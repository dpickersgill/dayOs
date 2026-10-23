'use strict';

// The Assistant's look-ups into a mountain's own data (Assistant Plus). Each tool is read-only, scoped to the mountain,
// limited to the roles that could see the same thing on screen, and to the apps the mountain has. Patient care records
// are never reachable from here. Results are small JSON the model reads; lists are capped.
const { rows, one } = require('../db');
const { addDays } = require('./util');

const MANAGERS = ['owner', 'manager'];
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const hhmm = (t) => String(t || '').slice(11, 16) || String(t || '').slice(0, 5);
const DATE = { type: 'string', description: 'A date as YYYY-MM-DD. Work out "today", "tomorrow" or "last Saturday" from today\'s date given above.' };

const TOOLS = [
  {
    name: 'day_report', module: null, roles: null,
    description: 'One day at the mountain: open or closed and the hours, weather and snow, visits (gate scans), tickets sold, lesson students. Managers also get revenue.',
    input_schema: { type: 'object', properties: { date: DATE }, required: ['date'] },
    async run(db, c, { date }) {
      const [cal, rec, scans] = await Promise.all([
        one(db, 'SELECT status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date = ?', [c.tenantId, date]),
        one(db, 'SELECT * FROM day_records WHERE tenant_id = ? AND on_date = ?', [c.tenantId, date]),
        one(db, "SELECT COUNT(*) AS n FROM scans WHERE tenant_id = ? AND result = 'ok' AND scanned_at >= ? AND scanned_at < ?", [c.tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]).catch(() => ({ n: null })),
      ]);
      const out = { date, calendar: cal ? { status: cal.status, open: cal.open_time, close: cal.close_time, notes: cal.notes } : null, gate_scans: scans ? Number(scans.n) : null };
      if (rec) {
        Object.assign(out, { weather: { high_f: rec.high_f, low_f: rec.low_f, snowfall_in: rec.snowfall_in, wind_mph: rec.wind_mph }, crew_new_snow_in: rec.crew_new_snow_in, base_in: rec.crew_base_in,
          visits: rec.visits, tickets_sold: rec.tickets_sold, presold_online: rec.presold_online, lesson_students: rec.lesson_students });
        if (MANAGERS.includes(c.role)) out.revenue_dollars = rec.revenue_cents == null ? null : rec.revenue_cents / 100;
      }
      return out;
    },
  },
  {
    name: 'sales_summary', module: 'sell', roles: MANAGERS,
    description: 'Sales between two dates (inclusive): number of orders, gross, refunds and net in dollars, split by what was sold (tickets, lessons, rentals, programs, gift cards) and by channel (window, online...).',
    input_schema: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from', 'to'] },
    async run(db, c, { from, to }) {
      const range = [c.tenantId, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`];
      const [tot, byKind, byChannel] = await Promise.all([
        one(db, "SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS gross, COALESCE(SUM(refunded_cents), 0) AS refunds FROM orders WHERE tenant_id = ? AND status <> 'cancelled' AND created_at >= ? AND created_at < ?", range),
        rows(db, `SELECT i.line_kind, COUNT(*) AS items, COALESCE(SUM(i.unit_price_cents * i.quantity - i.discount_cents), 0) AS cents FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
          WHERE o.tenant_id = ? AND o.status <> 'cancelled' AND o.created_at >= ? AND o.created_at < ? GROUP BY i.line_kind`, range),
        rows(db, "SELECT channel, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE tenant_id = ? AND status <> 'cancelled' AND created_at >= ? AND created_at < ? GROUP BY channel", range),
      ]);
      return { from, to, orders: Number(tot.orders), gross_dollars: Number(tot.gross) / 100, refunds_dollars: Number(tot.refunds) / 100, net_dollars: (Number(tot.gross) - Number(tot.refunds)) / 100,
        by_kind: byKind.map((r) => ({ kind: r.line_kind, items: Number(r.items), dollars_before_tax: Number(r.cents) / 100 })), by_channel: byChannel.map((r) => ({ channel: r.channel, orders: Number(r.orders), dollars: Number(r.cents) / 100 })) };
    },
  },
  {
    name: 'lessons_on', module: 'school', roles: [...MANAGERS, 'instructor', 'counter'],
    description: 'Ski school lessons on a date: time, lesson, discipline, level, instructor, places booked and spots, status.',
    input_schema: { type: 'object', properties: { date: DATE }, required: ['date'] },
    async run(db, c, { date }) {
      const data = await rows(db, `SELECT s.starts_at, s.ends_at, s.discipline, s.ability_level, s.capacity, s.status, s.format, pr.name AS lesson, CONCAT(pe.first_name, ' ', pe.last_name) AS instructor,
          (SELECT COUNT(*) FROM lesson_bookings b WHERE b.tenant_id = s.tenant_id AND b.session_id = s.id AND b.status IN ('booked','attended')) AS booked
        FROM lesson_sessions s JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
        LEFT JOIN staff st ON st.tenant_id = s.tenant_id AND st.id = s.instructor_id LEFT JOIN people pe ON pe.tenant_id = st.tenant_id AND pe.id = st.person_id
        WHERE s.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at LIMIT 60`, [c.tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`]);
      return { date, lessons: data.map((s) => ({ time: `${hhmm(s.starts_at)}-${hhmm(s.ends_at)}`, lesson: s.lesson, discipline: s.discipline, level: s.ability_level, format: s.format, instructor: s.instructor, booked: Number(s.booked), spots: s.capacity, status: s.status })) };
    },
  },
  {
    name: 'programs_overview', module: 'programs', roles: [...MANAGERS, 'instructor', 'counter'],
    description: 'Programs run in sessions: each program\'s sessions and, for each weekday group, how many are enrolled, the spots, how many are waiting, and the next lesson date. Optionally only programs whose name contains some text.',
    input_schema: { type: 'object', properties: { program: { type: 'string', description: 'Part of the program name, optional' } } },
    async run(db, c, { program }) {
      const progs = await rows(db, `SELECT id, name FROM programs WHERE tenant_id = ? AND active = 1 ${program ? 'AND name LIKE ?' : ''} ORDER BY name LIMIT 20`, program ? [c.tenantId, `%${program}%`] : [c.tenantId]);
      const out = [];
      for (const p of progs) {
        const groups = await rows(db, `SELECT pt.name AS session, pt.status, g.weekday, g.capacity, g.discipline,
            (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = g.tenant_id AND e.group_id = g.id AND e.status = 'enrolled') AS enrolled,
            (SELECT COUNT(*) FROM program_enrollments e WHERE e.tenant_id = g.tenant_id AND e.group_id = g.id AND e.status = 'waitlist') AS waiting,
            (SELECT MIN(s.starts_at) FROM program_sessions s WHERE s.tenant_id = g.tenant_id AND s.group_id = g.id AND s.status = 'scheduled' AND s.starts_at >= ?) AS next_lesson
          FROM program_groups g JOIN program_terms pt ON pt.tenant_id = g.tenant_id AND pt.id = g.term_id WHERE pt.tenant_id = ? AND pt.program_id = ? AND pt.status <> 'archived' ORDER BY pt.starts_on, g.weekday`, [`${c.today} 00:00:00`, c.tenantId, p.id]);
        out.push({ program: p.name, groups: groups.map((g) => ({ session: g.session, status: g.status, day: DAYS[g.weekday], discipline: g.discipline, enrolled: Number(g.enrolled), spots: g.capacity, waiting: Number(g.waiting), next_lesson: g.next_lesson ? String(g.next_lesson).slice(0, 16) : null })) });
      }
      return { programs: out };
    },
  },
  {
    name: 'program_roster', module: 'programs', roles: [...MANAGERS, 'instructor', 'counter'],
    description: 'The children in one weekday group of a program session: name, age, ski or snowboard, class, whether they have an allergy note, the parent, and anything owed. Give part of the program name and the weekday; the session is the current one unless named.',
    input_schema: { type: 'object', properties: { program: { type: 'string' }, weekday: { type: 'string', enum: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] }, session: { type: 'string', description: 'Part of the session name, optional' } }, required: ['program', 'weekday'] },
    async run(db, c, { program, weekday, session }) {
      const g = await one(db, `SELECT g.id, pt.name AS session, pr.name AS program FROM program_groups g JOIN program_terms pt ON pt.tenant_id = g.tenant_id AND pt.id = g.term_id JOIN programs pr ON pr.tenant_id = pt.tenant_id AND pr.id = pt.program_id
        WHERE g.tenant_id = ? AND pr.name LIKE ? AND g.weekday = ? ${session ? 'AND pt.name LIKE ?' : ''} AND pt.status <> 'archived'
        ORDER BY (SELECT MAX(s.starts_at) FROM program_sessions s WHERE s.tenant_id = g.tenant_id AND s.group_id = g.id) < ?, pt.starts_on LIMIT 1`,
      [c.tenantId, `%${program}%`, DAYS.indexOf(weekday), ...(session ? [`%${session}%`] : []), `${c.today} 00:00:00`]);
      if (!g) return { found: false };
      const kids = await rows(db, `SELECT p.first_name, p.last_name, p.date_of_birth, e.status, e.discipline, l.name AS class_name, e.allergies IS NOT NULL AND e.allergies <> '' AS allergy_note,
          GREATEST(0, COALESCE(e.price_cents, 0) - e.discount_cents - e.paid_cents) AS owes, CONCAT(gp.first_name, ' ', gp.last_name) AS parent
        FROM program_enrollments e JOIN people p ON p.tenant_id = e.tenant_id AND p.id = e.person_id LEFT JOIN people gp ON gp.tenant_id = e.tenant_id AND gp.id = e.guardian_id
        LEFT JOIN program_levels l ON l.tenant_id = e.tenant_id AND l.id = e.level_id WHERE e.tenant_id = ? AND e.group_id = ? AND e.status IN ('enrolled','waitlist') ORDER BY e.status, p.last_name LIMIT 80`, [c.tenantId, g.id]);
      const age = (dob) => (dob ? Math.floor((Date.parse(`${c.today}T12:00:00Z`) - Date.parse(`${dstr(dob)}T12:00:00Z`)) / 31557600000) : null);
      return { program: g.program, session: g.session, day: weekday, children: kids.map((k) => ({ name: `${k.first_name} ${k.last_name}`, age: age(k.date_of_birth), status: k.status, discipline: k.discipline, class: k.class_name, allergy_note: Boolean(Number(k.allergy_note)), parent: k.parent, owes_dollars: Number(k.owes) / 100 })) };
    },
  },
  {
    name: 'who_is_working', module: 'workforce', roles: [...MANAGERS, 'counter', 'instructor', 'staff', 'patrol'],
    description: 'Who is scheduled on a date (name, position, shift times) and, for today, who is clocked in now. Patrollers signed in for duty are included where the mountain has Patrol.',
    input_schema: { type: 'object', properties: { date: DATE }, required: ['date'] },
    async run(db, c, { date }) {
      const range = [c.tenantId, `${date} 00:00:00`, `${addDays(date, 1)} 00:00:00`];
      const shifts = await rows(db, `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name, po.name AS position, sh.starts_at, sh.ends_at, sh.status FROM shifts sh JOIN staff st ON st.tenant_id = sh.tenant_id AND st.id = sh.staff_id
        JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id LEFT JOIN positions po ON po.tenant_id = sh.tenant_id AND po.id = sh.position_id
        WHERE sh.tenant_id = ? AND sh.starts_at >= ? AND sh.starts_at < ? ORDER BY sh.starts_at LIMIT 150`, range);
      const out = { date, scheduled: shifts.map((s) => ({ name: s.name, position: s.position, time: `${hhmm(s.starts_at)}-${hhmm(s.ends_at)}`, status: s.status })) };
      if (date === c.today) {
        out.clocked_in_now = (await rows(db, `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name, t.clock_in FROM time_entries t JOIN staff st ON st.tenant_id = t.tenant_id AND st.id = t.staff_id
          JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE t.tenant_id = ? AND t.clock_out IS NULL ORDER BY t.clock_in LIMIT 150`, [c.tenantId])).map((t) => ({ name: t.name, since: hhmm(t.clock_in) }));
      }
      if (c.modules.has('patrol')) {
        out.patrol_on_duty = (await rows(db, `SELECT CONCAT(p.first_name, ' ', p.last_name) AS name, d.signed_in_at, d.signed_out_at FROM patrol_duty d JOIN staff st ON st.tenant_id = d.tenant_id AND st.id = d.staff_id
          JOIN people p ON p.tenant_id = st.tenant_id AND p.id = st.person_id WHERE d.tenant_id = ? AND d.on_date = ? ORDER BY d.signed_in_at LIMIT 100`, [c.tenantId, date])).map((d) => ({ name: d.name, in: hhmm(d.signed_in_at), out: d.signed_out_at ? hhmm(d.signed_out_at) : null }));
      }
      return out;
    },
  },
  {
    name: 'lifts_and_trails', module: 'conditions', roles: null,
    description: 'Lifts and trails right now: each lift and its status, how many trails are open, and the trails that are closed with the reason.',
    input_schema: { type: 'object', properties: {} },
    async run(db, c) {
      const [lifts, trails] = await Promise.all([
        rows(db, 'SELECT name, status FROM lifts WHERE tenant_id = ? ORDER BY name LIMIT 60', [c.tenantId]),
        rows(db, 'SELECT name, difficulty, status, groomed, closure_reason FROM trails WHERE tenant_id = ? ORDER BY name LIMIT 200', [c.tenantId]),
      ]);
      return { lifts, trails_open: trails.filter((t) => t.status === 'open').length, trails_total: trails.length, closed_trails: trails.filter((t) => t.status !== 'open').slice(0, 40).map((t) => ({ name: t.name, reason: t.closure_reason })), groomed: trails.filter((t) => t.groomed).map((t) => t.name).slice(0, 40) };
    },
  },
  {
    name: 'find_customer', module: null, roles: [...MANAGERS, 'counter'],
    description: 'Find a guest by name: up to 5 matches with age, phone and email, this season\'s passes, upcoming lessons and program places, and whether a waiver is on file.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'First and/or last name' } }, required: ['name'] },
    async run(db, c, { name }) {
      const parts = String(name).trim().split(/\s+/).slice(0, 2);
      const where = parts.length > 1 ? 'p.first_name LIKE ? AND p.last_name LIKE ?' : '(p.first_name LIKE ? OR p.last_name LIKE ?)';
      const args = parts.length > 1 ? [`${parts[0]}%`, `${parts[1]}%`] : [`${parts[0]}%`, `${parts[0]}%`];
      const people = await rows(db, `SELECT p.id, p.first_name, p.last_name, p.date_of_birth, p.phone, p.email FROM people p WHERE p.tenant_id = ? AND p.anonymised_at IS NULL AND ${where} ORDER BY p.last_name, p.first_name LIMIT 5`, [c.tenantId, ...args]);
      const out = [];
      for (const p of people) {
        const [passes, lessons, places, waiver] = await Promise.all([
          rows(db, "SELECT pr.name, t.valid_from, t.valid_to, t.status FROM tickets t JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id WHERE t.tenant_id = ? AND t.person_id = ? AND pr.kind = 'season_pass' AND t.valid_to >= ? LIMIT 5", [c.tenantId, p.id, c.today]),
          rows(db, "SELECT s.starts_at, pr.name FROM lesson_bookings b JOIN lesson_sessions s ON s.tenant_id = b.tenant_id AND s.id = b.session_id JOIN products pr ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id WHERE b.tenant_id = ? AND b.person_id = ? AND b.status = 'booked' AND s.starts_at >= ? ORDER BY s.starts_at LIMIT 5", [c.tenantId, p.id, `${c.today} 00:00:00`]),
          rows(db, "SELECT pr.name AS program, pt.name AS session, g.weekday, e.status FROM program_enrollments e JOIN programs pr ON pr.tenant_id = e.tenant_id AND pr.id = e.program_id LEFT JOIN program_terms pt ON pt.tenant_id = e.tenant_id AND pt.id = e.term_id LEFT JOIN program_groups g ON g.tenant_id = e.tenant_id AND g.id = e.group_id WHERE e.tenant_id = ? AND e.person_id = ? AND e.status IN ('enrolled','waitlist') LIMIT 5", [c.tenantId, p.id]),
          one(db, 'SELECT id FROM waivers WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 1', [c.tenantId, p.id]),
        ]);
        out.push({ name: `${p.first_name} ${p.last_name}`, date_of_birth: p.date_of_birth ? dstr(p.date_of_birth) : null, phone: p.phone, email: p.email,
          season_passes: passes.map((x) => ({ pass: x.name, valid: `${dstr(x.valid_from)} to ${dstr(x.valid_to)}`, status: x.status })), upcoming_lessons: lessons.map((x) => `${String(x.starts_at).slice(0, 16)} ${x.name}`),
          programs: places.map((x) => `${x.program}${x.session ? `, ${x.session}` : ''}${x.weekday != null ? `, ${DAYS[x.weekday]}s` : ''} (${x.status})`), waiver_on_file: Boolean(waiver) });
      }
      return { matches: out };
    },
  },
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The tools this person may use, given their role and the mountain's apps. */
function toolsFor(c) {
  return TOOLS.filter((t) => (!t.module || c.modules.has(t.module)) && (!t.roles || MANAGERS.includes(c.role) || t.roles.includes(c.role)));
}

/** Runs one tool call, checking again that this person may use it. */
async function run(db, c, name, input) {
  const t = toolsFor(c).find((x) => x.name === name);
  if (!t) return { error: 'That look-up is not available to you' };
  for (const k of ['date', 'from', 'to']) if (input && input[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(input[k]))) return { error: `${k} must be YYYY-MM-DD` };
  try { return await t.run(db, c, input || {}); } catch (err) { return { error: 'The look-up failed' }; }
}

module.exports = { TOOLS, toolsFor, run };
