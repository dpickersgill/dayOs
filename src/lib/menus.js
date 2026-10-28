'use strict';

// The menu each role sees: its own short list of apps, in order, and the screen it opens on. Owners and managers see
// everything (null). An owner can change a role's menu under Settings, Team and logins, Menus for each role; the
// changes are kept in tenants.role_menus (JSON) and only for the roles that were changed.

// Every app a menu can hold, with the name shown on the menu.
const APPS = {
  dashboard: 'Today', inbox: 'Inbox', sell: 'Sell', gate: 'Gate', conditions: 'Mountain status', park: 'Terrain park',
  assets: 'Assets and fleet', documents: 'Documents', rentals: 'Rentals', school: 'Ski school', programs: 'Programs',
  availability: 'Instructor availability', patrol: 'Patrol', people: 'Customers', waivers: 'Waivers', lostfound: 'Lost and found',
  shop: 'Online shop', myshifts: 'My shifts',
};
const KEYS = Object.keys(APPS);

// Always in every role's menu, at the end unless the owner placed them.
const ALWAYS = ['inbox', 'myshifts'];

// What each role may open at all (the same rules as the menu in public/js/main.js). A menu can only hold these.
const EVERYONE = ['dashboard', 'inbox', 'conditions', 'park', 'documents', 'myshifts'];
const ROLE_APPS = {
  counter: [...EVERYONE, 'sell', 'gate', 'rentals', 'school', 'programs', 'availability', 'people', 'waivers', 'lostfound', 'shop'],
  instructor: [...EVERYONE, 'school', 'programs', 'availability', 'people', 'waivers'],
  staff: [...EVERYONE, 'gate', 'assets', 'lostfound'],
  patrol: [...EVERYONE, 'patrol'],
};
const ROLES = Object.keys(ROLE_APPS);

const STANDARD = {
  counter: { apps: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop', 'inbox', 'myshifts'], start: 'sell' },
  instructor: { apps: ['school', 'availability', 'people', 'waivers', 'inbox', 'myshifts'], start: 'school' },
  staff: { apps: ['dashboard', 'conditions', 'gate', 'lostfound', 'inbox', 'myshifts'], start: 'dashboard' },
  patrol: { apps: ['patrol', 'conditions', 'inbox', 'myshifts'], start: 'patrol' },
};

const copy = (m) => ({ apps: [...m.apps], start: m.start });
const standardFor = (role) => (STANDARD[role] ? copy(STANDARD[role]) : null);

/** Inbox and My shifts are always in: add whichever is missing at the end, and drop repeats. */
function withAlways(apps) {
  const out = [...new Set(apps)];
  for (const k of ALWAYS) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * Checks one role's menu. Returns the menu as it is kept (Inbox and My shifts added), or a plain-words problem.
 * Only apps the role may open can be in it, and the screen it opens on must be one of them.
 */
function check(role, menu) {
  if (!ROLE_APPS[role]) return { problem: `${role} has no menu of its own: owners and managers see everything` };
  if (!menu || !Array.isArray(menu.apps) || typeof menu.start !== 'string') return { problem: 'A menu needs its apps and the screen it opens on' };
  const unknown = menu.apps.filter((k) => !KEYS.includes(k));
  if (unknown.length) return { problem: `Not an app: ${unknown.join(', ')}` };
  const notAllowed = menu.apps.filter((k) => !ROLE_APPS[role].includes(k));
  if (notAllowed.length) return { problem: `${notAllowed.map((k) => APPS[k]).join(', ')} cannot be opened by this role, so it cannot be in its menu` };
  const apps = withAlways(menu.apps);
  if (!apps.includes(menu.start)) return { problem: 'The screen it opens on must be one of the apps in the menu' };
  return { menu: { apps, start: menu.start } };
}

/** The stored changes (a JSON column: a string on MariaDB, an object on MySQL), with anything no longer valid left out. */
function parse(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const role of ROLES) {
    if (!v[role]) continue;
    const r = check(role, v[role]);
    if (r.menu) out[role] = r.menu;
  }
  return out;
}

/** The menu for someone with this role: null for owners, managers and anyone else who sees everything. */
function menuFor(role, raw) {
  if (!ROLE_APPS[role]) return null;
  return parse(raw)[role] || standardFor(role);
}

module.exports = { APPS, KEYS, ALWAYS, ROLE_APPS, ROLES, STANDARD, standardFor, withAlways, check, parse, menuFor };
