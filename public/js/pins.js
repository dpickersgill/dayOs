// Pins: the top of a person's menu ("Pinned"), arranged by the person. With nothing saved they are the role's menu as
// the owner set it; a person can pin the page they are on (the star in the top bar, with its tab and filters), pin or
// unpin from a menu row (right-click, or a long press on a phone), reorder, rename and reset in Edit, and choose the
// four pages on their phone's bottom bar. Pins are kept on the server for the person (/me/nav), so they are the same on
// every device. A shared counter computer and the ski area's read-only login keep the role's menu: nothing here is
// offered there.
//
// This module draws nothing in the menu itself. The frame (nav.js) does, from frame.setPins(pins, bar); it tells this
// module what the person asked for through three events on window: nav:page (where they are), nav:edit-pins (Edit was
// pressed) and nav:row-menu (a row was right-clicked or long-pressed). main.js loads it after the frame is built.
import { h, clear, ctx, svg, dialog, toast } from './ui.js';
import { icon } from './icons.js';
import { get, put, del, describeError } from './api.js';

export const PIN_MAX = 12;
export const LABEL_MAX = 40;
export const BAR_MAX = 4;
// A page address a pin may hold, as the server checks it (src/lib/menus.js): an app, path parts, a query; no ".." part.
const HREF = /^[a-z0-9-]+(\/[A-Za-z0-9_.-]+)*(\?[A-Za-z0-9_=&%.,:+-]*)?$/;
// Home pages that can go on the phone bar (Inbox has its own button in the phone's top bar).
const BAR_HOME = [['dashboard', 'Today'], ['myshifts', 'My shifts'], ['calendar', 'Calendar']];

/** The app a page address belongs to: its first part. 'patrol/cases?tab=records' -> 'patrol'. */
export const appOf = (href) => String(href || '').split(/[/?]/)[0];
/** A location hash as a pin's address: '#/works?status=overdue' -> 'works?status=overdue'. */
export const hrefOfHash = (hash) => String(hash || '').replace(/^#\/?/, '').replace(/\/+(\?|$)/, '$1').replace(/\?$/, '');
/** Can this address be pinned? (Its form; the server also checks the person may open its app.) */
export function pinnable(href) {
  if (typeof href !== 'string' || !href || href.length > 200 || !HREF.test(href)) return false;
  return !href.split('?')[0].split('/').some((part) => /^\.+$/.test(part));
}
/** The address to pin for a page: as it is, or without its filters when they hold something an address may not. */
export function pinHref(href) {
  if (pinnable(href)) return href;
  const path = String(href || '').split('?')[0];
  return pinnable(path) ? path : null;
}
/** A list with one item moved from one place to another. */
export function moved(list, from, to) {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}
const newId = () => `p${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
const same = (a, b) => JSON.stringify([a.pins, a.bar, a.custom]) === JSON.stringify([b.pins, b.bar, b.custom]);
const barItem = (p) => ({ label: p.label, href: p.href, app: p.app, ...(p.icon ? { icon: p.icon } : {}) });

// Small line icons of this module's own, in the menu icons' style (24px grid, round joins).
const PATHS = {
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
};
const glyph = (name, size = 18) => svg('svg', { class: 'ico', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, svg('path', { d: PATHS[name] }));
const grip = () => svg('svg', { class: 'ico', width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'aria-hidden': 'true' }, svg('path', { d: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01' }));

let live = null; // the running instance; start() ends the one before it (the shell is built again after each sign-in)

/**
 * Starts pins for this frame: shows the person's pins, fills the star, and answers Edit, the row menu and the palette.
 * Returns the instance (for tests): { state(), pin(), unpin(), stop() }.
 */
export function start(frame) {
  if (live) live.stop();
  live = null;
  const me = ctx.me;
  const first = me && me.nav;
  // An older server (or a kept copy of the person from before this release): the frame's own starting pins stay.
  if (!frame || !first || !Array.isArray(first.pins)) return null;

  // What the menu shows, what the server last confirmed, and the role's starting pins once the server has said them.
  let state = { pins: first.pins, bar: first.bar || null, custom: Boolean(first.custom) };
  let kept = state;
  let standard = null;
  // The page on screen: the frame's last nav:page when this module arrives after it, else the address and title.
  let page = frame.page && typeof frame.page.href === 'string' ? { key: frame.page.key || appOf(frame.page.href), href: hrefOfHash(frame.page.href), label: frame.page.label || '' }
    : { key: appOf(hrefOfHash(location.hash)), href: hrefOfHash(location.hash), label: String(document.title || '').split(' · ')[0] };
  let editor = null; // the open Edit dialog: { redraw(focus), close() }
  let menu = null; // the open row menu: { close() }
  // A shared counter computer and the ski area's login keep the role's menu; nothing to change is offered there.
  const canEdit = frame.canEdit !== false && me.role !== 'area' && !me.terminal;

  const pinAt = (href) => state.pins.find((p) => p.href === href) || null;
  function show(focus) {
    if (frame.setPins) frame.setPins(state.pins, state.bar);
    if (ctx.me === me) me.nav = { pins: state.pins, bar: state.bar, custom: state.custom };
    paintStar();
    if (editor) editor.redraw(focus);
  }

  // ---- saving: the menu changes at once; the server is told after, and a refusal puts the menu back and says why
  let busy = false; let again = false;
  async function push() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      do {
        again = false;
        const sent = state;
        const out = sent.custom ? await put('/me/nav', { pins: sent.pins, bar: sent.bar ? sent.bar.map((b) => b.href) : null }) : await del('/me/nav');
        kept = { pins: out.pins, bar: out.bar || null, custom: Boolean(out.custom) };
        if (Array.isArray(out.standard)) standard = out.standard;
        // The server's copy is the one kept (it may have left out a pin whose app is off). Drawn again only when it
        // differs, so a name being typed in Edit is not thrown away by a save that changed nothing.
        // When it is the same, the objects already drawn are kept, so the rows in Edit still point at the pins in state.
        if (state === sent) { if (same(kept, sent)) kept = sent; else { state = kept; show(); } }
      } while (again);
    } catch (err) {
      again = false;
      state = kept;
      show();
      toast(`Your pins were not saved. ${describeError(err)}`, 'error');
    } finally { busy = false; }
  }
  /** The person's own list from now on. focus: what to focus in Edit after it is drawn again. */
  function change(pins, bar = state.bar, focus) {
    // The bar holds pins and Home pages: a pin taken out leaves it, and a renamed pin is renamed there.
    const nextBar = bar ? bar.map((b) => { const p = pins.find((x) => x.href === b.href); return p ? barItem(p) : BAR_HOME.some(([k]) => k === b.href) ? b : null; }).filter(Boolean) : null;
    state = { pins, bar: nextBar, custom: true };
    show(focus);
    return push();
  }
  async function reset() {
    // The role's menu is shown at once when it is known; else as soon as the server answers.
    if (standard) { state = { pins: standard, bar: null, custom: false }; show('reset'); return push(); }
    try {
      const out = await del('/me/nav');
      state = { pins: out.pins, bar: null, custom: false }; kept = state; standard = out.standard || null;
      show('reset');
    } catch (err) { toast(`Your pins were not reset. ${describeError(err)}`, 'error'); }
    return undefined;
  }

  /** Pins a page. Returns true when it was pinned. */
  function pin({ href, label, app, icon: ico }) {
    const at = pinHref(href);
    if (!canEdit || !at) return false;
    if (pinAt(at)) return true;
    if (state.pins.length >= PIN_MAX) { toast(`You have ${PIN_MAX} pins, the most there can be. Unpin one to add another.`, 'warn'); return false; }
    const name = String(label || '').trim().slice(0, LABEL_MAX).trim() || appOf(at);
    change([...state.pins, { id: newId(), label: name, href: at, app: app || appOf(at), ...(ico ? { icon: ico } : {}) }]);
    toast(`Pinned ${name}`);
    return true;
  }
  /** Takes a pin out, by its page address. */
  function unpin(href, focus) {
    const p = pinAt(href) || pinAt(pinHref(href));
    if (!canEdit || !p) return false;
    change(state.pins.filter((x) => x !== p), state.bar, focus);
    if (!editor) toast(`Unpinned ${p.label}`);
    return true;
  }

  // ---- the star in the top bar: pins the page you are on, with its tab and filters; pressed again, unpins it
  const star = canEdit && frame.slots && frame.slots.star ? h('button', { type: 'button', class: 'pin-star', 'aria-pressed': 'false', 'aria-label': 'Pin this page to your menu' }, glyph('star', 20)) : null;
  function paintStar() {
    if (!star) return;
    const at = pinHref(page.href);
    const on = Boolean(at && pinAt(at));
    star.setAttribute('aria-pressed', String(on));
    star.disabled = !at;
    star.title = !at ? 'This page cannot be pinned' : on ? 'Unpin this page' : 'Pin this page';
  }
  if (star) {
    star.addEventListener('click', () => { const at = pinHref(page.href); if (!at) return; if (pinAt(at)) unpin(at); else pin(page); });
    clear(frame.slots.star).append(star);
  }

  // ---- the row menu: Pin or Unpin, at the pointer (right-click on a menu row, long press on a phone tile)
  function closeMenu(focusBack) { if (menu) menu.close(focusBack); }
  function openRowMenu({ href, label, x = 0, y = 0 }) {
    closeMenu(false);
    const at = pinHref(href);
    if (!at) return;
    const previous = document.activeElement;
    const on = Boolean(pinAt(at));
    const item = (text, run) => { const b = h('button', { type: 'button', role: 'menuitem', class: 'pin-menu-item', tabindex: '-1' }, text); b.addEventListener('click', () => { close(true); run(); }); return b; };
    const items = [
      on ? item('Unpin', () => unpin(at)) : item('Pin to my menu', () => pin({ href: at, label })),
      item('Edit pins', () => openEditor()),
    ];
    const box = h('div', { class: 'pin-menu', role: 'menu', 'aria-label': label ? `${label}: pins` : 'Pins' }, items);
    const onDown = (e) => { if (!box.contains(e.target)) close(false); };
    const onKey = (e) => {
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); } else if (e.key === 'Tab') close(false);
    };
    function close(focusBack) {
      if (menu !== mine) return;
      menu = null;
      box.remove();
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onAway);
      window.removeEventListener('hashchange', onAway);
      if (focusBack && previous && previous.isConnected && previous.focus) previous.focus();
    }
    const onAway = () => close(false);
    const mine = { close };
    menu = mine;
    box.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('hashchange', onAway);
    document.body.append(box);
    // At the pointer, kept inside the window.
    const w = box.offsetWidth || 200; const ht = box.offsetHeight || 96;
    box.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(y, window.innerHeight - ht - 8))}px`;
    items[0].focus();
  }

  // ---- Edit: the list (drag, or the arrows for the keyboard), rename, unpin, reset, and the phone bar's four
  /** The phone bar as it stands when the person has not chosen: the screen their menu opens on, their pins, then Home. */
  function standardBar() {
    const home = frame.plan && Array.isArray(frame.plan.home) ? frame.plan.home : BAR_HOME.map(([k]) => k);
    const homeItem = (k) => { const m = BAR_HOME.find(([key]) => key === k); return m && home.includes(k) ? { label: m[1], href: k, app: k } : null; };
    const out = [];
    const add = (it) => { if (it && out.length < BAR_MAX && !out.some((x) => x.href === it.href)) out.push(it); };
    const opens = me.menu && me.menu.start;
    if (opens) add(pinAt(opens) ? barItem(pinAt(opens)) : homeItem(opens));
    for (const p of state.pins) add(barItem(p));
    for (const [k] of BAR_HOME) add(homeItem(k));
    return out;
  }
  function openEditor({ bar: toBar = false } = {}) {
    if (!canEdit) return;
    closeMenu(false);
    if (editor) { editor.redraw(toBar ? 'bar' : null); return; }
    const body = h('div', { class: 'pins-edit' });
    const says = h('p', { class: 'sr', role: 'status', 'aria-live': 'polite' });
    let renaming = null; // the id of the pin whose name is being typed
    let asking = false; // "Reset?" is showing
    const say = (text) => { says.textContent = ''; says.textContent = text; };
    const dlg = dialog('Edit your pins', [body, says], { onClose: () => { editor = null; } });
    const iconBtn = (act, name, label, disabled, run) => h('button', { type: 'button', class: 'pins-icon-btn', 'data-act': act, 'aria-label': label, title: label, disabled, onclick: run }, glyph(name, 16));

    function rename(p, value) {
      const name = String(value || '').trim().slice(0, LABEL_MAX).trim();
      renaming = null;
      dlg.setDirty(false);
      if (!name || name === p.label) { redraw(`[data-id="${p.id}"] [data-act=rename]`); return; }
      change(state.pins.map((x) => (x.id === p.id ? { ...x, label: name } : x)), state.bar, `[data-id="${p.id}"] [data-act=rename]`);
      say(`Renamed to ${name}`);
    }
    function move(p, by) {
      const i = state.pins.findIndex((x) => x.id === p.id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= state.pins.length) return;
      change(moved(state.pins, i, j), state.bar, [`[data-id="${p.id}"] [data-act=${by < 0 ? 'up' : 'down'}]`, `[data-id="${p.id}"] [data-act=${by < 0 ? 'down' : 'up'}]`]);
      say(`${p.label} moved ${by < 0 ? 'up' : 'down'}: now ${j + 1} of ${state.pins.length}`);
    }
    /** Dragging by the handle: the row follows the pointer between the others; letting go keeps the new order. */
    function dragFrom(handle, li, list) {
      handle.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        li.classList.add('dragging');
        const onMove = (ev) => {
          const others = [...list.children].filter((x) => x !== li);
          const before = others.find((o) => { const r = o.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
          if (before) { if (li.nextElementSibling !== before) list.insertBefore(li, before); } else if (list.lastElementChild !== li) list.append(li);
        };
        const done = (keep) => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onCancel);
          li.classList.remove('dragging');
          const order = [...list.children].map((x) => x.dataset.id);
          const next = order.map((id) => state.pins.find((p) => p.id === id)).filter(Boolean);
          if (keep && next.length === state.pins.length && next.some((p, i) => p !== state.pins[i])) {
            const p = state.pins.find((x) => x.id === li.dataset.id);
            change(next, state.bar, [`[data-id="${li.dataset.id}"] [data-act=up]`, `[data-id="${li.dataset.id}"] [data-act=down]`]);
            if (p) say(`${p.label} moved: now ${next.indexOf(p) + 1} of ${next.length}`);
          } else redraw();
        };
        const onUp = () => done(true);
        const onCancel = () => done(false);
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancel);
      });
    }
    function pinRow(p, i, list) {
      const n = state.pins.length;
      const li = h('li', { class: 'pins-row', dataset: { id: p.id } });
      const handle = h('span', { class: 'pins-grip', 'aria-hidden': 'true', title: 'Drag to reorder' }, grip());
      dragFrom(handle, li, list);
      let middle;
      if (renaming === p.id) {
        const box = h('input', { type: 'text', class: 'pins-name-input', maxlength: String(LABEL_MAX), value: p.label, 'aria-label': `Name for ${p.label}`, autocomplete: 'off' });
        // Escape puts the name back without closing the dialog; a name being typed does not make the dialog ask to discard.
        box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); renaming = null; dlg.setDirty(false); redraw(`[data-id="${p.id}"] [data-act=rename]`); } });
        box.addEventListener('input', (e) => e.stopPropagation());
        const form = h('form', { class: 'pins-rename', novalidate: true }, box,
          h('button', { type: 'submit', class: 'btn small primary' }, 'Save name'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { renaming = null; redraw(`[data-id="${p.id}"] [data-act=rename]`); } }, 'Cancel'));
        form.addEventListener('submit', (e) => { e.preventDefault(); rename(p, box.value); });
        middle = form;
      } else {
        middle = [h('span', { class: 'pins-name' }, icon(p.icon || p.app, 18), h('span', null, p.label)),
          h('button', { type: 'button', class: 'btn small', 'data-act': 'rename', 'aria-label': `Rename ${p.label}`, onclick: () => { renaming = p.id; redraw('.pins-name-input'); } }, 'Rename')];
      }
      li.append(handle, ...[middle].flat(),
        h('span', { class: 'pins-move' },
          iconBtn('up', 'up', `Move ${p.label} up`, i === 0, () => move(p, -1)),
          iconBtn('down', 'down', `Move ${p.label} down`, i === n - 1, () => move(p, 1))),
        h('button', { type: 'button', class: 'btn small', 'data-act': 'unpin', 'aria-label': `Unpin ${p.label}`, onclick: () => {
          const after = state.pins[i + 1] || state.pins[i - 1];
          say(`${p.label} unpinned`);
          unpin(p.href, after ? `[data-id="${after.id}"] [data-act=unpin]` : '[data-act=reset]');
        } }, 'Unpin'));
      return li;
    }

    function barSection() {
      const own = Boolean(state.bar);
      const on = own ? state.bar : standardBar();
      const set = (next, focus) => change(state.pins, next, focus);
      const moveBar = (i, by) => { const j = i + by; if (j < 0 || j >= on.length) return; set(moved(on, i, j), [`[data-bar="${on[i].href}"] [data-act=${by < 0 ? 'bar-up' : 'bar-down'}]`, `[data-bar="${on[i].href}"] [data-act=${by < 0 ? 'bar-down' : 'bar-up'}]`]); say(`${on[i].label} moved ${by < 0 ? 'left' : 'right'} on the bar: now ${j + 1} of ${on.length}`); };
      const onList = h('ol', { class: 'pins-list pins-bar-on', 'aria-label': 'On your phone bar, left to right' }, on.map((b, i) => h('li', { class: 'pins-row', dataset: { bar: b.href } },
        h('span', { class: 'pins-name' }, icon(b.icon || b.app, 18), h('span', null, b.label)),
        h('span', { class: 'pins-move' },
          iconBtn('bar-up', 'up', `Move ${b.label} earlier on the bar`, i === 0, () => moveBar(i, -1)),
          iconBtn('bar-down', 'down', `Move ${b.label} later on the bar`, i === on.length - 1, () => moveBar(i, 1))),
        h('button', { type: 'button', class: 'btn small', 'data-act': 'bar-off', 'aria-label': `Take ${b.label} off the bar`, onclick: () => { say(`${b.label} taken off the bar`); set(on.filter((x) => x !== b), [`[data-bar="${b.href}"] [data-act=bar-on]`, '[data-act=bar-off]', '[data-act=bar-standard]']); } }, 'Take off'))));
      const rest = [...state.pins.map(barItem), ...BAR_HOME.map(([k, text]) => ({ label: text, href: k, app: k })).filter((b) => !frame.plan || !Array.isArray(frame.plan.home) || frame.plan.home.includes(b.href))]
        .filter((b, i, all) => !on.some((x) => x.href === b.href) && all.findIndex((x) => x.href === b.href) === i);
      const full = on.length >= BAR_MAX;
      const restList = rest.length ? h('ul', { class: 'pins-list pins-bar-rest', 'aria-label': 'Not on your phone bar' }, rest.map((b) => h('li', { class: 'pins-row', dataset: { bar: b.href } },
        h('span', { class: 'pins-name plain' }, icon(b.icon || b.app, 18), h('span', null, b.label)),
        h('button', { type: 'button', class: 'btn small', 'data-act': 'bar-on', 'aria-label': `Put ${b.label} on the bar`, disabled: full, onclick: () => { say(`${b.label} put on the bar`); set([...on, b], `[data-bar="${b.href}"] [data-act=bar-off]`); } }, 'Put on bar')))) : null;
      return h('section', { class: 'pins-section pins-bar', 'aria-labelledby': 'pins-bar-h' },
        h('h3', { id: 'pins-bar-h', tabindex: '-1' }, 'Phone bar'),
        h('p', { class: 'muted small' }, own
          ? `The buttons at the bottom of your phone, beside Menu: up to ${BAR_MAX} of your pins, or Today, My shifts and Calendar.`
          : `The buttons at the bottom of your phone, beside Menu. This is the standard bar: the screen your menu opens on, then your first pins. Change it to choose your own ${BAR_MAX}.`),
        on.length ? onList : h('p', { class: 'muted' }, 'Nothing is on your phone bar but Menu.'),
        restList ? h('p', { class: 'pins-sub' }, full ? `The bar is full (${BAR_MAX}). Take one off to put another on.` : 'Not on the bar') : null,
        restList,
        h('div', { class: 'pins-foot' }, h('button', { type: 'button', class: 'btn small', 'data-act': 'bar-standard', disabled: !own, onclick: () => { say('The standard bar is back'); set(null, ['[data-act=bar-off]', '[data-act=bar-on]']); } }, 'Use the standard bar')));
    }

    /** Where the keyboard is now, as a selector, so a redraw nobody asked for (the server's answer) leaves it there. */
    function focusNow() {
      const el = document.activeElement;
      const act = el && body.contains(el) ? el.getAttribute('data-act') : null;
      if (!act) return null;
      const row = el.closest('[data-id], [data-bar]');
      return `${row ? (row.dataset.id ? `[data-id="${row.dataset.id}"] ` : `[data-bar="${row.dataset.bar}"] `) : ''}[data-act=${act}]`;
    }
    function redraw(asked) {
      const focus = asked || focusNow();
      const list = h('ol', { class: 'pins-list', 'aria-label': 'Your pins, in order' });
      state.pins.forEach((p, i) => list.append(pinRow(p, i, list)));
      const resetRow = asking
        ? h('div', { class: 'pins-foot pins-ask', role: 'group', 'aria-label': 'Reset to your role\'s menu?' },
          h('p', null, 'Put back your role\'s menu? Your own pins, their names and your phone bar go.'),
          h('button', { type: 'button', class: 'btn small danger', 'data-act': 'reset-yes', onclick: () => { asking = false; say('Your role\'s menu is back'); reset(); } }, 'Reset'),
          h('button', { type: 'button', class: 'btn small', 'data-act': 'reset-no', onclick: () => { asking = false; redraw('[data-act=reset]'); } }, 'Keep mine'))
        : h('div', { class: 'pins-foot' },
          h('button', { type: 'button', class: 'btn small', 'data-act': 'reset', disabled: !state.custom, onclick: () => { asking = true; redraw('[data-act=reset-no]'); } }, 'Reset to my role\'s menu'),
          h('span', { class: 'muted small' }, state.custom ? 'Your own pins.' : 'These are your role\'s starting pins. Change anything to make them your own.'));
      clear(body).append(
        h('section', { class: 'pins-section', 'aria-labelledby': 'pins-list-h' },
          h('h3', { id: 'pins-list-h', class: 'sr' }, 'Pinned'),
          h('p', { class: 'muted small' }, `Pinned pages are at the top of your menu, on every device you sign in on. Up to ${PIN_MAX}. To pin a page, open it and press the star at the top, or right-click it in the menu.`),
          state.pins.length ? list : h('p', { class: 'pins-none' }, 'Nothing is pinned. Every app you can use is still in the menu, in its section.'),
          resetRow),
        barSection());
      // Focus goes where it was asked to (the first of the choices that can take it), so the keyboard never falls off the dialog.
      const usable = (sel) => [...body.querySelectorAll(sel)].find((el) => !el.disabled) || null;
      const target = focus === 'bar' ? body.querySelector('#pins-bar-h') : focus === 'reset' ? usable('[data-act=reset]') || dlg.box.querySelector('header button')
        : focus ? [focus].flat().map(usable).find(Boolean) || null : null;
      if (target) { target.focus(); if (focus === 'bar' && target.scrollIntoView) target.scrollIntoView({ block: 'start' }); } else if (focus) { const any = usable('button'); if (any) any.focus(); }
      if (renaming && target && target.select) target.select();
    }
    editor = { redraw, close: () => dlg.close() };
    redraw(toBar ? 'bar' : null);
    // The role's menu (for Reset), and the pins as the server has them now: another device may have changed them.
    get('/me/nav').then((out) => {
      if (!editor || busy || state !== kept) return;
      if (Array.isArray(out.standard)) standard = out.standard;
      const fresh = { pins: out.pins, bar: out.bar || null, custom: Boolean(out.custom) };
      if (!same(fresh, state) && !renaming) { state = fresh; kept = fresh; show(); }
    }).catch(() => { /* Edit still works with what the page has */ });
  }

  // ---- what the frame says
  const onPage = (e) => {
    const d = (e && e.detail) || {};
    page = { key: d.key || appOf(d.href), href: hrefOfHash(d.href || ''), label: d.label || '' };
    closeMenu(false);
    paintStar();
  };
  const onEdit = (e) => openEditor({ bar: Boolean(e && e.detail && e.detail.bar) });
  const onRow = (e) => { if (canEdit && e && e.detail) openRowMenu(e.detail); };
  window.addEventListener('nav:page', onPage);
  window.addEventListener('nav:edit-pins', onEdit);
  window.addEventListener('nav:row-menu', onRow);

  // ---- Jump to: pin or unpin the page you are on, and Edit
  if (canEdit && frame.addCommands) {
    frame.addCommands(() => {
      if (live !== self) return [];
      const at = pinHref(page.href);
      const on = Boolean(at && pinAt(at));
      const words = 'pin pins pinned unpin star favorite favourite bookmark menu shortcut';
      return [
        ...(at ? [{ id: 'pin-page', title: on ? 'Unpin this page' : 'Pin this page', hint: page.label || '', icon: 'star', words, run: () => (on ? unpin(at) : pin(page)) }] : []),
        { id: 'pins-edit', title: 'Edit my pins', hint: '', icon: 'star', words: `${words} reorder rename reset arrange`, run: () => openEditor() },
        { id: 'pins-bar', title: 'Edit my phone bar', hint: '', icon: 'menu', words: 'phone bar bottom buttons tabs mobile pins', run: () => openEditor({ bar: true }) },
      ];
    });
  }

  function stop() {
    window.removeEventListener('nav:page', onPage);
    window.removeEventListener('nav:edit-pins', onEdit);
    window.removeEventListener('nav:row-menu', onRow);
    closeMenu(false);
    if (editor) editor.close();
    if (star) star.remove();
    if (live === self) live = null;
  }
  const self = { state: () => state, pin, unpin, reset, openEditor, canEdit, stop };
  live = self;
  show();
  return self;
}
