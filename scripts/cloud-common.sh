#!/usr/bin/env bash
# Shared by deploy.sh, promote.sh, scripts/staging-setup.sh, scripts/harden.sh and scripts/cloud-armor.sh: signs in, reads
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
