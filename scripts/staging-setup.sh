#!/usr/bin/env bash
# Run once, from an unzipped release folder in Cloud Shell:   bash scripts/staging-setup.sh
# Creates STAGING, the private test copy of DAY/OS, and puts this release on it. After this, every release goes:
#   bash deploy.sh    puts it on staging, to check
#   bash promote.sh   puts that same build live
#
# What staging gets, and what keeps it apart from the live site:
#   - its own Cloud Run service (summitops-staging): one server at most, and none when nobody is using it
#   - its own database (summitops_staging) on the same database server, with a login that can reach nothing else
#   - its own keys (sign-in, bootstrap) and a shared password in front of the whole site
#   - Stripe in test mode only (live keys are refused), with its own test webhooks
#   - every email goes to your inbox instead of to the person it names; no text messages are sent
#   - hidden from search engines
# Safe to run again: it keeps what already exists and fills in anything missing.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh

STG_DB=summitops_staging
STG_USER=summitops_stg
SECRETS=(summitops-staging-db-password summitops-staging-jwt summitops-staging-bootstrap summitops-staging-gate)

rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }
put_secret() { # name value: create the secret, or add a new version only when asked to
  if secret_exists "$1"; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --replication-policy=automatic --data-file=- >/dev/null; fi
}
ensure_secret() { secret_exists "$1" || put_secret "$1" "$2"; }

step "Checking you are signed in to Google Cloud"
signed_in

step "Reading the live service's settings"
load_service
SOCKET="$(envval DB_SOCKET)"
if [ -z "$SOCKET" ]; then echo "Staging needs the live database to be on Cloud SQL (DB_SOCKET is not set)."; exit 1; fi
SQL_CONN="${SOCKET#/cloudsql/}"
INSTANCE="${SQL_CONN##*:}"
LIVE_DB="$(envval DB_NAME)"
if [ "$LIVE_DB" = "$STG_DB" ]; then echo "The live database is already called $STG_DB. Stopping."; exit 1; fi
MAIL_FROM_V="$(envval MAIL_FROM)"
PM_SECRET="$(secretof POSTMARK_SERVER_TOKEN)"; PM_PLAIN="$(envval POSTMARK_SERVER_TOKEN)"
SA="$RUN_SA"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
fi
echo "Database server $INSTANCE; the live database is $LIVE_DB; staging runs as $SA."

step "A few choices"
ME="$(gcloud config get-value account 2>/dev/null || true)"
read -r -p "Where should staging's email go? [$ME] " INBOX; INBOX="${INBOX:-$ME}"
if ! secret_exists summitops-staging-gate; then
  read -r -s -p "Choose a staging password (at least 10 characters), or press Enter for a random one: " GATE; echo
  if [ -z "$GATE" ]; then GATE="$(rand 20)"; elif [ ${#GATE} -lt 10 ]; then echo "That is too short."; exit 1; fi
  put_secret summitops-staging-gate "$GATE"
fi
STRIPE_KEY=""
if ! secret_exists summitops-staging-stripe-key; then
  echo "Stripe for staging: in the Stripe dashboard, turn on Test mode, open Developers, API keys, and copy the Secret key (sk_test_...)."
  read -r -s -p "Paste it here, or press Enter to leave payments off on staging for now: " STRIPE_KEY; echo
  case "$STRIPE_KEY" in
    "") ;;
    sk_test_*|rk_test_*) put_secret summitops-staging-stripe-key "$STRIPE_KEY" ;;
    *) echo "That is not a test key. Staging only takes a key starting sk_test_. Nothing was saved."; exit 1 ;;
  esac
else STRIPE_KEY="$(secret_read summitops-staging-stripe-key)"; fi

step "Installing"
npm install --omit=dev --no-audit --no-fund

step "1. The staging database"
if gcloud sql databases describe "$STG_DB" --instance "$INSTANCE" >/dev/null 2>&1; then echo "$STG_DB is already there."
else gcloud sql databases create "$STG_DB" --instance "$INSTANCE" --charset=utf8mb4 --quiet; fi

step "2. Keys, and a database login that can only reach the staging database"
ensure_secret summitops-staging-db-password "$(rand 40)"
ensure_secret summitops-staging-jwt "$(rand 64)"
ensure_secret summitops-staging-bootstrap "$(rand 32)"
STG_PW="$(secret_read summitops-staging-db-password)"
AS=migrator open_db
node scripts/staging-db-user.js "$STG_USER" "$STG_PW" "$STG_DB"
export DB_USER="$STG_USER" DB_PASSWORD="$STG_PW" DB_NAME="$STG_DB"
export JWT_SECRET="$(secret_read summitops-staging-jwt)"
npm run migrate

step "3. Letting staging read its keys"
ALL=("${SECRETS[@]}"); secret_exists summitops-staging-stripe-key && ALL+=(summitops-staging-stripe-key)
[ -n "$PM_SECRET" ] && ALL+=("$PM_SECRET")
for s in "${ALL[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
echo "Done."

step "4. Deploying staging (this takes a few minutes)"
ENVS="NODE_ENV=production|STAGE=staging|STAGING_INBOX=$INBOX|DB_SOCKET=$SOCKET|DB_USER=$STG_USER|DB_NAME=$STG_DB|DB_POOL=4|STRIPE_GUEST_FALLBACK=on"
[ -n "$MAIL_FROM_V" ] && ENVS="$ENVS|MAIL_FROM=$MAIL_FROM_V"
[ -z "$PM_SECRET" ] && [ -n "$PM_PLAIN" ] && ENVS="$ENVS|POSTMARK_SERVER_TOKEN=$PM_PLAIN"
SECS="DB_PASSWORD=summitops-staging-db-password:latest,JWT_SECRET=summitops-staging-jwt:latest,BOOTSTRAP_KEY=summitops-staging-bootstrap:latest,STAGING_GATE=summitops-staging-gate:latest"
[ -n "$PM_SECRET" ] && SECS="$SECS,POSTMARK_SERVER_TOKEN=$PM_SECRET:latest"
secret_exists summitops-staging-stripe-key && SECS="$SECS,STRIPE_SECRET_KEY=summitops-staging-stripe-key:latest"
gcloud run deploy "$STAGING_SERVICE" --source . --region "$REGION" --quiet --service-account "$SA" \
  --add-cloudsql-instances "$SQL_CONN" --allow-unauthenticated \
  --min-instances=0 --max-instances=1 --concurrency=40 --memory=1Gi --cpu-boost --timeout=900 \
  --set-env-vars "^|^$ENVS" --set-secrets "$SECS"
URL="$(gcloud run services describe "$STAGING_SERVICE" --region "$REGION" --format='value(status.url)')"

if [ -n "$STRIPE_KEY" ] && ! secret_exists summitops-staging-stripe-webhook; then
  step "5. Stripe test-mode webhooks for staging"
  hook() { # extra curl args: creates a webhook endpoint at staging and prints its signing secret
    curl -sS -u "$STRIPE_KEY:" https://api.stripe.com/v1/webhook_endpoints -d "url=$URL/api/v1/stripe/webhook" \
      -d "description=DAY/OS staging" "$@" | jq -r '.secret // empty'
  }
  W1="$(hook -d 'enabled_events[]=checkout.session.completed' -d 'enabled_events[]=checkout.session.expired' \
    -d 'enabled_events[]=customer.subscription.created' -d 'enabled_events[]=customer.subscription.updated' -d 'enabled_events[]=customer.subscription.deleted' \
    -d 'enabled_events[]=invoice.paid' -d 'enabled_events[]=invoice.payment_failed' -d 'enabled_events[]=invoice.finalized')"
  W2="$(hook -d connect=true -d 'enabled_events[]=checkout.session.completed' -d 'enabled_events[]=checkout.session.expired' \
    -d 'enabled_events[]=account.updated' -d 'enabled_events[]=account.application.deauthorized')"
  if [ -n "$W1" ] && [ -n "$W2" ]; then
    put_secret summitops-staging-stripe-webhook "$W1"; put_secret summitops-staging-stripe-connect-webhook "$W2"
    for s in summitops-staging-stripe-webhook summitops-staging-stripe-connect-webhook; do
      gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
    done
    gcloud run services update "$STAGING_SERVICE" --region "$REGION" --quiet \
      --update-secrets "STRIPE_WEBHOOK_SECRET=summitops-staging-stripe-webhook:latest,STRIPE_CONNECT_WEBHOOK_SECRET=summitops-staging-stripe-connect-webhook:latest"
    echo "Stripe will send test-mode payment events to staging."
  else
    echo "Stripe did not create the webhooks. Payments on staging will start but not finish; run this script again to retry."
  fi
fi

step "Checking staging"
sleep 5
curl -s "$URL/readyz"; echo
echo ""
echo "Staging is ready: $URL"
echo "  Staging password:   gcloud secrets versions access latest --secret=summitops-staging-gate"
echo "  Bootstrap key (to create a mountain, or the first console sign-in at $URL/platform):"
echo "                      gcloud secrets versions access latest --secret=summitops-staging-bootstrap"
echo "  A full demo mountain to test with: $URL/try"
echo "  Email from staging goes to $INBOX. No text messages are sent."
echo ""
echo "From now on, each release:   bash deploy.sh   (staging), check it, then   bash promote.sh   (live)."
