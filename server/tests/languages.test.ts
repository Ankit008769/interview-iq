import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';

process.env.JWT_SECRET = 'languages-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
const calls: { system: string; input: any }[] = [];
const transcriptions: string[] = [];
let asked = 0;
const HINDI_ANSWER = 'मैं hash map का उपयोग करूँगा क्योंकि lookup O(1) है।';

const gateway = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/audio/transcriptions')) { transcriptions.push(Buffer.concat(chunks).toString('latin1')); res.end(JSON.stringify({ text: 'नमस्ते' })); return; }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = JSON.parse(parsed.messages[1].content);
  calls.push({ system: parsed.messages[0].content, input });
  const value = input.turns
    ? { overall: { summary: 'आपने सही approach बताया।', strengths: [{ text: 'सही data structure', quote: 'hash map का उपयोग' }], improvements: ['Complexity और trade-off बताइए।'], nextSteps: ['एक और सवाल का अभ्यास करें।'] },
      answers: input.turns.map((t: any) => ({ questionIndex: t.questionIndex, verdict: 'partly_correct', verdictReason: 'Approach सही है पर trade-off नहीं बताया।',
        keyPoints: ['Hash map lookup O(1)', 'Memory trade-off'], tip: 'एक example जोड़िए।',
        criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 3, quote: t.answer, rationale: 'कुछ evidence है।', improvement: 'और detail दें।' })) })) }
    : { question: `आप duplicate numbers कैसे ढूँढेंगे? (${++asked})`, topic: 'DSA' };
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
const start = (extra: Record<string, unknown>) => owner.post('/api/interviews')
  .send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2, mode: 'ai', ...extra });

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge'); vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Language Tester', email: 'languages@example.test', password: 'test-password' }).expect(201);
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
}, 120_000);
beforeEach(async () => { calls.length = 0; transcriptions.length = 0; await Interview.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('runs a Hindi interview end to end with the language instruction on every prompt', async () => {
  const created = (await start({ language: 'hi' }).expect(201)).body.interview;
  expect(created).toMatchObject({ language: 'hi' });
  expect(created.currentQuestion).toMatch(/duplicate numbers कैसे/);
  for (const questionIndex of [0, 1]) {
    await owner.post(`/api/interviews/${created._id}/answer`).send({ answer: HINDI_ANSWER, questionIndex, submissionId: `hi-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  const done = (await owner.get(`/api/interviews/${created._id}`).expect(200)).body.interview;
  expect(done.status).toBe('completed');
  expect(calls).toHaveLength(3);
  for (const call of calls) expect(call.system).toMatch(/Hindi using Devanagari script/);
  expect(done.feedback.answers[0].review.reason).toMatch(/trade-off/);
  expect(done.feedback.answers[0].criteria[0].evidence.quote).toBe(HINDI_ANSWER);
  expect(done.feedback.strengths).toEqual(['सही data structure — “hash map का उपयोग”']);
  expect(done.feedback.generation.promptVersion).toBe('evidence-judge.v2+hi');
  const versions = (await AIUsage.find({ interviewId: created._id }).lean()).map(a => a.promptVersion).sort();
  expect(versions).toEqual(['evidence-judge.v2+hi', 'interviewer.v3+hi', 'interviewer.v3+hi']);

  // This stand-in model does not implement rewrites (the request fails), but the prompt it received must be in Hindi.
  calls.length = 0;
  await owner.post(`/api/interviews/${created._id}/rewrites`).send({ questionIndex: 0 }).expect(502);
  expect(calls).toHaveLength(1);
  expect(calls[0].input.ratings).toHaveLength(5);
  expect(calls[0].system).toMatch(/Never add facts.*Hindi using Devanagari script/s);
});

it('uses Roman-script Hinglish when chosen and leaves English prompts unchanged', async () => {
  await start({ language: 'hinglish' }).expect(201);
  expect(calls[0].system).toMatch(/Hinglish: conversational Hindi written in Roman script/);
  calls.length = 0;
  const english = (await start({}).expect(201)).body.interview;
  expect(english.language).toBe('en');
  expect(calls[0].system).not.toMatch(/Language:/);
  expect((await AIUsage.findOne({ interviewId: english._id }).lean())!.promptVersion).toBe('interviewer.v3');
});

it('keeps practice interviews in English and rejects unknown languages', async () => {
  expect((await start({ language: 'hi', mode: 'practice' }).expect(400)).body.error).toMatch(/need AI mode/);
  await start({ language: 'fr' }).expect(400);
  await start({ language: 'en', mode: 'practice' }).expect(201);
  expect(calls).toHaveLength(0);
});

it('hints Hindi to the transcriber only for Hindi interviews', async () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);
  const hindi = (await start({ language: 'hi' }).expect(201)).body.interview;
  await owner.post(`/api/interviews/${hindi._id}/transcribe`).set('Content-Type', 'audio/webm').send(webm).expect(200);
  const hinglish = (await start({ language: 'hinglish' }).expect(201)).body.interview;
  await owner.post(`/api/interviews/${hinglish._id}/transcribe`).set('Content-Type', 'audio/webm').send(webm).expect(200);
  expect(transcriptions[0]).toMatch(/name="language"\r\n\r\nhi\r\n/);
  expect(transcriptions[1]).not.toMatch(/name="language"/);
});
