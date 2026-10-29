'use strict';

// The return side of the rental shop: one scan box that checks a piece in the moment its tag is scanned, Out now with a
// search, season rentals (settings, buy out) and the shop manager's reports. A to_fit rental (paid, not handed out) is
// never out, overdue or in Out now. Mounted inside routes/rentals.js.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, todayIn, nowIn, addDays, dayRange, localTime } = require('../lib/util');
const { AppError, notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const R = require('../lib/rentals');
const RR = require('../lib/rentalreturn');
const D = require('../lib/rentaldeposit');

const router = express.Router();
const counter = ['counter', 'manager'];
const manager = ['manager'];
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const OPEN_SQL = "('out','overdue')";

/** A contract number as staff type or scan it: 123, #123, C-123, RC-123 or CONTRACT-123. */
const contractNo = (code) => { const m = /^(?:#|C-?|RC-?|CONTRACT-?)?(\d{1,10})$/i.exec(String(code).trim()); return m ? Number(m[1]) : null; };

// ---------------------------------------------------------------- the Returns tab: scan to return
/**
 * One scan. A gear tag (or serial number) on an open contract is checked in at once, as fine, or as damaged when
 * damage_notes is given; the reply is the contract, showing what is still out. A contract number opens the contract
 * without checking anything in. When the last piece is back the contract closes, the late fee is added and a card
 * deposit with nothing owed is released.
 */
router.post('/returns/scan', requireRole(...counter), validate(z.object({
  code: z.string().trim().min(1).max(80),
  damage_notes: z.string().trim().max(500).optional(),
  fee_cents: z.number().int().min(0).max(1_000_000).optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const code = req.body.code;
  const item = await one(pool, 'SELECT * FROM rental_items WHERE tenant_id = ? AND (sku = ? OR serial_no = ?) ORDER BY sku = ? DESC LIMIT 1', [tenantId, code, code, code]);
  if (!item) {
    const no = contractNo(code);
    const view = no ? await RR.contractView(pool, tenantId, no) : null;
    if (!view || view.status === 'to_fit' || view.status === 'cancelled') throw new AppError(404, `No gear tag or open contract called ${code.slice(0, 40)}`);
    return res.json({ kind: 'contract', contract: view });
  }
  const line = await one(pool, `SELECT l.contract_id FROM rental_contract_items l JOIN rental_contracts c ON c.id = l.contract_id AND c.tenant_id = l.tenant_id
    WHERE l.tenant_id = ? AND l.rental_item_id = ? AND l.returned_at IS NULL AND c.status IN ${OPEN_SQL} ORDER BY l.id DESC LIMIT 1`, [tenantId, item.id]);
  if (!line) throw conflict(`${item.sku} is not out on a rental. It is ${item.status.replace('_', ' ')}.`, { sku: item.sku, status: item.status });
  const out = await tx(async (conn) => {
    const contract = await RR.lockOpen(conn, tenantId, line.contract_id);
    const d = { rental_item_id: item.id, ...(req.body.damage_notes ? { damage_notes: req.body.damage_notes } : {}), ...(req.body.fee_cents ? { fee_cents: req.body.fee_cents } : {}) };
    const r = await RR.checkinLines(conn, tenantId, contract, [d]);
    await audit(conn, req, 'checkin', 'rental_contracts', contract.id, { returned: r.returned, via: 'scan', damaged: Boolean(req.body.damage_notes) });
    return r;
  });
  const deposit = out.status === 'returned' ? await D.afterReturn(tenantId, line.contract_id, req) : null;
  res.json({ kind: 'returned', item: { id: item.id, sku: item.sku, category: item.category, brand: item.brand, model: item.model, size: item.size },
    closed: out.status === 'returned', fees: out.fees, deposit, contract: await RR.contractView(pool, tenantId, line.contract_id) });
});

/**
 * Damage noticed after a piece was scanned back: notes it, sends it to service and adds the fee. Only while the piece
 * has not gone out again.
 */
router.post('/returns/lines/:lineId/damage', requireRole(...counter), validate(z.object({ notes: z.string().trim().min(1).max(500), fee_cents: z.number().int().min(0).max(1_000_000).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const lineId = paramId(req, 'lineId');
  const result = await tx(async (conn) => {
    const line = await one(conn, 'SELECT l.*, r.sku, r.status AS item_status FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.id = ? FOR UPDATE', [tenantId, lineId]);
    if (!line) throw notFound('Rental line');
    if (!line.returned_at) throw conflict('That piece is still out. Check it in first.');
    if (line.item_status === 'rented' || line.item_status === 'sold') throw conflict(`${line.sku} has gone out again, so it cannot be marked from this return`);
    await conn.query('UPDATE rental_contract_items SET damage_notes = ? WHERE tenant_id = ? AND id = ?', [req.body.notes, tenantId, lineId]);
    if (line.item_status === 'available') await conn.query("UPDATE rental_items SET status = 'maintenance' WHERE tenant_id = ? AND id = ?", [tenantId, line.rental_item_id]);
    if (req.body.fee_cents > 0) await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'damage', ?, ?)", [tenantId, line.contract_id, req.body.fee_cents, `${line.sku}: ${req.body.notes}`.slice(0, 200)]);
    await audit(conn, req, 'damage', 'rental_contracts', line.contract_id, { rental_item_id: line.rental_item_id, fee_cents: req.body.fee_cents || 0 });
    return line.contract_id;
  });
  res.json({ contract: await RR.contractView(pool, tenantId, result) });
});

router.get('/contracts/:id/view', requireRole(...counter), async (req, res) => {
  const view = await RR.contractView(pool, req.auth.tenantId, paramId(req));
  if (!view) throw notFound('Contract');
  res.json(view);
});

// ---------------------------------------------------------------- Out now
/**
 * Contracts with gear out, searched by name, phone, contract number or gear tag, and filtered: overdue, due today,
 * groups, season. Each row carries the deposit and a warning when a card hold ends within a day.
 */
router.get('/out', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const now = nowIn(tz);
  const today = todayIn(tz);
  const where = ['c.tenant_id = ?', `c.status IN ${OPEN_SQL}`];
  const params = [tenantId];
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    const no = contractNo(q);
    const digits = q.replace(/\D/g, '');
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const ors = ["CONCAT(p.first_name, ' ', p.last_name) LIKE ?", 'c.group_name LIKE ?',
      'EXISTS (SELECT 1 FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.returned_at IS NULL AND (r.sku = ? OR r.serial_no = ?))',
      "EXISTS (SELECT 1 FROM rental_contract_items l JOIN people u ON u.id = l.person_id AND u.tenant_id = l.tenant_id WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND CONCAT(u.first_name, ' ', u.last_name) LIKE ?)"];
    params.push(like, like, q, q, like);
    if (digits.length >= 4) { ors.push("REGEXP_REPLACE(COALESCE(p.phone, ''), '[^0-9]', '') LIKE ?"); params.push(`%${digits}%`); }
    if (no) { ors.push('c.id = ?'); params.push(no); }
    where.push(`(${ors.join(' OR ')})`);
  }
  const f = String(req.query.filter || '');
  if (f === 'overdue') { where.push('c.due_at < ?'); params.push(now); }
  if (f === 'today') { where.push('c.due_at >= ? AND c.due_at < ?'); params.push(`${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`); }
  if (f === 'groups') where.push('(c.group_id IS NOT NULL OR c.group_name IS NOT NULL)');
  if (f === 'season') where.push("c.kind = 'season'");
  const data = await rows(pool, `SELECT c.id, c.person_id, c.status, c.kind, c.due_at, c.checked_out_at, c.group_name, c.group_id, c.deposit_cents, c.deposit_mode, c.deposit_status, c.deposit_card,
      p.first_name, p.last_name, p.phone,
      (SELECT COUNT(*) FROM rental_contract_items l WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.returned_at IS NULL) AS pieces_out,
      (SELECT GROUP_CONCAT(r.sku ORDER BY r.sku SEPARATOR ', ') FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.returned_at IS NULL) AS tags,
      (SELECT d.expires_at FROM rental_deposits d WHERE d.tenant_id = c.tenant_id AND d.contract_id = c.id AND d.status = 'held' AND d.kind = 'hold' ORDER BY d.id DESC LIMIT 1) AS hold_ends_at,
      (SELECT COALESCE(SUM(ch.cents), 0) FROM rental_charges ch WHERE ch.tenant_id = c.tenant_id AND ch.contract_id = c.id AND ch.status = 'due' AND ch.kind <> 'deposit') AS fees_due_cents
    FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
    WHERE ${where.join(' AND ')} ORDER BY c.due_at, c.id LIMIT 300`, params);
  const soon = new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' ');
  for (const c of data) {
    c.overdue = String(c.due_at) < now;
    c.due_today = String(c.due_at).slice(0, 10) === today;
    c.hold_ends_soon = Boolean(c.hold_ends_at && String(c.hold_ends_at) < soon);
    c.fees_due_cents = Number(c.fees_due_cents);
  }
  const fees = await rows(pool, `SELECT ch.*, p.first_name, p.last_name, c.deposit_mode, c.deposit_status, c.deposit_card FROM rental_charges ch JOIN rental_contracts c ON c.id = ch.contract_id AND c.tenant_id = ch.tenant_id
     JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id WHERE ch.tenant_id = ? AND ch.status = 'due' ORDER BY ch.id DESC LIMIT 200`, [tenantId]);
  res.json({ now, today, data, fees });
});

// ---------------------------------------------------------------- season rentals
/** What a buyout would cost: by default half of what each piece cost the shop, when that is known. */
router.get('/contracts/:id/buyout', requireRole(...manager), async (req, res) => {
  const view = await RR.contractView(pool, req.auth.tenantId, paramId(req));
  if (!view) throw notFound('Contract');
  res.json({ contract: view, items: view.items.filter((i) => !i.returned_at).map((i) => ({ rental_item_id: i.rental_item_id, sku: i.sku, category: i.category, size: i.size, cost_cents: i.cost_cents, suggested_cents: i.cost_cents ? Math.round(Number(i.cost_cents) / 2) : null })) });
});

/**
 * Buy out: the renter keeps the gear. A manager enters the price of each piece (default half its cost); each becomes a
 * buyout fee to collect, the pieces are marked sold and come off the contract. No late fee for pieces bought.
 */
router.post('/contracts/:id/buyout', requireRole(...manager), validate(z.object({
  items: z.array(z.object({ rental_item_id: z.number().int().positive(), cents: z.number().int().min(0).max(1_000_000) })).min(1).max(60),
  note: z.string().trim().max(150).optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const out = await tx(async (conn) => {
    const contract = await RR.lockOpen(conn, tenantId, id);
    const lines = req.body.items.map((i) => ({ rental_item_id: i.rental_item_id, sold: true }));
    const r = await RR.checkinLines(conn, tenantId, contract, lines);
    let total = 0;
    for (const i of req.body.items) {
      const it = await one(conn, 'SELECT sku FROM rental_items WHERE tenant_id = ? AND id = ?', [tenantId, i.rental_item_id]);
      if (i.cents > 0) await conn.query("INSERT INTO rental_charges (tenant_id, contract_id, kind, cents, note) VALUES (?, ?, 'buyout', ?, ?)", [tenantId, id, i.cents, `${it.sku}${req.body.note ? `: ${req.body.note}` : ''}`.slice(0, 200)]);
      total += i.cents;
    }
    await audit(conn, req, 'buyout', 'rental_contracts', id, { items: req.body.items, total_cents: total });
    return { ...r, total_cents: total };
  });
  const deposit = out.status === 'returned' ? await D.afterReturn(tenantId, id, req) : null;
  res.json({ status: out.status, outstanding: out.outstanding, total_cents: out.total_cents, deposit });
});

/** The return side's settings, saved apart from the counter's: the deposit kind and the season return date. */
router.put('/settings/returns', requireRole(...manager), validate(z.object({
  deposit_mode: z.enum(['none', 'note', 'card']).optional(),
  season_return_md: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Use MM-DD, like 04-15').refine((s) => !Number.isNaN(Date.parse(`2024-${s}T00:00:00Z`)) && new Date(`2024-${s}T00:00:00Z`).toISOString().slice(5, 10) === s, 'That is not a real date').optional(),
})), async (req, res) => {
  const { tenantId } = req.auth;
  const cur = await R.getSettings(pool, tenantId);
  const next = { deposit_mode: req.body.deposit_mode ?? cur.deposit_mode ?? 'note', season_return_md: req.body.season_return_md ?? cur.season_return_md ?? '04-15' };
  await pool.query('INSERT INTO rental_settings (tenant_id, deposit_mode, season_return_md) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE deposit_mode = VALUES(deposit_mode), season_return_md = VALUES(season_return_md)', [tenantId, next.deposit_mode, next.season_return_md]);
  await audit(pool, req, 'update', 'rental_settings', tenantId, req.body);
  res.json(await R.getSettings(pool, tenantId));
});

// ---------------------------------------------------------------- the shop manager's reports
/**
 * For a period: how often each piece went out (days out over days in the period), by type and size; pieces never or
 * rarely rented; damage, repair spend and fees; rental revenue per piece; late returns.
 * Revenue per piece: each paid rental line on a sale is linked to its contract (order_items.contract_id, or the
 * contract made for that line, rental_contracts.order_item_id). Its amount, less discount and refunds, is shared
 * equally across the pieces handed out on that contract (swapped-out pieces do not count). Fee payments are not rental
 * revenue and are left out. Rental lines with no contract are shown as one total, not linked to gear.
 */
router.get('/reports/shop', requireRole(...manager), async (req, res) => {
  const { tenantId } = req.auth;
  const tz = await tzOf(tenantId);
  const today = todayIn(tz);
  const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
  const from = ok(req.query.from) ? String(req.query.from) : addDays(today, -29);
  const to = ok(req.query.to) ? String(req.query.to) : today;
  if (to < from) throw bad('The end date is before the start date');
  const [start] = dayRange(tz, from); const [, end] = dayRange(tz, to);
  const ms = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);
  const periodDays = (ms(end) - ms(start)) / 864e5;
  const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const fleet = await rows(pool, "SELECT id, sku, category, brand, model, size, tier, status, cost_cents, purchased_on FROM rental_items WHERE tenant_id = ? AND status NOT IN ('retired','sold') ORDER BY category, sku", [tenantId]);
  const lines = await rows(pool, `SELECT l.id, l.contract_id, l.rental_item_id, l.returned_at, l.swap_reason, c.checked_out_at FROM rental_contract_items l
    JOIN rental_contracts c ON c.id = l.contract_id AND c.tenant_id = l.tenant_id
    WHERE l.tenant_id = ? AND c.status NOT IN ('to_fit','cancelled') AND c.checked_out_at < ? AND (l.returned_at IS NULL OR l.returned_at >= ?)`, [tenantId, end, start]);
  const use = new Map();
  for (const l of lines) {
    const a = Math.max(ms(l.checked_out_at), ms(start));
    const b = Math.min(l.returned_at ? ms(l.returned_at) : ms(nowUtc), ms(end));
    const u = use.get(l.rental_item_id) || { days: 0, times: 0 };
    if (b > a) u.days += (b - a) / 864e5;
    if (ms(l.checked_out_at) >= ms(start)) u.times += 1;
    use.set(l.rental_item_id, u);
  }
  // revenue per piece
  const sales = await rows(pool, `SELECT oi.id, oi.contract_id, oi.unit_price_cents * oi.quantity - COALESCE(oi.discount_cents, 0) AS cents, oi.refunded_at,
      (SELECT c.id FROM rental_contracts c WHERE c.tenant_id = oi.tenant_id AND c.order_item_id = oi.id ORDER BY c.id LIMIT 1) AS fit_contract
    FROM order_items oi JOIN orders o ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
    WHERE oi.tenant_id = ? AND oi.line_kind = 'rental' AND o.status IN ('paid','refunded') AND o.created_at >= ? AND o.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM rental_charges ch WHERE ch.tenant_id = o.tenant_id AND ch.order_id = o.id)`, [tenantId, start, end]);
  const revenue = new Map(); let unlinked = 0; let rentalRevenue = 0;
  const piecesOf = new Map();
  for (const s of sales) {
    const cents = s.refunded_at ? 0 : Math.max(Number(s.cents), 0);
    rentalRevenue += cents;
    const cid = s.contract_id || s.fit_contract;
    if (!cid || !cents) { if (!cid) unlinked += cents; continue; }
    if (!piecesOf.has(cid)) piecesOf.set(cid, (await rows(pool, 'SELECT rental_item_id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND swap_reason IS NULL', [tenantId, cid])).map((x) => x.rental_item_id));
    const pieces = piecesOf.get(cid);
    if (!pieces.length) { unlinked += cents; continue; }
    pieces.forEach((pid) => revenue.set(pid, (revenue.get(pid) || 0) + cents / pieces.length));
  }
  const byPiece = fleet.map((i) => {
    const u = use.get(i.id) || { days: 0, times: 0 };
    return { id: i.id, sku: i.sku, category: i.category, size: i.size, brand: i.brand, model: i.model, tier: i.tier, status: i.status, cost_cents: i.cost_cents,
      times: u.times, days_out: Math.round(u.days * 10) / 10, use_pct: periodDays > 0 ? Math.round((u.days / periodDays) * 1000) / 10 : 0, revenue_cents: Math.round(revenue.get(i.id) || 0) };
  });
  const groups = new Map();
  for (const p of byPiece) {
    const k = `${p.category}|${p.size || ''}`;
    const g = groups.get(k) || { category: p.category, size: p.size || '', pieces: 0, times: 0, days_out: 0, revenue_cents: 0 };
    g.pieces += 1; g.times += p.times; g.days_out += p.days_out; g.revenue_cents += p.revenue_cents;
    groups.set(k, g);
  }
  const byTypeSize = [...groups.values()].map((g) => ({ ...g, days_out: Math.round(g.days_out * 10) / 10, use_pct: periodDays > 0 && g.pieces ? Math.round((g.days_out / (periodDays * g.pieces)) * 1000) / 10 : 0 }));
  const rarely = byPiece.filter((p) => p.times <= 1).sort((a, b) => a.times - b.times || a.category.localeCompare(b.category) || a.sku.localeCompare(b.sku));

  const service = await rows(pool, 'SELECT kind, COUNT(*) AS n, COALESCE(SUM(cost_cents), 0) AS cents FROM rental_service_log WHERE tenant_id = ? AND done_at >= ? AND done_at < ? GROUP BY kind ORDER BY cents DESC', [tenantId, start, end]);
  const damaged = await one(pool, "SELECT COUNT(*) AS n FROM rental_contract_items WHERE tenant_id = ? AND damage_notes IS NOT NULL AND damage_notes <> 'Lost' AND returned_at >= ? AND returned_at < ?", [tenantId, start, end]);
  const lost = await one(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(r.cost_cents), 0) AS cost FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND r.status = 'lost' AND l.returned_at >= ? AND l.returned_at < ?", [tenantId, start, end]);
  // fees: charged in the period (by when they were raised), and paid or waived in the period (by when that happened)
  const charged = await rows(pool, "SELECT kind, COUNT(*) AS n, COALESCE(SUM(cents), 0) AS cents FROM rental_charges WHERE tenant_id = ? AND kind <> 'deposit' AND created_at >= ? AND created_at < ? GROUP BY kind", [tenantId, start, end]);
  const settled = await rows(pool, "SELECT kind, status, COUNT(*) AS n, COALESCE(SUM(cents), 0) AS cents FROM rental_charges WHERE tenant_id = ? AND kind <> 'deposit' AND status IN ('paid','waived') AND resolved_at >= ? AND resolved_at < ? GROUP BY kind, status", [tenantId, start, end]);
  const dueNow = await one(pool, "SELECT COUNT(*) AS n, COALESCE(SUM(cents), 0) AS cents FROM rental_charges WHERE tenant_id = ? AND kind <> 'deposit' AND status = 'due'", [tenantId]);

  // late returns: back after the due time plus the grace period, on the mountain's clock
  const settings = await R.getSettings(pool, tenantId);
  const back = await rows(pool, `SELECT c.id, c.kind, c.due_at, c.checked_in_at, c.group_name, p.first_name, p.last_name,
      (SELECT COALESCE(SUM(ch.cents), 0) FROM rental_charges ch WHERE ch.tenant_id = c.tenant_id AND ch.contract_id = c.id AND ch.kind = 'late') AS late_fee_cents
    FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND c.status = 'returned' AND c.checked_in_at >= ? AND c.checked_in_at < ? ORDER BY c.checked_in_at DESC LIMIT 2000`, [tenantId, start, end]);
  const late = [];
  for (const c of back) {
    const backLocal = localTime(c.checked_in_at, tz);
    const minutes = Math.round((ms(backLocal) - ms(c.due_at)) / 60000);
    if (minutes > (settings.late_grace_minutes || 0)) late.push({ id: c.id, kind: c.kind, renter: `${c.first_name} ${c.last_name}`, group_name: c.group_name, due_at: c.due_at, back_at: backLocal, minutes_late: minutes, late_fee_cents: Number(c.late_fee_cents) });
  }

  res.json({
    from, to, period_days: Math.round(periodDays),
    pieces: byPiece, by_type_size: byTypeSize, rarely: rarely.slice(0, 200),
    service, damaged_returns: damaged.n, lost: { n: lost.n, cost_cents: Number(lost.cost) },
    fees: { charged, settled, due_now: { n: dueNow.n, cents: Number(dueNow.cents) } },
    revenue: { rental_cents: rentalRevenue, unlinked_cents: unlinked, method: 'Each rental sale line is shared equally across the pieces handed out on its contract. Fee payments are left out.' },
    late: { returned: back.length, late: late.length, list: late.slice(0, 200) },
  });
});

module.exports = router;
