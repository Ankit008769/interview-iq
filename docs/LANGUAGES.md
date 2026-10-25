# Hindi and Hinglish interviews (Phase B5, v1, beta)

Implemented 25 October 2026. AI interviews can be held in **English**, **Hindi**
(Devanagari) or **Hinglish** (Hindi in Roman script mixed with English). Questions, the
per-answer verdict and reason, the points a strong answer covers, tips, the summary,
improvements and next steps come back in the chosen language. Candidates may answer in
Hindi, English or a mix. Practice interviews stay in English, because the curated bank
is English.

This is a first, text-first slice of B5 using the same local model (Qwen3.5 4B through
Ollama, see [LOCAL_MODELS.md](LOCAL_MODELS.md)). The Hindi UI, Indic speech recognition
and a Hindi voice model from the roadmap are later steps.

## How it works

- `language` on the interview: `en` (default), `hi` or `hinglish`, chosen in setup when
  AI is on. `POST /api/interviews` rejects Hindi or Hinglish with practice mode.
- For Hindi and Hinglish, every AI prompt (question, grounded question, scoring, score
  re-review, rewrite, STAR check) gets one language instruction: write candidate-facing
  text in that language, keep technical terms in English, keep JSON keys, IDs and enum
  values unchanged, and still copy quotes exactly from the answer in whatever script it
  uses. Evidence verification is unchanged and works on Devanagari text.
- The prompt version records the language, for example `evidence-judge.v2+hi` and
  `interviewer.v3+hinglish`, so English prompts and the calibration measured with them
  are unchanged.
- Reading a question aloud asks the browser for a `hi-IN` voice for Hindi and `en-IN` for
  Hinglish (Roman script). Voice transcription, when enabled, gets a `hi` language hint
  for Hindi interviews; mixed Hinglish is left to auto-detection.
- The interview header and results title show the language.

## Measured on the laptop CPU (25 October 2026)

- Hindi question: about 30 s (about 110 output tokens; Devanagari uses many more tokens
  than English). Hinglish question: about 16 s.
- Scoring two Hindi-feedback answers: about 240 s (about 1,700 output tokens), so a
  five-answer Hindi interview takes roughly 10 minutes to score.
- Quality: Hinglish questions were natural; Hindi questions were understandable but
  sometimes unnatural. Hindi feedback (verdicts, key points, tips, next steps) was
  sensible, and a strong Hindi STAR answer was scored high with verified quotes. A
  Hinglish answer that did state a result was marked as missing it, so scoring of
  mixed-language answers is less accurate than English. Setup labels both languages
  **beta** and says so.

## Not yet done

- The B5 exit gate (Hinglish word error rate and native-speaker ratings of Hindi rounds)
  is not measured; with no human raters, a Hindi version of the automated evaluator check
  would be the substitute.
- A larger or Indic-tuned model (for example on a GPU) for better Hindi; Hindi UI text;
  Indic speech recognition and text-to-speech.

## Tests

`server/tests/languages.test.ts`: a Hindi interview end to end with the instruction on
every prompt and tagged prompt versions, verified Devanagari quotes and strengths, a
Hindi rewrite prompt, Hinglish instructions, unchanged English prompts, practice-mode
rejection and the transcription hint. `server/e2e/language.spec.ts`: choosing Hindi in
setup, the language label and a `hi-IN` read-aloud request in Chromium.
