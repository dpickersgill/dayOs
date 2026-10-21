'use strict';

// The apps a mountain can have, and which parts of the API belong to each.
// A mountain with no saved choice has every app on. The platform operator turns apps off per mountain.
const { pool } = require('../db');
const { AppError } = require('./errors');

// paths are matched against the API path after /api/v1 (for example /rentals/items).
const MODULES = [
  { key: 'sell', label: 'Sell', blurb: 'Point of sale: tickets, passes, orders, gift cards and refunds.', needs: ['catalog'], paths: ['/checkout', '/gift-cards', '/orders', '/passes'] },
  { key: 'catalog', label: 'Products and prices', blurb: 'The product list, promo codes and price rules.', paths: ['/products', '/pricing'] },
  { key: 'gate', label: 'Gate', blurb: 'Scanning lift tickets and passes at the gate: barcodes, RFID cards and gate hardware.', paths: ['/tickets', '/access'] },
  { key: 'conditions', label: 'Lifts and trails', blurb: 'Lift and trail status, grooming, snow and weather, maintenance and daily reports.', paths: ['/schedule', '/ops'] },
  { key: 'assets', label: 'Assets and fleet (add-on)', blurb: 'The asset register for the fleet, lifts, snowmaking and buildings: meters, fuel, inspections, parts and stock, purchase orders, costs and QR tags. Off until the operator turns it on for a mountain.', addon: true, needs: ['conditions'], paths: ['/assets'] },
  { key: 'park', label: 'Terrain park', blurb: 'Park features, areas and the park map.', paths: ['/park'] },
  { key: 'rentals', label: 'Rentals', blurb: 'Rental equipment and contracts.', paths: ['/rentals'] },
  { key: 'school', label: 'Ski school', blurb: 'Lessons, instructors, students, credits and online lesson requests.', paths: ['/skischool'] },
  { key: 'programs', label: 'Clubs and programs', blurb: 'Clubs, camps, leagues and their sessions.', paths: ['/programs'] },
  { key: 'availability', label: 'Instructor availability', blurb: 'Instructors post open dates and times, with an optional public page.', paths: ['/availability'] },
  { key: 'patrol', label: 'Patrol', blurb: 'Incidents, dispatch, checklists, follow-up, training and the guest help page.', paths: ['/patrol'] },
  { key: 'documents', label: 'Documents', blurb: 'Files by category with versions, search and read-and-accepted tracking.', paths: ['/documents'] },
  { key: 'doc_ocr', label: 'Document text recognition (add-on)', blurb: 'Reads the words in scanned PDFs and pictures so they can be searched. Off until the operator turns it on for a mountain.', addon: true, needs: ['documents'], paths: [] },
  { key: 'messages', label: 'Messages', blurb: 'Email and text messages to customers who agreed to hear from you, and automatic rental and pass reminders.', paths: ['/messages'] },
  { key: 'shop', label: 'Online shop', blurb: 'A public page where guests buy lift tickets and passes by card, and the list of those orders.', needs: ['catalog'], paths: ['/online-shop'] },
  { key: 'money', label: 'Money', blurb: 'Tax rules, till, card reconciliation and exports.', paths: ['/tax-rules', '/till', '/reconcile', '/exports'] },
  { key: 'workforce', label: 'Staff and schedule', blurb: 'Staff, shifts, certifications, time clock and the kiosk tablets.', paths: ['/workforce', '/kiosk-admin'] },
];
const KEYS = MODULES.map((m) => m.key);
// Paid add-ons start off: a mountain has one only when its operator has turned it on.
const DEFAULTS = Object.fromEntries(MODULES.map((m) => [m.key, !m.addon]));
const BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));

// Reference data other apps read: the lift and trail list is open to anyone who has an app that uses it.
// A patrol on its own (Patrol on, Lifts and trails off) still keeps its list of runs and lifts.
const SHARED_WRITES = [{ re: /^\/schedule\/(lifts|trails)(\/|$)/, any: ['patrol'] }];
const SHARED_READS = [
  { re: /^\/schedule\/(lifts|trails|days|events)(\/|$)/, any: ['conditions', 'patrol', 'park', 'gate'] },
  { re: /^\/(products|pricing)(\/|$)/, any: ['catalog', 'sell', 'rentals', 'school', 'programs'] },
];

// Public pages, by the word after the mountain's web name.
const PUBLIC = { conditions: 'conditions', booking: 'school', quote: 'school', requests: 'school', 'instructor-availability': 'availability', help: 'patrol', give: 'patrol', shop: 'shop' };

/** Turning one app on turns on what it needs; turning one off turns off what needs it. */
function settle(want) {
  const on = new Set(KEYS.filter((k) => (BY_KEY[k].addon ? want[k] === true : want[k] !== false)));
  for (const k of [...on]) for (const n of BY_KEY[k].needs || []) on.add(n);
  for (const k of Object.keys(want)) if (want[k] === false) { // an explicit off wins, and takes dependents with it
    on.delete(k);
    for (const m of MODULES) if ((m.needs || []).includes(k)) on.delete(m.key);
  }
  return KEYS.filter((k) => on.has(k));
}

/** Apply a set of on/off requests to a mountain's current choices; what an app needs (or what needs it) moves with it. */
function apply(current, changes) {
  const want = { ...DEFAULTS, ...current };
  const turn = (k, on) => {
    if (want[k] === on) return;
    want[k] = on;
    if (on) for (const n of BY_KEY[k].needs || []) turn(n, true);
    else for (const m of MODULES) if ((m.needs || []).includes(k)) turn(m.key, false);
  };
  for (const [k, v] of Object.entries(changes)) turn(k, Boolean(v));
  return settle(want);
}

const cache = new Map(); // tenant id -> { at, status, on:Set }
const TTL = Number(process.env.MODULE_CACHE_MS ?? 10000);
const invalidate = (tenantId) => { if (tenantId === undefined) cache.clear(); else cache.delete(Number(tenantId)); };

async function stateOf(tenantId) {
  const id = Number(tenantId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const [[t]] = await pool.query('SELECT status FROM tenants WHERE id = ?', [id]);
  const [rows] = await pool.query('SELECT module, enabled FROM tenant_modules WHERE tenant_id = ?', [id]);
  const want = {}; for (const r of rows) want[r.module] = Boolean(r.enabled);
  const state = { at: Date.now(), status: t ? t.status : 'missing', on: new Set(settle(want)) };
  cache.set(id, state);
  return state;
}
const enabledKeys = async (tenantId) => { const { on } = await stateOf(tenantId); return KEYS.filter((k) => on.has(k)); };

const off = (module) => { const e = new AppError(403, `${BY_KEY[module].label} is not turned on for your mountain`); e.details = { code: 'module_disabled', module }; return e; };

function moduleFor(path) {
  for (const m of MODULES) for (const p of m.paths) if (path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}.`)) return m.key;
  return null;
}

/** Signed-in requests: refuse the ones that belong to an app this mountain has turned off. */
function moduleGate(req, _res, next) {
  (async () => {
    const path = req.path;
    const key = moduleFor(path);
    if (!key) return;
    const { on } = await stateOf(req.auth.tenantId);
    if (on.has(key)) return;
    if (req.method === 'GET') { const shared = SHARED_READS.find((s) => s.re.test(path)); if (shared && shared.any.some((k) => on.has(k))) return; }
    else { const shared = SHARED_WRITES.find((s) => s.re.test(path)); if (shared && shared.any.some((k) => on.has(k))) return; }
    throw off(key);
  })().then(() => next(), next);
}

/** Public pages: /public/<mountain>/<page>. A paused mountain or a switched-off app looks like a page that does not exist. */
function publicGate(req, _res, next) {
  (async () => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts[0] === 'followup') return; // checked once the link's mountain is known
    const slug = parts[0]; const module = PUBLIC[parts[1]];
    if (!module) return;
    if (slug) {
      const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
      if (!t) return; // the page itself answers "not found"
      const s = await stateOf(t.id);
      if (s.status !== 'active' || !s.on.has(module)) throw new AppError(404, 'Page not found');
      // A mountain whose Verdynt/OS subscription has lapsed takes no online orders or bookings (waivers and help still work).
      if (['shop', 'school'].includes(module) && await require('./billing').publicBlocked(t.id, req.method)) throw new AppError(409, 'This mountain is not taking online orders right now. Please contact them directly.');
    }
  })().then(() => next(), next);
}

/** For code that already knows the mountain (a tablet, a follow-up link). */
async function requireModule(tenantId, module) {
  const s = await stateOf(tenantId);
  if (s.status !== 'active') throw new AppError(403, 'This mountain is paused');
  if (!s.on.has(module)) throw off(module);
}

module.exports = { MODULES, KEYS, settle, apply, invalidate, stateOf, enabledKeys, moduleGate, publicGate, requireModule, moduleFor };
