import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ids = d => Object.fromEntries(['turn_id', 'run_id', 'chunk_id', 'call_id', 'frame_id'].filter(k => d[k] !== undefined).map(k => [k, d[k]]));
export const mediaIds = d => ({ ...ids(d), ...(d.turn !== undefined ? { input_turn_id: d.turn } : {}) });
const percentile = (v, p) => v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)];

export function latencyReport(events) {
  const groups = new Map(), pairs = new Map();
  function add(name, ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    const values = groups.get(name) || []; values.push(ms); groups.set(name, values);
  }
  for (const e of events) {
    for (const [k, v] of Object.entries(e.data || {})) if (['duration_ms', 'decode_ms', 'queue_ms', 'rtt_ms', 'base_latency_ms', 'output_latency_ms', 'frame_duration_ms', 'render_to_main_ms'].includes(k)) add(`${e.clock}/${e.stage}/${k}`, v);
    const d = e.data || {}, inputTurn = d.input_turn_id, run = d.run_id;
    if (e.clock === 'server' && e.stage === 'provider.event') {
      if (d.action === 'input.speech.stopped' && inputTurn !== undefined) pairs.set(`stop:${inputTurn}`, e.t_ms);
      if (d.action === 'input.transcript.done' && inputTurn !== undefined && pairs.has(`stop:${inputTurn}`)) add('server/speech_stop_to_final_transcript_ms', e.t_ms - pairs.get(`stop:${inputTurn}`));
      if (d.action === 'response.audio.started' && run !== undefined) pairs.set(`start:${run}`, e.t_ms);
      if (d.action?.startsWith('output.transcript.') && run !== undefined && !pairs.has(`text:${run}`)) pairs.set(`text:${run}`, e.t_ms);
    }
    if (e.clock === 'server' && e.stage === 'provider.audio.received' && run !== undefined && !pairs.has(`first_audio:${run}`)) {
      pairs.set(`first_audio:${run}`, e.t_ms);
      if (pairs.has(`start:${run}`)) add('server/audio_start_notification_to_first_pcm_ms', e.t_ms - pairs.get(`start:${run}`));
      if (pairs.has(`text:${run}`)) add('server/first_output_transcript_to_first_pcm_ms', e.t_ms - pairs.get(`text:${run}`));
    }
    if (e.clock === 'browser' && e.stage === 'provider.event' && d.action === 'response.audio.started' && run !== undefined) pairs.set(`browser_start:${run}`, e.t_ms);
    if (e.clock === 'browser' && e.stage === 'audio.scheduled' && run !== undefined && pairs.has(`browser_start:${run}`) && !pairs.has(`browser_audio:${run}`)) {
      pairs.set(`browser_audio:${run}`, e.t_ms); add('browser/audio_start_notification_to_scheduled_output_estimate_ms', d.presentation_estimate_ms - pairs.get(`browser_start:${run}`));
    }
  }
  const metrics = [...groups].map(([name, v]) => { v.sort((a, b) => a - b); return { name, count: v.length, min: v[0], p50: percentile(v, .5), p95: percentile(v, .95), max: v.at(-1) }; });
  return {
    eventCount: events.length, metrics,
    interpretation: '所有差值只使用同一时钟；跨端不直接相减。speech_stop 是服务端 VAD 通知，不能当作真人最后一字的物理时间。input.turn 与回复 turn_id 是不同编号域，不自动关联；只按明确的输入编号或 run_id 配对。',
    unavailable: [
      { metric: 'MOSS 内部 STT / LLM / TTS 各自计算时间', reason: '当前协议没有分别暴露这些阶段；不能把整个等待时间拆成三个虚构数值' },
      { metric: '单向网络时间', reason: '浏览器和服务器时钟未同步；记录 WebSocket RTT，不能用 RTT/2 当作实测单向延迟' },
      { metric: '物理麦克风采集 / 扬声器出声时间', reason: '没有外部回录；浏览器播放时间为 AudioContext 调度或 getOutputTimestamp 估算，onended 为回调到达时间' },
      { metric: '用户说完到对应模型首次文字 / 首音频', reason: '语音活动停止通知没有保证携带编号，输入 turn 与输出 turn_id 也没有公开的必然对应关系；保留原始事件，未可靠关联时不生成该统计' },
    ],
  };
}

export class VoiceTrace {
  constructor(folder, sessionId, onError = () => {}) {
    this.folder = folder; this.sessionId = sessionId; this.events = []; this.queue = mkdir(folder, { recursive: true, mode: 0o700 }); this.onError = onError;
  }
  mark(stage, data = {}, { clock = 'server', t_ms = performance.now() } = {}) {
    const event = { seq: this.events.length + 1, session_id: this.sessionId, at: new Date().toISOString(), clock, t_ms, stage, data };
    this.events.push(event);
    this.queue = this.queue.then(() => appendFile(path.join(this.folder, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })).catch(error => this.onError(error));
  }
  browser(event) {
    if (!event || typeof event.stage !== 'string' || !/^[a-z][a-z0-9_.]{0,79}$/.test(event.stage) || !Number.isFinite(event.t_ms) || event.t_ms < 0 || JSON.stringify(event).length > 16000) return;
    this.mark(event.stage, event.data || {}, { clock: 'browser', t_ms: event.t_ms });
  }
  async flush() {
    await this.queue;
    const report = latencyReport(this.events);
    await writeFile(path.join(this.folder, 'latency.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    return report;
  }
}
