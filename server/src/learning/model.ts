import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs';
import type { InterviewLevel } from '../models/Interview.js';

// Per-skill ability on the 0–5 rubric scale, kept as a Gaussian belief (mean, variance) and updated with a
// one-dimensional Kalman filter. Each scored criterion is a noisy observation of ability, shifted by question
// difficulty. Variance grows while a skill is not practised, so stale estimates show as less certain. Item
// response theory (2PL) calibration needs response data from many learners and is not attempted yet.
export const PRIOR_MEAN = 2.5;
export const PRIOR_VARIANCE = 1.5 ** 2;
export const OBSERVATION_NOISE = 1.0;      // variance of one rubric score around true ability
export const WEAK_OBSERVATION_NOISE = 2.0; // "insufficient evidence": treated as 0, with less confidence
export const DRIFT_PER_DAY = 0.01;         // variance added per day without practice
const DIFFICULTY_OFFSET: Record<InterviewLevel, number> = { Beginner: -0.5, Intermediate: 0, Advanced: 0.5 };

export type Belief = { mean: number; variance: number; lastObservedAt?: Date };
export type Observation = { score: number | null; difficulty: InterviewLevel; at: Date };

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// The belief as of a later moment: same mean, with the variance that has built up since the last observation.
export function current(belief: Belief, at: Date): Belief {
  const days = belief.lastObservedAt ? Math.max(0, (at.getTime() - belief.lastObservedAt.getTime()) / 86_400_000) : 0;
  return { ...belief, variance: Math.min(PRIOR_VARIANCE, belief.variance + DRIFT_PER_DAY * days) };
}

export function observe(belief: Belief, obs: Observation): Belief {
  const prior = current(belief, obs.at).variance;
  const noise = obs.score === null ? WEAK_OBSERVATION_NOISE : OBSERVATION_NOISE;
  const evidence = clamp((obs.score ?? 0) + DIFFICULTY_OFFSET[obs.difficulty], 0, 5);
  const gain = prior / (prior + noise);
  return { mean: clamp(belief.mean + gain * (evidence - belief.mean), 0, 5), variance: (1 - gain) * prior, lastObservedAt: obs.at };
}

export const sd = (b: Belief) => Math.sqrt(b.variance);
export const lowerBound = (b: Belief) => clamp(b.mean - 1.96 * sd(b), 0, 5);
export const upperBound = (b: Belief) => clamp(b.mean + 1.96 * sd(b), 0, 5);
export function level(b: Belief): 'Needs work' | 'Developing' | 'Proficient' | 'Strong' {
  return b.mean < 1.5 ? 'Needs work' : b.mean < 2.5 ? 'Developing' : b.mean < 3.5 ? 'Proficient' : 'Strong';
}
export const lowConfidence = (b: Belief) => sd(b) > 0.8;
export const drillDifficulty = (b: Belief): InterviewLevel => b.mean < 2 ? 'Beginner' : b.mean < 3.5 ? 'Intermediate' : 'Advanced';

// Spaced retests with FSRS. Skills are scheduled in days (no minute-level learning steps), and one interview's
// average evidence for the skill grades the review.
const scheduler = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));
export const newCard = (at: Date): Card => createEmptyCard(at);
export function gradeFor(averageEvidence: number): Grade {
  return averageEvidence < 1.5 ? Rating.Again : averageEvidence < 2.5 ? Rating.Hard : averageEvidence < 4 ? Rating.Good : Rating.Easy;
}
export function review(card: Card, at: Date, averageEvidence: number): Card {
  return scheduler.next(card, at, gradeFor(averageEvidence)).card;
}

// Readiness for the focus areas: 20 × the average of (mean − one standard deviation) over practised competency
// skills, so uncertainty lowers it. Shown with this explanation, never as a hiring prediction.
export function readiness(beliefs: Belief[]): number | null {
  if (!beliefs.length) return null;
  return Math.round(20 * beliefs.reduce((sum, b) => sum + clamp(b.mean - sd(b), 0, 5), 0) / beliefs.length);
}
