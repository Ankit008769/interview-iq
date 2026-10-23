import { describe, expect, it } from 'vitest';
import { verifyEvidence, summarizeEvidence } from '../src/services/evidence.js';
import { rubricFor } from '../src/services/rubrics.js';
import type { AnswerTurn, InterviewType } from '../src/models/Interview.js';
const answer = '🙂 Arrays allow indexed access. Linked lists require traversal.';
const turns: AnswerTurn[] = [{ question: 'Compare arrays and linked lists.', answer, topic: 'DSA', answeredAt: new Date() }];
function response(type: InterviewType = 'Technical') {
  return { answers: [{ questionIndex: 0, criteria: rubricFor(type).criteria.map(c => ({ criterionId: c.id,
    score: 4, quote: 'Arrays allow indexed access.', rationale: 'The comparison includes indexed reads.', improvement: 'Explain the cost of insertion.' })) }] };
}
describe('verified evidence contract', () => {
  it('computes exact UTF-16 offsets against the complete saved answer', () => {
    const result = verifyEvidence(response(), turns, 'Technical');
    const span = result[0].criteria[0].evidence!;
    expect(span.start).toBe(3);
    expect(answer.slice(span.start, span.end)).toBe(span.quote);
    expect(summarizeEvidence(result).score).toBe(80);
  });
  it('removes fabricated quotes, scores and advice instead of displaying unsupported feedback', () => {
    const raw = response();
    raw.answers[0].criteria[0].quote = 'I built a database.';
    const rating = verifyEvidence(raw, turns, 'Technical')[0].criteria[0];
    expect(rating).toMatchObject({ score: null, status: 'insufficient_evidence', evidence: null, improvement: null });
    expect(rating.rationale).not.toContain('indexed');
  });
  it('does not accept quotes from a different answer or the question', () => {
    const raw = response(); raw.answers[0].criteria.forEach(c => c.quote = turns[0].question);
    expect(summarizeEvidence(verifyEvidence(raw, turns, 'Technical')).score).toBeNull();
  });
  it('distinguishes an evidenced zero from absent evidence and requires half the criteria for an aggregate', () => {
    const raw = response(); raw.answers[0].criteria.forEach(c => { c.score = 0; c.quote = ''; });
    raw.answers[0].criteria[0].quote = 'Arrays allow indexed access.';
    const result = verifyEvidence(raw, turns, 'Technical');
    expect(result[0].criteria[0].score).toBe(0);
    expect(summarizeEvidence(result).score).toBeNull();
  });
  it('rejects missing, duplicate, unknown and out-of-range references', () => {
    const duplicate = response(); duplicate.answers[0].criteria[1].criterionId = 'correctness';
    expect(() => verifyEvidence(duplicate, turns, 'Technical')).toThrow();
    const unknown = response(); unknown.answers[0].criteria[0].criterionId = 'personality';
    expect(() => verifyEvidence(unknown, turns, 'Technical')).toThrow();
    const missing = response(); missing.answers[0].criteria.pop();
    expect(() => verifyEvidence(missing, turns, 'Technical')).toThrow();
    const wrongTurn = response(); wrongTurn.answers[0].questionIndex = 3;
    expect(() => verifyEvidence(wrongTurn, turns, 'Technical')).toThrow();
    expect(() => verifyEvidence({ answers: [response().answers[0], response().answers[0]] }, [...turns, ...turns], 'Technical')).toThrow();
  });
  it.each(['Technical', 'Behavioral', 'HR'] as InterviewType[])('uses the distinct %s rubric', type => {
    const result = verifyEvidence(response(type), turns, type);
    expect(result[0].criteria.map(c => c.criterionId)).toEqual(rubricFor(type).criteria.map(c => c.id));
  });
  it('rejects out-of-scale scores instead of clamping them', () => {
    const raw = response(); raw.answers[0].criteria[0].score = 100;
    expect(() => verifyEvidence(raw, turns, 'Technical')).toThrow();
  });
});
