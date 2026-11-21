import test from 'node:test';
import assert from 'node:assert/strict';
import { interviewerMessages, respondentMessages, analystMessages, validateDecision, validateSummary, verifyEvidence, resolveEvidence } from '../src/text-interview.mjs';

const turns = [
  { id: 't1', role: 'interviewer', text: '是不是价格太高？' },
  { id: 't2', role: 'participant', text: '也不是付不起，主要是后面还是自己改。' },
];
test('访谈员和分析员只得到研究任务和公开对话，受访者没有研究员私有目标', () => {
  const brief = { goal: 'RESEARCHER_PRIVATE_GOAL' };
  const config = { role: 'INTERVIEWER_ROLE', runtime: 'INTERVIEWER_RUNTIME', brief, turns, remaining: 10, respondentRole: 'RESPONDENT_PRIVATE_HISTORY' };
  assert.doesNotMatch(JSON.stringify(interviewerMessages(config)), /RESPONDENT_PRIVATE_HISTORY/);
  assert.doesNotMatch(JSON.stringify(analystMessages(config)), /RESPONDENT_PRIVATE_HISTORY/);
  const respondent = respondentMessages({ ...config, role: 'RESPONDENT_PRIVATE_HISTORY', runtime: 'RESPONDENT_RUNTIME' });
  assert.match(JSON.stringify(respondent), /RESPONDENT_PRIVATE_HISTORY/);
  assert.doesNotMatch(JSON.stringify(respondent), /RESEARCHER_PRIVATE_GOAL|INTERVIEWER_RUNTIME/);
  assert.deepEqual(respondent.slice(1).map(m => m.role), ['user', 'assistant']);
});
test('追问依据必须来自已经存在的受访者原话', () => {
  assert.doesNotThrow(() => verifyEvidence([{ turn_id: 't2', quote: '主要是后面还是自己改' }], turns, true));
  assert.throws(() => verifyEvidence([{ turn_id: 't1', quote: '价格太高' }], turns, true));
  assert.throws(() => verifyEvidence([{ turn_id: 't2', quote: '我付不起' }], turns, true));
  assert.throws(() => verifyEvidence([{ turn_id: 't999', quote: '不存在' }], turns, true));
});
test('剩余提问为零必须结束，不能越过应用预算', () => {
  const d = { action: 'ask', utterance: '能讲讲那次经历吗？', topic: 'workflow', basis_turn_ids: [] };
  assert.doesNotThrow(() => validateDecision(d, turns, 1));
  assert.throws(() => validateDecision(d, turns, 0));
  assert.doesNotThrow(() => validateDecision({ ...d, action: 'finish', utterance: '谢谢，今天先聊到这里。' }, turns, 0));
});
test('连问保留为可见质量问题，收尾不能继续提问', () => {
  const d = validateDecision({ action: 'ask', utterance: '为什么买？什么时候买？', topic: 'trigger', basis_turn_ids: [] }, turns, 2);
  assert.equal(d.qualityIssues.length, 1);
  assert.throws(() => validateDecision({ action: 'finish', utterance: '还有什么补充吗？', topic: 'closing', basis_turn_ids: [] }, turns, 2));
});
test('小结引文不能用访谈员的诱导问题充当受访者证据', () => {
  const f = { finding: '受访者认为后续修改未得到帮助', evidence_turn_ids: ['t2'] };
  const s = { findings: [f, { ...f, finding: '受访者区分了支付能力与价值' }], unknowns: ['具体效果尚未测量'], next_steps: ['进一步验证修改工作流'] };
  assert.doesNotThrow(() => validateSummary(s, turns));
  assert.throws(() => validateSummary({ ...s, findings: [{ ...f, evidence_turn_ids: ['t1'] }, f] }, turns));
  assert.throws(() => validateSummary({ ...s, findings: [{ ...f, evidence_turn_ids: [] }, f] }, turns));
  assert.deepEqual(validateSummary(s, turns).findings[0].evidence, [{ turn_id: 't2', quote: turns[1].text }]);
});
test('程序只从真实受访者编号提取原文，拒绝虚构编号和引导问题', () => {
  assert.deepEqual(resolveEvidence(['t2'], turns, true), [{ turn_id: 't2', quote: turns[1].text }]);
  assert.throws(() => resolveEvidence(['t99'], turns, true));
  assert.throws(() => resolveEvidence(['t1'], turns, true));
  assert.throws(() => resolveEvidence(['t2', 't2'], turns, true));
});
test('不能将已经问过的相同问题再次发给受访者', () => {
  assert.throws(() => validateDecision({ action: 'ask', utterance: '是不是价格太高?', topic: 'decision', basis_turn_ids: [] }, turns, 5), /重复/);
});
