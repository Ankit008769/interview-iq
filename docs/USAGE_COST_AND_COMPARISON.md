# Usage cost and provider comparison (Phase A2/A3)

## Account cost tracking

Every metered text attempt retains an immutable USD cost estimate and the exact rate
entry used (version, source URL, validity interval, provider, endpoint, resolved model,
slot and rates). Rate cards are captured before dispatch; changing configuration does
not reprice existing receipts. Rejected output still incurs estimated cost when the
provider reported its tokens. Transport failures, interrupted attempts and historical
unpriced receipts remain unknown. Consent cancellation before dispatch is zero cost.

The account page shows the last 30 days of owner-only usage: known estimated subtotal
and unknown-cost attempt count. The subtotal is incomplete when that count is nonzero.
Exports include the cost snapshot. Normal account deletion removes these usage records.
This is not an invoice and excludes taxes, credits, provider overhead and unreported
charges. USD amounts are rounded to 12 decimal places internally (six in the UI).

No current market prices are hardcoded or enabled by this milestone. Operators set
`AI_RATE_CARD_JSON` to a JSON array of reviewed rates, or leave it `[]` for unknown.
Each entry requires:

- `version`, `provider` (`openai` or `compatible`), `endpoint` (exact configured base URL),
  `model` (exact resolved model ID), `slot` (`interviewer` or `judge`), `source` URL.
- `validFrom`, `validUntil`: ISO UTC timestamps; the interval is inclusive/exclusive.
- `inputUsdPerMillion`, `outputUsdPerMillion`, optional `cachedInputUsdPerMillion`.

Validate the applicable provider pricing and billing units before setting rates.
Overlapping entries, malformed values and negative rates fail startup. Expired rates,
unmatched model aliases or gateways, and missing token usage do not produce a price.
Reported cached tokens use the cached rate; if absent, that attempt stays unknown.
When the provider omits cache details, input is estimated at the ordinary input rate.
Tiered, batch, regional, tool-call or other non-token fees are not modeled. **Audio
cost remains unknown**: transcribers can bill by duration or distinct audio token
classes, which must not be priced using generic text-token rates.

## Scoped invoice reconciliation (offline)

Use an owner export or an authorized usage-only JSON array. Match the exact account,
provider, resolved model and UTC interval to an operator-supplied **USD subtotal**;
do not compare one user's receipts against a whole-project invoice. The explicit
scope assertion is required. The command never modifies receipts or imports secrets.

From `server/` (the output directory must already exist):

```sh
npm run comparison -- reconcile --usage /private/usage.json --provider openai --model EXACT_RESOLVED_MODEL --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z --billed-usd 1.25 --scope-matched --out ../calibration/output/reconciliation.json
```

The billed amount above is an illustrative operator input, not a provider price.
The report gives matching attempts, partial estimated subtotal and missing-cost count.
The billed-minus-estimated difference is null if any matching costs are unknown.
Duplicate receipt IDs and empty scopes are rejected. Matching totals alone do not
prove an invoice is correct: review discounts, missing receipts and other charges.

## Repeatable evaluator comparison

The runner uses the production one-answer evaluator and evidence verifier against the
same calibration items for each configured provider/model. It runs sequentially,
without hidden retries, and checkpoints after each item. No account interviews are
exported or transmitted by this tool. Use only reviewed synthetic, licensed or
explicitly research-consented items; ordinary AI processing consent is insufficient.

Set provider credentials in the process environment; never in CLI arguments, datasets
or reports. This CLI deliberately does not read the production `.env`. Practice mode
cannot run a benchmark. Production-mode execution is refused. Each invocation uses
one configured provider, avoiding implicit fan-out or fallback.

```sh
# Configure AI_PROVIDER, provider credentials, JUDGE_MODEL and INTERVIEWER_MODEL first.
# Default dry run makes no calls. Default cap is 25 items; larger reviewed sets need --max-items.
npm run comparison -- run --items ../calibration/items.synthetic.v1.jsonl --label candidate-a --out ../calibration/output/a.json
# After reviewing the dataset and accepting the disclosed paid provider calls:
npm run comparison -- run --items ../calibration/items.synthetic.v1.jsonl --label candidate-a --out ../calibration/output/a.json --reviewed --yes
# Change provider/model configuration; run the identical dataset with label candidate-b and out b.json.
npm run comparison -- report --runs ../calibration/output/a.json,../calibration/output/b.json --out ../calibration/output/comparison.json
```

Run files retain dataset hash, ordered item IDs, requested/resolved models, rubric and
prompt versions, timestamps, reported tokens, cost/rate version, latency, failures and
verified evidence coverage. New runs also retain criterion scorecards, including
exact evidence quotes and rationales, to reuse the same responses for human calibration.
They omit a separate input-answer field, audio, provider errors and credentials, but
quotes may contain the entire answer. Treat these private research artifacts like the
dataset itself; do not publish them or commit them to Git.
Outputs belong in ignored `calibration/output/`, not Git. Existing output paths are
refused. An interrupted run remains partial and is rejected by the comparison command;
rerun to a new path (paid calls can recur). Successful rows have priced or unknown costs;
failed benchmark calls conservatively retain unknown usage/cost, even if the provider
may have billed them. Their latency and failures remain in the denominator.

Comparison rejects mismatched dataset/rubric/prompt versions, duplicate labels/items
and missing rows. It reports nearest-rank p50/p95 latency, failures, token and cost
coverage, rate versions and supported-quote counts. **Quote coverage is not semantic
accuracy. No automatic best-provider verdict is issued.** Use the human ratings and
unsupported-claim audits in [CALIBRATION.md](CALIBRATION.md) for the quality gate.
Model order, provider load, dataset size and warm/cold caches affect results; repeat
counterbalanced runs before making a deployment choice.

### Reuse comparison responses for calibration

Export each candidate separately; this performs no provider calls:

```sh
npm run comparison -- export-calibration --items ../calibration/items.synthetic.v1.jsonl --run ../calibration/output/a.json --out ../calibration/output/a-model.jsonl
```

The export requires a reviewed, complete successful run with matching dataset hash,
item IDs, rubric, model/prompt metadata and every expected criterion. Older run files
without retained scorecards and partial/failed runs cannot be exported. Their cost
and failure reports remain usable; do not discard failures to improve a quality score.
Use the exported file as `--model` for calibration audit sheets and reports. Make a
separate evidence audit for each candidate: fingerprints bind each review to its
exact score, rationale, quote, model and dataset. Human scoring sheets stay blind
and can be shared across candidates only for the identical frozen dataset.

## Verification and remaining gates

Tests exercise cached-token math, expiry/model/endpoint matching, failed-output
pricing, unknown historical usage, owner isolation, billing-window boundaries,
duplicate receipts, report compatibility, checkpointed failures, dry-run safety and
two real HTTP calls to a local test gateway. Browser coverage checks partial-cost
labelling alongside the account, interview, coaching and voice regressions.

No paid live comparison, provider invoice reconciliation, human review or transcription
accuracy benchmark was performed by these tests. Those remain empirical Phase A/B
release gates. Email stays disabled; production rate cards and providers are unchanged.
