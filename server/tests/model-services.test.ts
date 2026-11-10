import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { z } from 'zod';
import { providerConfig } from '../src/services/providerConfig.js';
import { configuredProvider, localModelStatus, localVoiceStatus, resetWarmUp, warmLocalModels } from '../src/services/modelProvider.js';
import { clearIdentityTokens } from '../src/services/googleIdentity.js';

// Staging can run the open models as their own private Cloud Run services that scale to zero. The app signs
// each call with its service account's identity token from the metadata server.
process.env.JWT_SECRET = 'model-services-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const MODEL = 'https://interview-iq-ollama-341474411884.asia-south1.run.app';
const VOICE = 'https://interview-iq-whisper-341474411884.asia-south1.run.app';
const realFetch = globalThis.fetch;
const calls: { url: string; auth: string | null; body?: any }[] = [];
let tokens = 0;

function fakeNetwork() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (url.startsWith('http://metadata.google.internal/')) {
      expect(new Headers(init?.headers).get('Metadata-Flavor')).toBe('Google');
      return new Response(`token-${++tokens}-${new URL(url).searchParams.get('audience')}`);
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, auth: headers.get('authorization'), body });
    if (url.endsWith('/chat/completions')) return Response.json({ id: 'c', object: 'chat.completion', created: 1, model: 'qwen3.5:4b',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ question: 'Why?' }), refusal: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    return Response.json({ ok: true });
  });
}

let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); }, 120_000);
beforeEach(() => {
  calls.length = 0; tokens = 0; clearIdentityTokens(); resetWarmUp();
  vi.stubEnv('AI_PROVIDER', 'local'); vi.stubEnv('LLM_BASE_URL', `${MODEL}/v1`); vi.stubEnv('LOCAL_MODEL_AUTH', 'google');
  vi.stubEnv('TRANSCRIPTION_MODEL', 'small'); vi.stubEnv('TRANSCRIPTION_BASE_URL', `${VOICE}/v1`);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

it('accepts a remote local model only as our own HTTPS Cloud Run service with identity tokens', () => {
  expect(providerConfig()).toMatchObject({ provider: 'local', modelAuth: 'google', baseURL: `${MODEL}/v1`, transcriptionBaseURL: `${VOICE}/v1` });
  vi.stubEnv('LOCAL_MODEL_AUTH', '');
  expect(() => providerConfig()).toThrow(/LOCAL_MODEL_AUTH=google/);
  vi.stubEnv('LOCAL_MODEL_AUTH', 'google');
  vi.stubEnv('LLM_BASE_URL', 'https://models.example.com/v1'); expect(() => providerConfig()).toThrow(/Interview IQ Cloud Run service/);
  vi.stubEnv('LLM_BASE_URL', 'http://interview-iq-ollama-341474411884.asia-south1.run.app/v1'); expect(() => providerConfig()).toThrow(/HTTPS/);
  vi.stubEnv('LLM_BASE_URL', `${MODEL}/v1`); vi.stubEnv('TRANSCRIPTION_BASE_URL', 'https://speech.example.com/v1');
  expect(() => providerConfig()).toThrow(/speech-to-text/);
  // Loopback still works without tokens, as on the laptop.
  vi.stubEnv('LOCAL_MODEL_AUTH', ''); vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:11434/v1'); vi.stubEnv('TRANSCRIPTION_BASE_URL', 'http://127.0.0.1:8000/v1');
  expect(providerConfig()).toMatchObject({ modelAuth: 'none' });
});

it('signs every model call with a cached identity token for that service', async () => {
  fakeNetwork();
  const provider = configuredProvider()!;
  const request1 = { slot: 'interviewer' as const, system: 's', input: {}, schema: z.object({ question: z.string() }), name: 'q', promptVersion: 'v', maxOutputTokens: 10 };
  expect((await provider.structured(request1)).value).toEqual({ question: 'Why?' });
  await provider.structured(request1);
  const model = calls.filter(c => c.url === `${MODEL}/v1/chat/completions`);
  expect(model).toHaveLength(2);
  expect(model.every(c => c.auth === `Bearer token-1-${MODEL}`)).toBe(true);
  expect(tokens).toBe(1);
});

it('never wakes on-demand services for health checks', async () => {
  const spy = fakeNetwork();
  expect(await localModelStatus()).toBe('on-demand');
  expect(await localVoiceStatus()).toBe('on-demand');
  expect((await request(app).get('/api/health').expect(200)).body).toMatchObject({ model: 'on-demand', voice: 'on-demand' });
  expect(spy.mock.calls.some(([input]) => String(input).includes('run.app'))).toBe(false);
});

it('warms the models and speech service at most once every five minutes, sending no candidate content', async () => {
  fakeNetwork();
  vi.stubEnv('JUDGE_MODEL', 'gemma4:e2b');
  const now = Date.now();
  expect(warmLocalModels(now)).toBe(true);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls.filter(c => c.url === `${MODEL}/api/generate`).map(c => c.body)).toEqual([{ model: 'qwen3.5:4b', keep_alive: -1 }, { model: 'gemma4:e2b', keep_alive: -1 }]);
  expect(calls.find(c => c.url === `${VOICE}/health`)!.auth).toBe(`Bearer token-2-${VOICE}`);
  expect(calls.filter(c => c.url.startsWith(MODEL)).every(c => c.auth === `Bearer token-1-${MODEL}`)).toBe(true);
  expect(warmLocalModels(now + 60_000)).toBe(false);
  expect(warmLocalModels(now + 5 * 60_000 + 1)).toBe(true);
  vi.stubEnv('AI_PROVIDER', 'practice');
  resetWarmUp(); expect(warmLocalModels()).toBe(false);
});

it('offers the warm-up to signed-in users only', async () => {
  fakeNetwork();
  await request(app).post('/api/interviews/warmup').expect(401);
  const agent = request.agent(app);
  await agent.post('/api/auth/register').send({ name: 'Warm', email: 'warm@example.test', password: 'test-password' }).expect(201);
  expect((await agent.post('/api/interviews/warmup').expect(202)).body).toEqual({ started: true });
  expect((await agent.post('/api/interviews/warmup').expect(202)).body).toEqual({ started: false });
});
