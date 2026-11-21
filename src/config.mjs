import os from 'node:os';
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export function supportDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'LingXu');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'LingXu');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'LingXu');
}
export const configPath = () => process.env.LINGXU_CONFIG || path.join(supportDirectory(), 'config.env');
const allowed = new Set(['MOSS_API_KEY', 'MOSS_MODEL', 'MOSS_TTS_MODEL', 'INTERVIEWER_VOICE', 'RESPONDENT_VOICE', 'RESPONDENT_REPLY_DELAY_MS', 'TEXT_MODEL_BASE_URL', 'TEXT_MODEL', 'TEXT_MODEL_API_KEY', 'TEXT_MODEL_PROVIDER', 'HUMAN_RECORDINGS_DIR']);
export async function loadConfig({ file = configPath(), env = process.env } = {}) {
  let contents;
  try { contents = await readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (contents !== undefined) for (const [key, value] of Object.entries(parseEnv(contents))) {
    if (allowed.has(key) && env[key] === undefined) env[key] = value;
  }
  env.TEXT_MODEL_BASE_URL ||= 'http://127.0.0.1:11434/v1';
  env.TEXT_MODEL ||= 'qwen3:8b';
  env.HUMAN_RECORDINGS_DIR ||= path.join(supportDirectory(), 'recordings');
  return file;
}
export async function createConfig(root) {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, await readFile(path.join(root, '.env.example')), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return file;
}
