// The menu. On a computer the side menu is always in view: managers and owners see every app in five groups, always
// open; everyone else sees the short menu for their role (ctx.me.menu) with the rest under All apps. On a phone a
// labeled bottom bar holds the person's first four items and Menu, which opens a sheet of everything. Jump to
// (Ctrl+K, Cmd+K or "/") opens any page the person may use by typing a few letters.
import { h, clear, ctx, label, isManager } from './ui.js';
import { icon } from './icons.js';
import { readTerminal } from './terminal.js';

// Menu groups: label, color key, apps. Today, Inbox and My shifts stand alone at the top. Each group has its own accent dot.
export const GROUPS = [
  ['Front desk', 'front', ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound']],
  ['Mountain', 'mountain', ['conditions', 'park', 'assets']],
  ['Safety', 'safety', ['patrol', 'area']],
  ['Programs', 'programs', ['school', 'programs', 'availability']],
  ['Office', 'office', ['catalog', 'money', 'workforce', 'messages', 'documents']],
];
export const GROUP_OF = Object.fromEntries(GROUPS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }])));
const START = ['dashboard', 'inbox', 'myshifts'];
const MINE = ['inbox', 'myshifts']; // always in a role menu, after the role's own apps
const BOTTOM = ['settings', 'help'];
const PHONE_FIRST = ['dashboard', 'sell', 'gate', 'patrol', 'area', 'school', 'conditions', 'myshifts'];

// Patrol is the one app with sections between the app and its tabs.
export const PATROL_SECTIONS = [['now', 'Now'], ['cases', 'Cases'], ['people', 'People'], ['gear', 'Gear']];
const SECTION_OF = {
  now: 'now', home: 'now', board: 'now', duty: 'now', dispatch: 'now', map: 'now', opening: 'now', sweep: 'now', avalanche: 'now', log: 'now', room: 'now',
  cases: 'cases', case: 'cases', review: 'cases', followup: 'cases', records: 'cases', release: 'cases', stats: 'cases', network: 'cases', risk: 'cases', 'risk-report': 'cases', claim: 'cases', version: 'cases', collision: 'cases', access: 'cases', refusal: 'cases', handoff: 'cases',
  people: 'people', schedule: 'people', crews: 'people', cover: 'people', posts: 'people', team: 'people', training: 'people', passport: 'people',
  gear: 'gear', kit: 'gear', kits: 'gear', 'kit-labels': 'gear', equipment: 'gear', meds: 'gear', lifts: 'gear',
};
/** Which Patrol section a Patrol address belongs to: ['case', '12'] -> 'cases'. */
export const patrolSection = (params = []) => SECTION_OF[params[0]] || 'now';

// Words people might type that are not in the page's name (old names included, so habits still work).
const ALSO = {
  dashboard: 'home overview numbers today', sell: 'ticket pos register checkout basket partner passes indy pass reciprocal redeem', gate: 'scan lift ticket scanner check in',
  conditions: 'lifts trails snow open closed status grooming groomer snowmaking weather maintenance work orders inspection fleet downtime handoff report', park: 'terrain park rails jumps boxes features freestyle halfpipe jib map', rentals: 'equipment skis boards boots rent', school: 'lessons instructors ski school',
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
  myshifts: 'my schedule clock in out', settings: 'account setup password security two-step passkey profile mountain team logins billing subscription plan invoice menus',
  help: 'how to guide instructions support questions articles',
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
 * A role menu ({ apps, start }) lists its apps in its order, then Inbox and My shifts; everything else they may open is
 * under All apps. No menu (owners and managers): every app in the five groups.
 */
export function menuPlan(views, menu) {
  const keys = views.map(([k]) => k);
  const has = (k) => keys.includes(k);
  const bottom = BOTTOM.filter(has);
  if (menu && Array.isArray(menu.apps)) {
    const apps = [...new Set(menu.apps)].filter((k) => has(k) && !MINE.includes(k) && !BOTTOM.includes(k));
    const mine = MINE.filter(has);
    const listed = new Set([...apps, ...mine, ...bottom]);
    return { role: true, apps, mine, bottom, more: keys.filter((k) => !listed.has(k)), first: [...apps, ...mine].slice(0, 4) };
  }
  const start = START.filter(has);
  const groups = GROUPS.map(([name, id, ks]) => ({ name, id, keys: ks.filter(has) })).filter((g) => g.keys.length);
  const inGroups = new Set([...start, ...groups.flatMap((g) => g.keys), ...bottom]);
  const extra = keys.filter((k) => !inGroups.has(k)); // nothing today; a new app shows somewhere rather than nowhere
  if (extra.length) groups.push({ name: 'More', id: 'office', keys: extra });
  return { role: false, start, groups, bottom, more: [], first: PHONE_FIRST.filter(has).slice(0, 4) };
}

/** Apps grouped the way the menu groups them: [[heading, id, keys]], for All apps and the phone sheet. */
function grouped(keys) {
  const out = [];
  const start = START.filter((k) => keys.includes(k));
  if (start.length) out.push(['Start', 'home', start]);
  for (const [name, id, ks] of GROUPS) { const in_ = ks.filter((k) => keys.includes(k)); if (in_.length) out.push([name, id, in_]); }
  const rest = keys.filter((k) => !out.some(([, , ks]) => ks.includes(k)) && !BOTTOM.includes(k));
  if (rest.length) out.push(['More', 'office', rest]);
  return out;
}

/**
 * Builds the page frame. views: [[key, label]] already filtered for this person; menu: ctx.me.menu.
 * Returns { shell, setCurrent(key, params), openPalette(), openAllApps(), setBadge() }.
 */
export function buildFrame({ views, main, signOut, menu = null }) {
  const byKey = new Map(views);
  const have = (k) => byKey.has(k);
  const plan = menuPlan(views, menu);
  const shell = h('div', { class: `shell${plan.role ? ' role-menu' : ''}` });
  const links = new Map(); // key -> every <a> for that page (side menu, phone bar, sheet)
  const dots = new Set();
  let currentKey = null;
  let currentSection = null;
  const keep = (key, a) => { if (!links.has(key)) links.set(key, []); links.get(key).push(a); return a; };

  const link = (key, cls = 'nav-row') => keep(key, h('a', { href: `#/${key}`, class: cls, dataset: { key } }, icon(key, 18), h('span', { class: 'nav-label' }, byKey.get(key))));

  // Patrol's sections, under Patrol while it is open (and as chips in the phone sheet).
  const sectionLinks = [];
  const sectionsBox = () => {
    const box = h('div', { class: 'nav-sections', hidden: currentKey !== 'patrol', 'aria-label': 'Patrol sections', role: 'group' },
      PATROL_SECTIONS.map(([id, text]) => { const a = h('a', { href: `#/patrol/${id}`, class: 'nav-sec', dataset: { section: id } }, text); sectionLinks.push(a); return a; }));
    return box;
  };
  const sectionBoxes = [];
  const appLink = (key) => {
    const a = link(key);
    if (key !== 'patrol') return a;
    const box = sectionsBox();
    sectionBoxes.push(box);
    return [a, box];
  };

  // ---- side menu
  let nav;
  if (plan.role) {
    nav = h('nav', { class: 'nav nav-role', 'aria-label': 'Main' },
      h('div', { class: 'nav-group nav-mine' }, plan.apps.map(appLink)),
      plan.mine.length ? h('div', { class: 'nav-group nav-mine nav-personal-apps' }, plan.mine.map((k) => link(k))) : null);
  } else {
    nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
      plan.start.length ? h('div', { class: 'nav-group nav-home' }, plan.start.map((k) => link(k))) : null,
      plan.groups.map((g) => h('div', { class: 'nav-group', dataset: { group: g.id } },
        h('p', { class: 'nav-title', id: `nav-${g.id}` }, h('span', null, g.name)),
        h('div', { class: 'nav-items', role: 'group', 'aria-labelledby': `nav-${g.id}` }, g.keys.map(appLink)))));
  }
  const allBtn = () => {
    const b = h('button', { type: 'button', class: 'nav-row nav-all', 'aria-haspopup': 'dialog' }, icon('apps', 18), h('span', { class: 'nav-label' }, 'All apps'), h('span', { class: 'nav-more' }, `${plan.more.length} more`));
    b.addEventListener('click', () => openAllApps());
    return b;
  };

  const search = h('button', { type: 'button', class: 'rail-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', { class: 'nav-label' }, 'Jump to'), h('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  // Ask: the assistant's side panel, loaded the first time it is opened. Hidden until the server says it is on.
  const viewKeys = views.map(([k]) => k);
  ctx.views = viewKeys;
  const openAsk = () => import('./assistant.js').then((m) => m.openAssistant({ page: currentKey, views: viewKeys }));
  const ask = h('button', { type: 'button', class: 'rail-search rail-ask', 'aria-label': 'Ask the assistant', hidden: true }, icon('ask', 18), h('span', { class: 'nav-label' }, 'Ask'));
  const topAsk = h('button', { type: 'button', class: 'top-inbox top-ask', 'aria-label': 'Ask the assistant', hidden: true }, icon('ask', 22));
  ask.addEventListener('click', openAsk); topAsk.addEventListener('click', openAsk);
  if (ctx.me.role !== 'area') import('./assistant.js').then((m) => m.assistantOn()).then((yes) => { ask.hidden = !yes; topAsk.hidden = !yes; }).catch(() => {});

  const name = ctx.me.login_name || ctx.me.username || ctx.me.email;
  const roleText = ctx.me.role === 'area' ? 'Ski area (read-only)' : label(ctx.me.role);
  const terminal = Boolean(ctx.me.terminal) || Boolean(readTerminal());
  const outBtn = (cls) => { const b = h('button', { type: 'button', class: cls }, icon('signout', 17), h('span', null, 'Sign out')); b.addEventListener('click', () => signOut()); return b; };
  // A shared counter computer: the next person switches in with their PIN (signing out shows the PIN screen there).
  const switchBtn = (cls) => { if (!terminal) return null; const b = h('button', { type: 'button', class: cls }, icon('swap', 17), h('span', null, 'Switch person')); b.addEventListener('click', () => signOut()); return b; };
  const who = h('div', { class: 'who' },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name)),
    h('span', { class: 'who-text' }, h('b', { title: ctx.me.email || name }, name), h('span', null, roleText)),
    themeControl('menu'));
  const rail = h('aside', { class: 'rail' },
    h('div', { class: 'brand' }, h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: '', width: '48', height: '27' }),
      h('div', { class: 'brand-text' }, h('strong', null, 'Verdynt/OS'), h('span', null, ctx.me.tenant_name))),
    search, ask, nav,
    h('div', { class: 'rail-foot' },
      h('nav', { class: 'nav nav-bottom', 'aria-label': 'Settings and help' },
        plan.role && plan.more.length ? allBtn() : null,
        plan.bottom.map((k) => link(k))),
      who,
      h('div', { class: 'who-actions' }, switchBtn('btn small who-switch'), outBtn('rail-out'), whoVersion())));

  // ---- phone: slim top bar, a labeled bottom bar, and a sheet with everything
  const tabLinks = new Map();
  const tab = (key) => { const a = keep(key, h('a', { href: `#/${key}`, dataset: { key }, class: 'tab' }, icon(key, 22), h('span', null, byKey.get(key)))); tabLinks.set(key, a); return a; };
  const more = h('button', { type: 'button', class: 'tab tab-menu', 'aria-haspopup': 'dialog' }, icon('menu', 22), h('span', null, 'Menu'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Quick links' }, plan.first.map(tab), more);
  const topSearch = h('button', { type: 'button', class: 'top-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', null, 'Jump to a page'), h('kbd', null, isMac() ? '⌘K' : 'Ctrl K'));
  const topInbox = have('inbox') ? keep('inbox', h('a', { href: '#/inbox', class: 'top-inbox', dataset: { key: 'inbox' }, 'aria-label': 'Inbox' }, icon('inbox', 22))) : null;
  const topbar = h('header', { class: 'topbar' }, h('div', { class: 'top-brand' }, h('img', { class: 'brand-mark', src: '/brand/verdynt-mark.png', alt: 'Verdynt/OS', width: '53', height: '30' }), h('strong', null, ctx.me.tenant_name)), topSearch, topAsk, topInbox);

  /** A sheet over the page (the phone menu and All apps). build(close) returns its content. */
  function sheet(title, cls, build) {
    const previous = document.activeElement;
    const closeBtn = h('button', { type: 'button', class: 'sheet-close', 'aria-label': `Close ${title.toLowerCase()}` }, icon('close', 20));
    const titleId = `sheet-${Math.random().toString(36).slice(2, 7)}`;
    const box = h('div', { class: `dialog menu-sheet ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    const overlay = h('div', { class: 'overlay menu-overlay' }, box);
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); if (previous && previous.isConnected && previous.focus) previous.focus(); }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    box.append(h('header', null, h('h2', { id: titleId }, title), closeBtn), build(close));
    box.addEventListener('click', (e) => { if (e.target.closest('a[href]')) close(); });
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    closeBtn.focus();
    return { close, box };
  }
  const tile = (k) => h('a', { href: `#/${k}`, class: 'sheet-item', dataset: { key: k }, 'aria-current': currentKey === k ? 'page' : null }, icon(k, 20), h('span', null, byKey.get(k)), dots.has(k) ? h('span', { class: 'nav-badge dot', 'aria-label': 'new' }) : null);
  const chips = () => h('div', { class: 'sheet-chips', role: 'group', 'aria-label': 'Patrol sections' },
    PATROL_SECTIONS.map(([id, text]) => h('a', { href: `#/patrol/${id}`, class: 'sheet-chip', 'aria-current': currentKey === 'patrol' && currentSection === id ? 'true' : null }, text)));
  const groupBlock = ([heading, id, keys], withHeading = true) => h('div', { class: 'sheet-group', dataset: { group: id } },
    withHeading ? h('p', { class: 'nav-title' }, h('span', null, heading)) : null,
    h('div', { class: 'sheet-grid' }, keys.map(tile)),
    keys.includes('patrol') && currentKey === 'patrol' ? chips() : null);

  /** Every other app this person may open (role menus): grouped, one tap away. */
  function openAllApps() {
    return sheet('All apps', 'all-apps', () => h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Apps you can use that are not in your menu.'),
      grouped(plan.more).map((g) => groupBlock(g))));
  }

  function openSheet() {
    const searchBox = h('input', { type: 'search', class: 'sheet-search', placeholder: 'Jump to an app or page', 'aria-label': 'Jump to an app or page', autocomplete: 'off' });
    const s = sheet('Menu', 'phone-menu', (close) => {
      searchBox.addEventListener('input', () => { const q = searchBox.value; close(); openPalette(q); });
      const blocks = plan.role
        ? [groupBlock(['Your apps', 'home', [...plan.apps, ...plan.mine]], false)]
        : [...(plan.start.length ? [groupBlock(['Start', 'home', plan.start])] : []), ...plan.groups.map((g) => groupBlock([g.name, g.id, g.keys]))];
      const all = plan.role && plan.more.length ? h('button', { type: 'button', class: 'sheet-row nav-all' }, icon('apps', 20), h('span', null, 'All apps'), h('span', { class: 'nav-more' }, `${plan.more.length} more`)) : null;
      if (all) all.addEventListener('click', () => { close(); openAllApps(); });
      const signOutBtn = outBtn('btn small');
      signOutBtn.addEventListener('click', close, { capture: true });
      const sw = switchBtn('btn small');
      if (sw) sw.addEventListener('click', close, { capture: true });
      return h('div', { class: 'sheet-body' }, searchBox, h('div', { class: 'sheet-groups' }, blocks, all),
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
    if (plan.role && plan.more.length) list.push({ id: 'all', title: 'All apps', hint: `${plan.more.length} more`, icon: 'apps', words: 'apps more everything', run: () => openAllApps() });
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

    const everything = () => [
      ...views.map(([key, text]) => ({ id: `page-${key}`, title: text, hint: key === currentKey ? 'You are here' : '', icon: key, words: `${text} ${ALSO[key] || ''}`, run: () => { location.hash = `#/${key}`; } })),
      ...(have('patrol') ? PATROL_SECTIONS.map(([id, text]) => ({ id: `patrol-${id}`, title: `Patrol: ${text}`, hint: currentKey === 'patrol' && currentSection === id ? 'You are here' : '', icon: 'patrol', words: `patrol ${text}`, run: () => { location.hash = `#/patrol/${id}`; } })) : []),
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
        const rest = all.filter((i) => !rec.includes(i));
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
        const li = h('li', { class: 'palette-item', role: 'option', id: `pal-${idx}`, 'aria-selected': String(idx === at) }, icon(r.icon, 18), h('span', { class: 'p-title' }, r.title), r.hint ? h('span', { class: 'p-hint' }, r.hint) : null);
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

  /** Marks where the person is: the app in the menus, and Patrol's section while Patrol is open. */
  function setCurrent(key, params = []) {
    currentKey = key;
    currentSection = key === 'patrol' ? patrolSection(params) : null;
    for (const [k, anchors] of links) for (const a of anchors) { if (k === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    for (const box of sectionBoxes) box.hidden = key !== 'patrol';
    for (const a of sectionLinks) { if (a.dataset.section === currentSection) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }
    // Keep the open app in view when the side menu is taller than the screen.
    const here = (key === 'patrol' && sectionBoxes[0]) || nav.querySelector(`[data-key="${key}"]`);
    if (here && here.scrollIntoView && shell.isConnected) { try { here.scrollIntoView({ block: 'nearest' }); } catch (_) { /* old browsers */ } }
    more.classList.toggle('on', !tabLinks.has(key));
    const rec = [key, ...recent().filter((k) => k !== key)].slice(0, 5);
    write(RECENT_KEY, JSON.stringify(rec));
  }
  /**
   * A count on a page's menu links (unread messages on Inbox). 0 removes it. With { dot: true } it is a small dot
   * instead of a number (Help, when What's new has something): quiet, and repeated on the phone's Menu button when
   * the page sits inside the menu sheet there.
   */
  function setBadge(key, n, { dot = false, says = 'unread' } = {}) {
    for (const a of links.get(key) || []) {
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
