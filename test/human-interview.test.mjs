import test from'node:test';import assert from'node:assert/strict';import{EventEmitter}from'node:events';import{mkdtemp,mkdir,copyFile,readFile,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';
import{HumanInterview}from'../src/human-interview.mjs';
class Socket extends EventEmitter {
 readyState=1;bufferedAmount=0;
 constructor(){super();queueMicrotask(()=>this.emit('open'));}
 send(data,options,cb){if(typeof options==='function')options();else cb?.();if(options?.binary)return;const e=JSON.parse(data);let response;if(e.action==='attach_session')response={action:'session_attached',data:{session_id:'test'}};if(e.action==='session.update')response={action:'session.updated',data:{error:''}};if(e.action==='media.configure')response={action:'media.configured',data:{error:'',output_audio:{sample_rate:16000,format:'pcm16'},playback:'server'}};if(response)queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify(response)),false));}
 close(){this.emit('close',1000);}
}
test('真人模式只将实际ASR交给树，不加载受访者卡片，并保存文稿和路径',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'human-tree-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'roles'));await mkdir(path.join(root,'prompts'));
 await copyFile(new URL('../roles/许知.md',import.meta.url),path.join(root,'roles/许知.md'));await copyFile(new URL('../prompts/interviewer-text.txt',import.meta.url),path.join(root,'prompts/interviewer-text.txt'));
 const sent=[],calls=[];const call=async(actor,messages)=>{calls.push({actor,messages});if(actor==='interviewer_closing')return{value:{action:'finish',utterance:'谢谢，今天先到这里。',topic:'closing',basis_turn_ids:[]},record:{}};return{value:{action:'ask',utterance:actor==='interviewer_opening'?'愿意分享吗？':'最近具体做了什么？',topic:actor==='interviewer_opening'?'opening':'workflow',basis_turn_ids:[]},record:{}};};
 const session=new HumanInterview({root,key:'not-recorded',maxRounds:2,send:(m,binary)=>sent.push({m,binary}),peerFactory:()=>new Socket(),callFactory:()=>call,autoAdvanceMs:60000,tts:async opts=>opts.onPcm(Buffer.alloc(640))});
 t.after(()=>session.peer?.close());await session.start();assert.equal(session.phase,'speaking');await session.playback({action:'playback.completed',run_id:session.playbackRun});
 session.provider({action:'input.transcript.done',data:{turn:'one',text:'可以聊。'}});session.provider({action:'input.transcript.revised',data:{turn:'one',text:'可以，我愿意聊。'}});await session.commit();assert.equal(session.tree.steps[0].answer.text,'可以，我愿意聊。');
 await session.playback({action:'playback.completed',run_id:session.playbackRun});session.provider({action:'input.transcript.revised',data:{turn:'one',text:'旧轮次的迟到修订。'}});session.provider({action:'input.transcript.done',data:{turn:'two',text:'我最近用工具整理了会议记录。'}});await session.commit();await session.playback({action:'playback.completed',run_id:session.playbackRun});await session.finalize();
 assert.equal(session.reason,'completed');assert.equal(session.tree.steps.length,2);assert.equal(calls.some(c=>c.actor==='simulated_respondent'),false);
 assert.match(await readFile(path.join(session.folder,'访谈文字稿.txt'),'utf8'),/我最近用工具整理了会议记录/);
 const asr=(await readFile(path.join(session.folder,'识别原文.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(asr.slice(0,2).map(e=>e.data.text),['可以聊。','可以，我愿意聊。']);assert.equal(asr[2].accepted_for_current_answer,false);
 const trajectory=JSON.parse(await readFile(path.join(session.folder,'决策轨迹.json'),'utf8'));assert.deepEqual(trajectory.steps[0].asr_source.asr_event_ids,['asr-2']);assert.equal(trajectory.steps[1].answer_used.text,'我最近用工具整理了会议记录。');
 const frozen=JSON.parse(await readFile(path.join(session.folder,'frozen-inputs.json'),'utf8'));assert.equal(frozen.robotPersonaUsed,false);assert.equal(frozen.artificialHumanDelayMs,0);
});

test('真人控制器把问题池取消信号传给模型请求，不被会话信号覆盖', {timeout:2000}, async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'human-cancel-test-'));await mkdir(path.join(root,'roles'));await mkdir(path.join(root,'prompts'));
 await copyFile(new URL('../roles/许知.md',import.meta.url),path.join(root,'roles/许知.md'));await copyFile(new URL('../prompts/interviewer-text.txt',import.meta.url),path.join(root,'prompts/interviewer-text.txt'));
 let preparationSignal,count=0;
 const client=async(actor,messages,options)=>{
  if(actor==='candidate_planner')return new Promise((resolve,reject)=>{preparationSignal=options.signal;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
  return {value:{action:'ask',utterance:actor==='interviewer_opening'?'愿意聊聊吗？':`第${++count}次具体发生了什么？`,topic:actor==='interviewer_opening'?'opening':'workflow',basis_turn_ids:[]},record:{}};
 };
 const session=new HumanInterview({root,key:'not-recorded',maxRounds:3,send:()=>{},peerFactory:()=>new Socket(),callFactory:()=>client,autoAdvanceMs:60000,tts:async()=>{}});
 t.after(async()=>{await session.end('test_complete');await session.tree?.poolTask;await session.serial;await session.journal?.flush();session.peer?.close();await rm(root,{recursive:true,force:true});});
 await session.start();await session.playback({action:'playback.completed',run_id:session.playbackRun});
 session.provider({action:'input.transcript.done',data:{turn:'one',text:'愿意聊。'}});await session.commit();assert.equal(preparationSignal.aborted,false);
 await session.playback({action:'playback.completed',run_id:session.playbackRun});
 session.provider({action:'input.transcript.done',data:{turn:'two',text:'已经说完了。'}});await session.commit();
 assert.equal(preparationSignal.aborted,true);assert.equal(session.abort.signal.aborted,false);
 assert.equal(session.tree.steps[1].selection.code,'pool_not_ready');
});
