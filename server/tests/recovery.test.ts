import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';
import * as ai from '../src/services/ai.js';
import { processNextInterviewJob, startInterviewWorker, MAX_JOB_ATTEMPTS } from '../src/services/interviewJobs.js';

process.env.JWT_SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
delete process.env.OPENAI_API_KEY;
const { app } = await import('../src/app.js');
const owner = request.agent(app);
const stranger = request.agent(app);
let mongo: MongoMemoryServer;
let ownerId: string;
const payload = { answer: 'State changes cause React to reconcile the component tree.', questionIndex: 0, submissionId: 'saved-answer' };
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ownerId = (await owner.post('/api/auth/register').send({ name: 'Owner', email: 'recovery@example.test', password: 'test-password' }).expect(201)).body.user.id;
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger@example.test', password: 'test-password' }).expect(201);
}, 120_000);
beforeEach(async () => { vi.restoreAllMocks(); delete process.env.OPENAI_API_KEY; await Interview.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
async function queued() {
  const doc = await Interview.create({ userId: ownerId, role: 'Developer', type: 'Technical', difficulty: 'Intermediate',
    topic: 'React', totalQuestions: 2, mode: 'practice', currentQuestion: 'Explain React rendering.', currentTopic: 'React' });
  const saved = await owner.post(`/api/interviews/${doc.id}/answer`).send(payload).expect(202);
  expect(saved.body.interview.turns).toHaveLength(1);
  expect(saved.body.interview.processingState).toBe('queued');
  return doc.id as string;
}
async function due(id: string) {
  await Interview.updateOne({ _id: id }, { $set: { jobNextAttemptAt: new Date(0) } });
}

it('persists before calling the provider, survives failure, and recovers without resubmission', async () => {
  const id = await queued();
  const generate = vi.spyOn(ai, 'generateQuestion').mockImplementationOnce(async () => {
    const saved = await Interview.findById(id);
    expect(saved?.turns[0].answer).toBe(payload.answer);
    expect(saved?.processingState).toBe('processing');
    throw new Error('provider timeout with private details');
  });
  await processNextInterviewJob();
  const failedAttempt = await owner.get(`/api/interviews/${id}`).expect(200);
  expect(failedAttempt.body.interview.turns).toHaveLength(1);
  expect(failedAttempt.body.interview.processingState).toBe('queued');
  expect(JSON.stringify(failedAttempt.body)).not.toContain('private details');
  expect(await processNextInterviewJob()).toBe(false); // backoff is respected
  await due(id);
  await processNextInterviewJob();
  expect(generate).toHaveBeenCalledTimes(2);
  expect((await Interview.findById(id))?.processingState).toBe('ready');
  expect((await Interview.findById(id))?.turns).toHaveLength(1);
});

it('replays queued submissions and refuses a new answer until the next question is ready', async () => {
  const id = await queued();
  const replay = await owner.post(`/api/interviews/${id}/answer`).send(payload).expect(200);
  expect(replay.body.replayed).toBe(true);
  await owner.post(`/api/interviews/${id}/answer`).send({ ...payload, questionIndex: 1, submissionId: 'too-soon' }).expect(409);
  expect((await Interview.findById(id))?.turns).toHaveLength(1);
});

it('limits automatic retries and allows only the owner to requeue failed work', async () => {
  const id = await queued();
  vi.spyOn(ai, 'generateQuestion').mockRejectedValue(new Error('unavailable'));
  for (let n = 0; n < MAX_JOB_ATTEMPTS; n++) { await due(id); await processNextInterviewJob(); }
  expect((await Interview.findById(id))?.processingState).toBe('failed');
  expect(await processNextInterviewJob()).toBe(false);
  await request(app).post(`/api/interviews/${id}/retry`).expect(401);
  await stranger.post(`/api/interviews/${id}/retry`).expect(404);
  const retry = await owner.post(`/api/interviews/${id}/retry`).expect(202);
  expect(retry.body.interview.turns).toHaveLength(1);
  expect(retry.body.interview.jobAttempts).toBe(0);
  await owner.post(`/api/interviews/${id}/retry`).expect(409);
  vi.restoreAllMocks();
  await processNextInterviewJob();
  expect((await Interview.findById(id))?.processingState).toBe('ready');
});

it('only permits one worker to claim a live job', async () => {
  const id = await queued();
  let finish!: (value: { question: string; topic: string }) => void;
  const generate = vi.spyOn(ai, 'generateQuestion').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = processNextInterviewJob();
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  try { expect(await processNextInterviewJob()).toBe(false); }
  finally { finish({ question: 'Next question', topic: 'React' }); await first; }
  expect((await Interview.findById(id))?.turns).toHaveLength(1);
});

it('reclaims expired work and fences late results from the former worker', async () => {
  const id = await queued();
  let finish!: (value: { question: string; topic: string }) => void;
  const generate = vi.spyOn(ai, 'generateQuestion')
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ question: 'Recovered question', topic: 'React' });
  const oldWorker = processNextInterviewJob();
  await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
  try {
    await Interview.updateOne({ _id: id }, { $set: { jobLeaseUntil: new Date(0) } });
    await processNextInterviewJob();
  } finally { finish({ question: 'Stale result', topic: 'React' }); await oldWorker; }
  expect((await Interview.findById(id))?.currentQuestion).toBe('Recovered question');
  expect((await Interview.findById(id))?.jobAttempts).toBe(2);
});

it('moves a crashed final attempt to a manually recoverable state', async () => {
  const id = await queued();
  await Interview.updateOne({ _id: id }, { $set: { processingState: 'processing', jobAttempts: MAX_JOB_ATTEMPTS,
    jobLeaseToken: 'dead-worker', jobLeaseUntil: new Date(0) } });
  expect(await processNextInterviewJob()).toBe(false);
  expect((await Interview.findById(id))?.processingState).toBe('failed');
  await owner.post(`/api/interviews/${id}/retry`).expect(202);
  await processNextInterviewJob();
  expect((await Interview.findById(id))?.processingState).toBe('ready');
});

it('recovers persisted work when a fresh worker starts', async () => {
  const id = await queued();
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri());
  const stop = startInterviewWorker();
  try {
    await vi.waitFor(async () => expect((await Interview.findById(id))?.processingState).toBe('ready'), { timeout: 5000 });
  } finally { await stop(); }
});

it('preserves the final answer when evaluation fails, then completes on recovery', async () => {
  const id = await queued();
  await processNextInterviewJob();
  await owner.post(`/api/interviews/${id}/answer`).send({ ...payload, questionIndex: 1, submissionId: 'final-answer' }).expect(202);
  vi.spyOn(ai, 'evaluateInterview').mockRejectedValueOnce(new Error('evaluation failed'));
  await processNextInterviewJob();
  const pending = await Interview.findById(id);
  expect(pending?.turns).toHaveLength(2);
  expect(pending?.status).toBe('in_progress');
  await due(id);
  await processNextInterviewJob();
  const complete = await Interview.findById(id);
  expect(complete?.status).toBe('completed');
  expect(complete?.feedback?.score).toBeNull();
  expect(await processNextInterviewJob()).toBe(false);
});

it('keeps the session mode stable across configuration changes', async () => {
  const id = await queued();
  process.env.OPENAI_API_KEY = 'not-a-real-key';
  await processNextInterviewJob(); // practice must not call the provider
  expect((await Interview.findById(id))?.processingState).toBe('ready');
  delete process.env.OPENAI_API_KEY;
  await Interview.updateOne({ _id: id }, { $set: { mode: 'ai' } });
  await owner.post(`/api/interviews/${id}/answer`).send({ ...payload, questionIndex: 1, submissionId: 'final' }).expect(202);
  await processNextInterviewJob();
  const doc = await Interview.findById(id);
  expect(doc?.processingState).toBe('queued');
  expect(doc?.feedback).toBeUndefined(); // never silently replace AI assessment with practice
});
