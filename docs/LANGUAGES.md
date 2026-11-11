# Interview languages: Hindi, Hinglish (B5, beta) and four regional languages (E2, experimental)

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

## Tamil, Telugu, Bengali and Marathi (Phase E2, v1, experimental)

Added 11 November 2026, for HR and behavioural interviews in AI mode.

| Part | Behaviour |
|---|---|
| Language codes | `ta`, `te`, `bn` and `mr`. Setup shows these languages only when the interview type is HR or Behavioral; `POST /api/interviews` refuses them for technical interviews and for practice mode. |
| Prompts | Each prompt gets one instruction: write in that language and its own script (Tamil, Telugu or Bengali script, or Devanagari for Marathi, "not Hindi"), keep common workplace terms in English, and copy quotes exactly. Prompt versions are tagged `+ta`, `+te`, `+bn` and `+mr`. |
| Quotes | Evidence quotes are verified word for word in any script, as for Hindi. |
| Speech | Read-aloud asks the browser for a `ta-IN`, `te-IN`, `bn-IN` or `mr-IN` voice. The transcriber gets the language hint; faster-whisper supports all four. |
| Plans | When billing is enforced these languages are a Pro feature, like Hindi and Hinglish. |

### Measured with the local model (11 November 2026)

`npm run language-check -- --questions 3` asked qwen3.5:4b on the laptop CPU for three HR and three behavioural
questions in each language (24 questions in all). "In script" is the share of letters and vowel signs written
in the language's own script.

| Language | Mean in script | Questions at least 80% in script | Questions with another Indic script | Seconds per question |
|---|---|---|---|---|
| Tamil | 93% | 6 of 6 | 0 | 27 |
| Telugu | 87% | 5 of 6 | 0 | 24 |
| Bengali | 98% | 6 of 6 | 1 | 27 |
| Marathi | 95% | 6 of 6 | 0 | 24 |

Reading the questions themselves (not a native-speaker review):
- **Bengali** questions were mostly sensible interview questions.
- **Tamil and Telugu** questions were often awkward, and some were off-topic. One Tamil HR question was
  about molecular-level biology, and Telugu ones mentioned "controversial metrics" and "Cartier".
- **Marathi** sometimes used Hindi words (आपके) or made-up ones.
- One Bengali question contained a few Cyrillic letters.

The script is right, but the language quality of this 4B model is not good enough to recommend. Setup
therefore labels these languages **experimental** and says that questions can be unnatural or off-topic.

### Not yet done (E2)

- **Better models.** A larger or Indic-tuned model, and Indic speech models (IndicConformer for recognition,
  Indic Parler-TTS for speech), as the roadmap plans. Both need a GPU.
- **Native-speaker ratings** of questions and feedback in each language.
- **Scale items.** The rest of E2 needs the cloud project's billing and GPUs: GKE Inference Gateway,
  reservations, disaster recovery in Delhi and a TPU batch-evaluation trial.

### Tests

- `server/tests/languages.test.ts`: each language on HR and behavioural rounds with its instruction and
  prompt tag, refusal for technical and practice interviews, and the transcriber hint.
- `server/tests/language-check.test.ts`: the script-share measure, including vowel signs, mixed English and a
  wrong-script question.
