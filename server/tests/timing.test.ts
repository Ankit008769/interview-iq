import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';

process.env.JWT_SECRET = 'timing-test-secret-longer-than-thirty-two-characters';
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;
process.env.INTERVIEW_WRITES_PER_15_MIN = '500';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
let mongo: MongoMemoryServer;
const setup = { role: 'Backend developer', type: 'Technical', difficulty: 'Intermediate', topic: 'Node.js', totalQuestions: 2 };
const answer = (questionIndex: number) => ({ questionIndex, submissionId: `t-${questionIndex}-${Math.random()}`,
  answer: 'The event loop runs callbacks after the call stack empties and polls for I/O.' });
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Timer', email: 'timer@example.test', password: 'a-test-password' }).expect(201);
}, 120_000);
beforeEach(async () => { await Interview.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); delete process.env.INTERVIEW_WRITES_PER_15_MIN; });

it('starts a timed round with a server clock and reports server time for the countdown', async () => {
  const before = Date.now();
  const created = await owner.post('/api/interviews').send({ ...setup, timeLimitSeconds: 180 }).expect(201);
  expect(created.body.interview).toMatchObject({ timeLimitSeconds: 180, pausedMs: 0 });
  expect(new Date(created.body.interview.questionStartedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  expect(new Date(created.body.serverNow).getTime()).toBeGreaterThanOrEqual(before - 1000);
  await owner.post('/api/interviews').send({ ...setup, timeLimitSeconds: 45 }).expect(400);
});

it('records time taken, marks over-time answers and restarts the clock only when the next question is ready', async () => {
  const id = (await owner.post('/api/interviews').send({ ...setup, timeLimitSeconds: 120 }).expect(201)).body.interview._id;
  await Interview.updateOne({ _id: id }, { $set: { questionStartedAt: ago(150) } });
  const saved = (await owner.post(`/api/interviews/${id}/answer`).send(answer(0)).expect(202)).body.interview;
  near(saved.turns[0].elapsedSeconds, 150);
  expect(saved.turns[0]).toMatchObject({ overTime: true, pausedSeconds: 0 });
  const queuedAt = Date.now();
  await processNextInterviewJob();
  const next = (await owner.get(`/api/interviews/${id}`).expect(200)).body.interview;
  expect(new Date(next.questionStartedAt).getTime()).toBeGreaterThanOrEqual(queuedAt - 1000);
  expect(next.pausedMs).toBe(0);
  await Interview.updateOne({ _id: id }, { $set: { questionStartedAt: ago(60) } });
  const second = (await owner.post(`/api/interviews/${id}/answer`).send(answer(1)).expect(202)).body.interview;
  near(second.turns[1].elapsedSeconds, 60);
  expect(second.turns[1].overTime).toBe(false);
});

it('excludes paused time, makes pause and resume idempotent, and stops the clock if answered while paused', async () => {
  const id = (await owner.post('/api/interviews').send({ ...setup, timeLimitSeconds: 180 }).expect(201)).body.interview._id;
  await Interview.updateOne({ _id: id }, { $set: { questionStartedAt: ago(100) } });
  const paused = (await owner.post(`/api/interviews/${id}/pause`).expect(200)).body.interview;
  expect(paused.pausedAt).toBeTruthy();
  expect((await owner.post(`/api/interviews/${id}/pause`).expect(200)).body.interview.pausedAt).toBe(paused.pausedAt);
  await Interview.updateOne({ _id: id }, { $set: { pausedAt: ago(30) } });
  const resumed = (await owner.post(`/api/interviews/${id}/resume`).expect(200)).body.interview;
  expect(resumed.pausedAt).toBeUndefined();
  near(resumed.pausedMs / 1000, 30);
  expect((await owner.post(`/api/interviews/${id}/resume`).expect(200)).body.interview.pausedMs).toBe(resumed.pausedMs);
  const saved = (await owner.post(`/api/interviews/${id}/answer`).send(answer(0)).expect(202)).body.interview;
  near(saved.turns[0].elapsedSeconds, 70);
  near(saved.turns[0].pausedSeconds, 30);

  await processNextInterviewJob();
  await Interview.updateOne({ _id: id }, { $set: { questionStartedAt: ago(90), pausedAt: ago(40), pausedMs: 0 } });
  const whilePaused = (await owner.post(`/api/interviews/${id}/answer`).send(answer(1)).expect(202)).body.interview;
  near(whilePaused.turns[1].elapsedSeconds, 50);
  expect(whilePaused.pausedAt).toBeUndefined();
});

it('only pauses a timed question that is on screen, for its owner', async () => {
  const untimed = (await owner.post('/api/interviews').send(setup).expect(201)).body.interview._id;
  await owner.post(`/api/interviews/${untimed}/pause`).expect(409);
  const timed = (await owner.post('/api/interviews').send({ ...setup, timeLimitSeconds: 300 }).expect(201)).body.interview._id;
  await owner.post(`/api/interviews/${timed}/answer`).send(answer(0)).expect(202);
  await owner.post(`/api/interviews/${timed}/pause`).expect(409);
  const stranger = request.agent(app);
  await stranger.post('/api/auth/register').send({ name: 'Stranger', email: 'stranger-timer@example.test', password: 'a-test-password' }).expect(201);
  await stranger.post(`/api/interviews/${timed}/pause`).expect(404);
  await stranger.post(`/api/interviews/${timed}/resume`).expect(404);
  await owner.post('/api/interviews/not-an-id/pause').expect(404);
});

it('records time taken for untimed sessions without an over-time flag', async () => {
  const id = (await owner.post('/api/interviews').send(setup).expect(201)).body.interview._id;
  await Interview.updateOne({ _id: id }, { $set: { questionStartedAt: ago(500) } });
  const turn = (await owner.post(`/api/interviews/${id}/answer`).send(answer(0)).expect(202)).body.interview.turns[0];
  near(turn.elapsedSeconds, 500);
  expect(turn.overTime).toBeUndefined();
});
