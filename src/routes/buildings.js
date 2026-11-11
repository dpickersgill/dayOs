'use strict';

// Buildings (muni release 1, the `buildings` add-on, paths /buildings): a municipality's own properties and their
// life-safety calendar. Buildings and the rooms in them; the equipment inside (extinguishers, exit lights, the elevator,
// the boiler) on the asset register with QR tags; the library of recurring checks, each a service plan on each piece of
// equipment; vendor visits with their results, certificates and the report filed in Documents; staff rounds on a phone;
// deficiencies and the work orders that fix them; and the binder: everything in a date range, to print or download.
// The rules live in lib/buildings.js.
//
// Who does what: everyone signed in may read (the front desk answers "when was the elevator inspected?"). The crew
// (staff) and managers record rounds, vendor visits and deficiencies, and add equipment. Managers set up buildings, the
// library and certificates. No resident's details are ever stored or shown here.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { partialOf, z, dateStr, validate, paramId, setClause, todayIn, nowIn, addDays } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { card, todayRoute } = require('../lib/today');
const { toCsv } = require('../lib/csv');
const { sniff, photoFacts } = require('../lib/exif');
const CR = require('../lib/checkrules');
const O = require('../lib/ops');
const A = require('../lib/assets');
const B = require('../lib/buildings');

const router = express.Router();
router.use(requireRole('staff', 'manager', 'counter'));
const crew = requireRole('staff', 'manager');
const manager = requireRole('manager');
const nullable = (s) => s.nullable().optional();
const first = (v) => (v === undefined ? undefined : String(Array.isArray(v) ? v[0] : v));
const isManager = (req) => ['owner', 'manager'].includes(req.auth.role);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const raw = (limit) => express.raw({ type: () => true, limit });

// The library is seeded the first time Buildings is used (lib/buildings.js ensureLibrary).
router.use((req, _res, next) => { B.ensureLibrary(req.auth.tenantId).then(() => next(), next); });

const tzOf = (conn, t) => B.tzOf(conn, t);
const todayOf = async (t) => todayIn(await tzOf(pool, t));
async function mustExist(conn, table, tenantId, id, what) {
  if (id && !(await one(conn, `SELECT id FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [tenantId, id]))) throw notFound(what);
}
async function buildingOf(conn, tenantId, id, { lock = false } = {}) {
  const b = await one(conn, `SELECT * FROM buildings WHERE tenant_id = ? AND id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!b) throw notFound('Building');
  return b;
}
/** A room of this building (a location inside the building's own). */
async function roomOf(conn, tenantId, building, roomId) {
  if (!roomId) return null;
  const r = await one(conn, 'SELECT id, name, active FROM asset_locations WHERE tenant_id = ? AND id = ? AND parent_id = ?', [tenantId, roomId, building.location_id]);
  if (!r) throw notFound('Room');
  return r;
}
/** Equipment in a building, or 404. */
async function equipmentOf(conn, tenantId, assetId) {
  const e = await one(conn, `${B.EQUIPMENT_SQL} AND a.id = ?`, [tenantId, assetId]);
  if (!e) throw notFound('Equipment in a building');
  return B.shapeEquipment(e);
}
const typeLabel = (v) => (B.TYPES.find((t) => t.value === v) || {}).label || 'Other';
const kindLabel = (v) => (O.ASSET_KINDS.find((k) => k.value === v) || {}).label || v;
async function addressOf(conn, tenantId, b) {
  if (b.street_id) {
    const s = await one(conn, 'SELECT name FROM streets WHERE tenant_id = ? AND id = ?', [tenantId, b.street_id]);
    if (s) return [b.house_number, s.name].filter(Boolean).join(' ');
  }
  return b.address || null;
}
const shapeBuilding = async (conn, tenantId, b) => ({ ...b, active: Boolean(b.active), type_label: typeLabel(b.type), full_address: await addressOf(conn, tenantId, b) });

// ---------------------------------------------------------------- meta and Today
router.get('/meta', async (req, res) => {
  const t = req.auth.tenantId;
  const [vendors, streets] = await Promise.all([
    rows(pool, 'SELECT id, name FROM vendors WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]),
    rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]).catch(() => []),
  ]);
  res.json({
    types: B.TYPES, frequencies: B.FREQUENCIES,
    kinds: O.ASSET_KINDS, equipment_kinds: B.EQUIPMENT_KINDS.map((k) => ({ value: k, label: kindLabel(k) })),
    vendors, streets, can_manage: isManager(req), can_record: req.auth.role !== 'counter', today: await todayOf(t),
  });
});

/** The Today cards: checks overdue, checks due this week, certificates running out in 30 days. Counts only. */
router.get('/today', todayRoute(async (req) => {
  const t = req.auth.tenantId;
  const today = await todayOf(t);
  const plans = await B.plansOf(pool, t, today);
  const certs = await B.currentCerts(pool, t, today);
  const n = (s) => plans.filter((p) => p.state === s).length;
  const overdue = n('overdue'); const never = n('never'); const week = n('week');
  const soon = certs.filter((c) => c.state === 'soon').length; const expired = certs.filter((c) => c.state === 'expired').length;
  return [
    card({ title: 'Building checks overdue', count: overdue, text: [overdue ? 'Past their due date' : 'Nothing past its due date', never ? `${never} more with no record yet` : null].filter(Boolean).join('. '), href: '#/buildings?tab=calendar' }),
    card({ title: 'Building checks due this week', count: week, text: week ? 'Due in the next 7 days' : 'Nothing due in the next 7 days', href: '#/buildings?tab=calendar' }),
    card({ title: 'Certificates expiring in 30 days', count: soon, text: [soon ? 'Elevator, boiler and other certificates of operation' : 'None run out in the next 30 days', expired ? `${expired} already expired` : null].filter(Boolean).join('. '), href: '#/buildings?tab=certificates' }),
  ];
}));

// ---------------------------------------------------------------- the library of recurring checks
const LIB_SQL = `SELECT t.*, v.name AS vendor, i.items, i.name AS template_name,
    (SELECT COUNT(*) FROM building_plans p JOIN pm_tasks m ON m.tenant_id = p.tenant_id AND m.id = p.pm_task_id WHERE p.tenant_id = t.tenant_id AND p.task_id = t.id AND m.active = 1) AS plans
  FROM life_safety_tasks t LEFT JOIN vendors v ON v.tenant_id = t.tenant_id AND v.id = t.vendor_id LEFT JOIN inspection_templates i ON i.tenant_id = t.tenant_id AND i.id = t.template_id`;
const shapeTask = (t) => ({ ...t, active: Boolean(t.active), items: t.items ? JSON.parse(t.items) : [], plans: Number(t.plans || 0), every: B.everyText(t.interval_days), kind_label: kindLabel(t.kind) });

router.get('/library', async (req, res) => {
  const data = await rows(pool, `${LIB_SQL} WHERE t.tenant_id = ? ORDER BY t.active DESC, t.sort, t.name`, [req.auth.tenantId]);
  res.json({ data: data.map((t) => ({ ...shapeTask(t), rules: shapeTask(t).items.map((s) => CR.ruleText(s)) })) });
});

const taskFields = {
  name: z.string().trim().min(3).max(120),
  kind: z.string().refine((k) => O.ASSET_KIND_KEYS.includes(k), 'Choose a kind of equipment'),
  who: z.enum(['staff', 'vendor']),
  interval_days: z.number().int().min(1).max(3650),
  standard: nullable(z.string().trim().max(120)),
  certificate: nullable(z.string().trim().max(80)),
  vendor_id: nullable(z.number().int().positive()),
  notes: nullable(z.string().max(500)),
  active: z.boolean().optional(),
  items: z.array(CR.stepSchema).min(1).max(60),
};
const blankToNull = (b) => { for (const k of ['standard', 'certificate', 'notes']) if (b[k] === '') b[k] = null; return b; };

router.post('/library', manager, validate(z.object(taskFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = blankToNull({ ...req.body });
  if (new Set(b.items.map((i) => i.key)).size !== b.items.length) throw bad('Each checklist item needs its own key');
  const id = await tx(async (conn) => {
    await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
    let tplId;
    try {
      const [r] = await conn.query('INSERT INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, ?, ?)', [t, b.name, b.kind, JSON.stringify(b.items)]);
      tplId = r.insertId;
      const [s] = await conn.query('INSERT INTO life_safety_tasks (tenant_id, name, kind, who, interval_days, standard, template_id, certificate, vendor_id, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 500)',
        [t, b.name, b.kind, b.who, b.interval_days, b.standard ?? null, tplId, b.certificate ?? null, b.vendor_id ?? null, b.notes ?? null]);
      await audit(conn, req, 'create', 'life_safety_tasks', s.insertId, { name: b.name });
      return s.insertId;
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a check or checklist with that name'); throw err; }
  });
  const made = await B.syncPlans(pool, t);
  res.status(201).json({ id, plans_made: made });
});

/** Change a check. Its service plans follow: name, how often and the checklist. Turning it off pauses them. */
router.patch('/library/:id', manager, validate(partialOf(Object.fromEntries(Object.entries(taskFields).filter(([k]) => k !== 'kind')))), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = blankToNull({ ...req.body });
  if (b.items && new Set(b.items.map((i) => i.key)).size !== b.items.length) throw bad('Each checklist item needs its own key');
  await tx(async (conn) => {
    const cur = await one(conn, 'SELECT * FROM life_safety_tasks WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!cur) throw notFound('Check');
    await mustExist(conn, 'vendors', t, b.vendor_id, 'Vendor');
    const body = { ...b }; delete body.items;
    if (body.active !== undefined) body.active = body.active ? 1 : 0;
    const set = setClause(body, ['name', 'who', 'interval_days', 'standard', 'certificate', 'vendor_id', 'notes', 'active']);
    if (!set && !b.items) throw bad('Nothing to change');
    try {
      if (set) await conn.query(`UPDATE life_safety_tasks SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, id]);
      if (b.items || b.name) {
        if (cur.template_id) {
          const tset = setClause({ items: b.items ? JSON.stringify(b.items) : undefined, name: b.name }, ['items', 'name']);
          await conn.query(`UPDATE inspection_templates SET ${tset.sql} WHERE tenant_id = ? AND id = ?`, [...tset.values, t, cur.template_id]);
        } else if (b.items) {
          const [r] = await conn.query('INSERT INTO inspection_templates (tenant_id, name, kinds, items) VALUES (?, ?, ?, ?)', [t, b.name || cur.name, cur.kind, JSON.stringify(b.items)]);
          await conn.query('UPDATE life_safety_tasks SET template_id = ? WHERE tenant_id = ? AND id = ?', [r.insertId, t, id]);
        }
      }
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a check or checklist with that name'); throw err; }
    const now = await one(conn, `${LIB_SQL} WHERE t.tenant_id = ? AND t.id = ?`, [t, id]);
    const checklist = now.items ? JSON.parse(now.items).map((s) => s.label).join('\n').slice(0, 2000) : null;
    await conn.query(`UPDATE pm_tasks m JOIN building_plans p ON p.tenant_id = m.tenant_id AND p.pm_task_id = m.id SET m.name = ?, m.interval_days = ?, m.checklist = ?, m.notes = ?
      WHERE m.tenant_id = ? AND p.task_id = ?`, [now.name.slice(0, 150), now.interval_days, checklist, now.standard ? `Standard: ${now.standard}` : null, t, id]);
    await audit(conn, req, 'update', 'life_safety_tasks', id, Object.keys(req.body));
  });
  await B.syncPlans(pool, t);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the calendar
router.get('/calendar', async (req, res) => {
  const t = req.auth.tenantId;
  const today = await todayOf(t);
  const buildingId = Number(first(req.query.building_id)) || undefined;
  const vendorId = Number(first(req.query.vendor_id)) || undefined;
  const who = ['staff', 'vendor'].includes(first(req.query.who)) ? first(req.query.who) : undefined;
  const plans = await B.plansOf(pool, t, today, { buildingId, vendorId, who });
  const certs = await B.currentCerts(pool, t, today, { buildingId });
  const counts = {}; for (const s of ['overdue', 'never', 'week', 'month', 'ok']) counts[s] = plans.filter((p) => p.state === s).length;
  const order = { overdue: 0, never: 1, week: 2, month: 3, ok: 4 };
  plans.sort((a, b) => order[a.state] - order[b.state] || String(a.due_on || '').localeCompare(String(b.due_on || '')) || a.building.localeCompare(b.building) || a.asset.localeCompare(b.asset));
  res.json({ today, counts, plans, certificates: certs });
});

// ---------------------------------------------------------------- certificates
router.get('/certificates', async (req, res) => {
  const t = req.auth.tenantId;
  const today = await todayOf(t);
  res.json({ today, data: await B.currentCerts(pool, t, today, { buildingId: Number(first(req.query.building_id)) || undefined }) });
});

const certFields = { asset_id: z.number().int().positive(), name: z.string().trim().min(3).max(80), number: nullable(z.string().trim().max(60)), issued_on: nullable(dateStr), expires_on: dateStr };
router.post('/certificates', manager, validate(z.object(certFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (b.issued_on && b.issued_on > b.expires_on) throw bad('The certificate runs out before it was issued. Check the dates.');
  const id = await tx(async (conn) => {
    await equipmentOf(conn, t, b.asset_id);
    const cid = await B.addCertificate(conn, req, { assetId: b.asset_id, name: b.name, number: b.number, issuedOn: b.issued_on, expiresOn: b.expires_on });
    await audit(conn, req, 'create', 'building_certificates', cid, { asset_id: b.asset_id, expires_on: b.expires_on });
    return cid;
  });
  res.status(201).json({ id });
});

// ---------------------------------------------------------------- files filed in Documents
/** Checks an upload the way Documents does: an allowed type, and the bytes are what the name says. */
function checkFile(req) {
  const D = require('./documents').files;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('No file was sent');
  if (buf.length > D.MAX_BYTES) throw bad('Files can be up to 10 MB');
  const name = D.cleanName(decodeURIComponent(String(req.get('x-filename') || 'file')));
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!D.TYPES[ext]) throw bad(`That file type is not allowed. Use ${Object.keys(D.TYPES).join(', ')}.`);
  if (!D.contentMatches(ext, buf)) throw bad(`That file is not a real .${ext} file, or it carries macros. Save it again as a plain .${ext} and upload that.`);
  return { buf, name, mime: D.TYPES[ext] };
}
/**
 * Files a document in the "Building certificates and reports" category of Documents (a new one, or a new version of
 * `documentId`) and lists it under each building in `buildingIds`. Inside the caller's transaction. Returns the document id.
 */
async function fileDocument(conn, req, { documentId, title, description, file, buildingIds, visitId = null, assetId = null }) {
  const D = require('./documents').files;
  const t = req.auth.tenantId;
  let d = documentId ? await one(conn, 'SELECT * FROM documents WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, documentId]) : null;
  if (!d) {
    const category = await B.docCategory(conn, t);
    const [r] = await conn.query('INSERT INTO documents (tenant_id, category_id, title, description, uploaded_by, uploader) VALUES (?, ?, ?, ?, ?, ?)',
      [t, category, String(title).slice(0, 150), description ? String(description).slice(0, 500) : null, req.auth.userId, await B.who(conn, req)]);
    await audit(conn, req, 'create', 'documents', r.insertId, { category_id: category, from: 'buildings' });
    d = await one(conn, 'SELECT * FROM documents WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, r.insertId]);
  }
  const version = await D.storeFile(conn, req, d, { buf: file.buf, name: file.name, mime: file.mime, note: d.file_name ? 'New file from Buildings' : null });
  for (const bid of new Set(buildingIds)) {
    await conn.query('INSERT IGNORE INTO building_documents (tenant_id, building_id, document_id, visit_id, asset_id) VALUES (?, ?, ?, ?, ?)', [t, bid, d.id, visitId, assetId]);
  }
  return { id: d.id, version };
}
const scanLater = (tenantId, id) => require('./documents').files.scanDocument(tenantId, id, { ocr: false }).catch(() => null);

router.put('/certificates/:id/file', crew, raw(10 * 1024 * 1024), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const file = checkFile(req);
  const out = await tx(async (conn) => {
    const c = await one(conn, 'SELECT * FROM building_certificates WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, id]);
    if (!c) throw notFound('Certificate');
    const e = await equipmentOf(conn, t, c.asset_id);
    const doc = await fileDocument(conn, req, { documentId: c.document_id, title: `${c.name}: ${e.name}, expires ${A.ymd(c.expires_on)}`, file, buildingIds: [e.building_id], assetId: e.id });
    await conn.query('UPDATE building_certificates SET document_id = ? WHERE tenant_id = ? AND id = ?', [doc.id, t, id]);
    return doc;
  });
  await scanLater(t, out.id);
  res.status(201).json({ document_id: out.id, version: out.version });
});

/** A file listed under a building (a vendor report, a certificate, a floor plan). Opens for anyone who may use Buildings. */
router.get('/documents/:docId/file', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req, 'docId');
  const link = await one(pool, 'SELECT id FROM building_documents WHERE tenant_id = ? AND document_id = ? LIMIT 1', [t, id]);
  if (!link) throw notFound('Document');
  const d = await one(pool, 'SELECT d.file_name, d.mime_type, f.content FROM documents d JOIN document_files f ON f.tenant_id = d.tenant_id AND f.document_id = d.id WHERE d.tenant_id = ? AND d.id = ?', [t, id]);
  if (!d) throw notFound('File');
  const D = require('./documents').files;
  const inline = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(d.mime_type) && req.query.download !== '1';
  res.set({ 'content-type': d.mime_type, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${D.cleanName(d.file_name)}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" });
  res.send(d.content);
});

// ---------------------------------------------------------------- vendor visits
const VISIT_SQL = `SELECT v.*, n.name AS vendor, d.title AS document, d.file_name,
    (SELECT COUNT(*) FROM building_visit_items i WHERE i.tenant_id = v.tenant_id AND i.visit_id = v.id) AS items,
    (SELECT COUNT(*) FROM building_visit_items i WHERE i.tenant_id = v.tenant_id AND i.visit_id = v.id AND i.result = 'fail') AS failed
  FROM building_visits v JOIN vendors n ON n.tenant_id = v.tenant_id AND n.id = v.vendor_id LEFT JOIN documents d ON d.tenant_id = v.tenant_id AND d.id = v.document_id`;
/** The buildings a visit covered, by name. */
async function visitBuildings(db, tenantId, visitIds) {
  if (!visitIds.length) return new Map();
  const list = await rows(db, `SELECT DISTINCT i.visit_id, b.id, b.name FROM building_visit_items i
      JOIN ops_assets a ON a.tenant_id = i.tenant_id AND a.id = i.asset_id
      JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
      JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id)
    WHERE i.tenant_id = ? AND i.visit_id IN (?) ORDER BY b.name`, [tenantId, visitIds]);
  const map = new Map();
  for (const r of list) { if (!map.has(r.visit_id)) map.set(r.visit_id, []); map.get(r.visit_id).push({ id: r.id, name: r.name }); }
  return map;
}
const shapeVisit = (v, bmap) => ({ ...v, visit_on: A.ymd(v.visit_on), items: Number(v.items), failed: Number(v.failed), buildings: (bmap && bmap.get(v.id)) || [] });

router.get('/visits', async (req, res) => {
  const t = req.auth.tenantId;
  const where = ['v.tenant_id = ?']; const params = [t];
  const bid = Number(first(req.query.building_id)) || null;
  if (bid) {
    where.push(`EXISTS (SELECT 1 FROM building_visit_items i JOIN ops_assets a ON a.tenant_id = i.tenant_id AND a.id = i.asset_id JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
      JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id) WHERE i.tenant_id = v.tenant_id AND i.visit_id = v.id AND b.id = ?)`);
    params.push(bid);
  }
  if (req.query.vendor_id) { where.push('v.vendor_id = ?'); params.push(Number(first(req.query.vendor_id))); }
  const list = await rows(pool, `${VISIT_SQL} WHERE ${where.join(' AND ')} ORDER BY v.visit_on DESC, v.id DESC LIMIT 300`, params);
  const bmap = await visitBuildings(pool, t, list.map((v) => v.id));
  res.json({ data: list.map((v) => shapeVisit(v, bmap)) });
});

router.get('/visits/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const v = await one(pool, `${VISIT_SQL} WHERE v.tenant_id = ? AND v.id = ?`, [t, id]);
  if (!v) throw notFound('Vendor visit');
  const items = await rows(pool, `SELECT i.*, a.name AS asset, a.asset_tag, w.status AS work_order_status, w.title AS work_order FROM building_visit_items i
      JOIN ops_assets a ON a.tenant_id = i.tenant_id AND a.id = i.asset_id LEFT JOIN work_orders w ON w.tenant_id = i.tenant_id AND w.id = i.work_order_id
    WHERE i.tenant_id = ? AND i.visit_id = ? ORDER BY i.id`, [t, id]);
  const certs = await rows(pool, 'SELECT c.id, c.asset_id, c.name, c.number, c.issued_on, c.expires_on, a.name AS asset FROM building_certificates c JOIN ops_assets a ON a.tenant_id = c.tenant_id AND a.id = c.asset_id WHERE c.tenant_id = ? AND c.visit_id = ?', [t, id]);
  const defs = await rows(pool, 'SELECT d.id, d.description, d.work_order_id, w.status AS work_order_status FROM building_deficiencies d LEFT JOIN work_orders w ON w.tenant_id = d.tenant_id AND w.id = d.work_order_id WHERE d.tenant_id = ? AND d.visit_id = ? ORDER BY d.id', [t, id]);
  const bmap = await visitBuildings(pool, t, [id]);
  res.json({ ...shapeVisit(v, bmap), lines: items, certificates: certs.map((c) => ({ ...c, issued_on: A.ymd(c.issued_on), expires_on: A.ymd(c.expires_on) })), deficiencies: defs });
});

const visitItem = z.object({
  plan_id: z.number().int().positive(),
  result: z.enum(['pass', 'fail', 'na']),
  note: nullable(z.string().trim().max(500)),
  answers: z.array(CR.answerSchema).max(60).optional(),
  failed_keys: z.array(z.string().max(30)).max(60).optional(),
  certificate: z.object({ expires_on: dateStr, number: nullable(z.string().trim().max(60)), issued_on: nullable(dateStr) }).optional(),
});
const visitSchema = z.object({
  vendor_id: z.number().int().positive(),
  visit_on: dateStr,
  technician: nullable(z.string().trim().max(100)),
  notes: nullable(z.string().trim().max(1000)),
  items: z.array(visitItem).min(1, 'Pick at least one item the visit covered').max(400),
  deficiencies: z.array(z.object({ plan_id: nullable(z.number().int().positive()), asset_id: nullable(z.number().int().positive()), building_id: nullable(z.number().int().positive()), description: z.string().trim().min(3).max(500), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() })).max(100).optional(),
});

/**
 * Records a vendor's visit: every item it covered (many at once, across buildings), the result of each, a new
 * certificate where the item renews one, and the vendor's findings. Each item is an inspection on the equipment and marks
 * its service plan done on the visit date (not applicable leaves it as it was). Each failed item and each finding opens a
 * work order. The report or certificate file is attached next, with PUT /visits/:id/file.
 */
router.post('/visits', crew, validate(visitSchema), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const today = await todayOf(t);
  if (b.visit_on > today) throw bad('The visit date is in the future. Record a visit once it has happened.');
  if (new Set(b.items.map((i) => i.plan_id)).size !== b.items.length) throw bad('Each item can be listed once on a visit');
  const out = await tx(async (conn) => {
    const vendor = await one(conn, 'SELECT id, name FROM vendors WHERE tenant_id = ? AND id = ?', [t, b.vendor_id]);
    if (!vendor) throw notFound('Vendor');
    const [r] = await conn.query('INSERT INTO building_visits (tenant_id, vendor_id, visit_on, technician, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)', [t, b.vendor_id, b.visit_on, b.technician ?? null, b.notes ?? null, req.auth.userId]);
    const visitId = r.insertId;
    const at = b.visit_on === today ? nowIn(await tzOf(conn, t)) : `${b.visit_on} 12:00:00`;
    const inspector = [vendor.name, b.technician].filter(Boolean).join(', ');
    const lines = []; const workOrders = []; const certificates = [];
    for (const it of b.items) {
      const plan = await B.planFor(conn, t, it.plan_id);
      if (!plan) throw notFound('Building check');
      if (it.result === 'fail' && !it.note && !(it.answers && it.answers.length)) throw bad(`${plan.task} on ${plan.asset}: say what the vendor found`);
      const rec = await B.recordCheck(conn, req, plan, { answers: it.answers, result: it.result, failedKeys: it.failed_keys || [], note: it.note, on: b.visit_on, at, inspector, source: 'visit', visitId });
      let certId = null;
      if (it.certificate) {
        if (!plan.certificate) throw bad(`${plan.task} does not renew a certificate. Add certificates for it under Certificates.`);
        if (it.certificate.issued_on && it.certificate.issued_on > it.certificate.expires_on) throw bad('A certificate runs out before it was issued. Check the dates.');
        certId = await B.addCertificate(conn, req, { assetId: plan.asset_id, name: plan.certificate, number: it.certificate.number, issuedOn: it.certificate.issued_on || b.visit_on, expiresOn: it.certificate.expires_on, visitId });
        certificates.push(certId);
      }
      await conn.query(`INSERT INTO building_visit_items (tenant_id, visit_id, pm_task_id, task_id, asset_id, task_name, result, note, inspection_id, work_order_id, certificate_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [t, visitId, plan.plan_id, plan.task_id, plan.asset_id, plan.task.slice(0, 120), rec.result === 'fail' ? 'fail' : it.result === 'na' ? 'na' : 'pass', it.note ?? null, rec.inspection_id, rec.work_order_id, certId]);
      if (rec.work_order_id) workOrders.push(rec.work_order_id);
      lines.push({ plan_id: plan.plan_id, result: rec.result, inspection_id: rec.inspection_id, work_order_id: rec.work_order_id, certificate_id: certId });
    }
    for (const d of b.deficiencies || []) {
      let plan = null; let asset = null; let building = null;
      if (d.plan_id) { plan = await B.planFor(conn, t, d.plan_id); if (!plan) throw notFound('Building check'); }
      const assetId = d.asset_id || (plan && plan.asset_id);
      if (assetId) asset = await equipmentOf(conn, t, assetId);
      if (asset) building = { id: asset.building_id, name: asset.building, room: asset.room };
      else if (d.building_id) { const bb = await buildingOf(conn, t, d.building_id); building = { id: bb.id, name: bb.name, room: null }; }
      else throw bad('Say which building or piece of equipment each finding is about');
      const def = await B.openDeficiency(conn, req, { buildingId: building.id, building: building.name, room: building.room, asset, description: d.description, foundOn: b.visit_on, source: 'visit', visitId, priority: d.priority, title: `${vendor.name} finding: ${d.description}` });
      workOrders.push(def.work_order_id);
    }
    await audit(conn, req, 'create', 'building_visits', visitId, { vendor_id: b.vendor_id, items: b.items.length, work_orders: workOrders.length });
    return { id: visitId, items: lines, work_orders: workOrders, certificates };
  });
  res.status(201).json(out);
});

/** The vendor's report or certificate for a visit, filed in Documents under every building the visit covered. */
router.put('/visits/:id/file', crew, raw(10 * 1024 * 1024), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const file = checkFile(req);
  const out = await tx(async (conn) => {
    const v = await one(conn, 'SELECT v.*, n.name AS vendor FROM building_visits v JOIN vendors n ON n.tenant_id = v.tenant_id AND n.id = v.vendor_id WHERE v.tenant_id = ? AND v.id = ? FOR UPDATE', [t, id]);
    if (!v) throw notFound('Vendor visit');
    const bmap = await visitBuildings(conn, t, [id]);
    const buildings = bmap.get(id) || [];
    const title = req.get('x-title') ? decodeURIComponent(String(req.get('x-title'))).trim().slice(0, 150) : `${v.vendor} report, ${A.ymd(v.visit_on)}`;
    const doc = await fileDocument(conn, req, { documentId: v.document_id, title, description: `Vendor visit on ${A.ymd(v.visit_on)}: ${buildings.map((x) => x.name).join(', ')}`, file, buildingIds: buildings.map((x) => x.id), visitId: id });
    await conn.query('UPDATE building_visits SET document_id = ? WHERE tenant_id = ? AND id = ?', [doc.id, t, id]);
    // The certificates this visit renewed point at the same file.
    await conn.query('UPDATE building_certificates SET document_id = ? WHERE tenant_id = ? AND visit_id = ? AND document_id IS NULL', [doc.id, t, id]);
    await audit(conn, req, 'attach_file', 'building_visits', id, { document_id: doc.id, version: doc.version });
    return doc;
  });
  await scanLater(t, out.id);
  res.status(201).json({ document_id: out.id, version: out.version });
});

// ---------------------------------------------------------------- deficiencies
const DEF_SQL = `SELECT d.*, b.name AS building, a.name AS asset, a.asset_tag, w.title AS work_order, w.status AS work_order_status, w.priority, w.completed_at, w.resolution, n.name AS vendor
  FROM building_deficiencies d JOIN buildings b ON b.tenant_id = d.tenant_id AND b.id = d.building_id
  LEFT JOIN ops_assets a ON a.tenant_id = d.tenant_id AND a.id = d.asset_id
  LEFT JOIN work_orders w ON w.tenant_id = d.tenant_id AND w.id = d.work_order_id
  LEFT JOIN building_visits v ON v.tenant_id = d.tenant_id AND v.id = d.visit_id
  LEFT JOIN vendors n ON n.tenant_id = v.tenant_id AND n.id = v.vendor_id`;
// A deficiency is open while its work order is; a work order that was deleted leaves it closed with no date.
const defOpen = "(w.id IS NOT NULL AND w.status NOT IN ('done','cancelled'))";
const shapeDef = (d) => ({ ...d, found_on: A.ymd(d.found_on), open: Boolean(d.work_order_id && d.work_order_status && !['done', 'cancelled'].includes(d.work_order_status)), fixed_on: d.work_order_status === 'done' && d.completed_at ? String(d.completed_at).slice(0, 10) : null });

router.get('/deficiencies', async (req, res) => {
  const where = ['d.tenant_id = ?']; const params = [req.auth.tenantId];
  if (req.query.building_id) { where.push('d.building_id = ?'); params.push(Number(first(req.query.building_id))); }
  const st = first(req.query.status) || 'open';
  if (st === 'open') where.push(defOpen); else if (st === 'closed') where.push(`NOT ${defOpen}`);
  res.json({ data: (await rows(pool, `${DEF_SQL} WHERE ${where.join(' AND ')} ORDER BY d.found_on DESC, d.id DESC LIMIT 500`, params)).map(shapeDef) });
});

/** Something found wrong outside a round or a visit (the fire marshal's walk-through): opens a work order. */
router.post('/deficiencies', crew, validate(z.object({ building_id: z.number().int().positive(), asset_id: nullable(z.number().int().positive()), description: z.string().trim().min(3).max(500), found_on: nullable(dateStr), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const today = await todayOf(t);
  if (b.found_on && b.found_on > today) throw bad('That date is in the future');
  const out = await tx(async (conn) => {
    const bld = await buildingOf(conn, t, b.building_id);
    const asset = b.asset_id ? await equipmentOf(conn, t, b.asset_id) : null;
    if (asset && asset.building_id !== bld.id) throw bad('That equipment is in another building');
    const d = await B.openDeficiency(conn, req, { buildingId: bld.id, building: bld.name, room: asset ? asset.room : null, asset, description: b.description, foundOn: b.found_on || today, source: 'manual', priority: b.priority });
    await audit(conn, req, 'create', 'building_deficiencies', d.id, { work_order_id: d.work_order_id });
    return d;
  });
  res.status(201).json(out);
});

// ---------------------------------------------------------------- staff rounds
async function roundOf(conn, tenantId, id, { lock = false } = {}) {
  const r = await one(conn, `SELECT r.*, b.name AS building FROM building_rounds r JOIN buildings b ON b.tenant_id = r.tenant_id AND b.id = r.building_id WHERE r.tenant_id = ? AND r.id = ?${lock ? ' FOR UPDATE' : ''}`, [tenantId, id]);
  if (!r) throw notFound('Round');
  return r;
}

router.get('/rounds/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const r = await roundOf(pool, t, id);
  const stops = await rows(pool, `SELECT s.*, a.name AS asset, a.asset_tag, a.kind, k.name AS task, k.template_id, i.items AS steps, l.name AS room_full, w.status AS work_order_status
      FROM building_round_stops s JOIN ops_assets a ON a.tenant_id = s.tenant_id AND a.id = s.asset_id
      JOIN life_safety_tasks k ON k.tenant_id = s.tenant_id AND k.id = s.task_id
      LEFT JOIN inspection_templates i ON i.tenant_id = k.tenant_id AND i.id = k.template_id
      LEFT JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
      LEFT JOIN work_orders w ON w.tenant_id = s.tenant_id AND w.id = s.work_order_id
    WHERE s.tenant_id = ? AND s.round_id = ? ORDER BY s.sort, s.id`, [t, id]);
  const photos = await rows(pool, 'SELECT id, stop_id, sha256, bytes, uploaded_at FROM building_photos WHERE tenant_id = ? AND stop_id IN (SELECT id FROM building_round_stops WHERE tenant_id = ? AND round_id = ?) ORDER BY id', [t, t, id]);
  res.json({
    ...r,
    stops: stops.map((s) => {
      const room = s.room_full && s.room_full !== r.building ? B.roomName(r.building, s.room_full) : null;
      return { ...s, scanned: Boolean(s.scanned), steps: s.steps ? JSON.parse(s.steps) : [], room, room_full: undefined, photos: photos.filter((p) => p.stop_id === s.id) };
    }),
    counts: { total: stops.length, done: stops.filter((s) => s.result && s.result !== 'skipped').length, failed: stops.filter((s) => s.result === 'fail').length, missing: stops.filter((s) => s.result === 'missing').length },
  });
});

/**
 * One stop of a round: pass with one tap (every pass-or-fail item passes), fail with what is wrong (opens a work order),
 * or missing (not found in its place: a work order to find or replace it, and the check is not counted as done).
 * scanned: the person scanned the item's QR tag rather than picking it from the list.
 */
router.post('/rounds/:id/stops/:stopId', crew, validate(z.object({
  result: z.enum(['pass', 'fail', 'missing']),
  answers: z.array(CR.answerSchema).max(60).optional(),
  failed_keys: z.array(z.string().max(30)).max(60).optional(),
  note: nullable(z.string().trim().max(500)),
  scanned: z.boolean().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const stopId = paramId(req, 'stopId'); const b = req.body;
  const out = await tx(async (conn) => {
    const r = await roundOf(conn, t, id, { lock: true });
    if (r.status !== 'open') throw conflict('This round is finished. Start a new round to check again.');
    const s = await one(conn, 'SELECT * FROM building_round_stops WHERE tenant_id = ? AND round_id = ? AND id = ? FOR UPDATE', [t, id, stopId]);
    if (!s) throw notFound('Stop');
    if (s.result) throw conflict('This item is already checked on this round');
    const plan = await B.planFor(conn, t, s.pm_task_id);
    if (!plan) throw notFound('Building check');
    if (b.result === 'fail' && !b.note && !(b.answers && b.answers.length)) throw bad('Say what is wrong');
    const tz = await tzOf(conn, t);
    const rec = await B.recordCheck(conn, req, plan, { answers: b.result === 'missing' ? undefined : b.answers, result: b.result === 'missing' ? 'fail' : b.result, failedKeys: b.failed_keys || [], note: b.note, on: todayIn(tz), at: nowIn(tz), inspector: await B.who(conn, req), source: 'round', roundId: id, missing: b.result === 'missing' });
    const result = rec.result === 'missing' ? 'missing' : rec.result === 'fail' ? 'fail' : 'pass';
    await conn.query('UPDATE building_round_stops SET result = ?, note = ?, scanned = ?, inspection_id = ?, work_order_id = ?, checked_at = ?, checked_by = ? WHERE tenant_id = ? AND id = ?',
      [result, b.note ?? null, b.scanned ? 1 : 0, rec.inspection_id, rec.work_order_id, nowIn(tz), req.auth.userId, t, stopId]);
    return { result, inspection_id: rec.inspection_id, work_order_id: rec.work_order_id };
  });
  res.json(out);
});

/** A photo of what failed: kept as taken, with its SHA-256 recorded. Never shown outside the signed-in app. */
router.post('/rounds/:id/stops/:stopId/photo', crew, raw(15 * 1024 * 1024), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const stopId = paramId(req, 'stopId');
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const out = await tx(async (conn) => {
    const r = await roundOf(conn, t, id);
    const s = await one(conn, 'SELECT id, asset_id, inspection_id, result FROM building_round_stops WHERE tenant_id = ? AND round_id = ? AND id = ?', [t, id, stopId]);
    if (!s) throw notFound('Stop');
    if (!s.result || s.result === 'skipped') throw bad('Check the item first, then add the photo');
    const hash = sha(buf);
    const facts = photoFacts(buf);
    const [p] = await conn.query('INSERT INTO building_photos (tenant_id, building_id, asset_id, stop_id, inspection_id, mime, bytes, sha256, original, taken_at, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [t, r.building_id, s.asset_id, s.id, s.inspection_id, mime, buf.length, hash, buf, facts.taken_at, req.auth.userId, nowIn(await tzOf(conn, t))]);
    await audit(conn, req, 'add_photo', 'building_round_stops', s.id, { photo_id: p.insertId, sha256: hash, bytes: buf.length });
    return { id: p.insertId, sha256: hash, bytes: buf.length };
  });
  res.status(201).json(out);
});

router.get('/photos/:id', crew, async (req, res) => {
  const p = await one(pool, 'SELECT mime, sha256, original FROM building_photos WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!p) throw notFound('Photo');
  res.set({ 'content-type': p.mime, 'x-sha256': p.sha256, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" });
  res.send(p.original);
});

/** Ends the round. Anything not checked is listed as skipped (still due on the calendar). */
router.post('/rounds/:id/finish', crew, validate(z.object({ note: nullable(z.string().trim().max(500)) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    const r = await roundOf(conn, t, id, { lock: true });
    if (r.status !== 'open') throw conflict('This round is already finished');
    const [sk] = await conn.query("UPDATE building_round_stops SET result = 'skipped' WHERE tenant_id = ? AND round_id = ? AND result IS NULL", [t, id]);
    await conn.query("UPDATE building_rounds SET status = 'done', finished_at = ?, note = COALESCE(?, note) WHERE tenant_id = ? AND id = ?", [nowIn(await tzOf(conn, t)), req.body.note ?? null, t, id]);
    const c = await one(conn, "SELECT SUM(result = 'pass') AS passed, SUM(result = 'fail') AS failed, SUM(result = 'missing') AS missing FROM building_round_stops WHERE tenant_id = ? AND round_id = ?", [t, id]);
    await audit(conn, req, 'finish', 'building_rounds', id, { skipped: sk.affectedRows });
    return { passed: Number(c.passed || 0), failed: Number(c.failed || 0), missing: Number(c.missing || 0), skipped: sk.affectedRows };
  });
  res.json(out);
});

// ---------------------------------------------------------------- the binder
const CSV_COLS = ['section', 'building', 'date', 'item', 'equipment', 'tag', 'result', 'details', 'by', 'expires_on', 'status', 'fixed_on'];
const fmtVal = (i) => (i.value != null ? `${i.value}${i.unit ? ` ${i.unit}` : ''}` : null);

/**
 * Everything an insurer's loss-control visit or the fire marshal asks for, for one building (or all) and a date range:
 * each building's summary, every inspection and vendor visit in the range with results, the certificates on file with
 * their expiry dates, deficiencies (found in the range, or still open) with the date each was fixed, and what is overdue
 * now. format=csv gives the same as a spreadsheet. No resident details are in any of it.
 */
router.get('/binder', async (req, res) => {
  const t = req.auth.tenantId;
  const today = await todayOf(t);
  const to = first(req.query.to) || today;
  const from = first(req.query.from) || addDays(to, -365);
  if (!dateStr.safeParse(from).success || !dateStr.safeParse(to).success) throw bad('Use dates like 2026-01-31');
  if (from > to) throw bad('The start date is after the end date');
  if (addDays(from, 366 * 5) < to) throw bad('Pick a range of five years or less');
  const bid = Number(first(req.query.building_id)) || null;
  const bl = bid ? [await buildingOf(pool, t, bid)] : await rows(pool, 'SELECT * FROM buildings WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]);
  const ids = bl.map((b) => b.id);
  const inB = ids.length ? ids : [0];
  const equipment = (await rows(pool, `${B.EQUIPMENT_SQL} AND b.id IN (?) ORDER BY b.name, a.name`, [t, inB])).map(B.shapeEquipment);
  const rooms = await rows(pool, 'SELECT b.id AS building_id, COUNT(l.id) AS n FROM buildings b JOIN asset_locations l ON l.tenant_id = b.tenant_id AND l.parent_id = b.location_id AND l.active = 1 WHERE b.tenant_id = ? AND b.id IN (?) GROUP BY b.id', [t, inB]);
  const buildings = [];
  for (const b of bl) {
    const mine = equipment.filter((e) => e.building_id === b.id && e.status !== 'retired');
    const byKind = {}; for (const e of mine) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    buildings.push({ ...(await shapeBuilding(pool, t, b)), rooms: Number((rooms.find((r) => r.building_id === b.id) || {}).n || 0), equipment: mine.length,
      by_kind: Object.entries(byKind).map(([kind, n]) => ({ kind, label: kindLabel(kind), n })).sort((x, y) => x.label.localeCompare(y.label)) });
  }
  const assetIds = equipment.map((e) => e.id);
  const where = assetIds.length ? assetIds : [0];
  const insp = await rows(pool, `SELECT i.id, i.asset_id, i.template_name, i.result, i.items, i.inspector, i.note, i.done_at, i.work_order_id,
      vi.visit_id, n.name AS vendor, rs.round_id
    FROM asset_inspections i
    LEFT JOIN building_visit_items vi ON vi.tenant_id = i.tenant_id AND vi.inspection_id = i.id
    LEFT JOIN building_visits v ON v.tenant_id = vi.tenant_id AND v.id = vi.visit_id
    LEFT JOIN vendors n ON n.tenant_id = v.tenant_id AND n.id = v.vendor_id
    LEFT JOIN building_round_stops rs ON rs.tenant_id = i.tenant_id AND rs.inspection_id = i.id
    WHERE i.tenant_id = ? AND i.asset_id IN (?) AND i.done_at >= ? AND i.done_at <= ? ORDER BY i.done_at, i.id`, [t, where, `${from} 00:00:00`, `${to} 23:59:59`]);
  const eq = new Map(equipment.map((e) => [e.id, e]));
  const inspections = insp.map((i) => {
    const e = eq.get(i.asset_id); const items = JSON.parse(i.items || '[]');
    return {
      id: i.id, date: String(i.done_at).slice(0, 10), building_id: e.building_id, building: e.building, room: e.room, asset_id: i.asset_id, asset: e.name, tag: e.asset_tag, check: i.template_name, result: i.result,
      by: i.inspector, source: i.visit_id ? 'visit' : i.round_id ? 'round' : 'other', visit_id: i.visit_id, work_order_id: i.work_order_id,
      failed: items.filter((x) => x.result === 'fail').map((x) => `${x.label}${fmtVal(x) ? ` (${fmtVal(x)})` : ''}${x.note ? `: ${x.note}` : ''}`),
      readings: items.filter((x) => x.value != null && x.result !== 'fail').map((x) => `${x.label}: ${fmtVal(x)}`),
      note: i.note,
    };
  });
  const visitRows = await rows(pool, `${VISIT_SQL} WHERE v.tenant_id = ? AND v.visit_on >= ? AND v.visit_on <= ? AND EXISTS (SELECT 1 FROM building_visit_items i WHERE i.tenant_id = v.tenant_id AND i.visit_id = v.id AND i.asset_id IN (?)) ORDER BY v.visit_on, v.id`, [t, from, to, where]);
  const bmap = await visitBuildings(pool, t, visitRows.map((v) => v.id));
  const visits = [];
  for (const v of visitRows) {
    const lines = await rows(pool, 'SELECT asset_id, task_name, result, note FROM building_visit_items WHERE tenant_id = ? AND visit_id = ? AND asset_id IN (?) ORDER BY id', [t, v.id, where]);
    visits.push({ ...shapeVisit(v, bmap), buildings: (bmap.get(v.id) || []).filter((x) => ids.includes(x.id)), lines: lines.map((l) => ({ ...l, asset: (eq.get(l.asset_id) || {}).name, tag: (eq.get(l.asset_id) || {}).asset_tag })) });
  }
  const certificates = (await B.currentCerts(pool, t, today)).filter((c) => ids.includes(c.building_id));
  const deficiencies = (await rows(pool, `${DEF_SQL} WHERE d.tenant_id = ? AND d.building_id IN (?) AND ((d.found_on >= ? AND d.found_on <= ?) OR ${defOpen}) ORDER BY d.found_on, d.id`, [t, inB, from, to])).map(shapeDef);
  const overdue = (await B.plansOf(pool, t, today)).filter((p) => ids.includes(p.building_id) && (p.state === 'overdue' || p.state === 'never'));
  const binder = { from, to, today, all: !bid, buildings, inspections, visits, certificates, deficiencies, overdue };

  if (first(req.query.format) === 'csv') {
    const out = [];
    for (const b of buildings) out.push({ section: 'Building', building: b.name, item: b.type_label, details: [b.full_address, b.year_built ? `Built ${b.year_built}` : null, b.square_feet ? `${b.square_feet} sq ft` : null, `${b.rooms} rooms or areas`, `${b.equipment} items: ${b.by_kind.map((k) => `${k.n} ${k.label}`).join('; ')}`].filter(Boolean).join('. ') });
    for (const i of inspections) out.push({ section: 'Inspection', building: i.building, date: i.date, item: i.check, equipment: i.asset, tag: i.tag, result: i.result, details: [...i.failed, ...i.readings, i.note].filter(Boolean).join('; '), by: i.by });
    for (const v of visits) out.push({ section: 'Vendor visit', building: v.buildings.map((x) => x.name).join('; '), date: v.visit_on, item: `${v.items} items, ${v.failed} failed`, by: [v.vendor, v.technician].filter(Boolean).join(', '), details: [v.notes, v.document ? `Report on file: ${v.document}` : 'No report on file'].filter(Boolean).join('. ') });
    for (const c of certificates) out.push({ section: 'Certificate', building: c.building, item: c.name, equipment: c.asset, tag: c.asset_tag, expires_on: c.expires_on, status: c.state, details: [c.number ? `Number ${c.number}` : null, c.document ? 'On file' : 'No file attached'].filter(Boolean).join('. ') });
    for (const d of deficiencies) out.push({ section: 'Deficiency', building: d.building, date: d.found_on, item: d.description, equipment: d.asset, tag: d.asset_tag, status: d.open ? 'Open' : d.fixed_on ? 'Fixed' : 'Closed', fixed_on: d.fixed_on, by: d.vendor || null, details: d.resolution });
    for (const p of overdue) out.push({ section: 'Overdue', building: p.building, date: p.due_on, item: p.task, equipment: p.asset, tag: p.asset_tag, status: p.state === 'never' ? 'No record yet' : 'Overdue', details: p.standard ? `Standard: ${p.standard}` : null, by: p.who === 'vendor' ? (p.vendor || 'Vendor') : 'Staff' });
    await audit(pool, req, 'export', 'buildings', bid, { from, to, rows: out.length });
    const name = `building-binder-${bid ? bl[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'all'}-${from}-to-${to}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}"`).send(toCsv(CSV_COLS, out));
    return;
  }
  res.json(binder);
});

// ---------------------------------------------------------------- buildings
const bFields = {
  name: z.string().trim().min(2).max(80),
  type: z.enum(B.TYPE_KEYS).default('other'),
  street_id: nullable(z.number().int().positive()),
  house_number: nullable(z.string().trim().max(20)),
  address: nullable(z.string().trim().max(150)),
  year_built: nullable(z.number().int().min(1700).max(2100)),
  square_feet: nullable(z.number().int().min(1).max(10000000)),
  notes: nullable(z.string().max(500)),
  active: z.boolean().optional(),
};
const roomField = z.string().trim().min(1).max(60);

router.get('/', async (req, res) => {
  const t = req.auth.tenantId;
  const today = await todayOf(t);
  const list = await rows(pool, `SELECT b.*,
      (SELECT COUNT(*) FROM asset_locations l WHERE l.tenant_id = b.tenant_id AND l.parent_id = b.location_id AND l.active = 1) AS rooms
    FROM buildings b WHERE b.tenant_id = ? ${req.query.all === '1' ? '' : 'AND b.active = 1'} ORDER BY b.name`, [t]);
  const equipment = await rows(pool, `SELECT b.id AS building_id, COUNT(*) AS n FROM ops_assets a JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id
    JOIN buildings b ON b.tenant_id = a.tenant_id AND (b.location_id = l.id OR b.location_id = l.parent_id) WHERE a.tenant_id = ? AND a.status <> 'retired' GROUP BY b.id`, [t]);
  const plans = await B.plansOf(pool, t, today);
  const certs = await B.currentCerts(pool, t, today);
  const defs = await rows(pool, `SELECT d.building_id, COUNT(*) AS n FROM building_deficiencies d JOIN work_orders w ON w.tenant_id = d.tenant_id AND w.id = d.work_order_id WHERE d.tenant_id = ? AND w.status NOT IN ('done','cancelled') GROUP BY d.building_id`, [t]);
  const data = [];
  for (const b of list) {
    const mine = plans.filter((p) => p.building_id === b.id);
    const cert = certs.filter((c) => c.building_id === b.id)[0] || null;
    data.push({ ...(await shapeBuilding(pool, t, b)), rooms: Number(b.rooms), equipment: Number((equipment.find((e) => e.building_id === b.id) || {}).n || 0),
      overdue: mine.filter((p) => p.state === 'overdue').length, never: mine.filter((p) => p.state === 'never').length, due_week: mine.filter((p) => p.state === 'week').length,
      open_deficiencies: Number((defs.find((d) => d.building_id === b.id) || {}).n || 0), next_certificate: cert ? { name: cert.name, asset: cert.asset, expires_on: cert.expires_on, state: cert.state } : null });
  }
  res.json({ today, data });
});

router.post('/', manager, validate(z.object({ ...bFields, rooms: z.array(roomField).max(100).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const id = await tx(async (conn) => {
    await mustExist(conn, 'streets', t, b.street_id, 'Street');
    // A place of the same name already on the asset register becomes this building's place, if it is not one already.
    let loc = await one(conn, 'SELECT id, kind FROM asset_locations WHERE tenant_id = ? AND name = ? FOR UPDATE', [t, b.name]);
    if (loc && await one(conn, 'SELECT id FROM buildings WHERE tenant_id = ? AND location_id = ?', [t, loc.id])) throw conflict('There is already a building with that name');
    if (loc) await conn.query("UPDATE asset_locations SET kind = 'building', active = 1 WHERE tenant_id = ? AND id = ?", [t, loc.id]);
    else { const [r] = await conn.query("INSERT INTO asset_locations (tenant_id, name, kind) VALUES (?, ?, 'building')", [t, b.name]); loc = { id: r.insertId }; }
    let r;
    try {
      [r] = await conn.query('INSERT INTO buildings (tenant_id, location_id, name, type, street_id, house_number, address, year_built, square_feet, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [t, loc.id, b.name, b.type, b.street_id ?? null, b.house_number ?? null, b.address ?? null, b.year_built ?? null, b.square_feet ?? null, b.notes ?? null]);
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a building with that name'); throw err; }
    for (const room of new Set(b.rooms || [])) {
      try { await conn.query("INSERT INTO asset_locations (tenant_id, name, kind, parent_id) VALUES (?, ?, 'area', ?)", [t, B.roomLocationName(b.name, room), loc.id]); } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw conflict(`There is already a place called "${B.roomLocationName(b.name, room)}" on the asset register`); throw err;
      }
    }
    await audit(conn, req, 'create', 'buildings', r.insertId, { name: b.name });
    return r.insertId;
  });
  await B.syncPlans(pool, t);
  res.status(201).json({ id });
});

router.get('/:id', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const today = await todayOf(t);
  const b = await buildingOf(pool, t, id);
  const [roomList, equipment, plans, certs, docs, defs, rounds, recent] = await Promise.all([
    rows(pool, 'SELECT id, name, active, (SELECT COUNT(*) FROM ops_assets a WHERE a.tenant_id = l.tenant_id AND a.location_id = l.id AND a.status <> \'retired\') AS equipment FROM asset_locations l WHERE l.tenant_id = ? AND l.parent_id = ? ORDER BY l.active DESC, l.name', [t, b.location_id]),
    rows(pool, `${B.EQUIPMENT_SQL} AND b.id = ? ORDER BY a.status = 'retired', l.name, a.name`, [t, id]),
    B.plansOf(pool, t, today, { buildingId: id }),
    B.currentCerts(pool, t, today, { buildingId: id }),
    rows(pool, 'SELECT d.id, d.title, d.file_name, d.mime_type, d.version, d.updated_at, x.visit_id, x.asset_id FROM building_documents x JOIN documents d ON d.tenant_id = x.tenant_id AND d.id = x.document_id WHERE x.tenant_id = ? AND x.building_id = ? ORDER BY d.updated_at DESC', [t, id]),
    rows(pool, `${DEF_SQL} WHERE d.tenant_id = ? AND d.building_id = ? AND ${defOpen} ORDER BY d.found_on DESC`, [t, id]),
    rows(pool, "SELECT r.id, r.status, r.started_at, r.finished_at, (SELECT COUNT(*) FROM building_round_stops s WHERE s.tenant_id = r.tenant_id AND s.round_id = r.id) AS stops, (SELECT COUNT(*) FROM building_round_stops s WHERE s.tenant_id = r.tenant_id AND s.round_id = r.id AND s.result IN ('fail','missing')) AS problems FROM building_rounds r WHERE r.tenant_id = ? AND r.building_id = ? ORDER BY r.started_at DESC LIMIT 10", [t, id]),
    rows(pool, `SELECT i.id, i.asset_id, a.name AS asset, a.asset_tag, i.template_name, i.result, i.inspector, i.done_at, i.work_order_id FROM asset_inspections i JOIN ops_assets a ON a.tenant_id = i.tenant_id AND a.id = i.asset_id
      JOIN asset_locations l ON l.tenant_id = a.tenant_id AND l.id = a.location_id WHERE i.tenant_id = ? AND (l.id = ? OR l.parent_id = ?) ORDER BY i.done_at DESC, i.id DESC LIMIT 30`, [t, b.location_id, b.location_id]),
  ]);
  res.json({
    ...(await shapeBuilding(pool, t, b)), today,
    rooms: roomList.map((r) => ({ id: r.id, name: B.roomName(b.name, r.name), active: Boolean(r.active), equipment: Number(r.equipment) })),
    equipment: equipment.map(B.shapeEquipment).map((e) => ({ ...e, kind_label: kindLabel(e.kind), plans: plans.filter((p) => p.asset_id === e.id) })),
    plans, certificates: certs, documents: docs, deficiencies: defs.map(shapeDef), rounds: rounds.map((r) => ({ ...r, stops: Number(r.stops), problems: Number(r.problems) })), inspections: recent,
  });
});

router.patch('/:id', manager, validate(partialOf(bFields)), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = { ...req.body };
  await tx(async (conn) => {
    const cur = await buildingOf(conn, t, id, { lock: true });
    await mustExist(conn, 'streets', t, b.street_id, 'Street');
    if (b.active !== undefined) b.active = b.active ? 1 : 0;
    const set = setClause(b, Object.keys(bFields));
    if (!set) throw bad('Nothing to change');
    try {
      await conn.query(`UPDATE buildings SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, id]);
      if (b.name && b.name !== cur.name) {
        await conn.query('UPDATE asset_locations SET name = ? WHERE tenant_id = ? AND id = ?', [b.name, t, cur.location_id]);
        const kids = await rows(conn, 'SELECT id, name FROM asset_locations WHERE tenant_id = ? AND parent_id = ?', [t, cur.location_id]);
        for (const k of kids) await conn.query('UPDATE asset_locations SET name = ? WHERE tenant_id = ? AND id = ?', [B.roomLocationName(b.name, B.roomName(cur.name, k.name)), t, k.id]);
      }
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a building or place with that name'); throw err; }
    if (b.active !== undefined) await conn.query('UPDATE asset_locations SET active = ? WHERE tenant_id = ? AND id = ?', [b.active, t, cur.location_id]);
    await audit(conn, req, 'update', 'buildings', id, Object.keys(req.body));
  });
  await B.syncPlans(pool, t);
  res.json({ ok: true });
});

router.post('/:id/rooms', manager, validate(z.object({ name: roomField })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const b = await buildingOf(pool, t, id);
  try {
    const [r] = await pool.query("INSERT INTO asset_locations (tenant_id, name, kind, parent_id) VALUES (?, ?, 'area', ?)", [t, B.roomLocationName(b.name, req.body.name), b.location_id]);
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('This building already has a room or area with that name'); throw err; }
});
router.patch('/:id/rooms/:roomId', manager, validate(z.object({ name: roomField.optional(), active: z.boolean().optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const b = await buildingOf(pool, t, id);
  const room = await roomOf(pool, t, b, paramId(req, 'roomId'));
  const set = setClause({ name: req.body.name ? B.roomLocationName(b.name, req.body.name) : undefined, active: req.body.active === undefined ? undefined : (req.body.active ? 1 : 0) }, ['name', 'active']);
  if (!set) throw bad('Nothing to change');
  try { await pool.query(`UPDATE asset_locations SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, t, room.id]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('This building already has a room or area with that name'); throw err;
  }
  res.json({ ok: true });
});

/**
 * Adds equipment to a building: new items on the asset register (each with its own QR tag; count makes several at once,
 * numbered "Fire extinguisher 1", "Fire extinguisher 2"...), or an item already on the register moved in (asset_id).
 * Service plans for every library check of its kind are made at once.
 */
router.post('/:id/equipment', crew, validate(z.object({
  asset_id: nullable(z.number().int().positive()),
  name: z.string().trim().min(1).max(90).optional(),
  kind: z.string().refine((k) => O.ASSET_KIND_KEYS.includes(k), 'Choose a kind of equipment').optional(),
  room_id: nullable(z.number().int().positive()),
  count: z.number().int().min(1).max(60).default(1),
  make_model: nullable(z.string().max(100)), serial: nullable(z.string().max(80)), notes: nullable(z.string().max(500)),
  critical: z.boolean().optional(),
}).refine((v) => v.asset_id || (v.name && v.kind), 'Give a name and a kind, or pick something already on the asset register')), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const ids = await tx(async (conn) => {
    const bld = await buildingOf(conn, t, id);
    const room = await roomOf(conn, t, bld, b.room_id);
    const locationId = room ? room.id : bld.location_id;
    if (b.asset_id) {
      const a = await one(conn, 'SELECT id, status FROM ops_assets WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, b.asset_id]);
      if (!a) throw notFound('Asset');
      await conn.query('UPDATE ops_assets SET location_id = ? WHERE tenant_id = ? AND id = ?', [locationId, t, a.id]);
      await audit(conn, req, 'move', 'ops_assets', a.id, { building_id: bld.id, location_id: locationId });
      return [a.id];
    }
    await A.ensureSettings(conn, t);
    const made = [];
    let k = 1;
    for (let i = 0; i < b.count; i += 1) {
      let name = b.name;
      if (b.count > 1) { while (await one(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND name = ?', [t, `${b.name} ${k}`])) k += 1; name = `${b.name} ${k}`; k += 1; }
      const row = await one(conn, 'SELECT next_tag FROM asset_settings WHERE tenant_id = ? FOR UPDATE', [t]);
      let n = Number(row.next_tag);
      while (await one(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND asset_tag = ?', [t, A.tagOf(n)])) n += 1;
      await conn.query('UPDATE asset_settings SET next_tag = ? WHERE tenant_id = ?', [n + 1, t]);
      try {
        const [r] = await conn.query('INSERT INTO ops_assets (tenant_id, name, kind, category, asset_tag, location_id, make_model, serial, notes, critical) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [t, name.slice(0, 100), b.kind, O.CATEGORY_OF[b.kind] || 'other', A.tagOf(n), locationId, b.make_model ?? null, b.serial ?? null, b.notes ?? null, b.critical ? 1 : 0]);
        made.push(r.insertId);
        await audit(conn, req, 'create', 'ops_assets', r.insertId, { tag: A.tagOf(n), building_id: bld.id });
      } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict(`There is already an asset called "${name}". Give it a name with its building or room, such as "${bld.name} ${b.name}".`); throw err; }
    }
    return made;
  });
  const plans = await B.syncPlans(pool, t);
  res.status(201).json({ ids, plans_made: plans });
});

/** Moves equipment to another room, or to another building (building_id). Its service plans and history go with it. */
router.patch('/:id/equipment/:assetId', crew, validate(z.object({ room_id: nullable(z.number().int().positive()), building_id: nullable(z.number().int().positive()) })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const assetId = paramId(req, 'assetId');
  await tx(async (conn) => {
    const e = await equipmentOf(conn, t, assetId);
    if (e.building_id !== id) throw notFound('Equipment in this building');
    const to = await buildingOf(conn, t, req.body.building_id || id);
    const room = await roomOf(conn, t, to, req.body.room_id);
    await conn.query('UPDATE ops_assets SET location_id = ? WHERE tenant_id = ? AND id = ?', [room ? room.id : to.location_id, t, assetId]);
    await audit(conn, req, 'move', 'ops_assets', assetId, { building_id: to.id, room_id: room ? room.id : null });
  });
  await B.syncPlans(pool, t);
  res.json({ ok: true });
});

/** A building's year at a glance: each library check down the side, the twelve months across. */
router.get('/:id/year', async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const today = await todayOf(t);
  const year = Number(first(req.query.year)) || Number(today.slice(0, 4));
  if (year < 2000 || year > 2100) throw bad('Pick a year from 2000 to 2100');
  await buildingOf(pool, t, id);
  const plans = await B.plansOf(pool, t, today, { buildingId: id });
  const logs = plans.length ? await rows(pool, 'SELECT pm_task_id, done_on FROM pm_log WHERE tenant_id = ? AND pm_task_id IN (?) AND done_on >= ? ORDER BY done_on', [t, plans.map((p) => p.plan_id), `${year - 3}-01-01`]) : [];
  const byPlan = new Map();
  for (const l of logs) { if (!byPlan.has(l.pm_task_id)) byPlan.set(l.pm_task_id, []); byPlan.get(l.pm_task_id).push(A.ymd(l.done_on)); }
  const planRows = plans.map((p) => ({ plan_id: p.plan_id, task_id: p.task_id, asset_id: p.asset_id, asset: p.asset, tag: p.asset_tag, room: p.room, state: p.state, cells: B.yearCells(byPlan.get(p.plan_id) || [], p.interval_days, year, today) }));
  const tasks = [];
  for (const p of plans) if (!tasks.some((x) => x.task_id === p.task_id)) tasks.push({ task_id: p.task_id, task: p.task, who: p.who, standard: p.standard, every: p.every });
  const RANK = B.RANK;
  for (const tk of tasks) {
    const mine = planRows.filter((r) => r.task_id === tk.task_id);
    tk.plans = mine.length;
    tk.never = mine.filter((r) => r.state === 'never').length;
    tk.cells = Array.from({ length: 12 }, (_, m) => {
      const states = mine.map((r) => r.cells[m]);
      const worst = states.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'none');
      return { state: worst, done: states.filter((s) => s === 'done' || s === 'late').length, late: states.filter((s) => s === 'late').length, missed: states.filter((s) => s === 'missed' || s === 'overdue').length };
    });
  }
  res.json({ year, today, tasks, plans: planRows });
});

/**
 * Starts a staff round in a building: a route through its items (by room, then name). Without task_ids it holds every
 * staff check that is overdue, due in the next 7 days or has no record yet; with them, every item of those checks. An
 * open round in the building is picked up again rather than a second one started.
 */
router.post('/:id/rounds', crew, validate(z.object({ task_ids: z.array(z.number().int().positive()).max(50).optional() })), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const out = await tx(async (conn) => {
    const b = await buildingOf(conn, t, id, { lock: true });
    const open = await one(conn, "SELECT id FROM building_rounds WHERE tenant_id = ? AND building_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [t, b.id]);
    if (open) return { id: open.id, resumed: true };
    const today = todayIn(await tzOf(conn, t));
    let plans = await B.plansOf(conn, t, today, { buildingId: b.id, who: 'staff' });
    if (req.body.task_ids && req.body.task_ids.length) plans = plans.filter((p) => req.body.task_ids.includes(p.task_id));
    else plans = plans.filter((p) => ['overdue', 'never', 'week'].includes(p.state));
    if (!plans.length) throw bad(req.body.task_ids && req.body.task_ids.length ? 'This building has nothing for those checks' : 'Nothing in this building is due for a staff check this week. Pick the checks to do instead.');
    plans.sort((x, y) => String(x.room || '').localeCompare(String(y.room || '')) || x.asset.localeCompare(y.asset, undefined, { numeric: true }) || x.task.localeCompare(y.task));
    const [r] = await conn.query('INSERT INTO building_rounds (tenant_id, building_id, started_by, started_at) VALUES (?, ?, ?, ?)', [t, b.id, req.auth.userId, nowIn(await tzOf(conn, t))]);
    let sort = 0;
    for (const p of plans) await conn.query('INSERT INTO building_round_stops (tenant_id, round_id, pm_task_id, task_id, asset_id, sort) VALUES (?, ?, ?, ?, ?, ?)', [t, r.insertId, p.plan_id, p.task_id, p.asset_id, sort += 1]);
    await audit(conn, req, 'create', 'building_rounds', r.insertId, { building_id: b.id, stops: plans.length });
    return { id: r.insertId, stops: plans.length, resumed: false };
  });
  res.status(out.resumed ? 200 : 201).json(out);
});

/** Files a document under the building (a floor plan, an evacuation map, an inspection report from elsewhere). */
router.put('/:id/documents', crew, raw(10 * 1024 * 1024), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req);
  const file = checkFile(req);
  const title = req.get('x-title') ? decodeURIComponent(String(req.get('x-title'))).trim().slice(0, 150) : null;
  const out = await tx(async (conn) => {
    const b = await buildingOf(conn, t, id);
    return fileDocument(conn, req, { title: title || `${b.name}: ${file.name}`, file, buildingIds: [b.id] });
  });
  await scanLater(t, out.id);
  res.status(201).json({ document_id: out.id, version: out.version });
});

module.exports = router;
