# Evaluator calibration (Phase A5)

Added 25 October 2026. AI scorecards stay labelled "uncalibrated" until this process
shows the AI judge agrees with expert humans. This document covers the tooling; the
ratings themselves need a human panel.

## Gates

| Gate | Target (Phase A) | Statistic |
|---|---|---|
| Human–human agreement | ICC ≥ 0.70 | ICC(1,1), absolute agreement, two ratings per unit |
| AI judge vs human consensus | ICC ≥ 0.60 (Phase C: ≥ 0.75) | ICC(A,1), absolute agreement |
| Unsupported AI claims | < 5% | share of audited AI ratings marked "no" |

A verdict needs at least 30 scored units; otherwise the report says "insufficient
data". Low human agreement means the rubric or anchors are unclear: fix them before
judging the AI. The report also shows quadratic-weighted kappa, exact and within-one
agreement, how often raters agree on "insufficient evidence", the AI's mean bias, and
mean human scores by intended quality as a sanity check.

## Data rules

- Calibration items are JSONL (`calibration/*.jsonl`): id, type, role, difficulty,
  topic, question, answer, `source` (`synthetic`, `licensed` or `consented`), and
  optional `intendedQuality` (never shown to raters).
- `calibration/items.synthetic.v1.jsonl` is a **24-item synthetic starter set** for
  piloting the process: 8 Technical, 8 Behavioural, 8 HR, each set mixing strong,
  adequate, weak and off-topic answers. It was drafted by an AI assistant; review it
  before use. Release decisions need a larger set (the roadmap targets 500 answers)
  of licensed or research-consented real answers.
- **Do not export user interviews into a calibration set.** AI-processing consent
  does not cover human review or evaluation research. That needs its own explicit
  opt-in, which the product does not have yet.
- Rater sheets and results go in `calibration/ratings/` and `calibration/output/`,
  which git ignores. Use pseudonymous rater IDs such as R01.
- Sheets write a UTF-8 BOM and guard formula-like cells, so they open safely in Excel
  or Google Sheets.

## Process

Run from `server/`.

1. **Recruit and brief raters** with [RATER_GUIDE.md](RATER_GUIDE.md). Run a short
   practice round on 3–4 items and discuss disagreements before the real round.
2. **Blind sheets**, one per rater (no AI scores; order shuffled per rater):
   ```sh
   npm run calibration -- template --items ../calibration/items.synthetic.v1.jsonl --rater R01 --out ../calibration/ratings/R01.csv
   ```
   Every unit needs at least two raters.
3. **AI judge run** with the production evaluator (same prompt, rubric and quote
   verification as users get). It sends every item to the configured provider, so it
   first prints a summary and only proceeds with `--yes`. It refuses to run with
   `NODE_ENV=production` or in practice mode.
   ```sh
   npm run calibration -- judge --items ../calibration/items.synthetic.v1.jsonl --out ../calibration/output/model.jsonl --yes
   ```
4. **Evidence audit sheet** (shows the AI's scored ratings, quote and rationale):
   ```sh
   npm run calibration -- audit-template --items ../calibration/items.synthetic.v1.jsonl --model ../calibration/output/model.jsonl --auditor A01 --out ../calibration/ratings/audit-A01.csv
   ```
5. **Report** (Markdown plus JSON; prints each gate's verdict):
   ```sh
   npm run calibration -- report --items ../calibration/items.synthetic.v1.jsonl --ratings ../calibration/ratings/R01.csv,../calibration/ratings/R02.csv --model ../calibration/output/model.jsonl --audit ../calibration/ratings/audit-A01.csv --out ../calibration/output/report.md
   ```
   Input problems (bad scores, unknown IDs, duplicate ratings, evidence quotes not
   found in the answer) are listed in the report rather than silently dropped.

Record each round's item set, rubric version, judge model and prompt version (all in
the report header), and keep reports with the release notes. A rubric or prompt change
starts a new round: scores across versions are not comparable.

## Verification

`server/tests/calibration.test.ts` checks the ICC formulas against the published
Shrout & Fleiss (1979) example, kappa against a hand-computed case, CSV round-trips
(including Unicode and formula-like text), the starter set, blind and shuffled sheets,
rating validation, gate verdicts (pass, fail and insufficient data), handling of
insufficient evidence, the judge run with a stub evaluator, the audit sheet, and the
command line end to end.
