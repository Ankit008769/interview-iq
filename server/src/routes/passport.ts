import { createHmac } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { ACHIEVEMENT_KINDS, PassportCredential } from '../models/Passport.js';
import { achievements, DISCLAIMER, didDocument, issuePassport, issuer, PassportError, statusListCredential, verifyPassport } from '../passport/service.js';
import { consumeQuota } from '../services/quotas.js';

const router = Router();
const userId = (req: Request) => (req as unknown as AuthRequest).userId;
const fail = (res: Response, err: unknown, next: NextFunction) => (err instanceof PassportError ? res.status(err.status).json({ error: err.message }) : next(err));
// Public endpoints are limited per (hashed) IP address.
const ipLimit = (name: string, max: number): RequestHandler => async (req, _res, next) => {
  try { await consumeQuota(`ip:${createHmac('sha256', process.env.JWT_SECRET!).update(req.ip || 'unknown').digest('hex')}`, name, max, 900_000); next(); } catch (err) { next(err); }
};
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;

// The issuer's DID document, served at /.well-known/did.json (app.ts).
export const didRoute: RequestHandler = (_req, res) => {
  const doc = didDocument();
  if (!doc) { res.status(404).end(); return; }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('application/did+json').send(JSON.stringify(doc));
};

// ---------------------------------------------------------------- public: status list, shared passports, verification

router.get('/status/1', async (_req, res, next) => {
  try {
    const list = await statusListCredential();
    if (!list) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.type('application/vc+ld+json').send(JSON.stringify(list));
  } catch (err) { next(err); }
});
// A shared passport: the credential and its verification. A revoked one shows nothing but that fact.
router.get('/public/:publicId', ipLimit('passport views', 120), async (req, res, next) => {
  try {
    const doc = PUBLIC_ID.test(req.params.publicId) ? await PassportCredential.findOne({ publicId: req.params.publicId }).lean() : null;
    if (!doc) { res.status(404).json({ error: 'Passport not found.' }); return; }
    if (doc.revokedAt) { res.json({ revoked: true, disclaimer: DISCLAIMER }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ revoked: false, credential: doc.credential, verification: await verifyPassport(doc.credential), disclaimer: DISCLAIMER });
  } catch (err) { fail(res, err, next); }
});
// Anyone can check a passport JSON they were given.
router.post('/verify', ipLimit('passport verifications', 60), express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'Send the credential JSON.' }); return; }
    res.json(await verifyPassport(req.body));
  } catch (err) { fail(res, err, next); }
});

// ---------------------------------------------------------------- the holder's own passports

router.use(requireAuth);
router.get('/', async (req, res, next) => {
  try {
    const [available, issued] = await Promise.all([achievements(userId(req)), PassportCredential.find({ userId: new mongoose.Types.ObjectId(userId(req)) }).sort({ issuedAt: -1 }).limit(50).lean()]);
    res.json({ configured: !!issuer(), disclaimer: DISCLAIMER, available,
      issued: issued.map(p => ({ publicId: p.publicId, kinds: p.kinds, includeName: p.includeName, issuedAt: p.issuedAt, validUntil: p.validUntil, revokedAt: p.revokedAt ?? null })) });
  } catch (err) { next(err); }
});
router.post('/', async (req, res, next) => {
  try {
    const body = z.object({ kinds: z.array(z.enum(ACHIEVEMENT_KINDS)).min(1).max(ACHIEVEMENT_KINDS.length), includeName: z.boolean().default(false) }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Choose what to include.' }); return; }
    await consumeQuota(userId(req), 'passports issued', 10, 86_400_000);
    const p = await issuePassport(userId(req), body.data.kinds, body.data.includeName);
    res.status(201).json({ publicId: p.publicId, link: `/passport/${p.publicId}`, credential: p.credential });
  } catch (err) { fail(res, err, next); }
});
router.get('/:publicId/credential.json', async (req, res, next) => {
  try {
    const doc = PUBLIC_ID.test(req.params.publicId) ? await PassportCredential.findOne({ publicId: req.params.publicId, userId: new mongoose.Types.ObjectId(userId(req)) }).lean() : null;
    if (!doc) { res.status(404).json({ error: 'Passport not found.' }); return; }
    res.setHeader('Content-Disposition', 'attachment; filename="interview-iq-practice-record.json"');
    res.type('application/vc+ld+json').send(JSON.stringify(doc.credential, null, 2));
  } catch (err) { next(err); }
});
router.delete('/:publicId', async (req, res, next) => {
  try {
    const updated = PUBLIC_ID.test(req.params.publicId) ? await PassportCredential.updateOne({ publicId: req.params.publicId, userId: new mongoose.Types.ObjectId(userId(req)), revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } }) : null;
    if (!updated?.modifiedCount) { res.status(404).json({ error: 'Passport not found or already revoked.' }); return; }
    res.json({ revoked: true });
  } catch (err) { next(err); }
});

export default router;
