#!/usr/bin/env bash
# Step 2 of every release, from the same unzipped folder, once staging has been checked:   bash promote.sh
# It puts live exactly the build staging is running, the same container image, not a new build. It stops unless
# staging is running this folder's release and build, and asks you to type the version before anything changes.
# Then it migrates the live database, deploys, checks the live site answers as the new version, and prints the one
# command that switches back to the version before.
#   bash promote.sh --allow-older   put an older release live on purpose (it must be on staging first)
#   bash promote.sh --yes           skip the typed confirmation (for an automated Sunday deploy)
#
# Servers (2026.11.10): the live site keeps one server always running, so the first guest of the morning never waits
# for one to start, and grows to at most LIVE_MAX_SERVERS (default 4) when it is busy. Each server opens at most
# LIVE_DB_POOL (default 8) database connections. DEPLOY.md, "Servers and database connections", has the math.
set -euo pipefail
DAYOS_TARGET=summitops-staging
source "$(dirname "$0")/scripts/cloud-common.sh"

LIVE_MIN_SERVERS="${LIVE_MIN_SERVERS:-1}"
LIVE_MAX_SERVERS="${LIVE_MAX_SERVERS:-4}"
LIVE_DB_POOL="${LIVE_DB_POOL:-8}"
# Connections the database server must hold at the busiest moment: every live server full, staging (at most 2 servers
# x 4, during a load test), and 4 more for a migration and the Cloud SQL proxy in Cloud Shell. Cloud SQL's smallest MySQL servers allow
# 250; DB_CONNECTION_BUDGET keeps well under that, because each connection also takes memory on a small server.
DB_CONNECTION_BUDGET="${DB_CONNECTION_BUDGET:-60}"
NEEDED=$(( LIVE_MAX_SERVERS * LIVE_DB_POOL + 8 + 4 ))
if [ "$LIVE_MIN_SERVERS" -gt "$LIVE_MAX_SERVERS" ] || [ "$LIVE_MAX_SERVERS" -lt 1 ]; then
  echo "LIVE_MIN_SERVERS ($LIVE_MIN_SERVERS) must be 0 or more and no more than LIVE_MAX_SERVERS ($LIVE_MAX_SERVERS)."; exit 1
fi
if [ "$NEEDED" -gt "$DB_CONNECTION_BUDGET" ]; then
  echo "$LIVE_MAX_SERVERS servers x $LIVE_DB_POOL connections, plus staging and tools, is $NEEDED database connections, more than the budget of $DB_CONNECTION_BUDGET."
  echo "Lower LIVE_MAX_SERVERS or LIVE_DB_POOL, or read DEPLOY.md (Servers and database connections) before raising DB_CONNECTION_BUDGET."
  exit 1
fi

YES=""; PASS=()
for a in "$@"; do case "$a" in --yes) YES=1 ;; *) PASS+=("$a") ;; esac; done

step "Checking you are signed in to Google Cloud"
signed_in

step "Checking staging is running this release"
NEW_VERSION="$(node -p "require('./package.json').version")"
NEW_BUILD="$(node -p "(()=>{try{return require('./src/release/build.json').build||'dev'}catch(_){return 'dev'}})()")"
load_service
STG_URL="$(check_url)"
STG="$(curl -s --max-time 30 "$STG_URL/readyz" || true)"
STG_VERSION="$(echo "$STG" | jq -r '.version // empty' 2>/dev/null || true)"
STG_BUILD="$(echo "$STG" | jq -r '.build // empty' 2>/dev/null || true)"
if [ "$(echo "$STG" | jq -r '.ok // false' 2>/dev/null)" != true ] || [ "$STG_VERSION" != "$NEW_VERSION" ] || [ "$STG_BUILD" != "$NEW_BUILD" ]; then
  echo "Staging is not running this release (it runs ${STG_VERSION:-nothing} build ${STG_BUILD:-?}; this folder is $NEW_VERSION build $NEW_BUILD)."
  echo "Put it on staging and check it first:   bash deploy.sh"
  exit 1
fi
REV="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.latestReadyRevisionName)')"
IMAGE="$(gcloud run revisions describe "$REV" --region "$REGION" --format='value(status.imageDigest)')"
if [ -z "$IMAGE" ]; then echo "Could not read the image staging runs ($REV)."; exit 1; fi
echo "Staging runs $NEW_VERSION build $NEW_BUILD: $IMAGE"

step "Checking the live version"
SERVICE="$PROD_SERVICE"
load_service
LIVE_VERSION="$(curl -s --max-time 15 "$(check_url)/version" | jq -r '.version // empty' 2>/dev/null || true)"
node scripts/check-version.js "$LIVE_VERSION" "${PASS[@]}"
PREV_REV="$(echo "$SVC_JSON" | jq -r '.status.latestReadyRevisionName // empty')"

if [ -z "$YES" ]; then
  echo ""
  echo "This puts $NEW_VERSION live for every mountain (the live site runs ${LIVE_VERSION:-unknown} now)."
  read -r -p "Type $NEW_VERSION to go ahead, anything else to stop: " TYPED
  if [ "$TYPED" != "$NEW_VERSION" ]; then echo "Stopped. Nothing changed."; exit 1; fi
fi

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "Migrating the live database"
AS=migrator open_db
npm run migrate
if secret_exists summitops-db-migrator && [ "$(envval DB_USER)" = summitops_app ]; then
  node scripts/db-runtime-user.js summitops_app # new tables from this migration
fi

step "Putting it live (this takes a minute or two)"
# The same image staging ran. One server always warm (LIVE_MIN_SERVERS), up to LIVE_MAX_SERVERS at peak, LIVE_DB_POOL
# database connections each, 1 GiB each, 15-minute requests for the daily job, and a faster start. Rate limits are
# counted in the database (rate_limits, migrated above), so they hold across every server.
SA_FLAG=()
if gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1; then SA_FLAG=(--service-account "$RUN_SA"); fi
echo "Servers: $LIVE_MIN_SERVERS always running, at most $LIVE_MAX_SERVERS, $LIVE_DB_POOL database connections each ($NEEDED at most, with staging and tools)."
gcloud run deploy "$SERVICE" --image "$IMAGE" --region "$REGION" --quiet "${SA_FLAG[@]}" \
  --min-instances="$LIVE_MIN_SERVERS" --max-instances="$LIVE_MAX_SERVERS" --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --update-env-vars "DB_POOL=$LIVE_DB_POOL,RATE_STORE=mysql,DEPLOYED_BY=$(gcloud config get-value account 2>/dev/null || echo unknown)"

step "Checking the live site"
load_service
URL="$(check_url)"
sleep 5
OUT="$(curl -s "$URL/readyz" || true)"
echo "$OUT"
BACK="gcloud run services update-traffic $SERVICE --to-revisions=$PREV_REV=100 --region $REGION"
case "$OUT" in
  *'"ok":true'*'"version":"'"$NEW_VERSION"'"'*)
    echo "Done. $URL is running $NEW_VERSION, migrated."
    [ -n "$PREV_REV" ] && echo "To switch back to the version before, if you ever need to:   $BACK" ;;
  *'"ok":true'*) echo "The site is up but is not answering as $NEW_VERSION yet. Wait a minute and run: curl -s $URL/version"; exit 1 ;;
  *) echo "The new version did not answer as expected. Switch back with:   $BACK"; exit 1 ;;
esac
