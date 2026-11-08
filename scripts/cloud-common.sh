#!/usr/bin/env bash
# Shared by deploy.sh, promote.sh and the scripts in scripts/ (staging-setup.sh, harden.sh, cloud-armor.sh and others): signs in, reads
# a service's settings and opens a database connection on 127.0.0.1:3307 (through the Cloud SQL Auth Proxy). Source it;
# do not run it. SERVICE is the live service unless the script sets DAYOS_TARGET to the staging one first.
PROD_SERVICE=summitops-api
STAGING_SERVICE=summitops-staging
SERVICE="${DAYOS_TARGET:-$PROD_SERVICE}"
REGION=us-east1
PROJECT=summitops-510715
RUN_SA="summitops-run@${PROJECT}.iam.gserviceaccount.com"
# Staging runs as its own account, which may read the summitops-staging-* secrets and no live one (staging-setup.sh).
STAGING_SA="summitops-staging@${PROJECT}.iam.gserviceaccount.com"
# Builds (deploy.sh, staging-setup.sh: gcloud run deploy --source) run as their own account (2026.11.11), never as the
# default compute account, which has Editor on a new project and could read the weekly database copies.
BUILD_SA="summitops-build@${PROJECT}.iam.gserviceaccount.com"

# The weekly database copy (scripts/backups-setup.sh). BACKUP_PROJECT can be a separate project, so the app's project
# (and anything that can build or deploy in it) cannot read or delete the copies.
BACKUP_PROJECT="${BACKUP_PROJECT:-$PROJECT}"
BACKUP_BUCKET="${BACKUP_BUCKET:-gs://${BACKUP_PROJECT}-backups}"

step() { printf '\n== %s\n' "$1"; }

# The Cloud SQL Auth Proxy, downloaded once and checked against the checksum Google publishes for this version
# (https://github.com/GoogleCloudPlatform/cloud-sql-proxy/releases/tag/v2.26.0). A download that does not match is
# deleted and nothing runs. To move to a newer version, change both lines from that version's release page.
PROXY_VERSION=v2.26.0
PROXY_SHA256=a38fe97690a27490e60a7945a8a178186ff9464abb81fe2bc652a3f773443387
proxy_path() {
  local proxy="$HOME/cloud-sql-proxy-$PROXY_VERSION"
  if [ ! -x "$proxy" ] || [ "$(sha256sum "$proxy" | cut -d' ' -f1)" != "$PROXY_SHA256" ]; then
    rm -f "$proxy"
    curl -sSfo "$proxy.download" "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/$PROXY_VERSION/cloud-sql-proxy.linux.amd64"
    if [ "$(sha256sum "$proxy.download" | cut -d' ' -f1)" != "$PROXY_SHA256" ]; then
      rm -f "$proxy.download"
      echo "The Cloud SQL Auth Proxy download does not match its published checksum. Stopping." >&2
      return 1
    fi
    mv "$proxy.download" "$proxy"; chmod +x "$proxy"
  fi
  echo "$proxy"
}

signed_in() {
  if ! gcloud auth print-access-token >/dev/null 2>&1; then
    echo "Not signed in. Run: gcloud auth login   then: gcloud config set project $PROJECT   then run this again."
    exit 1
  fi
  # A new Cloud Shell session can forget the project, so set it every time.
  gcloud config set project "$PROJECT" >/dev/null 2>&1
}

load_service() {
  SVC_JSON="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
  SVC_URL="$(echo "$SVC_JSON" | jq -r '.status.url')"
}
envval() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .value // empty'; }
secretof() { echo "$SVC_JSON" | jq -r --arg k "$1" '.spec.template.spec.containers[0].env[]? | select(.name==$k) | .valueFrom.secretKeyRef.name // empty'; }
secret_exists() { gcloud secrets describe "$1" >/dev/null 2>&1; }
secret_read() { gcloud secrets versions access latest --secret="$1"; }
# Who may read a secret. Each prints only when it changes something, so a second run shows it had nothing to do.
can_read() { # secret account
  gcloud secrets get-iam-policy "$1" --format=json | jq -e --arg m "serviceAccount:$2" \
    '[.bindings[]? | select(.role == "roles/secretmanager.secretAccessor") | .members[]?] | any(. == $m)' >/dev/null
}
let_read() { # secret account
  if can_read "$1" "$2"; then return 0; fi
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$2" --role roles/secretmanager.secretAccessor --quiet >/dev/null
  echo "  $2 may now read $1"
}
stop_read() { # secret account
  if ! can_read "$1" "$2"; then return 0; fi
  gcloud secrets remove-iam-policy-binding "$1" --member "serviceAccount:$2" --role roles/secretmanager.secretAccessor --quiet >/dev/null
  echo "  $2 may no longer read $1"
}
# Where to check the live service: its run.app address, or PUBLIC_URL once ingress only allows the load balancer.
check_url() {
  local ingress; ingress="$(echo "$SVC_JSON" | jq -r '.metadata.annotations["run.googleapis.com/ingress"] // "all"')"
  if [ "$ingress" != "all" ] && [ -n "$(envval PUBLIC_URL)" ]; then echo "$(envval PUBLIC_URL)"; else echo "$SVC_URL"; fi
}

# Opens the database for this shell: exports DB_HOST, DB_PORT, DB_SSL (and DB_CA), DB_USER, DB_PASSWORD, DB_NAME.
# With AS=migrator it uses the migration login (summitops-db-migrator) when harden.sh has made one, for the live service
# only: staging migrates with its own login, which can reach the staging database and nothing else.
PROXY_PID=""
open_db() {
  export DB_NAME="$(envval DB_NAME)" NODE_ENV=production
  if [ "${AS:-}" = migrator ] && [ "$SERVICE" = "$PROD_SERVICE" ] && secret_exists summitops-db-migrator; then
    local m; m="$(secret_read summitops-db-migrator)"
    export DB_USER="$(echo "$m" | jq -r .user)" DB_PASSWORD="$(echo "$m" | jq -r .password)"
  else
    export DB_USER="$(envval DB_USER)"
    export DB_PASSWORD="$(secret_read "$(secretof DB_PASSWORD)")"
  fi
  export JWT_SECRET="$(secret_read "$(secretof JWT_SECRET)")"
  local socket; socket="$(envval DB_SOCKET)"
  if [ -n "$socket" ]; then
    # Cloud SQL: reach it from Cloud Shell through the Cloud SQL Auth Proxy, on a local port.
    SQL_CONN="${socket#/cloudsql/}"
    local proxy; proxy="$(proxy_path)" || exit 1
    if [ -z "$PROXY_PID" ]; then
      "$proxy" --gcloud-auth --port 3307 "$SQL_CONN" >/tmp/cloud-sql-proxy.log 2>&1 &
      PROXY_PID=$!
      trap '[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true' EXIT
      for _ in $(seq 1 20); do (echo > /dev/tcp/127.0.0.1/3307) 2>/dev/null && break; sleep 1; done
    fi
    export DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=false
  else
    SQL_CONN=""
    export DB_HOST="$(envval DB_HOST)" DB_PORT="$(envval DB_PORT)" DB_SSL=true
    export DB_CA="$(secret_read "$(secretof DB_CA)")"
  fi
}

# Makes a Cloud SQL login, or sets its password, with the password read from stdin (2026.11.11). It goes to the Cloud SQL
# Admin API in the request body, never on a command line, where other programs and the shell history could see it.
#   printf %s "$PW" | sql_user_set <instance> <user>
sql_user_set() {
  local inst="$1" user="$2" pw hdr api
  pw="$(cat)"
  [ ${#pw} -ge 16 ] || { echo "sql_user_set: the password for $user is missing or too short."; return 1; }
  api="https://sqladmin.googleapis.com/v1/projects/$PROJECT/instances/$inst/users"
  hdr="$(mktemp)"; chmod 600 "$hdr"
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$(gcloud auth print-access-token)" > "$hdr"
  if gcloud sql users list --instance="$inst" --format='value(name)' | grep -qx "$user"; then
    SQLPW="$pw" jq -n --arg n "$user" '{name:$n,host:"%",password:env.SQLPW}' | curl -sSf -X PUT -H @"$hdr" --data-binary @- "$api?name=$user&host=%25" >/dev/null
  else
    SQLPW="$pw" jq -n --arg n "$user" '{name:$n,host:"%",password:env.SQLPW}' | curl -sSf -X POST -H @"$hdr" --data-binary @- "$api" >/dev/null
  fi
  local rc=$?; rm -f "$hdr"; [ $rc -eq 0 ] || return $rc
  for _ in $(seq 1 30); do gcloud sql users list --instance="$inst" --format='value(name)' | grep -qx "$user" && return 0; sleep 2; done
  echo "sql_user_set: $user did not appear on $inst."; return 1
}

# The build account: push the built image to Artifact Registry, write build logs, read the uploaded source. Nothing else:
# no secrets, no database, no other bucket. Safe to run again; it prints only what it changes.
ensure_build_sa() {
  if ! gcloud iam service-accounts describe "$BUILD_SA" >/dev/null 2>&1; then
    gcloud iam service-accounts create summitops-build --display-name "Verdynt/OS builds (Cloud Build)" --quiet >/dev/null
    echo "  Made $BUILD_SA for builds."
    sleep 5
  fi
  local role policy
  policy="$(gcloud projects get-iam-policy "$PROJECT" --format=json)"
  for role in roles/artifactregistry.writer roles/logging.logWriter; do
    if ! echo "$policy" | jq -e --arg r "$role" --arg m "serviceAccount:$BUILD_SA" '[.bindings[]? | select(.role == $r and .condition == null) | .members[]?] | any(. == $m)' >/dev/null; then
      gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$BUILD_SA" --role "$role" --condition=None --quiet >/dev/null
      echo "  $BUILD_SA now has $role"
    fi
  done
  # The source upload buckets only (not the project's other buckets, and never the backup bucket).
  local b
  for b in "gs://run-sources-${PROJECT}-${REGION}" "gs://${PROJECT}_cloudbuild"; do
    gcloud storage buckets describe "$b" >/dev/null 2>&1 || continue
    gcloud storage buckets add-iam-policy-binding "$b" --member "serviceAccount:$BUILD_SA" --role roles/storage.objectViewer --quiet >/dev/null
  done
}
BUILD_FLAG=(--build-service-account "projects/${PROJECT}/serviceAccounts/${BUILD_SA}")

# Scheduled jobs sign in with a Google ID token for this account (2026.11.11, scripts/jobs-oidc.sh), so no key sits in
# Cloud Scheduler. The account has no roles: it exists only to be named in the token, which the app checks
# (src/lib/jobauth.js). Needs the live service loaded (load_service). Sets JOB_AUTH for gcloud scheduler jobs.
JOBS_SA="summitops-jobs@${PROJECT}.iam.gserviceaccount.com"
ensure_jobs_oidc() {
  # Only a live site on 2026.11.11 or later checks these tokens; an older one would turn every job away.
  local live; live="$(curl -s --max-time 15 "$(check_url)/version" | jq -r '.version // empty' 2>/dev/null || true)"
  if ! node -e "const p=(v)=>String(v).split('.').map(Number);const [a,b]=[p(process.argv[1]),[2026,11,11]];process.exit(a[0]*1e6+a[1]*1e3+a[2]>=b[0]*1e6+b[1]*1e3+b[2]?0:1)" "${live:-0.0.0}"; then
    echo "The live site runs ${live:-an unknown version}. Signed job calls need 2026.11.11 or later: run bash promote.sh first."; exit 1
  fi
  if ! gcloud iam service-accounts describe "$JOBS_SA" >/dev/null 2>&1; then
    gcloud iam service-accounts create summitops-jobs --display-name "Verdynt/OS scheduled jobs (signs the job calls)" --quiet >/dev/null
    echo "  Made $JOBS_SA for the scheduled jobs."
    sleep 5
  fi
  local aud="$SVC_URL"
  [ -n "$(envval PUBLIC_URL)" ] && aud="$aud,$(envval PUBLIC_URL)"
  if [ "$(envval JOBS_OIDC_EMAIL)" != "$JOBS_SA" ] || [ "$(envval JOBS_OIDC_AUDIENCES)" != "$aud" ]; then
    gcloud run services update "$SERVICE" --region "$REGION" --quiet --update-env-vars "^|^JOBS_OIDC_EMAIL=$JOBS_SA|JOBS_OIDC_AUDIENCES=$aud" >/dev/null
    echo "  $SERVICE now accepts job calls signed for $JOBS_SA ($aud)."
    load_service
  fi
  JOB_AUTH=(--oidc-service-account-email "$JOBS_SA" --oidc-token-audience "$SVC_URL")
}

# Cloud Scheduler jobs are changed through the Cloud Scheduler API (2026.11.12). `gcloud scheduler jobs update http`
# crashes in current gcloud (TypeError on NoneType), and deleting a job to make it again leaves no job at all if the new
# one cannot be made. A PATCH changes the job in place: it is there the whole time, and a change that fails leaves it as
# it was. The access token goes in a header file only this account can read (chmod 600), never on a command line, and
# the file is removed after. Used by jobs-oidc.sh, guests-job.sh, lessons-job.sh, outreach-setup.sh, cloud-armor.sh and
# backups-setup.sh. With DRY set (a --dry-run), it prints what it would send and changes nothing.
#   printf '%s' "$fields_json" | sched_patch <job> <updateMask>
sched_patch() {
  local j="$1" mask="$2" hdr out rc=0
  local url="https://cloudscheduler.googleapis.com/v1/projects/$PROJECT/locations/$REGION/jobs/$j?updateMask=$mask"
  if [ -n "${DRY:-}" ]; then printf '  would run: PATCH %s with %s\n' "$url" "$(cat)"; return 0; fi
  hdr="$(mktemp)"; chmod 600 "$hdr"; out="$(mktemp)"
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$(gcloud auth print-access-token)" > "$hdr"
  curl -sS --fail-with-body -X PATCH -H @"$hdr" --data-binary @- -o "$out" "$url" || rc=$?
  rm -f "$hdr"
  if [ "$rc" -ne 0 ]; then
    echo "  Could not change $j through the Cloud Scheduler API (curl exit $rc). The job is as it was."
    if [ -s "$out" ]; then { jq -r '.error.message // empty' "$out" 2>/dev/null || cat "$out"; } | sed 's/^/    /'; fi
  fi
  rm -f "$out"
  return "$rc"
}
sched_exists() { gcloud scheduler jobs describe "$1" --location "$REGION" >/dev/null 2>&1; }
# The job's http target, cleaned for sending back: no User-Agent header (Google sets that one) and, unless asked to keep
# it, no old x-jobs-key header.   sched_target <job> [keep-key]
sched_target() {
  gcloud scheduler jobs describe "$1" --location "$REGION" --format=json | jq -c --arg keep "${2:-}" '.httpTarget
    | .headers = ((.headers // {}) | with_entries(select((.key | ascii_downcase) as $k | $k != "user-agent" and ($keep != "" or $k != "x-jobs-key"))))'
}

# A scheduled job that calls the app, signed with a Google ID token for summitops-jobs (no key stored in the job). Made
# when it is not there; otherwise its schedule, address, time limit and signing are set in place (sched_patch). Needs
# ensure_jobs_oidc first (JOBS_SA, JOB_AUTH) and the live service loaded.
#   app_job <job> <cron schedule> <path, such as /api/v1/internal/jobs/guests> <time limit, such as 120s>
app_job() {
  local j="$1" sched="$2" path="$3" deadline="$4" uri
  uri="$(check_url)$path"
  if sched_exists "$j"; then
    sched_target "$j" | jq -c --arg s "$sched" --arg tz America/New_York --arg d "$deadline" --arg uri "$uri" --arg sa "$JOBS_SA" --arg aud "$SVC_URL" \
      '{schedule: $s, timeZone: $tz, attemptDeadline: $d, httpTarget: (. | .uri = $uri | .httpMethod = "POST" | del(.oauthToken) | .oidcToken = {serviceAccountEmail: $sa, audience: $aud})}' \
      | sched_patch "$j" schedule,timeZone,attemptDeadline,httpTarget
    echo "  $j updated: $sched (America/New_York), $uri"
  else
    gcloud scheduler jobs create http "$j" --location "$REGION" --schedule "$sched" --time-zone America/New_York --uri "$uri" --http-method POST "${JOB_AUTH[@]}" --attempt-deadline="$deadline" --quiet
    echo "  $j made: $sched (America/New_York), $uri"
  fi
}

# Deletes older revisions of $SERVICE that still hold a key in a plain setting (2026.11.11). The revision serving now and
# the newest one are never touched. Used by harden.sh (step 8) and rotate-secrets.sh.
PLAIN_KEYS=(STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_CONNECT_WEBHOOK_SECRET POSTMARK_SERVER_TOKEN TWILIO_AUTH_TOKEN JOBS_KEY BOOTSTRAP_KEY TOTP_KEY LINK_SECRET KIOSK_SECRET PLATFORM_TOTP_SECRET PLATFORM_KEY ANTHROPIC_API_KEY ASSISTANT_API_KEY DB_PASSWORD JWT_SECRET OUTREACH_GMAIL_KEY)
clean_plain_revisions() {
  local names serving rev n=0
  names="$(printf '%s\n' "${PLAIN_KEYS[@]}" | jq -R . | jq -s .)"
  serving="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json | jq -r '[.status.traffic[]? | select((.percent // 0) > 0) | .revisionName] + [.status.latestReadyRevisionName] | .[]')"
  while read -r rev; do
    [ -n "$rev" ] || continue
    if echo "$serving" | grep -qx "$rev"; then echo "  $rev holds a plain key but is serving now: move its keys (harden.sh) and run this again."; continue; fi
    gcloud run revisions delete "$rev" --region "$REGION" --quiet >/dev/null && echo "  Deleted $rev (it held a key in a plain setting)" && n=$((n + 1))
  done < <(gcloud run revisions list --service "$SERVICE" --region "$REGION" --format=json \
    | jq -r --argjson names "$names" '.[] | select([.spec.containers[0].env[]? | select(.value != null and .value != "" and (.name as $n | $names | index($n)))] | length > 0) | .metadata.name')
  echo "  $n older revision(s) with plain keys deleted."
}
