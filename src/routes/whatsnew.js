'use strict';

// Help > What's new: the release notes this person would care about (their role, their mountain's apps), how many
// are new since they last looked (the quiet badge on Help), and marking them seen.
const express = require('express');
const { pool, one } = require('../db');
const moduleGate = require('../lib/modules');
const V = require('../lib/version');

const router = express.Router();

async function viewerOf(req) {
  const u = await one(pool, 'SELECT role, seen_version FROM users WHERE id = ? AND tenant_id = ?', [req.auth.userId, req.auth.tenantId]);
  return { role: u ? u.role : req.auth.role, seen: u ? u.seen_version : null, modules: await moduleGate.enabledKeys(req.auth.tenantId) };
}

router.get('/', async (req, res) => {
  const v = await viewerOf(req);
  const releases = V.releasesFor(v).filter((r) => V.compare(r.version, V.VERSION) <= 0);
  res.json({ version: V.VERSION, build: V.BUILD, seen: v.seen, unseen: V.unseenCount(releases, v.seen), releases });
});

/** Just the count, for the badge: checked when the app opens. */
router.get('/count', async (req, res) => {
  const v = await viewerOf(req);
  const releases = V.releasesFor(v).filter((r) => V.compare(r.version, V.VERSION) <= 0);
  res.json({ version: V.VERSION, unseen: V.unseenCount(releases, v.seen) });
});

router.post('/seen', async (req, res) => {
  await pool.query('UPDATE users SET seen_version = ? WHERE id = ? AND tenant_id = ?', [V.VERSION, req.auth.userId, req.auth.tenantId]);
  res.json({ ok: true, seen: V.VERSION });
});

module.exports = router;
