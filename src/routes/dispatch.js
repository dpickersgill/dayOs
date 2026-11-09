'use strict';

// Ski patrol dispatch: a call board with a timestamped timeline, responders, and the guest Help page.
//
// Calls come from patrollers (radio, phone) or from guests who scan a trail-sign QR code. A guest call is
// only a request: it lands on the board as "new" and a dispatcher decides what to do. The guest page is
// off for every mountain until a manager turns it on, and it tells guests to call 911 for emergencies.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, nowIn } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const patrolCases = require('./patrol');
const OPS = require('../lib/patrolops');
const PUSH = require('../lib/push');
const SMS = require('../lib/sms');
const GH = require('../lib/guesthelp');

const router = express.Router();
const publicRouter = express.Router();
const patrol = requireRole('patrol', 'manager');
const PA = require('../lib/patrolaccess');
const needs = (feature, message) => PA.needs(pool, feature, message);

const ACTIVE = ['new', 'dispatched', 'on_scene', 'transporting'];
const PX = require('../lib/patientaccess');
const { todayIn } = require('../lib/util');

// The board and the patient-record rule (feat/auth-hardening): what a caller said becomes the case's summary, so
//   - without the records check the board shows active calls and today's; a past day, a status other than active, or the
//     season view needs the check;
//   - a call that has a case shows its words (description, caller, the timeline's notes) only to someone who may open
//     that case without the check, or who made it;
//   - a call that is neither active nor today's is opened or changed only by them too.
const todayOf = async (tenantId) => todayIn(((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])) || {}).timezone || 'America/New_York');
const currentCall = (c, today) => ACTIVE.includes(c.status) || String(c.call_date).slice(0, 10) === today;
async function wordsHidden(req, calls) {
  const withCase = calls.filter((c) => c.incident_id).map((c) => Number(c.incident_id));
  if (!withCase.length) return () => false;
  const may = await PX.openable(pool, req, withCase);
  return (c) => Boolean(c.incident_id) && !may.has(Number(c.incident_id));
}
const HIDE = (c) => ({ ...c, description: null, caller_name: null, caller_phone: null, answers: null, last_scan_hint: null, words_hidden: true });
// Express matches addresses without regard to case or a trailing slash, so the address is compared as lib/pathcheck reads
// it (lower case, no trailing slash): POST /dispatch/7/Events is the same timeline write as /events (review 2026.11.12).
const caseWrite = (req) => {
  const at = require('../lib/pathcheck').normal(req.path);
  return req.method === 'PATCH' || (req.method === 'POST' && at === '/events') || (req.method === 'DELETE' && /^\/responders\/[^/]+$/.test(at));
};
router.use('/dispatch/:id', PX.byChild('id', 'SELECT id, incident_id, status, call_date FROM dispatch_calls WHERE tenant_id = ? AND id = ?', {
  skipOther: true, // /dispatch/available and others share the address
  // Current calls stay open for reading (words hidden as on the board) and for sending people. Changing the words or the
  // timeline (notes, status) of a call that has a case, or taking someone off it, changes what that case shows: the
  // case's rule decides, so anyone tied to it (dispatched, on duty, crew) goes on as before and anyone else needs the
  // records check.
  allow: async (req, c) => req.auth.recordsChecked || (currentCall(c, await todayOf(req.auth.tenantId)) && !(c.incident_id && caseWrite(req))),
}));
// Timeline event -> the call status it sets. Notes and "at aid room" leave the status alone.
const STATUS_FOR = { dispatched: 'dispatched', on_scene: 'on_scene', transporting: 'transporting', closed: 'closed', cancelled: 'cancelled' };
const callNo = (c) => `${String(c.call_date).slice(5).replace('-', '')}-${String(c.seq).padStart(2, '0')}`; // 1215-03

/** Creates the call and its first timeline entry. Call numbers restart each day; a collision retries. */
async function createCall(tenant, b, { source, userId = null, staffId = null, sender = null }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await tx(async (conn) => {
        const now = nowIn(tenant.timezone);
        const date = now.slice(0, 10);
        const { n } = await one(conn, 'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM dispatch_calls WHERE tenant_id = ? AND call_date = ?', [tenant.id, date]);
        // A guest request from a phone or address that has sent several in the last 10 minutes joins that sender's group
        // on the board (flood_of: the first in the group). It is never refused. Text HELP calls (source 'sms') are grouped
        // the same way, keyed on the texting phone (lib/helpline.js).
        let floodOf = null;
        if (sender) {
          const since = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - FLOOD_WINDOW_MS).toISOString().slice(0, 19).replace('T', ' ');
          const recent = await rows(conn, `SELECT id, flood_of, sender_hash = ? AS same_device FROM dispatch_calls WHERE tenant_id = ? AND source IN ('guest','sms') AND received_at >= ?
            AND (sender_hash = ? OR ip_hash = ?) ORDER BY id`, [sender.device, tenant.id, since, sender.device, sender.ip]);
          const sameDevice = recent.filter((x) => Number(x.same_device)).length;
          if (sameDevice >= FLOOD_DEVICE || recent.length >= FLOOD_ADDRESS) {
            const head = recent.find((x) => !x.flood_of) || recent[0];
            floodOf = head.flood_of || head.id;
          }
          sender.repeats = sameDevice;
        }
        // help/guest: the guest's status page key, the sign or place, who needs help, the page language, the answers so far
        // and the request key that lets a retry find this call (all null for a call dispatch logs).
        const [r] = await conn.query(
          `INSERT INTO dispatch_calls (tenant_id, call_date, seq, source, priority, location, description, caller_name, caller_phone, gps_lat, gps_lng, received_at, sender_hash, ip_hash, flood_of,
             located_at, located_accuracy_m, guest_token, place_id, place_text, who, lang, answers, request_key, call_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [tenant.id, date, n, source, b.priority ?? 'normal', b.location, b.description ?? null, b.caller_name ?? null, b.caller_phone ?? null, b.gps_lat ?? null, b.gps_lng ?? null, now,
            sender ? sender.device : null, sender ? sender.ip : null, floodOf,
            b.gps_lat != null && b.accuracy != null ? now : null, b.gps_lat != null && b.accuracy != null ? Math.round(b.accuracy) : null,
            b.guest_token ?? null, b.place_id ?? null, b.place_text ?? null, b.who ?? null, b.lang ?? null, b.answers ? JSON.stringify(b.answers) : null, b.request_key ?? null, b.call_type ?? null],
        );
        if (floodOf) {
          const [first] = await conn.query('UPDATE dispatch_calls SET flood_alerted_at = ? WHERE tenant_id = ? AND id = ? AND flood_alerted_at IS NULL', [now, tenant.id, floodOf]);
          if (sender) sender.alert = first.affectedRows ? floodOf : null;
        }
        await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'received', ?, ?, ?)", [tenant.id, r.insertId, now, staffId, source === 'guest' ? 'Guest help request' : source === 'sms' ? `Text HELP from ${b.caller_phone}` : null, userId]);
        return { id: r.insertId, call_no: callNo({ call_date: date, seq: n }), flood_of: floodOf };
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && attempt < 4) continue;
      throw err;
    }
  }
}

/**
 * A new request for help from a guest (the help page, Text HELP) or from staff (Guest needs help here) alerts patrol on
 * duty at once, the same way for all three, so a mountain with no one watching the board still hears about it. The
 * alert says where, never what the guest wrote (2026.11.11 rule). A request grouped into a flood is covered by the one
 * flood alert, and a lost child has its own alert (both sent by the caller). Never holds up the answer to the guest.
 */
const REQUEST_TITLE = { guest: 'Guest help', sms: 'Text HELP', staff: 'Guest needs help here' };
async function alertNewRequest(tenantId, out, location, source) {
  if (!out || out.flood_of) return 0;
  const on = await OPS.onDutyIds(pool, tenantId).catch(() => []);
  if (!on.length) return 0;
  return PUSH.notifyStaff(tenantId, on, { title: `${REQUEST_TITLE[source] || 'Guest help'}: patrol call ${out.call_no}`, body: `${String(location || 'Place not given yet')}. Open the app for details.`, url: '#/patrol/dispatch', tag: `call-${out.id}` }).catch(() => 0);
}

const withNo = (c) => { const out = { ...c, call_no: callNo(c) }; delete out.locate_token; delete out.sender_hash; delete out.ip_hash; delete out.guest_token; delete out.request_key; return out; };

// Guest help floods: a phone sending its 3rd request in 10 minutes, or an address its 6th (several phones on one
// connection), joins a group on the board. A phone past HELP_REPEAT_WARN is told patrol already has its requests.
const FLOOD_WINDOW_MS = 10 * 60000;
const FLOOD_DEVICE = 2;
const FLOOD_ADDRESS = 5;
const HELP_REPEAT_WARN = Number(process.env.HELP_RATE_LIMIT) || 5;
const senderKey = (tenantId, kind, v) => require('crypto').createHmac('sha256', require('../config').linkSecret).update(`help:${tenantId}:${kind}:${v}`).digest('hex');

// ---------------------------------------------------------------- the board
router.get('/dispatch', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const today = await todayOf(tenantId);
  const current = (!req.query.status || req.query.status === 'active') || String(req.query.date || '') === today;
  if (!current && !req.auth.recordsChecked) throw PX.needed('past_calls'); // the season's calls, or another day's
  const where = ['c.tenant_id = ?'];
  const params = [tenantId];
  if (req.query.status === 'active' || !req.query.status) { where.push(`c.status IN (${ACTIVE.map(() => '?').join(',')})`); params.push(...ACTIVE); }
  else if (req.query.status !== 'all') { where.push('c.status = ?'); params.push(String(req.query.status)); }
  if (req.query.date) {
    if (!dateStr.safeParse(String(req.query.date)).success) throw bad('date must be YYYY-MM-DD');
    where.push('c.call_date = ?'); params.push(String(req.query.date));
  }
  const all = await rows(pool, `SELECT c.* FROM dispatch_calls c WHERE ${where.join(' AND ')} ORDER BY FIELD(c.priority,'critical','high','normal','low'), c.received_at DESC LIMIT 500`, params);
  // Repeats from one guest phone or address fold under the first of the group; each one is still listed with its place.
  const heads = new Set(all.filter((c) => !c.flood_of).map((c) => Number(c.id)));
  const folded = all.filter((c) => c.flood_of && heads.has(Number(c.flood_of)));
  const calls = all.filter((c) => !(c.flood_of && heads.has(Number(c.flood_of)))).slice(0, 200);
  const ids = calls.map((c) => c.id);
  const responders = ids.length
    ? await rows(pool, `SELECT r.call_id, r.staff_id, p.first_name, p.last_name, m.callsign FROM dispatch_responders r
                        JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                        LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id
                        WHERE r.tenant_id = ? AND r.call_id IN (?)`, [tenantId, ids])
    : [];
  const hidden = await wordsHidden(req, [...calls, ...folded]);
  res.json({ data: calls.map((c0) => {
    const c = hidden(c0) ? HIDE(c0) : c0;
    const rep = folded.filter((f) => Number(f.flood_of) === Number(c.id)).map((f) => (hidden(f) ? HIDE(f) : f));
    return { ...withNo(c), responders: responders.filter((r) => r.call_id === c.id), ...(rep.length ? { repeats: rep.map((f) => ({ id: f.id, call_no: callNo(f), location: f.location, description: f.description, received_at: f.received_at, status: f.status, gps_lat: f.gps_lat, gps_lng: f.gps_lng })) } : {}) };
  }) });
});

/**
 * Patrollers on duty right now: signed in on Patrol (volunteers and paid alike), or clocked in on the time clock for a
 * patrol shift. Each says whether they are already out on a call.
 */
router.get('/dispatch/available', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const duty = await OPS.onDuty(pool, tenantId);
  const clocked = await rows(pool, `SELECT DISTINCT s.id AS staff_id, p.first_name, p.last_name, m.callsign, te.clock_in
     FROM time_entries te JOIN staff s ON s.id = te.staff_id AND s.tenant_id = te.tenant_id AND s.status = 'active'
     JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
     LEFT JOIN patrol_members m ON m.staff_id = s.id AND m.tenant_id = s.tenant_id
     LEFT JOIN shifts sh ON sh.id = te.shift_id AND sh.tenant_id = te.tenant_id
     LEFT JOIN positions pos ON pos.id = sh.position_id AND pos.tenant_id = sh.tenant_id
     WHERE te.tenant_id = ? AND te.clock_out IS NULL AND (m.id IS NOT NULL OR pos.department = 'patrol')`, [tenantId]);
  const byId = new Map();
  for (const d of duty) byId.set(Number(d.staff_id), { staff_id: Number(d.staff_id), first_name: d.first_name, last_name: d.last_name, callsign: d.callsign, radio: d.radio, station: d.station, since: d.signed_in_at, via: 'signed_in' });
  for (const c of clocked) if (!byId.has(Number(c.staff_id))) byId.set(Number(c.staff_id), { staff_id: Number(c.staff_id), first_name: c.first_name, last_name: c.last_name, callsign: c.callsign, since: c.clock_in, via: 'time_clock' });
  const ids = [...byId.keys()];
  const busy = ids.length ? await rows(pool, `SELECT r.staff_id, c.id FROM dispatch_responders r JOIN dispatch_calls c ON c.id = r.call_id AND c.tenant_id = r.tenant_id
     WHERE r.tenant_id = ? AND r.staff_id IN (?) AND c.status IN ('dispatched','on_scene','transporting')`, [tenantId, ids]) : [];
  const onCall = new Map(busy.map((b) => [Number(b.staff_id), b.id]));
  const data = [...byId.values()].map((a) => ({ ...a, on_call_id: onCall.get(a.staff_id) || null, state: onCall.has(a.staff_id) ? 'on_call' : 'available' }))
    .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`));
  res.json({ data });
});

/** Alert the people sent to a call on their phones, and text them too on a critical call when the mountain allows it. */
async function alertResponders(tenantId, call, staffIds, { text = false } = {}) {
  // A phone alert or text shows on a locked screen: where to go, never what was reported about the person (2026.11.11).
  const msg = { title: `${call.priority === 'critical' ? 'CRITICAL: ' : ''}Patrol call ${callNo(call)}`, body: `${call.location}. Open the app for details.`, url: '#/patrol/dispatch', tag: `call-${call.id}` };
  await PUSH.notifyStaff(tenantId, staffIds, msg);
  await pool.query('UPDATE dispatch_responders SET notified_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND staff_id IN (?)', [tenantId, call.id, staffIds]);
  if (!text) return 0;
  let texted = 0;
  if (!(SMS.enabled())) return 0;
  const phones = await rows(pool, 'SELECT s.id, p.phone FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id IN (?) AND p.phone IS NOT NULL', [tenantId, staffIds]);
  for (const ph of phones) {
    const r = await SMS.send({ tenantId, to: ph.phone, body: `${msg.title}: ${msg.body}`.slice(0, 300) });
    if (!r.ok) continue;
    await pool.query('UPDATE dispatch_responders SET texted_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, call.id, ph.id]);
    texted += 1;
  }
  return texted;
}

const callFields = z.object({
  location: z.string().min(1).max(255),
  description: z.string().max(500).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  source: z.enum(['patrol', 'radio', 'phone']).default('radio'),
  caller_name: z.string().max(100).nullable().optional(),
  caller_phone: z.string().max(40).nullable().optional(),
  gps_lat: z.number().min(-90).max(90).nullable().optional(),
  gps_lng: z.number().min(-180).max(180).nullable().optional(),
});

router.post('/dispatch', patrol, needs('dispatch'), validate(callFields), async (req, res) => {
  const tenant = await one(pool, 'SELECT id, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const out = await createCall(tenant, req.body, { source: req.body.source, userId: req.auth.userId, staffId: req.auth.staffId });
  await audit(pool, req, 'create', 'dispatch_calls', out.id, { source: req.body.source, priority: req.body.priority });
  // A critical call goes to everyone on duty at once, so the nearest can answer on the radio.
  if (req.body.priority === 'critical') {
    const call = await loadCall(pool, tenant.id, out.id);
    out.alerted = await PUSH.notifyStaff(tenant.id, await OPS.onDutyIds(pool, tenant.id), { title: `CRITICAL: Patrol call ${callNo(call)}`, body: `${call.location}. Open the app for details.`, url: '#/patrol/dispatch', tag: `call-${call.id}` });
  }
  res.status(201).json(out);
});

async function loadCall(conn, tenantId, id, lock = false) {
  const c = await one(conn, `SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!c) throw notFound('Call');
  return c;
}

router.get('/dispatch/:id', patrol, needs('dispatch'), async (req, res) => {
  const id = paramId(req);
  const c = await loadCall(pool, req.auth.tenantId, id);
  const [events, responders, incident] = await Promise.all([
    rows(pool, `SELECT e.id, e.at, e.kind, e.note, e.staff_id, p.first_name, p.last_name FROM dispatch_events e
                LEFT JOIN staff s ON s.id = e.staff_id AND s.tenant_id = e.tenant_id LEFT JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id
                WHERE e.tenant_id = ? AND e.call_id = ? ORDER BY e.at, e.id`, [req.auth.tenantId, id]),
    rows(pool, `SELECT r.staff_id, r.notified_at, r.acked_at, r.texted_at, p.first_name, p.last_name, m.callsign FROM dispatch_responders r JOIN staff s ON s.id = r.staff_id AND s.tenant_id = r.tenant_id
                JOIN people p ON p.id = s.person_id AND p.tenant_id = s.tenant_id LEFT JOIN patrol_members m ON m.staff_id = r.staff_id AND m.tenant_id = r.tenant_id
                WHERE r.tenant_id = ? AND r.call_id = ?`, [req.auth.tenantId, id]),
    c.incident_id ? one(pool, 'SELECT id, season, seq FROM incidents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, c.incident_id]) : null,
  ]);
  const hide = (await wordsHidden(req, [c]))(c);
  res.json({ ...withNo(hide ? HIDE(c) : c), events: hide ? events.map((e) => ({ ...e, note: null })) : events, responders, case: incident ? { id: incident.id, case_number: `${incident.season}-${String(incident.seq).padStart(4, '0')}` } : null,
    guest: await guestBlock(c, hide) });
});

/**
 * help/guest: what the guest told patrol from their phone, for the call view's Guest section: the tap answers in plain
 * words, who needs help, the page language, the pass hint, the phone's latest positions and the messages. A call whose
 * words are hidden (it has a case this person may not open) shows none of it.
 */
async function guestBlock(c, hide) {
  if (c.source !== 'guest' || !c.guest_token) return null;
  if (hide) return { hidden: true };
  let answers = {};
  try { answers = c.answers ? JSON.parse(c.answers) : {}; } catch (_) { answers = {}; }
  const [positions, messages] = await Promise.all([
    rows(pool, 'SELECT lat, lng, accuracy_m, taken_at, received_at FROM dispatch_positions WHERE tenant_id = ? AND call_id = ? ORDER BY id DESC LIMIT 10', [c.tenant_id, c.id]),
    require('../lib/guestmsg').list(pool, c.tenant_id, c.id),
  ]);
  return { who: c.who, who_text: c.who ? GH.WHO[c.who] : null, lang: c.lang, answers: GH.answerWords(answers), scan_hint: GH.scanHintWords(c.last_scan_hint),
    live_off_at: c.live_off_at, positions, messages, can_text: Boolean(c.caller_phone && SMS.enabled()) };
}

/** A message to the guest: on their status page, and texted when they gave a phone and texts are set up (lib/guestmsg.js). */
router.post('/dispatch/:id/messages', patrol, needs('dispatch'), validate(z.object({ body: z.string().trim().min(1).max(1000) })), async (req, res) => {
  const c = await loadCall(pool, req.auth.tenantId, paramId(req));
  if (c.source !== 'guest' || !c.guest_token) throw bad('Only a request from the guest help page can get messages here');
  if (!ACTIVE.includes(c.status)) throw conflict('This call is closed');
  const out = await require('../lib/guestmsg').toGuest(pool, c, req.body.body, { userId: req.auth.userId });
  await audit(pool, req, 'message_guest', 'dispatch_calls', c.id, { texted: out.texted }); // never the words
  res.status(201).json(out);
});

router.patch('/dispatch/:id', patrol, needs('dispatch'), validate(z.object({ priority: z.enum(['low', 'normal', 'high', 'critical']).optional(), location: z.string().min(1).max(255).optional(), description: z.string().max(500).nullable().optional() })), async (req, res) => {
  const c = await loadCall(pool, req.auth.tenantId, paramId(req));
  if (!ACTIVE.includes(c.status)) throw conflict('This call is closed');
  const keys = Object.keys(req.body);
  if (!keys.length) throw bad('No updatable fields supplied');
  await pool.query(`UPDATE dispatch_calls SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => req.body[k]), req.auth.tenantId, c.id]);
  await audit(pool, req, 'update', 'dispatch_calls', c.id, { fields: Object.keys(req.body) }); // field names only, never the patient's condition
  res.json({ ok: true });
});

/** Adds a timeline entry. Moving the call along (on scene, transporting, closed) also sets its status. */
router.post(
  '/dispatch/:id/events',
  patrol, needs('dispatch'),
  validate(z.object({ kind: z.enum(['dispatched', 'on_scene', 'transporting', 'at_aid_room', 'note', 'closed', 'cancelled']), note: z.string().max(500).nullable().optional(), staff_id: z.number().int().positive().nullable().optional() })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const b = req.body;
    if (b.kind === 'note' && !b.note) throw bad('A note needs some text');
    const out = await tx(async (conn) => {
      const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
      const c = await loadCall(conn, tenantId, paramId(req), true);
      if (!ACTIVE.includes(c.status)) throw conflict('This call is already closed');
      if (b.staff_id && !(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [tenantId, b.staff_id]))) throw notFound('Staff member');
      const now = nowIn(tenant.timezone);
      await conn.query('INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, c.id, now, b.kind, b.staff_id ?? null, b.note ?? null, req.auth.userId]);
      const next = STATUS_FOR[b.kind];
      if (next) await conn.query('UPDATE dispatch_calls SET status = ?, closed_at = ? WHERE tenant_id = ? AND id = ?', [next, ['closed', 'cancelled'].includes(next) ? now : null, tenantId, c.id]);
      await audit(conn, req, 'event', 'dispatch_calls', c.id, { kind: b.kind });
      return { status: next || c.status };
    });
    // A call that came by text gets one closing text (lib/helpline.js). It never holds up the answer.
    if (['closed', 'cancelled'].includes(out.status)) require('../lib/helpline').closed(tenantId, paramId(req)).catch((err) => require('../lib/jobs').logFailure({ job: 'help_sms', tenant: tenantId, message: err.message }));
    res.status(201).json(out);
  },
);

/** Sends a patroller. Anyone not active is refused; a call that is still "new" becomes "dispatched". */
router.post('/dispatch/:id/responders', patrol, needs('dispatch'), validate(z.object({ staff_id: z.number().int().positive() })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    const c = await loadCall(conn, tenantId, paramId(req), true);
    if (!ACTIVE.includes(c.status)) throw conflict('This call is already closed');
    if (!(await one(conn, "SELECT id FROM staff WHERE tenant_id = ? AND id = ? AND status = 'active'", [tenantId, req.body.staff_id]))) throw conflict('That person is not an active staff member');
    const [r] = await conn.query('INSERT IGNORE INTO dispatch_responders (tenant_id, call_id, staff_id, added_by, added_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())', [tenantId, c.id, req.body.staff_id, req.auth.userId]); // who sent them, and when (lib/patientaccess.js)
    if (!r.affectedRows) throw conflict('Already sent to this call');
    await conn.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, user_id) VALUES (?, ?, ?, 'dispatched', ?, ?)", [tenantId, c.id, nowIn(tenant.timezone), req.body.staff_id, req.auth.userId]);
    if (c.status === 'new') await conn.query("UPDATE dispatch_calls SET status = 'dispatched' WHERE tenant_id = ? AND id = ?", [tenantId, c.id]);
    await audit(conn, req, 'dispatch', 'dispatch_calls', c.id, { staff_id: req.body.staff_id });
  });
  const call = await loadCall(pool, tenantId, paramId(req));
  const settings = await OPS.settingsOf(pool, tenantId);
  await alertResponders(tenantId, call, [req.body.staff_id], { text: call.priority === 'critical' && settings.sms_critical });
  res.status(201).json({ ok: true });
});

/** "On my way": the responder acknowledges the alert, so dispatch knows it was seen. */
router.post('/dispatch/:id/ack', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  if (!staffId) throw bad('Your login is not linked to anyone on the roster');
  const c = await loadCall(pool, tenantId, paramId(req));
  const [r] = await pool.query('UPDATE dispatch_responders SET acked_at = COALESCE(acked_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, c.id, staffId]);
  if (!r.affectedRows) throw notFound('You are not sent to this call');
  const tz = (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, staff_id, note, user_id) VALUES (?, ?, ?, 'note', ?, 'On the way', ?)", [tenantId, c.id, nowIn(tz), staffId, req.auth.userId]);
  res.json({ ok: true });
});

/** My calls: the ones I am sent to that are still open, for the alert screen and my phone. */
router.get('/dispatch-mine', patrol, async (req, res) => {
  const { tenantId, staffId } = req.auth;
  if (!staffId) return res.json({ data: [] });
  const list = await rows(pool, `SELECT c.*, r.acked_at FROM dispatch_responders r JOIN dispatch_calls c ON c.tenant_id = r.tenant_id AND c.id = r.call_id
    WHERE r.tenant_id = ? AND r.staff_id = ? AND c.status IN ('new','dispatched','on_scene','transporting') ORDER BY c.received_at DESC`, [tenantId, staffId]);
  const hidden = await wordsHidden(req, list); // as on the board: a late self-dispatch does not show a case's words
  res.json({ data: list.map((c) => withNo(hidden(c) ? HIDE(c) : c)) });
});

/** Text a responder who has not acknowledged (the dispatcher's backup when the phone alert was missed). */
router.post('/dispatch/:id/responders/:staffId/text', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await loadCall(pool, tenantId, paramId(req));
  const sid = paramId(req, 'staffId');
  if (!(await one(pool, 'SELECT staff_id FROM dispatch_responders WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, c.id, sid]))) throw notFound('Responder');
  if (!(SMS.enabled())) throw bad('Text messages are not set up for Verdynt/OS yet');
  const n = await alertResponders(tenantId, c, [sid], { text: true });
  if (!n) throw bad('Could not text them: check the phone number on their staff record');
  await audit(pool, req, 'text_responder', 'dispatch_calls', c.id, { staff_id: sid });
  res.json({ ok: true });
});

/**
 * Takes a responder off a call. It is written to the audit log. On a call that has a case, the removed person keeps the
 * tie to that case they had from being sent (dispatch_responders_removed, read by lib/patientaccess.js): taking someone
 * off the board does not take away their own scene case. The tie still counts only by the link rule (sent within 30
 * minutes of the case starting, or by someone tied to it). Removing someone from a call with a case needs the case rule
 * (the guard above).
 */
router.delete('/dispatch/:id/responders/:staffId', patrol, needs('dispatch'), async (req, res) => {
  const { tenantId } = req.auth;
  const callId = paramId(req); const staffId = paramId(req, 'staffId');
  const gone = await tx(async (conn) => {
    const r = await one(conn, `SELECT d.staff_id, d.added_by, d.added_at, d.acked_at, c.incident_id FROM dispatch_responders d JOIN dispatch_calls c ON c.tenant_id = d.tenant_id AND c.id = d.call_id
      WHERE d.tenant_id = ? AND d.call_id = ? AND d.staff_id = ? FOR UPDATE`, [tenantId, callId, staffId]);
    if (!r) throw notFound('Responder');
    if (r.incident_id) {
      await conn.query(`INSERT INTO dispatch_responders_removed (tenant_id, call_id, staff_id, added_by, added_at, removed_by, removed_at)
        VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`, [tenantId, callId, staffId, r.added_by, r.added_at, req.auth.userId]);
    }
    await conn.query('DELETE FROM dispatch_responders WHERE tenant_id = ? AND call_id = ? AND staff_id = ?', [tenantId, callId, staffId]);
    return r;
  });
  await audit(pool, req, 'remove_responder', 'dispatch_calls', callId, { staff_id: staffId, acked: Boolean(gone.acked_at), incident_id: gone.incident_id ? Number(gone.incident_id) : null });
  res.status(204).end();
});

/** Opens a patient care report from the call and links the two. Their times seed the case timeline. */
router.post('/dispatch/:id/case', patrol, needs('dispatch'), validate(z.object({ category: z.enum(['injury', 'collision', 'lost_person', 'equipment', 'medical', 'conduct', 'other']).default('injury'), severity: z.enum(['minor', 'moderate', 'serious', 'critical']).default('minor') })), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await loadCall(pool, tenantId, paramId(req));
  if (c.incident_id) throw conflict('This call already has a case');
  const made = await patrolCases.createCase(req, {
    occurred_at: String(c.received_at), location: c.location, category: req.body.category, severity: req.body.severity,
    summary: (c.description || `Call ${callNo(c)}`).slice(0, 500),
  });
  const [r] = await pool.query('UPDATE dispatch_calls SET incident_id = ? WHERE tenant_id = ? AND id = ? AND incident_id IS NULL', [made.id, tenantId, c.id]);
  if (!r.affectedRows) throw conflict('This call already has a case');
  await audit(pool, req, 'link_case', 'dispatch_calls', c.id, { incident_id: made.id });
  res.status(201).json(made);
});

// ---------------------------------------------------------------- guest help settings
/**
 * The numbers a guest sees, from Patrol settings, Text HELP (lib/helpline.js lineOf): patrol_phone for Call patrol and
 * sms_number for Send by text instead, each with the way it is written on a sign (610-555-0100).
 */
async function guestNumbers(tenantId) {
  const HL = require('../lib/helpline');
  const l = (await HL.lineOf(pool, tenantId)) || {};
  return { patrol_phone: l.patrol_phone || null, patrol_phone_shown: l.patrol_phone ? HL.says(l.patrol_phone) : null,
    sms_number: l.help_number || null, sms_number_shown: l.help_number ? HL.says(l.help_number) : null };
}
router.get('/guest-help', patrol, needs('manage_settings'), async (req, res) => {
  const t = await one(pool, 'SELECT slug, guest_help_enabled, guest_help_message FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const n = await guestNumbers(req.auth.tenantId);
  res.json({ enabled: Boolean(t.guest_help_enabled), message: t.guest_help_message, ...n, path: `/help/${t.slug}` });
});

// The page switch and message. The patrol phone (Call patrol) and the number guests text (Send by text instead, and the
// sign sheets) are set in one place, Patrol settings, Text HELP (/patrol/text-help), and read here.
router.put('/guest-help', patrol, needs('manage_settings'), validate(z.object({ enabled: z.boolean(), message: z.string().max(300).nullable().optional() })), async (req, res) => {
  const b = req.body;
  const sets = ['guest_help_enabled = ?', 'guest_help_message = ?']; const vals = [b.enabled ? 1 : 0, b.message ?? null];
  await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, [...vals, req.auth.tenantId]);
  await audit(pool, req, 'set_guest_help', 'tenants', req.auth.tenantId, { enabled: b.enabled });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- public: guest help request
// No sign-in. Anyone with the link can send a request, so the endpoint is small, rate limited, ignores
// anything not listed, and creates only a "new" call for patrol to review. It never returns patrol data.
publicRouter.get('/:slug/help', async (req, res) => {
  const t = await one(pool, 'SELECT id, name, guest_help_enabled, guest_help_message FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t || !t.guest_help_enabled) throw notFound('Help page');
  const [places, lifts] = await Promise.all([
    rows(pool, 'SELECT name FROM trails WHERE tenant_id = ? ORDER BY name LIMIT 200', [t.id]),
    rows(pool, 'SELECT id, name FROM lifts WHERE tenant_id = ? ORDER BY name LIMIT 40', [t.id]),
  ]);
  // A sign's code from the QR (?c=R7), when help/places has mapped it: its name only, never anything about patrol.
  const place = req.query.c ? await GH.placeByCode(pool, t.id, String(req.query.c)) : null;
  res.set('Cache-Control', 'no-store');
  res.set('Vary', 'Accept-Language');
  res.json({ mountain: t.name, message: t.guest_help_message, places: places.map((p) => p.name), lifts: lifts.map((l) => ({ id: l.id, name: l.name })),
    ...(await guestNumbers(t.id)), lang: GH.langOf(req.get('accept-language')),
    ...(place ? { place: { code: String(req.query.c).toUpperCase(), name: place.name } } : {}) });
});

// A retry of the same request (the same key), or the same phone again within 2 minutes, joins the call already made
// instead of making another (help/guest). Only the new page sends a key; anything else is grouped as before (PATROL-4).
const JOIN_MS = 2 * 60000;
const GUEST_DESC = { help: 'Guest pressed I need help now.', someone: 'Guest is asking for help for someone they saw.', lost_child: 'Lost child reported by a guest. Details follow as they answer.' };

publicRouter.post(
  '/:slug/help',
  validate(z.object({
    location: z.string().trim().min(2).max(120).optional(), // typed, or the sign's ?loc= text
    description: z.string().trim().max(300).optional(),
    name: z.string().trim().max(60).optional(),
    phone: z.string().trim().max(30).optional(),
    gps_lat: z.number().min(-90).max(90).optional(), gps_lng: z.number().min(-180).max(180).optional(), // when the guest lets the page share where they are
    accuracy: z.number().min(0).max(100000).optional(),
    kind: z.enum(['help', 'lost_child']).optional(),
    who: z.enum(['me', 'someone_with_me', 'someone_i_saw']).optional(),
    code: z.string().trim().max(10).optional(), // the sign code from the QR (?c=R7)
    lang: z.enum(['en', 'es']).optional(),
    rid: z.string().regex(/^[0-9a-f]{32}$/).optional(), // the page's key for this request, the same on every retry
    website: z.string().max(200).optional(), // hidden field: real people leave it empty, form-filling bots do not
  })),
  async (req, res) => {
    const t = await one(pool, 'SELECT id, timezone, guest_help_enabled FROM tenants WHERE slug = ?', [req.params.slug]);
    if (!t || !t.guest_help_enabled) throw notFound('Help page');
    res.set('Cache-Control', 'no-store');
    if (req.body.website) return res.status(202).json({ ok: true }); // pretend success, create nothing
    const b = req.body;
    // Always accepted: a real request for help is never refused because others sent junk. Repeats from one phone or
    // address are grouped on the board and patrol is alerted to the flood.
    const dev = String(req.get('x-device') || '');
    const realDevice = /^[A-Za-z0-9_-]{16,64}$/.test(dev);
    const ip = String(req.ip || '');
    const sender = { ip: senderKey(t.id, 'ip', ip), device: senderKey(t.id, 'dev', realDevice ? dev : `ip:${ip}`) };
    const kind = b.kind || 'help';
    const callType = kind === 'lost_child' ? 'lost_child' : null;
    const hasGps = b.gps_lat !== undefined && b.gps_lng !== undefined;

    if (b.rid) {
      // A retry, or the same phone pressing again: join that call. Only a phone's own id joins by phone, never an address
      // (a lodge's Wi-Fi puts every guest on one).
      const now = nowIn(t.timezone);
      const since = new Date(Date.parse(`${now.replace(' ', 'T')}Z`) - JOIN_MS).toISOString().slice(0, 19).replace('T', ' ');
      const same = (await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND request_key = ? ORDER BY id LIMIT 1', [t.id, b.rid]))
        || (realDevice ? await one(pool, `SELECT * FROM dispatch_calls WHERE tenant_id = ? AND source = 'guest' AND sender_hash = ? AND guest_token IS NOT NULL
             AND status IN ('new','dispatched','on_scene','transporting') AND received_at >= ? AND ${callType ? "call_type = 'lost_child'" : '(call_type IS NULL OR call_type <> \'lost_child\')'}
             ORDER BY id DESC LIMIT 1`, [t.id, sender.device, since]) : null);
      if (same) {
        if (hasGps && (same.gps_lat === null || (b.accuracy != null && (same.located_accuracy_m === null || b.accuracy < same.located_accuracy_m)))) {
          await pool.query('UPDATE dispatch_calls SET gps_lat = ?, gps_lng = ?, located_at = ?, located_accuracy_m = ? WHERE tenant_id = ? AND id = ?',
            [b.gps_lat, b.gps_lng, now, b.accuracy != null ? Math.round(b.accuracy) : null, t.id, same.id]);
        }
        if (same.request_key !== b.rid) await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, note) VALUES (?, ?, ?, 'note', 'The guest\\'s phone asked again. It joined this call.')", [t.id, same.id, now]);
        return res.status(200).json({ ok: true, joined: true, reference: callNo(same), token: same.guest_token, status: require('../lib/guestmsg').guestStatus(same.status) });
      }
    }

    // Where: the sign's code (help/places), the typed or ?loc= place, the mapped place near the phone, or the phone's position.
    const place = b.code ? await GH.placeByCode(pool, t.id, b.code) : null;
    const near = hasGps ? await GH.describePlace(pool, t.id, b.gps_lat, b.gps_lng, b.accuracy) : null;
    const auto = !place && !b.location;
    const placeText = near && near.text ? String(near.text).slice(0, 255) : null;
    const location = place ? `Sign ${String(b.code).toUpperCase()}: ${place.name}`.slice(0, 255) : b.location
      || GH.autoLocation({ place_text: placeText, gps_lat: hasGps ? b.gps_lat : null, gps_lng: b.gps_lng, located_accuracy_m: b.accuracy != null ? Math.round(b.accuracy) : null });
    const who = b.who || (kind === 'lost_child' ? null : undefined);
    const token = require('crypto').randomBytes(16).toString('hex');
    const lang = b.lang || GH.langOf(req.get('accept-language'));
    const description = b.description || GUEST_DESC[kind === 'lost_child' ? 'lost_child' : who === 'someone_i_saw' ? 'someone' : 'help'];
    const out = await createCall(t, {
      location, description, caller_name: b.name, caller_phone: b.phone, gps_lat: hasGps ? b.gps_lat : null, gps_lng: hasGps ? b.gps_lng : null, accuracy: hasGps ? b.accuracy : null,
      priority: kind === 'lost_child' ? 'high' : 'normal', call_type: callType, guest_token: token, who: who || null, lang,
      place_id: place ? place.id : near && near.place_id ? near.place_id : null, place_text: placeText, request_key: b.rid || null, answers: auto ? { auto_location: true } : null,
    }, { source: 'guest', sender });
    if (sender.alert) {
      const on = await OPS.onDutyIds(pool, t.id).catch(() => []);
      if (on.length) PUSH.notifyStaff(t.id, on, { title: 'Guest help: many requests from one phone', body: 'They are grouped on the dispatch board. Check each place listed.', url: '#/patrol/dispatch', tag: `flood-${sender.alert}` }).catch(() => {});
    }
    if (callType !== 'lost_child') alertNewRequest(t.id, out, location, 'guest').catch(() => {});
    if (callType === 'lost_child' && !out.flood_of) {
      // A lost child goes to everyone on duty at once, like a critical call. Where to look, never the child's details.
      const on = await OPS.onDutyIds(pool, t.id).catch(() => []);
      if (on.length) PUSH.notifyStaff(t.id, on, { title: `Lost child: patrol call ${out.call_no}`, body: `${location}. Open the app for details.`, url: '#/patrol/dispatch', tag: `call-${out.id}` }).catch(() => {});
    }
    const warning = sender.repeats >= HELP_REPEAT_WARN ? 'Patrol already has several requests from this phone. Stay where you are. If things get worse, call 911.' : undefined;
    return res.status(201).json({ ok: true, reference: out.call_no, token, status: 'received', ...(warning ? { warning } : {}) });
  },
);

// ---------------------------------------------------------------- locating a caller
// A guest who cannot say where they are: dispatch texts them a one-time link, and when they tap it and allow it, their
// phone sends back its position, which lands on the call (and the dispatch map) with how accurate it is. The link works
// for 2 hours and only while the call is open; it shows the guest nothing about the call but the mountain's name.
const LOCATE_HOURS = 2;
const locateUrl = (req, token) => `${require('../lib/baseurl').baseUrl(req)}/locate/${token}`;

router.post('/dispatch/:id/locate', patrol, needs('dispatch'), validate(z.object({ phone: z.string().trim().max(30).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await loadCall(pool, tenantId, paramId(req));
  if (!ACTIVE.includes(c.status)) throw conflict('This call is closed');
  const phone = req.body.phone || c.caller_phone;
  if (!phone || !SMS.e164(phone)) throw bad('Add the caller\'s mobile number first');
  const token = require('crypto').randomBytes(16).toString('hex');
  const t = await one(pool, 'SELECT name, timezone FROM tenants WHERE id = ?', [tenantId]);
  const now = nowIn(t.timezone);
  await pool.query('UPDATE dispatch_calls SET locate_token = ?, locate_sent_at = ?, caller_phone = ? WHERE tenant_id = ? AND id = ?', [token, now, phone, tenantId, c.id]);
  const link = locateUrl(req, token);
  const sent = SMS.enabled()
    ? await SMS.send({ tenantId, to: phone, body: `${t.name} ski patrol: tap this link and allow location so we can find you: ${link} If it is life threatening, also call 911.` })
    : { ok: false, error: 'Text messages are not set up' };
  await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, note, user_id) VALUES (?, ?, ?, 'note', ?, ?)", [tenantId, c.id, now, sent.ok ? `Location link texted to ${phone}` : `Location link made (not texted: ${sent.error})`, req.auth.userId]);
  await audit(pool, req, 'locate_caller', 'dispatch_calls', c.id, { texted: sent.ok });
  res.json({ texted: Boolean(sent.ok), error: sent.ok ? null : sent.error, link });
});

async function locateCall(token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  const c = await one(pool, `SELECT c.*, t.name AS mountain, t.timezone FROM dispatch_calls c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.locate_token = ? AND c.status IN ('new','dispatched','on_scene','transporting') AND t.status = 'active'`, [token]);
  if (!c) return null;
  const sent = Date.parse(`${String(c.locate_sent_at).replace(' ', 'T')}Z`);
  const now = Date.parse(`${nowIn(c.timezone).replace(' ', 'T')}Z`);
  return now - sent <= LOCATE_HOURS * 3600000 ? c : null;
}

publicRouter.get('/locate/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = await locateCall(req.params.token);
  if (!c) throw notFound('This link has expired');
  res.json({ mountain: c.mountain, located: Boolean(c.located_at) });
});

publicRouter.post('/locate/:token', validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional() })), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = await locateCall(req.params.token);
  if (!c) throw notFound('This link has expired');
  const now = nowIn(c.timezone);
  const acc = req.body.accuracy === undefined ? null : Math.round(req.body.accuracy);
  await pool.query('UPDATE dispatch_calls SET gps_lat = ?, gps_lng = ?, located_at = ?, located_accuracy_m = ? WHERE id = ?', [req.body.lat, req.body.lng, now, acc, c.id]);
  await pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, note) VALUES (?, ?, ?, 'note', ?)", [c.tenant_id, c.id, now, `Caller shared their location${acc !== null ? ` (within about ${acc} m)` : ''}`]);
  // Everyone on the call sees it at once.
  const staff = (await rows(pool, 'SELECT staff_id FROM dispatch_responders WHERE tenant_id = ? AND call_id = ?', [c.tenant_id, c.id])).map((r) => r.staff_id);
  if (staff.length) await PUSH.notifyStaff(c.tenant_id, staff, { title: `Call ${callNo(c)}: caller located`, body: `Within about ${acc ?? '?'} m. Open the call for the map.`, url: '#/patrol/dispatch', tag: `call-${c.id}-loc` }).catch(() => {});
  res.json({ ok: true, mountain: c.mountain });
});

module.exports = { router, publicRouter, createCall, callNo, senderKey, guestNumbers, alertNewRequest }; // callNo, senderKey: Text HELP (lib/helpline.js)
