'use strict';

// Emails to people who start a demo mountain, written as personal notes from the founder (SITE_FOUNDER_NAME), replies to
// hello@. Three at most: the welcome as the demo is built (a sign-in link, three things to try, what Verdynt/OS is), a
// nudge about a part they have not opened yet (day 2, from the daily job), and a note before the demo ends. Each has a
// stop link. Nobody who has since asked for a walkthrough or a trial gets the follow-ups.
//
// The sign-in link carries the demo's id and a keyed signature over it and the demo's open_nonce, so the same link can
// be sent again in a later email, and the console's "Send sign-in link" retires every older link by changing the nonce.
const crypto = require('crypto');
const config = require('../config');
const { pool, rows, one } = require('../db');
const mailer = require('./mailer');
const { logFailure } = require('./jobs');

const sig = (kind, id, nonce) => crypto.createHmac('sha256', config.jwtSecret).update(`demo-${kind}:${id}:${nonce || ''}`).digest('base64url').slice(0, 40);
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** A fresh nonce for this demo (retires earlier links) and the token to send. */
async function newOpenToken(signupId) {
  const nonce = crypto.randomBytes(8).toString('hex');
  await pool.query('UPDATE sandbox_signups SET open_nonce = ? WHERE id = ?', [nonce, signupId]);
  return `${signupId}.${sig('open', signupId, nonce)}`;
}
const tokenFor = (s) => (s.open_nonce ? `${s.id}.${sig('open', s.id, s.open_nonce)}` : null);

/** The demo a sign-in token opens, if the demo is still running; null otherwise. */
async function signupForToken(token) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{40})$/.exec(String(token || ''));
  if (!m) return null;
  const s = await one(pool, `SELECT s.*, t.slug FROM sandbox_signups s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.id = ? AND s.ended_at IS NULL AND t.sandbox_expires_at > NOW()`, [Number(m[1])]);
  if (!s || !s.open_nonce || !same(m[2], sig('open', s.id, s.open_nonce))) return null;
  return s;
}

const stopToken = (id) => `${id}.${sig('stop', id, '')}`;
async function stop(token) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{40})$/.exec(String(token || ''));
  if (!m || !same(m[2], sig('stop', Number(m[1]), ''))) return false;
  await pool.query('UPDATE sandbox_signups SET emails_stopped_at = COALESCE(emails_stopped_at, UTC_TIMESTAMP()) WHERE id = ?', [Number(m[1])]);
  return true;
}

// ---------------------------------------------------------------- the words
const appBase = (base) => config.site.appUrl || base;
const siteBase = (base) => (config.site.hosts.length ? `https://${config.site.hosts[0]}` : `${base}/site`);
const openUrl = (base, token, to) => `${appBase(base)}/try?open=${encodeURIComponent(token)}${to ? `&to=${to}` : ''}`;
const firstName = (s) => String(s.name || '').trim().split(/\s+/)[0] || 'there';
const dayName = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });

async function fromPrice() {
  const r = await one(pool, "SELECT MIN(monthly_cents) AS c FROM billing_plans WHERE kind = 'plan' AND active = 1 AND code <> 'patrol-only'").catch(() => null);
  return r && r.c ? `$${Math.round(Number(r.c) / 100)}` : null;
}

function signature() {
  return `${config.site.founderFirst}\n\n${config.site.founderName}\nVerdynt/OS\n${config.site.helloEmail}`;
}
const footer = (base, s) => `\n\n--\nYou are getting this because you started a demo at Verdynt/OS. No more emails about it: ${appBase(base)}/try?stop=${stopToken(s.id)}`;

async function welcomeText(base, s, token) {
  const from = await fromPrice();
  return {
    subject: `Your demo mountain is ready, ${firstName(s)}`,
    text: `Hi ${firstName(s)},

Thanks for trying Verdynt/OS. Your demo mountain, ${s.mountain}, is ready and stays open until ${dayName(s.expires_at)}.

This link signs you straight in, from any computer or phone:
${openUrl(base, token)}

Keep it to yourself, since it opens your demo. If you'd rather use a password, set one under Account once you're in.

Three things I'd try first:

1. Sell a lift ticket in Sell, then scan it at the Gate.
2. Put a lift on hold in Mountain status, and watch the public conditions page change.
3. Open Patrol on your phone and start a case, the way a patroller would on the hill.

Today has guided tours if you'd like a walk through each part. Everything in the demo is made up, and email and card payments are switched off.

In short, Verdynt/OS runs the whole day at an independent ski area in one place: tickets and the gate, rentals, ski school and programs, lifts and trails, maintenance, patrol and staff. You turn on only the parts you run, prices are published${from ? ` (from ${from} a month)` : ''}, and every plan starts with a 14-day free trial on your own mountain. Founding mountains also pay half in their first season.

If you'd like me to walk you through it with your own mountain in mind, just reply and we'll find a time.

${signature()}${footer(base, s)}`,
  };
}

// The parts a nudge can point at, in the order worth showing: the area name the demo's requests are counted under, the
// screen to open, and why it is worth a look.
const NUDGES = [
  { area: 'patrol', to: 'patrol', name: 'Patrol', why: 'It\'s the part patrol directors ask about most: patient care reports on a phone, dispatch, the closing sweep, and records that hold up when a lawyer asks.' },
  { area: 'tickets', to: 'gate', name: 'the Gate', why: 'Sell a ticket, then scan it. Scan it again straight after and it warns you, which is how a pass handed back over the fence gets caught.' },
  { area: 'ops', to: 'conditions', name: 'Mountain status', why: 'Lift and trail status, grooming and the morning lift checks, with your public conditions page updating within a minute.' },
  { area: 'skischool', to: 'school', name: 'Ski school', why: 'Lessons, instructors and online booking, with each student\'s report card building as they go.' },
  { area: 'programs', to: 'programs', name: 'Programs', why: 'Multi-week lesson programs with weekday groups, makeup weeks, sibling discounts and a family page for parents.' },
  { area: 'rentals', to: 'rentals', name: 'Rentals', why: 'Rental contracts with sizing and binding records, and barcoded gear in and out.' },
];

async function nudgeText(base, s) {
  const used = new Set((await rows(pool, 'SELECT area FROM sandbox_usage WHERE signup_id = ? AND requests > 0', [s.id])).map((r) => r.area));
  const pick = NUDGES.find((n) => !used.has(n.area));
  const token = tokenFor(s);
  if (!pick) {
    return { subject: 'How is the demo going?', text: `Hi ${firstName(s)},

I can see you've been all over ${s.mountain}, which is great. Is there anything that didn't work the way your mountain does it? That's the most useful thing I can hear.

If it would help to see it with your own lifts, products and staff, reply and we'll set up a walkthrough. Your demo is here when you want it:
${openUrl(base, token)}

${signature()}${footer(base, s)}` };
  }
  return {
    subject: `One part of your demo worth a look: ${pick.name}`,
    text: `Hi ${firstName(s)},

Quick note: you haven't opened ${pick.name} in ${s.mountain} yet. ${pick.why}

This link signs you in and takes you straight there:
${openUrl(base, token, pick.to)}

Any questions, just reply.

${signature()}${footer(base, s)}`,
  };
}

async function endingText(base, s) {
  return {
    subject: `Your demo ends ${new Date(s.expires_at).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' })}`,
    text: `Hi ${firstName(s)},

Your demo mountain, ${s.mountain}, closes on ${dayName(s.expires_at)}, and everything in it is deleted then.

If it looks like a fit, there are two easy next steps:

1. Reply to this email and we'll set up a walkthrough with your own mountain in mind.
2. Or ask for a 14-day free trial on your real mountain, set up with your lifts and products: ${siteBase(base)}/contact

Either way I'd like to hear what you thought, good or bad.

${signature()}${footer(base, s)}`,
  };
}

async function send(s, { subject, text }, tag) {
  return mailer.sendPlatform({ to: s.email, fromName: config.site.founderName, fromAddress: config.site.demoFrom || undefined, replyTo: config.site.helloEmail, subject, text, tag });
}

/** The welcome, right after a demo is built. Never throws: a demo works without it. */
async function welcome(base, signupId) {
  try {
    const s = await one(pool, 'SELECT * FROM sandbox_signups WHERE id = ?', [signupId]);
    if (!s) return false;
    const token = await newOpenToken(s.id);
    const r = await send(s, await welcomeText(base, s, token), 'demo-welcome');
    if (r.ok) await pool.query('UPDATE sandbox_signups SET welcome_sent_at = UTC_TIMESTAMP() WHERE id = ?', [s.id]);
    return r.ok;
  } catch (err) { logFailure({ job: 'demo_welcome', message: err.message }); return false; }
}

/** From the console: a new sign-in link, retiring the old ones. */
async function sendLink(base, signupId) {
  const s = await one(pool, `SELECT s.* FROM sandbox_signups s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ? AND s.ended_at IS NULL AND t.sandbox_expires_at > NOW()`, [signupId]);
  if (!s) return { ok: false, error: 'That demo has ended' };
  const token = await newOpenToken(s.id);
  return send(s, { subject: 'Your sign-in link for the Verdynt/OS demo', text: `Hi ${firstName(s)},

Here's a new link to your demo mountain, ${s.mountain}. It signs you straight in, and it works until the demo ends on ${dayName(s.expires_at)}:
${openUrl(base, token)}

Any links I sent before no longer work.

${signature()}${footer(base, s)}` }, 'demo-link');
}

// Follow-ups go only to running demos whose owner has not stopped them, and not to anyone who has since asked us for a
// walkthrough or a trial (a lead with the same email made after the demo started).
const ELIGIBLE = `s.ended_at IS NULL AND s.emails_stopped_at IS NULL AND s.welcome_sent_at IS NOT NULL AND s.tenant_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM site_leads l WHERE l.email = s.email AND l.created_at >= s.at)`;

/** The daily job: day-2 nudges and before-it-ends notes. Each email is claimed before it is sent, so none goes twice. */
async function runAll(base) {
  const out = { nudges: 0, endings: 0, failed: 0 };
  const ending = await rows(pool, `SELECT s.* FROM sandbox_signups s WHERE ${ELIGIBLE} AND s.ending_sent_at IS NULL
    AND s.expires_at BETWEEN UTC_TIMESTAMP() AND UTC_TIMESTAMP() + INTERVAL 60 HOUR AND s.at <= UTC_TIMESTAMP() - INTERVAL 72 HOUR`);
  for (const s of ending) {
    const [c] = await pool.query('UPDATE sandbox_signups SET ending_sent_at = UTC_TIMESTAMP(), nudge_sent_at = COALESCE(nudge_sent_at, UTC_TIMESTAMP()) WHERE id = ? AND ending_sent_at IS NULL', [s.id]);
    if (!c.affectedRows) continue;
    const r = await send(s, await endingText(base, s), 'demo-ending');
    if (r.ok) out.endings += 1; else out.failed += 1;
  }
  const nudge = await rows(pool, `SELECT s.* FROM sandbox_signups s WHERE ${ELIGIBLE} AND s.nudge_sent_at IS NULL AND s.ending_sent_at IS NULL
    AND s.at <= UTC_TIMESTAMP() - INTERVAL 40 HOUR AND s.expires_at > UTC_TIMESTAMP() + INTERVAL 60 HOUR`);
  for (const s of nudge) {
    const [c] = await pool.query('UPDATE sandbox_signups SET nudge_sent_at = UTC_TIMESTAMP() WHERE id = ? AND nudge_sent_at IS NULL', [s.id]);
    if (!c.affectedRows) continue;
    const r = await send(s, await nudgeText(base, s), 'demo-nudge');
    if (r.ok) out.nudges += 1; else out.failed += 1;
  }
  return out;
}

module.exports = { welcome, sendLink, runAll, signupForToken, stop, stopToken, newOpenToken, NUDGES };
