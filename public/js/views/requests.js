// Requests (muni release 1): resident reports and the repair record. Residents report from the public page
// (/report/<municipality>); staff add the ones that come by phone, at the counter, by email or text, or that the crew
// notices. Front desk and managers decide what to do with each new one (a work order for the crew, passed to another
// agency, a duplicate, or closed with no action); the crew marks it made safe and fixed, with photos kept as taken.
// Every request shows its times against the manager's response standard in plain words.
// Tabs: New, Open, Map, Done, Ledger (the repair record), Settings (managers). #/requests/r/12 opens one request.
// The resident's contact details show only to Front desk and managers, and never leave in an export unless a manager
// ticks "include contact details" (logged).
import { get, post, patch, put, sendBytes, fetchBlob, download } from '../api.js';
import { h, clear, ctx, isManager, can, table, state, tabs, input, select, field, button, toast, formDialog, confirmDialog, dialog, val, num, fmtDateTime, fmtDay, empty, errorBox, hashParam, todayStr, addDays } from '../ui.js';
import { loadLeaflet, makeMap, removeWhenGone, fitMap } from './incident-map.js';
import { qr } from '../barcode.js';
import { intakeChecks, requestChecks } from './utility-bits.js';

const TONE = { new: 'warn', assigned: 'neutral', made_safe: 'neutral', fixed: 'good', closed_no_action: 'neutral', duplicate: 'neutral', referred: 'neutral' };
const PRIORITIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];
const SOURCES = [['phone', 'Phone call'], ['walk_in', 'Walk-in'], ['crew', 'Crew noticed it'], ['email', 'Email'], ['text', 'Text message']];
const STAGES = [['before', 'Before'], ['made_safe', 'Made safe'], ['after', 'After']];
const CLASS_WORDS = { any: 'Any street', local: 'Local', collector: 'Collector', arterial: 'Arterial' };
const desk = () => can('counter');
const crewOrManager = () => isManager() || (ctx.me && ctx.me.role === 'staff');
const local16 = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const ref = () => Math.random().toString(36).slice(2, 12);
let META = null;
const meta = async (fresh = false) => { if (!META || fresh) META = await get('/requests/meta'); return META; };

/** Time against the standard: the words, marked late when the target was missed. */
function clock(m) {
  if (!m || !m.words) return '';
  return h('span', { class: m.met === false ? 'state' : null, dataset: m.met === false ? { state: 'bad' } : undefined }, m.words);
}

export async function render(root, params = []) {
  await meta(true);
  const head = h('div', { class: 'page-head spread' }, h('div', null, h('h1', null, 'Requests'), h('p', { class: 'muted' }, 'Reports from residents and the crew, each with its repair record.')),
    h('div', { class: 'row no-print' }, button('New request', () => newRequest(() => reload()), { kind: 'primary' })));
  let reload = () => {};
  const items = [
    ['new', 'New', (box) => { reload = () => list(box, 'new'); return reload(); }],
    ['open', 'Open', (box) => { reload = () => list(box, 'open'); return reload(); }],
    ['map', 'Map', (box) => { reload = () => drawMap(box); return reload(); }],
    ['done', 'Done', (box) => { reload = () => list(box, 'done'); return reload(); }],
    ['ledger', 'Ledger', (box) => { reload = () => drawLedger(box); return reload(); }],
  ];
  if (isManager()) items.push(['settings', 'Settings', (box) => { reload = () => drawSettings(box); return reload(); }]);
  root.append(head, tabs(items, META.categories.length && desk() ? 'new' : 'open'));
  if (params[0] === 'r' && /^\d+$/.test(params[1] || '')) openRequest(Number(params[1]), () => reload());
}

// ---------------------------------------------------------------- lists
async function list(box, view) {
  const cat = select([['', 'Every category'], ...META.categories.map((c) => [c.id, c.name])], hashParam('category') || '', { 'aria-label': 'Category' });
  const street = select([['', 'Every street'], ...META.streets.map((s) => [s.id, s.name])], '', { 'aria-label': 'Street' });
  const late = h('input', { type: 'checkbox', checked: hashParam('late') === '1' });
  const find = input({ type: 'search', placeholder: 'Reference or words', 'aria-label': 'Find a request' });
  const body = h('div');
  clear(box).append(h('div', { class: 'row req-filters no-print' }, cat, street, view === 'open' ? h('label', { class: 'check' }, late, ' Past target only') : null, find), body);
  async function load() {
    const qs = new URLSearchParams({ view: view === 'new' ? 'new' : view, ...(cat.value ? { category_id: cat.value } : {}), ...(street.value ? { street_id: street.value } : {}), ...(find.value.trim() ? { q: find.value.trim() } : {}), ...(late.checked ? { late: '1' } : {}) });
    const { data } = await get(`/requests?${qs}`);
    clear(body);
    if (!data.length) { body.append(empty(view === 'new' ? 'Nothing new to look at.' : view === 'open' ? 'No open requests.' : 'Nothing here yet.')); return; }
    body.append(table([
      { head: 'Request', cell: (r) => h('span', { class: 'stack tight' }, h('strong', null, r.reference), h('span', { class: 'muted small' }, r.priority !== 'normal' ? `${r.priority} priority` : '')) },
      { head: 'What', cell: (r) => r.category },
      { head: 'Where', cell: (r) => r.place },
      { head: 'Status', cell: (r) => state(r.status_words, TONE[r.status]) },
      { head: 'Reported', cell: (r) => fmtDateTime(r.reported_at) },
      { head: view === 'done' ? 'Fixed' : 'Against the standard', cell: (r) => (view === 'done' ? clock(r.fix) : h('span', { class: 'stack tight' }, r.status === 'made_safe' ? null : clock(r.make_safe), clock(r.fix))) },
      { head: '', actions: true, cell: (r) => button('Open', () => openRequest(r.id, load), { small: true, label: `Open ${r.reference}` }) },
    ], data));
  }
  for (const el of [cat, street, late]) el.addEventListener('change', load);
  let t; find.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
  await load();
}

// ---------------------------------------------------------------- one request
async function openRequest(id, after) {
  let r;
  try { r = await get(`/requests/${id}`); } catch (err) { dialog('Request', errorBox(err)); return; }
  const open = ['new', 'assigned', 'made_safe'].includes(r.status);
  const redo = async () => { dlg.close(); await after(); await openRequest(id, after); };
  const photoBox = h('div', { class: 'row' });
  for (const p of r.photos) {
    const img = h('img', { alt: `${p.stage} photo`, style: 'width:120px;height:120px;object-fit:cover;border-radius:8px' });
    fetchBlob(`/requests/${id}/photos/${p.id}`).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
    photoBox.append(h('figure', { style: 'margin:0' }, img, h('figcaption', { class: 'small muted' }, p.by_resident ? 'The resident\u2019s photo' : `${STAGES.find((s) => s[0] === p.stage)?.[1] || 'Before'} · ${p.uploaded_by || ''}`, h('br'), h('span', { title: p.sha256 }, `Fingerprint ${p.sha256.slice(0, 12)}…`))));
  }
  const note = input({ placeholder: 'Add an internal note', maxlength: 1000, 'aria-label': 'Internal note' });
  const actions = h('div', { class: 'row' },
    open && desk() && !r.work_order ? button('Make work order', () => workOrder(r, redo), { kind: 'primary', small: true }) : null,
    open && desk() && r.work_order && ['done', 'cancelled'].includes(r.work_order.status) ? button('New work order', () => workOrder(r, redo), { small: true }) : null,
    open && !r.made_safe_at ? button('Made safe', () => madeSafe(r, redo), { small: true }) : null,
    open && crewOrManager() ? button('Mark fixed', () => fixed(r, redo), { kind: 'primary', small: true }) : null,
    button('Add photo', () => addPhoto(r, redo), { small: true }),
    open && desk() ? button('Refer', () => refer(r, redo), { small: true }) : null,
    open && desk() ? button('Duplicate', () => duplicate(r, redo), { small: true }) : null,
    open && desk() ? button('Close, no action', () => closeIt(r, redo), { small: true }) : null,
    !open && isManager() ? button('Reopen', () => reopen(r, redo), { small: true }) : null,
    button('Edit', () => edit(r, redo), { small: true }),
    isManager() && ['phone', 'walk_in'].includes(r.source) ? button('Change when we were told', () => toldAt(r, redo), { small: true }) : null);
  const facts = [
    ['Reported', `${fmtDateTime(r.reported_at)} (${r.source_words})`],
    r.assigned_at ? ['Work order made', fmtDateTime(r.assigned_at)] : null,
    r.made_safe_at ? ['Made safe', `${fmtDateTime(r.made_safe_at)}${r.made_safe_note ? `: ${r.made_safe_note}` : ''}`] : null,
    r.fixed_at ? ['Fixed', fmtDateTime(r.fixed_at)] : null,
    r.referred_to ? ['Referred to', `${r.referred_to}, ${fmtDateTime(r.referred_at)}`] : null,
    r.closed_reason ? ['Closed because', r.closed_reason] : null,
    r.duplicate_of ? ['Duplicate of', r.duplicate_of.reference] : null,
    r.duplicates.length ? ['Duplicates', r.duplicates.map((d) => d.reference).join(', ')] : null,
    ['Response standard', `${r.standard.make_safe_hours ? `make safe in ${r.standard.make_safe_hours} hours` : 'no make-safe target'}, ${r.standard.fix_hours ? `fix in ${r.standard.fix_hours} hours` : 'no fix target'}${r.street_class ? ` (${CLASS_WORDS[r.street_class]} street)` : ''}`],
    r.work_order ? ['Work order', `#${r.work_order.id} ${r.work_order.title} (${r.work_order.status.replace('_', ' ')}${r.work_order.assignee ? `, ${r.work_order.assignee}` : ''})`] : null,
  ].filter(Boolean);
  const dlg = dialog(`${r.reference}: ${r.category}`, [
    h('p', null, state(r.status_words, TONE[r.status]), ' ', r.place),
    r.description ? h('p', null, r.description) : null,
    h('p', null, clock(r.make_safe), h('br'), clock(r.fix)),
    h('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    r.public_note ? h('p', null, h('strong', null, 'Note for the resident: '), r.public_note) : null,
    requestChecks(r, redo), // 2026.11.20: what else is open on the block (utility-bits.js)
    r.contact ? h('section', { class: 'panel' }, h('h3', null, 'Resident'), h('p', null, [r.contact.name, r.contact.phone && h('a', { href: `tel:${r.contact.phone.replace(/[^0-9+]/g, '')}` }, r.contact.phone), r.contact.email].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
      h('p', { class: 'muted small' }, `Updates: ${[r.updates_by_text && 'texts', r.updates_by_email && 'emails'].filter(Boolean).join(' and ') || 'none asked for'}.`))
      : r.has_resident ? h('p', { class: 'muted small' }, 'A resident left contact details. Front desk can see them.') : null,
    r.photos.length ? h('section', null, h('h3', null, 'Photos'), photoBox) : null,
    actions,
    h('section', null, h('h3', null, 'Timeline'), h('ul', { class: 'wo-notes' }, r.events.map((e) => h('li', null, h('span', { class: 'muted small' }, `${fmtDateTime(e.at)} ${e.author || ''}`), ' ', e.kind === 'note' ? h('em', null, e.body) : e.body))),
      h('div', { class: 'row' }, note, button('Add note', async () => { if (!note.value.trim()) return; await post(`/requests/${id}/notes`, { body: note.value.trim() }); await redo(); }, { small: true }))),
    r.messages.length ? h('p', { class: 'muted small' }, 'Sent to the resident: ', r.messages.map((m) => `${m.kind} by ${m.channel === 'sms' ? 'text' : 'email'} ${m.ok ? fmtDateTime(m.at) : m.error && /daily limit/.test(m.error) ? `(${m.error})` : '(did not go)'}`).join('; ')) : null,
    h('p', { class: 'small' }, h('a', { href: r.status_link, target: '_blank', rel: 'noopener' }, 'The resident’s status page')),
  ], { wide: true });
}

function workOrder(r, done) {
  formDialog(`Work order for ${r.reference}`, h('div', { class: 'form' },
    field('What needs doing', input({ name: 'title', maxlength: 150, value: `${r.category}: ${r.place}`.slice(0, 150) })),
    field('Priority', select(PRIORITIES, r.priority, { name: 'priority' })),
    META.staff.length ? field('Assign to', select([['', 'Nobody yet'], ...META.staff.map((s) => [s.id, s.name])], '', { name: 'assigned_staff_id' })) : null,
    field('Due', input({ name: 'due_date', type: 'date' })),
    r.has_resident && (r.updates_by_text || r.updates_by_email) ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'tell', checked: true }), ' Tell the resident the work is scheduled') : null), async (fd) => {
    if (!META.work_orders) throw new Error('Work orders need Assets and fleet turned on.');
    await post(`/requests/${r.id}/work-order`, { title: val(fd, 'title'), priority: val(fd, 'priority'), assigned_staff_id: num(fd, 'assigned_staff_id'), due_date: val(fd, 'due_date'), tell_resident: fd.get('tell') === 'on' });
    toast('Work order made'); await done();
  }, { submitText: 'Make work order' });
}

/** A photo file from the phone's camera or files: the bytes as taken, with where the phone was if it can tell quickly. */
function photoField() { return input({ type: 'file', name: 'photo', accept: 'image/*', capture: 'environment' }); }
const position = () => new Promise((ok) => { if (!navigator.geolocation) { ok(null); return; } navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }), () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }); });
async function sendPhoto(id, file, stage) {
  if (!file || !file.size) return;
  const at = await position();
  const qs = new URLSearchParams({ stage, client_ref: ref(), ...(at ? { lat: at.lat.toFixed(6), lng: at.lng.toFixed(6) } : {}) });
  await sendBytes('POST', `/requests/${id}/photos?${qs}`, file);
}

function madeSafe(r, done) {
  formDialog(`Made safe: ${r.reference}`, h('div', { class: 'form' },
    h('p', { class: 'muted' }, 'Coned, barricaded or signed so nobody gets hurt before the repair.'),
    field('When', input({ name: 'at', type: 'datetime-local', value: local16(), required: true })),
    field('What was done', input({ name: 'note', maxlength: 500, placeholder: 'Two cones and a sign' })),
    field('Photo', photoField(), 'Recommended: it is the proof it was made safe.')), async (fd) => {
    await post(`/requests/${r.id}/made-safe`, { at: val(fd, 'at'), note: val(fd, 'note') });
    await sendPhoto(r.id, fd.get('photo'), 'made_safe');
    toast('Marked made safe'); await done();
  }, { submitText: 'Mark made safe' });
}

function fixed(r, done) {
  formDialog(`Fixed: ${r.reference}`, h('div', { class: 'form' },
    field('When', input({ name: 'at', type: 'datetime-local', value: local16(), required: true })),
    field('What was done', h('textarea', { name: 'resolution', rows: 2, required: true, minlength: 3, maxlength: 500 })),
    field('After photo', photoField(), 'Recommended: it is the proof it was fixed.'),
    field('Note for the resident (shown on their status page and in the message)', input({ name: 'public_note', maxlength: 500 })),
    r.work_order && !['done', 'cancelled'].includes(r.work_order.status) ? h('p', { class: 'muted small' }, `This also completes work order #${r.work_order.id}.`) : null), async (fd) => {
    const file = fd.get('photo');
    await post(`/requests/${r.id}/fixed`, { at: val(fd, 'at'), resolution: val(fd, 'resolution'), public_note: val(fd, 'public_note') });
    await sendPhoto(r.id, file, 'after');
    toast('Marked fixed'); await done();
  }, { submitText: 'Mark fixed' });
}

function addPhoto(r, done) {
  formDialog(`Add a photo to ${r.reference}`, h('div', { class: 'form' }, field('Photo', photoField()), field('Which', select(STAGES, r.fixed_at ? 'after' : r.made_safe_at ? 'made_safe' : 'before', { name: 'stage' })),
    h('p', { class: 'muted small' }, 'The photo is kept exactly as taken, with a fingerprint that shows it was never changed.')), async (fd) => {
    if (!fd.get('photo') || !fd.get('photo').size) throw new Error('Choose a photo');
    await sendPhoto(r.id, fd.get('photo'), val(fd, 'stage'));
    toast('Photo added'); await done();
  }, { submitText: 'Add photo' });
}

function refer(r, done) {
  formDialog(`Refer ${r.reference}`, h('div', { class: 'form' },
    field('Passed to', input({ name: 'referred_to', required: true, maxlength: 120, list: 'refer-to', placeholder: 'PennDOT' }), 'The agency or company that looks after it.'),
    h('datalist', { id: 'refer-to' }, ['PennDOT', 'The county', 'The electric company', 'The water company', 'The trash hauler'].map((x) => h('option', { value: x }))),
    field('Internal note', input({ name: 'note', maxlength: 500 })), field('Note for the resident', input({ name: 'public_note', maxlength: 500 }))), async (fd) => {
    await post(`/requests/${r.id}/refer`, { referred_to: val(fd, 'referred_to'), note: val(fd, 'note'), public_note: val(fd, 'public_note') });
    toast('Referred'); await done();
  }, { submitText: 'Refer' });
}

function duplicate(r, done) {
  formDialog(`${r.reference} is a duplicate`, h('div', { class: 'form' }, field('Of request', input({ name: 'of', required: true, maxlength: 12, placeholder: 'R-4821' }), 'The first report of the same problem.'), field('Note', input({ name: 'note', maxlength: 500 }))), async (fd) => {
    await post(`/requests/${r.id}/duplicate`, { of: val(fd, 'of'), note: val(fd, 'note') });
    toast('Marked a duplicate'); await done();
  }, { submitText: 'Mark duplicate' });
}

function closeIt(r, done) {
  formDialog(`Close ${r.reference} with no action`, h('div', { class: 'form' }, field('Why', input({ name: 'reason', required: true, minlength: 3, maxlength: 500, placeholder: 'On private property' })), field('Note for the resident', input({ name: 'public_note', maxlength: 500 }))), async (fd) => {
    await post(`/requests/${r.id}/close`, { reason: val(fd, 'reason'), public_note: val(fd, 'public_note') });
    toast('Closed'); await done();
  }, { submitText: 'Close request' });
}

function reopen(r, done) {
  formDialog(`Reopen ${r.reference}`, h('div', { class: 'form' }, h('p', { class: 'muted' }, 'The times it was fixed or closed stay in its timeline.'), field('Why', input({ name: 'reason', required: true, minlength: 3, maxlength: 500 }))), async (fd) => {
    await post(`/requests/${r.id}/reopen`, { reason: val(fd, 'reason') });
    toast('Reopened'); await done();
  }, { submitText: 'Reopen' });
}

function toldAt(r, done) {
  formDialog('When the municipality was told', h('div', { class: 'form' },
    h('p', { class: 'muted' }, 'For a call or visit taken down later. The first time and the reason stay in the record.'),
    field('Told at', input({ name: 'reported_at', type: 'datetime-local', required: true, value: String(r.reported_at).replace(' ', 'T').slice(0, 16) })),
    field('Why it is different', input({ name: 'reason', required: true, minlength: 3, maxlength: 255, placeholder: 'Voicemail left overnight' }))), async (fd) => {
    await post(`/requests/${r.id}/reported-at`, { reported_at: val(fd, 'reported_at'), reason: val(fd, 'reason') });
    toast('Saved'); await done();
  }, { submitText: 'Save' });
}

function edit(r, done) {
  formDialog(`Edit ${r.reference}`, h('div', { class: 'form' },
    field('Category', select(META.categories.map((c) => [c.id, c.name]), r.category_id, { name: 'category_id' })),
    field('Street', select([['', 'None'], ...META.streets.map((s) => [s.id, s.name])], r.street_id || '', { name: 'street_id' })),
    field('House number', input({ name: 'house_number', maxlength: 20, value: r.house_number || '' })),
    field('Nearest cross street', input({ name: 'cross_street', maxlength: 120, value: r.cross_street || '' })),
    field('Priority', select(PRIORITIES, r.priority, { name: 'priority' })),
    field('Description', h('textarea', { name: 'description', rows: 3, maxlength: 1000 }, r.description || '')),
    field('Note for the resident', input({ name: 'public_note', maxlength: 500, value: r.public_note || '' }))), async (fd) => {
    await patch(`/requests/${r.id}`, { category_id: num(fd, 'category_id'), street_id: num(fd, 'street_id'), house_number: val(fd, 'house_number'), cross_street: val(fd, 'cross_street'), priority: val(fd, 'priority'), description: val(fd, 'description'), public_note: val(fd, 'public_note') });
    toast('Saved'); await done();
  });
}

// ---------------------------------------------------------------- a new request from staff
function newRequest(done) {
  let at = null;
  const where = h('p', { class: 'muted small', role: 'status' });
  const gps = button('Use my location', async () => {
    where.textContent = 'Finding your location…';
    at = await position();
    where.textContent = at ? `Location added (within about ${Math.round(at.acc)} m).` : 'The location was not shared. Pick the street instead.';
  }, { small: true });
  const contact = desk() ? h('fieldset', null, h('legend', null, 'Resident (optional)'),
    field('Name', input({ name: 'name', maxlength: 120 })), field('Phone', input({ name: 'phone', type: 'tel', maxlength: 30 })), field('Email', input({ name: 'email', type: 'email', maxlength: 190 })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'texts_ok' }), ' They want texts about it (they said yes; they can reply STOP)'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'emails_ok' }), ' They want emails about it')) : null;
  const crew = ctx.me && ctx.me.role === 'staff';
  const checks = intakeChecks(); // 2026.11.20: already open on the block, and the caller's earlier requests (utility-bits.js)
  formDialog('New request', h('div', { class: 'form' },
    field('What', select(META.categories.filter((c) => c.active).map((c) => [c.id, c.name]), '', { name: 'category_id', required: true })),
    field('How it came in', select(SOURCES, crew ? 'crew' : 'phone', { name: 'source' })),
    field('Street', select([['', 'Pick the street'], ...META.streets.filter((s) => s.active).map((s) => [s.id, s.name])], '', { name: 'street_id' })),
    field('House number', input({ name: 'house_number', maxlength: 20 })), field('Or the nearest cross street', input({ name: 'cross_street', maxlength: 120 })),
    h('div', { class: 'row' }, gps, where),
    checks,
    field('Description', h('textarea', { name: 'description', rows: 3, maxlength: 1000 })),
    field('Priority', select(PRIORITIES, 'normal', { name: 'priority' })),
    field('Photo', photoField()),
    contact,
    contact ? checks.callerEl : null,
    isManager() ? h('details', null, h('summary', null, 'They told us earlier (a voicemail, a note)'),
      field('Told at', input({ name: 'reported_at', type: 'datetime-local' })), field('Why it is different', input({ name: 'reported_reason', maxlength: 255 }))) : null), async (fd) => {
    const body = {
      category_id: num(fd, 'category_id'), source: val(fd, 'source'), street_id: num(fd, 'street_id'), house_number: val(fd, 'house_number'), cross_street: val(fd, 'cross_street'),
      description: val(fd, 'description'), priority: val(fd, 'priority'), client_ref: ref(), ...(at ? { lat: Number(at.lat.toFixed(6)), lng: Number(at.lng.toFixed(6)), accuracy: Math.round(at.acc) } : {}),
      ...(val(fd, 'reported_at') ? { reported_at: val(fd, 'reported_at'), reported_reason: val(fd, 'reported_reason') } : {}),
      ...(desk() ? { contact: { name: val(fd, 'name'), phone: val(fd, 'phone'), email: val(fd, 'email'), texts_ok: fd.get('texts_ok') === 'on', emails_ok: fd.get('emails_ok') === 'on' } } : {}),
    };
    const out = await post('/requests', body);
    if (!out.repeat) await checks.after(out);
    await sendPhoto(out.id, fd.get('photo'), 'before');
    toast(`Request ${out.reference} saved`);
    if (out.texts_off) toast(out.texts_off, 'error'); // the phone texted STOP: only a texted START turns texts back on
    await done();
  }, { submitText: 'Save request', wide: true });
}

// ---------------------------------------------------------------- the map
async function drawMap(box) {
  const [L, cfg] = await Promise.all([loadLeaflet(), get('/requests/map')]);
  const mapEl = h('div', { class: 'map-box tall', role: 'application', 'aria-label': 'Map of open requests' });
  const color = Object.fromEntries(cfg.categories.map((c) => [c.id, c.color]));
  clear(box).append(h('p', { class: 'muted' }, `Open requests with a position from the phone (${cfg.data.length}). Requests given by street only are in the Open list.`),
    h('ul', { class: 'row', style: 'list-style:none;padding:0' }, cfg.categories.filter((c) => cfg.data.some((r) => r.category_id === c.id)).map((c) => h('li', null, h('span', { style: `display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.color};margin-right:6px` }), c.name))), mapEl);
  const map = makeMap(L, mapEl, cfg, cfg.center || { lat: 39.8283, lng: -98.5795, zoom: 4 }, { remember: 'requests' });
  removeWhenGone(mapEl, map);
  for (const r of cfg.data) {
    const pop = h('div', null, h('strong', null, `${r.reference}: ${r.category}`), h('br'), r.place, h('br'), r.status_words, h('br'), button('Open', () => openRequest(r.id, () => drawMap(box)), { small: true }));
    L.circleMarker([r.lat, r.lng], { radius: 9, color: '#fff', weight: 2, fillColor: color[r.category_id] || '#5b6770', fillOpacity: 0.95 }).bindPopup(pop).addTo(map);
  }
  if (cfg.data.length) fitMap(map, L.latLngBounds(cfg.data.map((r) => [r.lat, r.lng])), { padding: [40, 40], maxZoom: 18 });
}

// ---------------------------------------------------------------- the ledger (the repair record)
async function drawLedger(box) {
  const street = select([['', 'Every street'], ...META.streets.map((s) => [s.id, s.name])], hashParam('street') || '', { 'aria-label': 'Street' });
  const cat = select([['', 'Every category'], ...META.categories.map((c) => [c.id, c.name])], '', { 'aria-label': 'Category' });
  const from = input({ type: 'date', value: addDays(todayStr(), -90), 'aria-label': 'From' });
  const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const contacts = h('input', { type: 'checkbox' });
  const body = h('div');
  const qs = () => new URLSearchParams({ ...(street.value ? { street_id: street.value } : {}), ...(cat.value ? { category_id: cat.value } : {}), ...(from.value ? { from: from.value } : {}), ...(to.value ? { to: to.value } : {}), ...(contacts.checked ? { contacts: '1' } : {}) });
  clear(box).append(
    h('p', { class: 'muted no-print' }, 'Every request in time order: when the municipality was told, when it was made safe and fixed, against the response standard, with each photo’s fingerprint. Requests are public records: exports leave out residents’ names, phones, emails and house numbers.'),
    h('div', { class: 'row req-filters no-print' }, street, cat, from, to,
      isManager() ? h('label', { class: 'check', title: 'Logged with your name' }, contacts, ' Include contact details (logged)') : null,
      button('Download CSV', () => download(`/requests/ledger.csv?${qs()}`, `repair-record-${todayStr()}.csv`), { small: true }),
      button('Print or save as PDF', () => window.print(), { small: true })),
    body);
  async function load() {
    const d = await get(`/requests/ledger?${qs()}`);
    const title = [street.value ? META.streets.find((s) => String(s.id) === street.value).name : 'Every street', cat.value ? META.categories.find((c) => String(c.id) === cat.value).name : null, `${fmtDay(from.value)} to ${fmtDay(to.value)}`].filter(Boolean).join(', ');
    clear(body).append(h('h2', null, `Repair record: ${title}`));
    if (!d.data.length) { body.append(empty('No requests in this range.')); return; }
    body.append(h('h3', null, 'Met the target, by category'), table([
      { head: 'Category', cell: (s) => s.category },
      { head: 'Requests', num: true, cell: (s) => String(s.requests) },
      { head: 'Made safe in time', cell: (s) => (s.safe_pct === null ? 'No target or none done' : `${s.safe_pct}% (${s.safe_met} of ${s.safe_n})`) },
      { head: 'Fixed in time', cell: (s) => (s.fix_pct === null ? 'No target or none done' : `${s.fix_pct}% (${s.fix_met} of ${s.fix_n})`) },
    ], d.summary));
    body.append(h('h3', null, 'Every request'), table([
      { head: 'Request', cell: (r) => h('span', { class: 'stack tight' }, h('strong', null, r.reference), r.category) },
      { head: 'Where', cell: (r) => [r.house_number, r.street, r.cross_street ? `near ${r.cross_street}` : null].filter(Boolean).join(' ') || 'Phone location' },
      { head: 'Told', cell: (r) => fmtDateTime(r.reported_at) },
      { head: 'Made safe', cell: (r) => h('span', { class: 'stack tight' }, r.made_safe_at ? fmtDateTime(r.made_safe_at) : '', clock(r.make_safe)) },
      { head: 'Fixed', cell: (r) => h('span', { class: 'stack tight' }, r.fixed_at ? fmtDateTime(r.fixed_at) : r.status_words, clock(r.fix)) },
      { head: 'Photos', cell: (r) => r.photos.map((p) => `${p.stage} ${p.sha256.slice(0, 10)}`).join(', ') },
      ...(d.data[0].contact !== undefined ? [{ head: 'Resident', cell: (r) => (r.contact ? [r.contact.name, r.contact.phone, r.contact.email].filter(Boolean).join(', ') : '') }] : []),
      { head: '', actions: true, cell: (r) => button('Open', () => openRequest(r.id, load), { small: true, label: `Open ${r.reference}` }) },
    ], d.data));
  }
  for (const el of [street, cat, from, to, contacts]) el.addEventListener('change', () => load().catch((err) => clear(body).append(errorBox(err))));
  await load();
}

// ---------------------------------------------------------------- settings (managers)
async function drawSettings(box) {
  const s = await get('/requests/settings');
  const link = `${location.origin}/report/${encodeURIComponent(ctx.me.tenant)}`;
  const mapLink = `${location.origin}/open-requests/${encodeURIComponent(ctx.me.tenant)}`;
  const page = h('section', { class: 'panel' }, h('h2', null, 'The report page'),
    h('p', null, 'Put this link on the municipality’s website and the QR code on flyers and at the counter. Residents report from their phones; no app or account.'),
    h('p', null, h('a', { href: link, target: '_blank', rel: 'noopener' }, link)), qr(link, { size: 160 }),
    h('div', { class: 'row' }, button('Copy the link', async () => { await navigator.clipboard.writeText(link); toast('Link copied'); }, { small: true }), button('Print the QR code', () => window.print(), { small: true })));

  const general = h('form', { class: 'form panel' }, h('h2', null, 'Numbers, words and the public map'),
    field('Municipal office phone (shown on the report page)', input({ name: 'office_phone', type: 'tel', maxlength: 30, value: s.office_phone || '' })),
    field('After-hours number (shown for the categories marked "after hours")', input({ name: 'after_hours_phone', type: 'tel', maxlength: 30, value: s.after_hours_phone || '' })),
    field('A line at the top of the report page', input({ name: 'intro', maxlength: 500, value: s.intro || '' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'public_map', checked: s.public_map }), ' Show open requests on a public map (no names, no house numbers, places rounded to about 50 m)'),
    s.public_map ? h('p', { class: 'small' }, h('a', { href: mapLink, target: '_blank', rel: 'noopener' }, mapLink)) : null,
    h('fieldset', null, h('legend', null, 'Who hears about new requests (phone alert and Inbox, without the resident’s details)'),
      s.users.map((u) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'alert', value: u.id, checked: s.alert_user_ids.includes(u.id) }), ` ${u.name}`))),
    button('Save', async () => {
      const fd = new FormData(general);
      await put('/requests/settings', { office_phone: val(fd, 'office_phone') || '', after_hours_phone: val(fd, 'after_hours_phone') || '', intro: val(fd, 'intro') || '', public_map: fd.get('public_map') === 'on', alert_user_ids: fd.getAll('alert').map(Number) });
      toast('Saved'); await drawSettings(box);
    }, { kind: 'primary' }));

  const cats = h('section', { class: 'panel' }, h('h2', null, 'Categories'), h('p', { class: 'muted' }, 'What residents can report. "Needs contact" asks for a phone or email; "after hours" shows the after-hours number.'),
    table([
      { head: 'Category', cell: (c) => h('span', null, h('span', { style: `display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.color};margin-right:6px` }), c.name) },
      { head: 'Needs contact', cell: (c) => (c.needs_contact ? 'Yes' : 'No') },
      { head: 'After hours', cell: (c) => (c.after_hours ? 'Yes' : 'No') },
      { head: 'On the page', cell: (c) => (c.active ? 'Yes' : 'Hidden') },
      { head: '', actions: true, cell: (c) => button('Edit', () => category(c), { small: true, label: `Edit ${c.name}` }) },
    ], s.categories), button('Add a category', () => category(null), { small: true }));
  function category(c) {
    formDialog(c ? `Edit ${c.name}` : 'New category', h('div', { class: 'form' },
      field('Name', input({ name: 'name', required: true, maxlength: 60, value: c ? c.name : '' })),
      field('Map color', input({ name: 'color', type: 'color', value: c ? c.color : '#5b6770' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'needs_contact', checked: c ? c.needs_contact : false }), ' Needs a phone or email'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'after_hours', checked: c ? c.after_hours : false }), ' Show the after-hours number'),
      c ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: c.active }), ' On the report page') : null), async (fd) => {
      const body = { name: val(fd, 'name'), color: val(fd, 'color'), needs_contact: fd.get('needs_contact') === 'on', after_hours: fd.get('after_hours') === 'on', ...(c ? { active: fd.get('active') === 'on' } : {}) };
      if (c) await patch(`/requests/categories/${c.id}`, body); else await post('/requests/categories', body);
      toast('Saved'); await meta(true); await drawSettings(box);
    });
  }

  // Response standards: per category, for any street, and optionally by street class. Hours or days.
  const unit = (hrs) => (hrs && hrs >= 48 && hrs % 24 === 0 ? ['days', hrs / 24] : ['hours', hrs || '']);
  const cell = (name, hrs) => { const [u, n] = unit(hrs); return h('span', { class: 'row', style: 'flex-wrap:nowrap' }, input({ name: `${name}_n`, type: 'number', min: 1, max: 8760, step: 1, value: n, style: 'width:5.5em', 'aria-label': name }), select([['hours', 'hours'], ['days', 'days']], u, { name: `${name}_u`, 'aria-label': `${name} unit` })); };
  const rows = [];
  for (const c of s.categories.filter((x) => x.active)) for (const cls of ['any', ...s.classes]) {
    const st = s.standards.find((x) => x.category_id === c.id && x.street_class === cls);
    if (cls !== 'any' && !st) continue;
    rows.push({ c, cls, st });
  }
  const stdForm = h('form', { class: 'form' });
  const draw = () => clear(stdForm).append(table([
    { head: 'Category', cell: (r) => r.c.name },
    { head: 'Streets', cell: (r) => CLASS_WORDS[r.cls] },
    { head: 'Make safe within', cell: (r) => cell(`s-${r.c.id}-${r.cls}`, r.st && r.st.make_safe_hours) },
    { head: 'Fix within', cell: (r) => cell(`f-${r.c.id}-${r.cls}`, r.st && r.st.fix_hours) },
    { head: '', actions: true, cell: (r) => (r.cls === 'any' ? button('By street class', () => { for (const cls of s.classes) if (!rows.some((x) => x.c.id === r.c.id && x.cls === cls)) rows.splice(rows.indexOf(r) + 1, 0, { c: r.c, cls, st: null }); draw(); }, { small: true, label: `Set ${r.c.name} by street class` }) : '') },
  ], rows));
  draw();
  const hoursOf = (fd, name) => { const n = Number(fd.get(`${name}_n`)); if (!n) return null; return fd.get(`${name}_u`) === 'days' ? n * 24 : n; };
  const standards = h('section', { class: 'panel' }, h('h2', null, 'Response standards'),
    h('p', { class: 'muted' }, 'How soon the municipality aims to make each kind of problem safe and to fix it. Each request shows its times against these. Residents never see them as a promise. Leave a box empty for no target. Changes are logged.'),
    stdForm, button('Save standards', async () => {
      const fd = new FormData(stdForm);
      await put('/requests/standards', { standards: rows.map((r) => ({ category_id: r.c.id, street_class: r.cls, make_safe_hours: hoursOf(fd, `s-${r.c.id}-${r.cls}`), fix_hours: hoursOf(fd, `f-${r.c.id}-${r.cls}`) })) });
      toast('Standards saved'); await drawSettings(box);
    }, { kind: 'primary' }));

  const classes = h('form', { class: 'form' }, s.streets.length ? table([
    { head: 'Street', cell: (x) => x.name },
    { head: 'Class', cell: (x) => select(s.classes.map((k) => [k, CLASS_WORDS[k]]), x.street_class, { name: `c-${x.id}`, 'aria-label': `${x.name} class` }) },
  ], s.streets) : empty('No streets yet. Add them in Settings, Streets.'));
  const streets = h('section', { class: 'panel' }, h('h2', null, 'Street classes'), h('p', { class: 'muted' }, 'Local, Collector or Arterial, for standards by street class.'), classes,
    s.streets.length ? button('Save street classes', async () => {
      const fd = new FormData(classes);
      await put('/requests/street-classes', { streets: s.streets.map((x) => ({ id: x.id, street_class: fd.get(`c-${x.id}`) })) });
      toast('Saved'); await meta(true);
    }) : null);
  clear(box).append(page, general, cats, standards, streets);
}
