import { get, post, put, patch } from '../api.js';
import { h, clear, can, isManager, money, toCents, centsToInput, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, tabs, val, num, todayStr, fmtDate, fmtRange, label, empty, errorBox } from '../ui.js';
import { personPicker } from '../widgets.js';

const KINDS = ['club', 'race_team', 'school_program', 'camp', 'league'];

export async function render(root) {
  const body = h('div');
  const seasonIn = input({ placeholder: 'All seasons', 'aria-label': 'Season' });
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Programs'),
    isManager() ? button('Add program', () => editProgram(null, load), { kind: 'primary' }) : null),
    h('div', { class: 'inline-form' }, field('Season', seasonIn, 'Such as 2026-27'), button('Filter', () => load())), body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const q = seasonIn.value.trim() ? `&season=${encodeURIComponent(seasonIn.value.trim())}` : '';
      const { data } = await get(`/programs?limit=200${q}`);
      clear(body).append(data.length ? table([
        { head: 'Program', cell: (p) => h('strong', null, p.name) },
        { head: 'Kind', cell: (p) => label(p.kind) },
        { head: 'Season', cell: (p) => p.season },
        { head: 'Spots', num: true, cell: (p) => (p.capacity === null ? 'No limit' : String(p.capacity)) },
        { head: 'Price', num: true, cell: (p) => money(p.price_cents) },
        { head: '', actions: true, cell: (p) => [
          can('instructor') ? button('Open', () => detail(p), { small: true, kind: 'primary' }) : button('Enroll', () => enrollOnly(p), { small: true, kind: 'primary' }),
          isManager() ? button('Edit', () => editProgram(p, load), { small: true }) : null,
        ] },
      ], data) : empty('No programs found.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function editProgram(p, done) {
  const f = h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, value: p ? p.name : '' })),
    field('Kind', select(KINDS, p ? p.kind : 'club', { name: 'kind' })),
    field('Season', input({ name: 'season', required: true, value: p ? p.season : '', placeholder: '2026-27' })),
    field('Spots', input({ name: 'capacity', type: 'number', min: 1, value: p && p.capacity ? p.capacity : '' }), 'Blank for no limit. Extra sign-ups go on a waitlist.'),
    field('Price ($)', input({ name: 'price', inputmode: 'decimal', value: p ? centsToInput(p.price_cents) : '0.00' })),
    field('Starts', input({ name: 'starts_on', type: 'date', value: p && p.starts_on ? p.starts_on : '' })),
    field('Ends', input({ name: 'ends_on', type: 'date', value: p && p.ends_on ? p.ends_on : '' })));
  formDialog(p ? `Edit ${p.name}` : 'Add a program', f, async (fd) => {
    const cents = toCents(fd.get('price'));
    if (cents === null) throw new Error('Price must be an amount like 250.00');
    const body = { name: val(fd, 'name'), kind: val(fd, 'kind'), season: val(fd, 'season'), capacity: num(fd, 'capacity'), price_cents: cents, starts_on: val(fd, 'starts_on'), ends_on: val(fd, 'ends_on') };
    if (p) await patch(`/programs/${p.id}`, body); else await post('/programs', body);
    toast('Program saved');
    await done();
  });
}

// ---------------------------------------------------------------- counter staff can enroll but not see rosters
function enrollOnly(p) {
  const picker = personPicker({ label: 'Participant', required: true });
  const guardian = personPicker({ label: 'Parent or guardian' });
  const go = button('Enroll', async () => {
    if (!picker.get()) throw new Error('Choose a participant');
    const out = await post(`/programs/${p.id}/enrollments`, { person_id: picker.get().id, guardian_id: guardian.get() ? guardian.get().id : undefined });
    toast(out.status === 'waitlist' ? 'Program is full. Added to the waitlist' : 'Enrolled');
    dlg.close();
  }, { kind: 'primary' });
  const dlg = dialog(`Enroll in ${p.name}`, [picker.el, guardian.el, h('div', { class: 'footer row' }, go)]);
}

// ---------------------------------------------------------------- program detail
function detail(p) {
  dialog(p.name, tabs([['roster', 'Roster', (b) => roster(p, b)], ['sessions', 'Sessions', (b) => sessions(p, b)]]), { wide: true });
}

async function roster(p, box) {
  const picker = personPicker({ label: 'Participant', required: true });
  const guardian = personPicker({ label: 'Parent or guardian' });
  const list = h('div');
  async function load() {
    const { data } = await get(`/programs/${p.id}/roster`);
    const enrolled = data.filter((r) => r.status === 'enrolled').length;
    clear(list).append(h('p', { class: 'muted' }, `${enrolled} enrolled${p.capacity ? ` of ${p.capacity}` : ''}, ${data.length - enrolled} on the waitlist.`),
      data.length ? table([
        { head: 'Name', cell: (r) => h('strong', null, `${r.first_name} ${r.last_name}`) },
        { head: 'Status', cell: (r) => state(label(r.status), r.status === 'enrolled' ? 'good' : 'warn') },
        { head: 'Parent or guardian', cell: (r) => (r.guardian_first_name ? `${r.guardian_first_name} ${r.guardian_last_name}  ${r.guardian_email || r.guardian_phone || ''}` : '') },
        { head: 'Paid', num: true, cell: (r) => `${money(r.paid_cents)} of ${money(p.price_cents)}` },
        { head: '', actions: true, cell: (r) => [
          isManager() ? button('Record payment', () => payment(r), { small: true }) : null,
          button('Withdraw', () => confirmDialog('Withdraw this person?', `${r.first_name} ${r.last_name} leaves ${p.name}. The next person on the waitlist moves in.`, 'Withdraw', async () => {
            const out = await post(`/programs/${p.id}/enrollments/${r.enrollment_id}/withdraw`);
            toast(out.promoted_person_id ? 'Withdrawn. Someone moved off the waitlist' : 'Withdrawn');
            await load();
          }, { danger: true }), { small: true, kind: 'danger' }),
        ] },
      ], data) : empty('No one enrolled yet.'));
  }
  function payment(r) {
    formDialog(`Payment from ${r.first_name} ${r.last_name}`, h('div', { class: 'form' }, field('Amount ($)', input({ name: 'amount', inputmode: 'decimal', required: true }))), async (fd) => {
      const cents = toCents(fd.get('amount'));
      if (!cents) throw new Error('Enter an amount like 100.00');
      await post(`/programs/${p.id}/payments`, { enrollment_id: r.enrollment_id, amount_cents: cents });
      toast('Payment recorded');
      await load();
    });
  }
  const add = button('Enroll', async () => {
    if (!picker.get()) throw new Error('Choose a participant');
    const out = await post(`/programs/${p.id}/enrollments`, { person_id: picker.get().id, guardian_id: guardian.get() ? guardian.get().id : undefined });
    toast(out.status === 'waitlist' ? 'Program is full. Added to the waitlist' : 'Enrolled');
    picker.set(null);
    guardian.set(null);
    await load();
  }, { kind: 'primary' });
  box.append(h('div', { class: 'stack' }, list, h('h3', null, 'Enroll someone'), h('div', { class: 'form' }, picker.el, guardian.el), h('div', { class: 'row' }, add)));
  await load();
}

async function sessions(p, box) {
  const list = h('div');
  async function load() {
    const { data } = await get(`/programs/${p.id}/sessions`);
    clear(list).append(data.length ? table([
      { head: 'When', cell: (s) => fmtRange(s.starts_at, s.ends_at) },
      { head: '', actions: true, cell: (s) => button('Attendance', () => attendance(s), { small: true }) },
    ], data) : empty('No sessions scheduled.'));
  }
  async function attendance(s) {
    const { data } = await get(`/programs/${p.id}/roster`);
    const rows = data.filter((r) => r.status === 'enrolled').map((r) => ({ r, cb: h('input', { type: 'checkbox', checked: true, 'aria-label': `${r.first_name} ${r.last_name} present` }) }));
    if (!rows.length) { toast('No one is enrolled yet', 'error'); return; }
    const save = button('Save attendance', async () => {
      await put(`/programs/sessions/${s.id}/attendance`, { marks: rows.map((x) => ({ person_id: x.r.person_id, present: x.cb.checked })) });
      toast('Attendance saved');
      dlg.close();
    }, { kind: 'primary' });
    const dlg = dialog(`Attendance, ${fmtDate(s.starts_at)}`, [h('p', { class: 'muted' }, 'Untick anyone who was absent.'), table([{ head: 'Here', cell: (x) => x.cb }, { head: 'Name', cell: (x) => `${x.r.first_name} ${x.r.last_name}` }], rows), h('div', { class: 'footer row' }, save)]);
  }
  const addBtn = isManager() ? button('Add session', () => formDialog('Add a session', h('div', { class: 'form' },
    field('Starts', input({ type: 'datetime-local', name: 'starts_at', required: true, value: `${todayStr()}T16:00` })),
    field('Ends', input({ type: 'datetime-local', name: 'ends_at', required: true, value: `${todayStr()}T18:00` }))), async (fd) => {
    await post(`/programs/${p.id}/sessions`, { starts_at: val(fd, 'starts_at'), ends_at: val(fd, 'ends_at') });
    toast('Session added');
    await load();
  }), { kind: 'primary' }) : null;
  box.append(h('div', { class: 'stack' }, h('div', { class: 'row' }, addBtn), list));
  await load();
}
