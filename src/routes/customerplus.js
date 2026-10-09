'use strict';

// The customer record, release 1: consent history, staff flags, dated notes, a data export and anonymise for one person,
// and a data-quality summary. Mounted before people.js so fixed paths like /quality are not read as a customer id.
const express = require('express');
const { pool, rows, one, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { CHANNELS, recordConsent, currentConsent } = require('../lib/consent');

const router = express.Router();
const front = ['manager', 'counter', 'instructor'];
const FLAG_KINDS = ['do_not_rent', 'unpaid_balance', 'medical_alert', 'vip', 'banned', 'other'];
const NOTE_KINDS = ['general', 'service', 'complaint', 'preference', 'follow_up'];
const SOURCES = ['counter', 'phone', 'in_writing', 'online', 'guest_request'];

const actor = async (req) => (await one(pool, 'SELECT email FROM users WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, req.auth.userId]) || {}).email || null;
async function person(req) {
  const p = await one(pool, 'SELECT id, first_name, last_name, anonymised_at FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Person');
  return p;
}
const live = (p) => { if (p.anonymised_at) throw conflict('This customer has been anonymised'); };

// ---------------------------------------------------------------- data quality (manager)
/** Share of the details a mountain usually wants: email, phone, date of birth, address, emergency contact, a consent record. */
const SCORE_SQL = `(
  (email IS NOT NULL) + (phone IS NOT NULL) + (date_of_birth IS NOT NULL) + (address_line1 IS NOT NULL AND postal_code IS NOT NULL)
  + (emergency_phone IS NOT NULL)
  + EXISTS (SELECT 1 FROM consent_events c WHERE c.tenant_id = people.tenant_id AND c.person_id = people.id)
) * 100 DIV 6`;
router.get('/quality', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const t = await one(pool, `SELECT COUNT(*) AS total, COALESCE(SUM(email IS NULL), 0) AS no_email, COALESCE(SUM(phone IS NULL), 0) AS no_phone,
      COALESCE(SUM(date_of_birth IS NULL), 0) AS no_dob, COALESCE(SUM(address_line1 IS NULL OR postal_code IS NULL), 0) AS no_address,
      COALESCE(SUM(NOT EXISTS (SELECT 1 FROM consent_events c WHERE c.tenant_id = people.tenant_id AND c.person_id = people.id)), 0) AS no_consent_record,
      COALESCE(AVG(${SCORE_SQL}), 0) AS average
    FROM people WHERE tenant_id = ? AND anonymised_at IS NULL`, [tenantId]);
  const flags = await one(pool, 'SELECT COUNT(*) AS n FROM person_flags WHERE tenant_id = ? AND cleared_at IS NULL', [tenantId]);
  const n = (v) => Number(v);
  res.json({ total: n(t.total), no_email: n(t.no_email), no_phone: n(t.no_phone), no_date_of_birth: n(t.no_dob), no_address: n(t.no_address), no_consent_record: n(t.no_consent_record), average_score: Math.round(n(t.average)), open_flags: n(flags.n) });
});

/** Scores for a set of ids, used by the Customers list. */
router.get('/scores', requireRole(...front), async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 200);
  if (!ids.length) return res.json({ data: {} });
  const r = await rows(pool, `SELECT id, ${SCORE_SQL} AS score FROM people WHERE tenant_id = ? AND id IN (?)`, [req.auth.tenantId, ids]);
  const flags = await rows(pool, 'SELECT person_id, kind FROM person_flags WHERE tenant_id = ? AND person_id IN (?) AND cleared_at IS NULL AND (expires_on IS NULL OR expires_on >= CURDATE())', [req.auth.tenantId, ids]);
  const data = {};
  for (const x of r) data[x.id] = { score: Number(x.score), flags: [] };
  for (const f of flags) if (data[f.person_id]) data[f.person_id].flags.push(f.kind);
  res.json({ data });
});

// ---------------------------------------------------------------- consent
router.get('/:id/consent', requireRole(...front), async (req, res) => {
  const p = await person(req);
  const events = await rows(pool, 'SELECT id, channel, status, source, wording, recorded_by_name, created_at FROM consent_events WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 50', [req.auth.tenantId, p.id]);
  res.json({ current: await currentConsent(pool, req.auth.tenantId, p.id), events });
});

const consentBody = z.object({ channel: z.enum(CHANNELS), status: z.enum(['opted_in', 'opted_out']), source: z.enum(SOURCES) });
router.post('/:id/consent', requireRole(...front), validate(consentBody), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  live(p);
  const b = req.body;
  if (b.channel === 'sms') {
    const ok = await one(pool, 'SELECT phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, p.id]);
    if (b.status === 'opted_in' && !ok.phone) throw bad('Add a phone number before recording text message consent');
  }
  if (b.channel === 'email' && b.status === 'opted_in') {
    const ok = await one(pool, 'SELECT email FROM people WHERE tenant_id = ? AND id = ?', [tenantId, p.id]);
    if (!ok.email) throw bad('Add an email address before recording email consent');
  }
  const cur = (await currentConsent(pool, tenantId, p.id))[b.channel];
  if (cur && cur.status === b.status) throw conflict(`Already ${b.status === 'opted_in' ? 'agreed' : 'opted out'} for ${b.channel === 'sms' ? 'text messages' : 'email'}`);
  await tx(async (conn) => {
    await recordConsent(conn, tenantId, p.id, b.channel, b.status, b.source, { userId: req.auth.userId });
    if (b.channel === 'email') {
      await conn.query(b.status === 'opted_in' ? 'UPDATE people SET marketing_opt_in = 1, marketing_opt_in_at = NOW() WHERE tenant_id = ? AND id = ?' : 'UPDATE people SET marketing_opt_in = 0 WHERE tenant_id = ? AND id = ?', [tenantId, p.id]);
    }
    await audit(conn, req, 'consent', 'people', p.id, { channel: b.channel, status: b.status, source: b.source });
  });
  res.status(201).json({ current: await currentConsent(pool, tenantId, p.id) });
});

// ---------------------------------------------------------------- flags
const flagRows = (tenantId, id) => rows(pool, `SELECT id, kind, message, expires_on, set_by_name, created_at FROM person_flags
  WHERE tenant_id = ? AND person_id = ? AND cleared_at IS NULL AND (expires_on IS NULL OR expires_on >= CURDATE()) ORDER BY id DESC`, [tenantId, id]);

router.get('/:id/flags', requireRole(...front, 'patrol'), async (req, res) => {
  const p = await person(req);
  // Patrol sees medical alerts only; a rental or banned note is not their business.
  const data = (await flagRows(req.auth.tenantId, p.id)).filter((f) => req.auth.role !== 'patrol' || f.kind === 'medical_alert');
  res.json({ data });
});

const flagBody = z.object({
  kind: z.enum(FLAG_KINDS),
  message: z.string().trim().min(2).max(200),
  expires_on: z.preprocess((v) => (v === '' ? null : v), dateStr.nullable().optional()),
});
router.post('/:id/flags', requireRole('manager'), validate(flagBody), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  live(p);
  const b = req.body;
  const [r] = await pool.query('INSERT INTO person_flags (tenant_id, person_id, kind, message, expires_on, set_by, set_by_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [tenantId, p.id, b.kind, b.message, b.expires_on || null, req.auth.userId, await actor(req)]);
  await audit(pool, req, 'flag_set', 'people', p.id, { flag_id: r.insertId, kind: b.kind });
  res.status(201).json({ data: await flagRows(tenantId, p.id) });
});

router.delete('/:id/flags/:flagId', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  const flagId = Number(req.params.flagId);
  const [r] = await pool.query('UPDATE person_flags SET cleared_at = NOW(), cleared_by_name = ? WHERE tenant_id = ? AND person_id = ? AND id = ? AND cleared_at IS NULL', [await actor(req), tenantId, p.id, flagId]);
  if (!r.affectedRows) throw notFound('Flag');
  await audit(pool, req, 'flag_clear', 'people', p.id, { flag_id: flagId });
  res.json({ data: await flagRows(tenantId, p.id) });
});

// ---------------------------------------------------------------- notes
router.get('/:id/notes', requireRole(...front), async (req, res) => {
  const p = await person(req);
  res.json({ data: await rows(pool, 'SELECT id, category, body, author_name, created_at FROM person_notes WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 100', [req.auth.tenantId, p.id]) });
});

const noteBody = z.object({ category: z.enum(NOTE_KINDS).default('general'), body: z.string().trim().min(1).max(1000) });
router.post('/:id/notes', requireRole(...front), validate(noteBody), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  live(p);
  await pool.query('INSERT INTO person_notes (tenant_id, person_id, category, body, author_id, author_name) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, p.id, req.body.category, req.body.body, req.auth.userId, await actor(req)]);
  await audit(pool, req, 'note_add', 'people', p.id, { category: req.body.category });
  res.status(201).json({ data: await rows(pool, 'SELECT id, category, body, author_name, created_at FROM person_notes WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 100', [tenantId, p.id]) });
});

router.delete('/:id/notes/:noteId', requireRole('manager'), async (req, res) => {
  const p = await person(req);
  const [r] = await pool.query('DELETE FROM person_notes WHERE tenant_id = ? AND person_id = ? AND id = ?', [req.auth.tenantId, p.id, Number(req.params.noteId)]);
  if (!r.affectedRows) throw notFound('Note');
  await audit(pool, req, 'note_delete', 'people', p.id, { note_id: Number(req.params.noteId) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- one person's data: download it, or anonymise it
router.get('/:id/data-export', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  const id = p.id;
  const q = (sql) => rows(pool, sql, [tenantId, id]);
  const record = await one(pool, 'SELECT * FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  delete record.photo; record.has_photo = Boolean(await one(pool, 'SELECT 1 AS x FROM people WHERE tenant_id = ? AND id = ? AND photo IS NOT NULL', [tenantId, id]));
  const out = {
    exported_at: new Date().toISOString(),
    person: record,
    consent: await q('SELECT channel, status, source, wording, recorded_by_name, created_at FROM consent_events WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    notes: await q('SELECT category, body, author_name, created_at FROM person_notes WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    flags: await q('SELECT kind, message, expires_on, set_by_name, created_at, cleared_at FROM person_flags WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    waivers: await q('SELECT season, kind, signed_at, signed_by_name, signer_relation FROM waivers WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    orders: await q('SELECT id, created_at, status, channel, total_cents FROM orders WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    tickets: await q('SELECT code, valid_from, valid_to, status, uses_remaining FROM tickets WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    lessons: await q('SELECT b.status, s.starts_at FROM lesson_bookings b JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id WHERE b.tenant_id = ? AND b.person_id = ? ORDER BY b.id'),
    rentals: await q('SELECT status, checked_out_at, due_at FROM rental_contracts WHERE tenant_id = ? AND person_id = ? ORDER BY id'),
    programs: await q('SELECT e.status, p.name, p.season FROM program_enrollments e JOIN programs p ON p.id = e.program_id AND p.tenant_id = e.tenant_id WHERE e.tenant_id = ? AND e.person_id = ? ORDER BY e.id'),
  };
  await audit(pool, req, 'data_export', 'people', id, null);
  res.set('Content-Type', 'application/json; charset=utf-8').set('Content-Disposition', `attachment; filename="customer-${id}-data.json"`).send(JSON.stringify(out, null, 2));
});

const anonBody = z.object({ confirm: z.literal(true) });
/**
 * Removes who this person is while keeping what the mountain needs for its books and its legal duties: sales, tickets, rentals
 * and signed waivers stay (with no name attached to them any more), and the consent history stays so the withdrawal is provable.
 */
router.post('/:id/anonymise', requireRole('manager'), validate(anonBody), async (req, res) => {
  const { tenantId } = req.auth;
  const p = await person(req);
  live(p);
  if (await one(pool, 'SELECT id FROM staff WHERE tenant_id = ? AND person_id = ?', [tenantId, p.id])) throw conflict('That customer is a staff member, so they cannot be anonymised here');
  if (await one(pool, 'SELECT id FROM users WHERE tenant_id = ? AND person_id = ?', [tenantId, p.id])) throw conflict('That customer has a sign-in, so they cannot be anonymised');
  if (await one(pool, "SELECT id FROM rental_contracts WHERE tenant_id = ? AND person_id = ? AND status IN ('out','overdue')", [tenantId, p.id])) throw conflict('This customer still has rental gear out');
  await tx(async (conn) => {
    for (const channel of CHANNELS) {
      const cur = (await currentConsent(conn, tenantId, p.id))[channel];
      if (cur && cur.status === 'opted_in') await recordConsent(conn, tenantId, p.id, channel, 'opted_out', 'erasure', { userId: req.auth.userId });
    }
    await conn.query(`UPDATE people SET first_name = 'Former', last_name = 'customer', email = NULL, phone = NULL, date_of_birth = NULL, sex = NULL, height_in = NULL, weight_lb = NULL,
      boot_size = NULL, stance = NULL, skier_type = NULL, photo = NULL, address_line1 = NULL, address_line2 = NULL, city = NULL, region = NULL, postal_code = NULL, country = NULL,
      emergency_name = NULL, emergency_phone = NULL, discipline = NULL, ability_level = NULL, marketing_opt_in = 0, notes = NULL, anonymised_at = NOW() WHERE tenant_id = ? AND id = ?`, [tenantId, p.id]);
    await conn.query('DELETE FROM person_notes WHERE tenant_id = ? AND person_id = ?', [tenantId, p.id]);
    await conn.query('DELETE FROM person_flags WHERE tenant_id = ? AND person_id = ?', [tenantId, p.id]);
    await conn.query('DELETE FROM person_links WHERE tenant_id = ? AND (adult_id = ? OR member_id = ?)', [tenantId, p.id, p.id]);
    await conn.query('DELETE FROM rental_profiles WHERE tenant_id = ? AND person_id = ?', [tenantId, p.id]);
    await conn.query('INSERT INTO person_tombstones (tenant_id, old_id, kept_id, action, done_by) VALUES (?, ?, NULL, ?, ?)', [tenantId, p.id, 'anonymise', req.auth.userId]);
    await audit(conn, req, 'anonymise', 'people', p.id, null);
  });
  res.json({ ok: true, id: p.id });
});

module.exports = router;
