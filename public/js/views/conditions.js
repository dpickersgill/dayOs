import { get, put, patch, post } from '../api.js';
import { h, clear, ctx, can, isManager, tabs, table, state, trailMark, input, select, field, button, toast, formDialog, val, todayStr, label, empty, errorBox, fail } from '../ui.js';

const LIFT_STATES = [['open', 'Open', 'good'], ['hold', 'On hold', 'warn'], ['wind_hold', 'Wind hold', 'warn'], ['closed', 'Closed', 'bad']];
const TRAIL_STATES = [['open', 'Open', 'good'], ['closed', 'Closed', 'bad']];
const DIFFICULTY = [['green', 'Easy'], ['blue', 'Intermediate'], ['black', 'Advanced'], ['double_black', 'Expert'], ['park', 'Terrain park']];

export async function render(root, params = []) {
  const canSet = can('patrol', 'staff');
  const openOrder = params[0] === 'wo' && /^\d+$/.test(params[1] || '') ? Number(params[1]) : null;
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Mountain status'),
    h('p', { class: 'page-note' }, canSet ? 'Status, grooming, snow, maintenance and the daily report. Status changes show on your public conditions feed within a minute.' : 'You can see status here. Patrol and managers change it.')));
  if (!canSet) { await drawStatus(root, false); return; }
  root.append(tabs([
    ['status', 'Status', (box) => drawStatus(box, true)],
    ['grooming', 'Grooming', async (box) => (await import('./ops-groom.js')).drawGrooming(box)],
    ['snow', 'Snow and weather', async (box) => (await import('./ops-weather.js')).drawSnowWeather(box)],
    ['maint', 'Maintenance', async (box) => (await import('./ops-maint.js')).drawMaintenance(box, { openOrder })],
    ['reports', 'Reports', async (box) => (await import('./ops-reports.js')).drawReports(box)],
  ], openOrder ? 'maint' : 'status'));
}

async function drawStatus(root, canSet) {
  const day = h('section', { class: 'section' });
  const lifts = h('section', { class: 'section' });
  const trails = h('section', { class: 'section' });
  root.append(day, lifts, trails);
  await Promise.all([drawDay(day), drawLifts(lifts, canSet), drawTrails(trails, canSet)]);
  if (isManager()) {
    root.append(h('p', { class: 'muted small' }, `Public feed for your website: /api/v1/public/${ctx.me.tenant}/conditions`));
  }
}

// ---------------------------------------------------------------- operating day
async function drawDay(box) {
  const date = input({ type: 'date', value: todayStr() });
  const body = h('div', { class: 'stack' });
  clear(box).append(h('header', null, h('h2', null, 'Operating day'), isManager() ? field('Date', date) : null), body);

  async function load() {
    const { data } = await get(`/schedule/days?from=${date.value}&to=${date.value}`);
    const d = data[0];
    clear(body);
    body.append(h('div', { class: 'row' },
      d ? state(label(d.status), d.status === 'open' ? 'good' : d.status === 'limited' ? 'warn' : 'bad') : state('Not set for this date', 'neutral'),
      d && d.open_time ? h('span', null, `${d.open_time.slice(0, 5)} to ${(d.close_time || '').slice(0, 5)}`) : null,
      d && d.notes ? h('span', { class: 'muted' }, d.notes) : null));
    if (isManager()) {
      const st = select([['open', 'Open'], ['limited', 'Limited terrain'], ['closed', 'Closed']], d ? d.status : 'open', { name: 'status' });
      const o = input({ type: 'time', name: 'open_time', value: d && d.open_time ? d.open_time.slice(0, 5) : '09:00' });
      const c = input({ type: 'time', name: 'close_time', value: d && d.close_time ? d.close_time.slice(0, 5) : '16:00' });
      const n = input({ name: 'notes', maxlength: 500, value: d && d.notes ? d.notes : '', placeholder: 'Shown to guests, such as "Night skiing until 9"' });
      const save = button('Save day', async () => {
        await put(`/schedule/days/${date.value}`, { status: st.value, open_time: st.value === 'closed' ? null : o.value, close_time: st.value === 'closed' ? null : c.value, notes: n.value.trim() || null });
        toast('Day saved');
        await load();
      }, { kind: 'primary' });
      body.append(h('div', { class: 'form' }, field('Status', st), field('Opens', o), field('Closes', c), field('Note for guests', n)), h('div', { class: 'row' }, save));
    }
  }
  date.addEventListener('change', () => date.value && load().catch((e) => clear(body).append(errorBox(e))));
  await load();
}

// ---------------------------------------------------------------- segmented control
function segmented(states, current, enabled, onPick) {
  const wrap = h('div', { class: 'seg', role: 'group' });
  for (const [value, text, tone] of states) {
    const b = h('button', { type: 'button', 'aria-pressed': String(value === current), dataset: { tone }, disabled: !enabled }, text);
    b.addEventListener('click', async () => {
      if (value === current) return;
      b.disabled = true;
      try {
        await onPick(value);
        current = value;
        for (const x of wrap.children) x.setAttribute('aria-pressed', String(x.textContent === text));
      } catch (err) {
        toast(err.message || 'Could not change status', 'error');
      } finally {
        b.disabled = !enabled;
      }
    });
    wrap.append(b);
  }
  return wrap;
}

// ---------------------------------------------------------------- lifts
async function drawLifts(box, canSet) {
  const { data } = await get('/schedule/lifts?limit=500');
  clear(box).append(h('header', null, h('h2', null, `Lifts (${data.filter((l) => l.status === 'open').length} of ${data.length} open)`),
    isManager() ? button('Add lift', () => addLift(() => drawLifts(box, canSet)), { small: true }) : null));
  if (!data.length) { box.append(empty('No lifts yet.')); return; }
  box.append(table([
    { head: 'Lift', cell: (l) => h('strong', null, l.name) },
    { head: 'Status', cell: (l) => segmented(LIFT_STATES, l.status, canSet, (v) => patch(`/schedule/lifts/${l.id}`, { status: v })) },
  ], data));
}
function addLift(done) {
  formDialog('Add a lift', h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 100 }))), async (fd) => {
    await post('/schedule/lifts', { name: val(fd, 'name') });
    toast('Lift added');
    await done();
  }, { submitText: 'Add lift' });
}

// ---------------------------------------------------------------- trails
async function drawTrails(box, canSet) {
  const { data } = await get('/schedule/trails?limit=500');
  clear(box).append(h('header', null, h('h2', null, `Trails (${data.filter((t) => t.status === 'open').length} of ${data.length} open)`),
    isManager() ? button('Add trail', () => addTrail(() => drawTrails(box, canSet)), { small: true }) : null));
  if (!data.length) { box.append(empty('No trails yet.')); return; }
  const order = DIFFICULTY.map((d) => d[0]);
  data.sort((a, b) => order.indexOf(a.difficulty) - order.indexOf(b.difficulty) || a.name.localeCompare(b.name));
  box.append(table([
    { head: 'Trail', cell: (t) => h('strong', null, t.name) },
    { head: 'Difficulty', cell: (t) => trailMark(t.difficulty) },
    { head: 'Status', cell: (t) => segmented(TRAIL_STATES, t.status, canSet, (v) => patch(`/schedule/trails/${t.id}`, { status: v })) },
    { head: 'Groomed', cell: (t) => {
      const cb = h('input', { type: 'checkbox', checked: Boolean(t.groomed), disabled: !canSet, 'aria-label': `${t.name} groomed` });
      cb.addEventListener('change', async () => {
        try { await patch(`/schedule/trails/${t.id}`, { groomed: cb.checked ? 1 : 0 }); } catch (err) { cb.checked = !cb.checked; fail(err); }
      });
      return cb;
    } },
  ], data));
}
function addTrail(done) {
  formDialog('Add a trail', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100 })),
    field('Difficulty', select(DIFFICULTY, 'blue', { name: 'difficulty' }))), async (fd) => {
    await post('/schedule/trails', { name: val(fd, 'name'), difficulty: val(fd, 'difficulty') });
    toast('Trail added');
    await done();
  }, { submitText: 'Add trail' });
}
