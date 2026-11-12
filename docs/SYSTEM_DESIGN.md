# System-design board (Phase C3, v1)

Implemented 11 November 2026. Candidates pick one of 30 system-design problems, draw an architecture on an
Excalidraw board, estimate the load it must handle and explain their key decisions. When they submit:
- the app reads the drawing as components and connections and checks the estimates arithmetically;
- the AI interviewer then changes two constraints, one at a time, and asks how the design copes;
- the candidate rates each question's relevance, and the AI reviews the design against a trade-off rubric.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| Excalidraw canvas | Yes: `@excalidraw/excalidraw` 0.18.1 (MIT), loaded only on the design page. Its fonts are served by the app, not a CDN. |
| Shapes converted to a component graph (services, stores, edges, labels) | Yes, by the app (`server/src/design/graph.ts`). |
| Requirement cards | Yes: what it must do, how well, and scale. |
| Capacity-estimate checker | Yes, arithmetic only (`server/src/design/estimates.ts`). |
| Trade-off rubric | Yes: six criteria with verified quotes (`DESIGN_RUBRIC`). |
| "Changing constraints" follow-ups | Yes: two per attempt, from three per problem. |
| 30 calibrated design prompts | 30 prompts. Their reviewer is checked with two independent judges (below), not with human raters. |
| Exit gate: rater agreement on the design rubric ICC ≥ 0.65 | Met between two AI judges: ICC(A,1) 0.91 on 18 synthetic designs after the quote request (0.71 before it; below). Human raters are not used, by the owner's decision. |
| Exit gate: users rate follow-ups ≥ 4/5 | Each follow-up has a 1–5 relevance rating, which is collected. No user ratings exist yet. |

## Problems and requirement cards

`server/src/design/prompts.ts` has 30 problems, from a URL shortener and pastebin to payments, ticket-booking
rushes, live-match comments and a live cricket score. None names a real company. Each problem has:

- **Requirement cards:** what it must do (functional) and how well (non-functional).
- **A scale card:** actors, writes and reads per actor per day, bytes per write and the peak factor, shown
  as plain text (for example "20 million daily active users. Per day, each accounts for about 0.5 links
  created and 10 redirects…").
- **Hidden until submission:** the components such designs usually need, three changing constraints, and
  trade-offs worth probing.

## Drawing and how it is read

The board saves itself about 1.5 seconds after each change (`PUT /api/design/sessions/:id/draft`).

- **What is kept.** Only drawing elements (rectangles, ellipses, diamonds, arrows, lines, text and
  freehand) and the fields needed to redraw them are stored. Images, embeds, links and files are dropped,
  and there are limits on the number of elements and on text length.
- **Body limit.** Drafts may be up to 1 MB. Every other request keeps the 100 KB body limit.

On submission (`sceneToGraph`), the drawing is read as follows:

- **Components.** Each labelled box, ellipse or diamond is a component. A label is the text bound to the
  shape, or text typed on top of it. Unlabelled shapes are counted.
- **Connections.** An arrow or line is a connection when both ends attach to labelled components, either
  through Excalidraw's binding or because the end point lies over a shape. Other arrows are counted as
  dangling. Arrow labels are kept.
- **Notes.** Other text becomes notes.
- **Classification.** Components are classified by keywords in their labels, with the first match
  winning: CDN, load balancer, gateway, cache, queue or stream, search, object storage, relational, NoSQL
  or generic database, real-time, notifications, external provider, monitoring, worker, client, service.

The app then compares the graph with the problem (`analyzeGraph`). It reports a missing client, missing
connections, components connected to nothing, dangling arrows, unlabelled boxes, a database of unstated
kind, and the component kinds such designs usually include. These are observations, not a score. The
candidate sees exactly this reading, and it is all the interviewer sees of the drawing.

## Capacity estimates

The candidate enters three numbers:
- average writes per second;
- peak reads per second;
- new storage per year, with a unit.

The reference values follow from the scale card:
- writes per day ÷ 86,400;
- reads per day ÷ 86,400 × the peak factor;
- writes per day × bytes per write × 365.

Each estimate is "close" within 2×, "right order of magnitude" within 10×, and otherwise "more than 10
times off". The formula is shown after submission. No model is involved.

## Interviewer and review

Prompts are `design-followup.v1` and `design-review.v1`, with the language suffixes from
[LANGUAGES.md](LANGUAGES.md). Both need AI permission and count against the AI quota.

- **Follow-ups.** Two per attempt, using the problem's first two changing constraints in order. The
  question must name one of the candidate's own components, and every `backticked` name must appear in
  their design. Otherwise it is asked again, up to three times. After that, the app asks the constraint
  plainly ("… How would your design change to handle this?") and records `referenced: 'added'`.
- **Answers.** Answers are saved before anything else and cannot be changed afterwards. A second question
  waits for the first answer.
- **Ratings.** Each question can be rated 1–5 for relevance at any time.
- **Review.** Six criteria: requirements and scope, high-level architecture, data model and storage,
  scalability and capacity, reliability and failure handling, and trade-off reasoning. Each gets 0–5 only
  with a quote found verbatim in what the candidate wrote: labels, connections, notes, explanation or
  answers. Without such a quote the criterion gets "not enough evidence". The estimate verdicts and
  observations are given to the judge as facts, and it must not reward naming technologies without
  reasons.

## Measured with the local models

`npm run design-check -- --judges qwen3.5:4b,gemma4:e2b` reviews 21 synthetic designs with each judge:
strong, medium and weak versions for seven problems. Medium versions drop half the components, shorten the
reasoning and give estimates five times off; weak versions are three boxes and "I am not sure". The check
reports each judge's ordering by quality, the agreement between the judges, and how often follow-ups name
the candidate's components.

First full run, 11 November 2026, on the laptop CPU. This was before the quote request described below
was added.

| | qwen3.5:4b | gemma4:e2b |
|---|---|---|
| Mean score: strong / medium / weak designs | 65 / 50 / 0 | 75 / 58 / 0 |
| Pairs ordered correctly by quality (concordance) | 0.85 | 0.96 |
| Spearman correlation with design quality | 0.72 | 0.91 |

- **Agreement between the judges.** ICC(A,1) is **0.71** on the 21 designs, above the roadmap's 0.65.
- **Follow-ups.** Questions written by qwen3.5:4b named the candidate's own components for **7 of 7**
  strong designs.
- **Weak designs.** Every weak design scored 0 with both judges. Each criterion was "not enough evidence",
  because three boxes and "I am not sure" give nothing to quote.
- **qwen's failure mode.** qwen sometimes scored criteria but left every quote empty. The strong pastebin
  design then scored 0, with six criteria and no verifiable quote, and one medium design also scored 0.
  gemma did not do this.

Since then, a scored criterion without a verifiable quote triggers one extra request
(`design-quote.v1`). It asks only for the exact supporting sentences; it cannot change the scores, and the
quotes are still checked word for word.

Rerun with the quote request, 12 November 2026, on the same 21 designs:

| | qwen3.5:4b | gemma4:e2b |
|---|---|---|
| Designs reviewed (the rest returned invalid JSON and failed) | 19 of 21 | 20 of 21 |
| Mean score: strong / medium / weak designs | 90 / 58 / 0 | 83 / 58 / 0 |
| Pairs ordered correctly by quality (concordance) | 0.95 (was 0.85) | 1.00 (was 0.96) |
| Spearman correlation with design quality | 0.90 (was 0.72) | 0.97 (was 0.91) |
| Scored criteria still without a verifiable quote | 10 | 0 |

- **Agreement between the judges.** ICC(A,1) is **0.91** on the 18 designs both judges reviewed, up from
  0.71.
- **The quote request fixed qwen's empty-quote failure.** The strong pastebin design now scores 100 instead
  of 0. Some qwen quotes still do not match the text, and those criteria stay "not enough evidence".
- **Failed reviews.** 3 of the 42 failed because the model returned invalid JSON. In the app the candidate
  sees an error and can retry, and their answers are kept.
- **Follow-ups** again named the candidate's own components for 7 of 7 designs.

Two caveats:
- These are synthetic designs and two small local judges, so this is a consistency check, not a
  measure of accuracy against human interviewers.
- A strong design review takes 1–2.5 minutes with qwen and about 1 minute with gemma on this CPU.

## Data

`design_sessions` stores the drawing, estimates, explanation, the app's reading, follow-ups with answers and
ratings, and the review. It is included in the account export (`designSessions`), deleted with the account
and reconciled on restore. The consent text gains a design line.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/design/prompts` | Problems with the caller's attempts |
| GET | `/api/design/prompts/:id` | Requirement cards, scale card and estimate labels (no answers), recent attempts |
| POST | `/api/design/sessions` | Start an attempt (30 a day) |
| GET | `/api/design/sessions/:id` | One attempt |
| PUT | `/api/design/sessions/:id/draft` | Autosave the drawing, estimates and reasoning while drafting (up to 1 MB) |
| POST | `/api/design/sessions/:id/submit` | Read the drawing, check estimates, reveal expected components and trade-offs |
| POST | `/api/design/sessions/:id/follow-ups` | The next constraint question (two in total) |
| POST | `/api/design/sessions/:id/follow-ups/:index/answer` · `/rating` | Save an answer (once) or a 1–5 relevance rating |
| POST | `/api/design/sessions/:id/review` | The review, after both answers |

## Tests

- `server/tests/design.test.ts`:
  - all 30 problems complete, and the reference estimates;
  - estimate verdicts;
  - reading a scene with bound labels, a label typed on top, bound and geometric arrows, a dangling arrow,
    an unlabelled box, a note and a deleted element;
  - keyword classification and scene sanitising;
  - the full API flow: a drawing larger than 100 KB, submission, consent, re-asked and fallback
    follow-ups, saved answers, ratings, review quote verification and replay, ownership and export.
- `server/e2e/design.spec.ts`:
  - a box drawn and labelled through the real Excalidraw UI is autosaved;
  - estimates, the diagram reading, both follow-ups with a rating, and the review;
  - the console is watched for content-security-policy errors.
