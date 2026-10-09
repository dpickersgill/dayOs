import { get, post, patch, put } from '../api.js';
import { h, clear, table, state, input, select, field, button, toast, formDialog, val, todayStr, fmtDate, fmtDateTime, label, empty, money, toCents, centsToInput, addDays } from '../ui.js';
import { personPicker } from '../widgets.js';

const CATEGORIES = ['ski', 'snowboard', 'boot', 'helmet', 'pole', 'other'];

// ---------------------------------------------------------------- reservations
export async function drawReservations(box) {
  const from = todayStr();
  const { data } = await get(`/rentals/reservations?from=${addDays(from, -7)}`);
  const reload = async () => { const n = h('div'); await drawReservations(n); clear(box).append(...n.childNodes); };
  const shown = data.filter((r) => r.status === 'held' || r.pickup_on >= from);
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Hold gear ahead of time. Held gear is counted against availability for those dates. Pick it up from the Counter tab.'), button('New reservation', () => newReservation(reload), { kind: 'primary' })),
    shown.length ? table([
      { head: 'Pickup', cell: (r) => `${fmtDate(r.pickup_on)} · ${r.days} day${r.days === 1 ? '' : 's'}` },
      { head: 'Renter', cell: (r) => h('strong', null, `${r.first_name} ${r.last_name}`) },
      { head: 'Gear', cell: (r) => r.lines.map((l) => `${l.quantity} ${l.tier === 'performance' ? 'performance ' : ''}${l.category}`).join(', ') },
      { head: 'Status', cell: (r) => state(label(r.status), r.status === 'held' ? 'neutral' : r.status === 'picked_up' ? 'good' : 'warn') },
      { head: '', actions: true, cell: (r) => (r.status === 'held' ? h('span', { class: 'row' },
        button('No-show', async () => { await patch(`/rentals/reservations/${r.id}`, { status: 'no_show' }); await reload(); }, { small: true }),
        button('Cancel', async () => { await patch(`/rentals/reservations/${r.id}`, { status: 'cancelled' }); await reload(); }, { small: true })) : null) },
    ], shown) : empty('No reservations coming up.')));
}

function newReservation(done) {
  let person = null;
  const picker = personPicker({ label: 'Renter', required: true, onPick: (p) => { person = p; } });
  const lines = [];
  const lineBox = h('div', { class: 'stack' });
  const pickup = input({ type: 'date', name: 'pickup', required: true, value: todayStr(), min: todayStr() });
  const days = input({ type: 'number', name: 'days', min: '1', max: '60', value: '1', required: true });
  const avail = h('p', { class: 'muted small' });
  async function showAvail() {
    if (!pickup.value) return;
    const r = await get(`/rentals/availability?from=${pickup.value}&days=${days.value || 1}`);
    avail.textContent = r.data.length ? `Free for those dates: ${r.data.map((d) => `${d.free} ${d.tier === 'performance' ? 'performance ' : ''}${d.category}`).join(', ')}` : 'Add gear to your inventory first.';
  }
  pickup.addEventListener('change', showAvail); days.addEventListener('change', showAvail);
  function addLine() {
    const l = { cat: select(CATEGORIES.map((c) => [c, label(c)]), 'ski'), tier: select([['standard', 'Standard'], ['performance', 'Performance']], 'standard'), qty: input({ type: 'number', min: '1', max: '100', value: '1', style: 'width:5rem' }), size: input({ maxlength: 60, placeholder: 'Sizes or notes' }) };
    lines.push(l);
    lineBox.append(h('div', { class: 'row' }, l.cat, l.tier, l.qty, l.size));
  }
  addLine();
  const notes = input({ name: 'notes', maxlength: 500 });
  formDialog('New reservation', h('div', { class: 'stack' }, picker.el, h('div', { class: 'form' }, field('Pickup date', pickup), field('Days', days)), avail, lineBox, button('Add another kind of gear', addLine, { small: true }), field('Notes', notes)), async () => {
    if (!person) throw new Error('Choose who is renting');
    await post('/rentals/reservations', { person_id: person.id, pickup_on: pickup.value, days: Number(days.value), notes: notes.value.trim() || undefined,
      lines: lines.map((l) => ({ category: l.cat.value, tier: l.tier.value, quantity: Number(l.qty.value), ...(l.size.value.trim() ? { size_note: l.size.value.trim() } : {}) })) });
    toast('Reservation saved');
    await done();
  }, { wide: true });
  showAvail();
}

// ---------------------------------------------------------------- service
export async function drawService(box) {
  const r = await get('/rentals/service');
  const reload = async () => { const n = h('div'); await drawService(n); clear(box).append(...n.childNodes); };
  const cols = (shop) => [
    { head: 'SKU', cell: (i) => h('strong', null, i.sku) },
    { head: 'Gear', cell: (i) => `${label(i.category)} ${[i.brand, i.model, i.size].filter(Boolean).join(' ')}` },
    { head: shop ? 'Notes' : 'Rentals since service', cell: (i) => (shop ? i.notes || '' : String(i.uses_count - i.uses_at_service)) },
    { head: '', actions: true, cell: (i) => button('Log work', () => logWork(i, reload), { small: true, kind: 'primary' }) },
  ];
  clear(box).append(h('div', { class: 'stack' },
    h('h3', null, 'In the shop'), r.in_shop.length ? table(cols(true), r.in_shop) : empty('Nothing is waiting for service.'),
    r.service_every_uses ? h('div', null, h('h3', null, `Due for service (every ${r.service_every_uses} rentals)`), r.due.length ? table(cols(false), r.due) : empty('Nothing is due.')) : h('p', { class: 'muted' }, 'Set "Service every" in Settings to see gear due for a tune.')));
}

function logWork(i, done) {
  const rack = h('input', { type: 'checkbox', name: 'rack', checked: i.status === 'maintenance' });
  formDialog(`Service ${i.sku}`, h('div', { class: 'form' },
    field('Work done', select([['tune', 'Tune'], ['wax', 'Wax'], ['repair', 'Repair'], ['binding_test', 'Binding test'], ['inspection', 'Inspection'], ['other', 'Other']], 'tune', { name: 'kind' })),
    field('Done by', input({ name: 'by', maxlength: 100 })), field('Cost ($)', input({ name: 'cost', type: 'number', min: '0', step: '0.01' })), field('Notes', input({ name: 'notes', maxlength: 500 })),
    i.status === 'maintenance' ? h('label', { class: 'check' }, rack, 'Back on the rack when saved') : null), async (fd) => {
    await post(`/rentals/items/${i.id}/service`, { kind: val(fd, 'kind'), done_by: val(fd, 'by') || undefined, cost_cents: val(fd, 'cost') ? toCents(val(fd, 'cost')) : undefined, notes: val(fd, 'notes') || undefined, return_to_rack: rack.checked });
    toast('Service logged');
    await done();
  });
}

// ---------------------------------------------------------------- reports
export async function drawReports(box) {
  const from = input({ type: 'date', value: addDays(todayStr(), -29) });
  const to = input({ type: 'date', value: todayStr() });
  const out = h('div');
  async function run() {
    const r = await get(`/rentals/reports?from=${from.value}&to=${to.value}`);
    const fee = (k, st) => r.fees.filter((f) => f.kind === k && (!st || f.status === st)).reduce((a, f) => a + Number(f.cents), 0);
    const nres = (s) => (r.reservations.find((x) => x.status === s) || { n: 0 }).n;
    const total = r.fleet.reduce((a, f) => a + f.n, 0);
    clear(out).append(h('div', { class: 'stack' },
      h('div', { class: 'tiles' },
        stat('Contracts', r.contracts), stat('Pieces out', r.pieces.reduce((a, p) => a + p.n, 0)), stat('Fleet', total),
        stat('Late fees', money(fee('late'))), stat('Damage and loss fees', money(fee('damage') + fee('loss'))), stat('Fees unpaid', money(r.fees.filter((f) => f.status === 'due' && f.kind !== 'deposit').reduce((a, f) => a + Number(f.cents), 0))),
        stat('Damaged returns', r.damaged), stat('No-shows', nres('no_show')), stat('Cancelled', nres('cancelled'))),
      h('h3', null, 'Pieces rented by type'), r.pieces.length ? table([{ head: 'Type', cell: (p) => label(p.category) }, { head: 'Pieces', cell: (p) => String(p.n) }], r.pieces) : empty('No rentals in this period.'),
      h('h3', null, 'Most rented gear'), r.top_items.length ? table([{ head: 'SKU', cell: (i) => i.sku }, { head: 'Gear', cell: (i) => `${label(i.category)} ${[i.brand, i.model].filter(Boolean).join(' ')}` }, { head: 'Rentals', cell: (i) => String(i.n) }], r.top_items) : null,
      h('h3', null, 'Overdue now'), r.overdue.length ? table([{ head: 'Contract', cell: (c) => `#${c.id}` }, { head: 'Renter', cell: (c) => `${c.first_name} ${c.last_name}` }, { head: 'Was due', cell: (c) => fmtDateTime(c.due_at) }], r.overdue) : h('p', { class: 'muted' }, 'Nothing is overdue.'),
      h('h3', null, 'Fleet'), table([{ head: 'Type', cell: (f) => `${label(f.category)}${f.tier === 'performance' ? ' (performance)' : ''}` }, { head: 'Status', cell: (f) => label(f.status) }, { head: 'Count', cell: (f) => String(f.n) }], r.fleet)));
  }
  const go = button('Show', run, { kind: 'primary' });
  clear(box).append(h('div', { class: 'stack' }, h('div', { class: 'row' }, field('From', from), field('To', to), go), out));
  await run();
}
const stat = (name, value) => h('div', { class: 'card stat' }, h('div', { class: 'muted small' }, name), h('div', { class: 'big' }, String(value)));

// ---------------------------------------------------------------- settings and binding chart
export async function drawSettings(box) {
  const [s, chart] = await Promise.all([get('/rentals/settings'), get('/rentals/chart')]);
  const f = {
    fee: input({ type: 'number', min: '0', step: '0.01', value: centsToInput(s.late_fee_cents_per_day) }),
    grace: input({ type: 'number', min: '0', max: '1440', value: s.late_grace_minutes }),
    dep: input({ type: 'number', min: '0', step: '0.01', value: centsToInput(s.default_deposit_cents) }),
    svc: input({ type: 'number', min: '0', max: '1000', value: s.service_every_uses }),
    bind: h('input', { type: 'checkbox', checked: s.require_binding_record }),
  };
  const save = button('Save settings', async () => {
    await put('/rentals/settings', { late_fee_cents_per_day: toCents(f.fee.value || '0'), late_grace_minutes: Number(f.grace.value || 0), default_deposit_cents: toCents(f.dep.value || '0'), service_every_uses: Number(f.svc.value || 0), require_binding_record: f.bind.checked });
    toast('Settings saved');
  }, { kind: 'primary' });
  const rowsEl = h('div', { class: 'stack' });
  const rows = chart.data.map((r) => ({ ...r }));
  function drawRows() {
    clear(rowsEl);
    if (!rows.length) rowsEl.append(h('p', { class: 'muted' }, 'No rows yet. Without a chart the Chart button at the counter has nothing to suggest.'));
    rows.forEach((r, n) => {
      const cell = (k, w = '5rem', step = '1') => { const e = input({ type: 'number', min: '0', step, value: r[k] ?? '', style: `width:${w}`, 'aria-label': k.replace(/_/g, ' ') }); e.addEventListener('input', () => { r[k] = e.value === '' ? null : Number(e.value); }); return e; };
      const type = input({ value: r.skier_type || '', maxlength: 4, style: 'width:4rem', 'aria-label': 'ability type' }); type.addEventListener('input', () => { r.skier_type = type.value; });
      rowsEl.append(h('div', { class: 'row' }, type, cell('weight_lb_min'), cell('weight_lb_max'), cell('sole_mm_min'), cell('sole_mm_max'), cell('din', '5rem', '0.25'), button('Remove', () => { rows.splice(n, 1); drawRows(); }, { small: true })));
    });
  }
  drawRows();
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'form' },
      field('Late fee per day ($)', f.fee, 'Zero means no late fee'), field('Grace period (minutes)', f.grace, 'Time after the due time before fees start'),
      field('Default deposit ($)', f.dep), field('Service every (rentals)', f.svc, 'Zero turns service reminders off'),
      h('label', { class: 'check' }, f.bind, 'Require binding setting and technician for skis')), h('div', { class: 'row' }, save),
    h('h3', null, 'Binding chart'),
    h('p', { class: 'muted' }, 'Enter the release settings your shop uses, from your binding manufacturer and the standard you follow. SummitOps does not supply values. The Chart button at the counter only looks up what you enter here, and the technician still records what they set.'),
    h('div', { class: 'row muted small' }, 'Type · Weight min · max (lb) · Sole min · max (mm) · Setting'),
    rowsEl,
    h('div', { class: 'row' }, button('Add row', () => { rows.push({ skier_type: '', din: '' }); drawRows(); }, { small: true }),
      button('Save chart', async () => {
        const clean = rows.filter((r) => r.skier_type && r.din !== '' && r.din != null).map((r) => ({ skier_type: r.skier_type, weight_lb_min: r.weight_lb_min ?? null, weight_lb_max: r.weight_lb_max ?? null, height_in_min: r.height_in_min ?? null, height_in_max: r.height_in_max ?? null, sole_mm_min: r.sole_mm_min ?? null, sole_mm_max: r.sole_mm_max ?? null, din: Number(r.din) }));
        await put('/rentals/chart', { rows: clean });
        toast(`${clean.length} chart row${clean.length === 1 ? '' : 's'} saved`);
      }, { kind: 'primary' }))));
}
