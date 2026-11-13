import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera, ShieldCheck, Star, Trash2 } from 'lucide-react';
import { deleteAllRecordings, deleteRecording, getPref, getRecording, listRecordings, purgeExpired, RETENTION_DAYS, setPref, type RecordingInfo } from '../lib/recordings';
import { sendFeatureEvent } from '../lib/api';

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
const secs = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const RATED_KEY = 'iq.selfReview.rated';

function Player({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    void getRecording(id).then(r => { if (r) { made = URL.createObjectURL(r.blob); setUrl(made); } });
    return () => { if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url ? <video className="review-video" src={url} controls playsInline preload="metadata"/> : <p className="muted">Loading…</p>;
}

// Video self-review on Results (roadmap D4): this device's recordings of each answer, with framing notes.
export function SelfReview({ interviewId }: { interviewId: string }) {
  const [items, setItems] = useState<RecordingInfo[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rated, setRated] = useState(() => { try { return localStorage.getItem(RATED_KEY) === 'yes'; } catch { return false; } });
  const load = useCallback(() => { void purgeExpired().catch(() => {}).then(() => listRecordings(interviewId)).then(setItems).catch(() => setItems([])); }, [interviewId]);
  useEffect(() => { load(); window.addEventListener('recordings-changed', load); return () => window.removeEventListener('recordings-changed', load); }, [load]);
  if (!items?.length) return null;
  function rate(n: number) {
    sendFeatureEvent('video_review', 'rating', n);
    try { localStorage.setItem(RATED_KEY, 'yes'); } catch { /* private mode */ }
    setRated(true);
  }
  return <section className="card feedback-card self-review" aria-label="Video self-review">
    <div className="feedback-heading"><Camera size={20}/><h3>Video self-review</h3></div>
    <p className="camera-privacy"><ShieldCheck size={14}/> These recordings are stored only in this browser and are deleted automatically after {RETENTION_DAYS} days. Framing notes come from where your face sits in the frame and where your eyes point, never from expressions or emotions.</p>
    <ul className="recording-list">{items.map(r => <li key={r.id}>
      <div className="recording-head"><div><b>Question {r.questionIndex + 1}</b><span>{secs(r.durationMs)} · {mb(r.bytes)}</span></div>
        <div className="button-row"><button type="button" className="button secondary" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>{open === r.id ? 'Hide' : 'Watch'}</button>
          <button type="button" className="icon-button" aria-label={`Delete recording of question ${r.questionIndex + 1}`} onClick={() => { void deleteRecording(r.id).then(load); }}><Trash2 size={16}/></button></div></div>
      <p className="recording-question">{r.question}</p>
      {open === r.id && <Player id={r.id}/>}
      {r.framing.frames > 0 && <div className="framing-stats">
        <span>Face in view {r.framing.faceVisible}%</span><span>Centred {r.framing.centred}%</span><span>Eye level {r.framing.eyeLineOk}%</span><span>Looking at the camera {r.framing.eyeContact}%</span><span>Good light {r.framing.lightingOk}%</span>
      </div>}
      {r.alerts && Object.values(r.alerts).some(n => n > 0) && <p className="proctor-summary" data-testid="alert-summary">Alerts during this answer: {([['multiple_faces', 'another face or person'], ['face_away', 'face out of view'], ['phone', 'phone in view'], ['object', 'book, screen or device in view']] as const).filter(([k]) => r.alerts![k] > 0).map(([k, label]) => `${label} ${r.alerts![k]}×`).join(', ')}.</p>}
      {r.framing.tips.length > 0 ? <ul className="framing-notes">{r.framing.tips.map(t => <li key={t}>{t}</li>)}</ul> : r.framing.frames > 0 ? <p className="framing-notes ok">Framing looked good throughout.</p> : null}
    </li>)}</ul>
    {!rated ? <div className="feature-rating"><span>Was video self-review useful?</span>{[1, 2, 3, 4, 5].map(n => <button key={n} type="button" className="icon-button" aria-label={`Rate ${n} out of 5`} onClick={() => rate(n)}><Star size={17}/></button>)}</div>
      : <p className="muted">Thanks for rating video self-review. Manage recordings in <Link to="/account">Account</Link>.</p>}
  </section>;
}

// Account page: what this device holds, and switches for the two optional features.
export function SelfReviewSettings() {
  const [items, setItems] = useState<RecordingInfo[] | null>(null);
  const [camera, setCamera] = useState(() => getPref('camera'));
  const [avatar, setAvatar] = useState(() => getPref('avatar'));
  const load = useCallback(() => { void purgeExpired().catch(() => {}).then(() => listRecordings()).then(setItems).catch(() => setItems([])); }, []);
  useEffect(load, [load]);
  const bytes = (items ?? []).reduce((n, r) => n + r.bytes, 0);
  const toggle = (name: 'camera' | 'avatar', on: boolean) => {
    setPref(name, on); (name === 'camera' ? setCamera : setAvatar)(on);
    sendFeatureEvent(name === 'camera' ? 'video_review' : 'avatar', on ? 'enabled' : 'disabled');
  };
  return <>
    <h2>Video self-review and avatar</h2>
    <p>Camera practice shows framing and eye-line tips during an interview and records each answer for you to watch on the Results page. Recordings stay in this browser, are never uploaded, and are deleted after {RETENTION_DAYS} days. Only face position and eye direction are measured, never expressions or emotions. These switches apply to this device. On a shared computer, anyone using this browser profile can watch the recordings, so delete them when you finish.</p>
    <label className="check-row"><input type="checkbox" checked={camera} onChange={e => toggle('camera', e.target.checked)}/> Camera practice during interviews</label>
    <label className="check-row"><input type="checkbox" checked={avatar} onChange={e => toggle('avatar', e.target.checked)}/> Show an interviewer avatar when questions are read aloud</label>
    <p>{items === null ? 'Checking this device…' : items.length ? `${items.length} ${items.length === 1 ? 'recording' : 'recordings'} on this device (${mb(bytes)}).` : 'No recordings on this device.'}</p>
    {!!items?.length && <button type="button" className="button secondary" onClick={() => { if (window.confirm('Delete every recording on this device? This cannot be undone.')) void deleteAllRecordings().then(load); }}><Trash2 size={15}/> Delete all recordings on this device</button>}
  </>;
}
