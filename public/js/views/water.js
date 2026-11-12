// Water (release 2026.11.20, the Water add-on): main breaks. A break is recorded on its water main: when and where, the
// cause, the pipe, the valves operated to shut it down (the mapped valves within 150 m are offered, those on the main or
// the street first), customers out, boil water and its notice, and the repair. Recording one opens an urgent work order
// on the main, where the crew, equipment and materials are its cost. Each main keeps its break history, and more than 2
// breaks in 5 years raises its condition. People decide on a boil water advisory; the app records it.
//   #/water                     the breaks, and the mains by breaks in the last 5 years
//   #/water?new=1&main=12       a new break on main 12 (from the map's panel)
//   #/water?break=4             one break
import { get, post, patch, del, download } from '../api.js';
import { h, clear, appendAll, button, field, input, select, state, table, toast, fail, formDialog, confirmDialog, dialog, empty, tabs, hashParam, isManager, val, num, fmtDateTime as fmtDateTimeShort, fmtDay, fmtTime, todayStr, nowInput } from '../ui.js';
import { featurePicker } from './utility-bits.js';
import { riskState } from './asset-bits.js';

// A break in another year shows its year (a main's history goes back years): "Sat, Nov 12, 2022, 4:20 AM ET" (2026.11.20).
const fmtDateTime = (s) => (s && String(s).slice(0, 4) !== todayStr().slice(0, 4) ? `${fmtDay(s)}, ${fmtTime(s)}` : fmtDateTimeShort(s));

let CAUSES = [];
const causeWords = (k) => (CAUSES.find((c) => c.value === k) || { label: k }).label;
const local = (s) => (s ? String(s).replace(' ', 'T').slice(0, 16) : '');

export async function render(root) {
  let reload = async () => {};
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Water'), h('p', { class: 'muted' }, 'Main breaks: the valves shut, customers out, boil water, the repair, and each main’s break history.')),
    h('div', { class: 'actions' }, button('Record a main break', () => breakForm(null, () => reload()), { kind: 'primary', small: true }))));
  root.append(tabs([
    ['breaks', 'Main breaks', async (box) => { reload = () => drawBreaks(box); await drawBreaks(box); }],
    ['mains', 'Mains', async (box) => { reload = () => drawMains(box); await drawMains(box); }],
  ], hashParam('tab') || 'breaks'));
  const id = Number(hashParam('break'));
  if (id) openBreak(id, () => reload()).catch(fail);
  if (hashParam('new') === '1') {
    const mainId = Number(hashParam('main'));
    const main = mainId ? await get(`/assets/map/features/${mainId}`).catch(() => null) : null;
    breakForm(main ? { main_id: main.id, main_label: [main.kind_label, main.tag, main.name].filter(Boolean).join(' '), pipe_material: main.material, pipe_size: main.size, street_id: main.street_id } : null, () => reload());
  }
}

async function drawBreaks(box) {
  const year = select([['', 'Every year'], ...Array.from({ length: 8 }, (_, i) => { const y = new Date().getFullYear() - i; return [y, String(y)]; })], '', { 'aria-label': 'Year' });
  const status = select([['', 'Open and repaired'], ['open', 'Open'], ['repaired', 'Repaired']], '', { 'aria-label': 'Status' });
  const body = h('div');
  clear(box).append(h('div', { class: 'week-filter', role: 'group', 'aria-label': 'Filters' }, year, status,
    button('Download spreadsheet', () => download('/water/main-breaks/export.csv', 'main-breaks.csv'), { small: true })), body);
  async function load() {
    const q = new URLSearchParams(); if (year.value) q.set('year', year.value); if (status.value) q.set('status', status.value);
    const r = await get(`/water/main-breaks?${q}`);
    CAUSES = r.causes;
    clear(body).append(r.data.length ? h('div', { class: 'table-scroll' }, table([
      { head: 'When', cell: (b) => fmtDateTime(b.broke_at) },
      { head: 'Main', cell: (b) => h('span', { class: 'stack tight' }, h('strong', null, b.main || 'Main'), h('span', { class: 'muted small' }, [b.location, b.street].filter(Boolean).join(', '))) },
      { head: 'Cause', cell: (b) => b.cause_words },
      { head: 'Customers out', num: true, cell: (b) => (b.customers_out === null ? '' : String(b.customers_out)) },
      { head: 'Boil water', cell: (b) => (b.boil_water ? state(b.notice ? `Yes, ${b.notice.code}` : 'Yes', 'warn') : 'No') },
      { head: 'Status', cell: (b) => (b.status === 'open' ? state('Open', 'bad') : state(`Repaired${b.hours_out !== null ? `, ${b.hours_out} h out` : ''}`, 'good')) },
      { head: '', actions: true, cell: (b) => button('Open', () => openBreak(b.id, load), { small: true, label: `Open the break of ${fmtDateTime(b.broke_at)}` }) },
    ], r.data)) : empty('No main breaks recorded. Record one from here or from a main’s panel on the map.'));
  }
  year.addEventListener('change', load); status.addEventListener('change', load);
  await load();
}

async function drawMains(box) {
  const r = await get('/water/mains');
  CAUSES = r.causes;
  clear(box).append(h('p', { class: 'muted' }, r.rule), r.data.length ? h('div', { class: 'table-scroll' }, table([
    { head: 'Main', cell: (m) => h('a', { href: `#/assets/map/f${m.id}` }, m.name) },
    { head: 'Street', cell: (m) => m.street || '' },
    { head: 'Pipe', cell: (m) => [m.size, m.material, m.installed_year].filter(Boolean).join(', ') },
    { head: 'Breaks in 5 years', num: true, cell: (m) => (m.breaks_5y > 2 ? state(String(m.breaks_5y), 'bad') : String(m.breaks_5y)) },
    { head: 'All breaks', num: true, cell: (m) => String(m.breaks) },
    { head: 'Last break', cell: (m) => (m.last_break ? fmtDateTime(m.last_break) : '') },
    { head: 'Risk', cell: (m) => riskState(m.risk) || h('span', { class: 'muted' }, 'Not scored') },
    { head: '', actions: true, cell: (m) => button('Record a break', () => breakForm({ main_id: m.id, main_label: m.name, pipe_material: m.material, pipe_size: m.size, street_id: m.street_id }, () => drawMains(box)), { small: true, label: `Record a break on ${m.name}` }) },
  ], r.data)) : empty('No water mains on the map yet. Draw them in Assets and fleet, Map, as drinking water lines.'));
}

/** The valves to shut for this main and point, as checkboxes with when each was closed and opened. */
function valvePicker(chosen = []) {
  const box = h('div', { class: 'stack tight' }, h('p', { class: 'muted small' }, 'Pick the main to see the valves near it.'));
  let rows = [];
  const el = h('fieldset', null, h('legend', null, 'Valves operated'), box);
  el.load = async (mainId, at) => {
    if (!mainId) return;
    const q = new URLSearchParams({ main_id: mainId }); if (at) { q.set('lat', at.lat); q.set('lng', at.lng); }
    let r;
    try { r = await get(`/water/main-breaks/valves?${q}`); } catch (err) { clear(box).append(h('p', { class: 'muted' }, err.message)); return; }
    el.customers = r.customers_on_street;
    const have = new Map(chosen.map((v) => [v.valve_id, v]));
    for (const v of chosen) if (!r.valves.some((x) => x.id === v.valve_id)) r.valves.push({ id: v.valve_id, tag: v.tag, name: v.name, distance_m: null });
    rows = r.valves.map((v) => {
      const c = have.get(v.id);
      const tick = h('input', { type: 'checkbox', checked: Boolean(c) });
      const closed = input({ type: 'datetime-local', value: c ? local(c.closed_at) : '', 'aria-label': `When ${v.tag || 'the valve'} was closed` });
      const opened = input({ type: 'datetime-local', value: c ? local(c.opened_at) : '', 'aria-label': `When ${v.tag || 'the valve'} was opened again` });
      const turns = input({ type: 'number', min: '0', step: '0.5', value: c && c.turns !== null ? c.turns : '', 'aria-label': `Turns on ${v.tag || 'the valve'}` });
      tick.addEventListener('change', () => { if (tick.checked && !closed.value) closed.value = nowInput(); });
      return { v, tick, closed, opened, turns };
    });
    clear(box).append(rows.length ? h('ul', { class: 'plain stack tight' }, rows.map((x) => h('li', { class: 'stack tight' },
      h('label', { class: 'check' }, x.tick, ` ${x.v.tag || x.v.name || `Valve ${x.v.id}`}`, h('span', { class: 'muted small' }, ` ${[x.v.distance_m !== null ? `${x.v.distance_m} m away` : null, x.v.on_main ? 'on this main' : x.v.same_street ? 'on the same street' : null, x.v.status && x.v.status !== 'in_service' ? x.v.status.replace(/_/g, ' ') : null].filter(Boolean).join(', ')}`)),
      h('div', { class: 'valve-times' }, h('label', null, h('span', { class: 'small' }, 'Closed'), x.closed), h('label', null, h('span', { class: 'small' }, 'Opened again'), x.opened), h('label', null, h('span', { class: 'small' }, 'Turns'), x.turns))))) : h('p', { class: 'muted' }, `No mapped valves within ${r.within_m} m. Add valves on the map, or note the valves in the notes.`));
  };
  el.value = () => rows.filter((x) => x.tick.checked).map((x) => ({ valve_id: x.v.id, closed_at: x.closed.value || null, opened_at: x.opened.value || null, turns: x.turns.value === '' ? null : Number(x.turns.value) }));
  return el;
}

/** New break (b null or a few prefilled fields), or a change to one (b from GET /main-breaks/:id). */
async function breakForm(b, done) {
  const editing = Boolean(b && b.id);
  if (!CAUSES.length) CAUSES = (await get('/water/mains')).causes;
  const notices = await get('/street-notices?status=all').then((r) => r.data.filter((n) => ['water_outage', 'boil_water'].includes(n.type))).catch(() => []);
  const valves = valvePicker(editing ? b.valve_list : []);
  let at = b && b.lat !== null && b.lat !== undefined ? { lat: b.lat, lng: b.lng } : null;
  const where = h('span', { class: 'muted small', role: 'status' }, at ? 'Break point on the map is set.' : '');
  const custHint = h('span', { class: 'hint' });
  const mainPick = featurePicker({ name: 'main_id', kinds: ['potable_line'], placeholder: 'Main tag, name or street', value: b && b.main_id ? { id: b.main_id, label: b.main_label || b.main || `Main ${b.main_id}` } : null,
    onPick: async (f) => { await valves.load(f && f.id, at); if (valves.customers) custHint.textContent = `${valves.customers} water customers on the street`; } });
  const gps = button('Use my location', () => new Promise((resolve) => {
    if (!navigator.geolocation) { where.textContent = 'This device cannot share its location.'; resolve(); return; }
    where.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition((p) => { at = { lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }; where.textContent = `Break point set (within about ${Math.round(p.coords.accuracy)} m).`; valves.load(mainPick.value(), at); resolve(); },
      () => { where.textContent = 'The location was not shared. The valves near the main are shown.'; resolve(); }, { enableHighAccuracy: true, timeout: 15000 });
  }), { small: true });
  const boil = h('input', { type: 'checkbox', name: 'boil_water', checked: Boolean(b && b.boil_water) });
  const body = h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Water main', mainPick)),
    field('When it broke', input({ name: 'broke_at', type: 'datetime-local', required: true, value: b && b.broke_at ? local(b.broke_at) : nowInput() })),
    field('Where on the main', input({ name: 'location', maxlength: 200, value: (b && b.location) || '', placeholder: 'In front of 214 Market Street' })),
    h('div', { class: 'wide row' }, gps, where),
    field('Cause', select(CAUSES.map((c) => [c.value, c.label]), (b && b.cause) || 'unknown', { name: 'cause' })),
    field('Pipe material', input({ name: 'pipe_material', maxlength: 40, value: (b && b.pipe_material) || '', placeholder: 'From the main' })),
    field('Pipe size', input({ name: 'pipe_size', maxlength: 40, value: (b && b.pipe_size) || '', placeholder: 'From the main' })),
    field('Customers out of water', input({ name: 'customers_out', type: 'number', min: '0', value: b && b.customers_out !== null && b.customers_out !== undefined ? b.customers_out : '' }), custHint),
    field('Water off at', input({ name: 'water_off_at', type: 'datetime-local', value: b ? local(b.water_off_at) : '' })),
    editing ? field('Water back on at', input({ name: 'water_on_at', type: 'datetime-local', value: local(b.water_on_at) })) : null,
    h('label', { class: 'check wide' }, boil, ' A boil water advisory was issued (your certified operator decides; this records it)'),
    notices.length ? field('Street notice', select([['', 'None'], ...notices.map((n) => [n.id, `${n.code || 'Draft'}: ${n.title}`])], (b && b.notice_id) || '', { name: 'notice_id' }), 'Send it from Street notices') : null,
    h('div', { class: 'wide' }, valves),
    editing ? h('div', { class: 'wide' }, field('Repair', h('textarea', { name: 'repair', rows: 2, maxlength: 1000 }, b.repair || ''))) : null,
    editing ? field('Repaired at', input({ name: 'repaired_at', type: 'datetime-local', value: local(b.repaired_at) })) : null,
    h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 }, (b && b.notes) || ''))),
    !editing ? h('p', { class: 'muted small wide' }, 'Saving opens an urgent work order on the main. Record the crew, equipment and materials on it: they are the cost of the break.') : null);
  if (b && b.main_id) valves.load(b.main_id, at);
  formDialog(editing ? 'Change the main break' : 'Record a main break', body, async (fd) => {
    const mainId = mainPick.value();
    if (!mainId) throw new Error('Pick the water main');
    const out = { main_id: mainId, broke_at: val(fd, 'broke_at'), location: val(fd, 'location'), cause: val(fd, 'cause'), pipe_material: val(fd, 'pipe_material'), pipe_size: val(fd, 'pipe_size'),
      customers_out: num(fd, 'customers_out'), water_off_at: val(fd, 'water_off_at'), boil_water: boil.checked, notes: val(fd, 'notes'), valves: valves.value(),
      ...(fd.has('notice_id') ? { notice_id: num(fd, 'notice_id') } : {}), ...(at ? { lat: at.lat, lng: at.lng } : {}) };
    if (editing) {
      Object.assign(out, { water_on_at: val(fd, 'water_on_at'), repair: val(fd, 'repair'), repaired_at: val(fd, 'repaired_at') });
      await patch(`/water/main-breaks/${b.id}`, out);
      toast('Saved');
    } else {
      const r = await post('/water/main-breaks', out);
      toast(r.condition_raised ? 'Break recorded. It is this main’s third break in 5 years, so its condition is now Poor.' : 'Break recorded, and a work order opened');
    }
    await done();
  }, { submitText: editing ? 'Save' : 'Record the break', wide: true });
}

async function openBreak(id, done) {
  const b = await get(`/water/main-breaks/${id}`);
  CAUSES = b.causes;
  const facts = [
    ['Main', b.main_id ? h('a', { href: `#/assets/map/f${b.main_id}` }, b.main || 'On the map') : 'Not set'],
    ['Where', [b.location, b.street].filter(Boolean).join(', ')], ['Broke', fmtDateTime(b.broke_at)], ['Cause', causeWords(b.cause)],
    ['Pipe', [b.pipe_size, b.pipe_material].filter(Boolean).join(', ')], ['Customers out', b.customers_out === null ? '' : String(b.customers_out)],
    ['Water off', fmtDateTime(b.water_off_at)], ['Water back on', fmtDateTime(b.water_on_at)], ['Hours out', b.hours_out === null ? '' : `${b.hours_out} hours`],
    ['Boil water', b.boil_water ? 'Yes, issued by the certified operator' : 'No'],
    ['Street notice', b.notice ? h('a', { href: '#/notices' }, `${b.notice.code}: ${b.notice.title}`) : ''],
    ['Work order', b.work_order_id ? h('a', { href: `#/works/${b.work_order_id}` }, `Work order ${b.work_order_id}${b.work_order_status ? ` (${b.work_order_status.replace(/_/g, ' ')})` : ''}`) : ''],
    ['Repair', b.repair ? `${b.repair}${b.repaired_at ? `, ${fmtDateTime(b.repaired_at)}` : ''}` : ''], ['Notes', b.notes],
  ].filter(([, v]) => v);
  const dlg = dialog(`Main break, ${fmtDateTime(b.broke_at)}`, h('div', { class: 'stack' },
    h('p', null, b.status === 'open' ? state('Open', 'bad') : state('Repaired', 'good'), b.breaks_5y !== null ? h('span', { class: 'muted' }, ` This main has had ${b.breaks_5y} break${b.breaks_5y === 1 ? '' : 's'} in the last 5 years.`) : null),
    h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('section', { class: 'stack tight' }, h('h3', null, 'Valves operated'), b.valve_list.length ? h('ul', { class: 'plain' }, b.valve_list.map((v) => h('li', null, h('a', { href: `#/assets/map/f${v.valve_id}` }, v.tag || v.name || `Valve ${v.valve_id}`),
      `: closed ${v.closed_at ? fmtDateTime(v.closed_at) : 'time not noted'}${v.opened_at ? `, opened ${fmtDateTime(v.opened_at)}` : ', not opened yet'}${v.turns !== null ? `, ${v.turns} turns` : ''}`))) : h('p', { class: 'muted' }, 'None recorded.')),
    b.history.length > 1 ? h('section', { class: 'stack tight' }, h('h3', null, 'This main’s breaks'), h('ul', { class: 'plain' }, b.history.map((x) => h('li', null, `${fmtDateTime(x.broke_at)}: ${x.cause_words}${x.id === b.id ? ' (this one)' : ''}`)))) : null,
    h('div', { class: 'row' },
      button(b.status === 'open' ? 'Record the repair' : 'Change', () => { dlg.close(); breakForm(b, done); }, { kind: b.status === 'open' ? 'primary' : null, small: true }),
      isManager() ? button('Delete', () => confirmDialog('Delete this break?', 'Only for a break entered by mistake. Its work order stays.', 'Delete', async () => { await del(`/water/main-breaks/${id}`); dlg.close(); toast('Deleted'); await done(); }, { danger: true }), { small: true }) : null)), { wide: true });
}
