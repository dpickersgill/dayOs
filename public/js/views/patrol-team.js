// Patrol team management: roster, today's posts, equipment checks, training log.

import { daysDialog } from './patrol-schedule.js';
import { get, post, patch, put, del } from '../api.js';
import { h, clear, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, table, val, num, todayStr, addDays, fmtDate, fmtDateLong, fmtDateTime, fmtTime, label, empty, isManager } from '../ui.js';
import { has, accessLevel } from './patrol-feat.js';
import { compact } from './patrol-case.js';

const LEVELS = ['candidate', 'patroller', 'senior', 'leader', 'director'];
const STATION_KINDS = [['aid_room', 'Aid room'], ['base', 'Base'], ['hut', 'Hut'], ['zone', 'Zone']];
const EQUIPMENT_KINDS = ['toboggan', 'aed', 'oxygen', 'trauma_bag', 'radio', 'splint_kit', 'other'];
const EQUIPMENT_STATUS = ['in_service', 'needs_attention', 'out_of_service', 'retired'];
const TRAINING_KINDS = [['oec', 'Outdoor emergency care'], ['refresher', 'Refresher'], ['ride_evac', 'Ride and evacuation'], ['toboggan', 'Toboggan handling'], ['avalanche', 'Avalanche'], ['cpr_aed', 'CPR and AED'], ['other', 'Other']];
const certTone = { current: 'good', expiring: 'warn', expired: 'bad', no_expiry: 'neutral' };
const certText = { current: 'current', expiring: 'expires soon', expired: 'expired', no_expiry: 'no expiry' };
const statusTone = { in_service: 'good', needs_attention: 'warn', out_of_service: 'bad', retired: 'neutral' };

const ACCESS = [['admin', 'Admin'], ['manager', 'Manager'], ['approver', 'Approver'], ['patrol', 'Patrol'], ['host', 'Host']];
const refresh = (box, draw) => async () => { const n = h('div'); await draw(n); clear(box).append(...n.childNodes); };

// ---------------------------------------------------------------- roster
export async function drawTeam(box, { canLead }) {
  const { data } = await get('/patrol/team');
  const mgr = has('manage_team');
  const again = refresh(box, (n) => drawTeam(n, { canLead }));
  const cols = [
    // One roster: managers can open the person's full staff record (certifications, availability, shifts) from here.
    { head: 'Name', cell: (m) => h('span', null, isManager() && m.on_staff_list ? h('a', { href: `#/workforce/staff/${m.staff_id}` }, h('b', null, `${m.first_name} ${m.last_name}`)) : h('b', null, `${m.first_name} ${m.last_name}`), m.staff_status !== 'active' ? h('span', { class: 'muted' }, ' (not active)') : null, h('small', { class: 'muted' }, m.on_staff_list ? ' Paid' : ' Volunteer')) },
    { head: 'Rank', cell: (m) => label(m.level) },
    { head: 'Access', cell: (m) => label(m.access_level || 'patrol') },
    { head: 'Callsign', cell: (m) => m.callsign || '' },
    { head: 'Patrol no.', cell: (m) => m.patrol_number || '' },
    { head: 'Certifications', cell: (m) => (m.certifications.length ? h('span', { class: 'chips' }, m.certifications.map((c) => state(`${c.name}: ${certText[c.state]}`, certTone[c.state]))) : h('span', { class: 'muted' }, 'None on file')) },
    { head: 'Training this season', num: true, cell: (m) => `${m.training_hours_season} h` },
    { head: 'Cases led', num: true, cell: (m) => m.cases_led_season },
  ];
  if (mgr) {
    cols.splice(3, 0, { head: 'Contact', cell: (m) => [m.phone, m.email].filter(Boolean).join(', ') }, { head: 'Emergency contact', cell: (m) => m.emergency_contact || '' });
    cols.push({ head: '', actions: true, cell: (m) => button('Edit', () => memberDialog(m, again), { small: true }) });
  }
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'The patrol roster is kept here. Volunteers are on it only; paid patrollers are also on the staff list.'),
      h('div', { class: 'row' }, button('Days patrolled', () => daysDialog(), { small: true }), mgr ? button('Add to roster', () => addMemberDialog(data, again), { kind: 'primary' }) : null)),
    data.length ? table(cols, data) : empty(mgr ? 'No one is on the patrol roster yet. Add your patrollers, volunteers included.' : 'The patrol roster is empty.')));
}

/**
 * Put someone on the roster: a new person (a volunteer, or anyone not on the staff list), or someone already on the
 * staff list (a paid patroller, whose pay and time clock stay in Staff and schedule).
 */
async function addMemberDialog(roster, again) {
  let staff = [];
  try { staff = (await get('/workforce/staff?status=active')).data; } catch (_) { /* no access to the staff list: new people only */ }
  const onRoster = new Set(roster.map((m) => Number(m.staff_id)));
  const options = staff.filter((s) => !onRoster.has(Number(s.id)));
  let mode = 'new';
  const modeBox = h('div', { class: 'seg day-seg', role: 'group', 'aria-label': 'Who' });
  const newBox = h('div', { class: 'form' }, field('First name', input({ name: 'first_name', maxlength: 100 })), field('Last name', input({ name: 'last_name', maxlength: 100 })),
    field('Email', input({ name: 'email', type: 'email', maxlength: 255 }), 'Optional. Needed for a login.'), field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40 })));
  const staffBox = h('div', { class: 'form', hidden: true }, options.length ? field('Staff member', select(options.map((s) => [s.id, `${s.first_name} ${s.last_name}`]), '', { name: 'staff_id' }))
    : h('p', { class: 'muted' }, 'Everyone on the staff list is already on the roster.'));
  const drawMode = () => {
    clear(modeBox).append(...[['new', 'New patroller'], ['staff', 'From the staff list (paid)']].map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(mode === k), onclick: () => { mode = k; newBox.hidden = k !== 'new'; staffBox.hidden = k !== 'staff'; drawMode(); } }, t)));
  };
  drawMode();
  formDialog('Add to patrol roster', h('div', { class: 'stack' }, modeBox,
    h('p', { class: 'muted small' }, 'A new patroller is kept in Patrol only (right for volunteers). Someone from the staff list is also paid and clocks in through Staff and schedule.'),
    newBox, staffBox,
    h('div', { class: 'form' }, field('Rank', select(LEVELS, 'patroller', { name: 'level' })), field('Callsign', input({ name: 'callsign', maxlength: 30 })),
      field('Patrol number', input({ name: 'patrol_number', maxlength: 20 }), 'Printed on the reports they complete'), field('Emergency contact', input({ name: 'emergency_contact', maxlength: 255 })))),
  async (fd) => {
    const who = mode === 'staff' ? { staff_id: num(fd, 'staff_id') } : { person: compact({ first_name: val(fd, 'first_name'), last_name: val(fd, 'last_name'), email: val(fd, 'email'), phone: val(fd, 'phone') }) };
    if (mode === 'staff' && !who.staff_id) throw new Error('Choose someone from the staff list');
    if (mode === 'new' && (!who.person.first_name || !who.person.last_name)) throw new Error('Enter their first and last name');
    await post('/patrol/team', compact({ ...who, level: val(fd, 'level'), callsign: val(fd, 'callsign'), patrol_number: val(fd, 'patrol_number'), emergency_contact: val(fd, 'emergency_contact') }));
    toast('Added to roster');
    await again();
  }, { submitText: 'Add to roster' });
}

function memberDialog(m, again) {
  const d = formDialog(`${m.first_name} ${m.last_name}`, h('div', { class: 'form' },
    field('First name', input({ name: 'first_name', value: m.first_name || '', maxlength: 100, required: true })),
    field('Last name', input({ name: 'last_name', value: m.last_name || '', maxlength: 100, required: true })),
    field('Email', input({ name: 'email', type: 'email', value: m.email || '', maxlength: 255 })),
    field('Phone', input({ name: 'phone', type: 'tel', value: m.phone || '', maxlength: 40 })),
    field('Rank', select(LEVELS, m.level, { name: 'level' })),
    accessLevel() === 'admin' ? field('Access level', select(ACCESS, m.access_level || 'patrol', { name: 'access_level' })) : null,
    field('Callsign', input({ name: 'callsign', value: m.callsign || '', maxlength: 30 })),
    field('Patrol number', input({ name: 'patrol_number', value: m.patrol_number || '', maxlength: 20 }), 'Printed on the reports they complete'),
    h('div', { class: 'wide' }, field('Emergency contact', input({ name: 'emergency_contact', value: m.emergency_contact || '', maxlength: 255 }))),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', value: m.notes || '', maxlength: 500 }))),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'on_staff_list', checked: Boolean(m.on_staff_list) }), ' Paid: also on the staff list, for pay and the time clock')),
  async (fd) => {
    if (fd.get('access_level') && fd.get('access_level') !== (m.access_level || 'patrol')) await put(`/patrol/team/${m.staff_id}/access`, { access_level: fd.get('access_level') });
    await patch(`/patrol/team/${m.staff_id}`, { first_name: val(fd, 'first_name'), last_name: val(fd, 'last_name'), email: val(fd, 'email'), phone: val(fd, 'phone'), on_staff_list: Boolean(fd.get('on_staff_list')),
      level: val(fd, 'level'), callsign: val(fd, 'callsign'), patrol_number: val(fd, 'patrol_number'), emergency_contact: val(fd, 'emergency_contact'), notes: val(fd, 'notes') });
    toast('Saved');
    await again();
  });
  d.body.append(button('Remove from roster', () => confirmDialog('Remove from roster?', `${m.first_name} ${m.last_name} comes off the patrol shifts still ahead (left open for someone else). Their cases and training stay on record.`, 'Remove', async () => { await del(`/patrol/team/${m.staff_id}`); d.close(); toast('Removed from roster'); await again(); }, { danger: true }), { small: true }));
}

// ---------------------------------------------------------------- today's posts
export async function drawPosts(box, { canLead }, date = todayStr()) {
  const [dep, { data: stations }, { data: roster }] = await Promise.all([get(`/patrol/deployments?date=${date}`), get('/patrol/stations'), get('/patrol/team')]);
  const again = () => refresh(box, (n) => drawPosts(n, { canLead }, date))();
  const go = (d) => refresh(box, (n) => drawPosts(n, { canLead }, d))();
  const dateInput = input({ type: 'date', value: date, 'aria-label': 'Day' });
  dateInput.addEventListener('change', () => dateInput.value && go(dateInput.value));
  const missing = dep.scheduled.filter((s) => !s.deployed);
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' },
      h('div', { class: 'row' }, button('Previous day', () => go(addDays(date, -1)), { small: true }), h('strong', null, fmtDateLong(date)), button('Next day', () => go(addDays(date, 1)), { small: true }), dateInput),
      canLead ? h('div', { class: 'row' }, button('Edit posts', () => postsDialog(dep, stations, roster, date, again), { kind: 'primary' }), button('Stations', () => stationsDialog(stations, again)) ) : null),
    missing.length ? h('p', { class: 'warn-note', role: 'status' }, `Scheduled on patrol but not posted: ${missing.map((s) => `${s.first_name} ${s.last_name}`).join(', ')}`) : null,
    h('h2', null, 'Posts'),
    dep.assignments.length ? table([{ head: 'Patroller', cell: (a) => `${a.first_name} ${a.last_name}` }, { head: 'Station', cell: (a) => a.station || 'Roving' }, { head: 'Role', cell: (a) => a.role_label || '' }, { head: 'Callsign', cell: (a) => a.callsign || '' }], dep.assignments) : empty('No one is posted for this day yet.'),
    h('h2', null, 'Scheduled for patrol'),
    dep.scheduled.length ? table([{ head: 'Patroller', cell: (s) => `${s.first_name} ${s.last_name}` }, { head: 'Shift', cell: (s) => `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}` }, { head: 'Position', cell: (s) => s.position }, { head: 'Posted', cell: (s) => (s.deployed ? state('Posted', 'good') : state('Not posted', 'warn')) }], dep.scheduled) : h('p', { class: 'muted' }, 'No patrol shifts are scheduled for this day. Add them on Staff and schedule.')));
}

function postsDialog(dep, stations, roster, date, again) {
  const members = roster.filter((m) => m.staff_status === 'active');
  const rows = h('div', { class: 'stack' });
  const addRow = (a = {}) => {
    const staff = select([['', 'Choose a patroller'], ...members.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`])], a.staff_id || '', { 'aria-label': 'Patroller', class: 'p-staff' });
    const station = select([['', 'Roving'], ...stations.map((s) => [s.id, s.name])], a.station_id || '', { 'aria-label': 'Station', class: 'p-station' });
    const role = input({ 'aria-label': 'Role', placeholder: 'Role', value: a.role_label || '', maxlength: 60, class: 'p-role' });
    const call = input({ 'aria-label': 'Callsign', placeholder: 'Callsign', value: a.callsign || '', maxlength: 30, class: 'p-call' });
    const gone = button('Remove', () => row.remove(), { small: true });
    const row = h('div', { class: 'post-row' }, staff, station, role, call, gone);
    rows.append(row);
  };
  (dep.assignments.length ? dep.assignments : []).forEach(addRow);
  const prefill = button('Add scheduled patrollers', () => {
    const have = new Set([...rows.querySelectorAll('.p-staff')].map((s) => Number(s.value)));
    for (const s of dep.scheduled) if (!have.has(s.staff_id) && members.some((m) => m.staff_id === s.staff_id)) addRow({ staff_id: s.staff_id });
  }, { small: true });
  const d = formDialog(`Posts for ${fmtDate(date)}`, h('div', { class: 'stack' }, rows, h('div', { class: 'row' }, button('Add a row', () => addRow(), { small: true }), prefill)),
    async () => {
      const assignments = [...rows.querySelectorAll('.post-row')].map((r) => ({ staff_id: Number(r.querySelector('.p-staff').value), station_id: r.querySelector('.p-station').value ? Number(r.querySelector('.p-station').value) : null, role_label: r.querySelector('.p-role').value.trim() || null, callsign: r.querySelector('.p-call').value.trim() || null }));
      if (assignments.some((a) => !a.staff_id)) throw new Error('Choose a patroller on every row, or remove the empty row');
      await put(`/patrol/deployments/${date}`, { assignments });
      toast('Posts saved');
      await again();
    }, { wide: true, submitText: 'Save posts' });
  return d;
}

function stationsDialog(stations, again) {
  const list = h('ul', { class: 'plain' }, stations.map((s) => h('li', { class: 'spread' }, h('span', null, s.name, h('span', { class: 'muted' }, ` ${label(s.kind)}`)),
    has('manage_equipment') ? button('Remove', () => confirmDialog('Remove station?', `${s.name} is removed. Past posts keep their record.`, 'Remove', async () => { await del(`/patrol/stations/${s.id}`); d.close(); await again(); }, { danger: true }), { small: true }) : null)));
  const name = input({ name: 'name', maxlength: 100, required: true });
  const kind = select(STATION_KINDS, 'zone', { name: 'kind' });
  const add = button('Add station', async () => { if (!name.value.trim()) throw new Error('Name the station'); await post('/patrol/stations', { name: name.value.trim(), kind: kind.value }); d.close(); toast('Station added'); await again(); }, { kind: 'primary' });
  const d = dialog('Patrol stations', [stations.length ? list : h('p', { class: 'muted' }, 'No stations yet. Add the aid room, huts and zones where patrollers are posted.'), h('div', { class: 'form' }, field('Name', name), field('Kind', kind)), h('div', { class: 'row' }, add)]);
}

// ---------------------------------------------------------------- equipment
export async function drawEquipment(box, { canLead }) {
  const [{ data }, { data: stations }] = await Promise.all([get('/patrol/equipment'), get('/patrol/stations')]);
  const again = refresh(box, (n) => drawEquipment(n, { canLead }));
  const bad = data.filter((e) => ['needs_attention', 'out_of_service'].includes(e.status));
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Any patroller can log a check. A failed check shows here for everyone.'), canLead ? button('Add equipment', () => equipmentDialog(null, stations, again), { kind: 'primary' }) : null),
    bad.length ? h('p', { class: 'warn-note', role: 'status' }, `${bad.length} item${bad.length === 1 ? '' : 's'} need attention: ${bad.map((e) => e.name).join(', ')}`) : null,
    data.length ? table([
      { head: 'Item', cell: (e) => h('span', null, h('b', null, e.name), e.serial ? h('span', { class: 'muted' }, ` ${e.serial}`) : null) },
      { head: 'Kind', cell: (e) => label(e.kind) }, { head: 'Where', cell: (e) => e.station || '' },
      { head: 'Status', cell: (e) => state(label(e.status), statusTone[e.status]) },
      { head: 'Last check', cell: (e) => (e.last_checked_at ? `${fmtDateTime(e.last_checked_at)}, ${label(e.last_result)}${e.last_reading ? ` (${e.last_reading})` : ''}` : h('span', { class: 'muted' }, 'Never checked')) },
      { head: '', actions: true, cell: (e) => h('span', { class: 'row' }, e.status !== 'retired' ? button('Log check', () => checkDialog(e, again, canLead), { small: true }) : null, canLead && ['needs_attention', 'out_of_service'].includes(e.status) ? button('Clear for use', () => clearDialog(e, again), { small: true, kind: 'primary' }) : null, button('History', () => historyDialog(e), { small: true }), canLead ? button('Edit', () => equipmentDialog(e, stations, again), { small: true }) : null) },
    ], data) : empty(canLead ? 'No equipment yet. Add toboggans, AEDs, oxygen and radios so checks can be logged.' : 'No equipment has been added yet.')));
}

function checkDialog(e, again, canLeadHere = false) {
  formDialog(`Check: ${e.name}`, h('div', { class: 'form' },
    field('Result', select([...(e.status === 'in_service' || canLeadHere ? [['ok', 'OK, ready to use']] : []), ['needs_attention', 'Needs attention'], ['out_of_service', 'Out of service']], e.status === 'in_service' || canLeadHere ? 'ok' : 'needs_attention', { name: 'result' })),
    field('Reading', input({ name: 'reading', maxlength: 40, placeholder: e.kind === 'aed' ? 'Battery 100%' : e.kind === 'oxygen' ? 'Tank 2000 psi' : '' })),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255 })))),
  async (fd) => { await post(`/patrol/equipment/${e.id}/checks`, compact({ result: val(fd, 'result'), reading: val(fd, 'reading'), notes: val(fd, 'notes') })); toast('Check logged'); await again(); });
}

function clearDialog(e, again) {
  formDialog(`Clear for use: ${e.name}`, h('div', { class: 'form' },
    h('p', { class: 'wide muted' }, 'This puts the item back in service and records who cleared it and why.'),
    h('div', { class: 'wide' }, field('What was done', input({ name: 'notes', required: true, minlength: 3, maxlength: 240, placeholder: 'New battery fitted, tested OK' })))),
  async (fd) => { await post(`/patrol/equipment/${e.id}/clear`, { notes: val(fd, 'notes') }); toast('Cleared for use'); await again(); }, { submitText: 'Clear for use' });
}

async function historyDialog(e) {
  const { data } = await get(`/patrol/equipment/${e.id}/checks`);
  dialog(`History: ${e.name}`, data.length ? table([{ head: 'When', cell: (c) => fmtDateTime(c.checked_at) }, { head: 'Result', cell: (c) => label(c.result) }, { head: 'Reading', cell: (c) => c.reading || '' }, { head: 'Notes', cell: (c) => c.notes || '' }, { head: 'By', cell: (c) => c.checked_by || '' }], data) : h('p', { class: 'muted' }, 'No checks yet.'), { wide: true });
}

function equipmentDialog(e, stations, again) {
  formDialog(e ? 'Edit equipment' : 'Add equipment', h('div', { class: 'form' },
    field('Name', input({ name: 'name', value: e ? e.name : '', required: true, maxlength: 100 })), field('Kind', select(EQUIPMENT_KINDS, e ? e.kind : 'other', { name: 'kind' })),
    field('Serial number', input({ name: 'serial', value: e && e.serial ? e.serial : '', maxlength: 60 })), field('Stored at', select([['', 'Not assigned'], ...stations.map((s) => [s.id, s.name])], e && e.station_id ? e.station_id : '', { name: 'station_id' })),
    e ? field('Status', select(EQUIPMENT_STATUS, e.status, { name: 'status' })) : null),
  async (fd) => {
    const body = { name: val(fd, 'name'), kind: val(fd, 'kind'), serial: val(fd, 'serial'), station_id: num(fd, 'station_id') };
    if (e) await patch(`/patrol/equipment/${e.id}`, { ...body, status: val(fd, 'status') }); else await post('/patrol/equipment', compact({ ...body, serial: body.serial, station_id: body.station_id }));
    toast('Saved');
    await again();
  });
}

// ---------------------------------------------------------------- training
export async function drawTraining(box, { canLead, staffId }) {
  const [{ data }, { data: roster }] = await Promise.all([get('/patrol/training'), get('/patrol/team')]);
  const again = refresh(box, (n) => drawTraining(n, { canLead, staffId }));
  const mgr = has('manage_training');
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Hours count toward each patroller\'s season total on the Team tab.'), button('Log training', () => trainingDialog(roster, { canLead, staffId }, again), { kind: 'primary' })),
    data.length ? table([
      { head: 'Date', cell: (t) => fmtDate(t.completed_on) }, { head: 'Patroller', cell: (t) => `${t.first_name} ${t.last_name}` }, { head: 'Training', cell: (t) => t.title },
      { head: 'Kind', cell: (t) => (TRAINING_KINDS.find((k) => k[0] === t.kind) || [0, label(t.kind)])[1] }, { head: 'Hours', num: true, cell: (t) => t.hours }, { head: 'Notes', cell: (t) => t.notes || '' },
      mgr ? { head: '', actions: true, cell: (t) => button('Remove', () => confirmDialog('Remove this record?', `${t.title} for ${t.first_name} ${t.last_name}`, 'Remove', async () => { await del(`/patrol/training/${t.id}`); await again(); }, { danger: true }), { small: true }) } : { head: '', cell: () => '' },
    ], data) : empty('No training has been logged yet.')));
}

function trainingDialog(roster, { canLead, staffId }, again) {
  const members = roster.filter((m) => m.staff_status === 'active');
  formDialog('Log training', h('div', { class: 'form' },
    canLead ? field('Patroller', select(members.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), staffId || '', { name: 'staff_id' })) : null,
    field('Date', input({ type: 'date', name: 'completed_on', value: todayStr(), required: true })), field('Training', input({ name: 'title', required: true, maxlength: 150, placeholder: 'Toboggan refresher' })),
    field('Kind', select(TRAINING_KINDS, 'other', { name: 'kind' })), field('Hours', input({ name: 'hours', type: 'number', step: '0.25', min: 0, max: 200, required: true })),
    h('div', { class: 'wide' }, field('Notes', input({ name: 'notes', maxlength: 255 })))),
  async (fd) => { await post('/patrol/training', compact({ staff_id: canLead ? num(fd, 'staff_id') : null, completed_on: val(fd, 'completed_on'), title: val(fd, 'title'), kind: val(fd, 'kind'), hours: num(fd, 'hours'), notes: val(fd, 'notes') })); toast('Training logged'); await again(); });
}
