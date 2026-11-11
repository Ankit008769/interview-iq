import mongoose from 'mongoose';
import { CampusLicence, Credit, Subscription } from '../models/Billing.js';
import { Membership } from '../models/Organization.js';
import { Interview } from '../models/Interview.js';
import { CAMPUS_VOICE_PER_YEAR, PLANS, type Capability, type Entitlements, type PlanId } from './plans.js';

// Entitlements (roadmap D5: "entitlements tied to quotas"). While BILLING_ENFORCEMENT is not "on" (the
// beta), nothing is blocked: everyone can use everything, and the Billing page shows what their plan would
// include. Limits count AI interviews started in the calendar month (India time); practice-bank interviews
// are free and unlimited. A voice interview is one in which at least one answer was transcribed.
export const enforcing = () => process.env.BILLING_ENFORCEMENT === 'on';
const oid = (id: string | mongoose.Types.ObjectId) => new mongoose.Types.ObjectId(String(id));
const DAY = 86_400_000;

export class EntitlementError extends Error {
  constructor(message: string, readonly capability: Capability | 'text_interviews' | 'voice_interviews', readonly plan: PlanId) { super(message); }
}

// The start of this month in India (UTC+5:30), as a Date.
export function monthStart(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3_600_000);
}

export async function currentPlan(userId: string, now = new Date()): Promise<{ plan: PlanId; source: 'subscription' | 'campus' | 'free'; until?: Date; orgId?: string }> {
  const sub = await Subscription.findOne({ userId: oid(userId), status: { $in: ['active', 'past_due', 'cancelled'] }, currentPeriodEnd: { $gt: now } })
    .sort({ plan: -1, currentPeriodEnd: -1 }).lean();
  // A cancelled subscription keeps working until its paid period ends; past_due gets the provider's retry window.
  if (sub && (sub.plan === 'pro_plus' || sub.plan === 'pro')) return { plan: sub.plan, source: 'subscription', until: sub.currentPeriodEnd };
  const memberships = await Membership.find({ userId: oid(userId), role: 'student' }).select('orgId').lean();
  if (memberships.length) {
    const licence = await CampusLicence.findOne({ orgId: { $in: memberships.map(m => m.orgId) }, startsAt: { $lte: now }, endsAt: { $gt: now } }).sort({ endsAt: -1 }).lean();
    if (licence && await seatHeld(licence.orgId, userId, licence.seats)) return { plan: 'campus', source: 'campus', until: licence.endsAt, orgId: String(licence.orgId) };
  }
  return { plan: 'free', source: 'free' };
}
// Seats go to the earliest-joined students, so a licence never covers more students than it paid for.
async function seatHeld(orgId: mongoose.Types.ObjectId, userId: string, seats: number) {
  const first = await Membership.find({ orgId, role: 'student' }).sort({ createdAt: 1, _id: 1 }).limit(seats).select('userId').lean();
  return first.some(m => String(m.userId) === String(userId));
}

export async function creditsAvailable(userId: string, now = new Date()) {
  const rows = await Credit.aggregate([{ $match: { userId: oid(userId), $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }, { voiceInterviews: { $lt: 0 } }] } },
    { $group: { _id: null, n: { $sum: '$voiceInterviews' } } }]);
  return Math.max(0, rows[0]?.n ?? 0);
}

export async function usage(userId: string, now = new Date()) {
  const plan = await currentPlan(userId, now);
  const entitlements: Entitlements = { plan: plan.plan, ...PLANS[plan.plan].entitlements };
  // Campus voice allowance is per licence year rather than per month.
  const voiceFrom = plan.plan === 'campus' ? new Date(now.getTime() - 365 * DAY) : monthStart(now);
  const [text, voice, credits] = await Promise.all([
    Interview.countDocuments({ userId: oid(userId), mode: 'ai', createdAt: { $gte: monthStart(now) } }),
    Interview.countDocuments({ userId: oid(userId), voiceUsedAt: { $gte: voiceFrom } }),
    creditsAvailable(userId, now),
  ]);
  const voiceLimit = plan.plan === 'campus' ? CAMPUS_VOICE_PER_YEAR : entitlements.voiceInterviews;
  return { ...plan, entitlements: { ...entitlements, voiceInterviews: voiceLimit }, used: { textInterviews: text, voiceInterviews: voice }, credits, enforcing: enforcing(), periodStart: monthStart(now) };
}

const needs = (capability: Capability): PlanId => (PLANS.pro.entitlements.capabilities.includes(capability) ? 'pro' : 'pro_plus');
const LABEL: Record<Capability, string> = { resume_jd: 'Tailoring to a resume or job description', delivery: 'Delivery feedback', indic_languages: 'Hindi and Hinglish interviews',
  coding_lab: 'The coding lab', system_design: 'System design', project_defense: 'Project defense', study_plan: 'The adaptive study plan' };

// Throws EntitlementError when enforcement is on and the plan does not include the capability.
export async function requireCapability(userId: string, capability: Capability) {
  if (!enforcing()) return;
  const { plan } = await currentPlan(userId);
  if (!PLANS[plan].entitlements.capabilities.includes(capability)) {
    throw new EntitlementError(`${LABEL[capability]} is part of ${PLANS[needs(capability)].name}.`, capability, needs(capability));
  }
}
export async function hasCapability(userId: string, capability: Capability) {
  if (!enforcing()) return true;
  return PLANS[(await currentPlan(userId)).plan].entitlements.capabilities.includes(capability);
}

// Before an AI interview starts.
export async function requireInterviewAllowance(userId: string) {
  if (!enforcing()) return;
  const u = await usage(userId);
  const limit = u.entitlements.textInterviews;
  if (limit !== null && u.used.textInterviews >= limit) {
    throw new EntitlementError(`You have used this month's ${limit} AI interviews on ${PLANS[u.plan].name}. Practice interviews stay unlimited.`, 'text_interviews', 'pro');
  }
}

// On the first transcribed answer of an interview: counts it as a voice interview, using a credit once the
// plan's allowance is used up. Returns false when neither is left (typing still works).
// With dryRun, only reports whether the interview may use voice, without counting it or spending a credit.
export async function claimVoiceInterview(userId: string, interviewId: string, now = new Date(), dryRun = false) {
  const doc = await Interview.findOne({ _id: interviewId, userId: oid(userId) }).select('voiceUsedAt').lean();
  if (!doc) return false;
  if (doc.voiceUsedAt) return true;
  if (enforcing()) {
    const u = await usage(userId, now);
    const limit = u.entitlements.voiceInterviews;
    if (limit !== null && u.used.voiceInterviews >= limit) {
      if (u.credits < 1) return false;
      if (dryRun) return true;
      try { await Credit.create({ userId: oid(userId), voiceInterviews: -1, reason: 'used', ref: `voice:${interviewId}` }); }
      catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
    }
  }
  if (!dryRun) await Interview.updateOne({ _id: interviewId, userId: oid(userId), voiceUsedAt: { $exists: false } }, { $set: { voiceUsedAt: now } });
  return true;
}
