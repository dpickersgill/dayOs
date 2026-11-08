// Ski school money and people (feat/school-pay). school.js adds these tabs to Lessons and these pages to Settings, Ski school.
//   Training (Instructors):        the director logs training sessions, who came and for how long; paid at the hourly rate
//   Feedback (Instructors):        each instructor's "would you recommend" score (NPS style) and the families' comments
//   Group programs (Bookings):     a school or club's weekly program: the private booking link, roster, waivers, chaperones,
//                                  drop-off and pickup
//   Owner reports (Planning):      owners and managers: revenue per instructor hour, cost against revenue, instructor
//                                  return rate, first-timer conversion; a CSV for each
// Settings, Ski school: Pay ladder (rates by certification level, credential add-ons), Learn to ski ladder.
// Also used by school.js and school-lineup.js: takePayment, setupWarning, npsChip, loadNps, waiverSigner, ladderNote.
import { get, post, patch, put, del, download } from '../api.js';
import { h, clear, ctx, can, schoolCan, isManager, table, state, input, select, field, button, toast, formDialog, dialog, val, money, toCents, centsToInput,
  todayStr, addDays, fmtDate, fmtTime, fmtDateTime, label, empty, errorBox, loading, confirmDialog, fail, appendAll, closeAllDialogs, seasonFor } from '../ui.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hoursOf = (min) => `${Math.round((Number(min || 0) / 60) * 100) / 100} h`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

export function tabs() {
  const out = [];
  if (can('counter') || schoolCan('supervisor')) out.push(['groups', 'Group programs', (panel) => groupsTab(panel)]);
  if (schoolCan('director')) out.push(['training', 'Training', (panel) => trainingTab(panel)], ['feedback', 'Feedback', (panel) => feedbackTab(panel)]);
  if (isManager()) out.push(['owner', 'Owner reports', (panel) => ownerTab(panel)]);
  return out;
}
export const settingsPages = {
  'pay-ladder': { title: 'Pay ladder', render: (panel) => ladderSettings(panel) },
  'learn-ladder': { title: 'Learn to ski ladder', render: (panel) => learnSettings(panel) },
};

// ================================================================ small pieces for other screens
/** "Take payment" for an unpaid booking: opens Sell with the lesson in the basket for this student. */
export function takePayment(x) {
  if (!(can('counter') || isManager()) || !x || !x.booking_id) return null;
  return button('Take payment', async () => { await closeAllDialogs(); location.hash = `#/sell?pay=${x.booking_id}`; }, { small: true, label: `Take payment for ${x.first_name || 'this student'}` });
}

/** A learn to ski ladder lesson: what it includes, for the desk to hand out. */
export function ladderNote(x) {
  if (!x || !x.ladder) return null;
  return h('div', { class: 'small' }, state(`Learn to ski: ${x.ladder.name}`, 'neutral'), x.ladder.includes ? ` Includes ${x.ladder.includes}.` : '');
}

/**
 * Who signed the waiver at the desk, as Sell records it: for a student under 18, the parent or guardian's name (filled
 * from a guardian on file). capture: the customer form; box: the "signed at the desk" checkbox.
 */
export function waiverSigner(capture, box) {
  const name = input({ name: 'waiver_signer', maxlength: 160, autocomplete: 'off', placeholder: 'Full name of the parent or guardian' });
  const el = h('div', { class: 'guardian-row', hidden: true }, field('Parent or guardian who signed', name, 'A student under 18 cannot sign. The name is kept with the waiver.'));
  let onFile = null;
  const sync = () => { el.hidden = !(box.checked && capture.isMinor()); };
  box.addEventListener('change', sync);
  capture.el.addEventListener('input', sync); capture.el.addEventListener('change', sync);
  return {
    el,
    guardian(g) { onFile = g || null; if (onFile && !name.value) name.value = onFile.name; sync(); },
    read() {
      sync();
      if (el.hidden || !name.value.trim()) return {};
      return { waiver_signer: { name: name.value.trim(), ...(onFile && onFile.name === name.value.trim() ? { person_id: onFile.id } : {}) } };
    },
    reset() { name.value = ''; onFile = null; el.hidden = true; },
  };
}

let npsCache = null;
/** Directors: each instructor's satisfaction score this season, by staff id (a Map), or null for everyone else. */
export async function loadNps() {
  if (!schoolCan('director')) return null;
  if (npsCache && npsCache.at > Date.now() - 60_000) return npsCache.map;
  try {
    const { data } = await get('/skischool/ratings/summary');
    npsCache = { at: Date.now(), map: new Map(data.map((r) => [r.staff_id, r])) };
    return npsCache.map;
  } catch (_) { return null; }
}
const npsWords = (r) => (r.nps === null ? 'No answers yet' : `${r.nps > 0 ? '+' : ''}${r.nps}`);
export function npsChip(map, staffId) {
  const r = map && map.get(Number(staffId));
  if (!r || !r.count) return null;
  return h('span', { class: 'nps-chip', title: `Would recommend: ${r.promoters} of ${r.count} said 9 or 10, ${r.detractors} said 6 or less` }, ' ', state(`Score ${npsWords(r)} (${r.count})`, r.nps >= 50 ? 'good' : r.nps < 0 ? 'bad' : 'neutral'));
}

/** Directors: a warning listing instructors with no pay rate yet, with a link to set them. Null when all are set. */
export async function setupWarning() {
  if (!schoolCan('director')) return null;
  let d;
  try { d = await get('/skischool/pay/setup-check'); } catch (_) { return null; }
  if (!d.missing.length) return null;
  return h('div', { class: 'notice warn stack tight pay-setup', role: 'status' },
    h('strong', null, `Pay rates are not set for ${plural(d.missing.length, 'instructor')}`),
    h('p', { class: 'small' }, 'They see 0.00 for these lessons until a rate is set, by their certification level on the pay ladder, the school default or their own rate.'),
    h('ul', { class: 'plain small' }, d.missing.slice(0, 12).map((m) => h('li', null, h('strong', null, m.name), `: no ${m.kinds.map((k) => k.words).join(', ')} rate`))),
    d.missing.length > 12 ? h('p', { class: 'small muted' }, `And ${d.missing.length - 12} more.`) : null,
    h('p', null, h('a', { href: '#/settings/school', class: 'btn small' }, 'Set pay rates')));
}

// ================================================================ Training
async function trainingTab(root) {
  const body = h('div', { class: 'stack' });
  let staff = null;
  root.append(h('div', { class: 'row between' }, h('p', { class: 'muted' }, 'Clinics and on-snow training. Each instructor who came is paid for the time at their hourly rate, on My pay and in payroll.'),
    button('Log training', () => edit(null), { kind: 'primary' })), body);
  async function load() {
    clear(body).append(loading());
    try {
      const { data } = await get('/skischool/training');
      clear(body).append(data.length ? table([
        { head: 'When', cell: (x) => h('span', null, `${fmtDate(x.starts_at)}, ${fmtTime(x.starts_at)} to ${fmtTime(x.ends_at)}`, h('div', { class: 'muted small' }, hoursOf(x.minutes))) },
        { head: 'Training', cell: (x) => h('span', null, h('strong', null, x.title), x.status === 'cancelled' ? h('span', null, ' ', state('Removed', 'neutral')) : null, x.notes ? h('div', { class: 'muted small' }, x.notes) : null) },
        { head: 'Who came', cell: (x) => h('span', null, x.attendees.map((a) => `${a.name}${a.minutes ? ` (${hoursOf(a.minutes)})` : ''}`).join(', '), x.attendees.some((a) => a.paid) ? h('div', null, state('Paid in payroll', 'good')) : null) },
        { head: '', actions: true, cell: (x) => (x.status === 'held' && !x.attendees.some((a) => a.paid) ? [
          button('Edit', () => edit(x), { small: true, label: `Edit ${x.title}` }),
          button('Remove', () => confirmDialog('Remove this training?', `${x.title}, ${fmtDate(x.starts_at)}. Nobody is paid for it.`, 'Remove', async () => { await del(`/skischool/training/${x.id}`); toast('Removed'); await load(); }, { danger: true }), { small: true }),
        ] : null) },
      ], data) : empty('No training logged yet.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  async function edit(x) {
    if (!staff) staff = (await get('/skischool/instructors')).data.filter((s) => s.teaches);
    const day = input({ type: 'date', name: 'day', required: true, value: x ? String(x.starts_at).slice(0, 10) : todayStr() });
    const from = input({ type: 'time', name: 'from', required: true, value: x ? String(x.starts_at).slice(11, 16) : '08:00' });
    const to = input({ type: 'time', name: 'to', required: true, value: x ? String(x.ends_at).slice(11, 16) : '09:30' });
    const came = new Set(x ? x.attendees.map((a) => a.staff_id) : []);
    const boxes = staff.map((s) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `s_${s.id}`, checked: came.has(s.id) }), ` ${s.name}`));
    formDialog(x ? 'Edit training' : 'Log training', h('div', { class: 'form' },
      h('div', { class: 'wide' }, field('What', input({ name: 'title', required: true, maxlength: 160, value: x ? x.title : '', placeholder: 'For example: Kids lineup clinic' }))),
      field('Day', day), field('From', from), field('To', to),
      h('fieldset', { class: 'wide stack' }, h('legend', null, 'Who came'), h('div', { class: 'row wrap' }, ...boxes)),
      h('div', { class: 'wide' }, field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 1000 }, x && x.notes ? x.notes : '')))), async (fd) => {
      const attendees = staff.filter((s) => fd.get(`s_${s.id}`)).map((s) => ({ staff_id: s.id }));
      if (!attendees.length) throw new Error('Tick who came');
      const body2 = { title: val(fd, 'title'), starts_at: `${val(fd, 'day')}T${val(fd, 'from')}`, ends_at: `${val(fd, 'day')}T${val(fd, 'to')}`, notes: val(fd, 'notes'), attendees };
      if (x) await put(`/skischool/training/${x.id}`, body2); else await post('/skischool/training', body2);
      toast(x ? 'Training saved' : 'Training logged');
      await load();
    }, { wide: true, submitText: x ? 'Save' : 'Log training' });
  }
  await load();
}

// ================================================================ Feedback
async function feedbackTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('p', { class: 'muted' }, 'After each lesson the family page asks: How likely are you to recommend your instructor? (0 to 10). The score is the share who said 9 or 10, less the share who said 6 or less, from -100 to 100. Instructors see only their own number.'), body);
  try {
    const { data } = await get('/skischool/ratings/summary');
    clear(body).append(data.length ? table([
      { head: 'Instructor', cell: (r) => h('strong', null, r.name) },
      { head: 'Score', num: true, cell: (r) => npsWords(r) },
      { head: 'Answers', num: true, cell: (r) => String(r.count) },
      { head: '9 or 10', num: true, cell: (r) => String(r.promoters) },
      { head: '7 or 8', num: true, cell: (r) => String(r.passives) },
      { head: '6 or less', num: true, cell: (r) => String(r.detractors) },
      { head: '', actions: true, cell: (r) => (Number(r.staff_id) === Number(ctx.me && ctx.me.staff_id) && !isManager() ? null : button('Comments', () => comments(r), { small: true, label: `Comments about ${r.name}` })) },
    ], data) : empty('No answers yet this season.'));
  } catch (err) { clear(body).append(errorBox(err)); }
  async function comments(r) {
    try {
      const { data } = await get(`/skischool/ratings?staff_id=${r.staff_id}`);
      dialog(`Comments about ${r.name}`, data.length ? h('ul', { class: 'plain stack' }, data.map((c) => h('li', { class: 'panel' }, h('div', { class: 'row between' }, h('strong', null, `${c.score} of 10`), h('span', { class: 'muted small' }, `${c.product}, ${fmtDate(c.starts_at)}`)), h('p', null, c.comment)))) : empty('No comments yet.'), { wide: true });
    } catch (err) { fail(err); }
  }
}

// ================================================================ Group programs
async function groupsTab(root) {
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'row between' }, h('p', { class: 'muted' }, 'A school or club books a weekly program. Send the group leader their private link: they fill the roster and the chaperone plan before the deadline, and each parent signs a waiver by link.'),
    schoolCan('director') ? button('Add a group program', () => addGroup(), { kind: 'primary' }) : null), body);
  async function load() {
    clear(body).append(loading());
    try {
      const { data } = await get('/skischool/groups');
      clear(body).append(data.length ? table([
        { head: 'Group', cell: (g) => h('span', null, h('strong', null, g.org_name), h('div', { class: 'muted small' }, `${g.program}, leader ${g.leader_name}`)) },
        { head: 'When', cell: (g) => h('span', null, `${g.weekday}s from ${fmtDate(g.first_day)}`, h('div', { class: 'muted small' }, `${plural(g.weeks, 'week')}, ${clock(g.start_time)} to ${clock(g.end_time)}`)) },
        { head: 'Roster', cell: (g) => h('span', null, `${g.students} of ${g.max_students}`, h('div', { class: 'muted small' }, `${g.waivers} waivers signed`)) },
        { head: 'Chaperones', cell: (g) => state(`${g.chaperones} of ${g.chaperones_needed}`, g.chaperones >= g.chaperones_needed ? 'good' : 'warn') },
        { head: 'Link', cell: (g) => (g.status !== 'open' ? state('Canceled', 'neutral') : g.open ? h('span', { class: 'small' }, `Open until ${fmtDateTime(String(g.deadline_at).replace(' ', 'T'))}`) : state('Roster closed', 'neutral')) },
        { head: '', actions: true, cell: (g) => button('Open', () => openGroup(g.id), { small: true, label: `Open ${g.org_name}` }) },
      ], data) : empty('No group programs yet.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  function showLink(link, words) {
    const box = input({ value: link, readonly: true, 'aria-label': 'Booking link', class: 'link-box' });
    dialog('Send this link to the group leader', h('div', { class: 'stack' }, h('p', null, words), box,
      h('div', { class: 'row' }, button('Copy link', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (_) { box.select(); } }, { kind: 'primary' }),
        h('a', { class: 'btn', href: link, target: '_blank', rel: 'noopener' }, 'Open the page')),
      h('p', { class: 'muted small' }, 'The link is shown once. Make a new one from the group if it is lost (the old one then stops working).')));
  }
  function addGroup() {
    const first = input({ type: 'date', name: 'first_day', required: true, value: addDays(todayStr(), 14) });
    formDialog('Add a group program', h('div', { class: 'form' },
      field('School or club', input({ name: 'org_name', required: true, maxlength: 160, placeholder: 'For example: Valley Elementary' })),
      field('Program name', input({ name: 'program_name', maxlength: 120, placeholder: 'For example: After-school ski' }), 'Blank: the group and the weekday'),
      field('Group leader', input({ name: 'leader_name', required: true, maxlength: 160 })),
      field('Leader email', input({ name: 'leader_email', type: 'email', maxlength: 255 })), field('Leader phone', input({ name: 'leader_phone', type: 'tel', maxlength: 40 })),
      field('First day', first, 'The program meets on this weekday each week'), field('Weeks', input({ type: 'number', name: 'weeks', min: 1, max: 16, value: 6, required: true })),
      field('From', input({ type: 'time', name: 'start_time', value: '15:30', required: true })), field('To', input({ type: 'time', name: 'end_time', value: '17:30', required: true })),
      field('Most children', input({ type: 'number', name: 'max_students', min: 1, max: 200, value: 30 })),
      field('Children per chaperone', input({ type: 'number', name: 'per_chaperone', min: 1, max: 30, value: 10 }), 'The plan needs one chaperone for each group this size'),
      field('Roster closes', select([[24, '24 hours before'], [48, '48 hours before'], [72, '72 hours before'], [120, '5 days before'], [168, '7 days before']], 72, { name: 'deadline_hours' }), 'Before the first day'),
      field('Meeting place', input({ name: 'meeting_place', maxlength: 160, placeholder: 'For example: the ski school bell' })),
      field('Price for the group', input({ name: 'price', inputmode: 'decimal', placeholder: '0.00' }), 'Kept with the program, for the invoice')), async (fd) => {
      const cents = toCents(val(fd, 'price') || '0');
      if (cents === null) throw new Error('Write the price as an amount, such as 1200.00');
      const out = await post('/skischool/groups', { org_name: val(fd, 'org_name'), program_name: val(fd, 'program_name') || undefined, leader_name: val(fd, 'leader_name'), leader_email: val(fd, 'leader_email') || null, leader_phone: val(fd, 'leader_phone') || null,
        first_day: val(fd, 'first_day'), weeks: Number(val(fd, 'weeks')), start_time: val(fd, 'start_time'), end_time: val(fd, 'end_time'), max_students: Number(val(fd, 'max_students')) || 30,
        per_chaperone: Number(val(fd, 'per_chaperone')) || 10, deadline_hours: Number(val(fd, 'deadline_hours')), meeting_place: val(fd, 'meeting_place'), price_cents: cents });
      await load();
      showLink(out.link, `The roster and chaperone plan close ${fmtDateTime(String(out.deadline_at).replace(' ', 'T'))}.`);
    }, { wide: true, submitText: 'Add group' });
  }
  async function openGroup(id) {
    let g; let instructors = [];
    try { g = await get(`/skischool/groups/${id}`); } catch (err) { fail(err); return; }
    if (schoolCan('director')) { try { instructors = (await get('/skischool/instructors')).data.filter((s) => s.teaches); } catch (_) { /* coach stays as is */ } }
    const coachSel = (m) => {
      const sel = select([['', 'No instructor yet'], ...instructors.map((s) => [s.id, s.name])], m.coach_staff_id || '', { 'aria-label': `Instructor on ${fmtDate(m.starts_at)}` });
      sel.addEventListener('change', async () => { try { await patch(`/skischool/groups/${id}/meetings/${m.id}`, { coach_staff_id: sel.value ? Number(sel.value) : null, all: true }); toast('Instructor set for this and the later weeks'); } catch (err) { fail(err); } });
      return sel;
    };
    const handoff = (m, what) => {
      const names = g.chaperones.map((c) => c.name);
      formDialog(what === 'dropoff' ? 'Drop-off' : 'Pickup', h('div', { class: 'form' },
        field(what === 'dropoff' ? 'Dropped off by' : 'Picked up by', names.length ? select(names.map((n) => [n, n]), names[0], { name: 'by' }) : input({ name: 'by', required: true, maxlength: 160 })),
        field('Children', input({ type: 'number', name: 'count', min: 0, max: 500, value: what === 'pickup' && m.dropoff ? m.dropoff.count : g.students.length, required: true }))), async (fd) => {
        const r = await post(`/skischool/groups/${id}/meetings/${m.id}/handoff`, { what, by: val(fd, 'by'), count: Number(val(fd, 'count')) });
        if (r.mismatch) toast(r.mismatch, 'error'); else toast(what === 'dropoff' ? 'Drop-off recorded' : 'Pickup recorded');
        await closeAllDialogs(); await openGroup(id);
      }, { submitText: what === 'dropoff' ? 'Record drop-off' : 'Record pickup' });
    };
    const hand = (x) => (x ? `${fmtTime(String(x.at).replace(' ', 'T'))}, ${x.by}, ${x.count}` : '');
    dialog(`${g.org_name}: ${g.program}`, h('div', { class: 'stack' },
      h('p', null, `${g.weekday}s, ${clock(g.start_time)} to ${clock(g.end_time)}, ${plural(g.weeks, 'week')} from ${fmtDate(g.first_day)}.${g.meeting_place ? ` Meet at ${g.meeting_place}.` : ''} Leader: ${g.leader_name}${g.leader_phone ? `, ${g.leader_phone}` : ''}${g.leader_email ? `, ${g.leader_email}` : ''}.`),
      h('p', { class: 'small' }, g.open ? `The leader can change the roster until ${fmtDateTime(String(g.deadline_at).replace(' ', 'T'))}.` : 'The roster is closed. Changes go through the ski school.'),
      schoolCan('director') && g.status === 'open' ? h('div', { class: 'row' },
        button('Make a new link', () => confirmDialog('Make a new booking link?', 'The old link stops working.', 'Make a new link', async () => { const r = await post(`/skischool/groups/${id}/link`, {}); showLink(r.link, 'Send this new link to the group leader.'); })),
        button('Cancel the program', () => confirmDialog('Cancel this group program?', 'Every meeting still ahead is canceled and the link stops working.', 'Cancel program', async () => { await patch(`/skischool/groups/${id}`, { status: 'cancelled' }); toast('Canceled'); await closeAllDialogs(); await load(); }, { danger: true }))) : null,
      h('h3', null, 'Meetings'),
      table([
        { head: 'Day', cell: (m) => h('span', null, fmtDate(m.starts_at), m.status !== 'scheduled' ? h('span', null, ' ', state(label(m.status), 'neutral')) : null) },
        { head: 'Instructor', cell: (m) => (schoolCan('director') ? coachSel(m) : m.coach || h('span', { class: 'muted' }, 'Not set')) },
        { head: 'Drop-off', cell: (m) => (m.dropoff ? hand(m.dropoff) : m.status === 'scheduled' ? button('Drop-off', () => handoff(m, 'dropoff'), { small: true, label: `Record drop-off on ${fmtDate(m.starts_at)}` }) : '') },
        { head: 'Pickup', cell: (m) => (m.pickup ? hand(m.pickup) : m.dropoff ? button('Pickup', () => handoff(m, 'pickup'), { small: true, label: `Record pickup on ${fmtDate(m.starts_at)}` }) : '') },
      ], g.meetings),
      h('h3', null, `Children (${g.students.length} of ${g.max_students})`),
      g.students.length ? table([
        { head: 'Child', cell: (s) => h('strong', null, `${s.first_name} ${s.last_name}`) },
        { head: 'Parent or guardian', cell: (s) => h('span', null, s.guardian_name || '', s.guardian_phone ? h('div', { class: 'small' }, h('a', { href: `tel:${String(s.guardian_phone).replace(/[^\d+]/g, '')}` }, s.guardian_phone)) : null) },
        { head: 'Waiver', cell: (s) => (s.waiver_signed ? state(s.waiver_signed_by ? `Signed by ${s.waiver_signed_by}` : 'Signed', 'good') : state('Not signed yet', 'warn')) },
      ], g.students) : empty('The leader has not added anyone yet.'),
      h('h3', null, `Chaperones (${g.chaperones.length} of ${g.chaperones_needed} needed)`),
      g.chaperones.length ? h('ul', { class: 'plain' }, g.chaperones.map((c) => h('li', null, `${c.name}, `, h('a', { href: `tel:${String(c.phone).replace(/[^\d+]/g, '')}` }, c.phone)))) : empty('No chaperones yet.')), { wide: true });
  }
  await load();
}

// ================================================================ Owner reports
async function ownerTab(root) {
  const season = seasonFor(todayStr());
  const y = Number(season.slice(0, 4));
  const from = input({ type: 'date', value: `${y}-08-01`, 'aria-label': 'From' });
  const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const seasons = [0, 1, 2].map((k) => { const s = y - k; return [`${s}-${String((s + 1) % 100).padStart(2, '0')}`, `${s}-${String((s + 1) % 100).padStart(2, '0')} season`]; });
  const seasonSel = select(seasons, season, { 'aria-label': 'Season' });
  const body = h('div', { class: 'stack owner-reports' });
  root.append(h('p', { class: 'muted' }, 'For owners and managers. Revenue counts only what was paid for a seat, before tax, less refunds. Instructor cost is the pay lines, as payroll counts them (tips are not cost).'),
    h('div', { class: 'inline-form' }, field('From', from), field('To', to), field('Season', seasonSel), button('Show', () => load(), { kind: 'primary' })), body);
  const csvBtn = (path, name) => button('Download CSV', () => download(`${path}${path.includes('?') ? '&' : '?'}format=csv`, name), { small: true, label: `Download ${name}` });
  const section = (title, intro, csv, content) => h('section', { class: 'panel stack', 'data-report': title }, h('header', { class: 'row between' }, h('h2', null, title), csv), intro ? h('p', { class: 'muted small' }, intro) : null, content);
  const pctText = (v) => (v === null || v === undefined ? '' : `${v}%`);
  async function load() {
    clear(body).append(loading());
    const r = `from=${from.value}&to=${to.value}`;
    try {
      const [rph, cost, ret, conv] = await Promise.all([get(`/skischool/owner-reports/revenue-per-hour?${r}`), get(`/skischool/owner-reports/cost?${r}`), get(`/skischool/owner-reports/return-rate?season=${seasonSel.value}`), get(`/skischool/owner-reports/conversion?season=${seasonSel.value}`)]);
      appendAll(clear(body),
        section('Revenue per instructor hour', `${money(rph.total.revenue_cents)} over ${rph.total.hours} instructor hours: ${rph.total.revenue_per_hour_cents === null ? 'no hours yet' : `${money(rph.total.revenue_per_hour_cents)} an hour`}.`, csvBtn(`/skischool/owner-reports/revenue-per-hour?${r}`, `revenue-per-hour-${from.value}.csv`),
          rph.rows.length ? table([
            { head: 'Instructor', cell: (x) => h('strong', null, x.instructor) },
            { head: 'Lessons', num: true, cell: (x) => String(x.lessons) },
            { head: 'Hours', num: true, cell: (x) => String(x.hours) },
            { head: 'Revenue', num: true, cell: (x) => money(x.revenue_cents) },
            { head: 'Per hour', num: true, cell: (x) => (x.revenue_per_hour_cents === null ? '' : money(x.revenue_per_hour_cents)) },
          ], rph.rows) : empty('No lessons in these days.')),
        section('Instructor cost and lesson revenue', `Revenue ${money(cost.total.revenue_cents)}, instructor cost ${money(cost.total.cost_cents)}${cost.total.cost_pct === null ? '' : ` (${cost.total.cost_pct}% of revenue)`}.`, csvBtn(`/skischool/owner-reports/cost?${r}`, `cost-${from.value}.csv`),
          h('div', { class: 'stack' },
            h('h3', null, 'By product'), cost.by_product.length ? table(costCols('Product'), cost.by_product) : empty('Nothing yet.'),
            h('details', null, h('summary', null, `By day (${cost.by_day.length})`), cost.by_day.length ? table(costCols('Day', (k) => fmtDate(k)), cost.by_day) : empty('Nothing yet.')))),
        section('Instructor return rate', `${ret.total.returned} of ${ret.total.taught_last_season} instructors who taught in ${ret.last_season} are teaching in ${ret.season} (${ret.total.return_pct}%). ${plural(ret.total.new_this_season, 'new instructor')} this season.`, csvBtn(`/skischool/owner-reports/return-rate?season=${seasonSel.value}`, `return-rate-${seasonSel.value}.csv`),
          ret.rows.length ? table([
            { head: 'Instructor', cell: (x) => h('strong', null, x.instructor) },
            { head: 'Last season', num: true, cell: (x) => plural(x.last_season, 'lesson') },
            { head: 'This season', num: true, cell: (x) => plural(x.this_season, 'lesson') },
            { head: 'Back', cell: (x) => state(x.returned ? 'Back' : 'Not back', x.returned ? 'good' : 'neutral') },
          ], ret.rows) : empty(`Nobody taught in ${ret.last_season}.`)),
        section('First-timer conversion', `${plural(conv.first_timers, 'first-timer')} in ${conv.season}: students whose first lesson was Level 1. Converted means they then booked another lesson, bought a lesson pack, started a learn to ski ladder, or bought a season pass.`, csvBtn(`/skischool/owner-reports/conversion?season=${seasonSel.value}`, `conversion-${seasonSel.value}.csv`),
          conv.first_timers ? table([
            { head: 'What they did', cell: (x) => (x.kind ? x.what : h('strong', null, x.what)) },
            { head: 'Within 30 days', num: true, cell: (x) => `${x.d30} (${pctText(x.d30_pct)})` },
            { head: 'Within 60 days', num: true, cell: (x) => `${x.d60} (${pctText(x.d60_pct)})` },
            { head: 'In the season', num: true, cell: (x) => `${x.season} (${pctText(x.season_pct)})` },
          ], conv.rows) : empty('No first-timers this season yet.')));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  const costCols = (head, fmt = (k) => k) => [
    { head, cell: (x) => h('strong', null, fmt(x.key)) },
    { head: 'Revenue', num: true, cell: (x) => money(x.revenue_cents) },
    { head: 'Instructor cost', num: true, cell: (x) => money(x.cost_cents) },
    { head: 'Margin', num: true, cell: (x) => money(x.margin_cents) },
    { head: 'Cost share', num: true, cell: (x) => pctText(x.cost_pct) },
  ];
  await load();
}

// ================================================================ Settings, Ski school: Pay ladder
const LESSON_KINDS = [['group', 'Group'], ['semi_private', 'Semi-private'], ['private', 'Private'], ['hourly', 'Hourly'], ['program', 'Program meeting']];
async function ladderSettings(panel) {
  const body = h('div', { class: 'stack' });
  panel.append(h('p', { class: 'muted' }, 'Pay by certification level. An instructor\'s own rate (Pay rates) always wins; then the ladder by their level (set it in Who teaches what); then the school default. Credential add-ons are paid on top: Children\'s Specialist on lessons for under 18s, Adaptive on adaptive lessons, Freestyle on park and freestyle lessons.'), body);
  async function load() {
    clear(body).append(loading());
    const d = await get('/skischool/pay/ladder');
    const cur = (rung, kind) => d.ladder.filter((r) => r.rung === rung && r.kind === kind && String(r.effective_from).slice(0, 10) <= d.today).sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0] || null;
    const cell = (rung, kind) => { const r = cur(rung, kind); return r ? money(r.cents) : h('span', { class: 'muted' }, 'Not set'); };
    clear(body).append(
      d.can_edit ? null : h('p', { class: 'muted small' }, 'Only an owner or manager can change the pay ladder.'),
      h('h3', null, 'Certification levels'),
      table([
        { head: 'Level', cell: (c) => h('span', null, h('strong', null, c.words), c.instructors ? h('div', { class: 'muted small' }, plural(c.instructors, 'instructor')) : null) },
        ...LESSON_KINDS.map(([k, t]) => ({ head: t, num: true, cell: (c) => cell(c.key, k) })),
        { head: '', actions: true, cell: (c) => (d.can_edit ? button('Edit', () => edit(c, LESSON_KINDS), { small: true, label: `Edit pay for ${c.words}` }) : null) },
      ], d.certs),
      h('h3', null, 'Specialist credential add-ons'),
      table([
        { head: 'Credential', cell: (c) => h('strong', null, c.words) },
        { head: 'Per lesson', num: true, cell: (c) => cell(c.key, 'lesson_addon') },
        { head: 'Per hour', num: true, cell: (c) => cell(c.key, 'hourly_addon') },
        { head: '', actions: true, cell: (c) => (d.can_edit ? button('Edit', () => edit(c, [['lesson_addon', 'Per lesson'], ['hourly_addon', 'Per hour']]), { small: true, label: `Edit the ${c.words} add-on` }) : null) },
      ], d.credentials));
    function edit(c, kinds) {
      const fromIn = input({ type: 'date', name: 'from', value: d.today, required: true });
      const inputs = kinds.map(([k, t]) => { const r = cur(c.key, k); return [k, t, input({ name: k, inputmode: 'decimal', value: r ? centsToInput(r.cents) : '', placeholder: 'Not set' })]; });
      formDialog(`Pay ladder: ${c.words}`, h('div', { class: 'form' }, ...inputs.map(([, t, el]) => field(t, el)), field('From', fromIn, 'Lessons on and after this day use these amounts.'),
        h('p', { class: 'muted small wide' }, 'Leave a box empty for none.')), async () => {
        let n = 0;
        for (const [k, , el] of inputs) {
          const r = cur(c.key, k);
          const text = el.value.trim();
          if (!text) { if (r) { await post('/skischool/pay/ladder', { rung: c.key, kind: k, cents: null, effective_from: fromIn.value }); n += 1; } continue; }
          const cents = toCents(text);
          if (cents === null) throw new Error('Write each amount like 36.00');
          if (r && r.cents === cents) continue;
          await post('/skischool/pay/ladder', { rung: c.key, kind: k, cents, effective_from: fromIn.value }); n += 1;
        }
        toast(n ? 'Pay ladder saved' : 'Nothing changed');
        await load();
      });
    }
  }
  await load();
}

// ================================================================ Settings, Ski school: Learn to ski ladder
async function learnSettings(panel) {
  const body = h('div', { class: 'stack' });
  panel.append(h('p', { class: 'muted' }, 'A first-timer package of 3 or 4 lessons with a lift ticket and rental included. It is sold in Sell like a lesson package and spent one lesson at a time on the roster. When a student has attended every lesson, they get your season pass offer, shown on the family\'s progress card.'), body);
  async function load() {
    clear(body).append(loading());
    const d = await get('/skischool/ladders');
    clear(body).append(d.data.length ? table([
      { head: 'Package', cell: (l) => h('span', null, h('strong', null, l.name), h('div', { class: 'muted small' }, `${plural(l.lessons, 'lesson')}, ${money(l.price_cents)}${l.includes ? `, includes ${l.includes}` : ''}`)) },
      { head: 'Graduate offer', cell: (l) => (l.pass_percent && l.pass ? `${l.pass_percent}% off ${l.pass}, for ${l.pass_days} days` : h('span', { class: 'muted' }, 'None')) },
      { head: 'Sold', cell: (l) => state(l.active ? 'On sale' : 'Off', l.active ? 'good' : 'neutral') },
      { head: '', actions: true, cell: (l) => (d.choices ? button('Edit', () => edit(l), { small: true, label: `Edit ${l.name}` }) : null) },
    ], d.data) : empty('No learn to ski ladder yet.'), d.choices ? h('div', { class: 'row' }, button('Add a ladder', () => edit(null), { kind: 'primary' })) : null);
    function edit(l) {
      const pick = (list, v, name, none) => select([['', none], ...list.map((p) => [p.id, `${p.name} (${money(p.base_price_cents)})`])], v || '', { name });
      formDialog(l ? `Edit ${l.name}` : 'Add a learn to ski ladder', h('div', { class: 'form' },
        h('div', { class: 'wide' }, field('Name', input({ name: 'name', required: true, maxlength: 120, value: l ? l.name : 'Learn to ski in 3' }))),
        field('Lessons', select([[3, '3 lessons'], [4, '4 lessons']], l ? l.lessons : 3, { name: 'lessons' })),
        field('Price', input({ name: 'price', inputmode: 'decimal', required: true, value: l ? centsToInput(l.price_cents) : '' }), 'For the whole package'),
        field('Lift ticket included', pick(d.choices.tickets, l && l.ticket_product_id, 'ticket', 'No lift ticket')),
        field('Rental included', pick(d.choices.rentals, l && l.rental_product_id, 'rental', 'No rental')),
        field('Graduate offer: season pass', pick(d.choices.passes, l && l.pass_product_id, 'pass', 'No offer')),
        field('Discount for graduates', input({ type: 'number', name: 'pass_percent', min: 0, max: 100, value: l ? l.pass_percent : 20 }), 'Percent off the season pass'),
        field('Offer good for', input({ type: 'number', name: 'pass_days', min: 7, max: 365, value: l ? l.pass_days : 30 }), 'Days after they graduate'),
        l ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: l.active }), ' On sale') : null), async (fd) => {
        const cents = toCents(val(fd, 'price') || '');
        if (cents === null) throw new Error('Write the price as an amount, such as 199.00');
        const b = { name: val(fd, 'name'), lessons: Number(val(fd, 'lessons')), price_cents: cents, ticket_product_id: Number(val(fd, 'ticket')) || null, rental_product_id: Number(val(fd, 'rental')) || null,
          pass_product_id: Number(val(fd, 'pass')) || null, pass_percent: Number(val(fd, 'pass_percent')) || 0, pass_days: Number(val(fd, 'pass_days')) || 30 };
        if (l) await patch(`/skischool/ladders/${l.id}`, { ...b, active: Boolean(fd.get('active')) }); else await post('/skischool/ladders', b);
        toast('Saved'); await load();
      }, { wide: true });
    }
  }
  await load();
}
