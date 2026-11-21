import test from 'node:test';
import assert from 'node:assert/strict';
import { selectWithModel, routerMessages, explicitFocusQuote } from '../src/model-router.mjs';
import { contextHash } from '../src/question-lab.mjs';

const prefix = [{ id: 't1', role: 'interviewer', text: '后来怎样？' }];
const pool = { contextHash: contextHash(prefix), candidates: [{ id: 'c1', question: '替代方案怎么操作？', eligible: true, flags: [], topic: 'friction', use_when: '回答提到改用其他工具但未说明操作' }, { id: 'c2', question: '重复问题？', eligible: false, flags: ['repeat'] }] };
const fresh = { pick: 'new', text: '团队共享这件事，您最希望解决什么？', topic: 'workflow' };

test('由模型选择候选，原始返回和应用输入关联分别保留，不编造模型引文', async () => {
  const result = await selectWithModel(async (_, messages, options) => {
    const input = JSON.parse(messages[1].content);
    assert.equal(input.latest_answer, '改用其他工具了');
    assert.equal(input.candidates.length, 1);
    assert.equal(input.candidates[0].use_when, pool.candidates[0].use_when);
    assert.equal(options.maxTokens, 180);
    return { value: { anchor: '其他工具', pick: 'c1' }, record: {} };
  }, pool, prefix, '改用其他工具了', {});
  assert.equal(result.source, 'model');
  assert.equal(result.candidate.question, pool.candidates[0].question);
  assert.deepEqual(result.decision, { anchor: '其他工具', pick: 'c1' });
  assert.deepEqual(result.evidence, [{turn_id:'t2',quote:'其他工具'}]);
  assert.deepEqual(result.input_turn_ids, ['t2']);
  assert.equal(result.input_provenance.source, 'application');
});

test('纠正与显式换话题停用旧候选，模型不能重新强选旧分支', async () => {
  for (const answer of ['不是，我刚才说得不准确，问题其实是品牌切换。', '先不说改稿了，我真正纠结的是团队能不能共享。', '后来另一家小店的项目出了问题。', '改稿还是没省下来，就有点不值。']) {
    let calls = 0;
    const result = await selectWithModel(async (_, messages) => {
      assert.deepEqual(JSON.parse(messages[1].content).candidates, []);
      assert.equal(JSON.parse(messages[1].content).conversation.length,1);
      return { value: ++calls === 1 ? { pick: 'c1' } : fresh, record: {} };
    }, pool, prefix, answer, {});
    assert.equal(calls, 2);
    assert.equal(result.kind, 'generated');
    assert.ok(result.invalidation);
  }
});

test('选择候选必须引用本轮短原话，不能用虚构或历史文本通过校验', async () => {
  let calls=0;
  const result=await selectWithModel(async()=>({value:++calls===1?{anchor:'历史里才出现的原话',pick:'c1'}:fresh,record:{}}),pool,prefix,'我们希望共享团队素材',{});
  assert.equal(calls,2);assert.equal(result.kind,'generated');assert.deepEqual(result.evidence,[]);
});

test('不能选用无效候选或夹带引用编号，恢复时直接生成且不再选旧候选', async () => {
  for (const invalid of [{ pick: 'c2' }, { pick: 'c1', basis_turn_ids: [2] }]) {
    let calls = 0;
    const result = await selectWithModel(async (_, messages) => {
      if (calls) assert.equal(JSON.parse(messages[1].content).candidates.length, 0);
      return { value: ++calls === 1 ? invalid : fresh, record: {} };
    }, pool, prefix, '回答', {});
    assert.equal(result.kind, 'generated');
    assert.equal(calls, 2);
  }
  await assert.rejects(selectWithModel(async () => assert.fail('不应调用模型'), { ...pool, contextHash: 'old' }, prefix, '回答', {}), /上下文已改变/);
});

test('候选不合适时同一次调用生成新问题，不需要第二次生成请求', async () => {
  let calls = 0;
  const result = await selectWithModel(async actor => {
    assert.equal(actor, 'branch_selector'); calls++;
    return { value: fresh, record: {} };
  }, pool, prefix, '我们在讨论团队协作', {}, { requireQuestion: true });
  assert.equal(calls, 1); assert.equal(result.kind, 'generated'); assert.equal(result.question, fresh.text);
});

test('用户明确结束优先于继续追问约束，未知政策仍走原有受保护流程', async () => {
  const result = await selectWithModel(async () => ({ value: { pick: 'finish', text: '谢谢，今天先到这里。' }, record: {} }), pool, prefix, '结束访谈', {}, { requireQuestion: true });
  assert.equal(result.kind, 'finish');
  const policy = await selectWithModel(async () => assert.fail('不应选旧候选'), pool, prefix, '访谈记录由谁保管，能否撤回授权？', {});
  assert.equal(policy.kind, 'fallback'); assert.equal(policy.code, 'unconfigured_research_policy');
  assert.equal(policy.source, 'application');
});

test('仅要求继续追问时不能用收尾绕过任务；提示词保留真实最新回答', async () => {
  let calls = 0;
  const result = await selectWithModel(async () => ({ value: ++calls === 1 ? { pick: 'finish', text: '谢谢。' } : fresh, record: {} }), pool, prefix, '回答', {}, { requireQuestion: true });
  assert.equal(result.kind, 'generated'); assert.equal(calls, 2);
  const input = JSON.parse(routerMessages(pool, prefix, 'RECOGNIZED_ANSWER_42', {})[1].content);
  assert.equal(input.latest_answer, 'RECOGNIZED_ANSWER_42');
});

test('重置时提取用户明确转折后的原话，不生成新的意图摘要', () => {
  const answer='不是局部改稿的问题，我说麻烦的是给不同客户切换品牌风格。';
  const quote=explicitFocusQuote(answer);
  assert.equal(quote,'给不同客户切换品牌风格。');assert.ok(answer.includes(quote));
  const input=JSON.parse(routerMessages(pool,prefix,answer,{})[1].content);
  assert.equal(input.latest_answer,answer);assert.equal(input.current_focus_quote,quote);
  assert.equal(input.focus_quote_source,'application_literal_contrast_span');
  assert.deepEqual(input.candidates,[]);
});

test('恢复输出只缺new标记时保留原始返回，显式记录程序补齐', async () => {
  const responses=[{pick:'new'}, {text:fresh.text,topic:'workflow'}];let calls=0;
  const result=await selectWithModel(async()=>({value:responses[calls++],record:{}}),pool,prefix,'先不说旧话题了，我们关注团队共享',{}, {requireQuestion:true});
  assert.equal(calls,2);assert.equal(result.kind,'generated');assert.equal(result.question,fresh.text);
  assert.deepEqual(result.decision,responses[1]);assert.equal(result.normalized_decision.pick,'new');
  assert.equal(result.normalization.source,'application');
});

test('连续无效结构转入受记录的现场生成，不强选候选或中断访谈', async () => {
  let calls=0;const result=await selectWithModel(async()=>({value:{pick:'missing'},record:{n:++calls}}),pool,prefix,'回答',{});
  assert.equal(calls,2);assert.equal(result.kind,'fallback');assert.equal(result.code,'invalid_model_decision');
  assert.equal(result.source,'application');assert.match(result.validation_error,/pick/);
});
