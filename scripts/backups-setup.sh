#!/usr/bin/env bash
# Backups, checked and switched on (2026.11.10, READY). Run once from the unzipped folder in Cloud Shell, and again any
# time to check:   bash scripts/backups-setup.sh
# RECOVERY.md says what each part is for. It reads the database server's settings, says what is on, and turns on
# what is missing:
#   1. Daily automated backups at 07:00 UTC (2 or 3 AM Eastern), 14 kept
#   2. Point-in-time recovery (binary logs) kept 7 days, so the database can go back to any minute of the last week
#   3. Deletion protection, so the server cannot be deleted by accident
#   4. A weekly copy of the whole database outside the server, in a Cloud Storage bucket, every version kept a year
#      (automated backups are lost if the server itself is ever deleted; this copy is not)
# Options:
#   --ha        also make the database server highly available (a standby in a second zone; about twice the database
#               cost). Without it, losing the server's zone means restoring from backup (RECOVERY.md).
#   --dry-run   print what would change, change nothing
# Turning on point-in-time recovery or high availability restarts the database (a minute or two): it asks first.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
INSTANCE="${INSTANCE:-summitops-db}"
BUCKET="gs://${PROJECT}-backups"
BACKUP_SA="summitops-backup@${PROJECT}.iam.gserviceaccount.com"
JOB=summitops-weekly-export

DRY=""; HA=""
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; --ha) HA=1 ;; *) echo "Unknown option $a"; exit 1 ;; esac; done
run() { if [ -n "$DRY" ]; then printf '  would run: %s\n' "$*"; else "$@"; fi; }

step "Checking you are signed in to Google Cloud"
signed_in

step "Reading the database server's backup settings"
SQL="$(gcloud sql instances describe "$INSTANCE" --format=json)"
get() { echo "$SQL" | jq -r "$1 // empty"; }
ON="$(get '.settings.backupConfiguration.enabled')"
BINLOG="$(get '.settings.backupConfiguration.binaryLogEnabled')"
KEPT="$(get '.settings.backupConfiguration.backupRetentionSettings.retainedBackups')"
LOGDAYS="$(get '.settings.backupConfiguration.transactionLogRetentionDays')"
START="$(get '.settings.backupConfiguration.startTime')"
PROTECTED="$(get '.settings.deletionProtectionEnabled')"
AVAIL="$(get '.settings.availabilityType')"
echo "  Daily backups:            ${ON:-false} (at ${START:-?} UTC, ${KEPT:-?} kept)"
echo "  Point-in-time recovery:   ${BINLOG:-false} (${LOGDAYS:-?} days of logs)"
echo "  Deletion protection:      ${PROTECTED:-false}"
echo "  High availability:        $([ "$AVAIL" = REGIONAL ] && echo on || echo off)"

PATCH=(); RESTARTS=""
[ "$ON" = true ] || PATCH+=(--backup-start-time=07:00)
[ "${KEPT:-0}" -ge 14 ] 2>/dev/null || PATCH+=(--retained-backups-count=14)
if [ "$BINLOG" != true ]; then PATCH+=(--enable-bin-log); RESTARTS="point-in-time recovery"; fi
[ "${LOGDAYS:-0}" -ge 7 ] 2>/dev/null || PATCH+=(--retained-transaction-log-days=7)
[ "$PROTECTED" = true ] || PATCH+=(--deletion-protection)
if [ -n "$HA" ] && [ "$AVAIL" != REGIONAL ]; then PATCH+=(--availability-type=REGIONAL); RESTARTS="${RESTARTS:+$RESTARTS and }high availability"; fi

step "Turning on what is missing"
if [ "${#PATCH[@]}" -eq 0 ]; then
  echo "  Nothing: every backup setting is on."
else
  if [ -n "$RESTARTS" ] && [ -z "$DRY" ]; then
    echo "  Turning on $RESTARTS restarts the database server: the app stops answering for a minute or two."
    read -r -p "  Type restart to go ahead now (do it after closing time), anything else to skip those: " OK
    if [ "$OK" != restart ]; then
      PATCH=("${PATCH[@]/--enable-bin-log}"); PATCH=("${PATCH[@]/--availability-type=REGIONAL}")
      echo "  Skipped. Run this again after closing time to turn them on."
    fi
  fi
  CLEAN=(); for p in "${PATCH[@]}"; do [ -n "$p" ] && CLEAN+=("$p"); done
  if [ "${#CLEAN[@]}" -gt 0 ]; then run gcloud sql instances patch "$INSTANCE" "${CLEAN[@]}" --quiet; echo "  Changed: ${CLEAN[*]}"; fi
fi

step "A weekly copy outside the database server"
if ! gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1; then
  run gcloud storage buckets create "$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
fi
# Every weekly copy has the same name; the bucket keeps each older version for a year, then deletes it.
run gcloud storage buckets update "$BUCKET" --versioning
LIFE="$(mktemp)"
echo '{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"daysSinceNoncurrentTime":365}}]}' > "$LIFE"
run gcloud storage buckets update "$BUCKET" --lifecycle-file="$LIFE"
rm -f "$LIFE"
# The database server writes the copy into the bucket itself.
SQL_SA="$(gcloud sql instances describe "$INSTANCE" --format='value(serviceAccountEmailAddress)')"
run gcloud storage buckets add-iam-policy-binding "$BUCKET" --member="serviceAccount:$SQL_SA" --role=roles/storage.objectAdmin --quiet >/dev/null
# Cloud Scheduler asks for the copy every Tuesday at 08:00 UTC (3 or 4 AM Eastern), as an account that may only do that.
if ! gcloud iam service-accounts describe "$BACKUP_SA" >/dev/null 2>&1; then
  run gcloud iam service-accounts create summitops-backup --display-name "Verdynt/OS weekly database copy"
fi
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BACKUP_SA" --role=roles/cloudsql.viewer --condition=None --quiet >/dev/null
run gcloud services enable cloudscheduler.googleapis.com --quiet
load_service; DBNAME="$(envval DB_NAME)"; DBNAME="${DBNAME:-summitops}"
BODY="{\"exportContext\":{\"fileType\":\"SQL\",\"uri\":\"$BUCKET/weekly/summitops.sql.gz\",\"databases\":[\"$DBNAME\"]}}"
URI="https://sqladmin.googleapis.com/v1/projects/$PROJECT/instances/$INSTANCE/export"
if gcloud scheduler jobs describe "$JOB" --location "$REGION" >/dev/null 2>&1; then
  run gcloud scheduler jobs update http "$JOB" --location "$REGION" --schedule="0 8 * * 2" --time-zone=Etc/UTC --uri="$URI" --http-method=POST \
    --message-body="$BODY" --oauth-service-account-email="$BACKUP_SA" --quiet
else
  run gcloud scheduler jobs create http "$JOB" --location "$REGION" --schedule="0 8 * * 2" --time-zone=Etc/UTC --uri="$URI" --http-method=POST \
    --message-body="$BODY" --oauth-service-account-email="$BACKUP_SA" --quiet
fi
echo "  Every Tuesday at 08:00 UTC: $BUCKET/weekly/summitops.sql.gz (older copies kept a year)."
echo "  Make the first copy now:   gcloud scheduler jobs run $JOB --location $REGION"

echo ""
if [ -n "$DRY" ]; then echo "Dry run: nothing was changed."; else
  echo "Done. Check it in the Cloud console: SQL, $INSTANCE, Backups. RECOVERY.md has the restore steps and the drill."
fi
