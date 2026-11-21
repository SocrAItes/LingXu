import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, supportDirectory } from '../src/config.mjs';
test('私有配置不能覆盖显式环境变量，也不能注入无关系统变量', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'lingxu-config-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'private.env');
  await writeFile(file, ['MOSS_API_KEY' + '=' + 'fixture-placeholder', 'TEXT_MODEL=qwen3:8b', 'PATH=unwanted'].join('\n'));
  const env = { MOSS_API_KEY: 'existing-placeholder' };
  await loadConfig({ file, env });
  assert.equal(env.MOSS_API_KEY, 'existing-placeholder');
  assert.equal(env.TEXT_MODEL, 'qwen3:8b');
  assert.equal(env.PATH, undefined);
});
test('平台私有目录保存在用户数据目录', () => {
  assert.equal(supportDirectory('win32', { LOCALAPPDATA: 'local-data' }, 'home'), path.join('local-data', 'LingXu'));
  assert.equal(supportDirectory('darwin', {}, 'home'), path.join('home', 'Library', 'Application Support', 'LingXu'));
});
