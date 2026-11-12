'use strict';

// The bulk pickup driving order (release 2026.11.20, lib/bulkroute.js). Mounted at /api/v1/solid-waste ahead of
// routes/bulkpickup.js, so it is part of Trash and recycling.
//   GET /route?weekday=0..6   the route for a collection weekday: the streets in driving order with their house number
//                             direction, then the active streets not in it yet (everyone who sees bulk pickup)
//   PUT /route                { weekday, streets: [{ street_id, direction: 'up'|'down' }] } in driving order (managers)
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { bad, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const BR = require('../lib/bulkroute');

const router = express.Router();
const anyone = requireRole('manager', 'counter', 'staff');
const managers = requireRole('manager');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

router.get('/route', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const s = await one(pool, 'SELECT collection_days FROM bulk_settings WHERE tenant_id = ?', [t]);
  const days = String((s && s.collection_days) || '1').split(',').filter((x) => /^[0-6]$/.test(x)).map(Number).sort();
  const asked = Number(req.query.weekday);
  const weekday = Number.isInteger(asked) && asked >= 0 && asked <= 6 ? asked : days[0] ?? 1;
  const route = await BR.routeOf(pool, t, weekday);
  const inRoute = new Set(route.map((r) => r.street_id));
  // How many stops each street had on this weekday in the last year, so the manager sees which streets matter.
  const counts = new Map((await rows(pool, `SELECT street_id, COUNT(*) AS n FROM bulk_bookings WHERE tenant_id = ? AND status = 'booked' AND collection_date >= CURDATE() - INTERVAL 1 YEAR AND DAYOFWEEK(collection_date) - 1 = ? GROUP BY street_id`, [t, weekday]))
    .map((r) => [Number(r.street_id), Number(r.n)]));
  const others = (await rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t])).filter((x) => !inRoute.has(Number(x.id)))
    .map((x) => ({ street_id: Number(x.id), name: x.name, stops_last_year: counts.get(Number(x.id)) || 0 }));
  res.json({ weekday, weekday_name: DAYS[weekday], collection_days: days.map((d) => ({ weekday: d, name: DAYS[d] })),
    route: route.map((r) => ({ ...r, stops_last_year: counts.get(r.street_id) || 0 })), not_in_route: others, can_edit: ['owner', 'manager'].includes(req.auth.role) });
});

router.put('/route', managers, validate(z.object({
  weekday: z.number().int().min(0).max(6),
  streets: z.array(z.object({ street_id: z.number().int().positive(), direction: z.enum(['up', 'down']).default('up') })).max(2000),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const ids = b.streets.map((s) => s.street_id);
  if (new Set(ids).size !== ids.length) throw bad('A street is in the route twice');
  await tx(async (conn) => {
    if (ids.length) {
      const found = await rows(conn, 'SELECT id FROM streets WHERE tenant_id = ? AND id IN (?)', [t, ids]);
      if (found.length !== ids.length) throw notFound('Street');
    }
    await conn.query('DELETE FROM bulk_route_order WHERE tenant_id = ? AND weekday = ?', [t, b.weekday]);
    for (const [i, s] of b.streets.entries()) {
      await conn.query('INSERT INTO bulk_route_order (tenant_id, weekday, street_id, position, direction, updated_by) VALUES (?, ?, ?, ?, ?, ?)', [t, b.weekday, s.street_id, i + 1, s.direction, req.auth.userId || null]);
    }
    await audit(conn, req, 'route_order', 'bulk_route_order', b.weekday, { weekday: b.weekday, streets: ids.length });
  });
  res.json({ ok: true });
});

module.exports = router;
