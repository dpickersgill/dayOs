#!/usr/bin/env bash
# The ski school's frequent job (2026.11.5): waitlist offers that ran out, privates the instructor did not answer in time,
# recaps due, and lineups locking at their start. Run once from the unzipped folder in Cloud Shell, after promote.sh:
#
#   bash scripts/lessons-job.sh
#
# It adds (or updates) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/lessons on the live service every
# 5 minutes signed with a Google ID token for summitops-jobs (no key stored in the job). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every 5 minutes (Cloud Scheduler)"
BASE="$(check_url)"
# Signed with a Google ID token for summitops-jobs, checked by the app (2026.11.11): no key is stored in the job.
ensure_jobs_oidc
ARGS=(--location "$REGION" --schedule "*/5 * * * *" --time-zone "America/New_York" --uri "$BASE/api/v1/internal/jobs/lessons" --http-method POST "${JOB_AUTH[@]}" --attempt-deadline=120s --quiet)
if gcloud scheduler jobs describe summitops-lessons --location "$REGION" >/dev/null 2>&1; then gcloud scheduler jobs update http summitops-lessons "${ARGS[@]}" --remove-headers x-jobs-key
else gcloud scheduler jobs create http summitops-lessons "${ARGS[@]}"; fi
echo "Done. Check it with: gcloud scheduler jobs run summitops-lessons --location $REGION"
