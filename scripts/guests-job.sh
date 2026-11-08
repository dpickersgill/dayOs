#!/usr/bin/env bash
# The guests job (2026.11.8): birthday gifts, evening recaps, morning messages, gift deliveries, payment plan charges,
# pass waitlist offers and scan review. Run once from the unzipped folder in Cloud Shell, after promote.sh:
#
#   bash scripts/guests-job.sh
#
# It adds (or updates) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/guests on the live service every
# 5 minutes signed with a Google ID token for summitops-jobs (no key stored in the job). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every 5 minutes (Cloud Scheduler)"
# Signed with a Google ID token for summitops-jobs, checked by the app (2026.11.11): no key is stored in the job.
ensure_jobs_oidc
# Made, or changed in place through the Cloud Scheduler API (app_job in cloud-common.sh: gcloud's update crashes).
app_job summitops-guests "*/5 * * * *" /api/v1/internal/jobs/guests 120s
echo "Done. Check it with: gcloud scheduler jobs run summitops-guests --location $REGION"
