// Work orders for a municipality (muni release 1): the jobs for the crew and the service plans that keep the trucks,
// plows and equipment running. The same work orders and service plans as Mountain status, Maintenance (views/ops-maint.js:
// the API under /ops/work-orders and /ops/pm, the same statuses, notes and "Make work order"), without lifts or ski words.
// Reachable with Assets and fleet on (lib/modules.js opens those two paths for it). Tabs: Open, Done, Service plans.
// Filters: priority, assigned to, where it came from, overdue. #/works?tab=done, #/works?overdue=1, #/works/12 opens one.
import { get, post, patch, del, download } from '../api.js';
import { shareButton } from '../share.js';
import { miniMap } from './asset-bits.js';
import { costPickers, markDone, costsSection, booksFacts, booksFields, booksBody, doneRange, doneTotals } from './works-costs.js';
import { h, clear, ctx, isManager, table, state, tabs, input, select, field, button, toast, formDialog, confirmDialog, val, num, todayStr, fmtDate, fmtDateTime, empty, label, hashParam, money } from '../ui.js';

const PRIORITY_TONE = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const STATUS_TEXT = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting for parts', done: 'Done', cancelled: 'Canceled' };
// Where a work order came from (work_orders.source). Requests, programs and notices arrive with the municipal apps.
export const SOURCES = [['manual', 'Entered by staff'], ['preventive', 'Service plan'], ['inspection', 'Inspection'], ['request', 'Resident request'], ['program', 'Program'], ['notice', 'Street notice']];
const SOURCE_TEXT = Object.fromEntries(SOURCES);
const PM_TONE = { overdue: 'bad', soon: 'warn', ok: 'good', never: 'neutral' };
const PM_TEXT = { overdue: 'Overdue', soon: 'Due soon', ok: 'On track', never: 'Never done' };

const assetsOn = () => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes('assets'));
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
    ['plans', 'Service plans', (box) => { reload = () => drawPlans(box, pick); return drawPlans(box, pick); }],
  ], ['open', 'done', 'plans'].includes(wanted) ? wanted : 'open', { param: 'tab' }));
  if (opened) openOrder(opened, pick, () => reload()).catch((err) => toast(err.message || 'Could not open that work order', 'error'));
}

// ---------------------------------------------------------------- work orders
async function drawOrders(box, status, pick) {
  const priority = select([['', 'Any priority'], ...PRIORITIES], '', { 'aria-label': 'Priority' });
  const who = select([['', 'Anyone'], ...(ctx.me.staff_id ? [['mine', 'Assigned to me']] : []), ['none', 'Not assigned'], ...pick.staff.map((s) => [s.id, staffName(s)])], '', { 'aria-label': 'Assigned to' });
  const source = select([['', 'From anywhere'], ...SOURCES], '', { 'aria-label': 'Where it came from' });
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
    if (status === 'open' && overdue.checked) q.set('overdue', '1');
    return q;
  };
  const exportRow = h('div', { class: 'row no-print' },
    button('Download spreadsheet', () => { const q = filters(); if (contacts.checked) q.set('contacts', '1'); return download(`/ops/work-orders/export?${q}`, `work-orders-${todayStr()}.csv`); }, { small: true }),
    isManager() ? h('label', { class: 'check', title: 'Logged with your name' }, contacts, ' Include contact details (logged)') : null,
    h('span', { class: 'muted small' }, 'Work orders are public records. The spreadsheet leaves out residents’ house numbers and their own words.'));
  clear(box).append(h('div', { class: 'week-filter', role: 'group', 'aria-label': 'Filters' }, priority, who, source,
    status === 'open' ? h('label', { class: 'check' }, overdue, ' Overdue only') : null, range ? range.el : null), body, exportRow);
  async function load() {
    const q = filters();
    const { data, totals } = await get(`/ops/work-orders?${q}`);
    clear(body);
    if (totals) body.append(doneTotals(totals));
    if (!data.length) { body.append(empty(status === 'open' ? 'No open work orders. Nice work.' : 'Nothing done in these dates.')); return; }
    const today = todayStr();
    body.append(table([
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
  for (const el of [priority, who, source, overdue]) el.addEventListener('change', load);
  await load();
}

function orderFields(pick, w = {}) {
  return h('div', { class: 'form' },
    field('What needs doing', input({ name: 'title', required: true, maxlength: 150, value: w.title || '', placeholder: 'Patch pothole' })),
    field('Priority', select(PRIORITIES, w.priority || 'normal', { name: 'priority' })),
    pick.assets.length ? field('Asset', select([['', 'None'], ...pick.assets.map((a) => [a.id, a.asset_tag ? `${a.name} (${a.asset_tag})` : a.name])], w.asset_id || '', { name: 'asset_id' }), 'The truck, pump or other equipment, if there is one') : null,
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
  const dlg = formDialog(w.title, h('div', { class: 'stack' },
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
      open ? act('cancelled', 'Cancel job') : null,
      open && isManager() ? button('Edit', () => { dlg.close(); editOrder(w, pick, done); }, { small: true }) : null,
      isManager() ? button('Delete', () => confirmDialog('Delete work order', 'This removes the job and its notes. To keep the record, cancel it instead.', 'Delete', async () => { await del(`/ops/work-orders/${id}`); dlg.close(); await done(); }, { danger: true }), { small: true }) : null)),
  async () => {}, { submitText: 'Close' });

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
