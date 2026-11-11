# Video self-review and interviewer avatar (Phase D4, v1)

Implemented 11 November 2026. Both features are optional and off by default.

- **Camera practice.** The candidate sees themselves during an interview, with live tips on framing, eye line
  and lighting. Each answer is recorded so they can watch it on the Results page. Everything stays in the
  browser.
- **Interviewer avatar.** A simple drawn face moves its mouth while a question is read aloud.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| On-device recording for self-review | Yes. One recording per answer, in the browser's IndexedDB only. Never uploaded. Deleted after 14 days or on request. |
| Framing and eye-line tips via in-browser MediaPipe | Yes. MediaPipe Face Landmarker 1.1.1 (Apache-2.0) runs as WebAssembly from the app's own files. |
| Optional lightweight 2D interviewer avatar synced to TTS | Yes. An SVG face driven by the browser's speech-synthesis events, with a still version under reduced motion. |
| No emotion inference | Yes. Blendshapes (MediaPipe's expression outputs) are switched off. Only landmark positions and image brightness are used. |
| Video stays local unless shared | Yes. There is no sharing or upload path at all in v1. |
| Exit gate: privacy review passed | The engineering review is below. **A human privacy or legal sign-off is still needed.** |
| Exit gate: opt-in rate and satisfaction measured; keep only if it improves retention | Measured with `npm run feature-report` (below). There are no users yet, so there is no result yet. |

## How it works

### Camera practice (`CameraCoach`)

The Interview page shows a **Camera practice** card, which is off by default. Turning it on:

- asks for the camera and microphone and shows a mirrored self-view;
- loads MediaPipe lazily, the first time on that device. The download is about 13.5 MB of WebAssembly and a
  3.7 MB model, served by the app.

About five times a second, it reads the face landmarks and a 64 × 48 copy of the frame (`lib/framing.ts`).
It checks:

| Check | Pass condition |
|---|---|
| Face visible | A face is found |
| Centred | The face centre is within 35–65% of the width |
| Distance | The face box is 20–55% of the frame width |
| Eye line | The eyes are 22–50% of the way down the frame, about a third being ideal |
| Level | Head or camera roll is at most 8° |
| Facing the camera | The nose is close to the eye midpoint (turn), and sits between the eye line and the chin (nod) |
| Eye contact | Facing the camera, with each iris near the middle of its eye across and between the lids |
| Lighting | The face is not dark (luminance below 0.22), and not much darker than the frame (backlit) |

One tip is shown at a time, most important first. It is the tip seen most often over the last two seconds, so
it does not flicker.

Recording:
- Each answer is recorded with `MediaRecorder` (WebM at about 600 kbit/s, so roughly 4.5 MB a minute).
- Recording starts when a question appears and stops when the answer is submitted, with a cap of 10 minutes.
- The recording is saved with a summary of that answer's checks: the share of frames for each check, and
  advice for any issue present in at least 30% of frames. Eye contact below 50% also gets advice, because
  looking at the screen is normal.

### Results (`SelfReview`)

The Results page lists this device's recordings for the interview, with the question, length, size, framing
percentages and advice. **Watch** plays a recording from a `blob:` URL.

Each recording can be deleted, and a 1–5 "Was video self-review useful?" rating is asked once per device.

**Account** shows how many recordings this device holds and their size, has switches for both features, and
can delete every recording on the device.

### Interviewer avatar (`InterviewerAvatar`)

The avatar is switched on per device with **Interviewer avatar** under the question.

- **Speech.** `ReadAloud` sends `iq-speech` events: start, word boundary and end. The avatar opens its mouth on
  each word boundary and keeps moving while speech lasts, because some voices send no boundaries.
- **Blinking.** It blinks every 3 to 6 seconds.
- **No reactions.** It has no expressions and never reacts to the candidate.
- **Reduced motion.** It stays still when the user prefers reduced motion.

## Privacy review (engineering)

| Question | Answer |
|---|---|
| What is collected? | Video and audio of the candidate's answers, on their own device only. |
| Where is it stored? | IndexedDB in the browser (`interviewiq-self-review`), per device and per browser profile. |
| Is anything sent to Interview IQ? | Only optional-feature signals: feature (`video_review` or `avatar`), event (`enabled`, `disabled` or `rating`), a 1–5 rating, the account and the time (`feature_events`, kept about 13 months). No video, audio, images, landmarks or framing figures. |
| Is anything sent to third parties? | No. MediaPipe and its model are served by the app. MediaPipe 1.1.1 has built-in usage logging to `odml.pa.googleapis.com`, which is switched off in code (`silenceUsageLogging`). The content-security policy also blocks any such request, because `connect-src` falls back to `'self'`. The browser test fails if any request leaves the app. |
| What is inferred? | Face position and size, head tilt and turn, iris position in the eye, and brightness. Expressions (blendshapes), emotion, personality, attractiveness, identity, age, gender and ethnicity are never inferred. |
| Does it affect scores? | No. Framing advice is shown only to the candidate and is not part of any score or placement report. |
| Who can see recordings? | Only someone using the same browser profile on that device. |
| Retention | 14 days, purged whenever the feature or the Results page is used. Recordings can also be deleted one at a time or all at once. |
| Consent | The feature is opt-in. The camera card states what happens before the camera starts, and the browser asks for camera permission. |
| Account deletion and export | `feature_events` is included in the export (`featureEvents`), deleted with the account, and removed on backup restore. Recordings are not on the server, so the Account page explains how to delete them on the device. |
| Shared computers | Recordings persist in that browser profile until they expire or are deleted. The privacy note and the Account page say so. |
| Content-security policy change | `script-src` adds `'wasm-unsafe-eval'`, so WebAssembly can compile; it does not allow JavaScript `eval`. `media-src` adds `blob:` for playback. Nothing else changes. |

Still needed before a public launch:
- a human privacy or legal sign-off on this review, as part of D2;
- a decision on whether to measure retention by cohort once there are users.

## Model and files

| File | Source | Licence |
|---|---|---|
| `client/public/mediapipe/face_landmarker.task` (committed, 3,758,596 bytes, SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`) | `storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task` | Apache-2.0 |
| `client/public/mediapipe/wasm/*` (copied from `node_modules` at build, gitignored) | `@mediapipe/tasks-vision` 1.1.1 | Apache-2.0 |

## Measuring the exit gate

`npm run feature-report -- --days 30` (server, with `MONGODB_URI`) prints counts only, with no IDs:

| Figure | Meaning |
|---|---|
| Active users | Users who started an interview in the window |
| Opt-in | How many of them switched each feature on in the window, and the rate |
| Ratings | The number of ratings, the mean and the count for each value |
| 7-day return | Among users whose first interview in the window was at least 7 days before its end, the share who started another interview more than an hour and up to 7 days later, with and without the feature |

The feature should be kept only if the return rate with it is not worse. Small numbers need care.

## Tests

`server/tests/self-review.test.ts` covers:
- each framing check and the order of tips on synthetic landmarks;
- tilt measured in real proportions, brightness inside a box, and the per-answer summary and its thresholds;
- the content-security policy;
- that feature events accept only feature, event and rating, and appear in the export;
- the report's opt-in, rating and return figures.

`server/e2e/self-review.spec.ts` uses Chromium's fake camera, which shows no face:
1. Turning the camera on gives the "cannot see your face" tip, which proves MediaPipe loads and runs under
   the content-security policy.
2. The avatar follows speech events.
3. Both answers are recorded on the device, play back from `blob:`, and can be rated and deleted.
4. The account export contains only the feature events, and nothing was uploaded.
5. No request went to any other address.
6. Account shows and deletes the device's recordings.
