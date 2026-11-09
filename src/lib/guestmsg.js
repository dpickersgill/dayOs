'use strict';

// Messages between dispatch and a guest who asked for help (help/guest, Nov 9).
//
// A message to the guest shows on their status page (the page they sent the request from) and, when the guest gave a
// phone number and texts are set up, it is texted too. A message from the guest comes from the status page or, through
// help/sms, from a text. Both land in dispatch_messages; nothing else writes that table (help/sms calls these two).
//
// These are patrol and dispatch data. They never go to AI: no brief, no assistant, no draft (test/ai-patrol-line.test.js).
const { rows, one } = require('../db');
const { nowIn } = require('./util');
const { bad, conflict } = require('./errors');

const MAX = 1000;
const TEXT_CAP = () => Number(process.env.HELP_SMS_CALL_CAP) || 20;
const ACTIVE = ['new', 'dispatched', 'on_scene', 'transporting'];

// The call status a guest sees, in their words. Dispatch's own statuses map onto four.
const GUEST_STATUS = { new: 'received', dispatched: 'dispatched', on_scene: 'on_scene', transporting: 'on_scene', closed: 'closed', cancelled: 'closed' };
const guestStatus = (status) => GUEST_STATUS[status] || 'received';

const callNo = (c) => `${String(c.call_date).slice(5).replace('-', '')}-${String(c.seq).padStart(2, '0')}`;
const tzOf = async (db, tenantId) => ((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])) || {}).timezone || 'America/New_York';
const clean = (body) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, MAX);

/**
 * Sends a message to the guest on a call: saved, shown on their status page, and texted when they gave a phone and
 * texts are set up. staff: { userId } of the sender (or null for a message the system sends). Returns
 * { id, texted, error }.
 */
async function toGuest(db, call, body, staff) {
  const text = clean(body);
  if (!text) throw bad('A message needs some text');
  if (!ACTIVE.includes(call.status)) throw conflict('This call is closed');
  const tz = await tzOf(db, call.tenant_id);
  const now = nowIn(tz);
  const SMS = require('./sms');
  let texted = false; let error = null;
  // A phone the guest typed on the help page gets at most 20 texts a call, like a Text HELP call (lib/helpline.js counts
  // those). Past that, messages still show on the guest's page.
  let capped = false;
  if (call.source !== 'sms' && call.caller_phone && SMS.enabled()) {
    const n = await one(db, "SELECT COUNT(*) AS n FROM dispatch_messages WHERE tenant_id = ? AND call_id = ? AND direction = 'to_guest' AND channel = 'sms'", [call.tenant_id, call.id]);
    if (Number(n.n) >= TEXT_CAP()) { capped = true; error = `This call has had ${TEXT_CAP()} texts, the limit. The message is on the guest's page. Call the guest.`; }
  }
  if (!capped && call.caller_phone && SMS.enabled() && (SMS.e164(call.caller_phone) || (call.source === 'sms' && /^\+[1-9]\d{7,14}$/.test(String(call.caller_phone))))) {
    const t = await one(db, 'SELECT name FROM tenants WHERE id = ?', [call.tenant_id]);
    const r = await SMS.send({ tenantId: call.tenant_id, to: call.caller_phone, body: `${t.name} ski patrol: ${text}`.slice(0, 600) });
    texted = Boolean(r.ok); error = r.ok ? null : r.error;
  }
  const [r] = await db.query('INSERT INTO dispatch_messages (tenant_id, call_id, direction, channel, body, sent_by, at, delivered) VALUES (?, ?, \'to_guest\', ?, ?, ?, ?, ?)',
    [call.tenant_id, call.id, texted ? 'sms' : 'page', text, staff && staff.userId ? staff.userId : null, now, texted ? now : null]);
  return { id: r.insertId, texted, error };
}

/**
 * A message from the guest: from their status page (channel 'page') or a text (channel 'sms', help/sms). Saved, and
 * everyone sent to the call gets a phone alert. The alert never holds the guest's words: a locked screen shows only that
 * there is a message (2026.11.11 rule). A text (channel 'sms') is alerted by lib/helpline.js instead, once a minute and to
 * patrol on duty when no one is sent yet, so a text never alerts twice. Returns { id, alerted }.
 */
async function fromGuest(db, call, body, channel = 'page') {
  const text = clean(body);
  if (!text) throw bad('A message needs some text');
  const tz = await tzOf(db, call.tenant_id);
  const now = nowIn(tz);
  const [r] = await db.query('INSERT INTO dispatch_messages (tenant_id, call_id, direction, channel, body, at, delivered) VALUES (?, ?, \'from_guest\', ?, ?, ?, ?)',
    [call.tenant_id, call.id, channel === 'sms' ? 'sms' : 'page', text, now, now]);
  if (channel === 'sms') return { id: r.insertId, alerted: 0 };
  const staff = (await rows(db, 'SELECT staff_id FROM dispatch_responders WHERE tenant_id = ? AND call_id = ?', [call.tenant_id, call.id])).map((x) => x.staff_id);
  if (staff.length) {
    await require('./push').notifyStaff(call.tenant_id, staff, { title: `Call ${callNo(call)}: message from the guest`, body: 'Open the call to read it.', url: '#/patrol/dispatch', tag: `call-${call.id}-msg` }).catch(() => {});
  }
  return { id: r.insertId, alerted: staff.length };
}

/** The messages on a call, oldest first. */
async function list(db, tenantId, callId) {
  return rows(db, 'SELECT id, direction, channel, body, sent_by, at, delivered FROM dispatch_messages WHERE tenant_id = ? AND call_id = ? ORDER BY id LIMIT 200', [tenantId, callId]);
}

module.exports = { toGuest, fromGuest, list, guestStatus, GUEST_STATUS, MAX };
