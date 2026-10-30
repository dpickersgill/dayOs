'use strict';

// Guests round 2, Track FAIR: fair by design. The price calendar's next rise, the walk-up cap at the window, the
// price-drop promise, closure credits, the conditions guarantee, the fair scan review with blocks a guest can answer,
// payment plans on the mountain's own Stripe account, auto-renew and the waitlist for a capped pass. Stripe and
// Postmark are mock servers.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.FAIR_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.STRIPE_GUEST_FALLBACK = 'on';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'hello@summitops.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const mailer = require('../src/lib/mailer');
const { createApp } = require('../src/app');
const { pool, tx } = require('../src/db');
const F = require('../src/lib/fairprice');
const PP = require('../src/lib/paymentplans');
const AR = require('../src/lib/autorenew');

let server; let base; let stripeMock; let pmMock; const calls = []; const mails = []; let n = 0;
let failCharges = false; let lastSetupMeta = null;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const q = async (sql, params) => (await pool.query(sql, params))[0];
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const plus = (d, k) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
const DEVICE = 'test-device-0123456789abcdef';
async function call(prefix, method, path, { token, body, headers } = {}) {
  const res = await fetch(`${base}${prefix}${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const api = (m, p, o) => call('/api/v1', m, p, o);
const ok = (r, status = 200) => { assert.equal(r.status, status, r.text); return r.body; };
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: `Mount ${slug}`, phone: '215-555-0000', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  const owner = (await api('POST', '/auth/login', { body: { tenant: slug, email: `owner@${slug}.test`, password: PW } })).body.token;
  return { slug, owner, id: (await q('SELECT id FROM tenants WHERE slug = ?', [slug]))[0].id };
}
async function addUser(m, email, role) {
  assert.equal((await api('POST', '/users', { token: m.owner, body: { email, password: PW, role } })).status, 201);
  return (await api('POST', '/auth/login', { body: { tenant: m.slug, email, password: PW } })).body.token;
}
const linkIn = (mail, kind) => { const m = new RegExp(`/${kind}/[^/\\s]+/([A-Za-z0-9_-]{30,80})`).exec(mail.TextBody || ''); return m && m[1]; };
const mailTo = (to, re) => mails.filter((m) => m.To.includes(to) && (!re || re.test(m.Subject)));

let A; let counter; let dayP; let earlyP; let passP; let seq = 0;
/** A person, an order, a line and a ticket, written directly: channel, card payment, price and days as given. */
async function sold({ product, person = null, cents = 6000, from = today, to = from, channel = 'online', card = true, tax = 0, tier = 'adult' }) {
  seq += 1;
  let pid = person;
  if (!pid) {
    const [p] = await pool.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [A.id, `Gus${seq}`, 'Guest', `gus${seq}-${suffix}@x.test`]);
    pid = p.insertId;
  }
  const [o] = await pool.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, tax_cents, total_cents, channel) VALUES (?, ?, 'paid', ?, ?, ?, ?)", [A.id, pid, cents, tax, cents + tax, channel]);
  const [i] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, tax_cents) VALUES (?, ?, ?, 'ticket', ?, ?, 1, ?, ?, ?)", [A.id, o.insertId, product, pid, tier, cents, from, tax]);
  const code = `T${suffix}${seq}`.toUpperCase().slice(0, 20);
  const [k] = await pool.query('INSERT INTO tickets (tenant_id, order_item_id, person_id, product_id, code, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)', [A.id, i.insertId, pid, product, code, from, to]);
  await pool.query('INSERT INTO order_payments (tenant_id, order_id, tender, amount_cents, reference, processor) VALUES (?, ?, ?, ?, ?, ?)', [A.id, o.insertId, card ? 'card' : 'cash', cents + tax, card ? `pi_t${suffix}${seq}` : null, card ? 'stripe' : null]);
  return { personId: pid, orderId: o.insertId, itemId: i.insertId, ticketId: k.insertId, code, email: `gus${seq}-${suffix}@x.test`, pi: `pi_t${suffix}${seq}` };
}
const settings = (body) => api('PATCH', '/guests/settings', { token: A.owner, body });
const scan = (code) => api('POST', '/tickets/scan', { token: counter, body: { code, location: 'Gate' } });

test.before(async () => {
  stripeMock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ method: req.method, path: req.url, params, key: req.headers['idempotency-key'] });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/v1/refunds') res.end(JSON.stringify({ id: `re_${++n}`, status: 'succeeded' }));
      else if (req.method === 'POST' && req.url === '/v1/payment_intents') {
        if (failCharges) { res.statusCode = 402; res.end(JSON.stringify({ error: { message: 'Your card was declined.' } })); return; }
        res.end(JSON.stringify({ id: `pi_off_${++n}`, status: 'succeeded' }));
      } else if (req.method === 'GET' && req.url.startsWith('/v1/payment_intents/')) {
        res.end(JSON.stringify({ id: req.url.split('/')[3].split('?')[0], customer: 'cus_mock', payment_method: { id: 'pm_mock', card: { brand: 'visa', last4: '4242' } } }));
      } else if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        lastSetupMeta = { tenant_id: params['metadata[tenant_id]'], kind: params['metadata[kind]'], ref_id: params['metadata[ref_id]'] };
        res.end(JSON.stringify({ id: `cs_setup_${++n}`, url: `https://checkout.stripe.test/s/${n}` }));
      } else if (req.method === 'GET' && req.url.startsWith('/v1/checkout/sessions/')) {
        res.end(JSON.stringify({ id: req.url.split('/')[4].split('?')[0], status: 'complete', metadata: lastSetupMeta, customer: 'cus_new', setup_intent: { payment_method: { id: 'pm_new', card: { brand: 'visa', last4: '1111' } } } }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  pmMock = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { mails.push(JSON.parse(d)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m-${++n}` })); }); });
  await new Promise((r) => stripeMock.listen(0, '127.0.0.1', r));
  await new Promise((r) => pmMock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${stripeMock.address().port}`;
  mailer.settings.apiBase = `http://127.0.0.1:${pmMock.address().port}`;
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  config.stripe.publicUrl = base;
  A = await mountain(`fa-${suffix}`);
  counter = await addUser(A, `counter@${A.slug}.test`, 'counter');
  const mk = async (b) => ok(await api('POST', '/products', { token: A.owner, body: b }), 201).id;
  dayP = await mk({ kind: 'day_ticket', name: 'Day ticket', base_price_cents: 6000, online: 1 });
  earlyP = await mk({ kind: 'day_ticket', name: 'Saver day', base_price_cents: 6000, online: 1, advance_days: 7, advance_percent: 20 });
  passP = await mk({ kind: 'season_pass', name: 'Season pass', base_price_cents: 45000, valid_days: 200, online: 1 });
  ok(await api('PUT', '/tenant/profile', { token: A.owner, body: { online_shop: true } }));
  await q('UPDATE tenants SET scan_passback_seconds = 0 WHERE id = ?', [A.id]); // the same pass is scanned again and again here
});
test.after(async () => { config.stripe.publicUrl = ''; await new Promise((r) => server.close(r)); await new Promise((r) => stripeMock.close(r)); await new Promise((r) => pmMock.close(r)); await pool.end(); });

test('every promise is off by default, and the shop shows no badges until one is on', async () => {
  const s = ok(await api('GET', '/guests/fair/settings', { token: A.owner }));
  for (const k of ['walkup_cap_on', 'price_promise_on', 'closure_credit_on', 'conditions_guarantee_on', 'plans_on', 'autorenew_on']) assert.equal(Number(s[k]), 0, k);
  assert.deepEqual(s.badges, []);
  assert.deepEqual(ok(await api('GET', `/public/${A.slug}/fair`)).badges, []);
  assert.equal((await api('PATCH', '/guests/fair/settings', { token: counter, body: { travel_minutes: 9 } })).status, 403, 'managers only');
});

test('next rise: the early price for a day ends advance_days before it, and the shop calendar shows it', async () => {
  const far = plus(today, 10);
  const r = await F.nextRise(pool, A.id, earlyP, far, { today });
  assert.deepEqual(r, { on: plus(far, -6), cents: 1200, from_cents: 4800, to_cents: 6000 });
  assert.equal(await F.nextRise(pool, A.id, earlyP, plus(today, 3), { today }), null, 'the early price already ended for this day');
  assert.equal(await F.nextRise(pool, A.id, dayP, far, { today }), null, 'no early price, no rise');
  const month = ok(await api('GET', `/public/${A.slug}/shop/month?month=${far.slice(0, 7)}`));
  assert.equal(month.days[far].next_rise.cents, 1200);
  assert.equal(month.days[far].next_rise.on, plus(far, -6));
  assert.deepEqual(month.badges, []);
  assert.equal(ok(await api('GET', `/guests/fair/next-rise?product_id=${earlyP}&day=${far}`, { token: counter })).next_rise.cents, 1200);
});

test('the walk-up cap: the window never charges more than the cap over the best online price, and says so', async () => {
  const quote = async () => ok(await api('POST', '/checkout/quote', { token: counter, body: { lines: [{ type: 'ticket', product_id: earlyP, quantity: 1, tier: 'adult' }] } })).lines[0];
  assert.equal((await quote()).unit_price_cents, 6000, 'off: the full window price');
  ok(await settings({ walkup_cap_on: true, walkup_cap_cents: 500 }));
  const l = await quote();
  assert.equal(l.unit_price_cents, 5300, 'online best 4800 plus 5.00');
  assert.deepEqual(l.walkup, { from_cents: 6000, online_cents: 4800, cap_cents: 500 });
  assert.match(l.detail, /walk-up cap applied/);
  const plain = ok(await api('POST', '/checkout/quote', { token: counter, body: { lines: [{ type: 'ticket', product_id: dayP, quantity: 1, tier: 'adult' }] } })).lines[0];
  assert.equal(plain.unit_price_cents, 6000, 'no early price online: nothing to cap');
  assert.ok(ok(await api('GET', `/public/${A.slug}/fair`)).badges.some((b) => b.key === 'walkup_cap'));
  ok(await settings({ walkup_cap_on: false }));
});

test('price-drop promise: an online ticket gets the difference back once per drop; window cash sales are skipped', async () => {
  const day = plus(today, 20);
  const t = await sold({ product: dayP, cents: 6000, from: day, tax: 600 });
  const cash = await sold({ product: dayP, cents: 6000, from: day, channel: 'window', card: false });
  assert.equal((await F.priceDrops(A.id)).refunded, 0, 'off by default');
  ok(await settings({ price_promise_on: true }));
  assert.equal((await F.priceDrops(A.id)).refunded, 0, 'the price has not moved');
  ok(await api('PUT', `/products/${dayP}/calendar`, { token: A.owner, body: { entries: [{ on_date: day, price_cents: 5000 }] } }));
  const before = calls.filter((c) => c.path === '/v1/refunds').length;
  assert.equal((await F.priceDrops(A.id)).refunded, 1);
  assert.equal((await F.priceDrops(A.id)).refunded, 0, 'the same drop is never refunded twice');
  const refunds = calls.filter((c) => c.path === '/v1/refunds').slice(before);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].params.amount, '1100', '10.00 plus its 10% tax');
  assert.equal(refunds[0].params.payment_intent, t.pi);
  const [o] = await q('SELECT refunded_cents FROM orders WHERE id = ?', [t.orderId]);
  assert.equal(o.refunded_cents, 1100);
  assert.equal((await q("SELECT COUNT(*) AS n FROM order_refunds WHERE order_id = ? AND reason = 'price_promise' AND card_status = 'sent'", [t.orderId]))[0].n, 1);
  assert.equal((await q('SELECT COUNT(*) AS n FROM order_refunds WHERE order_id = ?', [cash.orderId]))[0].n, 0, 'cash at the window: skipped');
  assert.equal(mailTo(t.email, /price for your day went down/).length, 1);
  ok(await api('PUT', `/products/${dayP}/calendar`, { token: A.owner, body: { entries: [{ on_date: day, price_cents: 4500 }] } }));
  assert.equal((await F.priceDrops(A.id)).refunded, 1, 'a further drop is refunded too');
  assert.equal((await q('SELECT refunded_cents FROM orders WHERE id = ?', [t.orderId]))[0].refunded_cents, 1650);
  assert.ok((await q("SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND action = 'price_promise_refund'", [A.id]))[0].n >= 2);
  ok(await settings({ price_promise_on: false }));
});

test('closure credits: a preview first, then one credit per ticket that did not ski, once', async () => {
  const day = plus(today, -1);
  const skipped = await sold({ product: dayP, cents: 6000, from: day });
  const skied = await sold({ product: dayP, cents: 6000, from: day });
  await q("INSERT INTO scans (tenant_id, ticket_id, code, location, result, scanned_at) VALUES (?, ?, ?, 'Gate', 'ok', ?)", [A.id, skied.ticketId, skied.code, `${day} 16:00:00`]);
  const pre = ok(await api('POST', '/guests/fair/closures/preview', { token: A.owner, body: { day } }));
  assert.deepEqual(pre.items.map((i) => i.ticket_id), [skipped.ticketId]);
  assert.equal(pre.items[0].cents, 6000);
  assert.equal(pre.items[0].person_id, undefined, 'the preview does not send ids it does not need');
  assert.equal((await api('POST', '/guests/fair/closures', { token: A.owner, body: { day } })).status, 409, 'off');
  ok(await settings({ closure_credit_on: true }));
  assert.equal((await api('POST', '/guests/fair/closures', { token: counter, body: { day } })).status, 403);
  const r = ok(await api('POST', '/guests/fair/closures', { token: A.owner, body: { day, reason: 'High winds' } }), 201);
  assert.equal(r.issued, 1);
  assert.equal(ok(await api('POST', '/guests/fair/closures', { token: A.owner, body: { day } }), 201).issued, 0, 'once per ticket');
  const [rw] = await q("SELECT * FROM guest_rewards WHERE tenant_id = ? AND kind = 'closure' AND person_id = ?", [A.id, skipped.personId]);
  assert.equal((typeof rw.options === 'string' ? JSON.parse(rw.options) : rw.options).credit.cents, 6000);
  assert.equal(mailTo(skipped.email, /credit/).length, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM guest_rewards WHERE tenant_id = ? AND person_id = ? AND kind = 'closure'", [A.id, skied.personId]))[0].n, 0);
  ok(await settings({ closure_credit_on: false }));
});

test('conditions guarantee: a private link, within the hours after the first lift only, once per ticket', async () => {
  const t = await sold({ product: dayP, cents: 5500, from: today });
  assert.equal(await F.guaranteeLink(pool, A.id, t.ticketId, base), null, 'off: no link');
  ok(await settings({ conditions_guarantee_on: true, conditions_hours: 2 }));
  const url = await F.guaranteeLink(pool, A.id, t.ticketId, base);
  assert.match(url, new RegExp(`^${base}/guarantee/${A.slug}/[A-Za-z0-9_-]{43}$`));
  const token = url.split('/').pop();
  assert.equal((await q('SELECT COUNT(*) AS n FROM fair_links WHERE token_hash = ?', [F.hash(token)]))[0].n, 1, 'stored hashed');
  assert.equal((await q('SELECT COUNT(*) AS n FROM fair_links WHERE token_hash = ?', [token]))[0].n, 0);
  const page = await fetch(`${base}/guarantee/${A.slug}/${token}`); assert.equal(page.status, 200);
  const pub = (m, b) => api(m, `/public/${A.slug}/guarantee/${token}`, { body: b });
  assert.equal(ok(await pub('GET')).state, 'waiting', 'not scanned yet');
  assert.equal((await pub('POST', {})).status, 409);
  ok(await scan(t.code));
  const v = ok(await pub('GET'));
  assert.equal(v.state, 'open'); assert.equal(v.credit_cents, 5500);
  const c = ok(await pub('POST', { note: 'Icy' }));
  assert.equal(c.state, 'claimed'); assert.equal(c.reward.cents, 5500);
  assert.equal(ok(await pub('POST', {})).state, 'claimed', 'a second tap gives nothing more');
  assert.equal((await q("SELECT COUNT(*) AS n FROM guest_rewards WHERE tenant_id = ? AND kind = 'conditions' AND person_id = ?", [A.id, t.personId]))[0].n, 1);
  assert.equal((await api('GET', `/public/${A.slug}/guarantee/${token.slice(0, -2)}xx`)).status, 404);
  // After the hours: closed.
  const late = await sold({ product: dayP, cents: 5500, from: today });
  ok(await scan(late.code));
  await q('UPDATE scans SET scanned_at = DATE_SUB(scanned_at, INTERVAL 3 HOUR) WHERE ticket_id = ?', [late.ticketId]);
  const lt = (await F.guaranteeLink(pool, A.id, late.ticketId, base)).split('/').pop();
  assert.equal(ok(await api('GET', `/public/${A.slug}/guarantee/${lt}`)).state, 'closed');
  // A manager turns it off for today.
  const third = await sold({ product: dayP, cents: 5500, from: today });
  ok(await scan(third.code));
  ok(await api('PUT', `/guests/fair/guarantee/off/${today}`, { token: A.owner, body: { off: true } }));
  const tt = (await F.guaranteeLink(pool, A.id, third.ticketId, base)).split('/').pop();
  assert.match(ok(await api('GET', `/public/${A.slug}/guarantee/${tt}`)).why, /off today/);
  const list = ok(await api('GET', '/guests/fair/guarantee', { token: A.owner }));
  assert.equal(list.data.length, 1); assert.ok(list.off_days.includes(today));
  ok(await api('PUT', `/guests/fair/guarantee/off/${today}`, { token: A.owner, body: { off: false } }));
});

test('fair scan review: flags with evidence, nothing automatic; a manager blocks with a reason, the guest answers, unblock', async () => {
  const t = await sold({ product: passP, cents: 45000, from: today, to: plus(today, 100) });
  await q("INSERT INTO scans (tenant_id, ticket_id, code, location, result, scanned_at) VALUES (?, ?, ?, 'Summit Chair', 'ok', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)), (?, ?, ?, 'Base Quad', 'ok', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 590 SECOND))",
    [A.id, t.ticketId, t.code, A.id, t.ticketId, t.code]);
  const u = await sold({ product: passP, cents: 45000, from: today, to: plus(today, 100) });
  await q("INSERT INTO scans (tenant_id, ticket_id, code, location, result, scanned_at) VALUES (?, ?, ?, 'Summit Chair', 'ok', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)), (?, ?, ?, 'Base Quad', 'ok', DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 MINUTE))",
    [A.id, u.ticketId, u.code, A.id, u.ticketId, u.code]);
  for (let i = 0; i < 5; i += 1) await F.noteFailedReload(pool, A.id, { uid: '04AABBCCDD', why: 'declined' });
  assert.equal((await F.detect(A.id)).flagged, 3);
  assert.equal((await F.detect(A.id)).flagged, 0, 'the same evidence is flagged once');
  const r = ok(await api('GET', '/guests/fair/review', { token: A.owner }));
  const kinds = r.flags.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['failed_reloads', 'far_apart', 'two_gates']);
  const two = r.flags.find((f) => f.kind === 'two_gates');
  assert.equal(two.ticket_id, t.ticketId); assert.equal(two.evidence.scans.length, 2);
  assert.equal(ok(await scan(t.code)).result, 'ok', 'a flag blocks nothing');
  assert.equal((await api('GET', '/guests/fair/review', { token: counter })).status, 403);
  assert.equal((await api('POST', '/guests/fair/blocks', { token: counter, body: { ticket_id: t.ticketId, reason: 'Shared pass' } })).status, 403);
  const b = ok(await api('POST', '/guests/fair/blocks', { token: A.owner, body: { ticket_id: t.ticketId, flag_id: two.id, reason: 'This pass went through two gates 10 seconds apart.' } }), 201);
  assert.equal(b.emailed, true);
  const g = ok(await scan(t.code));
  assert.equal(g.result, 'blocked'); assert.equal(g.valid, false); assert.match(g.reason, /on hold/);
  const mail = mailTo(t.email, /on hold/)[0];
  assert.match(mail.TextBody, /two gates 10 seconds apart/);
  const token = linkIn(mail, 'blocked');
  const view = ok(await api('GET', `/public/${A.slug}/blocked/${token}`));
  assert.equal(view.status, 'active'); assert.match(view.reason, /two gates/);
  ok(await api('POST', `/public/${A.slug}/blocked/${token}`, { body: { reply: 'My son borrowed it, sorry. It will not happen again.' } }));
  const after = ok(await api('GET', '/guests/fair/review', { token: A.owner }));
  assert.match(after.blocks[0].reply, /borrowed/);
  assert.equal(after.flags.find((f) => f.id === two.id).status, 'blocked');
  ok(await api('POST', `/guests/fair/blocks/${b.id}/lift`, { token: A.owner, body: { note: 'Thanks for explaining.' } }));
  assert.equal(ok(await scan(t.code)).result, 'ok');
  assert.equal(mailTo(t.email, /works again/).length, 1);
  assert.equal((await api('POST', `/public/${A.slug}/blocked/${token}`, { body: { reply: 'again' } })).status, 409, 'nothing to answer once lifted');
});

test('payment plans: quote, start, scheduled charges, failure and retries, hold at the gate, a new card, settle', async () => {
  const basket = { lines: [{ product_id: passP }], total_cents: 45001 };
  assert.equal((await PP.quote(pool, A.id, basket)).available, false, 'off');
  ok(await settings({ plans_on: true, plans_count: 3 }));
  assert.equal((await PP.quote(pool, A.id, { lines: [{ product_id: dayP }], total_cents: 6000 })).available, false, 'a day ticket is not in a plan');
  const qt = await PP.quote(pool, A.id, basket);
  assert.equal(qt.available, true); assert.equal(qt.count, 3);
  assert.equal(qt.first_cents + qt.then.reduce((s, x) => s + x.cents, 0), 45001);
  assert.deepEqual(qt.then.map((x) => x.cents), [15000, 15000]);
  ok(await api('PUT', `/guests/fair/products/${dayP}`, { token: A.owner, body: { plan_ok: true } }));
  assert.equal((await PP.quote(pool, A.id, { lines: [{ product_id: dayP }], total_cents: 6000 })).available, true, 'a product a manager marked');
  assert.deepEqual(PP.checkoutExtra().payment_intent_data, { setup_future_usage: 'off_session' });

  const t = await sold({ product: passP, cents: 45000, from: today, to: plus(today, 150) });
  const planId = await tx((conn) => PP.start(conn, A.id, { id: t.orderId, person_id: t.personId, email: t.email, name: 'Gus Guest', total_cents: 45000, payment_intent: t.pi, customer: null }));
  assert.equal(await tx((conn) => PP.start(conn, A.id, { id: t.orderId, total_cents: 45000 })), planId, 'once per order');
  let p = ok(await api('GET', `/guests/fair/plans/${planId}`, { token: A.owner }));
  assert.deepEqual(p.charges.map((c) => c.status), ['paid', 'due', 'due']);
  assert.equal(p.paid_cents, 15000);
  assert.equal((await PP.chargeDue()).paid, 0, 'nothing due yet');
  // Payment 2 comes due: charged off-session on the saved card from the first payment.
  await q('UPDATE payment_plan_charges SET due_on = ? WHERE plan_id = ? AND n = 2', [today, planId]);
  assert.equal((await PP.chargeDue()).paid, 1);
  const charge = calls.filter((c) => c.path === '/v1/payment_intents').pop();
  assert.equal(charge.params.amount, '15000'); assert.equal(charge.params.off_session, 'true'); assert.equal(charge.params.payment_method, 'pm_mock'); assert.equal(charge.params.customer, 'cus_mock');
  assert.equal((await q("SELECT COUNT(*) AS n FROM order_payments WHERE order_id = ? AND processor = 'stripe'", [t.orderId]))[0].n, 2);
  // Payment 3 fails: tried again 3 days later, then 4 days after that, then the pass is held at the gate.
  failCharges = true;
  await q('UPDATE payment_plan_charges SET due_on = ? WHERE plan_id = ? AND n = 3', [today, planId]);
  assert.equal((await PP.chargeDue()).failed, 1);
  p = ok(await api('GET', `/guests/fair/plans/${planId}`, { token: A.owner }));
  assert.equal(p.status, 'late'); assert.equal(p.charges[2].next_try_on, plus(today, 3));
  assert.equal(ok(await scan(t.code)).result, 'ok', 'a late payment does not stop the pass yet');
  const failMail = mailTo(t.email, /did not go through/)[0];
  assert.ok(failMail, 'the guest is told'); assert.ok(linkIn(failMail, 'plan'));
  assert.equal((await PP.chargeDue()).failed, 0, 'waits for the retry day');
  await q('UPDATE payment_plan_charges SET next_try_on = ? WHERE plan_id = ? AND n = 3', [today, planId]);
  assert.equal((await PP.chargeDue()).failed, 1);
  assert.equal(ok(await api('GET', `/guests/fair/plans/${planId}`, { token: A.owner })).charges[2].next_try_on, plus(today, 4));
  await q('UPDATE payment_plan_charges SET next_try_on = ? WHERE plan_id = ? AND n = 3', [today, planId]);
  assert.equal((await PP.chargeDue()).failed, 1);
  p = ok(await api('GET', `/guests/fair/plans/${planId}`, { token: A.owner }));
  assert.equal(p.status, 'suspended');
  const g = ok(await scan(t.code));
  assert.equal(g.result, 'plan_unpaid'); assert.match(g.reason, /overdue/);
  assert.equal((await PP.chargeDue()).failed, 0, 'no more tries without a new card');
  // The guest updates the card from the email: the overdue payment goes through and the pass works again.
  const holdMail = mailTo(t.email, /on hold/).pop();
  const token = linkIn(holdMail, 'plan');
  const view = ok(await api('GET', `/public/${A.slug}/plan/${token}`));
  assert.equal(view.status, 'suspended'); assert.equal(view.charges.length, 3); assert.equal(view.email, undefined, 'no contact details on the page');
  const sess = ok(await api('POST', `/public/${A.slug}/plan/${token}/card`));
  assert.match(sess.url, /^https:\/\/checkout\.stripe\.test/);
  assert.equal(calls.filter((c) => c.path === '/v1/checkout/sessions').pop().params.mode, 'setup');
  failCharges = false;
  const done = ok(await api('POST', `/public/${A.slug}/plan/${token}/card-done`, { body: { session_id: 'cs_setup_back1' } }));
  assert.equal(done.status, 'paid'); assert.equal(done.card.last4, '1111');
  assert.equal(calls.filter((c) => c.path === '/v1/payment_intents').pop().params.payment_method, 'pm_new');
  assert.equal(ok(await scan(t.code)).result, 'ok');
  // Settle another plan by hand.
  const t2 = await sold({ product: passP, cents: 30000, from: today, to: plus(today, 150) });
  const p2 = await tx((conn) => PP.start(conn, A.id, { id: t2.orderId, person_id: t2.personId, email: t2.email, total_cents: 30000, payment_intent: t2.pi }));
  assert.equal((await api('POST', `/guests/fair/plans/${p2}/settle`, { token: counter, body: { note: 'cash' } })).status, 403);
  const s = ok(await api('POST', `/guests/fair/plans/${p2}/settle`, { token: A.owner, body: { note: 'Paid the rest in cash at the window' } }));
  assert.equal(s.status, 'settled'); assert.deepEqual(s.charges.map((c) => c.status), ['paid', 'settled', 'settled']);
  assert.equal((await api('POST', `/guests/fair/plans/${p2}/cancel`, { token: A.owner, body: {} })).status, 409);
  assert.ok(ok(await api('GET', '/guests/fair/plans', { token: A.owner })).data.length >= 2);
  ok(await settings({ plans_on: false }));
});

test('auto-renew: a reminder a week before, then the saved card is charged at the guaranteed price, once', async () => {
  const old = await sold({ product: passP, cents: 40000, from: plus(today, -200), to: plus(today, -1) });
  assert.equal((await api('POST', '/guests/fair/renewals', { token: A.owner, body: { person_id: old.personId, on: true } })).status, 409, 'off');
  ok(await settings({ autorenew_on: true }));
  ok(await api('PATCH', '/guests/fair/settings', { token: A.owner, body: { renew_on: plus(today, 5), renew_rule: 'lower' } }));
  const on = ok(await api('POST', '/guests/fair/renewals', { token: counter, body: { person_id: old.personId, on: true } }));
  assert.equal(on.on, true); assert.equal(on.needs_card, true);
  const token = on.link.split('/').pop();
  const v = ok(await api('GET', `/public/${A.slug}/renew/${token}`));
  assert.equal(v.price_cents, 40000, 'last season 400.00 is lower than this season 450.00'); assert.equal(v.card, null);
  ok(await api('POST', `/public/${A.slug}/renew/${token}/card`));
  const withCard = ok(await api('POST', `/public/${A.slug}/renew/${token}/card-done`, { body: { session_id: 'cs_setup_back2' } }));
  assert.equal(withCard.card.last4, '1111');
  const r1 = await AR.daily(A.id, base);
  assert.equal(r1.reminded, 1); assert.equal(r1.renewed, 0);
  assert.equal((await AR.daily(A.id, base)).reminded, 0, 'one reminder');
  assert.match(mailTo(old.email, /renews on/)[0].TextBody, /\$400\.00/);
  ok(await api('PATCH', '/guests/fair/settings', { token: A.owner, body: { renew_on: today } }));
  const r2 = await AR.daily(A.id, base);
  assert.equal(r2.renewed, 1);
  const pi = calls.filter((c) => c.path === '/v1/payment_intents').pop();
  assert.equal(pi.params.amount, '40000'); assert.equal(pi.params.off_session, 'true'); assert.match(pi.key, /^renew-/);
  const [nt] = await q('SELECT * FROM tickets WHERE tenant_id = ? AND person_id = ? AND valid_from = ?', [A.id, old.personId, today]);
  assert.ok(nt, 'the new pass');
  assert.equal(ok(await scan(nt.code)).result, 'ok');
  assert.equal((await AR.daily(A.id, base)).renewed, 0, 'once a season');
  assert.equal(mailTo(old.email, /is renewed/).length, 1);
  // Off from the guest's page.
  assert.equal(ok(await api('POST', `/public/${A.slug}/renew/${token}`, { body: { on: false } })).on, false);
  assert.equal((await api('GET', `/public/${A.slug}/autorenew`)).status, 401, 'the household switch needs the family sign-in');
  ok(await settings({ autorenew_on: false }));
});

test('waitlist for a capped pass: offers go out in order, held 48 hours, then the next guest', async () => {
  const capped = ok(await api('POST', '/products', { token: A.owner, body: { kind: 'season_pass', name: 'Founders pass', base_price_cents: 30000, valid_days: 200, online: 1 } }), 201).id;
  ok(await api('PUT', `/guests/fair/products/${capped}`, { token: A.owner, body: { cap: 1 } }));
  const holder = await sold({ product: capped, cents: 30000, from: today, to: plus(today, 150) });
  const join = (first, email) => api('POST', `/public/${A.slug}/pass-waitlist`, { body: { product_id: capped, first_name: first, last_name: 'Wait', email } });
  const first = ok(await join('Wanda', `wanda-${suffix}@x.test`), 202);
  ok(await join('Will', `will-${suffix}@x.test`), 202);
  assert.deepEqual(ok(await join('Wanda', `wanda-${suffix}@x.test`), 202), first, 'the same answer for someone already on the list');
  assert.equal((await AR.waitlistTick(A.id, base)).offered, 0, 'full');
  assert.equal((await AR.passPlaces(pool, A.id, capped)).left, 0);
  await q("UPDATE tickets SET status = 'void' WHERE id = ?", [holder.ticketId]); // refunded: a place opens
  assert.equal((await AR.waitlistTick(A.id, base)).offered, 1);
  const offer = mailTo(`wanda-${suffix}@x.test`, /open for you/)[0];
  assert.ok(offer, 'the first in line is offered');
  assert.equal(mailTo(`will-${suffix}@x.test`).length, 0);
  assert.equal((await AR.passPlaces(pool, A.id, capped, { email: `wanda-${suffix}@x.test` })).left, 1, 'held for her');
  assert.equal((await AR.passPlaces(pool, A.id, capped, { email: `will-${suffix}@x.test` })).left, 0, 'not for him');
  const v = ok(await api('GET', `/public/${A.slug}/pass-offer/${linkIn(offer, 'pass-offer')}`));
  assert.equal(v.status, 'offered'); assert.equal(v.pass, 'Founders pass');
  await q("UPDATE fair_waitlist SET offer_expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 MINUTE) WHERE tenant_id = ? AND status = 'offered'", [A.id]);
  const t2 = await AR.waitlistTick(A.id, base);
  assert.equal(t2.expired, 1); assert.equal(t2.offered, 1);
  assert.equal(mailTo(`will-${suffix}@x.test`, /open for you/).length, 1, 'then the next guest');
  const list = ok(await api('GET', '/guests/fair/waitlist', { token: A.owner })).data.find((x) => x.product_id === capped);
  assert.equal(list.cap, 1); assert.deepEqual(list.waiting.map((w) => w.first_name), ['Will']);
});

test('a guest page is served for each private link, and an unknown token is a plain 404', async () => {
  for (const k of ['guarantee', 'blocked', 'plan', 'renew', 'pass-offer']) {
    const r = await fetch(`${base}/${k}/${A.slug}/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`);
    assert.equal(r.status, 200, k);
    assert.match(await r.text(), /\/js\/fair\.js/);
  }
  assert.equal((await api('GET', `/public/${A.slug}/plan/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`)).status, 404);
  assert.equal((await api('GET', `/public/${A.slug}/renew/short`)).status, 404);
});

// ---------------------------------------------------------------- guests round 2 fixes (one value for what a ticket is paid)
test('fix: price drops, closure and conditions credits use what was paid after discounts and earlier refunds', async () => {
  const LV = require('../src/lib/linevalue');
  ok(await settings({ price_promise_on: true, closure_credit_on: true }));
  const sat = plus(today, 40);
  const free = await sold({ product: dayP, from: sat });
  await q('UPDATE order_items SET discount_cents = 6000 WHERE id = ?', [free.itemId]); // a reward took the whole price
  const half = await sold({ product: dayP, from: sat });
  await q('UPDATE order_items SET discount_cents = 3000 WHERE id = ?', [half.itemId]); // a promo took half
  assert.equal(await LV.netPaidForTicket(pool, A.id, free.ticketId), 0);
  assert.equal(await LV.netPaidForTicket(pool, A.id, half.ticketId), 3000);
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents) VALUES (?, ?, ?, NULL, 5000)', [A.id, dayP, sat]);
  await F.priceDrops(A.id);
  assert.equal((await q('SELECT COUNT(*) AS n FROM fair_price_drops WHERE ticket_id IN (?)', [[free.ticketId, half.ticketId]]))[0].n, 0, 'nothing back: they paid less than the new price');
  // a drop, then a change of day: the change gives back only what is left over the new day
  const full = await sold({ product: dayP, from: sat });
  await F.priceDrops(A.id);
  assert.equal((await q('SELECT refund_cents FROM fair_price_drops WHERE ticket_id = ?', [full.ticketId]))[0].refund_cents, 1000);
  const tue = plus(today, 41);
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents) VALUES (?, ?, ?, NULL, 4000)', [A.id, dayP, tue]);
  const ch = ok(await api('POST', `/guests/tickets/${full.code}/change-day`, { token: A.owner, body: { date: tue } }));
  assert.equal(ch.back_cents, 1000, '60.00 paid, 10.00 back for the drop, now a 40.00 day: 10.00 more');
  await F.priceDrops(A.id);
  assert.equal(Number((await q('SELECT refunded_cents FROM orders WHERE id = ?', [full.orderId]))[0].refunded_cents), 2000);
  // closure credit for a ticket bought at half price is the half
  const t2 = await sold({ product: dayP, from: today });
  await q('UPDATE order_items SET discount_cents = 2500 WHERE id = ?', [t2.itemId]);
  const pre = ok(await api('POST', '/guests/fair/closures/preview', { token: A.owner, body: { day: today } }));
  assert.equal(pre.items.find((i) => i.ticket_id === t2.ticketId).cents, 3500);
  await q('UPDATE order_items SET refunded_at = NOW() WHERE id = ?', [t2.itemId]); // keep later closure tests clean
  ok(await settings({ price_promise_on: false, closure_credit_on: false }));
});

test('fix: the price-drop job checks the refund again under the lock', async () => {
  ok(await settings({ price_promise_on: true }));
  const day = plus(today, 45);
  const s = await sold({ product: dayP, from: day });
  await q('INSERT INTO price_calendar (tenant_id, product_id, on_date, tier, price_cents) VALUES (?, ?, ?, NULL, 5000)', [A.id, dayP, day]);
  // a refund lands between the job's list and its transaction: the list is read, then the line is refunded
  const LV = require('../src/lib/linevalue');
  const was = LV.netPaidForTicket;
  LV.netPaidForTicket = async (...a) => { const v = await was(...a); if (a[2] === s.ticketId) await q('UPDATE order_items SET refunded_at = NOW() WHERE id = ?', [s.itemId]); return v; };
  try { await F.priceDrops(A.id); } finally { LV.netPaidForTicket = was; }
  assert.equal((await q('SELECT COUNT(*) AS n FROM fair_price_drops WHERE ticket_id = ?', [s.ticketId]))[0].n, 0);
  ok(await settings({ price_promise_on: false }));
});

test('fix: a refund cancels an unused closure credit, and a used one comes off the refund', async () => {
  ok(await settings({ closure_credit_on: true }));
  const yesterday = plus(today, -1);
  const a = await sold({ product: dayP, from: yesterday });
  const b = await sold({ product: dayP, from: yesterday });
  ok(await api('POST', '/guests/fair/closures', { token: A.owner, body: { day: yesterday, reason: 'wind' } }), 201);
  const ref = ok(await api('POST', `/orders/${a.orderId}/refund`, { token: A.owner, body: { reason: 'weather' } }));
  assert.equal(ref.amount_cents, 6000);
  assert.equal((await q('SELECT status FROM guest_rewards WHERE tenant_id = ? AND source_key = ?', [A.id, `closure:${a.ticketId}`]))[0].status, 'void');
  // b used its credit already: the refund is the price less the credit (here nothing)
  await q("UPDATE guest_rewards SET status = 'redeemed', chosen = 'credit', credit_cents = 6000 WHERE tenant_id = ? AND source_key = ?", [A.id, `closure:${b.ticketId}`]);
  const ref2 = ok(await api('POST', `/orders/${b.orderId}/refund`, { token: A.owner, body: { reason: 'weather' } }));
  assert.equal(ref2.amount_cents, 0, 'the guest kept the credit, so no money too');
  ok(await settings({ closure_credit_on: false }));
});

test('fix: a refund stops a payment plan, a part refund lowers it, and a canceled plan holds the pass until settled', async () => {
  const mk = async () => {
    const s = await sold({ product: passP, cents: 15000 });
    await q('UPDATE orders SET total_cents = 45000, subtotal_cents = 45000 WHERE id = ?', [s.orderId]);
    const id = await tx((c) => PP.start(c, A.id, { id: s.orderId, total_cents: 45000, payment_intent: s.pi, person_id: s.personId, email: s.email }, { count: 3 }));
    return { ...s, planId: id };
  };
  // whole refund
  const a = await mk();
  ok(await api('POST', `/orders/${a.orderId}/refund`, { token: A.owner, body: { reason: 'customer_request' } }));
  assert.equal((await q('SELECT status FROM payment_plans WHERE id = ?', [a.planId]))[0].status, 'canceled');
  assert.deepEqual((await q('SELECT status FROM payment_plan_charges WHERE plan_id = ? ORDER BY n', [a.planId])).map((c) => c.status), ['paid', 'canceled', 'canceled']);
  // even if a plan were left on, the charge job never charges a refunded order
  await q("UPDATE payment_plans SET status = 'active' WHERE id = ?", [a.planId]);
  await q("UPDATE payment_plan_charges SET status = 'due', due_on = ? WHERE plan_id = ? AND n = 2", [today, a.planId]);
  const before = calls.filter((c) => c.path === '/v1/payment_intents' && c.method === 'POST').length;
  await PP.chargeDue(null);
  assert.equal(calls.filter((c) => c.path === '/v1/payment_intents' && c.method === 'POST').length, before);
  assert.equal((await q('SELECT status FROM payment_plans WHERE id = ?', [a.planId]))[0].status, 'canceled');
  // part refund: a pass and a day ticket on one plan; refunding the pass takes its unpaid part off what is to come
  const b = await mk();
  const [i2] = await pool.query("INSERT INTO order_items (tenant_id, order_id, product_id, line_kind, person_id, tier, quantity, unit_price_cents, valid_on, tax_cents) VALUES (?, ?, ?, 'ticket', ?, 'adult', 1, 30000, ?, 0)", [A.id, b.orderId, dayP, b.personId, today]);
  await q('UPDATE order_items SET unit_price_cents = 15000 WHERE id = ?', [b.itemId]);
  void i2;
  const r = ok(await api('POST', `/orders/${b.orderId}/refund`, { token: A.owner, body: { reason: 'customer_request', item_ids: [b.itemId] } }));
  assert.equal(r.amount_cents, 5000, 'a third of the pass was paid, so a third goes back');
  const left = await q("SELECT cents, status FROM payment_plan_charges WHERE plan_id = ? AND n > 1 ORDER BY n", [b.planId]);
  assert.equal(left.filter((c) => c.status === 'due').reduce((x, c) => x + Number(c.cents), 0), 20000, '30000 was to come; the pass\'s unpaid 10000 is gone');
  // a canceled plan holds the pass at the gate (and off the offline list) until a manager settles it
  const c = await mk();
  ok(await api('POST', `/guests/fair/plans/${c.planId}/cancel`, { token: A.owner, body: { note: 'stop' } }));
  assert.equal(ok(await scan(c.code)).result, 'plan_unpaid');
  ok(await api('POST', `/guests/fair/plans/${c.planId}/settle`, { token: A.owner, body: { note: 'paid cash' } }));
  assert.equal(ok(await scan(c.code)).result, 'ok');
});

test('fix: auto-renew prices by the holder\'s guest type on the renewal day, and two runs make one pass', async () => {
  ok(await settings({ autorenew_on: true }));
  const renewOn = plus(today, 3);
  ok(await api('PATCH', '/guests/fair/settings', { token: A.owner, body: { renew_on: renewOn, renew_rule: 'lower' } }));
  await q("INSERT INTO price_tiers (tenant_id, product_id, tier, price_cents) VALUES (?, ?, 'child', 20000) ON DUPLICATE KEY UPDATE price_cents = 20000", [A.id, passP]);
  // born 12 years and 362 days before today: a child when the pass was bought, 13 (youth) on the renewal day
  const dob = `${Number(today.slice(0, 4)) - 13}${plus(today, 2).slice(4)}`;
  const kid = await sold({ product: passP, cents: 20000, tier: 'child', from: plus(today, -200), to: plus(today, 100) });
  await q('UPDATE people SET date_of_birth = ? WHERE id = ?', [dob, kid.personId]);
  const p = await AR.renewPrice(pool, A.id, { person_id: kid.personId, product_id: passP, from_ticket_id: kid.ticketId }, renewOn);
  assert.equal(p.tier, 'youth'); assert.equal(p.cents, 45000, 'the youth price, not last season\'s child price'); assert.equal(p.last_cents, null);
  // the race: two runs at once charge once and make one pass
  ok(await api('POST', '/guests/fair/renewals', { token: A.owner, body: { person_id: kid.personId, on: true } }));
  const [c] = await pool.query("INSERT INTO fair_cards (tenant_id, person_id, provider, customer, payment_method) VALUES (?, ?, 'stripe', 'cus_mock', 'pm_mock')", [A.id, kid.personId]);
  await q('UPDATE fair_renewals SET card_id = ? WHERE tenant_id = ? AND person_id = ?', [c.insertId, A.id, kid.personId]);
  ok(await api('PATCH', '/guests/fair/settings', { token: A.owner, body: { renew_on: today } }));
  await q('UPDATE fair_renewals SET status = \'off\' WHERE tenant_id = ? AND person_id <> ?', [A.id, kid.personId]);
  const [x, y] = await Promise.all([AR.daily(A.id, base), AR.daily(A.id, base)]);
  assert.equal(x.renewed + y.renewed, 1);
  assert.equal((await q("SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ? AND person_id = ? AND product_id = ? AND valid_from >= ?", [A.id, kid.personId, passP, today]))[0].n, 1);
  ok(await settings({ autorenew_on: false }));
});
