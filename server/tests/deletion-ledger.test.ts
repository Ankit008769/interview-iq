import { beforeAll, beforeEach, afterAll, afterEach, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
const { save, files } = vi.hoisted(() => ({ save: vi.fn(), files: vi.fn() }));
vi.mock('@google-cloud/storage', () => ({ Storage: class {
  bucket(name: string) { return { file: (key: string) => ({ save: (...args: unknown[]) => save(name, key, ...args) }), getFilesStream: files }; }
} }));
import { AccountDeletion, AuthSession, AccountToken } from '../src/models/Account.js';
import { User } from '../src/models/User.js';
import { AIUsage } from '../src/models/AIUsage.js';
import { CandidateDocument } from '../src/models/CandidateDocument.js';
import { processAccountDeletions } from '../src/services/account.js';
import { writeDeletionReceipt } from '../src/services/deletionLedger.js';
import { parseReceipt, reconcileDeletions, readDeletionLedger, validateRestoreTarget } from '../src/services/deletionRestore.js';
import { SkillState, StudyPlan } from '../src/models/Learning.js';
process.env.JWT_SECRET = 'ledger-test-secret-longer-than-thirty-two-characters';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
const { app } = await import('../src/app.js');
let mongo: MongoMemoryServer;
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await AccountDeletion.init(); }, 120_000);
beforeEach(async () => {
  vi.stubEnv('DELETION_LEDGER_BUCKET', 'private-ledger-test'); vi.stubEnv('AI_PROVIDER', 'practice');
  save.mockReset().mockResolvedValue(undefined);
  files.mockReset();
  await Promise.all(Object.values(mongoose.connection.collections).map(c => c.deleteMany({})));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });
const password = 'ledger-test-password';
async function register() {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/register').send({ name: 'Ledger Tester', email: `ledger-${new mongoose.Types.ObjectId()}@example.test`, password }).expect(201);
  return { agent, id: response.body.user.id as string };
}
it('writes only opaque receipts with a create-only precondition; retries a lost response safely', async () => {
  const id = new mongoose.Types.ObjectId().toHexString(), at = new Date();
  await writeDeletionReceipt(id, at);
  expect(save.mock.calls[0]).toEqual(['private-ledger-test', `receipts/v1/${id}.json`, JSON.stringify({ version: 1, userId: id, requestedAt: at.toISOString() }),
    expect.objectContaining({ resumable: false, timeout: 5000, preconditionOpts: { ifGenerationMatch: 0 } })]);
  save.mockRejectedValueOnce({ code: 412 }); await expect(writeDeletionReceipt(id, at)).resolves.toBe(true);
  save.mockRejectedValueOnce({ code: 403 }); await expect(writeDeletionReceipt(id, at)).rejects.toThrow('unavailable');
});
it('replicates before acknowledging deletion and preserves the in-flight drain window', async () => {
  const a = await register();
  await a.agent.post('/api/account/delete').send({ password: 'wrong', confirmation: 'DELETE' }).expect(400); expect(save).not.toHaveBeenCalled();
  await a.agent.post('/api/account/delete').send({ password, confirmation: 'DELETE' }).expect(202);
  expect((await AccountDeletion.findOne({ userId: a.id }))?.replicatedAt).toBeInstanceOf(Date);
  await processAccountDeletions(); expect(await User.findById(a.id)).not.toBeNull();
  await processAccountDeletions(new Date(Date.now() + 61_000)); expect(await User.findById(a.id)).toBeNull(); expect(save).toHaveBeenCalledTimes(1);
});
it('holds cleanup on storage failure, retries after backoff and keeps unrelated accounts usable', async () => {
  const a = await register(), b = await register(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  save.mockRejectedValue(new Error('secret provider payload'));
  const response = await a.agent.post('/api/account/delete').send({ password, confirmation: 'DELETE' }).expect(503);
  expect(response.body.error).toContain('Access is revoked'); expect(JSON.stringify(response.body)).not.toContain('secret');
  await a.agent.get('/api/auth/me').expect(401); await b.agent.get('/api/auth/me').expect(200);
  await processAccountDeletions(); expect(save).toHaveBeenCalledTimes(1);
  await processAccountDeletions(new Date(Date.now() + 61_000)); expect(await User.findById(a.id)).not.toBeNull();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('deletion_ledger_failure')); expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  save.mockResolvedValue(undefined);
  await processAccountDeletions(new Date(Date.now() + 122_000)); expect(await User.findById(a.id)).toBeNull();
});
it('fails closed without a production bucket and backfills historical receipts to a new bucket', async () => {
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('DELETION_LEDGER_BUCKET', '');
  await expect(writeDeletionReceipt(new mongoose.Types.ObjectId().toHexString(), new Date())).rejects.toThrow('required'); expect(save).not.toHaveBeenCalled();
  vi.stubEnv('DELETION_LEDGER_BUCKET', 'replacement-ledger');
  await AccountDeletion.create({ userId: new mongoose.Types.ObjectId(), requestedAt: new Date(0), replicatedAt: new Date(), replicationBucket: 'old-ledger' });
  await processAccountDeletions(); expect(save.mock.calls[0][0]).toBe('replacement-ledger');
});
it('recovers a marker if the process stopped before creating its receipt', async () => {
  const a = await register(); await User.updateOne({ _id: a.id }, { $set: { deletionRequestedAt: new Date(0) } });
  await processAccountDeletions(); expect(save).toHaveBeenCalledTimes(1); expect(await User.findById(a.id)).toBeNull();
});
it('reconciles a pre-deletion restore, preserves other users, removes late writes and revokes all sessions', async () => {
  const a = await register(), b = await register(); const at = new Date().toISOString();
  await AIUsage.create([{ userId: a.id }, { userId: b.id }]);
  const doc = { kind: 'resume', title: 'Resume', text: 'Restored resume text.', chars: 21 };
  await CandidateDocument.create([{ userId: a.id, ...doc }, { userId: b.id, ...doc }]);
  const skill = { skillId: 'hr.framing', mean: 2, variance: 1, observations: 1, card: { due: new Date() }, history: [], basisAt: new Date() };
  await SkillState.create([{ userId: a.id, ...skill }, { userId: b.id, ...skill }]);
  const plan = { interviewDate: new Date(Date.now() + 86400000), focusTypes: ['HR'], dailyMinutes: 10 };
  await StudyPlan.create([{ userId: a.id, ...plan }, { userId: b.id, ...plan }]);
  await AccountToken.create({ userId: b.id, tokenHash: 'test-hash', version: 0, purpose: 'reset', expiresAt: new Date(Date.now() + 60000) });
  const db = mongoose.connection.db!;
  const receipts = [{ version: 1 as const, userId: a.id, requestedAt: at }];
  await reconcileDeletions(db, receipts);
  expect(await User.findById(a.id)).toBeNull(); expect(await User.findById(b.id)).not.toBeNull();
  expect(await AIUsage.countDocuments({ userId: a.id })).toBe(0); expect(await AIUsage.countDocuments({ userId: b.id })).toBe(1);
  expect(await CandidateDocument.countDocuments({ userId: a.id })).toBe(0); expect(await CandidateDocument.countDocuments({ userId: b.id })).toBe(1);
  for (const model of [SkillState, StudyPlan] as any[]) { expect(await model.countDocuments({ userId: a.id })).toBe(0); expect(await model.countDocuments({ userId: b.id })).toBe(1); }
  expect(await AuthSession.countDocuments()).toBe(0); expect(await AccountToken.countDocuments()).toBe(0);
  await AIUsage.create({ userId: a.id }); await reconcileDeletions(db, receipts); expect(await AIUsage.countDocuments({ userId: a.id })).toBe(0);
});
it('rejects malformed, mismatched and contaminated ledger entries before mutating a restore', async () => {
  const a = await register(); const at = new Date().toISOString();
  expect(() => parseReceipt(`receipts/v1/${a.id}.json`, JSON.stringify({ version: 1, userId: a.id, requestedAt: at, email: 'private' }))).toThrow();
  expect(() => parseReceipt('receipts/v1/other.json', JSON.stringify({ version: 1, userId: a.id, requestedAt: at }))).toThrow();
  await expect(reconcileDeletions(mongoose.connection.db!, [{ version: 1, userId: a.id, requestedAt: 'invalid' }])).rejects.toThrow();
  expect(await User.findById(a.id)).not.toBeNull(); expect(await AuthSession.countDocuments()).toBe(1);
});
it('reads all streamed pages and fails closed on a partial listing, failed download or empty ledger', async () => {
  const entry = () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    return { name: `receipts/v1/${id}.json`, metadata: { size: '100' }, download: async () => [Buffer.from(JSON.stringify({ version: 1, userId: id, requestedAt: new Date().toISOString() }))] };
  };
  files.mockImplementation(async function* () { yield entry(); yield entry(); });
  expect(await readDeletionLedger('test')).toHaveLength(2);
  files.mockImplementation(async function* () { yield entry(); throw new Error('listing interrupted'); });
  await expect(readDeletionLedger('test')).rejects.toThrow('listing interrupted');
  files.mockImplementation(async function* () { yield { ...entry(), download: async () => { throw new Error('download failed'); } }; });
  await expect(readDeletionLedger('test')).rejects.toThrow('download failed');
  files.mockImplementation(async function* () {});
  await expect(readDeletionLedger('test')).rejects.toThrow('Empty ledger');
});
it('refuses remote, implicit or SRV restore database targets', () => {
  for (const uri of ['mongodb://10.42.0.10/interviewiq', 'mongodb+srv://localhost/interviewiq', 'mongodb://localhost', 'mongodb://localhost/db,other']) expect(() => validateRestoreTarget(uri)).toThrow();
  expect(() => validateRestoreTarget('mongodb://127.0.0.1:27018/interviewiq')).not.toThrow();
});
