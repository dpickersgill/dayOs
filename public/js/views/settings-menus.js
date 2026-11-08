// Settings, Team and logins, Menus for each role, owners and managers included: what each role sees in its menu, in what
// order, and the screen it opens on. Home (Today, Inbox, Calendar, My shifts) is pinned at the top for everyone, so it is
// shown here as fixed and is not offered. Everything else the role may open stays under All apps (and Jump to). Owners
// change; managers can look. The patrol director has a menu apart from the patrollers', and each position (Staff and
// schedule) can have one: Park crew gets the terrain park, not the lifts.
import { get, put } from '../api.js';
import { h, clear, ctx, select } from '../ui.js';
import { ROLE_NAMES } from '../nav.js';
import { saveBar } from './settings-kit.js';

// The rows, named as the person's name card names the role (nav.js ROLE_NAMES).
const ROLE_ROWS = ['counter', 'instructor', 'staff', 'patrol_director', 'patrol', 'manager', 'owner'];
const MENU_NAMES = { counter: 'ticket window', instructor: 'instructor', staff: 'lift and mountain staff', patrol_director: 'patrol director', patrol: 'patroller', manager: 'manager', owner: 'owner' };
const same = (a, b) => (!a && !b) || (Boolean(a) && Boolean(b) && a.start === b.start && a.apps.join() === b.apps.join());
const copy = (m) => (m ? { apps: [...m.apps], start: m.start } : null);

export async function drawMenus(box) {
  const data = await get('/settings/menus');
  const can = data.can_change;
  const home = data.home || data.always || [];
  const name = (k) => data.apps[k] || k;
  const on = (k) => {
    const app = data.links && data.links[k] ? data.links[k].app : k;
    return !ctx.me.modules || home.includes(app) || ['dashboard', 'calendar', 'people', 'waivers', 'lostfound', 'myshifts', 'inbox'].includes(app) || ctx.me.modules.includes(app);
  };
  const positions = data.positions || [];
  const rows = ROLE_ROWS.filter((r) => data.roles[r]);
  const rowName = (r) => (r.startsWith('pos:') ? (positions.find((p) => p.key === r) || {}).name || r : ROLE_NAMES[r] || r);
  const canOpen = (r) => (r.startsWith('pos:') ? (positions.find((p) => p.key === r) || {}).can_open || [] : data.roles[r].can_open);
  const saved = Object.fromEntries([...rows.map((r) => [r, copy(data.roles[r])]), ...positions.map((p) => [p.key, p.own ? { apps: p.apps, start: p.start } : null])]);
  const work = Object.fromEntries(Object.entries(saved).map(([r, m]) => [r, copy(m)]));
  let role = 'counter';

  const changedRows = () => Object.keys(work).filter((r) => !same(work[r], saved[r]));
  const bar = saveBar({
    count: () => changedRows().length,
    message: (n) => (n === 1 ? `You changed the ${MENU_NAMES[changedRows()[0]] || rowName(changedRows()[0])} menu.` : `You changed ${n} menus.`),
    undo: () => { for (const r of Object.keys(work)) work[r] = copy(saved[r]); draw(); },
    save: async () => {
      for (const r of changedRows()) {
        const standard = !work[r] || same(work[r], data.standard[r]);
        const out = await put('/settings/menus', { role: r, menu: standard ? null : work[r] });
        saved[r] = copy(out.menu);
        work[r] = copy(out.menu);
      }
      draw();
    },
  });

  const picker = h('div', { class: 'set-roles', role: 'radiogroup', 'aria-label': 'Role' });
  const posPicker = positions.length ? h('div', { class: 'set-roles', role: 'radiogroup', 'aria-labelledby': 'set-pos-h' }) : null;
  const body = h('div', { class: 'stack' });
  box.append(h('div', { class: 'stack set-menus' },
    h('p', { class: 'set-lead' }, 'Choose what each role sees in its menu. People can still open anything their role allows from All apps or Jump to; this only decides what is in front of them.'),
    can ? null : h('div', { class: 'callout' }, 'Only the owner can change the menus. You can see them here.'),
    picker,
    posPicker ? h('div', { class: 'stack tight' }, h('h2', { class: 'set-sub', id: 'set-pos-h' }, 'Positions'),
      h('p', { class: 'set-hint' }, 'From Staff and schedule. People whose role is Lift and mountain staff or Ticket window and rentals get their position’s menu instead of their role’s.'), posPicker) : null,
    body, bar.bar));

  const allKeys = () => [...rows, ...positions.map((p) => p.key)];
  function pickRole(r, focus) {
    role = r;
    draw();
    if (focus) box.querySelector(`[data-role="${r}"]`).focus();
  }
  function roleButton(r, text) {
    const b = h('button', { type: 'button', role: 'radio', class: 'set-role', 'aria-checked': String(r === role), tabIndex: r === role ? 0 : -1, dataset: { role: r } }, text);
    b.addEventListener('click', () => pickRole(r));
    b.addEventListener('keydown', (e) => {
      const keys = allKeys(); const at = keys.indexOf(r);
      const to = { ArrowRight: keys[(at + 1) % keys.length], ArrowDown: keys[(at + 1) % keys.length], ArrowLeft: keys[(at - 1 + keys.length) % keys.length], ArrowUp: keys[(at - 1 + keys.length) % keys.length] }[e.key];
      if (to) { e.preventDefault(); pickRole(to, true); }
    });
    return b;
  }
  function drawPicker() {
    clear(picker).append(...rows.map((r) => roleButton(r, ROLE_NAMES[r] || r)));
    if (posPicker) clear(posPicker).append(...positions.map((p) => roleButton(p.key, p.name)));
  }

  function draw(focusSel) {
    drawPicker();
    clear(body);
    const position = role.startsWith('pos:') ? positions.find((p) => p.key === role) : null;
    const may = canOpen(role);
    const fixed = home.filter((k) => may.includes(k));
    if (position && !work[role]) {
      // A position with no menu of its own: its people use their role's menu.
      body.append(h('section', { class: 'set-card set-menu-foot' },
        h('p', null, h('b', null, position.name), ' uses the menu of its people’s role (Lift and mountain staff, or Ticket window and rentals).'),
        h('button', { type: 'button', class: 'btn', disabled: !can, 'data-act': 'own-menu', onclick: () => { work[role] = copy(data.roles.staff); draw('[data-list=in] button'); } }, 'Give it its own menu')));
      bar.refresh();
      return;
    }
    const m = work[role];
    const move = (k, by) => { const i = m.apps.indexOf(k); const j = i + by; if (j < 0 || j >= m.apps.length) return; [m.apps[i], m.apps[j]] = [m.apps[j], m.apps[i]]; draw(`[data-app="${k}"] [data-act=${by < 0 ? 'up' : 'down'}]`); };
    const startable = (k) => !(data.links && data.links[k]);
    const takeOut = (k) => { m.apps = m.apps.filter((x) => x !== k); if (m.start === k) m.start = fixed.includes('dashboard') && ['owner', 'manager'].includes(role) ? 'dashboard' : m.apps.find(startable) || 'dashboard'; draw('[data-list=out] button'); };
    const addIn = (k) => { m.apps.push(k); draw(`[data-app="${k}"] [data-act=out]`); };
    const note = (k) => (!on(k) ? 'off for your mountain' : data.links && data.links[k] ? `a page in ${name(data.links[k].app)}` : k === 'sell' && ctx.me.modules && ctx.me.modules.includes('sell') ? 'with the Partner passes tab' : null);
    const inList = h('ol', { class: 'set-menu-list', 'data-list': 'in' }, m.apps.map((k, i) => h('li', { dataset: { app: k } },
      h('span', { class: 'set-move' },
        h('button', { type: 'button', class: 'set-icon-btn', 'data-act': 'up', 'aria-label': `Move ${name(k)} up`, disabled: !can || i === 0, onclick: () => move(k, -1) }, '▲'),
        h('button', { type: 'button', class: 'set-icon-btn', 'data-act': 'down', 'aria-label': `Move ${name(k)} down`, disabled: !can || i === m.apps.length - 1, onclick: () => move(k, 1) }, '▼')),
      h('span', { class: 'set-menu-name' }, name(k), note(k) ? h('small', { class: 'set-menu-note' }, note(k)) : null),
      h('button', { type: 'button', class: 'btn small', 'data-act': 'out', disabled: !can || m.apps.length <= 1, onclick: () => takeOut(k) }, 'Take out'))));
    const rest = may.filter((k) => !m.apps.includes(k) && !home.includes(k));
    const outList = rest.length ? h('ul', { class: 'set-menu-list', 'data-list': 'out' }, rest.map((k) => h('li', { dataset: { app: k } },
      h('span', { class: 'set-menu-name plain' }, name(k), note(k) ? h('small', { class: 'set-menu-note' }, note(k)) : null),
      h('button', { type: 'button', class: 'btn small', 'data-act': 'in', disabled: !can, onclick: () => addIn(k) }, 'Add to menu'))))
      : h('p', { class: 'set-card-intro' }, 'Everything this role can open is in its menu.');
    const start = select([...fixed, ...m.apps.filter(startable)].map((k) => [k, name(k)]), m.start, { name: 'start', disabled: !can });
    start.id = 'set-menu-start';
    start.addEventListener('change', () => { m.start = start.value; bar.refresh(); });
    const std = data.standard[role] || null;
    const isStandard = same(m, std);
    const reset = position
      ? h('button', { type: 'button', class: 'btn', disabled: !can || isStandard, onclick: () => { work[role] = copy(std); draw(); } }, std ? 'Put back the standard menu' : 'Use the role’s menu')
      : h('button', { type: 'button', class: 'btn', disabled: !can || isStandard, onclick: () => { work[role] = copy(std); draw(); } }, 'Put back the standard menu');
    const homeCard = fixed.length ? h('section', { class: 'set-card set-home', 'aria-labelledby': 'set-home-h' },
      h('div', { class: 'set-card-head' }, h('h2', { id: 'set-home-h' }, 'Home'), h('span', { class: 'set-hint' }, 'Always at the top, for everyone')),
      h('ul', { class: 'set-fixed', 'aria-label': 'Fixed at the top of the menu' }, fixed.map((k) => h('li', { class: 'set-fixed-app', dataset: { app: k } }, name(k), h('small', { class: 'set-menu-note' }, 'fixed'))))) : null;
    const who = position ? `For people working ${position.name} whose role is Lift and mountain staff or Ticket window and rentals. Each sees only the apps their role may open.`
      : role === 'patrol_director' ? 'For patrollers whose roster access is Admin or Manager. Other patrollers get the Patroller menu.'
        : role === 'patrol' ? 'For patrollers. The Patrol director has a menu of its own.'
          : role === 'staff' && positions.length ? 'For lift and mountain staff whose positions have no menu of their own.' : null;
    body.append(...[who ? h('p', { class: 'set-hint' }, who) : null, homeCard].filter(Boolean),
      h('div', { class: 'set-two' },
        h('section', { class: 'set-card', 'aria-labelledby': 'set-in-h' }, h('div', { class: 'set-card-head' }, h('h2', { id: 'set-in-h' }, 'In their menu'), h('span', { class: 'set-hint' }, 'In this order')), inList),
        h('section', { class: 'set-card', 'aria-labelledby': 'set-out-h' }, h('div', { class: 'set-card-head' }, h('h2', { id: 'set-out-h' }, 'Under All apps'), h('span', { class: 'set-hint' }, 'Still one click away')), outList)),
      h('div', { class: 'set-card set-menu-foot' },
        h('div', { class: 'field' }, h('label', { for: 'set-menu-start' }, 'Opens on'), start),
        h('p', { class: 'set-hint' }, m.apps.includes('sell') || may.includes('sell')
          ? ['Partner passes is a tab inside Sell. Turn it off under ', h('a', { href: '#/settings/sell' }, 'Sell and gate'), ' if your mountain does not take a partner pass.']
          : isStandard ? 'This is the standard menu for this role.' : 'Changed from the standard menu.'),
        reset));
    bar.refresh();
    if (focusSel) { const el = body.querySelector(focusSel); if (el && !el.disabled) el.focus(); else { const any = body.querySelector('.set-menu-list button:not([disabled])'); if (any) any.focus(); } }
  }
  draw();
}
