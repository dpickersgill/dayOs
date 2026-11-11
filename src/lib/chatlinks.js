'use strict';

// Links to records inside an Inbox message. A message stores only { type, id }. When someone reads the message, each
// link is looked up for that reader with the same rules as the page it opens: a counter login sees a link to a patrol
// case as "a patrol case you cannot open", never its title. A record that was removed shows as gone.

const { pool, rows } = require('../db');
const M = require('./modules');
const { audit } = require('./audit');
const PA = require('./patrolaccess');

const role = (req) => req.auth.role;
const is = (req, ...roles) => role(req) === 'owner' || roles.includes(role(req));
const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;

// Each type: label, the app page it opens, who may open it, and how to title a batch of them.
const TYPES = {
  patrol_case: {
    label: 'Patrol case', path: (id) => `#/patrol/case/${id}`, module: 'patrol',
    allowed: async (req) => is(req, 'patrol', 'manager') && PA.can(pool, req, 'view_cases'),
    titles: async (t, ids) => rows(pool, "SELECT id, CONCAT('Case ', COALESCE(CONCAT(season, '-', LPAD(seq, 4, '0')), id)) AS title, CONCAT(UPPER(LEFT(category, 1)), SUBSTRING(REPLACE(category, '_', ' '), 2), ' · ', DATE_FORMAT(occurred_at, '%b %e')) AS subtitle FROM incidents WHERE tenant_id = ? AND id IN (?)", [t, ids]),
  },
  asset: {
    label: 'Asset', path: (id) => `#/assets/a/${id}`, module: 'assets',
    allowed: async (req) => is(req, 'staff', 'manager'),
    titles: async (t, ids) => rows(pool, "SELECT id, name AS title, CONCAT_WS(' · ', asset_tag, make_model) AS subtitle FROM ops_assets WHERE tenant_id = ? AND id IN (?)", [t, ids]),
  },
  work_order: {
    // Either app opens work orders (lib/modules.js): Lifts and trails, or Assets and fleet (a municipality's Work orders).
    label: 'Work order', path: (id) => `#/conditions/wo/${id}`, module: ['conditions', 'assets'],
    allowed: async (req) => is(req, 'staff', 'manager', 'patrol'),
    titles: async (t, ids) => rows(pool, "SELECT id, title, CONCAT(UPPER(LEFT(status, 1)), REPLACE(SUBSTRING(status, 2), '_', ' '), ' · ', priority, ' priority') AS subtitle FROM work_orders WHERE tenant_id = ? AND id IN (?)", [t, ids]),
  },
  customer: {
    label: 'Customer', path: (id) => `#/people/${id}`,
    allowed: async (req) => is(req, 'manager', 'counter', 'instructor'),
    titles: async (t, ids) => rows(pool, "SELECT id, TRIM(CONCAT(first_name, ' ', last_name)) AS title, 'Customer' AS subtitle FROM people WHERE tenant_id = ? AND id IN (?)", [t, ids]),
  },
  order: {
    label: 'Order', path: (id) => `#/sell/order/${id}`, module: 'sell',
    allowed: async (req) => is(req, 'counter', 'manager'),
    titles: async (t, ids) => rows(pool, "SELECT o.id, CONCAT('Order #', o.id) AS title, CONCAT_WS(' · ', NULLIF(TRIM(CONCAT(COALESCE(p.first_name, ''), ' ', COALESCE(p.last_name, ''))), ''), DATE_FORMAT(o.created_at, '%b %e'), o.status) AS subtitle, o.total_cents FROM orders o LEFT JOIN people p ON p.tenant_id = o.tenant_id AND p.id = o.person_id WHERE o.tenant_id = ? AND o.id IN (?)", [t, ids]),
    after: (r) => ({ ...r, subtitle: `${money(r.total_cents)} · ${r.subtitle}`, total_cents: undefined }),
  },
  waiver: {
    label: 'Waiver', path: (id) => `#/waivers/w/${id}`,
    allowed: async (req) => is(req, 'manager', 'counter', 'instructor'),
    titles: async (t, ids) => rows(pool, "SELECT w.id, CONCAT('Waiver: ', p.first_name, ' ', p.last_name) AS title, CONCAT('Signed ', DATE_FORMAT(w.signed_at, '%b %e, %Y'), ' · ', w.season) AS subtitle FROM waivers w JOIN people p ON p.tenant_id = w.tenant_id AND p.id = w.person_id WHERE w.tenant_id = ? AND w.id IN (?)", [t, ids]),
  },
  document: {
    label: 'Document', path: (id) => `#/documents/d/${id}`, module: 'documents',
    allowed: async () => true, // checked per document below: its category decides
    titles: async (t, ids, req) => {
      const docs = await rows(pool, 'SELECT id, title, category_id, file_name FROM documents WHERE tenant_id = ? AND id IN (?)', [t, ids]);
      if (is(req, 'manager')) return docs.map((d) => ({ id: d.id, title: d.title, subtitle: d.file_name || 'Link' }));
      const ok = new Set((await rows(pool, 'SELECT category_id FROM doc_category_roles WHERE tenant_id = ? AND role = ?', [t, role(req)])).map((r) => r.category_id));
      const out = docs.map((d) => (ok.has(d.category_id) ? { id: d.id, title: d.title, subtitle: d.file_name || 'Link' } : { id: d.id, denied: true }));
      // a missing document looks the same as one you may not see, so links cannot be used to find out what exists
      for (const id of ids) if (!docs.some((d) => Number(d.id) === id)) out.push({ id, denied: true });
      return out;
    },
  },
  // muni release 1: a resident's request, by its reference and what it is about; never the resident.
  resident_request: {
    label: 'Resident request', path: (id) => `#/requests/r/${id}`, module: 'requests',
    allowed: async (req) => is(req, 'staff', 'counter', 'manager'),
    titles: async (t, ids) => rows(pool, "SELECT r.id, CONCAT('Request ', r.reference) AS title, CONCAT_WS(' · ', c.name, s.name) AS subtitle FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id LEFT JOIN streets s ON s.tenant_id = r.tenant_id AND s.id = r.street_id WHERE r.tenant_id = ? AND r.id IN (?)", [t, ids]),
  },
};
const TYPE_KEYS = Object.keys(TYPES);

/** The app address a link opens, to recognize links pasted into a message. Returns { type, id } or null. */
const PATTERNS = [
  [/#\/patrol\/case\/(\d+)/, 'patrol_case'], [/#\/assets\/a\/(\d+)/, 'asset'], [/#\/conditions\/wo\/(\d+)/, 'work_order'],
  [/#\/people\/(\d+)/, 'customer'], [/#\/requests\/r\/(\d+)/, 'resident_request'], [/#\/sell\/order\/(\d+)/, 'order'], [/#\/waivers\/w\/(\d+)/, 'waiver'], [/#\/documents\/d\/(\d+)/, 'document'],
];

/** Look up a list of links for one reader: [{ type, id, label, path, title?, subtitle?, state: 'ok' | 'no_access' | 'gone' }]. */
async function resolve(req, refs) {
  const t = req.auth.tenantId;
  const { on } = await M.stateOf(t);
  const out = new Map();
  const byType = new Map();
  for (const r of refs) { if (!TYPES[r.type]) continue; if (!byType.has(r.type)) byType.set(r.type, new Set()); byType.get(r.type).add(Number(r.id)); }
  for (const [type, idSet] of byType) {
    const def = TYPES[type];
    const ids = [...idSet];
    const base = (id) => ({ type, id, label: def.label, path: def.path(id) });
    const canOpen = (!def.module || [].concat(def.module).some((m) => on.has(m))) && await def.allowed(req);
    if (!canOpen) { for (const id of ids) out.set(`${type}:${id}`, { ...base(id), state: 'no_access' }); continue; }
    const found = new Map((await def.titles(t, ids, req)).map((r) => [Number(r.id), def.after ? def.after(r) : r]));
    for (const id of ids) {
      const r = found.get(id);
      if (!r) out.set(`${type}:${id}`, { ...base(id), state: 'gone' });
      else if (r.denied) out.set(`${type}:${id}`, { ...base(id), state: 'no_access' });
      else out.set(`${type}:${id}`, { ...base(id), state: 'ok', title: r.title, subtitle: r.subtitle || null });
      // a patrol case's summary is part of the case record: seeing it in a message is logged like opening the case
      if (r && !r.denied && type === 'patrol_case') await audit(pool, req, 'view_link', 'incidents', id);
    }
  }
  return refs.map((r) => out.get(`${r.type}:${Number(r.id)}`)).filter(Boolean);
}

module.exports = { TYPES, TYPE_KEYS, PATTERNS, resolve };
