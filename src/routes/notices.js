'use strict';
// Notes a person has dismissed, kept per login so a dismissed note stays gone on every device (feat/school-pay).
// Used by the "Setup for this app moved to Settings" note (public/js/main.js). Mounted at /notices.
const express = require('express');
const { pool, rows } = require('../db');
const { validate, z } = require('../lib/util');

const router = express.Router();
const KEY = /^[a-z0-9_.:-]{1,60}$/;

router.get('/', async (req, res) => {
  const list = await rows(pool, 'SELECT notice_key FROM user_notices WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, req.auth.userId]);
  res.set('Cache-Control', 'no-store');
  res.json({ dismissed: list.map((r) => r.notice_key) });
});
router.post('/dismiss', validate(z.object({ key: z.string().regex(KEY) })), async (req, res) => {
  await pool.query('INSERT IGNORE INTO user_notices (tenant_id, user_id, notice_key) VALUES (?, ?, ?)', [req.auth.tenantId, req.auth.userId, req.body.key]);
  res.json({ ok: true });
});

module.exports = router;
