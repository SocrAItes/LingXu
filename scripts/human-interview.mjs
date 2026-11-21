import { loadConfig, createConfig, configPath } from '../src/config.mjs';
import{fileURLToPath}from'node:url';import path from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdir,writeFile}from'node:fs/promises';
import{buildNativeAudio,NativeAudio}from'../src/native-audio.mjs';import{HumanInterview}from'../src/human-interview.mjs';
import{ensureLocalModel}from'../src/local-model.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.argv.includes('--setup')){console.log(await createConfig(root));process.exit(0);}
await loadConfig();
const binary=await buildNativeAudio(root);
if(process.argv.includes('--check-audio')){const exec=promisify(execFile);for(const flag of['--self-test','--status']){const r=await exec(binary,[flag],{windowsHide:true});process.stdout.write(r.stderr);}process.exit(0);}
if(!process.env.MOSS_API_KEY)throw new Error(`请在本机私有配置 ${configPath()} 中设置 MOSS_API_KEY；首次运行请先执行 --setup。`);
await ensureLocalModel(root);
const index=process.argv.indexOf('--rounds'),maxRounds=index<0?8:Number(process.argv[index+1]);if(!Number.isInteger(maxRounds)||maxRounds<2||maxRounds>12)throw new Error('--rounds须为2～12');
let audio,session,finishing;const finish=()=>{
 if(finishing)return finishing;
 finishing=(async()=>{await audio.stop();try{session.recordingBytes=await audio.exportRecording();}catch(e){console.error('录音转换失败，原始音轨已保留：',e.message);}await session.finalize();})();return finishing;
};
session=new HumanInterview({root,key:process.env.MOSS_API_KEY,maxRounds,send:(m,binary=false)=>{
 if(binary){audio.audio(m);return;}
 if(m.type==='provider_event')audio.provider(m.event);
 else if(m.type==='question')console.log(`采访员：${m.text}`);
 else if(m.type==='answer')console.log(`你：${m.text}`);
 else if(m.type==='human_state'&&m.phase==='listening')console.log('请直接回答。');
 else if(m.type==='finish_recording')void finish().catch(e=>{console.error(e.message);process.exitCode=1;});
 else if(m.type==='saved')console.log(`已保存：${m.folder}`);
 else if(m.type==='error')console.error(m.message);
}});
await mkdir(session.folder,{recursive:true});audio=new NativeAudio(binary,session.folder);
audio.on('pcm',packet=>session.input(packet));audio.on('playback',e=>{void session.playback(e).catch(error=>session.fail(error));});
audio.on('event',e=>{session.trace('native.audio',e);if(e.type==='permission_required')console.log('请在系统提示中允许麦克风。');});
audio.on('diagnostic',message=>session.trace('native.diagnostic',{message}));audio.on('failure',error=>{if(session.journal)void session.fail(error);});
for(const signal of['SIGINT','SIGTERM'])process.on(signal,()=>{void session.end('operator_ended');});
console.log('真人语音访谈：无需页面或按钮。听完问题直接回答，说“结束访谈”结束并保存。');
try{await audio.start();session.work=session.start();await session.work;}catch(error){console.error(error.message);process.exitCode=1;if(session.journal){await session.end('error');await finish();}else{await audio.stop();await writeFile(path.join(session.folder,'启动失败.txt'),error.message);}}
