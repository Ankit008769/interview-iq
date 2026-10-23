import 'dotenv/config';
import mongoose from 'mongoose';
import { app } from './app.js';
import { startInterviewWorker } from './services/interviewJobs.js';
import { quotaLimit } from './services/quotas.js';
import { interviewMode } from './services/ai.js';

const port = Number(process.env.PORT || 5000);
if (!process.env.MONGODB_URI) throw new Error('Missing MONGODB_URI. See server/.env.example');
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters.');
if (process.env.JWT_SECRET.startsWith('replace-with-')) throw new Error('Replace the example JWT_SECRET before starting.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
if (process.env.NODE_ENV === 'production') {
  const origin = new URL(process.env.CLIENT_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.origin !== process.env.CLIENT_ORIGIN) throw new Error('Production CLIENT_ORIGIN must be an exact HTTPS origin.');
}
quotaLimit('INTERVIEW_WRITES_PER_15_MIN', 40);
quotaLimit('INTERVIEWS_PER_DAY', 20);
quotaLimit('AI_CALLS_PER_DAY', 100);
const mode = interviewMode(); // Fail before listening if the selected provider is misconfigured.
try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  const stopWorker = startInterviewWorker();
  const server = app.listen(port, () => console.log(`InterviewIQ API running on http://localhost:${port} (${mode} mode)`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await stopWorker();
    await mongoose.disconnect();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  console.error('Database connection failed:', err);
  process.exit(1);
}
