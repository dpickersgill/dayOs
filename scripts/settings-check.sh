#!/usr/bin/env bash
# Sourced by deploy.sh and promote.sh after load_service (2026.11.11). From this release the server refuses to start in
# production without PUBLIC_URL, with DB_USER unset or root, with a database reached over the network without DB_SSL, or
# with a weak JWT_SECRET or platform key (src/config.js refuseUnsafe). This checks the plain settings first, so a deploy
# stops here with the fix to make, instead of a new revision that will not start:
#   - PUBLIC_URL missing: set to the service's own https address so the revision starts. PUBLIC_URL should be the
#     address people use, for example https://app.yourdomain.com (scripts/cloud-armor.sh sets the load balancer's
#     address itself). Links in emails use it, and passkeys work only on PUBLIC_URL and on the addresses listed in
#     WEBAUTHN_ORIGINS (src/lib/passkeys.js): any other address staff use must be listed there.
#   - PUBLIC_URL a run.app address while WEBAUTHN_RP_ID is your own domain: a warning. Passkeys belong to that domain but
#     would be accepted only on the run.app address, so nobody on app.yourdomain.com could use one.
#   - DB_USER missing or root: stop. Run scripts/harden.sh, which makes the app's own login (summitops_app).
#   - DB_HOST over the network without DB_SSL=true and no DB_SOCKET: stop.
# JWT_SECRET and BOOTSTRAP_KEY are in Secret Manager: if either is too weak, the new revision does not start and Cloud Run
# keeps the old one serving; a new, long random version of that secret fixes it.
settings_check() {
  local pub user host sock ssl
  pub="$(envval PUBLIC_URL)"; user="$(envval DB_USER)"; host="$(envval DB_HOST)"; sock="$(envval DB_SOCKET)"; ssl="$(envval DB_SSL)"
  if [ -z "$pub" ]; then
    echo "PUBLIC_URL is not set on $SERVICE. Setting it to $SVC_URL for now (links in emails and passkeys use it)."
    echo "PUBLIC_URL should be the address people use, for example https://app.yourdomain.com. List any other address staff use in WEBAUTHN_ORIGINS."
    gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=$SVC_URL" --quiet >/dev/null
    load_service
    pub="$(envval PUBLIC_URL)"
  fi
  passkey_origin_warning "$pub" "$(envval WEBAUTHN_RP_ID)"
  if [ -z "$user" ] || [ "$user" = root ]; then
    echo "Stopped: $SERVICE signs in to the database as ${user:-root}. Run bash scripts/harden.sh first (it makes the app's own login), then run this again."
    exit 1
  fi
  if [ -z "$sock" ] && [ -n "$host" ] && [ "$host" != 127.0.0.1 ] && [ "$host" != localhost ] && [ "$ssl" != true ]; then
    echo "Stopped: $SERVICE reaches its database at $host without TLS. Set DB_SSL=true (and DB_CA), or use Cloud SQL's DB_SOCKET."
    exit 1
  fi
}

# Warns (never stops) when PUBLIC_URL is a run.app address but passkeys belong to your own domain. Arguments: PUBLIC_URL,
# WEBAUTHN_RP_ID. Prints nothing when the two agree.
passkey_origin_warning() {
  local pub="$1" rpid="$2" phost
  phost="${pub#*://}"; phost="${phost%%/*}"; phost="${phost%%:*}"
  [ -n "$rpid" ] || return 0
  case "$phost" in *.run.app) ;; *) return 0 ;; esac
  case "$rpid" in *run.app) return 0 ;; esac
  echo "Warning: PUBLIC_URL is $pub, a run.app address, but WEBAUTHN_RP_ID is $rpid."
  echo "  Passkeys are accepted only on PUBLIC_URL and the addresses in WEBAUTHN_ORIGINS, so nobody can use one on $rpid."
  echo "  Set PUBLIC_URL to the address people use (for example https://app.$rpid), and list the run.app address in WEBAUTHN_ORIGINS if staff still use it."
}
