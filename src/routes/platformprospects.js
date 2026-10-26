'use strict';

// Prospects in the platform console (mounted at /platform/prospects, behind the console's sign-in): the ski areas we
// are selling to, the people there, where each one is in the pipeline, the next step, and a timeline of notes.
// See src/lib/prospects.js.
const express = require('express');
const { pool, rows, one } = require('../db');
const { z, validate, paramId } = require('../lib/util');
const { bad, notFound } = require('../lib/errors');
const { cell } = require('../lib/csv');
const P = require('../lib/prospects');

const s = (max) => z.string().trim().max(max);
// An emptied box arrives as '' and is saved as nothing.
const opt = (schema) => z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), schema.nullable().optional());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-11-02');

const prospectFields = {
  name: s(150).min(1),
  state: opt(z.string().trim().length(2).transform((v) => v.toUpperCase())),
  town: opt(s(120)),
  region: opt(s(60)),
  website: opt(s(500).url('A full web address, starting with https://')),
  phone: opt(s(60)),
  ownership: opt(s(600)),
  indy_pass: z.boolean().nullable().optional(),
  vertical_ft: z.number().int().min(0).max(10000).nullable().optional(),
  lifts: z.number().int().min(0).max(100).nullable().optional(),
  trails: z.number().int().min(0).max(500).nullable().optional(),
  acres: z.number().int().min(0).max(20000).nullable().optional(),
  patrol: z.enum(P.PATROL_KINDS).nullable().optional(),
  fit_notes: opt(s(2000)),
  stage: z.enum(P.STAGE_KEYS).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  plan_interest: opt(s(60)),
  next_step: opt(s(300)),
  next_on: date.nullable().optional(),
  owner_name: opt(s(100)),
  tenant_id: z.number().int().positive().nullable().optional(),
};
const contactFields = {
  role: z.enum(P.ROLE_KEYS),
  name: opt(s(120)),
  title: opt(s(200)),
  email: opt(z.string().trim().max(200).email('That email address does not look right')),
  phone: opt(s(80)),
  source_url: opt(s(500).url('A full web address, starting with https://')),
  note: opt(s(500)),
};

module.exports = function prospectsRouter(log) {
  const router = express.Router();

  const leaderOf = (contacts) => {
    for (const role of P.LEADER_ORDER) { const c = contacts.find((x) => x.role === role && x.name); if (c) return c; }
    return null;
  };

  // The list, with filters. Contacts come along in one query, so the list can show who leads each area.
  router.get('/', async (req, res) => {
    const where = []; const args = [];
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q) { where.push('(p.name LIKE ? OR p.town LIKE ? OR EXISTS (SELECT 1 FROM prospect_contacts c WHERE c.prospect_id = p.id AND c.name LIKE ?))'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (req.query.stage === 'open') { where.push(`p.stage IN (${P.OPEN_STAGES.map(() => '?').join(', ')})`); args.push(...P.OPEN_STAGES); } else if (P.STAGE_KEYS.includes(req.query.stage)) { where.push('p.stage = ?'); args.push(req.query.stage); }
    if (/^[A-Za-z]{2}$/.test(String(req.query.state || ''))) { where.push('p.state = ?'); args.push(String(req.query.state).toUpperCase()); }
    if (req.query.region) { where.push('p.region = ?'); args.push(String(req.query.region).slice(0, 60)); }
    if (['1', '2', '3'].includes(String(req.query.priority))) { where.push('p.priority = ?'); args.push(Number(req.query.priority)); }
    if (req.query.due === '1') where.push('p.next_on IS NOT NULL AND p.next_on <= CURRENT_DATE()');
    const list = await rows(pool, `SELECT p.* FROM prospects p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.priority, (p.next_on IS NULL), p.next_on, p.state, p.name LIMIT 1000`, args);
    const ids = list.map((p) => p.id);
    const contacts = ids.length ? await rows(pool, `SELECT id, prospect_id, role, name, title, email, phone FROM prospect_contacts WHERE prospect_id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`, ids) : [];
    const byId = new Map(ids.map((id) => [id, []]));
    for (const c of contacts) byId.get(c.prospect_id).push(c);
    const stats = await rows(pool, 'SELECT stage, COUNT(*) AS n FROM prospects GROUP BY stage');
    const [[due]] = await pool.query('SELECT COUNT(*) AS n FROM prospects WHERE next_on IS NOT NULL AND next_on <= CURRENT_DATE()');
    const regions = (await rows(pool, 'SELECT DISTINCT region FROM prospects WHERE region IS NOT NULL ORDER BY region')).map((r) => r.region);
    const states = (await rows(pool, 'SELECT DISTINCT state FROM prospects WHERE state IS NOT NULL ORDER BY state')).map((r) => r.state);
    res.json({
      data: list.map((p) => {
        const cs = byId.get(p.id);
        const lead = leaderOf(cs);
        return { ...P.shape(p), contact_count: cs.length, leader: lead ? { name: lead.name, title: lead.title, role: lead.role } : null };
      }),
      stages: P.STAGES, roles: P.ROLES, note_kinds: P.NOTE_KINDS, patrol_kinds: P.PATROL_KINDS,
      counts: Object.fromEntries(stats.map((r) => [r.stage, Number(r.n)])), due: Number(due.n), regions, states,
    });
  });

  // Everything, one row per contact (a prospect with no contacts gets one row), for a spreadsheet or a mail merge.
  router.get('/export.csv', async (_req, res) => {
    const data = await rows(pool, `SELECT p.*, c.role AS c_role, c.name AS c_name, c.title AS c_title, c.email AS c_email, c.phone AS c_phone, c.source_url AS c_source
      FROM prospects p LEFT JOIN prospect_contacts c ON c.prospect_id = p.id ORDER BY p.priority, p.state, p.name, c.id`);
    const stage = Object.fromEntries(P.STAGES); const role = Object.fromEntries(P.ROLES);
    const head = ['Ski area', 'State', 'Town', 'Region', 'Stage', 'Priority', 'Next step', 'Next step on', 'Website', 'Main phone', 'Ownership', 'Indy Pass', 'Vertical (ft)', 'Lifts', 'Trails', 'Acres', 'Patrol', 'Software today', 'Why they fit', 'Contact role', 'Contact name', 'Title', 'Email', 'Phone', 'Source'];
    const lines = data.map((r) => [r.name, r.state, r.town, r.region, stage[r.stage] || r.stage, r.priority, r.next_step, r.next_on, r.website, r.phone, r.ownership,
        r.indy_pass === null ? '' : r.indy_pass ? 'Yes' : 'No', r.vertical_ft, r.lifts, r.trails, r.acres, r.patrol,
        (P.shape(r).software || []).map((x) => [x.area, x.vendor].filter(Boolean).join(': ')).join('; '), r.fit_notes,
        r.c_role ? role[r.c_role] || r.c_role : '', r.c_name, r.c_title, r.c_email, r.c_phone, r.c_source].map(cell).join(','));
    const csv = [head.map(cell).join(','), ...lines].join('\r\n');
    res.set('content-type', 'text/csv; charset=utf-8').set('content-disposition', 'attachment; filename="verdynt-prospects.csv"').send(csv);
  });

  // A research batch in the db/data/prospects-*.json format: { prospects: [...] } or the list itself.
  router.post('/import', async (req, res) => {
    const list = Array.isArray(req.body) ? req.body : req.body && Array.isArray(req.body.prospects) ? req.body.prospects : null;
    if (!list || !list.length) throw bad('That file has no prospects in it. It needs a list of ski areas, each with at least a name.');
    if (list.length > 2000) throw bad('Up to 2,000 ski areas at a time');
    const r = await P.importBatch(pool, list, { checkedOn: (req.body && req.body.checked_on) || null });
    await log(pool, req, null, 'prospects_import', r);
    res.json(r);
  });

  router.post('/', validate(z.object(prospectFields)), async (req, res) => {
    const b = req.body;
    const [[dupe]] = await pool.query('SELECT id FROM prospects WHERE name = ? AND state <=> ?', [b.name, b.state ?? null]);
    if (dupe) throw bad(`${b.name} is already on the list`);
    if (b.indy_pass === true) throw bad('Indy Pass resorts are left off the prospect list');
    const cols = Object.keys(b).filter((k) => b[k] !== undefined);
    const [r] = await pool.query(`INSERT INTO prospects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => (k === 'indy_pass' && b[k] !== null ? (b[k] ? 1 : 0) : b[k])));
    await log(pool, req, null, 'prospect_add', { id: r.insertId, name: b.name });
    res.status(201).json({ id: r.insertId });
  });

  router.get('/:id', async (req, res) => {
    const p = await one(pool, 'SELECT p.*, t.slug AS tenant_slug FROM prospects p LEFT JOIN tenants t ON t.id = p.tenant_id WHERE p.id = ?', [paramId(req)]);
    if (!p) throw notFound('Prospect');
    const contacts = await rows(pool, 'SELECT * FROM prospect_contacts WHERE prospect_id = ? ORDER BY FIELD(role, ?), id', [p.id, P.ROLE_KEYS]);
    const notes = await rows(pool, 'SELECT * FROM prospect_notes WHERE prospect_id = ? ORDER BY id DESC LIMIT 200', [p.id]);
    // A website lead from the same mountain, so a walkthrough request is not missed.
    const leads = await rows(pool, 'SELECT id, created_at, kind, name, email, status FROM site_leads WHERE mountain LIKE ? ORDER BY id DESC LIMIT 5', [`%${p.name.replace(/\(.*$/, '').trim().split(/\s+/).slice(0, 2).join(' ')}%`]).catch(() => []);
    // Each person's outreach, if any (the latest sequence for their address).
    const outreach = await rows(pool, 'SELECT id, contact_id, status, step, next_at, stop_reason FROM outreach_sequences WHERE prospect_id = ? ORDER BY id', [p.id]).catch(() => []);
    for (const c of contacts) c.outreach = outreach.filter((o) => o.contact_id === c.id).pop() || null;
    res.json({ ...P.shape(p), contacts, notes, leads });
  });

  router.patch('/:id', validate(z.object(prospectFields).partial()), async (req, res) => {
    const b = req.body;
    const set = Object.keys(b).filter((k) => b[k] !== undefined);
    if (!set.length) throw bad('Nothing to change');
    const before = await one(pool, 'SELECT id, name, stage FROM prospects WHERE id = ?', [paramId(req)]);
    if (!before) throw notFound('Prospect');
    await pool.query(`UPDATE prospects SET ${set.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...set.map((k) => (k === 'indy_pass' && b[k] !== null ? (b[k] ? 1 : 0) : b[k])), before.id]);
    // A stage change goes on the timeline by itself, so the history reads without anyone writing it up.
    if (b.stage && b.stage !== before.stage) await require('../lib/outreach').stopForProspect(pool, before.id, b.stage); // talking or done: outreach stops
    if (b.stage && b.stage !== before.stage) {
      const name = Object.fromEntries(P.STAGES);
      await pool.query('INSERT INTO prospect_notes (prospect_id, kind, body, actor) VALUES (?, ?, ?, ?)', [before.id, 'stage', `${name[before.stage] || before.stage} → ${name[b.stage]}`, req.operator || null]);
    }
    await log(pool, req, null, 'prospect_edit', { id: before.id, name: before.name, fields: set });
    res.json({ ok: true });
  });

  router.delete('/:id', async (req, res) => {
    const p = await one(pool, 'SELECT id, name FROM prospects WHERE id = ?', [paramId(req)]);
    if (!p) throw notFound('Prospect');
    await pool.query('DELETE FROM prospects WHERE id = ?', [p.id]);
    await log(pool, req, null, 'prospect_remove', p);
    res.json({ ok: true });
  });

  router.post('/:id/contacts', validate(z.object(contactFields)), async (req, res) => {
    const p = await one(pool, 'SELECT id, name FROM prospects WHERE id = ?', [paramId(req)]);
    if (!p) throw notFound('Prospect');
    const b = req.body;
    if (!b.name && !b.email && !b.phone) throw bad('Give a name, an email or a phone number');
    const [r] = await pool.query('INSERT INTO prospect_contacts (prospect_id, role, name, title, email, phone, source_url, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [p.id, b.role, b.name ?? null, b.title ?? null, b.email ?? null, b.phone ?? null, b.source_url ?? null, b.note ?? null]);
    await log(pool, req, null, 'prospect_contact_add', { prospect: p.id, contact: r.insertId });
    res.status(201).json({ id: r.insertId });
  });

  router.patch('/:id/contacts/:cid', validate(z.object(contactFields).partial()), async (req, res) => {
    const cid = Number(req.params.cid);
    if (!Number.isInteger(cid) || cid < 1) throw notFound('Contact');
    const set = Object.keys(req.body).filter((k) => req.body[k] !== undefined);
    if (!set.length) throw bad('Nothing to change');
    const [r] = await pool.query(`UPDATE prospect_contacts SET ${set.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND prospect_id = ?`, [...set.map((k) => req.body[k]), cid, paramId(req)]);
    if (!r.affectedRows) throw notFound('Contact');
    await log(pool, req, null, 'prospect_contact_edit', { prospect: paramId(req), contact: cid, fields: set });
    res.json({ ok: true });
  });

  router.delete('/:id/contacts/:cid', async (req, res) => {
    const [r] = await pool.query('DELETE FROM prospect_contacts WHERE id = ? AND prospect_id = ?', [Number(req.params.cid) || 0, paramId(req)]);
    if (!r.affectedRows) throw notFound('Contact');
    await log(pool, req, null, 'prospect_contact_remove', { prospect: paramId(req), contact: Number(req.params.cid) });
    res.json({ ok: true });
  });

  router.post('/:id/notes', validate(z.object({ kind: z.enum(P.NOTE_KINDS).default('note'), body: s(4000).min(1, 'Write the note') })), async (req, res) => {
    const p = await one(pool, 'SELECT id FROM prospects WHERE id = ?', [paramId(req)]);
    if (!p) throw notFound('Prospect');
    const [r] = await pool.query('INSERT INTO prospect_notes (prospect_id, kind, body, actor) VALUES (?, ?, ?, ?)', [p.id, req.body.kind, req.body.body, req.operator || null]);
    // Logging a call, email or meeting moves a prospect still being researched to Contacted.
    if (['call', 'email', 'meeting', 'demo', 'visit'].includes(req.body.kind)) await pool.query("UPDATE prospects SET stage = 'contacted' WHERE id = ? AND stage IN ('research', 'to_contact')", [p.id]);
    res.status(201).json({ id: r.insertId });
  });

  return router;
};
