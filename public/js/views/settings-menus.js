// Settings, Team and logins, Menus for each role: what each role sees in its menu, in what order, and the screen it
// opens on. Everything else the role may open stays under All apps (and Jump to). Owners change; managers can look.
import { get, put } from '../api.js';
import { h, clear, ctx, select } from '../ui.js';
import { saveBar } from './settings-kit.js';

const ROLE_NAMES = [['counter', 'Ticket window and rentals'], ['instructor', 'Instructor'], ['staff', 'Lift and mountain staff'], ['patrol', 'Patroller'], ['manager', 'Managers']];
const MENU_NAMES = { counter: 'ticket window', instructor: 'instructor', staff: 'lift and mountain staff', patrol: 'patroller' };
const same = (a, b) => a.start === b.start && a.apps.join() === b.apps.join();
const copy = (m) => ({ apps: [...m.apps], start: m.start });

export async function drawMenus(box) {
  const data = await get('/settings/menus');
  const can = data.can_change;
  const always = data.always;
  const name = (k) => data.apps[k] || k;
  const on = (k) => !ctx.me.modules || always.includes(k) || ['dashboard', 'people', 'waivers', 'lostfound', 'myshifts', 'inbox'].includes(k) || ctx.me.modules.includes(k);
  const saved = Object.fromEntries(Object.entries(data.roles).map(([r, m]) => [r, copy(m)]));
  const work = Object.fromEntries(Object.entries(data.roles).map(([r, m]) => [r, copy(m)]));
  let role = 'counter';

  const changedRoles = () => Object.keys(work).filter((r) => !same(work[r], saved[r]));
  const bar = saveBar({
    count: () => changedRoles().length,
    message: (n) => (n === 1 ? `You changed the ${MENU_NAMES[changedRoles()[0]]} menu.` : `You changed ${n} menus.`),
    undo: () => { for (const r of Object.keys(work)) work[r] = copy(saved[r]); draw(); },
    save: async () => {
      for (const r of changedRoles()) {
        const standard = same(work[r], data.standard[r]);
        const out = await put('/settings/menus', { role: r, menu: standard ? null : work[r] });
        saved[r] = copy(out.menu);
        work[r] = copy(out.menu);
      }
      draw();
    },
  });

  const picker = h('div', { class: 'set-roles', role: 'radiogroup', 'aria-label': 'Role' });
  const body = h('div', { class: 'stack' });
  box.append(h('div', { class: 'stack set-menus' },
    h('p', { class: 'set-lead' }, 'Choose what each role sees in its menu. People can still open anything their role allows from All apps or Jump to; this only decides what is in front of them.'),
    can ? null : h('div', { class: 'callout' }, 'Only the owner can change the menus. You can see them here.'),
    picker, body, bar.bar));

  function pickRole(r, focus) {
    role = r;
    draw();
    if (focus) picker.querySelector(`[data-role=${r}]`).focus();
  }
  function drawPicker() {
    clear(picker).append(...ROLE_NAMES.map(([r, text]) => {
      const b = h('button', { type: 'button', role: 'radio', class: 'set-role', 'aria-checked': String(r === role), tabIndex: r === role ? 0 : -1, dataset: { role: r } }, text);
      b.addEventListener('click', () => pickRole(r));
      b.addEventListener('keydown', (e) => {
        const keys = ROLE_NAMES.map((x) => x[0]); const at = keys.indexOf(r);
        const to = { ArrowRight: keys[(at + 1) % keys.length], ArrowDown: keys[(at + 1) % keys.length], ArrowLeft: keys[(at - 1 + keys.length) % keys.length], ArrowUp: keys[(at - 1 + keys.length) % keys.length] }[e.key];
        if (to) { e.preventDefault(); pickRole(to, true); }
      });
      return b;
    }));
  }

  function draw(focusSel) {
    drawPicker();
    clear(body);
    if (role === 'manager') {
      body.append(h('section', { class: 'set-card' }, h('div', { class: 'set-card-head' }, h('h2', null, 'Managers and owners')),
        h('p', { class: 'set-card-intro' }, 'Managers and owners see everything: every app that is on, in five groups, with Settings and Help at the bottom. Their menu cannot be changed.')));
      bar.refresh();
      return;
    }
    const m = work[role];
    const move = (k, by) => { const i = m.apps.indexOf(k); const j = i + by; if (j < 0 || j >= m.apps.length) return; [m.apps[i], m.apps[j]] = [m.apps[j], m.apps[i]]; draw(`[data-app="${k}"] [data-act=${by < 0 ? 'up' : 'down'}]`); };
    const takeOut = (k) => { m.apps = m.apps.filter((x) => x !== k); if (m.start === k) m.start = m.apps[0]; draw('[data-list=out] button'); };
    const addIn = (k) => { let at = m.apps.length; while (at > 0 && always.includes(m.apps[at - 1])) at -= 1; m.apps.splice(at, 0, k); draw(`[data-app="${k}"] [data-act=out]`); };
    const note = (k) => (always.includes(k) ? 'always in' : !on(k) ? 'off for your mountain' : k === 'sell' && ctx.me.modules && ctx.me.modules.includes('sell') ? 'with the Partner passes tab' : null);
    const inList = h('ol', { class: 'set-menu-list', 'data-list': 'in' }, m.apps.map((k, i) => h('li', { dataset: { app: k } },
      h('span', { class: 'set-move' },
        h('button', { type: 'button', class: 'set-icon-btn', 'data-act': 'up', 'aria-label': `Move ${name(k)} up`, disabled: !can || i === 0, onclick: () => move(k, -1) }, '▲'),
        h('button', { type: 'button', class: 'set-icon-btn', 'data-act': 'down', 'aria-label': `Move ${name(k)} down`, disabled: !can || i === m.apps.length - 1, onclick: () => move(k, 1) }, '▼')),
      h('span', { class: 'set-menu-name' }, name(k), note(k) ? h('small', { class: 'set-menu-note' }, note(k)) : null),
      always.includes(k) ? null : h('button', { type: 'button', class: 'btn small', 'data-act': 'out', disabled: !can || m.apps.length <= always.length + 1, onclick: () => takeOut(k) }, 'Take out'))));
    const rest = data.roles[role].can_open.filter((k) => !m.apps.includes(k));
    const outList = rest.length ? h('ul', { class: 'set-menu-list', 'data-list': 'out' }, rest.map((k) => h('li', { dataset: { app: k } },
      h('span', { class: 'set-menu-name plain' }, name(k), !on(k) ? h('small', { class: 'set-menu-note' }, 'off for your mountain') : null),
      h('button', { type: 'button', class: 'btn small', 'data-act': 'in', disabled: !can, onclick: () => addIn(k) }, 'Add to menu'))))
      : h('p', { class: 'set-card-intro' }, 'Everything this role can open is in its menu.');
    const start = select(m.apps.map((k) => [k, name(k)]), m.start, { name: 'start', disabled: !can });
    start.id = 'set-menu-start';
    start.addEventListener('change', () => { m.start = start.value; bar.refresh(); });
    const isStandard = same(m, data.standard[role]);
    const reset = h('button', { type: 'button', class: 'btn', disabled: !can || isStandard, onclick: () => { work[role] = copy(data.standard[role]); draw(); } }, 'Put back the standard menu');
    body.append(
      h('div', { class: 'set-two' },
        h('section', { class: 'set-card', 'aria-labelledby': 'set-in-h' }, h('div', { class: 'set-card-head' }, h('h2', { id: 'set-in-h' }, 'In their menu'), h('span', { class: 'set-hint' }, 'In this order')), inList),
        h('section', { class: 'set-card', 'aria-labelledby': 'set-out-h' }, h('div', { class: 'set-card-head' }, h('h2', { id: 'set-out-h' }, 'Under All apps'), h('span', { class: 'set-hint' }, 'Still one click away')), outList)),
      h('div', { class: 'set-card set-menu-foot' },
        h('div', { class: 'field' }, h('label', { for: 'set-menu-start' }, 'Opens on'), start),
        h('p', { class: 'set-hint' }, m.apps.includes('sell') || data.roles[role].can_open.includes('sell')
          ? ['Partner passes is a tab inside Sell. Turn it off under ', h('a', { href: '#/settings/sell' }, 'Sell and gate'), ' if your mountain does not take a partner pass.']
          : isStandard ? 'This is the standard menu for this role.' : 'Changed from the standard menu.'),
        reset));
    bar.refresh();
    if (focusSel) { const el = body.querySelector(focusSel); if (el && !el.disabled) el.focus(); else { const any = body.querySelector('.set-menu-list button:not([disabled])'); if (any) any.focus(); } }
  }
  draw();
}
