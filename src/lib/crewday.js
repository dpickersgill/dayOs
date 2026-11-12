'use strict';

// The crew's day for a municipality (release 2026.11.20): the manager's crew board on Today (who is in, who is off, who
// is on call, and what each person has today), a crew member's own "My work today", and the people who hold a water or
// wastewater operator license (for the boil water advisory's certified operators). Only staff names, never a resident's
// contact details: Today is often on a wall screen.
const { pool, rows, one } = require('../db');
const { addDays, nowIn, dayRange, localTime } = require('./util');
const MF = require('./mapfeatures');
const M = require('./modules');
const OC = require('./oncall');
const { OPERATOR_CODES } = require('./crewcerts');
const { progressWords } = require('./programprogress');

// The water, sewer and stormwater groups of map items (as routes/utilities.js counts them for its Today cards).
const SYSTEM_GROUPS = { water: ['potable'], sewer: ['sewer'], stormwater: ['storm', 'drainage'] };
const kindsOfGroup = (g) => MF.KINDS.filter((k) => SYSTEM_GROUPS[g].includes(MF.systemFor(k, 'municipality'))).map((k) => k.key);

/** Work order list filter ?system=water|sewer|stormwater: work orders on that system's map items. */
function systemFilter(req, where, params) {
  const g = String(Array.isArray(req.query.system) ? req.query.system[0] : req.query.system || '');
  if (!SYSTEM_GROUPS[g]) return;
  where.push('w.map_feature_id IN (SELECT f.id FROM map_features f WHERE f.tenant_id = w.tenant_id AND f.kind IN (?))');
  params.push(kindsOfGroup(g));
}

const PRIORITY = { urgent: 0, high: 1, normal: 2, low: 3 };
const tzOf = async (t) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;

/** Open work orders assigned to these people, due today or before (or with no date), most pressing first. */
async function workFor(t, staffIds, today) {
  if (!staffIds.length) return [];
  const Q = require('./requests');
  return (await rows(pool, `SELECT w.id, w.title, w.status, w.priority, w.due_date, w.assigned_staff_id, w.location, mf.tag AS feature_tag, a.name AS asset,
      rq.house_number, rq.cross_street, st.name AS street_name
    FROM work_orders w LEFT JOIN map_features mf ON mf.tenant_id = w.tenant_id AND mf.id = w.map_feature_id LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id
    LEFT JOIN requests rq ON rq.tenant_id = w.tenant_id AND rq.id = w.request_id LEFT JOIN streets st ON st.tenant_id = rq.tenant_id AND st.id = rq.street_id
    WHERE w.tenant_id = ? AND w.assigned_staff_id IN (?) AND w.status NOT IN ('done','cancelled') AND (w.due_date IS NULL OR w.due_date <= ? OR w.status = 'in_progress')
    ORDER BY w.status = 'in_progress' DESC, FIELD(w.priority, 'urgent', 'high', 'normal', 'low'), w.due_date IS NULL, w.due_date, w.id LIMIT 500`, [t, staffIds, today]))
    // The board is often on a wall screen: a resident's house number stays off it (the street stays), as on Today's cards.
    .map((w) => ({ id: Number(w.id), title: w.house_number ? Q.withoutHouseNumber(w.title, w) : w.title, status: w.status, priority: w.priority, due_date: w.due_date ? String(w.due_date).slice(0, 10) : null, overdue: Boolean(w.due_date && String(w.due_date).slice(0, 10) < today),
      where: [w.feature_tag, w.asset].filter(Boolean).join(', ') || null, staff_id: Number(w.assigned_staff_id) }));
}

/** Open programs assigned to these people with targets still to do. */
async function programsFor(t, staffIds) {
  if (!staffIds.length) return [];
  return (await rows(pool, `SELECT p.id, p.name, p.due_on, p.assigned_staff_id,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id) AS total,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'done') AS done,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.status = 'skipped') AS skipped,
      (SELECT COUNT(*) FROM asset_program_targets g WHERE g.tenant_id = p.tenant_id AND g.program_id = p.id AND g.result = 'fail') AS failed
    FROM asset_programs p WHERE p.tenant_id = ? AND p.status = 'open' AND p.assigned_staff_id IN (?) ORDER BY p.due_on IS NULL, p.due_on, p.id`, [t, staffIds]))
    .map((p) => { const pr = { total: Number(p.total), done: Number(p.done), skipped: Number(p.skipped), failed: Number(p.failed) }; pr.todo = pr.total - pr.done - pr.skipped; return { id: Number(p.id), name: p.name, due_on: p.due_on ? String(p.due_on).slice(0, 10) : null, staff_id: Number(p.assigned_staff_id), todo: pr.todo, words: progressWords(pr) }; })
    .filter((p) => p.todo > 0);
}

/**
 * The crew board for a manager's Today: every active staff member with where they are today (in, scheduled, done for
 * the day, off), whether they are on call, and their work. Also what is not assigned, and certifications running out.
 */
async function board(t) {
  const tz = await tzOf(t);
  const now = nowIn(tz); const today = now.slice(0, 10);
  const [from, to] = dayRange(tz, today);
  const on = await M.enabledKeys(t);
  const people = await rows(pool, `SELECT s.id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE s.tenant_id = ? AND s.status = 'active' AND s.in_workforce = 1 ORDER BY p.first_name, p.last_name LIMIT 300`, [t]);
  const ids = people.map((p) => Number(p.id));
  const [punches, shifts, oncall] = await Promise.all([
    ids.length ? rows(pool, 'SELECT staff_id, clock_in, clock_out, callout FROM time_entries WHERE tenant_id = ? AND staff_id IN (?) AND (clock_out IS NULL OR clock_out >= ?) ORDER BY clock_in', [t, ids, from]) : [],
    ids.length ? rows(pool, "SELECT s.staff_id, s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id IN (?) AND s.status = 'published' AND s.starts_at < ? AND s.ends_at > ? ORDER BY s.starts_at", [t, ids, `${addDays(today, 1)} 00:00:00`, `${today} 00:00:00`]) : [],
    OC.onCallNow(pool, t, now),
  ]);
  const work = on.includes('assets') ? await workFor(t, ids, today) : [];
  const programs = on.includes('assets') ? await programsFor(t, ids) : [];
  const doneToday = on.includes('assets') && ids.length ? await rows(pool, "SELECT assigned_staff_id AS s, COUNT(*) AS n FROM work_orders WHERE tenant_id = ? AND status = 'done' AND completed_at >= ? AND completed_at < ? AND assigned_staff_id IN (?) GROUP BY assigned_staff_id", [t, `${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`, ids]) : [];
  const doneBy = new Map(doneToday.map((d) => [Number(d.s), Number(d.n)]));
  const list = people.map((p) => {
    const id = Number(p.id);
    const mine = punches.filter((e) => Number(e.staff_id) === id);
    const open = mine.find((e) => !e.clock_out);
    const shift = shifts.find((s) => Number(s.staff_id) === id);
    const calls = oncall.data.filter((o) => (o.now && o.now.staff_id === id) || (o.tonight && o.tonight.staff_id === id)).map((o) => ({ rotation: o.rotation.name, now: Boolean(o.now && o.now.staff_id === id), tonight: Boolean(o.tonight && o.tonight.staff_id === id) }));
    const state = open ? 'in' : mine.length ? 'done' : shift && String(shift.ends_at).slice(0, 19) > now ? 'scheduled' : 'off'; // a shift that is over with no punch: off
    return {
      staff_id: id, name: `${p.first_name} ${p.last_name}`.trim(), state,
      since: open ? localTime(open.clock_in, tz).slice(11, 16) : null, callout: Boolean(open && Number(open.callout)),
      shift: shift ? { starts: String(shift.starts_at).slice(11, 16), ends: String(shift.ends_at).slice(11, 16), position: shift.position } : null,
      oncall: calls, work: work.filter((w) => w.staff_id === id).slice(0, 6), work_count: work.filter((w) => w.staff_id === id).length,
      programs: programs.filter((g) => g.staff_id === id).slice(0, 3), done_today: doneBy.get(id) || 0,
    };
  });
  const order = { in: 0, scheduled: 1, done: 2, off: 3 };
  list.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  const unassigned = on.includes('assets') ? Number((await one(pool, "SELECT COUNT(*) AS n FROM work_orders WHERE tenant_id = ? AND status NOT IN ('done','cancelled') AND assigned_staff_id IS NULL", [t])).n) : 0;
  const certs = await rows(pool, `SELECT sc.staff_id, CONCAT(p.first_name, ' ', p.last_name) AS name, c.name AS certification, sc.expires_on FROM staff_certifications sc
    JOIN staff s ON s.tenant_id = sc.tenant_id AND s.id = sc.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    JOIN certifications c ON c.tenant_id = sc.tenant_id AND c.id = sc.certification_id
    WHERE sc.tenant_id = ? AND sc.expires_on IS NOT NULL AND sc.expires_on <= ? ORDER BY sc.expires_on LIMIT 20`, [t, addDays(today, 60)]);
  return {
    date: today, time: now.slice(11, 16), holiday: oncall.holiday, people: list,
    counts: { in: list.filter((x) => x.state === 'in').length, scheduled: list.filter((x) => x.state === 'scheduled').length, done: list.filter((x) => x.state === 'done').length, off: list.filter((x) => x.state === 'off').length },
    oncall: oncall.data, unassigned,
    certifications: certs.map((c) => ({ staff_id: Number(c.staff_id), name: String(c.name || '').trim(), certification: c.certification, expires_on: String(c.expires_on).slice(0, 10), expired: String(c.expires_on).slice(0, 10) < today })),
  };
}

/**
 * Everything open that is assigned to one person: what is in progress, then today's and overdue, then the rest (50 at
 * most). "My work today" lists these, and the count beside Work orders in a crew member's menu is the overdue ones
 * (lib/navcounts.js), so the two always agree. Only this person's work orders: staffId comes from their own sign-in.
 */
async function myWork(t, staffId, today) {
  if (!staffId) return [];
  return (await rows(pool, `SELECT w.id, w.title, w.status, w.priority, w.due_date, w.location, mf.tag AS feature_tag, a.name AS asset FROM work_orders w
        LEFT JOIN map_features mf ON mf.tenant_id = w.tenant_id AND mf.id = w.map_feature_id LEFT JOIN ops_assets a ON a.tenant_id = w.tenant_id AND a.id = w.asset_id
        WHERE w.tenant_id = ? AND w.assigned_staff_id = ? AND w.status NOT IN ('done','cancelled')
        ORDER BY w.status = 'in_progress' DESC, (w.due_date IS NOT NULL AND w.due_date <= ?) DESC, FIELD(w.priority, 'urgent', 'high', 'normal', 'low'), w.due_date IS NULL, w.due_date, w.id LIMIT 50`, [t, staffId, today]))
    // The board is often on a wall screen: a resident's house number stays off it (the street stays), as on Today's cards.
    .map((w) => ({ id: Number(w.id), title: w.house_number ? require('./requests').withoutHouseNumber(w.title, w) : w.title, status: w.status, priority: w.priority, due_date: w.due_date ? String(w.due_date).slice(0, 10) : null, today: Boolean(w.due_date && String(w.due_date).slice(0, 10) <= today), overdue: Boolean(w.due_date && String(w.due_date).slice(0, 10) < today), where: [w.feature_tag, w.asset, w.location].filter(Boolean).join(', ') || null }));
}

/** "My work today" for a crew member: the clock, on call, assigned work orders and programs, the bulk pickup route and building rounds due. */
async function myDay(t, staffId, role) {
  const tz = await tzOf(t);
  const now = nowIn(tz); const today = now.slice(0, 10);
  const on = await M.enabledKeys(t);
  const out = { date: today, linked: Boolean(staffId), clock: null, shift: null, oncall: [], work: [], programs: [], bulk: null, rounds: [] };
  if (staffId) {
    const open = await one(pool, 'SELECT id, clock_in, callout FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL', [t, staffId]);
    const st = await one(pool, 'SELECT in_workforce FROM staff WHERE tenant_id = ? AND id = ?', [t, staffId]);
    out.clock = { in: Boolean(open), since: open ? localTime(open.clock_in, tz).slice(11, 16) : null, callout: Boolean(open && Number(open.callout)), may: Boolean(st && st.in_workforce) };
    const shift = await one(pool, "SELECT s.starts_at, s.ends_at, pos.name AS position FROM shifts s JOIN positions pos ON pos.tenant_id = s.tenant_id AND pos.id = s.position_id WHERE s.tenant_id = ? AND s.staff_id = ? AND s.status = 'published' AND s.starts_at < ? AND s.ends_at > ? ORDER BY s.starts_at LIMIT 1", [t, staffId, `${addDays(today, 1)} 00:00:00`, now]);
    if (shift) out.shift = { starts: String(shift.starts_at).slice(11, 16), ends: String(shift.ends_at).slice(11, 16), position: shift.position };
    out.oncall = await OC.myOnCall(pool, t, staffId);
    if (on.includes('assets')) {
      out.work = await myWork(t, staffId, today);
      out.programs = await programsFor(t, [staffId]);
    }
  }
  // The bulk pickup route is the crew's together (nobody is assigned stops one by one): today's stops, for the crew.
  if (on.includes('solidwaste') && role !== 'counter') {
    const c = await one(pool, "SELECT COUNT(*) AS stops, SUM(outcome IS NOT NULL) AS done FROM bulk_bookings WHERE tenant_id = ? AND collection_date = ? AND status = 'booked'", [t, today]);
    if (Number(c.stops)) out.bulk = { stops: Number(c.stops), done: Number(c.done || 0), href: `#/bulk?tab=day&date=${today}` };
  }
  // Building checks the staff do themselves (rounds), overdue or due this week, by building.
  if (on.includes('buildings') && role !== 'counter') {
    const B = require('./buildings');
    const due = (await B.plansOf(pool, t, today, { who: 'staff' })).filter((p) => p.state === 'overdue' || p.state === 'week' || p.state === 'never');
    const by = new Map();
    for (const p of due) { const k = Number(p.building_id); if (!by.has(k)) by.set(k, { building_id: k, building: p.building, checks: 0, overdue: 0 }); const b = by.get(k); b.checks += 1; if (p.state === 'overdue') b.overdue += 1; }
    out.rounds = [...by.values()];
  }
  return out;
}

/** The people who hold an unexpired license of this kind (OPERATOR_CODES), with their logins: [{ staff_id, name, user_ids, expires_on }]. */
async function licenseHolders(t, kind) {
  const code = OPERATOR_CODES[kind];
  if (!code) return [];
  const today = nowIn(await tzOf(t)).slice(0, 10);
  const list = await rows(pool, `SELECT sc.staff_id, sc.expires_on, CONCAT(p.first_name, ' ', p.last_name) AS name, c.name AS certification,
      (SELECT GROUP_CONCAT(u.id) FROM users u WHERE u.tenant_id = sc.tenant_id AND u.staff_id = sc.staff_id AND u.active = 1) AS user_ids
    FROM staff_certifications sc JOIN certifications c ON c.tenant_id = sc.tenant_id AND c.id = sc.certification_id AND c.code = ?
    JOIN staff s ON s.tenant_id = sc.tenant_id AND s.id = sc.staff_id AND s.status = 'active' JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
    WHERE sc.tenant_id = ? AND (sc.expires_on IS NULL OR sc.expires_on >= ?) ORDER BY p.first_name, p.last_name`, [code, t, today]);
  return list.map((r) => ({ staff_id: Number(r.staff_id), name: String(r.name || '').trim(), certification: r.certification, expires_on: r.expires_on ? String(r.expires_on).slice(0, 10) : null, user_ids: OC.ids(r.user_ids) }));
}

module.exports = { SYSTEM_GROUPS, kindsOfGroup, systemFilter, board, myDay, myWork, licenseHolders, PRIORITY };
