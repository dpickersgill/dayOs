#!/usr/bin/env bash
# Sourced by deploy.sh and promote.sh after load_service (2026.11.11). From this release the server refuses to start in
# production without PUBLIC_URL, with DB_USER unset or root, with a database reached over the network without DB_SSL, or
# with a weak JWT_SECRET or platform key (src/config.js refuseUnsafe). This checks the plain settings first, so a deploy
# stops here with the fix to make, instead of a new revision that will not start:
#   - PUBLIC_URL missing: set to the service's own https address (the run.app address, or the load balancer's address
#     once scripts/cloud-armor.sh has run; it sets PUBLIC_URL itself).
#   - DB_USER missing or root: stop. Run scripts/harden.sh, which makes the app's own login (summitops_app).
#   - DB_HOST over the network without DB_SSL=true and no DB_SOCKET: stop.
# JWT_SECRET and BOOTSTRAP_KEY are in Secret Manager: if either is too weak, the new revision does not start and Cloud Run
# keeps the old one serving; a new, long random version of that secret fixes it.
settings_check() {
  local pub user host sock ssl
  pub="$(envval PUBLIC_URL)"; user="$(envval DB_USER)"; host="$(envval DB_HOST)"; sock="$(envval DB_SOCKET)"; ssl="$(envval DB_SSL)"
  if [ -z "$pub" ]; then
    echo "PUBLIC_URL is not set on $SERVICE. Setting it to $SVC_URL (links in emails use it)."
    gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=$SVC_URL" --quiet >/dev/null
    load_service
  fi
  if [ -z "$user" ] || [ "$user" = root ]; then
    echo "Stopped: $SERVICE signs in to the database as ${user:-root}. Run bash scripts/harden.sh first (it makes the app's own login), then run this again."
    exit 1
  fi
  if [ -z "$sock" ] && [ -n "$host" ] && [ "$host" != 127.0.0.1 ] && [ "$host" != localhost ] && [ "$ssl" != true ]; then
    echo "Stopped: $SERVICE reaches its database at $host without TLS. Set DB_SSL=true (and DB_CA), or use Cloud SQL's DB_SOCKET."
    exit 1
  fi
}
