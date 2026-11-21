import{EventEmitter}from'node:events';import{spawn,execFile}from'node:child_process';import{promisify}from'node:util';import{mkdir,stat,readFile,writeFile}from'node:fs/promises';import path from'node:path';
import{pcmWave}from'./pcm.mjs';
const exec=promisify(execFile);
export async function buildNativeAudio(root){
 if(process.platform==='win32'){
  const binary=path.join(root,'.cache','voice-console.exe');
  await stat(binary).catch(()=>{throw new Error('缺少 Windows 音频桥。请下载 Windows 发布包，或按部署文档先用 PyInstaller 编译 native/windows/audio_bridge.py。');});return binary;
 }
 if(process.platform!=='darwin')throw new Error('音频采集仅支持 macOS 和 Windows');
 const dir=path.join(root,'.cache'),binary=path.join(dir,'voice-console'),source=path.join(root,'native/VoiceConsole.swift'),info=path.join(root,'native/Info.plist');await mkdir(dir,{recursive:true});
 if(await stat(binary).catch(()=>null)&&await stat(path.join(dir,'prebuilt')).catch(()=>null))return binary;
 const [a,b,c]=await Promise.all([stat(source),stat(info),stat(binary).catch(()=>null)]);if(c&&(await stat(path.join(dir,'prebuilt')).catch(()=>null)||c.mtimeMs>=Math.max(a.mtimeMs,b.mtimeMs)))return binary;
 await exec('/usr/bin/swiftc',[source,'-o',binary,'-framework','AVFoundation','-module-cache-path',path.join(dir,'swift-modules'),'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',info],{maxBuffer:1024*1024});
 await exec('/usr/bin/codesign',['--force','--sign','-','--identifier','ai.lingxu.listenflow.audio',binary]);return binary;
}
export class NativeAudio extends EventEmitter {
 constructor(binary,folder,{platform=process.platform}={}){super();this.binary=binary;this.folder=folder;this.platform=platform;this.origins={};this.pending=new Map();this.context=null;}
 start(){return new Promise((resolve,reject)=>{
  this.child=spawn(this.binary,[this.folder],{stdio:['pipe','pipe','pipe'],env:process.env,windowsHide:true});let pcm=Buffer.alloc(0),stderr='';
  this.child.on('error',reject);this.child.on('exit',code=>{this.exited=true;this.emit('exit',code);if(code&&!this.stopping){const error=new Error(`系统音频进程退出 ${code}`);reject(error);this.emit('failure',error);}});
  this.child.stdout.on('data',bytes=>{pcm=Buffer.concat([pcm,bytes]);while(pcm.length>=640){const packet=Buffer.alloc(641);pcm.copy(packet,1,0,640);pcm=pcm.subarray(640);this.emit('pcm',packet);}});
  this.child.stderr.on('data',bytes=>{stderr+=bytes.toString();let newline;while((newline=stderr.indexOf('\n'))>=0){const line=stderr.slice(0,newline);stderr=stderr.slice(newline+1);let e;try{e=JSON.parse(line);}catch{this.emit('diagnostic',line);continue;}this.emit('event',e);
   if(e.type==='ready')resolve(e);
   if(e.type==='capture_origin')this.origins[e.track]=e;
   if(e.type==='error'){const error=new Error(e.message);reject(error);this.emit('failure',error);}
   if(e.type==='chunk_played'){const run=this.pending.get(e.run_id);if(run){run.count--;this.complete(e.run_id,run);}}
  }});
 });}
 command(data){if(!this.child||this.exited)return;this.child.stdin.write(JSON.stringify(data)+'\n');}
 provider(event){const a=event.action,d=event.data||{};if(a==='response.audio.context')this.context=d;else if(a==='response.audio.done'){const run=this.pending.get(d.run_id)||{count:0,done:false,turn_id:d.turn_id};run.done=true;this.pending.set(d.run_id,run);this.complete(d.run_id,run);}}
 audio(pcm){if(!this.context)throw new Error('原生播放缺少音频上下文');const d=this.context;this.context=null;const run=this.pending.get(d.run_id)||{count:0,done:false,turn_id:d.turn_id};run.count++;this.pending.set(d.run_id,run);this.command({action:'chunk',...d,pcm:pcm.toString('base64')});}
 complete(id,run){if(run.done&&!run.count&&!run.completed){run.completed=true;this.emit('playback',{action:'playback.completed',run_id:id,turn_id:run.turn_id});}}
 async stop(){if(this.stopping)return this.stopping;this.stopping=(async()=>{if(!this.exited){await new Promise(resolve=>{this.child.once('exit',resolve);this.command({action:'stop'});const timer=setTimeout(()=>{this.child.kill('SIGTERM');resolve();},5000);timer.unref();});}})();return this.stopping;}
 async exportRecording(){
  const tracks={};
  for(const[name,file]of[['microphone','microphone'],['interviewer','interviewer-playback']]){
   const target=path.join(this.folder,`${name}.wav`);if(this.platform==='darwin')await exec('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',path.join(this.folder,`${file}.caf`),target]);const bytes=await readFile(target);
   let pcm;for(let p=12;p+8<=bytes.length;){const size=bytes.readUInt32LE(p+4);if(bytes.toString('ascii',p,p+4)==='data'){pcm=bytes.subarray(p+8,p+8+size);break;}p+=8+size+size%2;}if(!pcm)throw new Error('原生录音缺少PCM数据');tracks[name]=pcm;
  }
  const origins=this.origins,start=Math.min(origins.microphone?.host_s??0,origins.interviewer?.host_s??0),offsets={};let frames=0;
  for(const[name,pcm]of Object.entries(tracks)){offsets[name]=Math.max(0,Math.round(((origins[name]?.host_s??start)-start)*16000));frames=Math.max(frames,offsets[name]+pcm.length/2);}
  const stereo=Buffer.alloc(frames*4),mono=Buffer.alloc(frames*2);
  for(const[name,pcm]of Object.entries(tracks)){const channel=name==='microphone'?0:1;for(let i=0;i<pcm.length/2;i++)stereo.writeInt16LE(pcm.readInt16LE(i*2),(offsets[name]+i)*4+channel*2);}
  for(let i=0;i<frames;i++)mono.writeInt16LE(Math.max(-32768,Math.min(32767,stereo.readInt16LE(i*4)+stereo.readInt16LE(i*4+2))),i*2);
  await Promise.all([writeFile(path.join(this.folder,'conversation.wav'),pcmWave(stereo,16000,2)),writeFile(path.join(this.folder,'conversation-listen.wav'),pcmWave(mono)),writeFile(path.join(this.folder,'recording-clock.json'),JSON.stringify({origins,offsets,rate:16000,frames,note:'原生输入采集和播放器输出分别录制，按CoreAudio或PortAudio采集时钟对齐；不按网络包时间插缝，非外部声学回录。'},null,2))]);
  return{wav:44+stereo.length};
 }
}
