// Patrol > Team > Medications: the formulary set by the medical director, stock by lot and station, controlled-drug
// counts, and the oxygen cylinders and AEDs with what is due on each. Anything expired, low or owed shows at the top.
import { get, post, patch } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, table, empty, errorBox, state, fmtDate, fmtDateTime, label } from '../ui.js';

const AUTH = { standing_order: 'Standing order', assist_own: "Assist with the patient's own", medical_control: 'Medical control only' };

export async function drawMeds(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try { draw(await get('/patrol/meds')); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(d) {
    const edit = d.can_edit;
    const certName = Object.fromEntries(d.certs);
    clear(body).append(...[
      h('div', null, h('h2', null, 'Medications and oxygen'),
        h('p', { class: 'muted' }, [d.medical_director ? `Medical director: ${d.medical_director}.` : 'No medical director recorded (Settings, Patrol, Patrol settings).', d.protocol_version ? ` Protocols: ${d.protocol_version}.` : ''].join(''))),
      d.flags.length ? h('ul', { class: 'flag-list', role: 'status' }, d.flags.map((f) => h('li', null, state(f.level === 'bad' ? 'Now' : 'Soon', f.level), ` ${f.text}`))) : h('p', { class: 'muted' }, 'Nothing expired, low or owed.'),

      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h3', null, 'Formulary'), edit ? button('Add a medication', () => drugDialog(d, null, load), { small: true }) : null),
        h('p', { class: 'muted small' }, 'Only these can be recorded as given on a case. A patroller needs the certification shown, and the case checks allergies and, for nitroglycerin, the blood pressure.'),
        table([
          { head: 'Medication', cell: (f) => h('span', null, h('b', null, f.name), f.active ? null : h('span', { class: 'muted' }, ' (not in use)'), f.controlled ? state('Controlled', 'warn') : null) },
          { head: 'Authority', cell: (f) => AUTH[f.authority] },
          { head: 'Route', cell: (f) => f.routes.map(label).join(', ') },
          { head: 'Largest dose', cell: (f) => (f.max_dose !== null ? `${f.max_dose} ${f.dose_unit || ''}` : '') },
          { head: 'Who may give', cell: (f) => `${certName[f.min_cert]} or higher` },
          { head: '', actions: true, cell: (f) => (edit ? button('Edit', () => drugDialog(d, f, load), { small: true, label: `Edit ${f.name}` }) : '') },
        ], d.formulary)),

      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('h3', null, 'Stock'), h('div', { class: 'row' }, edit ? button('Receive stock', () => receiveDialog(d, load), { small: true }) : null,
          edit && d.controlled_counts && d.stock.some((k) => k.controlled) ? button('Controlled count', () => countDialog(d, load), { small: true }) : null)),
        d.stock.length ? table([
          { head: 'Medication', cell: (k) => h('b', null, k.drug) }, { head: 'Lot', cell: (k) => k.lot || '' },
          { head: 'Expires', cell: (k) => (k.expires_on ? fmtDate(String(k.expires_on).slice(0, 10)) : '') },
          { head: 'Where', cell: (k) => k.station || '' }, { head: 'On hand', num: true, cell: (k) => `${k.quantity} ${k.unit}` },
          { head: '', actions: true, cell: (k) => (edit ? button('Change', () => moveDialog(d, k, load), { small: true, label: `Change ${k.drug} lot ${k.lot || ''}` }) : '') },
        ], d.stock) : empty(edit ? 'No stock recorded. Receive stock to track lots, expiry and what is used on cases.' : 'No stock recorded.')),

      h('section', { class: 'panel stack' }, h('h3', null, 'Oxygen and AEDs'),
        d.equipment.length ? table([
          { head: 'Item', cell: (e) => h('b', null, e.name) }, { head: 'Where', cell: (e) => e.station || '' },
          { head: 'Now', cell: (e) => (e.kind === 'oxygen' ? (e.o2_psi != null ? state(`${e.o2_psi} psi`, e.o2_psi < d.o2_refill_psi ? 'warn' : 'good') : 'No reading yet') : Number(e.needs_download) ? state('Download data, new pads', 'bad') : state(label(e.status), e.status === 'in_service' ? 'good' : 'warn')) },
          { head: 'Pads', cell: (e) => (e.pads_expire_on ? fmtDate(String(e.pads_expire_on).slice(0, 10)) : '') },
          { head: 'Battery', cell: (e) => (e.battery_expire_on ? fmtDate(String(e.battery_expire_on).slice(0, 10)) : '') },
        ], d.equipment) : empty('No oxygen or AEDs on the equipment list yet (Team, Equipment).'),
        h('p', { class: 'muted small' }, `Log oxygen pressure and AED checks on Team, Equipment. Cylinders under ${d.o2_refill_psi} psi are flagged for refill.`)),

      d.moves.length ? h('details', { class: 'panel' }, h('summary', null, h('b', null, 'Recent stock changes')), table([
        { head: 'When', cell: (m) => fmtDateTime(m.at) }, { head: 'Medication', cell: (m) => `${m.drug}${m.lot ? `, lot ${m.lot}` : ''}` },
        { head: 'Change', num: true, cell: (m) => `${Number(m.delta) > 0 ? '+' : ''}${Number(m.delta)}` }, { head: 'Why', cell: (m) => `${label(m.reason)}${m.incident_id ? ` (case)` : ''}${m.note ? `: ${m.note}` : ''}` }, { head: 'By', cell: (m) => m.by_name || '' },
      ], d.moves)) : null,
      d.counts.length ? h('details', { class: 'panel' }, h('summary', null, h('b', null, 'Controlled counts')), table([
        { head: 'When', cell: (c) => fmtDateTime(c.counted_at) }, { head: 'Counted by', cell: (c) => `${c.by_name || ''} with ${c.witness || ''}` },
        { head: 'Result', cell: (c) => (Number(c.discrepancy) ? state('Did not match', 'bad') : state('Matched', 'good')) }, { head: 'Note', cell: (c) => c.note || '' },
      ], d.counts)) : null].filter(Boolean));
  }
  await load();
}

function drugDialog(d, f, again) {
  const routes = h('div', { class: 'row' }, d.routes.map((r) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'routes', value: r, checked: f ? f.routes.includes(r) : false }), ` ${label(r)}`)));
  formDialog(f ? `Edit ${f.name}` : 'Add a medication', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, value: f ? f.name : '' }), 'As patrollers will pick it'),
    field('Authority', select(Object.entries(AUTH), f ? f.authority : 'standing_order', { name: 'authority' })),
    h('div', { class: 'wide' }, h('span', { class: 'field-label' }, 'Routes'), routes),
    field('Largest single dose', input({ name: 'max_dose', type: 'number', step: 'any', min: 0, value: f && f.max_dose !== null ? f.max_dose : '' })),
    field('Unit', select([['', 'None'], ...d.units.map((u) => [u, u])], f && f.dose_unit ? f.dose_unit : '', { name: 'dose_unit' })),
    field('Lowest certification to give it', select(d.certs, f ? f.min_cert : 'oec', { name: 'min_cert' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'controlled', checked: f ? f.controlled : false }), ' Controlled (two-person counts and witnessed waste)'),
    f ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: f.active }), ' In use') : null,
    h('div', { class: 'wide' }, field('Notes for patrollers', input({ name: 'notes', maxlength: 255, value: f && f.notes ? f.notes : '' })))), async (fd) => {
    const body = { name: String(fd.get('name')).trim(), authority: fd.get('authority'), routes: fd.getAll('routes'), max_dose: fd.get('max_dose') === '' ? null : Number(fd.get('max_dose')), dose_unit: fd.get('dose_unit') || null, min_cert: fd.get('min_cert'), controlled: Boolean(fd.get('controlled')), notes: String(fd.get('notes') || '').trim() || null };
    if (f) await patch(`/patrol/meds/formulary/${f.id}`, { ...body, active: Boolean(fd.get('active')) }); else await post('/patrol/meds/formulary', body);
    toast('Formulary saved'); await again();
  }, { submitText: 'Save', wide: true });
}

async function receiveDialog(d, again) {
  const { data: stations } = await get('/patrol/stations');
  formDialog('Receive stock', h('div', { class: 'form' },
    field('Medication', select(d.formulary.filter((f) => f.active).map((f) => [f.id, f.name]), '', { name: 'formulary_id' })),
    field('Station', select([['', 'Not assigned'], ...stations.map((s) => [s.id, s.name])], '', { name: 'station_id' })),
    field('Lot number', input({ name: 'lot', maxlength: 40 })), field('Expires', input({ name: 'expires_on', type: 'date' })),
    field('Quantity', input({ name: 'quantity', type: 'number', step: 'any', min: 0, required: true })), field('Counted in', input({ name: 'unit', maxlength: 20, value: 'doses' }), 'Doses, tablets, tubes, pens'),
    field('Warn when down to', input({ name: 'low_at', type: 'number', step: 'any', min: 0 }))), async (fd) => {
    await post('/patrol/meds/stock', { formulary_id: Number(fd.get('formulary_id')), station_id: fd.get('station_id') ? Number(fd.get('station_id')) : null, lot: String(fd.get('lot') || '').trim() || null, expires_on: fd.get('expires_on') || null, quantity: Number(fd.get('quantity')), unit: String(fd.get('unit') || 'doses').trim(), low_at: fd.get('low_at') === '' ? null : Number(fd.get('low_at')) });
    toast('Stock received'); await again();
  }, { submitText: 'Receive' });
}

async function moveDialog(d, k, again) {
  const { data: roster } = await get('/patrol/team');
  formDialog(`${k.drug}, lot ${k.lot || k.id}`, h('div', { class: 'form' },
    field('What happened', select([['wasted', 'Wasted or broken'], ['expired', 'Removed: expired'], ['received', 'More received'], ['adjust', 'Correct the amount']], 'wasted', { name: 'reason' })),
    field(`Amount (${k.unit})`, input({ name: 'delta', type: 'number', step: 'any', required: true }), `On hand now: ${k.quantity}. For a correction, a minus number takes away.`),
    k.controlled ? field('Witness', select(roster.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), '', { name: 'witness_staff' }), 'A controlled medication needs a second person') : null,
    h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 255 })))), async (fd) => {
    await post(`/patrol/meds/stock/${k.id}/moves`, { reason: fd.get('reason'), delta: Number(fd.get('delta')), note: String(fd.get('note') || '').trim() || null, witness_staff: fd.get('witness_staff') ? Number(fd.get('witness_staff')) : null });
    toast('Stock changed'); await again();
  }, { submitText: 'Save' });
}

async function countDialog(d, again) {
  const { data: roster } = await get('/patrol/team');
  const lots = d.stock.filter((k) => k.controlled);
  formDialog('Controlled medication count', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Count each lot with a second person. A lot that does not match is set to what you count, and needs a note.'),
    field('Witness', select(roster.map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`]), '', { name: 'witness_staff' })),
    ...lots.map((k) => field(`${k.drug}, lot ${k.lot || k.id}${k.station ? `, ${k.station}` : ''} (record shows ${k.quantity})`, input({ name: `lot-${k.id}`, type: 'number', step: 'any', min: 0, required: true }))),
    field('Note', input({ name: 'note', maxlength: 500 }))), async (fd) => {
    const r = await post('/patrol/meds/counts', { witness_staff: Number(fd.get('witness_staff')), lines: lots.map((k) => ({ stock_id: k.id, counted: Number(fd.get(`lot-${k.id}`)) })), note: String(fd.get('note') || '').trim() || null });
    toast(r.discrepancy ? 'Count saved: it did not match and is flagged' : 'Count matched'); await again();
  }, { submitText: 'Save count', wide: true });
}
