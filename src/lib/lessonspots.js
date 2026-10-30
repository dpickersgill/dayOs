'use strict';
// Spots that follow staff (2026.11.9, Track STAFF). A lesson with spots_mode 'staff' keeps its capacity equal to the
// instructors free and cleared for it times the student ratio (school_settings ratio_kids or ratio_adults by its age
// band), never above spots_cap and never below what is already booked or held. Every place that sells or books a lesson
// keeps reading lesson_sessions.capacity, so nothing else changes: sync() moves capacity when staffing changes.
//
// Call sync() after anything that changes who can teach a lesson time: a plan publish, an instructor's availability or
// day off, a shift offer accepted, an instructor assigned or moved. The lessons job also runs it every 5 minutes for the
// next 21 days. Safe to call often; it only writes rows whose number changed.
//
// How instructors are counted for one day (plan()):
//   - Who teaches: lessonstaffing.instructors (a teaching profile or an instructor sign-in, active).
//   - Cleared for a lesson: lessonstaffing.suits (discipline, level, kids, adaptive) and any certification the lesson needs.
//   - Free: not teaching another lesson, on a work shift, on patrol or coaching a program meeting at that time (the same
//     clashes as workforce.staffProblems), and available (workforce.isAvailable: their weekly pattern or a date marked
//     open; someone who has said neither can work any time). Saying yes to a shift offer for that time counts as available.
//   - Shared: an instructor counts once across lessons that overlap. A lesson keeps its assigned instructor. Lessons
//     already sold without an instructor (set classes and privates with bookings) take theirs first, then lessons that
//     follow staff, most constrained first: adaptive, then kids, then the narrowest level range (lessons alike take one
//     instructor each in turn). Among the instructors who could take a lesson, the ones who suit the fewest other lessons
//     at that time go first.
//   - Advance sale: when no instructor has any availability entered for that date (no open time that day, no weekly
//     pattern for that weekday, no shift offer taken), the lesson sells up to its cap.
// This reads everything for the day in a few queries instead of asking staffProblems per instructor and lesson, so the
// lessons job stays light. Keep it in step with workforce.staffProblems and isAvailable.
const { pool, tx, one, rows } = require('../db');
const { addDays, nowIn, weekdayOf } = require('./util');
const { audit } = require('./audit');
const { spotsLeft } = require('./lessonrules');
const ST = require('./lessonstaffing');
const SS = require('./schoolsettings');

const NO_CAP = 60; // a staff-following lesson with no cap: the most a group lesson holds
const kidsOf = (s) => s.age_max != null && Number(s.age_max) <= 12;
const ratioOf = (set, s) => Math.max(1, Number(kidsOf(s) ? set.ratio_kids : set.ratio_adults) || 1);
const capOf = (s) => (s.spots_cap != null ? Number(s.spots_cap) : NO_CAP);
const day = (dt) => String(dt).slice(0, 10);
const tm = (dt) => String(dt).slice(11, 19) || '00:00:00';
const overlaps = (a, b) => a.s < b.e && b.s < a.e;
const isTx = (db) => Boolean(db && typeof db.beginTransaction === 'function');
/** The most constrained lesson first: adaptive, kids, then the narrowest level range. */
const rankOf = (s) => {
  const width = s.level_min != null && s.level_max != null ? Number(s.level_max) - Number(s.level_min) : 9;
  return (s.discipline === 'adaptive' ? 0 : kidsOf(s) ? 100 : 200) + width;
};

/** Students booked and spots held (waitlist offers standing, online requests waiting) per lesson, for a list of ids. */
async function counts(db, tenantId, ids) {
  const out = new Map(ids.map((id) => [Number(id), { booked: 0, held: 0 }]));
  if (!ids.length) return out;
  for (const r of await rows(db, "SELECT session_id, COUNT(*) AS n FROM lesson_bookings WHERE tenant_id = ? AND session_id IN (?) AND status IN ('booked','attended') GROUP BY session_id", [tenantId, ids])) out.get(Number(r.session_id)).booked = Number(r.n);
  for (const r of await rows(db, "SELECT session_id, COUNT(*) AS n FROM lesson_waitlist WHERE tenant_id = ? AND session_id IN (?) AND status = 'offered' AND offer_expires_at > UTC_TIMESTAMP() GROUP BY session_id", [tenantId, ids])) out.get(Number(r.session_id)).held += Number(r.n);
  for (const r of await rows(db, "SELECT session_id, students FROM lesson_requests WHERE tenant_id = ? AND session_id IN (?) AND status IN ('pending','awaiting_payment')", [tenantId, ids])) {
    let k = 1; try { k = JSON.parse(r.students).students.length || 1; } catch (_) { /* one */ }
    out.get(Number(r.session_id)).held += k;
  }
  return out;
}

/**
 * Everything needed to count instructors on some days, read once: { tz, now, set, teachers, lessons, busy, windows,
 * open, openEver, offers, certs }. dates: a list of 'YYYY-MM-DD'.
 */
async function load(db, tenantId, dates) {
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const set = await SS.get(db, tenantId);
  const list = [...new Set(dates)].sort();
  const from = `${list[0]} 00:00:00`; const to = `${addDays(list[list.length - 1], 1)} 00:00:00`;
  const teachers = await ST.instructors(db, tenantId);
  const ids = teachers.map((i) => i.id);
  const lessons = (await rows(db, `SELECT id, product_id, starts_at, ends_at, discipline, format, level_min, level_max, age_min, age_max, capacity, instructor_id, required_certification_id,
      kind, spots_mode, spots_cap, plan_id, status FROM lesson_sessions WHERE tenant_id = ? AND status = 'scheduled' AND starts_at < ? AND ends_at > ? ORDER BY starts_at, id`, [tenantId, to, from]))
    .filter((s) => list.includes(day(s.starts_at)));
  const busy = new Map(); // staff id -> [{ s, e, lesson }]
  const addBusy = (staffId, s, e, lesson = 0) => { if (!staffId) return; const k = Number(staffId); if (!busy.has(k)) busy.set(k, []); busy.get(k).push({ s: String(s), e: String(e), lesson: Number(lesson) }); };
  for (const r of await rows(db, "SELECT id, instructor_id, starts_at, ends_at FROM lesson_sessions WHERE tenant_id = ? AND instructor_id IS NOT NULL AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?", [tenantId, to, from])) addBusy(r.instructor_id, r.starts_at, r.ends_at, r.id);
  for (const r of await rows(db, "SELECT staff_id, starts_at, ends_at FROM shifts WHERE tenant_id = ? AND staff_id IS NOT NULL AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?", [tenantId, to, from])) addBusy(r.staff_id, r.starts_at, r.ends_at);
  for (const r of await rows(db, "SELECT staff_id, starts_at, ends_at FROM patrol_shifts WHERE tenant_id = ? AND staff_id IS NOT NULL AND status <> 'cancelled' AND starts_at < ? AND ends_at > ?", [tenantId, to, from])) addBusy(r.staff_id, r.starts_at, r.ends_at);
  const levelCoaches = new Map();
  for (const r of await rows(db, 'SELECT group_id, coach_staff_id FROM program_levels WHERE tenant_id = ? AND coach_staff_id IS NOT NULL', [tenantId])) {
    if (!levelCoaches.has(Number(r.group_id))) levelCoaches.set(Number(r.group_id), new Set());
    levelCoaches.get(Number(r.group_id)).add(Number(r.coach_staff_id));
  }
  for (const r of await rows(db, `SELECT ps.starts_at, ps.ends_at, ps.group_id, ps.coach_staff_id, g.coach_staff_id AS group_coach FROM program_sessions ps
      LEFT JOIN program_groups g ON g.tenant_id = ps.tenant_id AND g.id = ps.group_id WHERE ps.tenant_id = ? AND ps.status = 'scheduled' AND ps.starts_at < ? AND ps.ends_at > ?`, [tenantId, to, from])) {
    const who = new Set();
    if (r.coach_staff_id) who.add(Number(r.coach_staff_id)); else if (r.group_coach) who.add(Number(r.group_coach));
    for (const c of levelCoaches.get(Number(r.group_id)) || []) who.add(c);
    for (const c of who) addBusy(c, r.starts_at, r.ends_at);
  }
  const windows = new Map(); const open = new Map(); const openEver = new Set(); const offers = new Map(); const certs = new Map();
  if (ids.length) {
    for (const r of await rows(db, 'SELECT staff_id, weekday, start_time, end_time FROM availability WHERE tenant_id = ? AND staff_id IN (?)', [tenantId, ids])) {
      const k = Number(r.staff_id); if (!windows.has(k)) windows.set(k, []); windows.get(k).push({ weekday: Number(r.weekday), s: String(r.start_time), e: String(r.end_time) });
    }
    for (const r of await rows(db, 'SELECT DISTINCT staff_id FROM instructor_open WHERE tenant_id = ? AND staff_id IN (?)', [tenantId, ids])) openEver.add(Number(r.staff_id));
    for (const r of await rows(db, 'SELECT staff_id, open_date, start_time, end_time FROM instructor_open WHERE tenant_id = ? AND staff_id IN (?) AND open_date IN (?)', [tenantId, ids, list])) {
      const k = `${r.staff_id}|${day(r.open_date)}`; if (!open.has(k)) open.set(k, []); open.get(k).push({ s: String(r.start_time), e: String(r.end_time) });
    }
    for (const r of await rows(db, `SELECT x.staff_id, o.starts_at, o.ends_at FROM shift_offers o JOIN shift_offer_sends x ON x.tenant_id = o.tenant_id AND x.offer_id = o.id AND x.answer = 'yes'
        WHERE o.tenant_id = ? AND o.starts_at < ? AND o.ends_at > ?`, [tenantId, to, from])) {
      const k = Number(r.staff_id); if (!offers.has(k)) offers.set(k, []); offers.get(k).push({ s: String(r.starts_at), e: String(r.ends_at) });
    }
    const needed = [...new Set(lessons.map((s) => s.required_certification_id).filter(Boolean))];
    if (needed.length) {
      for (const r of await rows(db, 'SELECT staff_id, certification_id, expires_on FROM staff_certifications WHERE tenant_id = ? AND staff_id IN (?) AND certification_id IN (?)', [tenantId, ids, needed])) {
        const k = Number(r.staff_id); if (!certs.has(k)) certs.set(k, []); certs.get(k).push({ id: Number(r.certification_id), until: r.expires_on ? day(r.expires_on) : null });
      }
    }
  }
  return { tz: t.timezone, now: nowIn(t.timezone), set, teachers, lessons, busy, windows, open, openEver, offers, certs, dates: list };
}

/** Has anyone said when they can work on this date (open time that day, a weekly pattern for that weekday, an offer taken)? */
function anyAvailability(L, date) {
  const wd = weekdayOf(date);
  for (const i of L.teachers) {
    if ((L.windows.get(i.id) || []).some((w) => w.weekday === wd)) return true;
    if (L.open.has(`${i.id}|${date}`)) return true;
    if ((L.offers.get(i.id) || []).some((o) => day(o.s) === date)) return true;
  }
  return false;
}

/** workforce.isAvailable, from what load() read; a shift offer they said yes to also counts. */
function available(L, staffId, s) {
  const date = day(s.starts_at); const a = tm(s.starts_at); const b = day(s.ends_at) === date ? tm(s.ends_at) : '23:59:59';
  if ((L.offers.get(staffId) || []).some((o) => o.s <= String(s.starts_at) && o.e >= String(s.ends_at))) return true;
  const ws = L.windows.get(staffId) || [];
  const wd = weekdayOf(date);
  if (ws.some((w) => w.weekday === wd && w.s <= a && w.e >= b)) return true;
  if ((L.open.get(`${staffId}|${date}`) || []).some((w) => w.s <= a && w.e >= b)) return true;
  if (ws.length) return false;
  return !L.openEver.has(staffId);
}

/** Instructors cleared and free for a lesson (its own assigned instructor aside), as staff ids. */
function candidates(L, s) {
  const span = { s: String(s.starts_at), e: String(s.ends_at) };
  const out = [];
  for (const i of L.teachers) {
    if (s.instructor_id && Number(s.instructor_id) === i.id) continue;
    if (!ST.suits(i, { discipline: s.discipline, level_max: s.level_max, kids: kidsOf(s) })) continue;
    if (s.required_certification_id && !(L.certs.get(i.id) || []).some((c) => c.id === Number(s.required_certification_id) && (!c.until || c.until >= day(s.starts_at)))) continue;
    if ((L.busy.get(i.id) || []).some((b) => b.lesson !== Number(s.id) && overlaps(b, span))) continue;
    if (!available(L, i.id, s)) continue;
    out.push(i.id);
  }
  return out;
}

/**
 * Shares instructors among groups that overlap in time. groups: [{ key, s, e, rank, need, pre: [staff ids], cands: [staff ids] }].
 * Fills g.taken (the pre-assigned plus up to need more) and g.spare (candidates nobody overlapping took).
 */
function share(groups) {
  const takenBy = new Map(); // staff id -> [{ s, e }]
  const isTaken = (id, g) => (takenBy.get(id) || []).some((x) => overlaps(x, g));
  const take = (id, g) => { if (!takenBy.has(id)) takenBy.set(id, []); takenBy.get(id).push({ s: g.s, e: g.e }); };
  for (const g of groups) { g.taken = []; for (const id of g.pre) { if (!isTaken(id, g)) { take(id, g); g.taken.push(id); } } }
  // By rank; lessons of the same rank take one instructor each in turn, so two pools at one time both get some.
  const order = [...groups].sort((a, b) => a.rank - b.rank || a.s.localeCompare(b.s) || String(a.key).localeCompare(String(b.key)));
  const pick = (g) => {
    if (g.taken.length >= g.need) return false;
    const others = groups.filter((x) => x !== g && overlaps(x, g));
    const versatility = (id) => others.filter((x) => x.cands.includes(id)).length;
    const id = g.cands.filter((x) => !isTaken(x, g)).sort((a, b) => versatility(a) - versatility(b) || a - b)[0];
    if (id === undefined) return false;
    take(id, g); g.taken.push(id);
    return true;
  };
  for (let i = 0; i < order.length;) {
    let j = i; while (j < order.length && order[j].rank === order[i].rank) j += 1;
    const tier = order.slice(i, j);
    for (let more = true; more;) { more = false; for (const g of tier) if (pick(g)) more = true; }
    i = j;
  }
  for (const g of groups) g.spare = g.cands.filter((id) => !isTaken(id, g));
  return groups;
}

/**
 * What every staff-following lesson on these dates should hold now. Returns { L, lessons: Map(id -> info), advance: Map(date -> bool) }
 * where info = { id, spots, instructors, ratio, cap, advance, booked, held, capacity (now), cands }.
 */
async function plan(db, tenantId, dates) {
  const L = await load(db, tenantId, dates);
  const c = await counts(db, tenantId, L.lessons.map((s) => s.id));
  const out = new Map(); const advance = new Map();
  for (const date of L.dates) {
    const adv = !anyAvailability(L, date);
    advance.set(date, adv);
    const todays = L.lessons.filter((s) => day(s.starts_at) === date);
    const groups = [];
    for (const s of todays) {
      const k = c.get(Number(s.id)); const ratio = ratioOf(L.set, s);
      const g = { key: s.id, s: String(s.starts_at), e: String(s.ends_at), pre: s.instructor_id ? [Number(s.instructor_id)] : [], cands: [], need: 0, rank: 0, lesson: s };
      if (s.spots_mode === 'staff') {
        g.cands = candidates(L, s); g.need = Math.ceil(capOf(s) / ratio); g.rank = rankOf(s);
      } else if (!s.instructor_id && k.booked > 0) {
        g.cands = candidates(L, s); g.need = s.format === 'group' ? Math.ceil(k.booked / ratio) : 1; g.rank = -1; // sold already: theirs first
      } else continue;
      groups.push(g);
    }
    share(groups);
    for (const g of groups) {
      const s = g.lesson;
      if (s.spots_mode !== 'staff') continue;
      const k = c.get(Number(s.id)); const ratio = ratioOf(L.set, s); const cap = capOf(s);
      const instructors = g.taken.length;
      const floor = k.booked + k.held;
      const spots = adv ? Math.max(floor, cap) : Math.max(floor, Math.min(cap, instructors * ratio));
      out.set(Number(s.id), { id: Number(s.id), starts_at: s.starts_at, spots, instructors, ratio, cap, advance: adv, booked: k.booked, held: k.held, capacity: Number(s.capacity), free: g.cands.length });
    }
  }
  return { L, lessons: out, advance, counts: c };
}

/** Dates to look at for a scope: { sessionIds } (the days those lessons are on) or { from, to } (inclusive). */
async function datesOf(db, tenantId, scope) {
  if (scope.sessionIds) {
    const ids = [...new Set(scope.sessionIds.map(Number).filter((x) => x > 0))];
    if (!ids.length) return [];
    return [...new Set((await rows(db, "SELECT DISTINCT DATE(starts_at) AS d FROM lesson_sessions WHERE tenant_id = ? AND id IN (?)", [tenantId, ids])).map((r) => day(r.d)))];
  }
  if (scope.dates) return [...new Set(scope.dates)];
  if (!scope.from) return [];
  const to = scope.to || scope.from;
  const have = new Set((await rows(db, "SELECT DISTINCT DATE(starts_at) AS d FROM lesson_sessions WHERE tenant_id = ? AND spots_mode = 'staff' AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?",
    [tenantId, `${scope.from} 00:00:00`, `${addDays(to, 1)} 00:00:00`])).map((r) => day(r.d)));
  return [...have].sort();
}

/**
 * sync(conn, tenantId, { sessionIds } | { from, to } | { dates }, { req }) -> { checked, changed }.
 * conn: the pool, or a transaction connection (a plan publish): then rows are locked and written in that transaction.
 * With the pool, each changed lesson is written in its own short transaction, locked first, and booked plus held counted
 * again under the lock, so a booking that lands at the same moment is never squeezed out.
 */
async function sync(conn, tenantId, scope = {}, { req = null } = {}) {
  const db = conn || pool;
  const asked = await datesOf(db, tenantId, scope);
  if (!asked.length) return { checked: 0, changed: 0 };
  const sorted = [...asked].sort();
  const withStaff = new Set((await rows(db, "SELECT DISTINCT DATE(starts_at) AS d FROM lesson_sessions WHERE tenant_id = ? AND spots_mode = 'staff' AND status = 'scheduled' AND starts_at >= ? AND starts_at < ?",
    [tenantId, `${sorted[0]} 00:00:00`, `${addDays(sorted[sorted.length - 1], 1)} 00:00:00`])).map((r) => day(r.d)));
  const dates = sorted.filter((d) => withStaff.has(d));
  if (!dates.length) return { checked: 0, changed: 0 };
  const { L, lessons } = await plan(db, tenantId, dates);
  const todo = [...lessons.values()].filter((x) => String(x.starts_at) > L.now).sort((a, b) => a.id - b.id);
  let changed = 0; let up = 0; let down = 0;
  const write = async (c, x) => {
    const s = await one(c, "SELECT id, capacity, status, spots_mode FROM lesson_sessions WHERE tenant_id = ? AND id = ? FOR UPDATE", [tenantId, x.id]);
    if (!s || s.status !== 'scheduled' || s.spots_mode !== 'staff') return;
    const left = await spotsLeft(c, tenantId, { id: s.id, capacity: s.capacity });
    const floor = left.booked + left.offers + left.requests;
    const next = Math.max(floor, x.advance ? x.cap : Math.min(x.cap, x.instructors * x.ratio));
    if (next === Number(s.capacity)) return;
    await c.query('UPDATE lesson_sessions SET capacity = ? WHERE tenant_id = ? AND id = ?', [next, tenantId, s.id]);
    changed += 1; if (next > Number(s.capacity)) up += 1; else down += 1;
  };
  for (const x of todo) {
    if (x.spots === x.capacity) continue;
    if (isTx(db)) await write(db, x); else await tx((c) => write(c, x));
  }
  if (changed) {
    const who = req && req.auth ? req : { auth: { tenantId, userId: null } };
    await audit(db, who, 'spots_sync', 'lesson_sessions', null, { from: dates[0], to: dates[dates.length - 1], checked: todo.length, changed, up, down });
  }
  return { checked: todo.length, changed };
}

/**
 * sync() after a change has committed, from a route: never fails the request (a recount that fails is logged and the
 * lessons job tries again within 5 minutes). Use it for one-line hooks: await LS.after(tenantId, { sessionIds: [id] }, req).
 */
async function after(tenantId, scope, req = null) {
  try { return await sync(pool, tenantId, scope, { req }); } catch (err) {
    console.error(JSON.stringify({ severity: 'ERROR', part: 'lessonspots', tenant: tenantId, message: err.message }));
    return { checked: 0, changed: 0, error: err.message };
  }
}

/** after() for the next 21 days: a change that is not tied to one day (a weekly availability pattern). */
async function afterAhead(tenantId, req = null) {
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = nowIn(t.timezone).slice(0, 10);
  return after(tenantId, { from: today, to: addDays(today, 21) }, req);
}

/** What a staff-following lesson's capacity would be now, with the reason: { spots, instructors, ratio, cap, advance, booked, held, free }. */
async function staffSpots(db, tenantId, session) {
  if (!session || session.spots_mode !== 'staff') return { spots: Number(session && session.capacity) || 0, instructors: null, ratio: null, cap: session ? session.spots_cap ?? null : null, advance: false };
  const { lessons } = await plan(db || pool, tenantId, [day(session.starts_at)]);
  const x = lessons.get(Number(session.id));
  if (!x) return { spots: Number(session.capacity) || 0, instructors: null, ratio: null, cap: session.spots_cap ?? null, advance: false };
  return { spots: x.spots, instructors: x.instructors, ratio: x.ratio, cap: x.cap, advance: x.advance, booked: x.booked, held: x.held, free: x.free };
}

/** "6 instructors free x 5 = 30 spots, cap 40" for a lesson's reason. */
function reasonWords(r) {
  if (!r || r.instructors == null) return null;
  if (r.advance) return `No instructor availability in yet for this day, so it sells up to the cap of ${r.cap}`;
  const base = `${r.instructors} instructor${r.instructors === 1 ? '' : 's'} free x ${r.ratio} = ${r.instructors * r.ratio} spots, cap ${r.cap}`;
  if (r.spots > Math.min(r.cap, r.instructors * r.ratio)) return `${base}. Kept at ${r.spots} because ${r.booked + r.held} are booked or held`;
  return base;
}

module.exports = { sync, after, afterAhead, staffSpots, plan, load, candidates, share, counts, reasonWords, anyAvailability, kidsOf, ratioOf, capOf, rankOf };
