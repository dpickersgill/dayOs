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
| `PLATFORM_TOTP_SECRET`, `PLATFORM_ALLOW_IPS` | Two-step sign-in and an address allowlist for the platform console. See RUNBOOK.md. |

See RUNBOOK.md for rotating secrets, the scheduler command and the security checklist.
