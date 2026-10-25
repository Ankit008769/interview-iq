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

## Automated check results (25 October 2026)

24 synthetic items (8 Technical, 8 Behavioral, 8 HR; 7 strong, 8 adequate, 6 weak,
3 off-topic), local CPU runs: Qwen3.5 4B 25 minutes, Gemma 4 E2B 19 minutes, no invalid
scorecards after the constrained schema.

| Gate | Qwen3.5 4B | Gemma 4 E2B | Threshold | Verdict |
|---|---|---|---|---|
| Pairwise ordering of known-quality answers | 0.83 | 0.92 | ≥ 0.80 | pass, pass |
| Spearman with intended quality | 0.77 | 0.89 | ≥ 0.60 | pass, pass |
| Agreement between the judges, item scores ICC(A,1) | 0.88 | | ≥ 0.60 | pass |

Mean item score (0–5) by intended quality: Qwen strong 4.11, adequate 2.42, weak 0.17,
off-topic 0.00; Gemma 4.36, 2.22, 0.17, 0.00.

**Caveat:** the judges agree on how good an answer is overall, but not on individual
criteria. Where both rated the same criterion (45 cases) the quadratic-weighted kappa is
−0.01, and in 18 more cases only one of them found enough evidence. Per-criterion scores
from a 4B model should be read as rough coaching signals; the overall score is the more
reliable number. Synthetic answers are also easier than real ones.

## Running on Google Cloud (staging)

Chosen 25 October 2026: a **CPU sidecar** in the existing Cloud Run service in Mumbai
(asia-south1). Cloud Run L4 GPUs in Mumbai are invitation-only; a GPU in Singapore was
the faster but out-of-India alternative.

- `deploy/ollama/Dockerfile` builds Ollama 0.40.11 (pinned by digest) with
  `qwen3.5:4b` baked in, a 16K context and the model kept loaded. The app reaches it on
  `127.0.0.1:11434`. It binds all interfaces inside its container because Cloud Run's
  startup probe cannot reach a loopback-only server (the first rollout failed exactly that
  way); sidecar ports are not exposed outside the instance, since only the app container
  receives requests.
- The app container runs with `AI_PROVIDER=local` and starts after the sidecar's
  startup probe (`GET /api/version`) passes. Sidecar: 6 vCPU, 8 GiB; app: 1 vCPU,
  512 MiB (Cloud Run allows 8 vCPU per instance in total). Instance billing and one
  always-on instance stay as before, so the cost is continuous.
- `GET /api/health` reports `model: "ready"` once both configured models are installed,
  without changing the status code.
- Terraform declares the sidecar (`model_image`, `model_cpu`, `model_memory`,
  `app_container_name`); releases still own the app image and environment.

**Current (25 October 2026, 14:36 UTC):** revision `interview-iq-learning-1d439c7` serves 100% of traffic
with app `interview-iq:1d439c7` (`sha256:dbba319c7e5ae67f47e6e58efd08e9e3dbcb58a265e19027499331e15df8d31b`: adaptive learning, daily drills, study plans and
interview styles, see [ADAPTIVE_LEARNING.md](ADAPTIVE_LEARNING.md)) and the same Ollama and speech containers;
rollback `interview-iq-visibility-5926cbd`.

**Previous (11:58 UTC):** revision `interview-iq-visibility-5926cbd` served 100% of traffic
with app `interview-iq:5926cbd` (`sha256:45d7117bca83ca3b9e0a83cbf252a76fe59bbb0afaa0cf52c8f6b6cc8c02e683`: dashboard "New in AI interviews" panel, AI on by default in setup,
clearer permission prompts) and the same Ollama and speech containers; rollback `interview-iq-voice-9ae0c55`.

**Previous (11:32 UTC):** revision `interview-iq-voice-9ae0c55` served 100% of traffic:
app `interview-iq:9ae0c55` (`sha256:98d7984dbf0039828f0df7b96e5f7fef49780d987ea58c21a3674f9d3c791933`), Ollama `interview-iq-ollama:0.40.11-qwen3.5-4b-v2` (6 vCPU) and
speech-to-text `interview-iq-whisper:1.2.1-small` (`sha256:3f2237cdb419d9987bfc2834a3487c543554031a343f0775d9603c53eb953310`, 1 vCPU); `/api/health` reports model and voice
ready. Voice answers are on (see [VOICE_ANSWERS.md](VOICE_ANSWERS.md)). Rollback revision
`interview-iq-languages-2a4cc85`. Releases now use `deploy/prepare-release.mjs` (candidate, then restore).

**Previous (10:50 UTC):** revision `interview-iq-languages-2a4cc85` served 100% of
traffic with app image `interview-iq:2a4cc85`
(`sha256:aef7d5fa89266ff129e2c345a950363a5cc8d3a6ca9bb4df110f5d0646e2745b`: adds Hindi and Hinglish
interviews, see [LANGUAGES.md](LANGUAGES.md)); rollback revision `interview-iq-feedback-faa10f2`.

**Previous (10:23 UTC):** revision `interview-iq-feedback-faa10f2` served 100% of
traffic with app image `interview-iq:faa10f2`
(`sha256:770880464627defa3f8a839b4d2c88f597021b7da0a48f0d5e814c9e3c2e9218`: per-answer verdicts,
key points and tips, overall AI feedback, always-present score) and the same model image; rollback
revision `interview-iq-local-models-v2-4d88c97`. App-only releases reuse the same candidate steps
with a manifest that changes only the app image, `DEPLOYMENT_COMMIT` and the revision name.

**First deployed 25 October 2026:** revision `interview-iq-local-models-v2-4d88c97`, 100% of
traffic, app image `interview-iq:4d88c97`
(`sha256:e9f8599d41011a007db50c94ff643132670c7b289db625b7e76e5b4959c6fca5`), model image
`interview-iq-ollama:0.40.11-qwen3.5-4b-v2`
(`sha256:541e62d83925b6577194a82e119b07570d3c0e39d68510ce2a4a8e4df1b39262`). Rollback revision:
`interview-iq-cost-voice-c9bcf44` (practice mode). In Cloud Run the model server started in
about 49 s and `/api/health` reported `aiMode: ai, model: ready`.

Rollout (needs a signed-in `gcloud`; from the repository root). Builds run as the
`interviewiq-build` service account with Cloud Logging only, as earlier deploys did:

```
# Cloud Build config per image: one docker build step, images: [IMAGE],
# options: { logging: CLOUD_LOGGING_ONLY, machineType: E2_HIGHCPU_8 }, timeout 3600s for the model
gcloud builds submit deploy/ollama --region=asia-south1 --config=cb-model.yaml --service-account=projects/PROJECT/serviceAccounts/interviewiq-build@PROJECT.iam.gserviceaccount.com
gcloud builds submit . --region=asia-south1 --config=cb-app.yaml --service-account=...same...
gcloud run services describe interview-iq --region=asia-south1 --format=json > live.json
node deploy/add-model-sidecar.mjs --in live.json --out next.json --revision interview-iq-local-models-SHA --model-image MODEL_IMAGE --app-image APP_IMAGE --commit FULL_SHA
# in next.json, for the check only: metadata.annotations["run.googleapis.com/maxScale"] = "2"
# and add {"revisionName": "interview-iq-local-models-SHA", "tag": "candidate"} to spec.traffic
gcloud run services replace next.json --region=asia-south1
curl https://candidate---<service host>/api/health      # expect aiMode "ai" and model "ready"
gcloud run services update-traffic interview-iq --region=asia-south1 --to-revisions=interview-iq-local-models-SHA=100 --remove-tags=candidate
# then set the service maxScale back to "1" with a describe/replace of the same template (no new revision)
```

Two lessons from the first attempt:

- **The service allows one instance** (service-level min 1, max 1), so a candidate revision
  cannot start while the old one holds it. Raise the service maximum to 2 for the check,
  then restore it.
- **Cloud Run's startup probe cannot reach a loopback-only server.** The first model image
  bound `127.0.0.1` and its probe failed 60 times; the `-v2` image binds `0.0.0.0` inside
  the container. No traffic reached the failed revision.

`deploy/add-model-sidecar.mjs` also raises the request timeout to 600 s (first questions,
rewrites and STAR checks wait on the CPU model), updates `DEPLOYMENT_COMMIT` and drops
annotations left by earlier source builds. Roll back with `update-traffic --to-revisions=
interview-iq-cost-voice-c9bcf44=100`.

## Training later

This laptop (Ryzen 5 7530U, 15 GB RAM, integrated Radeon graphics, no NVIDIA GPU) can
run 2–4B models but cannot train them in reasonable time. When there is data worth
learning from, the plan is:

1. Export consented interviews and the judge's verified scorecards as training pairs.
2. LoRA fine-tune a small model (for example Qwen3.5 4B) on a rented or free GPU
   (Google Cloud L4, Colab or Kaggle), using the automated checks above as the test set.
3. Export to GGUF, load it in Ollama with a Modelfile, and switch with
   `INTERVIEWER_MODEL` / `JUDGE_MODEL`. Keep it only if the automated checks improve.
