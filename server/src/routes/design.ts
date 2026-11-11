import express, { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { DESIGN_FOLLOW_UPS, DesignSession, sanitizeScene, type IDesignSession } from '../models/DesignSession.js';
import { INTERVIEW_LANGUAGES } from '../models/Interview.js';
import { DESIGN_PROMPTS, DESIGN_PROMPT_BY_ID } from '../design/prompts.js';
import { analyzeGraph, sceneToGraph } from '../design/graph.js';
import { checkEstimates, referenceEstimates, scaleCard, STORAGE_UNITS } from '../design/estimates.js';
import { askConstraint, reviewDesign } from '../design/coach.js';
import { consumeAIQuota, consumeQuota } from '../services/quotas.js';
import { ConsentRequiredError, requireAIConsent } from '../services/providerConsent.js';
import { interviewMode } from '../services/ai.js';
import { operationalEvent } from '../services/monitoring.js';
import { DESIGN_RUBRIC } from '../services/rubrics.js';
import { requireCapability } from '../billing/entitlements.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
// Drawings are larger than other requests; this route has its own body limit (the app skips its global one).
export const designDraftBody = express.json({ limit: '1mb' });
const limit = (name: string, max: number, windowMs: number): RequestHandler => async (req, _res, next) => {
  try { await consumeQuota(userId(req), name, max, windowMs); next(); } catch (err) { next(err); }
};
const load = (req: any) => mongoose.isValidObjectId(req.params.id) ? DesignSession.findOne({ _id: req.params.id, userId: userId(req) }) : Promise.resolve(null);
const view = (s: InstanceType<typeof DesignSession>) => {
  const doc = s.toObject() as IDesignSession & { _id: mongoose.Types.ObjectId };
  return { ...doc, id: String(doc._id), promptTitle: DESIGN_PROMPT_BY_ID.get(doc.promptId)?.title };
};

router.get('/prompts', async (req, res, next) => {
  try {
    const progress = await DesignSession.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(userId(req)) } },
      { $group: { _id: '$promptId', sessions: { $sum: 1 }, reviewed: { $max: { $cond: [{ $eq: ['$status', 'reviewed'] }, 1, 0] } } } }]);
    const byId = new Map(progress.map(p => [p._id as string, p]));
    res.json({ prompts: DESIGN_PROMPTS.map(p => ({ id: p.id, title: p.title, difficulty: p.difficulty, summary: p.summary,
      sessions: byId.get(p.id)?.sessions ?? 0, reviewed: byId.get(p.id)?.reviewed === 1 })) });
  } catch (err) { next(err); }
});

// Requirement cards. Expected components, trade-offs and reference estimates are shown only after submitting.
router.get('/prompts/:id', async (req, res, next) => {
  try {
    const prompt = DESIGN_PROMPT_BY_ID.get(req.params.id);
    if (!prompt) { res.status(404).json({ error: 'Design problem not found.' }); return; }
    const sessions = await DesignSession.find({ userId: userId(req), promptId: prompt.id }).sort({ createdAt: -1, _id: -1 }).limit(10).select('status createdAt submittedAt review.createdAt').lean();
    res.json({ prompt: { id: prompt.id, title: prompt.title, difficulty: prompt.difficulty, summary: prompt.summary, functional: prompt.functional,
      nonFunctional: prompt.nonFunctional, scale: scaleCard(prompt), estimates: referenceEstimates(prompt).map(e => ({ id: e.id, label: e.label, unit: e.unit })),
      storageUnits: Object.keys(STORAGE_UNITS) },
      sessions: sessions.map(s => ({ ...s, id: String(s._id) })), rubric: DESIGN_RUBRIC });
  } catch (err) { next(err); }
});

router.post('/sessions', limit('design sessions', 30, 86_400_000), async (req, res, next) => {
  try {
    const prompt = DESIGN_PROMPT_BY_ID.get(String(req.body?.promptId ?? ''));
    if (!prompt) { res.status(400).json({ error: 'Choose a design problem.' }); return; }
    await requireCapability(userId(req), 'system_design');
    const session = await DesignSession.create({ userId: userId(req), promptId: prompt.id });
    res.status(201).json({ session: view(session) });
  } catch (err) { next(err); }
});

router.get('/sessions/:id', async (req, res, next) => {
  try {
    const session = await load(req);
    if (!session) { res.status(404).json({ error: 'Design session not found.' }); return; }
    res.json({ session: view(session) });
  } catch (err) { next(err); }
});

const draftSchema = z.object({
  scene: z.array(z.unknown()).max(5000).optional(),
  explanation: z.string().max(4000).optional(),
  estimates: z.object({ writeQps: z.number().positive().max(1e15).nullable().optional(), peakReadQps: z.number().positive().max(1e15).nullable().optional(),
    storagePerYear: z.object({ value: z.number().positive().max(1e9), unit: z.enum(['KB', 'MB', 'GB', 'TB', 'PB']) }).nullable().optional() }).optional(),
});
router.put('/sessions/:id/draft', limit('design saves', 240, 900_000), designDraftBody, async (req, res, next) => {
  try {
    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'The drawing, estimates or explanation could not be saved.' }); return; }
    const set: Record<string, unknown> = {};
    if (parsed.data.scene) set.scene = sanitizeScene(parsed.data.scene);
    if (parsed.data.explanation !== undefined) set.explanation = parsed.data.explanation;
    if (parsed.data.estimates) set.estimates = parsed.data.estimates;
    const session = mongoose.isValidObjectId(req.params.id)
      ? await DesignSession.findOneAndUpdate({ _id: req.params.id, userId: userId(req), status: 'drafting' }, { $set: set }, { new: true, runValidators: true }) : null;
    if (!session) {
      const exists = await load(req);
      res.status(exists ? 409 : 404).json({ error: exists ? 'This design was already submitted.' : 'Design session not found.' }); return;
    }
    res.json({ session: view(session) });
  } catch (err) { next(err); }
});

// Submitting fixes the design: the app reads the drawing and checks the estimates. No AI is involved.
router.post('/sessions/:id/submit', async (req, res, next) => {
  try {
    const session = await load(req);
    if (!session) { res.status(404).json({ error: 'Design session not found.' }); return; }
    if (session.status !== 'drafting') { res.json({ session: view(session), replayed: true }); return; }
    const prompt = DESIGN_PROMPT_BY_ID.get(session.promptId)!;
    const graph = sceneToGraph(session.scene);
    if (!graph.nodes.length && session.explanation.trim().length < 50) {
      res.status(400).json({ error: 'Draw at least one labelled component, or explain your design in at least 50 characters, before submitting.' }); return;
    }
    const updated = await DesignSession.findOneAndUpdate({ _id: session._id, userId: userId(req), status: 'drafting' },
      { $set: { status: 'submitted', submittedAt: new Date(), graph, analysis: analyzeGraph(graph, prompt), estimateCheck: checkEstimates(prompt, session.estimates ?? {}) } },
      { new: true }) ?? await load(req);
    res.json({ session: view(updated!), expected: prompt.expected, tradeoffs: prompt.tradeoffs });
  } catch (err) { next(err); }
});

const languageOf = (req: any) => z.enum(INTERVIEW_LANGUAGES).catch('en').parse(req.body?.language);
router.post('/sessions/:id/follow-ups', limit('interview requests', 40, 900_000), async (req, res, next) => {
  try {
    const session = await load(req);
    if (!session) { res.status(404).json({ error: 'Design session not found.' }); return; }
    if (session.status !== 'submitted') { res.status(409).json({ error: session.status === 'drafting' ? 'Submit your design first.' : 'This design has already been reviewed.' }); return; }
    if (session.followUps.length >= DESIGN_FOLLOW_UPS) { res.status(409).json({ error: 'Both follow-up questions have been asked.' }); return; }
    if (session.followUps.some(f => !f.answer)) { res.json({ session: view(session), replayed: true }); return; }
    if (interviewMode() !== 'ai') { res.status(409).json({ error: 'The AI interviewer is not enabled on this server.' }); return; }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    const index = session.followUps.length;
    let asked;
    try { asked = await askConstraint({ usageContext: { userId: userId(req) }, prompt: DESIGN_PROMPT_BY_ID.get(session.promptId)!, session, index, language: languageOf(req) }); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('design_follow_up_failure', 'WARNING');
      res.status(502).json({ error: 'The interviewer question could not be written. Please try again.' }); return;
    }
    // Only the first of two concurrent requests adds the question.
    const updated = await DesignSession.findOneAndUpdate({ _id: session._id, userId: userId(req), status: 'submitted', [`followUps.${index}`]: { $exists: false } },
      { $push: { followUps: { index, ...asked, askedAt: new Date() } } }, { new: true }) ?? await load(req);
    res.status(201).json({ session: view(updated!) });
  } catch (err) { next(err); }
});

router.post('/sessions/:id/follow-ups/:index/answer', limit('interview requests', 40, 900_000), async (req, res, next) => {
  try {
    const index = Number(req.params.index);
    const answer = z.string().trim().min(10).max(2000).safeParse(req.body?.answer);
    if (!answer.success || !Number.isInteger(index)) { res.status(400).json({ error: 'Answer in 10 to 2000 characters.' }); return; }
    const updated = mongoose.isValidObjectId(req.params.id) ? await DesignSession.findOneAndUpdate(
      { _id: req.params.id, userId: userId(req), status: 'submitted', followUps: { $elemMatch: { index, answer: { $exists: false } } } },
      { $set: { 'followUps.$.answer': answer.data, 'followUps.$.answeredAt': new Date() } }, { new: true }) : null;
    if (!updated) {
      const session = await load(req);
      if (!session) { res.status(404).json({ error: 'Design session not found.' }); return; }
      const followUp = session.followUps.find(f => f.index === index);
      if (followUp?.answer === answer.data) { res.json({ session: view(session), replayed: true }); return; }
      res.status(409).json({ error: followUp ? 'This question already has an answer.' : 'Ask for this question first.' }); return;
    }
    res.json({ session: view(updated) });
  } catch (err) { next(err); }
});

// How relevant each follow-up felt (1–5): the roadmap's measure for these questions.
router.post('/sessions/:id/follow-ups/:index/rating', limit('design ratings', 60, 900_000), async (req, res, next) => {
  try {
    const rating = z.number().int().min(1).max(5).safeParse(req.body?.rating);
    if (!rating.success) { res.status(400).json({ error: 'Rate from 1 to 5.' }); return; }
    const updated = mongoose.isValidObjectId(req.params.id) ? await DesignSession.findOneAndUpdate({ _id: req.params.id, userId: userId(req), 'followUps.index': Number(req.params.index) },
      { $set: { 'followUps.$.rating': rating.data } }, { new: true }) : null;
    if (!updated) { res.status(404).json({ error: 'Follow-up not found.' }); return; }
    res.json({ session: view(updated) });
  } catch (err) { next(err); }
});

router.post('/sessions/:id/review', limit('interview requests', 40, 900_000), async (req, res, next) => {
  try {
    const session = await load(req);
    if (!session) { res.status(404).json({ error: 'Design session not found.' }); return; }
    if (session.status === 'reviewed') { res.json({ session: view(session), replayed: true }); return; }
    if (session.status !== 'submitted' || session.followUps.length < DESIGN_FOLLOW_UPS || session.followUps.some(f => !f.answer)) {
      res.status(409).json({ error: 'Answer both follow-up questions before the review.' }); return;
    }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let review;
    try { review = await reviewDesign({ usageContext: { userId: userId(req) }, prompt: DESIGN_PROMPT_BY_ID.get(session.promptId)!, session, language: languageOf(req) }); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('design_review_failure', 'WARNING');
      res.status(502).json({ error: 'Your design could not be reviewed. Your answers are saved; please try again.' }); return;
    }
    const updated = await DesignSession.findOneAndUpdate({ _id: session._id, userId: userId(req), status: 'submitted' },
      { $set: { status: 'reviewed', review: { criteria: review.criteria, summary: review.summary, generation: review.generation, createdAt: new Date() } } }, { new: true }) ?? await load(req);
    res.status(201).json({ session: view(updated!) });
  } catch (err) { next(err); }
});

export default router;
