import { describe, expect, it } from 'vitest';
import { AlertTracker, ALERT_RULES } from '../../client/src/lib/proctor.js';

// Face checks arrive about every 200 ms and object checks about every second, as in the camera panel.
describe('practice integrity alerts', () => {
  it('alerts when a second face stays in view, not on a single stray frame', () => {
    const t = new AlertTracker();
    expect(t.faces(2, 0)).toEqual([]);
    expect(t.faces(1, 200)).toEqual([]); // gone again: no alert
    expect(t.faces(2, 400)).toEqual([]);
    expect(t.faces(2, 600)).toEqual([]);
    expect(t.faces(2, 900)).toEqual([{ kind: 'multiple_faces', text: 'Another face is in view.' }]);
    // While it lasts, the alert repeats only every eight seconds, and counts as one episode.
    expect(t.faces(2, 1100)).toEqual([]);
    expect(t.faces(2, 900 + ALERT_RULES.repeatMs)).toHaveLength(1);
    expect(t.counts.multiple_faces).toBe(1);
    t.faces(1, 10_000); t.faces(2, 10_200); t.faces(2, 10_800);
    expect(t.counts.multiple_faces).toBe(2);
  });

  it('alerts when the face is out of view for two seconds', () => {
    const t = new AlertTracker();
    for (let ms = 0; ms < ALERT_RULES.faceAwayMs; ms += 200) expect(t.faces(0, ms)).toEqual([]);
    expect(t.faces(0, ALERT_RULES.faceAwayMs)).toEqual([{ kind: 'face_away', text: 'Your face left the frame.' }]);
    expect(t.faces(1, 2200)).toEqual([]);
    expect(t.counts).toMatchObject({ face_away: 1, multiple_faces: 0 });
  });

  it('alerts on a phone, book, second screen or second person seen in two checks in a row', () => {
    const t = new AlertTracker();
    const phone = [{ label: 'cell phone', score: 0.6 }];
    expect(t.objects(phone, 0)).toEqual([]);
    expect(t.objects(phone, 1000)).toEqual([{ kind: 'phone', text: 'A phone is in view.' }]);
    expect(t.objects([], 2000)).toEqual([]); // the streak resets
    expect(t.objects([{ label: 'cell phone', score: 0.3 }], 3000)).toEqual([]); // too unsure to count
    expect(t.objects([{ label: 'book', score: 0.7 }, { label: 'person', score: 0.9 }], 4000)).toEqual([]);
    expect(t.objects([{ label: 'book', score: 0.7 }, { label: 'person', score: 0.9 }, { label: 'person', score: 0.8 }], 5000))
      .toEqual([{ kind: 'object', text: 'A book or notes are in view.' }]);
    expect(t.objects([{ label: 'person', score: 0.9 }, { label: 'person', score: 0.8 }], 6000)).toEqual([{ kind: 'multiple_faces', text: 'Another person is in view.' }]);
    expect(t.objects([{ label: 'laptop', score: 0.9 }], 7000)).toEqual([]);
    expect(t.objects([{ label: 'laptop', score: 0.9 }], 8000)).toEqual([]); // "object" sounded at 5 s; it repeats only after 8 s
    expect(t.objects([{ label: 'laptop', score: 0.9 }], 13_000)).toEqual([{ kind: 'object', text: 'Another screen is in view.' }]);
    expect(t.objects([{ label: 'dog', score: 0.99 }], 14_000)).toEqual([]); // not something the alerts watch
    expect(t.counts).toMatchObject({ phone: 1, object: 2, multiple_faces: 1 });
  });
});
