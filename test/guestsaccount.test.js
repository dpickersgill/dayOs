'use strict';

// Guests round 2, Track ACCOUNT: the household account (email-link sign-in, isolation), one prefilled checkout, rebuy,
// pass renewal with last season's photo, rewards online, the designed confirmation, the morning-of message, card reload
// online and gift experiences. Stripe and Postmark are mock servers; the webhook is signed like the real one.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.SHOP_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let stripeMock; let pmMock; const mails = []; let n = 0; const sessions = [];
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const year = Number(today.slice(0, 4));
const DEVICE = 'test-device-0123456789abcdef';
async function call(prefix, method, path, { token, body, session } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(session ? { 'x-family-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const paidEvent = (row, tenant) => ({ id: `evt_${++n}`, type: 'checkout.session.completed', data: { object: { id: row.stripe_session_id, payment_status: 'paid', amount_total: row.amount_cents, payment_intent: `pi_${row.stripe_session_id}`, metadata: { tenant_id: String(tenant), request_id: String(row.id), shop_order_id: String(row.id), kind: 'shop' } } } });

let A; let pub; let day; let dayP; let rentalP; let passP;
const PHOTO = `data:image/jpeg;base64,${Buffer.from('a tiny photo').toString('base64')}`;
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
/** A household on file: an adult with an email and three children linked as guardian. */
async function household(last, email, kids = 3) {
  const [a] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, email, phone, date_of_birth, source) VALUES (?, 'Pat', ?, ?, '215-555-0101', ?, 'online')", [A.id, last, email, `${year - 40}-05-05`]);
  const ids = [a.insertId];
  for (let i = 0; i < kids; i++) {
    const [k] = await pool.query("INSERT INTO people (tenant_id, first_name, last_name, date_of_birth, source) VALUES (?, ?, ?, ?, 'online')", [A.id, ['Ava', 'Ben', 'Cal'][i], last, `${year - 8 - i * 2}-03-0${i + 1}`]);
    await pool.query("INSERT INTO person_links (tenant_id, adult_id, member_id, relation) VALUES (?, ?, ?, 'guardian')", [A.id, a.insertId, k.insertId]);
    ids.push(k.insertId);
  }
  return ids;
}
/** Signs in by the emailed link (the only way in). */
async function signIn(email) {
  const before = mails.length;
  assert.equal((await pub('POST', '/family/link', { body: { email } })).status, 200);
  const m = mails.slice(before).find((x) => x.To === email);
  assert.ok(m, 'a sign-in link was emailed');
  const token = /\?t=([A-Za-z0-9_-]+)/.exec(m.TextBody)[1];
  const s = await pub('POST', '/family/session', { body: { token } });
  assert.equal(s.status, 200);
  return s.body.session;
}
const contact = { contact_first_name: 'Pat', contact_last_name: 'Rivera', contact_email: 'pat@rivera.test', contact_phone: '215-555-0101', terms_accepted: true, waiver_accepted: true };
async function payFor(body, session) {
  const r = await pub('POST', '/shop/orders', { body, session });
  assert.equal(r.status, 201, r.text);
  const row = (await q('SELECT * FROM shop_orders WHERE tenant_id = ? AND reference = ?', [A.id, r.body.reference]))[0];
  return { r, row };
}

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/checkout/sessions') { sessions.push(Object.fromEntries(new URLSearchParams(data))); res.end(JSON.stringify({ id: `cs_acc_${++n}`, url: `https://checkout.stripe.test/c/${n}` })); }
      else if (req.url === '/v1/refunds') res.end(JSON.stringify({ id: `re_${++n}`, status: 'succeeded' }));
      else if (req.url.startsWith('/v1/refunds?')) res.end(JSON.stringify({ data: [] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ga-${suffix}`);
  pub = (m, p, o) => call('/api/v1/public', m, `/${A.slug}${p}`, o);
  day = plus(today, 4);
  const mk = async (b) => { const r = await api('POST', '/products', { token: A.owner, body: b }); assert.equal(r.status, 201, r.text); return r.body.id; };
  dayP = await mk({ kind: 'day_ticket', name: 'Day ticket', base_price_cents: 6000, online: 1 });
  assert.equal((await api('PUT', `/products/${dayP}/tiers`, { token: A.owner, body: { tiers: [{ tier: 'child', price_cents: 3000 }] } })).status, 200);
  rentalP = await mk({ kind: 'rental', name: 'Ski rental', base_price_cents: 4000, online: 1 });
  passP = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 40000, valid_days: 200, online: 1 });
  await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true, waiver_text: 'I accept the risks.' } });
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

test('sign-in is by emailed link only, and the answer never says whether an email has an account', async () => {
  await household('Known', 'known@x.test', 0);
  const before = mails.length;
  const a = await pub('POST', '/family/link', { body: { email: 'known@x.test' } });
  const b = await pub('POST', '/family/link', { body: { email: 'nobody@x.test' } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body, 'the same reply for a known and an unknown email');
  assert.equal(mails.slice(before).filter((m) => m.To === 'nobody@x.test').length, 0);
  assert.equal(mails.slice(before).filter((m) => m.To === 'known@x.test').length, 1);
  assert.equal((await pub('GET', '/account')).status, 401, 'no session, no account');
  assert.equal((await pub('GET', '/account', { session: 'made-up-session-value' })).status, 401);
  const s = await signIn('known@x.test');
  assert.equal((await pub('GET', '/account', { session: s })).status, 200);
  assert.equal((await pub('POST', '/family/session', { body: { token: 'not-a-real-token-123' } })).status >= 400, true);
});

let riv; let rivS; let other; let otherS;
test('a household sees only its own people, and cannot touch or buy for another household', async () => {
  riv = await household('Rivera', 'pat@rivera.test');
  other = await household('Other', 'sam@other.test', 1);
  rivS = await signIn('pat@rivera.test'); otherS = await signIn('sam@other.test');
  const acc = (await pub('GET', '/account', { session: rivS })).body;
  assert.deepEqual(acc.members.map((m) => m.id).sort(), [...riv].sort());
  assert.equal(acc.members.find((m) => m.id === riv[0]).relation, 'self');
  assert.ok(acc.members.every((m) => !('allergies' in m) && !('medical' in m) && !('notes' in m) && !('email' in m)));
  assert.equal((await pub('PATCH', `/account/people/${other[1]}`, { session: rivS, body: { boot_size: '22' } })).status, 404);
  assert.equal((await pub('GET', `/account/people/${other[0]}/photo`, { session: rivS })).status, 404);
  assert.equal((await pub('POST', '/account/basket', { session: rivS, body: { date: day, people: [{ id: other[1] }] } })).status, 404);
  const sneaky = await pub('POST', '/shop/quote', { session: rivS, body: { items: [{ product_id: dayP, valid_on: day, holder: { person_id: other[1] } }] } });
  assert.equal(sneaky.status, 400, 'a person from another household is refused in the shop');
  assert.equal((await pub('POST', '/shop/quote', { body: { items: [{ product_id: dayP, valid_on: day, holder: { person_id: riv[1] } }] } })).status, 400, 'no session: no household people');
  // Saved family: sizes and levels, and a new child.
  assert.equal((await pub('PATCH', `/account/people/${riv[1]}`, { session: rivS, body: { height_in: 50, weight_lb: 60, boot_size: '21.5', ski_level: 3, stance: 'regular' } })).status, 200);
  const added = await pub('POST', '/account/people', { session: rivS, body: { first_name: 'Dee', last_name: 'Rivera', date_of_birth: `${year - 5}-01-10` } });
  assert.equal(added.status, 201);
  const again = (await pub('GET', '/account', { session: rivS })).body;
  assert.equal(again.members.length, 5);
  assert.equal(again.members.find((m) => m.id === riv[1]).boot_size, '21.5');
  assert.ok(!(await pub('GET', '/account', { session: otherS })).body.members.some((m) => m.id === added.body.id));
});

let firstOrder;
test('one prefilled checkout: a household of 4 for a day, rentals in their sizes and a lesson hand-off, nothing typed', async () => {
  const b = await pub('POST', '/account/basket', { session: rivS, body: { date: day, people: [{ id: riv[0] }, { id: riv[1], rental: true }, { id: riv[2], rental: true, lesson: true }, { id: riv[3] }] } });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.body.basket.items.length, 4);
  assert.equal(b.body.basket.addons.length, 2);
  assert.match(b.body.lesson_link, new RegExp(`/book/${A.slug}\\?date=${day}`));
  const qt = await pub('POST', '/shop/quote', { session: rivS, body: b.body.basket });
  assert.equal(qt.status, 200, qt.text);
  assert.equal(qt.body.subtotal_cents, 6000 + 3000 * 3 + 4000 * 2);
  const { row } = await payFor({ ...contact, ...b.body.basket }, rivS);
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  firstOrder = (await q('SELECT order_id FROM shop_orders WHERE id = ?', [row.id]))[0].order_id;
  const tk = await q('SELECT t.person_id FROM tickets t JOIN order_items i ON i.id = t.order_item_id WHERE i.order_id = ? AND i.line_kind = ? ORDER BY t.id', [firstOrder, 'ticket']);
  assert.deepEqual(tk.map((x) => x.person_id).slice(0, 4), riv, 'each ticket is for the right person, no new records');
  const fits = await q("SELECT person_id, status FROM rental_contracts WHERE tenant_id = ? AND person_id IN (?) AND status = 'to_fit'", [A.id, [riv[1], riv[2]]]);
  assert.equal(fits.length, 2, 'rentals wait in Ready to fit');
  assert.equal((await q('SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND last_name = ?', [A.id, 'Rivera']))[0].n, 5, 'no duplicate people');
});

test('the designed confirmation: barcode, first-timer steps, the guarantee link when the mountain offers it, a plain-text part', async () => {
  const fair = require('../src/lib/fairprice');
  const was = fair.guaranteeLink;
  fair.guaranteeLink = async (_db, _t, ticketId, b) => `${b}/guarantee/${A.slug}/tok${ticketId}`;
  try {
    const S = require('../src/lib/salemail');
    const c = await S.confirmation(A.id, { orderId: firstOrder }, 'https://app.test');
    const code = c.tickets[0].code;
    assert.ok(c.html.includes(`Barcode ${code}`), 'the barcode is drawn in the email');
    assert.ok(c.html.includes('bgcolor="#000000"'), 'as table cells, so mail apps show it');
    assert.ok(c.html.includes(code) && c.text.includes(code));
    assert.match(c.html, /your first day, step by step/);
    assert.match(c.html, /guarantee\/ga-/);
    assert.match(c.html, /data-slot="wallet" style="display:none/);
    assert.match(c.text, /Where to park:/);
    assert.ok(!/—/.test(c.html + c.text), 'no em dashes');
  } finally { fair.guaranteeLink = was; }
  const shopMail = mails.find((m) => m.To === 'pat@rivera.test' && /Your tickets for/.test(m.Subject));
  assert.ok(shopMail && shopMail.HtmlBody && shopMail.TextBody, 'the shop order email went with both parts');
});

test('rebuy: "Same as last time" builds the same people and rentals for a new day', async () => {
  const d2 = plus(today, 6);
  const b = await pub('POST', '/account/basket', { session: rivS, body: { date: d2, same_as_last: true } });
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(b.body.basket.items.map((i) => i.holder.person_id), riv);
  assert.equal(b.body.basket.addons.length, 2);
  assert.ok(b.body.basket.items.every((i) => i.valid_on === d2));
  assert.equal((await pub('POST', '/account/basket', { session: otherS, body: { date: d2, same_as_last: true } })).status, 409, 'nothing to repeat');
});

test('renewing a season pass uses last season\'s photo once the guest says it is still them', async () => {
  await pool.query('UPDATE people SET photo = ? WHERE id = ?', [PHOTO, riv[0]]);
  const prevSeasonDay = `${Number(require('../src/lib/util').seasonFor(today).slice(0, 4)) - 1}-12-01`;
  const [oi] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, discount_cents, tax_cents, total_cents, channel) VALUES (?, ?, 'paid', 0, 0, 0, 0, 'online')", [A.id, riv[0]]);
  const [it] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents) VALUES (?, ?, ?, 'ticket', ?, 'adult', 1, 0)", [A.id, oi.insertId, passP, riv[0]]);
  await pool.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', [A.id, it.insertId, riv[0], passP, `OLD${suffix}`.toUpperCase(), prevSeasonDay, plus(prevSeasonDay, 120)]);
  const acc = (await pub('GET', '/account', { session: rivS })).body;
  assert.ok(acc.renew.some((x) => x.person_id === riv[0] && x.has_photo));
  assert.equal((await pub('POST', '/account/renew', { session: rivS, body: { person_id: riv[0], product_id: passP } })).status, 400, 'the guest must confirm the photo');
  const r = await pub('POST', '/account/renew', { session: rivS, body: { person_id: riv[0], product_id: passP, photo_is_me: true } });
  assert.equal(r.status, 200, r.text);
  const { row } = await payFor({ ...contact, ...r.body.basket }, rivS);
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  const pass = await q("SELECT t.person_id FROM tickets t JOIN order_items i ON i.id = t.order_item_id JOIN shop_orders s ON s.order_id = i.order_id WHERE s.id = ? AND t.product_id = ?", [row.id, passP]);
  assert.deepEqual(pass.map((x) => x.person_id), [riv[0]]);
});

test('a reward is used online once, inside the order; a second order with it is refunded; a refund puts it back', async () => {
  const R = require('../src/lib/rewards');
  const rw = await R.issue(pool, A.id, { personId: riv[1], kind: 'birthday', options: { free_ticket: { product_id: dayP }, percent: { percent: 50 } }, validFrom: today, validTo: plus(today, 10), sourceKey: 'birthday:test' });
  const acc = (await pub('GET', '/account', { session: rivS })).body;
  const held = acc.rewards.find((x) => x.id === rw.id);
  assert.ok(held && held.choices.length === 2);
  assert.equal((await pub('POST', '/shop/quote', { session: otherS, body: { items: [{ product_id: dayP, valid_on: day, holder: { person_id: other[0] } }], reward: { id: rw.id, choice: 'percent', for_item: 0 } } })).status, 400, 'not your reward');
  const basket = { items: [{ product_id: dayP, valid_on: day, holder: { person_id: riv[1] } }], reward: { id: rw.id, choice: 'free_ticket', for_item: 0 } };
  const qt = await pub('POST', '/shop/quote', { session: rivS, body: { ...basket, items: [...basket.items, { product_id: dayP, valid_on: day, holder: { person_id: riv[0] } }] } });
  assert.equal(qt.status, 200, qt.text);
  assert.equal(qt.body.reward.cents, 3000);
  assert.equal(qt.body.total_cents, 6000, 'the child ticket is free');
  const one = await payFor({ ...contact, ...basket, items: [...basket.items, { product_id: dayP, valid_on: day, holder: { person_id: riv[0] } }] }, rivS);
  const two = await payFor({ ...contact, ...basket, items: [...basket.items, { product_id: dayP, valid_on: day, holder: { person_id: riv[0] } }] }, rivS);
  const [w1, w2] = await Promise.all([webhook(paidEvent(one.row, A.id)), webhook(paidEvent(two.row, A.id))]);
  assert.equal(w1.status, 200); assert.equal(w2.status, 200);
  const states = await q('SELECT status FROM shop_orders WHERE id IN (?) ORDER BY id', [[one.row.id, two.row.id]]);
  assert.deepEqual(states.map((s) => s.status).sort(), ['paid', 'refunded'], 'only one order could use it');
  const used = (await q('SELECT * FROM guest_rewards WHERE id = ?', [rw.id]))[0];
  assert.equal(used.status, 'redeemed'); assert.equal(used.chosen, 'free_ticket');
  assert.equal((await q('SELECT COUNT(*) AS n FROM order_items WHERE reward_id = ?', [rw.id]))[0].n, 1);
  await R.release(pool, A.id, used.order_id);
  assert.equal((await q('SELECT status FROM guest_rewards WHERE id = ?', [rw.id]))[0].status, 'offered');
});

test('the morning-of message goes once per order per day, by email, and by text only with consent', async () => {
  const { runMorning } = require('../src/routes/guestsaccount');
  const { row } = await payFor({ ...contact, items: [{ product_id: dayP, valid_on: today, holder: { person_id: riv[0] } }] }, rivS);
  await webhook(paidEvent(row, A.id));
  const sms = require('../src/lib/sms');
  const texts = []; const was = { enabled: sms.enabled, send: sms.send };
  sms.enabled = () => true; sms.send = async (m) => { texts.push(m); return { ok: true }; };
  try {
    const t = (await q('SELECT id, slug, name, timezone FROM tenants WHERE id = ?', [A.id]))[0];
    await pool.query("INSERT INTO account_settings (tenant_id, morning_time) VALUES (?, '00:00') ON DUPLICATE KEY UPDATE morning_time = '00:00'", [A.id]);
    const before = mails.length;
    const sent = await runMorning(t, 'https://app.test', { now: `${today} 07:05:00` });
    assert.ok(sent >= 1);
    const mine = mails.slice(before).filter((m) => m.Subject === `Today at ${t.name}`);
    assert.ok(mine.length >= 1);
    assert.equal(texts.length, 0, 'no text without consent');
    assert.equal(await runMorning(t, 'https://app.test', { now: `${today} 07:10:00` }), 0, 'once per order per day');
    // With consent recorded, a new order's message is texted too.
    const { recordConsent } = require('../src/lib/consent');
    const buyer = (await q('SELECT person_id FROM orders WHERE id = (SELECT order_id FROM shop_orders WHERE id = ?)', [row.id]))[0].person_id;
    await recordConsent(pool, A.id, buyer, 'sms', 'opted_in', 'online', null);
    const { row: r2 } = await payFor({ ...contact, items: [{ product_id: dayP, valid_on: today, holder: { person_id: riv[1] } }] }, rivS);
    await webhook(paidEvent(r2, A.id));
    await runMorning(t, 'https://app.test', { now: `${today} 07:20:00` });
    assert.equal(texts.length, 1);
    assert.match(texts[0].body, /Today at/);
  } finally { sms.enabled = was.enabled; sms.send = was.send; }
});

test('reload a card online: a day goes onto the card, the gate accepts it, and a card holding a good pass is refused', async () => {
  await pool.query("INSERT INTO rfid_cards (tenant_id, uid, label, status) VALUES (?, 'A1B2C3D4', 'K-1001', 'free')", [A.id]);
  assert.equal((await pub('POST', '/reload/check', { body: { card: 'K-1001' } })).body.ok, true);
  assert.equal((await pub('POST', '/reload/check', { body: { card: 'NOPE-0000' } })).body.ok, false);
  const { row } = await payFor({ ...contact, items: [{ product_id: dayP, valid_on: today, holder: { first_name: 'Walk', last_name: 'Up', age_group: 'adult' } }], reload_card: 'K-1001' });
  assert.equal((await webhook(paidEvent(row, A.id))).status, 200);
  const card = (await q("SELECT c.status, t.valid_from FROM rfid_cards c JOIN tickets t ON t.id = c.ticket_id WHERE c.tenant_id = ? AND c.uid = 'A1B2C3D4'", [A.id]))[0];
  assert.equal(card.status, 'assigned');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const d = await require('../src/lib/access').decide(conn, A.id, { uid: 'A1B2C3D4', via: 'rfid', location: 'Base lift' });
    await conn.commit();
    assert.equal(d.valid, true, `the gate accepts the card (${d.result})`);
  } finally { conn.release(); }
  assert.equal((await pub('POST', '/reload/check', { body: { card: 'K-1001' } })).body.ok, false, 'it holds today\'s ticket now');
  assert.equal((await pub('POST', '/shop/orders', { body: { ...contact, items: [{ product_id: dayP, valid_on: today, holder: { first_name: 'Walk', last_name: 'Up', age_group: 'adult' } }], reload_card: 'K-1001' } })).status, 409);
});

test('a gift experience: priced on the server, delivered on its date, revealed by its link, redeemed once into an account; the balance page', async () => {
  const menu = (await pub('GET', '/gifts/menu')).body;
  assert.ok(menu.themes.includes('First day on snow'));
  const exp = { theme: 'First day on snow', includes: ['ticket', 'rental'], from_name: 'Grandpa Joe', recipient_name: 'Mia Lane', recipient_email: 'mia@lane.test', message: 'Have fun!', deliver_on: plus(today, 1) };
  const qt = await pub('POST', '/shop/quote', { body: { gifts: [{ experience: exp }] } });
  assert.equal(qt.status, 200, qt.text);
  assert.equal(qt.body.total_cents, 6000 + 4000);
  const { row } = await payFor({ ...contact, gifts: [{ experience: exp }] });
  await webhook(paidEvent(row, A.id));
  const g = (await q('SELECT * FROM gift_experiences WHERE tenant_id = ? AND recipient_email = ?', [A.id, 'mia@lane.test']))[0];
  assert.ok(g && !g.delivered_at);
  const { runGifts } = require('../src/routes/guestsaccount');
  const t = (await q('SELECT id, slug, name, timezone FROM tenants WHERE id = ?', [A.id]))[0];
  assert.equal(await runGifts(t, 'https://app.test'), 0, 'not before its date');
  await pool.query('UPDATE gift_experiences SET deliver_on = ? WHERE id = ?', [today, g.id]);
  assert.equal(await runGifts(t, 'https://app.test'), 1);
  assert.equal(await runGifts(t, 'https://app.test'), 0, 'delivered once');
  const m = mails.find((x) => x.To === 'mia@lane.test' && /sent you a gift/.test(x.Subject));
  const token = new RegExp(`/gift/${A.slug}/([A-Za-z0-9_-]+)`).exec(m.TextBody)[1];
  assert.equal((await pub('GET', '/gift/not-the-token-at-all')).status, 404);
  const rev = (await pub('GET', `/gift/${token}`)).body;
  assert.equal(rev.theme, 'First day on snow'); assert.equal(rev.code, null, 'no code before it is redeemed');
  const red = await pub('POST', `/gift/${token}/redeem`, { body: { first_name: 'Mia', last_name: 'Lane' } });
  assert.equal(red.status, 200, red.text);
  assert.ok(red.body.code);
  assert.equal((await pub('POST', `/gift/${token}/redeem`, { body: { first_name: 'Mia', last_name: 'Lane' } })).status, 409, 'once');
  assert.equal((await q("SELECT COUNT(*) AS n FROM people WHERE tenant_id = ? AND email = 'mia@lane.test'", [A.id]))[0].n, 1, 'she has an account now');
  const bal = (await pub('POST', '/gift-balance', { body: { code: red.body.code } })).body;
  assert.equal(bal.found, true); assert.equal(bal.balance_cents, 10000);
  assert.equal((await pub('POST', '/gift-balance', { body: { code: 'ZZZZZZZZZZ' } })).body.found, false);
});

test('the shop calendar carries each day\'s next price rise and the fair badges (Track FAIR fills them)', async () => {
  const fair = require('../src/lib/fairprice');
  const was = { calendarRises: fair.calendarRises, badges: fair.badges };
  // FAIR's calendarRises adds next_rise only for early-buy products; the shop's side is that it carries what FAIR returns
  fair.calendarRises = async (_db, _t, days) => { for (const [d, v] of Object.entries(days)) if (v && v.state === 'open') v.next_rise = { on: plus(d, -1), cents: 500 }; return days; };
  fair.badges = async () => [{ key: 'price_promise', text: 'Price promise' }];
  try {
    const ym = plus(today, 40).slice(0, 7);
    const m = (await pub('GET', `/shop/month?month=${ym}`)).body;
    const anyDay = Object.values(m.days).find((d) => d.state === 'open');
    assert.ok(anyDay && anyDay.next_rise && anyDay.next_rise.cents === 500);
    assert.deepEqual(m.badges, [{ key: 'price_promise', text: 'Price promise' }]);
    assert.equal((await pub('GET', '/shop')).body.badges[0].text, 'Price promise');
  } finally { Object.assign(fair, was); }
});

// ---------------------------------------------------------------- guests round 2 fixes
test('fix: counter staff add a gift experience only to a gift card they sold today; a manager to any', async () => {
  const email = `counter-gx-${Date.now()}@${A.slug}.test`;
  assert.equal((await api('POST', '/users', { token: A.owner, body: { email, password: PW, role: 'counter' } })).status, 201);
  const counter = (await api('POST', '/auth/login', { body: { tenant: A.slug, email, password: PW } })).body.token;
  const cid = (await q('SELECT id FROM users WHERE tenant_id = ? AND email = ?', [A.id, email]))[0].id;
  const card = async (userId) => {
    const [o] = await pool.query("INSERT INTO orders (tenant_id, user_id, status, subtotal_cents, tax_cents, total_cents, channel) VALUES (?, ?, 'paid', 5000, 0, 5000, 'window')", [A.id, userId]);
    const [g] = await pool.query('INSERT INTO gift_cards (tenant_id, code, initial_cents, balance_cents, order_id) VALUES (?, ?, 5000, 5000, ?)', [A.id, `GX${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(0, 20), o.insertId]);
    return g.insertId;
  };
  const gift = (id) => ({ gift_card_id: id, theme: 'A day on the mountain', amount_cents: 5000, from_name: 'Sam', recipient_name: 'Lee Park', recipient_email: 'lee@park.test', deliver_on: plus(today, 1) });
  const someoneElses = await card(null);
  assert.equal((await api('POST', '/guests/gift-experiences', { token: counter, body: gift(someoneElses) })).status, 403, 'not their sale: a manager');
  assert.equal((await api('POST', '/guests/gift-experiences', { token: counter, body: gift(await card(cid)) })).status, 201, 'a card they just sold');
  assert.equal((await api('POST', '/guests/gift-experiences', { token: A.owner, body: gift(someoneElses) })).status, 201, 'a manager may');
});
