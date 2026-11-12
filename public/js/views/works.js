// Work orders for a municipality (muni release 1): the jobs for the crew and the service plans that keep the trucks,
// plows and equipment running. The same work orders and service plans as Mountain status, Maintenance (views/ops-maint.js:
// the API under /ops/work-orders and /ops/pm, the same statuses, notes and "Make work order"), without lifts or ski words.
// Reachable with Assets and fleet on (lib/modules.js opens those two paths for it). Tabs: Open, Done, Service plans.
// Filters: priority, assigned to, where it came from, overdue. #/works?tab=done, #/works?overdue=1, #/works/12 opens one.
// 2026.11.20 (crew): ?system=water|sewer|stormwater (work orders on that system's map items, from Today's cards),
// ?who=mine|none|<staff id>, ?new=1 opens New work order; a manager picks several open ones and assigns them to a person
// and day at once (POST /ops/work-orders/assign); the Map tab shows open work orders by priority (GET /ops/work-orders/map).
// 2026.11.20 (assembly): every filter can come from the link, so Today's cards and the monthly report open the list
// already filtered: ?priority=, ?source=, ?department_id=, ?fund_id=, ?street_id= (with system, who and overdue above).
import { get, post, patch, del, download } from '../api.js';
import { shareButton } from '../share.js';
import { miniMap } from './asset-bits.js';
import { costPickers, markDone, costsSection, booksFacts, booksFields, booksBody, doneRange, doneTotals } from './works-costs.js';
import { featurePicker } from './utility-bits.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';
import { h, clear, ctx, isManager, table, state, tabs, input, select, field, button, toast, formDialog, confirmDialog, dialog, val, num, todayStr, fmtDate, fmtDateTime, empty, label, hashParam, money, errorBox } from '../ui.js';
import { whenNew } from '../newmenu.js';

const PRIORITY_TONE = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const STATUS_TEXT = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting for parts', done: 'Done', cancelled: 'Canceled' };
// Where a work order came from (work_orders.source). Requests, programs and notices arrive with the municipal apps.
export const SOURCES = [['manual', 'Entered by staff'], ['preventive', 'Service plan'], ['inspection', 'Inspection'], ['request', 'Resident request'], ['program', 'Program'], ['notice', 'Street notice']];
const SOURCE_TEXT = Object.fromEntries(SOURCES);
const PM_TONE = { overdue: 'bad', soon: 'warn', ok: 'good', never: 'neutral' };
const PM_TEXT = { overdue: 'Overdue', soon: 'Due soon', ok: 'On track', never: 'Never done' };

const assetsOn = () => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes('assets'));
const moduleOn = (k) => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes(k));
// The utility systems a work order can be on (its map item's), each shown when its add-on is on (2026.11.20).
const SYSTEMS = [['water', 'Water'], ['sewer', 'Sewer'], ['stormwater', 'Stormwater']];
const PRIORITY_COLOR = { urgent: '#c62828', high: '#e8710a', normal: '#1f5fd1', low: '#6b7780' };
const workforceOn = () => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes('workforce'));

/** What the pickers need: the asset register (Assets and fleet) and, for managers, the staff to assign. */
async function pickers() {
  const [assets, staff, books] = await Promise.all([
    assetsOn() ? get('/assets/register').then((r) => r.data).catch(() => []) : Promise.resolve([]),
    isManager() && workforceOn() ? get('/workforce/staff').then((r) => r.data || []).catch(() => []) : Promise.resolve([]),
    assetsOn() ? costPickers({ fresh: true }) : Promise.resolve(null), // departments, funds and streets (works-costs.js)
  ]);
  return { assets, staff: staff.filter((s) => ['active', 'onboarding'].includes(s.status)), books };
}
const staffName = (s) => `${s.first_name} ${s.last_name}`.trim();

export async function render(root, params = []) {
  const opened = /^\d+$/.test(params[0] || '') ? Number(params[0]) : null;
  const pick = await pickers();
  root.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Work orders'), h('p', null, 'Jobs for the crew, and the service plans that keep trucks and equipment running.')),
    h('div', { class: 'actions' }, button('New work order', () => addOrder(pick, () => reload()), { kind: 'primary', small: true }))));
  const holder = h('div');
  root.append(holder);
  let reload = () => {};
  const wanted = hashParam('tab');
  holder.append(tabs([
    ['open', 'Open', (box) => { reload = () => drawOrders(box, 'open', pick); return drawOrders(box, 'open', pick); }],
    ['done', 'Done', (box) => { reload = () => drawOrders(box, 'closed', pick); return drawOrders(box, 'closed', pick); }],
    ['map', 'Map', (box) => { reload = () => drawWorkMap(box, pick); return drawWorkMap(box, pick); }],
    ['plans', 'Service plans', (box) => { reload = () => drawPlans(box, pick); return drawPlans(box, pick); }],
  ], ['open', 'done', 'map', 'plans'].includes(wanted) ? wanted : 'open', { param: 'tab' }));
  if (opened) openOrder(opened, pick, () => reload()).catch((err) => toast(err.message || 'Could not open that work order', 'error'));
  whenNew(root, () => addOrder(pick, () => reload())); // #/works?new=1 (+ New, Today's Report a problem): the form opens, the mark comes off the address
}

// ---------------------------------------------------------------- work orders
async function drawOrders(box, status, pick) {
  // A value from the link counts only when it is one of the choices (an old or mistyped link shows the full list).
  const wanted = (name, options) => { const v = hashParam(name) || ''; return options.some(([k]) => String(k) === v) ? v : ''; };
  const priority = select([['', 'Any priority'], ...PRIORITIES], wanted('priority', PRIORITIES), { 'aria-label': 'Priority' });
  const whoOptions = [...(ctx.me.staff_id ? [['mine', 'Assigned to me']] : []), ['none', 'Not assigned'], ...pick.staff.map((s) => [s.id, staffName(s)])];
  const who = select([['', 'Anyone'], ...whoOptions], wanted('who', whoOptions), { 'aria-label': 'Assigned to' });
  const source = select([['', 'From anywhere'], ...SOURCES], wanted('source', SOURCES), { 'aria-label': 'Where it came from' });
  // A municipality's departments, funds and streets (2026.11.20). The department is always offered; a fund or a street
  // only when the link asks for one, so the row stays short.
  const books = pick.books && pick.books.is_muni ? pick.books : null;
  const bookSelect = (name, all, list, text) => {
    const options = (list || []).filter((x) => x.active !== false || String(x.id) === hashParam(name)).map((x) => [x.id, x.name]);
    return options.length ? select([['', all], ...options], wanted(name, options), { 'aria-label': text }) : null;
  };
  const department = books ? bookSelect('department_id', 'Any department', books.departments, 'Department') : null;
  const fund = books && hashParam('fund_id') ? bookSelect('fund_id', 'Any fund', books.funds, 'Fund') : null;
  const street = books && hashParam('street_id') ? bookSelect('street_id', 'Any street', books.streets, 'Street') : null;
  const systems = SYSTEMS.filter(([k]) => moduleOn(k));
  const system = select([['', 'Any system'], ...systems], systems.some(([k]) => k === hashParam('system')) ? hashParam('system') : '', { 'aria-label': 'System' });
  const overdue = h('input', { type: 'checkbox', name: 'overdue' });
  overdue.checked = status === 'open' && hashParam('overdue') === '1';
  const body = h('div');
  // Work orders are public records. The spreadsheet leaves out what would identify a resident (the house number and the
  // resident's own words on a work order made from a request) unless a manager ticks the box, which is logged.
  const contacts = h('input', { type: 'checkbox' });
  // The Done tab: a date range, and the totals of what matches (works-costs.js).
  const range = status === 'closed' ? doneRange(() => load()) : null;
  const filters = () => {
    const q = new URLSearchParams({ status });
    if (range) range.apply(q);
    if (priority.value) q.set('priority', priority.value);
    if (who.value === 'mine') q.set('mine', '1'); else if (who.value) q.set('assigned_staff_id', who.value);
    if (source.value) q.set('source', source.value);
    if (system.value) q.set('system', system.value);
    for (const [k, el] of [['department_id', department], ['fund_id', fund], ['street_id', street]]) if (el && el.value) q.set(k, el.value);
    if (status === 'open' && overdue.checked) q.set('overdue', '1');
    return q;
  };
  // A manager picks several open work orders and assigns them at once (2026.11.20).
  const bulk = status === 'open' && isManager() && pick.staff.length;
  const picked = new Set();
  const bar = h('div', { class: 'wo-bulkbar row wrap', hidden: true, role: 'region', 'aria-label': 'Assign the work orders picked' });
  const drawBar = () => {
    bar.hidden = !picked.size;
    if (!picked.size) return;
    const to = select([['', 'Choose a person'], ['none', 'Nobody (unassign)'], ...pick.staff.map((s) => [s.id, staffName(s)])], '', { 'aria-label': 'Assign to' });
    const due = input({ type: 'date', value: todayStr(), 'aria-label': 'Due' });
    const keepDue = h('input', { type: 'checkbox' });
    clear(bar).append(h('b', null, `${picked.size} picked`), h('label', { class: 'muted small' }, 'Assign to ', to), h('label', { class: 'muted small' }, 'Due ', due), h('label', { class: 'check small' }, keepDue, ' Keep their due dates'),
      button('Assign', async () => {
        if (!to.value) { toast('Choose who does them', 'error'); return; }
        const r = await post('/ops/work-orders/assign', { ids: [...picked], assigned_staff_id: to.value === 'none' ? null : Number(to.value), ...(keepDue.checked ? {} : { due_date: due.value || null }) });
        toast(`${r.updated} work order${r.updated === 1 ? '' : 's'} assigned`);
        picked.clear(); drawBar(); await load();
      }, { kind: 'primary', small: true }),
      button('Clear', () => { picked.clear(); body.querySelectorAll('input.wo-pick').forEach((x) => { x.checked = false; }); drawBar(); }, { small: true }));
  };
  // The spreadsheet is for the office (managers and Front desk); the Crew's screen is for the work (2026.11.20).
  const exportRow = ctx.me && ctx.me.role === 'staff' ? null : h('div', { class: 'row no-print' },
    button('Download spreadsheet', () => { const q = filters(); if (contacts.checked) q.set('contacts', '1'); return download(`/ops/work-orders/export?${q}`, `work-orders-${todayStr()}.csv`); }, { small: true }),
    isManager() ? h('label', { class: 'check', title: 'Logged with your name' }, contacts, ' Include contact details (logged)') : null,
    h('span', { class: 'muted small' }, 'Work orders are public records. The spreadsheet leaves out residents’ house numbers and their own words.'));
  clear(box).append(h('div', { class: 'week-filter', role: 'group', 'aria-label': 'Filters' }, priority, who, source, systems.length ? system : null, department, fund, street,
    status === 'open' ? h('label', { class: 'check' }, overdue, ' Overdue only') : null, range ? range.el : null), body, bar, ...(exportRow ? [exportRow] : []));
  async function load() {
    const q = filters();
    const { data, totals } = await get(`/ops/work-orders?${q}`);
    clear(body);
    if (totals) body.append(doneTotals(totals));
    if (!data.length) { body.append(empty(status === 'open' ? 'No open work orders. Nice work.' : 'Nothing done in these dates.')); return; }
    const today = todayStr();
    for (const id of [...picked]) if (!data.some((w) => w.id === id)) picked.delete(id);
    drawBar();
    const pickBox = (w) => { const c = h('input', { type: 'checkbox', class: 'wo-pick', 'aria-label': `Pick ${w.title}`, checked: picked.has(w.id) }); c.addEventListener('change', () => { if (c.checked) picked.add(w.id); else picked.delete(w.id); drawBar(); }); return c; };
    const allBox = h('input', { type: 'checkbox', class: 'wo-pick' });
    allBox.addEventListener('change', () => { for (const w of data) { if (allBox.checked) picked.add(w.id); else picked.delete(w.id); } body.querySelectorAll('tbody input.wo-pick').forEach((x) => { x.checked = allBox.checked; }); drawBar(); });
    if (bulk) body.append(h('label', { class: 'check small' }, allBox, ' Pick all shown, to assign them at once'));
    body.append(table([
      ...(bulk ? [{ head: 'Pick', cell: pickBox }] : []),
      { head: 'Priority', cell: (w) => state(label(w.priority), PRIORITY_TONE[w.priority]) },
      { head: 'Job', cell: (w) => h('span', { class: 'stack tight' }, h('strong', null, w.title), h('span', { class: 'muted small' }, [w.asset, w.feature_tag || w.feature_name, w.location].filter(Boolean).join(', '))) },
      { head: 'Assigned to', cell: (w) => w.assignee || h('span', { class: 'muted' }, 'Nobody yet') },
      { head: status === 'open' ? 'Due' : 'Done', cell: (w) => (status === 'open' ? (w.due_date ? h('span', null, fmtDate(w.due_date), String(w.due_date).slice(0, 10) < today ? h('span', null, ' ', state('Overdue', 'bad')) : null) : '') : (w.completed_at ? fmtDateTime(w.completed_at) : STATUS_TEXT[w.status])) },
      { head: 'Status', cell: (w) => STATUS_TEXT[w.status] || label(w.status) },
      { head: 'From', cell: (w) => SOURCE_TEXT[w.source] || label(w.source) },
      ...(status === 'closed' ? [{ head: 'Hours', num: true, cell: (w) => (w.hours ? String(w.hours) : '') }, ...(isManager() ? [{ head: 'Cost', num: true, cell: (w) => (w.cost_cents ? money(w.cost_cents) : '') }] : [])] : []),
      { head: '', actions: true, cell: (w) => button('Open', () => openOrder(w.id, pick, load), { small: true, label: `Open ${w.title}` }) },
    ], data));
  }
  for (const el of [priority, who, source, system, department, fund, street, overdue]) if (el) el.addEventListener('change', load);
  await load();
}

function orderFields(pick, w = {}) {
  return h('div', { class: 'form' },
    field('What needs doing', input({ name: 'title', required: true, maxlength: 150, value: w.title || '', placeholder: 'Patch pothole' })),
    field('Priority', select(PRIORITIES, w.priority || 'normal', { name: 'priority' })),
    pick.assets.length ? field('Asset', select([['', 'None'], ...pick.assets.map((a) => [a.id, a.asset_tag ? `${a.name} (${a.asset_tag})` : a.name])], w.asset_id || '', { name: 'asset_id' }), 'The truck, pump or other equipment, if there is one') : null,
    // Any map item: a main, valve, hydrant, service line, sewer line or manhole (2026.11.20, utility-bits.js).
    assetsOn() ? h('div', { class: 'wide' }, field('On the map', featurePicker({ value: w.map_feature_id ? { id: w.map_feature_id, label: [w.feature_kind_label, w.feature_tag || w.feature_name].filter(Boolean).join(' ') } : null }), 'The main, valve, hydrant, manhole or other item on the map, if there is one')) : null,
    field('Where', input({ name: 'location', maxlength: 120, value: w.location || '', placeholder: 'Mill Street at 3rd Avenue' })),
    pick.staff.length ? field('Assigned to', select([['', 'Nobody yet'], ...pick.staff.map((s) => [s.id, staffName(s)])], w.assigned_staff_id || '', { name: 'assigned_staff_id' })) : null,
    field('Due', input({ name: 'due_date', type: 'date', value: w.due_date ? String(w.due_date).slice(0, 10) : '' })),
    field('Details', h('textarea', { name: 'description', rows: 3, maxlength: 5000 }, w.description || '')),
    pick.books ? booksFields(pick.books, w) : null);
}
const orderBody = (fd, pick, w = {}) => ({
  title: val(fd, 'title'), priority: val(fd, 'priority'), location: val(fd, 'location'), due_date: val(fd, 'due_date'), description: val(fd, 'description'),
  ...(pick.assets.length ? { asset_id: num(fd, 'asset_id') } : {}), ...(pick.staff.length ? { assigned_staff_id: num(fd, 'assigned_staff_id') } : {}),
  ...(pick.books ? booksBody(fd, pick.books, w) : {}),
  ...(fd.has('map_feature_id') ? { map_feature_id: num(fd, 'map_feature_id') } : {}),
});

function addOrder(pick, done) {
  formDialog('New work order', orderFields(pick), async (fd) => {
    await post('/ops/work-orders', orderBody(fd, pick));
    toast('Work order created');
    await done();
  }, { submitText: 'Create' });
}

async function openOrder(id, pick, done) {
  const w = await get(`/ops/work-orders/${id}`);
  const note = input({ placeholder: 'Add a note', maxlength: 1000, 'aria-label': 'Note' });
  const open = w.status !== 'done' && w.status !== 'cancelled';
  const act = (status, text, kind) => button(text, () => setStatus(w, status), { small: true, kind });
  const mapSlot = h('div');
  // Its costs: each person's hours, equipment, parts and materials, and Add costs (works-costs.js).
  const costSlot = h('div');
  const reopen = async () => { dlg.close(); await done(); await openOrder(id, pick, done); };
  if (assetsOn()) costsSection(w, reopen).then((el) => { if (el) costSlot.append(el); });
  if (w.map_feature_id) miniMap({ geometry: w.feature_geometry, points: w.feature_points, lat: w.feature_lat, lng: w.feature_lng }, { label: 'Where it is on the map' }).then((el) => mapSlot.append(el));
  // One way to close: the dialog's own Close (it is not a form, so no Cancel and Save). Cancel job and Delete sit apart
  // from the work buttons, and both ask first (2026.11.20).
  const dlg = dialog(w.title, h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('p', null, state(STATUS_TEXT[w.status] || label(w.status), w.status === 'done' ? 'good' : 'neutral'), ' ', state(label(w.priority), PRIORITY_TONE[w.priority])), shareButton('work_order', w.id)),
    w.description ? h('p', null, w.description) : null,
    h('dl', { class: 'facts' },
      w.asset ? [h('dt', null, 'Asset'), h('dd', null, w.asset)] : null,
      // A valve, hydrant or manhole on the asset map, and the program it came from (asset workstream, muni release 1).
      w.map_feature_id ? [h('dt', null, 'On the map'), h('dd', null, h('a', { href: `#/assets/map/f${w.map_feature_id}` }, [w.feature_kind_label, w.feature_tag || w.feature_name].filter(Boolean).join(' ')))] : null,
      w.program ? [h('dt', null, 'Program'), h('dd', null, h('a', { href: `#/assetprograms/${w.program_id}` }, w.program))] : null,
      w.location ? [h('dt', null, 'Where'), h('dd', null, w.location)] : null,
      [h('dt', null, 'Assigned to'), h('dd', null, w.assignee || 'Nobody yet')],
      w.due_date ? [h('dt', null, 'Due'), h('dd', null, fmtDate(w.due_date))] : null,
      [h('dt', null, 'From'), h('dd', null, SOURCE_TEXT[w.source] || label(w.source))],
      [h('dt', null, 'Opened'), h('dd', null, fmtDateTime(w.opened_at))],
      booksFacts(w),
      w.labor_hours ? [h('dt', null, 'Labor'), h('dd', null, `${Number(w.labor_hours)} hours`)] : null,
      w.parts_note ? [h('dt', null, 'Parts'), h('dd', null, w.parts_note)] : null),
    w.map_feature_id ? mapSlot : null,
    w.resolution ? h('p', null, h('strong', null, 'Done: '), w.resolution) : null,
    costSlot,
    h('ul', { class: 'wo-notes' }, ...w.notes.map((n) => h('li', null, h('span', { class: 'muted small' }, `${fmtDateTime(n.at)} ${n.author || ''}`), h('span', null, n.body)))),
    h('div', { class: 'row' }, note, button('Add note', async () => { if (!note.value.trim()) return; await post(`/ops/work-orders/${id}/notes`, { body: note.value.trim() }); dlg.close(); await openOrder(id, pick, done); }, { small: true })),
    h('div', { class: 'row wrap' },
      w.status === 'open' || w.status === 'waiting_parts' ? act('in_progress', 'Start work', 'primary') : null,
      w.status === 'in_progress' ? act('waiting_parts', 'Waiting for parts') : null,
      open ? act('done', 'Mark done', 'primary') : act('open', 'Reopen'),
      open && isManager() ? button('Edit', () => { dlg.close(); editOrder(w, pick, done); }, { small: true }) : null),
    open || isManager() ? h('div', { class: 'row wrap wo-danger' },
      open ? button('Cancel job', () => confirmDialog('Cancel this job?', 'It stays on the record as canceled, with its notes. You can reopen it later.', 'Cancel job', () => setStatus(w, 'cancelled'), { danger: true, noText: 'Keep the job' }), { small: true }) : null,
      isManager() ? button('Delete', () => confirmDialog('Delete work order', 'This removes the job and its notes. To keep the record, cancel it instead.', 'Delete', async () => { await del(`/ops/work-orders/${id}`); dlg.close(); await done(); }, { danger: true }), { small: true }) : null) : null));

  function setStatus(order, status) {
    if (status !== 'done') {
      return post(`/ops/work-orders/${order.id}/status`, { status }).then(async () => { toast('Updated'); dlg.close(); await done(); });
    }
    // Mark done with what it took: each person's hours, equipment, parts and materials (works-costs.js).
    return markDone(order, async () => { dlg.close(); await done(); });
  }
}

function editOrder(w, pick, done) {
  formDialog(`Edit ${w.title}`, orderFields(pick, w), async (fd) => {
    await patch(`/ops/work-orders/${w.id}`, orderBody(fd, pick, w));
    toast('Saved');
    await done();
  });
}

// ---------------------------------------------------------------- the map (2026.11.20)
/** Open work orders that have a place (a map item, an asset on the map, or a resident request's location), by priority. */
async function drawWorkMap(box, pick) {
  const mine = h('input', { type: 'checkbox' });
  mine.checked = !isManager() && Boolean(ctx.me.staff_id);
  const systems = SYSTEMS.filter(([k]) => moduleOn(k));
  const system = select([['', 'Any system'], ...systems], '', { 'aria-label': 'System' });
  const mapEl = h('div', { class: 'map-box tall', role: 'application', 'aria-label': 'Map of open work orders, colored by priority' });
  const note = h('p', { class: 'muted small' });
  const legend = h('ul', { class: 'amap-legend row wrap', style: 'display:flex;gap:6px 16px;flex-wrap:wrap' }, PRIORITIES.slice().reverse().map(([k, t]) => h('li', null, h('span', { class: 'amap-swatch', style: `--c:${PRIORITY_COLOR[k]}` }), ` ${t}`)));
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'week-filter', role: 'group', 'aria-label': 'Filters' }, ctx.me.staff_id ? h('label', { class: 'check' }, mine, ' Assigned to me') : null, systems.length ? system : null),
    legend, mapEl, note));
  let L; let map; let layer;
  try { L = await loadLeaflet(); const cfg = await get('/assets/map/view'); map = makeMap(L, mapEl, cfg, cfg.center || { lat: 39.8283, lng: -98.5795, zoom: 4 }, { base: 'Streets', remember: 'works' }); removeWhenGone(mapEl, map); } catch (err) { mapEl.replaceWith(errorBox(err)); return; }
  async function load() {
    const q = new URLSearchParams();
    if (mine.checked) q.set('mine', '1');
    if (system.value) q.set('system', system.value);
    const { data, unplaced } = await get(`/ops/work-orders/map?${q}`);
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(map);
    const order = { low: 0, normal: 1, high: 2, urgent: 3 };
    for (const w of [...data].sort((a, b) => order[a.priority] - order[b.priority])) {
      const m = L.circleMarker([w.lat, w.lng], { radius: w.priority === 'urgent' ? 11 : 8, color: '#fff', weight: 2, fillColor: PRIORITY_COLOR[w.priority], fillOpacity: 0.95 }).addTo(layer);
      const pop = h('div', { class: 'stack tight' }, h('b', null, w.title), h('span', { class: 'muted small' }, [label(w.priority), STATUS_TEXT[w.status], w.assignee || 'Nobody yet', w.place].filter(Boolean).join(' · ')),
        button('Open', () => openOrder(w.id, pick, load), { small: true }));
      m.bindPopup(pop);
      m.bindTooltip(w.title);
    }
    if (data.length) fitMap(map, L.latLngBounds(data.map((w) => [w.lat, w.lng])), { padding: [30, 30], maxZoom: 17 });
    note.textContent = `${data.length} open work order${data.length === 1 ? '' : 's'} on the map.${unplaced ? ` ${unplaced} more have no place on the map; they are on the Open tab.` : ''}`;
  }
  mine.addEventListener('change', load); system.addEventListener('change', load);
  await load();
}

// ---------------------------------------------------------------- service plans
async function drawPlans(box, pick) {
  const { data } = await get('/ops/pm');
  clear(box).append(h('header', { class: 'row between' }, h('h2', null, 'Service plans'), button('Add a service plan', () => add(), { small: true })));
  if (!data.length) { box.append(empty('No service plans yet. Add oil changes, plow blade checks, generator test runs and the like.')); return; }
  box.append(table([
    { head: 'Job', cell: (t) => h('span', { class: 'stack tight' }, h('strong', null, t.name), h('span', { class: 'muted small' }, t.asset || '')) },
    { head: 'Every', cell: (t) => [t.interval_days ? `${t.interval_days} days` : null, t.interval_hours ? `${Number(t.interval_hours)} hours` : null, t.interval_miles ? `${Number(t.interval_miles)} miles` : null].filter(Boolean).join(' or ') },
    { head: 'Last done', cell: (t) => (t.last_done_on ? fmtDate(t.last_done_on) : 'Never') },
    { head: 'Next', cell: (t) => [t.due_on ? fmtDate(t.due_on) : null, t.hours_left !== null && t.hours_left !== undefined ? `${t.hours_left} h left` : null, t.miles_left !== null && t.miles_left !== undefined ? `${t.miles_left} mi left` : null].filter(Boolean).join(', ') },
    { head: 'Status', cell: (t) => state(PM_TEXT[t.state], PM_TONE[t.state]) },
    { head: '', actions: true, cell: (t) => [
      button('Mark done', () => done(t), { small: true, kind: t.state === 'overdue' ? 'primary' : null }),
      button('Make work order', async () => { await post(`/ops/pm/${t.id}/work-order`); toast('Work order created. It is on the Open tab.'); }, { small: true }),
      isManager() ? button('Delete', () => confirmDialog('Delete service plan', `Remove "${t.name}" and its history?`, 'Delete', async () => { await del(`/ops/pm/${t.id}`); await drawPlans(box, pick); }, { danger: true }), { small: true }) : null] },
  ], data));
  function done(t) {
    formDialog(`Mark done: ${t.name}`, h('div', { class: 'form' },
      field('Date', input({ name: 'done_on', type: 'date', value: todayStr() })),
      t.asset ? field('Hour meter', input({ name: 'hours', type: 'number', step: '0.1', min: '0', value: t.asset_hours ?? '' }), 'Defaults to the current meter') : null,
      t.asset ? field('Odometer (miles)', input({ name: 'miles', type: 'number', step: '0.1', min: '0', value: t.asset_miles ?? '' }), 'Defaults to the current reading') : null,
      field('Note', input({ name: 'note', maxlength: 255 }))), async (fd) => {
      await post(`/ops/pm/${t.id}/done`, { done_on: val(fd, 'done_on'), hours: num(fd, 'hours'), miles: num(fd, 'miles'), note: val(fd, 'note') });
      toast('Recorded');
      await drawPlans(box, pick);
    }, { submitText: 'Record' });
  }
  function add() {
    formDialog('Add a service plan', h('div', { class: 'form' },
      field('Job', input({ name: 'name', required: true, maxlength: 150, placeholder: 'Plow truck oil change' })),
      pick.assets.length ? field('Asset', select([['', 'None'], ...pick.assets.map((a) => [a.id, a.name])], '', { name: 'asset_id' })) : null,
      field('Every (days)', input({ name: 'interval_days', type: 'number', min: '1' })),
      field('Every (hours on the meter)', input({ name: 'interval_hours', type: 'number', min: '1' }), 'Needs an asset'),
      field('Every (miles)', input({ name: 'interval_miles', type: 'number', min: '1' }), 'Needs an asset'),
      field('Checklist', h('textarea', { name: 'checklist', rows: 3, maxlength: 2000 }), 'One step per line. It goes on each work order the plan makes.'),
      field('Notes', input({ name: 'notes', maxlength: 500 }))), async (fd) => {
      await post('/ops/pm', { name: val(fd, 'name'), asset_id: num(fd, 'asset_id'), interval_days: num(fd, 'interval_days'), interval_hours: num(fd, 'interval_hours'), interval_miles: num(fd, 'interval_miles'), checklist: val(fd, 'checklist'), notes: val(fd, 'notes') });
      toast('Service plan added');
      await drawPlans(box, pick);
    }, { submitText: 'Add plan' });
  }
}
