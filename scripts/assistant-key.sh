#!/usr/bin/env bash
# Stores the API key for the in-app assistant (Ask, Assistant Plus, lesson recaps, outreach drafts) on live and on
# staging, run from the
# unzipped folder in Cloud Shell:
#
#   bash scripts/assistant-key.sh            it asks for the key (paste it; it is not shown and not kept in the shell history)
#   bash scripts/assistant-key.sh --staging-off   staging gets no assistant key (it answers "not set up")
#
# The key is either an Anthropic key (sk-ant-...) or an OpenRouter key (sk-or-...); the app tells them apart by the
# start, so nothing else needs setting to switch (ASSISTANT_PROVIDER can still force one).
# Use a key from a plain Anthropic organization, not the patrol BAA one: the assistant never sees patient care records.
# Patrol "Fill in from the story" never goes through OpenRouter; it keeps its own BAA key (ANTHROPIC_API_KEY).
# The key goes into Secret Manager for live. Staging runs code nobody has checked yet, so it never gets the live key
# (2026.11.11): it asks for a SEPARATE key for staging (make a second key in the Anthropic Console, with a low spend
# limit; at OpenRouter, a second key with a credit limit), or press Enter to leave the assistant off on staging.
# Safe to run again with a new key.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
[ $# -eq 0 ] || [ "$1" = --staging-off ] || { echo "The key is not given on the command line any more (the shell history would keep it). Run: bash scripts/assistant-key.sh"; exit 1; }
KEY_RE='^sk-(ant|or)-[A-Za-z0-9_-]{20,}$'
read -r -s -p "The live assistant's API key (Anthropic sk-ant-... or OpenRouter sk-or-...): " KEY; echo
[[ "$KEY" =~ $KEY_RE ]] || { echo "That does not look like an Anthropic (sk-ant-...) or OpenRouter (sk-or-...) API key. Nothing changed."; exit 1; }
STG_KEY=""
if [ "${1:-}" != --staging-off ]; then
  read -r -s -p "A SEPARATE key for staging, or press Enter to leave the assistant off on staging: " STG_KEY; echo
  if [ -n "$STG_KEY" ]; then
    [[ "$STG_KEY" =~ $KEY_RE ]] || { echo "That does not look like an Anthropic or OpenRouter API key. Nothing changed."; exit 1; }
    [ "$STG_KEY" != "$KEY" ] || { echo "Staging must not use the live key. Make a second key (Anthropic Console or openrouter.ai). Nothing changed."; exit 1; }
  fi
fi
signed_in
step "Into Secret Manager"
put() { if secret_exists "$1"; then gcloud secrets versions add "$1" --data-file=- >/dev/null; else gcloud secrets create "$1" --replication-policy=automatic --data-file=- >/dev/null; fi; }
VIA=Anthropic; case "$KEY" in sk-or-*) VIA=OpenRouter ;; esac
printf '%s' "$KEY" | put summitops-assistant-api-key
[ -n "$STG_KEY" ] && printf '%s' "$STG_KEY" | put summitops-staging-assistant-api-key
unset KEY
for S in "$PROD_SERVICE" "$STAGING_SERVICE"; do
  if [ "$S" = "$STAGING_SERVICE" ] && [ -z "$STG_KEY" ]; then
    if gcloud run services describe "$S" --region "$REGION" --format='value(metadata.name)' >/dev/null 2>&1; then
      gcloud run services update "$S" --region "$REGION" --remove-secrets ASSISTANT_API_KEY --quiet >/dev/null 2>&1 || true
    fi
    echo "Staging: assistant off (no key)."; continue
  fi
  SERVICE="$S"
  NAME=summitops-assistant-api-key; [ "$S" = "$STAGING_SERVICE" ] && NAME=summitops-staging-assistant-api-key
  if ! gcloud run services describe "$SERVICE" --region "$REGION" --format='value(metadata.name)' >/dev/null 2>&1; then echo "No $SERVICE service yet: skipped."; continue; fi
  load_service
  SA="$(echo "$SVC_JSON" | jq -r '.spec.template.spec.serviceAccountName // empty')"
  [ -n "$SA" ] && let_read "$NAME" "$SA"
  step "On $SERVICE"
  gcloud run services update "$SERVICE" --region "$REGION" --update-secrets "ASSISTANT_API_KEY=$NAME:latest" --quiet
done
[ "$VIA" = OpenRouter ] && echo "OpenRouter key: questions go through OpenRouter, to Anthropic only unless OPENROUTER_PROVIDERS says otherwise."
echo "Done. Ask now shows in the menu, and managers set it up under Account, Assistant."
