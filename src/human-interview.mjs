import { mkdir,readFile,writeFile,appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { archiveFolder } from './archive.mjs';
import { pcmWave,taggedPcm } from './pcm.mjs';
import { VoiceTree,voiceTreeGraph } from './voice-tree.mjs';
import { voiceTreeSvg } from './voice-tree-svg.mjs';
import { RealtimePeer } from './realtime-peer.mjs';
import { VoiceTrace } from './voice-trace.mjs';
import { makeQwenClient } from './question-lab.mjs';
import { streamQuestion,FEMALE_INTERVIEWER_VOICE,DEFAULT_TTS_MODEL } from './moss-tts.mjs';

export class HumanInterview {
  constructor({root,key,send,maxRounds=8,peerFactory,callFactory,tts=streamQuestion,autoAdvanceMs=1600}){
    Object.assign(this,{root,key,send,maxRounds,peerFactory,callFactory,tts,autoAdvanceMs});
    this.id=randomUUID();this.folder=path.join(process.env.HUMAN_RECORDINGS_DIR||path.join(root,'data','human-interviews'),this.id);this.phase='preparing';this.ended=false;this.abort=new AbortController();this.serial=Promise.resolve();this.segments=new Map();this.calls=[];this.round=0;this.playbackRun=null;this.recordingBytes={wav:0};this.frame=0;this.asrEvents=[];this.asrRounds=new Map();this.asrLatest=new Map();this.answerSources=new Map();this.callContext=new AsyncLocalStorage();this.callSeq=0;
  }
  emit(type,data={}){this.send({type,...data});}
  state(phase){this.phase=phase;this.emit('human_state',{phase,round:this.round,maxRounds:this.maxRounds,sessionId:this.id,question:this.tree?.steps.at(-1)?.question.planned_text||null});}
  trace(stage,data={}){this.journal?.mark(stage,data);}
  save(snapshot=this.tree?.snapshot()){
    if(!snapshot)return this.serial;
    const state=JSON.stringify(snapshot,null,2),graph=JSON.stringify(voiceTreeGraph(snapshot),null,2),svg=voiceTreeSvg(snapshot);
    this.serial=this.serial.then(async()=>{await writeFile(path.join(this.folder,'tree-state.json'),state);await writeFile(path.join(this.folder,'tree.json'),graph);await writeFile(path.join(this.folder,'tree.svg'),svg);});return this.serial;
  }
  async start(){
    await mkdir(path.join(this.folder,'tts'),{recursive:true,mode:0o700});await mkdir(path.join(this.folder,'raw-audio'),{recursive:true});
    this.journal=new VoiceTrace(this.folder,this.id,()=>this.emit('error',{message:'记录保存失败'}));
    this.emit('session_ready',{sessionId:this.id,folder:this.folder});
    this.state('preparing');
    const role=await readFile(path.join(this.root,'roles/许知.md'),'utf8'),runtime=await readFile(path.join(this.root,'prompts/interviewer-text.txt'),'utf8');
    const client=this.callFactory?this.callFactory():makeQwenClient({base:process.env.TEXT_MODEL_BASE_URL||'http://127.0.0.1:11434/v1',model:process.env.TEXT_MODEL||'qwen3:8b',apiKey:process.env.TEXT_MODEL_API_KEY,audit:async r=>{const item={...this.callContext.getStore(),...r};this.calls.push(item);await appendFile(path.join(this.folder,'model-requests.jsonl'),JSON.stringify(item)+'\n');}});
    const call=async(actor,messages,options)=>{const meta={call_id:`call-${++this.callSeq}`,round:this.tree.steps.length,actor};this.trace('model.request.started',{...meta,messages});const at=performance.now();try{const r=await this.callContext.run(meta,()=>client(actor,messages,{...options,signal:options?.signal?AbortSignal.any([this.abort.signal,options.signal]):this.abort.signal}));r.record.call_id=meta.call_id;this.trace('model.request.completed',{...meta,duration_ms:performance.now()-at});return r;}catch(e){this.trace('model.request.failed',{...meta,message:e.message});throw e;}};
    this.tree=new VoiceTree({call,role,runtime,maxRounds:this.maxRounds,trace:(s,d)=>this.trace(s,d),changed:s=>this.save(s)});
    await writeFile(path.join(this.folder,'frozen-inputs.json'),JSON.stringify({mode:'human',maxRounds:this.maxRounds,role,runtime,voice:process.env.INTERVIEWER_VOICE||FEMALE_INTERVIEWER_VOICE.id,ttsModel:process.env.MOSS_TTS_MODEL||DEFAULT_TTS_MODEL,robotPersonaUsed:false,artificialHumanDelayMs:0,autoAdvanceMs:this.autoAdvanceMs,recording:'系统麦克风与播放器分别按原生音频时钟录制；非外部扬声器声学回录'},null,2));
    await new Promise((resolve,reject)=>{
      this.peer=new RealtimePeer({name:'human-listener',key:this.key,playback:'server',model:process.env.MOSS_MODEL||'moss-live-1.0',factory:this.peerFactory,instructions:'只听取用户的真实回答。不得猜测用户经历，不调用工具。后续问题由外部研究控制器决定。',persona:{name:'输入监听',prompt:'只理解真人语音，不代替受访者回答。'},trace:(s,d)=>this.trace(s,d)});
      const timer=setTimeout(()=>reject(new Error('语音连接初始化超时')),25000);
      this.peer.once('ready',()=>{clearTimeout(timer);resolve();});
      this.peer.on('failure',e=>{clearTimeout(timer);reject(e);if(this.tree&&!this.ended){this.emit('error',{message:e.message});void this.end('provider_error');}});
      this.peer.on('event',e=>this.provider(e));
      this.peer.on('audio',c=>{c.acknowledge();}); // Native auto-replies never enter the interviewer's playback.
    });
    if(!this.ended)await this.ask(await this.tree.next());
  }
  provider(event){
    const a=event.action,d=event.data||{};
    if(/^input\.(speech|transcript)\./.test(a)){
      if(d.turn!==undefined&&!this.asrRounds.has(d.turn)&&this.phase==='listening')this.asrRounds.set(d.turn,this.round);
      const round=d.turn===undefined?(this.phase==='listening'?this.round:null):(this.asrRounds.get(d.turn)??null);
      const item={event_id:`asr-${this.asrEvents.length+1}`,at:new Date().toISOString(),t_ms:performance.now(),round,round_at_receipt:this.round,phase:this.phase,action:a,data:d,accepted_for_current_answer:!this.ended&&this.phase==='listening'&&round===this.round};
      this.asrEvents.push(item);this.trace('asr.event',item);if(['input.transcript.done','input.transcript.revised'].includes(a)&&d.turn!==undefined)this.asrLatest.set(d.turn,item.event_id);
      this.serial=this.serial.then(()=>appendFile(path.join(this.folder,'识别原文.jsonl'),JSON.stringify(item)+'\n'));
    }
    if(d.turn!==undefined&&this.asrRounds.has(d.turn)&&this.asrRounds.get(d.turn)!==this.round)return;
    if(this.ended||this.phase!=='listening')return;
    if(a==='input.speech.started'){this.speaking=true;clearTimeout(this.answerTimer);}
    if(a==='input.speech.stopped'){this.speaking=false;this.arm();}
    if(a==='input.transcript.updated')this.emit('interim',{text:d.text||''});
    if(['input.transcript.done','input.transcript.revised'].includes(a)&&d.text?.trim()){
      const key=d.turn||`segment-${this.segments.size+1}`;this.segments.set(key,d.text);this.lastAsrAt=performance.now();
      if(/^(好[了的吧]?[，,。\s]*)?(我们)?(结束访谈|停止访谈|结束吧|到此为止)[。！!，,\s]*$/.test(d.text.trim())){this.trace('human.voice_end',{text:d.text});void this.end('voice_ended');return;}
      this.emit('recognized',{text:[...this.segments.values()].join(''),round:this.round});this.arm();
    }
  }
  arm(){clearTimeout(this.answerTimer);if(this.phase==='listening'&&!this.speaking&&this.segments.size)this.answerTimer=setTimeout(()=>{void this.commit().catch(e=>this.fail(e));},this.autoAdvanceMs);}
  async ask(next){
    if(this.ended)return;
    this.round=this.tree.steps.length;this.current=next;this.segments.clear();this.speaking=false;
    this.state('speaking');this.emit('question',{text:next.utterance,round:this.round,closing:next.action==='finish'});
    const run_id=`human-${this.id}-${this.round}-${next.action}`,turn_id=`question-${this.round}`;this.playbackRun=run_id;let chunks=0;
    this.emit('provider_event',{event:{action:'response.audio.started',data:{run_id,turn_id}}});
    await this.tts({text:next.utterance,key:this.key,voice:process.env.INTERVIEWER_VOICE||FEMALE_INTERVIEWER_VOICE.id,model:process.env.MOSS_TTS_MODEL||DEFAULT_TTS_MODEL,folder:this.folder,base:`round-${String(this.round).padStart(2,'0')}-${next.action}`,round:this.round,closing:next.action==='finish',trace:(s,d)=>this.trace(s,d),onPcm:pcm=>{
      if(this.ended)return;const meta={run_id,turn_id,chunk_id:`chunk-${++chunks}`,sample_rate:16000};
      this.emit('provider_event',{event:{action:'response.audio.context',data:meta}});this.send(pcm,true);
    }});
    if(!this.ended)this.emit('provider_event',{event:{action:'response.audio.done',data:{run_id,turn_id}}});
  }
  async playback(event){
    this.trace('native.playback',{event});
    if(this.ended||event.run_id!==this.playbackRun||event.action!=='playback.completed')return;
    if(this.current.action==='finish'){this.tree.closing.spoken=true;await this.end('completed');return;}
    const q=this.tree.steps.at(-1)?.question;if(q&&!q.spoken)await this.tree.spoken(q.planned_text,this.round);
    this.state('listening');
  }
  input(packet){
    if(this.ended||this.phase!=='listening'||packet[0]!==0||packet.length!==641)return;
    const frame=++this.frame,round=this.round;this.trace('microphone.frame',{frame_id:frame,round,bytes:packet.length});
    this.serial=this.serial.then(()=>appendFile(path.join(this.folder,'raw-audio',`round-${String(round).padStart(2,'0')}-input.tagged`),packet));
    this.peer.input(packet,{frame_id:frame,round,source:'human_microphone'});
  }
  async commit(){
    if(this.ended||this.phase!=='listening')return;
    if(!this.segments.size){this.emit('notice',{message:'还没有识别到完整回答，请继续说。'});return;}
    clearTimeout(this.answerTimer);const answer=[...this.segments.values()].join('');
    const source={round:this.round,text:answer,input_turn_ids:[...this.segments.keys()],asr_event_ids:[...this.segments.keys()].map(k=>this.asrLatest.get(k)).filter(Boolean)};this.answerSources.set(this.round,source);this.trace('tree.actual_answer',source);
    this.emit('answer',{text:answer,round:this.round});this.state('thinking');
    this.work=(async()=>{const next=await this.tree.next(answer);if(!this.ended)await this.ask(next);})();await this.work;
  }
  pause(paused){clearTimeout(this.answerTimer);if(this.ended)return;if(paused&&this.phase==='listening')this.state('paused');else if(!paused&&this.phase==='paused'){this.state('listening');this.arm();}}
  async fail(error){if(this.ended)return;this.emit('error',{message:error.message});await this.end('error');}
  async end(reason='user_ended'){
    if(this.ended)return;this.ended=true;this.reason=reason;clearTimeout(this.answerTimer);this.abort.abort();this.peer?.close();this.state('finished');await this.save();this.emit('finish_recording',{reason,sessionId:this.id});
  }
  recording(bytes,format){
    if(!['webm','wav'].includes(format)||!this.journal||this.recordingBytes[format]+bytes.length>150*1024*1024)throw new Error('录音数据无效或过大');
    this.recordingBytes[format]+=bytes.length;this.serial=this.serial.then(()=>appendFile(path.join(this.folder,`conversation.${format}`),bytes));
  }
  async finalize(){
    await Promise.allSettled([this.work,this.tree?.poolTask]);await this.save();await this.serial;
    const snapshot=this.tree?.snapshot(),lines=['真人语音访谈记录',`状态：${this.reason||'disconnected'}；真人回答；未加载受访者人物卡。`,''];
    for(const s of snapshot?.steps||[])lines.push(`第${s.index}轮`,`采访员TTS输入：${s.question.planned_text}`,`真人回答（真实ASR）：${s.answer?.text||'(尚未提交)'}`,`模型选路：${JSON.stringify(s.selection?.decision||s.selection||null)}`,'');
    if(snapshot?.closing)lines.push(`收尾：${snapshot.closing.text}`);
    await writeFile(path.join(this.folder,'访谈文字稿.txt'),lines.join('\n'));
    const io=['真实模型输入输出（真人模式，无受访者人物卡）',''];for(const r of this.calls)io.push(`=== ${r.call_id} / ${r.actor} ===`,'INPUT',JSON.stringify(r.payload,null,2),'OUTPUT',r.response.content,'TIMING',JSON.stringify({durationMs:r.durationMs,...r.timing}),'');await writeFile(path.join(this.folder,'模型输入输出.txt'),io.join('\n'));
    await writeFile(path.join(this.folder,'report.json'),JSON.stringify({id:this.id,mode:'human',status:this.reason,answeredRounds:snapshot?.steps.filter(s=>s.answer).length||0,recordingBytes:this.recordingBytes,folder:this.folder,voice:process.env.INTERVIEWER_VOICE||FEMALE_INTERVIEWER_VOICE.id,artificialHumanDelayMs:0},null,2));
    await writeFile(path.join(this.folder,'识别原文.txt'),this.asrEvents.map(e=>`[${e.event_id}] ${e.action} round=${e.round??'未关联'} turn=${e.data.turn??'未提供'} phase=${e.phase}\n${e.data.text??''}`).join('\n\n'));
    const trajectory={session_id:this.id,mode:'human',steps:(snapshot?.steps||[]).map(s=>({round:s.index,question_id:s.question.id,question_tts_input:s.question.planned_text,played:s.question.spoken,asr_source:this.answerSources.get(s.index)||null,answer_used:s.answer||null,candidates:s.pool?.candidates||[],decision:s.selection?.decision||s.selection||null,next:s.next||null,model_call_ids:[...(s.selection?.attempts||[]),...(s.next?.attempts||[])].map(a=>a.call_id).filter(Boolean)})),note:'实际ASR更新和修订逐条保留；answer_used为决策当时收到的版本，后到的修订不会伪装成旧决策依据。未选分支没有虚构回答。'};
    await writeFile(path.join(this.folder,'决策轨迹.json'),JSON.stringify(trajectory,null,2));
    for(const s of snapshot?.steps||[]){const raw=await readFile(path.join(this.folder,'raw-audio',`round-${String(s.index).padStart(2,'0')}-input.tagged`)).catch(()=>null);if(raw)await writeFile(path.join(this.folder,`round-${String(s.index).padStart(2,'0')}-识别输入.wav`),pcmWave(taggedPcm(raw)));}
    await this.journal.flush();
    await writeFile(path.join(this.folder,'导出说明.txt'),['conversation.wav：真人麦克风与采访员双轨；conversation-listen.wav：合并试听。','microphone.caf / microphone.wav：真人原始采集和转换音轨；interviewer-playback.caf / interviewer.wav：采访员播放音轨。','round-XX-识别输入.wav：实际发给MOSS识别的逐轮音频。','识别原文.jsonl / 识别原文.txt：逐段更新、确认、修订，包含MOSS原始数据和轮次关联。','访谈文字稿.txt：访谈文稿；模型输入输出.txt / model-requests.jsonl：真实模型请求和返回。','决策轨迹.json：从识别事件ID到实际回答、候选、选路及模型调用ID；tree.json / tree.svg：路径与未采用候选。','events.jsonl / latency.json：原始事件和可观测时延；不伪造未暴露的内部阶段。'].join('\n'));
    if(['darwin','win32'].includes(process.platform)){this.exportZip=path.join(path.dirname(this.folder),`${this.id}-导出.zip`);await archiveFolder(this.folder,this.exportZip);}
    this.emit('saved',{sessionId:this.id,folder:this.folder,recordingBytes:this.recordingBytes,exportZip:this.exportZip});
  }
}
