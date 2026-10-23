#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/interviewiq-startup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y docker.io curl jq openssl
systemctl enable --now docker
install -d -m 700 /etc/interviewiq
install -d /var/lib/interviewiq/mongo
DATA_DEVICE=/dev/disk/by-id/google-mongo-data
for attempt in $(seq 1 30); do [ -b "$DATA_DEVICE" ] && break; sleep 2; done
[ -b "$DATA_DEVICE" ] || { echo 'Mongo data disk missing'; exit 1; }
if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then mkfs.ext4 -F "$DATA_DEVICE"; fi
# Stop an existing container before mounting; Docker may have started during boot.
docker stop interviewiq-mongo >/dev/null 2>&1 || true
mountpoint -q /var/lib/interviewiq/mongo || mount "$DATA_DEVICE" /var/lib/interviewiq/mongo
DISK_UUID=$(blkid -s UUID -o value "$DATA_DEVICE")
grep -q "UUID=$DISK_UUID " /etc/fstab || printf 'UUID=%s /var/lib/interviewiq/mongo ext4 defaults 0 2\n' "$DISK_UUID" >> /etc/fstab
install -d /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/var/lib/interviewiq/mongo\n' > /etc/systemd/system/docker.service.d/interviewiq-disk.conf
systemctl daemon-reload
PROJECT=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id)
TOKEN=$(curl -fsS -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -r .access_token)
PASSWORD=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/interviewiq-mongo-password/versions/latest:access" | jq -r .payload.data | base64 -d)
unset TOKEN
if [ ! -f /etc/interviewiq/mongo.env ]; then
  umask 077
  printf 'MONGO_INITDB_ROOT_USERNAME=root\nMONGO_INITDB_ROOT_PASSWORD=%s\nMONGO_APP_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$PASSWORD" > /etc/interviewiq/mongo.env
fi
unset PASSWORD
cat > /etc/interviewiq/init.js <<'JS'
const application = db.getSiblingDB('interviewiq');
application.createUser({ user: 'interviewiq', pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: 'readWrite', db: 'interviewiq' }] });
JS
chmod 644 /etc/interviewiq/init.js
if ! docker container inspect interviewiq-mongo >/dev/null 2>&1; then
  docker run -d --name interviewiq-mongo --restart unless-stopped --memory=1200m \
    -p 10.42.0.10:27017:27017 --env-file /etc/interviewiq/mongo.env \
    -v /var/lib/interviewiq/mongo:/data/db \
    -v /etc/interviewiq/init.js:/docker-entrypoint-initdb.d/init.js:ro \
    mongo:7 --wiredTigerCacheSizeGB 0.35
else
  docker start interviewiq-mongo
fi
for attempt in $(seq 1 60); do
  if timeout 10 docker exec interviewiq-mongo mongosh --quiet --eval '
    const admin = db.getSiblingDB("admin");
    if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD).ok) quit(1);
    const app = db.getSiblingDB("interviewiq");
    if (!app.getUser("interviewiq")) app.createUser({user:"interviewiq",pwd:process.env.MONGO_APP_PASSWORD,roles:[{role:"readWrite",db:"interviewiq"}]});
    print("APP_USER_READY");
  ' | grep -q APP_USER_READY; then
    echo 'INTERVIEWIQ_MONGO_READY'; exit 0
  fi
  sleep 2
done
echo 'MongoDB did not become ready'; exit 1
