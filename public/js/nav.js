// The menu and the page frame (2026.11.21). The menu is for places and the top bar is for actions.
//
// On a computer the side menu has three parts. A 56 px row at the top: the organization and a button that collapses the
// menu. One list that scrolls as a whole: Home (Today, Inbox, Calendar, My shifts, whichever the person may open), then
// Pinned (the person's own short list, starting from their role's menu), then every app they may open, each in its one
// section, all open. A 56 px row at the bottom: the person, which opens the account menu (profile, Settings, Help and
// What's new, the theme, Switch person, Sign out, the version). Collapsed, the menu is a 64 px strip of icons that shows
// the whole menu over the page while the pointer or the keyboard is in it.
//
// The top bar is on every page: where you are (the app, then its part), a place for the pin star, Jump to, + New, Guest
// needs help (ski areas), Ask, Inbox and the page's Help. On a phone the top bar holds the organization's name and three
// icon buttons, a bottom bar holds the person's four places and Menu, and Menu opens a sheet with everything in grids.
//
// Two other modules plug in through what buildFrame returns: pins.js (setPins, slots.star, the nav:edit-pins and
// nav:row-menu events) and navcounts.js / newmenu.js (setBadge, setNew, addCommands). The frame works without them: it
// starts from the role's menu, and shows no Edit link until someone has called setPins.
import { h, clear, ctx, label, isManager, isMuni, schoolCan } from './ui.js';
import { icon } from './icons.js';
import { readTerminal } from './terminal.js';
import { subPagesFor } from './jumpindex.js';
import { mayAskForHelp, openStaffHelp } from './staffhelp.js';

// Home: the first rows of the menu for everyone, never inside a section and never a pin.
export const HOME = ['dashboard', 'inbox', 'calendar', 'myshifts'];
// The sections of a ski area's menu: [label, id, apps]. Every app has one home, the same for every role; a role only
// changes which apps show. An app shows only for people who may open it, and a section with none of them does not show.
export const SECTIONS = [
  ['Guests and sales', 'sales', ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']],
  ['Mountain', 'hill', ['conditions', 'park', 'patrol', 'area', 'assets']],
  ['Ski school', 'school', ['school', 'programs', 'availability']],
  ['Back office', 'office', ['catalog', 'money', 'workforce', 'messages', 'documents']],
];
// A municipality's sections. The ski sections never show there.
export const MUNI_SECTIONS = [
  ['Residents', 'residents', ['requests', 'notices', 'bulk']],
  ['Public works', 'works', ['works', 'assets', 'assetprograms', 'buildings', 'monthreport']],
  ['Utilities', 'utilities', ['water', 'sewer', 'stormwater']],
  ['Back office', 'office', ['workforce', 'messages', 'documents']],
];
/** The sections of the menu for this person's organization. */
export const sectionsFor = () => (isMuni() ? MUNI_SECTIONS : SECTIONS);
/** The section each app lives in ({ id, name }); Home's apps say 'home'. main.js puts the id on the page (data-group). */
export const SECTION_OF = Object.fromEntries([...HOME.map((k) => [k, { id: 'home', name: 'Home' }]), ...MUNI_SECTIONS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }])), ...SECTIONS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }]))]);
// Settings and Help are not rows of the menu: they are in the account menu.
const ACCOUNT = ['settings', 'help'];
// The phone bar: the screen the person's menu opens on first, then their pins, then these, to make four (Inbox has its
// own button in the phone's top bar).
const PHONE_HOME = ['myshifts', 'dashboard', 'calendar'];
// The phone bar has room for about twelve letters under an icon. Every app has a label that fits, so nothing is ever cut
// in the middle of a word there (the full name is the link's accessible name).
export const SHORT = {
  dashboard: 'Today', inbox: 'Inbox', calendar: 'Calendar', myshifts: 'My shifts',
  sell: 'Sell', gate: 'Gate', shop: 'Shop', rentals: 'Rentals', people: 'Customers', waivers: 'Waivers', lostfound: 'Lost items',
  conditions: 'Mountain', park: 'Park', patrol: 'Patrol', area: 'Summary', assets: 'Assets',
  school: 'Lessons', programs: 'Programs', availability: 'Availability',
  catalog: 'Products', money: 'Money', workforce: 'Staff', messages: 'Messages', documents: 'Documents',
  requests: 'Requests', notices: 'Notices', bulk: 'Bulk pickup', works: 'Work orders', assetprograms: 'Programs', buildings: 'Buildings',
  monthreport: 'Report', water: 'Water', sewer: 'Sewer', stormwater: 'Stormwater', settings: 'Settings', help: 'Help',
};
export const BAR_LABEL_MAX = 12;
/**
 * The words under a phone bar icon, 12 letters at most and never cut inside a word. An app's own page uses its short
 * name. A pin with its own name keeps it when it fits; a longer one keeps its first whole words ("Records requests"
 * is "Records"), and when even the first word is too long, its app's short name.
 */
export function barLabel(item) {
  const text = String((item && item.label) || '').trim();
  const short = SHORT[item && item.app] || '';
  if (item && item.href === item.app && short) return short;
  if (text && text.length <= BAR_LABEL_MAX) return text;
  let out = '';
  for (const word of text.split(/\s+/)) { const next = out ? `${out} ${word}` : word; if (next.length > BAR_LABEL_MAX) break; out = next; }
  return out || short || text.slice(0, BAR_LABEL_MAX);
}

// What each role is called, the same in the account row and in Settings, Team and logins, Menus for each role.
export const ROLE_NAMES = {
  owner: 'Owner', manager: 'Manager', counter: 'Ticket window and rentals', instructor: 'Instructor', staff: 'Lift and mountain staff',
  patrol: 'Patroller', patrol_director: 'Patrol director', area: 'Ski area (read-only)',
};
// A municipality's roles have their own names (muni release 1): the crew and the front desk.
export const MUNI_ROLE_NAMES = { owner: 'Owner', manager: 'Manager', staff: 'Crew', counter: 'Front desk' };
/** The role names for this person's tenant. */
export const roleNamesFor = (me = ctx.me) => (me && me.org_type === 'municipality' ? MUNI_ROLE_NAMES : ROLE_NAMES);
/** The name of this person's role: a patroller whose roster access is Admin or Manager is the Patrol director. */
export function roleName(me) {
  if (!me) return '';
  if (me.org_type === 'municipality') return MUNI_ROLE_NAMES[me.role] || label(me.role);
  if (me.role === 'patrol' && me.patrol_lead) return ROLE_NAMES.patrol_director;
  return ROLE_NAMES[me.role] || label(me.role);
}
// The ski area's read-only login: its menu is the summary alone, and it has no pins.
export const AREA_MENU = { apps: ['area'], start: 'area' };

// Patrol's four parts are its page tabs (row 1 on the Patrol page). The side menu has none of them.
export const PATROL_SECTIONS = [['now', 'Now'], ['cases', 'Cases'], ['people', 'People'], ['gear', 'Gear']];
const PATROL_PART_OF = {
  now: 'now', home: 'now', board: 'now', duty: 'now', dispatch: 'now', map: 'now', opening: 'now', sweep: 'now', avalanche: 'now', log: 'now', room: 'now',
  cases: 'cases', case: 'cases', review: 'cases', followup: 'cases', records: 'cases', release: 'cases', stats: 'cases', network: 'cases', risk: 'cases', 'risk-report': 'cases', claim: 'cases', version: 'cases', collision: 'cases', access: 'cases', refusal: 'cases', handoff: 'cases',
  people: 'people', schedule: 'people', crews: 'people', cover: 'people', posts: 'people', team: 'people', training: 'people', passport: 'people',
  gear: 'gear', kit: 'gear', kits: 'gear', 'kit-labels': 'gear', equipment: 'gear', meds: 'gear', lifts: 'gear', places: 'gear', signs: 'gear', stencil: 'gear',
};
/** Which Patrol section a Patrol address belongs to: ['case', '12'] -> 'cases'. */
export const patrolSection = (params = []) => PATROL_PART_OF[params[0]] || 'now';

// Words people might type that are not in the page's name (old names included, so habits still work).
const ALSO = {
  dashboard: 'home overview numbers today', sell: 'ticket pos register checkout basket partner passes indy pass reciprocal redeem', gate: 'scan lift ticket scanner check in',
  conditions: 'lifts trails snow open closed status grooming groomer snowmaking weather maintenance work orders inspection fleet downtime handoff report', park: 'terrain park rails jumps boxes features freestyle halfpipe jib map', rentals: 'equipment skis boards boots rent', school: 'lessons instructors ski school availability instructor availability open dates',
  programs: 'clubs camps leagues teams', patrol: 'incident case injury first aid dispatch admin', people: 'customers guests search members',
  catalog: 'products prices passes items', money: 'sales refunds reports till drawer payments', workforce: 'staff schedule shifts hours kiosk time clock pin badge',
  availability: 'instructor calendar open dates times schedule days off private lessons',
  shop: 'online will-call willcall pickup web orders groups waitlist reprint tickets prices calendar pace report',
  messages: 'email text sms campaign newsletter send announce reminder unsubscribe marketing',
  inbox: 'chat message team staff internal conversation dm direct share link talk',
  documents: 'files forms policies manuals handbook pdf upload library repository',
  assets: 'fleet vehicles trucks groomers equipment maintenance parts inventory stock purchase orders vendors fuel inspection qr tag registration insurance warranty depreciation',
  waivers: 'waiver release liability sign signature signed guardian minor consent form',
  lostfound: 'lost found missing handed in phone wallet keys gloves goggles claim return guest services',
  myshifts: 'my schedule clock in out', calendar: 'mountain calendar events meetings training closures holidays groups what is happening this week month ics phone',
  settings: 'account setup password security two-step passkey profile mountain team logins billing subscription plan invoice menus',
  help: 'how to guide instructions support questions articles',
  // The municipal edition's apps (muni release 1).
  requests: 'resident report pothole streetlight complaint service request 311 call', notices: 'street notice text alert water main break boil residents affected',
  works: 'work orders jobs repairs crew service plans preventive maintenance recurring', assetprograms: 'programs hydrant flushing valve exercising inspections many assets',
  monthreport: 'monthly report council month totals cost hours department fund liquid fuels ms-965 response times',
  water: 'water main break valve shut customers out boil water repair history', sewer: 'sewer chapter 94 ch94 flow pump station run hours gpm mgd edu connections overflow sso dep',
  stormwater: 'stormwater ms4 permit outfall screening illicit discharge idde case minimum control measures education construction bmp good housekeeping training annual report',
  bulk: 'bulk trash pickup furniture appliance large item booking route order', buildings: 'building inspections life safety fire extinguisher sprinkler alarm elevator boiler backflow generator playground binder certificate vendor round calendar',
};
const RECENT_KEY = 'so.recent';
const FOLDED_KEY = 'so.nav.folded'; // the sections this device keeps folded (ids)
const COLLAPSED_KEY = 'so.nav.collapsed'; // '1' collapsed, '0' open; nothing kept: by the window's width
const MOVED_KEY = 'so.nav.moved'; // the "moved here" note: when this device first saw this menu, and whether it was dismissed
export const MOVED_NOTE_DAYS = 14;
const COLLAPSE_UNDER = 1280; // with no choice kept on this device, the menu starts collapsed under this width
const PEEK_MS = 150; // how long the pointer rests on the collapsed strip before the whole menu shows

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
const initials = (name) => String(name || '?').split('@')[0].split(/[\s._-]+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const isMac = () => /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');
const media = (q) => { try { return Boolean(window.matchMedia && window.matchMedia(q).matches); } catch (_) { return false; } };
const onPhone = () => media('(max-width: 860px)');
/** An address without its "#/": '#/patrol/cases?tab=records' -> 'patrol/cases?tab=records'. */
const bare = (hash) => String(hash || '').replace(/^#\/?/, '');
const hrefNow = () => bare(typeof location !== 'undefined' ? location.hash : '');
/** Tells the other modules something happened in the frame (nav:page, nav:edit-pins, nav:row-menu), on window. */
const tell = (name, detail) => window.dispatchEvent(new window.CustomEvent(name, { detail }));
/** True when the address `at` is the page `href` names: the same path, and every ?name=value of href is in it. */
export function samePage(href, at) {
  const [path, query = ''] = String(href).split('?');
  const [atPath, atQuery = ''] = String(at).split('?');
  if (path.replace(/\/$/, '') !== atPath.replace(/\/$/, '')) return false;
  let want; let have;
  try { want = new URLSearchParams(query); have = new URLSearchParams(atQuery); } catch (_) { return false; }
  for (const [k, v] of want) if (have.get(k) !== v) return false;
  return true;
}

// ---------------------------------------------------------------- theme
// Light, Dark, or the same as this device (the default). theme.js applies it before the page paints; this keeps it in step.
export const THEME_KEY = 'verdynt.theme';
const THEMES = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['device', 'Device', 'device']];
const THEME_SAYS = { light: 'Light', dark: 'Dark', device: 'Same as this device' };
export function themePick() { const v = read(THEME_KEY, null); return v === 'light' || v === 'dark' ? v : 'device'; }
const deviceDark = () => media('(prefers-color-scheme: dark)');
export function applyTheme(pick = themePick()) {
  const dark = pick === 'dark' || (pick === 'device' && deviceDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
export function setTheme(pick) {
  if (pick === 'device') { try { localStorage.removeItem(THEME_KEY); } catch (_) { /* this device only, best effort */ } } else write(THEME_KEY, pick);
  applyTheme(pick);
  window.dispatchEvent(new Event('theme:change'));
}

/**
 * The three theme choices in one row. In the account menu (a role=menu) each is a menuitemradio; in the phone's account
 * sheet they are radios in a radiogroup. Choosing one changes the theme at once and leaves the menu open, so the
 * person sees it happen.
 */
function themeRow(inMenu) {
  const choices = THEMES.map(([id, text]) => {
    const b = h('button', { type: 'button', role: inMenu ? 'menuitemradio' : 'radio', dataset: { theme: id }, class: 'theme-choice', 'aria-label': THEME_SAYS[id] }, text);
    b.addEventListener('click', () => setTheme(id));
    return b;
  });
  const root = h('div', { class: 'theme-seg', role: inMenu ? 'group' : 'radiogroup', 'aria-label': 'Theme' }, choices);
  const mark = () => { const now = themePick(); for (const b of choices) b.setAttribute('aria-checked', String(b.dataset.theme === now)); };
  const onChange = () => { if (!root.isConnected) { window.removeEventListener('theme:change', onChange); return; } mark(); };
  window.addEventListener('theme:change', onChange);
  mark();
  return root;
}

/** The version at the foot of the account menu: "Verdynt/OS 2026.11.21", linking to What's new. */
function whoVersion(inMenu) {
  const a = h('a', { class: 'who-version', href: '#/help/whats-new', role: inMenu ? 'menuitem' : null }, 'Verdynt/OS');
  fetch('/version').then((r) => r.json()).then((v) => { if (v && v.version) a.textContent = `Verdynt/OS ${v.version}`; }).catch(() => {});
  return a;
}

/**
 * What the menu shows for this person. views: [[key, label]] already filtered for them; menu: ctx.me.menu (the role's
 * menu, as managers set it); links: ctx.me.menu_links (its shortcuts to a page inside an app).
 * home: Today, Inbox, Calendar, My shifts. sections: every other app they may open, each in its one section ("More"
 * for an app that has none yet). apps: the role's menu, in its order, without Home. pins: that menu as starting pins
 * ({ id, label, href, app, icon? }). bar: the phone bar's four places. account: Settings and Help, for the account menu.
 */
export function menuPlan(views, menu, links = {}) {
  const keys = views.map(([k]) => k);
  const names = new Map(views);
  const has = (k) => keys.includes(k);
  // A shortcut (a page inside an app, such as Patrol's Records requests) shows when the person may open its app.
  const usable = (k) => (links && links[k] ? has(links[k].app) : has(k));
  const home = HOME.filter(has);
  const account = ACCOUNT.filter(has);
  const rest = keys.filter((k) => !HOME.includes(k) && !ACCOUNT.includes(k));
  const sections = sectionsFor().map(([name, id, ks]) => ({ name, id, keys: ks.filter((k) => rest.includes(k)) })).filter((s) => s.keys.length);
  const extra = rest.filter((k) => !sections.some((s) => s.keys.includes(k))); // a new app shows somewhere rather than nowhere
  if (extra.length) sections.push({ name: 'More', id: 'more', keys: extra });
  const apps = menu && Array.isArray(menu.apps) ? [...new Set(menu.apps)].filter((k) => usable(k) && !HOME.includes(k) && !ACCOUNT.includes(k)) : [];
  const pinOf = (k) => (links && links[k]
    ? { id: k, label: links[k].label, href: links[k].href, app: links[k].app, ...(links[k].icon ? { icon: links[k].icon } : {}) }
    : { id: k, label: names.get(k), href: k, app: k });
  const pins = apps.map(pinOf);
  const start = menu && menu.start && has(menu.start) && menu.start !== 'inbox' ? menu.start : null;
  const bar = defaultBar({ start, pins, home, names });
  return { home, apps, pins, sections, account, bar, start };
}

/** The phone bar when the person has not chosen one: the screen their menu opens on, their pins, then Home, to make four. */
function defaultBar({ start, pins, home, names }) {
  const place = (k) => ({ label: names.get(k), href: k, app: k });
  const all = [...(start ? [place(start)] : []), ...pins, ...PHONE_HOME.filter((k) => home.includes(k)).map(place)];
  const seen = new Set();
  return all.filter((p) => (seen.has(p.href) ? false : seen.add(p.href))).slice(0, 4).map(({ label: text, href, app, icon: ico }) => ({ label: text, href, app, ...(ico ? { icon: ico } : {}) }));
}

/** Whether the "moved here" note is still due on this device: 14 days from the first time it loaded this menu. */
export function movedHereDue(now = Date.now()) {
  let kept = null;
  try { kept = JSON.parse(read(MOVED_KEY, 'null')); } catch (_) { kept = null; }
  if (!kept || !kept.first) { kept = { first: now, done: false }; write(MOVED_KEY, JSON.stringify(kept)); }
  return !kept.done && now - kept.first < MOVED_NOTE_DAYS * 86400000;
}
const movedHereDone = () => { let first = Date.now(); try { first = JSON.parse(read(MOVED_KEY, 'null')).first || first; } catch (_) { /* a new record */ } write(MOVED_KEY, JSON.stringify({ first, done: true })); };

/**
 * Builds the page frame. views: [[key, label]] already filtered for this person; menu: ctx.me.menu; links:
 * ctx.me.menu_links; nav: ctx.me.nav when the server sent the person's own pins ({ pins, bar }), so the first paint
 * already has them.
 * Returns { shell, plan, canEdit, slots: { star }, setCurrent(key, params), setWhere({ part, help }), setPins(pins, bar),
 * setBadge(key, n, { dot, says, alert }), setNew(items), addCommands(fn), openPalette(), openSheet() }.
 */
export function buildFrame({ views, main, signOut, menu = null, links = {}, nav = null }) {
  const me = ctx.me;
  const byKey = new Map(views);
  const viewKeys = views.map(([k]) => k);
  ctx.views = viewKeys;
  const plan = menuPlan(views, menu, links);
  const terminal = Boolean(me.terminal) || Boolean(readTerminal());
  // A session opened by PIN on a shared computer and the ski area's read-only login keep the role's menu as it is.
  const canEdit = !me.terminal && me.role !== 'area';
  const appItem = (k) => ({ label: byKey.get(k), href: k, app: k });
  /** Only pins and bar places whose app this person may open, in the shape the frame draws. */
  const usablePins = (list) => (Array.isArray(list) ? list : []).filter((p) => p && p.href && byKey.has(p.app) && !ACCOUNT.includes(p.app)).map((p) => ({ id: String(p.id || p.href), label: String(p.label || byKey.get(p.app)), href: bare(p.href), app: p.app, ...(p.icon ? { icon: p.icon } : {}) }));

  let pins = me.role === 'area' ? [] : nav && Array.isArray(nav.pins) ? usablePins(nav.pins) : plan.pins;
  // The phone bar the person chose: an array (an empty one too: only Menu), or null for the default.
  let bar = nav && Array.isArray(nav.bar) ? usablePins(nav.bar).slice(0, 4) : null;
  let pinsLive = false; // true once pins.js has called setPins: only then is there someone to answer Edit
  const barNow = () => bar || defaultBar({ start: plan.start, pins, home: plan.home, names: byKey });

  const shell = h('div', { class: 'shell' });
  let currentKey = null;
  let currentSection = null;
  let where = { key: null, href: null, label: null };
  const badges = new Map(); // app key -> { n, dot, says, alert }
  const commandFns = []; // palette commands other modules add (addCommands)

  // ---- every link the frame draws to a page, so the open page and the counts can be marked wherever it shows.
  // zone: 'list' (Home and the sections), 'pins', 'bar', 'top', 'sheet'. kind: 'app' (the app's own row) or 'pin'.
  let shown = [];
  const track = (el, item, zone, kind) => { shown.push({ el, app: item.app, href: item.href, zone, kind }); return el; };
  const forget = (zone) => { shown = shown.filter((s) => s.zone !== zone); };
  /** The pin or bar place that names this exact page (the one with the most of the address in it), or null. */
  function pinHere() {
    const at = hrefNow();
    const hits = [...pins, ...barNow()].filter((p) => p.app === currentKey && p.href !== p.app && samePage(p.href, at));
    return hits.sort((a, b) => b.href.length - a.href.length)[0] || null;
  }
  /** Marks the open page: its app's row in its section, and among the pins the one that names the page most exactly. */
  function mark() {
    const exact = pinHere();
    const on = (s) => (s.kind === 'app' ? s.app === currentKey : exact ? s.href === exact.href : s.href === currentKey);
    for (const s of shown) { if (on(s)) s.el.setAttribute('aria-current', 'page'); else s.el.removeAttribute('aria-current'); }
    more.classList.toggle('on', Boolean(currentKey) && !barNow().some((p) => (exact ? p.href === exact.href : p.href === currentKey)));
  }

  /** Draws (or removes) the count on one link. A count is said once: hidden from screen readers, and in the link's description. */
  function paintBadge(el, st) {
    let b = [...el.children].find((c) => c.classList && c.classList.contains('nav-badge'));
    if (!st || !st.n) { if (b) b.remove(); el.removeAttribute('aria-description'); return; }
    if (!b) { b = h('span', { class: 'nav-badge', 'aria-hidden': 'true' }); el.append(b); }
    b.classList.toggle('dot', Boolean(st.dot));
    b.classList.toggle('alert', Boolean(st.alert));
    b.textContent = st.dot ? '' : st.n > 99 ? '99+' : String(st.n);
    el.setAttribute('aria-description', st.dot ? st.says : `${st.n} ${st.says}`);
  }
  /** Puts every count where its app shows at its own address. A pin to a page inside an app gets none. */
  function paintBadges(zone) {
    for (const s of shown) if ((!zone || s.zone === zone) && s.href === s.app) paintBadge(s.el, badges.get(s.app));
  }

  /**
   * Right-click (or a long press on a phone) on a menu row or tile asks pins.js for the Pin / Unpin menu: the frame
   * stops the browser's own menu and says which row, and shows nothing itself. Not offered where the menu cannot be changed.
   */
  let lastAsk = 0;
  function askRowMenu(item, x, y) {
    if (Date.now() - lastAsk < 400) return; // a long press also fires contextmenu on some phones: once is enough
    lastAsk = Date.now();
    tell('nav:row-menu', { key: item.app, href: item.href, label: item.label, x, y, pinned: pins.some((p) => p.href === item.href) });
  }
  /** A long press on a touch screen: after half a second without moving, do(x, y); the tap that follows is swallowed. */
  function longPress(el, act) {
    let timer = null; let at = null; let fired = false;
    const stop = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      fired = false; at = [e.clientX, e.clientY];
      timer = setTimeout(() => { fired = true; act(at[0], at[1]); }, 500);
    });
    el.addEventListener('pointermove', (e) => { if (timer && at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > 10) stop(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
    el.addEventListener('click', (e) => { if (fired) { e.preventDefault(); e.stopPropagation(); fired = false; } }, true);
  }
  function rowMenu(el, item) {
    if (!canEdit || ACCOUNT.includes(item.app)) return el;
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); askRowMenu(item, e.clientX, e.clientY); });
    longPress(el, (x, y) => askRowMenu(item, x, y));
    return el;
  }
  const askEdit = (forBar) => tell('nav:edit-pins', { bar: Boolean(forBar) });

  /** One row of the side menu: the icon, the name, and room for a count. */
  const row = (item, zone, kind) => h('li', null, rowMenu(track(
    h('a', { href: `#/${item.href}`, class: 'nav-row', dataset: { key: item.app, ...(kind === 'pin' ? { pin: item.id } : {}) } }, icon(item.icon || item.app, 18), h('span', { class: 'nav-label' }, item.label)),
    item, zone, kind), item));

  // ---- sections: all open; a label folds its section, and this device remembers the ones it folded
  const foldedNow = () => { try { const v = JSON.parse(read(FOLDED_KEY, '[]')); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  const keepFolded = (id, folded) => { const now = new Set(foldedNow()); if (folded) now.add(id); else now.delete(id); write(FOLDED_KEY, JSON.stringify([...now])); };
  const folds = []; // { id, btn, body, keys }
  function section(s) {
    const bodyId = `nav-s-${s.id}`;
    const btn = h('button', { type: 'button', class: 'nav-fold', 'aria-expanded': 'true', 'aria-controls': bodyId, dataset: { section: s.id } },
      h('span', { class: 'nav-fold-text' }, s.name), h('span', { class: 'nav-chev', 'aria-hidden': 'true' }));
    const body = h('ul', { class: 'nav-items', id: bodyId }, s.keys.map((k) => row(appItem(k), 'list', 'app')));
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return; // the section holding the open page stays open
      keepFolded(s.id, btn.getAttribute('aria-expanded') === 'true');
      paintFolds();
    });
    folds.push({ id: s.id, btn, body, keys: s.keys });
    return h('div', { class: 'nav-sec', dataset: { section: s.id } }, h('h2', { class: 'nav-head' }, btn), body);
  }
  /** Open or folded, from what this device kept. The section holding the open page is always open and says why. */
  function paintFolds() {
    const kept = foldedNow();
    for (const f of folds) {
      const held = Boolean(currentKey) && f.keys.includes(currentKey);
      const open = held || !kept.includes(f.id);
      f.btn.setAttribute('aria-expanded', String(open));
      if (held) { f.btn.setAttribute('aria-disabled', 'true'); f.btn.title = 'The page you are on is in this section, so it stays open'; } else { f.btn.removeAttribute('aria-disabled'); f.btn.removeAttribute('title'); }
      f.body.hidden = !open;
    }
  }

  // ---- the side menu
  const name = me.login_name || me.username || me.email || '';
  const shortName = String(name).split('@')[0] || name;
  const roleText = roleName(me);
  const collapseKeys = isMac() ? '⌘\\' : 'Ctrl+\\';
  const toggle = h('button', { type: 'button', class: 'rail-toggle', 'aria-controls': 'nav-list' }, icon('collapse', 16));
  // A ski area keeps the mountain mark; a municipality has the wordmark only (2026.11.20), and its initials stand in
  // for a mark where there is no room for words (the collapsed strip).
  const org = h('div', { class: 'rail-org' },
    isMuni() ? h('span', { class: 'org-mono', 'aria-hidden': 'true' }, initials(me.tenant_name)) : h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: '', width: '32', height: '18' }),
    h('div', { class: 'org-text' }, h('strong', { title: me.tenant_name }, me.tenant_name), h('span', null, 'Verdynt/OS')),
    toggle);

  const editBtn = h('button', { type: 'button', class: 'nav-edit', hidden: true, 'aria-label': 'Edit your pinned pages' }, 'Edit');
  editBtn.addEventListener('click', () => askEdit(false));
  const pinList = h('ul', { class: 'nav-items' });
  const pinBox = h('div', { class: 'nav-sec nav-pins', hidden: true }, h('div', { class: 'nav-head' }, h('h2', { class: 'nav-title' }, 'Pinned'), editBtn), pinList);
  const list = h('nav', { class: 'nav', id: 'nav-list', 'aria-label': 'Main' },
    plan.home.length ? h('ul', { class: 'nav-items nav-home' }, plan.home.map((k) => row(appItem(k), 'list', 'app'))) : null,
    pinBox,
    plan.sections.map(section));

  const avatar = () => h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
  const acctBtn = h('button', { type: 'button', class: 'acct', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': `Account: ${name}, ${roleText}`, title: me.email || name },
    avatar(), h('span', { class: 'who-text' }, h('b', null, shortName), h('span', null, roleText)), icon('chevron', 16));
  const foot = h('div', { class: 'rail-foot' }, acctBtn);
  const rail = h('aside', { class: 'rail', 'aria-label': 'Menu' }, org, list, foot);

  /** Draws Pinned in the side menu and the phone bar from the pins and bar there are now. */
  function drawPins() {
    forget('pins');
    clear(pinList).append(...pins.map((p) => row(p, 'pins', 'pin')));
    pinBox.hidden = !pins.length;
    editBtn.hidden = !(canEdit && pinsLive);
    drawBar();
    redrawSheet();
    paintBadges('pins');
    mark();
  }

  // ---- collapsed: a 64 px strip. With no choice kept on this device it starts collapsed under 1280 px.
  const keptCollapsed = () => { const v = read(COLLAPSED_KEY, null); return v === '1' ? true : v === '0' ? false : null; };
  const isCollapsed = () => shell.classList.contains('collapsed');
  function paintCollapsed() {
    const kept = keptCollapsed();
    const c = kept === null ? (typeof window !== 'undefined' && window.innerWidth < COLLAPSE_UNDER) : kept;
    shell.classList.toggle('collapsed', c);
    if (!c) rail.classList.remove('peek');
    toggle.setAttribute('aria-expanded', String(!c));
    const says = c ? 'Keep the menu open' : 'Collapse the menu';
    toggle.setAttribute('aria-label', says);
    toggle.title = `${says} (${collapseKeys})`;
    clear(toggle).append(icon(c ? 'expand' : 'collapse', 16));
  }
  function setCollapsed(c) { write(COLLAPSED_KEY, c ? '1' : '0'); paintCollapsed(); }
  toggle.addEventListener('click', () => setCollapsed(!isCollapsed()));

  // Pointing at the strip for a moment, or moving keyboard focus into it, shows the whole menu over the page (the page
  // does not move). It goes back to a strip when the pointer and the focus have both left. A tap on a touch screen never
  // opens it: the tap goes to the icon.
  let peekTimer = null; let pointerIn = false;
  const focusIn = () => {
    const a = document.activeElement;
    if (!a || !rail.contains(a)) return false;
    try { return a.matches(':focus-visible'); } catch (_) { return true; } // a browser without :focus-visible: any focus counts
  };
  const peek = (on) => { clearTimeout(peekTimer); if (!on || (isCollapsed() && !menuOpen(acctBtn))) rail.classList.toggle('peek', on); };
  const settlePeek = () => { clearTimeout(peekTimer); peekTimer = setTimeout(() => { if (!pointerIn && !focusIn()) peek(false); }, 180); };
  rail.addEventListener('pointerenter', (e) => { if (e.pointerType === 'touch') return; pointerIn = true; clearTimeout(peekTimer); peekTimer = setTimeout(() => peek(true), PEEK_MS); });
  rail.addEventListener('pointerleave', () => { pointerIn = false; settlePeek(); });
  rail.addEventListener('focusin', () => { if (focusIn()) peek(true); });
  rail.addEventListener('focusout', () => settlePeek());
  rail.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rail.classList.contains('peek') && !menuOpen(acctBtn)) { pointerIn = false; peek(false); main.focus({ preventScroll: true }); } });

  // ---- small menus that open from a button (the account menu, + New): role=menu, arrow keys, Escape, focus returns
  const openMenus = new Map(); // button -> close()
  const menuOpen = (btn) => openMenus.has(btn);
  /**
   * Opens `build(close)` as a menu beside `btn`. Up and Down move through its items (Home and End jump to the ends),
   * Escape closes it and returns to the button, Tab or a press anywhere else closes it. A link in it closes it too.
   */
  function popMenu(btn, { cls, says, build, host = btn.parentElement }) {
    if (openMenus.has(btn)) { openMenus.get(btn)(true); return null; }
    const pop = h('div', { class: `pop-menu ${cls}`, role: 'menu', 'aria-label': says });
    const items = () => [...pop.querySelectorAll('[role=menuitem], [role=menuitemradio]')].filter((el) => !el.hidden && !el.closest('[hidden]'));
    function close(focusBack) {
      pop.remove(); openMenus.delete(btn);
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onOutside, true);
      if (focusBack && btn.isConnected) btn.focus();
      settlePeek();
    }
    const onOutside = (e) => { if (!pop.contains(e.target) && !btn.contains(e.target)) close(false); };
    pop.addEventListener('keydown', (e) => {
      const all = items(); const at = all.indexOf(document.activeElement);
      const to = { ArrowDown: all[(at + 1) % all.length], ArrowUp: all[(at - 1 + all.length) % all.length], Home: all[0], End: all[all.length - 1] }[e.key];
      if (to) { e.preventDefault(); to.focus({ preventScroll: true }); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } else if (e.key === 'Tab') close(false);
    });
    pop.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(false); });
    pop.append(...[build(close)].flat().filter(Boolean));
    host.append(pop);
    openMenus.set(btn, close);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    const first = items()[0];
    if (first) first.focus({ preventScroll: true });
    return pop;
  }

  // ---- the account menu: everything that used to be pinned at the bottom of the side menu
  // A patroller's Patrol access (their level and features), read once when the account menu or Jump to first needs it.
  let patrolInfo = null;
  let patrolAsked = false;
  async function loadPatrol() {
    try { patrolInfo = JSON.parse(sessionStorage.getItem('so.patrol.me') || 'null'); } catch (_) { patrolInfo = null; }
    if (patrolInfo) return;
    try { const { get } = await import('./api.js'); patrolInfo = await get('/patrol/me'); } catch (_) { patrolInfo = null; }
  }
  const mayOpen = (k) => byKey.has(k);
  /** Where "Settings" goes for someone who has more than their own profile there, or null when they have only that. */
  function settingsHome() {
    if (!mayOpen('settings') || me.role === 'area') return null;
    if (isManager()) return '#/settings/organization';
    if (me.role === 'instructor' && schoolCan('director') && (!me.modules || me.modules.includes('school'))) return '#/settings/school';
    if ((me.role === 'patrol' || me.on_patrol) && (me.patrol_lead || (patrolInfo && (patrolInfo.access_level === 'admin' || (patrolInfo.features || []).includes('manage_settings'))))) return '#/settings/patrol';
    return null;
  }
  /**
   * The account's rows, for the menu on a computer (inMenu) and the sheet on a phone: the person, their profile,
   * Settings, Help and What's new (with its dot), the theme, Switch person on a shared computer, Sign out, the version.
   */
  function accountRows(close, inMenu) {
    const item = inMenu ? 'menuitem' : null;
    const go = (href, ico, text, extra) => h('a', { href, class: 'menu-row', role: item, 'aria-current': bare(href) === hrefNow() ? 'page' : null }, icon(ico, 18), h('span', null, text), extra || null);
    const act = (ico, text, run) => { const b = h('button', { type: 'button', class: 'menu-row', role: item }, icon(ico, 18), h('span', null, text)); b.addEventListener('click', () => { close(false); run(); }); return b; };
    const news = badges.get('help');
    const settings = settingsHome();
    return [
      h('div', { class: 'menu-who' }, avatar(), h('span', { class: 'who-text' }, h('b', null, name), h('span', null, `${roleText}, ${me.tenant_name}`))),
      h('hr', { role: inMenu ? 'separator' : null }),
      mayOpen('settings') ? go('#/settings/profile', 'people', 'Your profile and sign-in') : null,
      settings ? go(settings, 'settings', 'Settings') : null,
      mayOpen('help') ? go('#/help', 'help', "Help and What's new", news && news.n ? h('span', { class: 'nav-badge dot', role: 'img', 'aria-label': 'new' }) : null) : null,
      h('p', { class: 'menu-label', 'aria-hidden': 'true' }, 'Theme'),
      themeRow(inMenu),
      h('hr', { role: inMenu ? 'separator' : null }),
      // A shared counter computer: the next person switches in with their PIN (signing out shows the PIN screen there).
      terminal ? act('swap', 'Switch person', () => signOut()) : null,
      act('signout', 'Sign out', () => signOut()),
      whoVersion(inMenu),
    ];
  }
  function openAccount() {
    endMovedNote(false);
    rail.classList.remove('peek'); // collapsed: the strip stays a strip and the menu opens beside the avatar
    popMenu(acctBtn, { cls: 'acct-menu', says: 'Account', build: (close) => accountRows(close, true), host: foot });
    // A patroller's Settings row depends on their Patrol access. It is read once, the first time the menu opens, and the
    // menu is drawn again only if that adds the row.
    if (menuOpen(acctBtn) && (me.role === 'patrol' || me.on_patrol) && !isManager() && !patrolAsked && !settingsHome()) {
      patrolAsked = true;
      loadPatrol().then(() => { if (menuOpen(acctBtn) && settingsHome()) { openMenus.get(acctBtn)(false); openAccount(); } });
    }
  }
  acctBtn.addEventListener('click', openAccount);

  // ---- for 14 days: "Settings, Help and Sign out moved here."
  let movedNote = null;
  function endMovedNote(dismissed) { if (movedNote) { movedNote.remove(); movedNote = null; } if (dismissed) movedHereDone(); }
  function movedHere(cls) {
    const got = h('button', { type: 'button', class: 'btn small' }, 'Got it');
    const note = h('div', { class: `moved-here ${cls}`, role: 'note' }, h('span', null, 'Settings, Help and Sign out moved here.'), got);
    got.addEventListener('click', () => { note.remove(); endMovedNote(true); });
    return note;
  }
  if (movedHereDue()) { movedNote = movedHere('by-rail'); foot.append(movedNote); }

  // ---- the top bar: where you are on the left, actions on the right
  const whereApp = h('span', { class: 'where-app' });
  const whereSep = h('span', { class: 'where-sep', 'aria-hidden': 'true', hidden: true }, '›');
  const wherePart = h('span', { class: 'where-part', hidden: true });
  const whereBox = h('div', { class: 'top-where' }, whereApp, whereSep, wherePart);
  const star = h('span', { class: 'top-star' }); // pins.js fills it (frame.slots.star)
  const jump = h('button', { type: 'button', class: 'top-jump', 'aria-label': 'Jump to a page, record or action', 'aria-keyshortcuts': 'Control+K' }, icon('search', 16), h('span', { class: 'top-jump-text' }, 'Jump to'), h('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  const newSlot = h('div', { class: 'top-new', hidden: true });
  // "Guest needs help": the same call as Mountain status and the Gate make, for the same people (staffhelp.js decides).
  // A ski area's button: a municipality has no patrol to call.
  const sos = !isMuni() && mayAskForHelp() ? h('button', { type: 'button', class: 'top-sos', 'data-act': 'staff-help', 'aria-label': 'Guest needs help here' }, icon('plus', 16), h('span', null, 'Guest needs help')) : null;
  if (sos) sos.addEventListener('click', () => openStaffHelp());
  // Ask: the assistant's side panel, loaded the first time it is opened. Hidden until the server says it is on.
  const openAsk = () => import('./assistant.js').then((m) => m.openAssistant({ page: currentKey, views: viewKeys }));
  const ask = h('button', { type: 'button', class: 'top-btn top-ask', 'aria-label': 'Ask the assistant', title: 'Ask the assistant', hidden: true }, icon('ask', 18));
  ask.addEventListener('click', openAsk);
  if (me.role !== 'area') import('./assistant.js').then((m) => m.assistantOn()).then((yes) => { ask.hidden = !yes; }).catch(() => {});
  const have = (k) => byKey.has(k);
  const inbox = have('inbox') ? track(h('a', { href: '#/inbox', class: 'top-btn top-inbox', dataset: { key: 'inbox' }, 'aria-label': 'Inbox', title: 'Inbox' }, icon('inbox', 18)), appItem('inbox'), 'top', 'app') : null;
  const help = h('a', { href: '#/help', class: 'top-btn top-help', 'aria-label': 'Help', title: 'Help', hidden: true }, icon('help', 18));
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'top-brand' }, isMuni() ? null : h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: '', width: '32', height: '18' }), h('strong', null, me.tenant_name)),
    whereBox, star, jump, newSlot, sos, ask, inbox, help);

  // ---- + New: what this person may create (newmenu.js gives the list through setNew)
  let newItems = [];
  const newBtn = h('button', { type: 'button', class: 'btn primary top-new-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('plus', 16), h('span', null, 'New'));
  const newFab = h('button', { type: 'button', class: 'new-fab', 'aria-label': 'New', 'aria-haspopup': 'dialog', hidden: true }, icon('plus', 24));
  newSlot.append(newBtn);
  const newRow = (it, role) => h('a', { href: `#/${bare(it.href)}`, class: 'menu-row', role, dataset: { new: it.id } }, icon(it.icon || it.app, 18), h('span', null, it.label));
  newBtn.addEventListener('click', () => popMenu(newBtn, { cls: 'new-menu', says: 'New', build: () => newItems.map((it) => newRow(it, 'menuitem')) }));
  /** On a phone: the same list in a sheet, with the open app's own things first. */
  newFab.addEventListener('click', () => {
    const mine = newItems.filter((it) => it.app === currentKey);
    const rest = newItems.filter((it) => it.app !== currentKey);
    sheet('New', 'new-sheet', () => h('div', { class: 'sheet-body' }, h('div', { class: 'sheet-rows' }, mine.map((it) => newRow(it, null))), mine.length && rest.length ? h('hr') : null, h('div', { class: 'sheet-rows' }, rest.map((it) => newRow(it, null)))));
  });
  /** The round button shows on pages whose app has something to create, unless the page has a floating button of its own. */
  function paintNew() {
    newSlot.hidden = !newItems.length;
    newFab.hidden = !newItems.some((it) => it.app === currentKey) || Boolean(main.querySelector && main.querySelector('.fab'));
  }
  function setNew(items) {
    newItems = (Array.isArray(items) ? items : []).filter((it) => it && it.label && it.href);
    if (!newItems.length && openMenus.has(newBtn)) openMenus.get(newBtn)(false);
    paintNew();
  }

  // ---- phone: a bottom bar with the person's four places and Menu, and a sheet with everything
  const more = h('button', { type: 'button', class: 'tab tab-menu', 'aria-haspopup': 'dialog' }, icon('menu', 22), h('span', null, 'Menu'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Quick links' }, more);
  function drawBar() {
    forget('bar');
    const tabs = barNow().map((p) => {
      const a = track(h('a', { href: `#/${p.href}`, class: 'tab', dataset: { key: p.app }, title: p.label, 'aria-label': p.label }, icon(p.icon || p.app, 22), h('span', { class: 'tab-text', 'aria-hidden': 'true' }, barLabel(p))), p, 'bar', 'pin');
      // A long press (or right-click) on the bar asks to choose what is on it.
      if (canEdit) { a.addEventListener('contextmenu', (e) => { e.preventDefault(); if (pinsLive) askEdit(true); }); longPress(a, () => { if (pinsLive) askEdit(true); }); }
      return a;
    });
    clear(tabbar).append(...tabs, more);
    paintBadges('bar');
    paintMenuDot();
  }
  /** The Menu button carries a dot when something new is in the sheet and not on the bar (What's new, in the account). */
  function paintMenuDot() {
    const news = [...badges].some(([k, st]) => st.dot && st.n && !barNow().some((p) => p.href === k));
    more.classList.toggle('has-new', news);
    if (news) more.setAttribute('aria-description', 'Something new in Help'); else more.removeAttribute('aria-description');
    const dot = Boolean(badges.get('help') && badges.get('help').n);
    acctBtn.classList.toggle('has-new', dot);
    if (dot) acctBtn.setAttribute('aria-description', 'Something new in Help'); else acctBtn.removeAttribute('aria-description');
  }

  /** A sheet over the page (the phone's Menu, the account, + New). build(close) returns its content. The whole sheet scrolls as one. */
  const sheets = []; // open sheets, the top one last: Escape closes only that one
  function sheet(title, cls, build) {
    const previous = document.activeElement;
    const closeBtn = h('button', { type: 'button', class: 'sheet-close', 'aria-label': `Close ${title.toLowerCase()}` }, icon('close', 20));
    const titleId = `sheet-${Math.random().toString(36).slice(2, 7)}`;
    const box = h('div', { class: `dialog menu-sheet ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    const overlay = h('div', { class: `overlay menu-overlay ${cls}-overlay` }, box);
    const self = { close };
    function close(focusBack = true) {
      if (!overlay.isConnected) return;
      overlay.remove(); document.removeEventListener('keydown', onKey);
      sheets.splice(sheets.indexOf(self), 1);
      if (cls === 'phone-menu') forget('sheet');
      if (focusBack && previous && previous.isConnected && previous.focus) previous.focus();
    }
    const onKey = (e) => { if (e.key === 'Escape' && sheets[sheets.length - 1] === self) { e.stopPropagation(); close(); } };
    box.append(h('header', null, h('h2', { id: titleId }, title), closeBtn), build(close));
    // A link in a sheet goes to its page: every sheet closes on the way.
    box.addEventListener('click', (e) => { if (e.target.closest('a[href]')) for (const s of [...sheets]) s.close(false); });
    closeBtn.addEventListener('click', () => close());
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    sheets.push(self);
    closeBtn.focus();
    return { close, box };
  }

  /** A tile in the phone's Menu sheet. */
  const tile = (item, kind) => rowMenu(track(h('a', { href: `#/${item.href}`, class: 'sheet-item', dataset: { key: item.app, ...(kind === 'pin' ? { pin: item.id } : {}) } }, icon(item.icon || item.app, 22), h('span', { class: 'sheet-item-text' }, item.label)), item, 'sheet', kind), item);
  const grid = (items, kind) => h('div', { class: 'sheet-grid' }, items.map((it) => tile(it, kind)));

  /**
   * The phone's Menu: a search box, Guest needs help, Home, Pinned, then every section as a grid, all open, and one
   * account row at the bottom.
   */
  let menuSheet = null; // the phone Menu sheet while it is open: { box, close }
  /** The Menu sheet's content. Drawn when it opens, and again when the pins change while it is open. */
  function menuBody(close) {
    const searchBox = h('button', { type: 'button', class: 'sheet-search' }, icon('search', 18), h('span', null, 'Jump to a page, record or action'));
    searchBox.addEventListener('click', () => { close(false); openPalette(); });
    const helpHere = sos ? h('button', { type: 'button', class: 'btn staff-help-btn sheet-help-here', 'data-act': 'staff-help' }, h('span', { class: 'sh-plus', 'aria-hidden': 'true' }, '+'), h('span', null, 'Guest needs help here')) : null;
    if (helpHere) helpHere.addEventListener('click', () => { close(false); openStaffHelp(); });
    const edit = canEdit && pinsLive ? h('button', { type: 'button', class: 'nav-edit', 'aria-label': 'Edit your pinned pages' }, 'Edit') : null;
    if (edit) edit.addEventListener('click', () => { close(false); askEdit(false); });
    const acct = h('button', { type: 'button', class: 'sheet-acct', 'aria-haspopup': 'dialog' }, avatar(), h('span', { class: 'who-text' }, h('b', null, shortName), h('span', null, `${roleText}. Settings, help, theme, sign out`)),
      badges.get('help') && badges.get('help').n ? h('span', { class: 'nav-badge dot', role: 'img', 'aria-label': 'Something new in Help' }) : null, icon('chevron', 16));
    acct.addEventListener('click', () => { endMovedNote(false); sheet('Account', 'acct-sheet', (shut) => h('div', { class: 'sheet-body sheet-rows' }, accountRows(() => { shut(false); close(false); }, false))); });
    return h('div', { class: 'sheet-body' }, searchBox, helpHere,
      plan.home.length ? h('div', { class: 'sheet-sec sheet-home' }, grid(plan.home.map(appItem), 'app')) : null,
      pins.length ? h('div', { class: 'sheet-sec sheet-pins' }, h('div', { class: 'sheet-label' }, h('h3', null, 'Pinned'), edit), grid(pins, 'pin')) : null,
      plan.sections.map((sec) => h('div', { class: 'sheet-sec', dataset: { section: sec.id } }, h('div', { class: 'sheet-label' }, h('h3', null, sec.name)), grid(sec.keys.map(appItem), 'app'))),
      movedHereDue() ? movedHere('in-sheet') : null,
      acct);
  }
  function openSheet() {
    forget('sheet');
    const s = sheet('Menu', 'phone-menu', menuBody);
    menuSheet = s;
    paintBadges('sheet');
    mark();
    return s;
  }
  /** The pins changed while the Menu sheet is open (a tile pinned by a long press): draw its content again, in place. */
  function redrawSheet() {
    if (!menuSheet || !menuSheet.box.isConnected) { menuSheet = null; return; }
    const old = menuSheet.box.querySelector(':scope > .sheet-body');
    if (!old) return;
    forget('sheet');
    old.replaceWith(menuBody(menuSheet.close));
    paintBadges('sheet');
  }
  more.addEventListener('click', openSheet);

  // ---- palette
  function actions() {
    const list = [];
    if (isManager()) list.push({ id: 'kiosk', title: 'Open the time clock kiosk page', hint: 'New tab', icon: 'clock', words: 'kiosk tablet punch', run: () => window.open('/kiosk', '_blank', 'noopener') });
    if (!onPhone()) list.push({ id: 'collapse', title: isCollapsed() ? 'Keep the menu open' : 'Collapse the menu', hint: collapseKeys, icon: isCollapsed() ? 'expand' : 'collapse', words: 'menu side bar sidebar collapse hide show narrow wide icons', run: () => setCollapsed(!isCollapsed()) });
    for (const [id, , ico] of THEMES) list.push({ id: `theme-${id}`, title: id === 'device' ? 'Theme: same as this device' : `Theme: ${id}`, hint: themePick() === id ? 'On now' : '', icon: ico, words: 'theme dark light mode night day colors', run: () => setTheme(id) });
    if (!ask.hidden) list.push({ id: 'ask', title: 'Ask the assistant', hint: '', icon: 'ask', words: 'assistant question how do i ai chat', run: () => openAsk() });
    if (terminal) list.push({ id: 'switch', title: 'Switch person', hint: '', icon: 'swap', words: 'pin shared terminal change user', run: () => signOut() });
    list.push({ id: 'out', title: 'Sign out', hint: '', icon: 'signout', words: 'log out leave', run: () => signOut() });
    return list;
  }
  /** Commands from other modules (pins.js: Pin this page; newmenu.js: New work order), asked for each time Jump to opens. */
  function added() {
    const out = [];
    for (const fn of commandFns) {
      let items = [];
      try { items = fn() || []; } catch (_) { items = []; }
      for (const it of items) if (it && it.title && typeof it.run === 'function') out.push({ id: `cmd-${it.id || it.title}`, title: it.title, hint: it.hint || '', icon: it.icon || 'plus', words: `${it.title} ${it.words || ''}`, run: it.run });
    }
    return out;
  }
  function recent() { try { return JSON.parse(read(RECENT_KEY, '[]')).filter(have); } catch (_) { return []; } }

  function openPalette(start = '') {
    if (document.querySelector('.palette-overlay')) return;
    const previous = document.activeElement;
    const box = h('input', { class: 'palette-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Go to a page or run a command', placeholder: 'Go to a page or run a command', autocomplete: 'off', spellcheck: 'false' });
    box.value = typeof start === 'string' ? start : '';
    const listEl = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    const palFoot = h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move'), h('span', null, h('kbd', null, 'Enter'), ' to open'), h('span', null, h('kbd', null, 'Esc'), ' to close'));
    const panel = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Jump to a page' }, h('div', { class: 'palette-top' }, icon('search', 18), box), listEl, palFoot);
    const overlay = h('div', { class: 'overlay palette-overlay' }, panel);
    let rows = []; let at = 0;
    // Records as well as pages (2026.11.20): map items, assets, work orders, requests and people, from /jump, a moment
    // after typing stops. Only what this person's role and apps open comes back.
    const RECORD_ICON = { feature: 'assets', asset: 'assets', work_order: 'works', request: 'requests', person: 'workforce' };
    let found = { q: '', items: [] }; let wanted = ''; let timer = null;
    const fetchRecords = (q) => {
      clearTimeout(timer);
      if (q.length < 2 || found.q === q) return;
      wanted = q;
      timer = setTimeout(async () => {
        try {
          const { get } = await import('./api.js');
          const r = await get(`/jump?q=${encodeURIComponent(q)}`);
          if (wanted !== q || !overlay.isConnected) return;
          found = { q, items: (r.data || []).map((x) => ({ id: `rec-${x.href}`, title: x.title, hint: x.hint, icon: RECORD_ICON[x.type] || 'search', words: '', record: true, run: () => { location.hash = x.href; } })) };
          paint();
        } catch (_) { /* pages still work without the records */ }
      }, 250);
    };

    // Pages inside apps (the tabs of row 1 and row 2), with the app's name, only those this person may open.
    const appName = (k) => byKey.get(k) || k;
    const subs = () => subPagesFor(viewKeys, { manager: isManager(), role: me.role, school: me.school_access, patrol: patrolInfo, muni: isMuni() }).map((p) => ({
      id: `sub-${p.href}`, title: p.title, app: appName(p.app), hint: location.hash === p.href ? 'You are here' : '', icon: p.app, words: `${p.title} ${appName(p.app)} ${p.words}`, run: () => { location.hash = p.href; },
    }));
    const everything = () => [
      ...views.map(([key, text]) => ({ id: `page-${key}`, title: text, hint: key === currentKey ? 'You are here' : '', icon: key, words: `${text} ${ALSO[key] || ''}`, run: () => { location.hash = `#/${key}`; } })),
      ...(have('patrol') ? PATROL_SECTIONS.map(([id, text]) => ({ id: `patrol-${id}`, title: `Patrol: ${text}`, hint: currentKey === 'patrol' && currentSection === id ? 'You are here' : '', icon: 'patrol', words: `patrol ${text}`, run: () => { location.hash = `#/patrol/${id}`; } })) : []),
      ...subs(),
      ...added(),
      ...actions(),
    ];
    function score(item, q) {
      const t = item.title.toLowerCase();
      const w = item.words.toLowerCase();
      if (t.startsWith(q)) return 3;
      if (t.split(/\s+/).some((p) => p.startsWith(q))) return 2.5;
      if (t.includes(q)) return 2;
      if (w.split(/\s+/).some((p) => p.startsWith(q))) return 1.5;
      return q.split(/\s+/).every((p) => w.includes(p)) ? 1 : 0;
    }
    function paint() {
      const q = box.value.trim().toLowerCase();
      const all = everything();
      let lines;
      if (!q) {
        const rec = recent().filter((k) => k !== currentKey).slice(0, 3).map((k) => all.find((i) => i.id === `page-${k}`)).filter(Boolean);
        const rest = all.filter((i) => !rec.includes(i) && !i.app); // pages inside apps show once something is typed
        lines = [...(rec.length ? [{ heading: 'Recent' }, ...rec] : []), { heading: rec.length ? 'Everything' : 'Pages and commands' }, ...rest];
      } else {
        const hits = all.map((i) => [i, score(i, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
        const records = found.q === q ? found.items : [];
        lines = hits.length || records.length ? [...hits, ...(records.length ? [{ heading: 'Records' }, ...records] : [])] : [{ none: true }];
        fetchRecords(q);
      }
      rows = lines.filter((r) => !r.heading && !r.none);
      if (at >= rows.length) at = 0;
      clear(listEl);
      let n = -1;
      for (const r of lines) {
        if (r.heading) { listEl.append(h('li', { class: 'palette-heading', role: 'presentation' }, r.heading)); continue; }
        if (r.none) { listEl.append(h('li', { class: 'palette-none', role: 'presentation' }, `Nothing matches "${box.value.trim()}". ${isMuni() ? 'Try a page name like Work orders or Requests, a tag like V-114, or a request number.' : 'Try a page name like Sell or Patrol.'}`)); continue; }
        n += 1;
        const idx = n;
        const li = h('li', { class: 'palette-item', role: 'option', id: `pal-${idx}`, 'aria-selected': String(idx === at) }, icon(r.icon, 18), h('span', { class: 'p-title' }, r.title, r.app ? h('span', { class: 'p-app' }, ` in ${r.app}`) : null), r.hint ? h('span', { class: 'p-hint' }, r.hint) : null);
        li.addEventListener('mousemove', () => { if (at !== idx) { at = idx; markRow(); } });
        li.addEventListener('click', () => choose(idx));
        listEl.append(li);
      }
      markRow();
    }
    function markRow() {
      [...listEl.querySelectorAll('.palette-item')].forEach((li, i) => li.setAttribute('aria-selected', String(i === at)));
      const cur = listEl.querySelector(`#pal-${at}`);
      if (cur) { box.setAttribute('aria-activedescendant', cur.id); if (cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' }); } else box.removeAttribute('aria-activedescendant');
    }
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (previous && previous.isConnected && previous.focus) previous.focus(); }
    function choose(i) { const it = rows[i]; if (!it) return; close(); it.run(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); at = rows.length ? (at + 1) % rows.length : 0; markRow(); } else if (e.key === 'ArrowUp') { e.preventDefault(); at = rows.length ? (at - 1 + rows.length) % rows.length : 0; markRow(); } else if (e.key === 'Enter') { e.preventDefault(); choose(at); } else if (e.key === 'Tab') { e.preventDefault(); }
    }
    box.addEventListener('input', () => { at = 0; paint(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    paint();
    box.focus();
    // Patrol's pages depend on the person's Patrol access: load it once, then show those pages too.
    if (have('patrol') && !patrolInfo && !isManager()) loadPatrol().then(() => { if (overlay.isConnected) paint(); });
  }
  jump.addEventListener('click', () => openPalette());
  const onGlobalKey = (e) => {
    if (!shell.isConnected) { document.removeEventListener('keydown', onGlobalKey); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPalette(); } else if (e.key === '\\' && (e.ctrlKey || e.metaKey) && !e.altKey) { e.preventDefault(); setCollapsed(!isCollapsed()); }
  };
  document.addEventListener('keydown', onGlobalKey);
  if (typeof window !== 'undefined' && window.addEventListener) {
    // With no choice kept on this device the menu follows the window: a strip under 1280 px, open from there up.
    const onResize = () => { if (!shell.isConnected) { window.removeEventListener('resize', onResize); return; } if (keptCollapsed() === null) paintCollapsed(); };
    window.addEventListener('resize', onResize);
    // A tab change inside a page does not draw the page again, but a pin to that tab is lit (or no longer lit).
    const onHash = () => { if (!shell.isConnected) { window.removeEventListener('hashchange', onHash); return; } if (currentKey) mark(); };
    window.addEventListener('hashchange', onHash);
  }

  // The first stop for the Tab key: past the menu, straight to the page.
  const skip = h('button', { type: 'button', class: 'skip-link' }, 'Skip to the page');
  skip.addEventListener('click', () => main.focus());
  shell.append(skip, rail, h('div', { class: 'frame' }, topbar, main), tabbar, newFab);
  paintCollapsed();
  drawPins();
  paintFolds();

  /**
   * Says which app is open (before its page is drawn): the menus mark it, its section opens if it was folded, the row
   * comes into view, and the top bar names it. The part of the app follows from setWhere once the page is there.
   */
  function setCurrent(key, params = []) {
    currentKey = key;
    currentSection = key === 'patrol' ? patrolSection(params) : null;
    mark();
    paintFolds();
    paintNew();
    paintWhere(null);
    help.hidden = true;
    // The open page stays in view in the list: when none of its rows is (it was opened from Jump to, say), the list
    // moves just far enough to show its row in its section. A press on a row that is in view never moves the list.
    if (list.clientHeight) {
      const box = list.getBoundingClientRect();
      const inView = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.top >= box.top && r.bottom <= box.bottom; };
      const lit = [...list.querySelectorAll('.nav-row[aria-current="page"]')];
      const home = lit.find((el) => !el.dataset.pin) || lit[0];
      if (home && home.scrollIntoView && !lit.some(inView)) home.scrollIntoView({ block: 'nearest' });
    }
    const rec = [key, ...recent().filter((k) => k !== key)].slice(0, 5);
    write(RECENT_KEY, JSON.stringify(rec));
  }
  function paintWhere(part) {
    const app = byKey.get(currentKey) || '';
    // With a part showing, the app's name is the way back to the app's first page.
    const first = part ? h('a', { href: `#/${currentKey}` }, app) : app;
    clear(whereApp).append(first);
    whereSep.hidden = !part; wherePart.hidden = !part;
    wherePart.textContent = part || '';
    return part ? `${app}: ${part}` : app;
  }
  /**
   * Says which part of the app is on screen, once the page is drawn and after every tab change: part is its name (or
   * nothing), help the page's Help address. Tells the other modules too (nav:page), once per change.
   */
  function setWhere({ part = null, help: helpTo = null } = {}) {
    if (!currentKey) return;
    const text = paintWhere(part);
    if (helpTo) { help.href = helpTo.href; help.setAttribute('aria-label', helpTo.label || 'Help'); help.title = helpTo.label || 'Help'; }
    help.hidden = !helpTo;
    paintNew();
    mark();
    const now = { key: currentKey, href: hrefNow(), label: text };
    if (now.key === where.key && now.href === where.href && now.label === where.label) return;
    where = now;
    api.page = { ...now };
    tell('nav:page', { ...now });
  }

  /**
   * The person's pins and phone bar, from pins.js. pins: [{ id, label, href, app, icon? }]; bar: up to four
   * { label, href, app, icon? }, or null for the default (the start screen, the pins, then Home). A pin whose app the
   * person may not open is left out.
   */
  function setPins(next, nextBar = null) {
    pinsLive = true;
    pins = me.role === 'area' ? [] : usablePins(next);
    // Only null (or nothing) means the default bar; an empty list is a choice: the bar holds Menu alone.
    bar = Array.isArray(nextBar) ? usablePins(nextBar).slice(0, 4) : null;
    drawPins();
  }
  /**
   * A count on an app, wherever it shows at its own address: its row in its section, a pin to the app itself, the
   * collapsed icon, the phone bar and the sheet tile (and Inbox's button in the top bar). 0 removes it. alert: red, for
   * overdue or urgent. dot: a small dot instead of a number (Help, when What's new has something): on the account row
   * and, on a phone, the Menu button.
   */
  function setBadge(key, n, { dot = false, says = 'unread', alert = false } = {}) {
    if (n) badges.set(key, { n, dot, says, alert }); else badges.delete(key);
    for (const s of shown) if (s.app === key && s.href === s.app) paintBadge(s.el, badges.get(key));
    paintMenuDot();
  }
  function addCommands(fn) { if (typeof fn === 'function') commandFns.push(fn); }

  // page: the page on screen now ({ key, href, label }, as nav:page last said it), for a module that starts after the
  // first nav:page (pins.js loads on its own and may arrive late). null until the first page is drawn.
  const api = { shell, plan, canEdit, slots: { star }, page: null, setCurrent, setWhere, setPins, setBadge, setNew, addCommands, openPalette, openSheet };
  return api;
}
