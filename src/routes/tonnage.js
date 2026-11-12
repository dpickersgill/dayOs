'use strict';

// Tonnage (release 2026.11.22, Trash and recycling): weigh tickets and the figures made from them. See lib/tonnage.js.
// Mounted at /solid-waste (signed in, the solidwaste app on). Money (tipping fees, cost per ton) goes only to owners and
// managers: lib/nomoney.js takes it out of every answer under /solid-waste/tonnage for anyone else.
//   GET  /tonnage/setup                    facilities, streams, zones, trucks, materials (what the forms need)
//   POST /tonnage/facilities, PUT /tonnage/facilities/:id   landfills, transfer stations, processors (managers)
//   GET  /tonnage/tickets, POST /tonnage/tickets, GET /tonnage/tickets/:id, POST /tonnage/tickets/:id/void
//   POST /tonnage/tickets/:id/photos, GET /tonnage/tickets/:id/photos/:photoId   the ticket's photo, as taken
//   POST /tonnage/import, GET /tonnage/imports   a facility's or hauler's monthly report from a spreadsheet
//   GET  /tonnage/figures?year= | from=&to=      tons by month, stream, facility and zone; rate; per household; cost per ton
//   GET  /tonnage/tickets.csv              the tickets as a spreadsheet
const crypto = require('crypto');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, dateStr, validate, paramId, todayIn, nowIn, addDays } = require('../lib/util');
const { notFound, conflict, bad } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { photoFacts, sniff } = require('../lib/exif');
const { toCsv, dollars } = require('../lib/csv');
const T = require('../lib/tonnage');

const router = express.Router();
const office = requireRole('manager', 'counter');
const anyone = requireRole('manager', 'counter', 'staff');
const managers = requireRole('manager');
const MAX_PHOTO = 15 * 1024 * 1024;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tzOf = async (tenantId) => (await one(pool, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

router.get('/tonnage/setup', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  res.json({
    facilities: await T.facilitiesOf(pool, t, { all: true }), facility_kinds: T.FACILITY_KINDS,
    streams: await rows(pool, 'SELECT id, name, kind FROM collection_streams WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [t]),
    zones: await rows(pool, 'SELECT id, name FROM collection_zones WHERE tenant_id = ? AND active = 1 ORDER BY sort, id', [t]),
    trucks: await rows(pool, "SELECT id, name, asset_tag FROM ops_assets WHERE tenant_id = ? AND status <> 'retired' AND category = 'fleet' ORDER BY name LIMIT 200", [t]),
    materials: T.MATERIALS.map(([key, label, kind]) => ({ key, label, kind })), sectors: T.SECTORS, stream_kinds: T.STREAM_KINDS, today: todayIn(await tzOf(t)),
  });
});

const facilityBody = z.object({
  name: z.string().trim().min(2, 'Give the facility a name').max(120),
  kind: z.enum(Object.keys(T.FACILITY_KINDS)),
  address: z.string().trim().max(200).optional().nullable(),
  fee_per_ton_cents: z.number().int().min(0).max(100000).optional().nullable(),
  residue_pct: z.number().min(0).max(60).default(0),
  active: z.boolean().default(true),
});
router.post('/tonnage/facilities', managers, validate(facilityBody), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  if (await one(pool, 'SELECT id FROM tonnage_facilities WHERE tenant_id = ? AND name = ?', [t, b.name])) throw conflict('A facility with that name is already on the list');
  const [r] = await pool.query('INSERT INTO tonnage_facilities (tenant_id, name, kind, address, fee_per_ton_cents, residue_pct, active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [t, b.name, b.kind, b.address || null, b.fee_per_ton_cents ?? null, b.residue_pct, b.active ? 1 : 0]);
  await audit(pool, req, 'tonnage_facility', 'tonnage_facilities', r.insertId, { name: b.name, kind: b.kind, fee_per_ton_cents: b.fee_per_ton_cents ?? null, residue_pct: b.residue_pct });
  res.status(201).json({ id: Number(r.insertId) });
});
router.put('/tonnage/facilities/:id', managers, validate(facilityBody), async (req, res) => {
  const b = req.body; const t = req.auth.tenantId;
  const dup = await one(pool, 'SELECT id FROM tonnage_facilities WHERE tenant_id = ? AND name = ? AND id <> ?', [t, b.name, paramId(req)]);
  if (dup) throw conflict('A facility with that name is already on the list');
  const [r] = await pool.query('UPDATE tonnage_facilities SET name = ?, kind = ?, address = ?, fee_per_ton_cents = ?, residue_pct = ?, active = ? WHERE tenant_id = ? AND id = ?',
    [b.name, b.kind, b.address || null, b.fee_per_ton_cents ?? null, b.residue_pct, b.active ? 1 : 0, t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Facility');
  await audit(pool, req, 'tonnage_facility_change', 'tonnage_facilities', paramId(req), { name: b.name, kind: b.kind, fee_per_ton_cents: b.fee_per_ton_cents ?? null, residue_pct: b.residue_pct, active: b.active });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- tickets
const TICKETS = `SELECT t.*, f.name AS facility, s.name AS stream, z.name AS zone, a.name AS truck,
    (SELECT COUNT(*) FROM weigh_ticket_photos p WHERE p.tenant_id = t.tenant_id AND p.ticket_id = t.id) AS photos
  FROM weigh_tickets t JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id
  LEFT JOIN collection_streams s ON s.tenant_id = t.tenant_id AND s.id = t.stream_id LEFT JOIN collection_zones z ON z.tenant_id = t.tenant_id AND z.id = t.zone_id
  LEFT JOIN ops_assets a ON a.tenant_id = t.tenant_id AND a.id = t.truck_asset_id`;
const ticketShape = (x) => ({
  id: Number(x.id), on_date: day(x.on_date), ticket_no: x.ticket_no, facility_id: Number(x.facility_id), facility: x.facility, stream_id: x.stream_id ? Number(x.stream_id) : null, stream: x.stream,
  stream_kind: x.stream_kind, material: x.material, material_label: (T.MATERIAL[x.material] || {}).label || x.material, sector: x.sector, zone_id: x.zone_id ? Number(x.zone_id) : null, zone: x.zone,
  truck_asset_id: x.truck_asset_id ? Number(x.truck_asset_id) : null, truck: x.truck || x.truck_label, gross_lb: x.gross_lb === null ? null : Number(x.gross_lb), tare_lb: x.tare_lb === null ? null : Number(x.tare_lb),
  net_lb: Number(x.net_lb), net_tons: T.tons(x.net_lb), fee_cents: x.fee_cents === null ? null : Number(x.fee_cents), source: x.source, hauler: x.hauler, note: x.note, photos: Number(x.photos || 0),
  voided: Boolean(x.voided_at), void_reason: x.void_reason, created_at: x.created_at,
});

function ticketFilter(req, t) {
  const where = ['t.tenant_id = ?']; const params = [t];
  const from = req.query.from ? String(req.query.from) : null; const to = req.query.to ? String(req.query.to) : null;
  if (from) { if (!dateStr.safeParse(from).success) throw bad('from must be YYYY-MM-DD'); where.push('t.on_date >= ?'); params.push(from); }
  if (to) { if (!dateStr.safeParse(to).success) throw bad('to must be YYYY-MM-DD'); where.push('t.on_date <= ?'); params.push(to); }
  if (req.query.facility_id) { where.push('t.facility_id = ?'); params.push(Number(req.query.facility_id) || 0); }
  if (req.query.stream_kind) { if (!T.STREAM_KINDS.includes(String(req.query.stream_kind))) throw bad('Unknown stream'); where.push('t.stream_kind = ?'); params.push(String(req.query.stream_kind)); }
  if (String(req.query.voided || '') !== '1') where.push('t.voided_at IS NULL');
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (q) { where.push('(t.ticket_no LIKE ? OR t.hauler LIKE ? OR t.truck_label LIKE ?)'); const like = `%${q.replace(/[\\%_]/g, '')}%`; params.push(like, like, like); }
  return { where, params };
}

router.get('/tonnage/tickets', anyone, async (req, res) => {
  const { where, params } = ticketFilter(req, req.auth.tenantId);
  const list = await rows(pool, `${TICKETS} WHERE ${where.join(' AND ')} ORDER BY t.on_date DESC, t.id DESC LIMIT 500`, params);
  const sum = await one(pool, `SELECT COUNT(*) AS n, COALESCE(SUM(t.net_lb), 0) AS lb, COALESCE(SUM(t.fee_cents), 0) AS fees FROM weigh_tickets t WHERE ${where.join(' AND ')}`, params);
  res.json({ data: list.map(ticketShape), totals: { tickets: Number(sum.n), net_tons: T.tons(sum.lb), fees_cents: Number(sum.fees) } });
});

router.get('/tonnage/tickets/:id', anyone, async (req, res) => {
  const x = await one(pool, `${TICKETS} WHERE t.tenant_id = ? AND t.id = ?`, [req.auth.tenantId, paramId(req)]);
  if (!x) throw notFound('Weigh ticket');
  const photos = await rows(pool, 'SELECT id, mime, bytes, sha256, taken_at, uploaded_at FROM weigh_ticket_photos WHERE tenant_id = ? AND ticket_id = ? ORDER BY id', [req.auth.tenantId, x.id]);
  res.json({ ...ticketShape(x), photo_list: photos.map((p) => ({ ...p, id: Number(p.id) })) });
});

const ticketBody = z.object({
  on_date: dateStr,
  ticket_no: z.string().trim().max(40).optional().nullable(),
  facility_id: z.number().int().positive(),
  stream_id: z.number().int().positive().optional().nullable(),
  stream_kind: z.enum(T.STREAM_KINDS).optional().nullable(),
  material: z.enum(T.MATERIAL_KEYS).optional().nullable(),
  sector: z.enum(T.SECTOR_KEYS).optional().nullable(),
  zone_id: z.number().int().positive().optional().nullable(),
  truck_asset_id: z.number().int().positive().optional().nullable(),
  truck_label: z.string().trim().max(60).optional().nullable(),
  gross_lb: z.number().min(0).max(10_000_000).optional().nullable(),
  tare_lb: z.number().min(0).max(10_000_000).optional().nullable(),
  net_lb: z.number().min(0).max(10_000_000).optional().nullable(),
  net_tons: z.number().min(0).max(5000).optional().nullable(),
  fee_cents: z.number().int().min(0).max(100_000_000).optional().nullable(),
  hauler: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});
router.post('/tonnage/tickets', office, validate(ticketBody), async (req, res) => {
  const b = req.body;
  // A front desk entry never sets the fee by hand (money is a manager's): the facility's usual fee per ton applies.
  if (!['owner', 'manager'].includes(req.auth.role)) delete b.fee_cents;
  const out = await tx((conn) => T.addTicket(conn, req.auth.tenantId, { ...b, source: 'office' }, { by: req.auth.userId }));
  res.status(201).json(out);
});

router.post('/tonnage/tickets/:id/void', managers, validate(z.object({ reason: z.string().trim().min(3, 'Say why the ticket is taken out').max(200) })), async (req, res) => {
  const [r] = await pool.query('UPDATE weigh_tickets SET voided_at = UTC_TIMESTAMP(), voided_by = ?, void_reason = ?, ticket_no = IF(ticket_no IS NULL, NULL, CONCAT(LEFT(ticket_no, 30), \'~void\', id)) WHERE tenant_id = ? AND id = ? AND voided_at IS NULL',
    [req.auth.userId, req.body.reason, req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Weigh ticket');
  await audit(pool, req, 'weigh_ticket_void', 'weigh_tickets', paramId(req), { reason: req.body.reason });
  res.json({ ok: true });
});

router.post('/tonnage/tickets/:id/photos', office, express.raw({ type: () => true, limit: MAX_PHOTO }), async (req, res) => {
  const t = req.auth.tenantId; const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Take a photo of the ticket first');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = z.object({ client_ref: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional() }).safeParse(req.query);
  if (!q.success) throw bad('Something about that photo upload was not right');
  const out = await tx(async (conn) => {
    const x = await one(conn, 'SELECT id FROM weigh_tickets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!x) throw notFound('Weigh ticket');
    if (q.data.client_ref) {
      const seen = await one(conn, 'SELECT id, sha256 FROM weigh_ticket_photos WHERE tenant_id = ? AND client_ref = ?', [t, q.data.client_ref]);
      if (seen) return { id: Number(seen.id), sha256: seen.sha256, repeat: true };
    }
    const facts = photoFacts(buf); const hash = sha(buf); const now = nowIn(await tzOf(t));
    const [r] = await conn.query('INSERT INTO weigh_ticket_photos (tenant_id, ticket_id, mime, bytes, sha256, original, taken_at, client_ref, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, x.id, mime, buf.length, hash, buf, facts.taken_at || now, q.data.client_ref || null, req.auth.userId, now]);
    await audit(conn, req, 'weigh_ticket_photo', 'weigh_tickets', x.id, { photo_id: Number(r.insertId), sha256: hash, bytes: buf.length });
    return { id: Number(r.insertId), sha256: hash };
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

router.get('/tonnage/tickets/:id/photos/:photoId', anyone, async (req, res) => {
  const p = await one(pool, 'SELECT id, mime, sha256, original FROM weigh_ticket_photos WHERE tenant_id = ? AND ticket_id = ? AND id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'photoId')]);
  if (!p) throw notFound('Photo');
  res.set('Content-Type', p.mime).set('X-Content-SHA256', p.sha256).set('Cache-Control', 'private, no-store').send(p.original);
});

// ---------------------------------------------------------------- import
router.post('/tonnage/import', office, validate(z.object({
  csv: z.string().min(1, 'Pick the file or paste the lines').max(5_000_000),
  source_name: z.string().trim().min(2, 'Say whose report this is').max(120),
  file_name: z.string().trim().max(160).optional().nullable(),
  facility_id: z.number().int().positive().optional().nullable(),
  hauler: z.string().trim().max(120).optional().nullable(),
  dry_run: z.boolean().default(false),
})), async (req, res) => {
  const b = req.body;
  const out = await T.importCsv(req.auth.tenantId, { csv: b.csv, sourceName: b.source_name, fileName: b.file_name, facilityId: b.facility_id, hauler: b.hauler, dryRun: b.dry_run }, { by: req.auth.userId });
  res.status(b.dry_run ? 200 : 201).json(out);
});
router.get('/tonnage/imports', office, async (req, res) => {
  res.json({ data: await rows(pool, 'SELECT id, source_name, file_name, rows_added, rows_skipped, created_at FROM weigh_ticket_imports WHERE tenant_id = ? ORDER BY id DESC LIMIT 50', [req.auth.tenantId]) });
});

// ---------------------------------------------------------------- figures
router.get('/tonnage/figures', anyone, async (req, res) => {
  const t = req.auth.tenantId;
  const today = todayIn(await tzOf(t));
  let from; let to; let year = null;
  if (req.query.from || req.query.to) {
    from = String(req.query.from || ''); to = String(req.query.to || '');
    if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success || from > to) throw bad('from and to must be dates, from before to');
  } else {
    year = Number(req.query.year || today.slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw bad('Pick a year');
    from = `${year}-01-01`; to = `${year}-12-31`;
  }
  const f = await T.figures(pool, t, { from, to, year });
  const first = await one(pool, 'SELECT MIN(on_date) AS d FROM weigh_tickets WHERE tenant_id = ? AND voided_at IS NULL', [t]);
  res.json({ ...f, year, today, first_year: first && first.d ? Number(day(first.d).slice(0, 4)) : Number(today.slice(0, 4)),
    carts: await require('../lib/carts').counts(pool, t) });
});

router.get('/tonnage/tickets.csv', office, async (req, res) => {
  const t = req.auth.tenantId;
  if (!req.query.from) req.query.from = addDays(todayIn(await tzOf(t)), -366);
  const { where, params } = ticketFilter(req, t);
  const list = (await rows(pool, `${TICKETS} WHERE ${where.join(' AND ')} ORDER BY t.on_date, t.id LIMIT 50000`, params)).map(ticketShape);
  const data = list.map((x) => ({ ...x, sector: T.SECTORS[x.sector], tipping_fee_dollars: dollars(x.fee_cents), photos: x.photos }));
  const cols = ['id', 'on_date', 'ticket_no', 'facility', 'stream', 'stream_kind', 'material_label', 'sector', 'zone', 'truck', 'gross_lb', 'tare_lb', 'net_lb', 'net_tons', 'tipping_fee_dollars', 'source', 'hauler', 'photos'];
  await audit(pool, req, 'weigh_ticket_export', 'weigh_tickets', null, { rows: data.length });
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="weigh-tickets.csv"').send(toCsv(cols, data));
});

module.exports = router;
