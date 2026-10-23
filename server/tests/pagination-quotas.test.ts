import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';
import { consumeQuota, consumeAIQuota, QuotaBucket, QuotaError } from '../src/services/quotas.js';
import { processNextInterviewJob } from '../src/services/interviewJobs.js';
import * as ai from '../src/services/ai.js';
process.env.JWT_SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
delete process.env.OPENAI_API_KEY;
const { app } = await import('../src/app.js');
const owner = request.agent(app);
const other = request.agent(app);
let mongo: MongoMemoryServer;
let ownerId: string;
let otherId: string;
const setup = { role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'React', totalQuestions: 2 };
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  ownerId = (await owner.post('/api/auth/register').send({ name: 'Owner', email: 'pages@example.test', password: 'test-password' }).expect(201)).body.user.id;
  otherId = (await other.post('/api/auth/register').send({ name: 'Other', email: 'other-pages@example.test', password: 'test-password' }).expect(201)).body.user.id;
}, 120_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const key of ['INTERVIEWS_PER_DAY', 'AI_CALLS_PER_DAY', 'INTERVIEW_WRITES_PER_15_MIN']) delete process.env[key];
  await Interview.deleteMany({}); await QuotaBucket.deleteMany({});
});
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

it('paginates 106 tied-date records without duplicates, omissions or another account', async () => {
  const base = { ...setup, currentQuestion: 'Question', currentTopic: 'React', createdAt: new Date('2026-01-01T00:00:00Z') };
  await Interview.insertMany(Array.from({ length: 106 }, () => ({ ...base, userId: ownerId })));
  await Interview.create({ ...base, userId: otherId });
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await owner.get(`/api/interviews?limit=20${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
    expect(page.body.interviews.length).toBeLessThanOrEqual(20);
    expect(page.body.interviews.every((x: any) => !x.turns)).toBe(true);
    ids.push(...page.body.interviews.map((x: any) => x._id));
    cursor = page.body.nextCursor;
    if (ids.length === 20) await Interview.create({ ...base, userId: ownerId, createdAt: new Date() });
  } while (cursor);
  expect(ids).toHaveLength(106); expect(new Set(ids).size).toBe(106);
});

it('validates cursor/page limits and returns an empty terminal page', async () => {
  for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'cursor=garbage']) await owner.get(`/api/interviews?${query}`).expect(400);
  const empty = await owner.get('/api/interviews').expect(200);
  expect(empty.body).toEqual({ interviews: [], nextCursor: null });
});

it('enforces shared counters atomically under concurrent requests', async () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => consumeQuota(ownerId, 'test', 3, 86400_000, now)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(17);
  await expect(consumeQuota(otherId, 'test', 3, 86400_000, now)).resolves.toMatchObject({ remaining: 2 });
});

it('persists quota across connections and resets by window rather than TTL cleanup', async () => {
  const now = new Date('2026-01-01T23:59:59Z');
  await consumeQuota(ownerId, 'test', 1, 86400_000, now);
  await mongoose.disconnect(); await mongoose.connect(mongo.getUri());
  await expect(consumeQuota(ownerId, 'test', 1, 86400_000, now)).rejects.toBeInstanceOf(QuotaError);
  await expect(consumeQuota(ownerId, 'test', 1, 86400_000, new Date('2026-01-02T00:00:00Z'))).resolves.toMatchObject({ remaining: 0 });
});

it('returns structured 429 and reset information without blocking another account', async () => {
  process.env.INTERVIEWS_PER_DAY = '1';
  await owner.post('/api/interviews').send(setup).expect(201);
  const denied = await owner.post('/api/interviews').send(setup).expect(429);
  expect(denied.body.code).toBe('QUOTA_EXCEEDED');
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
  await other.post('/api/interviews').send(setup).expect(201);
  expect(await Interview.countDocuments({ userId: ownerId })).toBe(1);
});

it('keeps reads available when the write quota is exhausted', async () => {
  process.env.INTERVIEW_WRITES_PER_15_MIN = '1';
  const created = await owner.post('/api/interviews').send(setup).expect(201);
  await owner.post(`/api/interviews/${created.body.interview._id}/answer`).send({ answer: 'A sufficient answer.', submissionId: 'one', questionIndex: 0 }).expect(429);
  await owner.get('/api/interviews').expect(200);
  await owner.get('/api/auth/me').expect(200);
});

it('defers saved AI work until quota reset without consuming retry attempts', async () => {
  process.env.AI_CALLS_PER_DAY = '1';
  await consumeAIQuota(ownerId);
  const doc = await Interview.create({ ...setup, userId: ownerId, mode: 'ai', currentQuestion: 'Explain React.', currentTopic: 'React',
    processingState: 'queued', jobNextAttemptAt: new Date(0), jobAttempts: 0,
    turns: [{ question: 'Explain React.', answer: 'React renders UI from state.', topic: 'React', answeredAt: new Date() }] });
  const generate = vi.spyOn(ai, 'generateQuestion').mockResolvedValue({ question: 'Next question', topic: 'React' });
  await processNextInterviewJob();
  const waiting = await Interview.findById(doc.id);
  expect(waiting?.turns).toHaveLength(1); expect(waiting?.jobAttempts).toBe(0);
  expect(waiting?.processingState).toBe('queued');
  expect(waiting!.jobNextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  expect(generate).not.toHaveBeenCalled();
  await QuotaBucket.deleteMany({});
  await Interview.updateOne({ _id: doc.id }, { $set: { jobNextAttemptAt: new Date(0) } });
  await processNextInterviewJob();
  expect((await Interview.findById(doc.id))?.processingState).toBe('ready');
  expect(generate).toHaveBeenCalledOnce();
});
