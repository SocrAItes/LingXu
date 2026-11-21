export async function ensureLocalModel() {
  const base = process.env.TEXT_MODEL_BASE_URL || 'http://127.0.0.1:11434/v1';
  const headers = {};
  if (process.env.TEXT_MODEL_API_KEY) headers.Authorization = `Bearer ${process.env.TEXT_MODEL_API_KEY}`;
  let response;
  try { response = await fetch(`${base.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('文字模型未连接。请先启动 Ollama 并运行 ollama pull qwen3:8b，或配置 TEXT_MODEL_BASE_URL。'); }
  if (!response.ok) throw new Error(`文字模型检查失败 HTTP ${response.status}`);
  const data = await response.json();
  const model = process.env.TEXT_MODEL || 'qwen3:8b';
  if (!data.data?.some(item => item.id === model)) throw new Error('文字模型列表中找不到 TEXT_MODEL。请先下载对应模型，或修改本机私有配置中的模型名称。');
}
