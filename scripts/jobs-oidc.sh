#!/usr/bin/env bash
# Scheduled jobs without a stored key (2026.11.11, security review INF-4). Run once from the unzipped folder in Cloud
# Shell, after promote.sh has put 2026.11.11 live:   bash scripts/jobs-oidc.sh
#
# Before this, every Cloud Scheduler job (daily, guests, lessons, outreach) sent the JOBS_KEY in a header, stored in
# clear in the job, and anyone who could read the jobs could run them. Now each job signs its call with a Google ID
# token for the summitops-jobs service account, and the app checks Google's signature, the address and the account
# (src/lib/jobauth.js). Once that works, the app refuses the old key and the key is taken off the service.
# Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

# Signs one job's calls. `gcloud scheduler jobs update http` crashes in current gcloud (TypeError on NoneType), so this
# changes the job through the Cloud Scheduler API (sched_patch in cloud-common.sh): it reads the job, drops the old key
# header, the User-Agent header (Google sets that one) and any OAuth token, adds the Google ID token, and sends back the
# httpTarget only.
sched_sign() { # job
  local target
  target="$(sched_target "$1" | jq -c --arg sa "$JOBS_SA" --arg aud "$SVC_URL" '{httpTarget: (del(.oauthToken) | .oidcToken = {serviceAccountEmail: $sa, audience: $aud})}')"
  printf '%s' "$target" | sched_patch "$1" httpTarget
}

step "1. The jobs account, and the app told to accept its signed calls"
ensure_jobs_oidc

step "2. Every job that calls the app signs its calls"
MOVED=0
while read -r name uri; do
  [ -n "$uri" ] || continue
  case "$uri" in */api/v1/internal/jobs/*) ;; *) continue ;; esac
  job="${name##*/}"
  sched_sign "$job"
  echo "  $job now signs its calls as $JOBS_SA"
  MOVED=$((MOVED + 1))
done < <(gcloud scheduler jobs list --location "$REGION" --format='value(name,httpTarget.uri)')
[ "$MOVED" -gt 0 ] || { echo "No scheduled jobs call the app. Make them first (RUNBOOK.md, Scheduled jobs)."; exit 1; }

step "3. Checking a signed call works"
gcloud scheduler jobs run summitops-guests --location "$REGION" --quiet >/dev/null 2>&1 || true
sleep 20
CODE="$(gcloud scheduler jobs describe summitops-guests --location "$REGION" --format='value(status.code)' 2>/dev/null || true)"
if [ -n "$CODE" ] && [ "$CODE" != 0 ]; then
  echo "The guests job did not get through (status $CODE). Logs: gcloud run services logs read $SERVICE --region $REGION --limit 30"
  echo "The old key still works until this check passes. Fix it and run this again."
  exit 1
fi
echo "  The guests job got through with a signed call."

step "4. The old key off the service"
if [ -n "$(secretof JOBS_KEY)" ]; then
  gcloud run services update "$SERVICE" --region "$REGION" --quiet --remove-secrets JOBS_KEY >/dev/null
elif [ -n "$(envval JOBS_KEY)" ]; then
  gcloud run services update "$SERVICE" --region "$REGION" --quiet --remove-env-vars JOBS_KEY >/dev/null
fi
echo "Done. The jobs run with signed calls only, and no key is stored in Cloud Scheduler."
echo "If you ever need the old key back for a while: set JOBS_KEY again and JOBS_KEY_FALLBACK=on on the service."
