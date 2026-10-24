# Practice question bank

Implemented 24 October 2026 as the first Phase A4 "expanded coach" slice. Version
`2026-10-24.v2` in `server/src/services/questionBank.ts`. It replaces the previous
30-question list, which ignored difficulty and repeated the same questions in the
same order every session.

## Content

108 questions: six topics (DSA, React, Node.js, DBMS, Behavioral, General/HR) ×
three difficulties (Beginner, Intermediate, Advanced) × six questions. All 30
original questions are kept and assigned a difficulty. Each question has a stable
ID such as `node-a2` (topic prefix, difficulty letter, position).

The new questions were drafted by an AI assistant and have **not yet been reviewed
by a human subject expert**. They are common, non-proprietary interview prompts,
not leaked company questions. Review them before marketing the bank as expert
curated, and record the reviewer and date here when that happens. Never edit an
existing ID's meaning: add a new ID instead, so history stays comparable.

Technical interviews use the selected topic when the bank has it (otherwise
General). Behavioral interviews use Behavioral. HR interviews use General.

## Selection

1. The pool is the mapped topic at the requested difficulty.
2. Questions already asked in this session are excluded, by ID and also by text so
   older sessions without IDs are handled.
3. Among the rest, a question this user has not seen in their 30 most recent
   interviews is chosen at random (`crypto.randomInt`).
4. If all have been seen, the least recently seen question is chosen.
5. If the pool is somehow exhausted, the same topic at any difficulty is used.

Saved answers record `questionId`, and interviews record `currentQuestionId`, so
repeat avoidance works across sessions and future analytics can group by question.
Older interviews have no IDs and remain readable. AI mode is unchanged: the model
generates questions and these IDs stay empty.

With six questions per pool and up to five per session, a user's second session at
the same topic and difficulty can only avoid repeats partially. Grow pools after
expert review rather than with unreviewed bulk content.

## Verification

`server/tests/question-bank.test.ts` checks unique IDs and text, at least six
questions per topic/difficulty, topic mapping, difficulty, no in-session repeats
(including text-only legacy turns), preference for unseen then least recently
seen questions, and a MongoDB-backed flow where a returning user's second
three-question session shares no question with the first.
