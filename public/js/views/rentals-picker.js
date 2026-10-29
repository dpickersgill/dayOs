// The one gear picker: Sell, the fitting card and anywhere else gear is chosen. Type, level and size chips with how many
// are free, a search box and a scan box. Gear loads from the server a page at a time (GET /rentals/fit/gear), so a big
// fleet never loses pieces off the end of a list. Also "What's left": free, out and in service by type and size.

import { get } from '../api.js';
import { h, clear, label, toast, button, table, empty } from '../ui.js';

const CATEGORIES = ['ski', 'snowboard', 'boot', 'helmet', 'pole', 'other'];
export const gearName = (i) => [i.brand, i.model, i.size].filter(Boolean).join(' ');
const PAGE = 60;

function chip(text, on, click, count, aria) {
  const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': aria || null }, text, count === undefined || count === null ? null : h('span', { class: 'n' }, String(count)));
  b.addEventListener('click', click);
  return b;
}

/**
 * opts.onPick(item): a tile was pressed or a tag scanned (the caller adds or removes it).
 * opts.isPicked(id): true draws the tile as chosen. opts.start: { category, size } to open on (a boot size from the card).
 * Returns { el, reload, show({ category, size }) }.
 */
export function gearPicker({ onPick, isPicked = () => false, start = {}, sizeFor = () => null } = {}) {
  let cat = start.category || '';
  let tier = '';
  let size = start.size || '';
  let offset = 0;
  let items = [];
  let total = 0;
  let timer = null;
  const typeBar = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Type of gear' });
  const tierBar = h('div', { class: 'rchips small', role: 'group', 'aria-label': 'Level' });
  const sizeBar = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Size' });
  const search = h('input', { type: 'search', placeholder: 'Search brand, model or tag', 'aria-label': 'Search gear', autocomplete: 'off' });
  const scan = h('input', { type: 'text', placeholder: 'Scan a gear tag, then Enter', 'aria-label': 'Scan a gear tag', autocomplete: 'off' });
  const list = h('div', { class: 'gear-grid', 'aria-live': 'polite' });
  const more = h('div', { class: 'row' });
  const leftBox = h('div', { class: 'fit-left-mini', hidden: true });
  const leftBtn = button("What's left", () => { leftBox.hidden = !leftBox.hidden; leftBtn.setAttribute('aria-expanded', String(!leftBox.hidden)); }, { small: true });
  leftBtn.setAttribute('aria-expanded', 'false');

  async function load(append = false) {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(append ? offset : 0) });
    if (cat) qs.set('category', cat);
    if (tier) qs.set('tier', tier);
    if (cat && size) qs.set('size', size);
    if (search.value.trim()) qs.set('q', search.value.trim());
    const r = await get(`/rentals/fit/gear?${qs}`);
    // a size from the card that this type does not come in: show every size instead
    if (cat && size && !r.sizes.some((x) => x.size === size)) { size = ''; return load(append); }
    items = append ? items.concat(r.data) : r.data;
    offset = (append ? offset : 0) + r.data.length;
    total = r.total;
    drawChips(r);
    drawTiles();
  }
  function drawChips(r) {
    const free = (c) => (r.types.find((t) => t.category === c) || { free: 0 }).free;
    const allFree = r.types.reduce((a, t) => a + t.free, 0);
    clear(typeBar).append(chip('All', !cat, () => { cat = ''; size = ''; tier = ''; load(); }, allFree, `All types, ${allFree} free`),
      ...CATEGORIES.filter((c) => r.types.some((t) => t.category === c)).map((c) => chip(label(c), cat === c, () => { cat = c; size = sizeFor(c) || ''; tier = ''; load(); }, free(c), `${label(c)}, ${free(c)} free`)));
    clear(tierBar);
    if (r.tiers.length > 1) tierBar.append(chip('Any level', !tier, () => { tier = ''; load(); }), chip('Standard', tier === 'standard', () => { tier = 'standard'; load(); }), chip('Performance', tier === 'performance', () => { tier = 'performance'; load(); }));
    clear(sizeBar);
    if (cat && r.sizes.length > 1) {
      sizeBar.append(chip('Any size', !size, () => { size = ''; load(); }),
        ...r.sizes.filter((s) => s.size).map((s) => chip(s.size, size === s.size, () => { size = s.size; load(); }, s.free, `Size ${s.size}, ${s.free} free`)));
    }
    clear(leftBox).append(cat && r.sizes.length
      ? table([{ head: 'Size', cell: (s) => s.size || 'No size' }, { head: 'Free', num: true, cell: (s) => String(s.free) }, { head: 'Out', num: true, cell: (s) => String(s.out_now) }, { head: 'In service', num: true, cell: (s) => String(s.service) }], r.sizes)
      : h('p', { class: 'muted small' }, 'Pick a type to see what is left in each size.'));
  }
  function drawTiles() {
    clear(list);
    clear(more);
    if (!items.length) { list.append(h('p', { class: 'muted fit-none' }, size ? `None free in size ${size}. Tap Any size, or another size.` : total === 0 && !search.value ? 'No gear of this kind is free right now.' : 'Nothing free matches. Try another size or type.')); return; }
    for (const i of items) {
      const on = isPicked(i.id);
      const tile = h('button', { type: 'button', class: `gear-tile${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': `${i.sku}, ${label(i.category)} ${gearName(i)}${i.tier === 'performance' ? ', performance' : ''}` },
        h('span', { class: 'size' }, i.size || '-'),
        h('span', { class: 'what' }, label(i.category), [i.brand, i.model].filter(Boolean).length ? h('small', { class: 'muted' }, ` ${[i.brand, i.model].filter(Boolean).join(' ')}`) : null),
        h('span', { class: 'meta' }, i.sku, i.tier === 'performance' ? h('span', { class: 'tag' }, 'Perf') : null, i.grade ? h('span', { class: 'grade' }, i.grade) : null),
        on ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null);
      tile.addEventListener('click', () => { onPick(i); drawTiles(); });
      list.append(tile);
    }
    if (items.length < total) more.append(h('span', { class: 'muted small' }, `Showing ${items.length} of ${total}`), button('Show more', () => load(true), { small: true }));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load(), 250); });
  scan.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    scan.value = '';
    if (!code) return;
    try {
      const r = await get(`/rentals/lookup?code=${encodeURIComponent(code)}`);
      if (r.item.status !== 'available' && !isPicked(r.item.id)) throw new Error(`${r.item.sku} is ${label(r.item.status).toLowerCase()}${r.contract_id ? ` on contract #${r.contract_id}` : ''}`);
      onPick(r.item);
      drawTiles();
      toast(`${r.item.sku} ${isPicked(r.item.id) ? 'added' : 'removed'}`);
    } catch (err) { toast(err.message, 'error'); }
  });
  const el = h('div', { class: 'fit-picker stack' },
    h('div', { class: 'rent-find' }, search, scan),
    typeBar, tierBar, sizeBar,
    h('div', { class: 'row' }, leftBtn), leftBox,
    list, more);
  load().catch((err) => { clear(list).append(h('p', { class: 'error-box', role: 'alert' }, err.message)); });
  return { el, reload: () => load(), redraw: drawTiles, show: (o) => { cat = o.category ?? cat; size = o.size ?? ''; tier = ''; return load(); } };
}

/** What's left: for each type, free now, out and in service, with the sizes underneath. */
export async function leftPanel(box) {
  const { data } = await get('/rentals/fit/left');
  clear(box);
  if (!data.length) { box.append(empty('No gear in the inventory yet.')); return; }
  box.append(...data.map((t) => h('details', { class: 'fit-left' },
    h('summary', null, h('strong', null, label(t.category)), h('span', { class: 'muted small' }, ` ${t.free} free · ${t.out_now} out · ${t.service} in service`)),
    h('div', { class: 'fit-left-sizes' }, t.sizes.map((s) => h('span', { class: `fit-size${s.free ? '' : ' none'}`, title: `${s.out_now} out, ${s.service} in service` }, h('strong', null, s.size || 'No size'), ` ${s.free}`))))));
}
