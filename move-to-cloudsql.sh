#!/usr/bin/env bash
# Moves the SummitOps database from Aiven to Cloud SQL (MySQL 8.4 in us-east1, next to the app). Run it once, from the
# unzipped folder in Cloud Shell, after `bash deploy.sh` has put this release live:
#   bash move-to-cloudsql.sh
# Safe to run again if it stops part way: each step checks what is already done. The Aiven database is not changed, so
# going back is one command (printed at the end).
set -euo pipefail
PROJECT=summitops-510715
SERVICE=summitops-api
REGION=us-east1
INSTANCE=summitops-db
DBNAME=summitops
DBUSER=summitops
SECRET=summitops-cloudsql-password
TIER="${TIER:-db-g1-small}" # shared core, 1.7 GB memory: plenty for a few mountains. Change later with one command.

step() { printf '\n== %s\n' "$1"; }

step "Checking you are signed in to Google Cloud"
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "Not signed in. Run: gcloud auth login   then: gcloud config set project $PROJECT   then run this again."
  exit 1
fi
gcloud config set project "$PROJECT" >/dev/null 2>&1

step "Reading the current database settings"
SVC_JSON="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
envval() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .value // empty'; }
secretof() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .valueFrom.secretKeyRef.name // empty'; }
if [ -n "$(envval DB_SOCKET)" ]; then
  echo "The app already uses Cloud SQL ($(envval DB_SOCKET)). Nothing to do."
  exit 0
fi
export SRC_HOST="$(envval DB_HOST)" SRC_PORT="$(envval DB_PORT)" SRC_USER="$(envval DB_USER)" SRC_NAME="$(envval DB_NAME)" SRC_SSL=true
OLD_PW_SECRET="$(secretof DB_PASSWORD)"
export SRC_PASSWORD="$(gcloud secrets versions access latest --secret="$OLD_PW_SECRET")"
export SRC_CA="$(gcloud secrets versions access latest --secret="$(secretof DB_CA)")"
echo "Copying from $SRC_HOST (database $SRC_NAME)"

step "Turning on Cloud SQL"
gcloud services enable sqladmin.googleapis.com

step "Creating the database server (this takes 5 to 10 minutes the first time)"
if gcloud sql instances describe "$INSTANCE" >/dev/null 2>&1; then
  echo "Already there."
else
  gcloud sql instances create "$INSTANCE" --database-version=MYSQL_8_4 --edition=enterprise --tier="$TIER" --region="$REGION" \
    --storage-type=SSD --storage-size=10 --storage-auto-increase \
    --backup-start-time=07:00 --enable-bin-log --retained-backups-count=14 --deletion-protection \
    --root-password="$(openssl rand -hex 24)"
fi
CONN="$(gcloud sql instances describe "$INSTANCE" --format='value(connectionName)')"

step "Creating the SummitOps database and its login"
if ! gcloud sql databases describe "$DBNAME" --instance="$INSTANCE" >/dev/null 2>&1; then
  gcloud sql databases create "$DBNAME" --instance="$INSTANCE" --charset=utf8mb4 --collation=utf8mb4_0900_ai_ci
fi
if gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  PW="$(gcloud secrets versions access latest --secret="$SECRET")"
else
  PW="$(openssl rand -hex 24)"
  printf '%s' "$PW" | gcloud secrets create "$SECRET" --data-file=-
fi
if gcloud sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$DBUSER"; then
  gcloud sql users set-password "$DBUSER" --instance="$INSTANCE" --host=% --password="$PW"
else
  gcloud sql users create "$DBUSER" --instance="$INSTANCE" --host=% --password="$PW"
fi

step "Letting the app use it"
SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
SA="${SA:-$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com}"
gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" --role=roles/cloudsql.client --condition=None >/dev/null
echo "Done for $SA"

step "Connecting to it from here"
PROXY="$HOME/cloud-sql-proxy"
if [ ! -x "$PROXY" ]; then
  curl -sSfo "$PROXY" https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.26.0/cloud-sql-proxy.linux.amd64
  chmod +x "$PROXY"
fi
"$PROXY" --gcloud-auth --port 3307 "$CONN" >/tmp/cloud-sql-proxy.log 2>&1 &
PROXY_PID=$!
trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do (echo > /dev/tcp/127.0.0.1/3307) 2>/dev/null && break; sleep 1; done
if ! (echo > /dev/tcp/127.0.0.1/3307) 2>/dev/null; then echo "Could not connect. Details:"; cat /tmp/cloud-sql-proxy.log; exit 1; fi

export DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER="$DBUSER" DB_PASSWORD="$PW" DB_NAME="$DBNAME" DB_SSL=false NODE_ENV=production
export JWT_SECRET="$(gcloud secrets versions access latest --secret="$(secretof JWT_SECRET)")"

step "Installing"
npm install --omit=dev --no-audit --no-fund >/dev/null

step "Setting up the tables"
npm run migrate

step "Copying the data (keep this window open; anything changed in the app from now until the switch is not copied)"
node db/copy-db.js
npm run migrate >/dev/null # the same check again, now with the data in place

step "Switching the app to Cloud SQL"
# Aiven's settings stay on the service (unused while DB_SOCKET is set), so going back is quick.
gcloud run services update "$SERVICE" --region "$REGION" --quiet \
  --add-cloudsql-instances "$CONN" \
  --update-env-vars "DB_SOCKET=/cloudsql/$CONN,DB_USER=$DBUSER,DB_NAME=$DBNAME,DB_SSL=false" \
  --update-secrets "DB_PASSWORD=$SECRET:latest"

step "Checking the app"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
OUT=""
for _ in $(seq 1 12); do OUT="$(curl -s "$URL/readyz" || true)"; case "$OUT" in *'"ok":true'*) break ;; esac; sleep 5; done
echo "$OUT"
case "$OUT" in
  *'"ok":true'*)
    echo
    echo "Done. SummitOps now runs on Cloud SQL ($CONN)."
    echo "Keep the Aiven database for a week. If anything looks wrong, go back to it with:"
    echo "  gcloud run services update $SERVICE --region $REGION --remove-env-vars DB_SOCKET --update-env-vars DB_USER=$SRC_USER,DB_NAME=$SRC_NAME,DB_SSL=true --update-secrets DB_PASSWORD=$OLD_PW_SECRET:latest --remove-cloudsql-instances $CONN"
    ;;
  *)
    echo "The app did not answer as expected on Cloud SQL. Going back to Aiven now."
    gcloud run services update "$SERVICE" --region "$REGION" --quiet --remove-env-vars DB_SOCKET \
      --update-env-vars "DB_USER=$SRC_USER,DB_NAME=$SRC_NAME,DB_SSL=true" --update-secrets "DB_PASSWORD=$OLD_PW_SECRET:latest" --remove-cloudsql-instances "$CONN"
    exit 1
    ;;
esac
