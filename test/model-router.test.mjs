import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWithModel } from '../src/model-router.mjs';
import { contextHash } from '../src/question-lab.mjs';

const prefix = [{ id: 't1', role: 'interviewer', text: '后来怎样？' }];
const pool = { contextHash: contextHash(prefix), candidates: [{ id: 'c1', question: '替代方案怎么操作？', eligible: true, flags: [] }, { id: 'c2', question: '重复问题？', eligible: false, flags: ['repeat'] }] };
const decision = { action: 'select', candidate_id: 'c1', utterance: null, basis_turn_ids: ['t2'], reason: '最新回答说明换了工具，继续了解具体过程。' };
test('采用模型明确选中的问题，不用关键词覆盖选择', async () => {
  const result = await selectWithModel(async (_, messages) => {
    const input = JSON.parse(messages[1].content); assert.deepEqual(input.evidence_constraint.allowed_ids, ['t2']);
    return { value: decision, record: {} };
  }, pool, prefix, '改用其他工具了', {});
  assert.equal(result.source, 'model'); assert.equal(result.candidate.question, pool.candidates[0].question);
});
test('无效候选、数字原话编号和过期上下文不能变成成功命中', async () => {
  for (const invalid of [{ ...decision, candidate_id: 'c2' }, { ...decision, basis_turn_ids: [2] }]) {
    let calls = 0;
    await assert.rejects(selectWithModel(async () => { calls++; return { value: invalid, record: {} }; }, pool, prefix, '回答', {}));
    assert.equal(calls, 2);
  }
  await assert.rejects(selectWithModel(async () => assert.fail('不应调用模型'), { ...pool, contextHash: 'old' }, prefix, '回答', {}), /上下文已改变/);
});
test('模型可以明确开新分支或结束，不能被强行命中第一个候选', async () => {
  for (const action of ['generate', 'finish']) {
    const value = { ...decision, action, candidate_id: null, utterance: action === 'finish' ? '谢谢，今天先到这里。' : null };
    const result = await selectWithModel(async () => ({ value, record: {} }), pool, prefix, '不方便继续', {});
    assert.equal(result.kind, action === 'finish' ? 'finish' : 'fallback'); assert.equal(result.source, 'model');
  }
});
