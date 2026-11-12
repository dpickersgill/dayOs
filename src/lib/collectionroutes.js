'use strict';

// Collection routes (the `collectionroutes` add-on) and hauler oversight (the `hauler` add-on), release 2026.11.22,
// workstream "routes". Routes in src/routes/collectionroutes.js; tables in db/steps/trash-routes.js.
//
// THE DRIVER'S ROUTE. Each collection day, every zone and stream collected that day (lib/collection.js dayRoutes, after
// holiday shifts and changes) is one route: "Monday north, Trash". Its stops are the zone's streets (whole, or a block by
// house numbers and side) in the borough's street order (bulk pickup's driving order for that weekday), then any go-backs
// due that day, then that day's bulk pickup stops in its zone (marked through bulk pickup's own outcome, as before). A
// route is kept in the database from the day it runs (today or earlier); a later day is shown as a preview.
// The crew taps each stop Done, or Skipped with a reason (blocked, parked cars, contaminated, not out, other); Skipped
// needs a photo, kept exactly as taken with its SHA-256 (as bulk pickup's). Every tap carries an id from the phone
// (client_ref), so a tap sent again after a lost answer, or replayed from the phone's offline queue, is kept once.
//
// WHO SEES WHICH ROUTE (the rule chosen for this release): owners and managers see and change every route; the front desk
// reads them (to answer "has the truck been?") but marks nothing; a Crew login sees the routes it is on, and today's
// routes nobody is on yet (so the crew can pick theirs up: starting a route puts them on it). A Crew login on no route of
// a day sees no other crew's route.
//
// THE TRUCK comes from Assets and fleet (collection_trucks lists which trucks collect and which also plow; with none
// listed, every truck in the register is offered). Starting a route takes the truck, the odometer (it only goes up, as
// the register's meter does) and the pre-trip check done today on that truck (Assets and fleet's own checklist), or a
// note that it was skipped. An out-of-service truck cannot start a route.
//
// COSTS (the 2026.11.20 cost rules, lib/workcosts.js). A truck's day is costed as a work order per job: "collection" is
// on the Sanitation department and fund, "plowing" on Streets and the Liquid Fuels fund (when the municipality has one),
// so the monthly report's Sanitation line and the Liquid Fuels report pick them up with no change of their own. Finishing
// a route adds each crew member's hours (at their own labor rate), the truck's hours (at its hourly rate), and the
// tipping fee of each landfill or recycling ticket entered (a materials line); the ticket itself goes to the tonnage
// records through lib/tonnage.js addTicket.
//
// SNOW. A manager declares a snow day for a date (and zones): collection_changes rows (reason 'snow') move that day by
// the holiday rule ('shift': to the next day, and on a whole-borough snow day the later days of that Monday-Saturday week
// move one day too; 'skip': that day is canceled; 'none': that day only moves to the next day). That day's routes show
// "Delayed for snow", and a street notice to the streets of the zones affected is DRAFTED for the manager to send from
// Street notices. A truck's plow changeover is a short work order on the truck.
//
// HAULER OVERSIGHT. A missed pickup reported where a contracted hauler collects is emailed to the hauler with a link that
// needs no login (32 random bytes, kept only as a SHA-256, good for 30 days, and only for that one request): the address
// and stream, never the resident's name, phone or email. The hauler marks it Collected; the time is measured against the
// contract's service level ("collected within 24 hours"), and the monthly scorecard counts it.
//
// Money (costs, rates, tipping fees, contract price and penalties) only reaches owners and managers: the paths are in
// lib/nomoney.js's list, and these functions leave money out for anyone else as well.
const crypto = require('crypto');
const { pool, rows, one, tx } = require('../db');
const { addDays, weekdayOf, todayIn, nowIn } = require('./util');
const { bad, conflict, forbidden, notFound } = require('./errors');
const { audit } = require('./audit');

const C = require('./collection');
/** tonnage's addTicket(conn, tenantId, ticket, { by }) when it is there; a stand-in that keeps nothing when it is not. */
function addTicketFn() {
  try { const T = require('./tonnage'); if (typeof T.addTicket === 'function') return T.addTicket; } catch (err) { if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).startsWith("Cannot find module './tonnage'")) throw err; }
  return async () => null; // phase 1: the ticket stays on the route (collection_route_tickets) until tonnage is merged
}

const REASONS = { blocked: 'Blocked', parked_cars: 'Parked cars', contaminated: 'Contaminated', not_out: 'Not out', other: 'Other' };
const MANAGERS = ['owner', 'manager'];
const isMgr = (req) => MANAGERS.includes(req.auth.role);
const n = (v) => Number(v || 0);
const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const dt = (d) => (d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : d ? String(d).slice(0, 19) : null);
const tzOf = async (conn, t) => (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;
const houseNo = (s) => { const m = /^\s*(\d{1,7})/.exec(String(s || '')); return m ? Number(m[1]) : null; };
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "Thursday, November 19". */
const dayWords = (d) => `${DAY[weekdayOf(d)]}, ${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const hoursBetween = (a, b) => (a && b ? Math.max(0, (Date.parse(`${dt(b).replace(' ', 'T')}Z`) - Date.parse(`${dt(a).replace(' ', 'T')}Z`)) / 3_600_000) : 0);
const quarter = (h) => Math.round(h * 4) / 4;
const zoneIdsOf = (v) => { if (!v) return []; try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } };

/** "Main Street", or "Main Street 101 to 199, odd side". */
function stopWords(s) {
  const from = s.from_no ?? s.fromNo; const to = s.to_no ?? s.toNo; const side = s.side || 'both';
  const range = from !== null && from !== undefined && to !== null && to !== undefined ? ` ${from} to ${to}` : from !== null && from !== undefined ? ` from ${from}` : to !== null && to !== undefined ? ` up to ${to}` : '';
  return `${s.street}${range}${side !== 'both' ? `${range ? ',' : ''} ${side} side` : ''}`;
}
/** Does a stop (a street, or a block of it) take in this house number? */
function covers(s, no) {
  const x = houseNo(no);
  const from = s.from_no === null || s.from_no === undefined ? null : Number(s.from_no);
  const to = s.to_no === null || s.to_no === undefined ? null : Number(s.to_no);
  if (x === null) return from === null && to === null;
  if (from !== null && x < from) return false;
  if (to !== null && x > to) return false;
  if (s.side === 'odd' && x % 2 === 0) return false;
  if (s.side === 'even' && x % 2 === 1) return false;
  return true;
}

// ---------------------------------------------------------------- building a day's routes
/**
 * Keeps the routes of a day in the database (a day that has come: today or earlier): one per zone and stream collected
 * that day, its streets in order, the go-backs due, and marks a route that a change moved off this day Delayed.
 * Safe to call at the same time from two phones: each route's stops are written once, under its row lock.
 */
async function ensureRoutes(t, date) {
  const plan = await C.dayRoutes(pool, t, date);
  await tx(async (conn) => {
    for (const [i, p] of plan.entries()) {
      await conn.query('INSERT IGNORE INTO collection_routes (tenant_id, on_date, zone_id, stream_id, name, sort) VALUES (?, ?, ?, ?, ?, ?)', [t, date, p.zoneId, p.streamId, `${p.zoneName}, ${p.streamName}`.slice(0, 140), i + 1]);
      const r = await one(conn, 'SELECT id, status FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND zone_id = ? AND stream_id = ? FOR UPDATE', [t, date, p.zoneId, p.streamId]);
      if (r.status === 'delayed') await conn.query("UPDATE collection_routes SET status = IF(started_at IS NULL, 'planned', 'started'), delayed_reason = NULL, moved_to = NULL WHERE tenant_id = ? AND id = ?", [t, r.id]); // the change was undone
      if (n((await one(conn, "SELECT COUNT(*) AS c FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND kind = 'street'", [t, r.id])).c)) continue;
      for (const [k, s] of p.streets.entries()) {
        await conn.query('INSERT INTO collection_route_stops (tenant_id, route_id, position, kind, street_id, from_no, to_no, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, r.id, (k + 1) * 10, 'street', s.streetId, s.fromNo ?? null, s.toNo ?? null, s.side || 'both']);
      }
    }
    // A route kept for this day that is no longer collected on it (a snow day moved it): Delayed, with where it went.
    const kept = await rows(conn, "SELECT id, zone_id, stream_id FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND status IN ('planned','started') FOR UPDATE", [t, date]);
    const live = new Set(plan.map((p) => `${p.zoneId}|${p.streamId}`));
    for (const r of kept) {
      if (live.has(`${r.zone_id}|${r.stream_id}`)) continue;
      const ch = (await rows(conn, 'SELECT moved_to, zone_ids, reason FROM collection_changes WHERE tenant_id = ? AND on_date = ? ORDER BY id DESC', [t, date]))
        .find((c) => { const z = zoneIdsOf(c.zone_ids); return !z.length || z.includes(Number(r.zone_id)); });
      await conn.query("UPDATE collection_routes SET status = 'delayed', delayed_reason = ?, moved_to = ? WHERE tenant_id = ? AND id = ?", [ch ? ch.reason : 'other', ch && ch.moved_to ? ymd(ch.moved_to) : null, t, r.id]);
    }
    await placeGobacks(conn, t, date);
  });
}

/** Go-backs due on a day go on the end of a route of that day: the one for their zone and stream, else their stream, else any. */
async function placeGobacks(conn, t, date) {
  const waiting = await rows(conn, `SELECT g.id, g.street_id, g.house_number, g.stream_id FROM collection_gobacks g
    WHERE g.tenant_id = ? AND g.status = 'waiting' AND g.due_on = ? AND (g.route_id IS NULL OR NOT EXISTS (SELECT 1 FROM collection_route_stops s WHERE s.tenant_id = g.tenant_id AND s.goback_id = g.id)) FOR UPDATE`, [t, date]);
  if (!waiting.length) return;
  const routes = await rows(conn, "SELECT id, zone_id, stream_id FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND status <> 'delayed' ORDER BY sort, id", [t, date]);
  if (!routes.length) return; // nothing collected that day: it waits on the list of go-backs with no route
  for (const g of waiting) {
    const z = await C.zoneFor(conn, t, { streetId: Number(g.street_id), houseNo: g.house_number });
    const zoneId = z && z.zoneId ? z.zoneId : null;
    const r = routes.find((x) => Number(x.zone_id) === zoneId && (!g.stream_id || Number(x.stream_id) === Number(g.stream_id)))
      || routes.find((x) => g.stream_id && Number(x.stream_id) === Number(g.stream_id)) || routes[0];
    const last = await one(conn, 'SELECT COALESCE(MAX(position), 0) AS p FROM collection_route_stops WHERE tenant_id = ? AND route_id = ?', [t, r.id]);
    const no = houseNo(g.house_number);
    await conn.query("INSERT INTO collection_route_stops (tenant_id, route_id, position, kind, street_id, from_no, to_no, side, goback_id) VALUES (?, ?, ?, 'goback', ?, ?, ?, 'both', ?)", [t, r.id, n(last.p) + 10, g.street_id, no, no, g.id]);
    await conn.query('UPDATE collection_gobacks SET route_id = ? WHERE tenant_id = ? AND id = ?', [r.id, t, g.id]);
  }
}

// ---------------------------------------------------------------- who sees what
async function crewOf(db, t, routeIds) {
  if (!routeIds.length) return [];
  return rows(db, `SELECT c.route_id, c.user_id, c.staff_id, c.hours, COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, sp.first_name, ''), ' ', COALESCE(p.last_name, sp.last_name, ''))), ''), u.username) AS name
    FROM collection_route_crew c JOIN users u ON u.tenant_id = c.tenant_id AND u.id = c.user_id
    LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id LEFT JOIN staff s ON s.tenant_id = u.tenant_id AND s.id = u.staff_id LEFT JOIN people sp ON sp.tenant_id = s.tenant_id AND sp.id = s.person_id
    WHERE c.tenant_id = ? AND c.route_id IN (?) ORDER BY c.id`, [t, routeIds]);
}
/** May this person see the route? (the rule above) */
function maySee(req, route, crew, today) {
  if (isMgr(req) || req.auth.role === 'counter') return true;
  if (req.auth.role !== 'staff') return false;
  const mine = crew.filter((c) => Number(c.route_id) === Number(route.id));
  return mine.some((c) => Number(c.user_id) === Number(req.auth.userId)) || (!mine.length && ymd(route.on_date) === today);
}
/** May this person mark stops, start or finish the route? Managers, and Crew on it (or joining a route nobody is on). */
function mayWork(req, route, crew, today) {
  if (isMgr(req)) return true;
  if (req.auth.role !== 'staff') return false;
  return maySee(req, route, crew, today);
}

// ---------------------------------------------------------------- reading routes
const ROUTE_SQL = `SELECT r.*, z.name AS zone_name, st.name AS stream_name, st.kind AS stream_kind, st.color AS stream_color, a.name AS truck, a.asset_tag AS truck_tag
  FROM collection_routes r JOIN collection_zones z ON z.tenant_id = r.tenant_id AND z.id = r.zone_id JOIN collection_streams st ON st.tenant_id = r.tenant_id AND st.id = r.stream_id
  LEFT JOIN ops_assets a ON a.tenant_id = r.tenant_id AND a.id = r.asset_id`;
const STOP_SQL = `SELECT s.*, st.name AS street, g.house_number AS goback_house, g.note AS goback_note, g.request_id
  FROM collection_route_stops s JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id LEFT JOIN collection_gobacks g ON g.tenant_id = s.tenant_id AND g.id = s.goback_id`;

function stopShape(s) {
  return {
    id: Number(s.id), kind: s.kind, position: Number(s.position), street_id: Number(s.street_id), street: s.street,
    words: s.kind === 'goback' ? `${s.goback_house ? `${s.goback_house} ` : ''}${s.street}` : stopWords(s),
    from_no: s.from_no === null ? null : Number(s.from_no), to_no: s.to_no === null ? null : Number(s.to_no), side: s.side,
    status: s.status, reason: s.reason, reason_words: s.reason ? REASONS[s.reason] : null, note: s.note, photo_id: s.photo_id ? Number(s.photo_id) : null,
    marked_at: dt(s.marked_at), lat: s.marked_lat === null ? null : Number(s.marked_lat), lng: s.marked_lng === null ? null : Number(s.marked_lng),
    ...(s.kind === 'goback' ? { goback_id: Number(s.goback_id), goback_note: s.goback_note, request_id: s.request_id ? Number(s.request_id) : null } : {}),
  };
}
function progressOf(stops) {
  const done = stops.filter((s) => s.status === 'done').length; const skipped = stops.filter((s) => s.status === 'skipped').length;
  const total = stops.length;
  return { total, done, skipped, left: total - done - skipped, percent: total ? Math.round(((done + skipped) / total) * 100) : 0 };
}
function routeShape(r, stops, crew) {
  return {
    id: Number(r.id), date: ymd(r.on_date), name: r.name, zone_id: Number(r.zone_id), zone: r.zone_name, stream_id: Number(r.stream_id), stream: r.stream_name, kind: r.stream_kind, color: r.stream_color,
    status: r.status, delayed_reason: r.delayed_reason, moved_to: ymd(r.moved_to),
    status_words: r.status === 'delayed' ? `Delayed for ${r.delayed_reason === 'snow' ? 'snow' : r.delayed_reason === 'holiday' ? 'a holiday' : 'weather'}${r.moved_to ? `: now ${dayWords(ymd(r.moved_to))}` : ''}` : { planned: 'Not started', started: 'On the road', done: 'Finished' }[r.status],
    truck_id: r.asset_id ? Number(r.asset_id) : null, truck: r.truck || null, started_at: dt(r.started_at), finished_at: dt(r.finished_at),
    odometer_start: r.odometer_start === null ? null : Number(r.odometer_start), odometer_end: r.odometer_end === null ? null : Number(r.odometer_end),
    pretrip: r.pretrip_inspection_id ? 'done' : Number(r.pretrip_skipped) ? 'skipped' : null, truck_hours: r.truck_hours === null ? null : Number(r.truck_hours),
    last: r.last_lat !== null ? { lat: Number(r.last_lat), lng: Number(r.last_lng), at: dt(r.last_seen_at) } : null,
    crew: crew.filter((c) => Number(c.route_id) === Number(r.id)).map((c) => ({ user_id: Number(c.user_id), name: String(c.name || '').trim(), hours: c.hours === null ? null : Number(c.hours) })),
    progress: progressOf(stops),
  };
}

/**
 * A day's routes for this person: { date, today, kept (true: in the database; false: a preview of a later day), routes,
 * moved: [what a change took off this day], moved_in: [what a change brought to it], gobacks_unplaced }.
 */
async function dayView(req, date) {
  const t = req.auth.tenantId;
  const tz = await tzOf(pool, t); const today = todayIn(tz);
  const out = { date, today, kept: date <= today, routes: [], moved: [], moved_in: [], can_manage: isMgr(req) };
  const changes = await rows(pool, `SELECT c.on_date, c.moved_to, c.zone_ids, c.reason, c.note FROM collection_changes c WHERE c.tenant_id = ? AND (c.on_date = ? OR c.moved_to = ?) ORDER BY c.id`, [t, date, date]);
  const zones = new Map((await rows(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ?', [t])).map((z) => [Number(z.id), z.name]));
  const zoneWords = (ids) => (ids.length ? ids.map((i) => zones.get(i) || 'A zone').join(', ') : 'Every zone');
  for (const c of changes) {
    const w = { zones: zoneWords(zoneIdsOf(c.zone_ids)), reason: c.reason, note: c.note, from: ymd(c.on_date), to: ymd(c.moved_to) };
    if (ymd(c.on_date) === date) out.moved.push(w); else out.moved_in.push(w);
  }
  if (!out.kept) {
    // A later day: what the schedule says, nothing kept or marked yet.
    out.routes = (await C.dayRoutes(pool, t, date)).map((p) => ({ id: null, date, name: `${p.zoneName}, ${p.streamName}`, zone_id: p.zoneId, zone: p.zoneName, stream_id: p.streamId, stream: p.streamName, kind: p.kind, status: 'planned', status_words: 'Planned', crew: [], progress: progressOf(p.streets.map(() => ({ status: 'todo' }))) }));
    return out;
  }
  await ensureRoutes(t, date);
  const list = await rows(pool, `${ROUTE_SQL} WHERE r.tenant_id = ? AND r.on_date = ? ORDER BY r.status = 'delayed', r.sort, r.id`, [t, date]);
  const crew = await crewOf(pool, t, list.map((r) => Number(r.id)));
  const seen = list.filter((r) => maySee(req, r, crew, today));
  const stops = seen.length ? await rows(pool, 'SELECT route_id, status FROM collection_route_stops WHERE tenant_id = ? AND route_id IN (?)', [t, seen.map((r) => r.id)]) : [];
  out.routes = seen.map((r) => routeShape(r, stops.filter((s) => Number(s.route_id) === Number(r.id)), crew));
  if (isMgr(req)) out.gobacks_unplaced = n((await one(pool, "SELECT COUNT(*) AS c FROM collection_gobacks WHERE tenant_id = ? AND status = 'waiting' AND due_on <= ? AND route_id IS NULL", [t, date])).c);
  return out;
}

async function routeRow(db, t, id, { lock = false } = {}) {
  const r = await one(db, `${ROUTE_SQL} WHERE r.tenant_id = ? AND r.id = ?${lock ? ' FOR UPDATE' : ''}`, [t, id]);
  if (!r) throw notFound('Route');
  return r;
}
/** The route with its stops, crew, truck and pre-trip, for someone allowed to see it (else 404, as if it were not there). */
async function routeView(req, id) {
  const t = req.auth.tenantId;
  const tz = await tzOf(pool, t); const today = todayIn(tz);
  const r = await routeRow(pool, t, id);
  const crew = await crewOf(pool, t, [Number(r.id)]);
  if (!maySee(req, r, crew, today)) throw notFound('Route');
  const date = ymd(r.on_date);
  const stops = (await rows(pool, `${STOP_SQL} WHERE s.tenant_id = ? AND s.route_id = ? ORDER BY s.position, s.id`, [t, r.id])).map(stopShape);
  const out = { ...routeShape(r, stops, crew), today, stops, can_work: mayWork(req, r, crew, today) && date === today && r.status !== 'delayed' && r.status !== 'done', can_manage: isMgr(req), reasons: Object.entries(REASONS).map(([key, words]) => ({ key, words })) };
  out.bulk = r.stream_kind === 'trash' ? await bulkStopsFor(t, r, date) : [];
  out.carts = await cartStopsOn(t, r, date);
  out.pretrip_check = r.asset_id ? await pretripOf(pool, t, Number(r.asset_id), date) : null;
  out.trucks = out.can_work || isMgr(req) ? await trucks(t, date) : [];
  return out;
}

/** That day's bulk pickup stops in this route's zone (or with no zone, on the day's first trash route). Never a resident's contact. */
async function bulkStopsFor(t, r, date) {
  const list = await rows(pool, `SELECT b.id, b.reference, b.street_id, b.house_number, b.unit, b.items_note, b.outcome, b.outcome_reason, b.outcome_at, s.name AS street
    FROM bulk_bookings b JOIN streets s ON s.tenant_id = b.tenant_id AND s.id = b.street_id WHERE b.tenant_id = ? AND b.collection_date = ? AND b.status = 'booked'`, [t, date]);
  if (!list.length) return [];
  const first = await one(pool, "SELECT r.id FROM collection_routes r JOIN collection_streams st ON st.tenant_id = r.tenant_id AND st.id = r.stream_id WHERE r.tenant_id = ? AND r.on_date = ? AND st.kind = 'trash' ORDER BY r.sort, r.id LIMIT 1", [t, date]);
  const items = await require('./bulkpickup').itemsOf(pool, t, list.map((b) => b.id));
  const out = [];
  for (const b of list) {
    const z = await C.zoneFor(pool, t, { streetId: Number(b.street_id), houseNo: b.house_number });
    const mine = z && z.zoneId ? z.zoneId === Number(r.zone_id) : first && Number(first.id) === Number(r.id);
    if (!mine) continue;
    out.push({ id: Number(b.id), street: b.street, unit: b.unit, booking_id: Number(b.id), reference: b.reference, words: `${b.house_number}${b.unit ? ` ${b.unit}` : ''} ${b.street}`, street_id: Number(b.street_id), house_number: b.house_number,
      items: require('./bulkpickup').itemsText(items.filter((i) => Number(i.booking_id) === Number(b.id))), items_note: b.items_note, outcome: b.outcome, outcome_reason: b.outcome_reason, outcome_at: dt(b.outcome_at) });
  }
  const order = await require('./bulkroute').order(pool, t, weekdayOf(date), out);
  return order.stops.map(({ id, street, unit, ...x }) => x);
}

/**
 * That day's cart deliveries (workstream tonnage's lib/carts.js cartStopsFor, when it is there) in this route's zone, or
 * with no zone on the day's first route. Shown on the route; delivered and marked in Carts. Never a resident's contact.
 */
async function cartStopsOn(t, r, date) {
  let CT;
  try { CT = require('./carts'); } catch (err) { if (err.code === 'MODULE_NOT_FOUND' && String(err.message).startsWith("Cannot find module './carts'")) return []; throw err; }
  if (typeof CT.cartStopsFor !== 'function') return [];
  let list;
  try { list = (await CT.cartStopsFor(pool, t, date)) || []; } catch (_) { return []; }
  if (!list.length) return [];
  const first = await one(pool, 'SELECT id FROM collection_routes WHERE tenant_id = ? AND on_date = ? ORDER BY sort, id LIMIT 1', [t, date]);
  const out = [];
  for (const c of list) {
    const streetId = Number(c.street_id || 0); const no = c.house_number || null;
    const houseNo = no != null && /^\d+/.test(String(no)) ? parseInt(String(no), 10) : null; // "120A" is house 120 for zones
    const z = streetId ? await C.zoneFor(pool, t, { streetId, houseNo }) : null;
    const mine = z && z.zoneId ? z.zoneId === Number(r.zone_id) : first && Number(first.id) === Number(r.id);
    if (!mine) continue;
    out.push({ id: c.id ? Number(c.id) : null, words: c.address || c.words || `${no ? `${no} ` : ''}${c.street || ''}`.trim(), what: [c.kind_label || c.kind, c.stream, c.size_gal ? `${c.size_gal} gallon` : null].filter(Boolean).join(', '), done: Boolean(c.delivered) }); // the shape tonnage's cartStopsFor returns
  }
  return out;
}

// ---------------------------------------------------------------- trucks and the pre-trip check
/** The trucks to choose from: the ones listed for collection, else every truck in the register, with today's state. */
async function trucks(t, date) {
  const listed = await rows(pool, `SELECT a.id, a.name, a.asset_tag, a.status, a.miles, c.plows, c.setup FROM collection_trucks c JOIN ops_assets a ON a.tenant_id = c.tenant_id AND a.id = c.asset_id
    WHERE c.tenant_id = ? AND c.active = 1 AND a.status <> 'retired' ORDER BY a.name`, [t]);
  const list = listed.length ? listed : await rows(pool, "SELECT a.id, a.name, a.asset_tag, a.status, a.miles, 0 AS plows, 'collection' AS setup FROM ops_assets a WHERE a.tenant_id = ? AND a.kind = 'truck' AND a.status <> 'retired' ORDER BY a.name", [t]);
  const busy = new Map((await rows(pool, "SELECT asset_id, name FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND asset_id IS NOT NULL AND status IN ('started','planned')", [t, date])).map((x) => [Number(x.asset_id), x.name]));
  return list.map((a) => ({ id: Number(a.id), name: a.name, tag: a.asset_tag, status: a.status, out_of_service: a.status === 'out_of_service', miles: a.miles === null ? null : Number(a.miles), plows: Boolean(Number(a.plows)), setup: a.setup, on_route: busy.get(Number(a.id)) || null, listed: listed.length > 0 }));
}
/** The pre-trip checklist for a truck (Assets and fleet's own) and whether it was done on this day. */
async function pretripOf(db, t, assetId, date) {
  const a = await one(db, 'SELECT kind FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, assetId]);
  const tpls = await rows(db, "SELECT id, name, kinds FROM inspection_templates WHERE tenant_id = ? AND active = 1 AND name LIKE '%pre-trip%' ORDER BY id", [t]);
  const tpl = tpls.find((x) => !x.kinds || String(x.kinds).split(',').map((k) => k.trim()).includes(a ? a.kind : 'truck')) || tpls[0] || null;
  const done = await one(db, "SELECT id, result, done_at FROM asset_inspections WHERE tenant_id = ? AND asset_id = ? AND template_name LIKE '%pre-trip%' AND done_at BETWEEN ? AND ? ORDER BY done_at DESC LIMIT 1", [t, assetId, `${date} 00:00:00`, `${date} 23:59:59`]);
  return { template_id: tpl ? Number(tpl.id) : null, template_name: tpl ? tpl.name : null, done: done ? { id: Number(done.id), result: done.result, at: dt(done.done_at) } : null };
}
/** An odometer reading on the truck's register (it only goes up, as Assets and fleet's meter does). */
async function readOdometer(conn, req, assetId, miles, at) {
  const a = await one(conn, 'SELECT miles FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, assetId]);
  if (!a) throw notFound('Truck');
  if (a.miles !== null && Number(miles) < Number(a.miles)) throw bad(`The odometer reads ${Number(a.miles).toLocaleString('en-US')} miles on the register already. Check the number: it only goes up.`);
  await conn.query('UPDATE ops_assets SET miles = ? WHERE tenant_id = ? AND id = ?', [miles, req.auth.tenantId, assetId]);
  await conn.query("INSERT INTO asset_meters (tenant_id, asset_id, meter, value, read_at, source, user_id) VALUES (?, ?, 'miles', ?, ?, 'manual', ?)", [req.auth.tenantId, assetId, miles, at, req.auth.userId]);
}

// ---------------------------------------------------------------- the crew's day
async function workable(conn, req, id) {
  const t = req.auth.tenantId;
  const tz = await tzOf(conn, t); const today = todayIn(tz);
  const r = await routeRow(conn, t, id, { lock: true });
  const crew = await crewOf(conn, t, [Number(r.id)]);
  if (!maySee(req, r, crew, today)) throw notFound('Route');
  if (!mayWork(req, r, crew, today)) throw forbidden('Only the crew on this route, or a manager, can do that');
  return { t, tz, today, r, crew, now: nowIn(tz) };
}
/** Puts the signed-in Crew login on the route (starting a route nobody is on). */
async function joinCrew(conn, req, r, crew) {
  if (req.auth.role !== 'staff' || crew.some((c) => Number(c.user_id) === Number(req.auth.userId))) return;
  await conn.query('INSERT IGNORE INTO collection_route_crew (tenant_id, route_id, user_id, staff_id, added_by) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, r.id, req.auth.userId, req.auth.staffId || null, req.auth.userId]);
}

/** Start the route: the truck, the odometer, the pre-trip check (done today, or skipped with the crew saying so). */
async function start(req, id, b) {
  return tx(async (conn) => {
    const { t, today, r, crew, now } = await workable(conn, req, id);
    if (ymd(r.on_date) !== today) throw conflict('A route is started on its own day');
    if (r.status === 'delayed') throw conflict(`This route is delayed${r.moved_to ? ` to ${dayWords(ymd(r.moved_to))}` : ''}. It runs on that day's list.`);
    if (r.status === 'done') throw conflict('This route is finished');
    const a = await one(conn, 'SELECT id, name, status FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, b.truck_id]);
    if (!a) throw notFound('Truck');
    if (a.status === 'out_of_service') throw conflict(`${a.name} is out of service. Pick another truck, or ask the shop.`);
    const busy = await one(conn, "SELECT name FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND asset_id = ? AND status = 'started' AND id <> ?", [t, today, a.id, r.id]);
    if (busy) throw conflict(`${a.name} is out on ${busy.name}. Finish that route first, or pick another truck.`);
    const check = await pretripOf(conn, t, Number(a.id), today);
    let inspection = null;
    if (b.pretrip_inspection_id) {
      const i = await one(conn, 'SELECT id, result, done_at FROM asset_inspections WHERE tenant_id = ? AND asset_id = ? AND id = ?', [t, a.id, b.pretrip_inspection_id]);
      if (!i || ymd(i.done_at) !== today) throw bad('That pre-trip check is not from this truck today');
      if (i.result === 'fail') throw conflict('The pre-trip check failed. The truck needs the shop before it goes out; pick another truck.');
      inspection = Number(i.id);
    } else if (check.done) {
      if (check.done.result === 'fail') throw conflict('Today\'s pre-trip check on this truck failed. Pick another truck, or ask the shop.');
      inspection = check.done.id;
    } else if (!b.pretrip_skipped) throw bad('Do the pre-trip check on this truck first, or say it was skipped', { code: 'pretrip_needed', template_id: check.template_id });
    if (b.odometer !== undefined && b.odometer !== null) await readOdometer(conn, req, a.id, b.odometer, now);
    await conn.query(`UPDATE collection_routes SET status = 'started', asset_id = ?, started_at = COALESCE(started_at, ?), started_by = COALESCE(started_by, ?), odometer_start = COALESCE(?, odometer_start),
      pretrip_inspection_id = ?, pretrip_skipped = ?, last_lat = COALESCE(?, last_lat), last_lng = COALESCE(?, last_lng), last_seen_at = ? WHERE tenant_id = ? AND id = ?`,
    [a.id, now, req.auth.userId, b.odometer ?? null, inspection, inspection ? 0 : 1, b.lat ?? null, b.lng ?? null, now, t, r.id]);
    await joinCrew(conn, req, r, crew);
    await audit(conn, req, 'route_start', 'collection_routes', r.id, { truck_id: a.id, odometer: b.odometer ?? null, pretrip: inspection ? 'done' : 'skipped' });
    return { ok: true };
  });
}

/** Photo of a stop, as taken (the body is the file). Query: stop_id, lat, lng, client_ref. */
async function addPhoto(req, id, buf, q) {
  const { photoFacts, sniff } = require('./exif');
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Take a photo first');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  return tx(async (conn) => {
    const { t, r, now } = await workable(conn, req, id);
    if (q.client_ref) {
      const seen = await one(conn, 'SELECT id, sha256, route_id FROM collection_photos WHERE tenant_id = ? AND client_ref = ?', [t, q.client_ref]);
      if (seen && Number(seen.route_id) === Number(r.id)) return { id: Number(seen.id), sha256: seen.sha256, repeat: true };
      if (seen) throw conflict('That photo was sent for another route');
    }
    if (q.stop_id && !(await one(conn, 'SELECT id FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND id = ?', [t, r.id, q.stop_id]))) throw notFound('Stop');
    const facts = photoFacts(buf);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const [ins] = await conn.query(`INSERT INTO collection_photos (tenant_id, route_id, stop_id, mime, bytes, sha256, original, taken_at, taken_from, taken_lat, taken_lng, client_ref, uploaded_by, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, r.id, q.stop_id || null, mime, buf.length, hash, buf, facts.taken_at || now, facts.taken_at ? 'photo' : 'phone', facts.lat ?? q.lat ?? null, facts.lng ?? q.lng ?? null, q.client_ref || null, req.auth.userId, now]);
    await audit(conn, req, 'route_photo', 'collection_routes', r.id, { photo_id: ins.insertId, sha256: hash, bytes: buf.length });
    return { id: Number(ins.insertId), sha256: hash };
  });
}

/**
 * Done, Skipped (reason and photo required) or back to To do (a correction). Kept once per client_ref: a tap the phone
 * sends again, or replays from its queue, answers the same and changes nothing. A tap from the queue that is older than
 * the stop's last mark is kept in the history but does not undo the newer one.
 */
async function mark(req, id, stopId, b) {
  return tx(async (conn) => {
    const { t, today, r, crew, now } = await workable(conn, req, id);
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT m.stop_id, m.status FROM collection_stop_marks m WHERE m.tenant_id = ? AND m.client_ref = ?', [t, b.client_ref]);
      if (seen) {
        if (Number(seen.stop_id) !== Number(stopId)) throw conflict('That tap was sent for another stop');
        return { ok: true, repeat: true, status: seen.status };
      }
    }
    const s = await one(conn, 'SELECT * FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND id = ? FOR UPDATE', [t, r.id, stopId]);
    if (!s) throw notFound('Stop');
    if (ymd(r.on_date) !== today && !isMgr(req)) throw conflict(`This route was for ${dayWords(ymd(r.on_date))}. A manager can correct it.`);
    if (r.status === 'delayed') throw conflict(`This route is delayed${r.moved_to ? ` to ${dayWords(ymd(r.moved_to))}` : ''}. Nothing is collected on it today.`);
    if (r.status === 'done' && !isMgr(req)) throw conflict('This route is finished. A manager can correct it.');
    let photo = null;
    if (b.status === 'skipped') {
      if (!b.reason) throw bad('Pick why it was skipped');
      if (b.reason === 'other' && !b.note) throw bad('Say why it was skipped');
      if (b.photo_id) photo = await one(conn, 'SELECT id FROM collection_photos WHERE tenant_id = ? AND route_id = ? AND id = ?', [t, r.id, b.photo_id]);
      else if (b.photo_ref) photo = await one(conn, 'SELECT id FROM collection_photos WHERE tenant_id = ? AND route_id = ? AND client_ref = ?', [t, r.id, b.photo_ref]);
      if (!photo) throw bad(b.photo_id || b.photo_ref ? 'That photo is not from this route. Take it again.' : 'Take a photo first: a skipped street needs one');
    }
    const phoneAt = b.at ? String(b.at).replace('T', ' ').slice(0, 19) : null;
    const at = phoneAt && phoneAt < now ? phoneAt : now;
    await conn.query('INSERT INTO collection_stop_marks (tenant_id, stop_id, status, reason, photo_id, phone_at, queued, client_ref, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, s.id, b.status, b.status === 'skipped' ? b.reason : null, photo ? photo.id : null, phoneAt, b.queued ? 1 : 0, b.client_ref || null, req.auth.userId, now]);
    const stale = s.marked_at && dt(s.marked_at) > at && b.queued; // an older tap arriving late
    if (!stale) {
      await conn.query('UPDATE collection_route_stops SET status = ?, reason = ?, note = ?, photo_id = ?, marked_at = ?, marked_by = ?, marked_lat = ?, marked_lng = ? WHERE tenant_id = ? AND id = ?',
        [b.status, b.status === 'skipped' ? b.reason : null, b.status === 'todo' ? null : (b.note || null), photo ? photo.id : null, b.status === 'todo' ? null : at, b.status === 'todo' ? null : req.auth.userId, b.lat ?? null, b.lng ?? null, t, s.id]);
      if (photo) await conn.query('UPDATE collection_photos SET stop_id = ? WHERE tenant_id = ? AND id = ?', [s.id, t, photo.id]);
      if (s.goback_id) {
        if (b.status === 'done') await gobackDone(conn, t, Number(s.goback_id), at, req.auth.userId);
        else await conn.query("UPDATE collection_gobacks SET status = 'waiting', done_at = NULL, done_by = NULL WHERE tenant_id = ? AND id = ? AND status = 'done'", [t, s.goback_id]);
      }
    }
    // The first tap of the day starts the route, with this person on it (a truck is chosen when it is started properly).
    if (r.status === 'planned') await conn.query("UPDATE collection_routes SET status = 'started', started_at = COALESCE(started_at, ?), started_by = COALESCE(started_by, ?) WHERE tenant_id = ? AND id = ?", [at, req.auth.userId, t, r.id]);
    if (b.lat !== undefined && b.lng !== undefined) await conn.query('UPDATE collection_routes SET last_lat = ?, last_lng = ?, last_seen_at = ? WHERE tenant_id = ? AND id = ?', [b.lat, b.lng, at, t, r.id]);
    await joinCrew(conn, req, r, crew);
    await audit(conn, req, 'route_mark', 'collection_routes', r.id, { stop_id: s.id, status: b.status, reason: b.reason || null, photo_id: photo ? photo.id : null, queued: Boolean(b.queued), stale: Boolean(stale) });
    return { ok: true, status: stale ? s.status : b.status, ...(stale ? { stale: true } : {}) };
  });
}

async function gobackDone(conn, t, gid, at, userId) {
  await conn.query("UPDATE collection_gobacks SET status = 'done', done_at = ?, done_by = ? WHERE tenant_id = ? AND id = ? AND status = 'waiting'", [at, userId, t, gid]);
  // The missed pickup it came from is fixed (collected on the go-back), if it is still open.
  const g = await one(conn, 'SELECT request_id FROM collection_gobacks WHERE tenant_id = ? AND id = ?', [t, gid]);
  if (g && g.request_id) await conn.query("UPDATE requests SET status = 'fixed', fixed_at = COALESCE(fixed_at, ?), public_note = COALESCE(public_note, 'Collected on a go-back.') WHERE tenant_id = ? AND id = ? AND status IN ('new','assigned','made_safe')", [at, t, g.request_id]);
}

/** Managers: who is on the route (Crew logins). */
async function setCrew(req, id, userIds) {
  return tx(async (conn) => {
    const t = req.auth.tenantId;
    const r = await routeRow(conn, t, id, { lock: true });
    const users = userIds.length ? await rows(conn, "SELECT id, staff_id FROM users WHERE tenant_id = ? AND id IN (?) AND active = 1 AND role IN ('staff','manager','owner')", [t, userIds]) : [];
    if (users.length !== new Set(userIds).size) throw notFound('Crew member');
    await conn.query('DELETE FROM collection_route_crew WHERE tenant_id = ? AND route_id = ? AND user_id NOT IN (?)', [t, r.id, userIds.length ? userIds : [0]]);
    for (const u of users) await conn.query('INSERT IGNORE INTO collection_route_crew (tenant_id, route_id, user_id, staff_id, added_by) VALUES (?, ?, ?, ?, ?)', [t, r.id, u.id, u.staff_id || null, req.auth.userId]);
    await audit(conn, req, 'route_crew', 'collection_routes', r.id, { users: userIds });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- costs: a truck's job on a day
/** The work order a truck's job on a day is costed on (made the first time): collection on Sanitation, plowing on Streets / Liquid Fuels. */
async function truckJob(conn, req, date, assetId, job) {
  const t = req.auth.tenantId;
  const have = await one(conn, 'SELECT work_order_id FROM collection_truck_jobs WHERE tenant_id = ? AND on_date = ? AND asset_id = ? AND job = ?', [t, date, assetId, job]);
  if (have) return Number(have.work_order_id);
  const W = require('./workcosts');
  await W.ensureBooks(conn, t);
  const a = await one(conn, 'SELECT name FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, assetId]);
  const { departments, funds } = await W.books(conn, t);
  const dept = departments.find((d) => d.active && d.kind === (job === 'plowing' ? 'streets' : 'sanitation')) || null;
  const fund = job === 'plowing' ? (funds.find((f) => f.active && f.kind === 'liquid_fuels') || null) : (funds.find((f) => f.active && f.kind === 'sanitation') || null);
  const title = `${job === 'plowing' ? 'Plowing and salting' : 'Collection'}: ${a ? a.name : 'truck'}, ${dayWords(date)}`;
  const woId = await require('../routes/maintenance').createOrder(conn, req, { title, description: job === 'plowing' ? 'Snow and ice: the truck\'s plowing hours this day (Collection routes).' : 'Trash and recycling collection: the crew, truck hours and tipping fees of this day\'s routes (Collection routes).', priority: 'normal', asset_id: assetId, due_date: date });
  // Chosen by the app (not by the person finishing the route), so set here rather than through the create form's rule.
  await conn.query("UPDATE work_orders SET department_id = ?, fund_id = COALESCE(?, fund_id), books_checked = 1, status = 'in_progress' WHERE tenant_id = ? AND id = ?", [dept ? dept.id : null, fund ? fund.id : (dept ? dept.fund_id : null), t, woId]);
  await conn.query('INSERT INTO collection_truck_jobs (tenant_id, on_date, asset_id, job, work_order_id) VALUES (?, ?, ?, ?, ?)', [t, date, assetId, job, woId]);
  return woId;
}
async function closeJob(conn, t, woId, now) {
  await conn.query("UPDATE work_orders SET status = 'done', completed_at = COALESCE(completed_at, ?) WHERE tenant_id = ? AND id = ? AND status <> 'cancelled'", [now, t, woId]);
}

/** Hours on a truck for a job (plowing, or collection outside a route), with the crew's hours: costed on the day's job work order. */
async function logTruckHours(req, b) {
  return tx(async (conn) => {
    const t = req.auth.tenantId; const tz = await tzOf(conn, t); const now = nowIn(tz);
    const a = await one(conn, 'SELECT id, name FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, b.truck_id]);
    if (!a) throw notFound('Truck');
    const date = b.on_date || todayIn(tz);
    if (date > todayIn(tz)) throw bad('Log hours on the day they were worked, not ahead');
    const W = require('./workcosts');
    const woId = await truckJob(conn, req, date, Number(a.id), b.job);
    await W.addEquipment(conn, req, woId, { asset_id: Number(a.id), hours: b.hours, used_on: date, note: b.note || `${b.job === 'plowing' ? 'Plowing' : 'Collection'} hours` });
    for (const c of b.crew || []) await W.addLabor(conn, req, woId, { staff_id: c.staff_id, hours: c.hours, worked_on: date, note: b.job === 'plowing' ? 'Plowing' : 'Collection' });
    if (b.odometer !== undefined && b.odometer !== null) await readOdometer(conn, req, Number(a.id), b.odometer, now);
    await closeJob(conn, t, woId, now);
    await audit(conn, req, 'truck_hours', 'ops_assets', a.id, { job: b.job, hours: b.hours, on_date: date, crew: (b.crew || []).length, work_order_id: woId });
    return { ok: true, work_order_id: woId };
  });
}

/** Finish the route: odometer, hours (the crew's and the truck's; worked out from the start and end when not given), tickets. */
async function finish(req, id, b) {
  const addTicket = addTicketFn();
  return tx(async (conn) => {
    const { t, today, r, crew, now } = await workable(conn, req, id);
    // Sent again from the phone's queue (it carries a client_ref): the route is finished already, so the same answer.
    if (b.client_ref && r.status === 'done') return { ok: true, repeat: true, work_order_id: r.work_order_id ? Number(r.work_order_id) : null };
    if (r.status === 'done') throw conflict('This route is already finished');
    if (r.status === 'delayed') throw conflict('This route is delayed; there is nothing to finish today');
    if (ymd(r.on_date) !== today && !isMgr(req)) throw conflict('A route is finished on its own day. A manager can finish an older one.');
    const truck = b.truck_id || r.asset_id;
    if (!truck) throw bad('Pick the truck you drove');
    const started = r.started_at ? dt(r.started_at) : null;
    const worked = quarter(hoursBetween(started, now));
    const truckHours = b.truck_hours ?? (worked || null);
    if (!truckHours) throw bad('Give the truck\'s hours today');
    if (b.odometer !== undefined && b.odometer !== null) {
      if (r.odometer_start !== null && Number(b.odometer) < Number(r.odometer_start)) throw bad(`The odometer read ${Number(r.odometer_start).toLocaleString('en-US')} at the start. Check the number.`);
      await readOdometer(conn, req, Number(truck), b.odometer, now);
    }
    const W = require('./workcosts');
    const date = ymd(r.on_date);
    const woId = await truckJob(conn, req, date, Number(truck), 'collection');
    await W.addEquipment(conn, req, woId, { asset_id: Number(truck), hours: truckHours, used_on: date, note: `${r.name}` });
    // The crew's hours: as given, else each person on the route for the route's time.
    const given = new Map((b.crew || []).map((c) => [Number(c.user_id), c.hours]));
    const people = crew.length ? crew : (req.auth.role === 'staff' ? [{ user_id: req.auth.userId, staff_id: req.auth.staffId || null }] : []);
    for (const c of people) {
      const hours = given.has(Number(c.user_id)) ? given.get(Number(c.user_id)) : worked || truckHours;
      if (!hours) continue;
      const u = await one(conn, 'SELECT staff_id, username FROM users WHERE tenant_id = ? AND id = ?', [t, c.user_id]);
      await W.addLabor(conn, req, woId, { staff_id: u && u.staff_id ? Number(u.staff_id) : null, worker: u && u.staff_id ? null : (u ? u.username : 'Crew'), hours, worked_on: date, note: r.name });
      await conn.query('INSERT INTO collection_route_crew (tenant_id, route_id, user_id, staff_id, hours, added_by) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE hours = VALUES(hours)', [t, r.id, c.user_id, u && u.staff_id ? u.staff_id : null, hours, req.auth.userId]);
    }
    // Tickets: to the tonnage records, and the tipping fee onto the day's cost.
    for (const k of b.tickets || []) {
      if (k.client_ref && (await one(conn, 'SELECT id FROM collection_route_tickets WHERE tenant_id = ? AND client_ref = ?', [t, k.client_ref]))) continue;
      const tid = await addTicket(conn, t, { ticket_date: date, asset_id: Number(truck), stream_id: k.stream_id || Number(r.stream_id), facility_id: k.facility_id || null, facility: k.facility, ticket_no: k.ticket_no || null, net_tons: k.net_tons, gross_lbs: k.gross_lbs ?? null, tare_lbs: k.tare_lbs ?? null, fee_cents: k.fee_cents || 0, route_id: Number(r.id), source: 'driver' }, { by: req.auth.userId });
      await conn.query('INSERT INTO collection_route_tickets (tenant_id, route_id, ticket_id, facility, stream_id, ticket_no, net_tons, fee_cents, client_ref, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [t, r.id, tid && (tid.id || Number(tid)) ? Number(tid.id || tid) : null, k.facility, k.stream_id || r.stream_id, k.ticket_no || null, k.net_tons, k.fee_cents || 0, k.client_ref || null, req.auth.userId]);
      if (k.fee_cents) await W.addMaterial(conn, req, woId, { description: `Tipping fee: ${k.facility}${k.ticket_no ? `, ticket ${k.ticket_no}` : ''} (${Number(k.net_tons).toFixed(2)} tons)`.slice(0, 150), qty: 1, unit: 'ticket', unit_cost_cents: k.fee_cents, used_on: date });
    }
    await conn.query("UPDATE collection_routes SET status = 'done', asset_id = ?, finished_at = ?, finished_by = ?, odometer_end = COALESCE(?, odometer_end), truck_hours = ?, work_order_id = ?, started_at = COALESCE(started_at, ?) WHERE tenant_id = ? AND id = ?",
      [truck, now, req.auth.userId, b.odometer ?? null, truckHours, woId, now, t, r.id]);
    // The day's job is done when every route on this truck that day is.
    const open = await one(conn, "SELECT COUNT(*) AS c FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND asset_id = ? AND status = 'started' AND id <> ?", [t, date, truck, r.id]);
    if (!n(open.c)) await closeJob(conn, t, woId, now);
    const left = await one(conn, "SELECT COUNT(*) AS c FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND status = 'todo'", [t, r.id]);
    await audit(conn, req, 'route_finish', 'collection_routes', r.id, { truck_id: truck, truck_hours: truckHours, tickets: (b.tickets || []).length, left: n(left.c), work_order_id: woId });
    return { ok: true, work_order_id: woId, left: n(left.c) };
  });
}

/** A plow / spreader changeover is a short work order on the truck; the truck's setup changes with it. */
async function changeover(req, assetId, to) {
  return tx(async (conn) => {
    const t = req.auth.tenantId;
    const a = await one(conn, 'SELECT id, name, status FROM ops_assets WHERE tenant_id = ? AND id = ?', [t, assetId]);
    if (!a) throw notFound('Truck');
    const today = todayIn(await tzOf(conn, t));
    const title = to === 'plow' ? `Changeover to plow and spreader: ${a.name}` : `Changeover back to collection: ${a.name} (plow and spreader off)`;
    const woId = await require('../routes/maintenance').createOrder(conn, req, { title, description: to === 'plow' ? 'Mount the plow and spreader, check the hydraulics and plow lights, load salt.' : 'Take off the plow and spreader, wash out salt, check the packer body before collection.', priority: 'high', asset_id: Number(a.id), due_date: today });
    await conn.query("INSERT INTO collection_trucks (tenant_id, asset_id, plows, setup, updated_by) VALUES (?, ?, 1, ?, ?) ON DUPLICATE KEY UPDATE setup = VALUES(setup), plows = 1, updated_by = VALUES(updated_by)", [t, a.id, to === 'plow' ? 'plow' : 'collection', req.auth.userId]);
    await audit(conn, req, 'truck_changeover', 'ops_assets', a.id, { to, work_order_id: woId });
    return { ok: true, work_order_id: woId };
  });
}

/** Managers: which trucks collect, and which also plow. */
async function saveTrucks(req, list) {
  return tx(async (conn) => {
    const t = req.auth.tenantId;
    const ids = list.map((x) => x.truck_id);
    if (ids.length) {
      const found = await rows(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND id IN (?)', [t, ids]);
      if (found.length !== new Set(ids).size) throw notFound('Truck');
    }
    await conn.query('UPDATE collection_trucks SET active = 0 WHERE tenant_id = ? AND asset_id NOT IN (?)', [t, ids.length ? ids : [0]]);
    for (const x of list) await conn.query('INSERT INTO collection_trucks (tenant_id, asset_id, plows, active, updated_by) VALUES (?, ?, ?, 1, ?) ON DUPLICATE KEY UPDATE plows = VALUES(plows), active = 1, updated_by = VALUES(updated_by)', [t, x.truck_id, x.plows ? 1 : 0, req.auth.userId]);
    await audit(conn, req, 'collection_trucks', 'collection_trucks', null, { trucks: list });
    return { ok: true };
  });
}

// ---------------------------------------------------------------- go-backs
async function addGoback(req, b) {
  return tx(async (conn) => {
    const t = req.auth.tenantId; const tz = await tzOf(conn, t); const today = todayIn(tz);
    let streetId = b.street_id; let house = b.house_number || null;
    if (b.request_id) {
      const q = await one(conn, 'SELECT id, street_id, house_number FROM requests WHERE tenant_id = ? AND id = ?', [t, b.request_id]);
      if (!q) throw notFound('Request');
      streetId = streetId || (q.street_id ? Number(q.street_id) : null); house = house || q.house_number;
      const open = await one(conn, "SELECT id FROM collection_gobacks WHERE tenant_id = ? AND request_id = ? AND status = 'waiting'", [t, q.id]);
      if (open) throw conflict('A go-back is already waiting for this request');
    }
    if (!streetId || !(await one(conn, 'SELECT id FROM streets WHERE tenant_id = ? AND id = ?', [t, streetId]))) throw bad('Pick the street');
    if (b.stream_id && !(await one(conn, 'SELECT id FROM collection_streams WHERE tenant_id = ? AND id = ?', [t, b.stream_id]))) throw notFound('Stream');
    const due = b.due_on || addDays(today, 1);
    if (due < today) throw bad('A go-back is for today or a later day');
    const [ins] = await conn.query('INSERT INTO collection_gobacks (tenant_id, request_id, street_id, house_number, stream_id, note, due_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, b.request_id || null, streetId, house, b.stream_id || null, b.note || null, due, req.auth.userId]);
    if (due <= today && (await one(conn, 'SELECT id FROM collection_routes WHERE tenant_id = ? AND on_date = ? LIMIT 1', [t, due]))) await placeGobacks(conn, t, due);
    await audit(conn, req, 'goback_add', 'collection_gobacks', ins.insertId, { request_id: b.request_id || null, due_on: due });
    return { id: Number(ins.insertId), due_on: due };
  });
}
async function cancelGoback(req, id) {
  const t = req.auth.tenantId;
  const [r] = await pool.query("UPDATE collection_gobacks SET status = 'cancelled' WHERE tenant_id = ? AND id = ? AND status = 'waiting'", [t, id]);
  if (!r.affectedRows) throw notFound('Waiting go-back');
  await pool.query("DELETE FROM collection_route_stops WHERE tenant_id = ? AND goback_id = ? AND status = 'todo'", [t, id]);
  await audit(pool, req, 'goback_cancel', 'collection_gobacks', id);
}
/** Go-backs waiting (due today or before). userId: only those on routes this Crew login is on; null: all of them (managers). */
async function gobacksWaiting(db, t, today, userId = null) {
  if (userId === null) return n((await one(db, "SELECT COUNT(*) AS c FROM collection_gobacks WHERE tenant_id = ? AND status = 'waiting' AND due_on <= ?", [t, today])).c);
  return n((await one(db, `SELECT COUNT(*) AS c FROM collection_gobacks g JOIN collection_route_crew c ON c.tenant_id = g.tenant_id AND c.route_id = g.route_id AND c.user_id = ?
    WHERE g.tenant_id = ? AND g.status = 'waiting' AND g.due_on <= ?`, [userId, t, today])).c);
}
async function gobackList(req, { status = 'waiting' } = {}) {
  const t = req.auth.tenantId;
  const list = await rows(pool, `SELECT g.*, s.name AS street, st.name AS stream, r.name AS route, rq.reference FROM collection_gobacks g JOIN streets s ON s.tenant_id = g.tenant_id AND s.id = g.street_id
    LEFT JOIN collection_streams st ON st.tenant_id = g.tenant_id AND st.id = g.stream_id LEFT JOIN collection_routes r ON r.tenant_id = g.tenant_id AND r.id = g.route_id
    LEFT JOIN requests rq ON rq.tenant_id = g.tenant_id AND rq.id = g.request_id
    WHERE g.tenant_id = ? ${status === 'all' ? '' : 'AND g.status = ?'} ORDER BY g.due_on DESC, g.id DESC LIMIT 300`, status === 'all' ? [t] : [t, status]);
  return list.map((g) => ({ id: Number(g.id), words: `${g.house_number ? `${g.house_number} ` : ''}${g.street}`, stream: g.stream, due_on: ymd(g.due_on), route: g.route, status: g.status, note: g.note, request: g.reference || null, request_id: g.request_id ? Number(g.request_id) : null, done_at: dt(g.done_at) }));
}

// ---------------------------------------------------------------- the missed-pickup check (schedule's check calls this)
/**
 * Where the route stands for one address and stream on a day: { outcome: 'not_yet' | 'done' | 'skipped', at, reason,
 * reason_words, photo, delayed, moved_to } or null when there is no route for it that day (the check falls back to its
 * own rule). 'not_yet': the route has not reached that street (or is delayed). Read-only.
 */
async function routeCheck(conn, t, { streetId, houseNo: no, streamId = null, date }) {
  const z = await C.zoneFor(conn, t, { streetId, houseNo: no });
  if (!z || !z.zoneId) return null;
  const list = await rows(conn, `SELECT id, status, moved_to, delayed_reason FROM collection_routes WHERE tenant_id = ? AND on_date = ? AND zone_id = ? ${streamId ? 'AND stream_id = ?' : ''} ORDER BY id`, streamId ? [t, date, z.zoneId, streamId] : [t, date, z.zoneId]);
  if (!list.length) {
    const plan = (await C.dayRoutes(conn, t, date)).find((p) => p.zoneId === z.zoneId && (!streamId || p.streamId === Number(streamId)));
    return plan ? { outcome: 'not_yet', message: 'The truck is still on its route today.' } : null;
  }
  const r = list[0];
  if (r.status === 'delayed') {
    const to = ymd(r.moved_to);
    return { outcome: 'not_yet', delayed: true, reason: r.delayed_reason === 'snow' ? 'snow' : 'weather', moved_to: to, message: `Today's pickup on your street is delayed for ${r.delayed_reason === 'snow' ? 'snow' : 'weather'}${to ? `. It is now ${dayWords(to)}` : ''}.` };
  }
  const stops = await rows(conn, 'SELECT id, kind, from_no, to_no, side, status, reason, marked_at, photo_id FROM collection_route_stops WHERE tenant_id = ? AND route_id = ? AND street_id = ? ORDER BY marked_at DESC', [t, r.id, streetId]);
  const hit = stops.filter((s) => covers(s, no));
  const done = hit.find((s) => s.status === 'done');
  if (done) return { outcome: 'done', at: dt(done.marked_at), message: `The crew marked your street done at ${require('./util').clock(dt(done.marked_at))}. Tell us what was missed and we will send someone back.` };
  const skipped = hit.find((s) => s.status === 'skipped');
  if (skipped) return { outcome: 'skipped', at: dt(skipped.marked_at), reason: REASONS[skipped.reason].toLowerCase(), reason_key: skipped.reason, reason_words: REASONS[skipped.reason], photo: Boolean(skipped.photo_id), message: `The crew could not collect on your street today: ${REASONS[skipped.reason].toLowerCase()}. You can still report it, and we will send someone back.` };
  if (r.status === 'done') return null; // finished without that street marked: the check's own rule
  return { outcome: 'not_yet', message: 'The truck is still on its route today.' };
}

// ---------------------------------------------------------------- snow days
async function settingsOf(db, t) {
  return (await one(db, 'SELECT * FROM collection_settings WHERE tenant_id = ?', [t])) || { model: 'inhouse', holiday_rule: 'shift' };
}
/** The next day trucks run after this one (Sunday is skipped). */
const nextRunDay = (d) => { const x = addDays(d, 1); return weekdayOf(x) === 0 ? addDays(x, 1) : x; };

/**
 * Declares a snow day (managers): the changes, the routes Delayed for snow, and a DRAFT street notice to the streets of
 * the zones affected. Returns { id, changes: [{ from, to }], notice_id, notice: { title, sms_text }, delayed }.
 */
async function declareSnowDay(req, b) {
  const t = req.auth.tenantId;
  const zoneIds = [...new Set(b.zone_ids || [])].map(Number);
  return tx(async (conn) => {
    const tz = await tzOf(conn, t); const today = todayIn(tz); const now = nowIn(tz);
    if (b.on_date < today) throw bad('A snow day is declared for today or a later day');
    const s = await settingsOf(conn, t);
    const rule = s.holiday_rule || 'shift';
    if (zoneIds.length && (await rows(conn, 'SELECT id FROM collection_zones WHERE tenant_id = ? AND id IN (?)', [t, zoneIds])).length !== zoneIds.length) throw notFound('Zone');
    const plan = await C.dayRoutes(conn, t, b.on_date);
    const hit = plan.filter((p) => !zoneIds.length || zoneIds.includes(p.zoneId));
    if (!hit.length) throw conflict(`Nothing is collected ${zoneIds.length ? 'in those zones ' : ''}on ${dayWords(b.on_date)}`);
    const active = await rows(conn, 'SELECT id, zone_ids FROM collection_snow_days WHERE tenant_id = ? AND on_date = ? AND undone_at IS NULL', [t, b.on_date]);
    if (active.some((x) => { const z = zoneIdsOf(x.zone_ids); return !z.length || !zoneIds.length || z.some((i) => zoneIds.includes(i)); })) throw conflict(`A snow day is already declared for ${dayWords(b.on_date)}. Undo it first to change it.`);
    const moves = [{ from: b.on_date, to: rule === 'skip' ? null : nextRunDay(b.on_date), zones: zoneIds }];
    // A whole-borough snow day with the shift rule: the rest of that Monday-Saturday week moves a day too.
    if (rule === 'shift' && !zoneIds.length && weekdayOf(b.on_date) !== 0) {
      for (let d = addDays(b.on_date, 1); weekdayOf(d) !== 0; d = addDays(d, 1)) {
        if ((await C.dayRoutes(conn, t, d)).length) moves.push({ from: d, to: nextRunDay(d), zones: [] });
      }
    }
    const changeIds = [];
    for (const m of moves) {
      const [ins] = await conn.query("INSERT INTO collection_changes (tenant_id, on_date, moved_to, zone_ids, reason, note, created_by) VALUES (?, ?, ?, ?, 'snow', ?, ?)", [t, m.from, m.to, JSON.stringify(m.zones), b.note || null, req.auth.userId]);
      changeIds.push(Number(ins.insertId));
    }
    // That day's routes kept already (today): Delayed for snow.
    const affected = hit.map((p) => p.zoneId);
    const [del] = await conn.query("UPDATE collection_routes SET status = 'delayed', delayed_reason = 'snow', moved_to = ? WHERE tenant_id = ? AND on_date = ? AND zone_id IN (?) AND status IN ('planned','started')", [moves[0].to, t, b.on_date, affected]);
    // The street notice: the schedule's own draft for a moved or canceled day (routes/collection.js draftNotice), aimed
    // at the zones affected, for the manager to read over and send from Street notices.
    const more = moves.length > 1 ? 'Pickups later this week move one day later too.' : '';
    const noticeId = await require('../routes/collection').draftNotice(conn, req, { id: changeIds[0], on_date: b.on_date, moved_to: moves[0].to, reason: 'snow', note: [more, b.note].filter(Boolean).join(' ') || null, zone_ids: zoneIds.length ? zoneIds : [...new Set(affected)] });
    if (noticeId) await conn.query('UPDATE collection_changes SET notice_id = ? WHERE tenant_id = ? AND id IN (?)', [noticeId, t, changeIds]);
    const nt = noticeId ? await one(conn, 'SELECT title, sms_text FROM street_notices WHERE tenant_id = ? AND id = ?', [t, noticeId]) : null;
    const streetsN = noticeId ? n((await one(conn, 'SELECT COUNT(*) AS c FROM street_notice_areas WHERE tenant_id = ? AND notice_id = ?', [t, noticeId])).c) : 0;
    const [sd] = await conn.query('INSERT INTO collection_snow_days (tenant_id, on_date, zone_ids, change_ids, notice_id, note, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [t, b.on_date, JSON.stringify(zoneIds), JSON.stringify(changeIds), noticeId, b.note || null, req.auth.userId, now]);
    await audit(conn, req, 'snow_day', 'collection_snow_days', sd.insertId, { on_date: b.on_date, zones: zoneIds, rule, changes: moves.length, notice_id: noticeId });
    return { id: Number(sd.insertId), rule, changes: moves.map((m) => ({ from: m.from, to: m.to })), notice_id: noticeId, notice: nt ? { title: nt.title, sms_text: nt.sms_text, streets: streetsN } : null, delayed: del.affectedRows };
  });
}
async function undoSnowDay(req, id) {
  const t = req.auth.tenantId;
  return tx(async (conn) => {
    const s = await one(conn, 'SELECT * FROM collection_snow_days WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!s || s.undone_at) throw notFound('Snow day');
    const ids = zoneIdsOf(s.change_ids);
    if (ids.length) await conn.query('DELETE FROM collection_changes WHERE tenant_id = ? AND id IN (?)', [t, ids]);
    let noticeSent = false;
    if (s.notice_id) {
      const nt = await one(conn, 'SELECT status FROM street_notices WHERE tenant_id = ? AND id = ?', [t, s.notice_id]);
      if (nt && nt.status === 'draft') { await conn.query('DELETE FROM street_notice_areas WHERE tenant_id = ? AND notice_id = ?', [t, s.notice_id]); await conn.query('DELETE FROM street_notices WHERE tenant_id = ? AND id = ?', [t, s.notice_id]); } else if (nt) noticeSent = true;
    }
    await conn.query("UPDATE collection_routes SET status = IF(started_at IS NULL, 'planned', 'started'), delayed_reason = NULL, moved_to = NULL WHERE tenant_id = ? AND on_date = ? AND status = 'delayed' AND delayed_reason = 'snow'", [t, ymd(s.on_date)]);
    await conn.query('UPDATE collection_snow_days SET undone_at = ?, undone_by = ? WHERE tenant_id = ? AND id = ?', [nowIn(await tzOf(conn, t)), req.auth.userId, t, id]);
    await audit(conn, req, 'snow_day_undo', 'collection_snow_days', id, { notice_sent: noticeSent });
    return { ok: true, notice_sent: noticeSent };
  });
}
async function snowDays(t, today) {
  const list = await rows(pool, `SELECT d.*, n.status AS notice_status, n.code AS notice_code FROM collection_snow_days d LEFT JOIN street_notices n ON n.tenant_id = d.tenant_id AND n.id = d.notice_id
    WHERE d.tenant_id = ? AND d.undone_at IS NULL AND d.on_date >= ? ORDER BY d.on_date`, [t, addDays(today, -14)]);
  return list.map((d) => ({ id: Number(d.id), on_date: ymd(d.on_date), zone_ids: zoneIdsOf(d.zone_ids), note: d.note, notice_id: d.notice_id ? Number(d.notice_id) : null, notice_status: d.notice_status || null, declared_at: dt(d.declared_at) }));
}

// ---------------------------------------------------------------- the office's progress board and costs
/** Today's (or a day's) routes for the office's board: progress, truck, crew, where the truck was last, and the stops' marks for the map. */
async function board(req, date) {
  const v = await dayView(req, date);
  if (!v.kept) return { ...v, points: [] };
  const ids = v.routes.map((r) => r.id).filter(Boolean);
  const pts = ids.length ? await rows(pool, `SELECT s.route_id, s.status, s.marked_lat, s.marked_lng, s.marked_at, st.name AS street, s.from_no, s.to_no, s.side, s.kind FROM collection_route_stops s
    JOIN streets st ON st.tenant_id = s.tenant_id AND st.id = s.street_id WHERE s.tenant_id = ? AND s.route_id IN (?) AND s.marked_lat IS NOT NULL`, [req.auth.tenantId, ids]) : [];
  return { ...v, points: pts.map((p) => ({ route_id: Number(p.route_id), status: p.status, lat: Number(p.marked_lat), lng: Number(p.marked_lng), at: dt(p.marked_at), words: p.kind === 'goback' ? p.street : stopWords(p) })) };
}

/** Collection-day costs from..to (managers): by day and route: crew hours, truck hours, tons, and (managers only) costs. */
async function costs(req, from, to) {
  const t = req.auth.tenantId;
  const W = require('./workcosts');
  const jobs = await rows(pool, 'SELECT j.on_date, j.asset_id, j.job, j.work_order_id, a.name AS truck FROM collection_truck_jobs j JOIN ops_assets a ON a.tenant_id = j.tenant_id AND a.id = j.asset_id WHERE j.tenant_id = ? AND j.on_date BETWEEN ? AND ? ORDER BY j.on_date, a.name', [t, from, to]);
  const cost = await W.orderCosts(pool, t, jobs.map((j) => Number(j.work_order_id)));
  const tickets = await rows(pool, 'SELECT r.on_date, r.asset_id, SUM(k.net_tons) AS tons, SUM(k.fee_cents) AS fees FROM collection_route_tickets k JOIN collection_routes r ON r.tenant_id = k.tenant_id AND r.id = k.route_id WHERE k.tenant_id = ? AND r.on_date BETWEEN ? AND ? GROUP BY r.on_date, r.asset_id', [t, from, to]);
  const mgr = isMgr(req);
  const list = jobs.map((j) => {
    const c = cost.get(Number(j.work_order_id)) || {};
    const k = j.job === 'collection' ? tickets.find((x) => ymd(x.on_date) === ymd(j.on_date) && Number(x.asset_id) === Number(j.asset_id)) : null;
    return { date: ymd(j.on_date), truck: j.truck, job: j.job, work_order_id: Number(j.work_order_id), crew_hours: r2(c.labor_hours), truck_hours: r2(c.equipment_hours), tons: k ? r2(k.tons) : 0,
      ...(mgr ? { labor_cents: c.labor_cents || 0, equipment_cents: c.equipment_cents || 0, tipping_cents: k ? n(k.fees) : 0, total_cents: c.total_cents || 0 } : {}) };
  });
  const sum = (job, key) => r2(list.filter((x) => x.job === job).reduce((s, x) => s + n(x[key]), 0));
  const totals = { collection: { crew_hours: sum('collection', 'crew_hours'), truck_hours: sum('collection', 'truck_hours'), tons: sum('collection', 'tons') }, plowing: { crew_hours: sum('plowing', 'crew_hours'), truck_hours: sum('plowing', 'truck_hours') } };
  if (mgr) {
    totals.collection.total_cents = Math.round(sum('collection', 'total_cents')); totals.collection.tipping_cents = Math.round(sum('collection', 'tipping_cents'));
    totals.plowing.total_cents = Math.round(sum('plowing', 'total_cents'));
    totals.collection.cost_per_ton_cents = totals.collection.tons ? Math.round(totals.collection.total_cents / totals.collection.tons) : null;
  }
  return { from, to, days: list, totals };
}

// ---------------------------------------------------------------- Today and the menu count
/** Today's cards for Collection routes: the managers' and desk's progress card, the go-backs waiting, the crew's own route. */
async function todayCards(req) {
  const t = req.auth.tenantId; const tz = await tzOf(pool, t); const today = todayIn(tz);
  const v = await dayView(req, today);
  const cards = [];
  const rs = v.routes;
  if (req.auth.role === 'staff') {
    const mine = rs.filter((r) => r.crew.some((c) => c.user_id === Number(req.auth.userId)));
    for (const r of mine.length ? mine : rs) cards.push({ title: `${mine.length ? 'Your route' : 'Route to pick up'}: ${r.name}`, count: r.progress.left, text: r.status === 'delayed' ? r.status_words : `${r.progress.done} done, ${r.progress.skipped} skipped, ${r.progress.left} to go`, href: `#/bulk?tab=routes&route=${r.id}` });
  } else if (rs.length) {
    const tally = (s) => rs.filter((r) => r.status === s).length;
    const stops = rs.reduce((a, r) => a + r.progress.total, 0); const marked = rs.reduce((a, r) => a + r.progress.done + r.progress.skipped, 0);
    cards.push({ title: 'Collection routes today', count: rs.length, text: [`${tally('done')} finished`, `${tally('started')} on the road`, tally('planned') ? `${tally('planned')} not started` : null, tally('delayed') ? `${tally('delayed')} delayed for snow or weather` : null, stops ? `${Math.round((marked / stops) * 100)}% of streets done` : null].filter(Boolean).join(', '), href: '#/bulk?tab=routes' });
  } else if (v.moved.length) cards.push({ title: 'No collection today', count: null, text: `Moved: ${v.moved.map((m) => `${m.zones}${m.to ? ` to ${dayWords(m.to)}` : ' (canceled)'}`).join('; ')}`, href: '#/bulk?tab=routes' });
  const waiting = await gobacksWaiting(pool, t, today, isMgr(req) || req.auth.role === 'counter' ? null : req.auth.userId);
  if (waiting) cards.push({ title: 'Missed pickups to go back for', count: waiting, text: `${waiting} go-back${waiting === 1 ? '' : 's'} on today's routes or waiting`, href: '#/bulk?tab=routes&view=gobacks' });
  return cards;
}

// ---------------------------------------------------------------- hauler oversight
const TOKEN_DAYS = 30;
const hash = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex');
const plusHours = (local, h) => new Date(Date.parse(`${dt(local).replace(' ', 'T')}Z`) + h * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

async function contractOf(db, t, date = null) {
  const list = await rows(db, 'SELECT * FROM hauler_contracts WHERE tenant_id = ? ORDER BY starts_on DESC, id DESC', [t]);
  if (!date) return list[0] || null;
  return list.find((c) => ymd(c.starts_on) <= date && (!c.ends_on || ymd(c.ends_on) >= date)) || list[0] || null;
}
function contractShape(c, mgr) {
  if (!c) return null;
  return { id: Number(c.id), hauler_name: c.hauler_name, starts_on: ymd(c.starts_on), ends_on: ymd(c.ends_on), service_hours: Number(c.service_hours), households: c.households === null ? null : Number(c.households), penalty_after: Number(c.penalty_after), terms: c.terms,
    ...(mgr ? { price_per_household_cents: c.price_per_household_cents === null ? null : Number(c.price_per_household_cents), penalty_cents: c.penalty_cents === null ? null : Number(c.penalty_cents) } : {}) };
}
async function saveContract(req, b) {
  return tx(async (conn) => {
    const t = req.auth.tenantId;
    const cur = b.id ? await one(conn, 'SELECT id FROM hauler_contracts WHERE tenant_id = ? AND id = ?', [t, b.id]) : null;
    if (b.id && !cur) throw notFound('Contract');
    if (b.ends_on && b.ends_on < b.starts_on) throw bad('The contract ends before it starts');
    const vals = [b.hauler_name, b.starts_on, b.ends_on || null, b.service_hours, b.households ?? null, b.price_per_household_cents ?? null, b.penalty_cents ?? null, b.penalty_after ?? 0, b.terms || null, req.auth.userId];
    let id;
    if (cur) { await conn.query('UPDATE hauler_contracts SET hauler_name = ?, starts_on = ?, ends_on = ?, service_hours = ?, households = ?, price_per_household_cents = ?, penalty_cents = ?, penalty_after = ?, terms = ?, updated_by = ? WHERE tenant_id = ? AND id = ?', [...vals, t, cur.id]); id = Number(cur.id); } else {
      const [ins] = await conn.query('INSERT INTO hauler_contracts (hauler_name, starts_on, ends_on, service_hours, households, price_per_household_cents, penalty_cents, penalty_after, terms, updated_by, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...vals, t]); id = Number(ins.insertId);
    }
    await audit(conn, req, cur ? 'hauler_contract_update' : 'hauler_contract_add', 'hauler_contracts', id, { hauler_name: b.hauler_name, starts_on: b.starts_on, ends_on: b.ends_on || null, service_hours: b.service_hours, price_per_household_cents: b.price_per_household_cents ?? null, penalty_cents: b.penalty_cents ?? null });
    return id;
  });
}

/** Is this request a missed pickup? (the category "Missed pickup", or its earlier name "Missed trash or recycling") */
const MISSED = "rc.name LIKE 'Missed%'";
async function streamOfRequest(db, t, requestId) {
  // The schedule workstream asks for the stream on a missed pickup; read it when the column is there.
  const col = await one(db, "SELECT 1 AS x FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'requests' AND column_name = 'stream_id'");
  if (!col) return null;
  const r = await one(db, 'SELECT st.name FROM requests q JOIN collection_streams st ON st.tenant_id = q.tenant_id AND st.id = q.stream_id WHERE q.tenant_id = ? AND q.id = ?', [t, requestId]);
  return r ? r.name : null;
}

/**
 * Sends a missed pickup to the hauler by email, with a new link (the old one stops working). Only the address, the
 * stream and when it was reported: never the resident's name, phone, email or own words. Returns { id, sent, link }.
 */
async function forward(t, requestId, { base, by = null, req = null } = {}) {
  const s = await settingsOf(pool, t);
  if (s.model !== 'contract') throw conflict('Missed pickups go to a hauler only when a contracted hauler collects (Schedule, Who collects)');
  if (!s.hauler_email) throw conflict('Add the hauler\'s email address first (Schedule, Who collects)');
  const town = await one(pool, 'SELECT id, name, slug, timezone FROM tenants WHERE id = ?', [t]);
  const q = await one(pool, `SELECT q.id, q.reference, q.house_number, q.reported_at, q.status, s.name AS street, rc.name AS category FROM requests q JOIN request_categories rc ON rc.tenant_id = q.tenant_id AND rc.id = q.category_id
    LEFT JOIN streets s ON s.tenant_id = q.tenant_id AND s.id = q.street_id WHERE q.tenant_id = ? AND q.id = ? AND ${MISSED}`, [t, requestId]);
  if (!q) throw notFound('Missed pickup request');
  const c = await contractOf(pool, t, ymd(q.reported_at));
  const hours = c ? Number(c.service_hours) : 24;
  const token = crypto.randomBytes(32).toString('base64url');
  const now = nowIn(town.timezone);
  const expires = plusHours(now, TOKEN_DAYS * 24);
  const reported = dt(q.reported_at);
  const due = plusHours(reported, hours);
  await pool.query(`INSERT INTO hauler_forwards (tenant_id, request_id, contract_id, token_hash, expires_at, sent_to, reported_at, due_at, forwarded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE token_hash = VALUES(token_hash), expires_at = VALUES(expires_at), sent_to = VALUES(sent_to), contract_id = VALUES(contract_id), forwarded_by = VALUES(forwarded_by)`,
  [t, q.id, c ? c.id : null, hash(token), expires, s.hauler_email, reported, due, by]);
  const f = await one(pool, 'SELECT id FROM hauler_forwards WHERE tenant_id = ? AND request_id = ?', [t, q.id]);
  const link = `${String(base || '').replace(/\/$/, '')}/hauler/${town.slug}/${token}`;
  const stream = await streamOfRequest(pool, t, q.id);
  const address = `${q.house_number ? `${q.house_number} ` : ''}${q.street || 'the street given'}`;
  const clock = require('./util').clock;
  const text = [`A missed pickup was reported in ${town.name}.`, '', `Address: ${address}`, stream ? `Stream: ${stream}` : null, `Reported: ${dayWords(reported.slice(0, 10))}, ${clock(reported)}`,
    `Please collect by: ${dayWords(due.slice(0, 10))}, ${clock(due)} (the contract's ${hours}-hour service level)`, `Reference: ${q.reference}`, '',
    'When it is collected, mark it on this page (no login needed):', link, '', `The link works for ${TOKEN_DAYS} days and only for this pickup.`].filter((x) => x !== null).join('\n');
  const r = await require('./mailer').send({ tenantId: t, to: s.hauler_email, fromName: town.name, subject: `Missed pickup: ${address} (${q.reference})`, text, tag: 'hauler_missed' });
  await pool.query('UPDATE hauler_forwards SET sent_at = ?, send_error = ? WHERE tenant_id = ? AND id = ?', [r.ok ? now : null, r.ok ? null : String(r.error || 'not sent').slice(0, 200), t, f.id]);
  await audit(pool, req || { auth: { tenantId: t, userId: by } }, 'hauler_forward', 'requests', q.id, { forward_id: Number(f.id), sent: Boolean(r.ok) });
  return { id: Number(f.id), sent: Boolean(r.ok), error: r.ok ? null : r.error || null, link };
}

/** The 5-minute job: new missed pickups where a contracted hauler collects (the hauler add-on on) go to the hauler. */
async function forwardDue(base) {
  const list = await rows(pool, `SELECT q.tenant_id, q.id FROM requests q JOIN request_categories rc ON rc.tenant_id = q.tenant_id AND rc.id = q.category_id
    JOIN collection_settings s ON s.tenant_id = q.tenant_id AND s.model = 'contract' AND s.hauler_email IS NOT NULL JOIN tenants tn ON tn.id = q.tenant_id AND tn.org_type = 'municipality' AND tn.status = 'active'
    WHERE ${MISSED} AND q.status IN ('new','assigned') AND q.created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY
      AND NOT EXISTS (SELECT 1 FROM hauler_forwards f WHERE f.tenant_id = q.tenant_id AND f.request_id = q.id) ORDER BY q.id LIMIT 200`);
  let sent = 0;
  for (const q of list) {
    try {
      if (!(await addonOn(Number(q.tenant_id), 'hauler'))) continue;
      const r = await forward(Number(q.tenant_id), Number(q.id), { base });
      if (r.sent) sent += 1;
    } catch (err) { console.error(JSON.stringify({ severity: 'ERROR', job: 'hauler_forward', tenant: q.tenant_id, message: err.message })); }
  }
  return { found: list.length, sent };
}
/** Is this add-on on for the tenant (a municipality, active, with Trash and recycling)? */
const addonOn = async (t, key) => { const s = await require('./modules').stateOf(t); return s.org === 'municipality' && s.status === 'active' && s.on.has('solidwaste') && s.on.has(key); };

/** The hauler's page, by its link: the address, stream and times only. null when the link is unknown or has expired. */
async function byToken(slug, token) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(String(token))) return null;
  const town = await one(pool, "SELECT id, name, timezone FROM tenants WHERE slug = ? AND org_type = 'municipality'", [String(slug)]);
  if (!town) return null;
  const f = await one(pool, `SELECT f.*, q.reference, q.house_number, s.name AS street FROM hauler_forwards f JOIN requests q ON q.tenant_id = f.tenant_id AND q.id = f.request_id
    LEFT JOIN streets s ON s.tenant_id = q.tenant_id AND s.id = q.street_id WHERE f.tenant_id = ? AND f.token_hash = ?`, [town.id, hash(token)]);
  if (!f) return null;
  const now = nowIn(town.timezone);
  if (dt(f.expires_at) < now) return { expired: true, town };
  return { town, f, now };
}
async function haulerView(slug, token) {
  const v = await byToken(slug, token);
  if (!v) throw notFound('Link');
  if (v.expired) { const e = new (require('./errors').AppError)(410, 'This link has expired. Please call the municipal office.'); throw e; }
  const { f, town, now } = v;
  if (!f.opened_at) await pool.query('UPDATE hauler_forwards SET opened_at = ? WHERE tenant_id = ? AND id = ?', [now, town.id, f.id]);
  const stream = await streamOfRequest(pool, town.id, f.request_id);
  return { town: town.name, reference: f.reference, address: `${f.house_number ? `${f.house_number} ` : ''}${f.street || ''}`.trim(), stream, reported_at: dt(f.reported_at), due_at: dt(f.due_at),
    collected_at: dt(f.collected_at), collected_note: f.collected_note, late: !f.collected_at && dt(f.due_at) < now };
}
async function haulerCollected(slug, token, note, ip) {
  const v = await byToken(slug, token);
  if (!v) throw notFound('Link');
  if (v.expired) throw new (require('./errors').AppError)(410, 'This link has expired. Please call the municipal office.');
  const { f, town, now } = v;
  if (!f.collected_at) await markCollected(town.id, Number(f.id), { at: now, via: 'link', note, by: null, req: { auth: { tenantId: town.id, userId: null }, ip } });
  return haulerView(slug, token);
}
async function markCollected(t, forwardId, { at, via, note = null, by = null, req }) {
  await tx(async (conn) => {
    const f = await one(conn, 'SELECT * FROM hauler_forwards WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, forwardId]);
    if (!f) throw notFound('Forwarded pickup');
    if (f.collected_at) return;
    await conn.query('UPDATE hauler_forwards SET collected_at = ?, collected_via = ?, collected_note = ?, collected_by = ? WHERE tenant_id = ? AND id = ?', [at, via, note ? String(note).slice(0, 300) : null, by, t, f.id]);
    await conn.query("UPDATE requests SET status = 'fixed', fixed_at = COALESCE(fixed_at, ?), public_note = COALESCE(public_note, 'The hauler collected it.') WHERE tenant_id = ? AND id = ? AND status IN ('new','assigned','made_safe')", [at, t, f.request_id]);
    await audit(conn, req, 'hauler_collected', 'requests', f.request_id, { forward_id: Number(f.id), via, on_time: at <= dt(f.due_at) });
  });
}

async function forwardsList(req, { show = 'open' } = {}) {
  const t = req.auth.tenantId; const now = nowIn(await tzOf(pool, t));
  const list = await rows(pool, `SELECT f.*, q.reference, q.house_number, s.name AS street FROM hauler_forwards f JOIN requests q ON q.tenant_id = f.tenant_id AND q.id = f.request_id
    LEFT JOIN streets s ON s.tenant_id = q.tenant_id AND s.id = q.street_id WHERE f.tenant_id = ? ${show === 'open' ? 'AND f.collected_at IS NULL' : ''} ORDER BY f.due_at ${show === 'open' ? 'ASC' : 'DESC'} LIMIT 300`, [t]);
  const notSent = await rows(pool, `SELECT q.id, q.reference, q.house_number, q.reported_at, s.name AS street FROM requests q JOIN request_categories rc ON rc.tenant_id = q.tenant_id AND rc.id = q.category_id
    LEFT JOIN streets s ON s.tenant_id = q.tenant_id AND s.id = q.street_id WHERE q.tenant_id = ? AND ${MISSED} AND q.status IN ('new','assigned','made_safe')
    AND NOT EXISTS (SELECT 1 FROM hauler_forwards f WHERE f.tenant_id = q.tenant_id AND f.request_id = q.id) ORDER BY q.reported_at LIMIT 100`, [t]);
  return {
    forwards: list.map((f) => ({ id: Number(f.id), request_id: Number(f.request_id), reference: f.reference, address: `${f.house_number ? `${f.house_number} ` : ''}${f.street || ''}`.trim(), reported_at: dt(f.reported_at), due_at: dt(f.due_at), sent_at: dt(f.sent_at), send_error: f.send_error, opened: Boolean(f.opened_at),
      collected_at: dt(f.collected_at), collected_via: f.collected_via, collected_note: f.collected_note, late: f.collected_at ? dt(f.collected_at) > dt(f.due_at) : dt(f.due_at) < now, link_expired: dt(f.expires_at) < now })),
    not_sent: notSent.map((q) => ({ request_id: Number(q.id), reference: q.reference, address: `${q.house_number ? `${q.house_number} ` : ''}${q.street || ''}`.trim(), reported_at: dt(q.reported_at) })),
  };
}

/** Monday of the week a date falls in. */
const mondayOf = (d) => { const w = weekdayOf(d); return addDays(d, w === 0 ? -6 : 1 - w); };
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/**
 * The month's scorecard: missed pickups sent to the hauler, collected on time, late, still open, the hours to collect
 * (average and the longest), by zone and by week, the contract's penalties (managers), and complaints by kind.
 */
async function scorecard(req, month) {
  if (!MONTH_RE.test(month || '')) throw bad('month must be YYYY-MM');
  const t = req.auth.tenantId; const mgr = isMgr(req);
  const now = nowIn(await tzOf(pool, t));
  const from = `${month}-01`; const to = addDays(Number(month.slice(5)) === 12 ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5)) + 1).padStart(2, '0')}-01`, -1);
  const list = await rows(pool, `SELECT f.*, q.street_id, q.house_number FROM hauler_forwards f JOIN requests q ON q.tenant_id = f.tenant_id AND q.id = f.request_id WHERE f.tenant_id = ? AND f.reported_at BETWEEN ? AND ?`, [t, `${from} 00:00:00`, `${to} 23:59:59`]);
  const zones = new Map();
  const weeks = new Map();
  const times = [];
  let onTime = 0; let late = 0; let open = 0; let openLate = 0;
  for (const f of list) {
    const due = dt(f.due_at); const got = dt(f.collected_at);
    let state;
    if (got) { if (got <= due) { onTime += 1; state = 'on_time'; } else { late += 1; state = 'late'; } times.push(hoursBetween(dt(f.reported_at), got)); } else if (due < now) { openLate += 1; state = 'open_late'; } else { open += 1; state = 'open'; }
    const z = f.street_id ? await C.zoneFor(pool, t, { streetId: Number(f.street_id), houseNo: f.house_number }) : null;
    const zk = z && z.zoneName ? z.zoneName : 'No zone';
    const wk = mondayOf(dt(f.reported_at).slice(0, 10));
    for (const [m, k] of [[zones, zk], [weeks, wk]]) { const x = m.get(k) || { key: k, missed: 0, on_time: 0, late: 0, open: 0 }; x.missed += 1; if (state === 'on_time') x.on_time += 1; else if (state === 'late' || state === 'open_late') x.late += 1; else x.open += 1; m.set(k, x); }
  }
  const c = await contractOf(pool, t, from);
  const missedLate = late + openLate;
  const out = {
    month, from, to, contract: contractShape(c, mgr), missed: list.length, collected: onTime + late, on_time: onTime, late, open, open_late: openLate,
    on_time_rate: onTime + late + openLate ? Math.round((onTime / (onTime + late + openLate)) * 1000) / 10 : null,
    hours_to_collect: times.length ? { average: r2(times.reduce((a, b) => a + b, 0) / times.length), longest: r2(Math.max(...times)) } : null,
    by_zone: [...zones.values()].map((x) => ({ zone: x.key, ...x, key: undefined })).sort((a, b) => b.missed - a.missed),
    by_week: [...weeks.values()].map((x) => ({ week_of: x.key, ...x, key: undefined })).sort((a, b) => a.week_of.localeCompare(b.week_of)),
  };
  // Complaints by kind: the month's trash and recycling requests by category.
  out.complaints = (await rows(pool, `SELECT rc.name AS kind, COUNT(*) AS c FROM requests q JOIN request_categories rc ON rc.tenant_id = q.tenant_id AND rc.id = q.category_id
    WHERE q.tenant_id = ? AND q.reported_at BETWEEN ? AND ? AND (rc.name LIKE 'Missed%' OR rc.name LIKE '%cart%' OR rc.name LIKE '%trash%' OR rc.name LIKE '%recycl%' OR rc.name LIKE '%bulk%') GROUP BY rc.name ORDER BY c DESC`, [t, `${from} 00:00:00`, `${to} 23:59:59`])).map((x) => ({ kind: x.kind, count: n(x.c) }));
  if (mgr && c) {
    const counted = Math.max(0, missedLate - Number(c.penalty_after || 0));
    out.penalties = { late: missedLate, free: Number(c.penalty_after || 0), counted, per_late_cents: c.penalty_cents === null ? null : Number(c.penalty_cents), total_cents: c.penalty_cents === null ? null : counted * Number(c.penalty_cents) };
    out.contract_month_cents = c.price_per_household_cents !== null && c.households !== null ? Math.round((Number(c.price_per_household_cents) * Number(c.households)) / 12) : null;
  }
  return out;
}

module.exports = {
  C, REASONS, stopWords, covers, ensureRoutes, dayView, routeView, start, addPhoto, mark, setCrew, finish, logTruckHours, changeover, saveTrucks, trucks, pretripOf,
  addGoback, cancelGoback, gobacksWaiting, gobackList, routeCheck, declareSnowDay, undoSnowDay, snowDays, settingsOf, board, costs, todayCards,
  contractOf, contractShape, saveContract, forward, forwardDue, haulerView, haulerCollected, markCollected, forwardsList, scorecard, addonOn, dayWords, nextRunDay, hash, TOKEN_DAYS,
};
