import { get, post, put, patch, del } from '../api.js';
import { h, clear, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, tabs, val, num, todayStr, addDays, weekStart, fmtDate, fmtDateLong, fmtTime, fmtDateTime, dayOf, label, empty, errorBox } from '../ui.js';
import { availabilityDialog } from './myshifts.js';
import { drawKiosk } from './kiosk-admin.js';

const DEPARTMENTS = ['lifts', 'rentals', 'ski_school', 'patrol', 'food', 'guest_services', 'grooming', 'maintenance', 'admin'];
const STAFF_STATUS = ['applicant', 'onboarding', 'active', 'inactive'];
const fullName = (s) => `${s.first_name} ${s.last_name}`;

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Staff and schedule')),
    tabs([['schedule', 'Schedule', drawSchedule], ['staff', 'Staff', drawStaff], ['positions', 'Positions and certifications', drawPositions], ['time', 'Hours worked', drawTime], ['kiosk', 'Time clock kiosk', drawKiosk]]));
}

// ---------------------------------------------------------------- schedule
async function drawSchedule(box) {
  let start = weekStart(todayStr());
  const [positions, staff] = await Promise.all([get('/workforce/positions?limit=500'), get('/workforce/staff?status=active')]);
  const body = h('div');
  const label_ = h('h2');
  const nav = h('div', { class: 'week-nav' },
    button('Previous week', () => { start = addDays(start, -7); return load(); }, { small: true }),
    button('This week', () => { start = weekStart(todayStr()); return load(); }, { small: true }),
    button('Next week', () => { start = addDays(start, 7); return load(); }, { small: true }), label_);
  const tools = h('div', { class: 'row' },
    button('Add shift', () => addShift(positions.data, staff.data, start, load), { kind: 'primary' }),
    button('Publish this week', () => publish(start, load)),
    button('Staffing needs', () => needs(start)));
  clear(box).append(h('div', { class: 'stack' }, nav, tools, body));

  async function load() {
    const end = addDays(start, 6);
    label_.textContent = `${fmtDate(start)} to ${fmtDate(end)}`;
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/workforce/shifts?from=${start}&to=${end}`);
      clear(body);
      if (!data.length) { body.append(empty('No shifts this week. Add the first one.')); return; }
      const draft = data.filter((s) => s.status === 'draft').length;
      const unfilled = data.filter((s) => !s.staff_id).length;
      body.append(h('p', { class: 'muted' }, `${data.length} shifts, ${unfilled} unfilled, ${draft} not yet published.`));
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i);
        const day = data.filter((s) => dayOf(s.starts_at) === d);
        if (!day.length) continue;
        body.append(h('div', { class: 'day-block' }, h('h3', null, fmtDateLong(d)), table([
          { head: 'Time', cell: (s) => `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}` },
          { head: 'Position', cell: (s) => h('span', null, h('strong', null, s.position), h('span', { class: 'muted' }, `  ${label(s.department)}`)) },
          { head: 'Assigned', cell: (s) => (s.staff_id ? `${s.first_name} ${s.last_name}` : state('Unfilled', 'warn')) },
          { head: 'Status', cell: (s) => state(label(s.status), s.status === 'published' ? 'good' : 'neutral') },
          { head: '', actions: true, cell: (s) => [
            button(s.staff_id ? 'Change' : 'Assign', () => assign(s, staff.data, load), { small: true }),
            button('Cancel shift', () => confirmDialog('Cancel this shift?', `${s.position}, ${fmtDateTime(s.starts_at)}.`, 'Cancel shift', async () => { await del(`/workforce/shifts/${s.id}`); toast('Shift cancelled'); await load(); }, { danger: true }), { small: true, kind: 'danger' }),
          ] },
        ], day, { rowClass: (s) => (s.staff_id ? null : 'attention') })));
      }
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function staffOptions(staff, blank) {
  return [...(blank ? [['', blank]] : []), ...staff.map((s) => [s.id, fullName(s)])];
}

function addShift(positions, staff, start, done) {
  if (!positions.length) { toast('Add a position first, on the Positions tab', 'error'); return; }
  const f = h('div', { class: 'form' },
    field('Position', select(positions.map((p) => [p.id, `${p.name} (${label(p.department)})`]), positions[0].id, { name: 'position_id' })),
    field('Starts', input({ type: 'datetime-local', name: 'starts_at', value: `${todayStr()}T08:00`, required: true })),
    field('Ends', input({ type: 'datetime-local', name: 'ends_at', value: `${todayStr()}T16:00`, required: true })),
    field('Assign now', select(staffOptions(staff, 'Leave unfilled'), '', { name: 'staff_id' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'override' }), 'Allow outside their availability'));
  formDialog('Add a shift', f, async (fd) => {
    await post('/workforce/shifts', { position_id: num(fd, 'position_id'), starts_at: val(fd, 'starts_at'), ends_at: val(fd, 'ends_at'), staff_id: num(fd, 'staff_id') || undefined, override_availability: Boolean(fd.get('override')) });
    toast('Shift added as a draft');
    await done();
  }, { submitText: 'Add shift' });
}

function assign(shift, staff, done) {
  const f = h('div', { class: 'stack' },
    field('Who', select(staffOptions(staff, 'Nobody (unassign)'), shift.staff_id || '', { name: 'staff_id' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'override' }), 'Allow outside their availability'),
    h('p', { class: 'muted small' }, 'Certifications, overlapping shifts and lessons are always checked.'));
  formDialog(`${shift.position}, ${fmtDateTime(shift.starts_at)}`, f, async (fd) => {
    await patch(`/workforce/shifts/${shift.id}/assign`, { staff_id: num(fd, 'staff_id') || null, override_availability: Boolean(fd.get('override')) });
    toast('Shift updated');
    await done();
  }, { submitText: 'Save' });
}

function publish(start, done) {
  const end = addDays(start, 6);
  confirmDialog('Publish this week?', `Every draft shift from ${fmtDate(start)} to ${fmtDate(end)} becomes visible to staff.`, 'Publish', async () => {
    const out = await post('/workforce/shifts/publish', { from: start, to: end });
    toast(`${out.published} shift${out.published === 1 ? '' : 's'} published`);
    await done();
  });
}

async function needs(start) {
  const date = input({ type: 'date', value: todayStr() });
  const forecast = input({ type: 'number', min: 0, placeholder: 'Use tickets sold' });
  const out = h('div');
  async function run() {
    clear(out);
    try {
      const q = `date=${date.value}${forecast.value !== '' ? `&forecast=${forecast.value}` : ''}`;
      const r = await get(`/workforce/staffing-suggestion?${q}`);
      out.append(h('p', { class: 'muted' }, `${r.forecast_visits} expected guests (${r.basis === 'override' ? 'your number' : 'tickets already sold for this day'}).`),
        r.data.length ? table([
          { head: 'Position', cell: (p) => p.position },
          { head: 'Needed', num: true, cell: (p) => String(p.suggested) },
          { head: 'Scheduled', num: true, cell: (p) => String(p.scheduled) },
          { head: 'Gap', num: true, cell: (p) => (p.gap > 0 ? state(`${p.gap} short`, 'warn') : state('Covered', 'good')) },
        ], r.data) : empty('No positions have "guests per staff member" set yet. Set it on the Positions tab.'));
    } catch (err) { out.append(errorBox(err)); }
  }
  dialog('Staffing needs for a day', [h('div', { class: 'inline-form' }, field('Day', date), field('Expected guests', forecast), button('Check', run, { kind: 'primary' })), out], { wide: true });
}

// ---------------------------------------------------------------- staff
async function drawStaff(box) {
  const [{ data }, expiring, certs] = await Promise.all([get('/workforce/staff'), get('/workforce/certifications-expiring?days=45'), get('/workforce/certifications?limit=500')]);
  const reload = async () => { const n = h('div'); await drawStaff(n); clear(box).append(...n.childNodes); };
  const parts = [h('div', { class: 'row' }, button('Add staff member', () => addStaff(reload), { kind: 'primary' }))];
  if (expiring.data.length) {
    parts.push(h('section', { class: 'section' }, h('header', null, h('h2', null, 'Certifications expiring within 45 days')),
      table([{ head: 'Person', cell: (r) => `${r.first_name} ${r.last_name}` }, { head: 'Certification', cell: (r) => r.certification }, { head: 'Expires', cell: (r) => fmtDate(r.expires_on) }], expiring.data)));
  }
  parts.push(data.length ? table([
    { head: 'Name', cell: (s) => h('strong', null, fullName(s)) },
    { head: 'Contact', cell: (s) => [s.email, s.phone].filter(Boolean).join('  ') },
    { head: 'Status', cell: (s) => state(label(s.status), s.status === 'active' ? 'good' : 'neutral') },
    { head: 'Housing', cell: (s) => (s.needs_housing ? 'Needs housing' : '') },
    { head: '', actions: true, cell: (s) => [
      button('Status', () => setStatus(s, reload), { small: true }),
      button('Certifications', () => staffCerts(s, certs.data), { small: true }),
      button('Availability', () => availabilityDialog(s.id, fullName(s)), { small: true }),
    ] },
  ], data) : empty('No staff yet. Add your first team member.'));
  clear(box).append(h('div', { class: 'stack' }, parts));
}

function addStaff(done) {
  const f = h('div', { class: 'form' },
    field('First name', input({ name: 'first', required: true })), field('Last name', input({ name: 'last', required: true })),
    field('Email', input({ name: 'email', type: 'email' })), field('Phone', input({ name: 'phone', type: 'tel' })),
    field('Status', select(STAFF_STATUS, 'onboarding', { name: 'status' })), field('Hired on', input({ name: 'hired_on', type: 'date' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'housing' }), 'Needs staff housing'));
  formDialog('Add a staff member', f, async (fd) => {
    await post('/workforce/staff', { person: { first_name: val(fd, 'first'), last_name: val(fd, 'last'), email: val(fd, 'email') || undefined, phone: val(fd, 'phone') || undefined }, status: val(fd, 'status'), hired_on: val(fd, 'hired_on') || undefined, needs_housing: Boolean(fd.get('housing')) });
    toast('Staff member added');
    await done();
  }, { submitText: 'Add' });
}

function setStatus(s, done) {
  formDialog(`Status for ${fullName(s)}`, h('div', { class: 'form' },
    field('Status', select(STAFF_STATUS, s.status, { name: 'status' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'housing', checked: Boolean(s.needs_housing) }), 'Needs staff housing')), async (fd) => {
    await patch(`/workforce/staff/${s.id}`, { status: val(fd, 'status'), needs_housing: Boolean(fd.get('housing')) });
    toast('Saved');
    await done();
  });
}

async function staffCerts(s, certs) {
  const list = h('div');
  async function load() {
    const { data } = await get(`/workforce/staff/${s.id}/certifications`);
    clear(list).append(data.length ? table([
      { head: 'Certification', cell: (c) => c.name }, { head: 'Issued', cell: (c) => (c.issued_on ? fmtDate(c.issued_on) : '') }, { head: 'Expires', cell: (c) => (c.expires_on ? fmtDate(c.expires_on) : 'No expiry') },
    ], data) : h('p', { class: 'muted' }, 'No certifications recorded.'));
  }
  const cert = select(certs.map((c) => [c.id, c.name]), certs[0] && certs[0].id, { name: 'cert' });
  const issued = input({ type: 'date' });
  const expires = input({ type: 'date' });
  const add = button('Save certification', async () => {
    if (!certs.length) throw new Error('Add certification types on the Positions tab first');
    await put(`/workforce/staff/${s.id}/certifications`, { certification_id: Number(cert.value), issued_on: issued.value || undefined, expires_on: expires.value || null });
    toast('Certification saved');
    await load();
  }, { kind: 'primary' });
  dialog(`Certifications for ${fullName(s)}`, [list, h('h3', null, 'Add or renew'), h('div', { class: 'form' }, field('Certification', cert), field('Issued', issued), field('Expires', expires)), h('div', { class: 'row' }, add)], { wide: true });
  await load();
}

// ---------------------------------------------------------------- positions and certification types
async function drawPositions(box) {
  const [positions, certs] = await Promise.all([get('/workforce/positions?limit=500'), get('/workforce/certifications?limit=500')]);
  const reload = async () => { const n = h('div'); await drawPositions(n); clear(box).append(...n.childNodes); };
  clear(box).append(h('div', { class: 'stack' },
    h('section', null, h('header', { class: 'spread' }, h('h2', null, 'Positions'), button('Add position', () => editPosition(null, reload), { kind: 'primary', small: true })),
      positions.data.length ? table([
        { head: 'Position', cell: (p) => h('strong', null, p.name) }, { head: 'Department', cell: (p) => label(p.department) },
        { head: 'Guests per staff member', num: true, cell: (p) => (p.visits_per_staff ? String(p.visits_per_staff) : '') },
        { head: '', actions: true, cell: (p) => [button('Edit', () => editPosition(p, reload), { small: true }), button('Required certifications', () => requirements(p, certs.data), { small: true })] },
      ], positions.data) : empty('No positions yet, such as Lift operator or Rental tech.')),
    h('section', { class: 'section' }, h('header', { class: 'spread' }, h('h2', null, 'Certification types'), button('Add certification', () => addCert(reload), { small: true })),
      certs.data.length ? table([{ head: 'Name', cell: (c) => c.name }], certs.data) : empty('No certification types yet, such as Outdoor emergency care.'))));
}

function editPosition(p, done) {
  formDialog(p ? `Edit ${p.name}` : 'Add a position', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, value: p ? p.name : '' })),
    field('Department', select(DEPARTMENTS, p ? p.department : 'lifts', { name: 'department' })),
    field('Guests per staff member', input({ name: 'visits', type: 'number', min: 1, value: p && p.visits_per_staff ? p.visits_per_staff : '' }), 'Used to suggest how many people to schedule')), async (fd) => {
    const body = { name: val(fd, 'name'), department: val(fd, 'department'), visits_per_staff: num(fd, 'visits') };
    if (p) await patch(`/workforce/positions/${p.id}`, body); else await post('/workforce/positions', body);
    toast('Position saved');
    await done();
  });
}
function addCert(done) {
  formDialog('Add a certification type', h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 100 }))), async (fd) => {
    await post('/workforce/certifications', { name: val(fd, 'name') });
    toast('Certification added');
    await done();
  });
}
function requirements(p, certs) {
  if (!certs.length) { toast('Add certification types first', 'error'); return; }
  const boxes = certs.map((c) => ({ c, cb: h('input', { type: 'checkbox' }) }));
  const save = button('Save requirements', async () => {
    await put(`/workforce/positions/${p.id}/requirements`, { certification_ids: boxes.filter((b) => b.cb.checked).map((b) => b.c.id) });
    toast('Requirements saved');
    dlg.close();
  }, { kind: 'primary' });
  const dlg = dialog(`Required for ${p.name}`, [
    h('p', { class: 'muted' }, 'Tick every certification this position needs. Saving replaces the earlier list. Leave all unticked for none.'),
    h('div', { class: 'checks' }, boxes.map((b) => h('label', { class: 'check' }, b.cb, b.c.name))), h('div', { class: 'footer row' }, save)]);
}

// ---------------------------------------------------------------- hours
async function drawTime(box) {
  const from = input({ type: 'date', value: addDays(todayStr(), -14) });
  const to = input({ type: 'date', value: todayStr() });
  const staff = (await get('/workforce/staff')).data;
  const names = new Map(staff.map((s) => [s.id, fullName(s)]));
  const out = h('div');
  async function load() {
    clear(out);
    try {
      const { data } = await get(`/workforce/time/entries?from=${from.value}&to=${to.value}`);
      if (!data.length) { out.append(empty('No time entries in this range.')); return; }
      const totals = new Map();
      for (const e of data) totals.set(e.staff_id, (totals.get(e.staff_id) || 0) + Number(e.minutes));
      const hrs = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
      out.append(h('h3', null, 'Totals'), table([{ head: 'Person', cell: (r) => names.get(r[0]) || `Staff #${r[0]}` }, { head: 'Hours', num: true, cell: (r) => hrs(r[1]) }], [...totals.entries()]),
        h('h3', null, 'Entries'), table([
          { head: 'Person', cell: (e) => names.get(e.staff_id) || `Staff #${e.staff_id}` },
          { head: 'In', cell: (e) => fmtDateTime(e.clock_in) },
          { head: 'Out', cell: (e) => (e.clock_out ? fmtDateTime(e.clock_out) : state('Still clocked in', 'good')) },
          { head: 'Hours', num: true, cell: (e) => hrs(Number(e.minutes)) },
        ], data));
    } catch (err) { out.append(errorBox(err)); }
  }
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', load, { kind: 'primary' })), out));
  await load();
}
