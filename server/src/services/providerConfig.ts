export function providerConfig() {
  const provider = process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'practice');
  if (!['practice', 'openai', 'compatible'].includes(provider)) throw new Error('Invalid AI_PROVIDER.');
  const key = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.LLM_GATEWAY_TOKEN;
  if (provider === 'openai' && !key) throw new Error('OpenAI provider credentials are missing.');
  if (provider === 'compatible') {
    const url = new URL(process.env.LLM_BASE_URL || '');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      throw new Error('LLM_BASE_URL must be HTTPS (HTTP is allowed only on loopback) without embedded credentials.');
    }
    if (!loopback && !key) throw new Error('Remote compatible providers require LLM_GATEWAY_TOKEN.');
    if (!process.env.INTERVIEWER_MODEL || !process.env.JUDGE_MODEL) throw new Error('Compatible providers require explicit interviewer and judge models.');
  }
  return { provider, key, baseURL: provider === 'compatible' ? process.env.LLM_BASE_URL : provider === 'openai' ? 'https://api.openai.com/v1' : undefined };
}
