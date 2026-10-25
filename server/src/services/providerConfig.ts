// "local" is an open-weight model served on this machine (for example by Ollama) through its
// OpenAI-compatible API. Nothing leaves the server, and CPU inference needs longer timeouts.
export const LOCAL_DEFAULT_URL = 'http://127.0.0.1:11434/v1';
export const LOCAL_DEFAULT_MODEL = 'qwen3.5:4b';
const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export function providerConfig() {
  const provider = process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'practice');
  if (!['practice', 'openai', 'compatible', 'local'].includes(provider)) throw new Error('Invalid AI_PROVIDER.');
  const local = provider === 'local';
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : provider === 'compatible' ? process.env.LLM_GATEWAY_TOKEN : undefined;
  if (provider === 'openai' && !key) throw new Error('OpenAI provider credentials are missing.');
  const baseURL = provider === 'compatible' ? process.env.LLM_BASE_URL : local ? process.env.LLM_BASE_URL || LOCAL_DEFAULT_URL
    : provider === 'openai' ? 'https://api.openai.com/v1' : undefined;
  if (provider === 'compatible' || local) {
    const url = new URL(baseURL || '');
    const loopback = loopbackHosts.includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('LLM_BASE_URL must be HTTPS (HTTP is allowed only on loopback) without embedded credentials.');
    }
    if (local && !loopback) throw new Error('A local model must be served on this machine (localhost).');
    if (!loopback && !key) throw new Error('Remote compatible providers require LLM_GATEWAY_TOKEN.');
    if (!local && (!process.env.INTERVIEWER_MODEL || !process.env.JUDGE_MODEL)) throw new Error('Compatible providers require explicit interviewer and judge models.');
  }
  // AI_MODEL is the OpenAI fallback and never names a local model.
  const fallbackModel = local ? LOCAL_DEFAULT_MODEL : process.env.AI_MODEL || 'gpt-4o-mini';
  const interviewerModel = process.env.INTERVIEWER_MODEL || fallbackModel;
  const judgeModel = process.env.JUDGE_MODEL || fallbackModel;
  // Measured on a laptop CPU: about 100 s to score one answer, so a five-answer interview needs up to ~10 minutes.
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || (local ? 1_200_000 : 25_000));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 1_800_000) throw new Error('LLM_TIMEOUT_MS must be between 5000 and 1800000.');
  // Voice answers stay off until a transcription model is chosen explicitly, so no audio cost is a surprise.
  const transcriptionModel = provider === 'practice' ? undefined : process.env.TRANSCRIPTION_MODEL || undefined;
  return { provider, key, transcriptionModel, baseURL, interviewerModel, judgeModel, timeoutMs };
}

// Work leases outlast the slowest allowed model call, so a slow local model is never claimed twice.
export function workLeaseMs() {
  const config = providerConfig();
  return Math.max(120_000, (config.provider === 'practice' ? 0 : config.timeoutMs) + 60_000);
}
