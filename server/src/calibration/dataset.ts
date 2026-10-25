import { z } from 'zod';
import { createHash } from 'node:crypto';
import { RUBRIC_VERSION, rubricFor } from '../services/rubrics.js';
import { parseCsv, writeCsv } from './csv.js';

// A calibration item is one answer to rate. Use only synthetic, licensed or explicitly research-consented
// content; never export user interviews into a calibration set without that consent.
export const itemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  type: z.enum(['Technical', 'Behavioral', 'HR']),
  role: z.string().min(2).max(100),
  difficulty: z.enum(['Beginner', 'Intermediate', 'Advanced']),
  topic: z.string().min(2).max(100),
  question: z.string().min(5).max(650),
  answer: z.string().min(10).max(3500),
  source: z.enum(['synthetic', 'licensed', 'consented']),
  intendedQuality: z.enum(['strong', 'adequate', 'weak', 'off_topic']).optional(),
});
export type CalibrationItem = z.infer<typeof itemSchema>;
export type Score = number | null; // null = insufficient evidence
export type HumanRating = { itemId: string; criterionId: string; raterId: string; score: Score; quote: string; datasetHash?: string };
export const modelRatingSchema = z.object({
  itemId: z.string().min(1), criterionId: z.string().min(1), score: z.number().int().min(0).max(5).nullable(),
  quote: z.string().nullable(), rationale: z.string(), model: z.string().min(1), promptVersion: z.string().min(1),
  rubricVersion: z.string().min(1), datasetHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ModelRating = z.infer<typeof modelRatingSchema>;
export const datasetHash = (items: CalibrationItem[]) => createHash('sha256').update(JSON.stringify(items)).digest('hex');
export type AuditRow = { itemId: string; criterionId: string; auditorId: string; supported: 'yes' | 'partly' | 'no'; modelFingerprint?: string };
export const modelFingerprint = (rating: ModelRating) => createHash('sha256').update(JSON.stringify([
  rating.datasetHash ?? null, rating.itemId, rating.criterionId, rating.score, rating.quote, rating.rationale,
  rating.model, rating.promptVersion, rating.rubricVersion,
])).digest('hex');

export function parseItems(jsonl: string): CalibrationItem[] {
  const items = jsonl.split(/\r?\n/).filter(l => l.trim()).map((line, i) => {
    try { return itemSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Item line ${i + 1} is not a valid calibration item.`); }
  });
  const ids = new Set<string>();
  for (const item of items) { if (ids.has(item.id)) throw new Error(`Duplicate item id ${item.id}.`); ids.add(item.id); }
  return items;
}

const criteriaFor = (item: CalibrationItem) => rubricFor(item.type).criteria;

// Blind sheet: no AI scores and no intended quality. Item order is shuffled per rater (seeded by rater ID)
// to spread order and fatigue effects across raters.
export function ratingTemplate(items: CalibrationItem[], raterId: string): string {
  const hash = datasetHash(items);
  let seed = [...raterId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const order = items.map(item => ({ item, key: random() })).sort((a, b) => a.key - b.key).map(x => x.item);
  return writeCsv(['item_id', 'type', 'criterion_id', 'criterion', 'guidance', 'question', 'answer', 'dataset_hash', 'rater_id', 'score', 'evidence_quote', 'notes'],
    order.flatMap(item => criteriaFor(item).map(c => ({ item_id: item.id, type: item.type, criterion_id: c.id, criterion: c.label,
      guidance: c.guidance, question: item.question, answer: item.answer, dataset_hash: hash, rater_id: raterId, score: '', evidence_quote: '', notes: '' }))));
}

export function auditTemplate(items: CalibrationItem[], model: ModelRating[], auditorId: string): string {
  const byId = new Map(items.map(i => [i.id, i]));
  return writeCsv(['item_id', 'criterion_id', 'answer', 'model_score', 'model_quote', 'model_rationale', 'model_fingerprint', 'auditor_id', 'supported', 'notes'],
    model.filter(m => m.score !== null).map(m => ({ item_id: m.itemId, criterion_id: m.criterionId, answer: byId.get(m.itemId)?.answer,
      model_score: m.score, model_quote: m.quote, model_rationale: m.rationale, model_fingerprint: modelFingerprint(m), auditor_id: auditorId, supported: '', notes: '' })));
}

export type ParseResult<T> = { rows: T[]; problems: string[] };

// Blank scores are skipped (unfinished sheets are fine); invalid values and unknown references are reported.
export function parseHumanRatings(csv: string, items: CalibrationItem[]): ParseResult<HumanRating> {
  const byId = new Map(items.map(i => [i.id, i]));
  const rows: HumanRating[] = [], problems: string[] = [], seen = new Set<string>();
  parseCsv(csv).forEach((r, i) => {
    const line = `rating row ${i + 2}`;
    if (!r.score) return;
    const item = byId.get(r.item_id);
    if (!item) { problems.push(`${line}: unknown item ${r.item_id}`); return; }
    if (!criteriaFor(item).some(c => c.id === r.criterion_id)) { problems.push(`${line}: unknown criterion ${r.criterion_id}`); return; }
    if (!r.rater_id) { problems.push(`${line}: missing rater_id`); return; }
    const raw = r.score.toUpperCase();
    const score = raw === 'IE' ? null : /^[0-5]$/.test(raw) ? Number(raw) : undefined;
    if (score === undefined) { problems.push(`${line}: score must be 0–5 or IE`); return; }
    const key = `${r.rater_id}|${r.item_id}|${r.criterion_id}`;
    if (seen.has(key)) { problems.push(`${line}: duplicate rating by ${r.rater_id}`); return; }
    seen.add(key);
    if (score !== null && r.evidence_quote && !item.answer.includes(r.evidence_quote)) problems.push(`${line}: evidence_quote is not an exact passage of the answer (rating kept)`);
    rows.push({ itemId: r.item_id, criterionId: r.criterion_id, raterId: r.rater_id, score, quote: r.evidence_quote ?? '',
      ...(r.dataset_hash ? {datasetHash:r.dataset_hash} : {}) });
  });
  return { rows, problems };
}

export function parseAudit(csv: string): ParseResult<AuditRow> {
  const rows: AuditRow[] = [], problems: string[] = [];
  parseCsv(csv).forEach((r, i) => {
    if (!r.supported) return;
    const supported = r.supported.toLowerCase();
    if (supported !== 'yes' && supported !== 'partly' && supported !== 'no') { problems.push(`audit row ${i + 2}: supported must be yes, partly or no`); return; }
    rows.push({ itemId: r.item_id, criterionId: r.criterion_id, auditorId: r.auditor_id, supported,
      ...(r.model_fingerprint ? {modelFingerprint: r.model_fingerprint} : {}) });
  });
  return { rows, problems };
}

export function parseModelRatings(jsonl: string): ModelRating[] {
  return jsonl.split(/\r?\n/).filter(l => l.trim()).map((line, i) => {
    try { return modelRatingSchema.parse(JSON.parse(line)); }
    catch { throw new Error(`Model rating line ${i + 1} is invalid.`); }
  });
}

export { RUBRIC_VERSION, criteriaFor };
