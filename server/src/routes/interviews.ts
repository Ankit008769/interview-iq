import { ConsentRequiredError, requireAIConsent } from '../services/providerConsent.js';
import { operationalEvent } from '../services/monitoring.js';
import { Router } from 'express';
import mongoose from 'mongoose';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { generateQuestion, interviewMode, rewriteAnswer } from '../services/ai.js';
import { consumeAIQuota, consumeQuota, quotaLimit } from '../services/quotas.js';
import { MAX_CHALLENGES_PER_INTERVIEW } from '../services/challenges.js';
import { randomUUID } from 'node:crypto';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
const makeSchema = z.object({
  mode: z.enum(['ai','practice']).optional(),
  role: z.string().trim().min(2).max(100),
  type: z.enum(['Technical', 'Behavioral', 'HR']),
  difficulty: z.enum(['Beginner', 'Intermediate', 'Advanced']),
  topic: z.string().trim().min(2).max(100),
  totalQuestions: z.number().int().min(2).max(5),
});
const answerSchema = z.object({
  answer: z.string().trim().min(10).max(3500),
  questionIndex: z.number().int().min(0).max(4),
  submissionId: z.string().min(1).max(100),
});
const challengeSchema = z.object({
  questionIndex: z.number().int().min(0).max(4),
  criterionId: z.string().min(1).max(40),
  reason: z.string().trim().min(10).max(500),
  submissionId: z.string().min(1).max(100),
});
const rewriteRequestSchema = z.object({ questionIndex: z.number().int().min(0).max(4) });
const aiLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'interview requests', quotaLimit('INTERVIEW_WRITES_PER_15_MIN', 40), 900_000); next(); }
  catch (err) { next(err); }
};

router.get('/mode', (_req, res) => res.json({ mode: interviewMode() }));
router.get('/dashboard', async (req, res, next) => {
  try {
    const owner = new mongoose.Types.ObjectId(userId(req));
    const [stats, recent] = await Promise.all([
      Interview.aggregate([
        { $match: { userId: owner } },
        { $group: { _id: null, total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          averageScore: { $avg: { $cond: [{ $eq: ['$feedback.source', 'ai'] }, '$feedback.score', null] } },
        } },
      ]),
      Interview.find({ userId: owner }).select('role topic type status feedback.score feedback.source createdAt totalQuestions').sort({ createdAt: -1, _id: -1 }).limit(5).lean(),
    ]);
    const summary = stats[0];
    res.json({ total: summary?.total ?? 0, completed: summary?.completed ?? 0,
      averageScore: summary?.averageScore == null ? null : Math.round(summary.averageScore), recent });
  } catch (err) { next(err); }
});
router.get('/', async (req, res, next) => {
  try {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(300).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'Invalid history page size or cursor.' }); return; }
    let boundary = {};
    if (query.data.cursor) {
      try {
        const cursor = z.object({ date: z.string().datetime(), id: z.string().regex(/^[a-f0-9]{24}$/) })
          .parse(JSON.parse(Buffer.from(query.data.cursor, 'base64url').toString('utf8')));
        const date = new Date(cursor.date);
        boundary = { $or: [{ createdAt: { $lt: date } }, { createdAt: date, _id: { $lt: new mongoose.Types.ObjectId(cursor.id) } }] };
      } catch { res.status(400).json({ error: 'Invalid history cursor.' }); return; }
    }
    const docs = await Interview.find({ userId: userId(req), ...boundary })
      .select('role topic type difficulty status feedback.score feedback.source createdAt totalQuestions turns processingState')
      .sort({ createdAt: -1, _id: -1 }).limit(query.data.limit + 1).lean();
    const page = docs.slice(0, query.data.limit);
    const last = page.at(-1);
    const nextCursor = docs.length > query.data.limit && last
      ? Buffer.from(JSON.stringify({ date: last.createdAt.toISOString(), id: last._id.toString() })).toString('base64url') : null;
    res.json({ interviews: page.map(x => ({ ...x, answered: x.turns.length, turns: undefined })), nextCursor });
  } catch (err) { next(err); }
});
router.post('/', aiLimit, async (req, res, next) => {
  try {
    const parsed = makeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose a valid role, topic, type, difficulty and number of questions.' }); return; }
    const input = { ...parsed.data, mode: parsed.data.mode || interviewMode() };
    if (input.mode === 'ai') await requireAIConsent(userId(req));
    await consumeQuota(userId(req), 'daily interview starts', quotaLimit('INTERVIEWS_PER_DAY', 20), 86400_000);
    if (input.mode === 'ai') await consumeAIQuota(userId(req));
    const id = new mongoose.Types.ObjectId();
    const first = await generateQuestion({ ...input, usageContext: { userId: userId(req), interviewId: id.toString() }, turnIndex: 0, history: [] });
    if (!await User.exists({ _id: userId(req), deletionRequestedAt: { $exists: false } })) { res.sendStatus(401); return; }
    const doc = await Interview.create({ _id: id, userId: userId(req), ...input, status: 'in_progress', currentQuestion: first.question, currentTopic: first.topic, currentQuestionId: first.questionId, currentQuestionGeneration: first.generation, turns: [] });
    res.status(201).json({ interview: doc, mode: doc.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.json({ interview: doc, mode: doc.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
router.post('/:id/answer', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Provide a valid question index, submission ID and answer between 10 and 3500 characters.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const replay = doc.turns.find(t => t.submissionId === parsed.data.submissionId);
    if (replay) {
      if (replay.answer !== parsed.data.answer || replay.questionIndex !== parsed.data.questionIndex) {
        res.status(409).json({ error: 'This submission ID was used for a different answer. Reload the interview.' }); return;
      }
      res.json({ interview: doc, mode: doc.mode ?? interviewMode(), replayed: true }); return;
    }
    if (doc.status !== 'in_progress') { res.status(409).json({ error: 'This interview is already complete.' }); return; }
    if (doc.turns.length !== parsed.data.questionIndex) {
      res.status(409).json({ error: 'This question has already changed. Reload the interview before answering.' }); return;
    }
    if (doc.processingState !== 'ready') {
      res.status(409).json({ error: 'Your previous answer is saved and is still being processed.' }); return;
    }
    const turn = { question: doc.currentQuestion, answer: parsed.data.answer, topic: doc.currentTopic,
      answeredAt: new Date(), submissionId: parsed.data.submissionId, questionIndex: parsed.data.questionIndex,
      questionId: doc.currentQuestionId, questionGeneration: doc.currentQuestionGeneration };
    const updated = await Interview.findOneAndUpdate(
      { _id: doc._id, userId: userId(req), status: 'in_progress',
        $or: [{ processingState: 'ready' }, { processingState: { $exists: false } }],
        [`turns.${parsed.data.questionIndex}`]: { $exists: false } },
      { $push: { turns: turn },
        $set: { processingState: 'queued', jobAttempts: 0, jobNextAttemptAt: new Date(), mode: doc.mode ?? interviewMode() },
        $unset: { processingError: 1, jobLeaseToken: 1, jobLeaseUntil: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) { res.status(409).json({ error: 'This answer was already submitted. Refresh the interview.' }); return; }
    res.status(202).json({ interview: updated, mode: updated.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
router.post('/:id/retry', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const doc = await Interview.findOneAndUpdate({ _id: req.params.id, userId: userId(req),
      status: 'in_progress', processingState: 'failed' },
    { $set: { processingState: 'queued', jobAttempts: 0, jobNextAttemptAt: new Date() },
      $unset: { processingError: 1, jobLeaseToken: 1, jobLeaseUntil: 1 } }, { new: true });
    if (!doc) {
      const exists = await Interview.exists({ _id: req.params.id, userId: userId(req) });
      res.status(exists ? 409 : 404).json({ error: exists ? 'This interview is not awaiting a retry.' : 'Interview not found.' }); return;
    }
    res.status(202).json({ interview: doc, mode: doc.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
// Ask for a second AI review of one rating. The worker does the review; a score can go up, down or stay.
router.post('/:id/challenges', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const parsed = challengeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose a rating and explain what the review missed in 10 to 500 characters.' }); return; }
    const { questionIndex, criterionId, reason, submissionId } = parsed.data;
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const replay = doc.challenges.find(c => c.submissionId === submissionId);
    if (replay) {
      if (replay.questionIndex !== questionIndex || replay.criterionId !== criterionId || replay.reason !== reason) {
        res.status(409).json({ error: 'This submission ID was used for a different challenge. Reload the results.' }); return;
      }
      res.json({ interview: doc, mode: doc.mode ?? interviewMode(), replayed: true }); return;
    }
    const original = doc.status === 'completed' && doc.feedback?.source === 'ai'
      ? doc.feedback.answers?.find(a => a.questionIndex === questionIndex)?.criteria.find(c => c.criterionId === criterionId) : undefined;
    if (!original) { res.status(409).json({ error: 'Only AI-scored ratings in a completed interview can be challenged.' }); return; }
    await requireAIConsent(userId(req));
    const existing = doc.challenges.find(c => c.questionIndex === questionIndex && c.criterionId === criterionId);
    if (existing && existing.state !== 'failed') { res.status(409).json({ error: 'This rating already has a re-review.' }); return; }
    if (!existing && doc.challenges.length >= MAX_CHALLENGES_PER_INTERVIEW) {
      res.status(409).json({ error: `You can challenge up to ${MAX_CHALLENGES_PER_INTERVIEW} ratings per interview.` }); return;
    }
    const requeue = { $set: { 'challenges.$.state': 'queued', 'challenges.$.attempts': 0, 'challenges.$.nextAttemptAt': new Date(),
      'challenges.$.reason': reason, 'challenges.$.submissionId': submissionId }, $unset: { 'challenges.$.error': 1 } };
    const { criterionId: id, label, score, status, rationale, improvement, evidence } = original;
    const updated = existing
      ? await Interview.findOneAndUpdate({ _id: doc._id, userId: userId(req), challenges: { $elemMatch: { id: existing.id, state: 'failed' } } }, requeue, { new: true })
      // The conditions repeat the checks above atomically, so concurrent requests cannot exceed the limit or duplicate a rating.
      : await Interview.findOneAndUpdate({ _id: doc._id, userId: userId(req), status: 'completed',
        challenges: { $not: { $elemMatch: { questionIndex, criterionId } } }, 'challenges.submissionId': { $ne: submissionId },
        [`challenges.${MAX_CHALLENGES_PER_INTERVIEW - 1}`]: { $exists: false } },
      { $push: { challenges: { id: randomUUID(), submissionId, questionIndex, criterionId, reason, state: 'queued', attempts: 0,
        nextAttemptAt: new Date(), createdAt: new Date(), original: { criterionId: id, label, score, status, rationale, improvement, evidence } } } },
      { new: true, runValidators: true });
    if (!updated) { res.status(409).json({ error: 'This rating already has a re-review. Reload the results.' }); return; }
    res.status(202).json({ interview: updated, mode: updated.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
// One grounded rewrite per answer. Generated synchronously: the answer is already saved, so a failure loses nothing.
router.post('/:id/rewrites', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const parsed = rewriteRequestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose an answer to rewrite.' }); return; }
    const { questionIndex } = parsed.data;
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (doc.rewrites.some(r => r.questionIndex === questionIndex)) { res.json({ interview: doc, mode: doc.mode ?? interviewMode(), replayed: true }); return; }
    const ratings = doc.status === 'completed' && doc.feedback?.source === 'ai'
      ? doc.feedback.answers?.find(a => a.questionIndex === questionIndex)?.criteria : undefined;
    if (!ratings || !doc.turns[questionIndex]) {
      res.status(409).json({ error: 'A stronger version is available for AI-scored answers in completed interviews.' }); return;
    }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let rewrite;
    try {
      rewrite = await rewriteAnswer({ usageContext: { userId: userId(req), interviewId: doc.id }, role: doc.role, type: doc.type,
        difficulty: doc.difficulty, topic: doc.topic, turn: doc.turns[questionIndex], ratings });
    } catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('answer_rewrite_failure', 'WARNING');
      res.status(502).json({ error: 'A stronger version could not be built from your answer. Please try again.' }); return;
    }
    // A concurrent request may have saved one first; keep that one and return it.
    const updated = await Interview.findOneAndUpdate({ _id: doc._id, userId: userId(req), 'rewrites.questionIndex': { $ne: questionIndex } },
      { $push: { rewrites: { questionIndex, ...rewrite, createdAt: new Date() } } }, { new: true, runValidators: true })
      ?? await Interview.findOne({ _id: doc._id, userId: userId(req) });
    if (!updated) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.status(201).json({ interview: updated, mode: updated.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
export default router;
