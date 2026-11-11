// Framing and eye-line tips for video self-review (roadmap D4). Everything here runs in the browser on
// MediaPipe face landmarks: where the face sits in the frame, how large it is, head tilt and turn, where the
// irises sit within the eyes, and how bright the face is. Nothing about expression, emotion, personality,
// attractiveness or identity is inferred, and no landmark leaves the device.

export type Point = { x: number; y: number; z?: number };
export type Lighting = { face: number; frame: number }; // mean luminance 0–1 inside the face box and over the frame

// MediaPipe Face Mesh indices (478 points with irises). "First" and "second" eye are as they appear in the
// image, so the code works the same whether or not the preview is mirrored.
export const LM = {
  eyeA: { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468 },
  eyeB: { outer: 263, inner: 362, upper: 386, lower: 374, iris: 473 },
  noseTip: 1, chin: 152, forehead: 10,
} as const;

export type FrameCheck = {
  face: boolean;
  centred: boolean;
  distance: 'ok' | 'far' | 'close';
  eyeLine: 'ok' | 'low' | 'high';
  level: boolean;
  facing: boolean;
  eyeContact: boolean;
  lighting: 'ok' | 'dark' | 'backlit';
};

export const THRESHOLDS = {
  centreOffset: 0.15,          // face centre within 35–65% of the width
  faceWidth: [0.2, 0.55],      // face box width as a share of the frame width
  eyeLine: [0.22, 0.5],        // eyes in the upper half, ideally about a third of the way down
  rollDegrees: 8,
  yaw: 0.22,                   // nose offset from the eye midpoint, in eye-distances
  pitch: [0.28, 0.66],         // nose position between the eye line and the chin
  irisAcross: 0.14,            // iris offset from the eye's middle, as a share of eye width
  irisDown: [0.25, 0.72],      // iris position between upper and lower lid
  dark: 0.22,
  backlitRatio: 0.62,
} as const;

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// Where the iris sits across and down the eye, each 0–1 (0.5 is the middle).
function irisPosition(p: Point[], eye: typeof LM.eyeA | typeof LM.eyeB) {
  const outer = p[eye.outer], inner = p[eye.inner], iris = p[eye.iris], upper = p[eye.upper], lower = p[eye.lower];
  const width = inner.x - outer.x;
  const across = width ? (iris.x - outer.x) / width : 0.5;
  const height = lower.y - upper.y;
  const down = height > 1e-4 ? (iris.y - upper.y) / height : 0.5;
  return { across, down };
}

// One video frame. `aspect` is width / height of the frame, so tilt is measured in real proportions.
export function checkFrame(points: Point[] | null | undefined, aspect: number, light?: Lighting): FrameCheck {
  if (!points || points.length < 478) return { face: false, centred: false, distance: 'ok', eyeLine: 'ok', level: true, facing: false, eyeContact: false, lighting: 'ok' };
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const q of points) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const width = maxX - minX;
  const centreX = (minX + maxX) / 2;
  const a = points[LM.eyeA.outer], b = points[LM.eyeB.outer];
  const eyes = mid(a, b);
  const roll = Math.abs(Math.atan2((b.y - a.y), (b.x - a.x) * aspect) * 180 / Math.PI);
  const eyeGap = dist(points[LM.eyeA.inner], points[LM.eyeB.inner]) || 1e-3;
  const nose = points[LM.noseTip], chin = points[LM.chin];
  const yaw = (nose.x - mid(points[LM.eyeA.inner], points[LM.eyeB.inner]).x) / eyeGap;
  const pitch = (nose.y - eyes.y) / ((chin.y - eyes.y) || 1e-3);
  const facing = Math.abs(yaw) <= THRESHOLDS.yaw && pitch >= THRESHOLDS.pitch[0] && pitch <= THRESHOLDS.pitch[1];
  const ia = irisPosition(points, LM.eyeA), ib = irisPosition(points, LM.eyeB);
  const across = (ia.across + ib.across) / 2, down = (ia.down + ib.down) / 2;
  const eyeContact = facing && Math.abs(across - 0.5) <= THRESHOLDS.irisAcross && down >= THRESHOLDS.irisDown[0] && down <= THRESHOLDS.irisDown[1];
  const lighting = !light ? 'ok' : light.face < THRESHOLDS.dark ? 'dark' : light.face < light.frame * THRESHOLDS.backlitRatio ? 'backlit' : 'ok';
  return {
    face: true,
    centred: Math.abs(centreX - 0.5) <= THRESHOLDS.centreOffset,
    distance: width < THRESHOLDS.faceWidth[0] ? 'far' : width > THRESHOLDS.faceWidth[1] ? 'close' : 'ok',
    eyeLine: eyes.y > THRESHOLDS.eyeLine[1] ? 'low' : eyes.y < THRESHOLDS.eyeLine[0] ? 'high' : 'ok',
    level: roll <= THRESHOLDS.rollDegrees,
    facing, eyeContact, lighting,
  };
}

// The face box in normalised coordinates, for measuring its brightness.
export function faceBox(points: Point[]) {
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const q of points) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  return { x: Math.max(0, minX), y: Math.max(0, minY), w: Math.min(1, maxX) - Math.max(0, minX), h: Math.min(1, maxY) - Math.max(0, minY) };
}

// Mean luminance (Rec. 709) of RGBA pixels, 0–1, inside an optional box given in pixels.
export function luminance(data: Uint8ClampedArray, width: number, height: number, box?: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.max(0, Math.floor(box?.x ?? 0)), y0 = Math.max(0, Math.floor(box?.y ?? 0));
  const x1 = Math.min(width, Math.ceil(box ? box.x + box.w : width)), y1 = Math.min(height, Math.ceil(box ? box.y + box.h : height));
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; n++;
  }
  return n ? sum / n / 255 : 0;
}

// The tip to show now, most important first, or null when the frame looks fine.
export function liveTip(c: FrameCheck): string | null {
  if (!c.face) return 'We cannot see your face. Sit facing the camera.';
  if (c.lighting === 'dark') return 'Your face is dark. Add light in front of you.';
  if (c.lighting === 'backlit') return 'The light is behind you. Face a window or lamp instead.';
  if (c.distance === 'far') return 'Move a little closer to the camera.';
  if (c.distance === 'close') return 'Move back a little so your head and shoulders fit.';
  if (!c.centred) return 'Move to the centre of the frame.';
  if (c.eyeLine === 'low') return 'Raise the camera to eye level, or sit up a little.';
  if (c.eyeLine === 'high') return 'Lower the camera a little, leaving some space above your head.';
  if (!c.level) return 'Level your head or the camera.';
  if (!c.facing) return 'Face the camera.';
  if (!c.eyeContact) return 'Look at the camera now and then, not only at the screen.';
  return null;
}

export type FramingSummary = {
  frames: number;
  faceVisible: number; centred: number; distanceOk: number; eyeLineOk: number; level: number; eyeContact: number; lightingOk: number; // percentages of frames
  tips: string[];
};
const pct = (n: number, d: number) => (d ? Math.round(100 * n / d) : 0);
// Percentages are over frames with a face, except faceVisible. A tip appears when an issue was present in at
// least 30% of those frames; eye contact is suggested below 50%, since looking at the screen is normal.
export function summarise(checks: FrameCheck[]): FramingSummary {
  const seen = checks.filter(c => c.face);
  const n = seen.length;
  const share = (f: (c: FrameCheck) => boolean) => pct(seen.filter(f).length, n);
  const s = {
    frames: checks.length, faceVisible: pct(n, checks.length),
    centred: share(c => c.centred), distanceOk: share(c => c.distance === 'ok'), eyeLineOk: share(c => c.eyeLine === 'ok'),
    level: share(c => c.level), eyeContact: share(c => c.eyeContact), lightingOk: share(c => c.lighting === 'ok'),
  };
  const tips: string[] = [];
  if (checks.length && s.faceVisible < 70) tips.push('Your face was out of view for much of the answer. Keep facing the camera.');
  if (n) {
    const most = (f: (c: FrameCheck) => boolean) => seen.filter(f).length / n >= 0.3;
    if (most(c => c.lighting === 'dark')) tips.push('Your face was often dark: put a light in front of you.');
    else if (most(c => c.lighting === 'backlit')) tips.push('Light was often behind you: face the light source instead.');
    if (most(c => c.distance === 'far')) tips.push('You were far from the camera: sit closer so your head and shoulders fill more of the frame.');
    if (most(c => c.distance === 'close')) tips.push('You were very close to the camera: move back a little.');
    if (most(c => !c.centred)) tips.push('You were often off-centre: move to the middle of the frame.');
    if (most(c => c.eyeLine === 'low')) tips.push('Your eyes sat low in the frame: raise the camera to eye level.');
    if (most(c => c.eyeLine === 'high')) tips.push('Your eyes sat very high in the frame: lower the camera slightly.');
    if (most(c => !c.level)) tips.push('Your head or camera was often tilted: level it.');
    if (s.eyeContact < 50) tips.push('Look into the camera more often, especially when you make a key point.');
  }
  return { ...s, tips };
}
