export async function ensureLocalModel() {
  const base = process.env.TEXT_MODEL_BASE_URL || 'http://127.0.0.1:11434/v1';
  const headers = {};
  if (process.env.TEXT_MODEL_API_KEY) headers.Authorization = `Bearer ${process.env.TEXT_MODEL_API_KEY}`;
  let response;
  try { response = await fetch(`${base.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('文字模型未连接。请先启动 Ollama 并运行 ollama pull qwen3:8b，或配置 TEXT_MODEL_BASE_URL。'); }
  if (!response.ok) throw new Error(`文字模型检查失败 HTTP ${response.status}`);
  const body = await response.text();
  const ollama = process.env.TEXT_MODEL_PROVIDER === 'ollama' || (!process.env.TEXT_MODEL_PROVIDER && new URL(base).port === '11434');
  // Some MLX servers answer GET /models with an empty HTTP 200 response.
  // Their configured model is checked by the actual completion request.
  if (!body.trim() && !ollama) return;
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('文字模型的 /models 返回无效 JSON，请检查服务地址和协议配置。'); }
  const model = process.env.TEXT_MODEL || 'qwen3:8b';
  if (Array.isArray(data.data) && !data.data.some(item => item.id === model)) throw new Error('文字模型列表中找不到 TEXT_MODEL。请先下载对应模型，或修改本机私有配置中的模型名称。');
  if (ollama && !Array.isArray(data.data)) throw new Error('Ollama 未返回模型列表，请检查服务地址。');
}
