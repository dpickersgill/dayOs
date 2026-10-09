# Deploying SummitOps

SummitOps runs on Google Cloud Run (service `summitops-api`, region `us-east1`) with an Aiven MySQL database. Secrets live in Google Secret Manager. Every update is: upload the zip, install, migrate, deploy, check.

## First deploy

From Google Cloud Shell, in this folder:

```bash
gcloud run deploy summitops-api --source . --region us-east1 --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,DB_SSL=true,DB_HOST=...,DB_PORT=...,DB_USER=...,DB_NAME=summitops \
  --set-secrets DB_PASSWORD=summitops-db-password:latest,JWT_SECRET=summitops-jwt:latest,BOOTSTRAP_KEY=summitops-bootstrap:latest,DB_CA=aiven-ca:latest
```

Run `npm run migrate` against the Aiven database (Cloud Shell works) before the first request, and again after every update: it only adds what is missing and never touches data. Health checks: `GET /healthz` (process) and `GET /readyz` (database).

## Updating (every new zip)

Run these in Cloud Shell, one at a time.

1. Unzip the newest zip into a clean folder:
   ```bash
   rm -rf ~/summitops-new && mkdir ~/summitops-new
   unzip -oq "$(ls -t ~/summitops-rentals*.zip | head -1)" -d ~/summitops-new
   cd ~/summitops-new && npm install --omit=dev
   ```
2. Load the database settings from the running service and Secret Manager:
   ```bash
   for k in DB_HOST DB_PORT DB_USER DB_NAME; do export $k="$(gcloud run services describe summitops-api --region us-east1 --format=json | jq -r --arg k $k '.spec.template.spec.containers[0].env[] | select(.name==$k) | .value')"; done; export DB_SSL=true NODE_ENV=production
   export DB_PASSWORD="$(gcloud secrets versions access latest --secret=summitops-db-password)" DB_CA="$(gcloud secrets versions access latest --secret=aiven-ca)" JWT_SECRET="$(gcloud secrets versions access latest --secret=summitops-jwt)"
   ```
3. Migrate (safe to re-run; only adds what is missing): `npm run migrate`
4. Deploy: `gcloud run deploy summitops-api --source . --region us-east1 --quiet`
5. Check: `curl -s https://<service-url>/readyz` should print `{"ok":true}`.

If Cloud Shell says there is no active account, run `gcloud auth login`, then `gcloud config set project summitops-510715`, and repeat the step.

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
| `DB_POOL` | Database connections per server (default 10) |

See RUNBOOK.md for rotating secrets, the scheduler command and the security checklist.
