#!/usr/bin/env bash
# The guests job (2026.11.8): birthday gifts, evening recaps, morning messages, gift deliveries, payment plan charges,
# pass waitlist offers and scan review. Run once from the unzipped folder in Cloud Shell, after promote.sh:
#
#   bash scripts/guests-job.sh
#
# It adds (or updates) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/guests on the live service every
# 5 minutes with the same JOBS_KEY the daily job uses. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every 5 minutes (Cloud Scheduler)"
BASE="$(check_url)"
JOBS="$(secretof JOBS_KEY)"
if [ -z "$JOBS" ]; then echo "The service has no JOBS_KEY yet (see RUNBOOK.md, Patrol follow-up emails). Add it, then run this again."; exit 1; fi
ARGS=(--location "$REGION" --schedule "*/5 * * * *" --time-zone "America/New_York" --uri "$BASE/api/v1/internal/jobs/guests" --http-method POST --headers "x-jobs-key=$(secret_read "$JOBS")" --attempt-deadline=120s --quiet)
if gcloud scheduler jobs describe summitops-guests --location "$REGION" >/dev/null 2>&1; then gcloud scheduler jobs update http summitops-guests "${ARGS[@]}"
else gcloud scheduler jobs create http summitops-guests "${ARGS[@]}"; fi
echo "Done. Check it with: gcloud scheduler jobs run summitops-guests --location $REGION"
