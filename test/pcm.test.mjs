import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmDownsampler,PcmClock,sampleClockTracks,taggedPcm } from '../src/pcm.mjs';

test('录音按采样位置连续重建，21.4ms到包抖动不能变成每帧静音',()=>{
  const source=Buffer.alloc(1920);for(let i=0;i<960;i++)source.writeInt16LE(Math.round(5000*Math.sin(i*.1)),i*2);
  const parts=[0,1,2].map(i=>({pcm:source.subarray(i*640,(i+1)*640),sample_index:i*320,t_ms:i*21.4,source:'interviewer'}));
  const out=sampleClockTracks(parts);assert.deepEqual(out.tracks.interviewer.subarray(0,1920),source);
  const tagged=Buffer.concat(parts.map(s=>Buffer.concat([Buffer.from([0]),s.pcm])));assert.deepEqual(taggedPcm(tagged),source);
});
test('HTTP任意字节边界不能损坏立体声帧或改变降采样结果',()=>{
  const input=Buffer.alloc(4800*4);for(let i=0;i<4800;i++){const value=Math.round(12000*Math.sin(2*Math.PI*500*i/48000));input.writeInt16LE(value,i*4);input.writeInt16LE(value,i*4+2);}
  const whole=new PcmDownsampler(48000,2),expected=whole.push(input);whole.finish();assert.equal(expected.length,3200);
  const stream=new PcmDownsampler(48000,2),chunks=[];for(let p=0;p<input.length;p+=137)chunks.push(stream.push(input.subarray(p,p+137)));stream.finish();assert.deepEqual(Buffer.concat(chunks),expected);
});
test('48k到16k降采样滤除奈奎斯特频率以上的信号，避免混叠杂音',()=>{
  const amplitudes=[];
  for(const frequency of [1000,14000]){const b=Buffer.alloc(48000*2);for(let i=0;i<48000;i++)b.writeInt16LE(Math.round(12000*Math.sin(2*Math.PI*frequency*i/48000)),i*2);const d=new PcmDownsampler(48000,1),out=d.push(b);let sum=0;for(let i=400;i<out.length;i+=2)sum+=out.readInt16LE(i)**2;amplitudes.push(Math.sqrt(sum/((out.length-400)/2)));}
  assert.ok(amplitudes[1]/amplitudes[0]<.01);
});
test('调度补偿处理耗时，不把每帧CPU时间累积到20ms周期之后',()=>{
  let now=0,next=null,delay=null;const times=[];
  const clock=new PcmClock(()=>{times.push(now);now+=3;},{now:()=>now,schedule:(fn,ms)=>{next=fn;delay=ms;return 1;},cancel:()=>{}}).start();
  for(let i=0;i<5;i++){assert.equal(delay,17);now+=delay;next();}clock.stop();assert.deepEqual(times,[0,20,40,60,80,100]);
});
