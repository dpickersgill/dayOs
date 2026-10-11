'use strict';

// The injury network, from a mountain's side (mounted under /patrol, so it follows the Patrol app):
// whether the mountain shares de-identified injury counts, who agreed and when, and how its own season compares with
// the other mountains that share. Only the patrol director level (patrol admin, owner or manager) can turn sharing on
// or off. Anyone with patrol Reports can see the comparison.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, todayIn } = require('../lib/util');
const { bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const PA = require('../lib/patrolaccess');
const S = require('../lib/safety');

const router = express.Router();
const patrol = requireRole('patrol', 'manager');
const needs = (feature, message) => PA.needs(pool, feature, message);
const director = async (req, _res, next) => {
  try {
    if ((await PA.levelOf(pool, req)) !== 'admin') throw forbidden('Only the patrol director, the owner or a manager can change injury network sharing');
    next();
  } catch (err) { next(err); }
};

router.get('/network', patrol, needs('reports'), async (req, res) => {
  const { tenantId } = req.auth;
  const [sharing, log, inNetwork] = await Promise.all([
    S.sharingOf(pool, tenantId),
    rows(pool, 'SELECT share, named, region, state, agreement_version, by_name, by_title, at FROM safety_sharing_log WHERE tenant_id = ? ORDER BY at DESC, id DESC LIMIT 20', [tenantId]),
    S.members(pool),
  ]);
  res.json({
    sharing,
    agreement_version: S.AGREEMENT_VERSION,
    regions: S.REGIONS.map(([value, label]) => ({ value, label })),
    network_mountains: inNetwork.length,
    min_mountains: S.MIN_MOUNTAINS,
    can_change: (await PA.levelOf(pool, req)) === 'admin',
    history: log.map((l) => ({ ...l, share: Boolean(l.share), named: Boolean(l.named) })),
  });
});

router.put('/network/sharing', patrol, director, validate(z.object({
  share: z.boolean(),
  named: z.boolean().default(false),
  region: z.enum(S.REGION_KEYS).nullable().optional(),
  state: z.string().trim().max(40).nullable().optional(),
  agree: z.boolean().optional(),
  signer_name: z.string().trim().max(100).optional(),
  signer_title: z.string().trim().max(100).optional(),
})), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const b = req.body;
  const t = await one(pool, 'SELECT sandbox_expires_at FROM tenants WHERE id = ?', [tenantId]);
  if (b.share && t.sandbox_expires_at) throw forbidden('A demo mountain cannot join the injury network');
  if (b.share) {
    if (!b.agree) throw bad('Tick the box to agree to the data-sharing terms');
    if (!b.signer_name) throw bad('Type your name');
    if (!b.signer_title) throw bad('Type your title, for example Patrol director');
    if (!b.region) throw bad('Choose your region');
  }
  const named = b.share && b.named ? 1 : 0;
  await tx(async (conn) => {
    const before = await one(conn, 'SELECT * FROM safety_sharing WHERE tenant_id = ? FOR UPDATE', [tenantId]);
    // Turning sharing off keeps the last agreement on file, so the history shows what was agreed; the share flag is what counts.
    const agreed = b.share
      ? [S.AGREEMENT_VERSION, userId, b.signer_name, b.signer_title]
      : [before ? before.agreement_version : null, before ? before.agreed_by : null, before ? before.agreed_name : null, before ? before.agreed_title : null];
    const region = b.region !== undefined ? b.region : (before ? before.region : null);
    const state = b.state !== undefined ? (b.state || null) : (before ? before.state : null);
    await conn.query(
      `INSERT INTO safety_sharing (tenant_id, share, named, region, state, agreement_version, agreed_by, agreed_name, agreed_title, agreed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${b.share ? 'UTC_TIMESTAMP()' : 'NULL'})
       ON DUPLICATE KEY UPDATE share = VALUES(share), named = VALUES(named), region = VALUES(region), state = VALUES(state),
         agreement_version = VALUES(agreement_version), agreed_by = VALUES(agreed_by), agreed_name = VALUES(agreed_name),
         agreed_title = VALUES(agreed_title), agreed_at = ${b.share ? 'UTC_TIMESTAMP()' : 'agreed_at'}`,
      [tenantId, b.share ? 1 : 0, named, region, state, ...agreed]);
    const who = b.share ? [b.signer_name, b.signer_title] : [await nameOf(conn, req), null];
    await conn.query('INSERT INTO safety_sharing_log (tenant_id, share, named, region, state, agreement_version, by_user, by_name, by_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId, b.share ? 1 : 0, named, region, state, b.share ? S.AGREEMENT_VERSION : null, userId, ...who]);
    await audit(conn, req, b.share ? 'injury_network_share' : 'injury_network_stop', 'tenant', tenantId, { named: Boolean(named), region });
  });
  res.json({ sharing: await S.sharingOf(pool, tenantId) });
});

async function nameOf(conn, req) {
  const u = await one(conn, 'SELECT u.email, COALESCE(p.first_name, sp.first_name) AS first_name, COALESCE(p.last_name, sp.last_name) AS last_name FROM users u LEFT JOIN people p ON p.id = u.person_id AND p.tenant_id = u.tenant_id LEFT JOIN staff s ON s.id = u.staff_id AND s.tenant_id = u.tenant_id LEFT JOIN people sp ON sp.id = s.person_id AND sp.tenant_id = s.tenant_id WHERE u.id = ? AND u.tenant_id = ?', [req.auth.userId, req.auth.tenantId]);
  if (!u) return null;
  return u.first_name ? `${u.first_name} ${u.last_name}`.trim() : u.email;
}

router.get('/network/benchmark', patrol, needs('reports'), async (req, res) => {
  const { tenantId } = req.auth;
  const t = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  const period = S.periodOf({ season: req.query.season ? String(req.query.season) : null }, todayIn(t.timezone));
  if (!period) throw bad('Use a season like 2026-27');
  res.json(await S.benchmark(pool, tenantId, { period }));
});

module.exports = router;
