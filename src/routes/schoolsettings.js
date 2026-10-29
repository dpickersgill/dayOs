'use strict';

// The ski school's settings (lib/schoolsettings.js). Mounted at /skischool. Everyone in the school reads them; managers change them.
const express = require('express');
const { pool, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { validate } = require('../lib/util');
const { audit } = require('../lib/audit');
const S = require('../lib/schoolsettings');
const { list } = require('../lib/levels');

const router = express.Router();

router.get('/settings', requireRole('instructor', 'manager', 'counter'), async (req, res) => {
  res.json({ ...(await S.get(pool, req.auth.tenantId)), levels: { ski: list('ski'), snowboard: list('snowboard') } });
});

router.patch('/settings', requireRole('manager'), validate(S.schema), async (req, res) => {
  await tx(async (conn) => {
    await S.save(conn, req.auth.tenantId, req.body);
    await audit(conn, req, 'update', 'school_settings', req.auth.tenantId, req.body);
  });
  res.json(await S.get(pool, req.auth.tenantId));
});

module.exports = router;
