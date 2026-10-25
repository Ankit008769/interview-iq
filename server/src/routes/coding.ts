import { Router, type RequestHandler } from 'express';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { CodeRun, type ICodeRun } from '../models/CodeRun.js';
import { INTERVIEW_LANGUAGES } from '../models/Interview.js';
import { PROBLEMS, PROBLEM_BY_ID } from '../coding/problems.js';
import { buildProgram, starterCode } from '../coding/harness.js';
import { grade } from '../coding/grade.js';
import { exampleCases, runTimeLimit, stdinFor, testCases } from '../coding/tests.js';
import { runOnRunner, runnerConfigured, runnerHealth, RunnerUnavailableError } from '../coding/runnerClient.js';
import { askFollowUp, reviewSubmission } from '../coding/coach.js';
import { CODE_LANGUAGES, LANGUAGE_LABELS, type CodeLanguage, type Problem, type SubmissionLanguage } from '../coding/types.js';
import { consumeAIQuota, consumeQuota, quotaLimit } from '../services/quotas.js';
import { ConsentRequiredError, requireAIConsent } from '../services/providerConsent.js';
import { interviewMode } from '../services/ai.js';
import { operationalEvent } from '../services/monitoring.js';
import { CODING_RUBRIC } from '../services/rubrics.js';

const router = Router();
router.use(requireAuth);
const userId = (req: any) => (req as AuthRequest).userId;
const languagesFor = (problem: Problem): SubmissionLanguage[] => (problem.kind === 'sql' ? ['sql'] : problem.languages ?? [...CODE_LANGUAGES]);
const runnerLanguage = (language: SubmissionLanguage): CodeLanguage => (language === 'sql' ? 'python' : language);

// Runner health is cached briefly so listing problems does not wake the runner on every request.
let health: { at: number; value: Awaited<ReturnType<typeof runnerHealth>> } | undefined;
async function runnerStatus() {
  if (!health || Date.now() - health.at > 60_000 || !health.value?.ok) health = { at: Date.now(), value: await runnerHealth() };
  return health.value;
}

const runLimit: RequestHandler = async (req, _res, next) => {
  try {
    await consumeQuota(userId(req), 'code runs', quotaLimit('CODE_RUNS_PER_15_MIN', 40), 900_000);
    await consumeQuota(userId(req), 'daily code runs', quotaLimit('CODE_RUNS_PER_DAY', 300), 86_400_000);
    next();
  } catch (err) { next(err); }
};
const aiLimit: RequestHandler = async (req, _res, next) => {
  try { await consumeQuota(userId(req), 'interview requests', quotaLimit('INTERVIEW_WRITES_PER_15_MIN', 40), 900_000); next(); }
  catch (err) { next(err); }
};

const runView = (run: InstanceType<typeof CodeRun> | (ICodeRun & { _id: unknown })) => {
  const doc = 'toObject' in run ? (run as any).toObject() : run;
  return { ...doc, id: String(doc._id), problemTitle: PROBLEM_BY_ID.get(doc.problemId)?.title };
};

router.get('/status', async (_req, res, next) => {
  try {
    const status = await runnerStatus();
    res.json({ runner: { configured: runnerConfigured(), ready: !!status?.ok, languages: status?.languages ?? {} }, aiAvailable: interviewMode() === 'ai' });
  } catch (err) { next(err); }
});

router.get('/problems', async (req, res, next) => {
  try {
    const progress = await CodeRun.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId(req)), mode: 'submit' } },
      { $group: { _id: '$problemId', submissions: { $sum: 1 }, solved: { $max: { $cond: [{ $eq: ['$verdict', 'accepted'] }, 1, 0] } } } },
    ]);
    const byId = new Map(progress.map(p => [p._id as string, p]));
    res.json({ problems: PROBLEMS.map(p => ({ id: p.id, title: p.title, kind: p.kind, difficulty: p.difficulty, topics: p.topics, languages: languagesFor(p),
      submissions: byId.get(p.id)?.submissions ?? 0, solved: byId.get(p.id)?.solved === 1 })) });
  } catch (err) { next(err); }
});

router.get('/problems/:id', async (req, res, next) => {
  try {
    const problem = PROBLEM_BY_ID.get(req.params.id);
    if (!problem) { res.status(404).json({ error: 'Problem not found.' }); return; }
    const runs = await CodeRun.find({ userId: userId(req), problemId: problem.id }).sort({ createdAt: -1, _id: -1 }).limit(10)
      .select('language mode verdict passed total createdAt followUp.review.createdAt').lean();
    const languages = languagesFor(problem);
    const examples = exampleCases(problem).map((t, i) => ({ args: t.args, expected: t.expected, explanation: problem.examples[i]?.explanation }));
    res.json({ problem: {
      id: problem.id, title: problem.title, kind: problem.kind, difficulty: problem.difficulty, topics: problem.topics,
      statement: problem.statement, constraints: problem.constraints, languages, examples,
      ...(problem.kind === 'sql'
        ? { schema: problem.schema, columns: problem.columns, ordered: problem.ordered, starters: { sql: '-- Write one SELECT query\n' } }
        : { signature: problem.signature, compare: problem.compare ?? 'exact',
          starters: Object.fromEntries(languages.map(l => [l, starterCode(problem, l as CodeLanguage)])) }),
      hiddenTests: testCases(problem, 'submit').filter(t => !t.visible).length,
    }, runs: runs.map(r => ({ ...r, id: String(r._id) })), languageLabels: LANGUAGE_LABELS, rubric: CODING_RUBRIC });
  } catch (err) { next(err); }
});

const runSchema = z.object({ language: z.enum(['javascript', 'typescript', 'python', 'java', 'cpp', 'sql']), source: z.string().min(1).max(65_536),
  mode: z.enum(['run', 'submit']) });
router.post('/problems/:id/runs', runLimit, async (req, res, next) => {
  try {
    const problem = PROBLEM_BY_ID.get(req.params.id);
    if (!problem) { res.status(404).json({ error: 'Problem not found.' }); return; }
    const parsed = runSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.source.trim()) { res.status(400).json({ error: 'Choose a language and write some code (up to 64 KB).' }); return; }
    const { language, source, mode } = parsed.data;
    if (!languagesFor(problem).includes(language)) { res.status(400).json({ error: `This problem accepts ${languagesFor(problem).map(l => LANGUAGE_LABELS[l]).join(', ')}.` }); return; }
    const status = await runnerStatus();
    if (status?.ok && status.languages && !status.languages[runnerLanguage(language)]) {
      res.status(409).json({ error: `${LANGUAGE_LABELS[language]} is not available on this code runner.` }); return;
    }
    const tests = testCases(problem, mode);
    const nonce = randomBytes(9).toString('hex');
    const program = buildProgram(problem, language, source, nonce);
    let response;
    try { response = await runOnRunner({ ...program, stdin: stdinFor(tests), timeLimitMs: runTimeLimit(problem, language, mode) }); }
    catch (err) {
      if (!(err instanceof RunnerUnavailableError)) throw err;
      health = undefined;
      res.status(503).json({ error: err.message, code: 'RUNNER_UNAVAILABLE' }); return;
    }
    const graded = grade(problem, language, source.split('\n').length, tests, nonce, response);
    if (graded.verdict === 'runner_error') operationalEvent('code_runner_failure', 'WARNING');
    const run = await CodeRun.create({ userId: userId(req), problemId: problem.id, language, mode, source, ...graded,
      runnerVersion: (response as { runner?: { version?: string } }).runner?.version });
    res.status(201).json({ run: runView(run) });
  } catch (err) { next(err); }
});

router.get('/runs/:id', async (req, res, next) => {
  try {
    const run = mongoose.isValidObjectId(req.params.id) ? await CodeRun.findOne({ _id: req.params.id, userId: userId(req) }) : null;
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    res.json({ run: runView(run) });
  } catch (err) { next(err); }
});

const contextFor = (run: InstanceType<typeof CodeRun>, problem: Problem, req: any, interfaceLanguage?: typeof INTERVIEW_LANGUAGES[number]) => ({
  usageContext: { userId: userId(req) }, problem, language: run.language, source: run.source,
  verdict: run.verdict, passed: run.passed, total: run.total, tests: run.tests, interfaceLanguage });

// One interviewer question per submission. Synchronous like answer rewrites: nothing is lost if it fails.
router.post('/runs/:id/follow-up', aiLimit, async (req, res, next) => {
  try {
    const run = mongoose.isValidObjectId(req.params.id) ? await CodeRun.findOne({ _id: req.params.id, userId: userId(req) }) : null;
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    if (run.followUp) { res.json({ run: runView(run), replayed: true }); return; }
    const problem = PROBLEM_BY_ID.get(run.problemId);
    if (!problem || run.mode !== 'submit' || run.verdict === 'compile_error' || run.verdict === 'runner_error') {
      res.status(409).json({ error: 'The interviewer follow-up is available for submissions that ran.' }); return;
    }
    if (interviewMode() !== 'ai') { res.status(409).json({ error: 'The AI interviewer is not enabled on this server.' }); return; }
    const language = z.enum(INTERVIEW_LANGUAGES).catch('en').parse(req.body?.language);
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let asked;
    try { asked = await askFollowUp(contextFor(run, problem, req, language)); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('coding_follow_up_failure', 'WARNING');
      res.status(502).json({ error: 'The interviewer question could not be written. Please try again.' }); return;
    }
    const updated = await CodeRun.findOneAndUpdate({ _id: run._id, userId: userId(req), followUp: { $exists: false } },
      { $set: { followUp: { question: asked.question, generation: asked.generation, askedAt: new Date() } } }, { new: true })
      ?? await CodeRun.findOne({ _id: run._id, userId: userId(req) });
    res.status(201).json({ run: runView(updated!) });
  } catch (err) { next(err); }
});

const answerSchema = z.object({ answer: z.string().trim().min(10).max(3500), language: z.enum(INTERVIEW_LANGUAGES).optional() });
router.post('/runs/:id/answer', aiLimit, async (req, res, next) => {
  try {
    const run = mongoose.isValidObjectId(req.params.id) ? await CodeRun.findOne({ _id: req.params.id, userId: userId(req) }) : null;
    if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Explain your approach in 10 to 3500 characters.' }); return; }
    if (!run.followUp) { res.status(409).json({ error: 'Ask for the interviewer question first.' }); return; }
    if (run.followUp.review) { res.json({ run: runView(run), replayed: true }); return; }
    const problem = PROBLEM_BY_ID.get(run.problemId)!;
    await requireAIConsent(userId(req));
    await consumeAIQuota(userId(req));
    let review;
    try { review = await reviewSubmission({ ...contextFor(run, problem, req, parsed.data.language), question: run.followUp.question, answer: parsed.data.answer }); }
    catch (err) {
      if (err instanceof ConsentRequiredError) throw err;
      operationalEvent('coding_review_failure', 'WARNING');
      res.status(502).json({ error: 'Your explanation could not be reviewed. It was not saved; please try again.' }); return;
    }
    const updated = await CodeRun.findOneAndUpdate({ _id: run._id, userId: userId(req), 'followUp.review': { $exists: false } },
      { $set: { 'followUp.answer': parsed.data.answer, 'followUp.answeredAt': new Date(), 'followUp.review': { ...review, createdAt: new Date() } } }, { new: true })
      ?? await CodeRun.findOne({ _id: run._id, userId: userId(req) });
    res.status(201).json({ run: runView(updated!) });
  } catch (err) { next(err); }
});

export default router;
