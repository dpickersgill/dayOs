#!/usr/bin/env bash
# The shared Text HELP number's job (help/shared): a guest whose text to the shared help number did not say which ski area
# is texted again after 3 minutes, and the request closes after 2 hours with a last text. Run once from the unzipped
# folder in Cloud Shell, after promote.sh:
#
#   bash scripts/help-texts-job.sh
#
# It adds (or updates) a Cloud Scheduler job that calls POST /api/v1/internal/jobs/help-texts on the live service every
# minute, signed with a Google ID token for summitops-jobs (no key stored in the job). Safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
signed_in
SERVICE="$PROD_SERVICE"
load_service

step "Every minute (Cloud Scheduler)"
ensure_jobs_oidc
app_job summitops-help-texts "* * * * *" /api/v1/internal/jobs/help-texts 60s
echo "Done. Check it with: gcloud scheduler jobs run summitops-help-texts --location $REGION"
