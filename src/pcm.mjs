export function pcmWave(pcm, rate = 16000, channels = 1) {
  const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(channels,22);h.writeUInt32LE(rate,24);h.writeUInt32LE(rate*channels*2,28);h.writeUInt16LE(channels*2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);
}
export function taggedPcm(bytes) {
  if(bytes.length%641)throw new Error('带标签输入帧长度必须是641字节的整数倍');
  const pcm=Buffer.alloc(bytes.length/641*640);
  for(let p=0;p<bytes.length;p+=641){if(bytes[p]!==0)throw new Error('音频记录含非音频标签');bytes.copy(pcm,p/641*640,p+1,p+641);}
  return pcm;
}
export function sampleClockTracks(segments,rate=16000){
  const parts=segments.filter(s=>s.pcm.length&&!s.context?.bootstrap);
  if(parts.some(s=>!Number.isInteger(s.sample_index)))throw new Error('录音片段缺少采样序号，禁止按包到达时间插入空隙');
  const start=parts.length?Math.min(...parts.map(s=>s.sample_index)):0;
  const end=parts.length?Math.max(...parts.map(s=>s.sample_index+s.pcm.length/2)):start;
  const samples=end-start+rate,tracks={interviewer:Buffer.alloc(samples*2),respondent:Buffer.alloc(samples*2)};
  for(const s of parts)s.pcm.copy(tracks[s.source],(s.sample_index-start)*2);
  const stereo=Buffer.alloc(samples*4);
  for(let i=0;i<samples;i++){stereo.writeInt16LE(tracks.interviewer.readInt16LE(i*2),i*4);stereo.writeInt16LE(tracks.respondent.readInt16LE(i*2),i*4+2);}
  return {tracks,stereo,samples,startSample:start,rate};
}

// Stateful antialias FIR decimation. HTTP chunks may end inside a PCM sample or stereo frame.
export class PcmDownsampler {
  constructor(rate,channels,bits=16){
    if(![16000,32000,48000].includes(rate)||![1,2].includes(channels)||bits!==16)throw new Error(`不支持的流式PCM参数：${rate}/${channels}/${bits}`);
    this.factor=rate/16000;this.channels=channels;this.pending=Buffer.alloc(0);this.phase=0;this.ring=new Float64Array(63);this.index=0;
    const cutoff=.45/this.factor;
    this.taps=Float64Array.from({length:63},(_,i)=>{const x=i-31;return(x===0?2*cutoff:Math.sin(2*Math.PI*cutoff*x)/(Math.PI*x))*(.54-.46*Math.cos(2*Math.PI*i/62));});
    const sum=this.taps.reduce((a,b)=>a+b,0);this.taps=this.taps.map(x=>x/sum);
  }
  push(bytes){
    const b=Buffer.concat([this.pending,bytes]),frameBytes=this.channels*2,n=b.length-b.length%frameBytes,out=[];
    for(let p=0;p<n;p+=frameBytes){let mono=0;for(let c=0;c<this.channels;c++)mono+=b.readInt16LE(p+c*2)/this.channels;
      this.ring[this.index]=mono;this.index=(this.index+1)%63;this.phase++;
      if(this.phase===this.factor){this.phase=0;let value=mono;if(this.factor>1){value=0;for(let k=0;k<63;k++)value+=this.taps[k]*this.ring[(this.index-1-k+126)%63];}out.push(Math.max(-32768,Math.min(32767,Math.round(value))));}
    }
    this.pending=Buffer.from(b.subarray(n));const result=Buffer.alloc(out.length*2);out.forEach((v,i)=>result.writeInt16LE(v,i*2));return result;
  }
  finish(){if(this.pending.length)throw new Error('流式PCM终止在不完整的声道帧');}
}

export class PcmClock {
  constructor(frame,{now=()=>performance.now(),schedule=setTimeout,cancel=clearTimeout}={}){Object.assign(this,{frame,now,schedule,cancel});this.stopped=true;}
  start(){this.stopped=false;this.origin=this.now();this.frames=0;this.pump();return this;}
  pump=()=>{if(this.stopped)return;const target=this.origin+this.frames*20,delay=target-this.now();if(delay>.5){this.timer=this.schedule(this.pump,Math.max(1,delay));return;}this.frame({frame:this.frames++,target_ms:target,late_ms:this.now()-target});if(!this.stopped)this.timer=this.schedule(this.pump,Math.max(1,this.origin+this.frames*20-this.now()));};
  stop(){this.stopped=true;this.cancel(this.timer);}
}
