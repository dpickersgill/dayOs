#!/usr/bin/env bash
# Stores the signing secret of the Stripe Connect webhook (events from the mountains' own Stripe accounts) on the
# service, run from the unzipped folder in Cloud Shell:
#
#   bash scripts/stripe-connect.sh whsec_...
#
# If the service already keeps its keys in Secret Manager (scripts/harden.sh), the secret goes there and only the
# service's own account can read it; otherwise it is set as a plain setting. Safe to run again with a new secret.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
WHSEC="${1:-}"
[[ "$WHSEC" =~ ^whsec_[A-Za-z0-9]+$ ]] || { echo "Give the signing secret from Stripe, for example: bash scripts/stripe-connect.sh whsec_abc123"; exit 1; }
signed_in
load_service
NAME=summitops-stripe-connect-webhook-secret
if [ -n "$(secretof STRIPE_WEBHOOK_SECRET)" ]; then
  step "Into Secret Manager"
  if secret_exists "$NAME"; then printf '%s' "$WHSEC" | gcloud secrets versions add "$NAME" --data-file=- >/dev/null
  else printf '%s' "$WHSEC" | gcloud secrets create "$NAME" --replication-policy=automatic --data-file=- >/dev/null; fi
  SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
  [ -n "$SA" ] && gcloud secrets add-iam-policy-binding "$NAME" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
  gcloud run services update "$SERVICE" --region "$REGION" --update-secrets "STRIPE_CONNECT_WEBHOOK_SECRET=$NAME:latest" --quiet
else
  step "As a setting"
  gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "STRIPE_CONNECT_WEBHOOK_SECRET=$WHSEC" --quiet
fi
echo "Done. Stripe's Connect events are now accepted at /api/v1/stripe/webhook. Owners connect their accounts under Billing, Guest card payments."
