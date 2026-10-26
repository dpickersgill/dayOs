#!/usr/bin/env bash
# Connects prospect outreach (platform console, Prospects, Outreach) to your Google Workspace mailbox, run from the
# unzipped folder in Cloud Shell once the Workspace mailbox exists:
#
#   bash scripts/outreach-setup.sh dan@your-outreach-domain.com
#
# It turns on the Gmail API, makes a service account for outreach with a key kept in Secret Manager, gives the key and
# the mailbox to the live service only (staging never sends outreach), and adds a Cloud Scheduler job that runs
# outreach every 30 minutes on weekdays. At the end it prints the client ID to authorize in Google Workspace Admin.
# Safe to run again (a new key replaces the old one).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
SENDER="${1:-}"
[[ "$SENDER" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || { echo "Give the mailbox outreach sends as, for example: bash scripts/outreach-setup.sh dan@verdynt-mail.com"; exit 1; }
signed_in
NAME=summitops-outreach-gmail-key
OSA="summitops-outreach@${PROJECT}.iam.gserviceaccount.com"

step "Gmail API"
gcloud services enable gmail.googleapis.com --quiet

step "Service account for outreach"
gcloud iam service-accounts describe "$OSA" >/dev/null 2>&1 || gcloud iam service-accounts create summitops-outreach --display-name "Verdynt/OS outreach (Gmail)" --quiet
KEYFILE="$(mktemp)"
trap 'rm -f "$KEYFILE"' EXIT
if ! gcloud iam service-accounts keys create "$KEYFILE" --iam-account "$OSA" --quiet; then
  echo "Could not make a key. If your organization blocks service account keys (iam.disableServiceAccountKeyCreation), allow it for this project and run this again."
  exit 1
fi

step "Into Secret Manager"
if secret_exists "$NAME"; then gcloud secrets versions add "$NAME" --data-file="$KEYFILE" >/dev/null
else gcloud secrets create "$NAME" --replication-policy=automatic --data-file="$KEYFILE" >/dev/null; fi

SERVICE="$PROD_SERVICE"
load_service
SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
[ -n "$SA" ] && gcloud secrets add-iam-policy-binding "$NAME" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null

step "On $SERVICE"
gcloud run services update "$SERVICE" --region "$REGION" --update-secrets "OUTREACH_GMAIL_KEY=$NAME:latest" --update-env-vars "OUTREACH_SENDER=$SENDER" --quiet
load_service

step "Every 30 minutes on weekdays (Cloud Scheduler)"
BASE="$(check_url)"
JOBS="$(secretof JOBS_KEY)"
if [ -z "$JOBS" ]; then echo "The service has no JOBS_KEY yet (see RUNBOOK.md, Patrol follow-up emails). Add it, then run this again."; exit 1; fi
ARGS=(--location "$REGION" --schedule "*/30 8-17 * * 1-5" --time-zone "America/New_York" --uri "$BASE/api/v1/internal/jobs/outreach" --http-method POST --headers "x-jobs-key=$(secret_read "$JOBS")" --attempt-deadline=300s --quiet)
if gcloud scheduler jobs describe summitops-outreach --location "$REGION" >/dev/null 2>&1; then gcloud scheduler jobs update http summitops-outreach "${ARGS[@]}"
else gcloud scheduler jobs create http summitops-outreach "${ARGS[@]}"; fi

CLIENT_ID="$(gcloud iam service-accounts describe "$OSA" --format='value(oauth2ClientId)')"
cat <<EOF

Last step, in Google Workspace Admin (admin.google.com), signed in as the Workspace admin:
  Security, Access and data control, API controls, Manage domain-wide delegation, Add new
  Client ID:  $CLIENT_ID
  Scopes:     https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly

Then in the platform console: Prospects, Outreach, Send a test to me.
EOF
