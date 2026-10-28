import { get, post, del } from '../api.js';
import { h, clear, isManager, table, state, tabs, input, select, field, button, toast, formDialog, val, num, todayStr, addDays, fmtDate, fmtDateTime, empty, label } from '../ui.js';

export async function drawReports(root) {
  root.append(tabs([
    ['report', 'Daily report', drawDaily],
    ['downtime', 'Lift downtime', drawDowntime],
    ['handoff', 'Handoff notes', drawHandoffs],
  ], 'report', { param: 'sub' })); // inside Mountain status's Reports tab
}

// ---------------------------------------------------------------- daily report
async function drawDaily(box) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Report date' });
  const body = h('div', { class: 'stack' });
  clear(box).append(h('header', null, h('h2', null, 'Daily mountain report'), h('div', { class: 'row' }, button('Back', () => { date.value = addDays(date.value, -1); return load(); }, { small: true }), date, button('Next', () => { date.value = addDays(date.value, 1); return load(); }, { small: true }))), body);
  async function load() {
    const r = await get(`/ops/report?date=${date.value}`);
    clear(body);
    const stat = (big, small) => h('div', { class: 'stat' }, h('strong', null, big), h('span', null, small));
    body.append(h('div', { class: 'stats' },
      stat(r.live ? `${r.lifts_open}/${r.lifts_total}` : r.lifts_total, r.live ? 'lifts open' : 'lifts'),
      stat(r.live ? `${r.trails_open}/${r.trails_total}` : r.trails_total, r.live ? 'trails open' : 'trails'),
      stat(`${r.grooming.done}/${r.grooming.planned}`, 'trails groomed'),
      stat(r.snow && r.snow.base_in !== null ? `${r.snow.base_in} in` : 'none', 'base depth'),
      stat(r.weather && r.weather.high_f !== null ? `${r.weather.high_f}°F` : 'none', 'high'),
      stat(r.maintenance.open_orders, 'open work orders')));
    const flags = [];
    if (r.maintenance.failed_inspections.length) flags.push(state(`Failed inspection: ${r.maintenance.failed_inspections.join(', ')}`, 'bad'));
    if (r.maintenance.pm_overdue) flags.push(state(`${r.maintenance.pm_overdue} recurring job${r.maintenance.pm_overdue === 1 ? '' : 's'} overdue`, 'warn'));
    const noInspect = r.lifts.filter((l) => !l.inspection);
    if (r.live && noInspect.length) flags.push(state(`Not inspected: ${noInspect.map((l) => l.name).join(', ')}`, 'warn'));
    if (flags.length) body.append(h('div', { class: 'row wrap' }, ...flags));
    body.append(table([
      { head: 'Lift', cell: (l) => h('strong', null, l.name) },
      { head: 'Status now', cell: (l) => label(l.status) },
      { head: 'Down', cell: (l) => (l.down_minutes ? `${Math.floor(l.down_minutes / 60)} h ${l.down_minutes % 60} m` : '') },
      { head: 'Inspection', cell: (l) => (l.inspection ? state(l.inspection === 'pass' ? 'Passed' : 'Failed', l.inspection === 'pass' ? 'good' : 'bad') : '') },
    ], r.lifts));
    const text = h('textarea', { rows: 8, readonly: true, 'aria-label': 'Report text' }, r.text);
    body.append(h('div', { class: 'stack tight' }, h('h3', null, 'Text to share'), text, h('div', { class: 'row' },
      button('Copy text', async () => { try { await navigator.clipboard.writeText(r.text); toast('Copied'); } catch (_) { text.select(); toast('Select and copy the text'); } }, { small: true, kind: 'primary' }),
      button('Print', () => window.print(), { small: true }))));
  }
  date.addEventListener('change', () => date.value && load());
  await load();
}

// ---------------------------------------------------------------- downtime
async function drawDowntime(box) {
  const [{ data }, sum, meta, lifts] = await Promise.all([get('/ops/downtime'), get('/ops/downtime/summary'), get('/ops/meta'), get('/schedule/lifts?limit=500')]);
  const reason = (v) => (meta.downtime_reasons.find((r) => r.value === v) || {}).label || label(v);
  const mins = (m) => (m === null || m === undefined ? '' : `${Math.floor(m / 60)} h ${m % 60} m`);
  clear(box).append(h('header', null, h('h2', null, 'Lift downtime'), button('Log downtime', () => add(), { small: true })),
    h('p', { class: 'muted small' }, `Changing a lift's status on the Status tab logs downtime automatically. Last 30 days (${fmtDate(sum.from)} to ${fmtDate(sum.to)}):`));
  if (sum.by_lift.length) box.append(table([{ head: 'Lift', cell: (r) => r.lift }, { head: 'Stops', cell: (r) => r.events }, { head: 'Time down', cell: (r) => mins(r.minutes) }], sum.by_lift));
  box.append(h('h3', null, 'Recent'));
  if (!data.length) { box.append(empty('No downtime logged.')); return; }
  box.append(table([
    { head: 'Lift', cell: (r) => h('strong', null, r.lift) },
    { head: 'Stopped', cell: (r) => fmtDateTime(r.started_at) },
    { head: 'Restarted', cell: (r) => (r.ended_at ? fmtDateTime(r.ended_at) : state('Still down', 'bad')) },
    { head: 'Time', cell: (r) => mins(r.minutes) },
    { head: 'Reason', cell: (r) => reason(r.reason) },
    { head: 'Note', cell: (r) => r.note || '' },
    { head: '', cell: (r) => (isManager() ? button('Delete', async () => { await del(`/ops/downtime/${r.id}`); await drawDowntime(box); }, { small: true }) : '') },
  ], data));
  function add() {
    formDialog('Log lift downtime', h('div', { class: 'form' },
      field('Lift', select(lifts.data.map((l) => [l.id, l.name]), '', { name: 'lift_id' })),
      field('Stopped', input({ name: 'started_at', type: 'datetime-local', required: true })),
      field('Restarted', input({ name: 'ended_at', type: 'datetime-local' }), 'Leave blank if still down'),
      field('Reason', select(meta.downtime_reasons.map((r) => [r.value, r.label]), 'mechanical', { name: 'reason' })),
      field('Note', input({ name: 'note', maxlength: 255 }))), async (fd) => {
      await post('/ops/downtime', { lift_id: num(fd, 'lift_id'), started_at: val(fd, 'started_at'), ended_at: val(fd, 'ended_at'), reason: val(fd, 'reason'), note: val(fd, 'note') });
      await drawDowntime(box);
    }, { submitText: 'Save' });
  }
}

// ---------------------------------------------------------------- handoffs
async function drawHandoffs(box) {
  const [{ data }, meta] = await Promise.all([get('/ops/handoffs'), get('/ops/meta')]);
  clear(box).append(h('header', null, h('h2', null, 'Shift handoff notes'), button('Write a note', () => add(), { small: true })),
    h('p', { class: 'muted small' }, 'What the next crew needs to know. Showing the last three days.'));
  if (!data.length) { box.append(empty('No notes. Leave one when you hand off a shift.')); return; }
  const dept = (v) => (meta.departments.find((d) => d.value === v) || {}).label || label(v);
  box.append(h('ul', { class: 'handoffs' }, ...data.map((n) => h('li', { class: n.ack_at ? 'acked' : '' },
    h('div', { class: 'row' }, state(dept(n.dept), 'neutral'), h('span', { class: 'muted small' }, `${fmtDate(n.shift_date)}, ${n.shift} shift, ${n.author || 'unknown'}`)),
    h('p', null, n.body),
    h('div', { class: 'row' },
      n.ack_at ? h('span', { class: 'muted small' }, `Read by ${n.ack_by || 'someone'}`) : button('Got it', async () => { await post(`/ops/handoffs/${n.id}/ack`); await drawHandoffs(box); }, { small: true }),
      isManager() ? button('Delete', async () => { await del(`/ops/handoffs/${n.id}`); await drawHandoffs(box); }, { small: true }) : null)))));
  function add() {
    formDialog('Write a handoff note', h('div', { class: 'form' },
      field('Department', select(meta.departments.map((d) => [d.value, d.label]), 'general', { name: 'dept' })),
      field('Shift', select([['day', 'Day'], ['night', 'Night']], 'day', { name: 'shift' })),
      field('Note', h('textarea', { name: 'body', rows: 4, required: true, maxlength: 2000 }))), async (fd) => {
      await post('/ops/handoffs', { dept: val(fd, 'dept'), shift: val(fd, 'shift'), body: val(fd, 'body') });
      await drawHandoffs(box);
    }, { submitText: 'Post note' });
  }
}
