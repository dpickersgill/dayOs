#!/usr/bin/env bash
# A web firewall (Google Cloud Armor) in front of Verdynt/OS, run from the unzipped folder in Cloud Shell [review M3].
# It costs extra (a load balancer, roughly $20 a month plus traffic). Two stages, because the domain has to move first:
#
#   bash scripts/cloud-armor.sh www.example.com app.example.com
#       Builds the load balancer with Cloud Armor and prints the address to point your domains at. Nothing changes for
#       visitors until you change DNS. The attack rules start in preview (logged, not blocking) so you can check them.
#   bash scripts/cloud-armor.sh --lock www.example.com app.example.com
#       Once the certificate shows ACTIVE: only the load balancer can reach the app, the daily job is sent through it,
#       and the attack rules start blocking. The run.app address stops answering.
#   bash scripts/cloud-armor.sh --unlock
#       Opens the run.app address again (if something goes wrong). The firewall stays in front of the domains.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh
MODE=build; DOMAINS=()
for a in "$@"; do
  case "$a" in
    --lock) MODE=lock ;;
    --unlock) MODE=unlock ;;
    -*) echo "Unknown option $a"; exit 1 ;;
    *) DOMAINS+=("$a") ;;
  esac
done
signed_in
load_service
P=summitops
WAF_RULES=(sqli-v33-stable xss-v33-stable lfi-v33-stable rfi-v33-stable rce-v33-stable scannerdetection-v33-stable protocolattack-v33-stable)

if [ "$MODE" = unlock ]; then
  gcloud run services update "$SERVICE" --region "$REGION" --ingress all --update-env-vars TRUST_PROXY_HOPS=1 --quiet
  echo "The run.app address answers again."
  exit 0
fi
[ ${#DOMAINS[@]} -gt 0 ] || { echo "Name the domains, for example: bash scripts/cloud-armor.sh www.example.com app.example.com"; exit 1; }

if [ "$MODE" = build ]; then
  gcloud services enable compute.googleapis.com --quiet

  step "Cloud Armor policy"
  if ! gcloud compute security-policies describe "$P-armor" >/dev/null 2>&1; then
    gcloud compute security-policies create "$P-armor" --description "Verdynt/OS web firewall"
  fi
  gcloud compute security-policies update "$P-armor" --enable-layer7-ddos-defense --log-level=VERBOSE --quiet
  # Rule 100: one address sending more than 600 requests a minute gets "too many requests" for that minute.
  gcloud compute security-policies rules delete 100 --security-policy "$P-armor" --quiet >/dev/null 2>&1 || true
  gcloud compute security-policies rules create 100 --security-policy "$P-armor" --src-ip-ranges='*' \
    --action=throttle --rate-limit-threshold-count=600 --rate-limit-threshold-interval-sec=60 \
    --conform-action=allow --exceed-action=deny-429 --enforce-on-key=IP --description "Per-address rate limit"
  # Rules 1000+: the standard attack signatures (SQL injection, scripting, file access, scanners), logged only for now.
  n=1000
  for r in "${WAF_RULES[@]}"; do
    gcloud compute security-policies rules delete "$n" --security-policy "$P-armor" --quiet >/dev/null 2>&1 || true
    gcloud compute security-policies rules create "$n" --security-policy "$P-armor" \
      --expression "evaluatePreconfiguredWaf('$r', {'sensitivity': 1})" --action=deny-403 --preview --description "$r"
    n=$((n + 10))
  done

  step "Load balancer"
  gcloud compute network-endpoint-groups describe "$P-neg" --region "$REGION" >/dev/null 2>&1 || \
    gcloud compute network-endpoint-groups create "$P-neg" --region "$REGION" --network-endpoint-type=serverless --cloud-run-service="$SERVICE"
  if ! gcloud compute backend-services describe "$P-backend" --global >/dev/null 2>&1; then
    gcloud compute backend-services create "$P-backend" --global --load-balancing-scheme=EXTERNAL_MANAGED
    gcloud compute backend-services add-backend "$P-backend" --global --network-endpoint-group="$P-neg" --network-endpoint-group-region="$REGION"
  fi
  gcloud compute backend-services update "$P-backend" --global --security-policy "$P-armor" --enable-logging --logging-sample-rate=1
  gcloud compute url-maps describe "$P-lb" >/dev/null 2>&1 || gcloud compute url-maps create "$P-lb" --default-service "$P-backend"
  CERT="$P-cert-$(printf '%s' "${DOMAINS[*]}" | md5sum | cut -c1-8)"
  gcloud compute ssl-certificates describe "$CERT" --global >/dev/null 2>&1 || \
    gcloud compute ssl-certificates create "$CERT" --global --domains "$(IFS=,; echo "${DOMAINS[*]}")"
  if gcloud compute target-https-proxies describe "$P-https" >/dev/null 2>&1; then
    gcloud compute target-https-proxies update "$P-https" --ssl-certificates "$CERT" --global-ssl-certificates
  else
    gcloud compute target-https-proxies create "$P-https" --url-map "$P-lb" --ssl-certificates "$CERT"
  fi
  gcloud compute addresses describe "$P-ip" --global >/dev/null 2>&1 || gcloud compute addresses create "$P-ip" --global --ip-version IPV4
  IP="$(gcloud compute addresses describe "$P-ip" --global --format='value(address)')"
  gcloud compute forwarding-rules describe "$P-https-rule" --global >/dev/null 2>&1 || \
    gcloud compute forwarding-rules create "$P-https-rule" --global --load-balancing-scheme=EXTERNAL_MANAGED --address "$P-ip" --target-https-proxy "$P-https" --ports 443
  # Plain http on port 80 is sent to https.
  if ! gcloud compute url-maps describe "$P-redirect" >/dev/null 2>&1; then
    printf 'name: %s-redirect\ndefaultUrlRedirect:\n  httpsRedirect: true\n  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT\n' "$P" > /tmp/redirect.yaml
    gcloud compute url-maps import "$P-redirect" --global --source /tmp/redirect.yaml --quiet
    gcloud compute target-http-proxies create "$P-http" --url-map "$P-redirect"
    gcloud compute forwarding-rules create "$P-http-rule" --global --load-balancing-scheme=EXTERNAL_MANAGED --address "$P-ip" --target-http-proxy "$P-http" --ports 80
  fi

  printf '\nBuilt. Now point each domain at %s with an A record at your domain registrar:\n' "$IP"
  for d in "${DOMAINS[@]}"; do echo "  $d  A  $IP"; done
  echo "The certificate turns ACTIVE 15 to 60 minutes after DNS points here. Check with:"
  echo "  gcloud compute ssl-certificates describe $CERT --global --format='value(managed.status)'"
  echo "Then run:  bash scripts/cloud-armor.sh --lock ${DOMAINS[*]}"
  exit 0
fi

# --lock
CERT="$P-cert-$(printf '%s' "${DOMAINS[*]}" | md5sum | cut -c1-8)"
STATUS="$(gcloud compute ssl-certificates describe "$CERT" --global --format='value(managed.status)' 2>/dev/null || true)"
[ "$STATUS" = ACTIVE ] || { echo "The certificate is $STATUS, not ACTIVE yet. Check DNS points at the load balancer and try again later."; exit 1; }
APP_DOMAIN="${DOMAINS[${#DOMAINS[@]}-1]}"
curl -sf --max-time 15 "https://$APP_DOMAIN/healthz" >/dev/null || { echo "https://$APP_DOMAIN does not answer through the load balancer yet."; exit 1; }

step "Attack rules now block"
n=1000
for r in "${WAF_RULES[@]}"; do
  gcloud compute security-policies rules update "$n" --security-policy "$P-armor" --no-preview >/dev/null
  n=$((n + 10))
done

step "Only the load balancer reaches the app"
PUBLIC="$(envval PUBLIC_URL)"; [ -n "$PUBLIC" ] || PUBLIC="https://$APP_DOMAIN"
gcloud run services update "$SERVICE" --region "$REGION" --ingress internal-and-cloud-load-balancing \
  --update-env-vars "TRUST_PROXY_HOPS=2,PUBLIC_URL=$PUBLIC" --quiet
if gcloud scheduler jobs describe summitops-daily --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http summitops-daily --location "$REGION" --uri "$PUBLIC/api/v1/internal/jobs/daily" --quiet
  echo "The daily job now goes through $PUBLIC."
fi
echo "Done. Visitors reach Verdynt/OS only through Cloud Armor at ${DOMAINS[*]}. If anything breaks: bash scripts/cloud-armor.sh --unlock"
