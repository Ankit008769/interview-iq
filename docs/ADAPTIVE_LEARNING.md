# Adaptive learning (Phase C5, v1)

Implemented 25 October 2026. The **Learn** page turns AI-scored interviews into skill
estimates and picks one short drill a day: a skill due for a spaced retest, a first
estimate for an area never practised, or the skill with the lowest plausible level. A
study plan with an interview date focuses the drills. Setup also offers interview
**styles** (product company, IT services, startup) that change how AI questions are asked.

What this version does **not** do yet, and why:

- **No item response theory (IRT) calibration.** A 2PL model needs many learners'
  responses to the same items to estimate item difficulty and discrimination. Questions
  are freshly generated for every candidate, so items never repeat across learners.
  Question difficulty is the level chosen for the interview (Beginner, Intermediate,
  Advanced), applied as a fixed offset.
- **No learning-gain study.** The roadmap's measure of success (improvement compared with
  learners who practise without adaptive drills) needs real learners over several weeks.
  The page says plainly that estimates are coaching estimates from an AI judge and have
  not been validated against learner outcomes.
- **No hiring prediction.** Readiness is an average of uncertain skill estimates, not a
  probability of passing an interview, and the page says so.

## Skills

`server/src/learning/skills.ts` defines 20 skills:

- **Topic skills**: DSA, React, Node.js, Databases (technical interviews on those topics),
  Behavioral stories and HR and career questions. A technical interview on another topic
  updates the competencies only.
- **Competency skills**: one per rubric criterion (5 technical, 5 behavioral, 4 HR), so
  every scored answer informs them.
- **Foundations** link skills: depth and approach build on correctness, trade-offs on
  depth, ownership, impact and reflection on STAR structure, motivation on role
  understanding.

## Estimates

`server/src/learning/model.ts`. Each skill is a Gaussian belief on the 0–5 rubric scale
(prior mean 2.5, standard deviation 1.5) updated with a one-dimensional Kalman filter:

- **One observation per skill per interview**: the average of that skill's ratings across
  the interview's answers. Answers in one interview share a day and a judge, so they are
  not treated as independent evidence. A criterion with no evidence in an answer counts
  as 0, exactly as it does in the interview score; when every rating for the skill in
  that interview is "insufficient evidence", the observation is a 0 with double the
  noise (less certain).
- **Difficulty**: Beginner evidence counts 0.5 lower and Advanced 0.5 higher, clamped to 0–5.
- **Observation noise** 1.0 (variance of one rubric average around true ability).
- **Forgetting**: variance grows by 0.01 a day without practice, up to the prior, so an old
  estimate shows a wider range. The mean does not change.
- **Levels**: below 1.5 Needs work, below 2.5 Developing, below 3.5 Proficient, else
  Strong. "Low confidence" is shown while the standard deviation is above 0.8 (one
  interview on that skill).
- **Readiness**: 20 × the average over the focus areas' competencies of (estimate − one
  standard deviation), floored at 0. Uncertainty lowers it.

### Rebuilt from interviews, never patched

Skill states (`skill_states`) are a cache. `refreshSkills` replays the learner's AI-scored
interviews (the 500 most recent) in completion order and writes every skill in one bulk
upsert. This keeps estimates exact when a score changes later:

- the interview worker rebuilds right after an AI-scored interview completes;
- a second review that revises a rating rebuilds as well;
- opening Learn rebuilds if any scored interview changed after the last rebuild (for
  example a rebuild that failed and logged `skill_update_failure`).

Each state stores `basisAt`, the newest interview update the replay saw. A write only
replaces a state with an older or equal basis, so a slower rebuild that started before a
newer one can never overwrite it. Practice-mode interviews have no AI scores and are not
used.

## Spaced retests

Each skill also has an FSRS card (`ts-fsrs` 5.4.2, no fuzz, no same-day learning steps).
Every interview that informs a skill is one review, graded from that interview's average
evidence for the skill: below 1.5 Again, below 2.5 Hard, below 4 Good, otherwise Easy.
Strong results push the next retest further away; weak results bring it back within a
day or so. The replay recreates cards exactly, so they follow revised scores too.

## Choosing today's drill

`selectDrill` in `server/src/services/learning.ts`, over the plan's focus types (all
three without a plan):

1. **Spaced retest**: practised skills whose card is due, lowest lower bound first.
2. **First estimate**: a focus type with no practice yet gets a short drill on its topic
   skill (DSA first for technical).
3. **Lowest estimate**: otherwise the practised skill with the lowest lower bound
   (estimate − 1.96 SD), so an uncertain estimate is measured again before a confident
   one that is only slightly lower.
4. **Foundation first**: if the chosen skill has a foundation that is practised, below 2.5
   and weaker than it, the drill moves to the foundation (up to three steps, for example
   trade-offs → depth → correctness).

The drill is an ordinary AI interview with `purpose: 'drill'`:

- type from the skill; topic from a topic skill, or the weakest practised technical topic
  for a technical competency;
- difficulty from the estimate (below 2 Beginner, below 3.5 Intermediate, else Advanced);
- length from the plan: 10 minutes → 2 questions of 3 minutes, 20 → 3 of 5, 30 → 4 of 5
  (2 of 3 without a plan);
- `focusSkills`: the skill, plus the type's weakest competency for a topic drill (at most
  two, and they must match the interview type);
- role: the learner's most recent interview role.

Any skill in the list can also be practised on demand (`GET /api/learning/drill?skillId=`).
Drills need AI mode; when the server runs in practice mode, Learn explains that drills are
unavailable.

## Drill and style prompts

Question prompts only (scoring is unchanged, so drill scores are comparable with
interview scores):

- A drill adds "Practice drill: ask questions that give the candidate a clear chance to
  show …" with each focus skill's fixed description, and marks the prompt version
  `+drill`.
- A style adds one paragraph describing how that kind of employer interviews and "Never
  name, imitate or claim to represent a real company", and marks `+style-product`,
  `+style-services` or `+style-startup`. Styles describe a kind of employer; they do not
  copy any company's questions.
- Language rules still apply last, for example `interviewer.v3+drill+style-startup+hi`.

Because daily drills revisit the same skills often, the repeat check now covers the last
20 interviews: the prompt lists the 20 most recent earlier questions and exact repeats are
rejected against the last 50.

## Study plan

`study_plans`, one per learner: interview date (today to one year ahead in the learner's
time zone; impossible dates such as 31 February are rejected), focus types (one to three)
and minutes a day (10, 20 or 30). The browser sends its IANA time zone in the
`x-time-zone` header (not the URL); an invalid zone falls back to Asia/Kolkata. The plan
card shows the countdown and roughly how many daily sessions are left.

## Streak and progress report

- **Streak**: consecutive calendar days, in the learner's time zone, with at least one
  AI-scored interview or drill, ending today or (before today's session) yesterday.
- **Report** (`GET /api/learning/report?weeks=1–12`, default 4): rolling seven-day weeks
  ending now with drills, other interviews (including practice) and the average AI score;
  plus the three biggest gains and declines over the last 28 days, from each skill's saved
  history (the last 60 points), marked when the change is since the skill was first
  practised.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/learning/overview` | Readiness, streak, retests due, today's drill, every skill's estimate and range, upcoming retests, plan |
| GET | `/api/learning/drill?skillId=` | A drill for one chosen skill, ready to post to `/api/interviews` |
| PUT · DELETE | `/api/learning/plan` | Save or remove the study plan (30 changes per 15 minutes) |
| GET | `/api/learning/report?weeks=` | Weekly sessions and the skills that moved most |

`POST /api/interviews` accepts `purpose` (`interview` or `drill`), `focusSkills` (up to two
skill IDs of the interview's type) and `style` (`general`, `product`, `services`,
`startup`). Drills, focus skills and non-general styles need AI mode.

## Data lifecycle

Skill states and the study plan are included in the account export (`skills`,
`studyPlan`), deleted by the account deletion sweep, and removed again when a restored
backup is reconciled against deletion receipts (`skill_states`, `study_plans`). Skill
states hold numbers and interview IDs only, no answer text.

## Tests

- `server/tests/learning.test.ts`: Kalman updates, difficulty, missing evidence, forgetting,
  readiness, FSRS grades and intervals; per-interview evidence and order-independent
  replay with bounded history; every drill-selection rule; streaks across time zones; a
  full drill with style through the worker to the overview; validation; exact rebuilds
  after a revised rating, stale rebuilds never winning, cleanup with no interviews; plan
  validation and focus; the weekly report; per-skill drills and practice mode.
- `server/tests/account.test.ts` and `deletion-ledger.test.ts`: export, deletion and restore
  reconciliation include learning data.
- `server/e2e/learning.spec.ts`: dashboard drill card → Learn, estimates with ranges, plan
  form, drill start, phone width; interview styles in setup.
