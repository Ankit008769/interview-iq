# Timed rounds

Implemented 24 October 2026 as the last Phase A4 "expanded coach" slice. Works in
practice and AI modes; no AI call is involved.

## User flow

Setup offers **Time per question**: Untimed (default), 2, 3 or 5 minutes. The
interview room then shows a countdown above the question ("1:42 left"). It turns
amber in the last 30 seconds and red at zero ("Time is up · +0:12"), with a note to
finish and submit.

The limit is **soft**: answers are still accepted after time runs out, because a hard
cutoff would lose the candidate's work. The saved answer records the time taken and
an over-time flag. **Pause timer** stops the clock and hides the question until
**Resume**, so pausing does not become extra thinking time. The draft answer is kept.

Results show "Answered in 1:35 of 2:00" or "Answered in 2:11, 0:11 over the 2:00
limit" under each question (plus any paused time), and a summary such as "Timed
round: 1 of 2 answers within the 2:00 limit". Untimed sessions also show time
taken, without a limit or flag.

## Server clock

Timing is computed on the server so reloads, closed tabs and client clocks cannot
change it:

- `questionStartedAt` is set when an interview is created and whenever the worker
  makes the next question ready. Time spent processing an answer is never counted.
- `pausedAt` and `pausedMs` track pauses for the current question.
  `POST /api/interviews/:id/pause` and `/resume` are idempotent. Resume matches the
  exact `pausedAt` it read, so a duplicate resume cannot count a pause twice.
- Saving an answer stores `elapsedSeconds` (time on the question minus paused time),
  `pausedSeconds` and, for timed rounds, `overTime`. Answering while paused stops the
  clock at the moment of the pause. Saving clears `pausedAt`.
- Only an in-progress timed question that is on screen (`processingState: ready`)
  can be paused (409 otherwise). Pause and resume have their own write bucket (60 per
  15 minutes), so they cannot use up answer submissions.
- Interview responses include `serverNow`. The browser uses it to correct for clock
  skew when drawing the countdown.
- `timeLimitSeconds` must be 120, 180 or 300 (400 otherwise). Older interviews have no
  clock fields and simply show no timing.

## Verification

`server/tests/timing.test.ts` checks the created clock and `serverNow`, rejected
limits, recorded time and over-time flags, clock restart only when the next
question is ready, pause exclusion, idempotent pause and resume, answering while
paused, pause rules for untimed, processing and other users' interviews, and time
taken for untimed sessions. `server/e2e/timed.spec.ts` drives setup, countdown,
pause (question hidden, clock frozen), resume with the draft intact, a time-up state
(via a loopback-only fixture route that ages the question) and the results summary.
