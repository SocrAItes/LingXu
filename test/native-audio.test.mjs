import test from'node:test';import assert from'node:assert/strict';import{mkdtemp,writeFile,readFile,rm}from'node:fs/promises';import{execFile}from'node:child_process';import{promisify}from'node:util';import path from'node:path';import os from'node:os';
import{NativeAudio}from'../src/native-audio.mjs';import{pcmWave}from'../src/pcm.mjs';
test('Windows WAV 轨道无需系统转码，仍按 ADC / DAC 时钟对齐',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'windows-recording-test-'));t.after(()=>rm(folder,{recursive:true,force:true}));
 const pcm=Buffer.alloc(3200);for(let i=0;i<1600;i++)pcm.writeInt16LE(1000,i*2);
 await writeFile(path.join(folder,'microphone.wav'),pcmWave(pcm));await writeFile(path.join(folder,'interviewer.wav'),pcmWave(pcm));
 const audio=new NativeAudio('unused',folder,{platform:'win32'});audio.origins={microphone:{host_s:50},interviewer:{host_s:50.02}};
 await audio.exportRecording();const wave=await readFile(path.join(folder,'conversation.wav'));assert.equal(wave.length,44+1920*4);
 assert.equal(wave.readInt16LE(44+2),0);assert.equal(wave.readInt16LE(44+320*4+2),1000);
 const clock=JSON.parse(await readFile(path.join(folder,'recording-clock.json'),'utf8'));assert.equal(clock.offsets.interviewer,320);
});
test('原生轨道导出按采集时钟对齐，保留真人与采访员独立声道',{skip:process.platform!=='darwin'},async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'native-recording-test-'));t.after(()=>rm(folder,{recursive:true,force:true}));const pcm=Buffer.alloc(16000);for(let i=0;i<8000;i++)pcm.writeInt16LE(Math.round(3000*Math.sin(i*.1)),i*2);await writeFile(path.join(folder,'fixture.wav'),pcmWave(pcm));
 for(const name of['microphone','interviewer-playback'])await promisify(execFile)('/usr/bin/afconvert',['-f','caff','-d','LEF32@48000','-c','1',path.join(folder,'fixture.wav'),path.join(folder,name+'.caf')]);
 const audio=new NativeAudio('unused',folder);audio.origins={microphone:{host_s:100},interviewer:{host_s:100.1}};await audio.exportRecording();const wave=await readFile(path.join(folder,'conversation.wav'));assert.equal(wave.readUInt16LE(22),2);assert.equal(wave.readUInt32LE(24),16000);assert.equal(wave.length,44+9600*4);
 const clock=JSON.parse(await readFile(path.join(folder,'recording-clock.json'),'utf8'));assert.equal(clock.offsets.microphone,0);assert.equal(clock.offsets.interviewer,1600);
 assert.equal(wave.readInt16LE(44+100*4+2),0);assert.notEqual(wave.readInt16LE(44+1700*4+2),0);
});
