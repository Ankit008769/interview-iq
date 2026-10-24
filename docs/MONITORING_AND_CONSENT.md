# Phase A monitoring and AI provider consent

Implemented 24 October 2026. Application email remains disabled. The owner explicitly
authorized Cloud Monitoring notifications to ankitbhukar815@gmail.com; those alerts
are independent of application recovery/verification email.

## AI processing permission

Practice is the default selection in interview setup, even when an AI provider is
configured. It sends no content to an AI provider and produces no automated score.
Users can separately choose AI after reviewing and explicitly accepting the provider
notice. The checkbox is never preselected. The notice names the provider, endpoint,
question/evaluator models, data shared, retention limitations and withdrawal behavior.
No claim of India-only processing, offline service or zero retention is made.

`GET /api/account/ai-consent` returns the current disclosure and grant status.
`POST` to that route requires `accepted:true` and the exact current disclosure hash.
`DELETE` withdraws permission. Grants are account-scoped and server-timestamped.
The hash covers disclosure text, provider name, model slots and full configured
endpoint. Provider/model/path/policy changes invalidate prior permission. Set
LLM_PROVIDER_NAME to the actual gateway operator when using a compatible provider;
the endpoint remains visible even when the display name is omitted.

The API checks consent before starting an AI interview and at the provider boundary
for each initial question, queued follow-up, retry and evaluation. Production calls
without an account context fail closed. OpenAI's endpoint is pinned explicitly, so
OPENAI_BASE_URL cannot redirect content behind the notice. Practice requires no grant.
Missing/withdrawn permission leaves queued answers saved and marks processing failed
with directions to Account. After granting permission there, the user can retry.
Permission cannot recall already sent content or cancel a request already in flight.

AI usage stores the consent version. Withdrawal between ledger creation and dispatch
records a cancelled attempt with zero tokens; it does not masquerade as a billable
transport failure. The latest grant is included in owned account export and removed
with account deletion. This is product permission enforcement, not a legal compliance
certification or a substitute for selecting a provider with appropriate terms.

## Cloud monitoring resources

Project: project-12b39f1f-9d49-456e-957. Configuration is versioned in
`deploy/monitoring-config.mjs`; `deploy/configure-monitoring.mjs` creates/updates
named resources without changing IAM, networking or application email credentials.
Run it with a short-lived Google access token in IQ_MONITORING_TOKEN, never in argv,
source, Git or logs. Clear the process variable immediately afterward. The script
reuses the existing owner email channel and named policies/dashboard.

Dashboard: https://console.cloud.google.com/monitoring/dashboards/builder/c9cd28d5-6155-43d1-b53e-da1154c572c5?project=project-12b39f1f-9d49-456e-957

| Alert | Condition |
|---|---|
| Health unavailable | At least two checker locations fail `/api/health` for two minutes |
| Scheduled backup failed | Any scheduled-snapshot warning/error for the exact Mongo data disk |
| Backup success missing | No completed successful scheduled-snapshot event for three hours |
| Worker heartbeat missing | No successful database worker cycle for ten minutes, aggregated across revisions |
| Application errors | Sanitized application/worker ERROR events |
| Elevated latency | P95 Cloud Run request latency over 10 seconds for five minutes |

The public HTTPS check validates TLS and requires the connected-database marker in
the response body, so a login redirect cannot count as healthy. Existing Cloud Run
access currently permits public HTTP, while private account data requires app login.
This turn does not weaken access settings. If IAP is enabled again, replace this
with an appropriately authenticated/private probe instead of disabling security.

Four log-based metrics feed the dashboard: snapshot successes/failures, worker
heartbeats and application errors. Snapshot success requires the exact disk ID,
ScheduledSnapshots method, final operation marker, DONE status and no error payload.
Metric-absence alerts only become effective after their first post-creation point.
The backup monitor must receive the next natural hourly completion; worker monitoring
must receive a heartbeat from the new deployed app. Do not claim absence protection
before those first samples. Log ingestion delays also affect detection latency.

Heartbeat events follow successful DB cleanup/worker cycles, at most once per minute.
API error events and worker DB errors are structured, bounded fields without exception
payloads, prompts, answers, email addresses, URLs or credentials. Retiring a revision
must not generate a false heartbeat absence alert, so the condition reduces across
revisions. Stopping all staging compute intentionally will alert after activation.

## Operations and verification

For a health incident, check the active revision, database health and VM before
changing resources. For a backup incident, inspect policy attachment, the newest
READY snapshot and the ScheduledSnapshots audit operation. Never delete retained
backups to silence an alert. Follow BACKUP_RESTORE.md for isolated restoration and
deletion reconciliation. An alert is not proof that a backup is recoverable.

A separately labeled temporary log-alert policy is used for delivery testing; it
matches only a synthetic test event, not a fake application failure. Remove that
policy after verification. Do not induce a live DB outage or break the backup schedule
just to test email. The test notification arrived in the authorized Gmail inbox at 13:10:24 UTC on
24 October 2026; its incident was confirmed in Cloud Monitoring. The temporary
policy was removed afterward. Operator delivery evidence is kept outside Git in agent-notes.

Local verification: both builds, 59 backend tests and 14 Chromium tests. Coverage
includes missing/stale consent, explicit acceptance, withdrawal, queued answer safety,
a withdrawal race before dispatch, practice fallback, pinned provider endpoint,
production account-context enforcement, metric filters, thresholds, cross-revision
aggregation and mobile UI. Existing account/interview/recovery suites remain green.
Cloud verification checks API resource acceptance, real healthy uptime samples,
matching real snapshot events and a synthetic notification delivery drill.

Deletion-ledger replication failures emit sanitized ERROR events caught by the
existing application-error policy. See [DELETION_LEDGER.md](DELETION_LEDGER.md).

Remaining Phase A work includes complete
infrastructure-as-code, live application email setup, priced usage reconciliation,
API quality comparison, expanded coaching and evaluator calibration. This milestone
does not add Mongo HA, PITR, automatic failover or a restore-time guarantee.

References: [snapshot alerts](https://docs.cloud.google.com/compute/docs/disks/create-alert-snapshot-schedule),
[metric absence activation](https://docs.cloud.google.com/monitoring/alerts/metric-absence),
[uptime checks](https://docs.cloud.google.com/monitoring/uptime-checks).
