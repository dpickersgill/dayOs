#!/usr/bin/env bash
# Connects prospect outreach (platform console, Prospects, Outreach) to your Google Workspace mailbox, run from the
# unzipped folder in Cloud Shell once the Workspace mailbox exists:
#
#   bash scripts/outreach-setup.sh dan@your-outreach-domain.com
#
# It turns on the Gmail API, makes a service account for outreach, lets the live app's own account sign in as it (no key
# is made: since 2026.11.11 Google signs each sign-in through IAM Credentials, so there is no key to leak, copy or
# rotate), deletes any key an earlier run made, gives the mailbox to the live service only (staging never sends
# outreach), and adds a Cloud Scheduler job that runs outreach every 30 minutes on weekdays. At the end it prints the
# client ID to authorize in Google Workspace Admin. Safe to run again.
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
gcloud services enable iamcredentials.googleapis.com --quiet

SERVICE="$PROD_SERVICE"
load_service
SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
[ -n "$SA" ] || { echo "The live service has no service account of its own yet. Run bash scripts/harden.sh first."; exit 1; }

step "The app may sign in as the outreach account (no key)"
# Token Creator on the outreach account ONLY (not the project): the app can sign for summitops-outreach and nothing else.
gcloud iam service-accounts add-iam-policy-binding "$OSA" --member "serviceAccount:$SA" --role roles/iam.serviceAccountTokenCreator --quiet >/dev/null
echo "  $SA may sign in as $OSA."

step "Old keys deleted"
for k in $(gcloud iam service-accounts keys list --iam-account "$OSA" --managed-by=user --format='value(name.basename())'); do
  gcloud iam service-accounts keys delete "$k" --iam-account "$OSA" --quiet >/dev/null && echo "  Deleted key $k"
done
REMOVE=()
if [ -n "$(secretof OUTREACH_GMAIL_KEY)" ]; then REMOVE=(--remove-secrets OUTREACH_GMAIL_KEY); fi

step "On $SERVICE"
gcloud run services update "$SERVICE" --region "$REGION" "${REMOVE[@]}" --update-env-vars "OUTREACH_SENDER=$SENDER,OUTREACH_GMAIL_SA=$OSA" --quiet
load_service
# Only now that the service no longer reads it: the secret that held the old key goes too.
secret_exists "$NAME" && { gcloud secrets delete "$NAME" --quiet >/dev/null; echo "  Deleted the secret $NAME (it held a key)."; } || true

step "Every 30 minutes on weekdays (Cloud Scheduler)"
BASE="$(check_url)"
# Signed with a Google ID token for summitops-jobs, checked by the app (2026.11.11): no key is stored in the job.
ensure_jobs_oidc
ARGS=(--location "$REGION" --schedule "*/30 8-17 * * 1-5" --time-zone "America/New_York" --uri "$BASE/api/v1/internal/jobs/outreach" --http-method POST "${JOB_AUTH[@]}" --attempt-deadline=300s --quiet)
if gcloud scheduler jobs describe summitops-outreach --location "$REGION" >/dev/null 2>&1; then gcloud scheduler jobs update http summitops-outreach "${ARGS[@]}" --remove-headers x-jobs-key
else gcloud scheduler jobs create http summitops-outreach "${ARGS[@]}"; fi

CLIENT_ID="$(gcloud iam service-accounts describe "$OSA" --format='value(oauth2ClientId)')"
cat <<EOF

Last step, in Google Workspace Admin (admin.google.com), signed in as the Workspace admin:
  Security, Access and data control, API controls, Manage domain-wide delegation, Add new
  Client ID:  $CLIENT_ID
  Scopes:     https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly

Then in the platform console: Prospects, Outreach, Send a test to me.
EOF
