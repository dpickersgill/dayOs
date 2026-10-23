// Assets and fleet (paid add-on): the register for the fleet, lifts, snowmaking and buildings, and everything around it.
//   Overview    what needs attention today: service due, papers running out, low stock, what to think about replacing
//   Assets      the register: search, filter by category, add, print QR labels
//   Service     every service plan by date, hours or miles
//   Parts       the parts catalog and stock on hand
//   Purchasing  purchase orders: draft, order, receive into stock
//   Costs       what each asset costs to keep, its book value and cost per hour or mile (managers)
//   Settings    places, vendors, checklists and the shop labor rate (managers)
// One asset opens on its own page (asset-page.js), which is also where a scanned QR tag lands.

import { get, post, patch, put, download } from '../api.js';
import { drawMap } from './asset-map.js';
import { h, clear, state, button, toast, formDialog, dialog, confirmDialog, field, input, select, val, num, money, toCents, centsToInput, fmtDate, label, empty, table, tabs, isManager, errorBox } from '../ui.js';
import { renderAsset, renderLabels, assetDialog, fullMeta, STATUS, SERVICE, workOrderSheet, fmtDay, leftText } from './asset-page.js';

const PAPER = { expired: 'bad', soon: 'warn' };
const PO_STATE = { draft: ['Draft', 'neutral'], ordered: ['Ordered', 'warn'], partial: ['Part received', 'warn'], received: ['Received', 'good'], cancelled: ['Cancelled', 'neutral'] };
const n1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

export async function render(root, params = []) {
  if (params[0] === 'a' && /^\d+$/.test(params[1] || '')) { await renderAsset(root, Number(params[1])); return; }
  if (params[0] === 'tag' && params[1]) {
    try { const { id } = await get(`/assets/tag/${encodeURIComponent(decodeURIComponent(params[1]))}`); history.replaceState(null, '', `#/assets/a/${id}`); await renderAsset(root, id); } catch (err) { root.append(h('p', { class: 'back' }, h('a', { href: '#/assets' }, '‹ Assets')), errorBox(err)); }
    return;
  }
  if (params[0] === 'labels') { await renderLabels(root, params[1] || 'all'); return; }
  const items = [
    ['overview', 'Overview', drawOverview], ['register', 'Assets', drawRegister], ['service', 'Service', drawService],
    ['map', 'Map', (b) => drawMap(b, params[0] === 'map' ? params[1] : '')], ['parts', 'Parts', drawParts], ['purchasing', 'Purchasing', drawPurchasing],
    ...(isManager() ? [['costs', 'Costs', drawCosts], ['settings', 'Settings', drawSettings]] : []),
  ];
  const want = items.some((i) => i[0] === params[0]) ? params[0] : 'overview';
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Assets and fleet'), h('p', { class: 'page-note' }, 'Every machine, lift part and building system: what it is, where it is, what it needs and what it costs.'))),
    tabs(items.map(([k, t, fn]) => [k, t, (box) => { try { history.replaceState(null, '', `#/assets/${k}`); } catch (_) { /* tab still opens */ } return fn(box); }]), want));
}

const assetLink = (id, text) => h('a', { href: `#/assets/a/${id}` }, text);

// ---------------------------------------------------------------- overview
async function drawOverview(box) {
  const o = await get('/assets/overview');
  const stat = (n, text, tone, href) => h(href ? 'a' : 'div', { class: `stat ${tone || ''}`.trim(), href }, h('b', null, String(n)), h('span', null, text));
  const list = (title, rows, none) => h('section', { class: 'panel stack' }, h('h2', null, title), rows.length ? h('ul', { class: 'plain rows' }, rows) : h('p', { class: 'muted' }, none));
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'stats' },
      stat(o.counts.assets, 'assets on the register', '', '#/assets/register'),
      stat(o.counts.out_of_service, 'out of service', o.counts.out_of_service ? 'bad' : ''),
      stat(o.counts.needs_service, 'need service', o.counts.needs_service ? 'warn' : ''),
      stat(o.counts.open_orders, `open work orders${o.counts.urgent_orders ? `, ${o.counts.urgent_orders} urgent` : ''}`, o.counts.urgent_orders ? 'bad' : ''),
      stat(o.low_stock.length, 'parts at or below reorder', o.low_stock.length ? 'warn' : '', '#/assets/parts'),
      o.spend_month_cents !== null ? stat(money(o.spend_month_cents), 'spent this month (labor, parts, outside, fuel)') : null),
    o.by_category.length ? h('div', { class: 'cat-row' }, o.by_category.map((c) => h('span', { class: 'cat-chip' }, h('b', null, c.total), ` ${c.label}`, c.down ? h('span', { class: 'down' }, ` · ${c.down} down`) : null))) : null,
    h('div', { class: 'pair' },
      list('Service due', o.service_due.map((s) => h('li', null, state(SERVICE[s.state][0], SERVICE[s.state][1]), ' ', s.asset_id ? assetLink(s.asset_id, `${s.asset} (${s.asset_tag})`) : h('span', null, s.lift || ''), h('span', null, `: ${s.name}`), h('span', { class: 'muted small' }, ` ${[s.due_on && `due ${fmtDay(s.due_on)}`, leftText(s.hours_left, 'h'), leftText(s.miles_left, 'mi')].filter(Boolean).join(', ')}`))), 'Nothing due in the next week.'),
      list('Papers running out', o.papers_due.map((p) => h('li', null, state(`${p.label} ${p.state === 'expired' ? 'expired' : 'due'} ${fmtDay(p.on)}`, PAPER[p.state]), ' ', assetLink(p.asset_id, `${p.asset} (${p.tag})`))), 'Registrations, insurance and inspections are all current.')),
    h('div', { class: 'pair' },
      list('Low stock', o.low_stock.map((p) => h('li', null, h('b', null, `${p.qty_on_hand} ${p.unit}`), ` ${p.sku} ${p.name}`, h('span', { class: 'muted small' }, ` (reorder at ${p.reorder_point})`))), 'Every part is above its reorder point.'),
      isManager() ? list('Worth considering a replacement', o.replace.map((r) => h('li', null, assetLink(r.id, `${r.name} (${r.tag})`), h('span', { class: 'muted small' }, ` ${r.reasons.join('. ')}.`))), 'Nothing is past its life or costing more than it is worth.') : null),
    isManager() && o.top_cost.length ? list('Most upkeep, last 12 months', o.top_cost.map((r) => h('li', { class: 'spread' }, assetLink(r.id, `${r.name} (${r.tag})`), h('b', null, money(r.maintenance_12)))), '') : null));
}

// ---------------------------------------------------------------- register
async function drawRegister(box) {
  const meta = await fullMeta();
  const q = input({ type: 'search', placeholder: 'Search name, tag, model, serial, VIN or plate', 'aria-label': 'Search assets' });
  const cat = select([['', 'Every category'], ...meta.categories.map((c) => [c.value, c.label])], '', { 'aria-label': 'Category' });
  const st = select([['', 'In use'], ['needs_service', 'Needs service'], ['out_of_service', 'Out of service'], ['retired', 'Retired']], '', { 'aria-label': 'Status' });
  const loc = select([['', 'Every place'], ...meta.locations.map((l) => [l.id, l.name])], '', { 'aria-label': 'Location' });
  const body = h('div');
  let shown = [];
  const labelsBtn = button('Print QR labels', () => { location.hash = `#/assets/labels/${shown.map((a) => a.id).join(',') || 'all'}`; }, { small: true });
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('div', { class: 'row filters' }, q, cat, st, loc), h('div', { class: 'row' }, labelsBtn, button('Add an asset', () => assetDialog(meta, null, async (out) => { location.hash = `#/assets/a/${out.id}`; }), { kind: 'primary', small: true }))),
    body));
  async function load() {
    const qs = new URLSearchParams();
    if (q.value.trim()) qs.set('q', q.value.trim());
    if (cat.value) qs.set('category', cat.value);
    if (st.value) qs.set('status', st.value);
    if (loc.value) qs.set('location_id', loc.value);
    const { data } = await get(`/assets/register?${qs}`);
    shown = data;
    clear(body);
    if (!data.length) { body.append(empty(q.value || cat.value || st.value || loc.value ? 'No assets match.' : 'No assets yet. Add the fleet, lift drives, snowmaking pumps and building systems you look after.')); return; }
    const worstPaper = (a) => a.papers.find((p) => p.state === 'expired') || a.papers.find((p) => p.state === 'soon');
    body.append(table([
      { head: 'Tag', cell: (a) => h('span', { class: 'tag-cell' }, a.asset_tag) },
      { head: 'Asset', cell: (a) => h('span', { class: 'stack tight' }, assetLink(a.id, h('strong', null, a.name)), h('span', { class: 'muted small' }, [(meta.kinds.find((k) => k.value === a.kind) || {}).label, a.location, a.parent && `part of ${a.parent}`].filter(Boolean).join(' · '))) },
      { head: 'Meters', cell: (a) => [a.hours ? `${n1(a.hours).toLocaleString()} h` : null, a.miles !== null ? `${n1(a.miles).toLocaleString()} mi` : null].filter(Boolean).join(' · ') },
      { head: 'Status', cell: (a) => state(STATUS[a.status][0], STATUS[a.status][1]) },
      { head: 'Service', cell: (a) => (a.service ? state(SERVICE[a.service.state][0], SERVICE[a.service.state][1]) : h('span', { class: 'muted small' }, 'No plan')) },
      { head: 'Papers', cell: (a) => { const p = worstPaper(a); return p ? state(`${p.label} ${p.state === 'expired' ? 'expired' : 'due'}`, PAPER[p.state]) : ''; } },
      { head: 'Open work', cell: (a) => (a.open_orders ? String(a.open_orders) : '') },
    ], data, { rowClass: (a) => `asset-row status-${a.status}` }));
  }
  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  for (const s of [cat, st, loc]) s.addEventListener('change', load);
  await load();
}

// ---------------------------------------------------------------- service plans
async function drawService(box) {
  const [{ data }, meta] = await Promise.all([get('/ops/pm'), fullMeta()]);
  const assetName = (p) => (p.asset_id ? assetLink(p.asset_id, p.asset) : p.lift || 'Not tied to an asset');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Plans come due by date, by hours, by miles, or whichever comes first. A plan makes a work order; completing that work order marks the plan done at the meters recorded on it.'), button('Add a plan', () => planDialog(meta, () => drawService(box)), { kind: 'primary', small: true })),
    data.length ? table([
      { head: 'When', cell: (p) => state(SERVICE[p.state][0], SERVICE[p.state][1]) },
      { head: 'Plan', cell: (p) => h('span', { class: 'stack tight' }, h('strong', null, p.name), h('span', { class: 'muted small' }, `Every ${[p.interval_days && `${p.interval_days} days`, p.interval_hours && `${n1(p.interval_hours)} h`, p.interval_miles && `${n1(p.interval_miles)} mi`].filter(Boolean).join(' or ')}`)) },
      { head: 'Asset', cell: assetName },
      { head: 'Due', cell: (p) => [p.due_on && fmtDay(p.due_on), leftText(p.hours_left, 'h'), leftText(p.miles_left, 'mi')].filter(Boolean).join(', ') },
      { head: 'Last done', cell: (p) => (p.last_done_on ? fmtDay(p.last_done_on) : 'Never') },
      { head: '', actions: true, cell: (p) => button('Create work order', async () => { const r = await post(`/ops/pm/${p.id}/work-order`, {}); toast('Work order ready'); if (p.asset_id) location.hash = `#/assets/a/${p.asset_id}`; else await workOrderSheet(r.id, null, () => drawService(box)); }, { small: true }) },
    ], data) : empty('No service plans yet.')));
}

function planDialog(meta, done) {
  formDialog('New service plan', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('What gets done', input({ name: 'name', required: true, maxlength: 150, placeholder: 'Annual brake inspection' }))),
    field('Asset', select([['', 'Choose'], ...meta.assets.map((a) => [a.id, `${a.name} (${a.asset_tag})`])], '', { name: 'asset_id' })),
    field('Every so many days', input({ name: 'interval_days', type: 'number', min: 1 })), field('Every so many hours', input({ name: 'interval_hours', type: 'number', min: 1 })), field('Every so many miles', input({ name: 'interval_miles', type: 'number', min: 1 })),
    h('div', { class: 'wide' }, field('Checklist (one step per line)', h('textarea', { name: 'checklist', rows: 4, maxlength: 2000 })))),
  async (fd) => {
    if (!num(fd, 'asset_id')) throw new Error('Choose the asset');
    await post('/ops/pm', { name: val(fd, 'name'), asset_id: num(fd, 'asset_id'), interval_days: num(fd, 'interval_days'), interval_hours: num(fd, 'interval_hours'), interval_miles: num(fd, 'interval_miles'), checklist: val(fd, 'checklist') });
    toast('Plan added');
    await done();
  }, { submitText: 'Add plan' });
}

// ---------------------------------------------------------------- parts
async function drawParts(box) {
  const [vendors, locs] = await Promise.all([get('/assets/vendors'), get('/assets/locations')]);
  const q = input({ type: 'search', placeholder: 'Search part number, name or what it fits', 'aria-label': 'Search parts' });
  const lowOnly = h('input', { type: 'checkbox' });
  const body = h('div');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('div', { class: 'row filters' }, q, h('label', { class: 'check' }, lowOnly, ' At or below reorder only')), button('Add a part', () => partDialog(null, vendors.data, locs.data, load), { kind: 'primary', small: true })),
    body));
  async function load() {
    const { data } = await get(`/assets/parts?${new URLSearchParams({ ...(q.value.trim() ? { q: q.value.trim() } : {}), ...(lowOnly.checked ? { low: '1' } : {}) })}`);
    clear(body);
    if (!data.length) { body.append(empty(q.value || lowOnly.checked ? 'No parts match.' : 'No parts yet. Add the filters, belts, pads and fluids you keep on the shelf.')); return; }
    body.append(table([
      { head: 'Part', cell: (p) => h('span', { class: 'stack tight' }, h('strong', null, `${p.sku} ${p.name}`), p.fits ? h('span', { class: 'muted small' }, `Fits: ${p.fits}`) : null) },
      { head: 'On hand', num: true, cell: (p) => h('span', null, `${p.qty_on_hand} ${p.unit} `, p.low ? state('Reorder', 'warn') : null) },
      { head: 'Reorder at', num: true, cell: (p) => (p.reorder_point !== null ? String(p.reorder_point) : '') },
      { head: 'Where', cell: (p) => [p.location, p.bin && `bin ${p.bin}`].filter(Boolean).join(', ') },
      { head: 'Vendor', cell: (p) => p.vendor || '' },
      { head: 'Cost', num: true, cell: (p) => money(p.unit_cost_cents) },
      { head: '', actions: true, cell: (p) => button('Open', () => partSheet(p.id, vendors.data, locs.data, load), { small: true, label: `Open ${p.name}` }) },
    ], data));
  }
  let t = null;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  lowOnly.addEventListener('change', load);
  await load();
}

function partDialog(p, vendors, locs, done) {
  const cur = p || {};
  formDialog(p ? `Edit ${p.sku}` : 'Add a part', h('div', { class: 'form' },
    field('Part number', input({ name: 'sku', required: true, maxlength: 60, value: cur.sku || '' })), field('Name', input({ name: 'name', required: true, maxlength: 150, value: cur.name || '' })),
    field('Unit', input({ name: 'unit', maxlength: 20, value: cur.unit || 'each' })), isManager() ? field('Cost per unit ($)', input({ name: 'cost', inputmode: 'decimal', value: centsToInput(cur.unit_cost_cents) })) : null,
    p ? null : field('On hand now', input({ name: 'qty_on_hand', type: 'number', min: 0, step: 'any' })),
    field('Reorder when at or below', input({ name: 'reorder_point', type: 'number', min: 0, step: 'any', value: cur.reorder_point ?? '' })), field('Reorder how many', input({ name: 'reorder_qty', type: 'number', min: 0, step: 'any', value: cur.reorder_qty ?? '' })),
    field('Vendor', select([['', 'Not set'], ...vendors.map((v) => [v.id, v.name])], cur.vendor_id || '', { name: 'vendor_id' })), field("Vendor's part number", input({ name: 'vendor_part_no', maxlength: 60, value: cur.vendor_part_no || '' })),
    field('Kept at', select([['', 'Not set'], ...locs.map((l) => [l.id, l.name])], cur.location_id || '', { name: 'location_id' })), field('Bin', input({ name: 'bin', maxlength: 40, value: cur.bin || '' })),
    h('div', { class: 'wide' }, field('Fits', input({ name: 'fits', maxlength: 255, value: cur.fits || '', placeholder: 'PistenBully 600, plow trucks' })))),
  async (fd) => {
    const b = { sku: val(fd, 'sku'), name: val(fd, 'name'), unit: val(fd, 'unit') || 'each', reorder_point: num(fd, 'reorder_point'), reorder_qty: num(fd, 'reorder_qty'), vendor_id: num(fd, 'vendor_id'), vendor_part_no: val(fd, 'vendor_part_no'), location_id: num(fd, 'location_id'), bin: val(fd, 'bin'), fits: val(fd, 'fits') };
    if (isManager() && val(fd, 'cost') !== null) { const c = toCents(val(fd, 'cost')); if (c === null) throw new Error('Cost must be an amount like 12.50'); b.unit_cost_cents = c; }
    if (!p && num(fd, 'qty_on_hand') !== null) b.qty_on_hand = num(fd, 'qty_on_hand');
    if (p) await patch(`/assets/parts/${p.id}`, b); else { for (const k of Object.keys(b)) if (b[k] === null) delete b[k]; await post('/assets/parts', b); }
    toast(p ? 'Saved' : 'Part added');
    await done();
  }, { wide: true, submitText: p ? 'Save' : 'Add part' });
}

async function partSheet(id, vendors, locs, done) {
  const p = await get(`/assets/parts/${id}`);
  const moveText = { receive: 'Received', issue: 'Used', return: 'Returned', adjust: 'Adjusted', count: 'Counted' };
  const dlg = dialog(`${p.sku} ${p.name}`, h('div', { class: 'stack' },
    h('p', null, h('b', null, `${p.qty_on_hand} ${p.unit} on hand`), p.low ? [' ', state('At or below reorder', 'warn')] : null, h('span', { class: 'muted small' }, ` ${[p.location, p.bin && `bin ${p.bin}`, p.vendor].filter(Boolean).join(' · ')}`)),
    h('div', { class: 'row' },
      button('Count stock', () => { dlg.close(); stockDialog(p, 'count', done); }, { small: true }),
      button('Adjust', () => { dlg.close(); stockDialog(p, 'change', done); }, { small: true }),
      button('Edit', () => { dlg.close(); partDialog(p, vendors, locs, done); }, { small: true })),
    h('h3', null, 'History'),
    p.moves.length ? h('ul', { class: 'plain rows' }, p.moves.map((m) => h('li', null, h('b', null, `${moveText[m.kind]} ${Math.abs(m.qty)} ${p.unit}`), h('span', { class: 'muted small' }, ` ${fmtDate(m.at)}${m.asset ? `, ${m.asset} (${m.asset_tag})` : ''}${m.work_order ? `, ${m.work_order}` : ''}${m.note ? `, ${m.note}` : ''}`)))) : h('p', { class: 'muted' }, 'No movements yet.')), { wide: true });
}

function stockDialog(p, mode, done) {
  formDialog(mode === 'count' ? `Count ${p.sku}` : `Adjust ${p.sku}`, h('div', { class: 'form' },
    field(mode === 'count' ? `How many are on the shelf (${p.unit})` : 'Add (positive) or take away (negative)', input({ name: 'n', type: 'number', step: 'any', required: true })),
    h('div', { class: 'wide' }, field('Reason', input({ name: 'note', required: true, minlength: 3, maxlength: 255, placeholder: mode === 'count' ? 'Monthly shelf count' : 'Damaged in storage' })))),
  async (fd) => {
    await post(`/assets/parts/${p.id}/stock`, { [mode]: num(fd, 'n'), note: val(fd, 'note') });
    toast('Stock updated');
    await done();
  }, { submitText: 'Save' });
}

// ---------------------------------------------------------------- purchasing
async function drawPurchasing(box) {
  const [vendors, parts] = await Promise.all([get('/assets/vendors'), get('/assets/parts')]);
  const show = select([['open', 'Open'], ['all', 'All']], 'open', { 'aria-label': 'Show' });
  const body = h('div');
  const tools = isManager() ? h('div', { class: 'row' },
    button('Reorder low stock', () => reorderDialog(vendors.data, load), { small: true }),
    button('New purchase order', () => poDialog(null, vendors.data, parts.data, load), { kind: 'primary', small: true })) : null;
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'spread' }, show, tools), body));
  async function load() {
    const { data } = await get(`/assets/purchase-orders?status=${show.value}`);
    clear(body);
    if (!data.length) { body.append(empty(isManager() ? 'No purchase orders. Start one, or reorder everything at or below its reorder point.' : 'No purchase orders waiting to arrive.')); return; }
    body.append(table([
      { head: 'PO', cell: (o) => h('strong', null, `PO ${o.po_number}`) },
      { head: 'Vendor', cell: (o) => o.vendor },
      { head: 'Status', cell: (o) => state(PO_STATE[o.status][0], PO_STATE[o.status][1]) },
      { head: 'Total', num: true, cell: (o) => money(o.total_cents) },
      { head: 'Expected', cell: (o) => (o.expected_on ? fmtDate(o.expected_on) : '') },
      { head: '', actions: true, cell: (o) => button('Open', () => poSheet(o.id, vendors.data, parts.data, load), { small: true, label: `Open purchase order ${o.po_number}` }) },
    ], data));
  }
  show.addEventListener('change', load);
  await load();
}

function reorderDialog(vendors, done) {
  if (!vendors.length) { toast('Add a vendor under Settings first', 'error'); return; }
  formDialog('Reorder low stock', h('div', { class: 'form' }, field('Vendor', select(vendors.map((v) => [v.id, v.name]), vendors[0].id, { name: 'vendor_id' }), 'Makes a draft with every part from this vendor at or below its reorder point')), async (fd) => {
    const r = await post('/assets/purchase-orders/reorder', { vendor_id: num(fd, 'vendor_id') });
    toast(`Draft PO ${r.po_number} with ${r.lines} line${r.lines === 1 ? '' : 's'}`);
    await done();
  }, { submitText: 'Make the draft' });
}

function poDialog(po, vendors, parts, done) {
  if (!vendors.length) { toast('Add a vendor under Settings first', 'error'); return; }
  const linesBox = h('div', { class: 'stack tight po-lines' });
  const addLine = (l = {}) => {
    const part = select([['', 'Not a stocked part'], ...parts.map((p) => [p.id, `${p.sku} ${p.name}`])], l.part_id || '', { 'aria-label': 'Part', class: 'l-part' });
    const desc = input({ maxlength: 200, placeholder: 'Description', value: l.part_id ? '' : (l.description || ''), 'aria-label': 'Description', class: 'l-desc' });
    const qty = input({ type: 'number', min: 0, step: 'any', value: l.qty ?? 1, 'aria-label': 'Quantity', class: 'l-qty short-num' });
    const cost = input({ inputmode: 'decimal', value: centsToInput(l.unit_cost_cents ?? (parts.find((p) => p.id === l.part_id) || {}).unit_cost_cents), 'aria-label': 'Cost each', placeholder: 'Cost each', class: 'l-cost short-num' });
    part.addEventListener('change', () => { const p = parts.find((x) => String(x.id) === part.value); desc.hidden = Boolean(p); if (p && !cost.value) cost.value = centsToInput(p.unit_cost_cents); });
    desc.hidden = Boolean(l.part_id);
    const rm = h('button', { type: 'button', class: 'btn small quiet' }, 'Remove');
    const row = h('div', { class: 'po-line' }, part, desc, qty, cost, rm);
    rm.addEventListener('click', () => row.remove());
    linesBox.append(row);
  };
  (po ? po.lines : [{}]).forEach(addLine);
  formDialog(po ? `PO ${po.po_number}` : 'New purchase order', h('div', { class: 'stack' },
    h('div', { class: 'form' }, field('Vendor', select(vendors.map((v) => [v.id, v.name]), po ? po.vendor_id : vendors[0].id, { name: 'vendor_id' })), field('Expected', input({ name: 'expected_on', type: 'date', value: po && po.expected_on ? String(po.expected_on).slice(0, 10) : '' })),
      h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500, value: (po && po.notes) || '' })))),
    h('h3', null, 'Lines'), linesBox, h('div', { class: 'row' }, button('Add a line', () => addLine(), { small: true }))),
  async (fd) => {
    const lines = [...linesBox.querySelectorAll('.po-line')].map((r) => {
      const c = r.querySelector('.l-cost').value.trim();
      const cents = c === '' ? 0 : toCents(c);
      if (cents === null) throw new Error('Each cost must be an amount like 12.50');
      const pid = r.querySelector('.l-part').value;
      return { part_id: pid ? Number(pid) : null, description: r.querySelector('.l-desc').value.trim() || null, qty: Number(r.querySelector('.l-qty').value), unit_cost_cents: cents };
    });
    if (!lines.length) throw new Error('Add at least one line');
    const body = { vendor_id: num(fd, 'vendor_id'), expected_on: val(fd, 'expected_on'), notes: val(fd, 'notes'), lines };
    if (po) await put(`/assets/purchase-orders/${po.id}`, body); else await post('/assets/purchase-orders', body);
    toast(po ? 'Saved' : 'Draft saved');
    await done();
  }, { wide: true, submitText: po ? 'Save' : 'Save draft' });
}

async function poSheet(id, vendors, parts, done) {
  const o = await get(`/assets/purchase-orders/${id}`);
  const open = ['ordered', 'partial'].includes(o.status);
  const qtys = new Map();
  const dlg = dialog(`PO ${o.po_number}: ${o.vendor}`, h('div', { class: 'stack' },
    h('p', null, state(PO_STATE[o.status][0], PO_STATE[o.status][1]), h('span', { class: 'muted small' }, ` ${[o.ordered_at && `ordered ${fmtDate(o.ordered_at)}`, o.expected_on && `expected ${fmtDate(o.expected_on)}`, o.notes].filter(Boolean).join(' · ')}`)),
    table([
      { head: 'Item', cell: (l) => l.description },
      { head: 'Ordered', num: true, cell: (l) => `${l.qty}${l.unit ? ` ${l.unit}` : ''}` },
      { head: 'Received', num: true, cell: (l) => String(l.received_qty) },
      { head: 'Each', num: true, cell: (l) => money(l.unit_cost_cents) },
      ...(open ? [{ head: 'Receiving now', cell: (l) => { const left = l.qty - l.received_qty; if (left <= 0) return 'Done'; const inp = input({ type: 'number', min: 0, max: left, step: 'any', value: left, 'aria-label': `Receiving now: ${l.description}`, class: 'short-num' }); qtys.set(l.id, inp); return inp; } }] : []),
    ], o.lines),
    h('p', null, h('b', null, 'Total: '), money(o.total_cents)),
    h('div', { class: 'row' },
      o.status === 'draft' && isManager() ? button('Edit', () => { dlg.close(); poDialog(o, vendors, parts, done); }, { small: true }) : null,
      o.status === 'draft' && isManager() ? button('Mark as ordered', async () => { await post(`/assets/purchase-orders/${o.id}/order`, {}); toast('Marked as ordered'); dlg.close(); await done(); }, { kind: 'primary', small: true }) : null,
      open ? button('Receive', async () => {
        const lines = [...qtys].map(([lineId, inp]) => ({ line_id: lineId, qty: Number(inp.value) })).filter((l) => l.qty > 0);
        if (!lines.length) throw new Error('Enter what arrived');
        const r = await post(`/assets/purchase-orders/${o.id}/receive`, { lines });
        toast(r.status === 'received' ? 'All received. Stock updated.' : 'Received. Stock updated; the rest is still to come.');
        dlg.close(); await done();
      }, { kind: 'primary', small: true }) : null,
      ['draft', 'ordered'].includes(o.status) && isManager() ? button('Cancel order', () => confirmDialog(`Cancel PO ${o.po_number}?`, 'It stays on the list as cancelled.', 'Cancel order', async () => { await post(`/assets/purchase-orders/${o.id}/cancel`, {}); dlg.close(); await done(); }, { danger: true }), { small: true, kind: 'quiet-danger' }) : null)), { wide: true });
}

// ---------------------------------------------------------------- costs (managers)
async function drawCosts(box) {
  const { data, settings } = await get('/assets/lifecycle');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, `Labor at ${money(settings.labor_rate_cents)} an hour, parts at cost, outside work and fuel. Book value is straight-line over the useful life, down to salvage. A replacement is flagged when the last 12 months of upkeep pass ${settings.replace_pct}% of book value, or the asset is past its life.`),
      button('Download spreadsheet', () => download('/assets/lifecycle?format=csv', 'asset-costs.csv'), { small: true })),
    data.length ? table([
      { head: 'Asset', cell: (a) => h('span', { class: 'stack tight' }, assetLink(a.id, h('strong', null, a.name)), h('span', { class: 'muted small' }, a.tag)) },
      { head: 'Age', num: true, cell: (a) => (a.age_years !== null ? `${a.age_years} y` : '') },
      { head: 'Book value', num: true, cell: (a) => (a.book_value_cents !== null ? money(a.book_value_cents) : '') },
      { head: 'Upkeep, 12 months', num: true, cell: (a) => money(a.maintenance_12) },
      { head: 'All costs', num: true, cell: (a) => money(a.total) },
      { head: 'Per hour', num: true, cell: (a) => (a.cost_per_hour_cents !== null ? money(a.cost_per_hour_cents) : '') },
      { head: 'Per mile', num: true, cell: (a) => (a.cost_per_mile_cents !== null ? money(a.cost_per_mile_cents) : '') },
      { head: '', cell: (a) => (a.replace ? state('Consider replacing', 'warn') : '') },
    ], data) : empty('No assets yet.')));
}

// ---------------------------------------------------------------- settings (managers)
async function drawSettings(box) {
  const [s, locs, vendors, meta] = await Promise.all([get('/assets/settings'), get('/assets/locations'), get('/assets/vendors'), get('/assets/meta')]);
  const again = () => drawSettings(box);
  const rate = input({ name: 'rate', inputmode: 'decimal', value: centsToInput(s.labor_rate_cents), 'aria-label': 'Shop labor rate per hour' });
  const pct = input({ name: 'pct', type: 'number', min: 5, max: 200, value: s.replace_pct, 'aria-label': 'Replacement threshold percent' });
  const warn = input({ name: 'warn', type: 'number', min: 1, max: 365, value: s.expiry_warn_days, 'aria-label': 'Days of warning before papers run out' });
  const kindLabel = (k) => (meta.kinds.find((x) => x.value === k) || { label: k }).label;
  clear(box).append(h('div', { class: 'stack' },
    h('section', { class: 'panel stack' }, h('h2', null, 'Shop rules'),
      h('div', { class: 'form' }, field('Shop labor rate, per hour ($)', rate, 'Applied to time logged from now on'), field('Flag a replacement when a year of upkeep passes this % of book value', pct), field('Warn this many days before papers run out', warn)),
      h('div', { class: 'row' }, button('Save', async () => { const c = toCents(rate.value); if (c === null) throw new Error('The labor rate must be an amount'); await put('/assets/settings', { labor_rate_cents: c, replace_pct: Number(pct.value), expiry_warn_days: Number(warn.value) }); toast('Saved'); }, { kind: 'primary', small: true }))),
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Places'), button('Add a place', () => locDialog(null, locs.data, again), { small: true })),
      locs.data.length ? h('ul', { class: 'plain rows' }, locs.data.map((l) => h('li', { class: 'spread' }, h('span', null, h('b', null, l.name), h('span', { class: 'muted small' }, ` ${label(l.kind)}${l.parent ? `, in ${l.parent}` : ''} · ${l.assets} asset${Number(l.assets) === 1 ? '' : 's'}${l.active ? '' : ' · not in use'}`)), button('Edit', () => locDialog(l, locs.data, again), { small: true, label: `Edit ${l.name}` })))) : h('p', { class: 'muted' }, 'Add the shop, the yard, each lodge and lift terminal.')),
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Vendors'), button('Add a vendor', () => vendorDialog(null, again), { small: true })),
      vendors.data.length ? h('ul', { class: 'plain rows' }, vendors.data.map((v) => h('li', { class: 'spread' }, h('span', null, h('b', null, v.name), h('span', { class: 'muted small' }, ` ${[v.contact, v.phone, v.email, v.account_no && `account ${v.account_no}`].filter(Boolean).join(' · ')}${v.active ? '' : ' · not in use'}`)), button('Edit', () => vendorDialog(v, again), { small: true, label: `Edit ${v.name}` })))) : h('p', { class: 'muted' }, 'Add the dealers and suppliers you buy parts and service from.')),
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Inspection checklists'), button('Add a checklist', () => tplDialog(null, meta, again), { small: true })),
      h('ul', { class: 'plain rows' }, meta.templates.map((t) => h('li', { class: 'spread' }, h('span', null, h('b', null, t.name), h('span', { class: 'muted small' }, ` ${t.items.length} items · ${t.kinds.length ? t.kinds.map(kindLabel).join(', ') : 'anything without its own checklist'}${t.active ? '' : ' · not in use'}`)), button('Edit', () => tplDialog(t, meta, again), { small: true, label: `Edit ${t.name}` })))))));
}

function locDialog(l, all, done) {
  const cur = l || {};
  formDialog(l ? `Edit ${l.name}` : 'Add a place', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: cur.name || '' })),
    field('Kind', select([['shop', 'Shop'], ['yard', 'Yard'], ['building', 'Building'], ['lift', 'Lift terminal'], ['storage', 'Storage'], ['area', 'Area'], ['other', 'Other']], cur.kind || 'area', { name: 'kind' })),
    field('Inside', select([['', 'Nothing'], ...all.filter((x) => x.id !== cur.id).map((x) => [x.id, x.name])], cur.parent_id || '', { name: 'parent_id' })),
    l ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(cur.active) }), ' In use') : null),
  async (fd) => {
    const b = { name: val(fd, 'name'), kind: val(fd, 'kind'), parent_id: num(fd, 'parent_id') };
    if (l) await patch(`/assets/locations/${l.id}`, { ...b, active: fd.get('active') === 'on' }); else await post('/assets/locations', b);
    toast('Saved'); await done();
  });
}

function vendorDialog(v, done) {
  const cur = v || {};
  formDialog(v ? `Edit ${v.name}` : 'Add a vendor', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 150, value: cur.name || '' })), field('Contact', input({ name: 'contact', maxlength: 150, value: cur.contact || '' })),
    field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40, value: cur.phone || '' })), field('Email', input({ name: 'email', type: 'email', maxlength: 255, value: cur.email || '' })),
    field('Account number', input({ name: 'account_no', maxlength: 60, value: cur.account_no || '' })),
    v ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(cur.active) }), ' In use') : null,
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500, value: cur.notes || '' })))),
  async (fd) => {
    const b = { name: val(fd, 'name'), contact: val(fd, 'contact'), phone: val(fd, 'phone'), email: val(fd, 'email'), account_no: val(fd, 'account_no'), notes: val(fd, 'notes') };
    if (v) await patch(`/assets/vendors/${v.id}`, { ...b, active: fd.get('active') === 'on' }); else await post('/assets/vendors', b);
    toast('Saved'); await done();
  });
}

function tplDialog(t, meta, done) {
  const cur = t || { kinds: [], items: [] };
  const boxes = meta.kinds.map((k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k.value, checked: cur.kinds.includes(k.value) }), ` ${k.label}`));
  formDialog(t ? `Edit ${t.name}` : 'Add a checklist', h('div', { class: 'stack' },
    field('Name', input({ name: 'name', required: true, maxlength: 120, value: cur.name || '' })),
    field('Items, one per line', h('textarea', { name: 'items', rows: 8, required: true }, cur.items.map((i) => i.label).join('\n')), 'Each line is one thing to check: pass, fail or not applicable'),
    h('fieldset', { class: 'stack tight' }, h('legend', null, 'Used for these types (none: for anything without its own)'), h('div', { class: 'checks' }, boxes)),
    t ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: Boolean(cur.active) }), ' In use') : null),
  async (fd) => {
    const lines = String(fd.get('items') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Add at least one item');
    // Keep the keys of items that stay, so past inspections still line up.
    const used = new Set();
    const items = lines.map((labelText, i) => {
      const old = cur.items.find((x) => x.label === labelText);
      let key = old ? old.key : labelText.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || `item_${i + 1}`;
      while (used.has(key)) key = `${key.slice(0, 26)}_${i + 1}`;
      used.add(key);
      return { key, label: labelText.slice(0, 150) };
    });
    const body = { name: val(fd, 'name'), items, kinds: boxes.map((b) => b.firstChild).filter((x) => x.checked).map((x) => x.value) };
    if (t) await patch(`/assets/templates/${t.id}`, { ...body, active: fd.get('active') === 'on' }); else await post('/assets/templates', body);
    toast('Saved'); await done();
  }, { wide: true });
}
