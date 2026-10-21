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
the exact command for the revision it replaced.

## Staging

`bash scripts/staging-setup.sh`, once, from an unzipped release folder, creates:

| | Live | Staging |
|---|---|---|
| Cloud Run service | `summitops-api` | `summitops-staging` (one server at most, none when idle) |
| Database | the live one | `summitops_staging` on the same server, with a login (`summitops_stg`) that can reach nothing else |
| Keys | live secrets | `summitops-staging-*` secrets: sign-in key, bootstrap key, database password, staging password |
| Stripe | live keys | test keys only (a live key stops staging from starting), with its own test-mode webhooks |
| Email and texts | to guests and staff | every email to `STAGING_INBOX`, with who it was for in the subject; no texts unless `STAGING_SMS_TO` is set |
| Visitors | everyone | a shared password (`STAGING_GATE`) first; hidden from search engines; a yellow band on every page |

Staging starts empty. Use its `/try` page for a full demo mountain, or its bootstrap key to create a mountain or sign
in to its console the first time. Read the staging password or the bootstrap key with
`gcloud secrets versions access latest --secret=summitops-staging-gate` (or `summitops-staging-bootstrap`). The script
is safe to run again: it keeps what exists and fills in anything missing (for example Stripe, if it was skipped).

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
| `DB_POOL` | Database connections per server (deploy.sh sets 8; with at most 4 servers that is 32 connections) |
| `POSTMARK_BROADCAST_STREAM` | The Postmark stream for marketing messages (default `broadcast`); tickets, reminders and patrol mail use `POSTMARK_STREAM` (default `outbound`) |
| `TOTP_KEY`, `LINK_SECRET`, `KIOSK_SECRET` | Separate keys for two-step secrets, unsubscribe links and staff badges. Each falls back to `JWT_SECRET`. See RUNBOOK.md before rotating `JWT_SECRET`. |
| `SITE_HOSTS`, `APP_URL`, `SITE_CONTACT_EMAIL` | The product website on its own domain. `SITE_HOSTS` lists the website's addresses (`www.runmyresort.com,runmyresort.com`): on those, `/` is the website. `APP_URL` is where staff sign in (`https://app.runmyresort.com`). `SITE_CONTACT_EMAIL` gets the Contact page's requests (they are also in the console, Leads). The website is always at `/site` too. See "Putting the website live" below. |
| `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | The ownership codes from Google Search Console and Bing Webmaster Tools (their "HTML tag" option), added to every website page. |
| `PLATFORM_TOTP_SECRET`, `PLATFORM_ALLOW_IPS` | Two-step sign-in and an address allowlist for the platform console. See RUNBOOK.md. |
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
2. **The Connect webhook.** Developers, Webhooks (or Workbench, Event destinations), Add a destination: choose **Connected accounts** (events on your users' accounts), the address `https://app.runmyresort.com/api/v1/stripe/webhook`, and the events `checkout.session.completed`, `checkout.session.expired`, `account.updated` and `account.application.deauthorized`. Copy its signing secret (`whsec_...`).
3. **Give the secret to the service**, from the unzipped folder in Cloud Shell:
   ```
   bash scripts/stripe-connect.sh whsec_...
   ```
4. **Each mountain connects.** The owner opens Billing, Guest card payments, Connect Stripe, confirms it is them, and finishes Stripe's pages (the business, a person and a bank account; an existing Stripe login works). Card payments open as soon as Stripe says the account can take them. Until then the online shop, lesson payments and patrol giving show as not taking cards.

Payments taken into the Verdynt/OS account before this release (if any) still refund through the Verdynt/OS account; everything new goes to the mountain's own.

