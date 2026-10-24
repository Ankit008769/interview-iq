# Google Cloud staging

Project: `project-12b39f1f-9d49-456e-957` (Ankit's billing-enabled project).
Region: `asia-south1`. Cloud Run service: `interview-iq`.
URL: https://interview-iq-341474411884.asia-south1.run.app

The current service configuration permits public HTTP access; account and interview
data require application sign-in. Earlier staging used Identity-Aware Proxy (IAP). The IAP service agent has Cloud
Run Invoker access; Ankit's Google account has service-level IAP Web App User access.
External Gmail access requires the IAP OAuth consent/client configuration. The
initial deployment checks below predate IAP; ordinary CLI identity-token requests
are not a substitute for configuring IAP programmatic access.

The container serves React and the API together, with secure HTTP-only cookies.
It uses instance-based CPU allocation and one minimum/maximum instance so the
embedded background worker runs between requests. This keeps compute running.
No OpenAI key is configured: staging uses practice questions and unscored feedback.

MongoDB 7 runs on `interviewiq-mongo`, zone `asia-south1-b`, using an e2-small VM
and a separate 20 GB persistent disk `interviewiq-mongo-data` (auto-delete off).
The database listens through the VM's private address `10.42.0.10`; firewall
`interviewiq-mongo-private` permits port 27017 only from `10.42.0.0/24`.
Cloud Run reaches it through Direct VPC egress on `interviewiq-staging`.
The VM has an external address for outbound package/image downloads; MongoDB and
SSH are not opened to public ingress.

Secret Manager holds `interviewiq-mongodb-uri`, `interviewiq-jwt-secret`, and
`interviewiq-mongo-password`. Application credentials grant read/write access only
to the interviewiq database. The app service account can access only its URI and
JWT secrets; the Mongo VM service account can access its password secret.
The dedicated `interviewiq-build` account has the user-approved project-level
`roles/run.builder`. No secret values belong in Git or this document.

`deploy/mongo-startup.sh` mounts the data disk, configures Docker's mount dependency,
initializes/repairs the application user, and checks authenticated readiness.
Hourly snapshots with a seven-day retention policy are now active. A populated
MongoDB 7 restore drill passed on 24 October 2026. See [backup/restore evidence and
limitations](BACKUP_RESTORE.md). Alerting and production HA remain pending.

## Operations

Use the authenticated Google Cloud CLI with explicit project and region:

```sh
gcloud run services describe interview-iq --region=asia-south1 --project=project-12b39f1f-9d49-456e-957
gcloud run services logs read interview-iq --region=asia-south1 --project=project-12b39f1f-9d49-456e-957 --limit=50
```

Health `/api/health` must report `database: connected`. In the current configuration
this endpoint is public and is probed by Cloud Monitoring. Account and interview
endpoints reject unauthenticated application requests. If IAP is restored, update
monitoring authentication as well; never put identity tokens in logs or traces.

To suspend staging compute, set the Cloud Run minimum instances to zero and stop
the Mongo VM. Restore the VM and minimum instance count before expecting background
jobs to run. Disks, artifacts and other retained resources can still incur charges.
Billing credits and remaining balance are managed by the owner; their availability
has not been independently verified. No resources were deleted for this deployment.

GitHub Actions runs the builds and regression suites on pushes and pull requests.

Verified on 23 October 2026: 25 local backend tests, 9 local Chromium tests, and
a live HTTPS browser smoke covering database health, registration, secure cookies,
two saved answers with reload, worker completion, history, logout and login.

VM guest logs are available through serial-port output. The VM service account
does not currently have Cloud Logging writer permission; centralized VM log
shipping remains pending. Cloud Run application logs are available; native uptime,
backup and application monitoring are now configured. See [monitoring and consent](MONITORING_AND_CONSENT.md).

The live browser smoke also passed after a Mongo VM reboot. During the reboot,
health correctly returned 503, then recovered. A request without Google IAM
authentication returned 403 as intended.
