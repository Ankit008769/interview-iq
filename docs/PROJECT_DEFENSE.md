# Project defense (Phase C4, v1)

Implemented 10 November 2026. Candidates upload a project they built as a zip. The app removes secrets,
indexes the code with tree-sitter, checks the claims in a chosen resume against the code, and runs a
**project-defense interview**: each question is about a specific file and function, shown with the
question, and scoring checks the explanation against that code.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| Repository upload (zip first; GitHub app later) | Zip upload, up to 8 MB. A least-privilege GitHub app is not built. |
| Secret scanning | Yes, before anything is stored (below). |
| Code indexing with tree-sitter | Yes: the WebAssembly tree-sitter build that VS Code ships (`@vscode/tree-sitter-wasm` 0.3.1), so no native modules. |
| Embeddings | **Not used yet.** Questions pick symbols directly, and claims are matched lexically; neither needs similarity search. |
| Resume claims checked against code | Yes (below). |
| Questions grounded in specific files and functions | Yes: the app chooses the code, the model writes the question. |
| Uploaded code executed only inside the C2 sandbox | v1 never executes uploaded code at all. |
| Exit gate: ≥ 90% of questions reference real files or functions | Measured (below): 10 of 10 named by the model, all real symbols. |
| Exit gate: zero secret leakage in logs or prompts (automated scan) | Tested on every run (below). |

## Upload and secret removal

`server/src/projects/ingest.ts` reads the zip in memory with yauzl and never writes it to disk.

- **Archive limits.** At most 8 MB compressed and 5,000 entries. Each kept file is at most 256 KB, checked
  against the declared size before inflating and against the bytes actually produced while inflating, so a
  header that lies stops early. Files over 64 KB that compress more than 200:1 are skipped as possible zip
  bombs. At most 1,500 files and 4 MB of text are kept.
- **Paths.** Entries pointing outside the folder (`../`, absolute paths) make yauzl refuse the whole archive,
  and the upload is rejected with a clear message. A single top-level folder (as in GitHub downloads) is
  dropped from paths. Symbolic links are skipped.
- **Skipped content.** Dependency and build folders (`node_modules`, `dist`, `build`, `vendor`, `venv`,
  `target`, `.git` and others), lock files, minified files, source maps and anything binary (containing a
  NUL byte) or not a known source type.
- **Secret files are dropped whole:** `.env*`, key and certificate files (`.pem`, `.key`, `.p12`, `id_rsa`
  and others), `.npmrc`, `.netrc`, `credentials.json`, service-account JSON, `secrets.*` and Terraform state.
- **Secrets in code are redacted** (`server/src/projects/secrets.ts`): private key blocks, AWS, GitHub,
  GitLab, Slack, Google, Stripe, OpenAI, Anthropic, SendGrid, Twilio and npm tokens, Azure storage keys,
  JSON web tokens, the `user:password` part of connection strings, and quoted values assigned to names such
  as `password`, `apiKey` or `client_secret`. Placeholders such as `changeme`, `process.env.X` or `${VAR}`
  are left alone. Each value becomes `[redacted <kind>]`. A redacted private key keeps its line count, so
  line numbers stay right. Findings keep only file, line and kind, never the value.

The project page lists every removed secret and dropped file, and tells the candidate to rotate them,
because they were in the zip they uploaded.

## Index

`server/src/projects/codeIndex.ts`:

- **Symbols** come from tree-sitter queries for JavaScript, TypeScript, TSX, Python, Java, Go, Rust, Ruby,
  PHP, C# and C/C++. They cover functions, methods (functions inside a class), classes, structs and
  interfaces; React components are capitalised functions in `.jsx`/`.tsx` files. Each symbol has its file and
  line range, with up to 200 per file and 3,000 per project.
- **Routes** come from Express/Koa/Fastify calls, Flask/FastAPI decorators, Spring mappings and Django
  paths.
- **Dependencies** come from `package.json`, `requirements.txt`, `pyproject.toml`, `pom.xml`, Gradle,
  `go.mod`, `Cargo.toml`, `Gemfile` and `composer.json`.

## Project-defense interview

Start it from the project page. It is an AI technical interview with `projectId`, and it needs AI permission.
For each question (`generateProjectQuestion` in `server/src/services/ai.ts`, prompt
`interviewer-project.v1`):

1. The app picks the target (`pickTarget`): a function, method, class or route not asked about yet. Tests,
   config files and helpers under four lines are skipped. Targets spread across files before revisiting
   one, and the starting point depends on the interview, so two interviews on the same project differ.
2. The model gets the redacted target code (up to 60 lines; a route shows 20 lines of its handler), the file
   list and the dependency names, and writes one question of at most two sentences.
3. The question must name the file or the function. Every `backticked` name in it must appear in the
   target code, a file path or a symbol name. Otherwise the question is asked again, up to three times. If
   the last try still does not name the code, the app prefixes the reference itself and records
   `referenced: 'added'` instead of `'model'`.
4. The question is saved with the file, symbol, line range and excerpt, and the page shows it as "About your
   code" with the code. Scoring (`evidence-judge.v2+project`) gives the judge that code as `referenceCode`,
   so it can tell whether the explanation matches what the code does. Quotes still come only from the
   answer.

The worker loads the project for each next question. A question written while the project is being deleted
misses its write and is re-queued without the project.

### Measured with the local model (10 November 2026)

`npm run project-check -- project.zip --questions 10` was run with qwen3.5:4b on this repository's own source
(`git archive` of `server/src`, `client/src` and `runner`: 89 files, 444 symbols, 2 secrets removed):

- First prompt: 10 of 10 questions named the code themselves, all real symbols. But some questions were long,
  one misquoted a line, and one invented identifiers (`draftIsSaved`, `InterviewerCoach`). This led to the
  two-sentence limit and the backtick check.
- After the change: **10 of 10 named the code themselves (`referenced: 'model'`), 10 of 10 real symbols,**
  no invented identifiers, 32–59 s per question on the laptop CPU. One question asked two things.

This is one project and one model; the check should be repeated on other projects and after model changes.

## Resume claims against code

`POST /api/projects/:id/claims { documentId }`, prompt `project-claims.v1` (`server/src/projects/claims.ts`):

- The model lists up to eight claims from a saved resume about software the candidate built. Each claim
  quotes the resume exactly and names one to six keywords that would appear in code. Claims whose quote is
  not found verbatim are dropped and counted.
- **The app, not the model, decides support.** Strong evidence is a dependency or a symbol named after the
  keyword. Medium evidence is a file path, or the word appearing in two files. Weak evidence is the word in
  the code. Manifests count only as dependencies, and redacted lines are never shown. A claim is "found in
  the code" when at least half its keywords have strong or medium evidence, at least one of them strong. It
  is "partly found" when anything matches, and "not found" otherwise. Each claim shows its evidence as
  file:line.
- The last five checks are kept on the project.

## Exit-gate tests

`server/tests/projects.test.ts` builds a project zip with planted secrets: an AWS key, a GitHub token, a
password in a connection string, a hard-coded password, a `.env` file and a key file. It asserts that **none**
of the values appear in:
- the stored project;
- any API response;
- any request sent to the AI gateway (claims, every interview question, scoring);
- anything written to the console during the whole flow.

It also asserts that every interview question refers to a symbol that exists in the indexed project, with
its excerpt, and that none repeats. It covers the invented-identifier re-ask, zip limits, a zip bomb, zip
slip, binary and lock-file skipping, symbol and dependency extraction, target selection, claim statuses,
project limits (3 per user), ownership and deletion. `server/e2e/project.spec.ts` covers the same flow in the
browser.

## Data and deletion

`projects` stores the redacted files, the index, the findings and the claim checks; it is included in the
account export (`projects`), deleted with the account and reconciled on restore. Deleting a project replaces
the questions generated from it with the removed-question notice and drops their code excerpts, as for
documents. The consent text gains a projects line: uploaded code is redacted before saving, processed by the
same AI models and never run.

## API

| Method | Route | Purpose |
|---|---|---|
| GET · POST | `/api/projects` | List projects, or upload one (`Content-Type: application/zip`, name in `x-project-name`; 10 uploads a day) |
| GET · DELETE | `/api/projects/:id` | The project with its index, findings and claim checks (never full file texts), or delete it with its questions |
| GET | `/api/projects/:id/excerpt?path=&start=&end=` | Up to 60 redacted lines of one file |
| POST | `/api/projects/:id/claims` | Check a saved resume's claims against the code |

`POST /api/interviews` accepts `projectId` for an AI technical interview.
