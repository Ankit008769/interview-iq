# Independent deletion ledger

Account deletion now copies a minimal receipt to Cloud Storage before acknowledging
success or physically cleaning up the account. This protects deletions made after
the database snapshot used for a restore. Application email remains disabled.

## Storage and permissions

- Bucket: `gs://interviewiq-deletion-ledger-341474411884`, region `asia-south1`.
- Uniform bucket-level access and public access prevention are enabled.
- Minimum retention is 30 days, **unlocked**. There is no lifecycle expiry rule.
- Runtime identity `interviewiq-app` has bucket-scoped `roles/storage.objectCreator`.
  It cannot list, read, overwrite or delete receipts with this grant.
- Application Default Credentials use the Cloud Run service identity; no downloaded
  service-account keys or user tokens belong in the application.
- Objects are `receipts/v1/<ObjectId>.json`, containing only schema version, opaque
  account ID and requested-at time. No email, password, answer or provider content.
- Writes use `ifGenerationMatch: 0`. A repeated write returning 412 is treated as
  success because the stable object name is already present in this dedicated
  create-only namespace. Do not manually replace objects or write arbitrary files
  into this namespace. Bucket administrators remain trusted.

Receipt retention is intentionally longer than the seven-day snapshot schedule and
has no automatic expiry: failed schedules can retain old snapshots beyond seven
days. Do not purge receipts while any recoverable copy can contain the account.
This is independent of the Mongo disk, but still shares its Google project and
region. It is not protection against project deletion, region loss or a privileged
administrator deleting the ledger after its retention period.

Provisioning commands (already applied; inspect before reusing):

```sh
gcloud storage buckets create gs://interviewiq-deletion-ledger-341474411884 --project=project-12b39f1f-9d49-456e-957 --location=asia-south1 --uniform-bucket-level-access --public-access-prevention --retention-period=30d
gcloud storage buckets add-iam-policy-binding gs://interviewiq-deletion-ledger-341474411884 --member=serviceAccount:interviewiq-app@project-12b39f1f-9d49-456e-957.iam.gserviceaccount.com --role=roles/storage.objectCreator
```

## Deletion and failure behavior

1. Verify the password and atomically mark the account; immediately revoke access.
2. Upsert a Mongo receipt and synchronously replicate it. A successful 202 response
   in production requires a successful remote write (or existing receipt).
3. On replication failure, return 503 explaining that access is revoked, cleanup is
   paused and automatic retries are pending. Do not invite another deletion request.
4. The worker repairs markers without receipts, retries remote failures once per
   minute, and processes at most five receipts per cycle. Replication failure emits
   `deletion_ledger_failure` at ERROR, caught by the existing application-error alert
   routed to the owner. Candidate content and upstream exception text are excluded.
5. Only after replication and the one-minute in-flight-write drain period does the
   worker remove owned data. Repeated sweeps remove late writes. Existing receipts
   are automatically backfilled, including receipts left from earlier releases.

`replicatedAt` and `replicationBucket` record the successful destination; changing
the configured bucket triggers backfill. They are not a substitute for verifying
the bucket exists and remains intact. Production startup requires
`DELETION_LEDGER_BUCKET`; development without it explicitly has no remote guarantee.

MongoDB and Cloud Storage do not share a transaction. A crash between marking the
user and recording/replicating the receipt is repaired from the durable user marker.
If the database is permanently lost during this interval, an unacknowledged pending
deletion may not be present remotely. Stop promotion and reconcile outstanding
requests with the owner; do not claim zero data loss or complete replication merely
because a bucket contains some objects. During migration, wait for all historical
receipts and pending user markers to be covered before relying on this ledger.

Run `node dist/scripts/deletionLedgerStatus.js` in a controlled operator job with the
same MongoDB secret and ledger bucket configuration. It reads only counts and exits
nonzero if any receipts lack replication or any marked users lack receipts. Compare
the count with a separate operator listing of the bucket, and validate a disposable
account's object. This audit does not grant the app bucket read access. Concurrent
deletions can change counts between checks; quiesce writes for restore promotion.

## Restore reconciliation — required before promotion

Quiesce application writes/workers first, including revisions undergoing rollback.
Copy surviving current receipts and pending markers into the isolated restored
database if available. Keep that restored copy disconnected from app traffic.

The built CLI requires `--isolated-restore`, `RESTORE_MONGODB_URI` with an explicitly
named database on loopback, and `DELETION_LEDGER_BUCKET`. It deliberately does not
load `.env` or use the application's `MONGODB_URI`. Use an isolated restore host,
not a live Mongo host or an SSH tunnel to the live database. Use operator ADC with
bucket read/list access; do not grant those permissions to the application.

```sh
# On an isolated restore host, after npm ci and npm run build in server/:
export RESTORE_MONGODB_URI='mongodb://127.0.0.1:27018/interviewiq'
export DELETION_LEDGER_BUCKET='interviewiq-deletion-ledger-341474411884'
node dist/scripts/reconcileDeletions.js --isolated-restore
```

The tool reads every streamed page and validates all remote receipts before database
mutation. Empty ledgers, download/listing failures and malformed receipts fail closed.
It merges remote receipts, restored receipts and pending user markers; removes owned
profiles, interviews, usage and quotas; then removes **all** restored sessions and
action tokens. It reports counts only. Rerunning it is safe. Any error means do not
promote; complete reconciliation and the health/auth/interview checks in
[BACKUP_RESTORE.md](BACKUP_RESTORE.md) first. Quiescing matters: bucket listing is not
a transaction with concurrent account deletion requests.

Automated tests cover lost-response duplicate writes, access denial, backoff, cleanup
gating, marker repair, destination migration, malformed/partial remote reads, restore
isolation, session revocation and suppression of deleted accounts from an older copy.

References: [Cloud Storage preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles).
