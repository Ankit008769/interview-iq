import type { Request, Response, NextFunction } from 'express';
import { AuthSession } from '../models/Account.js';
import { User } from '../models/User.js';
import { tokenHash } from '../services/account.js';

export type AuthRequest = Request & { userId: string; sessionId: string };

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.iq_session as string | undefined;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) { res.status(401).json({ error: 'Please sign in.' }); return; }
  try {
    const session = await AuthSession.findOne({ tokenHash: tokenHash(token), expiresAt: { $gt: new Date() } });
    const user = session && await User.findOne({ _id: session.userId, deletionRequestedAt: { $exists: false } });
    if (!user || session!.version !== (user.authVersion ?? 0)) { res.status(401).json({ error: 'Your session has expired. Please sign in.' }); return; }
    (req as AuthRequest).userId = user.id;
    (req as AuthRequest).sessionId = session!.id;
    next();
  } catch (error) { next(error); }
}
