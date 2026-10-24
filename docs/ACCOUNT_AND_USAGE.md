# Account lifecycle and usage tracking

Implemented 24 October 2026. Live email delivery is intentionally disabled at the
owner's request. The account/usage release f3dd618 was deployed and live-tested on 24 October 2026.
The backup schedule is active in Google Cloud. Subsequent consent and monitoring
behavior is documented in MONITORING_AND_CONSENT.md.

## Account access

The Account page supports listing/revoking sessions, signing out all sessions,
changing a password, exporting owned data, viewing AI usage and deleting an account.
Sessions use random 256-bit opaque cookies with only SHA-256 hashes stored in Mongo.
They expire after seven days, checked on each request independently of TTL cleanup.
Cookies remain HTTP-only, SameSite=Lax and Secure in production. Authentication
also checks the user's session version and deletion state on every request.

Deploying this release signs out old JWT cookies once. Existing accounts keep their
passwords and interviews. Accounts without authVersion are treated as version zero;
password change/reset and sign-out-all increment it, invalidating even a concurrent
login that writes a stale session after revocation. JWT_SECRET is retained as the
configuration name for the shared authentication limiter's IP HMAC, not JWT signing.

New passwords require 8 characters and at most 72 UTF-8 bytes (bcrypt's input limit).
Login accepts existing passwords up to the previous 128-character limit. Sensitive
changes require the current password; single-session revocation checks ownership.
Mongo-backed limits allow 20 requests per IP and action per 15-minute window. They
survive process restarts and expose Retry-After. This is basic abuse prevention,
not a replacement for edge protection or per-recipient email limits at public launch.

## Recovery and verification

The server and browser flows exist and are tested with a fake mailbox. There is no
live email provider, sender, key or outbound mail call. The capabilities endpoint
reports emailDelivery:false; mail requests return explicit unavailable responses.
The Account page disables sending verification mail and recovery explains the limit.

Action tokens are random, hashed in storage, purpose-bound, version-bound and
single-use. Reset tokens last 30 minutes; verification tokens last 60 minutes.
Expired tokens are rejected even before TTL cleanup. Reset revokes all sessions
and action tokens. Links carry their token in a URL fragment; the browser removes
it from the address bar and submits it only in the POST body. No token is returned
by production API responses or written to logs. Test-only link issuance is confined
to the loopback browser fixture, excluded from the production build.

To enable delivery later, implement accountMail.ts using a verified sender/provider,
store credentials in Secret Manager, and test delivery, bounces and recipient abuse
limits. Do not flip a configuration flag without an actual delivery implementation.
Unknown recovery addresses receive the same response as known addresses when mail
is enabled; failed delivery removes the issued token. Email verification does not
currently gate practice or API usage, since mail is intentionally unavailable.

## Export and deletion

Export is owner-scoped streamed JSON with backpressure handling and no-store headers.
It contains profile, interviews and usage, excluding password hashes and auth tokens.
It is a streaming export, not a transactionally consistent point-in-time snapshot.

Deletion requires the password and literal DELETE. A durable marker revokes access
immediately. The existing worker waits at least a minute before removing owned
interviews, usage, sessions, action tokens, quota buckets and the user. Cleanup is
idempotent and retries after failures. Minimal receipts contain user ID, request
time and sweep time; repeated sweeps remove late writes already in flight. Receipts
have no email, password or interview content and are retained without automatic
expiry to support restore suppression. Cleanup runs in bounded batches; a stopped
worker delays physical deletion but cannot restore account access.

Backups are separate copies. Do not promise immediate deletion from snapshots.
Before promoting a restored database, merge the latest deletion receipts AND pending
user deletion markers from the surviving authoritative database (if available),
apply those deletions, and purge all restored sessions/action tokens. An older
snapshot alone cannot reveal deletion requests made after it was taken. If the
latest deletion record is unavailable, stop promotion and reconcile outstanding
requests with the owner. Independent deletion-ledger replication is still pending.
See BACKUP_RESTORE.md for snapshot retention caveats and the tested restore drill.

## Usage accounting

Every production model request inserts an AIUsage attempt before contacting the
provider. Records include owner, interview ID, model slot, requested/resolved model,
prompt version, timestamps, status, reported token counts and latency. They never
contain prompts, answers, credentials or upstream error bodies. Practice calls do
not create usage rows. The first question is associated with a preallocated interview
ID, even if generation fails and the interview is never created.

Raw API responses are validated after extracting token usage, so malformed JSON,
invalid schemas, refusal and incomplete output retain counts when supplied. Transport
failures have null usage, not zero. A process interrupted after sending a request
can leave status started; the UI calls it unresolved. Provider success means the
structured response passed schema validation, not that the downstream scorecard
was accepted or that the candidate interview completed. Durable retries each get
an attempt. No automatic retry is hidden inside the SDK.

The account summary aggregates the last 30 days, separates unknown counts and makes
no currency/cost or invoice claim. Historical pre-release requests are not backfilled.
Provider invoice reconciliation, priced cost reports, quality benchmarks and API
bake-offs remain later milestones. Neither live paid AI requests nor training were
needed for these tests.

## Verification

Both production builds pass. 50 backend tests and 13 Chromium tests pass, including
real local Mongo integration, a local HTTP model gateway, mailbox-mocked reset,
one-use/expiry/version/purpose enforcement, legacy accounts, session ownership,
export isolation, deletion failure/retry/late-write cleanup, shared auth quotas,
successful/failed usage, and mobile layout. Successful verification/reset browser
flows and reused/invalid links are covered. Production mail delivery is not tested
because it remains disabled. Cloud MongoDB 7 restoration is separately verified;
the local regression suites use MongoDB 8.2.6.
