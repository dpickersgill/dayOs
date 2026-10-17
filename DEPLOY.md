# Deploying SummitOps

SummitOps runs on Google Cloud Run (service `summitops-api`, region `us-east1`) with a Cloud SQL MySQL 8.4 database (`summitops-db`, same region; reached through the Cloud SQL socket, `DB_SOCKET`). Until `move-to-cloudsql.sh` has been run it uses Aiven. Secrets live in Google Secret Manager. Every update is: upload the zip, install, migrate, deploy, check.

## First deploy

From Google Cloud Shell, in this folder:

```bash
gcloud run deploy summitops-api --source . --region us-east1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,DB_SSL=true,DB_HOST=...,DB_PORT=...,DB_USER=...,DB_NAME=summitops \
  --set-secrets DB_PASSWORD=summitops-db-password:latest,JWT_SECRET=summitops-jwt:latest,BOOTSTRAP_KEY=summitops-bootstrap:latest,DB_CA=aiven-ca:latest
```

Run `npm run migrate` against the Aiven database (Cloud Shell works) before the first request, and again after every update: it only adds what is missing and never touches data. Health checks: `GET /healthz` (process) and `GET /readyz` (database).

## Updating (every new zip)

Every zip is named after its version, for example `summitops-2026.10.4.zip` (see Versions, below). Run these in Cloud Shell.

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
3. Run the deploy script. It says which version it is replacing and refuses to put an older version over a newer one,
   then installs, loads the database settings, migrates (and stops if that fails), deploys with the right limits, and
   checks the new version is the one answering:
   ```bash
   bash deploy.sh
   ```
   It ends with `Done. <address> is running <version>, migrated.` If it stops earlier, nothing was deployed; send the last lines.

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
- `deploy.sh` stops if the live site is newer than this folder. To go back to an older version on purpose (better: use
  Rolling back, below, which needs no rebuild), run `bash deploy.sh --allow-older`.

## Rolling back

Every deploy is a new Cloud Run revision. To go back, list revisions and send all traffic to the previous one:

```bash
gcloud run revisions list --service summitops-api --region us-east1
gcloud run services update-traffic summitops-api --region us-east1 --to-revisions=<previous-revision>=100
```

Migrations only add tables and columns, so the previous revision keeps working after a rollback.

## Optional settings (Cloud Run environment)

| Setting | What it turns on |
| --- | --- |
| `POSTMARK_SERVER_TOKEN`, `MAIL_FROM` | Email (tickets, reminders, patrol follow-ups, weekly report, messages) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Text messages |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL` | Online card payment (shop, lessons, donations). The Stripe webhook must send `checkout.session.completed` and `checkout.session.expired` to `/api/v1/stripe/webhook`. |
| `JOBS_KEY` | The daily job (`POST /api/v1/internal/jobs/daily` with header `x-jobs-key`), called by Cloud Scheduler once a day |
| `BOOTSTRAP_KEY` | Creating mountains and the platform console |
| `DB_POOL` | Database connections per server (deploy.sh sets 8; with at most 4 servers that is 32 connections) |
| `POSTMARK_BROADCAST_STREAM` | The Postmark stream for marketing messages (default `broadcast`); tickets, reminders and patrol mail use `POSTMARK_STREAM` (default `outbound`) |
| `TOTP_KEY`, `LINK_SECRET`, `KIOSK_SECRET` | Separate keys for two-step secrets, unsubscribe links and staff badges. Each falls back to `JWT_SECRET`. See RUNBOOK.md before rotating `JWT_SECRET`. |
| `SITE_HOSTS`, `APP_URL`, `SITE_CONTACT_EMAIL` | The product website on its own domain. `SITE_HOSTS` lists the website's addresses (`www.summitops.com,summitops.com`): on those, `/` is the website. `APP_URL` is where staff sign in (`https://app.summitops.com`). `SITE_CONTACT_EMAIL` gets the Contact page's requests (they are also in the console, Leads). The website is always at `/site` too. See "Putting the website live" below. |
| `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | The ownership codes from Google Search Console and Bing Webmaster Tools (their "HTML tag" option), added to every website page. |
| `PLATFORM_TOTP_SECRET`, `PLATFORM_ALLOW_IPS` | Two-step sign-in and an address allowlist for the platform console. See RUNBOOK.md. |
| `SESSION_IDLE_MINUTES`, `LOGIN_LOCK_AFTER`, `REQUIRE_ADMIN_MFA`, `PWNED_CHECK`, `PLATFORM_KEY_SIGNIN` | Security settings, all with safe defaults: sign-out after 60 idle minutes, a 15-minute lock after 10 wrong passwords, two-step required for owners and managers in production, breached passwords refused, and the platform key off once an operator has two-step. See RUNBOOK.md, Security setup. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `STEP_UP_MINUTES`, `STEP_UP_REFUND_CENTS`, `TERMINAL_IDLE_MINUTES` | Passkeys and the second check. Set `WEBAUTHN_RP_ID` to your own domain (for example `summitops.com`) once the app is on it, before people add passkeys. See RUNBOOK.md, Tiered sign-in. |
| `TRUST_PROXY_HOPS`, `PUSH_EXTRA_HOSTS`, `AUDIT_LOG_STDOUT` | Set by cloud-armor.sh (2 behind the load balancer); extra push service hosts; `off` stops audit events going to Cloud Logging. |

See RUNBOOK.md for rotating secrets, the scheduler command, the one-time security setup (`bash scripts/harden.sh`) and the security checklist.

## Putting the website live

The product website (Home, Product, Pricing, Security, Contact, Privacy, Terms) is served by this same service. Check it first at `https://<service address>/site/`.

1. **Domains.** In Cloud Run, Manage custom domains, map the website address (for example `www.summitops.com`, and the bare `summitops.com`) and the app address (`app.summitops.com`) to `summitops-api`. Add the DNS records it shows at your domain registrar. The certificates follow on their own, usually within an hour.
2. **Settings.** Set the website's settings once (they are kept by every later deploy):
   ```
   gcloud run services update summitops-api --region us-east1 --update-env-vars "^@^SITE_HOSTS=www.summitops.com,summitops.com@APP_URL=https://app.summitops.com@PUBLIC_URL=https://app.summitops.com@SITE_CONTACT_EMAIL=you@yourdomain.com"
   ```
   The `^@^` at the start lets the website list hold a comma. `PUBLIC_URL` is used for Stripe's return links, so it should be the app address.
3. **Email.** The Contact page emails `SITE_CONTACT_EMAIL` and sends the visitor a copy through Postmark, so `POSTMARK_SERVER_TOKEN` and `MAIL_FROM` must be set and the sender verified. Without email, requests still land in the console under Leads.
4. **Prices.** The Pricing page shows the active plans and add-ons from the console (Plans and prices). The first migration adds the launch set (Lodge, Mountain, Resort and six add-ons); change them there and the website follows within a minute. Press Sync to Stripe on each before mountains pay.
5. **Legal pages.** Privacy and Terms are plain-language starting points. Have a lawyer read them before launch, especially the governing law (Pennsylvania), the 60-day export window and the liability limit.
6. **Search engines.** In [Google Search Console](https://search.google.com/search-console), add the website as a URL-prefix property (`https://www.summitops.com/`), choose the HTML tag check, and set its code as `GOOGLE_SITE_VERIFICATION` (same `gcloud run services update ... --update-env-vars` as above). Once verified, submit `https://www.summitops.com/sitemap.xml` under Sitemaps. Do the same in Bing Webmaster Tools with `BING_SITE_VERIFICATION` (it can also import from Search Console). Check the structured data with Google's Rich Results Test.
