// Staff and schedule > Staff: a searchable list, and a page for each person with everything about them in one place:
// details, positions they work, certifications, availability (weekly and instructor open dates), their login, their
// patrol and ski school roles, this week's hours and upcoming shifts.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, confirmDialog, dialog, table, state, label, empty, errorBox, fmtDate, todayStr, addDays } from '../ui.js';
import { availabilityDialog, WEEKDAYS } from './myshifts.js';
import { span, hrs, dayShort, monthDay, tod, STAFF_STATUS, STATUS_TONE, fullName } from './workforce-common.js';

const certState = (c) => {
  if (!c.expires_on) return state('No expiry', 'neutral');
  const d = String(c.expires_on).slice(0, 10);
  if (d < todayStr()) return state(`Expired ${fmtDate(d)}`, 'bad');
  if (d <= addDays(todayStr(), 45)) return state(`Expires ${fmtDate(d)}`, 'warn');
  return state(`Valid to ${fmtDate(d)}`, 'good');
};

// ---------------------------------------------------------------- the list
export async function drawStaff(box) {
  const [{ data: positions }, expiring] = await Promise.all([get('/workforce/positions?limit=500'), get('/workforce/certifications-expiring?days=45')]);
  const q = input({ type: 'search', placeholder: 'Find by name, email or phone', 'aria-label': 'Find staff' });
  const status = select([['active', 'Active'], ['onboarding', 'Onboarding'], ['applicant', 'Applicants'], ['inactive', 'Inactive'], ['', 'Everyone']], 'active', { 'aria-label': 'Status' });
  const pos = select([['', 'Any position'], ...positions.map((p) => [p.id, p.name])], '', { 'aria-label': 'Position' });
  const list = h('div');
  let token = 0;
  async function load() {
    const my = ++token;
    const params = new URLSearchParams();
    if (status.value) params.set('status', status.value);
    if (q.value.trim()) params.set('q', q.value.trim());
    if (pos.value) params.set('position_id', pos.value);
    try {
      const { data } = await get(`/workforce/staff?${params}`);
      if (my !== token) return;
      clear(list).append(data.length ? table([
        { head: 'Name', cell: (s) => h('a', { href: `#/workforce/staff/${s.id}` }, h('b', null, fullName(s))) },
        { head: 'Works as', cell: (s) => (s.positions.length ? s.positions.map((p) => p.name).join(', ') : h('span', { class: 'muted' }, 'Not set')) },
        { head: 'Contact', cell: (s) => [s.email, s.phone].filter(Boolean).join(', ') },
        { head: 'Sign-in', cell: (s) => (s.login_email ? s.login_email : h('span', { class: 'muted' }, 'No login')) },
        { head: 'Status', cell: (s) => state(label(s.status), STATUS_TONE[s.status]) },
      ], data) : empty(q.value || pos.value ? 'Nobody matches that.' : 'No staff here yet.'));
    } catch (err) { clear(list).append(errorBox(err)); }
  }
  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  status.addEventListener('change', load);
  pos.addEventListener('change', load);
  clear(box).append(h('div', { class: 'stack' },
    expiring.data.length ? h('section', { class: 'section notice-box' }, h('h2', null, `Certifications to renew (${expiring.data.length})`),
      table([{ head: 'Person', cell: (r) => h('a', { href: `#/workforce/staff/${r.staff_id}` }, `${r.first_name} ${r.last_name}`) }, { head: 'Certification', cell: (r) => r.certification }, { head: 'Expires', cell: (r) => certState(r) }], expiring.data)) : null,
    h('div', { class: 'filter-bar' }, q, status, pos, button('Add staff member', () => addStaff(), { kind: 'primary' })), list));
  await load();
}

function addStaff() {
  formDialog('Add a staff member', h('div', { class: 'form' },
    field('First name', input({ name: 'first', required: true })), field('Last name', input({ name: 'last', required: true })),
    field('Email', input({ name: 'email', type: 'email' })), field('Phone', input({ name: 'phone', type: 'tel' })),
    field('Status', select(STAFF_STATUS, 'onboarding', { name: 'status' })), field('Hired on', input({ name: 'hired_on', type: 'date' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'housing' }), ' Needs staff housing')), async (fd) => {
    const v = (k) => String(fd.get(k) || '').trim() || undefined;
    const r = await post('/workforce/staff', { person: { first_name: v('first'), last_name: v('last'), email: v('email'), phone: v('phone') }, status: v('status'), hired_on: v('hired_on'), needs_housing: Boolean(fd.get('housing')) });
    toast('Staff member added');
    location.hash = `#/workforce/staff/${r.id}`;
  }, { submitText: 'Add and open' });
}

// ---------------------------------------------------------------- one person
export async function personPage(root, id) {
  const holder = h('div', { class: 'stack person-page' });
  root.append(h('p', { class: 'help-back' }, h('a', { href: '#/workforce/staff' }, '← Staff')), holder);
  async function draw() {
    let p; let certTypes; let positions;
    try { [p, { data: certTypes }, { data: positions }] = await Promise.all([get(`/workforce/staff/${id}`), get('/workforce/certifications?limit=500'), get('/workforce/positions?limit=500')]); } catch (err) { clear(holder).append(errorBox(err)); return; }
    const name = fullName(p);
    const card = (title, action, ...content) => h('section', { class: 'card pcard' }, h('header', { class: 'card-head' }, h('h2', null, title), action), ...content);

    clear(holder).append(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, name), h('p', { class: 'person-meta' }, state(label(p.status), STATUS_TONE[p.status]),
        p.hired_on ? ` Hired ${fmtDate(String(p.hired_on).slice(0, 10))}.` : '', p.needs_housing ? ' Needs staff housing.' : '')),
      h('div', { class: 'row' }, button('Edit details', () => editDetails(p, draw)), button('Change status', () => changeStatus(p, draw)))),
      h('div', { class: 'pgrid' },
        card('This week', null,
          h('p', { class: 'big-pair' }, h('span', null, h('b', null, hrs(p.week.scheduled_minutes)), ' scheduled'), h('span', null, h('b', null, hrs(p.week.worked_minutes)), ' worked')),
          p.upcoming.length ? h('ul', { class: 'plain-list' }, p.upcoming.map((s) => h('li', null, h('b', null, `${dayShort(s.starts_at.slice(0, 10))} ${monthDay(s.starts_at.slice(0, 10))}`), ` ${span(s.starts_at, s.ends_at)}, ${s.position}`, s.status === 'draft' ? h('small', { class: 'muted' }, ' (draft)') : null)))
            : h('p', { class: 'muted' }, 'No shifts ahead.')),
        card('Works as', button('Change', () => editPositions(p, positions, draw), { small: true, label: 'Change positions' }),
          p.positions.length ? h('p', null, p.positions.map((x) => x.name).join(', ')) : h('p', { class: 'muted' }, 'Not set. People trained for a position are offered first when filling its shifts.')),
        card('Certifications', button('Add or renew', () => certDialog(p, certTypes, null, draw), { small: true }),
          p.certifications.length ? table([
            { head: 'Certification', cell: (c) => c.name },
            { head: 'Status', cell: certState },
            { head: '', actions: true, cell: (c) => [button('Renew', () => certDialog(p, certTypes, c, draw), { small: true, label: `Renew ${c.name}` }),
              button('Remove', () => confirmDialog(`Remove ${c.name}?`, `${name} will no longer be able to work positions that require it.`, 'Remove', async () => { await del(`/workforce/staff/${id}/certifications/${c.id}`); toast('Removed'); await draw(); }, { danger: true }), { small: true, label: `Remove ${c.name}` })] },
          ], p.certifications) : h('p', { class: 'muted' }, 'None recorded.')),
        card('Availability', button('Change', () => availabilityDialog(id, name, draw), { small: true, label: 'Change availability' }),
          p.availability.length ? h('ul', { class: 'plain-list' }, p.availability.map((w) => h('li', null, h('b', null, WEEKDAYS[w.weekday]), ` ${tod(w.start_time)} to ${tod(w.end_time)}`)))
            : h('p', { class: 'muted' }, 'No weekly pattern: can be scheduled any time.'),
          p.instructor && p.instructor.open_dates.length ? [h('p', { class: 'muted small' }, 'Also open on these dates (from Instructor availability):'),
            h('ul', { class: 'plain-list' }, p.instructor.open_dates.map((d) => h('li', null, `${dayShort(String(d.open_date).slice(0, 10))} ${monthDay(String(d.open_date).slice(0, 10))}, ${tod(d.start_time)} to ${tod(d.end_time)}`)))] : null),
        card('Sign-in', p.login ? null : button('Link a login', () => linkLogin(p, draw), { small: true }),
          p.login ? h('p', null, h('b', null, p.login.email), ` (${label(p.login.role)}). They see their shifts in My shifts, clock in, and get schedule messages in their Inbox.`)
            : h('p', { class: 'muted' }, 'No login linked. Without one they use the time clock kiosk and do not get schedule messages.')),
        card('Other roles', null, h('ul', { class: 'plain-list' },
          h('li', null, p.patrol ? [h('b', null, 'Patrol: '), `${label(p.patrol.level)}${p.patrol.callsign ? `, call sign ${p.patrol.callsign}` : ''}. `, h('a', { href: '#/patrol/team' }, 'Patrol team')] : h('span', { class: 'muted' }, 'Not on the patrol roster.')),
          h('li', null, p.instructor ? [h('b', null, 'Ski school: '), p.instructor.is_public ? 'public instructor profile' : 'instructor profile (not public)', p.instructor.disciplines ? `, ${p.instructor.disciplines}` : '', '. ', h('a', { href: '#/availability' }, 'Instructor availability')] : h('span', { class: 'muted' }, 'No instructor profile.')))),
        card('Contact', null, h('p', null, [p.email, p.phone].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'No email or phone.')))));
  }
  await draw();
}

function editDetails(p, done) {
  formDialog(`Edit ${fullName(p)}`, h('div', { class: 'form' },
    field('First name', input({ name: 'first_name', required: true, value: p.first_name })), field('Last name', input({ name: 'last_name', required: true, value: p.last_name })),
    field('Email', input({ name: 'email', type: 'email', value: p.email || '' })), field('Phone', input({ name: 'phone', type: 'tel', value: p.phone || '' })),
    field('Hired on', input({ name: 'hired_on', type: 'date', value: p.hired_on ? String(p.hired_on).slice(0, 10) : '' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'housing', checked: Boolean(p.needs_housing) }), ' Needs staff housing')), async (fd) => {
    const v = (k) => String(fd.get(k) || '').trim();
    await patch(`/workforce/staff/${p.id}`, { first_name: v('first_name'), last_name: v('last_name'), email: v('email') || null, phone: v('phone') || null, hired_on: v('hired_on') || null, needs_housing: Boolean(fd.get('housing')) });
    toast('Saved');
    await done();
  });
}

function changeStatus(p, done) {
  const s = select(STAFF_STATUS, p.status, { name: 'status' });
  const warn = h('p', { class: 'muted small' });
  const sync = () => { warn.textContent = s.value !== 'active' && p.status === 'active' && p.future_shifts ? `${p.future_shifts} shift${p.future_shifts === 1 ? '' : 's'} ahead will be left unfilled for someone else, and ${p.login ? 'they get a message' : 'nobody is messaged (no login)'}.` : ''; };
  s.addEventListener('change', sync);
  sync();
  formDialog(`Status for ${fullName(p)}`, h('div', { class: 'form' }, field('Status', s, 'Only active people can be put on shifts.'), warn), async () => {
    const r = await patch(`/workforce/staff/${p.id}`, { status: s.value });
    toast(r.unassigned ? `Saved. ${r.unassigned} shift${r.unassigned === 1 ? '' : 's'} left unfilled.` : 'Saved');
    await done();
  });
}

function editPositions(p, positions, done) {
  const have = new Set(p.positions.map((x) => x.id));
  const boxes = positions.map((x) => ({ x, cb: h('input', { type: 'checkbox', checked: have.has(Number(x.id)) }) }));
  formDialog(`What ${p.first_name} works as`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'People trained for a position are offered first when filling its shifts. This does not stop anyone else being chosen.'),
    positions.length ? h('div', { class: 'checks' }, boxes.map((b) => h('label', { class: 'check' }, b.cb, ` ${b.x.name}`))) : empty('No positions yet. Add them on the Setup tab.')), async () => {
    await put(`/workforce/staff/${p.id}/positions`, { position_ids: boxes.filter((b) => b.cb.checked).map((b) => Number(b.x.id)) });
    toast('Saved');
    await done();
  });
}

function certDialog(p, certTypes, current, done) {
  if (!certTypes.length) { toast('Add certification types on the Setup tab first', 'error'); return; }
  formDialog(current ? `Renew ${current.name}` : `Add a certification for ${p.first_name}`, h('div', { class: 'form' },
    field('Certification', select(certTypes.map((c) => [c.id, c.name]), current ? current.id : certTypes[0].id, { name: 'cert', disabled: Boolean(current) })),
    field('Issued', input({ type: 'date', name: 'issued', value: current && current.issued_on ? String(current.issued_on).slice(0, 10) : '' })),
    field('Expires', input({ type: 'date', name: 'expires', value: current && current.expires_on ? String(current.expires_on).slice(0, 10) : '' }), 'Leave blank if it does not expire')), async (fd) => {
    await put(`/workforce/staff/${p.id}/certifications`, { certification_id: current ? Number(current.id) : Number(fd.get('cert')), issued_on: String(fd.get('issued') || '') || undefined, expires_on: String(fd.get('expires') || '') || null });
    toast('Certification saved');
    await done();
  });
}

async function linkLogin(p, done) {
  const { data: users } = await get('/users');
  const free = users.filter((u) => !u.staff_id && u.role !== 'owner' && u.active);
  if (!free.length) {
    dialog('Link a login', [h('p', null, 'Every login is already linked to someone. Add a login for them in Account, and choose their staff record there.'), h('p', null, h('a', { href: '#/settings' }, 'Open Account'))]);
    return;
  }
  formDialog(`Link a login to ${fullName(p)}`, h('div', { class: 'form' }, field('Login', select(free.map((u) => [u.id, `${u.email} (${label(u.role)})`]), free[0].id, { name: 'user' }), 'Only logins not linked to anyone are listed. To make a new login, use Account.')), async (fd) => {
    await patch(`/users/${fd.get('user')}`, { staff_id: p.id });
    toast('Login linked');
    await done();
  }, { submitText: 'Link' });
}
