import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';
import { analyzeDelivery, countFillers, countWords } from '../src/services/delivery.js';
import { verifyStar } from '../src/services/evidence.js';

process.env.JWT_SECRET = 'delivery-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
const SPOKEN = 'Um, so basically I rebuilt the cache, you know. It was, like, ten times faster after that change went live.';
const ANSWER = 'In my final-year project our demo server crashed a day before the review. I had to restore it before the panel met. I rebuilt it from backups and wrote a recovery script.';
let transcript = SPOKEN;
let star: 'good' | 'invented' | 'fail' = 'good';
const starCalls: { system: string; input: any }[] = [];

const gateway = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/audio/transcriptions')) { res.end(JSON.stringify({ text: transcript })); return; }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = JSON.parse(parsed.messages[1].content);
  let value: unknown;
  if (input.starParts) {
    starCalls.push({ system: parsed.messages[0].content, input });
    if (star === 'fail') { res.statusCode = 500; res.end(JSON.stringify({ error: { message: 'upstream failure echoing the answer' } })); return; }
    value = { parts: [
      { part: 'situation', quote: 'our demo server crashed a day before the review', tip: null },
      { part: 'task', quote: star === 'invented' ? 'I led a team of ten engineers' : 'I had to restore it before the panel met', tip: 'ignored when found' },
      { part: 'action', quote: 'I rebuilt it from backups', tip: null },
      { part: 'result', quote: null, tip: 'Add how the review went, if you know it.' }] };
  } else if (input.turns) {
    value = { answers: input.turns.map((turn: any) => ({ questionIndex: turn.questionIndex,
      criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 3, quote: turn.answer, rationale: 'Some evidence.', improvement: 'Be specific.' })) })) };
  } else value = { question: `Tell me about a time you recovered from a setback, question ${input.questionNumber}.`, topic: 'Behavioral' };
  res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } }));
});

let mongo: MongoMemoryServer;
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);
const start = (type = 'Behavioral') => owner.post('/api/interviews').send({ role: 'Developer', type, difficulty: 'Intermediate',
  topic: type === 'Behavioral' ? 'Behavioral' : 'DSA', totalQuestions: 2, mode: 'ai' }).expect(201).then(r => r.body.interview._id as string);
const transcribe = (id: string, ms?: string) => {
  const req = owner.post(`/api/interviews/${id}/transcribe`).set('Content-Type', 'audio/webm');
  return (ms === undefined ? req : req.set('X-Recording-Ms', ms)).send(webm);
};
async function completed(type = 'Behavioral') {
  const id = await start(type);
  for (let questionIndex = 0; questionIndex < 2; questionIndex++) {
    await owner.post(`/api/interviews/${id}/answer`).send({ answer: ANSWER, questionIndex, submissionId: `${id}-${questionIndex}` }).expect(202);
    await processNextInterviewJob();
  }
  return id;
}

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'compatible'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEWER_MODEL', 'iq-interviewer'); vi.stubEnv('JUDGE_MODEL', 'iq-judge'); vi.stubEnv('TRANSCRIPTION_MODEL', 'iq-transcriber');
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Delivery Tester', email: 'delivery@example.test', password: 'test-password' }).expect(201);
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
}, 120_000);
beforeEach(async () => {
  transcript = SPOKEN; star = 'good'; starCalls.length = 0; await Interview.deleteMany({});
  await owner.patch('/api/account/preferences').send({ deliveryMetrics: true }).expect(200);
});
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); });

it('counts words, pace and fillers, including Hinglish, and reports pace only for ten seconds or more', () => {
  expect(countWords('  I rebuilt   the cache — twice. ')).toBe(5);
  expect(countWords('मतलब, हमने cache बदला।')).toBe(4);
  expect(analyzeDelivery(SPOKEN, 12)).toEqual({ seconds: 12, words: 20, wordsPerMinute: 100, version: 'delivery.v1',
    fillers: [{ term: 'basically', count: 1 }, { term: 'like', count: 1 }, { term: 'um', count: 1 }, { term: 'you know', count: 1 }] });
  expect(analyzeDelivery(SPOKEN, 9).wordsPerMinute).toBeNull();
  expect(countFillers('Matlab, humne pehle API banaya. Iska matlab hai ki latency kam hui.')).toEqual([{ term: 'matlab', count: 1 }]);
  expect(countFillers('Do you know how a hash map works? I would like to explain. We used MATLAB.')).toEqual([]);
});

// Synthetic labelled sentences, including hard negatives and fillers the rules deliberately miss. A real,
// consented transcript set is still needed for the B4 exit gate.
it('keeps filler precision at or above 0.9 on the labelled synthetic set', () => {
  const path = fileURLToPath(new URL('../../calibration/fillers.synthetic.v1.jsonl', import.meta.url));
  let tp = 0, fp = 0, fn = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const item = JSON.parse(line) as { text: string; fillers: Record<string, number> };
    const found = Object.fromEntries(countFillers(item.text).map(f => [f.term, f.count]));
    for (const term of new Set([...Object.keys(found), ...Object.keys(item.fillers)])) {
      const predicted = found[term] ?? 0, labelled = item.fillers[term] ?? 0;
      tp += Math.min(predicted, labelled); fp += Math.max(0, predicted - labelled); fn += Math.max(0, labelled - predicted);
    }
  }
  expect(tp / (tp + fp)).toBeGreaterThanOrEqual(0.9);
  expect(tp / (tp + fn)).toBeGreaterThan(0.8);
});

it('records delivery counts for the question on screen, never the transcript, and keeps them bounded', async () => {
  const id = await start();
  const response = await transcribe(id, '12400').expect(200);
  expect(response.body).toEqual({ transcript: SPOKEN, delivery: analyzeDelivery(SPOKEN, 12) });
  let saved = await Interview.findById(id).lean();
  expect(saved!.deliveryClips).toEqual([expect.objectContaining({ questionIndex: 0, seconds: 12, words: 20, version: 'delivery.v1',
    fillers: [{ term: 'basically', count: 1 }, { term: 'like', count: 1 }, { term: 'um', count: 1 }, { term: 'you know', count: 1 }] })]);
  expect(JSON.stringify(saved!.deliveryClips)).not.toContain('rebuilt');

  for (const ms of [undefined, 'abc', '500', '400000', '1.5']) {
    expect((await transcribe(id, ms).expect(200)).body.delivery).toBeUndefined();
  }
  await owner.post(`/api/interviews/${id}/answer`).send({ answer: 'I rebuilt the cache and it got faster.', questionIndex: 0, submissionId: 'd-0' }).expect(202);
  await processNextInterviewJob();
  await transcribe(id, '30000').expect(200);
  saved = await Interview.findById(id).lean();
  expect(saved!.deliveryClips.map(c => c.questionIndex)).toEqual([0, 1]);

  await Interview.updateOne({ _id: id }, { $set: { deliveryClips: Array.from({ length: 50 }, () => ({ questionIndex: 1, seconds: 20, words: 40, fillers: [], version: 'delivery.v1' })) } });
  await transcribe(id, '15000').expect(200);
  saved = await Interview.findById(id).lean();
  expect(saved!.deliveryClips).toHaveLength(50);
  expect(saved!.deliveryClips.at(-1)!.seconds).toBe(15);
});

it('stops measuring when the candidate turns delivery feedback off', async () => {
  const off = await owner.patch('/api/account/preferences').send({ deliveryMetrics: false }).expect(200);
  expect(off.body.user.preferences).toEqual({ deliveryMetrics: false });
  expect((await owner.get('/api/auth/me').expect(200)).body.user.preferences).toEqual({ deliveryMetrics: false });
  await owner.patch('/api/account/preferences').send({ deliveryMetrics: 'no' }).expect(400);
  await owner.patch('/api/account/preferences').send({ deliveryMetrics: false, extra: 1 }).expect(400);
  const id = await start();
  const response = await transcribe(id, '12000').expect(200);
  expect(response.body).toEqual({ transcript: SPOKEN });
  expect((await Interview.findById(id).lean())!.deliveryClips).toEqual([]);
});

it('checks STAR coverage with verified quotes, once per behavioral answer, without touching scores', async () => {
  const id = await completed();
  const before = (await owner.get(`/api/interviews/${id}`).expect(200)).body.interview.feedback;
  const created = await owner.post(`/api/interviews/${id}/star`).send({ questionIndex: 1 }).expect(201);
  const check = created.body.interview.starChecks[0];
  const at = (quote: string) => ({ quote, start: ANSWER.indexOf(quote), end: ANSWER.indexOf(quote) + quote.length });
  expect(check).toMatchObject({ questionIndex: 1, generation: { promptVersion: 'star-coverage.v1', model: 'iq-judge' } });
  expect(check.parts).toEqual([
    { part: 'situation', status: 'found', ...at('our demo server crashed a day before the review') },
    { part: 'task', status: 'found', ...at('I had to restore it before the panel met') },
    { part: 'action', status: 'found', ...at('I rebuilt it from backups') },
    { part: 'result', status: 'missing', tip: 'Add how the review went, if you know it.' }]);
  expect(created.body.interview.feedback).toEqual(before);
  expect(starCalls[0].input).toMatchObject({ answer: ANSWER, interviewType: 'Behavioral' });
  expect(starCalls[0].system).toMatch(/untrusted data/);
  expect(await AIUsage.countDocuments({ interviewId: id, promptVersion: 'star-coverage.v1', status: 'succeeded' })).toBe(1);

  expect((await owner.post(`/api/interviews/${id}/star`).send({ questionIndex: 1 }).expect(200)).body.replayed).toBe(true);
  expect(starCalls).toHaveLength(1);
});

it('marks a STAR part missing when its quote is not in the answer, and stores nothing on failure', async () => {
  expect(verifyStar({ parts: ['situation', 'task', 'action', 'result'].map(part => ({ part: part as any, quote: '  ', tip: null })) }, ANSWER)
    .every(p => p.status === 'missing')).toBe(true);
  expect(() => verifyStar({ parts: ['situation', 'situation', 'action', 'result'].map(part => ({ part: part as any, quote: null, tip: null })) }, ANSWER)).toThrow();
  star = 'invented';
  const id = await completed();
  const parts = (await owner.post(`/api/interviews/${id}/star`).send({ questionIndex: 0 }).expect(201)).body.interview.starChecks[0].parts;
  expect(parts[1]).toEqual({ part: 'task', status: 'missing', tip: 'ignored when found' });
  expect(JSON.stringify(parts)).not.toContain('team of ten');

  star = 'fail';
  const failed = await owner.post(`/api/interviews/${id}/star`).send({ questionIndex: 1 }).expect(502);
  expect(failed.body.error).not.toMatch(/echoing/);
  expect((await Interview.findById(id).lean())!.starChecks).toHaveLength(1);
});

it('offers STAR checks only for answers in completed AI behavioral interviews', async () => {
  const technical = await completed('Technical');
  await owner.post(`/api/interviews/${technical}/star`).send({ questionIndex: 0 }).expect(409);
  const unfinished = await start();
  await owner.post(`/api/interviews/${unfinished}/star`).send({ questionIndex: 0 }).expect(409);
  const done = await completed();
  await owner.post(`/api/interviews/${done}/star`).send({ questionIndex: 4 }).expect(409);
  await owner.post(`/api/interviews/${done}/star`).send({ questionIndex: 9 }).expect(400);
  await request(app).post(`/api/interviews/${done}/star`).send({ questionIndex: 0 }).expect(401);
  expect(starCalls).toHaveLength(0);
});
