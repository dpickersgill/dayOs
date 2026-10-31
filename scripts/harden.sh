#!/usr/bin/env bash
# One-time security setup for Google Cloud, run from the unzipped folder in Cloud Shell:   bash scripts/harden.sh
# Safe to run again: each step checks what is already in place. What it does (security review findings in brackets):
#   1. A service account just for the live app, with only the roles it needs, instead of the default one with Editor [H2]
#      (staging runs as its own account, summitops-staging, made by staging-setup.sh; it is never given a live secret)
#   2. Every key the app holds (Stripe, Postmark, the job key, the phone-alert keys) moved into Secret Manager [M6]
#   3. A database login for the app that can change rows but not tables, and can only add to the audit trail; the current login is
#      kept for migrations only [M4, M5]
#   4. The database refuses unencrypted connections and cannot be deleted by accident [L4]
#   5. A copy of every audit event kept for 400 days in its own log bucket, outside the database [M5]
#   6. The app redeployed with all of the above, then checked
#   7. (2026.11.11) Builds run as their own account (summitops-build: Artifact Registry, logs, the uploaded source), and
#      the default compute account loses Editor and any project-wide read of storage (the weekly database copies)
#   8. (2026.11.11) Older app revisions that still hold a key in a plain setting are deleted, so the key is gone from
#      them too. Then rotate each key at its provider: bash scripts/rotate-secrets.sh
# Options:
#   --lock-audit      locks the audit log bucket so nobody (you included) can shorten or delete it (cannot be undone)
#   --keep-editor     leaves Editor on the default compute account (not recommended; only if something else of yours
#                     runs as that account and needs it)
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
LOCK_AUDIT=0; REMOVE_EDITOR=1
for a in "$@"; do
  case "$a" in
    --lock-audit) LOCK_AUDIT=1 ;;
    --remove-editor) REMOVE_EDITOR=1 ;; # the default since 2026.11.11; kept so older notes still work
    --keep-editor) REMOVE_EDITOR=0 ;;
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
  gcloud iam service-accounts create summitops-run --display-name "Verdynt/OS app (Cloud Run)"
  sleep 5
fi
for role in roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter roles/cloudtrace.agent; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$RUN_SA" --role "$role" --condition=None --quiet >/dev/null
done
echo "summitops-run can reach the database and write logs. It gets its own secrets one by one in step 3."

step "2. Keys into Secret Manager"
SECRETS=()
# MOVABLE is also read by rotate-secrets.sh. ANTHROPIC_API_KEY is the patrol assistant's (BAA) key; ASSISTANT_API_KEY the
# in-app assistant's (assistant-key.sh puts that one in Secret Manager already).
MOVABLE=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET POSTMARK_SERVER_TOKEN TWILIO_AUTH_TOKEN JOBS_KEY BOOTSTRAP_KEY TOTP_KEY LINK_SECRET KIOSK_SECRET PLATFORM_TOTP_SECRET PLATFORM_KEY ANTHROPIC_API_KEY ASSISTANT_API_KEY)
for name in "${MOVABLE[@]}"; do
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
  printf %s "$APP_PW" | node scripts/db-runtime-user.js summitops_app -
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
# Staging's account never reads a live secret.
if gcloud iam service-accounts describe "$STAGING_SA" >/dev/null 2>&1; then
  for s in $NEEDED summitops-db-migrator; do secret_exists "$s" && stop_read "$s" "$STAGING_SA"; done
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
  gcloud logging buckets create summitops-audit --location=global --retention-days=400 --description "Verdynt/OS audit events (sign-ins, console actions, record changes)"
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
elif [ "$(gcloud logging buckets describe summitops-audit --location=global --format='value(locked)' 2>/dev/null)" = True ]; then
  echo "Locked already: audit events are kept 400 days and nobody can shorten that."
else
  # Asked every run until it is locked (2026.11.11): an unlocked audit trail can be cut short by anyone with Editor.
  echo "Kept 400 days, but not locked: someone with enough access could still shorten or delete it."
  read -r -p "Type lock to lock it now (cannot be undone), or press Enter to leave it for now: " L
  if [ "$L" = lock ]; then gcloud logging buckets update summitops-audit --location=global --locked --quiet; echo "Locked."; fi
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

step "7. Builds as their own account; the default compute account loses Editor"
ensure_build_sa
# Before 2026.11.11 --remove-editor gave the default account what builds needed, including read of EVERY bucket in the
# project (the weekly database copies too). Builds now run as summitops-build, so the default account needs none of it.
for role in roles/storage.objectViewer roles/cloudbuild.builds.builder roles/artifactregistry.writer; do
  gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$COMPUTE_SA" --role "$role" --condition=None --quiet >/dev/null 2>&1 && echo "  $COMPUTE_SA no longer has $role" || true
done
if [ "$REMOVE_EDITOR" = 1 ]; then
  gcloud projects remove-iam-policy-binding "$PROJECT" --member "serviceAccount:$COMPUTE_SA" --role roles/editor --condition=None --quiet >/dev/null 2>&1 && echo "  $COMPUTE_SA no longer has Editor" || true
  echo "The default compute account has no Editor role. Builds run as $BUILD_SA."
else
  echo "WARNING: --keep-editor: $COMPUTE_SA keeps Editor. Anything running as it can change the whole project and read every"
  echo "  bucket, the weekly database copies included. Run bash scripts/harden.sh without --keep-editor when you can."
fi

step "8. Older revisions that still hold a key in a plain setting"
# A key moved to Secret Manager is still written, in plain text, in every earlier revision of the service. Those
# revisions are deleted (the one serving now, and the newest, are never touched).
if [ ${#SECRETS[@]} -gt 0 ] || [ "${CLEAN_REVISIONS:-}" = 1 ]; then
  NAMES_JSON="$(printf '%s\n' "${MOVABLE[@]}" | jq -R . | jq -s .)"
  SERVING="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json | jq -r '[.status.traffic[]? | select((.percent // 0) > 0) | .revisionName] + [.status.latestReadyRevisionName] | .[]')"
  gcloud run revisions list --service "$SERVICE" --region "$REGION" --format=json \
    | jq -r --argjson names "$NAMES_JSON" '.[] | select([.spec.containers[0].env[]? | select(.value != null and (.name as $n | $names | index($n)))] | length > 0) | .metadata.name' \
    | while read -r rev; do
        if echo "$SERVING" | grep -qx "$rev"; then continue; fi
        gcloud run revisions delete "$rev" --region "$REGION" --quiet >/dev/null && echo "  Deleted $rev (it held a key in a plain setting)"
      done
  echo "Rolling back can only go to revisions made after this. Now give each key a new value: bash scripts/rotate-secrets.sh"
else
  echo "  Nothing moved this time. To check again anyway: CLEAN_REVISIONS=1 bash scripts/harden.sh"
fi

printf '\nSecurity setup finished.\n'
echo "Optional: bash scripts/cloud-armor.sh www.yourdomain.com app.yourdomain.com   (web firewall in front of the app; see RUNBOOK.md)"
