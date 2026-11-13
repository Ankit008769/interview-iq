// Practice "proctoring" alerts for camera practice (D4 follow-up), like the checks some online interviews
// run: another face in view, the candidate's face leaving the frame, and a phone, book, second screen or
// second person in view. Everything runs in the browser on MediaPipe output; nothing is uploaded, nobody is
// identified, and nothing here affects scores. This module only decides when to alert.

export type AlertKind = 'multiple_faces' | 'face_away' | 'phone' | 'object';
export type Detection = { label: string; score: number };

export const ALERT_RULES = {
  multipleFacesMs: 500,       // two or more faces for this long
  faceAwayMs: 2000,           // no face for this long
  objectChecks: 2,            // the object must be seen in this many detector checks in a row
  repeatMs: 8000,             // the same alert sounds again at most this often while it lasts
  phoneScore: 0.45,
  objectScore: 0.5,
} as const;

// COCO labels from the object detector, and how they are described to the candidate.
export const OBJECT_LABELS: Record<string, { kind: AlertKind; text: string }> = {
  'cell phone': { kind: 'phone', text: 'A phone is in view.' },
  book: { kind: 'object', text: 'A book or notes are in view.' },
  laptop: { kind: 'object', text: 'Another screen is in view.' },
  tv: { kind: 'object', text: 'Another screen is in view.' },
  remote: { kind: 'object', text: 'A device is in view.' },
};
export const ALERT_TEXT: Record<AlertKind, string> = {
  multiple_faces: 'Another face is in view.',
  face_away: 'Your face left the frame.',
  phone: 'A phone is in view.',
  object: 'Something else is in view.',
};

export type AlertSummary = Record<AlertKind, number>;
export const emptySummary = (): AlertSummary => ({ multiple_faces: 0, face_away: 0, phone: 0, object: 0 });

export class AlertTracker {
  private multiSince: number | null = null;
  private awaySince: number | null = null;
  private objectStreak = new Map<string, number>();
  private lastFired = new Map<AlertKind, number>();
  private active = new Set<AlertKind>();
  readonly counts: AlertSummary = emptySummary(); // episodes per kind (an episode is counted once however long it lasts)

  private fire(kind: AlertKind, now: number, text: string, out: { kind: AlertKind; text: string }[]) {
    if (!this.active.has(kind)) { this.active.add(kind); this.counts[kind]++; }
    const last = this.lastFired.get(kind);
    if (last === undefined || now - last >= ALERT_RULES.repeatMs) { this.lastFired.set(kind, now); out.push({ kind, text }); }
  }
  private clear(kind: AlertKind) { this.active.delete(kind); }

  // Face results, about five times a second. Returns the alerts to sound now.
  faces(count: number, now: number) {
    const out: { kind: AlertKind; text: string }[] = [];
    if (count >= 2) { this.multiSince ??= now; if (now - this.multiSince >= ALERT_RULES.multipleFacesMs) this.fire('multiple_faces', now, ALERT_TEXT.multiple_faces, out); }
    else { this.multiSince = null; this.clear('multiple_faces'); }
    if (count === 0) { this.awaySince ??= now; if (now - this.awaySince >= ALERT_RULES.faceAwayMs) this.fire('face_away', now, ALERT_TEXT.face_away, out); }
    else { this.awaySince = null; this.clear('face_away'); }
    return out;
  }

  // Object-detector results, about once a second. A second "person" counts as another person in view.
  objects(detections: Detection[], now: number) {
    const out: { kind: AlertKind; text: string }[] = [];
    const seen = new Set<string>();
    for (const d of detections) {
      const rule = OBJECT_LABELS[d.label];
      if (rule && d.score >= (rule.kind === 'phone' ? ALERT_RULES.phoneScore : ALERT_RULES.objectScore)) seen.add(d.label);
    }
    if (detections.filter(d => d.label === 'person' && d.score >= ALERT_RULES.objectScore).length >= 2) seen.add('person');
    for (const label of [...this.objectStreak.keys()]) if (!seen.has(label)) this.objectStreak.delete(label);
    const kinds = new Set<AlertKind>();
    for (const label of seen) {
      const streak = (this.objectStreak.get(label) ?? 0) + 1;
      this.objectStreak.set(label, streak);
      if (streak < ALERT_RULES.objectChecks) continue;
      if (label === 'person') { kinds.add('multiple_faces'); this.fire('multiple_faces', now, 'Another person is in view.', out); continue; }
      const rule = OBJECT_LABELS[label];
      kinds.add(rule.kind); this.fire(rule.kind, now, rule.text, out);
    }
    if (!kinds.has('phone')) this.clear('phone');
    if (!kinds.has('object')) this.clear('object');
    return out;
  }
}

// A short beep through Web Audio (no sound files). Two tones for objects so the kinds sound different.
let audio: AudioContext | null = null;
export function primeAudio() {
  try { audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)(); void audio.resume(); } catch { audio = null; }
}
export function beep(kind: AlertKind) {
  primeAudio();
  if (!audio) return;
  const tones = kind === 'phone' || kind === 'object' ? [880, 660] : kind === 'multiple_faces' ? [988, 988] : [523];
  tones.forEach((freq, i) => {
    const osc = audio!.createOscillator(), gain = audio!.createGain();
    const start = audio!.currentTime + i * 0.22;
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.connect(gain).connect(audio!.destination); osc.start(start); osc.stop(start + 0.2);
  });
}
