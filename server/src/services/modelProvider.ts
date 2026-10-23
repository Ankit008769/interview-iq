import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import { createHash } from 'node:crypto';

export type ModelSlot = 'interviewer' | 'judge';
export interface GenerationMetadata {
  provider: string; model: string; promptVersion: string; inputHash: string;
  inputTokens: number | null; outputTokens: number | null; latencyMs: number;
}
export interface StructuredRequest<T> {
  slot: ModelSlot; system: string; input: unknown; schema: z.ZodType<T>;
  name: string; promptVersion: string; maxOutputTokens: number;
}
export interface ModelProvider {
  structured<T>(request: StructuredRequest<T>): Promise<{ value: T; metadata: GenerationMetadata }>;
}

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
  return { provider, key, baseURL: provider === 'compatible' ? process.env.LLM_BASE_URL : undefined };
}

export function configuredProvider(): ModelProvider | null {
  const config = providerConfig();
  if (config.provider === 'practice') return null;
  const client = new OpenAI({ apiKey: config.key || 'local-development', baseURL: config.baseURL, timeout: 25_000, maxRetries: 0 });
  return {
    async structured<T>(request: StructuredRequest<T>) {
      const model = (request.slot === 'judge' ? process.env.JUDGE_MODEL : process.env.INTERVIEWER_MODEL) || process.env.AI_MODEL || 'gpt-4o-mini';
      const serialized = JSON.stringify(request.input);
      const inputHash = createHash('sha256').update(JSON.stringify({ system: request.system, input: request.input })).digest('hex');
      const started = Date.now();
      try {
        let value: unknown;
        let actualModel: string;
        let inputTokens: number | null;
        let outputTokens: number | null;
        if (config.provider === 'openai') {
          const response = await client.responses.parse({ model, store: false,
            input: [{ role: 'system', content: request.system }, { role: 'user', content: serialized }],
            text: { format: zodTextFormat(request.schema, request.name) }, max_output_tokens: request.maxOutputTokens });
          value = response.output_parsed;
          actualModel = response.model;
          inputTokens = response.usage?.input_tokens ?? null;
          outputTokens = response.usage?.output_tokens ?? null;
        } else {
          const response = await client.chat.completions.parse({ model,
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: serialized }],
            response_format: zodResponseFormat(request.schema, request.name), max_tokens: request.maxOutputTokens });
          value = response.choices[0]?.message.parsed;
          actualModel = response.model;
          inputTokens = response.usage?.prompt_tokens ?? null;
          outputTokens = response.usage?.completion_tokens ?? null;
        }
        return { value: request.schema.parse(value), metadata: { provider: config.provider, model: actualModel,
          promptVersion: request.promptVersion, inputHash, inputTokens, outputTokens, latencyMs: Date.now() - started } };
      } catch {
        // Provider errors may contain credentials, transcripts or upstream response bodies.
        throw new Error('The AI provider did not return a valid response. Please retry.');
      }
    },
  };
}
