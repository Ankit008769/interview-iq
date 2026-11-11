import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Volume2, VolumeX } from 'lucide-react';
import { clock } from './Timing';
import { DeliveryNote } from './Delivery';
import type { Delivery } from '../lib/api';

// Prefer local browser voices; remote/browser-managed voices may use a provider.
export function ReadAloud({ text, lang }: { text: string; lang?: string }) {
  const [speaking, setSpeaking] = useState(false);
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;
  useEffect(() => { setSpeaking(false); return () => { if (supported) { window.speechSynthesis.cancel(); window.dispatchEvent(new CustomEvent('iq-speech', { detail: 'end' })); } }; }, [supported, text]);
  if (!supported) return null;
  const toggle = () => {
    window.speechSynthesis.cancel();
    if (speaking) { setSpeaking(false); window.dispatchEvent(new CustomEvent('iq-speech', { detail: 'end' })); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices?.() ?? [];
    // Prefer a voice for the interview's language, then a local one.
    const matching = lang ? voices.filter(voice => voice.lang?.toLowerCase().startsWith(lang.toLowerCase())) : voices;
    const voice = matching.find(v => v.localService) ?? matching[0] ?? (lang ? undefined : voices.find(v => v.localService));
    if (lang) utterance.lang = lang;
    if (voice) utterance.voice = voice;
    // The optional interviewer avatar listens for these to move its mouth with the speech.
    const signal = (type: 'start' | 'boundary' | 'end') => window.dispatchEvent(new CustomEvent('iq-speech', { detail: type }));
    utterance.onboundary = () => signal('boundary');
    utterance.onend = utterance.onerror = () => { setSpeaking(false); signal('end'); };
    window.speechSynthesis.speak(utterance);
    setSpeaking(true); signal('start');
  };
  return <button type="button" className="button secondary read-aloud" onClick={toggle} aria-pressed={speaking}>
    {speaking ? <><VolumeX size={15}/> Stop reading</> : <><Volume2 size={15}/> Read question aloud</>}
  </button>;
}

const MAX_SECONDS = 300;
const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

// Records one spoken answer, sends it for transcription and hands back text for the candidate to edit.
export function VoiceAnswer({ interviewId, disabled, onTranscript, onBusy }: {
  interviewId: string; disabled: boolean; onTranscript: (text: string) => boolean; onBusy: (busy: boolean) => void;
}) {
  const [state, setState] = useState<'idle' | 'requesting' | 'recording' | 'transcribing'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const startedAt = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const active = useRef(false);
  const transcriptCallback = useRef(onTranscript); transcriptCallback.current = onTranscript;
  const busyCallback = useRef(onBusy); busyCallback.current = onBusy;
  const supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  function release() {
    const rec = recorder.current; recorder.current = null;
    if (rec) { rec.onstop = null; rec.ondataavailable = null; rec.onerror = null; if (rec.state !== 'inactive') rec.stop(); }
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    controllerRef.current?.abort(); controllerRef.current = null;
  }
  function cancel() {
    generation.current++; active.current = false; release();
    setState('idle'); busyCallback.current(false);
  }
  const stop = () => { if (recorder.current?.state === 'recording') recorder.current.stop(); };
  useEffect(() => () => { generation.current++; active.current = false; release(); busyCallback.current(false); }, []);
  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  useEffect(() => { if (state === 'recording' && seconds >= MAX_SECONDS) stop(); }, [state, seconds]);
  if (!supported) return null;

  async function upload(blob: Blob, run: number, recordedMs: number) {
    if (run !== generation.current) return;
    if (blob.size > 8 * 1024 * 1024) { cancel(); setError('Recording exceeds 8 MB. Try a shorter answer or type it.'); return; }
    setState('transcribing');
    const controller = new AbortController(); controllerRef.current = controller;
    // On-server CPU transcription of a long answer can take a few minutes.
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
      const response = await fetch(`/api/interviews/${interviewId}/transcribe`, { method: 'POST', body: blob, credentials: 'include',
        headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm', 'X-Recording-Ms': String(recordedMs) }, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (run !== generation.current) return;
      if (!response.ok) throw new Error(data.error || 'Your recording could not be transcribed.');
      if (typeof data.transcript !== 'string' || !data.transcript.trim()) throw new Error('No speech was detected. Try again or type your answer.');
      setDelivery(data.delivery ?? null);
      if (!transcriptCallback.current(data.transcript)) {
        setDraft(data.transcript); setError('This transcript exceeds the space left in your answer. Shorten it below, then insert it. Nothing was cut off.');
      }
    } catch (e) {
      if (run === generation.current) setError(controller.signal.aborted ? 'Transcription timed out. Try a shorter answer or type it.' : (e as Error).message);
    } finally {
      clearTimeout(timeout);
      if (run === generation.current) { controllerRef.current = null; active.current = false; setState('idle'); busyCallback.current(false); }
    }
  }
  async function start() {
    if (active.current || disabled) return;
    active.current = true; const run = ++generation.current;
    setError(''); setDelivery(null); setState('requesting'); busyCallback.current(true);
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (run !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const mimeType = preferredTypes.find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = []; let bytes = 0;
      rec.ondataavailable = event => {
        if (run !== generation.current) return;
        bytes += event.data.size;
        if (bytes > 8 * 1024 * 1024) { cancel(); setError('Recording exceeds 8 MB. Try a shorter answer or type it.'); return; }
        if (event.data.size) chunks.push(event.data);
      };
      rec.onerror = () => { if (run === generation.current) { cancel(); setError('Recording failed. You can type your answer instead.'); } };
      rec.onstop = () => {
        stream?.getTracks().forEach(track => track.stop());
        if (run !== generation.current) return;
        recorder.current = null; streamRef.current = null;
        void upload(new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' }), run, Math.round(performance.now() - startedAt.current));
      };
      recorder.current = rec; setSeconds(0); startedAt.current = performance.now(); rec.start(1000); setState('recording');
    } catch {
      stream?.getTracks().forEach(track => track.stop());
      if (run === generation.current) { cancel(); setError('Microphone access or recording is unavailable. You can type your answer instead.'); }
    }
  }
  return <div className="voice-answer">
    {state === 'idle' && !draft && <button type="button" className="button secondary" disabled={disabled} onClick={start}><Mic size={15}/> Answer by voice</button>}
    {state === 'requesting' && <span role="status">Waiting for microphone permission…</span>}
    {state === 'recording' && <button type="button" className="button primary recording" onClick={stop}><Square size={14}/> Stop recording · <span role="timer">{clock(seconds)}</span></button>}
    {state === 'transcribing' && <span className="voice-status" role="status">Transcribing your answer…</span>}
    {state !== 'idle' && <button type="button" className="button secondary" onClick={cancel}>Cancel voice answer</button>}
    <span className="voice-note">Your recording is sent for transcription, then discarded by Interview IQ. Provider retention follows its terms. Check and edit the text before you submit.</span>
    {state === 'idle' && delivery && <DeliveryNote delivery={delivery}/>}
    {error && <p className="alert error" role="alert">{error}</p>}
    {draft && <div><label>Transcript to shorten<textarea aria-label="Transcript to shorten" value={draft} onChange={e => setDraft(e.target.value)}/></label>
      <button type="button" className="button" disabled={disabled || !draft.trim()} onClick={() => { if (transcriptCallback.current(draft)) { setDraft(''); setError(''); } }}>Insert edited transcript</button></div>}
  </div>;
}
