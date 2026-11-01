#!/usr/bin/env bash
# Gives the live app's keys new values (2026.11.11, review INF-7). Run from the unzipped folder in Cloud Shell, after
# harden.sh has moved them into Secret Manager:   bash scripts/rotate-secrets.sh
# A key that was ever a plain setting is still written in old revisions and may have been seen; moving it did not
# change it. For each key below it asks for the new value (it is not shown and not kept in the shell history), or
# makes a random one where the app alone uses it. Press Enter to skip a key.
#   Stripe secret key            Stripe dashboard, Developers, API keys, Roll key (then paste the new one)
#   Stripe webhook secrets       Stripe dashboard, Developers, Webhooks, the endpoint, Roll secret
#   Postmark server token        Postmark, the server, API Tokens, generate a new one (then delete the old one there)
#   Twilio auth token            Twilio console, Account, API keys and tokens, request a secondary token, promote it
#   Anthropic keys               Anthropic Console, API keys, create a new one (then delete the old one there)
#   Bootstrap and platform keys  made here at random (the bootstrap key is only for making mountains)
# NOT rotated here, because a new value would break what people already have: TOTP_KEY (every two-step app),
# LINK_SECRET (every link already sent), KIOSK_SECRET (every paired kiosk), PLATFORM_TOTP_SECRET, the phone-alert keys
# and JWT_SECRET (everyone signed out). Rotate those only on purpose, with RUNBOOK.md.
# Then the service is redeployed to read the new values, older secret versions are disabled, and older revisions that
# held plain keys are deleted (harden.sh, step 8).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service
rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }

ASK=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET POSTMARK_SERVER_TOKEN TWILIO_AUTH_TOKEN ANTHROPIC_API_KEY ASSISTANT_API_KEY)
MAKE=(BOOTSTRAP_KEY PLATFORM_KEY)
CHANGED=()

newval() { # secret value-on-stdin
  gcloud secrets versions add "$1" --data-file=- >/dev/null
  CHANGED+=("$1")
}

step "Keys from their providers"
for name in "${ASK[@]}"; do
  s="$(secretof "$name")"
  if [ -z "$s" ]; then
    [ -n "$(envval "$name")" ] && echo "  $name is still a plain setting: run bash scripts/harden.sh first."
    continue
  fi
  read -r -s -p "  New $name (Enter to skip): " V; echo
  [ -n "$V" ] || continue
  if [ "$V" = "$(secret_read "$s")" ]; then echo "  That is the value it has now. Skipped."; unset V; continue; fi
  printf '%s' "$V" | newval "$s"; unset V
  echo "  $name: new value saved in $s"
done

step "Keys the app alone uses"
for name in "${MAKE[@]}"; do
  s="$(secretof "$name")"; [ -n "$s" ] || continue
  read -r -p "  Make a new random $name? Type yes, or Enter to skip: " Y
  [ "$Y" = yes ] || continue
  rand 48 | newval "$s"
  echo "  $name: new value saved in $s (read it with: gcloud secrets versions access latest --secret=$s)"
done

[ ${#CHANGED[@]} -gt 0 ] || { echo "Nothing changed."; exit 0; }

step "The app reads the new values"
gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars "SECRETS_ROTATED_AT=$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null
load_service; sleep 5
OUT="$(curl -s "$(check_url)/readyz" || true)"; echo "$OUT"
case "$OUT" in *'"ok":true'*) ;; *) echo "The app did not answer as expected. The old values are still enabled; fix it before running this again."; exit 1 ;; esac

step "Older versions disabled"
for s in "${CHANGED[@]}"; do
  latest="$(gcloud secrets versions list "$s" --filter='state=ENABLED' --sort-by='~createTime' --format='value(name.basename())' | head -1)"
  for v in $(gcloud secrets versions list "$s" --filter='state=ENABLED' --format='value(name.basename())'); do
    [ "$v" = "$latest" ] && continue
    gcloud secrets versions disable "$v" --secret "$s" --quiet >/dev/null && echo "  $s version $v disabled"
  done
done

step "Older revisions that held plain keys"
clean_plain_revisions
echo "Done. Delete the old values at each provider too (the old Stripe key, Postmark token, Twilio token, Anthropic key)."
