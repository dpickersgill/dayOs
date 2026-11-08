#!/usr/bin/env bash
# Security alerts (2026.11.11, review INF-12). Run once from the unzipped folder in Cloud Shell, after
# scripts/uptime-setup.sh (it sends to the same text and email channels):   bash scripts/security-alerts.sh
# Safe to run again: it updates what is there. Each alert is a log-based metric with an alert policy on it:
#   1. Stripe webhook signature refused (any): a wrong signing secret, or someone sending fake payment events
#   2. Sign-in lockouts and "too many attempts" (more than 20 in 5 minutes): someone guessing passwords
#   3. Platform console sign-ins (any): you should recognize every one
#   4. Data exports (more than 10 in an hour): someone pulling data out in bulk
#   5. Server errors (more than 20 answers of 500 or more in 5 minutes)
#   6. A scheduled job call refused (any): the job is misconfigured, or someone is calling the job address
#   7. Failed staff sign-ins (more than 30 in 5 minutes): a slow password spray across many logins never trips the
#      lockout or "too many" alert, so the sign_in_failed audit events are counted (feat/auth-hardening)
#   8. Failed console sign-ins (more than 2 in 15 minutes): someone trying the platform console
# What to do about each: RUNBOOK.md, "Security alerts". A new metric needs a few minutes before an alert can use it: if
# a policy says "not yet", run this again 10 minutes later. Any other failure (a missing permission, a bad filter) is
# printed with Google's message, the script carries on with the rest, and it ends with exit status 1.
# It also turns on Data Access audit logs for Secret Manager and Cloud SQL, so every read of a secret and every
# database administration call is recorded by Google (Logging, Logs Explorer, "data_access").
#   --dry-run   print what would change, change nothing
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
DRY=""; [ "${1:-}" = --dry-run ] && DRY=1
# "would run" goes to the terminal (file descriptor 3) even where the command's own output is thrown away.
exec 3>&1
run() { if [ -n "$DRY" ]; then printf '  would run: %s\n' "$*" >&3; else "$@"; fi; }
ALPHA=(gcloud alpha monitoring)
signed_in

step "Where alerts go (the channels uptime-setup.sh made)"
CHANNELS="$("${ALPHA[@]}" channels list --format='value(name,displayName)' 2>/dev/null | grep -F 'Verdynt/OS:' | cut -f1 | paste -sd, - || true)"
[ -n "$CHANNELS" ] || { echo "No alert channels yet. Run bash scripts/uptime-setup.sh first."; exit 1; }
echo "  $CHANNELS"

RUN='resource.type="cloud_run_revision" AND resource.labels.service_name="'"$PROD_SERVICE"'"'
# name|description|filter|threshold (count above which it alerts)|window seconds
ALERTS=(
  "summitops-webhook-bad-signature|Stripe webhook signature refused|$RUN AND jsonPayload.job=\"stripe_webhook\" AND jsonPayload.message=\"bad signature\"|0|300"
  "summitops-signin-lockouts|Sign-in lockouts and too many attempts|$RUN AND httpRequest.status=429 AND httpRequest.requestUrl:\"/api/v1/auth/\"|20|300"
  "summitops-console-signins|Platform console sign-in|$RUN AND jsonPayload.logName=\"summitops-audit\" AND jsonPayload.console=true AND jsonPayload.action=\"sign_in\"|0|60"
  "summitops-exports|Data exports in bulk|$RUN AND jsonPayload.logName=\"summitops-audit\" AND jsonPayload.action=~\"^export\"|10|3600"
  "summitops-5xx-burst|Server errors in a burst|$RUN AND httpRequest.status>=500|20|300"
  "summitops-job-refused|A scheduled job call refused|$RUN AND jsonPayload.job_auth=\"refused\"|0|300"
  "summitops-signin-failures|Failed staff sign-ins|$RUN AND jsonPayload.logName=\"summitops-audit\" AND jsonPayload.action=\"sign_in_failed\" AND NOT jsonPayload.console=true|30|300"
  "summitops-console-signin-failures|Failed console sign-ins|$RUN AND jsonPayload.logName=\"summitops-audit\" AND jsonPayload.console=true AND jsonPayload.action=\"sign_in_failed\"|2|900"
)

step "Log-based metrics and alert policies"
EXISTING="$("${ALPHA[@]}" policies list --format='value(name,displayName)' 2>/dev/null || true)"
# A log-based metric made a moment ago can take Google up to 10 minutes before an alert policy may use it. Such an alert
# is marked "not yet", and a second run makes it. Google's words for that case (Cloud Monitoring, 2026):
#   Cannot find metric(s) that match type = "logging.googleapis.com/user/...". If a metric was created recently, it could
#   take up to 10 minutes to become available.
NOT_READY='Cannot find metric\(s\) that match type|could take up to 10 minutes to become available'
PENDING=0
FAILED=0
for a in "${ALERTS[@]}"; do
  IFS='|' read -r name desc filter threshold window <<< "$a"
  verb=create; gcloud logging metrics describe "$name" >/dev/null 2>&1 && verb=update
  if ! err="$(run gcloud logging metrics "$verb" "$name" --description="$desc" --log-filter="$filter" --quiet 2>&1 >/dev/null)"; then
    echo "  FAILED: the metric $name could not be made or changed:"
    printf '%s\n' "$err" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
    continue
  fi
  title="Verdynt/OS security: $desc"
  if echo "$EXISTING" | grep -qF "$title"; then echo "  kept: $title"; continue; fi
  file="$(mktemp)"
  cat > "$file" <<JSON
{
  "displayName": "$title",
  "combiner": "OR",
  "conditions": [{
    "displayName": "$desc",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/$name\" AND resource.type=\"cloud_run_revision\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": $threshold,
      "duration": "0s",
      "aggregations": [{ "alignmentPeriod": "${window}s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }]
    }
  }],
  "notificationChannels": [$(echo "$CHANNELS" | sed 's/[^,]*/"&"/g')],
  "documentation": { "content": "RUNBOOK.md, Security alerts, says what to do.", "mimeType": "text/markdown" }
}
JSON
  # Only the "metric not ready yet" answer is "not yet" (run the script again later). Anything else is a real failure:
  # Google's message is shown, and the script ends with exit status 1 after doing the rest.
  if [ -n "$DRY" ]; then
    run "${ALPHA[@]}" policies create --policy-from-file="$file"
  elif err="$("${ALPHA[@]}" policies create --policy-from-file="$file" 2>&1 >/dev/null)"; then
    echo "  made: $title"
  elif printf '%s' "$err" | grep -qiE "$NOT_READY"; then
    echo "  not yet: $title (its metric is new; Google needs up to 10 minutes)"
    PENDING=$((PENDING + 1))
  else
    echo "  FAILED: $title could not be made:"
    printf '%s\n' "$err" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
  fi
  rm -f "$file"
done
if [ "$PENDING" -gt 0 ]; then
  echo "Run this again in 10 minutes to finish the $PENDING alert(s) marked 'not yet'. It keeps what is done."
fi

step "Data Access audit logs for Secret Manager and Cloud SQL"
# The audit service for Cloud SQL is cloudsql.googleapis.com (Google rejects sqladmin.googleapis.com here).
POLICY="$(mktemp)"
gcloud projects get-iam-policy "$PROJECT" --format=json > "$POLICY"
NEW="$(jq '.auditConfigs = ((.auditConfigs // []) | map(select(.service != "secretmanager.googleapis.com" and .service != "cloudsql.googleapis.com"))
  + [{"service":"secretmanager.googleapis.com","auditLogConfigs":[{"logType":"ADMIN_READ"},{"logType":"DATA_READ"},{"logType":"DATA_WRITE"}]},
     {"service":"cloudsql.googleapis.com","auditLogConfigs":[{"logType":"ADMIN_READ"},{"logType":"DATA_READ"},{"logType":"DATA_WRITE"}]}])' "$POLICY")"
if [ "$(jq -S .auditConfigs "$POLICY")" != "$(echo "$NEW" | jq -S .auditConfigs)" ]; then
  echo "$NEW" > "$POLICY"
  if [ -n "$DRY" ]; then
    run gcloud projects set-iam-policy "$PROJECT" "$POLICY" --quiet
  elif err="$(gcloud projects set-iam-policy "$PROJECT" "$POLICY" --quiet 2>&1 >/dev/null)"; then
    echo "  Turned on: every read of a secret and every Cloud SQL call is now in the audit logs."
  else
    echo "  FAILED: the audit log settings could not be changed:"
    printf '%s\n' "$err" | sed 's/^/    /'
    FAILED=$((FAILED + 1))
  fi
else
  echo "  Already on."
fi
rm -f "$POLICY"
echo ""
if [ -n "$DRY" ]; then echo "Dry run: nothing was changed."
elif [ "$FAILED" -gt 0 ]; then
  echo "$FAILED step(s) FAILED (shown above with Google's message). Fix what it says, for example a missing permission, and run this again."
  exit 1
elif [ "$PENDING" -gt 0 ]; then echo "Nearly done. The alerts made so far go to the same text and email as the uptime checks."
else echo "Done. Alerts go to the same text and email as the uptime checks."; fi
