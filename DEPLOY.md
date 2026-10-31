# Deploying Verdynt/OS

Verdynt/OS runs on Google Cloud Run (service `summitops-api`, region `us-east1`) with a Cloud SQL MySQL 8.4 database (`summitops-db`, same region; reached through the Cloud SQL socket, `DB_SOCKET`). Until `move-to-cloudsql.sh` has been run it uses Aiven. Secrets live in Google Secret Manager. Every update is: upload the zip, install, migrate, deploy, check.

## First deploy

From Google Cloud Shell, in this folder:

```bash
gcloud run deploy summitops-api --source . --region us-east1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,DB_SSL=true,DB_HOST=...,DB_PORT=...,DB_USER=...,DB_NAME=summitops \
  --set-secrets DB_PASSWORD=summitops-db-password:latest,JWT_SECRET=summitops-jwt:latest,BOOTSTRAP_KEY=summitops-bootstrap:latest,DB_CA=aiven-ca:latest
```

Run `npm run migrate` against the Aiven database (Cloud Shell works) before the first request, and again after every update: it only adds what is missing and never touches data. Health checks: `GET /healthz` (process) and `GET /readyz` (database).

## Updating (every new zip): staging first, then live

Every release goes to **staging** first, the private test copy of Verdynt/OS, and only goes live once it has been checked
there. The live site only ever gets the exact build (the same container image) that ran on staging.

**Once, before the first release that uses it:** `bash scripts/staging-setup.sh` (see Staging, below).

Every zip is named after its version, for example `summitops-2026.10.25.zip` (see Versions, below). Run these in Cloud Shell.

1. Unzip the newest zip into a clean folder:
   ```bash
   rm -rf ~/summitops-new && mkdir ~/summitops-new
   unzip -oq "$(ls -t ~/summitops-2*.zip | head -1)" -d ~/summitops-new
   cd ~/summitops-new
   ```
2. Check it is the version you expect:
   ```bash
   grep '"version"' package.json
   ```
3. Put it on staging. It refuses to put an older version over a newer one, checks the packages, installs, migrates the
   staging database (and stops if that fails), deploys, and checks staging answers as this exact build:
   ```bash
   bash deploy.sh
   ```
   It ends with `Staging is running <version> (build <build>): <address>`. If it stops earlier, nothing was deployed.
4. Check the release on staging (the release notes say what to try).
5. From the same folder, put that same build live. It stops unless staging runs this folder's release and build, asks
   you to type the version, migrates the live database, deploys the staging image, checks the live site, and prints the
   command that switches back:
   ```bash
   bash promote.sh
   ```
   It ends with `Done. <address> is running <version>, migrated.`

Releases go live on Sunday night. Urgent fixes still go through staging, just faster.

If it says you are not signed in, run `gcloud auth login`, then `gcloud config set project summitops-510715`, and run it again.

`/readyz` answers `{"ok":false,"reason":"run npm run migrate"}` when a version is running against a database that was not migrated for it.
`/version` answers with the version and build that is live, for example `{"version":"2026.10.4","build":"1a2b3c4"}`.

## Versions

Versions are calendar versions, YEAR.MONTH.N: `2026.10.4` is the fourth release of October 2026. The count starts
again at 1 each month. The build is the short git commit the zip was made from.

- The number is in `package.json` (and `package-lock.json`). Every zip that is deployed gets a new number.
- Each release has an entry at the top of `src/release/changelog.json`, in plain words for the people who use the app.
  Each note says its kind (`new`, `improved`, `fixed`), its app (or `null` for everyone) and who sees it (`null` for
  every role, a list of roles, or `"platform"` for the console only). Owners and managers see every note for the apps
  their mountain has. People see these in Help > What's new, and a small dot on Help tells them when there is
  something new for them.
- Making a zip: bump the version, add the change log entry, commit, then `node scripts/stamp-build.js` (writes
  `src/release/build.json` and refuses if the change log has no entry for this version), then zip.
- The app shows the version on the sign-in screen, in the account menu and at the foot of Help. The console's
  **Releases** shows the live version, every version that has started (with who deployed it) and the full change log.
- `deploy.sh` stops if staging is newer than this folder, and `promote.sh` stops if the live site is. To go back to an
  older version on purpose (better: use Rolling back, below, which needs no rebuild), run `bash deploy.sh --allow-older`
  and then `bash promote.sh --allow-older`.

## Rolling back

Every deploy is a new Cloud Run revision. To go back, list revisions and send all traffic to the previous one:

```bash
gcloud run revisions list --service summitops-api --region us-east1
gcloud run services update-traffic summitops-api --region us-east1 --to-revisions=<previous-revision>=100
```

Migrations only add tables and columns, so the previous revision keeps working after a rollback. `promote.sh` prints
the exact command for the revision it replaced. RECOVERY.md has the whole recovery plan: targets, backups, restoring the
database, who to tell, and the drill.

## Ready for the busiest morning (2026.11.10): once, when this release goes live

Run these from the unzipped 2026.11.10 folder in Cloud Shell, in this order. Each is safe to run again.

```bash
bash deploy.sh                                     # as always: staging first (creates rate_limits and status_notes there)
bash promote.sh                                    # live: migrates, then one server always running, at most 4
bash scripts/backups-setup.sh                      # checks backups and point-in-time recovery, adds the weekly copy
gcloud scheduler jobs run summitops-weekly-export --location us-east1   # the first weekly copy, now
bash scripts/uptime-setup.sh +1XXXXXXXXXX you@example.com              # your mobile number and email: texts when live is down
```

`uptime-setup.sh` asks for the code Google texts to your phone. `backups-setup.sh` asks before anything that restarts
the database (only if point-in-time recovery was off); say no during the day and run it again after closing.
Then, once: the load test on staging (Load test, below), and the restore drill (RECOVERY.md, The drill).

### Servers and database connections

`promote.sh` keeps **one live server always running** (`--min-instances=1`), so the first guest of the morning never
waits for a server to start (a cold start is several seconds), and lets Cloud Run add servers up to **4** when it is
busy. Staging stays at none when idle (`--min-instances=0`, at most 1 server).

The math: each server holds at most `DB_POOL` database connections (8 on live, 4 on staging), and a server serves up to
40 requests at once, which share those 8. At the busiest moment that is 4 x 8 = 32 live connections, plus staging
(at most 2 x 4 = 8, during a staging load test), plus 4 for a migration and the Cloud SQL proxy in Cloud Shell:
**44 connections**. Cloud SQL's smallest MySQL servers allow at least 250 (see yours with
`SHOW VARIABLES LIKE 'max_connections'` through the proxy), but each connection also uses memory on a small server, so
`promote.sh` refuses any setting above a budget of 60. To change it: `LIVE_MAX_SERVERS=6 LIVE_DB_POOL=6 bash promote.sh`
(6 x 6 + 12 = 48). Raise `DB_CONNECTION_BUDGET` only after moving the database to a bigger server
(`gcloud sql instances patch summitops-db --tier=db-custom-1-3840`). A server always running costs a little each month
even when nobody uses it (Cloud Run bills an idle server at a lower rate); see Cloud Run pricing.

### What changed so several servers agree

With more than one server, anything a server kept in its own memory would differ from server to server. This is
what was in memory, and what happened to it:

| In memory before | Now |
|---|---|
| Every rate limit (sign-in, codes, the console, every guest form, gates, the online shop, the assistant, the website) | Counted in the database, table `rate_limits` (`src/lib/ratestore.js`, behind express-rate-limit's store interface). 10 a minute is 10 a minute across all servers. A sign-in that works gives its count back, so a crew signing in at opening from one address is never turned away; wrong passwords still count. The daily job removes old counts. If the database does not answer within 1.5 seconds, a server falls back to its own count for that request and logs `rate_store`. |
| The console's "a code works once" (`PLATFORM_TOTP_SECRET`) | Each code is claimed in the same table, so it works once across servers. |
| Demo usage counts (added up for 30 seconds, then written) | Kept, but now also written when Cloud Run stops a server, so a quiet-time scale-down loses nothing. |
| Login lockouts, emailed codes and their tries, sessions, passkey challenges | Already in the database. Nothing to do. |
| Caches (plans, apps on, billing standing, website pages, the status checks) | Kept per server on purpose: each lasts 10 to 60 seconds. |
| How many demos build at once (3), one scanned document read at a time | Kept per server on purpose: they protect each server's own memory. |

### Load test

`scripts/loadtest.js` plays a holiday Saturday morning against one mountain: gates scanning, counters selling day
tickets for cash, and an online shop rush (`node scripts/loadtest.js --help`). It refuses the live site: it only runs
against this computer or an address whose `/version` says staging.

On staging, with its demo mountain (made at staging's `/try`), a counter login, and a pairing code from Gate, Devices,
Add a device. Every request comes from Cloud Shell's one address, so raise staging's per-address guest limits for the
test, and put them back after:

```bash
STG=$(gcloud run services describe summitops-staging --region us-east1 --format='value(status.url)')
gcloud run services update summitops-staging --region us-east1 --update-env-vars PUBLIC_RATE_LIMIT=100000,SHOP_RATE_LIMIT=100000,DEVICE_RATE_LIMIT=100000
node scripts/loadtest.js --url "$STG" --mountain <demo slug> --login <counter login> --password '<password>' \
  --staging-password "$(gcloud secrets versions access latest --secret=summitops-staging-gate)" --pair-code <code> --json ~/loadtest.json
gcloud run services update summitops-staging --region us-east1 --remove-env-vars PUBLIC_RATE_LIMIT,SHOP_RATE_LIMIT,DEVICE_RATE_LIMIT
```

To see the limits hold across servers, deploy staging with two servers first: `STAGING_MAX_SERVERS=2 bash deploy.sh`.
Staging has at most 1 or 2 servers and a small database, so its numbers are a floor for live, not a promise.
`--orders 10` also makes 10 online orders, each opening a Stripe checkout in test mode.

Results on a developer computer (one server, the shared limits in the database, MariaDB on the same machine,
120 seconds, 6 gates scanning every 2 seconds, 6 counters selling every 10 seconds, 120 online shoppers, 0 errors):

| Request | Per minute | p50 | p95 | p99 |
|---|---|---|---|---|
| Gate scan | 166 | 14 ms | 43 ms | 108 ms |
| Counter sale | 33 | 22 ms | 80 ms | 120 ms |
| Shop day (prices and spots) | 55 | 23 ms | 44 ms | 85 ms |
| Everything (541 a minute) | | 14 ms | 41 ms | 85 ms |

At three times that (1,860 requests a minute) p95 was 70 ms and p99 149 ms, with 0 errors; counting the limits in
memory instead was p95 50 ms, so the shared limits cost about 20 ms at the 95th percentile under that load.

### Uptime checks that text you

`bash scripts/uptime-setup.sh +1XXXXXXXXXX you@example.com` makes, in Cloud Monitoring: a text channel to your phone
(confirmed with a code) and an email channel; an uptime check on live `/readyz` every minute from three US regions
(it passes only on `"ok":true`, so a database that cannot be reached or a missing migration also alerts); a check on
the website's `/status` every 5 minutes (when `SITE_HOSTS` is set); and an alert for each when two regions fail for a
minute, with another message when it is back. `--dry-run` shows what it would do. To change the phone, run it again
with the new number. Staging is not checked.

### The status page

`/status` on the website (and `/site/status`) shows each part (the app, online shop and booking pages, card payments,
email, texts) as Working, Slow or partly working, Not working, or Not checked (that part is not set up). Each server
checks them itself at most once a minute: the database, and whether Stripe, Postmark and Twilio accept our keys
(`STATUS_PROBES=off` skips those three). Incidents and planned maintenance are written in the console (Status page);
an open note sets its parts' state. It shows the last 90 days and never any customer data. It is linked from the
website's footer and the Security page. `GET /api/v1/status` gives the same as JSON.

## Staging

`bash scripts/staging-setup.sh`, once, from an unzipped release folder, creates:

| | Live | Staging |
|---|---|---|
| Cloud Run service | `summitops-api` | `summitops-staging` (one server at most, none when idle) |
| Service account | `summitops-run` (reads the live secrets) | `summitops-staging`: reaches the database server and writes logs; reads only the `summitops-staging-*` secrets, never a live one |
| Database | the live one | `summitops_staging` on the same server, with a login (`summitops_stg`) that can reach nothing else |
| Keys | live secrets | `summitops-staging-*` secrets: sign-in key, bootstrap key, database password, staging password, and staging's own copies of the email (Postmark) and assistant keys |
| Stripe | live keys | test keys only (a live key stops staging from starting), with its own test-mode webhooks |
| Email and texts | to guests and staff | every email to `STAGING_INBOX`, with who it was for in the subject; no texts unless `STAGING_SMS_TO` is set |
| Visitors | everyone | a shared password (`STAGING_GATE`) first; hidden from search engines; a yellow band on every page |

Staging starts empty. Use its `/try` page for a full demo mountain, or its bootstrap key to create a mountain or sign
in to its console the first time. Read the staging password or the bootstrap key with
`gcloud secrets versions access latest --secret=summitops-staging-gate` (or `summitops-staging-bootstrap`). The script
is safe to run again: it keeps what exists, fills in anything missing (for example Stripe, if it was skipped) and prints
each permission it changes.

Staging shares the live database server (Cloud SQL instance), in a database of its own that the staging login cannot
leave. Its service account can connect to that server but holds no live database password, so it can only sign in as
the staging login. A separate server or project would separate them further.
Staging's email key starts as a copy of the live Postmark key (so a leak from staging could send mail as you). For full
separation, make a second Postmark server for staging and store its token with
`printf '%s' <token> | gcloud secrets versions add summitops-staging-postmark --data-file=-`.

**A staging set up before staging had its own account runs as the live account** (`summitops-run`), which can read every live key.
`deploy.sh` now stops until it is moved. Run `bash scripts/staging-setup.sh` once from the release folder staging runs:
it makes `summitops-staging`, gives it staging's keys, takes them away from `summitops-run`, checks it can read no live
secret, and redeploys staging as it. To switch only the account of the running staging service, after that script has
made the account and its permissions:
`gcloud run services update summitops-staging --region us-east1 --service-account summitops-staging@summitops-510715.iam.gserviceaccount.com`

## Optional settings (Cloud Run environment)

| Setting | What it turns on |
| --- | --- |
| `POSTMARK_SERVER_TOKEN`, `MAIL_FROM` | Email (tickets, reminders, patrol follow-ups, weekly report, messages) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Text messages |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL` | Stripe: the platform's own account (mountains' Verdynt/OS subscriptions). Its webhook sends `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.*` and `invoice.*` to `/api/v1/stripe/webhook`. |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | Guest card payments (shop, lessons, date changes, patrol giving) go to each mountain's own Stripe account through Stripe Connect. This is the signing secret of the Connect webhook. See "Guest card payments (Stripe Connect)" below. |
| `STRIPE_GUEST_FALLBACK` | Leave unset. In production a mountain takes guest card payments only once it has connected its own Stripe account. `on` would let unconnected mountains take payments into the platform's account (tests and local runs only). |
| `JOBS_KEY` | The daily job (`POST /api/v1/internal/jobs/daily` with header `x-jobs-key`), called by Cloud Scheduler once a day |
| `BOOTSTRAP_KEY` | Creating mountains and the platform console |
| `DB_POOL` | Database connections per server (promote.sh sets 8 on live, deploy.sh 4 on staging; see Servers and database connections) |
| `RATE_STORE`, `RATE_STORE_TIMEOUT_MS` | Where rate limits are counted: `mysql` (shared by every server; deploy.sh and promote.sh set it) or `memory` (this server only; the default outside production). How long to wait for the database before counting in memory (default 250 ms; while a count for one key is still running, more hits on it are counted in memory, and at most `RATE_STORE_MAX_PENDING`, default 10, counting queries run at once per server). |
| `PUBLIC_RATE_LIMIT`, `DEVICE_RATE_LIMIT`, `SHOP_RATE_LIMIT` | Limits on guest pages (600 a minute per address and mountain, and `PUBLIC_RATE_LIMIT_ALL`, 2400 a minute, per address across all mountains), gates (600 a minute per paired gate; `DEVICE_MISS_LIMIT`, 30 a minute per address, for requests with no or a wrong gate key) and online orders (12 an hour). Raise them on staging only, for a load test. |
| `STATUS_PROBES`, `STATUS_CACHE_MS` | The status page's outside checks (`off` skips Stripe, Postmark and Twilio) and how long each server keeps its checks (default 60000 ms). |
| `LIVE_MIN_SERVERS`, `LIVE_MAX_SERVERS`, `LIVE_DB_POOL`, `STAGING_MAX_SERVERS` | Not service settings: set them in Cloud Shell before `bash promote.sh` or `bash deploy.sh` to change the number of servers (defaults 1, 4, 8 and 1). |
| `POSTMARK_BROADCAST_STREAM` | The Postmark stream for marketing messages (default `broadcast`); tickets, reminders and patrol mail use `POSTMARK_STREAM` (default `outbound`) |
| `TOTP_KEY`, `LINK_SECRET`, `KIOSK_SECRET` | Separate keys for two-step secrets, unsubscribe links and staff badges. Each falls back to `JWT_SECRET`. See RUNBOOK.md before rotating `JWT_SECRET`. |
| `SITE_HOSTS`, `APP_URL`, `SITE_CONTACT_EMAIL` | The product website on its own domain. `SITE_HOSTS` lists the website's addresses (`www.runmyresort.com,runmyresort.com`): on those, `/` is the website. `APP_URL` is where staff sign in (`https://app.runmyresort.com`). `SITE_CONTACT_EMAIL` gets the Contact page's requests (they are also in the console, Leads). The website is always at `/site` too. See "Putting the website live" below. |
| `SITE_HELLO_EMAIL`, `SITE_SUPPORT_EMAIL` | The public addresses on the website and in Help. Default `hello@runmyresort.com` (sales and questions) and `support@runmyresort.com` (customer support, security.txt). Contact page requests (`SITE_CONTACT_EMAIL`) and replies to Verdynt/OS's own emails go to the hello@ address. |
| `PATROL_AI`, `ANTHROPIC_API_KEY`, `PATROL_AI_MODEL` | Patrol "Fill in from the story". Off unless `PATROL_AI=on` and a key is set; then each mountain turns it on in Patrol, Settings. The patient narrative is sent to Anthropic, so set these only once a business associate agreement (BAA) covers it. `PATROL_AI_MODEL` defaults to `claude-sonnet-5-5`. The report check needs nothing. |
| `ASSISTANT_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_DATA_MODEL` | The in-app assistant (Ask) and Assistant Plus. Off unless `ASSISTANT_API_KEY` is set (as a secret). Use a key from a plain Anthropic organization, not the patrol BAA key: the assistant never sees patient care records. `ASSISTANT_MODEL` (how-to questions and guests) defaults to `claude-haiku-5-5`; `ASSISTANT_DATA_MODEL` (Assistant Plus look-ups) to `claude-sonnet-5-5`. `ASSISTANT=off` turns it off without removing the key. `ASSISTANT_PRICES` (JSON, dollars per million tokens, e.g. `{"claude-haiku-5-5":[0.1,0.5]}`) corrects the cost the monthly cap counts if prices change. Set the key on live and staging with `bash scripts/assistant-key.sh sk-ant-...`. |
| `SITE_FOUNDER_NAME`, `DEMO_MAIL_FROM` | Demo emails (welcome, day-2 nudge, before-it-ends note) come from this name, default `Dan Pickersgill`; replies go to `SITE_HELLO_EMAIL`. `DEMO_MAIL_FROM` is an optional sender address of your own (e.g. `dan@runmyresort.com`), which must be a verified sender in Postmark; without it they use `MAIL_FROM`. The follow-ups go out with the daily job. |
| `MAP_TILE_URL`, `MAP_IMAGERY_URL`, `MAP_IMAGERY_MAX_ZOOM`, `MAP_MAX_ZOOM` | Map tiles. By default the street map is OpenStreetMap's free servers (no guarantee, and they may cut off commercial apps; take a MapTiler or similar plan and set `MAP_TILE_URL` before many mountains rely on the maps) and the satellite view is the USGS National Map's aerial imagery (free, public domain, US only). `MAP_IMAGERY_URL` swaps in paid imagery; `MAP_IMAGERY_MAX_ZOOM` is its deepest tile level (default 16); `MAP_MAX_ZOOM` is how far every map zooms (default 21). |
| `SITE_SAME_AS` | The company's own profiles elsewhere, comma-separated (the LinkedIn company page). Google uses them to tie the profiles to the website; a LinkedIn address is also linked from the website's footer. |
| `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | The ownership codes from Google Search Console and Bing Webmaster Tools (their "HTML tag" option), added to every website page. |
| `PLATFORM_TOTP_SECRET`, `PLATFORM_ALLOW_IPS` | Two-step sign-in and an address allowlist for the platform console. See RUNBOOK.md. |
| `OPEN_METEO_KEY`, `WEATHER` | Day by day records each mountain's weather from Open-Meteo every night. Open-Meteo's free service is for non-commercial use; once mountains are paying, buy an Open-Meteo API plan and set `OPEN_METEO_KEY` to its key. `WEATHER=off` stops the weather lookups (the rest of each day is still recorded). |
| `SESSION_IDLE_MINUTES`, `LOGIN_LOCK_AFTER`, `REQUIRE_ADMIN_MFA`, `PWNED_CHECK`, `PLATFORM_KEY_SIGNIN` | Security settings, all with safe defaults: sign-out after 60 idle minutes, a 15-minute lock after 10 wrong passwords, two-step required for owners and managers in production, breached passwords refused, and the platform key off once an operator has two-step. See RUNBOOK.md, Security setup. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `STEP_UP_MINUTES`, `STEP_UP_REFUND_CENTS`, `TERMINAL_IDLE_MINUTES` | Passkeys and the second check. Set `WEBAUTHN_RP_ID` to your own domain (for example `runmyresort.com`) once the app is on it, before people add passkeys. See RUNBOOK.md, Tiered sign-in. |
| `TRUST_PROXY_HOPS`, `PUSH_EXTRA_HOSTS`, `AUDIT_LOG_STDOUT` | Set by cloud-armor.sh (2 behind the load balancer); extra push service hosts; `off` stops audit events going to Cloud Logging. |

See RUNBOOK.md for rotating secrets, the scheduler command, the one-time security setup (`bash scripts/harden.sh`) and the security checklist.

## Putting the website live

The product website (Home, Product, the solution pages for ski patrol, lift tickets, ski school, rentals, waivers and lift maintenance, Pricing, Security, Contact, Privacy, Terms) is served by this same service. Check it first at `https://<service address>/site/`.

1. **Domains.** In Cloud Run, Manage custom domains, map the website address (for example `www.runmyresort.com`, and the bare `runmyresort.com`) and the app address (`app.runmyresort.com`) to `summitops-api`. Add the DNS records it shows at your domain registrar. The certificates follow on their own, usually within an hour.
2. **Settings.** Set the website's settings once (they are kept by every later deploy):
   ```
   gcloud run services update summitops-api --region us-east1 --update-env-vars "^@^SITE_HOSTS=www.runmyresort.com,runmyresort.com@APP_URL=https://app.runmyresort.com@PUBLIC_URL=https://app.runmyresort.com@WEBAUTHN_RP_ID=runmyresort.com@SITE_CONTACT_EMAIL=you@yourdomain.com"
   ```
   The `^@^` at the start lets the website list hold a comma. `PUBLIC_URL` is used for Stripe's return links, so it should be the app address. `WEBAUTHN_RP_ID` makes passkeys belong to the domain, so one passkey works on every address under it; passkeys made earlier on the run.app address stop working and are added again.
3. **Email.** The Contact page emails `SITE_CONTACT_EMAIL` and sends the visitor a copy through Postmark, so `POSTMARK_SERVER_TOKEN` and `MAIL_FROM` must be set and the sender verified. Without email, requests still land in the console under Leads.
4. **Prices.** The Pricing page shows the active plans and add-ons from the console (Plans and prices). The first migration adds the launch set (Lodge, Mountain, Resort and six add-ons); change them there and the website follows within a minute. Press Sync to Stripe on each before mountains pay.
5. **Legal pages.** Privacy and Terms are plain-language starting points. Have a lawyer read them before launch, especially the governing law (Pennsylvania), the 60-day export window and the liability limit.
6. **Moving addresses.** Point the Stripe webhooks (card payments and subscriptions) at `https://app.runmyresort.com/api/v1/stripe/webhook`, and the daily job: `gcloud scheduler jobs update http summitops-daily --location us-east1 --uri https://app.runmyresort.com/api/v1/internal/jobs/daily`.
7. **Search engines.** In [Google Search Console](https://search.google.com/search-console), add the website as a URL-prefix property (`https://www.runmyresort.com/`), choose the HTML tag check, and set its code as `GOOGLE_SITE_VERIFICATION` (same `gcloud run services update ... --update-env-vars` as above). Once verified, submit `https://www.runmyresort.com/sitemap.xml` under Sitemaps. Do the same in Bing Webmaster Tools with `BING_SITE_VERIFICATION` (it can also import from Search Console). Check the structured data with Google's Rich Results Test. If the domain is already verified as a Domain property (a DNS TXT record), skip the tag and go straight to Sitemaps.
8. **What search engines get.** Every page has its own title, description, canonical address, link-preview card and structured data (the organisation, the software with its live prices, breadcrumbs, and each page's questions). Plans and prices are written into Home and Pricing on the server, so crawlers see the real prices. `/sitemap.xml` lists every page, `/robots.txt` keeps the app, console and API out, and `/llms.txt` is a plain summary for AI assistants. The app address (`app.runmyresort.com`) is never indexed apart from each mountain's own public pages.

## Guest card payments (Stripe Connect)

Guests' card payments go straight into each mountain's own Stripe account (a Standard account the mountain controls), never into the Verdynt/OS account. The mountain pays Stripe's card fees on its own account and gets Stripe's payouts to its own bank. Verdynt/OS can keep a platform fee per mountain, set in the console (mountain, Guest card payments, Set the fee); it is 0 unless you set it, it is returned in proportion on refunds, and gifts to the patrol never carry it.

Set up once, in the Stripe dashboard of the Verdynt/OS account:

1. **Turn on Connect.** Connect, Get started: choose to build a platform where your users (the mountains) take payments, and fill in the platform profile. The mountains use Standard accounts, which they run themselves in their own Stripe dashboard.
2. **The Connect webhook.** Developers, Webhooks (or Workbench, Event destinations), Add a destination: choose **Connected accounts** (events on your users' accounts), the address `https://app.runmyresort.com/api/v1/stripe/webhook`, and the events `checkout.session.completed`, `checkout.session.expired`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` (card reader payments at the counter), `account.updated` and `account.application.deauthorized`. Copy its signing secret (`whsec_...`).
3. **Give the secret to the service**, from the unzipped folder in Cloud Shell:
   ```
   bash scripts/stripe-connect.sh whsec_...
   ```
4. **Each mountain connects.** The owner opens Billing, Guest card payments, Connect Stripe, confirms it is them, and finishes Stripe's pages (the business, a person and a bank account; an existing Stripe login works). Card payments open as soon as Stripe says the account can take them. Until then the online shop, lesson payments and patrol giving show as not taking cards.

Payments taken into the Verdynt/OS account before this release (if any) still refund through the Verdynt/OS account; everything new goes to the mountain's own.

