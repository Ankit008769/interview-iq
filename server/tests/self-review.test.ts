import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { checkFrame, liveTip, LM, luminance, summarise, type FrameCheck, type Point } from '../../client/src/lib/framing.js';
import { FeatureEvent } from '../src/models/FeatureEvent.js';
import { Interview } from '../src/models/Interview.js';
import { User } from '../src/models/User.js';
import { featureReport } from '../src/services/featureReport.js';

process.env.JWT_SECRET = 'self-review-test-secret-longer-than-thirty-two-characters';
const { app } = await import('../src/app.js');
const DAY = 86_400_000;

// A synthetic set of 478 face landmarks: a face box, eyes on one line, irises, nose and chin.
function face(o: { cx?: number; cy?: number; w?: number; eyeY?: number; roll?: number; yaw?: number; iris?: number; irisDown?: number } = {}): Point[] {
  const cx = o.cx ?? 0.5, w = o.w ?? 0.32, h = w * 1.3, cy = o.cy ?? 0.48;
  const ey = o.eyeY ?? cy - 0.12 * h, chinY = cy + 0.48 * h;
  const p: Point[] = Array.from({ length: 478 }, () => ({ x: cx, y: cy }));
  p[3] = { x: cx - w / 2, y: cy - h / 2 }; p[4] = { x: cx + w / 2, y: cy + h / 2 };
  const tilt = (x: number) => ey + (o.roll ?? 0) * (x - cx);
  const eye = (e: typeof LM.eyeA | typeof LM.eyeB, outerX: number, innerX: number) => {
    p[e.outer] = { x: outerX, y: tilt(outerX) }; p[e.inner] = { x: innerX, y: tilt(innerX) };
    const mx = (outerX + innerX) / 2;
    p[e.upper] = { x: mx, y: tilt(mx) - 0.012 }; p[e.lower] = { x: mx, y: tilt(mx) + 0.012 };
    p[e.iris] = { x: outerX + (innerX - outerX) * (o.iris ?? 0.5), y: tilt(mx) - 0.012 + 0.024 * (o.irisDown ?? 0.5) };
  };
  eye(LM.eyeA, cx - 0.32 * w, cx - 0.1 * w);
  eye(LM.eyeB, cx + 0.32 * w, cx + 0.1 * w);
  p[LM.noseTip] = { x: cx + (o.yaw ?? 0) * 0.2 * w, y: ey + 0.45 * (chinY - ey) };
  p[LM.chin] = { x: cx, y: chinY };
  return p;
}
const good = { face: 0.55, frame: 0.5 };

describe('framing and eye-line checks', () => {
  it('passes a centred, well-lit face looking at the camera', () => {
    const c = checkFrame(face(), 4 / 3, good);
    expect(c).toEqual({ face: true, centred: true, distance: 'ok', eyeLine: 'ok', level: true, facing: true, eyeContact: true, lighting: 'ok' });
    expect(liveTip(c)).toBeNull();
  });
  it('names one problem at a time, most important first', () => {
    const tip = (points: Point[] | null, light = good) => liveTip(checkFrame(points, 4 / 3, light));
    expect(tip(null)).toMatch(/cannot see your face/);
    expect(tip(face(), { face: 0.1, frame: 0.12 })).toMatch(/face is dark/);
    expect(tip(face(), { face: 0.3, frame: 0.8 })).toMatch(/light is behind you/);
    expect(tip(face({ w: 0.12 }))).toMatch(/closer/);
    expect(tip(face({ w: 0.62 }))).toMatch(/Move back/);
    expect(tip(face({ cx: 0.78 }))).toMatch(/centre/);
    expect(tip(face({ eyeY: 0.62, cy: 0.7 }))).toMatch(/Raise the camera/);
    expect(tip(face({ roll: 0.6 }))).toMatch(/Level/);
    expect(tip(face({ yaw: 2 }))).toMatch(/Face the camera/);
    expect(tip(face({ iris: 0.8 }))).toMatch(/Look at the camera/);
    expect(tip(face({ irisDown: 0.95 }))).toMatch(/Look at the camera/);
    // A tilt measured in pixels: the same normalised slope is steeper on a wide frame.
    expect(checkFrame(face({ roll: 0.1 }), 1, good).level).toBe(true);
  });
  it('measures brightness inside a box', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set(i % 4 < 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    expect(luminance(data, 4, 4)).toBeCloseTo(0.5);
    expect(luminance(data, 4, 4, { x: 0, y: 0, w: 2, h: 4 })).toBeCloseTo(1);
    expect(luminance(data, 4, 4, { x: 2, y: 0, w: 2, h: 4 })).toBe(0);
  });
  it('summarises an answer and suggests only frequent issues', () => {
    const ok = checkFrame(face(), 4 / 3, good);
    const far: FrameCheck = { ...ok, distance: 'far' };
    const away: FrameCheck = { ...ok, eyeContact: false };
    const none = checkFrame(null, 4 / 3);
    const s = summarise([...Array(6).fill(ok), ...Array(2).fill(far), ...Array(2).fill(none)]);
    expect(s).toMatchObject({ frames: 10, faceVisible: 80, distanceOk: 75, eyeContact: 100, tips: [] });
    const t = summarise([...Array(3).fill(ok), ...Array(5).fill({ ...far, eyeContact: false }), ...Array(7).fill(away)]);
    expect(t.tips).toEqual([expect.stringMatching(/far from the camera/), expect.stringMatching(/Look into the camera/)]);
    expect(summarise(Array(5).fill(none)).tips).toEqual([expect.stringMatching(/out of view/)]);
    expect(summarise([])).toMatchObject({ frames: 0, faceVisible: 0, tips: [] });
  });
});

describe('feature events, report and headers', () => {
  let mongo: MongoMemoryServer;
  const agent = request.agent(app);
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
    await agent.post('/api/auth/register').send({ name: 'Viewer', email: 'viewer@example.test', password: 'test-password' }).expect(201);
  }, 120_000);
  afterAll(async () => { await mongoose.disconnect(); await mongo?.stop(); });

  it('lets the page compile MediaPipe and play local recordings, and nothing more', async () => {
    const csp = (await request(app).get('/api/health')).headers['content-security-policy'];
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("default-src 'self'");
    const directive = (name: string) => csp.split(';').find((d: string) => d.startsWith(`${name} `));
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive('script-src-attr')).toBe("script-src-attr 'none'");
  });

  it('records only the feature, what happened and a rating', async () => {
    await request(app).post('/api/account/feature-events').send({ feature: 'video_review', kind: 'enabled' }).expect(401);
    await agent.post('/api/account/feature-events').send({ feature: 'video_review', kind: 'rating' }).expect(400);
    await agent.post('/api/account/feature-events').send({ feature: 'video_review', kind: 'enabled', rating: 4 }).expect(400);
    await agent.post('/api/account/feature-events').send({ feature: 'emotion', kind: 'enabled' }).expect(400);
    await agent.post('/api/account/feature-events').send({ feature: 'video_review', kind: 'enabled', landmarks: [1, 2] }).expect(201);
    await agent.post('/api/account/feature-events').send({ feature: 'video_review', kind: 'rating', rating: 4 }).expect(201);
    const stored = await FeatureEvent.find().lean();
    expect(stored.map(e => [e.feature, e.kind, e.rating ?? null])).toEqual([['video_review', 'enabled', null], ['video_review', 'rating', 4]]);
    expect(Object.keys(stored[0]).sort()).toEqual(['__v', '_id', 'createdAt', 'feature', 'kind', 'userId']);
    const exported = (await agent.get('/api/account/export').expect(200)).body;
    expect(exported.featureEvents.map((e: { kind: string }) => e.kind)).toEqual(['enabled', 'rating']);
  });

  it('reports opt-in, ratings and 7-day return with and without the feature', async () => {
    await FeatureEvent.deleteMany({});
    const now = new Date();
    const users = await User.insertMany([1, 2, 3, 4].map(i => ({ name: `U${i}`, email: `u${i}@example.test`, passwordHash: 'x' })));
    const start = (u: number, daysAgo: number) => ({ userId: users[u]._id, role: 'Dev', type: 'HR', difficulty: 'Beginner', topic: 'General', totalQuestions: 2, mode: 'practice',
      status: 'completed', createdAt: new Date(now.getTime() - daysAgo * DAY), updatedAt: now });
    // Users 0 and 1 turn the feature on; 0 returns within a week. User 2 returns; user 3 does not.
    await Interview.collection.insertMany([start(0, 20), start(0, 17), start(1, 20), start(2, 20), start(2, 15), start(3, 20), start(3, 2)]);
    await FeatureEvent.insertMany([{ userId: users[0]._id, feature: 'video_review', kind: 'enabled' }, { userId: users[1]._id, feature: 'video_review', kind: 'enabled' },
      { userId: users[0]._id, feature: 'video_review', kind: 'rating', rating: 5 }, { userId: users[1]._id, feature: 'video_review', kind: 'rating', rating: 2 },
      { userId: users[0]._id, feature: 'video_review', kind: 'enabled', createdAt: new Date(now.getTime() - 60 * DAY) }]);
    const report = await featureReport(30, new Date(now.getTime() + 60_000)); // after the events were written
    expect(report.features.video_review).toEqual({ activeUsers: 4, optedIn: 2, optInRate: 50, ratings: 2, meanRating: 3.5, ratingCounts: [0, 1, 0, 0, 1],
      retention: { withFeature: { users: 2, returnedWithin7Days: 50 }, withoutFeature: { users: 2, returnedWithin7Days: 50 } } });
    expect(report.features.avatar).toMatchObject({ activeUsers: 4, optedIn: 0, optInRate: 0, ratings: 0, meanRating: null });
    expect(JSON.stringify(report)).not.toMatch(/[a-f0-9]{24}/);
  });
});
