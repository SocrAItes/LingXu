import { contextHash, questionKey, qualityFlags, safetyGate, policyConcern } from './question-lab.mjs';

export const ROUTER_PROTOCOL = 'compact-v3';
const topics = new Set(['trigger', 'workflow', 'friction', 'decision']);

// These checks discard stale assumptions. They never choose a question.
export function candidateInvalidation(answer) {
  const gate = safetyGate(answer);
  if (gate) return gate;
  if (/另一(?:家|个|次|种)|另外(?:一家|一个|一次)/.test(answer)) return { code: 'subject_shift', reason: '本轮明确切换了经历或对象，先停用基于旧经历准备的候选' };
  if (/不值|没.{0,6}省|帮.{0,3}倒忙|仍(?:然)?得自己/.test(answer)) return { code: 'negative_reassessment', reason: '本轮明确否定或重估旧方案的价值，停用旧候选，重新理解后提问' };
  if (/先不(?:说|聊|谈)|换(?:个|一个)(?:话题|方向)|我(?:真正|其实|更|主要)(?:纠结|关心|担心|想了解)的?是|另一个问题/.test(answer)) {
    return { code: 'topic_shift', reason: '回答明确切换话题，旧候选停用，问题由模型重新生成' };
  }
  if (explicitFocusQuote(answer)) return { code: 'correction', reason: '用户明确重述或转折后的重点，停用基于旧理解准备的候选' };
  return null;
}

export function explicitFocusQuote(answer) {
  // Preserve a literal user span, not an application-written interpretation.
  for (const pattern of [/而是(.+)$/s, /我(?:真正|实际|主要|更)(?:关心|担心|纠结|想说|想了解)的?是(.+)$/s, /我(?:刚才)?说[^，。]{0,12}?的是(.+)$/s]) {
    const match=answer.match(pattern);
    if(match?.[1]?.trim())return match[1].trim();
  }
  return null;
}

export function routerMessages(pool, prefix, answer, brief, { requireQuestion = false, disableCandidates = false } = {}) {
  const gate = candidateInvalidation(answer);
  const candidates = gate || disableCandidates ? [] : pool.candidates.filter(c => c.eligible && !prefix.some(t => t.role === 'interviewer' && questionKey(t.text) === questionKey(c.question)));
  const stop = gate?.code === 'end_request';
  return [
    { role: 'system', content: `你是访谈员的下一问控制器。先读最新回答，再判断候选是否真的接得上。只输出一个简短JSON，不写理由、引文编号或分析。
候选只是缓存，不是必须完成的问题清单。只有问题能直接追问最新回答中尚未讲清的具体内容，且没有重复已知事实时，才选候选。不要只因同属“帮助/困难/续费”就选择候选。候选都不适合就当场写新问题，不要先返回“需要生成”再等下一次调用。
历史与最新回答冲突时以最新回答为准。已纠正的前提不能继续使用。对方换话题就接新话题，不拉回旧项目。担忧或设想不等于发生过的经历，不能编造“那次”的事件。
如果回答已描述困难，就追问处理、结果或原因，不再问遇到了什么困难；已说过尝试的方法，就追问效果，不再问尝试过什么。有current_focus_quote时，本轮必须围绕这个用户明确强调的新重点提问。
选候选时先摘出最新回答里最关键的4到18字原话，再选择能继续追问这条原话的问题：{"anchor":"本轮回答中的逐字短原话","pick":"c1"}。pick只能是输入中的有效候选编号。原话不能取自历史回答，候选不能追问已讲清的事实。
新问题：{"pick":"new","text":"一个自然的具体追问？","topic":"workflow"}。一次只问一件事，不超过70字。topic只能是trigger/workflow/friction/decision。不加解释或复述整段回答。
${stop ? '对方明确要求结束，必须返回：{"pick":"finish","text":"简短道别。"}，不再提问。' : requireQuestion ? '本轮研究任务仍需继续，必须选择候选或生成新问题，不能finish。' : '研究已完成或对方明确结束时可返回：{"pick":"finish","text":"简短道别。"}，不再提问。'}` },
    { role: 'user', content: JSON.stringify({ research: { goal: brief.goal, topics: brief.topics }, conversation: (gate ? prefix.slice(-1) : prefix).map(({ role, text }) => ({ role, text })), context_policy: gate ? '旧经历已失效，只围绕本轮回答中的新信息提问。被否定的困难不能再当成事实。' : '完整已发生历史', candidate_status: gate?.code || (disableCandidates ? 'invalid_output_recovery' : 'available'), candidates: candidates.map(({ id, question, topic, use_when }) => ({ id, question, topic, use_when })), latest_answer: answer, current_focus_quote: gate ? explicitFocusQuote(answer) : null, focus_quote_source: 'application_literal_contrast_span' }) },
  ];
}

export async function selectWithModel(call, pool, prefix, answer, brief, options = {}) {
  if (pool.contextHash !== contextHash(prefix)) throw new Error('选路上下文已改变，不能使用旧候选');
  const started = performance.now(), gate = candidateInvalidation(answer), attempts = [];
  const inputTurn = { id: `t${prefix.length + 1}`, role: 'participant', text: answer };
  const common = () => ({ source: 'model', protocol: ROUTER_PROTOCOL, attempts, routeMs: performance.now() - started, evidence: [], input_turn_ids: [inputTurn.id], input_provenance: { source: 'application', turn: inputTurn }, invalidation: gate });
  // Retain generateFresh's checks for unconfigured research-policy answers.
  if (policyConcern(answer)) return { ...common(), source: 'application', kind: 'fallback', code: 'unconfigured_research_policy', reason: '具体研究政策未配置，交给受政策校验保护的生成流程', reason_source: 'application' };
  let messages = routerMessages(pool, prefix, answer, brief, options);
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await call('branch_selector', messages, { maxTokens: 180 });
      attempts.push(result.record);
      const raw = result.value;
      if (Object.keys(raw).some(k => !['anchor', 'pick', 'text', 'topic'].includes(k))) throw new Error('只允许anchor、pick、text、topic字段，不生成引用编号');
      const available = JSON.parse(messages[1].content).candidates;
      // A complete new question with only its redundant pick missing is
      // unambiguous when no cached question is available. Preserve raw output.
      const repaired = !available.length && raw.pick === undefined && typeof raw.text === 'string' && topics.has(raw.topic);
      const d = repaired ? { ...raw, pick: 'new' } : raw;
      const output = () => ({ decision: raw, ...(repaired ? { normalized_decision: d, normalization: { source: 'application', code: 'missing_new_pick' } } : {}) });
      if (available.some(c => c.id === d.pick)) {
        if (d.text || d.topic) throw new Error('选择候选时只返回anchor和pick，不重写问题');
        const normalize = s => s.normalize('NFKC').replace(/\s+/g, '');
        // A longer literal quote is verbose, but not fabricated evidence. Do not
        // discard an otherwise valid choice solely for exceeding the short-quote target.
        if (typeof d.anchor !== 'string' || d.anchor.trim().length < Math.min(4, answer.trim().length) || d.anchor.length > 200 || !normalize(answer).includes(normalize(d.anchor))) throw new Error('anchor必须逐字来自本轮回答，不得引用旧回答或虚构原话');
        return { ...common(), ...output(), kind: 'hit', code: 'model_selected', candidate: pool.candidates.find(c => c.id === d.pick), evidence: [{ turn_id: inputTurn.id, quote: d.anchor }], evidence_source: 'model_quote_validated_against_current_answer', reason: `模型选择${d.pick}`, reason_source: 'application' };
      }
      if (!['new', 'finish'].includes(d.pick)) throw new Error('pick不是可用候选编号、new或finish');
      if (typeof d.text !== 'string' || !d.text.trim() || d.text.length > 180) throw new Error('缺少有效问题或收尾文本');
      const text = d.text.trim();
      if (d.pick === 'finish') {
        if (options.requireQuestion && gate?.code !== 'end_request') throw new Error('本轮要求继续追问，不能收尾');
        if (/[?？]/.test(text)) throw new Error('收尾不能继续提问');
        return { ...common(), ...output(), kind: 'finish', code: 'model_finished', utterance: text, reason: '模型决定结束', reason_source: 'application' };
      }
      if (gate?.code === 'end_request') throw new Error('用户明确结束，不得继续提问');
      if (!topics.has(d.topic) || text.length > 100 || prefix.some(t => t.role === 'interviewer' && questionKey(t.text) === questionKey(text))) throw new Error('新问题话题无效、过长或与已问问题重复');
      return { ...common(), ...output(), kind: 'generated', code: 'model_generated_inline', question: text, topic: d.topic, flags: qualityFlags(text), reason: '模型在同一次调用中生成新问题', reason_source: 'application' };
    } catch (error) {
      if (!result && error.record) attempts.push(error.record);
      if (error.name === 'AbortError' || (!result && !error.record)) throw error;
      if (attempt) return { ...common(), source: 'application', kind: 'fallback', code: 'invalid_model_decision', decision: result?.value, validation_error: error.message, reason: '紧凑决策未通过校验，转入独立现场生成', reason_source: 'application' };
      messages = [...routerMessages(pool, prefix, answer, brief, { ...options, disableCandidates: true }), ...(result ? [{ role: 'assistant', content: JSON.stringify(result.value) }] : []), { role: 'user', content: `上次输出无效：${error.message}。候选已停用，请直接用new生成一个问题，或在允许结束时用finish收尾。只输出规定JSON。` }];
    }
  }
}
