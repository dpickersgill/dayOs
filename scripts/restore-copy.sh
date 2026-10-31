#!/usr/bin/env bash
# Restores the database onto a NEW server when the old one is gone or cannot be cloned (RECOVERY.md, "Restoring the
# database", step 3). Run from the unzipped folder in Cloud Shell. It never changes the live server or the live site.
#   bash scripts/restore-copy.sh --weekly              from the newest weekly copy in the backup bucket
#   bash scripts/restore-copy.sh --weekly <gs://...#generation>   from an older weekly copy (gcloud storage ls -a lists them)
#   bash scripts/restore-copy.sh --backup <BACKUP_ID>  from a daily backup (gcloud sql backups list --instance summitops-db)
# Options:
#   --name <server>            the new server's name (default summitops-restored)
#   --private-network <vpc>    give the new server a private address on that network and no public address
#
# What it does (2026.11.11):
#   1. Makes the new server with the same protections as the live one: encrypted connections only, deletion protection,
#      daily backups (14 kept) and point-in-time recovery (7 days). A random root password, never shown.
#   2. Weekly copy: lets the new server read the backup bucket for the import, then takes that away again.
#   3. Makes the logins the app needs. A weekly copy holds the data but not the logins: the migration login (from the
#      summitops-db-migrator secret) and the app's login summitops_app (summitops-db-app-password, its rows-only grants)
#      are made on the new server with the SAME passwords, so the app can be pointed at it without changing a secret.
#      Passwords go through stdin and the request body, never a command line.
#   4. Checks the copy (scripts/restore-check.js) and prints the command that points the app at it.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
SOURCE=summitops-db
NEW=summitops-restored
FROM=""; ARG=""; NET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --weekly) FROM=weekly; case "${2:-}" in gs://*) ARG="$2"; shift ;; esac ;;
    --backup) FROM=backup; ARG="${2:-}"; shift ;;
    --name) NEW="${2:-}"; shift ;;
    --private-network) NET="${2:-}"; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
  shift
done
[ -n "$FROM" ] || { echo "Say where from: --weekly, or --backup <BACKUP_ID>. RECOVERY.md explains which."; exit 1; }
[ "$FROM" != backup ] || [ -n "$ARG" ] || { echo "Name the backup: gcloud sql backups list --instance $SOURCE"; exit 1; }
case "$NEW" in summitops-db|"") echo "Refusing: the new server must not be the live one."; exit 1 ;; esac
TIER="${TIER:-db-g1-small}"
DBNAME="${DBNAME:-summitops}"
COPY="${ARG:-$BACKUP_BUCKET/weekly/summitops.sql.gz}"

step "Checking you are signed in to Google Cloud"
signed_in

step "1. A new server, $NEW, with the live server's protections"
if gcloud sql instances describe "$NEW" >/dev/null 2>&1; then
  echo "$NEW is already there (a run that stopped part way). Carrying on with it."
else
  NETFLAGS=()
  [ -n "$NET" ] && NETFLAGS=(--network="projects/$PROJECT/global/networks/$NET" --no-assign-ip)
  gcloud sql instances create "$NEW" --database-version=MYSQL_8_4 --edition=enterprise --tier="$TIER" --region="$REGION" \
    --storage-type=SSD --storage-size=10 --storage-auto-increase --ssl-mode=ENCRYPTED_ONLY --deletion-protection \
    --backup-start-time=07:00 --retained-backups-count=14 --enable-bin-log --retained-transaction-log-days=7 "${NETFLAGS[@]}"
fi
openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40 | sql_user_set "$NEW" root
NEW_CONN="$(gcloud sql instances describe "$NEW" --format='value(connectionName)')"
NEW_SA="$(gcloud sql instances describe "$NEW" --format='value(serviceAccountEmailAddress)')"

if [ "$FROM" = backup ]; then
  step "2. Restoring backup $ARG of $SOURCE onto $NEW (10 to 30 minutes)"
  gcloud sql backups restore "$ARG" --restore-instance="$NEW" --backup-instance="$SOURCE" --quiet
else
  step "2. Importing $COPY into $NEW (10 to 30 minutes)"
  BUCKET_ONLY="$(echo "$COPY" | sed -E 's#^(gs://[^/]+).*#\1#')"
  # The new server has its own service account, which cannot read the bucket until it is allowed to.
  gcloud storage buckets add-iam-policy-binding "$BUCKET_ONLY" --member="serviceAccount:$NEW_SA" --role=roles/storage.objectViewer --quiet >/dev/null
  echo "  $NEW_SA may read $BUCKET_ONLY for the import."
  gcloud sql databases describe "$DBNAME" --instance="$NEW" >/dev/null 2>&1 || \
    gcloud sql databases create "$DBNAME" --instance="$NEW" --charset=utf8mb4 --collation=utf8mb4_0900_ai_ci --quiet
  set +e
  gcloud sql import sql "$NEW" "$COPY" --database="$DBNAME" --quiet
  RC=$?
  set -e
  gcloud storage buckets remove-iam-policy-binding "$BUCKET_ONLY" --member="serviceAccount:$NEW_SA" --role=roles/storage.objectViewer --quiet >/dev/null || true
  echo "  $NEW_SA may no longer read $BUCKET_ONLY."
  [ $RC -eq 0 ] || { echo "The import failed. Look at: gcloud sql operations list --instance $NEW --limit 3"; exit 1; }
fi

step "3. The logins the app uses, with the same passwords as on $SOURCE"
# The live database's migration login (summitops-db-migrator after harden.sh, or the one login before it), through the
# Cloud SQL Auth Proxy on 127.0.0.1:3307. The same login is made on the new server.
load_service
AS=migrator open_db
printf %s "$DB_PASSWORD" | sql_user_set "$NEW" "$DB_USER"
echo "  $DB_USER (migrations) is on $NEW."
"$(proxy_path)" --gcloud-auth --port 3308 "$NEW_CONN" >/tmp/cloud-sql-proxy-restore.log 2>&1 &
RPID=$!
trap 'kill "$RPID" 2>/dev/null || true; [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/3308) 2>/dev/null && break; sleep 1; done
if [ "$(envval DB_USER)" = summitops_app ] && secret_exists summitops-db-app-password; then
  secret_read summitops-db-app-password | DB_PORT=3308 DB_NAME="$DBNAME" node scripts/db-runtime-user.js summitops_app -
  echo "  summitops_app (the app: rows only, audit tables read and add) is on $NEW."
fi

step "4. Comparing the copy with the live database (reads only)"
DRILL_PORT=3308 DRILL_DB_NAME="$DBNAME" node scripts/restore-check.js || echo "Look at what the check says above before pointing the app at $NEW."

cat <<EOT

$NEW is ready. Compare it with the live database (RECOVERY.md, step 4), then point the app at it (step 5):
  gcloud run services update $PROD_SERVICE --region $REGION --add-cloudsql-instances $NEW_CONN --update-env-vars DB_SOCKET=/cloudsql/$NEW_CONN
Once the app runs on it, back it up like the old one (the weekly copy then comes from $NEW):
  INSTANCE=$NEW bash scripts/backups-setup.sh
EOT
