import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ensureLocalModel } from '../src/local-model.mjs';
test('兼容 MLX 空模型列表响应，Ollama 仍须检查已下载模型', async t => {
  let body = '';
  const server = createServer((req, res) => res.end(body));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const keys = ['TEXT_MODEL_PROVIDER', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    server.closeAllConnections(); return new Promise(resolve => server.close(resolve));
  });
  process.env.TEXT_MODEL_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.TEXT_MODEL = 'fixture-model';
  process.env.TEXT_MODEL_PROVIDER = 'openai';
  await ensureLocalModel();
  process.env.TEXT_MODEL_PROVIDER = 'ollama';
  await assert.rejects(ensureLocalModel(), /无效 JSON/);
  body = JSON.stringify({ data: [] });
  await assert.rejects(ensureLocalModel(), /找不到/);
  body = JSON.stringify({ data: [{ id: 'fixture-model' }] });
  await ensureLocalModel();
});
