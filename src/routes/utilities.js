'use strict';

// The Water, Sewer and Stormwater add-ons' Today cards (muni release 1, lib/today.js): open work orders on the system's
// map items, and its items at high risk or worse. Everything else of theirs lives in Assets and fleet (the map, its
// inspections and programs). Mounted at /water, /sewer and /stormwater, so each card shows only with its add-on on.
const express = require('express');
const { pool, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { card, todayRoute } = require('../lib/today');
const MF = require('../lib/mapfeatures');

// [path, words, the systems its map items are drawn in for a municipality]
const GROUPS = [['water', 'Water', ['potable']], ['sewer', 'Sewer', ['sewer']], ['stormwater', 'Stormwater', ['storm', 'drainage']]];

function routerFor([key, words, systems]) {
  const router = express.Router();
  router.use(requireRole('staff', 'manager'));
  const kinds = MF.KINDS.filter((k) => systems.includes(MF.systemFor(k, 'municipality'))).map((k) => k.key);
  router.get('/today', todayRoute(async (req) => {
    const t = req.auth.tenantId;
    const c = await one(pool, `SELECT
        (SELECT COUNT(*) FROM work_orders w JOIN map_features f ON f.tenant_id = w.tenant_id AND f.id = w.map_feature_id
          WHERE w.tenant_id = ? AND w.status NOT IN ('done','cancelled') AND f.kind IN (?)) AS open_n,
        (SELECT COUNT(*) FROM work_orders w JOIN map_features f ON f.tenant_id = w.tenant_id AND f.id = w.map_feature_id
          WHERE w.tenant_id = ? AND w.status NOT IN ('done','cancelled') AND w.priority = 'urgent' AND f.kind IN (?)) AS urgent,
        (SELECT COUNT(*) FROM map_features f WHERE f.tenant_id = ? AND f.kind IN (?) AND f.status <> 'abandoned' AND f.condition_score * f.criticality >= ?) AS risky`,
    [t, kinds, t, kinds, t, kinds, MF.RISK_MIN.high]);
    const n = (v) => Number(v || 0);
    return [
      n(c.open_n) ? card({ title: `${words} work orders`, count: n(c.open_n), text: n(c.urgent) ? `${n(c.urgent)} urgent` : 'Open on the map\'s items, none urgent', href: '#/works' }) : null,
      n(c.risky) ? card({ title: `${words}: high risk`, count: n(c.risky), text: 'Map items at high or very high risk (condition times criticality)', href: '#/assets?tab=overview' }) : null,
    ];
  }));
  return router;
}

module.exports = Object.fromEntries(GROUPS.map((g) => [g[0], routerFor(g)]));
