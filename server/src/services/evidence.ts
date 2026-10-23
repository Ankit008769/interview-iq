import { z } from 'zod';
import type { AnswerTurn, InterviewType } from '../models/Interview.js';
import { rubricFor } from './rubrics.js';

export const evidenceResponseSchema = z.object({ answers: z.array(z.object({
  questionIndex: z.number().int().min(0).max(4),
  criteria: z.array(z.object({ criterionId: z.string(), score: z.number().int().min(0).max(5).nullable(),
    quote: z.string().nullable(), rationale: z.string().max(600), improvement: z.string().max(400).nullable() })).min(4).max(5),
})).min(1).max(5) });
export interface CriterionRating {
  criterionId: string; label: string; score: number | null;
  status: 'rated' | 'insufficient_evidence'; rationale: string; improvement: string | null;
  evidence: { quote: string; start: number; end: number } | null;
}
export interface AnswerEvaluation { questionIndex: number; criteria: CriterionRating[] }

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
      const quote = rating.quote;
      const start = quote && quote.trim() ? turn.answer.indexOf(quote) : -1;
      if (rating.score === null || start < 0 || !quote) return { criterionId: criterion.id, label: criterion.label,
        score: null, status: 'insufficient_evidence' as const, evidence: null, improvement: null,
        rationale: 'There is not enough verified evidence in this answer to assign this rating.' };
      return { criterionId: criterion.id, label: criterion.label, score: rating.score, status: 'rated' as const,
        rationale: rating.rationale, improvement: rating.improvement,
        evidence: { quote, start, end: start + quote.length } };
    }) };
  }).sort((a, b) => a.questionIndex - b.questionIndex);
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
