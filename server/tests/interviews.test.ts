import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';

process.env.JWT_SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
delete process.env.OPENAI_API_KEY;
const { app } = await import('../src/app.js');
const ai = await import('../src/services/ai.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
const other = request.agent(app);
let mongo: MongoMemoryServer;
let ownerId: string;
let otherId: string;
const setup = { role: 'MERN developer', type: 'Technical', difficulty: 'Intermediate', topic: 'React', totalQuestions: 2 };
const answer = { answer: 'State updates trigger rendering and React reconciles the resulting tree.', questionIndex: 0, submissionId: 'first-answer' };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const first = await owner.post('/api/auth/register').send({ name: 'Test Owner', email: 'owner@example.test', password: 'a-test-password' }).expect(201);
  ownerId = first.body.user.id;
  const second = await other.post('/api/auth/register').send({ name: 'Other User', email: 'other@example.test', password: 'a-test-password' }).expect(201);
  otherId = second.body.user.id;
}, 120_000);
beforeEach(async () => { vi.restoreAllMocks(); await Interview.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
async function createInterview() {
  const response = await owner.post('/api/interviews').send(setup).expect(201);
  return response.body.interview._id as string;
}

describe('interview API with real MongoDB', () => {
  it('returns empty lifetime statistics without manufacturing a score', async () => {
    const result = await owner.get('/api/interviews/dashboard').expect(200);
    expect(result.body).toEqual({ total: 0, completed: 0, averageScore: null, recent: [] });
  });
  it('completes practice, preserves answers, and never invents a score', async () => {
    const id = await createInterview();
    await owner.post(`/api/interviews/${id}/answer`).send(answer).expect(202);
    await processNextInterviewJob();
    await owner.post(`/api/interviews/${id}/answer`).send({ ...answer, questionIndex: 1, submissionId: 'second-answer' }).expect(202);
    await processNextInterviewJob();
    const result = await owner.get(`/api/interviews/${id}`).expect(200);
    expect(result.body.interview.status).toBe('completed');
    expect(result.body.interview.turns).toHaveLength(2);
    expect(result.body.interview.feedback).toMatchObject({ source: 'practice', score: null });
    const history = await owner.get('/api/interviews').expect(200);
    expect(history.body.interviews[0].answered).toBe(2);
  });

  it('replays a delayed request without consuming the next question or another AI call', async () => {
    const id = await createInterview();
    await owner.post(`/api/interviews/${id}/answer`).send(answer).expect(202);
    await processNextInterviewJob();
    const generation = vi.spyOn(ai, 'generateQuestion');
    const replay = await owner.post(`/api/interviews/${id}/answer`).send(answer).expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.interview.turns).toHaveLength(1);
    expect(generation).not.toHaveBeenCalled();
    await owner.post(`/api/interviews/${id}/answer`).send({ ...answer, submissionId: 'different-key' }).expect(409);
  });

  it('rejects reuse of a submission ID with changed content', async () => {
    const id = await createInterview();
    await owner.post(`/api/interviews/${id}/answer`).send(answer).expect(202);
    await processNextInterviewJob();
    await owner.post(`/api/interviews/${id}/answer`).send({ ...answer, answer: 'This is a different response.' }).expect(409);
    expect((await Interview.findById(id))?.turns).toHaveLength(1);
  });

  it('allows replay after completion without appending an answer', async () => {
    const id = await createInterview();
    await owner.post(`/api/interviews/${id}/answer`).send(answer).expect(202);
    await processNextInterviewJob();
    const last = { ...answer, questionIndex: 1, submissionId: 'last-answer' };
    await owner.post(`/api/interviews/${id}/answer`).send(last).expect(202);
    await processNextInterviewJob();
    const replay = await owner.post(`/api/interviews/${id}/answer`).send(last).expect(200);
    expect(replay.body.interview.turns).toHaveLength(2);
  });

  it('accepts at most one of two simultaneous answers', async () => {
    const id = await createInterview();
    const responses = await Promise.all([
      owner.post(`/api/interviews/${id}/answer`).send(answer),
      owner.post(`/api/interviews/${id}/answer`).send({ ...answer, submissionId: 'another-tab' }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 409]);
    expect((await Interview.findById(id))?.turns).toHaveLength(1);
  });

  it('requires authentication, ownership and question identity', async () => {
    const id = await createInterview();
    await request(app).get('/api/interviews').expect(401);
    await other.get(`/api/interviews/${id}`).expect(404);
    await other.post(`/api/interviews/${id}/answer`).send(answer).expect(404);
    await owner.post(`/api/interviews/${id}/answer`).send({ answer: answer.answer }).expect(400);
    await owner.post('/api/interviews').set('Origin', 'https://untrusted.example').send(setup).expect(403);
  });

  it('aggregates more than 100 sessions without including another user or practice scores', async () => {
    const base = { ...setup, currentQuestion: 'Explain rendering?', currentTopic: 'React', status: 'completed', turns: [] };
    await Interview.insertMany([
      ...Array.from({ length: 105 }, () => ({ ...base, userId: ownerId, feedback: { source: 'practice', score: null, summary: 'Practice' } })),
      { ...base, userId: ownerId, feedback: { source: 'ai', score: 80, summary: 'Feedback' } },
      { ...base, userId: otherId, feedback: { source: 'ai', score: 10, summary: 'Other user' } },
    ]);
    const result = await owner.get('/api/interviews/dashboard').expect(200);
    expect(result.body).toMatchObject({ total: 106, completed: 106, averageScore: 80 });
    expect(result.body.recent).toHaveLength(5);
  });

  it('clears the authenticated session on logout', async () => {
    const session = request.agent(app);
    await session.post('/api/auth/login').send({ email: 'owner@example.test', password: 'a-test-password' }).expect(200);
    await session.get('/api/auth/me').expect(200);
    await session.post('/api/auth/logout').expect(200);
    await session.get('/api/auth/me').expect(401);
  });
});
