// The pieces every Settings page is built from: cards with label-left, control-right rows, switches, and the save bar
// that stays in view while a page has changes that are not saved yet.
import { h, toast, fail } from '../ui.js';

let uid = 0;
const nextId = (stem) => `set-${stem}-${++uid}`;

/** A card: a title, and its rows. `actions` sit on the right of the title (an Add button). */
export function card(title, children, { actions, id, intro } = {}) {
  const hid = nextId('h');
  return h('section', { class: 'set-card', 'aria-labelledby': hid, 'data-card': id || null },
    h('div', { class: 'set-card-head' }, h('h2', { id: hid }, title), actions || null),
    intro ? h('p', { class: 'set-card-intro' }, intro) : null,
    h('div', { class: 'set-rows' }, children));
}

/** One row: the label and a line of help on the left, the control on the right. */
export function row(text, control, hint, { wide = false } = {}) {
  const target = control && control.matches && control.matches('input, select, textarea') ? control : control && control.querySelector ? control.querySelector('input, select, textarea') : null;
  if (target && !target.id) target.id = nextId('f');
  const lab = target ? h('label', { for: target.id, class: 'set-label' }, text) : h('span', { class: 'set-label' }, text);
  return h('div', { class: `set-row${wide ? ' wide' : ''}` },
    h('div', { class: 'set-row-text' }, lab, hint ? h('span', { class: 'set-hint' }, hint) : null),
    h('div', { class: 'set-row-control' }, control));
}

/** A row of words only (a link, a note) with something on the right. */
export function infoRow(text, detail, right) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-row-text' }, h('span', { class: 'set-label' }, text), detail ? h('span', { class: 'set-hint' }, detail) : null), right ? h('div', { class: 'set-row-control' }, right) : null);
}

/** An on/off switch: a real checkbox, read out as a switch. */
export function toggle(attrs = {}) {
  return h('input', { type: 'checkbox', role: 'switch', class: 'switch', ...attrs });
}

/** A number with its unit after it: [ 24 ] hours. */
export function amount(inp, unit) {
  inp.classList.add('set-num');
  return h('span', { class: 'set-amount' }, inp, unit ? h('span', { class: 'set-unit' }, unit) : null);
}

/** A public link with Copy link and Open page. */
export function linkRow(text, url) {
  const copy = h('button', { type: 'button', class: 'btn small' }, 'Copy link');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch (_) { toast('Copy did not work here. Select the link and copy it.', 'error'); }
  });
  return h('div', { class: 'set-row' },
    h('div', { class: 'set-row-text' }, h('span', { class: 'set-label' }, text), h('span', { class: 'set-hint set-url' }, url)),
    h('div', { class: 'set-row-control row' }, copy, h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener' }, 'Open page')));
}

// ---------------------------------------------------------------- unsaved changes
// The page that has changes not saved yet, so leaving it can ask first.
let pending = null;
export const hasUnsaved = () => Boolean(pending && pending.bar.isConnected && pending.count() > 0);
window.addEventListener('beforeunload', (e) => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });

/**
 * The save bar. count() says how many changes there are, message(n) says it in words, undo() puts them back,
 * save() keeps them (and throws to keep the bar up). Call refresh() after anything changes.
 */
export function saveBar({ count, message, undo, save }) {
  const say = h('span', { class: 'set-savebar-text', role: 'status' });
  const undoBtn = h('button', { type: 'button', class: 'btn set-undo' }, 'Undo changes');
  const saveBtn = h('button', { type: 'button', class: 'btn primary set-save' }, 'Save changes');
  const bar = h('div', { class: 'set-savebar', role: 'region', 'aria-label': 'Unsaved changes', hidden: true }, say, h('div', { class: 'row' }, undoBtn, saveBtn));
  const me = { count, bar, refresh };
  function refresh() {
    const n = count();
    bar.hidden = n === 0;
    say.textContent = n ? message(n) : '';
    if (n) pending = me; else if (pending === me) pending = null;
  }
  undoBtn.addEventListener('click', () => { undo(); refresh(); });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try { await save(); refresh(); toast('Saved'); } catch (err) { fail(err); } finally { saveBtn.disabled = false; }
  });
  return me;
}

/**
 * Watches form controls on a page: counts the ones changed since they were last saved, and gives a save bar.
 * save(changed) gets a test for "was this control changed" and does the saving.
 */
export function formTracker(save) {
  const items = [];
  const valueOf = (el) => (el.type === 'checkbox' ? el.checked : el.value);
  const changed = (el) => { const i = items.find((x) => x.el === el); return Boolean(i) && valueOf(el) !== i.initial; };
  const sb = saveBar({
    count: () => items.filter((i) => valueOf(i.el) !== i.initial).length,
    message: (n) => (n === 1 ? 'You changed 1 setting on this page.' : `You changed ${n} settings on this page.`),
    undo: () => {
      for (const i of items) {
        if (valueOf(i.el) === i.initial) continue;
        if (i.el.type === 'checkbox') i.el.checked = i.initial; else i.el.value = i.initial;
        i.el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    },
    save: async () => {
      await save(changed);
      for (const i of items) i.initial = valueOf(i.el);
    },
  });
  return {
    bar: sb.bar,
    changed,
    refresh: sb.refresh,
    /** Watch a control (returns it, so it can be written inline). */
    track(el) {
      items.push({ el, initial: valueOf(el) });
      el.addEventListener('input', sb.refresh);
      el.addEventListener('change', sb.refresh);
      return el;
    },
  };
}

/** An empty holder that a page fills; shows a short note when nothing ends up in it. */
export function nothingHere(text) { return h('p', { class: 'set-empty' }, text); }

