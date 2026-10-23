import { useState } from 'react';
import type { CriterionRating, Feedback, Turn } from '../lib/api';

export function RubricGuide({ rubric }: { rubric: NonNullable<Feedback['rubric']> }) {
  return <details className="card rubric-guide">
    <summary>How the rubric works · {rubric.type}</summary>
    <p>Each criterion uses a 0–5 scale. Missing evidence is unscored, not zero. Version {rubric.version}.</p>
    <ul>{rubric.criteria.map(c => <li key={c.id}><strong>{c.label}:</strong> {c.guidance}</li>)}</ul>
    <ol start={0}>{rubric.anchors.map((anchor, i) => <li key={i}>{anchor}</li>)}</ol>
  </details>;
}

export function EvidenceReview({ turn, index, criteria }: { turn: Turn; index: number; criteria: CriterionRating[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const evidence = criteria.find(c => c.criterionId === selected)?.evidence;
  const verified = evidence && turn.answer.slice(evidence.start, evidence.end) === evidence.quote;
  return <article className="card review-turn evidence-review">
    <span className="question-label">QUESTION {index + 1} · {turn.topic}</span>
    <h4>{turn.question}</h4>
    <div className="review-answer" aria-label={`Your answer to question ${index + 1}`}>
      {verified ? <>{turn.answer.slice(0, evidence.start)}<mark>{evidence.quote}</mark>{turn.answer.slice(evidence.end)}</> : turn.answer}
    </div>
    <div className="criteria-grid">{criteria.map(c => <section className="criterion-card" key={c.criterionId}>
      <div className="criterion-heading"><h5>{c.label}</h5><strong>{c.score === null ? 'Insufficient evidence' : `${c.score} / 5`}</strong></div>
      <p>{c.rationale}</p>
      {c.evidence && <><blockquote>{c.evidence.quote}</blockquote>
        <button type="button" className="button secondary" aria-pressed={selected === c.criterionId}
          onClick={() => setSelected(selected === c.criterionId ? null : c.criterionId)}>Show evidence for {c.label}</button></>}
      {c.improvement && <p><strong>Try next:</strong> {c.improvement}</p>}
    </section>)}</div>
  </article>;
}
