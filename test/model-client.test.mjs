import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeQwenClient } from '../src/question-lab.mjs';
for (const provider of ['ollama', 'openai']) test(`${provider} 保留实际请求返回，禁用思考并拒绝截断 JSON`, async t => {
  let response, input, url;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    input = JSON.parse(body); url = req.url;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  let audit;
  const call = makeQwenClient({ base: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', provider, audit: async r => { audit = r; } });
  const content = '{"action":"ask"}';
  response = provider === 'ollama' ? { done: true, done_reason: 'stop', message: { content } } : { choices: [{ finish_reason: 'stop', message: { content } }] };
  assert.deepEqual((await call('fixture', [{ role: 'user', content: 'fixture' }])).value, { action: 'ask' });
  assert.equal(url, provider === 'ollama' ? '/api/chat' : '/v1/chat/completions');
  assert.equal(provider === 'ollama' ? input.think : input.chat_template_kwargs.enable_thinking, false);
  assert.deepEqual(audit.response.raw, response);
  response = provider === 'ollama' ? { done: true, done_reason: 'length', message: { content } } : { choices: [{ finish_reason: 'length', message: { content } }] };
  await assert.rejects(call('fixture', []), /未完整生成/);
});
