import { get, post, patch, del } from '../api.js';
import { h, clear, can, isManager, table, state, input, select, field, button, toast, formDialog, dialog, val, num, todayStr, addDays, fmtDateTime, fmtDate, fmtTime, fmtRange, label, empty, errorBox, tabs, money, confirmDialog, fail, appendAll } from '../ui.js';
import { waiverPanel } from '../widgets.js';
import { loadCustomerForm, customerCapture } from './customer-form.js';
import { cardDialog } from './school-card.js';

const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const LEVELS = ['first_timer', 'beginner', 'intermediate', 'advanced'];
const FORMATS = [['group', 'Group'], ['semi_private', 'Semi-private (2 to 4)'], ['private', 'Private']];
const AGES = [['all', 'All ages'], ['kids', 'Kids'], ['teens', 'Teens'], ['adults', 'Adults']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pill = (s) => (s.format && s.format !== 'group' ? h('span', { class: 'muted' }, `  ${label(s.format)}`) : null);

export async function render(root) {
  const staff = isManager() ? (await get('/workforce/staff?status=active')).data : [];
  const certs = isManager() ? (await get('/workforce/certifications?limit=500')).data : [];
  const names = new Map(staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`]));
  let pending = 0;
  if (can('counter')) { try { pending = (await get('/skischool/requests?status=pending')).pending; } catch (_) { /* leave at 0 */ } }

  // Today first: on the day, the board of who teaches what is what the desk needs.
  const items = [['today', 'Today', (b) => boardTab(b, { staff })], ['lessons', 'Lessons', (b) => lessonsTab(b, { staff, certs, names })]];
  if (can('counter')) items.push(['requests', pending ? `Online requests (${pending})` : 'Online requests', (b) => requestsTab(b)]);
  if (can('instructor')) items.push(['levels', 'Levels and skills', (b) => levelsTab(b)]);
  if (isManager()) items.push(['hours', 'Instructor hours', (b) => hoursTab(b)]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Ski school')), tabs(items, 'today'));
}

// ---------------------------------------------------------------- lessons
async function lessonsTab(root, { staff, certs, names }) {
  const from = input({ type: 'date', value: todayStr() });
  const to = input({ type: 'date', value: addDays(todayStr(), 14) });
  const body = h('div');
  root.append(h('div', { class: 'row' }, isManager() ? button('Add lesson session', () => addSession(staff, certs, load), { kind: 'primary' }) : null, isManager() ? button('Add a series of days', () => addSeries(staff, certs, load)) : null,
    isManager() ? button('Cancel a day', () => cancelDays(load)) : null),
    h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', () => load(), { kind: 'primary' })), body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/skischool/sessions?from=${from.value}&to=${to.value}`);
      clear(body).append(data.length ? table([
        { head: 'When', cell: (s) => fmtRange(s.starts_at, s.ends_at) },
        { head: 'Lesson', cell: (s) => h('span', null, h('strong', null, s.product), h('div', { class: 'muted small' }, `${label(s.discipline)}, ${label(s.ability_level)}`), pill(s), s.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${s.meeting_place}`) : null) },
        { head: 'Instructor', cell: (s) => (s.instructor_id ? names.get(s.instructor_id) || 'Assigned' : state('Needs an instructor', 'warn')) },
        { head: 'Booked', num: true, cell: (s) => `${s.booked} of ${s.capacity}` },
        { head: 'Status', cell: (s) => h('span', null, state(label(s.status), s.status === 'scheduled' ? 'good' : s.status === 'cancelled' ? 'bad' : 'neutral'), s.cancel_reason ? h('div', { class: 'muted small' }, s.cancel_reason) : null) },
        { head: '', actions: true, cell: (s) => [
          button('Roster', () => roster(s, load), { small: true }),
          isManager() && s.status === 'scheduled' ? button('Instructor', () => setInstructor(s, load), { small: true }) : null,
          isManager() && s.status === 'scheduled' ? button('Cancel', () => cancelOne(s, load), { small: true }) : null,
        ] },
      ], data, { rowClass: (s) => (s.status === 'scheduled' && !s.instructor_id ? 'attention' : null) }) : empty('No lessons in this range.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

// ---- cancelling lessons (routes/skischool.js, lib/lessoncancel.js)
/** What cancelling does to the people on a lesson, in plain words, from the preview counts. */
function consequences(list) {
  const sum = (k) => list.reduce((n, s) => n + Number(s[k] || 0), 0);
  const booked = sum('booked'); const pack = sum('on_package'); const online = sum('paid_online');
  if (!booked) return h('p', null, 'Nobody is booked, so nobody needs telling.');
  return h('ul', { class: 'plain stack' },
    h('li', null, `${booked} booking${booked === 1 ? '' : 's'} cancelled, and everyone booked gets an email.`),
    pack ? h('li', null, `${pack} package lesson${pack === 1 ? '' : 's'} go back on the package.`) : null,
    online ? h('li', null, `${online} online payment${online === 1 ? ' is' : 's are'} refunded in full to the card.`) : null,
    booked - pack - online > 0 ? h('li', null, 'Anyone who paid at the desk is listed afterwards, to refund at the counter.') : null);
}
/** After cancelling: who still needs a refund at the desk. */
function afterCancel(results) {
  const desk = results.flatMap((r) => r.desk_refunds || []);
  const cards = results.flatMap((r) => r.card_refunds || []);
  const body = h('div', { class: 'stack' },
    h('p', null, `${results.length} lesson${results.length === 1 ? '' : 's'} cancelled. ${results.reduce((n, r) => n + r.emailed, 0)} email${results.reduce((n, r) => n + r.emailed, 0) === 1 ? '' : 's'} sent.`),
    cards.length ? h('p', null, `Refunded to cards: ${cards.map((c) => `${c.name} ${money(c.amount_cents)}`).join(', ')}.`) : null,
    desk.length ? h('div', { class: 'notice warn stack' }, h('b', null, 'Refund these at the desk'), h('ul', { class: 'plain' }, desk.map((d) => h('li', null, `${d.name}: ${money(d.amount_cents)}, order #${d.order_id}`))),
      h('p', { class: 'small' }, 'Open each order under Sell, Sold today or Find an order, and refund the lesson.')) : null);
  dialog('Lessons cancelled', body);
}
async function cancelOne(s, done) {
  let p;
  try { p = await get(`/skischool/sessions/${s.id}/cancel-preview`); } catch (err) { fail(err); return; }
  const reason = input({ name: 'reason', required: true, maxlength: 300, placeholder: 'For example: high winds, lifts closed' });
  const f = h('div', { class: 'stack' }, h('p', null, h('strong', null, `${s.product}, ${fmtRange(s.starts_at, s.ends_at)}`)), consequences([p]),
    field('Reason', reason, 'Kept on the record and included in the email to guests.'));
  const deletable = Number(p.ever_booked) === 0;
  formDialog(deletable ? 'Cancel or delete this lesson' : 'Cancel this lesson', h('div', { class: 'stack' }, f,
    deletable ? h('p', { class: 'muted small' }, 'Nobody has ever booked it. If it was added by mistake, you can delete it instead: ', button('Delete lesson', async () => {
      await del(`/skischool/sessions/${s.id}`); toast('Lesson deleted'); document.querySelectorAll('.overlay').forEach((o) => o.remove()); await done();
    }, { small: true })) : null), async (fd) => {
    const r = await post(`/skischool/sessions/${s.id}/cancel`, { reason: val(fd, 'reason') });
    toast('Lesson cancelled');
    await done();
    if (r.bookings) afterCancel([r]);
  }, { submitText: 'Cancel lesson' });
}
async function cancelDays(done) {
  const from = input({ type: 'date', name: 'from', value: todayStr(), required: true });
  const to = input({ type: 'date', name: 'to', value: todayStr(), required: true });
  const reason = input({ name: 'reason', required: true, maxlength: 300, placeholder: 'For example: storm, the mountain is closed' });
  const list = h('div', { 'aria-live': 'polite' });
  let seen = null;
  const look = async () => {
    clear(list);
    try {
      const r = await post('/skischool/sessions/cancel-days', { from: from.value, to: to.value, reason: reason.value.trim() || 'checking', preview: true });
      seen = `${from.value}|${to.value}`;
      appendAll(list, r.sessions.length ? [h('p', null, h('strong', null, `${r.sessions.length} lesson${r.sessions.length === 1 ? '' : 's'} will be cancelled:`)),
        h('ul', { class: 'plain' }, r.sessions.map((s) => h('li', null, `${fmtRange(s.starts_at, s.ends_at)}, ${s.product}: ${s.booked} booked`))), consequences(r.sessions)]
        : [empty('No lessons are scheduled on those days.')]);
    } catch (err) { list.append(errorBox(err)); }
  };
  from.addEventListener('change', look); to.addEventListener('change', look);
  formDialog('Cancel every lesson on a day', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'For a storm or a closure: every lesson from the first day to the last is cancelled, with refunds and emails as for one lesson.'),
    h('div', { class: 'form' }, field('First day', from), field('Last day', to)), field('Reason', reason, 'Kept on the record and included in the email to guests.'), list), async (fd) => {
    if (seen !== `${from.value}|${to.value}`) { await look(); throw new Error('Check the list of lessons, then press Cancel lessons again.'); }
    const r = await post('/skischool/sessions/cancel-days', { from: val(fd, 'from'), to: val(fd, 'to'), reason: val(fd, 'reason') });
    toast(`${r.cancelled} lesson${r.cancelled === 1 ? '' : 's'} cancelled`);
    await done();
    afterCancel(r.sessions);
  }, { submitText: 'Cancel lessons', wide: true });
  look();
}

const sessionFields = (products, staff, certs) => [
  field('Lesson product', select(products.map((p) => [p.id, p.name]), products[0].id, { name: 'product_id' }), 'Packages are sold, not scheduled'),
  field('Type', select(FORMATS, 'group', { name: 'format' }), 'Sets the usual number of spots'),
  field('Discipline', select(DISCIPLINES, 'ski', { name: 'discipline' })),
  field('Level', select(LEVELS, 'beginner', { name: 'ability_level' })),
  field('Ages', select(AGES, 'all', { name: 'age_group' })),
  field('Spots (blank = usual for the type)', input({ type: 'number', name: 'capacity', min: 1, max: 60 })),
  field('Meet at', input({ name: 'meeting_place', maxlength: 120, placeholder: 'For example: Base lodge, door 2' })),
  field('Instructor', select([['', 'Assign later'], ...staff.map((s) => [s.id, `${s.first_name} ${s.last_name}`])], '', { name: 'instructor_id' })),
  field('Required certification', select([['', 'None'], ...certs.map((c) => [c.id, c.name])], '', { name: 'cert' })),
];
const sessionBody = (fd) => ({
  product_id: num(fd, 'product_id'), format: val(fd, 'format'), discipline: val(fd, 'discipline'), ability_level: val(fd, 'ability_level'), age_group: val(fd, 'age_group'),
  capacity: num(fd, 'capacity') || undefined, meeting_place: val(fd, 'meeting_place') || undefined,
  instructor_id: num(fd, 'instructor_id') || undefined, required_certification_id: num(fd, 'cert') || undefined,
});
async function singleProducts() {
  const { data } = await get('/products?kind=lesson&active=1&limit=500');
  return data.filter((p) => !(p.uses > 1));
}

async function addSession(staff, certs, done) {
  const products = await singleProducts();
  if (!products.length) { toast('Add a lesson product first, under Products and prices', 'error'); return; }
  const f = h('div', { class: 'form' }, sessionFields(products, staff, certs),
    field('Starts', input({ type: 'datetime-local', name: 'starts_at', value: `${todayStr()}T10:00`, required: true })),
    field('Ends', input({ type: 'datetime-local', name: 'ends_at', value: `${todayStr()}T12:00`, required: true })));
  formDialog('Add a lesson session', f, async (fd) => {
    await post('/skischool/sessions', { ...sessionBody(fd), starts_at: val(fd, 'starts_at'), ends_at: val(fd, 'ends_at') });
    toast('Lesson session added');
    await done();
  });
}

/** The same lesson at the same time on several days: pick a first day, how many days, and which weekdays to skip. */
async function addSeries(staff, certs, done) {
  const products = await singleProducts();
  if (!products.length) { toast('Add a lesson product first, under Products and prices', 'error'); return; }
  const days = WEEKDAYS.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `wd${i}`, checked: true }), ` ${d}`));
  const f = h('div', { class: 'form' }, sessionFields(products, staff, certs),
    field('First day', input({ type: 'date', name: 'first', value: todayStr(), required: true })),
    field('Number of days', input({ type: 'number', name: 'span', min: 1, max: 120, value: 14 }), 'Counted from the first day'),
    field('Starts at', input({ type: 'time', name: 'start_time', value: '10:00', required: true })),
    field('Ends at', input({ type: 'time', name: 'end_time', value: '12:00', required: true })),
    h('div', { class: 'wide' }, h('p', { class: 'muted small' }, 'Days of the week to include'), h('div', { class: 'row' }, days)));
  formDialog('Add a series of lessons', f, async (fd) => {
    const dates = [];
    const span = Math.min(Math.max(num(fd, 'span') || 1, 1), 120);
    for (let i = 0; i < span; i++) {
      const d = addDays(val(fd, 'first'), i);
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (fd.get(`wd${wd}`)) dates.push(d);
    }
    if (!dates.length) throw new Error('No days are selected');
    if (dates.length > 60) throw new Error('A series can have up to 60 days. Choose fewer days.');
    const out = await post('/skischool/sessions/series', { ...sessionBody(fd), dates, start_time: val(fd, 'start_time'), end_time: val(fd, 'end_time') });
    toast(`${out.count} lesson sessions added`);
    await done();
  }, { wide: true });
}

async function setInstructor(s, done) {
  const { data } = await get(`/skischool/sessions/${s.id}/eligible-instructors`);
  const opts = [['', 'Nobody'], ...data.map((x) => [x.id, `${x.name}${x.requested_by ? ` (requested by ${x.requested_by})` : ''}`])];
  formDialog('Instructor', h('div', { class: 'form' }, field('Instructor', select(opts, s.instructor_id || '', { name: 'id' }), data.length ? 'Only people who are certified, free and available are listed' : 'Nobody is free and qualified for this time'), ), async (fd) => {
    await patch(`/skischool/sessions/${s.id}/instructor`, { instructor_id: num(fd, 'id') || null });
    toast('Instructor updated');
    await done();
  });
}

// ---------------------------------------------------------------- the day board
async function boardTab(root, { staff }) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'inline-form' }, field('Day', date), button('Show', () => load(), { kind: 'primary' }),
    button('Previous', () => { date.value = addDays(date.value, -1); return load(); }), button('Next', () => { date.value = addDays(date.value, 1); return load(); })), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const b = await get(`/skischool/board?date=${date.value}`);
      const total = b.sessions.reduce((n, s) => n + s.students.length, 0);
      appendAll(clear(body),
        h('p', { class: 'muted' }, `${b.sessions.length} lesson${b.sessions.length === 1 ? '' : 's'}, ${total} student${total === 1 ? '' : 's'}`, b.unassigned ? h('span', null, ' ', state(`${b.unassigned} without an instructor`, 'warn')) : null),
        b.instructors.length ? h('div', { class: 'row' }, b.instructors.map((i) => state(`${i.name}: ${i.lessons} lesson${i.lessons === 1 ? '' : 's'}, ${Math.round(i.minutes / 6) / 10} h`, 'neutral'))) : null,
        b.sessions.length ? h('div', { class: 'board' }, b.sessions.map((s) => h('article', { class: ['panel', s.instructor_id ? '' : 'attention'].join(' ').trim(), 'data-session': s.id },
          h('header', { class: 'row between' }, h('strong', null, `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}`), s.status === 'completed' ? state('Done', 'neutral') : null),
          h('div', null, s.product, pill(s), h('span', { class: 'muted' }, `  ${label(s.discipline)}, ${label(s.ability_level)}`)),
          s.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${s.meeting_place}`) : null,
          h('div', null, s.instructor ? h('strong', null, s.instructor) : state('Needs an instructor', 'warn')),
          s.notes ? h('p', { class: 'small' }, s.notes) : null,
          s.students.length ? h('ul', { class: 'students' }, s.students.map((x) => h('li', null, h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); cardDialog(x.person_id, { onChange: load }); } }, `${x.first_name} ${x.last_name}`),
            x.level ? h('span', { class: 'muted small' }, `  level ${x.level}`) : null, x.unpaid ? h('span', null, ' ', state('Unpaid', 'warn')) : null, x.requested_instructor_id && x.requested_instructor_id === s.instructor_id ? h('span', null, ' ', state('Requested', 'good')) : null,
            x.status !== 'booked' ? h('span', { class: 'muted small' }, `  ${label(x.status)}`) : null))) : h('p', { class: 'muted small' }, 'Nobody booked yet.'),
          h('div', { class: 'row' }, button('Roster', () => roster(s, load), { small: true }),
            can('instructor') ? button('Notes and tip', () => sessionDetails(s, load), { small: true }) : null,
            isManager() ? button('Instructor', () => setInstructor(s, load), { small: true }) : null)))) : empty('No lessons on this day.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function sessionDetails(s, done) {
  const tip = input({ name: 'tip', inputmode: 'decimal', value: s.tip_cents ? (s.tip_cents / 100).toFixed(2) : '', placeholder: '0.00' });
  formDialog(`${fmtTime(s.starts_at)} ${s.product}`, h('div', { class: 'form' },
    field('Meet at', input({ name: 'meeting_place', maxlength: 120, value: s.meeting_place || '' })),
    field('Tips received ($)', tip, 'Adds to the instructor hours report'),
    h('div', { class: 'wide' }, field('Notes for the lesson', h('textarea', { name: 'notes', maxlength: 1000, rows: 3 }, s.notes || '')))), async (fd) => {
    const cents = Math.round(Number(String(fd.get('tip') || '0').replace(/[$,]/g, '')) * 100);
    if (!Number.isFinite(cents) || cents < 0) throw new Error('Enter the tip in dollars, for example 20.00');
    await patch(`/skischool/sessions/${s.id}/details`, { notes: val(fd, 'notes'), meeting_place: val(fd, 'meeting_place'), tip_cents: cents });
    toast('Saved');
    await done();
  });
}

// ---------------------------------------------------------------- the roster
async function roster(session, done) {
  const list = h('div');
  const def = await loadCustomerForm();
  const wslot = h('div');
  const creditSlot = h('div');
  let credit = null;
  const capture = customerCapture({ def, scope: 'lesson', who: 'Student', onPick: async (p) => {
    clear(wslot); clear(creditSlot); credit = null;
    if (!p) return;
    wslot.append(waiverPanel(p.id, session.starts_at.slice(0, 10)));
    try {
      const { data } = await get(`/skischool/credits?person_id=${p.id}`);
      const usable = data.filter((c) => c.left > 0 && (!c.expires_on || c.expires_on >= session.starts_at.slice(0, 10)));
      if (usable.length) {
        credit = select([['', 'Do not use a package'], ...usable.map((c) => [c.id, `${c.product}: ${c.left} left`])], usable[0].id, { name: 'use-credit', 'aria-label': 'Use a lesson package' });
        creditSlot.append(field('Lesson package', credit, 'Uses one lesson from their package instead of being paid for now'));
      }
    } catch (_) { /* no packages to offer */ }
  } });
  const signBox = h('input', { type: 'checkbox', name: 'sign_waiver' });
  const signRow = h('label', { class: 'check' }, signBox, ' The student has signed the season waiver (record it now if none is on file)');

  async function load() {
    const { data } = await get(`/skischool/sessions/${session.id}/roster`);
    clear(list).append(data.length ? table([
      { head: 'Student', cell: (r) => h('span', null, h('strong', null, `${r.first_name} ${r.last_name}`), r.unpaid ? h('span', null, ' ', state('Unpaid', 'warn')) : null, r.credit_id ? h('span', null, ' ', state('Package', 'neutral')) : null) },
      { head: 'Level so far', cell: (r) => (r.latest_level ? `Level ${r.latest_level}` : '') },
      { head: 'Status', cell: (r) => select([['booked', 'Booked'], ['attended', 'Attended'], ['no_show', 'No show'], ['cancelled', 'Cancel']], r.status, {
        'aria-label': `Status for ${r.first_name} ${r.last_name}`,
        onChange: async (e) => { try { await patch(`/skischool/bookings/${r.booking_id}`, { status: e.target.value }); toast('Updated'); if (e.target.value === 'cancelled') await load(); } catch (err) { fail(err); } },
      }) },
      { head: '', actions: true, cell: (r) => [
        button('Report card', () => cardDialog(r.person_id), { small: true }),
        can('instructor') ? button('Lesson note', () => bookingNote(r, load), { small: true }) : null,
      ] },
    ], data) : h('p', { class: 'muted' }, 'No one is booked yet.'));
  }
  const book = button('Book student', async () => {
    capture.check();
    const body = { ...capture.payload('student'), sign_waiver: signBox.checked };
    if (credit && credit.value) body.use_credit_id = Number(credit.value);
    let out;
    try {
      out = await post(`/skischool/sessions/${session.id}/bookings`, body);
    } catch (err) {
      // The student was saved even though the booking was not (no waiver yet, or the class is full): keep them selected so a retry does not create a second record.
      const pid = err.details && err.details.person_id;
      if (pid && !capture.person()) { try { capture.usePerson(await get(`/people/${pid}`)); } catch (_) { /* leave the form as typed */ } }
      throw err;
    }
    toast(out.customer.created ? 'Student saved and booked' : 'Student booked');
    capture.reset();
    signBox.checked = false;
    clear(creditSlot); clear(wslot); credit = null;
    await load();
    if (done) done();
  }, { kind: 'primary' });
  dialog(`${fmtDateTime(session.starts_at)}, ${session.product}`, [
    h('p', { class: 'muted' }, `${session.capacity} spots. Students need a signed waiver for the season.`),
    list, h('h3', null, 'Add a student'), capture.el, signRow, wslot, creditSlot, h('div', { class: 'row' }, book)], { wide: true });
  await load();
}

function bookingNote(r, done) {
  formDialog(`Note for ${r.first_name} ${r.last_name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('What went well and what to work on', h('textarea', { name: 'note', maxlength: 1000, rows: 4 }, r.instructor_notes || '')))), async (fd) => {
    await patch(`/skischool/bookings/${r.booking_id}/notes`, { instructor_notes: val(fd, 'note') });
    toast('Note saved');
    await done();
  });
}

// ---------------------------------------------------------------- requests from the online booking page
async function requestsTab(root) {
  const status = select([['pending', 'Waiting'], ['confirmed', 'Confirmed'], ['awaiting_payment', 'Paying now'], ['declined', 'Declined'], ['cancelled', 'Cancelled by guest'], ['expired', 'Not completed']], 'pending', { name: 'req-status', 'aria-label': 'Show requests' });
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Guests ask for a lesson on the public booking page. A request holds a place but takes no payment: confirm it, then they pay at the desk. Turn the page on in Settings.'), field('Show', status), body);
  status.addEventListener('change', load);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/skischool/requests?status=${status.value}`);
      clear(body).append(data.length ? h('div', { class: 'stack' }, data.map((r) => h('article', { class: 'panel stack', 'data-request': r.reference },
        h('header', { class: 'row between' }, h('strong', null, `${r.product}, ${fmtDateTime(r.starts_at)}`), state(r.reference, 'neutral'), r.amount_cents ? h('span', { class: 'small' }, r.status === 'confirmed' ? `Paid by card ${money(r.amount_cents)}${r.refund_cents ? `, refunded ${money(r.refund_cents)}` : ''}` : r.status === 'awaiting_payment' ? `Waiting for card payment of ${money(r.amount_cents)}` : `Card amount ${money(r.amount_cents)}${r.refund_cents ? `, refunded ${money(r.refund_cents)}` : ''}`) : null),
        h('div', null, `${r.contact_name}  `, h('a', { href: `mailto:${r.contact_email}` }, r.contact_email), `  ${r.contact_phone}`),
        h('ul', null, r.students.map((s) => h('li', null, `${s.first_name} ${s.last_name}`, h('span', { class: 'muted' }, `  born ${fmtDate(s.date_of_birth)}${s.discipline ? `, ${label(s.discipline)}` : ''}${s.height_in ? `, ${s.height_in} in` : ''}${s.weight_lb ? `, ${s.weight_lb} lb` : ''}${s.boot_size ? `, boot ${s.boot_size}` : ''}`)))),
        r.note ? h('p', { class: 'small' }, `Note: ${r.note}`) : null,
        r.staff_note ? h('p', { class: 'muted small' }, `Staff note: ${r.staff_note}`) : null,
        r.status === 'pending' ? h('div', { class: 'row' },
          button('Confirm', async () => {
            const out = await post(`/skischool/requests/${r.id}/confirm`, {});
            toast(out.waiver_needed.length ? `Confirmed. ${out.waiver_needed.join(', ')} must sign a waiver at the desk.` : 'Confirmed. They pay at the desk.');
            confirmedDialog(r, out);
            await load();
          }, { kind: 'primary', small: true }),
          button('Decline', () => formDialog('Decline this request', h('div', { class: 'form' }, field('Message to the guest (optional)', input({ name: 'staff_note', maxlength: 300 }))), async (fd) => { await post(`/skischool/requests/${r.id}/decline`, { staff_note: val(fd, 'staff_note') || undefined }); toast('Declined'); await load(); }, { submitText: 'Decline' }), { small: true })) : null))) : empty('Nothing here.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function confirmedDialog(r, out) {
  const subject = encodeURIComponent(`Your ${r.product} lesson is confirmed (${out.reference})`);
  const text = encodeURIComponent(`Hello ${r.contact_name},\n\nYour lesson on ${fmtDateTime(r.starts_at)} is confirmed. Please arrive 20 minutes early and pay at the ski school desk. Reference: ${out.reference}.\n\nSee you on the snow!`);
  dialog('Confirmed', h('div', { class: 'stack' }, h('p', null, `${out.booked.map((b) => b.name).join(', ')} booked, unpaid until they pay at the desk.`),
    out.waiver_needed.length ? h('p', null, state(`Waiver needed at the desk: ${out.waiver_needed.join(', ')}`, 'warn')) : null,
    h('a', { class: 'btn', href: `mailto:${out.contact.email}?subject=${subject}&body=${text}` }, `Email ${out.contact.email}`)));
}

// ---------------------------------------------------------------- levels and skills
async function levelsTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'The ladder students move up, and the skills they show to pass each level. Instructors tick skills off on the student\'s report card.'), body);
  async function load() {
    const { data } = await get('/skischool/levels');
    clear(body);
    for (const d of DISCIPLINES) {
      const levels = data.filter((l) => l.discipline === d);
      if (!levels.length && !isManager()) continue;
      body.append(h('section', { class: 'panel stack', 'data-ladder': d },
        h('div', { class: 'row between' }, h('h2', null, label(d)), isManager() ? button('Add a level', () => formDialog(`Add a ${label(d)} level`, h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 80 })), field('Description', input({ name: 'description', maxlength: 300 }))), async (fd) => { await post('/skischool/levels', { discipline: d, name: val(fd, 'name'), description: val(fd, 'description') || undefined }); toast('Level added'); await load(); }), { small: true }) : null),
        levels.length ? levels.map((l) => h('details', { class: 'level' },
          h('summary', null, `Level ${l.rank_no}: ${l.name}`, h('span', { class: 'muted' }, `  ${l.skills.length} skills`)),
          l.description ? h('p', { class: 'muted small' }, l.description) : null,
          h('ul', { class: 'skills' }, l.skills.map((s) => h('li', null, s.name, isManager() ? h('span', { class: 'row' }, ' ',
            button('Rename', () => formDialog('Rename skill', h('div', { class: 'form' }, field('Skill', input({ name: 'name', required: true, maxlength: 160, value: s.name }))), async (fd) => { await patch(`/skischool/skills/${s.id}`, { name: val(fd, 'name') }); await load(); }), { small: true }),
            button('Remove', () => confirmDialog('Remove this skill?', s.name, 'Remove', async () => { try { await del(`/skischool/skills/${s.id}`); await load(); } catch (err) { fail(err); } }, { danger: true }), { small: true })) : null))),
          isManager() ? h('div', { class: 'row' },
            button('Add a skill', () => formDialog(`Add a skill to level ${l.rank_no}`, h('div', { class: 'form' }, field('Skill', input({ name: 'name', required: true, maxlength: 160 }))), async (fd) => { await post(`/skischool/levels/${l.id}/skills`, { name: val(fd, 'name') }); await load(); }), { small: true }),
            button('Rename level', () => formDialog('Rename level', h('div', { class: 'form' }, field('Name', input({ name: 'name', required: true, maxlength: 80, value: l.name })), field('Description', input({ name: 'description', maxlength: 300, value: l.description || '' }))), async (fd) => { await patch(`/skischool/levels/${l.id}`, { name: val(fd, 'name'), description: val(fd, 'description') }); await load(); }), { small: true })) : null)) : h('p', { class: 'muted' }, 'No levels yet.')));
    }
  }
  await load();
}

// ---------------------------------------------------------------- hours
async function hoursTab(root) {
  const from = input({ type: 'date', value: addDays(todayStr(), -14) });
  const to = input({ type: 'date', value: todayStr() });
  const body = h('div');
  root.append(h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', () => load(), { kind: 'primary' })), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/skischool/hours?from=${from.value}&to=${to.value}`);
      clear(body).append(data.length ? table([
        { head: 'Instructor', cell: (r) => h('strong', null, r.name) },
        { head: 'Lessons', num: true, cell: (r) => String(r.lessons) },
        { head: 'Hours', num: true, cell: (r) => r.hours.toFixed(2) },
        { head: 'Students taught', num: true, cell: (r) => String(r.students) },
        { head: 'No shows', num: true, cell: (r) => String(r.no_shows) },
        { head: 'Tips', num: true, cell: (r) => money(r.tip_cents) },
      ], data) : empty('No lessons taught in this range.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}
