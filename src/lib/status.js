'use strict';

// The public status page (2026.11.10, READY): /status on the website, and GET /api/v1/status for the same as JSON.
// Each part of the service shows as working or not, from cheap checks this server makes itself, plus the incidents and
// planned maintenance the platform operator writes in the console (status_notes), for the last 90 days.
// No customer data: the checks only ask "does it answer", and the notes are written for the public.
//
// The checks, cached for a minute on each server (one check at a time, however many visitors):
//   app       the database answers and is migrated for this version (the same test as /readyz)
//   guest     the online shop and booking pages: the same servers and database as the app, so they follow it
//   payments  Stripe answers our key (GET /v1/balance). "Not checked" when Stripe is not set up.
//   email     Postmark answers our server token (GET /server). "Not checked" when email is not set up.
//   texts     Twilio answers our account (GET /Accounts/<sid>.json). "Not checked" when texts are not set up.
// STATUS_PROBES=off skips the three outside checks (they show "Not checked").
// While an incident or maintenance note is open, the parts it names show its impact, whatever the checks say.
const { pool, rows } = require('../db');

const PARTS = [
  ['app', 'The app', 'Staff sign-in and every screen at the mountain'],
  ['guest', 'Online shop and booking pages', 'Tickets, lessons, programs, waivers and rentals online'],
  ['payments', 'Card payments', 'Paying by card online and at the counter (Stripe)'],
  ['email', 'Email', 'Tickets, receipts, reminders and sign-in codes'],
  ['texts', 'Text messages', 'Reminders and alerts by text'],
];
const PART_KEYS = PARTS.map((p) => p[0]);
const IMPACT = { none: 'No impact expected', slow: 'Slow or partly working', down: 'Not working' };
const WORD = { ok: 'Working', slow: 'Slow or partly working', down: 'Not working', unknown: 'Not checked', maintenance: 'Planned maintenance' };
const CACHE_MS = () => Number(process.env.STATUS_CACHE_MS ?? 60_000);
const PROBE_MS = 4000;

async function probe(url, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_MS);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    return res.ok ? 'ok' : (res.status >= 500 || res.status === 429 ? 'slow' : 'down');
  } catch (_) { return 'down'; } finally { clearTimeout(t); }
}

async function checkApp() {
  try {
    await pool.query('SELECT 1');
    const { LATEST } = require('../schema');
    const [r] = LATEST.column
      ? await pool.query('SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1', [LATEST.table, LATEST.column])
      : await pool.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1', [LATEST.table, LATEST.index]);
    return r.length ? 'ok' : 'slow';
  } catch (_) { return 'down'; }
}

async function checkPayments() {
  const config = require('../config');
  if (!require('./stripe').enabled()) return 'unknown';
  return probe(`${config.stripe.apiBase}/v1/balance`, { authorization: `Bearer ${config.stripe.secretKey}` });
}
async function checkEmail() {
  const mailer = require('./mailer');
  if (!mailer.enabled()) return 'unknown';
  return probe(`${mailer.settings.apiBase}/server`, { accept: 'application/json', 'x-postmark-server-token': process.env.POSTMARK_SERVER_TOKEN });
}
async function checkTexts() {
  if (!require('./sms').enabled()) return 'unknown';
  const env = process.env;
  const base = env.TWILIO_API_BASE || 'https://api.twilio.com';
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  return probe(`${base}/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}.json`, { authorization: `Basic ${auth}` });
}

let cache = { at: 0, checks: null };
let running = null;
/** { app, guest, payments, email, texts }: ok, slow, down or unknown, at most a minute old. */
async function checks() {
  if (cache.checks && Date.now() - cache.at < CACHE_MS()) return cache.checks;
  if (running) return running;
  running = (async () => {
    const outside = process.env.STATUS_PROBES !== 'off';
    const [app, payments, email, texts] = await Promise.all([checkApp(), outside ? checkPayments() : 'unknown', outside ? checkEmail() : 'unknown', outside ? checkTexts() : 'unknown']);
    const out = { app, guest: app, payments, email, texts };
    cache = { at: Date.now(), checks: out };
    return out;
  })();
  try { return await running; } finally { running = null; }
}
const forget = () => { cache = { at: 0, checks: null }; };

const utc = (d) => new Date(`${String(d).replace(' ', 'T')}Z`);
const iso = (d) => (d ? utc(d).toISOString() : null);
const shape = (n) => ({
  id: Number(n.id), kind: n.kind, title: n.title, body: n.body || '', parts: String(n.parts || '').split(',').filter((p) => PART_KEYS.includes(p)),
  impact: n.impact, starts_at: iso(n.starts_at), ends_at: iso(n.ends_at), updated_at: n.updated_at ? new Date(`${String(n.updated_at).replace(' ', 'T')}Z`).toISOString() : null,
});

/** Notes that touch the last 90 days, and planned maintenance still to come. */
async function notes(db = pool) {
  return (await rows(db, `SELECT id, kind, title, body, parts, impact, starts_at, ends_at, updated_at FROM status_notes
    WHERE ends_at IS NULL OR ends_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 90 DAY) ORDER BY starts_at DESC, id DESC LIMIT 300`)).map(shape);
}

const isOpen = (n, now) => new Date(n.starts_at) <= now && (!n.ends_at || new Date(n.ends_at) > now);
const RANK = { ok: 0, unknown: 0, maintenance: 1, slow: 2, down: 3 };

/** Everything the page shows. now is for the tests. */
async function snapshot(now = new Date()) {
  const [c, list] = await Promise.all([checks(), notes().catch(() => [])]);
  const open = list.filter((n) => isOpen(n, now));
  const parts = PARTS.map(([key, name, about]) => {
    let state = c[key];
    for (const n of open) {
      if (!n.parts.includes(key)) continue;
      const s = n.kind === 'maintenance' && n.impact === 'none' ? 'maintenance' : n.impact === 'none' ? state : n.impact;
      if (RANK[s] > RANK[state]) state = s;
    }
    // 90 days, oldest first: the worst a note said about this part on each day (UTC days).
    const days = [];
    for (let i = 89; i >= 0; i -= 1) {
      const d0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
      const d1 = new Date(d0.getTime() + 86_400_000);
      let worst = 'ok'; const titles = [];
      for (const n of list) {
        if (!n.parts.includes(key) || n.impact === 'none' || new Date(n.starts_at) >= d1 || (n.ends_at && new Date(n.ends_at) < d0) || new Date(n.starts_at) > now) continue;
        if (RANK[n.impact] > RANK[worst]) worst = n.impact;
        titles.push(n.title);
      }
      days.push({ date: d0.toISOString().slice(0, 10), state: worst, titles });
    }
    return { key, name, about, state, word: WORD[state], days };
  });
  const worst = parts.reduce((w, p) => (RANK[p.state] > RANK[w] ? p.state : w), 'ok');
  const summary = worst === 'down' ? 'Something is not working. We are on it.'
    : worst === 'slow' ? 'Some things are slow or partly working. We are on it.'
      : worst === 'maintenance' ? 'Planned maintenance is under way.' : 'Everything is working.';
  return {
    summary, state: worst, checked_at: new Date(cache.at || Date.now()).toISOString(), parts,
    open: open.map((n) => ({ ...n, impact_word: IMPACT[n.impact] })),
    planned: list.filter((n) => n.kind === 'maintenance' && new Date(n.starts_at) > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map((n) => ({ ...n, impact_word: IMPACT[n.impact] })),
    past: list.filter((n) => n.ends_at && new Date(n.ends_at) <= now).map((n) => ({ ...n, impact_word: IMPACT[n.impact] })),
  };
}

// ---------------------------------------------------------------- the page itself (src/site/status.html)
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ET = { timeZone: 'America/New_York' };
const when = (s) => `${new Date(s).toLocaleString('en-US', { ...ET, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
const dayWord = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const partNames = (keys) => keys.map((k) => (PARTS.find((p) => p[0] === k) || [k, k])[1]).join(', ');

function noteHtml(n, heading = 'h3') {
  const span = n.ends_at ? `${when(n.starts_at)} to ${when(n.ends_at)}` : `Since ${when(n.starts_at)}`;
  return `<article class="st-note st-${esc(n.kind)}">
  <${heading}>${n.kind === 'maintenance' ? 'Maintenance: ' : ''}${esc(n.title)}</${heading}>
  <p class="st-meta">${esc(span)}. ${esc(partNames(n.parts) || 'The whole service')}. ${esc(IMPACT[n.impact])}.</p>
  ${n.body ? `<p>${esc(n.body).replace(/\n+/g, '<br>')}</p>` : ''}
</article>`;
}

/** Fills the status page's <!--STATUS--> from a snapshot. */
function pageHtml(s) {
  const parts = s.parts.map((p) => `<li class="st-part st-${esc(p.state)}">
      <div class="st-row"><span class="st-dot" aria-hidden="true"></span><div><h3>${esc(p.name)}</h3><p>${esc(p.about)}</p></div><b>${esc(p.word)}</b></div>
      <ol class="st-days" aria-label="${esc(p.name)}, the last 90 days">${p.days.map((d) => `<li class="st-${esc(d.state)}" title="${esc(`${dayWord(d.date)}: ${d.state === 'ok' ? 'no incidents' : `${WORD[d.state]}. ${d.titles.join('; ')}`}`)}"><span class="vh">${esc(dayWord(d.date))}: ${esc(d.state === 'ok' ? 'no incidents' : WORD[d.state])}</span></li>`).join('')}</ol>
      <div class="st-scale" aria-hidden="true"><span>90 days ago</span><span>Today</span></div>
    </li>`).join('\n    ');
  const open = s.open.length ? `<section class="st-sec" aria-labelledby="st-now"><h2 id="st-now">Happening now</h2>${s.open.map((n) => noteHtml(n)).join('')}</section>` : '';
  const planned = `<section class="st-sec" aria-labelledby="st-planned"><h2 id="st-planned">Planned maintenance</h2>${s.planned.length ? s.planned.map((n) => noteHtml(n)).join('') : '<p class="st-none">Nothing planned.</p>'}</section>`;
  const past = `<section class="st-sec" aria-labelledby="st-past"><h2 id="st-past">The last 90 days</h2>${s.past.length ? s.past.map((n) => noteHtml(n)).join('') : '<p class="st-none">No incidents in the last 90 days.</p>'}</section>`;
  return `<div class="st-sum st-${esc(s.state)}" role="status"><span class="st-dot" aria-hidden="true"></span><p><b>${esc(s.summary)}</b><span>Checked ${esc(when(s.checked_at))}. This page checks again every minute.</span></p></div>
  ${open}
  <ul class="st-parts" aria-label="Each part of Verdynt/OS">
    ${parts}
  </ul>
  ${planned}
  ${past}`;
}

module.exports = { PARTS, PART_KEYS, IMPACT, WORD, checks, forget, notes, snapshot, pageHtml, shape };
