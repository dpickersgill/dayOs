// The ski school, round 2 (pay). school.js adds these tabs to Ski school and these pages to Settings, Ski school.
// tabs(ctx): [[key, label, (panel) => render]], ctx = { staff, names, certs }. settingsPages: { key: { title, render(panel) } }.
//   Privates:  instructors answer private lessons asked for by name; the desk and managers see every request and assign by hand.
//   My pay:    an instructor's lines for the week and the season, with tips by lesson, and "Ask a question".
//   My guests: an instructor's past private guests, to offer them another time (managers can book one directly).
//   Payroll:   managers approve a pay period and export it as CSV; tips are listed apart and marked paid out.
// Settings, Ski school: Pay (how the school pays), Pay rates, Privates online (the lengths sold on /private/<mountain>).
// payLine(lesson) and myDayTop(panel) are used by the instructor's My day (school-myday.js).
import { get, post, patch, del, download } from '../api.js';
import { h, clear, ctx, can, isManager, table, state, input, select, field, button, toast, formDialog, dialog, val, money, toCents, centsToInput,
  todayStr, addDays, weekStart, fmtDate, fmtTime, fmtRange, label, empty, errorBox, loading, confirmDialog, fail, appendAll } from '../ui.js';

const KINDS = [['group', 'Group lesson'], ['semi_private', 'Semi-private'], ['private', 'Private'], ['hourly', 'Hourly'], ['program', 'Program meeting']];
const MODES = [['per_lesson', 'Per lesson: each lesson pays its rate'], ['hourly', 'Hourly: paid by the hour (the time card, or the lesson time)'], ['both', 'Both: the lesson rate plus hourly pay']];
const isInstructor = () => Boolean(ctx.me && ctx.me.role === 'instructor');
const myStaff = () => (ctx.me && ctx.me.staff_id) || null;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hours = (min) => `${Math.round((Number(min || 0) / 60) * 100) / 100} h`;
const lengthWords = (m) => (m % 60 === 0 ? plural(m / 60, 'hour') : `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min`);
/** A UTC instant ('...Z') as the mountain's clock time, "2:15 PM". */
const atClock = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: ctx.tz || 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const minutesLeft = (iso) => Math.round((new Date(iso) - Date.now()) / 60000);
const leftWords = (iso) => { const m = minutesLeft(iso); if (m <= 0) return 'time is up'; return m < 90 ? `${m} min left` : `${Math.round(m / 60)} h left`; };
/** "$46.00 (private $40.00 + request $6.00)" from the server's parts. */
export const payWords = (p) => (p.parts && p.parts.length > 1 ? `${money(p.cents)} (${p.parts.filter((x) => x.cents).map((x) => `${x.label} ${money(x.cents)}`).join(' + ')})` : money(p.cents));

export function tabs(_ctx) {
  const out = [];
  if (can('instructor', 'counter')) out.push(['privates', 'Privates', (panel) => privatesTab(panel)]);
  if (can('instructor')) out.push(['mypay', isManager() ? 'Instructor pay' : 'My pay', (panel) => myPayTab(panel)]);
  if (can('instructor')) out.push(['guests', isManager() ? 'Rebook guests' : 'My guests', (panel) => guestsTab(panel)]);
  if (isManager()) out.push(['payroll', 'Payroll', (panel) => payrollTab(panel)]);
  return out;
}

export const settingsPages = {
  pay: { title: 'Instructor pay', render: (panel) => paySettings(panel) },
  'pay-rates': { title: 'Pay rates', render: (panel) => ratesPage(panel) },
  privates: { title: 'Privates online', render: (panel) => offersPage(panel) },
};

// ================================================================ My day hooks
const dayCache = new Map(); // date -> Promise of /skischool/pay/my-day
function myDayData(date) {
  if (!dayCache.has(date)) dayCache.set(date, get(`/skischool/pay/my-day?date=${date}`).catch((err) => { dayCache.delete(date); throw err; }));
  return dayCache.get(date);
}
/** Forget the cached pay lines (after accepting a private, the day changes). */
export function refreshPay() { dayCache.clear(); }

/** A short pay line for a lesson on the instructor's My day ("Your pay: ..."), or null. It fills itself in when the day's pay arrives. */
export function payLine(lesson) {
  if (!lesson || !myStaff()) return null;
  const id = lesson.session_id || lesson.id;
  const date = String(lesson.starts_at || '').slice(0, 10);
  if (!id || !date) return null;
  const el = h('p', { class: 'pay-line small muted', 'aria-live': 'polite' });
  myDayData(date).then((d) => {
    const p = d.lessons && d.lessons[id];
    if (!p) { el.remove(); return; }
    appendAll(el, h('span', { class: 'pay-label' }, 'Your pay: '), p.cents ? payWords(p) : (p.note || 'Not paid by the lesson'), p.cents && p.note ? h('span', { class: 'pay-note' }, ` ${p.note}`) : null);
  }).catch(() => el.remove());
  return el;
}

/** Privates asked for by name waiting for this instructor, at the top of My day. opts.date: the day My day shows. */
export async function myDayTop(panel, opts = {}) {
  if (!myStaff()) return;
  const box = h('div', { class: 'stack pay-top' });
  panel.append(box);
  let d;
  try { d = await myDayData(opts.date || todayStr()); } catch (_) { box.remove(); return; }
  if (!d.requests || !d.requests.length) { box.remove(); return; }
  box.append(h('h2', { class: 'pay-top-head' }, d.requests.length === 1 ? 'A private lesson is waiting for your answer' : `${d.requests.length} private lessons are waiting for your answer`),
    ...d.requests.map((r) => requestCard(r, async () => { refreshPay(); clear(box); box.remove(); await myDayTop(panel, opts); window.dispatchEvent(new CustomEvent('school:changed')); })));
}

/** One request an instructor can answer: when, who, levels, the deadline, what it pays; Accept and Decline. */
function requestCard(r, done) {
  return h('article', { class: 'panel stack req-card', 'aria-label': `Private request ${r.reference}` },
    h('div', { class: 'row between' },
      h('strong', { class: 'req-when' }, `${fmtDate(r.starts_at)}, ${fmtTime(r.starts_at)}`),
      r.deadline_at ? state(`Answer by ${atClock(r.deadline_at)} (${leftWords(r.deadline_at)})`, minutesLeft(r.deadline_at) < 30 ? 'bad' : 'warn') : null),
    h('div', null, `${lengthWords(r.minutes)} ${label(r.discipline)} private, ${r.any_instructor ? 'any instructor' : 'asked for you by name'}`),
    h('ul', { class: 'plain req-students' }, r.students.map((s) => h('li', null, h('strong', null, s.first_name), ` ${s.last_name ? `${s.last_name[0]}.` : ''}  `, h('span', { class: 'muted' }, s.level_words || 'Level not given')))),
    r.note ? h('p', { class: 'small' }, h('span', { class: 'muted' }, 'Family note: '), r.note) : null,
    r.pay ? h('p', { class: 'pay-line' }, h('span', { class: 'pay-label' }, 'Your pay: '), r.pay.cents ? payWords(r.pay) : 'No private rate is set yet') : null,
    h('div', { class: 'row' },
      button('Accept', async () => { await post(`/skischool/pay/requests/${r.id}/accept`, {}); toast('Accepted. The lesson is on your day and the family is told.'); await done(); }, { kind: 'primary', label: `Accept the private on ${fmtDate(r.starts_at)}` }),
      button('Decline', () => declineDialog(r, done), { label: `Decline the private on ${fmtDate(r.starts_at)}` })));
}
function declineDialog(r, done) {
  const why = input({ name: 'reason', maxlength: 300, placeholder: 'Optional, for the ski school' });
  formDialog('Decline this private?', h('div', { class: 'stack' },
    h('p', null, r.any_instructor ? 'It stays open for the other instructors.' : 'The family is offered another instructor who is free then, or a full refund, by the school\'s setting.'),
    field('Reason', why)), async (fd) => {
    await post(`/skischool/pay/requests/${r.id}/decline`, { reason: val(fd, 'reason') || undefined });
    toast('Declined');
    await done();
  }, { submitText: 'Decline' });
}

// ================================================================ Privates tab
async function privatesTab(root) {
  if (isInstructor()) return mineRequests(root);
  return allRequests(root);
}

async function mineRequests(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Private lessons families asked for with you by name, or with any instructor who teaches them. Answer before the time runs out, or the family is offered someone else.'), body);
  async function load() {
    clear(body).append(loading());
    const d = await get('/skischool/pay/requests');
    clear(body);
    body.append(h('h2', null, 'Waiting for you'));
    if (!d.waiting.length) body.append(empty('Nothing is waiting for you right now.'));
    for (const r of d.waiting) body.append(requestCard(r, async () => { refreshPay(); await load(); }));
    if (d.recent.length) {
      body.append(h('h2', null, 'Your recent requests'), table([
        { head: 'When', cell: (r) => fmtRange(r.starts_at, r.ends_at) },
        { head: 'Students', cell: (r) => r.students.map((s) => s.first_name).join(', ') },
        { head: 'Status', cell: (r) => statusPill(r) },
      ], d.recent));
    }
  }
  await load();
}

const STATUS = { waiting: ['Waiting for the instructor', 'warn'], offered: ['Family is choosing another instructor', 'warn'], accepted: ['Booked', 'good'], refunded: ['Refunded', 'neutral'], declined: ['Declined', 'neutral'], cancelled: ['Canceled', 'neutral'], expired: ['Not paid', 'neutral'] };
const statusPill = (r) => state(...(STATUS[r.status] || [label(r.status), 'neutral']));

async function allRequests(root) {
  const which = select([['open', 'Open'], ['accepted', 'Booked'], ['all', 'All']], 'open', { name: 'status', 'aria-label': 'Show' });
  const body = h('div', { class: 'stack' });
  let slug = null;
  try { slug = (await get('/skischool/pay/private-offers')).slug; } catch (_) { /* the link is optional */ }
  root.append(h('div', { class: 'row between' }, h('p', { class: 'muted' }, 'Private lessons asked for online. Instructors accept them on My day; you can give one to an instructor by hand.'),
    slug ? h('a', { class: 'btn small', href: `/private/${encodeURIComponent(slug)}`, target: '_blank', rel: 'noopener' }, 'Open the private lesson page') : null),
  h('div', { class: 'inline-form' }, field('Show', which)), body);
  which.addEventListener('change', () => load());
  let staff = null;
  async function load() {
    clear(body).append(loading());
    try {
      const { requests } = await get(`/skischool/pay/requests?scope=all&status=${which.value}`);
      clear(body).append(requests.length ? table([
        { head: 'When', cell: (r) => h('span', null, fmtRange(r.starts_at, r.ends_at), h('div', { class: 'muted small' }, `${lengthWords(r.minutes)} ${label(r.discipline)}, ${r.level_words}`)) },
        { head: 'Students', cell: (r) => h('span', null, r.students.map((s) => s.first_name).join(', '), h('div', { class: 'muted small' }, `${r.contact_name}, ${r.contact_phone}`)) },
        { head: 'Asked for', cell: (r) => r.staff_name || (r.any_instructor ? 'Any instructor' : '') },
        { head: 'Status', cell: (r) => h('span', null, statusPill(r), r.status === 'waiting' && r.deadline_at ? h('div', { class: 'muted small' }, `Answer by ${atClock(r.deadline_at)}`) : null,
          r.pay_at_desk ? h('div', { class: 'muted small' }, 'Pays at the desk') : h('div', { class: 'muted small' }, `Paid ${money(r.amount_cents)}${r.refund_cents ? `, refunded ${money(r.refund_cents)}` : ''}`),
          r.staff_note ? h('div', { class: 'muted small' }, r.staff_note) : null) },
        { head: '', actions: true, cell: (r) => (['waiting', 'offered'].includes(r.status) ? [
          button('Assign', () => assignDialog(r), { small: true, label: `Assign the private for ${r.students[0].first_name}` }),
          isManager() ? button('Refund', () => confirmDialog('Cancel and refund this request?', `${r.contact_name} gets ${r.pay_at_desk ? 'an email that it is canceled' : `${money(r.amount_cents)} back in full`}.`, 'Cancel and refund', async () => { await post(`/skischool/pay/requests/${r.id}/refund`, {}); toast('Canceled'); await load(); }, { danger: true }), { small: true }) : null,
        ] : null) },
      ], requests, { rowClass: (r) => (r.status === 'waiting' && r.deadline_at && minutesLeft(r.deadline_at) < 30 ? 'attention' : null) }) : empty(which.value === 'open' ? 'No private requests are waiting.' : 'No private requests yet.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  async function assignDialog(r) {
    if (!staff) staff = (await get('/skischool/pay/rates').catch(() => null))?.instructors || (await get('/availability/instructors')).data;
    const pick = select([['', 'Choose an instructor'], ...staff.map((s) => [s.id, s.name])], '', { name: 'staff_id', required: true });
    formDialog('Give this private to an instructor', h('div', { class: 'stack' },
      h('p', null, `${fmtRange(r.starts_at, r.ends_at)}, ${r.students.map((s) => s.first_name).join(' and ')}, ${r.level_words}.`),
      field('Instructor', pick, 'They must be free then. The lesson is made and the family is told.')), async (fd) => {
      if (!val(fd, 'staff_id')) throw new Error('Choose an instructor');
      await post(`/skischool/pay/requests/${r.id}/assign`, { staff_id: Number(val(fd, 'staff_id')) });
      toast('Booked'); await load();
    }, { submitText: 'Book it' });
  }
  await load();
}

// ================================================================ My pay
async function pickInstructor(root, onPick) {
  if (!isManager()) return myStaff();
  const { instructors } = await get('/skischool/pay/rates');
  const sel = select([['', 'Choose an instructor'], ...instructors.map((s) => [s.id, s.name])], myStaff() || '', { 'aria-label': 'Instructor' });
  sel.addEventListener('change', () => onPick(sel.value ? Number(sel.value) : null));
  root.append(h('div', { class: 'inline-form' }, field('Instructor', sel)));
  return sel.value ? Number(sel.value) : null;
}

async function myPayTab(root) {
  let week = weekStart(todayStr());
  const body = h('div', { class: 'stack' });
  const head = h('div', { class: 'row between pay-week' });
  let staffId = await pickInstructor(root, (id) => { staffId = id; load(); });
  root.append(head, body);
  async function load() {
    clear(head).append(
      button('Previous week', () => { week = addDays(week, -7); load(); }, { small: true, label: 'Previous week' }),
      h('strong', null, `${fmtDate(week)} to ${fmtDate(addDays(week, 6))}`),
      button('Next week', () => { week = addDays(week, 7); load(); }, { small: true, label: 'Next week' }));
    if (!staffId) { clear(body).append(empty(isManager() ? 'Choose an instructor to see their pay.' : 'Your login is not linked to a staff record yet. Ask a manager to link it.')); return; }
    clear(body).append(loading());
    try {
      const d = await get(`/skischool/pay/mine?from=${week}&to=${addDays(week, 6)}${isManager() ? `&staff_id=${staffId}` : ''}`);
      const pay = d.lines.filter((l) => !l.tip);
      const tips = d.lines.filter((l) => l.tip);
      clear(body).append(
        h('div', { class: 'pay-tiles' },
          tile('This week', money(d.total_cents), hours(d.minutes)),
          tile('Tips this week', money(d.tips_cents), 'Paid to you in full'),
          tile('Season so far', money(d.season.total_cents), `${hours(d.season.minutes)}, tips ${money(d.season.tips_cents)}`)),
        h('p', { class: 'muted small' }, howPaid(d)),
        pay.length ? table([
          { head: 'Day', cell: (l) => (l.kind === 'clock' ? fmtDate(l.day) : `${fmtDate(l.starts_at)}, ${fmtTime(l.starts_at)}`) },
          { head: 'What', cell: (l) => h('span', null, l.title, l.note ? h('div', { class: 'muted small' }, l.note) : null) },
          { head: 'Time', num: true, cell: (l) => (l.minutes ? hours(l.minutes) : '') },
          { head: 'Pay', num: true, cell: (l) => h('span', null, money(l.cents), l.parts.length > 1 ? h('div', { class: 'muted small' }, l.parts.map((p) => `${p.label} ${money(p.cents)}`).join(' + ')) : null, l.paid ? h('div', { class: 'small' }, state('Paid', 'good')) : null) },
          { head: '', actions: true, cell: (l) => button('Ask', () => askDialog(l), { small: true, label: `Ask a question about ${l.title} on ${fmtDate(l.day)}` }) },
        ], pay) : empty('No lessons or meetings this week.'),
        tips.length ? h('section', { class: 'stack' }, h('h2', null, 'Tips'), table([
          { head: 'Lesson', cell: (l) => `${fmtDate(l.starts_at)}, ${l.title.replace(/^Tip, /, '')}` },
          { head: 'Tip', num: true, cell: (l) => h('span', null, money(l.cents), l.note ? h('div', { class: 'muted small' }, l.note) : null) },
        ], tips)) : null);
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}
const tile = (title, big, small) => h('div', { class: 'pay-tile' }, h('span', { class: 'muted small' }, title), h('strong', null, big), h('span', { class: 'muted small' }, small));
function howPaid(d) {
  const mode = { per_lesson: 'Paid per lesson.', hourly: 'Paid by the hour: the time card when you clock in, otherwise the lesson time.', both: 'Paid per lesson, plus by the hour.' }[d.pay_mode] || '';
  return `${mode}${d.lineup_paid ? ' Lineup time is paid once per start time.' : ''} Tips go to you in full and are listed apart.`;
}
function askDialog(l) {
  const line = `${fmtDate(l.day)}: ${l.title}, ${money(l.cents)}${l.words ? ` (${l.words})` : ''}`;
  const msg = h('textarea', { name: 'message', rows: 4, required: true, maxlength: 1000, placeholder: 'For example: I taught two lineups that day' });
  formDialog('Ask about this line', h('div', { class: 'stack' }, h('p', null, line), field('Your question', msg, 'It goes to the ski school director by email, with this line.')), async (fd) => {
    const m = val(fd, 'message');
    if (!m || m.length < 3) throw new Error('Write your question first');
    await post('/skischool/pay/question', { line, message: m });
    toast('Sent to the director');
  }, { submitText: 'Send' });
}

// ================================================================ My guests (rebook)
async function guestsTab(root) {
  const body = h('div', { class: 'stack' });
  let staffId = await pickInstructor(root, (id) => { staffId = id; load(); });
  root.append(h('p', { class: 'muted' }, 'Families you taught a private for, or who asked for you. Offer them another time: they get an email (and a text if they said yes) with a link to book you.'), body);
  let offers = null;
  async function load() {
    if (!staffId) { clear(body).append(empty(isManager() ? 'Choose an instructor.' : 'Your login is not linked to a staff record yet. Ask a manager to link it.')); return; }
    clear(body).append(loading());
    try {
      const { guests } = await get(`/skischool/pay/guests${isManager() ? `?staff_id=${staffId}` : ''}`);
      clear(body).append(guests.length ? table([
        { head: 'Guest', cell: (g) => h('span', null, h('strong', null, `${g.first_name} ${g.last_name}`), g.level_words ? h('div', { class: 'muted small' }, g.level_words) : null) },
        { head: 'Last lesson', cell: (g) => h('span', null, fmtDate(g.last_at), h('div', { class: 'muted small' }, plural(Number(g.lessons), 'lesson'))) },
        { head: 'Next', cell: (g) => (g.next_at ? state(`Booked ${fmtDate(g.next_at)}`, 'good') : h('span', { class: 'muted' }, 'Nothing booked')) },
        { head: '', actions: true, cell: (g) => [
          g.reachable ? button('Offer a time', () => offerDialog(g), { small: true, label: `Offer ${g.first_name} another lesson` }) : h('span', { class: 'muted small' }, 'No email on file'),
          isManager() ? button('Book', () => bookDialog(g), { small: true, label: `Book ${g.first_name} a private` }) : null,
        ] },
      ], guests) : empty('No private guests yet. They show here after their lesson.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  function offerDialog(g) {
    const msg = h('textarea', { name: 'message', rows: 3, maxlength: 500, placeholder: `For example: ${g.first_name} was linking turns by the end. Let us try the blue runs next.` });
    formDialog(`Offer ${g.first_name} another lesson`, h('div', { class: 'stack' }, field('A note from you (optional)', msg, 'Your open dates are on the link. Keep them up to date in Availability.')), async (fd) => {
      await post(`/skischool/pay/guests/${g.person_id}/offer`, { message: val(fd, 'message') || undefined, ...(isManager() ? { staff_id: staffId } : {}) });
      toast('Sent');
    }, { submitText: 'Send' });
  }
  async function bookDialog(g) {
    if (!offers) offers = (await get('/skischool/pay/private-offers')).offers.filter((o) => o.active);
    if (!offers.length) { toast('Add a private lesson length first, in Settings, Ski school, Privates online.', 'error'); return; }
    const when = input({ type: 'datetime-local', name: 'starts_at', required: true, value: `${addDays(todayStr(), 1)}T10:00` });
    const len = select(offers.map((o) => [o.id, `${lengthWords(o.minutes)}, ${o.product}`]), offers[0].id, { name: 'offer_id' });
    const waiver = input({ type: 'checkbox', name: 'sign_waiver' });
    formDialog(`Book ${g.first_name} a private`, h('div', { class: 'form' }, field('Starts', when), field('Length', len),
      h('label', { class: 'check' }, waiver, ' The guest signed a paper waiver for this season'),
      h('p', { class: 'muted small' }, 'Paid at the desk. Safety details and consents carry over from their last lesson.')), async (fd) => {
      await post(`/skischool/pay/guests/${g.person_id}/book`, { staff_id: staffId, offer_id: Number(val(fd, 'offer_id')), starts_at: val(fd, 'starts_at'), sign_waiver: waiver.checked || undefined });
      toast('Booked'); await load();
    }, { submitText: 'Book' });
  }
  await load();
}

// ================================================================ Payroll
async function payrollTab(root) {
  const start = addDays(weekStart(todayStr()), -7);
  const from = input({ type: 'date', value: start, 'aria-label': 'First day' });
  const to = input({ type: 'date', value: addDays(start, 6), 'aria-label': 'Last day' });
  const body = h('div', { class: 'stack' });
  const past = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'Pick a pay period, check each instructor, approve, then export. Exported lines are never paid twice. Tips are listed apart: they pass straight through to the instructor.'),
    h('div', { class: 'inline-form' }, field('From', from), field('To', to), button('Show', () => load(), { kind: 'primary' })), body, past);
  async function load() {
    clear(body).append(loading());
    try {
      const d = await get(`/skischool/pay/payroll?from=${from.value}&to=${to.value}`);
      const all = d.instructors;
      const approved = all.filter((g) => g.approved && !g.changed);
      const total = all.reduce((n, g) => n + g.pay_cents, 0);
      const tipsTotal = all.reduce((n, g) => n + g.tips_cents, 0);
      clear(body).append(
        h('div', { class: 'pay-tiles' }, tile('Pay', money(total), plural(all.length, 'instructor')), tile('Tips to pass through', money(tipsTotal), 'Not part of pay'), tile('Approved', `${approved.length} of ${all.length}`, d.run && d.run.exported_at ? `Exported ${fmtDate(d.run.exported_at)}` : 'Not exported yet')),
        d.earlier ? h('p', { class: 'muted small' }, `${plural(d.earlier, 'line')} in this period were paid in an earlier export and are left out.`) : null,
        all.length ? table([
          { head: 'Instructor', cell: (g) => h('strong', null, g.name) },
          { head: 'Hours', num: true, cell: (g) => hours(g.minutes) },
          { head: 'Pay', num: true, cell: (g) => money(g.pay_cents) },
          { head: 'Tips', num: true, cell: (g) => money(g.tips_cents) },
          { head: 'Approved', cell: (g) => (g.changed ? state('Changed since approved', 'bad') : g.approved ? state('Approved', 'good') : state('Not yet', 'neutral')) },
          { head: '', actions: true, cell: (g) => [
            button('Lines', () => linesDialog(g), { small: true, label: `Lines for ${g.name}` }),
            g.approved && !g.changed ? button('Unapprove', () => approve([g.staff_id], false), { small: true, label: `Unapprove ${g.name}` }) : button('Approve', () => approve([g.staff_id], true), { small: true, kind: 'primary', label: `Approve ${g.name}` }),
          ] },
        ], all) : empty('Nothing to pay in this period.'),
        all.length ? h('div', { class: 'row' },
          button('Approve all', () => approve(all.map((g) => g.staff_id), true)),
          button('Export CSV', () => exportIt(approved), { kind: 'primary' })) : null);
    } catch (err) { clear(body).append(errorBox(err)); }
    await drawPast();
  }
  async function approve(ids, yes) {
    await post('/skischool/pay/payroll/approve', { from: from.value, to: to.value, staff_ids: ids, approved: yes });
    toast(yes ? 'Approved' : 'Approval removed');
    await load();
  }
  function exportIt(approved) {
    if (!approved.length) { toast('Approve at least one instructor first', 'error'); return; }
    confirmDialog('Export this pay period?', `${plural(approved.length, 'instructor')}, ${money(approved.reduce((n, g) => n + g.pay_cents, 0))} in pay and ${money(approved.reduce((n, g) => n + g.tips_cents, 0))} in tips. Their lines are marked paid and their tips paid out.`, 'Export', async () => {
      const r = await post('/skischool/pay/payroll/export', { from: from.value, to: to.value });
      await download(`/skischool/pay/payroll/runs/${r.run_id}/lines.csv`, `payroll-${from.value}-to-${to.value}-lines.csv`);
      await download(`/skischool/pay/payroll/runs/${r.run_id}/summary.csv`, `payroll-${from.value}-to-${to.value}-summary.csv`);
      toast(`Exported ${plural(r.lines, 'line')}`);
      await load();
    });
  }
  function linesDialog(g) {
    dialog(`${g.name}: ${fmtDate(from.value)} to ${fmtDate(to.value)}`, table([
      { head: 'Day', cell: (l) => (l.kind === 'clock' ? fmtDate(l.day) : `${fmtDate(l.starts_at)}, ${fmtTime(l.starts_at)}`) },
      { head: 'What', cell: (l) => h('span', null, l.title, l.note ? h('div', { class: 'muted small' }, l.note) : null) },
      { head: 'Pay', num: true, cell: (l) => h('span', null, money(l.cents), l.parts.length > 1 ? h('div', { class: 'muted small' }, l.parts.map((p) => `${p.label} ${money(p.cents)}`).join(' + ')) : null) },
    ], g.lines), { wide: true });
  }
  async function drawPast() {
    clear(past);
    try {
      const { runs } = await get('/skischool/pay/payroll/runs');
      if (!runs.length) return;
      past.append(h('h2', null, 'Past exports'), table([
        { head: 'Period', cell: (r) => `${fmtDate(r.period_from)} to ${fmtDate(r.period_to)}` },
        { head: 'Instructors', num: true, cell: (r) => String(r.instructors) },
        { head: 'Pay', num: true, cell: (r) => money(r.pay_cents) },
        { head: '', actions: true, cell: (r) => [
          button('Lines CSV', () => download(`/skischool/pay/payroll/runs/${r.id}/lines.csv`, `payroll-${r.period_from}-lines.csv`), { small: true }),
          button('Summary CSV', () => download(`/skischool/pay/payroll/runs/${r.id}/summary.csv`, `payroll-${r.period_from}-summary.csv`), { small: true }),
        ] },
      ], runs));
    } catch (_) { /* the list is a convenience */ }
  }
  await load();
}

// ================================================================ Settings, Ski school
async function paySettings(panel) {
  const s = await get('/skischool/settings');
  const mode = select(MODES, s.pay_mode, { name: 'pay_mode' });
  const lineup = input({ type: 'checkbox', name: 'lineup_paid', checked: Boolean(s.lineup_paid) });
  const lineupMin = input({ type: 'number', name: 'lineup_minutes', min: 0, max: 120, step: 5, value: s.lineup_minutes, inputmode: 'numeric' });
  const bonus = input({ name: 'request_bonus', inputmode: 'decimal', value: centsToInput(s.request_bonus_cents), placeholder: '0.00' });
  const accept = select([[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [1440, '1 day']].map(([v, t]) => [v, t]), s.private_accept_minutes, { name: 'private_accept_minutes' });
  if (![30, 60, 120, 240, 480, 1440].includes(Number(s.private_accept_minutes))) accept.append(h('option', { value: s.private_accept_minutes, selected: true }, `${s.private_accept_minutes} minutes`));
  const decline = select([['offer_other', 'Offer the family another instructor who is free then, or a full refund'], ['refund', 'Refund the family in full straight away']], s.private_decline, { name: 'private_decline' });
  const form = h('form', { class: 'stack', novalidate: true },
    h('section', { class: 'panel stack' }, h('h2', null, 'How instructors are paid'),
      field('Pay', mode, 'Set the amounts in Pay rates. Instructors see their pay under each lesson on My day.'),
      h('label', { class: 'check' }, lineup, ' Pay lineup time before group lessons'),
      field('Lineup minutes', lineupMin, 'Paid at the hourly rate, once per start time. Not added when the instructor is paid from the time card.'),
      field('Request bonus', bonus, 'Added to a lesson when a guest asked for the instructor by name. Leave at 0.00 for none.')),
    h('section', { class: 'panel stack' }, h('h2', null, 'Privates asked for by name'),
      field('Time to answer', accept, 'How long an instructor has to accept a private asked for by name.'),
      field('If the instructor says no or does not answer', decline)),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cents = toCents(bonus.value || '0');
    if (cents === null) { fail(new Error('Write the request bonus as an amount, such as 5.00')); return; }
    try {
      await patch('/skischool/settings', { pay_mode: mode.value, lineup_paid: lineup.checked, lineup_minutes: Number(lineupMin.value) || 0, request_bonus_cents: cents, private_accept_minutes: Number(accept.value), private_decline: decline.value });
      refreshPay();
      toast('Saved');
    } catch (err) { fail(err); }
  });
  panel.append(form);
}

async function ratesPage(panel) {
  const body = h('div', { class: 'stack' });
  panel.append(h('p', { class: 'muted' }, 'What the school pays. The school default applies to everyone; set an instructor\'s own rate only where it differs. Group, semi-private and private are per lesson, hourly is per hour (also used for lineup time), program is per meeting coached.'), body);
  async function load() {
    clear(body).append(loading());
    const d = await get('/skischool/pay/rates');
    const today = d.today;
    const current = (sid, kind) => d.rates.filter((r) => r.staff_id === sid && r.kind === kind && String(r.effective_from).slice(0, 10) <= today).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] || null;
    const upcoming = (sid) => d.rates.filter((r) => r.staff_id === sid && String(r.effective_from).slice(0, 10) > today);
    const rowsOf = [{ id: null, name: 'School default' }, ...d.instructors];
    clear(body).append(table([
      { head: 'Who', cell: (p) => h('span', null, h('strong', null, p.name), upcoming(p.id).length ? h('div', { class: 'muted small' }, upcoming(p.id).map((r) => `${label(r.kind)} ${money(r.cents)} from ${fmtDate(r.effective_from)}`).join(', ')) : null) },
      ...KINDS.map(([k, t]) => ({ head: t, num: true, cell: (p) => { const r = current(p.id, k); if (r) return money(r.cents); return h('span', { class: 'muted' }, p.id === null ? 'Not set' : 'Default'); } })),
      { head: '', actions: true, cell: (p) => button('Edit', () => edit(p, current), { small: true, label: `Edit rates for ${p.name}` }) },
    ], rowsOf));
    function edit(p, cur) {
      const inputs = KINDS.map(([k, t]) => { const r = cur(p.id, k); return [k, t, input({ name: k, inputmode: 'decimal', value: r ? centsToInput(r.cents) : '', placeholder: p.id === null ? 'Not set' : 'Use the default' })]; });
      const fromIn = input({ type: 'date', name: 'from', value: today, required: true });
      formDialog(`Rates: ${p.name}`, h('div', { class: 'form' }, ...inputs.map(([, t, el]) => field(t, el)), field('From', fromIn, 'Lessons on and after this day use these rates. Earlier lessons keep the old ones.'),
        p.id !== null ? h('p', { class: 'muted small' }, 'Leave a box empty to use the school default.') : null), async () => {
        let changed = 0;
        for (const [k, , el] of inputs) {
          const r = cur(p.id, k);
          if (el.value.trim() === '') {
            if (r && p.id !== null) { await del(`/skischool/pay/rates/${r.id}`); changed += 1; }
            continue;
          }
          const c = toCents(el.value);
          if (c === null) throw new Error(`Write the ${label(k)} rate as an amount, such as 36.00`);
          if (r && r.cents === c) continue;
          await post('/skischool/pay/rates', { staff_id: p.id, kind: k, cents: c, effective_from: fromIn.value || today });
          changed += 1;
        }
        refreshPay();
        toast(changed ? 'Rates saved' : 'Nothing changed');
        await load();
      });
    }
  }
  await load();
}

async function offersPage(panel) {
  const body = h('div', { class: 'stack' });
  panel.append(body);
  async function load() {
    clear(body).append(loading());
    const d = await get('/skischool/pay/private-offers');
    const link = `${location.origin}/private/${encodeURIComponent(d.slug)}`;
    clear(body).append(
      h('p', { class: 'muted' }, 'Families ask for a private lesson with an instructor by name on your private lesson page. Only instructors who are listed publicly (in Availability) appear, at the times they marked open. Add the lengths you sell here.'),
      h('p', null, 'Your page: ', h('a', { href: link, target: '_blank', rel: 'noopener' }, link)),
      d.offers.length ? table([
        { head: 'Length', cell: (o) => h('strong', null, lengthWords(o.minutes)) },
        { head: 'Sold as', cell: (o) => h('span', null, o.product, h('div', { class: 'muted small' }, money(o.base_price_cents))) },
        { head: 'Students', cell: (o) => `Up to ${o.max_students}${o.max_students > 1 && o.extra_student_cents ? `, ${money(o.extra_student_cents)} each extra` : ''}` },
        { head: 'Meet at', cell: (o) => o.meeting_place || '' },
        { head: 'On the page', cell: (o) => state(o.active ? 'Shown' : 'Hidden', o.active ? 'good' : 'neutral') },
        { head: '', actions: true, cell: (o) => [button('Edit', () => edit(o), { small: true, label: `Edit the ${lengthWords(o.minutes)} private` }),
          button(o.active ? 'Hide' : 'Show', async () => { await patch(`/skischool/pay/private-offers/${o.id}`, { active: !o.active }); await load(); }, { small: true })] },
      ], d.offers) : empty('No private lessons are offered online yet.'),
      h('div', { class: 'row' }, button('Add a length', () => edit(null), { kind: 'primary' })));
    function edit(o) {
      if (!d.products.length) { toast('Add a lesson product first, in Products and prices.', 'error'); return; }
      const prod = select(d.products.map((p) => [p.id, `${p.name} (${money(p.base_price_cents)})`]), o ? o.product_id : d.products[0].id, { name: 'product_id' });
      const mins = select([[60, '1 hour'], [90, '1 hour 30 min'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours (half day)'], [360, '6 hours (full day)']], o ? o.minutes : 60, { name: 'minutes' });
      const max = select([1, 2, 3, 4, 5, 6].map((x) => [x, String(x)]), o ? o.max_students : 1, { name: 'max_students' });
      const extra = input({ name: 'extra', inputmode: 'decimal', value: o ? centsToInput(o.extra_student_cents) : '', placeholder: '0.00' });
      const place = input({ name: 'meeting_place', maxlength: 120, value: o ? o.meeting_place || '' : '', placeholder: 'For example: the ski school bell' });
      formDialog(o ? 'Edit private lesson length' : 'Add a private lesson length', h('div', { class: 'form' },
        field('Length', mins), field('Sold as', prod, 'The price comes from this lesson product, by guest type and day.'), field('Most students', max),
        field('Price for each extra student', extra, 'Added for each student after the first.'), field('Meeting place', place)), async (fd) => {
        const c = toCents(extra.value || '0');
        if (c === null) throw new Error('Write the extra student price as an amount, such as 40.00');
        const body2 = { product_id: Number(val(fd, 'product_id')), minutes: Number(val(fd, 'minutes')), max_students: Number(val(fd, 'max_students')), extra_student_cents: c, meeting_place: val(fd, 'meeting_place') };
        if (o) await patch(`/skischool/pay/private-offers/${o.id}`, body2); else await post('/skischool/pay/private-offers', body2);
        toast('Saved'); await load();
      });
    }
  }
  await load();
}

