// One asset, on a phone first: what it is and where, its meters, what needs doing, and the four things people do
// standing next to it (log meters, fuel, run an inspection, report a problem). Opened from the register or by scanning
// the QR tag on the machine (#/assets/tag/A-0042). Also: the label sheet, and the work order costs sheet.

import { get, post, patch, del } from '../api.js';
import { h, clear, appendAll, state, button, toast, formDialog, dialog, confirmDialog, field, input, select, val, num, money, toCents, centsToInput, fmtDate, fmtDateTime, label, errorBox, empty, isManager, todayStr, ctx } from '../ui.js';
import { qr } from '../barcode.js';

export const STATUS = { in_service: ['In service', 'good'], needs_service: ['Needs service', 'warn'], out_of_service: ['Out of service', 'bad'], retired: ['Retired', 'neutral'] };
export const SERVICE = { overdue: ['Service overdue', 'bad'], soon: ['Service due soon', 'warn'], ok: ['Service on track', 'good'], never: ['Service never done', 'neutral'] };
const PAPER = { expired: 'bad', soon: 'warn', ended: 'neutral', ok: 'good' };
const PRIORITY = { urgent: 'bad', high: 'warn', normal: 'neutral', low: 'neutral' };
/** "Nov 1, 2020": papers and purchases need the year. */
export const fmtDay = (s) => { if (!s) return ''; const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`); return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }); };
/** "31 h overdue" or "40 h left". */
export const leftText = (n, unit) => (n === null || n === undefined ? null : n < 0 ? `${Math.abs(n).toLocaleString()} ${unit} overdue` : `${n.toLocaleString()} ${unit} left`);
const n1 = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const meterText = (a) => [a.hours ? `${n1(a.hours).toLocaleString()} h` : null, a.miles !== null && a.miles !== undefined ? `${n1(a.miles).toLocaleString()} mi` : null].filter(Boolean).join(' · ') || 'No meter';
export const tagUrl = (tag) => `${location.origin}${location.pathname}#/assets/tag/${encodeURIComponent(tag)}`;

/** A row of tap-chips for pass, fail and N/A. */
function resultChips(id, labelledBy) {
  let cur = '';
  const row = h('div', { class: 'chip-row', role: 'group', id, 'aria-labelledby': labelledBy });
  for (const [v, t] of [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']]) {
    const b = h('button', { type: 'button', class: `chip result-${v}`, 'data-value': v, 'aria-pressed': 'false' }, t);
    b.addEventListener('click', () => { cur = cur === v ? '' : v; for (const x of row.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.value === cur)); row.dispatchEvent(new window.Event('change', { bubbles: true })); });
    row.append(b);
  }
  return { el: row, get: () => cur || null, set: (v) => { cur = v; for (const x of row.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x.dataset.value === cur)); } };
}

/** Everything the asset forms choose from: types, checklists, places, lifts, other assets and vendors. */
export async function fullMeta() {
  const [m, locs, lifts, reg, vendors] = await Promise.all([get('/assets/meta'), get('/assets/locations'), get('/schedule/lifts?limit=500').catch(() => ({ data: [] })), get('/assets/register'), get('/assets/vendors')]);
  return { ...m, locations: locs.data.filter((l) => l.active), lifts: lifts.data, assets: reg.data, vendors: vendors.data.filter((v) => v.active) };
}

export async function renderAsset(root, id) {
  const page = h('div', { class: 'stack asset-page' });
  root.append(page);
  let meta = null;
  async function load() {
    let a;
    try { [a, meta] = await Promise.all([get(`/assets/register/${id}`), fullMeta()]); } catch (err) { clear(page).append(back(), errorBox(err)); return; }
    clear(page).append(draw(a));
  }
  const back = () => h('p', { class: 'back' }, h('a', { href: '#/assets/register' }, '‹ Assets'));

  function draw(a) {
    const kind = (meta.kinds.find((k) => k.value === a.kind) || { label: label(a.kind) }).label;
    const [stText, stTone] = STATUS[a.status];
    const urgent = [
      ...a.papers.filter((p) => p.state === 'expired' || p.state === 'soon').map((p) => h('li', null, state(`${p.label} ${p.state === 'expired' ? 'expired' : 'due'} ${fmtDay(p.on)}`, PAPER[p.state]))),
      ...a.service.filter((s) => s.state === 'overdue' || s.state === 'soon').map((s) => h('li', null, state(`${s.name}: ${s.state === 'overdue' ? 'overdue' : 'due soon'}`, SERVICE[s.state][1]), dueText(s))),
      ...a.work_orders.filter((w) => !['done', 'cancelled'].includes(w.status)).map((w) => h('li', null, state(label(w.priority), PRIORITY[w.priority]), ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); workOrderSheet(w.id, a, load); } }, w.title), h('span', { class: 'muted small' }, ` ${label(w.status)}`))),
    ];
    const act = (text, fn, kind2, data) => { const b = h('button', { type: 'button', class: `btn big ${kind2 || ''}`.trim(), 'data-act': data }, text); b.addEventListener('click', fn); return b; };
    return h('div', { class: 'stack' },
      back(),
      h('section', { class: 'panel asset-head' },
        h('div', { class: 'asset-title' },
          h('div', null, h('p', { class: 'asset-tag' }, a.asset_tag), h('h1', null, a.name), h('p', { class: 'muted' }, [kind, a.make_model, a.model_year].filter(Boolean).join(' · '))),
          h('div', { class: 'asset-state' }, state(stText, stTone), a.critical ? state('Critical', 'warn') : null)),
        h('div', { class: 'asset-meters' },
          h('div', null, h('span', { class: 'k' }, 'Hours'), h('b', null, a.hours ? n1(a.hours).toLocaleString() : '–')),
          h('div', null, h('span', { class: 'k' }, 'Miles'), h('b', null, a.miles !== null ? n1(a.miles).toLocaleString() : '–')),
          h('div', null, h('span', { class: 'k' }, 'Where'), h('b', { class: 'small-b' }, a.location || a.lift || 'Not set'))),
        h('div', { class: 'asset-actions' },
          act('Log hours or miles', () => meterDialog(a, load), 'primary', 'meter'),
          act('Fuel', () => fuelDialog(a, load), '', 'fuel'),
          act('Inspect', () => inspectSheet(a, meta, load), '', 'inspect'),
          act('Report a problem', () => problemDialog(a, load), 'warn-btn', 'problem'))),
      urgent.length ? h('section', { class: 'panel stack attention' }, h('h2', null, 'Needs attention'), h('ul', { class: 'plain' }, urgent)) : null,
      serviceSection(a), ordersSection(a), inspectionsSection(a), historySection(a),
      partsSection(a), lifecycleSection(a), detailsSection(a), tagSection(a));
  }

  const dueText = (s) => h('span', { class: 'muted small' }, ` ${[s.due_on && `${s.due_on < todayStr() ? 'was due' : 'by'} ${fmtDay(s.due_on)}`, leftText(s.hours_left, 'h'), leftText(s.miles_left, 'mi')].filter(Boolean).join(', ')}`);

  function serviceSection(a) {
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Service plans'), button('Add a plan', () => planDialog(a, load), { small: true })),
      a.service.length ? h('ul', { class: 'plain rows' }, a.service.map((s) => h('li', { class: 'spread' },
        h('span', null, h('b', null, s.name), ' ', state(SERVICE[s.state][0], SERVICE[s.state][1]), h('span', { class: 'muted small' }, ` Every ${[s.interval_days && `${s.interval_days} days`, s.interval_hours && `${n1(s.interval_hours)} hours`, s.interval_miles && `${n1(s.interval_miles)} miles`].filter(Boolean).join(' or ')}.`), dueText(s)),
        h('span', { class: 'row tight' },
          s.open_order_id ? button('Open work order', () => workOrderSheet(s.open_order_id, a, load), { small: true }) : button('Create work order', async () => { const r = await post(`/ops/pm/${s.id}/work-order`, {}); toast('Work order created'); await load(); workOrderSheet(r.id, a, load); }, { small: true }),
          button('Mark done', () => confirmDialog(`Mark "${s.name}" done?`, `Done today at ${meterText(a)}.`, 'Mark done', async () => { await post(`/ops/pm/${s.id}/done`, {}); toast('Marked done'); await load(); }), { small: true }))))) : h('p', { class: 'muted' }, 'No service plans yet. Add one for oil changes, annual inspections and the like.'));
  }

  function ordersSection(a) {
    return h('section', { class: 'panel stack' }, h('h2', null, 'Work orders'),
      a.work_orders.length ? h('ul', { class: 'plain rows' }, a.work_orders.slice(0, 15).map((w) => h('li', { class: 'spread' },
        h('span', null, h('b', null, w.title), ' ', state(label(w.status), w.status === 'done' ? 'good' : w.status === 'cancelled' ? 'neutral' : 'warn'), h('span', { class: 'muted small' }, ` ${fmtDate(w.opened_on)}${w.resolution ? `. ${w.resolution}` : ''}`)),
        h('span', { class: 'row tight' }, isManager() || w.labor_cents || w.parts_cents ? h('span', { class: 'muted small' }, money(w.labor_cents + w.parts_cents + (w.vendor_cost_cents || 0))) : null, button('Open', () => workOrderSheet(w.id, a, load), { small: true, label: `Open work order: ${w.title}` }))))) : h('p', { class: 'muted' }, 'None yet.'));
  }

  function inspectionsSection(a) {
    return h('section', { class: 'panel stack' }, h('h2', null, 'Inspections'),
      a.inspections.length ? h('ul', { class: 'plain rows' }, a.inspections.map((i) => h('li', null,
        h('span', null, state(i.result === 'pass' ? 'Passed' : 'Failed', i.result === 'pass' ? 'good' : 'bad'), ' ', h('b', null, i.template_name), h('span', { class: 'muted small' }, ` ${fmtDateTime(i.done_at)}${i.inspector ? `, ${i.inspector}` : ''}`)),
        i.result === 'fail' ? h('p', { class: 'small' }, i.items.filter((x) => x.result === 'fail').map((x) => `${x.label}: ${x.note}`).join('; ')) : null))) : h('p', { class: 'muted' }, 'No inspections recorded.'));
  }

  function historySection(a) {
    return h('details', { class: 'panel more' }, h('summary', null, `Meters and fuel (${a.meters.length + a.fuel.length})`),
      h('div', { class: 'pair' },
        h('div', null, h('h3', null, 'Meter readings'), a.meters.length ? h('ul', { class: 'plain' }, a.meters.map((m) => h('li', null, h('b', null, `${n1(m.value).toLocaleString()} ${m.meter === 'hours' ? 'h' : 'mi'}`), h('span', { class: 'muted small' }, ` ${fmtDateTime(m.read_at)}, ${label(m.source)}`)))) : h('p', { class: 'muted' }, 'None.')),
        h('div', null, h('h3', null, 'Fuel'), a.fuel.length ? h('ul', { class: 'plain' }, a.fuel.map((f) => h('li', null, h('b', null, `${f.gallons} gal`), f.cost_cents !== null ? ` ${money(f.cost_cents)}` : '', h('span', { class: 'muted small' }, ` ${fmtDateTime(f.filled_at)}${f.vendor ? `, ${f.vendor}` : ''}`)))) : h('p', { class: 'muted' }, 'None.'))));
  }

  function partsSection(a) {
    if (!a.parts_used.length) return null;
    return h('details', { class: 'panel more' }, h('summary', null, `Parts used (${a.parts_used.length})`),
      h('ul', { class: 'plain' }, a.parts_used.map((p) => h('li', null, h('b', null, `${p.qty} ${p.unit}`), ` ${p.sku} ${p.name}`, h('span', { class: 'muted small' }, ` ${fmtDate(p.at)}`)))));
  }

  function lifecycleSection(a) {
    const c = a.costs; const l = a.lifecycle;
    const rowsKv = [
      ['Labor', money(c.labor)], ['Parts', money(c.parts)], ['Outside work', money(c.vendor)], ['Fuel', money(c.fuel)],
      ['Upkeep, last 12 months', money(c.maintenance_12)],
      l.cost_per_hour_cents !== null ? ['Cost per hour', money(l.cost_per_hour_cents)] : null,
      l.cost_per_mile_cents !== null ? ['Cost per mile', money(l.cost_per_mile_cents)] : null,
      l.age_years !== null ? ['Age', `${l.age_years} years`] : null,
      l.book_value_cents !== undefined && l.book_value_cents !== null ? ['Book value', money(l.book_value_cents)] : null,
    ].filter(Boolean);
    return h('section', { class: 'panel stack' }, h('h2', null, 'Costs and lifecycle'),
      l.replace ? h('div', { class: 'replace-flag', role: 'note' }, h('b', null, 'Worth considering a replacement. '), l.reasons.join('. '), '.') : null,
      h('div', { class: 'cost-grid' }, rowsKv.map(([k, v]) => h('div', null, h('span', { class: 'k' }, k), h('b', null, v)))));
  }

  function detailsSection(a) {
    const kv = [
      ['Tag', a.asset_tag], ['Type', (meta.kinds.find((k) => k.value === a.kind) || {}).label], ['Category', (meta.categories.find((c) => c.value === a.category) || {}).label],
      ['Location', a.location], ['Lift', a.lift], ['Part of', a.parent ? h('a', { href: `#/assets/a/${a.parent_id}` }, `${a.parent} (${a.parent_tag})`) : null],
      ['Make and model', a.make_model], ['Year', a.model_year], ['Serial', a.serial], ['VIN', a.vin], ['Plate', a.plate], ['Fuel', a.fuel_type && label(a.fuel_type)],
      ...a.papers.map((p) => [p.label, h('span', null, fmtDay(p.on), ' ', p.state !== 'ok' ? state(p.state === 'soon' ? 'Due soon' : label(p.state), PAPER[p.state]) : null)]),
      ['Warranty note', a.warranty_note], ['Purchased', a.purchased_on && fmtDay(a.purchased_on)], ['Vendor', a.vendor],
      a.purchase_cents !== undefined && a.purchase_cents !== null ? ['Purchase price', money(a.purchase_cents)] : null,
      a.useful_life_years ? ['Useful life', `${a.useful_life_years} years`] : null, ['Notes', a.notes],
    ].filter((x) => x && x[1] !== null && x[1] !== undefined && x[1] !== '');
    return h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Details'), button('Edit', () => assetDialog(meta, a, load), { small: true })),
      h('dl', { class: 'kv' }, kv.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      a.children.length ? h('div', { class: 'stack tight' }, h('h3', null, 'Parts of this asset'), h('ul', { class: 'plain' }, a.children.map((ch) => h('li', null, h('a', { href: `#/assets/a/${ch.id}` }, `${ch.name} (${ch.asset_tag})`), ' ', state(STATUS[ch.status][0], STATUS[ch.status][1]))))) : null);
  }

  function tagSection(a) {
    return h('section', { class: 'panel stack tag-panel' }, h('h2', null, 'QR tag'),
      h('div', { class: 'row' }, qr(tagUrl(a.asset_tag), { size: 112 }), h('div', { class: 'stack tight' }, h('b', { class: 'tag-big' }, a.asset_tag), h('span', { class: 'muted small' }, 'Scan with a phone camera to open this page. Staff sign in first.'),
        h('a', { class: 'btn small', href: `#/assets/labels/${a.id}` }, 'Print a label'))));
  }

  await load();
}

// ---------------------------------------------------------------- dialogs shared with the register
export function assetDialog(meta, a, done) {
  const cur = a || {};
  const can = isManager();
  const kinds = meta.kinds.map((k) => [k.value, k.label]);
  // A place, lift or vendor taken out of use still shows on the asset that has it, so saving does not clear it.
  const keep = (list, id, name) => (id && !list.some((x) => x.id === id) ? [...list, { id, name: `${name || 'Unknown'} (not in use)` }] : list);
  const locations = keep(meta.locations, cur.location_id, cur.location);
  const lifts = keep(meta.lifts, cur.lift_id, cur.lift);
  const vendors = keep(meta.vendors, cur.vendor_id, cur.vendor);
  const date = (name) => input({ name, type: 'date', value: cur[name] || '' });
  formDialog(a ? `Edit ${a.name}` : 'Add an asset', h('div', { class: 'stack' },
    h('fieldset', { class: 'form' }, h('legend', null, 'What it is'),
      field('Name', input({ name: 'name', required: true, maxlength: 100, value: cur.name || '', placeholder: 'Plow truck 2' })),
      field('Type', select(kinds, cur.kind || 'truck', { name: 'kind' })),
      field('Make and model', input({ name: 'make_model', maxlength: 100, value: cur.make_model || '' })),
      field('Year', input({ name: 'model_year', type: 'number', min: 1900, max: 2100, value: cur.model_year || '' })),
      field('Status', select(Object.entries(STATUS).map(([k, [t]]) => [k, t]), cur.status || 'in_service', { name: 'status' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'critical', checked: Boolean(cur.critical) }), ' Critical (a failure stops operations; failed checks open urgent work orders)')),
    h('fieldset', { class: 'form' }, h('legend', null, 'Where'),
      field('Location', select([['', 'Not set'], ...locations.map((l) => [l.id, l.name])], cur.location_id || '', { name: 'location_id' })),
      field('Lift', select([['', 'None'], ...lifts.map((l) => [l.id, l.name])], cur.lift_id || '', { name: 'lift_id' })),
      field('Part of', select([['', 'Nothing (stands alone)'], ...meta.assets.filter((x) => x.id !== cur.id).map((x) => [x.id, `${x.name} (${x.asset_tag})`])], cur.parent_id || '', { name: 'parent_id' }), 'A gearbox is part of a lift drive, a plow is part of a truck')),
    h('fieldset', { class: 'form' }, h('legend', null, 'Identity'),
      field('Tag', input({ name: 'asset_tag', maxlength: 20, value: cur.asset_tag || '', placeholder: 'Given automatically' })),
      field('Serial', input({ name: 'serial', maxlength: 80, value: cur.serial || '' })), field('VIN', input({ name: 'vin', maxlength: 40, value: cur.vin || '' })), field('Plate', input({ name: 'plate', maxlength: 20, value: cur.plate || '' })),
      field('Fuel', select([['', 'Not set'], ...meta.fuel_types.map((f) => [f, label(f)])], cur.fuel_type || '', { name: 'fuel_type' })),
      a ? null : field('Hours now', input({ name: 'hours', type: 'number', min: 0, step: '0.1' })), a ? null : field('Miles now', input({ name: 'miles', type: 'number', min: 0, step: '0.1' }))),
    h('fieldset', { class: 'form' }, h('legend', null, 'Papers and warranty'),
      field('Registration expires', date('registration_expires')), field('Insurance expires', date('insurance_expires')), field('Annual inspection due', date('inspection_expires')),
      field('Warranty ends', date('warranty_expires')), field('Warranty note', input({ name: 'warranty_note', maxlength: 255, value: cur.warranty_note || '' }))),
    h('fieldset', { class: 'form' }, h('legend', null, 'Purchase'),
      field('Purchased on', date('purchased_on')),
      field('Vendor', select([['', 'Not set'], ...vendors.map((v) => [v.id, v.name])], cur.vendor_id || '', { name: 'vendor_id' })),
      can ? field('Purchase price ($)', input({ name: 'purchase', inputmode: 'decimal', value: centsToInput(cur.purchase_cents) })) : null,
      can ? field('Useful life (years)', input({ name: 'useful_life_years', type: 'number', min: 1, max: 100, value: cur.useful_life_years || '' })) : null,
      can ? field('Salvage value ($)', input({ name: 'salvage', inputmode: 'decimal', value: centsToInput(cur.salvage_cents) })) : null),
    field('Notes', h('textarea', { name: 'notes', rows: 2, maxlength: 500 }, cur.notes || ''))),
  async (fd) => {
    const body = {
      name: val(fd, 'name'), kind: val(fd, 'kind'), make_model: val(fd, 'make_model'), model_year: num(fd, 'model_year'), status: val(fd, 'status'), critical: fd.get('critical') === 'on',
      location_id: num(fd, 'location_id'), lift_id: num(fd, 'lift_id'), parent_id: num(fd, 'parent_id'), serial: val(fd, 'serial'), vin: val(fd, 'vin'), plate: val(fd, 'plate'), fuel_type: val(fd, 'fuel_type'),
      registration_expires: val(fd, 'registration_expires'), insurance_expires: val(fd, 'insurance_expires'), inspection_expires: val(fd, 'inspection_expires'), warranty_expires: val(fd, 'warranty_expires'), warranty_note: val(fd, 'warranty_note'),
      purchased_on: val(fd, 'purchased_on'), vendor_id: num(fd, 'vendor_id'), notes: val(fd, 'notes'),
    };
    if (val(fd, 'asset_tag')) body.asset_tag = val(fd, 'asset_tag');
    if (can) {
      const p = val(fd, 'purchase'); const s = val(fd, 'salvage');
      if (p !== null && toCents(p) === null) throw new Error('Purchase price must be an amount like 52000 or 52000.00');
      if (s !== null && toCents(s) === null) throw new Error('Salvage value must be an amount');
      body.purchase_cents = p === null ? null : toCents(p); body.salvage_cents = s === null ? null : toCents(s); body.useful_life_years = num(fd, 'useful_life_years');
    }
    if (!a) { for (const k of ['hours', 'miles']) if (num(fd, k) !== null) body[k] = num(fd, k); }
    if (!a) for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
    const out = a ? await patch(`/assets/register/${a.id}`, body) : await post('/assets/register', body);
    toast(a ? 'Saved' : 'Asset added');
    if (done) await done(out);
  }, { wide: true, submitText: a ? 'Save' : 'Add asset' });
}

function meterDialog(a, done) {
  formDialog(`Meters: ${a.name}`, h('div', { class: 'form' },
    field(`Hours (now ${a.hours ? n1(a.hours) : 'not set'})`, input({ name: 'hours', type: 'number', inputmode: 'decimal', step: '0.1', min: 0 })),
    field(`Miles (now ${a.miles !== null ? n1(a.miles) : 'not set'})`, input({ name: 'miles', type: 'number', inputmode: 'decimal', step: '0.1', min: 0 })),
    isManager() ? h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'correct' }), ' This corrects a wrong reading (lets the meter go down; it is logged)') : null),
  async (fd) => {
    const b = {}; if (num(fd, 'hours') !== null) b.hours = num(fd, 'hours'); if (num(fd, 'miles') !== null) b.miles = num(fd, 'miles');
    if (!Object.keys(b).length) throw new Error('Enter hours, miles or both');
    if (fd.get('correct') === 'on') b.correct = true;
    await post(`/assets/register/${a.id}/meter`, b);
    toast('Meter saved');
    await done();
  }, { submitText: 'Save reading' });
}

function fuelDialog(a, done) {
  formDialog(`Fuel: ${a.name}`, h('div', { class: 'form' },
    field('Gallons', input({ name: 'gallons', type: 'number', inputmode: 'decimal', step: '0.01', min: 0, required: true })),
    field('Cost ($)', input({ name: 'cost', inputmode: 'decimal' })),
    field('Hours now', input({ name: 'hours', type: 'number', inputmode: 'decimal', step: '0.1', min: 0, placeholder: a.hours ? String(n1(a.hours)) : '' })),
    field('Miles now', input({ name: 'miles', type: 'number', inputmode: 'decimal', step: '0.1', min: 0, placeholder: a.miles !== null ? String(n1(a.miles)) : '' }))),
  async (fd) => {
    const cost = val(fd, 'cost');
    if (cost !== null && toCents(cost) === null) throw new Error('Cost must be an amount like 84.50');
    await post(`/assets/register/${a.id}/fuel`, { gallons: num(fd, 'gallons'), cost_cents: cost === null ? null : toCents(cost), hours: num(fd, 'hours'), miles: num(fd, 'miles') });
    toast('Fuel logged');
    await done();
  }, { submitText: 'Log fuel' });
}

function problemDialog(a, done) {
  formDialog(`Report a problem: ${a.name}`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('What is wrong', input({ name: 'title', required: true, minlength: 3, maxlength: 150, placeholder: 'Hydraulic leak at the tiller' }))),
    h('div', { class: 'wide' }, field('Details', h('textarea', { name: 'description', rows: 3, maxlength: 5000 }))),
    h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'out_of_service' }), ' Take it out of service now')),
  async (fd) => {
    await post(`/assets/register/${a.id}/problem`, { title: val(fd, 'title'), description: val(fd, 'description'), out_of_service: fd.get('out_of_service') === 'on' });
    toast('Work order created');
    await done();
  }, { submitText: 'Report it' });
}

function planDialog(a, done) {
  formDialog(`New service plan: ${a.name}`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('What gets done', input({ name: 'name', required: true, maxlength: 150, placeholder: 'Oil and filter change' }))),
    field('Every so many days', input({ name: 'interval_days', type: 'number', min: 1 })), field('Every so many hours', input({ name: 'interval_hours', type: 'number', min: 1 })), field('Every so many miles', input({ name: 'interval_miles', type: 'number', min: 1 })),
    h('div', { class: 'wide' }, field('Checklist (one step per line)', h('textarea', { name: 'checklist', rows: 4, maxlength: 2000 }), 'Copied into each work order the plan creates'))),
  async (fd) => {
    await post('/ops/pm', { name: val(fd, 'name'), asset_id: a.id, interval_days: num(fd, 'interval_days'), interval_hours: num(fd, 'interval_hours'), interval_miles: num(fd, 'interval_miles'), checklist: val(fd, 'checklist') });
    toast('Plan added');
    await done();
  }, { submitText: 'Add plan' });
}

/** The checklist suited to the asset, every item answered pass, fail or N/A. A failure needs a note and opens a work order. */
export function inspectSheet(a, meta, done) {
  const active = meta.templates.filter((t) => t.active);
  const pick = active.find((t) => t.kinds.includes(a.kind)) || active.find((t) => !t.kinds.length) || active[0];
  if (!pick) { toast('Add a checklist under Settings first', 'error'); return; }
  const chooser = select(active.map((t) => [t.id, t.name]), pick.id, { 'aria-label': 'Checklist' });
  const box = h('div', { class: 'stack' });
  const err = h('div');
  let answers = [];
  const drawItems = () => {
    const t = active.find((x) => String(x.id) === chooser.value);
    answers = t.items.map((it, i) => {
      const id = `ins-${i}`;
      const c = resultChips(id, `${id}-l`);
      const note = input({ maxlength: 255, placeholder: 'What is wrong', 'aria-label': `What is wrong: ${it.label}`, hidden: true });
      c.el.addEventListener('change', () => { note.hidden = c.get() !== 'fail'; if (!note.hidden) note.focus(); });
      return { key: it.key, c, note, el: h('div', { class: 'ins-item' }, h('span', { id: `${id}-l`, class: 'ins-label' }, it.label), c.el, note) };
    });
    clear(box).append(...answers.map((x) => x.el));
  };
  chooser.addEventListener('change', drawItems);
  drawItems();
  const allPass = h('button', { type: 'button', class: 'btn small' }, 'Mark the rest as pass');
  allPass.addEventListener('click', () => { for (const x of answers) if (!x.c.get()) x.c.set('pass'); });
  const hours = input({ type: 'number', step: '0.1', min: 0, inputmode: 'decimal', 'aria-label': 'Hours now', placeholder: a.hours ? String(n1(a.hours)) : 'Hours now' });
  const miles = input({ type: 'number', step: '0.1', min: 0, inputmode: 'decimal', 'aria-label': 'Miles now', placeholder: a.miles !== null && a.miles !== undefined ? String(n1(a.miles)) : 'Miles now' });
  const save = h('button', { type: 'button', class: 'btn primary big', 'data-act': 'save-inspection' }, 'Save inspection');
  const dlg = dialog(`Inspect: ${a.name}`, h('div', { class: 'stack ins-sheet' }, h('div', { class: 'row' }, chooser, allPass), box, h('div', { class: 'row tight' }, hours, miles), err, h('div', { class: 'footer row' }, save)), { wide: true });
  dlg.box.classList.add('sheet');
  save.addEventListener('click', async () => {
    clear(err);
    const missing = answers.filter((x) => !x.c.get());
    if (missing.length) { err.append(errorBox(new Error(`Answer every item (${missing.length} left)`))); return; }
    const noNote = answers.filter((x) => x.c.get() === 'fail' && !x.note.value.trim());
    if (noNote.length) { err.append(errorBox(new Error('Say what is wrong with each item that failed'))); noNote[0].note.focus(); return; }
    save.disabled = true;
    try {
      const r = await post(`/assets/register/${a.id}/inspections`, { template_id: Number(chooser.value), items: answers.map((x) => ({ key: x.key, result: x.c.get(), note: x.note.value.trim() || null })), hours: hours.value === '' ? null : Number(hours.value), miles: miles.value === '' ? null : Number(miles.value) });
      dlg.close();
      toast(r.result === 'pass' ? 'Inspection passed' : 'Inspection failed: a work order was opened', r.result === 'pass' ? 'ok' : 'warn');
      await done();
    } catch (e) { err.append(errorBox(e)); save.disabled = false; }
  });
  return dlg;
}

/**
 * A work order from the asset side: what it is, its status, and what it cost (labor at the shop rate, parts from stock,
 * outside work), with the buttons a mechanic needs to work it to done.
 */
export async function workOrderSheet(woId, a, done) {
  const [w, c, parts] = await Promise.all([get(`/ops/work-orders/${woId}`), get(`/assets/work-orders/${woId}/costs`), get('/assets/parts')]);
  const body = h('div', { class: 'stack wo-sheet' });
  const dlg = dialog(w.title, body, { wide: true });
  const refresh = async () => { dlg.close(); await done(); await workOrderSheet(woId, a, done); };
  const st = (status, text, kind) => button(text, async () => {
    if (status === 'done') {
      formDialog('Complete the work order', h('div', { class: 'form' }, h('div', { class: 'wide' }, field('What was done', h('textarea', { name: 'resolution', rows: 3, maxlength: 500, required: true })))), async (fd) => {
        await post(`/ops/work-orders/${woId}/status`, { status: 'done', resolution: val(fd, 'resolution') });
        toast('Work order completed');
        await refresh();
      }, { submitText: 'Complete' });
      return;
    }
    await post(`/ops/work-orders/${woId}/status`, { status });
    toast(label(status)); await refresh();
  }, { small: true, kind });
  const closed = ['done', 'cancelled'].includes(w.status);
  const partSel = select([['', 'Choose a part'], ...parts.data.map((p) => [p.id, `${p.sku} ${p.name} (${p.qty_on_hand} ${p.unit} on hand)`])], '', { 'aria-label': 'Part' });
  const partQty = input({ type: 'number', min: 0, step: 'any', value: '1', 'aria-label': 'Quantity', class: 'short-num' });
  const hrs = input({ type: 'number', min: 0, step: '0.25', 'aria-label': 'Hours worked', placeholder: 'Hours', class: 'short-num' });
  const who = input({ maxlength: 100, 'aria-label': 'Who worked', placeholder: 'Who', value: (ctx.me && ctx.me.name) || '' });
  appendAll(body,
    h('p', null, state(label(w.status), w.status === 'done' ? 'good' : 'warn'), ' ', state(label(w.priority), PRIORITY[w.priority]), h('span', { class: 'muted small' }, ` ${[w.asset, w.lift, w.location, w.assignee].filter(Boolean).join(', ')}`)),
    w.description ? h('p', { class: 'prewrap' }, w.description) : null,
    w.resolution ? h('p', null, h('b', null, 'Done: '), w.resolution) : null,
    closed ? null : h('div', { class: 'row' }, w.status !== 'in_progress' ? st('in_progress', 'Start work') : null, w.status !== 'waiting_parts' ? st('waiting_parts', 'Waiting for parts') : null, st('done', 'Complete', 'primary')),
    h('section', { class: 'stack tight' }, h('h3', null, 'Labor'),
      c.labor.length ? h('ul', { class: 'plain' }, c.labor.map((l) => h('li', { class: 'spread' }, h('span', null, `${l.who || 'Not named'}: ${l.hours} h on ${fmtDate(l.worked_on)}`, h('span', { class: 'muted small' }, ` ${money(Math.round(l.hours * l.rate_cents))}`)),
        l.mine || isManager() ? button('Remove', async () => { await del(`/assets/work-orders/${woId}/labor/${l.id}`); await refresh(); }, { small: true, kind: 'quiet', label: `Remove ${l.hours} h by ${l.who || 'unnamed'}` }) : null))) : h('p', { class: 'muted' }, 'None logged.'),
      h('div', { class: 'row tight' }, who, hrs, button('Log time', async () => { if (!hrs.value) throw new Error('Enter the hours'); await post(`/assets/work-orders/${woId}/labor`, { worker: who.value.trim() || null, hours: Number(hrs.value) }); toast('Time logged'); await refresh(); }, { small: true }))),
    h('section', { class: 'stack tight' }, h('h3', null, 'Parts from stock'),
      c.parts.length ? h('ul', { class: 'plain' }, c.parts.map((p) => h('li', { class: 'spread' }, h('span', null, `${p.qty} ${p.unit} ${p.sku} ${p.name}`, h('span', { class: 'muted small' }, ` ${money(p.cost)}`)),
        button('Return one', async () => { await post(`/assets/work-orders/${woId}/parts`, { part_id: p.part_id, qty: -1 }); await refresh(); }, { small: true, kind: 'quiet', label: `Return one ${p.name}` })))) : h('p', { class: 'muted' }, 'None used.'),
      parts.data.length ? h('div', { class: 'row tight' }, partSel, partQty, button('Use part', async () => { if (!partSel.value) throw new Error('Choose a part'); await post(`/assets/work-orders/${woId}/parts`, { part_id: Number(partSel.value), qty: Number(partQty.value) }); toast('Part used'); await refresh(); }, { small: true })) : h('p', { class: 'muted small' }, 'Add parts under Parts to take them from stock here.')),
    h('section', { class: 'stack tight' }, h('h3', null, 'Meter at service and outside work'),
      h('p', { class: 'small' }, [c.meter_hours !== null ? `${n1(c.meter_hours)} h` : null, c.meter_miles !== null ? `${n1(c.meter_miles)} mi` : null].filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'No meter recorded'), c.vendor_cost_cents !== null ? ` · Outside work ${money(c.vendor_cost_cents)}${c.vendor ? ` (${c.vendor})` : ''}` : ''),
      button('Record meter or outside cost', () => costsDialog(woId, c, refresh), { small: true })),
    h('p', { class: 'wo-total' }, h('b', null, 'Total so far: '), money(c.total_cents), h('span', { class: 'muted small' }, ` (labor ${money(c.labor_cents)}, parts ${money(c.parts_cents)}${c.vendor_cost_cents ? `, outside ${money(c.vendor_cost_cents)}` : ''})`)),
  );
  return dlg;
}

async function costsDialog(woId, c, done) {
  const vendors = isManager() ? (await get('/assets/vendors')).data : [];
  formDialog('Meter and outside work', h('div', { class: 'form' },
    field('Hours at service', input({ name: 'meter_hours', type: 'number', step: '0.1', min: 0, value: c.meter_hours ?? '' })),
    field('Miles at service', input({ name: 'meter_miles', type: 'number', step: '0.1', min: 0, value: c.meter_miles ?? '' })),
    field('Hours out of service', input({ name: 'downtime_hours', type: 'number', step: '0.5', min: 0, value: c.downtime_hours ?? '' })),
    isManager() ? field('Outside vendor', select([['', 'None'], ...vendors.map((v) => [v.id, v.name])], c.vendor_id || '', { name: 'vendor_id' })) : null,
    isManager() ? field('Outside work cost ($)', input({ name: 'vendor_cost', inputmode: 'decimal', value: centsToInput(c.vendor_cost_cents) })) : null),
  async (fd) => {
    const b = { meter_hours: num(fd, 'meter_hours'), meter_miles: num(fd, 'meter_miles'), downtime_hours: num(fd, 'downtime_hours') };
    if (isManager()) {
      const v = val(fd, 'vendor_cost');
      if (v !== null && toCents(v) === null) throw new Error('Outside work cost must be an amount');
      b.vendor_id = num(fd, 'vendor_id'); b.vendor_cost_cents = v === null ? null : toCents(v);
    }
    await patch(`/assets/work-orders/${woId}/costs`, b);
    toast('Saved');
    await done();
  });
}

/** A printable sheet of QR labels: one asset, or every asset in the register. */
export async function renderLabels(root, which) {
  const { data } = await get('/assets/register');
  const list = which && which !== 'all' ? data.filter((a) => which.split(',').map(Number).includes(a.id)) : data;
  root.append(h('div', { class: 'labels-page stack' },
    h('div', { class: 'row labels-tools' }, h('a', { class: 'btn', href: '#/assets/register' }, '‹ Assets'), button('Print', () => window.print(), { kind: 'primary' }),
      h('span', { class: 'muted small' }, `${list.length} label${list.length === 1 ? '' : 's'}. Print on sticker sheets or plain paper and laminate. Outdoors, use weatherproof labels.`)),
    list.length ? h('div', { class: 'labels' }, list.map((a) => h('div', { class: 'label-card' }, qr(tagUrl(a.asset_tag), { size: 96 }),
      h('div', { class: 'label-text' }, h('b', null, a.asset_tag), h('span', null, a.name), h('span', { class: 'muted' }, (ctx.me && ctx.me.tenant_name) || ''), h('span', { class: 'small muted' }, 'Scan for history and checks'))))) : empty('No assets to label.')));
}

export { todayStr };
