'use strict';

// Resident requests with a repair record (muni release 1, app "requests"). lib/requests.js says why the record matters.
//
// Signed in (/api/v1/requests, the Resident requests app; Crew, Front desk and managers):
//   GET    /meta                     categories, streets, statuses, crew to assign
//   GET    /today                    the Today cards: new to look at, open past target, fixed today
//   GET    /                         the list (?view=new|open|done|all, category_id, street_id, q)
//   GET    /map                      open requests with a position, and the asset map's base layers
//   GET    /ledger, /ledger.csv      the repair record by street, dates or category (contacts=1: managers only, audited)
//   POST   /                         a request taken by phone, at the counter, by email or text, or noticed by the crew
//   GET    /:id                      one request: its record, photos, timeline and messages to the resident
//   PATCH  /:id                      what, where, priority, the note for the resident
//   POST   /:id/reported-at          a manager corrects when the municipality was told (phone and walk-in reports; audited)
//   POST   /:id/work-order           Front desk or a manager turns it into a work order for the crew
//   POST   /:id/refer | /duplicate | /close   passed to another agency, already reported, or closed with no action
//   POST   /:id/made-safe            coned, barricaded or signed: the time (and a photo, added next)
//   POST   /:id/fixed                fixed (completes its work order too)
//   POST   /:id/reopen               a manager reopens a closed request
//   POST   /:id/notes                an internal note
//   POST   /:id/photos               a photo kept as taken, with its fingerprint (?stage=before|made_safe|after)
//   GET    /:id/photos/:pid[/verify] the original with its fingerprint; recompute the fingerprint
//   GET/PUT /settings, POST/PATCH /categories, PUT /standards, PUT /street-classes   managers set the app up
// Streets (/requests/streets) are the foundation's (routes/streets.js); this router passes them on.
//
// Public (/api/v1/public/<slug>/..., no sign-in, the words 'report' and 'open-requests'):
//   GET  /:slug/report                          what the report page needs: categories, streets, the after-hours number
//   POST /:slug/report                          a resident's report; answers with the reference and the status link's token
//   GET  /:slug/report/:token                   the status page: the status and public note, never staff names or contacts
//   POST /:slug/report/:token/photos            up to 3 photos with the report
//   GET  /:slug/report/:token/photos/:pid       a photo with where it was taken removed
//   POST /:slug/report/:token/stop              stop updates by text and email
//   GET  /:slug/open-requests                   the public map, when the municipality turned it on: no personal details
const express = require('express');
const crypto = require('crypto');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, nowIn, todayIn, dateStr, dateTimeStr, normDateTime, addDays } = require('../lib/util');
const { notFound, bad, conflict, forbidden, AppError } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { counter } = require('../middleware/rateLimit');
const { photoFacts, sniff, stripGps } = require('../lib/exif');
const { card, todayRoute } = require('../lib/today');
const { toCsv } = require('../lib/csv');
const { baseUrl } = require('../lib/baseurl');
const config = require('../config');
const Q = require('../lib/requests');
const RES = require('../lib/residents');

const router = express.Router();
const publicRouter = express.Router();
const anyone = requireRole('staff', 'counter', 'manager');
const desk = requireRole('counter', 'manager');
const crewOrManager = requireRole('staff', 'manager');
const manager = requireRole('manager');
const seesContact = (req) => ['owner', 'manager', 'counter'].includes(req.auth.role);
const MAX_PHOTO = 12 * 1024 * 1024;
const RESIDENT_PHOTOS = 3;
const raw = (limit) => express.raw({ type: () => true, limit });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nullable = (s) => s.nullable().optional();
const first = (v) => String(Array.isArray(v) ? v[0] : v ?? '');
const idOrNull = (v) => { const n = Number(first(v)); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const phoneText = z.string().trim().max(30).regex(/^[0-9+()\-. ]{7,30}$/, 'Type the phone number with digits');
const tz = (tenantId) => Q.tzOf(pool, tenantId);
const msLocal = (s) => Date.parse(`${String(s).replace(' ', 'T').slice(0, 19)}Z`);

// The foundation's street list lives at /requests/streets in its own router: pass it on.
router.use((req, _res, next) => (String(req.path).split('/')[1] === 'streets' ? next('router') : next()));
router.use(anyone);

async function streetOf(conn, tenantId, id, { activeOnly = false } = {}) {
  if (!id) return null;
  const s = await one(conn, `SELECT id, name, street_class FROM streets WHERE tenant_id = ? AND id = ?${activeOnly ? ' AND active = 1' : ''}`, [tenantId, id]);
  if (!s) throw notFound('Street');
  return s;
}
async function categoryOf(conn, tenantId, id, { activeOnly = true } = {}) {
  await Q.ensureSetup(conn, tenantId);
  const c = await one(conn, `SELECT id, name, needs_contact, after_hours FROM request_categories WHERE tenant_id = ? AND id = ?${activeOnly ? ' AND active = 1' : ''}`, [tenantId, id]);
  if (!c) throw notFound('Category');
  return c;
}
async function mustRequest(conn, req, { lock = false } = {}) {
  const r = await Q.requestOf(conn, req.auth.tenantId, paramId(req), { lock });
  if (!r) throw notFound('Request');
  return r;
}
const isOpen = (r) => Q.OPEN.includes(r.status);
const mustBeOpen = (r) => { if (!isOpen(r)) throw conflict(`This request is ${Q.STATUS_WORDS[r.status].toLowerCase()}. A manager can reopen it.`); };

/** The list and map row: what and where, never the resident. */
function rowOf(r, std, now, zone) {
  const t = Q.timing(r, std, now, zone);
  return {
    id: Number(r.id), reference: r.reference, category_id: Number(r.category_id), category: r.category, color: r.category_color, status: r.status, status_words: Q.STATUS_WORDS[r.status],
    priority: r.priority, source: r.source, place: Q.placeWords(r), street_id: r.street_id ? Number(r.street_id) : null, street: r.street_name || null,
    reported_at: r.reported_at, made_safe_at: r.made_safe_at, fixed_at: r.fixed_at, closed_at: r.closed_at, work_order_id: r.work_order_id ? Number(r.work_order_id) : null,
    lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng), make_safe: t.make_safe, fix: t.fix,
    late: Boolean((t.make_safe.met === false) || (t.fix.met === false)),
  };
}

// ---------------------------------------------------------------- meta and Today
router.get('/meta', async (req, res) => {
  const t = req.auth.tenantId;
  const [categories, streets, staff, settings] = await Promise.all([
    Q.categoriesOf(pool, t, { all: true }),
    rows(pool, 'SELECT id, name, street_class, active FROM streets WHERE tenant_id = ? ORDER BY name', [t]),
    seesContact(req) ? rows(pool, "SELECT s.id, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE s.tenant_id = ? AND s.status = 'active' ORDER BY name", [t]) : [],
    Q.settingsOf(pool, t),
  ]);
  const modules = await require('../lib/modules').enabledKeys(t);
  res.json({
    categories, streets: streets.map((s) => ({ id: Number(s.id), name: s.name, street_class: s.street_class || 'local', active: Boolean(s.active) })), staff,
    statuses: Q.STATUSES.map((k) => ({ key: k, label: Q.STATUS_WORDS[k] })), sources: Q.SOURCES.map((k) => ({ key: k, label: Q.SOURCE_WORDS[k] })),
    classes: Q.CLASSES.map((k) => ({ key: k, label: Q.CLASS_WORDS[k] })), after_hours_phone: settings.after_hours_phone, public_map: settings.public_map,
    work_orders: modules.includes('assets'), sees_contact: seesContact(req),
  });
});

router.get('/today', todayRoute(async (req) => {
  const t = req.auth.tenantId; const zone = await tz(t);
  const now = nowIn(zone); const today = todayIn(zone);
  const open = await rows(pool, `${Q.REQ_SQL} WHERE r.tenant_id = ? AND r.status IN ('new','assigned','made_safe') LIMIT 2000`, [t]);
  const standards = await Q.standardsOf(pool, t);
  const late = open.filter((r) => { const x = Q.timing(r, Q.standardFor(standards, r.category_id, r.street_class), now, zone); return x.make_safe.met === false || x.fix.met === false; }).length;
  const fresh = open.filter((r) => r.status === 'new').length;
  const fixed = await one(pool, "SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND status = 'fixed' AND fixed_at >= ? AND fixed_at < ?", [t, `${today} 00:00:00`, `${addDays(today, 1)} 00:00:00`]);
  const n = Number(fixed.n);
  return [
    card({ title: 'New requests', count: fresh, text: fresh ? 'Waiting for someone to decide what to do' : 'Nothing waiting', href: '#/requests?tab=new' }),
    card({ title: 'Open past target', count: late, text: late ? 'Open longer than the response standard' : 'Every open request is within its standard', href: '#/requests?tab=open&late=1' }),
    card({ title: 'Fixed today', count: n, text: n === 1 ? 'Request fixed today' : 'Requests fixed today', href: '#/requests?tab=done' }),
  ];
}));

// ---------------------------------------------------------------- the list and the map
router.get('/', async (req, res) => {
  const t = req.auth.tenantId; const zone = await tz(t);
  const view = ['new', 'open', 'done', 'all'].includes(first(req.query.view)) ? first(req.query.view) : 'open';
  const where = ['r.tenant_id = ?']; const params = [t];
  if (view === 'new') where.push("r.status = 'new'");
  else if (view === 'open') where.push("r.status IN ('new','assigned','made_safe')");
  else if (view === 'done') where.push("r.status IN ('fixed','closed_no_action','duplicate','referred')");
  const cat = idOrNull(req.query.category_id); if (cat) { where.push('r.category_id = ?'); params.push(cat); }
  const st = idOrNull(req.query.street_id); if (st) { where.push('r.street_id = ?'); params.push(st); }
  const q = first(req.query.q).trim().slice(0, 60);
  if (q) {
    const ref = Q.normalRef(q);
    where.push('(r.reference = ? OR r.description LIKE ? OR s.name LIKE ? OR r.cross_street LIKE ?)');
    params.push(ref || '-', `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const list = await rows(pool, `${Q.REQ_SQL} WHERE ${where.join(' AND ')} ORDER BY ${view === 'done' ? 'COALESCE(r.closed_at, r.reported_at) DESC' : "FIELD(r.priority, 'urgent', 'high', 'normal', 'low'), r.reported_at"} LIMIT ?`, [...params, limit]);
  const standards = await Q.standardsOf(pool, t); const now = nowIn(zone);
  let data = list.map((r) => rowOf(r, Q.standardFor(standards, r.category_id, r.street_class), now, zone));
  if (first(req.query.late) === '1') data = data.filter((r) => r.late);
  res.json({ data });
});

router.get('/map', async (req, res) => {
  const t = req.auth.tenantId; const zone = await tz(t);
  const list = await rows(pool, `${Q.REQ_SQL} WHERE r.tenant_id = ? AND r.status IN ('new','assigned','made_safe') AND r.lat IS NOT NULL ORDER BY r.reported_at LIMIT 2000`, [t]);
  const standards = await Q.standardsOf(pool, t); const now = nowIn(zone);
  const center = await one(pool, 'SELECT map_lat, map_lng, map_zoom FROM tenants WHERE id = ?', [t]);
  res.json({
    layers: config.map.layers, max_zoom: config.map.maxZoom, categories: await Q.categoriesOf(pool, t, { all: true }),
    center: center && center.map_lat !== null ? { lat: Number(center.map_lat), lng: Number(center.map_lng), zoom: center.map_zoom || 15 } : null,
    data: list.map((r) => rowOf(r, Q.standardFor(standards, r.category_id, r.street_class), now, zone)),
  });
});

// ---------------------------------------------------------------- the ledger (the repair record)
const ledgerQuery = z.object({
  street_id: z.coerce.number().int().positive().optional(), category_id: z.coerce.number().int().positive().optional(),
  from: dateStr.optional(), to: dateStr.optional(), contacts: z.enum(['0', '1']).optional(),
});
function ledgerFilters(req) {
  const p = ledgerQuery.safeParse(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, first(v)]).filter(([, v]) => v !== '')));
  if (!p.success) throw bad('Check the street, category and dates');
  const f = p.data;
  if (f.from && f.to && f.from > f.to) throw bad('The first date is after the last one');
  const contacts = f.contacts === '1';
  if (contacts && !['owner', 'manager'].includes(req.auth.role)) throw forbidden('Only a manager can include contact details');
  return { filters: { street_id: f.street_id, category_id: f.category_id, from: f.from, to: f.to }, contacts };
}

router.get('/ledger', async (req, res) => {
  const { filters, contacts } = ledgerFilters(req);
  const out = await Q.ledger(pool, req.auth.tenantId, filters, { contacts });
  if (contacts) await audit(pool, req, 'export_contacts', 'requests', null, { format: 'print', rows: out.data.length, filters });
  res.json(out);
});

router.get('/ledger.csv', async (req, res) => {
  const { filters, contacts } = ledgerFilters(req);
  const out = await Q.ledger(pool, req.auth.tenantId, filters, { contacts });
  await audit(pool, req, contacts ? 'export_contacts' : 'export', 'requests', null, { format: 'csv', rows: out.data.length, filters });
  const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
  const data = out.data.map((d) => ({
    reference: d.reference, category: d.category, status: d.status_words, street: d.street || '', street_class: d.street_class || '', cross_street: d.cross_street || '',
    ...(contacts ? { house_number: d.house_number || '', name: d.contact ? d.contact.name || '' : '', phone: d.contact ? d.contact.phone || '' : '', email: d.contact ? d.contact.email || '' : '' } : {}),
    reported_at: d.reported_at, made_safe_at: d.made_safe_at || '', fixed_at: d.fixed_at || '', closed_at: d.closed_at || '', referred_to: d.referred_to || '',
    make_safe_target_hours: d.make_safe.target_hours ?? '', make_safe_hours: d.make_safe.done ? d.make_safe.hours : '', make_safe_met: d.make_safe.done ? yn(d.make_safe.met) : '',
    fix_target_hours: d.fix.target_hours ?? '', fix_hours: d.fix.done ? d.fix.hours : '', fix_met: d.fix.done ? yn(d.fix.met) : '',
    work_order: d.work_order_id || '', photos: d.photos.map((p) => `${p.stage} ${p.sha256}`).join('; '),
  }));
  const cols = ['reference', 'category', 'status', 'street', 'street_class', 'cross_street', ...(contacts ? ['house_number', 'name', 'phone', 'email'] : []), 'reported_at', 'made_safe_at', 'fixed_at', 'closed_at', 'referred_to',
    'make_safe_target_hours', 'make_safe_hours', 'make_safe_met', 'fix_target_hours', 'fix_hours', 'fix_met', 'work_order', 'photos'];
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="repair-record${contacts ? '-with-contacts' : ''}.csv"`, 'Cache-Control': 'private, no-store' }).send(toCsv(cols, data));
});

// ---------------------------------------------------------------- settings (managers)
router.get('/settings', async (req, res) => {
  const t = req.auth.tenantId;
  const [settings, categories, standards, streets, users] = await Promise.all([
    Q.settingsOf(pool, t), Q.categoriesOf(pool, t, { all: true }), Q.standardsOf(pool, t),
    rows(pool, 'SELECT id, name, street_class FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t]),
    rows(pool, "SELECT u.id, COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.email, u.username) AS name, u.role FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.active = 1 AND u.role IN ('owner','manager','staff','counter') ORDER BY name", [t]),
  ]);
  const { alert_thread_id: _thread, ...shown } = settings;
  res.json({ ...shown, categories, standards, streets: streets.map((s) => ({ id: Number(s.id), name: s.name, street_class: s.street_class || 'local' })), users: users.map((u) => ({ id: Number(u.id), name: u.name, role: u.role })), classes: Q.CLASSES });
});

router.put('/settings', manager, validate(z.object({
  after_hours_phone: nullable(z.union([phoneText, z.literal('')])), office_phone: nullable(z.union([phoneText, z.literal('')])),
  intro: nullable(z.string().trim().max(500)), public_map: z.boolean().optional(), alert_user_ids: z.array(z.number().int().positive()).max(30).optional(),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await tx(async (conn) => {
    await Q.ensureSetup(conn, t);
    if (b.alert_user_ids && b.alert_user_ids.length) {
      const ok = await rows(conn, 'SELECT id FROM users WHERE tenant_id = ? AND active = 1 AND id IN (?)', [t, b.alert_user_ids]);
      if (ok.length !== new Set(b.alert_user_ids).size) throw notFound('Login');
    }
    const sets = {}; const blank = (v) => (v === '' ? null : v);
    if (b.after_hours_phone !== undefined) sets.after_hours_phone = blank(b.after_hours_phone);
    if (b.office_phone !== undefined) sets.office_phone = blank(b.office_phone);
    if (b.intro !== undefined) sets.intro = blank(b.intro);
    if (b.public_map !== undefined) sets.public_map = b.public_map ? 1 : 0;
    if (b.alert_user_ids !== undefined) sets.alert_user_ids = JSON.stringify([...new Set(b.alert_user_ids)]);
    const keys = Object.keys(sets);
    if (keys.length) await conn.query(`UPDATE request_settings SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ?`, [...keys.map((k) => sets[k]), t]);
    if (b.alert_user_ids !== undefined) await Q.syncAlertThread(conn, t, req.auth.userId);
    await audit(conn, req, 'settings', 'request_settings', null, keys);
  });
  res.json({ ok: true });
});

const categoryFields = { name: z.string().trim().min(1).max(60), needs_contact: z.boolean().optional(), after_hours: z.boolean().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Pick a color').optional(), active: z.boolean().optional(), sort: z.number().int().min(0).max(9999).optional() };
router.post('/categories', manager, validate(z.object(categoryFields)), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  await Q.ensureSetup(pool, t);
  try {
    const [r] = await pool.query('INSERT INTO request_categories (tenant_id, name, needs_contact, after_hours, color, sort) VALUES (?, ?, ?, ?, ?, ?)', [t, b.name, b.needs_contact ? 1 : 0, b.after_hours ? 1 : 0, b.color || '#5b6770', b.sort ?? 500]);
    await audit(pool, req, 'create', 'request_categories', r.insertId, { name: b.name });
    res.status(201).json({ id: r.insertId });
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a category with that name'); throw err; }
});
router.patch('/categories/:id', manager, validate(z.object(categoryFields).partial()), async (req, res) => {
  const t = req.auth.tenantId; const id = paramId(req); const b = req.body;
  const sets = {};
  for (const k of ['name', 'color', 'sort']) if (b[k] !== undefined) sets[k] = b[k];
  for (const k of ['needs_contact', 'after_hours', 'active']) if (b[k] !== undefined) sets[k] = b[k] ? 1 : 0;
  const keys = Object.keys(sets);
  if (!keys.length) throw bad('Nothing to change');
  try {
    const [r] = await pool.query(`UPDATE request_categories SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => sets[k]), t, id]);
    if (!r.affectedRows) throw notFound('Category');
  } catch (err) { if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a category with that name'); throw err; }
  await audit(pool, req, 'update', 'request_categories', id, b);
  res.json({ ok: true });
});

const hours = z.number().int().min(1).max(24 * 365).nullable();
router.put('/standards', manager, validate(z.object({ standards: z.array(z.object({ category_id: z.number().int().positive(), street_class: z.enum(['any', ...Q.CLASSES]).default('any'), make_safe_hours: hours, fix_hours: hours })).max(400) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const cats = new Set((await Q.categoriesOf(conn, t, { all: true })).map((c) => c.id));
    for (const s of req.body.standards) if (!cats.has(s.category_id)) throw notFound('Category');
    const before = await Q.standardsOf(conn, t);
    await conn.query('DELETE FROM request_standards WHERE tenant_id = ?', [t]);
    for (const s of req.body.standards) {
      if (s.make_safe_hours === null && s.fix_hours === null) continue;
      if (s.make_safe_hours && s.fix_hours && s.make_safe_hours > s.fix_hours) throw bad('The time to make safe cannot be longer than the time to fix');
      await conn.query('INSERT INTO request_standards (tenant_id, category_id, street_class, make_safe_hours, fix_hours, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE make_safe_hours = VALUES(make_safe_hours), fix_hours = VALUES(fix_hours), updated_by = VALUES(updated_by)',
        [t, s.category_id, s.street_class, s.make_safe_hours, s.fix_hours, req.auth.userId]);
    }
    // The standard is part of the record: what it was and what it became.
    await audit(conn, req, 'standards', 'request_standards', null, { before, after: req.body.standards });
  });
  res.json({ ok: true });
});

router.put('/street-classes', manager, validate(z.object({ streets: z.array(z.object({ id: z.number().int().positive(), street_class: z.enum(Q.CLASSES) })).min(1).max(2000) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    for (const s of req.body.streets) {
      const [r] = await conn.query('UPDATE streets SET street_class = ? WHERE tenant_id = ? AND id = ?', [s.street_class, t, s.id]);
      if (!r.affectedRows) throw notFound('Street');
    }
    await audit(conn, req, 'street_classes', 'streets', null, { streets: req.body.streets.length });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- staff create
const contactFields = z.object({
  name: nullable(z.string().trim().max(120)), phone: nullable(z.union([phoneText, z.literal('')])), email: nullable(z.union([z.string().trim().email('Type a full email address').max(190), z.literal('')])),
  texts_ok: z.boolean().optional(), emails_ok: z.boolean().optional(),
}).optional();
const whereFields = {
  street_id: nullable(z.number().int().positive()), house_number: nullable(z.string().trim().max(20)), cross_street: nullable(z.string().trim().max(120)),
  lat: nullable(z.number().min(-90).max(90)), lng: nullable(z.number().min(-180).max(180)), accuracy: nullable(z.number().min(0).max(100000)),
};
const createFields = z.object({
  category_id: z.number().int().positive(), ...whereFields, description: nullable(z.string().trim().max(1000)),
  source: z.enum(['phone', 'walk_in', 'crew', 'email', 'text']).default('phone'), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  reported_at: nullable(dateTimeStr), reported_reason: nullable(z.string().trim().max(255)), contact: contactFields, client_ref: nullable(z.string().regex(/^[A-Za-z0-9_-]{6,32}$/)),
});
const hasPlace = (b) => Boolean(b.street_id || (b.lat !== null && b.lat !== undefined && b.lng !== null && b.lng !== undefined) || (b.cross_street && b.cross_street.trim()));

/** A manager's earlier "when we were told", checked: not in the future, not before the last 90 days, with a reason. */
function checkReportedAt(req, r, given, reason, now) {
  if (!['owner', 'manager'].includes(req.auth.role)) throw forbidden('Only a manager can change when the municipality was told');
  if (!['phone', 'walk_in'].includes(r.source)) throw bad('Only a phone or walk-in report\'s time can be changed. A report from the page, the crew, an email or a text keeps the time it arrived.');
  if (!reason || reason.trim().length < 3) throw bad('Say why the time is different, in a few words');
  const at = normDateTime(given);
  if (msLocal(at) > msLocal(now) + 5 * 60000) throw bad('That time is in the future');
  if (msLocal(at) < msLocal(now) - 90 * 86400000) throw bad('That is more than 90 days ago. Check the date.');
  return at;
}

router.post('/', validate(createFields), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (!hasPlace(b)) throw bad('Say where: pick the street, type the nearest cross street, or use the phone\'s location');
  const zone = await tz(t); const now = nowIn(zone);
  const out = await tx(async (conn) => {
    if (b.client_ref) {
      const seen = await one(conn, 'SELECT id, reference FROM requests WHERE tenant_id = ? AND request_key = ?', [t, crypto.createHash('md5').update(`staff:${b.client_ref}`).digest('hex')]);
      if (seen) return { id: Number(seen.id), reference: seen.reference, repeat: true };
    }
    const cat = await categoryOf(conn, t, b.category_id);
    const street = await streetOf(conn, t, b.street_id);
    const c = b.contact || {};
    const reportedAt = b.reported_at ? checkReportedAt(req, { source: b.source }, b.reported_at, b.reported_reason, now) : now;
    const residentId = (c.name || c.phone || c.email) ? await RES.upsertResident(conn, t, { name: c.name, phone: c.phone || null, email: c.email || null, streetId: street ? street.id : null, houseNumber: b.house_number, textsOk: c.texts_ok ? true : undefined, emailsOk: c.emails_ok ? true : undefined }, { source: 'staff', userId: req.auth.userId }) : null;
    if (cat.needs_contact && !residentId) throw bad(`${cat.name} needs the resident's phone or email, so the crew can reach them`);
    const ref = await Q.newReference(conn, t);
    const [r] = await conn.query(`INSERT INTO requests (tenant_id, reference, status_token, category_id, street_id, house_number, cross_street, lat, lng, accuracy_m, description, source, resident_id,
        updates_by_text, updates_by_email, reported_at, priority, request_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t, ref, Q.newToken(), cat.id, street ? street.id : null, b.house_number || null, b.cross_street || null, b.lat ?? null, b.lng ?? null, b.accuracy == null ? null : Math.round(b.accuracy),
      b.description || null, b.source, residentId, c.texts_ok && c.phone ? 1 : 0, c.emails_ok && c.email ? 1 : 0, reportedAt, b.priority,
      b.client_ref ? crypto.createHash('md5').update(`staff:${b.client_ref}`).digest('hex') : null, req.auth.userId]);
    await Q.event(conn, t, r.insertId, now, `Taken by staff (${Q.SOURCE_WORDS[b.source].toLowerCase()}).${b.reported_at ? ` Told at ${reportedAt}: ${b.reported_reason}.` : ''}`, req.auth.userId);
    await audit(conn, req, 'create', 'requests', r.insertId, { source: b.source, reference: ref, ...(b.reported_at ? { reported_at: reportedAt, reason: b.reported_reason } : {}) });
    return { id: r.insertId, reference: ref };
  });
  if (!out.repeat) {
    Q.alertNew(t, out.id, { exceptUserId: req.auth.userId }).catch(() => {});
    Q.tellResident(t, out.id, 'received', { base: baseUrl(req) }).catch(() => {});
  }
  res.status(out.repeat ? 200 : 201).json(out);
});

// ---------------------------------------------------------------- one request
router.get('/:id', async (req, res) => {
  const t = req.auth.tenantId; const zone = await tz(t);
  const r = await mustRequest(pool, req);
  const std = Q.standardFor(await Q.standardsOf(pool, t), r.category_id, r.street_class);
  const name = "COALESCE(NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), u.email, u.username)";
  const [photos, events, messages, dups, wo, original, resident] = await Promise.all([
    rows(pool, `SELECT ph.id, ph.stage, ph.mime, ph.bytes, ph.sha256, ph.taken_at, ph.taken_from, ph.by_resident, ph.uploaded_at, ${name} AS uploaded_by FROM request_photos ph
      LEFT JOIN users u ON u.tenant_id = ph.tenant_id AND u.id = ph.uploaded_by LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE ph.tenant_id = ? AND ph.request_id = ? ORDER BY ph.id`, [t, r.id]),
    rows(pool, `SELECT e.id, e.at, e.kind, e.body, ${name} AS author FROM request_events e LEFT JOIN users u ON u.tenant_id = e.tenant_id AND u.id = e.user_id LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE e.tenant_id = ? AND e.request_id = ? ORDER BY e.id`, [t, r.id]),
    rows(pool, 'SELECT kind, channel, ok, error, at FROM request_messages WHERE tenant_id = ? AND request_id = ? ORDER BY id', [t, r.id]),
    rows(pool, 'SELECT id, reference, status FROM requests WHERE tenant_id = ? AND duplicate_of = ? ORDER BY id', [t, r.id]),
    r.work_order_id ? one(pool, "SELECT w.id, w.title, w.status, w.completed_at, w.resolution, TRIM(CONCAT(p.first_name, ' ', p.last_name)) AS assignee FROM work_orders w LEFT JOIN staff s ON s.tenant_id = w.tenant_id AND s.id = w.assigned_staff_id LEFT JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id WHERE w.tenant_id = ? AND w.id = ?", [t, r.work_order_id]) : null,
    r.duplicate_of ? one(pool, 'SELECT id, reference, status FROM requests WHERE tenant_id = ? AND id = ?', [t, r.duplicate_of]) : null,
    r.resident_id && seesContact(req) ? one(pool, 'SELECT name, phone, email, texts_ok, emails_ok FROM residents WHERE tenant_id = ? AND id = ?', [t, r.resident_id]) : null,
  ]);
  const view = rowOf(r, std, nowIn(zone), zone);
  res.json({
    ...view, house_number: r.house_number, cross_street: r.cross_street, accuracy_m: r.accuracy_m, description: r.description, public_note: r.public_note,
    source_words: Q.SOURCE_WORDS[r.source], referred_to: r.referred_to, referred_at: r.referred_at, closed_reason: r.closed_reason, made_safe_note: r.made_safe_note, assigned_at: r.assigned_at,
    street_class: r.street_class || null, standard: std,
    has_resident: Boolean(r.resident_id), updates_by_text: Boolean(r.updates_by_text), updates_by_email: Boolean(r.updates_by_email),
    contact: resident ? { name: resident.name, phone: resident.phone, email: resident.email, texts_ok: Boolean(resident.texts_ok), emails_ok: Boolean(resident.emails_ok) } : null,
    photos: photos.map((p) => ({ ...p, id: Number(p.id), by_resident: Boolean(p.by_resident), uploaded_by: p.by_resident ? 'Resident' : p.uploaded_by })),
    events, messages: messages.map((m) => ({ ...m, ok: Boolean(m.ok) })), duplicates: dups, duplicate_of: original, work_order: wo,
    status_link: Q.statusLink(baseUrl(req), (await one(pool, 'SELECT slug FROM tenants WHERE id = ?', [t])).slug, r.status_token),
  });
});

router.patch('/:id', validate(z.object({
  category_id: z.number().int().positive().optional(), ...whereFields, description: nullable(z.string().trim().max(1000)),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), public_note: nullable(z.string().trim().max(500)),
})), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  if (!Object.keys(b).length) throw bad('Nothing to change');
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true });
    if (b.category_id) await categoryOf(conn, t, b.category_id, { activeOnly: false });
    if (b.street_id) await streetOf(conn, t, b.street_id);
    const cols = { category_id: 'category_id', street_id: 'street_id', house_number: 'house_number', cross_street: 'cross_street', lat: 'lat', lng: 'lng', accuracy: 'accuracy_m', description: 'description', priority: 'priority', public_note: 'public_note' };
    const keys = Object.keys(b).filter((k) => cols[k]);
    const merged = { street_id: r.street_id, lat: r.lat, lng: r.lng, cross_street: r.cross_street, ...b };
    if (!hasPlace(merged)) throw bad('Keep a street, a cross street or a position');
    await conn.query(`UPDATE requests SET ${keys.map((k) => `\`${cols[k]}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => (k === 'accuracy' && b[k] != null ? Math.round(b[k]) : b[k] === '' ? null : b[k])), t, r.id]);
    await Q.event(conn, t, r.id, nowIn(await tz(t)), `Changed: ${keys.map((k) => k.replace(/_id$/, '').replace(/_/g, ' ')).join(', ')}.`, req.auth.userId);
    await audit(conn, req, 'update', 'requests', r.id, keys);
  });
  res.json({ ok: true });
});

router.post('/:id/reported-at', manager, validate(z.object({ reported_at: dateTimeStr, reason: z.string().trim().min(3, 'Say why, in a few words').max(255) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true });
    const now = nowIn(await tz(t));
    const at = checkReportedAt(req, r, req.body.reported_at, req.body.reason, now);
    for (const [k, v] of [['made safe', r.made_safe_at], ['fixed', r.fixed_at]]) if (v && msLocal(at) > msLocal(v)) throw bad(`That is after it was ${k}. Check the time.`);
    await conn.query('UPDATE requests SET reported_at = ? WHERE tenant_id = ? AND id = ?', [at, t, r.id]);
    await Q.event(conn, t, r.id, now, `When the municipality was told changed from ${String(r.reported_at).slice(0, 16)} to ${at.slice(0, 16)}: ${req.body.reason}`, req.auth.userId);
    await audit(conn, req, 'reported_at', 'requests', r.id, { from: r.reported_at, to: at, reason: req.body.reason });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- triage
router.post('/:id/work-order', desk, validate(z.object({
  title: nullable(z.string().trim().max(150)), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), assigned_staff_id: nullable(z.number().int().positive()),
  due_date: nullable(dateStr), description: nullable(z.string().trim().max(5000)), tell_resident: z.boolean().optional(),
})), async (req, res) => {
  const t = req.auth.tenantId;
  if (!(await require('../lib/modules').enabledKeys(t)).includes('assets')) throw conflict('Work orders need Assets and fleet turned on. Ask your Verdynt/OS contact.');
  const out = await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true });
    mustBeOpen(r);
    if (r.work_order_id && await one(conn, "SELECT id FROM work_orders WHERE tenant_id = ? AND id = ? AND status NOT IN ('done','cancelled')", [t, r.work_order_id])) throw conflict('This request already has an open work order');
    const now = nowIn(await tz(t));
    const woId = await Q.makeWorkOrder(conn, req, r, req.body);
    await conn.query(`UPDATE requests SET work_order_id = ?, assigned_at = COALESCE(assigned_at, ?), status = IF(status = 'new', 'assigned', status), priority = COALESCE(?, priority) WHERE tenant_id = ? AND id = ?`, [woId, now, req.body.priority || null, t, r.id]);
    await Q.event(conn, t, r.id, now, `Work order ${woId} made for the crew.`, req.auth.userId);
    await audit(conn, req, 'work_order', 'requests', r.id, { work_order_id: woId });
    await audit(conn, req, 'create', 'work_orders', woId, { source: 'request', request_id: Number(r.id) });
    return { work_order_id: woId };
  });
  if (req.body.tell_resident) out.told = await Q.tellResident(t, paramId(req), 'scheduled', { base: baseUrl(req) });
  res.status(201).json(out);
});

router.post('/:id/refer', desk, validate(z.object({ referred_to: z.string().trim().min(2, 'Say who it was passed to').max(120), note: nullable(z.string().trim().max(500)), public_note: nullable(z.string().trim().max(500)) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true }); mustBeOpen(r);
    const now = nowIn(await tz(t));
    await conn.query("UPDATE requests SET status = 'referred', referred_to = ?, referred_at = ?, closed_at = ?, public_note = COALESCE(?, public_note) WHERE tenant_id = ? AND id = ?", [req.body.referred_to, now, now, req.body.public_note || null, t, r.id]);
    await Q.event(conn, t, r.id, now, `Referred to ${req.body.referred_to}.${req.body.note ? ` ${req.body.note}` : ''}`, req.auth.userId);
    await audit(conn, req, 'refer', 'requests', r.id, { to: req.body.referred_to });
  });
  await Q.tellResident(t, paramId(req), 'closed', { base: baseUrl(req) });
  res.json({ ok: true });
});

router.post('/:id/duplicate', desk, validate(z.object({ of: z.union([z.number().int().positive(), z.string().trim().min(4).max(12)]), note: nullable(z.string().trim().max(500)) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true }); mustBeOpen(r);
    const ref = typeof req.body.of === 'string' ? Q.normalRef(req.body.of) : null;
    const orig = typeof req.body.of === 'number' ? await one(conn, 'SELECT id, reference, status, duplicate_of FROM requests WHERE tenant_id = ? AND id = ?', [t, req.body.of])
      : ref ? await one(conn, 'SELECT id, reference, status, duplicate_of FROM requests WHERE tenant_id = ? AND reference = ?', [t, ref]) : null;
    if (!orig) throw notFound('The first request');
    if (Number(orig.id) === Number(r.id)) throw bad('A request cannot be a duplicate of itself');
    if (orig.status === 'duplicate') throw bad(`${orig.reference} is itself a duplicate. Link this one to the first report.`);
    const now = nowIn(await tz(t));
    await conn.query("UPDATE requests SET status = 'duplicate', duplicate_of = ?, closed_at = ? WHERE tenant_id = ? AND id = ?", [orig.id, now, t, r.id]);
    await Q.event(conn, t, r.id, now, `Marked a duplicate of ${orig.reference}.${req.body.note ? ` ${req.body.note}` : ''}`, req.auth.userId);
    await Q.event(conn, t, orig.id, now, `${r.reference} was marked a duplicate of this request.`, req.auth.userId);
    await audit(conn, req, 'duplicate', 'requests', r.id, { of: Number(orig.id) });
  });
  await Q.tellResident(t, paramId(req), 'closed', { base: baseUrl(req) });
  res.json({ ok: true });
});

router.post('/:id/close', desk, validate(z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(500), public_note: nullable(z.string().trim().max(500)) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true }); mustBeOpen(r);
    const now = nowIn(await tz(t));
    await conn.query("UPDATE requests SET status = 'closed_no_action', closed_reason = ?, closed_at = ?, public_note = COALESCE(?, public_note) WHERE tenant_id = ? AND id = ?", [req.body.reason, now, req.body.public_note || null, t, r.id]);
    await Q.event(conn, t, r.id, now, `Closed with no action: ${req.body.reason}`, req.auth.userId);
    await audit(conn, req, 'close', 'requests', r.id, { reason: req.body.reason });
  });
  await Q.tellResident(t, paramId(req), 'closed', { base: baseUrl(req) });
  res.json({ ok: true });
});

/** A time someone gives for what they did: from when the request was reported to now (5 minutes' slack for a phone clock). */
function doneAt(given, r, now) {
  if (!given) return now;
  const at = normDateTime(given);
  if (msLocal(at) > msLocal(now) + 5 * 60000) throw bad('That time is in the future');
  if (msLocal(at) < msLocal(r.reported_at)) throw bad('That is before the request was reported');
  return at;
}

router.post('/:id/made-safe', validate(z.object({ at: nullable(dateTimeStr), note: nullable(z.string().trim().max(500)) })), async (req, res) => {
  const t = req.auth.tenantId;
  const at = await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true }); mustBeOpen(r);
    if (r.made_safe_at) throw conflict(`Already made safe at ${String(r.made_safe_at).slice(0, 16)}`);
    const now = nowIn(await tz(t));
    const when = doneAt(req.body.at, r, now);
    await conn.query("UPDATE requests SET status = 'made_safe', made_safe_at = ?, made_safe_note = ? WHERE tenant_id = ? AND id = ?", [when, req.body.note || null, t, r.id]);
    await Q.event(conn, t, r.id, now, `Made safe at ${when.slice(0, 16)}.${req.body.note ? ` ${req.body.note}` : ''}`, req.auth.userId);
    await audit(conn, req, 'made_safe', 'requests', r.id, { at: when });
    return when;
  });
  res.json({ ok: true, made_safe_at: at });
});

router.post('/:id/fixed', crewOrManager, validate(z.object({ resolution: z.string().trim().min(3, 'Say what was done').max(500), public_note: nullable(z.string().trim().max(500)), at: nullable(dateTimeStr), labor_hours: nullable(z.number().min(0).max(999)) })), async (req, res) => {
  const t = req.auth.tenantId; const b = req.body;
  const ids = await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true }); mustBeOpen(r);
    const now = nowIn(await tz(t));
    const when = doneAt(b.at, r, now);
    if (r.work_order_id) {
      const w = await one(conn, 'SELECT id, status FROM work_orders WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, r.work_order_id]);
      if (w && !['done', 'cancelled'].includes(w.status)) {
        await conn.query("UPDATE work_orders SET status = 'done', completed_at = ?, resolution = ?, labor_hours = COALESCE(?, labor_hours) WHERE tenant_id = ? AND id = ?", [when, b.resolution, b.labor_hours ?? null, t, w.id]);
        await conn.query('INSERT INTO work_order_notes (tenant_id, work_order_id, user_id, body) VALUES (?, ?, ?, ?)', [t, w.id, req.auth.userId, `Completed: ${b.resolution}`]);
        await audit(conn, req, 'status', 'work_orders', w.id, { from: w.status, to: 'done', request_id: Number(r.id) });
      }
    }
    await Q.markFixed(conn, t, r, when, { userId: req.auth.userId, note: `Fixed at ${when.slice(0, 16)}: ${b.resolution}`, publicNote: b.public_note || null });
    await audit(conn, req, 'fixed', 'requests', r.id, { at: when, from: r.status });
    return [Number(r.id), ...(await Q.duplicatesOf(conn, t, r.id))];
  });
  await Q.tellFixed(t, ids, baseUrl(req));
  res.json({ ok: true });
});

router.post('/:id/reopen', manager, validate(z.object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(500) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true });
    if (isOpen(r)) throw conflict('This request is already open');
    const now = nowIn(await tz(t));
    const status = r.made_safe_at ? 'made_safe' : r.work_order_id ? 'assigned' : 'new';
    // The times it was fixed or closed stay in the timeline below; the request's clocks run again.
    await conn.query('UPDATE requests SET status = ?, fixed_at = NULL, closed_at = NULL, referred_to = NULL, referred_at = NULL, duplicate_of = NULL, closed_reason = NULL WHERE tenant_id = ? AND id = ?', [status, t, r.id]);
    await Q.event(conn, t, r.id, now, `Reopened (it was ${Q.STATUS_WORDS[r.status].toLowerCase()}${r.fixed_at ? ` at ${String(r.fixed_at).slice(0, 16)}` : r.closed_at ? ` at ${String(r.closed_at).slice(0, 16)}` : ''}): ${req.body.reason}`, req.auth.userId);
    await audit(conn, req, 'reopen', 'requests', r.id, { from: r.status, fixed_at: r.fixed_at, closed_at: r.closed_at, reason: req.body.reason });
  });
  res.json({ ok: true });
});

router.post('/:id/notes', validate(z.object({ body: z.string().trim().min(1).max(1000) })), async (req, res) => {
  const t = req.auth.tenantId;
  const r = await mustRequest(pool, req);
  await Q.event(pool, t, r.id, nowIn(await tz(t)), req.body.body, req.auth.userId, 'note');
  res.status(201).json({ ok: true });
});

// ---------------------------------------------------------------- photos (kept as taken)
async function savePhoto(conn, { tenantId, requestId, stage, buf, query, userId, byResident, now }) {
  const mime = sniff(buf);
  if (!mime) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  if (query.client_ref) {
    const seen = await one(conn, 'SELECT id, sha256 FROM request_photos WHERE tenant_id = ? AND client_ref = ?', [tenantId, query.client_ref]);
    if (seen) return { id: Number(seen.id), sha256: seen.sha256, repeat: true };
  }
  const facts = photoFacts(buf);
  const phoneAt = query.taken_at ? normDateTime(query.taken_at) : null;
  const takenAt = facts.taken_at || (phoneAt && msLocal(phoneAt) <= msLocal(now) + 5 * 60000 ? phoneAt : null);
  const hash = sha(buf);
  const [r] = await conn.query(`INSERT INTO request_photos (tenant_id, request_id, stage, mime, bytes, sha256, original, taken_at, taken_from, taken_lat, taken_lng, client_ref, by_resident, uploaded_by, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, requestId, stage, mime, buf.length, hash, buf, takenAt, facts.taken_at ? 'photo' : takenAt ? 'phone' : null,
    facts.lat ?? query.lat ?? null, facts.lng ?? query.lng ?? null, query.client_ref || null, byResident ? 1 : 0, userId, now]);
  return { id: r.insertId, sha256: hash, bytes: buf.length, taken_at: takenAt };
}
const photoQuery = z.object({
  stage: z.enum(['before', 'made_safe', 'after', 'report']).default('before'), client_ref: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), taken_at: dateTimeStr.optional(),
});

router.post('/:id/photos', raw(MAX_PHOTO), async (req, res) => {
  const t = req.auth.tenantId;
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  const q = photoQuery.safeParse(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, first(v)])));
  if (!q.success) throw bad('Something about that photo upload was not right');
  const out = await tx(async (conn) => {
    const r = await mustRequest(conn, req, { lock: true });
    const now = nowIn(await tz(t));
    const saved = await savePhoto(conn, { tenantId: t, requestId: r.id, stage: q.data.stage === 'report' ? 'before' : q.data.stage, buf, query: q.data, userId: req.auth.userId, byResident: false, now });
    if (!saved.repeat) {
      await Q.event(conn, t, r.id, now, `${{ before: 'Before', made_safe: 'Made safe', after: 'After' }[q.data.stage] || 'Before'} photo added (fingerprint ${saved.sha256.slice(0, 12)}).`, req.auth.userId);
      await audit(conn, req, 'add_photo', 'requests', r.id, { photo_id: saved.id, stage: q.data.stage, sha256: saved.sha256, bytes: saved.bytes });
    }
    return saved;
  });
  res.status(out.repeat ? 200 : 201).json(out);
});

async function photoRow(req) {
  const p = await one(pool, 'SELECT original, mime, sha256, uploaded_at FROM request_photos WHERE tenant_id = ? AND request_id = ? AND id = ?', [req.auth.tenantId, paramId(req), paramId(req, 'pid')]);
  if (!p) throw notFound('Photo');
  return p;
}
router.get('/:id/photos/:pid', async (req, res) => {
  const p = await photoRow(req);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[p.mime] || 'bin';
  res.set({ 'Content-Type': p.mime, 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="request-${paramId(req)}-photo-${paramId(req, 'pid')}.${ext}"`, 'X-Content-SHA256': p.sha256, 'Cache-Control': 'private, no-store' }).send(p.original);
});
router.get('/:id/photos/:pid/verify', async (req, res) => {
  const p = await photoRow(req);
  const now = sha(p.original);
  res.json({ unchanged: now === p.sha256, recorded: p.sha256, computed: now, uploaded_at: p.uploaded_at });
});

// ================================================================ public pages
const SLUG = /^[a-z0-9-]{1,80}$/i;
async function municipality(slug) {
  if (!SLUG.test(String(slug || ''))) throw notFound('Page');
  const t = await one(pool, "SELECT id, name, slug, timezone FROM tenants WHERE slug = ? AND org_type = 'municipality' AND status = 'active'", [slug]);
  if (!t) throw notFound('Page');
  return t;
}
const TOKEN = /^[0-9a-f]{32}$/;
async function byToken(req) {
  const t = await municipality(req.params.slug);
  const token = String(req.params.token || '');
  if (!TOKEN.test(token)) throw notFound('Report');
  const r = await one(pool, `${Q.REQ_SQL} WHERE r.tenant_id = ? AND r.status_token = ?`, [t.id, token]);
  if (!r) throw notFound('Report');
  return { t, r };
}
const limit = (name, windowMs, envMax, max) => counter({ name, windowMs, max: Number(process.env[envMax]) || max });
const LIMITS = { photos: limit('report-photos', 3_600_000, 'REPORT_PHOTO_LIMIT', 10), stop: limit('report-stop', 3_600_000, 'REPORT_STOP_LIMIT', 10) };
async function within(which, key) {
  const { over, retryAfter } = await LIMITS[which].hit(key);
  if (over) throw Object.assign(new AppError(429, 'Too many tries. Please try again later, or call the municipal office.'), { extra: { retry_after: retryAfter } });
}

publicRouter.get('/:slug/report', async (req, res) => {
  const t = await municipality(req.params.slug);
  const [categories, streets, s] = await Promise.all([Q.categoriesOf(pool, t.id), rows(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name LIMIT 3000', [t.id]), Q.settingsOf(pool, t.id)]);
  res.set('Cache-Control', 'no-store');
  res.json({
    municipality: t.name, intro: s.intro, office_phone: s.office_phone, after_hours_phone: s.after_hours_phone, open_map: s.public_map,
    categories: categories.map((c) => ({ id: c.id, name: c.name, needs_contact: c.needs_contact, after_hours: c.after_hours })),
    streets: streets.map((x) => ({ id: Number(x.id), name: x.name })),
  });
});

const reportFields = z.object({
  category_id: z.number().int().positive(), ...whereFields, description: nullable(z.string().trim().max(1000)),
  name: nullable(z.string().trim().max(120)), phone: nullable(z.union([phoneText, z.literal('')])), email: nullable(z.union([z.string().trim().email('Type a full email address').max(190), z.literal('')])),
  texts_ok: z.boolean().optional(), emails_ok: z.boolean().optional(), website: z.any().optional(), rid: nullable(z.string().regex(/^[0-9a-f]{32}$/)),
});

publicRouter.post('/:slug/report', validate(reportFields), async (req, res) => {
  const t = await municipality(req.params.slug);
  res.set('Cache-Control', 'no-store');
  const b = req.body;
  if (b.website !== undefined && b.website !== null && String(b.website).trim() !== '') return res.status(202).json({ ok: true }); // the hidden field: real people leave it empty
  if (!hasPlace(b)) throw bad('Say where: pick the street, type the nearest cross street, or use your location');
  if (b.texts_ok && !b.phone) throw bad('Type your phone number to get texts');
  if (b.texts_ok && !require('../lib/sms').e164(b.phone)) throw bad('Texts go only to a US or Canadian mobile number');
  if (b.emails_ok && !b.email) throw bad('Type your email address to get emails');
  const now = nowIn(t.timezone);
  const out = await tx(async (conn) => {
    if (b.rid) {
      const same = await one(conn, 'SELECT id, reference, status_token FROM requests WHERE tenant_id = ? AND request_key = ?', [t.id, b.rid]);
      if (same) return { id: Number(same.id), reference: same.reference, token: same.status_token, repeat: true };
    }
    const cat = await categoryOf(conn, t.id, b.category_id);
    const street = b.street_id ? await streetOf(conn, t.id, b.street_id, { activeOnly: true }) : null;
    if (cat.needs_contact && !b.phone && !b.email) throw bad(`For ${cat.name.toLowerCase()}, give a phone number or email so the crew can reach you`);
    const residentId = (b.name || b.phone || b.email) ? await RES.upsertResident(conn, t.id, { name: b.name, phone: b.phone || null, email: b.email || null, streetId: street ? street.id : null, houseNumber: b.house_number, textsOk: b.texts_ok ? true : undefined, emailsOk: b.emails_ok ? true : undefined }, { source: 'report_page' }) : null;
    const ref = await Q.newReference(conn, t.id);
    const token = Q.newToken();
    const sender = crypto.createHmac('sha256', config.linkSecret).update(`${t.id}|${req.ip}`).digest('hex').slice(0, 16);
    const [r] = await conn.query(`INSERT INTO requests (tenant_id, reference, status_token, category_id, street_id, house_number, cross_street, lat, lng, accuracy_m, description, source, resident_id,
        updates_by_text, updates_by_email, reported_at, request_key, sender_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?)`,
    [t.id, ref, token, cat.id, street ? street.id : null, b.house_number || null, b.cross_street || null, b.lat ?? null, b.lng ?? null, b.accuracy == null ? null : Math.round(b.accuracy),
      b.description || null, residentId, b.texts_ok && b.phone ? 1 : 0, b.emails_ok && b.email ? 1 : 0, now, b.rid || null, sender]);
    await Q.event(conn, t.id, r.insertId, now, `Reported on the report page${b.lat != null ? `, with the phone's location (within about ${b.accuracy == null ? '?' : Math.round(b.accuracy)} m)` : ''}.`);
    // The record of when the municipality was told: written to the audit log too, with no one signed in.
    await audit(conn, { auth: { tenantId: t.id, userId: null }, ip: req.ip }, 'create', 'requests', r.insertId, { source: 'web', reference: ref, reported_at: now });
    return { id: r.insertId, reference: ref, token };
  });
  if (!out.repeat) {
    Q.alertNew(t.id, out.id).catch(() => {});
    Q.tellResident(t.id, out.id, 'received', { base: baseUrl(req) }).catch(() => {});
  }
  res.status(out.repeat ? 200 : 201).json({ ok: true, reference: out.reference, token: out.token, status: 'received', ...(out.repeat ? { joined: true } : {}) });
});

publicRouter.get('/:slug/report/:token', async (req, res) => {
  const { t, r } = await byToken(req);
  res.set('Cache-Control', 'no-store');
  const photos = await rows(pool, "SELECT id, stage FROM request_photos WHERE tenant_id = ? AND request_id = ? AND ((stage = 'report' AND by_resident = 1) OR stage = 'after') AND mime <> 'image/heic' ORDER BY id", [t.id, r.id]);
  const mine = photos.filter((p) => p.stage === 'report').length;
  const s = await Q.settingsOf(pool, t.id);
  const st = Q.publicStatus(r);
  res.json({
    municipality: t.name, reference: r.reference, category: r.category, place: Q.placeWords(r, { withNumber: false }), reported_at: r.reported_at,
    status: st.key, status_words: st.words, status_more: st.more, made_safe_at: r.made_safe_at, fixed_at: r.fixed_at, closed_at: r.closed_at,
    public_note: r.public_note, photos: photos.map((p) => ({ id: Number(p.id), stage: p.stage === 'after' ? 'after' : 'yours' })),
    updates: { text: Boolean(r.updates_by_text), email: Boolean(r.updates_by_email) }, office_phone: s.office_phone,
    can_add_photos: mine < RESIDENT_PHOTOS && msLocal(nowIn(t.timezone)) - msLocal(r.reported_at) < 24 * 3600000 && Q.OPEN.includes(r.status),
  });
});

publicRouter.post('/:slug/report/:token/photos', raw(MAX_PHOTO), async (req, res) => {
  const { t, r } = await byToken(req);
  res.set('Cache-Control', 'no-store');
  await within('photos', r.status_token);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('Choose a photo');
  if (!sniff(buf)) throw bad('That file is not a photo (JPEG, PNG, WebP or HEIC)');
  const q = photoQuery.safeParse({ ...Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, first(v)])), stage: 'report' });
  if (!q.success) throw bad('Something about that photo was not right. Try another one.');
  const now = nowIn(t.timezone);
  if (msLocal(now) - msLocal(r.reported_at) > 24 * 3600000 || !Q.OPEN.includes(r.status)) throw conflict('Photos can be added for a day after the report, while it is open.');
  const out = await tx(async (conn) => {
    await one(conn, 'SELECT id FROM requests WHERE tenant_id = ? AND id = ? FOR UPDATE', [t.id, r.id]);
    // The phone's ref is kept with the report's id, so a retry of the same upload is stored once (and not counted twice).
    const query = { ...q.data, client_ref: q.data.client_ref ? `p${r.id}-${q.data.client_ref}`.slice(0, 40) : undefined };
    const retry = query.client_ref && await one(conn, 'SELECT id FROM request_photos WHERE tenant_id = ? AND client_ref = ?', [t.id, query.client_ref]);
    const n = await one(conn, "SELECT COUNT(*) AS n FROM request_photos WHERE tenant_id = ? AND request_id = ? AND stage = 'report' AND by_resident = 1", [t.id, r.id]);
    if (!retry && Number(n.n) >= RESIDENT_PHOTOS) throw conflict(`Up to ${RESIDENT_PHOTOS} photos can be added to a report.`);
    const saved = await savePhoto(conn, { tenantId: t.id, requestId: r.id, stage: 'report', buf, query, userId: null, byResident: true, now });
    if (!saved.repeat) await Q.event(conn, t.id, r.id, now, `The resident added a photo (fingerprint ${saved.sha256.slice(0, 12)}).`);
    return saved;
  });
  res.status(out.repeat ? 200 : 201).json({ ok: true, id: out.id });
});

publicRouter.get('/:slug/report/:token/photos/:pid', async (req, res) => {
  const { t, r } = await byToken(req);
  const pid = Number(req.params.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw notFound('Photo');
  const p = await one(pool, "SELECT original FROM request_photos WHERE tenant_id = ? AND request_id = ? AND id = ? AND ((stage = 'report' AND by_resident = 1) OR stage = 'after')", [t.id, r.id, pid]);
  if (!p) throw notFound('Photo');
  const shown = stripGps(p.original); // where it was taken never leaves on a public page
  if (!shown) throw notFound('Photo');
  res.set({ 'Content-Type': sniff(shown), 'Cache-Control': 'private, no-store' }).send(shown);
});

publicRouter.post('/:slug/report/:token/stop', async (req, res) => {
  const { t, r } = await byToken(req);
  res.set('Cache-Control', 'no-store');
  await within('stop', r.status_token);
  await tx(async (conn) => {
    await conn.query('UPDATE requests SET updates_by_text = 0, updates_by_email = 0 WHERE tenant_id = ? AND id = ?', [t.id, r.id]);
    if (r.resident_id) {
      const res0 = await one(conn, 'SELECT texts_ok, emails_ok FROM residents WHERE tenant_id = ? AND id = ?', [t.id, r.resident_id]);
      if (res0 && Number(res0.texts_ok)) await RES.recordConsent(conn, t.id, r.resident_id, 'sms', false, 'status_page');
      if (res0 && Number(res0.emails_ok)) await RES.recordConsent(conn, t.id, r.resident_id, 'email', false, 'status_page');
    }
    await Q.event(conn, t.id, r.id, nowIn(t.timezone), 'The resident stopped updates by text and email.');
  });
  res.json({ ok: true });
});

publicRouter.get('/:slug/open-requests', async (req, res) => {
  const t = await municipality(req.params.slug);
  const s = await Q.settingsOf(pool, t.id);
  if (!s.public_map) throw notFound('Page');
  res.set('Cache-Control', 'no-store');
  const since = `${addDays(todayIn(t.timezone), -30)} 00:00:00`;
  const list = await rows(pool, `${Q.REQ_SQL} WHERE r.tenant_id = ? AND (r.status IN ('new','assigned','made_safe') OR (r.status = 'fixed' AND r.fixed_at >= ?)) ORDER BY r.reported_at DESC LIMIT 1500`, [t.id, since]);
  const center = await one(pool, 'SELECT map_lat, map_lng, map_zoom FROM tenants WHERE id = ?', [t.id]);
  // What and roughly where only: the category, the street's name, the status, the day. No house number, no description,
  // no photo, no one's name, and positions rounded to about 50 m.
  const shape = (r) => ({ category: r.category, color: r.category_color, street: r.street_name || null, status: Q.publicStatus(r).words, reported_on: String(r.reported_at).slice(0, 10),
    fixed_on: r.fixed_at ? String(r.fixed_at).slice(0, 10) : null, at: Q.roundPosition(r.lat, r.lng) });
  res.json({
    municipality: t.name, layers: config.map.layers, max_zoom: config.map.maxZoom,
    center: center && center.map_lat !== null ? { lat: Number(center.map_lat), lng: Number(center.map_lng), zoom: center.map_zoom || 14 } : null,
    open: list.filter((r) => Q.OPEN.includes(r.status)).map(shape), fixed: list.filter((r) => r.status === 'fixed').map(shape),
  });
});

module.exports = { router, publicRouter };
