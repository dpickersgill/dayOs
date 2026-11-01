#!/usr/bin/env bash
# Stores the signing secret of the Stripe Connect webhook (events from the mountains' own Stripe accounts) on the
# service, run from the unzipped folder in Cloud Shell:
#
#   bash scripts/stripe-connect.sh     it asks for the secret (paste it; it is not shown and not kept in the shell history)
#
# The secret goes into Secret Manager, and only the service's own account can read it (2026.11.11: never a plain
# setting, which every later revision would copy). Safe to run again with a new secret.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
[ $# -eq 0 ] || { echo "The secret is not given on the command line any more (the shell history would keep it). Run: bash scripts/stripe-connect.sh"; exit 1; }
read -r -s -p "The Connect webhook's signing secret from Stripe (whsec_...): " WHSEC; echo
[[ "$WHSEC" =~ ^whsec_[A-Za-z0-9]+$ ]] || { echo "That does not look like a Stripe signing secret (whsec_...). Nothing changed."; exit 1; }
signed_in
load_service
NAME=summitops-stripe-connect-webhook-secret
step "Into Secret Manager"
if secret_exists "$NAME"; then printf '%s' "$WHSEC" | gcloud secrets versions add "$NAME" --data-file=- >/dev/null
else printf '%s' "$WHSEC" | gcloud secrets create "$NAME" --replication-policy=automatic --data-file=- >/dev/null; fi
unset WHSEC
SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
[ -n "$SA" ] && gcloud secrets add-iam-policy-binding "$NAME" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
# A plain setting from before is removed in the same update, so the secret is never missing.
REMOVE=(); [ -n "$(envval STRIPE_CONNECT_WEBHOOK_SECRET)" ] && REMOVE=(--remove-env-vars STRIPE_CONNECT_WEBHOOK_SECRET)
gcloud run services update "$SERVICE" --region "$REGION" --update-secrets "STRIPE_CONNECT_WEBHOOK_SECRET=$NAME:latest" "${REMOVE[@]}" --quiet
echo "Done. Stripe's Connect events are now accepted at /api/v1/stripe/webhook. Owners connect their accounts under Billing, Guest card payments."
