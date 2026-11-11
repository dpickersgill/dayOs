// Buildings (muni release 1, the `buildings` add-on): the municipality's own buildings and their life-safety calendar.
// The API is /buildings (src/routes/buildings.js); the rules are in src/lib/buildings.js.
//   #/buildings                 tabs: Buildings, Calendar, Vendor visits, Certificates, Deficiencies, Checks (the library)
//   #/buildings/b/12            one building: equipment by room, its year, certificates, files, deficiencies, rounds
//   #/buildings/round/7         a staff round on a phone: scan or tap each item, pass with one tap, fail with a photo
//   #/buildings/binder?building=12&from=2026-01-01&to=2026-12-31   the printable binder (Print, or Save as PDF)
// Everyone signed in may look; the crew and managers record; managers set up buildings, checks and certificates.
import { get, post, patch, uploadFile, sendBytes, openFile, download, fetchBlob } from '../api.js';
import { h, clear, ctx, isManager, table, state, tabs, input, select, field, button, toast, fail, formDialog, dialog, confirmDialog, val, num, todayStr, addDays, fmtDay, empty, errorBox, loading, hashParam } from '../ui.js';
import { cameraSupported, scanWithCamera } from '../readers.js';

const STATE = { overdue: ['Overdue', 'bad'], never: ['No record yet', 'warn'], week: ['Due this week', 'warn'], month: ['Due this month', 'neutral'], ok: ['On track', 'good'] };
const CERT = { expired: ['Expired', 'bad'], soon: ['Runs out within 30 days', 'warn'], watch: ['Runs out within 60 days', 'neutral'], ok: ['Current', 'good'] };
const RESULT = { pass: ['Passed', 'good'], fail: ['Failed', 'bad'], missing: ['Missing', 'bad'], skipped: ['Not checked', 'neutral'], na: ['Not applicable', 'neutral'] };
const CELL = { done: ['Done', '✓'], late: ['Done late', 'L'], missed: ['Missed', '✗'], overdue: ['Overdue', '!'], due: ['Due', '·'], none: ['', ''] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WO_TEXT = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting for parts', done: 'Fixed', cancelled: 'Canceled' };

const canRecord = () => ctx.me && ctx.me.role !== 'counter';
const chip = (map, key) => (map[key] ? state(map[key][0], map[key][1]) : null);
const back = (href, text) => h('p', { class: 'back no-print' }, h('a', { href }, `‹ ${text}`));
const where = (p) => [p.building, p.room].filter(Boolean).join(', ');
const tagText = (tag) => (tag ? ` (${tag})` : '');
let metaCache = null;
const meta = async () => { metaCache = metaCache || await get('/buildings/meta'); return metaCache; };

export async function render(root, params = []) {
  metaCache = null;
  if (params[0] === 'b' && /^\d+$/.test(params[1] || '')) return renderBuilding(root, Number(params[1]));
  if (params[0] === 'round' && /^\d+$/.test(params[1] || '')) return renderRound(root, Number(params[1]));
  if (params[0] === 'binder') return renderBinder(root);
  const m = await meta();
  root.append(h('div', { class: 'page-head' },
    h('div', null, h('h1', null, 'Buildings'), h('p', { class: 'page-note' }, 'Life-safety checks for the municipality’s own buildings: who checks what and when, vendor visits and certificates, and the binder for the insurer or the fire marshal.')),
    h('div', { class: 'actions' },
      canRecord() ? button('Record a vendor visit', () => visitDialog(null, () => location.reload()), { small: true }) : null,
      h('a', { class: 'btn small', href: '#/buildings/binder' }, 'The binder'),
      m.can_manage ? button('Add a building', () => buildingDialog(m, null, (out) => { location.hash = `#/buildings/b/${out.id}`; }), { kind: 'primary', small: true }) : null)));
  const items = [['list', 'Buildings', drawList], ['calendar', 'Calendar', drawCalendar], ['visits', 'Vendor visits', drawVisits], ['certificates', 'Certificates', drawCerts], ['deficiencies', 'Deficiencies', drawDefs], ['checks', 'Checks', drawLibrary]];
  const want = hashParam('tab');
  root.append(tabs(items, items.some((i) => i[0] === want) ? want : 'list'));
}

// ---------------------------------------------------------------- buildings
async function drawList(box) {
  const { data } = await get('/buildings');
  if (!data.length) { clear(box).append(empty(isManager() ? 'No buildings yet. Add the borough hall first, then the rest.' : 'No buildings yet. A manager adds them.')); return; }
  clear(box).append(table([
    { head: 'Building', cell: (b) => h('div', { class: 'stack tight' }, h('a', { href: `#/buildings/b/${b.id}` }, h('b', null, b.name)), h('span', { class: 'muted small' }, [b.type_label, b.full_address].filter(Boolean).join(' · '))) },
    { head: 'Items', num: true, cell: (b) => String(b.equipment) },
    { head: 'Checks', cell: (b) => h('div', { class: 'row' }, b.overdue ? state(`${b.overdue} overdue`, 'bad') : null, b.never ? state(`${b.never} no record`, 'warn') : null, b.due_week ? state(`${b.due_week} due this week`, 'warn') : null, !b.overdue && !b.never && !b.due_week ? state('Up to date', 'good') : null) },
    { head: 'Open deficiencies', num: true, cell: (b) => (b.open_deficiencies ? state(String(b.open_deficiencies), 'bad') : '0') },
    { head: 'Next certificate', cell: (b) => (b.next_certificate ? h('span', null, chip(CERT, b.next_certificate.state), ` ${b.next_certificate.asset}, ${fmtDay(b.next_certificate.expires_on)}`) : h('span', { class: 'muted' }, 'None on file')) },
  ], data));
}

function buildingDialog(m, b, done) {
  const f = {
    name: input({ name: 'name', required: true, maxlength: 80, value: b ? b.name : '' }),
    type: select(m.types.map((t) => [t.value, t.label]), b ? b.type : 'office', { name: 'type' }),
    street: select([['', m.streets.length ? 'Not on the street list' : 'No street list yet'], ...m.streets.map((s) => [s.id, s.name])], b ? b.street_id || '' : '', { name: 'street_id' }),
    house: input({ name: 'house_number', maxlength: 20, value: b ? b.house_number || '' : '' }),
    address: input({ name: 'address', maxlength: 150, value: b ? b.address || '' : '', placeholder: 'For a place not on the street list, such as a park' }),
    year: input({ name: 'year_built', type: 'number', min: 1700, max: 2100, value: b ? b.year_built || '' : '' }),
    sqft: input({ name: 'square_feet', type: 'number', min: 1, value: b ? b.square_feet || '' : '' }),
    rooms: h('textarea', { name: 'rooms', rows: 4, placeholder: 'Lobby\nBoiler room\nCouncil chambers' }),
    notes: h('textarea', { name: 'notes', rows: 2, maxlength: 500 }, b ? b.notes || '' : ''),
  };
  formDialog(b ? 'Edit building' : 'Add a building', h('div', { class: 'stack' },
    field('Name', f.name, 'As staff say it, such as "Borough Hall" or "Public Works Garage".'), field('Type', f.type),
    h('div', { class: 'row' }, field('House number', f.house), field('Street', f.street)), field('Address (if not on the street list)', f.address),
    h('div', { class: 'row' }, field('Year built', f.year), field('Square feet', f.sqft)),
    b ? null : field('Rooms and areas', f.rooms, 'One on each line. Equipment is placed in a room; you can add rooms later.'),
    field('Notes', f.notes)), async (fd) => {
    const body = { name: val(fd, 'name'), type: val(fd, 'type'), street_id: num(fd, 'street_id'), house_number: val(fd, 'house_number'), address: val(fd, 'address'), year_built: num(fd, 'year_built'), square_feet: num(fd, 'square_feet'), notes: val(fd, 'notes') };
    if (!b) body.rooms = String(fd.get('rooms') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const out = b ? await patch(`/buildings/${b.id}`, body) : await post('/buildings', body);
    toast(b ? 'Building saved' : 'Building added');
    done(out);
  }, { submitText: b ? 'Save' : 'Add building' });
}

// ---------------------------------------------------------------- calendar
async function drawCalendar(box) {
  const m = await meta();
  const list = await get('/buildings');
  const bSel = select([['', 'Every building'], ...list.data.map((b) => [b.id, b.name])], hashParam('building') || '', { 'aria-label': 'Building' });
  const vSel = select([['', 'Every vendor'], ...m.vendors.map((v) => [v.id, v.name])], '', { 'aria-label': 'Vendor' });
  const wSel = select([['', 'Staff and vendors'], ['staff', 'Staff checks'], ['vendor', 'Vendor checks']], '', { 'aria-label': 'Who does it' });
  const gSel = select([['when', 'Group by when it is due'], ['building', 'Group by building'], ['vendor', 'Group by vendor']], 'when', { 'aria-label': 'Group by' });
  const body = h('div', { class: 'stack' }, loading());
  clear(box).append(h('div', { class: 'week-filter', role: 'group', 'aria-label': 'Filters' }, bSel, vSel, wSel, gSel), body);
  const row = (p) => h('li', { class: 'bld-cal-row' },
    chip(STATE, p.state),
    h('div', { class: 'stack tight' },
      h('span', null, h('b', null, p.task), ' · ', h('a', { href: `#/assets/a/${p.asset_id}` }, `${p.asset}${tagText(p.asset_tag)}`)),
      h('span', { class: 'muted small' }, [where(p), p.every, p.who === 'vendor' ? (p.vendor || 'Vendor') : 'Staff', p.standard].filter(Boolean).join(' · '))),
    h('span', { class: 'small' }, p.due_on ? `Due ${fmtDay(p.due_on)}` : 'No record yet', p.last_done_on ? h('span', { class: 'muted' }, ` (last ${fmtDay(p.last_done_on)})`) : null));
  async function load() {
    const qs = new URLSearchParams();
    if (bSel.value) qs.set('building_id', bSel.value);
    if (vSel.value) qs.set('vendor_id', vSel.value);
    if (wSel.value) qs.set('who', wSel.value);
    const c = await get(`/buildings/calendar?${qs}`);
    clear(body);
    body.append(h('div', { class: 'stats' }, ...[['overdue', 'overdue'], ['never', 'with no record yet'], ['week', 'due this week'], ['month', 'due this month']].map(([k, t]) => h('div', { class: `stat ${c.counts[k] && k !== 'month' ? (k === 'overdue' ? 'bad' : 'warn') : ''}`.trim() }, h('strong', null, String(c.counts[k])), h('span', null, t)))));
    if (!c.plans.length) { body.append(empty('No checks yet. Add equipment to a building and its checks appear here.')); return; }
    const groups = [];
    if (gSel.value === 'when') {
      for (const [k, title] of [['overdue', 'Overdue'], ['never', 'No record yet'], ['week', 'Due this week'], ['month', 'Due this month']]) groups.push([title, c.plans.filter((p) => p.state === k), true]);
      groups.push(['Later', c.plans.filter((p) => p.state === 'ok'), false]);
    } else {
      const keyOf = (p) => (gSel.value === 'building' ? p.building : p.who === 'vendor' ? (p.vendor || 'Vendor not chosen') : 'Staff');
      for (const k of [...new Set(c.plans.map(keyOf))].sort()) groups.push([k, c.plans.filter((p) => keyOf(p) === k).filter((p) => p.state !== 'ok'), true]);
    }
    for (const [title, rows, open] of groups) {
      if (!rows.length) continue;
      const list = h('ul', { class: 'plain rows bld-cal' }, rows.map(row));
      body.append(open ? h('section', { class: 'panel stack' }, h('h2', null, `${title} (${rows.length})`), list) : h('details', { class: 'panel' }, h('summary', null, `${title} (${rows.length})`), list));
    }
    if (c.certificates.some((x) => x.state !== 'ok')) body.append(h('section', { class: 'panel stack' }, h('h2', null, 'Certificates'), certTable(c.certificates.filter((x) => x.state !== 'ok'))));
  }
  for (const s of [bSel, vSel, wSel, gSel]) s.addEventListener('change', () => load().catch(fail));
  await load();
}

// ---------------------------------------------------------------- vendor visits
async function drawVisits(box) {
  const { data } = await get('/buildings/visits');
  clear(box).append(h('div', { class: 'stack' },
    canRecord() ? h('div', { class: 'row' }, button('Record a vendor visit', () => visitDialog(null, () => drawVisits(box)), { kind: 'primary', small: true })) : null,
    data.length ? table([
      { head: 'Date', cell: (v) => fmtDay(v.visit_on) },
      { head: 'Vendor', cell: (v) => h('span', null, v.vendor, v.technician ? h('span', { class: 'muted small' }, ` (${v.technician})`) : null) },
      { head: 'Buildings', cell: (v) => v.buildings.map((b) => b.name).join(', ') },
      { head: 'Items', cell: (v) => h('span', null, `${v.items}`, v.failed ? state(` ${v.failed} failed`, 'bad') : null) },
      { head: 'Report', cell: (v) => (v.document_id ? button('Open', () => openFile(`/buildings/documents/${v.document_id}/file`), { small: true, label: `Open the report from ${v.vendor}` }) : canRecord() ? button('Attach', () => attachVisitFile(v.id, () => drawVisits(box)), { small: true }) : h('span', { class: 'muted' }, 'None')) },
      { head: '', actions: true, cell: (v) => button('Details', () => visitDetails(v.id), { small: true, label: `Details of the visit on ${v.visit_on}` }) },
    ], data) : empty('No vendor visits recorded yet.')));
}

function pickFile(accept, capture) {
  return new Promise((resolve) => {
    const el = h('input', { type: 'file', accept, ...(capture ? { capture: 'environment' } : {}) });
    el.addEventListener('change', () => resolve(el.files[0] || null));
    el.click();
  });
}
async function attachVisitFile(id, done) {
  const file = await pickFile('.pdf,.png,.jpg,.jpeg,.docx,.doc,.xlsx');
  if (!file) return;
  try { await uploadFile(`/buildings/visits/${id}/file`, file); toast('Report filed in Documents'); done(); } catch (err) { fail(err); }
}

async function visitDetails(id) {
  const v = await get(`/buildings/visits/${id}`);
  dialog(`${v.vendor}, ${fmtDay(v.visit_on)}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, [v.technician, v.buildings.map((b) => b.name).join(', ')].filter(Boolean).join(' · ')), v.notes ? h('p', null, v.notes) : null,
    table([
      { head: 'Item', cell: (l) => h('a', { href: `#/assets/a/${l.asset_id}` }, `${l.asset}${tagText(l.asset_tag)}`) },
      { head: 'Check', cell: (l) => l.task_name },
      { head: 'Result', cell: (l) => h('span', null, chip(RESULT, l.result), l.note ? h('span', { class: 'muted small' }, ` ${l.note}`) : null) },
      { head: 'Work order', cell: (l) => (l.work_order_id ? h('a', { href: `#/works/${l.work_order_id}` }, WO_TEXT[l.work_order_status] || 'Open') : '') },
    ], v.lines),
    v.certificates.length ? h('p', null, h('b', null, 'Certificates: '), v.certificates.map((c) => `${c.asset}, ${c.name.toLowerCase()} until ${fmtDay(c.expires_on)}`).join('; ')) : null,
    v.deficiencies.length ? h('p', null, h('b', null, 'Findings: '), v.deficiencies.map((d) => d.description).join('; ')) : null,
    v.document_id ? button('Open the report', () => openFile(`/buildings/documents/${v.document_id}/file`)) : null), { wide: true });
}

/**
 * Record a vendor visit: the vendor and date, then every item the visit covered (picked from the calendar, many at once),
 * the result of each, a new certificate date where the check renews one, and the vendor's findings. The report is
 * attached at the end.
 */
async function visitDialog(buildingId, done) {
  const m = await meta();
  if (!m.vendors.length) { toast(isManager() ? 'Add the vendor first: Assets and fleet, Purchasing, Vendors.' : 'Ask a manager to add the vendor first.', 'error'); return; }
  const cal = await get(`/buildings/calendar${buildingId ? `?building_id=${buildingId}` : ''}`);
  const buildings = [...new Map(cal.plans.map((p) => [p.building_id, p.building])).entries()];
  const vSel = select(m.vendors.map((v) => [v.id, v.name]), m.vendors[0].id, { name: 'vendor_id', 'aria-label': 'Vendor' });
  const date = input({ type: 'date', name: 'visit_on', value: todayStr(), max: todayStr(), required: true });
  const tech = input({ name: 'technician', maxlength: 100, placeholder: 'Name and certification number' });
  const notes = h('textarea', { name: 'notes', rows: 2, maxlength: 1000 });
  const bFilter = select([['', 'Every building'], ...buildings], buildingId || '', { 'aria-label': 'Building' });
  const staffToo = h('input', { type: 'checkbox' });
  const picked = new Map(); // plan id -> { box, result, note, cert, num }
  const list = h('div', { class: 'stack tight bld-pick' });
  const findings = h('textarea', { rows: 3, placeholder: 'One finding on each line. Each becomes a work order.' });
  const fileIn = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.docx,.doc,.xlsx' });
  function line(p) {
    if (!picked.has(p.plan_id)) {
      const result = select([['pass', 'Passed'], ['fail', 'Failed'], ['na', 'Not done this visit']], 'pass', { 'aria-label': `Result for ${p.asset}` });
      const note = input({ maxlength: 500, placeholder: 'What the vendor found', 'aria-label': `Note for ${p.asset}` });
      const cert = p.certificate ? input({ type: 'date', 'aria-label': `New certificate expires, ${p.asset}` }) : null;
      const no = p.certificate ? input({ maxlength: 60, placeholder: 'Certificate number', 'aria-label': `Certificate number, ${p.asset}` }) : null;
      const box = h('input', { type: 'checkbox', 'aria-label': `${p.task}, ${p.asset}` });
      const extra = h('div', { class: 'row bld-pick-extra', hidden: true }, result, note, cert ? field('New certificate expires', cert) : null, no);
      box.addEventListener('change', () => { extra.hidden = !box.checked; });
      picked.set(p.plan_id, { box, result, note, cert, no, extra });
    }
    const x = picked.get(p.plan_id);
    return h('div', { class: 'bld-pick-row' }, h('label', { class: 'check' }, x.box, h('span', null, h('b', null, p.task), ` · ${p.asset}${tagText(p.asset_tag)}`, h('span', { class: 'muted small' }, ` ${where(p)} · `, chip(STATE, p.state)))), x.extra);
  }
  function draw() {
    const rows = cal.plans.filter((p) => (staffToo.checked || p.who === 'vendor') && (!bFilter.value || String(p.building_id) === bFilter.value));
    clear(list).append(rows.length ? rows.map(line) : h('p', { class: 'muted' }, 'No vendor checks here. Tick "Show staff checks too" if the vendor did one of those.'));
  }
  bFilter.addEventListener('change', draw); staffToo.addEventListener('change', draw);
  draw();
  formDialog('Record a vendor visit', h('div', { class: 'stack' },
    h('div', { class: 'row' }, field('Vendor', vSel), field('Date of the visit', date)), field('Technician', tech), field('Notes', notes),
    h('h3', null, 'What the visit covered'), h('div', { class: 'row' }, bFilter, h('label', { class: 'check' }, staffToo, ' Show staff checks too')), list,
    field('Findings', findings, 'Things the vendor found that are not a failed item, such as a blocked exit. Each opens a work order.'),
    field('Report or certificate (optional)', fileIn, 'A PDF or a photo of the paper. It is filed in Documents under each building.')), async (fd) => {
    const items = [...picked.entries()].filter(([, x]) => x.box.checked).map(([plan, x]) => ({
      plan_id: plan, result: x.result.value, note: x.note.value.trim() || null,
      ...(x.cert && x.cert.value ? { certificate: { expires_on: x.cert.value, number: x.no.value.trim() || null } } : {}),
    }));
    if (!items.length) throw new Error('Tick at least one item the visit covered');
    const first = cal.plans.find((p) => p.plan_id === items[0].plan_id);
    const defs = findings.value.split('\n').map((x) => x.trim()).filter((x) => x.length >= 3).map((description) => ({ description, building_id: Number(bFilter.value) || first.building_id }));
    const out = await post('/buildings/visits', { vendor_id: Number(vSel.value), visit_on: val(fd, 'visit_on'), technician: val(fd, 'technician'), notes: val(fd, 'notes'), items, deficiencies: defs });
    if (fileIn.files[0]) await uploadFile(`/buildings/visits/${out.id}/file`, fileIn.files[0]);
    toast(out.work_orders.length ? `Visit recorded. ${out.work_orders.length} work order${out.work_orders.length === 1 ? '' : 's'} opened.` : 'Visit recorded');
    done(out);
  }, { submitText: 'Save visit', wide: true });
}

// ---------------------------------------------------------------- certificates
function certTable(list) {
  return table([
    { head: 'Status', cell: (c) => chip(CERT, c.state) },
    { head: 'Certificate', cell: (c) => h('span', null, c.name, c.number ? h('span', { class: 'muted small' }, ` No. ${c.number}`) : null) },
    { head: 'Item', cell: (c) => h('a', { href: `#/assets/a/${c.asset_id}` }, `${c.asset}${tagText(c.asset_tag)}`) },
    { head: 'Building', cell: (c) => c.building },
    { head: 'Expires', cell: (c) => fmtDay(c.expires_on) },
    { head: 'File', cell: (c) => (c.document_id ? button('Open', () => openFile(`/buildings/documents/${c.document_id}/file`), { small: true, label: `Open the ${c.name} for ${c.asset}` }) : canRecord() ? button('Attach', async () => {
      const file = await pickFile('.pdf,.png,.jpg,.jpeg');
      if (file) { await uploadFile(`/buildings/certificates/${c.id}/file`, file); toast('Certificate filed in Documents'); }
    }, { small: true }) : '') },
  ], list);
}
async function drawCerts(box) {
  const { data } = await get('/buildings/certificates');
  clear(box).append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Certificates of operation (elevators, boilers) with their expiry dates. Managers get a reminder in the Inbox and on their phones 60, 30 and 7 days before one runs out.'),
    isManager() ? h('div', { class: 'row' }, button('Add a certificate', () => certDialog(() => drawCerts(box)), { kind: 'primary', small: true })) : null,
    data.length ? certTable(data) : empty('No certificates on file yet. A vendor visit for an elevator or boiler inspection adds one.')));
}
async function certDialog(done) {
  const cal = await get('/buildings/calendar');
  const items = [...new Map(cal.plans.map((p) => [p.asset_id, `${p.asset}${tagText(p.asset_tag)}, ${p.building}`])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  formDialog('Add a certificate', h('div', { class: 'stack' },
    field('Item', select(items, '', { name: 'asset_id', required: true })),
    field('Certificate', input({ name: 'name', value: 'Certificate of operation', required: true, maxlength: 80 })),
    field('Number', input({ name: 'number', maxlength: 60 })),
    h('div', { class: 'row' }, field('Issued', input({ type: 'date', name: 'issued_on' })), field('Expires', input({ type: 'date', name: 'expires_on', required: true })))), async (fd) => {
    await post('/buildings/certificates', { asset_id: num(fd, 'asset_id'), name: val(fd, 'name'), number: val(fd, 'number'), issued_on: val(fd, 'issued_on'), expires_on: val(fd, 'expires_on') });
    toast('Certificate added'); done();
  }, { submitText: 'Add certificate' });
}

// ---------------------------------------------------------------- deficiencies
function defTable(list) {
  return table([
    { head: 'Found', cell: (d) => fmtDay(d.found_on) },
    { head: 'What', cell: (d) => h('div', { class: 'stack tight' }, h('span', null, d.description), h('span', { class: 'muted small' }, [d.building, d.asset ? `${d.asset}${tagText(d.asset_tag)}` : null, d.vendor ? `found by ${d.vendor}` : d.source === 'round' ? 'found on a round' : null].filter(Boolean).join(' · '))) },
    { head: 'Status', cell: (d) => (d.open ? state(WO_TEXT[d.work_order_status] || 'Open', 'bad') : d.fixed_on ? state(`Fixed ${fmtDay(d.fixed_on)}`, 'good') : state('Closed', 'neutral')) },
    { head: 'Work order', cell: (d) => (d.work_order_id && d.work_order_status ? h('a', { href: `#/works/${d.work_order_id}` }, 'Open it') : '') },
  ], list);
}
async function drawDefs(box) {
  const st = select([['open', 'Open'], ['closed', 'Fixed or closed'], ['all', 'All']], 'open', { 'aria-label': 'Which' });
  const body = h('div');
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, st, canRecord() ? button('Report a deficiency', () => defDialog(null, () => load()), { small: true }) : null), body));
  async function load() { const { data } = await get(`/buildings/deficiencies?status=${st.value}`); clear(body).append(data.length ? defTable(data) : empty(st.value === 'open' ? 'Nothing open. Every deficiency found has been fixed.' : 'None yet.')); }
  st.addEventListener('change', () => load().catch(fail));
  await load();
}
async function defDialog(building, done) {
  const list = building ? null : (await get('/buildings')).data;
  formDialog('Report a deficiency', h('div', { class: 'stack' },
    building ? null : field('Building', select(list.map((b) => [b.id, b.name]), '', { name: 'building_id', required: true })),
    building ? field('Item (optional)', select([['', 'The building itself'], ...building.equipment.map((e) => [e.id, `${e.name}${tagText(e.asset_tag)}`])], '', { name: 'asset_id' })) : null,
    field('What is wrong', h('textarea', { name: 'description', rows: 3, required: true, minlength: 3, maxlength: 500 })),
    field('Priority', select([['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent'], ['low', 'Low']], 'high', { name: 'priority' }))), async (fd) => {
    await post('/buildings/deficiencies', { building_id: building ? building.id : num(fd, 'building_id'), asset_id: num(fd, 'asset_id'), description: val(fd, 'description'), priority: val(fd, 'priority') });
    toast('Work order opened'); done();
  }, { submitText: 'Open work order' });
}

// ---------------------------------------------------------------- the library of checks
async function drawLibrary(box) {
  const m = await meta();
  const { data } = await get('/buildings/library');
  clear(box).append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'The recurring checks. Each applies to every item of its kind in every building, as a service plan that also shows on Work orders. The standard is a reference for the reader, not the standard’s text.'),
    m.can_manage ? h('div', { class: 'row' }, button('Add a check', () => taskDialog(m, null, () => drawLibrary(box)), { kind: 'primary', small: true })) : null,
    table([
      { head: 'Check', cell: (t) => h('div', { class: 'stack tight' }, h('b', null, t.name), h('span', { class: 'muted small' }, [t.kind_label, t.standard].filter(Boolean).join(' · '))) },
      { head: 'Who', cell: (t) => (t.who === 'vendor' ? (t.vendor || 'Vendor') : 'Staff') },
      { head: 'How often', cell: (t) => t.every },
      { head: 'Items', num: true, cell: (t) => String(t.plans) },
      { head: 'Status', cell: (t) => (t.active ? state('In use', 'good') : state('Turned off', 'neutral')) },
      { head: '', actions: true, cell: (t) => button(m.can_manage ? 'Edit' : 'View', () => taskDialog(m, t, () => drawLibrary(box)), { small: true, label: `${m.can_manage ? 'Edit' : 'View'} ${t.name}` }) },
    ], data)));
}
const slug = (s, used) => { let k = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'item'; const b = k; let n = 2; while (used.has(k)) k = `${b}_${n++}`.slice(0, 30); used.add(k); return k; };
function taskDialog(m, t, done) {
  const freq = select([...m.frequencies.map((f) => [f.days, f.label]), ['other', 'Another number of days']], t ? (m.frequencies.some((f) => f.days === t.interval_days) ? t.interval_days : 'other') : 31, { name: 'freq' });
  const days = input({ type: 'number', name: 'days', min: 1, max: 3650, value: t ? t.interval_days : 31 });
  const dayField = field('Every this many days', days); dayField.hidden = freq.value !== 'other';
  freq.addEventListener('change', () => { dayField.hidden = freq.value !== 'other'; });
  const items = h('textarea', { name: 'items', rows: 8, required: true }, t ? t.items.map((i) => i.label).join('\n') : '');
  const readOnly = !m.can_manage;
  formDialog(t ? (readOnly ? t.name : 'Edit check') : 'Add a check', h('div', { class: 'stack' },
    field('Name', input({ name: 'name', required: true, minlength: 3, maxlength: 120, value: t ? t.name : '', disabled: readOnly })),
    t ? h('p', { class: 'muted' }, `For: ${t.kind_label}`) : field('For which kind of item', select(m.equipment_kinds.map((k) => [k.value, k.label]), 'fire_extinguisher', { name: 'kind' })),
    h('div', { class: 'row' }, field('Who does it', select([['staff', 'Staff'], ['vendor', 'A vendor']], t ? t.who : 'staff', { name: 'who', disabled: readOnly })), field('How often', freq), dayField),
    field('Vendor', select([['', 'Not chosen'], ...m.vendors.map((v) => [v.id, v.name])], t ? t.vendor_id || '' : '', { name: 'vendor_id', disabled: readOnly })),
    field('Standard', input({ name: 'standard', maxlength: 120, value: t ? t.standard || '' : '', placeholder: 'For example NFPA 10', disabled: readOnly }), 'A reference line shown with the check. Never paste a standard’s text.'),
    field('Renews a certificate', input({ name: 'certificate', maxlength: 80, value: t ? t.certificate || '' : '', placeholder: 'For example Certificate of operation', disabled: readOnly })),
    field('Checklist', items, 'One item on each line, as the person doing the check reads it. Readings and dates already on the list keep their rules.'),
    t ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: t.active, disabled: readOnly }), ' In use (turn off to pause it everywhere)') : null), async (fd) => {
    if (readOnly) return;
    const used = new Set();
    const old = new Map((t ? t.items : []).map((i) => [i.label, i]));
    const lines = String(fd.get('items') || '').split('\n').map((x) => x.trim()).filter(Boolean);
    const steps = lines.map((label) => { const was = old.get(label); if (was) { used.add(was.key); return was; } return null; })
      .map((s, i) => s || { key: slug(lines[i], used), label: lines[i], type: 'pass' });
    const body = { name: val(fd, 'name'), who: val(fd, 'who'), interval_days: freq.value === 'other' ? Number(days.value) : Number(freq.value), vendor_id: num(fd, 'vendor_id'), standard: val(fd, 'standard') || '', certificate: val(fd, 'certificate') || '', items: steps };
    if (t) await patch(`/buildings/library/${t.id}`, { ...body, active: fd.get('active') === 'on' });
    else await post('/buildings/library', { ...body, kind: val(fd, 'kind') });
    toast('Check saved'); done();
  }, { submitText: readOnly ? 'Close' : 'Save' });
}

// ---------------------------------------------------------------- one building
async function renderBuilding(root, id) {
  let b;
  try { b = await get(`/buildings/${id}`); } catch (err) { root.append(back('#/buildings', 'Buildings'), errorBox(err)); return; }
  const m = await meta();
  const reload = () => { clear(root); renderBuilding(root, id); };
  root.append(back('#/buildings', 'Buildings'), h('div', { class: 'page-head' },
    h('div', null, h('h1', null, b.name), h('p', { class: 'page-note' }, [b.type_label, b.full_address, b.year_built ? `built ${b.year_built}` : null, b.square_feet ? `${Number(b.square_feet).toLocaleString('en-US')} sq ft` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'actions' },
      canRecord() ? button('Start a round', async () => {
        try { const r = await post(`/buildings/${id}/rounds`, {}); location.hash = `#/buildings/round/${r.id}`; } catch (err) {
          if (err.status === 400) roundPicker(b); else throw err;
        }
      }, { kind: 'primary', small: true }) : null,
      canRecord() ? button('Record a vendor visit', () => visitDialog(id, reload), { small: true }) : null,
      h('a', { class: 'btn small', href: `#/buildings/binder?building=${id}` }, 'Binder'),
      m.can_manage ? button('Edit', () => buildingDialog(m, b, reload), { small: true }) : null)));
  root.append(tabs([
    ['equipment', 'Items', (box) => drawEquipment(box, b, m, reload)],
    ['year', 'Year', (box) => drawYear(box, b)],
    ['certificates', 'Certificates', (box) => { clear(box).append(b.certificates.length ? certTable(b.certificates) : empty('No certificates on file for this building.')); }],
    ['files', 'Files', (box) => drawFiles(box, b, reload)],
    ['deficiencies', 'Deficiencies', (box) => { clear(box).append(h('div', { class: 'stack' }, canRecord() ? h('div', { class: 'row' }, button('Report a deficiency', () => defDialog(b, reload), { small: true })) : null, b.deficiencies.length ? defTable(b.deficiencies) : empty('Nothing open in this building.'))); }],
    ['history', 'History', (box) => drawHistory(box, b)],
  ], 'equipment'));
}

function roundPicker(b) {
  const tasks = [...new Map(b.plans.filter((p) => p.who === 'staff').map((p) => [p.task_id, p.task])).entries()];
  if (!tasks.length) { toast('This building has no staff checks. Add extinguishers, exit lights or other items first.', 'error'); return; }
  const boxes = tasks.map(([tid, name]) => [tid, h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'task', value: tid }), ` ${name}`)]);
  formDialog('Pick the checks for this round', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Nothing is due this week. Pick the checks to do anyway.'), ...boxes.map((x) => x[1])), async (fd) => {
    const ids = fd.getAll('task').map(Number);
    if (!ids.length) throw new Error('Pick at least one check');
    const r = await post(`/buildings/${b.id}/rounds`, { task_ids: ids });
    location.hash = `#/buildings/round/${r.id}`;
  }, { submitText: 'Start the round' });
}

function drawEquipment(box, b, m, reload) {
  const byRoom = new Map([[null, []], ...b.rooms.map((r) => [r.name, []])]);
  for (const e of b.equipment) { if (!byRoom.has(e.room)) byRoom.set(e.room, []); byRoom.get(e.room).push(e); }
  const tools = h('div', { class: 'row' },
    canRecord() ? button('Add items', () => equipmentDialog(b, m, reload), { kind: 'primary', small: true }) : null,
    m.can_manage ? button('Add a room', () => formDialog('Add a room or area', field('Name', input({ name: 'name', required: true, maxlength: 60 })), async (fd) => { await post(`/buildings/${b.id}/rooms`, { name: val(fd, 'name') }); toast('Room added'); reload(); }, { submitText: 'Add room' }), { small: true }) : null,
    b.equipment.length ? h('a', { class: 'btn small', href: `#/assets/labels/${b.equipment.map((e) => e.id).join(',')}` }, 'Print QR tags') : null);
  const sections = [...byRoom.entries()].filter(([, list]) => list.length).map(([room, list]) => h('section', { class: 'panel stack' }, h('h2', null, room || 'Whole building'),
    h('ul', { class: 'plain rows' }, list.map((e) => h('li', { class: 'stack tight' },
      h('span', null, h('a', { href: `#/assets/a/${e.id}` }, h('b', null, e.name)), h('span', { class: 'muted small' }, ` ${e.asset_tag || ''} · ${e.kind_label}`), e.status !== 'in_service' ? state(e.status === 'retired' ? ' Retired' : ' Needs service', e.status === 'retired' ? 'neutral' : 'warn') : null),
      e.plans.length ? h('span', { class: 'row small' }, e.plans.map((p) => h('span', null, chip(STATE, p.state), ` ${p.task}${p.due_on ? `, due ${fmtDay(p.due_on)}` : ''}`))) : h('span', { class: 'muted small' }, 'No life-safety checks for this kind of item'))))));
  clear(box).append(h('div', { class: 'stack' }, tools, sections.length ? sections : empty('No items yet. Add the extinguishers, exit lights, alarm panel and the rest.')));
}

function equipmentDialog(b, m, done) {
  const kind = select(m.equipment_kinds.map((k) => [k.value, k.label]), 'fire_extinguisher', { name: 'kind' });
  const name = input({ name: 'name', required: true, maxlength: 90, value: `${b.name} extinguisher` });
  kind.addEventListener('change', () => { name.value = `${b.name} ${(m.equipment_kinds.find((k) => k.value === kind.value) || {}).label.toLowerCase()}`; });
  formDialog('Add items', h('div', { class: 'stack' },
    field('Kind', kind), field('Name', name, 'Names are unique across the municipality, so include the building. With more than one, each gets a number.'),
    h('div', { class: 'row' }, field('How many', input({ type: 'number', name: 'count', min: 1, max: 60, value: 1 })), field('Room', select([['', 'Whole building'], ...b.rooms.filter((r) => r.active).map((r) => [r.id, r.name])], '', { name: 'room_id' }))),
    h('div', { class: 'row' }, field('Make and model', input({ name: 'make_model', maxlength: 100 })), field('Serial', input({ name: 'serial', maxlength: 80 }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'critical' }), ' Critical (a failure is urgent)')), async (fd) => {
    const out = await post(`/buildings/${b.id}/equipment`, { kind: val(fd, 'kind'), name: val(fd, 'name'), count: num(fd, 'count') || 1, room_id: num(fd, 'room_id'), make_model: val(fd, 'make_model'), serial: val(fd, 'serial'), critical: fd.get('critical') === 'on' });
    toast(`${out.ids.length} added, each with a QR tag. ${out.plans_made} check${out.plans_made === 1 ? '' : 's'} scheduled.`); done();
  }, { submitText: 'Add' });
}

async function drawYear(box, b) {
  const now = Number(todayStr().slice(0, 4));
  const ySel = select([now - 2, now - 1, now].map((y) => [y, String(y)]), now, { 'aria-label': 'Year' });
  const body = h('div');
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, ySel, h('span', { class: 'muted small' }, '✓ done · L done late · ✗ missed · ! overdue · · due')), body));
  async function load() {
    const y = await get(`/buildings/${b.id}/year?year=${ySel.value}`);
    if (!y.tasks.length) { clear(body).append(empty('No checks in this building yet.')); return; }
    const cell = (c) => h('td', { class: `bld-cell bld-${c.state}`, title: `${CELL[c.state][0]}${c.done ? `: ${c.done} done` : ''}${c.missed ? `, ${c.missed} missed` : ''}` }, CELL[c.state][1], c.state !== 'none' ? h('span', { class: 'sr' }, ` ${CELL[c.state][0]}`) : null);
    clear(body).append(h('div', { class: 'table-wrap' }, h('table', { class: 'rt bld-year' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Check'), MONTHS.map((mo) => h('th', { scope: 'col' }, mo)))),
      h('tbody', null, y.tasks.map((t) => h('tr', null, h('th', { scope: 'row' }, h('span', null, t.task), h('span', { class: 'muted small' }, ` ${t.plans} item${t.plans === 1 ? '' : 's'} · ${t.every}${t.never ? ` · ${t.never} with no record` : ''}`)), t.cells.map(cell)))))));
  }
  ySel.addEventListener('change', () => load().catch(fail));
  await load();
}

function drawFiles(box, b, reload) {
  clear(box).append(h('div', { class: 'stack' },
    canRecord() ? h('div', { class: 'row' }, button('Add a file', async () => {
      const file = await pickFile('.pdf,.png,.jpg,.jpeg,.docx,.doc,.xlsx');
      if (!file) return;
      await uploadFile(`/buildings/${b.id}/documents`, file); toast('Filed in Documents'); reload();
    }, { small: true }), h('span', { class: 'muted small' }, 'Floor plans, evacuation maps, reports. Vendor reports and certificates land here on their own.')) : null,
    b.documents.length ? h('ul', { class: 'plain rows' }, b.documents.map((d) => h('li', { class: 'spread' }, h('span', null, d.title, h('span', { class: 'muted small' }, ` ${d.file_name || ''}`)), button('Open', () => openFile(`/buildings/documents/${d.id}/file`), { small: true, label: `Open ${d.title}` })))) : empty('No files yet.')));
}

function drawHistory(box, b) {
  clear(box).append(h('div', { class: 'stack' },
    b.rounds.length ? h('section', { class: 'panel stack' }, h('h2', null, 'Rounds'), h('ul', { class: 'plain rows' }, b.rounds.map((r) => h('li', null, h('a', { href: `#/buildings/round/${r.id}` }, fmtDay(String(r.started_at).slice(0, 10))), ` · ${r.stops} items`, r.problems ? state(` ${r.problems} problems`, 'bad') : null, r.status === 'open' ? state(' Not finished', 'warn') : null)))) : null,
    h('section', { class: 'panel stack' }, h('h2', null, 'Latest inspections'), b.inspections.length ? table([
      { head: 'When', cell: (i) => fmtDay(String(i.done_at).slice(0, 10)) },
      { head: 'Item', cell: (i) => h('a', { href: `#/assets/a/${i.asset_id}` }, `${i.asset}${tagText(i.asset_tag)}`) },
      { head: 'Check', cell: (i) => i.template_name },
      { head: 'Result', cell: (i) => chip(RESULT, i.result) },
      { head: 'By', cell: (i) => i.inspector || '' },
    ], b.inspections) : empty('No inspections recorded yet.'))));
}

// ---------------------------------------------------------------- a staff round (phone)
async function renderRound(root, id) {
  let r;
  try { r = await get(`/buildings/rounds/${id}`); } catch (err) { root.append(back('#/buildings', 'Buildings'), errorBox(err)); return; }
  const reload = () => { clear(root); renderRound(root, id); };
  const open = r.status === 'open' && canRecord();
  const scanned = new Set();
  const cards = new Map();
  root.append(back(`#/buildings/b/${r.building_id}`, r.building), h('div', { class: 'page-head' },
    h('div', null, h('h1', null, `Round: ${r.building}`), h('p', { class: 'page-note' }, `${r.counts.done} of ${r.counts.total} checked${r.counts.failed ? `, ${r.counts.failed} failed` : ''}${r.counts.missing ? `, ${r.counts.missing} missing` : ''}. ${r.status === 'open' ? 'Scan each tag or pick the item from the list.' : 'This round is finished.'}`)),
    open ? h('div', { class: 'actions' },
      cameraSupported() ? button('Scan a tag', async () => {
        const text = await scanWithCamera('Point the camera at the item’s QR tag');
        if (!text) return;
        const mt = /#\/assets\/tag\/([^?#/]+)/.exec(text);
        const tag = decodeURIComponent(mt ? mt[1] : text).trim();
        const stop = r.stops.find((s) => s.asset_tag === tag && !s.result) || r.stops.find((s) => s.asset_tag === tag);
        if (!stop) { toast('That tag is not on this round', 'error'); return; }
        scanned.add(stop.id);
        const el = cards.get(stop.id); el.classList.add('bld-found'); el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (stop.result) toast(`${stop.asset} is already checked`);
      }, { kind: 'primary' }) : null,
      button('Finish round', () => confirmDialog('Finish this round?', r.counts.done < r.counts.total ? `${r.counts.total - r.counts.done} items are not checked. They stay due on the calendar.` : 'Every item is checked.', 'Finish round', async () => {
        const out = await post(`/buildings/rounds/${id}/finish`, {});
        toast(`Round finished: ${out.passed} passed, ${out.failed} failed, ${out.missing} missing, ${out.skipped} not checked.`);
        location.hash = `#/buildings/b/${r.building_id}`;
      }))) : null));
  const send = async (s, body) => {
    const out = await post(`/buildings/rounds/${id}/stops/${s.id}`, { ...body, scanned: scanned.has(s.id) });
    if (out.work_order_id) toast(`Work order opened for ${s.asset}`);
    return out;
  };
  const full = (s) => s.steps.some((x) => x.type && x.type !== 'pass');
  root.append(h('ol', { class: 'bld-round' }, r.stops.map((s) => {
    const el = h('li', { class: `bld-stop${s.result ? ` bld-stop-${s.result}` : ''}` },
      h('div', { class: 'stack tight' }, h('b', null, s.asset), h('span', { class: 'muted small' }, [s.asset_tag, s.room, s.task].filter(Boolean).join(' · '))),
      s.result ? h('div', { class: 'row' }, chip(RESULT, s.result), s.note ? h('span', { class: 'small' }, s.note) : null, s.work_order_id ? h('a', { href: `#/works/${s.work_order_id}`, class: 'small' }, 'Work order') : null, s.photos.length ? h('span', { class: 'muted small' }, `${s.photos.length} photo${s.photos.length === 1 ? '' : 's'}`) : null)
        : open ? h('div', { class: 'row bld-stop-actions' },
          full(s) ? button('Check', () => checklistDialog(s, (body) => send(s, body), reload), { kind: 'primary' }) : button('Pass', async () => { await send(s, { result: 'pass' }); reload(); }, { kind: 'primary', label: `Pass ${s.asset}` }),
          button('Fail', () => failDialog(s, id, (body) => send(s, body), reload), { kind: 'danger', label: `Fail ${s.asset}` }),
          button('Missing', () => confirmDialog(`${s.asset} is missing?`, 'It was not found in its place. A work order opens to find or replace it, and the check stays due.', 'Mark missing', async () => { await send(s, { result: 'missing' }); reload(); }), { label: `${s.asset} is missing` })) : null);
    cards.set(s.id, el);
    return el;
  })));
}

/** Fail: tick what is wrong, say what you see, and take a photo. */
function failDialog(s, roundId, send, done) {
  const passSteps = s.steps.filter((x) => !x.type || x.type === 'pass');
  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', name: 'photo' });
  formDialog(`What is wrong: ${s.asset}`, h('div', { class: 'stack' },
    passSteps.length ? h('fieldset', { class: 'stack tight' }, h('legend', null, 'Tick what failed'), passSteps.map((x) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'failed', value: x.key }), ` ${x.label}`))) : null,
    field('What you see', h('textarea', { name: 'note', rows: 3, required: true, maxlength: 500 })),
    field('Photo', photo, 'Kept as taken, with its fingerprint. Optional.')), async (fd) => {
    await send({ result: 'fail', failed_keys: fd.getAll('failed'), note: val(fd, 'note') });
    if (photo.files[0]) {
      try { await sendBytes('POST', `/buildings/rounds/${roundId}/stops/${s.id}/photo`, photo.files[0]); } catch (err) { fail(err); }
    }
    done();
  }, { submitText: 'Save and open a work order' });
}

/** A check with readings or dates (the generator run, the playground surfacing): every item answered. */
function checklistDialog(s, send, done) {
  const rows = s.steps.map((x) => {
    if (x.type === 'number') return field(`${x.label}${x.unit ? ` (${x.unit})` : ''}`, input({ type: 'number', step: 'any', name: `v_${x.key}`, required: true, inputmode: 'decimal' }), x.min != null || x.max != null ? `Allowed: ${[x.min != null ? `at least ${x.min}` : null, x.max != null ? `at most ${x.max}` : null].filter(Boolean).join(', ')}` : null);
    if (x.type === 'date') return field(x.label, input({ type: 'date', name: `v_${x.key}`, required: true }));
    return field(x.label, select([['pass', 'Pass'], ['fail', 'Fail'], ['na', 'Not applicable']], 'pass', { name: `r_${x.key}` }));
  });
  formDialog(`${s.task}: ${s.asset}`, h('div', { class: 'stack' }, ...rows, field('Note', h('textarea', { name: 'note', rows: 2, maxlength: 500 }), 'Needed when anything fails.')), async (fd) => {
    const answers = s.steps.map((x) => (x.type === 'number' ? { key: x.key, value: Number(fd.get(`v_${x.key}`)) } : x.type === 'date' ? { key: x.key, value: String(fd.get(`v_${x.key}`)) } : { key: x.key, result: String(fd.get(`r_${x.key}`)), note: String(fd.get(`r_${x.key}`)) === 'fail' ? val(fd, 'note') : null }));
    const out = await send({ result: 'pass', answers, note: val(fd, 'note') });
    toast(out.result === 'fail' ? 'Saved. Something was outside its range, so a work order opened.' : 'Saved');
    done();
  }, { submitText: 'Save' });
}

// ---------------------------------------------------------------- the binder
async function renderBinder(root) {
  const list = (await get('/buildings')).data;
  const today = todayStr();
  const bSel = select([['', 'Every building'], ...list.map((b) => [b.id, b.name])], hashParam('building') || '', { 'aria-label': 'Building' });
  const from = input({ type: 'date', value: hashParam('from') || addDays(today, -365), 'aria-label': 'From' });
  const to = input({ type: 'date', value: hashParam('to') || today, max: today, 'aria-label': 'To' });
  const body = h('div', { class: 'binder' }, loading());
  const qs = () => `building_id=${bSel.value}&from=${from.value}&to=${to.value}`;
  root.append(back('#/buildings', 'Buildings'), h('div', { class: 'page-head no-print' },
    h('div', null, h('h1', null, 'The binder'), h('p', { class: 'page-note' }, 'Everything an insurer’s loss-control visit or the fire marshal asks for. Print it, or choose Save as PDF in the print window.')),
    h('div', { class: 'actions' }, button('Print or save as PDF', () => window.print(), { kind: 'primary', small: true }),
      button('Download spreadsheet', () => download(`/buildings/binder?${qs()}&format=csv`, 'building-binder.csv'), { small: true }))),
  h('div', { class: 'week-filter no-print', role: 'group', 'aria-label': 'What to include' }, bSel, field('From', from), field('To', to), button('Show', () => load(), { small: true })), body);
  async function load() {
    history.replaceState(null, '', `#/buildings/binder?building=${bSel.value}&from=${from.value}&to=${to.value}`);
    let d;
    try { d = await get(`/buildings/binder?${qs()}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const sec = (title, content) => h('section', { class: 'binder-section' }, h('h2', null, title), content);
    clear(body).append(
      h('header', { class: 'binder-head' }, h('h1', null, `Life-safety binder: ${d.all ? 'all buildings' : d.buildings[0].name}`), h('p', null, `${ctx.me.tenant_name}. Records from ${fmtDay(d.from)} to ${fmtDay(d.to)}. Prepared ${fmtDay(d.today)}.`),
        h('p', { class: 'muted small' }, 'The dates and results are what staff and vendors recorded in Verdynt/OS. This binder does not certify any building or system.')),
      sec('Buildings', d.buildings.length ? table([
        { head: 'Building', cell: (b) => h('b', null, b.name) }, { head: 'Type', cell: (b) => b.type_label }, { head: 'Address', cell: (b) => b.full_address || '' },
        { head: 'Built', cell: (b) => (b.year_built ? String(b.year_built) : '') }, { head: 'Sq ft', num: true, cell: (b) => (b.square_feet ? Number(b.square_feet).toLocaleString('en-US') : '') },
        { head: 'Items', cell: (b) => b.by_kind.map((k) => `${k.n} ${k.label.toLowerCase()}`).join(', ') },
      ], d.buildings) : empty('No buildings.')),
      sec(`Overdue now (${d.overdue.length})`, d.overdue.length ? table([
        { head: 'Building', cell: (p) => where(p) }, { head: 'Item', cell: (p) => `${p.asset}${tagText(p.asset_tag)}` }, { head: 'Check', cell: (p) => [p.task, p.standard].filter(Boolean).join(' · ') },
        { head: 'Due', cell: (p) => (p.due_on ? fmtDay(p.due_on) : 'No record yet') }, { head: 'Who', cell: (p) => (p.who === 'vendor' ? (p.vendor || 'Vendor') : 'Staff') },
      ], d.overdue) : h('p', null, 'Nothing is overdue.')),
      sec(`Certificates on file (${d.certificates.length})`, d.certificates.length ? table([
        { head: 'Building', cell: (c) => c.building }, { head: 'Item', cell: (c) => `${c.asset}${tagText(c.asset_tag)}` }, { head: 'Certificate', cell: (c) => `${c.name}${c.number ? `, No. ${c.number}` : ''}` },
        { head: 'Expires', cell: (c) => fmtDay(c.expires_on) }, { head: 'Status', cell: (c) => chip(CERT, c.state) }, { head: 'Copy', cell: (c) => (c.document_id ? 'On file' : 'Not attached') },
      ], d.certificates) : h('p', null, 'No certificates on file.')),
      sec(`Deficiencies (${d.deficiencies.length})`, d.deficiencies.length ? table([
        { head: 'Found', cell: (x) => fmtDay(x.found_on) }, { head: 'Building', cell: (x) => x.building }, { head: 'What', cell: (x) => [x.description, x.asset ? `(${x.asset})` : null].filter(Boolean).join(' ') },
        { head: 'Fixed', cell: (x) => (x.open ? state('Open', 'bad') : x.fixed_on ? fmtDay(x.fixed_on) : 'Closed') }, { head: 'How', cell: (x) => x.resolution || '' },
      ], d.deficiencies) : h('p', null, 'No deficiencies in this period.')),
      sec(`Vendor visits (${d.visits.length})`, d.visits.length ? table([
        { head: 'Date', cell: (v) => fmtDay(v.visit_on) }, { head: 'Vendor', cell: (v) => [v.vendor, v.technician].filter(Boolean).join(', ') }, { head: 'Buildings', cell: (v) => v.buildings.map((x) => x.name).join(', ') },
        { head: 'Results', cell: (v) => `${v.lines.length} items, ${v.lines.filter((l) => l.result === 'fail').length} failed` }, { head: 'Report', cell: (v) => (v.document ? 'On file' : 'Not attached') },
      ], d.visits) : h('p', null, 'No vendor visits in this period.')),
      sec(`Inspections (${d.inspections.length})`, d.inspections.length ? table([
        { head: 'Date', cell: (i) => fmtDay(i.date) }, { head: 'Item', cell: (i) => h('span', null, `${i.asset}${tagText(i.tag)}`, h('span', { class: 'muted small' }, ` ${[i.building, i.room].filter(Boolean).join(', ')}`)) },
        { head: 'Check', cell: (i) => i.check }, { head: 'Result', cell: (i) => chip(RESULT, i.result) },
        { head: 'Details', cell: (i) => [...i.failed, ...i.readings].join('; ') }, { head: 'By', cell: (i) => i.by || '' },
      ], d.inspections) : h('p', null, 'No inspections in this period.')));
  }
  bSel.addEventListener('change', () => load());
  await load();
}

// Kept for other screens that show a building photo (the round's photos open in a new tab).
export async function openPhoto(id) { const blob = await fetchBlob(`/buildings/photos/${id}`); window.open(URL.createObjectURL(blob), '_blank'); }
