import express, { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { Project } from '../models/Project.js';
import { CandidateDocument } from '../models/CandidateDocument.js';
import { INTERVIEW_LANGUAGES } from '../models/Interview.js';
import { createProject, deleteProject, excerptFor, liveProject, projectView, ProjectLimitError, ProjectZipError } from '../projects/service.js';
import { checkClaim, extractClaims } from '../projects/claims.js';
import { LIMITS } from '../projects/ingest.js';
import { consumeAIQuota, consumeQuota } from '../services/quotas.js';
import { ConsentRequiredError, requireAIConsent } from '../services/providerConsent.js';
import { interviewMode } from '../services/ai.js';
import { operationalEvent } from '../services/monitoring.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
// Zips arrive as the raw request body: nothing is written to disk and the archive is never extracted to files.
const zipBody = express.raw({ type: ['application/zip', 'application/x-zip-compressed'], limit: LIMITS.zipBytes });
const uploadLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'project uploads', 10, 86_400_000); next(); }
  catch (err) { next(err); }
};
const aiLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'interview requests', 40, 900_000); next(); }
  catch (err) { next(err); }
};
const load = (req: any) => mongoose.isValidObjectId(req.params.id)
  ? Project.findOne({ _id: req.params.id, userId: userId(req), deletingAt: { $exists: false } }) : Promise.resolve(null);

router.get('/', async (req, res, next) => {
  try {
    const projects = await Project.find({ userId: userId(req) }).select('-files.text').sort({ createdAt: -1, _id: -1 }).lean();
    res.json({ projects: projects.map(p => projectView(p as any)) });
  } catch (err) { next(err); }
});

router.post('/', uploadLimit, zipBody, async (req, res, next) => {
  try {
    const name = z.string().trim().min(1).max(80).safeParse(decodeURIComponent(String(req.headers['x-project-name'] ?? '')));
    if (!name.success) { res.status(400).json({ error: 'Name the project (up to 80 characters).' }); return; }
    if (!Buffer.isBuffer(req.body) || !req.body.length) { res.status(415).json({ error: 'Upload the project as a .zip file.' }); return; }
    if (req.body.subarray(0, 4).toString('latin1') !== 'PK\u0003\u0004') { res.status(415).json({ error: 'That file is not a zip archive.' }); return; }
    const project = await createProject(userId(req), name.data, req.body);
    res.status(201).json({ project: projectView(project.toObject() as any, true) });
  } catch (err) {
    if (err instanceof ProjectZipError || err instanceof ProjectLimitError) { res.status(err instanceof ProjectLimitError ? 409 : 400).json({ error: err.message }); return; }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await load(req);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }
    res.json({ project: projectView(project.toObject() as any, true) });
  } catch (err) { next(err); }
});

// A few lines of one file, for showing the code a question or claim refers to.
router.get('/:id/excerpt', async (req, res, next) => {
  try {
    const query = z.object({ path: z.string().min(1).max(500), start: z.coerce.number().int().min(1), end: z.coerce.number().int().min(1) }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: 'Choose a file and line range.' }); return; }
    const project = await load(req);
    const excerpt = project && excerptFor(project, query.data.path, query.data.start, Math.max(query.data.start, query.data.end));
    if (!excerpt) { res.status(404).json({ error: 'File not found in this project.' }); return; }
    res.json({ excerpt: { path: query.data.path, ...excerpt } });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !await deleteProject(userId(req), req.params.id)) { res.status(404).json({ error: 'Project not found.' }); return; }
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Checks a saved resume's claims against this project's code. The model lists claims; the code decides.
router.post('/:id/claims', aiLimit, async (req, res, next) => {
  try {
    const body = z.object({ documentId: z.string().regex(/^[a-f0-9]{24}$/), language: z.enum(INTERVIEW_LANGUAGES).optional() }).safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'Choose a saved resume.' }); return; }
    const project = await liveProject(userId(req), req.params.id);
    if (!project) { res.status(404).json({ error: 'Project not found.' }); return; }
    const resume = await CandidateDocument.findOne({ _id: body.data.documentId, userId: userId(req), kind: 'resume', deletingAt: { $exists: false } }).select('title text');
    if (!resume) { res.status(400).json({ error: 'Choose one of your saved resumes.' }); return; }
    if (interviewMode() !== 'ai') { res.status(409).json({ error: 'Checking resume claims needs AI, which is not enabled on this server.' }); return; }
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let extracted;
    try { extracted = await extractClaims({ usageContext: { userId: userId(req) }, resume: resume.text, project, language: body.data.language }); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('project_claims_failure', 'WARNING');
      res.status(502).json({ error: 'The resume claims could not be read. Please try again.' }); return;
    }
    const check = { documentId: resume._id, documentTitle: resume.title, claims: extracted.claims.map(c => checkClaim(project, c)),
      dropped: extracted.dropped, generation: extracted.generation, createdAt: new Date() };
    const updated = await Project.findOneAndUpdate({ _id: project._id, userId: userId(req), deletingAt: { $exists: false } },
      { $push: { claimChecks: { $each: [check], $slice: -5 } } }, { new: true });
    if (!updated) { res.status(404).json({ error: 'Project not found.' }); return; }
    res.status(201).json({ project: projectView(updated.toObject() as any, true) });
  } catch (err) { next(err); }
});

export default router;
