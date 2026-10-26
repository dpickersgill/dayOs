'use strict';

// Lost and found (mounted under /lost-found; the guest form under /public/:slug/lost). Front desk logs what is handed
// in and what guests report missing; possible matches are suggested both ways; staff confirm a match and the guest is
// told by email or text; an item leaves as returned (with who collected it and an ID check), donated or thrown away.
// Phones, wallets, keys and cards are valuables, for locked storage. Card numbers are never asked for or kept.
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId, dateStr, dateTimeStr, normDateTime, nowIn, todayIn, addDays } = require('../lib/util');
const { notFound, bad, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const mailer = require('../lib/mailer');
const sms = require('../lib/sms');

const router = express.Router();
const publicRouter = express.Router();
const desk = requireRole('counter', 'manager', 'staff');
const KINDS = [['phone', 'Phone'], ['wallet', 'Wallet or purse'], ['keys', 'Keys'], ['card', 'Card or pass'], ['glasses', 'Glasses or sunglasses'], ['goggles', 'Goggles'], ['gloves', 'Gloves or mittens'],
  ['hat', 'Hat or helmet'], ['jacket', 'Jacket or clothing'], ['skis', 'Skis'], ['snowboard', 'Snowboard'], ['poles', 'Poles'], ['bag', 'Bag or backpack'], ['electronics', 'Electronics'], ['jewelry', 'Jewelry or watch'], ['other', 'Something else']];
const KIND_KEYS = KINDS.map((k) => k[0]);
const VALUABLE = new Set(['phone', 'wallet', 'keys', 'card', 'electronics', 'jewelry']);
const kindText = (k) => (KINDS.find((x) => x[0] === k) || [k, k])[1];
const MAX_PHOTO = 90_000; // a small JPEG made on the device, as a data URL

const settingsOf = async (db, t) => {
  const s = await one(db, 'SELECT keep_days, web_form, pickup FROM lost_found_settings WHERE tenant_id = ?', [t]);
  return { keep_days: s ? Number(s.keep_days) : 60, web_form: s ? Boolean(Number(s.web_form)) : true, pickup: s ? s.pickup : null };
};
const tzOf = async (db, t) => (await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [t])).timezone;

// ---------------------------------------------------------------- matching
const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const overlap = (a, b) => { const x = words(a); return [...words(b)].filter((w) => x.has(w)).length; };
/**
 * How well a found item fits a report: the same kind counts most, then color, brand, place and description words, and
 * the found date close after the lost date. Below 5 is not a likely match.
 */
function score(item, rep) {
  let n = item.kind === rep.kind ? 5 : 0;
  n += Math.min(2, overlap(item.color, rep.color)) * 2;
  n += Math.min(1, overlap(item.brand, rep.brand)) * 2;
  n += Math.min(2, overlap(item.found_where, rep.lost_where));
  n += Math.min(2, overlap(item.description, rep.description));
  const found = String(item.found_at).slice(0, 10); const lost = String(rep.lost_on).slice(0, 10);
  if (found >= addDays(lost, -1) && found <= addDays(lost, 7)) n += 2; else if (found < addDays(lost, -1)) n -= 3;
  return n;
}

const itemShape = (r) => ({ ...r, id: Number(r.id), number: Number(r.number), valuable: Boolean(Number(r.valuable)), id_checked: Boolean(Number(r.id_checked)), has_photo: Boolean(r.has_photo), photo: undefined, kind_label: kindText(r.kind) });
const ITEM_COLS = 'i.id, i.number, i.kind, i.description, i.brand, i.color, i.found_where, i.found_at, i.found_by, i.bin, i.valuable, i.status, i.report_id, i.returned_to, i.id_checked, i.closed_at, i.created_at, (i.photo IS NOT NULL) AS has_photo';

// ---------------------------------------------------------------- found items
/** Held items (or another status), the reports still open, what is due to clear out, and the settings. */
router.get('/', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const status = ['held', 'matched', 'returned', 'donated', 'discarded', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
  const where = status === 'open' ? "i.status IN ('held', 'matched')" : status === 'all' ? '1 = 1' : 'i.status = ?';
  const items = await rows(pool, `SELECT ${ITEM_COLS} FROM lost_items i WHERE i.tenant_id = ? AND ${where} ORDER BY i.found_at DESC LIMIT 300`, status === 'open' || status === 'all' ? [t] : [t, status]);
  const reports = await rows(pool, "SELECT * FROM lost_reports WHERE tenant_id = ? AND status = 'open' ORDER BY lost_on DESC, id DESC LIMIT 300", [t]);
  const s = await settingsOf(pool, t);
  const today = todayIn(await tzOf(pool, t));
  const cutoff = addDays(today, -s.keep_days);
  // Possible matches for each open report, from the items still held.
  const held = await rows(pool, "SELECT id, number, kind, description, brand, color, found_where, found_at FROM lost_items WHERE tenant_id = ? AND status = 'held'", [t]);
  res.json({
    items: items.map((i) => ({ ...itemShape(i), due: i.status === 'held' && String(i.found_at).slice(0, 10) <= cutoff })),
    reports: reports.map((r) => ({ ...r, id: Number(r.id), matches: held.map((i) => ({ id: Number(i.id), number: Number(i.number), score: score(i, r) })).filter((m) => m.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3) })),
    settings: s, kinds: KINDS, today,
  });
});

const itemFields = {
  kind: z.enum(KIND_KEYS),
  description: z.string().trim().max(255).nullable().optional(),
  brand: z.string().trim().max(60).nullable().optional(),
  color: z.string().trim().max(40).nullable().optional(),
  found_where: z.string().trim().max(150).nullable().optional(),
  found_at: dateTimeStr.transform(normDateTime).optional(),
  found_by: z.string().trim().max(150).nullable().optional(),
  bin: z.string().trim().max(40).nullable().optional(),
  valuable: z.boolean().optional(),
  photo: z.string().max(MAX_PHOTO).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'A photo from this screen').nullable().optional(),
};
// Anything that looks like a card number is refused: the item is described, its numbers are not kept.
const noCardNumbers = (b) => { for (const k of ['description', 'brand', 'bin']) if (/\b(?:\d[ -]?){13,19}\b/.test(String(b[k] || ''))) throw bad('Do not write card numbers here. Describe the card instead, for example "blue Visa, name on it".'); };

router.post('/items', desk, validate(z.object(itemFields)), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  noCardNumbers(b);
  const out = await tx(async (conn) => {
    const { n } = await one(conn, 'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM lost_items WHERE tenant_id = ? FOR UPDATE', [t]);
    const at = b.found_at || nowIn(await tzOf(conn, t));
    const [r] = await conn.query(`INSERT INTO lost_items (tenant_id, number, kind, description, brand, color, found_where, found_at, found_by, bin, valuable, photo, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [t, n, b.kind, b.description || null, b.brand || null, b.color || null, b.found_where || null, at, b.found_by || null, b.bin || null, (b.valuable ?? VALUABLE.has(b.kind)) ? 1 : 0, b.photo || null, req.auth.userId]);
    await audit(conn, req, 'create', 'lost_items', r.insertId);
    return { id: r.insertId, number: Number(n) };
  });
  // Open reports this item may belong to, so the counter can tell the guest straight away.
  const item = await one(pool, 'SELECT * FROM lost_items WHERE id = ?', [out.id]);
  const reps = await rows(pool, "SELECT * FROM lost_reports WHERE tenant_id = ? AND status = 'open'", [t]);
  res.status(201).json({ ...out, matches: reps.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, description: r.description, lost_on: r.lost_on, score: score(item, r) })).filter((m) => m.score >= 5).sort((a, b) => b.score - a.score).slice(0, 3) });
});

router.patch('/items/:id', desk, validate(z.object(itemFields).partial()), async (req, res) => {
  const t = req.auth.tenantId;
  const b = req.body;
  noCardNumbers(b);
  const keys = Object.keys(b).filter((k) => b[k] !== undefined);
  if (!keys.length) throw bad('Nothing to change');
  const [r] = await pool.query(`UPDATE lost_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => (typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : b[k])), t, paramId(req)]);
  if (!r.affectedRows) throw notFound('Item');
  res.json({ ok: true });
});

router.get('/items/:id/photo', desk, async (req, res) => {
  const r = await one(pool, 'SELECT photo FROM lost_items WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, paramId(req)]);
  if (!r || !r.photo) throw notFound('Photo');
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/.exec(r.photo);
  res.set('Content-Type', mime).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(b64, 'base64'));
});

/** Reports an item may belong to (best first), for the item's page. */
router.get('/items/:id/matches', desk, async (req, res) => {
  const t = req.auth.tenantId;
  const item = await one(pool, 'SELECT * FROM lost_items WHERE tenant_id = ? AND id = ?', [t, paramId(req)]);
  if (!item) throw notFound('Item');
  const reps = await rows(pool, "SELECT * FROM lost_reports WHERE tenant_id = ? AND status = 'open'", [t]);
  res.json({ data: reps.map((r) => ({ ...r, id: Number(r.id), score: score(item, r) })).filter((m) => m.score >= 3).sort((a, b) => b.score - a.score).slice(0, 10) });
});

/** Handed back: who collected it, and that their ID was checked. */
router.post('/items/:id/return', desk, validate(z.object({ returned_to: z.string().trim().min(2).max(150), id_checked: z.literal(true, { errorMap: () => ({ message: 'Check their ID before handing it over' }) }) })), async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const it = await one(conn, 'SELECT * FROM lost_items WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, paramId(req)]);
    if (!it) throw notFound('Item');
    if (!['held', 'matched'].includes(it.status)) throw conflict(`This item is already ${it.status}`);
    await conn.query("UPDATE lost_items SET status = 'returned', returned_to = ?, id_checked = 1, closed_at = ?, closed_by = ? WHERE tenant_id = ? AND id = ?", [req.body.returned_to, nowIn(await tzOf(conn, t)), req.auth.userId, t, it.id]);
    if (it.report_id) await conn.query("UPDATE lost_reports SET status = 'closed' WHERE tenant_id = ? AND id = ?", [t, it.report_id]);
    await audit(conn, req, 'return', 'lost_items', it.id, { to: req.body.returned_to });
  });
  res.json({ ok: true });
});

/** Cleared out after the keeping time: donated or thrown away. */
router.post('/items/:id/clear', desk, validate(z.object({ how: z.enum(['donated', 'discarded']) })), async (req, res) => {
  const t = req.auth.tenantId;
  const [r] = await pool.query("UPDATE lost_items SET status = ?, closed_at = ?, closed_by = ? WHERE tenant_id = ? AND id = ? AND status IN ('held', 'matched')", [req.body.how, nowIn(await tzOf(pool, t)), req.auth.userId, t, paramId(req)]);
  if (!r.affectedRows) throw conflict('Only items still held can be cleared out');
  await audit(pool, req, req.body.how, 'lost_items', paramId(req));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- reports of lost things
const reportFields = {
  kind: z.enum(KIND_KEYS),
  description: z.string().trim().max(255).optional(),
  brand: z.string().trim().max(60).optional(),
  color: z.string().trim().max(40).optional(),
  lost_where: z.string().trim().max(150).optional(),
  lost_on: dateStr,
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255).optional(),
  phone: z.string().trim().max(40).optional(),
};
const contactNeeded = (b) => { if (!b.email && !b.phone) throw bad('Give an email address or a phone number, so they can be told when it is found'); };

async function saveReport(db, t, b, source, userId) {
  const [r] = await db.query('INSERT INTO lost_reports (tenant_id, kind, description, brand, color, lost_where, lost_on, name, email, phone, source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [t, b.kind, b.description || null, b.brand || null, b.color || null, b.lost_where || null, b.lost_on, b.name, b.email || null, b.phone || null, source, userId || null]);
  return r.insertId;
}

router.post('/reports', desk, validate(z.object(reportFields)), async (req, res) => {
  const t = req.auth.tenantId;
  contactNeeded(req.body);
  noCardNumbers(req.body);
  const id = await saveReport(pool, t, req.body, 'counter', req.auth.userId);
  await audit(pool, req, 'create', 'lost_reports', id);
  const rep = await one(pool, 'SELECT * FROM lost_reports WHERE id = ?', [id]);
  const held = await rows(pool, `SELECT ${ITEM_COLS} FROM lost_items i WHERE i.tenant_id = ? AND i.status = 'held'`, [t]);
  res.status(201).json({ id, matches: held.map((i) => ({ ...itemShape(i), score: score(i, rep) })).filter((m) => m.score >= 5).sort((a, b) => b.score - a.score).slice(0, 5) });
});

router.post('/reports/:id/close', desk, async (req, res) => {
  const [r] = await pool.query("UPDATE lost_reports SET status = 'closed' WHERE tenant_id = ? AND id = ? AND status = 'open'", [req.auth.tenantId, paramId(req)]);
  if (!r.affectedRows) throw notFound('Open report');
  res.json({ ok: true });
});

/**
 * This item is theirs: the item is set aside for them, the report marked found, and the guest told by email or text
 * with how to collect it (unless the counter has them in front of them).
 */
router.post('/match', desk, validate(z.object({ item_id: z.number().int().positive(), report_id: z.number().int().positive(), tell: z.boolean().default(true) })), async (req, res) => {
  const t = req.auth.tenantId;
  const out = await tx(async (conn) => {
    const it = await one(conn, 'SELECT * FROM lost_items WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, req.body.item_id]);
    const rep = await one(conn, 'SELECT * FROM lost_reports WHERE tenant_id = ? AND id = ? FOR UPDATE', [t, req.body.report_id]);
    if (!it) throw notFound('Item');
    if (!rep) throw notFound('Report');
    if (it.status !== 'held') throw conflict('This item is not waiting to be claimed');
    if (rep.status !== 'open') throw conflict('This report is already closed');
    await conn.query("UPDATE lost_items SET status = 'matched', report_id = ? WHERE tenant_id = ? AND id = ?", [rep.id, t, it.id]);
    await conn.query("UPDATE lost_reports SET status = 'found', item_id = ? WHERE tenant_id = ? AND id = ?", [it.id, t, rep.id]);
    await audit(conn, req, 'match', 'lost_items', it.id, { report: rep.id });
    return { it, rep };
  });
  let told = null;
  if (req.body.tell) {
    const tenant = await one(pool, 'SELECT id, name FROM tenants WHERE id = ?', [t]);
    const s = await settingsOf(pool, t);
    const what = [out.it.color, out.it.brand, kindText(out.it.kind).toLowerCase()].filter(Boolean).join(' ');
    const text = `Good news from ${tenant.name}: we think we have found your ${what}. Item number ${out.it.number}. ${s.pickup || 'Collect it from Guest Services with photo ID.'}`;
    if (out.rep.email && (await mailer.send({ tenantId: t, to: out.rep.email, fromName: tenant.name, subject: `${tenant.name}: we may have found your ${kindText(out.it.kind).toLowerCase()}`, text: `Hello ${out.rep.name},\n\n${text}\n\nIf it is not yours, reply and let us know.`, tag: 'lost-found' })).ok) told = 'email';
    else if (out.rep.phone && (await sms.send({ tenantId: t, to: out.rep.phone, body: text })).ok) told = 'text';
    if (told) await pool.query('UPDATE lost_reports SET told_at = ? WHERE tenant_id = ? AND id = ?', [nowIn(await tzOf(pool, t)), t, out.rep.id]);
  }
  res.json({ ok: true, told });
});

/** Take back a match made by mistake: the item is held again and the report open again. */
router.post('/items/:id/unmatch', desk, async (req, res) => {
  const t = req.auth.tenantId;
  await tx(async (conn) => {
    const it = await one(conn, "SELECT * FROM lost_items WHERE tenant_id = ? AND id = ? AND status = 'matched' FOR UPDATE", [t, paramId(req)]);
    if (!it) throw conflict('This item is not matched');
    await conn.query("UPDATE lost_items SET status = 'held', report_id = NULL WHERE tenant_id = ? AND id = ?", [t, it.id]);
    await conn.query("UPDATE lost_reports SET status = 'open', item_id = NULL WHERE tenant_id = ? AND id = ?", [t, it.report_id]);
  });
  res.json({ ok: true });
});

router.put('/settings', requireRole('manager'), validate(z.object({ keep_days: z.number().int().min(7).max(365), web_form: z.boolean(), pickup: z.string().trim().max(255).nullable().optional() })), async (req, res) => {
  const t = req.auth.tenantId;
  await pool.query('INSERT INTO lost_found_settings (tenant_id, keep_days, web_form, pickup) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE keep_days = VALUES(keep_days), web_form = VALUES(web_form), pickup = VALUES(pickup)', [t, req.body.keep_days, req.body.web_form ? 1 : 0, req.body.pickup || null]);
  await audit(pool, req, 'update', 'lost_found_settings', null, req.body);
  res.json(await settingsOf(pool, t));
});

// ---------------------------------------------------------------- the guest form (no sign-in)
publicRouter.get('/:slug/lost', async (req, res) => {
  const t = await one(pool, 'SELECT id, name, timezone FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t || !(await settingsOf(pool, t.id)).web_form) throw notFound('Lost and found form');
  res.set('Cache-Control', 'no-store');
  res.json({ mountain: t.name, kinds: KINDS, today: todayIn(t.timezone) });
});

publicRouter.post('/:slug/lost', validate(z.object({ ...reportFields, website: z.string().max(200).optional() })), async (req, res) => {
  const t = await one(pool, 'SELECT id, timezone FROM tenants WHERE slug = ?', [req.params.slug]);
  if (!t || !(await settingsOf(pool, t.id)).web_form) throw notFound('Lost and found form');
  res.set('Cache-Control', 'no-store');
  if (req.body.website) return res.status(202).json({ ok: true }); // a form-filling bot: pretend, keep nothing
  contactNeeded(req.body);
  noCardNumbers(req.body);
  const today = todayIn(t.timezone);
  if (req.body.lost_on > today || req.body.lost_on < addDays(today, -365)) throw bad('Choose the day you lost it');
  const { n } = await one(pool, "SELECT COUNT(*) AS n FROM lost_reports WHERE tenant_id = ? AND source = 'web' AND created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR", [t.id]);
  if (n >= 60) return res.status(503).json({ error: 'Too many reports right now. Please call the mountain.' });
  await saveReport(pool, t.id, req.body, 'web', null);
  return res.status(201).json({ ok: true });
});

module.exports = { router, publicRouter, score, KINDS };
