#!/usr/bin/env node
'use strict';

// A holiday Saturday morning, squeezed into a few minutes (2026.11.10, READY). Plain Node 22 (fetch), nothing to install.
//
// Three things happen at once against one mountain:
//   gates     each gate scans a ticket every few seconds (POST /api/v1/device/check), mostly tickets the counters just sold
//   counters  each counter sells a day ticket for cash every few seconds (the menu, a quote, then the sale)
//   shop      guests open the online shop at once: the page, the shop, the month, the day, a priced basket
//             (and, with --orders N, N of them go on to make an order, which opens a Stripe checkout in test mode)
// At the end it prints, for each kind of request: how many, p50, p95, p99 and the slowest, errors, and how many were
// turned away by a rate limit (429: the limits are per address, and a load test comes from one address).
//
// It refuses to run against the live site. It only runs against this computer (localhost) or a service whose /version
// says it is staging, unless --live-i-am-sure is given.
//
// Usage (DEPLOY.md, "Load test"):
//   node scripts/loadtest.js --dry-run                      on this computer: http://localhost:8080, demo-mountain,
//                                                            owner@demo-mountain.test, sets up its own gate; 60 seconds
//   node scripts/loadtest.js --url https://<staging> --mountain <slug> --login <counter login> --password <pw> \
//        --staging-password <STAGING_GATE> --pair-code <code from Gate, Devices>
// Options:
//   --seconds N       how long the busy part lasts (default 120; 60 with --dry-run)
//   --gates N         gates scanning (default 6), --scan-every S seconds between scans per gate (default 2)
//   --counters N      counters selling (default 6), --sale-every S seconds between sales per counter (default 10)
//   --shoppers N      guests opening the online shop during the run (default 120), --shop-at-once N (default 12)
//   --orders N        how many shoppers go on to order (default 0: an order opens a Stripe checkout)
//   --scale X         multiplies gates, counters and shoppers (default 1)
//   --plan            print what it would do and stop (sends nothing but GET /version)
//   --json FILE       also write the numbers to FILE
const fs = require('node:fs');

// ---------------------------------------------------------------- options
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const flag = ['dry-run', 'plan', 'live-i-am-sure', 'help'].includes(k);
    if (flag) o[k] = true; else { o[k] = argv[i + 1]; i += 1; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 31).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
const dry = Boolean(args['dry-run']);
const num = (k, d) => (args[k] !== undefined ? Number(args[k]) : d);
const scale = num('scale', 1);
const opt = {
  url: String(args.url || (dry ? `http://localhost:${process.env.PORT || 8080}` : '')).replace(/\/+$/, ''),
  mountain: args.mountain || (dry ? 'demo-mountain' : ''),
  login: args.login || (dry ? 'owner@demo-mountain.test' : ''),
  password: args.password || process.env.LOADTEST_PASSWORD || (dry ? 'video-demo-pass-2026' : ''),
  stagingPassword: args['staging-password'] || process.env.STAGING_GATE || '',
  pairCode: args['pair-code'] || '',
  seconds: num('seconds', dry ? 60 : 120),
  gates: Math.round(num('gates', 6) * scale), scanEvery: num('scan-every', 2),
  counters: Math.round(num('counters', 6) * scale), saleEvery: num('sale-every', 10),
  shoppers: Math.round(num('shoppers', 120) * scale), shopAtOnce: Math.max(1, Math.round(num('shop-at-once', 12) * scale)),
  orders: num('orders', 0),
  json: args.json || '',
};

function stop(msg) { console.error(msg); process.exit(1); }
if (!opt.url) stop('Say where: --url https://<staging address>, or --dry-run for this computer. node scripts/loadtest.js --help');
if (!opt.mountain || !opt.login || !opt.password) stop('Say which mountain and login: --mountain <slug> --login <email or username> --password <password>.');
for (const k of ['seconds', 'gates', 'counters', 'shoppers', 'scanEvery', 'saleEvery', 'orders']) if (!Number.isFinite(opt[k]) || opt[k] < 0) stop(`--${k} must be a number, 0 or more.`);

const isLocal = (u) => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(u).hostname); } catch (_) { return false; } };
if (dry && !isLocal(opt.url)) stop('--dry-run only runs against this computer (localhost). For staging, leave --dry-run out.');

// ---------------------------------------------------------------- requests, timed
const stats = new Map(); // name -> { ms: [], errors, limited, codes: {} }
let cookie = '';
async function call(name, method, path, { token, device, body, html } = {}) {
  const headers = { accept: html ? 'text/html' : 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (device) headers.authorization = `Device ${device}`;
  if (cookie) headers.cookie = cookie;
  const s = stats.get(name) || { ms: [], errors: 0, limited: 0, codes: {} };
  stats.set(name, s);
  const t0 = performance.now();
  let status = 0; let json = null;
  try {
    const res = await fetch(`${opt.url}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (_) { json = null; }
  } catch (_) { status = 0; }
  const ms = performance.now() - t0;
  s.codes[status] = (s.codes[status] || 0) + 1;
  if (status === 429) s.limited += 1;
  else if (status === 0 || status >= 500) s.errors += 1;
  else s.ms.push(ms);
  return { status, body: json };
}
// Setup calls are not counted.
async function plain(method, path, opts = {}) {
  const r = await call('_setup', method, path, opts);
  stats.delete('_setup');
  return r;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
function report(started) {
  const secs = (Date.now() - started) / 1000;
  const lines = [];
  const out = {};
  const f = (v) => (v === null ? '-' : `${Math.round(v)}`);
  lines.push(`${'request'.padEnd(18)} ${'count'.padStart(6)} ${'/min'.padStart(6)} ${'p50 ms'.padStart(7)} ${'p95 ms'.padStart(7)} ${'p99 ms'.padStart(7)} ${'max ms'.padStart(7)} ${'errors'.padStart(7)} ${'429s'.padStart(5)}`);
  for (const [name, s] of [...stats.entries()].sort()) {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const n = sorted.length + s.errors + s.limited;
    const row = { count: n, per_min: Math.round((n / secs) * 60), p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99), max: sorted.length ? sorted[sorted.length - 1] : null, errors: s.errors, limited: s.limited, codes: s.codes };
    out[name] = row;
    lines.push(`${name.padEnd(18)} ${String(n).padStart(6)} ${String(row.per_min).padStart(6)} ${f(row.p50).padStart(7)} ${f(row.p95).padStart(7)} ${f(row.p99).padStart(7)} ${f(row.max).padStart(7)} ${String(s.errors).padStart(7)} ${String(s.limited).padStart(5)}`);
  }
  const all = [...stats.values()].flatMap((s) => s.ms).sort((a, b) => a - b);
  const errors = [...stats.values()].reduce((t, s) => t + s.errors, 0);
  const limited = [...stats.values()].reduce((t, s) => t + s.limited, 0);
  const total = all.length + errors + limited;
  lines.push(`${'all'.padEnd(18)} ${String(total).padStart(6)} ${String(Math.round((total / secs) * 60)).padStart(6)} ${f(pct(all, 50)).padStart(7)} ${f(pct(all, 95)).padStart(7)} ${f(pct(all, 99)).padStart(7)} ${f(all[all.length - 1] ?? null).padStart(7)} ${String(errors).padStart(7)} ${String(limited).padStart(5)}`);
  out.all = { count: total, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), errors, limited, seconds: Math.round(secs) };
  return { text: lines.join('\n'), out };
}

// ---------------------------------------------------------------- the run
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const jitter = (s) => s * 1000 * (0.7 + Math.random() * 0.6);
const rand = (n) => Math.floor(Math.random() * n);
const NAMES = ['Avery', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Harper', 'Rowan', 'Sawyer', 'Emerson'];
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  // Which service is this? Refuse the live site.
  const v = await plain('GET', '/version');
  if (v.status !== 200 || !v.body) stop(`${opt.url}/version did not answer (${v.status}). Is the address right?`);
  const staging = v.body.stage === 'staging';
  if (!isLocal(opt.url) && !staging && !args['live-i-am-sure']) {
    stop(`${opt.url} is not staging (its /version does not say "stage":"staging"). This load test does not run against the live site.\nIf you really mean to, add --live-i-am-sure, and only outside business hours.`);
  }
  console.log(`Load test of ${opt.url} (${staging ? 'staging' : isLocal(opt.url) ? 'this computer' : 'NOT STAGING'}), version ${v.body.version}, mountain ${opt.mountain}.`);
  console.log(`${opt.seconds} seconds: ${opt.gates} gates (a scan every ${opt.scanEvery} s each), ${opt.counters} counters (a sale every ${opt.saleEvery} s each), ${opt.shoppers} online shoppers (${opt.shopAtOnce} at once)${opt.orders ? `, ${opt.orders} of them ordering` : ''}.`);
  if (args.plan) { console.log('--plan: nothing else was sent.'); return; }

  // The staging password, when staging has one.
  if (opt.stagingPassword) {
    const res = await fetch(`${opt.url}/__staging`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password: opt.stagingPassword, next: '/' }), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (!set) stop('The staging password was not accepted.');
    cookie = set.split(';')[0];
  }

  // Sign in once; every counter uses the same sign-in (one login, several tabs).
  const isEmail = opt.login.includes('@');
  const li = await plain('POST', '/api/v1/auth/login', { body: { tenant: opt.mountain, ...(isEmail ? { email: opt.login } : { username: opt.login }), password: opt.password } });
  if (li.status !== 200 || !li.body || !li.body.token) {
    stop(`Could not sign in as ${opt.login} at ${opt.mountain} (${li.status}: ${li.body && li.body.error ? li.body.error : 'no token'}).${li.body && (li.body.mfa_required || li.body.mfa) ? ' That login needs two-step sign-in: use a counter login, and --pair-code for the gate.' : ''}`);
  }
  const token = li.body.token;

  // What the counter sells: the first day ticket on the menu.
  const menu = await plain('GET', '/api/v1/checkout/menu', { token });
  if (menu.status !== 200) stop(`This login cannot sell (${menu.status}). Use a counter or manager login.`);
  const ticket = (menu.body.tickets || []).find((t) => t.kind === 'day_ticket') || (menu.body.tickets || [])[0];
  if (!ticket) stop('The mountain has no ticket to sell. Add a day ticket under Tickets and passes first.');

  // A gate: paired with the code from Gate, Devices, or made here when the login is a manager.
  let device = null;
  let pairCode = opt.pairCode;
  if (!pairCode && opt.gates) {
    const made = await plain('POST', '/api/v1/access/devices', { token, body: { name: `Load test gate ${new Date().toISOString().slice(0, 16)}`, kind: 'gate', location: 'Load test' } });
    if (made.status === 201) pairCode = made.body.code;
    else console.log('No gate: give --pair-code (Gate, Devices, Add a device) to test scans. Skipping the gates.');
  }
  if (pairCode) {
    const p = await plain('POST', '/api/v1/device/pair', { body: { code: pairCode } });
    if (p.status !== 200) stop(`The pairing code did not work (${p.status}: ${p.body && p.body.error}).`);
    device = p.body.token;
  }

  // The online shop: is it open, and what does it sell today?
  const shop = await plain('GET', `/api/v1/public/${encodeURIComponent(opt.mountain)}/shop`);
  const shopOpen = shop.status === 200;
  if (!shopOpen) console.log(`The online shop did not open (${shop.status}). Skipping the shoppers.`);

  const codes = []; // tickets sold so far, for the gates to scan
  const until = Date.now() + opt.seconds * 1000;
  const started = Date.now();
  const workers = [];

  // Counters: menu, then a cash sale of one day ticket.
  for (let c = 0; c < opt.counters; c += 1) {
    workers.push((async () => {
      await sleep(rand(opt.saleEvery * 1000));
      while (Date.now() < until) {
        await call('counter menu', 'GET', '/api/v1/checkout/menu', { token });
        const lines = [{ type: 'ticket', product_id: ticket.id }];
        const q = await call('counter quote', 'POST', '/api/v1/checkout/quote', { token, body: { lines } });
        const price = q.body && Number.isFinite(q.body.total_cents) ? q.body.total_cents : Number(ticket.base_price_cents || 0);
        const first = NAMES[rand(NAMES.length)];
        const sale = await call('counter sale', 'POST', '/api/v1/checkout', { token, body: {
          customer: { details: { first_name: first, last_name: 'Loadtest', email: `${first.toLowerCase()}.${Date.now()}${rand(1000)}@loadtest.invalid`, date_of_birth: '1988-02-03', sex: 'female' } },
          lines,
          payments: [{ tender: 'cash', amount_cents: price, tendered_cents: price }],
        } });
        if (sale.status === 201 && sale.body && sale.body.tickets) for (const t of sale.body.tickets) if (t.code) codes.push(t.code);
        await sleep(jitter(opt.saleEvery));
      }
    })());
  }

  // Gates: scan a ticket sold in this run (three in four) or a code nobody sold.
  for (let g = 0; g < opt.gates && device; g += 1) {
    workers.push((async () => {
      await sleep(rand(opt.scanEvery * 1000));
      let n = 0;
      while (Date.now() < until) {
        const code = codes.length && Math.random() < 0.75 ? codes[rand(codes.length)] : `LT${Date.now().toString(36).toUpperCase()}${rand(1e6)}`;
        await call('gate scan', 'POST', '/api/v1/device/check', { device, body: { code, client_ref: `lt-${g}-${n += 1}-${Date.now()}` } });
        await sleep(jitter(opt.scanEvery));
      }
    })());
  }

  // Shoppers: arrive over the first half of the run, opening the shop the way the page does.
  if (shopOpen && opt.shoppers) {
    let next = 0; let ordered = 0;
    const slug = encodeURIComponent(opt.mountain);
    const day = today(); const month = day.slice(0, 7);
    const arriveOver = (opt.seconds * 1000) / 2;
    for (let w = 0; w < opt.shopAtOnce; w += 1) {
      workers.push((async () => {
        while (Date.now() < until) {
          const i = next; next += 1;
          if (i >= opt.shoppers) return;
          const due = started + (arriveOver * i) / opt.shoppers;
          if (due > Date.now()) await sleep(due - Date.now());
          await call('shop page', 'GET', `/shop/${slug}`, { html: true });
          await call('shop', 'GET', `/api/v1/public/${slug}/shop`);
          await call('shop month', 'GET', `/api/v1/public/${slug}/shop/month?month=${month}`);
          const d = await call('shop day', 'GET', `/api/v1/public/${slug}/shop/day?date=${day}`);
          const p = d.body && (d.body.products || []).find((x) => x.available !== false);
          if (!p) continue;
          const first = NAMES[rand(NAMES.length)];
          const basket = { items: [{ product_id: p.id, valid_on: day, holder: { first_name: first, last_name: 'Loadtest', date_of_birth: '1988-02-03', age_group: (p.prices && p.prices.some((x) => x.tier === 'adult')) ? 'adult' : undefined } }] };
          await call('shop quote', 'POST', `/api/v1/public/${slug}/shop/quote`, { body: basket });
          if (ordered < opt.orders) {
            ordered += 1;
            await call('shop order', 'POST', `/api/v1/public/${slug}/shop/orders`, { body: { ...basket, contact_first_name: first, contact_last_name: 'Loadtest', contact_email: `${first.toLowerCase()}@loadtest.invalid`, contact_phone: '610-555-0100', terms_accepted: true, waiver_accepted: true, limits_accepted: true } });
          }
        }
      })());
    }
  }

  const tick = setInterval(() => { process.stdout.write(`  ${Math.max(0, Math.round((until - Date.now()) / 1000))} s left, ${[...stats.values()].reduce((t, s) => t + s.ms.length + s.errors + s.limited, 0)} requests so far\n`); }, 15_000);
  await Promise.all(workers);
  clearInterval(tick);
  const { text, out } = report(started);
  console.log(`\nDone: ${codes.length} tickets sold.\n`);
  console.log(text);
  console.log('\nErrors are answers of 500 or more, and no answer at all. 429s are rate limits: every request here comes from one address.');
  if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ url: opt.url, version: v.body.version, options: { ...opt, password: undefined, stagingPassword: undefined }, results: out }, null, 2));
  if (out.all.errors) process.exitCode = 2;
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
