# Infrastructure as code (Terraform)

Added 25 October 2026 for Phase A1. `infra/terraform/staging/` describes the staging
environment that was first built by hand (see [GOOGLE_CLOUD_STAGING.md](GOOGLE_CLOUD_STAGING.md)).
**Read-only adoption audit completed 25 October 2026:** Terraform 1.9.8 with
Google provider 6.50.0 produced **29 imports, zero creates, updates or destroys**.
The import-only guard passed. No apply was run and remote state adoption is still
pending. The audit used an isolated local backend outside Git and a short-lived
CLI access token; no secret payloads were read.

The scaffold was reconciled with live private Google access, OS Login, invoker
check bypass, service/revision scaling and startup CPU boost. There is no
`allUsers` invoker IAM binding to import. Release tooling owns the environment
variables (including pinned secret versions and deployment commit), image and
build metadata. Terraform ignores those fields after import; review deployment
configuration separately. Provider 6.50.0 cannot represent the service-level
maximum of 1: verify it before and after any future Cloud Run infrastructure
update, or upgrade the provider to manage it explicitly. Do not infer the effective
limit from the revision maximum of 10.

## What it manages

| Area | Resources |
|---|---|
| APIs | Compute, Cloud Run, Secret Manager, IAM, Storage, Artifact Registry, Cloud Build, Logging, Monitoring (never disabled on destroy) |
| Network | `interviewiq-staging` VPC and subnet `10.42.0.0/24`; firewall `interviewiq-mongo-private` (TCP 27017 from the subnet only) |
| Database | VM `interviewiq-mongo` (e2-small, asia-south1-b, startup script `deploy/mongo-startup.sh`), data disk `interviewiq-mongo-data` (device `mongo-data`), snapshot policy `interviewiq-hourly-7d` and its attachment |
| Identity | Service accounts `interviewiq-app`, `interviewiq-build` and the Mongo VM account; secret containers `interviewiq-mongodb-uri`, `interviewiq-jwt-secret`, `interviewiq-mongo-password` (never their values); per-secret accessor grants; `roles/run.builder` for the build account |
| Deletion ledger | `interviewiq-deletion-ledger-341474411884` (uniform access, public access prevented, 30-day unlocked retention) and the app's create-only grant |
| App | Cloud Run `interview-iq`: one always-on instance, CPU always allocated, Direct VPC egress; release-owned environment and pinned secret references; IAM invoker check disabled while staging stays public |

Not managed here (yet): monitoring and alerts (still applied by
`deploy/configure-monitoring.mjs`), IAP and its OAuth configuration, the Artifact
Registry repository and Cloud Build plumbing used by source deploys, OS-level VM
setup (the startup script), and secret values.

## Safety rails

- **Adopt, don't create.** `imports.tf` imports every existing resource. The first
  plan should contain only imports.
- **`prevent_destroy`** on the Mongo VM (its boot disk holds the database root
  credentials), the data disk, all three secrets and the deletion-ledger bucket.
  Cloud Run has `deletion_protection`. Never run `terraform destroy` on staging.
- **Additive IAM only** (`*_iam_member`). Grants made outside Terraform are never
  removed.
- **Fields that would force replacement are ignored after import:** the VM boot image
  and size, secret replication, disk snapshot/image sources.
- **Releases stay outside Terraform.** The Cloud Run environment, image, revision and build/deploy
  metadata are ignored, so `gcloud run deploy` and CI keep working.
- **`infra/terraform/plan-guard.mjs`** fails on any delete or replacement and, with
  `--adopt`, on any create or update too. Malformed, errored, incomplete and
  deferred plans or unknown actions fail closed. Use saved-plan JSON, not state JSON.
- State contains resource metadata but no secret values. Keep the state bucket private
  and versioned; plans and state are gitignored.

## One-time adoption (project owner)

Run from the repository root with Terraform ≥ 1.7 (CI uses 1.9.8).

1. Authenticate: `gcloud auth login` and `gcloud auth application-default login`.
2. Create the private, versioned state bucket (once):
   ```sh
   gcloud storage buckets create gs://interviewiq-tfstate-341474411884 --project=project-12b39f1f-9d49-456e-957 --location=asia-south1 --uniform-bucket-level-access --public-access-prevention
   gcloud storage buckets update gs://interviewiq-tfstate-341474411884 --versioning
   ```
3. Initialise and plan:
   ```sh
   terraform -chdir=infra/terraform/staging init -backend-config="bucket=interviewiq-tfstate-341474411884"
   terraform -chdir=infra/terraform/staging plan -out=tfplan
   terraform -chdir=infra/terraform/staging show -json tfplan | node infra/terraform/plan-guard.mjs --adopt
   ```
4. **Run a fresh plan and reconcile until the guard passes.** The audit above is a
   point-in-time check, not permission to apply an old plan. Values marked `CONFIRM` in
   `variables.tf` were never recorded: subnet name and private Google access, Mongo
   network tag, service-account ID, disk type, Cloud Run CPU, memory and VPC egress
   mode, and any extra environment variables. If an import fails, fix the name. If a
   resource shows an update, edit the variable defaults (or the resource) to match the
   live value. Never apply to "fix" a difference you don't understand. Commit the
   reconciled defaults; they are not secrets.
5. Apply the import-only plan: `terraform -chdir=infra/terraform/staging apply tfplan`.
   This changes nothing in the cloud; it records the resources in state.
6. Confirm with a fresh `plan` showing no changes.

## Day-to-day changes

Change the `.tf` files in a pull request, then `plan -out=tfplan`, run the guard
without `--adopt`, review, and `apply tfplan`. CI runs `terraform fmt -check` and
`validate` on every push without credentials; it never plans or applies.

A production environment should be a separate state (for example
`infra/terraform/production` or a shared module with per-environment variables), with
its own project, high-availability MongoDB and no public invoker.
