# Verdynt/OS runbook: security and operations

## Before real customers
1. **Database on Cloud SQL**: run `bash move-to-cloudsql.sh` once (see "Moving the database to Cloud SQL" below). The
   Cloud SQL login's password is made at random and kept in the `summitops-cloudsql-password` secret.
2. **Change the owner password** in the app (Settings > Change password) and turn on two-step sign-in for every owner and manager.
3. **Verify backups**: Cloud SQL, Backups shows a daily backup and point-in-time recovery on. Restore one into a throwaway instance once and check the data.
4. **Legal**: have a lawyer review the waiver text and privacy terms. Sign a BAA with Google Cloud before storing patrol patient/health data (see HIPAA.md).
5. **Card payments**: the owner connects the mountain's own Stripe account under Billing, and a manager pairs a Stripe smart reader for each counter (see "Online card payment (Stripe)" below).

## Setting up a patrol on its own (Patrol only)

1. A patrol sign-up arrives in the console's Leads (kind Patrol).
2. Add the mountain in the console with the patrol's name and the director as owner, then under Billing choose the Patrol only plan with "apply apps", so only Patrol and Documents are on. The 14-day trial works as for any plan.
3. The director adds runs and lifts (Patrol, Admin, Patrol settings), imports the roster (Patrol, Team), and adds the ski area's read-only login (Account, Logins, role Ski area). That login is free.
4. If the ski area later buys a full plan, change the plan on the same mountain: the patrol keeps everything.

## Setting up a ski school on its own (School only)

1. A school sign-up arrives in the console's Leads (kind School).
2. Add the mountain in the console with the ski school's name and the director as owner, then under Billing choose the School only plan with "apply apps", so only Ski school, Documents and Instructor availability are on. The 14-day trial works as for any plan.
3. The director sets up levels, skills and lesson products (Settings, Lessons) and lets instructors post their open dates (Availability), then adds the ski area's read-only login (Account, Logins, role Ski area). That login is free.
4. The read-only login's Summary shows the Patrol section when the mountain also has Patrol on, the Ski school section when it has Ski school on, or both.
5. If the ski school later buys Mountain or Resort, change the plan on the same mountain: everything it set up carries on.

## Setting up a municipality (municipal edition)

1. In the console, press Add a mountain and set Type to Municipality. The type cannot be changed later: a ski area that also wants the municipal apps (or the other way) needs a second tenant.
2. Give the borough, township or authority's name, its web name and time zone, and the borough manager (or public works director) as owner. The core apps are ticked for you: Assets and fleet, Staff and schedule, Documents, Messages and Resident requests. Tick any add-ons they bought (Water, Sewer, Stormwater, Trash and recycling, Buildings).
3. Under Billing, pick Public Works and its add-ons, yearly. Only municipal plans are offered for a municipality, and ski plans for a ski area.
4. The owner adds the crew (role Crew) and front desk (role Front desk) under Settings, Team and logins, imports the street list under Settings, Streets (paste one street per line), and connects Stripe under Settings, Payments for bulk pickup fees.

## Street alert texts for a municipality (which number sends)

Street notices, alert sign-up codes and welcome texts go through `src/lib/sms.js` on the one Twilio account that sends
every Verdynt/OS text (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`). Which number they come from:

- **By default, the shared number** (`TWILIO_FROM`, a number or a Messaging Service `MG...`). Nothing to set up per
  municipality. Its STOP and START replies already reach `POST /api/v1/twilio/sms` (the "A message comes in" webhook,
  see Text HELP set-up above and FEATURES.md): a STOP is written to every customer record and every municipality's alert
  list with that phone (`alert_addresses`), so no one texts it again; START lifts only a stop that came by text. Twilio
  itself also blocks the shared number from texting a phone after STOP, at every tenant.
- **A number of the municipality's own** (optional, when a borough wants its alerts to come from one number residents
  save). Buy a toll-free number on the same account, verify it the way Text HELP set-up steps 1 and 4 describe, with the
  municipality as the business, use case category "Public Service Announcement" (or Customer Care), and sample messages
  such as "Riverbend Borough: Water is off on Dayton Street for a water main repair. Details: https://<host>/alerts/<slug>/AB3CDE Reply STOP to stop texts."
  Opt-in: residents sign up on `/alerts/<slug>`, confirm with a texted code and get a welcome text saying how to stop.
  Set the number's (or its Messaging Service's) "A message comes in" webhook to `https://<PUBLIC_URL host>/api/v1/twilio/sms`,
  never `/api/v1/public/sms/inbound` (that is the patrol help line and would take a STOP as a call for help). Then a
  manager enters the number under Street notices, Settings, Texting number; the screen shows the webhook address too.
  Clear it to go back to the shared number.

Sending is in the background: a send writes one queued row per phone and email (`street_notice_deliveries`) and
answers at once; the server that took the request sends them six at a time, and the 5-minute guests job
(`/internal/jobs/guests`, `street_notices` in its answer) sends anything left and the scheduled notices that are due. A
row a stopped server left half-sent is marked failed after 15 minutes rather than sent again. Twilio's own rate for the
number applies on top (a toll-free number takes a few texts a second; a 2,000-resident notice takes some minutes).
Water, boil water, sewer and street closure notices go at any hour; the others wait for 8 AM (`src/lib/quiet.js`).

## The demo borough

`SEED_PASSWORD=<at least 12 characters> node db/demo-municipal.js demo-borough` makes Riverbend Borough (made up) with every municipal app on, free of charge, and prints the login (username `owner`; also `manager`, `crew1` to `crew4`, `frontdesk`, all with SEED_PASSWORD). Run it against the database you mean (DB_NAME). It is safe to run again: nothing is added twice. To start over, close and delete the tenant in the console, or use db/reset.js on a test database. Each municipal app adds its sample data in its own file in `db/demo-municipal/`.

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
  passkeys so one passkey works on every address under that domain. Passkeys work only on the address in
  `PUBLIC_URL`, plus any listed in `WEBAUTHN_ORIGINS` (comma-separated `https://...` addresses), never on the address a
  request happens to come to. So `PUBLIC_URL` must be the address people use, for example `https://app.yourdomain.com`,
  and any other address staff sign in on (the run.app address during a move, a second domain) must be listed in
  `WEBAUTHN_ORIGINS`. `scripts/settings-check.sh` (run by deploy.sh and promote.sh) warns when `PUBLIC_URL` is still a
  run.app address while `WEBAUTHN_RP_ID` is your own domain.
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
   database login for the app (`summitops_app`) that can change rows but not tables and can only read and add audit
   rows, keeps the current login for migrations only (secret `summitops-db-migrator`, which the app cannot read), makes
   Cloud SQL refuse unencrypted connections and protects it from deletion, sends audit events to a log bucket kept 400
   days, and redeploys. `promote.sh` refreshes that login's grants after each migration: it only adds grants for new
   tables (and takes away anything wrong, such as DELETE on the audit tables), so the live app never loses access.
   It is safe to run again. From then on `promote.sh` migrates with the migration login and deploys live as
   `summitops-run`. Staging never runs as `summitops-run`: `deploy.sh` deploys it as `summitops-staging`, which
   `scripts/staging-setup.sh` makes and which can read only the `summitops-staging-*` secrets (see DEPLOY.md, Staging).
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
- The key alone (no authenticator code) can list mountains and make recorded changes, but it cannot read a mountain or
  hand over access: resetting a mountain login's password or two-step, setting an operator's password, resetting their
  two-step, switching an operator back on and adding an operator all need two-step (2026.11.10). The one exception is
  adding the first operator, while no active operator has two-step. If every operator has lost their phone, set
  `PLATFORM_TOTP_SECRET` too and sign in with the key and a code from that secret: that counts as two-step.
- Offline patrol notes on phones are sealed with a key made from `LINK_SECRET` and the person's login. Before rotating
  `LINK_SECRET`, make sure patrol phones have sent everything waiting, or those notes cannot be opened afterwards.
- Close mountain (console, Manage): paused now, deleted by the daily job after the window. The console's history of it is kept.
- The daily job also deletes website requests older than two years, sign-in records over a month old, and forecast data snapshots older than three years. Morning briefs, and the record of who was sent them, go after 30 days (`bash scripts/brief-job.sh` sends them; DEPLOY.md, Morning brief).
- Every push to GitHub runs `.github/workflows/ci.yml`: the tests, `npm audit` and CodeQL.

## Keeping an eye on it (set up once)

Every failure is written to the logs as one line with `"severity":"ERROR"` and a `job` name (`email`, `sms`,
`stripe_webhook`, `card_refund`, `daily`, and the daily job stages). Each finished daily job writes `daily job finished`.

1. **Uptime check:** `bash scripts/uptime-setup.sh +1XXXXXXXXXX you@example.com` (2026.11.10): live `/readyz` every
   minute and the website's `/status`, with a text and an email when either is down. See DEPLOY.md, Uptime checks.
2. **Error alert:** Cloud console, Logging, Logs Explorer. Query:
   `resource.type="cloud_run_revision" AND jsonPayload.severity="ERROR"`. Choose Actions, Create log alert, notify by
   email, at most one email every 30 minutes.
3. **Daily job missed:** Logging, Log-based metrics, Create a counter metric named `daily_job_finished` for
   `jsonPayload.message="daily job finished"`. Then Monitoring, Alerting, Create policy on that metric: alert when it
   is absent for 26 hours.
4. **Give the daily job time to finish:** it can run for several minutes as mountains grow. `bash scripts/daily-job.sh`
   (below, Daily schedule) gives it `--attempt-deadline=900s`, and run again it sets that on a job made without it, in
   place. (`gcloud scheduler jobs update http` crashes in current gcloud, so the scripts change jobs through the Cloud
   Scheduler API instead, and never delete a job to make it again.)
5. **Budget:** Billing, Budgets and alerts, a monthly budget (for example $50) with email alerts.

## Security alerts

`bash scripts/security-alerts.sh` (run once from Cloud Shell, after `scripts/uptime-setup.sh`, and again after a release
that adds an alert). It makes a log-based metric and an alert policy for each item below, sent to the same text and email
channels. A new metric needs a few minutes before a policy can use it: if the script says "not yet", run it again 10
minutes later. Any other problem (a missing permission, for example) is marked FAILED with Google's message; the script
does the rest and then stops with an error, so fix what the message says and run it again. `--dry-run` lists what it
would run and changes nothing. Each alert's text points here.

| Alert | What it means | What to do |
| --- | --- | --- |
| Stripe webhook signature refused | Payment events with the wrong signature. | Check `STRIPE_WEBHOOK_SECRET` matches the Stripe dashboard. If it does, someone is sending fake events: nothing is changed by them. |
| Sign-in lockouts and too many attempts | Over 20 lockouts or "too many" answers on sign-in in 5 minutes. | Logs Explorer: `jsonPayload.action="sign_in_failed"` shows which logins and addresses. Tell the mountain if one login is the target. |
| Failed staff sign-ins | Over 30 failed staff sign-ins in 5 minutes (the `sign_in_failed` audit event). This catches a slow password spray across many logins, which never locks any one of them. | Same query. Many logins from one address: block it in Cloud Armor. Many addresses on one login: ask the person to add a passkey, and reset their password if they think it is known. |
| Platform console sign-in | Every console sign-in. | You should recognize each one. If not, turn the operator off in the console and rotate the console's keys (Rotating keys). |
| Failed console sign-ins | More than 2 failed console sign-ins in 15 minutes. | Someone is trying the console. Check the addresses (`jsonPayload.console=true`). Make sure every operator signs in with a passkey. |
| Data exports in bulk | More than 10 exports in an hour. | Check who exported (`jsonPayload.action=~"^export"`) and ask them why. |
| Server errors in a burst | Over 20 errors in 5 minutes. | Logs Explorer, `severity="ERROR"`, then the release notes for the last deploy. |
| A scheduled job call refused | A call to a job address was refused. | Check the scheduler job's credentials (DEPLOY.md, Scheduled jobs). |

The sign-in events in the outside copy (`summitops-audit`) are `sign_in`, `sign_in_failed`, `login_locked`, `codes_stopped`,
`new_device`, `password_reset_by_email`, `mfa_recovery_used`, `staff_password_reset`, `staff_mfa_reset`, `records_check` and
`session_resumed`, plus the usual audit rows for two-step and passkey changes. None holds a password, a code or what someone
typed as a username.

## Patient record access and resets (feat/auth-hardening)

- **Fresh check:** opening a case that is not the person's own recent work asks for their passkey or app code (or password,
  for someone with neither) once per 30 minutes. A help call "the case will not open" is usually this: tell them to use
  the big passkey button, or set up a passkey in Settings.
- **Quick resume:** patrol, the ski area login, owners and managers pause after 30 minutes without use; a passkey or app
  code carries on, within the 8 hours. Without either, they sign in again.
- **Who resets whom:** a manager cannot reset a manager (only the owner), or a patrol leader at Admin, Manager or Approver
  (only the owner or a patrol Admin on the roster). A patrol Admin who is not a manager resets patrol logins only. A login whose patrol
  level, role or staff link was lowered in the last 24 hours, or by the person asking, cannot be reset by them (the owner can).
- **When nobody at the mountain can reset a director:** the console resets owners, managers, patrol directors and patrol
  admins. Confirm it is them by phone first, and type how in "How you confirmed it is them" (kept in the mountain's history).
  The person gets an email.
- **Weekly access summary:** Monday mornings to the owner and patrol Admins. Only the owner turns it off (Patrol, Settings).

## Backups

Cloud SQL backs up the database every day at 07:00 UTC, keeps 14 backups, and can restore to any moment in the last
week (point-in-time recovery). `bash scripts/backups-setup.sh` checks all of that, turns on what is missing and adds a
weekly copy in Cloud Storage; RECOVERY.md has the restore steps and the drill. The copy is asked for by the
`summitops-backup` account, which has one custom role, `summitopsWeeklyExport` ("Verdynt/OS weekly database copy": ask
Cloud SQL for an export and read the server's details, nothing else). Cloud SQL Viewer no longer allows an export, and
the roles that do can change the server. For an extra copy before a risky change:

```bash
gsutil mb -l us-east1 gs://summitops-510715-backups 2>/dev/null || true
gsutil iam ch "serviceAccount:$(gcloud sql instances describe summitops-db --format='value(serviceAccountEmailAddress)'):objectAdmin" gs://summitops-510715-backups
gcloud sql export sql summitops-db "gs://summitops-510715-backups/summitops-$(date +%F).sql.gz" --database=summitops
```

Test a restore once a season: `bash scripts/restore-drill.sh` (RECOVERY.md, The drill).

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
4. **Lost phone:** another operator chooses **Reset two-step** on them (or use the platform key with a code, see above). **Leaving:** Switch off.
   Either ends their open sessions at once.
5. **Once your own login works, turn key sign-in off** so the key alone opens nothing:
   `gcloud run services update summitops-api --region us-east1 --update-env-vars PLATFORM_KEY_SIGNIN=off`.
   To get back in if every operator is locked out: `gcloud run services update summitops-api --region us-east1 --remove-env-vars PLATFORM_KEY_SIGNIN`,
   sign in with the key, fix it, and turn it off again.

Five wrong passwords or codes lock that login for 15 minutes; sign-in is also limited to 20 tries per address per 15 minutes.
Sessions last 2 hours. **Address allowlist (optional):** `PLATFORM_ALLOW_IPS` = comma-separated addresses allowed to use the console.
`PLATFORM_TOTP_SECRET` (an authenticator code for the platform key itself) still works if you keep key sign-in on.

## Plans, prices and season billing

Plans and add-ons are set in the console under **Plans and prices**; the website and the Billing page follow straight away.
After changing a price, press **Sync to Stripe** on that row: it makes the monthly, yearly and season prices in Stripe.

- **Season billing** is the yearly price in six monthly payments, November to April. The daily job pauses Stripe's
  collection on those subscriptions from May to October (Stripe resumes it on November 1 by itself), and a mountain that
  signs up in the summer pays nothing until November 1. Nothing to set up: it runs with the daily job.
- **Guided setup** is priced on the website (Pricing, Getting set up): $750 Lodge, $1,500 Mountain, $3,000 Resort,
  $500 Patrol only, $600 School only, and $1,200 a day on site plus travel. Requests arrive in Leads as "Guided setup".
  Bill it as a one-off Stripe invoice to the mountain's customer once they choose a plan.
- The October 2026 review moved Resort to include Assets and fleet and Messages, and the Patrol add-on to $149 a month
  ($1,500 a year), the same as Patrol only. The migration changed them only where they were still the launch values.

## Prospect outreach (platform console, Prospects, Outreach)

Outreach emails go from your own Google Workspace mailbox, never through Postmark (Postmark carries the mountains' email and does not allow cold outreach). Use a separate domain for it, so runmyresort.com's reputation is never at risk.

1. **Workspace**: buy a second domain (for example verdynt-mail.com), set up Google Workspace on it with one mailbox, and turn on SPF, DKIM and DMARC in Workspace (Admin, Apps, Gmail, Authenticate email). Send normal mail from it for a week or two before outreach starts.
2. **Connect it**: in Cloud Shell, from the unzipped folder: `bash scripts/outreach-setup.sh you@your-outreach-domain.com`. It makes the service account and key, connects the live service (staging never sends outreach) and adds the `summitops-outreach` Cloud Scheduler job (every 30 minutes, weekdays 8 to 5 Eastern).
3. **Authorize it** in Google Workspace Admin: Security, Access and data control, API controls, Manage domain-wide delegation, Add new, with the client ID the script prints and the scopes `https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly`.
4. **In the console**: Prospects, Outreach, Settings. Your name, company line and a postal address (required in every commercial email), the sending hours and the daily cap. Then Send a test to me.
5. **APP_URL** must be set on the live service: the "not interested" link in every email points at it (`/o/...`).

Day to day: on a prospect, People, Start outreach drafts the first email (by the assistant when it is on). Approve it under Outreach. Follow-ups go on days 7, 16, 30 and 45 as replies in the same thread, then an update every 90 days. A reply, a bounce, "not interested" or moving the prospect to In conversation or later stops it. Not interested and bounced addresses are never emailed again.

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
2. **Secrets.** Store the token (never paste it into chat, or on a command line, where the shell history keeps it).
   `read -s` asks for it without showing it or saving it:
   ```
   read -r -s -p "Postmark server token: " T; printf '%s' "$T" | gcloud secrets create postmark-server-token --data-file=-; unset T
   ```
   Cloud Run's service account needs read access to it, as it has for the Stripe secrets.
3. **Connect it to the service.**
   ```
   gcloud run services update summitops-api --region us-east1 \
     --update-secrets=POSTMARK_SERVER_TOKEN=postmark-server-token:latest \
     --update-env-vars=MAIL_FROM=patrol@yourdomain.org,PUBLIC_URL=https://app.yourdomain.org
   ```
   `PUBLIC_URL` is the address people use, for example `https://app.yourdomain.org`: links in emails use it, and
   passkeys work only on it and on the addresses in `WEBAUTHN_ORIGINS`. If staff still use the run.app address too, add
   it to `WEBAUTHN_ORIGINS`. Before the app has its own domain, the run.app address is the address people use, so it is
   right there.
4. **Daily schedule** (7:30 am Eastern). The job signs its call with a Google ID token for the summitops-jobs account
   (2026.11.11): no key is stored in Cloud Scheduler. Run:
   ```
   bash scripts/daily-job.sh
   ```
   It makes the jobs account if needed, tells the app to accept it, and makes the job (or sets an existing one right).
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

`node db/demo.js <slug>` fills a mountain with made-up staff, customers, products, rentals, lessons, sales, patrol cases and punches by using the app's own API. It runs after `node db/seed.js` (it uses the seed's lifts, runs, products, certifications and positions) and is safe to run again: anything already there is kept and not added a second time. The ski school gets four instructors with certifications, teaching profiles and pay rates, lessons for kids and adults on each of the next 7 days, and a six-week Saturday program. Staff get 6-digit kiosk PINs, and patrollers get a published patrol schedule for the week. Run `node db/reset.js <slug> --yes` first for a clean start. It signs in with a temporary owner login that it deletes at the end, and it stops with a message if the mountain requires two-step sign-in.

## Patrol access levels
Upgrading needs `npm run migrate` (adds the access level column and the rules table; roster members are mapped from rank once). After deploying, sign in as the owner, open Patrol, then Access levels, and set anyone who should be Approver or Host. To undo someone's lockout, an owner or system manager can always open Access levels, since those logins are always Admin.

## Guest help page (help/guest)
- Turn it on per mountain under Patrol, Dispatch, Guest help page. The patrol phone (guests see Call patrol) and the help number (Send by text instead, answered by Text HELP, and printed on the sign sheets) are set in one place: Settings, Patrol, Patrol settings, Text HELP. The patrol phone can be set without a help number. Without a help number the page shows no text option when it cannot reach us; it keeps trying and Call 911 stays on screen.
- QR codes on signs: `/help/<mountain>?c=<sign code>` once help/places has mapped the signs, or `?loc=<place name>` until then.
- The status page's limits per request: `HELP_ANSWER_LIMIT` (60 answers in 10 minutes), `HELP_POSITION_LIMIT` (6 positions a minute), `HELP_MESSAGE_LIMIT` (20 replies in 10 minutes), `HELP_PASS_LIMIT` (3 pass lookups in 10 minutes) and `HELP_PASS_IP_LIMIT` (10 an hour per address). Leave them as they are in production. A request itself is never refused.
- A guest who says the page is stuck: they can call patrol or 911 from it at any time. Check the call on the board; their messages and answers are in the call's From the guest section.
- Set the patrol phone. When a new request reaches no one on duty (nobody signed in, or no phone took the alert), the call shows a red "No one on duty was alerted" banner on the board, and owners, managers (push) and the patrol phone (text) get one summary per mountain a minute at most (`HELP_NOBODY_GAP_S`), with at most 20 patrol phone texts an hour (`HELP_NOBODY_TEXT_HOURLY_CAP`). A lost child is sent at once. Without a patrol phone or texts set up, only the push and the banner happen.
- Requests grouped into a flood alert patrol at most once per flood every 30 seconds (`HELP_FLOOD_ALERT_GAP_S`, leave it in production). A lost child always alerts at once.
- Held alerts (the next flood push, the summary) are saved and go out from the process's timer, the next board load or guest request at that mountain, or the 5-minute guests job (`summitops-guests`), once each. Worst case when the timer is lost: the gap plus 5 minutes. Keep the guests job running.
- Upgrading needs `npm run migrate` (adds `dispatch_calls.same_phone_of`, `dispatch_alert_state` and `dispatch_calls.flood_pending_at`).

## Terrain park
Upgrading needs `npm run migrate` (creates park_areas, park_features, park_placements and park_inspections). Park crew sign in with the `staff` role; managers and owners can do everything. To make a past day editable for the crew there is no switch: a manager makes the change. `node db/reset.js <slug> --yes` also clears the park, and `node db/demo.js <slug>` loads 12 demo features placed for today.

## Upgrading to mountain operations
This release adds new tables (grooming, snow, weather, work orders, recurring jobs, inspections, downtime, handoffs). Run `npm run migrate` against the production database before or right after deploying. It is safe to run twice. Nothing existing is changed.

## Text HELP set-up (once per mountain)

Guests text HELP, PATROL or AYUDA to the mountain's help number and reach patrol (FEATURES.md, Text HELP). All mountains use
the one Twilio account that already sends Verdynt/OS texts (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`). Each mountain gets
its own number. Plan a week per mountain, start to finish, most of it waiting for Twilio's review.

**Which number: toll-free, with toll-free verification.** It is the faster and simpler path:

| | Toll-free with verification (use this) | Local 10DLC number |
| --- | --- | --- |
| Registration | One form per number, for the mountain as the business | A customer profile and a brand for each mountain, then a campaign |
| Typical time | Twilio reviews within about 3 business days | Profile 72 hours or more; brand minutes, or 7+ business days if reviewed by hand; campaign 5 to 10 days. About 1 to 3 weeks. |
| Before approval | Texts in reach patrol; replies are blocked (error 30032) | Texts in reach patrol; replies are blocked (error 30034) |

Verdynt/OS sends for many mountains, so under 10DLC each mountain must be its own brand under a secondary customer
profile. Use 10DLC only if a mountain insists on a local area code.

Sources: Twilio, [Toll-free verification](https://www.twilio.com/docs/messaging/compliance/toll-free) and the
[Jan 31, 2024 change blocking pending toll-free numbers](https://twilio.com/en-us/changelog/messaging-on-u-s--toll-free-phone-numbers-pending-verification-i);
[ISV A2P 10DLC registration guide](https://support.twilio.com/hc/en-us/articles/53502193289755-ISV-A2P-10DLC-Registration-Guide)
and [ISV onboarding](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv);
[error 30034](https://www.twilio.com/docs/api/errors/30034);
[campaign use case types](https://support.twilio.com/hc/en-us/articles/1260801844470-List-of-campaign-use-case-types-for-A2P-10DLC-registration).

**How Twilio treats the word HELP.** HELP and INFO are carrier keywords. A text that is only that one word (any other
word in it, as in "HELP R7", makes it an ordinary text) gets Twilio's own reply, "Reply STOP to unsubscribe. Msg&Data
Rates May Apply.", and by default Twilio does **not** forward it to our webhook, so no call would be made. With Advanced
Opt-Out turned on for the number's Messaging Service, Twilio forwards it (with `OptOutType=HELP`), and its HELP reply text
can be changed. The HELP keyword itself cannot be removed. Verdynt/OS makes the call and sends its own reply with the
location link, so a guest who texts just HELP gets two texts: Twilio's, then ours. Twilio's guide advises against a
second reply but does not block it: check it in step 7. A phone that has texted STOP gets no HELP reply from Twilio.
Sources: [Twilio support for opt-out keywords](https://support.twilio.com/hc/en-us/articles/223134027-Twilio-Support-for-Opt-out-Keywords-SMS-STOP-Filtering),
[Advanced Opt-Out](https://www.twilio.com/docs/messaging/services/tutorials/advanced-opt-out),
[Getting started with Advanced Opt-Out](https://support.twilio.com/hc/en-us/articles/360034798533),
[OptOutType](https://support.twilio.com/hc/en-us/articles/31560110671259-How-to-Track-Opt-Out-Opt-In-and-Help-Messages-Using-the-OptOutType-Parameter).

### 1. Buy the number
Twilio console, Phone Numbers, Manage, Buy a number. Country United States, type Toll-free, with SMS and MMS. Write the
number down as +18xx... for step 5.

### 2. Make a Messaging Service for the mountain and point it at Verdynt/OS
Messaging, Services, Create Messaging Service. Name it "<Mountain> Text HELP". Add the number to its Sender Pool.
Under Integration choose **Send a webhook**:
- Request URL: `https://<PUBLIC_URL host>/api/v1/public/sms/inbound`, HTTP POST. It must be exactly `PUBLIC_URL` plus
  that path (https, the same host, no trailing slash). Verdynt/OS checks Twilio's signature over that exact address
  and refuses anything else with 403. Patrol settings, Text HELP, "For whoever sets up Twilio" shows the address.
- Fallback URL: the same address. A text Twilio sends twice is taken once.
Use one service per mountain: the HELP reply text in step 3 belongs to the service, so it can name the mountain.

### 3. Advanced Opt-Out and the HELP reply
In the service, open the **Opt-Out** tab and turn on Advanced Opt-Out. Keep the STOP and START keywords as they are.
Edit the Help section: keep HELP and INFO, and set the reply to:

> <Mountain> ski patrol has your message. If it is life threatening, call 911. Patrol will text you a link to send your location. Reply STOP to stop texts.

Save. In the Opt-In section, add AYUDA and PATROL as opt-in keywords, so a guest who texted STOP and then texts only
AYUDA or PATROL can get replies again. Twilio forwards an opt-in keyword to Verdynt/OS (`OptOutType=START`), which still
makes or joins the call. HELP cannot be added: Twilio reserves "help" as a Help keyword that cannot be removed, and only
"start" and "unstop" are reserved opt-in keywords
([Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out)). So a guest who texted STOP
gets no replies after HELP until they text START (or AYUDA or PATROL alone); their texts still reach dispatch, and the
call says to call them. STOP still works as before: Twilio stops all texts from the number to that phone, and
Verdynt/OS records it so it never tries; START undoes both.

### 4. Register the number (toll-free verification)
Submit toll-free verification for the number (the number's page in the console, or Regulatory compliance, Toll-free
verification). The business is the mountain: its legal name, address, website and a contact there. Then:
- Use case category: Customer Care. Monthly volume: the lowest band (a few hundred texts a season is typical).
- Use case description: "<Mountain> ski patrol help line. Guests on the mountain text us to ask ski patrol for help.
  Patrol dispatch replies with safety instructions, a link to share their location, and updates about their request.
  Customer care only. No marketing."
- Opt-in type: Via Text. Opt-in description (message flow): "Every conversation starts with the guest. They text HELP,
  PATROL or AYUDA to the number printed on the <Mountain> trail map, ticket backs and lift tower signs: 'Need ski patrol?
  Text HELP to <number>.' We reply only to a guest who texted us, only about their request, and stop when the request is
  closed. Reply STOP to stop texts." Opt-in image: a photo or PDF of the trail map or ticket back showing that line.
- Sample messages:
  1. "<Mountain> ski patrol has your message. If it is life threatening, call 911. Tap this link to send your location: https://<PUBLIC_URL host>/locate/3f9c2a7d. Or reply with the code on the nearest sign or lift tower."
  2. "<Mountain> ski patrol: a patroller is on the way. Stay where you are."
  3. "Patrol has closed your request. Reply HELP if you need patrol again."

Twilio reviews within about 3 business days. Until it is approved, guests' texts still reach the board but no reply
goes out. If a mountain must use 10DLC instead: a secondary customer profile and a Standard brand for the mountain, then
a campaign with use case **Customer Care** (or Low-volume mixed for a small mountain), the same description, sample
messages and opt-in text, on the step 2 Messaging Service. Do not choose Emergency Services: carriers treat it as a
special use case with extra requirements.

### 5. Enter the number in Verdynt/OS
Sign in as the mountain's owner or patrol director: Settings, Patrol, Patrol settings, Text HELP. Enter the help number,
and the patrol phone if guests may call patrol (the guest help page shows it as Call patrol, and it is added to the first
reply). Save. The sign sheets and the guest help page read the same two numbers. Each number can belong to one
mountain only. Give the mountain the line for its trail map and ticket back from the same panel.

### 6. Photos
Twilio keeps each photo a guest texts and requires the account's key to open it. Verdynt/OS keeps only the address and
fetches the photo when a signed-in patroller opens it ([Media resource](https://www.twilio.com/docs/messaging/api/media-resource.md)).
Twilio keeps the photo until it is deleted in Twilio.

### 7. Test it
From a phone that is not a staff phone:
1. Text `HELP`. Expect Twilio's HELP reply and Verdynt/OS's reply with the location link. The board shows a New call,
   Text HELP. If only Twilio's reply arrives, check step 3 and the Twilio debugger.
2. Text a sign code (`R7`) and then a photo. The call's place changes and Photo 1 opens.
3. Reply from the call's Messages. It arrives from the help number.
4. Close the call. The closing text arrives.
5. Text `STOP` (Twilio confirms), check the call's timeline says so, then text `START`.
6. Text `AYUDA` from a new phone: the reply is in Spanish.
If Twilio's debugger shows error 11200 with a 403, the Request URL is not exactly `PUBLIC_URL` plus the path, or
`TWILIO_AUTH_TOKEN` is not this account's current token. Error 30032 means the toll-free number is not verified yet.

Limits (Cloud Run settings, rarely changed): `HELP_SMS_CALL_CAP` (texts out per call, default 20) and
`HELP_SMS_HOURLY_CAP` (texts out per mountain per hour, default 300). Past either, the call's timeline says to call the guest.
