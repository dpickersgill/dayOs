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
const config = require('../config');
const mailer = require('../lib/mailer');
const demoMail = require('../lib/demomail');
const { baseUrl } = require('../lib/baseurl');
const skiArea = require('../lib/skiarea');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();
const SEED = path.join(__dirname, '..', '..', 'db', 'demo.js');
const MAX_BUILDING = 3;
let building = 0;

const clean = (s) => String(s).replace(/[\u0000-\u001f<>]/g, '').trim();

// ---------------------------------------------------------------- the email check
// Before a demo is built, a 6-digit code is emailed to the address given, and the demo only builds once it is typed in,
// so every demo lead is a real, reachable address. On in production (and staging) whenever email is set up;
// TRY_EMAIL_CHECK=on or off overrides that. Throwaway inboxes are turned away either way.
const CODE_MINUTES = 15;
const MAX_TRIES = 5; // wrong codes before that code stops working
const MAX_CODES_PER_HOUR = 5; // per email address
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com',
  'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email',
  'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'tempinbox.com',
  'spamgourmet.com', 'mailnesia.com', 'burnermail.io', 'mail.tm', 'inboxkitten.com', 'moakt.com', 'tmpmail.org']);
const throwaway = (email) => DISPOSABLE.has(String(email).split('@').pop().toLowerCase());
const THROWAWAY = 'Please use your work or personal email. Throwaway inboxes cannot start a demo.';
function emailCheck() {
  const v = process.env.TRY_EMAIL_CHECK;
  if (v === 'off') return false;
  if (v === 'on') return mailer.enabled();
  return config.isProd && mailer.enabled();
}
const codeHash = (email, code) => crypto.createHmac('sha256', config.linkSecret).update(`try:${email}:${code}`).digest('hex');
const sameHash = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ipHashOf = (req) => crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 16);

/** Step 1 when the email check is on: emails a 6-digit code. Answers { required: false } when the check is off. */
router.post('/code', validate(z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  mountain: z.string().max(80).optional(),
  website: z.string().max(200).optional(),
})), async (req, res) => {
  const b = req.body;
  if (b.website) throw bad('Could not start the demo');
  const email = b.email.trim().toLowerCase();
  if (throwaway(email)) throw bad(THROWAWAY);
  if (!emailCheck()) return res.json({ required: false });
  await pool.query('DELETE FROM sandbox_codes WHERE created_at < NOW() - INTERVAL 1 DAY').catch(() => {}); // codes are kept a day at most
  const [[recent]] = await pool.query('SELECT COUNT(*) AS n FROM sandbox_codes WHERE email = ? AND created_at > NOW() - INTERVAL 1 HOUR', [email]);
  if (Number(recent.n) >= MAX_CODES_PER_HOUR) throw new AppError(429, 'Too many codes sent to that address. Try again in an hour, or ask us for a walkthrough.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query('UPDATE sandbox_codes SET expires_at = NOW() WHERE email = ? AND used_at IS NULL AND expires_at > NOW()', [email]); // only the newest code works
  const [ins] = await pool.query('INSERT INTO sandbox_codes (email, code_hash, ip_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)', [email, codeHash(email, code), ipHashOf(req), CODE_MINUTES]);
  const first = clean(b.name).split(/\s+/)[0] || 'there';
  const sent = await mailer.sendPlatform({ to: email, tag: 'try-code', subject: `Your Verdynt/OS demo code: ${code}`,
    text: `Hello ${first},\n\nYour code to start your Verdynt/OS demo mountain is:\n\n    ${code}\n\nType it on the demo page. It works for ${CODE_MINUTES} minutes.\n\nIf you did not ask for a demo, you can ignore this email.\n\nVerdynt/OS` });
  if (!sent.ok) {
    await pool.query('DELETE FROM sandbox_codes WHERE id = ?', [ins.insertId]);
    throw new AppError(502, 'We could not send an email to that address. Check it, or try again in a minute.');
  }
  res.json({ required: true, sent: true, minutes: CODE_MINUTES });
});

/** Checks the code for an email and uses it up. Returns the code's id (to give it back if the build fails), or throws. */
async function useCode(email, code) {
  if (!/^\d{6}$/.test(String(code || '').trim())) throw bad('Enter the 6-digit code we emailed you.');
  const row = (await rows(pool, 'SELECT id, code_hash, attempts, used_at, expires_at > NOW() AS live FROM sandbox_codes WHERE email = ? ORDER BY id DESC LIMIT 1', [email]))[0];
  if (!row || row.used_at || !Number(row.live)) throw bad('That code has expired. Send a new one.');
  if (Number(row.attempts) >= MAX_TRIES) throw bad('Too many wrong codes. Send a new one.');
  if (!sameHash(row.code_hash, codeHash(email, String(code).trim()))) {
    await pool.query('UPDATE sandbox_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw bad('That code is not right. Check the email we sent and try again.');
  }
  const [u] = await pool.query('UPDATE sandbox_codes SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [row.id]);
  if (u.affectedRows !== 1) throw bad('That code has already been used. Send a new one.');
  return row.id;
}

// ---------------------------------------------------------------- your own mountain
// "Is this you?": the visitor types their mountain's name and state, we look it up on OpenStreetMap, show the matches, and
// for the one they pick, its lifts and runs as a small drawing. The demo is then built on those lifts and runs.
const mapLimit = rateLimit({ windowMs: 600_000, max: Number(process.env.TRY_MAP_LIMIT) || 30, message: 'Too many map lookups from this address. Try again in a few minutes, or start with a sample mountain.' });
const STATE = z.enum(Object.keys(skiArea.STATES));
const REF = z.string().regex(/^(way|relation)\/\d{1,12}$/);

router.post('/find', mapLimit, validate(z.object({ mountain: z.string().trim().min(2).max(80), state: STATE })), async (req, res) => {
  try {
    res.json({ data: await skiArea.find(clean(req.body.mountain), req.body.state), credit: '\u00a9 OpenStreetMap contributors' });
  } catch (e) {
    if (e.unavailable) return res.json({ data: [], unavailable: true });
    throw bad(e.message);
  }
});

router.post('/area', mapLimit, validate(z.object({ ref: REF, state: STATE })), async (req, res) => {
  let d;
  try { d = await skiArea.details(req.body.ref, req.body.state); } catch (e) { if (e.unavailable) throw new AppError(503, 'The map service is not answering right now. Try again, or start with a sample mountain.'); throw e; }
  if (!d) throw new AppError(404, 'That ski area was not found on the map');
  const { preview, lifts, trails, ...rest } = d;
  res.json({ ...rest, lifts: lifts.map((l) => l.name), trails: trails.map((t) => ({ name: t.name, difficulty: t.difficulty })), preview, usable: lifts.length + trails.length >= 3, credit: '\u00a9 OpenStreetMap contributors' });
});

/** Fills a new demo mountain by running the same loader an operator would run by hand (with the real mountain's lifts and runs, when chosen). */
function seed(slug, area) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SEED, slug], { timeout: 170_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, STAGING_GATE: '', DEMO_AREA: area ? JSON.stringify(skiArea.forLoader(area)) : '' } }, (err, _out, errOut) => {
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
  code: z.string().max(12).optional(), // the emailed code, when the email check is on
  area_ref: REF.optional(), // the real ski area they picked on the map ("Is this you?")
  state: STATE.optional(),
})), async (req, res) => {
  const b = req.body;
  if (b.website) throw bad('Could not start the demo');
  const name = clean(b.name);
  // Their own mountain, when they picked one on the map. A lookup that fails now falls back to the sample mountain.
  let area = null;
  if (b.area_ref && b.state) {
    area = await skiArea.details(b.area_ref, b.state).catch(() => null);
    if (area && area.lifts.length + area.trails.length < 3) area = null;
  }
  const mountain = (area && area.name) || clean(b.mountain || '') || 'Demo Mountain';
  const email = b.email.trim().toLowerCase();
  if (!name) throw bad('Please tell us your name');
  if (throwaway(email)) throw bad(THROWAWAY);
  const codeId = emailCheck() ? await useCode(email, b.code) : null;
  const giveBack = () => (codeId ? pool.query('UPDATE sandbox_codes SET used_at = NULL WHERE id = ?', [codeId]).catch(() => {}) : null);

  await S.purgeExpired().catch(() => {});
  if (await S.activeCount() >= S.MAX_ACTIVE) { await giveBack(); throw new AppError(503, 'The demo is full right now. Please try again tomorrow, or ask us for a walkthrough.'); }
  if (building >= MAX_BUILDING) { await giveBack(); throw new AppError(503, 'Several demos are being built. Please try again in a minute.'); }

  // One demo per email: starting again from the same address replaces the old one. Anyone else typing that email gets a
  // new demo and leaves the first one alone (nobody proves they own an email here).
  const ipHash = ipHashOf(req);
  for (const r of await rows(pool, 'SELECT DISTINCT tenant_id FROM sandbox_signups WHERE email = ? AND ip_hash = ? AND tenant_id IS NOT NULL', [email, ipHash])) await S.purgeTenant(r.tenant_id).catch(() => {});

  const slug = `try-${crypto.randomBytes(5).toString('hex')}`;
  const password = crypto.randomBytes(15).toString('base64url');
  const hash = await bcrypt.hash(password, 10);
  const [first, ...rest] = name.split(/\s+/);
  const created = await tx(async (conn) => {
    const [t] = await conn.query('INSERT INTO tenants (slug, name, timezone, storage_cap_mb, sandbox_expires_at, map_lat, map_lng, map_zoom) VALUES (?, ?, ?, ?, NOW() + INTERVAL ? DAY, ?, ?, ?)',
      [slug, mountain, area ? area.timezone : 'America/New_York', S.STORAGE_MB, S.DAYS, area ? area.lat : null, area ? area.lng : null, area ? area.zoom : null]);
    const [p] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, email) VALUES (?, ?, ?, ?)', [t.insertId, first.slice(0, 100), (rest.join(' ') || 'Visitor').slice(0, 100), email]);
    const [u] = await conn.query("INSERT INTO users (tenant_id, person_id, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'owner')", [t.insertId, p.insertId, email, require('../lib/usernames').suggestUsername({ first_name: first, last_name: rest.join(' ') || 'Visitor', email }), hash]);
    // A demo shows everything, the paid add-ons included, so a visitor can see what they would be buying.
    for (const k of M.KEYS) await conn.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, ?)', [t.insertId, k, 1]);
    const [[exp]] = await conn.query('SELECT sandbox_expires_at AS e FROM tenants WHERE id = ?', [t.insertId]);
    return { tenantId: t.insertId, userId: u.insertId, expires: exp.e };
  });

  building += 1;
  try {
    await seed(slug, area);
  } catch (_) {
    await S.purgeTenant(created.tenantId).catch(() => {});
    await giveBack(); // the code still works for another try
    throw new AppError(500, 'We could not build your demo. Please try again in a minute.');
  } finally {
    building -= 1;
  }

  // Starting the demo signs them straight in, so that counts as the first sign-in and first use.
  const [su] = await pool.query('INSERT INTO sandbox_signups (email, name, mountain, tenant_id, expires_at, ip_hash, sign_ins, first_used_at, last_used_at, email_verified, area_ref) VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?, ?)', [email, name, mountain, created.tenantId, created.expires, ipHash, codeId ? 1 : 0, area ? area.ref : null]);
  // The welcome email (a sign-in link, what to try first), from the founder. Sent after the reply so the demo opens at once.
  setImmediate(() => { demoMail.welcome(baseUrl(req), su.insertId).catch(() => {}); });
  res.status(201).json({
    token: await signToken({ id: created.userId, tenant_id: created.tenantId, role: 'owner' }, req),
    role: 'owner', tenant: slug, email, password, expires_at: created.expires, mountain, real_map: Boolean(area),
  });
});

/** The sign-in link from a demo email: signs the visitor into their demo as its owner. */
router.post('/open', validate(z.object({ token: z.string().max(80) })), async (req, res) => {
  const s = await demoMail.signupForToken(req.body.token);
  if (!s) throw new AppError(410, 'This link has expired, or the demo has ended. Start a new demo, or reply to the email and we will help.');
  const [[u]] = await pool.query("SELECT id, tenant_id, role FROM users WHERE tenant_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1", [s.tenant_id]);
  if (!u) throw new AppError(410, 'This demo has no sign-in any more. Start a new demo.');
  await require('../lib/demousage').signedIn(s.tenant_id);
  res.json({ token: await signToken({ id: u.id, tenant_id: u.tenant_id, role: u.role }, req), tenant: s.slug, role: u.role });
});

/** "No more emails about it": the stop link at the foot of every demo email. */
router.post('/stop', validate(z.object({ token: z.string().max(80) })), async (req, res) => {
  if (!(await demoMail.stop(req.body.token))) throw bad('That link is not valid');
  res.json({ ok: true });
});

module.exports = router;
