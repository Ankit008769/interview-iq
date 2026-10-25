import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { PLAN_MINUTES, StudyPlan } from '../models/Learning.js';
import { SKILL_BY_ID } from '../learning/skills.js';
import { consumeQuota } from '../services/quotas.js';
import { daysBetween, drillForSkill, learningOverview, localDay, planView, progressReport, validTimeZone } from '../services/learning.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
const planLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'study plan changes', 30, 900_000); next(); }
  catch (err) { next(err); }
};
const planSchema = z.object({
  interviewDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  focusTypes: z.array(z.enum(['Technical', 'Behavioral', 'HR'])).min(1).max(3),
  dailyMinutes: z.union(PLAN_MINUTES.map(m => z.literal(m)) as [z.ZodLiteral<10>, z.ZodLiteral<20>, z.ZodLiteral<30>]),
});

router.get('/overview', async (req, res, next) => {
  try { res.json(await learningOverview(userId(req), validTimeZone(req.get('x-time-zone')))); }
  catch (err) { next(err); }
});
// A drill for one skill the learner picked from the list, ready to start as an interview.
router.get('/drill', async (req, res, next) => {
  try {
    const skillId = typeof req.query.skillId === 'string' ? req.query.skillId : '';
    if (!SKILL_BY_ID.has(skillId)) { res.status(400).json({ error: 'Choose a skill from the list.' }); return; }
    res.json({ drill: await drillForSkill(userId(req), skillId) });
  } catch (err) { next(err); }
});
router.put('/plan', planLimit, async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    const timeZone = validTimeZone(req.get('x-time-zone'));
    const date = parsed.success ? new Date(`${parsed.data.interviewDate}T00:00:00Z`) : null;
    // The date must exist (no 31 February) and fall between today and a year from now in the learner's time zone.
    const daysLeft = date && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === parsed.data?.interviewDate
      ? daysBetween(localDay(new Date(), timeZone), parsed.data.interviewDate) : null;
    if (!parsed.success || daysLeft === null || daysLeft < 0 || daysLeft > 365) {
      res.status(400).json({ error: 'Choose an interview date within the next year, at least one interview type and 10, 20 or 30 minutes a day.' }); return;
    }
    const plan = await StudyPlan.findOneAndUpdate({ userId: userId(req) },
      { $set: { interviewDate: date, focusTypes: [...new Set(parsed.data.focusTypes)], dailyMinutes: parsed.data.dailyMinutes } },
      { upsert: true, new: true, runValidators: true });
    res.json({ plan: planView(plan, new Date(), timeZone) });
  } catch (err) { next(err); }
});
router.delete('/plan', planLimit, async (req, res, next) => {
  try { await StudyPlan.deleteOne({ userId: userId(req) }); res.json({ deleted: true }); }
  catch (err) { next(err); }
});
router.get('/report', async (req, res, next) => {
  try {
    const weeks = z.coerce.number().int().min(1).max(12).catch(4).parse(req.query.weeks ?? 4);
    res.json(await progressReport(userId(req), weeks, validTimeZone(req.get('x-time-zone'))));
  } catch (err) { next(err); }
});
export default router;
