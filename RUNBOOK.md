# Verdynt/OS runbook: security and operations

## Before real customers
1. **Database on Cloud SQL**: run `bash move-to-cloudsql.sh` once (see "Moving the database to Cloud SQL" below). The
   Cloud SQL login's password is made at random and kept in the `summitops-cloudsql-password` secret.
2. **Change the owner password** in the app (Settings > Change password) and turn on two-step sign-in for every owner and manager.
3. **Verify backups**: Cloud SQL, Backups shows a daily backup and point-in-time recovery on. Restore one into a throwaway instance once and check the data.
4. **Legal**: have a lawyer review the waiver text and privacy terms. Sign a BAA with Google Cloud before storing patrol patient/health data (see HIPAA.md).
5. **Card payments**: pick a processor (Square or Stripe) before taking live cards through a terminal. Until then card sales are recorded manually.

## Setting up a patrol on its own (Patrol only)

1. A patrol sign-up arrives in the console's Leads (kind Patrol).
2. Add the mountain in the console with the patrol's name and the director as owner, then under Billing choose the Patrol only plan with "apply apps", so only Patrol and Documents are on. The 14-day trial works as for any plan.
3. The director adds runs and lifts (Patrol, Admin, Patrol settings), imports the roster (Patrol, Team), and adds the ski area's read-only login (Account, Logins, role Ski area). That login is free.
4. If the ski area later buys a full plan, change the plan on the same mountain: the patrol keeps everything.

## Tiered sign-in (2026.10.17)

Who signs in how:

| Who | How | Extra checks |
| --- | --- | --- |
| Owners, managers, patrol Admins and Managers | Passkey, or password plus authenticator app (always, in production) | Second check before sensitive actions; new-device email |
| Patrollers | Passkey, or password plus app (on by default; existing mountains get two weeks, `tenants.patrol_mfa_from`) | Second check before releasing or exporting records |
| Counter, instructor, lift staff | Password, or a PIN on an enrolled shared terminal | New device: code by email (when they have one); access ends at season end |
| Console operators | Passkey only, once they have one (password plus code until then) | Open each mountain with a reason, up to 8 hours |

- **Passkeys** belong to the address they were made on. If the app moves to its own domain (for example from the run.app
  address to app.yourdomain.com), people add their passkey again. Set `WEBAUTHN_RP_ID=yourdomain.com` before people add
  passkeys so one passkey works on every address under that domain. `WEBAUTHN_ORIGINS` (comma-separated
  `https://...` addresses) pins which pages may use them; by default it is the address the request came to.
- **Second check** (`STEP_UP_MINUTES`, 10): refunds over `STEP_UP_REFUND_CENTS` (20000 = $200), changing a role,
  switching a login off, adding a manager, resetting someone's password or two-step, customer, waiver and patrol
  downloads, releasing a patient record, billing, turning off the two-step rules, removing a passkey, and enrolling or
  removing a terminal. Straight after a sign-in counts.
- **Shared terminals** end after `TERMINAL_IDLE_MINUTES` (15) unused. Removing one in Account signs out everyone on it.
  A lost or stolen terminal: remove it, nothing else to do.
- **Lost phone**: a manager presses Reset two-step on that login (it removes their passkeys and authenticator app); for a
  manager, the owner does it; for the owner, the console's Reset password with "clear two-step".
- **Patrollers who must not be forced yet**: the owner can turn the patrol rule off in Account (needs their second check).

## Security setup (once, after 2026.10.16)

From the unzipped folder in Cloud Shell, after `bash promote.sh`:

1. `bash scripts/harden.sh` gives the app its own service account (`summitops-run`) with only the roles it needs, moves
   every key still held as a plain setting (Stripe, Postmark, `JOBS_KEY` and the rest) into Secret Manager, makes a
   database login for the app (`summitops_app`) that can change rows but not tables, keeps the current login for
   migrations only (secret `summitops-db-migrator`, which the app cannot read), makes Cloud SQL refuse unencrypted
   connections and protects it from deletion, sends audit events to a log bucket kept 400 days, and redeploys.
   It is safe to run again. From then on `deploy.sh` migrates with the migration login and deploys as `summitops-run`.
2. `bash scripts/harden.sh --lock-audit` locks that log bucket so nobody can shorten or delete it. Cannot be undone.
3. `bash scripts/harden.sh --remove-editor` takes Editor away from the default compute account (builds keep working:
   it gets the build roles first). If a deploy then fails at the build step, the script prints the command to undo it.
4. Optional web firewall: `bash scripts/cloud-armor.sh www.yourdomain.com app.yourdomain.com` builds a load balancer
   with Cloud Armor (about $20 a month extra) and prints the address for your domains' A records. When the certificate
   is ACTIVE, `bash scripts/cloud-armor.sh --lock <same domains>` makes the attack rules block, lets only the load
   balancer reach the app and sends the daily job through it. Change the Stripe webhook address to your domain first.
   `bash scripts/cloud-armor.sh --unlock` opens the run.app address again if something goes wrong.

What changed in the app with this release:
- Sign-ins are sessions the server can end: signing out, an hour unused (`SESSION_IDLE_MINUTES`), a password change,
  a console password reset or closing a mountain ends them. Everyone signs in again once after the update.
- Owners and managers must use two-step sign-in in production (`REQUIRE_ADMIN_MFA=off` turns that off, not advised).
- A login is locked for 15 minutes after 10 wrong passwords in a row (`LOGIN_LOCK_AFTER`); a console password reset
  unlocks it. Passwords seen in data breaches are refused (Pwned Passwords; only five characters of the hash are sent;
  `PWNED_CHECK=off` skips it).
- The platform key stops working once any operator has two-step sign-in. `PLATFORM_KEY_SIGNIN=on` is the break-glass
  setting if every operator is locked out; set it back afterwards.
- Offline patrol notes on phones are sealed with a key made from `LINK_SECRET` and the person's login. Before rotating
  `LINK_SECRET`, make sure patrol phones have sent everything waiting, or those notes cannot be opened afterwards.
- Close mountain (console, Manage): paused now, deleted by the daily job after the window. The console's history of it is kept.
- The daily job also deletes website requests older than two years and sign-in records over a month old.
- Every push to GitHub runs `.github/workflows/ci.yml`: the tests, `npm audit` and CodeQL.

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

Cloud SQL backs up the database every day at 07:00 UTC, keeps 14 backups, and can restore to any moment in the last
week (point-in-time recovery). For a copy you hold yourself, once a month (or before a risky change):

```bash
gsutil mb -l us-east1 gs://summitops-510715-backups 2>/dev/null || true
gsutil iam ch "serviceAccount:$(gcloud sql instances describe summitops-db --format='value(serviceAccountEmailAddress)'):objectAdmin" gs://summitops-510715-backups
gcloud sql export sql summitops-db "gs://summitops-510715-backups/summitops-$(date +%F).sql.gz" --database=summitops
```

Test a restore into a scratch instance once a season.

## Moving the database to Cloud SQL

The database started on Aiven's free plan, which cannot choose a region; every query crossed the country and the demo
timed out. `move-to-cloudsql.sh` (run once, after deploying the release that contains it) creates a MySQL 8.4 server
`summitops-db` in us-east1 next to the app, copies every row from Aiven and checks each table's row count, switches the
app to it, and checks `/readyz`. If the app does not answer, it switches back to Aiven by itself. Aiven is left as it
was: keep it a week, then delete the service in the Aiven console. Anything changed in the app while the copy runs
(a few minutes) is not copied, so run it when nobody is using the app.

To give the database more room later: `gcloud sql instances patch summitops-db --tier=db-custom-1-3840` (one dedicated
CPU, 3.75 GB; a few minutes of downtime).

## Rotating keys

`JWT_SECRET` signs sign-ins. Until this release it also protected two-step secrets, unsubscribe links and staff badges,
so rotating it on its own would lock out everyone using two-step sign-in and break every printed badge. Now each has its
own setting. To rotate `JWT_SECRET` safely:

1. Set `TOTP_KEY`, `LINK_SECRET` and `KIOSK_SECRET` on Cloud Run to the **current** `JWT_SECRET` value (as secrets).
2. Deploy, and check two-step sign-in and a badge still work.
3. Now change `JWT_SECRET`. Everyone signs in again; nothing else changes.

Before changing `LINK_SECRET`, have patrol phones send any reports waiting offline (they are sealed with a key made from it).

## Platform console

The console (`/platform`) is for the people who run Verdynt/OS. Each **operator** signs in with their own email, password
and a code from an authenticator app; everything they do is in the Activity log under their name.

1. **First operator:** open `/platform`, choose "Sign in with the platform key instead" (the key is the
   `summitops-bootstrap` secret: `gcloud secrets versions access latest --secret=summitops-bootstrap`), then
   **Operators**, **Add an operator** with your own email, name and a password.
2. **Sign out**, then sign in with your email and password. The first time, it shows a QR code: scan it in your
   authenticator app and type the code. From then on you sign in with email, password and the app's code.
3. **More operators:** Operators, Add an operator. Give them their first password by phone or in person; they set up
   their app at their first sign-in and can change the password (Change my password).
4. **Lost phone:** another operator chooses **Reset two-step** on them (or use the platform key). **Leaving:** Switch off.
   Either ends their open sessions at once.
5. **Once your own login works, turn key sign-in off** so the key alone opens nothing:
   `gcloud run services update summitops-api --region us-east1 --update-env-vars PLATFORM_KEY_SIGNIN=off`.
   To get back in if every operator is locked out: `gcloud run services update summitops-api --region us-east1 --remove-env-vars PLATFORM_KEY_SIGNIN`,
   sign in with the key, fix it, and turn it off again.

Five wrong passwords or codes lock that login for 15 minutes; sign-in is also limited to 20 tries per address per 15 minutes.
Sessions last 2 hours. **Address allowlist (optional):** `PLATFORM_ALLOW_IPS` = comma-separated addresses allowed to use the console.
`PLATFORM_TOTP_SECRET` (an authenticator code for the platform key itself) still works if you keep key sign-in on.

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
4. In Verdynt/OS > Settings, tick "Guests pay by card when they reserve" and set the refund tiers.

How it behaves: reserving holds the place for about 30 minutes while the guest pays. A signed webhook from Stripe books the lesson and records an order (channel online, tender card, tax included). If the lesson filled up meanwhile, or the amount does not match, the payment is refunded in full automatically. Cancelling online refunds 100% / the partial percent / 0% by hours before the lesson, and the refund is sent to Stripe and recorded in the books.

Limits to know: all money goes to the one Stripe account whose key you set (several mountains each need their own account or Stripe Connect, which is not built). A refund you issue from Sell > Orders on a card sale is recorded in Verdynt/OS but is **not** sent to Stripe: issue it in the Stripe dashboard too. No confirmation emails are sent by Verdynt/OS (Stripe can email receipts from its settings). Have a lawyer review the cancellation policy and waiver wording.

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
