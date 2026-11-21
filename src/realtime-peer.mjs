import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export class RealtimePeer extends EventEmitter {
  constructor({ name, key, voice, persona, instructions, tools = [], trace = () => {}, model = 'moss-live-1.0', factory, tool, playback = 'client' }) {
    super(); Object.assign(this, { name, voice, persona, instructions, tools, trace, tool, playback });
    this.runs = new Map(); this.handled = new Set(); this.awaiting = new Map(); this.config = {}; this.started = performance.now(); this.pendingContext = null; this.closed = false;
    this.ws = factory ? factory() : new WebSocket(`wss://api.mosi.cn/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20000, maxPayload: 4 * 1024 * 1024 });
    this.ws.on('open', () => { this.log('connection.open', { duration_ms: performance.now() - this.started }); this.send({ action: 'attach_session', session_id: null, memory_scope: 'session', delegation: { type: 'none' } }); });
    this.ws.on('message', (bytes, binary) => { try { if (binary) this.audio(bytes); else this.event(JSON.parse(bytes.toString())); } catch (error) { this.emit('failure', error); } });
    this.ws.on('error', error => this.emit('failure', new Error(`${name} WebSocket ${error.code || error.name}`)));
    this.ws.on('close', code => { this.log('connection.closed', { code }); if (!this.closed) this.emit('failure', new Error(`${name} 连接提前关闭 ${code}`)); });
  }
  log(stage, data = {}) { this.trace(stage, { peer: this.name, ...data }); }
  send(event) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error(`${this.name} 连接未打开`);
    const at = performance.now(); this.log('request', { event });
    this.ws.send(JSON.stringify(event), error => { this.log('request.flushed', { action: event.action, duration_ms: performance.now() - at, ok: !error }); if (error) this.emit('failure', new Error(`${this.name} 发送失败`)); });
  }
  input(packet, metadata = {}) {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 1024 * 1024) throw new Error(`${this.name} 上行积压超过1MB`);
    const at = performance.now();
    this.emit('input', { packet, metadata });
    this.log('input.queued', { ...metadata, bytes: packet.length });
    this.ws.send(packet, { binary: true }, error => { this.log('input.flushed', { ...metadata, duration_ms: performance.now() - at, ok: !error }); if (error) this.emit('failure', new Error(`${this.name} 音频发送失败`)); });
  }
  run(data) { if (!this.runs.has(data.run_id)) this.runs.set(data.run_id, { ...data, pending: 0, done: false, played: false }); return this.runs.get(data.run_id); }
  audio(bytes) {
    const meta = this.pendingContext; this.pendingContext = null;
    if (!meta) throw new Error(`${this.name} 音频没有关联上下文`);
    if (bytes.length % 2) throw new Error(`${this.name} PCM16长度错误`);
    const run = this.run(meta); run.pending++;
    this.log('audio.received', { ...meta, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    this.emit('audio', { pcm: Buffer.from(bytes), meta, acknowledge: () => { if (run.stopped) return; if(this.playback==='client') this.send({ action: 'playback.chunk.completed', run_id: meta.run_id, turn_id: meta.turn_id, chunk_id: meta.chunk_id }); run.pending--; this.complete(run); } });
  }
  complete(run) { if (run.done && !run.pending && !run.played && !run.stopped) { run.played = true; if(this.playback==='client') this.send({ action: 'playback.completed', run_id: run.run_id, turn_id: run.turn_id }); this.emit('played', run); } }
  event(event) {
    const a = event.action, d = event.data || {}; this.log('event', { event }); this.emit('event', event);
    if (a === 'session_attached') {
      this.sessionId = d.session_id;
      if (this.voice) this.send({ action: 'change_voice', voice_name: this.voice }); else this.configure();
    } else if (a === 'voice_changed') { if (d.error) throw new Error(`${this.name} 音色配置失败`); this.configure(); }
    else if (a === 'session.updated') { if (d.error !== '') throw new Error(`${this.name} 人设/工具配置失败`); this.config.session = true; }
    else if (a === 'media.configured') { if (d.error !== '' || d.output_audio?.sample_rate !== 16000 || d.output_audio?.format !== 'pcm16' || d.playback !== this.playback) throw new Error(`${this.name} PCM16/16k/播放模式配置失败`); this.config.media = true; }
    else if (a === 'response.audio.context') this.pendingContext = d;
    else if (a === 'response.audio.done') { const run = this.run(d); run.done = true; this.complete(run); }
    else if (a === 'response.audio.stop' || a === 'response.interrupted') { const run = this.run(d); run.stopped = true; this.emit('stop', d); }
    else if (a === 'response.function_call_arguments.done') this.functionCall(d);
    else if (a === 'response.done') { for (const call of d.response?.output || []) if (call.type === 'function_call') this.functionCall(call); }
    else if (a === 'conversation.item.created' && this.awaiting.has(d.item?.call_id)) {
      const id = d.item.call_id; this.log('tool.acknowledged', { call_id: id, duration_ms: performance.now() - this.awaiting.get(id) }); this.awaiting.delete(id); this.send({ action: 'response.create', response: { call_ids: [id] } });
    } else if (a === 'pong' && Number.isFinite(d.client_timestamp ?? d.timestamp)) this.log('network.rtt', { duration_ms: performance.now() - (d.client_timestamp ?? d.timestamp) });
    else if (a === 'error') throw new Error(`${this.name} MOSS错误 ${String(d.code || d.error?.code || 'unknown').slice(0,100)}`);
    if (!this.ready && this.config.session && this.config.media) { this.ready = true; this.log('session.ready', { duration_ms: performance.now() - this.started }); this.send({ action: 'mic_state', enabled: true }); this.emit('ready'); }
  }
  configure() {
    this.send({ action: 'session.update', session: { persona: this.persona, instructions: this.instructions, tools: this.tools } });
    this.send({ action: 'media.mode', binary_protocol: 'tagged-v1' });
    this.send({ action: 'media.configure', output_audio: { format: 'pcm16', sample_rate: 16000 }, playback: this.playback });
  }
  async functionCall(data) {
    if (this.handled.has(data.call_id)) return; this.handled.add(data.call_id);
    try {
      if (!this.tool) throw new Error('会话没有注册应用工具');
      const at = performance.now(); const result = await this.tool(data);
      if (this.closed) { this.log('tool.result.discarded', { call_id: data.call_id, reason: 'session closed' }); return; }
      this.log('tool.completed', { call_id: data.call_id, name: data.name, duration_ms: performance.now() - at, result });
      this.awaiting.set(data.call_id, performance.now());
      this.send({ action: 'conversation.item.create', item: { type: 'function_call_output', call_id: data.call_id, output: JSON.stringify(result) } });
    } catch (error) { this.emit('failure', error); }
  }
  close() { this.closed = true; this.ws.close(); }
}

// This is a paced, digital audio relay, not a measurement of physical speakers.
export class AudioRelay {
  constructor({ source, destination, trace = () => {}, save = () => {}, startDelayMs = 0, now = () => performance.now() }) { if(!Number.isFinite(startDelayMs)||startDelayMs<0)throw new Error('开口延迟无效');Object.assign(this, { source, destination, trace, save, startDelayMs, now }); this.queue = []; this.receipts = []; this.frames = 0; this.lastEnd = null;this.delayGroups=new Map(); }
  enqueue(chunk, context = {}) { this.queue.push({ ...chunk, context, offset: 0, receivedAt: this.now(), first: true }); }
  tick({ allowSpeech = true } = {}) {
    const now = this.now();
    while (this.receipts.length && this.receipts[0].at <= now) { const c = this.receipts.shift(); c.acknowledge?.(); this.trace('relay.chunk.completed', { source: this.source, destination: this.destination.name, ...c.meta, ...c.context, duration_ms: now - c.receivedAt }); }
    const packet = Buffer.alloc(641); let filled = 0; const segments = [], completed = [];
    while (allowSpeech && filled < 640 && this.queue.length) {
      const c = this.queue[0];
      const key=c.context.round!==undefined?`round-${c.context.round}`:c.meta.run_id;
      if(this.startDelayMs){
        if(!this.delayGroups.has(key)){this.delayGroups.set(key,{at:now,started:false});this.trace('relay.reply_delay.started',{source:this.source,...c.context,configured_ms:this.startDelayMs});}
        const delay=this.delayGroups.get(key);
        if(!delay.started){if(now-delay.at<this.startDelayMs)break;delay.started=true;this.trace('relay.reply_delay.completed',{source:this.source,...c.context,duration_ms:now-delay.at,configured_ms:this.startDelayMs});}
      }
      if (c.first) { c.first = false; this.trace('relay.chunk.started', { source: this.source, destination: this.destination.name, ...c.meta, ...c.context, duration_ms: performance.now() - c.receivedAt }); }
      const n = Math.min(640 - filled, c.pcm.length - c.offset);
      c.pcm.copy(packet, filled + 1, c.offset, c.offset + n);
      if (n) segments.push({ pcm: c.pcm.subarray(c.offset, c.offset + n), offsetSamples: filled / 2, context: c.context, meta: c.meta });
      c.offset += n; filled += n;
      if (c.offset >= c.pcm.length) { this.queue.shift(); completed.push({ ...c, endOffsetMs: filled / 32 }); }
    }
    const sentAt = performance.now(); this.destination.input(packet, { frame_id: ++this.frames, source: this.source, speech: Boolean(filled), round: segments[0]?.context.round });
    for (const c of completed) { this.lastEnd = sentAt + c.endOffsetMs; this.receipts.push({ ...c, at: this.lastEnd }); }
    for (const s of segments) this.save({ ...s, sample_index: (this.frames-1)*320+s.offsetSamples, t_ms: sentAt + s.offsetSamples / 16, source: this.source });
    return filled;
  }
  stop(run_id) { const removed = this.queue.filter(c => c.meta?.run_id === run_id); this.queue = this.queue.filter(c => c.meta?.run_id !== run_id); this.receipts = this.receipts.filter(c => c.meta?.run_id !== run_id); this.trace('relay.stopped', { source: this.source, run_id, dropped_bytes: removed.reduce((n,c)=>n+c.pcm.length-c.offset,0) }); }
}
