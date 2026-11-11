'use strict';

// Resident requests with a repair record (muni release 1). The pieces the routes, the work order hook and the demo share.
//
// Why the record: in Pennsylvania a borough or township can be liable for a dangerous street or utility defect only if it
// had notice of it early enough to fix it (42 Pa.C.S. 8542(b)(5),(6)). Each request keeps when the municipality was told
// (reported_at), when the defect was made safe and when it was fixed, with photos fingerprinted as taken, measured against
// the response standard a manager set. The words never promise a resident a response time, and the app never decides
// anything about a defect: people decide, the app records and sends.
//
// Resident contact details (lib/residents.js) never go on a public page, in an alert, in a log, to AI, or in an export
// unless a manager picks "include contact details" (audited).
const crypto = require('crypto');
const { pool, one, rows } = require('../db');
const { nowIn, utcFromLocal } = require('./util');
const R = require('./residents');

const DEFAULT_CATEGORIES = [
  // name, needs contact, show the after-hours number, map color
  ['Pothole', 0, 0, '#b3261e'],
  ['Street light out', 0, 0, '#c58a00'],
  ['Sign down or damaged', 0, 0, '#e8710a'],
  ['Sidewalk or curb', 0, 0, '#6d4c41'],
  ['Storm drain or flooding', 0, 0, '#1565c0'],
  ['Water leak or low pressure', 0, 1, '#00838f'],
  ['Sewer backup', 1, 1, '#4e342e'],
  ['Missed trash or recycling', 1, 0, '#2e7d32'],
  ['Tree or branch down', 0, 0, '#558b2f'],
  ['Other', 0, 0, '#5b6770'],
];
const SOURCES = ['web', 'phone', 'walk_in', 'crew', 'email', 'text'];
const SOURCE_WORDS = { web: 'Report page', phone: 'Phone call', walk_in: 'Walk-in', crew: 'Crew noticed it', email: 'Email', text: 'Text message' };
const STATUSES = ['new', 'assigned', 'made_safe', 'fixed', 'closed_no_action', 'duplicate', 'referred'];
const STATUS_WORDS = { new: 'New', assigned: 'Work order made', made_safe: 'Made safe', fixed: 'Fixed', closed_no_action: 'Closed, no action', duplicate: 'Duplicate', referred: 'Referred' };
const OPEN = ['new', 'assigned', 'made_safe'];
const DONE = ['fixed', 'closed_no_action', 'duplicate', 'referred'];
const CLASSES = ['local', 'collector', 'arterial'];
const CLASS_WORDS = { any: 'Any street', local: 'Local', collector: 'Collector', arterial: 'Arterial' };

// ---------------------------------------------------------------- setup
/** The municipality's categories and settings row, made with the defaults the first time anyone asks. */
async function ensureSetup(conn, tenantId) {
  const n = await one(conn, 'SELECT COUNT(*) AS n FROM request_categories WHERE tenant_id = ?', [tenantId]);
  if (!Number(n.n)) {
    for (const [i, [name, contact, after, color]] of DEFAULT_CATEGORIES.entries()) {
      await conn.query('INSERT IGNORE INTO request_categories (tenant_id, name, needs_contact, after_hours, color, sort) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, name, contact, after, color, (i + 1) * 10]);
    }
  }
  await conn.query('INSERT IGNORE INTO request_settings (tenant_id) VALUES (?)', [tenantId]);
}

async function settingsOf(conn, tenantId) {
  await ensureSetup(conn, tenantId);
  const s = await one(conn, 'SELECT * FROM request_settings WHERE tenant_id = ?', [tenantId]);
  let ids = [];
  try { ids = JSON.parse(s.alert_user_ids || '[]').map(Number).filter((x) => Number.isSafeInteger(x) && x > 0); } catch (_) { ids = []; }
  return { after_hours_phone: s.after_hours_phone, office_phone: s.office_phone, intro: s.intro, public_map: Boolean(s.public_map), alert_user_ids: ids, alert_thread_id: s.alert_thread_id };
}

async function categoriesOf(conn, tenantId, { all = false } = {}) {
  await ensureSetup(conn, tenantId);
  return (await rows(conn, `SELECT id, name, needs_contact, after_hours, color, active, sort FROM request_categories WHERE tenant_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, name`, [tenantId]))
    .map((c) => ({ id: Number(c.id), name: c.name, needs_contact: Boolean(c.needs_contact), after_hours: Boolean(c.after_hours), color: c.color, active: Boolean(c.active), sort: Number(c.sort) }));
}

async function standardsOf(conn, tenantId) {
  return (await rows(conn, 'SELECT category_id, street_class, make_safe_hours, fix_hours FROM request_standards WHERE tenant_id = ?', [tenantId]))
    .map((s) => ({ category_id: Number(s.category_id), street_class: s.street_class, make_safe_hours: s.make_safe_hours === null ? null : Number(s.make_safe_hours), fix_hours: s.fix_hours === null ? null : Number(s.fix_hours) }));
}

/** The standard for a category on a class of street: the class's own, else the category's "any street" one, else none. */
function standardFor(standards, categoryId, streetClass) {
  const of = (cls) => standards.find((s) => s.category_id === Number(categoryId) && s.street_class === cls);
  const own = streetClass ? of(streetClass) : null;
  const any = of('any');
  const pick = (k) => (own && own[k] !== null ? own[k] : any ? any[k] : null);
  return { make_safe_hours: pick('make_safe_hours'), fix_hours: pick('fix_hours') };
}

// ---------------------------------------------------------------- references and tokens
/** A short reference residents can read out on the phone: R-4821. Four digits while they last, then more. */
async function newReference(conn, tenantId) {
  for (let digits = 4; digits <= 7; digits += 1) {
    for (let i = 0; i < 12; i += 1) {
      const n = crypto.randomInt(10 ** (digits - 1), 10 ** digits);
      const ref = `R-${n}`;
      if (!(await one(conn, 'SELECT id FROM requests WHERE tenant_id = ? AND reference = ?', [tenantId, ref]))) return ref;
    }
  }
  throw new Error('Could not make a request reference');
}
const newToken = () => crypto.randomBytes(16).toString('hex');
/** A reference as typed ("r4821", "R 4821", "4821") in the stored form, or null. */
function normalRef(text) {
  const d = String(text || '').toUpperCase().replace(/^R/, '').replace(/[^0-9]/g, '');
  return d.length >= 4 && d.length <= 8 ? `R-${d}` : null;
}

// ---------------------------------------------------------------- time against the standard
const msOf = (local, tz) => (local ? Date.parse(`${utcFromLocal(String(local).slice(0, 19), tz).replace(' ', 'T')}Z`) : null);
const hoursBetween = (a, b, tz) => (a && b ? Math.max(0, (msOf(b, tz) - msOf(a, tz)) / 3600000) : null);

/** A length of time in plain words: "40 minutes", "31 hours", "4.5 days". */
function spanWords(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours < 1) { const m = Math.max(1, Math.round(hours * 60)); return `${m} minute${m === 1 ? '' : 's'}`; }
  if (hours < 72) { const h = Math.round(hours); return `${h} hour${h === 1 ? '' : 's'}`; }
  const d = Math.round((hours / 24) * 2) / 2;
  return `${d % 1 ? d.toFixed(1) : d} days`;
}
/** A target as the manager set it: whole days when it is a number of days of two or more, else hours. */
function targetWords(hours) {
  if (hours === null || hours === undefined) return '';
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} days`;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * One measure (make safe or fix) against its target, in plain words:
 *   done:  "Fixed in 31 hours, target 48 hours" (met), "Fixed in 3 days, target 48 hours" (missed)
 *   open:  "Open 20 hours, target 48 hours", "Open 60 hours, 12 hours past the 48-hour target"
 */
function measure(what, from, to, target, now, tz, { stopped = false } = {}) {
  const done = Boolean(to);
  const hours = done ? hoursBetween(from, to, tz) : (stopped ? null : hoursBetween(from, now, tz));
  const out = { hours: hours === null ? null : Math.round(hours * 10) / 10, target_hours: target, done, met: null, words: '' };
  if (target !== null && target !== undefined && hours !== null) out.met = hours <= target;
  if (done) out.words = `${what} in ${spanWords(hours)}${target ? `, target ${targetWords(target)}` : ''}`;
  else if (stopped) out.words = '';
  else if (!target) out.words = `Open ${spanWords(hours)}, no target set`;
  else if (hours <= target) out.words = `Open ${spanWords(hours)}, target ${targetWords(target)}`;
  else out.words = `Open ${spanWords(hours)}, ${spanWords(hours - target)} past the ${targetWords(target).replace(/s$/, '').replace(' ', '-')} target`;
  if (done && !target) out.words += ', no target set';
  return out;
}

/**
 * Time to make safe and time to fix against the request's standard. Fixing it also makes it safe. A request closed some
 * other way (referred, duplicate, no action) stops its clocks: what is left open is no longer the municipality's to fix.
 */
function timing(r, std, now, tz) {
  const stopped = !OPEN.includes(r.status) && r.status !== 'fixed';
  const safeAt = r.made_safe_at || r.fixed_at || null;
  return {
    make_safe: measure('Made safe', r.reported_at, safeAt, std.make_safe_hours, now, tz, { stopped: stopped && !safeAt }),
    fix: measure('Fixed', r.reported_at, r.fixed_at, std.fix_hours, now, tz, { stopped: stopped && !r.fixed_at }),
  };
}

// ---------------------------------------------------------------- where
/** "120 Main Street", "Main Street at Bridge Street", "Main Street", or the phone's position. withNumber false leaves the house number out. */
function placeWords(r, { withNumber = true } = {}) {
  const street = r.street_name || r.street || null;
  if (street && withNumber && r.house_number) return `${r.house_number} ${street}${r.cross_street ? ` near ${r.cross_street}` : ''}`;
  if (street && r.cross_street) return `${street} at ${r.cross_street}`;
  if (street) return street;
  if (r.cross_street) return `Near ${r.cross_street}`;
  if (r.lat !== null && r.lat !== undefined) return 'Location from the phone (see the map)';
  return 'No location given';
}

/** A position rounded to about 50 m, so a public map never points at one house. */
function roundPosition(lat, lng) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const la = Number(lat); const ln = Number(lng);
  const step = 0.00045; // about 50 m of latitude
  const lngStep = step / Math.max(0.2, Math.cos((la * Math.PI) / 180));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  return { lat: r6(Math.round(la / step) * step), lng: r6(Math.round(ln / lngStep) * lngStep) };
}

// ---------------------------------------------------------------- the record
const REQ_SQL = `SELECT r.*, c.name AS category, c.color AS category_color, s.name AS street_name, s.street_class
  FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
  LEFT JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id`;

async function requestOf(conn, tenantId, id, { lock = false } = {}) {
  return one(conn, `${REQ_SQL} WHERE r.tenant_id = ? AND r.id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
}

/** A line on the request's own timeline. */
const event = (conn, tenantId, requestId, at, body, userId = null, kind = 'event') => conn.query('INSERT INTO request_events (tenant_id, request_id, at, kind, body, user_id) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, requestId, at, kind, String(body).slice(0, 1000), userId]);

const tzOf = async (conn, tenantId) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---------------------------------------------------------------- the resident's status words (public)
/** What the resident's status page says, in their words. Never staff names. */
function publicStatus(r) {
  switch (r.status) {
    case 'new': return { key: 'received', words: 'Received', more: 'We have your report. Staff look at new reports and decide what to do.' };
    case 'assigned': return { key: 'scheduled', words: 'Work scheduled', more: 'A crew has this job on its list.' };
    case 'made_safe': return { key: 'made_safe', words: 'Made safe', more: 'The spot has been made safe for now. The repair is still to come.' };
    case 'fixed': return { key: 'fixed', words: 'Fixed', more: 'The crew marked this fixed.' };
    case 'referred': return { key: 'referred', words: `Passed to ${r.referred_to || 'another agency'}`, more: `This is looked after by ${r.referred_to || 'another agency'}, so we passed your report to them.` };
    case 'duplicate': return { key: 'duplicate', words: 'Already reported', more: 'Someone reported this before you. We are following the first report.' };
    default: return { key: 'closed', words: 'Closed', more: 'This report is closed.' };
  }
}

// ---------------------------------------------------------------- telling the resident
const MSG = {
  received: (m, r) => `we got your report ${r.reference} (${r.category}).`,
  scheduled: (m, r) => `work on your report ${r.reference} (${r.category}) is scheduled.`,
  fixed: (m, r) => `your report ${r.reference} (${r.category}) is marked fixed.${r.public_note ? ` ${r.public_note}` : ''}`,
  closed: (m, r) => `your report ${r.reference} (${r.category}) is closed.${r.status === 'referred' ? ` It is looked after by ${r.referred_to || 'another agency'}, and we passed it to them.` : r.status === 'duplicate' ? ' Someone reported this before you, and we are following that report.' : ''}${r.public_note ? ` ${r.public_note}` : ''}`,
};
const SUBJECT = { received: 'We got your report', scheduled: 'Work is scheduled', fixed: 'Marked fixed', closed: 'Report closed' };
const statusLink = (base, slug, token) => `${String(base || '').replace(/\/$/, '')}/report/${encodeURIComponent(slug)}#s=${token}`;

/**
 * Sends one status message (received, scheduled, fixed, closed) to the resident behind a request, by text and/or email,
 * only on the channels they asked for on this request and still allow, and once per kind. Never throws. Returns
 * { sms: 'sent'|'failed'|'skipped', email: ... }. Each try is kept in request_messages (the kind and whether it went; never
 * the address).
 */
async function tellResident(tenantId, requestId, kind, { base } = {}) {
  const out = { sms: 'skipped', email: 'skipped' };
  try {
    const r = await requestOf(pool, tenantId, requestId);
    if (!r || !r.resident_id || !MSG[kind]) return out;
    const res = await one(pool, 'SELECT * FROM residents WHERE tenant_id = ? AND id = ?', [tenantId, r.resident_id]);
    if (!res) return out;
    const t = await one(pool, 'SELECT name, slug, timezone FROM tenants WHERE id = ?', [tenantId]);
    const already = new Set((await rows(pool, 'SELECT channel FROM request_messages WHERE tenant_id = ? AND request_id = ? AND kind = ? AND ok = 1', [tenantId, requestId, kind])).map((m) => m.channel));
    const link = statusLink(base || require('../config').stripe.publicUrl || '', t.slug, r.status_token);
    const line = `${t.name}: ${MSG[kind](t.name, r)}`;
    const log = (channel, sent) => pool.query('INSERT INTO request_messages (tenant_id, request_id, kind, channel, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, requestId, kind, channel, sent.ok ? 1 : 0, sent.ok ? null : String(sent.error || '').slice(0, 200), nowIn(t.timezone)]);
    if (Number(r.updates_by_text) && !already.has('sms') && await R.textsAllowed(pool, tenantId, res)) {
      const body = `${line} See it: ${link} Reply STOP to stop texts.`;
      const sent = await require('./sms').send({ tenantId, to: res.phone, body, tag: `request-${kind}` });
      await log('sms', sent);
      out.sms = sent.ok ? 'sent' : 'failed';
    }
    if (Number(r.updates_by_email) && !already.has('email') && R.emailsAllowed(res)) {
      const text = `${line}\n\nSee your report: ${link}\n\nYou get these emails because you asked for updates on this report. To stop them, open the link above and choose Stop updates.\n\n${t.name}`;
      const sent = await require('./mailer').send({ tenantId, to: res.email, fromName: t.name, subject: `${t.name}: ${SUBJECT[kind]} (${r.reference})`, text, tag: 'resident-request' });
      await log('email', sent);
      out.email = sent.ok ? 'sent' : 'failed';
    }
  } catch (err) {
    console.error(`[requests] could not tell the resident: ${err && err.message}`); // no address, no words
  }
  return out;
}

// ---------------------------------------------------------------- alerting staff about a new request
const ALERT_THREAD = 'New resident requests';

/** The alert group's Inbox conversation, kept in step with the people chosen in Settings. */
async function syncAlertThread(conn, tenantId, byUser = null) {
  const s = await settingsOf(conn, tenantId);
  const ids = s.alert_user_ids.length ? (await rows(conn, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND id IN (?)', [tenantId, s.alert_user_ids])).map((u) => Number(u.id)) : [];
  let threadId = s.alert_thread_id;
  if (threadId && !(await one(conn, 'SELECT id FROM chat_threads WHERE tenant_id = ? AND id = ?', [tenantId, threadId]))) threadId = null;
  if (!threadId && ids.length) {
    const [r] = await conn.query("INSERT INTO chat_threads (tenant_id, kind, name, created_by) VALUES (?, 'group', ?, ?)", [tenantId, ALERT_THREAD, byUser || ids[0]]);
    threadId = r.insertId;
    await conn.query('UPDATE request_settings SET alert_thread_id = ? WHERE tenant_id = ?', [threadId, tenantId]);
  }
  if (!threadId) return { threadId: null, ids };
  const { top } = await one(conn, 'SELECT COALESCE(MAX(id), 0) AS top FROM chat_messages WHERE tenant_id = ? AND thread_id = ?', [tenantId, threadId]);
  const current = new Set((await rows(conn, 'SELECT user_id FROM chat_members WHERE tenant_id = ? AND thread_id = ? AND left_at IS NULL', [tenantId, threadId])).map((r) => Number(r.user_id)));
  for (const u of ids) {
    if (current.has(u)) continue;
    await conn.query(`INSERT INTO chat_members (thread_id, tenant_id, user_id, visible_from_id, last_read_id) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE left_at = NULL, visible_from_id = VALUES(visible_from_id), last_read_id = VALUES(last_read_id)`, [threadId, tenantId, u, top, top]);
  }
  for (const u of current) if (!ids.includes(u)) await conn.query('UPDATE chat_members SET left_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND thread_id = ? AND user_id = ?', [tenantId, threadId, u]);
  return { threadId, ids };
}

/**
 * Tells the people chosen in Settings about a new request: a phone alert and a line in their Inbox. What and where only
 * (the category and the street), never the resident's name, phone, email or house number. Never throws.
 */
async function alertNew(tenantId, requestId, { exceptUserId = null } = {}) {
  try {
    const r = await requestOf(pool, tenantId, requestId);
    if (!r) return 0;
    const { threadId, ids } = await syncAlertThread(pool, tenantId);
    const to = ids.filter((u) => u !== Number(exceptUserId));
    if (!to.length) return 0;
    const where = placeWords(r, { withNumber: false });
    const text = `New request ${r.reference}: ${r.category}, ${where}. Open Requests to decide what to do.`;
    if (threadId) {
      await pool.query('INSERT INTO chat_messages (tenant_id, thread_id, user_id, body, refs) VALUES (?, ?, NULL, ?, ?)', [tenantId, threadId, text, JSON.stringify([{ type: 'resident_request', id: Number(r.id) }])]);
      await pool.query('UPDATE chat_threads SET last_message_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?', [tenantId, threadId]);
    }
    return await require('./push').notifyUsers(tenantId, to, { title: `New request: ${r.category}`, body: where, url: `/#/requests/r/${r.id}`, tag: `request-${r.id}` }, { urgency: 'normal', ttl: 3600 });
  } catch (err) {
    console.error(`[requests] could not alert staff: ${err && err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------- work orders
/** Makes the request's work order (source 'request', request_id) inside the caller's transaction. Returns its id. */
async function makeWorkOrder(conn, req, r, { title, priority, assigned_staff_id: staffId, due_date: due, description }) {
  if (staffId && !(await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, staffId]))) {
    const { notFound } = require('./errors');
    throw notFound('Staff member');
  }
  const where = placeWords(r).slice(0, 120);
  const what = (title || `${r.category}: ${placeWords(r)}`).slice(0, 150);
  const body = [description || r.description || null, `Resident request ${r.reference} (reported ${String(r.reported_at).slice(0, 16)}).`].filter(Boolean).join('\n\n').slice(0, 5000);
  const [w] = await conn.query("INSERT INTO work_orders (tenant_id, title, description, priority, location, source, request_id, assigned_staff_id, due_date, opened_by) VALUES (?, ?, ?, ?, ?, 'request', ?, ?, ?, ?)",
    [req.auth.tenantId, what, body, priority || r.priority || 'normal', where, r.id, staffId || null, due || null, req.auth.userId]);
  return w.insertId;
}

/** Marks a request fixed inside a transaction: the time, the note for the resident, and its own timeline. */
async function markFixed(conn, tenantId, r, at, { userId = null, note = null, publicNote } = {}) {
  await conn.query("UPDATE requests SET status = 'fixed', fixed_at = ?, closed_at = ?, public_note = COALESCE(?, public_note) WHERE tenant_id = ? AND id = ?", [at, at, publicNote ?? null, tenantId, r.id]);
  await event(conn, tenantId, r.id, at, note || 'Marked fixed.', userId);
}

/**
 * The work order hook (routes/maintenance.js): a work order made from a request was completed. Inside the work order's
 * transaction, its request is marked fixed at the time the order was completed. Returns the request ids to tell
 * afterwards (the request, and any reports marked duplicates of it), or [].
 */
async function workOrderDone(conn, req, workOrderId) {
  const w = await one(conn, 'SELECT request_id, completed_at, resolution FROM work_orders WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, workOrderId]);
  if (!w || !w.request_id) return [];
  const r = await requestOf(conn, req.auth.tenantId, w.request_id, { lock: true });
  if (!r || !OPEN.includes(r.status)) return [];
  const at = w.completed_at || nowIn(await tzOf(conn, req.auth.tenantId));
  await markFixed(conn, req.auth.tenantId, r, at, { userId: req.auth.userId, note: `Work order ${workOrderId} completed${w.resolution ? `: ${w.resolution}` : ''}. Marked fixed.` });
  const { audit } = require('./audit');
  await audit(conn, req, 'fixed', 'requests', r.id, { work_order_id: workOrderId, from: r.status });
  return [Number(r.id), ...(await duplicatesOf(conn, req.auth.tenantId, r.id))];
}
const duplicatesOf = async (conn, tenantId, id) => (await rows(conn, "SELECT id FROM requests WHERE tenant_id = ? AND duplicate_of = ? AND status = 'duplicate'", [tenantId, id])).map((x) => Number(x.id));

/** After a fix is saved: the resident of the request, and of each report marked a duplicate of it, hears it is fixed. */
async function tellFixed(tenantId, ids, base) {
  for (const id of ids) await tellResident(tenantId, id, 'fixed', { base });
}

// ---------------------------------------------------------------- the ledger
/**
 * Every request matching the filters, oldest first, with its times against the standard, and "met target" per category.
 * filters: { street_id, category_id, from, to (dates, of reported_at) }. contacts: add the resident's details (managers,
 * audited by the caller).
 */
async function ledger(conn, tenantId, { street_id: streetId, category_id: categoryId, from, to } = {}, { contacts = false } = {}) {
  const tz = await tzOf(conn, tenantId);
  const now = nowIn(tz);
  const where = ['r.tenant_id = ?']; const params = [tenantId];
  if (streetId) { where.push('r.street_id = ?'); params.push(streetId); }
  if (categoryId) { where.push('r.category_id = ?'); params.push(categoryId); }
  if (from) { where.push('r.reported_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('r.reported_at <= ?'); params.push(`${to} 23:59:59`); }
  const list = await rows(conn, `${REQ_SQL} WHERE ${where.join(' AND ')} ORDER BY r.reported_at, r.id LIMIT 5000`, params);
  const standards = await standardsOf(conn, tenantId);
  const ids = list.map((r) => r.id);
  const photos = ids.length ? await rows(conn, 'SELECT id, request_id, stage, sha256, uploaded_at FROM request_photos WHERE tenant_id = ? AND request_id IN (?) ORDER BY id', [tenantId, ids]) : [];
  const residents = contacts && ids.length ? new Map((await rows(conn, 'SELECT id, name, phone, email, house_number FROM residents WHERE tenant_id = ? AND id IN (SELECT resident_id FROM requests WHERE tenant_id = ? AND id IN (?))', [tenantId, tenantId, ids])).map((x) => [Number(x.id), x])) : new Map();
  const data = list.map((r) => {
    const std = standardFor(standards, r.category_id, r.street_class);
    const t = timing(r, std, now, tz);
    const res = contacts && r.resident_id ? residents.get(Number(r.resident_id)) : null;
    return {
      id: Number(r.id), reference: r.reference, category_id: Number(r.category_id), category: r.category, status: r.status, status_words: STATUS_WORDS[r.status],
      street: r.street_name, street_class: r.street_class || null, cross_street: r.cross_street, ...(contacts ? { house_number: r.house_number } : {}),
      source: r.source, reported_at: r.reported_at, made_safe_at: r.made_safe_at, fixed_at: r.fixed_at, closed_at: r.closed_at,
      referred_to: r.referred_to, work_order_id: r.work_order_id ? Number(r.work_order_id) : null,
      make_safe: t.make_safe, fix: t.fix,
      photos: photos.filter((p) => Number(p.request_id) === Number(r.id)).map((p) => ({ id: Number(p.id), stage: p.stage, sha256: p.sha256, at: p.uploaded_at })),
      ...(contacts ? { contact: res ? { name: res.name, phone: res.phone, email: res.email } : null } : {}),
    };
  });
  // Met target, per category: of the requests with a target and a finished clock, how many were within it.
  const by = new Map();
  for (const d of data) {
    if (!by.has(d.category)) by.set(d.category, { category: d.category, requests: 0, safe_n: 0, safe_met: 0, fix_n: 0, fix_met: 0 });
    const s = by.get(d.category);
    s.requests += 1;
    if (d.make_safe.target_hours && d.make_safe.done) { s.safe_n += 1; if (d.make_safe.met) s.safe_met += 1; }
    if (d.fix.target_hours && d.fix.done) { s.fix_n += 1; if (d.fix.met) s.fix_met += 1; }
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
  const summary = [...by.values()].map((s) => ({ ...s, safe_pct: pct(s.safe_met, s.safe_n), fix_pct: pct(s.fix_met, s.fix_n) })).sort((a, b) => a.category.localeCompare(b.category));
  return { data, summary, now };
}

module.exports = {
  DEFAULT_CATEGORIES, SOURCES, SOURCE_WORDS, STATUSES, STATUS_WORDS, OPEN, DONE, CLASSES, CLASS_WORDS, REQ_SQL, ALERT_THREAD,
  ensureSetup, settingsOf, categoriesOf, standardsOf, standardFor, newReference, newToken, normalRef,
  spanWords, targetWords, measure, timing, placeWords, roundPosition, requestOf, event, tzOf, publicStatus, statusLink,
  tellResident, syncAlertThread, alertNew, makeWorkOrder, markFixed, workOrderDone, duplicatesOf, tellFixed, ledger, hoursBetween,
};
