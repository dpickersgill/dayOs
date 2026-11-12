'use strict';

// Bulk trash pickup (muni release 1, workstream "trash"): residents book a pickup by the weekly cutoff and pay online on
// the municipality's own Stripe account, with stickers, or at the office; the crew works the stop list; Not out needs a
// photo and tells only residents who said yes; STOP is honored; cancel before the cutoff refunds the card; the report adds
// up; the app is gated and each municipality sees only its own. Stripe, Twilio and Postmark are one mock server.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.PUBLIC_RATE_LIMIT = '100000';
process.env.BULK_RATE_LIMIT = '1000';
process.env.USERS_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_platform';
process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.STRIPE_GUEST_FALLBACK = 'off';
// Email and texts are switched on once every login is made (with email on, a manager's sign-in asks for an emailed code).
const MESSAGING = { POSTMARK_SERVER_TOKEN: 'pm', MAIL_FROM: 'noreply@test.example', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_FROM: '+15555550100' };
const messagingOff = () => { for (const k of Object.keys(MESSAGING)) delete process.env[k]; };
const messagingOn = () => Object.assign(process.env, MESSAGING);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const { createMuniTenant } = require('./helpers/muni');
const { signature } = require('../src/routes/twilioinbound');

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let mock; let n = 0;
const sink = [];
const q = async (sql, params) => (await pool.query(sql, params))[0];
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const wd = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
const NY = 'America/New_York';

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
const api = (m, p, o) => call(m, `/api/v1${p}`, o);
const pub = (m, slug, p, o) => call(m, `/api/v1/public/${slug}/bulk-pickup${p}`, o);
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${r.text}`);
const texts = (from) => sink.slice(from).filter((x) => x.u.includes('/Messages.json')).map((x) => new URLSearchParams(x.b));
const emails = (from) => sink.slice(from).filter((x) => x.u.startsWith('/email')).map((x) => JSON.parse(x.b));
const stripeCalls = (from) => sink.slice(from).filter((x) => x.u.startsWith('/v1/'));
async function webhook(event, secret = 'whsec_connect') {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, secret) }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const paidEvent = (row, acct, extra = {}) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', account: acct,
  data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.total_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(row.tenant_id), booking_id: String(row.id), kind: 'bulk', ...extra } } } });
async function twilioReply(from, bodyText) {
  const params = { From: from, Body: bodyText, To: '+15555550100' };
  const url = `${base}/api/v1/twilio/sms`;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature('twilio-token', url, params) }, body: new URLSearchParams(params).toString() });
  return res.status;
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), crypto.randomBytes(200), Buffer.from([0xff, 0xd9])]);

let A; let B; let C; let K; let P; let skiToken;
let crewA; let deskA; let mgrA;
const streets = {};
async function addStreets(m, names) {
  const ids = [];
  for (const name of names) { const r = await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [m.id, name]); ids.push(r.insertId); }
  streets[m.id] = ids;
  return ids;
}
/** Puts the settings in place through the manager's own screen (PUT /solid-waste/settings). */
async function settings(m, change = {}) {
  const cur = (await api('GET', '/solid-waste/settings', { token: m.token })).body;
  const body = { online: cur.online, collection_days: cur.collection_days, cutoff_days_before: cur.cutoff_days_before, cutoff_time: cur.cutoff_time, capacity: cur.capacity, curb_by: cur.curb_by,
    pay_card: cur.pay_card, pay_stickers: cur.pay_stickers, office_name: cur.office_name, rules_text: cur.rules_text, not_out_policy: cur.not_out_policy,
    sizes: cur.sizes.map((s) => ({ id: s.id, name: s.name, description: s.description, price_cents: s.price_cents, max_qty: s.max_qty, active: s.active })), ...change };
  const r = await api('PUT', '/solid-waste/settings', { token: m.token, body });
  is(r, 200, 'settings saved');
  return r.body;
}
const sizeId = (s, name) => s.sizes.find((x) => x.name === name).id;
const resident = (k, extra = {}) => ({ name: `Rae Resident ${k}`, phone: `610-555-01${String(k).padStart(2, '0')}`, email: `rae${k}-${suffix}@example.com`, texts_ok: true, emails_ok: true, ...extra });

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      sink.push({ u: req.url, b: data, h: req.headers, account: req.headers['stripe-account'] || null });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/email')) return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `pm${sink.length}` }));
      if (req.url.includes('/Messages.json')) return res.end(JSON.stringify({ sid: `SM${sink.length}` }));
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: `cs_bulk_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
      if (/^\/v1\/checkout\/sessions\/.+\/expire$/.test(req.url)) return res.end('{}');
      if (req.url === '/v1/refunds') return res.end(JSON.stringify({ id: `re_${++n}`, status: 'succeeded' }));
      if (req.url.startsWith('/v1/refunds?')) return res.end(JSON.stringify({ data: [] }));
      res.statusCode = 404; return res.end('{}');
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;
  config.stripe.apiBase = mockBase; config.stripe.guestFallback = false;
  process.env.TWILIO_API_BASE = mockBase; process.env.POSTMARK_API_BASE = mockBase;
  require('../src/lib/mailer').settings.apiBase = mockBase;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await createMuniTenant(base, { slug: `tr-a-${suffix}`, name: `Riverton Borough ${suffix}`, modules: { solidwaste: true } });
  B = await createMuniTenant(base, { slug: `tr-b-${suffix}`, name: `Lakeview Township ${suffix}`, modules: { solidwaste: true } });
  C = await createMuniTenant(base, { slug: `tr-c-${suffix}`, name: `Hillside Borough ${suffix}` }); // no Trash and recycling app
  // The same instant is a different day in these two: Kiritimati is UTC+14, Pago Pago is UTC-11.
  K = await createMuniTenant(base, { slug: `tr-k-${suffix}`, modules: { solidwaste: true }, timezone: 'Pacific/Kiritimati' });
  P = await createMuniTenant(base, { slug: `tr-p-${suffix}`, modules: { solidwaste: true }, timezone: 'Pacific/Pago_Pago' });
  for (const m of [A, B, C, K, P]) await addStreets(m, ['Main Street', 'Bridge Street', 'Church Street', 'Oak Lane']);
  crewA = await A.addLogin('staff'); deskA = await A.addLogin('counter'); mgrA = await A.addLogin('manager');
  const made = await api('POST', '/platform/tenants', { headers: { 'x-platform-key': KEY }, body: { slug: `tr-ski-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', owner: { email: `gm@tr-ski-${suffix}.test`, password: PW, first_name: 'G', last_name: 'M' } } });
  is(made, 201);
  skiToken = (await api('POST', '/auth/login', { body: { tenant: `tr-ski-${suffix}`, login: `gm@tr-ski-${suffix}.test`, password: PW } })).body.token;
  messagingOn();
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

// ---------------------------------------------------------------- settings and availability
test('a municipality starts with the usual settings: Monday, noon Thursday, 40 stops, Small $15 to Large $35 and Metal free', async () => {
  const s = (await api('GET', '/solid-waste/settings', { token: A.token })).body;
  assert.deepEqual(s.collection_days, [1]);
  assert.equal(s.cutoff_days_before, 4); assert.equal(s.cutoff_time, '12:00'); assert.equal(s.capacity, 40); assert.equal(s.curb_by, '06:00');
  assert.deepEqual(s.sizes.map((x) => [x.name, x.price_cents]), [['Small', 1500], ['Medium', 2500], ['Large', 3500], ['Metal', 0]]);
  assert.equal(s.pay_card, true); assert.equal(s.pay_stickers, true); assert.equal(s.not_out_policy, 'no_refund');
  assert.equal(s.card_ready, false, 'no Stripe account yet');
  assert.match(s.page, new RegExp(`/bulk-pickup/${A.slug}$`));
  is(await api('GET', '/solid-waste/settings', { token: deskA.token }), 403, 'the front desk does not change settings');
  is(await api('PUT', '/solid-waste/settings', { token: crewA.token, body: {} }), 403, 'nor does the crew');
});

test('availability: the cutoff is on the municipality\'s own clock', async () => {
  // Both close the day after Kiritimati's today, at midnight the day before: already past in Kiritimati, still ahead in Pago Pago.
  const kToday = todayIn('Pacific/Kiritimati');
  const D = plus(kToday, 1);
  for (const m of [K, P]) await settings(m, { collection_days: [wd(D)], cutoff_days_before: 1, cutoff_time: '00:00' });
  const k = (await pub('GET', K.slug, '')).body; const p = (await pub('GET', P.slug, '')).body;
  assert.ok(!k.days.some((d) => d.date === D), 'Kiritimati: booking for that day has closed, so it is not offered');
  const pd = p.days.find((d) => d.date === D);
  assert.ok(pd && pd.available, 'Pago Pago: still open');
  const s = (await api('GET', '/solid-waste/options', { token: K.token })).body;
  const sz = s.sizes[0].id;
  const r = await pub('POST', K.slug, '/bookings', { body: { collection_date: D, street_id: streets[K.id][0], house_number: '12', items: [{ size_id: sz, quantity: 1 }], pay: 'stickers', ...resident(1) } });
  is(r, 409, 'a closed day is refused');
  assert.match(r.body.error, /closed/);
  const ok = await pub('POST', P.slug, '/bookings', { body: { collection_date: D, street_id: streets[P.id][0], house_number: '12', items: [{ size_id: (await api('GET', '/solid-waste/options', { token: P.token })).body.sizes[0].id, quantity: 1 }], pay: 'stickers', ...resident(2) } });
  is(ok, 201, 'the same day is open in Pago Pago');
});

test('availability: capacity and skip dates', async () => {
  const today = todayIn(NY);
  const D = plus(today, 3); const D2 = plus(today, 4);
  const s = await settings(B, { collection_days: [wd(D), wd(D2)], cutoff_days_before: 1, cutoff_time: '12:00', capacity: 2 });
  const small = sizeId(s, 'Small');
  const book = (date, k) => pub('POST', B.slug, '/bookings', { body: { collection_date: date, street_id: streets[B.id][1], house_number: String(100 + k), items: [{ size_id: small, quantity: 1 }], pay: 'stickers', ...resident(10 + k) } });
  is(await book(D, 1), 201); is(await book(D, 2), 201);
  const full = await book(D, 3);
  is(full, 409, 'the third stop does not fit');
  assert.match(full.body.error, /full/);
  const page = (await pub('GET', B.slug, '')).body;
  assert.deepEqual(page.days.find((d) => d.date === D), { ...page.days.find((d) => d.date === D), available: false, reason: 'Full' });
  // A holiday: no pickup, the note shows, and booking is refused.
  is(await api('POST', '/solid-waste/skip-dates', { token: B.token, body: { on_date: D2, note: 'Holiday' } }), 201);
  const page2 = (await pub('GET', B.slug, '')).body;
  assert.equal(page2.days.find((d) => d.date === D2).reason, 'No pickup: Holiday');
  const hol = await book(D2, 4);
  is(hol, 409); assert.match(hol.body.error, /no pickup/i);
  // Staff can still book a full day for someone on the phone, as an override; never a skip date.
  const staffBody = { collection_date: D, street_id: streets[B.id][1], house_number: '7', items: [{ size_id: small, quantity: 1 }], pay: 'office_paid', name: 'Phone Caller', phone: '610-555-0177' };
  const refused = await api('POST', '/solid-waste/bookings', { token: B.token, body: staffBody });
  is(refused, 409); assert.equal(refused.body.details.can_override, true);
  is(await api('POST', '/solid-waste/bookings', { token: B.token, body: { ...staffBody, override: true } }), 201);
  is(await api('POST', '/solid-waste/bookings', { token: B.token, body: { ...staffBody, collection_date: D2, override: true } }), 409, 'never on a skip date');
});

// ---------------------------------------------------------------- booking and paying
test('booking with stickers: booked at once, the resident is on file, and the email confirms it', async () => {
  const today = todayIn(NY);
  const D = plus(today, 5);
  const s = await settings(A, { collection_days: [wd(D), wd(today)], cutoff_days_before: 1, cutoff_time: '12:00' });
  const before = sink.length;
  const r = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][0], house_number: '120', unit: 'Apt 2', items: [{ size_id: sizeId(s, 'Small'), quantity: 2 }, { size_id: sizeId(s, 'Metal'), quantity: 1 }], items_note: 'Two chairs and a bike', pay: 'stickers', ...resident(20, { texts_ok: false }) } });
  is(r, 201);
  assert.equal(r.body.pay_method, 'stickers'); assert.equal(r.body.total_cents, 3000);
  const [row] = await q('SELECT * FROM bulk_bookings WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  assert.equal(row.status, 'booked'); assert.equal(row.pay_status, 'not_needed');
  const [res] = await q('SELECT * FROM residents WHERE tenant_id = ? AND id = ?', [A.id, row.resident_id]);
  assert.equal(res.name, 'Rae Resident 20'); assert.equal(res.house_number, '120'); assert.equal(res.texts_ok, 0); assert.equal(res.emails_ok, 1);
  const mail = emails(before);
  assert.equal(mail.length, 1); assert.match(mail[0].TextBody, /sticker/); assert.match(mail[0].TextBody, new RegExp(r.body.reference));
  assert.equal(texts(before).length, 0, 'no text without a yes to texts');
  // Their own link shows their booking and nothing else.
  const v = await pub('GET', A.slug, `/bookings/${r.body.token}`);
  is(v, 200); assert.equal(v.body.address, `120 Main Street, Apt 2`); assert.equal(v.body.can_cancel, true);
  is(await pub('GET', B.slug, `/bookings/${r.body.token}`), 404, 'not under another municipality');
  // Too many of one size is refused with the limit.
  const many = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][0], house_number: '5', items: [{ size_id: sizeId(s, 'Large'), quantity: 9 }], pay: 'stickers', ...resident(21) } });
  is(many, 400); assert.match(many.body.error, /up to 3/);
  const noContact = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][0], house_number: '5', items: [{ size_id: sizeId(s, 'Small'), quantity: 1 }], pay: 'stickers', name: 'No Contact', texts_ok: false, emails_ok: false } });
  is(noContact, 400); assert.match(noContact.body.error, /phone number or an email/);
});

test('booking by card without a connected Stripe account is taken as "pay at the office"', async () => {
  const s = (await api('GET', '/solid-waste/settings', { token: A.token })).body;
  const page = (await pub('GET', A.slug, '')).body;
  assert.equal(page.pay.card, false); assert.equal(page.pay.office, true); assert.match(page.card_message, /Borough Hall/);
  const D = page.days.find((d) => d.available).date;
  const r = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][1], house_number: '44', items: [{ size_id: sizeId(s, 'Large'), quantity: 1 }], pay: 'card', ...resident(22) } });
  is(r, 201);
  assert.equal(r.body.pay_method, 'office'); assert.equal(r.body.pay_status, 'due'); assert.equal(r.body.checkout_url, undefined);
  assert.match(r.body.message, /pay \$35\.00 at Borough Hall/);
});

let acctA; let cardBooking;
test('booking by card goes to the municipality\'s own Stripe account; the webhook books it once', async () => {
  acctA = `acct_trash${suffix.replace(/\W/g, '')}`;
  await q('UPDATE tenants SET stripe_account = ?, stripe_charges_enabled = 1, stripe_payouts_enabled = 1 WHERE id = ?', [acctA, A.id]);
  const s = (await api('GET', '/solid-waste/settings', { token: A.token })).body;
  assert.equal(s.card_ready, true);
  const page = (await pub('GET', A.slug, '')).body;
  assert.equal(page.pay.card, true);
  const D = page.days.find((d) => d.available).date;
  const before = sink.length;
  const r = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][2], house_number: '9', items: [{ size_id: sizeId(s, 'Medium'), quantity: 1 }, { size_id: sizeId(s, 'Small'), quantity: 1 }], pay: 'card', ...resident(23) } });
  is(r, 201);
  assert.match(r.body.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  const co = stripeCalls(before).find((c) => c.u === '/v1/checkout/sessions');
  assert.equal(co.account, acctA, 'made on the municipality\'s account, never the platform\'s');
  const form = new URLSearchParams(co.b);
  assert.equal(form.get('metadata[kind]'), 'bulk'); assert.equal(form.get('line_items[0][price_data][unit_amount]'), '4000');
  [cardBooking] = await q('SELECT * FROM bulk_bookings WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  assert.equal(cardBooking.status, 'awaiting_payment');
  const day = (await api('GET', `/solid-waste/options`, { token: A.token })).body.days.find((d) => d.date === D);
  assert.ok(day.booked >= 1, 'the open card page holds its stop');
  const w = await webhook(paidEvent(cardBooking, acctA));
  is(w, 200); assert.equal(w.body.ok, true);
  [cardBooking] = await q('SELECT * FROM bulk_bookings WHERE id = ?', [cardBooking.id]);
  assert.equal(cardBooking.status, 'booked'); assert.equal(cardBooking.pay_status, 'paid'); assert.equal(cardBooking.paid_cents, 4000); assert.equal(cardBooking.processor_account, acctA);
  assert.equal((await webhook(paidEvent(cardBooking, acctA))).body.duplicate, true, 'a repeated event changes nothing');
  // An event from another municipality's account naming this booking is ignored.
  const other = await webhook(paidEvent({ ...cardBooking, stripe_session_id: 'cs_other' }, 'acct_someoneelse123'));
  assert.equal(other.body.ignored, true);
});

test('cancel before the cutoff refunds the card in full through the municipality\'s account', async () => {
  const before = sink.length;
  const r = await pub('POST', A.slug, `/bookings/${cardBooking.view_token}/cancel`);
  is(r, 200);
  assert.equal(r.body.status, 'cancelled'); assert.equal(r.body.pay_status, 'refunded'); assert.equal(r.body.refunded_cents, 4000);
  const refund = stripeCalls(before).find((c) => c.u === '/v1/refunds');
  assert.ok(refund, 'sent to Stripe');
  assert.equal(refund.account, acctA);
  const form = new URLSearchParams(refund.b);
  assert.equal(form.get('payment_intent'), cardBooking.payment_intent); assert.equal(form.get('amount'), '4000');
  const [ret] = await q('SELECT * FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [A.id, cardBooking.payment_intent]);
  assert.equal(ret.kind, 'bulk'); assert.equal(ret.card_status, 'sent');
  is(await pub('POST', A.slug, `/bookings/${cardBooking.view_token}/cancel`), 409, 'already canceled');
  assert.ok(emails(before).some((m) => /going back to your card/.test(m.TextBody)));
});

test('after the cutoff the resident cannot cancel; only a manager gives money back', async () => {
  const page = (await pub('GET', A.slug, '')).body;
  const D = page.days.find((d) => d.available).date;
  const s = (await api('GET', '/solid-waste/settings', { token: A.token })).body;
  const r = await pub('POST', A.slug, '/bookings', { body: { collection_date: D, street_id: streets[A.id][3], house_number: '31', items: [{ size_id: sizeId(s, 'Small'), quantity: 1 }], pay: 'card', ...resident(24) } });
  is(r, 201);
  let [row] = await q('SELECT * FROM bulk_bookings WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  is(await webhook(paidEvent(row, acctA)), 200);
  // The cutoff moves to a week before, so it has passed for this day.
  await settings(A, { cutoff_days_before: 7, cutoff_time: '00:00' });
  const v = (await pub('GET', A.slug, `/bookings/${r.body.token}`)).body;
  assert.equal(v.can_cancel, false);
  const no = await pub('POST', A.slug, `/bookings/${r.body.token}/cancel`);
  is(no, 409); assert.match(no.body.error, /closed/);
  is(await api('POST', `/solid-waste/bookings/${row.id}/cancel`, { token: deskA.token, body: { refund: true } }), 403, 'the front desk cannot refund after the cutoff');
  const before = sink.length;
  const ok = await api('POST', `/solid-waste/bookings/${row.id}/cancel`, { token: mgrA.token, body: { refund: true, reason: 'Moving away' } });
  is(ok, 200); assert.equal(ok.body.pay_status, 'refunded');
  assert.equal(stripeCalls(before).filter((c) => c.u === '/v1/refunds').length, 1);
  [row] = await q('SELECT * FROM bulk_bookings WHERE id = ?', [row.id]);
  assert.equal(row.status, 'cancelled');
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'bulk_cancel' AND entity_id = ?", [A.id, row.id])).length, 'audited');
  await settings(A, { cutoff_days_before: 1, cutoff_time: '12:00' });
});

// ---------------------------------------------------------------- staff bookings
test('the front desk books a phone call: paid at the office, stickers, a payment link by text, or a credit', async () => {
  const opts = (await api('GET', '/solid-waste/options', { token: deskA.token })).body;
  const D = opts.days.find((d) => d.available).date;
  const sm = opts.sizes.find((x) => x.name === 'Small').id; const lg = opts.sizes.find((x) => x.name === 'Large').id;
  const body = (k, extra) => ({ collection_date: D, street_id: streets[A.id][0], house_number: String(200 + k), items: [{ size_id: lg, quantity: 1 }], ...resident(30 + k), ...extra });
  const paid = await api('POST', '/solid-waste/bookings', { token: deskA.token, body: body(1, { pay: 'office_paid' }) });
  is(paid, 201);
  const [p] = await q('SELECT * FROM bulk_bookings WHERE id = ?', [paid.body.id]);
  assert.equal(p.source, 'staff'); assert.equal(p.pay_method, 'office'); assert.equal(p.pay_status, 'paid'); assert.equal(p.paid_cents, 3500); assert.equal(p.created_by, deskA.id);
  const st = await api('POST', '/solid-waste/bookings', { token: deskA.token, body: body(2, { pay: 'stickers' }) });
  is(st, 201);
  const before = sink.length;
  const link = await api('POST', '/solid-waste/bookings', { token: deskA.token, body: body(3, { pay: 'link', link_by: 'text' }) });
  is(link, 201); assert.deepEqual(link.body.sent, ['text']);
  const sms = texts(before);
  assert.equal(sms.length, 1); assert.equal(sms[0].get('To'), '+16105550133');
  assert.ok(sms[0].get('Body').includes(link.body.link), 'the text carries the payment link');
  const [l] = await q('SELECT * FROM bulk_bookings WHERE id = ?', [link.body.id]);
  assert.equal(l.status, 'booked', 'the stop is held while they pay'); assert.equal(l.pay_status, 'due');
  const tok = l.view_token;
  const pay = await pub('POST', A.slug, `/bookings/${tok}/pay`);
  is(pay, 200); assert.match(pay.body.checkout_url, /checkout\.stripe\.test/);
  const [l2] = await q('SELECT * FROM bulk_bookings WHERE id = ?', [l.id]);
  is(await webhook(paidEvent(l2, acctA)), 200);
  assert.equal((await q('SELECT pay_status FROM bulk_bookings WHERE id = ?', [l.id]))[0].pay_status, 'paid');
  is(await api('POST', '/solid-waste/bookings', { token: crewA.token, body: body(4, { pay: 'office_paid' }) }), 403, 'the crew does not take bookings');
  // A text link needs a yes to texts.
  const noYes = await api('POST', '/solid-waste/bookings', { token: deskA.token, body: body(5, { pay: 'link', link_by: 'text', texts_ok: false }) });
  is(noYes, 400);
  // Staff search finds it by name for the front desk; the crew sees no contact details.
  const found = (await api('GET', `/solid-waste/bookings?q=${encodeURIComponent('Resident 31')}`, { token: deskA.token })).body.data;
  assert.ok(found.some((x) => x.id === paid.body.id && x.phone));
  const crewList = (await api('GET', `/solid-waste/bookings?date=${D}`, { token: crewA.token })).body.data;
  assert.ok(crewList.length && crewList.every((x) => x.name === undefined && x.phone === undefined && x.email === undefined));
  void sm;
});

// ---------------------------------------------------------------- the crew
let todayStops;
test('collection day: the stop list is in street then house order, with counts by size', async () => {
  const today = todayIn(NY);
  const opts = (await api('GET', '/solid-waste/options', { token: A.token })).body;
  const sm = opts.sizes.find((x) => x.name === 'Small').id; const md = opts.sizes.find((x) => x.name === 'Medium').id;
  const add = (street, house, who, extra = {}) => api('POST', '/solid-waste/bookings', { token: A.token, body: { collection_date: today, street_id: street, house_number: house, items: [{ size_id: sm, quantity: 1 }, { size_id: md, quantity: 1 }], pay: 'office_paid', override: true, ...who, ...extra } });
  const [main, bridge] = streets[A.id];
  todayStops = {
    yes: (await add(main, '12', resident(40))).body.id,
    no: (await add(main, '9', resident(41, { texts_ok: false, emails_ok: false }))).body.id,
    stop: (await add(bridge, '100', resident(42))).body.id,
    later: (await add(main, '100', resident(43))).body.id,
  };
  const day = (await api('GET', `/solid-waste/day?date=${today}`, { token: crewA.token })).body;
  assert.deepEqual(day.stops.map((x) => x.address), ['100 Bridge Street', '9 Main Street', '12 Main Street', '100 Main Street']);
  assert.deepEqual(day.sizes, [{ name: 'Small', quantity: 4 }, { name: 'Medium', quantity: 4 }]);
  assert.equal(day.outcomes.left, 4);
  assert.ok(day.stops.every((x) => x.name === undefined), 'the crew list has no names or phones');
  const office = (await api('GET', `/solid-waste/day?date=${today}`, { token: deskA.token })).body;
  assert.ok(office.stops.every((x) => x.name), 'the office print view has them');
});

test('Not out needs a photo; the resident is told only if they said yes, and never sent the photo', async () => {
  const no = await api('POST', `/solid-waste/bookings/${todayStops.yes}/outcome`, { token: crewA.token, body: { outcome: 'not_out' } });
  is(no, 400); assert.match(no.body.error, /photo/);
  const up = await call('POST', `/api/v1/solid-waste/bookings/${todayStops.yes}/photos?lat=40.13&lng=-75.51`, { token: crewA.token, raw: JPEG });
  is(up, 201);
  assert.equal(up.body.sha256, crypto.createHash('sha256').update(JPEG).digest('hex'), 'kept exactly as taken');
  const wrong = await call('POST', `/api/v1/solid-waste/bookings/${todayStops.no}/photos`, { token: crewA.token, raw: JPEG });
  is(await api('POST', `/solid-waste/bookings/${todayStops.yes}/outcome`, { token: crewA.token, body: { outcome: 'not_out', photo_id: wrong.body.id } }), 400, 'a photo from another stop does not count');
  const before = sink.length;
  const ok = await api('POST', `/solid-waste/bookings/${todayStops.yes}/outcome`, { token: crewA.token, body: { outcome: 'not_out', photo_id: up.body.id, lat: 40.13, lng: -75.51 } });
  is(ok, 200); assert.deepEqual(ok.body.told.sort(), ['email', 'text']);
  const sms = texts(before);
  assert.equal(sms.length, 1); assert.match(sms[0].get('Body'), /nothing was out at the curb/);
  assert.ok(!sms[0].get('MediaUrl') && !/photo/i.test(sms[0].get('Body')), 'no photo goes to the resident');
  const [row] = await q('SELECT outcome, outcome_photo_id, outcome_lat, notified_via FROM bulk_bookings WHERE id = ?', [todayStops.yes]);
  assert.equal(row.outcome, 'not_out'); assert.equal(row.outcome_photo_id, up.body.id); assert.equal(Number(row.outcome_lat), 40.13); assert.equal(row.notified_via, 'text,email');
  // Marking it again does not tell them twice.
  const again = await api('POST', `/solid-waste/bookings/${todayStops.yes}/outcome`, { token: crewA.token, body: { outcome: 'not_out', photo_id: up.body.id } });
  assert.deepEqual(again.body.told, []);
  // No yes to texts or email: nothing goes out.
  const before2 = sink.length;
  const quiet = await api('POST', `/solid-waste/bookings/${todayStops.no}/outcome`, { token: crewA.token, body: { outcome: 'not_accepted', photo_id: wrong.body.id, reason: 'Paint cans' } });
  is(quiet, 200); assert.deepEqual(quiet.body.told, []);
  assert.equal(texts(before2).length + emails(before2).length, 0);
  // Not accepted needs a reason.
  const p3 = await call('POST', `/api/v1/solid-waste/bookings/${todayStops.later}/photos`, { token: crewA.token, raw: JPEG });
  is(await api('POST', `/solid-waste/bookings/${todayStops.later}/outcome`, { token: crewA.token, body: { outcome: 'not_accepted', photo_id: p3.body.id } }), 400);
  is(await api('POST', `/solid-waste/bookings/${todayStops.later}/outcome`, { token: crewA.token, body: { outcome: 'picked_up' } }), 200);
  // The photo opens for staff with its fingerprint.
  const img = await call('GET', `/api/v1/solid-waste/bookings/${todayStops.yes}/photos/${up.body.id}`, { token: deskA.token });
  is(img, 200); assert.equal(img.headers.get('x-content-sha256'), up.body.sha256);
  is(await api('POST', `/solid-waste/bookings/${todayStops.later}/outcome`, { token: deskA.token, body: { outcome: 'picked_up' } }), 403, 'the front desk does not mark stops');
});

test('STOP is honored: a resident who texted STOP is not texted about a not-out stop', async () => {
  assert.equal(await twilioReply('+16105550142', 'STOP'), 200);
  const [r] = await q('SELECT r.texts_ok FROM residents r JOIN bulk_bookings b ON b.resident_id = r.id AND b.tenant_id = r.tenant_id WHERE b.id = ?', [todayStops.stop]);
  assert.equal(r.texts_ok, 0);
  const up = await call('POST', `/api/v1/solid-waste/bookings/${todayStops.stop}/photos`, { token: crewA.token, raw: JPEG });
  const before = sink.length;
  const ok = await api('POST', `/solid-waste/bookings/${todayStops.stop}/outcome`, { token: crewA.token, body: { outcome: 'not_out', photo_id: up.body.id } });
  is(ok, 200); assert.deepEqual(ok.body.told, ['email'], 'email still, since they said yes to it');
  assert.equal(texts(before).length, 0);
});

test('the one STOP rule: ticking "text me" on a new booking does not undo a texted STOP; only a texted START does', async () => {
  const opts = (await api('GET', '/solid-waste/options', { token: A.token })).body;
  const D = opts.days.find((d) => d.available).date;
  const sm = opts.sizes.find((x) => x.name === 'Small').id;
  const book = (house) => api('POST', '/solid-waste/bookings', { token: deskA.token, body: { collection_date: D, street_id: streets[A.id][1], house_number: house, items: [{ size_id: sm, quantity: 1 }], pay: 'office_paid', ...resident(42) } });
  // The phone that texted STOP books again and the front desk ticks that they agree to texts: no text, and the answer says why.
  let before = sink.length;
  const again = await book('102');
  is(again, 201);
  assert.equal(again.body.texts_off, 'This phone has texts turned off. Text START to 555-555-0100 to turn them back on.');
  assert.deepEqual(again.body.sent, ['email']);
  assert.equal(texts(before).length, 0, 'still no text');
  const [r] = await q('SELECT r.id, r.texts_ok FROM residents r JOIN bulk_bookings b ON b.resident_id = r.id AND b.tenant_id = r.tenant_id WHERE b.id = ?', [again.body.id]);
  assert.equal(r.texts_ok, 0, 'the box did not turn texts back on');
  // The resident's own booking page says the same thing.
  const tok = (await q('SELECT view_token FROM bulk_bookings WHERE id = ?', [again.body.id]))[0].view_token;
  const page = await api('GET', `/public/${A.slug}/bulk-pickup/bookings/${tok}`);
  is(page, 200); assert.match(page.body.texts_off, /^This phone has texts turned off\. Text START to 555-555-0100 to turn them back on\.$/);
  // START by text turns them back on, and the next booking is confirmed by text.
  assert.equal(await twilioReply('+16105550142', 'START'), 200);
  assert.equal((await q('SELECT texts_ok FROM residents WHERE id = ?', [r.id]))[0].texts_ok, 1);
  const hist = await q("SELECT status, source FROM resident_consent WHERE tenant_id = ? AND resident_id = ? AND channel = 'sms' ORDER BY id DESC LIMIT 2", [A.id, r.id]);
  assert.deepEqual(hist.map((x) => `${x.status}/${x.source}`), ['opted_in/text_reply', 'opted_out/text_reply']);
  before = sink.length;
  const third = await book('104');
  is(third, 201);
  assert.equal(third.body.texts_off, undefined);
  assert.ok(third.body.sent.includes('text') && texts(before).length === 1, 'texted again after START');
  assert.equal((await api('GET', `/public/${A.slug}/bulk-pickup/bookings/${tok}`)).body.texts_off, null);
});

test('a manager decides a not-out stop: no refund, a refund, or a credit used for the next booking', async () => {
  is(await api('POST', `/solid-waste/bookings/${todayStops.yes}/decision`, { token: deskA.token, body: { decision: 'refund' } }), 403);
  is(await api('POST', `/solid-waste/bookings/${todayStops.later}/decision`, { token: A.token, body: { decision: 'refund' } }), 409, 'only a not-out or not-accepted stop');
  const credit = await api('POST', `/solid-waste/bookings/${todayStops.yes}/decision`, { token: A.token, body: { decision: 'credit', note: 'Rebook free' } });
  is(credit, 200); assert.equal(credit.body.decision_cents, 4000);
  is(await api('POST', `/solid-waste/bookings/${todayStops.yes}/decision`, { token: A.token, body: { decision: 'refund' } }), 409, 'decided once');
  const refund = await api('POST', `/solid-waste/bookings/${todayStops.no}/decision`, { token: A.token, body: { decision: 'refund' } });
  is(refund, 200);
  assert.equal((await q('SELECT pay_status FROM bulk_bookings WHERE id = ?', [todayStops.no]))[0].pay_status, 'refund_due', 'paid at the office, so refunded at the office');
  is(await api('POST', `/solid-waste/bookings/${todayStops.no}/refund-given`, { token: deskA.token }), 200);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'bulk_decision'", [A.id])).length >= 2);
  // The credit pays for a new booking once.
  const opts = (await api('GET', '/solid-waste/options', { token: deskA.token })).body;
  const D = opts.days.find((d) => d.available).date;
  const body = { collection_date: D, street_id: streets[A.id][0], house_number: '12', items: [{ size_id: opts.sizes.find((x) => x.name === 'Large').id, quantity: 1 }], pay: 'credit', credit_ref: credit.body.reference, ...resident(40) };
  const used = await api('POST', '/solid-waste/bookings', { token: deskA.token, body });
  is(used, 201);
  assert.equal((await q('SELECT pay_method, pay_status FROM bulk_bookings WHERE id = ?', [used.body.id]))[0].pay_method, 'credit');
  is(await api('POST', '/solid-waste/bookings', { token: deskA.token, body }), 400, 'a credit is used once');
});

// ---------------------------------------------------------------- reminder, report, Today, export
test('the reminder goes the afternoon before, once, only to residents who said yes', async () => {
  const bulk = require('../src/lib/bulkpickup');
  const today = todayIn(NY); const tomorrow = plus(today, 1);
  await settings(A, { collection_days: [wd(today), wd(tomorrow)], cutoff_days_before: 1, cutoff_time: '12:00' });
  const opts = (await api('GET', '/solid-waste/options', { token: A.token })).body;
  const mk = async (k, who) => (await api('POST', '/solid-waste/bookings', { token: A.token, body: { collection_date: tomorrow, street_id: streets[A.id][2], house_number: String(k), items: [{ size_id: opts.sizes[0].id, quantity: 1 }], pay: 'stickers', override: true, ...who } })).body.id;
  const yes = await mk(51, resident(51, { emails_ok: false }));
  await mk(52, resident(52, { texts_ok: false, emails_ok: false }));
  const before = sink.length;
  await bulk.remindDue('https://app.test', { now: `${today} 09:00:00` });
  assert.equal(texts(before).filter((t) => t.get('To') === '+16105550151').length, 0, 'not in the morning');
  await bulk.remindDue('https://app.test', { now: `${today} 16:00:00` });
  await bulk.remindDue('https://app.test', { now: `${today} 16:05:00` });
  const sent = texts(before).filter((t) => /curb by 6:00 AM/.test(t.get('Body')));
  assert.equal(sent.filter((t) => t.get('To') === '+16105550151').length, 1, 'once');
  assert.equal(sent.filter((t) => t.get('To') === '+16105550152').length, 0, 'no yes, no reminder');
  assert.ok((await q('SELECT reminded_at FROM bulk_bookings WHERE id = ?', [yes]))[0].reminded_at);
});

test('the report adds up by month: bookings, items, money and the not-out rate', async () => {
  const r = await api('GET', '/solid-waste/report', { token: A.token });
  is(r, 200);
  const month = todayIn(NY).slice(0, 7);
  const mine = await q(`SELECT COUNT(*) AS bookings, SUM(paid_cents) AS paid, SUM(refunded_cents) AS refunded, SUM(outcome = 'not_out') AS no_out,
      SUM(outcome IS NOT NULL) AS visited FROM bulk_bookings WHERE tenant_id = ? AND status = 'booked' AND DATE_FORMAT(collection_date, '%Y-%m') = ?`, [A.id, month]);
  const m = r.body.months.find((x) => x.month === month);
  if (!m) return; // every booking above fell in next month (the very end of a month)
  assert.equal(m.bookings, Number(mine[0].bookings));
  assert.equal(m.revenue_cents, Number(mine[0].paid) - Number(mine[0].refunded));
  assert.equal(m.not_out, Number(mine[0].no_out));
  assert.equal(m.not_out_rate, Math.round((Number(mine[0].no_out) / Number(mine[0].visited)) * 1000) / 10);
  is(await api('GET', '/solid-waste/report', { token: deskA.token }), 403, 'managers only');
});

test('the report counts exactly in a fresh municipality', async () => {
  const today = todayIn('Pacific/Pago_Pago'); // P's own day (it is on Pago Pago time), whatever the hour the test runs
  const s = await settings(P, { collection_days: [0, 1, 2, 3, 4, 5, 6], cutoff_days_before: 1, cutoff_time: '00:00', capacity: 50 });
  // Two at the office ($35 + $15), one with stickers; one not out, one picked up, one canceled.
  const mk = (k, items, pay) => api('POST', '/solid-waste/bookings', { token: P.token, body: { collection_date: today, street_id: streets[P.id][0], house_number: String(k), items, pay, override: true, ...resident(60 + k, { texts_ok: false, emails_ok: false }) } });
  const a = (await mk(1, [{ size_id: sizeId(s, 'Large'), quantity: 1 }], 'office_paid')).body.id;
  const b = (await mk(2, [{ size_id: sizeId(s, 'Small'), quantity: 1 }, { size_id: sizeId(s, 'Metal'), quantity: 2 }], 'office_paid')).body.id;
  const c = (await mk(3, [{ size_id: sizeId(s, 'Medium'), quantity: 1 }], 'stickers')).body.id;
  const d = (await mk(4, [{ size_id: sizeId(s, 'Small'), quantity: 1 }], 'office_paid')).body.id;
  is(await api('POST', `/solid-waste/bookings/${d}/cancel`, { token: P.token, body: {} }), 200);
  const photo = await call('POST', `/api/v1/solid-waste/bookings/${a}/photos`, { token: P.token, raw: JPEG });
  is(await api('POST', `/solid-waste/bookings/${a}/outcome`, { token: P.token, body: { outcome: 'not_out', photo_id: photo.body.id } }), 200);
  is(await api('POST', `/solid-waste/bookings/${b}/outcome`, { token: P.token, body: { outcome: 'picked_up' } }), 200);
  void c;
  const r = (await api('GET', '/solid-waste/report', { token: P.token })).body;
  const m = r.months.find((x) => x.month === today.slice(0, 7));
  // The earlier Pago Pago booking (stickers) may fall in this month too.
  const extra = (await q("SELECT COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND status = 'booked' AND source = 'online' AND DATE_FORMAT(collection_date, '%Y-%m') = ?", [P.id, today.slice(0, 7)]))[0].n;
  assert.equal(m.bookings, 3 + Number(extra));
  assert.equal(m.items, 5 + Number(extra));
  assert.equal(m.office_cents, 5000); assert.equal(m.card_cents, 0); assert.equal(m.revenue_cents, 5000);
  assert.equal(m.cancelled, 1); assert.equal(m.not_out, 1); assert.equal(m.picked_up, 1); assert.equal(m.not_out_rate, 50);
  assert.equal(m.stickers, 1 + Number(extra));
});

test('Today: next collection day and booked against capacity; done and not out on collection day', async () => {
  const r = await api('GET', '/solid-waste/today', { token: crewA.token });
  is(r, 200);
  const today = r.body.cards.find((c) => c.title === 'Bulk pickup today');
  assert.ok(today, JSON.stringify(r.body.cards));
  assert.match(today.text, /picked up, \d+ not out/);
  const next = r.body.cards.find((c) => /^Next bulk pickup/.test(c.title));
  assert.match(next.text, /of 40 stops booked, \d+ open/);
  assert.ok(r.body.cards.every((c) => !/Resident|610-555/.test(JSON.stringify(c))), 'no resident details on a card');
});

test('export: a public record version by default; contact details only for a manager, audited', async () => {
  const plain = await call('GET', '/api/v1/solid-waste/export', { token: deskA.token });
  is(plain, 200);
  assert.match(plain.headers.get('content-type'), /text\/csv/);
  assert.ok(!/Rae Resident|610-555|example\.com|house_number/.test(plain.text), 'no names, phones, emails or house numbers');
  assert.match(plain.text, /Main Street/);
  is(await call('GET', '/api/v1/solid-waste/export?contacts=1', { token: deskA.token }), 403);
  const full = await call('GET', '/api/v1/solid-waste/export?contacts=1', { token: mgrA.token });
  is(full, 200); assert.match(full.text, /Rae Resident/);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'bulk_export_contacts' AND user_id = ?", [A.id, mgrA.id])).length);
});

// ---------------------------------------------------------------- gating, isolation, privacy
test('the app is gated: off for a municipality without it and for a ski area', async () => {
  is(await api('GET', '/solid-waste/today', { token: C.token }), 403);
  is(await pub('GET', C.slug, ''), 404, 'no public page either');
  is(await api('GET', '/solid-waste/today', { token: skiToken }), 403);
  is(await pub('GET', `tr-ski-${suffix}`, ''), 404);
  const page = await call('GET', `/bulk-pickup/${A.slug}`);
  is(page, 200); assert.match(page.text, /bulkpage\.js/);
});

test('tenant isolation: one municipality never reaches another\'s bookings, photos or stops', async () => {
  const [bk] = await q('SELECT id, view_token FROM bulk_bookings WHERE tenant_id = ? LIMIT 1', [B.id]);
  is(await api('GET', `/solid-waste/bookings/${bk.id}`, { token: A.token }), 404);
  is(await api('POST', `/solid-waste/bookings/${bk.id}/cancel`, { token: A.token, body: {} }), 404);
  is(await api('POST', `/solid-waste/bookings/${bk.id}/outcome`, { token: crewA.token, body: { outcome: 'picked_up' } }), 404);
  is(await call('POST', `/api/v1/solid-waste/bookings/${bk.id}/photos`, { token: crewA.token, raw: JPEG }), 404);
  const list = (await api('GET', '/solid-waste/bookings?show=all', { token: A.token })).body.data;
  assert.ok(!list.some((x) => x.id === bk.id));
  is(await pub('GET', A.slug, `/bookings/${bk.view_token}`), 404);
  // A street from another municipality is refused.
  const s = (await api('GET', '/solid-waste/options', { token: A.token })).body;
  const r = await pub('POST', A.slug, '/bookings', { body: { collection_date: s.days.find((d) => d.available).date, street_id: streets[B.id][0], house_number: '1', items: [{ size_id: s.sizes[0].id, quantity: 1 }], pay: 'stickers', ...resident(70) } });
  is(r, 400); assert.match(r.body.error, /street/);
});

test('the public page shows no one\'s bookings, names or addresses', async () => {
  const page = await pub('GET', A.slug, '');
  is(page, 200);
  const text = JSON.stringify(page.body);
  assert.ok(!/Rae Resident|610-555|example\.com|"house_number"|"booked"|"left"|"capacity"/.test(text), text.slice(0, 400));
  for (const d of page.body.days) assert.deepEqual(Object.keys(d).sort(), ['available', 'cutoff_at', 'cutoff_words', 'date', 'label', 'reason']);
  // A made-up link finds nothing, and says nothing about whether it exists.
  is(await pub('GET', A.slug, `/bookings/${'0'.repeat(32)}`), 404);
  is(await pub('GET', A.slug, '/bookings/not-a-token'), 404);
});

test('migration: running it again changes nothing', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['db/migrate.js'], { cwd: require('node:path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.match(out, /\(0 changes applied\)/);
});

test('demo data: Riverbend\'s settings, ten weeks of past Mondays and 22 stops next Monday, once', async () => {
  const demo = require('../db/demo-municipal/40-trash');
  messagingOff();
  const D = await createMuniTenant(base, { slug: `tr-demo-${suffix}`, modules: { solidwaste: true } });
  messagingOn();
  await addStreets(D, ['Front Street', 'Gay Street', 'High Street', 'Hall Street', 'Nutt Road']);
  const conn = await pool.getConnection();
  try {
    await demo(conn, D.id, {});
    const count = async () => (await q('SELECT COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ?', [D.id]))[0].n;
    const first = await count();
    await demo(conn, D.id, {});
    assert.equal(await count(), first, 'a second run adds nothing');
  } finally { conn.release(); }
  const s = (await api('GET', '/solid-waste/settings', { token: D.token })).body;
  assert.deepEqual(s.collection_days, [1]); assert.equal(s.cutoff_days_before, 4); assert.equal(s.cutoff_time, '12:00'); assert.equal(s.capacity, 40);
  const today = todayIn(NY);
  let mon = plus(today, 1); while (wd(mon) !== 1) mon = plus(mon, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND collection_date = ? AND status = 'booked'", [D.id, mon]))[0].n, 22);
  const past = await q('SELECT COUNT(DISTINCT collection_date) AS days, SUM(outcome = \'not_out\') AS no FROM bulk_bookings WHERE tenant_id = ? AND collection_date < ?', [D.id, today]);
  assert.ok(Number(past[0].days) >= 9, `past Mondays: ${past[0].days}`);
  assert.ok(Number(past[0].no) >= 1, 'some not-outs');
  assert.equal((await q("SELECT COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND pay_method = 'card'", [D.id]))[0].n, 0, 'no card payments in the demo');
  const r = (await api('GET', '/solid-waste/report', { token: D.token })).body;
  assert.ok(r.months.length >= 2);
});
