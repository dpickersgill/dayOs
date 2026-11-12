// Sewer (release 2026.11.20, the Sewer add-on): Chapter 94 and overflows.
//   Chapter 94   for each pump station, run hours by month (from the hour meters on its rounds) x each pump's rated flow =
//                an estimated flow; the system by month, the year's total and average, the peak month; new connections
//                (EDUs) per year; the year's overflows. A printable summary and a spreadsheet for the engineer.
//   Overflows    each sanitary sewer overflow: where, when, how much, why, whether it reached a stream, when DEP was told.
// The flows are estimates from run time, not metered flows, and the screen says so. The app files nothing with DEP.
import { get, post, put, patch, del, download } from '../api.js';
import { h, clear, appendAll, button, field, input, select, state, table, toast, formDialog, confirmDialog, empty, tabs, hashParam, isManager, val, num, fmtDateTime } from '../ui.js';
import { featurePicker } from './utility-bits.js';
import { printDialog } from '../print.js';

const thisYear = () => new Date().getFullYear();
const monthName = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' });
const mg = (gal) => (gal === null || gal === undefined ? '' : (gal / 1e6).toFixed(3));
const mgd = (v) => (v === null || v === undefined ? '' : v.toFixed(3));
const local = (s) => (s ? String(s).replace(' ', 'T').slice(0, 16) : '');

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Sewer'), h('p', { class: 'muted' }, 'Chapter 94 flows from the pump stations’ run hours, new connections, and overflows.'))));
  root.append(tabs([['ch94', 'Chapter 94', ch94Tab], ['overflows', 'Overflows', overflowsTab]], hashParam('tab') || 'ch94'));
}

const yearPicker = (value, onChange) => {
  const sel = select(Array.from({ length: 6 }, (_, i) => { const y = thisYear() - i; return [y, String(y)]; }), value, { 'aria-label': 'Year' });
  sel.addEventListener('change', () => onChange(Number(sel.value)));
  return sel;
};

async function ch94Tab(box) {
  let year = Number(hashParam('year')) || thisYear() - (new Date().getMonth() < 2 ? 1 : 0);
  async function load() {
    const r = await get(`/sewer/ch94?year=${year}`);
    const s = r.system.annual;
    const conn = r.connections.find((c) => c.year === year);
    appendAll(clear(box),
      h('div', { class: 'row no-print' }, yearPicker(year, (y) => { year = y; load(); }),
        button('Print the summary', () => printSummary(r), { small: true }), button('Download spreadsheet', () => download(`/sewer/ch94.csv?year=${year}`, `chapter-94-flows-${year}.csv`), { small: true })),
      h('p', { class: 'muted small' }, r.basis),
      r.missing_rates.length ? h('p', { class: 'warn-note' }, `Enter each pump’s rated flow for ${r.missing_rates.join(', ')}. Until then its run hours have no flow.`) : null,
      h('div', { class: 'util-figures' },
        fig(mg(s.gallons) || '0', 'million gallons this year'), fig(mgd(s.mgd) || 'None', 'average daily flow (MGD)'),
        fig(s.peak_month ? monthName(s.peak_month) : 'None', `peak month${s.peak_mgd ? `, ${mgd(s.peak_mgd)} MGD` : ''}`),
        fig(s.peak_ratio ? `${s.peak_ratio}x` : 'None', 'peak month over the average'),
        fig(conn ? String(conn.new_edus) : 'Not entered', 'new connections (EDUs)'), fig(String(r.overflows.length), r.overflows.length === 1 ? 'overflow' : 'overflows')),
      h('section', { class: 'stack tight' }, h('h2', null, 'The system by month'), monthTable(r.months, r.system.months)),
      ...r.stations.map((st) => station(st, r.months, load)),
      !r.stations.length ? empty('No pump stations on the map. Put them on the map as pump stations, and read their hour meters on each round.') : null,
      connections(r, year, load),
      h('section', { class: 'stack tight' }, h('h2', null, 'Overflows this year'), r.overflows.length ? overflowTable(r.overflows) : h('p', { class: 'muted' }, 'None recorded.')));
  }
  await load();
}
const fig = (n, words) => h('div', { class: 'figure' }, h('strong', null, n), h('span', null, words));

function monthTable(months, rows) {
  return h('div', { class: 'table-scroll' }, table([
    { head: 'Month', cell: (m) => monthName(m.month) },
    { head: 'Run hours', num: true, cell: (m) => (m.hours ? String(m.hours) : '') },
    { head: 'Million gallons', num: true, cell: (m) => mg(m.gallons) },
    { head: 'Average daily flow (MGD)', num: true, cell: (m) => mgd(m.mgd) },
  ], rows.filter((m) => m.gallons !== null || m.hours)));
}

function station(st, months, reload) {
  return h('section', { class: 'stack tight' },
    h('h2', null, st.name, st.tag ? h('span', { class: 'muted' }, ` ${st.tag}`) : null),
    h('p', null, st.pumps.length ? st.pumps.map((p) => `${p.label.replace(/ run hour meter$/i, '')}: ${p.gpm === null ? 'rated flow not entered' : `${p.gpm} gpm`}`).join('. ') : 'No hour meter readings yet.',
      isManager() && st.pumps.length ? [' ', button('Rated flows', () => rates(st, reload), { small: true, label: `Rated flows for ${st.name}` })] : null),
    st.months.some((m) => m.readings) ? h('div', { class: 'table-scroll' }, table([
      { head: 'Month', cell: (m) => monthName(m.month) },
      ...st.pumps.map((p, i) => ({ head: `${p.label.replace(/ run hour meter$/i, '')} hours`, num: true, cell: (m) => (m.pumps[i].hours === null ? '' : String(m.pumps[i].hours)) })),
      { head: 'Million gallons', num: true, cell: (m) => (m.missing_rate && !m.gallons ? 'Needs rated flow' : mg(m.gallons)) },
      { head: 'MGD', num: true, cell: (m) => mgd(m.mgd) },
    ], st.months.filter((m) => m.readings))) : null,
    h('p', { class: 'small' }, `Year: ${st.annual.hours} run hours, ${mg(st.annual.gallons)} million gallons${st.annual.peak_month ? `, peak ${monthName(st.annual.peak_month)} (${mgd(st.annual.peak_mgd)} MGD)` : ''}.`));
}

function rates(st, reload) {
  formDialog(`Rated flows: ${st.name}`, h('div', { class: 'form' },
    h('p', { class: 'wide muted' }, 'Each pump’s rated flow at its operating point, in gallons a minute, from its pump curve or a drawdown test.'),
    ...st.pumps.map((p) => field(p.label.replace(/ run hour meter$/i, ''), input({ name: p.key, type: 'number', min: '0', step: '1', value: p.gpm ?? '' }), 'gpm'))), async (fd) => {
    await put(`/sewer/ch94/stations/${st.id}/pumps`, { pumps: Object.fromEntries(st.pumps.map((p) => [p.key, num(fd, p.key)])) });
    toast('Saved'); await reload();
  });
}

function connections(r, year, reload) {
  const c = r.connections.find((x) => x.year === year);
  return h('section', { class: 'stack tight' }, h('h2', null, 'New connections'),
    r.connections.length ? table([
      { head: 'Year', cell: (x) => String(x.year) }, { head: 'New EDUs', num: true, cell: (x) => String(x.new_edus) },
      { head: 'Projected EDUs (5 years)', num: true, cell: (x) => (x.projected_edus === null ? '' : String(x.projected_edus)) }, { head: 'Notes', cell: (x) => x.notes || '' },
    ], r.connections) : h('p', { class: 'muted' }, 'None entered.'),
    isManager() ? h('p', null, button(c ? `Change ${year}` : `Enter ${year}`, () => formDialog(`New connections in ${year}`, h('div', { class: 'form' },
      field('New connections (EDUs)', input({ name: 'new_edus', type: 'number', min: '0', required: true, value: c ? c.new_edus : '' })),
      field('Projected over the next 5 years (EDUs)', input({ name: 'projected_edus', type: 'number', min: '0', value: c && c.projected_edus !== null ? c.projected_edus : '' })),
      h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 500, value: c ? c.notes || '' : '', placeholder: 'Subdivisions, the plant’s planning module' })))), async (fd) => {
      await put(`/sewer/ch94/years/${year}`, { new_edus: num(fd, 'new_edus'), projected_edus: num(fd, 'projected_edus'), notes: val(fd, 'notes') });
      toast('Saved'); await reload();
    }), { small: true })) : null);
}

function overflowTable(list, edit) {
  return h('div', { class: 'table-scroll' }, table([
    { head: 'When', cell: (o) => fmtDateTime(o.started_at) },
    { head: 'Where', cell: (o) => [o.where, o.location].filter(Boolean).join(', ') },
    { head: 'Gallons', num: true, cell: (o) => (o.gallons === null ? '' : o.gallons.toLocaleString('en-US')) },
    { head: 'Cause', cell: (o) => o.cause_words },
    { head: 'Reached a stream', cell: (o) => (o.reached_water ? state('Yes', 'bad') : 'No') },
    { head: 'DEP told', cell: (o) => (o.reported_to_dep_at ? fmtDateTime(o.reported_to_dep_at) : state('Not yet', 'warn')) },
    ...(edit ? [{ head: '', actions: true, cell: (o) => edit(o) }] : []),
  ], list));
}

function printSummary(r) {
  const s = r.system.annual;
  printDialog(`Chapter 94 summary ${r.year}`, h('div', { class: 'sheet stack' },
    h('h2', null, `Chapter 94 flows, ${r.year}`), h('p', { class: 'small' }, r.basis),
    h('p', null, `Total ${mg(s.gallons)} million gallons; average ${mgd(s.mgd)} MGD; peak month ${s.peak_month ? `${monthName(s.peak_month)} at ${mgd(s.peak_mgd)} MGD` : 'none'}.`),
    monthTable(r.months, r.system.months),
    ...r.stations.map((st) => h('section', { class: 'stack tight' }, h('h3', null, st.name), h('p', null, `${st.annual.hours} run hours, ${mg(st.annual.gallons)} million gallons.`))),
    h('h3', null, 'New connections'), h('p', null, (r.connections.find((c) => c.year === r.year) || { new_edus: 'Not entered' }).new_edus.toString()),
    h('h3', null, 'Overflows'), r.overflows.length ? overflowTable(r.overflows) : h('p', null, 'None recorded.')));
}

async function overflowsTab(box) {
  let year = thisYear();
  async function load() {
    const r = await get(`/sewer/overflows?year=${year}`);
    const editBtn = (o) => button('Change', () => overflowForm(r.causes, o, load), { small: true });
    appendAll(clear(box),
      h('div', { class: 'row' }, yearPicker(year, (y) => { year = y; load(); }), button('Record an overflow', () => overflowForm(r.causes, null, load), { kind: 'primary', small: true })),
      r.data.length ? overflowTable(r.data, (o) => [editBtn(o), isManager() ? button('Delete', () => confirmDialog('Delete this overflow?', 'Only for one entered by mistake.', 'Delete', async () => { await del(`/sewer/overflows/${o.id}`); await load(); }, { danger: true }), { small: true }) : null]) : empty('No overflows recorded this year.'));
  }
  await load();
}

function overflowForm(causes, o, done) {
  const at = featurePicker({ kinds: ['sewer_manhole', 'lift_station', 'cleanout', 'sewer_line', 'force_main'], placeholder: 'Manhole or pump station tag, or street', value: o && o.map_feature_id ? { id: o.map_feature_id, label: o.where || 'On the map' } : null });
  formDialog(o ? 'Change the overflow' : 'Record an overflow', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Manhole or pump station', at)),
    h('div', { class: 'wide' }, field('Or describe the place', input({ name: 'location', maxlength: 200, value: o ? o.location || '' : '' }))),
    field('Started', input({ name: 'started_at', type: 'datetime-local', required: true, value: o ? local(o.started_at) : '' })),
    field('Stopped', input({ name: 'ended_at', type: 'datetime-local', value: o ? local(o.ended_at) : '' })),
    field('Gallons (estimate)', input({ name: 'gallons', type: 'number', min: '0', value: o && o.gallons !== null ? o.gallons : '' })),
    field('Cause', select(causes.map((c) => [c.value, c.label]), o ? o.cause : 'rain', { name: 'cause' })),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'reached_water', checked: Boolean(o && o.reached_water) }), ' It reached a stream, a storm drain or other waters'),
    field('DEP told at', input({ name: 'reported_to_dep_at', type: 'datetime-local', value: o ? local(o.reported_to_dep_at) : '' })),
    h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 }, o ? o.notes || '' : '')))), async (fd) => {
    const b = { map_feature_id: at.value(), location: val(fd, 'location'), started_at: val(fd, 'started_at'), ended_at: val(fd, 'ended_at'), gallons: num(fd, 'gallons'), cause: val(fd, 'cause'),
      reached_water: fd.get('reached_water') === 'on', reported_to_dep_at: val(fd, 'reported_to_dep_at'), notes: val(fd, 'notes') };
    if (o) await patch(`/sewer/overflows/${o.id}`, b); else await post('/sewer/overflows', b);
    toast('Saved'); await done();
  }, { submitText: 'Save', wide: true });
}
