'use strict';

// The public "try it" door. POST /api/v1/trial makes a private demo mountain for one visitor, fills it with made-up data, and signs them in.
// The mountain removes itself after SANDBOX_DAYS (default 7). See src/lib/sandbox.js for the guard rails.
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, tx, rows } = require('../db');
const { z, validate } = require('../lib/util');
const { AppError, bad } = require('../lib/errors');
const { signToken } = require('../middleware/auth');
const M = require('../lib/modules');
const S = require('../lib/sandbox');

const router = express.Router();
const SEED = path.join(__dirname, '..', '..', 'db', 'demo.js');
const MAX_BUILDING = 3;
let building = 0;

const clean = (s) => String(s).replace(/[\u0000-\u001f<>]/g, '').trim();

/** Fills a new demo mountain by running the same loader an operator would run by hand. */
function seed(slug) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SEED, slug], { timeout: 170_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, STAGING_GATE: '' } }, (err, _out, errOut) => {
      if (err) { console.error('Demo loader failed for', slug, String(errOut || err.message).slice(0, 400)); return reject(err); }
      return resolve();
    });
  });
}

router.post('/', validate(z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  mountain: z.string().max(80).optional(),
  website: z.string().max(200).optional(), // a hidden field: people leave it empty, scripts fill it in
})), async (req, res) => {
  const b = req.body;
  if (b.website) throw bad('Could not start the demo');
  const name = clean(b.name);
  const mountain = clean(b.mountain || '') || 'Demo Mountain';
  const email = b.email.trim().toLowerCase();
  if (!name) throw bad('Please tell us your name');

  await S.purgeExpired().catch(() => {});
  if (await S.activeCount() >= S.MAX_ACTIVE) throw new AppError(503, 'The demo is full right now. Please try again tomorrow, or ask us for a walkthrough.');
  if (building >= MAX_BUILDING) throw new AppError(503, 'Several demos are being built. Please try again in a minute.');

  // One demo per email: starting again from the same address replaces the old one. Anyone else typing that email gets a
  // new demo and leaves the first one alone (nobody proves they own an email here).
  const ipHash = crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 16);
  for (const r of await rows(pool, 'SELECT DISTINCT tenant_id FROM sandbox_signups WHERE email = ? AND ip_hash = ? AND tenant_id IS NOT NULL', [email, ipHash])) await S.purgeTenant(r.tenant_id).catch(() => {});

  const slug = `try-${crypto.randomBytes(5).toString('hex')}`;
  const password = crypto.randomBytes(15).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  const [first, ...rest] = name.split(/\s+/);
  const created = await tx(async (conn) => {
    const [t] = await conn.query('INSERT INTO tenants (slug, name, timezone, storage_cap_mb, sandbox_expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL ? DAY)', [slug, mountain, 'America/New_York', S.STORAGE_MB, S.DAYS]);
    const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [t.insertId, first.slice(0, 100), (rest.join(' ') || 'Visitor').slice(0, 100), email]);
    const [u] = await conn.query("INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')", [t.insertId, p.insertId, email, require('../lib/usernames').suggestUsername({ first_name: first, last_name: rest.join(' ') || 'Visitor', email }), hash]);
    // A demo shows everything, the paid add-ons included, so a visitor can see what they would be buying.
    for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?)', [t.insertId, k, 1]);
    const [[exp]] = await conn.query('SELECT sandbox_expires_at AS e FROM tenants WHERE id = ?', [t.insertId]);
    return { tenantId: t.insertId, userId: u.insertId, expires: exp.e };
  });

  building += 1;
  try {
    await seed(slug);
  } catch (_) {
    await S.purgeTenant(created.tenantId).catch(() => {});
    throw new AppError(500, 'We could not build your demo. Please try again in a minute.');
  } finally {
    building -= 1;
  }

  // Starting the demo signs them straight in, so that counts as the first sign-in and first use.
  await pool.query('INSERT INTO sandbox_signups (email, name, mountain, tenant_id, expires_at, ip_hash, sign_ins, first_used_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())', [email, name, mountain, created.tenantId, created.expires, ipHash]);
  res.status(201).json({
    token: await signToken({ id: created.userId, tenant_id: created.tenantId, role: 'owner' }, req),
    role: 'owner', tenant: slug, email, password, expires_at: created.expires, mountain,
  });
});

module.exports = router;
