import { providerConfig } from './providerConfig.js';
export { providerConfig } from './providerConfig.js';
import { requireAIConsent, ConsentRequiredError } from './providerConsent.js';
import { AIUsage } from '../models/AIUsage.js';
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
  usageContext?: { userId: string; interviewId?: string };
  slot: ModelSlot; system: string; input: unknown; schema: z.ZodType<T>;
  name: string; promptVersion: string; maxOutputTokens: number;
}
export interface ModelProvider {
  structured<T>(request: StructuredRequest<T>): Promise<{ value: T; metadata: GenerationMetadata }>;
}

export function configuredProvider(): ModelProvider | null {
  const config = providerConfig();
  if (config.provider === 'practice') return null;
  const client = new OpenAI({ apiKey: config.key || 'local-development', baseURL: config.baseURL, timeout: 25_000, maxRetries: 0 });
  return {
    async structured<T>(request: StructuredRequest<T>) {
      if (process.env.NODE_ENV === 'production' && !request.usageContext) throw new ConsentRequiredError();
      const model = (request.slot === 'judge' ? process.env.JUDGE_MODEL : process.env.INTERVIEWER_MODEL) || process.env.AI_MODEL || 'gpt-4o-mini';
      const serialized = JSON.stringify(request.input);
      const inputHash = createHash('sha256').update(JSON.stringify({ system: request.system, input: request.input })).digest('hex');
      const started = Date.now();
      const consent = request.usageContext ? await requireAIConsent(request.usageContext.userId) : null;
      // Persist before calling the vendor: a crash leaves an explicit unknown attempt.
      const attempt = request.usageContext ? await AIUsage.create({ ...request.usageContext,
        consentVersion: consent?.version, provider: config.provider, model, slot: request.slot, promptVersion: request.promptVersion }) : null;
      let actualModel = model;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let received = false;
      try {
        if (request.usageContext) await requireAIConsent(request.usageContext.userId);
        let raw: string | null | undefined;
        let complete = false;
        if (config.provider === 'openai') {
          const response = await client.responses.create({ model, store: false,
            input: [{ role: 'system', content: request.system }, { role: 'user', content: serialized }],
            text: { format: zodTextFormat(request.schema, request.name) }, max_output_tokens: request.maxOutputTokens });
          raw = response.output_text;
          complete = response.status === 'completed';
          actualModel = response.model;
          inputTokens = response.usage?.input_tokens ?? null;
          outputTokens = response.usage?.output_tokens ?? null;
        } else {
          const response = await client.chat.completions.create({ model,
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: serialized }],
            response_format: zodResponseFormat(request.schema, request.name), max_tokens: request.maxOutputTokens });
          raw = response.choices[0]?.message.content;
          complete = response.choices[0]?.finish_reason === 'stop' && !response.choices[0]?.message.refusal;
          actualModel = response.model;
          inputTokens = response.usage?.prompt_tokens ?? null;
          outputTokens = response.usage?.completion_tokens ?? null;
        }
        received = true;
        if (!complete || !raw) throw new Error('Incomplete response');
        const value = request.schema.parse(JSON.parse(raw));
        if (attempt) await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'succeeded', model: actualModel,
          inputTokens, outputTokens, latencyMs: Date.now() - started } });
        return { value, metadata: { provider: config.provider, model: actualModel,
          promptVersion: request.promptVersion, inputHash, inputTokens, outputTokens, latencyMs: Date.now() - started } };
      } catch (error) {
        if (error instanceof ConsentRequiredError) {
          if (attempt) await AIUsage.updateOne({_id:attempt._id},{$set:{status:'cancelled',inputTokens:0,outputTokens:0,failure:'consent_revoked',latencyMs:Date.now()-started}});
          throw error;
        }
        if (attempt) await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'failed', model: actualModel,
          inputTokens, outputTokens, latencyMs: Date.now() - started, failure: received ? 'invalid_output' : 'provider_error' } });
        // Provider errors may contain credentials, transcripts or upstream response bodies.
        throw new Error('The AI provider did not return a valid response. Please retry.');
      }
    },
  };
}
