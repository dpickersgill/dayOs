'use strict';

// The bulk pickup driving order (release 2026.11.20). A manager sets, for each collection weekday, the order the truck
// drives the streets and, for each street, whether house numbers go up or down. The day's stop list (routes/bulkpickup.js
// GET /day) follows it: streets in the route's order, then any street not in the route yet at the end, in name order, with
// a note so the manager adds it; on each street the house numbers in the street's direction.
const { rows } = require('../db');

/** The route for a weekday: [{ street_id, name, position, direction }] in driving order. */
async function routeOf(db, tenantId, weekday) {
  return (await rows(db, `SELECT r.street_id, s.name, r.position, r.direction FROM bulk_route_order r JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id
    WHERE r.tenant_id = ? AND r.weekday = ? ORDER BY r.position, s.name`, [tenantId, weekday])).map((r) => ({ street_id: Number(r.street_id), name: r.name, position: Number(r.position), direction: r.direction }));
}

const numOf = (s) => { const m = /^\s*(\d{1,7})/.exec(String(s || '')); return m ? Number(m[1]) : null; };

/**
 * Puts the day's stops (rows with street_id, street, house_number, unit, id) in driving order for that weekday.
 * Returns { stops, routed, new_streets: [names not in the route] }. With no route set, the order is by street name.
 */
async function order(db, tenantId, weekday, stops) {
  const route = await routeOf(db, tenantId, weekday);
  const pos = new Map(route.map((r, i) => [r.street_id, { i, dir: r.direction }]));
  const byNum = (a, b, dir) => {
    const x = numOf(a.house_number); const y = numOf(b.house_number);
    if (x === null && y === null) return String(a.house_number || '').localeCompare(String(b.house_number || '')) || String(a.unit || '').localeCompare(String(b.unit || '')) || a.id - b.id;
    if (x === null) return 1;
    if (y === null) return -1;
    return (dir === 'down' ? y - x : x - y) || String(a.house_number).localeCompare(String(b.house_number)) || String(a.unit || '').localeCompare(String(b.unit || '')) || a.id - b.id;
  };
  const sorted = [...stops].sort((a, b) => {
    const pa = pos.get(Number(a.street_id)); const pb = pos.get(Number(b.street_id));
    if (pa && pb && pa.i !== pb.i) return pa.i - pb.i;
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    if (!pa && !pb && a.street !== b.street) return String(a.street).localeCompare(String(b.street));
    return byNum(a, b, pa ? pa.dir : 'up');
  });
  const newStreets = route.length ? [...new Set(stops.filter((s) => !pos.has(Number(s.street_id))).map((s) => s.street))].sort() : [];
  return { stops: sorted, routed: route.length > 0, new_streets: newStreets };
}

module.exports = { routeOf, order };
