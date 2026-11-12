// The collection schedule's tabs in the Trash and recycling app (release 2026.11.22). views/bulk-pickup.js draws them:
//   Calendar        (everyone) look up an address, and see what is collected each day, zone by zone, with holidays,
//                   moved days and seasonal collections; open a day for its streets in driving order
//   Missed pickups  (everyone) missed pickup requests with the stream, what the schedule check said, and repeats
//   Schedule        (managers) setup: who collects, streams, zones and their streets, "not collected", the check that
//                   must pass before the calendar is published; holidays, seasonal collections, moved days; reminders
//                   and the Act 101 education log with the printable mailer
import { get, post, put, patch, del } from '../api.js';
import { h, clear, appendAll, ctx, state, button, field, input, select, toast, fail, formDialog, dialog, confirmDialog, empty, errorBox, loading, tabs, table, isManager, can, fmtDay, fmtDate, fmtDateLong, fmtInstant, hashParam, todayStr, addDays } from '../ui.js';
import { printDialog } from '../print.js';

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const FREQ = [['weekly', 'Every week'], ['biweekly', 'Every other week'], ['monthly', 'Once a month']];
const SIDES = [['both', 'Both sides'], ['odd', 'Odd side'], ['even', 'Even side']];
const REASONS = [['snow', 'Snow'], ['weather', 'Weather'], ['holiday', 'Holiday'], ['other', 'Other']];
const MOVED = { holiday: 'moved for the holiday', snow: 'moved for snow', weather: 'moved for the weather', other: 'moved' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const chip = (name, color, extra) => h('span', { class: 'cl-chip', style: `--chip:${color || '#5b6770'}` }, name, extra ? h('small', null, ` ${extra}`) : null);
const partWords = (p) => `${p.street}${p.from_no != null || p.to_no != null ? ` ${p.from_no ?? 'start'} to ${p.to_no ?? 'end'}` : ''}${p.side && p.side !== 'both' ? ` (${p.side} side)` : ''}`;
const mmddWords = (s) => (s ? new Date(`2026-${s}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const monthOf = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ================================================================ Calendar
export async function calendarTab(panel) {
  let setup;
  try { setup = await get('/solid-waste/collection/setup'); } catch (err) { panel.append(errorBox(err)); return; }
  if (!setup.zones.length) {
    panel.append(empty('The collection schedule is not set up yet.', isManager() ? h('a', { class: 'btn', href: '#/bulk?tab=schedule' }, 'Set it up') : h('p', { class: 'muted small' }, 'A manager sets it up in Schedule.')));
    return;
  }
  appendAll(panel,
    !setup.settings.setup_done ? h('p', { class: 'warn-note' }, 'Residents cannot see this calendar yet: setup is not finished.', isManager() ? [' ', h('a', { href: '#/bulk?tab=schedule' }, 'Finish setup')] : null) : null,
    lookupPanel(setup),
    agenda(setup));
}

/** Street and house number -> the zone and the next day of each stream (the front desk on the phone with a resident). */
function lookupPanel(setup) {
  const street = select([['', 'Pick the street'], ...setup.streets.map((s) => [s.id, s.name])], '', { 'aria-label': 'Street', name: 'street' });
  const house = input({ inputmode: 'numeric', maxlength: 20, placeholder: 'House number', 'aria-label': 'House number', name: 'house' });
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  const go = async () => {
    if (!street.value) { clear(out).append(h('p', { class: 'muted small' }, 'Pick the street first.')); return; }
    clear(out).append(loading('Looking it up'));
    try {
      const r = await get(`/solid-waste/collection/lookup?street_id=${street.value}&house_number=${encodeURIComponent(house.value.trim())}`);
      if (!r.found || r.not_collected) { clear(out).append(h('p', { class: 'callout' }, r.message)); return; }
      clear(out).append(h('p', null, h('b', null, r.zone.name)),
        h('ul', { class: 'plain stack tight cl-next' }, r.next.map((x) => h('li', null, chip(x.stream, x.color), ' ', h('b', null, x.words), h('span', { class: 'muted small' }, ` (${x.how_often}${x.season ? `, ${mmddWords(x.season.from)} to ${mmddWords(x.season.to)}` : ''})`)))));
    } catch (err) { clear(out).append(errorBox(err)); }
  };
  house.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  return h('section', { class: 'panel stack', 'aria-labelledby': 'cl-lookup-h' }, h('h2', { id: 'cl-lookup-h' }, 'Look up an address'),
    h('div', { class: 'row cl-lookup' }, street, house, button('Look up', go, { kind: 'primary' })), out);
}

/** Four weeks, day by day: each zone's streams (moved days marked), holidays and seasonal collections. */
function agenda(setup) {
  let from = hashParam('date') && /^\d{4}-\d{2}-\d{2}$/.test(hashParam('date')) ? hashParam('date') : setup.today;
  const zone = select([['', 'Every zone'], ...setup.zones.filter((z) => z.active).map((z) => [z.id, z.name])], '', { 'aria-label': 'Zone' });
  const body = h('div');
  const load = async () => {
    clear(body).append(loading('Loading the calendar'));
    let c;
    try { c = await get(`/solid-waste/collection/calendar?from=${from}&to=${addDays(from, 27)}${zone.value ? `&zone_id=${zone.value}` : ''}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const colors = new Map(c.streams.map((s) => [s.id, s.color]));
    const rowsOut = [];
    for (let d = c.from; d <= c.to; d = addDays(d, 1)) {
      const holiday = c.holidays.find((x) => String(x.on_date).slice(0, 10) === d);
      // A seasonal collection shows on its first day (or the first day here, when it started earlier), with its last day.
      const events = c.events.filter((e) => { const st = String(e.starts_on).slice(0, 10); const en = String(e.ends_on).slice(0, 10); return en >= d && (st === d || (d === c.from && st < d)); });
      const zones = c.zones.map((z) => ({ z, items: z.days.filter((x) => x.date === d) })).filter((x) => x.items.length);
      if (!zones.length && !holiday && !events.length) continue;
      rowsOut.push(h('li', { class: `cl-day${d === c.today ? ' cl-today' : ''}`, dataset: { date: d } },
        h('div', { class: 'cl-date' }, h('b', null, fmtDate(d)), d === c.today ? state('Today', 'good') : null),
        h('div', { class: 'stack tight' },
          holiday ? h('p', { class: 'cl-holiday' }, `${holiday.name} (holiday)`) : null,
          ...events.map((e) => h('p', { class: 'cl-event' }, `${e.name}${String(e.ends_on).slice(0, 10) !== String(e.starts_on).slice(0, 10) ? `, until ${fmtDate(e.ends_on)}` : ''}${e.zone_ids.length ? ` (${e.zone_ids.length === 1 ? 'one zone' : `${e.zone_ids.length} zones`})` : ''}`)),
          ...zones.map(({ z, items }) => h('p', { class: 'cl-zone' }, h('span', { class: 'cl-zname' }, z.name), ' ', ...items.map((x) => chip(x.streamName, colors.get(x.streamId), x.moved ? `(${MOVED[x.reason] || 'moved'})` : null)))),
          zones.length ? h('p', null, button('Streets', () => streetsOfDay(d), { small: true })) : null)));
    }
    clear(body).append(rowsOut.length ? h('ol', { class: 'plain cl-agenda' }, rowsOut) : empty('Nothing is collected in these four weeks.'));
  };
  zone.addEventListener('change', load);
  const move = (n) => { from = addDays(from, n); load(); };
  load();
  return h('section', { class: 'stack', 'aria-labelledby': 'cl-agenda-h' },
    h('div', { class: 'week-bar' }, h('h2', { id: 'cl-agenda-h' }, 'Collection days'), h('div', { class: 'week-actions row' }, zone,
      button('Earlier', () => move(-28), { small: true }), button('Today', () => { from = setup.today; load(); }, { small: true }), button('Later', () => move(28), { small: true }))),
    body);
}

async function streetsOfDay(date) {
  let r;
  try { r = await get(`/solid-waste/collection/day?date=${date}`); } catch (err) { fail(err); return; }
  dialog(`Collected ${fmtDateLong(date)}`, r.routes.length ? h('div', { class: 'stack' }, r.routes.map((x) => h('section', { class: 'stack tight' },
    h('h3', null, `${x.zoneName}: ${x.streamName}${x.moved ? ` (${MOVED[x.reason] || 'moved'})` : ''}`),
    x.streets.length ? h('ol', { class: 'cl-streets' }, x.streets.map((s) => h('li', null, partWords({ street: s.name, from_no: s.fromNo, to_no: s.toNo, side: s.side })))) : h('p', { class: 'muted small' }, 'No streets in this zone yet.')))) : h('p', null, 'Nothing is collected this day.'), { wide: true });
}

// ================================================================ Missed pickups
export async function missedTab(panel) {
  let show = 'open';
  const body = h('div');
  const pick = select([['open', 'Open'], ['all', 'The last 120 days']], show, { 'aria-label': 'Show' });
  pick.addEventListener('change', () => { show = pick.value; load(); });
  appendAll(panel, h('div', { class: 'week-bar' }, h('p', { class: 'muted small' }, 'Each report was checked against the schedule when it came in. A second miss at one address within 60 days is flagged to managers.'),
    h('div', { class: 'week-actions row' }, pick, can('counter') ? h('a', { class: 'btn primary', href: '#/requests?new=1&category=missed' }, 'New missed pickup') : null)), body);
  async function load() {
    clear(body).append(loading('Loading missed pickups'));
    let r;
    try { r = await get(`/solid-waste/collection/missed?show=${show}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body).append(r.data.length ? table([
      { head: 'Reported', cell: (m) => fmtInstant(m.reported_at) },
      { head: 'Where', cell: (m) => h('a', { href: `#/requests/r/${m.id}` }, m.place) },
      { head: 'What', cell: (m) => (m.stream ? chip(m.stream, m.stream_color) : '') },
      { head: 'Schedule check', cell: (m) => m.check_words || '' },
      { head: 'Status', cell: (m) => [state(m.status_words, m.status === 'new' ? 'warn' : ['fixed', 'closed_no_action'].includes(m.status) ? 'good' : 'neutral'), m.repeat ? [' ', state(`${m.repeat} in 60 days`, 'bad')] : null] },
      { head: 'Ref', cell: (m) => m.reference },
    ], r.data) : empty(show === 'open' ? 'No missed pickups are open.' : 'No missed pickups in the last 120 days.'));
  }
  await load();
}

// ================================================================ Schedule (managers)
let S = null;
const reloadSetup = async () => { S = await get('/solid-waste/collection/setup'); return S; };

export async function scheduleTab(panel) {
  try { await reloadSetup(); } catch (err) { panel.append(errorBox(err)); return; }
  panel.append(tabs([
    ['setup', 'Setup', setupPart],
    ['days', 'Holidays and changes', daysPart],
    ['residents', 'Reminders and education', residentsPart],
  ], 'setup', { param: 'part' }));
}

// ---------------------------------------------------------------- setup
async function setupPart(box) {
  const redraw = async () => { try { await reloadSetup(); } catch (err) { fail(err); return; } clear(box); draw(); };
  function draw() {
    const c = S.check;
    appendAll(box, h('div', { class: 'stack' },
      statusPanel(c, redraw),
      settingsPanel(redraw),
      streamsPanel(redraw),
      zonesPanel(redraw),
      unzonedPanel(redraw)));
  }
  draw();
}

function statusPanel(c, redraw) {
  const done = S.settings.setup_done;
  return h('section', { class: `panel stack cl-status${c.ok ? ' ok' : ''}`, 'aria-labelledby': 'cl-status-h' },
    h('h2', { id: 'cl-status-h' }, done ? 'The calendar is published' : 'Finish setup to publish the calendar'),
    done ? h('p', null, 'Residents look up their days at ', h('a', { href: S.page, target: '_blank', rel: 'noopener' }, S.page), '. Link it from your website’s trash page.') : h('p', null, 'Residents see the calendar once every street is in a zone or marked "not collected".'),
    c.problems.length ? h('ul', { class: 'cl-problems' }, c.problems.map((p) => h('li', null, p))) : h('p', null, state('Every street is covered', 'good')),
    c.partial.length ? h('p', { class: 'muted small' }, `Split by house numbers or sides, so check every house is covered: ${c.partial.map((s) => s.name).join(', ')}.`) : null,
    done ? null : h('div', { class: 'row' }, button('Finish setup', async () => {
      try { const r = await post('/solid-waste/collection/setup/finish'); toast('Published. Residents can look up their days now.'); await redraw(); return r; } catch (err) { fail(err); return null; }
    }, { kind: 'primary' })));
}

function settingsPanel(redraw) {
  const s = S.settings;
  const model = select(S.models.map((m) => [m.key, m.label]), s.model, { name: 'model' });
  const hauler = h('div', { class: 'form' },
    field('Hauler', input({ name: 'hauler_name', value: s.hauler_name || '', maxlength: 120 })), field('Phone residents call', input({ name: 'hauler_phone', value: s.hauler_phone || '', maxlength: 40, type: 'tel' })),
    field('Email', input({ name: 'hauler_email', value: s.hauler_email || '', maxlength: 255, type: 'email' })), field('Website', input({ name: 'hauler_url', value: s.hauler_url || '', maxlength: 255, placeholder: 'https://' })));
  const syncModel = () => { hauler.hidden = model.value !== 'contract'; };
  model.addEventListener('change', syncModel); syncModel();
  const rule = select(S.holiday_rules.map((r) => [r.key, r.label]), s.holiday_rule, { name: 'holiday_rule' });
  const hour = select([12, 13, 14, 15, 16, 17, 18, 19, 20].map((x) => [x, `${x > 12 ? x - 12 : x} PM`]), s.reminder_hour, { name: 'reminder_hour' });
  const curb = input({ name: 'curb_by', value: s.curb_by || '', maxlength: 80, placeholder: 'Carts at the curb by 6 AM' });
  const ord = h('textarea', { name: 'ordinance_materials', rows: 4, maxlength: 4000, placeholder: 'One a line, for example: Aluminum cans' }, s.ordinance_materials || '');
  const msg = h('div');
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'form' }, field('Who collects', model), field('Holidays', rule), field('Reminders go out at', hour, 'The evening before, until 9 PM'), field('What residents are told', curb, 'Shown on the calendar and in reminders')),
    hauler,
    field('Materials residents must separate (the recycling ordinance)', ord, 'Act 101 asks for at least three of the eight listed materials, plus leaf waste. Shown on the calendar page and the mailer.'),
    msg, h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg);
    const fd = new FormData(form); const v = (k) => String(fd.get(k) || '').trim();
    try {
      await put('/solid-waste/collection/settings', { model: v('model'), holiday_rule: v('holiday_rule'), reminder_hour: Number(v('reminder_hour')), curb_by: v('curb_by'), ordinance_materials: v('ordinance_materials'),
        ...(v('model') === 'contract' ? { hauler_name: v('hauler_name'), hauler_phone: v('hauler_phone'), hauler_email: v('hauler_email'), hauler_url: v('hauler_url') } : {}) });
      toast('Saved'); await redraw();
    } catch (err) { msg.append(errorBox(err)); }
  });
  return h('section', { class: 'panel stack', 'aria-labelledby': 'cl-settings-h' }, h('h2', { id: 'cl-settings-h' }, 'Who collects, and holidays'), form);
}

function streamsPanel(redraw) {
  return h('section', { class: 'panel stack', 'aria-labelledby': 'cl-streams-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-streams-h' }, 'Streams'), button('Add a stream', () => streamDialog(null, redraw), { small: true })),
    h('p', { class: 'muted small' }, 'What is collected: Trash, Recycling, Yard waste. Collected twice a week? Add a second stream, like "Trash, second day".'),
    S.streams.length ? table([
      { head: 'Stream', cell: (s) => [chip(s.name, s.color), s.active ? '' : [' ', state('Not collected now', 'neutral')]] },
      { head: 'How often', cell: (s) => `${FREQ.find((f) => f[0] === s.frequency)[1]}${s.anchor_date && s.frequency !== 'weekly' ? `, counting from ${fmtDay(s.anchor_date)}` : ''}` },
      { head: 'Season', cell: (s) => (s.season_start ? `${mmddWords(s.season_start)} to ${mmddWords(s.season_end)}` : 'All year') },
      { actions: true, cell: (s) => button('Edit', () => streamDialog(s, redraw), { small: true }) },
    ], S.streams) : empty('No streams yet. Add Trash first.'));
}

function streamDialog(s, done) {
  const cur = s || { name: '', kind: 'trash', frequency: 'weekly', anchor_date: '', season_start: '', season_end: '', color: '#2e7d32', materials: '', not_accepted: '', sort: (S.streams.length + 1) * 10, active: true };
  const freq = select(FREQ, cur.frequency, { name: 'frequency' });
  const anchor = input({ type: 'date', name: 'anchor_date', value: cur.anchor_date || '' });
  const anchorRow = field('A day it is collected', anchor, 'So we know which weeks (every other week) or which week of the month.');
  const sync = () => { anchorRow.hidden = freq.value === 'weekly'; };
  freq.addEventListener('change', sync); sync();
  const active = h('input', { type: 'checkbox', name: 'active', checked: cur.active });
  formDialog(s ? `Edit ${s.name}` : 'Add a stream', h('div', { class: 'form' },
    field('Name', input({ name: 'name', value: cur.name, maxlength: 60, required: true, placeholder: 'Recycling' })),
    field('Kind', select(S.kinds.map((k) => [k.key, k.label]), cur.kind, { name: 'kind' }), 'Recycling, yard waste and food scraps count toward the recycling rate.'),
    field('How often', freq), anchorRow,
    field('Season starts', input({ name: 'season_start', value: cur.season_start || '', placeholder: '04-01', pattern: '\\d{2}-\\d{2}', maxlength: 5 }), 'Month-day. Leave both empty for all year.'),
    field('Season ends', input({ name: 'season_end', value: cur.season_end || '', placeholder: '11-30', pattern: '\\d{2}-\\d{2}', maxlength: 5 })),
    field('Color', input({ type: 'color', name: 'color', value: cur.color })), field('Order', input({ type: 'number', name: 'sort', value: cur.sort, min: 0, max: 9999 })),
    h('div', { class: 'wide' }, field('What goes in (one a line)', h('textarea', { name: 'materials', rows: 4, maxlength: 4000 }, cur.materials || ''))),
    h('div', { class: 'wide' }, field('What does not (one a line)', h('textarea', { name: 'not_accepted', rows: 3, maxlength: 4000 }, cur.not_accepted || ''))),
    s ? h('label', { class: 'check wide' }, active, 'Collected now (untick to stop showing it)') : null), async (fd) => {
    const v = (k) => String(fd.get(k) || '').trim();
    const body = { name: v('name'), kind: v('kind'), frequency: v('frequency'), anchor_date: v('frequency') === 'weekly' ? null : v('anchor_date') || null, season_start: v('season_start') || null, season_end: v('season_end') || null,
      color: v('color'), sort: Number(v('sort')) || 0, materials: v('materials') || null, not_accepted: v('not_accepted') || null, ...(s ? { active: active.checked } : {}) };
    if (s) await patch(`/solid-waste/collection/streams/${s.id}`, body); else await post('/solid-waste/collection/streams', body);
    toast('Saved'); await done();
  }, { wide: true });
}

function zonesPanel(redraw) {
  const streamName = (id) => (S.streams.find((s) => s.id === id) || {}).name || 'Stream';
  return h('section', { class: 'panel stack', 'aria-labelledby': 'cl-zones-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-zones-h' }, 'Zones'), h('div', { class: 'row' },
    button('Add a zone', () => zoneDialog(null, redraw), { small: true }), button('Not collected', () => partsDialog(null, redraw), { small: true }))),
    h('p', { class: 'muted small' }, 'A zone is a part of town with its own days, like "Monday north". Add its streets, whole or by house numbers.'),
    S.zones.length ? h('ul', { class: 'plain stack' }, S.zones.map((z) => h('li', { class: 'cl-zone-row' },
      h('div', { class: 'spread' }, h('b', null, z.name, z.active ? '' : ' (not used now)'), h('div', { class: 'row' }, button('Days', () => zoneDialog(z, redraw), { small: true }), button('Streets', () => partsDialog(z, redraw), { small: true }))),
      h('p', null, z.days.length ? z.days.map((d) => `${streamName(d.stream_id)}: ${DAYS[d.weekday]}`).join('; ') : h('span', { class: 'warn' }, 'No collection days yet')),
      h('p', { class: 'muted small' }, z.streets.length ? `${plural(z.streets.length, 'street', 'streets')}: ${z.streets.slice(0, 8).map(partWords).join(', ')}${z.streets.length > 8 ? ', and more' : ''}` : 'No streets yet.')))) : empty('No zones yet.'),
    S.not_collected.length ? h('p', { class: 'muted small' }, `Not collected: ${S.not_collected.map(partWords).join(', ')}.`) : null);
}

function zoneDialog(z, done) {
  const cur = z || { name: '', sort: (S.zones.length + 1) * 10, active: true, days: [] };
  const daySel = S.streams.filter((s) => s.active).map((s) => ({ s, el: select([['', 'Not collected'], ...DAYS.slice(1).map((d, i) => [i + 1, d])], (cur.days.find((d) => d.stream_id === s.id) || {}).weekday || '', { 'aria-label': `${s.name} day` }) }));
  const active = h('input', { type: 'checkbox', checked: cur.active });
  formDialog(z ? `Edit ${z.name}` : 'Add a zone', h('div', { class: 'form' },
    field('Name', input({ name: 'name', value: cur.name, maxlength: 60, required: true, placeholder: 'Monday north' })), field('Order', input({ type: 'number', name: 'sort', value: cur.sort, min: 0, max: 9999 })),
    ...daySel.map((d) => field(d.s.name, d.el)),
    !S.streams.length ? h('p', { class: 'muted wide' }, 'Add a stream first, then give the zone its day.') : null,
    z ? h('label', { class: 'check wide' }, active, 'In use') : null), async (fd) => {
    const body = { name: String(fd.get('name') || '').trim(), sort: Number(fd.get('sort')) || 0, days: daySel.map((d) => ({ stream_id: d.s.id, weekday: d.el.value ? Number(d.el.value) : null })), ...(z ? { active: active.checked } : {}) };
    if (z) await patch(`/solid-waste/collection/zones/${z.id}`, body); else await post('/solid-waste/collection/zones', body);
    toast('Saved'); await done();
  }, { wide: true });
}

/** A zone's streets (zone null: the streets not collected): whole streets, or a house-number range on one or both sides. */
function partsDialog(z, done) {
  const list = h('div', { class: 'stack tight' });
  const row = (p = {}) => {
    const street = select([['', 'Pick a street'], ...S.streets.map((s) => [s.id, s.name])], p.street_id || '', { 'aria-label': 'Street' });
    const from = input({ type: 'number', min: 0, value: p.from_no ?? '', placeholder: 'From', 'aria-label': 'From house number' });
    const to = input({ type: 'number', min: 0, value: p.to_no ?? '', placeholder: 'To', 'aria-label': 'To house number' });
    const side = select(SIDES, p.side || 'both', { 'aria-label': 'Side' });
    const el = h('div', { class: 'row cl-part' }, street, from, to, side, button('Remove', () => el.remove(), { small: true }));
    el.value = () => (street.value ? { street_id: Number(street.value), from_no: from.value === '' ? null : Number(from.value), to_no: to.value === '' ? null : Number(to.value), side: side.value } : null);
    return el;
  };
  const parts = z ? z.streets : S.not_collected;
  list.append(...(parts.length ? parts : [{}]).map(row));
  formDialog(z ? `Streets in ${z.name}` : 'Streets the borough does not collect', h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, z ? 'Leave From and To empty for the whole street. A range or one side wins over a whole street, so a street split between zones can keep a whole-street row for the rest.' : 'Private streets, businesses or apartments with their own hauler. They are left off the schedule and the setup check.'),
    list, button('Add a street', () => list.append(row()), { small: true })), async () => {
    const streets = [...list.children].map((r) => r.value()).filter(Boolean);
    const r = z ? await put(`/solid-waste/collection/zones/${z.id}/streets`, { streets }) : await put('/solid-waste/collection/not-collected', { streets });
    toast(r.check.unzoned.length ? `Saved. ${plural(r.check.unzoned.length, 'street is', 'streets are')} still in no zone.` : 'Saved. Every street is in a zone or marked not collected.');
    await done();
  }, { wide: true });
}

/** The streets in no zone, each with a zone to put it in (whole) or "not collected", saved together. */
function unzonedPanel(redraw) {
  const list = S.check.unzoned;
  if (!list.length) return null;
  const picks = list.map((s) => ({ s, el: select([['', 'Choose'], ...S.zones.filter((z) => z.active).map((z) => [z.id, z.name]), ['none', 'Not collected']], '', { 'aria-label': `Zone for ${s.name}` }) }));
  return h('section', { class: 'panel stack', 'aria-labelledby': 'cl-unzoned-h' }, h('h2', { id: 'cl-unzoned-h' }, `Streets in no zone (${list.length})`),
    h('p', { class: 'muted small' }, 'Put each whole street in a zone here. To split a street by house numbers, use the zone’s Streets button.'),
    h('div', { class: 'cl-unzoned' }, picks.map((p) => field(p.s.name, p.el))),
    h('div', { class: 'row' }, button('Save these streets', async () => {
      const chosen = picks.filter((p) => p.el.value);
      if (!chosen.length) { toast('Choose a zone for at least one street', 'error'); return; }
      try {
        for (const z of S.zones) {
          const add = chosen.filter((p) => p.el.value === String(z.id)).map((p) => ({ street_id: p.s.id, from_no: null, to_no: null, side: 'both' }));
          if (add.length) await put(`/solid-waste/collection/zones/${z.id}/streets`, { streets: [...z.streets.map((x) => ({ street_id: x.street_id, from_no: x.from_no, to_no: x.to_no, side: x.side })), ...add] });
        }
        const none = chosen.filter((p) => p.el.value === 'none').map((p) => ({ street_id: p.s.id, from_no: null, to_no: null, side: 'both' }));
        if (none.length) await put('/solid-waste/collection/not-collected', { streets: [...S.not_collected.map((x) => ({ street_id: x.street_id, from_no: x.from_no, to_no: x.to_no, side: x.side })), ...none] });
        toast('Saved'); await redraw();
      } catch (err) { fail(err); }
    }, { kind: 'primary' })));
}

// ---------------------------------------------------------------- holidays, seasonal collections, changes
async function daysPart(box) {
  const redraw = async () => { try { await reloadSetup(); } catch (err) { fail(err); return; } clear(box); draw(); };
  const zoneNames = (ids) => (ids.length ? ids.map((id) => (S.zones.find((z) => z.id === id) || {}).name).filter(Boolean).join(', ') : 'Every zone');
  function draw() {
    const year = Number(S.today.slice(0, 4));
    appendAll(box, h('div', { class: 'stack' },
      h('section', { class: 'panel stack', 'aria-labelledby': 'cl-changes-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-changes-h' }, 'Moved or canceled days'), button('Move or cancel a day', () => changeDialog(redraw), { kind: 'primary', small: true })),
        h('p', { class: 'muted small' }, 'For snow, weather or anything else. The calendar, the feed and the reminders follow at once. A street notice to those zones is drafted for you to check and send.'),
        S.changes.length ? table([
          { head: 'Day', cell: (c) => fmtDay(c.on_date) },
          { head: 'Now', cell: (c) => (c.moved_to ? `Moved to ${fmtDay(c.moved_to)}` : state('Canceled', 'warn')) },
          { head: 'Zones', cell: (c) => zoneNames(c.zone_ids) },
          { head: 'Why', cell: (c) => [REASONS.find((r) => r[0] === c.reason)[1], c.note ? h('div', { class: 'muted small' }, c.note) : null] },
          { head: 'Notice', cell: (c) => (c.notice_id ? h('a', { href: '#/notices?tab=drafts' }, 'In Street notices') : '') },
          { actions: true, cell: (c) => button('Undo', () => confirmDialog('Undo this change?', 'The day goes back to the usual schedule. A notice already sent stays sent; send an update if residents need to know.', 'Undo', async () => { await del(`/solid-waste/collection/changes/${c.id}`); toast('Undone'); await redraw(); }), { small: true }) },
        ], S.changes) : empty('No days moved.')),
      h('section', { class: 'panel stack', 'aria-labelledby': 'cl-hol-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-hol-h' }, 'Holidays'),
        h('div', { class: 'row' }, button(`Add the federal holidays for ${year}`, () => federal(year, redraw), { small: true }), button(`For ${year + 1}`, () => federal(year + 1, redraw), { small: true }), button('Add a holiday', () => holidayDialog(redraw), { small: true }))),
        h('p', { class: 'muted small' }, `${(S.holiday_rules.find((r) => r.key === S.settings.holiday_rule) || {}).label}. Remove the holidays your crew works.`),
        S.holidays.length ? h('ul', { class: 'plain stack tight' }, S.holidays.map((x) => h('li', { class: 'spread' }, h('span', null, h('b', null, fmtDay(x.on_date)), ` ${x.name}`),
          button('Remove', async () => { try { await del(`/solid-waste/collection/holidays/${x.id}`); await redraw(); } catch (err) { fail(err); } }, { small: true })))) : empty('No holidays yet.')),
      h('section', { class: 'panel stack', 'aria-labelledby': 'cl-ev-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-ev-h' }, 'Seasonal collections'), button('Add one', () => eventDialog(null, redraw), { small: true })),
        h('p', { class: 'muted small' }, 'Leaf collection, Christmas trees, household hazardous waste days. Residents see them on the calendar and in the feed.'),
        S.events.length ? table([
          { head: 'What', cell: (e) => [h('b', null, e.name), h('div', { class: 'muted small' }, e.kind_label)] },
          { head: 'When', cell: (e) => (e.starts_on === e.ends_on ? fmtDay(e.starts_on) : `${fmtDate(e.starts_on)} to ${fmtDay(e.ends_on)}`) },
          { head: 'Zones', cell: (e) => zoneNames(e.zone_ids) },
          { actions: true, cell: (e) => h('div', { class: 'row' }, button('Edit', () => eventDialog(e, redraw), { small: true }), button('Delete', () => confirmDialog(`Delete ${e.name}?`, 'It comes off the calendar and the feed.', 'Delete', async () => { await del(`/solid-waste/collection/events/${e.id}`); await redraw(); }, { danger: true }), { small: true })) },
        ], S.events) : empty('No seasonal collections coming up.'))));
  }
  draw();
}

async function federal(year, done) {
  try { const r = await post('/solid-waste/collection/holidays/federal', { year }); toast(r.added ? `Added ${plural(r.added, 'holiday', 'holidays')}` : 'They were already on the list'); await done(); } catch (err) { fail(err); }
}
function holidayDialog(done) {
  formDialog('Add a holiday', h('div', { class: 'form' }, field('Day', input({ type: 'date', name: 'on_date', required: true })), field('Name', input({ name: 'name', maxlength: 80, required: true, placeholder: 'Day after Thanksgiving' }))), async (fd) => {
    await post('/solid-waste/collection/holidays', { on_date: String(fd.get('on_date')), name: String(fd.get('name')).trim() });
    toast('Added'); await done();
  });
}
const zoneChecks = (chosen = []) => S.zones.filter((z) => z.active).map((z) => ({ z, el: h('input', { type: 'checkbox', checked: chosen.includes(z.id) }) }));
function eventDialog(e, done) {
  const cur = e || { kind: 'leaf', name: '', starts_on: '', ends_on: '', notes: '', zone_ids: [] };
  const checks = zoneChecks(cur.zone_ids);
  formDialog(e ? `Edit ${e.name}` : 'Add a seasonal collection', h('div', { class: 'form' },
    field('Kind', select(S.event_kinds.map((k) => [k.key, k.label]), cur.kind, { name: 'kind' })), field('Name', input({ name: 'name', value: cur.name, maxlength: 120, required: true, placeholder: 'Leaf collection, week 1' })),
    field('First day', input({ type: 'date', name: 'starts_on', value: cur.starts_on ? String(cur.starts_on).slice(0, 10) : '', required: true })), field('Last day', input({ type: 'date', name: 'ends_on', value: cur.ends_on ? String(cur.ends_on).slice(0, 10) : '', required: true })),
    h('fieldset', { class: 'wide' }, h('legend', null, 'Zones (none ticked: every zone)'), h('div', { class: 'row' }, checks.map((c) => h('label', { class: 'check' }, c.el, c.z.name)))),
    h('div', { class: 'wide' }, field('What residents should know', h('textarea', { name: 'notes', rows: 3, maxlength: 2000 }, cur.notes || '')))), async (fd) => {
    const body = { kind: String(fd.get('kind')), name: String(fd.get('name')).trim(), starts_on: String(fd.get('starts_on')), ends_on: String(fd.get('ends_on')), notes: String(fd.get('notes') || '').trim() || null, zone_ids: checks.filter((c) => c.el.checked).map((c) => c.z.id) };
    if (e) await patch(`/solid-waste/collection/events/${e.id}`, body); else await post('/solid-waste/collection/events', body);
    toast('Saved'); await done();
  }, { wide: true });
}
function changeDialog(done) {
  const checks = zoneChecks();
  const cancel = h('input', { type: 'checkbox' });
  const moveTo = input({ type: 'date', name: 'moved_to', value: addDays(todayStr(), 1) });
  const moveRow = field('Move it to', moveTo);
  cancel.addEventListener('change', () => { moveRow.hidden = cancel.checked; });
  const notice = h('input', { type: 'checkbox', checked: true });
  formDialog('Move or cancel a collection day', h('div', { class: 'form' },
    field('The day', input({ type: 'date', name: 'on_date', value: todayStr(), required: true }), 'The day as it stands now, after any holiday move.'),
    moveRow, h('label', { class: 'check' }, cancel, 'Cancel it instead (no pickup that day)'),
    field('Why', select(REASONS, 'snow', { name: 'reason' })), field('Note for residents', input({ name: 'note', maxlength: 255, placeholder: 'Optional' })),
    h('fieldset', { class: 'wide' }, h('legend', null, 'Zones (none ticked: every zone)'), h('div', { class: 'row' }, checks.map((c) => h('label', { class: 'check' }, c.el, c.z.name)))),
    h('label', { class: 'check wide' }, notice, 'Draft a street notice to those zones (you check and send it in Street notices)')), async (fd) => {
    const r = await post('/solid-waste/collection/changes', { on_date: String(fd.get('on_date')), moved_to: cancel.checked ? null : moveTo.value || null, reason: String(fd.get('reason')), note: String(fd.get('note') || '').trim() || null,
      zone_ids: checks.filter((c) => c.el.checked).map((c) => c.z.id), notice: notice.checked });
    toast(r.notice_id ? 'Saved. The street notice is in Street notices, Drafts.' : 'Saved');
    await done();
  }, { wide: true });
}

// ---------------------------------------------------------------- reminders and the Act 101 education log
async function residentsPart(box) {
  let rem; let edu;
  try { [rem, edu] = await Promise.all([get('/solid-waste/collection/reminders'), get('/solid-waste/collection/education')]); } catch (err) { box.append(errorBox(err)); return; }
  const year = Number(S.today.slice(0, 4));
  const redraw = async () => { clear(box); await residentsPart(box); };
  appendAll(box, h('div', { class: 'stack' },
    h('section', { class: 'panel stack', 'aria-labelledby': 'cl-rem-h' }, h('h2', { id: 'cl-rem-h' }, 'Night-before reminders'),
      h('p', null, `${plural(rem.signups, 'sign-up gets', 'sign-ups get')} reminders: ${rem.texts} by text, ${rem.emails} by email. They go out from ${rem.hour > 12 ? rem.hour - 12 : rem.hour} PM the evening before.`),
      rem.streams.length ? h('p', { class: 'muted small' }, rem.streams.map((s) => `${s.name}: ${s.signups}`).join(' · ')) : null,
      h('p', { class: 'muted small' }, 'Residents sign up on the calendar page. They confirm their phone with a code or their email with a link, and a STOP or the link in any email stops them. You never see who signed up here.')),
    h('section', { class: 'panel stack', 'aria-labelledby': 'cl-edu-h' }, h('div', { class: 'spread' }, h('h2', { id: 'cl-edu-h' }, 'Act 101 education log'),
      h('div', { class: 'row' }, button(`Print the ${year} mailer`, () => mailer(year), { small: true }), button('Add an entry', () => eduDialog(edu.kinds, redraw), { small: true }))),
      h('p', { class: 'row' }, edu.overdue ? state(`Residents are due a reminder${edu.last_at ? ` (the last was ${fmtDay(edu.last_at)})` : ''}`, 'bad') : state(`Next reminder due by ${fmtDay(edu.next_due)}`, 'good'), ' ',
        edu.printed_this_year ? state(`A printed form went out in ${year}`, 'good') : state(`No printed form yet in ${year}`, 'warn')),
      h('p', { class: 'muted small' }, 'Act 101 asks you to remind residents at least every six months, with at least one printed form a year. Street notices about trash or leaves, and each month’s reminders, are added here by themselves.'),
      edu.entries.length ? table([
        { head: 'Date', cell: (e) => fmtDay(e.on_date) },
        { head: 'What', cell: (e) => [h('b', null, e.title), h('div', { class: 'muted small' }, e.kind_label)] },
        { head: 'Who it reached', cell: (e) => [e.audience || '', e.copies ? ` (${e.copies} copies)` : ''] },
        { actions: true, cell: (e) => (e.own && isManager() ? button('Delete', () => confirmDialog('Delete this entry?', 'It comes off the education log.', 'Delete', async () => { await del(`/solid-waste/collection/education/${e.id}`); await redraw(); }, { danger: true }), { small: true }) : '') },
      ], edu.entries) : empty('Nothing logged yet.'))));
}

function eduDialog(kinds, done) {
  formDialog('Add to the education log', h('div', { class: 'form' },
    field('Date', input({ type: 'date', name: 'on_date', value: todayStr(), required: true })), field('Kind', select(kinds.map((k) => [k.key, k.label]), 'mailer', { name: 'kind' })),
    h('div', { class: 'wide' }, field('What', input({ name: 'title', maxlength: 160, required: true, placeholder: '2027 collection calendar mailed to every household' }))),
    field('Who it reached', input({ name: 'audience', maxlength: 160, placeholder: 'Every household' })), field('Copies', input({ type: 'number', name: 'copies', min: 0 })),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'printed' }), 'It was printed (a mailer, a flyer, a bill insert)'),
    h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 500 })))), async (fd) => {
    const v = (k) => String(fd.get(k) || '').trim();
    await post('/solid-waste/collection/education', { on_date: v('on_date'), kind: v('kind'), title: v('title'), audience: v('audience') || null, copies: v('copies') ? Number(v('copies')) : null, note: v('note') || null, printed: fd.get('printed') === 'on' });
    toast('Logged'); await done();
  }, { wide: true });
}

/** The printable mailer: each zone's year, what goes in each stream, the ordinance's materials, holidays, how to sign up. */
async function mailer(year) {
  let m;
  try { m = await get(`/solid-waste/collection/mailer?year=${year}`); } catch (err) { fail(err); return; }
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const sheets = m.zones.map((z) => h('article', { class: 'sheet mailer-sheet', dataset: { sheet: 'mailer' } },
    h('header', null, h('h2', null, `${m.municipality}: trash and recycling ${year}`), h('p', null, h('b', null, z.name), ` · ${z.streams.map((s) => `${s.name} ${s.how_often}`).join(' · ')}`)),
    h('div', { class: 'mailer-months' }, months.map((mo) => {
      // One line a day: "5 Trash, Recycling*".
      const by = new Map();
      for (const d of z.days.filter((x) => x.date.startsWith(mo))) { if (!by.has(d.date)) by.set(d.date, []); by.get(d.date).push(`${d.stream}${d.moved ? '*' : ''}`); }
      return h('section', null, h('h3', null, monthOf(`${mo}-15`)), h('ul', null, [...by].map(([d, list]) => h('li', null, `${Number(d.slice(8, 10))} ${list.join(', ')}`))));
    })),
    h('p', { class: 'small' }, '* moved for a holiday. ', m.holiday_rule, '.', m.curb_by ? ` ${m.curb_by}.` : ''),
    z.events.length ? h('p', { class: 'small' }, h('b', null, 'Seasonal: '), z.events.map((e) => `${e.name} ${fmtDate(e.starts_on)}${e.ends_on !== e.starts_on ? ` to ${fmtDate(e.ends_on)}` : ''}`).join('; ')) : null,
    h('div', { class: 'mailer-what' }, m.streams.filter((s) => s.materials || s.not_accepted).map((s) => h('section', null, h('h3', null, s.name),
      s.materials ? h('p', { class: 'small' }, h('b', null, 'Yes: '), s.materials.split('\n').filter(Boolean).join(', ')) : null,
      s.not_accepted ? h('p', { class: 'small' }, h('b', null, 'No: '), s.not_accepted.split('\n').filter(Boolean).join(', ')) : null))),
    m.ordinance_materials ? h('p', { class: 'small' }, h('b', null, 'Our recycling ordinance asks you to separate: '), m.ordinance_materials.split('\n').filter(Boolean).join(', '), '.') : null,
    h('p', { class: 'small' }, `Look up your days and sign up for a reminder the night before: ${m.page}`, m.phone ? `. Questions: ${m.phone}` : '', m.hauler && m.hauler.phone ? `. Missed pickup: call ${m.hauler.name || 'the hauler'} at ${m.hauler.phone}` : '', '.')));
  printDialog(`The ${year} mailer`, sheets.length ? sheets : [h('p', null, 'Add zones first.')], [button('Log that it was mailed', () => { const d = document.querySelector('.print-overlay'); if (d) d.querySelector('.dialog-close, [aria-label="Close"]')?.click(); eduDialog([{ key: 'mailer', label: 'Printed mailer' }], async () => { toast('Logged'); }); })]);
}

export const helpers = { chip, partWords };
