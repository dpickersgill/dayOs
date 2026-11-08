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
  school: 'Lessons', programs: 'Programs', availability: 'My availability',
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

// Shortcuts: a menu item that opens one page inside an app (a second-row tab), for menus that need it. Allowed only in
// the menus listed in `rows`, and only shown when the person may open the app.
const LINKS = {
  'patrol-records': { label: 'Records requests', app: 'patrol', href: 'patrol/cases?tab=records', icon: 'documents', rows: ['patrol_director', 'owner', 'manager'] },
  'patrol-access': { label: 'Access log', app: 'patrol', href: 'patrol/cases?tab=access', icon: 'search', rows: ['patrol_director', 'owner', 'manager'] },
  'patrol-review': { label: 'Case review', app: 'patrol', href: 'patrol/cases?tab=review', icon: 'patrol', rows: ['patrol_director', 'owner', 'manager'] },
};
const LINK_KEYS = Object.keys(LINKS);

// Menus beyond the six roles (2026.11.13). The patrol director (a patroller whose roster access level is Admin or Manager)
// has a menu of its own, apart from the patrollers'. And a position from Staff and schedule (Park crew, Groomer) can have
// one: people with the role Lift and mountain staff or Ticket window and rentals who work that position get it instead
// of their role's. Kept in the same tenants.role_menus JSON, under 'patrol_director' and 'pos:<position id>'.
const DIRECTOR = 'patrol_director';
STANDARD[DIRECTOR] = { apps: ['patrol', 'patrol-records', 'patrol-access', 'conditions'], start: 'patrol' };
// The roles a position menu applies to, and what it may hold (each person still sees only what their role may open).
const POSITION_ROLES = ['staff', 'counter'];
const POSITION_APPS = [...new Set(POSITION_ROLES.flatMap((r) => ROLE_APPS[r]))];
const isPositionKey = (k) => /^pos:\d{1,18}$/.test(String(k));
/** What a menu row may hold: its role's apps, the patrol director's patrol apps and shortcuts, a position's apps. */
function canOpen(row) {
  if (row === DIRECTOR) return [...ROLE_APPS.patrol, ...LINK_KEYS.filter((k) => LINKS[k].rows.includes(DIRECTOR))];
  if (isPositionKey(row)) return POSITION_APPS;
  if (!ROLE_APPS[row]) return null;
  return [...ROLE_APPS[row], ...LINK_KEYS.filter((k) => LINKS[k].rows.includes(row) && ROLE_APPS[row].includes(LINKS[k].app))];
}

// The work a position stands for, from its department and name, and the menu that work gets unless the owner sets one.
// Only these kinds have a standard menu; any other position uses the role's menu until the owner gives it one.
const KIND_MENUS = {
  lifts: { apps: ['conditions', 'gate', 'lostfound'], start: 'dashboard' },
  park: { apps: ['park', 'conditions', 'lostfound'], start: 'dashboard' },
  grooming: { apps: ['conditions', 'assets', 'park'], start: 'dashboard' },
  maintenance: { apps: ['conditions', 'assets'], start: 'dashboard' },
  rentals: { apps: ['rentals', 'sell', 'waivers', 'people', 'lostfound'], start: 'rentals' },
  food: { apps: ['sell', 'lostfound', 'conditions'], start: 'dashboard' },
};
/** 'park' for Park crew or Terrain park, 'grooming' for a groomer, and so on; null when nothing fits. */
function positionKind(p) {
  if (!p) return null;
  const n = String(p.name || '').toLowerCase();
  if (/\bpark\b|terrain/.test(n)) return 'park';
  if (p.department === 'grooming' || /groom|snowcat|snow ?mak/.test(n)) return 'grooming';
  if (p.department === 'lifts' || /\blift/.test(n)) return 'lifts';
  if (p.department === 'rentals' || /rental/.test(n)) return 'rentals';
  if (p.department === 'food' || /\b(food|cafe|caf\u00e9|cook|kitchen|grill)\b/.test(n)) return 'food';
  if (p.department === 'maintenance' || /mechanic|maintenance/.test(n)) return 'maintenance';
  return null;
}

const copy = (m) => ({ apps: [...m.apps], start: m.start });
/** The standard menu of a role or menu row (a position's comes from its kind: pass the position). */
function standardFor(row, position = null) {
  if (isPositionKey(row)) { const k = positionKind(position); return k ? copy(KIND_MENUS[k]) : null; }
  return STANDARD[row] ? copy(STANDARD[row]) : null;
}

/** A menu's apps without Home (pinned for everyone) and without repeats. */
function withoutHome(apps) {
  return [...new Set(apps)].filter((k) => !HOME.includes(k));
}
// Kept for older callers.
const withAlways = withoutHome;

const nameOf = (k) => APPS[k] || (LINKS[k] && LINKS[k].label) || k;

/**
 * Checks one menu (a role's, the patrol director's or a position's). Returns the menu as it is kept (Home apps left out:
 * they are pinned), or a plain-words problem. Only apps that menu may hold can be in it, and the screen it opens on must
 * be one of them or a Home app.
 */
function check(row, menu) {
  const may = canOpen(row);
  if (!may) return { problem: `${row} has no menu of its own` };
  if (!menu || !Array.isArray(menu.apps) || typeof menu.start !== 'string') return { problem: 'A menu needs its apps and the screen it opens on' };
  const unknown = menu.apps.filter((k) => !KEYS.includes(k) && !LINK_KEYS.includes(k));
  if (unknown.length) return { problem: `Not an app: ${unknown.join(', ')}` };
  const notAllowed = menu.apps.filter((k) => !may.includes(k));
  if (notAllowed.length) return { problem: `${notAllowed.map(nameOf).join(', ')} cannot be opened by this role, so it cannot be in its menu` };
  const apps = withoutHome(menu.apps);
  if (!apps.length) return { problem: 'A menu needs at least one app besides Today, Inbox, Calendar and My shifts' };
  const homeStart = HOME.includes(menu.start) && may.includes(menu.start);
  if (LINK_KEYS.includes(menu.start) || (!apps.includes(menu.start) && !homeStart)) return { problem: 'The screen it opens on must be one of the apps in the menu, or Today, Inbox, Calendar or My shifts' };
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
  for (const row of Object.keys(v)) {
    if (!ROLES.includes(row) && row !== DIRECTOR && !isPositionKey(row)) continue;
    const m = v[row];
    if (!m || !Array.isArray(m.apps)) continue;
    const may = canOpen(row);
    const apps = m.apps.filter((k) => !HOME.includes(k) && !(k === 'availability' && !may.includes(k)));
    const r = check(row, { apps, start: m.start === 'availability' && !may.includes('availability') ? apps[0] : m.start });
    if (r.menu) out[row] = r.menu;
  }
  return out;
}

/**
 * The menu a position's people get from their positions (the owner's, or the standard one for its kind), only the apps
 * their role may open, in order and without repeats. It opens on the first position's screen when the role may open
 * it, else on Today. null when no position has a menu, or nothing in them is for this role.
 */
function positionMenu(role, stored, positions) {
  if (!POSITION_ROLES.includes(role) || !Array.isArray(positions) || !positions.length) return null;
  const menus = positions.map((p) => stored[`pos:${p.id}`] || standardFor(`pos:${p.id}`, p)).filter(Boolean);
  if (!menus.length) return null;
  const may = ROLE_APPS[role];
  const apps = [...new Set(menus.flatMap((m) => m.apps))].filter((k) => may.includes(k));
  if (!apps.length) return null;
  const first = menus[0].start;
  const start = apps.includes(first) || (HOME.includes(first) && may.includes(first)) ? first : 'dashboard';
  return { apps, start };
}

/**
 * The menu for someone with this role: null for a login with no menu of its own (the ski area's read-only login).
 * schoolAccess: an instructor login's ski school level (lib/schoolaccess.js); a Director also gets Sell (lessons only)
 * and Products and prices (lesson products only) right after Lessons. who: { patrolLead, positions } — a patrol director
 * gets the patrol director's menu; staff and counter logins linked to a staff member get their positions' menu.
 */
function menuFor(role, raw, schoolAccess = null, who = {}) {
  if (!ROLE_APPS[role]) return null;
  const stored = parse(raw);
  let menu = null;
  if (role === 'patrol' && who.patrolLead) menu = stored[DIRECTOR] || standardFor(DIRECTOR);
  if (!menu) menu = positionMenu(role, stored, who.positions);
  if (!menu) menu = stored[role] || standardFor(role);
  if (role === 'instructor' && schoolAccess === 'director') {
    const extra = ['sell', 'catalog'].filter((k) => !menu.apps.includes(k));
    const at = menu.apps.includes('school') ? menu.apps.indexOf('school') + 1 : 0;
    menu.apps.splice(at, 0, ...extra);
  }
  return menu;
}

/** Which menu row a person's menu comes from: 'patrol_director', 'pos:<id>' or the role. */
function rowFor(role, raw, who = {}) {
  if (role === 'patrol' && who.patrolLead) return DIRECTOR;
  if (positionMenu(role, parse(raw), who.positions)) {
    const stored = parse(raw);
    const p = (who.positions || []).find((x) => stored[`pos:${x.id}`] || positionKind(x));
    if (p) return `pos:${p.id}`;
  }
  return ROLE_APPS[role] ? role : null;
}

/** The shortcuts a menu holds, for the page: { key: { label, href, app, icon } }. */
function linksIn(menu) {
  if (!menu) return {};
  return Object.fromEntries(menu.apps.filter((k) => LINKS[k]).map((k) => [k, { label: LINKS[k].label, href: LINKS[k].href, app: LINKS[k].app, icon: LINKS[k].icon }]));
}

/** The kinds of work a person's positions stand for, in order, without repeats: ['park'], ['lifts', 'grooming']. */
const kindsOf = (positions) => [...new Set((positions || []).map(positionKind).filter(Boolean))];

module.exports = { APPS, KEYS, HOME, ALWAYS, ROLE_APPS, ROLES, STANDARD, LINKS, DIRECTOR, POSITION_ROLES, POSITION_APPS, KIND_MENUS, isPositionKey, canOpen, positionKind, standardFor, withoutHome, withAlways, check, parse, menuFor, rowFor, linksIn, kindsOf };
