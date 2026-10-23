// Test-only host: isolated MongoDB, loopback binding, no production credentials.
import express from 'express';
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
process.env.JWT_SECRET = 'browser-test-only-secret-longer-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://127.0.0.1:5101';
process.env.NODE_ENV = 'test';
process.env.SERVE_CLIENT = 'true';
process.env.AI_PROVIDER = 'practice';
process.env.MONGOMS_VERSION = '8.2.6';
process.env.MONGOMS_DOWNLOAD_DIR = fileURLToPath(new URL('../node_modules/.cache/mongodb-memory-server', import.meta.url));
delete process.env.OPENAI_API_KEY;
const { app } = await import('../src/app.js');
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri());
let stopWorker: (() => Promise<void>) | undefined = startInterviewWorker();
const host = express();
host.use(cookieParser());
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
host.use(app);
const server = host.listen(5101, '127.0.0.1');
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await stopWorker?.();
  await mongoose.disconnect();
  await mongo.stop();
};
process.on('SIGTERM', close);
process.on('SIGINT', close);
