// Patrol: cases (patient care reports), team, posts, equipment, training, trail checks and statistics.

import { get, download } from '../api.js';
import { setAccess, has } from './patrol-feat.js';
import { drawLevels } from './patrol-levels.js';
import { h, clear, input, select, field, button, toast, formDialog, tabs, val, num, nowInput, todayStr, addDays, label, errorBox, ctx } from '../ui.js';
import { renderCase, CATEGORIES, SEVERITY, compact, flow } from './patrol-case.js';
import { renderHandoff } from './patrol-handoff.js';
import { renderCollisionReport } from './patrol-collision.js';
import { renderRefusal } from './patrol-refusal.js';
import { renderTakehome } from './patrol-takehome.js';
import { drawHome } from './patrol-home.js';
import { caseRow } from './case-list.js';
import { drawFollowup } from './patrol-followup.js';
import { drawTeam, drawPosts, drawEquipment, drawTraining } from './patrol-team.js';
import { drawDispatch, drawPassport } from './patrol-dispatch.js';
import { formSettingsDialog, loadForm, keptForm } from './nsaar-form.js';
import { drawMapTab } from './incident-map.js';
import { drawAccessLog } from './patrol-access.js';
import { drawNetwork } from './patrol-network.js';
import { drawReview } from './patrol-review.js';
import { drawSchedule } from './patrol-schedule.js';
import { drawCover } from './patrol-cover.js';
import { drawCrews } from './patrol-crews.js';
import { drawDuty, renderRoom } from './patrol-duty.js';
import { drawSweep, drawOpening } from './patrol-sweep.js';
import { drawMeds } from './patrol-meds.js';
import { drawLifts } from './patrol-lifts.js';
import { drawLog } from './patrol-log.js';
import { drawAvy } from './patrol-avy.js';
import { drawRecords, renderRelease } from './patrol-records.js';
import { drawOpsSettings } from './patrol-settings.js';
import { drawRequirements } from './patrol-requirements.js';
import { send as queue, keepCase, latestKept } from '../outbox.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A banner that appears when the phone loses its connection, so nobody keeps typing into a page that is not saving. */
function connectionBanner() {
  const el = h('div', { class: 'offline-banner', role: 'status', 'aria-live': 'polite', hidden: navigator.onLine !== false },
    h('b', null, 'No connection. '), 'Vitals, treatments, time stamps, assessment answers, signatures and the before-the-patient-leaves checklist are kept on this phone and sent when the signal returns. Other changes wait until then.');
  const sync = () => { if (!el.isConnected) { window.removeEventListener('online', sync); window.removeEventListener('offline', sync); return; } el.hidden = navigator.onLine !== false; };
  window.addEventListener('online', sync); window.addEventListener('offline', sync);
  return el;
}
/** A big "New case" button that stays in reach on every patrol screen. */
const newCaseButton = () => !has('create_case') ? null : h('button', { type: 'button', class: 'fab', 'data-act': 'new-case', onclick: () => newCase() }, h('span', { 'aria-hidden': 'true' }, '+'), ' New case');

const ONE = /^\d+$/;
const CASE_ID = /^-?\d+$/; // a case started with no signal has a temporary negative id until it reaches the server
// The last answers from the server, so a case can still be opened in a dead spot (the app itself is already loaded).
let lastMe = null; let lastRoster = [];
export async function render(root, params = []) {
  let me;
  try { me = await get('/patrol/me'); lastMe = me; } catch (err) { if (!lastMe || (err && err.status && err.status < 500)) throw err; me = lastMe; }
  setAccess(me);
  // Keep the report form's layout on this phone while there is a signal, so a case can be started where there is none.
  if (has('create_case')) loadForm().catch(() => {});
  root.append(connectionBanner());
  if (params[0] === 'case' && CASE_ID.test(params[1] || '')) {
    let roster = lastRoster;
    try { roster = (await get('/patrol/team')).data; lastRoster = roster; } catch (_) { /* no signal: the roster last seen */ }
    await renderCase(root, Number(params[1]), { roster, me, mode: params[2] });
    return; // no floating New case button over a case: it covered the case's own buttons
  }
  if (params[0] === 'version' && ONE.test(params[1] || '') && ONE.test(params[2] || '')) {
    await renderCase(root, Number(params[1]), { me, version: Number(params[2]) }); // a frozen copy, read only
    return;
  }
  if (params[0] === 'room') { await renderRoom(root); return; } // the patrol-room sign-in screen
  if (params[0] === 'release' && ONE.test(params[1] || '')) { await renderRelease(root, Number(params[1])); return; }
  const printPages = { handoff: renderHandoff, refusal: renderRefusal, takehome: renderTakehome };
  // the refusal can be signed on a case started with no signal (temporary negative ids, kept on the phone)
  if (printPages[params[0]] && (params[0] === 'refusal' ? CASE_ID : ONE).test(params[1] || '') && (params[0] === 'refusal' ? CASE_ID : ONE).test(params[2] || '')) {
    await printPages[params[0]](root, Number(params[1]), Number(params[2]), params[3]);
    return;
  }
  if (params[0] === 'collision' && ONE.test(params[1] || '')) {
    await renderCollisionReport(root, Number(params[1]));
    return;
  }
  const opts = { canLead: me.can_lead, canAdmin: me.can_admin_form, staffId: me.staff_id, newCase };
  const only = (feature, item) => (has(feature) ? [item] : []);
  const items = [
    ['home', 'Home', (b) => drawHome(b, opts)],
    ['duty', 'On duty', drawDuty],
    ['sweep', 'Closing sweep', drawSweep],
    ['opening', 'Opening checks', drawOpening],
    ['log', 'Daily log', drawLog],
    ...(me.avalanche ? [['avalanche', 'Avalanche', drawAvy]] : []),
    ...only('dispatch', ['dispatch', 'Dispatch', (b) => drawDispatch(b, opts)]),
    ...only('view_cases', ['cases', 'All cases', (b) => drawCases(b, opts)]),
    ...only('followups', ['followup', 'Follow-up', drawFollowup]),
    ['map', 'Map', (b) => drawMapTab(b, opts)],
    ['schedule', 'Schedule', drawSchedule],
    ['crews', 'Crews', drawCrews],
    ['cover', 'Shift cover', drawCover],
    ['posts', 'Today\'s posts', (b) => drawPosts(b, opts)],
    ['team', 'Roster', (b) => drawTeam(b, opts)],
    ['equipment', 'Equipment', (b) => drawEquipment(b, opts)],
    ['meds', 'Medications', drawMeds],
    ['lifts', 'Lift evacuation', drawLifts],
    ['training', 'Training', (b) => drawTraining(b, opts)],
    ['passport', 'Skills', (b) => drawPassport(b, opts)],
    ...only('records', ['records', 'Records requests', drawRecords]),
    ...(['manage_settings', 'manage_schedule', 'manage_meds', 'run_sweep', 'avalanche'].some(has) ? [['settings', 'Patrol settings', drawOpsSettings]] : []),
    ...(['manage_settings', 'approve_case', 'submit_case'].some(has) ? [['requirements', 'Report requirements', drawRequirements]] : []),
    ...only('reports', ['stats', 'Statistics', drawStats]),
    ...only('reports', ['network', 'Injury network', drawNetwork]),
    ...(me.is_reviewer || me.can_manage_review ? [['review', me.review_group ? 'Review' : 'Review group', (b) => drawReview(b, me)]] : []),
    ...only('view_access_log', ['access', 'Access log', drawAccessLog]),
    ...(me.access_level === 'admin' ? [['levels', 'Access levels', drawLevels]] : []),
  ];
  // Two levels: a few sections for what the person is doing, then the pages inside the chosen section. On a phone the
  // pages show as large buttons that wrap, so none hides off the edge of the screen.
  const SECTIONS = [
    ['now', 'Now', ['home', 'duty', 'dispatch', 'map', 'opening', 'sweep', 'avalanche', 'log']],
    ['cases', 'Cases', ['cases', 'review', 'followup', 'records', 'stats', 'network']],
    ['people', 'People', ['schedule', 'crews', 'cover', 'posts', 'team', 'training', 'passport']],
    ['gear', 'Gear', ['equipment', 'meds', 'lifts']],
    ['admin', 'Admin', ['settings', 'requirements', 'access', 'levels']],
  ].map(([id, text, keys]) => ({ id, text, items: keys.map((k) => items.find((i) => i[0] === k)).filter(Boolean) })).filter((s) => s.items.length);
  const wanted = SECTIONS.find((s) => s.items.some((i) => i[0] === params[0])) || SECTIONS[0];
  const body = h('div', { class: 'pbody' });
  const buttons = new Map();
  let badge = null;
  const nav = h('nav', { class: 'psections', 'aria-label': 'Patrol sections' }, ...SECTIONS.map((s) => {
    const b = h('button', { type: 'button', 'data-section': s.id, onclick: () => open(s) }, s.text);
    buttons.set(s.id, b);
    return b;
  }));
  function open(section, key) {
    for (const [id, b] of buttons) { if (id === section.id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    clear(body).append(h('div', { class: section.items.length === 1 ? 'solo' : null }, tabs(section.items, key && section.items.some((i) => i[0] === key) ? key : section.items[0][0])));
  }
  // New case is the one thing a patroller must always find: in the header on every screen size, and floating on a phone.
  const headNew = has('create_case') ? h('button', { type: 'button', class: 'btn primary patrol-new', 'data-act': 'new-case-head', onclick: () => newCase() }, h('span', { 'aria-hidden': 'true' }, '+'), ' New case') : null;
  root.append(h('div', { class: 'page-head patrol-head' }, h('h1', null, 'Patrol'), nav, headNew), body, newCaseButton());
  open(wanted, params[0]);
  // A small count on Cases when reports are waiting for this person to approve.
  if (has('approve_case') && buttons.has('cases')) {
    get('/patrol/home').then((home) => {
      const n = home.can_approve ? home.waiting.length : 0;
      if (!n || !nav.isConnected) return;
      badge = h('span', { class: 'psec-badge', 'aria-label': `${n} waiting for approval` }, String(n));
      buttons.get('cases').append(badge);
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------- cases
const REMEMBER = { report_state: '', category: '', severity: '', range: '', from: '', to: '', q: '' };
const dayStr = (back) => addDays(todayStr(), -back);
const RANGES = [['', 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['custom', 'Pick dates']];
const STATES = [['', 'All'], ['draft', 'Drafts'], ['submitted', 'Waiting for review'], ['approved', 'Approved']];

async function drawCases(box, { canAdmin } = {}) {
  const f = { ...REMEMBER, ...(drawCases.last || {}) };   // the filters are kept while the page stays open
  const remember = () => { drawCases.last = { ...f }; };
  const q = input({ type: 'search', 'aria-label': 'Search cases', placeholder: 'Search cases', value: f.q });
  const category = select([['', 'Any type'], ...CATEGORIES.map((c) => [c, label(c)])], f.category, { 'aria-label': 'Type' });
  const severity = select([['', 'Any severity'], ...SEVERITY.map((c) => [c, label(c)])], f.severity, { 'aria-label': 'Severity' });
  const from = input({ type: 'date', 'aria-label': 'From', value: f.from });
  const to = input({ type: 'date', 'aria-label': 'To', value: f.to });
  const dates = h('div', { class: 'row' }, h('label', { class: 'small muted' }, 'From ', from), h('label', { class: 'small muted' }, 'To ', to));
  const summary = h('div', { class: 'cases-summary', role: 'status', 'aria-live': 'polite' });
  const list = h('div');
  const stateBar = h('div', { class: 'fchips', role: 'group', 'aria-label': 'Report state' });
  const rangeBar = h('div', { class: 'fchips', role: 'group', 'aria-label': 'When' });
  const seg = (bar, options, key) => {
    clear(bar).append(...options.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(f[key] === value), 'data-value': value, onclick: () => { f[key] = value; sync(); load(); } }, text)));
  };
  const range = () => {
    if (f.range === 'today') return { from: dayStr(0) };
    if (f.range === 'week') return { from: dayStr(6) };
    if (f.range === 'month') return { from: dayStr(29) };
    if (f.range === 'custom') return { from: f.from, to: f.to };
    return {};
  };
  const query = () => {
    const parts = { q: f.q.trim(), report_state: f.report_state, category: f.category, severity: f.severity, ...range() };
    return Object.entries(parts).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  };
  const active = () => [
    f.report_state && ['State', STATES.find((x) => x[0] === f.report_state)[1], () => { f.report_state = ''; }],
    f.category && ['Type', label(f.category), () => { f.category = ''; }],
    f.severity && ['Severity', label(f.severity), () => { f.severity = ''; }],
    f.range && ['When', f.range === 'custom' ? [f.from, f.to].filter(Boolean).join(' to ') || 'Pick dates' : RANGES.find((x) => x[0] === f.range)[1], () => { f.range = ''; f.from = ''; f.to = ''; }],
    f.q.trim() && ['Search', `"${f.q.trim()}"`, () => { f.q = ''; }],
  ].filter(Boolean);
  function sync() {
    f.category = category.value; f.severity = severity.value; f.from = from.value; f.to = to.value;
    seg(stateBar, STATES, 'report_state'); seg(rangeBar, RANGES, 'range');
    dates.hidden = f.range !== 'custom';
    remember();
  }
  function clearAll() { Object.assign(f, REMEMBER); q.value = ''; category.value = ''; severity.value = ''; from.value = ''; to.value = ''; sync(); load(); }
  function drawSummary(count) {
    const pills = active();
    clear(summary).append(h('b', null, count == null ? 'Loading…' : `${count}${count === 500 ? '+' : ''} case${count === 1 ? '' : 's'}`),
      ...pills.map(([name, value, undo]) => h('button', { type: 'button', class: 'pill', 'aria-label': `Remove ${name} filter: ${value}`, onclick: () => { undo(); q.value = f.q; category.value = f.category; severity.value = f.severity; from.value = f.from; to.value = f.to; sync(); load(); } }, `${value} ×`)),
      ...(pills.length ? [button('Clear all', clearAll, { small: true, kind: 'ghost' })] : []));
  }
  let token = 0;
  async function load() {
    const my = ++token;
    drawSummary(null);
    clear(list).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/patrol/incidents${query() ? `?${query()}` : ''}`);
      if (my !== token) return;
      drawSummary(data.length);
      clear(list).append(data.length ? h('div', { class: 'case-list' }, data.map((i) => caseRow(i, { reportState: true })))
        : h('div', { class: 'empty' }, h('p', null, active().length ? 'No cases match these filters.' : 'There are no cases yet.'), active().length ? button('Clear filters', clearAll, { small: true }) : null));
    } catch (err) { if (my === token) clear(list).append(errorBox(err)); }
  }
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { f.q = q.value; remember(); load(); }, 300); });
  q.addEventListener('search', () => { clearTimeout(timer); f.q = q.value; remember(); load(); });
  for (const el of [category, severity, from, to]) el.addEventListener('change', () => { sync(); load(); });
  const mgr = has('reports');
  const exports = (mgr || canAdmin) ? h('details', { class: 'menu-pop' }, h('summary', { class: 'btn small' }, 'Options'),
    h('div', { class: 'menu-items stack' },
      mgr ? button('Cases CSV (uses the filters)', () => download(`/patrol/incidents.csv${query() ? `?${query()}` : ''}`, 'cases.csv'), { small: true }) : null,
      mgr ? button('Patient statistics CSV', () => download('/patrol/patients.csv', 'patients.csv'), { small: true }) : null,
      canAdmin ? button('Report requirements', () => { location.hash = '#/patrol/requirements'; }, { small: true }) : null,
      canAdmin ? button('Legal name on reports', () => formSettingsDialog(), { small: true }) : null)) : null;
  clear(box).append(h('div', { class: 'stack cases' },
    h('div', { class: 'cases-bar' }, h('div', { class: 'grow search' }, q), exports),
    h('div', { class: 'cases-filters' }, stateBar, rangeBar, dates, h('div', { class: 'row' }, category, severity)),
    summary,
    h('p', { class: 'muted small' }, 'Cases hold guest injury details. Opening a case is logged.'), list));
  sync();
  await load();
}

const PATIENT_TYPES = ['injury', 'collision', 'medical'];
let lastTrails = [];
/**
 * A case started with no signal, as the case page needs it, kept (sealed) on this phone under its temporary id. The
 * report form, trails and checklists come from the last case opened here, so the bedside card works the same.
 */
function startOffline(tmp, body, trailName) {
  const prev = latestKept();
  const p = body.patient;
  const c = {
    id: tmp, case_number: null, offline: true, status: 'open', report_state: 'draft', occurred_at: body.occurred_at.replace('T', ' '), location: body.location,
    trail_id: body.trail_id || null, trail: trailName || null, category: body.category, severity: body.severity, summary: body.summary, narrative: null, disposition: null,
    resort: prev && prev.c && prev.c.resort ? prev.c.resort : { name: ctx.me.tenant_name, legal_name: null },
    form: {}, notes: [], events: [], responders: [], witnesses: [], signatures: [], collision: null, parties: [], checklist: [], versions: [], photos: [], review: null, check: [], story_fill: false,
    patients: p ? [{ id: tmp - 1, incident_id: tmp, first_name: p.first_name || 'Unknown', last_name: p.last_name || 'Patient', age_years: p.age_years ?? null, chief_complaint: p.chief_complaint || null,
      sex: 'unknown', allergies: null, form: {}, vitals: [], injuries: [], treatments: [], derived: {} }] : [],
  };
  keepCase(tmp, { c, def: (prev && prev.def) || keptForm(), trails: prev ? prev.trails : lastTrails, checklists: prev ? prev.checklists : [] });
}

async function newCase() {
  let trails = lastTrails;
  try { trails = (await get('/schedule/trails?limit=500')).data; lastTrails = trails; } catch (_) { /* no signal: the trails last seen */ }
  // Built for gloves and cold hands: big buttons for type and severity, trail first, and the spot only when it adds something.
  const segmented = (name, options, value, ariaLabel) => {
    const hidden = h('input', { type: 'hidden', name, value });
    const btns = options.map((o) => h('button', { type: 'button', class: 'btn big-choice', 'aria-pressed': String(o === value), onclick: () => {
      hidden.value = o; for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.value === o));
    }, dataset: { value: o } }, label(o)));
    return h('div', { class: 'choice-grid', role: 'group', 'aria-label': ariaLabel }, btns, hidden);
  };
  const trail = select([['', 'Not on a trail'], ...trails.map((t) => [t.id, t.name])], '', { name: 'trail_id' });
  const where = input({ name: 'location', maxlength: 255, placeholder: 'For example "Top of Lower Ridge, skier\'s left"' });
  const summary = input({ name: 'summary', maxlength: 500, placeholder: 'Filled in for you if you leave it blank' });
  formDialog('New case', h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', null, 'Type'), segmented('category', CATEGORIES, 'injury', 'Type')),
    h('div', { class: 'field' }, h('span', null, 'Severity'), segmented('severity', SEVERITY, 'minor', 'Severity')),
    h('div', { class: 'form' }, field('Trail', trail), field('Where exactly (optional when a trail is picked)', where)),
    h('details', null, h('summary', null, 'Patient (optional, add more on the case)'), h('div', { class: 'form' },
      field('First name', input({ name: 'p_first', maxlength: 100 })), field('Last name', input({ name: 'p_last', maxlength: 100 })),
      field('Age', input({ name: 'p_age', type: 'number', min: 0, max: 120, inputmode: 'numeric' })), field('Chief complaint', input({ name: 'p_complaint', maxlength: 255 })))),
    h('details', null, h('summary', null, 'Time and summary (filled in for you)'), h('div', { class: 'form' },
      field('When', input({ type: 'datetime-local', name: 'occurred_at', value: nowInput(), required: true })),
      h('div', { class: 'wide' }, field('One-line summary', summary, 'Optional. If you leave it, the first patient\'s chief complaint becomes the summary.'))))),
  async (fd) => {
    const trailName = trail.value ? trail.options[trail.selectedIndex].textContent : '';
    const spot = val(fd, 'location') || trailName;
    if (!spot) throw new Error('Pick the trail or say where it is');
    const cat = val(fd, 'category');
    const patient = compact({ first_name: val(fd, 'p_first'), last_name: val(fd, 'p_last'), age_years: num(fd, 'p_age') ?? undefined, chief_complaint: val(fd, 'p_complaint') });
    const body = compact({ occurred_at: val(fd, 'occurred_at'), location: spot, trail_id: val(fd, 'trail_id') ? Number(val(fd, 'trail_id')) : null, category: cat, severity: val(fd, 'severity'),
      summary: val(fd, 'summary') || patient.chief_complaint || `${label(cat)} at ${spot}`, patient: Object.keys(patient).length ? patient : undefined });
    // No signal: the case is started on this phone with a temporary id and opens straight away, so time stamps and
    // bedside entries can be added at once. Everything waits, in order, and is sent when the signal returns; the case
    // then gets its real number and the page moves to it. The phone's id stops it being made twice.
    const tmp = -(Date.now() % 2000000000);
    // Offline, a patient record is made with the case (a placeholder name if none was given) so vitals can go on it at once.
    const offlineBody = PATIENT_TYPES.includes(cat) && !body.patient ? { ...body, patient: { first_name: 'Unknown', last_name: 'Patient' } } : body;
    const c = await queue('POST', '/patrol/incidents', body, { caseId: tmp, label: `New case at ${spot}`, offlineBody, temp: { caseId: tmp, patientId: offlineBody.patient ? tmp - 1 : null } });
    if (c.queued) {
      startOffline(tmp, offlineBody, trailName);
      toast('No signal: the case is started on this phone. Keep working; it is sent with everything you add when the signal returns.', 'warn');
      location.hash = `#/patrol/case/${tmp}/care`;
      return;
    }
    toast(`Case ${c.case_number} started`);
    flow.addPatient = PATIENT_TYPES.includes(cat) && !body.patient;
    flow.vitalsNext = PATIENT_TYPES.includes(cat);
    location.hash = `#/patrol/case/${c.id}`;
  }, { submitText: 'Start case' });
}

// ---------------------------------------------------------------- statistics
async function drawStats(box) {
  const from = input({ type: 'date', 'aria-label': 'From' });
  const to = input({ type: 'date', 'aria-label': 'To', value: todayStr() });
  const out = h('div', { class: 'stack' });
  async function load() {
    clear(out).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const qs = [from.value && `from=${from.value}`, to.value && `to=${to.value}`].filter(Boolean).join('&');
      const a = await get(`/patrol/analytics${qs ? `?${qs}` : ''}`);
      if (!from.value) from.value = a.from;
      const mins = (v) => (v === null ? 'No timed cases' : `${v} min`);
      const helmetYes = (a.helmet_use_on_snow.find((x) => x.label === 'yes') || { n: 0 }).n;
      const helmetAll = a.helmet_use_on_snow.reduce((s, x) => s + x.n, 0);
      clear(out).append(
        h('div', { class: 'figures' },
          fig('Cases', a.cases), fig('Patients', a.patients), a.staff_patients_on_duty ? fig('Staff hurt on duty', a.staff_patients_on_duty) : null, fig('Call to on scene', mins(a.response_times.call_to_scene_min)), fig('On scene to aid room', mins(a.response_times.scene_to_aid_room_min)),
          fig('Helmet use on snow', helmetAll ? `${Math.round((helmetYes / helmetAll) * 100)}%` : 'No data')),
        h('div', { class: 'two-col' },
          bars('Cases by type', a.by_category.map(lab)), bars('Cases by severity', a.by_severity.map(lab)),
          bars('Where cases happen', a.top_places), bars('Day of week', a.by_weekday.map((x) => ({ label: WEEKDAYS[x.label], n: x.n }))),
          bars('Hour of day', a.by_hour.map((x) => ({ label: `${x.label}:00`, n: x.n }))), bars('Patient outcomes', a.patients_by_disposition.map(lab)),
          bars('Activity', a.patients_by_activity.map(lab)), bars('Ability level', a.patients_by_ability.map(lab)),
          bars('Injuries by body part', a.injuries_by_region.map(lab)), bars('Injuries by type', a.injuries_by_type.map(lab)),
          bars('Cases led by', a.cases_by_lead), bars('Report status', a.report_states.map(lab))),
        h('p', { class: 'muted small' }, `Showing ${a.from} to ${a.to}. Response times use cases that have both times stamped on the timeline (${a.response_times.timed_cases}).`));
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  from.addEventListener('change', load); to.addEventListener('change', load);
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, field('From', from), field('To', to)), out));
  await load();
}
const lab = (x) => ({ label: label(String(x.label)), n: x.n });
const fig = (name, value) => h('div', { class: 'figure' }, h('strong', null, String(value)), h('span', null, name));
function bars(title, data) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return h('section', { class: 'panel stack' }, h('h3', null, title),
    data.length ? h('ul', { class: 'bars' }, data.map((d) => h('li', null, h('span', null, d.label), h('meter', { min: 0, max, value: d.n, 'aria-label': `${d.label}: ${d.n}` }), h('b', null, d.n)))) : h('p', { class: 'muted' }, 'No data for these dates.'));
}
