import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { ensureLocalModel } from '../src/local-model.mjs';
import { makeQwenClient, generatePool, generateFresh, PLAN_STYLES, qualityFlags, questionKey } from '../src/question-lab.mjs';
import { selectWithModel, ROUTER_PROTOCOL } from '../src/model-router.mjs';

const option=(name,otherwise)=>{const i=process.argv.indexOf(name);return i<0?otherwise:process.argv[i+1];};
const source=option('--recording');
if(!source)throw new Error('Usage: node scripts/benchmark-decisions.mjs --recording RECORDING_DIRECTORY [--repeats 3]');
const repeats=Number(option('--repeats','3'));
const requireQuestion=process.argv.includes('--require-question');
const legacyPath=option('--legacy-router');
const legacyRouter=legacyPath?(await import(pathToFileURL(path.resolve(legacyPath)).href)).selectWithModel:null;
if(!Number.isInteger(repeats)||repeats<1||repeats>10)throw new Error('--repeats must be 1..10');
await loadConfig();
await ensureLocalModel();
const root=path.resolve(import.meta.dirname,'..');
const id=new Date().toISOString().replaceAll(':','-');
const output=path.resolve(option('--output',path.join(root,'data','decision-benchmarks',id)));
await mkdir(output,{recursive:true,mode:0o700});
await mkdir(path.join(output,'source'),{recursive:true});
const sourceHashes={};
for(const file of ['src/model-router.mjs','src/question-lab.mjs','src/voice-tree.mjs','scripts/benchmark-decisions.mjs']){
 const contents=await readFile(path.join(root,file));sourceHashes[file]=createHash('sha256').update(contents).digest('hex');await writeFile(path.join(output,'source',path.basename(file)),contents);
}
const frozen=JSON.parse(await readFile(path.join(source,'frozen-inputs.json'),'utf8'));
const tree=JSON.parse(await readFile(path.join(source,'tree-state.json'),'utf8'));
const timing=JSON.parse(await readFile(path.join(source,'timing-details.json'),'utf8'));
const cases=tree.steps.filter(s=>s.index>=2&&s.index<=7&&s.answer).map(s=>{
 const sample=timing.rounds.find(r=>r.round===s.index);
 return {id:`recorded-${s.index}`,label:`原录音第${s.index}轮回答`,source:'recorded_asr',prefix:tree.turns.slice(0,tree.turns.findIndex(t=>t.id===s.question.id)+1),answer:s.answer.text,recorded_speech_window_ms:sample.question_duration_ms+sample.answer_duration_ms};
});
const baseCase=cases.find(c=>c.id==='recorded-6');
if(cases.length!==6||!baseCase)throw new Error('需要包含第2至第7轮完整回答的运行记录，才能进行固定场景对照。');
cases.push(
 {...baseCase,id:'correction',label:'纠正前提（人工输入）',source:'constructed',answer:'不是，我刚才说得不太准确。那张海报的局部修改其实挺顺利，我说麻烦的是给不同客户切换品牌风格。',recorded_speech_window_ms:null},
 {...baseCase,id:'new-topic',label:'转到新话题（人工输入）',source:'constructed',answer:'先不说改稿了，我真正纠结的是团队能不能一起用，每个人生成的东西很难共享。',recorded_speech_window_ms:null},
);
const inputs=c=>({role:frozen.interviewerRole,runtime:frozen.interviewerRuntime,brief:frozen.brief,prefix:c.prefix,answer:c.answer});
const context=new AsyncLocalStorage();
const requests=[];
const base=process.env.TEXT_MODEL_BASE_URL;
const client=makeQwenClient({base,model:process.env.TEXT_MODEL,provider:process.env.TEXT_MODEL_PROVIDER,apiKey:process.env.TEXT_MODEL_API_KEY,audit:async r=>{
 const item={call_id:`call-${requests.length+1}`,...context.getStore(),...r};
 requests.push(item);await appendFile(path.join(output,'model-requests.jsonl'),JSON.stringify(item)+'\n');
}});
const call=(actor,messages,options)=>{
 if(requireQuestion&&(actor==='on_demand_interviewer'||actor==='branch_selector'&&context.getStore()?.arm==='legacy')){
  const policy=actor==='branch_selector'
   ? '\n\n本次受控实验要求两种方案都继续追问一轮。本轮不允许结束访谈，action 只能为 select 或 generate。请优先承接最新回答中尚未说明的具体内容。'
   : '\n\n本次受控实验要求两种方案都继续追问一轮。本轮不允许结束访谈，action 必须为 ask。请优先承接最新回答中尚未说明的具体内容。';
  messages=messages.map((m,i)=>i===0?{...m,content:m.content+policy}:m);
 }
 return client(actor,messages,options);
};
const check=(result,c)=>({flags:result.action==='ask'?qualityFlags(result.question):[],exact_repeat:c.prefix.some(t=>t.role==='interviewer'&&questionKey(t.text)===questionKey(result.question)),action:result.action,basis:result.basis||[]});

async function direct(c,repeat){
 const started=performance.now(),mark=requests.length;
 try{
  const result=await context.run({case_id:c.id,repeat,arm:'direct',phase:'after_answer'},()=>generateFresh(call,inputs(c)));
  if(requireQuestion&&result.action!=='ask')throw new Error('Controlled-trial policy violation: expected ask, received '+result.action);
  return {ok:true,after_answer_ms:performance.now()-started,result,quality:check(result,c),calls:requests.slice(mark).map(r=>r.call_id),attempts:result.attempts.length};
 }catch(e){return {ok:false,after_answer_ms:performance.now()-started,error:e.message,calls:requests.slice(mark).map(r=>r.call_id)};}
}
async function prepared(c,repeat,arm='tree',shared){
 let pool,pool_error;
 const prepStart=performance.now(),prepMark=requests.length;
 if(shared){pool=shared.pool;pool_error=shared.pool_error;}
 else try{
  pool=await context.run({case_id:c.id,repeat,arm:'tree',phase:'before_answer'},()=>generatePool(call,{role:frozen.interviewerRole,brief:frozen.brief,prefix:c.prefix,strategy:PLAN_STYLES[0]}));
 }catch(e){pool_error=e.message;}
 const preparation_ms=shared?.preparation_ms??performance.now()-prepStart,preparation_calls=shared?.preparation_calls??requests.slice(prepMark).map(r=>r.call_id);
 const started=performance.now(),mark=requests.length;
 try{
  let selection,result;
  if(pool){
   selection=await context.run({case_id:c.id,repeat,arm,phase:'after_answer'},()=>arm==='legacy'?legacyRouter(call,pool,c.prefix,c.answer,frozen.brief):selectWithModel(call,pool,c.prefix,c.answer,frozen.brief,{requireQuestion}));
  }
  if(selection?.kind==='hit')result={action:'ask',question:selection.candidate.question,basis:selection.evidence,source:'prepared_candidate'};
  else if(selection?.kind==='finish')result={action:'finish',question:selection.utterance,basis:selection.evidence,source:'model_finished'};
  else if(selection?.kind==='generated')result={action:'ask',question:selection.question,topic:selection.topic,basis:selection.evidence,source:'inline_generated'};
  else result={...await context.run({case_id:c.id,repeat,arm,phase:'after_answer'},()=>generateFresh(call,inputs(c))),source:'on_demand_fallback'};
  if(requireQuestion&&result.action!=='ask')throw new Error('Controlled-trial policy violation: expected ask, received '+result.action);
  return {ok:true,preparation_ms,pool,pool_error,preparation_calls,after_answer_ms:performance.now()-started,selection,result,quality:check(result,c),calls:requests.slice(mark).map(r=>r.call_id),attempts:(selection?.attempts?.length||0)+(result.attempts?.length||0)};
 }catch(e){return {ok:false,preparation_ms,pool,pool_error,preparation_calls,after_answer_ms:performance.now()-started,error:e.message,calls:requests.slice(mark).map(r=>r.call_id)};}
}

const protocol={id,router_protocol:ROUTER_PROTOCOL,source_hashes:sourceHashes,source_recording:path.resolve(source),model:process.env.TEXT_MODEL,base,provider:process.env.TEXT_MODEL_PROVIDER,repeats,cases,role:frozen.interviewerRole,runtime:frozen.interviewerRuntime,brief:frozen.brief,requireQuestion,legacy_router:legacyPath?path.resolve(legacyPath):null,implementation:'Direct: existing generateFresh. Tree: current compact router (version recorded separately). Optional legacy arm loads the preserved pre-optimization model router. All arms must ask when requireQuestion=true; early finish is a failure.',scope:legacyRouter?'Text-only three-arm trial; six arm-order permutations rotated across the recorded triples. No speech, ASR, TTS or fixed ASR-stability wait.':'Text-only paired trial with alternating arm order. No speech, ASR, TTS or fixed ASR-stability wait.',preparation:'Candidate generation receives prefix only, never the answer. In the three-arm trial both routers receive exactly the same independently prepared pool. Preparation is measured separately; this does not measure live background overlap.',fallback:'Any second generation call is independently measured; outputs are never shared between arms. The compact router may generate a new question in its first routing call.',quality:'Programmatic validation and heuristic flags are recorded; they do not establish semantic equivalence or human-quality parity.',settings:{temperature:0.65,top_p:0.85,stream:false,think:false},warmup:'Warmup requests have repeat=0 and are excluded.'};
await writeFile(path.join(output,'protocol.json'),JSON.stringify(protocol,null,2));
console.log('OUTPUT',output);
console.log('WARMUP');
await context.run({case_id:'warmup',repeat:0,arm:'warmup',phase:'warmup'},async()=>{
 const c=cases[0];
 try{const pool=await generatePool(call,{role:frozen.interviewerRole,brief:frozen.brief,prefix:c.prefix,strategy:PLAN_STYLES[0]});await selectWithModel(call,pool,c.prefix,c.answer,frozen.brief,{requireQuestion});if(legacyRouter)await legacyRouter(call,pool,c.prefix,c.answer,frozen.brief);}catch(e){console.log('WARMUP NOTE',e.message);}
 try{await generateFresh(call,inputs(c));}catch(e){console.log('WARMUP NOTE',e.message);}
});

const results=[];
for(let repeat=1;repeat<=repeats;repeat++){
 const sequence=repeat%2?cases:[...cases].reverse();
 for(const c of sequence){
  const originalIndex=cases.indexOf(c);
  const permutations=[['direct','legacy','tree'],['direct','tree','legacy'],['legacy','direct','tree'],['legacy','tree','direct'],['tree','direct','legacy'],['tree','legacy','direct']];
  const order=legacyRouter?permutations[(originalIndex+(repeat-1)*cases.length)%6]:(originalIndex+repeat)%2===0?['direct','tree']:['tree','direct'];
  console.log('START',repeat,c.id,order.join('/'));
  const result={case_id:c.id,label:c.label,source:c.source,repeat,order,answer:c.answer,recorded_speech_window_ms:c.recorded_speech_window_ms};
  let shared;
  if(legacyRouter){
   const started=performance.now(),mark=requests.length;let pool,pool_error;
   try{pool=await context.run({case_id:c.id,repeat,arm:'preparation',phase:'before_answer'},()=>generatePool(call,{role:frozen.interviewerRole,brief:frozen.brief,prefix:c.prefix,strategy:PLAN_STYLES[0]}));}catch(e){pool_error=e.message;}
   shared={pool,pool_error,preparation_ms:performance.now()-started,preparation_calls:requests.slice(mark).map(r=>r.call_id)};
  }
  for(const arm of order)result[arm]=arm==='direct'?await direct(c,repeat):await prepared(c,repeat,arm,shared);
  if(c.recorded_speech_window_ms!=null){result.tree.preparation_fits_recorded_speech_window=result.tree.preparation_ms<=c.recorded_speech_window_ms;result.tree.estimated_unhidden_preparation_ms=Math.max(0,result.tree.preparation_ms-c.recorded_speech_window_ms);}
  results.push(result);await appendFile(path.join(output,'pairs.jsonl'),JSON.stringify(result)+'\n');
  await writeFile(path.join(output,'results.json'),JSON.stringify({protocol,results},null,2));
  console.log('RESULT',JSON.stringify({repeat,case:c.id,direct_ms:result.direct.after_answer_ms,direct_ok:result.direct.ok,legacy_ms:result.legacy?.after_answer_ms,legacy_ok:result.legacy?.ok,tree_ms:result.tree.after_answer_ms,tree_ok:result.tree.ok,prepare_ms:result.tree.preparation_ms,route:result.tree.selection?.kind||result.tree.error||'pool_failed',direct_question:result.direct.result?.question,tree_question:result.tree.result?.question}));
 }
}
await writeFile(path.join(output,'completed.json'),JSON.stringify({completed_at:new Date().toISOString(),pair_count:results.length,call_count:requests.length},null,2));
console.log('COMPLETE',output);
