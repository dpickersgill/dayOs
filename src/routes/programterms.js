'use strict';

// Programs, sessions (lib/programsessions.js): the staff side. Mounted inside the programs router.
//   A manager sets up a session once (dates, weeks, makeup weeks, the weekdays it runs, spots and prices) and every day's
//   lesson dates are made. Staff enroll and move children between days; instructors see the day's groups, sort them into
//   level classes and take attendance; a manager cancels a day for weather and the makeup date takes its place.
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { todayIn, addDays } = require('../lib/util');
const PS = require('../lib/programsessions');

const manager = requireRole('manager');
const coord = requireRole('manager', 'instructor');
const desk = requireRole('manager', 'instructor', 'counter');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are 24 hour, like 15:45');
const step = z.object({ label: z.string().trim().max(40).optional(), until: dateStr, price_cents: z.number().int().min(0).max(10000000) });
const day = z.object({
  weekday: z.number().int().min(0).max(6),
  capacity: z.number().int().min(1).max(2000).nullable().optional(),
  price_cents: z.number().int().min(0).max(10000000).nullable().optional(),
  start_time: time.nullable().optional(),
  end_time: time.nullable().optional(),
  coach_staff_id: z.number().int().positive().nullable().optional(),
});
const termFields = {
  name: z.string().trim().min(1).max(100),
  starts_on: dateStr,
  weeks: z.number().int().min(1).max(40),
  makeup_weeks: z.number().int().min(0).max(6).default(1),
  start_time: time,
  end_time: time,
  price_cents: z.number().int().min(0).max(10000000),
  price_steps: z.array(step).max(6).default([]),
  skip_dates: z.array(dateStr).max(30).default([]),
  reg_opens_on: dateStr.nullable().optional(),
  reg_closes_on: dateStr.nullable().optional(),
  status: z.enum(['draft', 'open', 'closed', 'archived']).default('draft'),
};

const tz = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const programOf = async (db, tenantId, id) => { const p = await one(db, 'SELECT * FROM programs WHERE tenant_id = ? AND id = ?', [tenantId, id]); if (!p) throw notFound('Program'); return p; };
const termOf = async (db, tenantId, id, lock = false) => { const t = await one(db, `SELECT * FROM program_terms WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]); if (!t) throw notFound('Session'); return t; };
const groupOf = async (db, tenantId, id) => { const g = await one(db, 'SELECT * FROM program_groups WHERE tenant_id = ? AND id = ?', [tenantId, id]); if (!g) throw notFound('Day'); return g; };
const hasPlaces = async (db, tenantId, termId) => Number((await one(db, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND term_id = ? AND status <> 'withdrawn'", [tenantId, termId])).n) > 0;

function checkTerm(b) {
  if (b.end_time <= b.start_time) throw bad('The end time must be after the start time');
  if (b.reg_opens_on && b.reg_closes_on && b.reg_closes_on < b.reg_opens_on) throw bad('Registration must open before it closes');
}

async function addDay(conn, tenantId, term, d) {
  const [r] = await conn.query('INSERT INTO program_groups (tenant_id, term_id, weekday, start_time, end_time, capacity, price_cents, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [tenantId, term.id, d.weekday, d.start_time || null, d.end_time || null, d.capacity ?? null, d.price_cents ?? null, d.coach_staff_id ?? null]);
  const group = await groupOf(conn, tenantId, r.insertId);
  await PS.buildMeetings(conn, tenantId, term, group);
  return group;
}

module.exports = function mount(router) {
  /** A program with its sessions (places taken on each), and its bundles. */
  router.get('/:id/overview', desk, async (req, res) => {
    const t = req.auth.tenantId;
    const program = await programOf(pool, t, paramId(req));
    const terms = await rows(pool, 'SELECT * FROM program_terms WHERE tenant_id = ? AND program_id = ? ORDER BY starts_on, id', [t, program.id]);
    const today = todayIn(await tz(t));
    const out = [];
    for (const term of terms) out.push(await PS.termDetail(pool, t, term.id, today));
    const bundles = await rows(pool, 'SELECT * FROM program_bundles WHERE tenant_id = ? AND program_id = ? ORDER BY id', [t, program.id]);
    const { slug } = await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [t]);
    res.json({ program, terms: out, bundles: bundles.map((b) => ({ ...b, term_ids: PS.parseJson(b.term_ids, []) })), today, slug });
  });

  /** A new session: its days are made, and each day's lesson dates (makeup weeks on standby). */
  router.post('/:id/terms', manager, validate(z.object({ ...termFields, days: z.array(day).min(1).max(7) })), async (req, res) => {
    const t = req.auth.tenantId; const b = req.body;
    checkTerm(b);
    if (new Set(b.days.map((d) => d.weekday)).size !== b.days.length) throw bad('Each weekday once');
    const id = await tx(async (conn) => {
      const program = await programOf(conn, t, paramId(req));
      const [r] = await conn.query('INSERT INTO program_terms (tenant_id, program_id, name, starts_on, weeks, makeup_weeks, start_time, end_time, price_cents, price_steps, skip_dates, reg_opens_on, reg_closes_on, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [t, program.id, b.name, b.starts_on, b.weeks, b.makeup_weeks, b.start_time, b.end_time, b.price_cents, JSON.stringify(b.price_steps), JSON.stringify(b.skip_dates), b.reg_opens_on || null, b.reg_closes_on || null, b.status]);
      const term = await termOf(conn, t, r.insertId);
      for (const d of b.days) await addDay(conn, t, term, d);
      await audit(conn, req, 'create_session', 'programs', program.id, { term_id: term.id, days: b.days.map((d) => d.weekday) });
      return term.id;
    });
    res.status(201).json(await PS.termDetail(pool, t, id, todayIn(await tz(t))));
  });

  router.get('/terms/:tid', desk, async (req, res) => {
    const t = req.auth.tenantId;
    const d = await PS.termDetail(pool, t, paramId(req, 'tid'), todayIn(await tz(t)));
    res.json({ ...d, program: await programOf(pool, t, d.program_id) });
  });

  /**
   * Change a session. Prices, steps, registration dates and status change any time. The dates themselves (start, weeks,
   * makeup weeks, skipped dates, times) change only before anyone has a place, and every day's dates are made again.
   */
  router.patch('/terms/:tid', manager, validate(z.object(Object.fromEntries(Object.entries(termFields).map(([k, v]) => [k, v.optional()])))), async (req, res) => {
    const t = req.auth.tenantId; const b = req.body;
    await tx(async (conn) => {
      const term = await termOf(conn, t, paramId(req, 'tid'), true);
      const next = { ...PS.shapeTerm(term), ...b };
      checkTerm(next);
      const dated = ['starts_on', 'weeks', 'makeup_weeks', 'skip_dates', 'start_time', 'end_time'].filter((k) => b[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify(PS.shapeTerm(term)[k]));
      if (dated.length && await hasPlaces(conn, t, term.id)) throw conflict('Children are already enrolled, so the dates cannot change. Cancel or add single dates instead.');
      const set = []; const vals = [];
      for (const k of Object.keys(b)) { set.push(`${k} = ?`); vals.push(['price_steps', 'skip_dates'].includes(k) ? JSON.stringify(b[k]) : b[k]); }
      if (set.length) await conn.query(`UPDATE program_terms SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, t, term.id]);
      if (dated.length) {
        const fresh = await termOf(conn, t, term.id);
        await conn.query('DELETE a FROM attendance a JOIN program_sessions s ON s.tenant_id = a.tenant_id AND s.id = a.session_id WHERE s.tenant_id = ? AND s.term_id = ?', [t, term.id]);
        await conn.query('DELETE FROM program_sessions WHERE tenant_id = ? AND term_id = ?', [t, term.id]);
        for (const g of await rows(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND term_id = ?', [t, term.id])) await PS.buildMeetings(conn, t, fresh, g);
      }
      await audit(conn, req, 'update_session', 'programs', term.program_id, { term_id: term.id, fields: Object.keys(b) });
    });
    res.json(await PS.termDetail(pool, t, paramId(req, 'tid'), todayIn(await tz(t))));
  });

  /** The next session from this one: same days, spots, times and prices from a new start date. Price steps move with it. */
  router.post('/terms/:tid/copy', manager, validate(z.object({ name: z.string().trim().min(1).max(100), starts_on: dateStr })), async (req, res) => {
    const t = req.auth.tenantId;
    const id = await tx(async (conn) => {
      const src = await termOf(conn, t, paramId(req, 'tid'));
      const shift = Math.round((Date.parse(`${req.body.starts_on}T12:00:00Z`) - Date.parse(`${PS.dstr(src.starts_on)}T12:00:00Z`)) / 86400000);
      const steps = PS.parseJson(src.price_steps, []).map((s) => ({ ...s, until: addDays(PS.dstr(s.until), shift) }));
      const [r] = await conn.query("INSERT INTO program_terms (tenant_id, program_id, name, starts_on, weeks, makeup_weeks, start_time, end_time, price_cents, price_steps, skip_dates, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'draft')",
        [t, src.program_id, req.body.name, req.body.starts_on, src.weeks, src.makeup_weeks, src.start_time, src.end_time, src.price_cents, JSON.stringify(steps)]);
      const term = await termOf(conn, t, r.insertId);
      for (const g of await rows(conn, 'SELECT * FROM program_groups WHERE tenant_id = ? AND term_id = ? ORDER BY weekday', [t, src.id])) {
        const ng = await addDay(conn, t, term, { weekday: g.weekday, capacity: g.capacity, price_cents: g.price_cents, start_time: g.start_time ? PS.tstr(g.start_time) : null, end_time: g.end_time ? PS.tstr(g.end_time) : null, coach_staff_id: g.coach_staff_id });
        for (const l of await rows(conn, 'SELECT name, coach_staff_id, sort FROM program_levels WHERE tenant_id = ? AND group_id = ? ORDER BY sort, id', [t, g.id])) {
          await conn.query('INSERT INTO program_levels (tenant_id, group_id, name, coach_staff_id, sort) VALUES (?, ?, ?, ?, ?)', [t, ng.id, l.name, l.coach_staff_id, l.sort]);
        }
      }
      await audit(conn, req, 'copy_session', 'programs', src.program_id, { from: src.id, to: term.id });
      return term.id;
    });
    res.status(201).json(await PS.termDetail(pool, t, id, todayIn(await tz(t))));
  });

  /** Another weekday for a session. */
  router.post('/terms/:tid/days', manager, validate(day), async (req, res) => {
    const t = req.auth.tenantId;
    await tx(async (conn) => {
      const term = await termOf(conn, t, paramId(req, 'tid'), true);
      if (await one(conn, 'SELECT id FROM program_groups WHERE tenant_id = ? AND term_id = ? AND weekday = ?', [t, term.id, req.body.weekday])) throw conflict(`${PS.WEEKDAYS[req.body.weekday]} is already a day of this session`);
      await addDay(conn, t, term, req.body);
      await audit(conn, req, 'add_session_day', 'programs', term.program_id, { term_id: term.id, weekday: req.body.weekday });
    });
    res.status(201).json(await PS.termDetail(pool, t, paramId(req, 'tid'), todayIn(await tz(t))));
  });

  /** A day's spots, price, coach. More spots move people up from its waitlist. */
  router.patch('/groups/:gid', manager, validate(day.omit({ weekday: true }).partial()), async (req, res) => {
    const t = req.auth.tenantId; const b = req.body;
    const promoted = await tx(async (conn) => {
      const g = await groupOf(conn, t, paramId(req, 'gid'));
      const keys = Object.keys(b);
      if (!keys.length) throw bad('Nothing to change');
      await conn.query(`UPDATE program_groups SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => b[k]), t, g.id]);
      if (b.coach_staff_id !== undefined) await conn.query("UPDATE program_sessions SET coach_staff_id = ? WHERE tenant_id = ? AND group_id = ? AND status <> 'cancelled' AND starts_at >= NOW()", [b.coach_staff_id, t, g.id]);
      const fresh = await groupOf(conn, t, g.id);
      const moved = [];
      for (;;) {
        if (fresh.capacity != null && Number((await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'enrolled'", [t, g.id])).n) >= fresh.capacity) break;
        const next = await PS.promoteWaitlist(conn, t, fresh);
        if (!next) break;
        moved.push(next.person_id);
      }
      const term = await termOf(conn, t, g.term_id);
      await audit(conn, req, 'update_session_day', 'programs', term.program_id, { group_id: g.id, fields: keys, promoted: moved.length });
      return moved.length;
    });
    res.json({ ok: true, promoted });
  });

  /** One day's group: the children, their parent, level class, included ticket and rental sizes, and who is waiting. */
  router.get('/groups/:gid/roster', coord, async (req, res) => {
    const t = req.auth.tenantId;
    const g = await groupOf(pool, t, paramId(req, 'gid'));
    const term = await termOf(pool, t, g.term_id);
    const program = await programOf(pool, t, term.program_id);
    const data = await rows(pool, `SELECT e.id AS enrollment_id, e.status, e.level_id, e.any_day, e.price_cents, e.discount_cents, e.paid_cents, e.created_at, e.bundle_id,
        p.id AS person_id, p.first_name, p.last_name, p.date_of_birth, p.ability_level, p.height_in, p.weight_lb, p.boot_size, p.stance, p.emergency_name, p.emergency_phone,
        g.first_name AS guardian_first_name, g.last_name AS guardian_last_name, g.email AS guardian_email, g.phone AS guardian_phone, tk.code AS ticket_code
      FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
      LEFT JOIN people g ON g.tenant_id = e.tenant_id AND g.id = e.guardian_id
      LEFT JOIN tickets tk ON tk.tenant_id = e.tenant_id AND tk.id = e.ticket_id
      WHERE e.tenant_id = ? AND e.group_id = ? AND e.status <> 'withdrawn' ORDER BY e.status, p.last_name, p.first_name`, [t, g.id]);
    const levels = await rows(pool, 'SELECT id, name, coach_staff_id, sort FROM program_levels WHERE tenant_id = ? AND group_id = ? ORDER BY sort, id', [t, g.id]);
    res.json({ group: { ...g, day: PS.WEEKDAYS[g.weekday] }, term: PS.shapeTerm(term), program: { id: program.id, name: program.name, includes_ticket: Boolean(program.includes_ticket), includes_rental: Boolean(program.includes_rental), level_mode: program.level_mode }, levels,
      data: data.map((r) => ({ ...r, date_of_birth: r.date_of_birth ? PS.dstr(r.date_of_birth) : null, owes_cents: Math.max(0, Number(r.price_cents || 0) - Number(r.discount_cents || 0) - Number(r.paid_cents || 0)) })) });
  });

  /** Staff put a child in a day of a session (at the desk or on the phone). Paying is separate: the basket, or Record payment. */
  router.post('/terms/:tid/enroll', desk, validate(z.object({ person_id: z.number().int().positive(), group_id: z.number().int().positive(), guardian_id: z.number().int().positive().nullable().optional(), any_day: z.boolean().optional() })), async (req, res) => {
    const t = req.auth.tenantId; const b = req.body;
    const today = todayIn(await tz(t));
    const out = await tx(async (conn) => {
      const term = await termOf(conn, t, paramId(req, 'tid'));
      const g = await groupOf(conn, t, b.group_id);
      if (g.term_id !== term.id) throw bad('That day is not part of this session');
      const program = await programOf(conn, t, term.program_id);
      if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [t, b.person_id]))) throw notFound('Person');
      const r = await PS.enroll(conn, t, { program, term, group: g, personId: b.person_id, guardianId: b.guardian_id || null, priceCents: PS.priceNow(term, g, today).cents, anyDay: b.any_day });
      await audit(conn, req, 'enroll', 'programs', program.id, { term_id: term.id, group_id: g.id, person_id: b.person_id, status: r.status });
      return r;
    });
    res.status(201).json(out);
  });

  /** Move a child to another day of the same session, when it has room. */
  router.post('/enrollments/:eid/move', desk, validate(z.object({ group_id: z.number().int().positive() })), async (req, res) => {
    const t = req.auth.tenantId;
    const out = await tx(async (conn) => {
      const e = await one(conn, 'SELECT * FROM program_enrollments WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req, 'eid')]);
      if (!e || !e.group_id) throw notFound('Place');
      if (e.status === 'withdrawn') throw conflict('This place was withdrawn');
      const to = await groupOf(conn, t, req.body.group_id);
      if (to.term_id !== e.term_id) throw bad('Moves stay within the same session');
      if (to.id === e.group_id) return { ok: true, promoted: null };
      await conn.query('SELECT id FROM program_groups WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, to.id]);
      const { n } = await one(conn, "SELECT COUNT(*) AS n FROM program_enrollments WHERE tenant_id = ? AND group_id = ? AND status = 'enrolled'", [t, to.id]);
      if (to.capacity != null && Number(n) >= to.capacity) throw conflict(`${PS.WEEKDAYS[to.weekday]} is full`);
      const from = await groupOf(conn, t, e.group_id);
      await conn.query("UPDATE program_enrollments SET group_id = ?, level_id = NULL, status = 'enrolled' WHERE tenant_id = ? AND id = ?", [to.id, t, e.id]);
      if (e.ticket_id) {
        const span = await PS.groupSpan(conn, t, to.id);
        await conn.query('UPDATE tickets SET valid_from = ?, valid_to = ?, uses_remaining = ? WHERE tenant_id = ? AND id = ?', [span.first, span.last, span.count, t, e.ticket_id]);
      }
      const promoted = e.status === 'enrolled' ? await PS.promoteWaitlist(conn, t, from) : null;
      await audit(conn, req, 'move_day', 'programs', e.program_id, { enrollment_id: e.id, from: from.weekday, to: to.weekday });
      return { ok: true, promoted: promoted ? promoted.person_id : null };
    });
    res.json(out);
  });

  // ---------------------------------------------------------------- level classes within a day
  router.post('/groups/:gid/levels', coord, validate(z.object({ name: z.string().trim().min(1).max(60), coach_staff_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
    const t = req.auth.tenantId;
    const g = await groupOf(pool, t, paramId(req, 'gid'));
    const { n } = await one(pool, 'SELECT COUNT(*) AS n FROM program_levels WHERE tenant_id = ? AND group_id = ?', [t, g.id]);
    const [r] = await pool.query('INSERT INTO program_levels (tenant_id, group_id, name, coach_staff_id, sort) VALUES (?, ?, ?, ?, ?)', [t, g.id, req.body.name, req.body.coach_staff_id ?? null, Number(n)]);
    res.status(201).json({ id: r.insertId });
  });
  router.patch('/levels/:lid', coord, validate(z.object({ name: z.string().trim().min(1).max(60).optional(), coach_staff_id: z.number().int().positive().nullable().optional() })), async (req, res) => {
    const keys = Object.keys(req.body);
    if (!keys.length) throw bad('Nothing to change');
    const [r] = await pool.query(`UPDATE program_levels SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => req.body[k]), req.auth.tenantId, paramId(req, 'lid')]);
    if (!r.affectedRows) throw notFound('Class');
    res.json({ ok: true });
  });
  router.delete('/levels/:lid', coord, async (req, res) => {
    const t = req.auth.tenantId; const lid = paramId(req, 'lid');
    await tx(async (conn) => {
      await conn.query('UPDATE program_enrollments SET level_id = NULL WHERE tenant_id = ? AND level_id = ?', [t, lid]);
      const [r] = await conn.query('DELETE FROM program_levels WHERE tenant_id = ? AND id = ?', [t, lid]);
      if (!r.affectedRows) throw notFound('Class');
    });
    res.json({ ok: true });
  });
  /** Sort the day's children into classes (on the first day, or ahead of time when the mountain presets them). */
  router.put('/groups/:gid/levels/assign', coord, validate(z.object({ assignments: z.array(z.object({ enrollment_id: z.number().int().positive(), level_id: z.number().int().positive().nullable() })).min(1).max(500) })), async (req, res) => {
    const t = req.auth.tenantId;
    const g = await groupOf(pool, t, paramId(req, 'gid'));
    const levels = new Set((await rows(pool, 'SELECT id FROM program_levels WHERE tenant_id = ? AND group_id = ?', [t, g.id])).map((l) => l.id));
    await tx(async (conn) => {
      for (const a of req.body.assignments) {
        if (a.level_id !== null && !levels.has(a.level_id)) throw bad('That class is not part of this day');
        await conn.query('UPDATE program_enrollments SET level_id = ? WHERE tenant_id = ? AND group_id = ? AND id = ?', [a.level_id, t, g.id, a.enrollment_id]);
      }
    });
    res.json({ ok: true });
  });
  /**
   * Preset classes before the first day: each child goes into the class with the same name they were in last session
   * of this program, else the class named for their ability on file (beginner, intermediate...). Nobody already placed moves.
   */
  router.post('/groups/:gid/levels/preset', coord, async (req, res) => {
    const t = req.auth.tenantId;
    const g = await groupOf(pool, t, paramId(req, 'gid'));
    const term = await termOf(pool, t, g.term_id);
    const levels = await rows(pool, 'SELECT id, name FROM program_levels WHERE tenant_id = ? AND group_id = ?', [t, g.id]);
    if (!levels.length) throw conflict('Add the classes for this day first');
    const byName = new Map(levels.map((l) => [l.name.trim().toLowerCase(), l.id]));
    const kids = await rows(pool, `SELECT e.id, e.person_id, p.ability_level,
        (SELECT l.name FROM program_enrollments pe JOIN program_terms pt ON pt.tenant_id = pe.tenant_id AND pt.id = pe.term_id JOIN program_levels l ON l.tenant_id = pe.tenant_id AND l.id = pe.level_id
          WHERE pe.tenant_id = e.tenant_id AND pe.person_id = e.person_id AND pe.program_id = e.program_id AND pt.starts_on < ? ORDER BY pt.starts_on DESC LIMIT 1) AS last_level
      FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
      WHERE e.tenant_id = ? AND e.group_id = ? AND e.status = 'enrolled' AND e.level_id IS NULL`, [term.starts_on, t, g.id]);
    let placed = 0;
    for (const k of kids) {
      const want = [k.last_level, k.ability_level].filter(Boolean).map((x) => String(x).trim().toLowerCase());
      const hit = want.map((w) => byName.get(w) || [...byName].find(([n]) => n.includes(w) || w.includes(n))?.[1]).find(Boolean);
      if (!hit) continue;
      await pool.query('UPDATE program_enrollments SET level_id = ? WHERE tenant_id = ? AND id = ?', [hit, t, k.id]);
      placed += 1;
    }
    res.json({ placed, left: kids.length - placed });
  });

  // ---------------------------------------------------------------- the lesson dates: weather and makeups
  /** The lessons on a date, every program: for the instructors' day sheet and the storm-day screen. */
  router.get('/day', coord, async (req, res) => {
    const t = req.auth.tenantId;
    const date = dateStr.safeParse(req.query.date).success ? req.query.date : todayIn(await tz(t));
    const data = await rows(pool, `SELECT s.id, s.starts_at, s.ends_at, s.kind, s.status, s.cancel_reason, s.group_id, s.term_id, pr.name AS program, pt.name AS term, g.weekday,
        (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = s.tenant_id AND e.group_id = s.group_id AND e.status = 'enrolled') AS enrolled,
        (SELECT COUNT(*) FROM attendance a WHERE a.tenant_id = s.tenant_id AND a.session_id = s.id AND a.present = 1) AS present
      FROM program_sessions s JOIN programs pr ON pr.tenant_id = s.tenant_id AND pr.id = s.program_id
      LEFT JOIN program_terms pt ON pt.tenant_id = s.tenant_id AND pt.id = s.term_id LEFT JOIN program_groups g ON g.tenant_id = s.tenant_id AND g.id = s.group_id
      WHERE s.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ? AND s.status <> 'standby' ORDER BY s.starts_at, pr.name`, [t, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
    res.json({ date, data: data.map((m) => ({ ...m, enrolled: Number(m.enrolled), present: Number(m.present) })) });
  });

  /** One lesson date: its group's children with today's attendance marks. */
  router.get('/meetings/:mid', coord, async (req, res) => {
    const t = req.auth.tenantId;
    const m = await one(pool, 'SELECT * FROM program_sessions WHERE tenant_id = ? AND id = ?', [t, paramId(req, 'mid')]);
    if (!m) throw notFound('Lesson date');
    const kids = m.group_id ? await rows(pool, `SELECT e.id AS enrollment_id, e.level_id, p.id AS person_id, p.first_name, p.last_name, a.present
      FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id
      LEFT JOIN attendance a ON a.tenant_id = e.tenant_id AND a.session_id = ? AND a.person_id = e.person_id
      WHERE e.tenant_id = ? AND e.group_id = ? AND e.status = 'enrolled' ORDER BY p.last_name, p.first_name`, [m.id, t, m.group_id]) : [];
    res.json({ ...m, date: PS.dstr(m.starts_at), data: kids.map((k) => ({ ...k, present: k.present === null ? null : Boolean(k.present) })) });
  });

  /** Cancel one lesson date (weather). The day's makeup date takes its place; families are emailed. */
  router.post('/meetings/:mid/cancel', manager, validate(z.object({ reason: z.string().trim().min(2).max(255), notify: z.boolean().default(true) })), async (req, res) => {
    const t = req.auth.tenantId;
    const out = await tx(async (conn) => {
      const r = await PS.cancelMeeting(conn, t, paramId(req, 'mid'), req.body.reason);
      await audit(conn, req, 'cancel_date', 'programs', r.program_id, { meeting: r.id, makeup: r.makeup ? r.makeup.id : null, reason: req.body.reason });
      return r;
    });
    out.emailed = req.body.notify ? await PS.notifyCancel(pool, t, out, req.body.reason) : 0;
    res.json(out);
  });

  /**
   * A storm day: every program lesson on that date. preview lists them first. Only that date is touched; each day group
   * uses its own makeup date.
   */
  router.post('/cancel-day', manager, validate(z.object({ date: dateStr, reason: z.string().trim().min(2).max(255), notify: z.boolean().default(true), preview: z.boolean().default(false) })), async (req, res) => {
    const t = req.auth.tenantId; const b = req.body;
    const list = await rows(pool, `SELECT s.id, s.starts_at, pr.name AS program, pt.name AS term, g.weekday FROM program_sessions s JOIN programs pr ON pr.tenant_id = s.tenant_id AND pr.id = s.program_id
      LEFT JOIN program_terms pt ON pt.tenant_id = s.tenant_id AND pt.id = s.term_id LEFT JOIN program_groups g ON g.tenant_id = s.tenant_id AND g.id = s.group_id
      WHERE s.tenant_id = ? AND s.status = 'scheduled' AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at`, [t, `${b.date} 00:00:00`, `${addDays(b.date, 1)} 00:00:00`]);
    if (b.preview) return res.json({ date: b.date, data: list });
    if (!list.length) throw conflict('No program lessons are scheduled that day');
    const done = [];
    for (const m of list) {
      const r = await tx(async (conn) => {
        const x = await PS.cancelMeeting(conn, t, m.id, b.reason);
        await audit(conn, req, 'cancel_date', 'programs', x.program_id, { meeting: x.id, makeup: x.makeup ? x.makeup.id : null, reason: b.reason, storm_day: b.date });
        return x;
      });
      r.emailed = b.notify ? await PS.notifyCancel(pool, t, r, b.reason) : 0;
      done.push({ ...r, program: m.program, term: m.term });
    }
    res.json({ date: b.date, data: done });
  });

  /** Another lesson date for a day group (when its makeup weeks are used up). Included tickets stretch to cover it. */
  router.post('/groups/:gid/meetings', manager, validate(z.object({ date: dateStr })), async (req, res) => {
    const t = req.auth.tenantId;
    const out = await tx(async (conn) => {
      const g = await groupOf(conn, t, paramId(req, 'gid'));
      const term = await termOf(conn, t, g.term_id);
      if (await one(conn, "SELECT id FROM program_sessions WHERE tenant_id = ? AND group_id = ? AND DATE(starts_at) = ? AND status <> 'cancelled'", [t, g.id, req.body.date])) throw conflict('This day already has a lesson on that date');
      const start = PS.tstr(g.start_time || term.start_time); const end = PS.tstr(g.end_time || term.end_time);
      const [r] = await conn.query("INSERT INTO program_sessions (tenant_id, program_id, term_id, group_id, starts_at, ends_at, kind, status, coach_staff_id) VALUES (?, ?, ?, ?, ?, ?, 'extra', 'scheduled', ?)",
        [t, term.program_id, term.id, g.id, `${req.body.date} ${start}:00`, `${req.body.date} ${end}:00`, g.coach_staff_id]);
      await PS.stretchTickets(conn, t, g.id);
      await audit(conn, req, 'add_date', 'programs', term.program_id, { group_id: g.id, date: req.body.date });
      return { id: r.insertId };
    });
    res.status(201).json(out);
  });

  // ---------------------------------------------------------------- bundles: several sessions at one price
  const bundleBody = z.object({ name: z.string().trim().min(1).max(100), price_cents: z.number().int().min(0).max(10000000), term_ids: z.array(z.number().int().positive()).min(2).max(8), active: z.boolean().optional() });
  async function checkBundleTerms(t, programId, ids) {
    const found = await rows(pool, 'SELECT id FROM program_terms WHERE tenant_id = ? AND program_id = ? AND id IN (?)', [t, programId, ids]);
    if (found.length !== new Set(ids).size) throw bad('A bundle is made of sessions of the same program');
  }
  router.post('/:id/bundles', manager, validate(bundleBody), async (req, res) => {
    const t = req.auth.tenantId; const program = await programOf(pool, t, paramId(req));
    await checkBundleTerms(t, program.id, req.body.term_ids);
    const [r] = await pool.query('INSERT INTO program_bundles (tenant_id, program_id, name, price_cents, term_ids, active) VALUES (?, ?, ?, ?, ?, ?)', [t, program.id, req.body.name, req.body.price_cents, JSON.stringify(req.body.term_ids), req.body.active === false ? 0 : 1]);
    await audit(pool, req, 'create_bundle', 'programs', program.id, { bundle: r.insertId });
    res.status(201).json({ id: r.insertId });
  });
  router.patch('/bundles/:bid', manager, validate(bundleBody.partial()), async (req, res) => {
    const t = req.auth.tenantId;
    const bundle = await one(pool, 'SELECT * FROM program_bundles WHERE tenant_id = ? AND id = ?', [t, paramId(req, 'bid')]);
    if (!bundle) throw notFound('Bundle');
    if (req.body.term_ids) await checkBundleTerms(t, bundle.program_id, req.body.term_ids);
    const keys = Object.keys(req.body);
    if (!keys.length) throw bad('Nothing to change');
    await pool.query(`UPDATE program_bundles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => (k === 'term_ids' ? JSON.stringify(req.body[k]) : req.body[k])), t, bundle.id]);
    res.json({ ok: true });
  });
};
