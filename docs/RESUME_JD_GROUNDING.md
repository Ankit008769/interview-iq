# Resume and job-description grounding (Phase B3, v1)

Implemented 25 October 2026. Candidates paste a resume or a job description, choose
one of each for an AI interview, and get questions about their own projects and the
role's requirements. Each tailored question shows the exact line it came from.

This is a deliberately small first version of the B3 plan in the strategy report. It
is API-first and paste-only: no file uploads, no document parsing, no embeddings or
vector search. A resume and a job description together fit easily in one model
request, so retrieval is not needed yet.

## What the user sees

- **Resume & JD** page (`/documents`): add a document (type, title, pasted text up
  to 12,000 characters), view its text, delete it. Up to 10 documents per account.
  The page tells candidates to remove contact details first, because the full text
  goes to the AI provider when a document is chosen.
- **Setup**: when "Use AI" is ticked, an optional *Tailor to your resume or a job
  description* box offers one resume and one job description. Practice interviews
  cannot be tailored; they use the curated question bank.
- **Interview and results**: under a tailored question, "Based on your resume:
  “…”" or "Based on your job description: “…”". If the model's quoted line is not
  found verbatim, the question is still shown, labelled as tailored with no verified
  source line.

## How a tailored question is made

1. The interviewer prompt (`interviewer-grounded.v1`) receives the chosen documents'
   kind and text, resume first, as untrusted data. The title is not sent. The prompt
   forbids following instructions inside the documents, stating facts the documents
   and answers do not contain, and asking about age, gender, marital status, family,
   religion, caste, nationality, health, disability, photo, address or salary history.
2. The model returns the question plus a `source`: which document, and the passage
   copied from it.
3. The server keeps the source only when the trimmed passage is at most 300
   characters and appears verbatim in that document, and stores its offsets.
   Line endings are normalised to `\n` when a document is saved, so offsets are stable.
4. Every question generated with documents in context records their IDs
   (`grounding.documentIds`), whether or not a source line was verified. This is what
   makes deletion complete.

The evaluator, score challenges and rewrites never receive documents. Follow-up
questions are tailored the same way while the documents exist.

## Deleting a document

Deleting a document removes the document and **every interview question generated
with it in context**: the question text is replaced with "This question was removed
because you deleted the document it was based on." and its source is removed. This
applies to saved turns and to the question currently on screen. The candidate's
answers, scores and AI rationales stay; candidates are told this before confirming.

Deletion is safe against work in flight:

- The document is first marked as deleting, so it is never used for a new question
  from that moment. A repeated delete finishes an interrupted one.
- The document ID is pulled from interviews before any question is cleared. A worker
  that was generating a follow-up writes with a fence on the document IDs it used, so
  its result is discarded and the job is requeued without the document.
- The current question is cleared before saved turns, and an answer is accepted only if
  the question it copies is still current. An answer submitted during deletion is
  either caught by the turn pass or rejected with a reload message.
- If a document is deleted while the first question of a new interview is being
  generated, the new interview is cleaned before it is returned.

Account export includes documents. Account deletion and backup-restore reconciliation
delete them with the rest of the account.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/documents` | List own documents (no text) and limits |
| GET | `/api/documents/:id` | One own document with its text |
| POST | `/api/documents` | Save `{ kind: 'resume' \| 'job_description', title, text }` |
| DELETE | `/api/documents/:id` | Delete a document and the questions generated from it |

`POST /api/interviews` accepts optional `documentIds` (at most one resume and one job
description, AI mode only, the caller's own documents). Other users' documents return
404 or are rejected; document writes share a quota of 30 per 15 minutes.

## Consent

The AI disclosure (policy `2026-10-25.v2`) adds a paragraph saying that a chosen
resume or job description is sent in full to the provider. The fingerprint changes,
so every AI user reviews and accepts again before their next AI request.

## Tests

`server/tests/grounding.test.ts` covers owner-only access, validation and the
10-document limit; tailored questions, prompt content and provenance; rejection of
other users' documents, practice mode and duplicate kinds; dropped unverifiable
sources; deletion of derived questions without touching other interviews or users;
both deletion races (follow-up and first question); and interrupted deletion.
`account.test.ts` and `deletion-ledger.test.ts` cover export, account deletion and
restore reconciliation. `server/e2e/grounding.spec.ts` runs the full flow in
Chromium, including the phone layout.

## Not yet done

- **Relevance is unmeasured.** The B3 exit gate asks that at least 80% of tailored
  questions are rated relevant by reviewers. That needs the A5 rater process.
- Uploads (PDF/DOCX), parsing with a correction step, a competency map and gap
  analysis, and retrieval for long documents remain later B3 work, adopted only when
  pasted text proves insufficient.
- Documents cannot be edited; delete and add again.
- AI-written rationales may mention a question's topic and are kept after a document
  is deleted, like the answers they describe.
