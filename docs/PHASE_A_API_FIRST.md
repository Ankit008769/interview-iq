# Phase A: reliable, evidence-based coaching

Decision date: 24 October 2026. This implementation follows the product sequence
in the founder's 51-page strategy report, with the founder-authorized API-first
change. It does not claim the full Phase A exit gate is complete.

> **Update, 25 October 2026:** scoring is AI-only (no human raters), and questions are
> generated fresh by local, pretrained open models (`AI_PROVIDER=local`, Ollama with
> Qwen3.5 4B; Gemma 4 E2B as a second judge for automated checks). Hosted APIs remain
> available through the same provider boundary. Training is deferred until there is data
> and a GPU. See [LOCAL_MODELS.md](LOCAL_MODELS.md); this supersedes the A5 human-rater
> plan and the API-first default below.

## Decisions

- Preserve the MERN app, atomic answer/job writes, lease fencing, owner checks,
  quotas and private Google Cloud staging.
- Use hosted model APIs first, behind a replaceable `ModelProvider` interface.
  OpenAI Responses remains the existing provider; a separate chat-completions
  adapter supports explicitly configured compatible gateways. No GPU deployment
  or training job is needed for this milestone.
- Keep interviewer and evaluator model slots separate. The existing model default
  is retained for compatibility, not declared the best model. Compare candidates
  on a reviewed evaluation set before changing production defaults.
- Make evidence, reproducible rubric definitions and reviewed evaluation data the
  near-term product advantage. Hosting location alone does not establish quality.
- Do not promise offline operation, India-only model processing, legal compliance,
  a particular cost saving, or benchmark performance while using external APIs.
  The report's projections and release dates remain planning assumptions.
- Fine-tuning and self-hosting become optional experiments after quality, privacy
  requirements, traffic and total operating cost justify them. Google Cloud credits
  do not automatically fund an external OpenAI account.

## Milestones and acceptance gates

| Milestone | Work | Gate / status |
|---|---|---|
| A1 delivery checkpoint | Preserve remote Git history, push Phase 0, execute GitHub CI | Complete: baseline run 40016222354 passed |
| A2 provider boundary | OpenAI + compatible adapters, independent model slots, schema validation, timeout, no hidden retries, provenance | Implemented; tested with mocked Responses and a real local HTTP gateway |
| A4 scorecard foundation | Technical/Behavioral/HR rubric snapshots, 0–5 ratings, exact quote checks, offsets, insufficient evidence, result highlighting | Implemented; automated contract and browser checks |
| A1 account/privacy | Revocable sessions, password recovery, verified email, export/deletion, clear provider disclosure and consent | Account flows and versioned provider consent/disclosure implemented/tested; live application email remains disabled |
| A1 operations | Backups + restore drill, monitoring, shared auth limiter, infrastructure as code | Shared auth limiter, hourly snapshots/restore drill and monitoring policies implemented. Terraform for staging written with import blocks and safety guards, validated offline and in CI, and adopted into private remote state with 29 imports and zero resource changes ([INFRASTRUCTURE_AS_CODE.md](INFRASTRUCTURE_AS_CODE.md)); single VM remains staging |
| A2 metering + A3 API bake-off | Persist attempts and billable usage including rejected outputs; latency/cost report; assess API providers on reviewed examples | Attempt ledger, failed-output token tracking and account summary implemented; versioned cost estimates, scoped invoice reconciliation and repeatable comparison tooling implemented ([USAGE_COST_AND_COMPARISON.md](USAGE_COST_AND_COMPARISON.md)); actual invoice validation and reviewed live bake-off pending |
| A4 expanded coach | Challenge/re-review workflow, grounded rewrites, repeat-aware curated bank and timed rounds | Repeat-aware, difficulty-tagged 108-question practice bank implemented and tested ([QUESTION_BANK.md](QUESTION_BANK.md)); new questions await expert review. Score challenges implemented and tested as a second AI review ([SCORE_CHALLENGES.md](SCORE_CHALLENGES.md)). Grounded rewrites implemented and tested with quote-verified sentences and bracketed prompts ([ANSWER_REWRITES.md](ANSWER_REWRITES.md)). Timed rounds implemented and tested with a server-side clock, soft limits and pause ([TIMED_ROUNDS.md](TIMED_ROUNDS.md)). All A4 slices built; do not claim human review exists yet |
| A5 evaluator calibration | Rater guide, licensed/consented dataset, double ratings, agreement and unsupported-claim audit | Tooling implemented and tested: rater guide, blind sheets, AI judge run, evidence audit, agreement report with gate verdicts, 24-item synthetic starter set ([CALIBRATION.md](CALIBRATION.md)). No human ratings collected yet; scores remain explicitly uncalibrated |

After Phase A: B adds turn-based voice and transcript correction before realtime
voice, resume/JD grounding and Hindi/Hinglish. B1 turn-based voice and read-aloud are
implemented and tested ([VOICE_ANSWERS.md](VOICE_ANSWERS.md)); transcription accuracy
is not yet measured. B3 v1 resume/JD grounding (pasted text, verified source lines, complete
deletion of derived questions) is implemented and tested ([RESUME_JD_GROUNDING.md](RESUME_JD_GROUNDING.md));
question relevance is not yet rated. B4 v1 delivery feedback (pace and precision-first filler counts from voice
transcripts, with an off switch) and quote-verified STAR checks are implemented and tested
([DELIVERY_AND_STAR.md](DELIVERY_AND_STAR.md)); filler precision on real transcripts is not yet measured. C adds isolated coding, system design,
project defense and adaptive practice; training is conditional. D adds campus tools,
billing and an optional offline client. E covers scale and research after usage
justifies it. Employer assessment remains a separate, reviewed product decision.

## Provider configuration

`AI_PROVIDER=practice|openai|compatible`. When unset, existing behavior is preserved:
an `OPENAI_API_KEY` selects OpenAI, otherwise practice mode. Explicit selection
fails on invalid or missing credentials at startup. An existing AI session never
silently downgrades to practice when configuration disappears.

OpenAI uses `OPENAI_API_KEY`, optional `INTERVIEWER_MODEL` and `JUDGE_MODEL`, falling
back to `AI_MODEL` and then the previous `gpt-4o-mini` default. Responses requests
set `store:false`; that setting is not a claim of zero retention or India residency.

Compatible gateways require `LLM_BASE_URL`, explicit `INTERVIEWER_MODEL` and
`JUDGE_MODEL`, and `LLM_GATEWAY_TOKEN` for remote endpoints. HTTPS is mandatory
outside loopback; credentials in URLs are rejected. They must support strict
JSON-schema chat-completions output. No automatic provider failover or transcript
fan-out is implemented. Choose and evaluate a provider deliberately.

Each request has a 25-second timeout and zero SDK retries. The existing durable
worker owns retry/backoff and AI call quotas. Requests have output-token caps
(800 for questions, 8,000 for a full scorecard); all saved answers, up to the
existing 3,500 characters each, are passed without silent truncation. The provider
must support the resulting context size. Refusal, invalid schema, timeout or
truncated output fails the attempt and retains the saved answer for recovery.

Successful outputs store provider, resolved model ID, prompt version, SHA-256 input
hash, token counts when supplied, and elapsed milliseconds. Question metadata is
copied into the saved turn; feedback stores its rubric snapshot and metadata.
No candidate answers or provider error payloads are logged by the provider layer.

## Evidence contract

The model returns one entry per saved answer and one rating per rubric criterion.
Scores are integers 0–5 or null. Unknown/duplicate/missing references and out-of-scale
scores reject the response. Each non-null score requires a nonblank exact quote
from that same answer. The server computes start/end offsets in JavaScript UTF-16
code units, matching the browser's `slice`; end is exclusive.

An absent or fabricated quote becomes `insufficient_evidence`, with null score,
null evidence, null suggestion and a fixed explanation. A missing observation is
not scored as zero. Aggregate score is the equal-weight mean of supported ratings,
mapped to 0–100 for the existing dashboard, only when at least half of all ratings
are supported. Unscored criteria are excluded. Old reports remain readable and
are not silently re-evaluated; changes in rubric/model make scores non-equivalent.
The dashboard's historical average still mixes versions, so it must not be used
as a measured learning-gain claim until the analytics milestone separates them.

Exact quote matching verifies provenance, not whether the quote logically supports
the rationale or rating. Expert calibration and semantic support review are still
required. The UI makes this limitation explicit. It renders all model and candidate
text as text, never HTML, and allows keyboard-operable evidence highlighting.
Practice reports display the rubric as a self-review guide without fake scores.

## Verification and limits

Local tests cover provider config, no silent fallback, no hidden retries, secret-safe
errors, Responses request options, complete-answer context, HTTP gateway integration,
persisted scorecards, exact offsets including emoji, fabricated quotes, bad references,
different rubrics, account isolation and mobile browser highlighting.

The 25 October continuation passes both production builds, 117 backend tests and
22 Chromium tests, including voice cancellation, microphone cleanup, transcript
overflow recovery and a consent-withdrawal race before audio dispatch. Tests pin MongoDB
8.2.6 and its cache path explicitly, avoiding accidental downloads when invoked
from a different directory. This is not a compatibility claim for every MongoDB
release; staging currently uses MongoDB 7. CI installs only Chromium's headless
shell and bounds dependency-install/job time.

No paid live model call, provider-quality benchmark, evaluator agreement measurement,
training run or GPU provision is part of this milestone. Staging remains on the
previous image until this version is explicitly deployed; its practice mode needs
no vendor key. Keep credentials in environment/Secret Manager, never in Git or chat.

Implementation reference: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

Account lifecycle, session migration and usage semantics: [ACCOUNT_AND_USAGE.md](ACCOUNT_AND_USAGE.md).
Live backup policy, restore evidence and promotion checklist: [BACKUP_RESTORE.md](BACKUP_RESTORE.md).
Monitoring and provider consent: [MONITORING_AND_CONSENT.md](MONITORING_AND_CONSENT.md).
The full Phase A quality and evaluator-calibration exit gate remains open.


## Continuation checkpoint - 25 October 2026

Reviewed the six implementation commits through `1267b79` and the uncommitted B1
voice slice. Existing question-bank, challenge, rewrite, timing, calibration and
Terraform work is preserved. B1 now handles cancellation and navigation cleanup,
ignores stale results, prevents submission during voice processing, preserves long
transcripts for correction, and rechecks consent immediately before audio dispatch.
Commit `c9bcf44` is deployed as `interview-iq-cost-voice-c9bcf44`. Live verification
passed 18 API groups and 6 Chromium groups; application email remains disabled.
Paid AI and transcription remain unconfigured, so their live quality is not validated.

Next sequence:

1. A2/A3 cost tracking and comparison tooling are implemented. Configure reviewed rates
   and run the live comparison on reviewed items; reconcile an actual matching invoice
   subtotal before claiming validated unit economics.
2. Collect independent human ratings using the A5 toolkit. Synthetic examples and
   passing software tests cannot establish evaluator quality.
   Comparison runs now export their exact scorecards without another provider call.
   Calibration rejects duplicate/unrelated reviews and mismatched provenance, and
   separates pilot statistics from the 500-real-answer release gate. Provider
   credentials and human ratings are deferred at the founder's request; no paid
   comparison, candidate selection or calibrated-quality claim has been made.
3. Terraform remote state and import-only adoption are complete: 29 imported, zero
   resource changes, and a fresh post-adoption plan with no changes. State is private
   and versioned. See [INFRASTRUCTURE_AS_CODE.md](INFRASTRUCTURE_AS_CODE.md).
4. Measure B1 transcription quality and latency on consented Indian English and
   Hinglish examples before progressing to real-time B2 voice. B3 v1 resume/JD grounding
   is implemented; rate tailored-question relevance (B3 gate: at least 80% relevant)
   with the A5 rater process before claiming it.

Application email stays disabled. No paid provider was enabled during this review.
The existing backup failure and three-hour freshness policies were verified enabled;
the freshness metric now has real post-creation successful snapshot samples.
