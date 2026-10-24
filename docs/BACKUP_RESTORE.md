# MongoDB backup and restore runbook

Verified 24 October 2026 in project `project-12b39f1f-9d49-456e-957`.
The application remains private staging, with a single MongoDB VM.

## Active backups

- Source disk: `interviewiq-mongo-data`, zone `asia-south1-b`.
- Snapshot policy: `interviewiq-hourly-7d`, region `asia-south1`.
- Frequency: hourly. Storage location: `asia-south1`.
- Scheduled retention: seven days; apply retention when source disk is deleted.
- Multiple automatically created snapshots were confirmed READY after attachment.

These are crash-consistent disk snapshots, not point-in-time recovery or a replica.
Journal recovery was tested on a copy. An hourly schedule is not a guaranteed maximum
one-hour RPO: failed/delayed snapshots extend the gap, and alerting is still pending.
Google only automatically removes an expired snapshot when a newer snapshot exists;
manual snapshots are not governed by this policy. Seven days is therefore a configured
retention policy, not an unconditional deletion deadline. Monitor snapshot age and
retention, especially during suspension. Snapshot storage consumes project credits.

Creation commands (already applied; do not create a duplicate policy):

```sh
gcloud compute resource-policies create snapshot-schedule interviewiq-hourly-7d --project=project-12b39f1f-9d49-456e-957 --region=asia-south1 --hourly-schedule=1 --start-time=00:00 --max-retention-days=7 --on-source-disk-delete=apply-retention-policy --storage-location=asia-south1
gcloud compute disks add-resource-policies interviewiq-mongo-data --project=project-12b39f1f-9d49-456e-957 --zone=asia-south1-b --resource-policies=interviewiq-hourly-7d
```

Check policy attachment and backup freshness:

```sh
gcloud compute disks describe interviewiq-mongo-data --project=project-12b39f1f-9d49-456e-957 --zone=asia-south1-b --format='json(resourcePolicies)'
gcloud compute resource-policies describe interviewiq-hourly-7d --project=project-12b39f1f-9d49-456e-957 --region=asia-south1
gcloud compute snapshots list --project=project-12b39f1f-9d49-456e-957 --filter='sourceDisk:interviewiq-mongo-data' --sort-by='~creationTimestamp' --format='table(name,status,creationTimestamp,autoCreated)'
```

## Completed isolated restore drill

A manual snapshot `interviewiq-drill-20261024` was restored into the separate disk
`interviewiq-restore-drill-20261024`. A temporary e2-small Debian 12 VM named
`interviewiq-restore-check-20261024` used that disk as a non-boot disk. The VM had no
service account/scopes or Mongo firewall tag; its database container had no network
interface (`--network none`) and published no ports. Its external address was used
only for downloading packages and the Mongo image. The live disk, application service
and secrets were not changed by the drill.

`deploy/restore-drill.sh` mounted the existing filesystem without formatting it,
started MongoDB 7 on the copy, let its journal recover, ran full collection validation,
checked populated application collections, the unique email index and interview owner
fields, and stopped the container. No user record content was printed. Result:

```json
{"collectionsValidated":3,"users":3,"interviews":3,"uniqueEmailIndex":true}
```

Serial log marker: `INTERVIEWIQ_RESTORE_PASS` at 05:28:07 UTC on 24 October 2026
(10:58:07 IST). The temporary VM, auto-delete boot/restore disks and manual snapshot
were removed after the drill; scheduled snapshots remain. This verifies a populated
MongoDB 7 restore, not automated application failover or a contractual RTO.

To repeat, choose an existing READY snapshot, create a NEW disk in the target zone,
and create a temporary VM with a DIFFERENT name from the data disk (avoids a boot-disk
name collision). Attach the disk as `device-name=restore-data,mode=rw,boot=no`, use
`--no-service-account --no-scopes`, and set
`--metadata-from-file=startup-script=deploy/restore-drill.sh`. Do not add ingress tags
or expose ports. Read serial output for PASS/FAILED; inspect counts and validation.
Delete only the temporary VM/disks after recording the result. The script deliberately
uses no auth only inside a network-disabled container; never use it on a live host.

## Before an actual promotion

1. Stop application writes/workers and identify the latest healthy backup and
   authoritative deletion receipts/pending deletions. Record the data-loss interval.
2. Restore a new disk; preserve the original. Validate the isolated copy as above.
3. Merge current `accountdeletions` receipts with those restored. Include live users
   with `deletionRequestedAt`, even if cleanup has not run. Remove those IDs from
   users, interviews, AI usage, sessions, action tokens and owned quota buckets.
   Receipts contain only opaque IDs and timestamps; transfer them securely, never
   through Git or public logs. If the authoritative record is lost, reconcile with
   the owner before promotion rather than silently resurrecting deleted accounts.
4. Delete ALL restored `authsessions` and `accounttokens`, forcing sign-in and fresh
   recovery links. Restore can otherwise revive revoked sessions. Old JWT deployments
   also need signing-secret rotation when restoring a Phase 0 image.
5. Configure authenticated MongoDB and private-only networking before connecting the
   app. The data snapshot includes application-user credentials, but the root password
   file is on the original VM's boot disk and is not part of this data backup. Recover
   admin access only on the isolated copy, or use the surviving secured root credentials.
   Confirm the app URI/Secret Manager version matches; do not print credentials.
6. Connect a controlled staging revision, check database health, sign-in, owner
   isolation, an interview/worker completion and history. Resume writes only after
   the checks and deletion reconciliation pass. Roll back to the preserved disk if
   needed; keep the outage/write boundary explicit to avoid divergent data.

Independent deletion-ledger replication, backup failure/age alerts, infrastructure
as code, cross-region DR, logical exports and automated promotion remain follow-up
work. This milestone does not make the single-VM deployment production HA.

References: [Google snapshot schedules](https://docs.cloud.google.com/compute/docs/disks/scheduled-snapshots),
[retention behavior](https://docs.cloud.google.com/compute/docs/disks/about-snapshot-schedules),
[snapshot consistency and restore validation](https://docs.cloud.google.com/compute/docs/disks/snapshot-best-practices).
