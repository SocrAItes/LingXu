import { PcmDownsampler, pcmWave } from './pcm.mjs';
import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const FEMALE_INTERVIEWER_VOICE={id:'6c3152b1-1d4f-4e49-ade3-09f447712fec',name:'暖暖'};
export const DEFAULT_TTS_MODEL='moss-tts-2.0-flash-preview';
export async function streamQuestion({text,voice=FEMALE_INTERVIEWER_VOICE.id,model=DEFAULT_TTS_MODEL,key,folder,base,round,closing=false,onPcm,trace=()=>{},fetcher=fetch}){
  const payload={model,input:text,voice_id:voice,language:'Chinese',response_format:'pcm',stream:true,stream_format:'audio'};
  const at=performance.now();trace('tts.request',{round,closing,payload});
  const r=await fetcher('https://api.mosi.cn/v1/audio/speech',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(60000)});
  const headersAt=performance.now(),headers=Object.fromEntries(r.headers),raw=[],converted=[];let firstBody=null,firstPcm=null,resamplingMs=0;
  if(!r.ok){const body=await r.text();await writeFile(path.join(folder,'tts',`${base}-error.txt`),body);trace('tts.failed',{round,status:r.status});throw new Error(`MOSS TTS HTTP ${r.status}`);}
  if(!(headers['content-type']||'').includes('audio/pcm'))throw new Error('TTS没有返回PCM流，不能猜测音频格式');
  const rate=Number(headers['x-sample-rate']),channels=Number(headers['x-channels']),bits=Number(headers['x-bit-depth']);
  const decoder=new PcmDownsampler(rate,channels,bits);
  for await(const bytes of r.body){const now=performance.now();firstBody??=now;const chunk=Buffer.from(bytes);raw.push(chunk);const started=performance.now(),pcm=decoder.push(chunk);resamplingMs+=performance.now()-started;
    trace('tts.audio.delta',{round,closing,bytes:chunk.length,pcm_bytes:pcm.length});
    if(pcm.length){firstPcm??=performance.now();converted.push(pcm);onPcm(pcm);}
  }
  decoder.finish();const end=performance.now(),body=Buffer.concat(raw),pcm=Buffer.concat(converted);
  await Promise.all([writeFile(path.join(folder,'tts',`${base}-response.pcm`),body),writeFile(path.join(folder,'tts',`${base}-original.wav`),pcmWave(body,rate,channels)),writeFile(path.join(folder,'tts',`${base}.wav`),pcmWave(pcm))]);
  const timing={headers_ms:headersAt-at,first_body_byte_ms:firstBody===null?null:firstBody-at,first_pcm_ms:firstPcm===null?null:firstPcm-at,body_complete_ms:end-at,resampling_ms:resamplingMs};
  const record={round,closing,payload,response:{status:r.status,headers,bodyFile:`tts/${base}-response.pcm`},audioFile:`tts/${base}-original.wav`,audioBytes:body.length,timing};
  await appendFile(path.join(folder,'tts-requests.jsonl'),JSON.stringify(record)+'\n');trace('tts.response',{round,closing,status:r.status,headers,timing,bytes:body.length});trace('tts.pcm.ready',{round,closing,duration_ms:resamplingMs,total_ms:end-at,audio_duration_ms:pcm.length/32});
  return record;
}
