import { get, post, patch, put, del } from '../api.js';
import { h, clear, ctx, can, isManager, table, state, input, select, field, button, toast, formDialog, dialog, val, num, todayStr, addDays, fmtDateTime, fmtDate, fmtTime, fmtRange, label, empty, errorBox, tabs, money, confirmDialog, fail, appendAll } from '../ui.js';
import { levelOptions, levelName, levelList } from '../levels.js';
import * as myDay from './school-myday.js';
import { flags } from './school-myday.js';
import { waiverPanel } from '../widgets.js';
import { loadCustomerForm, customerCapture } from './customer-form.js';
import { cardDialog } from './school-card.js';
import * as lineupPart from './school-lineup.js';
import * as parentsPart from './school-parents.js';
import * as payPart from './school-pay.js';
import * as directorPart from './school-director.js';

const PARTS = [lineupPart, parentsPart, payPart, directorPart];

const DISCIPLINES = ['ski', 'snowboard', 'telemark', 'adaptive'];
const PSIA = [['none', 'None yet'], ['level1', 'PSIA-AASI Level 1'], ['level2', 'PSIA-AASI Level 2'], ['level3', 'PSIA-AASI Level 3']];
/** 'Levels 2 to 3, ages 5 to 8' for a lesson. */
const ages = (s) => (s.age_min != null || s.age_max != null ? (s.age_max == null ? `ages ${s.age_min}+` : s.age_min == null ? `ages up to ${s.age_max}` : `ages ${s.age_min} to ${s.age_max}`) : 'all ages');
const lessonWords = (s) => `${label(s.discipline)}, ${s.level_words || 'All levels'}, ${ages(s)}`;
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

  // An instructor opens on My day (their lessons and program groups). The desk opens on Today, the board of who teaches what.
  const instructor = ctx.me && ctx.me.role === 'instructor';
  const items = [];
  if (instructor || (isManager() && ctx.me.staff_id)) items.push(['myday', 'My day', (b) => myDay.render(b)]);
  items.push(['today', 'Today', (b) => boardTab(b, { staff })], ['lessons', 'Lessons', (b) => lessonsTab(b, { staff, certs, names })]);
  if (can('counter')) items.push(['requests', pending ? `Online requests (${pending})` : 'Online requests', (b) => requestsTab(b)]);
  if (isManager()) items.push(['instructors', 'Instructors', (b) => instructorsTab(b, { certs })], ['hours', 'Instructor hours', (b) => hoursTab(b)]);
  for (const part of PARTS) items.push(...part.tabs({ staff, certs, names }));
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Ski school')), tabs(items, instructor ? 'myday' : 'today'));
}

/** Setup shown in Settings, Ski school (managers): the level ladder and the skills for each level. */
export const settingsPages = {
  basics: { title: 'Confirmations', render: (panel) => basicsPage(panel) },
  levels: { title: 'Levels and skills', render: (panel) => levelsTab(panel) },
  ...lineupPart.settingsPages, ...parentsPart.settingsPages, ...payPart.settingsPages, ...directorPart.settingsPages,
};

// ---------------------------------------------------------------- lessons
async function lessonsTab(root, { staff, certs, names }) {
  const from = input({ type: 'date', value: todayStr() });
  const to = input({ type: 'date', value: addDays(todayStr(), 14) });
  const body = h('div');
  root.append(h('div', { class: 'row' }, isManager() ? button('Add lesson session', () => addSession(staff, certs, load), { kind: 'primary' }) : null, isManager() ? button('Add a series of days', () => addSeries(staff, certs, load)) : null,
    isManager() ? button('Weather: delay or cancel a day', () => { location.hash = '#/school?tab=weather'; }) : null), // Track DIRECTOR: one weather playbook for lessons and programs (cancelDays below is no longer reached)
    h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', () => load(), { kind: 'primary' })), body);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/skischool/sessions?from=${from.value}&to=${to.value}`);
      clear(body).append(data.length ? table([
        { head: 'When', cell: (s) => fmtRange(s.starts_at, s.ends_at) },
        { head: 'Lesson', cell: (s) => h('span', null, h('strong', null, s.product), h('div', { class: 'muted small' }, lessonWords(s)), pill(s), s.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${s.meeting_place}`) : null) },
        { head: 'Instructor', cell: (s) => (s.instructor_id ? s.instructor_name || names.get(s.instructor_id) || 'Assigned' : state('Needs an instructor', 'warn')) },
        { head: 'Booked', num: true, cell: (s) => `${s.booked} of ${s.capacity}` },
        { head: 'Status', cell: (s) => h('span', null, state(label(s.status), s.status === 'scheduled' ? 'good' : s.status === 'cancelled' ? 'bad' : 'neutral'), s.cancel_reason ? h('div', { class: 'muted small' }, s.cancel_reason) : null) },
        { head: '', actions: true, cell: (s) => [
          button('Roster', () => roster(s, load), { small: true }),
          isManager() && s.status === 'scheduled' ? button('Instructor', () => setInstructor(s, load), { small: true }) : null,
          isManager() && s.status === 'scheduled' ? button('Edit', () => editSession(s, load), { small: true, label: `Edit ${s.product} ${fmtRange(s.starts_at, s.ends_at)}` }) : null,
          isManager() && s.status === 'scheduled' ? button('Cancel', () => cancelOne(s, load), { small: true }) : null,
        ] },
      ], data, { rowClass: (s) => (s.status === 'scheduled' && !s.instructor_id ? 'attention' : null) }) : empty('No lessons in this range.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

// ---- canceling lessons (routes/skischool.js, lib/lessoncancel.js)
/** What canceling does to the people on a lesson, in plain words, from the preview counts. */
function consequences(list) {
  const sum = (k) => list.reduce((n, s) => n + Number(s[k] || 0), 0);
  const booked = sum('booked'); const pack = sum('on_package'); const online = sum('paid_online');
  if (!booked) return h('p', null, 'Nobody is booked, so nobody needs telling.');
  return h('ul', { class: 'plain stack' },
    h('li', null, `${booked} booking${booked === 1 ? '' : 's'} canceled, and everyone booked gets an email.`),
    pack ? h('li', null, `${pack} package lesson${pack === 1 ? '' : 's'} go back on the package.`) : null,
    online ? h('li', null, `${online} online payment${online === 1 ? ' is' : 's are'} refunded in full to the card.`) : null,
    booked - pack - online > 0 ? h('li', null, 'Anyone who paid at the desk is listed afterwards, to refund at the counter.') : null);
}
/** After cancelling: who still needs a refund at the desk. */
function afterCancel(results) {
  const desk = results.flatMap((r) => r.desk_refunds || []);
  const cards = results.flatMap((r) => r.card_refunds || []);
  const body = h('div', { class: 'stack' },
    h('p', null, `${results.length} lesson${results.length === 1 ? '' : 's'} canceled. ${results.reduce((n, r) => n + r.emailed, 0)} email${results.reduce((n, r) => n + r.emailed, 0) === 1 ? '' : 's'} sent.`),
    cards.length ? h('p', null, `Refunded to cards: ${cards.map((c) => `${c.name} ${money(c.amount_cents)}`).join(', ')}.`) : null,
    desk.length ? h('div', { class: 'notice warn stack' }, h('b', null, 'Refund these at the desk'), h('ul', { class: 'plain' }, desk.map((d) => h('li', null, `${d.name}: ${money(d.amount_cents)}, order #${d.order_id}`))),
      h('p', { class: 'small' }, 'Open each order under Sell, Sold today or Find an order, and refund the lesson.')) : null);
  dialog('Lessons canceled', body);
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
    toast('Lesson canceled');
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
  formDialog('Cancel every lesson on a day', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'For a storm or a closure: every lesson from the first day to the last is canceled, with refunds and emails as for one lesson.'),
    h('div', { class: 'form' }, field('First day', from), field('Last day', to)), field('Reason', reason, 'Kept on the record and included in the email to guests.'), list), async (fd) => {
    if (seen !== `${from.value}|${to.value}`) { await look(); throw new Error('Check the list of lessons, then press Cancel lessons again.'); }
    const r = await post('/skischool/sessions/cancel-days', { from: val(fd, 'from'), to: val(fd, 'to'), reason: val(fd, 'reason') });
    toast(`${r.cancelled} lesson${r.cancelled === 1 ? '' : 's'} canceled`);
    await done();
    afterCancel(r.sessions);
  }, { submitText: 'Cancel lessons', wide: true });
  look();
}

/** Lowest and highest level (the nine levels), and the ages: two selects and two numbers. */
function levelAgeFields(cur = {}) {
  const disc = cur.discipline || 'ski';
  const lmin = select([['', 'Any'], ...levelOptions(disc)], cur.level_min || '', { name: 'level_min' });
  const lmax = select([['', 'Any'], ...levelOptions(disc)], cur.level_max || '', { name: 'level_max' });
  const amin = input({ type: 'number', name: 'age_min', min: 0, max: 99, value: cur.age_min ?? '', inputmode: 'numeric' });
  const amax = input({ type: 'number', name: 'age_max', min: 0, max: 99, value: cur.age_max ?? '', inputmode: 'numeric' });
  const sync = (d) => { for (const el of [lmin, lmax]) { const v = el.value; clear(el); for (const [k, t] of [['', 'Any'], ...levelOptions(d)]) el.append(h('option', { value: k, selected: k === v }, t)); } };
  return { els: [field('Lowest level', lmin, 'PSIA-AASI levels 1 to 9'), field('Highest level', lmax), field('Youngest age', amin, 'Blank: any age'), field('Oldest age', amax, '12 or under counts as a kids lesson')], sync };
}
const levelAgeBody = (fd) => ({ level_min: num(fd, 'level_min') || null, level_max: num(fd, 'level_max') || null, age_min: fd.get('age_min') === '' ? null : num(fd, 'age_min'), age_max: fd.get('age_max') === '' ? null : num(fd, 'age_max') });

const sessionFields = (products, staff, certs) => {
  const disc = select(DISCIPLINES, 'ski', { name: 'discipline' });
  const la = levelAgeFields();
  disc.addEventListener('change', () => la.sync(disc.value));
  return [
    field('Lesson product', select(products.map((p) => [p.id, p.name]), products[0].id, { name: 'product_id' }), 'Packages are sold, not scheduled'),
    field('Type', select(FORMATS, 'group', { name: 'format' }), 'Sets the usual number of spots'),
    field('Discipline', disc),
    ...la.els,
    field('Spots (blank = usual for the type)', input({ type: 'number', name: 'capacity', min: 1, max: 60 })),
    field('Meet at', input({ name: 'meeting_place', maxlength: 120, placeholder: 'For example: Base lodge, door 2' })),
    field('Required certification', select([['', 'None'], ...certs.map((c) => [c.id, c.name])], '', { name: 'cert' })),
  ];
};
const sessionBody = (fd) => ({
  product_id: num(fd, 'product_id'), format: val(fd, 'format'), discipline: val(fd, 'discipline'), ...levelAgeBody(fd),
  capacity: num(fd, 'capacity') || undefined, meeting_place: val(fd, 'meeting_place') || undefined,
  instructor_id: num(fd, 'instructor_id') || undefined, required_certification_id: num(fd, 'cert') || undefined,
  override_reason: val(fd, 'override_reason') || undefined,
});

/**
 * The instructor picker for a lesson: only people who teach, best fit first, with why someone does not fit. Picking
 * someone with a problem asks a manager for a reason ("Assign anyway"), which is kept on the record.
 * load(): the fit list ([{ id, name, ok, problems, requested_by }]).
 */
function instructorPicker(load, current) {
  const sel = select([['', 'Assign later']], '', { name: 'instructor_id', 'aria-label': 'Instructor' });
  const why = h('div', { class: 'small', 'aria-live': 'polite' });
  const reason = input({ name: 'override_reason', maxlength: 300, placeholder: 'For example: shadowing, the only one free' });
  const reasonField = field('Reason to assign anyway', reason, 'Kept on the record');
  reasonField.hidden = true;
  let list = [];
  const show = () => {
    const x = list.find((i) => String(i.id) === sel.value);
    clear(why);
    reasonField.hidden = !(x && !x.ok);
    reason.required = Boolean(x && !x.ok);
    if (x && !x.ok) why.append(h('div', { class: 'notice warn' }, h('strong', null, `${x.name} does not fit: `), x.problems.join('. '), '. You can still assign them with a reason.'));
  };
  sel.addEventListener('change', show);
  const refresh = async () => {
    try { list = await load(); } catch (_) { list = []; }
    const keep = sel.value || (current ? String(current) : '');
    clear(sel).append(h('option', { value: '' }, 'Assign later'));
    const good = list.filter((x) => x.ok); const rest = list.filter((x) => !x.ok);
    if (good.length) sel.append(h('optgroup', { label: 'Free and cleared' }, good.map((x) => h('option', { value: x.id, selected: String(x.id) === keep }, `${x.name}${x.requested_by ? `, asked for by ${x.requested_by}` : ''}`))));
    if (rest.length) sel.append(h('optgroup', { label: 'Does not fit' }, rest.map((x) => h('option', { value: x.id, selected: String(x.id) === keep }, `${x.name}: ${x.problems[0]}`))));
    show();
  };
  return { el: h('div', { class: 'stack tight wide' }, field('Instructor', sel, 'Only people who teach. Best fit first.'), why, reasonField), refresh, sel };
}

async function singleProducts() {
  const { data } = await get('/products?kind=lesson&active=1&limit=500');
  return data.filter((p) => !(p.uses > 1));
}

async function addSession(staff, certs, done) {
  const products = await singleProducts();
  if (!products.length) { toast('Add a lesson product first, under Products and prices', 'error'); return; }
  const starts = input({ type: 'datetime-local', name: 'starts_at', value: `${todayStr()}T10:00`, required: true });
  const ends = input({ type: 'datetime-local', name: 'ends_at', value: `${todayStr()}T12:00`, required: true });
  const f = h('div', { class: 'form' }, sessionFields(products, staff, certs), field('Starts', starts), field('Ends', ends));
  const form = () => f.closest('form');
  const picker = instructorPicker(async () => {
    const fd = new FormData(form());
    const b = sessionBody(fd);
    return (await post('/skischool/instructor-fit', { starts_at: starts.value, ends_at: ends.value, discipline: b.discipline, level_max: b.level_max, age_max: b.age_max, required_certification_id: b.required_certification_id || null })).data;
  });
  f.append(picker.el);
  formDialog('Add a lesson', f, async (fd) => {
    await post('/skischool/sessions', { ...sessionBody(fd), starts_at: val(fd, 'starts_at'), ends_at: val(fd, 'ends_at') });
    toast('Lesson added');
    await done();
  });
  // Re-check who fits when the time, level, ages, discipline or certification change.
  for (const name of ['starts_at', 'ends_at', 'discipline', 'level_max', 'age_max', 'cert']) { const el = f.querySelector(`[name="${name}"]`); if (el) el.addEventListener('change', () => picker.refresh()); }
  await picker.refresh();
}

/** Change a lesson's levels, ages, meeting place, spots or type. */
function editSession(s, done) {
  const la = levelAgeFields(s);
  formDialog(`${s.product}, ${fmtRange(s.starts_at, s.ends_at)}`, h('div', { class: 'form' },
    field('Type', select(FORMATS, s.format, { name: 'format' })), ...la.els,
    field('Spots', input({ type: 'number', name: 'capacity', min: 1, max: 60, value: s.capacity })),
    field('Meet at', input({ name: 'meeting_place', maxlength: 120, value: s.meeting_place || '' }))), async (fd) => {
    await patch(`/skischool/sessions/${s.id}`, { ...levelAgeBody(fd), format: val(fd, 'format'), capacity: num(fd, 'capacity') || undefined, meeting_place: val(fd, 'meeting_place') });
    toast('Lesson saved');
    await done();
  });
}

/** The same lesson at the same time on several days: pick a first day, how many days, and which weekdays to skip. */
async function addSeries(staff, certs, done) {
  const products = await singleProducts();
  if (!products.length) { toast('Add a lesson product first, under Products and prices', 'error'); return; }
  const days = WEEKDAYS.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `wd${i}`, checked: true }), ` ${d}`));
  const f = h('div', { class: 'form' }, sessionFields(products, staff, certs),
    field('Instructor', select([['', 'Assign later'], ...staff.map((x) => [x.id, `${x.first_name} ${x.last_name}`])], '', { name: 'instructor_id' }), 'Checked for every day: anyone busy or not cleared on a day stops the series'),
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
  const picker = instructorPicker(async () => (await get(`/skischool/sessions/${s.id}/eligible-instructors`)).data, s.instructor_id);
  await picker.refresh();
  formDialog(`Instructor for ${s.product}, ${fmtTime(s.starts_at)}`, h('div', { class: 'form' }, h('p', { class: 'muted small wide' }, lessonWords(s)), picker.el), async (fd) => {
    await patch(`/skischool/sessions/${s.id}/instructor`, { instructor_id: num(fd, 'instructor_id') || null, override_reason: val(fd, 'override_reason') || undefined });
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
          h('div', null, s.product, pill(s), h('div', { class: 'muted small' }, lessonWords(s))),
          s.delay_minutes ? h('div', null, state(`Delayed ${s.delay_minutes} min`, 'warn')) : null,
          s.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${s.meeting_place}`) : null,
          h('div', null, s.instructor ? h('strong', null, s.instructor) : state('Needs an instructor', 'warn')),
          s.notes ? h('p', { class: 'small' }, s.notes) : null,
          s.students.length ? h('ul', { class: 'students' }, s.students.map((x) => h('li', null, h('a', { href: '#', class: 'link', onclick: (e) => { e.preventDefault(); cardDialog(x.person_id, { onChange: load, discipline: s.discipline }); } }, `${x.first_name} ${x.last_name}`),
            x.level ? h('span', { class: 'muted small' }, `  ${levelName(x.level, s.discipline)}`) : null, flags(x), x.unpaid ? h('span', null, ' ', state('Unpaid', 'warn')) : null, x.requested_instructor_id && x.requested_instructor_id === s.instructor_id ? h('span', null, ' ', state('Requested', 'good')) : null,
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
const TEXT_WORDS = 'Text me about this lesson: check-in, changes and the recap. Message and data rates may apply. Reply STOP to stop.';
const PHOTO_WORDS = 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.';
const textsOn = () => Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes('lesson_texts'));

/**
 * The safety details and consents for one booking, as form fields: allergies, medical notes, who picks up, who to call,
 * the email for the confirmation, texts (only with the Texts to families add-on) and photos. fill(d) puts values in.
 */
function safetyFields(prefix = '') {
  const n = (k) => `${prefix}${k}`;
  const els = {
    allergies: input({ name: n('allergies'), maxlength: 300, placeholder: 'For example: peanuts. Blank if none' }),
    medical: h('textarea', { name: n('medical'), maxlength: 500, rows: 2, placeholder: 'Anything the instructor must know: asthma, an inhaler, diabetes. Blank if none' }),
    pickup: input({ name: n('pickup'), maxlength: 300, placeholder: 'Who may pick up the child, for example: Mom (Ana) or Grandpa Joe' }),
    contact_name: input({ name: n('contact_name'), maxlength: 150, autocomplete: 'name' }),
    contact_phone: input({ name: n('contact_phone'), maxlength: 40, type: 'tel', autocomplete: 'tel' }),
    contact_email: input({ name: n('contact_email'), maxlength: 255, type: 'email', autocomplete: 'email' }),
    text_ok: h('input', { type: 'checkbox', name: n('text_ok') }),
    photo_ok: h('input', { type: 'checkbox', name: n('photo_ok') }),
  };
  const el = h('fieldset', { class: 'form safety' }, h('legend', null, 'Safety and contact'),
    field('Allergies', els.allergies), h('div', { class: 'wide' }, field('Medical notes', els.medical)), h('div', { class: 'wide' }, field('Pickup', els.pickup)),
    field('Parent or contact', els.contact_name), field('Their phone', els.contact_phone), h('div', { class: 'wide' }, field('Email for the confirmation', els.contact_email)),
    textsOn() ? h('label', { class: 'check wide' }, els.text_ok, ` ${TEXT_WORDS}`) : null,
    h('label', { class: 'check wide' }, els.photo_ok, ` ${PHOTO_WORDS}`));
  const fill = (d) => { for (const k of ['allergies', 'medical', 'pickup', 'contact_name', 'contact_phone', 'contact_email']) els[k].value = d[k] || ''; els.text_ok.checked = Boolean(d.text_ok); els.photo_ok.checked = Boolean(d.photo_ok); };
  const read = () => {
    const out = {};
    for (const k of ['allergies', 'medical', 'pickup', 'contact_name', 'contact_phone', 'contact_email']) out[k] = els[k].value.trim() || null;
    if (textsOn()) out.text_ok = els.text_ok.checked;
    out.photo_ok = els.photo_ok.checked;
    return out;
  };
  return { el, fill, read, els };
}

async function roster(session, done) {
  const list = h('div');
  const def = await loadCustomerForm();
  const wslot = h('div');
  const creditSlot = h('div');
  const safety = safetyFields();
  const confirmBox = h('input', { type: 'checkbox', name: 'send_confirmation', checked: true });
  const confirmRow = h('label', { class: 'check' }, confirmBox, ' Email the confirmation (time, meeting place, what to bring and their check-in link)');
  const syncConfirm = () => { const has = Boolean(safety.els.contact_email.value.trim()); confirmRow.hidden = !has; if (!has) confirmBox.checked = false; };
  safety.els.contact_email.addEventListener('input', () => { if (safety.els.contact_email.value.trim()) confirmBox.checked = true; syncConfirm(); });
  let credit = null;
  const capture = customerCapture({ def, scope: 'lesson', who: 'Student', onPick: async (p) => {
    clear(wslot); clear(creditSlot); credit = null;
    safety.fill({});
    if (!p) { syncConfirm(); return; }
    wslot.append(waiverPanel(p.id, session.starts_at.slice(0, 10)));
    // Fill the safety details from their last booking (or their emergency contact); staff check them with the family.
    try { const d = await get(`/skischool/students/${p.id}/safety`); safety.fill(d); confirmBox.checked = Boolean(d.contact_email); } catch (_) { /* typed fresh */ }
    syncConfirm();
    try {
      const { data } = await get(`/skischool/credits?person_id=${p.id}`);
      const usable = data.filter((c) => c.left > 0 && (!c.expires_on || c.expires_on >= session.starts_at.slice(0, 10)));
      if (usable.length) {
        credit = select([['', 'Do not use a package'], ...usable.map((c) => [c.id, `${c.product}: ${c.left} left`])], usable[0].id, { name: 'use-credit', 'aria-label': 'Use a lesson package' });
        creditSlot.append(field('Lesson package', credit, 'Uses one lesson from their package instead of being paid for now'));
      }
    } catch (_) { /* no packages to offer */ }
  } });
  syncConfirm();
  const signBox = h('input', { type: 'checkbox', name: 'sign_waiver' });
  const signRow = h('label', { class: 'check' }, signBox, ' The student has signed the season waiver (record it now if none is on file)');

  async function load() {
    const r = await get(`/skischool/sessions/${session.id}/roster`);
    const data = r.data;
    clear(list).append(data.length ? table([
      { head: 'Student', cell: (x) => h('span', null, h('strong', null, `${x.first_name} ${x.last_name}`), x.unpaid ? h('span', null, ' ', state('Unpaid', 'warn')) : null, x.credit_id ? h('span', null, ' ', state('Package', 'neutral')) : null,
        flags(x), x.pickup ? h('div', { class: 'small' }, `Pickup: ${x.pickup}`) : null,
        x.contact_phone ? h('div', { class: 'small' }, h('a', { href: `tel:${String(x.contact_phone).replace(/[^\d+]/g, '')}` }, `${x.contact_name || 'Contact'}: ${x.contact_phone}`)) : null,
        x.checked_in_at ? h('div', null, state('Checked in', 'good')) : null) },
      { head: 'Level', cell: (x) => (x.level ? levelName(x.level, session.discipline) : h('span', { class: 'muted' }, 'Not set')) },
      { head: 'Status', cell: (x) => (can('counter') || r.details ? select([['booked', 'Booked'], ['attended', 'Attended'], ['no_show', 'No show'], ...(can('counter') ? [['cancelled', 'Cancel']] : [])], x.status, {
        'aria-label': `Status for ${x.first_name} ${x.last_name}`,
        onChange: async (e) => { try { await patch(`/skischool/bookings/${x.booking_id}`, { status: e.target.value }); toast('Updated'); if (e.target.value === 'cancelled') await load(); } catch (err) { fail(err); } },
      }) : label(x.status)) },
      { head: '', actions: true, cell: (x) => [
        button('Report card', () => cardDialog(x.person_id, { discipline: session.discipline }), { small: true, label: `Report card for ${x.first_name}` }),
        r.details ? button('Safety', () => editSafety(x, load), { small: true, label: `Safety details for ${x.first_name}` }) : null,
        can('instructor') && r.details ? button('Lesson note', () => bookingNote(x, load), { small: true }) : null,
        can('counter') ? button(x.confirmed_at ? 'Resend confirmation' : 'Send confirmation', async () => { const o = await post(`/skischool/bookings/${x.booking_id}/confirmation`, {}); toast(`Confirmation sent to ${o.to}`); await load(); }, { small: true, label: `Send the confirmation for ${x.first_name}` }) : null,
      ] },
    ], data) : h('p', { class: 'muted' }, 'No one is booked yet.'));
  }
  const book = button('Book student', async () => {
    capture.check();
    const body = { ...capture.payload('student'), sign_waiver: signBox.checked, ...safety.read(), send_confirmation: confirmBox.checked };
    if (credit && credit.value) body.use_credit_id = Number(credit.value);
    let out;
    try {
      out = await post(`/skischool/sessions/${session.id}/bookings`, body);
    } catch (err) {
      // The student was saved even though the booking was not (no waiver yet, the class is full, already in another lesson): keep them selected so a retry does not create a second record.
      const pid = err.details && err.details.person_id;
      if (pid && !capture.person()) { try { capture.usePerson(await get(`/people/${pid}`)); } catch (_) { /* leave the form as typed */ } }
      throw err;
    }
    const sent = out.confirmation && out.confirmation.ok ? ` Confirmation sent to ${out.confirmation.to}.` : out.confirmation && out.confirmation.error ? ` The confirmation was not sent: ${out.confirmation.error}.` : '';
    toast(`${out.customer.created ? 'Student saved and booked.' : 'Student booked.'}${sent}`);
    capture.reset();
    signBox.checked = false;
    safety.fill({}); syncConfirm();
    clear(creditSlot); clear(wslot); credit = null;
    await load();
    if (done) done();
  }, { kind: 'primary' });
  const canBook = can('counter', 'instructor');
  dialog(`${fmtDateTime(session.starts_at)}, ${session.product}`, [
    h('p', { class: 'muted' }, `${lessonWords(session)}. ${session.capacity} spots.${canBook ? ' Students need a signed waiver for the season.' : ''}`),
    list, canBook ? [h('h3', null, 'Add a student'), capture.el, signRow, wslot, creditSlot, safety.el, confirmRow, h('div', { class: 'row' }, book)] : null], { wide: true });
  await load();
}

/** Change one booking's safety details and consents. */
async function editSafety(x, done) {
  const f = safetyFields();
  f.fill(x);
  formDialog(`Safety and contact for ${x.first_name} ${x.last_name}`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Only the lesson\'s instructor, the desk and managers see these.'), f.el), async () => {
    await patch(`/skischool/bookings/${x.booking_id}/safety`, f.read());
    toast('Saved');
    await done();
  }, { wide: true });
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
  const status = select([['pending', 'Waiting'], ['confirmed', 'Confirmed'], ['awaiting_payment', 'Paying now'], ['declined', 'Declined'], ['cancelled', 'Canceled by guest'], ['expired', 'Not completed']], 'pending', { name: 'req-status', 'aria-label': 'Show requests' });
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
/**
 * The nine levels (PSIA-AASI) for ski and snowboard, in plain words, with the mountain's own "I can" skills for each
 * level. Instructors tick the skills on the report card. Telemark and adaptive lessons use the ski levels.
 */
async function levelsTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Every lesson, program, report card and guest uses the same nine levels. Level 1 is a first time on snow, level 9 skis or rides anything. Add the skills students show at each level; instructors tick them off on the report card.'), body);
  async function load() {
    const { data } = await get('/skischool/levels');
    clear(body);
    for (const d of ['ski', 'snowboard']) {
      const levels = data.filter((l) => l.discipline === d);
      body.append(h('section', { class: 'panel stack', 'data-ladder': d }, h('h2', null, label(d)),
        levels.map((l) => h('details', { class: 'level' },
          h('summary', null, `Level ${l.rank_no}: ${l.name}`, h('span', { class: 'muted' }, `  ${l.skills.length} skill${l.skills.length === 1 ? '' : 's'}`)),
          h('p', { class: 'muted small' }, l.description || (levelList(d)[l.rank_no - 1] || {}).can || ''),
          h('ul', { class: 'skills' }, l.skills.map((sk) => h('li', null, sk.name, isManager() ? h('span', { class: 'row' }, ' ',
            button('Rename', () => formDialog('Rename skill', h('div', { class: 'form' }, field('Skill', input({ name: 'name', required: true, maxlength: 160, value: sk.name }))), async (fd) => { await patch(`/skischool/skills/${sk.id}`, { name: val(fd, 'name') }); await load(); }), { small: true, label: `Rename ${sk.name}` }),
            button('Remove', () => confirmDialog('Remove this skill?', sk.name, 'Remove', async () => { try { await del(`/skischool/skills/${sk.id}`); await load(); } catch (err) { fail(err); } }, { danger: true }), { small: true, label: `Remove ${sk.name}` })) : null))),
          isManager() ? h('div', { class: 'row' },
            button('Add a skill', () => formDialog(`Add a skill to level ${l.rank_no}`, h('div', { class: 'form' }, field('Skill', input({ name: 'name', required: true, maxlength: 160, placeholder: 'Start with "I can", for example: I can stop on the beginner slope' }))), async (fd) => { await post(`/skischool/levels/${l.id}/skills`, { name: val(fd, 'name') }); await load(); }), { small: true }),
            button('Describe level', () => formDialog(`Level ${l.rank_no}: ${l.name}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('What a student at this level can do', input({ name: 'description', maxlength: 300, value: l.description || '' })))), async (fd) => { await patch(`/skischool/levels/${l.id}`, { description: val(fd, 'description') }); await load(); }), { small: true })) : null))));
    }
  }
  await load();
}

/** Settings, Ski school, Confirmations: the email families get when a lesson is booked, and what to bring. */
async function basicsPage(root) {
  const st = await get('/skischool/settings');
  const on = h('input', { type: 'checkbox', name: 'confirm_email', checked: Boolean(st.confirm_email) });
  const bring = h('textarea', { name: 'what_to_bring', rows: 3, maxlength: 500, placeholder: 'For example: warm layers, waterproof gloves, goggles, a helmet and a snack. Please arrive 20 minutes early.' }, st.what_to_bring || '');
  const save = button('Save', async () => {
    await patch('/skischool/settings', { confirm_email: on.checked, what_to_bring: bring.value.trim() || null });
    toast('Saved');
  }, { kind: 'primary' });
  root.append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'When a lesson is booked (at the desk, online, or from a request you confirm), the family gets an email with the time, where to meet, what to bring, their own link to check in or change the date, and your cancellation policy. With the Texts to families add-on, families who say yes get a text too.'),
    h('label', { class: 'check' }, on, ' Email a confirmation when a lesson is booked'),
    h('p', { class: 'muted small' }, 'Staff can still send one from the roster with Send confirmation.'),
    field('What to bring', bring, 'In every confirmation. Blank uses a sensible default.'),
    h('div', { class: 'row' }, save)));
}

// ---------------------------------------------------------------- instructors: what each is cleared to teach
async function instructorsTab(root, { certs }) {
  const body = h('div');
  root.append(h('p', { class: 'muted' }, 'Who teaches, and what each instructor is cleared for. The instructor picker uses this: someone not cleared for a lesson\'s level, for kids or for adaptive lessons is shown as not a fit.'), body);
  async function load() {
    const { data } = await get('/skischool/instructors');
    const teach = data.filter((x) => x.teaches);
    const cap = (n) => (n ? `up to level ${n}` : 'any level');
    clear(body).append(teach.length ? table([
      { head: 'Instructor', cell: (x) => h('strong', null, x.name) },
      { head: 'Teaches', cell: (x) => h('span', null, (x.disciplines.length ? x.disciplines.map(label).join(', ') : 'Not set'),
        h('div', { class: 'muted small' }, [x.disciplines.includes('snowboard') || !x.disciplines.length ? `Snowboard ${cap(x.snowboard_level_max)}` : null, x.disciplines.includes('ski') || !x.disciplines.length ? `Ski ${cap(x.ski_level_max)}` : null].filter(Boolean).join(', '))) },
      { head: 'Kids', cell: (x) => (x.teaches_kids ? 'Yes' : 'No') },
      { head: 'Adaptive', cell: (x) => (x.teaches_adaptive ? 'Yes' : 'No') },
      { head: 'PSIA-AASI', cell: (x) => (PSIA.find((p) => p[0] === x.psia_level) || PSIA[0])[1] },
      { head: 'Certifications', cell: (x) => (x.certifications.length ? x.certifications.map((c) => `${c.name}${c.expires_on ? ` (until ${fmtDate(c.expires_on)})` : ''}`).join(', ') : h('span', { class: 'muted' }, 'None')) },
      { head: '', actions: true, cell: (x) => button('Edit', () => editInstructor(x, certs, load), { small: true, label: `Edit ${x.name}` }) },
    ], teach) : empty('Nobody teaches yet. Give a staff member an instructor login under Settings, Team, or set up their teaching here.'));
    const others = data.filter((x) => !x.teaches);
    if (others.length) body.append(h('details', null, h('summary', null, `Other staff (${others.length})`), h('ul', { class: 'plain' }, others.map((x) => h('li', null, x.name, ' ', button('Set up to teach', () => editInstructor(x, certs, load), { small: true, label: `Set up ${x.name} to teach` }))))));
  }
  await load();
}

function editInstructor(x, certs, done) {
  const box = (name, checked, text) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, checked }), ` ${text}`);
  const capSel = (name, v) => select([['', 'Any level'], ...levelOptions(name.startsWith('snow') ? 'snowboard' : 'ski').map(([k, t]) => [k, `Up to ${t}`])], v || '', { name });
  const held = new Map(x.certifications.map((c) => [c.id, c]));
  const certRows = certs.map((c) => h('div', { class: 'inline-form' }, box(`cert_${c.id}`, held.has(c.id), c.name),
    field('Expires', input({ type: 'date', name: `cert_exp_${c.id}`, value: held.get(c.id) && held.get(c.id).expires_on ? String(held.get(c.id).expires_on).slice(0, 10) : '' }))));
  formDialog(`Teaching: ${x.name}`, h('div', { class: 'form' },
    h('div', { class: 'wide row' }, ...DISCIPLINES.map((d) => box(`d_${d}`, x.disciplines.includes(d), label(d)))),
    field('Ski: cleared to', capSel('ski_level_max', x.ski_level_max)),
    field('Snowboard: cleared to', capSel('snowboard_level_max', x.snowboard_level_max)),
    box('teaches_kids', x.teaches_kids, 'Teaches kids (12 and under)'),
    box('teaches_adaptive', x.teaches_adaptive, 'Teaches adaptive lessons'),
    field('PSIA-AASI', select(PSIA, x.psia_level, { name: 'psia_level' })),
    certs.length ? h('fieldset', { class: 'wide stack' }, h('legend', null, 'Certifications'), certRows) : null), async (fd) => {
    await put(`/skischool/instructors/${x.id}/profile`, {
      disciplines: DISCIPLINES.filter((d) => fd.get(`d_${d}`)), ski_level_max: num(fd, 'ski_level_max') || null, snowboard_level_max: num(fd, 'snowboard_level_max') || null,
      teaches_kids: Boolean(fd.get('teaches_kids')), teaches_adaptive: Boolean(fd.get('teaches_adaptive')), psia_level: val(fd, 'psia_level'),
    });
    for (const c of certs) {
      const want = Boolean(fd.get(`cert_${c.id}`));
      const exp = val(fd, `cert_exp_${c.id}`);
      if (want) await put(`/workforce/staff/${x.id}/certifications`, { certification_id: c.id, expires_on: exp || null });
      else if (held.has(c.id)) await del(`/workforce/staff/${x.id}/certifications/${c.id}`);
    }
    toast('Saved');
    await done();
  }, { wide: true });
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
