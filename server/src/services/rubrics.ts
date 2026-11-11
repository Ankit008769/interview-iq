import type { InterviewType } from '../models/Interview.js';

export const RUBRIC_VERSION = '2026-10-24.v1';
export const JUDGE_PROMPT_VERSION = 'evidence-judge.v2';
export const CHALLENGE_PROMPT_VERSION = 'challenge-review.v1';
export const REWRITE_PROMPT_VERSION = 'answer-rewrite.v1';
export const QUESTION_PROMPT_VERSION = 'interviewer.v3';
export const GROUNDED_QUESTION_PROMPT_VERSION = 'interviewer-grounded.v2';
export const STAR_PROMPT_VERSION = 'star-coverage.v1';
export const CODING_FOLLOWUP_PROMPT_VERSION = 'coding-followup.v1';
export const PROJECT_QUESTION_PROMPT_VERSION = 'interviewer-project.v1';
export const PROJECT_CLAIMS_PROMPT_VERSION = 'project-claims.v1';
export const DESIGN_FOLLOWUP_PROMPT_VERSION = 'design-followup.v1';
export const DESIGN_REVIEW_PROMPT_VERSION = 'design-review.v1';
// Asked only when the review scored criteria without a quote that is in the candidate's text.
export const DESIGN_QUOTE_PROMPT_VERSION = 'design-quote.v1';
export const CODING_REVIEW_PROMPT_VERSION = 'coding-review.v1';
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

// Coding lab (C2): test results come from the sandbox and are never rated by the model; these criteria cover
// what tests cannot show. Evidence quotes must come from the candidate's code or explanation.
export const CODING_RUBRIC = { version: '2026-10-25.coding.v1', scale: '0–5; insufficient evidence is unscored', anchors,
  criteria: [
    { id: 'approach', label: 'Algorithmic approach', guidance: 'Is the chosen algorithm and data structure suitable for the problem and its constraints, judged from the code and explanation?' },
    { id: 'complexity', label: 'Complexity reasoning', guidance: 'Does the explanation state time and space complexity correctly for this code, and connect it to the input size?' },
    { id: 'quality', label: 'Code quality', guidance: 'Is the code readable and organized: clear names, no needless duplication, edge cases handled deliberately?' },
    { id: 'explanation', label: 'Explanation', guidance: 'Does the explanation answer the interviewer question clearly and accurately describe what the code does?' },
  ] };

// System design (C3): the trade-off rubric. Capacity verdicts and structural observations come from the app;
// evidence quotes must come from the candidate's labels, notes, explanation or follow-up answers.
export const DESIGN_RUBRIC = { version: '2026-11-11.design.v1', scale: '0–5; insufficient evidence is unscored', anchors,
  criteria: [
    { id: 'requirements', label: 'Requirements and scope', guidance: 'Does the design address the functional and non-functional requirements, and state assumptions?' },
    { id: 'architecture', label: 'High-level architecture', guidance: 'Are the components and their connections sensible for the problem, with clear responsibilities?' },
    { id: 'data', label: 'Data model and storage', guidance: 'Are storage choices justified by the access patterns, consistency needs and data size?' },
    { id: 'scale', label: 'Scalability and capacity', guidance: 'Does the design handle the stated load and peaks, using sound estimates, caching, partitioning or queues where they help?' },
    { id: 'reliability', label: 'Reliability and failure handling', guidance: 'Does it avoid single points of failure and say what happens when components fail or slow down?' },
    { id: 'tradeoffs', label: 'Trade-off reasoning', guidance: 'Does the candidate compare alternatives and explain why their choice fits, including under the changed constraints?' },
  ] };
