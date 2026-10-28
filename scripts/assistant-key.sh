#!/usr/bin/env bash
# Stores the Anthropic API key for the in-app assistant (Ask and Assistant Plus) on live and on staging, run from the
# unzipped folder in Cloud Shell:
#
#   bash scripts/assistant-key.sh sk-ant-...
#
# Use a key from a plain Anthropic organization, not the patrol BAA one: the assistant never sees patient care records.
# The key goes into Secret Manager, once for live and once for staging (staging's account may read only staging's
# secrets). Safe to run again with a new key.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
KEY="${1:-}"
[[ "$KEY" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || { echo "Give the API key from the Anthropic Console, for example: bash scripts/assistant-key.sh sk-ant-api03-..."; exit 1; }
signed_in
step "Into Secret Manager"
for NAME in summitops-assistant-api-key summitops-staging-assistant-api-key; do
  if secret_exists "$NAME"; then printf '%s' "$KEY" | gcloud secrets versions add "$NAME" --data-file=- >/dev/null
  else printf '%s' "$KEY" | gcloud secrets create "$NAME" --replication-policy=automatic --data-file=- >/dev/null; fi
done
for S in "$PROD_SERVICE" "$STAGING_SERVICE"; do
  SERVICE="$S"
  NAME=summitops-assistant-api-key; [ "$S" = "$STAGING_SERVICE" ] && NAME=summitops-staging-assistant-api-key
  if ! gcloud run services describe "$SERVICE" --region "$REGION" --format='value(metadata.name)' >/dev/null 2>&1; then echo "No $SERVICE service yet: skipped."; continue; fi
  load_service
  SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
  [ -n "$SA" ] && let_read "$NAME" "$SA"
  step "On $SERVICE"
  gcloud run services update "$SERVICE" --region "$REGION" --update-secrets "ASSISTANT_API_KEY=$NAME:latest" --quiet
done
echo "Done. Ask now shows in the menu, and managers set it up under Account, Assistant."
