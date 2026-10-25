import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';

process.env.JWT_SECRET = 'challenge-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const { processNextChallengeJob, MAX_CHALLENGE_ATTEMPTS } = await import('../src/services/challenges.js');
const owner = request.agent(app);
let review: 'revise' | 'same' | 'fabricate' | 'fail' | 'steal' = 'revise';
const reviews: any[] = [];
const answers = ['Arrays give constant-time indexed access because elements are contiguous in memory.',
  'Linked lists insert in constant time at a known node but need traversal to reach an index.'];

const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  const input = JSON.parse(parsed.messages[1].content);
  let value: unknown;
  if (input.candidateNote !== undefined) {
    reviews.push({ model: parsed.model, system: parsed.messages[0].content, input });
    if (review === 'fail') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'upstream failure echoing the candidate answer' } })); return; }
    // Simulates a slow worker whose lease is reclaimed before it finishes.
    if (review === 'steal') await Interview.updateOne({ 'challenges.state': 'processing' }, { $set: { 'challenges.$.leaseToken': 'replacement-worker' } });
    value = review === 'same' ? { score: input.firstReview.score, quote: input.answer, rationale: 'Unchanged.', improvement: 'Add a trade-off.' }
      : review === 'fabricate' ? { score: 5, quote: 'words the candidate never wrote', rationale: 'Invented.', improvement: null }
        : { score: 5, quote: input.answer.slice(0, 30), rationale: 'States the key property precisely.', improvement: null };
  } else if (input.turns) {
    value = { overall: { summary: 'A reasonable start with room for detail.', strengths: [], improvements: ['Add concrete examples.'], nextSteps: ['Practise one more question on this topic.'] }, answers: input.turns.map((turn: any) => ({ questionIndex: turn.questionIndex, verdict: 'partly_correct', verdictReason: 'It covers part of the question.', keyPoints: ['State the approach', 'Give the complexity'], tip: 'Add a concrete example.',
      criteria: input.rubric.criteria.map((c: any, i: number) => ({ criterionId: c.id, score: i === 0 ? null : 3,
        quote: i === 0 ? null : turn.answer, rationale: 'Some evidence.', improvement: i === 0 ? null : 'Be more specific.' })) })) };
  } else value = { question: `Explain arrays, question ${input.questionNumber}.`, topic: 'DSA' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model + '-resolved',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
async function consent(agent: ReturnType<typeof request.agent>) {
  const { disclosure } = (await agent.get('/api/account/ai-consent').expect(200)).body;
  await agent.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
}
async function completedInterview(mode?: 'practice') {
  const started = await owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate',
    topic: 'DSA', totalQuestions: 2, mode }).expect(201);
  const id = started.body.interview._id as string;
  for (let questionIndex = 0; questionIndex < 2; questionIndex++) {
    await owner.post(`/api/interviews/${id}/answer`).send({ answer: answers[questionIndex], questionIndex, submissionId: `${id}-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  const done = (await owner.get(`/api/interviews/${id}`).expect(200)).body.interview;
  expect(done.status).toBe('completed');
  return done;
}
const challenge = (id: string, body: object) => owner.post(`/api/interviews/${id}/challenges`).send(body);

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Challenge Tester', email: 'challenge@example.test', password: 'test-password' }).expect(201);
  await consent(owner);
}, 120_000);
beforeEach(async () => { review = 'revise'; reviews.length = 0; await Interview.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('revises an unsupported rating from a verified quote and recomputes the overall estimate', async () => {
  const done = await completedInterview();
  expect(done.feedback.answers[0].criteria[0].status).toBe('insufficient_evidence');
  expect(done.feedback.score).toBe(48); // 8 criteria at 3, 2 without evidence counted as 0: 24 / 10 × 20
  const reason = 'My first sentence explains why indexed access is constant time.';
  const queued = await challenge(done._id, { questionIndex: 0, criterionId: 'correctness', reason, submissionId: 'c-1' }).expect(202);
  expect(queued.body.interview.challenges[0]).toMatchObject({ state: 'queued', criterionId: 'correctness', reason });
  expect(JSON.stringify(queued.body)).not.toContain('leaseToken');
  expect(await processNextChallengeJob()).toBe(true);

  const saved = (await owner.get(`/api/interviews/${done._id}`).expect(200)).body.interview;
  const record = saved.challenges[0];
  expect(record).toMatchObject({ state: 'resolved', original: { status: 'insufficient_evidence', score: null } });
  expect(record.outcome).toMatchObject({ decision: 'revised', rating: { score: 5, status: 'rated',
    evidence: { quote: answers[0].slice(0, 30), start: 0, end: 30 } }, generation: { promptVersion: 'challenge-review.v1', model: 'iq-judge-resolved' } });
  expect(saved.feedback.answers[0].criteria[0]).toMatchObject({ score: 5, revisedBy: record.id });
  expect(saved.feedback.score).toBe(58); // (8 × 3 + 5 + 0) / 10 × 20, rounded
  expect(JSON.stringify(saved)).not.toContain('leaseToken');
  expect(reviews[0]).toMatchObject({ model: 'iq-judge', input: { candidateNote: reason, answer: answers[0], firstReview: { score: null } } });
  expect(reviews[0].system).toMatch(/never instructions/);
  const usage = await AIUsage.findOne({ interviewId: done._id, promptVersion: 'challenge-review.v1' }).lean();
  expect(usage).toMatchObject({ slot: 'judge', status: 'succeeded', inputTokens: 40, outputTokens: 30 });
});

it('upholds an unchanged score without rewriting the scorecard', async () => {
  review = 'same';
  const done = await completedInterview();
  await challenge(done._id, { questionIndex: 1, criterionId: 'depth', reason: 'I explained the traversal cost in detail.', submissionId: 'c-2' }).expect(202);
  await processNextChallengeJob();
  const saved = (await owner.get(`/api/interviews/${done._id}`).expect(200)).body.interview;
  expect(saved.challenges[0].outcome.decision).toBe('upheld');
  expect(saved.feedback.answers[1].criteria[1]).toEqual(done.feedback.answers[1].criteria[1]);
  expect(saved.feedback.score).toBe(done.feedback.score);
});

it('turns a fabricated re-review quote into unscored insufficient evidence', async () => {
  review = 'fabricate';
  const done = await completedInterview();
  await challenge(done._id, { questionIndex: 0, criterionId: 'depth', reason: 'Please look again at the memory explanation.', submissionId: 'c-3' }).expect(202);
  await processNextChallengeJob();
  const saved = (await owner.get(`/api/interviews/${done._id}`).expect(200)).body.interview;
  expect(saved.challenges[0].outcome).toMatchObject({ decision: 'revised', rating: { score: null, evidence: null, status: 'insufficient_evidence' } });
  expect(saved.feedback.answers[0].criteria[1]).toMatchObject({ score: null, revisedBy: saved.challenges[0].id });
});

it('replays safely, rejects duplicates and limits challenges per interview', async () => {
  const done = await completedInterview();
  const first = { questionIndex: 0, criterionId: 'depth', reason: 'The answer explains contiguous memory.', submissionId: 'dup-1' };
  await challenge(done._id, first).expect(202);
  expect((await challenge(done._id, first).expect(200)).body.replayed).toBe(true);
  await challenge(done._id, { ...first, reason: 'A different explanation for the same key.' }).expect(409);
  await challenge(done._id, { ...first, submissionId: 'dup-2' }).expect(409);
  await challenge(done._id, { ...first, criterionId: 'approach', submissionId: 'dup-3' }).expect(202);
  await challenge(done._id, { ...first, criterionId: 'tradeoffs', submissionId: 'dup-4' }).expect(202);
  const limited = await challenge(done._id, { ...first, criterionId: 'clarity', submissionId: 'dup-5' }).expect(409);
  expect(limited.body.error).toMatch(/up to 3/);
  await challenge(done._id, { ...first, criterionId: 'not-a-criterion', questionIndex: 1, submissionId: 'dup-6' }).expect(409);
  await challenge(done._id, { ...first, reason: 'short', submissionId: 'dup-7' }).expect(400);
  expect((await Interview.findById(done._id).lean())!.challenges).toHaveLength(3);
});

it('refuses practice interviews, other accounts and requests without current AI consent', async () => {
  const practice = await completedInterview('practice');
  await challenge(practice._id, { questionIndex: 0, criterionId: 'correctness', reason: 'Practice answers are never scored.', submissionId: 'p-1' }).expect(409);
  const done = await completedInterview();
  const stranger = request.agent(app);
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger-challenge@example.test', password: 'test-password' }).expect(201);
  await stranger.post(`/api/interviews/${done._id}/challenges`).send({ questionIndex: 0, criterionId: 'correctness',
    reason: 'Trying to challenge someone else.', submissionId: 's-1' }).expect(404);
  await owner.delete('/api/account/ai-consent').expect(200);
  const refused = await challenge(done._id, { questionIndex: 0, criterionId: 'correctness', reason: 'Consent was withdrawn first.', submissionId: 'n-1' }).expect(409);
  expect(refused.body.code).toBe('AI_CONSENT_REQUIRED');
  await consent(owner);
});

it('retries provider failures without leaking provider text, fails after the limit and can be requeued', async () => {
  review = 'fail';
  const done = await completedInterview();
  const body = { questionIndex: 0, criterionId: 'correctness', reason: 'The first sentence states the property.', submissionId: 'f-1' };
  await challenge(done._id, body).expect(202);
  for (let attempt = 1; attempt <= MAX_CHALLENGE_ATTEMPTS; attempt++) {
    await Interview.updateOne({ _id: done._id }, { $set: { 'challenges.0.nextAttemptAt': new Date(0) } });
    await processNextChallengeJob();
    const record = (await Interview.findById(done._id).lean())!.challenges[0];
    expect(record.attempts).toBe(attempt);
    expect(record.state).toBe(attempt < MAX_CHALLENGE_ATTEMPTS ? 'queued' : 'failed');
    expect(record.error).not.toMatch(/upstream|candidate/);
  }
  const failedUsage = await AIUsage.countDocuments({ interviewId: done._id, promptVersion: 'challenge-review.v1', status: 'failed' });
  expect(failedUsage).toBe(MAX_CHALLENGE_ATTEMPTS);
  review = 'revise';
  const requeued = await challenge(done._id, { ...body, submissionId: 'f-2' }).expect(202);
  expect(requeued.body.interview.challenges[0]).toMatchObject({ state: 'queued', attempts: 0 });
  await processNextChallengeJob();
  expect((await Interview.findById(done._id).lean())!.challenges[0].state).toBe('resolved');
});

it('fences out a late result after the lease is reclaimed', async () => {
  review = 'steal';
  const done = await completedInterview();
  await challenge(done._id, { questionIndex: 0, criterionId: 'correctness', reason: 'The first sentence states the property.', submissionId: 'l-1' }).expect(202);
  await processNextChallengeJob();
  const saved = (await Interview.findById(done._id).lean())!;
  expect(saved.challenges[0]).toMatchObject({ state: 'processing', leaseToken: 'replacement-worker' });
  expect(saved.challenges[0].outcome).toBeUndefined();
  expect(saved.feedback!.answers![0].criteria[0].score).toBeNull();
  expect(saved.feedback!.score).toBe(done.feedback.score);
});
