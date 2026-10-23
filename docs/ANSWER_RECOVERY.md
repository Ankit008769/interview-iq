# Durable answer processing

An interview stores its accepted turns and processing job in one MongoDB document.
The answer route performs a conditional atomic update that appends the answer and
sets `processingState: queued`, `jobAttempts: 0`, and `jobNextAttemptAt`. It returns
202 without calling the AI provider. No separate queue write or replica-set
transaction is required, so this also works with the local standalone MongoDB.

## States

| State | Meaning | Allowed action |
|---|---|---|
| ready | Next question available, or interview completed | Submit next answer if still in progress |
| queued | Answer saved, worker attempt pending/backing off | Read/poll; identical submission replay is safe |
| processing | A worker owns the current lease | Read/poll; no new answer accepted |
| failed | Three attempts exhausted, including crashed attempts | Owner can explicitly retry processing |

The worker runs immediately after the database connects and then checks for work
once per second. Each process handles one job at a time. Multiple processes can
claim distinct jobs using MongoDB's conditional `findOneAndUpdate`. A claim assigns
a random lease token, increments attempts and sets a two-minute expiration. Both
success and failure writes must match the token and processing state. An expired
worker cannot overwrite the result of a replacement worker.

Failures back off for 2 then 4 seconds before the next automatic attempt. After
three attempts the job becomes `failed`. A crashed third attempt is also marked
failed after lease expiration. Manual retry resets the attempt budget without
adding an answer. Duplicate retry requests cannot requeue an active job. The API's
existing rate limit applies to retries.

For intermediate turns, success atomically stores the next question and sets
`ready`. For the final turn, success atomically stores feedback, completion time,
completed status and `ready`. The session's AI/practice mode is persisted; removing
an AI key causes retries rather than silently substituting unscored feedback.
Legacy sessions adopt the configured mode when their next answer is saved.

## Failure boundaries

- Crash before the atomic save: the answer is not accepted; the client can retry.
- Lost acknowledgement after save: resending the same submission ID/content returns
  the existing state, without creating a turn or a second job.
- Crash after save but before claim: startup finds the persisted queued work.
- Crash during processing: a replacement can claim it after lease expiry.
- Provider success followed by database failure: another attempt may call the
  provider again. Database state remains fenced; provider billing is at least once.
- All workers stopped: answers remain queued until a worker starts.
- Database durability depends on the deployment's persistence/write concern and
  backups. This change does not protect against losing the database itself.

## Verification

MongoDB-backed tests exercise persistence before generation, backoff, bounded retry,
manual retry authorization, live-lease exclusion, stale-result fencing, crashed
final attempts, worker startup after database reconnection, mode stability and
final evaluation failure. Existing authentication, concurrency and analytics tests
continue to run. Chromium tests exercise the UI using real HTTP and MongoDB; the
test-only host can pause the worker and inject a failed job state. Paid live AI
calls, production deployment, sustained load and other browser engines are not
covered by these checks.
