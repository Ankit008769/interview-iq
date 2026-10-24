import { useState } from 'react';
import type { AnswerRewrite, CriterionRating, Feedback, ScoreChallenge, Turn } from '../lib/api';
import { TurnTiming } from './Timing';

export function RubricGuide({ rubric }: { rubric: NonNullable<Feedback['rubric']> }) {
  return <details className="card rubric-guide">
    <summary>How the rubric works · {rubric.type}</summary>
    <p>Each criterion uses a 0–5 scale. Missing evidence is unscored, not zero. Version {rubric.version}.</p>
    <ul>{rubric.criteria.map(c => <li key={c.id}><strong>{c.label}:</strong> {c.guidance}</li>)}</ul>
    <ol start={0}>{rubric.anchors.map((anchor, i) => <li key={i}>{anchor}</li>)}</ol>
  </details>;
}

export type ChallengeRequest = (criterionId: string, reason: string, submissionId: string) => Promise<void>;
const scoreText = (c: CriterionRating) => c.score === null ? 'insufficient evidence' : `${c.score} / 5`;

function ChallengeControl({ criterion, challenge, canChallenge, onChallenge }:
  { criterion: CriterionRating; challenge?: ScoreChallenge; canChallenge: boolean; onChallenge?: ChallengeRequest }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  // Kept for the life of one form so a resend after a network failure replays instead of duplicating.
  const [submissionId, setSubmissionId] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const send = async (text: string, id: string) => {
    setSending(true); setError('');
    try { await onChallenge!(criterion.criterionId, text.trim(), id); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'The challenge could not be sent.'); }
    finally { setSending(false); }
  };
  if (challenge?.state === 'queued' || challenge?.state === 'processing') {
    return <p className="challenge-status" role="status">Second AI review in progress for {criterion.label}…</p>;
  }
  if (challenge?.state === 'resolved' && challenge.outcome) {
    const revised = challenge.outcome.decision === 'revised';
    return <div className={`challenge-status ${revised ? 'revised' : ''}`} role="status">
      <strong>{revised ? `Second AI review changed this rating from ${scoreText(challenge.original)} to ${scoreText(challenge.outcome.rating)}.`
        : `Second AI review kept this rating at ${scoreText(challenge.original)}.`}</strong>
      {!revised && <p>{challenge.outcome.rating.rationale}</p>}
    </div>;
  }
  if (challenge?.state === 'failed') {
    return <div className="challenge-status failed" role="alert">
      <p>{challenge.error || 'The second review could not finish.'}</p>
      <button type="button" className="button secondary" disabled={sending}
        onClick={() => send(challenge.reason, crypto.randomUUID())}>{sending ? 'Sending…' : 'Try the second review again'}</button>
      {error && <p className="alert error">{error}</p>}
    </div>;
  }
  if (!onChallenge || !canChallenge) return null;
  if (!open) return <button type="button" className="button secondary challenge-open"
    onClick={() => { setOpen(true); setSubmissionId(crypto.randomUUID()); }}>Challenge {criterion.label} rating</button>;
  const valid = reason.trim().length >= 10 && reason.trim().length <= 500;
  return <form className="challenge-box" onSubmit={e => { e.preventDefault(); if (valid) send(reason, submissionId); }}>
    <label htmlFor={`challenge-${criterion.criterionId}`}>What did the review miss in your answer?</label>
    <textarea id={`challenge-${criterion.criterionId}`} value={reason} maxLength={500} rows={3}
      onChange={e => setReason(e.target.value)} placeholder="Point to the part of your answer that supports a different rating." />
    <p className="challenge-note">A second AI review re-checks only your saved answer. The score can go up, down or stay the same. This is not a human review.</p>
    {error && <p className="alert error">{error}</p>}
    <div className="challenge-actions">
      <button type="submit" className="button primary" disabled={!valid || sending}>{sending ? 'Sending…' : 'Request second review'}</button>
      <button type="button" className="button secondary" disabled={sending} onClick={() => setOpen(false)}>Cancel</button>
    </div>
  </form>;
}

function StrongerVersion({ rewrite, onRewrite }: { rewrite?: AnswerRewrite; onRewrite?: () => Promise<void> }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  if (rewrite) return <section className="rewrite-box" aria-label="Stronger version of this answer">
    <h5>Stronger version, built from your answer</h5>
    {rewrite.summary && <p className="rewrite-summary">{rewrite.summary}</p>}
    <ol className="rewrite-parts">{rewrite.parts.map((part, i) => part.kind === 'answer'
      ? <li key={i}><span>{part.text}</span><small>From your answer: “{part.quote}”</small></li>
      : <li key={i} className="rewrite-addition"><span>Add only if true: {part.text}</span></li>)}</ol>
    <p className="challenge-note">Each sentence is tied to words you wrote. Bracketed prompts show what is missing; never add details that are not true.</p>
  </section>;
  if (!onRewrite) return null;
  return <div className="rewrite-box">
    <button type="button" className="button secondary" disabled={sending} onClick={async () => {
      setSending(true); setError('');
      try { await onRewrite(); } catch (e) { setError(e instanceof Error ? e.message : 'A stronger version could not be built.'); }
      finally { setSending(false); }
    }}>{sending ? 'Building a stronger version…' : 'Show a stronger version of this answer'}</button>
    <p className="challenge-note">Built only from what you wrote. Missing pieces appear as bracketed prompts, never as invented details.</p>
    {error && <p className="alert error">{error}</p>}
  </div>;
}

export function EvidenceReview({ turn, index, criteria, challenges = [], canChallenge = false, onChallenge, rewrite, onRewrite, limit }:
  { turn: Turn; index: number; criteria: CriterionRating[]; challenges?: ScoreChallenge[]; canChallenge?: boolean; onChallenge?: ChallengeRequest;
    rewrite?: AnswerRewrite; onRewrite?: () => Promise<void>; limit?: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const evidence = criteria.find(c => c.criterionId === selected)?.evidence;
  const verified = evidence && turn.answer.slice(evidence.start, evidence.end) === evidence.quote;
  return <article className="card review-turn evidence-review">
    <span className="question-label">QUESTION {index + 1} · {turn.topic}</span>
    <h4>{turn.question}</h4>
    <TurnTiming turn={turn} limit={limit} />
    <div className="review-answer" aria-label={`Your answer to question ${index + 1}`}>
      {verified ? <>{turn.answer.slice(0, evidence.start)}<mark>{evidence.quote}</mark>{turn.answer.slice(evidence.end)}</> : turn.answer}
    </div>
    <div className="criteria-grid">{criteria.map(c => <section className="criterion-card" key={c.criterionId}>
      <div className="criterion-heading"><h5>{c.label}</h5><strong>{c.score === null ? 'Insufficient evidence' : `${c.score} / 5`}</strong></div>
      {c.revisedBy && <span className="revised-tag">Revised after second AI review</span>}
      <p>{c.rationale}</p>
      {c.evidence && <><blockquote>{c.evidence.quote}</blockquote>
        <button type="button" className="button secondary" aria-pressed={selected === c.criterionId}
          onClick={() => setSelected(selected === c.criterionId ? null : c.criterionId)}>Show evidence for {c.label}</button></>}
      {c.improvement && <p><strong>Try next:</strong> {c.improvement}</p>}
      <ChallengeControl criterion={c} challenge={challenges.find(x => x.criterionId === c.criterionId)}
        canChallenge={canChallenge} onChallenge={onChallenge} />
    </section>)}</div>
    <StrongerVersion rewrite={rewrite} onRewrite={onRewrite} />
  </article>;
}
