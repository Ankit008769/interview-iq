# Campus and placement offices (Phase D1, v1)

Implemented 11 November 2026. A college's training and placement office (TPO) creates an organisation,
brings students in, sets assignments and drive-preparation packs, and follows each cohort's readiness.
Students choose to join, see exactly what will be shared before they do, and can leave at any time.

## Roadmap items and status

| Roadmap item | v1 |
|---|---|
| Org admin, coordinator and student roles | Yes. |
| Cohorts | Yes, up to 100 per organisation, each with its own join code. |
| Bulk onboarding by CSV | Yes. Invitations are accepted by the owner of a verified email address. |
| SSO (Google Workspace, OIDC, SAML) | Not built. It needs each college's identity provider to be set up with us. Join codes and CSV invitations work without it. |
| Assignments with due dates | Yes: an interview, a coding problem or a system-design problem. |
| Placement-readiness index | Yes (below). It is a practice signal, never a hiring prediction. |
| Cohort analytics and CSV export | Yes. |
| Drive-preparation packs | Yes: IT services, product company and startup. |
| Branding | Organisation name, a display name and an accent colour. Custom domains and logos are not included. |
| Student consent for data sharing | Yes, versioned (`SHARING_VERSION` `2026-11-11.v1`). |
| Tenant isolation | Yes. Every organisation route checks the caller's membership, and every query is filtered by the organisation. |
| DPA template | [legal/DPA_TEMPLATE.md](legal/DPA_TEMPLATE.md), a draft that needs legal review before use. |

## Roles

| Role | Can |
|---|---|
| Admin | Everything a coordinator can, plus: rename and brand the organisation; make a new organisation join code; change roles; move members between cohorts; remove members; delete cohorts; invite coordinators; delete the organisation. |
| Coordinator | Create cohorts; import students; cancel invitations; set and delete assignments; add packs; see cohort reports and export them; make a new cohort join code. |
| Student | Join; see their own cohorts and assignments; leave. |

Rules:
- An organisation always keeps at least one admin. The last admin cannot be demoted, and cannot leave
  while other members remain.
- When the last member leaves, the organisation is deleted.
- Staff cannot be made students, because only students agreed to share their progress; they can leave and
  join again with a code.
- Each person can create up to two organisations, and at most five creation attempts a day.

## Joining

Students join from the **Campus** page in one of two ways. Both show the sharing terms, and the student
must tick "I agree" before joining.

- **Join code.** Each organisation has a join code, and so does each cohort. The organisation's code adds a
  student with no cohort. A cohort's code also places them in that cohort, so a class can be given one code.
  Codes are eight characters from an alphabet without look-alike letters. Making a new code stops the old
  one working; current members stay.
- **Invitation.** Staff import a CSV with an `email` column and, optionally, `name`, `cohort`, `roll_number`
  and `role` (`student` or `coordinator`).
  - Missing cohorts are created.
  - People who are already members are moved into the named cohort instead.
  - Importing the same email again updates the invitation.
  - Errors are reported by line.
  - Up to 1,000 rows and 512 KB per import.

  The invited person sees the invitation on their Campus page after signing in with that email. **They can
  accept only once their email address is verified,** because an invitation can carry a coordinator role.
  While the app has no email provider configured (see [account behaviour](ACCOUNT_AND_USAGE.md)), nobody
  can verify an address, so use join codes. Imported roll numbers and names wait in the invitation until
  then.

The sharing terms read: *Your placement office will see your name, email and roll number, which of their
assignments you finished and when, your scores on them, your overall interview scores and your readiness
index. They never see your answers, recordings, code, documents or projects. You can leave at any time.*
The accepted version and time are stored on the membership.

## Assignments

An assignment points at practice the app already offers, so it opens ready to start:

| Kind | Opens | Counts as done when the student… |
|---|---|---|
| Interview | `/interview/new` with type, topic, level, number of questions and style preset | finishes an interview of the same type, topic and level, with AI feedback |
| Coding | The problem in the coding lab | makes an accepted submission |
| System design | The problem on the design board | gets a review of a design |

Rules for completion:
- Only work after the assignment was set counts. Practice-bank interviews (no AI feedback) do not count.
- Completion is read from the student's own records. Nothing is copied into the organisation.
- Interview assignments are limited to the choices on the setup page: Technical with DSA, React, Node.js
  or DBMS; Behavioral; HR; 2, 3 or 5 questions.

Scores:
- An interview's score is its overall AI score.
- An accepted coding submission scores 100.
- A design's score is the mean of the review criteria that had evidence, scaled to 0–100.

**Drive-preparation packs** add a sequence of assignments to a cohort, each due a set number of days after
a chosen start:
- **IT services drive:** DSA and DBMS basics, two easy problems and an HR round, over two weeks.
- **Product company drive:** two harder problems, an advanced DSA interview, a URL-shortener design and a
  behavioural round, over three weeks.
- **Startup drive:** Node.js and React interviews, one problem and an ownership-focused behavioural
  round, over two weeks.

## Placement-readiness index

The index runs from 0 to 100 and combines:

| Part | Weight | Source |
|---|---|---|
| Skill readiness | 50% | Adaptive learning's competency estimates ([adaptive learning](ADAPTIVE_LEARNING.md)) |
| On-time assignments | 30% | Assignments finished by their due date, out of those already due |
| Recent interviews | 20% | Mean of the last five AI-scored interviews |

A part with no data is left out and the other weights are rescaled. With no data at all, the index is
empty, not zero. The cohort page explains the formula and says that the index is a practice signal for
coaching, not a hiring prediction.

## Cohort report and export

The cohort page shows:
- the cohort's join code;
- each student's readiness and its three parts, assignments done, and last activity;
- a cell per assignment: done, late or not done, with the score;
- per-assignment completion counts.

**Export CSV** downloads the same report as a UTF-8 file with a byte-order mark, which Excel needs. Any
cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe, so a name
such as `=HYPERLINK(...)` can never become a formula.

## Data and privacy

Collections:
- `organizations`
- `memberships` (role, cohorts, roll number, the sharing version and when it was accepted)
- `org_invitations`
- `cohorts`
- `assignments`

Staff access:
- Staff see students only through these routes, and only for members of their own organisation.
- Staff see none of a student's answers, recordings, code, documents or projects.

Account lifecycle:
- **Export.** A student's account export includes their memberships under `organisations`.
- **Account deletion.** The person's memberships and invitations to their email are removed. An
  organisation whose only admin they were is deleted with its cohorts, assignments and invitations;
  members keep all of their own practice. The same rules run when a backup is restored
  (`reconcileDeletions`).
- **Leaving.** Leaving removes the membership at once, so the student disappears from the cohort report.

Audit trail: administration (joins, leaves, role and cohort changes, imports, new codes, assignments, packs,
exports and deletions) is logged as `org_audit` events with opaque IDs and counts only. See
[monitoring](MONITORING_AND_CONSENT.md).

## Isolation

`routes/orgs.ts` loads the caller's membership for every route under `/api/orgs/:orgId`:

| Caller | Response |
|---|---|
| Not a member, or an invalid organisation ID | 404, so outsiders cannot tell an organisation exists |
| Member without the needed role | 403 |

Every lookup of a cohort, assignment, member or invitation is filtered by the organisation in the URL as
well as by its own ID. An admin of one organisation therefore cannot reach another's records through
their own organisation's routes. A member cannot be moved into another organisation's cohort.

## API

| Method | Route | Who | Purpose |
|---|---|---|---|
| GET | `/api/orgs` | Anyone | My memberships, invitations to my email, the sharing terms and the packs |
| GET | `/api/orgs/assignments` | Anyone | My assignments across organisations, with completion |
| POST | `/api/orgs` | Anyone | Create an organisation (I become its admin) |
| POST | `/api/orgs/join` | Anyone | Join with a code, agreeing to the current sharing version |
| POST · DELETE | `/api/orgs/invitations/:id/accept` · `/api/orgs/invitations/:id` | Invitee | Accept (verified email only) or decline |
| GET | `/api/orgs/:orgId` | Member | Organisation and cohorts (codes and counts for staff) |
| PATCH · DELETE | `/api/orgs/:orgId` | Admin | Rename and brand, or delete |
| POST | `/api/orgs/:orgId/join-code` | Admin | New organisation join code |
| DELETE | `/api/orgs/:orgId/membership` | Member | Leave |
| GET | `/api/orgs/:orgId/members` | Staff | Members and pending invitations |
| PATCH · DELETE | `/api/orgs/:orgId/members/:userId` | Admin | Change role or cohorts, or remove |
| POST | `/api/orgs/:orgId/invitations/import` | Staff | CSV import (`text/csv`, or JSON `{ csv }`) |
| DELETE | `/api/orgs/:orgId/invitations/:id` | Staff | Cancel an invitation |
| POST | `/api/orgs/:orgId/cohorts` | Staff | Create a cohort |
| DELETE | `/api/orgs/:orgId/cohorts/:cohortId` | Admin | Delete a cohort and its assignments |
| GET | `/api/orgs/:orgId/cohorts/:cohortId` · `/export.csv` | Staff | Cohort report, or its CSV |
| POST | `/api/orgs/:orgId/cohorts/:cohortId/join-code` | Staff | New cohort join code |
| POST | `/api/orgs/:orgId/cohorts/:cohortId/assignments` · `/packs` | Staff | Add an assignment or a pack |
| DELETE | `/api/orgs/:orgId/assignments/:id` | Staff | Delete an assignment |

## Tests

`server/tests/orgs.test.ts` covers:
- the readiness weights and rescaling, design scores, CSV formula neutralising, and that every pack item is
  a valid assignment;
- joining with consent, and with cohort and organisation codes;
- isolation: outsiders get 404; an admin of another organisation using their own routes gets 404;
  students get 403; coordinator limits; staff cannot be made students;
- CSV import: errors by line, updates, moving existing members, verified-email acceptance, and that
  nobody else can accept or decline someone's invitation;
- completion rules for all three kinds, including what does not count, the readiness index before and
  after assignments fall due, and the CSV export;
- last-admin protection, leaving, new codes, branding validation, the creation limit and deleting an
  organisation;
- removal on account deletion and on backup restore, and the export;
- audit events that carry IDs but no names or email addresses.

`server/e2e/campus.spec.ts` drives the real UI:
1. An officer creates an organisation and cohort, and sets a React interview assignment.
2. A student cannot join until they agree to the terms. They join with the cohort code and open the
   assignment, which arrives at the preset setup page.
3. The officer sees the student and downloads the CSV.
4. The student leaves and disappears from the cohort.
