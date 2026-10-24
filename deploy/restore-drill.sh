#!/bin/bash
# Isolated restore drill ONLY. Never run this on the live MongoDB host.
set -euo pipefail
trap 'echo INTERVIEWIQ_RESTORE_FAILED' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y docker.io
systemctl enable --now docker
DATA_DEVICE=/dev/disk/by-id/google-restore-data
for attempt in $(seq 1 30); do [ -b "$DATA_DEVICE" ] && break; sleep 2; done
[ -b "$DATA_DEVICE" ]
mkdir -p /var/lib/interviewiq-restore
# Never format: the point is to test an existing snapshot's filesystem and journal.
mount "$DATA_DEVICE" /var/lib/interviewiq-restore
docker run -d --name restore-check --network none --memory=1200m \
  -v /var/lib/interviewiq-restore:/data/db mongo:7 \
  --bind_ip 127.0.0.1 --noauth --wiredTigerCacheSizeGB 0.35
for attempt in $(seq 1 90); do
  if docker exec restore-check mongosh --quiet --eval 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec restore-check mongosh --quiet --eval '
const app = db.getSiblingDB("interviewiq");
const names = app.getCollectionNames();
if (!names.includes("users") || !names.includes("interviews")) throw new Error("Missing application collections");
for (const name of names) {
  const result = app.runCommand({validate:name,full:true});
  if (!result.ok || !result.valid) throw new Error("Collection validation failed");
}
const users = app.users.countDocuments();
const interviews = app.interviews.countDocuments();
if (users < 1 || interviews < 1) throw new Error("Expected populated staging data");
if (!app.users.getIndexes().some(i => i.key.email === 1 && i.unique)) throw new Error("Unique email index missing");
if (app.interviews.countDocuments({userId:{$exists:false}})) throw new Error("Interview owner missing");
print(JSON.stringify({collectionsValidated:names.length,users,interviews,uniqueEmailIndex:true}));
print("INTERVIEWIQ_RESTORE_PASS");
'
docker stop restore-check
