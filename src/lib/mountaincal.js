'use strict';
// The Mountain calendar (2026.11.10, Track CALENDAR): one calendar every staff member can open, showing what is
// happening at the mountain. Two parts:
//   added     events people add (mountain_events): a title, a day or a range, all day or a time, a place, a note, the
//             teams that see it (or everyone) and a kind (event, meeting, training, closure, other).
//   gathered  read only, from what the app already knows (each links to its own screen): closed and limited days, the
//             season's opening and closing days, public events, group bookings (rental groups, booked group inquiries,
//             activity groups), program dates, the ski school season plan (periods, closed days) and school holidays,
//             patrol training shifts, upkeep due (preventive maintenance, work orders, asset inspections and papers),
//             and ticket days (blackouts and special prices, partner pass blackouts).
// Each person sees what is for everyone plus what is for their teams; owners and managers see everything. Gathered
// items never carry a guest's, patient's or payroll detail: a group shows its name and size only.
const crypto = require('crypto');
const { rows, one } = require('../db');
const { z, dateStr, timeStr, addDays, todayIn } = require('./util');
const { bad, forbidden } = require('./errors');
const modules = require('./modules');
const patrolAccess = require('./patrolaccess');
const schoolAccess = require('./schoolaccess');
const lessonPlan = require('./lessonplan');

const TEAMS = [['front_desk', 'Front desk'], ['rentals', 'Rentals'], ['ski_school', 'Ski school'], ['patrol', 'Patrol'], ['lifts', 'Lifts and mountain'], ['office', 'Office']];
const TEAM_KEYS = TEAMS.map((t) => t[0]);
const TEAM_LABEL = Object.fromEntries(TEAMS);
// Kinds people choose, then the two kinds only gathered items have.
const KINDS = [['event', 'Event'], ['meeting', 'Meeting'], ['training', 'Training'], ['closure', 'Closure'], ['other', 'Other']];
const GATHERED_KINDS = [['upkeep', 'Upkeep and inspections'], ['tickets', 'Ticket days']];
const KIND_KEYS = KINDS.map((k) => k[0]);
const ALL_KINDS = [...KINDS, ...GATHERED_KINDS];
const MAX_SPAN = 62; // days one request can ask for (a month view shows six weeks)
const MAX_EVENT_DAYS = 120; // the longest event someone can add
const GROUP_SIZE = 6; // activity places in one order on one slot that count as a group
const FEED_BACK = 30; const FEED_AHEAD = 180; // days the calendar feed covers

// The team a login's role belongs to, and the team each staff department belongs to.
const ROLE_TEAMS = { counter: ['front_desk', 'rentals'], instructor: ['ski_school'], patrol: ['patrol'], staff: ['lifts'] };
const DEPT_TEAM = { lifts: 'lifts', grooming: 'lifts', maintenance: 'lifts', attractions: 'lifts', rentals: 'rentals', ski_school: 'ski_school', patrol: 'patrol', guest_services: 'front_desk', food: 'front_desk', admin: 'office' };
const MANAGERS = ['owner', 'manager'];

// ---------------------------------------------------------------- who is looking

/**
 * What this person may see and add. auth: req.auth (or the same fields read for a calendar feed).
 * -> { manager, teams: [keys], addFor: [team keys] | 'all', schoolDirector, patrolLead }
 */
async function viewer(db, auth) {
  const manager = MANAGERS.includes(auth.role);
  if (manager) return { manager: true, teams: [...TEAM_KEYS], addFor: 'all', schoolDirector: false, patrolLead: false };
  const teams = new Set(ROLE_TEAMS[auth.role] || []);
  if (auth.onPatrol) teams.add('patrol');
  if (auth.staffId) {
    const depts = await rows(db, `SELECT DISTINCT p.department FROM staff_positions sp JOIN positions p ON p.tenant_id = sp.tenant_id AND p.id = sp.position_id
      WHERE sp.tenant_id = ? AND sp.staff_id = ?`, [auth.tenantId, auth.staffId]);
    for (const d of depts) if (DEPT_TEAM[d.department]) teams.add(DEPT_TEAM[d.department]);
  }
  const schoolDirector = auth.role === 'instructor' && schoolAccess.levelNow(auth) === 'director';
  let patrolLead = false;
  if (auth.role === 'patrol' || auth.onPatrol) patrolLead = ['admin', 'manager'].includes(await patrolAccess.levelOf(db, { auth }));
  const addFor = [...(schoolDirector ? ['ski_school'] : []), ...(patrolLead ? ['patrol'] : [])];
  return { manager: false, teams: TEAM_KEYS.filter((t) => teams.has(t)), addFor, schoolDirector, patrolLead };
}

/** The sign-in fields a calendar feed needs, read for one login (null when the login is gone, off or past its access). */
async function authOfUser(db, tenantId, userId) {
  const u = await one(db, `SELECT u.id, u.tenant_id, u.role, u.staff_id,
      (u.staff_id IS NOT NULL AND EXISTS (SELECT 1 FROM patrol_members m JOIN staff s2 ON s2.tenant_id = m.tenant_id AND s2.id = m.staff_id AND s2.status = 'active' WHERE m.tenant_id = u.tenant_id AND m.staff_id = u.staff_id)) AS on_patrol,
      (SELECT ip.school_access FROM instructor_profiles ip JOIN staff s3 ON s3.tenant_id = ip.tenant_id AND s3.id = ip.staff_id AND s3.status = 'active' WHERE ip.tenant_id = u.tenant_id AND ip.staff_id = u.staff_id) AS school_access
    FROM users u JOIN tenants t ON t.id = u.tenant_id
    WHERE u.tenant_id = ? AND u.id = ? AND u.active = 1 AND t.status = 'active' AND (u.access_ends_on IS NULL OR u.access_ends_on >= CURDATE())
      AND (t.sandbox_expires_at IS NULL OR t.sandbox_expires_at >= NOW())`, [tenantId, userId]);
  if (!u || u.role === 'area') return null; // the ski area's read-only login has no calendar
  return { tenantId: Number(u.tenant_id), userId: Number(u.id), role: u.role, staffId: u.staff_id ? Number(u.staff_id) : null, onPatrol: Boolean(Number(u.on_patrol)), schoolLevel: u.role === 'instructor' ? (u.school_access || 'instructor') : null };
}

/** Can this person see an item meant for these teams (null: everyone)? */
const canSee = (who, teams) => who.manager || !teams || !teams.length || teams.some((t) => who.teams.includes(t));

/** Can this person add, change or delete an event for these teams? Directors and patrol leads: their own team only. */
function canWrite(who, teams) {
  if (who.addFor === 'all') return true;
  if (!teams || !teams.length) return false; // everyone: owners and managers only
  return teams.every((t) => who.addFor.includes(t));
}

// ---------------------------------------------------------------- events people add

const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
const teamsOf = (raw) => (raw ? String(raw).split(',').filter((t) => TEAM_KEYS.includes(t)) : null);

const eventFields = {
  title: z.string().trim().min(1, 'Give the event a title').max(120),
  kind: z.enum(KIND_KEYS).default('event'),
  starts_on: dateStr,
  ends_on: dateStr.nullable().optional(),
  all_day: z.boolean().default(true),
  start_time: timeStr.nullable().optional(),
  end_time: timeStr.nullable().optional(),
  place: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  teams: z.array(z.enum(TEAM_KEYS)).max(TEAM_KEYS.length).nullable().optional(), // null or empty: everyone
};
const eventSchema = z.object(eventFields);

/** Checks an event's days and times. Returns the row to keep. Throws 400 in plain words. */
function cleanEvent(b) {
  const endsOn = b.ends_on || b.starts_on;
  if (endsOn < b.starts_on) throw bad('The last day must be on or after the first day');
  const days = Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${b.starts_on}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_EVENT_DAYS) throw bad(`An event can last at most ${MAX_EVENT_DAYS} days`);
  let start = null; let end = null;
  if (!b.all_day) {
    start = hhmm(b.start_time); end = hhmm(b.end_time);
    if (!start) throw bad('Give a start time, or make it all day');
    if (end && end <= start) throw bad('The end time must be after the start time');
  }
  const teams = b.teams && b.teams.length ? TEAM_KEYS.filter((t) => b.teams.includes(t)) : null;
  return {
    title: b.title, kind: b.kind, starts_on: b.starts_on, ends_on: endsOn, all_day: b.all_day ? 1 : 0, start_time: start, end_time: end,
    place: b.place || null, note: b.note || null, teams: teams && teams.length === TEAM_KEYS.length ? null : teams,
  };
}

function eventItem(e, who) {
  const teams = teamsOf(e.teams);
  return {
    id: `event:${e.id}`, event_id: Number(e.id), source: 'added', source_label: 'Added by staff', kind: e.kind, title: e.title,
    starts_on: e.starts_on, ends_on: e.ends_on, all_day: Boolean(Number(e.all_day)), start_time: hhmm(e.start_time), end_time: hhmm(e.end_time),
    place: e.place || null, note: e.note || null, teams, link: null, editable: Boolean(who) && canWrite(who, teams),
  };
}

// ---------------------------------------------------------------- what the app already knows

const item = (o) => ({ all_day: true, start_time: null, end_time: null, place: null, note: null, teams: null, link: null, editable: false, ends_on: o.starts_on, ...o });
const ymd = (v) => (v ? String(v).slice(0, 10) : null);
const clampDay = (d, from, to) => (d < from ? from : d > to ? to : d);
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

/** Each gathered source: [module it belongs to (null: always), fn(db, tenantId, from, to, today) -> items]. */
const SOURCES = [
  // Closed and limited days on the operating calendar (Mountain status).
  ['conditions', async (db, t, from, to) => (await rows(db, "SELECT on_date, status, open_time, close_time, notes FROM calendar_days WHERE tenant_id = ? AND on_date BETWEEN ? AND ? AND status IN ('closed','limited') ORDER BY on_date LIMIT 400", [t, from, to]))
    .map((d) => item({ id: `day:${ymd(d.on_date)}`, source: 'days', source_label: 'Operating calendar', kind: d.status === 'closed' ? 'closure' : 'other',
      title: d.status === 'closed' ? 'Mountain closed' : `Limited operation${d.open_time ? `, ${hhmm(d.open_time)} to ${hhmm(d.close_time) || 'close'}` : ''}`,
      starts_on: ymd(d.on_date), note: d.notes || null, link: '#/conditions' }))],
  // The season's opening and closing days (Settings: guest settings and the season end).
  [null, async (db, t, from, to) => {
    const [g, tn] = await Promise.all([one(db, 'SELECT season_opens_on FROM guest_settings WHERE tenant_id = ?', [t]), one(db, 'SELECT season_ends_on FROM tenants WHERE id = ?', [t])]);
    const out = [];
    const opens = g && ymd(g.season_opens_on); const ends = tn && ymd(tn.season_ends_on);
    if (opens && opens >= from && opens <= to) out.push(item({ id: `season:open:${opens}`, source: 'season', source_label: 'Season dates', kind: 'event', title: 'Opening day', starts_on: opens }));
    if (ends && ends >= from && ends <= to) out.push(item({ id: `season:close:${ends}`, source: 'season', source_label: 'Season dates', kind: 'event', title: 'Closing day', starts_on: ends }));
    return out;
  }],
  // Public events (the conditions feed's "upcoming events"): anyone may see them.
  [null, async (db, t, from, to) => (await rows(db, 'SELECT id, title, starts_at, ends_at FROM events WHERE tenant_id = ? AND starts_at < ? AND COALESCE(ends_at, starts_at) >= ? ORDER BY starts_at LIMIT 200', [t, `${addDays(to, 1)} 00:00:00`, `${from} 00:00:00`]))
    .map((e) => { const s = String(e.starts_at); const en = e.ends_at ? String(e.ends_at) : null; const sameDay = !en || ymd(en) === ymd(s); return item({ id: `public:${e.id}`, source: 'public', source_label: 'Public event', kind: 'event', title: e.title, starts_on: ymd(s), ends_on: en ? ymd(en) : ymd(s), all_day: s.slice(11, 16) === '00:00' && !en, start_time: s.slice(11, 16) === '00:00' && !en ? null : s.slice(11, 16), end_time: en && sameDay ? en.slice(11, 16) : null }); })],
  // Rental groups (Rentals, Groups): the group's name and how many in it.
  ['rentals', async (db, t, from, to) => (await rows(db, `SELECT g.id, g.name, g.rental_on, g.days,
      (SELECT COUNT(*) FROM rental_contracts c WHERE c.tenant_id = g.tenant_id AND c.group_id = g.id AND c.status <> 'cancelled') AS members
    FROM rental_groups g WHERE g.tenant_id = ? AND g.status <> 'closed' AND g.rental_on <= ? AND DATE_ADD(g.rental_on, INTERVAL g.days - 1 DAY) >= ? ORDER BY g.rental_on LIMIT 200`, [t, to, from]))
    .map((g) => item({ id: `rentalgroup:${g.id}`, source: 'rentals', source_label: 'Rental group', kind: 'event', title: `Rental group: ${g.name}${Number(g.members) ? ` (${g.members})` : ''}`,
      starts_on: ymd(g.rental_on), ends_on: addDays(ymd(g.rental_on), Math.max(1, Number(g.days)) - 1), teams: ['rentals', 'front_desk'], link: '#/rentals?tab=groups' }))],
  // Group inquiries marked Booked (Online shop): the group's name and size, never the contact's details.
  ['shop', async (db, t, from, to) => (await rows(db, "SELECT id, organisation, group_size, preferred_on FROM group_enquiries WHERE tenant_id = ? AND status = 'booked' AND preferred_on BETWEEN ? AND ? ORDER BY preferred_on LIMIT 200", [t, from, to])) // spelling-ok
    .map((g) => item({ id: `groupinq:${g.id}`, source: 'groups', source_label: 'Group booking', kind: 'event', title: `Group: ${g.organisation || 'Booked group'} (${g.group_size})`, // spelling-ok
      starts_on: ymd(g.preferred_on), teams: ['front_desk', 'office'], link: '#/shop?tab=groups' }))],
  // Activity groups: one order with several places on the same attraction slot (a birthday party on the coaster).
  ['sell', async (db, t, from, to) => (await rows(db, `SELECT oi.order_id, b.on_date, b.start_time, b.end_time, a.name AS attraction, COUNT(*) AS places
    FROM activity_bookings b JOIN order_items oi ON oi.tenant_id = b.tenant_id AND oi.id = b.order_item_id JOIN attractions a ON a.tenant_id = b.tenant_id AND a.id = b.attraction_id
    WHERE b.tenant_id = ? AND b.status = 'booked' AND b.on_date BETWEEN ? AND ?
    GROUP BY oi.order_id, b.on_date, b.start_time, b.end_time, a.name HAVING COUNT(*) >= ? ORDER BY b.on_date, b.start_time LIMIT 200`, [t, from, to, GROUP_SIZE]))
    .map((g) => item({ id: `actgroup:${g.order_id}:${ymd(g.on_date)}:${hhmm(g.start_time) || 'day'}`, source: 'activities', source_label: 'Activity group', kind: 'event',
      title: `Group of ${g.places}: ${g.attraction}`, starts_on: ymd(g.on_date), all_day: !g.start_time, start_time: hhmm(g.start_time), end_time: hhmm(g.end_time), place: g.attraction, teams: ['front_desk', 'lifts'] }))],
  // Program dates (Programs): one line per program per day, with the time from its first to its last group.
  ['programs', async (db, t, from, to) => (await rows(db, `SELECT p.id, p.name, DATE(s.starts_at) AS on_date, MIN(TIME(s.starts_at)) AS start_t, MAX(TIME(s.ends_at)) AS end_t,
      SUM(s.status <> 'cancelled') AS running, COUNT(*) AS meetings
    FROM program_sessions s JOIN programs p ON p.tenant_id = s.tenant_id AND p.id = s.program_id
    WHERE s.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ? GROUP BY p.id, p.name, DATE(s.starts_at) ORDER BY on_date, start_t LIMIT 400`, [t, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]))
    .map((s) => { const off = Number(s.running) === 0; return item({ id: `program:${s.id}:${ymd(s.on_date)}`, source: 'programs', source_label: 'Programs', kind: off ? 'closure' : 'event',
      title: `${off ? 'Canceled: ' : ''}${s.name}`, starts_on: ymd(s.on_date), all_day: false, start_time: hhmm(s.start_t), end_time: hhmm(s.end_t), teams: ['ski_school', 'front_desk'], link: `#/programs/${s.id}` }); })],
  // School holidays (Ski school, Planning).
  ['school', async (db, t, from, to) => (await rows(db, 'SELECT id, on_date, name FROM school_holidays WHERE tenant_id = ? AND on_date BETWEEN ? AND ? ORDER BY on_date LIMIT 200', [t, from, to]))
    .map((d) => item({ id: `holiday:${d.id}`, source: 'school', source_label: 'School holiday', kind: 'other', title: `School holiday: ${d.name}`, starts_on: ymd(d.on_date), teams: ['ski_school', 'front_desk'], link: '#/school?tab=plan&view=season' }))],
  // The ski school's published season plans: its named periods and the days it closes.
  ['school', async (db, t, from, to) => {
    const out = [];
    for (const p of await rows(db, "SELECT id, name, from_on, to_on, doc FROM lesson_plans WHERE tenant_id = ? AND status = 'published' AND from_on <= ? AND to_on >= ? LIMIT 20", [t, to, from])) {
      let doc; try { doc = JSON.parse(p.doc); } catch (_) { continue; }
      const types = new Map((doc.day_types || []).map((x) => [x.key, x]));
      for (const per of doc.periods || []) {
        if (per.to < from || per.from > to || per.to < ymd(p.from_on) || per.from > ymd(p.to_on)) continue;
        const type = types.get(per.day_type);
        out.push(item({ id: `plan:${p.id}:period:${per.from}`, source: 'school', source_label: 'Ski school season plan', kind: type && type.closed ? 'closure' : 'other',
          title: `Ski school: ${per.name || (type ? type.name : 'Period')}${per.name && type ? ` (${type.name})` : ''}`, starts_on: per.from, ends_on: per.to, teams: ['ski_school'], link: '#/school?tab=plan&view=season' }));
      }
      const a = from > ymd(p.from_on) ? from : ymd(p.from_on); const b = to < ymd(p.to_on) ? to : ymd(p.to_on);
      if (a > b) continue;
      for (const d of lessonPlan.expand(doc, a, b)) {
        if (!d.closed || d.source !== 'exception') continue; // a closed period shows above; a closed weekday is the plan's normal week
        out.push(item({ id: `plan:${p.id}:closed:${d.date}`, source: 'school', source_label: 'Ski school season plan', kind: 'closure', title: 'Ski school closed', starts_on: d.date, teams: ['ski_school'], link: '#/school?tab=plan&view=season' }));
      }
    }
    return out;
  }],
  // Patrol training on the published patrol schedule (a shift whose role or note says training).
  ['patrol', async (db, t, from, to) => (await rows(db, `SELECT DATE(starts_at) AS on_date, COALESCE(NULLIF(role_label, ''), 'Training') AS what, MIN(TIME(starts_at)) AS start_t, MAX(TIME(ends_at)) AS end_t, COUNT(*) AS people
    FROM patrol_shifts WHERE tenant_id = ? AND status = 'published' AND starts_at >= ? AND starts_at < ? AND (role_label LIKE '%train%' OR notes LIKE '%train%')
    GROUP BY DATE(starts_at), COALESCE(NULLIF(role_label, ''), 'Training') ORDER BY on_date LIMIT 200`, [t, `${from} 00:00:00`, `${addDays(to, 1)} 00:00:00`]))
    .map((s) => item({ id: `patroltrain:${ymd(s.on_date)}:${s.what}`, source: 'patrol', source_label: 'Patrol schedule', kind: 'training', title: /train/i.test(s.what) ? `Patrol: ${s.what}` : `Patrol training: ${s.what}`,
      starts_on: ymd(s.on_date), all_day: false, start_time: hhmm(s.start_t), end_time: hhmm(s.end_t), note: plural(s.people, 'patroller'), teams: ['patrol'], link: '#/patrol/schedule' }))],
  // Preventive maintenance coming due (by days), on lifts and machines. Overdue shows on today.
  ['conditions', async (db, t, from, to, today) => (await rows(db, `SELECT k.id, k.name, k.interval_days, k.last_done_on, l.name AS lift, a.name AS asset
    FROM pm_tasks k LEFT JOIN lifts l ON l.tenant_id = k.tenant_id AND l.id = k.lift_id LEFT JOIN ops_assets a ON a.tenant_id = k.tenant_id AND a.id = k.asset_id
    WHERE k.tenant_id = ? AND k.active = 1 AND k.interval_days IS NOT NULL LIMIT 500`, [t]))
    .map((k) => { const due = k.last_done_on ? addDays(ymd(k.last_done_on), Number(k.interval_days)) : today; const late = due < today; return { k, due, late, on: late ? today : due }; })
    .filter((x) => x.on >= from && x.on <= to)
    .map(({ k, due, late, on }) => item({ id: `pm:${k.id}`, source: 'upkeep', source_label: 'Maintenance', kind: 'upkeep', title: `${late ? 'Overdue' : 'Due'}: ${k.name}${k.lift || k.asset ? ` (${k.lift || k.asset})` : ''}`,
      starts_on: on, note: late ? `Was due ${due}` : null, teams: ['lifts', 'office'], link: '#/conditions?tab=maint' }))],
  // Work orders with a due date (open ones only).
  ['conditions', async (db, t, from, to) => (await rows(db, `SELECT w.id, w.title, w.due_date, w.priority, l.name AS lift FROM work_orders w LEFT JOIN lifts l ON l.tenant_id = w.tenant_id AND l.id = w.lift_id
    WHERE w.tenant_id = ? AND w.status IN ('open','in_progress','waiting_parts') AND w.due_date BETWEEN ? AND ? ORDER BY w.due_date LIMIT 200`, [t, from, to]))
    .map((w) => item({ id: `wo:${w.id}`, source: 'upkeep', source_label: 'Work order', kind: 'upkeep', title: `Work order due: ${w.title}${w.lift ? ` (${w.lift})` : ''}`, starts_on: ymd(w.due_date),
      note: w.priority === 'urgent' || w.priority === 'high' ? `${w.priority === 'urgent' ? 'Urgent' : 'High'} priority` : null, teams: ['lifts', 'office'], link: '#/conditions?tab=maint' }))],
  // Annual inspections, registrations and insurance running out (Assets and fleet).
  ['assets', async (db, t, from, to) => {
    const papers = [['inspection_expires', 'Annual inspection due'], ['registration_expires', 'Registration runs out'], ['insurance_expires', 'Insurance runs out']];
    const out = [];
    for (const a of await rows(db, `SELECT id, name, inspection_expires, registration_expires, insurance_expires FROM ops_assets WHERE tenant_id = ? AND status <> 'retired'
      AND (inspection_expires BETWEEN ? AND ? OR registration_expires BETWEEN ? AND ? OR insurance_expires BETWEEN ? AND ?) LIMIT 300`, [t, from, to, from, to, from, to])) {
      for (const [col, words] of papers) {
        const on = ymd(a[col]);
        if (on && on >= from && on <= to) out.push(item({ id: `paper:${a.id}:${col}`, source: 'upkeep', source_label: 'Assets and fleet', kind: 'upkeep', title: `${words}: ${a.name}`, starts_on: on, teams: ['lifts', 'office'], link: `#/assets/a/${a.id}` }));
      }
    }
    return out;
  }],
  // Ticket days from the price calendar: blackouts and special prices, by day, with the products named.
  ['catalog', async (db, t, from, to) => {
    const byDay = new Map();
    for (const r of await rows(db, `SELECT c.on_date, c.blackout, p.name FROM price_calendar c JOIN products p ON p.tenant_id = c.tenant_id AND p.id = c.product_id
      WHERE c.tenant_id = ? AND c.on_date BETWEEN ? AND ? AND p.active = 1 GROUP BY c.on_date, c.blackout, p.name ORDER BY c.on_date, p.name LIMIT 2000`, [t, from, to])) {
      const k = `${ymd(r.on_date)}|${Number(r.blackout) ? 'b' : 'p'}`;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(r.name);
    }
    return [...byDay].map(([k, names]) => {
      const [day, what] = k.split('|');
      const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
      return item({ id: `prices:${day}:${what}`, source: 'tickets', source_label: 'Price calendar', kind: 'tickets', title: what === 'b' ? `Blackout: ${list}` : `Special price: ${list}`, starts_on: day, teams: ['front_desk', 'office'], link: '#/catalog' });
    });
  }],
  // Partner pass blackout days (Sell, Partner passes).
  ['sell', async (db, t, from, to) => (await rows(db, `SELECT b.on_date, GROUP_CONCAT(p.name ORDER BY p.name SEPARATOR ', ') AS names FROM partner_blackouts b JOIN partner_programs p ON p.tenant_id = b.tenant_id AND p.id = b.program_id
    WHERE b.tenant_id = ? AND b.on_date BETWEEN ? AND ? AND p.active = 1 GROUP BY b.on_date ORDER BY b.on_date LIMIT 200`, [t, from, to]))
    .map((b) => item({ id: `partnerblackout:${ymd(b.on_date)}`, source: 'tickets', source_label: 'Partner passes', kind: 'tickets', title: `Partner pass blackout: ${b.names}`, starts_on: ymd(b.on_date), teams: ['front_desk', 'office'], link: '#/sell?tab=partners' }))],
];

/** Sort: by first day, all-day first, then by time, then title. */
const order = (a, b) => a.starts_on.localeCompare(b.starts_on) || (a.all_day === b.all_day ? 0 : a.all_day ? -1 : 1) || String(a.start_time || '').localeCompare(String(b.start_time || '')) || a.title.localeCompare(b.title);

/**
 * Everything on the calendar from..to (inclusive) this person may see. who: viewer(). Optional filters: team (a team
 * key: what is for that team, plus everyone's), kinds (list of kind keys).
 */
async function itemsFor(db, tenantId, who, from, to, { team = null, kinds = null } = {}) {
  const tz = (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const today = todayIn(tz);
  const on = new Set(await modules.enabledKeys(tenantId));
  const added = (await rows(db, 'SELECT * FROM mountain_events WHERE tenant_id = ? AND starts_on <= ? AND ends_on >= ? ORDER BY starts_on LIMIT 1000', [tenantId, to, from])).map((e) => eventItem(e, who));
  const gathered = (await Promise.all(SOURCES.filter(([m]) => !m || on.has(m)).map(([, fn]) => fn(db, tenantId, from, to, today)))).flat();
  let list = [...added, ...gathered].filter((x) => canSee(who, x.teams));
  if (team) list = list.filter((x) => !x.teams || x.teams.includes(team));
  if (kinds && kinds.length) list = list.filter((x) => kinds.includes(x.kind));
  return { today, items: list.sort(order) };
}

/** Checks a from..to request. */
function range(from, to, most = MAX_SPAN) {
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('Use dates like 2026-12-01');
  if (to < from) throw bad('The end date must be on or after the start date');
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 >= most) throw bad(`Ask for at most ${most} days at a time`);
  return { from, to };
}

// ---------------------------------------------------------------- the private calendar feed (.ics)

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newFeedToken = () => crypto.randomBytes(32).toString('base64url');

/** RFC 5545 text: escape \ ; , and new lines, and fold lines at 75 octets. */
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const compactDay = (d) => d.replace(/-/g, '');
const compactTime = (t) => `${t.replace(':', '')}00`;

/** The calendar as an iCalendar file, in the mountain's time zone. */
function toIcs(items, { name, tz, host, stamp }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Verdynt/OS//Mountain calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const x of items) {
    const kind = (ALL_KINDS.find((k) => k[0] === x.kind) || [x.kind, 'Other'])[1];
    lines.push('BEGIN:VEVENT', `UID:${icsText(x.id)}@${host}`, `DTSTAMP:${stamp}`, `SUMMARY:${icsText(x.title)}`, `CATEGORIES:${icsText(kind)}`);
    if (x.all_day || !x.start_time) {
      lines.push(`DTSTART;VALUE=DATE:${compactDay(x.starts_on)}`, `DTEND;VALUE=DATE:${compactDay(addDays(x.ends_on, 1))}`);
    } else {
      const end = x.end_time && x.end_time > x.start_time ? x.end_time : null;
      lines.push(`DTSTART;TZID=${tz}:${compactDay(x.starts_on)}T${compactTime(x.start_time)}`);
      if (end) lines.push(`DTEND;TZID=${tz}:${compactDay(x.starts_on)}T${compactTime(end)}`);
      const days = Math.round((Date.parse(`${x.ends_on}T00:00:00Z`) - Date.parse(`${x.starts_on}T00:00:00Z`)) / 86400000) + 1;
      if (days > 1) lines.push(`RRULE:FREQ=DAILY;COUNT=${days}`); // the same times each day of the range
    }
    if (x.place) lines.push(`LOCATION:${icsText(x.place)}`);
    const desc = [x.note, x.teams ? `For: ${x.teams.map((t) => TEAM_LABEL[t]).join(', ')}` : 'For: everyone', `From: ${x.source_label}`].filter(Boolean).join('\n');
    lines.push(`DESCRIPTION:${icsText(desc)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** The person a feed link belongs to, or null (unknown, turned off, or the login can no longer sign in). */
async function feedOwner(db, token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token || ''))) return null;
  const f = await one(db, 'SELECT tenant_id, user_id FROM calendar_feeds WHERE token_sha = ?', [sha(token)]);
  if (!f) return null;
  const auth = await authOfUser(db, f.tenant_id, f.user_id);
  if (!auth) return null;
  return auth;
}

module.exports = {
  TEAMS, TEAM_KEYS, TEAM_LABEL, KINDS, KIND_KEYS, GATHERED_KINDS, ALL_KINDS, MAX_SPAN, GROUP_SIZE, FEED_BACK, FEED_AHEAD,
  viewer, authOfUser, canSee, canWrite, eventSchema, eventFields, cleanEvent, eventItem, itemsFor, range, sha, newFeedToken, toIcs, feedOwner, icsText, fold,
};
