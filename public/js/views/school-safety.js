// Ski school safety (feat/school-safety): pickup with authorized adults, lost child tied to patrol dispatch, class sizes
// by age band, the adaptive intake, live updates from the lesson, and where the groups are. school.js adds the Pickup
// view to Lessons, Today and the Safety and class sizes page to Settings; My day, the board, the roster and Sell use the
// pieces exported here. Pickup lists, adaptive notes and places are only fetched by the people the server lets see them.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, can, schoolCan, state, input, select, field, button, toast, dialog, formDialog, todayStr, fmtTime, empty, errorBox, fail, val } from '../ui.js';
import { shrink } from '../photo.js';
import { row, amount } from './settings-kit.js';

const desk = () => can('counter') || schoolCan('supervisor');
const lead = () => schoolCan('supervisor');
const COLOR_WORDS = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Black', 'White', 'Gray'];
const EQUIPMENT = [['bi_ski', 'Bi-ski'], ['mono_ski', 'Mono-ski'], ['outriggers', 'Outriggers'], ['slider', 'Slider or walker'], ['tethers', 'Tethers'], ['sit_ski', 'Sit-ski'], ['other', 'Other']];
const clock = (dt) => (dt ? fmtTime(dt) : '');

export function tabs() {
  if (!desk()) return [];
  return [['pickup', 'Pickup', (p) => pickupTab(p)]];
}

// ---------------------------------------------------------------- the pickup list editor (booking forms)
/**
 * Rows of adults who may pick a child up: name, relationship, phone and an optional photo, with the parent's consent to
 * keep the photos. Used by the roster, Sell and the family's lesson page. Returns { el, read(), fill(list) }.
 */
export function pickupEditor({ photos = true, title = 'Who may pick up' } = {}) {
  const list = h('div', { class: 'stack tight pk-list' });
  const consent = h('input', { type: 'checkbox', name: 'pickup_photo_consent' });
  const consentRow = h('label', { class: 'check wide', hidden: true }, consent, ' The family agrees we keep these photos to check who picks up. They can remove them any time.');
  const rows = [];
  const addRow = (a = {}) => {
    const name = input({ maxlength: 150, value: a.name || '', 'aria-label': 'Name', placeholder: 'Full name', autocomplete: 'off' });
    const rel = input({ maxlength: 60, value: a.relationship || '', 'aria-label': 'Relationship', placeholder: 'Mom, Grandpa, nanny', autocomplete: 'off' });
    const phone = input({ maxlength: 40, value: a.phone || '', type: 'tel', inputmode: 'tel', 'aria-label': 'Phone', placeholder: 'Phone', autocomplete: 'off' });
    const r = { id: a.id || null, photo: null, has_photo: Boolean(a.has_photo), name, rel, phone };
    const pic = photos ? h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Photo of this adult (optional)', class: 'pk-photo' }) : null;
    const picNote = h('span', { class: 'muted small' }, r.has_photo ? 'Photo on file' : '');
    if (pic) {
      pic.addEventListener('change', async () => {
        try { r.photo = await shrink(pic.files[0]); picNote.textContent = 'New photo added'; consentRow.hidden = false; } catch (err) { picNote.textContent = err.message; }
      });
    }
    const el = h('div', { class: 'pk-row' }, name, rel, phone, pic ? h('label', { class: 'pk-pic' }, 'Photo ', pic, picNote) : null,
      button('Remove', () => { rows.splice(rows.indexOf(r), 1); el.remove(); }, { small: true, label: `Remove ${a.name || 'this adult'}` }));
    r.el = el;
    rows.push(r);
    list.append(el);
  };
  const el = h('fieldset', { class: 'stack tight pickup-editor wide' }, h('legend', null, title),
    h('p', { class: 'muted small' }, 'Children 12 and under are released only to an adult on this list, after staff see their photo ID.'),
    list, h('div', { class: 'row' }, button('Add an adult', () => addRow(), { small: true })), consentRow);
  return {
    el,
    fill(adults = []) { rows.splice(0); clear(list); for (const a of adults) addRow(a); },
    read() {
      const out = rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), name: r.name.value.trim(), relationship: r.rel.value.trim() || null, phone: r.phone.value.trim() || null, ...(r.photo ? { photo: r.photo } : {}) })).filter((a) => a.name);
      return { pickup_adults: out, ...(out.some((a) => a.photo) ? { pickup_photo_consent: consent.checked } : {}) };
    },
    touched: () => rows.length > 0,
  };
}

/** The adaptive intake fields: needs, equipment, extra staff, anything the instructor should know. */
export function adaptiveEditor(cur = null) {
  const c = cur || {};
  const needs = h('textarea', { name: 'adaptive_needs', rows: 2, maxlength: 1000 }, c.needs || '');
  const notes = h('textarea', { name: 'adaptive_notes', rows: 2, maxlength: 1000 }, c.notes || '');
  const extra = input({ type: 'number', min: 0, max: 4, value: c.extra_staff ?? 0, name: 'adaptive_extra' });
  const boxes = EQUIPMENT.map(([k, t]) => [k, h('input', { type: 'checkbox', value: k, checked: (c.equipment || []).includes(k) }), t]);
  const el = h('fieldset', { class: 'stack tight adaptive-editor wide' }, h('legend', null, 'Adaptive intake'),
    h('p', { class: 'muted small' }, 'Only the lesson\'s instructors, the desk and managers see this.'),
    field('Needs', needs, 'For example: low vision, autism, a wheelchair user'),
    h('div', { class: 'row wrap', role: 'group', 'aria-label': 'Equipment' }, h('strong', { class: 'small' }, 'Equipment'), ...boxes.map(([, b, t]) => h('label', { class: 'check' }, b, ` ${t}`))),
    field('Extra staff', extra, 'Staff on top of the adaptive ratio, for example a tether helper'),
    field('Anything the instructor should know', notes));
  return { el, read: () => ({ needs: needs.value.trim() || null, notes: notes.value.trim() || null, extra_staff: Number(extra.value) || 0, equipment: boxes.filter(([, b]) => b.checked).map(([k]) => k) }) };
}

/** Opens the adaptive intake for a booking (seen and changed by the lesson's instructor, the desk and managers). */
export async function adaptiveDialog(bookingId, firstName) {
  let r;
  try { r = await get(`/skischool/bookings/${bookingId}/adaptive`); } catch (err) { fail(err); return; }
  const ed = adaptiveEditor(r.intake);
  formDialog(`Adaptive notes for ${firstName || r.first_name}`, h('div', { class: 'form' }, ed.el), async () => {
    await put(`/skischool/bookings/${bookingId}/adaptive`, ed.read());
    toast('Adaptive notes saved');
  }, { wide: true });
}

// ---------------------------------------------------------------- release at pickup
/**
 * Release a child: pick the adult from the list (with their photo), confirm the photo ID was seen. Someone else needs a
 * manager and a reason. student: { booking_id, first_name, last_name }. done() after.
 */
export async function releaseDialog(student, done) {
  let r;
  try { r = await get(`/skischool/bookings/${student.booking_id}/pickup`); } catch (err) { fail(err); return; }
  if (r.released) { toast(`${r.first_name} was picked up by ${r.released.to} at ${clock(r.released.at)}`); return; }
  const name = `${r.first_name} ${r.last_name}`;
  const pickName = `pick-${student.booking_id}`;
  const choices = r.adults.map((a) => {
    const radio = h('input', { type: 'radio', name: pickName, value: String(a.id) });
    const pic = h('span', { class: 'pk-face', 'aria-hidden': 'true' }, a.name.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase());
    if (a.has_photo) get(`/skischool/pickup-adults/${a.id}/photo`).then((p) => { if (p.photo) clear(pic).append(h('img', { src: p.photo, alt: '' })); }).catch(() => {});
    return h('label', { class: 'pk-choice' }, radio, pic, h('span', null, h('strong', null, a.name), h('span', { class: 'muted small' }, [a.relationship, a.phone].filter(Boolean).join(', '))));
  });
  const otherRadio = h('input', { type: 'radio', name: pickName, value: 'other' });
  const otherName = input({ name: 'other_name', maxlength: 150, placeholder: 'Their full name' });
  const reason = input({ name: 'override_reason', maxlength: 300, placeholder: 'For example: Mom phoned the desk' });
  const otherBox = h('div', { class: 'stack tight', hidden: true }, field('Name', otherName),
    r.may_override ? field('Reason (a manager releases to someone not on the list)', reason) : h('p', { class: 'notice warn small' }, 'Only a manager can release a child to someone not on the list. Call a manager.'));
  const idSeen = h('input', { type: 'checkbox', name: 'id_seen' });
  const sync = () => { otherBox.hidden = !otherRadio.checked; };
  const content = h('div', { class: 'stack' },
    !r.adults.length ? h('p', { class: 'notice warn' }, `No adults are listed for ${r.first_name}. Ask the family, or call a manager.`) : null,
    h('div', { class: 'stack tight', role: 'radiogroup', 'aria-label': 'Who is picking up' }, ...choices, h('label', { class: 'pk-choice' }, otherRadio, h('span', null, h('strong', null, 'Someone not on the list')))),
    otherBox,
    h('label', { class: 'check wide pk-id' }, idSeen, ' I saw their photo ID and it matches'));
  content.addEventListener('change', sync);
  formDialog(`Release ${name}`, content, async () => {
    const chosen = content.querySelector(`input[name="${pickName}"]:checked`);
    if (!chosen) throw new Error('Pick who is picking up');
    if (!idSeen.checked) throw new Error('Check their photo ID first');
    const body = { id_seen: true };
    if (chosen.value === 'other') { body.other_name = otherName.value.trim(); if (reason.value.trim()) body.override_reason = reason.value.trim(); } else body.adult_id = Number(chosen.value);
    const out = await post(`/skischool/bookings/${student.booking_id}/release`, body);
    toast(`${r.first_name} released to ${out.released_to}. The family is told.`);
    if (done) await done();
  }, { submitText: 'Release' });
}

// ---------------------------------------------------------------- lost child
/** One quick step: jacket and helmet color (prefilled when the family gave them), then patrol gets the call. */
export function lostDialog(student, done) {
  const colorList = h('datalist', { id: 'lost-colors' }, COLOR_WORDS.map((c) => h('option', { value: c })));
  const jacket = input({ name: 'jacket_color', maxlength: 40, list: 'lost-colors', value: student.jacket_color || '', placeholder: 'Red' });
  const helmet = input({ name: 'helmet_color', maxlength: 40, list: 'lost-colors', value: student.helmet_color || '', placeholder: 'White' });
  const seen = input({ name: 'last_seen', maxlength: 200, placeholder: 'Optional: where you last saw them' });
  formDialog(`Lost child: ${student.first_name}`, h('div', { class: 'form' },
    h('p', { class: 'wide notice bad' }, 'This opens a patrol call now, with the child\'s first name, age, photo, colors, class and last known place. The director and the desk are told.'),
    colorList, field('Jacket color', jacket), field('Helmet color', helmet), h('div', { class: 'wide' }, field('Last seen', seen))), async () => {
    const out = await post(`/skischool/bookings/${student.booking_id}/lost`, { jacket_color: jacket.value.trim() || null, helmet_color: helmet.value.trim() || null, last_seen: seen.value.trim() || null });
    toast(`Patrol call ${out.call_no} opened for ${student.first_name}`);
    if (done) await done();
  }, { submitText: 'Call patrol' });
}

/** Record who found the child, where and when. */
export function foundDialog(report, done) {
  const now = new Date();
  const at = input({ type: 'time', name: 'found_at', value: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` });
  formDialog(`${report.first_name} found`, h('div', { class: 'form' },
    field('Found by', input({ name: 'found_by', required: true, minlength: 2, maxlength: 150 })), field('Where', input({ name: 'found_where', required: true, minlength: 2, maxlength: 200 })), field('Time', at)), async (fd) => {
    await post(`/skischool/lost/${report.id}/found`, { found_by: val(fd, 'found_by'), found_where: val(fd, 'found_where'), found_at: at.value || undefined });
    toast(`${report.first_name} found. Patrol's call is updated.`);
    if (done) await done();
  }, { submitText: 'Record found' });
}

const CALL_WORDS = { new: 'Patrol has the call', dispatched: 'Patrol is on the way', on_scene: 'Patrol is there', transporting: 'Patrol is moving', closed: 'Call closed', cancelled: 'Call canceled' };
/** The open lost child reports, as a red strip: the call's status, and Found. */
export function lostStrip(list, done) {
  const open = (list || []).filter((x) => x.status === 'open');
  if (!open.length) return null;
  return h('section', { class: 'notice bad stack tight lost-strip', role: 'alert' }, ...open.map((x) => h('div', { class: 'row between wrap' },
    h('div', null, h('strong', null, `Lost child: ${x.first_name}${x.age != null ? `, age ${x.age}` : ''}.`), ` ${[x.jacket_color ? `Jacket ${String(x.jacket_color).toLowerCase()}` : null, x.helmet_color ? `helmet ${String(x.helmet_color).toLowerCase()}` : null].filter(Boolean).join(', ')}${x.jacket_color || x.helmet_color ? '. ' : ''}${x.product} ${clock(x.starts_at)}${x.instructor_first ? ` with ${x.instructor_first}` : ''}.`,
      h('div', { class: 'small' }, `Call ${x.call_no || ''}: ${CALL_WORDS[x.call_status] || 'Patrol has the call'}. Reported ${clock(x.reported_at)}.${x.last_seen ? ` Last known: ${x.last_seen}.` : ''}`)),
    button('Found', () => foundDialog(x, done), { kind: 'primary', small: true, label: `${x.first_name} found` }))));
}

// ---------------------------------------------------------------- live updates and "We're at"
/** Post a photo or one line to the class. Photos go only to families who allowed photos. */
export function updateDialog(lesson, done) {
  const body = h('textarea', { name: 'body', rows: 2, maxlength: 280, placeholder: 'First run on the magic carpet!' });
  const pic = h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Photo of the class' });
  let photo = null;
  const note = h('p', { class: 'muted small' }, 'A photo goes only to families who said yes to photos. Families can turn updates off.');
  pic.addEventListener('change', async () => {
    try {
      const { fit } = await import('../photo.js');
      photo = await fit(pic.files[0], 1600, 'image/jpeg', 1_400_000);
      note.textContent = 'Photo ready. It goes only to families who said yes to photos.';
    } catch (err) { note.textContent = err.message; }
  });
  formDialog(`Update for ${lesson.product} ${fmtTime(lesson.starts_at)}`, h('div', { class: 'form' }, h('div', { class: 'wide' }, field('One line', body)), field('Photo', pic), h('div', { class: 'wide' }, note)), async () => {
    const out = await post(`/skischool/sessions/${lesson.id}/updates`, { ...(body.value.trim() ? { body: body.value.trim() } : {}), ...(photo ? { photo } : {}) });
    toast(`Posted. ${out.sent} famil${out.sent === 1 ? 'y' : 'ies'} told.`);
    if (done) await done();
  }, { submitText: 'Post' });
}

let placesCache = null;
/** "We're at": one tap on a spot the school named. */
export async function atDialog(lesson, done) {
  try { placesCache = placesCache || (await get('/skischool/settings')).group_places; } catch (err) { fail(err); return; }
  const d = dialog(`Where is the ${fmtTime(lesson.starts_at)} class?`, h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'The director and the desk see it on the board for today. Families never see where you are.'),
    h('div', { class: 'at-grid' }, placesCache.map((p) => button(p, async () => {
      try { await post(`/skischool/sessions/${lesson.id}/at`, { place: p }); toast(`We're at ${p}`); d.close(); if (done) await done(p); } catch (err) { fail(err); }
    })))));
}

// ---------------------------------------------------------------- the board: ratios, places, pickup, lost children
/**
 * Adds to the day board: the lost child strip and who still waits for pickup at the top, and on each lesson card the
 * class size by age band (red with the reason when over) and the group's last known place. Desk and managers only.
 */
export async function decorateBoard(top, cards, date, reload) {
  if (!desk()) return;
  let b;
  try { b = await get(`/skischool/safety/board?date=${date}`); } catch (_) { return; }
  const late = b.waiting.filter((w) => w.late);
  const strip = lostStrip(b.lost, reload);
  const wait = b.waiting.length ? h('section', { class: `notice ${late.length ? 'bad' : 'warn'} stack tight pickup-strip` },
    h('strong', null, `Waiting for pickup: ${b.waiting.length}${late.length ? `, ${late.length} past their window` : ''}`),
    h('div', { class: 'row wrap tight pickup-names' }, ...b.waiting.map((w) => state(`${w.first_name} ${w.last_name.slice(0, 1)}. ${w.late ? 'late' : 'waiting'}`, w.late ? 'bad' : 'warn')),
      button('Open Pickup', () => { location.hash = '#/school?tab=day&view=pickup'; }, { small: true }))) : null;
  for (const el of [strip, wait]) if (el) top.prepend(el);
  for (const card of cards) {
    const s = b.sessions[card.dataset.session];
    if (!s) continue;
    const bits = [];
    if (s.limit) bits.push(s.over_ratio ? h('div', { class: 'ratio-line over' }, state('Over ratio', 'bad'), ` ${s.ratio_reason}`) : h('div', { class: 'ratio-line muted small' }, `${s.count} of ${s.limit} (${s.limit_label})`));
    else if (s.over_ratio) bits.push(h('div', { class: 'ratio-line over' }, state('Staff', 'bad'), ` ${s.ratio_reason}`));
    if (s.place) bits.push(h('div', { class: 'place-line small' }, h('strong', null, s.place.place), ` at ${clock(s.place.at)} `, h('span', { class: 'muted' }, s.place.source === 'gate' ? '(lift scan)' : '(instructor)')));
    if (s.waiting) bits.push(h('div', null, state(`${s.waiting} waiting for pickup`, 'warn')));
    if (s.over_ratio) card.classList.add('over-ratio');
    const head = card.querySelector('header');
    if (head) head.after(...bits); else card.prepend(...bits);
  }
}

// ---------------------------------------------------------------- the desk's Pickup view
async function pickupTab(root) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const show = select([['waiting', 'Waiting and late'], ['all', 'Everyone']], 'waiting', { 'aria-label': 'Show' });
  const top = h('div', { class: 'stack tight' });
  const body = h('div', { class: 'stack', 'aria-live': 'polite' });
  root.append(h('p', { class: 'muted' }, 'Children 12 and under are released only to an adult on their pickup list, after you see the adult\'s photo ID. The family is told who picked up and when.'),
    h('div', { class: 'inline-form' }, field('Day', date), field('Show', show)), top, body);
  date.addEventListener('change', load); show.addEventListener('change', load);
  const STATE = { released: ['Picked up', 'good'], late: ['Late', 'bad'], waiting: ['Waiting', 'warn'], in_lesson: ['In the lesson', 'neutral'] };
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const [r, lost] = await Promise.all([get(`/skischool/pickup?date=${date.value}`), get(`/skischool/lost?date=${date.value}`)]);
      clear(top); const strip = lostStrip(lost.data, load); if (strip) top.append(strip);
      clear(body);
      const list = show.value === 'all' ? r.data : r.data.filter((x) => x.state === 'waiting' || x.state === 'late');
      if (!list.length) { body.append(empty(show.value === 'all' ? 'No children to release on this day.' : 'Nobody is waiting. Lessons still running show under Everyone.')); return; }
      const by = new Map();
      for (const x of list) { if (!by.has(x.session_id)) by.set(x.session_id, []); by.get(x.session_id).push(x); }
      for (const items of by.values()) {
        const x0 = items[0];
        const lateN = items.filter((x) => x.state === 'late').length;
        body.append(h('details', { class: 'panel group-fold', open: true },
          h('summary', null, h('strong', null, `${fmtTime(x0.starts_at)} ${x0.product}${x0.instructor_first ? `, ${x0.instructor_first}` : ''}`), h('span', { class: 'muted small' }, ` ${items.length} child${items.length === 1 ? '' : 'ren'}${lateN ? `, ${lateN} late` : ''}`)),
          h('ul', { class: 'plain lu-list' }, items.map((x) => h('li', { class: `lu-row${x.state === 'released' ? ' in' : ''}`, 'data-booking': x.booking_id },
            h('div', { class: 'lu-who' }, h('strong', null, `${x.first_name} ${x.last_name}`),
              h('span', { class: 'muted small' }, [x.age != null ? `age ${x.age}` : null, `ends ${fmtTime(x.ends_at)}`, x.state === 'late' || x.state === 'waiting' ? `pickup by ${fmtTime(x.due_at)}` : null, `${x.adults} adult${x.adults === 1 ? '' : 's'} listed`].filter(Boolean).join(', ')),
              h('span', null, state(...STATE[x.state]), x.released_to ? ` ${x.released_to} at ${fmtTime(x.released_at)}` : '')),
            h('div', { class: 'lu-act' }, x.state !== 'released' ? button('Release', () => releaseDialog(x, load), { kind: 'primary', small: true, label: `Release ${x.first_name}` }) : null,
              x.state !== 'released' ? button('Lost child', () => lostDialog(x, load), { small: true, kind: 'danger', label: `Lost child: ${x.first_name}` }) : null,
              lead() && x.state === 'released' ? button('Undo', () => formDialog(`Undo the release of ${x.first_name}`, h('div', { class: 'form' }, field('Reason', input({ name: 'reason', required: true, minlength: 3, maxlength: 300 }))), async (fd) => { await del(`/skischool/bookings/${x.booking_id}/release`, { reason: val(fd, 'reason') }); toast('Release undone'); await load(); }), { small: true }) : null))))));
      }
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
  const poll = setInterval(() => { if (!root.isConnected) { clearInterval(poll); return; } if (document.visibilityState !== 'hidden') load(); }, 30000);
}

// ---------------------------------------------------------------- settings
function bandRows(list, keys) {
  const wrap = h('div', { class: 'stack tight band-rows' });
  const rows = [];
  const add = (b = {}) => {
    const r = { label: input({ maxlength: 40, value: b.label || '', 'aria-label': 'Name' }), min: input({ type: 'number', min: 0, max: 99, value: b.age_min ?? '', 'aria-label': 'From age' }),
      max: input({ type: 'number', min: 0, max: 99, value: b.age_max ?? '', 'aria-label': 'To age', placeholder: 'and up' }), n: input({ type: 'number', min: keys.n === 'minutes' ? 0 : 1, max: keys.n === 'minutes' ? 120 : 30, value: b[keys.n] ?? '', 'aria-label': keys.label }) };
    r.el = h('div', { class: 'band-row' }, r.label, h('span', { class: 'small' }, 'ages'), r.min, h('span', { class: 'small' }, 'to'), r.max, r.n, h('span', { class: 'small' }, keys.unit), button('Remove', () => { rows.splice(rows.indexOf(r), 1); r.el.remove(); }, { small: true }));
    rows.push(r); wrap.append(r.el);
  };
  for (const b of list) add(b);
  const num = (el) => (el.value === '' ? null : Number(el.value));
  return { el: h('div', { class: 'stack tight' }, wrap, button(keys.addText, () => add(), { small: true })),
    read: () => rows.map((r) => ({ label: r.label.value.trim() || 'Band', age_min: num(r.min), age_max: num(r.max), [keys.n]: Number(r.n.value) || 0 })) };
}

export const settingsPages = {
  safety: { title: 'Safety and class sizes', who: 'manager', render: async (panel) => {
    const s = await get('/skischool/settings');
    const bands = bandRows(s.ratio_bands, { n: 'size', unit: 'a class', label: 'Students per instructor', addText: 'Add an age band' });
    const windows = bandRows(s.pickup_windows, { n: 'minutes', unit: 'minutes', label: 'Minutes after the lesson', addText: 'Add a pickup window' });
    const adaptive = input({ type: 'number', min: 1, max: 6, value: s.ratio_adaptive, name: 'ratio_adaptive' });
    const places = h('textarea', { rows: 4, maxlength: 2000, name: 'group_places' }, (s.group_places || []).join('\n'));
    const save = button('Save', async () => {
      const body = { ratio_bands: bands.read(), pickup_windows: windows.read(), ratio_adaptive: Number(adaptive.value) || 1, group_places: places.value.split('\n').map((x) => x.trim()).filter(Boolean) };
      if (!body.ratio_bands.length) throw new Error('Keep at least one age band');
      await patch('/skischool/settings', body);
      toast('Saved');
    }, { kind: 'primary' });
    panel.append(h('p', { class: 'set-card-intro' }, 'Class sizes by age, pickup windows and the spots instructors tap for "We\'re at".'),
      row('Class size by age band', bands.el, 'The youngest student in a class sets its size. The lineup split, desk booking and online booking keep to these, and the board shows a class over its size in red.', { wide: true }),
      row('Adaptive ratio', amount(adaptive, 'students per instructor'), 'Extra staff from each adaptive intake add to the staff a lesson needs.'),
      row('Pickup windows', windows.el, 'Minutes after the lesson ends for each age. After that, a child not picked up shows as late on the board and in Pickup.', { wide: true }),
      row('Spots for "We\'re at"', places, 'One per line, for example Magic carpet. Kept for the day only; families never see them.'),
      h('div', { class: 'row' }, save));
  } },
};

/** Who may pick up and released-to, for a roster row (the desk, managers and the lesson's instructor). */
export function releaseLine(x) {
  if (x.released_to) return h('div', { class: 'small' }, state(`Picked up by ${x.released_to}`, 'good'), x.released_at ? ` at ${fmtTime(x.released_at)}` : '');
  if (x.pickup_waiting) return h('div', null, state(x.pickup_late ? 'Late for pickup' : 'Waiting for pickup', x.pickup_late ? 'bad' : 'warn'));
  return null;
}

