# Delivery feedback and STAR checks (Phase B4, v1)

Implemented 25 October 2026. Two coaching aids that sit beside the evidence scorecard
and never change a score:

- **Delivery feedback** for voice answers: speaking pace and common filler words.
- **STAR check** for behavioral answers: which parts of situation, task, action and
  result the answer states, quoting the candidate's own words.

This is a first, API-first version of the B4 plan. It needs no extra model or audio
processing: delivery is computed on the server from the transcript and the recording
length, and the STAR check is one prompted call through the existing provider boundary.

## Delivery feedback

**What is measured.** When a candidate records a voice answer (B1), the browser sends
the recording length (`X-Recording-Ms`) with the audio. After transcription the server
computes, for that recording:

- seconds and words (whitespace-separated tokens containing a letter or digit, so
  Devanagari works too);
- words per minute, shown only for at least 10 seconds of speech;
- filler counts from a small rule set (`services/delivery.ts`, version `delivery.v1`).

Only these counts are stored, on the interview, against the question that was on
screen (`deliveryClips`, at most the latest 50 per interview). The transcript text and
the audio are not stored for delivery. Nothing about tone, emotion, accent,
personality or protected traits is inferred.

**Filler rules favour precision.** Counted: `um`, `uh`, `erm`, `hmm`, `basically`,
`literally`; `you know` ending a clause (not "do you know?", "if you know", "as you
know"); `I mean` followed by a comma; `like` set off by commas; Hinglish `matlab` /
`मतलब` followed by a comma or opening a sentence, but not "iska matlab hai" (this means)
and never the software name MATLAB. Not counted: ambiguous words such as "actually",
"so", "na", "toh", "sort of" and "like" inside a sentence.

On the synthetic labelled set `calibration/fillers.synthetic.v1.jsonl` (44 sentences
including hard negatives) the rules score precision 0.96 and recall 0.87; the test
requires precision ≥ 0.9. The one known false positive is a sentence-initial "Matlab
kya hai…?" (what does … mean?). The B4 exit gate needs the same measurement on real,
consented transcripts, which has not been done.

**Known limits.** Transcription models often drop "um" and "uh", so hesitation counts
are a lower bound; the panel says so. The recording length comes from the browser and
includes silence before and after speaking. Long pauses and talk ratio need word
timings or real-time voice (B2) and are not measured.

**Where it appears.** Right after a transcription, under the recorder ("Last
recording: 0:12 · 140 words per minute · fillers: “basically” ×1"), and on the results
page as a *Delivery from your voice answers* panel with a session line and one line per
question. The panel quotes a rough guide (conversational English is often quoted at
about 120–150 words per minute) and says clarity matters more than speed.

**Turning it off.** Account → *Delivery feedback*, or *Turn off delivery feedback* on
the results page (`PATCH /api/account/preferences { deliveryMetrics: false }`). Off
means new recordings are not measured and existing delivery feedback is hidden. The
preference is returned as `user.preferences.deliveryMetrics` (absent means on).

## STAR check

`POST /api/interviews/:id/star { questionIndex }` on a completed AI behavioral
interview. The judge slot (prompt `star-coverage.v1`) returns each STAR part once, with
either a passage copied from the answer or a one-sentence tip on what kind of detail to
add. A part is **found** only when its trimmed quote appears verbatim in the answer;
otherwise it is **missing**, shown with the tip. The prompt forbids writing the missing
content, inferring unstated parts and following instructions inside the answer.

One check per answer, stored in `starChecks`; repeating the request returns the saved
check without another provider call. Provider failures return a generic message, store
nothing, and emit `star_check_failure`. The usage ledger records every attempt. The
interview's scores and feedback are unchanged.

## Tests

`server/tests/delivery.test.ts`: word, pace and filler counting (including Hinglish
and hard negatives); precision on the labelled set; clips recorded for the question on
screen, never the transcript, ignored without a valid recording length, and bounded;
the off switch; STAR checks with verified quotes, replay, invented quotes, failures and
eligibility. `server/tests/source-encoding.test.ts` keeps every source file valid UTF-8
(the voice controls had shown `�` because of Windows-1252 characters).
`server/e2e/delivery.spec.ts` runs the results page, STAR check, phone layout and the
off switch in Chromium.

## Not yet done

- Filler precision on real, consented Indian English and Hinglish transcripts (B4 gate:
  ≥ 0.9), and a privacy review of delivery metrics.
- Pauses, talk ratio and word-level timings; delivery for typed answers is out of
  scope.
- STAR checks are prompted; the strategy report's trained IQ-Delivery model (C1) is
  conditional on consented data and measured shortcomings.
