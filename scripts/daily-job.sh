#!/usr/bin/env bash
# The daily job (patrol follow-up, reminders, the morning's reports). Run once from the unzipped folder in Cloud Shell,
# after promote.sh, and again any time to put its settings right:
#
#   bash scripts/daily-job.sh
#
# It adds (or updates in place) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/daily on the live service at
# 7:30 am Eastern, signed with a Google ID token for summitops-jobs (no key stored in the job), with 15 minutes to
# finish. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every day at 7:30 am Eastern (Cloud Scheduler)"
# Signed with a Google ID token for summitops-jobs, checked by the app (2026.11.11): no key is stored in the job.
ensure_jobs_oidc
# Made, or changed in place through the Cloud Scheduler API (app_job in cloud-common.sh: gcloud's update crashes).
app_job summitops-daily "30 7 * * *" /api/v1/internal/jobs/daily 900s
echo "Done. Check it with: gcloud scheduler jobs run summitops-daily --location $REGION"
