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
// numbered, and tailored ones cite the first line of the first document; for the seeded evidence answer, rewrites restate both seeded sentences plus one bracketed
// prompt and second reviews rate the seeded quote 5.
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('/audio/transcriptions')) { res.end(JSON.stringify({ text: 'Arrays give constant-time indexed access.' })); return; }
  const input = JSON.parse(JSON.parse(body).messages[1].content);
  const value = input.ratings !== undefined
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
  const answers = verifyEvidence({ answers: turns.map((_, questionIndex) => ({ questionIndex,
    criteria: rubric.criteria.map((c, i) => ({ criterionId: c.id, score: 4,
      quote: i === 0 ? 'Arrays allow indexed access.' : null,
      rationale: 'You explain indexed reads.', improvement: 'Compare the cost of insertion.' })) })) }, turns, 'Technical');
  const doc = await Interview.create({ userId: (req as AuthRequest).userId, role: 'Evidence test',
    type: 'Technical', difficulty: 'Intermediate', topic: 'DSA', totalQuestions: 2,
    currentQuestion: 'Explain indexed access.', currentTopic: 'DSA', turns, mode: 'ai', status: 'completed',
    completedAt: new Date(), feedback: { source: 'ai', ...summarizeEvidence(answers), rubric, answers,
      generation: { provider: 'test', model: 'deterministic-fixture', promptVersion: 'evidence-judge.v1',
        inputHash: '0'.repeat(64), inputTokens: 10, outputTokens: 20, latencyMs: 1 } } });
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
  await stopWorker?.();
  await mongoose.disconnect();
  await mongo.stop();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
