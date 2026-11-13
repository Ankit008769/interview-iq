import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, CircleDot, ShieldCheck } from 'lucide-react';
import { checkFrame, faceBox, liveTip, luminance, summarise, type FrameCheck, type Point } from '../lib/framing';
import { getPref, purgeExpired, RETENTION_DAYS, saveRecording, setPref } from '../lib/recordings';
import { AlertTracker, beep, primeAudio, type AlertKind } from '../lib/proctor';
import { sendFeatureEvent } from '../lib/api';

type Landmarker = { detectForVideo(video: HTMLVideoElement, ts: number): { faceLandmarks: Point[][] }; close(): void };
type Detector = { detectForVideo(video: HTMLVideoElement, ts: number): { detections: { categories: { categoryName: string; score: number }[] }[] }; close(): void };
const MAX_MS = 10 * 60_000;
const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

// MediaPipe runs in this browser from files served by the app; nothing is sent anywhere. Blendshapes (which
// describe facial expressions) are switched off: only landmark positions are used.
async function loadLandmarker(): Promise<Landmarker> {
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks(`${window.location.origin}/mediapipe/wasm`);
  const task = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${window.location.origin}/mediapipe/face_landmarker.task`, delegate: 'CPU' },
    // Up to three faces, so another person in view can be noticed; tips use the first face found.
    runningMode: 'VIDEO', numFaces: 3, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
  });
  silenceUsageLogging(task);
  return task as unknown as Landmarker;
}
// Object detection (EfficientDet-Lite0, COCO labels), only for the labels the alerts use.
async function loadDetector(): Promise<Detector> {
  const { ObjectDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const files = await FilesetResolver.forVisionTasks(`${window.location.origin}/mediapipe/wasm`);
  const task = await ObjectDetector.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${window.location.origin}/mediapipe/efficientdet_lite0.tflite`, delegate: 'CPU' },
    runningMode: 'VIDEO', scoreThreshold: 0.4, maxResults: 6, categoryAllowlist: ['cell phone', 'book', 'laptop', 'tv', 'remote', 'person'],
  });
  silenceUsageLogging(task);
  return task as unknown as Detector;
}

// MediaPipe 1.1.1 queues usage statistics and posts them to odml.pa.googleapis.com every minute and on close.
// Its logger stops sending once it has failed, so it is marked failed here. This reaches into the pinned
// version's internals; if they change, the content-security policy (connect-src falls back to 'self') still
// blocks the request, and the browser test fails on any request to that address.
export function silenceUsageLogging(task: unknown) {
  const logger = (task as { o?: { m?: { error?: unknown; i?: unknown[] } } } | null)?.o?.m;
  if (logger && Array.isArray(logger.i)) { logger.error = new Error('Usage logging is disabled.'); logger.i = []; }
}

// Optional camera practice during an interview (roadmap D4): a self-view with live framing and eye-line tips,
// and a recording of each answer kept only on this device for self-review on the Results page.
export function CameraCoach({ interviewId, questionIndex, question, active }: { interviewId: string; questionIndex: number; question: string; active: boolean }) {
  const [on, setOn] = useState(() => getPref('camera'));
  const [status, setStatus] = useState<'off' | 'starting' | 'live' | 'error'>('off');
  const [message, setMessage] = useState('');
  const [tip, setTip] = useState<string | null>(null);
  const [tips, setTips] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [recording, setRecording] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const landmarker = useRef<Landmarker | null>(null);
  const recorder = useRef<{ rec: MediaRecorder; chunks: Blob[]; checks: FrameCheck[]; started: number; index: number; question: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const recent = useRef<FrameCheck[]>([]);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  // Practice integrity alerts: another face, face out of view, a phone or other object in view.
  const detector = useRef<Detector | null>(null);
  const tracker = useRef(new AlertTracker());
  const [alert, setAlert] = useState<{ kind: AlertKind; text: string; at: number } | null>(null);
  const [sound, setSound] = useState(() => getPref('sound'));
  const soundRef = useRef(sound); soundRef.current = sound;

  // Stops the current answer's recording and saves it with its framing summary.
  const finish = useCallback(() => {
    const current = recorder.current;
    if (!current) return;
    recorder.current = null; setRecording(false); clearTimeout(current.timer);
    const durationMs = Date.now() - current.started;
    const save = () => {
      const blob = new Blob(current.chunks, { type: current.rec.mimeType || 'video/webm' });
      if (!blob.size) return;
      void saveRecording({ id: `${interviewId}:${current.index}`, interviewId, questionIndex: current.index, question: current.question, blob, mimeType: blob.type,
        durationMs, createdAt: Date.now(), framing: summarise(current.checks), alerts: { ...tracker.current.counts } })
        .then(() => window.dispatchEvent(new Event('recordings-changed')))
        .catch(() => setMessage('This recording could not be saved; the browser may be out of storage.'));
    };
    if (current.rec.state !== 'inactive') { current.rec.onstop = save; current.rec.stop(); } else save();
  }, [interviewId]);

  const begin = useCallback(() => {
    if (!stream.current || recorder.current || typeof MediaRecorder === 'undefined') return;
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream.current, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 600_000 });
    const entry = { rec, chunks: [] as Blob[], checks: [] as FrameCheck[], started: Date.now(), index: questionIndex, question, timer: setTimeout(() => finish(), MAX_MS) };
    rec.ondataavailable = e => { if (e.data.size) entry.chunks.push(e.data); };
    rec.start(1000);
    tracker.current = new AlertTracker(); // alert counts are kept per answer
    recorder.current = entry; setRecording(true);
  }, [questionIndex, question, finish]);

  const stopAll = useCallback(() => {
    finish();
    stream.current?.getTracks().forEach(t => t.stop()); stream.current = null;
    landmarker.current?.close(); landmarker.current = null;
    detector.current?.close(); detector.current = null;
    if (video.current) video.current.srcObject = null;
    setStatus('off'); setTip(null); setAlert(null);
  }, [finish]);

  const start = useCallback(async () => {
    setStatus('starting'); setMessage('');
    try {
      const constraints = { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } };
      stream.current = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: true }).catch(() => navigator.mediaDevices.getUserMedia(constraints));
      if (video.current) { video.current.srcObject = stream.current; await video.current.play().catch(() => {}); }
      setStatus('live');
      void purgeExpired().catch(() => {});
      loadLandmarker().then(l => { landmarker.current = l; setTips('ready'); }).catch(() => setTips('unavailable'));
      loadDetector().then(d => { detector.current = d; }).catch(() => { /* object alerts unavailable; face alerts still work */ });
    } catch {
      setStatus('error'); setMessage('The camera could not be started. Check that this site may use it, or keep answering without it.');
    }
  }, []);

  useEffect(() => { if (on) void start(); return () => stopAll(); }, [on, start, stopAll]);
  // One recording per answer: start when a question is on screen, save when it is answered.
  useEffect(() => {
    if (status !== 'live') return;
    if (active) begin();
    return () => finish();
  }, [status, active, questionIndex, begin, finish]);

  // Framing analysis about five times a second.
  useEffect(() => {
    if (status !== 'live') return;
    let raf = 0, last = 0, lastObjects = 0;
    const raise = (alerts: { kind: AlertKind; text: string }[]) => {
      if (!alerts.length) return;
      const a = alerts[alerts.length - 1];
      setAlert({ ...a, at: Date.now() });
      if (soundRef.current) beep(a.kind);
    };
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const v = video.current;
      if (!v || !landmarker.current || t - last < 200 || v.readyState < 2 || !v.videoWidth) return;
      last = t;
      const result = landmarker.current.detectForVideo(v, t);
      const faces = result.faceLandmarks ?? [];
      const points = faces[0] ?? null;
      raise(tracker.current.faces(faces.length, Date.now()));
      // Objects about once a second: detection costs more than face landmarks.
      if (detector.current && t - lastObjects >= 1000) {
        lastObjects = t;
        try {
          const found = detector.current.detectForVideo(v, t).detections.map(d => ({ label: d.categories[0]?.categoryName ?? '', score: d.categories[0]?.score ?? 0 }));
          raise(tracker.current.objects(found, Date.now()));
        } catch { /* a skipped frame */ }
      }
      const c = canvas.current ??= document.createElement('canvas');
      c.width = 64; c.height = 48;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      let light;
      if (ctx) {
        ctx.drawImage(v, 0, 0, 64, 48);
        const data = ctx.getImageData(0, 0, 64, 48).data;
        const box = points ? faceBox(points) : null;
        light = { frame: luminance(data, 64, 48), face: box ? luminance(data, 64, 48, { x: box.x * 64, y: box.y * 48, w: box.w * 64, h: box.h * 48 }) : 0 };
      }
      const check = checkFrame(points, v.videoWidth / v.videoHeight, points ? light : undefined);
      recorder.current?.checks.push(check);
      recent.current = [...recent.current.slice(-9), check];
      // Show the tip seen most often in the last two seconds, so it does not flicker.
      const counts = new Map<string | null, number>();
      for (const r of recent.current) { const k = liveTip(r); counts.set(k, (counts.get(k) ?? 0) + 1); }
      setTip([...counts].sort((a, b) => b[1] - a[1])[0][0]);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [status]);

  // An alert stays on screen for four seconds after it last sounded.
  useEffect(() => { if (!alert) return; const t = setTimeout(() => setAlert(null), 4000); return () => clearTimeout(t); }, [alert]);

  function toggle(next: boolean) {
    if (next) primeAudio(); // browsers allow sound only after a click
    setPref('camera', next); setOn(next);
    sendFeatureEvent('video_review', next ? 'enabled' : 'disabled');
    if (!next) stopAll();
  }

  if (!on) return <section className="card camera-card" aria-label="Camera practice">
    <h3><Camera size={16}/> Camera practice <span className="optional-tag">Optional</span></h3>
    <p>See yourself as an interviewer would, with tips on framing, eye line and lighting, and record each answer to watch afterwards. Like an online interview’s checks, it beeps if another face, a phone or other object comes into view, or your face leaves the frame.</p>
    <p className="camera-privacy"><ShieldCheck size={14}/> Video stays on this device and is deleted after {RETENTION_DAYS} days. Nothing is uploaded, and expressions or emotions are never analysed.</p>
    <button type="button" className="button secondary" onClick={() => toggle(true)}><Camera size={15}/> Turn on camera</button>
  </section>;

  return <section className="card camera-card" aria-label="Camera practice">
    <h3><Camera size={16}/> Camera practice {recording && <span className="rec-dot" role="status"><CircleDot size={12}/> Recording on this device</span>}</h3>
    <div className="self-view"><video ref={video} muted playsInline autoPlay aria-label="Your camera preview"/>
      {alert && <p className={`proctor-alert ${alert.kind}`} role="alert" data-testid="proctor-alert">{alert.text}</p>}
      {status === 'live' && tips === 'ready' && <p className={`framing-tip ${tip ? 'warn' : 'ok'}`} role="status" aria-live="polite" data-testid="framing-tip">{tip ?? 'Framing looks good.'}</p>}
      {status === 'live' && tips === 'loading' && <p className="framing-tip" role="status">Loading framing tips…</p>}
      {status === 'starting' && <p className="framing-tip" role="status">Starting the camera…</p>}
    </div>
    {tips === 'unavailable' && status === 'live' && <p className="muted">Framing tips are not available in this browser; your answers are still recorded for review.</p>}
    {message && <div className="alert warning" role="alert">{message}</div>}
    <p className="camera-privacy"><ShieldCheck size={14}/> Kept only in this browser for {RETENTION_DAYS} days. Watch or delete recordings on the Results page.</p>
    <div className="camera-controls">
      <label className="check-row"><input type="checkbox" checked={sound} onChange={e => { primeAudio(); setPref('sound', e.target.checked); setSound(e.target.checked); }}/> Sound alerts</label>
      <button type="button" className="button secondary" onClick={() => toggle(false)}><CameraOff size={15}/> Turn off camera</button>
    </div>
  </section>;
}
