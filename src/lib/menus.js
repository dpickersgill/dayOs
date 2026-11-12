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
/**
 * 'park' for Park crew or Terrain park, 'grooming' for a groomer, and so on; null when nothing fits. The name matches in
 * any case (Lift Operator, Lift operator and LIFT OPERATOR are the same position: 2026.11.13 seed names are sentence case).
 */
function positionKind(p) {
  if (!p) return null;
  const n = String(p.name || '').toLowerCase();
  p = { ...p, department: String(p.department || '').toLowerCase() };
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

// A municipality (muni release 1): four roles, each with a fixed short menu of the municipal apps. The ski menus, the patrol
// director's and position menus do not apply; the menu shows only the apps the person may open with the apps turned on.
const MUNI_ROLES = ['owner', 'manager', 'staff', 'counter'];
const MUNI_STANDARD = {
  owner: { apps: ['requests', 'works', 'assets', 'workforce'], start: 'dashboard' },
  manager: { apps: ['requests', 'works', 'assets', 'workforce'], start: 'dashboard' },
  staff: { apps: ['works', 'requests', 'assets'], start: 'dashboard' },
  counter: { apps: ['requests', 'bulk', 'notices'], start: 'dashboard' },
};
/** A municipality's menu for this role, or null for a role a municipality does not have. */
const muniMenuFor = (role) => (MUNI_STANDARD[role] ? copy(MUNI_STANDARD[role]) : null);

/** The kinds of work a person's positions stand for, in order, without repeats: ['park'], ['lifts', 'grooming']. */
const kindsOf = (positions) => [...new Set((positions || []).map(positionKind).filter(Boolean))];

// ---------------------------------------------------------------- pins (2026.11.21)
// A person's pins: the top of their menu, under "Pinned". With nothing saved they are the role's menu above (its apps and
// shortcuts, in order), so an owner's change to a role's menu keeps reaching everyone who has not made their own. A person
// can pin any page they may open, reorder, rename and reset; their list is kept in user_nav (routes/menav.js).
//   a pin: { id, label, href, app, icon? }   href: a page address without the leading "#/" ("patrol/cases?tab=records")
//                                            app: the view it belongs to, always the first part of href

// Every page of the app by its view key, with its name: the menus' apps, a municipality's, and the pages every menu has.
const VIEW_NAMES = {
  ...APPS, brief: 'Morning brief', settings: 'Settings', help: 'Help', area: 'Summary',
  requests: 'Requests', notices: 'Street notices', works: 'Work orders', assetprograms: 'Programs', bulk: 'Bulk pickup', buildings: 'Buildings',
  monthreport: 'Monthly report', water: 'Water', sewer: 'Sewer', stormwater: 'Stormwater',
};
// Who may open each view: the same rules as VIEWS in public/js/main.js (test/nav-pins.test.js checks every view there
// has a rule here). w: { role, onPatrol, schoolAccess }.
const isManagerRole = (w) => w.role === 'owner' || w.role === 'manager';
const roleCan = (w, ...roles) => isManagerRole(w) || roles.includes(w.role) || (roles.includes('patrol') && Boolean(w.onPatrol));
const schoolDirector = (w) => isManagerRole(w) || (w.role === 'instructor' && w.schoolAccess === 'director');
const anyone = () => true;
const notArea = (w) => w.role !== 'area';
const VIEW_RULES = {
  dashboard: anyone, inbox: anyone, brief: notArea, sell: (w) => roleCan(w, 'counter') || schoolDirector(w), gate: (w) => roleCan(w, 'counter', 'staff'),
  conditions: anyone, park: anyone, assets: (w) => roleCan(w, 'staff'), documents: anyone, rentals: (w) => roleCan(w, 'counter'),
  school: (w) => roleCan(w, 'instructor', 'counter'), programs: (w) => roleCan(w, 'instructor', 'counter'),
  // An instructor's own page; everyone else who may open it is sent to Lessons, so it is a page of its own only for them.
  availability: (w) => w.role === 'instructor',
  patrol: (w) => roleCan(w, 'patrol'), people: (w) => roleCan(w, 'counter', 'instructor'), waivers: (w) => roleCan(w, 'counter', 'instructor'),
  lostfound: (w) => roleCan(w, 'counter', 'staff'), shop: (w) => roleCan(w, 'counter'), catalog: schoolDirector,
  messages: isManagerRole, money: isManagerRole, workforce: isManagerRole, myshifts: anyone, calendar: notArea, settings: anyone, help: anyone,
  area: (w) => w.role === 'area',
  requests: (w) => roleCan(w, 'counter', 'staff'), notices: (w) => roleCan(w, 'counter', 'staff'), works: (w) => roleCan(w, 'staff'),
  assetprograms: (w) => roleCan(w, 'staff'), bulk: (w) => roleCan(w, 'counter', 'staff'), buildings: (w) => roleCan(w, 'counter', 'staff'),
  monthreport: isManagerRole, water: (w) => roleCan(w, 'staff'), sewer: (w) => roleCan(w, 'staff'), stormwater: (w) => roleCan(w, 'staff'),
};
// A view whose app (lib/modules.js) has another name; every other view's key is its app's key. These are a
// municipality's views and never show for a ski area (main.js VIEW_MODULE).
const VIEW_MODULE = { requests: 'requests', notices: 'requests', works: 'assets', assetprograms: 'assets', bulk: 'solidwaste', buildings: 'buildings', monthreport: 'assets', water: 'water', sewer: 'sewer', stormwater: 'stormwater' };
// The views a municipality may have at all, and the pages no tenant can turn off (main.js MUNI_VIEWS and ALWAYS).
const MUNI_VIEWS = ['dashboard', 'inbox', 'myshifts', 'requests', 'notices', 'bulk', 'works', 'assets', 'assetprograms', 'buildings', 'monthreport', 'workforce', 'messages', 'documents', 'settings', 'help', 'water', 'sewer', 'stormwater'];
const NEVER_OFF = ['dashboard', 'brief', 'calendar', 'inbox', 'people', 'waivers', 'lostfound', 'myshifts', 'settings', 'help', 'area'];

/**
 * The views this person may open now, as the page works it out (main.js visibleViews): their role, the apps that are on
 * for the tenant, and the kind of tenant. who: { role, org: 'mountain' | 'municipality', modules: [app keys that are on],
 * onPatrol, schoolAccess }. A pin can only point into one of these.
 */
function viewsFor(who) {
  const w = who || {};
  const on = new Set(w.modules || []);
  const appOn = (k) => NEVER_OFF.includes(k) || on.has(VIEW_MODULE[k] || k);
  const may = (k) => VIEW_RULES[k](w);
  if (w.org === 'municipality') {
    return MUNI_VIEWS.filter((k) => (k !== 'myshifts' || on.has('workforce')) && (VIEW_MODULE[k] ? on.has(VIEW_MODULE[k]) : appOn(k)) && may(k));
  }
  if (w.role === 'area') return ['area', 'settings', 'help'];
  // A patrol on its own (Patrol on, none of the front-desk or mountain apps) has no customers, waivers or day board.
  const patrolOnly = on.has('patrol') && !['sell', 'conditions', 'rentals', 'school'].some((k) => on.has(k));
  const hide = patrolOnly ? ['dashboard', 'people', 'waivers', 'lostfound', 'myshifts'] : [];
  return Object.keys(VIEW_RULES).filter((k) => !hide.includes(k) && !VIEW_MODULE[k] && appOn(k) && may(k));
}

const PIN_MAX = 12;
const PIN_LABEL_MAX = 40;
const PIN_HREF_MAX = 200;
const BAR_MAX = 4;
// A page address: an app, then path parts, then a query. Nothing that could leave the app: no scheme, no "//", no "#",
// no spaces, and (checked apart) no ".." part.
const PIN_HREF = /^[a-z0-9-]+(\/[A-Za-z0-9_.-]+)*(\?[A-Za-z0-9_=&%.,:+-]*)?$/;
const PIN_ID = /^[A-Za-z0-9_.:-]{1,40}$/;
const PIN_ICON = /^[a-z0-9-]{1,30}$/;
/** The app a page address belongs to: its first part. */
const appOfHref = (href) => String(href).split(/[/?]/)[0];
/** Is this a page address a pin may hold? (Its form only; whether the person may open its app is checked apart.) */
function goodHref(href) {
  if (typeof href !== 'string' || href.length > PIN_HREF_MAX || !PIN_HREF.test(href)) return false;
  return !href.split('?')[0].split('/').some((part) => /^\.+$/.test(part));
}

/**
 * A role's starting pins from its menu: each app, and each shortcut with its page address and label, in the menu's
 * order; only what the person may open (may: viewsFor). menu: menuFor() or muniMenuFor(); null gives none.
 */
function startingPins(menu, may) {
  if (!menu || !Array.isArray(menu.apps)) return [];
  const out = [];
  for (const k of [...new Set(menu.apps)]) {
    const l = LINKS[k];
    const app = l ? l.app : k;
    if (!may.includes(app) || HOME.includes(k)) continue;
    out.push(l ? { id: k, label: l.label, href: l.href, app, icon: l.icon } : { id: k, label: VIEW_NAMES[k] || k, href: k, app });
    if (out.length === PIN_MAX) break;
  }
  return out;
}

/**
 * A pin's name as it is kept: control characters and the characters that turn text around (bidirectional overrides
 * and isolates, the left-to-right and right-to-left marks) taken out, so a name cannot hide or reorder what the menu
 * shows; runs of spaces folded. The same rule as nav.js cleanLabel.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const cleanText = (v) => (typeof v === 'string' ? v.replace(UNSAFE_TEXT, '').replace(/\s+/g, ' ').trim() : '');
/** How long a name is as a person counts it: in characters (code points), so an emoji or an accented letter is one. */
const textLength = (v) => [...v].length;

/** One pin as it is kept and sent, or null when it is not a pin at all (a stored row is read through this too). */
function cleanPin(p) {
  if (!p || typeof p !== 'object') return null;
  const label = cleanText(p.label);
  if (!PIN_ID.test(String(p.id || '')) || !label || textLength(label) > PIN_LABEL_MAX || !goodHref(p.href)) return null;
  const pin = { id: String(p.id), label, href: p.href, app: appOfHref(p.href) };
  if (typeof p.icon === 'string' && PIN_ICON.test(p.icon)) pin.icon = p.icon;
  return pin;
}

/**
 * Checks what a person asks to save. Returns { pins, bar } as kept (bar: the page addresses on the phone bar, or null
 * for the standard bar), or a plain-words problem. Every pin must point into an app the person may open (may), no two
 * pins share an id or a page, and each of the bar's four is one of the pins or a Home page.
 */
function checkNav(body, may) {
  const list = body && Array.isArray(body.pins) ? body.pins : null;
  if (!list) return { problem: 'Send your pins as a list' };
  if (list.length > PIN_MAX) return { problem: `You can have up to ${PIN_MAX} pins. Unpin one to add another.` };
  const pins = [];
  for (const raw of list) {
    const label = raw ? cleanText(raw.label) : '';
    if (!label) return { problem: 'Every pin needs a name' };
    if (textLength(label) > PIN_LABEL_MAX) return { problem: `A pin's name can be up to ${PIN_LABEL_MAX} characters` };
    if (!raw || !goodHref(raw.href)) return { problem: `"${label}" does not point to a page in Verdynt/OS, so it cannot be pinned` };
    const app = appOfHref(raw.href);
    if (raw.app !== undefined && raw.app !== app) return { problem: `"${label}" names one app and points to another. Pin the page again.` };
    if (!may.includes(app)) return { problem: `You cannot open ${VIEW_NAMES[app] || 'that page'}, so it cannot be pinned` };
    const pin = cleanPin(raw);
    if (!pin) return { problem: `"${label}" is not a pin. Pin the page again.` };
    if (pins.some((x) => x.id === pin.id)) return { problem: 'Two pins have the same id. Reload the page and try again.' };
    if (pins.some((x) => x.href === pin.href)) return { problem: `"${label}" is pinned twice. Take one of them out.` };
    pins.push(pin);
  }
  let bar = null;
  if (body.bar !== undefined && body.bar !== null) {
    if (!Array.isArray(body.bar)) return { problem: 'Send the phone bar as a list' };
    if (body.bar.length > BAR_MAX) return { problem: `The phone bar holds up to ${BAR_MAX} pages` };
    bar = [];
    for (const b of body.bar) {
      const href = typeof b === 'string' ? b : b && b.href;
      const known = pins.some((x) => x.href === href) || (HOME.includes(href) && may.includes(href));
      if (!known) return { problem: 'The phone bar can hold your pins and Today, Inbox, Calendar and My shifts. Pin a page first to put it on the bar.' };
      if (bar.includes(href)) return { problem: 'A page can be on the phone bar once' };
      bar.push(href);
    }
  }
  return { pins, bar };
}

/** A JSON column's value (a string on MariaDB, a value on MySQL), or null. */
function fromJson(raw) {
  if (typeof raw !== 'string') return raw === undefined ? null : raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * What a person's menu shows. row: their user_nav row ({ pins, bar }) or null; standard: their role's starting pins;
 * may: viewsFor(). Returns { pins, bar, custom }: their own pins without those whose app they can no longer open (a role
 * change, an app turned off; such a pin is dropped for good the next time they save), or the role's when they have made
 * none. bar: [{ label, href, app, icon? }] for the phone bar, or null for the standard bar.
 */
function navFrom(row, standard, may) {
  if (!row) return { pins: standard, bar: null, custom: false };
  const stored = fromJson(row.pins);
  const pins = (Array.isArray(stored) ? stored : []).map(cleanPin).filter((p) => p && may.includes(p.app)).slice(0, PIN_MAX);
  const hrefs = fromJson(row.bar);
  let bar = null;
  if (Array.isArray(hrefs)) {
    bar = [];
    for (const href of hrefs.slice(0, BAR_MAX)) {
      const pin = pins.find((p) => p.href === href);
      if (pin) bar.push({ label: pin.label, href: pin.href, app: pin.app, ...(pin.icon ? { icon: pin.icon } : {}) });
      else if (HOME.includes(href) && may.includes(href)) bar.push({ label: VIEW_NAMES[href], href, app: href });
    }
  }
  return { pins, bar, custom: true };
}

module.exports = { APPS, KEYS, HOME, ALWAYS, ROLE_APPS, ROLES, STANDARD, LINKS, DIRECTOR, POSITION_ROLES, POSITION_APPS, KIND_MENUS, isPositionKey, canOpen, positionKind, standardFor, withoutHome, withAlways, check, parse, menuFor, rowFor, linksIn, kindsOf, MUNI_ROLES, MUNI_STANDARD, muniMenuFor,
  VIEW_NAMES, VIEW_RULES, viewsFor, PIN_MAX, PIN_LABEL_MAX, PIN_HREF_MAX, BAR_MAX, PIN_HREF, goodHref, appOfHref, startingPins, checkNav, navFrom };

