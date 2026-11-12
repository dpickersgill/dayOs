'use strict';

// Jump to, beyond pages (2026.11.20): the records a few letters can find. Mounted at /api/v1/jump, signed in.
//   GET /jump?q=hydrant     map items by tag, name or kind ("V-114", "hydrant"), assets by tag or name, work orders by
//                           number or words ("#212", "storm inlet"), requests by reference ("R-1042", "1042"), and, for
//                           managers, people on the staff list by name.
// Each kind of record is offered only when its app is on and the person's role opens that app's screen (the same rules
// as the menu: Assets, Work orders and Programs for the Crew and managers, Requests for Front desk, the Crew and
// managers, Staff and schedule for managers). Nothing here shows a resident's name, phone, email or house number.
const express = require('express');
const { pool, rows } = require('../db');
const { bad } = require('../lib/errors');
const M = require('../lib/modules');
const MF = require('../lib/mapfeatures');

const router = express.Router();
const EACH = 6; // results per kind of record

/** A LIKE pattern for text typed by a person: their % and _ are plain characters. */
const like = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

router.get('/', async (req, res) => {
  const t = req.auth.tenantId; const role = req.auth.role;
  const q = String(typeof req.query.q === 'string' ? req.query.q : '').trim();
  if (q.length > 60) throw bad('Type up to 60 letters');
  if (q.length < 2) return res.json({ data: [] });
  const { on, org } = await M.stateOf(t);
  const manager = role === 'owner' || role === 'manager';
  const crew = manager || role === 'staff';
  const desk = manager || role === 'counter' || role === 'staff';
  const muni = org === 'municipality';
  const words = `%${like(q)}%`; const starts = `${like(q)}%`;
  const out = [];

  if (on.has('assets') && crew) {
    // A kind is found by its name too ("hydrant" finds every fire hydrant), but only kinds this tenant may map.
    const kinds = MF.kindsFor(org, on).filter((k) => k.label.toLowerCase().includes(q.toLowerCase())).map((k) => k.key);
    const allowed = MF.kindsFor(org, on).map((k) => k.key);
    const feats = allowed.length ? await rows(pool, `SELECT id, kind, name, tag FROM map_features
      WHERE tenant_id = ? AND kind IN (?) AND status <> 'abandoned' AND (tag LIKE ? OR name LIKE ?${kinds.length ? ' OR kind IN (?)' : ''})
      ORDER BY (tag LIKE ?) DESC, tag, name, id LIMIT ${EACH}`, [t, allowed, starts, words, ...(kinds.length ? [kinds] : []), starts]) : [];
    for (const f of feats) {
      const k = MF.kindOf(f.kind);
      const label = k ? MF.labelFor(k, org) : f.kind;
      out.push({ type: 'feature', title: f.name || (f.tag ? `${label} ${f.tag}` : `${label} ${f.id}`), hint: f.name ? `${label}${f.tag ? ` ${f.tag}` : ''}, on the map` : 'On the map', href: `#/assets/map/f${f.id}` });
    }
    const assets = await rows(pool, `SELECT id, name, asset_tag FROM ops_assets WHERE tenant_id = ? AND status <> 'retired' AND (asset_tag LIKE ? OR name LIKE ?)
      ORDER BY (asset_tag LIKE ?) DESC, name, id LIMIT ${EACH}`, [t, starts, words, starts]);
    for (const a of assets) out.push({ type: 'asset', title: a.name, hint: a.asset_tag ? `Asset ${a.asset_tag}` : 'Asset', href: `#/assets/a/${a.id}` });
  }

  // Work orders have their own screen in the municipal edition (a ski area's are inside Mountain status).
  if (muni && on.has('assets') && crew) {
    const n = /^#?\s*(\d{1,9})$/.exec(q);
    const list = await rows(pool, `SELECT id, title, status FROM work_orders WHERE tenant_id = ? AND (${n ? 'id = ? OR ' : ''}title LIKE ?)
      ORDER BY (status IN ('done','cancelled')), id DESC LIMIT ${EACH}`, [t, ...(n ? [Number(n[1])] : []), words]);
    const STATUS = { open: 'open', in_progress: 'in progress', waiting_parts: 'waiting for parts', done: 'done', cancelled: 'canceled' };
    for (const w of list) out.push({ type: 'work_order', title: w.title, hint: `Work order #${w.id}, ${STATUS[w.status] || w.status}`, href: `#/works/${w.id}` });
  }

  if (muni && on.has('requests') && desk) {
    // "R-1042", "r1042", "1042", or the start of one ("R-10"): requests whose reference starts with it.
    const m = /^r\s*-?\s*(\d{2,8})$/i.exec(q) || /^(\d{4,8})$/.exec(q);
    const ref = m ? `R-${m[1]}` : null;
    if (ref) {
      // The reference, the category and the street: never the house number or the resident.
      const list = await rows(pool, `SELECT r.id, r.reference, c.name AS category, s.name AS street FROM requests r
        JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id LEFT JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id
        WHERE r.tenant_id = ? AND r.reference LIKE ? ORDER BY r.id DESC LIMIT ${EACH}`, [t, `${like(ref)}%`]);
      for (const r of list) out.push({ type: 'request', title: `${r.reference} ${r.category}`, hint: r.street ? `Request on ${r.street}` : 'Request', href: `#/requests/r/${r.id}` });
    }
  }

  if (on.has('workforce') && manager) {
    const list = await rows(pool, `SELECT s.id, p.first_name, p.last_name FROM staff s JOIN people p ON p.tenant_id = s.tenant_id AND p.id = s.person_id
      WHERE s.tenant_id = ? AND s.status IN ('active','onboarding') AND (CONCAT(p.first_name, ' ', p.last_name) LIKE ? OR p.last_name LIKE ?)
      ORDER BY p.last_name, p.first_name LIMIT ${EACH}`, [t, words, starts]);
    for (const s of list) out.push({ type: 'person', title: `${s.first_name} ${s.last_name}`.trim(), hint: 'Staff', href: `#/workforce/staff/${s.id}` });
  }
  res.json({ data: out });
});

module.exports = router;
