'use strict';

// Rentals, the fitting side: paid rentals ready to fit, the fitting card (details, binding suggestion, signed
// confirmation), the stations queue and its wall board, the shared gear picker (no 500 cap), what's left by size, the
// printed rental agreement and the fitting settings. Mounted inside routes/rentals.js.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, todayIn, addDays, seasonFor, localTime } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { ON_FILE } = require('../lib/waivers');
const R = require('../lib/rentals');
const F = require('../lib/rentalfit');

const router = express.Router();
const counter = ['counter', 'manager'];
const manager = ['manager'];
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;

// ---- Settings: layout, closing time, the signed confirmation ----------------------------------------------
const fitSettingsSchema = z.object({
  layout: z.enum(['counter', 'stations']),
  closing_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 16:30'),
  require_signoff: z.boolean(),
  signoff_valid_days: z.number().int().min(1).max(30),
}).partial();

router.get('/fit/settings', requireRole(...counter), async (req, res) => res.json(await F.fitSettings(pool, req.auth.tenantId)));

router.put('/fit/settings', requireRole(...manager), validate(fitSettingsSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  await pool.query('INSERT IGNORE INTO rental_settings (tenant_id) VALUES (?)', [tenantId]);
  const cols = Object.keys(b);
  if (cols.length) {
    const vals = cols.map((k) => (k === 'require_signoff' ? (b[k] ? 1 : 0) : k === 'closing_time' ? `${b[k]}:00` : b[k]));
    await pool.query(`UPDATE rental_settings SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ?`, [...vals, tenantId]);
  }
  await audit(pool, req, 'update', 'rental_settings', tenantId, b);
  res.json(await F.fitSettings(pool, tenantId));
});

// ---- Ready to fit -------------------------------------------------------------------------------------
const READY_COLS = `c.id, c.person_id, c.order_id, c.order_item_id, c.kind, c.stage, c.valid_on, c.due_at, c.group_id, c.checked_out_at AS paid_at,
  TIMESTAMPDIFF(MINUTE, COALESCE(c.stage_at, c.checked_out_at), NOW()) AS waiting_min,
  p.first_name, p.last_name, p.phone, p.date_of_birth, pr.name AS product_name, oi.tier, pr.rental_kind`;
const READY_FROM = `FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
  LEFT JOIN order_items oi ON oi.id = c.order_item_id AND oi.tenant_id = c.tenant_id
  LEFT JOIN products pr ON pr.id = oi.product_id AND pr.tenant_id = oi.tenant_id`;

/** Today's paid rentals waiting for gear (and any from the last two weeks not picked up yet), oldest first. */
router.get('/fit/ready', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const today = todayIn(await tzOf(tenantId));
  // group rentals with gear set aside (stage 'set') are listed too, so a member who walks up alone is found
  const where = ["c.tenant_id = ? AND c.status = 'to_fit'", 'c.valid_on BETWEEN ? AND ?'];
  const params = [tenantId, addDays(today, -14), today];
  // a rental paid before the shop switched to stations has no station yet: it waits at the first one
  if (req.query.stage && F.STAGES.includes(String(req.query.stage))) { where.push(req.query.stage === 'form' ? "(c.stage = 'form' OR c.stage IS NULL)" : 'c.stage = ?'); if (req.query.stage !== 'form') params.push(String(req.query.stage)); }
  const q = String(req.query.q || '').trim();
  if (q) {
    const m = /^(?:ORD-?)?(\d{1,12})$/i.exec(q);
    const like = `%${q.replace(/[%_\\]/g, (x) => `\\${x}`)}%`;
    const digits = q.replace(/\D/g, '');
    where.push(`(CONCAT(p.first_name, ' ', p.last_name) LIKE ? OR p.last_name LIKE ?${digits.length >= 4 ? ' OR REPLACE(REPLACE(REPLACE(p.phone, \'-\', \'\'), \' \', \'\'), \'(\', \'\') LIKE ?' : ''}${m ? ' OR c.order_id = ?' : ''})`);
    params.push(like, like);
    if (digits.length >= 4) params.push(`%${digits}%`);
    if (m) params.push(Number(m[1]));
  }
  const data = await rows(pool, `SELECT ${READY_COLS} ${READY_FROM} WHERE ${where.join(' AND ')} ORDER BY COALESCE(c.stage_at, c.checked_out_at), c.id LIMIT 200`, params);
  for (const d of data) { d.age = F.ageOn(d.date_of_birth, today); delete d.date_of_birth; d.earlier = d.valid_on < today; }
  res.json({ today, data });
});

/** A scanned receipt, order number or ticket: the order and its rentals waiting to be fitted. */
router.get('/fit/find', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const code = String(req.query.code || '').trim();
  if (!code) throw bad('Scan the receipt or type the order number');
  let orderId = null;
  const m = /^(?:ORD-?)?(\d{1,12})$/i.exec(code);
  if (m && (/^ORD/i.test(code) || code.length < 10)) orderId = Number(m[1]);
  if (!orderId) {
    const t = await one(pool, 'SELECT oi.order_id FROM tickets t JOIN order_items oi ON oi.id = t.order_item_id AND oi.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND t.code = ?', [tenantId, code]);
    if (t) orderId = t.order_id;
  }
  if (!orderId) throw notFound('Order');
  const order = await one(pool, 'SELECT id, status FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, orderId]);
  if (!order) throw notFound('Order');
  const contracts = await rows(pool, `SELECT ${READY_COLS}, c.status ${READY_FROM} WHERE c.tenant_id = ? AND c.order_id = ? ORDER BY c.id`, [tenantId, orderId]);
  res.json({ order, ready: contracts.filter((c) => c.status === 'to_fit'), other: contracts.filter((c) => c.status !== 'to_fit').map((c) => ({ id: c.id, status: c.status, first_name: c.first_name, last_name: c.last_name })) });
});

/** Everything the fitting card shows for one rental: the person, what was bought, their details and the signoff. */
router.get('/fit/contracts/:id', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await one(pool, `SELECT c.*, pr.name AS product_name, pr.rental_kind, pr.valid_days, oi.tier, oi.unit_price_cents FROM rental_contracts c
    LEFT JOIN order_items oi ON oi.id = c.order_item_id AND oi.tenant_id = c.tenant_id LEFT JOIN products pr ON pr.id = oi.product_id AND pr.tenant_id = oi.tenant_id
    WHERE c.tenant_id = ? AND c.id = ?`, [tenantId, paramId(req)]);
  if (!c) throw notFound('Contract');
  const tz = await tzOf(tenantId);
  const today = todayIn(tz);
  const settings = await F.fitSettings(pool, tenantId);
  const card = await personCard(tenantId, c.person_id, today, settings, tz);
  const items = await rows(pool, `SELECT l.*, r.sku, r.category, r.brand, r.model, r.size, r.tier FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id
    WHERE l.tenant_id = ? AND l.contract_id = ? ORDER BY l.id`, [tenantId, c.id]);
  const others = c.order_id ? await rows(pool, "SELECT c.id, c.person_id, p.first_name, p.last_name FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id WHERE c.tenant_id = ? AND c.order_id = ? AND c.status = 'to_fit' AND c.id <> ? ORDER BY c.id", [tenantId, c.order_id, c.id]) : [];
  await audit(pool, req, 'view', 'rental_contracts', c.id, { via: 'fitting card' });
  res.json({ contract: c, ...card, items, same_order: others, settings: { layout: settings.layout, require_signoff: settings.require_signoff, require_binding_record: settings.require_binding_record, deposit_mode: settings.deposit_mode, default_deposit_cents: settings.default_deposit_cents, closing_time: settings.closing_time } });
});

async function personCard(tenantId, personId, today, settings, tz) {
  const { person, details, profile } = await F.detailsOf(pool, tenantId, personId);
  const waiver = await one(pool, ON_FILE, [tenantId, personId, seasonFor(today)]);
  const signoff = await F.validSignoff(pool, tenantId, personId, details, { settings, timeZone: tz });
  return {
    person: { ...person, age: F.ageOn(details.date_of_birth, today), waiver_signed: Boolean(waiver) },
    details, profile,
    signoff: signoff ? { id: signoff.signoff.id, signed_at: localTime(signoff.signoff.signed_at, tz), signer_name: signoff.signoff.signer_name, signer_relation: signoff.signoff.signer_relation, via: signoff.signoff.via, mismatch: signoff.mismatch } : null,
  };
}

/** The card for a person who is not on a contract yet (Sell's fitting card for someone already on file). */
router.get('/fit/people/:personId', requireRole(...counter), async (req, res) => {
  const tz = await tzOf(req.auth.tenantId);
  res.json(await personCard(req.auth.tenantId, paramId(req, 'personId'), todayIn(tz), await F.fitSettings(pool, req.auth.tenantId), tz));
});

/** Saves the details typed on the fitting card to the person and their rental profile. */
router.put('/fit/people/:personId', requireRole(...counter), validate(F.detailsSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const personId = paramId(req, 'personId');
  const tz = await tzOf(tenantId);
  if (req.body.date_of_birth && req.body.date_of_birth > todayIn(tz)) throw bad('Date of birth cannot be in the future');
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, personId]))) throw notFound('Person');
    await F.saveDetails(conn, tenantId, personId, req.body);
    await audit(conn, req, 'fit_details', 'people', personId, Object.keys(req.body));
  });
  res.json(await personCard(tenantId, personId, todayIn(tz), await F.fitSettings(pool, tenantId), tz));
});

/** The binding suggestion for the details on the card now (never from a past rental). */
router.get('/fit/suggest', requireRole(...counter), async (req, res) => {
  const n = (k) => (req.query[k] === undefined || req.query[k] === '' ? null : Number(req.query[k]));
  const tz = await tzOf(req.auth.tenantId);
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date_of_birth || '')) ? String(req.query.date_of_birth) : null;
  res.json(await F.suggestBinding(pool, req.auth.tenantId, { weight_lb: n('weight_lb'), height_in: n('height_in'), sole_mm: n('sole_mm'), skier_type: req.query.skier_type, age: F.ageOn(dob, todayIn(tz)) }));
});

/** The renter (or a parent or guardian) signs that the details on the card are true. The details are saved with it. */
router.post('/fit/signoffs', requireRole(...counter), validate(F.signoffSchema.extend({ person_id: z.number().int().positive(), contract_id: z.number().int().positive().optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const b = req.body;
  const today = todayIn(await tzOf(tenantId));
  const id = await tx(async (conn) => {
    if (b.contract_id) {
      const c = await one(conn, 'SELECT id, person_id FROM rental_contracts WHERE tenant_id = ? AND id = ?', [tenantId, b.contract_id]);
      if (!c) throw notFound('Contract');
    }
    await F.saveDetails(conn, tenantId, b.person_id, b.details);
    const sid = await F.writeSignoff(conn, tenantId, b.person_id, b, { contractId: b.contract_id ?? null, ip: req.ip || null, today });
    await audit(conn, req, 'signoff', 'rental_signoffs', sid, { person_id: b.person_id, contract_id: b.contract_id ?? null, relation: b.signer_relation });
    return sid;
  });
  res.status(201).json({ id });
});

/** Hands out the gear on a paid rental: it goes from Ready to fit to Out now. */
router.post('/contracts/:id/handout', requireRole(...counter), validate(F.handoutSchema), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const out = await tx(async (conn) => {
    const r = await F.handout(conn, tenantId, id, req.body, req);
    await audit(conn, req, 'handout', 'rental_contracts', id, { items: req.body.items.map((i) => i.rental_item_id), ...(r.unpaid_reason ? { unpaid_reason: r.unpaid_reason } : {}) });
    return r;
  });
  res.json(out);
});

/** Stations: "Done here" moves the rental to the next station, or a station can be chosen. The door hands out. */
router.post('/fit/contracts/:id/stage', requireRole(...counter), validate(z.object({ stage: z.enum(['form', 'boots', 'tech', 'door']).optional() })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const stage = await tx(async (conn) => {
    const c = await one(conn, 'SELECT id, status, stage FROM rental_contracts WHERE tenant_id = ? AND id = ? FOR UPDATE', [tenantId, id]);
    if (!c) throw notFound('Contract');
    if (c.status !== 'to_fit') throw conflict('That rental is not waiting to be fitted');
    const next = req.body.stage || F.nextStage(c.stage || 'form');
    if (!next) throw conflict('This is the last station. Hand out the gear here.');
    await conn.query('UPDATE rental_contracts SET stage = ?, stage_at = NOW() WHERE tenant_id = ? AND id = ?', [next, tenantId, id]);
    await audit(conn, req, 'stage', 'rental_contracts', id, { from: c.stage, to: next });
    return next;
  });
  res.json({ id, stage });
});

/** A manager clears a paid rental nobody will pick up (refunds are made on the order as usual). */
router.post('/fit/contracts/:id/cancel', requireRole(...manager), validate(z.object({ reason: z.string().trim().min(3).max(200) })), async (req, res) => {
  const { tenantId } = req.auth;
  const id = paramId(req);
  const [r] = await pool.query("UPDATE rental_contracts SET status = 'cancelled', stage = NULL, notes = LEFT(CONCAT_WS(' ', notes, ?), 300) WHERE tenant_id = ? AND id = ? AND status = 'to_fit'", [`Canceled: ${req.body.reason}`, tenantId, id]);
  if (!r.affectedRows) throw conflict('That rental is not waiting to be fitted');
  await audit(pool, req, 'cancel', 'rental_contracts', id, req.body);
  res.json({ ok: true });
});

/** The queue board for a wall screen: how many wait at each station and who is next (first name and initial only). */
router.get('/fit/board', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const today = todayIn(await tzOf(tenantId));
  const list = await rows(pool, `SELECT c.id, c.stage, p.first_name, LEFT(p.last_name, 1) AS initial, TIMESTAMPDIFF(MINUTE, COALESCE(c.stage_at, c.checked_out_at), NOW()) AS waiting_min
    FROM rental_contracts c JOIN people p ON p.id = c.person_id AND p.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND c.status = 'to_fit' AND c.valid_on = ? AND (c.stage IS NULL OR c.stage <> 'set') ORDER BY COALESCE(c.stage_at, c.checked_out_at), c.id LIMIT 300`, [tenantId, today]);
  const settings = await F.fitSettings(pool, tenantId);
  const stages = settings.layout === 'stations' ? F.STAGES : [null];
  res.json({ today, layout: settings.layout, stages: stages.map((s) => {
    const here = list.filter((x) => (s === null ? true : (x.stage || 'form') === s));
    return { stage: s, count: here.length, longest_min: here.length ? Math.max(...here.map((x) => Number(x.waiting_min) || 0)) : 0, next: here.slice(0, 8).map((x) => ({ id: x.id, name: `${x.first_name} ${x.initial}.`, waiting_min: Number(x.waiting_min) || 0 })) };
  }) });
});

// ---- The gear picker: filtered and paged on the server, with counts by size -------------------------------
const sizeKey = (z_) => { const n = parseFloat(z_); return Number.isNaN(n) ? [1, 0, String(z_)] : [0, n, String(z_)]; };
const bySize = (a, b) => { const x = sizeKey(a.size || ''); const y = sizeKey(b.size || ''); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
const COUNTS = `SUM(status = 'available') AS free, SUM(status = 'rented') AS out_now, SUM(status = 'maintenance') AS service, SUM(status = 'set_aside') AS set_aside`;
const numify = (r) => ({ ...r, free: Number(r.free || 0), out_now: Number(r.out_now || 0), service: Number(r.service || 0), set_aside: Number(r.set_aside || 0) });

router.get('/fit/gear', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const where = ['tenant_id = ?'];
  const params = [tenantId];
  const cat = R.CATEGORIES.includes(String(req.query.category)) ? String(req.query.category) : null;
  const tier = R.TIERS.includes(String(req.query.tier)) ? String(req.query.tier) : null;
  if (cat) { where.push('category = ?'); params.push(cat); }
  if (tier) { where.push('tier = ?'); params.push(tier); }
  const base = [...where]; const baseParams = [...params];
  const status = ['available', 'rented', 'maintenance', 'set_aside', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'available';
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (req.query.size !== undefined && req.query.size !== '') { where.push('COALESCE(size, \'\') = ?'); params.push(String(req.query.size)); }
  const q = String(req.query.q || '').trim();
  if (q) { const like = `%${q.replace(/[%_\\]/g, (x) => `\\${x}`)}%`; where.push('(sku LIKE ? OR brand LIKE ? OR model LIKE ? OR serial_no LIKE ? OR size = ?)'); params.push(like, like, like, like, q); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [data, total, sizes, types, tiers] = await Promise.all([
    rows(pool, `SELECT id, sku, category, brand, model, size, tier, grade, status, boot_sole_mm, location FROM rental_items WHERE ${where.join(' AND ')}
      ORDER BY (size REGEXP '^[0-9.]+$') DESC, CAST(size AS DECIMAL(8,2)), size, sku LIMIT ? OFFSET ?`, [...params, limit, offset]),
    one(pool, `SELECT COUNT(*) AS n FROM rental_items WHERE ${where.join(' AND ')}`, params),
    cat ? rows(pool, `SELECT COALESCE(size, '') AS size, ${COUNTS} FROM rental_items WHERE ${base.join(' AND ')} GROUP BY COALESCE(size, '')`, baseParams) : [],
    rows(pool, `SELECT category, ${COUNTS} FROM rental_items WHERE tenant_id = ? GROUP BY category`, [tenantId]),
    cat ? rows(pool, 'SELECT DISTINCT tier FROM rental_items WHERE tenant_id = ? AND category = ?', [tenantId, cat]) : [],
  ]);
  res.json({ data, total: Number(total.n), limit, offset, sizes: sizes.map(numify).sort(bySize), types: types.map(numify), tiers: tiers.map((t) => t.tier) });
});

/** What's left: for each type and size, how many are free now, out, and in service. */
router.get('/fit/left', requireRole(...counter), async (req, res) => {
  const data = await rows(pool, `SELECT category, COALESCE(size, '') AS size, ${COUNTS} FROM rental_items WHERE tenant_id = ? AND status NOT IN ('retired','lost','sold') GROUP BY category, COALESCE(size, '')`, [req.auth.tenantId]);
  const out = R.CATEGORIES.map((c) => ({ category: c, sizes: data.filter((d) => d.category === c).map(numify).sort(bySize) })).filter((c) => c.sizes.length);
  for (const c of out) { c.free = c.sizes.reduce((a, s) => a + s.free, 0); c.out_now = c.sizes.reduce((a, s) => a + s.out_now, 0); c.service = c.sizes.reduce((a, s) => a + s.service, 0); }
  res.json({ data: out });
});

// ---- The printed rental agreement ------------------------------------------------------------------------
router.get('/fit/contracts/:id/agreement', requireRole(...counter), async (req, res) => {
  const { tenantId } = req.auth;
  const c = await one(pool, `SELECT c.*, pr.name AS product_name, oi.tier FROM rental_contracts c LEFT JOIN order_items oi ON oi.id = c.order_item_id AND oi.tenant_id = c.tenant_id
    LEFT JOIN products pr ON pr.id = oi.product_id AND pr.tenant_id = oi.tenant_id WHERE c.tenant_id = ? AND c.id = ?`, [tenantId, paramId(req)]);
  if (!c) throw notFound('Contract');
  const t = await one(pool, 'SELECT name, address, phone, timezone FROM tenants WHERE id = ?', [tenantId]);
  const today = todayIn(t.timezone);
  const items = await rows(pool, `SELECT l.rental_item_id, l.person_id, l.din_setting, l.tech_name, l.test_result, l.set_at, l.boot_sole_mm, l.skier_type, l.returned_at, r.sku, r.category, r.brand, r.model, r.size
    FROM rental_contract_items l JOIN rental_items r ON r.id = l.rental_item_id AND r.tenant_id = l.tenant_id WHERE l.tenant_id = ? AND l.contract_id = ? AND l.swap_reason IS NULL ORDER BY l.id`, [tenantId, c.id]);
  const ids = [...new Set([c.person_id, ...items.map((i) => i.person_id).filter(Boolean)])];
  const people = [];
  for (const pid of ids) {
    const p = await one(pool, 'SELECT id, first_name, last_name, date_of_birth, phone FROM people WHERE tenant_id = ? AND id = ?', [tenantId, pid]);
    if (!p) continue;
    let s = await one(pool, 'SELECT signer_name, signer_relation, details, signature, via, signed_at FROM rental_signoffs WHERE tenant_id = ? AND person_id = ? AND contract_id = ? ORDER BY id DESC LIMIT 1', [tenantId, pid, c.id]);
    if (!s) { const v = await F.validSignoff(pool, tenantId, pid, null, { timeZone: t.timezone }); if (v) s = await one(pool, 'SELECT signer_name, signer_relation, details, signature, via, signed_at FROM rental_signoffs WHERE tenant_id = ? AND id = ?', [tenantId, v.signoff.id]); }
    if (s && typeof s.details === 'string') { try { s.details = JSON.parse(s.details); } catch (_) { s.details = {}; } }
    if (s) s.signed_at = localTime(s.signed_at, t.timezone); // stamped in UTC, shown on the mountain's clock
    const waiver = await one(pool, ON_FILE, [tenantId, pid, seasonFor(today)]);
    people.push({ id: p.id, first_name: p.first_name, last_name: p.last_name, age: F.ageOn(p.date_of_birth, today), is_renter: pid === c.person_id, waiver_signed: Boolean(waiver), signoff: s || null, items: items.filter((i) => (i.person_id || c.person_id) === pid) });
  }
  const settings = await F.fitSettings(pool, tenantId);
  await audit(pool, req, 'print', 'rental_contracts', c.id, { what: 'agreement' });
  if (c.checked_out_at) c.checked_out_at = localTime(c.checked_out_at, t.timezone);
  res.json({ mountain: { name: t.name, address: t.address, phone: t.phone }, contract: c, people, fees: { late_fee_cents_per_day: settings.late_fee_cents_per_day, late_grace_minutes: settings.late_grace_minutes }, season: seasonFor(today) });
});

module.exports = router;
