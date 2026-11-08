// The instructor's My day: today's (or tomorrow's) lessons and program meetings in time order, each with its roster and
// what an instructor needs on the hill (age, level, allergy and medical notes on tap, pickup, the parent's phone),
// check-in, attendance in one tap, the report card, and the pay line (school-pay.js). Works where the signal drops:
// the last day loaded is kept on this phone (sealed, see outbox.js) and attendance taps wait and send when back online.
import { get } from '../api.js';
import { h, clear, ctx, schoolCan, state, button, toast, dialog, fmtTime, todayStr, addDays, empty, errorBox, fail, label, field, select } from '../ui.js';
import { send, keepCase, keptCase, onChange, pending, flush } from '../outbox.js';
import { cardDialog } from './school-card.js';
import * as payPart from './school-pay.js';
import * as parentsPart from './school-parents.js';
import { moveDialog } from './school-lineup.js';
import { needsCard } from './school-staff.js';
import { releaseDialog, lostDialog, lostStrip, updateDialog, atDialog, adaptiveDialog } from './school-safety.js'; // feat/school-safety

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
  if (schoolCan('supervisor') && !opts.compact) {
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
  if (!staffId) { body.append(empty('Your login is not linked to a staff record, so there is no day to show. Ask a manager to link it in Settings, Team and logins.')); return; }
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
  const folds = new Map(); // lesson id -> open or not, as the instructor left it
  let lostOpen = new Set(); // bookings reported lost and not found yet
  const lostSlot = h('div');
  top.append(lostSlot);

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    let note = null;
    try {
      data = await get(`/skischool/my-day?date=${date}${schoolCan('supervisor') && staffId !== ctx.me.staff_id ? `&staff_id=${staffId}` : ''}`);
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
    // an open lost child report on this instructor's class stays on top until the child is found
    if (date === today) get(`/skischool/lost?date=${date}`).then((r) => {
      clear(lostSlot); const st = lostStrip(r.data, load); if (st) lostSlot.append(st);
      lostOpen = new Set(r.data.filter((x) => x.status === 'open').map((x) => x.booking_id));
      if (lostOpen.size) draw(note);
    }).catch(() => {});
  }
  /** Keeps the day on the phone after a tap, so a reload with no signal shows it. */
  const keep = () => keepCase(keepId(date, staffId), { data, at: Date.now() });

  function draw(note) {
    clear(body);
    if (note) body.append(note);
    body.append(h('h2', { class: 'myday-day' }, `${dayWords(date, data.today)}${data.staff && schoolCan('supervisor') ? `: ${data.staff.name}` : ''}`));
    if (!data.items.length) { body.append(empty(date === data.today ? 'No lessons or program groups today.' : 'No lessons or program groups on this day.')); return; }
    const lessons = data.items.filter((it) => it.kind === 'lesson');
    for (const it of data.items) body.append(it.kind === 'lesson' ? lessonCard(it, lessons.indexOf(it), lessons) : meetingCard(it));
  }

  /** Release opens 30 minutes before the lesson ends, on its day (the server records it whenever it is asked). */
  const releaseDue = (s) => date === data.today && data.now && data.now >= new Date(Date.parse(`${String(s.ends_at).slice(0, 19).replace(' ', 'T')}Z`) - 30 * 60000).toISOString().slice(0, 19).replace('T', ' ');

  // ---- one lesson
  function lessonCard(s, index, lessons) {
    const list = h('ul', { class: 'myday-roster' });
    const isToday = date === data.today;
    const head = h('header', { class: 'myday-head' },
      h('div', null, h('strong', { class: 'myday-time' }, `${fmtTime(s.starts_at)} to ${fmtTime(s.ends_at)}`), s.delay_minutes ? h('span', null, ' ', state(`Delayed ${s.delay_minutes} min`, 'warn')) : null),
      h('div', { class: 'myday-title' }, s.product, s.format && s.format !== 'group' ? h('span', { class: 'muted' }, ` ${label(s.format)}`) : null),
      h('div', { class: 'muted small' }, [s.level_words, label(s.discipline), s.meeting_place ? `Meet: ${s.meeting_place}` : null].filter(Boolean).join('  ·  ')));
    const count = h('span', { class: 'gf-count' });
    const drawRoster = () => {
      const present = s.students.filter((x) => x.status === 'attended').length;
      const toRelease = s.students.filter((x) => x.needs_release && !x.released && x.status !== 'no_show').length;
      count.textContent = `${s.students.length} student${s.students.length === 1 ? '' : 's'}${present ? `, ${present} here` : ''}${toRelease && releaseDue(s) ? `, ${toRelease} to release` : ''}`;
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
    // A long roster folds (feat/school-safety): open when it is the only lesson or a short one, else as the instructor left it.
    const open = folds.has(s.id) ? folds.get(s.id) : (lessons.length === 1 || s.students.length <= 10 || index === 0);
    const fold = h('details', { class: 'myday-fold group-fold', open }, h('summary', null, h('strong', null, 'Students'), ' ', count), list);
    fold.addEventListener('toggle', () => folds.set(s.id, fold.open));
    const tools = isToday ? h('div', { class: 'row wrap myday-tools' },
      button('We\'re at', () => atDialog(s, () => {}), { small: true, label: `Say where the ${fmtTime(s.starts_at)} class is` }),
      button('Post update', () => updateDialog(s), { small: true, label: `Post an update to the ${fmtTime(s.starts_at)} class's families` }),
      button('Lost child', () => pickLost(s), { small: true, kind: 'danger', label: `Lost child from the ${fmtTime(s.starts_at)} class` })) : null;
    return h('article', { class: 'panel stack myday-card', 'data-lesson': s.id }, head, s.notes ? h('p', { class: 'small' }, s.notes) : null, pay,
      h('div', { class: 'row myday-count' }, allBtn), tools, fold);
  }

  /** "Lost child" on the class: pick the child, then one quick step for the colors. */
  function pickLost(s) {
    const list = s.students.filter((x) => x.status !== 'no_show' && !x.released && !lostOpen.has(x.booking_id));
    const d = dialog('Which child is lost?', h('div', { class: 'at-grid' }, list.map((x) => button(`${x.first_name} ${x.last_name.slice(0, 1)}.`, () => { d.close(); lostDialog(x, () => load()); }))));
  }
  /** The rest of a student's actions, behind one button so a long roster stays short on a phone. */
  function moreFor(s, x) {
    const d = dialog(`${x.first_name} ${x.last_name}`, h('div', { class: 'stack' },
      date === data.today && !x.released && x.status !== 'no_show' && !lostOpen.has(x.booking_id) ? button('Lost child', () => { d.close(); lostDialog(x, () => load()); }, { kind: 'danger' }) : null,
      s.discipline === 'adaptive' ? button('Adaptive notes', () => { d.close(); adaptiveDialog(x.booking_id, x.first_name); }) : null,
      button('Report card', () => { d.close(); cardDialog(x.person_id, { discipline: s.discipline }); }),
      x.status !== 'no_show' ? button('Move group', () => { d.close(); moveDialog(x, () => load()); }) : null));
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
        checkin(x), x.released ? h('div', null, state(`Picked up by ${x.released_to}`, 'good')) : null),
      h('div', { class: 'myday-actions' }, toggles,
        // release at pickup (feat/school-safety): from 30 minutes before the end of today's lesson
        releaseDue(s) && x.needs_release && !x.released && x.status !== 'no_show' ? button('Release', () => releaseDialog(x, async () => { x.released = true; await load(); }), { small: true, kind: 'primary', label: `Release ${x.first_name} to an adult on the list` }) : null,
        lostOpen.has(x.booking_id) ? state('Reported lost', 'bad') : null,
        button('More', () => moreFor(s, x), { small: true, label: `More for ${x.first_name}: lost child, report card, move group` })));
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

