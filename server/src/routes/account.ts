import { aiDisclosure } from '../services/providerConsent.js';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { AuthSession, AccountToken, AccountDeletion } from '../models/Account.js';
import { replicateDeletionReceipt } from '../services/deletionLedger.js';
import { AIUsage } from '../models/AIUsage.js';
import { CandidateDocument } from '../models/CandidateDocument.js';
import { SkillState, StudyPlan } from '../models/Learning.js';
import { CodeRun } from '../models/CodeRun.js';
import { Project } from '../models/Project.js';
import { accountVersionFilter, clearSession, userView } from '../services/account.js';
import { authLimit, validPassword } from './auth.js';
const router = Router(); router.use(requireAuth);
router.get('/ai-consent', async(req,res,next)=>{
  try { const disclosure=aiDisclosure(); const user=await User.findById((req as AuthRequest).userId);
    res.json({disclosure, accepted:!!disclosure && user?.aiConsent?.version===disclosure.version, hasGrant:!!user?.aiConsent, acceptedAt:user?.aiConsent?.acceptedAt});
  } catch(error){next(error);}
});
router.post('/ai-consent', async(req,res,next)=>{
  try { const disclosure=aiDisclosure();
    if(!disclosure || req.body.version!==disclosure.version || req.body.accepted!==true){res.status(409).json({error:'AI provider details changed. Reload and review before accepting.'});return;}
    const result=await User.updateOne({_id:(req as AuthRequest).userId,deletionRequestedAt:{$exists:false}},{$set:{aiConsent:{version:disclosure.version,acceptedAt:new Date(),provider:disclosure.provider,endpoint:disclosure.endpoint}}});
    if(!result.matchedCount){res.sendStatus(401);return;} res.json({ok:true});
  }catch(error){next(error);}
});
router.delete('/ai-consent',async(req,res,next)=>{
  try{await User.updateOne({_id:(req as AuthRequest).userId},{$unset:{aiConsent:1}});res.json({ok:true});}catch(error){next(error);}
});
// Delivery metrics (pace and filler words from voice answers) can be turned off; that stops measuring and hides them.
router.patch('/preferences', async (req, res, next) => {
  try {
    const parsed = z.object({ deliveryMetrics: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose whether to show delivery feedback.' }); return; }
    const user = await User.findOneAndUpdate({ _id: (req as AuthRequest).userId, deletionRequestedAt: { $exists: false } },
      { $set: { 'preferences.deliveryMetrics': parsed.data.deliveryMetrics } }, { new: true });
    if (!user) { res.sendStatus(401); return; }
    res.json({ user: userView(user) });
  } catch (err) { next(err); }
});

router.get('/sessions', async (req, res, next) => {
  try {
    const auth = req as AuthRequest;
    const user = await User.findById(auth.userId);
    const sessions = await AuthSession.find({ userId: auth.userId, version: user?.authVersion ?? 0, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).select('_id createdAt expiresAt').lean();
    res.json({ sessions: sessions.map(s => ({ id: s._id, createdAt: s.createdAt, expiresAt: s.expiresAt, current: s._id.toString() === auth.sessionId })) });
  } catch (err) { next(err); }
});
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) { res.sendStatus(404); return; }
    const result = await AuthSession.deleteOne({ _id: req.params.id, userId: (req as unknown as AuthRequest).userId });
    if (!result.deletedCount) { res.status(404).json({ error: 'Session not found.' }); return; }
    if (req.params.id === (req as unknown as AuthRequest).sessionId) clearSession(res);
    res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/revoke-all', async (req, res, next) => {
  try { await User.updateOne({ _id: (req as unknown as AuthRequest).userId }, { $inc: { authVersion: 1 } });
    await AuthSession.deleteMany({ userId: (req as unknown as AuthRequest).userId }); clearSession(res); res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/password', authLimit, async (req, res, next) => {
  try {
    const parsed = z.object({ currentPassword: z.string().max(128), newPassword: z.string().min(8).max(72) }).safeParse(req.body);
    if (!parsed.success || !validPassword(parsed.data.newPassword)) { res.status(400).json({ error: 'New password must contain 8–72 UTF-8 bytes.' }); return; }
    const user = await User.findById((req as unknown as AuthRequest).userId).select('+passwordHash');
    if (!user || !await bcrypt.compare(parsed.data.currentPassword, user.passwordHash)) { res.status(400).json({ error: 'Current password is incorrect.' }); return; }
    const changed = await User.updateOne({ _id: user._id, ...accountVersionFilter(user.authVersion ?? 0), deletionRequestedAt: { $exists: false } },
      { $set: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12) }, $inc: { authVersion: 1 } });
    if (!changed.modifiedCount) { res.status(409).json({ error: 'Account changed. Please sign in again.' }); return; }
    await AuthSession.deleteMany({ userId: user._id }); await AccountToken.deleteMany({ userId: user._id });
    clearSession(res); res.json({ ok: true });
  } catch (err) { next(err); }
});
router.get('/usage', async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await AIUsage.aggregate([{ $match: { userId: new mongoose.Types.ObjectId((req as unknown as AuthRequest).userId), createdAt: { $gte: since } } },
      { $group: { _id: '$status', attempts: { $sum: 1 }, inputTokens: { $sum: '$inputTokens' }, outputTokens: { $sum: '$outputTokens' },
        estimatedCostUsd: { $sum: '$cost.amountUsd' },
        unknownCost: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$cost.amountUsd', null] }, null] }, 1, 0] } },
        unknownUsage: { $sum: { $cond: [{ $or: [{ $eq: ['$inputTokens', null] }, { $eq: ['$outputTokens', null] }] }, 1, 0] } } } }]);
    res.json({ since, rows, note: 'Reported tokens for the last 30 days, not an invoice. Unknown usage is not zero. Practice mode makes no AI calls.' });
  } catch (err) { next(err); }
});
router.get('/export', async (req, res, next) => {
  try {
    const userId = (req as unknown as AuthRequest).userId;
    const user = await User.findById(userId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="interviewiq-export.json"');
    res.setHeader('Cache-Control', 'no-store');
    const write = async (chunk: string) => {
      if (res.destroyed) throw new Error('Client disconnected');
      if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
        const clean = () => { res.off('drain', drained); res.off('close', closed); };
        const drained = () => { clean(); resolve(); };
        const closed = () => { clean(); reject(new Error('Client disconnected')); };
        res.once('drain', drained); res.once('close', closed);
      });
    };
    await write(JSON.stringify({ exportedAt: new Date(), user: { ...userView(user), aiConsent: user?.aiConsent } }).slice(0, -1) + ',"interviews":[');
    let first = true;
    for await (const interview of Interview.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(interview)); first = false;
    }
    await write('],"documents":['); first = true;
    for await (const document of CandidateDocument.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(document)); first = false;
    }
    await write('],"skills":['); first = true;
    for await (const skill of SkillState.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(skill)); first = false;
    }
    await write('],"studyPlan":' + JSON.stringify(await StudyPlan.findOne({ userId }).lean()));
    await write(',"codeRuns":['); first = true;
    for await (const run of CodeRun.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(run)); first = false;
    }
    await write('],"projects":['); first = true;
    for await (const project of Project.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(project)); first = false;
    }
    await write('],"usage":['); first = true;
    for await (const usage of AIUsage.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(usage)); first = false;
    }
    res.end(']}');
  } catch (err) { if (res.headersSent) res.destroy(); else next(err); }
});
router.post('/delete', authLimit, async (req, res, next) => {
  try {
    const parsed = z.object({ password: z.string().max(128), confirmation: z.literal('DELETE') }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Enter your password and type DELETE.' }); return; }
    const user = await User.findById((req as unknown as AuthRequest).userId).select('+passwordHash');
    if (!user || !await bcrypt.compare(parsed.data.password, user.passwordHash)) { res.status(400).json({ error: 'Password is incorrect.' }); return; }
    const requestedAt = new Date();
    const deleted = await User.updateOne({ _id: user._id, ...accountVersionFilter(user.authVersion ?? 0), deletionRequestedAt: { $exists: false } },
      { $set: { deletionRequestedAt: requestedAt }, $inc: { authVersion: 1 } });
    if (!deleted.modifiedCount) { res.status(409).json({ error: 'Account changed. Please sign in again.' }); return; }
    clearSession(res);
    const receipt = await AccountDeletion.findOneAndUpdate({ userId: user._id }, { $setOnInsert: { requestedAt } }, { upsert: true, new: true });
    if (!await replicateDeletionReceipt(receipt)) {
      res.status(503).json({ error: 'Access is revoked, but the deletion safety copy is pending. Cleanup is paused and will retry automatically. You do not need to submit again.' }); return;
    }
    res.status(202).json({ message: 'Access is revoked. Owned records will be removed by background cleanup after at least one minute. Minimal deletion receipts are retained separately for restore safety. Backups expire on their retention schedule.' });
  } catch (err) { next(err); }
});
export default router;
