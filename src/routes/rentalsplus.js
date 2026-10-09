'use strict';

// Rentals beyond the basic counter: settings, sizing profiles, binding chart, reservations,
// extensions and swaps, fees, service log, reports and bulk import. Mounted inside routes/rentals.js.
const { ON_FILE } = require('../lib/waivers');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime, todayIn, addDays, seasonFor, nowIn } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const R = require('../lib/rentals');

const router = express.Router();
const counter = ['counter', 'manager'];
const manager = ['manager'];
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---- Settings -------------------------------------------------------------------------------
const settingsSchema = z.object({
  late_fee_cents_per_day: z.number().int().min(0).max(100000),
  late_grace_minutes: z.number().int().min(0).max(1440),
  require_binding_record: z.boolean(),
  service_every_uses: z.number().int().min(0).max(1000),
  default_deposit_cents: z.number().int().min(0).max(1000000),
  hold_until_hour: z.number().int().min(0).max(23),
});

router.get('/settings', requireRole(...counter), async (req, res) => res.json(await R.getSettings(pool, req.auth.tenantId)));

router.put('/settings', requireRole(...manager), validate(settingsSchema.partial()), async (req, res) => {
  const { tenantId } = req.auth;
  const next = { ...(await R.getSettings(pool, tenantId)), ...req.body };
  await pool.query(
    `INSERT INTO rental_settings (tenant_id, late_fee_cents_per_day, late_grace_minutes, require_binding_record, service_every_uses, default_deposit_cents, hold_until_hour)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE late_fee_cents_per_day = VALUES(late_fee_cents_per_day), late_grace_minutes = VALUES(late_grace_minutes),
     require_binding_record = VALUES(require_binding_record), service_every_uses = VALUES(service_every_uses), default_deposit_cents = VALUES(default_deposit_cents), hold_until_hour = VALUES(hold_until_hour)`,
    [tenantId, next.late_fee_cents_per_day, next.late_grace_minutes, next.require_binding_record ? 1 : 0, next.service_every_uses, next.default_deposit_cents, next.hold_until_hour],
  );
  await audit(pool, req, 'update', 'rental_settings', tenantId, req.body);
  res.json(await R.getSettings(pool, tenantId));
});

// ---- Sizing profiles --------------------------------------------------------------------------
const profileSchema = z.object({
  skier_type: z.string().max(4).nullable().optional(),
  boot_sole_mm: z.number().int().min(150).max(400).nullable().optional(),
  shoe_size: z.string().max(20).nullable().optional(),
  stance: z.string().max(20).nullable().optional(),
  helmet_size: z.string().max(20).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
const PROFILE_COLS = ['skier_type', 'boot_sole_mm', 'shoe_size', 'stance', 'helmet_size', 'notes'];

router.get('/profiles/:personId', requireRole(...counter), async (req, res) => {
  const p = await one(pool, 'SELECT * FROM rental_profiles WHERE tenant_id = ? AND person_id = ?', [req.auth.tenantId, paramId(req, 'personId')]);
  const person = await one(pool, 'SELECT id, first_name, last_name, date_of_birth FROM people WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req, 'personId')]);
  if (!person) throw notFound('Person');
  res.json({ person, profile: p || null });
});

router.put('/profiles/:personId', requireRole(...counter), validate(profileSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const personId = paramId(req, 'personId');
  if (!(await one(pool, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, personId]))) throw notFound('Person');
  const vals = PROFILE_COLS.map((c) => req.body[c] ?? null);
  await pool.query(
    `INSERT INTO rental_profiles (tenant_id, person_id, ${PROFILE_COLS.join(', ')}) VALUES (?, ?, ${PROFILE_COLS.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${PROFILE_COLS.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [tenantId, personId, ...vals],
  );
  res.json({ ok: true });
});

// ---- Binding chart (entered by the shop; the app ships no release values) ------------------------------
const chartRow = z.object({
  skier_type: z.string().min(1).max(4),
  weight_lb_min: z.number().int().min(0).max(500).nullable().optional(),
  weight_lb_max: z.number().int().min(0).max(500).nullable().optional(),
  height_in_min: z.number().int().min(0).max(100).nullable().optional(),
  height_in_max: z.number().int().min(0).max(100).nullable().optional(),
  sole_mm_min: z.number().int().min(0).max(400).nullable().optional(),
  sole_mm_max: z.number().int().min(0).max(400).nullable().optional(),
  din: z.number().min(0.5).max(20),
});

router.get('/chart', requireRole(...counter), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT * FROM binding_chart WHERE tenant_id = ? ORDER BY skier_type, weight_lb_min, id', [req.auth.tenantId]) });
});

router.put('/chart', requireRole(...manager), validate(z.object({ rows: z.array(chartRow).max(500) })), async (req, res) => {
  const { tenantId } = req.auth;
  await tx(async (conn) => {
    await conn.query('DELETE FROM binding_chart WHERE tenant_id = ?', [tenantId]);
    for (const r of req.body.rows) {
      await conn.query(
        'INSERT INTO binding_chart (tenant_id, skier_type, weight_lb_min, weight_lb_max, height_in_min, height_in_max, sole_mm_min, sole_mm_max, din) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, r.skier_type, r.weight_lb_min ?? null, r.weight_lb_max ?? null, r.height_in_min ?? null, r.height_in_max ?? null, r.sole_mm_min ?? null, r.sole_mm_max ?? null, r.din],
      );
    }
    await audit(conn, req, 'update', 'binding_chart', tenantId, { rows: req.body.rows.length });
  });
  res.json({ rows: req.body.rows.length });
});

/** Looks up the shop's own chart. Advisory only: the technician still records what they actually set. */
router.get('/chart/suggest', requireRole(...counter), async (req, res) => {
  const n = (k) => (req.query[k] === undefined || req.query[k] === '' ? null : Number(req.query[k]));
  const [w, h, s] = [n('weight_lb'), n('height_in'), n('sole_mm')];
  const type = String(req.query.skier_type || '');
  const data = await rows(
    pool,
    `SELECT * FROM binding_chart WHERE tenant_id = ? AND skier_type = ?
       AND (weight_lb_min IS NULL OR ? IS NULL OR weight_lb_min <= ?) AND (weight_lb_max IS NULL OR ? IS NULL OR weight_lb_max >= ?)
       AND (height_in_min IS NULL OR ? IS NULL OR height_in_min <= ?) AND (height_in_max IS NULL OR ? IS NULL OR height_in_max >= ?)
       AND (sole_mm_min IS NULL OR ? IS NULL OR sole_mm_min <= ?) AND (sole_mm_max IS NULL OR ? IS NULL OR sole_mm_max >= ?)`,
    [req.auth.tenantId, type, w, w, w, w, h, h, h, h, s, s, s, s],
  );
  res.json({ data });
});

// ---- Reservations ---------------------------------------------------------------------------
const lineSchema = z.object({
  category: z.enum(R.CATEGORIES),
  tier: z.enum(R.TIERS).default('standard'),
  quantity: z.number().int().min(1).max(100).default(1),
  for_person_id: z.number().int().positive().optional(),
  size_note: z.string().max(60).optional(),
});

router.post(
  '/reservations',
  requireRole(...counter),
  validate(z.object({ person_id: z.number().int().positive(), pickup_on: dateStr, days: z.number().int().min(1).max(60), notes: z.string().max(500).optional(), lines: z.array(lineSchema).min(1).max(60) })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const b = req.body;
    const id = await tx(async (conn) => {
      if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, b.person_id]))) throw notFound('Person');
      // capacity check per category/tier: fleet in service minus other holds overlapping this window
      for (const l of b.lines) {
        const free = await availableFor(conn, tenantId, l.category, l.tier, b.pickup_on, b.days);
        const asking = b.lines.filter((x) => x.category === l.category && x.tier === l.tier).reduce((a, x) => a + x.quantity, 0);
        if (asking > free) throw conflict(`Only ${Math.max(free, 0)} ${l.tier} ${l.category} item${free === 1 ? '' : 's'} free for those dates`);
      }
      const [r] = await conn.query('INSERT INTO rental_reservations (tenant_id, person_id, pickup_on, days, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, b.person_id, b.pickup_on, b.days, b.notes ?? null, req.auth.userId ?? null]);
      for (const l of b.lines) {
        await conn.query('INSERT INTO rental_reservation_lines (tenant_id, reservation_id, category, tier, quantity, for_person_id, size_note) VALUES (?, ?, ?, ?, ?, ?, ?)', [tenantId, r.insertId, l.category, l.tier, l.quantity, l.for_person_id ?? null, l.size_note ?? null]);
      }
      await audit(conn, req, 'create', 'rental_reservations', r.insertId, { pickup_on: b.pickup_on, days: b.days });
      return r.insertId;
    });
    res.status(201).json({ id });
  },
);

/** Gear of one kind that is free for a date window: in-service fleet minus other holds and gear still out. */
async function availableFor(conn, tenantId, category, tier, pickupOn, days, excludeId = 0) {
  const fleet = (await one(conn, "SELECT COUNT(*) AS n FROM rental_items WHERE tenant_id = ? AND category = ? AND tier = ? AND status IN ('available','rented')", [tenantId, category, tier])).n;
  const end = addDays(pickupOn, days - 1);
  const held = (
    await one(
      conn,
      `SELECT COALESCE(SUM(l.quantity), 0) AS n FROM rental_reservation_lines l JOIN rental_reservations r ON r.id = l.reservation_id AND r.tenant_id = l.tenant_id
       WHERE l.tenant_id = ? AND l.category = ? AND l.tier = ? AND r.status = 'held' AND r.id <> ? AND r.pickup_on <= ? AND DATE_ADD(r.pickup_on, INTERVAL r.days - 1 DAY) >= ?`,
      [tenantId, category, tier, excludeId, end, pickupOn],
    )
  ).n;
  const out = (
    await one(
      conn,
      `SELECT COUNT(*) AS n FROM rental_contract_items li JOIN rental_contracts c ON c.id = li.contract_id AND c.tenant_id = li.tenant_id
       JOIN rental_items i ON i.id = li.rental_item_id AND i.tenant_id = li.tenant_id
       WHERE li.tenant_id = ? AND li.returned_at IS NULL AND i.category = ? AND i.tier = ? AND DATE(c.due_at) >= ?`,
      [tenantId, category, tier, pickupOn],
    )
  ).n;
  return Number(fleet) - Number(held) - Number(out);
}

router.get('/availability', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from)) ? String(req.query.from) : todayIn(await tzOf(tenantId));
  const days = Math.min(Math.max(Number(req.query.days) || 1, 1), 60);
  const kinds = await rows(pool, "SELECT category, tier FROM rental_items WHERE tenant_id = ? AND status IN ('available','rented') GROUP BY category, tier ORDER BY category, tier", [tenantId]);
  const data = [];
  for (const k of kinds) data.push({ ...k, free: Math.max(await availableFor(pool, tenantId, k.category, k.tier, from, days), 0) });
  res.json({ from, days, data });
});

router.get('/reservations', requireRole(...counter), async (req, res) => {
  const where = ['r.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.status) { where.push('r.status = ?'); params.push(String(req.query.status)); }
  if (req.query.from) { where.push('r.pickup_on >= ?'); params.push(String(req.query.from)); }
  const data = await rows(
    pool,
    `SELECT r.*, p.first_name, p.last_name FROM rental_reservations r JOIN people p ON p.id = r.person_id AND p.tenant_id = r.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY r.pickup_on, r.id LIMIT 300`,
    params,
  );
  if (data.length) {
    const lines = await rows(pool, 'SELECT * FROM rental_reservation_lines WHERE tenant_id = ? AND reservation_id IN (?)', [req.auth.tenantId, data.map((d) => d.id)]);
    for (const d of data) d.lines = lines.filter((l) => l.reservation_id === d.id);
  }
  res.json({ data });
});

router.get('/reservations/:id', requireRole(...counter), async (req, res) => {
  const r = await one(pool, 'SELECT * FROM rental_reservations WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r) throw notFound('Reservation');
  r.lines = await rows(pool, 'SELECT * FROM rental_reservation_lines WHERE tenant_id = ? AND reservation_id = ?', [req.auth.tenantId, r.id]);
  res.json(r);
});

router.patch('/reservations/:id', requireRole(...counter), validate(z.object({ status: z.enum(['cancelled', 'no_show']).optional(), notes: z.string().max(500).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  await tx(async (conn) => {
    const r = await one(conn, 'SELECT * FROM rental_reservations WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!r) throw notFound('Reservation');
    if (req.body.status && r.status !== 'held') throw conflict(`That reservation is already ${r.status.replace('_', ' ')}`);
    await conn.query('UPDATE rental_reservations SET status = COALESCE(?, status), notes = COALESCE(?, notes) WHERE tenant_id = ? AND id = ?', [req.body.status ?? null, req.body.notes ?? null, tenantId, id]);
    await audit(conn, req, 'update', 'rental_reservations', id, req.body);
  });
  res.json({ ok: true });
});

// ---- Extend and swap ------------------------------------------------------------------------
router.post('/contracts/:id/extend', requireRole(...counter), validate(z.object({ due_at: dateTimeStr })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const dueAt = normDateTime(req.body.due_at);
  await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!c) throw notFound('Contract');
    if (c.status === 'returned') throw conflict('That contract is already returned');
    if (dueAt <= String(c.due_at)) throw bad('The new return time must be later than the current one');
    await conn.query('UPDATE rental_contracts SET due_at = ? WHERE tenant_id = ? AND id = ?', [dueAt, tenantId, id]);
    await audit(conn, req, 'extend', 'rental_contracts', id, { from: c.due_at, to: dueAt });
  });
  res.json({ due_at: dueAt });
});

router.post(
  '/contracts/:id/swap',
  requireRole(...counter),
  validate(z.object({ out_item_id: z.number().int().positive(), reason: z.string().max(200).optional(), damaged: z.boolean().optional(), replacement: R.gearLine })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const id = paramId(req);
    await tx(async (conn) => {
      const c = await one(conn, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!c) throw notFound('Contract');
      if (c.status === 'returned') throw conflict('That contract is already returned');
      const line = await one(conn, 'SELECT * FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND rental_item_id = ? AND returned_at IS NULL', [tenantId, id, req.body.out_item_id]);
      if (!line) throw bad('That item is not outstanding on this contract');
      const incoming = await R.insertGear(conn, tenantId, id, [{ person_id: line.person_id ?? undefined, ...req.body.replacement }], await R.getSettings(conn, tenantId));
      await conn.query('UPDATE rental_contract_items SET returned_at = NOW(), swap_reason = ? WHERE id = ? AND tenant_id = ?', [req.body.reason ?? 'Swapped', line.id, tenantId]);
      await conn.query('UPDATE rental_items SET status = ? WHERE tenant_id = ? AND id = ?', [req.body.damaged ? 'maintenance' : 'available', tenantId, req.body.out_item_id]);
      await audit(conn, req, 'swap', 'rental_contracts', id, { out: req.body.out_item_id, in: incoming[0].id });
    });
    res.json({ ok: true });
  },
);

// ---- Fees and deposits ----------------------------------------------------------------------
router.get('/contracts/:id/charges', requireRole(...counter), async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT * FROM rental_charges WHERE tenant_id = ? AND contract_id = ? ORDER BY id', [req.auth.tenantId, paramId(req)]) });
});

router.post(
  '/contracts/:id/charges',
  requireRole(...counter),
  validate(z.object({ kind: z.enum(['late', 'damage', 'loss', 'other']), cents: z.number().int().min(1).max(1_000_000), note: z.string().max(250).optional() })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const id = paramId(req);
    if (!(await one(pool, 'SELECT id FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, id]))) throw notFound('Contract');
    const [r] = await pool.query('INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, ?, ?, ?)', [tenantId, id, req.body.kind, req.body.cents, req.body.note ?? null]);
    await audit(pool, req, 'create', 'rental_charges', r.insertId, req.body);
    res.status(201).json({ id: r.insertId });
  },
);

/** Takes payment for a fee (or returns a deposit). Fees become a paid order so they appear in sales reports. */
router.post('/charges/:id/collect', requireRole(...counter), validate(z.object({ method: z.enum(['cash', 'card', 'other']) })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const orderId = await tx(async (conn) => {
    const ch = await one(conn, 'SELECT * FROM rental_charges WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!ch) throw notFound('Charge');
    if (ch.status !== 'due') throw conflict(`That charge is already ${ch.status}`);
    const contract = await one(conn, 'SELECT person_id FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, ch.contract_id]);
    // a deposit is held, not sold: record it as paid without creating a sale
    let oid = null;
    if (ch.kind !== 'deposit') {
      const [o] = await conn.query("INSERT INTO orders (tenant_id, person_id, status, subtotal_cents, total_cents, user_id, channel, payment_ref) VALUES (?, ?, 'paid', ?, ?, ?, 'window', ?)", [tenantId, contract.person_id, ch.cents, ch.cents, req.auth.userId ?? null, req.body.method]);
      oid = o.insertId;
      await conn.query("INSERT INTO order_items (tenant_id, order_id, line_kind, person_id, contract_id, unit_price_cents) VALUES (?, ?, 'rental', ?, ?, ?)", [tenantId, oid, contract.person_id, ch.contract_id, ch.cents]);
    }
    await conn.query("UPDATE rental_charges SET status = 'paid', order_id = ?, resolved_at = NOW() WHERE tenant_id = ? AND id = ?", [oid, tenantId, id]);
    await audit(conn, req, 'collect', 'rental_charges', id, { method: req.body.method, cents: ch.cents });
    return oid;
  });
  res.json({ order_id: orderId });
});

router.post('/charges/:id/waive', requireRole(...manager), validate(z.object({ note: z.string().max(250).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const [r] = await pool.query("UPDATE rental_charges SET status = 'waived', resolved_at = NOW(), note = COALESCE(?, note) WHERE tenant_id = ? AND id = ? AND status = 'due'", [req.body.note ?? null, tenantId, id]);
  if (!r.affectedRows) throw conflict('That charge is not waiting for payment');
  await audit(pool, req, 'waive', 'rental_charges', id, req.body);
  res.json({ ok: true });
});

router.get('/charges', requireRole(...counter), async (req, res) => {
  const data = await rows(
    pool,
    `SELECT ch.*, p.first_name, p.last_name FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
     JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id WHERE ch.tenant_id = ? AND ch.status = ? ORDER BY ch.id DESC LIMIT 200`,
    [req.auth.tenantId, req.query.status === 'paid' ? 'paid' : 'due'],
  );
  res.json({ data });
});

// ---- Service ----------------------------------------------------------------------------------
router.get('/service', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const settings = await R.getSettings(pool, tenantId);
  const inShop = await rows(pool, "SELECT * FROM rental_items WHERE tenant_id = ? AND status = 'maintenance' ORDER BY category, sku", [tenantId]);
  const due = settings.service_every_uses
    ? await rows(pool, "SELECT * FROM rental_items WHERE tenant_id = ? AND status IN ('available','maintenance') AND uses_count - uses_at_service >= ? ORDER BY uses_count - uses_at_service DESC LIMIT 200", [tenantId, settings.service_every_uses])
    : [];
  res.json({ in_shop: inShop, due, service_every_uses: settings.service_every_uses });
});

router.post(
  '/items/:id/service',
  requireRole(...counter),
  validate(z.object({ kind: z.enum(['tune', 'wax', 'repair', 'binding_test', 'inspection', 'other']), notes: z.string().max(500).optional(), cost_cents: z.number().int().min(0).max(1_000_000).optional(), done_by: z.string().max(100).optional(), return_to_rack: z.boolean().optional() })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const id = paramId(req);
    await tx(async (conn) => {
      const it = await one(conn, 'SELECT * FROM rental_items WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
      if (!it) throw notFound('Rental item');
      await conn.query('INSERT INTO rental_service_log (tenant_id, rental_item_id, kind, notes, cost_cents, done_by) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, id, req.body.kind, req.body.notes ?? null, req.body.cost_cents ?? 0, req.body.done_by ?? null]);
      await conn.query('UPDATE rental_items SET uses_at_service = uses_count, last_service_at = NOW() WHERE tenant_id = ? AND id = ?', [tenantId, id]);
      if (req.body.return_to_rack && it.status === 'maintenance') await conn.query("UPDATE rental_items SET status = 'available' WHERE tenant_id = ? AND id = ?", [tenantId, id]);
      await audit(conn, req, 'service', 'rental_items', id, { kind: req.body.kind });
    });
    res.status(201).json({ ok: true });
  },
);

router.get('/items/:id/history', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const item = await one(pool, 'SELECT * FROM rental_items WHERE tenant_id = ? AND id = ?', [tenantId, id]);
  if (!item) throw notFound('Rental item');
  const service = await rows(pool, 'SELECT * FROM rental_service_log WHERE tenant_id = ? AND rental_item_id = ? ORDER BY done_at DESC LIMIT 100', [tenantId, id]);
  const rentals = await rows(
    pool,
    `SELECT li.contract_id, li.din_setting, li.tech_name, li.returned_at, li.damage_notes, c.checked_out_at AS created_at, p.first_name, p.last_name
     FROM rental_contract_items li JOIN rental_contracts c ON c.id = li.contract_id AND c.tenant_id = li.tenant_id
     JOIN people p ON p.id = COALESCE(li.person_id, c.person_id) AND p.tenant_id = li.tenant_id
     WHERE li.tenant_id = ? AND li.rental_item_id = ? ORDER BY li.id DESC LIMIT 50`,
    [tenantId, id],
  );
  res.json({ item, service, rentals });
});

// ---- Scan lookup ------------------------------------------------------------------------------
router.get('/lookup', requireRole(...counter), async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) throw bad('Scan or type a code');
  const item = await one(pool, 'SELECT * FROM rental_items WHERE tenant_id = ? AND (sku = ? OR serial_no = ?) LIMIT 1', [req.auth.tenantId, code, code]);
  if (!item) throw notFound('Rental item');
  const out = await one(
    pool,
    `SELECT li.contract_id FROM rental_contract_items li WHERE li.tenant_id = ? AND li.rental_item_id = ? AND li.returned_at IS NULL LIMIT 1`,
    [req.auth.tenantId, item.id],
  );
  res.json({ item, contract_id: out ? out.contract_id : null });
});

// ---- Pickup: scan a receipt or ticket and see everything about the order and the people on it -------------------
const ageOn = (dob, today) => {
  if (!dob) return null;
  const d = String(dob).slice(0, 10); const t = String(today).slice(0, 10);
  let a = Number(t.slice(0, 4)) - Number(d.slice(0, 4));
  if (t.slice(5) < d.slice(5)) a -= 1;
  return a;
};

router.get('/pickup', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const code = String(req.query.code || '').trim();
  if (!code) throw bad('Scan the receipt or type the order number');
  let orderId = null;
  const m = /^(?:ORD-?)?(\d{1,12})$/i.exec(code);
  if (m && /^ORD/i.test(code)) orderId = Number(m[1]);
  else if (m && code.length < 10) orderId = Number(m[1]); // a typed order number
  if (!orderId) {
    const t = await one(pool, 'SELECT oi.order_id FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id AND oi.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.code = ?', [tenantId, code]);
    if (t) orderId = t.order_id;
  }
  if (!orderId) throw notFound('Order');
  const order = await one(pool, 'SELECT id, person_id, status, total_cents, refunded_cents, channel, created_at FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, orderId]);
  if (!order) throw notFound('Order');
  const tz = await tzOf(tenantId);
  const today = todayIn(tz);
  const lines = await rows(
    pool,
    `SELECT oi.id, oi.line_kind, oi.person_id, oi.tier, oi.quantity, oi.valid_on, oi.refunded_at, oi.contract_id, COALESCE(oi.label, p.name, CASE oi.line_kind WHEN 'gift_card' THEN 'Gift card' WHEN 'rental' THEN 'Rental charge' WHEN 'fee' THEN 'Fee' ELSE '' END) AS name
     FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id AND p.tenant_id = oi.tenant_id WHERE oi.tenant_id = ? AND oi.order_id = ? ORDER BY oi.id`,
    [tenantId, orderId],
  );
  const ids = [...new Set([order.person_id, ...lines.map((l) => l.person_id)].filter(Boolean))];
  const season = seasonFor(today);
  const people = [];
  for (const pid of ids) {
    const p = await one(pool, 'SELECT id, first_name, last_name, email, phone, date_of_birth, height_in, weight_lb, boot_size, stance, skier_type, photo, emergency_name, emergency_phone, discipline, ability_level FROM people WHERE tenant_id = ? AND id = ?', [tenantId, pid]);
    if (!p) continue;
    const waiver = await one(pool, ON_FILE, [tenantId, pid, season]);
    const profile = await one(pool, 'SELECT * FROM rental_profiles WHERE tenant_id = ? AND person_id = ?', [tenantId, pid]);
    people.push({ ...p, age: ageOn(p.date_of_birth, today), is_buyer: pid === order.person_id, waiver_signed: Boolean(waiver), rental_profile: profile || null });
  }
  const contractIds = [...new Set(lines.map((l) => l.contract_id).filter(Boolean))];
  const contracts = [];
  for (const cid of contractIds) {
    const c = await one(pool, 'SELECT id, person_id, status, due_at, deposit_cents, group_name FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, cid]);
    if (!c) continue;
    c.items = await rows(
      pool,
      `SELECT li.rental_item_id, li.person_id, li.din_setting, li.tech_name, li.set_at, li.test_result, li.returned_at, li.boot_sole_mm, li.skier_type, r.sku, r.category, r.brand, r.model, r.size, r.tier
       FROM rental_contract_items li JOIN rental_items r ON r.id = li.rental_item_id AND r.tenant_id = li.tenant_id WHERE li.tenant_id = ? AND li.contract_id = ? ORDER BY li.id`,
      [tenantId, cid],
    );
    contracts.push(c);
  }
  const settings = await R.getSettings(pool, tenantId);
  await audit(pool, req, 'view', 'orders', orderId, { via: 'rental pickup' });
  res.json({ order, lines, people, contracts, season, require_binding_record: settings.require_binding_record });
});

/** Record the fitting on gear already handed out: binding setting, who set it, test result, sole length. */
router.patch(
  '/contracts/:id/items/:itemId',
  requireRole(...counter),
  validate(z.object({
    din_setting: z.number().min(0.5).max(20).optional(),
    tech_name: z.string().max(100).optional(),
    test_result: z.enum(['pass', 'fail']).optional(),
    boot_sole_mm: z.number().int().min(150).max(400).optional(),
    skier_type: z.string().max(4).optional(),
  })),
  async (req, res) => {
    const { tenantId } = req.auth;
    const b = req.body;
    const line = await one(pool, 'SELECT id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND rental_item_id = ? AND returned_at IS NULL', [tenantId, paramId(req), paramId(req, 'itemId')]);
    if (!line) throw notFound('Outstanding rental line');
    await pool.query(
      `UPDATE rental_contract_items SET din_setting = COALESCE(?, din_setting), tech_name = COALESCE(?, tech_name), test_result = COALESCE(?, test_result),
         boot_sole_mm = COALESCE(?, boot_sole_mm), skier_type = COALESCE(?, skier_type), set_at = IF(? IS NULL, set_at, NOW()) WHERE tenant_id = ? AND id = ?`,
      [b.din_setting ?? null, b.tech_name ?? null, b.test_result ?? null, b.boot_sole_mm ?? null, b.skier_type ?? null, b.din_setting ?? null, tenantId, line.id],
    );
    await audit(pool, req, 'fit', 'rental_contracts', paramId(req), { rental_item_id: paramId(req, 'itemId'), test_result: b.test_result });
    res.json({ ok: true, failed: b.test_result === 'fail' });
  },
);

// ---- Reports ----------------------------------------------------------------------------------
router.get('/reports', requireRole(...manager), async (req, res) => {
  const { tenantId } = req.auth;
  const today = todayIn(await tzOf(tenantId));
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
  const from = ok(req.query.from) ? String(req.query.from) : addDays(today, -29);
  const to = ok(req.query.to) ? String(req.query.to) : today;
  const range = [tenantId, from, `${to} 23:59:59`];
  const fleet = await rows(pool, "SELECT category, tier, status, COUNT(*) AS n FROM rental_items WHERE tenant_id = ? GROUP BY category, tier, status ORDER BY category, tier", [tenantId]);
  const contracts = await one(pool, 'SELECT COUNT(*) AS n FROM rental_contracts WHERE tenant_id = ? AND checked_out_at BETWEEN ? AND ?', range);
  const pieces = await rows(
    pool,
    `SELECT i.category, COUNT(*) AS n FROM rental_contract_items li JOIN rental_contracts c ON c.id = li.contract_id AND c.tenant_id = li.tenant_id
     JOIN rental_items i ON i.id = li.rental_item_id AND i.tenant_id = li.tenant_id WHERE li.tenant_id = ? AND c.checked_out_at BETWEEN ? AND ? GROUP BY i.category ORDER BY n DESC`,
    range,
  );
  const fees = await rows(pool, "SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(cents), 0) AS cents FROM rental_charges WHERE tenant_id = ? AND created_at BETWEEN ? AND ? GROUP BY kind, status", range);
  const reservations = await rows(pool, 'SELECT status, COUNT(*) AS n FROM rental_reservations WHERE tenant_id = ? AND pickup_on BETWEEN ? AND ? GROUP BY status', [tenantId, from, to]);
  const topItems = await rows(
    pool,
    `SELECT i.id, i.sku, i.category, i.brand, i.model, COUNT(*) AS n FROM rental_contract_items li JOIN rental_contracts c ON c.id = li.contract_id AND c.tenant_id = li.tenant_id
     JOIN rental_items i ON i.id = li.rental_item_id AND i.tenant_id = li.tenant_id WHERE li.tenant_id = ? AND c.checked_out_at BETWEEN ? AND ? GROUP BY i.id ORDER BY n DESC LIMIT 10`,
    range,
  );
  const damaged = await one(pool, 'SELECT COUNT(*) AS n FROM rental_contract_items WHERE tenant_id = ? AND damage_notes IS NOT NULL AND returned_at BETWEEN ? AND ?', range);
  const overdue = await rows(
    pool,
    `SELECT c.id, c.due_at, p.first_name, p.last_name FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
     WHERE c.tenant_id = ? AND c.status = 'out' AND c.due_at < ? ORDER BY c.due_at LIMIT 50`,
    [tenantId, nowIn(await tzOf(tenantId))],
  );
  res.json({ from, to, fleet, contracts: contracts.n, pieces, fees, reservations, top_items: topItems, damaged: damaged.n, overdue });
});

// ---- Bulk import ------------------------------------------------------------------------------
const importRow = z.object({
  sku: z.string().min(1).max(60),
  category: z.enum(R.CATEGORIES),
  brand: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  size: z.string().max(30).optional(),
  serial_no: z.string().max(80).optional(),
  tier: z.enum(R.TIERS).optional(),
  boot_sole_mm: z.number().int().min(150).max(400).optional(),
  location: z.string().max(60).optional(),
});

router.post('/items/import', requireRole(...manager), validate(z.object({ rows: z.array(importRow).min(1).max(1000) })), async (req, res) => {
  const { tenantId } = req.auth;
  let added = 0;
  const skipped = [];
  await tx(async (conn) => {
    for (const r of req.body.rows) {
      const [x] = await conn.query(
        `INSERT IGNORE INTO rental_items (tenant_id, sku, category, brand, model, size, serial_no, tier, boot_sole_mm, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, r.sku, r.category, r.brand ?? null, r.model ?? null, r.size ?? null, r.serial_no ?? null, r.tier ?? 'standard', r.boot_sole_mm ?? null, r.location ?? null],
      );
      if (x.affectedRows) added += 1; else skipped.push(r.sku);
    }
    await audit(conn, req, 'import', 'rental_items', 0, { added, skipped: skipped.length });
  });
  res.json({ added, skipped });
});

module.exports = router;
