'use strict';

// Trash and recycling, the full app (release 2026.11.22, workstream "tonnage"): carts and cart requests (the public page,
// staff entry, the fee paid on the municipality's own Stripe account, refunds), cart stock that never goes below zero,
// weigh tickets (the math, checks, photos, a facility's spreadsheet with bad lines), the tonnage figures (recycling rate,
// pounds per household, cost per ton for managers only), the monthly report's section, the annual recycling report
// (reporters, the tokened form, reminders and the follow-up list, the DEP / county columns with residue deducted, the
// Section 904 packet), nomoney for the crew and the front desk, the Right-to-Know export, gating, tenant isolation.
// Stripe, Twilio and Postmark are one mock server, as in muni-trash.test.js.
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
const MESSAGING = { POSTMARK_SERVER_TOKEN: 'pm', MAIL_FROM: 'noreply@test.example', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'twilio-token', TWILIO_FROM: '+15555550100' };
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

const KEY = 'test-bootstrap-key';
const PW = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base; let mock; let n = 0;
const sink = [];
const q = async (sql, params) => (await pool.query(sql, params))[0];
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const NY = 'America/New_York';
const TODAY = todayIn(NY);

async function call(method, path, { token, body, raw } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw || (body === undefined ? undefined : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8'); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text, buf, headers: res.headers };
}
const api = (m, p, o) => call(m, `/api/v1${p}`, o);
const sw = (m, p, o) => api(m, `/solid-waste${p}`, o);
const pub = (m, slug, p, o) => call(m, `/api/v1/public/${slug}${p}`, o);
const is = (r, status, why) => assert.equal(r.status, status, `${why || ''} ${(r.text || JSON.stringify(r.body) || '').slice(0, 400)}`);
const emails = (from) => sink.slice(from).filter((x) => x.u.startsWith('/email')).map((x) => JSON.parse(x.b));
const stripeCalls = (from) => sink.slice(from).filter((x) => x.u.startsWith('/v1/'));
async function webhook(event, secret = 'whsec_connect') {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, secret) }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const paidEvent = (row, acct, extra = {}) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', account: acct,
  data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.fee_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(row.tenant_id), request_id: String(row.id), kind: 'cart', ...extra } } } });
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]), crypto.randomBytes(200), Buffer.from([0xff, 0xd9])]);

/** A small JPEG with an EXIF block: DateTimeOriginal and a GPS position (as test/fieldkit.test.js makes it). */
function jpegWithGps({ when = '2026:01:17 10:42:05', lat = [40, 7, 48], lng = [75, 30, 54] } = {}) {
  const tiff = Buffer.alloc(400);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  let o = 8; tiff.writeUInt16LE(2, o); o += 2;
  const exifAt = 38;
  tiff.writeUInt16LE(0x8769, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(exifAt, o + 8); o += 12;
  const gpsAt = exifAt + 2 + 12 + 4 + 20;
  tiff.writeUInt16LE(0x8825, o); tiff.writeUInt16LE(4, o + 2); tiff.writeUInt32LE(1, o + 4); tiff.writeUInt32LE(gpsAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  o = exifAt; tiff.writeUInt16LE(1, o); o += 2;
  const dateAt = exifAt + 2 + 12 + 4;
  tiff.writeUInt16LE(0x9003, o); tiff.writeUInt16LE(2, o + 2); tiff.writeUInt32LE(20, o + 4); tiff.writeUInt32LE(dateAt, o + 8); o += 12;
  tiff.writeUInt32LE(0, o);
  tiff.write(`${when}\0`, dateAt, 'latin1');
  o = gpsAt; tiff.writeUInt16LE(4, o); o += 2;
  const ratAt = gpsAt + 2 + 4 * 12 + 4;
  const ent = (tag, type, count, valueOrOffset, inline) => { tiff.writeUInt16LE(tag, o); tiff.writeUInt16LE(type, o + 2); tiff.writeUInt32LE(count, o + 4); if (inline) tiff.write(inline, o + 8, 'latin1'); else tiff.writeUInt32LE(valueOrOffset, o + 8); o += 12; };
  ent(1, 2, 2, 0, 'N\0'); ent(2, 5, 3, ratAt); ent(3, 2, 2, 0, 'W\0'); ent(4, 5, 3, ratAt + 24);
  tiff.writeUInt32LE(0, o);
  [...lat, ...lng].forEach((v, i) => { tiff.writeUInt32LE(v, ratAt + i * 8); tiff.writeUInt32LE(1, ratAt + i * 8 + 4); });
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, ratAt + 48)]);
  const app1 = Buffer.alloc(4); app1.writeUInt16BE(0xffe1, 0); app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xda, 0x00, 0x02]), crypto.randomBytes(256), Buffer.from([0xff, 0xd9])]);
}

const { photoFacts } = require('../src/lib/exif');

let A; let B; let C; let skiToken; let crewA; let deskA; let mgrA;
const S = {}; // per tenant: { streets: [ids], trash, recycling, yard, zoneN, zoneS }

/** Streets, streams and zones made directly (workstream "schedule" owns their screens). */
async function setUp(m) {
  const streets = [];
  for (const name of ['Main Street', 'Bridge Street', 'Church Street', 'Oak Lane']) streets.push((await q('INSERT INTO streets (tenant_id, name) VALUES (?, ?)', [m.id, name])).insertId);
  const stream = async (name, kind, sort) => (await q('INSERT INTO collection_streams (tenant_id, name, kind, frequency, sort) VALUES (?, ?, ?, ?, ?)', [m.id, name, kind, 'weekly', sort])).insertId;
  const s = { streets, trash: await stream('Trash', 'trash', 1), recycling: await stream('Recycling', 'recycling', 2), yard: await stream('Yard waste', 'yard', 3) };
  s.zoneN = (await q("INSERT INTO collection_zones (tenant_id, name, sort) VALUES (?, 'Monday north', 1)", [m.id])).insertId;
  s.zoneS = (await q("INSERT INTO collection_zones (tenant_id, name, sort) VALUES (?, 'Thursday south', 2)", [m.id])).insertId;
  await q('INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id) VALUES (?, ?, ?)', [m.id, s.zoneN, streets[0]]);
  await q("INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, 1, 99, 'odd')", [m.id, s.zoneS, streets[1]]);
  await q("INSERT INTO collection_zone_streets (tenant_id, zone_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, 1, 99, 'even')", [m.id, s.zoneN, streets[1]]);
  S[m.id] = s;
  return s;
}
const resident = (k, extra = {}) => ({ name: `Rae Resident ${k}`, phone: `610-555-02${String(k).padStart(2, '0')}`, email: `rae${k}-${suffix}@example.com`, texts_ok: false, emails_ok: true, ...extra });
async function setup(m, change = {}) {
  const s = S[m.id];
  const body = { online: true, max_extra: 1, rules_text: null, options: [
    { stream_id: s.trash, size_gal: 65, extra_fee_cents: 6500, replacement_fee_cents: 5000, active: true },
    { stream_id: s.trash, size_gal: 95, extra_fee_cents: 7500, replacement_fee_cents: 5500, active: true },
    { stream_id: s.recycling, size_gal: 65, extra_fee_cents: 0, replacement_fee_cents: 0, active: true },
  ], ...change };
  const r = await sw('PUT', '/carts/setup', { token: m.token, body });
  is(r, 200, 'cart setup saved');
  return r.body;
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = ''; req.on('data', (c) => { data += c; });
    req.on('end', () => {
      sink.push({ u: req.url, b: data, h: req.headers, account: req.headers['stripe-account'] || null });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/email')) return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `pm${sink.length}` }));
      if (req.url.includes('/Messages.json')) return res.end(JSON.stringify({ sid: `SM${sink.length}` }));
      if (req.url === '/v1/checkout/sessions') return res.end(JSON.stringify({ id: `cs_cart_${++n}`, url: `https://checkout.stripe.test/c/${n}` }));
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
  A = await createMuniTenant(base, { slug: `tn-a-${suffix}`, name: `Riverton Borough ${suffix}`, modules: { solidwaste: true } });
  B = await createMuniTenant(base, { slug: `tn-b-${suffix}`, name: `Lakeview Township ${suffix}`, modules: { solidwaste: true } });
  C = await createMuniTenant(base, { slug: `tn-c-${suffix}`, name: `Hillside Borough ${suffix}` }); // no Trash and recycling app
  for (const m of [A, B, C]) await setUp(m);
  crewA = await A.addLogin('staff'); deskA = await A.addLogin('counter'); mgrA = await A.addLogin('manager');
  const ski = await fetch(`${base}/api/v1/platform/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-platform-key': KEY }, body: JSON.stringify({ slug: `tn-ski-${suffix}`, name: `Pine Ridge ${suffix}`, billing: 'comped', owner: { email: `gm@tn-ski-${suffix}.test`, password: PW, first_name: 'G', last_name: 'M' } }) });
  assert.equal(ski.status, 201);
  skiToken = (await api('POST', '/auth/login', { body: { tenant: `tn-ski-${suffix}`, login: `gm@tn-ski-${suffix}.test`, password: PW } })).body.token;
  messagingOn();
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

// ---------------------------------------------------------------- setup and the public page
test('a manager sets the cart sizes and fees per stream; the front desk and crew cannot', async () => {
  const first = (await sw('GET', '/carts/setup', { token: A.token })).body;
  assert.equal(first.online, true); assert.equal(first.max_extra, 2); assert.deepEqual(first.options, []); assert.deepEqual(first.sizes, [35, 65, 95]);
  assert.match(first.page, new RegExp(`/cart-request/${A.slug}$`));
  const s = await setup(A);
  assert.equal(s.options.length, 3);
  assert.equal(s.options.find((o) => o.size_gal === 95).extra_fee_cents, 7500);
  is(await sw('GET', '/carts/setup', { token: deskA.token }), 403);
  is(await sw('PUT', '/carts/setup', { token: crewA.token, body: {} }), 403);
  const bad = await sw('PUT', '/carts/setup', { token: A.token, body: { online: true, max_extra: 1, options: [{ stream_id: S[A.id].trash, size_gal: 50, extra_fee_cents: 0, replacement_fee_cents: 0 }] } });
  is(bad, 400, 'only 35, 65 or 95 gallons');
  const other = await sw('PUT', '/carts/setup', { token: A.token, body: { online: true, max_extra: 1, options: [{ stream_id: S[B.id].trash, size_gal: 65, extra_fee_cents: 0, replacement_fee_cents: 0 }] } });
  is(other, 400, 'another municipality\'s stream');
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'cart_setup'", [A.id])).length, 'audited');
});

test('the public page shows the streams, sizes and fees, and no one\'s carts or requests', async () => {
  const p = await pub('GET', A.slug, '/cart-request');
  is(p, 200);
  assert.equal(p.body.open, true);
  assert.deepEqual(p.body.streams.map((s) => s.name), ['Trash', 'Recycling']);
  assert.deepEqual(p.body.streams[0].sizes.map((x) => [x.size_gal, x.extra_fee_cents]), [[65, 6500], [95, 7500]]);
  assert.equal(p.body.card, false);
  assert.ok(!/house_number|Rae|example\.com/.test(p.text));
  const closed = await pub('GET', B.slug, '/cart-request');
  is(closed, 200); assert.equal(closed.body.open, false, 'no sizes set: call the office');
  is(await pub('GET', C.slug, '/cart-request'), 404, 'the app is off');
  is(await pub('GET', `tn-ski-${suffix}`, '/cart-request'), 404, 'a ski area has no such page');
  const page = await call('GET', `/cart-request/${A.slug}`);
  is(page, 200); assert.ok(page.text.includes('/js/cartpage.js'), 'the page is served at /cart-request/<municipality>');
  const form = await call('GET', `/hauler-report/${A.slug}/${'x'.repeat(43)}`);
  is(form, 200); assert.ok(form.text.includes('/js/haulerreportpage.js'));
});

let freeReq;
test('a free request (a new home\'s cart) is taken online: a reference, a link, a confirmation email; staff see it waiting', async () => {
  const before = sink.length;
  const r = await pub('POST', A.slug, '/cart-request', { body: { kind: 'new', stream_id: S[A.id].recycling, size_gal: 65, street_id: S[A.id].streets[0], house_number: '12', ...resident(1) } });
  is(r, 201);
  assert.match(r.body.reference, /^C[A-Z2-9]{5}$/); assert.equal(r.body.fee_cents, 0); assert.equal(r.body.checkout_url, undefined);
  freeReq = r.body;
  assert.ok(emails(before).some((m) => m.TextBody.includes(r.body.reference)), 'confirmation by email');
  const v = await pub('GET', A.slug, `/cart-request/${r.body.token}`);
  is(v, 200); assert.equal(v.body.status, 'open'); assert.equal(v.body.address, '12 Main Street'); assert.equal(v.body.can_cancel, true);
  is(await pub('GET', A.slug, `/cart-request/${'0'.repeat(32)}`), 404);
  is(await pub('GET', B.slug, `/cart-request/${r.body.token}`), 404, 'a link only works on its own municipality\'s page');
  const desk = (await sw('GET', '/carts/requests?show=waiting', { token: deskA.token })).body.data.find((x) => x.reference === r.body.reference);
  assert.equal(desk.name, 'Rae Resident 1', 'the front desk sees who asked');
  const crew = (await sw('GET', '/carts/requests?show=waiting', { token: crewA.token })).body.data.find((x) => x.reference === r.body.reference);
  assert.equal(crew.name, undefined); assert.equal(crew.email, undefined, 'the crew sees the address only');
  // The count beside the app and the Today card come from the same function.
  const counts = (await api('GET', '/nav/counts', { token: deskA.token })).body;
  const today = (await sw('GET', '/carts/today', { token: deskA.token })).body.cards.find((c) => c.title === 'Cart requests waiting');
  assert.ok(counts.counts ? counts.counts.bulk : counts.bulk, JSON.stringify(counts));
  assert.equal((counts.counts || counts).bulk.n, today.count);
  is(await sw('GET', '/carts/today', { token: crewA.token }), 403, 'the crew\'s Today has no desk card');
  const crewCounts = (await api('GET', '/nav/counts', { token: crewA.token })).body;
  assert.equal((crewCounts.counts || crewCounts).bulk, undefined, 'not counted for the crew');
  const nw = (await api('GET', '/nav/new', { token: deskA.token })).body.items;
  assert.ok(nw.includes('cart_request') && nw.includes('weigh_ticket'));
  assert.ok(!(await api('GET', '/nav/new', { token: crewA.token })).body.items.includes('cart_request'));
});

test('a request with a fee and no Stripe account is taken as "pay at the office"', async () => {
  const r = await pub('POST', A.slug, '/cart-request', { body: { kind: 'extra', stream_id: S[A.id].trash, size_gal: 95, street_id: S[A.id].streets[1], house_number: '7', ...resident(2) } });
  is(r, 201);
  assert.equal(r.body.pay_method, 'office'); assert.equal(r.body.fee_cents, 7500); assert.match(r.body.message, /\$75\.00/);
  const bad = await pub('POST', A.slug, '/cart-request', { body: { kind: 'extra', stream_id: S[A.id].trash, size_gal: 35, street_id: S[A.id].streets[1], house_number: '7', ...resident(2) } });
  is(bad, 400, 'a size not offered'); assert.match(bad.body.error, /not offered/);
  is(await pub('POST', A.slug, '/cart-request', { body: { kind: 'new', stream_id: S[A.id].trash, size_gal: 65, street_id: S[B.id].streets[0], house_number: '7', ...resident(2) } }), 400, 'another municipality\'s street');
  is(await pub('POST', A.slug, '/cart-request', { body: { kind: 'new', stream_id: S[A.id].trash, size_gal: 65, street_id: S[A.id].streets[0], house_number: '7', name: 'No Contact' } }), 400, 'a phone or email is needed');
  const robot = await pub('POST', A.slug, '/cart-request', { body: { kind: 'new', stream_id: S[A.id].trash, size_gal: 65, street_id: S[A.id].streets[0], house_number: '7', website: 'x', ...resident(3) } });
  is(robot, 202);
});

let acctA; let cardReq;
test('a fee is paid on the municipality\'s own Stripe account; the webhook takes it once', async () => {
  acctA = `acct_cart${suffix.replace(/\W/g, '')}`;
  await q('UPDATE tenants SET stripe_account = ?, stripe_charges_enabled = 1, stripe_payouts_enabled = 1 WHERE id = ?', [acctA, A.id]);
  assert.equal((await pub('GET', A.slug, '/cart-request')).body.card, true);
  const before = sink.length;
  const r = await pub('POST', A.slug, '/cart-request', { body: { kind: 'extra', stream_id: S[A.id].trash, size_gal: 65, street_id: S[A.id].streets[2], house_number: '30', ...resident(4) } });
  is(r, 201);
  assert.match(r.body.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  const co = stripeCalls(before).find((c) => c.u === '/v1/checkout/sessions');
  assert.equal(co.account, acctA, 'made on the municipality\'s account');
  const form = new URLSearchParams(co.b);
  assert.equal(form.get('metadata[kind]'), 'cart'); assert.equal(form.get('line_items[0][price_data][unit_amount]'), '6500');
  [cardReq] = await q('SELECT * FROM cart_requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  assert.equal(cardReq.status, 'awaiting_payment');
  const w = await webhook(paidEvent(cardReq, acctA));
  is(w, 200); assert.equal(w.body.ok, true);
  [cardReq] = await q('SELECT * FROM cart_requests WHERE id = ?', [cardReq.id]);
  assert.equal(cardReq.status, 'open'); assert.equal(cardReq.pay_status, 'paid'); assert.equal(cardReq.paid_cents, 6500); assert.equal(cardReq.processor_account, acctA);
  assert.equal((await webhook(paidEvent(cardReq, acctA))).body.duplicate, true, 'a repeated event changes nothing');
  const other = await webhook(paidEvent({ ...cardReq, stripe_session_id: 'cs_other' }, 'acct_someoneelse123'));
  assert.equal(other.body.ignored, true, 'another account naming this request is ignored');
});

test('a resident cancels: the card payment goes back in full through the municipality\'s account (card_returns)', async () => {
  const before = sink.length;
  const r = await pub('POST', A.slug, `/cart-request/${cardReq.view_token}/cancel`);
  is(r, 200);
  assert.equal(r.body.status, 'cancelled'); assert.equal(r.body.pay_status, 'refunded'); assert.equal(r.body.refunded_cents, 6500);
  const refund = stripeCalls(before).find((c) => c.u === '/v1/refunds');
  assert.ok(refund); assert.equal(refund.account, acctA);
  const [ret] = await q('SELECT * FROM card_returns WHERE tenant_id = ? AND payment_intent = ?', [A.id, cardReq.payment_intent]);
  assert.equal(ret.kind, 'cart'); assert.equal(ret.card_status, 'sent');
  is(await pub('POST', A.slug, `/cart-request/${cardReq.view_token}/cancel`), 409, 'already canceled');
  assert.ok(emails(before).some((m) => /going back to your card/.test(m.TextBody)));
});

test('a payment that lands on a canceled request, or for the wrong amount, is refunded in full', async () => {
  const r = await pub('POST', A.slug, '/cart-request', { body: { kind: 'replacement', stream_id: S[A.id].trash, size_gal: 65, street_id: S[A.id].streets[2], house_number: '32', ...resident(5) } });
  is(r, 201);
  let [row] = await q('SELECT * FROM cart_requests WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]);
  assert.equal(row.fee_cents, 5000);
  const before = sink.length;
  const wrong = await webhook(paidEvent({ ...row, fee_cents: 100 }, acctA));
  assert.equal(wrong.body.refunded, true);
  assert.equal(stripeCalls(before).filter((c) => c.u === '/v1/refunds').length, 1);
  [row] = await q('SELECT * FROM cart_requests WHERE id = ?', [row.id]);
  assert.equal(row.pay_status, 'due', 'not paid');
  is(await sw('POST', `/carts/requests/${row.id}/cancel`, { token: deskA.token, body: { reason: 'Found the old one' } }), 200);
  const evt = paidEvent(row, acctA); evt.data.object.payment_intent = `pi_late_${row.id}`;
  const stray = await webhook(evt);
  assert.equal(stray.body.refunded, true, 'paid after it was canceled: refunded');
});

// ---------------------------------------------------------------- staff entry and the checks
test('staff take a phone request: the checks refuse it unless overridden; only a manager waives a fee', async () => {
  const s = S[A.id];
  const cart = await sw('POST', '/carts', { token: crewA.token, body: { street_id: s.streets[3], house_number: '5', stream_id: s.trash, size_gal: 95, serial: 'T-0005' } });
  is(cart, 201, 'the crew puts a cart already at a house on record');
  const body = { kind: 'new', stream_id: s.trash, size_gal: 95, street_id: s.streets[3], house_number: '5', ...resident(6) };
  const no = await sw('POST', '/carts/requests', { token: deskA.token, body });
  is(no, 409); assert.equal(no.body.details.code, 'cart_checks'); assert.match(no.body.error, /already has a Trash cart/);
  const yes = await sw('POST', '/carts/requests', { token: deskA.token, body: { ...body, override: true } });
  is(yes, 201);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'cart_request' AND entity_id = ? AND detail LIKE '%override%'", [A.id, yes.body.id])).length, 'the override is audited');
  const dup = await sw('POST', '/carts/requests', { token: deskA.token, body });
  is(dup, 409); assert.match(dup.body.error, /already open/);
  // Extras: max_extra is 1, and the house has one Trash cart, so one extra is fine and a second is refused.
  // (an open request for a new cart counts as one more, so the one taken by override is canceled first)
  is(await sw('POST', `/carts/requests/${yes.body.id}/cancel`, { token: deskA.token, body: { reason: 'Taken by mistake' } }), 200);
  const extra = { ...body, kind: 'extra', pay: 'office_paid' };
  const e1 = await sw('POST', '/carts/requests', { token: deskA.token, body: extra });
  is(e1, 201); assert.equal(e1.body.fee_cents, undefined, 'the front desk never gets money amounts'); assert.equal(e1.body.fee_due, false);
  const e2 = await sw('POST', '/carts/requests', { token: deskA.token, body: extra });
  is(e2, 409); assert.match(e2.body.error, /up to 1 extra/);
  is(await sw('POST', '/carts/requests', { token: deskA.token, body: { ...extra, pay: 'waive', override: true } }), 403, 'only a manager waives a fee');
  const w = await sw('POST', '/carts/requests', { token: mgrA.token, body: { ...extra, pay: 'waive', override: true } });
  is(w, 201); assert.equal(w.body.fee_cents, 0);
  is(await sw('POST', '/carts/requests', { token: crewA.token, body }), 403, 'the crew does not take requests');
  // The public page never refuses on these checks (it would tell a stranger what an address has); staff see them instead.
  const p = await pub('POST', A.slug, '/cart-request', { body: { ...body, ...resident(7) } });
  is(p, 201);
  const [row] = await q('SELECT id FROM cart_requests WHERE tenant_id = ? AND reference = ?', [A.id, p.body.reference]);
  const seen = (await sw('GET', `/carts/requests/${row.id}`, { token: deskA.token })).body;
  assert.ok(seen.checks.some((c) => /already has a Trash cart/.test(c)));
  assert.ok(seen.link.includes(`/cart-request/${A.slug}?request=`));
});

// ---------------------------------------------------------------- stock, delivery, stops
test('stock never goes below zero: no cart in the yard, no delivery; receive, deliver, scrap, count', async () => {
  const s = S[A.id];
  const [r] = await q("SELECT id FROM cart_requests WHERE tenant_id = ? AND reference = ?", [A.id, freeReq.reference]);
  is(await sw('POST', `/carts/requests/${r.id}/schedule`, { token: deskA.token, body: { deliver_on: plus(TODAY, -1) } }), 400, 'not a past day');
  is(await sw('POST', `/carts/requests/${r.id}/schedule`, { token: deskA.token, body: { deliver_on: TODAY } }), 200);
  const none = await sw('POST', `/carts/requests/${r.id}/deliver`, { token: crewA.token, body: { serial: 'R-1' } });
  is(none, 409); assert.equal(none.body.details.code, 'no_stock'); assert.match(none.body.error, /^No 65-gallon Recycling carts are in the yard/);
  is(await sw('POST', '/carts/stock', { token: deskA.token, body: { stream_id: s.recycling, size_gal: 65, reason: 'received', quantity: 2 } }), 403, 'the front desk does not move stock');
  const got = await sw('POST', '/carts/stock', { token: crewA.token, body: { stream_id: s.recycling, size_gal: 65, reason: 'received', quantity: 2, note: 'Truckload from the vendor' } });
  is(got, 200); assert.equal(got.body.on_hand, 2);
  const scrap = await sw('POST', '/carts/stock', { token: crewA.token, body: { stream_id: s.recycling, size_gal: 65, reason: 'scrapped', quantity: 5 } });
  is(scrap, 409, 'cannot scrap more than there are');
  const stops = (await sw('GET', `/carts/stops?date=${TODAY}`, { token: crewA.token })).body.stops;
  const stop = stops.find((x) => x.reference === freeReq.reference);
  assert.ok(stop); assert.equal(stop.address, '12 Main Street');
  assert.ok(!/Rae|example\.com|610-555/.test(JSON.stringify(stops)), 'stops carry addresses only');
  const lib = await require('../src/lib/carts').cartStopsFor(pool, A.id, TODAY);
  assert.deepEqual(lib.map((x) => x.id), stops.map((x) => x.id), 'cartStopsFor is what the route shows');
  const before = sink.length;
  const ok = await sw('POST', `/carts/requests/${r.id}/deliver`, { token: crewA.token, body: { serial: 'R-1' } });
  is(ok, 200);
  assert.ok(emails(before).some((m) => /was delivered/.test(m.TextBody)));
  is(await sw('POST', `/carts/requests/${r.id}/deliver`, { token: crewA.token, body: {} }), 409, 'delivered once');
  const stock = (await sw('GET', '/carts/stock', { token: deskA.token })).body.stock.find((x) => x.stream_id === s.recycling && x.size_gal === 65);
  assert.equal(stock.on_hand, 1);
  const cnt = await sw('POST', '/carts/stock', { token: crewA.token, body: { stream_id: s.recycling, size_gal: 65, reason: 'count', quantity: 0 } });
  is(cnt, 200); assert.equal(cnt.body.on_hand, 0, 'a count sets the number');
  const [neg] = await q('SELECT MIN(on_hand) AS m FROM cart_stock WHERE tenant_id = ?', [A.id]);
  assert.ok(Number(neg.m) >= 0);
  const addr = (await sw('GET', `/carts/address?street_id=${s.streets[0]}&house_number=12`, { token: crewA.token })).body;
  assert.equal(addr.carts.length, 1); assert.equal(addr.carts[0].serial, 'R-1'); assert.equal(addr.zone, 'Monday north');
});

test('a replacement takes the old cart off the address; a cart that came back in good shape goes into the yard', async () => {
  const s = S[A.id];
  await sw('POST', '/carts/stock', { token: crewA.token, body: { stream_id: s.trash, size_gal: 95, reason: 'received', quantity: 1 } });
  const old = (await sw('GET', `/carts/address?street_id=${s.streets[3]}&house_number=5`, { token: deskA.token })).body.carts.find((c) => c.stream === 'Trash');
  const r = await sw('POST', '/carts/requests', { token: deskA.token, body: { kind: 'replacement', stream_id: s.trash, size_gal: 95, street_id: s.streets[3], house_number: '5', pay: 'office_due', ...resident(8) } });
  is(r, 201); assert.equal(r.body.fee_due, true);
  is(await sw('POST', `/carts/requests/${r.body.id}/schedule`, { token: deskA.token, body: { deliver_on: plus(TODAY, 1) } }), 200);
  is(await sw('POST', `/carts/requests/${r.body.id}/deliver`, { token: crewA.token, body: {} }), 409, 'the crew marks it on its day');
  const ok = await sw('POST', `/carts/requests/${r.body.id}/deliver`, { token: deskA.token, body: { serial: 'T-0099', old_cart_id: old.id, old_cart_back: true } });
  is(ok, 200);
  const [was] = await q('SELECT status FROM carts WHERE id = ?', [old.id]);
  assert.equal(was.status, 'removed');
  const k = (await sw('GET', '/carts/stock', { token: crewA.token })).body.stock.find((x) => x.stream_id === s.trash && x.size_gal === 95);
  assert.equal(k.on_hand, 1, 'one out, the old one back');
  const counts = (await sw('GET', '/carts/counts', { token: crewA.token })).body;
  assert.ok(counts.by_size.some((x) => x.stream === 'Trash' && x.size_gal === 95 && x.carts === 1));
  assert.ok(counts.by_zone.some((x) => x.zone === 'Monday north' && x.stream === 'Recycling'));
});

test('money: the crew and the front desk never get cart fees, tipping fees or cost per ton, by any spelling of the path', async () => {
  const list = (await sw('GET', '/carts/requests?show=all', { token: deskA.token })).body.data;
  assert.ok(list.length);
  for (const x of list) { assert.equal(x.fee_cents, undefined); assert.equal(x.paid_cents, undefined); }
  const mgr = (await sw('GET', '/carts/requests?show=all', { token: mgrA.token })).body.data;
  assert.ok(mgr.some((x) => x.fee_cents === 7500));
  const pubPage = (await pub('GET', A.slug, '/cart-request')).body;
  assert.equal(pubPage.streams[0].sizes[0].extra_fee_cents, 6500, 'the public price list is public');
  for (const path of ['/solid-waste/carts/setup', '/SOLID-WASTE/carts/requests?show=all', '/solid-waste/%63arts/requests?show=all']) {
    const r = await api('GET', path, { token: crewA.token });
    if (r.status === 200) assert.ok(!/_cents/.test(r.text), `${path}: ${r.text.slice(0, 200)}`);
  }
});

// ---------------------------------------------------------------- weigh tickets
let landfill; let mrf; let compost;
test('facilities: a manager keeps the list with the usual fee per ton and the processor\'s residue share', async () => {
  const add = (body, token = A.token) => sw('POST', '/tonnage/facilities', { token, body });
  const l = await add({ name: 'Pioneer Crossing Landfill', kind: 'landfill', fee_per_ton_cents: 7200 }); is(l, 201); landfill = l.body.id;
  const m = await add({ name: 'Blue Mountain MRF', kind: 'recycling', fee_per_ton_cents: 0, residue_pct: 10 }); is(m, 201); mrf = m.body.id;
  const c = await add({ name: 'Borough Compost Yard', kind: 'compost' }); is(c, 201); compost = c.body.id;
  is(await add({ name: 'Pioneer Crossing Landfill', kind: 'landfill' }), 409, 'names are unique');
  is(await add({ name: 'Elsewhere', kind: 'landfill' }, deskA.token), 403);
});

test('a weigh ticket: net = gross - tare, and the checks in plain words', async () => {
  const s = S[A.id];
  const T = (body, token = deskA.token) => sw('POST', '/tonnage/tickets', { token, body: { on_date: TODAY, facility_id: landfill, stream_id: s.trash, ...body } });
  const ok = await T({ ticket_no: 'PC-1001', gross_lb: 52340, tare_lb: 31220, zone_id: s.zoneN });
  is(ok, 201);
  assert.equal(ok.body.net_lb, 21120); assert.equal(ok.body.net_tons, 10.56);
  const [row] = await q('SELECT * FROM weigh_tickets WHERE id = ?', [ok.body.id]);
  assert.equal(row.fee_cents, Math.round(10.56 * 7200), 'the facility\'s usual fee per ton'); assert.equal(row.material, 'msw'); assert.equal(row.stream_kind, 'trash');
  const tareHigh = await T({ ticket_no: 'PC-1002', gross_lb: 30000, tare_lb: 31220 }); is(tareHigh, 400); assert.match(tareHigh.body.error, /tare .* less than the gross/);
  const onlyGross = await T({ ticket_no: 'PC-1003', gross_lb: 30000 }); is(onlyGross, 400); assert.match(onlyGross.body.error, /both the gross and the tare/);
  const mismatch = await T({ ticket_no: 'PC-1004', gross_lb: 50000, tare_lb: 30000, net_lb: 15000 }); is(mismatch, 400); assert.match(mismatch.body.error, /20,000 pounds/);
  is(await T({ ticket_no: 'PC-1005', gross_lb: 50000, tare_lb: 30000, net_lb: 20004 }), 201, 'a net typed from tons to two places is near enough');
  const noWeight = await T({ ticket_no: 'PC-1006' }); is(noWeight, 400);
  const zero = await T({ ticket_no: 'PC-1007', net_lb: 0 }); is(zero, 400);
  const future = await T({ ticket_no: 'PC-1008', net_lb: 1000, on_date: plus(TODAY, 2) }); is(future, 400); assert.match(future.body.error, /future/);
  const huge = await T({ ticket_no: 'PC-1009', net_tons: 2000 }); is(huge, 400); assert.match(huge.body.error, /1,000 tons/);
  const dup = await T({ ticket_no: 'PC-1001', net_lb: 1000 }); is(dup, 409); assert.equal(dup.body.details.code, 'duplicate_ticket');
  is(await T({ ticket_no: 'PC-1010', net_lb: 1000, facility_id: 999999999 }), 400, 'a facility not on the list');
  is(await T({ ticket_no: 'PC-1011', net_lb: 1000, stream_id: S[B.id].trash }), 400, 'another municipality\'s stream');
  is(await T({ ticket_no: 'PC-1012', net_lb: 1000, material: 'aluminum' }), 400, 'a trash ticket is trash');
  const tons = await T({ ticket_no: null, facility_id: mrf, stream_id: s.recycling, net_tons: 4.25, on_date: plus(TODAY, -3) });
  is(tons, 201); assert.equal(tons.body.net_lb, 8500);
  const again = await T({ ticket_no: null, facility_id: mrf, stream_id: s.recycling, net_tons: 4.25, on_date: plus(TODAY, -3) });
  is(again, 409, 'a statement line without a number is matched on its date, facility, stream and weight');
  is(await T({ net_lb: 1000 }, crewA.token), 403, 'the office enters tickets; the driver\'s phone is Collection routes');
  // The front desk cannot set a fee by hand; the facility's fee per ton applies.
  const deskFee = await T({ ticket_no: 'PC-1013', net_lb: 2000, fee_cents: 1 });
  is(deskFee, 201);
  assert.equal((await q('SELECT fee_cents FROM weigh_tickets WHERE id = ?', [deskFee.body.id]))[0].fee_cents, 7200);
  const v = await sw('POST', `/tonnage/tickets/${deskFee.body.id}/void`, { token: A.token, body: { reason: 'Entered twice' } });
  is(v, 200);
  is(await sw('POST', `/tonnage/tickets/${deskFee.body.id}/void`, { token: deskA.token, body: { reason: 'x x x' } }), 403);
  is(await T({ ticket_no: 'PC-1013', net_lb: 2000 }), 201, 'a voided ticket\'s number can be entered again');
});

test('addTicket is the one way in: the routes workstream calls it with a connection for a driver\'s ticket', async () => {
  const T = require('../src/lib/tonnage');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await T.addTicket(conn, A.id, { on_date: TODAY, facility_id: compost, stream_id: S[A.id].yard, gross_lb: 24000, tare_lb: 18000, source: 'driver', zone_id: S[A.id].zoneS }, { by: null });
    await conn.commit();
    assert.equal(out.net_lb, 6000); assert.equal(out.net_tons, 3);
    const [row] = await q('SELECT source, material FROM weigh_tickets WHERE id = ?', [out.id]);
    assert.equal(row.source, 'driver'); assert.equal(row.material, 'leaf_yard');
    await assert.rejects(() => T.addTicket(conn, B.id, { on_date: TODAY, facility_id: compost, net_lb: 100, stream_kind: 'yard' }), /facility/, 'another municipality\'s facility');
  } finally { conn.release(); }
});

test('a photo of the ticket is kept exactly as taken, with its SHA-256', async () => {
  const [t] = await q("SELECT id FROM weigh_tickets WHERE tenant_id = ? AND ticket_no = 'PC-1001'", [A.id]);
  const img = JPEG();
  const up = await sw('POST', `/tonnage/tickets/${t.id}/photos`, { token: deskA.token, raw: img });
  is(up, 201);
  assert.equal(up.body.sha256, crypto.createHash('sha256').update(img).digest('hex'));
  is(await sw('POST', `/tonnage/tickets/${t.id}/photos`, { token: deskA.token, raw: Buffer.from('not a photo') }), 400);
  const got = await sw('GET', `/tonnage/tickets/${t.id}/photos/${up.body.id}`, { token: crewA.token });
  is(got, 200); assert.ok(got.buf.equals(img));
  is(await api('GET', `/solid-waste/tonnage/tickets/${t.id}/photos/${up.body.id}`, { token: B.token }), 404, 'not another municipality\'s');
});

test('a facility\'s monthly report comes in from a spreadsheet; bad lines are listed and the rest come in', async () => {
  const lastMonth = plus(`${TODAY.slice(0, 7)}-01`, -1).slice(0, 7);
  const csv = [
    'Date,Ticket #,Facility,Material,Gross,Tare,Net Tons,Fee',
    `${lastMonth}-03,MRF-1,Blue Mountain MRF,Single Stream,,,6.10,0`,
    `${lastMonth}-10,MRF-2,Blue Mountain MRF,Cardboard,,,1.40,`,
    `${lastMonth}-17,MRF-3,Nowhere Recycling,Single Stream,,,2.00,`,
    `${lastMonth}-32,MRF-4,Blue Mountain MRF,Single Stream,,,2.00,`,
    `${lastMonth}-18,MRF-5,Blue Mountain MRF,Moon rocks,,,2.00,`,
    `${lastMonth}-19,MRF-6,Blue Mountain MRF,Single Stream,30000,31000,,`,
    `${lastMonth}-20,MRF-1,Blue Mountain MRF,Single Stream,,,6.10,0`,
    `${Number(lastMonth.slice(5)) }/21/${lastMonth.slice(0, 4)},MRF-7,Blue Mountain MRF,Commercial cardboard,,,0.75,$12.50`,
    '2030-01-02,MRF-8,Blue Mountain MRF,Single Stream,,,1.00,',
  ].join('\n');
  const dry = await sw('POST', '/tonnage/import', { token: deskA.token, body: { csv, source_name: 'Blue Mountain MRF statement', dry_run: true } });
  is(dry, 200);
  assert.equal(dry.body.added, 3); assert.equal(dry.body.skipped.length, 6, 'the check refuses what the import refuses, a date to come too');
  assert.match(dry.body.skipped.find((x) => x.line === 10).reason, /future/);
  assert.equal((await q('SELECT COUNT(*) AS n FROM weigh_tickets WHERE tenant_id = ? AND ticket_no LIKE ?', [A.id, 'MRF-%']))[0].n, 0, 'a check adds nothing');
  const r = await sw('POST', '/tonnage/import', { token: deskA.token, body: { csv, source_name: 'Blue Mountain MRF statement', file_name: 'mrf.csv' } });
  is(r, 201);
  assert.equal(r.body.added, 3);
  const why = Object.fromEntries(r.body.skipped.map((x) => [x.line, x.reason]));
  assert.match(why[4], /not on the facilities list/); assert.match(why[5], /not a real date/); assert.match(why[6], /not a stream or material/);
  assert.match(why[7], /tare/); assert.match(why[8], /already entered/); assert.match(why[10], /future/);
  const [card] = await q("SELECT material, net_lb, fee_cents, source, import_id FROM weigh_tickets WHERE tenant_id = ? AND ticket_no = 'MRF-2'", [A.id]);
  assert.equal(card.material, 'corrugated'); assert.equal(card.net_lb, 2800); assert.equal(card.source, 'import'); assert.ok(card.import_id);
  assert.equal((await q("SELECT fee_cents FROM weigh_tickets WHERE tenant_id = ? AND ticket_no = 'MRF-7'", [A.id]))[0].fee_cents, 1250);
  const again = await sw('POST', '/tonnage/import', { token: deskA.token, body: { csv, source_name: 'Blue Mountain MRF statement' } });
  assert.equal(again.body.added, 0, 'the same file twice adds nothing');
  is(await sw('POST', '/tonnage/import', { token: deskA.token, body: { csv: 'a,b\n1,2', source_name: 'x y' } }), 400, 'no date column');
  is(await sw('POST', '/tonnage/import', { token: crewA.token, body: { csv, source_name: 'x y' } }), 403);
});

test('the figures: tons by stream, month, facility and zone; recycling rate; pounds per household; cost per ton for managers', async () => {
  const s = S[A.id];
  // Households come from the water customer list.
  for (let i = 1; i <= 4; i += 1) await q("INSERT INTO service_addresses (tenant_id, street_id, house_number, house_no, match_key) VALUES (?, ?, ?, ?, ?)", [A.id, s.streets[0], String(i * 2), i * 2, `k${suffix}${i}`]);
  const year = Number(TODAY.slice(0, 4));
  const f = (await sw('GET', `/tonnage/figures?year=${year}`, { token: A.token })).body;
  const all = await q("SELECT stream_kind, SUM(net_lb) AS lb FROM weigh_tickets WHERE tenant_id = ? AND voided_at IS NULL AND YEAR(on_date) = ? GROUP BY stream_kind", [A.id, year]);
  const lb = Object.fromEntries(all.map((x) => [x.stream_kind, Number(x.lb)]));
  const total = Object.values(lb).reduce((a, b) => a + b, 0); const rec = (lb.recycling || 0) + (lb.yard || 0) + (lb.food || 0);
  assert.equal(f.recycling_rate, Math.round((rec / total) * 1000) / 10);
  assert.equal(f.households, 4); assert.equal(f.households_source, 'service_addresses');
  assert.equal(f.pounds_per_household, Math.round(total / 4));
  assert.equal(f.totals.all_tons, Math.round((total / 2000) * 100) / 100);
  assert.ok(f.cost_per_ton_cents > 0); assert.ok(f.fees_cents > 0);
  assert.ok(f.zones.some((z) => z.zone === 'Monday north' && z.tons.trash > 0));
  assert.ok(f.zones.some((z) => z.zone === 'Thursday south' && z.tons.yard === 3));
  assert.ok(f.facilities.some((x) => x.name === 'Pioneer Crossing Landfill' && x.cost_per_ton_cents === 7200));
  for (const tok of [crewA.token, deskA.token]) {
    const r = await sw('GET', `/tonnage/figures?year=${year}`, { token: tok });
    is(r, 200);
    assert.equal(r.body.recycling_rate, f.recycling_rate, 'the rate is for everyone');
    assert.ok(!/fees_cents|cost_per_ton|fee_cents/.test(r.text), 'no money for the crew or front desk');
  }
  const desk = await sw('GET', '/tonnage/tickets.csv', { token: deskA.token });
  is(desk, 200); assert.ok(!/tipping_fee/.test(desk.text.split('\n')[0]), 'no fee column for the front desk');
  const mgr = await sw('GET', '/tonnage/tickets.csv', { token: A.token });
  assert.ok(/tipping_fee_dollars/.test(mgr.text.split('\n')[0]));
});

test('what counts as recycled is where the load went: yard waste or recycling taken to a landfill is disposal', async () => {
  const s = S[A.id]; const year = Number(TODAY.slice(0, 4));
  const before = (await sw('GET', `/tonnage/figures?year=${year}`, { token: A.token })).body;
  const repBefore = (await sw('GET', `/recycling-report/${year}/report`, { token: A.token })).body;
  const ts = await sw('POST', '/tonnage/facilities', { token: A.token, body: { name: 'County Transfer Station', kind: 'transfer' } });
  for (const [facility, stream, no] of [[landfill, s.yard, 'LF-YARD-1'], [ts.body.id, s.recycling, 'TS-REC-1']]) {
    is(await sw('POST', '/tonnage/tickets', { token: deskA.token, body: { on_date: TODAY, facility_id: facility, stream_id: stream, ticket_no: no, net_lb: 4000 } }), 201);
  }
  const after = (await sw('GET', `/tonnage/figures?year=${year}`, { token: A.token })).body;
  assert.equal(after.totals.recycled_tons, before.totals.recycled_tons, 'not recycled');
  assert.equal(Math.round((after.totals.all_tons - before.totals.all_tons) * 100) / 100, 4, 'but counted in all tons');
  assert.ok(after.recycling_rate < before.recycling_rate);
  assert.equal(after.totals.by_stream.yard, Math.round((before.totals.by_stream.yard + 2) * 100) / 100, 'still yard waste by stream');
  const rep = (await sw('GET', `/recycling-report/${year}/report`, { token: A.token })).body;
  const yardOf = (r) => (r.rows.find((x) => x.material === 'leaf_yard') || { total: 0 }).total;
  assert.equal(yardOf(rep), yardOf(repBefore), 'not in the report\'s recycled materials');
  assert.ok(!rep.sources.some((x) => ['Pioneer Crossing Landfill', 'County Transfer Station'].includes(x.processor)), 'a landfill is never a processor');
  assert.equal(Math.round((rep.trash_tons - repBefore.trash_tons) * 100) / 100, 4, 'counted as disposal');
});

test('the monthly report gains a Trash and recycling section: tons, rate, missed pickups, carts delivered', async () => {
  const r = await api('GET', `/assets/month-report?month=${TODAY.slice(0, 7)}`, { token: A.token });
  is(r, 200);
  assert.ok(r.body.trash, 'the section is there');
  assert.ok(r.body.trash.all_tons > 0); assert.equal(typeof r.body.trash.missed_pickups, 'number'); assert.ok(r.body.trash.carts_delivered >= 1);
  const csv = await api('GET', `/assets/month-report.csv?month=${TODAY.slice(0, 7)}`, { token: A.token });
  assert.match(csv.text, /Trash and recycling/); assert.match(csv.text, /Recycling rate/);
});

// ---------------------------------------------------------------- the annual recycling report
let year; let haulerForm; let haulerLink; let bizId;
test('the year\'s report: reporters, forms sent by email with each reporter\'s own link', async () => {
  year = Number(TODAY.slice(0, 4));
  const add = (body) => sw('POST', '/recycling-report/reporters', { token: A.token, body });
  const h1 = await add({ name: 'Valley Waste Haulers', kind: 'hauler', email: `vwh-${suffix}@example.com`, contact_name: 'Dana' }); is(h1, 201);
  const b1 = await add({ name: 'Main Street Grocery', kind: 'business', email: `grocer-${suffix}@example.com` }); is(b1, 201); bizId = b1.body.id;
  const b2 = await add({ name: 'Corner Diner', kind: 'business', phone: '610-555-0300' }); is(b2, 201);
  is(await add({ name: 'Valley Waste Haulers', kind: 'hauler' }), 409);
  is(await sw('POST', '/recycling-report/reporters', { token: deskA.token, body: { name: 'X Y', kind: 'hauler' } }), 403);
  is(await sw('GET', `/recycling-report/${year}`, { token: A.token }), 404, 'not opened yet');
  is(await sw('POST', `/recycling-report/${year + 1}/open`, { token: A.token }), 400, 'not a year still to come');
  const o = await sw('POST', `/recycling-report/${year}/open`, { token: A.token });
  is(o, 201); assert.equal(o.body.county, 'Chester'); assert.equal(o.body.due_on, `${year + 1}-02-15`); assert.equal(o.body.followup_on, `${year + 1}-02-01`);
  const before = sink.length;
  const sent = await sw('POST', `/recycling-report/${year}/send`, { token: A.token, body: {} });
  is(sent, 200);
  assert.equal(sent.body.sent, 2); assert.deepEqual(sent.body.no_email, ['Corner Diner']);
  const mail = emails(before).find((m) => m.To === `vwh-${suffix}@example.com`);
  assert.ok(mail); assert.match(mail.TextBody, /Act 101/);
  haulerLink = /\/hauler-report\/[^/\s]+\/([A-Za-z0-9_-]{40,60})/.exec(mail.TextBody);
  assert.ok(haulerLink, mail.TextBody);
  assert.ok(!(await q('SELECT id FROM recycling_report_forms WHERE token_hash = ?', [haulerLink[1]])).length, 'only a hash of the link is kept');
  const rep = (await sw('GET', `/recycling-report/${year}`, { token: A.token })).body;
  haulerForm = rep.forms.find((f) => f.name === 'Valley Waste Haulers');
  assert.ok(haulerForm.sent_at); assert.equal(rep.summary.forms, 3);
});

test('the reporter\'s form: no login, its own form only, checked, and it ends when the report closes', async () => {
  const tok = haulerLink[1];
  const g = await pub('GET', A.slug, `/hauler-report/${tok}`);
  is(g, 200);
  assert.equal(g.body.reporter, 'Valley Waste Haulers'); assert.equal(g.body.year, year);
  assert.deepEqual(g.body.columns.map((c) => c.key), ['res_curb', 'res_dropoff', 'com_curb', 'com_dropoff']);
  assert.ok(!g.body.materials.some((m) => m.key === 'msw'), 'trash is not a recycled material');
  assert.equal(g.body.kind, 'hauler', 'the form words the nothing-to-report box by kind (a business: "We had nothing to recycle")');
  assert.ok(!/Main Street Grocery|Corner Diner|grocer/.test(g.text), 'nothing about other reporters');
  is(await pub('GET', B.slug, `/hauler-report/${tok}`), 404, 'only on its own municipality');
  is(await pub('GET', A.slug, `/hauler-report/${tok.slice(0, -2)}xx`), 404);
  const send = (body) => pub('POST', A.slug, `/hauler-report/${tok}`, { body });
  const line = { material: 'commingled', res_curb: 100, res_dropoff: 0, com_curb: 50, com_dropoff: 0, residue: 15, processor: 'Blue Mountain MRF' };
  is(await send({ lines: [line] }), 400, 'a name is needed');
  const over = await send({ name: 'Dana', lines: [{ ...line, residue: 200 }] }); is(over, 400); assert.match(over.body.error, /residue/);
  const noProc = await send({ name: 'Dana', lines: [{ ...line, processor: '' }] }); is(noProc, 400); assert.match(noProc.body.error, /processor/);
  is(await send({ name: 'Dana', lines: [{ ...line, material: 'msw' }] }), 400, 'not trash');
  is(await send({ name: 'Dana', lines: [] }), 400, 'nothing given');
  const ok = await send({ name: 'Dana', lines: [line, { material: 'corrugated', res_curb: 0, res_dropoff: 0, com_curb: 20, com_dropoff: 0, residue: 0, processor: 'Cardboard Mill' }] });
  is(ok, 200); assert.ok(ok.body.answered_at); assert.equal(ok.body.lines.length, 2);
  // The office types in the answer for the business without email.
  const rep = (await sw('GET', `/recycling-report/${year}`, { token: A.token })).body;
  const diner = rep.forms.find((f) => f.name === 'Corner Diner');
  is(await sw('POST', `/recycling-report/${year}/forms/${diner.id}/answer`, { token: A.token, body: { none: true } }), 200);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'recycling_answer'", [A.id])).length >= 2);
});

test('reminders on January 15, and on February 1 the last reminder and the follow-up list; December opens the year', async () => {
  const R = require('../src/lib/recyclingreport');
  // The year being reminded about is "last year" on those days.
  const before = sink.length;
  await R.daily(base, { today: `${year + 1}-01-16`, tenantId: A.id });
  const rem = emails(before);
  assert.equal(rem.length, 1, 'only the grocery has not answered and has an email');
  assert.match(rem[0].Subject, /Reminder/);
  await R.daily(base, { today: `${year + 1}-01-17`, tenantId: A.id });
  assert.equal(emails(before).length, 1, 'once');
  await R.daily(base, { today: `${year + 1}-02-01`, tenantId: A.id });
  assert.equal(emails(before).filter((m) => /Last reminder/.test(m.Subject)).length, 1);
  await R.daily(base, { today: `${year + 1}-02-02`, tenantId: A.id });
  assert.equal(emails(before).filter((m) => /Last reminder/.test(m.Subject)).length, 1, 'the follow-up day runs once');
  const rep = (await sw('GET', `/recycling-report/${year}`, { token: A.token })).body;
  assert.deepEqual(rep.followup.map((f) => f.name), ['Main Street Grocery']);
  assert.equal(rep.followup[0].email, `grocer-${suffix}@example.com`, 'with how to reach them');
  // December opens next year's report by itself, with a form for every reporter.
  await R.daily(base, { today: `${year + 1}-12-01`, tenantId: A.id });
  const [next] = await q('SELECT id FROM recycling_reports WHERE tenant_id = ? AND year = ?', [A.id, year + 1]);
  assert.ok(next);
  assert.equal((await q('SELECT COUNT(*) AS n FROM recycling_report_forms WHERE tenant_id = ? AND report_id = ?', [A.id, next.id]))[0].n, 3);
  await q('DELETE FROM recycling_report_forms WHERE report_id = ?', [next.id]); await q('DELETE FROM recycling_reports WHERE id = ?', [next.id]);
  void bizId;
});

test('the municipal report: the four DEP / county columns, residue deducted, processors named; printable and CSV', async () => {
  const r = (await sw('GET', `/recycling-report/${year}/report`, { token: A.token })).body;
  assert.deepEqual(r.columns.map((c) => c.label), ['Residential curbside', 'Residential drop-off', 'Commercial curbside', 'Commercial drop-off']);
  const mixed = r.rows.find((x) => x.material === 'commingled');
  // The hauler: 100 + 50 with 15 residue -> 90 + 45. Own tickets at the MRF (10% residue) come on top.
  const own = r.sources.filter((s) => s.material === 'commingled' && s.kind === 'tickets');
  const ownRes = own.reduce((a, s) => a + s.res_curb, 0);
  assert.equal(Math.round((mixed.res_curb - ownRes) * 100) / 100, 90);
  assert.equal(mixed.com_curb, 45);
  assert.ok(mixed.processors.includes('Blue Mountain MRF'));
  const hauler = r.sources.find((s) => s.source === 'Valley Waste Haulers' && s.material === 'commingled');
  assert.equal(hauler.residue, 15); assert.equal(hauler.total, 135);
  for (const s of own) {
    const gross = (await q("SELECT SUM(net_lb) AS lb FROM weigh_tickets WHERE tenant_id = ? AND voided_at IS NULL AND material = 'commingled' AND facility_id = ? AND YEAR(on_date) = ?", [A.id, mrf, year]))[0].lb / 2000;
    assert.ok(Math.abs(s.total - gross * 0.9) < 0.02, 'the processor\'s 10% residue comes off');
  }
  assert.ok(!r.rows.some((x) => x.material === 'msw'), 'trash is not recycling');
  assert.ok(r.trash_tons > 0); assert.equal(typeof r.recycling_rate, 'number');
  const totalCols = r.totals.res_curb + r.totals.res_dropoff + r.totals.com_curb + r.totals.com_dropoff;
  assert.ok(Math.abs(totalCols - r.totals.total) < 0.05, 'the columns add up to the total');
  const csv = await sw('GET', `/recycling-report/${year}/report.csv`, { token: A.token });
  is(csv, 200);
  assert.match(csv.text.split('\r\n')[0], /residential_curbside_tons.*residential_dropoff_tons.*commercial_curbside_tons.*commercial_dropoff_tons.*residue_deducted_tons.*total_tons.*processor/);
  assert.match(csv.text, /Valley Waste Haulers/);
  is(await sw('GET', `/recycling-report/${year}/report`, { token: deskA.token }), 403, 'a manager\'s report');
});

test('the Section 904 packet: totals and the backing documents, printable, and a zip of the ticket photos', async () => {
  const [t2] = await q("SELECT id FROM weigh_tickets WHERE tenant_id = ? AND ticket_no = 'PC-1005'", [A.id]);
  const gpsPhoto = jpegWithGps();
  assert.ok(photoFacts(gpsPhoto).lat, 'the test photo carries a position');
  is(await sw('POST', `/tonnage/tickets/${t2.id}/photos`, { token: deskA.token, raw: gpsPhoto }), 201);
  const p = (await sw('GET', `/recycling-report/${year}/packet`, { token: A.token })).body;
  assert.ok(p.documents.tickets.length >= 5);
  assert.ok(p.documents.tickets.some((t) => t.photos === 1));
  assert.ok(p.documents.reports.some((x) => x.reporter === 'Valley Waste Haulers'));
  const z = await sw('GET', `/recycling-report/${year}/packet.zip`, { token: A.token });
  is(z, 200);
  assert.equal(z.headers.get('content-type'), 'application/zip');
  const files = require('fflate').unzipSync(new Uint8Array(z.buf));
  const names = Object.keys(files);
  assert.ok(names.some((x) => /^ticket-photos\/.*PC-1001.*\.jpg$/.test(x)), names.join(','));
  assert.ok(names.includes('tickets.csv') && names.includes('recycling-report.csv') && names.includes('SHA256SUMS.txt'));
  const sums = Buffer.from(files['SHA256SUMS.txt']).toString();
  const photos = names.filter((x) => x.startsWith('ticket-photos/'));
  assert.equal(photos.length, 2);
  for (const ph of photos) {
    assert.ok(sums.includes(crypto.createHash('sha256').update(files[ph]).digest('hex')), 'each file\'s SHA-256 is listed');
    const facts = photoFacts(Buffer.from(files[ph]));
    assert.ok(!facts.lat && !facts.lng, `${ph}: where it was taken is taken out`);
  }
  const kept = await q("SELECT original FROM weigh_ticket_photos p JOIN weigh_tickets t ON t.id = p.ticket_id WHERE t.ticket_no = 'PC-1005' AND t.tenant_id = ?", [A.id]);
  assert.ok(photoFacts(kept[0].original).lat, 'the original in the app is kept as taken');
});

test('closing the report ends every link; opening it again does not bring old links back', async () => {
  is(await sw('POST', `/recycling-report/${year}/close`, { token: A.token }), 200);
  is(await pub('GET', A.slug, `/hauler-report/${haulerLink[1]}`), 404);
  is(await sw('POST', `/recycling-report/${year}/send`, { token: A.token, body: {} }), 409);
  is(await sw('POST', `/recycling-report/${year}/reopen`, { token: A.token }), 200);
  is(await pub('GET', A.slug, `/hauler-report/${haulerLink[1]}`), 404, 'a closed report\'s links stay ended');
  const link = await sw('POST', `/recycling-report/${year}/forms/${haulerForm.id}/link`, { token: A.token });
  is(link, 200);
  const tok = /\/([A-Za-z0-9_-]{40,60})$/.exec(link.body.link)[1];
  is(await pub('GET', A.slug, `/hauler-report/${tok}`), 200, 'a new link works');
});

// ---------------------------------------------------------------- the Right-to-Know export
test('the requests spreadsheet leaves out residents\' names, phones, emails and house numbers unless a manager asks (audited)', async () => {
  const plain = await sw('GET', '/carts/export', { token: deskA.token });
  is(plain, 200);
  const head = plain.text.split('\r\n')[0];
  assert.ok(!/name|phone|email|house_number/.test(head), head);
  assert.ok(!/Rae Resident|example\.com|610-555/.test(plain.text));
  assert.ok(!/fee|paid|refunded/.test(head) || true);
  is(await sw('GET', '/carts/export?contacts=1', { token: deskA.token }), 403);
  const full = await sw('GET', '/carts/export?contacts=1', { token: A.token });
  is(full, 200); assert.match(full.text, /Rae Resident/); assert.match(full.text.split('\r\n')[0], /house_number/);
  assert.ok((await q("SELECT id FROM audit_log WHERE tenant_id = ? AND action = 'cart_export_contacts'", [A.id])).length);
  assert.ok(!/fee|paid|refund|dollars|cents/.test(head), `the front desk's copy has no money columns: ${head}`);
  assert.match(full.text.split('\r\n')[0], /fee_dollars,paid_dollars,refunded_dollars/, 'a manager\'s copy has them');
});

test('no money for the crew or the front desk from any carts, tonnage or recycling report answer, JSON or spreadsheet', async () => {
  const s = S[A.id];
  const [req1] = await q('SELECT id FROM cart_requests WHERE tenant_id = ? AND fee_cents > 0 LIMIT 1', [A.id]);
  const [tk] = await q('SELECT id FROM weigh_tickets WHERE tenant_id = ? AND fee_cents > 0 LIMIT 1', [A.id]);
  const paths = ['/carts/setup', '/carts/options', '/carts/requests?show=all', `/carts/requests/${req1.id}`, `/carts/address?street_id=${s.streets[3]}&house_number=5`, '/carts', '/carts/counts',
    `/carts/stops?date=${TODAY}`, '/carts/stock', '/carts/today', '/carts/export?contacts=1', '/carts/export', '/tonnage/setup', '/tonnage/tickets', `/tonnage/tickets/${tk.id}`, `/tonnage/figures?year=${year}`,
    '/tonnage/imports', '/tonnage/tickets.csv', '/recycling-report', `/recycling-report/${year}`, `/recycling-report/${year}/report`, `/recycling-report/${year}/report.csv`, `/recycling-report/${year}/packet`];
  const MONEY = /(cents|fee|cost|paid|refund|price|amount|dollars|revenue)/i;
  const moneyKeys = (v, at = '') => (Array.isArray(v) ? v.flatMap((x, i) => moneyKeys(x, `${at}[${i}]`))
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => (MONEY.test(k) && typeof x !== 'boolean' && !/^pay_status$|^pay_method$/.test(k) ? [`${at}.${k}`] : moneyKeys(x, `${at}.${k}`))) : []);
  let seen = 0;
  for (const who of [crewA, deskA]) {
    for (const p of paths) {
      const r = await sw('GET', p, { token: who.token });
      if (r.status === 403) continue;
      is(r, 200, `${p}`);
      seen += 1;
      if (/text\/csv/.test(r.headers.get('content-type') || '')) assert.ok(!MONEY.test(r.text.split('\r\n')[0]), `${p}: ${r.text.split('\r\n')[0]}`);
      else assert.deepEqual(moneyKeys(r.body), [], `${p} for ${who.username}`);
    }
  }
  assert.ok(seen >= 25, `swept ${seen} answers`);
  // A manager does get them, so the sweep is not passing for want of money in the data.
  const m = await sw('GET', '/carts/export', { token: A.token });
  assert.ok(MONEY.test(m.text.split('\r\n')[0]));
  assert.ok(moneyKeys((await sw('GET', `/tonnage/figures?year=${year}`, { token: A.token })).body).length > 0);
});

// ---------------------------------------------------------------- gating and isolation
test('the app is gated: off for a municipality without Trash and recycling, and a ski area is refused', async () => {
  for (const p of ['/carts/setup', '/carts/requests', '/tonnage/figures', '/recycling-report']) {
    is(await sw('GET', p, { token: C.token }), 403, `${p} off`);
    const ski = await sw('GET', p, { token: skiToken });
    is(ski, 403, `${p} ski`);
  }
  is(await pub('GET', C.slug, '/hauler-report/x'.padEnd(60, 'x')), 404);
  is(await pub('GET', `tn-ski-${suffix}`, '/hauler-report/'.padEnd(60, 'x')), 404);
});

test('each municipality sees only its own carts, requests, tickets, facilities and reports', async () => {
  const [r] = await q('SELECT id FROM cart_requests WHERE tenant_id = ? ORDER BY id LIMIT 1', [A.id]);
  const [t] = await q('SELECT id FROM weigh_tickets WHERE tenant_id = ? ORDER BY id LIMIT 1', [A.id]);
  is(await sw('GET', `/carts/requests/${r.id}`, { token: B.token }), 404);
  is(await sw('POST', `/carts/requests/${r.id}/cancel`, { token: B.token, body: {} }), 404);
  is(await sw('POST', `/carts/requests/${r.id}/deliver`, { token: B.token, body: {} }), 404);
  is(await sw('GET', `/tonnage/tickets/${t.id}`, { token: B.token }), 404);
  is(await sw('POST', `/tonnage/tickets/${t.id}/void`, { token: B.token, body: { reason: 'not mine' } }), 404);
  is(await sw('PUT', `/tonnage/facilities/${landfill}`, { token: B.token, body: { name: 'Taken', kind: 'landfill' } }), 404);
  assert.equal((await sw('GET', '/carts/requests?show=all', { token: B.token })).body.data.length, 0);
  assert.equal((await sw('GET', '/tonnage/tickets', { token: B.token })).body.data.length, 0);
  assert.equal((await sw('GET', `/tonnage/figures?year=${year}`, { token: B.token })).body.totals.tickets, 0);
  is(await sw('GET', `/recycling-report/${year}`, { token: B.token }), 404);
  is(await sw('POST', '/carts/stock', { token: B.token, body: { stream_id: S[A.id].trash, size_gal: 65, reason: 'received', quantity: 1 } }), 400);
  const rep = (await sw('GET', `/recycling-report/${year}`, { token: A.token })).body;
  is(await sw('POST', `/recycling-report/${year}/forms/${rep.forms[0].id}/answer`, { token: B.token, body: { none: true } }), 404);
});

test('migration: running it again changes nothing', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['db/migrate.js'], { cwd: require('node:path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.match(out, /\(0 changes applied\)/);
});
