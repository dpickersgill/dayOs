'use strict';
// School and group programs (feat/school-pay). A school or club books a weekly program (for example six Tuesdays after
// school). It is a Programs program underneath (programs, program_sessions, program_enrollments), so instructors see the
// meetings and the children on My day, attendance works as for any program, and coaching is paid as a program meeting.
// On top of it (group_programs):
//   - a private booking link for the group leader, with a deadline (by default 72 hours before the first meeting): they
//     fill the roster and the chaperone plan there until then
//   - each child gets a waiver link for a parent or guardian to sign (the leader sends it, or it is emailed when the
//     leader gives the parent's email)
//   - the chaperone plan: names and phones, with the number needed for the group's size (one per per_chaperone children)
//   - drop-off and pickup recorded per group for each meeting: when, by whom, how many children
// router is mounted at /skischool (staff), publicRouter under /public (the link is the key; no sign-in).
const express = require('express');
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { rateLimit } = require('../middleware/rateLimit');
const { z, dateStr, validate, paramId, todayIn, nowIn, addDays, seasonFor } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const SA = require('../lib/schoolaccess');
const modules = require('../lib/modules');
const { baseUrl } = require('../lib/baseurl');
const { ON_FILE } = require('../lib/waivers');

const router = express.Router();
const publicRouter = express.Router();
const director = SA.school('director');
const desk = SA.school('supervisor', 'counter');
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const newToken = () => crypto.randomBytes(24).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const okToken = (s) => /^[A-Za-z0-9_-]{20,64}$/.test(String(s || ''));
const hhmm = (v) => String(v).slice(0, 5);
const needed = (n, per) => (n ? Math.ceil(n / Math.max(1, per)) : 0);
const linkOf = (req, slug, token) => `${baseUrl(req)}/group/${encodeURIComponent(slug)}/${token}`;
const waiverLinkOf = (req, slug, token) => `${baseUrl(req)}/group-waiver/${encodeURIComponent(slug)}/${token}`;
/** 'YYYY-MM-DD HH:MM:SS' minus hours, as wall-clock arithmetic. */
const minusHours = (dt, h) => { const d = new Date(`${dt.replace(' ', 'T')}Z`); d.setUTCHours(d.getUTCHours() - h); return d.toISOString().slice(0, 19).replace('T', ' '); };

const groupSchema = z.object({
  org_name: z.string().trim().min(2).max(160), leader_name: z.string().trim().min(2).max(160),
  leader_email: z.union([z.string().trim().toLowerCase().email().max(255), z.literal('')]).nullable().optional(), leader_phone: z.string().trim().max(40).nullable().optional(),
  program_name: z.string().trim().min(2).max(120).optional(),
  first_day: dateStr, weeks: z.number().int().min(1).max(16),
  start_time: z.string().regex(/^\d{2}:\d{2}$/), end_time: z.string().regex(/^\d{2}:\d{2}$/),
  max_students: z.number().int().min(1).max(200).default(30), per_chaperone: z.number().int().min(1).max(30).default(10),
  deadline_hours: z.number().int().min(0).max(720).default(72),
  meeting_place: z.string().trim().max(160).nullable().optional(), price_cents: z.number().int().min(0).max(10000000).default(0),
});

async function groupRow(db, tenantId, id, lock = false) {
  const g = await one(db, `SELECT g.*, p.name AS program, p.meeting_place, p.season, p.price_cents FROM group_programs g JOIN programs p ON p.tenant_id = g.tenant_id AND p.id = g.program_id
    WHERE g.tenant_id = ? AND g.id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!g) throw notFound('Group program');
  return g;
}
/** Everything about one group: its meetings (coach, drop-off and pickup), children (waiver signed?) and chaperones. */
async function detail(db, tenantId, g, { forLeader = false } = {}) {
  const meetings = await rows(db, `SELECT ps.id, ps.starts_at, ps.ends_at, ps.status, ps.coach_staff_id, TRIM(CONCAT(pe.first_name, ' ', pe.last_name)) AS coach,
      h.dropoff_at, h.dropoff_by, h.dropoff_count, h.pickup_at, h.pickup_by, h.pickup_count
    FROM program_sessions ps LEFT JOIN staff st ON st.tenant_id = ps.tenant_id AND st.id = ps.coach_staff_id LEFT JOIN people pe ON pe.tenant_id = st.tenant_id AND pe.id = st.person_id
    LEFT JOIN group_program_handoffs h ON h.tenant_id = ps.tenant_id AND h.group_id = ? AND h.meeting_id = ps.id
    WHERE ps.tenant_id = ? AND ps.program_id = ? ORDER BY ps.starts_at`, [g.id, tenantId, g.program_id]);
  const students = await rows(db, `SELECT s.id, s.person_id, s.guardian_name, s.guardian_email, s.guardian_phone, s.waiver_id, p.first_name, p.last_name, p.date_of_birth,
      w.signed_by_name, w.signed_at FROM group_program_students s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      LEFT JOIN waivers w ON w.tenant_id = s.tenant_id AND w.id = s.waiver_id
    WHERE s.tenant_id = ? AND s.group_id = ? ORDER BY p.last_name, p.first_name`, [tenantId, g.id]);
  // A waiver signed another way this season (at the desk, online) counts too.
  for (const s of students) {
    if (!s.waiver_id) { const w = await one(db, ON_FILE, [tenantId, s.person_id, g.season]); s.waiver_ok = Boolean(w); } else s.waiver_ok = true;
  }
  const chaperones = await rows(db, 'SELECT id, name, phone FROM group_program_chaperones WHERE tenant_id = ? AND group_id = ? ORDER BY id', [tenantId, g.id]);
  const nowLocal = nowIn((await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone);
  const open = g.status === 'open' && String(g.deadline_at) > nowLocal;
  return {
    id: g.id, org_name: g.org_name, leader_name: g.leader_name, leader_email: forLeader ? undefined : g.leader_email, leader_phone: forLeader ? undefined : g.leader_phone,
    program: g.program, meeting_place: g.meeting_place, weekday: WEEKDAYS[g.weekday], first_day: String(g.first_day).slice(0, 10), weeks: g.weeks, start_time: hhmm(g.start_time), end_time: hhmm(g.end_time),
    max_students: g.max_students, per_chaperone: g.per_chaperone, deadline_at: g.deadline_at, deadline_hours: g.deadline_hours, status: g.status, open, price_cents: g.price_cents,
    meetings: meetings.map((m) => ({ id: m.id, starts_at: m.starts_at, ends_at: m.ends_at, status: m.status, ...(forLeader ? {} : { coach_staff_id: m.coach_staff_id, coach: m.coach_staff_id ? m.coach : null }),
      dropoff: m.dropoff_at ? { at: m.dropoff_at, by: m.dropoff_by, count: m.dropoff_count } : null, pickup: m.pickup_at ? { at: m.pickup_at, by: m.pickup_by, count: m.pickup_count } : null })),
    students: students.map((s) => ({ id: s.id, first_name: s.first_name, last_name: s.last_name, date_of_birth: s.date_of_birth ? String(s.date_of_birth instanceof Date ? s.date_of_birth.toISOString() : s.date_of_birth).slice(0, 10) : null,
      guardian_name: s.guardian_name, ...(forLeader ? {} : { guardian_email: s.guardian_email, guardian_phone: s.guardian_phone, person_id: s.person_id }), waiver_signed: s.waiver_ok, waiver_signed_by: s.signed_by_name || null })),
    chaperones, chaperones_needed: needed(students.length, g.per_chaperone),
  };
}

// ================================================================ staff
router.get('/groups', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const list = await rows(pool, `SELECT g.*, p.name AS program,
      (SELECT COUNT(*) FROM group_program_students s WHERE s.tenant_id = g.tenant_id AND s.group_id = g.id) AS students,
      (SELECT COUNT(*) FROM group_program_students s WHERE s.tenant_id = g.tenant_id AND s.group_id = g.id AND s.waiver_id IS NOT NULL) AS waivers,
      (SELECT COUNT(*) FROM group_program_chaperones c WHERE c.tenant_id = g.tenant_id AND c.group_id = g.id) AS chaperones
    FROM group_programs g JOIN programs p ON p.tenant_id = g.tenant_id AND p.id = g.program_id WHERE g.tenant_id = ? ORDER BY g.status = 'open' DESC, g.first_day DESC LIMIT 200`, [t]);
  const nowLocal = nowIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
  res.json({ data: list.map((g) => ({ id: g.id, org_name: g.org_name, program: g.program, leader_name: g.leader_name, weekday: WEEKDAYS[g.weekday], first_day: String(g.first_day).slice(0, 10), weeks: g.weeks,
    start_time: hhmm(g.start_time), end_time: hhmm(g.end_time), status: g.status, deadline_at: g.deadline_at, open: g.status === 'open' && String(g.deadline_at) > nowLocal,
    students: Number(g.students), max_students: g.max_students, waivers: Number(g.waivers), chaperones: Number(g.chaperones), chaperones_needed: needed(Number(g.students), g.per_chaperone) })) });
});
router.get('/groups/:id', desk, async (req, res) => {
  const g = await groupRow(pool, req.auth.tenantId, paramId(req));
  res.json(await detail(pool, req.auth.tenantId, g));
});

router.post('/groups', director, validate(groupSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.end_time <= b.start_time) throw bad('The end time must be after the start time');
  const weekday = new Date(`${b.first_day}T12:00:00Z`).getUTCDay();
  const tn = await one(pool, 'SELECT slug, timezone FROM tenants WHERE id = ?', [t]);
  if (b.first_day < todayIn(tn.timezone)) throw bad('The first day has passed');
  const firstStart = `${b.first_day} ${b.start_time}:00`;
  const deadline = minusHours(firstStart, b.deadline_hours);
  const token = newToken();
  const out = await tx(async (conn) => {
    const lastDay = addDays(b.first_day, (b.weeks - 1) * 7);
    const name = b.program_name || `${b.org_name}: ${WEEKDAYS[weekday]}s`;
    const [p] = await conn.query(`INSERT INTO programs (tenant_id, name, kind, season, capacity, price_cents, starts_on, ends_on, description, online, active, meeting_place)
      VALUES (?, ?, 'school_program', ?, ?, ?, ?, ?, ?, 0, 0, ?)`, [t, name, seasonFor(b.first_day), b.max_students, b.price_cents, b.first_day, lastDay, `Group program booked by ${b.org_name}`, b.meeting_place ?? null]);
    for (let i = 0; i < b.weeks; i += 1) {
      const d = addDays(b.first_day, i * 7);
      await conn.query("INSERT INTO program_sessions (tenant_id, program_id, starts_at, ends_at, kind, status) VALUES (?, ?, ?, ?, 'regular', 'scheduled')", [t, p.insertId, `${d} ${b.start_time}:00`, `${d} ${b.end_time}:00`]);
    }
    const [g] = await conn.query(`INSERT INTO group_programs (tenant_id, program_id, org_name, leader_name, leader_email, leader_phone, weekday, first_day, weeks, start_time, end_time, max_students, per_chaperone, deadline_hours, deadline_at, token_sha, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, p.insertId, b.org_name, b.leader_name, b.leader_email || null, b.leader_phone || null, weekday, b.first_day, b.weeks, `${b.start_time}:00`, `${b.end_time}:00`,
      b.max_students, b.per_chaperone, b.deadline_hours, deadline, sha(token), req.auth.userId]);
    await audit(conn, req, 'create', 'group_programs', g.insertId, { org_name: b.org_name, weeks: b.weeks, program_id: p.insertId });
    return { id: g.insertId, program_id: p.insertId };
  });
  res.status(201).json({ ...out, link: linkOf(req, tn.slug, token), deadline_at: deadline });
});

/** A new booking link (the old one stops working): shown once, to copy and send to the group leader. */
router.post('/groups/:id/link', director, async (req, res) => {
  const t = req.auth.tenantId; const g = await groupRow(pool, t, paramId(req));
  const token = newToken();
  await pool.query('UPDATE group_programs SET token_sha = ? WHERE tenant_id = ? AND id = ?', [sha(token), t, g.id]);
  await audit(pool, req, 'new_link', 'group_programs', g.id);
  res.json({ link: linkOf(req, (await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [t])).slug, token) });
});
router.patch('/groups/:id', director, validate(z.object({ deadline_hours: z.number().int().min(0).max(720).optional(), max_students: z.number().int().min(1).max(200).optional(), per_chaperone: z.number().int().min(1).max(30).optional(), status: z.enum(['open', 'cancelled']).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    const g = await groupRow(conn, t, paramId(req), true);
    const set = {};
    if (b.deadline_hours !== undefined) { set.deadline_hours = b.deadline_hours; set.deadline_at = minusHours(`${String(g.first_day).slice(0, 10)} ${hhmm(g.start_time)}:00`, b.deadline_hours); }
    for (const k of ['max_students', 'per_chaperone', 'status']) if (b[k] !== undefined) set[k] = b[k];
    if (Object.keys(set).length) await conn.query(`UPDATE group_programs SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(set), t, g.id]);
    if (b.status === 'cancelled') await conn.query("UPDATE program_sessions SET status = 'cancelled', cancel_reason = 'Group program cancelled', cancelled_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND program_id = ? AND status = 'scheduled'", [t, g.program_id]);
    await audit(conn, req, 'update', 'group_programs', g.id, b);
  });
  res.json({ ok: true });
});
/** Who teaches a meeting (one instructor per meeting; it shows on their My day and is paid as a program meeting). */
router.patch('/groups/:id/meetings/:mid', director, validate(z.object({ coach_staff_id: z.number().int().positive().nullable(), all: z.boolean().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const g = await groupRow(pool, t, paramId(req));
  const mid = Number(req.params.mid) || 0;
  if (req.body.coach_staff_id && !(await one(pool, "SELECT id FROM staff WHERE tenant_id = ? AND id = ? AND status = 'active'", [t, req.body.coach_staff_id]))) throw notFound('Instructor');
  const m = await one(pool, 'SELECT id, starts_at FROM program_sessions WHERE tenant_id = ? AND id = ? AND program_id = ?', [t, mid, g.program_id]);
  if (!m) throw notFound('Meeting');
  const [r] = req.body.all
    ? await pool.query("UPDATE program_sessions SET coach_staff_id = ? WHERE tenant_id = ? AND program_id = ? AND starts_at >= ? AND status = 'scheduled'", [req.body.coach_staff_id, t, g.program_id, m.starts_at])
    : await pool.query('UPDATE program_sessions SET coach_staff_id = ? WHERE tenant_id = ? AND id = ?', [req.body.coach_staff_id, t, m.id]);
  await audit(pool, req, 'assign_coach', 'group_programs', g.id, { meeting_id: m.id, coach_staff_id: req.body.coach_staff_id, all: Boolean(req.body.all) });
  res.json({ ok: true, changed: r.affectedRows });
});
/** Drop-off or pickup for one meeting: when (now), by whom (the chaperone or parent), how many children. */
router.post('/groups/:id/meetings/:mid/handoff', desk, validate(z.object({ what: z.enum(['dropoff', 'pickup']), by: z.string().trim().min(2).max(160), count: z.number().int().min(0).max(500) })), async (req, res) => {
  const t = req.auth.tenantId; const g = await groupRow(pool, t, paramId(req));
  const m = await one(pool, 'SELECT id FROM program_sessions WHERE tenant_id = ? AND id = ? AND program_id = ?', [t, Number(req.params.mid) || 0, g.program_id]);
  if (!m) throw notFound('Meeting');
  const at = nowIn((await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone);
  const p = req.body.what;
  if (p === 'pickup') {
    const h = await one(pool, 'SELECT dropoff_at, dropoff_count FROM group_program_handoffs WHERE tenant_id = ? AND group_id = ? AND meeting_id = ?', [t, g.id, m.id]);
    if (!h || !h.dropoff_at) throw conflict('Record the drop-off first');
  }
  await pool.query(`INSERT INTO group_program_handoffs (tenant_id, group_id, meeting_id, ${p}_at, ${p}_by, ${p}_count, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE ${p}_at = VALUES(${p}_at), ${p}_by = VALUES(${p}_by), ${p}_count = VALUES(${p}_count), recorded_by = VALUES(recorded_by)`, [t, g.id, m.id, at, req.body.by, req.body.count, req.auth.userId]);
  await audit(pool, req, p, 'group_programs', g.id, { meeting_id: m.id, by: req.body.by, count: req.body.count });
  const h = await one(pool, 'SELECT dropoff_count, pickup_count FROM group_program_handoffs WHERE tenant_id = ? AND group_id = ? AND meeting_id = ?', [t, g.id, m.id]);
  res.json({ ok: true, at, mismatch: p === 'pickup' && h && Number(h.pickup_count) !== Number(h.dropoff_count) ? `${h.dropoff_count} were dropped off and ${h.pickup_count} picked up. Find the rest before anyone leaves.` : null });
});

// ================================================================ public: the group leader's link and the parents' waivers
const look = rateLimit({ windowMs: 60_000, max: 60, message: 'Too many requests. Please wait a minute.' });
const write = rateLimit({ windowMs: 3_600_000, max: Number(process.env.BOOKING_RATE_LIMIT) > 100 ? Number(process.env.BOOKING_RATE_LIMIT) : 100, message: 'Too many changes from this address. Please call the ski school.' });
async function mountain(slug) {
  const t = await one(pool, 'SELECT id, name, slug, phone, timezone, waiver_text FROM tenants WHERE slug = ?', [String(slug)]);
  if (!t) throw notFound('Page');
  const st = await modules.stateOf(t.id);
  if (st.status !== 'active' || !st.on.has('school')) throw notFound('Page');
  return t;
}
async function byLink(req, lock = false, conn = pool) {
  const t = await mountain(req.params.slug);
  if (!okToken(req.params.token)) throw notFound('Group');
  const g = await one(conn, `SELECT g.*, p.name AS program, p.meeting_place, p.season, p.price_cents FROM group_programs g JOIN programs p ON p.tenant_id = g.tenant_id AND p.id = g.program_id
    WHERE g.tenant_id = ? AND g.token_sha = ?${lock ? ' FOR UPDATE' : ''}`, [t.id, sha(req.params.token)]);
  if (!g || g.status !== 'open') throw notFound('Group');
  return { t, g };
}
const stillOpen = (t, g) => { if (String(g.deadline_at) <= nowIn(t.timezone)) throw conflict(`The roster closed ${g.deadline_hours} hours before the first day. Call the ski school${t.phone ? ` at ${t.phone}` : ''} to make a change.`); };

publicRouter.get('/:slug/group/:token', look, async (req, res) => {
  const { t, g } = await byLink(req);
  res.set('Cache-Control', 'no-store');
  res.json({ mountain: t.name, phone: t.phone, ...(await detail(pool, t.id, g, { forLeader: true })) });
});
const childSchema = z.object({
  first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), date_of_birth: dateStr,
  guardian_name: z.string().trim().min(3).max(160), guardian_email: z.union([z.string().trim().toLowerCase().email().max(255), z.literal('')]).nullable().optional(),
  guardian_phone: z.string().trim().max(40).nullable().optional(), website: z.string().max(200).optional(),
});
publicRouter.post('/:slug/group/:token/students', write, validate(childSchema), async (req, res) => {
  const b = req.body;
  res.set('Cache-Control', 'no-store');
  if (b.website) return res.status(202).json({ ok: true }); // a form-filling bot
  const wtoken = newToken();
  const out = await tx(async (conn) => {
    const { t, g } = await byLink(req, true, conn);
    stillOpen(t, g);
    const { n } = await one(conn, 'SELECT COUNT(*) AS n FROM group_program_students WHERE tenant_id = ? AND group_id = ?', [t.id, g.id]);
    if (Number(n) >= g.max_students) throw conflict(`The group is full (${g.max_students} children). Call the ski school to add more.`);
    if (b.date_of_birth > String(g.first_day).slice(0, 10)) throw bad('Check the date of birth');
    // The same child (name and birthday) on file is used again, so their levels and waivers follow them.
    let p = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND date_of_birth = ? ORDER BY id LIMIT 1', [t.id, b.first_name, b.last_name, b.date_of_birth]);
    if (!p) { const [r] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, date_of_birth) VALUES (?, ?, ?, ?)', [t.id, b.first_name, b.last_name, b.date_of_birth]); p = { id: r.insertId }; }
    if (await one(conn, 'SELECT id FROM group_program_students WHERE tenant_id = ? AND group_id = ? AND person_id = ?', [t.id, g.id, p.id])) throw conflict(`${b.first_name} is already on the roster`);
    const [s] = await conn.query('INSERT INTO group_program_students (tenant_id, group_id, person_id, guardian_name, guardian_email, guardian_phone, waiver_token_sha) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [t.id, g.id, p.id, b.guardian_name, b.guardian_email || null, b.guardian_phone || null, sha(wtoken)]);
    const had = await one(conn, 'SELECT id FROM program_enrollments WHERE tenant_id = ? AND program_id = ? AND person_id = ?', [t.id, g.program_id, p.id]);
    if (had) await conn.query("UPDATE program_enrollments SET status = 'enrolled', withdrawn_at = NULL WHERE tenant_id = ? AND id = ?", [t.id, had.id]);
    else await conn.query("INSERT INTO program_enrollments (tenant_id, program_id, person_id, status, paid_cents) VALUES (?, ?, ?, 'enrolled', 0)", [t.id, g.program_id, p.id]);
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'group_add_child', 'group_programs', g.id, { person_id: p.id });
    return { t, g, id: s.insertId };
  });
  const link = waiverLinkOf(req, out.t.slug, wtoken);
  let emailed = false;
  if (b.guardian_email) {
    const r = await require('../lib/mailer').send({ tenantId: out.t.id, to: b.guardian_email, fromName: out.t.name, tag: 'group-waiver', subject: `Please sign ${b.first_name}'s waiver for ${out.g.org_name}`,
      text: `Hi ${b.guardian_name.split(' ')[0]},\n\n${b.first_name} is on the roster for ${out.g.program} with ${out.g.org_name} at ${out.t.name}. Before the first day, please read and sign the waiver here:\n${link}\n\n${out.t.name}${out.t.phone ? `, ${out.t.phone}` : ''}` }).catch(() => null);
    emailed = Boolean(r && r.ok);
  }
  res.status(201).json({ id: out.id, waiver_link: link, emailed });
});
publicRouter.delete('/:slug/group/:token/students/:sid', write, async (req, res) => {
  await tx(async (conn) => {
    const { t, g } = await byLink(req, true, conn);
    stillOpen(t, g);
    const s = await one(conn, 'SELECT id, person_id FROM group_program_students WHERE tenant_id = ? AND group_id = ? AND id = ?', [t.id, g.id, Number(req.params.sid) || 0]);
    if (!s) throw notFound('Child');
    await conn.query('DELETE FROM group_program_students WHERE tenant_id = ? AND id = ?', [t.id, s.id]);
    await conn.query("UPDATE program_enrollments SET status = 'withdrawn', withdrawn_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND program_id = ? AND person_id = ?", [t.id, g.program_id, s.person_id]);
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'group_remove_child', 'group_programs', g.id, { person_id: s.person_id });
  });
  res.json({ ok: true });
});
/** A child's waiver link again (the leader lost it): a new one, the old one stops working. */
publicRouter.post('/:slug/group/:token/students/:sid/waiver-link', write, async (req, res) => {
  const { t, g } = await byLink(req);
  const wtoken = newToken();
  const [r] = await pool.query('UPDATE group_program_students SET waiver_token_sha = ? WHERE tenant_id = ? AND group_id = ? AND id = ?', [sha(wtoken), t.id, g.id, Number(req.params.sid) || 0]);
  if (!r.affectedRows) throw notFound('Child');
  res.json({ waiver_link: waiverLinkOf(req, t.slug, wtoken) });
});
publicRouter.put('/:slug/group/:token/chaperones', write, validate(z.object({ chaperones: z.array(z.object({ name: z.string().trim().min(2).max(160), phone: z.string().trim().min(7).max(40) })).max(40) })), async (req, res) => {
  await tx(async (conn) => {
    const { t, g } = await byLink(req, true, conn);
    stillOpen(t, g);
    await conn.query('DELETE FROM group_program_chaperones WHERE tenant_id = ? AND group_id = ?', [t.id, g.id]);
    for (const c of req.body.chaperones) await conn.query('INSERT INTO group_program_chaperones (tenant_id, group_id, name, phone) VALUES (?, ?, ?, ?)', [t.id, g.id, c.name, c.phone]);
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'group_chaperones', 'group_programs', g.id, { count: req.body.chaperones.length });
  });
  res.json({ ok: true });
});

// ---- a parent signs their child's waiver
async function byWaiverLink(req, conn = pool) {
  const t = await mountain(req.params.slug);
  if (!okToken(req.params.token)) throw notFound('Waiver');
  const s = await one(conn, `SELECT s.*, g.org_name, g.status, g.first_day, p.season, p.name AS program, pe.first_name, pe.last_name FROM group_program_students s
      JOIN group_programs g ON g.tenant_id = s.tenant_id AND g.id = s.group_id JOIN programs p ON p.tenant_id = g.tenant_id AND p.id = g.program_id
      JOIN people pe ON pe.tenant_id = s.tenant_id AND pe.id = s.person_id WHERE s.tenant_id = ? AND s.waiver_token_sha = ?`, [t.id, sha(req.params.token)]);
  if (!s || s.status !== 'open') throw notFound('Waiver');
  return { t, s };
}
publicRouter.get('/:slug/group-waiver/:token', look, async (req, res) => {
  const { t, s } = await byWaiverLink(req);
  const w = s.waiver_id ? await one(pool, 'SELECT signed_by_name, signed_at FROM waivers WHERE tenant_id = ? AND id = ?', [t.id, s.waiver_id]) : null;
  res.set('Cache-Control', 'no-store');
  res.json({ mountain: t.name, phone: t.phone, child: s.first_name, org_name: s.org_name, program: s.program, season: s.season, guardian_name: s.guardian_name, waiver_text: t.waiver_text || null,
    signed: w ? { by: w.signed_by_name, at: w.signed_at } : null });
});
publicRouter.post('/:slug/group-waiver/:token', write, validate(z.object({ signer_name: z.string().trim().min(3).max(160), relation: z.enum(['parent', 'guardian']), accept: z.literal(true) })), async (req, res) => {
  const out = await tx(async (conn) => {
    const { t, s } = await byWaiverLink(req, conn);
    await conn.query('SELECT id FROM group_program_students WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, s.id]);
    if (s.waiver_id) return { already: true };
    if (req.body.signer_name.toLowerCase() === `${s.first_name} ${s.last_name}`.toLowerCase()) throw bad('A parent or guardian signs for the child. Type your own name.');
    const textSha = t.waiver_text ? crypto.createHash('sha256').update(t.waiver_text).digest('hex') : null;
    const [w] = await conn.query("INSERT INTO waivers (tenant_id, person_id, season, kind, signed_by_name, signer_relation, text_sha, method) VALUES (?, ?, ?, 'general', ?, 'guardian', ?, 'signed_online')",
      [t.id, s.person_id, s.season, req.body.signer_name, textSha]);
    await conn.query('UPDATE group_program_students SET waiver_id = ? WHERE tenant_id = ? AND id = ?', [w.insertId, t.id, s.id]);
    if (t.waiver_text) await conn.query('INSERT IGNORE INTO waiver_texts (tenant_id, sha, body) VALUES (?, ?, ?)', [t.id, textSha, t.waiver_text]);
    await audit(conn, { auth: { tenantId: t.id, userId: null } }, 'sign_waiver', 'waivers', w.insertId, { person_id: s.person_id, via: 'group_link', relation: req.body.relation });
    return { signed: true };
  });
  res.status(out.already ? 200 : 201).json({ ok: true, ...out });
});

module.exports = { router, publicRouter };
