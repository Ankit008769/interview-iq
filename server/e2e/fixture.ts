// Test-only host: isolated MongoDB, loopback binding, no production credentials.
import express from 'express';
import cookieParser from 'cookie-parser';
import { requireAuth, type AuthRequest } from '../src/middleware/auth.js';
import { consumeQuota, quotaLimit } from '../src/services/quotas.js';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Interview } from '../src/models/Interview.js';
import { startInterviewWorker } from '../src/services/interviewJobs.js';
process.env.JWT_SECRET = 'browser-test-only-secret-longer-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://127.0.0.1:5101';
process.env.NODE_ENV = 'test';
process.env.SERVE_CLIENT = 'true';
delete process.env.OPENAI_API_KEY;
const { app } = await import('../src/app.js');
const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri());
let stopWorker: (() => Promise<void>) | undefined = startInterviewWorker();
const host = express();
host.use(cookieParser());
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
