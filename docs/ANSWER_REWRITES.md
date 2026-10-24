# Grounded answer rewrites

Implemented 24 October 2026 as the third Phase A4 "expanded coach" slice. On an
AI-scored results page, each answer offers "Show a stronger version of this answer":
a clearer, better-structured version built only from what the candidate wrote.

## What the user sees

- A short summary of what the stronger version changes.
- Ordered sentences. Each one shows "From your answer: “…”" with the exact words it
  restates.
- Missing pieces as dashed "Add only if true: [Add the measurable result, if you
  have one]" prompts. The product never writes the missing content itself.

One rewrite is kept per answer. Asking again returns the saved one with
`replayed: true` and no new AI call.

## Grounding rules

`rewriteAnswer` in `server/src/services/ai.ts` calls the judge slot with prompt
version `answer-rewrite.v1`. The model returns parts of two kinds:

| Kind | Must contain | Server check (`verifyRewrite`) |
|---|---|---|
| `answer` | a restated point plus the exact supporting quote | quote must be nonblank and found verbatim in the same answer; offsets are stored. Otherwise the part is dropped |
| `addition` | one bracketed prompt such as `[Add the trade-off you considered]` | must be a single `[…]` prompt; anything else (for example "Latency dropped by 40%") is dropped |

If no `answer` part survives, nothing is stored and the request returns 502 with a
retry message. The number of dropped parts is saved as `dropped` for auditing.

**Limitation:** the quote proves where a point came from, not that the restated
sentence adds nothing. A model could still paraphrase a quote into a stronger
claim. Showing the source quote under every sentence lets the candidate check, and
the prompt forbids new facts, numbers, names, tools, results and experiences.

## API

`POST /api/interviews/:id/rewrites` with `{ questionIndex }`.

- 201 with the interview (now including `rewrites[]`) on success; 200 `replayed`
  when that answer already has one.
- 409 when the interview is not completed, is a practice session, the answer has no
  AI ratings, or current AI-processing consent is missing (`AI_CONSENT_REQUIRED`).
- 502 when the provider fails or nothing grounded comes back. Provider text is never
  returned or logged; `answer_rewrite_failure` is emitted as a WARNING event.
- Counts against the interview write limit and the daily AI call quota, and every
  attempt is recorded in the AI usage ledger by the provider layer.

The call is synchronous (up to the provider's 25-second timeout) because nothing the
user submitted is at risk: the answer is already saved. Two simultaneous first
requests may both call the provider; the first saved result wins and is returned
to both. Rewrites are embedded in the interview, so export and deletion include them.

## Verification

`server/tests/rewrites.test.ts` (real local HTTP gateway and MongoDB): the verifier
rules, a grounded rewrite with offsets, provenance and usage, replay without a new
call, dropped invented sentences and fact-stating prompts, nothing stored on
ungrounded output or provider failure, retry afterwards, practice sessions, missing
answers, invalid input, other accounts and withdrawn consent.
`server/e2e/rewrite.spec.ts` drives the browser flow, reload and phone-width layout.
