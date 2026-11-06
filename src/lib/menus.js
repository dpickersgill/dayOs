'use strict';

// The menu each role sees: its own short list of work apps, in order, and the screen it opens on. Owners and managers
// have one too. Home (Today, Inbox, Calendar, My shifts) is never in a menu: it is pinned at the top of the side menu for
// everyone, so a menu holds only work apps. An owner can change any role's menu, the owner's and the manager's included,
// under Settings, Team and logins, Menus; the changes are kept in tenants.role_menus (JSON), only for the roles changed.

// Every app a menu can hold or open on, with the name shown on the menu.
const APPS = {
  dashboard: 'Today', inbox: 'Inbox', calendar: 'Calendar', myshifts: 'My shifts',
  sell: 'Sell', gate: 'Gate', shop: 'Online shop', rentals: 'Rentals', people: 'Customers', waivers: 'Waivers', lostfound: 'Lost and found',
  conditions: 'Mountain status', park: 'Terrain park', patrol: 'Patrol', assets: 'Assets and fleet',
  school: 'Lessons', programs: 'Programs', availability: 'Instructor availability',
  catalog: 'Products and prices', money: 'Money', workforce: 'Staff and schedule', messages: 'Messages', documents: 'Documents',
};
const KEYS = Object.keys(APPS);

// Home: pinned at the top for everyone (whichever of them the person may open). Never in a menu, but a menu may open on one.
const HOME = ['dashboard', 'inbox', 'calendar', 'myshifts'];
// Kept for older callers: the apps every person always has. They are Home now.
const ALWAYS = HOME;

// What each role may open at all (the same rules as the menu in public/js/main.js). A menu can only hold these.
const EVERYONE = ['dashboard', 'inbox', 'calendar', 'conditions', 'park', 'documents', 'myshifts'];
// Owners and managers may open every app. Instructor availability is a tab of Lessons for them, not a menu item.
const ALL_WORK = KEYS.filter((k) => k !== 'availability');
const ROLE_APPS = {
  owner: ALL_WORK,
  manager: ALL_WORK,
  counter: [...EVERYONE, 'sell', 'gate', 'rentals', 'school', 'programs', 'people', 'waivers', 'lostfound', 'shop'],
  instructor: [...EVERYONE, 'school', 'programs', 'availability', 'people', 'waivers'],
  staff: [...EVERYONE, 'gate', 'assets', 'lostfound'],
  patrol: [...EVERYONE, 'patrol'],
};
const ROLES = Object.keys(ROLE_APPS);

const STANDARD = {
  owner: { apps: ['money', 'conditions', 'patrol', 'school', 'people', 'workforce'], start: 'dashboard' },
  manager: { apps: ['conditions', 'sell', 'patrol', 'school', 'people', 'workforce'], start: 'dashboard' },
  counter: { apps: ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'], start: 'sell' },
  instructor: { apps: ['school', 'availability', 'people', 'waivers'], start: 'school' },
  staff: { apps: ['conditions', 'gate', 'lostfound'], start: 'dashboard' },
  patrol: { apps: ['patrol', 'conditions'], start: 'patrol' },
};

const copy = (m) => ({ apps: [...m.apps], start: m.start });
const standardFor = (role) => (STANDARD[role] ? copy(STANDARD[role]) : null);

/** A menu's apps without Home (pinned for everyone) and without repeats. */
function withoutHome(apps) {
  return [...new Set(apps)].filter((k) => !HOME.includes(k));
}
// Kept for older callers.
const withAlways = withoutHome;

/**
 * Checks one role's menu. Returns the menu as it is kept (Home apps left out: they are pinned), or a plain-words problem.
 * Only apps the role may open can be in it, and the screen it opens on must be one of them or a Home app.
 */
function check(role, menu) {
  if (!ROLE_APPS[role]) return { problem: `${role} has no menu of its own` };
  if (!menu || !Array.isArray(menu.apps) || typeof menu.start !== 'string') return { problem: 'A menu needs its apps and the screen it opens on' };
  const unknown = menu.apps.filter((k) => !KEYS.includes(k));
  if (unknown.length) return { problem: `Not an app: ${unknown.join(', ')}` };
  const notAllowed = menu.apps.filter((k) => !ROLE_APPS[role].includes(k));
  if (notAllowed.length) return { problem: `${notAllowed.map((k) => APPS[k]).join(', ')} cannot be opened by this role, so it cannot be in its menu` };
  const apps = withoutHome(menu.apps);
  if (!apps.length) return { problem: 'A menu needs at least one app besides Today, Inbox, Calendar and My shifts' };
  const homeStart = HOME.includes(menu.start) && ROLE_APPS[role].includes(menu.start);
  if (!apps.includes(menu.start) && !homeStart) return { problem: 'The screen it opens on must be one of the apps in the menu, or Today, Inbox, Calendar or My shifts' };
  return { menu: { apps, start: menu.start } };
}

/**
 * The stored changes (a JSON column: a string on MariaDB, an object on MySQL), with anything no longer valid left out.
 * Menus saved before Home was pinned held Today, Inbox, Calendar or My shifts: they are dropped here when read (the stored
 * row is not rewritten). So is Instructor availability in a menu of a role that now finds it inside Lessons.
 */
function parse(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const role of ROLES) {
    const m = v[role];
    if (!m || !Array.isArray(m.apps)) continue;
    const apps = m.apps.filter((k) => !HOME.includes(k) && !(k === 'availability' && !ROLE_APPS[role].includes(k)));
    const r = check(role, { apps, start: m.start === 'availability' && !ROLE_APPS[role].includes('availability') ? apps[0] : m.start });
    if (r.menu) out[role] = r.menu;
  }
  return out;
}

/**
 * The menu for someone with this role: null for a login with no menu of its own (the ski area's read-only login).
 * schoolAccess: an instructor login's ski school level (lib/schoolaccess.js); a Director also gets Sell (lessons only)
 * and Products and prices (lesson products only) right after Lessons.
 */
function menuFor(role, raw, schoolAccess = null) {
  if (!ROLE_APPS[role]) return null;
  const menu = parse(raw)[role] || standardFor(role);
  if (role === 'instructor' && schoolAccess === 'director') {
    const extra = ['sell', 'catalog'].filter((k) => !menu.apps.includes(k));
    const at = menu.apps.includes('school') ? menu.apps.indexOf('school') + 1 : 0;
    menu.apps.splice(at, 0, ...extra);
  }
  return menu;
}

module.exports = { APPS, KEYS, HOME, ALWAYS, ROLE_APPS, ROLES, STANDARD, standardFor, withoutHome, withAlways, check, parse, menuFor };
