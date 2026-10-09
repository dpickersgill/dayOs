import { get, post, patch } from '../api.js';
import { h, clear, can, isManager, table, state, input, select, field, button, toast, formDialog, dialog, tabs, val, num, todayStr, nowInput, fmtDateTime, label, empty, money, toCents, centsToInput, addDays } from '../ui.js';
import { personPicker, waiverPanel } from '../widgets.js';
import { code128 } from '../barcode.js';
import { printDialog } from '../print.js';
import * as more from './rentals-more.js';

export const CATEGORIES = ['ski', 'snowboard', 'boot', 'helmet', 'pole', 'other'];
const ITEM_STATUS = ['available', 'rented', 'maintenance', 'lost', 'retired'];
const gearName = (i) => [i.brand, i.model, i.size].filter(Boolean).join(' ');

export async function render(root) {
  const items = [['counter', 'Counter', drawCounter], ['out', 'Out now', drawOut], ['reservations', 'Reservations', more.drawReservations]];
  if (can('counter')) items.push(['inventory', 'Inventory', drawInventory], ['service', 'Service', more.drawService]);
  if (isManager()) items.push(['reports', 'Reports', more.drawReports], ['settings', 'Settings', more.drawSettings]);
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Rentals')), tabs(items));
}

// ---------------------------------------------------------------- out now
async function drawOut(box) {
  const [{ data }, fees] = await Promise.all([get('/rentals/contracts?status=out'), get('/rentals/charges?status=due')]);
  const now = nowInput().replace('T', ' ');
  const due = fees.data;
  clear(box).append(h('div', { class: 'stack' },
    due.length ? h('div', { class: 'callout' }, h('strong', null, `${due.length} unpaid fee${due.length === 1 ? '' : 's'}`),
      table([
        { head: 'Renter', cell: (c) => `${c.first_name} ${c.last_name}` },
        { head: 'Fee', cell: (c) => `${label(c.kind)}${c.note ? `: ${c.note}` : ''}` },
        { head: 'Amount', cell: (c) => money(c.cents) },
        { head: '', actions: true, cell: (c) => h('span', { class: 'row' }, c.kind === 'deposit' ? null : button('Collect', () => collect(c, () => drawOut(box)), { small: true, kind: 'primary' }), isManager() ? button(c.kind === 'deposit' ? 'Mark returned' : 'Waive', async () => { await post(`/rentals/charges/${c.id}/waive`, {}); toast('Done'); await drawOut(box); }, { small: true }) : null) },
      ], due.filter((c) => c.kind !== 'deposit' || true))) : null,
    data.length ? table([
      { head: 'Renter', cell: (c) => h('span', null, h('strong', null, `${c.first_name} ${c.last_name}`), c.group_name ? ` (${c.group_name})` : '') },
      { head: 'Due back', cell: (c) => fmtDateTime(c.due_at) },
      { head: 'Status', cell: (c) => (String(c.due_at) < now ? state('Overdue', 'bad') : state('Out', 'neutral')) },
      { head: '', actions: true, cell: (c) => h('span', { class: 'row' },
        button('Check in', () => checkIn(c, () => drawOut(box)), { small: true, kind: 'primary' }),
        button('Extend', () => extend(c, () => drawOut(box)), { small: true }),
        button('Swap', () => swap(c, () => drawOut(box)), { small: true })) },
    ], data, { rowClass: (c) => (String(c.due_at) < now ? 'attention' : null) }) : empty('No gear is out right now.')));
}

function collect(charge, done) {
  const method = select([['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']], 'cash', { name: 'method' });
  formDialog(`Collect ${money(charge.cents)}`, h('div', { class: 'form' }, field('Paid by', method)), async (fd) => {
    await post(`/rentals/charges/${charge.id}/collect`, { method: val(fd, 'method') });
    toast('Payment recorded');
    await done();
  }, { submitText: 'Record payment' });
}

function extend(c, done) {
  formDialog(`Extend ${c.first_name} ${c.last_name}`, h('div', { class: 'form' }, field('New return time', input({ type: 'datetime-local', name: 'due', required: true, value: String(c.due_at).replace(' ', 'T').slice(0, 16) }))), async (fd) => {
    await post(`/rentals/contracts/${c.id}/extend`, { due_at: val(fd, 'due') });
    toast('Return time updated');
    await done();
  });
}

async function swap(contract, done) {
  const [c, avail] = await Promise.all([get(`/rentals/contracts/${contract.id}`), get('/rentals/items?status=available&limit=500')]);
  const open = c.items.filter((i) => !i.returned_at);
  const outSel = select(open.map((i) => [String(i.rental_item_id), `${i.sku} ${gearName(i)}`]), '', { name: 'out' });
  const inSel = select(avail.data.map((i) => [String(i.id), `${i.sku} ${label(i.category)} ${gearName(i)}`]), '', { name: 'in' });
  const reason = input({ name: 'reason', maxlength: 200, placeholder: 'Too big, bad fit, broken…' });
  const damaged = h('input', { type: 'checkbox', name: 'damaged' });
  const din = input({ name: 'din', type: 'number', step: '0.25', min: '0.5', max: '20' });
  const tech = input({ name: 'tech', maxlength: 100 });
  formDialog('Swap gear', h('div', { class: 'form' }, field('Bring back', outSel), field('Give instead', inSel), field('Why', reason), h('label', { class: 'check' }, damaged, 'Returned item is damaged (send to service)'),
    field('Binding setting (skis)', din), field('Set by', tech)), async (fd) => {
    const rep = { rental_item_id: Number(val(fd, 'in')) };
    if (num(fd, 'din')) { rep.din_setting = num(fd, 'din'); rep.tech_name = val(fd, 'tech') || undefined; }
    await post(`/rentals/contracts/${contract.id}/swap`, { out_item_id: Number(val(fd, 'out')), reason: val(fd, 'reason') || undefined, damaged: damaged.checked, replacement: rep });
    toast('Gear swapped');
    await done();
  }, { submitText: 'Swap' });
}

async function checkIn(contract, done) {
  const c = await get(`/rentals/contracts/${contract.id}`);
  const open = c.items.filter((i) => !i.returned_at);
  const rows = open.map((i) => ({
    i,
    back: h('input', { type: 'checkbox', checked: true, 'aria-label': `${i.sku} returned` }),
    note: input({ placeholder: 'Damage, if any', maxlength: 500, 'aria-label': `${i.sku} damage notes` }),
    fee: input({ type: 'number', min: '0', step: '0.01', placeholder: 'Fee', 'aria-label': `${i.sku} damage or loss fee`, style: 'width:6rem' }),
    lost: h('input', { type: 'checkbox', 'aria-label': `${i.sku} lost` }),
  }));
  const tbl = table([
    { head: 'Back', cell: (r) => r.back },
    { head: 'Item', cell: (r) => h('span', null, h('strong', null, r.i.sku), ` ${gearName(r.i)}`) },
    { head: 'Damage', cell: (r) => r.note },
    { head: 'Fee', cell: (r) => r.fee },
    { head: 'Lost', cell: (r) => r.lost },
  ], rows);
  const go = button('Check in selected', async () => {
    const items = rows.filter((r) => r.back.checked || r.lost.checked).map((r) => ({
      rental_item_id: r.i.rental_item_id,
      ...(r.lost.checked ? { lost: true } : {}),
      ...(r.note.value.trim() ? { damage_notes: r.note.value.trim() } : {}),
      ...(toCents(r.fee.value) ? { fee_cents: toCents(r.fee.value) } : {}),
    }));
    if (!items.length) throw new Error('Select at least one item');
    const out = await post(`/rentals/contracts/${contract.id}/checkin`, { items });
    const owed = out.fees.reduce((a, f) => a + f.cents, 0);
    toast(owed ? `Returned. ${money(owed)} in fees to collect` : out.outstanding ? `${out.outstanding} item${out.outstanding === 1 ? '' : 's'} still out` : 'All gear returned');
    dlg.close();
    await done();
  }, { kind: 'primary' });
  const dlg = dialog(`Check in for ${contract.first_name} ${contract.last_name}`, [
    h('p', { class: 'muted' }, 'Gear with damage notes goes to service. A late fee is added automatically if the shop charges one.'), tbl, h('div', { class: 'footer row' }, go)], { wide: true });
}

// ---------------------------------------------------------------- counter (check out)
async function drawCounter(box) {
  let person = null;
  const waiverSlot = h('div');
  const profileSlot = h('div');
  const resSlot = h('div');
  const pickupSlot = h('div');
  let reservation = null;
  const people = new Map(); // id -> { id, name }; the renter and anyone else in the group
  const settings = await get('/rentals/settings');
  const picker = personPicker({ label: 'Renter', required: true, onPick: async (p) => {
    person = p; reservation = null;
    people.clear(); clear(waiverSlot); clear(profileSlot); clear(resSlot);
    if (!p) return;
    people.set(p.id, { id: p.id, name: `${p.first_name} ${p.last_name}` });
    waiverSlot.append(waiverPanel(p.id, todayStr(), () => {}));
    profileSlot.append(h('div', { class: 'row' }, button('Sizing profile', () => profile(p)), button('Add someone in the group', () => addMember())));
    const r = (await get(`/rentals/reservations?status=held&from=${addDays(todayStr(), -1)}`)).data.filter((x) => x.person_id === p.id);
    if (r.length) resSlot.append(h('div', { class: 'callout' }, h('strong', null, 'Reservation waiting: '), ...r.map((x) => button(`${x.lines.map((l) => `${l.quantity} ${l.category}`).join(', ')} for ${x.days} day${x.days === 1 ? '' : 's'}`, () => { reservation = x; due.value = `${addDays(x.pickup_on, x.days - 1)}T16:30`; toast('Reservation will be marked picked up'); }, { small: true }))));
    drawPicked();
  } });
  const due = input({ type: 'datetime-local', value: `${todayStr()}T16:30`, name: 'due' });
  const group = input({ name: 'group', maxlength: 120, placeholder: 'Family or school name (optional)' });
  const deposit = input({ name: 'deposit', type: 'number', min: '0', step: '0.01', value: centsToInput(settings.default_deposit_cents) });
  let cat = '';
  let tier = '';
  let sizeSel = '';
  const search = input({ type: 'search', placeholder: 'Search brand, model or SKU', 'aria-label': 'Filter gear' });
  const weight = input({ type: 'number', min: '0', max: '500', placeholder: 'For the chart', 'aria-label': 'Renter weight in pounds' });
  const scan = input({ type: 'text', placeholder: 'Scan, then Enter', 'aria-label': 'Scan a receipt or gear tag', autocomplete: 'off' });
  const list = h('div', { class: 'gear-grid' });
  const catBar = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Type of gear' });
  const sizeBar = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Size' });
  const tierBar = h('div', { class: 'rchips small', role: 'group', 'aria-label': 'Level' });
  const pickedBox = h('div', { class: 'stack' });
  const picked = new Map(); // item id -> { item, who, din, tech, test }
  const summary = h('p', { class: 'muted' });
  let items = [];

  function addMember() {
    const slot = h('div');
    const pk = personPicker({ label: 'Person', required: true, onPick: (p) => {
      clear(slot);
      if (p) { people.set(p.id, { id: p.id, name: `${p.first_name} ${p.last_name}` }); slot.append(waiverPanel(p.id, todayStr(), () => {})); drawPicked(); toast(`${p.first_name} added to this rental`); }
    } });
    dialog('Add someone to this rental', h('div', { class: 'stack' }, pk.el, slot, h('p', { class: 'muted small' }, 'Everyone wearing gear needs a signed waiver for the season.')));
  }
  function profile(p) {
    return new Promise((resolve) => { profileDialog(p, resolve); });
  }
  async function profileDialog(p, resolve) {
    const cur = (await get(`/rentals/profiles/${p.id}`)).profile || {};
    const f = h('div', { class: 'form' },
      field('Ability type', input({ name: 'skier_type', maxlength: 4, value: cur.skier_type || '' }), 'As your shop records it'),
      field('Boot sole length (mm)', input({ name: 'sole', type: 'number', min: '150', max: '400', value: cur.boot_sole_mm || '' })),
      field('Shoe size', input({ name: 'shoe', maxlength: 20, value: cur.shoe_size || '' })),
      field('Stance (boards)', input({ name: 'stance', maxlength: 20, value: cur.stance || '' })),
      field('Helmet size', input({ name: 'helmet', maxlength: 20, value: cur.helmet_size || '' })),
      field('Notes', input({ name: 'notes', maxlength: 500, value: cur.notes || '' })));
    formDialog(`Sizing for ${p.first_name} ${p.last_name}`, f, async (fd) => {
      await (await import('../api.js')).put(`/rentals/profiles/${p.id}`, { skier_type: val(fd, 'skier_type'), boot_sole_mm: num(fd, 'sole'), shoe_size: val(fd, 'shoe'), stance: val(fd, 'stance'), helmet_size: val(fd, 'helmet'), notes: val(fd, 'notes') });
      toast('Sizing saved');
      resolve();
    });
  }

  async function loadItems() {
    items = (await get('/rentals/items?status=available&limit=500')).data;
    drawList();
  }
  const sizeKey = (z) => { const n = parseFloat(z); return Number.isNaN(n) ? [1, 0, String(z)] : [0, n, String(z)]; };
  const bySize = (a, b) => { const x = sizeKey(a.size || ''); const y = sizeKey(b.size || ''); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || a.sku.localeCompare(b.sku); };
  const chip = (text, on, click, extra) => { const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on) }, text, extra ? h('span', { class: 'n' }, String(extra)) : null); b.addEventListener('click', click); return b; };
  function drawList() {
    const needle = search.value.trim().toLowerCase();
    const free = items.filter((i) => !picked.has(i.id));
    // type buttons with how many are free
    clear(catBar).append(chip('All', !cat, () => { cat = ''; sizeSel = ''; tier = ''; drawList(); }, free.length),
      ...CATEGORIES.filter((c) => items.some((i) => i.category === c)).map((c) => chip(label(c), cat === c, () => { cat = c; sizeSel = ''; tier = ''; drawList(); }, free.filter((i) => i.category === c).length)));
    const inCat = items.filter((i) => !cat || i.category === cat);
    // level toggle only when the shop has more than one level in this type
    clear(tierBar);
    if (new Set(inCat.map((i) => i.tier)).size > 1) tierBar.append(chip('Any level', !tier, () => { tier = ''; drawList(); }), chip('Standard', tier === 'standard', () => { tier = 'standard'; drawList(); }), chip('Performance', tier === 'performance', () => { tier = 'performance'; drawList(); }));
    else tier = '';
    const inTier = inCat.filter((i) => !tier || i.tier === tier);
    // size chips
    const sizes = [...new Set(inTier.map((i) => i.size || ''))].sort((a, b) => { const x = sizeKey(a); const y = sizeKey(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
    if (sizeSel && !sizes.includes(sizeSel)) sizeSel = '';
    clear(sizeBar);
    if (sizes.length > 1) sizeBar.append(chip('Any size', !sizeSel, () => { sizeSel = ''; drawList(); }), ...sizes.filter(Boolean).map((z) => chip(z, sizeSel === z, () => { sizeSel = z; drawList(); }, inTier.filter((i) => i.size === z && !picked.has(i.id)).length)));
    const shown = inTier.filter((i) => (!sizeSel || i.size === sizeSel) && (!needle || [i.sku, i.brand, i.model, i.size, i.tier, i.category].filter(Boolean).join(' ').toLowerCase().includes(needle))).sort(bySize);
    clear(list);
    if (!shown.length) { list.append(h('p', { class: 'muted' }, items.length ? 'Nothing free matches. Try another size or type.' : 'No gear is free right now.')); return; }
    for (const i of shown) {
      const on = picked.has(i.id);
      const tile = h('button', { type: 'button', class: `gear-tile${on ? ' on' : ''}`, 'aria-pressed': String(on), 'aria-label': `${i.sku}, ${label(i.category)} ${gearName(i)}${i.tier === 'performance' ? ', performance' : ''}` },
        h('span', { class: 'size' }, i.size || '–'),
        h('span', { class: 'what' }, label(i.category), [i.brand, i.model].filter(Boolean).length ? h('small', { class: 'muted' }, ` ${[i.brand, i.model].filter(Boolean).join(' ')}`) : null), // the kind of gear first, so a 100 pole is not mistaken for a ski
        h('span', { class: 'meta' }, i.sku, i.tier === 'performance' ? h('span', { class: 'tag' }, 'Perf') : null, i.grade ? h('span', { class: 'grade' }, i.grade) : null),
        on ? h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓') : null);
      tile.addEventListener('click', () => { if (picked.has(i.id)) picked.delete(i.id); else pick(i); drawPicked(); drawList(); });
      list.append(tile);
    }
  }
  function pick(i) { picked.set(i.id, { item: i, who: person ? person.id : null, din: '', tech: '', test: '' }); }
  scan.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    if (!code) return;
    scan.value = '';
    try {
      // a receipt (ORD-123), an order number or a ticket code opens the pickup card; anything else is a gear tag
      if (/^ORD-?\d+$/i.test(code) || /^\d{1,9}$/.test(code) || /^[A-Za-z0-9]{20}$/.test(code)) { await openPickup(code); return; }
      const r = await get(`/rentals/lookup?code=${encodeURIComponent(code)}`);
      if (r.item.status !== 'available') throw new Error(`${r.item.sku} is ${r.item.status}${r.contract_id ? ` on contract #${r.contract_id}` : ''}`);
      pick(r.item); drawPicked(); drawList();
      toast(`${r.item.sku} added`);
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---- pickup card: everything about a scanned order
  async function openPickup(code) {
    const d = await get(`/rentals/pickup?code=${encodeURIComponent(code)}`);
    const draw = async () => { const fresh = await get(`/rentals/pickup?code=${encodeURIComponent(code)}`); renderPickup(fresh); };
    renderPickup(d);
    function renderPickup(d) {
      const cm = (inches) => (inches ? `${Math.floor(inches / 12)}'${inches % 12}"` : null);
      const peopleCards = d.people.map((p) => {
        const rp = p.rental_profile || {};
        const size = [cm(p.height_in), p.weight_lb ? `${p.weight_lb} lb` : null, p.boot_size ? `boot ${p.boot_size}` : null, (rp.skier_type || p.skier_type) ? `type ${rp.skier_type || p.skier_type}` : null, p.stance ? label(p.stance) : null, rp.boot_sole_mm ? `sole ${rp.boot_sole_mm} mm` : null, rp.helmet_size ? `helmet ${rp.helmet_size}` : null].filter(Boolean);
        const waiverBox = h('div');
        if (!p.waiver_signed) waiverBox.append(waiverPanel(p.id, todayStr(), () => draw()));
        return h('div', { class: 'pickup-person' },
          p.photo ? h('img', { class: 'pickup-photo', src: p.photo, alt: `Photo of ${p.first_name} ${p.last_name}` }) : h('div', { class: 'pickup-photo none', 'aria-hidden': 'true' }, `${p.first_name[0]}${p.last_name[0]}`),
          h('div', { class: 'stack' },
            h('div', null, h('strong', null, `${p.first_name} ${p.last_name}`), p.age !== null && p.age !== undefined ? ` · ${p.age}${p.age < 18 ? ' (minor)' : ''}` : '', p.is_buyer ? ' · bought it' : ''),
            h('div', { class: 'small muted' }, [p.phone, p.email].filter(Boolean).join(' · ') || 'No contact on file'),
            p.emergency_name || p.emergency_phone ? h('div', { class: 'small muted' }, `Emergency: ${[p.emergency_name, p.emergency_phone].filter(Boolean).join(', ')}`) : null,
            h('div', { class: 'row' }, state(p.waiver_signed ? 'Waiver signed' : 'No waiver', p.waiver_signed ? 'good' : 'bad'), size.length ? h('span', { class: 'small' }, size.join(' · ')) : h('span', { class: 'small muted' }, 'No sizing yet')),
            waiverBox,
            h('div', { class: 'row' }, button('Sizing profile', () => profile(p).then(draw), { small: true }))));
      });
      const nameOfPerson = (id) => { const p = d.people.find((x) => x.id === id); return p ? `${p.first_name} ${p.last_name}` : ''; };
      const others = d.lines.filter((l) => l.line_kind !== 'rental');
      const contractBlocks = d.contracts.map((c) => h('div', { class: 'stack' },
        h('div', { class: 'spread' }, h('strong', null, `Contract #${c.id}${c.group_name ? ` · ${c.group_name}` : ''}`), h('span', { class: 'small muted' }, `Due ${fmtDateTime(c.due_at)} · ${label(c.status)}`)),
        ...c.items.map((it) => fitRow(c, it, nameOfPerson(it.person_id || c.person_id), d.require_binding_record))));
      pickupSlot.className = 'panel pickup';
      clear(pickupSlot).append(...[
        h('div', { class: 'spread' }, h('h2', null, `Order #${d.order.id}`), h('span', { class: 'row' }, h('span', { class: 'muted small' }, `${fmtDateTime(d.order.created_at)} · ${money(d.order.total_cents)} · ${label(d.order.status)}`), button('Close', () => { clear(pickupSlot); pickupSlot.className = ''; }, { small: true }))),
        d.order.status === 'refunded' ? h('div', { class: 'error-box' }, 'This order was refunded.') : null,
        h('div', { class: 'pickup-people' }, ...peopleCards),
        contractBlocks.length ? h('div', { class: 'stack' }, h('h3', null, 'Gear for this order'), ...contractBlocks) : h('p', { class: 'muted' }, 'No rental gear was sold on this order.'),
        others.length ? h('div', { class: 'small muted' }, `Also on the order: ${others.map((l) => `${l.name || label(l.line_kind)}${l.person_id ? ` (${nameOfPerson(l.person_id)})` : ''}`).join(', ')}`) : null].filter(Boolean));
    }
  }
  function fitRow(c, it, who, required) {
    const wearable = it.category === 'ski' || it.category === 'snowboard';
    const din = input({ type: 'number', step: '0.25', min: '0.5', max: '20', value: it.din_setting == null ? '' : Number(it.din_setting), placeholder: 'Setting', 'aria-label': `Binding setting ${it.sku}`, style: 'width:5.5rem' });
    const tech = input({ value: it.tech_name || '', placeholder: 'Set by', maxlength: 100, 'aria-label': `Technician ${it.sku}`, style: 'width:7rem' });
    const test = select([['', 'Test'], ['pass', 'Passed'], ['fail', 'Failed']], it.test_result || '', { 'aria-label': `Binding test ${it.sku}`, style: 'width:8rem' });
    const save = button('Save fitting', async () => {
      const body = { ...(din.value !== '' ? { din_setting: Number(din.value) } : {}), ...(tech.value.trim() ? { tech_name: tech.value.trim() } : {}), ...(test.value ? { test_result: test.value } : {}) };
      if (!Object.keys(body).length) throw new Error('Enter the setting, who set it, or the test result');
      const r = await patch(`/rentals/contracts/${c.id}/items/${it.rental_item_id}`, body);
      toast(r.failed ? 'Saved. That binding failed its test, so swap the gear from Out now.' : 'Fitting saved', r.failed ? 'error' : 'ok');
    }, { small: true });
    const done = Boolean(it.returned_at);
    return h('div', { class: 'cart-line' },
      h('div', { class: 'spread' }, h('span', null, h('strong', null, it.sku), ` ${label(it.category)} ${gearName(it)}${who ? ` · for ${who}` : ''}`), done ? state('Returned', 'neutral') : (!wearable ? null : (it.din_setting != null && it.tech_name ? state('Fitted', 'good') : state(required ? 'Needs fitting' : 'Not fitted', required ? 'warn' : 'neutral')))),
      wearable && !done ? h('div', { class: 'row' }, din, tech, test, save) : null);
  }
  function drawPicked() {
    clear(pickedBox);
    summary.textContent = picked.size ? `${picked.size} item${picked.size === 1 ? '' : 's'} selected` : 'Tap gear to add it.';
    for (const r of picked.values()) {
      const who = people.size > 1 ? (() => { const sel = select([...people.values()].map((p) => [String(p.id), p.name]), String(r.who || ''), { 'aria-label': `Who uses ${r.item.sku}` }); sel.addEventListener('change', () => { r.who = Number(sel.value); }); return sel; })() : null;
      pickedBox.append(h('div', { class: 'cart-line' },
        h('div', { class: 'spread' }, h('span', null, h('strong', null, r.item.sku), ` ${label(r.item.category)} ${gearName(r.item)}`), button('Remove', () => { picked.delete(r.item.id); drawPicked(); drawList(); }, { small: true })),
        who,
        r.item.category === 'ski' || r.item.category === 'snowboard' ? bindingCell(r) : null));
    }
  }
  function bindingCell(r) {
    const din = input({ type: 'number', step: '0.25', min: '0.5', max: '20', value: r.din, placeholder: 'Setting', 'aria-label': `Binding setting ${r.item.sku}`, style: 'width:5.5rem' });
    const tech = input({ value: r.tech, placeholder: 'Set by', maxlength: 100, 'aria-label': `Technician ${r.item.sku}`, style: 'width:7rem' });
    const test = select([['', 'Test'], ['pass', 'Passed'], ['fail', 'Failed']], r.test, { 'aria-label': `Binding test ${r.item.sku}`, style: 'width:8rem' });
    din.addEventListener('input', () => { r.din = din.value; });
    tech.addEventListener('input', () => { r.tech = tech.value; });
    test.addEventListener('change', () => { r.test = test.value; });
    const hint = button('Chart', async () => {
      const pr = r.who ? (await get(`/rentals/profiles/${r.who}`)).profile : null;
      const w = Number(weight.value || 0);
      if (!pr || !pr.skier_type) throw new Error('Add an ability type in the sizing profile first');
      const q = new URLSearchParams({ skier_type: pr.skier_type, ...(w ? { weight_lb: w } : {}), ...(pr.boot_sole_mm ? { sole_mm: pr.boot_sole_mm } : {}) });
      const res = (await get(`/rentals/chart/suggest?${q}`)).data;
      if (!res.length) throw new Error('Nothing in your chart matches. Set it by your shop procedure.');
      din.value = Number(res[0].din); r.din = din.value;
      toast('Filled from your chart. Check it before you set the binding.');
    }, { small: true });
    return h('span', { class: 'row' }, din, tech, test, hint);
  }

  search.addEventListener('input', drawList);

  const go = button('Check out gear', async () => {
    if (!person) throw new Error('Choose who is renting');
    if (!picked.size) throw new Error('Select the gear');
    if (!due.value) throw new Error('Set when it is due back');
    const body = {
      person_id: person.id, due_at: due.value,
      ...(group.value.trim() ? { group_name: group.value.trim() } : {}),
      ...(deposit.value !== '' ? { deposit_cents: toCents(deposit.value) } : {}),
      ...(reservation ? { reservation_id: reservation.id } : {}),
      items: [...picked.values()].map((r) => ({
        rental_item_id: r.item.id,
        ...(people.size > 1 && r.who && r.who !== person.id ? { person_id: r.who } : {}),
        ...(r.din !== '' ? { din_setting: Number(r.din) } : {}),
        ...(r.tech.trim() ? { tech_name: r.tech.trim() } : {}),
        ...(r.test ? { test_result: r.test } : {}),
      })),
    };
    const out = await post('/rentals/contracts', body);
    toast(`Contract #${out.id} created`);
    picked.clear(); reservation = null;
    drawPicked();
    await loadItems();
  }, { kind: 'primary' });

  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'scan-bar' }, field('Scan a receipt or a gear tag', scan, 'A receipt opens the order and the renter details. A gear tag adds that gear to the rental.')),
    pickupSlot,
    picker.el, waiverSlot, profileSlot, resSlot,
    h('div', { class: 'rent-layout' },
      h('section', { class: 'rent-pick', 'aria-label': 'Choose gear' },
        h('div', { class: 'rent-find' }, search),
        catBar, tierBar, sizeBar, list),
      h('aside', { class: 'rent-cart panel', 'aria-label': 'This rental' },
        h('h2', null, 'This rental'),
        pickedBox, summary,
        h('div', { class: 'form' }, field('Due back', due), field('Group', group), field('Deposit held ($)', deposit), field('Weight (lb)', weight)),
        h('div', { class: 'row' }, go),
        h('p', { class: 'muted small' }, settings.require_binding_record ? 'Your shop requires a binding setting and technician name for every ski before it goes out.' : 'Everyone wearing gear needs a signed waiver for this season.')))));
  await loadItems();
  drawPicked();
}

// ---------------------------------------------------------------- inventory
async function drawInventory(box) {
  const { data } = await get('/rentals/items?limit=500');
  const reload = async () => { const n = h('div'); await drawInventory(n); clear(box).append(...n.childNodes); };
  const counts = ITEM_STATUS.map((s) => `${data.filter((i) => i.status === s).length} ${label(s).toLowerCase()}`).join(', ');
  const needle = input({ type: 'search', placeholder: 'Search SKU, brand, model or serial', 'aria-label': 'Search inventory' });
  const body = h('div');
  const catSel = select([['', 'All types'], ...CATEGORIES.map((c) => [c, label(c)])], '');
  function drawRows() {
    const q = needle.value.trim().toLowerCase();
    const shown = data.filter((i) => (!catSel.value || i.category === catSel.value) && (!q || [i.sku, i.brand, i.model, i.serial_no].filter(Boolean).join(' ').toLowerCase().includes(q)));
    clear(body).append(shown.length ? table([
      { head: 'SKU', cell: (i) => h('strong', null, i.sku) },
      { head: 'Type', cell: (i) => label(i.category) + (i.tier === 'performance' ? ' (perf.)' : '') },
      { head: 'Gear', cell: (i) => [i.brand, i.model].filter(Boolean).join(' ') },
      { head: 'Size', cell: (i) => i.size || '' },
      { head: 'Uses', cell: (i) => String(i.uses_count) },
      { head: 'Status', cell: (i) => state(label(i.status), i.status === 'available' ? 'good' : i.status === 'rented' ? 'neutral' : 'warn') },
      { head: '', actions: true, cell: (i) => h('span', { class: 'row' }, button('History', () => history(i), { small: true }), button('Tag', () => printTags([i]), { small: true }), isManager() ? button('Edit', () => editItem(i, reload), { small: true }) : null) },
    ], shown) : empty('No gear matches.'));
  }
  needle.addEventListener('input', drawRows); catSel.addEventListener('change', drawRows);
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, counts), h('span', { class: 'row' },
      button('Print tags', () => printTags(data.filter((i) => !catSel.value || i.category === catSel.value).slice(0, 60)), { small: true }),
      isManager() ? button('Import list', () => importItems(reload), { small: true }) : null,
      isManager() ? button('Add gear', () => editItem(null, reload), { kind: 'primary' }) : null)),
    h('div', { class: 'row' }, needle, catSel), body));
  drawRows();
}

function printTags(list) {
  if (!list.length) return;
  printDialog('Gear tags', h('div', { class: 'tag-sheet' }, ...list.map((i) => h('div', { class: 'gear-tag' }, code128(i.sku, { height: 40, module: 1.6 }), h('div', null, h('strong', null, i.sku)), h('div', { class: 'small' }, `${label(i.category)} ${gearName(i)}`)))));
}

async function history(i) {
  const r = await get(`/rentals/items/${i.id}/history`);
  dialog(`${i.sku} history`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `${[i.brand, i.model, i.size].filter(Boolean).join(' ')} · ${r.item.uses_count} rentals${r.item.last_service_at ? ` · last service ${fmtDateTime(r.item.last_service_at)}` : ''}`),
    h('h3', null, 'Service'), r.service.length ? table([{ head: 'When', cell: (s) => fmtDateTime(s.done_at) }, { head: 'Work', cell: (s) => label(s.kind) }, { head: 'Notes', cell: (s) => s.notes || '' }, { head: 'By', cell: (s) => s.done_by || '' }], r.service) : h('p', { class: 'muted' }, 'No service recorded.'),
    h('h3', null, 'Recent rentals'), r.rentals.length ? table([{ head: 'Renter', cell: (x) => `${x.first_name} ${x.last_name}` }, { head: 'Out', cell: (x) => fmtDateTime(x.created_at) }, { head: 'Setting', cell: (x) => (x.din_setting == null ? '' : `${Number(x.din_setting)}${x.tech_name ? ` by ${x.tech_name}` : ''}`) }, { head: 'Damage', cell: (x) => x.damage_notes || '' }], r.rentals) : h('p', { class: 'muted' }, 'Not rented yet.')), { wide: true });
}

function importItems(done) {
  const ta = h('textarea', { name: 'csv', rows: 10, placeholder: 'sku,category,brand,model,size,serial_no,tier,boot_sole_mm,location\nSK-101,ski,Brand,Model,160,SER123,standard,,Rack A' });
  formDialog('Import gear', h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Paste rows from a spreadsheet saved as CSV. The first row is the column names. Existing SKUs are skipped.'), ta), async () => {
    const lines = ta.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('Add a header row and at least one gear row');
    const head = lines[0].split(',').map((c) => c.trim());
    if (!head.includes('sku') || !head.includes('category')) throw new Error('The first row needs at least sku and category');
    const rows = lines.slice(1).map((l) => {
      const cells = l.split(',').map((c) => c.trim());
      const o = {};
      head.forEach((k, n) => { if (cells[n]) o[k] = ['boot_sole_mm'].includes(k) ? Number(cells[n]) : cells[n]; });
      return o;
    });
    const r = await post('/rentals/items/import', { rows });
    toast(`${r.added} added${r.skipped.length ? `, ${r.skipped.length} already existed` : ''}`);
    await done();
  }, { submitText: 'Import', wide: true });
}

function editItem(i, done) {
  const f = h('div', { class: 'form' },
    field('SKU', input({ name: 'sku', required: true, maxlength: 60, value: i ? i.sku : '' }), 'The code on the gear tag'),
    field('Type', select(CATEGORIES, i ? i.category : 'ski', { name: 'category' })),
    field('Level', select([['standard', 'Standard'], ['performance', 'Performance']], i ? i.tier : 'standard', { name: 'tier' })),
    field('Brand', input({ name: 'brand', maxlength: 100, value: i && i.brand ? i.brand : '' })),
    field('Model', input({ name: 'model', maxlength: 100, value: i && i.model ? i.model : '' })),
    field('Size', input({ name: 'size', maxlength: 30, value: i && i.size ? i.size : '' })),
    field('Serial number', input({ name: 'serial', maxlength: 80, value: i && i.serial_no ? i.serial_no : '' })),
    field('Boot sole length (mm)', input({ name: 'sole', type: 'number', min: '150', max: '400', value: i && i.boot_sole_mm ? i.boot_sole_mm : '' })),
    field('Condition', select([['', 'Not graded'], ['A', 'A (like new)'], ['B', 'B'], ['C', 'C'], ['D', 'D (retire soon)']], i && i.grade ? i.grade : '', { name: 'grade' })),
    field('Bought on', input({ name: 'bought', type: 'date', value: i && i.purchased_on ? String(i.purchased_on).slice(0, 10) : '' })),
    field('Cost ($)', input({ name: 'cost', type: 'number', min: '0', step: '0.01', value: i && i.cost_cents != null ? centsToInput(i.cost_cents) : '' })),
    field('Location', input({ name: 'location', maxlength: 60, value: i && i.location ? i.location : '' }), 'Rack, bay or shelf'),
    i ? field('Status', select(ITEM_STATUS, i.status, { name: 'status' })) : null,
    field('Notes', input({ name: 'notes', maxlength: 500, value: i && i.notes ? i.notes : '' })));
  formDialog(i ? `Edit ${i.sku}` : 'Add gear', f, async (fd) => {
    const body = { sku: val(fd, 'sku'), category: val(fd, 'category'), tier: val(fd, 'tier'), brand: val(fd, 'brand'), model: val(fd, 'model'), size: val(fd, 'size'), serial_no: val(fd, 'serial'), boot_sole_mm: num(fd, 'sole'), grade: val(fd, 'grade'), purchased_on: val(fd, 'bought'), cost_cents: val(fd, 'cost') === null ? null : toCents(val(fd, 'cost')), location: val(fd, 'location'), notes: val(fd, 'notes') };
    if (i) { body.status = val(fd, 'status'); await patch(`/rentals/items/${i.id}`, body); } else await post('/rentals/items', body);
    toast('Gear saved');
    await done();
  }, { wide: true });
}
