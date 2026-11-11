'use strict';

// Street notices and resident alerts (muni release 1). Staff pick the streets a water break or road work affects (whole,
// or a house-number range on the odd, even or both sides) and text and email every resident who signed up for alerts
// there. People decide: the app records what they send and who issued it; it never decides that an advisory is needed.
//
// Who gets a notice: an active sign-up (alert_signups) on an affected street and house number, for the notice's topic,
// whose phone was confirmed with a code from that sign-up (by_text) or whose email was confirmed by that sign-up's link
// (by_email). A phone or email that said no (STOP by text, the manage link) is skipped and counted as opted out; texts
// also honor the customer consent history (sms.phoneSaidNo). One message per address per send, even when a household
// signed up twice. Follow-ups go to the same list as the first send, checked again for STOP.
//
// Sending: a send writes one queued row per address (street_notice_deliveries) and answers at once; the rows are sent in
// the background, six at a time, by kick() in this server and by the 5-minute guests job (tick) for anything left (a
// scheduled notice, a server that stopped). Each row is claimed before it is sent, so two servers never send it twice; a
// row a stopped server left half-sent is marked failed rather than tried again. Water, boil water, sewer and street
// closure notices go out at any hour; the others wait for 8 AM like other texts (lib/quiet.js).
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const config = require('../config');
const sms = require('./sms');
const mailer = require('./mailer');
const quiet = require('./quiet');
const { esc } = require('./format');
const { logFailure } = require('./jobs');

// ---------------------------------------------------------------- what a notice can be
const TOPICS = [
  ['water', 'Water and sewer outages'],
  ['streets', 'Street closures and paving'],
  ['trash', 'Trash and recycling changes'],
  ['leaves', 'Leaf collection'],
  ['news', 'General news'],
];
const TOPIC_KEYS = TOPICS.map((t) => t[0]);

// Templates: {streets}, {start} and {until} are filled in by the screen from the form; other blanks are typed in.
// Wording is the municipality's to change. A boil water advisory names the certified operator who issued it.
const TYPES = [
  { key: 'water_outage', label: 'Water outage', topic: 'water', urgent: true, workOrder: true,
    sms: 'Water is off on {streets} for a water main repair. We expect it back by {until}.',
    body: 'Water service is off on {streets} while crews repair a water main. We expect it back by {until}.\n\nKeep some bottled water on hand. When the water comes back, run the cold tap for a few minutes until it runs clear.' },
  { key: 'boil_water', label: 'Boil water advisory', topic: 'water', urgent: true, workOrder: false, operator: true,
    sms: 'Boil water advisory for {streets}, issued by our certified operator. Boil tap water for 1 minute before drinking or cooking until we tell you it is lifted.',
    body: 'Our certified water operator has issued a boil water advisory for {streets}.\n\nBring tap water to a rolling boil for 1 minute before drinking it, cooking with it, making ice or brushing teeth. Keep doing this until we tell you the advisory is lifted.' },
  { key: 'sewer', label: 'Sewer', topic: 'water', urgent: true, workOrder: true,
    sms: 'Sewer work on {streets}. Please use less water (laundry, dishwashers, long showers) until {until}.',
    body: 'Crews are working on the sewer line on {streets}. Please use as little water as you can (laundry, dishwashers, long showers) until {until}.' },
  { key: 'street_closure', label: 'Street closure', topic: 'streets', urgent: true, workOrder: false,
    sms: '{streets} closed to traffic from {start} until {until}. Please use another route.',
    body: '{streets} will be closed to traffic from {start} until {until}. Please use another route. Residents will be let through where it is safe.' },
  { key: 'paving', label: 'Paving', topic: 'streets', urgent: false, workOrder: false,
    sms: 'Paving on {streets} from {start}. Please move cars off the street by 7 AM. Parking is back by {until}.',
    body: 'We are paving {streets} from {start}. Please move cars off the street by 7 AM on those days. Parking is back by {until}.' },
  { key: 'trash_change', label: 'Trash schedule change', topic: 'trash', urgent: false, workOrder: false,
    sms: 'Trash and recycling pickup for {streets} moves to {day} this week.',
    body: 'Trash and recycling pickup for {streets} moves to {day} this week. Please have your cans at the curb by 6 AM.' },
  { key: 'leaf_collection', label: 'Leaf collection', topic: 'leaves', urgent: false, workOrder: false,
    sms: 'Leaf collection on {streets} starts {start}. Rake leaves to the curb, not into the street.',
    body: 'Leaf collection on {streets} starts {start}. Rake leaves to the curb, not into the street or onto storm drains. Keep sticks and bags out of the pile.' },
  { key: 'general', label: 'General', topic: 'news', urgent: false, workOrder: false,
    sms: '{message}',
    body: '{message}' },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.key, t]));
const TYPE_KEYS = TYPES.map((t) => t.key);
const OPERATOR_RULE = 'Only send when your certified operator has issued the advisory.';
/** Blanks still in the words ({day}, {streets}) that must be filled in before a notice goes out. */
const blanksIn = (...texts) => [...new Set(texts.join(' ').match(/\{[a-z_ ]{1,30}\}/gi) || [])];

// ---------------------------------------------------------------- house numbers and areas
/** The number part of a house number ("123A" -> 123, "12-14" -> 12), or null. */
function houseNo(s) {
  const m = /^\s*(\d{1,7})/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
}

/** One affected area in plain words: "Dayton Street", "Dayton Street 100 to 198 (even side)". */
function areaWords(a) {
  const side = a.side === 'odd' ? 'odd side' : a.side === 'even' ? 'even side' : null;
  let range = '';
  if (a.from_no != null && a.to_no != null) range = ` ${a.from_no} to ${a.to_no}`;
  else if (a.from_no != null) range = ` ${a.from_no} and up`;
  else if (a.to_no != null) range = ` up to ${a.to_no}`;
  return `${a.street_name}${range}${side ? ` (${side})` : ''}`;
}
const areasWords = (areas) => areas.map(areaWords).join('; ');

/**
 * SQL (and its values) that is true when sign-up s is inside one of these areas ({ street_id, from_no, to_no, side }).
 * A sign-up whose house number has no digits is inside any range on its street: a text too many is better than a missed
 * water outage.
 */
function areaSql(areas) {
  const parts = []; const vals = [];
  for (const a of areas) {
    const conds = ['s.street_id = ?']; vals.push(Number(a.street_id));
    const range = [];
    if (a.from_no !== null && a.from_no !== undefined) { range.push('s.house_no >= ?'); vals.push(Number(a.from_no)); }
    if (a.to_no !== null && a.to_no !== undefined) { range.push('s.house_no <= ?'); vals.push(Number(a.to_no)); }
    if (a.side === 'odd') range.push('MOD(s.house_no, 2) = 1');
    if (a.side === 'even') range.push('MOD(s.house_no, 2) = 0');
    if (range.length) conds.push(`(s.house_no IS NULL OR (${range.join(' AND ')}))`);
    parts.push(`(${conds.join(' AND ')})`);
  }
  return parts.length ? [`(${parts.join(' OR ')})`, vals] : ['1 = 0', []];
}

// ---------------------------------------------------------------- addresses: confirmed, stopped
const phoneAddr = (phone) => { const k = sms.phoneKey(phone); return k ? `+1${k}` : null; };
const emailAddr = (email) => { const e = String(email || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null; };
/** The key an address is kept under in alert_addresses: the 10 digits of a phone, an email in lower case. */
const addrKey = (channel, value) => (channel === 'sms' ? sms.phoneKey(value) : emailAddr(value));

/** The alert_addresses row for a phone or email, made when missing. Returns the row. */
async function addressRow(db, tenantId, channel, value) {
  const key = addrKey(channel, value);
  if (!key) return null;
  await db.query('INSERT IGNORE INTO alert_addresses (tenant_id, channel, addr) VALUES (?, ?, ?)', [tenantId, channel, key]);
  return one(db, 'SELECT * FROM alert_addresses WHERE tenant_id = ? AND channel = ? AND addr = ?', [tenantId, channel, key]);
}

/** Records a yes or no for an address (the row in alert_consent_events never changes). */
async function recordAnswer(db, tenantId, addressId, status, source, userId = null) {
  await db.query('INSERT INTO alert_consent_events (tenant_id, address_id, status, source, recorded_by) VALUES (?, ?, ?, ?, ?)', [tenantId, addressId, status, String(source).slice(0, 30), userId]);
}

/** The residents here whose phone or email this address is: [{ id, texts_ok, emails_ok }]. */
const residentsOf = (db, tenantId, channel, addr) => rows(db, `SELECT id, texts_ok, emails_ok FROM residents WHERE tenant_id = ? AND ${channel === 'sms'
  ? "phone IS NOT NULL AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 10) = ?" : 'LOWER(email) = ?'}`, [tenantId, addr]);
/** The resident's own record follows the address (one consent row each, lib/residents.js), when the answer changes it. */
async function residentsFollow(db, tenantId, channel, addr, yes, source, userId) {
  const RES = require('./residents');
  const col = channel === 'sms' ? 'texts_ok' : 'emails_ok';
  for (const r of await residentsOf(db, tenantId, channel, addr)) {
    if (Boolean(Number(r[col])) !== yes) await RES.recordConsent(db, tenantId, r.id, channel, yes, source === 'text_reply' ? 'text_reply' : 'street_notices', userId);
  }
}

/**
 * A confirmed yes: the address is confirmed and an earlier stop from the manage link or the office is lifted (a new code
 * or link is a new yes). A phone that texted STOP stays stopped: only a texted START lifts that (the one STOP rule,
 * lib/residents.js). Returns the row, with still_stopped true when the STOP stands.
 */
async function confirmAddress(db, tenantId, channel, value, how, source, userId = null) {
  const a = await addressRow(db, tenantId, channel, value);
  if (!a) return null;
  if (channel === 'sms' && await require('./residents').stoppedByText(db, tenantId, a.addr)) {
    await db.query('UPDATE alert_addresses SET confirmed_at = COALESCE(confirmed_at, UTC_TIMESTAMP()), confirmed_by = COALESCE(confirmed_by, ?), stopped_at = COALESCE(stopped_at, UTC_TIMESTAMP()), stop_source = ? WHERE tenant_id = ? AND id = ?', [how, 'text_reply', tenantId, a.id]);
    return { ...a, still_stopped: true };
  }
  await db.query('UPDATE alert_addresses SET confirmed_at = COALESCE(confirmed_at, UTC_TIMESTAMP()), confirmed_by = COALESCE(confirmed_by, ?), stopped_at = NULL, stop_source = NULL WHERE tenant_id = ? AND id = ?', [how, tenantId, a.id]);
  await recordAnswer(db, tenantId, a.id, 'opted_in', source, userId);
  await residentsFollow(db, tenantId, channel, a.addr, true, source, userId);
  return a;
}

/** A no: from now on nothing more goes to this address from this municipality's alerts. */
async function stopAddress(db, tenantId, channel, value, source, userId = null) {
  const a = await addressRow(db, tenantId, channel, value);
  if (!a) return false;
  if (!a.stopped_at) {
    await db.query('UPDATE alert_addresses SET stopped_at = UTC_TIMESTAMP(), stop_source = ? WHERE tenant_id = ? AND id = ?', [String(source).slice(0, 30), tenantId, a.id]);
    await recordAnswer(db, tenantId, a.id, 'opted_out', source, userId);
  } else if (source === 'text_reply' && a.stop_source !== 'text_reply') {
    // Stopped from the manage link earlier, and now a STOP by text: from here only a texted START lifts it.
    await db.query("UPDATE alert_addresses SET stop_source = 'text_reply' WHERE tenant_id = ? AND id = ?", [tenantId, a.id]);
    await recordAnswer(db, tenantId, a.id, 'opted_out', source, userId);
  }
  await residentsFollow(db, tenantId, channel, a.addr, false, source, userId);
  return true;
}

/**
 * A STOP or START text reply, for the alert list (called by lib/residents.js applyTextReply, the one path for every
 * resident text). tenantIds: the municipalities whose own number the reply came to; none means the shared number, where a
 * STOP stops alert texts to that phone at every municipality that texts from it (exceptTenantIds: those with a number of
 * their own). START lifts only a stop that came from a text reply.
 * Returns how many municipalities changed.
 */
async function textReply(phone, intent, { tenantIds = null, exceptTenantIds = [] } = {}) {
  const key = sms.phoneKey(phone);
  if (!key) return 0;
  const only = Array.isArray(tenantIds) && tenantIds.length ? new Set(tenantIds.map(Number)) : null;
  const skip = new Set((exceptTenantIds || []).map(Number)); // municipalities with a number of their own, on a reply to the shared number
  const list = await rows(pool, "SELECT id, tenant_id, stopped_at, stop_source FROM alert_addresses WHERE channel = 'sms' AND addr = ?", [key]);
  // A phone that signed up nowhere yet is still recorded, at every municipality with a resident on that phone.
  const residentsAt = await rows(pool, "SELECT DISTINCT tenant_id FROM residents WHERE RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 10) = ?", [key]);
  const tenants = new Set([...list.map((r) => Number(r.tenant_id)), ...residentsAt.map((r) => Number(r.tenant_id))].filter((t) => (!only || only.has(t)) && !skip.has(t)));
  let changed = 0;
  for (const t of tenants) {
    const a = list.find((r) => Number(r.tenant_id) === t);
    if (intent === 'stop' && (!a || !a.stopped_at || a.stop_source !== 'text_reply')) { await stopAddress(pool, t, 'sms', key, 'text_reply'); changed += 1; }
    if (intent === 'start' && a && a.stopped_at && a.stop_source === 'text_reply') {
      await pool.query('UPDATE alert_addresses SET stopped_at = NULL, stop_source = NULL WHERE tenant_id = ? AND id = ?', [t, a.id]);
      await recordAnswer(pool, t, a.id, 'opted_in', 'text_reply');
      changed += 1;
    }
  }
  return changed;
}

// ---------------------------------------------------------------- signed links
const sign = (kind, payload) => crypto.createHmac('sha256', config.linkSecret).update(`alerts:${kind}:${payload}`).digest('hex').slice(0, 32);
const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/** A link token: "<tenant>.<id>.<signature>", the signature also covering extra (an email, so a changed email voids it). */
const tokenFor = (kind, tenantId, id, extra = '') => `${tenantId}.${id}.${sign(kind, `${tenantId}.${id}.${extra}`)}`;
/** { tenantId, id, check(extra) } for a well-formed token (check says whether it is genuine), or null. */
function readToken(kind, token) {
  const m = /^(\d{1,12})\.(\d{1,15})\.([a-f0-9]{32})$/.exec(String(token || ''));
  if (!m) return null;
  return { tenantId: Number(m[1]), id: Number(m[2]), check: (extra = '') => same(m[3], sign(kind, `${m[1]}.${m[2]}.${extra}`)) };
}
// A manage link belongs to one confirmed phone or email (an alert_addresses row), never to a resident: it shows and
// changes only the sign-ups confirmed through that same phone or email. (Links made for a resident before 2026.11.19 used
// the kind 'manage' and no longer open anything.)
const manageToken = (tenantId, addressId) => tokenFor('manage-addr', tenantId, addressId);
const signupRef = (tenantId, signupId) => tokenFor('signup', tenantId, signupId);
const emailToken = (tenantId, signupId, email) => tokenFor('email', tenantId, signupId, String(email || '').toLowerCase());

const publicLink = (base, slug, code) => `${base}/alerts/${encodeURIComponent(slug)}/${code}`;
const manageLink = (base, slug, tenantId, addressId) => `${base}/alerts/${encodeURIComponent(slug)}/manage/${manageToken(tenantId, addressId)}`;

// ---------------------------------------------------------------- who a notice reaches
/** Phones (10-digit keys) whose latest answer on a customer record here is "no" (the same rule as sms.phoneSaidNo). */
async function phonesSaidNo(tenantId, keys) {
  const out = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    if (!part.length) continue;
    const found = await rows(pool, `SELECT p.phone_key AS k, (SELECT c.status FROM consent_events c JOIN people q ON q.tenant_id = c.tenant_id AND q.id = c.person_id
        WHERE c.tenant_id = p.tenant_id AND c.channel = 'sms' AND q.phone_key = p.phone_key ORDER BY c.id DESC LIMIT 1) AS st
      FROM people p WHERE p.tenant_id = ? AND p.phone_key IN (?) GROUP BY p.phone_key`, [tenantId, part]);
    for (const r of found) if (r.st === 'opted_out') out.add(r.k);
  }
  return out;
}

/** alert_addresses rows for these keys: Map 'sms:6105550100' -> row. */
async function addressesOf(tenantId, pairs) {
  const out = new Map();
  for (const channel of ['sms', 'email']) {
    const keys = [...new Set(pairs.filter((p) => p[0] === channel).map((p) => p[1]))];
    for (let i = 0; i < keys.length; i += 500) {
      const part = keys.slice(i, i + 500);
      if (!part.length) continue;
      for (const r of await rows(pool, 'SELECT * FROM alert_addresses WHERE tenant_id = ? AND channel = ? AND addr IN (?)', [tenantId, channel, part])) out.set(`${channel}:${r.addr}`, r);
    }
  }
  return out;
}

/**
 * The people a notice of this type on these areas would reach now: { send: [{ resident_id, channel, to }], opted_out: [...same], residents, no_number }.
 * One entry per address and channel. Sign-ups whose phone or email was never confirmed are not counted at all.
 */
async function audienceOf(tenantId, type, areas) {
  const [where, vals] = areaSql(areas);
  const found = await rows(pool, `SELECT s.id, s.resident_id, s.phone, s.email, s.by_text, s.by_email, s.house_no FROM alert_signups s
    WHERE s.tenant_id = ? AND s.status = 'active' AND s.resident_id IS NOT NULL AND FIND_IN_SET(?, s.topics) > 0 AND ${where} ORDER BY s.id`, [tenantId, TYPE[type].topic, ...vals]);
  const wanted = [];
  for (const s of found) {
    if (s.by_text && sms.phoneKey(s.phone)) wanted.push({ s, channel: 'sms', key: sms.phoneKey(s.phone), to: phoneAddr(s.phone) });
    if (s.by_email && emailAddr(s.email)) wanted.push({ s, channel: 'email', key: emailAddr(s.email), to: emailAddr(s.email) });
  }
  const addrs = await addressesOf(tenantId, wanted.map((w) => [w.channel, w.key]));
  const no = await phonesSaidNo(tenantId, [...new Set(wanted.filter((w) => w.channel === 'sms').map((w) => w.key))]);
  const seen = new Set(); const send = []; const optedOut = [];
  for (const w of wanted) {
    const id = `${w.channel}:${w.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = addrs.get(id);
    if (!a || !a.confirmed_at) continue; // never confirmed: not on the list
    const item = { resident_id: Number(w.s.resident_id), channel: w.channel, to: w.to };
    if (a.stopped_at || (w.channel === 'sms' && no.has(w.key))) optedOut.push(item); else send.push(item);
  }
  return { send, opted_out: optedOut, residents: new Set(send.map((x) => x.resident_id)).size, no_number: found.filter((s) => s.house_no === null).length };
}

/** The list a follow-up goes to: the first send's addresses, checked again for STOP. Same shape as audienceOf. */
async function followupAudience(tenantId, noticeId) {
  const first = await one(pool, "SELECT id FROM street_notice_updates WHERE tenant_id = ? AND notice_id = ? AND kind = 'first' AND status IN ('queued','done') ORDER BY id LIMIT 1", [tenantId, noticeId]);
  if (!first) return { send: [], opted_out: [], residents: 0, no_number: 0 };
  const was = await rows(pool, "SELECT resident_id, channel, to_addr FROM street_notice_deliveries WHERE tenant_id = ? AND update_id = ? AND status <> 'opted_out' AND to_addr IS NOT NULL ORDER BY id", [tenantId, first.id]);
  const pairs = was.map((d) => [d.channel, addrKey(d.channel, d.to_addr)]);
  const addrs = await addressesOf(tenantId, pairs);
  const no = await phonesSaidNo(tenantId, [...new Set(pairs.filter((p) => p[0] === 'sms').map((p) => p[1]))]);
  const send = []; const optedOut = [];
  for (const d of was) {
    const key = addrKey(d.channel, d.to_addr);
    const a = addrs.get(`${d.channel}:${key}`);
    const item = { resident_id: Number(d.resident_id), channel: d.channel, to: d.to_addr };
    if (!a || a.stopped_at || (d.channel === 'sms' && no.has(key))) optedOut.push(item); else send.push(item);
  }
  return { send, opted_out: optedOut, residents: new Set(send.map((x) => x.resident_id)).size, no_number: 0 };
}

/** Counts for the screen: { texts, emails, residents, opted_out, no_number }. */
const countsOf = (aud) => ({ texts: aud.send.filter((x) => x.channel === 'sms').length, emails: aud.send.filter((x) => x.channel === 'email').length,
  residents: aud.residents, opted_out: aud.opted_out.length, no_number: aud.no_number });

// ---------------------------------------------------------------- queueing a send
/** When a send of this notice type may go out: now, or 8 AM for a non-urgent notice in quiet hours. UTC 'YYYY-MM-DD HH:MM:SS'. */
async function sendAfterFor(tenantId, type) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  if (TYPE[type].urgent) return { at: now, held: false };
  const q = await quiet.forTenant(tenantId);
  return q.quiet ? { at: q.sendAfter, held: true } : { at: now, held: false };
}

/**
 * Writes the queue rows for one update (the first send, a follow-up or "Ended") and marks it queued. Safe to repeat: the
 * update is claimed first, and a row per address and channel is unique. Returns the counts and when it goes.
 */
async function queueUpdate(tenantId, updateId) {
  const u = await one(pool, 'SELECT u.*, n.type FROM street_notice_updates u JOIN street_notices n ON n.tenant_id = u.tenant_id AND n.id = u.notice_id WHERE u.tenant_id = ? AND u.id = ?', [tenantId, updateId]);
  if (!u) return null;
  const [claim] = await pool.query("UPDATE street_notice_updates SET status = 'queued', queued_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ? AND (status = 'scheduled' OR (status = 'queued' AND queued_at IS NULL))", [tenantId, updateId]);
  if (!claim.affectedRows) return null;
  const notice = await one(pool, 'SELECT * FROM street_notices WHERE tenant_id = ? AND id = ?', [tenantId, u.notice_id]);
  const aud = u.kind === 'first' ? await audienceOf(tenantId, notice.type, await areasOf(pool, tenantId, notice.id)) : await followupAudience(tenantId, notice.id);
  const when = await sendAfterFor(tenantId, notice.type);
  const all = [...aud.send.map((x) => [x, 'queued']), ...aud.opted_out.map((x) => [x, 'opted_out'])];
  for (let i = 0; i < all.length; i += 500) {
    const part = all.slice(i, i + 500);
    await pool.query(`INSERT IGNORE INTO street_notice_deliveries (tenant_id, notice_id, update_id, resident_id, channel, to_addr, status, error, send_after) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      part.flatMap(([x, st]) => [tenantId, notice.id, u.id, x.resident_id, x.channel, x.to, st, st === 'opted_out' ? 'Said no to these messages' : null, when.at]));
  }
  if (u.kind === 'first') await pool.query("UPDATE street_notices SET status = 'active', sent_at = COALESCE(sent_at, UTC_TIMESTAMP()) WHERE tenant_id = ? AND id = ? AND status IN ('draft','scheduled')", [tenantId, notice.id]);
  if (!aud.send.length) await pool.query("UPDATE street_notice_updates SET status = 'done' WHERE tenant_id = ? AND id = ?", [tenantId, u.id]);
  return { ...countsOf(aud), held_until: when.held ? when.at : null };
}

// ---------------------------------------------------------------- sending the queue
const cache = { tenants: new Map(), updates: new Map() };
/** Drops what this server remembers about a tenant's sending (its texting number changed). */
const forget = (id) => { cache.tenants.delete(Number(id)); };
async function tenantOf(id) {
  const hit = cache.tenants.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.t;
  const t = await one(pool, 'SELECT t.id, t.slug, t.name, t.timezone, t.reply_to, s.from_number FROM tenants t LEFT JOIN street_notice_settings s ON s.tenant_id = t.id WHERE t.id = ?', [id]);
  cache.tenants.set(id, { at: Date.now(), t });
  return t;
}
async function updateOf(tenantId, id) {
  const hit = cache.updates.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.u;
  const u = await one(pool, `SELECT u.id, u.kind, u.sms_text, u.body, u.base_url, n.id AS notice_id, n.code, n.type, n.title, n.starts_at, n.ends_expected_at
    FROM street_notice_updates u JOIN street_notices n ON n.tenant_id = u.tenant_id AND n.id = u.notice_id WHERE u.tenant_id = ? AND u.id = ?`, [tenantId, id]);
  if (u) u.areas = await areasOf(pool, tenantId, u.notice_id);
  cache.updates.set(id, { at: Date.now(), u });
  return u;
}
/** The notice's streets and ranges, with each street's name. */
async function areasOf(db, tenantId, noticeId) {
  return rows(db, `SELECT a.street_id, st.name AS street_name, a.from_no, a.to_no, a.side FROM street_notice_areas a
    JOIN streets st ON st.tenant_id = a.tenant_id AND st.id = a.street_id WHERE a.tenant_id = ? AND a.notice_id = ? ORDER BY a.id`, [tenantId, noticeId]);
}

const baseOf = (u) => u.base_url || config.stripe.publicUrl || '';
/** The text: the municipality, the words, the notice's page and how to stop. */
function smsBody(t, u) {
  const lead = u.kind === 'update' ? 'Update: ' : u.kind === 'ended' ? 'Ended: ' : '';
  const base = baseOf(u);
  return `${t.name}: ${lead}${u.sms_text}${base ? `\nDetails: ${publicLink(base, t.slug, u.code)}` : ''}\nReply STOP to stop texts.`;
}
/** The email: subject, plain text and html, with the notice's page and a manage link (List-Unsubscribe too). */
function emailOf(t, u, addressId) {
  const base = baseOf(u);
  const type = TYPE[u.type];
  const subject = `${u.kind === 'update' ? 'Update: ' : u.kind === 'ended' ? 'Ended: ' : ''}${u.title}`.slice(0, 200);
  const words = String(u.body || u.sms_text);
  const where = areasWords(u.areas);
  const link = base ? publicLink(base, t.slug, u.code) : null;
  const manage = base && addressId ? manageLink(base, t.slug, t.id, addressId) : null;
  const lines = [words, `Streets: ${where}`, link ? `Updates: ${link}` : null].filter(Boolean);
  const foot = `You get this because you signed up for ${t.name} alerts.${manage ? ` To change or stop them: ${manage}` : ''}`;
  const text = `${lines.join('\n\n')}\n\n--\n${foot}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#12303a;line-height:1.55">
<p style="font-size:13px;color:#55687a;margin:0 0 4px">${esc(t.name)}: ${esc(type ? type.label : 'Notice')}</p>
<h1 style="font-size:20px;margin:0 0 12px">${esc(subject)}</h1>
${words.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('\n')}
<p><strong>Streets:</strong> ${esc(where)}</p>
${link ? `<p><a href="${esc(link)}">See updates on this notice</a></p>` : ''}
<hr style="border:none;border-top:1px solid #d3dce1;margin:24px 0 12px">
<p style="font-size:12px;color:#55687a">You get this because you signed up for ${esc(t.name)} alerts.${manage ? ` <a href="${esc(manage)}">Change or stop these alerts</a>` : ''}</p></div>`;
  return { subject, text, html, manage };
}

/** Is this address still allowed, right before it is sent? (STOP may have come in after it was queued.) */
async function stillOk(tenantId, d) {
  const key = addrKey(d.channel, d.to_addr);
  const a = await one(pool, 'SELECT stopped_at FROM alert_addresses WHERE tenant_id = ? AND channel = ? AND addr = ?', [tenantId, d.channel, key]);
  if (!a || a.stopped_at) return false;
  if (d.channel === 'sms' && await sms.phoneSaidNo(tenantId, key)) return false;
  return true;
}

async function deliverOne(d) {
  let status; let error = null; let providerId = null;
  try {
    const t = await tenantOf(Number(d.tenant_id));
    const u = await updateOf(Number(d.tenant_id), Number(d.update_id));
    if (!t || !u) { status = 'failed'; error = 'The notice is gone'; } else if (!(await stillOk(t.id, d))) { status = 'opted_out'; error = 'Said no to these messages'; } else if (d.channel === 'sms') {
      const r = await sms.send({ tenantId: t.id, to: d.to_addr, body: smsBody(t, u), from: t.from_number || null, tag: 'street-notice' });
      status = r.ok ? 'sent' : 'failed'; error = r.ok ? null : r.error; providerId = r.id || null;
    } else {
      const a = await one(pool, "SELECT id FROM alert_addresses WHERE tenant_id = ? AND channel = 'email' AND addr = ?", [t.id, addrKey('email', d.to_addr)]);
      const m = emailOf(t, u, a ? Number(a.id) : null);
      const r = await mailer.send({ tenantId: t.id, to: d.to_addr, fromName: t.name, replyTo: t.reply_to || undefined, subject: m.subject, text: m.text, html: m.html, tag: 'street-notice',
        headers: m.manage ? [{ Name: 'List-Unsubscribe', Value: `<${m.manage}>` }] : undefined });
      status = r.ok ? 'sent' : 'failed'; error = r.ok ? null : r.error; providerId = r.id || null;
    }
  } catch (err) {
    status = 'failed'; error = 'Could not be sent';
    logFailure({ job: 'street_notices', tenant: Number(d.tenant_id), message: err.message });
  }
  await pool.query('UPDATE street_notice_deliveries SET status = ?, error = ?, provider_id = ?, sent_at = UTC_TIMESTAMP(), claim = NULL WHERE id = ? AND claim = ?',
    [status, error ? String(error).slice(0, 200) : null, providerId ? String(providerId).slice(0, 64) : null, d.id, d.claim]);
  return status;
}

const BATCH = 60;
const WORKERS = 6;
/** Sends what is due, batch by batch, until nothing is left or the time is up. Returns { sent, failed, opted_out }. */
async function drain({ budgetMs = 240_000 } = {}) {
  const out = { sent: 0, failed: 0, opted_out: 0 };
  const end = Date.now() + budgetMs;
  // A row a stopped server left half-sent is not tried again: the resident may already have it.
  await pool.query("UPDATE street_notice_deliveries SET status = 'failed', error = 'The server stopped while sending it. Not tried again, so nobody gets it twice.', claim = NULL WHERE status = 'sending' AND sent_at < UTC_TIMESTAMP() - INTERVAL 15 MINUTE");
  while (Date.now() < end) {
    const claim = crypto.randomBytes(8).toString('hex');
    const [c] = await pool.query("UPDATE street_notice_deliveries SET status = 'sending', claim = ?, sent_at = UTC_TIMESTAMP() WHERE status = 'queued' AND send_after <= UTC_TIMESTAMP() ORDER BY id LIMIT ?", [claim, BATCH]);
    if (!c.affectedRows) break;
    const batch = await rows(pool, 'SELECT id, tenant_id, update_id, resident_id, channel, to_addr, claim FROM street_notice_deliveries WHERE claim = ? ORDER BY id', [claim]);
    const queue = [...batch];
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) { const st = await deliverOne(d); out[st] = (out[st] || 0) + 1; }
    }));
    for (const u of new Set(batch.map((d) => `${d.tenant_id}:${d.update_id}`))) {
      const [tid, uid] = u.split(':').map(Number);
      await pool.query(`UPDATE street_notice_updates SET status = 'done' WHERE tenant_id = ? AND id = ? AND status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM street_notice_deliveries d WHERE d.tenant_id = ? AND d.update_id = ? AND d.status IN ('queued','sending'))`, [tid, uid, tid, uid]);
    }
  }
  return out;
}

let running = null; let again = false;
/** Starts sending in the background in this server (one loop at a time). Returns the loop's promise. */
function kick() {
  if (running) { again = true; return running; }
  running = (async () => {
    const total = { sent: 0, failed: 0, opted_out: 0 };
    do {
      again = false;
      const r = await drain();
      for (const k of Object.keys(total)) total[k] += r[k] || 0;
    } while (again);
    return total;
  })().catch((err) => { logFailure({ job: 'street_notices', message: err.message }); return { error: err.message }; }).finally(() => { running = null; });
  return running;
}
/** Resolves when this server has nothing more it is sending right now (tests and the job wait on it). */
const idle = () => running || Promise.resolve(null);

/** The 5-minute job: scheduled sends that are due are queued, then the queue is sent. */
/** Is this login one of the municipality's certified operators now (Street notices, Settings), and still active? */
async function operatorCertified(db, tenantId, userId) {
  if (!userId) return false;
  const s = await one(db, 'SELECT certified_operators FROM street_notice_settings WHERE tenant_id = ?', [tenantId]);
  const ids = String((s && s.certified_operators) || '').split(',').map(Number);
  if (!ids.includes(Number(userId))) return false;
  return Boolean(await one(db, 'SELECT id FROM users WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, userId]));
}
const NOT_CERTIFIED = (name) => `${name || 'The operator named on this advisory'} is no longer one of your certified operators, so it was not sent. Pick a certified operator, then send it again.`;

async function tick() {
  const due = await rows(pool, `SELECT u.tenant_id, u.id, u.kind, n.id AS notice_id, n.type, n.issued_by_user_id, n.issued_by_name FROM street_notice_updates u
    JOIN street_notices n ON n.tenant_id = u.tenant_id AND n.id = u.notice_id WHERE u.status = 'scheduled' AND u.send_at <= UTC_TIMESTAMP() ORDER BY u.id LIMIT 200`);
  let queued = 0;
  for (const u of due) {
    try {
      // A boil water advisory goes out at its scheduled time only if the operator named on it is still certified. If not,
      // it goes back to a draft and says why on the notice.
      if (u.kind === 'first' && TYPE[u.type] && TYPE[u.type].operator && !(await operatorCertified(pool, Number(u.tenant_id), u.issued_by_user_id))) {
        await pool.query("UPDATE street_notice_updates SET status = 'cancelled' WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [u.tenant_id, u.id]);
        await pool.query("UPDATE street_notices SET status = 'draft', held_note = ? WHERE tenant_id = ? AND id = ? AND status = 'scheduled'", [NOT_CERTIFIED(u.issued_by_name).slice(0, 255), u.tenant_id, u.notice_id]);
        logFailure({ job: 'street_notices', tenant: Number(u.tenant_id), message: `scheduled boil water advisory ${u.notice_id} held: operator no longer certified` });
        continue;
      }
      if (await queueUpdate(Number(u.tenant_id), Number(u.id))) queued += 1;
    } catch (err) { logFailure({ job: 'street_notices', tenant: Number(u.tenant_id), message: err.message }); }
  }
  const sent = await kick();
  return { queued, ...(sent || {}) };
}

/**
 * The daily retention run: the delivery log is kept 13 months like other message logs, then its address is blanked and
 * the counts stay; a sign-up nobody confirmed in 7 days is deleted with the phone and email typed into it.
 */
async function purge(days) {
  const [r] = await pool.query('UPDATE street_notice_deliveries SET to_addr = NULL WHERE to_addr IS NOT NULL AND created_at < UTC_TIMESTAMP() - INTERVAL ? DAY LIMIT 50000', [days]);
  const [p] = await pool.query("DELETE FROM alert_signups WHERE status = 'pending' AND confirmed_at IS NULL AND created_at < UTC_TIMESTAMP() - INTERVAL 7 DAY LIMIT 50000");
  return r.affectedRows + p.affectedRows;
}

module.exports = {
  TOPICS, TOPIC_KEYS, TYPES, TYPE, TYPE_KEYS, OPERATOR_RULE, operatorCertified, NOT_CERTIFIED, blanksIn, houseNo, areaWords, areasWords, areasOf, areaSql,
  phoneAddr, emailAddr, addrKey, addressRow, confirmAddress, stopAddress, recordAnswer, textReply,
  tokenFor, readToken, manageToken, signupRef, emailToken, publicLink, manageLink,
  audienceOf, followupAudience, countsOf, queueUpdate, sendAfterFor, smsBody, emailOf, drain, kick, idle, tick, purge, forget,
};
