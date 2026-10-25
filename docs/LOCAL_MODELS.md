# Local open models and AI-only scoring

Decided 25 October 2026. This replaces two parts of the earlier plan:

- **No human raters.** Scores come from AI models only. The A5 human panel is not
  being recruited; automated checks take its place (below).
- **Local, pretrained open models first.** Questions are generated fresh for every
  interview by an open-weight model running on the Interview IQ machine, not drawn
  from a fixed bank and not sent to an outside AI company. Training our own model
  comes later, when there is data and a GPU.

The provider boundary from Phase A stays: `AI_PROVIDER=local` is one more provider next
to `practice`, `openai` and `compatible`, so switching back or mixing is configuration.

## Setup (Windows laptop)

1. Install Ollama: `winget install --id Ollama.Ollama --exact` (MIT licence). It serves
   an OpenAI-compatible API on `http://127.0.0.1:11434/v1`, on loopback only. Set the
   Windows environment variable `OLLAMA_CONTEXT_LENGTH=16384` before starting it: the
   default 4,096-token window fits one answer but not a full five-answer scorecard.
2. Download the models:
   ```
   ollama pull qwen3.5:4b     # questions and scoring
   ollama pull gemma4:e2b     # second, independent judge for automated checks
   ```
3. In `server/.env`: `AI_PROVIDER=local`. Defaults: both slots `qwen3.5:4b`,
   `LLM_BASE_URL=http://127.0.0.1:11434/v1`, `LLM_TIMEOUT_MS=1200000` (20 minutes). Set
   `INTERVIEWER_MODEL` / `JUDGE_MODEL` to use other local models. `AI_MODEL` (the OpenAI
   fallback) is ignored for local models.
4. Check it: `npm run local-check` (in `server/`) generates one question and scores one
   calibration answer, with timings.

## How the app behaves with a local model

- **Fresh questions.** Every question is generated. The prompt receives the questions
  this candidate saw in their last 10 interviews (`avoidQuestions`, up to 20) and must
  not repeat or closely paraphrase them; an exact repeat is asked for again, up to three
  times. Prompt versions `interviewer.v3` and `interviewer-grounded.v2`.
- **Scoring** uses the same evidence rubric, exact-quote verification and
  insufficient-evidence rules as before; only the model changes. The schema sent with
  each scoring request lists the rubric's own criterion IDs and requires each answer and
  criterion exactly once, so the local model's constrained decoding cannot return
  unknown IDs or the wrong count. The local judge runs at temperature 0, so the same
  answer gets the same scorecard.
- **Thinking is off** (`reasoning_effort: none`) so CPU time goes to the answer.
- **Timeouts and leases.** Model calls may take up to `LLM_TIMEOUT_MS` (20 minutes by
  default for local). Worker leases for interviews and score challenges are always a
  minute longer than that, so a slow call is never processed twice. The browser waits up
  to 3 minutes for an interview's first question and 5 minutes for a rewrite or STAR check.
- **Consent text** says answers are processed by open models on the Interview IQ server
  and are not sent to an outside AI company (policy `2026-10-25.local.v1`). Switching
  provider changes the fingerprint, so users accept again.
- **Cost** is recorded as `local_model` with no per-call charge; the machine's own cost
  is not attributed per request.

## Models chosen

| Role | Model | Download | Why |
|---|---|---|---|
| Questions and scoring | Qwen3.5 4B (`qwen3.5:4b`, March 2026) | ~3.4 GB | Largest Qwen3.5 size that runs comfortably on a 15 GB RAM laptop CPU; structured JSON output; multilingual |
| Second judge (checks only) | Gemma 4 E2B (`gemma4:e2b`) | ~4.6 GB | Different model family from a different lab, so agreement means more than one model agreeing with itself |

The strategy report's server choices (Qwen3.6-35B-A3B, Qwen3.8-27B, Gemma 4 26B/31B)
need 18–24 GB downloads and a GPU; they are the upgrade path on Google Cloud.

## Automated checks instead of human raters

```
npm run calibration judge -- --items ../calibration/items.synthetic.v1.jsonl --out ../calibration/output/qwen.jsonl --reviewed --yes
npm run calibration judge -- --items ../calibration/items.synthetic.v1.jsonl --out ../calibration/output/gemma.jsonl --model gemma4:e2b --reviewed --yes
npm run calibration auto-report -- --items ../calibration/items.synthetic.v1.jsonl --a ../calibration/output/qwen.jsonl --b ../calibration/output/gemma.jsonl --out ../calibration/output/auto.md
```

| Gate | Threshold | What it shows |
|---|---|---|
| Pairwise ordering, per judge | ≥ 0.80 | Share of answer pairs of different intended quality (strong > adequate > weak > off-topic) that the judge orders correctly; ties count half |
| Rank correlation, per judge | Spearman ≥ 0.60 | Same idea as a correlation |
| Agreement between the two judges | ICC(A,1) ≥ 0.60 on item scores | Two independent models give similar scores |

An item's score is the mean of its criterion scores, with insufficient evidence counted
as 0. Gates report "insufficient data" below 20 items.

**What these checks do not show:** that the scores match what an expert interviewer
would give. Synthetic answers are also easier to tell apart than real ones. Scores stay
labelled as AI coaching estimates, not hiring predictions.

## Measured on this laptop

HP Pavilion 15 (Ryzen 5 7530U, 6 cores, 15 GB RAM), CPU only (`size_vram` 0), Qwen3.5 4B
Q4_K_M, 25 October 2026:

| Task | Time | Tokens |
|---|---|---|
| First load from disk | ~27 s | — |
| One question (warm) | 12–14 s | ~130 in / ~40–50 out |
| Scoring one answer (5 criteria) | ~95–105 s | ~610 in / ~515 out |
| Generation speed | ~5 tokens/s | — |

A three-answer interview takes about 5 minutes to score and a five-answer one about
8–9 minutes. Scoring runs in the background worker, so the candidate can leave and
come back. A GPU (for example a Google Cloud L4) would cut this to seconds.

In the first 24-answer run, one scorecard came back with invalid criterion entries and
the run stopped at 13/24; a repeat of the same answer was valid. That led to the
constrained schema and temperature 0 above, and to the calibration runner re-asking up to
three times and then skipping (and reporting) an item rather than stopping.

## Training later

This laptop (Ryzen 5 7530U, 15 GB RAM, integrated Radeon graphics, no NVIDIA GPU) can
run 2–4B models but cannot train them in reasonable time. When there is data worth
learning from, the plan is:

1. Export consented interviews and the judge's verified scorecards as training pairs.
2. LoRA fine-tune a small model (for example Qwen3.5 4B) on a rented or free GPU
   (Google Cloud L4, Colab or Kaggle), using the automated checks above as the test set.
3. Export to GGUF, load it in Ollama with a Modelfile, and switch with
   `INTERVIEWER_MODEL` / `JUDGE_MODEL`. Keep it only if the automated checks improve.
