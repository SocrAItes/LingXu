import { TEXT_BRIEF, interviewerMessages, validateDecision } from './text-interview.mjs';
import { PLAN_STYLES, contextHash, generatePool, generateFresh, questionKey } from './question-lab.mjs';
import { selectWithModel } from './model-router.mjs';

export const TREE_TOOL = {
  type: 'function', name: 'get_next_interview_question',
  description: '每次听到完整回答后、说任何话之前调用。由研究控制器根据真实转写选择下一问或结束，必须等结果再逐字说出 utterance。包括开始访谈时也调用；不得自行追加问题。',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
};

export class VoiceTree {
  constructor({ call, role, runtime, maxRounds = 8, brief = TEXT_BRIEF, changed = async () => {}, trace = () => {} }) {
    Object.assign(this, { call, role, runtime, maxRounds, brief, changed, trace });
    this.turns = []; this.steps = []; this.closed = false; this.poolTask = null;
  }
  snapshot() { return { maxRounds: this.maxRounds, brief: this.brief, turns: this.turns, steps: this.steps, closed: this.closed, closing: this.closing }; }
  async generate(remaining, actor) {
    let messages = interviewerMessages({ role: this.role, runtime: `${this.runtime}\n本次约 ${this.maxRounds} 轮（含征询同意），每轮一句短问题。普通纠正不等于退出。`, brief: this.brief, turns: this.turns, remaining });
    for (let i = 0; i < 2; i++) {
      let result;
      try { result = await this.call(actor, messages, { maxTokens: 700 }); return validateDecision(result.value, this.turns, remaining); }
      catch (error) { if (i) throw error; messages = [...messages, ...(result ? [{ role: 'assistant', content: JSON.stringify(result.value) }] : []), { role: 'user', content: `校验失败：${error.message}。原话编号只能选已有受访者编号，最多3个；重新输出有效JSON。` }]; }
    }
  }
  async next(answer) {
    if (this.closed) return { action: 'finish', utterance: this.closing?.text || '谢谢，访谈已经结束。', round: this.steps.length, already_finished: true };
    const started = performance.now();
    let next;
    if (!this.steps.length) next = { ...await this.generate(this.maxRounds, 'interviewer_opening'), source: 'generated_opening' };
    else {
      if (typeof answer !== 'string' || !answer.trim()) throw new Error('没有收到真实语音转写，不能推进访谈树');
      const step = this.steps.at(-1), prefix = this.turns.map(t => ({ ...t }));
      const a = { id: `t${this.turns.length + 1}`, role: 'participant', text: answer.trim() }; this.turns.push(a); step.answer = a;
      const mustEnd = this.steps.length >= this.maxRounds || /结束访谈|不想聊了|停止访谈|到此为止/.test(answer);
      if (mustEnd) {
        this.preparation?.abort.abort();
        next = { ...await this.generate(0, 'interviewer_closing'), source: 'generated_closing' };
      }
      else {
        const waitStarted = performance.now();
        const prepared = this.preparation?.status === 'ready' ? this.preparation.result : null;
        if (this.preparation?.status === 'pending') this.preparation.abort.abort();
        step.pool_wait_ms = performance.now() - waitStarted;
        if (prepared?.pool?.contextHash === contextHash(prefix)) {
          step.pool = prepared.pool;
          step.selection = await selectWithModel(this.call, step.pool, prefix, a.text, this.brief);
          if (step.selection.kind === 'hit') { const c = step.selection.candidate; next = { action: 'ask', utterance: c.question, topic: c.topic, source: 'prepared_candidate', candidateId: c.id }; }
          else if (step.selection.kind === 'generated') next = { action: 'ask', utterance: step.selection.question, topic: step.selection.topic, source: 'router_generated' };
          else if (step.selection.kind === 'finish') next = { action: 'finish', utterance: step.selection.utterance, source: 'model_router' };
        } else step.selection = { source: 'application', kind: 'fallback', code: this.preparation?.status === 'pending' ? 'pool_not_ready' : prepared?.error ? 'pool_failed' : 'stale_or_missing_pool', reason: prepared?.error || '候选未就绪或实际对话改变，直接根据实际回答生成' };
        if (!next) { const fresh = await generateFresh(this.call, { role: this.role, runtime: this.runtime, brief: this.brief, prefix, answer: a.text }); next = { ...fresh, utterance: fresh.question, source: 'on_demand' }; }
      }
      step.next = next;
    }
    if (next.action === 'finish') {
      this.closed = true; this.closing = { id: `t${this.turns.length + 1}`, role: 'interviewer', text: next.utterance, planned_text: next.utterance, spoken: false }; this.turns.push(this.closing);
    } else {
      const q = { id: `t${this.turns.length + 1}`, role: 'interviewer', text: next.utterance, planned_text: next.utterance, topic: next.topic, spoken: false };
      this.turns.push(q); this.steps.push({ index: this.steps.length + 1, question: q, answer: null, selection: null, pool: null, next: null });
      // Runs while MOSS speaks and the other robot answers. Never uses that future answer.
      const prefix = this.turns.map(t => ({ ...t }));
      this.preparation = null;
      if (this.steps.length > 1 && this.steps.length < this.maxRounds) {
        const task = { status: 'pending', abort: new AbortController(), result: null };
        this.preparation = task;
        const call = (actor, messages, options) => { task.abort.signal.throwIfAborted(); return this.call(actor, messages, { ...options, signal: task.abort.signal }); };
        this.poolTask = generatePool(call, { role: this.role, brief: this.brief, prefix, strategy: PLAN_STYLES[0] }).then(pool => ({ pool }), error => ({ error: error.message })).then(result => { task.result = result; task.status = 'ready'; return result; });
      } else this.poolTask = null;
    }
    this.trace('tree.decision.completed', { round: this.steps.length, duration_ms: performance.now() - started, action: next.action, source: next.source });
    await this.changed(this.snapshot());
    return { action: next.action, utterance: next.utterance, round: this.steps.length, instruction: '只自然说出 utterance，不念字段，不解释工具，不增加问题；说完等对方回答。' };
  }
  async spoken(text, round, closing = false) {
    const target = closing ? this.closing : this.steps[round - 1]?.question;
    if (!target || !text?.trim()) return;
    target.spoken_text = target.spoken_text ? `${target.spoken_text}${text}` : text;
    target.text = target.spoken_text; target.spoken = true;
    target.matches_plan = questionKey(target.text) === questionKey(target.planned_text || this.closing?.planned_text || target.text);
    await this.changed(this.snapshot());
  }
}

export function voiceTreeGraph(snapshot) {
  const nodes = [], edges = [];
  for (const step of snapshot.steps) {
    nodes.push({ id: step.question.id, kind: 'question', planned_text: step.question.planned_text, text: step.question.text, spoken: step.question.spoken, answer: step.answer });
    for (const c of step.pool?.candidates || []) {
      const next = snapshot.steps.find(s => s.index === step.index + 1 && s.question.planned_text === c.question);
      const id = next?.question.id || `${step.question.id}:${c.id}`;
      if (!next) nodes.push({ id, kind: 'candidate', text: c.question, spoken: false, eligible: c.eligible });
      edges.push({ from: step.question.id, to: id, candidate_id: c.id, selected: step.selection?.candidate?.id === c.id, walked: Boolean(next?.question.spoken && step.selection?.candidate?.id === c.id), decision: step.selection?.decision || null });
    }
    const next = snapshot.steps.find(s => s.index === step.index + 1);
    if (next && step.next?.source !== 'prepared_candidate') edges.push({ from: step.question.id, to: next.question.id, new_branch: true, walked: next.question.spoken, decision: step.selection?.decision || null });
  }
  if (snapshot.closing) { nodes.push({ id: snapshot.closing.id, kind: 'closing', text: snapshot.closing.text, spoken: snapshot.closing.spoken }); if (snapshot.steps.length) edges.push({ from: snapshot.steps.at(-1).question.id, to: snapshot.closing.id, walked: snapshot.closing.spoken, terminal: true }); }
  return { nodes, edges, note: '候选没有虚构的未来回答；walked 只标记实际发声路径。' };
}
