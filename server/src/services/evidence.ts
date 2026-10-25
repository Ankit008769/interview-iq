import { z } from 'zod';
import type { AnswerTurn, InterviewType } from '../models/Interview.js';
import { rubricFor } from './rubrics.js';

const ratingFields = { score: z.number().int().min(0).max(5).nullable(),
  quote: z.string().nullable(), rationale: z.string().max(600), improvement: z.string().max(400).nullable() };
export const evidenceResponseSchema = z.object({ answers: z.array(z.object({
  questionIndex: z.number().int().min(0).max(4),
  criteria: z.array(z.object({ criterionId: z.string(), ...ratingFields })).min(4).max(5),
})).min(1).max(5) });
export const ratingResponseSchema = z.object(ratingFields);
// The schema sent with a scoring request names this rubric's criteria and requires each answer and criterion once,
// so constrained decoding (local models) cannot produce unknown IDs or the wrong count.
export function evidenceSchemaFor(type: InterviewType, turns: number) {
  const ids = rubricFor(type).criteria.map(c => c.id) as [string, ...string[]];
  return z.object({ answers: z.array(z.object({
    questionIndex: z.number().int().min(0).max(turns - 1),
    criteria: z.array(z.object({ criterionId: z.enum(ids), ...ratingFields })).length(ids.length),
  })).length(turns) });
}
export interface CriterionRating {
  criterionId: string; label: string; score: number | null;
  status: 'rated' | 'insufficient_evidence'; rationale: string; improvement: string | null;
  evidence: { quote: string; start: number; end: number } | null;
  revisedBy?: string;
}
export interface AnswerEvaluation { questionIndex: number; criteria: CriterionRating[] }

// A score needs a nonblank quote found verbatim in the same answer; anything else is unscored, not zero.
export function verifyRating(rating: z.infer<typeof ratingResponseSchema>, answer: string, criterion: { id: string; label: string }): CriterionRating {
  const quote = rating.quote;
  const start = quote && quote.trim() ? answer.indexOf(quote) : -1;
  if (rating.score === null || start < 0 || !quote) return { criterionId: criterion.id, label: criterion.label,
    score: null, status: 'insufficient_evidence', evidence: null, improvement: null,
    rationale: 'There is not enough verified evidence in this answer to assign this rating.' };
  return { criterionId: criterion.id, label: criterion.label, score: rating.score, status: 'rated',
    rationale: rating.rationale, improvement: rating.improvement,
    evidence: { quote, start, end: start + quote.length } };
}

export function verifyEvidence(raw: z.infer<typeof evidenceResponseSchema>, turns: AnswerTurn[], type: InterviewType): AnswerEvaluation[] {
  const parsed = evidenceResponseSchema.parse(raw);
  if (parsed.answers.length !== turns.length || new Set(parsed.answers.map(a => a.questionIndex)).size !== turns.length) {
    throw new Error('Evaluation must cover each saved answer exactly once.');
  }
  const rubric = rubricFor(type);
  return parsed.answers.map(answer => {
    const turn = turns[answer.questionIndex];
    if (!turn || answer.criteria.length !== rubric.criteria.length || new Set(answer.criteria.map(c => c.criterionId)).size !== rubric.criteria.length) {
      throw new Error('Evaluation contains invalid answer or criterion references.');
    }
    return { questionIndex: answer.questionIndex, criteria: rubric.criteria.map(criterion => {
      const rating = answer.criteria.find(c => c.criterionId === criterion.id);
      if (!rating) throw new Error('Evaluation is missing a rubric criterion.');
      return verifyRating(rating, turn.answer, criterion);
    }) };
  }).sort((a, b) => a.questionIndex - b.questionIndex);
}

export const rewriteResponseSchema = z.object({
  parts: z.array(z.object({ kind: z.enum(['answer', 'addition']), text: z.string().trim().min(1).max(400), quote: z.string().nullable() })).min(1).max(12),
  summary: z.string().trim().max(400),
});
export type RewritePart = { kind: 'answer'; text: string; quote: string; start: number; end: number } | { kind: 'addition'; text: string };

// Keeps only rewritten sentences whose quote is found verbatim in the answer, and additions written as a
// bracketed prompt (e.g. "[Add the result, if you have one]") rather than as invented content.
export function verifyRewrite(raw: z.infer<typeof rewriteResponseSchema>, answer: string): { parts: RewritePart[]; summary: string; dropped: number } {
  const parsed = rewriteResponseSchema.parse(raw);
  const parts: RewritePart[] = [];
  for (const part of parsed.parts) {
    if (part.kind === 'addition') {
      if (/^\[[^\]]+\]$/.test(part.text)) parts.push({ kind: 'addition', text: part.text });
      continue;
    }
    const start = part.quote && part.quote.trim() ? answer.indexOf(part.quote) : -1;
    if (start >= 0) parts.push({ kind: 'answer', text: part.text, quote: part.quote!, start, end: start + part.quote!.length });
  }
  if (!parts.some(p => p.kind === 'answer')) throw new Error('The rewrite contained no sentence grounded in the answer.');
  return { parts, summary: parsed.summary, dropped: parsed.parts.length - parts.length };
}

export function summarizeEvidence(answers: AnswerEvaluation[]) {
  const all = answers.flatMap(a => a.criteria);
  const rated = all.filter(c => c.score !== null);
  const enough = rated.length >= Math.ceil(all.length / 2);
  return {
    score: enough ? Math.round(rated.reduce((sum, c) => sum + c.score!, 0) / rated.length * 20) : null,
    summary: `${rated.length} of ${all.length} criterion ratings have verified answer quotes. Unscored criteria are excluded. This is AI coaching feedback, not a hiring prediction.`,
    strengths: rated.filter(c => c.score! >= 4).slice(0, 5).map(c => `${c.label}: ${c.rationale}`),
    improvements: rated.filter(c => c.improvement).slice(0, 5).map(c => `${c.label}: ${c.improvement}`),
    nextSteps: rated.filter(c => c.improvement).slice(0, 3).map(c => c.improvement!),
  };
}

export const STAR_PARTS = ['situation', 'task', 'action', 'result'] as const;
export const starResponseSchema = z.object({
  parts: z.array(z.object({ part: z.enum(STAR_PARTS), quote: z.string().nullable(), tip: z.string().max(300).nullable() })).length(4),
});
export type StarPart = { part: typeof STAR_PARTS[number]; status: 'found'; quote: string; start: number; end: number }
  | { part: typeof STAR_PARTS[number]; status: 'missing'; tip?: string };

// A STAR part counts as found only with a quote found verbatim in the answer; otherwise it is missing, with
// the model's suggestion of what to add. Each part must appear exactly once.
export function verifyStar(raw: z.infer<typeof starResponseSchema>, answer: string): StarPart[] {
  const parsed = starResponseSchema.parse(raw);
  if (new Set(parsed.parts.map(p => p.part)).size !== STAR_PARTS.length) throw new Error('The STAR check must cover each part once.');
  return STAR_PARTS.map(part => {
    const item = parsed.parts.find(p => p.part === part)!;
    const quote = item.quote?.trim();
    const start = quote ? answer.indexOf(quote) : -1;
    if (quote && start >= 0) return { part, status: 'found', quote, start, end: start + quote.length };
    const tip = item.tip?.trim();
    return { part, status: 'missing', ...(tip ? { tip } : {}) };
  });
}
