import { useState } from 'react';
import { AudioLines } from 'lucide-react';
import type { Delivery, DeliveryClip, FillerCount } from '../lib/api';
import { clock } from './Timing';

const MIN_PACE_SECONDS = 10;
const pace = (words: number, seconds: number) => seconds >= MIN_PACE_SECONDS ? Math.round(words / (seconds / 60)) : null;
export const fillerText = (fillers: FillerCount[]) => fillers.length
  ? fillers.map(f => `“${f.term}” ×${f.count}`).join(', ') : 'none counted';
function merge(clips: DeliveryClip[]) {
  const fillers = new Map<string, number>();
  for (const clip of clips) for (const f of clip.fillers) fillers.set(f.term, (fillers.get(f.term) ?? 0) + f.count);
  const seconds = clips.reduce((sum, c) => sum + c.seconds, 0), words = clips.reduce((sum, c) => sum + c.words, 0);
  return { seconds, words, wordsPerMinute: pace(words, seconds), recordings: clips.length,
    fillers: [...fillers].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)) };
}
const paceText = (wpm: number | null) => wpm === null ? 'pace needs 10 seconds of speech' : `${wpm} words per minute`;

// Shown under the recorder right after a transcription.
export function DeliveryNote({ delivery }: { delivery: Delivery }) {
  return <p className="voice-delivery" role="status"><AudioLines size={14} aria-hidden="true"/>
    Last recording: {clock(delivery.seconds)} · {paceText(delivery.wordsPerMinute)} · fillers: {fillerText(delivery.fillers)}</p>;
}

export function DeliveryPanel({ clips, onTurnOff }: { clips: DeliveryClip[]; onTurnOff: () => Promise<void> }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const total = merge(clips);
  const questions = [...new Set(clips.map(c => c.questionIndex))].sort((a, b) => a - b);
  return <section className="card feedback-card delivery-panel" aria-label="Delivery feedback">
    <div className="feedback-heading"><AudioLines size={20}/><h3>Delivery from your voice answers</h3></div>
    <p>Spoke for {clock(total.seconds)} in {total.recordings} {total.recordings === 1 ? 'recording' : 'recordings'} · {paceText(total.wordsPerMinute)} · fillers: {fillerText(total.fillers)}</p>
    <ul className="delivery-list">{questions.map(q => { const m = merge(clips.filter(c => c.questionIndex === q));
      return <li key={q}><b>Question {q + 1}</b> {clock(m.seconds)} · {paceText(m.wordsPerMinute)} · fillers: {fillerText(m.fillers)}</li>; })}</ul>
    <p className="challenge-note">Measured from your transcripts and recording length only. Not part of your score. No audio is kept, and tone, emotion and accent are not analysed. Conversational English is often quoted at roughly 120–150 words per minute; treat that as a rough guide, since clarity matters more than speed. Transcription often drops “um” and “uh”, so hesitation counts can be low.</p>
    {error && <p className="alert error" role="alert">{error}</p>}
    <button type="button" className="button secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await onTurnOff(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}>Turn off delivery feedback</button>
  </section>;
}
