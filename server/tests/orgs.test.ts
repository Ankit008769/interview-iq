import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { Assignment, Cohort, Invitation, Membership, Organization, SHARING_VERSION } from '../src/models/Organization.js';
import { User } from '../src/models/User.js';
import { Interview } from '../src/models/Interview.js';
import { CodeRun } from '../src/models/CodeRun.js';
import { DesignSession } from '../src/models/DesignSession.js';
import { assignmentLink, csvCell, designScore, DRIVE_PACKS, readinessIndex, removeUserFromOrgs, validSpec } from '../src/orgs/service.js';
import { reconcileDeletions } from '../src/services/deletionRestore.js';
import { QuotaBucket } from '../src/services/quotas.js';

process.env.JWT_SECRET = 'orgs-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const DAY = 86_400_000;

describe('readiness, specs and spreadsheet safety', () => {
  it('weights readiness 50/30/20 and rescales over the parts that have data', () => {
    expect(readinessIndex({ skills: 80, assignments: 50, interviews: 70 })).toBe(69);
    expect(readinessIndex({ skills: 80, assignments: null, interviews: 60 })).toBe(Math.round((0.5 * 80 + 0.2 * 60) / 0.7));
    expect(readinessIndex({ skills: null, assignments: 100, interviews: null })).toBe(100);
    expect(readinessIndex({ skills: null, assignments: null, interviews: null })).toBeNull();
  });
  it('scores a design review over the criteria that had evidence', () => {
    expect(designScore([{ score: 5 }, { score: 3 }, { score: null }])).toBe(80);
    expect(designScore([{ score: null }])).toBeNull();
  });
  it('neutralises spreadsheet formulas in exported cells', () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    for (const lead of ['+1', '-1', '@SUM(A1)', '\tx']) expect(csvCell(lead).replace(/^"/, '')).toMatch(/^'/);
    expect(csvCell('Asha, CSE')).toBe('"Asha, CSE"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });
  it('accepts only assignments the app can open ready to start, and every pack item is one', () => {
    for (const pack of DRIVE_PACKS) for (const item of pack.items) expect(validSpec(item.spec), `${pack.id}: ${item.title}`).toBe(true);
    expect(validSpec({ kind: 'interview', type: 'Technical', topic: 'Quantum', difficulty: 'Beginner', totalQuestions: 3 })).toBe(false);
    expect(validSpec({ kind: 'interview', type: 'HR', topic: 'DSA', difficulty: 'Beginner', totalQuestions: 3 })).toBe(false);
    expect(validSpec({ kind: 'interview', type: 'Technical', topic: 'DSA', difficulty: 'Beginner', totalQuestions: 4 })).toBe(false);
    expect(validSpec({ kind: 'coding', problemId: 'no-such-problem' })).toBe(false);
    expect(validSpec({ kind: 'design', promptId: 'url-shortener' })).toBe(true);
    expect(assignmentLink({ kind: 'interview', type: 'Technical', topic: 'Node.js', difficulty: 'Advanced', totalQuestions: 5, style: 'product' }))
      .toBe('/interview/new?type=Technical&topic=Node.js&difficulty=Advanced&questions=5&style=product');
    expect(assignmentLink({ kind: 'coding', problemId: 'two-sum' })).toBe('/coding/two-sum');
  });
});

describe('campus API', () => {
  let mongo: MongoMemoryServer;
  const admin = request.agent(app), coordinator = request.agent(app), student = request.agent(app), student2 = request.agent(app), outsider = request.agent(app);
  const ids: Record<string, string> = {};
  const join = (agent: typeof admin, code: string, extra: object = {}) => agent.post('/api/orgs/join').send({ code, sharingVersion: SHARING_VERSION, ...extra });
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    for (const [agent, name, email] of [[admin, 'Tara TPO', 'tpo@college.test'], [coordinator, 'Cole Coordinator', 'coord@college.test'], [student, 'Asha Verma', 'asha@college.test'],
      [student2, '=HYPERLINK("http://evil","x")', 'ravi@college.test'], [outsider, 'Other TPO', 'tpo@other.test']] as const) {
      const res = await agent.post('/api/auth/register').send({ name, email, password: 'test-password' }).expect(201);
      ids[email] = res.body.user?.id ?? res.body.user?._id ?? String((await User.findOne({ email }).lean())!._id);
    }
  }, 120_000);
  beforeEach(async () => {
    await Promise.all([Organization.deleteMany({}), Membership.deleteMany({}), Invitation.deleteMany({}), Cohort.deleteMany({}), Assignment.deleteMany({}),
      Interview.deleteMany({}), CodeRun.deleteMany({}), DesignSession.deleteMany({}), QuotaBucket.deleteMany({})]);
    await User.updateMany({}, { $unset: { emailVerifiedAt: 1 } });
  });
  afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

  async function setUp() {
    const org = (await admin.post('/api/orgs').send({ name: 'Govt Engineering College' }).expect(201)).body.org;
    const cohort = (await admin.post(`/api/orgs/${org.id}/cohorts`).send({ name: 'CSE 2027' }).expect(201)).body.cohort;
    const other = (await outsider.post('/api/orgs').send({ name: 'Other Institute' }).expect(201)).body.org;
    const otherCohort = (await outsider.post(`/api/orgs/${other.id}/cohorts`).send({ name: 'ECE 2027' }).expect(201)).body.cohort;
    return { org, cohort, other, otherCohort };
  }

  it('lets students join only after agreeing to the sharing terms, straight into a cohort with its code', async () => {
    const { org, cohort } = await setUp();
    expect(org.joinCode).toMatch(/^[A-Z2-9]{8}$/);
    await student.post('/api/orgs/join').send({ code: cohort.joinCode }).expect(400);
    await student.post('/api/orgs/join').send({ code: cohort.joinCode, sharingVersion: '2020-01-01.v0' }).expect(400);
    await join(student, 'ZZZZZZZZ').expect(404);
    expect((await join(student, cohort.joinCode.toLowerCase(), { rollNumber: '21CS001' }).expect(201)).body).toMatchObject({ orgId: org.id, cohort: 'CSE 2027' });
    await join(student2, org.joinCode).expect(201);
    const m = await Membership.findOne({ orgId: org.id, userId: ids['asha@college.test'] }).lean();
    expect(m).toMatchObject({ role: 'student', rollNumber: '21CS001', sharingVersion: SHARING_VERSION });
    expect(m!.cohortIds.map(String)).toEqual([cohort.id]);
    expect((await Membership.findOne({ orgId: org.id, userId: ids['ravi@college.test'] }).lean())!.cohortIds).toHaveLength(0);
    // Joining again does not change the role or duplicate the membership.
    await join(student, cohort.joinCode).expect(201);
    expect(await Membership.countDocuments({ orgId: org.id })).toBe(3);
    const mine = (await student.get('/api/orgs').expect(200)).body;
    expect(mine.memberships).toEqual([expect.objectContaining({ orgId: org.id, role: 'student', name: 'Govt Engineering College' })]);
    expect(mine.sharing).toMatchObject({ version: SHARING_VERSION, text: expect.stringContaining('never see your answers') });
    // Students see their own cohort without codes or counts; staff see codes.
    const asStudent = (await student.get(`/api/orgs/${org.id}`).expect(200)).body;
    expect(asStudent.org.joinCode).toBeUndefined();
    expect(asStudent.cohorts).toEqual([{ id: cohort.id, name: 'CSE 2027' }]);
    const asAdmin = (await admin.get(`/api/orgs/${org.id}`).expect(200)).body;
    expect(asAdmin.org).toMatchObject({ joinCode: org.joinCode, branding: {}, role: 'admin' });
    expect(asAdmin.cohorts[0]).toMatchObject({ joinCode: cohort.joinCode, students: 1 });
  });

  it('keeps every organisation\'s data to its own members and roles', async () => {
    const { org, cohort, other, otherCohort } = await setUp();
    await join(student, cohort.joinCode).expect(201);
    const assignment = (await admin.post(`/api/orgs/${org.id}/cohorts/${cohort.id}/assignments`)
      .send({ title: 'Two Sum', spec: { kind: 'coding', problemId: 'two-sum' }, dueAt: new Date(Date.now() + DAY).toISOString() }).expect(201)).body.assignment;
    const studentId = ids['asha@college.test'];

    // Outsiders cannot tell the organisation exists.
    for (const path of [`/api/orgs/${org.id}`, `/api/orgs/${org.id}/members`, `/api/orgs/${org.id}/cohorts/${cohort.id}`, `/api/orgs/${org.id}/cohorts/${cohort.id}/export.csv`]) {
      await outsider.get(path).expect(404);
    }
    await outsider.patch(`/api/orgs/${org.id}`).send({ name: 'Mine now' }).expect(404);
    await outsider.post(`/api/orgs/${org.id}/cohorts`).send({ name: 'Sneaky' }).expect(404);
    await outsider.delete(`/api/orgs/${org.id}`).expect(404);
    await outsider.get('/api/orgs/not-an-id').expect(404);
    // An admin of another organisation cannot reach this one's records through their own organisation's routes.
    await outsider.get(`/api/orgs/${other.id}/cohorts/${cohort.id}`).expect(404);
    await outsider.post(`/api/orgs/${other.id}/cohorts/${cohort.id}/assignments`).send({ title: 'Xyz', spec: { kind: 'coding', problemId: 'two-sum' }, dueAt: new Date().toISOString() }).expect(404);
    await outsider.delete(`/api/orgs/${other.id}/assignments/${assignment.id}`).expect(404);
    await outsider.patch(`/api/orgs/${other.id}/members/${studentId}`).send({ role: 'admin' }).expect(404);
    await outsider.delete(`/api/orgs/${other.id}/members/${studentId}`).expect(404);
    await outsider.post(`/api/orgs/${other.id}/cohorts/${cohort.id}/join-code`).expect(404);
    await admin.patch(`/api/orgs/${org.id}/members/${studentId}`).send({ cohortIds: [otherCohort.id] }).expect(400);
    expect(await Assignment.countDocuments({ _id: assignment.id })).toBe(1);

    // Students cannot use staff routes.
    for (const path of [`/api/orgs/${org.id}/members`, `/api/orgs/${org.id}/cohorts/${cohort.id}`, `/api/orgs/${org.id}/cohorts/${cohort.id}/export.csv`]) await student.get(path).expect(403);
    await student.post(`/api/orgs/${org.id}/cohorts/${cohort.id}/assignments`).send({ title: 'X', spec: { kind: 'coding', problemId: 'two-sum' }, dueAt: new Date().toISOString() }).expect(403);
    await student.post(`/api/orgs/${org.id}/invitations/import`).set('Content-Type', 'text/csv').send('email\nx@y.test').expect(403);
    await student.patch(`/api/orgs/${org.id}/members/${studentId}`).send({ role: 'admin' }).expect(403);

    // Coordinators run cohorts but cannot change roles, settings or invite coordinators.
    await Membership.create({ orgId: org.id, userId: ids['coord@college.test'], role: 'coordinator', sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date() });
    await coordinator.get(`/api/orgs/${org.id}/cohorts/${cohort.id}`).expect(200);
    await coordinator.patch(`/api/orgs/${org.id}/members/${studentId}`).send({ role: 'coordinator' }).expect(403);
    await admin.patch(`/api/orgs/${org.id}/members/${ids['coord@college.test']}`).send({ role: 'student' }).expect(409);
    await coordinator.patch(`/api/orgs/${org.id}`).send({ name: 'Renamed' }).expect(403);
    await coordinator.post(`/api/orgs/${org.id}/join-code`).expect(403);
    const imported = (await coordinator.post(`/api/orgs/${org.id}/invitations/import`).set('Content-Type', 'text/csv').send('email,role\nnew@college.test,coordinator\n').expect(201)).body;
    expect(imported).toMatchObject({ invited: 0, errors: [{ line: 2, error: 'Only admins can invite coordinators.' }] });
  });

  it('imports invitations from a CSV and lets only a verified owner of the address accept them', async () => {
    const { org } = await setUp();
    const csv = '﻿Email,Name,Cohort,Roll Number,Role\r\nasha@college.test,"Verma, Asha",CSE 2027,21CS001,student\r\nnot-an-email,x,,,\r\nnew@college.test,New,ECE 2027,,student\r\n'
      + 'cole@college.test,,,,coordinator\r\nbad@college.test,,,,admin\r\n';
    const result = (await admin.post(`/api/orgs/${org.id}/invitations/import`).set('Content-Type', 'text/csv').send(csv).expect(201)).body;
    expect(result).toMatchObject({ invited: 3, updated: 0, alreadyMembers: 0, cohortsCreated: 1 }); // CSE 2027 already exists
    expect(result.errors).toEqual([{ line: 3, error: 'Not a valid email address.' }, { line: 6, error: 'Role must be student or coordinator.' }]);
    // Importing again updates instead of duplicating, and the JSON form works too.
    expect((await admin.post(`/api/orgs/${org.id}/invitations/import`).send({ csv: 'email,roll_number\nasha@college.test,21CS009' }).expect(201)).body).toMatchObject({ invited: 0, updated: 1 });
    const invitation = await Invitation.findOne({ orgId: org.id, email: 'asha@college.test' }).lean();
    expect(invitation).toMatchObject({ rollNumber: '21CS009', role: 'student' });
    expect(invitation!.cohortId).toBeUndefined();
    await admin.post(`/api/orgs/${org.id}/invitations/import`).send({ csv: 'email,cohort,roll_number\nasha@college.test,CSE 2027,21CS001' }).expect(201);

    const mine = (await student.get('/api/orgs').expect(200)).body;
    expect(mine.emailVerified).toBe(false);
    expect(mine.invitations).toEqual([expect.objectContaining({ orgName: 'Govt Engineering College', role: 'student' })]);
    const id = mine.invitations[0].id;
    await student.post(`/api/orgs/invitations/${id}/accept`).send({ sharingVersion: SHARING_VERSION }).expect(403);
    await User.updateOne({ email: 'asha@college.test' }, { $set: { emailVerifiedAt: new Date() } });
    await student.post(`/api/orgs/invitations/${id}/accept`).send({}).expect(400);
    await User.updateOne({ email: 'tpo@other.test' }, { $set: { emailVerifiedAt: new Date() } });
    await outsider.post(`/api/orgs/invitations/${id}/accept`).send({ sharingVersion: SHARING_VERSION }).expect(404);
    await student.post(`/api/orgs/invitations/${id}/accept`).send({ sharingVersion: SHARING_VERSION }).expect(200);
    const m = await Membership.findOne({ orgId: org.id, userId: ids['asha@college.test'] }).lean();
    const cse = await Cohort.findOne({ orgId: org.id, name: 'CSE 2027' }).lean();
    expect(m).toMatchObject({ role: 'student', rollNumber: '21CS001' });
    expect(m!.cohortIds.map(String)).toEqual([String(cse!._id)]);
    expect(await Invitation.countDocuments({ email: 'asha@college.test' })).toBe(0);
    // Members already in the organisation are moved into the cohort instead of being invited again.
    expect((await admin.post(`/api/orgs/${org.id}/invitations/import`).send({ csv: 'email,cohort\nasha@college.test,ECE 2027' }).expect(201)).body).toMatchObject({ alreadyMembers: 1 });
    expect((await Membership.findOne({ orgId: org.id, userId: ids['asha@college.test'] }).lean())!.cohortIds).toHaveLength(2);
    // Declining removes only the caller's own invitation.
    await User.updateOne({ email: 'coord@college.test' }, { $set: { emailVerifiedAt: new Date() } });
    const coleInvite = await Invitation.findOne({ email: 'cole@college.test' }).lean();
    await coordinator.delete(`/api/orgs/invitations/${coleInvite!._id}`).expect(404);
    const members = (await admin.get(`/api/orgs/${org.id}/members`).expect(200)).body;
    expect(members.invitations.map((i: { email: string }) => i.email).sort()).toEqual(['cole@college.test', 'new@college.test']);
  });

  it('tracks assignments from the student\'s own records and reports cohort readiness', async () => {
    const { org, cohort } = await setUp();
    await join(student, cohort.joinCode, { rollNumber: '21CS001' }).expect(201);
    await join(student2, cohort.joinCode).expect(201);
    const due = (days: number) => new Date(Date.now() + days * DAY).toISOString();
    const post = (body: object) => admin.post(`/api/orgs/${org.id}/cohorts/${cohort.id}/assignments`).send(body);
    await post({ title: 'Bad topic', spec: { kind: 'interview', type: 'Technical', topic: 'Quantum', difficulty: 'Beginner', totalQuestions: 3 }, dueAt: due(3) }).expect(400);
    await post({ title: 'Bad problem', spec: { kind: 'coding', problemId: 'nope' }, dueAt: due(3) }).expect(400);
    await post({ title: 'DSA basics', spec: { kind: 'interview', type: 'Technical', topic: 'DSA', difficulty: 'Beginner', totalQuestions: 3, style: 'services' }, dueAt: due(3) }).expect(201);
    await post({ title: 'Two Sum', spec: { kind: 'coding', problemId: 'two-sum' }, dueAt: due(3) }).expect(201);
    await post({ title: 'URL shortener', spec: { kind: 'design', promptId: 'url-shortener' }, dueAt: due(3) }).expect(201);
    expect((await admin.post(`/api/orgs/${org.id}/cohorts/${cohort.id}/packs`).send({ packId: 'services-drive', startAt: new Date().toISOString() }).expect(201)).body.created)
      .toBe(DRIVE_PACKS.find(p => p.id === 'services-drive')!.items.length);
    await admin.post(`/api/orgs/${org.id}/cohorts/${cohort.id}/packs`).send({ packId: 'nope' }).expect(400);

    const asha = new mongoose.Types.ObjectId(ids['asha@college.test']);
    const base = { role: 'Developer', type: 'Technical', difficulty: 'Beginner', topic: 'DSA', totalQuestions: 3, mode: 'ai', status: 'completed', completedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
    // A practice-bank interview, a different level and one finished before the assignment existed do not count.
    await Interview.collection.insertMany([
      { ...base, userId: asha, feedback: { source: 'practice', score: null } },
      { ...base, userId: asha, difficulty: 'Advanced', feedback: { source: 'ai', score: 90 } },
      { ...base, userId: asha, completedAt: new Date(Date.now() - DAY), feedback: { source: 'ai', score: 95 } },
    ]);
    let mine = (await student.get('/api/orgs/assignments').expect(200)).body.assignments;
    expect(mine.find((a: { title: string }) => a.title === 'DSA basics')).toMatchObject({ done: false, link: '/interview/new?type=Technical&topic=DSA&difficulty=Beginner&questions=3&style=services' });
    await Interview.collection.insertOne({ ...base, userId: asha, feedback: { source: 'ai', score: 72 } });
    await CodeRun.collection.insertMany([{ userId: asha, problemId: 'two-sum', mode: 'run', verdict: 'accepted', createdAt: new Date() },
      { userId: asha, problemId: 'two-sum', mode: 'submit', verdict: 'accepted', createdAt: new Date() }]);
    await DesignSession.collection.insertOne({ userId: asha, promptId: 'url-shortener', status: 'reviewed', createdAt: new Date(), updatedAt: new Date(),
      review: { criteria: [{ score: 4 }, { score: 3 }, { score: null }], summary: 'ok', createdAt: new Date() } });
    mine = (await student.get('/api/orgs/assignments').expect(200)).body.assignments;
    const byTitle = (t: string) => mine.find((a: { title: string }) => a.title === t);
    expect(byTitle('DSA basics')).toMatchObject({ done: true, late: false, score: 72, orgName: 'Govt Engineering College' });
    expect(byTitle('Two Sum')).toMatchObject({ done: true, score: 100 });
    expect(byTitle('URL shortener')).toMatchObject({ done: true, score: 70 });
    // An outsider sees no assignments; a student with no cohort sees none either.
    expect((await outsider.get('/api/orgs/assignments').expect(200)).body.assignments).toEqual([]);

    const report = (await admin.get(`/api/orgs/${org.id}/cohorts/${cohort.id}`).expect(200)).body;
    expect(report.cohort).toMatchObject({ id: cohort.id, joinCode: cohort.joinCode });
    const row = report.students.find((s: { email: string }) => s.email === 'asha@college.test');
    // Nothing is due yet, so readiness rests on the recent AI interview average (72, 90, 95 → 86).
    expect(row).toMatchObject({ name: 'Asha Verma', rollNumber: '21CS001', completed: 5, parts: { skills: null, assignments: null, interviews: 86 }, readiness: 86 });
    expect(report.assignments.find((a: { title: string }) => a.title === 'Two Sum')).toMatchObject({ completed: 1, onTime: 1, total: 2 });
    // Once the three single assignments are due, finishing them on time counts and missing them does not.
    await Assignment.updateMany({ orgId: org.id, pack: { $exists: false } }, { $set: { dueAt: new Date() } });
    const later = (await admin.get(`/api/orgs/${org.id}/cohorts/${cohort.id}`).expect(200)).body;
    expect(later.students.map((s: { email: string; readiness: number | null; parts: object }) => [s.email, s.readiness, s.parts])).toEqual([
      ['asha@college.test', 94, { skills: null, assignments: 100, interviews: 86 }], ['ravi@college.test', 0, { skills: null, assignments: 0, interviews: null }]]);

    const csv = await admin.get(`/api/orgs/${org.id}/cohorts/${cohort.id}/export.csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="CSE-2027.csv"');
    expect(csv.text.startsWith('﻿Name,Email,Roll number,Readiness index')).toBe(true);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(csv.text).toContain('Asha Verma,asha@college.test,21CS001,94,,100,86,5,');
  });

  it('protects the last admin, lets members leave and removes organisations with their data', async () => {
    const { org, cohort } = await setUp();
    await join(student, cohort.joinCode).expect(201);
    const adminId = ids['tpo@college.test'];
    await admin.patch(`/api/orgs/${org.id}/members/${adminId}`).send({ role: 'student' }).expect(409);
    await admin.delete(`/api/orgs/${org.id}/members/${adminId}`).expect(409);
    await admin.delete(`/api/orgs/${org.id}/membership`).expect(409);
    await student.delete(`/api/orgs/${org.id}/membership`).expect(200);
    expect((await admin.get(`/api/orgs/${org.id}/cohorts/${cohort.id}`).expect(200)).body.students).toEqual([]);
    await student.get(`/api/orgs/${org.id}`).expect(404);
    // Rotating the code stops the old one working.
    const fresh = (await admin.post(`/api/orgs/${org.id}/join-code`).expect(200)).body.joinCode;
    expect(fresh).not.toBe(org.joinCode);
    await join(student, org.joinCode).expect(404);
    // Branding is validated, and administration is audited with IDs only.
    await admin.patch(`/api/orgs/${org.id}`).send({ branding: { accentColor: 'red' } }).expect(400);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect((await admin.patch(`/api/orgs/${org.id}`).send({ branding: { displayName: 'GEC Placement Cell', accentColor: '#0f766e' } }).expect(200)).body.org.branding)
        .toEqual({ displayName: 'GEC Placement Cell', accentColor: '#0f766e' });
      await admin.get(`/api/orgs/${org.id}/cohorts/${cohort.id}/export.csv`).expect(200);
      const events = log.mock.calls.map(c => String(c[0])).filter(l => l.includes('org_audit')).map(l => JSON.parse(l));
      expect(events.map(e => [e.action, e.orgId, e.actorId])).toEqual([['org_updated', org.id, ids['tpo@college.test']], ['cohort_exported', org.id, ids['tpo@college.test']]]);
      expect(events[1].targetId).toBe(cohort.id);
      expect(JSON.stringify(events)).not.toMatch(/@|GEC|Asha/);
    } finally { log.mockRestore(); }
    // A third organisation is refused.
    await admin.post('/api/orgs').send({ name: 'Second' }).expect(201);
    await admin.post('/api/orgs').send({ name: 'Third' }).expect(409);
    await admin.delete(`/api/orgs/${org.id}`).expect(200);
    expect(await Promise.all([Cohort.countDocuments({ orgId: org.id }), Membership.countDocuments({ orgId: org.id }), Assignment.countDocuments({ orgId: org.id })])).toEqual([0, 0, 0]);
  });

  it('removes a deleted account from organisations, in the app and when a backup is restored', async () => {
    const { org, cohort, other } = await setUp();
    await join(student, cohort.joinCode).expect(201);
    await admin.post(`/api/orgs/${org.id}/invitations/import`).send({ csv: 'email\nasha@college.test' }).expect(201);
    // An organisation with a second admin survives; one whose only admin leaves is removed.
    await Membership.create({ orgId: other.id, userId: ids['tpo@college.test'], role: 'admin', sharingVersion: SHARING_VERSION, sharingAcceptedAt: new Date() });
    const exported = (await student.get('/api/account/export').expect(200)).body;
    expect(exported.organisations).toEqual([expect.objectContaining({ organisation: 'Govt Engineering College', role: 'student', sharingVersion: SHARING_VERSION })]);

    await removeUserFromOrgs(new mongoose.Types.ObjectId(ids['asha@college.test']), 'Asha@College.test');
    expect(await Membership.countDocuments({ userId: ids['asha@college.test'] })).toBe(0);
    expect(await Invitation.countDocuments({ email: 'asha@college.test' })).toBe(0);
    await removeUserFromOrgs(new mongoose.Types.ObjectId(ids['tpo@college.test']));
    expect(await Organization.exists({ _id: org.id })).toBeNull();
    expect(await Cohort.countDocuments({ orgId: org.id })).toBe(0);
    expect(await Organization.exists({ _id: other.id })).not.toBeNull();

    // Restoring a backup: the same rules apply to receipts for deleted users.
    const restored = await setUp();
    await join(student, restored.cohort.joinCode).expect(201);
    const db = mongoose.connection.db!;
    await reconcileDeletions(db, [{ version: 1, userId: ids['tpo@other.test'], requestedAt: new Date().toISOString() }]);
    expect(await Organization.exists({ _id: restored.other.id })).toBeNull();
    expect(await Membership.countDocuments({ orgId: restored.other.id })).toBe(0);
    expect(await Organization.exists({ _id: restored.org.id })).not.toBeNull();
    expect(await Membership.countDocuments({ orgId: restored.org.id })).toBe(2);
  });
});
