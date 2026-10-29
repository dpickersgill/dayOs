'use strict';

const { ON_FILE } = require('../lib/waivers');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { crud } = require('../lib/crud');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateTimeStr, validate, paramId, normDateTime, seasonFor, todayIn } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const R = require('../lib/rentals');
const F = require('../lib/rentalfit');
const RR = require('../lib/rentalreturn');

const router = express.Router();
const counter = ['counter', 'manager'];

const itemFields = {
  sku: z.string().min(1).max(60),
  category: z.enum(R.CATEGORIES),
  brand: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  size: z.string().max(30).nullable().optional(),
  status: z.enum(['available', 'rented', 'maintenance', 'lost', 'retired']).optional(),
  notes: z.string().max(500).nullable().optional(),
  serial_no: z.string().max(80).nullable().optional(),
  tier: z.enum(R.TIERS).optional(),
  boot_sole_mm: z.number().int().min(150).max(400).nullable().optional(),
  purchased_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  cost_cents: z.number().int().min(0).nullable().optional(),
  grade: z.enum(['A', 'B', 'C', 'D']).nullable().optional(),
  location: z.string().max(60).nullable().optional(),
};

/** Check out gear. Items are locked, verified available, and marked rented in one transaction. */
router.post(
  '/contracts',
  requireRole(...counter),
  validate(
    z.object({
      person_id: z.number().int().positive(),
      order_id: z.number().int().positive().optional(),
      reservation_id: z.number().int().positive().optional(),
      group_name: z.string().max(120).optional(),
      deposit_cents: z.number().int().min(0).max(1_000_000).optional(),
      notes: z.string().max(500).optional(),
      // gear out with nothing paid: managers only, and they say why
      unpaid_reason: z.string().max(200).optional(),
      due_at: dateTimeStr,
      items: z.array(R.gearLine).min(1).max(60),
    }),
  ),
  async (req, res) => {
    const { tenantId } = req.auth;
    const { person_id, order_id, items } = req.body;
    const dueAt = normDateTime(req.body.due_at);
    const unpaid = F.unpaidCheck(req, req.body);

    const created = await tx(async (conn) => {
      if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ?', [tenantId, person_id]))) throw notFound('Person');
      const tenant = await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
      const season = seasonFor(todayIn(tenant.timezone));
      // everyone who will wear the gear needs a waiver, not only the person paying
      const everyone = [...new Set([person_id, ...items.map((i) => i.person_id).filter(Boolean)])];
      for (const pid of everyone) {
        if (!(await one(conn, ON_FILE, [tenantId, pid, season]))) {
          const who = pid === person_id ? 'the renter' : `person ${pid}`;
          throw conflict(`No signed waiver on file for ${who} for the ${season} season`);
        }
      }
      const settings = await R.getSettings(conn, tenantId);
      const deposit = req.body.deposit_cents ?? settings.default_deposit_cents;
      let reservation = null;
      if (req.body.reservation_id) {
        reservation = await one(conn, 'SELECT * FROM rental_reservations WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, req.body.reservation_id]);
        if (!reservation) throw notFound('Reservation');
        if (reservation.status !== 'held') throw conflict(`That reservation is already ${reservation.status.replace('_', ' ')}`);
      }
      const [c] = await conn.query(
        'INSERT INTO rental_contracts (tenant_id, person_id, order_id, due_at, group_name, deposit_cents, reservation_id, notes, unpaid_reason, unpaid_by, deposit_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [tenantId, person_id, order_id ?? null, dueAt, req.body.group_name ?? null, deposit, reservation ? reservation.id : null, req.body.notes ?? null, unpaid, unpaid ? req.auth.userId ?? null : null, deposit > 0 ? 'note' : 'none'],
      );
      await R.insertGear(conn, tenantId, c.insertId, items, settings);
      if (reservation) await conn.query("UPDATE rental_reservations SET status = 'picked_up', contract_id = ? WHERE tenant_id = ? AND id = ?", [c.insertId, tenantId, reservation.id]);
      if (deposit > 0) {
        await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'deposit', ?, 'Deposit held')", [tenantId, c.insertId, deposit]);
      }
      await audit(conn, req, 'checkout', 'rental_contracts', c.insertId, { items: items.map((i) => i.rental_item_id), ...(unpaid ? { unpaid_reason: unpaid } : {}) });
      return c.insertId;
    });
    res.status(201).json({ id: created, status: 'out' });
  },
);

/**
 * Check in some or all items. Damaged gear goes to service, and a late return raises a late-fee charge. Only a contract
 * with gear out takes returns (a to_fit rental has nothing to bring back). When the last piece is back, a card deposit
 * with nothing owed is released (lib/rentaldeposit.js); with fees owed it waits for staff to confirm what to take.
 */
router.post(
  '/contracts/:id/checkin',
  requireRole(...counter),
  validate(
    z.object({
      items: z
        .array(z.object({ rental_item_id: z.number().int().positive(), damage_notes: z.string().max(500).optional(), lost: z.boolean().optional(), fee_cents: z.number().int().min(0).max(1_000_000).optional() }))
        .optional(),
    }),
  ),
  async (req, res) => {
    const { tenantId } = req.auth;
    const contractId = paramId(req);
    const result = await tx(async (conn) => {
      const contract = await RR.lockOpen(conn, tenantId, contractId);
      const out = await RR.checkinLines(conn, tenantId, contract, req.body.items || null);
      await audit(conn, req, 'checkin', 'rental_contracts', contractId, { returned: out.returned });
      return out;
    });
    const deposit = result.status === 'returned' ? await require('../lib/rentaldeposit').afterReturn(tenantId, contractId, req) : null;
    res.json({ status: result.status, outstanding: result.outstanding, fees: result.fees, deposit });
  },
);

router.get('/contracts', requireRole(...counter), async (req, res) => {
  const where = ['c.tenant_id = ?'];
  const params = [req.auth.tenantId];
  if (req.query.status) {
    where.push('c.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.overdue === 'true') where.push("c.status = 'out' AND c.due_at < NOW()");
  const data = await rows(
    pool,
    `SELECT c.*, p.first_name, p.last_name FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
     WHERE ${where.join(' AND ')} ORDER BY c.due_at LIMIT 200`,
    params,
  );
  res.json({ data });
});

router.get('/contracts/:id', requireRole(...counter), async (req, res) => {
  const contract = await one(pool, 'SELECT * FROM rental_contracts WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!contract) throw notFound('Contract');
  const items = await rows(
    pool,
    `SELECT l.*, r.sku, r.category, r.brand, r.model, r.size FROM rental_contract_items l
     JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.contract_id = ?`,
    [req.auth.tenantId, contract.id],
  );
  res.json({ ...contract, items });
});

router.use(require('./rentalsplus'));
router.use(require('./rentalsfit'));
router.use(require('./rentalsreturns')); // scan-to-return, Out now search, season rentals, the shop manager's reports
router.use(require('./rentaldeposits')); // card deposits on the counter's reader

router.use(
  '/items',
  crud({
    table: 'rental_items',
    entity: 'Rental item',
    createSchema: z.object(itemFields),
    updateSchema: partialOf(itemFields),
    columns: ['sku', 'category', 'brand', 'model', 'size', 'status', 'notes', 'serial_no', 'tier', 'boot_sole_mm', 'purchased_on', 'cost_cents', 'grade', 'location'],
    filters: ['category', 'size', 'status', 'tier', 'grade'],
    search: ['sku', 'brand', 'model', 'serial_no'],
    orderBy: 'category, sku',
    readRoles: ['counter'],
    writeRoles: ['manager'],
    allowDelete: false,
  }),
);

module.exports = router;
