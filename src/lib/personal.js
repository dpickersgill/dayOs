'use strict';

// Every table that holds a customer, in one place (2026.11.11, privacy). "Download this person's data" and "Anonymise"
// both read this list, so a table added here is exported and erased the same way. test/f11-privacy.test.js fails when a
// new table with a person_id, email, phone or health column is in neither REGISTRY nor NOT_GUESTS.
//
// Each entry says how to find the person's rows and what erasing does to them:
//   by:     'person_id' columns that point at people.id, and/or contact columns matched on the person's email or phone;
//           booking: a lesson_bookings id column, for rows that hang off one of the person's lesson bookings (2026.11.13)
//           call: a dispatch_calls id column, for rows that hang off a help request made with the person's phone (help/guest)
//   erase:  { set: { column: value } } blanks identity and health; 'delete' removes the row; { keep: why } keeps it as is
//   json:   text columns holding JSON whose names, contacts and health details are blanked on erase
//   group:  'patrol' rows are never put in the download (a records request through patrol gives them out); the export
//           says that they exist and how to ask.
const crypto = require('crypto');
const { rows, one } = require('../db');

const KEEP_LINK = 'Kept for the books, with no name on it once the customer record is anonymised.';
const KEEP_WAIVER = 'A signed waiver is the mountain’s legal record of the release, so the wording, the typed name and the signature stay. The contact details, birth date and device are removed.';
const KEEP_PATROL = 'Patrol care records are medical and legal records the mountain must keep. They are not changed. A guest can ask for a copy through a patrol records request.';
const KEEP_DISPATCH = 'A request for patrol\u2019s help, its messages and where the phone was are kept with the patrol call, as long as the mountain keeps its dispatch records. A guest can ask for a copy through a patrol records request.';

const REGISTRY = [
  // The person themselves (anonymise blanks the row; the export gives it whole, without the photo).
  { table: 'people', by: { key: 'id' }, erase: { keep: 'The customer record stays as "Former customer" with every detail removed.' } },
  { table: 'consent_events', by: { person: ['person_id'] }, erase: { keep: 'The consent history stays so the mountain can show the guest said no.' } },
  { table: 'person_notes', by: { person: ['person_id'] }, erase: 'delete' },
  { table: 'person_flags', by: { person: ['person_id'] }, erase: 'delete' },
  { table: 'person_links', by: { person: ['adult_id', 'member_id'] }, erase: 'delete' },
  { table: 'household_invites', by: { person: ['person_id'], email: ['email'] }, erase: 'delete' },
  { table: 'rental_profiles', by: { person: ['person_id'] }, erase: 'delete' },
  // Sales and what was sold: kept for the books.
  { table: 'orders', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'order_items', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'tickets', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'activity_bookings', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'partner_redemptions', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'lesson_credits', by: { person: ['person_id'] }, erase: { set: { note: null } } },
  { table: 'guest_rewards', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'guest_reward_mails', by: { person: ['to_person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'guest_recaps', by: { person: ['person_id', 'to_person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'guest_recap_stops', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'payment_plans', by: { person: ['person_id'], email: ['email'] }, erase: { set: { email: null, name: null } } },
  { table: 'fair_cards', by: { person: ['person_id'], email: ['email'] }, erase: { set: { email: null } } },
  { table: 'fair_renewals', by: { person: ['person_id'], email: ['email'] }, erase: { set: { email: null } } },
  { table: 'donations', by: { email: ['email'] }, erase: { set: { email: null, name: null } } },
  { table: 'gift_experiences', by: { person: ['redeemed_person_id'], email: ['recipient_email'] }, erase: { set: { recipient_email: '', recipient_name: 'Former customer', message: null } } },
  // Rentals.
  { table: 'rental_contracts', by: { person: ['person_id'] }, erase: { set: { notes: null } } },
  { table: 'rental_contract_items', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'rental_reservations', by: { person: ['person_id'] }, erase: { set: { notes: null } } },
  { table: 'rental_reservation_lines', by: { person: ['for_person_id'] }, erase: { set: { size_note: null } } },
  { table: 'rental_signoffs', by: { person: ['person_id'] }, erase: { set: { ip: null } }, why: KEEP_WAIVER },
  { table: 'rental_forms', by: { email: ['email'], phone: ['phone'] }, erase: { set: { contact_name: 'Former customer', email: null, phone: null } }, json: ['people'] },
  { table: 'rental_groups', by: { email: ['leader_email'], phone: ['leader_phone'] }, erase: { set: { leader_name: null, leader_email: null, leader_phone: null } } },
  // Lessons, programs and the school: children's safety details are cleared.
  { table: 'lesson_bookings', by: { person: ['person_id'], email: ['contact_email'], phone: ['contact_phone'] },
    erase: { set: { allergies: null, medical: null, pickup: null, contact_name: null, contact_phone: null, contact_email: null, instructor_notes: null, placement_answers: null,
      // school safety (2026.11.13): who the child was released to and why, what they wore, and a booking-past-a-warning note
      released_to: null, release_reason: null, jacket_color: null, helmet_color: null, override_reason: null } } },
  { table: 'lesson_recaps', by: { person: ['person_id'] }, erase: { set: { note: null, body: null } } },
  // feat/school-safety: an adult on a child's pickup list, found by their phone or by the child's booking; erasing either
  // removes the adult and their photo
  { table: 'lesson_pickup_adults', by: { phone: ['phone'], booking: 'booking_id' }, erase: 'delete' },
  // The adaptive intake (needs, equipment, extra staff, notes) is health information about the student: erasing deletes it.
  { table: 'lesson_adaptive_intake', by: { booking: 'booking_id' }, erase: 'delete' },
  // A lost child report stays as the school's safety record, without what the child wore or where they were last seen.
  { table: 'school_lost_children', by: { booking: 'booking_id' }, erase: { set: { jacket_color: null, helmet_color: null, last_seen: null } } },
  // The family's 0 to 10 answer stays in the school's score; the comment goes.
  { table: 'lesson_ratings', by: { booking: 'booking_id' }, erase: { set: { comment: null } } },
  { table: 'lesson_requests', by: { email: ['contact_email'], phone: ['contact_phone'] }, erase: { set: { contact_name: 'Former customer', contact_email: '', contact_phone: '', note: null } }, json: ['students'] },
  { table: 'lesson_waitlist', by: { email: ['contact_email'], phone: ['contact_phone'] }, erase: { set: { contact_name: 'Former customer', contact_email: '', contact_phone: null } }, json: ['student'] },
  { table: 'lesson_baskets', by: { email: ['contact_email'] }, erase: { set: { contact_email: '' } } },
  // School and group programs (feat/school-pay): a child on a group's roster with their parent's contact, the group's
  // leader, and the chaperones.
  { table: 'group_program_students', by: { person: ['person_id'], email: ['guardian_email'], phone: ['guardian_phone'] }, erase: { set: { guardian_name: 'Former customer', guardian_email: null, guardian_phone: null } } },
  { table: 'group_programs', by: { email: ['leader_email'], phone: ['leader_phone'] }, erase: { set: { leader_name: 'Former customer', leader_email: null, leader_phone: null } } },
  { table: 'group_program_chaperones', by: { phone: ['phone'] }, erase: { set: { name: 'Former customer', phone: '' } } },
  { table: 'private_requests', by: { email: ['contact_email'], phone: ['contact_phone'] }, erase: { set: { contact_name: 'Former customer', contact_email: '', contact_phone: '', note: null } }, json: ['students'] },
  { table: 'attendance', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'student_progress', by: { person: ['person_id'] }, erase: { set: { notes: null } } },
  { table: 'student_skills', by: { person: ['person_id'] }, erase: { keep: KEEP_LINK } },
  { table: 'program_enrollments', by: { person: ['person_id', 'guardian_id'] }, erase: { set: { allergies: null, medical: null, pickup: null } } },
  { table: 'program_registrations', by: { email: ['contact_email'], phone: ['contact_phone'] }, erase: { set: { contact_name: 'Former customer', contact_email: '', contact_phone: '', note: null } }, json: ['basket'] },
  { table: 'program_reminders', by: { email: ['email'] }, erase: 'delete' },
  { table: 'weather_choices', by: { person: ['person_id'], email: ['email'], phone: ['phone'] }, erase: { set: { email: null, phone: null } } },
  // Online shop and website.
  { table: 'shop_orders', by: { email: ['contact_email'], phone: ['contact_phone'] }, erase: { set: { contact_name: 'Former customer', contact_email: '', contact_phone: null, note: null } }, json: ['basket'] },
  { table: 'shop_waitlist', by: { email: ['email'] }, erase: 'delete' },
  { table: 'fair_waitlist', by: { email: ['email'] }, erase: 'delete' },
  { table: 'family_tokens', by: { email: ['email'] }, erase: 'delete' },
  { table: 'group_enquiries', by: { email: ['email'], phone: ['phone'] }, erase: { set: { contact_name: 'Former customer', email: '', phone: null, note: null } } },
  { table: 'lost_reports', by: { email: ['email'], phone: ['phone'] }, erase: { set: { name: 'Former customer', email: null, phone: null } } },
  // Messages sent, and the do-not-mail list.
  { table: 'message_log', by: { person: ['person_id'], email: ['to_addr'], phone: ['to_addr'] }, erase: { set: { to_addr: '' } } },
  { table: 'email_suppressions', by: { email: ['email'] }, erase: { keep: 'The address stays on the do-not-email list so the mountain never emails it again.' } },
  // Waivers.
  { table: 'waivers', by: { person: ['person_id', 'signed_by_person_id'] }, erase: { keep: KEEP_WAIVER } },
  { table: 'waiver_signings', by: { person: ['signer_person_id'], email: ['signer_email'], phone: ['signer_phone'] }, erase: { set: { signer_email: null, signer_phone: null, signer_dob: null, ip: null, user_agent: null } }, why: KEEP_WAIVER },
  // Patrol: listed in the export, never changed by an erase.
  { table: 'incident_patients', group: 'patrol', by: { person: ['person_id'], email: ['email', 'guardian_email'], phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'incidents', group: 'patrol', by: { person: ['person_id'] }, erase: { keep: KEEP_PATROL } },
  { table: 'incident_parties', group: 'patrol', by: { email: ['email'], phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'incident_witnesses', group: 'patrol', by: { email: ['email'], phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'incident_search', group: 'patrol', by: { phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'patrol_witness_links', group: 'patrol', by: { email: ['email'], phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'dispatch_calls', group: 'patrol', by: { phone: ['caller_phone'] }, erase: { keep: KEEP_PATROL } },
  // help/guest: the guest's messages with dispatch and the last 10 positions their phone sent, kept with the call (its
  // tap answers, the pass hint and the page language are columns of dispatch_calls, above).
  { table: 'dispatch_messages', group: 'patrol', by: { call: 'call_id' }, erase: { keep: KEEP_DISPATCH } },
  { table: 'dispatch_positions', group: 'patrol', by: { call: 'call_id' }, erase: { keep: KEEP_DISPATCH } },
  // help/sms: a call that came by text keeps the guest's phone, language and photo addresses with the call (dispatch
  // retention); a STOP to a mountain's help line is kept so that line never texts the phone again.
  { table: 'dispatch_sms_threads', group: 'patrol', by: { phone: ['phone'] }, erase: { keep: KEEP_PATROL } },
  { table: 'dispatch_sms_optouts', by: { phone: ['phone_key'] }, erase: { keep: 'Kept so the patrol help line never texts this phone again after it texted STOP.' } },
  // A patrol follow-up email: the address goes, the patrol record stays.
  { table: 'followups', group: 'patrol', by: { email: ['to_email'] }, erase: { set: { to_email: '' } } },
  // Municipal edition (muni release 1): a resident who reported a problem, booked a pickup or signed up for street notices.
  // Erasing blanks who they are and how to reach them; the requests stay as the municipality's public record, with no one's
  // name on them, and their consent history stays so the municipality can show they said no. Bulk pickup bookings point
  // at the row, so it is blanked rather than deleted, and the bookings keep only the street and the day.
  { table: 'residents', by: { email: ['email'], phone: ['phone'] }, erase: { set: { name: 'Former resident', email: null, phone: null, house_number: null, unit: null, texts_ok: 0, emails_ok: 0 } } },
  // Logins and staff are never anonymised here (the route refuses); listed so the export shows them.
  { table: 'staff', by: { person: ['person_id'] }, erase: { keep: 'Staff records are not anonymised here.' } },
  { table: 'users', by: { person: ['person_id'] }, erase: { keep: 'Sign-ins are not anonymised here.' }, columns: ['id', 'email', 'username', 'role', 'active', 'created_at', 'access_ends_on'] },
];

// Tables with a person, email or phone column that are not about a mountain's guests. The reason is for the reader.
const NOT_GUESTS = {
  tenants: 'the mountain itself', tenant_billing: 'the mountain’s bill', assistant_settings: 'a mountain setting', school_settings: 'a mountain setting',
  lost_found_settings: 'a mountain setting', vendors: 'a supplier', platform_operators: 'Verdynt/OS staff', goodday_subscribers: 'the Verdynt/OS newsletter (its own consent history)',
  goodday_consent_events: 'the Verdynt/OS newsletter (its own consent history)', site_leads: 'a mountain asking Verdynt/OS about the product', sandbox_codes: 'a demo sign-up',
  sandbox_signups: 'a demo sign-up', prospects: 'a mountain Verdynt/OS may contact', prospect_contacts: 'staff at a mountain Verdynt/OS may contact',
  outreach_sequences: 'Verdynt/OS sales email', outreach_suppress: 'Verdynt/OS sales email', morning_messages: 'a flag on an order', weekly_reports: 'a report to the mountain’s managers',
  deletion_ledger: 'the record of erasures, kept to replay after a restore', sms_held: 'texts waiting for 8 AM (deleted once sent)',
  // 2026.11.13: school tables with no guest column, named so nobody wonders. Each is about a class, a group or staff.
  lesson_live_updates: 'a line or photo to a whole class, deleted after 90 days', school_group_places: 'where a class is, kept for the day only',
  group_program_handoffs: 'drop-off and pickup counts for a school group', pay_line_flags: 'an instructor asking about their own pay',
  school_training_staff: 'staff training hours', user_notices: 'a notice a sign-in has dismissed',
  daily_snapshots: 'counts, prices and weather for a day, never a person (forecast data, kept 3 years)',
  // AI release 1: drafts the assistant prepared for staff to approve (the morning conditions update: lifts, trails, snow,
  // never a guest), and the conditions writer's settings. No guest column in either.
  ai_proposals: 'a draft for staff to approve, made from the mountain\u2019s own conditions, never a guest', conditions_writer_settings: 'a mountain setting',
  // ai/brief: the morning brief is about the day and goes to staff; a brief and the record of who was sent it are kept 30 days.
  // help/places: trail signs, lift towers and junctions patrol mapped, with the staff login that marked each one.
  mountain_places: 'a sign, tower or junction on the mountain, never a guest',
  // help/sms: the mountain's Text HELP number and patrol phone, a mountain setting.
  patrol_help_lines: 'a mountain setting (its Text HELP number and patrol phone)',
  // muni release 1: a resident request keeps its resident in residents (above); its own columns are yes or no flags
  // (updates by text, by email). request_settings holds the municipality's office and after-hours numbers.
  requests: 'a resident request: the resident is in residents; its email and text columns are yes or no flags', request_settings: 'a municipality setting (its office and after-hours numbers)',
  // muni release 1: a bulk pickup booking holds no contact of its own: its texts_ok and emails_ok are yes/no flags, and the
  // resident's name, phone and email are in residents (above, in REGISTRY), which an erase blanks.
  bulk_bookings: 'a municipality\u2019s bulk pickup stop; the resident\u2019s contact is in residents',
  brief_prefs: 'a staff login\u2019s morning brief setting', morning_briefs: 'the day\u2019s morning brief for staff (counts, no guest names), kept 30 days', brief_sends: 'which staff were sent the morning brief, kept 30 days',
};

// Columns never put in a download: secrets, signatures and payment tokens.
const SECRET = /token|hash|secret|password|totp|pin_|signature|^photo$|stripe|payment_intent|^customer$|payment_method|card_id|ip_hash/;

const q = (n) => '`' + String(n).replace(/`/g, '') + '`';
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

/** The person's identifiers: id, email (lower case) and the 10-digit phone key. */
async function identityOf(db, tenantId, personId) {
  const p = await one(db, 'SELECT id, first_name, last_name, email, phone, phone_key FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]);
  if (!p) return null;
  const key = p.phone_key || digits(p.phone);
  return { id: p.id, email: p.email ? String(p.email).toLowerCase() : null, phone: key && key.length === 10 ? key : null, name: [p.first_name, p.last_name].filter(Boolean).join(' ').trim() };
}

/** WHERE for one registry entry and one person: [sql, params], or null when nothing can match. */
function whereOf(entry, who) {
  const parts = []; const params = [];
  const by = entry.by;
  if (by.key) { parts.push(`${q(by.key)} = ?`); params.push(who.id); }
  for (const c of by.person || []) { parts.push(`${q(c)} = ?`); params.push(who.id); }
  if (who.email) for (const c of by.email || []) { parts.push(`LOWER(${q(c)}) = ?`); params.push(who.email); }
  if (who.phone) for (const c of by.phone || []) { parts.push(`RIGHT(REGEXP_REPLACE(${q(c)}, '[^0-9]', ''), 10) = ?`); params.push(who.phone); }
  if (by.booking) { parts.push(`${q(by.booking)} IN (SELECT lb.id FROM lesson_bookings lb WHERE lb.tenant_id = ${q(entry.table)}.tenant_id AND lb.person_id = ?)`); params.push(who.id); }
  if (by.call && who.phone) { parts.push(`${q(by.call)} IN (SELECT dc.id FROM dispatch_calls dc WHERE dc.tenant_id = ${q(entry.table)}.tenant_id AND RIGHT(REGEXP_REPLACE(dc.caller_phone, '[^0-9]', ''), 10) = ?)`); params.push(who.phone); }
  if (!parts.length) return null;
  return [`(${parts.join(' OR ')})`, params];
}

async function tableNames(db) {
  return new Set((await rows(db, "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'")).map((r) => r.t || r.TABLE_NAME));
}

const clean = (row) => { const o = {}; for (const [k, v] of Object.entries(row)) if (!SECRET.test(k) && !Buffer.isBuffer(v)) o[k] = v; return o; };

/** Assistant questions that name the person (by full name, email or phone). */
function assistantWhere(who) {
  const like = (s) => `%${String(s).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const parts = []; const params = [];
  if (who.name && who.name.includes(' ') && who.name.length >= 5) { parts.push('question LIKE ?'); params.push(like(who.name)); }
  if (who.email) { parts.push('question LIKE ?'); params.push(like(who.email)); }
  if (who.phone) { parts.push("REGEXP_REPLACE(question, '[^0-9]', '') LIKE ?"); params.push(like(who.phone)); }
  return parts.length ? [`(${parts.join(' OR ')})`, params] : null;
}

/**
 * Everything held about one person: { tables: { name: rows }, patrol_records: {...}, kept_on_erase: [...] }.
 * Patrol care rows are counted, not copied: the guest asks patrol for them through a records request.
 */
async function exportOf(db, tenantId, personId) {
  const who = await identityOf(db, tenantId, personId);
  const have = await tableNames(db);
  const tables = {}; const patrol = {};
  for (const e of REGISTRY) {
    if (!have.has(e.table) || e.table === 'people') continue;
    const w = whereOf(e, who); if (!w) continue;
    if (e.group === 'patrol') {
      const r = await one(db, `SELECT COUNT(*) AS n FROM ${q(e.table)} WHERE tenant_id = ? AND ${w[0]}`, [tenantId, ...w[1]]);
      if (Number(r.n)) patrol[e.table] = Number(r.n);
      continue;
    }
    const cols = e.columns ? e.columns.map(q).join(', ') : '*';
    const found = await rows(db, `SELECT ${cols} FROM ${q(e.table)} WHERE tenant_id = ? AND ${w[0]} LIMIT 5000`, [tenantId, ...w[1]]);
    if (found.length) tables[e.table] = found.map(clean);
  }
  const aw = assistantWhere(who);
  if (aw && have.has('assistant_log')) {
    const a = await rows(db, `SELECT created_at, audience, page, question FROM assistant_log WHERE tenant_id = ? AND ${aw[0]} ORDER BY id LIMIT 500`, [tenantId, ...aw[1]]);
    if (a.length) tables.assistant_log = a;
  }
  const n = Object.values(patrol).reduce((s, x) => s + x, 0);
  return {
    tables,
    patrol_records: n
      ? { exists: true, rows: patrol, how_to_request: 'Patrol holds care records that name this guest. They are not in this file. The guest (or a parent) asks the mountain for a copy, and patrol answers it under Patrol, Records requests, where the release is checked and logged.' }
      : { exists: false },
  };
}

/** Blanks names, contacts and health details inside a JSON value; keeps its shape. */
const BLANK = /name|email|phone|birth|dob|allerg|medical|medication|pickup|note|address|guardian|contact/i;
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = BLANK.test(k) && (typeof v === 'string' || typeof v === 'number' || Array.isArray(v) || (v && typeof v === 'object')) ? null : redact(v);
    return o;
  }
  return value;
}
function redactText(text) {
  try { return JSON.stringify(redact(JSON.parse(text))); } catch (_) { return '[]'; }
}

/**
 * Erases one person inside the caller's transaction (conn). The people row itself is blanked by the caller. Returns
 * { changed: { table: rows }, kept: [{ what, why }] } so the screen can say plainly what stayed and why.
 */
async function erase(conn, tenantId, personId, who0) {
  const who = who0 || await identityOf(conn, tenantId, personId);
  const have = await tableNames(conn);
  const changed = {}; const kept = new Map();
  const keep = (why, what, table) => { const k = kept.get(why) || { what: LABEL[what] || what, why, tables: [] }; if (!k.tables.includes(table)) k.tables.push(table); kept.set(why, k); };
  for (const e of REGISTRY) {
    if (!have.has(e.table) || e.table === 'people') continue;
    const w = whereOf(e, who); if (!w) continue;
    if (e.erase === 'delete') {
      const [r] = await conn.query(`DELETE FROM ${q(e.table)} WHERE tenant_id = ? AND ${w[0]}`, [tenantId, ...w[1]]);
      if (r.affectedRows) changed[e.table] = r.affectedRows;
      continue;
    }
    if (e.erase.keep) {
      const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM ${q(e.table)} WHERE tenant_id = ? AND ${w[0]}`, [tenantId, ...w[1]]);
      if (Number(c.n) && e.erase.keep !== KEEP_LINK && e.table !== 'consent_events') keep(e.erase.keep, e.group === 'patrol' ? 'Patrol care records' : e.table, e.table);
      continue;
    }
    if (e.json) {
      const found = await rows(conn, `SELECT id, ${e.json.map(q).join(', ')} FROM ${q(e.table)} WHERE tenant_id = ? AND ${w[0]}`, [tenantId, ...w[1]]);
      for (const r of found) for (const c of e.json) if (r[c] != null) await conn.query(`UPDATE ${q(e.table)} SET ${q(c)} = ? WHERE tenant_id = ? AND id = ?`, [redactText(r[c]), tenantId, r.id]);
    }
    const sets = Object.keys(e.erase.set);
    const [r] = await conn.query(`UPDATE ${q(e.table)} SET ${sets.map((c) => `${q(c)} = ?`).join(', ')} WHERE tenant_id = ? AND ${w[0]}`, [...sets.map((c) => e.erase.set[c]), tenantId, ...w[1]]);
    if (r.affectedRows) { changed[e.table] = r.affectedRows; if (e.why) keep(e.why, e.table, e.table); }
  }
  const aw = assistantWhere(who);
  if (aw && have.has('assistant_log')) {
    const [r] = await conn.query(`UPDATE assistant_log SET question = '[Removed: it named a customer who was erased]', answer = NULL WHERE tenant_id = ? AND ${aw[0]}`, [tenantId, ...aw[1]]);
    if (r.affectedRows) changed.assistant_log = r.affectedRows;
  }
  // The audit trail is add-only, even for the app. Entries written before 2026.11.11 may still show this guest's email.
  if (who.email && have.has('audit_log')) {
    const [[a]] = await conn.query('SELECT COUNT(*) AS n FROM audit_log WHERE tenant_id = ? AND detail LIKE ?', [tenantId, `%${who.email.replace(/[\\%_]/g, (m) => `\\${m}`)}%`]);
    if (Number(a.n)) keep('The audit trail cannot be changed, even by the app. Older entries that show when this guest\u2019s family page was opened still show their email.', 'Audit trail', 'audit_log');
  }
  return { changed, kept: [...kept.values()] };
}
const LABEL = { waivers: 'Signed waivers', waiver_signings: 'Signed waivers', rental_signoffs: 'Signed rental forms', email_suppressions: 'Do-not-email list', staff: 'Staff record', users: 'Sign-in' };

/** A short reference for an email in logs and the audit trail, instead of the address itself. */
const emailRef = (email) => (email ? crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16) : null);

module.exports = { REGISTRY, NOT_GUESTS, exportOf, erase, identityOf, redact, emailRef, KEEP_WAIVER, KEEP_PATROL, KEEP_DISPATCH };
