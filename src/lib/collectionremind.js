'use strict';

// Night-before collection reminders (release 2026.11.22, Trash and recycling). A resident signs up on the collection
// calendar page through the street alert sign-up (routes/streetnotices.js, POST /:slug/alerts with streams): the same
// code by text or link by email confirms the phone or email, and the same STOP rule applies. The sign-up keeps the
// streams they picked (alert_signups.collection_streams) and the 'trash' topic.
//
// The 5-minute guests job calls remindDue: from the municipality's reminder hour (6 PM unless a manager changed it) until
// 9 PM its own time, every confirmed phone and email whose sign-up has a picked stream collected tomorrow (after the
// holiday rule and any change for snow or weather) gets one message for tomorrow, naming the streams and saying when a
// day moved. One per phone or email per day, even when a household signed up twice: each is claimed in
// collection_reminder_sends (keyed by a hash of the address, never the address) before it goes. A phone that texted STOP,
// an address stopped from the manage link, a customer record that said no, or a sign-up without the trash topic gets
// nothing. Only municipalities with Trash and recycling on and a published calendar.
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const config = require('../config');
const { nowIn, addDays } = require('./util');
const C = require('./collection');

const QUIET_FROM = 21; // texts and emails stop at 9 PM (lib/quiet.js)
const hashOf = (tenantId, channel, key) => crypto.createHmac('sha256', config.linkSecret).update(`collection-remind:${tenantId}:${channel}:${key}`).digest('hex');
const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

/** The words of one reminder: { sms, subject, text } for the streams collected on a day. */
function wordsFor(t, date, items, curbBy) {
  const names = items.map((x) => x.streamName);
  const moved = items.filter((x) => x.moved);
  const movedWords = moved.length ? ` ${joinWords([...new Set(moved.map((x) => `${x.streamName} ${C.REASON_WORDS[x.reason] || 'moved'}`))])}.` : '';
  const day = C.longDay(date);
  const sms = `${t.name}: tomorrow, ${day}, is pickup for ${joinWords(names)}.${movedWords}${curbBy ? ` ${curbBy}.` : ''}`;
  return { sms, subject: `${t.name}: ${joinWords(names)} tomorrow`, text: `Tomorrow, ${day}, is pickup for ${joinWords(names)} at your address.${movedWords}${curbBy ? ` ${curbBy}.` : ''}` };
}

/** Is this phone or email still allowed to get alerts here (confirmed, not stopped, no "no" on a customer record)? */
async function allowed(tenantId, channel, key) {
  const a = await one(pool, 'SELECT confirmed_at, stopped_at FROM alert_addresses WHERE tenant_id = ? AND channel = ? AND addr = ?', [tenantId, channel, key]);
  if (!a || !a.confirmed_at || a.stopped_at) return false;
  if (channel === 'sms' && (await require('./sms').phoneSaidNo(tenantId, key) || await require('./residents').stoppedByText(pool, tenantId, key))) return false;
  return true;
}

/**
 * Sends what is due. opts: { now: 'YYYY-MM-DD HH:MM:SS' local time (tests), tenantId (one municipality, tests) }.
 * Returns { tenants, sent, failed, opted_out }.
 */
async function remindDue(base, opts = {}) {
  const out = { tenants: 0, sent: 0, failed: 0, opted_out: 0 };
  const towns = await rows(pool, `SELECT DISTINCT t.id, t.name, t.slug, t.timezone, t.reply_to FROM tenants t JOIN collection_settings cs ON cs.tenant_id = t.id
    JOIN alert_signups s ON s.tenant_id = t.id AND s.status = 'active' AND s.collection_streams IS NOT NULL AND s.collection_streams <> ''
    WHERE t.status = 'active' AND t.org_type = 'municipality' AND cs.setup_done_at IS NOT NULL${opts.tenantId ? ' AND t.id = ?' : ''}`, opts.tenantId ? [opts.tenantId] : []);
  for (const t of towns) {
    try {
      if (!(await require('./modules').stateOf(t.id)).on.has('solidwaste')) continue;
      const s = await C.settingsOf(pool, t.id);
      const clock = opts.now || nowIn(t.timezone);
      const hour = Number(clock.slice(11, 13));
      if (hour < s.reminder_hour || hour >= QUIET_FROM) continue;
      out.tenants += 1;
      const r = await remindTown(t, s, addDays(clock.slice(0, 10), 1), base);
      for (const k of ['sent', 'failed', 'opted_out']) out[k] += r[k];
    } catch (err) {
      require('./jobs').logFailure({ job: 'collection_reminders', tenant: Number(t.id), message: err.message });
    }
  }
  return out;
}

async function remindTown(t, s, date, base) {
  const SN = require('./streetnotices');
  const out = { sent: 0, failed: 0, opted_out: 0 };
  const signups = await rows(pool, `SELECT id, street_id, house_number, phone, email, by_text, by_email, collection_streams FROM alert_signups
    WHERE tenant_id = ? AND status = 'active' AND resident_id IS NOT NULL AND collection_streams IS NOT NULL AND collection_streams <> '' AND FIND_IN_SET('trash', topics) > 0 ORDER BY id`, [t.id]);
  const zones = new Map(); const dayOf = new Map();
  // Each phone or email: the streams collected tomorrow at any address it signed up for.
  const wanted = new Map(); // 'sms:6105550100' -> { channel, key, to, items: Map(streamId -> item), signupId }
  for (const su of signups) {
    const placeKey = `${su.street_id}|${su.house_number || ''}`;
    if (!zones.has(placeKey)) zones.set(placeKey, await C.zoneFor(pool, t.id, { streetId: su.street_id, houseNo: su.house_number }));
    const zone = zones.get(placeKey);
    if (!zone || !zone.zoneId) continue;
    if (!dayOf.has(zone.zoneId)) dayOf.set(zone.zoneId, await C.collectionDays(pool, t.id, { zoneId: zone.zoneId, from: date, to: date }));
    const picked = C.asList(su.collection_streams);
    const items = dayOf.get(zone.zoneId).filter((x) => picked.includes(x.streamId));
    if (!items.length) continue;
    const add = (channel, value) => {
      const key = SN.addrKey(channel, value);
      if (!key) return;
      const id = `${channel}:${key}`;
      if (!wanted.has(id)) wanted.set(id, { channel, key, to: channel === 'sms' ? SN.phoneAddr(value) : key, items: new Map(), signupId: su.id });
      for (const it of items) wanted.get(id).items.set(it.streamId, it);
    };
    if (Number(su.by_text) && su.phone) add('sms', su.phone);
    if (Number(su.by_email) && su.email) add('email', su.email);
  }
  const from = (await one(pool, 'SELECT from_number FROM street_notice_settings WHERE tenant_id = ?', [t.id])) || {};
  for (const w of wanted.values()) {
    const items = [...w.items.values()].sort((a, b) => a.streamId - b.streamId);
    const ok = await allowed(t.id, w.channel, w.key);
    const [claim] = await pool.query('INSERT IGNORE INTO collection_reminder_sends (tenant_id, for_date, channel, addr_hash, signup_id, streams, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t.id, date, w.channel, hashOf(t.id, w.channel, w.key), w.signupId, items.map((x) => x.streamId).join(',').slice(0, 200), ok ? 'sending' : 'opted_out']);
    if (!claim.affectedRows) continue; // already sent (or tried) for tomorrow
    if (!ok) { out.opted_out += 1; continue; }
    const words = wordsFor(t, date, items, s.curb_by);
    let sent;
    try {
      if (w.channel === 'sms') {
        sent = await require('./sms').send({ tenantId: t.id, to: w.to, body: `${words.sms} Reply STOP to stop texts.`, from: from.from_number || null, tag: 'collection-reminder' });
      } else {
        const a = await one(pool, "SELECT id FROM alert_addresses WHERE tenant_id = ? AND channel = 'email' AND addr = ?", [t.id, w.key]);
        const root = base || config.stripe.publicUrl || '';
        const manage = root && a ? SN.manageLink(root, t.slug, t.id, a.id) : null;
        const page = root ? `${root}/collection/${encodeURIComponent(t.slug)}` : null;
        const text = `${words.text}${page ? `\n\nYour calendar: ${page}` : ''}\n\n--\nYou get this because you asked ${t.name} for a reminder the night before pickup.${manage ? ` To change or stop it: ${manage}` : ''}`;
        sent = await require('./mailer').send({ tenantId: t.id, to: w.to, fromName: t.name, replyTo: t.reply_to || undefined, subject: words.subject, text, tag: 'collection-reminder',
          headers: manage ? [{ Name: 'List-Unsubscribe', Value: `<${manage}>` }] : undefined });
      }
    } catch (err) { sent = { ok: false, error: err.message }; }
    await pool.query('UPDATE collection_reminder_sends SET status = ?, error = ? WHERE tenant_id = ? AND for_date = ? AND channel = ? AND addr_hash = ?',
      [sent && sent.ok ? 'sent' : 'failed', sent && sent.ok ? null : String((sent && sent.error) || 'Could not be sent').slice(0, 200), t.id, date, w.channel, hashOf(t.id, w.channel, w.key)]);
    if (sent && sent.ok) out.sent += 1; else out.failed += 1;
  }
  return out;
}

module.exports = { remindDue, wordsFor };
