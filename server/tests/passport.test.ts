import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { generateSigningKey, publicKeyFromMultibase, statusBit, verifyProof } from '../src/passport/crypto.js';
import { PassportCredential } from '../src/models/Passport.js';
import { Interview } from '../src/models/Interview.js';
import { CodeRun } from '../src/models/CodeRun.js';
import { SkillState } from '../src/models/Learning.js';
import { User } from '../src/models/User.js';
import { Payment, Subscription } from '../src/models/Billing.js';
import { reconcileDeletions } from '../src/services/deletionRestore.js';

process.env.JWT_SECRET = 'passport-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');

describe('skill passport', () => {
  let mongo: MongoMemoryServer;
  const holder = request.agent(app), other = request.agent(app);
  let holderId: mongoose.Types.ObjectId;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await holder.post('/api/auth/register').send({ name: 'Asha Verma', email: 'asha@passport.test', password: 'test-password' }).expect(201);
    await other.post('/api/auth/register').send({ name: 'Ravi', email: 'ravi@passport.test', password: 'test-password' }).expect(201);
    holderId = (await User.findOne({ email: 'asha@passport.test' }).lean())!._id;
    const now = new Date();
    await Interview.collection.insertMany([{ userId: holderId, type: 'Technical', status: 'completed', feedback: { source: 'ai', score: 70 } },
      { userId: holderId, type: 'HR', status: 'completed', feedback: { source: 'ai', score: 80 } }, { userId: holderId, type: 'HR', status: 'completed', feedback: { source: 'practice', score: null } }]);
    await CodeRun.collection.insertMany([{ userId: holderId, problemId: 'two-sum', mode: 'submit', verdict: 'accepted' }, { userId: holderId, problemId: 'two-sum', mode: 'submit', verdict: 'accepted' },
      { userId: holderId, problemId: 'merge-intervals', mode: 'submit', verdict: 'wrong_answer' }]);
    await SkillState.collection.insertMany([{ userId: holderId, skillId: 'technical.correctness', mean: 3.8, variance: 0.25, lastObservedAt: now },
      { userId: holderId, skillId: 'technical.communication', mean: 3.9, variance: 2, lastObservedAt: now }, { userId: holderId, skillId: 'hr.motivation', mean: 1.2, variance: 0.2, lastObservedAt: now }]);
  }, 120_000);
  afterAll(async () => { vi.unstubAllEnvs(); await mongoose.disconnect(); await mongo?.stop(); });

  it('is off until an issuer key is configured', async () => {
    expect((await holder.get('/api/passport').expect(200)).body.configured).toBe(false);
    await holder.post('/api/passport').send({ kinds: ['interviews'] }).expect(503);
    await request(app).get('/.well-known/did.json').expect(404);
  });

  it('issues a signed practice record with only what the holder chose, verifiable by anyone', async () => {
    vi.stubEnv('PASSPORT_ISSUER_HOST', 'iq.example.test'); vi.stubEnv('PASSPORT_SIGNING_KEY', generateSigningKey());
    const { available, disclaimer } = (await holder.get('/api/passport').expect(200)).body;
    expect(disclaimer).toMatch(/^Practice record, not a hiring score/);
    expect(available.interviews).toEqual({ completedAiScoredInterviews: 2, byType: { Technical: 1, HR: 1 } });
    expect(available.coding).toMatchObject({ problemsSolved: 1 });
    expect(available.skills.skills).toEqual([expect.objectContaining({ skill: expect.any(String), area: 'Technical', level: 'Strong' })]); // the uncertain and the weak skill are left out
    expect(available.design).toBeNull();
    await holder.post('/api/passport').send({ kinds: ['design'] }).expect(400); // nothing to show
    await holder.post('/api/passport').send({ kinds: ['salary'] }).expect(400);

    const issued = (await holder.post('/api/passport').send({ kinds: ['interviews', 'coding'], includeName: false }).expect(201)).body;
    const vc = issued.credential;
    expect(vc).toMatchObject({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'InterviewPracticeRecord'], issuer: { id: 'did:web:iq.example.test' },
      description: disclaimer, credentialStatus: { type: 'BitstringStatusListEntry', statusPurpose: 'revocation', statusListCredential: 'https://iq.example.test/api/passport/status/1' },
      proof: { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', verificationMethod: 'did:web:iq.example.test#key-1' } });
    expect(Object.keys(vc.credentialSubject.practiceRecord)).toEqual(['interviews', 'coding']);
    expect(vc.credentialSubject.name).toBeUndefined();
    // The public DID document resolves the key that verifies the proof.
    const did = (await request(app).get('/.well-known/did.json').expect(200)).body;
    expect(did).toMatchObject({ id: 'did:web:iq.example.test', assertionMethod: ['did:web:iq.example.test#key-1'] });
    expect(verifyProof(vc, vm => (vm === did.verificationMethod[0].id ? publicKeyFromMultibase(did.verificationMethod[0].publicKeyMultibase) : null))).toBe(true);

    expect((await request(app).post('/api/passport/verify').send(vc).expect(200)).body).toEqual({ valid: true, checks: { issuer: true, signature: true, current: true, notRevoked: true } });
    const tampered = { ...vc, credentialSubject: { ...vc.credentialSubject, practiceRecord: { interviews: { completedAiScoredInterviews: 200 } } } };
    expect((await request(app).post('/api/passport/verify').send(tampered).expect(200)).body).toMatchObject({ valid: false, checks: { signature: false } });
    const shared = (await request(app).get(`/api/passport/public/${issued.publicId}`).expect(200)).body;
    expect(shared).toMatchObject({ revoked: false, verification: { valid: true } });
    await request(app).get('/api/passport/public/short').expect(404);

    // With the name, and downloadable by its holder only.
    const named = (await holder.post('/api/passport').send({ kinds: ['skills'], includeName: true }).expect(201)).body;
    expect(named.credential.credentialSubject.name).toBe('Asha Verma');
    await holder.get(`/api/passport/${named.publicId}/credential.json`).expect(200).expect('content-disposition', /attachment/);
    await other.get(`/api/passport/${named.publicId}/credential.json`).expect(404);
  });

  it('revokes through the status list, and only the holder can revoke', async () => {
    const p = await PassportCredential.findOne({ userId: holderId, revokedAt: { $exists: false } }).lean();
    await other.delete(`/api/passport/${p!.publicId}`).expect(404);
    await holder.delete(`/api/passport/${p!.publicId}`).expect(200);
    await holder.delete(`/api/passport/${p!.publicId}`).expect(404);
    const list = (await request(app).get('/api/passport/status/1').expect(200)).body;
    expect(list).toMatchObject({ type: ['VerifiableCredential', 'BitstringStatusListCredential'], credentialSubject: { statusPurpose: 'revocation' } });
    expect(statusBit(list.credentialSubject.encodedList, p!.statusIndex)).toBe(true);
    expect((await request(app).post('/api/passport/verify').send(p!.credential).expect(200)).body).toMatchObject({ valid: false, checks: { signature: true, notRevoked: false } });
    expect((await request(app).get(`/api/passport/public/${p!.publicId}`).expect(200)).body).toEqual({ revoked: true, disclaimer: expect.any(String) });
    const exported = (await holder.get('/api/account/export').expect(200)).body;
    expect(exported.passports).toHaveLength(2);
    expect(exported.billing).toMatchObject({ subscriptions: [], payments: [], referralCode: null });
  });

  it('keeps a live subscription from being deleted with the account, and detaches billing records on restore', async () => {
    const sub = await Subscription.create({ userId: holderId, plan: 'pro', interval: 'month', provider: 'razorpay', providerSubscriptionId: 'sub_del', status: 'active', currentPeriodEnd: new Date(Date.now() + 86_400_000) });
    expect((await holder.post('/api/account/delete').send({ password: 'test-password', confirmation: 'DELETE' }).expect(409)).body.error).toMatch(/Cancel your subscription/);
    await Subscription.updateOne({ _id: sub._id }, { $set: { cancelAtPeriodEnd: true } });
    await Payment.create({ userId: holderId, provider: 'razorpay', providerPaymentId: 'pay_del', kind: 'subscription', amount: 29_900, currency: 'INR', capturedAt: new Date() });
    const active = await PassportCredential.findOne({ userId: holderId, revokedAt: { $exists: false } }).lean();
    await reconcileDeletions(mongoose.connection.db!, [{ version: 1, userId: String(holderId), requestedAt: new Date().toISOString() }]);
    expect(await Payment.findOne({ providerPaymentId: 'pay_del' }).lean()).toMatchObject({ amount: 29_900 });
    expect((await Payment.findOne({ providerPaymentId: 'pay_del' }).lean())!.userId).toBeUndefined();
    expect((await Subscription.findById(sub._id).lean())!.userId).toBeUndefined();
    const kept = await PassportCredential.findById(active!._id).lean();
    expect(kept).toMatchObject({ statusIndex: active!.statusIndex, credential: {}, kinds: [] });
    expect(kept!.revokedAt).toBeInstanceOf(Date);
    const list = (await request(app).get('/api/passport/status/1').expect(200)).body;
    expect(statusBit(list.credentialSubject.encodedList, active!.statusIndex)).toBe(true);
  });
});
