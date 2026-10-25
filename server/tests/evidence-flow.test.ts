import { AIUsage } from '../src/models/AIUsage.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { processNextInterviewJob } from '../src/services/interviewJobs.js';

process.env.JWT_SECRET = 'evidence-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const owner = request.agent(app);
const requests: any[] = [];
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body); requests.push(parsed);
  const input = JSON.parse(parsed.messages[1].content);
  const value = input.turns ? { answers: input.turns.map((turn: any) => ({ questionIndex: turn.questionIndex,
    criteria: input.rubric.criteria.map((c: any, i: number) => ({ criterionId: c.id, score: 4,
      quote: i === 0 ? 'fabricated evidence' : turn.answer, rationale: 'The answer states a comparison.', improvement: 'Add a concrete example.' })) })) }
    : { question: `Explain array access, question ${input.questionNumber}.`, topic: 'DSA' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model + '-resolved',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 60, total_tokens: 110 } }));
});
let mongo: MongoMemoryServer;
beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Evidence Tester', email: 'evidence@example.test', password: 'test-password' }).expect(201);
  const consent=(await owner.get('/api/account/ai-consent')).body;
  await owner.post('/api/account/ai-consent').send({version:consent.disclosure.version,accepted:true}).expect(200);
}, 120_000);
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('persists provider provenance and verified scorecards through the real HTTP gateway and durable worker', async () => {
  const started = await owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2 }).expect(201);
  const id = started.body.interview._id;
  expect(started.body.interview.currentQuestionGeneration.model).toBe('iq-interviewer-resolved');
  for (let questionIndex = 0; questionIndex < 2; questionIndex++) {
    const answer = questionIndex === 0 ? 'Arrays provide indexed access. '.repeat(100) : 'Linked lists require traversal to find an indexed item.';
    await owner.post(`/api/interviews/${id}/answer`).send({ answer, questionIndex, submissionId: `turn-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  const saved = (await owner.get(`/api/interviews/${id}`).expect(200)).body.interview;
  expect(saved.status).toBe('completed');
  expect(saved.turns[0].questionGeneration.promptVersion).toBe('interviewer.v3');
  expect(saved.feedback.generation).toMatchObject({ model: 'iq-judge-resolved', provider: 'compatible', inputTokens: 50, outputTokens: 60 });
  expect(saved.feedback.rubric.version).toBe('2026-10-24.v1');
  expect(saved.feedback.answers[0].criteria[0]).toMatchObject({ score: null, evidence: null, status: 'insufficient_evidence' });
  expect(saved.feedback.answers[0].criteria[1].evidence.quote).toBe(saved.turns[0].answer);
  expect(saved.feedback.score).toBe(80);
  expect(requests).toHaveLength(3);
  const attempts = await AIUsage.find({ interviewId: id }).lean();
  expect(attempts).toHaveLength(3);
  expect(attempts.every(a => a.status === 'succeeded' && a.inputTokens === 50 && a.outputTokens === 60)).toBe(true);
  expect(attempts.map(a => a.slot).sort()).toEqual(['interviewer', 'interviewer', 'judge']);
  expect(JSON.parse(requests[2].messages[1].content).turns[0].answer.length).toBeGreaterThan(2500);
  expect(requests[2].model).toBe('iq-judge');
  const history = (await owner.get('/api/interviews').expect(200)).body.interviews;
  expect(history[0].feedback.score).toBe(80);
  expect(history[0].feedback.answers).toBeUndefined();
  expect(history[0].feedback.generation).toBeUndefined();
  const stranger = request.agent(app);
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger-evidence@example.test', password: 'test-password' }).expect(201);
  await stranger.get(`/api/interviews/${id}`).expect(404);
});
