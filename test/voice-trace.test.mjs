import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latencyReport, VoiceTrace } from '../src/voice-trace.mjs';

test('时延只按同一时钟的明确编号配对，不混淆输入段与输出话轮', () => {
  const events = [
    { clock: 'server', stage: 'provider.event', t_ms: 100, data: { action: 'input.speech.stopped', input_turn_id: 'u1' } },
    { clock: 'server', stage: 'provider.event', t_ms: 120, data: { action: 'response.audio.started', run_id: 'r1', turn_id: 'u1' } },
    { clock: 'server', stage: 'provider.event', t_ms: 130, data: { action: 'input.transcript.done', input_turn_id: 'u1' } },
    { clock: 'server', stage: 'provider.audio.received', t_ms: 155, data: {} },
    { clock: 'server', stage: 'provider.audio.received', t_ms: 180, data: { run_id: 'r2', turn_id: 'u1' } },
    { clock: 'server', stage: 'provider.audio.received', t_ms: 200, data: { run_id: 'r1', turn_id: 'u1' } },
    { clock: 'server', stage: 'provider.audio.received', t_ms: 210, data: { run_id: 'r1', turn_id: 'u1' } },
    { clock: 'browser', stage: 'provider.event', t_ms: 8000, data: { action: 'response.audio.started', run_id: 'r1', turn_id: 'u1' } },
    { clock: 'browser', stage: 'audio.scheduled', t_ms: 8050, data: { run_id: 'r1', turn_id: 'u1', queue_ms: 15, presentation_estimate_ms: 8065 } },
  ];
  const report = latencyReport(events), metric = name => report.metrics.find(m => m.name === name);
  assert.equal(metric('server/speech_stop_to_final_transcript_ms').p50, 30);
  assert.equal(metric('server/audio_start_notification_to_first_pcm_ms').p50, 80);
  assert.equal(metric('server/audio_start_notification_to_first_pcm_ms').count, 1);
  assert.equal(metric('server/speech_stop_to_first_audio_ms'), undefined);
  assert.equal(metric('browser/audio_start_notification_to_scheduled_output_estimate_ms').p50, 65);
  assert.equal(report.metrics.some(m => m.name.endsWith('/presentation_estimate_ms')), false);
  assert.equal(report.unavailable.length, 4);
});

test('原始事件落盘保留时钟和编号，非法浏览器事件被拒绝', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'moss-trace-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const failures = [], trace = new VoiceTrace(folder, 'test-session', e => failures.push(e));
  trace.mark('provider.connect');
  trace.browser({ stage: 'websocket.rtt', t_ms: 500, data: { rtt_ms: 8 } });
  trace.browser({ stage: 'bad event', t_ms: 510 });
  const report = await trace.flush();
  const lines = (await readFile(path.join(folder, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(e => e.clock), ['server', 'browser']);
  assert.equal(lines[1].t_ms, 500); assert.equal(report.eventCount, 2); assert.equal(failures.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(folder, 'latency.json'), 'utf8')).eventCount, 2);
});
