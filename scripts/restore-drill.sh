#!/usr/bin/env bash
# The restore drill (2026.11.10, READY; RECOVERY.md, "The drill"). Run from the unzipped folder in Cloud Shell, once a
# season and before the first busy weekend. It never changes the live database or the live site.
#   bash scripts/restore-drill.sh            1. copies the database server as it was 10 minutes ago into a new,
#                                               separate server (summitops-drill-<date>), timing how long it takes
#                                            2. compares the copy with the live database, table by table, and shows
#                                               the newest record in the copy (how much would have been lost)
#                                            3. points STAGING at the copy, so you can sign in and look around
#   bash scripts/restore-drill.sh --at 2026-11-08T14:05:00Z      a different moment (UTC) for step 1
#   bash scripts/restore-drill.sh --finish   points staging back at the real server and deletes the copy (it costs
#                                            money while it exists; run this the same day)
# Write down the times it prints in RECOVERY.md's drill log.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
SOURCE=summitops-db
STATE="$HOME/.summitops-drill"

FINISH=""; AT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --finish) FINISH=1 ;;
    --at) AT="${2:-}"; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
  shift
done

step "Checking you are signed in to Google Cloud"
signed_in

if [ -n "$FINISH" ]; then
  [ -f "$STATE" ] || { echo "No drill is running (nothing in $STATE)."; exit 1; }
  # shellcheck disable=SC1090
  source "$STATE"
  case "$DRILL" in summitops-drill-*) ;; *) echo "Refusing: $DRILL is not a drill copy."; exit 1 ;; esac
  step "Pointing staging back at $SOURCE"
  gcloud run services update "$STAGING_SERVICE" --region "$REGION" --quiet \
    --update-env-vars "DB_SOCKET=$OLD_SOCKET" --remove-cloudsql-instances "$DRILL_CONN" --add-cloudsql-instances "${OLD_SOCKET#/cloudsql/}"
  DAYOS_TARGET="$STAGING_SERVICE"; SERVICE="$STAGING_SERVICE"; load_service
  sleep 5; echo "Staging: $(curl -s "$(check_url)/readyz")"
  step "Deleting the copy $DRILL"
  gcloud sql instances delete "$DRILL" --quiet
  rm -f "$STATE"
  echo "Done. Staging uses $SOURCE again, and the copy is gone."
  exit 0
fi

[ -f "$STATE" ] && { echo "A drill is already running ($(cat "$STATE" | head -1)). Finish it first: bash scripts/restore-drill.sh --finish"; exit 1; }
if [ "$(gcloud sql instances describe "$SOURCE" --format='value(settings.backupConfiguration.binaryLogEnabled)')" != True ]; then
  echo "Point-in-time recovery is off on $SOURCE, so there is nothing to go back to. Run bash scripts/backups-setup.sh first."; exit 1
fi
AT="${AT:-$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ)}"
DRILL="summitops-drill-$(date -u +%m%d-%H%M)"

step "1. Copying $SOURCE as it was at $AT into $DRILL (often 10 to 30 minutes)"
T0=$(date +%s)
gcloud sql instances clone "$SOURCE" "$DRILL" --point-in-time="$AT"
# The copy is a separate server: it never gets deletion protection, so --finish can remove it.
gcloud sql instances patch "$DRILL" --no-deletion-protection --quiet >/dev/null 2>&1 || true
T1=$(date +%s)
DRILL_CONN="$(gcloud sql instances describe "$DRILL" --format='value(connectionName)')"
DAYOS_TARGET="$STAGING_SERVICE"; SERVICE="$STAGING_SERVICE"; load_service
OLD_SOCKET="$(envval DB_SOCKET)"
printf 'DRILL=%s\nDRILL_CONN=%s\nOLD_SOCKET=%s\nAT=%s\n' "$DRILL" "$DRILL_CONN" "$OLD_SOCKET" "$AT" > "$STATE"
echo "Copied in $(( (T1 - T0) / 60 )) minutes $(( (T1 - T0) % 60 )) seconds."

step "2. Comparing the copy with the live database"
SERVICE="$PROD_SERVICE"; load_service
AS=migrator open_db # the live database through the proxy on port 3307
PROXY="$HOME/cloud-sql-proxy"
"$PROXY" --gcloud-auth --port 3308 "$DRILL_CONN" >/tmp/cloud-sql-proxy-drill.log 2>&1 &
DRILL_PROXY=$!
trap '[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null; kill "$DRILL_PROXY" 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/3308) 2>/dev/null && break; sleep 1; done
DRILL_PORT=3308 DRILL_AT="$AT" node scripts/restore-check.js

step "3. Pointing staging at the copy"
gcloud run services update "$STAGING_SERVICE" --region "$REGION" --quiet \
  --add-cloudsql-instances "$DRILL_CONN" --update-env-vars "DB_SOCKET=/cloudsql/$DRILL_CONN"
T2=$(date +%s)
DAYOS_TARGET="$STAGING_SERVICE"; SERVICE="$STAGING_SERVICE"; load_service
sleep 5
echo "Staging: $(curl -s "$(check_url)/readyz")"
echo ""
echo "From the start to a working copy: $(( (T2 - T0) / 60 )) minutes. Target: under 60."
echo "Open staging, sign in, and check a few records from before $AT are there (staging's own data, as it was then)."
echo "When you are done, the same day:   bash scripts/restore-drill.sh --finish"
