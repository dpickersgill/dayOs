// The instructor's My day: today's (or tomorrow's) lessons and program meetings in time order, each with its roster and
// what an instructor needs on the hill (age, level, allergy and medical notes on tap, pickup, the parent's phone),
// check-in, attendance in one tap, the report card, and the pay line (school-pay.js). Works where the signal drops:
// the last day loaded is kept on this phone (sealed, see outbox.js) and attendance taps wait and send when back online.
import { get } from '../api.js';
import { h, clear, ctx, isManager, state, button, toast, dialog, fmtTime, todayStr, addDays, empty, errorBox, fail, label, field, select } from '../ui.js';
import { send, keepCase, keptCase, onChange, pending, flush } from '../outbox.js';
import { cardDialog } from './school-card.js';
import * as payPart from './school-pay.js';
import * as parentsPart from './school-parents.js';
import { moveDialog } from './school-lineup.js';
import { needsCard } from './school-staff.js';

const OUTBOX = 0; // attendance taps queue under this "case" in the phone's outbox
const keepId = (date, staffId) => -Number(`${String(staffId || 0).slice(-4)}${date.replace(/-/g, '')}`); // a negative id: never a patrol case
const savedAt = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dayWords = (date, today) => (date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }));
const initials = (s) => `${(s.first_name || '?')[0]}${(s.last_name || '')[0] || ''}`.toUpperCase();

/** My day for the signed-in instructor (or, for a manager, the instructor picked). opts.compact: the version on My shifts. */
export async function render(root, opts = {}) {
  const top = h('div', { class: 'stack' });
  const bar = h('div', { class: 'myday-bar row' });
  const body = h('div', { class: 'stack myday', 'aria-live': 'polite' });
  root.append(top, bar, body);
  let staffId = ctx.me.staff_id || null;
  if (isManager() && !opts.compact) {
    try {
      const { data } = await get('/skischool/instructors');
      const teach = data.filter((x) => x.teaches);
      if (teach.length) {
        const sel = select(teach.map((x) => [x.id, x.name]), staffId && teach.some((x) => x.id === staffId) ? staffId : teach[0].id, { 'aria-label': 'Whose day' });
        staffId = Number(sel.value);
        sel.addEventListener('change', () => { staffId = Number(sel.value); load(); });
        top.append(field('Whose day', sel));
      }
    } catch (_) { /* their own day */ }
  }
  if (!staffId) { body.append(empty('Your login is not linked to a staff record, so there is no day to show. Ask a manager to link it in Account.')); return; }
  try { await payPart.myDayTop(top); } catch (_) { /* nothing waiting */ }
  if (typeof parentsPart.recapCount === 'function') {
    try { const n = await parentsPart.recapCount(); if (n) top.append(h('p', null, h('a', { href: '#/school?tab=team&view=recaps', class: 'btn' }, `Recaps to send (${n})`))); } catch (_) { /* none */ }
  }
  try { await needsCard(top); } catch (_) { /* the staffing target is a nice to have (Track STAFF) */ }
  const today = todayStr();
  let date = today;
  const pick = h('input', { type: 'date', value: date, 'aria-label': 'Day' });
  pick.addEventListener('change', () => { date = pick.value || today; load(); });
  const dayBtn = (text, d) => button(text, () => { date = d; pick.value = d; return load(); }, { small: true });
  bar.append(dayBtn('Today', today), dayBtn('Tomorrow', addDays(today, 1)), pick);
  const waiting = h('span', { class: 'muted small', role: 'status' });
  bar.append(waiting);
  const showWaiting = () => { const n = pending(OUTBOX).length; waiting.textContent = n ? `${n} change${n === 1 ? '' : 's'} waiting for signal` : ''; };
  const off = onChange(showWaiting);
  let data = null;

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    let note = null;
    try {
      data = await get(`/skischool/my-day?date=${date}${isManager() && staffId !== ctx.me.staff_id ? `&staff_id=${staffId}` : ''}`);
      keepCase(keepId(date, staffId), { data, at: Date.now() });
      flush();
    } catch (err) {
      const kept = keptCase(keepId(date, staffId));
      if (!kept || !kept.data || !kept.data.data) { clear(body).append(errorBox(err)); return; }
      data = kept.data.data;
      note = h('div', { class: 'notice warn', role: 'status' }, `Saved at ${savedAt(kept.data.at)}, no signal. Attendance you mark is sent when the signal is back.`);
    }
    draw(note);
    showWaiting();
  }
  /** Keeps the day on the phone after a tap, so a reload with no signal shows it. */
  const keep = () => keepCase(keepId(date, staffId), { data, at: Date.now() });

  function draw(note) {
    clear(body);
    if (note) body.append(note);
    body.append(h('h2', { class: 'myday-day' }, `${dayWords(date, data.today)}${data.staff && isManager() ? `: ${data.staff.name}` : ''}`));
    if (!data.items.length) { body.append(empty(date === data.today ? 'No lessons or program groups today.' : 'No lessons or program groups on this day.')); return; }
    for (const it of data.items) body.append(it.kind === 'lesson' ? lessonCard(it) : meetingCard(it));
  }

  // ---- one lesson
  function lessonCard(s) {
    const list = h('ul', { class: 'myday-roster' });
    const head = h('header', { class: 'myday-head' },
      h('div', null, h('strong', { class: 'myday-time' }, `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}`), s.delay_minutes ? h('span', null, ' ', state(`Delayed ${s.delay_minutes} min`, 'warn')) : null),
      h('div', { class: 'myday-title' }, s.product, s.format && s.format !== 'group' ? h('span', { class: 'muted' }, ` ${label(s.format)}`) : null),
      h('div', { class: 'muted small' }, [s.level_words, label(s.discipline), s.meeting_place ? `Meet: ${s.meeting_place}` : null].filter(Boolean).join('  ·  ')));
    const count = h('p', { class: 'muted small' });
    const drawRoster = () => {
      const present = s.students.filter((x) => x.status === 'attended').length;
      count.textContent = `${s.students.length} student${s.students.length === 1 ? '' : 's'}${present ? `, ${present} here` : ''}`;
      clear(list); for (const x of s.students) list.append(studentRow(s, x, () => drawRoster()));
    };
    drawRoster();
    const allBtn = s.students.some((x) => x.status === 'booked') ? button('All present', async () => {
      const out = await send('POST', `/skischool/sessions/${s.id}/all-present`, {}, { caseId: OUTBOX, label: `All present, ${s.product}` });
      for (const x of s.students) if (x.status === 'booked') x.status = 'attended';
      keep(); drawRoster(); allBtn.remove();
      toast(out && out.queued ? 'Saved on this phone. It is sent when the signal is back.' : 'Everyone marked present');
    }, { kind: 'primary' }) : null;
    const pay = safePayLine(s);
    return h('article', { class: 'panel stack myday-card', 'data-lesson': s.id }, head, s.notes ? h('p', { class: 'small' }, s.notes) : null, pay,
      h('div', { class: 'row myday-count' }, count, allBtn), list);
  }

  function studentRow(s, x, redraw) {
    const mark = async (status) => {
      const before = x.status;
      x.status = status; keep(); redraw();
      try {
        const out = await send('PATCH', `/skischool/bookings/${x.booking_id}`, { status }, { caseId: OUTBOX, label: `${x.first_name}: ${label(status)}` });
        if (out && out.queued) toast('Saved on this phone. It is sent when the signal is back.');
      } catch (err) { x.status = before; keep(); redraw(); fail(err); }
    };
    const here = x.status === 'attended'; const gone = x.status === 'no_show';
    const toggles = h('div', { class: 'myday-marks', role: 'group', 'aria-label': `Attendance for ${x.first_name}` },
      h('button', { type: 'button', class: `btn small${here ? ' primary' : ''}`, 'aria-pressed': String(here), onclick: () => mark(here ? 'booked' : 'attended') }, here ? 'Present (undo)' : 'Present'),
      h('button', { type: 'button', class: `btn small${gone ? ' danger' : ''}`, 'aria-pressed': String(gone), onclick: () => mark(gone ? 'booked' : 'no_show') }, gone ? 'No-show (undo)' : 'No-show'));
    return h('li', { class: 'myday-student', 'data-booking': x.booking_id }, face(x),
      h('div', { class: 'myday-who' },
        h('div', null, h('strong', null, `${x.first_name} ${x.last_name}`), x.age !== null && x.age !== undefined ? h('span', { class: 'muted' }, `  age ${x.age}`) : null),
        h('div', { class: 'muted small' }, x.level_words || 'No level yet'),
        flags(x),
        x.pickup ? h('div', { class: 'small' }, `Pickup: ${x.pickup}`) : null,
        x.phone ? h('div', { class: 'small' }, h('a', { href: `tel:${String(x.phone).replace(/[^\d+]/g, '')}` }, `Call ${x.contact_name ? `${x.contact_name} ` : ''}${x.phone}`)) : null,
        checkin(x)),
      h('div', { class: 'myday-actions' }, toggles, button('Report card', () => cardDialog(x.person_id, { discipline: s.discipline }), { small: true, label: `Report card for ${x.first_name}` }),
        x.status !== 'no_show' ? button('Move group', () => moveDialog(x, () => load()), { small: true, label: `Move ${x.first_name} to another group` }) : null));
  }

  // ---- one program meeting
  function meetingCard(m) {
    const list = h('ul', { class: 'myday-roster' });
    const drawRoster = () => { clear(list); for (const x of m.students) list.append(meetingRow(m, x, drawRoster)); };
    drawRoster();
    const all = m.students.some((x) => x.present !== true) ? button('All present', async () => {
      const marks = m.students.map((x) => ({ person_id: x.person_id, present: true }));
      if (!marks.length) return;
      const out = await send('PUT', `/programs/sessions/${m.id}/attendance`, { marks }, { caseId: OUTBOX, label: `All present, ${m.product}` });
      for (const x of m.students) x.present = true;
      keep(); drawRoster(); all.remove();
      toast(out && out.queued ? 'Saved on this phone. It is sent when the signal is back.' : 'Everyone marked present');
    }, { kind: 'primary' }) : null;
    return h('article', { class: 'panel stack myday-card program', 'data-meeting': m.id },
      h('header', { class: 'myday-head' }, h('div', null, h('strong', { class: 'myday-time' }, `${fmtTime(m.starts_at)} to ${fmtTime(m.ends_at)}`), ' ', state('Program', 'neutral')),
        h('div', { class: 'myday-title' }, m.product), m.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${m.meeting_place}`) : null),
      h('p', { class: 'muted small' }, `${m.students.length} student${m.students.length === 1 ? '' : 's'}`), list, h('div', { class: 'row' }, all), safePayLine(m));
  }
  function meetingRow(m, x, redraw) {
    const set = async (present) => {
      const before = x.present;
      x.present = present; keep(); redraw();
      try {
        const out = await send('PUT', `/programs/sessions/${m.id}/attendance`, { marks: [{ person_id: x.person_id, present }] }, { caseId: OUTBOX, label: `${x.first_name}: ${present ? 'present' : 'absent'}` });
        if (out && out.queued) toast('Saved on this phone. It is sent when the signal is back.');
      } catch (err) { x.present = before; keep(); redraw(); fail(err); }
    };
    const here = x.present === true; const away = x.present === false;
    return h('li', { class: 'myday-student' }, face(x),
      h('div', { class: 'myday-who' }, h('div', null, h('strong', null, `${x.first_name} ${x.last_name}`), x.age != null ? h('span', { class: 'muted' }, `  age ${x.age}`) : null),
        h('div', { class: 'muted small' }, x.level_words || 'No level yet'), flags(x),
        x.pickup ? h('div', { class: 'small' }, `Pickup: ${x.pickup}`) : null,
        x.phone ? h('div', { class: 'small' }, h('a', { href: `tel:${String(x.phone).replace(/[^\d+]/g, '')}` }, `Call ${x.contact_name ? `${x.contact_name} ` : ''}${x.phone}`)) : null),
      h('div', { class: 'myday-actions' }, h('div', { class: 'myday-marks', role: 'group', 'aria-label': `Attendance for ${x.first_name}` },
        h('button', { type: 'button', class: `btn small${here ? ' primary' : ''}`, 'aria-pressed': String(here), onclick: () => set(true) }, 'Present'),
        h('button', { type: 'button', class: `btn small${away ? ' danger' : ''}`, 'aria-pressed': String(away), onclick: () => set(false) }, 'Absent')),
      button('Report card', () => cardDialog(x.person_id), { small: true, label: `Report card for ${x.first_name}` })));
  }

  await load();
  return { reload: load, stop: off };
}

function safePayLine(item) {
  try { const line = payPart.payLine(item); return line ? h('div', { class: 'myday-pay' }, line) : null; } catch (_) { return null; }
}

/** The student's photo (when on file and there is signal), else their initials. */
function face(x) {
  const box = h('span', { class: 'myday-face', 'aria-hidden': 'true' }, initials(x));
  if (x.has_photo && navigator.onLine !== false) {
    get(`/people/${x.person_id}/photo`).then((r) => { if (r && r.photo) clear(box).append(h('img', { src: r.photo, alt: '' })); }).catch(() => { /* initials stay */ });
  }
  return box;
}

/** Allergy and medical flags: one tap shows the words. */
export function flags(x) {
  if (!x.allergies && !x.medical && !x.has_allergies && !x.has_medical) return null;
  const show = () => dialog(`${x.first_name} ${x.last_name}`, h('div', { class: 'stack' },
    x.allergies ? h('div', null, h('strong', null, 'Allergies'), h('p', null, x.allergies)) : null,
    x.medical ? h('div', null, h('strong', null, 'Medical'), h('p', null, x.medical)) : null,
    !x.allergies && !x.medical ? h('p', { class: 'muted' }, 'Only the lesson\'s instructor, the desk and managers can read these.') : null));
  return h('div', { class: 'row tight myday-flags' },
    x.allergies || x.has_allergies ? h('button', { type: 'button', class: 'flag allergy', onclick: show, 'aria-label': `Allergy for ${x.first_name}: show` }, h('span', { 'aria-hidden': 'true' }, '!'), ' Allergy') : null,
    x.medical || x.has_medical ? h('button', { type: 'button', class: 'flag medical', onclick: show, 'aria-label': `Medical note for ${x.first_name}: show` }, h('span', { 'aria-hidden': 'true' }, '+'), ' Medical') : null);
}

function checkin(x) {
  if (x.status === 'no_show') return h('div', null, state('No-show', 'bad'));
  if (x.checked_in_at) return h('div', null, state(`Checked in${x.checked_in_via === 'link' ? ' by the family' : x.checked_in_via === 'desk' ? ' at the desk' : ''}`, 'good'));
  return h('div', null, state('Not checked in yet', 'neutral'));
}

