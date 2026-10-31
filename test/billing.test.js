'use strict';

// The mountain's Verdynt/OS subscription: plans and add-ons set in the console, a 14-day trial, paying by card, bank or
// invoice through a mock Stripe, the webhook keeping it in step, then grace days and read only (patrol still works).
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';
process.env.BILLING_CACHE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../src/config');
const stripe = require('../src/lib/stripe');
const B = require('../src/lib/billing');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

let server; let base; let mock; const calls = []; let n = 0;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
const KEY = 'test-bootstrap-key';
const q = async (sql, params) => (await pool.query(sql, params))[0];

async function api(method, path, { token, key, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json, text };
}
const plat = (method, path, body) => api(method, `/platform${path}`, { key: KEY, body });
const login = async (slug, email) => (await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).body.token;
const webhook = async (event) => {
  const raw = JSON.stringify(event);
  const res = await fetch(`${base}/api/v1/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.signWebhook(raw, 'whsec_mock') }, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const daysFrom = (n2) => new Date(Date.now() + n2 * 86400000).toISOString().slice(0, 10);

let slug; let tenantId; let owner; let manager; let base1; let full; let addon;

test.before(async () => {
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(data));
      calls.push({ method: req.method, path: req.url, params, key: req.headers['idempotency-key'] });
      res.setHeader('content-type', 'application/json');
      const send = (o) => res.end(JSON.stringify(o));
      const url = req.url.split('?')[0];
      if (url === '/v1/products') send({ id: `prod_${++n}` });
      else if (url === '/v1/prices') send({ id: `price_${++n}` });
      else if (url === '/v1/customers') send({ id: `cus_${suffix}_${++n}` });
      else if (url.startsWith('/v1/customers/')) send({ id: url.split('/')[3] });
      else if (url === '/v1/checkout/sessions') send({ id: `cs_${++n}`, url: `https://checkout.stripe.test/${n}` });
      else if (url === '/v1/billing_portal/sessions') send({ id: `bps_${++n}`, url: `https://billing.stripe.test/${n}` });
      else if (url === '/v1/subscriptions' && req.method === 'POST') send({ id: `sub_inv_${suffix}_${++n}`, status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 });
      else if (url.startsWith('/v1/subscriptions/') && req.method === 'GET') send({ id: url.split('/')[3], items: { data: [{ id: 'si_old_1' }, { id: 'si_old_2' }] } });
      else if (url.startsWith('/v1/subscriptions/')) send({ id: url.split('/')[3], status: 'active' });
      else if (url === '/v1/invoices') send({ data: [{ id: 'in_1', number: 'SO-0001', status: 'paid', amount_due: 49900, amount_paid: 49900, created: 1760000000, hosted_invoice_url: 'https://inv.stripe.test/1', invoice_pdf: 'https://inv.stripe.test/1.pdf' }] });
      else { res.statusCode = 404; send({ error: { message: `no mock for ${req.method} ${url}` } }); }
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  config.stripe.apiBase = `http://127.0.0.1:${mock.address().port}`;
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  slug = `bl-${suffix}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => mock.close(r)); await pool.end(); });

test('standing walks from trial to grace to read only, and payment brings it back', () => {
  const today = '2026-11-20';
  assert.equal(B.standing(null, today).state, 'ok', 'no billing row: free');
  assert.equal(B.standing({ comped: 1 }, today).kind, 'comped');
  const trial = { comped: 0, trial_ends_on: '2026-11-25' };
  assert.deepEqual([B.standing(trial, today).kind, B.standing(trial, today).days_left], ['trial', 5]);
  const ended = B.standing({ comped: 0, trial_ends_on: '2026-11-15' }, today);
  assert.equal(ended.state, 'grace'); assert.equal(ended.kind, 'trial_ended'); assert.equal(ended.until, '2026-11-29'); assert.equal(ended.days_left, 9);
  assert.equal(B.standing({ comped: 0, trial_ends_on: '2026-11-15' }, '2026-11-29').state, 'grace', 'the last grace day still works');
  const ro = B.standing({ comped: 0, trial_ends_on: '2026-11-15' }, '2026-11-30');
  assert.equal(ro.state, 'read_only'); assert.equal(ro.read_only, true);
  assert.equal(B.standing({ comped: 0, trial_ends_on: '2026-11-01', sub_status: 'active', stripe_subscription_id: 'sub' }, today).kind, 'subscribed');
  assert.equal(B.standing({ comped: 0, sub_status: 'active', cancel_at_period_end: 1, stripe_subscription_id: 'sub' }, today).kind, 'cancelling');
  const failed = B.standing({ comped: 0, sub_status: 'past_due', past_due_since: '2026-11-10 08:00:00', stripe_subscription_id: 'sub' }, today);
  assert.equal(failed.state, 'grace'); assert.equal(failed.kind, 'payment_failed'); assert.equal(failed.until, '2026-11-24');
  assert.equal(B.standing({ comped: 0, sub_status: 'past_due', past_due_since: '2026-11-01 08:00:00', stripe_subscription_id: 'sub' }, today).state, 'read_only');
  assert.equal(B.standing({ comped: 0, sub_status: 'past_due', past_due_since: '2026-11-01', paid_until: '2026-12-31', stripe_subscription_id: 'sub' }, today).kind, 'paid_manually', 'a check the operator recorded covers it');
  const canceled = B.standing({ comped: 0, sub_status: 'canceled', period_end: '2026-11-18 00:00:00', stripe_subscription_id: 'sub' }, today);
  assert.equal(canceled.kind, 'canceled'); assert.equal(canceled.until, '2026-12-02');
  assert.equal(B.standing({ comped: 0, paid_until: '2026-11-10' }, today).kind, 'paid_time_ended');
});

test('the console sets plans and add-ons, and a new mountain starts on a 14-day trial', async () => {
  const mk = async (b) => { const r = await plat('POST', '/billing/plans', b); assert.equal(r.status, 201, r.text); return r.body.id; };
  base1 = await mk({ code: `base-${suffix}`, name: 'Base', kind: 'plan', modules: ['sell', 'gate', 'conditions', 'patrol'], monthly_cents: 19900, yearly_cents: 199000, sort: 1 });
  full = await mk({ code: `full-${suffix}`, name: 'Full mountain', kind: 'plan', modules: ['sell', 'gate', 'conditions', 'patrol', 'rentals', 'school'], monthly_cents: 49900, yearly_cents: 499000, sort: 2 });
  addon = await mk({ code: `shop-${suffix}`, name: 'Online shop', kind: 'addon', modules: ['shop'], monthly_cents: 9900, yearly_cents: 0 });
  assert.equal((await plat('POST', '/billing/plans', { code: `base-${suffix}`, name: 'Again', monthly_cents: 1 })).status, 400, 'codes are unique');
  assert.equal((await plat('POST', '/billing/plans', { code: `bad-${suffix}`, name: 'Bad', modules: ['nope'], monthly_cents: 1 })).status, 400);
  assert.equal((await plat('PATCH', `/billing/plans/${base1}`, { blurb: 'Tickets, lifts and patrol' })).status, 200);
  const list = await plat('GET', '/billing/plans');
  assert.ok(list.body.data.find((p) => p.id === base1).blurb.includes('patrol'));
  assert.equal(list.body.data.find((p) => p.id === base1).monthly_cents, 19900, 'editing the description keeps the price');
  assert.equal(list.body.stripe, true);

  const made = await plat('POST', '/tenants', { slug, name: 'Billing Test', owner: { email: `o@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } });
  assert.equal(made.status, 201, made.text);
  tenantId = made.body.id;
  owner = await login(slug, `o@${slug}.test`);
  assert.equal((await api('POST', '/users', { token: owner, body: { email: `m@${slug}.test`, password: PW, role: 'manager', first_name: 'Max', last_name: 'Manager' } })).status, 201);
  manager = await login(slug, `m@${slug}.test`);
  const me = await api('GET', '/auth/me', { token: owner });
  assert.equal(me.body.billing.kind, 'trial'); assert.equal(me.body.billing.days_left, 14);
  const row = (await plat('GET', '/tenants')).body.data.find((t) => t.id === tenantId);
  assert.equal(row.billing.kind, 'trial');
});

test('the owner chooses a plan and pays by card or bank; a manager can only look', async () => {
  const page = await api('GET', '/billing', { token: manager });
  assert.equal(page.status, 200);
  assert.equal(page.body.can_pay, false);
  assert.ok(page.body.plans.some((p) => p.id === full) && page.body.addons.some((p) => p.id === addon));
  assert.equal((await api('PUT', '/billing/choice', { token: manager, body: { plan_id: full } })).status, 403);
  assert.equal((await api('PUT', '/billing/choice', { token: owner, body: { plan_id: addon } })).status, 400, 'an add-on is not a plan');
});

test('paying by bank keeps the trial days and opens Stripe Checkout for a subscription', async () => {
  const ch = await api('PUT', '/billing/choice', { token: owner, body: { plan_id: full, addons: [addon], interval: 'month' } });
  assert.equal(ch.status, 200, ch.text);
  calls.length = 0;
  const co = await api('POST', '/billing/checkout', { token: owner, body: { method: 'bank' } });
  assert.equal(co.status, 200, co.text);
  assert.ok(co.body.url.startsWith('https://checkout.stripe.test/'));
  assert.equal(calls.filter((c) => c.path === '/v1/products').length, 2, 'the plan and add-on are made in Stripe on first use');
  const season = calls.filter((c) => c.path === '/v1/prices' && c.params['metadata[period]'] === 'season');
  assert.ok(season.some((c) => c.params.unit_amount === String(Math.round(499000 / 6)) && c.params['recurring[interval]'] === 'month'), 'a season price (a sixth of yearly, monthly) is made with the others');
  const s = calls.find((c) => c.path === '/v1/checkout/sessions').params;
  assert.equal(s.mode, 'subscription');
  assert.equal(s['payment_method_types[0]'], 'us_bank_account');
  assert.ok(s['line_items[0][price]'] && s['line_items[1][price]']);
  assert.equal(s['metadata[kind]'], 'billing');
  assert.ok(Number(s['subscription_data[trial_end]']) > Date.now() / 1000 + 12 * 86400, 'the trial days left are kept');
  const plans = (await plat('GET', '/billing/plans')).body.data;
  assert.ok(plans.find((p) => p.id === full).stripe_month, 'the price id is kept for next time');
  // Stripe says it worked
  const done = await webhook({ id: `evt_${suffix}_1`, type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: `sub_${suffix}`, customer: 'cus_x', metadata: { kind: 'billing', tenant_id: String(tenantId) } } } });
  assert.equal(done.status, 200); assert.equal(done.body.billing.subscribed, true);
  assert.equal((await webhook({ id: `evt_${suffix}_1`, type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: `sub_${suffix}`, metadata: { kind: 'billing', tenant_id: String(tenantId) } } } })).body.billing.duplicate, true, 'the same event twice does nothing');
  await webhook({ id: `evt_${suffix}_2`, type: 'customer.subscription.updated', data: { object: { id: `sub_${suffix}`, status: 'trialing', current_period_end: Math.floor(Date.now() / 1000) + 14 * 86400, cancel_at_period_end: false } } });
  const me = await api('GET', '/auth/me', { token: owner });
  assert.equal(me.body.billing.kind, 'subscribed');
  assert.ok(me.body.modules.includes('rentals') && me.body.modules.includes('shop'), `the apps follow the plan and add-on: ${me.body.modules}`);
  assert.equal((await api('POST', '/billing/checkout', { token: owner, body: { method: 'card' } })).status, 409, 'one subscription at a time');
  const page = (await api('GET', '/billing', { token: owner })).body;
  assert.equal(page.billing.subscribed, true);
  assert.equal(page.invoices[0].number, 'SO-0001');
});

test('changing plans updates the Stripe subscription; the portal opens; failures and payments are tracked', async () => {
  calls.length = 0;
  const c1 = await api('PUT', '/billing/choice', { token: owner, body: { plan_id: base1, addons: [], interval: 'month' } }); assert.equal(c1.status, 200, c1.text);
  const upd = calls.find((c) => c.method === 'POST' && c.path === `/v1/subscriptions/sub_${suffix}`).params;
  assert.equal(upd['items[0][deleted]'], 'true'); assert.equal(upd['items[1][deleted]'], 'true');
  assert.ok(upd['items[2][price]']); assert.equal(upd.proration_behavior, 'create_prorations');
  let me = await api('GET', '/auth/me', { token: owner });
  assert.ok(!me.body.modules.includes('rentals') && me.body.modules.includes('patrol'), 'the smaller plan turns rentals off');
  const portal = await api('POST', '/billing/portal', { token: owner });
  assert.ok(portal.body.url.startsWith('https://billing.stripe.test/'));

  const failed = await webhook({ id: `evt_${suffix}_3`, type: 'invoice.payment_failed', data: { object: { id: 'in_2', number: 'SO-0002', amount_due: 19900, subscription: `sub_${suffix}` } } });
  assert.equal(failed.body.billing.failed, true);
  me = await api('GET', '/auth/me', { token: owner });
  assert.equal(me.body.billing.state, 'grace'); assert.equal(me.body.billing.kind, 'payment_failed');
  await webhook({ id: `evt_${suffix}_4`, type: 'invoice.paid', data: { object: { id: 'in_2', number: 'SO-0002', amount_paid: 19900, parent: { subscription_details: { subscription: `sub_${suffix}` } } } } });
  me = await api('GET', '/auth/me', { token: owner });
  assert.equal(me.body.billing.kind, 'subscribed');
  const hist = (await api('GET', '/billing', { token: owner })).body.events.map((e) => e.kind);
  assert.ok(hist.includes('payment_failed') && hist.includes('paid'));
});

test('season billing: the yearly price in six payments, November to April, with the summer paused', async () => {
  // the rules on their own
  assert.equal(B.seasonCents({ yearly_cents: 199000 }), 33167, 'a sixth of the yearly price');
  assert.equal(B.seasonCents({ yearly_cents: 0 }), 0);
  for (const [d, summer] of [['2026-04-30', false], ['2026-05-01', true], ['2026-10-31', true], ['2026-11-01', false], ['2027-02-10', false]]) assert.equal(B.inSummer(d), summer, d);
  assert.equal(B.nextNovember('2026-06-10'), '2026-11-01');
  assert.equal(B.nextNovember('2026-12-10'), '2027-11-01');
  const nov1 = Math.floor(Date.parse('2026-11-01T12:00:00Z') / 1000);
  assert.equal(B.trialEnd({ billing_interval: 'season' }, '2026-07-01'), nov1, 'starting in the summer, the first payment is November 1');
  assert.equal(B.trialEnd({ billing_interval: 'season', trial_ends_on: '2026-11-10' }, '2026-10-30') > nov1, true, 'trial days left still count');
  assert.equal(B.trialEnd({ billing_interval: 'season' }, '2027-01-15'), undefined, 'in the winter it starts now');
  assert.equal(B.trialEnd({ billing_interval: 'month' }, '2026-07-01'), undefined, 'monthly is not paused');

  // choosing it on a live subscription: a season price in Stripe, and a summer pause when it is summer
  const today = new Date().toISOString().slice(0, 10);
  calls.length = 0;
  const c = await api('PUT', '/billing/choice', { token: owner, body: { plan_id: base1, addons: [], interval: 'season' } });
  assert.equal(c.status, 200, c.text);
  // Stripe already holds the season price: syncing a plan makes its monthly, yearly and season prices together
  const plan = (await plat('GET', '/billing/plans')).body.data.find((p) => p.id === base1);
  assert.equal(plan.stripe_season_cents, 33167, 'a sixth of the yearly price');
  const upd = calls.find((x) => x.method === 'POST' && x.path === `/v1/subscriptions/sub_${suffix}`).params;
  assert.equal(upd['items[2][price]'], plan.stripe_season, 'the subscription moves to the season price');
  if (B.inSummer(today)) assert.equal(upd['pause_collection[behavior]'], 'void', 'nothing more is collected until November');
  else assert.equal(upd['pause_collection[behavior]'], undefined);
  let page = (await api('GET', '/billing', { token: owner })).body;
  assert.equal(page.billing.interval, 'season');
  assert.equal(page.billing.season_paused_until, B.inSummer(today) ? B.nextNovember(today) : null);
  // a plan with no yearly price cannot be paid over the season
  const monthlyOnly = (await plat('POST', '/billing/plans', { code: `mo-${suffix}`, name: 'Monthly only', kind: 'plan', modules: ['sell'], monthly_cents: 5000, yearly_cents: 0 })).body.id;
  assert.equal((await api('PUT', '/billing/choice', { token: owner, body: { plan_id: monthlyOnly, interval: 'season' } })).status, 400);
  await plat('PATCH', `/billing/plans/${monthlyOnly}`, { active: false });

  // the daily job pauses a season subscription in the summer, and back on monthly the pause comes off
  await q('UPDATE tenant_billing SET season_paused_until = NULL WHERE tenant_id = ?', [tenantId]);
  calls.length = 0;
  const n2 = await B.seasonAll();
  const ours = calls.find((x) => x.path === `/v1/subscriptions/sub_${suffix}`);
  if (B.inSummer(today)) { assert.ok(n2 >= 1); assert.equal(ours.params['pause_collection[behavior]'], 'void'); } else assert.equal(ours, undefined);
  calls.length = 0;
  assert.equal((await api('PUT', '/billing/choice', { token: owner, body: { plan_id: base1, addons: [], interval: 'month' } })).status, 200);
  const back = calls.find((x) => x.method === 'POST' && x.path === `/v1/subscriptions/sub_${suffix}`).params;
  if (B.inSummer(today)) assert.equal(back.pause_collection, '', 'the summer pause is taken off');
  page = (await api('GET', '/billing', { token: owner })).body;
  assert.equal(page.billing.season_paused_until, null);
});

test('read only: sales and new records stop, patrol and billing keep working, the shop stops taking orders', async () => {
  // The subscription is canceled and the trial long gone
  await webhook({ id: `evt_${suffix}_5`, type: 'customer.subscription.deleted', data: { object: { id: `sub_${suffix}`, status: 'canceled', current_period_end: Math.floor(Date.now() / 1000) - 20 * 86400 } } });
  assert.equal((await plat('PUT', `/tenants/${tenantId}/billing`, { trial_ends_on: daysFrom(-40) })).status, 200);
  const me = await api('GET', '/auth/me', { token: owner });
  assert.equal(me.body.billing.state, 'read_only');
  const blocked = await api('POST', '/products', { token: owner, body: { kind: 'day_ticket', name: 'Day ticket', base_price_cents: 5000 } });
  assert.equal(blocked.status, 402); assert.equal(blocked.body.details.code, 'billing_read_only');
  assert.equal((await api('GET', '/products', { token: owner })).status, 200, 'everything can still be seen');
  assert.notEqual((await api('POST', '/patrol/incidents', { token: owner, body: {} })).status, 402, 'patrol keeps working');
  assert.equal((await api('PUT', '/billing/choice', { token: owner, body: { plan_id: base1 } })).status, 200, 'billing can be fixed');
  const shop = await api('POST', `/public/${slug}/shop/orders`, { body: {} });
  assert.ok([404, 409].includes(shop.status), shop.text);
  // The operator records a check: everything is back straight away
  assert.equal((await plat('PUT', `/tenants/${tenantId}/billing`, { paid_until: daysFrom(300), notes: 'Check 1042' })).status, 200);
  assert.equal((await api('POST', '/products', { token: owner, body: { kind: 'day_ticket', name: 'Day ticket', base_price_cents: 5000 } })).status, 201);
  const detail = (await (await require('./helpers/platform-operator').operatorConsole(base, KEY))('GET', `/tenants/${tenantId}`)).body;
  assert.equal(detail.billing_standing.kind, 'paid_manually'); assert.equal(detail.billing.notes, 'Check 1042');
  assert.ok(detail.billing_events.some((e) => e.kind === 'operator_change'));
});

test('paying by invoice starts a subscription that Stripe emails; a free mountain is never blocked', async () => {
  const s2 = `bi-${suffix}`;
  const made = await plat('POST', '/tenants', { slug: s2, name: 'Invoice Test', owner: { email: `o@${s2}.test`, password: PW, first_name: 'Ivy', last_name: 'Owner' } });
  const t2 = made.body.id;
  const o2 = await login(s2, `o@${s2}.test`);
  assert.equal((await api('POST', '/billing/invoice', { token: o2, body: { billing_email: 'ap@invoice.test' } })).status, 400, 'choose a plan first');
  assert.equal((await api('PUT', '/billing/choice', { token: o2, body: { plan_id: base1, interval: 'year' } })).status, 200);
  calls.length = 0;
  const inv = await api('POST', '/billing/invoice', { token: o2, body: { billing_email: 'ap@invoice.test' } });
  assert.equal(inv.status, 200, inv.text);
  const sub = calls.find((c) => c.path === '/v1/subscriptions').params;
  assert.equal(sub.collection_method, 'send_invoice'); assert.equal(sub.days_until_due, '30');
  assert.equal(calls.find((c) => c.path === '/v1/customers').params.email, 'ap@invoice.test');
  const b = (await q('SELECT * FROM tenant_billing WHERE tenant_id = ?', [t2]))[0];
  assert.equal(b.pay_method, 'invoice'); assert.ok(b.stripe_subscription_id);
  // Canceled, then invoiced again the same day: a new subscription, not Stripe's saved answer for the old one.
  const firstKey = calls.find((c) => c.path === '/v1/subscriptions').key;
  await q("UPDATE tenant_billing SET sub_status = 'canceled' WHERE tenant_id = ?", [t2]);
  calls.length = 0;
  assert.equal((await api('POST', '/billing/invoice', { token: o2, body: { billing_email: 'ap@invoice.test' } })).status, 200);
  assert.notEqual(calls.find((c) => c.path === '/v1/subscriptions').key, firstKey);
  // free
  const s3 = `bf-${suffix}`;
  const m3 = await plat('POST', '/tenants', { slug: s3, name: 'Free Test', billing: 'comped', owner: { email: `o@${s3}.test`, password: PW, first_name: 'Fay', last_name: 'Owner' } });
  assert.equal(m3.status, 201);
  const o3 = await login(s3, `o@${s3}.test`);
  assert.equal((await api('GET', '/auth/me', { token: o3 })).body.billing.kind, 'comped');
});
