import { contextHash, questionKey } from './question-lab.mjs';
import { resolveEvidence } from './text-interview.mjs';

export function routerMessages(pool, prefix, answer, brief) {
  const latest = { id: `t${prefix.length + 1}`, role: 'participant', text: answer };
  return [
    { role: 'system', content: '你是研究访谈的下一问决策器。根据研究目标、已发生的对话、最新回答和候选问题，自主选择下一步。候选只是备选，不是必须走的固定流程。最新回答已经讲清楚的事不要再问；有新线索时沿新线索追问；前提被纠正、拒答或候选接不上时选择 generate；明确要求结束时选择 finish。不要靠关键词出现就选择候选。只输出 JSON，不输出分析过程。字段：action=select/generate/finish；candidate_id=选中的候选编号或 null；utterance=仅 finish 时的简短收尾或 null；basis_turn_ids=实际承接的受访者编号数组，必须包含最新回答编号；reason=不超过100字的选择依据摘要。select 只能选择 eligible=true 的问题。generate 表示下一次调用根据实际回答生成新分支，不能把未来回答当成事实。' },
    { role: 'user', content: JSON.stringify({ research: brief, conversation: prefix.map(({ id, role, text }) => ({ id, role, text })), latest_answer: latest, evidence_constraint: { allowed_ids: [...prefix.filter(t => t.role === 'participant').map(t => t.id), latest.id], required_id: latest.id, maximum_count: 3, example: [latest.id], note: '编号是 t 开头的字符串，只引用受访者；不要填数字或访谈员编号' }, candidates: pool.candidates.map(({ id, question, eligible, flags }) => ({ id, question, eligible, flags })) }) },
  ];
}

export async function selectWithModel(call, pool, prefix, answer, brief) {
  if (pool.contextHash !== contextHash(prefix)) throw new Error('选路上下文已改变，不能使用旧候选');
  const turns = [...prefix, { id: `t${prefix.length + 1}`, role: 'participant', text: answer }];
  let messages = routerMessages(pool, prefix, answer, brief);
  const attempts = [], started = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await call('branch_selector', messages, { maxTokens: 450 }); attempts.push(result.record);
      const d = result.value;
      if (!['select', 'generate', 'finish'].includes(d.action) || typeof d.reason !== 'string' || !d.reason.trim() || d.reason.length > 150) throw new Error('选路 action 或 reason 无效');
      const evidence = resolveEvidence(d.basis_turn_ids, turns, true);
      if (!d.basis_turn_ids.includes(turns.at(-1).id)) throw new Error('选路必须承接本轮实际回答');
      const common = { source: 'model', decision: d, evidence, attempts, routeMs: performance.now() - started, reason: d.reason };
      if (d.action === 'select') {
        const c = pool.candidates.find(c => c.id === d.candidate_id && c.eligible);
        if (!c || prefix.some(t => t.role === 'interviewer' && questionKey(t.text) === questionKey(c.question))) throw new Error('候选不存在、不可用或已问过');
        return { ...common, kind: 'hit', code: 'model_selected', candidate: c };
      }
      if (d.candidate_id !== null) throw new Error('generate/finish 的 candidate_id 必须为 null');
      if (d.action === 'finish') {
        if (typeof d.utterance !== 'string' || !d.utterance.trim() || d.utterance.length > 180 || /[?？]/.test(d.utterance)) throw new Error('收尾必须简短且不能继续提问');
        return { ...common, kind: 'finish', code: 'model_finished', utterance: d.utterance };
      }
      return { ...common, kind: 'fallback', code: 'model_new_branch' };
    } catch (error) {
      if (attempt) throw error;
      messages = [...messages, ...(result ? [{ role: 'assistant', content: JSON.stringify(result.value) }] : []), { role: 'user', content: `输出校验未通过：${error.message}。basis_turn_ids 必须是最多3个受访者编号字符串，只能从 ${JSON.stringify(turns.filter(t => t.role === 'participant').map(t => t.id))} 中选择，且必须包含 ${JSON.stringify(turns.at(-1).id)}。重新输出有效 JSON。` }];
    }
  }
}
