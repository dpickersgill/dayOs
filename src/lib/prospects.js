'use strict';

// Prospects: the ski areas the Verdynt/OS team is selling to, in the platform console only. Mountains never see this.
// Each prospect has the area's facts (size, what it runs, who owns it, the software it uses today), the people to talk
// to, a stage in the sales pipeline, the next step with a date, and a timeline of notes.
//
// A research batch (a JSON file in the format of db/data/prospects-2026-10.json) is loaded once by the migration, and
// later batches can be imported from the console. Indy Pass partner resorts are never added. Importing never overwrites what an operator has changed: a known
// prospect (same name and state) only gets facts that are still empty, and contacts it does not have yet.

const STAGES = [
  ['research', 'To research'],
  ['to_contact', 'To contact'],
  ['contacted', 'Contacted'],
  ['talking', 'In conversation'],
  ['demo', 'Demo done'],
  ['trial', 'On a trial'],
  ['won', 'Customer'],
  ['lost', 'Not now'],
  ['not_fit', 'Not a fit'],
];
const STAGE_KEYS = STAGES.map(([k]) => k);
const OPEN_STAGES = ['research', 'to_contact', 'contacted', 'talking', 'demo', 'trial'];

const ROLES = [
  ['general_manager', 'General manager'],
  ['owner', 'Owner'],
  ['president', 'President or CEO'],
  ['operations', 'Operations'],
  ['mountain_manager', 'Mountain manager'],
  ['patrol_director', 'Patrol director'],
  ['ski_school_director', 'Ski school director'],
  ['rental_manager', 'Rental manager'],
  ['marketing', 'Marketing'],
  ['finance', 'Finance'],
  ['hr', 'HR'],
  ['it', 'IT'],
  ['other', 'Other'],
];
const ROLE_KEYS = ROLES.map(([k]) => k);
// Who runs the place, for the list's "Leader" column: the first of these the prospect has.
const LEADER_ORDER = ['general_manager', 'owner', 'president', 'mountain_manager', 'operations'];

const NOTE_KINDS = ['note', 'call', 'email', 'meeting', 'demo', 'visit'];
const PATROL_KINDS = ['NSP volunteer', 'paid', 'mixed'];
const OFFERS = ['ski_school', 'rentals', 'terrain_park', 'night_skiing', 'tubing', 'summer_ops'];

const str = (v, max) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const bool = (v) => (v === true ? 1 : v === false ? 0 : null);
const url = (v) => { const s = str(v, 500); return s && /^https?:\/\//i.test(s) ? s : null; };
const parse = (s, fallback) => { if (s === null || s === undefined) return fallback; try { return JSON.parse(s); } catch (_) { return fallback; } };

/** One prospect from a research file, as table columns. Unknown or odd values become empty rather than failing the batch. */
function fromResearch(p, { region = null, checkedOn = null } = {}) {
  const size = p.size || {};
  const offers = {};
  for (const k of OFFERS) if (p.offers && typeof p.offers[k] === 'boolean') offers[k] = p.offers[k];
  const software = Array.isArray(p.current_software) ? p.current_software.filter((s) => s && (s.vendor || s.area)).map((s) => ({ area: str(s.area, 60), vendor: str(s.vendor, 120) })).slice(0, 20) : [];
  const sources = Array.isArray(p.sources) ? p.sources.map(url).filter(Boolean).slice(0, 30) : [];
  const state = str(p.state, 2);
  return {
    name: str(p.name, 150),
    state: state ? state.toUpperCase() : null,
    town: str(p.town, 120),
    region: str(p.region || region, 60),
    website: url(p.website),
    phone: str(p.phone, 60),
    ownership: str(p.ownership, 600),
    indy_pass: bool(p.indy_pass),
    vertical_ft: num(size.vertical_ft),
    lifts: num(size.lifts),
    trails: num(size.trails),
    acres: num(size.skiable_acres ?? size.acres),
    offers: Object.keys(offers).length ? JSON.stringify(offers) : null,
    patrol: PATROL_KINDS.includes(p.patrol) ? p.patrol : null,
    software: software.length ? JSON.stringify(software) : null,
    fit_notes: str(p.fit_notes, 2000),
    sources: sources.length ? JSON.stringify(sources) : null,
    priority: [1, 2, 3].includes(Number(p.priority)) ? Number(p.priority) : 2,
    checked_on: /^\d{4}-\d{2}-\d{2}$/.test(String(p.checked_on || checkedOn || '')) ? (p.checked_on || checkedOn) : null,
  };
}

function contactFrom(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {
    role: ROLE_KEYS.includes(c.role) ? c.role : 'other',
    name: str(c.name, 120),
    title: str(c.title, 200),
    email: str(c.email, 200),
    phone: str(c.phone, 80),
    source_url: url(c.source_url),
  };
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) out.email = null;
  return out.name || out.email || out.phone ? out : null;
}

const FACTS = ['town', 'region', 'website', 'phone', 'ownership', 'indy_pass', 'vertical_ft', 'lifts', 'trails', 'acres', 'offers', 'patrol', 'software', 'fit_notes', 'sources', 'checked_on'];

/**
 * Adds a research batch. conn is a pool or a connection (anything with query). Returns { added, updated, contacts }.
 * A prospect already there (same name and state) keeps everything an operator set; only empty facts are filled, and only
 * contacts not there yet (same role and name, or same role and email when unnamed) are added.
 * Indy Pass partner resorts are left out: we do not sell to them (skipped counts them).
 */
async function importBatch(conn, list, { region = null, checkedOn = null } = {}) {
  let added = 0; let updated = 0; let contacts = 0; let skipped = 0;
  for (const raw of list) {
    const p = fromResearch(raw || {}, { region, checkedOn });
    if (!p.name) continue;
    if (p.indy_pass === 1) { skipped += 1; continue; }
    const [[have]] = await conn.query('SELECT * FROM prospects WHERE name = ? AND state <=> ?', [p.name, p.state]);
    let id;
    if (have) {
      id = have.id;
      const fill = FACTS.filter((k) => (have[k] === null || have[k] === '') && p[k] !== null);
      if (fill.length) {
        await conn.query(`UPDATE prospects SET ${fill.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...fill.map((k) => p[k]), id]);
        updated += 1;
      }
    } else {
      const cols = ['name', 'state', ...FACTS, 'priority', 'stage'];
      const vals = [p.name, p.state, ...FACTS.map((k) => p[k]), p.priority, 'research'];
      const [r] = await conn.query(`INSERT INTO prospects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
      id = r.insertId;
      added += 1;
    }
    const [existing] = await conn.query('SELECT role, name, email FROM prospect_contacts WHERE prospect_id = ?', [id]);
    const key = (c) => `${c.role}|${(c.name || '').toLowerCase()}|${c.name ? '' : (c.email || c.phone || '').toLowerCase()}`;
    const seen = new Set(existing.map(key));
    for (const rc of Array.isArray(raw.contacts) ? raw.contacts : []) {
      const c = contactFrom(rc);
      if (!c || seen.has(key(c))) continue;
      seen.add(key(c));
      await conn.query('INSERT INTO prospect_contacts (prospect_id, role, name, title, email, phone, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, c.role, c.name, c.title, c.email, c.phone, c.source_url]);
      contacts += 1;
    }
  }
  return { added, updated, contacts, skipped };
}

/** A prospect row as the console shows it. */
function shape(p) {
  return {
    ...p,
    indy_pass: p.indy_pass === null || p.indy_pass === undefined ? null : Boolean(p.indy_pass),
    offers: parse(p.offers, {}),
    software: parse(p.software, []),
    sources: parse(p.sources, []),
  };
}

module.exports = { STAGES, STAGE_KEYS, OPEN_STAGES, ROLES, ROLE_KEYS, LEADER_ORDER, NOTE_KINDS, PATROL_KINDS, OFFERS, fromResearch, contactFrom, importBatch, shape };
