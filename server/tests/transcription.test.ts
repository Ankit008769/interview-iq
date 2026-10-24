import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';

process.env.JWT_SECRET = 'transcription-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const owner = request.agent(app);
let mode: 'ok' | 'empty' | 'fail' = 'ok';
const uploads: { contentType: string; body: string }[] = [];

const gateway = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/audio/transcriptions')) {
    uploads.push({ contentType: String(req.headers['content-type']), body: body.toString('latin1') });
    if (mode === 'fail') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'upstream failure echoing recorded words' } })); return; }
    res.end(JSON.stringify({ text: mode === 'empty' ? '   ' : '  An array gives constant-time indexed access.  ' }));
    return;
  }
  const parsed = JSON.parse(body.toString('utf8'));
  const input = JSON.parse(parsed.messages[1].content);
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', refusal: null,
      content: JSON.stringify({ question: `Explain arrays, question ${input.questionNumber}.`, topic: 'DSA' }) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
});

let mongo: MongoMemoryServer;
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);
const ogg = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(4096, 7)]);
async function consent() {
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
  return disclosure;
}
async function aiInterview(sessionMode: 'ai' | 'practice' = 'ai') {
  return (await owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate',
    topic: 'DSA', totalQuestions: 2, mode: sessionMode }).expect(201)).body.interview._id as string;
}
const upload = (id: string, audio: Buffer, type = 'audio/webm;codecs=opus') =>
  owner.post(`/api/interviews/${id}/transcribe`).set('Content-Type', type).send(audio);

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge'); vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Voice Tester', email: 'voice@example.test', password: 'test-password' }).expect(201);
  await consent();
}, 120_000);
beforeEach(async () => { mode = 'ok'; uploads.length = 0; vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber'); await Interview.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('discloses voice processing and asks for fresh consent when transcription is turned on', async () => {
  const withVoice = (await owner.get('/api/account/ai-consent').expect(200)).body.disclosure;
  expect(withVoice).toMatchObject({ transcriptionModel: 'iq-transcriber' });
  expect(withVoice.voice).toMatch(/does not store the recording/);
  vi.stubEnv('TRANSCRIPTION_MODEL', '');
  const without = (await owner.get('/api/account/ai-consent').expect(200)).body;
  expect(without.disclosure.voice).toBeUndefined();
  expect(without.disclosure.version).not.toBe(withVoice.version);
  expect(without.accepted).toBe(false);
  expect((await owner.get('/api/interviews/mode').expect(200)).body).toEqual({ mode: 'ai', transcription: false });
  vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber');
  expect((await owner.get('/api/interviews/mode').expect(200)).body).toEqual({ mode: 'ai', transcription: true });
});

it('transcribes a recording through the provider, records usage and stores no audio', async () => {
  const id = await aiInterview();
  const result = await upload(id, webm).expect(200);
  expect(result.body).toEqual({ transcript: 'An array gives constant-time indexed access.' });
  expect(uploads[0].contentType).toMatch(/^multipart\/form-data/);
  expect(uploads[0].body).toContain('iq-transcriber');
  expect(uploads[0].body).toContain('filename="answer.webm"');
  const usage = await AIUsage.findOne({ interviewId: id, slot: 'transcriber' }).lean();
  expect(usage).toMatchObject({ status: 'succeeded', model: 'iq-transcriber', promptVersion: 'transcription.v1' });
  expect(usage?.consentVersion).toBeTruthy();
  const saved = (await Interview.findById(id).lean())!;
  expect(saved.turns).toEqual([]);
  expect(JSON.stringify(saved)).not.toContain('constant-time');
  expect((await upload(id, ogg, 'audio/ogg').expect(200)).body.transcript).toBeTruthy();
});

it('rejects unsupported, mislabelled, tiny and oversized recordings before any provider call', async () => {
  const id = await aiInterview();
  await upload(id, webm, 'text/plain').expect(415);
  await upload(id, ogg, 'audio/webm').expect(415);
  await upload(id, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), 'audio/webm').expect(400);
  const tooLarge = await upload(id, Buffer.concat([webm, Buffer.alloc(9 * 1024 * 1024)]), 'audio/webm').expect(413);
  expect(tooLarge.body.error).toMatch(/too large/);
  expect(uploads).toHaveLength(0);
});

it('only transcribes for the owner of an AI interview with a question on screen and current consent', async () => {
  const practice = await aiInterview('practice');
  await upload(practice, webm).expect(409);
  const id = await aiInterview();
  await Interview.updateOne({ _id: id }, { $set: { pausedAt: new Date() } });
  await upload(id, webm).expect(409);
  await Interview.updateOne({ _id: id }, { $unset: { pausedAt: 1 } });
  await Interview.updateOne({ _id: id }, { $set: { processingState: 'queued' } });
  await upload(id, webm).expect(409);
  await Interview.updateOne({ _id: id }, { $set: { processingState: 'ready', status: 'completed' } });
  await upload(id, webm).expect(409);
  await Interview.updateOne({ _id: id }, { $set: { status: 'in_progress' } });
  const stranger = request.agent(app);
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger-voice@example.test', password: 'test-password' }).expect(201);
  await stranger.post(`/api/interviews/${id}/transcribe`).set('Content-Type', 'audio/webm').send(webm).expect(404);
  vi.stubEnv('TRANSCRIPTION_MODEL', '');
  expect((await upload(id, webm).expect(409)).body.error).toMatch(/not enabled/);
  vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber');
  await owner.delete('/api/account/ai-consent').expect(200);
  expect((await upload(id, webm).expect(409)).body.code).toBe('AI_CONSENT_REQUIRED');
  await consent();
  expect(uploads).toHaveLength(0);
});

it('reports provider failures and silence without leaking provider text', async () => {
  const id = await aiInterview();
  mode = 'fail';
  const failed = await upload(id, webm).expect(502);
  expect(JSON.stringify(failed.body)).not.toMatch(/upstream|recorded words/);
  expect(await AIUsage.countDocuments({ interviewId: id, slot: 'transcriber', status: 'failed' })).toBe(1);
  mode = 'empty';
  expect((await upload(id, webm).expect(422)).body.error).toMatch(/No speech/);
});

it('rechecks consent after metering and cancels without sending audio if permission was withdrawn', async () => {
  const id = await aiInterview();
  const create = AIUsage.create.bind(AIUsage);
  const spy = vi.spyOn(AIUsage, 'create').mockImplementationOnce((async (...args: any[]) => {
    const receipt = await (create as any)(...args);
    await owner.delete('/api/account/ai-consent').expect(200);
    return receipt;
  }) as any);
  try {
    await upload(id, webm).expect(409);
    expect(uploads).toHaveLength(0);
    expect(await AIUsage.findOne({interviewId:id,slot:'transcriber'}).lean()).toMatchObject({status:'cancelled',inputTokens:0,outputTokens:0,failure:'consent_revoked'});
  } finally {spy.mockRestore();await consent();}
});
