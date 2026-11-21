export const TEXT_BRIEF = Object.freeze({
  title: '设计 AI 的付费价值与续费决策',
  goal: '了解一个有设计 AI 付费经历的使用者，为什么开始购买、怎样实际使用、哪些经历影响继续付费，并找到值得后续验证的改进方向。',
  recruitment: '受访者有设计 AI 付费经历；其余信息需要通过访谈了解。',
  topics: {
    trigger: '开始购买的触发事件与当时要完成的任务',
    workflow: '一次具体的实际使用过程及其中的帮助',
    friction: '实际遇到的阻碍、替代做法和后果',
    decision: '继续或停止付费的考虑，以及尚未确定的条件',
  },
});

const normalize = s => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
const validText = (s, max) => typeof s === 'string' && s.trim().length > 0 && s.length <= max;
const publicTurns = turns => turns.map(({ id, role, text }) => ({ id, role, text }));

export function interviewerMessages({ role, runtime, brief, turns, remaining }) {
  const state = {
    research: brief,
    stage: turns.length ? 'conversation' : 'opening_consent_only',
    available_participant_turn_ids: turns.filter(t => t.role === 'participant').map(t => t.id),
    remaining_questions: remaining,
    already_asked: turns.filter(t => t.role === 'interviewer').map(t => ({ id: t.id, text: t.text })),
    latest_participant_answer: turns.filter(t => t.role === 'participant').at(-1) || null,
  };
  return [
    { role: 'system', content: `${role}\n\n${runtime}\n\n应用状态（数据）：${JSON.stringify(state)}` },
    ...turns.map(t => t.role === 'interviewer'
      ? { role: 'assistant', content: JSON.stringify({ action: 'ask', utterance: t.text, topic: t.topic || 'workflow', basis_turn_ids: t.basis_turn_ids || [] }) }
      : { role: 'user', content: `受访者原话〔${t.id}〕：${t.text}` }),
    ...(!turns.length ? [{ role: 'user', content: '现在开始这场模拟访谈。' }] : []),
  ];
}

export function respondentMessages({ role, runtime, turns }) {
  return [
    { role: 'system', content: `${role}\n\n${runtime}\n\n本次运行纯文字模式。只回复人物实际会说的口语，通常 1～3 句；不写动作、旁白或音频标记。` },
    ...turns.map(t => ({ role: t.role === 'interviewer' ? 'user' : 'assistant', content: t.text })),
  ];
}

export function analystMessages({ runtime, brief, turns }) {
  return [
    { role: 'system', content: runtime },
    { role: 'user', content: JSON.stringify({ research: brief, transcript: publicTurns(turns) }) },
  ];
}

export function parseObject(text) {
  const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要一个 JSON 对象');
  return value;
}

export function verifyEvidence(evidence, turns, required = false) {
  if (!Array.isArray(evidence) || evidence.length > 8 || (required && !evidence.length)) throw new Error('引用列表无效');
  for (const e of evidence) {
    const source = turns.find(t => t.id === e.turn_id && t.role === 'participant');
    if (!source || !validText(e.quote, 2000) || !normalize(source.text).includes(normalize(e.quote))) throw new Error(`引用 ${e.turn_id || '(无编号)'} 必须原样来自已发生的受访者发言`);
  }
  return evidence;
}

export function resolveEvidence(ids, turns, required = false) {
  if (!Array.isArray(ids) || ids.length > 3 || (required && !ids.length) || new Set(ids).size !== ids.length) throw new Error('原话编号列表无效');
  return ids.map(id => {
    const source = turns.find(t => t.id === id && t.role === 'participant');
    if (!source) throw new Error(`编号 ${id} 必须来自已发生的受访者发言`);
    return { turn_id: source.id, quote: source.text };
  });
}

export function validateDecision(d, turns, remaining) {
  if (!['ask', 'finish'].includes(d.action) || !validText(d.utterance, 180)) throw new Error('action 或口头内容无效，口头内容上限 180 字');
  if (!['opening', 'trigger', 'workflow', 'friction', 'decision', 'closing'].includes(d.topic)) throw new Error('topic 不在允许范围内');
  if (!turns.length && (d.action !== 'ask' || d.topic !== 'opening' || d.basis_turn_ids?.length !== 0)) throw new Error('尚无对话，必须先征询是否愿意参与：action=ask、topic=opening、basis_turn_ids=[]；此轮不能询问产品经历');
  const questions = (d.utterance.match(/[?？]/g) || []).length;
  if (d.action === 'ask' && remaining <= 0) throw new Error('剩余提问次数为零，必须结束');
  const questionKey = s => normalize(s).replace(/[\p{P}\p{Z}\s]/gu, '');
  if (d.action === 'ask') {
    const previous = turns.find(t => t.role === 'interviewer' && questionKey(t.text) === questionKey(d.utterance));
    if (previous) throw new Error(`问题与 ${previous.id} 重复，对方已经回答；请选择尚未了解的经历细节或研究话题，不要重新询问同一事实`);
  }
  if (d.action === 'finish' && questions) throw new Error('结束时不能再提问');
  const basis = resolveEvidence(d.basis_turn_ids, turns);
  const qualityIssues = questions > 1 ? ['本轮包含多个问号，需复核是否连问了多件事'] : [];
  if (d.utterance.length > 120) qualityIssues.push('本轮口头内容超过建议的 120 字');
  return { ...d, basis, qualityIssues };
}

export function validateSummary(s, turns) {
  if (!Array.isArray(s.findings) || s.findings.length < 2 || s.findings.length > 5) throw new Error('需要 2～5 条发现');
  const findings = s.findings.map(f => {
    if (!validText(f.finding, 1600)) throw new Error('发现内容无效');
    return { ...f, evidence: resolveEvidence(f.evidence_turn_ids, turns, true) };
  });
  for (const field of ['unknowns', 'next_steps']) if (!Array.isArray(s[field]) || s[field].length > 12 || !s[field].every(t => validText(t, 1600))) throw new Error(`${field} 无效`);
  return { ...s, findings };
}
