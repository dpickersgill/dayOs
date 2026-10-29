#!/usr/bin/env bash
# The ski school's frequent job (2026.11.5): waitlist offers that ran out, privates the instructor did not answer in time,
# recaps due, and lineups locking at their start. Run once from the unzipped folder in Cloud Shell, after promote.sh:
#
#   bash scripts/lessons-job.sh
#
# It adds (or updates) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/lessons on the live service every
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
ARGS=(--location "$REGION" --schedule "*/5 * * * *" --time-zone "America/New_York" --uri "$BASE/api/v1/internal/jobs/lessons" --http-method POST --headers "x-jobs-key=$(secret_read "$JOBS")" --attempt-deadline=120s --quiet)
if gcloud scheduler jobs describe summitops-lessons --location "$REGION" >/dev/null 2>&1; then gcloud scheduler jobs update http summitops-lessons "${ARGS[@]}"
else gcloud scheduler jobs create http summitops-lessons "${ARGS[@]}"; fi
echo "Done. Check it with: gcloud scheduler jobs run summitops-lessons --location $REGION"
