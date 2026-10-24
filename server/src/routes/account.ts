import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { User } from '../models/User.js';
import { Interview } from '../models/Interview.js';
import { AuthSession, AccountToken } from '../models/Account.js';
import { AIUsage } from '../models/AIUsage.js';
import { accountVersionFilter, clearSession, userView } from '../services/account.js';
import { authLimit, validPassword } from './auth.js';
const router = Router(); router.use(requireAuth);
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
    await write(JSON.stringify({ exportedAt: new Date(), user: userView(user) }).slice(0, -1) + ',"interviews":[');
    let first = true;
    for await (const interview of Interview.find({ userId }).lean().cursor()) {
      if (res.destroyed) return;
      await write((first ? '' : ',') + JSON.stringify(interview)); first = false;
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
    const deleted = await User.updateOne({ _id: user._id, ...accountVersionFilter(user.authVersion ?? 0), deletionRequestedAt: { $exists: false } },
      { $set: { deletionRequestedAt: new Date() }, $inc: { authVersion: 1 } });
    if (!deleted.modifiedCount) { res.status(409).json({ error: 'Account changed. Please sign in again.' }); return; }
    clearSession(res); res.status(202).json({ message: 'Access is revoked. Owned records will be removed by background cleanup after at least one minute. Backups expire on their retention schedule.' });
  } catch (err) { next(err); }
});
export default router;
