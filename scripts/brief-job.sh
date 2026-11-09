#!/usr/bin/env bash
# The morning brief's job (ai/brief): sends each mountain's brief from 6:00 AM in its own time zone on days its calendar
# says it is open, and the day before opening day. Run once from the unzipped folder in Cloud Shell, after promote.sh:
#
#   bash scripts/brief-job.sh
#
# It adds (or updates in place) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/brief on the live service
# every 15 minutes, signed with a Google ID token for summitops-jobs (no key stored in the job), with 2 minutes to
# finish. Every 15 minutes, because the daily job runs at 7:30 AM Eastern only, which is after 6:00 AM in every
# mountain's time zone. Safe to run again, and safe for the job to run often: each person's brief is claimed before it
# is sent, so nobody gets the same day's brief twice. Each run stops starting sends after 100 seconds and the next
# run carries on; the daily job finishes anything left.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every 15 minutes (Cloud Scheduler)"
# Signed with a Google ID token for summitops-jobs, checked by the app (2026.11.11): no key is stored in the job.
ensure_jobs_oidc
# Made, or changed in place through the Cloud Scheduler API (app_job in cloud-common.sh: gcloud's update crashes).
app_job summitops-brief "*/15 * * * *" /api/v1/internal/jobs/brief 120s
echo "Done. Check it with: gcloud scheduler jobs run summitops-brief --location $REGION"
