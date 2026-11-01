'use strict';

// The ski school's settings (lib/schoolsettings.js). Mounted at /skischool. Everyone in the school reads them; managers change them.
const express = require('express');
const { pool, tx, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound, forbidden } = require('../lib/errors');
const SA = require('../lib/schoolaccess');
const { audit } = require('../lib/audit');
const S = require('../lib/schoolsettings');
const { list } = require('../lib/levels');

const router = express.Router();

router.get('/settings', requireRole('instructor', 'manager', 'counter'), async (req, res) => {
  res.json({ ...(await S.get(pool, req.auth.tenantId)), levels: { ski: list('ski'), snowboard: list('snowboard') } });
});

router.patch('/settings', SA.school('director'), validate(S.schema), async (req, res) => {
  // How instructors are paid is for owners and managers only (2026.11.11): a ski school director is paid by these
  // settings too, so they cannot change them. A form that sends them back unchanged is fine.
  if (!['owner', 'manager'].includes(req.auth.role)) {
    const now = await S.get(pool, req.auth.tenantId);
    const changed = S.PAY_FIELDS.filter((k) => req.body[k] !== undefined && String(req.body[k]) !== String(now[k]));
    if (changed.length) throw forbidden('Only an owner or manager can change how instructors are paid');
  }
  await tx(async (conn) => {
    await S.save(conn, req.auth.tenantId, req.body);
    await audit(conn, req, 'update', 'school_settings', req.auth.tenantId, req.body);
  });
  res.json(await S.get(pool, req.auth.tenantId));
});

// ---------------------------------------------------------------- school access level (2026.11.9)
// A person's ski school access: Instructor, Supervisor or Director (lib/schoolaccess.js). Only owners and managers see or
// set it (the staff page, Ski school section). It takes effect on the person's next request; a Director without two-step
// sign-in is asked to set it up before anything else (middleware/auth.js mfaRule, tier school_director).
async function accessOf(db, tenantId, staffId) {
  const st = await one(db, `SELECT st.id, st.status, ip.school_access, ip.staff_id IS NOT NULL AS has_profile,
      (SELECT u.id FROM users u WHERE u.tenant_id = st.tenant_id AND u.staff_id = st.id AND u.active = 1 ORDER BY u.role = 'instructor' DESC, u.id LIMIT 1) AS user_id,
      (SELECT u.role FROM users u WHERE u.tenant_id = st.tenant_id AND u.staff_id = st.id AND u.active = 1 ORDER BY u.role = 'instructor' DESC, u.id LIMIT 1) AS login_role,
      EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = st.tenant_id AND u.staff_id = st.id AND u.active = 1 AND (u.totp_enabled = 1 OR EXISTS (SELECT 1 FROM user_passkeys k WHERE k.user_id = u.id))) AS strong
    FROM staff st LEFT JOIN instructor_profiles ip ON ip.tenant_id = st.tenant_id AND ip.staff_id = st.id WHERE st.tenant_id = ? AND st.id = ?`, [tenantId, staffId]);
  if (!st) throw notFound('Staff member');
  return {
    staff_id: st.id, level: st.school_access || 'instructor', levels: SA.LEVELS.map((k) => ({ key: k, label: SA.LABEL[k] })),
    login_role: st.login_role || null, // the level applies to an instructor login; owners and managers can do everything anyway
    two_step: Boolean(Number(st.strong)), has_profile: Boolean(Number(st.has_profile)),
  };
}

router.get('/access/:id', requireRole('manager'), async (req, res) => res.json(await accessOf(pool, req.auth.tenantId, paramId(req))));

router.put('/access/:id', requireRole('manager'), validate(z.object({ level: z.enum(SA.LEVELS) })), async (req, res) => {
  const { tenantId } = req.auth;
  const staffId = paramId(req);
  await tx(async (conn) => {
    const before = await accessOf(conn, tenantId, staffId);
    // Creates the teaching profile when there is none yet (nothing taught set; the director fills that in Who teaches what).
    await conn.query(`INSERT INTO instructor_profiles (tenant_id, staff_id, is_public, school_access) VALUES (?, ?, 0, ?)
      ON DUPLICATE KEY UPDATE school_access = VALUES(school_access)`, [tenantId, staffId, req.body.level]);
    await audit(conn, req, 'school_access', 'instructor_profiles', staffId, { from: before.level, to: req.body.level });
  });
  res.json(await accessOf(pool, tenantId, staffId));
});

module.exports = router;
