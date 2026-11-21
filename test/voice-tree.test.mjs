import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTree, voiceTreeGraph } from '../src/voice-tree.mjs';

function setup(maxRounds = 8) {
  let generated = 0; const calls = [];
  const call = async (actor, messages) => {
    calls.push({ actor, messages });
    if (actor === 'candidate_planner') { const i=++generated;return { value:{main:`第${i}种操作具体怎么做？`,backup_a:`第${i}个困难怎么处理？`,backup_b:`第${i}次后续如何选择？`},record:{} }; }
    if (actor === 'branch_selector') return { value:{anchor:JSON.parse(messages[1].content).latest_answer.slice(0,12),pick:'c1'},record:{} };
    if (actor === 'interviewer_closing') return { value:{action:'finish',utterance:'谢谢，今天先到这里。',topic:'closing',basis_turn_ids:[]},record:{} };
    return { value:{action:'ask',utterance:actor==='interviewer_opening'?'愿意聊聊这段经历吗？':`第${++generated}次具体发生了什么？`,topic:actor==='interviewer_opening'?'opening':'workflow',basis_turn_ids:[]},record:{} };
  };
  return { brain:new VoiceTree({call,role:'访谈员',runtime:'只依据对话',maxRounds}),calls };
}

test('语音树连续8轮必须使用真实转写，每轮只推进一次并由模型收尾', async () => {
  const {brain,calls}=setup();
  let next=await brain.next();assert.equal(next.round,1);assert.equal(next.action,'ask');
  for(let round=1;round<=8;round++) {
    await brain.spoken(next.utterance,round);
    next=await brain.next(round===1?'可以，愿意聊。':`这是第${round}轮实际转写，我后来自己修改。`);
    assert.equal(brain.steps.filter(s=>s.answer).length,round);
    if(round<8){assert.equal(next.action,'ask');assert.equal(next.round,round+1);}else assert.equal(next.action,'finish');
  }
  await brain.spoken(next.utterance,8,true);
  assert.equal(brain.turns.length,17);assert.equal(brain.closed,true);
  assert.equal(calls.filter(c=>c.actor==='branch_selector').length,6);
  const graph=voiceTreeGraph(brain.snapshot());assert.equal(graph.nodes.filter(n=>n.kind==='question'&&n.spoken).length,8);
  assert.equal(graph.edges.filter(e=>e.walked).length,8);
  assert.equal(graph.nodes.filter(n=>n.kind==='candidate').every(n=>!n.spoken&&!n.answer),true);
});
test('没有语音转写时不得推进，实际语音改写后旧候选不能强行使用', async () => {
  const {brain,calls}=setup(4);
  await brain.next();await assert.rejects(brain.next(''),/真实语音转写/);assert.equal(brain.steps.length,1);
  const second=await brain.next('可以聊');await brain.spoken('与预定措辞不同的实际问题？',second.round);
  await brain.next('这是真实语音回答');
  assert.equal(calls.filter(c=>c.actor==='branch_selector').length,0);
  assert.equal(brain.steps[1].selection.code,'stale_or_missing_pool');assert.equal(brain.steps[1].question.matches_plan,false);
});

test('模型同次生成的新问题直接进入树，不再调用第二次现场生成', async () => {
  const {brain,calls}=setup(4),original=brain.call;
  brain.call=async(actor,messages,options)=>actor==='branch_selector'?{value:{pick:'new',text:'共享时最需要保留哪些信息？',topic:'workflow'},record:{}}:original(actor,messages,options);
  await brain.next();await brain.next('愿意聊');await brain.poolTask;
  const before=calls.filter(c=>c.actor==='on_demand_interviewer').length;
  const next=await brain.next('我们想了解团队共享');
  assert.equal(next.utterance,'共享时最需要保留哪些信息？');
  assert.equal(calls.filter(c=>c.actor==='on_demand_interviewer').length,before);
  assert.equal(brain.steps[1].next.source,'router_generated');
  await brain.poolTask;
});

test('候选未准备好时取消后台请求并继续，不等待问题池完成', {timeout:1000}, async () => {
  const {brain,calls}=setup(3),original=brain.call;let aborted=false;
  brain.call=(actor,messages,options)=>actor==='candidate_planner'?new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>{aborted=true;reject(options.signal.reason);},{once:true});
  }):original(actor,messages,options);
  await brain.next();await brain.next('愿意聊');const previous=brain.poolTask;
  const next=await brain.next('我已经回答完了');await previous;
  assert.equal(aborted,true);assert.equal(next.action,'ask');
  assert.equal(brain.steps[1].selection.code,'pool_not_ready');
  assert.equal(calls.filter(c=>c.actor==='branch_selector').length,0);
});
