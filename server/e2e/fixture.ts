// Test-only host: isolated MongoDB, loopback binding, no production credentials.
import express from 'express';
import { User } from '../src/models/User.js';
import { issueAccountToken } from '../src/services/account.js';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { requireAuth, type AuthRequest } from '../src/middleware/auth.js';
import { consumeQuota, quotaLimit } from '../src/services/quotas.js';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';
import { startInterviewWorker } from '../src/services/interviewJobs.js';
import { rubricFor } from '../src/services/rubrics.js';
import { verifyEvidence, summarizeEvidence } from '../src/services/evidence.js';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
process.env.JWT_SECRET = 'browser-test-only-secret-longer-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://127.0.0.1:5101';
process.env.NODE_ENV = 'test';
process.env.SERVE_CLIENT = 'true';
process.env.AI_PROVIDER = 'practice';
// Every browser test registers from 127.0.0.1, so the per-IP auth limit needs headroom here only.
process.env.AUTH_REQUESTS_PER_15_MIN = '200';
process.env.MONGOMS_VERSION = '8.2.6';
process.env.MONGOMS_DOWNLOAD_DIR = fileURLToPath(new URL('../node_modules/.cache/mongodb-memory-server', import.meta.url));
delete process.env.OPENAI_API_KEY;
// Test-only stand-in for the code runner: runs JavaScript and TypeScript with Node on loopback, without a sandbox.
const fakeRunner = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') { res.end(JSON.stringify({ ok: true, languages: { javascript: 'node', typescript: 'node', python: null, java: null, cpp: null } })); return; }
  const input = JSON.parse(body);
  const dir = mkdtempSync(join(tmpdir(), 'iq-e2e-runner-'));
  try {
    const file = join(dir, input.language === 'typescript' ? 'main.ts' : 'main.js');
    writeFileSync(file, input.source);
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', file], { input: input.stdin, encoding: 'utf8', timeout: input.timeLimitMs });
    res.end(JSON.stringify({ status: result.error ? 'timeout' : result.status === 0 ? 'ok' : 'runtime_error', runner: { version: 'e2e' },
      run: { ms: Date.now() - started, exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stdoutTruncated: false, stderr: result.stderr ?? '', stderrTruncated: false } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await new Promise<void>(resolve => fakeRunner.listen(0, '127.0.0.1', resolve));
process.env.RUNNER_URL = `http://127.0.0.1:${(fakeRunner.address() as AddressInfo).port}`;
process.env.RUNNER_AUTH = 'none';
const { app } = await import('../src/app.js');
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri());
let stopWorker: (() => Promise<void>) | undefined = startInterviewWorker();
const host = express();
host.use(cookieParser());
// Tokens are exposed only by this loopback test host, never by production app routes.
host.post('/__test/enable-ai', requireAuth, (_req,res)=>{process.env.AI_PROVIDER='openai';process.env.OPENAI_API_KEY='test-only-not-real';res.sendStatus(204);});
host.post('/__test/disable-ai', (_req,res)=>{process.env.AI_PROVIDER='practice';delete process.env.OPENAI_API_KEY;res.sendStatus(204);});
// Loopback OpenAI-compatible stand-in. Transcriptions return a fixed sentence; new questions are
// numbered, and tailored ones cite the first line of the first document; STAR checks of the seeded behavioral
// answer find three parts and miss the result; for the seeded evidence answer, rewrites restate both seeded sentences plus one bracketed
// prompt and second reviews rate the seeded quote 5.
let failNextCodingReview = false;
host.post('/__test/fail-next-coding-review', requireAuth, (_req, res) => { failNextCodingReview = true; res.sendStatus(204); });
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/audio/transcriptions')) { res.end(JSON.stringify({ text: 'Arrays give constant-time indexed access.' })); return; }
  const input = JSON.parse(JSON.parse(body).messages[1].content);
  if (input.candidateExplanation && failNextCodingReview) {
    failNextCodingReview = false; res.writeHead(503); res.end(JSON.stringify({ error: 'Test provider unavailable' })); return;
  }
  const value = input.candidateExplanation ? { summary: 'A hash map gives a one-pass solution; the complexity claim is right.', criteria: [
      { criterionId: 'approach', score: 5, quote: 'new Map()', rationale: 'A hash map suits the lookups.', improvement: null },
      { criterionId: 'complexity', score: 4, quote: 'O(n) time', rationale: 'The time complexity is stated correctly.', improvement: 'Also state the O(n) space.' },
      { criterionId: 'quality', score: 4, quote: 'seen.set(nums[i], i);', rationale: 'Short and readable.', improvement: 'Name the complement variable.' },
      { criterionId: 'explanation', score: null, quote: null, rationale: '', improvement: null }] }
    : input.testResults ? { question: 'Your solution passed. What are its time and space complexity, and why?' }
    : input.starParts ? { parts: [
      { part: 'situation', quote: 'our demo server crashed a day before the review', tip: null },
      { part: 'task', quote: 'I had to restore it before the panel met', tip: null },
      { part: 'action', quote: 'I rebuilt it from backups', tip: null },
      { part: 'result', quote: null, tip: 'Add how the review went, if you know it.' }] }
    : input.ratings !== undefined
    ? { summary: 'Leads with the contrast between the two structures.', parts: [
      { kind: 'answer', text: 'Arrays give direct indexed access.', quote: 'Arrays allow indexed access.' },
      { kind: 'answer', text: 'Linked lists must be walked to reach an element.', quote: 'Linked lists require traversal.' },
      { kind: 'addition', text: '[Add the time complexity of each operation]', quote: null }] }
    : input.documents ? { question: `Tell me about the project behind this line, question ${input.questionNumber}.`, topic: 'Projects',
      source: { document: input.documents[0].kind, quote: input.documents[0].text.split(/\r?\n/)[0] } }
    : input.questionNumber !== undefined ? { question: `Explain indexed access, question ${input.questionNumber}.`, topic: 'DSA' }
      : { score: 5, quote: 'Arrays allow indexed access.', rationale: 'The answer names indexed access explicitly.', improvement: null };
  res.end(JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: 'fixture-judge',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(value), refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
});
await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
host.post('/__test/enable-gateway', requireAuth, (_req, res) => {
  Object.assign(process.env, { AI_PROVIDER: 'compatible', LLM_BASE_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`,
    INTERVIEWER_MODEL: 'fixture-interviewer', JUDGE_MODEL: 'fixture-judge', TRANSCRIPTION_MODEL: 'fixture-transcriber' });
  res.sendStatus(204);
});
host.post('/__test/account-links', requireAuth, async (req, res) => {
  const user = (await User.findById((req as AuthRequest).userId))!;
  res.json({ reset: await issueAccountToken(user, 'reset'), verify: await issueAccountToken(user, 'verify') });
});
host.post('/__test/seed-evidence', requireAuth, async (req, res) => {
  const turns = [0, 1].map(i => ({ question: `Explain indexed access ${i + 1}.`,
    answer: '🙂 Arrays allow indexed access. <script>alert("untrusted")</script> Linked lists require traversal.',
    topic: 'DSA', answeredAt: new Date(), questionIndex: i, submissionId: `fixture-${i}` }));
  const rubric = rubricFor('Technical');
  const overall = { summary: 'You named indexed access but did not compare the two structures fully.', improvements: ['Compare insertion and lookup costs.'],
    nextSteps: ['Explain arrays versus linked lists aloud in two minutes.'], strengths: [{ text: 'Names indexed access', quote: 'Arrays allow indexed access.' }] };
  const answers = verifyEvidence({ overall, answers: turns.map((_, questionIndex) => ({ questionIndex,
    verdict: questionIndex === 0 ? 'partly_correct' as const : 'not_answered' as const,
    verdictReason: questionIndex === 0 ? 'It names indexed access but not the cost of insertion.' : 'The answer does not address this question.',
    keyPoints: ['Arrays give O(1) indexed reads', 'Linked lists need O(n) traversal', 'Insertion costs differ'], tip: 'Compare both structures with a concrete example.',
    criteria: rubric.criteria.map((c, i) => ({ criterionId: c.id, score: 4,
      quote: i === 0 ? 'Arrays allow indexed access.' : null,
      rationale: 'You explain indexed reads.', improvement: 'Compare the cost of insertion.' })) })) }, turns, 'Technical');
  const doc = await Interview.create({ userId: (req as AuthRequest).userId, role: 'Evidence test',
    type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2,
    currentQuestion: 'Explain indexed access.', currentTopic: 'DSA', turns, mode: 'ai', status: 'completed',
    completedAt: new Date(), feedback: { source: 'ai', ...summarizeEvidence(answers, overall, turns), rubric, answers,
      generation: { provider: 'test', model: 'deterministic-fixture', promptVersion: 'evidence-judge.v2',
        inputHash: '0'.repeat(64), inputTokens: 10, outputTokens: 20, latencyMs: 1 } } });
  res.json({ id: doc.id });
});
// A completed AI behavioral interview with delivery counts from three voice recordings.
host.post('/__test/seed-behavioral', requireAuth, async (req, res) => {
  const answer = 'In my final-year project our demo server crashed a day before the review. I had to restore it before the panel met. I rebuilt it from backups and wrote a recovery script.';
  const turns = [0, 1].map(i => ({ question: `Tell me about a setback ${i + 1}.`, answer, topic: 'Behavioral', answeredAt: new Date(), questionIndex: i, submissionId: `behavioral-${i}` }));
  const rubric = rubricFor('Behavioral');
  const answers = verifyEvidence({ answers: turns.map((_, questionIndex) => ({ questionIndex,
    criteria: rubric.criteria.map(c => ({ criterionId: c.id, score: 3, quote: 'I rebuilt it from backups', rationale: 'You describe your action.', improvement: 'Add the result.' })) })) }, turns, 'Behavioral');
  const clip = (questionIndex: number, seconds: number, words: number, fillers: { term: string; count: number }[]) => ({ questionIndex, seconds, words, fillers, version: 'delivery.v1' });
  const doc = await Interview.create({ userId: (req as AuthRequest).userId, role: 'Behavioral test', type: 'Behavioral', difficulty: 'Intermediate',
    topic: 'Behavioral', totalQuestions: 2, currentQuestion: 'Tell me about a setback.', currentTopic: 'Behavioral', turns, mode: 'ai', status: 'completed',
    completedAt: new Date(), feedback: { source: 'ai', ...summarizeEvidence(answers), rubric, answers },
    deliveryClips: [clip(0, 30, 60, [{ term: 'basically', count: 2 }, { term: 'um', count: 1 }]), clip(0, 15, 30, [{ term: 'you know', count: 1 }]), clip(1, 20, 40, [])] });
  res.json({ id: doc.id });
});
host.post('/__test/seed-history', requireAuth, async (req, res) => {
  await Interview.insertMany(Array.from({ length: 45 }, (_, i) => ({ userId: (req as AuthRequest).userId,
    role: `History sample ${i}`, type: 'Technical', difficulty: 'Intermediate', topic: 'React', totalQuestions: 2,
    currentQuestion: 'Explain React.', currentTopic: 'React', createdAt: new Date('2026-01-01T00:00:00Z') })));
  res.sendStatus(204);
});
host.post('/__test/exhaust-starts', requireAuth, async (req, res) => {
  const limit = quotaLimit('INTERVIEWS_PER_DAY', 20);
  for (let i = 0; i < limit; i++) {
    try { await consumeQuota((req as AuthRequest).userId, 'daily interview starts', limit, 86400_000); } catch { break; }
  }
  res.sendStatus(204);
});
host.post('/__test/pause', async (_req, res) => { await stopWorker?.(); stopWorker = undefined; res.sendStatus(204); });
host.post('/__test/resume', (_req, res) => { stopWorker ??= startInterviewWorker(); res.sendStatus(204); });
host.post('/__test/fail', async (_req, res) => {
  await Interview.updateMany({ processingState: 'queued' }, { $set: { processingState: 'failed' } });
  res.sendStatus(204);
});
// Moves the caller's current question clock back, so time-up states can be tested without waiting.
host.post('/__test/age-question', requireAuth, async (req, res) => {
  const seconds = Number(req.query.seconds ?? 0);
  await Interview.updateMany({ userId: (req as AuthRequest).userId, status: 'in_progress' },
    { $set: { questionStartedAt: new Date(Date.now() - seconds * 1000) } });
  res.sendStatus(204);
});
host.use(app);
const server = host.listen(5101, '127.0.0.1');
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.close();
  gateway.close();
  fakeRunner.close();
  await stopWorker?.();
  await mongoose.disconnect();
  await mongo.stop();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
