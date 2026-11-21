import { loadConfig } from '../src/config.mjs';
import { ensureLocalModel } from '../src/local-model.mjs';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VoiceTrace } from '../src/voice-trace.mjs';
import { RealtimePeer, AudioRelay } from '../src/realtime-peer.mjs';
import { VoiceTree, voiceTreeGraph } from '../src/voice-tree.mjs';
import { makeQwenClient } from '../src/question-lab.mjs';
import { voiceTreeSvg } from '../src/voice-tree-svg.mjs';
import { PcmClock, sampleClockTracks } from '../src/pcm.mjs';
import { streamQuestion, FEMALE_INTERVIEWER_VOICE, DEFAULT_TTS_MODEL } from '../src/moss-tts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await loadConfig();
await ensureLocalModel();
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const maxRounds = Number(option('--rounds', 8));
const respondentReplyDelayMs=Number(process.env.RESPONDENT_REPLY_DELAY_MS??500);
if(!Number.isFinite(respondentReplyDelayMs)||respondentReplyDelayMs<0||respondentReplyDelayMs>5000)throw new Error('受访者开口延迟须为0～5000毫秒');
if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > 12) throw new Error('--rounds 需要为2～12');
const key = process.env.MOSS_API_KEY; if (!key) throw new Error('需要在本机 config.env 配置 MOSS_API_KEY');
const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0,8)}`;
const folder = path.join(root, 'data', 'voice-tree-interviews', id);
await mkdir(path.join(folder, 'raw-audio'), { recursive: true, mode: 0o700 });
const journal = new VoiceTrace(folder, id, () => { failure ||= '原始事件写盘失败'; });
const observations = [], requests = [], relaySegments = [], streams = [], pendingWrites = [];
let failure = null, successful = false, tick, heartbeat;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{failure ||= `收到${signal}，停止并保存已有记录`;});
const trace = (stage, data = {}) => journal.mark(stage, data);
const read = file => readFile(path.join(root, file), 'utf8');
const [interviewerRole, interviewerRuntime, respondentRole, respondentRuntime] = await Promise.all([read('roles/许知.md'), read('prompts/interviewer-text.txt'), read('roles/林舟.md'), read('prompts/respondent-runtime.txt')]);
const voices = { interviewer: { id: process.env.INTERVIEWER_VOICE || FEMALE_INTERVIEWER_VOICE.id, name: !process.env.INTERVIEWER_VOICE || process.env.INTERVIEWER_VOICE===FEMALE_INTERVIEWER_VOICE.id ? FEMALE_INTERVIEWER_VOICE.name : '自定义音色' }, respondent: { id: process.env.RESPONDENT_VOICE || '531a0774-0417-41e4-8a70-3593b1a32e34', name: '青年音' } };
const inputs = { interviewer: new Map(), respondent: new Map() }, outputRuns = new Map();
let latestAsrAt = 0, interviewer, respondent, toInterviewer, toRespondent;
const client = makeQwenClient({ base: process.env.TEXT_MODEL_BASE_URL || 'http://127.0.0.1:11434/v1', model: process.env.TEXT_MODEL || 'qwen3:8b', apiKey: process.env.TEXT_MODEL_API_KEY,
  audit: async record => { const entry = { call_id: `call-${requests.length+1}`, ...record }; requests.push(entry); await appendFile(path.join(folder, 'model-requests.jsonl'), JSON.stringify(entry)+'\n'); },
});
const call = async (actor, messages, options) => {
  const round = tree.steps.length, started = performance.now(); trace('model.request.started', { actor, round });
  try { const result = await client(actor, messages, options); trace('model.request.completed', { actor, round, duration_ms: performance.now()-started }); return result; }
  catch(error) { trace('model.request.failed', { actor, round, duration_ms: performance.now()-started, error: error.message }); throw error; }
};
let saving = Promise.resolve();
const tree = new VoiceTree({ call, role: interviewerRole, runtime: interviewerRuntime, maxRounds, trace,
  changed: snapshot => { const frozen = JSON.stringify(snapshot, null, 2), graph = JSON.stringify(voiceTreeGraph(snapshot), null, 2); saving = saving.then(async()=>{ await writeFile(path.join(folder,'tree-state.json'), frozen); await writeFile(path.join(folder,'tree.json'), graph); }); return saving; },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout, label) { const started=performance.now(); while(!predicate()) { if(failure) throw new Error(failure); if(performance.now()-started>timeout) throw new Error(`${label}超时`); await sleep(25); } }
function wav(pcm, channels = 1) { const h=Buffer.alloc(44); h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(channels,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000*channels,28);h.writeUInt16LE(2*channels,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]); }
function wavPcm(bytes) { let encoding,rate,channels,bits;for(let p=12;p+8<=bytes.length;){const n=bytes.readUInt32LE(p+4),tag=bytes.toString('ascii',p,p+4);if(tag==='fmt '){encoding=bytes.readUInt16LE(p+8);channels=bytes.readUInt16LE(p+10);rate=bytes.readUInt32LE(p+12);bits=bytes.readUInt16LE(p+22);}if(tag==='data'){if(encoding!==1||rate!==16000||channels!==1||bits!==16)throw new Error('引导音频格式错误');return bytes.subarray(p+8,p+8+n);}p+=8+n+n%2;}throw new Error('缺少引导音频'); }
function observe(peer, kind, data = {}) { const item = { peer, kind, t_ms: performance.now(), ...data }; observations.push(item); return item; }
function listen(peer) {
  let chunkIndex=0;
  const stream = createWriteStream(path.join(folder,'raw-audio',`${peer.name}-input.tagged`), { mode: 0o600 }); streams.push(stream);
  stream.on('error', () => { failure ||= `${peer.name} 原始音频写盘失败`; });
  peer.on('failure', error=>{ failure ||= error.message; console.log('FAILURE', error.message); });
  peer.on('input', ({packet})=>{ if(!stream.write(packet)&&stream.writableLength>2*1024*1024) failure ||= '原始音频写盘积压'; });
  peer.on('event', event=>{
    const a=event.action,d=event.data||{},round=tree.steps.length;
    if(a==='input.transcript.done'||a==='input.transcript.revised') {
      const list=inputs[peer.name].get(round)||[]; const found=list.find(x=>d.turn && x.turn===d.turn);
      if(found){ found.text=d.text;found.t_ms=performance.now();found.revised=a.endsWith('revised'); }else list.push({turn:d.turn,text:d.text,t_ms:performance.now()});
      inputs[peer.name].set(round,list); if(peer.name==='interviewer')latestAsrAt=performance.now();
      observe(peer.name,'input_transcript',{round,event}); console.log(`ASR ${peer.name} round=${round}: ${d.text}`);
    }
    if(a==='response.audio.started'||a==='response.audio.context'||a.startsWith('output.transcript.')) {
      const runKey=`${peer.name}:${d.run_id}`;
      if(d.run_id&&!outputRuns.has(runKey)) {const approved=peer.name==='respondent';outputRuns.set(runKey,{peer:peer.name,run_id:d.run_id,approved,round:approved?round:0,closing:false,kind:d.kind,created_ms:performance.now(),texts:[]});}
      const run=outputRuns.get(runKey);
      if(a.startsWith('output.transcript.')) {
        observe(peer.name,a==='output.transcript.done'?'output_text_final':'output_text_update',{round:run?.round??round,run_id:d.run_id,closing:run?.closing,text:d.text});
        if(a==='output.transcript.done') {
          if(run)run.texts.push(d.text); console.log(`VOICE ${peer.name} round=${run?.round??round}: ${d.text}`);
          if(peer.name==='interviewer') { if(!run?.approved) observe(peer.name,'blocked_autonomous_speech',{text:d.text,run_id:d.run_id}); else pendingWrites.push(tree.spoken(d.text,run.round,run.closing)); }
        }
      }
    }
    if(a==='response.ended'||a==='response.interrupted') {
      const run=outputRuns.get(`${peer.name}:${d.run_id}`);if(run){run.ended_ms=performance.now();run.status=d.status||'interrupted';}
      observe(peer.name,a,{round:run?.round??round,event});
      if(a==='response.interrupted')console.log('INTERRUPTED',peer.name,d.reason||'');
    }
  });
  peer.on('audio', chunk=>{
    const run=outputRuns.get(`${peer.name}:${chunk.meta.run_id}`), context={round:run?.round??tree.steps.length,closing:Boolean(run?.closing)};
    if(run)run.last_audio_ms=performance.now();
    const at=performance.now(); observe(peer.name,'audio',{...context,...chunk.meta,bytes:chunk.pcm.length});
    const filename=`${peer.name}-${++chunkIndex}-${String(chunk.meta.run_id).replace(/[^a-zA-Z0-9_-]/g,'_')}-${String(chunk.meta.chunk_id).replace(/[^a-zA-Z0-9_-]/g,'_')}.pcm`;
    pendingWrites.push(writeFile(path.join(folder,'raw-audio',filename),chunk.pcm,{mode:0o600}));
    trace('audio.artifact',{peer:peer.name,...context,...chunk.meta,file:`raw-audio/${filename}`,bytes:chunk.pcm.length,received_ms:at});
    if(peer.name==='interviewer'&&!run?.approved){trace('audio.blocked',{peer:peer.name,run_id:chunk.meta.run_id,reason:'非树授权的自动回复不进入访谈，原始PCM仍保存'});chunk.acknowledge();}
    else if(peer.name==='respondent'&&run?.kind==='backchannel'){trace('audio.blocked',{peer:peer.name,run_id:chunk.meta.run_id,reason:'基线连续问答先过滤附和片段，原始PCM仍保存'});chunk.acknowledge();}
    else (peer.name==='interviewer'?toRespondent:toInterviewer).enqueue(chunk,context);
  });
  peer.on('stop', d=>{(peer.name==='interviewer'?toRespondent:toInterviewer).stop(d.run_id);if(peer.playback==='client')peer.send({action:'playback.stopped',run_id:d.run_id,turn_id:d.turn_id,played_audio_ms:0,reason:'digital relay stopped; completed chunks already acknowledged'});});
  peer.on('played', run=>observe(peer.name,'played',{run_id:run.run_id}));
}
const interviewerInstructions = '你是后台研究控制器的语音表达层。后台 commentary 会提供一句完整的访谈问题或收尾，逐字自然表达该句，不改写、不补充解释、不再加问题。听到对方回答时只听，不自行提问；下一问由后台根据真实转写决定。温和、好奇、语速适中，避免播报腔。';
const respondentInstructions = `${respondentRuntime}\n本次是连续对话基线测试。一般先用一句短话回答当前一个点，不自行把后续背景、尝试、结果和结论全部补全；被具体追问再自然补充。听清完整问题后回答，不主动用“嗯”附和打断，不讲舞台动作。开场征询同意时只表态，不立即介绍自己的产品经历。对方道别只简短道别，不反过来提问。`;
await mkdir(path.join(folder,'tts'),{recursive:true});
await writeFile(path.join(folder,'frozen-inputs.json'),JSON.stringify({maxRounds,voices,interviewerRole,interviewerRuntime,respondentRole,respondentRuntime,interviewerInstructions,respondentInstructions,tools:[],brief:tree.brief,model:process.env.MOSS_MODEL||'moss-live-1.0',ttsModel:process.env.MOSS_TTS_MODEL||DEFAULT_TTS_MODEL,ttsStreaming:true,recordingClock:'连续采样序号；网络到包时间仅用于遥测，不切碎音频',topology:'本地Qwen根据MOSS-Live真实ASR驱动树；MOSS TTS边接收边播报提问，另一个独立MOSS-Live会话扮演受访者。实时会话自动回复不进入对话。基线问答先完成问题再中继回答；非自由重叠压力测试。',playback:'server；本地另行记录数字中继，不声称扬声器回放'},null,2),{mode:0o600});
console.log('FOLDER',folder);
try {
  interviewer=new RealtimePeer({name:'interviewer',key,persona:{name:'许知',prompt:'你是语音输入监听会话，只听取受访者回答。提问由外部女声TTS播报。'},instructions:interviewerInstructions,tools:[],trace,playback:'server',model:process.env.MOSS_MODEL||'moss-live-1.0'});
  respondent=new RealtimePeer({name:'respondent',key,voice:voices.respondent.id,persona:{name:'林舟',prompt:respondentRole},instructions:respondentInstructions,trace,playback:'server',model:process.env.MOSS_MODEL||'moss-live-1.0'});
  const save=segment=>relaySegments.push(segment);
  trace('respondent.reply_delay.configured',{configured_ms:respondentReplyDelayMs});
  toInterviewer=new AudioRelay({source:'respondent',destination:interviewer,trace,save,startDelayMs:respondentReplyDelayMs});
  toRespondent=new AudioRelay({source:'interviewer',destination:respondent,trace,save});
  listen(interviewer);listen(respondent);
  await waitFor(()=>interviewer.ready&&respondent.ready,35000,'MOSS初始化');
  const questionDrained=()=>{const runs=[...outputRuns.values()].filter(r=>r.peer==='interviewer'&&r.approved&&r.round===tree.steps.length);return runs.length&&runs.every(r=>r.synthesis_done)&&!toRespondent.queue.length&&!toRespondent.receipts.length;};
  tick=new PcmClock(({late_ms})=>{try{if(late_ms>5)trace('relay.timer.late',{duration_ms:late_ms});toInterviewer.tick({allowSpeech:Boolean(questionDrained())});toRespondent.tick();}catch(error){failure ||= error.message;}}).start();
  heartbeat=setInterval(()=>{try{for(const peer of [interviewer,respondent])peer.send({action:'ping',timestamp:performance.now()});}catch(error){failure ||= error.message;}},10000);
  const publish=async next=>{
    observe('interviewer','tree_result',{answer_round:next.action==='finish'?tree.steps.length:tree.steps.length-1,...next});
    const n=tree.steps.length,base=`round-${String(n).padStart(2,'0')}-${next.action}`,run_id=`tts-${base}`,run={peer:'interviewer',run_id,round:n,closing:next.action==='finish',approved:true,kind:'speech',tts:true,synthesis_done:false,texts:[]};let chunks=0;
    outputRuns.set(`interviewer:${run_id}`,run);
    await streamQuestion({text:next.utterance,voice:voices.interviewer.id,model:process.env.MOSS_TTS_MODEL||DEFAULT_TTS_MODEL,key,folder,base,round:n,closing:next.action==='finish',trace,onPcm:pcm=>{
      run.last_audio_ms=performance.now();observe('interviewer','audio',{round:n,closing:next.action==='finish',run_id,bytes:pcm.length,source:'moss-tts-stream'});
      toRespondent.enqueue({pcm,meta:{run_id,turn_id:`question-${n}`,chunk_id:`${base}-${++chunks}`},acknowledge:()=>{}},{round:n,closing:next.action==='finish'});
    }});
    run.synthesis_done=true;run.status='completed';
    console.log(`TREE round=${next.round} action=${next.action}: ${next.utterance}`);
  };
  await publish(await tree.next());
  while(!tree.closed){
    const n=tree.steps.length;
    await waitFor(()=>questionDrained()&&[...outputRuns.values()].some(r=>r.peer==='respondent'&&r.round===n&&r.kind!=='backchannel'&&r.status==='completed')&&!toInterviewer.queue.length&&!toInterviewer.receipts.length&&inputs.interviewer.get(n)?.length&&latestAsrAt>=(toInterviewer.lastEnd||0)-100&&performance.now()-latestAsrAt>500,90000,`第${n}轮完整语音与转写`);
    const heardQuestion=(inputs.respondent.get(n)||[]).map(x=>x.text).join('');
    if(!heardQuestion)throw new Error('受访者没有确认问题转写');
    tree.steps[n-1].question.transcript_source='MOSS TTS输入原文；接收方ASR单独保存于heard_text，不伪称TTS返回文字';
    tree.steps[n-1].question.heard_text=heardQuestion;
    await tree.spoken(tree.steps[n-1].question.planned_text,n);
    const answer=inputs.interviewer.get(n).map(x=>x.text).join('');trace('tree.actual_answer',{round:n,text:answer,input_turn_ids:inputs.interviewer.get(n).map(x=>x.turn)});
    await publish(await tree.next(answer));
  }
  await waitFor(()=>questionDrained(),30000,'收尾音频中继');
  tree.closing.spoken=true;tree.closing.spoken_text=tree.closing.text;tree.closing.transcript_source='MOSS TTS请求原文与实际PCM已保存；不是提供方返回文字';
  await sleep(500); if(failure)throw new Error(failure);
  successful=true;
} catch(error) { failure=error.message;console.log('FAILED',failure);process.exitCode=1; }
finally {
  tick?.stop();clearInterval(heartbeat);interviewer?.close();respondent?.close();
  await tree.poolTask;
  for(const stream of streams)stream.end();await Promise.all(streams.map(s=>finished(s).catch(()=>{})));
  await Promise.allSettled(pendingWrites);await saving;await journal.flush();
  const snapshot=tree.snapshot();await writeFile(path.join(folder,'tree-state.json'),JSON.stringify(snapshot,null,2));await writeFile(path.join(folder,'tree.json'),JSON.stringify(voiceTreeGraph(snapshot),null,2));
  await writeFile(path.join(folder,'observations.json'),JSON.stringify(observations,null,2));
  // Audio stays on a continuous sample clock. Wall time is telemetry, never a 20ms splice boundary.
  const audible=relaySegments.filter(s=>!s.context.bootstrap),recording=sampleClockTracks(audible),{tracks,stereo,samples:sampleCount}=recording;
  await writeFile(path.join(folder,'recording-clock.json'),JSON.stringify({type:'continuous_pcm_sample_index',rate:16000,startSample:recording.startSample,samples:sampleCount,note:'网络到包抖动不再写成每20ms的静音插缝；真实网络时延仍在events.jsonl'},null,2));
  await Promise.all([writeFile(path.join(folder,'conversation.wav'),wav(stereo,2)),...Object.entries(tracks).map(([name,pcm])=>writeFile(path.join(folder,`${name}.wav`),wav(pcm)))]);
  for(const step of tree.steps){for(const peer of ['interviewer','respondent']){const pcm=Buffer.concat(audible.filter(s=>s.source===peer&&s.context.round===step.index&&!s.context.closing).map(s=>s.pcm));if(pcm.length)await writeFile(path.join(folder,`round-${String(step.index).padStart(2,'0')}-${peer}.wav`),wav(pcm));}}
  const rows=[];
  for(const step of tree.steps){
    const n=step.index, first=(peer,kind,round=n,closing=false)=>observations.find(o=>o.peer===peer&&o.kind===kind&&o.round===round&&Boolean(o.closing)===closing)?.t_ms??null;
    const segments=source=>audible.filter(s=>s.source===source&&s.context.round===n&&!s.context.closing);
    const q=segments('interviewer'),a=segments('respondent'),last=s=>s.length?Math.max(...s.map(x=>x.t_ms+x.pcm.length/32)):null;
    const qEnd=last(q),aEnd=last(a),asr=inputs.interviewer.get(n),toolResult=observations.find(o=>o.kind==='tree_result'&&o.answer_round===n);
    const diff=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)?end-start:null;
    rows.push({round:n,question_duration_ms:q.reduce((s,x)=>s+x.pcm.length/32,0),answer_duration_ms:a.reduce((s,x)=>s+x.pcm.length/32,0),question_last_sample_to_respondent_first_text_ms:diff(first('respondent','output_text_update'),qEnd),question_last_sample_to_respondent_first_audio_ms:diff(first('respondent','audio'),qEnd),answer_last_sample_to_interviewer_final_asr_ms:diff(asr?.at(-1)?.t_ms,aEnd),answer_last_sample_to_tree_result_ms:diff(toolResult?.t_ms,aEnd),answer_last_sample_to_next_question_first_audio_ms:diff(first('interviewer','audio',n+1),aEnd),answer_last_sample_to_closing_first_audio_ms:n===tree.steps.length?diff(first('interviewer','audio',n,true),aEnd):null,pool_wait_ms:step.pool_wait_ms??null,selection_ms:step.selection?.routeMs??null,decision:step.selection?.decision||null});
  }
  const metrics={clock:'单一Node进程 performance.now，音频末采样为数字中继预计时间；负值表示重叠，保留原值',rounds:rows,unavailable:['MOSS内部ASR/LLM/TTS各自计算耗时未暴露','物理麦克风/扬声器及声学回录未测试','网络单向时延无法从RTT准确拆分'],recording:'conversation.wav 左声道访谈员/右声道受访者；为真实数字中继音频，非物理扬声器回录'};
  await writeFile(path.join(folder,'round-latency.json'),JSON.stringify(metrics,null,2));
  const lines=['MOSS语音 + Qwen动态访谈树：真实运行记录',`状态：${successful?'completed':'failed'}；错误：${failure||'无'}；目标轮数：${maxRounds}；已保存回答：${tree.steps.filter(s=>s.answer).length}`,`访谈员发声：MOSS TTS；语音识别及受访者：MOSS-Live；访谈员音色：${voices.interviewer.name}；受访者音色：${voices.respondent.name}；人物为虚构角色`,metrics.recording,'本次为受控连续问答基线：问题播完后中继回答，附和与非树授权的自动回复被过滤；原始输出仍在raw-audio及events.jsonl。','提问原文是TTS真实请求；实际被听到的问题另外保存接收方ASR，不能将请求原文伪称提供方返回文字。',''];
  for(const step of tree.steps){const actual=observations.filter(o=>o.peer==='respondent'&&o.kind==='output_text_final'&&o.round===step.index).map(o=>o.text).join('');lines.push(`=== 第${step.index}轮 ===`,`决策及TTS输入：${step.question.planned_text}`,`受访者实际识别的问题：${step.question.heard_text||'(尚未取得)'}`,`受访者实际输出：${actual||'(未输出)'}`,`访谈员实际识别：${step.answer?.text||'(未取得或尚未决策)'}`,`候选：${JSON.stringify(step.pool?.candidates||[])}`,`选路原始决策：${JSON.stringify(step.selection?.decision||step.selection||null)}`,'时延：',JSON.stringify(rows.find(r=>r.round===step.index),null,2),'');}
  if(tree.closing)lines.push(`收尾：${tree.closing.spoken_text||tree.closing.text}`,'');
  lines.push('=== 测量边界 ===',metrics.clock,...metrics.unavailable,'','=== Qwen真实输入输出 ===');
  for(const r of requests)lines.push(`[${r.call_id}] ${r.actor}`,JSON.stringify(r.payload,null,2),'原始返回：',r.response.content,'耗时：',JSON.stringify({durationMs:r.durationMs,...r.timing}),'');
  lines.push('=== MOSS真实协议输入输出 ===','完整事件逐条见 events.jsonl；原始输入帧/输出PCM见 raw-audio，audio.artifact事件提供上下文与文件对应。');
  await writeFile(path.join(folder,'访谈记录与输入输出.txt'),lines.join('\n'));
  await writeFile(path.join(folder,'tree.svg'),voiceTreeSvg(snapshot));
  const report={id,status:successful?'completed':'failed',error:failure,targetRounds:maxRounds,answeredRounds:tree.steps.filter(s=>s.answer).length,spokenQuestions:tree.steps.filter(s=>s.question.spoken).length,modelCalls:requests.length,treeModelSelections:tree.steps.filter(s=>s.selection?.source==='model').length,ttsRequests:tree.steps.filter(s=>s.question.spoken).length+(tree.closing?.spoken?1:0),actualMossSessions:2,topology:'MOSS-Live输入ASR → 本地Qwen树决策 → MOSS TTS提问；MOSS-Live受访者；受控问答基线',audioDurationMs:sampleCount/16,folder,voices,limits:metrics.unavailable};
  await writeFile(path.join(folder,'report.json'),JSON.stringify(report,null,2));await writeFile(path.join(root,'data','latest-voice-tree.json'),JSON.stringify({folder,status:report.status}));
  console.log('RESULT',JSON.stringify(report));
}
