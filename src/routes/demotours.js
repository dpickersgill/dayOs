'use strict';

// Guided tours in a demo mountain: the browser reports how far the visitor got in each tour, so the platform's Demos
// dashboard can show which tours people take and finish. Only demo mountains record anything; elsewhere it is a no-op.
const express = require('express');
const { pool, one } = require('../db');
const { z, validate } = require('../lib/util');

const router = express.Router();
const TOURS = ['morning', 'sell', 'gate', 'patrol', 'staff', 'assets', 'waivers'];

router.post('/', validate(z.object({
  tour: z.enum(TOURS),
  step: z.number().int().min(1).max(50),
  total: z.number().int().min(1).max(50),
  done: z.boolean().default(false),
})), async (req, res) => {
  const s = await one(pool, `SELECT s.id FROM sandbox_signups s JOIN tenants t ON t.id = s.tenant_id
    WHERE s.tenant_id = ? AND t.sandbox_expires_at IS NOT NULL ORDER BY s.id DESC LIMIT 1`, [req.auth.tenantId]);
  if (!s) { res.status(204).end(); return; }
  const { tour, step, total, done } = req.body;
  await pool.query(`INSERT INTO sandbox_tours (signup_id, tour, steps_seen, steps_total, started_at, finished_at)
      VALUES (?, ?, ?, ?, UTC_TIMESTAMP(), ${done ? 'UTC_TIMESTAMP()' : 'NULL'})
    ON DUPLICATE KEY UPDATE steps_seen = GREATEST(steps_seen, VALUES(steps_seen)), steps_total = VALUES(steps_total),
      finished_at = COALESCE(finished_at, VALUES(finished_at))`, [s.id, tour, Math.min(step, total), total]);
  res.status(204).end();
});

module.exports = { router, TOURS };
