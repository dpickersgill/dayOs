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

Run these in Cloud Shell.

1. Unzip the newest zip into a clean folder:
   ```bash
   rm -rf ~/summitops-new && mkdir ~/summitops-new
   unzip -oq "$(ls -t ~/summitops-rentals*.zip | head -1)" -d ~/summitops-new
   cd ~/summitops-new
   ```
2. Run the deploy script. It installs, loads the database settings, migrates (and stops if that fails), deploys with
   the right limits, and checks the new version:
   ```bash
   bash deploy.sh
   ```
   It ends with `Done. <address> is up and migrated.` If it stops earlier, nothing was deployed; send the last lines.

If it says you are not signed in, run `gcloud auth login`, then `gcloud config set project summitops-510715`, and run it again.

`/readyz` answers `{"ok":false,"reason":"run npm run migrate"}` when a version is running against a database that was not migrated for it.

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
