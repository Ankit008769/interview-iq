import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Assignment, Cohort, Invitation, Membership, Organization, SHARING_VERSION, type AssignmentSpec, type IAssignment, type OrgRole } from '../models/Organization.js';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { CodeRun } from '../models/CodeRun.js';
import { DesignSession } from '../models/DesignSession.js';
import { SkillState } from '../models/Learning.js';
import { SKILLS } from '../learning/skills.js';
import { current, readiness } from '../learning/model.js';
import { PROBLEM_BY_ID } from '../coding/problems.js';
import { DESIGN_PROMPT_BY_ID } from '../design/prompts.js';

type Id = mongoose.Types.ObjectId;
const oid = (id: string | Id) => new mongoose.Types.ObjectId(String(id));
export class OrgError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export const MAX_ORGS_CREATED = 2;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newJoinCode = () => [...randomBytes(8)].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

export async function createOrg(userId: string, name: string) {
  if (await Organization.countDocuments({ createdBy: userId }) >= MAX_ORGS_CREATED) throw new OrgError(`You can create up to ${MAX_ORGS_CREATED} organisations.`, 409);
  const org = await Organization.create({ name, joinCode: newJoinCode(), createdBy: userId });
  await Membership.create({ orgId: org._id, userId, role: 'admin', sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date() });
  return org;
}

export const MAX_COHORTS = 100;
export async function createCohort(orgId: Id, name: string) {
  if (await Cohort.countDocuments({ orgId }) >= MAX_COHORTS) throw new OrgError(`An organisation can have up to ${MAX_COHORTS} cohorts.`, 409);
  return Cohort.create({ orgId, name, joinCode: newJoinCode() });
}

// Removes an organisation and everything that belongs to it.
export async function deleteOrgData(orgId: Id) {
  await Promise.all([Assignment.deleteMany({ orgId }), Cohort.deleteMany({ orgId }), Invitation.deleteMany({ orgId }), Membership.deleteMany({ orgId })]);
  await Organization.deleteOne({ _id: orgId });
}

// On account deletion: the person's memberships and invitations go; an organisation whose only admin they were
// goes too, because nobody could manage it (members keep all of their own practice data).
export async function removeUserFromOrgs(userId: Id, email?: string) {
  const adminOf = await Membership.find({ userId, role: 'admin' }).select('orgId').lean();
  for (const { orgId } of adminOf) {
    if (!await Membership.exists({ orgId, role: 'admin', userId: { $ne: userId } })) await deleteOrgData(orgId);
  }
  await Membership.deleteMany({ userId });
  if (email) await Invitation.deleteMany({ email: email.toLowerCase() });
}

// ---------------------------------------------------------------- assignments and progress

export function assignmentLink(spec: AssignmentSpec) {
  if (spec.kind === 'coding') return `/coding/${spec.problemId}`;
  if (spec.kind === 'design') return `/design/${spec.promptId}`;
  const params = new URLSearchParams({ type: spec.type, topic: spec.topic, difficulty: spec.difficulty, questions: String(spec.totalQuestions), ...(spec.style && spec.style !== 'general' ? { style: spec.style } : {}) });
  return `/interview/new?${params}`;
}
export function validSpec(spec: AssignmentSpec) {
  if (spec.kind === 'coding') return PROBLEM_BY_ID.has(spec.problemId);
  if (spec.kind === 'design') return DESIGN_PROMPT_BY_ID.has(spec.promptId);
  // Only what the interview setup page offers, so the assignment link opens it ready to start.
  return [2, 3, 5].includes(spec.totalQuestions)
    && (spec.type === 'Technical' ? INTERVIEW_TOPICS.includes(spec.topic) : spec.topic === (spec.type === 'Behavioral' ? 'Behavioral' : 'General'));
}
export const INTERVIEW_TOPICS = ['DSA', 'React', 'Node.js', 'DBMS'];

type Completion = { completedAt: Date; score: number | null };
// A design review's score: the mean of the criteria that had evidence, on 0–100 (null when none had).
export function designScore(criteria: { score?: number | null }[]) {
  const rated = criteria.filter(c => typeof c.score === 'number');
  return rated.length ? Math.round(rated.reduce((n, c) => n + c.score!, 0) / rated.length * 20) : null;
}
// The first qualifying record after the assignment was set: a completed AI interview with the same type,
// topic and difficulty, an accepted coding submission, or a reviewed design.
export async function completions(assignment: Pick<IAssignment, 'spec' | 'createdAt'>, userIds: Id[]): Promise<Map<string, Completion>> {
  const done = new Map<string, Completion>();
  const add = (userId: Id, at: Date, score: number | null) => { const k = String(userId); if (!done.has(k) || done.get(k)!.completedAt > at) done.set(k, { completedAt: at, score }); };
  const since = assignment.createdAt;
  const spec = assignment.spec;
  if (spec.kind === 'interview') {
    const docs = await Interview.find({ userId: { $in: userIds }, status: 'completed', 'feedback.source': 'ai', type: spec.type, topic: spec.topic, difficulty: spec.difficulty, completedAt: { $gte: since } })
      .select('userId completedAt feedback.score').lean();
    for (const d of docs) add(d.userId, d.completedAt!, d.feedback?.score ?? null);
  } else if (spec.kind === 'coding') {
    const runs = await CodeRun.find({ userId: { $in: userIds }, problemId: spec.problemId, mode: 'submit', verdict: 'accepted', createdAt: { $gte: since } }).select('userId createdAt').lean();
    for (const r of runs) add(r.userId, r.createdAt, 100);
  } else {
    // Ratings can change a reviewed session later, so the review's own time is the completion time.
    const sessions = await DesignSession.find({ userId: { $in: userIds }, promptId: spec.promptId, status: 'reviewed', 'review.createdAt': { $gte: since } }).select('userId review').lean();
    for (const s of sessions) if (s.review) add(s.userId, s.review.createdAt, designScore(s.review.criteria));
  }
  return done;
}

// Placement readiness index (0–100): skill readiness from adaptive learning (50%), assignments finished on time
// out of those already due (30%) and the average of the last five AI interview scores (20%). Parts with no data
// are left out and the weights rescaled. A practice signal for the placement office, never a hiring prediction.
export const READINESS_WEIGHTS = { skills: 0.5, assignments: 0.3, interviews: 0.2 };
export function readinessIndex(parts: { skills: number | null; assignments: number | null; interviews: number | null }) {
  const present = (Object.keys(READINESS_WEIGHTS) as (keyof typeof READINESS_WEIGHTS)[]).filter(k => parts[k] !== null);
  if (!present.length) return null;
  const weight = present.reduce((n, k) => n + READINESS_WEIGHTS[k], 0);
  return Math.round(present.reduce((n, k) => n + READINESS_WEIGHTS[k] * parts[k]!, 0) / weight);
}

async function skillReadiness(userIds: Id[], now: Date) {
  const states = await SkillState.find({ userId: { $in: userIds } }).select('userId skillId mean variance lastObservedAt').lean();
  const competency = new Set(SKILLS.filter(s => s.kind === 'competency').map(s => s.id));
  const byUser = new Map<string, { mean: number; variance: number; lastObservedAt?: Date }[]>();
  for (const s of states) if (competency.has(s.skillId)) byUser.set(String(s.userId), [...(byUser.get(String(s.userId)) ?? []), current(s, now)]);
  return new Map([...byUser].map(([k, v]) => [k, readiness(v)]));
}
async function recentScores(userIds: Id[]) {
  const rows = await Interview.aggregate([
    { $match: { userId: { $in: userIds }, status: 'completed', 'feedback.source': 'ai', 'feedback.score': { $type: 'number' } } },
    { $sort: { completedAt: -1 } },
    { $group: { _id: '$userId', scores: { $push: '$feedback.score' } } },
    { $project: { avg: { $avg: { $slice: ['$scores', 5] } } } },
  ]);
  return new Map(rows.map(r => [String(r._id), Math.round(r.avg)]));
}
async function lastActive(userIds: Id[]) {
  const [interviews, runs, designs] = await Promise.all([
    Interview.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: '$userId', at: { $max: '$updatedAt' } } }]),
    CodeRun.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: '$userId', at: { $max: '$createdAt' } } }]),
    DesignSession.aggregate([{ $match: { userId: { $in: userIds } } }, { $group: { _id: '$userId', at: { $max: '$updatedAt' } } }]),
  ]);
  const out = new Map<string, Date>();
  for (const r of [...interviews, ...runs, ...designs]) if (!out.has(String(r._id)) || out.get(String(r._id))! < r.at) out.set(String(r._id), r.at);
  return out;
}

export async function cohortReport(orgId: Id, cohortId: Id, now = new Date()) {
  const [members, assignments] = await Promise.all([
    Membership.find({ orgId, cohortIds: cohortId, role: 'student' }).select('userId rollNumber').lean(),
    Assignment.find({ orgId, cohortId }).sort({ dueAt: 1, _id: 1 }).lean(),
  ]);
  const userIds = members.map(m => m.userId);
  const [users, skills, scores, active, done] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('name email').lean(),
    skillReadiness(userIds, now), recentScores(userIds), lastActive(userIds),
    Promise.all(assignments.map(a => completions(a, userIds))),
  ]);
  const userById = new Map(users.map(u => [String(u._id), u]));
  const due = assignments.map((a, i) => ({ a, i })).filter(({ a }) => a.dueAt <= now);
  const students = members.map(m => {
    const key = String(m.userId);
    const onTime = due.filter(({ a, i }) => { const c = done[i].get(key); return c && c.completedAt <= a.dueAt; }).length;
    const parts = { skills: skills.get(key) ?? null, assignments: due.length ? Math.round(100 * onTime / due.length) : null, interviews: scores.get(key) ?? null };
    return { userId: key, name: userById.get(key)?.name ?? 'Deleted account', email: userById.get(key)?.email ?? '', rollNumber: m.rollNumber ?? '',
      readiness: readinessIndex(parts), parts, completed: done.filter(d => d.has(key)).length, onTime, lastActive: active.get(key) ?? null,
      assignments: assignments.map((a, i) => ({ id: String(a._id), done: done[i].has(key), late: !!done[i].get(key) && done[i].get(key)!.completedAt > a.dueAt, score: done[i].get(key)?.score ?? null })) };
  }).sort((x, y) => (y.readiness ?? -1) - (x.readiness ?? -1) || x.name.localeCompare(y.name));
  return {
    students,
    assignments: assignments.map((a, i) => ({ id: String(a._id), title: a.title, spec: a.spec, dueAt: a.dueAt, pack: a.pack, link: assignmentLink(a.spec),
      completed: done[i].size, onTime: [...done[i].values()].filter(c => c.completedAt <= a.dueAt).length, total: members.length })),
  };
}

// Spreadsheet cells that start with = + - @ (or a tab or carriage return) are formulas; prefix them so an
// export opened in Excel or Sheets can never run one.
export const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function cohortCsv(report: Awaited<ReturnType<typeof cohortReport>>) {
  const head = ['Name', 'Email', 'Roll number', 'Readiness index', 'Skill readiness', 'On-time completion %', 'Recent interview score', 'Assignments completed', 'Last active',
    ...report.assignments.map(a => a.title)];
  const rows = report.students.map(s => [s.name, s.email, s.rollNumber, s.readiness, s.parts.skills, s.parts.assignments, s.parts.interviews, s.completed, s.lastActive,
    ...s.assignments.map(a => (a.done ? (a.late ? 'late' : 'done') + (a.score !== null ? ` (${a.score})` : '') : ''))]);
  return [head, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- drive-preparation packs

type PackItem = { title: string; spec: AssignmentSpec; offsetDays: number };
export const DRIVE_PACKS: { id: string; title: string; description: string; items: PackItem[] }[] = [
  { id: 'services-drive', title: 'IT services drive', description: 'Fundamentals, a few easy coding problems and the HR round, over two weeks.', items: [
    { title: 'Technical basics: DSA', spec: { kind: 'interview', type: 'Technical', topic: 'DSA', difficulty: 'Beginner', totalQuestions: 3, style: 'services' }, offsetDays: 3 },
    { title: 'Coding: Two Sum', spec: { kind: 'coding', problemId: 'two-sum' }, offsetDays: 5 },
    { title: 'Coding: Valid Parentheses', spec: { kind: 'coding', problemId: 'valid-parentheses' }, offsetDays: 7 },
    { title: 'Technical basics: databases', spec: { kind: 'interview', type: 'Technical', topic: 'DBMS', difficulty: 'Beginner', totalQuestions: 3, style: 'services' }, offsetDays: 10 },
    { title: 'HR round', spec: { kind: 'interview', type: 'HR', topic: 'General', difficulty: 'Beginner', totalQuestions: 3 }, offsetDays: 14 },
  ] },
  { id: 'product-drive', title: 'Product company drive', description: 'Harder coding, one system design and depth-first technical rounds, over three weeks.', items: [
    { title: 'Coding: Merge Intervals', spec: { kind: 'coding', problemId: 'merge-intervals' }, offsetDays: 3 },
    { title: 'Coding: Longest Increasing Subsequence', spec: { kind: 'coding', problemId: 'longest-increasing-subsequence' }, offsetDays: 7 },
    { title: 'Technical depth: DSA', spec: { kind: 'interview', type: 'Technical', topic: 'DSA', difficulty: 'Advanced', totalQuestions: 3, style: 'product' }, offsetDays: 10 },
    { title: 'System design: URL shortener', spec: { kind: 'design', promptId: 'url-shortener' }, offsetDays: 14 },
    { title: 'Behavioural round', spec: { kind: 'interview', type: 'Behavioral', topic: 'Behavioral', difficulty: 'Intermediate', totalQuestions: 3, style: 'product' }, offsetDays: 21 },
  ] },
  { id: 'startup-drive', title: 'Startup drive', description: 'Practical, full-stack rounds and ownership stories, over two weeks.', items: [
    { title: 'Technical: Node.js', spec: { kind: 'interview', type: 'Technical', topic: 'Node.js', difficulty: 'Intermediate', totalQuestions: 3, style: 'startup' }, offsetDays: 3 },
    { title: 'Technical: React', spec: { kind: 'interview', type: 'Technical', topic: 'React', difficulty: 'Intermediate', totalQuestions: 3, style: 'startup' }, offsetDays: 6 },
    { title: 'Coding: Top K Frequent Elements', spec: { kind: 'coding', problemId: 'top-k-frequent' }, offsetDays: 9 },
    { title: 'Behavioural round: ownership', spec: { kind: 'interview', type: 'Behavioral', topic: 'Behavioral', difficulty: 'Intermediate', totalQuestions: 3, style: 'startup' }, offsetDays: 14 },
  ] },
];
export async function addPack(orgId: Id, cohortId: Id, packId: string, start: Date, createdBy: string) {
  const pack = DRIVE_PACKS.find(p => p.id === packId);
  if (!pack) throw new OrgError('Choose a preparation pack.');
  const day = 86_400_000;
  return Assignment.insertMany(pack.items.map(item => ({ orgId, cohortId, title: item.title, spec: item.spec, pack: pack.id,
    dueAt: new Date(start.getTime() + item.offsetDays * day), createdBy })));
}

// ---------------------------------------------------------------- bulk onboarding

const EMAIL = /^[^\s@,;]{1,64}@[^\s@,;]{1,190}\.[a-z]{2,}$/i;
function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; continue; }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

// CSV columns: email (required), name, cohort, roll_number, role (student or coordinator; admins are added
// in the app). People who are already members are moved into the cohort; everyone else gets an invitation
// that they accept after signing in with that email.
export async function importInvitations(orgId: Id, csv: string, invitedBy: string, inviterRole: OrgRole) {
  const rows = parseCsv(csv.replace(/^﻿/, ''));
  if (!rows.length) throw new OrgError('The CSV is empty.');
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (name: string) => header.indexOf(name);
  if (col('email') < 0) throw new OrgError('The first row must name the columns, including "email".');
  if (rows.length > 1001) throw new OrgError('Import at most 1,000 people at a time.');
  const cohorts = new Map((await Cohort.find({ orgId }).lean()).map(c => [c.name.toLowerCase(), c._id]));
  const result = { invited: 0, updated: 0, alreadyMembers: 0, cohortsCreated: 0, errors: [] as { line: number; error: string }[] };
  for (const [index, row] of rows.slice(1).entries()) {
    const line = index + 2;
    const get = (name: string) => (col(name) >= 0 ? (row[col(name)] ?? '').trim() : '');
    const email = get('email').toLowerCase();
    if (!EMAIL.test(email)) { result.errors.push({ line, error: 'Not a valid email address.' }); continue; }
    const role = (get('role') || 'student').toLowerCase();
    if (role !== 'student' && role !== 'coordinator') { result.errors.push({ line, error: 'Role must be student or coordinator.' }); continue; }
    if (role === 'coordinator' && inviterRole !== 'admin') { result.errors.push({ line, error: 'Only admins can invite coordinators.' }); continue; }
    const cohortName = get('cohort').slice(0, 80);
    let cohortId: Id | undefined;
    if (cohortName) {
      cohortId = cohorts.get(cohortName.toLowerCase());
      if (!cohortId) {
        try { cohortId = (await createCohort(orgId, cohortName))._id; } catch (err) { if (err instanceof OrgError) { result.errors.push({ line, error: err.message }); continue; } throw err; }
        cohorts.set(cohortName.toLowerCase(), cohortId); result.cohortsCreated++;
      }
    }
    const rollNumber = get('roll_number').slice(0, 40) || undefined;
    const user = await User.findOne({ email }).select('_id').lean();
    const member = user && await Membership.findOne({ orgId, userId: user._id });
    if (member) {
      await Membership.updateOne({ _id: member._id }, { ...(cohortId ? { $addToSet: { cohortIds: cohortId } } : {}), ...(rollNumber ? { $set: { rollNumber } } : {}) });
      result.alreadyMembers++; continue;
    }
    const existed = await Invitation.exists({ orgId, email });
    const name = get('name').slice(0, 120);
    const set = { role, invitedBy, ...(name ? { name } : {}), ...(cohortId ? { cohortId } : {}), ...(rollNumber ? { rollNumber } : {}) };
    const unset = { ...(name ? {} : { name: 1 }), ...(cohortId ? {} : { cohortId: 1 }), ...(rollNumber ? {} : { rollNumber: 1 }) };
    await Invitation.updateOne({ orgId, email }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true, runValidators: true });
    if (existed) result.updated++; else result.invited++;
  }
  return result;
}

export async function acceptInvitation(userId: string, invitationId: string) {
  const user = await User.findById(userId).select('email emailVerifiedAt').lean();
  // An invitation can carry a staff role, so only a verified owner of the invited address may accept it.
  if (user && !user.emailVerifiedAt) throw new OrgError('Verify your email address before accepting an invitation.', 403);
  const invitation = user && mongoose.isValidObjectId(invitationId) ? await Invitation.findOne({ _id: invitationId, email: user.email.toLowerCase() }) : null;
  if (!invitation) throw new OrgError('Invitation not found.', 404);
  await Membership.updateOne({ orgId: invitation.orgId, userId: oid(userId) },
    { $setOnInsert: { role: invitation.role, sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date() },
      ...(invitation.cohortId ? { $addToSet: { cohortIds: invitation.cohortId } } : {}), ...(invitation.rollNumber ? { $set: { rollNumber: invitation.rollNumber } } : {}) },
    { upsert: true });
  await Invitation.deleteOne({ _id: invitation._id });
  return invitation.orgId;
}
