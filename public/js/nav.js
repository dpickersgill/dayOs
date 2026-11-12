// The menu. On a computer the side menu is always in view. At the top, pinned: the brand, Jump to and Home (Today, Inbox,
// Calendar, My shifts, whichever the person may open), the same for everyone. In the middle, the only part that scrolls:
// the person's short menu (ctx.me.menu, owners and managers included), then All apps in four groups that fold. At the
// bottom, pinned: Settings, Help and the person. On a phone a labeled bottom bar holds the first four items and Menu,
// which opens a sheet: the short menu as tiles, then the same groups. Jump to (Ctrl+K, Cmd+K or "/") opens any page.
// The side menu only picks the app: the parts of an app are tabs on its page (ui.js tabs()).
import { h, clear, ctx, label, isManager, isMuni } from './ui.js';
import { icon } from './icons.js';
import { readTerminal } from './terminal.js';
import { subPagesFor } from './jumpindex.js';
import { staffHelpButton } from './staffhelp.js';

// Home: pinned at the top for everyone, never inside All apps or a menu.
export const HOME = ['dashboard', 'inbox', 'calendar', 'myshifts'];
// All apps: four groups that fold. [heading, id, apps]. An app shows only for people who may open it.
export const GROUPS = [
  ['Guests and sales', 'sales', ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']],
  ['On the hill', 'hill', ['conditions', 'park', 'patrol', 'area', 'assets']],
  ['Ski school', 'school', ['school', 'programs', 'availability']],
  ['Back office', 'office', ['catalog', 'money', 'workforce', 'messages', 'documents']],
];
// A municipality's All apps (muni release 1): residents, public works and the back office. The ski groups never show there.
export const MUNI_GROUPS = [
  ['Residents', 'residents', ['requests', 'notices', 'bulk']],
  ['Public works', 'works', ['works', 'assets', 'assetprograms', 'buildings', 'monthreport']],
  ['Back office', 'office', ['workforce', 'messages', 'documents']],
];
/** The groups of All apps for this person's tenant. */
export const groupsFor = () => (isMuni() ? MUNI_GROUPS : GROUPS);
export const GROUP_OF = Object.fromEntries([...HOME.map((k) => [k, { id: 'home', name: 'Home' }]), ...MUNI_GROUPS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }])), ...GROUPS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }]))]);
const BOTTOM = ['settings', 'help'];
// The phone bar: the screen the person's menu opens on first, then their apps, then these (Inbox has its own button in
// the phone's top bar).
const PHONE_HOME = ['myshifts', 'dashboard', 'calendar'];

// What each role is called, the same in the person's name card and in Settings, Team and logins, Menus for each role.
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
// The ski area's read-only login: its menu is the summary (and Help), never All apps.
export const AREA_MENU = { apps: ['area'], start: 'area' };
const OPEN_KEY = 'so.nav.open'; // which groups this device keeps open

// Patrol's four parts are its page tabs (row 1 on the Patrol page). The side menu has none of them.
export const PATROL_SECTIONS = [['now', 'Now'], ['cases', 'Cases'], ['people', 'People'], ['gear', 'Gear']];
const SECTION_OF = {
  now: 'now', home: 'now', board: 'now', duty: 'now', dispatch: 'now', map: 'now', opening: 'now', sweep: 'now', avalanche: 'now', log: 'now', room: 'now',
  cases: 'cases', case: 'cases', review: 'cases', followup: 'cases', records: 'cases', release: 'cases', stats: 'cases', network: 'cases', risk: 'cases', 'risk-report': 'cases', claim: 'cases', version: 'cases', collision: 'cases', access: 'cases', refusal: 'cases', handoff: 'cases',
  people: 'people', schedule: 'people', crews: 'people', cover: 'people', posts: 'people', team: 'people', training: 'people', passport: 'people',
  gear: 'gear', kit: 'gear', kits: 'gear', 'kit-labels': 'gear', equipment: 'gear', meds: 'gear', lifts: 'gear', places: 'gear', signs: 'gear', stencil: 'gear',
};
/** Which Patrol section a Patrol address belongs to: ['case', '12'] -> 'cases'. */
export const patrolSection = (params = []) => SECTION_OF[params[0]] || 'now';

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
  monthreport: 'monthly report council month totals cost hours department fund liquid fuels ms-965 response times', bulk: 'bulk trash pickup furniture appliance large item booking', buildings: 'building inspections life safety fire extinguisher sprinkler alarm elevator boiler backflow generator playground binder certificate vendor round calendar',
};
const RECENT_KEY = 'so.recent';

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
const initials = (name) => String(name || '?').split('@')[0].split(/[\s._-]+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
const isMac = () => /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '');

// ---------------------------------------------------------------- theme
// Light, Dark, or the same as this device (the default). theme.js applies it before the page paints; this keeps it in step.
export const THEME_KEY = 'verdynt.theme';
const THEMES = [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['device', 'Same as this device', 'device']];
export function themePick() { const v = read(THEME_KEY, null); return v === 'light' || v === 'dark' ? v : 'device'; }
const deviceDark = () => { try { return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (_) { return false; } };
export function applyTheme(pick = themePick()) {
  const dark = pick === 'dark' || (pick === 'device' && deviceDark());
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
export function setTheme(pick) {
  if (pick === 'device') { try { localStorage.removeItem(THEME_KEY); } catch (_) { /* this device only, best effort */ } } else write(THEME_KEY, pick);
  applyTheme(pick);
  window.dispatchEvent(new Event('theme:change'));
}

/** Three labeled choices. kind 'menu': a small button beside the person's name that opens them; 'seg': a row of three. */
function themeControl(kind) {
  const choices = THEMES.map(([id, text, ico]) => {
    const b = h('button', { type: 'button', role: kind === 'menu' ? 'menuitemradio' : 'radio', dataset: { theme: id }, class: 'theme-choice' }, icon(ico, 16), h('span', null, text));
    b.addEventListener('click', () => { setTheme(id); if (kind === 'menu') setOpen(false, true); });
    return b;
  });
  const mark = () => { const now = themePick(); for (const b of choices) b.setAttribute('aria-checked', String(b.dataset.theme === now)); if (btn) { const t = THEMES.find((x) => x[0] === now); clear(btn).append(icon(t[2], 17)); btn.setAttribute('aria-label', `Theme: ${t[1]}`); btn.title = `Theme: ${t[1]}`; } };
  let btn = null; let pop = null;
  function setOpen(open, focusBack) { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) (choices.find((b) => b.getAttribute('aria-checked') === 'true') || choices[0]).focus(); else if (focusBack) btn.focus(); }
  let root = null;
  const onChange = () => { if (root && !root.isConnected) { window.removeEventListener('theme:change', onChange); return; } mark(); };
  window.addEventListener('theme:change', onChange);
  if (kind !== 'menu') { root = h('div', { class: 'theme-seg', role: 'radiogroup', 'aria-label': 'Theme' }, choices); mark(); return root; }
  btn = h('button', { type: 'button', class: 'theme-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  pop = h('div', { class: 'theme-pop', role: 'menu', 'aria-label': 'Theme', hidden: true }, choices);
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(pop.hidden); });
  pop.addEventListener('keydown', (e) => {
    const at = choices.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false, true); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); choices[(at + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length].focus(); }
  });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) setOpen(false); });
  mark();
  root = h('div', { class: 'theme-wrap' }, btn, pop);
  return root;
}

/** The version under the person's name: "Verdynt/OS 2026.10.4", linking to What's new. */
function whoVersion() {
  const a = h('a', { class: 'who-version', href: '#/help/whats-new' });
  fetch('/version').then((r) => r.json()).then((v) => { if (v && v.version) a.textContent = `Verdynt/OS ${v.version}`; }).catch(() => {});
  return a;
}

/**
 * What the menu shows for this person. views: [[key, label]] already filtered for them; menu: ctx.me.menu.
 * home: Today, Inbox, Calendar, My shifts (pinned, the same for everyone). apps: their short menu, in its order, without
 * Home. groups: everything else they may open, in the four groups of All apps. first: the phone bar's four items.
 */
export function menuPlan(views, menu, links = {}) {
  const keys = views.map(([k]) => k);
  const has = (k) => keys.includes(k);
  // A shortcut (a page inside an app, such as Patrol's Records requests) shows when the person may open its app.
  const usable = (k) => has(k) || Boolean(links && links[k] && has(links[k].app));
  const home = HOME.filter(has);
  const bottom = BOTTOM.filter(has);
  const apps = menu && Array.isArray(menu.apps) ? [...new Set(menu.apps)].filter((k) => usable(k) && !HOME.includes(k) && !BOTTOM.includes(k)) : [];
  const listed = new Set([...home, ...apps, ...bottom]);
  const more = keys.filter((k) => !listed.has(k));
  const groups = groupsFor().map(([name, id, ks]) => ({ name, id, keys: ks.filter((k) => more.includes(k)) })).filter((g) => g.keys.length);
  const extra = more.filter((k) => !groups.some((g) => g.keys.includes(k))); // a new app shows somewhere rather than nowhere
  if (extra.length) groups.push({ name: 'More', id: 'more', keys: extra });
  // The phone bar always starts with the screen the menu opens on (Today, Patrol, Lessons, Sell, Summary).
  const start = menu && menu.start && has(menu.start) && menu.start !== 'inbox' ? [menu.start] : [];
  const first = [...new Set([...start, ...apps, ...PHONE_HOME.filter(has)])].slice(0, 4);
  return { home, apps, groups, bottom, more, first };
}

/** The group of All apps that holds this app, for this plan (null when the app is in Home or the short menu). */
const groupHolding = (plan, key) => (plan.groups.find((g) => g.keys.includes(key)) || null);

/** Which groups this device keeps open (ids). */
function openGroups() { try { const v = JSON.parse(read(OPEN_KEY, '[]')); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
function keepOpen(id, open) { const now = new Set(openGroups()); if (open) now.add(id); else now.delete(id); write(OPEN_KEY, JSON.stringify([...now])); }

/**
 * Builds the page frame. views: [[key, label]] already filtered for this person; menu: ctx.me.menu.
 * Returns { shell, setCurrent(key, params), openPalette(), openAllApps(), openSheet(), setBadge(), plan }.
 */
export function buildFrame({ views, main, signOut, menu = null, links = {} }) {
  const byKey = new Map(views);
  for (const [k, l] of Object.entries(links || {})) if (!byKey.has(k) && byKey.has(l.app)) byKey.set(k, l.label);
  const have = (k) => byKey.has(k) && !(links && links[k]);
  const plan = menuPlan(views, menu, links);
  const hrefOf = (k) => (links && links[k] ? `#/${links[k].href}` : `#/${k}`);
  const iconOf = (k) => (links && links[k] ? links[k].icon || links[k].app : k);
  const shell = h('div', { class: 'shell' });
  const links_ = new Map(); // key -> every <a> for that page (side menu, phone bar, sheet)
  const dots = new Set();
  let currentKey = null;
  let currentSection = null;
  const keep = (key, a) => { if (!links_.has(key)) links_.set(key, []); links_.get(key).push(a); return a; };
  const link = (key, cls = 'nav-row') => keep(key, h('a', { href: hrefOf(key), class: cls, dataset: { key } }, icon(iconOf(key), 18), h('span', { class: 'nav-label' }, byKey.get(key))));

  /**
   * A folding group: a heading button (aria-expanded) and its apps. The group holding the open page is locked open:
   * its heading says so (aria-disabled) and a press does nothing. Open or closed is kept on this device.
   */
  const folds = []; // every folding group drawn (side menu and phone sheet): { id, btn, body }
  function foldGroup(g, { prefix, item }) {
    const bodyId = `${prefix}-${g.id}`;
    const btn = h('button', { type: 'button', class: 'nav-fold', 'aria-expanded': 'false', 'aria-controls': bodyId, dataset: { group: g.id } },
      h('span', { class: 'nav-fold-text' }, g.name), h('span', { class: 'nav-chev', 'aria-hidden': 'true' }));
    const body = h('div', { class: 'nav-items', id: bodyId, role: 'group', 'aria-label': g.name, hidden: true }, g.keys.map(item));
    const f = { id: g.id, btn, body };
    btn.addEventListener('click', () => {
      if (btn.getAttribute('aria-disabled') === 'true') return; // the group holding this page stays open
      const open = btn.getAttribute('aria-expanded') !== 'true';
      keepOpen(g.id, open);
      paintFolds();
      if (open) afterFold();
    });
    folds.push(f);
    return h('div', { class: 'nav-group', dataset: { group: g.id } }, btn, body);
  }
  function paintFolds() {
    const held = currentKey ? groupHolding(plan, currentKey) : null;
    const kept = openGroups();
    for (const f of folds) {
      const locked = Boolean(held && held.id === f.id);
      const open = locked || kept.includes(f.id);
      f.btn.setAttribute('aria-expanded', String(open));
      if (locked) { f.btn.setAttribute('aria-disabled', 'true'); f.btn.title = 'The page you are on is in this group, so it stays open'; } else { f.btn.removeAttribute('aria-disabled'); f.btn.removeAttribute('title'); }
      f.body.hidden = !open;
    }
  }

  // ---- side menu: Home pinned at the top; the short menu and All apps scroll; Settings, Help and the person at the bottom
  const homeNav = plan.home.length ? h('nav', { class: 'nav nav-home', 'aria-label': 'Home' }, plan.home.map((k) => link(k))) : null;
  const allHead = plan.groups.length ? h('p', { class: 'nav-all-head', id: 'nav-all-head' }, 'All apps') : null;
  const nav = h('nav', { class: 'nav nav-scroll', 'aria-label': 'Main' },
    plan.apps.length ? h('div', { class: 'nav-group nav-mine' }, plan.apps.map((k) => link(k))) : null,
    allHead,
    plan.groups.length ? h('div', { class: 'nav-all-groups', role: 'group', 'aria-labelledby': 'nav-all-head' }, plan.groups.map((g) => foldGroup(g, { prefix: 'nav-g', item: (k) => link(k) }))) : null);

  const search = h('button', { type: 'button', class: 'rail-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', { class: 'nav-label' }, 'Jump to'), h('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  // Ask: the assistant's side panel, loaded the first time it is opened. Hidden until the server says it is on.
  const viewKeys = views.map(([k]) => k);
  ctx.views = viewKeys;
  const openAsk = () => import('./assistant.js').then((m) => m.openAssistant({ page: currentKey, views: viewKeys }));
  const ask = h('button', { type: 'button', class: 'rail-search rail-ask', 'aria-label': 'Ask the assistant', hidden: true }, icon('ask', 18), h('span', { class: 'nav-label' }, 'Ask'));
  const topAsk = h('button', { type: 'button', class: 'top-inbox top-ask', 'aria-label': 'Ask the assistant', hidden: true }, icon('ask', 22));
  ask.addEventListener('click', openAsk); topAsk.addEventListener('click', openAsk);
  if (ctx.me.role !== 'area') import('./assistant.js').then((m) => m.assistantOn()).then((yes) => { ask.hidden = !yes; topAsk.hidden = !yes; fit(); }).catch(() => {});

  const name = ctx.me.login_name || ctx.me.username || ctx.me.email;
  const roleText = roleName(ctx.me);
  const terminal = Boolean(ctx.me.terminal) || Boolean(readTerminal());
  const outBtn = (cls) => { const b = h('button', { type: 'button', class: cls }, icon('signout', 17), h('span', null, 'Sign out')); b.addEventListener('click', () => signOut()); return b; };
  // A shared counter computer: the next person switches in with their PIN (signing out shows the PIN screen there).
  const switchBtn = (cls) => { if (!terminal) return null; const b = h('button', { type: 'button', class: cls }, icon('swap', 17), h('span', null, 'Switch person')); b.addEventListener('click', () => signOut()); return b; };
  const who = h('div', { class: 'who' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
    h('span', { class: 'who-text' }, h('b', { title: ctx.me.email || name }, name), h('span', null, roleText)),
    themeControl('menu'));
  const foot = h('div', { class: 'rail-foot' },
    h('nav', { class: 'nav nav-bottom', 'aria-label': 'Settings and help' }, plan.bottom.map((k) => link(k))),
    who,
    h('div', { class: 'who-actions' }, switchBtn('btn small who-switch'), outBtn('rail-out'), whoVersion()));
  const rail = h('aside', { class: 'rail' },
    h('div', { class: 'rail-top' },
      h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: '', width: '48', height: '27' }),
        h('div', { class: 'brand-text' }, h('strong', null, 'Verdynt/OS'), h('span', null, ctx.me.tenant_name))),
      search, ask, homeNav, staffHelpButton('nav-help-here')),
    nav, foot);

  /**
   * The scrolling middle rests between two rows, never through one: its height is cut to the last whole row that fits.
   * A thin shadow at an edge says there is more past it (no fade: a fade dims the row under it).
   */
  const rowsIn = () => [...nav.querySelectorAll('.nav-row, .nav-fold, .nav-all-head')].filter((el) => el.offsetParent !== null);
  function fit(keepCurrent = true) {
    if (!rail.isConnected || !nav.isConnected) return;
    nav.style.flex = '';
    nav.style.height = '';
    const room = nav.clientHeight;
    const rows = rowsIn();
    if (!room || !rows.length) { edges(); return; }
    const top = nav.getBoundingClientRect().top - nav.scrollTop;
    const full = rows[rows.length - 1].getBoundingClientRect().bottom - top;
    if (full <= room + 1) { edges(); return; } // everything fits
    let last = -1;
    rows.forEach((r, i) => { if (last === i - 1 && r.getBoundingClientRect().bottom - top <= room) last = i; });
    // A heading is never the last row above the edge ("All apps" or an open group with none of its apps showing).
    while (last > 0 && (rows[last].classList.contains('nav-all-head') || (rows[last].classList.contains('nav-fold') && rows[last].getAttribute('aria-expanded') === 'true'))) last -= 1;
    if (last >= 0) {
      const cut = Math.floor(rows[last].getBoundingClientRect().bottom - top + 1); // measured before the size changes, as scrolling may move the rows
      nav.style.height = `${cut}px`;
      nav.style.flex = '0 0 auto';
    }
    // The page you are on stays in view (after a resize, or once the fonts are in); not after opening a group by hand.
    const cur = keepCurrent ? nav.querySelector('.nav-row[aria-current="page"]') : null;
    if (cur) showRow(cur); else edges();
  }
  /** Marks the edges with more past them: rail.more-up, rail.more-down. */
  function edges() {
    const up = nav.scrollTop > 1;
    const down = nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1;
    rail.classList.toggle('more-up', up);
    rail.classList.toggle('more-down', down);
  }
  /** Scrolls the scrolling middle so this row is fully in view, resting on a row edge, with one row of room past it. */
  function showRow(el) {
    if (!el || !nav.clientHeight) return;
    const rows = rowsIn();
    const navTop = nav.getBoundingClientRect().top;
    const at = (r) => r.getBoundingClientRect().top - navTop + nav.scrollTop;
    const i = rows.indexOf(el);
    const top = at(el); const bottom = top + el.offsetHeight;
    if (top >= nav.scrollTop && bottom <= nav.scrollTop + nav.clientHeight) { edges(); return; }
    if (top < nav.scrollTop) { nav.scrollTop = i > 0 ? at(rows[i - 1]) : 0; edges(); return; }
    // Past the bottom: scroll down by whole rows until it and the row after it (when there is one) are in view.
    const want = (rows[i + 1] ? at(rows[i + 1]) + rows[i + 1].offsetHeight : bottom) - nav.clientHeight;
    const start = rows.find((r) => at(r) >= want);
    nav.scrollTop = start ? at(start) : want;
    edges();
  }
  /** After a group opens: keep its heading in view and show as much of it as fits. */
  function afterFold() { fit(false); }
  nav.addEventListener('scroll', edges, { passive: true });
  if (typeof window !== 'undefined' && window.addEventListener) {
    const onResize = () => { if (!shell.isConnected) { window.removeEventListener('resize', onResize); return; } fit(); };
    window.addEventListener('resize', onResize);
  }

  // ---- phone: slim top bar, a labeled bottom bar, and a sheet with everything
  const tabLinks = new Map();
  // The bottom bar has room for about ten letters a label: long names get a short one there (the full name is the link's title).
  const SHORT = { works: 'Work orders', notices: 'Notices', assetprograms: 'Programs', bulk: 'Bulk pickup', conditions: 'Mountain', lostfound: 'Lost items', availability: 'Availability', workforce: 'Staff', documents: 'Docs', shop: 'Shop', dashboard: 'Today', myshifts: 'My shifts', people: 'Customers', catalog: 'Products', park: 'Park', area: 'Summary', 'patrol-records': 'Records', 'patrol-access': 'Access log', 'patrol-review': 'Review' };
  const tab = (key) => { const a = keep(key, h('a', { href: hrefOf(key), dataset: { key }, class: 'tab', title: byKey.get(key), 'aria-label': byKey.get(key) }, icon(iconOf(key), 22), h('span', { 'aria-hidden': 'true' }, SHORT[key] || byKey.get(key)))); tabLinks.set(key, a); return a; };
  const more = h('button', { type: 'button', class: 'tab tab-menu', 'aria-haspopup': 'dialog' }, icon('menu', 22), h('span', null, 'Menu'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Quick links' }, plan.first.map(tab), more);
  const topSearch = h('button', { type: 'button', class: 'top-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', null, 'Jump to a page'), h('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  const topInbox = have('inbox') ? keep('inbox', h('a', { href: '#/inbox', class: 'top-inbox', dataset: { key: 'inbox' }, 'aria-label': 'Inbox' }, icon('inbox', 22))) : null;
  const topbar = h('header', { class: 'topbar' }, h('div', { class: 'top-brand' }, h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: 'Verdynt/OS', width: '53', height: '30' }), h('strong', null, ctx.me.tenant_name)), topSearch, topAsk, topInbox);

  /** A sheet over the page (the phone menu and All apps). build(close) returns its content. The whole sheet scrolls as one. */
  function sheet(title, cls, build) {
    const previous = document.activeElement;
    const closeBtn = h('button', { type: 'button', class: 'sheet-close', 'aria-label': `Close ${title.toLowerCase()}` }, icon('close', 20));
    const titleId = `sheet-${Math.random().toString(36).slice(2, 7)}`;
    const box = h('div', { class: `dialog menu-sheet ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    const overlay = h('div', { class: 'overlay menu-overlay' }, box);
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); for (let i = folds.length - 1; i >= 0; i--) if (!folds[i].btn.isConnected) folds.splice(i, 1); if (previous && previous.isConnected && previous.focus) previous.focus(); }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    box.append(h('header', null, h('h2', { id: titleId }, title), closeBtn), build(close));
    box.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(); });
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    paintFolds();
    closeBtn.focus();
    return { close, box };
  }
  const tile = (k) => h('a', { href: hrefOf(k), class: 'sheet-item', dataset: { key: k }, 'aria-current': hereKey() === k ? 'page' : null }, icon(iconOf(k), 20), h('span', null, byKey.get(k)), dots.has(k) ? h('span', { class: 'nav-badge dot', 'aria-label': 'new' }) : null);
  const sheetGroups = (prefix) => plan.groups.map((g) => foldGroup(g, { prefix, item: tile }));
  const sheetAllHead = () => (plan.groups.length ? h('p', { class: 'nav-all-head' }, 'All apps') : null);

  /** All apps in a sheet (from Jump to): the four groups, folding the same way as in the side menu. */
  function openAllApps() {
    return sheet('All apps', 'all-apps', () => h('div', { class: 'sheet-body' },
      plan.groups.length ? h('div', { class: 'sheet-groups' }, sheetGroups('all-g')) : h('p', { class: 'muted small' }, 'Every app you can use is in your menu.')));
  }

  function openSheet() {
    const searchBox = h('input', { type: 'search', class: 'sheet-search', placeholder: 'Jump to an app or page', 'aria-label': 'Jump to an app or page', autocomplete: 'off' });
    const s = sheet('Menu', 'phone-menu', (close) => {
      searchBox.addEventListener('input', () => { const q = searchBox.value; close(); openPalette(q); });
      const mine = [...plan.home.filter((k) => k !== 'inbox'), ...plan.apps];
      const signOutBtn = outBtn('btn small');
      signOutBtn.addEventListener('click', close, { capture: true });
      const sw = switchBtn('btn small');
      if (sw) sw.addEventListener('click', close, { capture: true });
      const helpHere = staffHelpButton('sheet-help-here');
      if (helpHere) helpHere.addEventListener('click', close, { capture: true });
      return h('div', { class: 'sheet-body' }, searchBox, helpHere,
        mine.length ? h('div', { class: 'sheet-group sheet-mine' }, h('div', { class: 'sheet-grid' }, mine.map(tile))) : null,
        plan.groups.length ? h('div', { class: 'sheet-groups' }, sheetAllHead(), sheetGroups('sheet-g')) : null,
        h('div', { class: 'sheet-foot' },
          plan.bottom.map((k) => h('a', { href: `#/${k}`, class: 'sheet-row', 'aria-current': currentKey === k ? 'page' : null }, icon(k, 20), h('span', null, byKey.get(k)), dots.has(k) ? h('span', { class: 'nav-badge dot', 'aria-label': 'new' }) : null)),
          h('div', { class: 'sheet-theme' }, h('span', { class: 'small muted' }, 'Theme'), themeControl('seg')),
          h('div', { class: 'who sheet-who' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)), h('span', { class: 'who-text' }, h('b', null, name), h('span', null, roleText)), sw, signOutBtn)));
    });
    return s;
  }
  more.addEventListener('click', openSheet);

  // ---- palette
  function actions() {
    const list = [];
    if (isManager()) list.push({ id: 'kiosk', title: 'Open the time clock kiosk page', hint: 'New tab', icon: 'clock', words: 'kiosk tablet punch', run: () => window.open('/kiosk', '_blank', 'noopener') });
    if (plan.groups.length) list.push({ id: 'all', title: 'All apps', hint: '', icon: 'apps', words: 'apps more everything groups', run: () => openAllApps() });
    for (const [id, text, ico] of THEMES) list.push({ id: `theme-${id}`, title: id === 'device' ? 'Theme: same as this device' : `Theme: ${text.toLowerCase()}`, hint: themePick() === id ? 'On now' : '', icon: ico, words: 'theme dark light mode night day colors', run: () => setTheme(id) });
    if (!ask.hidden) list.push({ id: 'ask', title: 'Ask the assistant', hint: '', icon: 'ask', words: 'assistant question how do i ai chat', run: () => openAsk() });
    if (terminal) list.push({ id: 'switch', title: 'Switch person', hint: '', icon: 'swap', words: 'pin shared terminal change user', run: () => signOut() });
    list.push({ id: 'out', title: 'Sign out', hint: '', icon: 'signout', words: 'log out leave', run: () => signOut() });
    return list;
  }
  function recent() { try { return JSON.parse(read(RECENT_KEY, '[]')).filter(have); } catch (_) { return []; } }

  function openPalette(start = '') {
    if (document.querySelector('.palette-overlay')) return;
    const previous = document.activeElement;
    const box = h('input', { class: 'palette-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', 'aria-label': 'Go to a page or run a command', placeholder: 'Go to a page or run a command', autocomplete: 'off', spellcheck: 'false' });
    box.value = typeof start === 'string' ? start : '';
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    const foot = h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move'), h('span', null, h('kbd', null, 'Enter'), ' to open'), h('span', null, h('kbd', null, 'Esc'), ' to close'));
    const panel = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Jump to a page' }, h('div', { class: 'palette-top' }, icon('search', 18), box), list, foot);
    const overlay = h('div', { class: 'overlay palette-overlay' }, panel);
    let shown = []; let at = 0;

    // Pages inside apps (the tabs of row 1 and row 2), with the app's name, only those this person may open.
    const appName = (k) => byKey.get(k) || k;
    const subs = () => subPagesFor(viewKeys, { manager: isManager(), role: ctx.me.role, school: ctx.me.school_access, patrol: patrolInfo }).map((p) => ({
      id: `sub-${p.href}`, title: p.title, app: appName(p.app), hint: location.hash === p.href ? 'You are here' : '', icon: p.app, words: `${p.title} ${appName(p.app)} ${p.words}`, run: () => { location.hash = p.href; },
    }));
    const everything = () => [
      ...views.map(([key, text]) => ({ id: `page-${key}`, title: text, hint: key === currentKey ? 'You are here' : '', icon: key, words: `${text} ${ALSO[key] || ''}`, run: () => { location.hash = `#/${key}`; } })),
      ...(have('patrol') ? PATROL_SECTIONS.map(([id, text]) => ({ id: `patrol-${id}`, title: `Patrol: ${text}`, hint: currentKey === 'patrol' && currentSection === id ? 'You are here' : '', icon: 'patrol', words: `patrol ${text}`, run: () => { location.hash = `#/patrol/${id}`; } })) : []),
      ...subs(),
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
      let rows;
      if (!q) {
        const rec = recent().filter((k) => k !== currentKey).slice(0, 3).map((k) => all.find((i) => i.id === `page-${k}`)).filter(Boolean);
        const rest = all.filter((i) => !rec.includes(i) && !i.app); // pages inside apps show once something is typed
        rows = [...(rec.length ? [{ heading: 'Recent' }, ...rec] : []), { heading: rec.length ? 'Everything' : 'Pages and commands' }, ...rest];
      } else {
        const hits = all.map((i) => [i, score(i, q)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([i]) => i);
        rows = hits.length ? hits : [{ none: true }];
      }
      shown = rows.filter((r) => !r.heading && !r.none);
      if (at >= shown.length) at = 0;
      clear(list);
      let n = -1;
      for (const r of rows) {
        if (r.heading) { list.append(h('li', { class: 'palette-heading', role: 'presentation' }, r.heading)); continue; }
        if (r.none) { list.append(h('li', { class: 'palette-none', role: 'presentation' }, `Nothing matches "${box.value.trim()}". Try a page name like Sell or Patrol.`)); continue; }
        n += 1;
        const idx = n;
        const li = h('li', { class: 'palette-item', role: 'option', id: `pal-${idx}`, 'aria-selected': String(idx === at) }, icon(r.icon, 18), h('span', { class: 'p-title' }, r.title, r.app ? h('span', { class: 'p-app' }, ` in ${r.app}`) : null), r.hint ? h('span', { class: 'p-hint' }, r.hint) : null);
        li.addEventListener('mousemove', () => { if (at !== idx) { at = idx; mark(); } });
        li.addEventListener('click', () => choose(idx));
        list.append(li);
      }
      mark();
    }
    function mark() {
      [...list.querySelectorAll('.palette-item')].forEach((li, i) => li.setAttribute('aria-selected', String(i === at)));
      const cur = list.querySelector(`#pal-${at}`);
      if (cur) { box.setAttribute('aria-activedescendant', cur.id); if (cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' }); } else box.removeAttribute('aria-activedescendant');
    }
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey, true); if (previous && previous.isConnected && previous.focus) previous.focus(); }
    function choose(i) { const it = shown[i]; if (!it) return; close(); it.run(); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); at = shown.length ? (at + 1) % shown.length : 0; mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); at = shown.length ? (at - 1 + shown.length) % shown.length : 0; mark(); } else if (e.key === 'Enter') { e.preventDefault(); choose(at); } else if (e.key === 'Tab') { e.preventDefault(); }
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
  let patrolInfo = null;
  async function loadPatrol() {
    try { patrolInfo = JSON.parse(sessionStorage.getItem('so.patrol.me') || 'null'); } catch (_) { patrolInfo = null; }
    if (patrolInfo) return;
    try { const { get } = await import('./api.js'); patrolInfo = await get('/patrol/me'); } catch (_) { patrolInfo = null; }
  }
  search.addEventListener('click', () => openPalette());
  topSearch.addEventListener('click', () => openPalette());
  const onGlobalKey = (e) => {
    if (!shell.isConnected) { document.removeEventListener('keydown', onGlobalKey); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPalette(); }
  };
  document.addEventListener('keydown', onGlobalKey);

  shell.append(rail, h('div', { class: 'frame' }, topbar, main), tabbar);
  paintFolds();
  // Once the page is on screen and its fonts are in, the scrolling middle is cut to whole rows.
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fit());
  // And again whenever the rail, its pinned top or its foot change size (the stylesheet or fonts arriving late, the
  // Ask button appearing, a zoom): the cut is always made against the room there really is.
  if (typeof ResizeObserver === 'function') {
    let queued = false;
    const ro = new ResizeObserver(() => {
      if (!shell.isConnected) { ro.disconnect(); return; }
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; fit(); });
    });
    for (const el of [rail, rail.firstChild, foot]) ro.observe(el);
  }
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fit()); } catch (_) { /* fit on the next page */ }

  /**
   * Marks where the person is: the app in the menus (Patrol's part is marked on the Patrol page itself). The group of
   * All apps holding it opens and stays open, and the side menu scrolls so the app is in view under the pinned top.
   */
  /** The menu item for where the person is: a shortcut when the address is its page (Patrol, Records requests), else the app. */
  function hereKey() {
    const at = (typeof location !== 'undefined' && location.hash) || '';
    const tab = (hsh) => { try { return new URLSearchParams(hsh.split('?')[1] || '').get('tab'); } catch (_) { return null; } };
    for (const [k, l] of Object.entries(links || {})) {
      const want = `#/${l.href}`;
      if (anchorsFor(k) && at.split('?')[0] === want.split('?')[0] && tab(at) === tab(want)) return k;
    }
    return currentKey;
  }
  const anchorsFor = (k) => (links_.get(k) || []).length > 0;
  function mark() {
    const key = hereKey();
    for (const [k, anchors] of links_) for (const a of anchors) { if (k === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    more.classList.toggle('on', !tabLinks.has(key));
  }
  function setCurrent(key, params = []) {
    currentKey = key;
    currentSection = key === 'patrol' ? patrolSection(params) : null;
    mark();
    paintFolds();
    fit(); // cuts the middle to whole rows and scrolls the open app into view
    const rec = [key, ...recent().filter((k) => k !== key)].slice(0, 5);
    write(RECENT_KEY, JSON.stringify(rec));
  }
  // A tab change inside a page does not draw the page again, but a shortcut to that tab is lit (or no longer lit).
  if (typeof window !== 'undefined' && window.addEventListener && links && Object.keys(links).length) {
    const onHash = () => { if (!shell.isConnected) { window.removeEventListener('hashchange', onHash); return; } if (currentKey) mark(); };
    window.addEventListener('hashchange', onHash);
  }
  /**
   * A count on a page's menu links (unread messages on Inbox). 0 removes it. With { dot: true } it is a small dot
   * instead of a number (Help, when What's new has something): quiet, and repeated on the phone's Menu button when
   * the page sits inside the menu sheet there.
   */
  function setBadge(key, n, { dot = false, says = 'unread' } = {}) {
    for (const a of links_.get(key) || []) {
      let b = a.querySelector('.nav-badge');
      if (!n) { if (b) b.remove(); a.removeAttribute('aria-description'); continue; }
      if (!b) { b = h('span', { class: 'nav-badge', 'aria-hidden': 'true' }); a.append(b); }
      b.classList.toggle('dot', dot);
      b.textContent = dot ? '' : n > 99 ? '99+' : String(n);
      a.setAttribute('aria-description', dot ? says : `${n} ${says}`);
    }
    if (dot) {
      if (n) dots.add(key); else dots.delete(key);
      more.classList.toggle('has-new', [...dots].some((k) => !tabLinks.has(k)));
      if (more.classList.contains('has-new')) more.setAttribute('aria-description', 'Something new in Help'); else more.removeAttribute('aria-description');
    }
  }
  return { shell, setCurrent, openPalette, openAllApps, openSheet, setBadge, plan };
}
