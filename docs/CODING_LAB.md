# Coding lab (Phase C2, v1)

Implemented 25 October 2026. Candidates solve curated problems in a browser editor, run their code against
visible examples, submit it against hidden tests, then answer one follow-up question from the AI interviewer
and get a review of their approach. **Whether code is correct comes only from running it.** The AI never
grades correctness; its review covers what tests cannot show.

## What is in v1, and what is not yet

| Roadmap item | v1 |
|---|---|
| Browser editor | CodeMirror 6 (not Monaco): it works on phones and is about a third of Monaco's size. Each language's highlighting loads on demand. |
| Runners for JavaScript/TypeScript, Python, Java and C++ | Yes: Node 24 (TypeScript by type stripping, so type errors are not reported), Python 3.11, OpenJDK 17, g++ C++17 with a precompiled header. |
| Hidden tests | Yes: every problem has visible examples, hand-written edge cases and seeded large inputs that separate efficient solutions from brute force. |
| Complexity probing by the interviewer | Yes: one follow-up question per submission, based on the code and test results, then a review. |
| Test results shown separately from AI reasoning | Yes, in the API, the data model and the page. |
| Debugging drills | 4 "fix the buggy function" drills in JavaScript, TypeScript and Python. React, Express and MongoDB repository drills are not built yet. |
| SQL lab | 5 SQL problems run against an in-memory SQLite database per test. A MongoDB lab is not built yet. |
| 200 curated problems | **36 so far** (27 algorithm, 4 debugging, 5 SQL). |
| GKE Sandbox (gVisor) node pool | A separate Cloud Run service instead (see Isolation). |
| Exit gate: sandbox escape suite | Yes, run on every runner build (below). |
| Exit gate: external security review | **Not done.** It needs an outside reviewer. |
| Exit gate: p95 run time under 5 s | Measured on every build by `coding:verify`; see Measurements. |

## Architecture

```
browser ──► app (Cloud Run interview-iq) ──IAM identity token──► runner (Cloud Run interview-iq-runner)
              builds program + test input                          compiles and runs in iq-sandbox
              grades the output                                    returns stdout, stderr, status, timings
              stores code_runs, asks AI
```

- **Expected answers never leave the app.** The app wraps the candidate's function in a language harness
  (`server/src/coding/harness.ts`) that reads one JSON argument list per line and prints one tagged JSON
  result per test. The tag contains a random nonce, so text the program prints cannot pose as a result.
  The app compares results with expected values (`grade.ts`), with exact, unordered or nested-unordered
  comparison and float tolerance only for floating-point return types.
- **Expected values** come from each problem's reference solution (`problems.ts`); large inputs come from a
  seeded random generator, so every run sees the same tests. SQL expected rows are written by hand.
- **Hidden tests** report only passed, wrong answer, error or not run. Their inputs and outputs are never
  sent to the browser or stored.
- **Time limits** scale by language (C++ 1×, Java 1.5× plus JVM start, JavaScript and TypeScript 1.2×,
  Python 3×) from each problem's budget for all tests together.

## Isolation

The runner (`runner/`) is a separate service with no secrets, no database access and a service account with
**no IAM roles**. It accepts only requests signed with the app service account's identity token (Cloud Run
IAM; `allUsers` cannot invoke it), runs one program at a time per instance, and never runs code itself:
every compile and run goes through `iq-sandbox` (`runner/sandbox/iq-sandbox.c`), which before `exec`:

1. sets limits: CPU seconds, address space (Python and C++ 768 MB; Node and the JVM are bounded by their heap
   flags), processes (16–64), file size 32 MB, open files 128, no core dumps, stack 64 MB;
2. drops to the unprivileged user 65534 with no supplementary groups and verifies root cannot be regained;
3. sets `no_new_privs`;
4. installs a seccomp filter that refuses network sockets (only Unix sockets are allowed), so code cannot
   reach the internet **or the metadata server**, and refuses ptrace, namespaces (clone flags, unshare,
   setns), mount, keyrings, BPF, perf events, io_uring and kernel module or reboot calls;
5. starts the program with an empty environment apart from PATH, HOME, TMPDIR and LANG.

Each run gets a fresh directory under a root-owned `/sandbox` that the sandbox user cannot list. After every
run the runner kills every process of the sandbox user (repeatedly, so a fork bomb cannot outrun it), removes
its files from `/tmp`, `/var/tmp` and `/dev/shm`, and deletes the run directory. `tini` is PID 1 so orphaned
processes are reaped. At start-up the runner proves from inside the sandbox that it cannot reach 8.8.8.8 or
169.254.169.254, write to `/etc` or read PID 1's environment; if any check fails it refuses all work and
`/health` returns 503.

## Escape suite and verification (every runner build)

`runner/cloudbuild.yaml` builds the image and pushes it **only if** both pass:

- `runner/test/escape.test.mjs` inside the image: self-test; every language compiles and runs; compile errors
  are reported; IPv4, IPv6, DNS and metadata connections are refused in Node, Python and C++; AF_NETLINK and
  AF_PACKET sockets, unshare, ptrace, io_uring, mount, namespace clone and setuid(0) are refused; the user is
  65534 with no groups, `NoNewPrivs` set and only the four environment variables; writes to `/etc`,
  `/usr/local/bin`, `/app`, `/sandbox` and `/opt` fail and `/sandbox` and `/root` cannot be listed; infinite
  loops, sleeps, output floods, oversized files, memory bombs in Python, C++ and JavaScript are stopped; a
  fork bomb leaves no process behind and the next run works; a double-forked daemon is killed and its `/tmp`
  file removed; a later run cannot find an earlier run's files.
- `npm run coding:verify` against the running image: every problem's reference solution is accepted as
  JavaScript and TypeScript (and every SQL reference query), hand-written solutions in Python, Java and C++
  are accepted for problems covering every parameter and return type, the debugging drills' starters still
  fail, and broken submissions get the right verdict (wrong answer, time limit from an O(n²) solution,
  runtime error, infinite loop, compile errors in Java and C++, memory, wrong and invalid SQL). It prints
  p50 and p95 run times per language.

## AI interviewer

`server/src/coding/coach.ts`, prompts `coding-followup.v1` and `coding-review.v1` (with the language suffixes
from [LANGUAGES.md](LANGUAGES.md)):

- **Follow-up**: one question about this code (complexity, correctness, an edge case, or what went wrong when
  tests failed or large inputs timed out). The model sees the problem, the code, a test summary and the
  reference complexity, and is told never to reveal it, write code or mention hidden inputs.
- **Review**: four criteria (`CODING_RUBRIC`: algorithmic approach, complexity reasoning, code quality,
  explanation), each 0–5 with a quote that must be found verbatim in the explanation or the code, otherwise
  "not enough evidence"; plus a two-sentence summary. Test results are context only and never re-graded.
- Both need AI permission and count against the AI quota. The consent text gains a coding line when a runner
  is configured, so staging users accept once more.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/coding/status` | Whether the runner is ready, its languages, and whether AI is available |
| GET | `/api/coding/problems` | Problems with the caller's progress (solved, submissions) |
| GET | `/api/coding/problems/:id` | Statement, examples with expected answers, starters, number of hidden tests, recent runs |
| POST | `/api/coding/problems/:id/runs` | `{ language, source, mode: 'run' \| 'submit' }`: run examples or all tests (40 per 15 minutes, 300 a day) |
| GET | `/api/coding/runs/:id` | One run with its results and follow-up |
| POST | `/api/coding/runs/:id/follow-up` | The interviewer's question for a submission (once) |
| POST | `/api/coding/runs/:id/answer` | `{ answer }`: the review (once) |

`code_runs` stores the code, verdict, per-test status (actual values only for visible examples), output,
timings and the follow-up. It is included in the account export (`codeRuns`), deleted with the account and
reconciled on restore.

## Running locally

On a laptop without Docker, `RUNNER_MODE=local-unsafe` runs programs directly with the installed tools and
**no sandbox**. It refuses to listen on anything but loopback:

```bash
cd runner && RUNNER_MODE=local-unsafe PORT=8090 node server.mjs
```

Then start the app with `RUNNER_URL=http://127.0.0.1:8090` and `RUNNER_AUTH=none`. Languages whose tools are
missing (Java on this laptop) show as unavailable. `RUNNER_AUTH=token` with `RUNNER_TOKEN` is available for a
runner on another machine.

To check the deployed runner from a laptop, use your own identity token (you need `roles/run.invoker` on it;
project owners have it):

```bash
RUNNER_URL=https://interview-iq-runner-341474411884.asia-south1.run.app RUNNER_AUTH=bearer RUNNER_BEARER_TOKEN="$(gcloud auth print-identity-token)" npm run coding:verify
```
