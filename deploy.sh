#!/usr/bin/env bash
# One command for every update, run from the unzipped folder in Cloud Shell:   bash deploy.sh
# It installs, loads the database settings, migrates (and stops if that fails), deploys with sensible limits, then
# checks the new version is up and migrated. Nothing is deployed if any step fails.
set -euo pipefail
SERVICE=summitops-api
REGION=us-east1

step() { printf '\n== %s\n' "$1"; }

step "Checking you are signed in to Google Cloud"
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "Not signed in. Run: gcloud auth login   then: gcloud config set project summitops-510715   then run this again."
  exit 1
fi

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "Loading the database settings from the running service"
SVC_JSON="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
for k in DB_HOST DB_PORT DB_USER DB_NAME; do
  export "$k=$(echo "$SVC_JSON" | jq -r --arg k "$k" '.spec.template.spec.containers[0].env[] | select(.name==$k) | .value')"
done
export DB_SSL=true NODE_ENV=production
export DB_PASSWORD="$(gcloud secrets versions access latest --secret=summitops-db-password)"
export DB_CA="$(gcloud secrets versions access latest --secret=aiven-ca)"
export JWT_SECRET="$(gcloud secrets versions access latest --secret=summitops-jwt)"

step "Migrating the database"
npm run migrate

step "Deploying (this takes a few minutes)"
# At most 4 servers (so the database never runs out of connections), 8 connections each, 1 GiB each, 15-minute
# requests for the daily job, and a faster start. In season, add --min-instances=1 so the first guest never waits.
gcloud run deploy "$SERVICE" --source . --region "$REGION" --quiet \
  --max-instances=4 --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --update-env-vars DB_POOL=8

step "Checking the new version"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
sleep 5
OUT="$(curl -s "$URL/readyz" || true)"
echo "$OUT"
case "$OUT" in
  *'"ok":true'*) echo "Done. $URL is up and migrated." ;;
  *) echo "The new version did not answer as expected. To go back, see DEPLOY.md, Rolling back."; exit 1 ;;
esac
