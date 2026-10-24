# Rater guide (rubric version 2026-10-24.v1)

Thank you for rating. Your scores are the reference InterviewIQ uses to check whether
its AI coaching scores can be trusted. Rate honestly and independently: do not discuss
items with other raters until the round is finished.

## What you rate

Each row of your sheet is one **answer × criterion**. Read the question and the whole
answer, then give that criterion a score from **0 to 5**, or **IE** (insufficient
evidence). The sheet shows each criterion's guidance. The same guidance is given to
the AI.

| Score | Meaning |
|---|---|
| 5 | Precise, thorough evidence with relevant specifics and justified decisions |
| 4 | Clear and effective evidence, with minor omissions |
| 3 | Mostly effective evidence, with one meaningful gap |
| 2 | Some relevant evidence, with a substantial gap or weak explanation |
| 1 | Evidence shows a major misconception or a largely ineffective approach |
| 0 | Explicit evidence is incorrect, off-topic or contradicts this criterion |
| IE | The answer does not contain enough to judge this criterion |

**Zero vs IE.** Give 0 when the answer says something wrong or off-topic for this
criterion. Give IE when it simply does not address it. A missing detail is IE, not 0.

## How to rate

1. Rate only what is written. Do not reward what the candidate probably meant, and do
   not penalise for not mentioning something the question did not ask for.
2. Rate each criterion on its own. A wrong answer can still be clearly written;
   a correct answer can still lack trade-offs.
3. For any score from 0–5, paste the **exact words** from the answer that support it
   into `evidence_quote`. Copy them; do not retype. If you cannot point to words, the
   score is probably IE.
4. Use `notes` for anything unclear about the rubric or the item. Those notes improve
   the anchors.
5. Never score grammar, accent, dialect, writing style beyond clarity, or anything
   about the person: their background, gender, name, college or region.

## Criteria at a glance

- **Technical:** correctness, depth of understanding, problem-solving approach,
  trade-off awareness, communication clarity.
- **Behavioural:** situation/task/action/result, personal ownership, impact,
  reflection and learning, relevance.
- **HR:** role understanding, motivation clarity, professional framing, consistency.

## Practicalities

- Scores must be `0`–`5` or `IE`. Leave a row's score blank only if you have not rated
  it yet; blank rows are ignored.
- Do not change `item_id`, `criterion_id` or `rater_id`.
- Items appear in a different order for each rater. That is intentional.
- Expect about one to two minutes per row once you know the rubric.

## Evidence audit (separate sheet)

In an audit round you see the AI's score, quote and rationale. Mark `supported`:

- **yes**: the quote is in the answer and reasonably supports the rationale and score
- **partly**: the quote is relevant but the score or rationale overstates it
- **no**: the quote does not support the rationale, or the rationale claims things
  the answer does not say
