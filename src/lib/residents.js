'use strict';

// Residents (muni release 1): the people who report a problem, book a bulk pickup or sign up for street notices. A resident
// is a contact kept apart from everything public: never on a public page, in a log, in AI or in a public-record export
// (Right-to-Know) unless a manager picks "include contact details". Bulk pickup and requests write through upsertResident,
// and street alerts through residentForConfirmed once a phone or email is confirmed. A public form never adds to or
// changes a resident who is already on file: it keeps what was typed on its own row (the request, booking or sign-up).
//
// Consent follows the consent ledger's rules (lib/consent.js): every yes or no to texts or emails is its own row in
// resident_consent, never edited, and residents.texts_ok / emails_ok is the quick answer that follows the latest row.
//
// STOP, one rule for requests, bulk pickup and street notices: a STOP texted back turns texts off for that phone at the
// municipality, and only a START texted back turns them on again. Ticking "text me" on a form while the STOP stands
// changes nothing; the form says so in the words of textsOffNotice. A municipality texts residents from one number: its
// own (Street notices, Settings) or the shared Verdynt/OS number. A STOP to the shared number counts at every
// municipality with that phone, because the phone company then blocks the shared number for all of them; a STOP to a
// municipality's own number counts there only (routes/twilioinbound.js calls applyTextReply).
const { one, rows } = require('../db');
const SMS = require('./sms');

const WORDING = 'v1';
const SOURCES = ['report_page', 'status_page', 'staff', 'text_reply', 'bulk_pickup', 'street_notices', 'import'];

/** The 10-digit US/Canada key of a phone number, or null. */
const phoneKey = (phone) => SMS.phoneKey(phone);
const cleanEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s.slice(0, 190) : null; };
const cleanText = (v, max) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s ? s.slice(0, max) : null; };

/** The resident at this municipality with this phone (by its 10-digit key), oldest first, or null. */
async function byPhone(conn, tenantId, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  return one(conn, "SELECT * FROM residents WHERE tenant_id = ? AND phone IS NOT NULL AND REGEXP_REPLACE(phone, '[^0-9]', '') IN (?, ?) ORDER BY id LIMIT 1", [tenantId, key, `1${key}`]);
}
async function byEmail(conn, tenantId, email) {
  const e = cleanEmail(email);
  return e ? one(conn, 'SELECT * FROM residents WHERE tenant_id = ? AND email = ? ORDER BY id LIMIT 1', [tenantId, e]) : null;
}

/** One consent row; the resident's quick answer follows it. */
async function recordConsent(conn, tenantId, residentId, channel, yes, source = 'staff', userId = null) {
  await conn.query('INSERT INTO resident_consent (tenant_id, resident_id, channel, status, source, wording, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenantId, residentId, channel, yes ? 'opted_in' : 'opted_out', SOURCES.includes(source) ? source : 'staff', WORDING, userId]);
  await conn.query(`UPDATE residents SET ${channel === 'sms' ? 'texts_ok' : 'emails_ok'} = ? WHERE tenant_id = ? AND id = ?`, [yes ? 1 : 0, tenantId, residentId]);
}

/**
 * Finds the resident by phone (its 10-digit key), then by email, and brings the row up to date; or adds one. Returns the
 * resident's id, or null when nothing identifies anyone (no name, phone or email).
 *   fields: { name, phone, email, streetId, houseNumber, unit, textsOk, emailsOk }
 *   textsOk / emailsOk: true is a yes and false a no (each recorded in resident_consent); undefined or null leaves the
 *   resident's answer as it is (not ticking "text me" on a new report does not take back an earlier yes).
 *   opts (optional): { source: 'report_page' | 'staff' | 'bulk_pickup' | 'street_notices' | ..., userId, publicForm }
 *   publicForm: true for a page anyone can fill in. An existing resident is then only found, never changed (see below).
 */
async function upsertResident(conn, tenantId, { name, phone, email, streetId, houseNumber, unit, textsOk, emailsOk } = {}, { source = 'staff', userId = null, publicForm = false } = {}) {
  const nm = cleanText(name, 120);
  const ph = phoneKey(phone) ? cleanText(phone, 30) : null;
  const em = cleanEmail(email);
  if (!nm && !ph && !em) return null;
  const found = (ph && await byPhone(conn, tenantId, ph)) || (em && await byEmail(conn, tenantId, em)) || null;
  // A public form proves nothing about who typed it: it may point a report or booking at the resident with that phone or
  // email, but never changes that resident (no name, address, phone, email or yes/no is added or replaced). What the
  // person typed stays on the report, booking or sign-up row itself, and messages go to that.
  if (found && publicForm) return Number(found.id);
  let id;
  if (found) {
    id = Number(found.id);
    const sets = {};
    if (nm && nm !== found.name) sets.name = nm;
    // A phone or email is filled in when the row has none. One already there is kept: a yes to texts or emails belongs to
    // the number or address it was given for.
    if (ph && !phoneKey(found.phone)) sets.phone = ph;
    if (em && !found.email) sets.email = em;
    if (streetId) { sets.street_id = streetId; sets.house_number = cleanText(houseNumber, 20); sets.unit = cleanText(unit, 20); }
    const keys = Object.keys(sets);
    if (keys.length) await conn.query(`UPDATE residents SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => sets[k]), tenantId, id]);
  } else {
    const [r] = await conn.query('INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tenantId, nm, ph, em, streetId || null, streetId ? cleanText(houseNumber, 20) : null, streetId ? cleanText(unit, 20) : null]);
    id = r.insertId;
  }
  const cur = found || { texts_ok: 0, emails_ok: 0 };
  // A yes counts for the number or address on the row: one given now that differs from the row's is not the one texted.
  const hasPhone = ph ? (!found || !phoneKey(found.phone) || phoneKey(found.phone) === phoneKey(ph)) : Boolean(found && phoneKey(found.phone));
  const hasEmail = em ? (!found || !found.email || found.email === em) : Boolean(found && found.email);
  // A STOP texted to our number is undone only by START by text (the phone company blocks texts until then), so a box
  // ticked on a form does not turn texts back on.
  if (textsOk === true && hasPhone && !Number(cur.texts_ok) && !(await stoppedByText(conn, tenantId, ph || found.phone))) await recordConsent(conn, tenantId, id, 'sms', true, source, userId);
  if (textsOk === false && Number(cur.texts_ok)) await recordConsent(conn, tenantId, id, 'sms', false, source, userId);
  if (emailsOk === true && hasEmail && !Number(cur.emails_ok)) await recordConsent(conn, tenantId, id, 'email', true, source, userId);
  if (emailsOk === false && Number(cur.emails_ok)) await recordConsent(conn, tenantId, id, 'email', false, source, userId);
  return id;
}

/** Did this phone text STOP (its latest answer, on any resident with the number here or on the alert list, is a STOP by text)? */
async function stoppedByText(conn, tenantId, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  const last = await one(conn, `SELECT c.status, c.source FROM resident_consent c JOIN residents r ON r.tenant_id = c.tenant_id AND r.id = c.resident_id
    WHERE c.tenant_id = ? AND c.channel = 'sms' AND r.phone IS NOT NULL AND REGEXP_REPLACE(r.phone, '[^0-9]', '') IN (?, ?) ORDER BY c.id DESC LIMIT 1`, [tenantId, key, `1${key}`]);
  if (last && last.status === 'opted_out' && last.source === 'text_reply') return true;
  const alert = await one(conn, "SELECT 1 AS x FROM alert_addresses WHERE tenant_id = ? AND channel = 'sms' AND addr = ? AND stopped_at IS NOT NULL AND stop_source = 'text_reply'", [tenantId, key]);
  if (alert) return true;
  // A STOP texted before any list here had the phone (lib/smsstops.js, 2026.11.20 review).
  return require('./smsstops').stoppedAt(tenantId, key);
}

/**
 * Why this number cannot be a municipality's own texting number, or null when it can. Only the platform operator sets it
 * (platform console, the tenant's page). Refused: the shared Verdynt/OS numbers (TWILIO_FROM and the messaging service's
 * senders, TWILIO_SENDERS), any mountain's Text HELP number, and a number another tenant already has: a number belongs
 * to one municipality, so a STOP to it is that municipality's alone.
 */
async function ownNumberProblem(conn, tenantId, number) {
  const n = SMS.e164(String(number || '').replace(/[^\d+]/g, ''));
  if (!n) return 'The texting number must be a full US or Canadian phone number, like +16105550100.';
  if (SMS.sharedNumbers().includes(n)) return 'That is the shared Verdynt/OS number, which every municipality without its own number texts from. Give this municipality a number of its own, or leave it empty to keep the shared one.';
  if (await one(conn, 'SELECT tenant_id FROM patrol_help_lines WHERE help_number = ?', [n])) return 'That number is a Text HELP number for a ski patrol. Pick another number.';
  if (await one(conn, 'SELECT tenant_id FROM street_notice_settings WHERE from_number = ? AND tenant_id <> ?', [n, tenantId])) return 'Another municipality already texts from that number. Each texting number belongs to one municipality.';
  return null;
}

/** The municipality's own texting number (Street notices, Settings), as +1..., or null when it texts from the shared number. */
async function fromNumber(conn, tenantId) {
  const s = await one(conn, 'SELECT from_number FROM street_notice_settings WHERE tenant_id = ?', [tenantId]);
  return (s && s.from_number) || null;
}
/** A number as people say it: +16105550100 -> 610-555-0100. */
const sayNumber = (p) => { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || ''); };
/** The number residents text START to: the municipality's own, or the shared number; null when texts go from a messaging service. */
async function textingNumber(conn, tenantId) {
  const own = await fromNumber(conn, tenantId);
  if (own) return own;
  const shared = process.env.TWILIO_FROM;
  return shared && !/^MG/.test(shared) ? shared : null;
}
/** What every form says when "text me" is ticked for a phone whose STOP stands. One sentence, the same everywhere. */
const textsOffWords = (number) => `This phone has texts turned off. Text START to ${number ? sayNumber(number) : 'the number our texts come from'} to turn them back on.`;
/** That sentence when this phone texted STOP here and has not texted START since; otherwise null. */
async function textsOffNotice(conn, tenantId, phone) {
  if (!(await stoppedByText(conn, tenantId, phone))) return null;
  return textsOffWords(await textingNumber(conn, tenantId));
}

/**
 * May this resident be texted now? They said yes, the number can be texted, and the phone has not said no: neither a STOP
 * on a resident with that number nor (lib/sms.js phoneSaidNo) on a customer record at the same organization.
 */
async function textsAllowed(conn, tenantId, resident) {
  if (!resident || !Number(resident.texts_ok)) return false;
  const key = phoneKey(resident.phone);
  if (!key) return false;
  if (await SMS.phoneSaidNo(tenantId, key)) return false;
  const stopped = await one(conn, `SELECT 1 AS x FROM residents r WHERE r.tenant_id = ? AND r.phone IS NOT NULL AND REGEXP_REPLACE(r.phone, '[^0-9]', '') IN (?, ?)
    AND (SELECT c.status FROM resident_consent c WHERE c.tenant_id = r.tenant_id AND c.resident_id = r.id AND c.channel = 'sms' ORDER BY c.id DESC LIMIT 1) = 'opted_out' LIMIT 1`, [tenantId, key, `1${key}`]);
  return !stopped;
}
const emailsAllowed = (resident) => Boolean(resident && Number(resident.emails_ok) && cleanEmail(resident.email));

/**
 * May this phone get the texts a person asked for on a report or booking (the yes is on that row)? Not when the phone
 * texted STOP here, its latest answer on any resident with that number here is no, or a customer record here said no.
 */
async function phoneMayText(conn, tenantId, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  if (await SMS.phoneSaidNo(tenantId, key)) return false;
  if (await stoppedByText(conn, tenantId, key)) return false;
  const no = await one(conn, `SELECT 1 AS x FROM residents r WHERE r.tenant_id = ? AND r.phone IS NOT NULL AND REGEXP_REPLACE(r.phone, '[^0-9]', '') IN (?, ?)
    AND (SELECT c.status FROM resident_consent c WHERE c.tenant_id = r.tenant_id AND c.resident_id = r.id AND c.channel = 'sms' ORDER BY c.id DESC LIMIT 1) = 'opted_out' LIMIT 1`, [tenantId, key, `1${key}`]);
  return !no;
}
/** May this email get the emails a person asked for on a report or booking? Not when its latest answer on a resident here is no. */
async function emailMayGet(conn, tenantId, email) {
  const e = cleanEmail(email);
  if (!e) return false;
  const no = await one(conn, `SELECT 1 AS x FROM residents r WHERE r.tenant_id = ? AND r.email = ?
    AND (SELECT c.status FROM resident_consent c WHERE c.tenant_id = r.tenant_id AND c.resident_id = r.id AND c.channel = 'email' ORDER BY c.id DESC LIMIT 1) = 'opted_out' LIMIT 1`, [tenantId, e]);
  return !no;
}

/**
 * A resident for an alert sign-up whose phone (channel 'sms') or email was just confirmed by its code or link: the
 * resident here with that same phone or email, or a new one with only what was confirmed. Never changes a resident who
 * is already there. Returns the id.
 */
async function residentForConfirmed(conn, tenantId, channel, { name, phone, email, streetId, houseNumber, unit } = {}) {
  const found = channel === 'sms' ? await byPhone(conn, tenantId, phone) : await byEmail(conn, tenantId, email);
  if (found) return Number(found.id);
  const ph = channel === 'sms' && phoneKey(phone) ? cleanText(phone, 30) : null;
  const em = channel === 'email' ? cleanEmail(email) : null;
  const [r] = await conn.query('INSERT INTO residents (tenant_id, name, phone, email, street_id, house_number, unit) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenantId, cleanText(name, 120), ph, em, streetId || null, streetId ? cleanText(houseNumber, 20) : null, streetId ? cleanText(unit, 20) : null]);
  return Number(r.insertId);
}

/**
 * A STOP or START texted to one of our numbers (routes/twilioinbound.js), the one path for requests, bulk pickup and
 * street notices. STOP turns texts off; START turns them back on only where the last answer was a STOP by text.
 *   tenantIds: the municipalities whose own texting number the reply came to; empty or missing means the shared number,
 *   which is every municipality with that phone that texts from the shared number.
 * Each resident with the phone gets a consent row, and the phone's place on the alert list (lib/streetnotices.js) follows.
 * Returns how many records changed.
 */
async function applyTextReply(conn, phone, intent, { tenantIds = null } = {}) {
  const key = phoneKey(phone);
  if (!key || !['stop', 'start'].includes(intent)) return 0;
  const only = Array.isArray(tenantIds) && tenantIds.length ? tenantIds.map(Number) : null;
  // A reply to the shared number says nothing about a municipality that texts from a number of its own.
  const skip = only ? [] : (await rows(conn, 'SELECT tenant_id FROM street_notice_settings WHERE from_number IS NOT NULL')).map((r) => Number(r.tenant_id));
  const all = await rows(conn, `SELECT r.tenant_id, r.id, r.texts_ok,
      (SELECT CONCAT(c.status, '|', c.source) FROM resident_consent c WHERE c.tenant_id = r.tenant_id AND c.resident_id = r.id AND c.channel = 'sms' ORDER BY c.id DESC LIMIT 1) AS latest
    FROM residents r WHERE r.phone IS NOT NULL AND REGEXP_REPLACE(r.phone, '[^0-9]', '') IN (?, ?)${only ? ' AND r.tenant_id IN (?)' : ''}`, only ? [key, `1${key}`, only] : [key, `1${key}`]);
  const list = all.filter((r) => !skip.includes(Number(r.tenant_id)));
  let changed = 0;
  for (const r of list) {
    const [status, source] = String(r.latest || '|').split('|');
    if (intent === 'stop' && (Number(r.texts_ok) || status !== 'opted_out' || source !== 'text_reply')) { await recordConsent(conn, r.tenant_id, r.id, 'sms', false, 'text_reply'); changed += 1; }
    if (intent === 'start' && status === 'opted_out' && source === 'text_reply') { await recordConsent(conn, r.tenant_id, r.id, 'sms', true, 'text_reply'); changed += 1; }
  }
  changed += await require('./streetnotices').textReply(key, intent, { tenantIds: only, exceptTenantIds: skip });
  return changed;
}

/** The municipalities whose own texting number this is (the To of a text reply). Usually none or one. */
async function tenantsOfNumber(conn, number) {
  const key = phoneKey(number);
  if (!key) return [];
  // A shared number is never one municipality's own, whatever a settings row says.
  if (SMS.sharedNumbers().includes(`+1${key}`)) return [];
  return (await rows(conn, 'SELECT tenant_id FROM street_notice_settings WHERE from_number = ?', [`+1${key}`])).map((r) => Number(r.tenant_id));
}

/** The consent history of one resident, newest first: [{ channel, status, source, at }]. */
async function consentHistory(conn, tenantId, residentId) {
  return rows(conn, 'SELECT channel, status, source, created_at AS at FROM resident_consent WHERE tenant_id = ? AND resident_id = ? ORDER BY id DESC LIMIT 50', [tenantId, residentId]);
}

module.exports = { ownNumberProblem, upsertResident, residentForConfirmed, phoneMayText, emailMayGet, recordConsent, stoppedByText, textsAllowed, emailsAllowed, applyTextReply, tenantsOfNumber, fromNumber, textingNumber, sayNumber, textsOffWords, textsOffNotice, consentHistory, byPhone, byEmail, phoneKey, cleanEmail, WORDING, SOURCES };
