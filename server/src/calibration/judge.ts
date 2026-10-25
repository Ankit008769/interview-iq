import type { InterviewFeedback } from '../models/Interview.js';
import { evaluateInterview, type QuestionContext } from '../services/ai.js';
import { datasetHash, RUBRIC_VERSION, type CalibrationItem, type ModelRating } from './dataset.js';

type Evaluate = (ctx: Omit<QuestionContext, 'turnIndex'>) => Promise<InterviewFeedback>;

// Scores each item with the production evaluator exactly as a one-answer interview, so calibration measures
// the same prompt, rubric and evidence verification that users get.
// attempts > 1 re-asks after an invalid scorecard (small local models occasionally produce one). With onSkip, an
// item that still fails is reported and left out instead of stopping the run.
export async function runJudge(items: CalibrationItem[], evaluate: Evaluate = evaluateInterview, progress?: (done: number) => void,
  options: { attempts?: number; onSkip?: (itemId: string) => void } = {}): Promise<ModelRating[]> {
  const out: ModelRating[] = [];
  const hash = datasetHash(items);
  for (const [i, item] of items.entries()) {
    let feedback: InterviewFeedback | undefined, failure: unknown;
    for (let attempt = 0; attempt < (options.attempts ?? 1) && !(feedback?.answers?.[0] && feedback.generation); attempt++) {
      try { feedback = await evaluate({ mode: 'ai', role: item.role, type: item.type, difficulty: item.difficulty, topic: item.topic,
        history: [{ question: item.question, answer: item.answer, topic: item.topic, answeredAt: new Date() }] }); }
      catch (err) { failure = err; feedback = undefined; }
    }
    const answer = feedback?.answers?.[0];
    if (!answer || !feedback?.generation) {
      if (options.onSkip) { options.onSkip(item.id); progress?.(i + 1); continue; }
      throw failure instanceof Error ? failure : new Error(`The evaluator returned no scorecard for ${item.id}.`);
    }
    for (const c of answer.criteria) out.push({ itemId: item.id, criterionId: c.criterionId, score: c.score, quote: c.evidence?.quote ?? null,
      rationale: c.rationale, model: feedback.generation.model, promptVersion: feedback.generation.promptVersion,
      rubricVersion: feedback.rubric?.version ?? RUBRIC_VERSION, datasetHash: hash });
    progress?.(i + 1);
  }
  return out;
}
