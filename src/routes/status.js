'use strict';

// The status page's API (2026.11.10, READY). See lib/status.js.
//   GET  /api/v1/status                    public: each part's state, open and planned notes, the last 90 days (JSON)
// The platform console (mounted at /platform/status, behind the console's sign-in; every change is in its Activity):
//   GET    /                               every note of the last 90 days and every planned one, with the live checks
//   POST   /                               a new incident or planned maintenance
//   PATCH  /:id                            change a note (an update to its text, its times, the parts, the impact)
//   POST   /:id/end                        mark it over now
//   DELETE /:id                            remove a note written by mistake
const express = require('express');
const { pool, one } = require('../db');
const { z, validate } = require('../lib/util');
const { notFound, bad } = require('../lib/errors');
const S = require('../lib/status');

async function publicStatus(_req, res) {
  res.set('Cache-Control', 'public, max-age=60');
  res.json(await S.snapshot());
}

const stamp = (s) => new Date(s).toISOString().slice(0, 19).replace('T', ' ');
const when = z.string().trim().refine((s) => !Number.isNaN(Date.parse(s)), 'Not a date and time');
const fields = {
  kind: z.enum(['incident', 'maintenance']),
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().max(4000).optional().default(''),
  parts: z.array(z.enum(S.PART_KEYS)).min(1).max(S.PART_KEYS.length),
  impact: z.enum(['none', 'slow', 'down']),
  starts_at: when,
  ends_at: when.nullable().optional(),
};
const createBody = z.object(fields);
const editBody = z.object(fields).partial();

function platformRouter(log) {
  const router = express.Router();

  router.get('/', async (_req, res) => {
    res.json({ parts: S.PARTS.map(([key, name, about]) => ({ key, name, about })), impacts: S.IMPACT, notes: await S.notes(), live: await S.checks() });
  });

  router.post('/', validate(createBody), async (req, res) => {
    const b = req.body;
    if (b.ends_at && Date.parse(b.ends_at) <= Date.parse(b.starts_at)) throw bad('The end must be after the start');
    const [r] = await pool.query('INSERT INTO status_notes (kind, title, body, parts, impact, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [b.kind, b.title, b.body || null, b.parts.join(','), b.impact, stamp(b.starts_at), b.ends_at ? stamp(b.ends_at) : null, req.operatorId || null]);
    await log(pool, req, null, 'status_note_add', { id: r.insertId, kind: b.kind, title: b.title });
    res.status(201).json({ id: r.insertId });
  });

  const load = async (req) => {
    const id = Number(req.params.id);
    const n = Number.isInteger(id) && id > 0 ? await one(pool, 'SELECT * FROM status_notes WHERE id = ?', [id]) : null;
    if (!n) throw notFound('Note');
    return n;
  };

  router.patch('/:id', validate(editBody), async (req, res) => {
    const n = await load(req);
    const b = req.body;
    const set = {};
    for (const k of ['kind', 'title', 'impact']) if (b[k] !== undefined) set[k] = b[k];
    if (b.body !== undefined) set.body = b.body || null;
    if (b.parts !== undefined) set.parts = b.parts.join(',');
    if (b.starts_at !== undefined) set.starts_at = stamp(b.starts_at);
    if (b.ends_at !== undefined) set.ends_at = b.ends_at ? stamp(b.ends_at) : null;
    if (!Object.keys(set).length) throw bad('Nothing to change');
    const start = set.starts_at || n.starts_at; const end = 'ends_at' in set ? set.ends_at : n.ends_at;
    if (end && Date.parse(`${String(end).replace(' ', 'T')}Z`) <= Date.parse(`${String(start).replace(' ', 'T')}Z`)) throw bad('The end must be after the start');
    await pool.query(`UPDATE status_notes SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(set), n.id]);
    await log(pool, req, null, 'status_note_edit', { id: n.id, fields: Object.keys(set) });
    res.json({ ok: true });
  });

  router.post('/:id/end', async (req, res) => {
    const n = await load(req);
    await pool.query('UPDATE status_notes SET ends_at = GREATEST(starts_at, UTC_TIMESTAMP()) WHERE id = ?', [n.id]);
    await log(pool, req, null, 'status_note_end', { id: n.id });
    res.json({ ok: true });
  });

  router.delete('/:id', async (req, res) => {
    const n = await load(req);
    await pool.query('DELETE FROM status_notes WHERE id = ?', [n.id]);
    await log(pool, req, null, 'status_note_remove', { id: n.id, title: n.title });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { publicStatus, platformRouter };
