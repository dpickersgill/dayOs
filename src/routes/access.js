'use strict';

// Gate: RFID cards and the hardware at the lifts.
// adminRouter (/api/v1/access, signed-in staff): put a ticket on a card, look a card up, block a lost one, and (managers)
// pair gates and readers. deviceRouter (/api/v1/device, no login): what a paired gate, turnstile or handheld calls. The
// device's own key is its only credential and the mountain comes from the device, never from the request.

const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, todayIn, localTime } = require('../lib/util');
const { bad, unauthorized, notFound, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { requireModule } = require('../lib/modules');
const K = require('../lib/kiosk');
const A = require('../lib/access');

const tzOf = async (db, tenantId) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const desk = requireRole('counter', 'staff', 'manager');
const manager = requireRole('manager');
const uidField = z.string().trim().min(4).max(64);

// ================================================================ cards (staff)
const adminRouter = express.Router();

const CARD_SQL = `SELECT c.id, c.uid, c.label, c.status, c.assigned_at, c.last_seen_at, t.code AS ticket_code, t.valid_from, t.valid_to, t.status AS ticket_status, t.uses_remaining,
    pr.name AS product, p.first_name, p.last_name
  FROM rfid_cards c
  LEFT JOIN tickets t ON t.tenant_id = c.tenant_id AND t.id = c.ticket_id
  LEFT JOIN products pr ON pr.tenant_id = t.tenant_id AND pr.id = t.product_id
  LEFT JOIN people p ON p.tenant_id = t.tenant_id AND p.id = t.person_id`;
const cardOut = (c, tz) => ({
  id: c.id, uid: c.uid, label: c.label, status: c.status,
  ticket_code: c.status === 'free' ? null : c.ticket_code, product: c.status === 'free' ? null : c.product,
  holder: c.status !== 'free' && c.first_name ? `${c.first_name} ${c.last_name}` : null,
  valid_from: c.status === 'free' ? null : c.valid_from, valid_to: c.status === 'free' ? null : c.valid_to,
  ticket_status: c.status === 'free' ? null : c.ticket_status, uses_remaining: c.status === 'free' ? null : c.uses_remaining,
  assigned_at: c.assigned_at, last_seen_at: c.last_seen_at ? localTime(c.last_seen_at, tz) : null,
});

adminRouter.get('/cards', desk, async (req, res) => {
  const t = req.auth.tenantId; const tz = await tzOf(pool, t);
  const where = ['c.tenant_id = ?']; const params = [t];
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q) {
    const cands = A.uidCandidates(q);
    const like = `%${q.replace(/[%_]/g, '')}%`;
    where.push(`(c.label LIKE ? OR t.code = ? OR p.last_name LIKE ? OR p.first_name LIKE ?${cands.length ? ' OR c.uid IN (?)' : ''})`);
    params.push(like, q.toUpperCase(), `${q}%`, `${q}%`, ...(cands.length ? [cands] : []));
  }
  if (req.query.status) { where.push('c.status = ?'); params.push(String(req.query.status)); }
  const data = await rows(pool, `${CARD_SQL} WHERE ${where.join(' AND ')} ORDER BY COALESCE(c.last_seen_at, c.assigned_at, c.created_at) DESC LIMIT 200`, params);
  const counts = await one(pool, "SELECT COUNT(*) AS n, SUM(status = 'assigned') AS assigned, SUM(status = 'free') AS free, SUM(status = 'lost') AS lost FROM rfid_cards WHERE tenant_id = ?", [t]);
  res.json({ data: data.map((c) => cardOut(c, tz)), counts: { all: Number(counts.n), assigned: Number(counts.assigned || 0), free: Number(counts.free || 0), lost: Number(counts.lost || 0) } });
});

/** One card, by what a reader read off it. */
adminRouter.get('/cards/lookup', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const { card, cands } = await A.findCard(pool, t, req.query.uid);
  if (!cands.length) throw bad('That does not look like a card number');
  if (!card) return res.json({ card: null, uid: cands[0] });
  const c = await one(pool, `${CARD_SQL} WHERE c.tenant_id = ? AND c.id = ?`, [t, card.id]);
  res.json({ card: cardOut(c, await tzOf(pool, t)) });
});

/**
 * Put a ticket or pass on a card. A new card is registered on first use. A card that already carries another ticket
 * that is still good is refused unless replace is set; a ticket moved to a new card leaves its old card free (a lost
 * card stays blocked).
 */
adminRouter.post('/cards/assign', desk, validate(z.object({ ticket_code: z.string().trim().min(6).max(40), uid: uidField, label: z.string().trim().max(40).nullable().optional(), replace: z.boolean().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const uid = A.normUid(b.uid);
  if (!uid) throw bad('That does not look like a card number. Tap the card on the reader again.');
  const out = await tx(async (conn) => {
    const today = todayIn(await tzOf(conn, t));
    const ticket = await one(conn, 'SELECT id, code, status, valid_to FROM tickets WHERE tenant_id = ? AND code = ? FOR UPDATE', [t, b.ticket_code.toUpperCase().replace(/[\s-]/g, '')]);
    if (!ticket) throw notFound('Ticket');
    if (ticket.status === 'void') throw conflict('That ticket was voided');
    const { card } = await A.findCard(conn, t, b.uid, { lock: true });
    if (card && card.ticket_id) {
      const other = await one(conn, 'SELECT code, status, valid_to FROM tickets WHERE tenant_id = ? AND id = ?', [t, card.ticket_id]);
      Object.assign(card, other ? { other_code: other.code, other_status: other.status, other_valid_to: other.valid_to } : {});
    }
    if (card && (card.status === 'lost' || card.status === 'retired')) throw conflict(`This card is marked ${card.status}. Use another card, or have a manager mark it found.`);
    if (card && card.status === 'assigned' && card.ticket_id && card.ticket_id !== ticket.id && card.other_status === 'active' && String(card.other_valid_to) >= today && !b.replace) {
      const e = conflict('This card already carries another ticket that is still good. Replace it?');
      e.details = { code: 'card_in_use', other_ticket: card.other_code };
      throw e;
    }
    // A ticket lives on one card: any other card it was on goes back to the drawer.
    const [moved] = await conn.query("UPDATE rfid_cards SET ticket_id = NULL, status = 'free', assigned_at = NULL WHERE tenant_id = ? AND ticket_id = ? AND status = 'assigned' AND uid <> ?", [t, ticket.id, card ? card.uid : uid]);
    let id;
    if (card) {
      await conn.query("UPDATE rfid_cards SET ticket_id = ?, status = 'assigned', assigned_at = UTC_TIMESTAMP(), label = COALESCE(?, label) WHERE tenant_id = ? AND id = ?", [ticket.id, b.label || null, t, card.id]);
      id = card.id;
    } else {
      const [r] = await conn.query("INSERT INTO rfid_cards (tenant_id, uid, label, ticket_id, status, assigned_at) VALUES (?, ?, ?, ?, 'assigned', UTC_TIMESTAMP())", [t, uid, b.label || null, ticket.id]);
      id = r.insertId;
    }
    await audit(conn, req, 'card_assign', 'rfid_cards', id, { ticket: ticket.code, replaced: card && card.ticket_id && card.ticket_id !== ticket.id ? card.other_code : null, moved_from_cards: moved.affectedRows });
    return { id, uid: card ? card.uid : uid, ticket_code: ticket.code, moved_from_other_card: moved.affectedRows > 0 };
  });
  res.status(201).json(out);
});

/** Lost or stolen: the card stops opening gates at once. Its ticket can then go on a new card. */
adminRouter.post('/cards/:id/lost', desk, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const c = await one(pool, 'SELECT c.id, k.code FROM rfid_cards c LEFT JOIN tickets k ON k.tenant_id = c.tenant_id AND k.id = c.ticket_id WHERE c.tenant_id = ? AND c.id = ?', [t, id]);
  if (!c) throw notFound('Card');
  await pool.query("UPDATE rfid_cards SET status = 'lost' WHERE tenant_id = ? AND id = ?", [t, id]);
  await audit(pool, req, 'card_lost', 'rfid_cards', id, { ticket: c.code });
  res.json({ ok: true, ticket_code: c.code });
});

/** Back in the drawer: empty and ready to load again. A blocked card is unblocked only by a manager. */
adminRouter.post('/cards/:id/free', desk, async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const c = await one(pool, 'SELECT id, status FROM rfid_cards WHERE tenant_id = ? AND id = ?', [t, id]);
  if (!c) throw notFound('Card');
  if (['lost', 'retired'].includes(c.status) && !['owner', 'manager'].includes(req.auth.role)) throw conflict('Only a manager can unblock a lost card');
  // Only if nobody changed it meanwhile (a card reported lost a moment ago stays blocked for a counter user).
  const [r] = await pool.query("UPDATE rfid_cards SET status = 'free', ticket_id = NULL, assigned_at = NULL WHERE tenant_id = ? AND id = ? AND status = ?", [t, id, c.status]);
  if (!r.affectedRows) throw conflict('This card changed a moment ago. Look at it again.');
  await audit(pool, req, 'card_free', 'rfid_cards', id, { was: c.status });
  res.json({ ok: true });
});

adminRouter.get('/settings', manager, async (req, res) => {
  res.json(await one(pool, 'SELECT gate_open_ms, scan_passback_seconds FROM tenants WHERE id = ?', [req.auth.tenantId]));
});
adminRouter.put('/settings', manager, validate(z.object({ gate_open_ms: z.number().int().min(500).max(15000).optional(), scan_passback_seconds: z.number().int().min(0).max(3600).optional() })), async (req, res) => {
  const b = req.body;
  if (b.gate_open_ms === undefined && b.scan_passback_seconds === undefined) throw bad('Nothing to change');
  await pool.query('UPDATE tenants SET gate_open_ms = COALESCE(?, gate_open_ms), scan_passback_seconds = COALESCE(?, scan_passback_seconds) WHERE id = ?', [b.gate_open_ms ?? null, b.scan_passback_seconds ?? null, req.auth.tenantId]);
  await audit(pool, req, 'gate_settings', 'tenants', req.auth.tenantId, b);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- devices (managers)
const DEVICE_KINDS = ['gate', 'turnstile', 'handheld', 'reader'];
async function issuePairCode(req, id) {
  const code = K.newPairCode();
  // A new code is a fresh start: any old key stops working, and a switched-off or removed device is back in use.
  await pool.query('UPDATE access_devices SET pair_hash = ?, pair_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE), token_hash = NULL, paired_at = NULL, active = 1 WHERE id = ? AND tenant_id = ?', [K.pairHash(code), K.PAIR_MINUTES, id, req.auth.tenantId]);
  return { id, code, expires_in_minutes: K.PAIR_MINUTES };
}
adminRouter.get('/devices', manager, async (req, res) => {
  const t = req.auth.tenantId; const tz = await tzOf(pool, t);
  const data = await rows(pool,
    `SELECT d.id, d.name, d.location, d.kind, d.active, d.attraction_id, (SELECT a.name FROM attractions a WHERE a.tenant_id = d.tenant_id AND a.id = d.attraction_id) AS attraction, d.token_hash IS NOT NULL AS paired, (d.pair_hash IS NOT NULL AND d.pair_expires_at > NOW()) AS waiting, d.last_seen_at, d.last_list_at,
       (SELECT COUNT(*) FROM scans s WHERE s.tenant_id = d.tenant_id AND s.device_id = d.id AND s.scanned_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)) AS scans_24h
     FROM access_devices d WHERE d.tenant_id = ? ORDER BY d.name`, [t]);
  // The attractions a device can stand at (read from the table: the gate's own list).
  const attractions = await rows(pool, 'SELECT id, name, type FROM attractions WHERE tenant_id = ? AND active = 1 ORDER BY sort, name', [t]);
  res.json({ attractions, data: data.map((d) => ({ ...d, active: Boolean(d.active), paired: Boolean(d.paired), waiting: Boolean(d.waiting), scans_24h: Number(d.scans_24h), last_seen_at: d.last_seen_at ? localTime(d.last_seen_at, tz) : null, last_list_at: d.last_list_at ? localTime(d.last_list_at, tz) : null })) });
});
// attraction_id: the attraction the device stands at (activity tickets for it, and lift tickets that include it), or null for a lift gate.
const deviceFields = { name: z.string().trim().min(1).max(100), location: z.string().trim().max(100).nullable().optional(), kind: z.enum(DEVICE_KINDS).optional(), attraction_id: z.number().int().positive().nullable().optional() };
async function checkAttraction(tenantId, id) {
  if (!id) return;
  if (!(await one(pool, 'SELECT id FROM attractions WHERE tenant_id = ? AND id = ? AND active = 1', [tenantId, id]))) throw bad('That attraction is not on file');
}
adminRouter.post('/devices', manager, validate(z.object(deviceFields)), async (req, res) => {
  const b = req.body;
  await checkAttraction(req.auth.tenantId, b.attraction_id);
  const [r] = await pool.query('INSERT INTO access_devices (tenant_id, name, location, kind, attraction_id) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, b.name, b.location || null, b.kind || 'gate', b.attraction_id || null]);
  await audit(pool, req, 'device_added', 'access_devices', r.insertId, { name: b.name });
  res.status(201).json({ name: b.name, ...(await issuePairCode(req, r.insertId)) });
});
adminRouter.post('/devices/:id/pair-code', manager, async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM access_devices WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Device');
  await audit(pool, req, 'device_repair', 'access_devices', id, {});
  res.status(201).json(await issuePairCode(req, id));
});
adminRouter.patch('/devices/:id', manager, validate(z.object({ ...deviceFields, name: deviceFields.name.optional(), active: z.boolean().optional() })), async (req, res) => {
  const id = paramId(req); const b = req.body;
  await checkAttraction(req.auth.tenantId, b.attraction_id);
  const sets = []; const vals = [];
  for (const k of ['name', 'location', 'kind', 'attraction_id']) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k] || null); }
  if (b.active !== undefined) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (!sets.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE access_devices SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Device');
  await audit(pool, req, 'device_changed', 'access_devices', id, b);
  res.json({ ok: true });
});
adminRouter.delete('/devices/:id', manager, async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('UPDATE access_devices SET active = 0, token_hash = NULL, pair_hash = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Device');
  await audit(pool, req, 'device_removed', 'access_devices', id, {});
  res.json({ ok: true });
});

// ================================================================ the device itself
const deviceRouter = express.Router();
const MESSAGES = {
  ok: 'Welcome', expired: 'Ticket expired', not_yet_valid: 'Not valid yet', void: 'Ticket voided', no_uses: 'No rides left',
  unknown: 'Not recognized', duplicate: 'Already used, see staff', card_blocked: 'Card blocked, see staff',
  wrong_place: 'Wrong attraction', too_early: 'Too early for this slot', too_late: 'This slot has ended', not_included: 'Not included, see staff',
};

/** A device trades a manager's one-time code for its own long-lived key. The code works once and expires. */
deviceRouter.post('/pair', validate(z.object({ code: z.string().min(4).max(20) })), async (req, res) => {
  const d = await one(pool, 'SELECT id, tenant_id, name, location, kind FROM access_devices WHERE pair_hash = ? AND pair_expires_at > NOW() AND active = 1', [K.pairHash(req.body.code)]);
  if (!d) throw unauthorized('That code did not work. Ask a manager for a new one.');
  await requireModule(d.tenant_id, 'gate');
  const token = K.newDeviceToken();
  const [r] = await pool.query('UPDATE access_devices SET token_hash = ?, pair_hash = NULL, pair_expires_at = NULL, paired_at = NOW(), last_seen_at = NOW() WHERE id = ? AND pair_hash IS NOT NULL', [K.tokenHash(token), d.id]);
  if (!r.affectedRows) throw unauthorized('That code did not work. Ask a manager for a new one.');
  await pool.query('INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, detail) VALUES (?, NULL, ?, ?, ?, ?)', [d.tenant_id, 'device_paired', 'access_devices', d.id, JSON.stringify({ name: d.name })]);
  res.json({ token, device: { id: d.id, name: d.name, location: d.location, kind: d.kind } });
});

async function deviceAuth(req, _res, next) {
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Device ') ? header.slice(7).trim() : String(req.get('x-device-token') || '');
  const d = token ? await one(pool, 'SELECT id, tenant_id, name, location, attraction_id FROM access_devices WHERE token_hash = ? AND active = 1', [K.tokenHash(token)]) : null;
  if (!d) { const e = unauthorized('This device is not paired. Ask a manager for a pairing code.'); e.details = { code: 'device_unpaired' }; throw e; }
  await requireModule(d.tenant_id, 'gate');
  req.device = { tenantId: d.tenant_id, id: d.id, location: d.location || d.name, attractionId: d.attraction_id || null };
  await pool.query('UPDATE access_devices SET last_seen_at = NOW() WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < DATE_SUB(NOW(), INTERVAL 30 SECOND))', [d.id]);
  return next();
}
deviceRouter.use((req, res, next) => deviceAuth(req, res, next).catch(next));

deviceRouter.get('/ping', async (req, res) => res.json({ ok: true, device_id: req.device.id, server_time: new Date().toISOString() }));

/**
 * One tap or scan, decided now. client_ref is the device's own id for this scan: a retry with the same id gets the
 * first answer back instead of a second entry (and never a second ride off a punch card).
 */
/** The answer for a scan already recorded: the same yes or no, with the gate time and the ticket as they stand now. */
async function replyFor(tenantId, scan) {
  const tenant = await one(pool, 'SELECT gate_open_ms FROM tenants WHERE id = ?', [tenantId]);
  const t = scan.ticket_id ? await one(pool, 'SELECT k.uses_remaining, k.valid_to, p.first_name FROM tickets k LEFT JOIN people p ON p.tenant_id = k.tenant_id AND p.id = k.person_id WHERE k.tenant_id = ? AND k.id = ?', [tenantId, scan.ticket_id]) : null;
  const allow = scan.result === 'ok';
  return {
    allow, result: scan.result, message: allow && t && t.first_name ? `Welcome, ${t.first_name}` : MESSAGES[scan.result],
    open_ms: allow ? tenant.gate_open_ms : 0, uses_remaining: t ? t.uses_remaining : null, valid_to: t ? t.valid_to : null,
  };
}
const seenScan = (tenantId, deviceId, ref) => one(pool, 'SELECT result, ticket_id FROM scans WHERE tenant_id = ? AND device_id = ? AND client_ref = ?', [tenantId, deviceId, ref]);

/**
 * One tap or scan, decided now. client_ref is the device's own id for this scan: a retry with the same id gets the
 * same answer back (repeat: true) instead of a second entry, and never a second ride off a punch card.
 */
deviceRouter.post('/check', validate(z.object({ uid: uidField.optional(), code: z.string().trim().min(4).max(64).optional(), client_ref: z.string().trim().min(1).max(64).optional() })
  .refine((b) => b.uid || b.code, 'Send uid or code')), async (req, res) => {
  const { tenantId, id, location, attractionId } = req.device; const b = req.body;
  if (b.client_ref) {
    const seen = await seenScan(tenantId, id, b.client_ref);
    if (seen) return res.json({ ...(await replyFor(tenantId, seen)), repeat: true });
  }
  let out;
  try {
    out = await tx((conn) => A.decide(conn, tenantId, { code: b.code, uid: b.uid, location, deviceId: id, clientRef: b.client_ref || null, via: 'device', attractionId }));
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY' || !b.client_ref) throw err;
    return res.json({ ...(await replyFor(tenantId, await seenScan(tenantId, id, b.client_ref))), repeat: true });
  }
  res.json({
    allow: out.valid, result: out.result, message: out.valid && out.holder && out.holder.first_name ? `Welcome, ${out.holder.first_name}` : MESSAGES[out.result],
    open_ms: out.valid ? out.open_ms : 0, uses_remaining: out.ticket ? out.ticket.uses_remaining : null, valid_to: out.ticket ? out.ticket.valid_to : null,
    reason: out.reason || null, // for a screen on the device: why it was refused, in a sentence
  });
});

/** Today's list for deciding offline: good chips and codes, blocked chips. No names leave the server. */
deviceRouter.get('/list', async (req, res) => {
  const { tenantId, id, attractionId } = req.device;
  const list = await A.allowlist(pool, tenantId, { attractionId });
  await pool.query('UPDATE access_devices SET last_list_at = NOW() WHERE id = ?', [id]);
  // The same body while nothing changes, so a device that sends If-None-Match gets 304 and no body. Done here by hand:
  // the API marks every answer no-store, which turns off Express's own check.
  const body = JSON.stringify(list);
  const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
  res.set('ETag', etag);
  if (String(req.get('if-none-match') || '').split(',').map((x) => x.trim().replace(/^W\//, '')).includes(etag)) return res.status(304).end();
  res.type('application/json').send(body);
});

/**
 * Scans a device decided on its own while offline, sent when it is back. Each is saved once (by client_ref), at the
 * time it happened; an allowed scan uses up a ride on a punch card. The device's decision stands: this is the record.
 * A scan dated more than 5 minutes ahead or more than 14 days back is not saved (a gate with a wrong clock would
 * otherwise hold tickets in the pass-back window, or rewrite old history); it is listed in `rejected`.
 */
const offlineScan = z.object({ client_ref: z.string().trim().min(1).max(64), at: z.string().datetime({ offset: true }), uid: uidField.optional(), code: z.string().trim().min(4).max(64).optional(), allowed: z.boolean() })
  .refine((s) => s.uid || s.code, 'Each scan needs uid or code');
deviceRouter.post('/scans', validate(z.object({ scans: z.array(offlineScan).min(1).max(500) })), async (req, res) => {
  const { tenantId, id, location } = req.device;
  let saved = 0; let repeats = 0; const rejected = [];
  const now = Date.now();
  await tx(async (conn) => {
    for (const s of req.body.scans) {
      const when = Date.parse(s.at);
      if (!(when <= now + 5 * 60_000 && when >= now - 14 * 864e5)) { rejected.push({ client_ref: s.client_ref, reason: 'time out of range' }); continue; }
      let ticket = null; let uid = null;
      if (s.code) ticket = await one(conn, 'SELECT id, code, uses_remaining FROM tickets WHERE tenant_id = ? AND code = ? FOR UPDATE', [tenantId, s.code.toUpperCase().replace(/[\s-]/g, '')]);
      if (!ticket) {
        const { card, cands } = await A.findCard(conn, tenantId, s.uid || s.code);
        if (card) {
          uid = card.uid;
          if (card.ticket_id) ticket = await one(conn, 'SELECT id, code, uses_remaining FROM tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, card.ticket_id]);
        } else uid = cands[0] || null;
      }
      const at = new Date(when).toISOString().slice(0, 19).replace('T', ' ');
      try {
        await conn.query('INSERT INTO scans (tenant_id, ticket_id, code, location, result, scanned_at, media_uid, device_id, client_ref, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, ticket ? ticket.id : null, ticket ? ticket.code : String(s.uid || s.code).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 20), location, s.allowed ? 'ok' : 'unknown', at, uid, id, s.client_ref, 'offline']);
      } catch (err) {
        if (err.code !== 'ER_DUP_ENTRY') throw err;
        repeats += 1; continue; // already saved: an earlier upload, or the online check this scan timed out on
      }
      saved += 1;
      if (s.allowed && ticket && ticket.uses_remaining !== null && ticket.uses_remaining > 0) {
        // status is worked out from the value before this ride, so it reads the same on every database
        await conn.query("UPDATE tickets SET status = IF(uses_remaining <= 1, 'used_up', status), uses_remaining = uses_remaining - 1 WHERE tenant_id = ? AND id = ?", [tenantId, ticket.id]);
      }
    }
  });
  res.json({ saved, repeats, rejected });
});

module.exports = { adminRouter, deviceRouter };
