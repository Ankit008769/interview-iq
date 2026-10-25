import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { CandidateDocument } from '../src/models/CandidateDocument.js';
import { Interview } from '../src/models/Interview.js';
import { REMOVED_QUESTION } from '../src/services/documents.js';

process.env.JWT_SECRET = 'grounding-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app), other = request.agent(app);

const RESUME_LINE = 'Built a payments service in Node.js handling 2,000 requests per minute.';
const resumeText = `${RESUME_LINE}\r\nLed the move from REST polling to webhooks for order updates.\r\nSkills: TypeScript, MongoDB, Redis.`;
const JD_LINE = 'Experience designing idempotent APIs for financial transactions.';
const jdText = `We are hiring a backend engineer.\n${JD_LINE}\nComfortable with on-call rotations.`;

type Source = 'resume' | 'unverified' | 'long' | 'unsupplied' | 'none';
let source: Source = 'resume';
let duringQuestion: (() => Promise<void>) | undefined;
const calls: { system: string; input: any }[] = [];
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const parsed = JSON.parse(body);
  const input = JSON.parse(parsed.messages[1].content);
  calls.push({ system: parsed.messages[0].content, input });
  let value: unknown;
  if (input.turns) {
    value = { overall: { summary: 'A reasonable start with room for detail.', strengths: [], improvements: ['Add concrete examples.'], nextSteps: ['Practise one more question on this topic.'] }, answers: input.turns.map((turn: any) => ({ questionIndex: turn.questionIndex, verdict: 'partly_correct', verdictReason: 'It covers part of the question.', keyPoints: ['State the approach', 'Give the complexity'], tip: 'Add a concrete example.',
      criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 3, quote: turn.answer, rationale: 'Some evidence.', improvement: 'Be specific.' })) })) };
  } else if (input.documents) {
    const hook = duringQuestion; duringQuestion = undefined; await hook?.();
    const quote = { resume: RESUME_LINE, unverified: 'Built a payments platform at a bank.', long: resumeText.repeat(3).replace(/\r/g, ''),
      unsupplied: JD_LINE, none: '' }[source];
    value = { question: `Walk me through the payments service you built, question ${input.questionNumber}.`, topic: 'Projects',
      source: source === 'none' ? null : { document: source === 'unsupplied' ? 'job_description' : 'resume', quote } };
  } else value = { question: `Explain your API design approach, question ${input.questionNumber}.`, topic: 'APIs' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
async function consent(agent: typeof owner) {
  const { disclosure } = (await agent.get('/api/account/ai-consent').expect(200)).body;
  await agent.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
  return disclosure;
}
const addDocument = async (agent: typeof owner, kind: 'resume' | 'job_description', text: string, title = kind === 'resume' ? 'My resume' : 'Backend JD') =>
  (await agent.post('/api/documents').send({ kind, title, text }).expect(201)).body.document;
const start = (documentIds: string[], extra: Record<string, unknown> = {}, agent = owner) => agent.post('/api/interviews')
  .send({ role: 'Backend Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'Node.js', totalQuestions: 3, mode: 'ai', documentIds, ...extra });
async function answer(id: string, questionIndex: number, agent = owner) {
  await agent.post(`/api/interviews/${id}/answer`).send({ answer: `I designed the retries so a repeated webhook is applied once (${questionIndex}).`,
    questionIndex, submissionId: `${id}-${questionIndex}` }).expect(202);
  await processNextInterviewJob();
  return (await agent.get(`/api/interviews/${id}`).expect(200)).body.interview;
}

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Grounding Tester', email: 'grounding@example.test', password: 'test-password' }).expect(201);
  await other.post('/api/auth/register').send({ name: 'Other Tester', email: 'other-grounding@example.test', password: 'test-password' }).expect(201);
  await consent(owner); await consent(other);
}, 120_000);
beforeEach(async () => {
  source = 'resume'; duringQuestion = undefined; calls.length = 0;
  await Promise.all([Interview.deleteMany({}), CandidateDocument.deleteMany({})]);
});
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('discloses that chosen documents are sent to the provider', async () => {
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  expect(disclosure.documents).toMatch(/resume or job description/);
  expect(disclosure.policy).toBe('2026-10-25.v2');
});

it('keeps documents private to their owner, validates them and limits how many are kept', async () => {
  const saved = await addDocument(owner, 'resume', resumeText);
  expect(saved).toMatchObject({ kind: 'resume', title: 'My resume', text: resumeText.replace(/\r\n/g, '\n'), chars: resumeText.length - 2 });
  const list = (await owner.get('/api/documents').expect(200)).body;
  expect(list.documents).toEqual([{ id: saved.id, kind: 'resume', title: 'My resume', chars: saved.chars, createdAt: saved.createdAt }]);
  expect(list.limits).toEqual({ maxDocuments: 10, maxChars: 12000 });
  expect((await owner.get(`/api/documents/${saved.id}`).expect(200)).body.document.text).toBe(saved.text);

  for (const body of [{ kind: 'resume', title: 'Short', text: 'Too short to be a resume.' }, { kind: 'cover_letter', title: 'Letter', text: resumeText },
    { kind: 'resume', title: 'Huge', text: 'x'.repeat(12001) }, { kind: 'resume', title: 'Binary', text: `${resumeText}\u0000` },
    { kind: 'resume', title: ' ', text: resumeText }]) await owner.post('/api/documents').send(body).expect(400);

  await other.get(`/api/documents/${saved.id}`).expect(404);
  await other.delete(`/api/documents/${saved.id}`).expect(404);
  expect((await other.get('/api/documents').expect(200)).body.documents).toEqual([]);
  await owner.get('/api/documents/not-an-id').expect(404);

  for (let i = 1; i < 10; i++) await addDocument(owner, 'job_description', jdText, `JD ${i}`);
  const full = await owner.post('/api/documents').send({ kind: 'resume', title: 'Eleventh', text: resumeText }).expect(409);
  expect(full.body.error).toMatch(/up to 10 documents/);
  expect(await CandidateDocument.countDocuments()).toBe(10);
});

it('tailors questions to the chosen documents and shows the verified line each came from', async () => {
  const resume = await addDocument(owner, 'resume', resumeText), jd = await addDocument(owner, 'job_description', jdText);
  const created = (await start([jd.id, resume.id]).expect(201)).body.interview;
  const text = resumeText.replace(/\r\n/g, '\n');
  expect(created.documentIds).toEqual([resume.id, jd.id]);
  expect(created.currentQuestionGrounding).toEqual({ documentIds: [resume.id, jd.id],
    source: { documentId: resume.id, kind: 'resume', quote: RESUME_LINE, start: text.indexOf(RESUME_LINE), end: text.indexOf(RESUME_LINE) + RESUME_LINE.length } });
  expect(calls[0].input.documents).toEqual([{ kind: 'resume', text }, { kind: 'job_description', text: jdText }]);
  expect(JSON.stringify(calls[0].input)).not.toContain('My resume');
  expect(calls[0].system).toMatch(/untrusted data/);
  expect(calls[0].system).toMatch(/caste/);
  expect(await AIUsage.countDocuments({ interviewId: created._id, promptVersion: 'interviewer-grounded.v2', status: 'succeeded' })).toBe(1);

  let interview = await answer(created._id, 0);
  expect(interview.turns[0].grounding.source.quote).toBe(RESUME_LINE);
  expect(interview.currentQuestion).toMatch(/question 2/);
  expect(interview.currentQuestionGrounding.source.kind).toBe('resume');
  interview = await answer(created._id, 1);
  interview = await answer(created._id, 2);
  expect(interview.status).toBe('completed');
  const judge = calls.at(-1)!;
  expect(judge.input.turns).toHaveLength(3);
  expect(judge.input.documents).toBeUndefined();
  expect(JSON.stringify(judge.input)).not.toContain('Skills: TypeScript');
});

it('accepts only the caller\'s documents, in AI interviews, with at most one of each kind', async () => {
  const resume = await addDocument(owner, 'resume', resumeText), second = await addDocument(owner, 'resume', resumeText, 'Old resume');
  const theirs = await addDocument(other, 'job_description', jdText);
  expect((await start([resume.id], { mode: 'practice' }).expect(400)).body.error).toMatch(/needs an AI interview/);
  expect((await start([resume.id, theirs.id]).expect(400)).body.error).toMatch(/your saved/);
  expect((await start([resume.id, second.id]).expect(400)).body.error).toMatch(/at most one resume/);
  await start([resume.id, resume.id, resume.id]).expect(400);
  expect(calls).toHaveLength(0);
  expect(await Interview.countDocuments()).toBe(0);
});

it('shows no source line unless the passage is found verbatim in a supplied document', async () => {
  const resume = await addDocument(owner, 'resume', resumeText);
  for (const mode of ['unverified', 'long', 'unsupplied', 'none'] as const) {
    source = mode;
    const grounding = (await start([resume.id]).expect(201)).body.interview.currentQuestionGrounding;
    expect(grounding).toEqual({ documentIds: [resume.id] });
  }
});

it('deleting a document removes every question generated from it and stops tailoring', async () => {
  const resume = await addDocument(owner, 'resume', resumeText);
  const theirs = await addDocument(other, 'resume', resumeText);
  const tailored = (await start([resume.id]).expect(201)).body.interview;
  await answer(tailored._id, 0);
  const plain = (await start([]).expect(201)).body.interview;
  const untouched = (await start([theirs.id], {}, other).expect(201)).body.interview;

  await owner.delete(`/api/documents/${resume.id}`).expect(200);
  await owner.get(`/api/documents/${resume.id}`).expect(404);
  await owner.delete(`/api/documents/${resume.id}`).expect(404);
  let interview = (await owner.get(`/api/interviews/${tailored._id}`).expect(200)).body.interview;
  expect(interview.documentIds).toEqual([]);
  expect(interview.turns[0].question).toBe(REMOVED_QUESTION);
  expect(interview.turns[0].grounding).toBeUndefined();
  expect(interview.turns[0].answer).toMatch(/applied once/);
  expect(interview.currentQuestion).toBe(REMOVED_QUESTION);
  expect(interview.currentQuestionGrounding).toBeUndefined();
  expect(JSON.stringify(interview)).not.toMatch(/payments service|2,000 requests/);
  expect((await owner.get(`/api/interviews/${plain._id}`).expect(200)).body.interview.currentQuestion).toMatch(/API design/);
  expect((await other.get(`/api/interviews/${untouched._id}`).expect(200)).body.interview.currentQuestionGrounding.source.quote).toBe(RESUME_LINE);

  calls.length = 0;
  interview = await answer(tailored._id, 1);
  expect(calls[0].input.documents).toBeUndefined();
  expect(interview.currentQuestion).toMatch(/API design approach, question 3/);
  expect(interview.currentQuestionGrounding).toBeUndefined();
});

it('a document deleted while a follow-up is being generated never lands in the interview', async () => {
  const resume = await addDocument(owner, 'resume', resumeText);
  const created = (await start([resume.id]).expect(201)).body.interview;
  await owner.post(`/api/interviews/${created._id}/answer`).send({ answer: 'I made each webhook handler idempotent with a key.', questionIndex: 0, submissionId: 'race-0' }).expect(202);
  duringQuestion = async () => { await owner.delete(`/api/documents/${resume.id}`).expect(200); };
  await processNextInterviewJob();
  let saved = await Interview.findById(created._id).lean();
  expect(saved).toMatchObject({ processingState: 'queued', jobAttempts: 0, currentQuestion: REMOVED_QUESTION, documentIds: [] });
  expect(saved!.turns[0].question).toBe(REMOVED_QUESTION);
  await processNextInterviewJob();
  saved = await Interview.findById(created._id).lean();
  expect(saved).toMatchObject({ processingState: 'ready', currentQuestion: 'Explain your API design approach, question 2.' });
  expect(saved!.currentQuestionGrounding).toBeUndefined();
});

it('a document deleted while the first question is being generated is removed from the new interview', async () => {
  const resume = await addDocument(owner, 'resume', resumeText);
  duringQuestion = async () => { await owner.delete(`/api/documents/${resume.id}`).expect(200); };
  const created = (await start([resume.id]).expect(201)).body.interview;
  expect(created).toMatchObject({ currentQuestion: REMOVED_QUESTION, documentIds: [] });
  expect(created.currentQuestionGrounding).toBeUndefined();
  expect(await CandidateDocument.countDocuments()).toBe(0);
});

it('an interrupted deletion stops new use at once and a repeated delete finishes it', async () => {
  const resume = await addDocument(owner, 'resume', resumeText);
  const created = (await start([resume.id]).expect(201)).body.interview;
  await CandidateDocument.updateOne({ _id: resume.id }, { $set: { deletingAt: new Date() } });
  expect((await owner.get('/api/documents').expect(200)).body.documents[0].deleting).toBe(true);
  await start([resume.id]).expect(400);
  await owner.delete(`/api/documents/${resume.id}`).expect(200);
  expect((await owner.get(`/api/interviews/${created._id}`).expect(200)).body.interview.currentQuestion).toBe(REMOVED_QUESTION);
});
