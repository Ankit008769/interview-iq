import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';
import { QUESTION_BANK, bankTopicFor, pickPracticeQuestion } from '../src/services/questionBank.js';

process.env.JWT_SECRET = 'test-only-secret-with-more-than-thirty-two-characters';
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
let mongo: MongoMemoryServer;
const first = () => 0;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Bank User', email: 'bank@example.test', password: 'a-test-password' }).expect(201);
}, 120_000);
beforeEach(async () => { await Interview.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

describe('curated practice question bank', () => {
  it('has unique IDs and text, and enough questions for every topic and difficulty', () => {
    expect(new Set(QUESTION_BANK.map(q => q.id)).size).toBe(QUESTION_BANK.length);
    expect(new Set(QUESTION_BANK.map(q => q.question.toLowerCase())).size).toBe(QUESTION_BANK.length);
    for (const topic of ['DSA', 'React', 'Node.js', 'DBMS', 'Behavioral', 'General']) {
      for (const difficulty of ['Beginner', 'Intermediate', 'Advanced']) {
        // A session has at most five questions; one spare keeps the next session from being fully repeated.
        expect(QUESTION_BANK.filter(q => q.topic === topic && q.difficulty === difficulty).length).toBeGreaterThanOrEqual(6);
      }
    }
    expect(QUESTION_BANK.every(q => q.question.length <= 650)).toBe(true);
  });

  it('maps interview types onto bank topics', () => {
    expect(bankTopicFor('Technical', 'React')).toBe('React');
    expect(bankTopicFor('Technical', 'Kubernetes')).toBe('General');
    expect(bankTopicFor('Behavioral', 'React')).toBe('Behavioral');
    expect(bankTopicFor('HR', 'DSA')).toBe('General');
  });

  it('respects difficulty and never repeats within a session, including legacy text-only turns', () => {
    const history: { question: string; questionId?: string }[] = [{ question: QUESTION_BANK.find(q => q.id === 'dsa-a1')!.question }];
    for (let i = 0; i < 4; i++) {
      const next = pickPracticeQuestion({ type: 'Technical', topic: 'DSA', difficulty: 'Advanced', history, recentIds: [], random: first });
      expect(next.difficulty).toBe('Advanced');
      expect(next.id).not.toBe('dsa-a1');
      expect(history.some(t => t.questionId === next.id)).toBe(false);
      history.push({ question: next.question, questionId: next.id });
    }
  });

  it('prefers questions the user has not seen, then the least recently seen', () => {
    const pool = QUESTION_BANK.filter(q => q.topic === 'React' && q.difficulty === 'Beginner').map(q => q.id);
    const unseen = pickPracticeQuestion({ type: 'Technical', topic: 'React', difficulty: 'Beginner', history: [], recentIds: pool.slice(0, 5), random: first });
    expect(unseen.id).toBe(pool[5]);
    const oldest = pickPracticeQuestion({ type: 'Technical', topic: 'React', difficulty: 'Beginner', history: [], recentIds: [...pool].reverse(), random: first });
    expect(oldest.id).toBe(pool[0]);
  });

  it('gives a returning user different questions in the next session', async () => {
    const setup = { role: 'Backend developer', type: 'Technical', difficulty: 'Advanced', topic: 'Node.js', totalQuestions: 3 };
    const run = async () => {
      const created = await owner.post('/api/interviews').send(setup).expect(201);
      const id = created.body.interview._id as string;
      for (let questionIndex = 0; questionIndex < 3; questionIndex++) {
        await owner.post(`/api/interviews/${id}/answer`).send({ questionIndex, submissionId: `s-${id}-${questionIndex}`,
          answer: 'A detailed practice answer about idempotency keys, retries and safe state transitions.' }).expect(202);
        await processNextInterviewJob();
      }
      const done = await Interview.findById(id).lean();
      expect(done?.status).toBe('completed');
      return done!.turns.map(t => t.questionId!);
    };
    const firstIds = await run();
    const secondIds = await run();
    const advancedNode = QUESTION_BANK.filter(q => q.topic === 'Node.js' && q.difficulty === 'Advanced').map(q => q.id);
    for (const id of [...firstIds, ...secondIds]) expect(advancedNode).toContain(id);
    expect(new Set(firstIds).size).toBe(3);
    expect(secondIds.filter(id => firstIds.includes(id))).toEqual([]);
  });
});
