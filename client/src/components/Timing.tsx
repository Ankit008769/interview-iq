import { useEffect, useState } from 'react';
import { Pause, Play, Timer } from 'lucide-react';
import type { Interview, Turn } from '../lib/api';

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

// Seconds spent on the current question by the server's clock: skew is serverNow − local time at the last response.
export function useQuestionElapsed(interview: Interview | null, skewMs: number) {
  const [now, setNow] = useState(Date.now());
  const running = !!interview?.questionStartedAt && !interview.pausedAt;
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);
  if (!interview?.questionStartedAt) return null;
  const end = interview.pausedAt ? new Date(interview.pausedAt).getTime() : now + skewMs;
  return Math.max(0, (end - new Date(interview.questionStartedAt).getTime() - (interview.pausedMs ?? 0)) / 1000);
}

export function QuestionTimer({ limit, elapsed, paused, busy, onPause }: { limit: number; elapsed: number; paused: boolean; busy: boolean; onPause: () => void }) {
  const left = limit - elapsed;
  const state = left <= 0 ? 'over' : left <= 30 ? 'low' : '';
  return <div className={`question-timer ${state}`}>
    <span role="timer" aria-live="off"><Timer size={16}/> {left > 0 ? `${clock(left)} left` : `Time is up · +${clock(-left)}`}</span>
    {!paused && <button type="button" className="button secondary" disabled={busy} onClick={onPause}><Pause size={14}/> Pause timer</button>}
  </div>;
}

export function PausedCard({ busy, onResume }: { busy: boolean; onResume: () => void }) {
  return <div className="card answer-card paused-card" role="status">
    <h2>Round paused</h2>
    <p>The clock is stopped and the question is hidden until you resume. Your draft answer is kept.</p>
    <button type="button" className="button primary" disabled={busy} onClick={onResume}><Play size={15}/> {busy ? 'Resuming…' : 'Resume'}</button>
  </div>;
}

export function TurnTiming({ turn, limit }: { turn: Turn; limit?: number }) {
  if (turn.elapsedSeconds === undefined) return null;
  const paused = turn.pausedSeconds ? ` · timer paused ${clock(turn.pausedSeconds)}` : '';
  if (!limit) return <p className="turn-timing">Answered in {clock(turn.elapsedSeconds)}{paused}</p>;
  return <p className={`turn-timing ${turn.overTime ? 'over' : ''}`}>{turn.overTime
    ? `Answered in ${clock(turn.elapsedSeconds)}, ${clock(turn.elapsedSeconds - limit)} over the ${clock(limit)} limit`
    : `Answered in ${clock(turn.elapsedSeconds)} of ${clock(limit)}`}{paused}</p>;
}
