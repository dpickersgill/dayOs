'use strict';

// The Good Day: the Verdynt/OS newsletter for ski area owners, GMs and patrol directors (guests round 2, track SITE).
//
// Issues are files: src/site/good-day/issue-N.html, listed in src/site/good-day/issues.json (number, date, moment,
// question, title, teaser and the three lines its email carries). A new issue is one file and one line.
//
// Sign-up is double opt-in. The website's card posts an email (and an optional name and role); a pending row keeps the
// consent (when, the exact wording shown beside the button, the address it came from) and a confirmation link goes out.
// The link confirms, and a welcome email links Issue 1. Every email after that carries its own unsubscribe link and the
// List-Unsubscribe headers (one click in a mail app). The answer to a sign-up is always the same, so the form never
// says whether an address is already on the list. Link tokens are 32 random bytes; only their SHA-256 is stored.
//
// Sending (platform console, operators only): a test to one address, then every confirmed subscriber through Postmark's
// broadcast stream, in batches. Each subscriber's copy of an issue is claimed in goodday_deliveries before it goes, so
// pressing Send again (or two operators at once) never sends anyone the same issue twice. Platform-level: no tenant.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pool, tx, rows, one } = require('../db');
const config = require('../config');
const mailer = require('./mailer');
const { esc, dayText } = require('./format');

const DIR = path.join(__dirname, '..', 'site', 'good-day');
const MOMENTS = ['Plan', 'Arrive', 'Learn', 'Ride', 'Get help', 'Come back'];
const ROLES = { owner_gm: 'Owner or GM', patrol: 'Patrol director', other: 'Something else' };
// Shown beside every Subscribe button and stored with each sign-up, word for word.
const CONSENT = 'One email every other week from Verdynt/OS. We send a link to confirm first. Unsubscribe any time.';
const CONFIRM_DAYS = 7;
const RESEND_MINUTES = 10; // a second sign-up for the same pending address sends the link again, at most this often
const BATCH = 50;

// ---------------------------------------------------------------- the issues
let cache = null;
/** Every issue, newest first, and what comes next. Read from issues.json (again on each call outside production). */
function catalog() {
  if (cache && config.isProd) return cache;
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'issues.json'), 'utf8'));
  const issues = raw.issues.map((i) => ({
    n: Number(i.n), date: String(i.date), moment: i.moment, moment_no: MOMENTS.indexOf(i.moment) + 1, question: i.question, title: i.title, teaser: i.teaser,
    lines: Array.isArray(i.lines) && i.lines.length ? i.lines.slice(0, 3) : [i.teaser], slug: `good-day/issue-${Number(i.n)}`,
  })).filter((i) => i.n > 0 && i.moment_no > 0 && fs.existsSync(path.join(DIR, `issue-${i.n}.html`))).sort((a, b) => b.n - a.n);
  cache = { issues, next: raw.next || null };
  return cache;
}
const issues = () => catalog().issues;
const issue = (n) => issues().find((i) => i.n === Number(n)) || null;
const latest = () => issues()[0] || null;
/** "October 30, 2026": the date in an issue's masthead and in the archive. */
const longDate = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${String(d).slice(0, 10)}T12:00:00Z`));

// ---------------------------------------------------------------- search engines (added to lib/seo.js META by routes/site.js)
function meta() {
  const out = {
    'good-day': {
      title: 'The Good Day: A Newsletter for Ski Area Operators | Verdynt/OS',
      description: 'Every other week, one moment of your guest\'s day taken apart: Plan, Arrive, Learn, Ride, Get help, Come back. For ski area owners, GMs and patrol directors.',
      og: 'The Good Day: one moment of your guest\'s day, every other week', crumb: 'The Good Day', parent: 'resources',
    },
    'good-day/notice': { title: 'The Good Day | Verdynt/OS', description: 'Your subscription to The Good Day.', noindex: true },
  };
  for (const i of issues()) {
    out[i.slug] = {
      title: `The Good Day #${i.n}: ${i.question} | Verdynt/OS`,
      description: i.teaser.slice(0, 160), og: `The Good Day, Issue ${i.n}: ${i.question}`, crumb: `Issue ${i.n}`, parent: 'good-day',
      article: { published: i.date, headline: `The Good Day, Issue ${i.n}: ${i.title}` },
    };
  }
  return out;
}

// ---------------------------------------------------------------- the sign-up card (website)
const momentStrip = (on) => `<ol class="gd-moments" aria-label="The six moments of a guest's day">${MOMENTS.map((m, i) => `<li${m === on ? ' class="on" aria-current="step"' : ''}><b>${i + 1}</b>${m}</li>`).join('')}</ol>`;

/**
 * The sign-up form, the same everywhere: email, optional name and role, a field people never see (bots fill it), the
 * consent words. source names the page, kept with the sign-up. Posts to the API; site.js sends it without leaving the page.
 */
function form(source, { compact = false, id = source } = {}) {
  const f = (n) => `gd-${id}-${n}`;
  const extra = compact ? '' : `
    <div class="gd-more">
      <label class="gd-fld" for="${f('name')}"><span>Your name <i>(optional)</i></span><input id="${f('name')}" name="name" autocomplete="name" maxlength="100"></label>
      <label class="gd-fld" for="${f('role')}"><span>You are <i>(optional)</i></span><select id="${f('role')}" name="role"><option value="">Choose one</option>${Object.entries(ROLES).map(([k, t]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
    </div>`;
  return `<form class="gd-form${compact ? ' compact' : ''}" action="/api/v1/site/good-day/subscribe" method="post" data-gd="${esc(source)}" novalidate>
    <input type="hidden" name="source" value="${esc(source)}">
    <div class="gd-row">
      <label class="vh" for="${f('email')}">Email address</label>
      <input id="${f('email')}" type="email" name="email" required autocomplete="email" maxlength="255" placeholder="you@yourmountain.com" aria-describedby="${f('fine')}">
      <button type="submit">Subscribe</button>
    </div>${extra}
    <div class="gd-hp" aria-hidden="true"><label for="${f('web')}">Leave this empty</label><input id="${f('web')}" name="website" tabindex="-1" autocomplete="off"></div>
    <p class="gd-fine" id="${f('fine')}">${CONSENT}</p>
    <p class="gd-status" role="status" aria-live="polite" tabindex="-1"></p>
  </form>`;
}

/** The full card: Issue 1's question, a link to read it, and the sign-up. On an issue's own page, the link is left out. */
function card(source, { onIssue = null } = {}) {
  const i = latest();
  const read = i && onIssue !== i.n ? `
  <p class="gd-q">Issue ${i.n}: ${esc(i.title.charAt(0).toLowerCase() + i.title.slice(1))}.</p>
  <p>${esc(i.teaser)}</p>
  <p><a class="gd-btn" href="{{SITE}}/good-day/issue-${i.n}">Read Issue ${i.n}</a></p>
  <hr>` : '';
  const next = catalog().next;
  const get = read
    ? '<p class="gd-get"><strong>Get the next issue.</strong> Every other week, one moment of your guest\'s day taken apart.</p>'
    : `<p class="gd-get">Every other week, one moment of your guest's day taken apart.${next ? ` Next: <strong>${esc(next.moment)}</strong>, "${esc(next.question)}"` : ''}</p>`;
  return `<section class="gd-card" aria-labelledby="gd-h-${esc(source)}">
  <p class="gd-eye">The Good Day &middot; for ski area owners, GMs and patrol directors</p>
  <h2 id="gd-h-${esc(source)}">${read ? esc(i.question) : 'Get the next issue.'}</h2>${read}
  ${get}
  ${form(source)}
</section>`;
}

/** One line in every page's footer. */
function footerLine() {
  return `<div class="sf-gd"><div class="sf-gd-t"><b>The Good Day</b><span>One moment of your guest's day, every other week. <a href="{{SITE}}/good-day">Read the issues</a></span></div>${form('footer', { compact: true })}</div>`;
}

/** The archive on the Good Day home: newest first, each issue's moment, question and date. */
function archive() {
  const list = issues();
  if (!list.length) return '<p>The first issue is on its way.</p>';
  return `<ol class="gd-issues" reversed>${list.map((i) => `
      <li><a href="{{SITE}}/good-day/issue-${i.n}">
        <span class="gd-i-meta"><b>Issue ${i.n}</b><span class="gd-pill">${i.moment_no}. ${esc(i.moment)}</span><time datetime="${esc(i.date)}">${longDate(i.date)}</time></span>
        <strong>${esc(i.question)}</strong>
        <span class="gd-i-t">${esc(i.title)}. ${esc(i.teaser)}</span>
      </a></li>`).join('')}
    </ol>`;
}

// ---------------------------------------------------------------- tokens
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const looksLikeToken = (t) => /^[A-Za-z0-9_-]{43}$/.test(String(t || ''));
async function mint(conn, subscriberId, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  await conn.query(`INSERT INTO goodday_tokens (subscriber_id, purpose, token_hash, expires_at) VALUES (?, ?, ?, ${purpose === 'confirm' ? `UTC_TIMESTAMP() + INTERVAL ${CONFIRM_DAYS} DAY` : 'NULL'})`, [subscriberId, purpose, hash(token)]);
  return token;
}
async function find(token, purpose) {
  if (!looksLikeToken(token)) return null;
  return one(pool, `SELECT t.id AS token_id, t.expires_at, t.expires_at IS NOT NULL AND t.expires_at < UTC_TIMESTAMP() AS expired, s.*
    FROM goodday_tokens t JOIN goodday_subscribers s ON s.id = t.subscriber_id WHERE t.token_hash = ? AND t.purpose = ?`, [hash(token), purpose]);
}
/** "d***@yourmountain.com": enough for the person to know it is theirs, not enough to read someone else's. */
const masked = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, (_m, a, b) => `${a}***${b}`);

// ---------------------------------------------------------------- emails
async function settings() {
  await pool.query('INSERT IGNORE INTO goodday_settings (id) VALUES (1)');
  return one(pool, 'SELECT from_name, postal_address, updated_by, updated_at FROM goodday_settings WHERE id = 1');
}
const amber = '#f0a04b'; const spruce = '#0f3b2e'; const ink = '#14212b';
const FONT = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const DISPLAY = "'Barlow Condensed','Arial Narrow',Arial,sans-serif";

/** A plain, sturdy HTML email: tables and inline styles (Gmail, Outlook, Apple Mail), 600 wide, the masthead on top. */
function shell({ preheader, eyebrow, body, foot }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>The Good Day</title></head>
<body style="margin:0;padding:0;background:#f3f6f8;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f3f6f8;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f6f8;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:${spruce};padding:26px 28px 22px;font-family:${FONT};">
<p style="margin:0 0 6px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a9c7b8;font-weight:bold;">${esc(eyebrow)}</p>
<p style="margin:0;font-family:${DISPLAY};font-size:44px;line-height:1;font-weight:bold;text-transform:uppercase;color:#eef6f2;">The Good Day</p>
<p style="margin:8px 0 0;font-size:14px;color:#a9c7b8;">For ski area owners, GMs and patrol directors. Every other week.</p>
</td></tr>
<tr><td style="padding:28px;font-family:${FONT};font-size:17px;line-height:1.55;color:${ink};">${body}</td></tr>
<tr><td style="padding:18px 28px 26px;border-top:1px solid #d3dde5;font-family:${FONT};font-size:13px;line-height:1.5;color:#4d5f6e;">${foot}</td></tr>
</table></td></tr></table></body></html>`;
}
const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;"><tr><td style="background:${amber};border-radius:999px;">
<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:17px;font-weight:bold;color:${ink};text-decoration:none;border-radius:999px;">${esc(label)}</a></td></tr></table>`;
const p = (t) => `<p style="margin:0 0 14px;">${t}</p>`;
const unsubHeaders = (url) => [{ Name: 'List-Unsubscribe', Value: `<${url}>, <mailto:${config.site.helloEmail}?subject=unsubscribe>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }];
const footHtml = (unsubUrl, postal, why) => `${esc(why)} <a href="${esc(unsubUrl)}" style="color:#1d5b47;">Unsubscribe</a> in one click.${postal ? `<br>Verdynt/OS, ${esc(postal)}` : ''}`;
const footText = (unsubUrl, postal, why) => `${why}\nUnsubscribe: ${unsubUrl}${postal ? `\nVerdynt/OS, ${postal}` : ''}`;
const hi = (name) => (name ? `Hi ${String(name).split(/\s+/)[0]},` : 'Hello,');

function confirmEmail({ name, url }) {
  const subject = 'Confirm your subscription to The Good Day';
  const html = shell({
    preheader: 'One tap to confirm, and Issue 1 is on its way.', eyebrow: 'Confirm your email',
    body: p(esc(hi(name))) + p('Thanks for signing up for The Good Day. Tap the button to confirm it was you, and Issue 1 is on its way.') + button(url, 'Yes, subscribe me')
      + p(`<span style="font-size:14px;color:#4d5f6e;">The link works for ${CONFIRM_DAYS} days. If you did not sign up, ignore this email and nothing more is sent.</span>`),
    foot: 'You are getting this one email because someone entered this address on the Verdynt/OS website.',
  });
  const text = `${hi(name)}\n\nThanks for signing up for The Good Day. Open this link to confirm it was you, and Issue 1 is on its way:\n${url}\n\nThe link works for ${CONFIRM_DAYS} days. If you did not sign up, ignore this email and nothing more is sent.\n\nThe Good Day, from Verdynt/OS`;
  return { subject, html, text };
}

function welcomeEmail({ name, origin, unsubUrl, postal }) {
  const first = issues().slice(-1)[0];
  const read = first ? `${origin}/good-day/issue-${first.n}` : `${origin}/good-day`;
  const subject = 'Welcome to The Good Day';
  const why = 'You subscribed to The Good Day on the Verdynt/OS website.';
  const html = shell({
    preheader: first ? `Start with Issue ${first.n}: ${first.question}` : 'The first issue is on its way.', eyebrow: 'Welcome',
    body: p(esc(hi(name))) + p('You are in. A guest\'s day on your mountain is six moments: Plan, Arrive, Learn, Ride, Get help and Come back. Every other week, The Good Day takes one of them apart: the question in the guest\'s head, the process behind the answer, one number to watch and a quick test.')
      + (first ? p(`Start with Issue ${first.n}, on ${esc(first.moment)}: <strong>${esc(first.question)}</strong>`) + button(read, `Read Issue ${first.n}`) : '')
      + p('One ask: reply and tell me which moment of your guest\'s day is hardest right now. I read every reply.') + p('Dan<br><span style="color:#4d5f6e;">Verdynt/OS</span>'),
    foot: footHtml(unsubUrl, postal, why),
  });
  const text = `${hi(name)}\n\nYou are in. A guest's day on your mountain is six moments: Plan, Arrive, Learn, Ride, Get help and Come back. Every other week, The Good Day takes one of them apart.\n\n${first ? `Start with Issue ${first.n}, on ${first.moment}: ${first.question}\n${read}\n\n` : ''}One ask: reply and tell me which moment of your guest's day is hardest right now. I read every reply.\n\nDan\nVerdynt/OS\n\n--\n${footText(unsubUrl, postal, why)}`;
  return { subject, html, text };
}

/** An issue's email: a short teaser of the page, not the page. */
function issueEmail({ i, subject, intro, origin, unsubUrl, postal }) {
  const read = `${origin}/good-day/issue-${i.n}`;
  const why = 'You subscribed to The Good Day on the Verdynt/OS website.';
  const introHtml = intro ? String(intro).trim().split(/\n{2,}/).map((x) => p(esc(x).replace(/\n/g, '<br>'))).join('') : '';
  const html = shell({
    preheader: i.lines[0] || i.teaser, eyebrow: `Issue ${i.n} · ${i.moment} · ${dayText(i.date)}`,
    body: `<p style="margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#1d5b47;font-weight:bold;">Moment ${i.moment_no} of 6: ${esc(i.moment)}</p>
<p style="margin:0 0 18px;font-family:${DISPLAY};font-size:34px;line-height:1.05;font-weight:bold;text-transform:uppercase;color:${ink};">${esc(i.question)}</p>
${introHtml}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 4px;">${i.lines.map((l) => `<tr><td valign="top" style="padding:4px 10px 4px 0;color:#b45309;font-size:16px;">&#9670;</td><td style="padding:4px 0;font-size:17px;line-height:1.5;color:${ink};">${esc(l)}</td></tr>`).join('')}</table>
${button(read, `Read Issue ${i.n}`)}`,
    foot: footHtml(unsubUrl, postal, why),
  });
  const text = `THE GOOD DAY\nIssue ${i.n} · ${i.moment} · ${dayText(i.date)}\n\n${i.question}\n\n${intro ? `${String(intro).trim()}\n\n` : ''}${i.lines.map((l) => `- ${l}`).join('\n')}\n\nRead Issue ${i.n}: ${read}\n\n--\n${footText(unsubUrl, postal, why)}`;
  return { subject, html, text };
}

const fromName = async () => (await settings()).from_name || 'The Good Day';
const sendFrom = () => (process.env.GOODDAY_FROM ? { fromAddress: process.env.GOODDAY_FROM } : {});

// ---------------------------------------------------------------- sign-up, confirm, unsubscribe
/**
 * A sign-up from the website. Always resolves to the same thing, whatever the address's state, and sends any email
 * after the database work, in the background, so neither the answer nor its timing says who is subscribed.
 * Returns the email to send (or null), for the caller to hand to deliverLater().
 */
async function subscribe({ email, name, role, source, ip, origin }) {
  const addr = String(email).trim().toLowerCase();
  const wording = `${CONSENT} (Signed up on: ${String(source || 'website').slice(0, 40)})`;
  return tx(async (conn) => {
    const s = await one(conn, 'SELECT id, status, name, confirm_sent_at, confirm_sent_at > UTC_TIMESTAMP() - INTERVAL ? MINUTE AS recent FROM goodday_subscribers WHERE email = ? FOR UPDATE', [RESEND_MINUTES, addr]);
    let id;
    if (!s) {
      const [r] = await conn.query(`INSERT INTO goodday_subscribers (email, name, role, status, source, consent_at, consent_wording, consent_ip, confirm_sent_at)
        VALUES (?, ?, ?, 'pending', ?, UTC_TIMESTAMP(), ?, ?, UTC_TIMESTAMP())`, [addr, name || null, role || 'other', source || null, wording, ip || null]);
      id = r.insertId;
    } else if (s.status === 'confirmed') {
      return null; // already on the list: nothing to do, and nothing to say
    } else {
      if (s.recent) return null; // a link went a few minutes ago: no second email, so the form cannot be used to flood an inbox
      // pending again, or back after unsubscribing: the new consent replaces the old, and a new link goes
      await conn.query(`UPDATE goodday_subscribers SET status = 'pending', name = COALESCE(?, name), role = IF(? IS NULL, role, ?), source = ?, consent_at = UTC_TIMESTAMP(), consent_wording = ?, consent_ip = ?,
        confirm_sent_at = UTC_TIMESTAMP(), unsubscribed_at = NULL, unsubscribe_how = NULL WHERE id = ?`, [name || null, role || null, role || null, source || null, wording, ip || null, s.id]);
      id = s.id;
    }
    const token = await mint(conn, id, 'confirm');
    return { to: addr, ...confirmEmail({ name: name || (s && s.name), url: `${origin}/good-day/confirm/${token}` }), tag: 'goodday-confirm' };
  });
}

/** Sends an email without making the caller wait (the website's answer goes first). Failures are logged by the mailer. */
function deliverLater(mail) {
  if (!mail) return;
  setImmediate(async () => {
    try { await mailer.sendPlatform({ ...mail, fromName: await fromName(), ...sendFrom() }); } catch (_) { /* logged by the mailer */ }
  });
}

/**
 * The link in the confirmation email. Confirms a pending sign-up once and sends the welcome (once, ever).
 * Returns 'confirmed' | 'already' | 'expired' | 'invalid' | 'unsubscribed'.
 */
async function confirm(token, { ip, origin }) {
  const t = await find(token, 'confirm');
  if (!t) return { state: 'invalid' };
  if (t.status === 'confirmed') return { state: 'already', email: masked(t.email) };
  if (Number(t.expired)) return { state: 'expired' };
  // An unsubscribe after this link was sent wins: an old confirmation link does not sign someone back up.
  if (t.status === 'unsubscribed') return { state: 'unsubscribed' };
  const welcome = await tx(async (conn) => {
    const [r] = await conn.query("UPDATE goodday_subscribers SET status = 'confirmed', confirmed_at = UTC_TIMESTAMP(), confirmed_ip = ? WHERE id = ? AND status = 'pending'", [ip || null, t.id]);
    await conn.query('UPDATE goodday_tokens SET used_at = COALESCE(used_at, UTC_TIMESTAMP()) WHERE id = ?', [t.token_id]);
    if (r.affectedRows !== 1) return null;
    const [w] = await conn.query('UPDATE goodday_subscribers SET welcome_sent_at = UTC_TIMESTAMP() WHERE id = ? AND welcome_sent_at IS NULL', [t.id]);
    if (w.affectedRows !== 1) return null;
    const unsub = `${origin}/good-day/unsubscribe/${await mint(conn, t.id, 'unsubscribe')}`;
    return { to: t.email, ...welcomeEmail({ name: t.name, origin, unsubUrl: unsub, postal: (await settings()).postal_address }), headers: unsubHeaders(unsub), stream: 'broadcast', tag: 'goodday-welcome' };
  });
  deliverLater(welcome);
  return { state: 'confirmed', email: masked(t.email) };
}

/** The unsubscribe page, before the button: is the link good, and whose is it (masked)? */
async function peekUnsubscribe(token) {
  const t = await find(token, 'unsubscribe');
  if (!t) return { state: 'invalid' };
  return { state: t.status === 'unsubscribed' ? 'already' : 'ready', email: masked(t.email) };
}

/** Unsubscribes for good (until they sign up again). how: 'page' or 'one-click' (a mail app's button). */
async function unsubscribe(token, how = 'page') {
  const t = await find(token, 'unsubscribe');
  if (!t) return { state: 'invalid' };
  const [r] = await pool.query("UPDATE goodday_subscribers SET status = 'unsubscribed', unsubscribed_at = UTC_TIMESTAMP(), unsubscribe_how = ? WHERE id = ? AND status <> 'unsubscribed'", [how, t.id]);
  return { state: r.affectedRows ? 'unsubscribed' : 'already', email: masked(t.email) };
}

// ---------------------------------------------------------------- the console
async function counts() {
  const r = await rows(pool, 'SELECT status, COUNT(*) AS n FROM goodday_subscribers GROUP BY status');
  const out = { pending: 0, confirmed: 0, unsubscribed: 0 };
  for (const x of r) out[x.status] = Number(x.n);
  const roles = await rows(pool, "SELECT role, COUNT(*) AS n FROM goodday_subscribers WHERE status = 'confirmed' GROUP BY role");
  out.roles = Object.fromEntries(Object.keys(ROLES).map((k) => [k, Number((roles.find((x) => x.role === k) || { n: 0 }).n)]));
  return out;
}

async function subscribers({ status, q, limit = 500 } = {}) {
  const where = []; const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (q) { where.push('(email LIKE ? OR name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return rows(pool, `SELECT id, email, name, role, status, source, consent_at, consent_wording, consent_ip, confirmed_at, unsubscribed_at, unsubscribe_how, created_at
    FROM goodday_subscribers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${Math.min(Number(limit) || 500, 50000)}`, args);
}

/** Per issue: how many got it, how many failed, how many are still waiting (confirmed but not sent). */
async function issueStatus() {
  const [[conf]] = await pool.query("SELECT COUNT(*) AS n FROM goodday_subscribers WHERE status = 'confirmed'");
  const d = await rows(pool, 'SELECT issue_no, status, COUNT(*) AS n FROM goodday_deliveries GROUP BY issue_no, status');
  const waiting = await rows(pool, `SELECT d.issue_no, COUNT(*) AS n FROM goodday_subscribers s JOIN (SELECT DISTINCT issue_no FROM goodday_deliveries) d
    LEFT JOIN goodday_deliveries x ON x.issue_no = d.issue_no AND x.subscriber_id = s.id WHERE s.status = 'confirmed' AND x.id IS NULL GROUP BY d.issue_no`);
  const sends = await rows(pool, 'SELECT id, issue_no, subject, started_by, sent, failed, skipped, left_over, created_at, finished_at FROM goodday_sends ORDER BY id DESC LIMIT 50');
  return issues().map((i) => {
    const of = (st) => Number((d.find((x) => x.issue_no === i.n && x.status === st) || { n: 0 }).n);
    const started = d.some((x) => x.issue_no === i.n);
    return { ...i, sent: of('sent'), failed: of('failed'), sending: of('sending'), waiting: started ? Number((waiting.find((x) => x.issue_no === i.n) || { n: 0 }).n) : Number(conf.n), history: sends.filter((s) => s.issue_no === i.n) };
  });
}

function preview({ n, subject, intro, origin, postal }) {
  const i = issue(n);
  if (!i) return null;
  return issueEmail({ i, subject: subject || defaultSubject(i), intro, origin, unsubUrl: `${origin}/good-day/unsubscribe/preview`, postal });
}
const defaultSubject = (i) => `The Good Day, Issue ${i.n}: ${i.question}`;

async function sendTest({ n, subject, intro, to, origin }) {
  const i = issue(n);
  if (!i) return { ok: false, error: 'That issue is not in the list' };
  const s = await settings();
  const m = issueEmail({ i, subject: `[Test] ${subject || defaultSubject(i)}`, intro, origin, unsubUrl: `${origin}/good-day/unsubscribe/test-only`, postal: s.postal_address });
  return mailer.sendPlatform({ to, ...m, stream: 'broadcast', tag: 'goodday-test', fromName: s.from_name, ...sendFrom() });
}

/**
 * Sends issue n to every confirmed subscriber who has not had it, in batches of 50, up to `limit` this time (press
 * Send again for the rest). Each subscriber is claimed first (a unique row per issue and subscriber), so a second press,
 * or a second operator at the same moment, never sends anyone the same issue twice. A failed copy is tried again on the
 * next press; one that was claimed and never finished (the service stopped mid-send) stays as it is, never doubled.
 */
async function sendAll({ n, subject, intro, origin, operator, limit = 2000 }) {
  const i = issue(n);
  if (!i) return { ok: false, error: 'That issue is not in the list' };
  if (!mailer.enabled()) return { ok: false, error: 'Email is not set up (POSTMARK_SERVER_TOKEN and MAIL_FROM)' };
  const s = await settings();
  if (!s.postal_address) return { ok: false, error: 'Add your postal address first. Every issue must carry it.' };
  const subj = subject || defaultSubject(i);
  const [ins] = await pool.query('INSERT INTO goodday_sends (issue_no, subject, intro, started_by) VALUES (?, ?, ?, ?)', [i.n, subj, intro || null, operator || null]);
  const sendId = ins.insertId;
  const todo = await rows(pool, `SELECT s.id, s.email FROM goodday_subscribers s LEFT JOIN goodday_deliveries d ON d.issue_no = ? AND d.subscriber_id = s.id
    WHERE s.status = 'confirmed' AND (d.id IS NULL OR d.status = 'failed') ORDER BY s.id LIMIT ${Math.max(1, Math.min(Number(limit) || 2000, 10000))}`, [i.n]);
  const out = { sent: 0, failed: 0, skipped: 0 };
  for (let k = 0; k < todo.length; k += BATCH) {
    for (const sub of todo.slice(k, k + BATCH)) {
      // claim: a new row, or a failed one taken back; anything else is someone else's (or already sent)
      const [a] = await pool.query("INSERT IGNORE INTO goodday_deliveries (issue_no, subscriber_id, send_id, status) VALUES (?, ?, ?, 'sending')", [i.n, sub.id, sendId]);
      const claimed = a.affectedRows === 1 || (await pool.query("UPDATE goodday_deliveries SET status = 'sending', send_id = ?, error = NULL WHERE issue_no = ? AND subscriber_id = ? AND status = 'failed'", [sendId, i.n, sub.id]))[0].affectedRows === 1;
      // still confirmed? (someone may have unsubscribed a second ago)
      const still = claimed && await one(pool, "SELECT 1 AS ok FROM goodday_subscribers WHERE id = ? AND status = 'confirmed'", [sub.id]);
      if (!claimed || !still) {
        if (claimed) await pool.query('DELETE FROM goodday_deliveries WHERE issue_no = ? AND subscriber_id = ? AND status = \'sending\'', [i.n, sub.id]);
        out.skipped += 1; continue;
      }
      const unsub = `${origin}/good-day/unsubscribe/${await mint(pool, sub.id, 'unsubscribe')}`;
      const m = issueEmail({ i, subject: subj, intro, origin, unsubUrl: unsub, postal: s.postal_address });
      const r = await mailer.sendPlatform({ to: sub.email, ...m, headers: unsubHeaders(unsub), stream: 'broadcast', tag: `goodday-issue-${i.n}`, fromName: s.from_name, ...sendFrom() });
      await pool.query('UPDATE goodday_deliveries SET status = ?, message_id = ?, error = ?, sent_at = IF(? = \'sent\', UTC_TIMESTAMP(), NULL) WHERE issue_no = ? AND subscriber_id = ?',
        [r.ok ? 'sent' : 'failed', r.ok ? String(r.id || '').slice(0, 100) : null, r.ok ? null : String(r.error || '').slice(0, 200), r.ok ? 'sent' : 'failed', i.n, sub.id]);
      out[r.ok ? 'sent' : 'failed'] += 1;
    }
  }
  const [[left]] = await pool.query(`SELECT COUNT(*) AS n FROM goodday_subscribers s LEFT JOIN goodday_deliveries d ON d.issue_no = ? AND d.subscriber_id = s.id
    WHERE s.status = 'confirmed' AND (d.id IS NULL OR d.status = 'failed')`, [i.n]);
  out.left = Number(left.n);
  await pool.query('UPDATE goodday_sends SET sent = ?, failed = ?, skipped = ?, left_over = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?', [out.sent, out.failed, out.skipped, out.left, sendId]);
  return { ok: true, send_id: sendId, ...out };
}

module.exports = {
  MOMENTS, ROLES, CONSENT, catalog, issues, issue, latest, longDate, meta, momentStrip, form, card, footerLine, archive,
  subscribe, deliverLater, confirm, peekUnsubscribe, unsubscribe, masked, looksLikeToken,
  settings, counts, subscribers, issueStatus, preview, sendTest, sendAll, defaultSubject, confirmEmail, welcomeEmail, issueEmail,
};
