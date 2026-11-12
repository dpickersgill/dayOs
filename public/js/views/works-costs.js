// What a work order costs, for a municipality's Work orders (release 2026.11.20, workstream "money"): Mark done with the
// crew's hours, equipment hours, parts from stock, other materials and the outside bill; Add costs while it is open; the
// costs on the work order; its department, fund and street; and the Done tab's dates and totals. The API is
// /assets/cost-pickers, /assets/work-orders/:id/{complete,cost-lines,costs} (routes/workmoney.js). The crew sees hours;
// money is a manager's (a person's labor rate is their pay).
import { get, post, del } from '../api.js';
import { h, clear, ctx, isManager, isMuni, input, select, field, button, toast, formDialog, money, toCents, todayStr, addDays, fmtDate } from '../ui.js';

let cache = null;
/** What the forms choose from: crew, equipment, parts in stock, departments, funds, streets and (managers) vendors. */
export async function costPickers({ fresh = false } = {}) {
  if (!cache || fresh) cache = get('/assets/cost-pickers').catch(() => ({ staff: [], equipment: [], parts: [], departments: [], funds: [], streets: [], vendors: [], is_muni: false, can_manage: false }));
  return cache;
}

const hoursText = (n) => `${Math.round(Number(n || 0) * 100) / 100} h`;

/** A list of rows the person adds to and removes from; each row is made by make() and read by its own value(). */
function rowList(make, addText, { start = [] } = {}) {
  const list = h('div', { class: 'cost-rows' });
  const rows = [];
  const add = (init) => {
    const r = make(init || {});
    const remove = button('Remove', () => { r.el.remove(); rows.splice(rows.indexOf(r), 1); }, { small: true, kind: 'quiet', label: 'Remove this line' });
    r.el.append(remove);
    rows.push(r); list.append(r.el);
    const f = r.el.querySelector('select, input'); if (f && init && init.focus) f.focus();
  };
  for (const s of start) add(s);
  return { el: h('div', { class: 'stack tight' }, list, h('div', null, button(addText, () => add({ focus: true }), { small: true }))), values: () => rows.map((r) => r.value()).filter(Boolean) };
}

const numIn = (attrs) => input({ type: 'number', inputmode: 'decimal', min: '0', class: 'short-num', ...attrs });
function laborRow(p) {
  return (init) => {
    const who = p.staff.length ? select([['', 'Who'], ...p.staff.map((s) => [s.id, s.name]), ['other', 'Someone else']], init.staff_id || '', { 'aria-label': 'Who worked' }) : null;
    const name = input({ maxlength: 100, placeholder: 'Name', 'aria-label': 'Name of who worked', hidden: Boolean(who) });
    if (who) who.addEventListener('change', () => { name.hidden = who.value !== 'other'; });
    const hrs = numIn({ step: '0.25', max: '200', placeholder: 'Hours', 'aria-label': 'Hours worked', value: init.hours ?? '' });
    return { el: h('div', { class: 'cost-row' }, who, name, hrs), value: () => {
      if (!hrs.value) return null;
      const staffId = who && who.value && who.value !== 'other' ? Number(who.value) : null;
      if (!staffId && !name.value.trim()) throw new Error('Say who worked the hours');
      return { staff_id: staffId, worker: staffId ? null : name.value.trim(), hours: Number(hrs.value) };
    } };
  };
}
function equipmentRow(p) {
  return () => {
    const what = select([['', 'Equipment'], ...p.equipment.map((a) => [a.id, `${a.name}${a.tag ? ` (${a.tag})` : ''}${a.rate_cents ? `, ${money(a.rate_cents)}/h${a.suggested ? ' suggested' : ''}` : ''}`])], '', { 'aria-label': 'Equipment used' });
    const hrs = numIn({ step: '0.25', max: '500', placeholder: 'Hours', 'aria-label': 'Hours the equipment was used' });
    return { el: h('div', { class: 'cost-row' }, what, hrs), value: () => {
      if (!what.value && !hrs.value) return null;
      if (!what.value || !hrs.value) throw new Error('For equipment, choose it and give the hours');
      return { asset_id: Number(what.value), hours: Number(hrs.value) };
    } };
  };
}
function partRow(p) {
  return () => {
    const what = select([['', 'Part from stock'], ...p.parts.map((x) => [x.id, `${x.name} (${x.qty_on_hand} ${x.unit} on hand)`])], '', { 'aria-label': 'Part from stock' });
    const qty = numIn({ step: 'any', placeholder: 'How many', 'aria-label': 'How many' });
    return { el: h('div', { class: 'cost-row' }, what, qty), value: () => {
      if (!what.value && !qty.value) return null;
      if (!what.value || !qty.value) throw new Error('For a part, choose it and say how many');
      return { part_id: Number(what.value), qty: Number(qty.value) };
    } };
  };
}
function materialRow() {
  return () => {
    const what = input({ maxlength: 150, placeholder: 'What (asphalt, stone, pipe)', 'aria-label': 'Material' });
    const qty = numIn({ step: 'any', placeholder: 'How many', 'aria-label': 'Quantity' });
    const unit = input({ maxlength: 20, placeholder: 'Unit', 'aria-label': 'Unit', class: 'short-num' });
    const cost = input({ inputmode: 'decimal', placeholder: '$ each', 'aria-label': 'Cost each, in dollars', class: 'short-num' });
    return { el: h('div', { class: 'cost-row' }, what, qty, unit, cost), value: () => {
      if (!what.value.trim() && !qty.value) return null;
      if (!what.value.trim() || !qty.value) throw new Error('For other materials, say what and how many');
      const c = cost.value.trim() ? toCents(cost.value) : 0;
      if (c === null) throw new Error('The cost of a material must be an amount, like 85 or 85.50');
      return { description: what.value.trim(), qty: Number(qty.value), unit: unit.value.trim() || null, unit_cost_cents: c };
    } };
  };
}

/** The department, fund and street choosers (managers); the street for anyone. */
export function booksFields(p, w = {}) {
  if (!p.is_muni) return null;
  const keep = (list, id, name) => (id && !list.some((x) => x.id === id) ? [...list, { id, name: `${name || 'Unknown'} (not in use)` }] : list);
  return h('div', { class: 'form' },
    p.can_manage ? field('Department', select([['', 'Not set'], ...keep(p.departments, w.department_id, w.department).map((d) => [d.id, d.name])], w.department_id || '', { name: 'department_id' })) : null,
    p.can_manage ? field('Fund', select([['', 'The department\'s fund'], ...keep(p.funds, w.fund_id, w.fund).map((f) => [f.id, f.name])], w.fund_id || '', { name: 'fund_id' }), 'Road work charged to Liquid Fuels counts on the Liquid Fuels report by street') : null,
    p.streets.length ? field('Street', select([['', 'Not set'], ...p.streets.map((s) => [s.id, s.name])], w.street_id || '', { name: 'street_id' })) : null);
}
const booksBody = (fd, p, w = {}) => {
  if (!p.is_muni) return {};
  const n = (k) => { const v = fd.get(k); return v === null ? undefined : v === '' ? null : Number(v); };
  const out = {};
  for (const k of [...(p.can_manage ? ['department_id', 'fund_id'] : []), 'street_id']) { const v = n(k); if (v !== undefined && v !== (w[k] ?? null)) out[k] = v; }
  return out;
};
export { booksBody };

/** The costs form: crew hours, equipment, parts, other materials, and (managers) the outside bill. */
function costForm(p, w, { withDone }) {
  const me = ctx.me && ctx.me.staff_id;
  const firstWho = w.assigned_staff_id || me || null;
  const labor = rowList(laborRow(p), 'Add a person', { start: [{ staff_id: firstWho && p.staff.some((s) => s.id === firstWho) ? firstWho : '' }] });
  const equipment = rowList(equipmentRow(p), 'Add equipment');
  const parts = rowList(partRow(p), 'Add a part from stock');
  const materials = rowList(materialRow(), 'Add a material');
  const el = h('div', { class: 'stack cost-form' },
    withDone ? field('What was done', h('textarea', { name: 'resolution', rows: 3, required: true, maxlength: 500 })) : null,
    field('Day worked', input({ name: 'worked_on', type: 'date', value: todayStr(), max: todayStr() })),
    h('fieldset', { class: 'stack tight' }, h('legend', null, 'Crew hours'), labor.el),
    p.equipment.length ? h('fieldset', { class: 'stack tight' }, h('legend', null, 'Equipment hours'), equipment.el) : null,
    p.parts.length ? h('fieldset', { class: 'stack tight' }, h('legend', null, 'Parts from stock'), parts.el) : null,
    h('fieldset', { class: 'stack tight' }, h('legend', null, 'Other materials'), materials.el),
    p.can_manage ? h('fieldset', { class: 'form' }, h('legend', null, 'Outside work'),
      field('Vendor', select([['', 'None'], ...p.vendors.map((v) => [v.id, v.name])], w.vendor_id || '', { name: 'vendor_id' })),
      field('Their bill ($)', input({ name: 'vendor_cost', inputmode: 'decimal', value: '' }), 'Adds to what is already recorded')) : null,
    w.asset_id ? field('Hours out of service', input({ name: 'downtime_hours', type: 'number', min: '0', step: '0.5', inputmode: 'decimal' }), 'How long the truck or machine could not be used') : null,
    withDone && p.is_muni ? h('details', { class: 'stack tight' }, h('summary', null, `Charged to: ${[w.department || 'no department', w.fund, w.street].filter(Boolean).join(', ')}`), booksFields(p, w)) : null);
  const body = (fd, prior = {}) => {
    const b = { worked_on: fd.get('worked_on') || null, labor: labor.values(), equipment: equipment.values(), parts: parts.values(), materials: materials.values() };
    if (p.can_manage) {
      const v = String(fd.get('vendor_cost') || '').trim();
      if (v) { const c = toCents(v); if (c === null) throw new Error('The vendor\'s bill must be an amount, like 420 or 420.00'); b.vendor_cost_cents = Number(prior.vendor_cost_cents || 0) + c; }
      const vid = fd.get('vendor_id'); if (vid && Number(vid) !== (w.vendor_id || null)) b.vendor_id = Number(vid);
    }
    const down = String(fd.get('downtime_hours') || '').trim(); if (down) b.downtime_hours = Number(prior.downtime_hours || 0) + Number(down);
    if (withDone) Object.assign(b, booksBody(fd, p, w));
    return b;
  };
  return { el, body };
}

/** Mark done: what was done and what it took. done() runs after it is saved. */
export async function markDone(w, done) {
  const [p, c] = await Promise.all([costPickers(), get(`/assets/work-orders/${w.id}/costs`).catch(() => ({}))]);
  const f = costForm(p, w, { withDone: true });
  formDialog(`Mark done: ${w.title}`, f.el, async (fd) => {
    const r = await post(`/assets/work-orders/${w.id}/complete`, { resolution: String(fd.get('resolution') || '').trim(), ...f.body(fd, c) });
    toast(r.total_cents !== undefined ? `Work order done. ${hoursText(r.labor_hours)} of labor, ${money(r.total_cents)} in all.` : `Work order done. ${hoursText(r.labor_hours)} of labor recorded.`);
    cache = null;
    await done();
  }, { submitText: 'Mark done', wide: true });
}

/** Add costs to an open (or done) work order without closing it. */
export async function addCosts(w, c, done) {
  const p = await costPickers();
  const f = costForm(p, w, { withDone: false });
  formDialog(`Add costs: ${w.title}`, f.el, async (fd) => {
    const b = f.body(fd, c);
    if (!b.labor.length && !b.equipment.length && !b.parts.length && !b.materials.length && b.vendor_cost_cents === undefined && b.downtime_hours === undefined) throw new Error('Add at least one line');
    await post(`/assets/work-orders/${w.id}/cost-lines`, b);
    toast('Costs added');
    cache = null;
    await done();
  }, { submitText: 'Add', wide: true });
}

/** The work order's costs: a line per person, machine, part and material, the outside bill, and the total. */
export async function costsSection(w, refresh) {
  const box = h('section', { class: 'stack tight wo-costs', 'aria-label': 'Costs' });
  let c;
  try { c = await get(`/assets/work-orders/${w.id}/costs`); } catch (_) { return null; }
  const see = isManager();
  const amt = (cents) => (see && cents !== null && cents !== undefined ? h('span', { class: 'muted small' }, ` ${money(cents)}`) : null);
  const rm = (line, kind, text) => (line.mine || see ? button('Remove', async () => { await del(`/assets/work-orders/${w.id}/${kind}/${line.id}`); toast('Removed'); await refresh(); }, { small: true, kind: 'quiet', label: `Remove ${text}` }) : null);
  const li = (text, cents, remove) => h('li', { class: 'spread' }, h('span', null, text, amt(cents)), remove);
  const lines = [
    ...c.labor.map((l) => li(`${l.who || 'Not named'}: ${hoursText(l.hours)} on ${fmtDate(l.worked_on)}`, l.rate_cents === null ? null : Math.round(l.hours * l.rate_cents), rm(l, 'labor', `${l.hours} h by ${l.who || 'unnamed'}`))),
    ...c.equipment.map((e) => li(`${e.asset}: ${hoursText(e.hours)} of equipment`, e.cost, rm(e, 'equipment', `${e.hours} h of ${e.asset}`))),
    ...c.parts.map((x) => li(`${x.qty} ${x.unit} ${x.name} from stock`, x.cost, null)),
    ...c.materials.map((m) => li(`${m.qty}${m.unit ? ` ${m.unit}` : ''} ${m.description}`, m.cost, rm(m, 'materials', m.description))),
    c.vendor_cost_cents !== null && c.vendor_cost_cents !== undefined ? li(`Outside work${c.vendor ? `: ${c.vendor}` : ''}`, c.vendor_cost_cents, null) : null,
    c.downtime_hours ? li(`Out of service ${hoursText(c.downtime_hours)}`, null, null) : null,
  ].filter(Boolean);
  const open = !['cancelled'].includes(w.status);
  clear(box).append(
    h('div', { class: 'spread' }, h('h3', null, 'Costs'), open ? button('Add costs', () => addCosts(w, c, refresh), { small: true }) : null),
    lines.length ? h('ul', { class: 'plain rows' }, lines) : h('p', { class: 'muted' }, 'No hours or materials recorded yet.'),
    lines.length ? h('p', { class: 'wo-total' }, h('b', null, `${hoursText(c.labor_hours)} labor`), c.equipment_hours ? `, ${hoursText(c.equipment_hours)} equipment` : '',
      see && c.total_cents !== null ? h('span', null, ' · ', h('b', null, money(c.total_cents)), h('span', { class: 'muted small' }, ` (labor ${money(c.labor_cents)}, equipment ${money(c.equipment_cents)}, parts and materials ${money(c.parts_cents + c.materials_cents)}${c.vendor_cost_cents ? `, outside ${money(c.vendor_cost_cents)}` : ''})`)) : null) : null);
  return box;
}

/** The department, fund and street as facts on the work order (dt, dd pairs), for a municipality. */
export function booksFacts(w) {
  if (!isMuni()) return null;
  return [
    [h('dt', null, 'Department'), h('dd', null, w.department || 'Not set')],
    [h('dt', null, 'Fund'), h('dd', null, w.fund || 'Not set')],
    w.street ? [h('dt', null, 'Street'), h('dd', null, w.street)] : null,
  ];
}

// ---------------------------------------------------------------- the Done tab: dates and totals
const monthStart = (d) => `${d.slice(0, 8)}01`;
/** From and To for the Done tab, with quick picks. onChange() reloads the list. */
export function doneRange(onChange) {
  const today = todayStr();
  const from = input({ type: 'date', 'aria-label': 'Done from', value: monthStart(today), max: today });
  const to = input({ type: 'date', 'aria-label': 'Done to', value: today, max: today });
  const set = (a, b) => { from.value = a; to.value = b; onChange(); };
  const lastStart = monthStart(addDays(monthStart(today), -1));
  const quick = select([['', 'Pick dates'], ['month', 'This month'], ['last', 'Last month'], ['30', 'Last 30 days'], ['year', 'This year']], 'month', { 'aria-label': 'Dates' });
  quick.addEventListener('change', () => {
    if (quick.value === 'month') set(monthStart(today), today);
    else if (quick.value === 'last') set(lastStart, addDays(monthStart(today), -1));
    else if (quick.value === '30') set(addDays(today, -29), today);
    else if (quick.value === 'year') set(`${today.slice(0, 4)}-01-01`, today);
  });
  for (const el of [from, to]) el.addEventListener('change', () => { quick.value = ''; onChange(); });
  return { el: h('span', { class: 'row tight done-range' }, quick, h('label', { class: 'row tight' }, 'From ', from), h('label', { class: 'row tight' }, 'to ', to)), apply: (q) => { if (from.value) q.set('from', from.value); if (to.value) q.set('to', to.value); q.set('totals', '1'); } };
}

/** "14 work orders · 61.5 h labor · 12 h equipment · $8,412.00" above the Done list. */
export function doneTotals(t) {
  if (!t) return null;
  const stat = (n, text) => h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, text));
  return h('div', { class: 'stats done-totals', role: 'group', 'aria-label': 'Totals' },
    stat(t.count, t.count === 1 ? 'work order done' : 'work orders done'),
    stat(t.labor_hours, 'hours of labor'),
    t.equipment_hours ? stat(t.equipment_hours, 'hours of equipment') : null,
    t.cost_cents !== null && t.cost_cents !== undefined ? stat(money(t.cost_cents), 'cost (labor, equipment, parts, materials, outside)') : null);
}

