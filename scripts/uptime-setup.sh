#!/usr/bin/env bash
# Uptime checks that text you (2026.11.10, READY). Run once from the unzipped folder in Cloud Shell:
#   bash scripts/uptime-setup.sh +16105550123 you@example.com
# The phone number is in international form (+1 and ten digits in the US). Safe to run again: it keeps what exists,
# makes what is missing, and points the alerts at the phone and email given this time.
#
# What it makes in Cloud Monitoring:
#   - two ways to reach you: a text to the phone (Google texts a code first: type it in when asked) and an email
#   - an uptime check on the live app's /readyz, every minute, from three US regions. It passes only when the app
#     answers and the database is reachable and migrated ("ok":true).
#   - an uptime check on the website's /status page (when SITE_HOSTS is set on the live service), every 5 minutes
#   - an alert for each: when at least two regions fail for a minute, you get a text and an email; another when it
#     is back. Nothing is sent while staging is down: staging is not checked.
# --dry-run prints the gcloud commands that would change something, and changes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/cloud-common.sh

DRY=""; ARGS=()
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) ARGS+=("$a") ;; esac; done
PHONE="${ARGS[0]:-}"; EMAIL="${ARGS[1]:-}"
if ! [[ "$PHONE" =~ ^\+[1-9][0-9]{7,14}$ ]] || ! [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "Usage: bash scripts/uptime-setup.sh +16105550123 you@example.com"
  echo "The phone number starts with + and the country code (+1 in the US), with no spaces."
  exit 1
fi
# Changes go through run(); reads do not. With --dry-run, run() only prints.
run() { if [ -n "$DRY" ]; then printf '  would run: %s\n' "$*" >&2; else "$@"; fi; }
ALPHA=(gcloud alpha monitoring)

step "Checking you are signed in to Google Cloud"
signed_in
run gcloud services enable monitoring.googleapis.com --quiet
gcloud components list --filter='id=alpha' --format='value(state.name)' 2>/dev/null | grep -q Installed || echo "  (gcloud alpha commands are needed; Cloud Shell has them. Elsewhere: gcloud components install alpha)"

step "Finding the live app and the website"
load_service
APP_HOST="$(check_url | sed -E 's#^https?://##; s#/.*$##')"
SITE_HOST="$(envval SITE_HOSTS | cut -d, -f1 | tr -d ' ')"
echo "Live app: https://$APP_HOST/readyz"
if [ -n "$SITE_HOST" ]; then echo "Website: https://$SITE_HOST/status"; else echo "Website: SITE_HOSTS is not set on the live service, so the website is not checked yet."; fi

# ---------------------------------------------------------------- where alerts go
channel() { # display-name type label=value
  local name="$1" type="$2" label="$3" id
  id="$("${ALPHA[@]}" channels list --filter="displayName=\"$name\"" --format='value(name)' 2>/dev/null | head -1)"
  if [ -n "$id" ]; then
    run "${ALPHA[@]}" channels update "$id" --update-channel-labels="$label" --quiet >/dev/null
    echo "  kept: $name" >&2
  else
    if [ -n "$DRY" ]; then run "${ALPHA[@]}" channels create --display-name="$name" --type="$type" --channel-labels="$label"; id="projects/$PROJECT/notificationChannels/NEW-$type"
    else id="$("${ALPHA[@]}" channels create --display-name="$name" --type="$type" --channel-labels="$label" --format='value(name)')"; echo "  made: $name" >&2; fi
  fi
  echo "$id"
}
step "Where alerts go"
SMS_CH="$(channel 'Verdynt/OS: text Dan' sms "number=$PHONE")"
MAIL_CH="$(channel 'Verdynt/OS: email Dan' email "email_address=$EMAIL")"
# A text channel only works once its number is confirmed with a code Google texts to it.
if [ -z "$DRY" ]; then
  STATE="$("${ALPHA[@]}" channels describe "$SMS_CH" --format='value(verificationStatus)' 2>/dev/null || true)"
  if [ "$STATE" != "VERIFIED" ]; then
    "${ALPHA[@]}" channels send-verification-code "$SMS_CH"
    read -r -p "Google just texted a code to $PHONE. Type it here (G-123456 or 123456): " CODE
    CODE="${CODE#G-}"
    "${ALPHA[@]}" channels verify "$SMS_CH" --verification-code="G-$CODE" || "${ALPHA[@]}" channels verify "$SMS_CH" --verification-code="$CODE"
    echo "  The phone is confirmed."
  else
    echo "  The phone was already confirmed."
  fi
fi

# ---------------------------------------------------------------- the checks
uptime_check() { # display-name host path period-minutes content
  local name="$1" host="$2" path="$3" period="$4" content="$5" id
  id="$(gcloud monitoring uptime list-configs --filter="displayName=\"$name\"" --format='value(name)' 2>/dev/null | head -1)"
  if [ -z "$id" ]; then
    if [ -n "$DRY" ]; then
      run gcloud monitoring uptime create "$name" --resource-type=uptime-url --resource-labels="host=$host,project_id=$PROJECT" --protocol=https --path="$path" --period="$period" --timeout=10 --matcher-type=contains-string --matcher-content="$content" --regions=usa-iowa,usa-oregon,usa-virginia
      id="projects/$PROJECT/uptimeCheckConfigs/NEW"
    else
      id="$(gcloud monitoring uptime create "$name" --resource-type=uptime-url --resource-labels="host=$host,project_id=$PROJECT" --protocol=https --path="$path" --period="$period" --timeout=10 --matcher-type=contains-string --matcher-content="$content" --regions=usa-iowa,usa-oregon,usa-virginia --format='value(name)')"
      echo "  made: $name" >&2
    fi
  else
    echo "  kept: $name (to change it, delete it in Monitoring, Uptime checks, and run this again)" >&2
  fi
  echo "${id##*/}"
}
alert_for() { # display-name check-id what
  local name="$1" check="$2" what="$3" file existing
  file="$(mktemp)"
  cat > "$file" <<JSON
{
  "displayName": "$name",
  "combiner": "OR",
  "conditions": [{
    "displayName": "$what is not answering",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$check\" AND resource.type=\"uptime_url\"",
      "aggregations": [{ "alignmentPeriod": "1200s", "perSeriesAligner": "ALIGN_NEXT_OLDER", "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.*"] }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 1,
      "duration": "60s",
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$SMS_CH", "$MAIL_CH"],
  "alertStrategy": { "autoClose": "1800s" },
  "documentation": { "mimeType": "text/markdown", "content": "Verdynt/OS: $what is down. Check https://$APP_HOST/readyz, then RECOVERY.md (in the release folder) and the console's Status page to tell mountains." }
}
JSON
  existing="$("${ALPHA[@]}" policies list --filter="displayName=\"$name\"" --format='value(name)' 2>/dev/null | head -1)"
  if [ -n "$existing" ]; then
    run "${ALPHA[@]}" policies update "$existing" --policy-from-file="$file" --quiet >/dev/null
    echo "  kept and updated: $name"
  else
    run "${ALPHA[@]}" policies create --policy-from-file="$file" >/dev/null
    [ -z "$DRY" ] && echo "  made: $name"
  fi
  rm -f "$file"
}

step "The live app"
APP_CHECK="$(uptime_check 'Verdynt/OS live /readyz' "$APP_HOST" /readyz 1 '"ok":true')"
alert_for 'Verdynt/OS live is down' "$APP_CHECK" 'The live app'

if [ -n "$SITE_HOST" ]; then
  step "The website"
  SITE_CHECK="$(uptime_check 'Verdynt/OS website /status' "$SITE_HOST" /status 5 'Is Verdynt/OS working?')"
  alert_for 'Verdynt/OS website is down' "$SITE_CHECK" 'The website'
fi

echo ""
if [ -n "$DRY" ]; then echo "Dry run: nothing was changed."; else
  echo "Done. When the live app stops answering for a minute, $PHONE gets a text and $EMAIL an email, and again when it is back."
  echo "See them in the Cloud console: Monitoring, Uptime checks. To try the text now: Monitoring, Alerting, Edit notification channels, 'Verdynt/OS: text Dan', Send test notification."
fi
