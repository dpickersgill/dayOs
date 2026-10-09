'use strict';

// Messages to customers. Three rules sit above everything else:
//   1. A campaign goes only to people whose latest answer for that channel is "agreed" (the consent history), once per address.
//   2. Every email carries an unsubscribe link; every text says how to stop. Using it records the opt-out the same minute.
//   3. A message is logged before it counts as sent, and the log is unique, so a retry or a double click cannot send twice.
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const { eachTenant } = require('./jobs');
const config = require('../config');
const mailer = require('./mailer');
const sms = require('./sms');
const { recordConsent } = require('./consent');
const { todayIn, addDays } = require('./util');

const MAX_RECIPIENTS = 1000;
const { esc } = require('./format');
const sandbox = require('./sandbox');
const modules = require('./modules');

const AUDIENCES = [
  { key: 'all', label: 'Everyone who agreed' },
  { key: 'passholders', label: 'Current season pass holders' },
  { key: 'lapsed_passholders', label: 'Lapsed pass holders (had a pass, none now)' },
  { key: 'lesson_students', label: 'Lesson students in the last 12 months' },
];

// ---------------------------------------------------------------- unsubscribe links
const sign = (payload) => crypto.createHmac('sha256', config.linkSecret).update(`unsub:${payload}`).digest('hex').slice(0, 32);
const unsubToken = (tenantId, personId, channel) => { const p = `${tenantId}.${personId}.${channel}`; return `${p}.${sign(p)}`; };
function readUnsub(token) {
  const m = /^(\d{1,12})\.(\d{1,12})\.(email|sms)\.([a-f0-9]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const given = Buffer.from(m[4]); const want = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}`));
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return { tenantId: Number(m[1]), personId: Number(m[2]), channel: m[3] };
}
/** Records the opt-out from an unsubscribe link. Safe to repeat. */
async function unsubscribe({ tenantId, personId, channel }) {
  const p = await one(pool, 'SELECT id, email, marketing_opt_in FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) return false;
  const last = await one(pool, 'SELECT status FROM consent_events WHERE tenant_id = ? AND person_id = ? AND channel = ? ORDER BY id DESC LIMIT 1', [tenantId, personId, channel]);
  if (!last || last.status === 'opted_in') await recordConsent(pool, tenantId, personId, channel, 'opted_out', 'unsubscribe_link', null);
  if (channel === 'email') {
    await pool.query('UPDATE people SET marketing_opt_in = 0 WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
    if (p.email) await pool.query('INSERT IGNORE INTO email_suppressions (tenant_id, email) VALUES (?, ?)', [tenantId, p.email.toLowerCase()]);
  }
  return true;
}

// ---------------------------------------------------------------- who gets a campaign
const AGREED = {
  email: "p.email IS NOT NULL AND p.email <> '' AND (SELECT c.status FROM consent_events c WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.channel = 'email' ORDER BY c.id DESC LIMIT 1) = 'opted_in' AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.tenant_id = p.tenant_id AND s.email = LOWER(p.email))",
  sms: "p.phone_key IS NOT NULL AND CHAR_LENGTH(p.phone_key) = 10 AND (SELECT c.status FROM consent_events c WHERE c.tenant_id = p.tenant_id AND c.person_id = p.id AND c.channel = 'sms' ORDER BY c.id DESC LIMIT 1) = 'opted_in'",
};
const PASS = "t.status = 'active' AND pr.kind = 'season_pass'";
const SEGMENT = {
  all: () => '1 = 1',
  passholders: () => `EXISTS (SELECT 1 FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id WHERE t.tenant_id = p.tenant_id AND t.person_id = p.id AND ${PASS} AND t.valid_from <= ? AND t.valid_to >= ?)`,
  lapsed_passholders: () => `EXISTS (SELECT 1 FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id WHERE t.tenant_id = p.tenant_id AND t.person_id = p.id AND ${PASS} AND t.valid_to < ?)
    AND NOT EXISTS (SELECT 1 FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id WHERE t.tenant_id = p.tenant_id AND t.person_id = p.id AND ${PASS} AND t.valid_to >= ?)`,
  lesson_students: () => "EXISTS (SELECT 1 FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id WHERE b.tenant_id = p.tenant_id AND b.person_id = p.id AND b.status <> 'cancelled' AND s.starts_at >= ?)",
};
const SEGMENT_PARAMS = (key, today) => ({ all: [], passholders: [today, today], lapsed_passholders: [today, today], lesson_students: [addDays(today, -365)] }[key]);

/** The people a campaign would reach right now: one per address, newest record last. */
async function audienceOf(tenant, channel, audience, limit = MAX_RECIPIENTS + 1) {
  if (!SEGMENT[audience]) return [];
  const today = todayIn(tenant.timezone);
  const key = channel === 'email' ? 'LOWER(p.email)' : 'p.phone_key';
  return rows(pool, `SELECT MIN(p.id) AS id, SUBSTRING_INDEX(GROUP_CONCAT(p.first_name ORDER BY p.id), ',', 1) AS first_name, ${channel === 'email' ? 'LOWER(MIN(p.email))' : 'MIN(p.phone)'} AS addr
    FROM people p WHERE p.tenant_id = ? AND p.anonymised_at IS NULL AND ${AGREED[channel]} AND ${SEGMENT[audience]()}
    GROUP BY ${key} ORDER BY MIN(p.id) LIMIT ?`, [tenant.id, ...SEGMENT_PARAMS(audience, today), limit]);
}

// ---------------------------------------------------------------- what the message looks like
const fill = (text, vars) => String(text || '').replace(/\{(first_name|mountain)\}/g, (_, k) => vars[k] || '');
const footerLines = (tenant) => [tenant.name, tenant.address].filter(Boolean).join(', ');

function renderEmail(tenant, campaign, person, base, unsubUrl) {
  const vars = { first_name: person.first_name || 'there', mountain: tenant.name };
  const body = fill(campaign.body, vars);
  const text = `${body}\n\n--\n${footerLines(tenant)}\nYou are getting this because you agreed to hear from us. To stop: ${unsubUrl}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a;line-height:1.55">
${body.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('\n')}
<hr style="border:none;border-top:1px solid #d3dce1;margin:24px 0 12px">
<p style="font-size:12px;color:#55687a">${esc(footerLines(tenant))}<br>You are getting this because you agreed to hear from us. <a href="${esc(unsubUrl)}">Stop these emails</a></p></div>`;
  return { subject: fill(campaign.subject, vars), text, html };
}
const renderSms = (tenant, campaign, person) => `${fill(campaign.body, { first_name: person.first_name || 'there', mountain: tenant.name })}\n${tenant.name}. Reply STOP to opt out.`.slice(0, 640);

const unsubUrl = (base, tenantId, personId, channel) => `${base}/api/v1/public/unsub/${unsubToken(tenantId, personId, channel)}`;

const isSandbox = (tenantId) => sandbox.isSandbox(tenantId);

/** Sends one message and writes its log row. Returns 'sent' | 'failed' | 'duplicate'. Never throws. */
async function deliver({ tenant, campaign, person, kind, refId, channel, build, base }) {
  // A reminder that failed (not a campaign message) may be tried again on the next run.
  // A failed reminder is tried again after an hour; so is a claim left 'sending' by a server that stopped mid-send.
  if (kind !== 'campaign') await pool.query("DELETE FROM message_log WHERE tenant_id = ? AND kind = ? AND ref_id = ? AND person_id = ? AND channel = ? AND status = 'failed' AND created_at < NOW() - INTERVAL 1 HOUR", [tenant.id, kind, refId || 0, person.id, channel]);
  const [claim] = await pool.query(
    "INSERT IGNORE INTO message_log (tenant_id, campaign_id, person_id, kind, ref_id, channel, to_addr, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', 'sending')",
    [tenant.id, campaign ? campaign.id : null, person.id, kind, refId || 0, channel, person.addr],
  );
  if (!claim.affectedRows) return 'duplicate';
  let r;
  if (await isSandbox(tenant.id)) r = { ok: false, error: 'Demo mountains do not send messages' };
  else if (channel === 'email') {
    const m = build();
    r = await mailer.send({ tenantId: tenant.id, stream: kind === 'campaign' ? 'broadcast' : undefined, to: person.addr, fromName: tenant.name, replyTo: tenant.reply_to || undefined, subject: m.subject, text: m.text, html: m.html, tag: `msg-${kind}`,
      headers: m.unsubscribe ? [{ Name: 'List-Unsubscribe', Value: `<${m.unsubscribe}>` }] : undefined });
  } else r = await sms.send({ tenantId: tenant.id, to: person.addr, body: build() });
  await pool.query('UPDATE message_log SET status = ?, error = ? WHERE tenant_id = ? AND id = ?', [r.ok ? 'sent' : 'failed', r.ok ? null : r.error, tenant.id, claim.insertId]);
  return r.ok ? 'sent' : 'failed';
}

/** Sends a campaign to its audience. Returns { total, sent, failed }. */
async function sendCampaign(tenant, campaign, base) {
  const people = (await audienceOf(tenant, campaign.channel, campaign.audience)).slice(0, MAX_RECIPIENTS);
  let sent = 0; let failed = 0;
  const queue = [...people];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const url = unsubUrl(base, tenant.id, p.id, campaign.channel);
      const result = await deliver({
        tenant, campaign, person: p, kind: 'campaign', refId: campaign.id, channel: campaign.channel, base,
        build: campaign.channel === 'email' ? () => ({ ...renderEmail(tenant, campaign, p, base, url), unsubscribe: url }) : () => renderSms(tenant, campaign, p),
      });
      if (result === 'sent') sent += 1; else if (result === 'failed') failed += 1;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { total: people.length, sent, failed };
}

// ---------------------------------------------------------------- automatic reminders (run by the daily job)
async function enabledFor(tenantId) { return (await modules.enabledKeys(tenantId)).includes('messages'); }

function simpleEmail(tenant, subject, lines) {
  const text = `${lines.join('\n\n')}\n\n--\n${footerLines(tenant)}${tenant.phone ? `\n${tenant.phone}` : ''}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a;line-height:1.55">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<hr style="border:none;border-top:1px solid #d3dce1;margin:24px 0 12px"><p style="font-size:12px;color:#55687a">${esc(footerLines(tenant))}${tenant.phone ? `<br>${esc(tenant.phone)}` : ''}</p></div>`;
  return { subject, text, html };
}

/** Rentals past their due time, and season passes ending soon. Each goes once per rental or pass, to an address on file. */
async function runReminders(tenant, base) {
  const out = { overdue: 0, renewal: 0, failed: 0 };
  if (!mailer.enabled() || !(await enabledFor(tenant.id))) return out;
  const today = todayIn(tenant.timezone);
  const overdue = await rows(pool, `SELECT c.id AS ref, p.id, p.first_name, LOWER(p.email) AS addr, c.due_at FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND c.status IN ('out','overdue') AND c.due_at < NOW() - INTERVAL 1 HOUR AND p.email IS NOT NULL AND p.anonymised_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_log m WHERE m.tenant_id = c.tenant_id AND m.kind = 'rental_overdue' AND m.ref_id = c.id AND (m.status = 'sent' OR m.created_at >= NOW() - INTERVAL 1 HOUR)) LIMIT 200`, [tenant.id]);
  for (const r of overdue) {
    const res = await deliver({ tenant, person: r, kind: 'rental_overdue', refId: r.ref, channel: 'email', base,
      build: () => simpleEmail(tenant, `Your rental gear is overdue at ${tenant.name}`, [`Hi ${r.first_name},`, `Your rental gear from ${tenant.name} was due back and has not been returned yet. Please bring it back to the rental counter as soon as you can. Late fees may apply.`, 'If you already returned it, thank you, and please ignore this note.']) });
    if (res === 'sent') out.overdue += 1; else if (res === 'failed') out.failed += 1;
  }
  const ending = await rows(pool, `SELECT t.id AS ref, p.id, p.first_name, LOWER(p.email) AS addr, t.valid_to FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id JOIN people p ON p.id = t.person_id AND p.tenant_id = t.tenant_id
    WHERE t.tenant_id = ? AND t.status = 'active' AND pr.kind = 'season_pass' AND t.valid_to BETWEEN ? AND ? AND p.email IS NOT NULL AND p.anonymised_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_log m WHERE m.tenant_id = t.tenant_id AND m.kind = 'pass_renewal' AND m.ref_id = t.id AND (m.status = 'sent' OR m.created_at >= NOW() - INTERVAL 1 HOUR)) LIMIT 200`, [tenant.id, today, addDays(today, 14)]);
  for (const r of ending) {
    const when = String(r.valid_to).slice(0, 10);
    const res = await deliver({ tenant, person: r, kind: 'pass_renewal', refId: r.ref, channel: 'email', base,
      build: () => simpleEmail(tenant, `Your ${tenant.name} season pass ends on ${when}`, [`Hi ${r.first_name},`, `Your season pass at ${tenant.name} is good through ${when}. To keep skiing without a break, renew at the ticket window${tenant.phone ? ` or call us on ${tenant.phone}` : ''}.`, 'Thank you for skiing with us.']) });
    if (res === 'sent') out.renewal += 1; else if (res === 'failed') out.failed += 1;
  }
  return out;
}

async function runAll(base) {
  return eachTenant('messages_reminders', (t) => runReminders(t, base));
}

module.exports = { AUDIENCES, MAX_RECIPIENTS, audienceOf, sendCampaign, renderEmail, renderSms, unsubToken, readUnsub, unsubscribe, unsubUrl, deliver, runReminders, runAll, fill };
