'use strict';
// Guest settings (lib/guestsettings.js) and the guest stubs for the round 2 tracks. Mounted at /guests (module sell).
// router: staff. publicRouter: under /public (no sign-in). tick(): every 5 minutes; daily(): once a day.
const express = require('express');
const { pool, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { validate } = require('../lib/util');
const { audit } = require('../lib/audit');
const G = require('../lib/guestsettings');

const router = express.Router();
router.get('/settings', requireRole('counter', 'manager', 'staff', 'instructor'), async (req, res) => res.json(await G.get(pool, req.auth.tenantId)));
router.patch('/settings', requireRole('manager'), validate(G.schema), async (req, res) => {
  await tx(async (conn) => { await G.save(conn, req.auth.tenantId, req.body); await audit(conn, req, 'update', 'guest_settings', req.auth.tenantId, req.body); });
  res.json(await G.get(pool, req.auth.tenantId));
});

module.exports = { router };
