import { ConsentRequiredError, requireAIConsent } from '../services/providerConsent.js';
import { operationalEvent } from '../services/monitoring.js';
import express, { Router } from 'express';
import mongoose from 'mongoose';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { checkStar, generateQuestion, interviewMode, rewriteAnswer } from '../services/ai.js';
import { consumeAIQuota, consumeQuota, quotaLimit } from '../services/quotas.js';
import { MAX_CHALLENGES_PER_INTERVIEW } from '../services/challenges.js';
import { providerConfig, transcribeAudio } from '../services/modelProvider.js';
import { randomUUID } from 'node:crypto';
import { groundingDocuments, removeDerivedQuestions } from '../services/documents.js';
import { analyzeDelivery } from '../services/delivery.js';

// Accepted recording formats, each checked against its leading bytes rather than trusting the header.
const audioSignatures: Record<string, (b: Buffer) => boolean> = {
  'audio/webm': b => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  'audio/ogg': b => b.subarray(0, 4).toString('latin1') === 'OggS',
  'audio/mp4': b => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'audio/mpeg': b => b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  'audio/wav': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE',
};
const audioType = (header?: string) => { const base = header?.split(';')[0].trim().toLowerCase(); return base === 'audio/x-wav' ? 'audio/wav' : base; };
const audioBody = express.raw({ type: [...Object.keys(audioSignatures), 'audio/x-wav'], limit: '8mb' });

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
  timeLimitSeconds: z.union([z.literal(120), z.literal(180), z.literal(300)]).optional(),
  documentIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(2).optional(),
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
const answerIndexSchema = z.object({ questionIndex: z.number().int().min(0).max(4) });
const aiLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'interview requests', quotaLimit('INTERVIEW_WRITES_PER_15_MIN', 40), 900_000); next(); }
  catch (err) { next(err); }
};
// Pausing is cheap but still a write; it gets its own bucket so it cannot use up answer submissions.
const timerLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'timer changes', 60, 900_000); next(); }
  catch (err) { next(err); }
};
// serverNow lets the browser correct for clock skew when showing the countdown.
const view = (doc: InstanceType<typeof Interview>) => ({ interview: doc, mode: doc.mode ?? interviewMode(), serverNow: new Date() });

router.get('/mode', (_req, res) => res.json({ mode: interviewMode(), transcription: Boolean(providerConfig().transcriptionModel) }));
// Turns one spoken answer into text for the candidate to review and edit; the recording is never stored.
router.post('/:id/transcribe', aiLimit, audioBody, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) }).select('mode status processingState pausedAt turns.questionIndex');
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (!providerConfig().transcriptionModel) { res.status(409).json({ error: 'Voice answers are not enabled on this server.' }); return; }
    if (doc.mode !== 'ai' || doc.status !== 'in_progress' || doc.processingState !== 'ready' || doc.pausedAt) {
      res.status(409).json({ error: 'Voice answers are available while an AI interview question is on screen.' }); return;
    }
    const type = audioType(req.headers['content-type']);
    const audio: unknown = req.body;
    if (!type || !audioSignatures[type] || !Buffer.isBuffer(audio)) { res.status(415).json({ error: 'Send the recording as WebM, Ogg, MP4, MP3 or WAV audio.' }); return; }
    if (audio.length < 1024) { res.status(400).json({ error: 'The recording is too short. Record your answer again.' }); return; }
    if (!audioSignatures[type](audio)) { res.status(415).json({ error: 'The recording does not match its audio format.' }); return; }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let text: string;
    try { ({ text } = await transcribeAudio(audio, type, { userId: userId(req), interviewId: doc.id })); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('transcription_failure', 'WARNING');
      res.status(502).json({ error: 'Your recording could not be transcribed. Please try again or type your answer.' }); return;
    }
    if (!text) { res.status(422).json({ error: 'No speech was detected. Try again closer to the microphone, or type your answer.' }); return; }
    // Pace and filler counts come from the transcript and the browser's recording length, unless the candidate
    // turned delivery feedback off. Only counts are kept, for the question that is still on screen.
    const recordedMs = Number(req.headers['x-recording-ms']);
    const measure = Number.isInteger(recordedMs) && recordedMs >= 1000 && recordedMs <= 330_000
      && (await User.findById(userId(req)).select('preferences'))?.preferences?.deliveryMetrics !== false;
    const delivery = measure ? analyzeDelivery(text, Math.round(recordedMs / 1000)) : undefined;
    if (delivery) {
      const questionIndex = doc.turns.length;
      const { seconds, words, fillers, version } = delivery;
      await Interview.updateOne({ _id: doc._id, userId: userId(req), status: 'in_progress', [`turns.${questionIndex}`]: { $exists: false } },
        { $push: { deliveryClips: { $each: [{ questionIndex, seconds, words, fillers, version, createdAt: new Date() }], $slice: -50 } } });
    }
    res.json({ transcript: text, ...(delivery ? { delivery } : {}) });
  } catch (err) { next(err); }
});
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
    const { documentIds: requested = [], ...fields } = parsed.data;
    const input = { ...fields, mode: fields.mode || interviewMode() };
    const ids = [...new Set(requested)];
    const documents = ids.length ? await groundingDocuments(userId(req), ids) : [];
    if (ids.length && input.mode !== 'ai') { res.status(400).json({ error: 'Tailoring to a resume or job description needs an AI interview.' }); return; }
    if (documents.length !== ids.length) { res.status(400).json({ error: 'Choose documents from your saved resumes and job descriptions.' }); return; }
    if (new Set(documents.map(d => d.kind)).size !== documents.length) { res.status(400).json({ error: 'Choose at most one resume and one job description.' }); return; }
    if (input.mode === 'ai') await requireAIConsent(userId(req));
    await consumeQuota(userId(req), 'daily interview starts', quotaLimit('INTERVIEWS_PER_DAY', 20), 86400_000);
    if (input.mode === 'ai') await consumeAIQuota(userId(req));
    const id = new mongoose.Types.ObjectId();
    const first = await generateQuestion({ ...input, documents, usageContext: { userId: userId(req), interviewId: id.toString() }, turnIndex: 0, history: [] });
    if (!await User.exists({ _id: userId(req), deletionRequestedAt: { $exists: false } })) { res.sendStatus(401); return; }
    let doc = await Interview.create({ _id: id, userId: userId(req), ...input, documentIds: documents.map(d => d.id), status: 'in_progress', currentQuestion: first.question, currentTopic: first.topic, currentQuestionId: first.questionId, currentQuestionGeneration: first.generation, currentQuestionGrounding: first.grounding, questionStartedAt: new Date(), pausedMs: 0, turns: [] });
    // A document deleted while the first question was generated must not survive in the new interview.
    if (documents.length) {
      const live = new Set((await groundingDocuments(userId(req), ids)).map(d => d.id.toString()));
      const gone = documents.filter(d => !live.has(d.id.toString())).map(d => d.id);
      if (gone.length) { await removeDerivedQuestions(userId(req), gone, id); doc = (await Interview.findById(id))!; }
    }
    res.status(201).json(view(doc));
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.json(view(doc));
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
      res.json({ ...view(doc), replayed: true }); return;
    }
    if (doc.status !== 'in_progress') { res.status(409).json({ error: 'This interview is already complete.' }); return; }
    if (doc.turns.length !== parsed.data.questionIndex) {
      res.status(409).json({ error: 'This question has already changed. Reload the interview before answering.' }); return;
    }
    if (doc.processingState !== 'ready') {
      res.status(409).json({ error: 'Your previous answer is saved and is still being processed.' }); return;
    }
    // Time on this question, excluding paused time; a paused clock stops at the moment it was paused.
    const answeredAt = new Date();
    const pausedMs = (doc.pausedMs ?? 0) + (doc.pausedAt ? answeredAt.getTime() - doc.pausedAt.getTime() : 0);
    const elapsedSeconds = doc.questionStartedAt
      ? Math.max(0, Math.round((answeredAt.getTime() - doc.questionStartedAt.getTime() - pausedMs) / 1000)) : undefined;
    const turn = { question: doc.currentQuestion, answer: parsed.data.answer, topic: doc.currentTopic,
      answeredAt, submissionId: parsed.data.submissionId, questionIndex: parsed.data.questionIndex,
      questionId: doc.currentQuestionId, questionGeneration: doc.currentQuestionGeneration, grounding: doc.currentQuestionGrounding,
      elapsedSeconds, pausedSeconds: doc.questionStartedAt ? Math.round(pausedMs / 1000) : undefined,
      overTime: doc.timeLimitSeconds !== undefined && elapsedSeconds !== undefined ? elapsedSeconds > doc.timeLimitSeconds : undefined };
    // Matching the question copied above rejects the answer if a document deletion just removed it.
    const updated = await Interview.findOneAndUpdate(
      { _id: doc._id, userId: userId(req), status: 'in_progress', currentQuestion: doc.currentQuestion,
        $or: [{ processingState: 'ready' }, { processingState: { $exists: false } }],
        [`turns.${parsed.data.questionIndex}`]: { $exists: false } },
      { $push: { turns: turn },
        $set: { processingState: 'queued', jobAttempts: 0, jobNextAttemptAt: new Date(), mode: doc.mode ?? interviewMode() },
        $unset: { processingError: 1, jobLeaseToken: 1, jobLeaseUntil: 1, pausedAt: 1 } },
      { new: true, runValidators: true },
    );
    if (!updated) { res.status(409).json({ error: 'This answer was already submitted. Refresh the interview.' }); return; }
    res.status(202).json(view(updated));
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
    res.status(202).json(view(doc));
  } catch (err) { next(err); }
});
// Pause stops a timed question's clock; resume adds the paused span to pausedMs. Both are idempotent.
router.post('/:id/pause', timerLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const owner = { _id: req.params.id, userId: userId(req) };
    const doc = await Interview.findOneAndUpdate({ ...owner, status: 'in_progress', processingState: 'ready',
      timeLimitSeconds: { $exists: true }, pausedAt: { $exists: false } }, { $set: { pausedAt: new Date() } }, { new: true });
    if (doc) { res.json(view(doc)); return; }
    const existing = await Interview.findOne(owner);
    if (!existing) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (existing.pausedAt) { res.json(view(existing)); return; }
    res.status(409).json({ error: 'Only a timed question that is on screen can be paused.' });
  } catch (err) { next(err); }
});
router.post('/:id/resume', timerLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const owner = { _id: req.params.id, userId: userId(req) };
    const existing = await Interview.findOne(owner);
    if (!existing) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (!existing.pausedAt) { res.json(view(existing)); return; }
    const pausedFor = Math.max(0, Date.now() - existing.pausedAt.getTime());
    // Matching the exact pausedAt makes a duplicate resume a no-op instead of counting the pause twice.
    const doc = await Interview.findOneAndUpdate({ ...owner, pausedAt: existing.pausedAt },
      { $set: { pausedMs: (existing.pausedMs ?? 0) + pausedFor }, $unset: { pausedAt: 1 } }, { new: true })
      ?? await Interview.findOne(owner);
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.json(view(doc));
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
    const parsed = answerIndexSchema.safeParse(req.body);
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
// One STAR structure check per behavioral answer, generated synchronously like rewrites. Never changes a score.
router.post('/:id/star', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const parsed = answerIndexSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose an answer to check.' }); return; }
    const { questionIndex } = parsed.data;
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (doc.starChecks.some(c => c.questionIndex === questionIndex)) { res.json({ interview: doc, mode: doc.mode ?? interviewMode(), replayed: true }); return; }
    if (doc.type !== 'Behavioral' || doc.status !== 'completed' || doc.feedback?.source !== 'ai' || !doc.turns[questionIndex]) {
      res.status(409).json({ error: 'A STAR check is available for answers in completed AI behavioral interviews.' }); return;
    }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let check;
    try {
      check = await checkStar({ usageContext: { userId: userId(req), interviewId: doc.id }, role: doc.role, type: doc.type,
        difficulty: doc.difficulty, topic: doc.topic, turn: doc.turns[questionIndex] });
    } catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('star_check_failure', 'WARNING');
      res.status(502).json({ error: 'Your answer could not be checked. Please try again.' }); return;
    }
    const updated = await Interview.findOneAndUpdate({ _id: doc._id, userId: userId(req), 'starChecks.questionIndex': { $ne: questionIndex } },
      { $push: { starChecks: { questionIndex, ...check, createdAt: new Date() } } }, { new: true, runValidators: true })
      ?? await Interview.findOne({ _id: doc._id, userId: userId(req) });
    if (!updated) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.status(201).json({ interview: updated, mode: updated.mode ?? interviewMode() });
  } catch (err) { next(err); }
});
export default router;
