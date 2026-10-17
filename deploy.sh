#!/usr/bin/env bash
# One command for every update, run from the unzipped folder in Cloud Shell:   bash deploy.sh
# It checks this folder is not older than what is live, checks the packages for known security problems, installs,
# migrates (with the migration login when scripts/harden.sh has made one, and stops if that fails), deploys with
# sensible limits as the summitops-run service account (when it exists), then checks the new version is answering and
# is migrated. Nothing is deployed if any step fails. To go back to an older version on purpose:   bash deploy.sh --allow-older
set -euo pipefail
source "$(dirname "$0")/scripts/cloud-common.sh"

step "Checking you are signed in to Google Cloud"
signed_in

step "Checking the version"
NEW_VERSION="$(node -p "require('./package.json').version")"
load_service
LIVE_VERSION="$(curl -s --max-time 15 "$(check_url)/version" | jq -r '.version // empty' 2>/dev/null || true)"
node scripts/check-version.js "$LIVE_VERSION" "$@"

step "Checking the packages for known security problems"
# Stops on a high or critical problem in anything that runs in production. Fix by updating the package, or (only if
# it truly cannot affect SummitOps) run with SKIP_AUDIT=1 and note why in the release.
if [ "${SKIP_AUDIT:-}" != 1 ]; then npm audit --omit=dev --audit-level=high; fi

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "Migrating the database"
AS=migrator open_db
npm run migrate
if secret_exists summitops-db-migrator && [ "$(envval DB_USER)" = summitops_app ]; then
  node scripts/db-runtime-user.js summitops_app # new tables from this migration
fi

step "Deploying (this takes a few minutes)"
# At most 4 servers (so the database never runs out of connections), 8 connections each, 1 GiB each, 15-minute
# requests for the daily job, and a faster start. In season, add --min-instances=1 so the first guest never waits.
SA_FLAG=()
if gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1; then SA_FLAG=(--service-account "$RUN_SA"); fi
gcloud run deploy "$SERVICE" --source . --region "$REGION" --quiet "${SA_FLAG[@]}" \
  --max-instances=4 --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --update-env-vars "DB_POOL=8,DEPLOYED_BY=$(gcloud config get-value account 2>/dev/null || echo unknown)"

step "Checking the new version"
load_service
URL="$(check_url)"
sleep 5
OUT="$(curl -s "$URL/readyz" || true)"
echo "$OUT"
case "$OUT" in
  *'"ok":true'*'"version":"'"$NEW_VERSION"'"'*) echo "Done. $URL is running $NEW_VERSION, migrated." ;;
  *'"ok":true'*) echo "The site is up but is not answering as $NEW_VERSION yet. Wait a minute and run: curl -s $URL/version"; exit 1 ;;
  *) echo "The new version did not answer as expected. To go back, see DEPLOY.md, Rolling back."; exit 1 ;;
esac
if [ ${#SA_FLAG[@]} -eq 0 ]; then echo "Note: the one-time security setup has not been run yet. See RUNBOOK.md, Security setup (bash scripts/harden.sh)."; fi
