import type { InterviewFeedback } from '../models/Interview.js';
import { evaluateInterview, type QuestionContext } from '../services/ai.js';
import { datasetHash, RUBRIC_VERSION, type CalibrationItem, type ModelRating } from './dataset.js';

type Evaluate = (ctx: Omit<QuestionContext, 'turnIndex'>) => Promise<InterviewFeedback>;

// Scores each item with the production evaluator exactly as a one-answer interview, so calibration measures
// the same prompt, rubric and evidence verification that users get.
export async function runJudge(items: CalibrationItem[], evaluate: Evaluate = evaluateInterview, progress?: (done: number) => void): Promise<ModelRating[]> {
  const out: ModelRating[] = [];
  const hash = datasetHash(items);
  for (const [i, item] of items.entries()) {
    const feedback = await evaluate({ mode: 'ai', role: item.role, type: item.type, difficulty: item.difficulty, topic: item.topic,
      history: [{ question: item.question, answer: item.answer, topic: item.topic, answeredAt: new Date() }] });
    const answer = feedback.answers?.[0];
    if (!answer || !feedback.generation) throw new Error(`The evaluator returned no scorecard for ${item.id}.`);
    for (const c of answer.criteria) out.push({ itemId: item.id, criterionId: c.criterionId, score: c.score, quote: c.evidence?.quote ?? null,
      rationale: c.rationale, model: feedback.generation.model, promptVersion: feedback.generation.promptVersion,
      rubricVersion: feedback.rubric?.version ?? RUBRIC_VERSION, datasetHash: hash });
    progress?.(i + 1);
  }
  return out;
}
