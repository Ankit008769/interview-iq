import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { Assignment, Cohort, Invitation, Membership, Organization, ORG_ROLES, SHARING_VERSION, type IMembership, type OrgRole } from '../models/Organization.js';
import { User } from '../models/User.js';
import { INTERVIEW_STYLES } from '../models/Interview.js';
import { consumeQuota } from '../services/quotas.js';
import { orgAudit, type OrgAuditAction } from '../services/monitoring.js';
import { acceptInvitation, addPack, assignmentLink, cohortCsv, cohortReport, completions, createCohort, createOrg, deleteOrgData, DRIVE_PACKS, importInvitations, newJoinCode, OrgError,
  validSpec } from '../orgs/service.js';

const router = Router();
router.use(requireAuth);
const userId = (req: Request) => (req as unknown as AuthRequest).userId;
type OrgRequest = Request & { membership: IMembership & { _id: mongoose.Types.ObjectId } };
const limit = (name: string, max: number, windowMs: number): RequestHandler => async (req, _res, next) => {
  try { await consumeQuota(userId(req), name, max, windowMs); next(); } catch (err) { next(err); }
};
const STAFF: OrgRole[] = ['admin', 'coordinator'];
// Tenant isolation: every route below that names an organisation loads the caller's membership in it. A
// non-member gets 404 (the organisation's existence is not revealed); a member without the role gets 403.
const member = (roles: readonly OrgRole[] = ORG_ROLES) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const membership = mongoose.isValidObjectId(req.params.orgId) ? await Membership.findOne({ orgId: req.params.orgId, userId: userId(req) }).lean() : null;
    if (!membership) { res.status(404).json({ error: 'Organisation not found.' }); return; }
    if (!roles.includes(membership.role)) { res.status(403).json({ error: 'Your role in this organisation cannot do that.' }); return; }
    (req as OrgRequest).membership = membership as OrgRequest['membership'];
    next();
  } catch (err) { next(err); }
};
const orgId = (req: Request) => new mongoose.Types.ObjectId(req.params.orgId);
const cohortOf = (req: Request) => mongoose.isValidObjectId(req.params.cohortId) ? Cohort.findOne({ _id: req.params.cohortId, orgId: orgId(req) }).lean() : Promise.resolve(null);
const audit = (req: Request, action: OrgAuditAction, org: unknown, extra: { targetId?: string; count?: number } = {}) => orgAudit(action, { orgId: String(org), actorId: userId(req), ...extra });
const fail = (res: Response, err: unknown, next: NextFunction) => (err instanceof OrgError ? res.status(err.status).json({ error: err.message }) : next(err));

const SHARING_TEXT = 'Your placement office will see your name, email and roll number, which of their assignments you finished and when, your scores on them, your overall interview scores and your readiness index. They never see your answers, recordings, code, documents or projects. You can leave at any time.';
const specSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interview'), type: z.enum(['Technical', 'Behavioral', 'HR']), topic: z.string().trim().min(2).max(100),
    difficulty: z.enum(['Beginner', 'Intermediate', 'Advanced']), totalQuestions: z.number().int().min(2).max(5), style: z.enum(INTERVIEW_STYLES).optional() }),
  z.object({ kind: z.literal('coding'), problemId: z.string().max(80) }),
  z.object({ kind: z.literal('design'), promptId: z.string().max(80) }),
]);

// ---------------------------------------------------------------- the caller's own view

router.get('/', async (req, res, next) => {
  try {
    const [memberships, user] = await Promise.all([Membership.find({ userId: userId(req) }).lean(), User.findById(userId(req)).select('email emailVerifiedAt').lean()]);
    const orgs = await Organization.find({ _id: { $in: memberships.map(m => m.orgId) } }).select('name branding').lean();
    const invitations = user ? await Invitation.find({ email: user.email.toLowerCase() }).lean() : [];
    const invitingOrgs = await Organization.find({ _id: { $in: invitations.map(i => i.orgId) } }).select('name').lean();
    const name = new Map([...orgs, ...invitingOrgs].map(o => [String(o._id), o.name]));
    res.json({ sharing: { version: SHARING_VERSION, text: SHARING_TEXT }, emailVerified: !!user?.emailVerifiedAt,
      memberships: memberships.map(m => ({ orgId: String(m.orgId), name: name.get(String(m.orgId)), role: m.role, branding: orgs.find(o => String(o._id) === String(m.orgId))?.branding ?? {} })),
      invitations: invitations.map(i => ({ id: String(i._id), orgName: name.get(String(i.orgId)), role: i.role, createdAt: i.createdAt })),
      packs: DRIVE_PACKS.map(({ id, title, description, items }) => ({ id, title, description, items: items.map(i => ({ title: i.title, offsetDays: i.offsetDays })) })) });
  } catch (err) { next(err); }
});

// Assignments from every organisation the caller studies in, with whether they are done.
router.get('/assignments', async (req, res, next) => {
  try {
    const memberships = (await Membership.find({ userId: userId(req), role: 'student' }).lean()).filter(m => m.cohortIds.length);
    if (!memberships.length) { res.json({ assignments: [] }); return; }
    // The 200 latest by due date, shown soonest first.
    const assignments = (await Assignment.find({ $or: memberships.map(m => ({ orgId: m.orgId, cohortId: { $in: m.cohortIds } })) }).sort({ dueAt: -1 }).limit(200).lean()).reverse();
    const orgs = new Map((await Organization.find({ _id: { $in: memberships.map(m => m.orgId) } }).select('name').lean()).map(o => [String(o._id), o.name]));
    const me = new mongoose.Types.ObjectId(userId(req));
    const rows = await Promise.all(assignments.map(async a => {
      const done = (await completions(a, [me])).get(String(me));
      return { id: String(a._id), orgName: orgs.get(String(a.orgId)), title: a.title, spec: a.spec, dueAt: a.dueAt, link: assignmentLink(a.spec),
        done: !!done, completedAt: done?.completedAt, late: !!done && done.completedAt > a.dueAt, score: done?.score ?? null };
    }));
    res.json({ assignments: rows });
  } catch (err) { next(err); }
});

router.post('/', limit('organisations created', 5, 86_400_000), async (req, res, next) => {
  try {
    const name = z.string().trim().min(2).max(120).safeParse(req.body?.name);
    if (!name.success) { res.status(400).json({ error: 'Name the organisation (2 to 120 characters).' }); return; }
    const org = await createOrg(userId(req), name.data);
    audit(req, 'org_created', org._id);
    res.status(201).json({ org: { id: String(org._id), name: org.name, joinCode: org.joinCode } });
  } catch (err) { fail(res, err, next); }
});

// Joining always requires agreeing to the sharing terms shown with the join form. An organisation's code
// makes the person a student with no cohort; a cohort's code also places them in that cohort.
router.post('/join', limit('organisation joins', 20, 900_000), async (req, res, next) => {
  try {
    const body = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,12}$/), sharingVersion: z.literal(SHARING_VERSION), rollNumber: z.string().trim().max(40).optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Enter the join code and agree to what your placement office will see.' }); return; }
    const cohort = await Cohort.findOne({ joinCode: body.data.code }).select('orgId name').lean();
    const org = await Organization.findOne(cohort ? { _id: cohort.orgId } : { joinCode: body.data.code }).select('name').lean();
    if (!org) { res.status(404).json({ error: 'No organisation has that join code.' }); return; }
    await Membership.updateOne({ orgId: org._id, userId: userId(req) },
      { $setOnInsert: { role: 'student' }, $set: { sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date(), ...(body.data.rollNumber ? { rollNumber: body.data.rollNumber } : {}) },
        ...(cohort ? { $addToSet: { cohortIds: cohort._id } } : {}) }, { upsert: true });
    audit(req, 'member_joined', org._id, cohort ? { targetId: String(cohort._id) } : {});
    res.status(201).json({ orgId: String(org._id), name: org.name, ...(cohort ? { cohort: cohort.name } : {}) });
  } catch (err) { next(err); }
});
router.post('/invitations/:id/accept', async (req, res, next) => {
  try {
    if (req.body?.sharingVersion !== SHARING_VERSION) { res.status(400).json({ error: 'Agree to what your placement office will see.' }); return; }
    const joined = await acceptInvitation(userId(req), req.params.id);
    audit(req, 'invitation_accepted', joined);
    res.json({ orgId: String(joined) });
  } catch (err) { fail(res, err, next); }
});
router.delete('/invitations/:id', async (req, res, next) => {
  try {
    const user = await User.findById(userId(req)).select('email').lean();
    const deleted = mongoose.isValidObjectId(req.params.id) && user ? await Invitation.deleteOne({ _id: req.params.id, email: user.email.toLowerCase() }) : null;
    if (!deleted?.deletedCount) { res.status(404).json({ error: 'Invitation not found.' }); return; }
    res.json({ declined: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- one organisation

router.get('/:orgId', member(), async (req, res, next) => {
  try {
    const { membership } = req as OrgRequest;
    const org = await Organization.findById(orgId(req)).lean();
    if (!org) { res.status(404).json({ error: 'Organisation not found.' }); return; }
    const staff = STAFF.includes(membership.role);
    const cohorts = await Cohort.find({ orgId: org._id, ...(staff ? {} : { _id: { $in: membership.cohortIds } }) }).sort({ name: 1 }).lean();
    const counts = staff ? await Membership.aggregate([{ $match: { orgId: org._id, role: 'student' } }, { $unwind: '$cohortIds' }, { $group: { _id: '$cohortIds', n: { $sum: 1 } } }]) : [];
    res.json({ org: { id: String(org._id), name: org.name, branding: org.branding ?? {}, role: membership.role, ...(staff ? { joinCode: org.joinCode } : {}) },
      cohorts: cohorts.map(c => ({ id: String(c._id), name: c.name, ...(staff ? { joinCode: c.joinCode, students: counts.find(x => String(x._id) === String(c._id))?.n ?? 0 } : {}) })),
      ...(staff ? { members: await Membership.countDocuments({ orgId: org._id }), invitations: await Invitation.countDocuments({ orgId: org._id }) } : {}) });
  } catch (err) { next(err); }
});

router.patch('/:orgId', member(['admin']), async (req, res, next) => {
  try {
    const body = z.object({ name: z.string().trim().min(2).max(120).optional(),
      branding: z.object({ displayName: z.string().trim().max(60).optional(), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Use a name of 2 to 120 characters and a colour like #4f46e5.' }); return; }
    const org = await Organization.findByIdAndUpdate(orgId(req), { $set: { ...(body.data.name ? { name: body.data.name } : {}), ...(body.data.branding ? { branding: body.data.branding } : {}) } }, { new: true, runValidators: true });
    audit(req, 'org_updated', org!._id);
    res.json({ org: { id: String(org!._id), name: org!.name, branding: org!.branding ?? {} } });
  } catch (err) { next(err); }
});
router.post('/:orgId/join-code', member(['admin']), async (req, res, next) => {
  try { const org = await Organization.findByIdAndUpdate(orgId(req), { $set: { joinCode: newJoinCode() } }, { new: true }); audit(req, 'org_join_code_rotated', org!._id); res.json({ joinCode: org!.joinCode }); }
  catch (err) { next(err); }
});
router.delete('/:orgId', member(['admin']), async (req, res, next) => {
  try { await deleteOrgData(orgId(req)); audit(req, 'org_deleted', orgId(req)); res.json({ deleted: true }); } catch (err) { next(err); }
});
// Leaving stops sharing at once. The last admin cannot leave an organisation that still has other members.
router.delete('/:orgId/membership', member(), async (req, res, next) => {
  try {
    const { membership } = req as OrgRequest;
    if (membership.role === 'admin' && !await Membership.exists({ orgId: orgId(req), role: 'admin', userId: { $ne: membership.userId } })
      && await Membership.exists({ orgId: orgId(req), userId: { $ne: membership.userId } })) {
      res.status(409).json({ error: 'Make someone else an admin, or delete the organisation, before leaving.' }); return;
    }
    await Membership.deleteOne({ _id: membership._id });
    audit(req, 'member_left', orgId(req));
    if (!await Membership.exists({ orgId: orgId(req) })) await deleteOrgData(orgId(req));
    res.json({ left: true });
  } catch (err) { next(err); }
});

router.get('/:orgId/members', member(STAFF), async (req, res, next) => {
  try {
    const members = await Membership.find({ orgId: orgId(req) }).sort({ role: 1, createdAt: 1 }).lean();
    const users = new Map((await User.find({ _id: { $in: members.map(m => m.userId) } }).select('name email').lean()).map(u => [String(u._id), u]));
    const invitations = await Invitation.find({ orgId: orgId(req) }).sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ members: members.map(m => ({ userId: String(m.userId), name: users.get(String(m.userId))?.name, email: users.get(String(m.userId))?.email, role: m.role,
      rollNumber: m.rollNumber ?? '', cohortIds: m.cohortIds.map(String), joinedAt: m.createdAt })),
      invitations: invitations.map(i => ({ id: String(i._id), email: i.email, name: i.name, role: i.role, cohortId: i.cohortId ? String(i.cohortId) : null, rollNumber: i.rollNumber })) });
  } catch (err) { next(err); }
});
router.patch('/:orgId/members/:userId', member(['admin']), async (req, res, next) => {
  try {
    const body = z.object({ role: z.enum(ORG_ROLES).optional(), cohortIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(20).optional() }).safeParse(req.body);
    if (!body.success || !mongoose.isValidObjectId(req.params.userId)) { res.status(400).json({ error: 'Choose a role and cohorts.' }); return; }
    if (body.data.cohortIds && await Cohort.countDocuments({ orgId: orgId(req), _id: { $in: body.data.cohortIds } }) !== new Set(body.data.cohortIds).size) {
      res.status(400).json({ error: 'Choose cohorts from this organisation.' }); return;
    }
    const target = await Membership.findOne({ orgId: orgId(req), userId: req.params.userId });
    if (!target) { res.status(404).json({ error: 'Member not found.' }); return; }
    // Only students agreed to share their progress, so staff cannot be turned into students.
    if (body.data.role === 'student' && target.role !== 'student') {
      res.status(409).json({ error: 'Staff cannot be made students. They can leave and join again with a code.' }); return;
    }
    if (target.role === 'admin' && body.data.role && body.data.role !== 'admin' && !await Membership.exists({ orgId: orgId(req), role: 'admin', _id: { $ne: target._id } })) {
      res.status(409).json({ error: 'An organisation needs at least one admin.' }); return;
    }
    await Membership.updateOne({ _id: target._id }, { $set: { ...(body.data.role ? { role: body.data.role } : {}), ...(body.data.cohortIds ? { cohortIds: [...new Set(body.data.cohortIds)] } : {}) } });
    audit(req, 'member_updated', orgId(req), { targetId: String(target.userId) });
    res.json({ updated: true });
  } catch (err) { next(err); }
});
router.delete('/:orgId/members/:userId', member(['admin']), async (req, res, next) => {
  try {
    const target = mongoose.isValidObjectId(req.params.userId) ? await Membership.findOne({ orgId: orgId(req), userId: req.params.userId }) : null;
    if (!target) { res.status(404).json({ error: 'Member not found.' }); return; }
    if (String(target.userId) === userId(req)) { res.status(409).json({ error: 'Use Leave to remove yourself.' }); return; }
    await Membership.deleteOne({ _id: target._id });
    audit(req, 'member_removed', orgId(req), { targetId: String(target.userId) });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// Bulk onboarding from a CSV (sent as text/csv or as { csv }).
router.post('/:orgId/invitations/import', member(STAFF), limit('invitation imports', 20, 86_400_000), express.text({ type: 'text/csv', limit: '512kb' }), async (req, res, next) => {
  try {
    const csv = typeof req.body === 'string' ? req.body : typeof req.body?.csv === 'string' ? req.body.csv : '';
    if (!csv.trim()) { res.status(400).json({ error: 'Send the CSV with an email column.' }); return; }
    const result = await importInvitations(orgId(req), csv, userId(req), (req as OrgRequest).membership.role);
    audit(req, 'invitations_imported', orgId(req), { count: result.invited + result.updated + result.alreadyMembers });
    res.status(201).json(result);
  } catch (err) { fail(res, err, next); }
});
router.delete('/:orgId/invitations/:invitationId', member(STAFF), async (req, res, next) => {
  try {
    const deleted = mongoose.isValidObjectId(req.params.invitationId) ? await Invitation.deleteOne({ _id: req.params.invitationId, orgId: orgId(req) }) : null;
    if (!deleted?.deletedCount) { res.status(404).json({ error: 'Invitation not found.' }); return; }
    audit(req, 'invitation_cancelled', orgId(req));
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/:orgId/cohorts', member(STAFF), async (req, res, next) => {
  try {
    const name = z.string().trim().min(2).max(80).safeParse(req.body?.name);
    if (!name.success) { res.status(400).json({ error: 'Name the cohort (2 to 80 characters).' }); return; }
    const cohort = await createCohort(orgId(req), name.data);
    audit(req, 'cohort_created', orgId(req), { targetId: String(cohort._id) });
    res.status(201).json({ cohort: { id: String(cohort._id), name: cohort.name, joinCode: cohort.joinCode } });
  } catch (err) { fail(res, err, next); }
});
router.delete('/:orgId/cohorts/:cohortId', member(['admin']), async (req, res, next) => {
  try {
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    await Assignment.deleteMany({ orgId: orgId(req), cohortId: cohort._id });
    await Membership.updateMany({ orgId: orgId(req) }, { $pull: { cohortIds: cohort._id } });
    await Cohort.deleteOne({ _id: cohort._id });
    audit(req, 'cohort_deleted', orgId(req), { targetId: String(cohort._id) });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.get('/:orgId/cohorts/:cohortId', member(STAFF), async (req, res, next) => {
  try {
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    res.json({ cohort: { id: String(cohort._id), name: cohort.name, joinCode: cohort.joinCode }, ...await cohortReport(orgId(req), cohort._id) });
  } catch (err) { next(err); }
});
router.post('/:orgId/cohorts/:cohortId/join-code', member(STAFF), async (req, res, next) => {
  try {
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    const updated = await Cohort.findByIdAndUpdate(cohort._id, { $set: { joinCode: newJoinCode() } }, { new: true });
    audit(req, 'cohort_join_code_rotated', orgId(req), { targetId: String(cohort._id) });
    res.json({ joinCode: updated!.joinCode });
  } catch (err) { next(err); }
});
router.get('/:orgId/cohorts/:cohortId/export.csv', member(STAFF), async (req, res, next) => {
  try {
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    audit(req, 'cohort_exported', orgId(req), { targetId: String(cohort._id) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${cohort.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'cohort'}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + cohortCsv(await cohortReport(orgId(req), cohort._id)));
  } catch (err) { next(err); }
});
router.post('/:orgId/cohorts/:cohortId/assignments', member(STAFF), async (req, res, next) => {
  try {
    const body = z.object({ title: z.string().trim().min(2).max(120), spec: specSchema, dueAt: z.string().datetime() }).safeParse(req.body);
    if (!body.success || !validSpec(body.data.spec)) { res.status(400).json({ error: 'Give the assignment a title, a valid task and a due date.' }); return; }
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    const assignment = await Assignment.create({ orgId: orgId(req), cohortId: cohort._id, title: body.data.title, spec: body.data.spec, dueAt: new Date(body.data.dueAt), createdBy: userId(req) });
    audit(req, 'assignment_created', orgId(req), { targetId: String(assignment._id) });
    res.status(201).json({ assignment: { id: String(assignment._id), title: assignment.title } });
  } catch (err) { next(err); }
});
router.post('/:orgId/cohorts/:cohortId/packs', member(STAFF), async (req, res, next) => {
  try {
    const body = z.object({ packId: z.string().max(40), startAt: z.string().datetime().optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Choose a preparation pack.' }); return; }
    const cohort = await cohortOf(req);
    if (!cohort) { res.status(404).json({ error: 'Cohort not found.' }); return; }
    const created = await addPack(orgId(req), cohort._id, body.data.packId, body.data.startAt ? new Date(body.data.startAt) : new Date(), userId(req));
    audit(req, 'pack_added', orgId(req), { targetId: String(cohort._id), count: created.length });
    res.status(201).json({ created: created.length });
  } catch (err) { fail(res, err, next); }
});
router.delete('/:orgId/assignments/:assignmentId', member(STAFF), async (req, res, next) => {
  try {
    const deleted = mongoose.isValidObjectId(req.params.assignmentId) ? await Assignment.deleteOne({ _id: req.params.assignmentId, orgId: orgId(req) }) : null;
    if (!deleted?.deletedCount) { res.status(404).json({ error: 'Assignment not found.' }); return; }
    audit(req, 'assignment_deleted', orgId(req), { targetId: req.params.assignmentId });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

export default router;
