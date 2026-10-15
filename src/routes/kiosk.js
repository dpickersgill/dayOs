'use strict';

// The time clock kiosk. publicRouter is what a paired tablet calls (no login: the device token is the credential and
// the tenant comes from the device, never from the request). adminRouter is what a manager uses to set it all up.

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, dateTimeStr, validate, paramId, nowIn, todayIn, addDays, dayRange, normDateTime, localTime } = require('../lib/util');
const { AppError, bad, unauthorized, notFound, conflict } = require('../lib/errors');
const { baseUrl } = require('../lib/baseurl');
const K = require('../lib/kiosk');
const { requireModule } = require('../lib/modules');

const MSG_PIN = 'That PIN did not match';
const DUMMY = bcrypt.hashSync('not-a-real-pin', 8);

async function kioskAudit(db, tenantId, action, entityId, detail, userId = null) {
  await db.query('INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, userId, action, 'time_entries', entityId ?? null, JSON.stringify(detail)]);
}

// ================================================================ the tablet
const publicRouter = express.Router();

/** A tablet trades a manager's one-time code for its own long-lived token. The code works once and expires. */
publicRouter.post('/pair', validate(z.object({ code: z.string().min(4).max(20) })), async (req, res) => {
  const d = await one(pool, 'SELECT id, tenant_id, name FROM kiosk_devices WHERE pair_hash = ? AND pair_expires_at > NOW() AND active = 1', [K.pairHash(req.body.code)]);
  if (!d) throw unauthorized('That code did not work. Ask a manager for a new one.');
  const token = K.newDeviceToken();
  const [r] = await pool.query('UPDATE kiosk_devices SET token_hash = ?, pair_hash = NULL, pair_expires_at = NULL, paired_at = NOW(), last_seen_at = NOW() WHERE id = ? AND pair_hash IS NOT NULL', [K.tokenHash(token), d.id]);
  if (!r.affectedRows) throw unauthorized('That code did not work. Ask a manager for a new one.');
  await requireModule(d.tenant_id, 'workforce');
  const t = await K.tenantOf(pool, d.tenant_id);
  res.json({ token, device: { id: d.id, name: d.name }, mountain: { name: t.name, slug: t.slug } });
});

async function deviceAuth(req, _res, next) {
  const token = String(req.get('x-kiosk-token') || '');
  const d = token ? await one(pool, 'SELECT id, tenant_id FROM kiosk_devices WHERE token_hash = ? AND active = 1', [K.tokenHash(token)]) : null;
  if (!d) { const e = unauthorized('This tablet is not set up. Ask a manager for a pairing code.'); e.details = { code: 'kiosk_unpaired' }; return next(e); }
  await requireModule(d.tenant_id, 'workforce');
  req.kiosk = { tenantId: d.tenant_id, deviceId: d.id };
  await pool.query('UPDATE kiosk_devices SET last_seen_at = NOW() WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < DATE_SUB(NOW(), INTERVAL 1 MINUTE))', [d.id]);
  return next();
}
publicRouter.use((req, res, next) => deviceAuth(req, res, next).catch(next));

/** Who is on the screen: first name and last initial, with whether they are in. Only people with a PIN appear. */
publicRouter.get('/roster', async (req, res) => {
  const { tenantId } = req.kiosk;
  const t = await K.tenantOf(pool, tenantId);
  const data = await rows(pool,
    `SELECT s.id, p.first_name, p.last_name, MAX(te.id IS NOT NULL) AS clocked_in
       FROM kiosk_credentials c
       JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.staff_id AND s.status = 'active'
       JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
       LEFT JOIN time_entries te ON te.tenant_id = s.tenant_id AND te.staff_id = s.id AND te.clock_out IS NULL
      WHERE c.tenant_id = ? AND c.pin_hash IS NOT NULL
      GROUP BY s.id, p.first_name, p.last_name
      ORDER BY p.first_name, p.last_name`, [tenantId]);
  res.json({ mountain: t.name, timezone: t.timezone, photos: Boolean(t.kiosk_photos), photo_days: t.kiosk_photo_days, people: data.map((r) => ({ id: r.id, name: K.shownName(r), in: Boolean(r.clocked_in) })) });
});

/** Checks a PIN. Five wrong tries lock that person for ten minutes. The failure is counted even though the request errors. */
async function checkPin(tenantId, staffId, pin) {
  const out = await tx(async (conn) => {
    const c = await one(conn,
      `SELECT c.*, (c.locked_until IS NOT NULL AND c.locked_until > NOW()) AS locked, TIMESTAMPDIFF(MINUTE, NOW(), c.locked_until) AS mins
         FROM kiosk_credentials c JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.staff_id AND s.status = 'active'
        WHERE c.tenant_id = ? AND c.staff_id = ? FOR UPDATE`, [tenantId, staffId]);
    if (!c || !c.pin_hash) { await bcrypt.compare(pin, DUMMY); return { fail: true, left: null }; }
    if (c.locked) return { locked: true, mins: Math.max(1, Number(c.mins) + 1) };
    if (await bcrypt.compare(pin, c.pin_hash)) {
      if (c.failed_attempts || c.locked_until) await conn.query('UPDATE kiosk_credentials SET failed_attempts = 0, locked_until = NULL WHERE tenant_id = ? AND staff_id = ?', [tenantId, staffId]);
      return { ok: true };
    }
    const n = c.failed_attempts + 1;
    if (n >= K.MAX_TRIES) {
      await conn.query('UPDATE kiosk_credentials SET failed_attempts = 0, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE tenant_id = ? AND staff_id = ?', [K.LOCK_MINUTES, tenantId, staffId]);
      await kioskAudit(conn, tenantId, 'kiosk_locked', null, { staff_id: staffId });
      return { locked: true, mins: K.LOCK_MINUTES };
    }
    await conn.query('UPDATE kiosk_credentials SET failed_attempts = ? WHERE tenant_id = ? AND staff_id = ?', [n, tenantId, staffId]);
    return { fail: true, left: K.MAX_TRIES - n };
  });
  if (out.ok) return;
  if (out.locked) throw new AppError(429, `Too many wrong tries. Wait ${out.mins} minute${out.mins === 1 ? '' : 's'}, or ask a manager to unlock you.`, { code: 'locked' });
  throw new AppError(401, MSG_PIN, { attempts_left: out.left });
}

/** Step one: who are you. Returns what the person needs to see, and a 90-second token for step two. */
publicRouter.post('/identify', validate(z.object({ staff_id: z.number().int().positive().optional(), pin: z.string().max(10).optional(), badge: z.string().max(80).optional() })), async (req, res) => {
  const { tenantId, deviceId } = req.kiosk;
  let staffId; let method;
  if (req.body.badge) {
    const b = K.parseBadge(req.body.badge);
    const c = b ? await one(pool, `SELECT c.badge_version FROM kiosk_credentials c JOIN staff s ON s.tenant_id = c.tenant_id AND s.id = c.staff_id AND s.status = 'active' WHERE c.tenant_id = ? AND c.staff_id = ? AND c.badge_issued = 1`, [tenantId, b.staffId]) : null;
    if (!b || !c || c.badge_version !== b.version || !K.safeEq(b.mac, K.badgeMac(tenantId, b.staffId, b.version))) throw unauthorized('That badge was not recognized. Ask a manager for a new one.');
    staffId = b.staffId; method = 'badge';
  } else if (req.body.staff_id && req.body.pin) {
    staffId = req.body.staff_id; method = 'pin';
    await checkPin(tenantId, staffId, String(req.body.pin));
  } else throw bad('Tap your name and enter your PIN, or scan your badge');

  const t = await K.tenantOf(pool, tenantId);
  const [st, open, shift] = await Promise.all([
    one(pool, 'SELECT p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ?', [tenantId, staffId]),
    one(pool, 'SELECT id, clock_in, TIMESTAMPDIFF(MINUTE, clock_in, NOW()) AS minutes FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1', [tenantId, staffId]),
    one(pool, `SELECT sh.starts_at, sh.ends_at, pos.name AS position FROM shifts sh JOIN positions pos ON pos.tenant_id = sh.tenant_id AND pos.id = sh.position_id
                WHERE sh.tenant_id = ? AND sh.staff_id = ? AND sh.status = 'published' AND DATE(sh.starts_at) = ? ORDER BY sh.starts_at LIMIT 1`, [tenantId, staffId, todayIn(t.timezone)]),
  ]);
  res.json({
    session: K.signSession({ tenantId, deviceId, staffId, method }),
    staff: { id: staffId, name: K.shownName(st), first_name: st.first_name },
    state: open ? 'in' : 'out',
    since: open ? localTime(open.clock_in, t.timezone) : null,
    minutes: open ? Number(open.minutes) : null,
    shift: shift ? { position: shift.position, starts_at: shift.starts_at, ends_at: shift.ends_at } : null,
    photo: Boolean(t.kiosk_photos),
  });
});

/** Step two: clock in or out. The action has to match where the person is now, so a stray tap cannot flip it. */
publicRouter.post('/punch', validate(z.object({ session: z.string().max(400), action: z.enum(['in', 'out']), image: z.string().max(130000).optional() })), async (req, res) => {
  const { tenantId, deviceId } = req.kiosk;
  const s = K.readSession(req.body.session, tenantId, deviceId);
  if (!s) { const e = unauthorized('That took too long. Start again.'); e.details = { code: 'session_expired' }; throw e; }
  const t = await K.tenantOf(pool, tenantId);
  const { action } = req.body;
  const out = await tx(async (conn) => {
    const st = await one(conn, `SELECT s.id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ? AND s.status = 'active' FOR UPDATE`, [tenantId, s.staffId]);
    if (!st) throw notFound('Person');
    const open = await one(conn, 'SELECT id, clock_in FROM time_entries WHERE tenant_id = ? AND staff_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE', [tenantId, s.staffId]);
    const now = (await one(conn, 'SELECT NOW() AS n')).n;
    let entryId; let minutes = null;
    if (action === 'in') {
      if (open) throw conflict('You are already clocked in');
      const local = nowIn(t.timezone);
      const link = await require('../lib/shifts').shiftForPunch(conn, tenantId, s.staffId, local);
      const [r] = await conn.query('INSERT INTO time_entries (tenant_id, staff_id, shift_id, patrol_shift_id, clock_in, in_method, in_device_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, s.staffId, link.shift_id, link.patrol_shift_id, now, s.method, deviceId]);
      entryId = r.insertId;
    } else {
      if (!open) throw conflict('You are already clocked out');
      await conn.query('UPDATE time_entries SET clock_out = ?, out_method = ?, out_device_id = ? WHERE id = ? AND tenant_id = ?', [now, s.method, deviceId, open.id, tenantId]);
      entryId = open.id;
      minutes = (await one(conn, 'SELECT TIMESTAMPDIFF(MINUTE, ?, ?) AS m', [open.clock_in, now])).m;
    }
    let photo = false;
    if (t.kiosk_photos && K.validJpeg(req.body.image)) {
      await conn.query('INSERT INTO time_photos (tenant_id, entry_id, kind, image, taken_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE image = VALUES(image), taken_at = VALUES(taken_at)', [tenantId, entryId, action, req.body.image, now]);
      photo = true;
    }
    await kioskAudit(conn, tenantId, action === 'in' ? 'kiosk_clock_in' : 'kiosk_clock_out', entryId, { staff_id: s.staffId, device_id: deviceId, method: s.method, photo });
    return { name: K.shownName(st), first_name: st.first_name, at: localTime(now, t.timezone), minutes };
  });
  res.status(201).json({ action, ...out });
});

// ================================================================ the manager
const adminRouter = express.Router();
adminRouter.use(requireRole('manager'));
const mgrAudit = (db, req, action, entityId, detail) => kioskAudit(db, req.auth.tenantId, action, entityId, detail, req.auth.userId);

adminRouter.get('/overview', async (req, res) => {
  const { tenantId } = req.auth;
  const t = await K.tenantOf(pool, tenantId);
  const [devices, people] = await Promise.all([
    rows(pool, 'SELECT id, name, active, token_hash IS NOT NULL AS paired, (pair_hash IS NOT NULL AND pair_expires_at > NOW()) AS waiting, last_seen_at FROM kiosk_devices WHERE tenant_id = ? ORDER BY name', [tenantId]),
    rows(pool,
      `SELECT s.id AS staff_id, p.first_name, p.last_name, c.pin_hash IS NOT NULL AS pin_set, COALESCE(c.badge_issued, 0) AS badge_issued,
              (c.locked_until IS NOT NULL AND c.locked_until > NOW()) AS locked,
              EXISTS (SELECT 1 FROM time_entries te WHERE te.tenant_id = s.tenant_id AND te.staff_id = s.id AND te.clock_out IS NULL) AS clocked_in
         FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
         LEFT JOIN kiosk_credentials c ON c.tenant_id = s.tenant_id AND c.staff_id = s.id
        WHERE s.tenant_id = ? AND s.status = 'active' AND s.in_workforce = 1 ORDER BY p.last_name, p.first_name LIMIT 500`, [tenantId]),
  ]);
  res.json({
    mountain: { name: t.name },
    settings: { photos: Boolean(t.kiosk_photos), photo_days: t.kiosk_photo_days },
    devices: devices.map((d) => ({ id: d.id, name: d.name, active: Boolean(d.active), paired: Boolean(d.paired), waiting: Boolean(d.waiting), last_seen_at: d.last_seen_at ? localTime(d.last_seen_at, t.timezone) : null })),
    people: people.map((p) => ({ staff_id: p.staff_id, name: `${p.first_name} ${p.last_name}`, pin_set: Boolean(p.pin_set), badge_issued: Boolean(p.badge_issued), locked: Boolean(p.locked), clocked_in: Boolean(p.clocked_in) })),
  });
});

adminRouter.put('/settings', validate(z.object({ photos: z.boolean(), photo_days: z.number().int().min(1).max(365) })), async (req, res) => {
  await pool.query('UPDATE tenants SET kiosk_photos = ?, kiosk_photo_days = ? WHERE id = ?', [req.body.photos ? 1 : 0, req.body.photo_days, req.auth.tenantId]);
  await mgrAudit(pool, req, 'kiosk_settings', null, req.body);
  res.json({ ok: true });
});

// ---- devices
async function issuePairCode(req, id) {
  const code = K.newPairCode();
  await pool.query('UPDATE kiosk_devices SET pair_hash = ?, pair_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), token_hash = NULL, paired_at = NULL WHERE id = ? AND tenant_id = ?', [K.pairHash(code), K.PAIR_MINUTES, id, req.auth.tenantId]);
  return { id, code, link: `${baseUrl(req)}/kiosk/${code}`, expires_in_minutes: K.PAIR_MINUTES };
}
adminRouter.post('/devices', validate(z.object({ name: z.string().min(1).max(100) })), async (req, res) => {
  const [r] = await pool.query('INSERT INTO kiosk_devices (tenant_id, name) VALUES (?, ?)', [req.auth.tenantId, req.body.name.trim()]);
  await mgrAudit(pool, req, 'kiosk_device_added', r.insertId, { name: req.body.name });
  res.status(201).json({ name: req.body.name.trim(), ...(await issuePairCode(req, r.insertId)) });
});
adminRouter.post('/devices/:id/pair-code', async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM kiosk_devices WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Device');
  res.status(201).json(await issuePairCode(req, id));
});
adminRouter.patch('/devices/:id', validate(z.object({ name: z.string().min(1).max(100).optional(), active: z.boolean().optional() })), async (req, res) => {
  const id = paramId(req);
  const sets = []; const vals = [];
  if (req.body.name !== undefined) { sets.push('name = ?'); vals.push(req.body.name.trim()); }
  if (req.body.active !== undefined) { sets.push('active = ?'); vals.push(req.body.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE kiosk_devices SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Device');
  await mgrAudit(pool, req, 'kiosk_device_changed', id, req.body);
  res.json({ ok: true });
});
adminRouter.delete('/devices/:id', async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('DELETE FROM kiosk_devices WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Device');
  await mgrAudit(pool, req, 'kiosk_device_removed', id, {});
  res.json({ ok: true });
});

// ---- PINs and badges
async function activeStaff(req, id) {
  const s = await one(pool, `SELECT s.id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.id = ? AND s.status = 'active'`, [req.auth.tenantId, id]);
  if (!s) throw notFound('Staff member');
  return s;
}
/** Sets a PIN. Leave pin out and a random one is made; it is shown once and never stored in a form that can be read back. */
adminRouter.put('/people/:id/pin', validate(z.object({ pin: z.string().optional() })), async (req, res) => {
  const id = paramId(req);
  await activeStaff(req, id);
  const pin = req.body.pin === undefined || req.body.pin === '' ? K.randomPin() : req.body.pin;
  const problem = K.pinProblem(pin);
  if (problem) throw bad(problem);
  await pool.query('INSERT INTO kiosk_credentials (tenant_id, staff_id, pin_hash, pin_set_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE pin_hash = VALUES(pin_hash), pin_set_at = NOW(), failed_attempts = 0, locked_until = NULL', [req.auth.tenantId, id, await bcrypt.hash(pin, 10)]);
  await mgrAudit(pool, req, 'kiosk_pin_set', null, { staff_id: id });
  res.json({ pin });
});
adminRouter.delete('/people/:id/pin', async (req, res) => {
  const id = paramId(req);
  await pool.query('UPDATE kiosk_credentials SET pin_hash = NULL, pin_set_at = NULL, failed_attempts = 0, locked_until = NULL WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, id]);
  await mgrAudit(pool, req, 'kiosk_pin_cleared', null, { staff_id: id });
  res.json({ ok: true });
});
adminRouter.post('/people/:id/unlock', async (req, res) => {
  const id = paramId(req);
  await pool.query('UPDATE kiosk_credentials SET failed_attempts = 0, locked_until = NULL WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, id]);
  await mgrAudit(pool, req, 'kiosk_unlocked', null, { staff_id: id });
  res.json({ ok: true });
});
/** Badge codes for printing. Issuing does not change a badge that already exists. */
adminRouter.post('/badges', validate(z.object({ staff_ids: z.array(z.number().int().positive()).min(1).max(300) })), async (req, res) => {
  const { tenantId } = req.auth;
  const people = await rows(pool, `SELECT s.id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.status = 'active' AND s.id IN (?) ORDER BY p.last_name, p.first_name`, [tenantId, req.body.staff_ids]);
  const out = [];
  for (const p of people) {
    await pool.query('INSERT INTO kiosk_credentials (tenant_id, staff_id, badge_issued) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE badge_issued = 1', [tenantId, p.id]);
    const c = await one(pool, 'SELECT badge_version FROM kiosk_credentials WHERE tenant_id = ? AND staff_id = ?', [tenantId, p.id]);
    out.push({ staff_id: p.id, name: `${p.first_name} ${p.last_name}`, code: K.badgeCode(tenantId, p.id, c.badge_version) });
  }
  await mgrAudit(pool, req, 'kiosk_badges_printed', null, { staff_ids: out.map((o) => o.staff_id) });
  res.json({ data: out });
});
/** A lost badge: the old card stops working and a new code is made. */
adminRouter.post('/people/:id/badge/reissue', async (req, res) => {
  const id = paramId(req);
  const s = await activeStaff(req, id);
  await pool.query('INSERT INTO kiosk_credentials (tenant_id, staff_id, badge_issued, badge_version) VALUES (?, ?, 1, 1) ON DUPLICATE KEY UPDATE badge_issued = 1, badge_version = badge_version + 1', [req.auth.tenantId, id]);
  const c = await one(pool, 'SELECT badge_version FROM kiosk_credentials WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, id]);
  await mgrAudit(pool, req, 'kiosk_badge_reissued', null, { staff_id: id });
  res.json({ staff_id: id, name: `${s.first_name} ${s.last_name}`, code: K.badgeCode(req.auth.tenantId, id, c.badge_version) });
});

// ---- punches: everyone's clock-ins and outs, how they were made, snapshots, and corrections
adminRouter.get('/punches', async (req, res) => {
  const { tenantId } = req.auth;
  const t = await K.tenantOf(pool, tenantId);
  const to = dateStr.safeParse(req.query.to).success ? String(req.query.to) : todayIn(t.timezone);
  const from = dateStr.safeParse(req.query.from).success ? String(req.query.from) : addDays(to, -7);
  const [lo] = dayRange(t.timezone, from);
  const hi = dayRange(t.timezone, to)[1];
  const data = await rows(pool,
    `SELECT te.id, te.staff_id, p.first_name, p.last_name, te.clock_in, te.clock_out, te.in_method, te.out_method, d1.name AS in_device, d2.name AS out_device,
            TIMESTAMPDIFF(MINUTE, te.clock_in, COALESCE(te.clock_out, NOW())) AS minutes,
            EXISTS (SELECT 1 FROM time_photos ph WHERE ph.entry_id = te.id AND ph.kind = 'in') AS photo_in,
            EXISTS (SELECT 1 FROM time_photos ph WHERE ph.entry_id = te.id AND ph.kind = 'out') AS photo_out
       FROM time_entries te
       JOIN staff s ON s.tenant_id = te.tenant_id AND s.id = te.staff_id JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
       LEFT JOIN kiosk_devices d1 ON d1.id = te.in_device_id AND d1.tenant_id = te.tenant_id
       LEFT JOIN kiosk_devices d2 ON d2.id = te.out_device_id AND d2.tenant_id = te.tenant_id
      WHERE te.tenant_id = ? AND te.clock_in >= ? AND te.clock_in < ? ORDER BY te.clock_in DESC LIMIT 1000`, [tenantId, lo, hi]);
  res.json({ from, to, data: data.map((e) => ({
    id: e.id, staff_id: e.staff_id, name: `${e.first_name} ${e.last_name}`,
    clock_in: localTime(e.clock_in, t.timezone), clock_out: e.clock_out ? localTime(e.clock_out, t.timezone) : null, minutes: Number(e.minutes),
    in_method: e.in_method || 'login', out_method: e.clock_out ? (e.out_method || 'login') : null, in_device: e.in_device, out_device: e.out_device,
    photo_in: Boolean(e.photo_in), photo_out: Boolean(e.photo_out), long_open: !e.clock_out && Number(e.minutes) > K.LONG_OPEN_HOURS * 60,
  })) });
});

adminRouter.get('/photos/:id/:kind', async (req, res) => {
  const id = paramId(req);
  if (!['in', 'out'].includes(req.params.kind)) throw bad('Invalid kind');
  const t = await K.tenantOf(pool, req.auth.tenantId);
  const ph = await one(pool, 'SELECT image, taken_at FROM time_photos WHERE tenant_id = ? AND entry_id = ? AND kind = ?', [req.auth.tenantId, id, req.params.kind]);
  if (!ph) throw notFound('Snapshot');
  await mgrAudit(pool, req, 'kiosk_photo_viewed', id, { kind: req.params.kind });
  res.json({ image: ph.image, taken_at: localTime(ph.taken_at, t.timezone) });
});

/** Fix a forgotten clock-out or a wrong time. Times are the mountain's local time; the change is written to the audit log. */
adminRouter.patch('/entries/:id', validate(z.object({ clock_in: dateTimeStr.optional(), clock_out: dateTimeStr.optional() })), async (req, res) => {
  const id = paramId(req);
  const { tenantId } = req.auth;
  const t = await K.tenantOf(pool, tenantId);
  await tx(async (conn) => {
    const e = await one(conn, 'SELECT * FROM time_entries WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!e) throw notFound('Time entry');
    const inAt = req.body.clock_in ? K.localToDb(normDateTime(req.body.clock_in), t.timezone) : e.clock_in;
    const outAt = req.body.clock_out ? K.localToDb(normDateTime(req.body.clock_out), t.timezone) : e.clock_out;
    if (outAt && outAt <= inAt) throw bad('Clock-out must be after clock-in');
    if (!req.body.clock_in && !req.body.clock_out) throw bad('Nothing to change');
    await conn.query('UPDATE time_entries SET clock_in = ?, clock_out = ?, in_method = IF(?, \'manager\', in_method), out_method = IF(?, \'manager\', out_method) WHERE id = ? AND tenant_id = ?', [inAt, outAt, req.body.clock_in ? 1 : 0, req.body.clock_out ? 1 : 0, id, tenantId]);
    await kioskAudit(conn, tenantId, 'time_entry_corrected', id, { staff_id: e.staff_id, was: { clock_in: e.clock_in, clock_out: e.clock_out }, now: { clock_in: inAt, clock_out: outAt } }, req.auth.userId);
  });
  res.json({ ok: true });
});

module.exports = { publicRouter, adminRouter };
