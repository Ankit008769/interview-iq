import { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth.js';
import { CandidateDocument, DOCUMENT_KINDS, MAX_DOCUMENT_CHARS, MAX_DOCUMENTS_PER_USER } from '../models/CandidateDocument.js';
import { deleteCandidateDocument } from '../services/documents.js';
import { consumeQuota } from '../services/quotas.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
const createSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  title: z.string().trim().min(2).max(80),
  // Line endings are normalised so source offsets mean the same thing everywhere.
  text: z.string().transform(t => t.replace(/\r\n?/g, '\n').trim())
    .pipe(z.string().min(50).max(MAX_DOCUMENT_CHARS).refine(t => !t.includes('\u0000'))),
});
const writeLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'document changes', 30, 900_000); next(); }
  catch (err) { next(err); }
};
const view = (d: InstanceType<typeof CandidateDocument>) => ({ id: d.id, kind: d.kind, title: d.title, chars: d.chars,
  createdAt: d.createdAt, ...(d.deletingAt ? { deleting: true } : {}) });

router.get('/', async (req, res, next) => {
  try {
    const docs = await CandidateDocument.find({ userId: userId(req) }).select('-text').sort({ createdAt: -1, _id: -1 });
    res.json({ documents: docs.map(view), limits: { maxDocuments: MAX_DOCUMENTS_PER_USER, maxChars: MAX_DOCUMENT_CHARS } });
  } catch (err) { next(err); }
});
router.get('/:id', async (req, res, next) => {
  try {
    const doc = mongoose.isValidObjectId(req.params.id) ? await CandidateDocument.findOne({ _id: req.params.id, userId: userId(req) }) : null;
    if (!doc) { res.status(404).json({ error: 'Document not found.' }); return; }
    res.json({ document: { ...view(doc), text: doc.text } });
  } catch (err) { next(err); }
});
router.post('/', writeLimit, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: `Choose resume or job description, add a title, and paste 50 to ${MAX_DOCUMENT_CHARS.toLocaleString('en-US')} characters of text.` }); return; }
    const full = () => res.status(409).json({ error: `You can keep up to ${MAX_DOCUMENTS_PER_USER} documents. Delete one to add another.` });
    if (await CandidateDocument.countDocuments({ userId: userId(req) }) >= MAX_DOCUMENTS_PER_USER) { full(); return; }
    const doc = await CandidateDocument.create({ userId: userId(req), ...parsed.data, chars: parsed.data.text.length });
    // Concurrent saves can pass the check together; the extra one is removed again.
    if (await CandidateDocument.countDocuments({ userId: userId(req) }) > MAX_DOCUMENTS_PER_USER) {
      await CandidateDocument.deleteOne({ _id: doc._id }); full(); return;
    }
    res.status(201).json({ document: { ...view(doc), text: doc.text } });
  } catch (err) { next(err); }
});
// Deleting a document also removes every interview question generated from it. Answers stay.
router.delete('/:id', writeLimit, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !await deleteCandidateDocument(userId(req), req.params.id)) {
      res.status(404).json({ error: 'Document not found.' }); return;
    }
    res.json({ deleted: true });
  } catch (err) { next(err); }
});
export default router;
