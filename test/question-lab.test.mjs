import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePool, routeCandidate, plannerMessages, generatePool, generateFresh } from '../src/question-lab.mjs';
const prefix = [
  { id: 't1', role: 'interviewer', text: '最近一次使用是什么时候？' },
  { id: 't2', role: 'participant', text: '前几天，用一个工具做海报。' },
  { id: 't3', role: 'interviewer', text: '那次具体怎么做的？' },
];
const raw = { candidates: [
  { question: '当时为什么需要赶时间？', topic: 'trigger', signals: ['deadline'] },
  { question: '哪一步对你有帮助？', topic: 'workflow', signals: ['benefit'] },
  { question: '你最后怎么处理这次修改？', topic: 'friction', signals: ['friction', 'workaround'] },
  { question: '你接下来会怎么使用这个工具？', topic: 'decision', signals: ['continuation'] },
] };
test('准备请求不读取将来回答或人物私有档案', () => {
  const input = { role: '访谈员', brief: { goal: '研究工具体验' }, prefix, answer: 'FUTURE_ANSWER_PRIVATE_79', respondentRole: 'PRIVATE_PERSONA_林舟' };
  const messages = JSON.stringify(plannerMessages(input));
  assert.doesNotMatch(messages, /FUTURE_ANSWER_PRIVATE_79|PRIVATE_PERSONA_林舟/);
  assert.match(messages, /前几天/);
});
test('优先承接明确的阻碍和替代做法，返回实际的候选原文', () => {
  const result = routeCandidate(validatePool(raw, prefix), prefix, '初稿快了一些，但客户后来改图不稳定，最后还是自己改。');
  assert.equal(result.kind, 'hit'); assert.equal(result.candidate.id, 'c3');
  assert.equal(result.candidate.question, raw.candidates[2].question);
  assert.ok(result.routeMs >= 0);
});
test('纠正、拒答、不确定和否定不能因为提到关键词而被强行命中', () => {
  const pool = validatePool(raw, prefix);
  for (const answer of ['我纠正一下，赶时间是上一个项目。', '这个不方便回答，跳过吧。', '具体改了几次我记不清。', '我没用过 PS，也没有尝试其他工具。']) assert.equal(routeCandidate(pool, prefix, answer).kind, 'fallback');
});
test('对话被修订时旧候选失效', () => {
  const pool = validatePool(raw, prefix), revised = structuredClone(prefix); revised[1].text = '刚才说错了，我没有做海报。';
  assert.equal(routeCandidate(pool, revised, '当时很赶时间').code, 'stale_context');
});
test('新话题无法识别时回退，不会兜底选第一条', () => {
  const result = routeCandidate(validatePool(raw, prefix), prefix, '我想先了解访谈记录的保管政策。');
  assert.equal(result.kind, 'fallback'); assert.equal(result.code, 'unrecognized');
});
test('重复或诱导候选保留可见，但不参与选择', () => {
  const data = structuredClone(raw); data.candidates[0].question = prefix[2].text; data.candidates[1].question = '是预算紧张还是工具没用？';
  const pool = validatePool(data, prefix);
  assert.equal(pool.candidates[0].eligible, false); assert.equal(pool.candidates[1].eligible, false);
  assert.equal(routeCandidate(pool, prefix, '当时很赶时间').kind, 'fallback');
});
test('候选来自真实模型返回值，准备和现场生成单独记录', async () => {
  const inputs = { role: '访谈员', runtime: '规则', brief: { goal: '研究工具' }, prefix, answer: '后来自己修改' };
  const poolCalls = [];
  const pool = await generatePool(async (actor, messages) => { poolCalls.push({ actor, messages }); return { value: raw, record: { durationMs: 4 } }; }, inputs);
  assert.equal(poolCalls[0].actor, 'candidate_planner');
  assert.doesNotMatch(JSON.stringify(poolCalls[0].messages), /后来自己修改/);
  const fresh = await generateFresh(async (actor, messages) => {
    assert.equal(actor, 'on_demand_interviewer'); assert.match(JSON.stringify(messages), /后来自己修改/);
    return { value: { action: 'ask', utterance: '自己修改时最费事的是什么？', topic: 'friction', basis_turn_ids: ['t4'] }, record: { durationMs: 6 } };
  }, inputs);
  assert.equal(pool.candidates.length, 4); assert.equal(fresh.question, '自己修改时最费事的是什么？');
  assert.ok(pool.prepareMs >= 0 && fresh.generationMs >= 0);
});
test('简化的四方向输出只补充元数据，不改写模型生成的问题', () => {
  const input = { deadline: '那次赶时间时，原本打算怎么做？', benefit: '哪一部分帮上了忙？', friction: '后来是怎么处理的？', continuation: '下一次使用时你最想改变什么？' };
  const pool = validatePool(input, prefix);
  assert.equal(pool.candidates[0].question, input.deadline);
  assert.deepEqual(pool.candidates[2].signals, ['friction', 'workaround']);
});
test('没有配置访谈政策时，拒绝编造保管责任或授权承诺', async () => {
  let attempts = 0;
  const result = await generateFresh(async () => {
    attempts++;
    return { value: { action: 'finish', utterance: attempts === 1 ? '记录由研究团队保管，您随时可以撤回授权。' : '这些具体政策还需要确认，我们先暂停访谈。', topic: 'closing', basis_turn_ids: [] }, record: { durationMs: 1 } };
  }, { role: '访谈员', runtime: '规则', brief: { goal: '研究工具' }, prefix, answer: '我想知道访谈记录由谁保管，以及是否可以撤回授权。' });
  assert.equal(attempts, 2); assert.equal(result.action, 'finish'); assert.match(result.question, /需要确认/);
});
