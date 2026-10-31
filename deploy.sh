#!/usr/bin/env bash
# Step 1 of every release, run from the unzipped folder in Cloud Shell:   bash deploy.sh
# It puts this release on STAGING (the private test copy of Verdynt/OS), never on the live site. Check it there, then run
# bash promote.sh to put exactly the same build live. The live site only ever gets a build that ran on staging first.
#
# It checks this folder is not older than what staging runs, checks the packages for known security problems, installs,
# migrates the staging database (with the staging login, which cannot reach the live database), deploys, then checks
# staging answers as this exact build and is migrated. Nothing is deployed if any step fails.
# The first time, run bash scripts/staging-setup.sh instead: it creates staging and puts this release on it.
set -euo pipefail
DAYOS_TARGET=summitops-staging
source "$(dirname "$0")/scripts/cloud-common.sh"

step "Checking you are signed in to Google Cloud"
signed_in

step "Checking staging exists"
if ! gcloud run services describe "$SERVICE" --region "$REGION" >/dev/null 2>&1; then
  echo "There is no staging yet. Run this once first:   bash scripts/staging-setup.sh"
  exit 1
fi
# Staging runs builds nobody has checked yet, so it never runs as the live account, which can read the live keys.
if ! gcloud iam service-accounts describe "$STAGING_SA" >/dev/null 2>&1; then
  echo "Staging needs its own service account now, so it can never read the live site's keys. Run this once, then deploy again:"
  echo "  bash scripts/staging-setup.sh"
  exit 1
fi

step "Checking the version"
NEW_VERSION="$(node -p "require('./package.json').version")"
NEW_BUILD="$(node -p "(()=>{try{return require('./src/release/build.json').build||'dev'}catch(_){return 'dev'}})()")"
load_service
STAGING_VERSION="$(curl -s --max-time 15 "$(check_url)/version" | jq -r '.version // empty' 2>/dev/null || true)"
node scripts/check-version.js "$STAGING_VERSION" "$@"

step "Checking the packages for known security problems"
# Stops on a high or critical problem in anything that runs in production. Fix by updating the package, or (only if
# it truly cannot affect Verdynt/OS) run with SKIP_AUDIT=1 and note why in the release.
if [ "${SKIP_AUDIT:-}" != 1 ]; then npm audit --omit=dev --audit-level=high; fi

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "Migrating the staging database"
AS=migrator open_db
npm run migrate

step "Deploying to staging (this takes a few minutes)"
# One server is plenty for checking a release, and it shuts down when nobody is using it, so staging costs almost nothing.
# Staging stays at no server when idle (--min-instances=0); only the live site keeps one warm (promote.sh). For a load
# test on staging (scripts/loadtest.js), deploy with STAGING_MAX_SERVERS=2 to check the shared rate limits across servers.
gcloud run deploy "$SERVICE" --source . --region "$REGION" --quiet --service-account "$STAGING_SA" \
  --min-instances=0 --max-instances="${STAGING_MAX_SERVERS:-1}" --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --update-env-vars "DB_POOL=4,RATE_STORE=mysql,DEPLOYED_BY=$(gcloud config get-value account 2>/dev/null || echo unknown)"

step "Checking staging"
load_service
URL="$(check_url)"
sleep 5
OUT="$(curl -s "$URL/readyz" || true)"
echo "$OUT"
case "$OUT" in
  *'"ok":true'*'"version":"'"$NEW_VERSION"'"'*'"build":"'"$NEW_BUILD"'"'*)
    echo ""
    echo "Staging is running $NEW_VERSION (build $NEW_BUILD): $URL"
    echo "Check it there. When everything is right, put this same build live with:   bash promote.sh" ;;
  *'"ok":true'*) echo "Staging is up but is not answering as $NEW_VERSION build $NEW_BUILD yet. Wait a minute and run: curl -s $URL/readyz"; exit 1 ;;
  *) echo "Staging did not answer as expected. Look at its logs: gcloud run services logs read $SERVICE --region $REGION --limit 50"; exit 1 ;;
esac
