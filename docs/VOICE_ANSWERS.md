# Voice: turn-based answers and read-aloud (Phase B1)

Implemented 25 October 2026 as the first Phase B slice. Real-time voice (B2) comes
later; this slice keeps the existing text pipeline, so evidence scoring, challenges and
rewrites work unchanged on spoken answers.

## What the user sees

- **Read question aloud** on every question. It uses the browser's built-in speech
  synthesis, so it works in practice mode. Local voices are preferred when available;
  other voices may use browser/OS provider services, so offline processing is not guaranteed. The question
  stays on screen as the caption. The button is hidden in browsers without speech
  synthesis.
- **Answer by voice** in AI interviews when transcription is enabled. The browser asks
  for the microphone, a timer shows the recording length (automatic stop at 5 minutes),
  and **Stop recording** sends the audio for transcription. The text is appended to the
  answer box for the candidate to **review and edit before submitting**. Nothing is
  submitted automatically. A blocked microphone, silence or a provider failure shows a
  message, and typing always remains available.

## Provider and privacy

- API-first, like text: `TRANSCRIPTION_MODEL` enables voice through the configured
  provider's OpenAI-compatible `/audio/transcriptions` endpoint. That is OpenAI (for
  example `gpt-4o-mini-transcribe` or `whisper-1`), or a self-hosted Whisper server
  behind the compatible gateway. Voice stays off until the variable is set, and
  practice mode never transcribes.
- The AI disclosure gains the transcription model and a voice paragraph when voice is
  on. Because the disclosure is fingerprinted, turning voice on asks every user to
  review and accept again. Turning it off restores the earlier text and fingerprint.
- **Interview IQ does not persist recordings.** Provider retention follows its terms. The server holds the upload in memory, passes it
  to the provider and discards it. Only the text the candidate submits is saved. The
  usage ledger records each attempt (slot `transcriber`, prompt `transcription.v1`)
  before calling the provider. Provider errors are never echoed or logged.

## Local speech-to-text (25 October 2026)

With `AI_PROVIDER=local`, voice answers use **faster-whisper** on the Interview IQ server
instead of a hosted API, so recordings never leave it. `deploy/whisper/server.py` is a
small FastAPI app that loads the Whisper `small` model (multilingual, int8, about 464 MB)
once and serves the OpenAI-compatible `POST /v1/audio/transcriptions` the app already
calls, plus `GET /health`. Audio is decoded in memory and never written or logged.

- Laptop: create a virtual environment, `pip install -r deploy/whisper/requirements.txt`,
  then `uvicorn server:app --host 127.0.0.1 --port 8000` in `deploy/whisper`, and set
  `TRANSCRIPTION_MODEL=small` in `server/.env`. `TRANSCRIPTION_BASE_URL` defaults to
  `http://127.0.0.1:8000/v1` and must be on localhost; `TRANSCRIPTION_TIMEOUT_MS`
  defaults to 300000 for local CPU.
- Windows example (13 November 2026), with the environment and model kept outside the repo:

  ```
  python -m venv E:\InterviewIQ\tools\whisper-venv
  E:\InterviewIQ\tools\whisper-venv\Scripts\python -m pip install -r deploy\whisper\requirements.txt
  cd deploy\whisper
  set WHISPER_MODELS_DIR=E:\InterviewIQ\tools\whisper-models
  set WHISPER_BEAM=5
  E:\InterviewIQ\tools\whisper-venv\Scripts\python -m uvicorn server:app --host 127.0.0.1 --port 8000
  ```

  `WHISPER_BEAM=5` is slower than the default of 1, but more accurate for accented speech.
- **Language hint.** The transcriber is told the interview's language: `en` for English, and `hi`, `ta`,
  `te`, `bn` or `mr`. Only mixed Hinglish is left to auto-detection. Without a hint, Whisper guesses from the
  first seconds and could write an Indian-accented English answer in Hindi.
- Cloud Run: `deploy/whisper/Dockerfile` bakes the model in; it runs as a third
  container (`whisper`, 1 vCPU, 2 GiB, startup probe `GET /health` on port 8000), so the
  app (1) and Ollama (6) keep their CPUs within 8 vCPU per instance. Cloud Run only accepts
  per-container CPU of 0.08–1, 2, 4, 6 or 8 (a first attempt with Ollama at 5 was refused),
  and the release script now checks this. With one vCPU, online transcription is slower
  than on the laptop. `deploy/prepare-release.mjs
  candidate --voice-image IMAGE` adds it and points the app at it; Terraform declares it
  (`voice_image`, `voice_cpu`, `voice_memory`).
- `GET /api/health` reports `voice: "ready"` when the speech server answers. Turning
  voice on changes the consent text (recordings are transcribed on the Interview IQ
  server and then discarded), so users accept once more.
- Pins: faster-whisper 1.2.1 needs PyAV 15.1.0; PyAV 19 rejects an argument it passes,
  and every recording then fails to decode.

Measured on the laptop CPU: a 17.6 s spoken answer (WAV or WebM/Opus) transcribed in
about 7.5–8 s, about 8 s through the app including delivery feedback; the text was exact
apart from "XOR" becoming "x or". Hindi accuracy is not measured (no Hindi test voice on
the laptop); the `small` model is weaker on Hindi than larger Whisper models.

## API

The browser also sends the recording length as `X-Recording-Ms`; the server then returns
pace and filler counts as `delivery` and stores only those counts, unless the candidate
turned delivery feedback off ([DELIVERY_AND_STAR.md](DELIVERY_AND_STAR.md)).

`POST /api/interviews/:id/transcribe` with the raw recording as the body and its type
as `Content-Type`. Returns the full `{ transcript }`. The answer remains limited to 3,500 characters;
long transcripts are preserved in an editable recovery box instead of truncated.

- Accepted types: `audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg`,
  `audio/wav`/`audio/x-wav`. Each is checked against the file's leading bytes (415 if it
  does not match). Under 1 KB returns 400; over 8 MB returns 413.
- Requires the owner's in-progress AI interview with a question on screen (409
  otherwise), voice enabled on the server (409), and current AI consent (409
  `AI_CONSENT_REQUIRED`).
- Counts against the interview write limit and the daily AI call quota.
- 502 on provider failure (`transcription_failure` WARNING event), 422 when no speech
  is detected.
- `GET /api/interviews/mode` now also returns `transcription: true|false`.

The general error handler now returns 413 for any oversized body and 400 for an
unreadable body, instead of a generic 500.

## Verification

`server/tests/transcription.test.ts` (real local HTTP gateway and MongoDB): disclosure
and fingerprint change, the mode flag, a successful multipart upload with model and
filename, usage records, no stored audio or transcript, Ogg support, rejected types,
mislabelled and tiny files, the 8 MB limit, interview-state rules, other accounts,
voice switched off, withdrawn consent, provider failure without leaked text, and
silence. `server/e2e/voice.spec.ts` uses Chromium's fake microphone so the real
`MediaRecorder` records, uploads and transcribes. It checks the appended transcript,
editing before submit, the saved answer and read-aloud.

Not yet measured: transcription accuracy for Indian English and Hinglish. B5 adds the
test sets, and IndicConformer routing if needed.

## Reliability follow-up — 25 October 2026

Voice permission requests, recording and transcription can be cancelled. Navigation
or a question change stops all microphone tracks and aborts the local upload; a late
permission result or transcript is ignored. Cancelling cannot recall audio already
sent to the provider. Submitting an answer is disabled while voice is active. Typing
remains available, and overflow transcripts can be shortened without replacing the
existing answer. Recording errors release resources and recordings are bounded by
five minutes and 8 MB. Paused interviews reject transcription.

Consent is checked again immediately before vendor dispatch. Withdrawal after the
usage receipt is created cancels the attempt with zero tokens and sends no audio.
Browser regressions cover cancellation, navigating away while recording and overflow
correction, in addition to the original spoken-answer flow.
