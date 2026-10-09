# SummitOps runbook: security and operations

## Before real customers
1. **Rotate the Aiven database password** (Aiven console > service > Users > reset). Then update the secret:
   `echo -n 'NEWPASS' | gcloud secrets versions add summitops-db-password --data-file=-`
   and redeploy: `gcloud run deploy summitops-api --source . --region us-east1`.
2. **Change the owner password** in the app (Settings > Change password) and turn on two-step sign-in for every owner and manager.
3. **Verify backups**: in Aiven confirm automated backups are on and retention is acceptable. Do a restore into a throwaway service once and check the data.
4. **Legal**: have a lawyer review the waiver text and privacy terms. Sign BAAs (Aiven, Google Cloud) before storing patrol patient/health data (see HIPAA.md).
5. **Card payments**: pick a processor (Square or Stripe) before taking live cards through a terminal. Until then card sales are recorded manually.

## Keeping an eye on it (set up once)

Every failure is written to the logs as one line with `"severity":"ERROR"` and a `job` name (`email`, `sms`,
`stripe_webhook`, `card_refund`, `daily`, and the daily job stages). Each finished daily job writes `daily job finished`.

1. **Uptime check:** Cloud console, Monitoring, Uptime checks, Create. Target: HTTPS, your service address, path
   `/readyz`, every 5 minutes. Alert by email.
2. **Error alert:** Cloud console, Logging, Logs Explorer. Query:
   `resource.type="cloud_run_revision" AND jsonPayload.severity="ERROR"`. Choose Actions, Create log alert, notify by
   email, at most one email every 30 minutes.
3. **Daily job missed:** Logging, Log-based metrics, Create a counter metric named `daily_job_finished` for
   `jsonPayload.message="daily job finished"`. Then Monitoring, Alerting, Create policy on that metric: alert when it
   is absent for 26 hours.
4. **Give the daily job time to finish:** it can run for several minutes as mountains grow.
   `gcloud scheduler jobs update http summitops-daily --location us-east1 --attempt-deadline=900s`
5. **Budget:** Billing, Budgets and alerts, a monthly budget (for example $50) with email alerts.

## Backups

Aiven keeps its own backups (one on Hobbyist; two days of point-in-time recovery on Startup). Before a paying mountain
relies on it, move to Startup or higher. For a copy you hold yourself, once a month (or before a risky change):

```bash
gsutil mb -l us-east1 gs://summitops-510715-backups 2>/dev/null || true
mysqldump --single-transaction --routines --set-gtid-purged=OFF -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" \
  --ssl-ca=<(echo "$DB_CA") "$DB_NAME" | gzip | gsutil cp - "gs://summitops-510715-backups/summitops-$(date +%F).sql.gz"
```

(Load the DB_* settings first, as in DEPLOY.md.) Test a restore into a scratch database once a season.

## Rotating keys

`JWT_SECRET` signs sign-ins. Until this release it also protected two-step secrets, unsubscribe links and staff badges,
so rotating it on its own would lock out everyone using two-step sign-in and break every printed badge. Now each has its
own setting. To rotate `JWT_SECRET` safely:

1. Set `TOTP_KEY`, `LINK_SECRET` and `KIOSK_SECRET` on Cloud Run to the **current** `JWT_SECRET` value (as secrets).
2. Deploy, and check two-step sign-in and a badge still work.
3. Now change `JWT_SECRET`. Everyone signs in again; nothing else changes.

## Platform console

The console (`/platform`) asks for the platform key and your name, and records your name with every change.

- **Two-step sign-in (recommended):** create a secret with `node -e "console.log(require('./src/lib/totp').newSecret())"`,
  add it to your authenticator app (manual entry, time-based, 6 digits), and set it on Cloud Run as
  `PLATFORM_TOTP_SECRET`. From then on the key alone does not open the console.
- **Address allowlist (optional):** `PLATFORM_ALLOW_IPS` = a comma-separated list of addresses allowed to use it.

## Two-step sign-in recovery
- A user who lost their phone: use a recovery code, or an owner/manager clicks **Reset two-step** in Settings > Users.
- If the only owner is locked out, reset in SQL (Cloud Shell, with DB env vars):
  `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE email = 'owner@example.com';`
  then `DELETE FROM user_recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = 'owner@example.com');`
  and, if the mountain requires two-step, `UPDATE tenants SET require_mfa = 0 WHERE slug = 'your-slug';`
- **Warning**: turning on "require two-step" for the mountain forces everyone without it to enrol at next sign-in. Enrol yourself first.

## Routine
- After each update run `npm run migrate` against the live DB before deploying.
- Review the user list quarterly and disable staff who have left.

## Online lesson booking
- The public page `/book/<slug>` is open to anyone with the link. It is rate limited (8 requests an hour per address, a hidden bot trap, and caps on waiting requests), asks for no card and shows no guest data.
- It only works when someone watches **Ski school > Online requests**: check it each morning, and confirm or decline.
- Waiver: the guest ticks the waiver on the page. For anyone under 18 the person booking (an adult) accepts it as guardian; an adult booked by someone else signs at the desk. Have a lawyer review the wording.
- To turn it off immediately: Settings > Online lesson booking, untick, Save.


## Online card payment (Stripe)

Guests can pay for a lesson when they reserve it on `/book/<slug>`. Test with Stripe's **test mode** keys first.

1. In Stripe (dashboard.stripe.com) copy the **Secret key** (`sk_test_...` for testing, `sk_live_...` when ready).
2. In Stripe > Developers > Webhooks, add an endpoint `https://<your service URL>/api/v1/stripe/webhook` listening for `checkout.session.completed` and `checkout.session.expired`. Copy its **Signing secret** (`whsec_...`).
3. Store both as secrets and give them to Cloud Run (replace the names if you already use others):
   `printf '%s' 'sk_test_...' | gcloud secrets create stripe-secret-key --data-file=-` and the same for `stripe-webhook-secret`, then
   `gcloud run services update summitops-api --region us-east1 --update-secrets STRIPE_SECRET_KEY=stripe-secret-key:latest,STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest`
   (the service account needs the Secret Accessor role on both secrets, as it has for the database password).
4. In SummitOps > Settings, tick "Guests pay by card when they reserve" and set the refund tiers.

How it behaves: reserving holds the place for about 30 minutes while the guest pays. A signed webhook from Stripe books the lesson and records an order (channel online, tender card, tax included). If the lesson filled up meanwhile, or the amount does not match, the payment is refunded in full automatically. Cancelling online refunds 100% / the partial percent / 0% by hours before the lesson, and the refund is sent to Stripe and recorded in the books.

Limits to know: all money goes to the one Stripe account whose key you set (several mountains each need their own account or Stripe Connect, which is not built). A refund you issue from Sell > Orders on a card sale is recorded in SummitOps but is **not** sent to Stripe: issue it in the Stripe dashboard too. No confirmation emails are sent by SummitOps (Stripe can email receipts from its settings). Have a lawyer review the cancellation policy and waiver wording.

## Patrol follow-up emails and giving

One-time setup, in Cloud Shell:

1. **Postmark.** In Postmark, create or pick a server, verify the sender address you will send from, and copy the Server API token.
2. **Secrets.** Store the token and a job key (never paste these into chat):
   ```
   printf '%s' 'PASTE_POSTMARK_TOKEN' | gcloud secrets create postmark-server-token --data-file=-
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create jobs-key --data-file=-
   ```
   Cloud Run's service account needs read access to both, as it has for the Stripe secrets.
3. **Connect them to the service.**
   ```
   gcloud run services update summitops-api --region us-east1 \
     --update-secrets=POSTMARK_SERVER_TOKEN=postmark-server-token:latest,JOBS_KEY=jobs-key:latest \
     --update-env-vars=MAIL_FROM=patrol@yourdomain.org,PUBLIC_URL=https://summitops-api-33271059248.us-east1.run.app
   ```
4. **Daily schedule** (7:30 am Eastern):
   ```
   gcloud scheduler jobs create http summitops-daily --location us-east1 --schedule "30 7 * * *" --time-zone "America/New_York" \
     --uri "https://summitops-api-33271059248.us-east1.run.app/api/v1/internal/jobs/daily" --http-method POST \
     --headers "x-jobs-key=$(gcloud secrets versions access latest --secret=jobs-key)"
   ```
   Check it with `gcloud scheduler jobs run summitops-daily --location us-east1`, then look at Patrol, Follow-up.
5. **In the app**: Patrol, Follow-up, Settings. Switch follow-up on, set the name shown on the email, a mailing address, who replies go to, and the gift amounts. Leave the tax note blank until your board or accountant gives you the wording.
6. **Stripe webhook**: the existing endpoint already receives `checkout.session.completed`, which is what records gifts.

Day to day: directors open Patrol, Follow-up to approve or skip held cases. Emails for non-serious approved cases go out on their own five days after the incident. A guest who taps "Stop these emails" is never emailed again by this mountain.

## Time clock kiosk

1. Run `npm run migrate` before deploying (adds kiosk tables and punch columns).
2. In the app: Staff and schedule, Time clock kiosk. Set a PIN for each person (a random one is shown once; hand it over privately).
3. Add a tablet, open the link or enter the code at `/kiosk` on the tablet in Chrome. Pin Chrome to that page, turn on the tablet's kiosk or screen-pinning mode and keep it plugged in. The camera needs HTTPS, which Cloud Run provides.
4. Print badges if wanted (Print all badges). Laminate; a USB barcode scanner or the tablet camera reads them.
5. Snapshots: before turning on, tell staff in writing that photos are taken and how long they are kept. Since nothing is matched to a face, biometric-privacy laws should not apply, but have counsel confirm for your state.
6. If a tablet is lost: Turn off or Remove it in the tablet list. If a PIN leaks: set a new one. If a badge is lost: Lost badge.
7. The kiosk needs a connection to punch; it shows "No connection" and does not queue punches.

## Reset a mountain's data

`node db/reset.js <slug>` shows what would be deleted. `node db/reset.js <slug> --yes` deletes it. It keeps the mountain and its owner login(s) and removes everything else for that mountain only. There is no undo, so take a database backup first if the data matters.

## Demo data

`node db/demo.js <slug>` fills a mountain with made-up staff, customers, products, rentals, lessons, sales, patrol cases and punches by using the app's own API. Run `node db/reset.js <slug> --yes` first for a clean start. It signs in with a temporary owner login that it deletes at the end, and it stops with a message if the mountain requires two-step sign-in.

## Patrol access levels
Upgrading needs `npm run migrate` (adds the access level column and the rules table; roster members are mapped from rank once). After deploying, sign in as the owner, open Patrol, then Access levels, and set anyone who should be Approver or Host. To undo someone's lockout, an owner or system manager can always open Access levels, since those logins are always Admin.

## Terrain park
Upgrading needs `npm run migrate` (creates park_areas, park_features, park_placements and park_inspections). Park crew sign in with the `staff` role; managers and owners can do everything. To make a past day editable for the crew there is no switch: a manager makes the change. `node db/reset.js <slug> --yes` also clears the park, and `node db/demo.js <slug>` loads 12 demo features placed for today.

## Upgrading to mountain operations
This release adds new tables (grooming, snow, weather, work orders, recurring jobs, inspections, downtime, handoffs). Run `npm run migrate` against the production database before or right after deploying. It is safe to run twice. Nothing existing is changed.
