import { Router, type RequestHandler } from 'express';
import { createHmac } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { User } from '../models/User.js';
import { AccountToken, AuthSession } from '../models/Account.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { accountVersionFilter, clearSession, issueAccountToken, setSession, tokenHash, userView } from '../services/account.js';
import * as mail from '../services/accountMail.js';
import { consumeQuota } from '../services/quotas.js';
const router = Router();
const password = z.string().min(8).max(72); // bcrypt consumes at most 72 UTF-8 bytes; checked below.
export const validPassword = (value: string) => Buffer.byteLength(value, 'utf8') <= 72;
const payloadSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), password });
const registerSchema = payloadSchema.extend({ name: z.string().trim().min(2).max(65) });
export const authLimit: RequestHandler = async (req, _res, next) => {
  try {
    const ip = createHmac('sha256', process.env.JWT_SECRET!).update(req.ip || 'unknown').digest('hex');
    await consumeQuota(`auth:${ip}`, req.path, 20, 900_000); next();
  } catch (error) { next(error); }
};
router.get('/capabilities', (_req, res) => res.json({ emailDelivery: mail.emailDeliveryAvailable() }));
router.post('/register', authLimit, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success || !validPassword(parsed.data.password)) { res.status(400).json({ error: 'Enter a name, valid email and password of 8–72 UTF-8 bytes.' }); return; }
    const { name, email, password } = parsed.data;
    if (await User.exists({ email })) { res.status(409).json({ error: 'An account with this email already exists.' }); return; }
    const user = await User.create({ name, email, passwordHash: await bcrypt.hash(password, 12) });
    await setSession(res, user); res.status(201).json({ user: userView(user) });
  } catch (err: any) { if (err?.code === 11000) { res.status(409).json({ error: 'An account with this email already exists.' }); return; } next(err); }
});
router.post('/login', authLimit, async (req, res, next) => {
  try {
    const parsed = payloadSchema.extend({password:z.string().min(8).max(128)}).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email and password.' }); return; }
    const user = await User.findOne({ email: parsed.data.email, deletionRequestedAt: { $exists: false } }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) { res.status(401).json({ error: 'Invalid email or password.' }); return; }
    await setSession(res, user); res.json({ user: userView(user) });
  } catch (err) { next(err); }
});
router.post('/logout', async (req, res, next) => {
  try { if (typeof req.cookies?.iq_session === 'string') await AuthSession.deleteOne({ tokenHash: tokenHash(req.cookies.iq_session) }); clearSession(res); res.json({ ok: true }); }
  catch (err) { next(err); }
});
router.get('/me', requireAuth, async (req, res, next) => {
  try { const user = await User.findById((req as AuthRequest).userId); if (!user) { res.sendStatus(401); return; } res.json({ user: userView(user) }); }
  catch (err) { next(err); }
});
router.post('/forgot-password', authLimit, async (req, res, next) => {
  if (!mail.emailDeliveryAvailable()) { res.status(503).json({ error: 'Email recovery is not enabled yet. Contact the site owner.' }); return; }
  try {
    const parsed = payloadSchema.pick({ email: true }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email.' }); return; }
    const user = await User.findOne({ email: parsed.data.email, deletionRequestedAt: { $exists: false } });
    if (user) {
      const token = await issueAccountToken(user, 'reset');
      try { await mail.sendAccountLink(user.email, 'reset', `${process.env.CLIENT_ORIGIN}/account/recovery#token=${token}`); }
      catch { await AccountToken.deleteOne({ tokenHash: tokenHash(token) }); }
    }
    res.json({ message: 'If the account is eligible, a recovery link will be sent.' });
  } catch (err) { next(err); }
});
router.post('/verification-email', requireAuth, authLimit, async (req, res, next) => {
  if (!mail.emailDeliveryAvailable()) { res.status(503).json({ error: 'Email verification is not enabled yet.' }); return; }
  try {
    const user = await User.findOne({ _id: (req as AuthRequest).userId, deletionRequestedAt: { $exists: false } });
    if (!user) { res.sendStatus(401); return; }
    if (!user.emailVerifiedAt) {
      const token = await issueAccountToken(user, 'verify');
      try { await mail.sendAccountLink(user.email, 'verify', `${process.env.CLIENT_ORIGIN}/account/verify#token=${token}`); }
      catch { await AccountToken.deleteOne({ tokenHash: tokenHash(token) }); res.status(503).json({ error: 'The email could not be sent. Please retry.' }); return; }
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/reset-password', authLimit, async (req, res, next) => {
  try {
    const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password }).safeParse(req.body);
    if (!parsed.success || !validPassword(parsed.data.password)) { res.status(400).json({ error: 'Enter a valid link token and a password of 8–72 UTF-8 bytes.' }); return; }
    const hash = await bcrypt.hash(parsed.data.password, 12);
    const token = await AccountToken.findOneAndDelete({ tokenHash: tokenHash(parsed.data.token), purpose: 'reset', expiresAt: { $gt: new Date() } });
    const user = token && await User.findOneAndUpdate({ _id: token.userId, ...accountVersionFilter(token.version), deletionRequestedAt: { $exists: false } }, { $set: { passwordHash: hash }, $inc: { authVersion: 1 } });
    if (!user) { res.status(400).json({ error: 'This recovery link is invalid or expired.' }); return; }
    await AuthSession.deleteMany({ userId: user._id }); await AccountToken.deleteMany({ userId: user._id });
    clearSession(res); res.json({ ok: true });
  } catch (err) { next(err); }
});
router.post('/verify-email', authLimit, async (req, res, next) => {
  try {
    const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid verification link.' }); return; }
    const token = await AccountToken.findOneAndDelete({ tokenHash: tokenHash(parsed.data.token), purpose: 'verify', expiresAt: { $gt: new Date() } });
    const user = token && await User.findOneAndUpdate({ _id: token.userId, ...accountVersionFilter(token.version), deletionRequestedAt: { $exists: false } }, { $set: { emailVerifiedAt: new Date() } });
    if (!user) { res.status(400).json({ error: 'This verification link is invalid or expired.' }); return; }
    res.json({ ok: true });
  } catch (err) { next(err); }
});
export default router;
