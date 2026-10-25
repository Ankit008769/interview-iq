import type { InterviewType } from '../models/Interview.js';

export const RUBRIC_VERSION = '2026-10-24.v1';
export const JUDGE_PROMPT_VERSION = 'evidence-judge.v1';
export const CHALLENGE_PROMPT_VERSION = 'challenge-review.v1';
export const REWRITE_PROMPT_VERSION = 'answer-rewrite.v1';
export const QUESTION_PROMPT_VERSION = 'interviewer.v3';
export const GROUNDED_QUESTION_PROMPT_VERSION = 'interviewer-grounded.v2';
export const STAR_PROMPT_VERSION = 'star-coverage.v1';
export const anchors = [
  'Explicit evidence is incorrect, off-topic or contradicts this criterion.',
  'Evidence shows a major misconception or a largely ineffective approach.',
  'Some relevant evidence, with a substantial gap or weak explanation.',
  'Mostly effective evidence, with one meaningful gap.',
  'Clear and effective evidence, with minor omissions.',
  'Precise, thorough evidence with relevant specifics and justified decisions.',
];
const definitions: Record<InterviewType, Array<[string, string, string]>> = {
  Technical: [
    ['correctness', 'Correctness', 'Assess explicit technical claims against established concepts. Do not treat an unmentioned detail as an incorrect claim.'],
    ['depth', 'Depth of understanding', 'Look for explanation of how and why the concept works, beyond naming it.'],
    ['approach', 'Problem-solving approach', 'Look for a reasoned sequence, assumptions or a method for solving the stated problem.'],
    ['tradeoffs', 'Trade-off awareness', 'Look for justified alternatives, constraints, complexity or edge cases relevant to the question.'],
    ['clarity', 'Communication clarity', 'Assess whether the written explanation is understandable and organized, not grammar, accent or dialect.'],
  ],
  Behavioral: [
    ['star', 'Situation, task, action and result', 'Look for a concrete situation, task, action and result; do not invent missing context.'],
    ['ownership', 'Personal ownership', 'Look for what the speaker personally did, separate from team actions.'],
    ['impact', 'Impact', 'Look for a specific outcome. Numbers help when appropriate but are not mandatory.'],
    ['reflection', 'Reflection and learning', 'Look for lessons and a concrete change in future behavior.'],
    ['relevance', 'Relevance', 'Assess whether the example directly answers the question.'],
  ],
  HR: [
    ['understanding', 'Role understanding', 'Look for accurate, specific understanding of the target role; do not require company facts when no company is provided.'],
    ['motivation', 'Motivation clarity', 'Look for an articulated connection between interests, experience and the role.'],
    ['framing', 'Professional framing', 'Look for a relevant, constructive explanation; do not score personal circumstances or protected traits.'],
    ['consistency', 'Consistency', 'Check explicit statements for consistency within the answer. Lack of context is insufficient evidence.'],
  ],
};
export function rubricFor(type: InterviewType) {
  return { version: RUBRIC_VERSION, type, scale: '0–5; insufficient evidence is unscored', anchors,
    criteria: definitions[type].map(([id, label, guidance]) => ({ id, label, guidance })) };
}
