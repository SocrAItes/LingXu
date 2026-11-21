import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { voiceTreeSvg } from '../src/voice-tree-svg.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=path.resolve(process.argv[2]||(JSON.parse(await readFile(path.join(root,'data/latest-voice-tree.json'),'utf8'))).folder);
const json=file=>readFile(path.join(folder,file),'utf8').then(JSON.parse);
const jsonl=async file=>(await readFile(path.join(folder,file),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const [report,state,events,requests,tts,latency,observations]=await Promise.all([json('report.json'),json('tree-state.json'),jsonl('events.jsonl'),jsonl('model-requests.jsonl'),jsonl('tts-requests.jsonl'),json('round-latency.json'),json('observations.json')]);
await writeFile(path.join(folder,'tree.svg'),voiceTreeSvg(state));
const groups=new Map();
function add(name,value){if(!Number.isFinite(value))return;const values=groups.get(name)||[];values.push(value);groups.set(name,values);}
for(const r of requests)add(`Qwen/${r.actor}`,r.durationMs);
for(const r of tts){add('MOSS TTS/接口响应完成',r.timing.body_complete_ms);if(r.timing.first_pcm_ms!==undefined)add('MOSS TTS/第一段可播放PCM',r.timing.first_pcm_ms);if(r.download)add('MOSS TTS/音频结果下载',r.download.duration_ms);}
for(const e of events){const d=e.data||{};if(!Number.isFinite(d.duration_ms))continue;const entity=d.peer||d.source||d.actor||'app';add(`${entity}/${e.stage}${d.action?'/'+d.action:''}`,d.duration_ms);}
for(const e of events){const d=e.data||{};if(e.stage==='event'&&d.event?.action==='pong'&&Number.isFinite(d.event.data?.client_timestamp))add(`${d.peer}/应用ping往返RTT`,e.t_ms-d.event.data.client_timestamp);}
const quantile=(v,q)=>v[Math.min(v.length-1,Math.ceil(v.length*q)-1)];
const stats=[...groups].map(([stage,v])=>{v.sort((a,b)=>a-b);return{stage,count:v.length,min_ms:v[0],p50_ms:quantile(v,.5),p95_ms:quantile(v,.95),max_ms:v.at(-1)};});
for(const row of latency.rounds){
  const next=events.find(e=>e.stage==='relay.chunk.started'&&e.data.source==='interviewer'&&e.data.round===row.round+1&&!e.data.closing);
  const closing=events.find(e=>e.stage==='relay.chunk.started'&&e.data.source==='interviewer'&&e.data.round===row.round&&e.data.closing);
  const recorded=observations.find(o=>o.kind==='tree_result'&&o.answer_round===row.round);
  const treeDelay=row.answer_last_sample_to_tree_result_ms;
  const end=recorded&&Number.isFinite(treeDelay)?recorded.t_ms-treeDelay:null;
  row.answer_last_sample_to_next_question_relay_ms=end!==null&&next?next.t_ms-end:null;
  row.answer_last_sample_to_closing_relay_ms=end!==null&&closing?closing.t_ms-end:null;
  for(const[k,v]of Object.entries(row))if(k.endsWith('_ms'))add(`逐轮/${k}`,v);
}
const roundStats=[...groups].filter(([name])=>name.startsWith('逐轮/')).map(([stage,v])=>{v.sort((a,b)=>a-b);return{stage,count:v.length,min_ms:v[0],p50_ms:quantile(v,.5),p95_ms:quantile(v,.95),max_ms:v.at(-1)};});
const measurements={...latency,statistics:[...stats,...roundStats],nativeAutomaticAudioBlocked:events.filter(e=>e.stage==='audio.blocked'&&e.data.peer==='interviewer').length,backchannelAudioBlocked:events.filter(e=>e.stage==='audio.blocked'&&e.data.peer==='respondent').length};
await writeFile(path.join(folder,'timing-details.json'),JSON.stringify(measurements,null,2));
const transcript=['实际语音访谈文字稿',`状态：${report.status}；回答轮数：${report.answeredRounds}/${report.targetRounds}`,report.topology,'这是虚构受访者的模拟访谈；提问文本是MOSS TTS实际输入，听到的内容另存ASR。',''];
for(const s of state.steps){const output=observations.filter(o=>o.peer==='respondent'&&o.kind==='output_text_final'&&o.round===s.index).map(o=>o.text).join('');transcript.push(`第${s.index}轮`,`访谈员（TTS实际输入）：${s.question.planned_text}`,`受访者实际听到的转写：${s.question.heard_text||'(未取得)'}`,`受访者（MOSS-Live原始最终文字）：${output||'(未取得)'}`,`树实际接收的回答（MOSS-Live ASR）：${s.answer?.text||'(未取得)'}`,`下一步：${s.selection?.decision?JSON.stringify(s.selection.decision):s.next?.source||'(尚未选择)'}`,'');}
if(state.closing)transcript.push(`收尾（TTS实际输入）：${state.closing.planned_text||state.closing.text}`);
transcript.push('','质量观察：识别差异、重复问题和模型判断需要结合录音复核；链路完成不代表访谈质量全部通过。');
await writeFile(path.join(folder,'访谈文字稿.txt'),transcript.join('\n'));
const lines=['实际时延报告',`状态：${report.status}；回答轮数：${report.answeredRounds}；Qwen调用：${requests.length}；TTS调用：${tts.length}`,report.topology,'单位均为毫秒。Node端使用同一单调时钟。音频末采样是数字中继的预计时间；不是物理扬声器出声时间。','本次为受控一问一答基线，附和和自动发问未进入对话；不表示已通过自由重叠与打断压力测试。',''];
for(const r of [...stats,...roundStats])lines.push(`${r.stage} | n=${r.count} | p50=${r.p50_ms.toFixed(2)} | p95=${r.p95_ms.toFixed(2)} | min=${r.min_ms.toFixed(2)} | max=${r.max_ms.toFixed(2)}`);
lines.push('','=== 每轮原始测量 ===',JSON.stringify(latency.rounds,null,2),'','=== 无法单独测得 ===',...latency.unavailable,'',tts.some(r=>r.payload.stream)?'TTS使用PCM流式：first_pcm_ms为首段可播放PCM准备时间，body_complete_ms为整段流返回时间，音频在流结束前已中继。格式严格按响应头解析，连续采样录音不按包到达时间插缝。':'TTS接口本次为非流式；HTTP首字节可能是JSON元数据，不能称为首音频。接口响应、音频下载、转换及数字发送分别记录。','实际可观察的识别、语音响应等待包含模型和网络，不拆成虚构的内部阶段。');
await writeFile(path.join(folder,'时延报告.txt'),lines.join('\n'));
const b=await readFile(path.join(folder,'conversation.wav'));
if(b.length>=44&&b.readUInt16LE(22)===2){const mono=Buffer.alloc((b.length-44)/2);for(let i=44,j=0;i+3<b.length;i+=4,j+=2)mono.writeInt16LE(Math.max(-32768,Math.min(32767,b.readInt16LE(i)+b.readInt16LE(i+2))),j);const h=Buffer.from(b.subarray(0,44));h.writeUInt32LE(36+mono.length,4);h.writeUInt16LE(1,22);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt32LE(mono.length,40);await writeFile(path.join(folder,'conversation-mono.wav'),Buffer.concat([h,mono]));}
const checks={status:report.status,answeredRounds:state.steps.filter(s=>s.answer).length,sourceRecordCount:events.length,modelRequests:requests.length,ttsRequests:tts.length,modelSelections:state.steps.filter(s=>s.selection?.source==='model').length,allAnswersHaveRealAsr:state.steps.filter(s=>s.answer).every(s=>events.some(e=>e.stage==='tree.actual_answer'&&e.data.round===s.index&&e.data.text===s.answer.text)),allQuestionsHaveTtsRequest:state.steps.every(s=>tts.some(r=>r.round===s.index&&r.payload.input===s.question.planned_text)),allSelectedQuestionsEqualRawCandidate:state.steps.filter(s=>s.selection?.kind==='hit').every(s=>s.next?.utterance===s.selection.candidate.question),conversationSha256:createHash('sha256').update(b).digest('hex'),quality:'仅验证记录与流程一致；问题是否重复、识别是否准确需看quality-notes及原文，不能把流程通过当作品质全部通过。'};
await writeFile(path.join(folder,'verification.json'),JSON.stringify(checks,null,2));
console.log(JSON.stringify({folder,checks,keyLatency:roundStats.filter(s=>s.stage.includes('next_question_relay')||s.stage.includes('selection_ms')||s.stage.includes('pool_wait_ms'))},null,2));
