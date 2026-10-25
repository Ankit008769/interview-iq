import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { AIUsage } from '../src/models/AIUsage.js';
import { Interview } from '../src/models/Interview.js';
import { providerConfig, workLeaseMs } from '../src/services/providerConfig.js';
import { estimateCost } from '../src/services/usageCost.js';
import { buildAutoReport, concordance, spearman } from '../src/calibration/auto.js';
import { criteriaFor, datasetHash, parseItems, type ModelRating } from '../src/calibration/dataset.js';
import { RUBRIC_VERSION, rubricFor } from '../src/services/rubrics.js';
import { evidenceSchemaFor } from '../src/services/evidence.js';
import { runJudge } from '../src/calibration/judge.js';

process.env.JWT_SECRET = 'local-model-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const { processNextInterviewJob } = await import('../src/services/interviewJobs.js');
const owner = request.agent(app);
const bodies: any[] = [];
let repeat = false;
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.url === '/api/tags') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b' }, { name: 'gemma4:e2b' }] })); return; }
  const parsed = JSON.parse(body); bodies.push(parsed);
  const input = JSON.parse(parsed.messages[1].content);
  const value = input.turns
    ? { overall: { summary: 'A reasonable start with room for detail.', strengths: [], improvements: ['Add concrete examples.'], nextSteps: ['Practise one more question on this topic.'] }, answers: input.turns.map((t: any) => ({ questionIndex: t.questionIndex, verdict: 'partly_correct', verdictReason: 'It covers part of the question.', keyPoints: ['State the approach', 'Give the complexity'], tip: 'Add a concrete example.', criteria: input.rubric.criteria.map((c: any) => ({ criterionId: c.id, score: 2, quote: t.answer, rationale: 'r', improvement: 'i' })) })) }
    : { question: repeat && input.avoidQuestions?.length ? input.avoidQuestions[0] : `Fresh question ${bodies.length}.`, topic: 'DSA' };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'local', object: 'chat.completion', created: 1, model: parsed.model,
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } }));
});
// Stand-in for deploy/whisper: records what it received and answers like the real server.
const sttUploads: string[] = [];
const stt = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') { res.end(JSON.stringify({ ok: true, model: 'small' })); return; }
  sttUploads.push(Buffer.concat(chunks).toString('latin1'));
  res.end(JSON.stringify({ text: 'I would use a hash map.' }));
});
let mongo: MongoMemoryServer;
const start = () => owner.post('/api/interviews').send({ role: 'Developer', type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2, mode: 'ai' });

beforeAll(async () => {
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => stt.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('AI_PROVIDER', 'local'); vi.stubEnv('LLM_BASE_URL', `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`);
  vi.stubEnv('INTERVIEW_WRITES_PER_15_MIN', '500');
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  await owner.post('/api/auth/register').send({ name: 'Local Tester', email: 'local@example.test', password: 'test-password' }).expect(201);
}, 120_000);
beforeEach(async () => { bodies.length = 0; repeat = false; await Interview.deleteMany({}); });
afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); gateway.close(); stt.close(); });

it('configures a local model on loopback with CPU-friendly timeouts and leases', () => {
  vi.stubEnv('AI_MODEL', 'gpt-4o-mini');
  expect(providerConfig()).toMatchObject({ provider: 'local', interviewerModel: 'qwen3.5:4b', judgeModel: 'qwen3.5:4b', timeoutMs: 1_200_000, key: undefined });
  expect(workLeaseMs()).toBe(1_260_000);
  vi.stubEnv('JUDGE_MODEL', 'gemma4:e2b'); vi.stubEnv('LLM_TIMEOUT_MS', '120000');
  expect(providerConfig()).toMatchObject({ judgeModel: 'gemma4:e2b', interviewerModel: 'qwen3.5:4b', timeoutMs: 120_000 });
  expect(workLeaseMs()).toBe(180_000);
  vi.stubEnv('LLM_TIMEOUT_MS', '10'); expect(() => providerConfig()).toThrow(/LLM_TIMEOUT_MS/);
  vi.stubEnv('LLM_TIMEOUT_MS', ''); vi.stubEnv('JUDGE_MODEL', '');
  const url = process.env.LLM_BASE_URL!;
  vi.stubEnv('LLM_BASE_URL', 'https://models.example.com/v1'); expect(() => providerConfig()).toThrow(/on this machine/);
  vi.stubEnv('LLM_BASE_URL', url);
  vi.stubEnv('AI_PROVIDER', 'practice'); expect(workLeaseMs()).toBe(120_000);
  vi.stubEnv('AI_PROVIDER', 'local');
  expect(estimateCost([], { provider: 'local', model: 'qwen3.5:4b', slot: 'judge', inputTokens: 10, outputTokens: 5, at: new Date() }))
    .toEqual({ amountUsd: 0, reason: 'local_model' });
});

it('reports whether the local models are installed in the health check', async () => {
  expect((await request(app).get('/api/health').expect(200)).body).toEqual({ ok: true, database: 'connected', aiMode: 'ai', model: 'ready' });
  vi.stubEnv('JUDGE_MODEL', 'not-installed:1b');
  expect((await request(app).get('/api/health').expect(200)).body.model).toBe('unavailable');
  vi.stubEnv('JUDGE_MODEL', ''); const url = process.env.LLM_BASE_URL!;
  vi.stubEnv('LLM_BASE_URL', 'http://127.0.0.1:9/v1');
  expect((await request(app).get('/api/health').expect(200)).body.model).toBe('unavailable');
  vi.stubEnv('LLM_BASE_URL', url); vi.stubEnv('AI_PROVIDER', 'practice');
  expect((await request(app).get('/api/health').expect(200)).body.model).toBeUndefined();
  vi.stubEnv('AI_PROVIDER', 'local');
});

it('tells users their answers stay on the Interview IQ server', async () => {
  const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
  expect(disclosure).toMatchObject({ policy: '2026-10-25.local.v1', interviewerModel: 'qwen3.5:4b', judgeModel: 'qwen3.5:4b' });
  expect(disclosure.description).toMatch(/not sent to an outside AI company/);
  expect(JSON.stringify(disclosure)).not.toMatch(/127\.0\.0\.1|follow its terms/);
  await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
});

it('generates a fresh question every time, asking the model to avoid earlier ones, with thinking off', async () => {
  const first = (await start().expect(201)).body.interview;
  await owner.post(`/api/interviews/${first._id}/answer`).send({ answer: 'Arrays allow constant-time indexed access.', questionIndex: 0, submissionId: 'l-0' }).expect(202);
  await processNextInterviewJob();
  const asked = (await Interview.findById(first._id).lean())!;
  expect(bodies[0]).toMatchObject({ model: 'qwen3.5:4b', reasoning_effort: 'none' });
  expect(bodies[0].temperature).toBeUndefined();
  await owner.post(`/api/interviews/${first._id}/answer`).send({ answer: 'A heap keeps the smallest item at the root.', questionIndex: 1, submissionId: 'l-1' }).expect(202);
  await processNextInterviewJob();
  const scoring = bodies.find(b => JSON.parse(b.messages[1].content).turns)!;
  expect(scoring.temperature).toBe(0);
  const criteria = scoring.response_format.json_schema.schema.properties.answers.items.properties.criteria;
  expect(criteria.items.properties.criterionId.enum).toEqual(rubricFor('Technical').criteria.map(c => c.id));
  expect([criteria.minItems, criteria.maxItems]).toEqual([5, 5]);
  const second = (await start().expect(201)).body.interview;
  const input = JSON.parse(bodies.at(-1).messages[1].content);
  const done = (await Interview.findById(first._id).lean())!;
  expect(input.avoidQuestions).toEqual([done.turns[1].question, done.turns[0].question]);
  expect(done.turns[0].question).toBe(asked.turns[0].question);
  expect(second.currentQuestion).not.toBe(asked.turns[0].question);
  expect(bodies.at(-1).messages[0].content).toMatch(/avoidQuestions/);
  expect(await AIUsage.countDocuments({ provider: 'local', 'cost.reason': 'local_model', status: 'succeeded' })).toBeGreaterThan(0);

  repeat = true;
  const before = bodies.length;
  await start().expect(500);
  expect(bodies.length - before).toBe(3);
});

const items = parseItems(readFileSync(fileURLToPath(new URL('../../calibration/items.synthetic.v1.jsonl', import.meta.url)), 'utf8'));
const rank = { off_topic: 0, weak: 1, adequate: 3, strong: 5 } as const;
function judge(model: string, scoreFor: (item: (typeof items)[number], c: number) => number | null): ModelRating[] {
  return items.flatMap(item => criteriaFor(item).map((c, n) => {
    const score = scoreFor(item, n);
    return { itemId: item.id, criterionId: c.id, score, quote: null, rationale: 'r', model, promptVersion: 'evidence-judge.v1', rubricVersion: RUBRIC_VERSION, datasetHash: datasetHash(items) };
  }));
}

it('computes ordering and rank correlation, counting ties fairly', () => {
  expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
  expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
  expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
  expect(concordance([0, 1, 2], [1, 2, 3])).toBe(1);
  expect(concordance([0, 1, 2], [1, 1, 1])).toBe(0.5);
  expect(concordance([0, 0], [1, 2])).toBeNull();
});

it('passes judges that order known-quality answers and agree, and fails ones that do not', () => {
  const good = judge('qwen3.5:4b', item => rank[item.intendedQuality!]);
  const close = judge('gemma4:e2b', (item, n) => item.intendedQuality === 'off_topic' && n === 0 ? null : Math.min(5, rank[item.intendedQuality!] + (n % 2)));
  const report = buildAutoReport(items, good, close);
  expect(report.gates.map(g => g.verdict)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
  expect(report.judges[0]).toMatchObject({ model: 'qwen3.5:4b · evidence-judge.v1', items: 24, ordering: 1, spearman: 1 });
  expect(report.cross!.items).toBe(24);
  expect(report.limits).toMatch(/do not show agreement with expert interviewers/);

  const inverted = judge('phi:mini', item => 5 - rank[item.intendedQuality!]);
  const bad = buildAutoReport(items, inverted, good);
  expect(bad.gates.filter(g => g.verdict === 'fail').map(g => g.name)).toEqual([
    'Judge 1 orders known-quality answers (pairwise)', 'Judge 1 rank correlation with intended quality', 'Two independent judges agree on item scores (ICC A,1)']);

  expect(() => buildAutoReport(items, good, good)).toThrow(/different model/);
  expect(() => buildAutoReport(items, [...good, ...judge('other', () => 1)])).toThrow(/exactly one model/);
  expect(() => buildAutoReport(items, good.map(r => ({ ...r, datasetHash: 'f'.repeat(64) })))).toThrow(/mismatched/);
  const firstSix = new Set(items.slice(0, 6).map(i => i.id));
  const few = buildAutoReport(items, good.filter(r => firstSix.has(r.itemId)));
  expect(few.gates.every(g => g.verdict === 'insufficient data')).toBe(true);
});

it('constrains scorecards to the rubric and retries or skips invalid ones in calibration runs', async () => {
  const schema = evidenceSchemaFor('HR', 2);
  const criteria = rubricFor('HR').criteria.map(c => ({ criterionId: c.id, score: 3, quote: null, rationale: 'r', improvement: null }));
  const review = { verdict: 'not_answered', verdictReason: 'r', keyPoints: ['a', 'b'], tip: 't' };
  const overall = { summary: 's', strengths: [], improvements: ['i'], nextSteps: ['n'] };
  const card = (answers: unknown[]) => ({ overall, answers });
  expect(schema.safeParse(card([0, 1].map(questionIndex => ({ questionIndex, ...review, criteria })))).success).toBe(true);
  expect(schema.safeParse(card([0, 1].map(questionIndex => ({ questionIndex, criteria })))).success).toBe(false);
  expect(schema.safeParse({ answers: [0, 1].map(questionIndex => ({ questionIndex, ...review, criteria })) }).success).toBe(false);
  expect(schema.safeParse(card([{ questionIndex: 0, ...review, criteria }])).success).toBe(false);
  expect(schema.safeParse(card([0, 2].map(questionIndex => ({ questionIndex, ...review, criteria })))).success).toBe(false);
  expect(schema.safeParse(card([0, 1].map(questionIndex => ({ questionIndex, ...review, criteria: [...criteria.slice(1), { ...criteria[0], criterionId: 'made_up' }] })))).success).toBe(false);
  expect(schema.safeParse(card([0, 1].map(questionIndex => ({ questionIndex, ...review, criteria: criteria.slice(1) })))).success).toBe(false);
  expect(schema.safeParse(card([0, 1].map(questionIndex => ({ questionIndex, ...review, verdict: 'maybe', criteria })))).success).toBe(false);

  let calls = 0;
  const flaky = async (ctx: any) => {
    calls++;
    if (calls % 2 === 1) throw new Error('Evaluation contains invalid answer or criterion references.');
    const rubric = rubricFor(ctx.type);
    return { source: 'ai' as const, score: 60, summary: '', strengths: [], improvements: [], nextSteps: [], rubric,
      answers: [{ questionIndex: 0, criteria: rubric.criteria.map(c => ({ criterionId: c.id, label: c.label, score: 3, status: 'rated' as const, rationale: 'r', improvement: null, evidence: null })) }],
      generation: { provider: 'local', model: 'qwen3.5:4b', promptVersion: 'evidence-judge.v1', inputHash: '0'.repeat(64), inputTokens: 1, outputTokens: 1, latencyMs: 1 } };
  };
  expect((await runJudge(items.slice(0, 2), flaky, undefined, { attempts: 3 })).length).toBe(10);
  await expect(runJudge(items.slice(0, 1), async () => { throw new Error('bad scorecard'); })).rejects.toThrow('bad scorecard');
  const skipped: string[] = [];
  const kept = await runJudge(items.slice(0, 2), async ctx => ctx.history[0].question === items[0].question ? Promise.reject(new Error('bad')) : flaky(ctx),
    undefined, { attempts: 2, onSkip: id => skipped.push(id) });
  expect(skipped).toEqual([items[0].id]);
  expect(new Set(kept.map(r => r.itemId))).toEqual(new Set([items[1].id]));
});

it('transcribes voice answers on the local speech server and reports its readiness', async () => {
  const url = `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`;
  vi.stubEnv('TRANSCRIPTION_MODEL', 'small'); vi.stubEnv('TRANSCRIPTION_BASE_URL', url);
  try {
    expect(providerConfig()).toMatchObject({ transcriptionBaseURL: url, transcriptionTimeoutMs: 300_000 });
    const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
    expect(disclosure.voice).toMatch(/transcribed on the Interview IQ server and then discarded/);
    await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
    expect((await request(app).get('/api/health').expect(200)).body).toMatchObject({ model: 'ready', voice: 'ready' });
    const id = (await start().expect(201)).body.interview._id;
    const before = bodies.length;
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 7)]);
    const response = await owner.post(`/api/interviews/${id}/transcribe`).set('Content-Type', 'audio/webm').set('X-Recording-Ms', '12000').send(webm).expect(200);
    expect(response.body.transcript).toBe('I would use a hash map.');
    expect(sttUploads.at(-1)).toMatch(/name="model"\r\n\r\nsmall\r\n/);
    expect(bodies.length).toBe(before);
    vi.stubEnv('TRANSCRIPTION_BASE_URL', 'http://127.0.0.1:9/v1');
    expect((await request(app).get('/api/health').expect(200)).body.voice).toBe('unavailable');
    vi.stubEnv('TRANSCRIPTION_BASE_URL', 'https://speech.example.com/v1');
    expect(() => providerConfig()).toThrow(/speech-to-text must be served on this machine/);
  } finally {
    vi.stubEnv('TRANSCRIPTION_MODEL', ''); vi.stubEnv('TRANSCRIPTION_BASE_URL', '');
    const { disclosure } = (await owner.get('/api/account/ai-consent').expect(200)).body;
    await owner.post('/api/account/ai-consent').send({ version: disclosure.version, accepted: true }).expect(200);
  }
});
