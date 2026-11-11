import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { AuthSession, AccountToken, AccountDeletion } from '../models/Account.js';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { AIUsage } from '../models/AIUsage.js';
import { FeatureEvent } from '../models/FeatureEvent.js';
import { CandidateDocument } from '../models/CandidateDocument.js';
import { SkillState, StudyPlan } from '../models/Learning.js';
import { CodeRun } from '../models/CodeRun.js';
import { Project } from '../models/Project.js';
import { DesignSession } from '../models/DesignSession.js';
import { removeUserFromOrgs } from '../orgs/service.js';
import { QuotaBucket } from './quotas.js';
import { replicateDeletionReceipt } from './deletionLedger.js';
export const accountVersionFilter = (version: number) => version === 0 ? { $or: [{authVersion:0}, {authVersion:{$exists:false}}] } : {authVersion:version};
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const sessionCookie = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' });
export async function setSession(res: Response, user: { _id: { toString(): string }; authVersion?: number }) {
  const token = randomBytes(32).toString('hex');
  await AuthSession.create({ tokenHash: tokenHash(token), userId: user._id.toString(), version: user.authVersion ?? 0, expiresAt: new Date(Date.now() + 7 * 86400_000) });
  res.cookie('iq_session', token, { ...sessionCookie(), maxAge: 7 * 86400_000 });
}
export function clearSession(res: Response) { res.clearCookie('iq_session', sessionCookie()); }
export const userView = (user: any) => ({ id: user.id, name: user.name, email: user.email, emailVerified: !!user.emailVerifiedAt,
  preferences: { deliveryMetrics: user.preferences?.deliveryMetrics !== false } });
export async function issueAccountToken(user: { _id: { toString(): string }; authVersion?: number }, purpose: 'reset' | 'verify') {
  const token = randomBytes(32).toString('hex');
  await AccountToken.create({ tokenHash: tokenHash(token), userId: user._id.toString(), version: user.authVersion ?? 0,
    purpose, expiresAt: new Date(Date.now() + (purpose === 'reset' ? 30 : 60) * 60_000) });
  return token;
}
// Durable markers revoke access immediately. Receipts make cleanup retryable and
// repeat sweeps for writes that were already in flight when deletion was requested.
export async function processAccountDeletions(now = new Date()) {
  const users = await User.aggregate([
    { $match: { deletionRequestedAt: { $lte: now } } },
    { $lookup: { from: AccountDeletion.collection.name, localField: '_id', foreignField: 'userId', as: 'receipts' } },
    { $match: { 'receipts.0': { $exists: false } } },
    { $sort: { deletionRequestedAt: 1 } }, { $limit: 20 },
    { $project: { _id: 1, deletionRequestedAt: 1 } },
  ]);
  for (const user of users) {
    await AccountDeletion.updateOne({ userId: user._id }, { $setOnInsert: { requestedAt: user.deletionRequestedAt } }, { upsert: true });
  }
  const receipts = await AccountDeletion.find({ lastSweptAt: { $lte: new Date(now.getTime() - 60_000) },
    $or: [{ replicationRetryAt: { $exists: false } }, { replicationRetryAt: { $lte: now } }],
  }).sort({ lastSweptAt: 1 }).limit(5);
  for (const receipt of receipts) {
    if (!await replicateDeletionReceipt(receipt, now)) continue;
    // Replicate immediately, but retain the drain window for in-flight writes.
    if (receipt.requestedAt.getTime() > now.getTime() - 60_000) continue;
    const userId = receipt.userId;
    await Interview.deleteMany({ userId });
    await CandidateDocument.deleteMany({ userId });
    await SkillState.deleteMany({ userId });
    await StudyPlan.deleteMany({ userId });
    await CodeRun.deleteMany({ userId });
    await Project.deleteMany({ userId });
    await DesignSession.deleteMany({ userId });
    await removeUserFromOrgs(userId, (await User.findById(userId).select('email').lean())?.email);
    await AIUsage.deleteMany({ userId });
    await FeatureEvent.deleteMany({ userId });
    await AuthSession.deleteMany({ userId });
    await AccountToken.deleteMany({ userId });
    await QuotaBucket.deleteMany({ _id: { $regex: `^${userId.toString()}:` } });
    await User.deleteOne({ _id: userId });
    await AccountDeletion.updateOne({ _id: receipt._id }, { $set: { lastSweptAt: now } });
  }
}
