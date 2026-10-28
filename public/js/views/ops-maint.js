import { get, post, patch, del } from '../api.js';
import { shareButton } from '../share.js';
import { h, clear, ctx, isManager, table, state, tabs, input, select, field, button, toast, formDialog, confirmDialog, val, num, todayStr, fmtDate, fmtDateTime, empty, label } from '../ui.js';

const PRIORITY_TONE = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
const PM_TONE = { overdue: 'bad', soon: 'warn', ok: 'good', never: 'neutral' };
const PM_TEXT = { overdue: 'Overdue', soon: 'Due soon', ok: 'On track', never: 'Never done' };

export async function drawMaintenance(root, { openOrder = null } = {}) {
  // These tabs sit inside Mountain status's Maintenance tab, so they keep their place in the address as ?sub=.
  const asked = openOrder ? null : new URLSearchParams(location.hash.split('?')[1] || '').get('sub');
  root.append(tabs([
    ['orders', 'Work orders', (box) => drawOrders(box, openOrder)],
    ['checks', 'Lift inspections', drawChecks],
    ['pm', 'Recurring jobs', drawPm],
    ['fleet', 'Fleet', drawFleet],
  ], ['checks', 'pm', 'fleet'].includes(asked) ? asked : 'orders', { param: 'sub' }));
}

// ---------------------------------------------------------------- work orders
async function drawOrders(box, openId = null) {
  const filter = select([['open', 'Open'], ['closed', 'Closed'], ['all', 'All']], 'open', { 'aria-label': 'Show' });
  const body = h('div');
  clear(box).append(h('header', null, h('h2', null, 'Work orders'), h('div', { class: 'row' }, filter, button('New work order', () => add(), { small: true }))), body);
  const [assets, lifts] = await Promise.all([get('/ops/assets'), get('/schedule/lifts?limit=500')]);
  async function load() {
    const { data } = await get(`/ops/work-orders?status=${filter.value}`);
    clear(body);
    if (!data.length) { body.append(empty(filter.value === 'open' ? 'No open work orders.' : 'Nothing here.')); return; }
    body.append(table([
      { head: 'Priority', cell: (w) => state(label(w.priority), PRIORITY_TONE[w.priority]) },
      { head: 'Job', cell: (w) => h('span', { class: 'stack tight' }, h('strong', null, w.title), h('span', { class: 'muted small' }, [w.lift, w.asset, w.location].filter(Boolean).join(', '))) },
      { head: 'Status', cell: (w) => label(w.status) },
      { head: 'Due', cell: (w) => (w.due_date ? fmtDate(w.due_date) : '') },
      { head: 'From', cell: (w) => label(w.source) },
      { head: '', cell: (w) => button('Open', () => detail(w.id), { small: true }) },
    ], data));
  }
  filter.addEventListener('change', load);
  function add(pre = {}) {
    formDialog('New work order', h('div', { class: 'form' },
      field('What needs doing', input({ name: 'title', required: true, maxlength: 150, value: pre.title || '' })),
      field('Priority', select([['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']], 'normal', { name: 'priority' })),
      field('Lift', select([['', 'None'], ...lifts.data.map((l) => [l.id, l.name])], '', { name: 'lift_id' })),
      field('Machine', select([['', 'None'], ...assets.data.map((a) => [a.id, a.name])], '', { name: 'asset_id' })),
      field('Where', input({ name: 'location', maxlength: 120 })),
      field('Due', input({ name: 'due_date', type: 'date' })),
      field('Details', h('textarea', { name: 'description', rows: 3, maxlength: 5000 }))), async (fd) => {
      await post('/ops/work-orders', { title: val(fd, 'title'), priority: val(fd, 'priority'), lift_id: num(fd, 'lift_id'), asset_id: num(fd, 'asset_id'), location: val(fd, 'location'), due_date: val(fd, 'due_date'), description: val(fd, 'description') });
      toast('Work order created');
      await load();
    }, { submitText: 'Create' });
  }
  async function detail(id) {
    const w = await get(`/ops/work-orders/${id}`);
    const note = input({ placeholder: 'Add a note', maxlength: 1000 });
    const list = h('ul', { class: 'wo-notes' }, ...w.notes.map((n) => h('li', null, h('span', { class: 'muted small' }, `${fmtDateTime(n.at)} ${n.author || ''}`), h('span', null, n.body))));
    const act = (status, text, kind) => button(text, () => setStatus(w, status), { small: true, kind });
    const dlg = formDialog(w.title, h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('p', null, state(label(w.status), w.status === 'done' ? 'good' : 'neutral'), ' ', state(label(w.priority), PRIORITY_TONE[w.priority])), shareButton('work_order', w.id)),
      w.description ? h('p', null, w.description) : null,
      h('p', { class: 'muted small' }, [w.lift, w.asset, w.location, w.assignee].filter(Boolean).join(', ')),
      w.resolution ? h('p', null, h('strong', null, 'Done: '), w.resolution) : null,
      list,
      h('div', { class: 'row' }, note, button('Add note', async () => { if (!note.value.trim()) return; await post(`/ops/work-orders/${id}/notes`, { body: note.value.trim() }); dlg.close(); await detail(id); }, { small: true })),
      h('div', { class: 'row' },
        w.status === 'open' || w.status === 'waiting_parts' ? act('in_progress', 'Start work', 'primary') : null,
        w.status === 'in_progress' ? act('waiting_parts', 'Waiting for parts') : null,
        w.status !== 'done' && w.status !== 'cancelled' ? act('done', 'Complete', 'primary') : act('open', 'Reopen'),
        w.status !== 'done' && w.status !== 'cancelled' ? act('cancelled', 'Cancel job') : null,
        isManager() ? button('Delete', () => confirmDialog('Delete work order', 'This removes the job and its notes.', 'Delete', async () => { await del(`/ops/work-orders/${id}`); dlg.close(); await load(); }, { danger: true }), { small: true }) : null)),
    async () => {}, { submitText: 'Done' });
  }
  function setStatus(w, status) {
    if (status !== 'done') { return post(`/ops/work-orders/${w.id}/status`, { status }).then(() => { toast('Updated'); return load(); }); }
    formDialog('Complete work order', h('div', { class: 'form' },
      field('What was done', h('textarea', { name: 'resolution', rows: 3, required: true, maxlength: 500 })),
      field('Labor (hours)', input({ name: 'labor_hours', type: 'number', step: '0.25', min: '0' })),
      field('Parts used', input({ name: 'parts_note', maxlength: 255 }))), async (fd) => {
      await post(`/ops/work-orders/${w.id}/status`, { status: 'done', resolution: val(fd, 'resolution'), labor_hours: num(fd, 'labor_hours'), parts_note: val(fd, 'parts_note') });
      toast('Work order completed');
      await load();
    }, { submitText: 'Complete' });
    return Promise.resolve();
  }
  await load();
  // #/conditions/wo/12 (a shared link): open that work order
  if (openId === 'new') add();
  else if (openId) detail(openId).catch((err) => toast(err.message || 'Could not open that work order', 'error'));
}

// ---------------------------------------------------------------- lift inspections
async function drawChecks(box) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Date' });
  const body = h('div');
  clear(box).append(h('header', null, h('h2', null, 'Lift inspections'), field('Date', date)),
    h('p', { class: 'muted small' }, 'Walk each lift before it opens. A failed item opens a work order and the lift cannot be set to open until a new inspection passes.'), body);
  const meta = await get('/ops/meta');
  async function load() {
    const { data } = await get(`/ops/lift-checks/day?date=${date.value}`);
    clear(body);
    if (!data.length) { body.append(empty('No lifts yet. Add them on the Status tab.')); return; }
    body.append(table([
      { head: 'Lift', cell: (r) => h('strong', null, r.name) },
      { head: 'Lift status', cell: (r) => label(r.status) },
      { head: 'Inspection', cell: (r) => (r.result ? state(r.result === 'pass' ? 'Passed' : 'Failed', r.result === 'pass' ? 'good' : 'bad') : state('Not done', 'warn')) },
      { head: 'By', cell: (r) => (r.inspector ? `${r.inspector}, ${fmtDateTime(r.checked_at)}` : '') },
      { head: '', cell: (r) => h('span', { class: 'row' }, button(r.result ? 'Inspect again' : 'Inspect', () => inspect(r), { small: true, kind: r.result ? null : 'primary' }), button('History', () => history(r), { small: true })) },
    ], data));
  }
  function inspect(r) {
    const rows = meta.lift_checklist.map((i) => {
      const result = select([['pass', 'Pass'], ['fail', 'Fail'], ['na', 'Not applicable']], 'pass', { name: `r_${i.key}`, 'aria-label': i.label });
      const note = input({ name: `n_${i.key}`, maxlength: 255, placeholder: 'What is wrong', hidden: true });
      result.addEventListener('change', () => { note.hidden = result.value !== 'fail'; if (!note.hidden) note.focus(); });
      return h('div', { class: 'chk-row' }, h('span', null, i.label), result, note);
    });
    formDialog(`Inspect ${r.name}`, h('div', { class: 'stack' }, ...rows, field('Inspector', input({ name: 'inspector', maxlength: 100, placeholder: 'Defaults to you' })), field('Note', input({ name: 'note', maxlength: 500 }))), async (fd) => {
      const items = meta.lift_checklist.map((i) => ({ key: i.key, result: fd.get(`r_${i.key}`), note: val(fd, `n_${i.key}`) }));
      const out = await post('/ops/lift-checks', { lift_id: r.lift_id, check_date: date.value, items, inspector: val(fd, 'inspector'), note: val(fd, 'note') });
      toast(out.result === 'pass' ? 'Inspection passed' : 'Inspection failed. A work order was opened.', out.result === 'pass' ? 'ok' : 'error');
      await load();
    }, { submitText: 'Save inspection', wide: true });
  }
  async function history(r) {
    const { data } = await get(`/ops/lift-checks?lift_id=${r.lift_id}&limit=30`);
    formDialog(`${r.name} inspections`, data.length ? table([
      { head: 'Date', cell: (c) => fmtDate(c.check_date) },
      { head: 'Result', cell: (c) => state(c.result === 'pass' ? 'Passed' : 'Failed', c.result === 'pass' ? 'good' : 'bad') },
      { head: 'By', cell: (c) => c.inspector || '' },
      { head: 'Problems', cell: (c) => c.items.filter((i) => i.result === 'fail').map((i) => `${i.label}: ${i.note}`).join('; ') },
    ], data) : empty('No inspections yet.'), async () => {}, { submitText: 'Close', wide: true });
  }
  date.addEventListener('change', () => date.value && load());
  await load();
}

// ---------------------------------------------------------------- recurring jobs
async function drawPm(box) {
  const [{ data }, assets, lifts] = await Promise.all([get('/ops/pm'), get('/ops/assets'), get('/schedule/lifts?limit=500')]);
  clear(box).append(h('header', null, h('h2', null, 'Recurring jobs'), button('Add a recurring job', () => add(), { small: true })));
  if (!data.length) { box.append(empty('No recurring jobs yet. Add oil changes, annual lift work, rope checks and the like.')); return; }
  box.append(table([
    { head: 'Job', cell: (t) => h('span', { class: 'stack tight' }, h('strong', null, t.name), h('span', { class: 'muted small' }, [t.lift, t.asset].filter(Boolean).join(', '))) },
    { head: 'Every', cell: (t) => [t.interval_days ? `${t.interval_days} days` : null, t.interval_hours ? `${Number(t.interval_hours)} hours` : null].filter(Boolean).join(' or ') },
    { head: 'Last done', cell: (t) => (t.last_done_on ? fmtDate(t.last_done_on) : 'Never') },
    { head: 'Next', cell: (t) => [t.due_on ? fmtDate(t.due_on) : null, t.hours_left !== null ? `${t.hours_left} h left` : null].filter(Boolean).join(', ') },
    { head: 'Status', cell: (t) => state(PM_TEXT[t.state], PM_TONE[t.state]) },
    { head: '', cell: (t) => h('span', { class: 'row' },
      button('Mark done', () => done(t), { small: true, kind: t.state === 'overdue' ? 'primary' : null }),
      button('Make work order', async () => { await post(`/ops/pm/${t.id}/work-order`); toast('Work order created'); }, { small: true }),
      isManager() ? button('Delete', () => confirmDialog('Delete recurring job', `Remove "${t.name}" and its history?`, 'Delete', async () => { await del(`/ops/pm/${t.id}`); await drawPm(box); }, { danger: true }), { small: true }) : null) },
  ], data));
  function done(t) {
    formDialog(`Mark done: ${t.name}`, h('div', { class: 'form' },
      field('Date', input({ name: 'done_on', type: 'date', value: todayStr() })),
      t.asset ? field('Machine hours', input({ name: 'hours', type: 'number', step: '0.1', min: '0', value: t.asset_hours ?? '' }), 'Defaults to the current meter') : null,
      field('Note', input({ name: 'note', maxlength: 255 }))), async (fd) => {
      await post(`/ops/pm/${t.id}/done`, { done_on: val(fd, 'done_on'), hours: num(fd, 'hours'), note: val(fd, 'note') });
      toast('Recorded');
      await drawPm(box);
    }, { submitText: 'Record' });
  }
  function add() {
    formDialog('Add a recurring job', h('div', { class: 'form' },
      field('Job', input({ name: 'name', required: true, maxlength: 150, placeholder: 'Groomer oil change' })),
      field('Lift', select([['', 'None'], ...lifts.data.map((l) => [l.id, l.name])], '', { name: 'lift_id' })),
      field('Machine', select([['', 'None'], ...assets.data.map((a) => [a.id, a.name])], '', { name: 'asset_id' })),
      field('Every (days)', input({ name: 'interval_days', type: 'number', min: '1' })),
      field('Every (machine hours)', input({ name: 'interval_hours', type: 'number', min: '1' }), 'Needs a machine'),
      field('Notes', input({ name: 'notes', maxlength: 500 }))), async (fd) => {
      await post('/ops/pm', { name: val(fd, 'name'), lift_id: num(fd, 'lift_id'), asset_id: num(fd, 'asset_id'), interval_days: num(fd, 'interval_days'), interval_hours: num(fd, 'interval_hours'), notes: val(fd, 'notes') });
      await drawPm(box);
    }, { submitText: 'Add job' });
  }
}

// ---------------------------------------------------------------- fleet
async function drawFleet(box) {
  const [{ data }, meta] = await Promise.all([get('/ops/assets'), get('/ops/meta')]);
  clear(box).append(h('header', null, h('h2', null, 'Vehicles and equipment'), button('Add equipment', () => edit(), { small: true })));
  // With the Assets and fleet add-on, the full record (meters, fuel, inspections, parts, costs, QR tags) lives there.
  if (ctx.me && ctx.me.modules && ctx.me.modules.includes('assets')) box.append(h('p', { class: 'note-box' }, 'Full records for each machine (meters, fuel, inspections, parts, costs and QR tags) are in ', h('a', { href: '#/assets/register' }, 'Assets and fleet'), '.'));
  if (!data.length) { box.append(empty('No equipment yet. Add your groomers, snowmobiles and trucks.')); return; }
  box.append(table([
    { head: 'Name', cell: (a) => h('span', { class: 'stack tight' }, h('strong', null, a.name), h('span', { class: 'muted small' }, a.make_model || '')) },
    { head: 'Type', cell: (a) => (meta.asset_kinds.find((k) => k.value === a.kind) || {}).label || label(a.kind) },
    { head: 'Hours', cell: (a) => Number(a.hours).toLocaleString() },
    { head: 'Status', cell: (a) => state(label(a.status), a.status === 'in_service' ? 'good' : a.status === 'needs_service' ? 'warn' : 'bad') },
    { head: 'Open jobs', cell: (a) => a.open_orders || '' },
    { head: '', cell: (a) => h('span', { class: 'row' }, button('Meter', () => meter(a), { small: true }), button('Edit', () => edit(a), { small: true })) },
  ], data));
  function meter(a) {
    formDialog(`${a.name} hour meter`, h('div', { class: 'form' }, field('Reading', input({ name: 'hours', type: 'number', step: '0.1', min: String(a.hours), value: a.hours, required: true }), 'The meter only goes up')), async (fd) => {
      await post(`/ops/assets/${a.id}/hours`, { hours: num(fd, 'hours') });
      await drawFleet(box);
    }, { submitText: 'Save reading' });
  }
  function edit(a) {
    formDialog(a ? `Edit ${a.name}` : 'Add equipment', h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: a ? a.name : '' })),
      field('Type', select(meta.asset_kinds.map((k) => [k.value, k.label]), a ? a.kind : 'groomer', { name: 'kind' })),
      field('Make and model', input({ name: 'make_model', maxlength: 100, value: a ? a.make_model || '' : '' })),
      field('Serial number', input({ name: 'serial', maxlength: 80, value: a ? a.serial || '' : '' })),
      a ? null : field('Hours now', input({ name: 'hours', type: 'number', step: '0.1', min: '0', value: '0' })),
      field('Status', select([['in_service', 'In service'], ['needs_service', 'Needs service'], ['out_of_service', 'Out of service'], ['retired', 'Retired']], a ? a.status : 'in_service', { name: 'status' })),
      field('Notes', input({ name: 'notes', maxlength: 500, value: a ? a.notes || '' : '' }))), async (fd) => {
      const b = { name: val(fd, 'name'), kind: val(fd, 'kind'), make_model: val(fd, 'make_model'), serial: val(fd, 'serial'), status: val(fd, 'status'), notes: val(fd, 'notes') };
      if (a) await patch(`/ops/assets/${a.id}`, b); else await post('/ops/assets', { ...b, hours: num(fd, 'hours') || 0 });
      await drawFleet(box);
    }, { submitText: 'Save' });
  }
}
