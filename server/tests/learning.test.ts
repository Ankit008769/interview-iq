import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { Rating } from 'ts-fsrs';
import { Interview } from '../src/models/Interview.js';
import { SkillState, StudyPlan } from '../src/models/Learning.js';
import { PRIOR_MEAN, PRIOR_VARIANCE, current, gradeFor, level, newCard, observe, readiness, review } from '../src/learning/model.js';
import { SKILLS } from '../src/learning/skills.js';
import { rubricFor } from '../src/services/rubrics.js';

process.env.JWT_SECRET = 'learning-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const { interviewEvidence, localDay, practiceStreak, refreshSkills, replay, selectDrill, HISTORY_POINTS } = await import('../src/services/learning.js');

const DAY = 86_400_000;
const at = new Date('2026-10-01T10:00:00Z');
const oid = () => new mongoose.Types.ObjectId();
const calls: { system: string; input: any; promptVersion?: string }[] = [];
let judgeScores: Record<string, number | null> = {};

// The judge rates every criterion from judgeScores; questions are numbered so none repeat.
const gateway = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = JSON.parse(parsed.messages[1].content);
  calls.push({ system: parsed.messages[0].content, input });
  const value = input.turns
    ? { overall: { summary: 'Solid basics; compare alternatives more.', strengths: [], improvements: ['Compare alternatives.'], nextSteps: ['Practise trade-offs.'] },
      answers: input.turns.map((t: any) => ({ questionIndex: t.questionIndex, verdict: 'partly_correct', verdictReason: 'Mostly right.', keyPoints: ['Point one', 'Point two'],
        tip: 'Add a trade-off.', criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: judgeScores[c.id] ?? null,
          quote: judgeScores[c.id] == null ? null : t.answer.slice(0, 20), rationale: 'Evidence in the answer.', improvement: judgeScores[c.id] == null ? null : 'Go deeper.' })) })) }
    : { question: `Drill question ${calls.length} about hash maps?`, topic: 'DSA' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
const owner = request.agent(app);
const other = request.agent(app);
let ownerId = '';
const ANSWER = 'I would use a hash map because lookups are constant time on average, and fall back to sorting when memory is tight.';
const zone = { 'x-time-zone': 'Asia/Kolkata' };

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await SkillState.init();
  for (const [agent, email] of [[owner, 'learner@example.test'], [other, 'other-learner@example.test']] as const) {
    const registered = await agent.post('/api/auth/register').send({ name: 'Learner', email, password: 'test-password' }).expect(201);
    if (agent === owner) ownerId = registered.body.user.id;
    const { disclosure } = (await agent.get('/api/account/ai-consent').expect(200)).body;
    await agent.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
  }
}, 120_000);
beforeEach(async () => { calls.length = 0; judgeScores = {}; await Promise.all([Interview.deleteMany({}), SkillState.deleteMany({}), StudyPlan.deleteMany({})]); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

type Scores = Record<string, number | null>;
const answer = (scores: Scores) => ({ criteria: Object.entries(scores).map(([criterionId, score]) => ({ criterionId, score })) });
const allScores = (type: 'Technical' | 'Behavioral' | 'HR', score: number | null) =>
  Object.fromEntries(rubricFor(type).criteria.map(c => [c.id, score])) as Scores;
// A completed AI-scored interview stored the way the worker saves one.
async function seedScored(userId: string, input: { type?: 'Technical' | 'Behavioral' | 'HR'; topic?: string; scores: Scores[]; completedAt: Date; purpose?: 'interview' | 'drill'; score?: number }) {
  const type = input.type ?? 'Technical';
  const rubric = rubricFor(type);
  return Interview.create({ userId, role: 'Developer', type, difficulty: 'Intermediate', topic: input.topic ?? 'DSA', totalQuestions: Math.max(2, input.scores.length),
    currentQuestion: 'Done.', currentTopic: 'DSA', mode: 'ai', status: 'completed', completedAt: input.completedAt, purpose: input.purpose ?? 'interview',
    turns: input.scores.map((_, i) => ({ question: `Question ${i + 1}?`, answer: ANSWER, topic: 'DSA', answeredAt: input.completedAt, questionIndex: i })),
    feedback: { source: 'ai', score: input.score ?? 60, summary: 'Seeded.', strengths: [], improvements: [], nextSteps: [], rubric,
      answers: input.scores.map((scores, questionIndex) => ({ questionIndex, criteria: Object.entries(scores).map(([criterionId, score]) => ({
        criterionId, label: criterionId, score, status: score === null ? 'insufficient_evidence' : 'rated', rationale: 'Seeded.', improvement: null, evidence: null })) })) } });
}
const state = (mean: number, variance: number, due: Date) => ({ mean, variance, lastObservedAt: at, observations: 2, history: [], card: { due } });

describe('skill model', () => {
  it('moves the estimate toward rated evidence, more for harder questions, and less for missing evidence', () => {
    const prior = { mean: PRIOR_MEAN, variance: PRIOR_VARIANCE };
    const strong = observe(prior, { score: 5, difficulty: 'Intermediate', at });
    expect(strong.mean).toBeCloseTo(2.5 + (2.25 / 3.25) * 2.5, 6);
    expect(strong.variance).toBeCloseTo(2.25 * 1 / 3.25, 6);
    const hard = observe(prior, { score: 4, difficulty: 'Advanced', at }), easy = observe(prior, { score: 4, difficulty: 'Beginner', at });
    expect(hard.mean).toBeGreaterThan(easy.mean);
    const zero = observe(prior, { score: 0, difficulty: 'Intermediate', at }), missing = observe(prior, { score: null, difficulty: 'Intermediate', at });
    expect(missing.mean).toBeGreaterThan(zero.mean); expect(missing.mean).toBeLessThan(PRIOR_MEAN);
    expect(missing.variance).toBeGreaterThan(zero.variance);
    for (const b of [strong, hard, easy, zero, missing, observe(prior, { score: 5, difficulty: 'Advanced', at })]) {
      expect(b.mean).toBeGreaterThanOrEqual(0); expect(b.mean).toBeLessThanOrEqual(5);
    }
  });
  it('grows uncertainty while a skill is not practised, up to the prior, without moving the estimate', () => {
    const b = observe({ mean: 2.5, variance: PRIOR_VARIANCE }, { score: 3, difficulty: 'Intermediate', at });
    const later = current(b, new Date(at.getTime() + 30 * DAY));
    expect(later.variance).toBeCloseTo(b.variance + 0.3, 6); expect(later.mean).toBe(b.mean);
    expect(current(b, new Date(at.getTime() + 3650 * DAY)).variance).toBe(PRIOR_VARIANCE);
    expect(current(b, new Date(at.getTime() - DAY)).variance).toBe(b.variance);
  });
  it('lowers readiness for uncertain estimates and names levels', () => {
    expect(readiness([])).toBeNull();
    expect(readiness([{ mean: 4, variance: 0.04 }])).toBe(76);
    expect(readiness([{ mean: 4, variance: 1 }])).toBe(60);
    expect(readiness([{ mean: 0.5, variance: 1 }])).toBe(0);
    expect([1.4, 1.5, 2.5, 3.5].map(mean => level({ mean, variance: 1 }))).toEqual(['Needs work', 'Developing', 'Proficient', 'Strong']);
  });
  it('schedules spaced retests from FSRS grades: strong results wait longer', () => {
    expect([0, 1.4, 1.5, 2.4, 2.5, 3.9, 4, 5].map(gradeFor))
      .toEqual([Rating.Again, Rating.Again, Rating.Hard, Rating.Hard, Rating.Good, Rating.Good, Rating.Easy, Rating.Easy]);
    const easy = review(newCard(at), at, 5), again = review(newCard(at), at, 0);
    expect(easy.due.getTime()).toBeGreaterThan(again.due.getTime());
    expect(again.due.getTime()).toBeGreaterThan(at.getTime());
    expect(review(easy, easy.due, 5).due.getTime() - easy.due.getTime()).toBeGreaterThan(easy.due.getTime() - at.getTime());
  });
});

describe('evidence and replay', () => {
  const doc = (scores: Scores[], extra: Partial<{ type: 'Technical' | 'Behavioral' | 'HR'; topic: string; completedAt: Date }> = {}) =>
    ({ _id: oid(), type: 'Technical' as const, topic: 'DSA', difficulty: 'Intermediate' as const, completedAt: at, feedback: { answers: scores.map(answer) }, ...extra });
  it('turns one interview into one observation per skill, counting missing evidence as 0', () => {
    const evidence = interviewEvidence(doc([{ correctness: 4, depth: 2, approach: null, tradeoffs: null, clarity: 5 },
      { correctness: 2, depth: null, approach: null, tradeoffs: null, clarity: 3 }]));
    expect(Object.fromEntries(evidence)).toEqual({ 'technical.correctness': 3, 'technical.depth': 1, 'technical.approach': null,
      'technical.tradeoffs': null, 'technical.clarity': 4, 'topic.dsa': expect.closeTo((2.2 + 1) / 2, 6) });
    expect(interviewEvidence(doc([allScores('Technical', 3)], { topic: 'Python' })).has('topic.dsa')).toBe(false);
    expect([...interviewEvidence(doc([allScores('Behavioral', 3)], { type: 'Behavioral', topic: 'Behavioral' })).keys()])
      .toEqual(['behavioral.star', 'behavioral.ownership', 'behavioral.impact', 'behavioral.reflection', 'behavioral.relevance', 'topic.behavioral']);
    expect(interviewEvidence(doc([allScores('HR', null)], { type: 'HR', topic: 'General' })).get('topic.hr')).toBeNull();
  });
  it('replays in completion order whatever order interviews arrive in, and keeps a bounded history', () => {
    const docs = Array.from({ length: HISTORY_POINTS + 5 }, (_, i) => doc([allScores('Technical', i % 6)], { completedAt: new Date(at.getTime() + i * DAY) }));
    const forward = replay(docs), backward = replay([...docs].reverse());
    expect(backward.get('technical.depth')).toEqual(forward.get('technical.depth'));
    expect(forward.get('technical.depth')!.observations).toBe(HISTORY_POINTS + 5);
    expect(forward.get('technical.depth')!.history).toHaveLength(HISTORY_POINTS);
    expect(forward.get('technical.depth')!.history.at(-1)!.interviewId).toEqual(docs.at(-1)!._id);
  });
});

describe('drill selection', () => {
  const now = new Date(at.getTime() + 10 * DAY);
  const past = new Date(at.getTime() + DAY), future = new Date(at.getTime() + 30 * DAY);
  it('picks a skill due for a spaced retest before the weakest one', () => {
    const states = new Map([['technical.correctness', state(4, 0.1, past)], ['technical.clarity', state(1, 0.1, future)]]);
    const drill = selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now })!;
    expect(drill).toMatchObject({ skillId: 'technical.correctness', kind: 'retest', config: { type: 'Technical', topic: 'DSA', difficulty: 'Advanced',
      totalQuestions: 2, timeLimitSeconds: 180, focusSkills: ['technical.correctness'], purpose: 'drill', mode: 'ai', role: 'Developer' } });
    expect(drill.reason).toMatch(/due for a spaced retest/);
  });
  it('gives a first estimate for a focus area with no practice, ignoring retests outside the focus', () => {
    const states = new Map([['technical.correctness', state(4, 0.1, past)]]);
    const drill = selectDrill({ states, focusTypes: ['Behavioral'], dailyMinutes: 20, role: 'Developer', now })!;
    expect(drill).toMatchObject({ skillId: 'topic.behavioral', kind: 'baseline', config: { type: 'Behavioral', topic: 'Behavioral', difficulty: 'Intermediate',
      totalQuestions: 3, timeLimitSeconds: 300, focusSkills: ['topic.behavioral'] } });
  });
  it('picks the lowest plausible level, so an uncertain estimate is measured again', () => {
    const states = new Map([['technical.correctness', state(3, 0.04, future)], ['technical.clarity', state(2, 0.04, future)],
      ['technical.depth', state(2.6, 1, future)], ['topic.react', state(3, 0.2, future)], ['topic.dsa', state(2.5, 0.2, future)]]);
    const drill = selectDrill({ states, focusTypes: ['Technical'], dailyMinutes: 30, role: 'Developer', now })!;
    expect(drill).toMatchObject({ skillId: 'technical.depth', kind: 'weakest', config: { topic: 'DSA', difficulty: 'Intermediate', totalQuestions: 4 } });
  });
  it('works on a weaker foundation first, following prerequisite links', () => {
    const states = new Map([['technical.tradeoffs', state(1.5, 1, future)], ['technical.depth', state(1.2, 0.01, future)], ['technical.correctness', state(1, 0.01, future)]]);
    const drill = selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now })!;
    expect(drill).toMatchObject({ skillId: 'technical.correctness', kind: 'foundation', config: { difficulty: 'Beginner' } });
    expect(drill.reason).toMatch(/^Trade-off awareness builds on Technical correctness/);
    // A strong foundation is not substituted.
    states.set('technical.correctness', state(3, 0.01, future)); states.set('technical.depth', state(3, 0.01, future));
    expect(selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now })!.skillId).toBe('technical.tradeoffs');
  });
  it('adds the weakest competency to a topic drill, and builds a drill for a skill the learner chose', () => {
    const states = new Map([['topic.react', state(1, 0.05, past)], ['technical.clarity', state(1.5, 0.05, future)], ['technical.correctness', state(3, 0.05, future)]]);
    expect(selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now })!.config).toMatchObject({ topic: 'React', focusSkills: ['topic.react', 'technical.clarity'] });
    expect(selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now, skillId: 'hr.motivation' })).toMatchObject({ skillId: 'hr.motivation', kind: 'chosen',
      config: { type: 'HR', topic: 'General', difficulty: 'Intermediate', focusSkills: ['hr.motivation'] } });
    expect(selectDrill({ states, focusTypes: ['Technical'], role: 'Developer', now, skillId: 'nope' })).toBeNull();
  });
});

it('counts a practice streak in the learner\'s own calendar days', () => {
  const now = new Date('2026-10-25T06:00:00Z'); // 11:30 on 25 October in India
  const sessions = [new Date('2026-10-24T20:00:00Z'), new Date('2026-10-24T05:00:00Z'), new Date('2026-10-22T19:00:00Z')]; // 25, 24, 23 October in India
  expect(practiceStreak(sessions, now, 'Asia/Kolkata')).toEqual({ days: 3, practisedToday: true });
  expect(practiceStreak(sessions, now, 'UTC')).toEqual({ days: 1, practisedToday: false });
  expect(practiceStreak(sessions.slice(1), now, 'Asia/Kolkata')).toEqual({ days: 2, practisedToday: false });
  expect(practiceStreak([sessions[2]], now, 'Asia/Kolkata')).toEqual({ days: 0, practisedToday: false });
  expect(localDay(now, 'America/Los_Angeles')).toBe('2026-10-24');
});

it('runs a focused drill in a company style, then updates skill estimates and the overview', async () => {
  judgeScores = { correctness: 4, depth: 3, approach: 3, tradeoffs: null, clarity: 4 };
  const created = (await owner.post('/api/interviews').send({ role: 'Backend Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2,
    timeLimitSeconds: 180, mode: 'ai', purpose: 'drill', focusSkills: ['technical.tradeoffs', 'technical.tradeoffs'], style: 'product' }).expect(201)).body.interview;
  expect(created).toMatchObject({ purpose: 'drill', focusSkills: ['technical.tradeoffs'], style: 'product' });
  expect(created.currentQuestionGeneration.promptVersion).toBe('interviewer.v3+drill+style-product');
  expect(calls[0].system).toContain('Practice drill: ask questions that give the candidate a clear chance to show comparing alternatives and their costs.');
  expect(calls[0].system).toContain('product company');
  expect(calls[0].system).toContain('Never name, imitate or claim to represent a real company.');
  for (const questionIndex of [0, 1]) {
    await owner.post(`/api/interviews/${created._id}/answer`).send({ answer: ANSWER, questionIndex, submissionId: `drill-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  expect(calls[1].system).toContain('Practice drill'); // the worker keeps the focus for later questions
  const done = (await owner.get(`/api/interviews/${created._id}`).expect(200)).body.interview;
  expect(done.status).toBe('completed');
  // The worker rebuilt the estimates as soon as the interview was scored.
  const states = await SkillState.find({ userId: ownerId }).lean();
  expect(states.map(s => s.skillId).sort()).toEqual(['technical.approach', 'technical.clarity', 'technical.correctness', 'technical.depth', 'technical.tradeoffs', 'topic.dsa']);
  const overview = (await owner.get('/api/learning/overview').set(zone).expect(200)).body;
  const skill = (id: string) => overview.skills.find((s: any) => s.id === id);
  expect(skill('technical.correctness')).toMatchObject({ practised: true, observations: 1, level: 'Strong', lowConfidence: true, isDue: false });
  expect(skill('technical.tradeoffs').mean).toBeLessThan(skill('technical.correctness').mean);
  expect(skill('behavioral.star')).toEqual({ id: 'behavioral.star', label: 'STAR structure', kind: 'competency', type: 'Behavioral', foundations: [], practised: false });
  expect(overview.readiness).toBeGreaterThan(0);
  expect(overview.readinessByType).toMatchObject({ Behavioral: null, HR: null });
  expect(overview.streak).toEqual({ days: 1, practisedToday: true });
  expect(overview.drill).toMatchObject({ kind: 'baseline', config: { role: 'Backend Developer' } });
  expect(overview.skills).toHaveLength(SKILLS.length);
  // Another learner sees none of it.
  const theirs = (await other.get('/api/learning/overview').expect(200)).body;
  expect(theirs.skills.every((s: any) => !s.practised)).toBe(true); expect(theirs.readiness).toBeNull();
});

it('rejects drills and styles without AI, and focus skills that do not match the interview type', async () => {
  const base = { role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2 };
  for (const extra of [{ mode: 'practice', purpose: 'drill' }, { mode: 'practice', style: 'startup' }, { mode: 'practice', focusSkills: ['technical.depth'] }]) {
    expect((await owner.post('/api/interviews').send({ ...base, ...extra }).expect(400)).body.error).toBe('Drills and interview styles need AI mode.');
  }
  for (const focusSkills of [['behavioral.star'], ['made.up']]) {
    expect((await owner.post('/api/interviews').send({ ...base, mode: 'ai', focusSkills }).expect(400)).body.error).toBe('Choose practice skills that match the interview type.');
  }
  await owner.post('/api/interviews').send({ ...base, mode: 'ai', focusSkills: ['technical.depth', 'technical.clarity', 'technical.approach'] }).expect(400);
  await owner.post('/api/interviews').send({ ...base, mode: 'ai', style: 'famous-company' }).expect(400);
  await owner.post('/api/interviews').send({ ...base, mode: 'practice', style: 'general' }).expect(201);
  expect(calls).toHaveLength(0);
});

it('keeps rebuilt estimates exact after re-reviews and repeats, and never lets an older rebuild win', async () => {
  const first = await seedScored(ownerId, { scores: [allScores('Technical', 2), allScores('Technical', 3)], completedAt: new Date(Date.now() - 3 * DAY) });
  await seedScored(ownerId, { scores: [allScores('Technical', 4)], completedAt: new Date(Date.now() - DAY) });
  await refreshSkills(ownerId);
  const snapshot = async () => (await SkillState.find({ userId: ownerId }).sort({ skillId: 1 }).lean()).map(({ skillId, mean, variance, observations, card, history }) => ({ skillId, mean, variance, observations, card, history }));
  const once = await snapshot();
  await refreshSkills(ownerId);
  expect(await snapshot()).toEqual(once);
  expect(once.find(s => s.skillId === 'technical.depth')!.observations).toBe(2);
  // A second review revises a rating: the overview notices the newer interview update and rebuilds.
  await new Promise(resolve => setTimeout(resolve, 5));
  await Interview.updateOne({ _id: first._id }, { $set: { 'feedback.answers.0.criteria.1.score': 5 } });
  const depth = (await owner.get('/api/learning/overview').set(zone).expect(200)).body.skills.find((s: any) => s.id === 'technical.depth');
  expect(depth.mean).toBeGreaterThan(once.find(s => s.skillId === 'technical.depth')!.mean);
  // A state written from newer data is kept when a slower rebuild finishes later.
  await SkillState.updateOne({ userId: ownerId, skillId: 'technical.clarity' }, { $set: { mean: 4.9, basisAt: new Date(Date.now() + DAY) } });
  await refreshSkills(ownerId);
  expect((await SkillState.findOne({ userId: ownerId, skillId: 'technical.clarity' }))!.mean).toBe(4.9);
  // With no scored interviews left there is nothing to keep.
  await Interview.deleteMany({ userId: ownerId });
  await SkillState.updateOne({ userId: ownerId, skillId: 'technical.clarity' }, { $set: { basisAt: new Date(0) } });
  await refreshSkills(ownerId);
  expect(await SkillState.countDocuments({ userId: ownerId })).toBe(0);
});

it('saves a study plan in the learner\'s time zone and focuses drills and readiness on it', async () => {
  const inDays = (n: number) => localDay(new Date(Date.now() + n * DAY), 'Asia/Kolkata');
  const saved = (await owner.put('/api/learning/plan').set(zone).send({ interviewDate: inDays(30), focusTypes: ['Behavioral', 'Behavioral'], dailyMinutes: 20 }).expect(200)).body.plan;
  expect(saved).toEqual({ interviewDate: inDays(30), daysLeft: 30, focusTypes: ['Behavioral'], dailyMinutes: 20 });
  for (const body of [{ interviewDate: inDays(-1), focusTypes: ['HR'], dailyMinutes: 10 }, { interviewDate: inDays(366), focusTypes: ['HR'], dailyMinutes: 10 },
    { interviewDate: '2026-02-31', focusTypes: ['HR'], dailyMinutes: 10 }, { interviewDate: inDays(5), focusTypes: [], dailyMinutes: 10 },
    { interviewDate: inDays(5), focusTypes: ['HR'], dailyMinutes: 15 }, { interviewDate: inDays(5), focusTypes: ['Coding'], dailyMinutes: 10 }]) {
    await owner.put('/api/learning/plan').set(zone).send(body).expect(400);
  }
  await seedScored(ownerId, { scores: [allScores('Technical', 5)], completedAt: new Date(Date.now() - DAY) });
  const overview = (await owner.get('/api/learning/overview').set({ 'x-time-zone': 'Not/AZone' }).expect(200)).body;
  expect(overview.plan).toMatchObject({ focusTypes: ['Behavioral'], dailyMinutes: 20, daysLeft: 30 });
  expect(overview.readiness).toBeNull(); // no behavioral evidence yet
  expect(overview.readinessByType.Technical).toBeGreaterThan(0);
  expect(overview.drill).toMatchObject({ kind: 'baseline', config: { type: 'Behavioral', totalQuestions: 3, timeLimitSeconds: 300 } });
  await owner.delete('/api/learning/plan').expect(200);
  expect((await owner.get('/api/learning/overview').expect(200)).body.plan).toBeNull();
});

it('reports weekly sessions and the skills that moved most', async () => {
  await seedScored(ownerId, { scores: [allScores('Technical', 1)], completedAt: new Date(Date.now() - 40 * DAY) });
  await seedScored(ownerId, { scores: [allScores('Technical', 5)], completedAt: new Date(Date.now() - 3 * DAY), purpose: 'drill', score: 100 });
  await Interview.create({ userId: ownerId, role: 'Developer', type: 'HR', difficulty: 'Beginner', topic: 'General', totalQuestions: 2, currentQuestion: 'Done.',
    currentTopic: 'General', mode: 'practice', status: 'completed', completedAt: new Date(Date.now() - 2 * DAY),
    feedback: { source: 'practice', score: null, summary: 'Practice.', strengths: [], improvements: [], nextSteps: [] } });
  const report = (await owner.get('/api/learning/report?weeks=2').set(zone).expect(200)).body;
  expect(report.weeks).toHaveLength(2);
  expect(report.weeks[0]).toMatchObject({ drills: 1, interviews: 1, averageScore: 100 });
  expect(report.weeks[1]).toMatchObject({ drills: 0, interviews: 0, averageScore: null });
  expect(report.gains[0]).toMatchObject({ sinceFirstPractice: false });
  expect(report.gains[0].to).toBeGreaterThan(report.gains[0].from);
  expect(report.declines).toEqual([]);
  expect((await owner.get('/api/learning/report?weeks=50').expect(200)).body.weeks).toHaveLength(4);
});

it('builds a drill for a chosen skill, and offers none when AI scoring is off', async () => {
  expect((await owner.get('/api/learning/drill?skillId=hr.motivation').expect(200)).body.drill).toMatchObject({ kind: 'chosen', config: { type: 'HR', topic: 'General' } });
  await owner.get('/api/learning/drill?skillId=bad.skill').expect(400);
  vi.stubEnv('AI_PROVIDER', 'practice');
  try {
    expect((await owner.get('/api/learning/overview').expect(200)).body).toMatchObject({ aiAvailable: false, drill: null });
  } finally { vi.stubEnv('AI_PROVIDER', 'compatible'); }
  await request(app).get('/api/learning/overview').expect(401);
});
