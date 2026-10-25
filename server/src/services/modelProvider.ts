import { estimateCost, readRateCard, type CostEstimate } from './usageCost.js';
import { providerConfig } from './providerConfig.js';
export { providerConfig } from './providerConfig.js';
import { requireAIConsent, ConsentRequiredError } from './providerConsent.js';
import { AIUsage } from '../models/AIUsage.js';
import OpenAI, { toFile } from 'openai';
import { z } from 'zod';
import { zodTextFormat, zodResponseFormat } from 'openai/helpers/zod';
import { createHash } from 'node:crypto';

export type ModelSlot = 'interviewer' | 'judge';
export interface GenerationMetadata {
  cost?: CostEstimate;
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
  const client = new OpenAI({ apiKey: config.key || 'local-development', baseURL: config.baseURL, timeout: config.timeoutMs, maxRetries: 0 });
  return {
    async structured<T>(request: StructuredRequest<T>) {
      if (process.env.NODE_ENV === 'production' && !request.usageContext) throw new ConsentRequiredError();
      const model = request.slot === 'judge' ? config.judgeModel : config.interviewerModel;
      const serialized = JSON.stringify(request.input);
      const inputHash = createHash('sha256').update(JSON.stringify({ system: request.system, input: request.input })).digest('hex');
      const started = Date.now();
      const rates = readRateCard();
      const consent = request.usageContext ? await requireAIConsent(request.usageContext.userId) : null;
      // Persist before calling the vendor: a crash leaves an explicit unknown attempt.
      const attempt = request.usageContext ? await AIUsage.create({ ...request.usageContext,
        consentVersion: consent?.version, provider: config.provider, model, slot: request.slot, promptVersion: request.promptVersion }) : null;
      let actualModel = model;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      let cachedInputTokens = 0;
      const cost = (cancelled = false) => estimateCost(rates, { provider: config.provider, endpoint: config.baseURL, model: actualModel,
        slot: request.slot, inputTokens, outputTokens, cachedInputTokens, cancelled, at: new Date(started) });
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
          cachedInputTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
          inputTokens = response.usage?.input_tokens ?? null;
          outputTokens = response.usage?.output_tokens ?? null;
        } else {
          const response = await client.chat.completions.create({ model,
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: serialized }],
            response_format: zodResponseFormat(request.schema, request.name), max_tokens: request.maxOutputTokens,
            // Local reasoning models answer directly: thinking would multiply CPU time without changing the schema output.
            // A deterministic local judge gives the same scorecard for the same answer.
            ...(config.provider === 'local' ? { reasoning_effort: 'none' as never, ...(request.slot === 'judge' ? { temperature: 0 } : {}) } : {}) });
          raw = response.choices[0]?.message.content;
          complete = response.choices[0]?.finish_reason === 'stop' && !response.choices[0]?.message.refusal;
          actualModel = response.model;
          cachedInputTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
          inputTokens = response.usage?.prompt_tokens ?? null;
          outputTokens = response.usage?.completion_tokens ?? null;
        }
        received = true;
        if (!complete || !raw) throw new Error('Incomplete response');
        const value = request.schema.parse(JSON.parse(raw));
        if (attempt) await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'succeeded', model: actualModel,
          inputTokens, outputTokens, cachedInputTokens, cost: cost(), latencyMs: Date.now() - started } });
        return { value, metadata: { cost: cost(), provider: config.provider, model: actualModel,
          promptVersion: request.promptVersion, inputHash, inputTokens, outputTokens, latencyMs: Date.now() - started } };
      } catch (error) {
        if (error instanceof ConsentRequiredError) {
          if (attempt) await AIUsage.updateOne({_id:attempt._id},{$set:{status:'cancelled',cost:cost(true),inputTokens:0,outputTokens:0,failure:'consent_revoked',latencyMs:Date.now()-started}});
          throw error;
        }
        if (attempt) await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'failed', model: actualModel,
          inputTokens, outputTokens, cachedInputTokens, cost: cost(), latencyMs: Date.now() - started, failure: received ? 'invalid_output' : 'provider_error' } });
        // Provider errors may contain credentials, transcripts or upstream response bodies.
        throw new Error('The AI provider did not return a valid response. Please retry.');
      }
    },
  };
}

// For the health endpoint: whether the local model server answers and has both configured models installed.
export async function localModelStatus(): Promise<'ready' | 'unavailable' | undefined> {
  const config = providerConfig();
  if (config.provider !== 'local') return undefined;
  try {
    const response = await fetch(new URL('/api/tags', config.baseURL).toString(), { signal: AbortSignal.timeout(1500) });
    const { models } = await response.json() as { models?: { name: string }[] };
    const installed = new Set((models ?? []).map(m => m.name));
    return installed.has(config.interviewerModel) && installed.has(config.judgeModel) ? 'ready' : 'unavailable';
  } catch { return 'unavailable'; }
}

const audioExtensions: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

// Speech to text through the configured provider's OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI, or a self-hosted Whisper server). The audio is passed through and never stored.
// language (ISO 639-1) is a hint for single-language interviews; mixed Hinglish is left to auto-detection.
export async function transcribeAudio(audio: Buffer, mimeType: string, usageContext: { userId: string; interviewId?: string }, language?: string) {
  const config = providerConfig();
  if (!config.transcriptionModel) throw new Error('Transcription is not configured.');
  const consent = await requireAIConsent(usageContext.userId);
  const client = new OpenAI({ apiKey: config.key || 'local-development', baseURL: config.baseURL, timeout: 60_000, maxRetries: 0 });
  const started = Date.now();
  // Persist before calling the vendor, as for text generation.
  const attempt = await AIUsage.create({ ...usageContext, consentVersion: consent.version, provider: config.provider,
    model: config.transcriptionModel, slot: 'transcriber', promptVersion: 'transcription.v1', cost: {amountUsd:null,reason:'unsupported_audio_pricing'} });
  try {
    const file = await toFile(audio, `answer.${audioExtensions[mimeType] ?? 'webm'}`, { type: mimeType });
    await requireAIConsent(usageContext.userId);
    const result = await client.audio.transcriptions.create({ model: config.transcriptionModel, file, ...(language ? { language } : {}) });
    const usage = (result as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'succeeded', latencyMs: Date.now() - started,
      inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null } });
    return { text: (result.text ?? '').trim(), model: config.transcriptionModel };
  } catch (error) {
    if (error instanceof ConsentRequiredError) {
      await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'cancelled', cost: {amountUsd:0,reason:'cancelled_before_dispatch'}, inputTokens: 0, outputTokens: 0, failure: 'consent_revoked', latencyMs: Date.now() - started } });
      throw error;
    }
    await AIUsage.updateOne({ _id: attempt._id }, { $set: { status: 'failed', failure: 'provider_error', latencyMs: Date.now() - started } });
    // Provider errors may echo audio-derived text or credentials.
    throw new Error('The transcription provider did not return a valid response. Please retry.');
  }
}
