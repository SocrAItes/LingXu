import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';
import{streamQuestion}from'../src/moss-tts.mjs';
test('首段PCM在HTTP流结束之前交给播放器，且不转发鉴权到输出记录',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'moss-stream-test-'));await mkdir(path.join(folder,'tts'));t.after(()=>rm(folder,{recursive:true,force:true}));let firstDelivered=false,endReached=false;
 const fetcher=async(_,req)=>{assert.equal(JSON.parse(req.body).stream,true);return{ok:true,status:200,headers:new Headers({'content-type':'audio/pcm','x-sample-rate':'48000','x-channels':'2','x-bit-depth':'16'}),body:(async function*(){yield Buffer.alloc(1200);assert.equal(firstDelivered,true);yield Buffer.alloc(1200);endReached=true;})()};};
 const result=await streamQuestion({text:'短问题？',key:'not-in-output',folder,base:'one',round:1,fetcher,onPcm:()=>{assert.equal(endReached,false);firstDelivered=true;}});
 assert.ok(result.timing.first_pcm_ms<=result.timing.body_complete_ms);assert.doesNotMatch(JSON.stringify(result),/not-in-output/);
});
