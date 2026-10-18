#!/usr/bin/env bash
# One-time security setup for Google Cloud, run from the unzipped folder in Cloud Shell:   bash scripts/harden.sh
# Safe to run again: each step checks what is already in place. What it does (security review findings in brackets):
#   1. A service account just for the app, with only the roles it needs, instead of the default one with Editor [H2]
#   2. Every key the app holds (Stripe, Postmark, the job key, the phone-alert keys) moved into Secret Manager [M6]
#   3. A database login for the app that can change rows but not tables or the audit trail; the current login is
#      kept for migrations only [M4, M5]
#   4. The database refuses unencrypted connections and cannot be deleted by accident [L4]
#   5. A copy of every audit event kept for 400 days in its own log bucket, outside the database [M5]
#   6. The app redeployed with all of the above, then checked
# Two steps cannot be undone, so they only run when asked for:
#   --lock-audit      locks the audit log bucket so nobody (you included) can shorten or delete it
#   --remove-editor   takes the Editor role away from the default compute account (after giving it what builds need)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
LOCK_AUDIT=0; REMOVE_EDITOR=0
for a in "$@"; do
  case "$a" in
    --lock-audit) LOCK_AUDIT=1 ;;
    --remove-editor) REMOVE_EDITOR=1 ;;
    *) echo "Unknown option $a"; exit 1 ;;
  esac
done

step "Checking you are signed in to Google Cloud"
signed_in
load_service
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud services enable secretmanager.googleapis.com sqladmin.googleapis.com iam.googleapis.com logging.googleapis.com --quiet

step "1. The app's own service account"
if ! gcloud iam service-accounts describe "$RUN_SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create summitops-run --display-name "DAY/OS app (Cloud Run)"
  sleep 5
fi
for role in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter roles/cloudtrace.agent; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUN_SA" --role "$role" --condition=None --quiet >/dev/null
done
echo "summitops-run can reach the database and write logs. It gets its own secrets one by one in step 3."

step "2. Keys into Secret Manager"
SECRETS=()
for name in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET POSTMARK_SERVER_TOKEN TWILIO_AUTH_TOKEN JOBS_KEY BOOTSTRAP_KEY TOTP_KEY LINK_SECRET KIOSK_SECRET PLATFORM_TOTP_SECRET PLATFORM_KEY; do
  val="$(envval "$name")"
  [ -z "$val" ] && continue
  sname="summitops-$(echo "$name" | tr 'A-Z_' 'a-z-')"
  if secret_exists "$sname"; then
    printf '%s' "$val" | gcloud secrets versions add "$sname" --data-file=- >/dev/null
  else
    printf '%s' "$val" | gcloud secrets create "$sname" --replication-policy=automatic --data-file=- >/dev/null
  fi
  SECRETS+=("$name=$sname:latest")
  echo "Moved $name to $sname"
done
[ ${#SECRETS[@]} -eq 0 ] && echo "No keys left in plain settings."

step "3. A database login for the app that cannot change tables"
AS=migrator open_db
OLD_DB_SECRET="$(secretof DB_PASSWORD)"
APP_DB_SECRET=""
if [ "$(envval DB_USER)" = summitops_app ]; then
  echo "The app already uses summitops_app. Refreshing what it may do."
  node scripts/db-runtime-user.js summitops_app
  OLD_DB_SECRET=""
else
  # Keep the current login for migrations only. The running service is never given this secret.
  jq -n --arg u "$DB_USER" --arg p "$DB_PASSWORD" '{user:$u,password:$p}' > /tmp/migrator.json
  if secret_exists summitops-db-migrator; then gcloud secrets versions add summitops-db-migrator --data-file=/tmp/migrator.json >/dev/null
  else gcloud secrets create summitops-db-migrator --replication-policy=automatic --data-file=/tmp/migrator.json >/dev/null; fi
  rm -f /tmp/migrator.json
  APP_PW="$(openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-40)"
  node scripts/db-runtime-user.js summitops_app "$APP_PW"
  if secret_exists summitops-db-app-password; then printf '%s' "$APP_PW" | gcloud secrets versions add summitops-db-app-password --data-file=- >/dev/null
  else printf '%s' "$APP_PW" | gcloud secrets create summitops-db-app-password --replication-policy=automatic --data-file=- >/dev/null; fi
  APP_DB_SECRET="summitops-db-app-password"
  echo "The app will sign in to the database as summitops_app. Migrations keep using $DB_USER."
fi
# The phone-alert key pair moves from the database to Secret Manager unchanged, so phones already signed up keep working.
VAPID_JSON="$(node scripts/vapid-export.js || true)"
VAPID_MOVED=0
if [ -n "$VAPID_JSON" ] && [ -z "$(secretof VAPID_PRIVATE_KEY)" ]; then
  for part in pub:summitops-vapid-public priv:summitops-vapid-private; do
    k="${part%%:*}"; sname="${part#*:}"
    v="$(echo "$VAPID_JSON" | jq -r --arg k "$k" '.[$k]')"
    if secret_exists "$sname"; then printf '%s' "$v" | gcloud secrets versions add "$sname" --data-file=- >/dev/null
    else printf '%s' "$v" | gcloud secrets create "$sname" --replication-policy=automatic --data-file=- >/dev/null; fi
  done
  SECRETS_ONLY=("VAPID_PUBLIC_KEY=summitops-vapid-public:latest" "VAPID_PRIVATE_KEY=summitops-vapid-private:latest")
  VAPID_MOVED=1
  echo "Moved the phone-alert keys to Secret Manager."
else
  SECRETS_ONLY=()
fi
# summitops-run may read only the secrets the service uses, never the migration login.
gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor --condition=None --quiet >/dev/null 2>&1 || true
NEEDED="$( { echo "$SVC_JSON" | jq -r '.spec.template.spec.containers[0].env[]? | .valueFrom.secretKeyRef.name // empty'; printf '%s\n' "${SECRETS[@]}" "${SECRETS_ONLY[@]}" | sed -n 's/^[^=]*=\(.*\):latest$/\1/p'; echo "$APP_DB_SECRET"; } | grep -v "^$" | sort -u || true)"
for s in $NEEDED; do
  [ "$s" = summitops-db-migrator ] && continue
  [ -n "$OLD_DB_SECRET" ] && [ "$s" = "$OLD_DB_SECRET" ] && continue
  gcloud secrets add-iam-policy-binding "$s" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null
done
if [ -n "$OLD_DB_SECRET" ]; then
  gcloud secrets remove-iam-policy-binding "$OLD_DB_SECRET" --member "serviceAccount:$RUN_SA" --role roles/secretmanager.secretAccessor --quiet >/dev/null 2>&1 || true
fi

step "4. Database connections"
if [ -n "${SQL_CONN:-}" ]; then
  INSTANCE="${SQL_CONN##*:}"
  gcloud sql instances patch "$INSTANCE" --ssl-mode=ENCRYPTED_ONLY --deletion-protection --quiet
  NETS="$(gcloud sql instances describe "$INSTANCE" --format='value(settings.ipConfiguration.authorizedNetworks[].value)')"
  if [ -n "$NETS" ]; then echo "Warning: these addresses can reach the database directly: $NETS. Remove them unless you need them (Cloud SQL, Connections)."; fi
  echo "$INSTANCE now refuses unencrypted connections and is protected from deletion."
else
  echo "Not on Cloud SQL yet (move-to-cloudsql.sh). Skipped."
fi

step "5. Audit events kept outside the database"
if ! gcloud logging buckets describe summitops-audit --location=global >/dev/null 2>&1; then
  gcloud logging buckets create summitops-audit --location=global --retention-days=400 --description "DAY/OS audit events (sign-ins, console actions, record changes)"
fi
FILTER='logName="projects/'"$PROJECT"'/logs/summitops-audit" OR jsonPayload.logName="summitops-audit"'
if gcloud logging sinks describe summitops-audit >/dev/null 2>&1; then
  gcloud logging sinks update summitops-audit "logging.googleapis.com/projects/$PROJECT/locations/global/buckets/summitops-audit" --log-filter="$FILTER" --quiet
else
  gcloud logging sinks create summitops-audit "logging.googleapis.com/projects/$PROJECT/locations/global/buckets/summitops-audit" --log-filter="$FILTER" --quiet
fi
if [ "$LOCK_AUDIT" = 1 ]; then
  gcloud logging buckets update summitops-audit --location=global --locked --quiet
  echo "Locked: audit events are kept 400 days and nobody can shorten that."
else
  echo "Kept 400 days. To lock it so nobody can delete or shorten it (cannot be undone): bash scripts/harden.sh --lock-audit"
fi

step "6. Redeploying with the new account, keys and login"
UPDATE=(--service-account "$RUN_SA")
SET_SECRETS=("${SECRETS[@]}" "${SECRETS_ONLY[@]}")
ENV_CHANGE=()
if [ -n "$APP_DB_SECRET" ]; then
  SET_SECRETS+=("DB_PASSWORD=$APP_DB_SECRET:latest")
  ENV_CHANGE+=(--update-env-vars DB_USER=summitops_app)
fi
# A setting moving from plain to secret is removed and added back as a secret in the same update, so it is never missing.
if [ ${#SECRETS[@]} -gt 0 ]; then ENV_CHANGE+=(--remove-env-vars "$(printf '%s\n' "${SECRETS[@]}" | cut -d= -f1 | paste -sd, -)"); fi
if [ ${#SET_SECRETS[@]} -gt 0 ]; then UPDATE+=(--update-secrets "$(IFS=,; echo "${SET_SECRETS[*]}")"); fi
gcloud run services update "$SERVICE" --region "$REGION" --quiet "${UPDATE[@]}" "${ENV_CHANGE[@]}"
load_service
sleep 5
OUT="$(curl -s "$(check_url)/readyz" || true)"
echo "$OUT"
case "$OUT" in
  *'"ok":true'*) echo "The app is running with the new setup."
    if [ "$VAPID_MOVED" = 1 ]; then node scripts/vapid-export.js --forget && echo "Removed the database copy of the phone-alert keys."; fi ;;
  *) echo "The app did not answer as expected. Roll back in the console: Cloud Run, summitops-api, Revisions, send traffic to the previous one."; exit 1 ;;
esac

if [ "$REMOVE_EDITOR" = 1 ]; then
  step "Taking Editor away from the default compute account"
  # Builds (gcloud run deploy --source) run as this account, so give it what a build needs first.
  for role in roles/cloudbuild.builds.builder roles/artifactregistry.writer roles/logging.logWriter roles/storage.objectViewer; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$COMPUTE_SA" --role "$role" --condition=None --quiet >/dev/null
  done
  gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$COMPUTE_SA" --role roles/editor --condition=None --quiet >/dev/null 2>&1 || true
  echo "Done. If a later deploy fails at the build step, run: gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$COMPUTE_SA --role roles/editor"
fi

printf '\nSecurity setup finished.\n'
[ "$REMOVE_EDITOR" = 1 ] || echo "Optional: bash scripts/harden.sh --remove-editor   (default compute account loses Editor)"
echo "Optional: bash scripts/cloud-armor.sh www.yourdomain.com app.yourdomain.com   (web firewall in front of the app; see RUNBOOK.md)"
