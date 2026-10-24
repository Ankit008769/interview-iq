import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';
import { verifyRewrite } from '../src/services/evidence.js';

process.env.JWT_SECRET = 'rewrite-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
let mode: 'good' | 'mixed' | 'ungrounded' | 'fail' = 'good';
const rewrites: any[] = [];
const answers = ['I picked an array because indexed reads are constant time. Inserts in the middle were rare.',
  'A linked list made sense for the undo stack because we only pushed and popped at the head.'];

const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  const input = JSON.parse(parsed.messages[1].content);
  let value: unknown;
  if (input.ratings !== undefined) {
    rewrites.push({ model: parsed.model, system: parsed.messages[0].content, input });
    if (mode === 'fail') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'upstream failure echoing the candidate answer' } })); return; }
    const grounded = { kind: 'answer', text: 'I chose an array for constant-time indexed reads.', quote: 'indexed reads are constant time' };
    const prompt = { kind: 'addition', text: '[Add how often the data changed, if you know]', quote: null };
    value = mode === 'good' ? { parts: [grounded, { kind: 'answer', text: 'Middle inserts were rare, so their cost mattered less.',
      quote: 'Inserts in the middle were rare.' }, prompt], summary: 'Leads with the decision and its reason.' }
      : mode === 'mixed' ? { parts: [grounded, { kind: 'answer', text: 'This cut latency by 40%.', quote: 'cut latency by 40%' },
        { kind: 'addition', text: 'Latency dropped by 40% in production.', quote: null }, prompt], summary: 'Mixed.' }
        : { parts: [{ kind: 'answer', text: 'I led a team of ten.', quote: 'I led a team of ten' }], summary: 'Invented.' };
  } else if (input.turns) {
    value = { answers: input.turns.map((turn: any) => ({ questionIndex: turn.questionIndex,
      criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 3, quote: turn.answer, rationale: 'Some evidence.', improvement: 'Be specific.' })) })) };
  } else value = { question: `Explain your data structure choice, question ${input.questionNumber}.`, topic: 'DSA' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model + '-resolved',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
async function consent() {
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
}
async function completedInterview(sessionMode?: 'practice') {
  const started = await owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate',
    topic: 'DSA', totalQuestions: 2, mode: sessionMode }).expect(201);
  const id = started.body.interview._id as string;
  for (let questionIndex = 0; questionIndex < 2; questionIndex++) {
    await owner.post(`/api/interviews/${id}/answer`).send({ answer: answers[questionIndex], questionIndex, submissionId: `${id}-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  return (await owner.get(`/api/interviews/${id}`).expect(200)).body.interview;
}
const rewrite = (id: string, questionIndex: number) => owner.post(`/api/interviews/${id}/rewrites`).send({ questionIndex });

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Rewrite Tester', email: 'rewrite@example.test', password: 'test-password' }).expect(201);
  await consent();
}, 120_000);
beforeEach(async () => { mode = 'good'; rewrites.length = 0; await Interview.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('keeps only quoted sentences and bracketed prompts', () => {
  const answer = 'Arrays allow indexed access.';
  const result = verifyRewrite({ summary: 's', parts: [
    { kind: 'answer', text: 'Arrays give direct access.', quote: 'Arrays allow indexed access.' },
    { kind: 'answer', text: 'Blank quote.', quote: '  ' },
    { kind: 'addition', text: '[Add the time complexity]', quote: null },
    { kind: 'addition', text: 'It runs in O(1).', quote: null },
    { kind: 'addition', text: '[Nested [brackets] are not a single prompt]', quote: null },
  ] }, answer);
  expect(result.parts).toEqual([{ kind: 'answer', text: 'Arrays give direct access.', quote: answer, start: 0, end: answer.length },
    { kind: 'addition', text: '[Add the time complexity]' }]);
  expect(result.dropped).toBe(3);
  expect(() => verifyRewrite({ summary: '', parts: [{ kind: 'addition', text: '[Only a prompt]', quote: null }] }, answer)).toThrow();
});

it('builds a grounded rewrite once per answer and records its provenance', async () => {
  const done = await completedInterview();
  const created = await rewrite(done._id, 0).expect(201);
  const saved = created.body.interview.rewrites[0];
  expect(saved).toMatchObject({ questionIndex: 0, dropped: 0, summary: 'Leads with the decision and its reason.',
    generation: { promptVersion: 'answer-rewrite.v1', model: 'iq-judge-resolved' } });
  const quote = 'indexed reads are constant time';
  expect(saved.parts[0]).toEqual({ kind: 'answer', text: 'I chose an array for constant-time indexed reads.', quote,
    start: answers[0].indexOf(quote), end: answers[0].indexOf(quote) + quote.length });
  expect(saved.parts[2]).toEqual({ kind: 'addition', text: '[Add how often the data changed, if you know]' });
  expect(rewrites[0]).toMatchObject({ model: 'iq-judge', input: { answer: answers[0], question: done.turns[0].question } });
  expect(rewrites[0].input.ratings).toHaveLength(5);
  expect(rewrites[0].system).toMatch(/Never add facts/);
  expect(await AIUsage.countDocuments({ interviewId: done._id, promptVersion: 'answer-rewrite.v1', status: 'succeeded' })).toBe(1);

  const replay = await rewrite(done._id, 0).expect(200);
  expect(replay.body.replayed).toBe(true);
  expect(replay.body.interview.rewrites).toHaveLength(1);
  expect(rewrites).toHaveLength(1);
});

it('drops invented sentences and prompts that state facts', async () => {
  mode = 'mixed';
  const done = await completedInterview();
  const saved = (await rewrite(done._id, 0).expect(201)).body.interview.rewrites[0];
  expect(saved.parts.map((p: any) => p.kind)).toEqual(['answer', 'addition']);
  expect(saved.dropped).toBe(2);
  expect(JSON.stringify(saved)).not.toContain('40%');
});

it('stores nothing when no sentence is grounded or the provider fails, and can be retried', async () => {
  const done = await completedInterview();
  mode = 'ungrounded';
  const ungrounded = await rewrite(done._id, 0).expect(502);
  expect(ungrounded.body.error).toMatch(/could not be built/);
  mode = 'fail';
  const failed = await rewrite(done._id, 0).expect(502);
  expect(JSON.stringify(failed.body)).not.toMatch(/upstream|candidate answer/);
  expect((await Interview.findById(done._id).lean())!.rewrites).toEqual([]);
  mode = 'good';
  expect((await rewrite(done._id, 0).expect(201)).body.interview.rewrites).toHaveLength(1);
});

it('refuses practice sessions, missing answers, other accounts and requests without current consent', async () => {
  const practice = await completedInterview('practice');
  await rewrite(practice._id, 0).expect(409);
  const done = await completedInterview();
  await rewrite(done._id, 4).expect(409);
  await owner.post(`/api/interviews/${done._id}/rewrites`).send({ questionIndex: 'first' }).expect(400);
  const stranger = request.agent(app);
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger-rewrite@example.test', password: 'test-password' }).expect(201);
  await stranger.post(`/api/interviews/${done._id}/rewrites`).send({ questionIndex: 0 }).expect(404);
  await owner.delete('/api/account/ai-consent').expect(200);
  expect((await rewrite(done._id, 0).expect(409)).body.code).toBe('AI_CONSENT_REQUIRED');
  await consent();
  expect(rewrites).toHaveLength(0);
});
