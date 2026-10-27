'use strict';

// Prospect outreach from the platform console. An operator starts outreach to a person at a prospect; the first email
// is drafted (by the model when the assistant is on, otherwise from the template) and waits for the operator to approve
// it. Then the follow-ups go on their own on the cadence (days 0, 7, 16, 30 and 45 unless changed), each in the same
// thread, and after the fifth a short update goes every 90 days.
//
// It stops for good when the person replies, the email bounces, they choose "not interested" (the link in every email,
// or their mail app's unsubscribe button), the prospect moves to a stage where we are talking or done, or an operator
// stops it. "Not interested" and bounces go on a permanent suppression list: that address is never emailed again.
//
// Every email carries the sender's name, company and postal address and the opt-out link (CAN-SPAM). It sends from the
// operator's own mailbox (lib/gmail.js), only on weekdays inside the sending hours, and never more than the daily cap.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool, rows, one } = require('../db');
const config = require('../config');
const gmail = require('./gmail');

const STEPS = 5; // the sequence; step 6 is the quarterly update
const NURTURE = 6;
const STOP_STAGES = ['talking', 'demo', 'trial', 'won', 'lost', 'not_fit'];
const OPEN = ['pending', 'active', 'nurture'];

const DEFAULT_TEMPLATES = {
  1: { subject: 'If a guest from last February sued tomorrow', body: `Hi {first_name},

If a guest from last February sued {mountain} tomorrow, how long would it take to pull together everything about that day?

I'm {sender_first}, and I build Verdynt/OS for independent ski areas. Patrol writes the report at the bedside, time-stamped and never deleted, and the case picks up the rental binding record, the morning's grooming and the lift's status by itself. The claim file is one click.

Would a 20-minute look be useful? If patrol is the bigger need, it is also sold on its own, from {patrol_price} a month.

Thanks,
{sender_first}` },
  2: { subject: 'Re: {first_subject}', body: `Hi {first_name},

Following up on my note last week. Something I hear from smaller mountains: patrol reports live on paper or in a separate app, so the incident never meets the rental or lift records.

In Verdynt/OS a patrol report pulls in the rental binding setting, the lift's status and the grooming log by itself, and the owner gets a private staff injury register for work injuries.

Happy to show you in 20 minutes whenever suits.

{sender_first}` },
  3: { subject: 'Re: {first_subject}', body: `Hi {first_name},

One more thought for {mountain}. Getting started takes about a day: we load your products and prices, bring in your roster and pass holders, and train your team on site. Plans start at {price_from} a month, and patrol on its own is {patrol_price} a month.

If it would help, I can set up a demo mountain with {mountain}'s name on it so your team can try it.

{sender_first}` },
  4: { subject: 'Re: {first_subject}', body: `Hi {first_name},

I don't want to crowd your inbox. If someone else at {mountain} looks after systems, the front desk or patrol, could you point me to them?

Otherwise I'll check back once more.

{sender_first}` },
  5: { subject: 'Re: {first_subject}', body: `Hi {first_name},

Last note from me for now. If the timing isn't right this season, no problem. I'll send a short update a few times a year, and you can stop those with the link below.

If a look would help later, just reply to this email.

{sender_first}` },
  6: { subject: 'What is new in Verdynt/OS', body: `Hi {first_name},

A short update from Verdynt/OS, the operations software for independent ski areas. The latest release: {latest_release}.

If {mountain} is looking at systems for next season, I'd be glad to show you. Just reply.

{sender_first}` },
};

const FIELDS = ['first_name', 'mountain', 'town', 'state', 'sender_name', 'sender_first', 'opening', 'first_subject', 'price_from', 'patrol_price', 'latest_release'];
const render = (text, ctx) => String(text).replace(/\{([a-z_]+)\}/g, (m, k) => (FIELDS.includes(k) && ctx[k] !== undefined && ctx[k] !== null ? String(ctx[k]) : m));
const firstOf = (name) => String(name || '').trim().split(/\s+/)[0].replace(/[^A-Za-z'.-]/g, '') || 'there';
const money = (cents) => `$${Math.round(Number(cents) / 100).toLocaleString('en-US')}`;

async function settings(db = pool) {
  let s = await one(db, 'SELECT * FROM outreach_settings WHERE id = 1');
  if (!s) { await db.query('INSERT IGNORE INTO outreach_settings (id) VALUES (1)'); s = await one(db, 'SELECT * FROM outreach_settings WHERE id = 1'); }
  let offsets = [0, 7, 16, 30, 45];
  try { const o = JSON.parse(s.offsets); if (Array.isArray(o) && o.length === STEPS) offsets = o.map(Number); } catch (_) { /* keep the default */ }
  return { ...s, offsets, paused: Boolean(s.paused), use_ai: Boolean(s.use_ai) };
}

async function templates(db = pool) {
  const have = await rows(db, 'SELECT step, subject, body FROM outreach_templates');
  const out = {};
  for (let step = 1; step <= NURTURE; step++) out[step] = have.find((t) => t.step === step) || { step, ...DEFAULT_TEMPLATES[step] };
  return out;
}

let releaseTitle = null;
function latestRelease() {
  if (releaseTitle === null) {
    try { releaseTitle = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'release', 'changelog.json'), 'utf8')).releases[0].title; } catch (_) { releaseTitle = 'new features every week'; }
  }
  return releaseTitle;
}

async function contextFor(db, seq, s) {
  const p = await one(db, 'SELECT * FROM prospects WHERE id = ?', [seq.prospect_id]);
  const c = await one(db, 'SELECT * FROM prospect_contacts WHERE id = ?', [seq.contact_id]);
  const plans = await rows(db, "SELECT code, kind, monthly_cents FROM billing_plans WHERE kind = 'plan' AND monthly_cents > 0 ORDER BY monthly_cents").catch(() => []);
  const patrol = plans.find((x) => x.code === 'patrol-only');
  const full = plans.filter((x) => x.code !== 'patrol-only');
  const senderName = s.sender_name || 'The Verdynt/OS team';
  return {
    prospect: p, contact: c,
    first_name: firstOf(c && c.name), mountain: p.name, town: p.town || '', state: p.state || '',
    sender_name: senderName, sender_first: firstOf(senderName) === 'there' ? senderName : firstOf(senderName),
    opening: `I'm getting in touch with a handful of mountains like ${p.name}.`,
    first_subject: seq.first_subject || '', price_from: full.length ? money(full[0].monthly_cents) : '$199', patrol_price: patrol ? money(patrol.monthly_cents) : '$149',
    latest_release: latestRelease(),
  };
}

// The opt-out link lives on the app (APP_URL, or the public address Stripe uses when that is set).
const linkBase = () => (config.site.appUrl || (config.stripe && config.stripe.publicUrl) || '').replace(/\/$/, '');
const stopUrl = (seq) => `${linkBase()}/o/${seq.token}`;
function footer(s, seq) {
  return ['', '--', s.sender_name || 'Verdynt/OS', s.company_line || 'Verdynt/OS, operations software for ski areas', s.postal_address || '', '',
    `Not interested? ${stopUrl(seq)} and we won't email you again.`].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}

/**
 * The first email, drafted for this person and mountain. With the assistant on, the model writes it from the facts
 * (never the internal research notes word for word); otherwise the template is used. The operator approves it.
 */
async function draftFirst(db, seq, s) {
  const ctx = await contextFor(db, seq, s);
  const t = (await templates(db))[1];
  const fallback = { subject: render(t.subject, ctx), body: render(t.body, ctx), by: 'template' };
  if (!s.use_ai || !config.assistant || !config.assistant.on) return fallback;
  const p = ctx.prospect; const c = ctx.contact;
  const facts = [
    `Ski area: ${p.name}${p.town ? `, ${p.town}` : ''}${p.state ? `, ${p.state}` : ''}`,
    p.ownership ? `Ownership: ${p.ownership}` : null,
    [p.vertical_ft ? `${p.vertical_ft} ft vertical` : null, p.lifts ? `${p.lifts} lifts` : null].filter(Boolean).join(', ') || null,
    p.patrol ? `Patrol: ${p.patrol}` : null,
    p.fit_notes ? `Our notes (private; use only to choose an angle, never quote or mention research): ${p.fit_notes}` : null,
    `Recipient: ${c.name || 'unknown'}${c.title ? `, ${c.title}` : ''}`,
  ].filter(Boolean).join('\n');
  try {
    const out = await require('./assistant').callModel({
      model: config.assistant.model,
      system: `You write the first cold email from ${ctx.sender_name}, who builds Verdynt/OS: operations software for independent ski areas (tickets and passes, rentals, ski school, staff scheduling, and a deep ski patrol module: patient care reports that work offline, dispatch, crews, kits; patrol is also sold alone). Write in plain US English, warm and direct, like one person writing to another. Under 130 words. Open with the question this pitch is built on, adapted to them: if a guest from last season sued tomorrow, how long would it take to pull together everything about that day? Then, using one specific, true detail about this mountain from the facts where it fits, say what Verdynt/OS keeps: the report written at the bedside, time-stamped and never deleted, the rental binding record, the morning's grooming and the lift's status attached to the case by themselves, and a one-click claim file. End with one easy ask (a 20-minute look). Never claim it wins lawsuits or lowers insurance premiums. No flattery, no hype words, no em dashes, no links, no sign-off beyond "${ctx.sender_first}". Never mention that you researched them or quote the private notes. Never invent facts. Reply with JSON only: {"subject": "...", "body": "..."} where body starts with "Hi ${ctx.first_name},".`,
      messages: [{ role: 'user', content: facts }],
    });
    const text = ((out.content || []).find((b) => b.type === 'text') || {}).text || '';
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!j.subject || !j.body || j.body.length > 2000) return fallback;
    return { subject: String(j.subject).slice(0, 200), body: String(j.body).replace(/—/g, ', '), by: 'assistant' };
  } catch (_) { return fallback; }
}

const isSuppressed = async (db, email) => Boolean(await one(db, 'SELECT email FROM outreach_suppress WHERE email = ?', [String(email).toLowerCase()]));

/** Starts outreach to one person: a sequence waiting for its first email to be approved. Returns { id } or { skipped }. */
async function enroll(db, contactId, operator) {
  const c = await one(db, 'SELECT * FROM prospect_contacts WHERE id = ?', [contactId]);
  if (!c) return { skipped: 'not found' };
  const email = String(c.email || '').trim().toLowerCase();
  if (!email) return { skipped: 'no email address' };
  if (await isSuppressed(db, email)) return { skipped: 'asked not to be emailed, or bounced' };
  const p = await one(db, 'SELECT id, stage FROM prospects WHERE id = ?', [c.prospect_id]);
  if (STOP_STAGES.includes(p.stage)) return { skipped: 'the prospect is past outreach' };
  if (await one(db, `SELECT id FROM outreach_sequences WHERE email = ? AND status IN (${OPEN.map(() => '?').join(', ')})`, [email, ...OPEN])) return { skipped: 'already in outreach' };
  const token = crypto.randomBytes(16).toString('hex');
  const [r] = await db.query('INSERT INTO outreach_sequences (prospect_id, contact_id, email, token, created_by) VALUES (?, ?, ?, ?, ?)', [p.id, c.id, email, token, operator || null]);
  const seq = await one(db, 'SELECT * FROM outreach_sequences WHERE id = ?', [r.insertId]);
  const d = await draftFirst(db, seq, await settings(db));
  await db.query("INSERT INTO outreach_messages (sequence_id, step, subject, body, status, drafted_by) VALUES (?, 1, ?, ?, 'draft', ?)", [seq.id, d.subject, d.body, d.by]);
  return { id: seq.id };
}

/** The local hour and weekday in the sending time zone. */
function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}` };
}
const inWindow = (s, now) => { const l = localNow(s.timezone, now); return !['Sat', 'Sun'].includes(l.weekday) && l.hour >= s.send_from_hour && l.hour < s.send_to_hour; };

async function note(db, prospectId, kind, body) {
  await db.query('INSERT INTO prospect_notes (prospect_id, kind, body, actor) VALUES (?, ?, ?, ?)', [prospectId, kind, body.slice(0, 4000), 'Outreach']);
}

async function stop(db, seqId, status, reason) {
  await db.query(`UPDATE outreach_sequences SET status = ?, stop_reason = ?, stopped_at = UTC_TIMESTAMP(), next_at = NULL WHERE id = ? AND status IN (${OPEN.map(() => '?').join(', ')})`, [status, reason, seqId, ...OPEN]);
  await db.query("UPDATE outreach_messages SET status = 'skipped' WHERE sequence_id = ? AND status IN ('draft','approved')", [seqId]);
}

/** A prospect moved to a stage where we are talking, or done: its outreach stops. */
async function stopForProspect(db, prospectId, stage) {
  if (!STOP_STAGES.includes(stage)) return 0;
  const open = await rows(db, `SELECT id FROM outreach_sequences WHERE prospect_id = ? AND status IN (${OPEN.map(() => '?').join(', ')})`, [prospectId, ...OPEN]);
  for (const s of open) await stop(db, s.id, 'stopped', `Prospect moved to ${stage}`);
  return open.length;
}

/** The person chose "not interested": never again, at any prospect. */
async function notInterested(db, token) {
  const seq = await one(db, 'SELECT * FROM outreach_sequences WHERE token = ?', [token]);
  if (!seq) return null;
  await db.query("INSERT IGNORE INTO outreach_suppress (email, reason) VALUES (?, 'not_interested')", [seq.email]);
  const open = await rows(db, `SELECT id FROM outreach_sequences WHERE email = ? AND status IN (${OPEN.map(() => '?').join(', ')})`, [seq.email, ...OPEN]);
  for (const s of open) await stop(db, s.id, 'not_interested', 'Chose not interested');
  if (open.length || seq.status !== 'not_interested') {
    await note(db, seq.prospect_id, 'email', `${seq.email} chose "not interested". They will not be emailed again.`);
    await db.query("UPDATE prospects SET stage = 'lost' WHERE id = ? AND stage IN ('research','to_contact','contacted')", [seq.prospect_id]);
  }
  return seq;
}

/** Replies and bounces in the threads still going. Returns how many stopped. */
async function checkThreads(db, t) {
  const me = String(t.sender() || '').toLowerCase();
  const list = await rows(db, "SELECT * FROM outreach_sequences WHERE status IN ('active','nurture') AND thread_id IS NOT NULL ORDER BY id LIMIT 200");
  let stopped = 0;
  for (const seq of list) {
    let msgs;
    try { msgs = await t.thread(seq.thread_id); } catch (_) { continue; }
    const bounce = msgs.find((m) => /mailer-daemon|postmaster/.test(m.from));
    const reply = msgs.find((m) => m.from && !m.from.includes(me) && !/mailer-daemon|postmaster/.test(m.from));
    if (bounce) {
      await stop(db, seq.id, 'bounced', 'The email bounced');
      await db.query("INSERT IGNORE INTO outreach_suppress (email, reason) VALUES (?, 'bounced')", [seq.email]);
      await note(db, seq.prospect_id, 'email', `Outreach to ${seq.email} bounced. Check the address.`);
      stopped += 1;
    } else if (reply) {
      await stop(db, seq.id, 'replied', 'They replied');
      await note(db, seq.prospect_id, 'email', `${seq.email} replied: "${reply.snippet.slice(0, 300)}"`);
      await db.query("UPDATE prospects SET stage = 'talking' WHERE id = ? AND stage IN ('research','to_contact','contacted')", [seq.prospect_id]);
      stopped += 1;
    }
  }
  return stopped;
}

/** Sends what is due, inside the sending hours and under the daily cap. Returns { sent, failed, stopped, waiting }. */
async function runDue({ now = new Date(), db = pool, force = false } = {}) {
  const t = gmail.current();
  if (!t.ready()) return { skipped: 'The outreach mailbox is not connected (OUTREACH_GMAIL_KEY and OUTREACH_SENDER).' };
  if (!linkBase()) return { skipped: 'APP_URL is not set, so emails would have no working opt-out link.' };
  const s = await settings(db);
  const stopped = await checkThreads(db, t);
  if (s.paused) return { skipped: 'Outreach is paused', stopped };
  if (!force && !inWindow(s, now)) return { skipped: 'Outside the sending hours', stopped };
  const [[sentToday]] = await db.query("SELECT COUNT(*) AS n FROM outreach_messages WHERE status = 'sent' AND sent_at > ? AND sent_at <= ?", [new Date(now.getTime() - 24 * 3600_000), now]);
  let room = Math.max(0, s.daily_cap - Number(sentToday.n));
  const due = await rows(db, "SELECT * FROM outreach_sequences WHERE status IN ('active','nurture') AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at LIMIT 500", [now]);
  const tpl = await templates(db);
  let sent = 0; let failed = 0;
  for (const seq of due) {
    if (room <= 0) break;
    if (await isSuppressed(db, seq.email)) { await stop(db, seq.id, 'not_interested', 'On the do-not-email list'); continue; }
    const step = seq.status === 'nurture' ? NURTURE : seq.step + 1;
    let msg;
    if (step === 1) {
      msg = await one(db, "SELECT * FROM outreach_messages WHERE sequence_id = ? AND step = 1 AND status = 'approved' ORDER BY id DESC LIMIT 1", [seq.id]);
      if (!msg) continue;
    } else {
      const ctx = await contextFor(db, seq, s);
      const [r] = await db.query("INSERT INTO outreach_messages (sequence_id, step, subject, body, status) VALUES (?, ?, ?, ?, 'approved')", [seq.id, step, render(tpl[step].subject, ctx), render(tpl[step].body, ctx)]);
      msg = await one(db, 'SELECT * FROM outreach_messages WHERE id = ?', [r.insertId]);
    }
    // Claim it first, so two runs can never send the same email.
    const [claim] = await db.query("UPDATE outreach_messages SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'approved'", [now, msg.id]);
    if (!claim.affectedRows) continue;
    const threaded = step > 1 && step < NURTURE && seq.thread_id;
    try {
      const out = await t.send({ fromName: s.sender_name || 'Verdynt/OS', to: seq.email, subject: msg.subject, text: `${msg.body}\n${footer(s, seq)}`, unsubscribeUrl: stopUrl(seq), threadId: threaded ? seq.thread_id : undefined, inReplyTo: threaded ? seq.first_message_id : undefined });
      await db.query('UPDATE outreach_messages SET gmail_id = ? WHERE id = ?', [out.id, msg.id]);
      const next = step < STEPS ? new Date(new Date(seq.started_at || now).getTime() + s.offsets[step] * 86400_000) : new Date(now.getTime() + s.nurture_days * 86400_000);
      await db.query(`UPDATE outreach_sequences SET step = ?, status = ?, next_at = ?, started_at = COALESCE(started_at, ?), thread_id = ${step === 1 ? '?' : 'COALESCE(thread_id, ?)'}, first_message_id = COALESCE(first_message_id, ?), first_subject = COALESCE(first_subject, ?) WHERE id = ?`,
        [Math.min(step, STEPS), step >= STEPS ? 'nurture' : 'active', next, now, out.threadId || null, step === 1 ? out.messageId : null, step === 1 ? msg.subject : null, seq.id]);
      const c = await one(db, 'SELECT name FROM prospect_contacts WHERE id = ?', [seq.contact_id]);
      await note(db, seq.prospect_id, 'email', `${step === NURTURE ? 'Quarterly update' : `Outreach email ${step} of ${STEPS}`} sent to ${c && c.name ? c.name : seq.email}: ${msg.subject}`);
      if (step === 1) await db.query("UPDATE prospects SET stage = 'contacted' WHERE id = ? AND stage IN ('research','to_contact')", [seq.prospect_id]);
      sent += 1; room -= 1;
    } catch (err) {
      // The first email goes back to approved and is tried again on the next run; a follow-up is written again then.
      await db.query('UPDATE outreach_messages SET status = ?, sent_at = NULL, error = ? WHERE id = ?', [step === 1 ? 'approved' : 'failed', String(err.message).slice(0, 300), msg.id]);
      failed += 1;
    }
  }
  return { sent, failed, stopped, waiting: Math.max(0, due.length - sent - failed) };
}

module.exports = { linkBase, STEPS, NURTURE, STOP_STAGES, DEFAULT_TEMPLATES, FIELDS, render, settings, templates, contextFor, footer, draftFirst, enroll, stop, stopForProspect, notInterested, checkThreads, runDue, inWindow, isSuppressed, stopUrl };
