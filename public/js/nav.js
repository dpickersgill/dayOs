// The menu: a grouped icon rail on wide screens, a bottom bar with a "More" sheet on phones,
// and a jump-to palette (Ctrl+K, Cmd+K or "/") that opens any page by typing a few letters.
import { h, clear, ctx, label, isManager } from './ui.js';
import { icon } from './icons.js';

// Menu groups: label, colour key, pages. Today stands alone at the top. Each group has its own accent, used on the menu, the page title and the tabs.
const GROUPS = [
  ['Front desk', 'front', ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers']],
  ['Mountain', 'mountain', ['conditions', 'park', 'assets']],
  ['Safety', 'safety', ['patrol']],
  ['Programs', 'programs', ['school', 'programs', 'availability']],
  ['Office', 'office', ['catalog', 'money', 'workforce', 'messages', 'documents']],
];
export const GROUP_OF = Object.fromEntries(GROUPS.flatMap(([name, id, keys]) => keys.map((k) => [k, { id, name }])));
const PERSONAL = ['myshifts', 'settings', 'billing', 'help'];
const PHONE_FIRST = ['dashboard', 'sell', 'gate', 'patrol', 'school', 'conditions', 'myshifts'];
// Words people might type that are not in the page's name.
const ALSO = {
  dashboard: 'home overview numbers today', sell: 'ticket pos register checkout basket', gate: 'scan lift ticket scanner check in',
  conditions: 'lifts trails snow open closed status grooming groomer snowmaking weather maintenance work orders inspection fleet downtime handoff report', park: 'terrain park rails jumps boxes features freestyle halfpipe jib map', rentals: 'equipment skis boards boots rent', school: 'lessons instructors ski school',
  programs: 'clubs camps leagues teams', patrol: 'incident case injury first aid dispatch', people: 'customers guests search members',
  catalog: 'products prices passes items', money: 'sales refunds reports till drawer payments', workforce: 'staff schedule shifts hours kiosk time clock pin badge',
  availability: 'instructor calendar open dates times schedule days off private lessons',
  shop: 'online will-call willcall pickup web orders groups waitlist reprint tickets prices calendar pace report',
  messages: 'email text sms campaign newsletter send announce reminder unsubscribe marketing',
  inbox: 'chat message team staff internal conversation dm direct share link talk',
  documents: 'files forms policies manuals handbook pdf upload library repository',
  assets: 'fleet vehicles trucks groomers equipment maintenance parts inventory stock purchase orders vendors fuel inspection qr tag registration insurance warranty depreciation',
  waivers: 'waiver release liability sign signature signed guardian minor consent form',
  myshifts: 'my schedule clock in out', settings: 'account password security two-step sign out',
  billing: 'subscription plan pay payment invoice card bank ach trial renew upgrade receipt summitops',
  help: 'how to guide instructions support questions articles',
};
const RAIL_KEY = 'so.rail';
const RECENT_KEY = 'so.recent';
const FOLD_KEY = 'so.folded';

const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };
const initials = (email) => String(email || '?').split('@')[0].split(/[._-]/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';

/**
 * Builds the page frame. views: [[key, label]] already filtered for this person.
 * Returns { shell, main, setCurrent(key), openPalette() }.
 */
/** The version under Sign out in the account menu: "SummitOps 2026.10.4", linking to What's new. */
function whoVersion() {
  const a = h('a', { class: 'who-version', href: '#/help/whats-new' });
  fetch('/version').then((r) => r.json()).then((v) => { if (v && v.version) a.textContent = `SummitOps ${v.version}`; }).catch(() => {});
  return a;
}

export function buildFrame({ views, main, signOut }) {
  const byKey = new Map(views);
  const have = (k) => byKey.has(k);
  const shell = h('div', { class: 'shell' });
  if (read(RAIL_KEY, 'open') === 'closed') shell.classList.add('collapsed');
  const links = new Map(); // key -> every <a> for that page (rail and phone sheet)

  const link = (key, extra = {}) => {
    const a = h('a', { href: `#/${key}`, dataset: { key }, title: byKey.get(key), ...extra }, icon(key), h('span', { class: 'nav-label' }, byKey.get(key)));
    if (!links.has(key)) links.set(key, []);
    links.get(key).push(a);
    return a;
  };

  // ---- rail
  const sections = GROUPS.map(([name, id, keys]) => ({ name, id, keys: keys.filter(have) })).filter((g) => g.keys.length);
  let folded = [];
  // First visit: every group starts folded so all five headings fit on a small screen; the page you open unfolds its own group.
  try { const saved = read(FOLD_KEY, null); folded = saved === null ? sections.map((g) => g.id) : JSON.parse(saved); } catch (_) { folded = []; }
  const groupEls = new Map();
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
    have('dashboard') || have('inbox') ? h('div', { class: 'nav-group nav-home' }, have('dashboard') ? link('dashboard') : null, have('inbox') ? link('inbox') : null) : null,
    sections.map((g) => {
      const items = h('div', { class: 'nav-items', id: `nav-${g.id}` }, g.keys.map((k) => link(k)));
      const title = h('button', { type: 'button', class: 'nav-title', 'aria-expanded': String(!folded.includes(g.id)), 'aria-controls': `nav-${g.id}` }, h('span', null, g.name), icon('chevron', 14));
      const el = h('div', { class: `nav-group${folded.includes(g.id) ? ' folded' : ''}`, dataset: { group: g.id } }, title, items);
      title.addEventListener('click', () => {
        const nowFolded = !el.classList.contains('folded');
        el.classList.toggle('folded', nowFolded);
        title.setAttribute('aria-expanded', String(!nowFolded));
        folded = nowFolded ? [...new Set([...folded, g.id])] : folded.filter((x) => x !== g.id);
        write(FOLD_KEY, JSON.stringify(folded));
      });
      groupEls.set(g.id, el);
      return el;
    }));
  const personal = PERSONAL.filter(have);
  const toggle = h('button', { type: 'button', class: 'rail-toggle', 'aria-label': 'Collapse menu', 'aria-pressed': String(shell.classList.contains('collapsed')) }, icon('collapse', 18));
  toggle.addEventListener('click', () => {
    const closed = shell.classList.toggle('collapsed');
    write(RAIL_KEY, closed ? 'closed' : 'open');
    toggle.setAttribute('aria-pressed', String(closed));
    toggle.setAttribute('aria-label', closed ? 'Expand menu' : 'Collapse menu');
  });
  const search = h('button', { type: 'button', class: 'rail-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', { class: 'nav-label' }, 'Jump to'), h('kbd', null, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'));
  const out = h('button', { type: 'button', class: 'rail-out', title: 'Sign out' }, icon('signout', 18), h('span', { class: 'nav-label' }, 'Sign out'));
  out.addEventListener('click', () => signOut());
  // One account button replaces four stacked rows: it opens My shifts, Account, Help and Sign out.
  const whoMenu = h('div', { class: 'who-menu', id: 'who-menu', hidden: true }, h('nav', { class: 'nav nav-personal', 'aria-label': 'Your pages' }, h('div', { class: 'nav-group' }, personal.map((k) => link(k)))), out, whoVersion());
  const whoBtn = h('button', { type: 'button', class: 'who', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'who-menu', title: ctx.me.login_name || ctx.me.email },
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(ctx.me.username || ctx.me.email)), h('span', { class: 'who-text' }, h('b', null, ctx.me.login_name || ctx.me.email), h('span', null, label(ctx.me.role))), icon('chevron', 14));
  const setWho = (open) => { whoMenu.hidden = !open; whoBtn.setAttribute('aria-expanded', String(open)); };
  whoBtn.addEventListener('click', (e) => { e.stopPropagation(); setWho(whoMenu.hidden); });
  document.addEventListener('click', (e) => { if (!whoMenu.hidden && !whoMenu.contains(e.target)) setWho(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !whoMenu.hidden) { setWho(false); whoBtn.focus(); } });
  whoMenu.addEventListener('click', (e) => { if (e.target.closest('a')) setWho(false); });
  const rail = h('aside', { class: 'rail' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('conditions', 20)), h('div', { class: 'brand-text' }, h('strong', null, 'SummitOps'), h('span', null, ctx.me.tenant_name)), toggle),
    search, nav,
    h('div', { class: 'rail-foot' }, whoMenu, whoBtn));

  // ---- phone: slim top bar, bottom tabs, and a sheet with everything
  const first = PHONE_FIRST.filter(have).slice(0, 4);
  const tabLinks = new Map();
  const tab = (key) => { const a = h('a', { href: `#/${key}`, dataset: { key }, class: 'tab' }, icon(key, 22), h('span', null, byKey.get(key))); tabLinks.set(key, a); return a; };
  const more = h('button', { type: 'button', class: 'tab', 'aria-haspopup': 'dialog' }, icon('menu', 22), h('span', null, 'More'));
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Quick links' }, first.map(tab), more);
  const topSearch = h('button', { type: 'button', class: 'top-search', 'aria-label': 'Jump to a page' }, icon('search', 18), h('span', null, 'Jump to a page'), h('kbd', null, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K'));
  const topInbox = have('inbox') ? h('a', { href: '#/inbox', class: 'top-inbox', dataset: { key: 'inbox' }, 'aria-label': 'Inbox' }, icon('inbox', 22)) : null;
  if (topInbox) { if (!links.has('inbox')) links.set('inbox', []); links.get('inbox').push(topInbox); }
  const topbar = h('header', { class: 'topbar' }, h('div', { class: 'top-brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('conditions', 18)), h('strong', null, ctx.me.tenant_name)), topSearch, topInbox);

  function openSheet() {
    const items = [['Home', ['dashboard', 'inbox'].filter(have)], ...sections.map((g) => [g.name, g.keys]), ['You', personal]].filter(([, k]) => k.length);
    const closeBtn = h('button', { type: 'button', class: 'btn small' }, 'Close');
    const signOutBtn = h('button', { type: 'button', class: 'btn' }, 'Sign out');
    const sheet = h('div', { class: 'dialog sheet menu-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All pages' },
      h('header', null, h('h2', null, 'Go to'), closeBtn),
      items.map(([name, keys]) => h('div', { class: 'sheet-group' }, h('p', { class: 'nav-title' }, name),
        h('div', { class: 'sheet-grid' }, keys.map((k) => { const a = h('a', { href: `#/${k}`, class: 'sheet-item', 'data-current': String(currentKey === k) }, icon(k, 22), h('span', null, byKey.get(k)), dots.has(k) ? h('span', { class: 'nav-badge dot', 'aria-label': 'new' }) : null); a.addEventListener('click', close); return a; })))),
      signOutBtn);
    const overlay = h('div', { class: 'overlay' }, sheet);
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    closeBtn.addEventListener('click', close);
    signOutBtn.addEventListener('click', () => { close(); signOut(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    closeBtn.focus();
  }
  more.addEventListener('click', openSheet);

  // ---- palette
  let currentKey = null;
  function actions() {
    const list = [];
    if (isManager()) list.push({ id: 'kiosk', title: 'Open the time clock kiosk page', hint: 'New tab', icon: 'clock', words: 'kiosk tablet punch', run: () => window.open('/kiosk', '_blank', 'noopener') });
    list.push({ id: 'rail', title: shell.classList.contains('collapsed') ? 'Expand the menu' : 'Collapse the menu', hint: '', icon: 'collapse', words: 'sidebar rail', run: () => toggle.click() });
    list.push({ id: 'out', title: 'Sign out', hint: '', icon: 'signout', words: 'log out leave', run: () => signOut() });
    return list;
  }
  function recent() { try { return JSON.parse(read(RECENT_KEY, '[]')).filter(have); } catch (_) { return []; } }

  function openPalette() {
    if (document.querySelector('.palette-overlay')) return;
    const previous = document.activeElement;
    const box = h('input', { class: 'palette-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list', placeholder: 'Go to a page or run a command', autocomplete: 'off', spellcheck: 'false' });
    const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
    const foot = h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' to move'), h('span', null, h('kbd', null, 'Enter'), ' to open'), h('span', null, h('kbd', null, 'Esc'), ' to close'));
    const panel = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Jump to a page' }, h('div', { class: 'palette-top' }, icon('search', 18), box), list, foot);
    const overlay = h('div', { class: 'overlay palette-overlay' }, panel);
    let shown = []; let at = 0;

    const everything = () => [
      ...views.map(([key, text]) => ({ id: `page-${key}`, title: text, hint: key === currentKey ? 'You are here' : '', icon: key, words: `${text} ${ALSO[key] || ''}`, run: () => { location.hash = `#/${key}`; } })),
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
  search.addEventListener('click', openPalette);
  topSearch.addEventListener('click', openPalette);
  const onGlobalKey = (e) => {
    if (!shell.isConnected) { document.removeEventListener('keydown', onGlobalKey); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openPalette(); }
  };
  document.addEventListener('keydown', onGlobalKey);

  shell.append(rail, h('div', { class: 'frame' }, topbar, main), tabbar);

  function setCurrent(key) {
    currentKey = key;
    const g = GROUP_OF[key];
    if (g && groupEls.get(g.id) && groupEls.get(g.id).classList.contains('folded')) groupEls.get(g.id).querySelector('.nav-title').click();
    for (const [k, anchors] of links) for (const a of anchors) { if (k === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    for (const [k, a] of tabLinks) { if (k === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    more.classList.toggle('on', !first.includes(key));
    const rec = [key, ...recent().filter((k) => k !== key)].slice(0, 5);
    write(RECENT_KEY, JSON.stringify(rec));
  }
  /**
   * A count on a page's menu links (unread messages on Inbox). 0 removes it. With { dot: true } it is a small dot
   * instead of a number (Help, when What's new has something): quiet, and repeated on the account button and the
   * phone's More tab, since Help sits inside those.
   */
  const dots = new Set();
  function setBadge(key, n, { dot = false, says = 'unread' } = {}) {
    for (const a of links.get(key) || []) {
      let b = a.querySelector('.nav-badge');
      if (!n) { if (b) b.remove(); a.removeAttribute('aria-description'); continue; }
      if (!b) { b = h('span', { class: 'nav-badge', 'aria-hidden': 'true' }); a.append(b); }
      b.classList.toggle('dot', dot);
      b.textContent = dot ? '' : n > 99 ? '99+' : String(n);
      a.setAttribute('aria-description', dot ? says : `${n} ${says}`);
    }
    if (personal.includes(key)) {
      if (n) dots.add(key); else dots.delete(key);
      for (const el of [whoBtn, more]) {
        el.classList.toggle('has-new', dots.size > 0);
        if (dots.size) el.setAttribute('aria-description', 'Something new in Help'); else el.removeAttribute('aria-description');
      }
    }
  }
  return { shell, setCurrent, openPalette, setBadge };
}
