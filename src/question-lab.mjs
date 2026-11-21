import { createHash } from 'node:crypto';
import { interviewerMessages, parseObject, validateDecision } from './text-interview.mjs';

export const SIGNALS = {
  deadline: { label: '赶时间／触发事件', pattern: /赶|提前|截止|来不及|紧急|临时/ },
  benefit: { label: '得到帮助', pattern: /省|快|帮上|顺利|可用|有用|有帮助|效果好/ },
  friction: { label: '遇到阻碍', pattern: /不稳定|不太稳定|跟不上|跟得上|失败|麻烦|不好|不行|变了|跟着变|自己.{0,8}改|改不动|做不了|没接上/ },
  workaround: { label: '替代与处理办法', pattern: /Photoshop|\bPS\b|手动|重新|重做|自己.{0,8}(做|改)|最后|再描述|再生成/i },
  value: { label: '价格与价值', pattern: /价格|费用|多少钱|块钱|元|不值|划算|贵|预算|付不起/ },
  continuation: { label: '继续使用与续费', pattern: /续费|自动续|取消|关掉|停用|偶尔|还会|再试|以后|继续用|重新买/ },
};
export const TOPIC_LABELS = { opening: '开场', trigger: '购买触发', workflow: '使用过程', friction: '遇到阻碍', decision: '后续选择', closing: '收尾' };
export const contextHash = turns => createHash('sha256').update(JSON.stringify(turns.map(({ id, role, text }) => ({ id, role, text })))).digest('hex');
export const questionKey = text => text.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '');
export const policyConcern = answer => /记录.{0,12}(保管|保存)|录音.{0,12}(保管|保存)|撤回.{0,8}授权|隐私政策/.test(answer);
export const PLAN_STYLES = [
  { id: 'experience', name: '经历还原版', description: '沿具体事件还原动作、尝试与结果，优先了解当时发生了什么。' },
  { id: 'decision', name: '决策转折版', description: '围绕关键选择、取舍与改变主意的节点追问，不预设取消或价格原因。' },
  { id: 'value', name: '价值验证版', description: '区分得到的帮助、仍需自己承担的工作与继续使用的条件，不把回忆当测量。' },
];
export function rollingSlots(prefix) {
  const topic = prefix.at(-1)?.topic || 'friction';
  const definitions = {
    trigger: { label: '购买与触发', topic: 'trigger', signals: ['deadline'] },
    workflow: { label: '帮助与实际使用', topic: 'workflow', signals: ['benefit'] },
    friction: { label: '阻碍与处理办法', topic: 'friction', signals: ['friction', 'workaround'] },
    decision: { label: '价值与后续选择', topic: 'decision', signals: ['value', 'continuation'] },
  };
  const topics = topic === 'trigger' ? ['trigger', 'workflow', 'friction'] : topic === 'workflow' ? ['workflow', 'friction', 'decision'] : topic === 'decision' ? ['decision', 'friction', 'workflow'] : ['friction', 'workflow', 'decision'];
  return topics.map((t, i) => ({ ...definitions[t], key: ['main', 'backup_a', 'backup_b'][i], priority: i === 0 ? 'primary' : 'backup' }));
}

export function detectSignals(answer) {
  return Object.entries(SIGNALS).filter(([, s]) => s.pattern.test(answer)).map(([id]) => id);
}
export function safetyGate(answer) {
  if (/结束访谈|结束吧|不想聊了|停止访谈|到此为止/.test(answer)) return { code: 'end_request', reason: '受访者明确要求结束；停止使用候选问题' };
  if (/纠正|说错|理解错|不是这个意思|我没说|并没有|不是[，,。 ]|不是.{0,12}而是|也不是付不起/.test(answer)) return { code: 'correction', reason: '回答纠正了前提；候选暂时作废，重新理解后生成' };
  if (/不方便|不愿意|不想回答|别问|跳过|不想说/.test(answer)) return { code: 'refusal', reason: '受访者拒答；重新选择可聊的话题' };
  if (/记不清|不记得|想不起来|不知道|不确定/.test(answer)) return { code: 'uncertain', reason: '回答包含不确定信息；不沿预设前提继续追问' };
  if (/没用过|没有用过|没尝试|没有尝试|没有帮|没帮|没觉得.{0,6}(有用|有帮助)/.test(answer)) return { code: 'negated_signal', reason: '回答否定了可能命中的信号；保守转现场生成' };
  return null;
}
export function qualityFlags(text) {
  const flags = [];
  if ((text.match(/[?？]/g) || []).length > 1) flags.push('一次连问多个问题');
  if (/是不是因为|所以.{0,15}(主要|就是).{0,12}对吧|是.{1,50}还是/.test(text)) flags.push('可能包含诱导或强制二选一');
  if (text.length > 100) flags.push('问题较长');
  return flags;
}

export function plannerMessages({ role, brief, prefix, strategy, avoidQuestions = [] }) {
  if (strategy) {
    const slots = rollingSlots(prefix);
    return [
      { role: 'system', content: `${role}\n\n你在提前准备一个很小的访谈问题池：一个主问题和两个不同方向的备选。当前问题已问出，受访者还没回答。只用已发生的前文和研究目标，不读未来回答或私有人物档案。\n本版本采用“${strategy.name}”：${strategy.description}\n不要展开整棵树，不要模拟受访者回答。三个问题应体现本版本的访谈思路，互不重复，不重复已经问过的问题；使用具体的开放式问法，不用“有没有”“是否”“是不是”“是A还是B”等封闭或诱导问法。不要假设未知价格、日期、客户反应或技术原因。每个问题只问一件事，不超过 60 字。\n只输出一个 JSON 对象，恰好六个字符串字段：main、backup_a、backup_b 是完整问题，main_when、backup_a_when、backup_b_when 是对应问题的使用条件（不超过25字）。条件写明回答中需要出现什么具体线索，不能只写“有困难”或“有帮助”，不把假设条件当作已发生的回答。` },
      { role: 'user', content: JSON.stringify({ research: brief, known_conversation: prefix.map(({ id, role, text }) => ({ id, role, text })), response_directions: slots.map(({ key, label, signals }) => ({ key, label, signals })), other_version_questions_to_avoid: avoidQuestions }) },
    ];
  }
  return [
    { role: 'system', content: `${role}\n\n你在准备下一轮访谈的候选问题。当前问题已经问出，但受访者尚未回答。只能根据研究目标和当前已有对话，预测可能的回答方向，提前生成 4 个候选追问。你没有将来的回答，也没有人物私有档案。\n每条只问一件事，最多一个问号，不超过 70 字。用开放式、具体、口语化的问法；避免“是A还是B”“是不是因为”等诱导。不替受访者填入尚未出现的价格、产品或经历。不重复已经问过的问题。\n只输出一个 JSON 对象，恰好包含下面四个字段，值都是你自主生成的问题字符串：\ndeadline：假如下一条回答提到赶时间、临时任务，适合继续问什么；\nbenefit：假如下一条回答提到省时或有帮助，适合继续问什么；\nfriction：假如下一条回答提到修改困难或自己处理，适合继续问什么；\ncontinuation：假如下一条回答提到费用、续费或后续使用，适合继续问什么。\n四个字段的值都只写一句问题，不写说明。无需给问题标标签、编号或评分；程序会处理这些元数据。不要输出分析过程。` },
    { role: 'user', content: JSON.stringify({ research: brief, conversation_before_answer: prefix.map(({ id, role, text }) => ({ id, role, text })) }) },
  ];
}

export function validatePool(value, prefix) {
  if (!value.candidates && ['deadline', 'benefit', 'friction', 'continuation'].every(k => typeof value[k] === 'string')) {
    value = { candidates: [
      { question: value.deadline, topic: 'trigger', signals: ['deadline'] },
      { question: value.benefit, topic: 'workflow', signals: ['benefit'] },
      { question: value.friction, topic: 'friction', signals: ['friction', 'workaround'] },
      { question: value.continuation, topic: 'decision', signals: ['value', 'continuation'] },
    ] };
  }
  if (!Array.isArray(value.candidates) || value.candidates.length < 3 || value.candidates.length > 5) throw new Error('候选数量需要 3～5 个');
  const seen = new Set(), asked = new Set(prefix.filter(t => t.role === 'interviewer').map(t => questionKey(t.text)));
  const candidates = value.candidates.map((c, i) => {
    if (typeof c.question !== 'string' || !c.question.trim() || c.question.length > 120 || !['trigger', 'workflow', 'friction', 'decision'].includes(c.topic)) throw new Error('候选问题格式无效');
    if (!Array.isArray(c.signals) || c.signals.length < 1 || c.signals.length > 2 || !c.signals.every(s => s in SIGNALS)) throw new Error('候选信号标签无效');
    const key = questionKey(c.question);
    const flags = qualityFlags(c.question);
    if (asked.has(key) || seen.has(key)) flags.push('与已有问题重复');
    seen.add(key);
    return { id: `c${i + 1}`, question: c.question.trim(), topic: c.topic, signals: [...new Set(c.signals)], flags, eligible: !flags.length };
  });
  if (!candidates.some(c => c.eligible)) throw new Error('没有可用候选问题');
  return { candidates, contextHash: contextHash(prefix) };
}

// This route is deliberately a small, inspectable heuristic. It is not an LLM
// relevance judge; a keyword match is a candidate hit, not proof of interview quality.
export function routeCandidate(pool, prefix, answer) {
  const started = performance.now();
  const finish = result => ({ ...result, routeMs: performance.now() - started });
  if (pool.contextHash !== contextHash(prefix)) return finish({ kind: 'fallback', code: 'stale_context', reason: '准备候选时的对话已被修订，旧候选失效', signals: [] });
  const gate = safetyGate(answer);
  if (gate) return finish({ kind: 'fallback', ...gate, signals: [] });
  const signals = detectSignals(answer);
  if (!signals.length) return finish({ kind: 'fallback', code: 'unrecognized', reason: '轻量路由无法识别这条回答的方向，转现场生成', signals });
  const priorities = { friction: 3, workaround: 2.5, continuation: 2, value: 2, deadline: 1.5, benefit: 1 };
  const ranked = pool.candidates.filter(c => c.eligible).map(c => {
    const matched = c.signals.filter(s => signals.includes(s));
    return { candidate: c, matched, score: matched.reduce((n, s) => n + priorities[s], 0) };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  if (!ranked.length) return finish({ kind: 'fallback', code: 'no_match', reason: '回答方向没有对应的有效候选，转现场生成', signals });
  const picked = ranked[0];
  return finish({ kind: 'hit', candidate: picked.candidate, signals, matched: picked.matched, reason: `回答命中“${picked.matched.map(s => SIGNALS[s].label).join('、')}”，选择已生成的 ${picked.candidate.id}` });
}

export function makeQwenClient({ base, model, apiKey, provider = process.env.TEXT_MODEL_PROVIDER || (new URL(base).port === '11434' ? 'ollama' : 'openai'), audit = async () => {} }) {
  return async function call(actor, messages, { maxTokens = 1300, signal, asText = false } = {}) {
    const ollama = provider === 'ollama';
    const payload = ollama
      ? { model, messages, stream: false, think: false, options: { temperature: 0.65, top_p: 0.85, num_predict: maxTokens } }
      : { model, messages, temperature: 0.65, top_p: 0.85, max_tokens: maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false } };
    const started = performance.now(), at = new Date().toISOString();
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const endpoint = ollama ? new URL('/api/chat', base).href : `${base.replace(/\/$/, '')}/chat/completions`;
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`本地文字模型返回 HTTP ${response.status}`);
    const headersAt = performance.now(), bodyText = await response.text(), bodyAt = performance.now();
    const data = JSON.parse(bodyText), choice = ollama ? { message: data.message, finish_reason: data.done ? data.done_reason || 'stop' : null } : data.choices?.[0];
    const record = { actor, at, durationMs: Math.round(performance.now() - started), model: data.model, usage: data.usage, finishReason: choice?.finish_reason,
      timing: { headersMs: headersAt - started, bodyCompleteMs: bodyAt - started, jsonParseMs: performance.now() - bodyAt, firstTokenMs: null, firstTokenUnavailableReason: '本调用 stream=false，没有逐 token 到达事件' } };
    await audit({ ...record, endpoint, payload, response: { content: choice?.message?.content, model: data.model, usage: data.usage, finish_reason: choice?.finish_reason, raw: data } });
    if (choice?.finish_reason !== 'stop' || !choice?.message?.content?.trim()) throw new Error(`模型未完整生成（${choice?.finish_reason || '无终态'}）`);
    try { return { value: asText ? choice.message.content.trim() : parseObject(choice.message.content), record }; }
    catch (e) { e.modelOutput = choice.message.content; e.record = record; throw e; }
  };
}

export async function generatePool(call, inputs) {
  let messages = plannerMessages(inputs);
  const attempts = [], start = performance.now();
  for (let i = 0; i < 2; i++) {
    let result;
    try {
      result = await call('candidate_planner', messages, { maxTokens: inputs.strategy ? 900 : 1600 }); attempts.push(result.record);
      const slots = inputs.strategy ? rollingSlots(inputs.prefix) : null;
      const value = slots ? { candidates: slots.map(s => ({ question: result.value[s.key], topic: s.topic, signals: s.signals })) } : result.value;
      const pool = validatePool(value, inputs.prefix);
      if (inputs.strategy && inputs.avoidQuestions?.length) {
        const used = new Set(inputs.avoidQuestions.map(questionKey));
        pool.candidates = pool.candidates.map(c => ({ ...c, sharedWithOtherVersion: used.has(questionKey(c.question)) }));
      }
      if (slots) pool.candidates = pool.candidates.map((c, i) => ({ ...c, use_when: typeof result.value[slots[i].key + '_when'] === 'string' ? result.value[slots[i].key + '_when'].slice(0, 80) : undefined, label: `${i === 0 ? '主线' : `备选 ${i}`} · ${slots[i].label}`, priority: slots[i].priority }));
      return { ...pool, policy: slots ? 'one_primary_two_backups' : 'legacy_four_directions', prepareMs: Math.round(performance.now() - start), attempts, createdAt: new Date().toISOString() };
    } catch (e) {
      if (e.record) attempts.push(e.record);
      if (i) throw e;
      const previous = result ? JSON.stringify(result.value) : e.modelOutput;
      messages = [...messages, ...(previous ? [{ role: 'assistant', content: previous }] : []), { role: 'user', content: `应用校验未通过：${e.message}。请修正输出，仍然只用当前已知对话，不要猜测未来事实。` }];
    }
  }
}

export async function generateFresh(call, { role, runtime, brief, prefix, answer }) {
  const turns = [...prefix, { id: `t${prefix.length + 1}`, role: 'participant', text: answer }];
  let messages = interviewerMessages({ role, runtime, brief, turns, remaining: Math.max(1, 12 - Math.ceil(prefix.length / 2)) });
  if (policyConcern(answer)) messages[0].content += '\n\n本次运行尚未配置正式研究协议、记录保管负责人、保留期限或授权撤回流程。受访者现在询问这些信息。必须先说明具体政策尚需确认，暂停本次访谈并交由操作者说明：action=finish。不编造保管责任，不承诺随时撤回或任何未配置的处理能力，不继续业务提问。';
  const attempts = [], start = performance.now();
  for (let i = 0; i < 2; i++) {
    const result = await call('on_demand_interviewer', messages, { maxTokens: 1000 }); attempts.push(result.record);
    try {
      const d = validateDecision(result.value, turns, 12);
      if (policyConcern(answer) && (d.action !== 'finish' || !/需要确认|需确认|尚未|还未|暂未|还没|不清楚|无法确认|确认后|先.{0,8}确认/.test(d.utterance) || /随时可以|由研究团队保管|我们保证|一定可以/.test(d.utterance))) throw new Error('访谈政策尚未配置，必须明确需要确认并暂停，不能作保管或撤回承诺');
      return { question: d.utterance, action: d.action, topic: d.topic, flags: [...d.qualityIssues, ...qualityFlags(d.utterance)], basis: d.basis, generationMs: Math.round(performance.now() - start), attempts };
    } catch (e) { if (i) throw e; messages = [...messages, { role: 'assistant', content: JSON.stringify(result.value) }, { role: 'user', content: `应用校验未通过：${e.message}。重新生成，不能虚构原话。` }]; }
  }
}

export function pathPlanMessages({ role, brief, prefix, candidates }) {
  return [
    { role: 'system', content: `${role}\n\n你在设计尚未发生的访谈分支。输入只有已发生的前文和一个已经规划的问题，没有未来真实回答，也没有人物私有档案。请为这个问题再规划两个可能的后续追问。\n每条后续包含一个简短的“如果回答提到什么”的条件，以及对应的一个开放式追问。条件是假设，不是发生过的事实。不要填入未知的价格、日期、产品、客户反应或技术原因。问题不能重复上一个问题，不用“是不是因为”“是A还是B”等诱导，一次只问一件事。\n只输出一个 JSON 对象，恰好四个字段，值都为字符串：condition_a、question_a、condition_b、question_b。condition 是进入下一问的假设条件，不超过 35 字；question 是一个问题，不超过 70 字。两种条件应有区别。只规划问题，不模拟受访者回答，不输出分析过程或占位文字。` },
    { role: 'user', content: JSON.stringify({ research: brief, known_conversation: prefix.map(({ id, role, text }) => ({ id, role, text })), candidate_questions: candidates.map(({ id, question, signals }) => ({ id, question, possible_answer_signals: signals })) }) },
  ];
}

export function validatePathPlan(value, candidates) {
  const ids = new Set(candidates.map(c => c.id));
  if (!Array.isArray(value.branches) || value.branches.length !== ids.size) throw new Error('需要为每个候选问题提供分支');
  const seen = new Set();
  const branches = value.branches.map(b => {
    if (!ids.has(b.candidate_id) || seen.has(b.candidate_id) || !Array.isArray(b.next) || b.next.length !== 2) throw new Error('分支编号或下一问数量无效');
    seen.add(b.candidate_id);
    const next = b.next.map((n, i) => {
      if (typeof n.condition !== 'string' || !n.condition.trim() || n.condition.length > 80 || typeof n.question !== 'string' || !n.question.trim() || n.question.length > 120) throw new Error('后续问题或条件无效');
      return { id: `${b.candidate_id}-${i + 1}`, condition: n.condition.trim(), question: n.question.trim(), flags: qualityFlags(n.question), status: 'hypothetical_not_executed' };
    });
    return { candidate_id: b.candidate_id, next };
  });
  return { branches, scope: '条件式预测问题，未发生、未参与本轮规则选择，也不代表真实受访者回答' };
}

export async function generatePathPlan(call, inputs) {
  const attempts = [], branches = [], start = performance.now();
  for (const candidate of inputs.candidates) {
    let messages = pathPlanMessages({ ...inputs, candidates: [candidate] });
    for (let i = 0; i < 2; i++) {
      let result;
      try {
        result = await call('hypothetical_path_planner', messages, { maxTokens: 850 }); attempts.push(result.record);
        const v = result.value;
        const plan = validatePathPlan({ branches: [{ candidate_id: candidate.id, next: [{ condition: v.condition_a, question: v.question_a }, { condition: v.condition_b, question: v.question_b }] }] }, [candidate]);
        branches.push(...plan.branches); break;
      } catch (e) {
        if (e.record) attempts.push(e.record);
        if (i) throw e;
        const previous = result ? JSON.stringify(result.value) : e.modelOutput;
        messages = [...messages, ...(previous ? [{ role: 'assistant', content: previous }] : []), { role: 'user', content: `上次格式未完整通过。请只输出包含 condition_a、question_a、condition_b、question_b 的 JSON 对象，四个值都是完整字符串。仍然只规划问题，不编造真实回答。` }];
      }
    }
  }
  return { branches, scope: '条件式预测问题，未发生、未参与本轮规则选择，也不代表真实受访者回答', generationMs: Math.round(performance.now() - start), createdAt: new Date().toISOString(), attempts };
}
