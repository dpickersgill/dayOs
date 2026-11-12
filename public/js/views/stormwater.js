// Stormwater (release 2026.11.20, the Stormwater add-on): MS4 and illicit discharge cases.
//   MS4     the permit year (July 1 to June 30) by the six minimum control measures, with the year's records: education
//           and involvement, outfall screenings done against those required (and a map of them), illicit discharge
//           cases, construction and post-construction BMP inspections, yard inspections and staff training. A printable
//           pack and a spreadsheet for the engineer who writes the annual report.
//   Cases   illicit discharge cases: opened by a screening that found a suspected illicit discharge (or by hand), with
//           source tracing, upstream inspections, samples, notices sent, and how it was resolved.
// The app records what staff did; it does not file a report or decide that a discharge is illegal.
import { get, post, put, patch, download } from '../api.js';
import { h, clear, appendAll, button, field, input, select, state, table, toast, fail, formDialog, dialog, empty, tabs, hashParam, isManager, val, num, fmtDate, fmtDateTime, todayStr } from '../ui.js';
import { featurePicker } from './utility-bits.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';
import { printDialog } from '../print.js';

const permitYearNow = () => { const d = todayStr(); const y = Number(d.slice(0, 4)); return Number(d.slice(5, 7)) >= 7 ? y : y - 1; };
const CASE_TONE = { open: 'bad', source_found: 'warn', resolved: 'good', closed: 'neutral' };

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Stormwater'), h('p', { class: 'muted' }, 'The MS4 permit year by minimum control measure, and illicit discharge cases.'))));
  root.append(tabs([['ms4', 'MS4', ms4Tab], ['cases', 'Illicit discharge cases', casesTab]], hashParam('tab') || 'ms4'));
  const id = Number(hashParam('case'));
  if (id) openCase(id, async () => {}).catch(fail);
}

async function ms4Tab(box) {
  let year = Number(hashParam('year')) || permitYearNow();
  async function load() {
    const p = await get(`/stormwater/ms4?year=${year}`);
    const sel = select(Array.from({ length: 5 }, (_, i) => { const y = permitYearNow() - i; return [y, `${y} to ${y + 1}`]; }), year, { 'aria-label': 'Permit year' });
    sel.addEventListener('change', () => { year = Number(sel.value); load().catch(fail); });
    const sc = p.screenings;
    appendAll(clear(box),
      h('div', { class: 'row no-print' }, sel, button('Print the annual pack', () => printPack(p), { small: true }), button('Download spreadsheet', () => download(`/stormwater/ms4.csv?year=${year}`, `ms4-${year}-${year + 1}.csv`), { small: true }),
        isManager() ? button('Permit settings', () => settings(p, load), { small: true }) : null),
      h('p', null, `Permit year ${p.permit_year.label}.${p.settings.permit_number ? ` Permit ${p.settings.permit_number}.` : ''}`),
      h('div', { class: 'util-figures' },
        fig(`${sc.done} of ${sc.required}`, 'outfalls screened'), fig(String(sc.failed), 'screenings failed'), fig(String(sc.illicit), 'suspected illicit discharges'),
        fig(String(p.cases.filter((c) => ['open', 'source_found'].includes(c.status)).length), 'open cases'),
        fig(String(p.sections.reduce((n, s) => n + s.activities.length, 0) + p.bmp_inspections.length), 'other records this year')),
      ...p.sections.map((s) => section(s, p, load)));
    const mapSlot = box.querySelector('[data-outfall-map]');
    if (mapSlot) outfallMap(mapSlot, sc.outfalls);
  }
  await load();
}
const fig = (n, words) => h('div', { class: 'figure' }, h('strong', null, n), h('span', null, words));

function activityTable(list) {
  return h('div', { class: 'table-scroll' }, table([
    { head: 'Date', cell: (a) => fmtDate(a.on_date) },
    { head: 'What', cell: (a) => h('span', { class: 'stack tight' }, h('strong', null, a.title), h('span', { class: 'muted small' }, a.kind_words)) },
    { head: 'Who or how many', cell: (a) => (a.kind === 'training' ? `${a.attendees.length || a.people || 0} signed in` : [a.audience, a.people ? `${a.people} people` : null].filter(Boolean).join(', ')) },
    { head: 'Result', cell: (a) => (a.result === 'na' ? '' : state(a.result === 'pass' ? 'Passed' : 'Failed', a.result === 'pass' ? 'good' : 'bad')) },
    { head: 'Where', cell: (a) => [a.map_item, a.location].filter(Boolean).join(', ') },
  ], list));
}

function section(s, p, reload) {
  const kinds = p.kinds.filter((k) => k.mcm === s.mcm);
  const add = kinds.length ? button(`Add ${kinds.length === 1 ? kinds[0].label.charAt(0).toLowerCase() + kinds[0].label.slice(1) : 'a record'}`, () => activityForm(kinds, reload), { small: true }) : null;
  const extra = [];
  if (s.mcm === 3) {
    const sc = p.screenings;
    extra.push(h('p', null, `${sc.done} of ${sc.required} required outfall screenings done this permit year (${sc.total_outfalls} outfalls on the map). Screenings are done from Programs or an outfall’s panel on the map.`),
      h('div', { class: 'map-box util-map', 'data-outfall-map': '1', role: 'img', 'aria-label': 'Outfalls: screened, failed and not yet screened' }),
      h('p', { class: 'small muted' }, 'Green: screened and passed. Red: a screening failed. Gray: not screened yet this permit year.'),
      sc.outfalls.length ? h('details', null, h('summary', null, 'Every outfall'), h('div', { class: 'table-scroll' }, table([
        { head: 'Outfall', cell: (o) => h('a', { href: `#/assets/map/f${o.id}` }, o.tag || o.name || `Outfall ${o.id}`) },
        { head: 'Screened', cell: (o) => (o.screened ? `${fmtDateTime(o.last_screened)}${o.screenings > 1 ? ` (${o.screenings} times)` : ''}` : state('Not yet', 'warn')) },
        { head: 'Result', cell: (o) => (o.failed ? state(o.illicit ? 'Failed, suspected illicit discharge' : 'Failed', 'bad') : o.screened ? state('Passed', 'good') : '') },
      ], sc.outfalls))) : null,
      h('h3', null, 'Illicit discharge cases'), p.cases.length ? caseTable(p.cases, reload) : h('p', { class: 'muted' }, 'None this permit year.'));
  }
  if (s.mcm === 5) extra.push(h('h3', null, 'Stormwater facility inspections'), p.bmp_inspections.length ? h('div', { class: 'table-scroll' }, table([
    { head: 'Date', cell: (i) => fmtDateTime(i.done_at) }, { head: 'Facility', cell: (i) => h('a', { href: `#/assets/map/f${i.map_feature_id}` }, i.map_item || 'On the map') },
    { head: 'Checklist', cell: (i) => i.template }, { head: 'Result', cell: (i) => state(i.result === 'pass' ? 'Passed' : 'Failed', i.result === 'pass' ? 'good' : 'bad') }, { head: 'By', cell: (i) => i.inspector || '' },
  ], p.bmp_inspections)) : h('p', { class: 'muted' }, 'None this permit year. Inspect basins and rain gardens from the map.'));
  return h('section', { class: 'stack tight mcm' }, h('div', { class: 'spread' }, h('h2', null, `${s.mcm}. ${s.title}`), add),
    s.activities.length ? activityTable(s.activities) : kinds.length ? h('p', { class: 'muted' }, 'Nothing recorded this permit year.') : null, ...extra);
}

async function outfallMap(el, outfalls) {
  try {
    const pts = outfalls.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng));
    if (!pts.length) { el.replaceWith(h('p', { class: 'muted' }, 'No outfalls on the map yet.')); return; }
    const [L, cfg] = await Promise.all([loadLeaflet(), get('/assets/map/view')]);
    const map = makeMap(L, el, cfg, { lat: pts[0].lat, lng: pts[0].lng, zoom: 16 }, { remember: 'assets' });
    removeWhenGone(el, map);
    for (const o of pts) {
      const color = o.failed ? '#c62828' : o.screened ? '#2e7d32' : '#8a959c';
      L.circleMarker([o.lat, o.lng], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 0.95 }).bindPopup(`${o.tag || o.name || 'Outfall'}: ${o.failed ? 'failed' : o.screened ? 'screened' : 'not screened yet'}`).addTo(map);
    }
    if (pts.length > 1) fitMap(map, L.latLngBounds(pts.map((o) => [o.lat, o.lng])), { padding: [24, 24], maxZoom: 18 });
  } catch (err) { el.replaceWith(h('p', { class: 'muted' }, 'The map could not load.')); }
}

function activityForm(kinds, done) {
  const at = featurePicker({ placeholder: 'A basin, outfall or inlet on the map (optional)' });
  const kindSel = select(kinds.map((k) => [k.value, k.label]), kinds[0].value, { name: 'kind' });
  const people = h('textarea', { name: 'attendees', rows: 4, placeholder: 'One name a line' });
  const peopleField = field('Signed in (staff training)', people);
  const result = field('Result', select([['na', 'No result'], ['pass', 'Passed'], ['fail', 'Failed']], 'na', { name: 'result' }));
  const show = () => { peopleField.hidden = kindSel.value !== 'training'; result.hidden = !['construction', 'post_construction', 'housekeeping'].includes(kindSel.value); };
  kindSel.addEventListener('change', show); show();
  formDialog('Add an MS4 record', h('div', { class: 'form' },
    field('Kind', kindSel), field('Date', input({ name: 'on_date', type: 'date', required: true, value: todayStr() })),
    h('div', { class: 'wide' }, field('What', input({ name: 'title', required: true, minlength: 3, maxlength: 200, placeholder: 'Storm drain markers on Mill Street with the Scouts' }))),
    field('Audience', input({ name: 'audience', maxlength: 200, placeholder: 'Residents, a school, a business' })), field('People reached', input({ name: 'people', type: 'number', min: '0' })),
    field('Location', input({ name: 'location', maxlength: 200 })), result,
    h('div', { class: 'wide' }, field('On the map', at)), h('div', { class: 'wide' }, peopleField),
    h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 })))), async (fd) => {
    await post('/stormwater/ms4/activities', { kind: val(fd, 'kind'), on_date: val(fd, 'on_date'), title: val(fd, 'title'), audience: val(fd, 'audience'), people: num(fd, 'people'), location: val(fd, 'location'),
      result: kindSel.value === 'training' ? 'na' : val(fd, 'result') || 'na', map_feature_id: at.value(), notes: val(fd, 'notes'),
      attendees: kindSel.value === 'training' ? people.value.split(/\n/).map((x) => x.trim()).filter(Boolean) : [] });
    toast('Recorded'); await done();
  }, { submitText: 'Save', wide: true });
}

function settings(p, done) {
  formDialog('MS4 permit', h('div', { class: 'form' },
    field('Permit number', input({ name: 'permit_number', maxlength: 40, value: p.settings.permit_number || '', placeholder: 'PAG133701' })),
    field('Outfall screenings required this permit year', input({ name: 'screenings_required', type: 'number', min: '0', value: p.settings.screenings_required ?? '' }), `Blank: every outfall on the map (${p.settings.required_default})`)), async (fd) => {
    await put('/stormwater/ms4/settings', { permit_number: val(fd, 'permit_number'), screenings_required: num(fd, 'screenings_required') });
    toast('Saved'); await done();
  });
}

function printPack(p) {
  const sc = p.screenings;
  printDialog(`MS4 annual pack ${p.permit_year.year} to ${p.permit_year.year + 1}`, h('div', { class: 'sheet stack' },
    h('h2', null, 'MS4 annual report pack'), h('p', null, `Permit year ${p.permit_year.label}.${p.settings.permit_number ? ` Permit ${p.settings.permit_number}.` : ''} Records kept by staff; for the engineer who writes the report.`),
    ...p.sections.map((s) => h('section', { class: 'stack tight mcm' }, h('h3', null, `${s.mcm}. ${s.title}`),
      s.activities.length ? activityTable(s.activities) : h('p', null, s.mcm === 3 || s.mcm === 5 ? '' : 'Nothing recorded.'),
      s.mcm === 3 ? h('p', null, `Outfall screenings: ${sc.done} of ${sc.required} required done; ${sc.failed} failed; ${sc.illicit} with a suspected illicit discharge. Cases: ${p.cases.map((c) => `${c.reference} (${c.status_words}${c.resolution ? `: ${c.resolution}` : ''})`).join('; ') || 'none'}.`) : null,
      s.mcm === 5 ? h('p', null, `Stormwater facility inspections: ${p.bmp_inspections.length} (${p.bmp_inspections.filter((i) => i.result === 'fail').length} failed).`) : null))));
}

function caseTable(list, reload) {
  return h('div', { class: 'table-scroll' }, table([
    { head: 'Case', cell: (c) => h('strong', null, c.reference) },
    { head: 'Outfall', cell: (c) => (c.outfall_id ? h('a', { href: `#/assets/map/f${c.outfall_id}` }, c.outfall || 'On the map') : '') },
    { head: 'Opened', cell: (c) => fmtDate(c.opened_at) },
    { head: 'Status', cell: (c) => state(c.status_words, CASE_TONE[c.status]) },
    { head: 'Source', cell: (c) => c.suspected_source || '' },
    { head: '', actions: true, cell: (c) => button('Open', () => openCase(c.id, reload), { small: true, label: `Open case ${c.reference}` }) },
  ], list));
}

async function casesTab(box) {
  let status = 'open';
  async function load() {
    const r = await get(`/stormwater/cases?status=${status}`);
    const sel = select([['open', 'Open'], ['closed', 'Resolved and closed'], ['all', 'All']], status, { 'aria-label': 'Which cases' });
    sel.addEventListener('change', () => { status = sel.value; load().catch(fail); });
    appendAll(clear(box), h('div', { class: 'row' }, sel, button('Open a case', () => newCase(load), { small: true })),
      h('p', { class: 'muted small' }, 'A dry-weather screening that finds a suspected illicit discharge opens a case on its outfall by itself.'),
      r.data.length ? caseTable(r.data, load) : empty(status === 'open' ? 'No open cases.' : 'No cases.'));
  }
  await load();
}

function newCase(done) {
  const at = featurePicker({ kinds: ['storm_outfall'], placeholder: 'Outfall tag' });
  formDialog('Open an illicit discharge case', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Outfall', at)),
    h('div', { class: 'wide' }, field('What was found', h('textarea', { name: 'description', rows: 3, required: true, minlength: 3, maxlength: 1000, placeholder: 'A resident reported soapy water coming from the pipe at the creek' }))),
    field('Suspected source', input({ name: 'suspected_source', maxlength: 200 }))), async (fd) => {
    const r = await post('/stormwater/cases', { outfall_id: at.value(), description: val(fd, 'description'), suspected_source: val(fd, 'suspected_source') });
    toast('Case opened'); await done(); await openCase(r.id, done);
  }, { submitText: 'Open the case', wide: true });
}

async function openCase(id, done) {
  const c = await get(`/stormwater/cases/${id}`);
  const again = async () => { dlg.close(); await done(); await openCase(id, done); };
  const kind = select(c.entry_kinds.map((k) => [k.value, k.label]), 'trace', { 'aria-label': 'Kind of entry' });
  const words = input({ maxlength: 2000, placeholder: 'Dye test at inlet IN-404: dye reached the outfall', 'aria-label': 'What was done or found' });
  const day = input({ type: 'date', value: todayStr(), 'aria-label': 'Date' });
  const facts = [['Outfall', c.outfall_id ? h('a', { href: `#/assets/map/f${c.outfall_id}` }, c.outfall || 'On the map') : 'Not set'], ['Opened', fmtDateTime(c.opened_at)], ['What was found', c.description],
    ['Suspected source', c.suspected_source], ['Responsible party', c.responsible_party], ['Resolution', c.resolution], ['Resolved', c.resolved_at ? fmtDateTime(c.resolved_at) : null]].filter(([, v]) => v);
  const dlg = dialog(`${c.reference}: illicit discharge case`, h('div', { class: 'stack' },
    h('p', null, state(c.status_words, CASE_TONE[c.status])),
    h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('section', { class: 'stack tight' }, h('h3', null, 'Log'), c.entries.length ? h('ul', { class: 'wo-notes' }, c.entries.map((e) => h('li', null, h('span', { class: 'muted small' }, `${fmtDate(e.on_date)} ${e.kind_words}${e.author ? `, ${e.author}` : ''}${e.map_item ? `, ${e.map_item}` : ''}`), h('span', null, e.body)))) : h('p', { class: 'muted' }, 'Nothing yet.'),
      h('div', { class: 'row' }, kind, day, words, button('Add', async () => { if (!words.value.trim()) return; try { await post(`/stormwater/cases/${id}/entries`, { kind: kind.value, on_date: day.value || undefined, body: words.value.trim() }); await again(); } catch (err) { fail(err); } }, { small: true }))),
    h('div', { class: 'row' }, button('Update the case', () => { dlg.close(); updateCase(c, done); }, { kind: 'primary', small: true }))), { wide: true });
}

function updateCase(c, done) {
  formDialog(`Update ${c.reference}`, h('div', { class: 'form' },
    field('Status', select(c.statuses.map((s) => [s.value, s.label]), c.status, { name: 'status' })),
    field('Suspected source', input({ name: 'suspected_source', maxlength: 200, value: c.suspected_source || '' })),
    field('Responsible party', input({ name: 'responsible_party', maxlength: 200, value: c.responsible_party || '', placeholder: 'A business or property owner' })),
    h('div', { class: 'wide' }, field('Resolution', h('textarea', { name: 'resolution', rows: 2, maxlength: 1000 }, c.resolution || ''), 'Needed to resolve or close it'))), async (fd) => {
    await patch(`/stormwater/cases/${c.id}`, { status: val(fd, 'status'), suspected_source: val(fd, 'suspected_source'), responsible_party: val(fd, 'responsible_party'), resolution: val(fd, 'resolution') });
    toast('Saved'); await done(); await openCase(c.id, done);
  }, { submitText: 'Save', wide: true });
}
