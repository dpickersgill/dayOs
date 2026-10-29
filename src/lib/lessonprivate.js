'use strict';
// Private lessons asked for by name (Track PAY). A family picks an instructor (or "any instructor"), a day, a time and a
// length on /private/<mountain>, pays by card (or at the desk when card payment is off), and the request waits for that
// instructor to accept until a deadline (school_settings.private_accept_minutes). Accepting makes the lesson (origin
// 'request', format private), books the students through the same rules as every other online booking, and flags the
// request bonus. Declining, or no answer in time, offers the family another instructor who is free then, or refunds them
// in full, by the school's setting (private_decline).
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const config = require('../config');
const { notFound, conflict, bad } = require('./errors');
const { audit } = require('./audit');
const { staffProblems } = require('./workforce');
const { studentClash, clashWords } = require('./lessonrules');
const levels = require('./levels');
const S = require('./schoolsettings');
const familynotify = require('./familynotify');
const mailer = require('./mailer');
const cardrefund = require('./cardrefund');
const { confirmRequest } = require('./onlinesale');
const { unitPrice } = require('./pricing');
const { loadRules, applyTax } = require('./tax');
const { nowIn, addDays } = require('./util');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reference = () => Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const looksRight = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(t);
const OPEN = ['waiting', 'offered'];
const DISCIPLINE_WORDS = { ski: 'ski', snowboard: 'snowboard', telemark: 'telemark', adaptive: 'adaptive' };

const toMin = (t) => { const [a, b] = String(t).slice(0, 5).split(':').map(Number); return a * 60 + b; };
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const plusMinutes = (dt, m) => { const d = new Date(`${String(dt).replace(' ', 'T').slice(0, 19)}Z`); d.setUTCMinutes(d.getUTCMinutes() + m); return d.toISOString().slice(0, 19).replace('T', ' '); };
const clock = (dt) => { const [hh, mm] = String(dt).slice(11, 16).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const dayWords = (dt) => new Date(`${String(dt).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
const lengthWords = (m) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min`);
const ids = (csv) => String(csv || '').split(',').filter(Boolean).map(Number);
const parseJson = (r) => { try { return JSON.parse(r.students) || {}; } catch (_) { return {}; } };
const parseStudents = (r) => parseJson(r).students || [];
const shortName = (r) => (r.display_name || `${r.first_name || ''} ${r.last_name ? `${r.last_name[0]}.` : ''}`).trim();

/** A UTC 'YYYY-MM-DD HH:MM:SS' this many minutes from now. */
const utcIn = (minutes) => new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');

/** The instructor's public profile row joined with their name, or null when they are not listed publicly. */
async function publicInstructor(db, tenantId, staffId) {
  return one(db, `SELECT s.id, p.first_name, p.last_name, ip.display_name, ip.bio, ip.disciplines, ip.ski_level_max, ip.snowboard_level_max, ip.teaches_kids, ip.teaches_adaptive
    FROM instructor_profiles ip JOIN staff s ON s.tenant_id = ip.tenant_id AND s.id = ip.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE ip.tenant_id = ? AND ip.staff_id = ? AND ip.is_public = 1`, [tenantId, staffId]);
}
async function publicInstructors(db, tenantId) {
  return rows(db, `SELECT s.id, p.first_name, p.last_name, ip.display_name, ip.bio, ip.disciplines, ip.ski_level_max, ip.snowboard_level_max, ip.teaches_kids, ip.teaches_adaptive
    FROM instructor_profiles ip JOIN staff s ON s.tenant_id = ip.tenant_id AND s.id = ip.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE ip.tenant_id = ? AND ip.is_public = 1 ORDER BY COALESCE(ip.display_name, p.first_name)`, [tenantId]);
}

/** Does this instructor teach this discipline, level and these students? (An empty disciplines list means any.) */
function teaches(ins, discipline, levelMax, { kids = false } = {}) {
  const list = String(ins.disciplines || '').split(',').filter(Boolean);
  if (list.length && !list.includes(discipline)) return false;
  if (discipline === 'adaptive' && ins.teaches_adaptive === 0) return false;
  if (kids && ins.teaches_kids === 0) return false;
  return levels.instructorCovers(ins, discipline, levelMax);
}

/** The times the instructor is busy on a day: lessons, shifts, patrol shifts and program meetings they coach. */
async function busy(db, tenantId, staffId, day) {
  const next = addDays(day, 1);
  const list = await rows(db, `SELECT starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND instructor_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?
    UNION ALL SELECT starts_at, ends_at FROM shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?
    UNION ALL SELECT starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND staff_id = ? AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?
    UNION ALL SELECT ps.starts_at, ps.ends_at FROM program_sessions ps WHERE ps.tenant_id = ? AND ps.status = 'scheduled' AND ps.starts_at < ? AND ps.ends_at > ?
      AND (ps.coach_staff_id = ? OR EXISTS (SELECT 1 FROM program_levels pl WHERE pl.tenant_id = ps.tenant_id AND pl.group_id = ps.group_id AND pl.coach_staff_id = ?))`,
  [tenantId, staffId, next, day, tenantId, staffId, next, day, tenantId, staffId, next, day, tenantId, next, day, staffId, staffId]);
  // Requests already waiting for this instructor hold their time too, so two families are not promised the same hour.
  const held = await rows(db, "SELECT starts_at, minutes FROM private_requests WHERE tenant_id = ? AND staff_id = ? AND status IN ('awaiting_payment','waiting') AND DATE(starts_at) = ?", [tenantId, staffId, day]);
  return [...list, ...held.map((h) => ({ starts_at: h.starts_at, ends_at: plusMinutes(h.starts_at, h.minutes) }))];
}

/**
 * Start times (every 30 minutes) an instructor can take a private of this length on a day: inside a date they marked
 * open, and clear of everything they already have. earliest: the first allowed start ('YYYY-MM-DD HH:MM:SS', local).
 */
async function freeTimes(db, tenantId, staffId, day, minutes, earliest) {
  const wins = await rows(db, 'SELECT start_time, end_time FROM instructor_open WHERE tenant_id = ? AND staff_id = ? AND open_date = ? ORDER BY start_time', [tenantId, staffId, day]);
  if (!wins.length) return [];
  const taken = (await busy(db, tenantId, staffId, day)).map((b) => [b.starts_at.slice(0, 10) < day ? 0 : toMin(b.starts_at.slice(11, 16)), b.ends_at.slice(0, 10) > day ? 24 * 60 : toMin(b.ends_at.slice(11, 16))]);
  const out = new Set();
  for (const w of wins) {
    const a = toMin(w.start_time); const z = toMin(w.end_time);
    for (let m = Math.ceil(a / 30) * 30; m + minutes <= z; m += 30) {
      const start = `${day} ${fromMin(m)}:00`;
      if (earliest && start < earliest) continue;
      if (taken.some(([x, y]) => x < m + minutes && y > m)) continue;
      out.add(fromMin(m));
    }
  }
  return [...out].sort();
}

/** The public instructors who could take this private: teach it, are open then and are free. exclude: staff ids to leave out. */
async function freeInstructors(db, tenantId, { discipline, levelMax, kids, startsAt, minutes, exclude = [] }) {
  const day = startsAt.slice(0, 10); const t = startsAt.slice(11, 16);
  const out = [];
  for (const ins of await publicInstructors(db, tenantId)) {
    if (exclude.includes(ins.id) || !teaches(ins, discipline, levelMax, { kids })) continue;
    if ((await freeTimes(db, tenantId, ins.id, day, minutes, null)).includes(t)) out.push(ins);
  }
  return out;
}

/** The price: the offer's lesson product for the lesson, plus the extra-student price for each student after the first, with tax. */
async function quote(conn, tenantId, offer, students, day) {
  const priced = [];
  for (const [i, st] of students.entries()) {
    const tier = await require('./guesttypes').forBirthday(conn, tenantId, st.date_of_birth, day);
    if (i === 0) {
      const { product, cents } = await unitPrice(conn, tenantId, offer.product_id, tier, day);
      priced.push({ type: 'lesson', unit: cents, cents, tier, name: product.name });
    } else priced.push({ type: 'lesson', unit: offer.extra_student_cents, cents: offer.extra_student_cents, tier, name: '' });
  }
  const { tax, taxes } = applyTax(priced, 0, await loadRules(conn, tenantId));
  const subtotal = priced.reduce((n, p) => n + p.cents, 0);
  return { lines: priced.map((p) => ({ tier: p.tier, unit: p.unit, tax: p.tax })), subtotal, tax, taxes, total: subtotal + tax, name: priced[0] ? priced[0].name : '' };
}

/** A request by its family link, or null. */
async function byToken(db, tenantId, token) {
  if (!looksRight(token)) return null;
  return one(db, 'SELECT * FROM private_requests WHERE tenant_id = ? AND token_sha = ?', [tenantId, sha(token)]);
}

const tenantRow = (db, tenantId) => one(db, 'SELECT id, slug, name, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
const familyLink = (base, slug, token) => `${base || config.stripe.publicUrl || ''}/private/${encodeURIComponent(slug)}?r=${token}`;

/** The email of a staff member: their login's email, else the email on their person record. */
async function staffContact(db, tenantId, staffId) {
  return one(db, `SELECT s.id, p.first_name, p.last_name, COALESCE((SELECT u.email FROM users u WHERE u.tenant_id = s.tenant_id AND u.staff_id = s.id AND u.active = 1 ORDER BY u.id LIMIT 1), p.email) AS email
    FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?`, [tenantId, staffId]);
}

/** Tells the instructor (or, for "any instructor", every instructor who could take it) that a private is waiting. Never throws. */
async function tellInstructors(tenantId, r) {
  try {
    const t = await tenantRow(pool, tenantId);
    const st = parseStudents(r);
    const levelMax = Math.max(...st.map((s) => Number(s.level) || 1));
    const who = r.staff_id ? [{ id: r.staff_id }] : await freeInstructors(pool, tenantId, { discipline: r.discipline, levelMax, startsAt: r.starts_at, minutes: r.minutes, exclude: ids(r.declined_ids) });
    const deadline = r.deadline_at ? ` Please answer within ${(await S.get(pool, tenantId)).private_accept_minutes} minutes.` : '';
    for (const w of who) {
      const c = await staffContact(pool, tenantId, w.id);
      if (!c || !c.email) continue;
      await mailer.send({ tenantId, to: c.email, fromName: t.name, tag: 'private-request',
        subject: `Private lesson request: ${dayWords(r.starts_at)} at ${clock(r.starts_at)}`,
        text: `Hi ${c.first_name},\n\n${r.staff_id ? 'A family asked for you by name' : 'A family asked for a private with any instructor'}: ${lengthWords(r.minutes)} of ${DISCIPLINE_WORDS[r.discipline]} on ${dayWords(r.starts_at)} at ${clock(r.starts_at)}, for ${st.map((s) => s.first_name).join(' and ')} (${levels.range(Math.min(...st.map((s) => Number(s.level) || 1)), levelMax)}).${deadline}\n\nOpen Ski school, My day, to accept or decline.\n\n${t.name}` });
    }
  } catch (err) { console.error(JSON.stringify({ severity: 'ERROR', job: 'private_tell', message: err.message })); }
}

/** A short note to the family about their request (email always, a text with the add-on and their yes). Never throws. */
async function tellFamily(tenantId, r, { subject, text, sms }) {
  try {
    const t = await tenantRow(pool, tenantId);
    await familynotify.notify({ tenant: t, to: { email: r.contact_email, phone: r.contact_phone, textOk: Boolean(r.text_ok) }, subject, text: `${text}\n\n${t.name}${t.phone ? `, ${t.phone}` : ''}`, smsText: sms, tag: 'private-request' });
  } catch (err) { console.error(JSON.stringify({ severity: 'ERROR', job: 'private_family', message: err.message })); }
}

/**
 * A payment for a request came through (the webhook, or the return check on the family's page). obj: the Stripe
 * checkout session. Starts the instructor's clock. Returns { ok } or { duplicate } or { refunded } (a payment we cannot
 * honor goes back in full).
 */
async function markPaid(tenantId, requestId, obj, account) {
  let problem = null;
  const out = await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!r) { problem = 'the request is not on file'; return null; }
    if (r.payment_intent && r.payment_intent === String(obj.payment_intent)) return { duplicate: true };
    if (await cardrefund.returned(conn, tenantId, obj.payment_intent)) return { duplicate: true };
    if (r.status !== 'awaiting_payment') { problem = `the request was already ${r.status}`; return null; }
    if (r.stripe_session_id && r.stripe_session_id !== obj.id) { problem = 'it was not the card page saved for this request'; return null; }
    if (Number(obj.amount_total) !== Number(r.amount_cents)) { problem = 'the amount did not match'; return null; }
    const s = await S.get(conn, tenantId);
    await conn.query("UPDATE private_requests SET status = 'waiting', payment_intent = ?, payee_account = ?, fee_cents = ?, stripe_session_id = COALESCE(stripe_session_id, ?), deadline_at = ? WHERE tenant_id = ? AND id = ?",
      [String(obj.payment_intent), account || null, Number((obj.metadata || {}).platform_fee_cents) || 0, obj.id, utcIn(s.private_accept_minutes), tenantId, r.id]);
    await audit(conn, { auth: { tenantId, userId: null } }, 'private_paid', 'private_requests', r.id, { amount_cents: r.amount_cents });
    return { ok: true };
  });
  if (problem) {
    const id = await tx((conn) => cardrefund.oweReturn(conn, { tenantId, kind: 'private', rowId: requestId, session: obj.id, paymentIntent: obj.payment_intent, amountCents: Number(obj.amount_total), account, reason: problem }));
    if (id) await cardrefund.sendReturn(id);
    return { refunded: Boolean(id) };
  }
  if (out && out.ok) await afterWaiting(tenantId, requestId);
  return out;
}

/** Once a request is waiting: tell the instructor(s) and the family. */
async function afterWaiting(tenantId, requestId) {
  const r = await one(pool, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ?', [tenantId, requestId]);
  await tellInstructors(tenantId, r);
  const who = r.staff_id ? (await staffContact(pool, tenantId, r.staff_id)).first_name : 'our instructors';
  const mins = (await S.get(pool, tenantId)).private_accept_minutes;
  await tellFamily(tenantId, r, {
    subject: `Your private lesson request (${r.reference})`,
    text: `Thank you. We sent your request for ${dayWords(r.starts_at)} at ${clock(r.starts_at)} to ${who}. You will hear back within ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}.${r.pay_at_desk ? ' You pay at the ski school desk.' : ' If the lesson cannot go ahead, you get your money back in full.'}`,
    sms: `${who === 'our instructors' ? 'Your private lesson request was sent' : `We asked ${who} about your private lesson`}. We will text you when they answer.`,
  });
}

/**
 * The instructor (or a manager or the desk, by hand) takes the request: makes the lesson, books the students and records
 * the sale, all in one transaction. Throws 409 with the problems when the instructor is not free or a student is already
 * somewhere else then. Returns { session_id, booking_ids }.
 */
async function accept(req, requestId, staffId, { byHand = false } = {}) {
  const { tenantId } = req.auth;
  const done = await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!r) throw notFound('Private request');
    if (!OPEN.includes(r.status)) throw conflict(`This request is already ${r.status === 'accepted' ? 'accepted' : r.status}`);
    if (!byHand && r.status !== 'waiting') throw conflict('This request is waiting for the family to choose another instructor');
    if (!byHand && r.staff_id && r.staff_id !== staffId) throw conflict('This request was sent to another instructor');
    if (!byHand && ids(r.declined_ids).includes(staffId)) throw conflict('You already declined this request');
    const offer = await one(conn, 'SELECT * FROM private_offers WHERE tenant_id = ? AND id = ?', [tenantId, r.offer_id]);
    const st = parseStudents(r);
    const lv = st.map((s) => Number(s.level) || 1);
    const endsAt = plusMinutes(r.starts_at, r.minutes);
    const problems = await staffProblems(conn, tenantId, { staffId, startsAt: r.starts_at, endsAt, skipAvailability: true });
    if (problems.length) throw conflict(byHand ? 'That instructor cannot take this lesson' : 'You cannot take this lesson', problems);
    const [ins] = await conn.query(`INSERT INTO lesson_sessions (tenant_id, product_id, discipline, ability_level, format, age_group, meeting_place, notes, starts_at, ends_at, capacity, instructor_id, level_min, level_max, origin)
      VALUES (?, ?, ?, ?, 'private', 'all', ?, ?, ?, ?, ?, ?, ?, ?, 'request')`,
    [tenantId, r.product_id, r.discipline, levels.toLegacy(Math.max(...lv)) || 'beginner', offer ? offer.meeting_place : null, r.note ? `Family note: ${r.note}`.slice(0, 1000) : null, r.starts_at, endsAt, Math.min(Math.max(st.length, 1), 6), staffId, Math.min(...lv), Math.max(...lv)]);
    const sessionId = ins.insertId;
    // The booking goes through the same steps as a paid online request (people, waivers, bookings, the sale), so canceling
    // it later from the booking page uses the same policy and refunds.
    const studentsJson = JSON.stringify({ contact: parseJson(r).contact || {},
      students: st.map((s) => ({ first_name: s.first_name, last_name: s.last_name, date_of_birth: s.date_of_birth, sex: s.sex, discipline: r.discipline, ability_level: levels.toLegacy(Number(s.level) || 1) || undefined })),
      quote: r.pay_at_desk ? null : JSON.parse(r.quote_json || 'null') });
    let ref = r.reference;
    let lrId = null;
    for (let attempt = 0; attempt < 5 && !lrId; attempt += 1) {
      try {
        const [lr] = await conn.query(`INSERT INTO lesson_requests (tenant_id, session_id, reference, contact_name, contact_email, contact_phone, students, waiver_accepted, waiver_text_sha, note, status, amount_cents, policy_accepted, stripe_session_id, payment_intent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)`, [tenantId, sessionId, ref, r.contact_name, r.contact_email, r.contact_phone, studentsJson, r.waiver_accepted, r.waiver_text_sha, r.note, r.pay_at_desk ? 0 : r.amount_cents, r.stripe_session_id, r.payment_intent]);
        lrId = lr.insertId;
      } catch (err) { if (err.code !== 'ER_DUP_ENTRY') throw err; ref = reference(); }
    }
    const raw = await one(conn, 'SELECT * FROM lesson_requests WHERE tenant_id = ? AND id = ?', [tenantId, lrId]);
    const res = await confirmRequest(conn, tenantId, raw, { paid: !r.pay_at_desk, auditReq: req, paymentIntent: r.payment_intent, payee: { account: r.payee_account, feeCents: r.fee_cents } });
    const bookingIds = [];
    for (const [i, b] of res.booked.entries()) {
      const c = await studentClash(conn, tenantId, b.person_id, r.starts_at, endsAt, { ignoreSessionId: sessionId });
      if (c) throw conflict(`${b.name}: ${clashWords(c)}`);
      const s = st[i] || {};
      await conn.query(`UPDATE lesson_bookings SET requested_instructor_id = ?, allergies = ?, medical = ?, contact_name = ?, contact_phone = ?, contact_email = ?, text_ok = ?, photo_ok = ?, level = ?
        WHERE tenant_id = ? AND id = ?`, [r.staff_id ? staffId : null, s.allergies || null, s.medical || null, r.contact_name, r.contact_phone, r.contact_email, r.text_ok ? 1 : 0, s.photo_ok ? 1 : 0, Number(s.level) || null, tenantId, b.booking_id]);
      // The family's own level for the student, when nothing better is on file yet.
      if (Number(s.level)) await conn.query(`UPDATE people SET ${levels.personColumn(r.discipline)} = ?, level_source = 'quiz', level_set_at = NOW() WHERE tenant_id = ? AND id = ? AND ${levels.personColumn(r.discipline)} IS NULL`, [Number(s.level), tenantId, b.person_id]);
      bookingIds.push(b.booking_id);
    }
    await conn.query("UPDATE private_requests SET status = 'accepted', staff_id = ?, session_id = ?, lesson_request_id = ?, decided_by = ?, decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?",
      [staffId, sessionId, lrId, req.auth.userId || null, tenantId, r.id]);
    await audit(conn, req, byHand ? 'private_assign' : 'private_accept', 'private_requests', r.id, { staff_id: staffId, session_id: sessionId });
    return { session_id: sessionId, booking_ids: bookingIds, r };
  });
  // The confirmation (CORE's lessonconfirm) goes to the family for each booking. Until it is built, a short note says yes.
  const base = req.get ? require('./baseurl').baseUrl(req) : (config.stripe.publicUrl || '');
  let confirmed = false;
  for (const id of done.booking_ids) {
    try { const c = await require('./lessonconfirm').sendConfirmation(pool, tenantId, id, base); if (c && c.ok) confirmed = true; } catch (_) { /* never stops the accept */ }
  }
  if (!confirmed) {
    const who = await staffContact(pool, tenantId, staffId);
    await tellFamily(tenantId, done.r, { subject: `Your private lesson is booked (${done.r.reference})`,
      text: `Good news: ${who.first_name} will teach your private lesson on ${dayWords(done.r.starts_at)} at ${clock(done.r.starts_at)} (${lengthWords(done.r.minutes)}).${done.r.pay_at_desk ? ' Please pay at the ski school desk before the lesson.' : ''}`,
      sms: `${who.first_name} will teach your private lesson on ${dayWords(done.r.starts_at)} at ${clock(done.r.starts_at)}. See you on the hill.` });
  }
  return { session_id: done.session_id, booking_ids: done.booking_ids };
}

/** Writes a full refund of a paid request as owed (inside the transaction). Returns the card return id, or null. */
async function oweRefund(conn, tenantId, r, why) {
  if (r.pay_at_desk || !r.payment_intent) return null;
  await conn.query('UPDATE private_requests SET refund_cents = ? WHERE tenant_id = ? AND id = ?', [r.amount_cents, tenantId, r.id]);
  return cardrefund.oweReturn(conn, { tenantId, kind: 'private', rowId: r.id, session: r.stripe_session_id, paymentIntent: r.payment_intent, amountCents: r.amount_cents, account: r.payee_account, reason: why });
}

/**
 * The named instructor declined, or nobody answered in time. By the school's setting the family is offered the other
 * instructors free then (a link to pick one) or refunded in full straight away. A request with nobody else free is refunded.
 * Returns { outcome: 'offered'|'refunded'|'declined' }.
 */
async function decline(tenantId, requestId, { staffId = null, why, auditReq = null, expired = false }) {
  let outcome = null; let returnId = null;
  const r0 = await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!r) throw notFound('Private request');
    if (r.status !== 'waiting') throw conflict(`This request is already ${r.status}`);
    if (staffId && r.staff_id && r.staff_id !== staffId) throw conflict('This request was sent to another instructor');
    const declined = [...new Set([...ids(r.declined_ids), ...(r.staff_id ? [r.staff_id] : []), ...(staffId ? [staffId] : [])])];
    // "Any instructor": one instructor saying no leaves it open for the others until the deadline.
    if (!r.staff_id && staffId && !expired) {
      await conn.query('UPDATE private_requests SET declined_ids = ? WHERE tenant_id = ? AND id = ?', [declined.join(','), tenantId, r.id]);
      outcome = 'passed';
      return r;
    }
    const s = await S.get(conn, tenantId);
    const st = parseStudents(r);
    const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
    const future = r.starts_at > nowIn(tz);
    const others = s.private_decline === 'offer_other' && future
      ? await freeInstructors(conn, tenantId, { discipline: r.discipline, levelMax: Math.max(...st.map((x) => Number(x.level) || 1)), startsAt: r.starts_at, minutes: r.minutes, exclude: declined }) : [];
    if (others.length) {
      await conn.query("UPDATE private_requests SET status = 'offered', staff_id = NULL, declined_ids = ?, deadline_at = NULL, staff_note = ? WHERE tenant_id = ? AND id = ?", [declined.join(','), String(why || '').slice(0, 300) || null, tenantId, r.id]);
      outcome = 'offered';
    } else {
      returnId = await oweRefund(conn, tenantId, r, why || 'the instructor could not take the lesson');
      await conn.query('UPDATE private_requests SET status = ?, declined_ids = ?, decided_at = UTC_TIMESTAMP(), staff_note = ? WHERE tenant_id = ? AND id = ?', [r.pay_at_desk ? 'declined' : 'refunded', declined.join(','), String(why || '').slice(0, 300) || null, tenantId, r.id]);
      outcome = r.pay_at_desk ? 'declined' : 'refunded';
    }
    await audit(conn, auditReq || { auth: { tenantId, userId: null } }, expired ? 'private_expired' : 'private_decline', 'private_requests', r.id, { outcome, staff_id: staffId });
    return r;
  });
  if (returnId) await cardrefund.sendReturn(returnId);
  if (outcome === 'passed') return { outcome };
  const t = await tenantRow(pool, tenantId);
  const who = r0.staff_id ? (await staffContact(pool, tenantId, r0.staff_id)).first_name : 'No instructor';
  const when = `${dayWords(r0.starts_at)} at ${clock(r0.starts_at)}`;
  if (outcome === 'offered') {
    const token = newToken();
    await pool.query('UPDATE private_requests SET token_sha = ? WHERE tenant_id = ? AND id = ?', [sha(token), tenantId, r0.id]);
    const link = familyLink(null, t.slug, token);
    await tellFamily(tenantId, r0, { subject: `Pick another instructor for ${dayWords(r0.starts_at)}`,
      text: `${who} cannot teach your private lesson on ${when}. Other instructors are free then. Pick one, or ask for a full refund, here:\n${link}`,
      sms: `${who} cannot teach your private on ${when}. Pick another instructor or get a full refund: ${link}` });
  } else {
    await tellFamily(tenantId, r0, { subject: `Your private lesson request (${r0.reference})`,
      text: `We are sorry: we could not find an instructor for your private lesson on ${when}.${outcome === 'refunded' ? ' Your payment is refunded in full to your card. It can take 5 to 10 days to show.' : ''} Please call us if another time works.`,
      sms: `Sorry, no instructor is free for your private on ${when}.${outcome === 'refunded' ? ' Your payment is refunded in full.' : ''}` });
  }
  return { outcome };
}

/** The family picks another instructor from the offer: the clock starts again for that instructor. */
async function pick(tenantId, requestId, staffId) {
  await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!r || r.status !== 'offered') throw conflict('This request is not waiting for a choice');
    const st = parseStudents(r);
    const free = await freeInstructors(conn, tenantId, { discipline: r.discipline, levelMax: Math.max(...st.map((x) => Number(x.level) || 1)), startsAt: r.starts_at, minutes: r.minutes, exclude: ids(r.declined_ids) });
    if (!free.some((f) => f.id === staffId)) throw conflict('That instructor is no longer free then. Please pick another.');
    const s = await S.get(conn, tenantId);
    await conn.query("UPDATE private_requests SET status = 'waiting', staff_id = ?, any_instructor = 0, deadline_at = ? WHERE tenant_id = ? AND id = ?", [staffId, utcIn(s.private_accept_minutes), tenantId, r.id]);
    await audit(conn, { auth: { tenantId, userId: null } }, 'private_pick', 'private_requests', r.id, { staff_id: staffId });
  });
  await afterWaiting(tenantId, requestId);
}

/** The family asks for their money back before anyone accepted (waiting or offered). */
async function refundByFamily(tenantId, requestId) {
  let returnId = null; let r0;
  await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM private_requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, requestId]);
    if (!r || !OPEN.includes(r.status)) throw conflict(r && r.status === 'accepted' ? 'This lesson is already booked. Cancel it from the booking page under the cancellation policy.' : 'This request is already closed');
    returnId = await oweRefund(conn, tenantId, r, 'the family canceled before an instructor accepted');
    await conn.query("UPDATE private_requests SET status = ?, decided_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND id = ?", [r.pay_at_desk ? 'cancelled' : 'refunded', tenantId, r.id]);
    await audit(conn, { auth: { tenantId, userId: null } }, 'private_family_cancel', 'private_requests', r.id, {});
    r0 = r;
  });
  if (returnId) await cardrefund.sendReturn(returnId);
  return { refund_cents: r0.pay_at_desk ? 0 : r0.amount_cents };
}

/**
 * The 5-minute job: a request whose instructor has not answered by the deadline is declined for them; an offer the
 * family has not answered by 2 hours before the lesson is refunded; an unpaid card page older than 2 hours is closed.
 */
async function tick() {
  const late = await rows(pool, "SELECT id, tenant_id FROM private_requests WHERE status = 'waiting' AND deadline_at IS NOT NULL AND deadline_at < UTC_TIMESTAMP() LIMIT 50");
  let expired = 0; let lapsed = 0;
  for (const r of late) {
    try { await decline(r.tenant_id, r.id, { why: 'no answer in time', expired: true }); expired += 1; } catch (err) { if (err.status !== 409) throw err; }
  }
  const offers = await rows(pool, "SELECT r.id, r.tenant_id, r.starts_at, t.timezone FROM private_requests r JOIN tenants t ON t.id = r.tenant_id WHERE r.status = 'offered' LIMIT 200");
  for (const o of offers) {
    if (plusMinutes(nowIn(o.timezone), 120) < o.starts_at) continue;
    try {
      await refundByFamily(o.tenant_id, o.id);
      await pool.query("UPDATE private_requests SET staff_note = 'No instructor was picked in time, so it was refunded' WHERE tenant_id = ? AND id = ?", [o.tenant_id, o.id]);
      lapsed += 1;
    } catch (err) { if (err.status !== 409) throw err; }
  }
  const [x] = await pool.query("UPDATE private_requests SET status = 'expired' WHERE status = 'awaiting_payment' AND created_at < UTC_TIMESTAMP() - INTERVAL 2 HOUR");
  return { expired, lapsed, unpaid_closed: x.affectedRows };
}

module.exports = { sha, newToken, looksRight, reference, plusMinutes, clock, dayWords, lengthWords, ids, parseStudents, shortName, utcIn,
  publicInstructor, publicInstructors, teaches, freeTimes, freeInstructors, quote, byToken, familyLink, staffContact, tellFamily,
  markPaid, afterWaiting, accept, decline, pick, refundByFamily, tick, OPEN };
