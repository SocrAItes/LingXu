import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { RealtimePeer, AudioRelay } from '../src/realtime-peer.mjs';

class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent=[];
  send(value,options,callback){this.sent.push(options?.binary?value:JSON.parse(value));(typeof options==='function'?options:callback)?.();}
  close(){this.emit('close',1000);}
}
test('MOSS树工具只执行一次，匹配工具结果确认后才能继续发声', async t=>{
  const ws=new Socket(),trace=[],errors=[];let calls=0;
  const peer=new RealtimePeer({name:'interviewer',key:'not-logged',factory:()=>ws,trace:(stage,data)=>trace.push({stage,data}),tool:async()=>{calls++;return {utterance:'实际问题？'};}});
  peer.on('failure',e=>errors.push(e));t.after(()=>peer.close());
  const d={call_id:'c1',name:'next',arguments:'{}'};
  peer.event({action:'response.function_call_arguments.done',data:d});peer.event({action:'response.done',data:{response:{output:[{type:'function_call',...d}]}}});
  await setTimeout(0);assert.equal(calls,1);assert.equal(ws.sent.filter(e=>e.action==='response.create').length,0);
  peer.event({action:'conversation.item.created',data:{item:{call_id:'other'}}});assert.equal(ws.sent.filter(e=>e.action==='response.create').length,0);
  peer.event({action:'conversation.item.created',data:{item:{call_id:'c1'}}});peer.event({action:'conversation.item.created',data:{item:{call_id:'c1'}}});
  assert.equal(ws.sent.filter(e=>e.action==='response.create').length,1);assert.doesNotMatch(JSON.stringify(trace),/not-logged/);assert.equal(errors.length,0);
});
test('数字中继每帧20ms，片段回执等末采样调度后发送，原始采样可还原',async()=>{
  const sent=[],saved=[];let acknowledgments=0;
  const relay=new AudioRelay({source:'respondent',destination:{name:'interviewer',input:packet=>sent.push(packet)},save:s=>saved.push(s)});
  const pcm=Buffer.alloc(1280,3);
  relay.enqueue({pcm,meta:{run_id:'r',chunk_id:'c'},acknowledge:()=>acknowledgments++},{round:1});
  relay.tick();assert.equal(sent[0].length,641);assert.equal(sent[0][0],0);assert.equal(acknowledgments,0);
  await setTimeout(22);relay.tick();assert.equal(acknowledgments,0);assert.equal(relay.queue.length,0);
  await setTimeout(22);relay.tick();assert.equal(acknowledgments,1);
  assert.deepEqual(Buffer.concat(saved.map(s=>s.pcm)),pcm);
});
test('server播放模式不得为后台音频的空标识发送非法客户端回执',t=>{
  const ws=new Socket(),peer=new RealtimePeer({name:'interviewer',key:'test',factory:()=>ws,playback:'server'});
  t.after(()=>peer.close());peer.on('failure',e=>assert.fail(e.message));peer.on('audio',chunk=>chunk.acknowledge());
  peer.event({action:'response.audio.context',data:{run_id:'background',turn_id:'',chunk_id:'',duration_ms:100}});
  peer.audio(Buffer.alloc(3200));peer.event({action:'response.audio.done',data:{run_id:'background',turn_id:''}});
  assert.equal(ws.sent.some(e=>e.action?.startsWith('playback.')),false);
});
test('client播放回执只发送协议定义的标识，不回传音频上下文的额外字段',t=>{
  const ws=new Socket(),peer=new RealtimePeer({name:'interviewer',key:'test',factory:()=>ws});
  t.after(()=>peer.close());peer.on('failure',e=>assert.fail(e.message));peer.on('audio',chunk=>chunk.acknowledge());
  peer.event({action:'response.audio.context',data:{run_id:'r',turn_id:'t',chunk_id:'c',duration_ms:100}});peer.audio(Buffer.alloc(3200));
  assert.deepEqual(ws.sent.at(-1),{action:'playback.chunk.completed',run_id:'r',turn_id:'t',chunk_id:'c'});
});
test('往返时延读取服务端回显的client_timestamp，不拿服务端墙钟相减',t=>{
  const ws=new Socket(),trace=[],peer=new RealtimePeer({name:'interviewer',key:'test',factory:()=>ws,trace:(stage,data)=>trace.push({stage,data})});
  t.after(()=>peer.close());peer.event({action:'pong',data:{client_timestamp:performance.now()-40,server_recv_timestamp:1795241561547}});
  const rtt=trace.find(e=>e.stage==='network.rtt');assert.ok(rtt.data.duration_ms>=40&&rtt.data.duration_ms<1000);
});
test('500ms只延迟本轮回答开头，不在每个音频片段间重复等待',()=>{
 let now=0;const packets=[],events=[];const r=new AudioRelay({source:'respondent',destination:{name:'interviewer',input:b=>packets.push(b)},startDelayMs:500,now:()=>now,trace:(s,d)=>events.push({s,d})});
 for(const id of ['a','b'])r.enqueue({pcm:Buffer.alloc(640,1),meta:{run_id:'run',chunk_id:id}},{round:1});
 r.tick();assert.equal(packets.at(-1).subarray(1).some(x=>x!==0),false);now=499;r.tick();assert.equal(packets.at(-1).subarray(1).some(x=>x!==0),false);
 now=500;r.tick();assert.equal(packets.at(-1)[1],1);now=520;r.tick();assert.equal(packets.at(-1)[1],1);
 assert.equal(events.filter(e=>e.s==='relay.reply_delay.completed').length,1);assert.equal(events.find(e=>e.s==='relay.reply_delay.completed').d.duration_ms,500);
});
