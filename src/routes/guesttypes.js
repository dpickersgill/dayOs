'use strict';

// Products and prices, Guest types (lib/guesttypes.js): everyone who sells sees the list; managers add, rename, set
// ages, hide and reorder. A type that has been priced or sold is kept for the record and can only be hidden.
const express = require('express');
const { pool, one } = require('../db');
const { z, validate } = require('../lib/util');
const { requireRole } = require('../middleware/auth');
const { bad, conflict, notFound } = require('../lib/errors');
const { audit } = require('../lib/audit');
const GT = require('../lib/guesttypes');

const router = express.Router();
const age = z.number().int().min(0).max(120).nullable().optional();
const checkAges = (b) => { if (b.min_age != null && b.max_age != null && b.min_age > b.max_age) throw bad('The youngest age is older than the oldest'); };

router.get('/', async (req, res) => {
  res.json({ types: await GT.list(pool, req.auth.tenantId) });
});

router.post('/', requireRole('manager'), validate(z.object({ name: z.string().trim().min(1).max(60), min_age: age, max_age: age, online: z.boolean().optional() })), async (req, res) => {
  const b = req.body;
  checkAges(b);
  const types = await GT.list(pool, req.auth.tenantId);
  if (types.some((t) => t.name.toLowerCase() === b.name.toLowerCase())) throw conflict(`There is already a guest type called ${b.name}`);
  if (types.length >= 40) throw bad('A mountain can have up to 40 guest types');
  const base = GT.codeFor(b.name); let code = base;
  for (let i = 2; types.some((t) => t.code === code); i += 1) code = `${base.slice(0, 27)}_${i}`;
  const sort = types.reduce((m, t) => Math.max(m, t.sort), 0) + 1;
  await pool.query('INSERT INTO guest_types (tenant_id, code, name, min_age, max_age, online, sort) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [req.auth.tenantId, code, b.name, b.min_age ?? null, b.max_age ?? null, b.online === false ? 0 : 1, sort]);
  await audit(pool, req, 'create', 'guest_types', null, { code, name: b.name });
  res.status(201).json((await GT.list(pool, req.auth.tenantId)).find((t) => t.code === code));
});

router.patch('/:code', requireRole('manager'), validate(z.object({
  name: z.string().trim().min(1).max(60).optional(), min_age: age, max_age: age, online: z.boolean().optional(), hidden: z.boolean().optional(),
})), async (req, res) => {
  const types = await GT.list(pool, req.auth.tenantId);
  const t = types.find((x) => x.code === req.params.code);
  if (!t) throw notFound('Guest type');
  const b = req.body;
  checkAges({ min_age: b.min_age !== undefined ? b.min_age : t.min_age, max_age: b.max_age !== undefined ? b.max_age : t.max_age });
  if (b.name && types.some((x) => x.code !== t.code && x.name.toLowerCase() === b.name.toLowerCase())) throw conflict(`There is already a guest type called ${b.name}`);
  if (b.hidden && !t.hidden && types.filter((x) => !x.hidden).length <= 1) throw conflict('At least one guest type has to stay visible');
  const set = []; const vals = [];
  for (const k of ['name', 'min_age', 'max_age']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k]); }
  for (const k of ['online', 'hidden']) if (b[k] !== undefined) { set.push(`${k} = ?`); vals.push(b[k] ? 1 : 0); }
  if (!set.length) throw bad('Nothing to change');
  await pool.query(`UPDATE guest_types SET ${set.join(', ')} WHERE tenant_id = ? AND code = ?`, [...vals, req.auth.tenantId, t.code]);
  await audit(pool, req, 'update', 'guest_types', null, { code: t.code, ...b });
  res.json((await GT.list(pool, req.auth.tenantId)).find((x) => x.code === t.code));
});

/** The order types appear in at the counter, on price forms and online: every code, in the new order. */
router.post('/order', requireRole('manager'), validate(z.object({ codes: z.array(z.string().max(30)).min(1).max(40) })), async (req, res) => {
  const types = await GT.list(pool, req.auth.tenantId);
  const codes = req.body.codes;
  if (codes.length !== types.length || !types.every((t) => codes.includes(t.code))) throw bad('Send every guest type, each once, in the new order');
  for (const [i, code] of codes.entries()) await pool.query('UPDATE guest_types SET sort = ? WHERE tenant_id = ? AND code = ?', [i + 1, req.auth.tenantId, code]);
  await audit(pool, req, 'reorder', 'guest_types', null, { codes });
  res.json({ types: await GT.list(pool, req.auth.tenantId) });
});

router.delete('/:code', requireRole('manager'), async (req, res) => {
  const t = await one(pool, 'SELECT code, hidden FROM guest_types WHERE tenant_id = ? AND code = ?', [req.auth.tenantId, req.params.code]);
  if (!t) throw notFound('Guest type');
  if (await GT.used(pool, req.auth.tenantId, t.code)) throw conflict('This guest type has prices or sales on record, so it stays. Hide it instead.');
  const visible = (await GT.list(pool, req.auth.tenantId, { visibleOnly: true })).length;
  if (!Number(t.hidden) && visible <= 1) throw conflict('At least one guest type has to stay visible');
  await pool.query('DELETE FROM guest_types WHERE tenant_id = ? AND code = ?', [req.auth.tenantId, t.code]);
  await audit(pool, req, 'delete', 'guest_types', null, { code: t.code });
  res.json({ ok: true });
});

module.exports = router;
