import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from '../models/User.js';
import { AuthRequest, requireAuth } from '../middleware/auth.js';

const router = Router();
const payloadSchema = z.object({ email: z.string().email().max(254).transform(x => x.toLowerCase().trim()), password: z.string().min(8).max(128) });
const registerSchema = payloadSchema.extend({ name: z.string().trim().min(2).max(65) });
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

function setSession(res: any, userId: string) {
  const token = jwt.sign({}, process.env.JWT_SECRET!, { subject: userId, expiresIn: '7d' });
  res.cookie('iq_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400_000, path: '/' });
}
function view(user: any) { return { id: user._id.toString(), name: user.name, email: user.email }; }

router.post('/register', authLimit, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Enter your name, a valid email and a password of at least 8 characters.' }); return; }
    const { name, email, password } = parsed.data;
    if (await User.exists({ email })) { res.status(409).json({ error: 'An account with this email already exists.' }); return; }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash });
    setSession(res, user._id.toString());
    res.status(201).json({ user: view(user) });
  } catch (err: any) {
    if (err?.code === 11000) { res.status(409).json({ error: 'An account with this email already exists.' }); return; }
    next(err);
  }
});
router.post('/login', authLimit, async (req, res, next) => {
  try {
    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email and password.' }); return; }
    const user = await User.findOne({ email: parsed.data.email }).select('+passwordHash');
    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) { res.status(401).json({ error: 'Invalid email or password.' }); return; }
    setSession(res, user._id.toString());
    res.json({ user: view(user) });
  } catch (err) { next(err); }
});
router.post('/logout', (_req, res) => {
  res.clearCookie('iq_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById((req as AuthRequest).userId);
    if (!user) { res.status(401).json({ error: 'Account not found.' }); return; }
    res.json({ user: view(user) });
  } catch (err) { next(err); }
});
export default router;
