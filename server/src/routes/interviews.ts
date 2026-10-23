import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Interview } from '../models/Interview.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { evaluateInterview, generateQuestion, interviewMode } from '../services/ai.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
const makeSchema = z.object({
  role: z.string().trim().min(2).max(100),
  type: z.enum(['Technical', 'Behavioral', 'HR']),
  difficulty: z.enum(['Beginner', 'Intermediate', 'Advanced']),
  topic: z.string().trim().min(2).max(100),
  totalQuestions: z.number().int().min(2).max(5),
});
const answerSchema = z.object({ answer: z.string().trim().min(10).max(3500) });
const aiLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false });

router.get('/mode', (_req, res) => res.json({ mode: interviewMode() }));
router.get('/dashboard', async (req, res, next) => {
  try {
    const docs = await Interview.find({ userId: userId(req) }).select('role topic type status feedback createdAt totalQuestions').sort({ createdAt: -1 }).limit(100).lean();
    const scored = docs.filter(d => d.feedback?.source === 'ai' && typeof d.feedback.score === 'number');
    res.json({
      total: docs.length,
      completed: docs.filter(x => x.status === 'completed').length,
      averageScore: scored.length ? Math.round(scored.reduce((n, x) => n + (x.feedback?.score ?? 0), 0) / scored.length) : null,
      recent: docs.slice(0, 5),
    });
  } catch (err) { next(err); }
});
router.get('/', async (req, res, next) => {
  try {
    const docs = await Interview.find({ userId: userId(req) }).select('role topic type difficulty status feedback createdAt totalQuestions turns').sort({ createdAt: -1 }).limit(50).lean();
    res.json({ interviews: docs.map(x => ({ ...x, answered: x.turns.length, turns: undefined })) });
  } catch (err) { next(err); }
});
router.post('/', aiLimit, async (req, res, next) => {
  try {
    const parsed = makeSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose a valid role, topic, type, difficulty and number of questions.' }); return; }
    const input = parsed.data;
    const first = await generateQuestion({ ...input, turnIndex: 0, history: [] });
    const doc = await Interview.create({ userId: userId(req), ...input, status: 'in_progress', currentQuestion: first.question, currentTopic: first.topic, turns: [] });
    res.status(201).json({ interview: doc, mode: interviewMode() });
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    res.json({ interview: doc, mode: interviewMode() });
  } catch (err) { next(err); }
});
router.post('/:id/answer', aiLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.status(404).json({ error: 'Interview not found.' }); return; }
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Please write an answer between 10 and 3500 characters.' }); return; }
    const doc = await Interview.findOne({ _id: req.params.id, userId: userId(req) });
    if (!doc) { res.status(404).json({ error: 'Interview not found.' }); return; }
    if (doc.status !== 'in_progress') { res.status(409).json({ error: 'This interview is already complete.' }); return; }
    const history = [...doc.turns.map(t => ({ question: t.question, answer: t.answer, topic: t.topic, answeredAt: t.answeredAt })), {
      question: doc.currentQuestion, answer: parsed.data.answer, topic: doc.currentTopic, answeredAt: new Date(),
    }];
    const finished = history.length >= doc.totalQuestions;
    const result = finished
      ? await evaluateInterview({ role: doc.role, type: doc.type, difficulty: doc.difficulty, topic: doc.topic, history })
      : await generateQuestion({ role: doc.role, type: doc.type, difficulty: doc.difficulty, topic: doc.topic, turnIndex: history.length, history });
    // Atomic compare-and-update rejects duplicate submissions from retrying clients.
    const updated = await Interview.findOneAndUpdate(
      { _id: doc._id, userId: userId(req), status: 'in_progress', [`turns.${history.length - 1}`]: { $exists: false } },
      { $push: { turns: history[history.length - 1] },
        $set: finished
          ? { status: 'completed', completedAt: new Date(), feedback: result }
          : { currentQuestion: (result as {question: string}).question, currentTopic: (result as {topic: string}).topic },
      },
      { new: true, runValidators: true },
    );
    if (!updated) { res.status(409).json({ error: 'This answer was already submitted. Refresh the interview.' }); return; }
    res.json({ interview: updated, mode: interviewMode() });
  } catch (err) { next(err); }
});
export default router;
