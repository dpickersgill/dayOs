#!/usr/bin/env bash
# One command for every update, run from the unzipped folder in Cloud Shell:   bash deploy.sh
# It checks this folder is not older than what is live, installs, loads the database settings, migrates (and stops if
# that fails), deploys with sensible limits, then checks the new version is the one answering and is migrated.
# Nothing is deployed if any step fails. To go back to an older version on purpose:   bash deploy.sh --allow-older
set -euo pipefail
SERVICE=summitops-api
REGION=us-east1

step() { printf '\n== %s\n' "$1"; }

step "Checking you are signed in to Google Cloud"
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "Not signed in. Run: gcloud auth login   then: gcloud config set project summitops-510715   then run this again."
  exit 1
fi
# A new Cloud Shell session can forget the project, so set it every time.
gcloud config set project summitops-510715 >/dev/null 2>&1

step "Checking the version"
NEW_VERSION="$(node -p "require('./package.json').version")"
LIVE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
LIVE_VERSION="$(curl -s --max-time 15 "$LIVE_URL/version" | jq -r '.version // empty' 2>/dev/null || true)"
node scripts/check-version.js "$LIVE_VERSION" "$@"

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "Loading the database settings from the running service"
SVC_JSON="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
envval() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .value // empty'; }
secretof() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .valueFrom.secretKeyRef.name // empty'; }
export DB_USER="$(envval DB_USER)" DB_NAME="$(envval DB_NAME)" NODE_ENV=production
export DB_PASSWORD="$(gcloud secrets versions access latest --secret="$(secretof DB_PASSWORD)")"
export JWT_SECRET="$(gcloud secrets versions access latest --secret="$(secretof JWT_SECRET)")"
SOCKET="$(envval DB_SOCKET)"
PROXY_PID=""
if [ -n "$SOCKET" ]; then
  # Cloud SQL: reach it from Cloud Shell through the Cloud SQL Auth Proxy, on a local port.
  CONN="${SOCKET#/cloudsql/}"
  PROXY="$HOME/cloud-sql-proxy"
  if [ ! -x "$PROXY" ]; then
    curl -sSfo "$PROXY" https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.26.0/cloud-sql-proxy.linux.amd64
    chmod +x "$PROXY"
  fi
  "$PROXY" --gcloud-auth --port 3307 "$CONN" >/tmp/cloud-sql-proxy.log 2>&1 &
  PROXY_PID=$!
  trap '[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/3307) 2>/dev/null && break; sleep 1; done
  export DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=false
else
  export DB_HOST="$(envval DB_HOST)" DB_PORT="$(envval DB_PORT)" DB_SSL=true
  export DB_CA="$(gcloud secrets versions access latest --secret="$(secretof DB_CA)")"
fi

step "Migrating the database"
npm run migrate

step "Deploying (this takes a few minutes)"
# At most 4 servers (so the database never runs out of connections), 8 connections each, 1 GiB each, 15-minute
# requests for the daily job, and a faster start. In season, add --min-instances=1 so the first guest never waits.
gcloud run deploy "$SERVICE" --source . --region "$REGION" --quiet \
  --max-instances=4 --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --update-env-vars "DB_POOL=8,DEPLOYED_BY=$(gcloud config get-value account 2>/dev/null || echo unknown)"

step "Checking the new version"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
sleep 5
OUT="$(curl -s "$URL/readyz" || true)"
echo "$OUT"
case "$OUT" in
  *'"ok":true'*'"version":"'"$NEW_VERSION"'"'*) echo "Done. $URL is running $NEW_VERSION, migrated." ;;
  *'"ok":true'*) echo "The site is up but is not answering as $NEW_VERSION yet. Wait a minute and run: curl -s $URL/version"; exit 1 ;;
  *) echo "The new version did not answer as expected. To go back, see DEPLOY.md, Rolling back."; exit 1 ;;
esac
