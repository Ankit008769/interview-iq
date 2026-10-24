# Phase A: reliable, evidence-based coaching

Decision date: 24 October 2026. This implementation follows the product sequence
in the founder's 51-page strategy report, with the founder-authorized API-first
change. It does not claim the full Phase A exit gate is complete.

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
| A1 operations | Backups + restore drill, monitoring, shared auth limiter, infrastructure as code | Shared auth limiter, hourly snapshots/restore drill and monitoring policies implemented. Terraform for staging written with import blocks and safety guards, validated offline and in CI; adoption against the live project needs the owner's credentials ([INFRASTRUCTURE_AS_CODE.md](INFRASTRUCTURE_AS_CODE.md)); single VM remains staging |
| A2 metering + A3 API bake-off | Persist attempts and billable usage including rejected outputs; latency/cost report; assess API providers on reviewed examples | Attempt ledger, failed-output token tracking and account summary implemented; cost reconciliation and reviewed bake-off pending |
| A4 expanded coach | Challenge/re-review workflow, grounded rewrites, repeat-aware curated bank and timed rounds | Repeat-aware, difficulty-tagged 108-question practice bank implemented and tested ([QUESTION_BANK.md](QUESTION_BANK.md)); new questions await expert review. Score challenges implemented and tested as a second AI review ([SCORE_CHALLENGES.md](SCORE_CHALLENGES.md)). Grounded rewrites implemented and tested with quote-verified sentences and bracketed prompts ([ANSWER_REWRITES.md](ANSWER_REWRITES.md)). Timed rounds implemented and tested with a server-side clock, soft limits and pause ([TIMED_ROUNDS.md](TIMED_ROUNDS.md)). All A4 slices built; do not claim human review exists yet |
| A5 evaluator calibration | Rater guide, licensed/consented dataset, double ratings, agreement and unsupported-claim audit | Tooling implemented and tested: rater guide, blind sheets, AI judge run, evidence audit, agreement report with gate verdicts, 24-item synthetic starter set ([CALIBRATION.md](CALIBRATION.md)). No human ratings collected yet; scores remain explicitly uncalibrated |

After Phase A: B adds turn-based voice and transcript correction before realtime
voice, resume/JD grounding and Hindi/Hinglish. C adds isolated coding, system design,
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

The expanded suite has 59 backend tests and 14 Chromium tests. Tests pin MongoDB
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
