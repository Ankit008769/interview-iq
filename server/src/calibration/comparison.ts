import { z } from 'zod';
import { evaluateInterview } from '../services/ai.js';
import { criteriaFor, datasetHash, modelRatingSchema, RUBRIC_VERSION, type CalibrationItem } from './dataset.js';
const rowSchema = z.object({
  itemId: z.string(), status: z.enum(['succeeded', 'failed']), latencyMs: z.number().finite().nonnegative(),
  model: z.string(), promptVersion: z.string().nullable(), inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(), costUsd: z.number().finite().nonnegative().nullable(),
  costReason: z.string(), rateVersion: z.string().nullable(), supportedCriteria: z.number().int().nonnegative(), totalCriteria: z.number().int().nonnegative(),
  ratings: z.array(modelRatingSchema).optional(),
}).strict();
export const runSchema = z.object({
  version: z.literal(1), label: z.string().min(1).max(100), datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  itemIds: z.array(z.string()).min(1), rubricVersion: z.string(), provider: z.string(), endpoint: z.string(),
  requestedModel: z.string(), startedAt: z.string().datetime(), reviewed: z.boolean(), rows: z.array(rowSchema),
}).strict();
export type ComparisonRun = z.infer<typeof runSchema>;
export function newRun(items: CalibrationItem[], metadata: Pick<ComparisonRun, 'label'|'provider'|'endpoint'|'requestedModel'|'reviewed'>): ComparisonRun {
  if (!items.length) throw new Error('Comparison requires a non-empty dataset.');
  return runSchema.parse({ version: 1, ...metadata, datasetHash: datasetHash(items),
    itemIds: items.map(item => item.id), rubricVersion: RUBRIC_VERSION, startedAt: new Date().toISOString(), rows: [] });
}
export async function measureRun(items: CalibrationItem[], run: ComparisonRun, evaluate = evaluateInterview, checkpoint?: (run: ComparisonRun) => void) {
  for (const item of items) {
    const started = Date.now();
    let row: ComparisonRun['rows'][number];
    try {
      const feedback = await evaluate({ mode: 'ai', role: item.role, type: item.type, difficulty: item.difficulty, topic: item.topic,
        history: [{ question: item.question, answer: item.answer, topic: item.topic, answeredAt: new Date(0) }] });
      if (!feedback.generation || !feedback.answers?.[0]) throw new Error('No scorecard');
      const g = feedback.generation, criteria = feedback.answers[0].criteria;
      row = { itemId: item.id, status: 'succeeded', latencyMs: Date.now() - started, model: g.model, promptVersion: g.promptVersion,
        inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: g.cost?.amountUsd ?? null, costReason: g.cost?.reason ?? 'unpriced', rateVersion: g.cost?.rate?.version ?? null,
        supportedCriteria: criteria.filter(c => c.score !== null && c.evidence).length, totalCriteria: criteria.length,
        ratings: criteria.map(c => ({ itemId: item.id, criterionId: c.criterionId, score: c.score, quote: c.evidence?.quote ?? null,
          rationale: c.rationale, model: g.model, promptVersion: g.promptVersion,
          rubricVersion: feedback.rubric?.version ?? RUBRIC_VERSION, datasetHash: run.datasetHash })) };
      rowSchema.parse(row); // Malformed scorecards remain measured failures and are checkpointed.
    } catch {
      // Failure is a measured outcome, never a free request or an excluded item.
      // Provider errors/content are deliberately excluded from persisted reports.
      row = { itemId: item.id, status: 'failed', latencyMs: Date.now() - started, model: run.requestedModel, promptVersion: null,
        inputTokens: null, outputTokens: null, costUsd: null, costReason: 'failed_attempt_usage_unknown', rateVersion: null, supportedCriteria: 0, totalCriteria: 0 };
    }
    run.rows.push(rowSchema.parse(row)); checkpoint?.(run);
  }
  return run;
}
const percentile = (values: number[], p: number) => [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)] ?? null;
export function calibrationRatings(input: unknown, items: CalibrationItem[]) {
  const run = runSchema.parse(input);
  if (!run.reviewed || run.datasetHash !== datasetHash(items) || run.rubricVersion !== RUBRIC_VERSION ||
      JSON.stringify(run.itemIds) !== JSON.stringify(items.map(i => i.id)) || run.rows.length !== items.length ||
      new Set(run.rows.map(r => r.itemId)).size !== items.length) throw new Error('Calibration export requires a complete reviewed run on the exact dataset.');
  return run.rows.flatMap(row => {
    const item = items.find(i => i.id === row.itemId);
    const expected = item ? criteriaFor(item).map(c => c.id).sort() : [];
    if (row.status !== 'succeeded' || !row.ratings?.length || !run.itemIds.includes(row.itemId) ||
        JSON.stringify(row.ratings.map(r => r.criterionId).sort()) !== JSON.stringify(expected) ||
        row.ratings.some(r => r.itemId !== row.itemId || r.model !== row.model || r.promptVersion !== row.promptVersion ||
          r.datasetHash !== run.datasetHash || r.rubricVersion !== run.rubricVersion)) throw new Error('Missing or incompatible scorecards; do not silently exclude failed items.');
    return row.ratings;
  });
}
export function compareRuns(input: unknown[]) {
  if (input.length < 2) throw new Error('Provide at least two runs.');
  const runs = input.map(v => runSchema.parse(v)), first = runs[0];
  if (new Set(runs.map(r=>r.label)).size !== runs.length) throw new Error('Run labels must be unique.');
  const prompts = new Set(runs.flatMap(r=>r.rows.flatMap(row=>row.promptVersion ? [row.promptVersion] : [])));
  if (prompts.size > 1) throw new Error('Prompt versions differ; do not compare unlike evaluations.');
  for (const run of runs) {
    if (run.datasetHash !== first.datasetHash || run.rubricVersion !== first.rubricVersion || JSON.stringify(run.itemIds) !== JSON.stringify(first.itemIds)) throw new Error('Dataset or rubric mismatch.');
    if (new Set(run.itemIds).size !== run.itemIds.length || run.rows.length !== run.itemIds.length || new Set(run.rows.map(r=>r.itemId)).size !== run.rows.length
      || run.rows.some(row=>!run.itemIds.includes(row.itemId) || row.supportedCriteria > row.totalCriteria)) throw new Error('Incomplete or invalid run.');
  }
  return { datasetHash: first.datasetHash, rubricVersion: first.rubricVersion, promptVersion: [...prompts][0] ?? null,
    reviewed: runs.every(r=>r.reviewed), qualityVerdict: 'Not measured: use independent human calibration and evidence audits. No automatic winner.',
    runs: runs.map(run=>({ label: run.label, provider: run.provider, requestedModel: run.requestedModel, startedAt: run.startedAt,
      rateVersions: [...new Set(run.rows.flatMap(r=>r.rateVersion ? [r.rateVersion] : []))],
      inputTokensReported: run.rows.reduce((sum,r)=>sum+(r.inputTokens??0),0), outputTokensReported: run.rows.reduce((sum,r)=>sum+(r.outputTokens??0),0),
      unknownUsageAttempts: run.rows.filter(r=>r.inputTokens===null||r.outputTokens===null).length,
      resolvedModels: [...new Set(run.rows.map(r=>r.model))], attempts: run.rows.length, failures: run.rows.filter(r=>r.status==='failed').length,
      p50LatencyMs: percentile(run.rows.map(r=>r.latencyMs),.5), p95LatencyMs: percentile(run.rows.map(r=>r.latencyMs),.95),
      estimatedCostUsd: run.rows.reduce((sum,r)=>sum+(r.costUsd??0),0), unknownCostAttempts: run.rows.filter(r=>r.costUsd===null).length,
      supportedCriteria: run.rows.reduce((sum,r)=>sum+r.supportedCriteria,0), totalCriteria: run.rows.reduce((sum,r)=>sum+r.totalCriteria,0),
    })) };
}
