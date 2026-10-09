'use strict';

// Customers: the shared record that tickets, lessons, rentals, programs and patrol all point at.
const express = require('express');
const { pool, rows, one, tx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { VALID } = require('../lib/waivers');
const { z, validate, paramId, seasonFor, todayIn } = require('../lib/util');
const { notFound, conflict, bad, forbidden } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { FIELDS, COLS, personCreate, personUpdate, isBlank } = require('../lib/customers');
const { addLink, familyOf } = require('../lib/family');
const { recordConsent } = require('../lib/consent');
const patrolaccess = require('../lib/patrolaccess');
const who = (req) => ({ userId: req.auth.userId, name: req.auth.email || null });

const router = express.Router();
const front = ['manager', 'counter', 'instructor'];
const readers = [...front, 'patrol'];
// A patrol login may look guests up only when its patrol access level can write cases (a Host cannot).
const patrolLookup = async (req, _res, next) => {
  try {
    if (req.auth.role === 'patrol' && !(await patrolaccess.can(pool, req, 'create_case'))) throw forbidden('Your patrol access level cannot look up guests');
    next();
  } catch (err) { next(err); }
};

// Patrol can look a guest up (to start a patient record) but does not see address, emergency contact or marketing details.
const PATROL_HIDDEN = ['address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'emergency_name', 'emergency_phone', 'marketing_opt_in', 'marketing_opt_in_at', 'notes', 'source'];
const view = (req, p) => {
  if (!p) return p;
  const out = { ...p, has_photo: Boolean(p.has_photo) };
  if (req.auth.role !== 'patrol') return out;
  for (const k of PATROL_HIDDEN) delete out[k];
  return out;
};

async function emailTaken(req, email, exceptId) {
  if (isBlank(email)) return;
  const other = await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND email = ? AND id <> ? LIMIT 1', [req.auth.tenantId, email, exceptId || 0]);
  if (other) throw conflict('A customer with that email already exists', { person_id: other.id });
}

// ---------------------------------------------------------------- export (managers)
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
router.get('/export.csv', requireRole('manager'), async (req, res) => {
  const where = ['tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.marketing === '1') where.push('marketing_opt_in = 1 AND email IS NOT NULL');
  const data = await rows(pool, `SELECT ${COLS} FROM people WHERE ${where.join(' AND ')} ORDER BY last_name, first_name`, params);
  const cols = ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'sex', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'emergency_name', 'emergency_phone', 'discipline', 'ability_level', 'marketing_opt_in', 'marketing_opt_in_at', 'created_at'];
  await audit(pool, req, 'export', 'people', null, { rows: data.length, marketing_only: req.query.marketing === '1' });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="customers.csv"')
    .send([cols.join(','), ...data.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n'));
});

// ---------------------------------------------------------------- waivers and progress
router.post(
  '/:id/waivers',
  requireRole('manager', 'counter', 'instructor'),
  validate(z.object({ season: z.string().max(20).optional(), kind: z.string().max(40).default('general') })),
  async (req, res) => {
    const personId = paramId(req);
    if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, personId]))) throw notFound('Person');
    const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
    const season = req.body.season || seasonFor(todayIn(tenant.timezone));
    const [r] = await pool.query("INSERT INTO waivers (tenant_id, person_id, season, kind, method, recorded_by) VALUES (?, ?, ?, ?, 'recorded_by_staff', ?)", [req.auth.tenantId, personId, season, req.body.kind, req.auth.userId]);
    await audit(pool, req, 'sign_waiver', 'waivers', r.insertId, { person_id: personId, season });
    res.status(201).json({ id: r.insertId, person_id: personId, season, kind: req.body.kind });
  },
);

router.get('/:id/waivers', requireRole(...front), async (req, res) => {
  res.json({ data: (await rows(pool, `SELECT w.id, w.season, w.kind, w.signed_at, w.signed_by_name, w.signer_relation, w.method, w.signing_id, w.voided_at, w.void_reason, (${VALID('w')}) AS counts FROM waivers w WHERE w.tenant_id = ? AND w.person_id = ? ORDER BY w.signed_at DESC, w.id DESC`, [req.auth.tenantId, paramId(req)])).map((w) => ({ ...w, counts: Boolean(w.counts) })) });
});

router.get('/:id/progress', requireRole('manager', 'instructor'), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT * FROM student_progress WHERE tenant_id = ? AND person_id = ? ORDER BY recorded_at DESC', [req.auth.tenantId, paramId(req)]) });
});

/** Everything one customer has done across the mountain: purchases, tickets, lessons, rentals, programs. */
router.get('/:id/activity', requireRole(...front), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]))) throw notFound('Person');
  const [orders, tickets, lessons, rentals, programs, waivers, totals, visits] = await Promise.all([
    rows(pool, 'SELECT id, created_at, status, channel, total_cents FROM orders WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 25', [tenantId, id]),
    rows(pool, `SELECT t.code, pr.name AS product, t.valid_from, t.valid_to, t.status, t.uses_remaining FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id
                WHERE t.tenant_id = ? AND t.person_id = ? ORDER BY t.id DESC LIMIT 25`, [tenantId, id]),
    rows(pool, `SELECT b.id, b.status, s.starts_at, s.discipline, s.ability_level, pr.name AS product FROM lesson_bookings b
                JOIN lesson_sessions s ON s.id = b.session_id AND s.tenant_id = b.tenant_id JOIN products pr ON pr.id = s.product_id AND pr.tenant_id = s.tenant_id
                WHERE b.tenant_id = ? AND b.person_id = ? ORDER BY s.starts_at DESC LIMIT 25`, [tenantId, id]),
    rows(pool, 'SELECT id, status, checked_out_at, due_at FROM rental_contracts WHERE tenant_id = ? AND person_id = ? ORDER BY id DESC LIMIT 25', [tenantId, id]),
    rows(pool, `SELECT e.status, p.name, p.season FROM program_enrollments e JOIN programs p ON p.id = e.program_id AND p.tenant_id = e.tenant_id
                WHERE e.tenant_id = ? AND e.person_id = ? ORDER BY e.id DESC LIMIT 25`, [tenantId, id]),
    rows(pool, `SELECT w.season, w.kind, w.signed_at, w.voided_at, w.void_reason, (${VALID('w')}) AS counts FROM waivers w WHERE w.tenant_id = ? AND w.person_id = ? ORDER BY w.signed_at DESC LIMIT 10`, [tenantId, id]),
    one(pool, "SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS spend_cents FROM orders WHERE tenant_id = ? AND person_id = ? AND status = 'paid'", [tenantId, id]),
    one(pool, `SELECT COUNT(DISTINCT DATE(s.scanned_at)) AS days FROM scans s JOIN tickets t ON t.id = s.ticket_id AND t.tenant_id = s.tenant_id
               WHERE s.tenant_id = ? AND t.person_id = ? AND s.result = 'ok'`, [tenantId, id]),
  ]);
  res.json({ orders, tickets, lessons, rentals, programs, waivers, totals: { orders: Number(totals.orders), spend_cents: Number(totals.spend_cents), days_skied: Number(visits.days) } });
});

// ---------------------------------------------------------------- lookup: the first step of every sale, booking and patient
/**
 * "Who is this?" Type a name, a phone number or an email and get the few best matches, each with a short summary of
 * what we already know. Phone numbers match on their last 10 digits, so formatting does not matter.
 * Front-desk roles also see whether a waiver is on file and what is active today. Patrol sees the guest only
 * (patrol pulls ticket and rental details for a patient separately, and those pulls are logged).
 */
router.get('/lookup', requireRole(...readers), patrolLookup, async (req, res) => {
  const { tenantId } = req.auth;
  const q = String(Array.isArray(req.query.q) ? req.query.q[0] : req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ data: [], kind: null });
  // Patrol must search for someone specific (three letters of a name, seven digits of a phone, or an email), so the
  // customer file cannot be read two letters at a time.
  if (req.auth.role === 'patrol' && !(/[a-z]{3}/i.test(q.replace(/[^a-z\s'-]/gi, '')) || q.replace(/\D/g, '').length >= 7 || /\S+@\S+/.test(q))) return res.json({ data: [], kind: null, hint: 'Type at least three letters of a name, a phone number or an email' });
  const digits = q.replace(/\D/g, '');
  let kind = 'name';
  let where; let params; let rank;
  if (q.includes('@')) {
    kind = 'email';
    where = 'email LIKE ?'; params = [`${q.replace(/[%_]/g, '')}%`];
    rank = ['(email = ?)', [q]];
  } else if (digits.length >= 4 && digits.length >= q.replace(/[\s()+.-]/g, '').length) {
    kind = 'phone';
    where = 'phone_key LIKE ?'; params = [`%${digits.slice(-10)}`];
    rank = ['(phone_key = ?)', [digits.slice(-10)]];
  } else {
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 3).map((t) => t.replace(/[%_]/g, ''));
    where = tokens.map(() => '(first_name LIKE ? OR last_name LIKE ?)').join(' AND ');
    params = tokens.flatMap((t) => [`${t}%`, `${t}%`]);
    rank = ["(CONCAT(first_name, ' ', last_name) = ?)", [q]];
  }
  const data = await rows(pool, `SELECT ${COLS}, ${rank[0]} AS exact FROM people WHERE tenant_id = ? AND ${where} ORDER BY exact DESC, last_name, first_name LIMIT 10`, [...rank[1], tenantId, ...params]);

  let out = data.map((p) => view(req, p));
  if (req.auth.role !== 'patrol' && data.length) {
    const ids = data.map((p) => p.id);
    const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
    const today = todayIn(tenant.timezone);
    const season = seasonFor(today);
    const [waivers, tickets, rentals, flags] = await Promise.all([
      rows(pool, `SELECT DISTINCT w.person_id FROM waivers w WHERE w.tenant_id = ? AND w.season = ? AND w.person_id IN (?) AND ${VALID('w')}`, [tenantId, season, ids]),
      rows(pool, `SELECT t.person_id, pr.name FROM tickets t JOIN products pr ON pr.id = t.product_id AND pr.tenant_id = t.tenant_id
                  WHERE t.tenant_id = ? AND t.person_id IN (?) AND t.status = 'active' AND t.valid_from <= ? AND t.valid_to >= ?`, [tenantId, ids, today, today]),
      rows(pool, "SELECT DISTINCT person_id FROM rental_contracts WHERE tenant_id = ? AND person_id IN (?) AND status IN ('out','overdue')", [tenantId, ids]),
      rows(pool, 'SELECT person_id, kind, message FROM person_flags WHERE tenant_id = ? AND person_id IN (?) AND cleared_at IS NULL AND (expires_on IS NULL OR expires_on >= CURDATE()) ORDER BY id', [tenantId, ids]),
    ]);
    const wv = new Set(waivers.map((w) => w.person_id));
    const rt = new Set(rentals.map((r) => r.person_id));
    out = out.map((p) => ({ ...p, flags: flags.filter((f) => f.person_id === p.id).map((f) => ({ kind: f.kind, message: f.message })), summary: { waiver_this_season: wv.has(p.id), tickets_today: tickets.filter((t) => t.person_id === p.id).map((t) => t.name), rental_out: rt.has(p.id) } }));
  }
  out = out.map(({ exact, ...p }) => p);
  if (req.auth.role === 'patrol') await audit(pool, req, 'lookup', 'people', null, { by: kind, results: out.length });
  res.json({ data: out, kind });
});

// ---------------------------------------------------------------- the records themselves
router.get('/', requireRole(...readers), patrolLookup, async (req, res) => {
  // Patrol cannot browse the customer list: they must search for someone, and each search is logged.
  // A search must be specific (three letters of a name, seven digits of a phone or an email), and there is no paging.
  if (req.auth.role === 'patrol') {
    const q = String(req.query.q || '').trim();
    const specific = /[a-z]{3}/i.test(q.replace(/[^a-z\s'-]/gi, '')) || q.replace(/\D/g, '').length >= 7 || /\S+@\S+/.test(q);
    if (!specific) throw bad('Type at least three letters of a name, a phone number or an email to search');
    if (Number(req.query.offset) > 0) throw forbidden('Patrol searches show the first matches only. Search for a fuller name.');
    await audit(pool, req, 'lookup', 'people', null, { by: 'list' });
  }
  const where = ['tenant_id = ?'];
  const params = [req.auth.tenantId];
  const first = (v) => String(Array.isArray(v) ? v[0] : v);
  if (req.query.email) { where.push('email = ?'); params.push(first(req.query.email)); }
  if (req.query.marketing === '1') where.push('marketing_opt_in = 1');
  if (req.query.q) {
    const q = `%${first(req.query.q).replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR CONCAT(first_name, \' \', last_name) LIKE ?)');
    params.push(q, q, q, q, q);
  }
  const limit = Math.min(Number(req.query.limit) || (req.auth.role === 'patrol' ? 10 : 100), req.auth.role === 'patrol' ? 10 : 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const data = await rows(pool, `SELECT ${COLS} FROM people WHERE ${where.join(' AND ')} ORDER BY last_name, first_name LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ data: data.map((p) => view(req, p)), limit, offset });
});

// ---------------------------------------------------------------- duplicates and merge (managers)
/** Groups of customers that look like the same person: same name and birth date, or same name and phone. */
router.get('/duplicates', requireRole('manager'), async (req, res) => {
  const { tenantId } = req.auth;
  const keyed = await rows(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? ORDER BY id`, [tenantId]);
  const groups = new Map();
  const add = (k, p) => { if (!groups.has(k)) groups.set(k, []); const g = groups.get(k); if (!g.some((x) => x.id === p.id)) g.push(p); };
  for (const p of keyed) {
    const name = `${p.first_name} ${p.last_name}`.trim().toLowerCase();
    if (p.date_of_birth) add(`dob|${name}|${p.date_of_birth}`, p);
    if (p.phone_key) add(`ph|${name}|${p.phone_key}`, p);
  }
  // Merge groups that share a person so one customer is not listed twice.
  const seen = new Set();
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const ids = g.map((p) => p.id).sort((a, b) => a - b).join(',');
    if (seen.has(ids)) continue;
    seen.add(ids);
    out.push(g.map((p) => ({ id: p.id, first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth, phone: p.phone, email: p.email, created_at: p.created_at })));
  }
  res.json({ data: out.slice(0, 100) });
});

const mergeBody = z.object({ into_id: z.coerce.number().int().positive() });
// Tables where a person may only appear once per parent row: duplicates of the merged-away person are dropped.
const ONCE = [['lesson_bookings', 'person_id'], ['program_enrollments', 'person_id'], ['attendance', 'person_id']];
const MOVE = [['waivers', 'person_id'], ['waivers', 'signed_by_person_id'], ['waiver_signings', 'signer_person_id'], ['orders', 'person_id'], ['order_items', 'person_id'], ['tickets', 'person_id'], ['gift_cards', 'purchaser_id'],
  ['rental_contracts', 'person_id'], ['student_progress', 'person_id'], ['incidents', 'person_id'], ['incident_patients', 'person_id'], ['program_enrollments', 'guardian_id'],
  ['consent_events', 'person_id'], ['person_notes', 'person_id'], ['person_flags', 'person_id']];

/** Folds one customer record into another: everything they bought, signed or booked moves over, then the extra record is removed. */
router.post('/:id/merge', requireRole('manager'), validate(mergeBody), async (req, res) => {
  const { tenantId } = req.auth;
  const fromId = paramId(req);
  const toId = req.body.into_id;
  if (fromId === toId) throw bad('Pick a different customer to merge into');
  const result = await tx(async (conn) => {
    const from = await one(conn, 'SELECT * FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, fromId]);
    const to = await one(conn, 'SELECT * FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, toId]);
    if (!from || !to) throw notFound('Person');
    if (await one(conn, 'SELECT id FROM staff WHERE tenant_id = ? AND person_id = ?', [tenantId, fromId])) throw conflict('That customer is a staff member, so they cannot be merged away');
    if (await one(conn, 'SELECT id FROM users WHERE tenant_id = ? AND person_id = ?', [tenantId, fromId])) throw conflict('That customer has a sign-in, so they cannot be merged away');
    for (const [table, col] of ONCE) {
      const keyCol = table === 'attendance' ? 'session_id' : table === 'lesson_bookings' ? 'session_id' : 'program_id';
      await conn.query(`DELETE a FROM ${table} a JOIN ${table} b ON b.tenant_id = a.tenant_id AND b.${keyCol} = a.${keyCol} AND b.${col} = ? WHERE a.tenant_id = ? AND a.${col} = ?`, [toId, tenantId, fromId]);
    }
    const moved = {};
    for (const [table, col] of MOVE.concat(ONCE)) {
      const [r] = await conn.query(`UPDATE ${table} SET ${col} = ? WHERE tenant_id = ? AND ${col} = ?`, [toId, tenantId, fromId]);
      if (r.affectedRows) moved[`${table}.${col}`] = r.affectedRows;
    }
    // Family links: re-point, then drop self links and exact duplicates.
    await conn.query('UPDATE IGNORE person_links SET adult_id = ? WHERE tenant_id = ? AND adult_id = ?', [toId, tenantId, fromId]);
    await conn.query('UPDATE IGNORE person_links SET member_id = ? WHERE tenant_id = ? AND member_id = ?', [toId, tenantId, fromId]);
    await conn.query('DELETE FROM person_links WHERE tenant_id = ? AND (adult_id = ? OR member_id = ? OR adult_id = member_id)', [tenantId, fromId, fromId]);
    // Remove the extra record first (frees its email), then fill the gaps in the kept record from it.
    await conn.query('DELETE FROM people WHERE tenant_id = ? AND id = ?', [tenantId, fromId]);
    const fill = [];
    const vals = [];
    for (const k of FIELDS.map((f) => f.key).concat(['notes', 'photo'])) {
      if (['marketing_opt_in'].includes(k)) continue;
      if (isBlank(to[k]) && !isBlank(from[k])) { fill.push(`\`${k}\` = ?`); vals.push(from[k]); }
    }
    if (from.marketing_opt_in && !to.marketing_opt_in) fill.push('marketing_opt_in = 1, marketing_opt_in_at = ' + (from.marketing_opt_in_at ? conn.escape(from.marketing_opt_in_at) : 'NOW()'));
    if (fill.length) await conn.query(`UPDATE people SET ${fill.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, tenantId, toId]);
    await conn.query("INSERT INTO person_tombstones (tenant_id, old_id, kept_id, action, done_by) VALUES (?, ?, ?, 'merge', ?)", [tenantId, fromId, toId, req.auth.userId]);
    await audit(conn, req, 'merge', 'people', toId, { merged_id: fromId, moved });
    return { id: toId, merged_id: fromId, moved };
  });
  res.json(result);
});

// ---------------------------------------------------------------- photo
const photoBody = z.object({ photo: z.string().regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/, 'A JPEG photo').max(120000) });
router.get('/:id/photo', requireRole(...front), async (req, res) => {
  const p = await one(pool, 'SELECT photo FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Person');
  res.json({ photo: p.photo || null });
});
router.put('/:id/photo', requireRole(...front), validate(photoBody), async (req, res) => {
  const id = paramId(req);
  const [r] = await pool.query('UPDATE people SET photo = ? WHERE tenant_id = ? AND id = ?', [req.body.photo, req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Person');
  await audit(pool, req, 'update', 'people', id, { fields: ['photo'] });
  res.json({ id, has_photo: true });
});
router.delete('/:id/photo', requireRole('manager', 'counter'), async (req, res) => {
  const id = paramId(req);
  await pool.query('UPDATE people SET photo = NULL WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  await audit(pool, req, 'update', 'people', id, { fields: ['photo'], removed: true });
  res.json({ id, has_photo: false });
});

// ---------------------------------------------------------------- family
router.get('/:id/family', requireRole(...front), async (req, res) => {
  const id = paramId(req);
  if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Person');
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [req.auth.tenantId]);
  res.json(await familyOf(pool, req.auth.tenantId, id, todayIn(tenant.timezone)));
});
const linkBody = z.object({ other_id: z.coerce.number().int().positive(), relation: z.enum(['guardian', 'family']).default('family'), as: z.enum(['guardian_of', 'dependent_of']).default('guardian_of') });
// "other" is linked to this person. For a guardian link, as = guardian_of means this person is the guardian of other.
router.post('/:id/family', requireRole(...front), validate(linkBody), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const { other_id: otherId, relation, as } = req.body;
  if (id === otherId) throw bad('Pick a different person');
  const [a, b] = await Promise.all([one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]), one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, otherId])]);
  if (!a || !b) throw notFound('Person');
  if (relation === 'guardian' && as === 'dependent_of') await addLink(pool, tenantId, otherId, id, 'guardian');
  else await addLink(pool, tenantId, id, otherId, relation);
  await audit(pool, req, 'link', 'people', id, { other_id: otherId, relation });
  const tenant = await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  res.status(201).json(await familyOf(pool, tenantId, id, todayIn(tenant.timezone)));
});
router.delete('/:id/family/:otherId', requireRole(...front), async (req, res) => {
  const id = paramId(req);
  const other = Number(req.params.otherId);
  if (!Number.isInteger(other)) throw bad('Bad id');
  await pool.query('DELETE FROM person_links WHERE tenant_id = ? AND ((adult_id = ? AND member_id = ?) OR (adult_id = ? AND member_id = ?))', [req.auth.tenantId, id, other, other, id]);
  await audit(pool, req, 'unlink', 'people', id, { other_id: other });
  res.json({ ok: true });
});

/** What a rental counter wants at a glance: sizing on file plus the DIN used last time. */
router.get('/:id/rental-profile', requireRole(...front), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const p = await one(pool, 'SELECT id, first_name, last_name, date_of_birth, sex, height_in, weight_lb, boot_size, stance, skier_type FROM people WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!p) throw notFound('Person');
  const last = await one(pool, `SELECT ci.din_setting AS din FROM rental_contract_items ci JOIN rental_contracts c ON c.id = ci.contract_id AND c.tenant_id = ci.tenant_id WHERE c.tenant_id = ? AND c.person_id = ? AND ci.din_setting IS NOT NULL ORDER BY c.id DESC LIMIT 1`, [tenantId, id]);
  res.json({ ...p, last_din: last ? last.din : null });
});

router.get('/:id', requireRole(...readers), patrolLookup, async (req, res) => {
  const p = await one(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Person');
  if (req.auth.role === 'patrol') {
    // Patrol opens a guest's record only once that guest is a patient on a case; finding someone goes through search.
    const onCase = await one(pool, 'SELECT id FROM incident_patients WHERE tenant_id = ? AND person_id = ? LIMIT 1', [req.auth.tenantId, p.id]);
    if (!onCase) throw notFound('Person');
    await audit(pool, req, 'lookup', 'people', p.id, { by: 'id' });
  }
  res.json(view(req, p));
});

router.post('/', requireRole(...front), validate(personCreate), async (req, res) => {
  const b = req.body;
  await emailTaken(req, b.email);
  const keys = FIELDS.map((f) => f.key).concat('notes').filter((k) => k !== 'marketing_opt_in' && !isBlank(b[k]));
  const optIn = b.marketing_opt_in === true;
  const [r] = await pool.query(
    `INSERT INTO people (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}, marketing_opt_in, marketing_opt_in_at, source) VALUES (?, ${keys.map(() => '?').join(', ')}, ?, ${optIn ? 'NOW()' : 'NULL'}, 'staff')`,
    [req.auth.tenantId, ...keys.map((k) => b[k]), optIn ? 1 : 0],
  );
  if (optIn) await recordConsent(pool, req.auth.tenantId, r.insertId, 'email', 'opted_in', 'staff_form', who(req));
  await audit(pool, req, 'create', 'people', r.insertId);
  res.status(201).json(await one(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, r.insertId]));
});

router.patch('/:id', requireRole(...front), validate(personUpdate), async (req, res) => {
  const id = paramId(req);
  const b = req.body;
  const cur = await one(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, id]);
  if (!cur) throw notFound('Person');
  if (b.email !== undefined) await emailTaken(req, b.email, id);
  const set = [];
  const vals = [];
  for (const k of FIELDS.map((f) => f.key).concat('notes')) {
    if (k === 'marketing_opt_in' || b[k] === undefined) continue;
    if (['first_name', 'last_name'].includes(k) && isBlank(b[k])) continue;
    set.push(`\`${k}\` = ?`);
    vals.push(isBlank(b[k]) ? null : b[k]);
  }
  if (b.marketing_opt_in === true && !cur.marketing_opt_in) set.push('marketing_opt_in = 1, marketing_opt_in_at = NOW()');
  if (b.marketing_opt_in === false && cur.marketing_opt_in) set.push('marketing_opt_in = 0');
  if (!set.length) throw bad('No updatable fields supplied');
  if (cur.anonymised_at) throw conflict('This customer has been anonymised and can no longer be edited');
  await pool.query(`UPDATE people SET ${set.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, req.auth.tenantId, id]);
  if (b.marketing_opt_in === true && !cur.marketing_opt_in) await recordConsent(pool, req.auth.tenantId, id, 'email', 'opted_in', 'staff_form', who(req));
  if (b.marketing_opt_in === false && cur.marketing_opt_in) await recordConsent(pool, req.auth.tenantId, id, 'email', 'opted_out', 'staff_form', who(req));
  await audit(pool, req, 'update', 'people', id, { fields: Object.keys(b) });
  res.json(await one(pool, `SELECT ${COLS} FROM people WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, id]));
});

module.exports = router;
