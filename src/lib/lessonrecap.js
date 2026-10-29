'use strict';
// Lesson recaps (Track PARENTS). After a lesson ends, its instructor writes each student a short recap: the skills they
// can now do (ticked from the level's "I can" skills), the level they are at now, a note, and up to two photos for a
// child whose family said yes to photos. With AI recaps on (Assistant Plus, or lesson_ai), the writer drafts the words
// from the first name, the ticked skills and the note only. Nothing goes to the family until the instructor approves it.
// The family gets a link to their lesson page with the recap and, when the school takes tips, a way to tip.
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { nowIn, todayIn } = require('./util');
const { conflict, notFound, forbidden, bad } = require('./errors');
const { audit } = require('./audit');
const L = require('./levels');
const S = require('./schoolsettings');
const F = require('./lessonfamily');
const { notify, aiRecapsOn } = require('./familynotify');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const MAX_PHOTOS = 2;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // resized on the phone to 1600 px, so well under this
const KEEP_PHOTO_DAYS = 90;
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);

/** Makes the recap rows for lessons that ended (within `hours`) and have no recap yet. Returns how many were made. */
async function ensureDue(db, tenantId, nowLocal, { hours = 2, staffId = null } = {}) {
  const from = F.plusMinutes(nowLocal, -hours * 60);
  const [r] = await db.query(`INSERT IGNORE INTO lesson_recaps (tenant_id, booking_id, session_id, person_id, staff_id, status)
    SELECT b.tenant_id, b.id, s.id, b.person_id, s.instructor_id, 'due' FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id
    WHERE b.tenant_id = ? AND b.status IN ('booked','attended') AND s.status <> 'cancelled' AND s.ends_at <= ? AND s.ends_at >= ?${staffId ? ' AND s.instructor_id = ?' : ''}`,
  [tenantId, nowLocal, from, ...(staffId ? [staffId] : [])]);
  return r.affectedRows;
}

/** Every few minutes: lessons that ended in the last 2 hours get their recaps ready for the instructor. */
async function tick() {
  let made = 0;
  const tenants = await rows(pool, `SELECT DISTINCT t.id, t.timezone FROM tenants t JOIN lesson_sessions s ON s.tenant_id = t.id
    WHERE s.ends_at BETWEEN DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY) AND DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY)`);
  for (const t of tenants) {
    if (!(await S.get(pool, t.id)).recap_on) continue;
    made += await ensureDue(pool, t.id, nowIn(t.timezone), { hours: 2 });
  }
  return made;
}

/** Once a day: recap photos are deleted after 90 days. */
async function cleanup() {
  const [r] = await pool.query('DELETE FROM lesson_recap_photos WHERE created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY)', [KEEP_PHOTO_DAYS]);
  return r.affectedRows;
}

/** The "I can" skills for a level (and the next), from the school's own list, else the plain words from levels.js. */
async function skillsFor(db, tenantId, discipline, level) {
  const disc = ['ski', 'snowboard'].includes(discipline) ? discipline : 'ski';
  const out = [];
  for (const n of [level, level + 1].filter((x) => L.valid(x))) {
    const list = await rows(db, `SELECT k.id, k.name FROM school_skills k JOIN school_levels l ON l.tenant_id = k.tenant_id AND l.id = k.level_id
      WHERE k.tenant_id = ? AND l.discipline = ? AND l.rank_no = ? ORDER BY k.sort_no, k.id`, [tenantId, disc, n]);
    if (list.length) out.push(...list.map((k) => ({ id: k.id, name: k.name, level: n })));
    else out.push({ id: null, name: (disc === 'snowboard' ? L.SNOWBOARD : L.SKI)[n].can, level: n });
  }
  return out;
}

/** The recaps an instructor still has to send (managers: everyone's), grouped by lesson, last 7 days. */
async function listFor(req) {
  const tenantId = req.auth.tenantId;
  const set = await S.get(pool, tenantId);
  if (!set.recap_on) return { on: false, lessons: [] };
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const nowLocal = nowIn(t.timezone);
  const mine = !isManager(req);
  if (mine && !req.auth.staffId) return { on: true, lessons: [], ai: false, photos: Boolean(set.recap_photos) };
  await ensureDue(pool, tenantId, nowLocal, { hours: 72, staffId: mine ? req.auth.staffId : null });
  const list = await rows(pool, `SELECT r.id, r.booking_id, r.status, r.skills, r.level, r.note, r.body, r.ai_used, s.id AS session_id, s.starts_at, s.ends_at, s.discipline, s.level_min, s.level_max, s.instructor_id,
      pr.name AS product, p.first_name, p.last_name, p.ski_level, p.snowboard_level, b.photo_ok, b.level AS booked_level,
      (SELECT COUNT(*) FROM lesson_recap_photos ph WHERE ph.tenant_id = r.tenant_id AND ph.recap_id = r.id) AS photos
    FROM lesson_recaps r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN lesson_bookings b ON b.tenant_id = r.tenant_id AND b.id = r.booking_id JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id
    WHERE r.tenant_id = ? AND r.status IN ('due','draft') AND b.status IN ('booked','attended') AND s.ends_at >= ?${mine ? ' AND s.instructor_id = ?' : ''}
    ORDER BY s.starts_at, p.first_name`, [tenantId, `${require('./util').addDays(nowLocal.slice(0, 10), -7)} 00:00:00`, ...(mine ? [req.auth.staffId] : [])]);
  const lessons = new Map();
  for (const r of list) {
    if (!lessons.has(r.session_id)) lessons.set(r.session_id, { session_id: r.session_id, starts_at: r.starts_at, ends_at: r.ends_at, product: r.product, discipline: r.discipline, level_words: L.range(r.level_min, r.level_max), students: [] });
    const now = L.personLevel(r, r.discipline) || r.booked_level || r.level_min || 1;
    let skills = []; try { skills = JSON.parse(r.skills || '[]'); } catch (_) { skills = []; }
    lessons.get(r.session_id).students.push({
      booking_id: r.booking_id, first_name: r.first_name, last_name: r.last_name, status: r.status, photo_ok: Boolean(r.photo_ok), photos: Number(r.photos),
      level_now: Number(now), skills_offered: await skillsFor(pool, tenantId, r.discipline, Number(now)), skills, level: r.level, note: r.note, body: r.body,
    });
  }
  return { on: true, ai: await aiRecapsOn(tenantId), photos: Boolean(set.recap_photos), lessons: [...lessons.values()] };
}

/** How many recaps this instructor still has to send (for My day). */
async function recapCount(req) {
  if (!req.auth.staffId) return 0;
  const r = await one(pool, `SELECT COUNT(*) AS n FROM lesson_recaps r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id
    WHERE r.tenant_id = ? AND s.instructor_id = ? AND r.status IN ('due','draft') AND r.created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY)`, [req.auth.tenantId, req.auth.staffId]);
  return Number(r.n);
}

/** The recap for a booking, if this person may write it: the lesson's instructor, or a manager. Locked for the change. */
async function recapOf(conn, req, bookingId) {
  const r = await one(conn, `SELECT r.*, s.instructor_id, s.discipline, s.starts_at, s.ends_at, pr.name AS product, b.photo_ok, b.contact_email, b.contact_phone, b.text_ok, b.request_id, b.token_sha,
      p.first_name, p.email AS person_email
    FROM lesson_recaps r JOIN lesson_sessions s ON s.tenant_id = r.tenant_id AND s.id = r.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
    JOIN lesson_bookings b ON b.tenant_id = r.tenant_id AND b.id = r.booking_id JOIN people p ON p.tenant_id = r.tenant_id AND p.id = r.person_id
    WHERE r.tenant_id = ? AND r.booking_id = ?${conn === pool ? '' : ' FOR UPDATE'}`, [req.auth.tenantId, bookingId]);
  if (!r) throw notFound('Recap');
  if (!isManager(req) && (!req.auth.staffId || Number(r.instructor_id) !== Number(req.auth.staffId))) throw forbidden('Only the lesson\'s instructor can write this recap');
  return r;
}

/** Cleans the ticked skills: only names offered for this student's levels, at most 12. */
function cleanSkills(skills) {
  return (Array.isArray(skills) ? skills : []).slice(0, 12).map((s) => ({ id: s && s.id ? Number(s.id) : null, name: String((s && s.name) || s || '').trim().slice(0, 200) })).filter((s) => s.name);
}

/** Saves what the instructor has so far (not sent). */
async function saveDraft(req, bookingId, b) {
  return tx(async (conn) => {
    const r = await recapOf(conn, req, bookingId);
    if (r.status === 'sent') throw conflict('This recap was already sent');
    await conn.query("UPDATE lesson_recaps SET status = 'draft', skills = ?, level = ?, note = ?, body = ? WHERE tenant_id = ? AND id = ?",
      [JSON.stringify(cleanSkills(b.skills)), L.valid(Number(b.level)) ? Number(b.level) : null, b.note ?? r.note, b.body ?? r.body, req.auth.tenantId, r.id]);
    return { ok: true };
  });
}

/**
 * The AI writer drafts the recap from the first name, the ticked skills, the level words and the instructor's note. No
 * allergies, medical notes, photos, last names or contact details are sent. Only with AI recaps on.
 */
async function aiDraft(req, bookingId, b) {
  if (!(await aiRecapsOn(req.auth.tenantId))) throw forbidden('AI recaps are not on for this mountain');
  const r = await recapOf(pool, req, bookingId);
  const skills = cleanSkills(b.skills).map((s) => s.name);
  const level = L.valid(Number(b.level)) ? L.name(Number(b.level), r.discipline) : null;
  const note = String(b.note || '').slice(0, 1000);
  const config = require('../config');
  const A = require('./assistant');
  const sport = r.discipline === 'snowboard' ? 'snowboard' : 'ski';
  const out = await A.callModel({
    model: config.assistant.model,
    system: `You write short, warm lesson recaps that a ${sport} instructor sends to a family after a lesson. Write 3 to 5 plain sentences in US English, to the family, about the student by first name. Mention what they can do now and one thing to practice next. No em dashes, no emojis, no made-up facts. Write only the recap.`,
    messages: [{ role: 'user', content: `Student first name: ${r.first_name}\nSkills ticked today: ${skills.length ? skills.join('; ') : '(none ticked)'}\nLevel now: ${level || '(not set)'}\nInstructor's note: ${note || '(none)'}` }],
  });
  const text = (out.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim().replace(/—|–/g, ',');
  await pool.query('UPDATE lesson_recaps SET ai_used = 1 WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, r.id]);
  return { body: text };
}

/**
 * The instructor approves and sends the recap: the level they set goes on the student (level_source 'instructor'), the
 * ticked skills on their report card, and the family gets the link by email (and a text with the add-on).
 */
async function approveAndSend(req, bookingId, b, base) {
  const body = String(b.body || '').trim();
  if (body.length < 10) throw bad('Write a few words to the family before sending');
  const t = await one(pool, 'SELECT id, name, slug, timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const out = await tx(async (conn) => {
    const r = await recapOf(conn, req, bookingId);
    if (r.status === 'sent') throw conflict('This recap was already sent');
    const level = L.valid(Number(b.level)) ? Number(b.level) : null;
    const skills = cleanSkills(b.skills);
    const token = crypto.randomBytes(24).toString('base64url');
    await conn.query("UPDATE lesson_recaps SET status = 'sent', skills = ?, level = ?, note = ?, body = ?, token_sha = ?, approved_by = ?, sent_at = NOW() WHERE tenant_id = ? AND id = ?",
      [JSON.stringify(skills), level, b.note ?? r.note, body.slice(0, 4000), sha(token), req.auth.userId, t.id, r.id]);
    if (level) {
      const col = L.personColumn(r.discipline);
      const before = await one(conn, `SELECT ${col} AS lv FROM people WHERE tenant_id = ? AND id = ?`, [t.id, r.person_id]);
      await conn.query(`UPDATE people SET ${col} = ?, level_source = 'instructor', level_set_at = NOW() WHERE tenant_id = ? AND id = ?`, [level, t.id, r.person_id]);
      if (Number(before && before.lv) !== level) await conn.query('INSERT INTO student_progress (tenant_id, person_id, discipline, level, notes, recorded_by) VALUES (?, ?, ?, ?, ?, ?)', [t.id, r.person_id, r.discipline, level, 'Set on the lesson recap', req.auth.userId]);
    }
    const day = todayIn(t.timezone);
    for (const s of skills.filter((x) => x.id)) {
      const ok = await one(conn, 'SELECT id FROM school_skills WHERE tenant_id = ? AND id = ?', [t.id, s.id]);
      if (ok) await conn.query('INSERT IGNORE INTO student_skills (tenant_id, person_id, skill_id, passed_on, user_id) VALUES (?, ?, ?, ?, ?)', [t.id, r.person_id, s.id, day, req.auth.userId]);
    }
    await audit(conn, req, 'recap_send', 'lesson_recaps', r.id, { booking_id: r.booking_id, level, skills: skills.length });
    let email = r.contact_email;
    if (!email && r.request_id) email = (await one(conn, 'SELECT contact_email FROM lesson_requests WHERE tenant_id = ? AND id = ?', [t.id, r.request_id]) || {}).contact_email;
    return { r, token, email: email || r.person_email };
  });
  const link = `${base}/lesson/${encodeURIComponent(t.slug)}/${out.token}`;
  const sent = await notify({ tenant: t, to: { email: out.email, phone: out.r.contact_phone, textOk: Boolean(out.r.text_ok) }, tag: 'lesson-recap',
    subject: `${out.r.first_name}'s lesson recap from ${t.name}`,
    text: [`Hi,`, '', body, '', `See the whole recap${(await S.get(pool, t.id)).tips_on ? ', the progress card and a way to thank the instructor' : ' and the progress card'}: ${link}`, '', t.name].join('\n'),
    smsText: `${t.name}: ${out.r.first_name}'s lesson recap is ready: ${link}` });
  return { ok: true, sent: { email: Boolean(sent.email && sent.email.ok !== false), text: Boolean(sent.text && sent.text.ok !== false) } };
}

/** Skips a recap (a student who left early, say). */
async function skip(req, bookingId) {
  return tx(async (conn) => {
    const r = await recapOf(conn, req, bookingId);
    if (r.status === 'sent') throw conflict('This recap was already sent');
    await conn.query("UPDATE lesson_recaps SET status = 'skipped' WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, r.id]);
    await audit(conn, req, 'recap_skip', 'lesson_recaps', r.id, {});
    return { ok: true };
  });
}

/** Adds a photo to a recap: only for a child whose family said yes, and only when the school allows recap photos. */
async function addPhoto(req, bookingId, buf) {
  if (!(await S.get(pool, req.auth.tenantId)).recap_photos) throw forbidden('Recap photos are turned off for this ski school');
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  if (buf.length > MAX_PHOTO_BYTES) throw bad('That photo is too big. Try again: it is made smaller on your phone.');
  const mime = require('./exif').sniff(buf);
  if (!mime || mime === 'image/heic') throw bad('That file is not a photo we can show (JPEG, PNG or WebP)');
  return tx(async (conn) => {
    const r = await recapOf(conn, req, bookingId);
    if (!Number(r.photo_ok)) throw forbidden('This family has not said yes to photos');
    if (r.status === 'sent') throw conflict('This recap was already sent');
    const { n } = await one(conn, 'SELECT COUNT(*) AS n FROM lesson_recap_photos WHERE tenant_id = ? AND recap_id = ?', [req.auth.tenantId, r.id]);
    if (Number(n) >= MAX_PHOTOS) throw conflict(`Up to ${MAX_PHOTOS} photos per recap`);
    const [p] = await conn.query('INSERT INTO lesson_recap_photos (tenant_id, recap_id, booking_id, mime, bytes, data, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [req.auth.tenantId, r.id, r.booking_id, mime, buf.length, buf, req.auth.userId]);
    if (r.status === 'due') await conn.query("UPDATE lesson_recaps SET status = 'draft' WHERE tenant_id = ? AND id = ?", [req.auth.tenantId, r.id]);
    await audit(conn, req, 'recap_photo_add', 'lesson_recaps', r.id, { photo_id: p.insertId });
    return { id: p.insertId };
  });
}

async function photosOf(req, bookingId) {
  const r = await recapOf(pool, req, bookingId);
  return (await rows(pool, 'SELECT id, bytes, created_at FROM lesson_recap_photos WHERE tenant_id = ? AND recap_id = ? ORDER BY id', [req.auth.tenantId, r.id]));
}

async function removePhoto(req, bookingId, photoId) {
  return tx(async (conn) => {
    const r = await recapOf(conn, req, bookingId);
    if (r.status === 'sent') throw conflict('This recap was already sent');
    const [d] = await conn.query('DELETE FROM lesson_recap_photos WHERE tenant_id = ? AND recap_id = ? AND id = ?', [req.auth.tenantId, r.id, photoId]);
    if (!d.affectedRows) throw notFound('Photo');
    await audit(conn, req, 'recap_photo_remove', 'lesson_recaps', r.id, { photo_id: photoId });
    return { ok: true };
  });
}

/** A photo's bytes, for staff who may write the recap. */
async function staffPhoto(req, bookingId, photoId) {
  const r = await recapOf(pool, req, bookingId);
  const p = await one(pool, 'SELECT mime, data FROM lesson_recap_photos WHERE tenant_id = ? AND recap_id = ? AND id = ?', [req.auth.tenantId, r.id, photoId]);
  if (!p) throw notFound('Photo');
  return p;
}

/** A photo's bytes for the family: their booking's recap, sent, and the family still says yes to photos. */
async function familyPhoto(tenantId, booking, photoId) {
  if (!booking.photo_ok) return null;
  return one(pool, `SELECT ph.mime, ph.data FROM lesson_recap_photos ph JOIN lesson_recaps r ON r.tenant_id = ph.tenant_id AND r.id = ph.recap_id
    WHERE ph.tenant_id = ? AND ph.booking_id = ? AND ph.id = ? AND r.status = 'sent'`, [tenantId, booking.id, photoId]);
}

module.exports = { ensureDue, tick, cleanup, skillsFor, listFor, recapCount, saveDraft, aiDraft, approveAndSend, skip, addPhoto, photosOf, removePhoto, staffPhoto, familyPhoto, MAX_PHOTOS, KEEP_PHOTO_DAYS };
