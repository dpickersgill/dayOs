import { get, post, patch, del } from '../api.js';
import { h, clear, isManager, table, state, input, select, field, button, toast, formDialog, confirmDialog, val, num, todayStr, addDays, fmtDate, fmtTime, trailMark, empty, errorBox, fail, label } from '../ui.js';

const PLAN_TONE = { planned: 'neutral', in_progress: 'warn', done: 'good', skipped: 'bad' };
const PLAN_TEXT = { planned: 'Planned', in_progress: 'Grooming now', done: 'Done', skipped: 'Skipped' };

/** The grooming tab: the plan for a night or day, with start and finish marks, then snowmaking. */
export async function drawGrooming(root) {
  const plan = h('section', { class: 'section' });
  const making = h('section', { class: 'section' });
  root.append(plan, making);
  await Promise.all([drawPlan(plan), drawSnowmaking(making)]);
}

async function drawPlan(box) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Plan date' });
  const shift = select([['night', 'Night grooming'], ['day', 'Day grooming']], 'night', { 'aria-label': 'Shift' });
  const body = h('div', { class: 'stack' });
  const head = h('header', null, h('h2', null, 'Grooming plan'), h('div', { class: 'row' },
    button('Back', () => { date.value = addDays(date.value, -1); return load(); }, { small: true }), date,
    button('Next', () => { date.value = addDays(date.value, 1); return load(); }, { small: true }), shift));
  clear(box).append(head, body);
  let assets = [];

  async function load() {
    const [{ data }, a] = await Promise.all([get(`/ops/groom/plan?date=${date.value}&shift=${shift.value}`), get('/ops/assets?kind=groomer')]);
    assets = a.data;
    clear(body);
    const done = data.filter((r) => r.status === 'done').length;
    body.append(h('div', { class: 'row' },
      h('p', { class: 'muted' }, data.length ? `${done} of ${data.length} trails done` : 'Nothing planned for this shift yet.'),
      h('div', { class: 'row grow-end' },
        button('Add trail', () => addTrail(), { small: true }),
        button('Add every trail', () => fill(true), { small: true }),
        button('Add trails not groomed', () => fill(false), { small: true }),
        isManager() ? button('Clear groomed marks', () => clearMarks(), { small: true }) : null)));
    if (!data.length) return;
    body.append(table([
      { head: 'Trail', cell: (r) => h('span', { class: 'stack tight' }, h('strong', null, r.trail), trailMark(r.difficulty)) },
      { head: 'Machine', cell: (r) => machinePick(r) },
      { head: 'Status', cell: (r) => h('span', { class: 'stack tight' }, state(PLAN_TEXT[r.status], PLAN_TONE[r.status]),
        r.finished_at ? h('span', { class: 'muted small' }, `${fmtTime(r.started_at)} to ${fmtTime(r.finished_at)}${r.machine_hours ? `, ${Number(r.machine_hours)} h` : ''}`) : r.started_at ? h('span', { class: 'muted small' }, `Since ${fmtTime(r.started_at)}`) : null,
        r.note ? h('span', { class: 'muted small' }, r.note) : null) },
      { head: '', cell: (r) => h('span', { class: 'row' }, ...actions(r)) },
    ], data));
  }

  function machinePick(r) {
    const sel = select([['', 'No machine'], ...assets.map((a) => [a.id, `${a.name}${a.status !== 'in_service' ? ` (${label(a.status).toLowerCase()})` : ''}`])], r.asset_id || '', { 'aria-label': `Machine for ${r.trail}`, disabled: r.status === 'done' });
    sel.addEventListener('change', async () => { try { await patch(`/ops/groom/plan/${r.id}`, { asset_id: sel.value ? Number(sel.value) : null }); } catch (e) { fail(e); await load(); } });
    return sel;
  }

  function actions(r) {
    const out = [];
    if (r.status === 'planned') out.push(button('Start', async () => { await post(`/ops/groom/plan/${r.id}/start`); await load(); }, { small: true, kind: 'primary' }));
    if (r.status === 'in_progress') out.push(button('Finish', () => finish(r), { small: true, kind: 'primary' }));
    if (r.status === 'planned' || r.status === 'in_progress') out.push(button('Skip', () => skip(r), { small: true }));
    if (r.status === 'done' || r.status === 'skipped') out.push(button('Reopen', async () => { await post(`/ops/groom/plan/${r.id}/reopen`); await load(); }, { small: true }));
    if (r.status !== 'done') out.push(button('Remove', async () => { await del(`/ops/groom/plan/${r.id}`); await load(); }, { small: true }));
    return out;
  }

  function finish(r) {
    formDialog(`Finish ${r.trail}`, h('div', { class: 'form' },
      field('Machine hours used', input({ name: 'machine_hours', type: 'number', step: '0.1', min: '0', max: '99' })),
      field('Fuel used (gallons)', input({ name: 'fuel_gal', type: 'number', step: '0.1', min: '0', max: '999' }))), async (fd) => {
      await post(`/ops/groom/plan/${r.id}/finish`, { machine_hours: num(fd, 'machine_hours'), fuel_gal: num(fd, 'fuel_gal') });
      toast(`${r.trail} marked groomed`);
      await load();
    }, { submitText: 'Mark groomed' });
  }
  function skip(r) {
    formDialog(`Skip ${r.trail}`, h('div', { class: 'form' }, field('Why', input({ name: 'note', maxlength: 255, placeholder: 'Not enough snow, machine down' }))), async (fd) => {
      await post(`/ops/groom/plan/${r.id}/skip`, { note: val(fd, 'note') });
      await load();
    }, { submitText: 'Skip trail' });
  }
  async function fill(all) {
    const r = await post('/ops/groom/plan/fill', { plan_date: date.value, shift: shift.value, all });
    toast(r.added ? `${r.added} trail${r.added === 1 ? '' : 's'} added` : 'Nothing to add');
    await load();
  }
  function clearMarks() {
    confirmDialog('Clear groomed marks', 'This marks every trail as not groomed, ready for tonight. Do it after the morning report.', 'Clear marks', async () => {
      const r = await post('/ops/groom/clear-marks');
      toast(`${r.cleared} trails cleared`);
      await load();
    });
  }
  async function addTrail() {
    const { data } = await get('/schedule/trails?limit=500');
    formDialog('Add a trail to the plan', h('div', { class: 'form' },
      field('Trail', select(data.map((t) => [t.id, t.name]), '', { name: 'trail_id' })),
      field('Priority', input({ name: 'priority', type: 'number', min: '1', max: '99', value: '5' }), '1 is groomed first')), async (fd) => {
      await post('/ops/groom/plan', { plan_date: date.value, shift: shift.value, trail_id: num(fd, 'trail_id'), priority: num(fd, 'priority') || 5 });
      await load();
    }, { submitText: 'Add to plan' });
  }

  date.addEventListener('change', () => date.value && load().catch((e) => clear(body).append(errorBox(e))));
  shift.addEventListener('change', () => load().catch((e) => clear(body).append(errorBox(e))));
  await load();
}

// ---------------------------------------------------------------- snowmaking
async function drawSnowmaking(box) {
  async function load() {
    const { data } = await get('/ops/snowmaking?limit=30');
    clear(box).append(h('header', null, h('h2', null, 'Snowmaking'), button('Start snowmaking', () => start(), { small: true })));
    if (!data.length) { box.append(empty('No snowmaking logged yet.')); return; }
    box.append(table([
      { head: 'Trail', cell: (r) => h('strong', null, r.trail) },
      { head: 'Started', cell: (r) => `${fmtDate(r.started_at)}, ${fmtTime(r.started_at)}` },
      { head: 'Running', cell: (r) => r.ended_at ? state('Stopped', 'neutral') : state('Running', 'good') },
      { head: 'Guns', cell: (r) => r.guns ?? '' },
      { head: 'Temp', cell: (r) => (r.temp_f === null ? '' : `${Number(r.temp_f)}°F`) },
      { head: 'Water', cell: (r) => (r.water_gal ? `${Number(r.water_gal).toLocaleString()} gal` : '') },
      { head: '', cell: (r) => (r.ended_at ? '' : button('Stop', () => stop(r), { small: true })) },
    ], data));
  }
  async function start() {
    const { data } = await get('/schedule/trails?limit=500');
    formDialog('Start snowmaking', h('div', { class: 'form' },
      field('Trail', select(data.map((t) => [t.id, t.name]), '', { name: 'trail_id' })),
      field('Guns running', input({ name: 'guns', type: 'number', min: '0', max: '500' })),
      field('Air temperature (°F)', input({ name: 'temp_f', type: 'number', step: '0.5', min: '-80', max: '130' }))), async (fd) => {
      await post('/ops/snowmaking', { trail_id: num(fd, 'trail_id'), guns: num(fd, 'guns'), temp_f: num(fd, 'temp_f') });
      await load();
    }, { submitText: 'Start' });
  }
  function stop(r) {
    formDialog(`Stop snowmaking on ${r.trail}`, h('div', { class: 'form' }, field('Water used (gallons)', input({ name: 'water_gal', type: 'number', min: '0' }))), async (fd) => {
      await post(`/ops/snowmaking/${r.id}/stop`, { water_gal: num(fd, 'water_gal') });
      await load();
    }, { submitText: 'Stop' });
  }
  await load();
}
