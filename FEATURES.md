# SummitOps features

What each part of the app does and the rules it enforces, grouped by area. For running the app see [README.md](README.md); for deploying see [DEPLOY.md](DEPLOY.md); for security and operations see [RUNBOOK.md](RUNBOOK.md).

## How the platform works

### How tenancy and access work

- Every business table has `tenant_id`, and every foreign key includes it, so a row cannot reference another mountain's data even by mistake.
- `tenant_id` is read only from the signed JWT, never from the URL or body. Every query filters on it.
- Roles: `owner`, `manager`, `counter`, `instructor`, `patrol`, `staff`. Owner can do everything; each route lists who else may use it. Only the owner can create managers.
- The one unauthenticated read is `GET /api/v1/public/:slug/conditions` (operating status, lifts, trails, upcoming events). It exposes no people, prices, or notes beyond the public day note.
- Pricing is always computed on the server. Clients never send prices.
- Sessions are checked against the database on every request, so deactivating a login, changing its role, or changing its password takes effect immediately, not when the token expires. Changing or resetting a password signs out every other session.
- A `staff` login is linked to one staff record (`users.staff_id`). Non-managers can only clock in, set availability and view certifications for that record, and a login without a link cannot clock in.
- Sensitive reads (patrol incidents) and all writes are recorded in `audit_log`.

### Keeping mountains apart

Every mountain's data carries its `tenant_id`, and the signed-in mountain comes only from the login token. `test/tenant-isolation.test.js` proves it: it fills one mountain with demo data, signs in as a second mountain, and calls every signed-in endpoint with the first mountain's ids. It fails if anything of the first mountain comes back, changes, or gets linked to the second. It also checks that a leak would be caught. Run it after adding any new endpoint (`npm test` includes it). It reads the route files itself, so new endpoints are covered automatically; if you add a new route file, add it to the `MOUNTS` list at the top of the test.

### The platform console

Open `https://<your-service-address>/platform` and enter the platform key (the `BOOTSTRAP_KEY` setting; it is kept only in that browser tab). From there you can:

- **Add a mountain**: name, web name, owner login, document storage limit, and which apps it starts with.
- **Turn apps on and off per mountain**: Sell, Products and prices, Gate, Lifts and trails, Terrain park, Rentals, Ski school, Clubs and programs, Instructor availability, Patrol, Documents, Money, and Staff and schedule, plus the paid add-on **Document text recognition**, which starts off for every mountain. An app that is off disappears from the menu for everyone at that mountain (owner included), its requests are refused, and its public pages answer "not found". Nothing is deleted, so turning it back on restores everything. Sell needs Products and prices, so the console turns them on and off together. The home page, customers, account pages and the daily summary are always on. Changes show within about 10 seconds.
- **Pause a mountain**: everyone is signed out, nobody can sign in, and its public pages stop. Resume at any time.
- **Set the document storage limit** (default 500 MB). Uploads past the limit are refused with a clear message; the mountain sees its usage on the Documents screen.
- **Reset an owner or manager password** (and turn off their two-step sign-in if the phone was lost). That person is signed out everywhere.
- **See recent activity**: every change made in the console is logged.

A mountain that has never been touched in the console has every app on. The console is not tied to any mountain's logins: a mountain owner's token cannot open it. Use a long random `BOOTSTRAP_KEY`.

### Try-it demo

Visitors can start their own demo at `/try`: they enter a name and email, and about 20 seconds later they are signed in to a private demo mountain with every app on and made-up lifts, tickets, lessons, patrol cases, staff and documents. It is a real mountain (named `try-xxxxxxxxxx`) built by the same loader as `node db/demo.js`.

- **Expires:** after `SANDBOX_DAYS` days (default 7). A finished demo cannot sign in. It is removed with every row it owns the next time anyone starts a demo, or when you run the purge (below). The sign-up row stays, so `/platform` > **Demo sign-ups** is your list of leads.
- **Safe:** a demo can never send email or take a card payment, has a 25 MB document limit, and is hidden from the main mountain list in `/platform`. Starting again with the same email replaces that person's old demo.
- **Limits:** 5 demos per address per hour (`SANDBOX_RATE_LIMIT`), at most 40 running at once (`SANDBOX_MAX_ACTIVE`), and at most 3 being built at the same moment. A hidden form field turns away simple bots.
- **Link back to your website:** set `MARKETING_URL` (for example `https://summitops.example/contact`) and the tag inside a demo ("Demo mountain. 6 days left.") shows an "Ask for a walkthrough" link to it.
- **Daily cleanup (optional):** `POST /api/v1/platform/sandboxes/purge` with the `X-Platform-Key` header removes finished demos. Run it from Cloud Scheduler once a day.
- This release adds a column and a table, so run `npm run migrate` when upgrading. `test/sandbox.test.js` covers sign-up, expiry, full removal, the limits and the email block.

### Menu

The side menu has Today at the top and five groups (Front desk, Mountain, Safety, Programs, Office), each with its own accent colour. Groups fold open and shut (remembered per browser; all start folded on a first visit and a page unfolds its own group), and the menu collapses to icons only. Account, My shifts, Help and Sign out sit behind one account button at the bottom. Every page title shows its group's icon, name and colour, and section tabs underline in that colour. Patrol is its own group so it can be offered separately. Press Ctrl+K (Cmd+K on Mac) or "/" to jump to any page by typing; the palette also lists recent pages. On phones the menu becomes a bottom bar with a "More" sheet. Code: `public/js/nav.js`, `public/js/icons.js`.

### In-app help
**Help** is in the side menu under your name, and a **Help with this page** link sits under every page title. It holds short how-to articles for each app: numbered steps, a few tips and related articles, with a search box that looks through titles and text.
- People see only the topics their role can use, for apps their mountain has turned on. A mountain without Rentals has no Rentals help.
- The articles are plain data in `public/js/help-content.js` (a section per app, then articles with `steps`, `tips` and `related`). To add or change one, edit that file; `test/help.test.js` checks that ids are unique, links point at real articles and every section is a real screen.
- No server or database changes.

### API overview (`/api/v1`)

| Area | Endpoints |
| --- | --- |
| Platform | `POST /tenants` (needs `x-bootstrap-key`), `POST /auth/login`, `GET /auth/me`, `POST /users` |
| Customers (shared record) | `/people` list/search `?q=` (name, email, phone), create, patch; `GET /people/:id/activity` (orders, tickets, lessons, rentals, programs, waivers, lifetime spend); `GET /people/export.csv[?marketing=1]` (managers); `POST /people/:id/waivers`; `GET /people/:id/progress`. `GET /crm/form` (fields, which are mandatory), `PUT /crm/form-config` (managers). |
| Products and pricing | `/products` CRUD, `PUT /products/:id/tiers`, `PUT /products/:id/calendar` (date prices and blackouts), `/pricing/promos`, `POST /pricing/quote` |
| Ticketing | `POST /orders` (send `person_id` and/or a `purchaser` object; the purchaser is matched or created in the customer record), `GET /orders`, `GET /orders/:id`, `POST /orders/:id/refund`, `POST /tickets/scan` |
| Rentals | `/rentals/items` CRUD, `POST /rentals/contracts` (checkout), `POST /rentals/contracts/:id/checkin`, `GET /rentals/contracts?overdue=true` |
| Schedule | `PUT /schedule/days/:date`, `/schedule/lifts`, `/schedule/trails`, `/schedule/events`, public conditions feed |
| Workforce | `/workforce/positions`, `/workforce/certifications`, `PUT /workforce/positions/:id/requirements`, `/workforce/staff`, `PUT /workforce/staff/:id/certifications`, `GET /workforce/certifications-expiring`, `PUT /workforce/staff/:id/availability`, `/workforce/shifts` (+ `/assign`, `/publish`), `/workforce/time/*`, `GET /workforce/staffing-suggestion` |
| Ski school | `/skischool/sessions`, `POST /skischool/sessions/:id/bookings` (send `person_id` or a `student` object, optional `sign_waiver`), `GET /skischool/sessions/:id/roster`, `POST /skischool/progress` |
| Patrol cases | `/patrol/incidents` (patient care reports: patients, vitals, injuries, treatments, timeline, responders, witnesses, signatures; `submit`, `approve`, `reopen`), `/patrol/incidents.csv`, `/patrol/patients.csv`, `/patrol/analytics` (per 1000 visits), `/patrol/trail-checks` |
| Incident form (NSAAR) | `GET /patrol/form` (every field, options, which are mandatory), `PUT /patrol/form-config` (manager or patrol director: choose mandatory fields, set the resort's legal name). Case and patient records take a `form` object. `submit` and `approve` answer 409 with `details`: a list of `{ message, scope, section, field, patient_id }` (or `{ message, area }` for the summary, patients, responders or signatures) so the screen can link each missing item to its field. |
| Patrol dispatch | `/patrol/dispatch` (board, `available` patrollers, `:id/events` timeline, `:id/responders`, `:id/case`), `/patrol/guest-help` (manager switch) |
| Patrol team | `/patrol/team`, `/patrol/stations`, `/patrol/deployments/:date`, `/patrol/equipment` (+ `checks`, `clear`), `/patrol/training`, `/patrol/competencies`, `/patrol/passport` |
| Guest help (public) | `GET/POST /public/:slug/help`, and the page `/help/:slug` (QR codes on trail signs; `?loc=Ridge+Run` pre-fills the place) |
| Programs | `/programs` CRUD, `POST /programs/:id/enrollments` (waitlist when full), `.../withdraw` (auto-promotes), `/programs/:id/sessions`, `PUT /programs/sessions/:sessionId/attendance` |
| Reports | `GET /reports/daily` |

### Business rules enforced by the code

- **Price precedence:** date+tier override, then date override for all tiers, then tier price, then base price. A blackout blocks the sale.
- **Scans:** log every scan with a result (`ok`, `expired`, `not_yet_valid`, `void`, `no_uses`, `unknown`). Punch cards decrement.
- **Refunds:** void unused tickets; refused if any ticket on the order was already scanned.
- **Rentals:** items are locked and checked in one transaction (no double checkout); a signed waiver for the current season is required; damaged items go to maintenance.
- **Shifts and lessons:** staff must be active, hold every required certification (unexpired on the day), have no overlapping shift or lesson, and fit declared availability (managers can override availability only, never certifications).
- **Capacity:** lesson classes and programs are enforced under row locks. Full programs waitlist, and a withdrawal promotes the next person.

### Safe against double taps

The database itself refuses a second open till drawer or a second open clock-in for the same person, drawer moves are locked against closing, a cancelled lesson booking cannot be revived into a full lesson, and a transaction that loses a lock collision is retried automatically. `test/races.test.js` fires bursts of simultaneous requests to prove it.

## Customers

### The shared customer record

`people` is the one customer table every module points at: tickets and orders (`orders.person_id` is the purchaser), lesson bookings, rentals, programs, waivers, and patrol patients (patrol sees name, phone, email and date of birth only). It holds name, email, phone, date of birth, postal address, emergency contact, ski or snowboard and ability, and email consent (with the time it was given).

- **Capture:** the sell screen and the lesson roster show the same customer form. Choosing an existing customer fills it in so the clerk can confirm or correct it.
- **Matching:** with no customer chosen, a purchaser is matched by email, or by name plus date of birth. A match is reused and only its blanks are filled; nothing already on file is overwritten and consent is never withdrawn by a match. No match creates a customer. Without an email or date of birth, the same person can be recorded twice.
- **Mandatory details:** a manager chooses, separately for ticket sales and lesson bookings, which details are required, and can require a purchaser on every sale (`customer_form_config`). Names are always required once someone is recorded. With nothing chosen, only names are required.
- **Consent:** the email box is never ticked by default and cannot be made mandatory. `GET /people/export.csv?marketing=1` lists only customers who agreed.
- **Consent history (release 1):** every change is a row in `consent_events` (email or text, agreed or opted out, how, who, when); `people.marketing_opt_in` follows the latest email row. Existing consent was carried over once as source "earlier record". `GET/POST /people/:id/consent`.
- **Alerts and notes:** `person_flags` (do not rent, unpaid balance, medical alert, VIP, banned, note; optional end date; managers set and clear) show in the customer record and in the customer picker. Patrol sees medical alerts only. `person_notes` are dated, with author; the old single note was carried over as the first entry. They warn staff; they do not block a sale or rental.
- **Privacy:** `GET /people/:id/data-export` (manager, audited) downloads one person's data; `POST /people/:id/anonymise` (manager, audited) removes identity and keeps sales, tickets, rentals, signed waivers and the consent history. Merge and anonymise leave a `person_tombstones` row. Blocked for staff, sign-in holders and gear still out.
- **Data quality:** `GET /people/quality` (manager) counts what is missing; `GET /people/scores` gives each listed customer a completeness percent. Code: `src/routes/customerplus.js`, `src/lib/consent.js`, `db/customers.sql`. Not built yet: retention setting, tags and saved groups, households, organisations (see the Customer Record Gap Review).

### Finding a customer, and the patrol pull

- Every screen that asks "who is this?" uses one search box: type a name, a phone number or an email. `GET /people/lookup?q=` returns the best
  matches ranked (an exact email or phone first). Phone numbers match on their last 10 digits, so formatting does not matter
  (`people.phone_key`, added by `npm run migrate`). Front-desk roles also see whether a waiver is on file, what is valid today, and whether gear is out.
- A sale or booking that arrives with a name and phone number now reuses the existing customer instead of creating a duplicate
  (matching: email, then name + date of birth, then name + phone).
- Patrol: `GET /patrol/pull/:personId?incident_id=` previews a guest's details, the ticket valid on the incident day and the gear
  rented that day. Adding a patient from a guest (`person_id`), or `POST /patrol/incidents/:id/patients/:pid/pull`, copies those into the
  patient record, filling blanks only. It is read-only toward customers, tickets and rentals.
- `GET /patrol/access-log` (patrol administrators): who opened, changed, searched for, pulled or exported patient information.
- Safeguards for patient data, and what the mountain still has to do, are in `HIPAA.md`.
- Behaviour changes: patrol has no browsable Customers screen (search only); the incident CSV no longer includes the free-text
  summary; the default sign-in lifetime is 8 hours (was 12); the screen signs out after 15 idle minutes; API responses are `no-store`.

### Every item is for a named person

- Every ticket, lesson, rental and program place is sold to a named person, and the customer (the payer) is always required. A ticket line with quantity 2 becomes two tickets, each with its own holder (`holders: ["customer", "p1"]` on the line, keys into `participants`). The receipt and order details show who each ticket is for.
- Rule for everyone sold something: first name, last name, date of birth and sex. Adults (18 or over, or no date of birth entered) also need a phone number or an email, plus anything the mountain made mandatory under Mandatory details. Under 18s do not need a phone or email, even if the mountain made them mandatory.
- `people.sex` (female, male, other) is new, appears on the Customers screen and in the customer CSV, and fills patrol patient sex when it is still unknown.
- Gift cards are named by the purchaser (the customer).
- The old ticket-only `POST /orders`, the School screen and the Programs screen keep their older, lighter rules.
- Daily report, Sold today and the patrol gear pull now use the mountain's local day, so a sale made after 8 pm Eastern lands on the right day. Migration adds 1 change (`people.sex`).

## Selling and money

### Sell: one menu, one basket

The Sell screen sells tickets, lessons, rental packages, program places and gift cards from one menu. Staff build a basket, then add the customer, then take payment.

- `GET /checkout/menu` lists what can be sold today. `POST /checkout/quote` prices a basket. `POST /checkout` sells it in one transaction (order, tickets, lesson bookings, rental contracts, program enrollments, gift cards, payments). Prices always come from the server.
- Rentals are sold as products of kind `rental` (for example "Adult ski package", created in the Catalog). Gear is chosen at checkout. Without such a product the Rentals tab is empty.
- Lessons appear when sessions are scheduled in the next 14 days. A full program cannot be added from the basket (no waitlist there).
- Gift cards have a code and a balance, any amount from $5 to $1,000. They can be used as payment (`GET /gift-cards/:code` to check a balance). They cannot buy gift cards, and promo codes do not discount them.
- Payments are recorded by tender: cash (with change due), card, gift card, other. Split payments are allowed and must add up to the total.
- Refunds undo every line kind. They are refused while rental gear is still out, a lesson was attended, or a gift card sold on the order has been spent. Gift-card money paid in is restored.
- Reports: `revenue_cents` excludes gift card sales; `gift_card_sales_cents` and `tenders` are reported separately.
- The old `POST /orders` (tickets only) still works. Migration adds 8 changes to existing databases.

### Sell and Gate are separate pages

- **Sell** (`#/sell`, counter and managers): menu tabs, basket, checkout and Sold today. A button links to the gate.
- **Gate** (`#/gate`, counter, staff and managers): the ticket scanner on its own page, with a large result panel and recent scans.
- Both pages were restyled: pill tabs, larger product tiles, and a sticky basket with a large total.

### Money, safety and records
- **Sales tax**: rates per kind (or all) in Money > Sales tax; shown on baskets, receipts, dashboard.
- **Card payments**: card brand, last 4 and approval code are recorded and matched against a pasted processor statement (Money > Card statement). A live terminal integration (Square/Stripe) is NOT built; it needs a processor choice and keys.
- **Cash drawer / end of day**: open and close drawers, count cash, see over/short (Sell > Cash drawer, Money > Cash drawers).
- **Receipts and tickets**: print with Code 128 barcode and QR, reprint, email via the guest's mail app. QR code library is vendored in `public/vendor/qrcode`.
- **Guardians and family links**: under-18s need a guardian, who signs the waiver; waiver text lives in mountain settings (have a lawyer review it).
- **Sizing profile**: height, weight, boot size, stance, skier type; last DIN is pulled from past rentals.
- **Season passes**: photo required at sale, renewals list, lookup by code/phone/name at the Gate.
- **Comps** (with reason, optional counter limit), **refund reasons and partial refunds** (manager only), **merge duplicate customers** (manager).
- **Two-step sign-in** (authenticator app + recovery codes); a mountain can require it (`require_mfa`).
- **Gate**: shows photo and name, warns on a repeat scan within `scan_passback_seconds` (default 120).
- **Accountant exports**: CSVs under Money > For the accountant.
See `RUNBOOK.md` for security chores.

### Online shop

A public page at `/shop/<mountain>` where guests buy day tickets, multi-day tickets and season passes by card.

- **Turn on:** Settings > Online shop, then tick "Sell on the online shop" on each product. Needs the Stripe keys (see "Online card payment"); without them the page says online sales are closed. Demo mountains never take payment.
- **Flow:** the guest picks a day on a calendar (past days and days where every product is blacked out are greyed; up to a year ahead), then sees what is on sale that day with the price for each age group (`GET /public/<mountain>/shop/day?date=`), adds tickets for named people, and can add other days to the same order.
- **Selling rules:** each product can have `sale_days` (weekdays it is sold, bit per day, Sunday = 1; blank = every day) and `online_daily_limit` (most tickets valid on one day); the mountain has an `online_daily_limit` across all products. Days are enforced in the shared price check, so the ticket window and the shop both refuse a weekday ticket on a Saturday. Limits count every ticket valid that day (window sales too; a multi-day ticket counts on each of its days; season passes are not counted) plus baskets waiting on the card page (held 40 minutes), and stop online sales only. Each basket is placed under a lock on the mountain so the last ticket cannot be sold twice.
- **Pricing:** always on the server. Each ticket is for a named person; their date of birth sets the tier (child, youth, adult, senior) and the day sets calendar prices and blackouts. Tax follows the mountain's rules.
- **Nothing is sold until the payment lands.** The basket is saved as an `awaiting_payment` row in `shop_orders`; Stripe's `checkout.session.completed` webhook (the same `/api/v1/stripe/webhook`, `metadata.kind = shop`) then makes the people, waivers (buyer signs for self and children), a normal `online` order, one ticket per person and the card payment. A repeated webhook changes nothing; a payment that does not match the basket is refunded in full.
- **Tickets:** shown on the guest's page (`/shop/<mountain>?order=<secret>`) with Code 128 and QR codes, and emailed through Postmark when email is set up. Money > Online orders lists orders and can resend tickets.
- **Refunds:** staff refund from Sell > Orders; the card part now goes back through Stripe automatically for online card sales.
- **Limits:** up to 20 tickets per basket, days up to a year ahead, 150 unpaid baskets at once, 12 orders per hour per address (`SHOP_RATE_LIMIT`). Tickets are not self-service refundable.
- Run `npm run migrate` first: adds `shop_orders`, `tenants.online_shop`, `tenants.shop_message`, `products.online`.

### Online shop: guest experience and desk tools

- **Age group, not date of birth:** a day ticket asks for an age group (child, youth, adult, senior); only a season pass asks for a date of birth (and a photo, taken or chosen on the phone and shrunk before upload). Child and youth tickets make the buyer sign the waiver as guardian.
- **Calendar prices:** `GET /public/<m>/shop/month?month=YYYY-MM` gives the lowest price per day plus Few left / Sold out (cached 60 seconds). A product can have `advance_days` and `advance_percent`: a visit that far ahead gets that percent off online only ("buy online and save"; the window never gets it).
- **Branding:** Account > Look of the online shop (`/online-shop/brand`): logo, brand colour (must stay readable with white text), hero photo, opening day banner. The page shows today's conditions from the existing day status, snow readings, lifts and trails.
- **Basket extras:** add-ons (lesson, rental and voucher products marked online, delivered as a voucher with a barcode), gift cards ($5 to $1,000, code shown on the order page and emailed) and promo codes (not on gift cards). Tax and the discount are shared per line exactly as at the window.
- **Phones and language:** the pay bar sticks to the bottom on phones; the page has an English/Spanish switch (the guest's choice is kept in their browser) and remembers guests and buyer details on that device only.
- **After the sale:** a guest can move a single-day ticket to another day from the order page (Account > Online shop sets the cutoff hours and the fee). Free when the price is the same; a fee or higher price is paid on Stripe first (`metadata.kind = shop_change`) and recorded as its own small online order. Other emails go with the daily job: a day-before reminder (every paid order), a thank-you the day after (only guests who ticked the news box), one reminder for an abandoned basket (off unless switched on in Account), and a waitlist email when a sold-out day opens.
- **Desk (menu: Online shop):** Will-call (find by reference, email, phone, name or ticket code; print or resend), Group enquiries, Waitlist, and for managers Prices and limits (bulk price/close/reopen/limit by date range and weekday; a limit for one day replaces the usual one) and Sales pace (last 28 days against the same weekdays 364 days earlier, coming days against last year at the same lead time, and visits to baskets to paid).
- Run `npm run migrate` first: adds `shop_brand`, `shop_waitlist`, `group_enquiries`, `shop_changes`, `shop_day_limits`, `shop_visits`, `products.advance_days/advance_percent`, `shop_orders.recovery_sent_at/reminder_sent_at/thanks_sent_at`, `tenants.shop_recovery/shop_change_hours/shop_change_fee_cents`.

### Rentals

The Rentals screen is a full counter: sizing profiles, reservations with availability, group contracts (a waiver is required for everyone wearing gear), binding setting records with technician and test result, deposits, late, damage and loss fees that can be collected or waived, extend and swap, service log with a rentals-since-service reminder, gear tags with Code 128 barcodes and scan-to-add, CSV import, and a manager report.

- Settings (Rentals > Settings): late fee per day, grace period, default deposit, service interval, and whether skis need a binding record before they go out.
- The binding chart starts empty. Shops enter the release settings they use; the app ships no values, and the technician always records what they actually set.
- Late fees use the mountain's own time zone. Fees collected become paid orders, so they appear in sales reports. Deposits are tracked but are not sales.
- API: everything under `/api/v1/rentals` (module `rentals`). Tests: `test/rentals.test.js`.
- Pickup: receipts that include a rental print an order barcode (ORD-<number>). Scan it, or a ticket barcode, in the Counter tab to see the order, each person's contact details, emergency contact, waiver status and sizing, and the gear assigned, and to record the binding fitting. Scanners that type like a keyboard work as they are.

### Messages (email and text)

Office > Messages (managers only). Write a message, pick who gets it, send a test to yourself, then send.

- **Who can receive:** only customers whose latest consent event for that channel is "agreed", not suppressed, not anonymised. One message per address.
- **Audiences:** everyone who agreed, pass holders, lapsed pass holders, lesson students.
- **Unsubscribe:** every email carries a signed link; opening it shows a confirm page, and confirming records an opt-out in the consent ledger (source `unsubscribe_link`). Texts say "Reply STOP to opt out." STOP replies are not processed in the app yet; record them by hand on the customer.
- **Limit:** 1,000 recipients per message; sending happens while the request runs.
- **Automatic reminders** (run by the daily job, once each, no marketing consent needed): rental overdue (1 hour after due) and pass renewal (within 14 days of expiry).
- **Demo mountains never send.**

Environment variables (nothing sends until set):

- Email (Postmark): `POSTMARK_SERVER_TOKEN`, `MAIL_FROM`
- Text (Twilio): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- Daily job: `JOBS_KEY`; Cloud Scheduler calls `POST /internal/jobs/daily` with header `x-jobs-key`.
- Run `npm run migrate` first: adds `campaigns` and `message_log`.

### Weekly owner report

Money > Weekly report shows a Monday-to-Sunday week (in the mountain's time zone): sales (before tax, after refunds, the same as the Today screen), orders and guests compared with the week before, a day-by-day bar list, sales by type and channel, top sellers, new customers, lessons, patrol cases and a "needs attention" list. "Email me this report" sends the chosen week to the signed-in manager.

- **Monday email:** the existing daily job (`POST /api/v1/internal/jobs/daily`, Cloud Scheduler) builds last week's report on Monday to Wednesday if it has not been done, and emails every active owner and manager once. It is kept in `weekly_reports` (one row per mountain per week), so a repeated job run never sends twice. A job that was down on Monday still sends on Tuesday or Wednesday; later than that it skips.
- **Settings:** Settings > "Email the weekly report" turns it off for a mountain (on by default). Needs Postmark (`POSTMARK_SERVER_TOKEN`, `MAIL_FROM`). Demo mountains never send.
- Run `npm run migrate` first: adds `weekly_reports` and `tenants.weekly_report`.

## Ski school

### Ski school
Ski school screen tabs: **Lessons**, **Today**, **Online requests**, **Levels and skills**, **Instructor hours**.
- **Lesson types**: group, semi-private (2 to 4) and private lessons, with an age group and a meeting place. The usual seats come from the type. "Add a series of days" makes the same lesson on many days at once. Pricing comes from the lesson product (add one per length, such as "Private 1 hour" and "Private half day").
- **Packages**: a lesson product with 2 or more "rides" is a lesson package. It is sold from Sell > Lessons, then spent one lesson at a time when the student is booked in on the Roster. Cancelling a booking gives the lesson back; refunding an unused package voids it (a used one must be refunded by hand).
- **Levels and skills**: a default ski and snowboard ladder is created the first time it is opened, and managers edit it. Instructors tick skills off and move a student up on the **report card** (printable). Lesson notes are written per student by the instructor.
- **Instructor tools**: Today board (lessons, students, levels, unpaid flags, requested instructor), a picker that lists only instructors who are certified, free and available, session notes and tips, and an hours report.
- **Online booking**: switch it on in Settings; the public page is `/book/<mountain slug>` (its own light stylesheet, `public/css/book.css`). Guests pick a **day** and a **lesson type**; a day with nothing scheduled says so and tells them to call the mountain. With **card payment** on (Stripe, see RUNBOOK) they accept the cancellation policy, pay on Stripe's page, and the lesson is booked and recorded as an online sale when the payment lands; cancelling refunds by the mountain's tiers (default: full ≥48 h before, 50% ≥24 h, then none). With card payment off, it takes lesson **requests** only: a request holds a place but no money; staff confirm it (Ski school > Online requests), the booking shows **Unpaid**, and the guest pays at the desk (the sale picks up the held booking). Guests can check or cancel with their reference and email. No emails are sent by the system: staff get a ready-made email link when they confirm.
- API: `/skischool/levels`, `/skischool/students/:id/card`, `/skischool/board`, `/skischool/hours`, `/skischool/credits`, `/skischool/requests`, `/skischool/sessions/series`, public `/api/v1/public/:slug/booking` and `/requests`.

### Instructor availability
**Availability** (menu, under Programs) lets each instructor mark the dates and times they are open, whenever plans change.
- An instructor taps days on a month calendar (or picks all weekends or weekdays), chooses times (Morning, Afternoon, All day, or exact times, with an optional note) and presses Mark open. Overlapping times on a day join into one. They can remove a time or clear days at any point. Only today and later can be changed, up to a year ahead. Instructors can edit only their own; managers can pick any instructor.
- The instructor's login must be linked to their staff record (Staff and schedule). The **Everyone** tab shows the ski school desk (counter and managers) who is open over the next two weeks.
- **Public page:** a manager turns it on under Availability, Public page. It then lives at `/availability/<mountain slug>`, for your website or social media. It is read only: guests see names, a short bio, what each instructor teaches, levels and open times for the next 60 days. They cannot book, request or contact anyone from it. Each instructor decides whether to be listed (Public profile), and by default only a first name and last initial show. No emails, phone numbers or photos are shown, and past times drop off automatically.
- This is separate from the weekly availability used to check shift assignments. This release adds tables (`db/availability.sql`) and a column on tenants: run `npm run migrate` when upgrading.

## Patrol

### Patrol access levels
Every patrol roster member has one of five access levels: **Admin, Manager, Approver, Patrol, Host**. The level decides which patrol features the person can see and use; rank (candidate to director) is only for training and seniority.
- A patrol Admin opens **Patrol → Access levels** to switch features on or off for each level, and to set each person's level. The Admin column is locked on. "Reset to standard" puts every level back to the built-in defaults.
- Defaults: Manager runs the team (roster, posts, equipment, training, reports); Approver approves reports and follow-up emails; Patrol works cases and dispatch; Host sees the map, posts and trail checks but no case or patient details. Admin does everything.
- Mountain owners and system managers are always Admins. A `patrol` login that is not on the roster is a plain Patrol.
- Existing roster members were moved over from rank once: director to Admin, leader to Manager, everyone else to Patrol. After that, rank changes never touch a level someone chose.
- The server checks the level on every patrol request; the screens only hide what the person cannot use. Changes to levels and rules are in the audit log.

### Patrol: bedside card, quick vitals, hand-off sheet

- Opening a case now shows a **bedside card** per patient: name, age, allergies, medications, complaint, latest vitals (colour and word flags such as "High"/"Low", trend arrows), a "next vitals due" timer, one-tap treatments (Splint, Oxygen, etc.) and one-tap **stages** (On scene, Packaged, Transporting...) that stamp the timeline. The long NSAAR form is still there, tucked under **Paperwork**.
- **Add vitals** opens a sheet built for gloved hands: plus/minus steppers that start from the last reading, chips for pain, AVPU, skin and pupils, "check again in N minutes". Any value can be saved; flags are advice only. Logic is in `public/js/vitals-guide.js`.
- **Hand-off sheet** (`#/patrol/handoff/:caseId/:patientId`): one page for the next level of care with allergies, medications, history, complaint, injuries, treatment given, every set of vitals over time, who took over and when. Buttons: Print, Copy as text, Record hand-off (saves `handoff_to` / `handoff_time` and stamps a hand-off event).
- Printing is logged: `POST /patrol/incidents/:id/patients/:pid/handoff-printed` writes a `handoff_print` row (visible in Patrol, Access log). No database changes; `npm run migrate` reports 0 changes.

### Patrol: collisions, checklists, home screen, follow-up and giving

- **Patrol Home** is the first tab: My open cases, Waiting for approval (directors and managers), nudges for drafts left over from before today and for follow-up emails waiting on a decision, and a search by patient name, place or case number (`GET /patrol/incidents?q=`). A **New case** button stays in reach on every patrol screen, and a red banner shows when the phone loses its connection.
- **Collision report.** A collision case has a panel for each person involved (`POST/PATCH/DELETE /patrol/incidents/:id/parties`) and the scene (`PUT /patrol/incidents/:id/collision`: type, right of way, factors, police, equipment held, property damage, legal hold, other party left the scene). Any case can become a collision with "Record a collision". The printable report (`#/patrol/collision/:id`) shows people, scene, witnesses and notifications and **no medical details**. Printing writes a `collision_print` audit row.
- **Checklists** (`src/lib/checklists.js`, `GET /patrol/checklists`, `POST /patrol/incidents/:id/checklist`): collision, head or spine injury, minor, refusal, and sending to higher care. The case page suggests the ones that fit, and each tick records who and when.
- **Refusal of care** (`#/patrol/refusal/:id/:pid`): answers saved on the patient (`refusal_*` form fields), outcome set to refused care, signature collected with the existing signature pad, one-page print.
- **Take-home sheets** (`#/patrol/takehome/:id/:pid`): concussion, sprain or suspected break, and a general sheet. General first-aid advice only; have your medical director read the wording before you rely on it.
- **Follow-up emails** (Patrol, Follow-up tab; `src/lib/followups.js`):
  - Five days (configurable) after an **approved** case, a patient with an email address gets one thank-you email asking how we did and inviting a gift. A minor is emailed at the guardian address only. "Do not contact", a missing address and the unsubscribe list all stop it.
  - Transports and serious or critical cases are **held** for a director to approve or skip. Everything else sends on its own.
  - The email never mentions an injury, treatment or case details. It has a postal address footer, a stop link and a `List-Unsubscribe` header.
  - The page behind it (`/f/<token>`) takes a 1 to 5 rating and a comment, offers one-tap gift amounts and a stop button.
- **Giving.** `/f/<token>?give=50` and `/give/<mountain>` open Stripe Checkout for one-time or monthly gifts ($5 to $10,000). The existing Stripe webhook records paid gifts once (`donations` table, unique per Checkout session). Only the first payment of a monthly gift is recorded in SummitOps; the rest are in Stripe.
- **The daily job**: `POST /api/v1/internal/jobs/daily` with header `x-jobs-key: $JOBS_KEY`. It queues and sends due follow-ups and emails managers a short note (no patient details) when reports or drafts are waiting.
- **New settings** (all optional; nothing is sent until the first two are set): `POSTMARK_SERVER_TOKEN`, `MAIL_FROM` (a sender address verified in Postmark), `POSTMARK_STREAM` (default `outbound`), `JOBS_KEY` (a long random string), and `PUBLIC_URL` (the service address, used for links in emails; falls back to the request host). Giving needs the existing `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
- Run `npm run migrate` (about 12 changes: collision, parties, checklist, follow-up, suppression and donation tables, plus patient email and mountain follow-up settings).
- **Things to settle outside the software:** whether gifts are tax deductible depends on the legal entity that receives the money (the "tax note" field is blank until you fill it in); patient email addresses are health-adjacent data, so have your lawyer review the follow-up and the privacy notice; Postmark needs your sender address verified and, for bulk mail, its own message stream.
- Not built: photos and a scene sketch on the collision report, and a receipt letter for gifts (Stripe emails its own receipt).

### Patrol map

- Each incident's Location section has **Drop a pin on the map**; saving records `gps_lat` / `gps_lng` on the case. Approved reports show **View the pin on the map** (read-only).
- Patrol → **Map** tab shows every case with a pin, coloured by severity. `GET /patrol/map-pins` is audited and carries no patient names.
- `PUT /patrol/map-config` (patrol admin) sets where the map opens (`tenants.map_lat/map_lng/map_zoom`). Run `npm run migrate` (3 changes).
- Leaflet is vendored in `public/vendor/leaflet`. Default tiles are free OpenStreetMap / OpenTopoMap, which have usage limits; for production set `MAP_TILE_URL` (and related `MAP_*` env vars) to a keyed provider. Tile hosts are added to the CSP `img-src` automatically.

## Mountain operations

### Mountain status
**Mountain status** now has five tabs for owners, managers, staff and patrol (counter and instructor logins still see status only).
- **Status**: the operating day, lifts and trails, as before. Setting a lift to anything but Open logs lift downtime automatically; setting it back to Open ends the entry. A lift whose inspection failed today cannot be set to Open until a new inspection passes.
- **Grooming**: a plan for each night or day shift. Add trails one at a time, add every trail, or add only trails not yet groomed. Pick a machine, press Start and Finish (hours and fuel are recorded, the machine's hour meter goes up and the trail is marked groomed on the public feed). Managers can clear all groomed marks after the morning report. Snowmaking runs are started and stopped here.
- **Snow and weather**: snow depth, new snow and surface readings (whole mountain or one trail), and a weather log with wind and gusts.
- **Maintenance**: work orders (open, note, start, wait for parts, complete with what was done); lift inspections (standard ten-item pre-opening list; a failed item opens a high priority work order); recurring jobs due by days, machine hours or both, with Mark done and Make work order; the vehicle and equipment fleet with hour meters.
- **Reports**: lift downtime with totals per lift, shift handoff notes that the next crew can mark as read, and the daily mountain report with text to copy or print.
Managers delete records; everyone on the crew creates them. Everything is in the audit log. This release adds tables (`db/ops.sql`), so run `npm run migrate` when upgrading. `node db/demo.js <slug>` now also loads sample fleet, grooming, inspections, work orders and notes.

### Terrain park
**Terrain park** (menu, under Operations) tracks the features your park crew builds with and where they put them each day.
- **Features** is the catalog: rails, boxes, jumps, pipes and more (33 types), each with a size, length, whether the crew moves it day to day, notes, and a status (Ready, Needs attention, Closed, Retired).
- **Daily map** shows the mountain map for any day. Press Place on a feature, then tap the map (or use your phone's location) to put it down. Drag a marker to adjust. Markers show a letter for the kind (R rail, B box, J jump, P pipe) and turn amber or red when a feature needs attention or is closed. A dashed outline means it has not been inspected yet today.
- **Copy from…** starts a day from an earlier day's layout. It only adds features that are not placed yet; it never moves anything.
- **Inspect** records a result (OK, needs attention, close it). A problem needs a note. The result sets the feature's status everywhere.
- **Areas** are zones such as a main park or kids park; tag a placement with one.
- Who can do what: anyone signed in can look. Owners, managers and staff logins (the park crew) can add, place and inspect. Today and future days can be changed by the crew; a past day is a record that only a manager or owner can change. Placements, moves and inspections are in the audit log.
- Open the map where your park is once: as a manager, pan and zoom to the park and press "Open the map here by default".

### The day board (Today)
The **Today** page is a set of tiles each person can choose and reorder: Lifts, Trails and grooming, Snow and weather, Work orders, Guests scanned, Sales, Rentals, Lessons, Staffing, Certifications expiring, Patrol and Shift notes.
- **Who sees what:** a tile shows only if the person's role allows it and the mountain has that app on (turn Rentals off and the Rentals tile goes). Counter, instructor, patrol, staff and manager/owner each start with their own set.
- **Alerts band:** at the top, a failed lift inspection or a wind hold shows first ("Blocks opening"), then overdue rentals, open incidents and unfilled shifts.
- **Customize:** add a tile, move it up or down, take it off, or go back to the standard board. A person's own choice wins; otherwise a manager's default for their role; otherwise the built-in set. Managers can set or clear the default for a role.
- **Shift notes:** anyone can post, managers can pin, and you can remove your own.
- **Wall screen:** full-screen, refreshes every minute, for the lodge or patrol room.
- **Other days:** managers can pick another date; other roles see today.
- API: `GET /board` (tiles, layout, alerts and data in one call), `PUT/DELETE /board/layout`, `PUT/DELETE /board/layout/role/:role`, `POST/PATCH/DELETE /board/notes`. `npm run migrate` adds two tables (`board_layouts`, `board_notes`).

## Staff

### Time clock kiosk

A shared tablet by the staff door lets people clock in and out without an account: tap your name and enter a PIN, or scan a QR badge.

- Set up (Staff and schedule, Time clock kiosk tab): give each person a PIN, add a tablet, open the pairing link on it, and optionally print badges.
- Pairing codes work once and expire in 30 minutes. A tablet's token is stored only as a hash and the tablet can be turned off or removed at any time.
- PINs are 4 to 6 digits, stored hashed, and five wrong tries lock that person for 10 minutes (a manager can unlock). Badges are derived from the server secret, so they can be reprinted; "Lost badge" makes the old one stop working.
- Each punch must match the person's current state (in or out), and the confirm step expires after 90 seconds, so a stray tap cannot flip someone's status.
- Snapshots are off by default. When on, the tablet shows a notice, one photo is saved per punch, only managers can view it (each view is logged), and the daily job deletes it after the chosen number of days. Nothing is matched to faces.
- Managers can fix a forgotten clock-out; the change is written to the audit log. Entries open more than 14 hours are flagged.
- Needs `x-kiosk-token` on `/api/v1/kiosk/*` (set by the page), `/api/v1/kiosk-admin/*` for managers. Env: `KIOSK_PAIR_LIMIT`, `KIOSK_RATE_LIMIT`.
- Fix in this update: the Hours worked list and My shifts now show mountain-local times (they showed UTC before).

## Documents

### Documents
**Documents** (menu, under Operations) is a shared library for policies, forms, manuals and plans.
- Managers and owners make **categories** (Safety, HR forms, Manuals) and choose, for each one, which roles can see it (staff, patrol, instructors, counter) and which of those can also add and remove documents. A category with no roles ticked is managers only. Managers and owners always see everything.
- A document is a file (up to 10 MB: PDF, Word, Excel, PowerPoint, images, text, CSV, zip) or a web link. PDFs and images open in the browser; everything else downloads. Replacing a file keeps the same document and raises its version number.
- A role that cannot see a category cannot see its documents, search results or files; they look like they do not exist. Web pages and scripts cannot be uploaded.
- **Versions:** replacing a file keeps the old one as an earlier version, with who added it, when, and an optional "what changed" note. A document keeps up to **10 versions**. The Versions button lists them; any version can be opened or downloaded, and a manager or an allowed role can restore one (it becomes the newest version, so nothing is lost). When a document is at version 10 the next file has to be a new document, and the screen offers to create it.
- **Search inside files:** every file is read when it is added, so the search box finds words inside documents, not just titles. It reads text files, CSV, Markdown, RTF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and PDFs. Pictures of text (a scanned PDF or a photo) are read with OCR in English, but only at mountains that have the **Document text recognition** add-on (platform console, Apps list; off by default, and it turns Documents on with it). Without it those files stay "Not searchable yet" and everything else is unchanged; the first 30 pages of a scanned PDF are read. The old Word, Excel and PowerPoint formats (.doc, .xls, .ppt) and zip files cannot be read, so they are found by title only. A manager sees a bar showing how many files are searchable, with **Scan waiting** and **Rescan everything** buttons; use these once after upgrading to read the files already uploaded. OCR needs memory: run the service with at least 1 GiB (`--memory 1Gi`), or set `DOCS_OCR=0` to turn OCR off.
- Files are stored in the database, so they are backed up with it and need nothing extra to deploy. This release adds tables and columns (`db/docs.sql`): run `npm run migrate` when upgrading. Uploads, replacements, deletions and role changes are in the audit log.

### Documents: read and accepted, and storage

Tick "Ask people to read and accept this" on a document. Everyone who can see its category gets a notice at the top of Documents until they click **I have read this**; their name and the time are recorded. Managers see **Accepted by N** and who is still waiting. Replacing the file (a new version) asks everyone again.

## Waivers

Every guest needs a waiver for the season before they rent gear or take a lesson, and Sell, Rentals, Ski school and the Gate show whether they have one that counts.

- **Signed, not just ticked.** A signing keeps the drawn signature, the typed name, the time, the device (address and browser), and the exact wording, stored word for word in `waiver_texts`. One signing can cover the signer and their children; each person covered gets a `waivers` row pointing at it (`waiver_signings`).
- **Four ways to sign:** the public page `/waiver/<mountain>` (at home or by QR code; works on a phone), a counter tablet mode of the same page that clears after each family, **Sign on this screen** on any guest at the counter, or **Email a link**. Staff can still **Record a paper waiver**.
- **Children:** only an adult (18 or over) signs, for themselves and up to 10 children. A child who already has a different guardian on file is never signed for by someone else: online, that signing goes on a new record marked as a possible duplicate for staff to check; at the counter, staff are told.
- **Who is who:** the public page cannot name an existing record. It matches a person only on first name, last name and date of birth together, never on an email alone, and never changes a matched record's contact details. The signed copy shows names as the guest typed them.
- **The guest's copy:** a private link (`/waiver/<mountain>?copy=<token>`) shows exactly what they signed, with a Print or Save as PDF button. It is emailed only when the address is the signer's own, at most 3 times an hour per address.
- **Waivers screen (Front desk):** search everyone signed this season, open one to see and print exactly what was signed, void a mistake with a reason (managers; it stops counting but is kept), and download a CSV (managers). Patrol do not see the register.
- **Wording:** managers edit it under Waivers, Wording, with a sample to start from (not legal advice). Every version is kept. **Ask everyone to sign again** makes all earlier waivers stop counting, including boxes ticked against the old wording in shop baskets and lesson requests still being paid for.
- **Next season:** a counter signing for a lesson next season is signed for that season (current or next only).
- **Privacy:** anonymising a customer keeps their signed waivers (the mountain's legal record) but removes the signer's email, phone, address and browser from them. Merging customers moves their signings.
- Run `npm run migrate` when upgrading: it adds `waiver_texts`, `waiver_signings` and new columns on `waivers` and `tenants`, and archives each mountain's current wording.

## Hardening release (fixes from the full app review)

### Money

- **Card refunds can fail and be retried.** A refund to a card is recorded as pending, then sent to Stripe. If Stripe refuses, the order shows the refund as failed with **Try again**; the daily job also retries. Stripe is checked first so a guest is never refunded twice.
- **Webhooks only act on orders still waiting for payment.** A late or repeated Stripe message cannot sell a ticket twice. If the sale can no longer be honoured (sold out, already used), nothing is saved and the card is refunded.
- **Gift cards are never taxed.** Date-change price differences are taxed like the ticket; the change fee is its own line ("Fees" in reports).
- **One-use promo codes hold while a guest is on the card page,** so two guests cannot both use the last one. A guest who goes back to change their basket does not lose their own code.
- **Cash refunds name a drawer,** so drawer counts include them. Old-style `/orders` sales record tax.
- **The daily report counts sales on the sale day and refunds on the refund day,** so a past day's figures never change.

### Security

- **Demo mountains cannot send email or texts.** Every email and text names its mountain; bulk campaigns go out on a separate Postmark stream (`POSTMARK_BROADCAST_STREAM`).
- **Online orders no longer overwrite customer records.** Buying for someone fills in blanks only, and a buyer's email goes only on their own record.
- **Two-step sign-in lockout is kept in the database** (survives restarts and works across servers); a sign-in started before a password change is refused.
- **Platform console:** Demo sign-ups now has Delete on each running demo and "Delete every demo". Sign in with the key, your name and (if `PLATFORM_TOTP_SECRET` is set) an authenticator code; sessions last 2 hours; `PLATFORM_ALLOW_IPS` limits where it can be used from; the audit log shows who.
- **Separate keys** for two-step codes, email links and kiosks (`TOTP_KEY`, `LINK_SECRET`, `KIOSK_SECRET`; each falls back to `JWT_SECRET`).
- **Patrol can only look up people specifically** (3+ letters, 7+ digits or an email, 10 results) and only open people on their own cases.
- **Lesson request status** is checked with a POST (the email is no longer in the address).

### Operations

- **The daily job runs once even if two schedulers fire,** retries stuck campaign sends and card refunds, and logs `daily job finished` (used for an alert, see RUNBOOK.md).
- **`/readyz` says "run npm run migrate"** when the database is behind the code; migrate exits with an error if it could not finish.
- **`deploy.sh`** checks sign-in, migrates, deploys with sensible limits (4 servers, 8 database connections each) and checks the new version is ready.
- RUNBOOK.md has new sections: alerts, backups, rotating keys, platform console.

### Screens

- **Quick sale** at the ticket window: day tickets, multi-day, punch cards and vouchers skip the customer form (turn off in Account).
- **Faster payment:** choose cash or card first; cash has Exact/$20/$50/$100 buttons and shows change in large type; a warning if no drawer is open.
- **Dialogs** no longer close when you click outside them after typing.
- **Patrol new case:** big Type and Severity buttons, trail first, "Where exactly" optional.
- **Online shop:** a running total beside the form on desktop, promo code in the order panel.
- **Lesson booking page** in Spanish (language switch), and clearer messages when online booking is off.

## Engineering notes

### PATCH keeps defaulted fields

zod 4's `.partial()` still applies `.default()`, so any PATCH silently reset untouched fields (e.g. incident severity to `minor`). All update schemas now use `partialOf()` from `src/lib/util.js`; regression test in `test/map.test.js`.

## Known limits

- **Rate limits are kept in each server's memory,** so with several Cloud Run instances the real limit multiplies. `LOGIN_RATE_LIMIT` (default 10 a minute per address) raises the sign-in limit for automated tests.
- **Migrations are idempotent steps, not numbered files.** `db/migrate.js` checks what exists and adds what is missing. Adopt numbered migrations before changes that alter or remove existing columns.
- **Patient and incident data may be regulated** depending on how patrol is run. Access is limited by patrol access level and every read is audited, but that is not a compliance claim (see HIPAA.md). Get a legal review.
- **Customer data is personal data,** including children's dates of birth and photos. Get a legal review of the privacy notice, consent wording and retention.
- **The guest help page is open to the internet.** It is off until a manager turns it on, rate limited (`HELP_RATE_LIMIT`), ignores bot-filled forms and stops at 20 waiting requests. It always tells guests to call 911 for emergencies.
- **No password-reset email.** A manager sets a new password for a locked-out person (Account, then Logins); the platform console can reset an owner.
- **The incident form follows the NSAAR layout,** a Canadian form, with US equivalents where it helps. Whether it meets your insurer's or state's rules is for them to confirm.
- **One Stripe account for every mountain.** Online sales all land in the platform's Stripe account. Move to Stripe Connect before a second mountain sells online.
- **Daily ticket limits stop online sales only;** the ticket window can still sell past them.
