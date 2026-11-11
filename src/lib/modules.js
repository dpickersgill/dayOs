'use strict';

// The apps a mountain can have, and which parts of the API belong to each.
// A mountain with no saved choice has every app on. The platform operator turns apps off per mountain.
//
// Municipal edition (muni release 1): a tenant is a mountain (a ski area) or a municipality (tenants.org_type). Each app
// says which of them it is for (orgs). An app that is not for the tenant's kind is always off, is never offered in the
// console, and its API paths and public pages are refused. A municipality with no saved choice has Assets and fleet,
// Staff and schedule, Documents, Messages and Resident requests on; its add-ons stay off until the operator turns them on.
// Assets and fleet is a paid add-on for a mountain, and part of the core plan for a municipality.
const { pool } = require('../db');
const { AppError } = require('./errors');

// paths are matched against the API path after /api/v1 (for example /rentals/items).
const MODULES = [
  { key: 'sell', label: 'Sell', blurb: 'Point of sale: tickets, passes, orders, gift cards and refunds.', needs: ['catalog'], paths: ['/checkout', '/guests', '/gift-cards', '/orders', '/passes', '/terminal', '/partner-passes'] },
  { key: 'catalog', label: 'Products and prices', blurb: 'The product list, promo codes and price rules.', paths: ['/products', '/pricing', '/guest-types'] },
  { key: 'gate', label: 'Gate', blurb: 'Scanning lift tickets and passes at the gate: barcodes, RFID cards and gate hardware.', paths: ['/tickets', '/access'] },
  { key: 'conditions', label: 'Lifts and trails', blurb: 'Lift and trail status, grooming, snow and weather, maintenance and daily reports.', paths: ['/schedule', '/ops', '/attractions'] },
  { key: 'assets', label: 'Assets and fleet (add-on)', blurb: 'The asset register for the fleet, lifts, snowmaking and buildings: meters, fuel, inspections, parts and stock, purchase orders, costs and QR tags. Off until the operator turns it on for a mountain.', addon: true, orgs: ['mountain', 'municipality'], addonFor: ['mountain'], paths: ['/assets'] },
  { key: 'park', label: 'Terrain park', blurb: 'Park features, areas and the park map.', paths: ['/park'] },
  { key: 'rentals', label: 'Rentals', blurb: 'Rental equipment and contracts.', paths: ['/rentals'] },
  { key: 'school', label: 'Ski school', blurb: 'Lessons, instructors, students, credits and online lesson requests.', paths: ['/skischool'] },
  { key: 'programs', label: 'Clubs and programs', blurb: 'Clubs, camps, leagues and their sessions.', paths: ['/programs'] },
  { key: 'availability', label: 'Instructor availability', blurb: 'Instructors post open dates and times, with an optional public page.', paths: ['/availability'] },
  { key: 'patrol', label: 'Patrol', blurb: 'Incidents, dispatch, checklists, follow-up, training and the guest help page.', paths: ['/patrol'] },
  { key: 'documents', label: 'Documents', orgs: ['mountain', 'municipality'], blurb: 'Files by category with versions, search and read-and-accepted tracking.', paths: ['/documents'] },
  { key: 'doc_ocr', label: 'Document text recognition (add-on)', orgs: ['mountain', 'municipality'], blurb: 'Reads the words in scanned PDFs and pictures so they can be searched. Off until the operator turns it on for a mountain.', addon: true, needs: ['documents'], paths: [] },
  { key: 'assistant_plus', label: 'AI Operations (add-on)', orgs: ['mountain', 'municipality'], blurb: 'Questions about the mountain\'s own numbers (sales, rosters, lessons, who is on), the guest assistant on the online pages, the morning conditions writer, and weather-day plans when they arrive. The assistant drafts; a person approves before anything is published or sent.', addon: true, paths: [] },
  { key: 'lesson_texts', label: 'Texts to families (add-on)', blurb: 'Lesson confirmations, recaps, waitlist offers and weather changes also go to families by text message, when they said yes to texts. Without it they go by email. Off until the operator turns it on for a mountain.', addon: true, needs: ['school'], paths: [] },
  { key: 'lesson_ai', label: 'AI lesson recaps', blurb: 'Writes a short recap for each student from the instructor\'s ticks and spoken note; the instructor approves every one. Included with AI Operations; the operator can also turn it on for a mountain at no cost.', addon: true, needs: ['school'], paths: [] },
  { key: 'messages', label: 'Messages', orgs: ['mountain', 'municipality'], blurb: 'Email and text messages to customers who agreed to hear from you, and automatic rental and pass reminders.', paths: ['/messages'] },
  { key: 'shop', label: 'Online shop', blurb: 'A public page where guests buy lift tickets and passes by card, and the list of those orders.', needs: ['catalog'], paths: ['/online-shop'] },
  { key: 'money', label: 'Money', blurb: 'Tax rules, till, card reconciliation and exports.', paths: ['/tax-rules', '/till', '/reconcile', '/exports'] },
  { key: 'workforce', label: 'Staff and schedule', blurb: 'Staff, shifts, certifications, time clock and the kiosk tablets.', orgs: ['mountain', 'municipality'], paths: ['/workforce', '/kiosk-admin'] },
  // The municipal edition's own apps (never on for a mountain).
  { key: 'requests', label: 'Resident requests', blurb: 'Residents report a pothole, a streetlight or a missed pickup online; staff turn each one into a work order and tell them when it is fixed. Includes the street list and street notices.', orgs: ['municipality'], paths: ['/requests', '/street-notices'] },
  { key: 'water', label: 'Water (add-on)', blurb: 'Water mains, valves, hydrants and meters on the asset register, with their inspections and programs.', addon: true, orgs: ['municipality'], paths: ['/water'] },
  { key: 'sewer', label: 'Sewer (add-on)', blurb: 'Sewer mains, manholes and pump stations on the asset register, with their inspections and programs.', addon: true, orgs: ['municipality'], paths: ['/sewer'] },
  { key: 'stormwater', label: 'Stormwater (add-on)', blurb: 'Inlets, outfalls and basins on the asset register, with their inspections and programs.', addon: true, orgs: ['municipality'], paths: ['/stormwater'] },
  { key: 'solidwaste', label: 'Trash and recycling (add-on)', blurb: 'Residents book and pay for bulk trash pickup online, and the crew sees each day\'s route.', addon: true, orgs: ['municipality'], paths: ['/solid-waste'] },
  { key: 'buildings', label: 'Buildings (add-on)', blurb: 'Life-safety inspections for the municipality\'s own buildings: the calendar of checks, vendor visits and certificates, staff rounds, and the binder for the insurer or fire marshal.', addon: true, orgs: ['municipality'], paths: ['/buildings'] },
];
const ORG_TYPES = ['mountain', 'municipality'];
// Every app without its own list is a ski area app.
for (const m of MODULES) if (!m.orgs) m.orgs = ['mountain'];
const KEYS = MODULES.map((m) => m.key);
const BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));
const orgOf = (org) => (org === 'municipality' ? 'municipality' : 'mountain');
/** Is this app for this kind of tenant? */
const offered = (key, org = 'mountain') => Boolean(BY_KEY[key]) && BY_KEY[key].orgs.includes(orgOf(org));
/** A paid add-on for this kind of tenant (Assets and fleet is one for a mountain, part of the core plan for a municipality). */
const isAddon = (m, org = 'mountain') => Boolean(m.addon) && (!m.addonFor || m.addonFor.includes(orgOf(org)));
/** The apps offered to a kind of tenant, in the usual order. */
const keysFor = (org = 'mountain') => KEYS.filter((k) => offered(k, org));
const modulesFor = (org = 'mountain') => MODULES.filter((m) => offered(m.key, org));
// Paid add-ons start off: a tenant has one only when its operator has turned it on. Apps not for its kind are always off.
const defaultsFor = (org = 'mountain') => Object.fromEntries(MODULES.map((m) => [m.key, offered(m.key, org) && !isAddon(m, org)]));
const DEFAULTS = defaultsFor('mountain');

// Reference data other apps read: the lift and trail list is open to anyone who has an app that uses it.
// A patrol on its own (Patrol on, Lifts and trails off) still keeps its list of runs and lifts.
const SHARED_WRITES = [{ re: /^\/schedule\/(lifts|trails)(\/|$)/, any: ['patrol'] }];
// Work orders and service plans (under Lifts and trails' /ops) are also the Assets and fleet app's: a municipality, or a
// mountain without Lifts and trails, reaches them with Assets and fleet on. Nothing else under /ops opens this way.
const WORK_ORDERS = /^\/ops\/(work-orders|pm)(\/|$)/;
SHARED_WRITES.push({ re: WORK_ORDERS, any: ['assets'] });
const SHARED_READS = [
  { re: WORK_ORDERS, any: ['assets'] },
  { re: /^\/schedule\/(lifts|trails|days|events)(\/|$)/, any: ['conditions', 'patrol', 'park', 'gate'] },
  { re: /^\/(products|pricing)(\/|$)/, any: ['catalog', 'sell', 'rentals', 'school', 'programs'] },
  // The attractions themselves (not their inspections): Patrol picks one as a case's place, Sell and the shop sell them.
  { re: /^\/attractions(\/(meta|\d+))?\/?$/, any: ['conditions', 'patrol', 'sell', 'shop', 'gate', 'catalog', 'workforce'] },
];

// Public pages, by the word after the mountain's web name.
const PUBLIC = { conditions: 'conditions', booking: 'school', quote: 'school', requests: 'school', 'lesson-basket': 'school', waitlist: 'school', 'instructor-availability': 'availability', help: 'patrol', give: 'patrol', shop: 'shop', partner: 'shop', programs: 'programs', family: 'programs', assistant: 'assistant_plus', 'rental-form': 'rentals',
  // The municipal edition's public pages.
  report: 'requests', 'open-requests': 'requests', alerts: 'requests', streets: 'requests', 'bulk-pickup': 'solidwaste' };

/**
 * Turning one app on turns on what it needs; turning one off turns off what needs it. org: the tenant's kind; an app that
 * is not for it is never on.
 */
function settle(want, org = 'mountain') {
  const on = new Set(keysFor(org).filter((k) => (isAddon(BY_KEY[k], org) ? want[k] === true : want[k] !== false)));
  for (const k of [...on]) for (const n of BY_KEY[k].needs || []) on.add(n);
  for (const k of Object.keys(want)) if (want[k] === false) { // an explicit off wins, and takes dependents with it
    on.delete(k);
    for (const m of MODULES) if ((m.needs || []).includes(k)) on.delete(m.key);
  }
  return keysFor(org).filter((k) => on.has(k));
}

/** Apply a set of on/off requests to a tenant's current choices; what an app needs (or what needs it) moves with it. */
function apply(current, changes, org = 'mountain') {
  const want = { ...defaultsFor(org), ...current };
  const turn = (k, on) => {
    if (want[k] === on) return;
    want[k] = on;
    if (on) for (const n of BY_KEY[k].needs || []) turn(n, true);
    else for (const m of MODULES) if ((m.needs || []).includes(k)) turn(m.key, false);
  };
  for (const [k, v] of Object.entries(changes)) turn(k, Boolean(v));
  return settle(want, org);
}

const cache = new Map(); // tenant id -> { at, status, org, on:Set }
const TTL = Number(process.env.MODULE_CACHE_MS ?? 10000);
const invalidate = (tenantId) => { if (tenantId === undefined) cache.clear(); else cache.delete(Number(tenantId)); };

async function stateOf(tenantId) {
  const id = Number(tenantId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const [[t]] = await pool.query('SELECT status, org_type FROM tenants WHERE id = ?', [id]);
  const [rows] = await pool.query('SELECT module, enabled FROM tenant_modules WHERE tenant_id = ?', [id]);
  const want = {}; for (const r of rows) want[r.module] = Boolean(r.enabled);
  const org = orgOf(t && t.org_type);
  const state = { at: Date.now(), status: t ? t.status : 'missing', org, on: new Set(settle(want, org)) };
  cache.set(id, state);
  return state;
}
const enabledKeys = async (tenantId) => { const { on } = await stateOf(tenantId); return KEYS.filter((k) => on.has(k)); };
/** The tenant's kind: 'mountain' or 'municipality'. */
const orgTypeOf = async (tenantId) => (await stateOf(tenantId)).org;
/** "mountain" or "municipality", for words shown to people. */
const orgWord = (org) => (orgOf(org) === 'municipality' ? 'municipality' : 'mountain');

const off = (module, org = 'mountain') => { const e = new AppError(403, `${BY_KEY[module].label} is not turned on for your ${orgWord(org)}`); e.details = { code: 'module_disabled', module }; return e; };

function moduleFor(path) {
  for (const m of MODULES) for (const p of m.paths) if (path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}.`)) return m.key;
  return null;
}

// Ski-area routes with no app key of their own (review fix, 2026.11.19): lost and found, waivers, attractions, the daily
// and weekly reports, and the ski Today board. A municipality is refused them like any app it does not have (403,
// module_disabled); its own Today is built from each municipal app's /today (lib/today.js).
const MOUNTAIN_ONLY = ['/lost-found', '/waivers', '/attractions', '/reports', '/board'];
const mountainOnly = (path) => MOUNTAIN_ONLY.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}.`));

/** Signed-in requests: refuse the ones that belong to an app this mountain has turned off. */
function moduleGate(req, _res, next) {
  (async () => {
    const path = require('./pathcheck').normal(req.path); // capitals or a trailing slash reach the same routes
    if (mountainOnly(path) && (await stateOf(req.auth.tenantId)).org === 'municipality') {
      const e = new AppError(403, 'This is part of the ski area edition and is not turned on for your municipality');
      e.details = { code: 'module_disabled', module: null };
      throw e;
    }
    const key = moduleFor(path);
    if (!key) return;
    const { on, org } = await stateOf(req.auth.tenantId);
    if (on.has(key)) return;
    if (req.method === 'GET') { const shared = SHARED_READS.find((s) => s.re.test(path)); if (shared && shared.any.some((k) => on.has(k))) return; }
    else { const shared = SHARED_WRITES.find((s) => s.re.test(path)); if (shared && shared.any.some((k) => on.has(k))) return; }
    throw off(key, org);
  })().then(() => next(), next);
}

// Public words with no app of their own that a municipality keeps (none yet: its pages are all in PUBLIC above).
const MUNI_OPEN = [];

/** Public pages: /public/<mountain>/<page>. A paused mountain or a switched-off app looks like a page that does not exist. */
function publicGate(req, _res, next) {
  (async () => {
    const parts = req.path.split('/').filter(Boolean);
    if (parts[0] === 'followup') return; // checked once the link's mountain is known
    const slug = parts[0]; const module = PUBLIC[parts[1]];
    if (!module) {
      // A municipality has only its own public pages: a ski area's page (a waiver, lost and found) is not found there.
      if (slug && parts[1] && !MUNI_OPEN.includes(parts[1])) {
        const [[t]] = await pool.query("SELECT id FROM tenants WHERE slug = ? AND org_type = 'municipality'", [slug]);
        if (t) throw new AppError(404, 'Page not found');
      }
      return;
    }
    if (slug) {
      const [[t]] = await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]);
      if (!t) return; // the page itself answers "not found"
      const s = await stateOf(t.id);
      if (s.status !== 'active' || !s.on.has(module)) throw new AppError(404, 'Page not found');
      // A mountain whose Verdynt/OS subscription has lapsed takes no online orders or bookings (waivers and help still work).
      if (['shop', 'school', 'programs'].includes(module) && await require('./billing').publicBlocked(t.id, req.method)) throw new AppError(409, 'This mountain is not taking online orders right now. Please contact them directly.');
    }
  })().then(() => next(), next);
}

/** For code that already knows the mountain (a tablet, a follow-up link). */
async function requireModule(tenantId, module) {
  const s = await stateOf(tenantId);
  if (s.status !== 'active') throw new AppError(403, 'This mountain is paused');
  if (!s.on.has(module)) throw off(module, s.org);
}

module.exports = { MODULES, KEYS, ORG_TYPES, settle, apply, invalidate, stateOf, enabledKeys, orgTypeOf, orgWord, offered, isAddon, keysFor, modulesFor, defaultsFor, DEFAULTS, moduleGate, publicGate, requireModule, moduleFor, PUBLIC, MOUNTAIN_ONLY };
