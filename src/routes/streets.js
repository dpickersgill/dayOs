'use strict';

// A municipality's street list (muni release 1, the Resident requests app). Requests (where the problem is), bulk pickup
// (the address) and street notices (which streets a water break affects) all pick from it, so a street is one row
// however residents spell it: its other spellings are its aliases ("Main St, Main"). A street is never deleted, only
// marked not in use, so old requests keep their street.
//
// Signed in (mounted at /api/v1/requests/streets, gated with the requests app): everyone reads; managers add, rename,
// mark not in use and import (one street per line, or CSV with name,aliases).
// Public: GET /api/v1/public/<slug>/streets lists the names in use, and nothing else (the public report and booking forms).
const express = require('express');
const { pool, tx, rows, one } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { bad, notFound, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');

const router = express.Router();
const publicRouter = express.Router();
const managers = requireRole('manager');

/** One spelling for a name: trimmed, single spaces. */
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** Aliases as one line, "a, b": trimmed, no repeats, no empties, never the name itself. */
function tidyAliases(s, name) {
  if (s === null || s === undefined) return null;
  const seen = new Set([tidy(name).toLowerCase()]);
  const out = [];
  for (const a of String(s).split(/[,;]/).map(tidy).filter(Boolean)) { if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); out.push(a); } }
  const text = out.join(', ');
  if (text.length > 255) throw bad('Other spellings are too long: keep them under 255 characters');
  return text || null;
}
const nameField = z.string().transform(tidy).pipe(z.string().min(2, 'Give the street a name').max(120, 'Keep the street name under 120 characters'));
const shape = (r) => ({ id: Number(r.id), name: r.name, aliases: r.aliases || null, active: Boolean(r.active) });
const taken = (name) => conflict(`There is already a street called ${name}`);

router.get('/', async (req, res) => {
  const all = req.query.all === '1';
  const data = await rows(pool, `SELECT id, name, aliases, active FROM streets WHERE tenant_id = ? ${all ? '' : 'AND active = 1'} ORDER BY name`, [req.auth.tenantId]);
  res.json({ data: data.map(shape) });
});

router.post('/', managers, validate(z.object({ name: nameField, aliases: z.string().max(400).nullable().optional() })), async (req, res) => {
  const { name } = req.body;
  try {
    const [r] = await pool.query('INSERT INTO streets (tenant_id, name, aliases) VALUES (?, ?, ?)', [req.auth.tenantId, name, tidyAliases(req.body.aliases, name)]);
    await audit(pool, req, 'create', 'streets', r.insertId, { name });
    res.status(201).json({ id: r.insertId });
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw taken(name); throw e; }
});

/** Rename, change the other spellings, or mark in use or not in use. */
router.patch('/:id', managers, validate(z.object({ name: nameField.optional(), aliases: z.string().max(400).nullable().optional(), active: z.boolean().optional() })), async (req, res) => {
  const id = paramId(req);
  const cur = await one(pool, 'SELECT id, name FROM streets WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!cur) throw notFound('Street');
  const set = {};
  if (req.body.name !== undefined) set.name = req.body.name;
  if (req.body.aliases !== undefined) set.aliases = tidyAliases(req.body.aliases, set.name || cur.name);
  if (req.body.active !== undefined) set.active = req.body.active ? 1 : 0;
  if (!Object.keys(set).length) throw bad('Nothing to change');
  try {
    await pool.query(`UPDATE streets SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...Object.values(set), req.auth.tenantId, id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw taken(set.name); throw e; }
  await audit(pool, req, req.body.active === false ? 'deactivate' : 'update', 'streets', id, { ...set, ...(set.name ? { was: cur.name } : {}) });
  res.json({ ok: true });
});

/** One CSV line into its cells: commas split, "quoted, cells" keep theirs, "" is a quote. */
function csvCells(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The streets in a pasted list: one street per line, or CSV with name,aliases (a first line "name,aliases" is a heading).
 * Returns [{ name, aliases }]. A line with a comma is read as CSV only when csv is true, since a pasted street name never
 * holds one.
 */
function parseList(text, csv) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const [i, line] of lines.entries()) {
    const cells = csv ? csvCells(line) : [line];
    const name = tidy(cells[0]);
    if (i === 0 && csv && /^(street ?)?name$/i.test(name)) continue; // the heading
    if (!name) continue;
    out.push({ name, aliases: csv ? cells.slice(1).map(tidy).filter(Boolean).join(', ') || null : null });
  }
  return out;
}

/**
 * Add many at once. A street already on the list is put back in use and gains any new spellings; nothing is removed.
 * Returns { added, updated, unchanged, skipped: [{ line, why }] }.
 */
router.post('/import', managers, validate(z.object({ text: z.string().max(200000), format: z.enum(['lines', 'csv']).default('lines') })), async (req, res) => {
  const list = parseList(req.body.text, req.body.format === 'csv');
  if (!list.length) throw bad('Paste at least one street, one per line');
  if (list.length > 5000) throw bad('That is more than 5,000 streets. Import them in parts.');
  const out = await tx(async (conn) => {
    const have = new Map((await rows(conn, 'SELECT id, name, aliases, active FROM streets WHERE tenant_id = ? FOR UPDATE', [req.auth.tenantId])).map((r) => [r.name.toLowerCase(), r]));
    const counts = { added: 0, updated: 0, unchanged: 0, skipped: [] };
    for (const s of list) {
      if (s.name.length < 2 || s.name.length > 120) { counts.skipped.push({ line: s.name.slice(0, 120), why: 'A street name is 2 to 120 characters' }); continue; }
      const cur = have.get(s.name.toLowerCase());
      if (!cur) {
        const aliases = tidyAliases(s.aliases, s.name);
        const [r] = await conn.query('INSERT INTO streets (tenant_id, name, aliases) VALUES (?, ?, ?)', [req.auth.tenantId, s.name, aliases]);
        have.set(s.name.toLowerCase(), { id: r.insertId, name: s.name, aliases, active: 1 });
        counts.added += 1;
        continue;
      }
      const aliases = tidyAliases([cur.aliases, s.aliases].filter(Boolean).join(', '), cur.name);
      if (Number(cur.active) && (aliases || null) === (cur.aliases || null)) { counts.unchanged += 1; continue; }
      await conn.query('UPDATE streets SET aliases = ?, active = 1 WHERE tenant_id = ? AND id = ?', [aliases, req.auth.tenantId, cur.id]);
      cur.aliases = aliases; cur.active = 1;
      counts.updated += 1;
    }
    await audit(conn, req, 'import', 'streets', null, { added: counts.added, updated: counts.updated, skipped: counts.skipped.length });
    return counts;
  });
  res.json(out);
});

// ---------------------------------------------------------------- public
// The names in use, for the public report and booking forms. Only names: never who lives where.
publicRouter.get('/:slug/streets', async (req, res) => {
  const t = await one(pool, "SELECT id FROM tenants WHERE slug = ? AND status = 'active' AND org_type = 'municipality'", [req.params.slug]);
  if (!t) throw notFound('Page');
  const data = await rows(pool, 'SELECT name FROM streets WHERE tenant_id = ? AND active = 1 ORDER BY name', [t.id]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ streets: data.map((r) => r.name) });
});

module.exports = { router, publicRouter, parseList, tidyAliases };
