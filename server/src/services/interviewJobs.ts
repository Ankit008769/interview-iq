import { ConsentRequiredError } from './providerConsent.js';
import { operationalEvent } from './monitoring.js';
import { randomUUID } from 'node:crypto';
import { Interview } from '../models/Interview.js';
import { evaluateInterview, generateQuestion } from './ai.js';
import { consumeAIQuota, QuotaError } from './quotas.js';
import { processAccountDeletions } from './account.js';
import { processNextChallengeJob } from './challenges.js';
import { User } from '../models/User.js';

export const MAX_JOB_ATTEMPTS = 3;
export const JOB_LEASE_MS = 120_000;
const failureMessage = 'Your answer is saved. Processing could not finish. Please retry.';

// The answer and job live in one MongoDB document: no gap between saving and enqueueing.
// Lease tokens fence out late results from a worker whose lease has been reclaimed.
export async function processNextInterviewJob(): Promise<boolean> {
  const now = new Date();
  await Interview.updateMany({ status: 'in_progress', processingState: 'processing',
    jobLeaseUntil: { $lte: now }, jobAttempts: { $gte: MAX_JOB_ATTEMPTS } },
  { $set: { processingState: 'failed', processingError: failureMessage },
    $unset: { jobLeaseToken: 1, jobLeaseUntil: 1 } });

  const token = randomUUID();
  const doc = await Interview.findOneAndUpdate({ status: 'in_progress', jobAttempts: { $lt: MAX_JOB_ATTEMPTS },
    $or: [
      { processingState: 'queued', jobNextAttemptAt: { $lte: now } },
      { processingState: 'processing', jobLeaseUntil: { $lte: now } },
    ] },
  { $set: { processingState: 'processing', jobLeaseToken: token, jobLeaseUntil: new Date(now.getTime() + JOB_LEASE_MS) },
    $inc: { jobAttempts: 1 } }, { new: true, sort: { jobNextAttemptAt: 1 } });
  if (!doc) return false;
  const fence = { _id: doc._id, processingState: 'processing', jobLeaseToken: token };
  try {
    if (!await User.exists({ _id: doc.userId, deletionRequestedAt: { $exists: false } })) {
      await Interview.deleteOne({ _id: doc._id }); return true;
    }
    if (doc.mode === 'ai') await consumeAIQuota(doc.userId.toString());
    const context = { role: doc.role, type: doc.type, difficulty: doc.difficulty,
      topic: doc.topic, history: doc.turns, mode: doc.mode, usageContext: { userId: doc.userId.toString(), interviewId: doc.id } };
    const finished = doc.turns.length >= doc.totalQuestions;
    const result = finished
      ? { status: 'completed', completedAt: new Date(), feedback: await evaluateInterview(context) }
      : await generateQuestion({ ...context, turnIndex: doc.turns.length }).then(q => ({ currentQuestion: q.question, currentTopic: q.topic,
        currentQuestionId: q.questionId, currentQuestionGeneration: q.generation, questionStartedAt: new Date(), pausedMs: 0 }));
    // The question clock starts when the next question is ready, so processing time is never counted.
    await Interview.updateOne(fence, { $set: { ...result, processingState: 'ready' },
      $unset: { jobLeaseToken: 1, jobLeaseUntil: 1, jobNextAttemptAt: 1, processingError: 1, pausedAt: 1 } }, { runValidators: true });
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      await Interview.updateOne(fence, {$set:{processingState:'failed',processingError:err.message},$unset:{jobLeaseToken:1,jobLeaseUntil:1}});
      return true;
    }
    operationalEvent('interview_processing_failure', 'WARNING');
    if (err instanceof QuotaError) {
      await Interview.updateOne(fence, { $set: { processingState: 'queued',
        processingError: err.message, jobNextAttemptAt: err.resetAt },
        $inc: { jobAttempts: -1 }, $unset: { jobLeaseToken: 1, jobLeaseUntil: 1 } });
      return true;
    }
    // Do not expose provider payloads or candidate content in errors/logs.
    await Interview.updateOne(fence, { $set: {
      processingState: doc.jobAttempts >= MAX_JOB_ATTEMPTS ? 'failed' : 'queued',
      processingError: failureMessage,
      jobNextAttemptAt: new Date(Date.now() + 1000 * 2 ** doc.jobAttempts),
    }, $unset: { jobLeaseToken: 1, jobLeaseUntil: 1 } });
  }
  return true;
}

export function startInterviewWorker() {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let lastHeartbeat = 0;
  const tick = () => {
    running = (async () => {
      try { await processAccountDeletions(); await processNextInterviewJob(); await processNextChallengeJob();
        if (Date.now()-lastHeartbeat >= 60_000) { operationalEvent('worker_heartbeat','INFO'); lastHeartbeat=Date.now(); }
      }
      catch { operationalEvent('worker_database_error','ERROR'); }
      if (!stopped) timer = setTimeout(tick, 1000);
    })();
  };
  tick(); // Immediately recover durable work on startup.
  return async () => { stopped = true; clearTimeout(timer); await running; };
}
