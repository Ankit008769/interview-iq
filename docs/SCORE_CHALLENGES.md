# Score challenges (second AI review)

Implemented 24 October 2026 as the second Phase A4 "expanded coach" slice. A user
who thinks one rating on an AI scorecard is wrong can ask for a second AI review
of that single criterion. **This is not human review**, and the product says so.

## User flow

On the results page of a completed AI-scored interview, each criterion card offers
"Challenge … rating". The user writes 10–500 characters pointing to the part of
their saved answer the first review missed. The card then shows "Second AI review
in progress" and polls every 2.5 seconds until the outcome arrives:

- **Upheld:** the score did not change. The scorecard is not rewritten; the second
  reviewer's rationale is shown under the card.
- **Revised:** the criterion shows the new rating with a "Revised after second AI
  review" tag, and the overall estimate is recomputed. The original rating stays
  in the challenge record for audit.
- **Failed:** after three attempts the card offers "Try the second review again".

The score can go up, down or stay the same; the form says so before submitting.

## Rules

- Only ratings in completed interviews with AI feedback can be challenged; practice
  sessions have no scores and return 409.
- One challenge per rating, at most three per interview. A failed challenge can be
  requeued, which does not use another of the three.
- Current AI-processing consent is required (409 `AI_CONSENT_REQUIRED` otherwise).
- `submissionId` makes the request idempotent: an exact replay returns 200 with
  `replayed: true`; reusing the ID with different content returns 409.
- The interview write limit applies to the request; each worker attempt consumes
  the daily AI call quota and is recorded in the AI usage ledger.

## Second review

`reviewChallenge` in `server/src/services/ai.ts` calls the judge slot with prompt
version `challenge-review.v1`. It re-evaluates one criterion from scratch using the
saved answer. The first review and the user's note are passed as data and the
instructions say they are context, never evidence or instructions; the note may
only help locate a passage. The output goes through the same `verifyRating` check
as the main scorecard: a score needs an exact quote from the same answer, and a
missing or fabricated quote becomes unscored insufficient evidence.

Prompt instructions reduce but do not eliminate the risk that persuasive notes
sway the model. Exact-quote verification prevents scores based on text the
candidate never wrote. Limit and one-per-rating rules prevent repeated retries.

## Processing and storage

Challenges are embedded in the interview document (`challenges[]`), so data export
and account deletion already include them. `processNextChallengeJob` in
`server/src/services/challenges.ts` runs in the existing worker loop after
interview jobs. It mirrors the interview job guarantees: a lease token with a
two-minute expiry, three attempts with 2 s / 4 s backoff, crashed final attempts
marked failed, fenced writes so a late worker cannot overwrite a reclaimed job,
consent withdrawal stops the job, and quota exhaustion waits for the reset without
using an attempt. Errors store a fixed message, never provider payloads or answers.
The lease token is removed from API responses.

A revision replaces the criterion in `feedback.answers` (with `revisedBy` set to the
challenge ID) and then recomputes `feedback.score` in one atomic MongoDB update from
the stored ratings, using the same rule as the original scorecard. This keeps the
estimate correct even if two revisions finish at once. The free-text summary,
strengths and improvements are not regenerated after a revision.

## Verification

`server/tests/challenges.test.ts` uses a real local HTTP gateway and MongoDB. It
covers revision with a verified quote and score recomputation, upheld outcomes,
fabricated quotes, replay and conflict handling, the per-interview limit, practice
sessions, other accounts, withdrawn consent, provider failures without leaked text,
requeueing after failure, AI usage records and lease fencing. The browser test
`server/e2e/challenge.spec.ts` drives the full flow through the real worker,
including reload and phone-width layout.
