import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

export type AuthRequest = Request & { userId: string };

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.iq_session as string | undefined;
  if (!token) { res.status(401).json({ error: 'Please sign in.' }); return; }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string' || !mongoose.isValidObjectId(payload.sub)) throw new Error('Invalid session');
    (req as AuthRequest).userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please sign in.' });
  }
}
