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

step() { printf '\n== %s\n' "$1"; }

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
    local proxy="$HOME/cloud-sql-proxy"
    if [ ! -x "$proxy" ]; then
      curl -sSfo "$proxy" https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.26.0/cloud-sql-proxy.linux.amd64
      chmod +x "$proxy"
    fi
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
