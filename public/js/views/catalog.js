import { get, post, put, patch, del } from '../api.js';
import { h, clear, money, toCents, centsToInput, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, tabs, val, num, fmtDate, label, empty, isManager, errorBox } from '../ui.js';
import { loadTypes, typeName, forget } from '../guesttypes.js';

const KINDS = ['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'lesson', 'rental', 'program', 'voucher'];

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Products and prices')),
    tabs([['products', 'Products', drawProducts], ['types', 'Guest types', drawTypes], ['promos', 'Promo codes', drawPromos]]));
}

// ---------------------------------------------------------------- guest types (routes/guesttypes.js)
const ageText = (t) => (t.min_age == null && t.max_age == null ? 'Any age (chosen at the counter)' : t.max_age == null ? `${t.min_age} and over` : !t.min_age ? `Under ${t.max_age + 1}` : `${t.min_age} to ${t.max_age}`);
const off = (b, no) => { b.disabled = no; return b; };
async function drawTypes(box) {
  let types;
  try { types = await loadTypes(true); } catch (err) { clear(box).append(errorBox(err)); return; }
  const again = async () => { forget(); await drawTypes(box); };
  const mgr = isManager();
  const move = async (i, by) => {
    const codes = types.map((t) => t.code); const [c] = codes.splice(i, 1); codes.splice(i + by, 0, c);
    await post('/guest-types/order', { codes }); await again();
  };
  clear(box).append(h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'The kinds of guest you price by. Each product can have its own price for each type; a type with no price uses the product’s base price. Online, a guest’s age on the day picks their type (the narrowest age range wins); types marked Online can also be chosen by guests who give no date of birth.'),
    mgr ? h('div', { class: 'row' }, button('Add a guest type', () => editType(null, again), { kind: 'primary' })) : null,
    table([
      { head: 'Guest type', cell: (t) => h('span', null, h('strong', null, t.name), t.hidden ? [' ', state('Hidden', 'neutral')] : null) },
      { head: 'Ages online', cell: (t) => ageText(t) },
      { head: 'Online', cell: (t) => (t.online ? 'Can be chosen' : 'Counter only') },
      { head: '', actions: true, cell: (t) => (mgr ? [
        off(button('↑', () => move(types.indexOf(t), -1), { small: true, label: `Move ${t.name} up` }), types.indexOf(t) === 0),
        off(button('↓', () => move(types.indexOf(t), 1), { small: true, label: `Move ${t.name} down` }), types.indexOf(t) === types.length - 1),
        button('Edit', () => editType(t, again), { small: true }),
        button(t.hidden ? 'Show' : 'Hide', async () => { await patch(`/guest-types/${t.code}`, { hidden: !t.hidden }); toast(t.hidden ? `${t.name} is back` : `${t.name} is hidden: no longer sold`); await again(); }, { small: true }),
        button('Delete', () => confirmDialog(`Delete ${t.name}?`, 'Only a type that has never had a price or a sale can be deleted. Otherwise, hide it.', 'Delete', async () => { await del(`/guest-types/${t.code}`); toast('Deleted'); await again(); }, { danger: true }), { small: true }),
      ] : null) },
    ], types)));
}
function editType(t, done) {
  const name = input({ name: 'name', required: true, maxlength: 60, value: t ? t.name : '', placeholder: 'For example: College, Local, Twilight' });
  const min = input({ name: 'min_age', type: 'number', min: 0, max: 120, value: t && t.min_age != null ? String(t.min_age) : '' });
  const max = input({ name: 'max_age', type: 'number', min: 0, max: 120, value: t && t.max_age != null ? String(t.max_age) : '' });
  const online = h('input', { type: 'checkbox', name: 'online', checked: t ? t.online : true });
  formDialog(t ? `Edit ${t.name}` : 'Add a guest type', h('div', { class: 'stack' }, field('Name', name),
    h('div', { class: 'form' }, field('From age (optional)', min), field('To age (optional)', max)),
    h('p', { class: 'muted small' }, 'Leave the ages blank for a type staff choose at the counter, like Military or Local.'),
    h('label', { class: 'check-row' }, online, h('span', null, 'Guests can choose it online when they give no date of birth'))), async (fd) => {
    const n = (k) => (val(fd, k) === '' || val(fd, k) === undefined ? null : Number(val(fd, k)));
    const body = { name: val(fd, 'name'), min_age: n('min_age'), max_age: n('max_age'), online: online.checked };
    if (t) await patch(`/guest-types/${t.code}`, body); else await post('/guest-types', body);
    toast(t ? 'Saved' : 'Guest type added');
    await done();
  }, { submitText: t ? 'Save' : 'Add guest type' });
}

function need(cents, name) {
  if (cents === null) throw new Error(`${name} must be an amount like 49.00`);
  return cents;
}

// ---------------------------------------------------------------- products
async function drawProducts(box) {
  const { data } = await get('/products?limit=500');
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'row' }, button('Add product', () => editProduct(null, async () => { clear(box); box.append(...(await rebuild())); }), { kind: 'primary' })));
  async function rebuild() { const n = h('div'); await drawProducts(n); return [...n.childNodes]; }
  wrap.append(data.length ? table([
    { head: 'Product', cell: (p) => h('strong', null, p.name) },
    { head: 'Kind', cell: (p) => label(p.kind) },
    { head: 'Base price', num: true, cell: (p) => money(p.base_price_cents) },
    { head: 'Days', num: true, cell: (p) => String(p.valid_days) },
    { head: 'Rides', num: true, cell: (p) => (p.uses === null ? 'Unlimited' : String(p.uses)) },
    { head: 'Rules', cell: (p) => rulesText(p) },
    { head: 'Status', cell: (p) => [state(p.active ? 'Selling' : 'Off sale', p.active ? 'good' : 'neutral'), p.online ? state('Online', 'good') : null] },
    { head: '', actions: true, cell: (p) => [
      button('Edit', () => editProduct(p, async () => { clear(box); box.append(...(await rebuild())); }), { small: true }),
      button('Prices', () => pricing(p), { small: true }),
    ] },
  ], data) : empty('No products yet. Add your day tickets first.'));
  clear(box).append(wrap);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function rulesText(p) {
  const bits = [];
  const m = p.sale_days;
  if (m && m !== 127) bits.push(m === 62 ? 'Mon to Fri only' : m === 65 ? 'Weekends only' : `${DOW.filter((_, i) => m & (1 << i)).join(', ')} only`);
  if (p.online_daily_limit) bits.push(`Max ${p.online_daily_limit} a day online`);
  if (p.advance_days && p.advance_percent) bits.push(`${p.advance_percent}% off online ${p.advance_days}+ days ahead`);
  return bits.length ? bits.join('. ') : '';
}

function editProduct(p, done) {
  const mask = p && p.sale_days ? p.sale_days : 127;
  const dayBoxes = DOW.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `dow${i}`, checked: Boolean(mask & (1 << i)) }), d));
  const f = h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 255, value: p ? p.name : '' })),
    field('Kind', select(KINDS, p ? p.kind : 'day_ticket', { name: 'kind' })),
    field('Base price ($)', input({ name: 'price', inputmode: 'decimal', required: true, value: p ? centsToInput(p.base_price_cents) : '' })),
    field('Valid for (days)', input({ name: 'valid_days', type: 'number', min: 1, max: 400, value: p ? p.valid_days : 1 })),
    field('Rides (blank = unlimited)', input({ name: 'uses', type: 'number', min: 1, value: p && p.uses !== null ? p.uses : '' }), 'For punch cards. For a lesson product, 2 or more makes it a lesson package: that many lessons, valid for the number of days above (1 means no expiry).'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p ? Boolean(p.active) : true }), 'On sale'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'online', checked: p ? Boolean(p.online) : false }), 'Sell on the online shop'),
    h('p', { class: 'muted small' }, 'Day tickets, multi-day tickets and season passes are sold on the calendar. Lessons, rentals and vouchers are sold as add-ons (a voucher with a barcode to use at the mountain). Needs the online shop turned on in Account.'),
    h('fieldset', { class: 'field days' }, h('legend', null, 'Days it is sold'), h('div', { class: 'row' }, dayBoxes), h('p', { class: 'muted small' }, 'For example, untick Sat and Sun for a weekday ticket. The ticket window and the online shop both refuse the other days.')),
    field('Online discount (%)', input({ name: 'advance_percent', type: 'number', min: 1, max: 90, value: p && p.advance_percent ? p.advance_percent : '' }), 'Shown as "buy online and save". Leave blank for no discount.'),
    field('Discount applies when the visit is at least this many days away', input({ name: 'advance_days', type: 'number', min: 1, max: 365, value: p && p.advance_days ? p.advance_days : '' })),
    field('Most sold for one day online (blank = no limit)', input({ name: 'online_daily_limit', type: 'number', min: 1, max: 100000, value: p && p.online_daily_limit ? p.online_daily_limit : '' }), 'Counts every ticket of this product for that day, window sales too. When it is reached the day shows Sold out in the online shop. Day tickets and multi-day tickets only.'));
  formDialog(p ? `Edit ${p.name}` : 'Add a product', f, async (fd) => {
    const picked = DOW.reduce((n, _, i) => n + (fd.get(`dow${i}`) ? (1 << i) : 0), 0);
    if (!picked) throw new Error('Tick at least one day it is sold');
    const sold = picked === 127 ? null : picked;
    const body = {
      name: val(fd, 'name'), kind: val(fd, 'kind'), base_price_cents: need(toCents(fd.get('price')), 'Price'),
      valid_days: num(fd, 'valid_days') || 1, uses: num(fd, 'uses'), active: fd.get('active') ? 1 : 0, online: fd.get('online') ? 1 : 0,
      sale_days: sold, online_daily_limit: num(fd, 'online_daily_limit'),
      advance_percent: num(fd, 'advance_percent'), advance_days: num(fd, 'advance_days'),
    };
    if (!!body.advance_percent !== !!body.advance_days) throw new Error('Fill in both the discount and the number of days ahead, or leave both blank');
    if (p) await patch(`/products/${p.id}`, body); else await post('/products', body);
    toast(p ? 'Product saved' : 'Product added');
    await done();
  });
}

async function pricing(p) {
  const [{ tiers, calendar }, types] = await Promise.all([get(`/products/${p.id}/pricing`), loadTypes(true)]);
  const have = new Map(tiers.map((t) => [t.tier, t.price_cents]));
  // The visible guest types, plus any hidden one that still has a price here (so it can be seen and cleared).
  const TIERS = types.filter((t) => !t.hidden || have.has(t.code)).map((t) => t.code);
  const nameOf = (c) => { const t = types.find((x) => x.code === c); return t ? `${t.name}${t.hidden ? ' (hidden)' : ''}` : typeName(c); };
  const tierInputs = TIERS.map((t) => input({ name: `tier_${t}`, inputmode: 'decimal', value: have.has(t) ? centsToInput(have.get(t)) : '', placeholder: money(p.base_price_cents) }));
  const tierForm = h('div', { class: 'form' }, TIERS.map((t, i) => field(nameOf(t), tierInputs[i])));
  const saveTiers = button('Save prices by guest type', async () => {
    const out = [];
    TIERS.forEach((t, i) => { const v = tierInputs[i].value.trim(); if (v) out.push({ tier: t, price_cents: need(toCents(v), `${nameOf(t)} price`) }); });
    await put(`/products/${p.id}/tiers`, { tiers: out });
    toast('Prices saved');
  }, { kind: 'primary' });

  const calBody = h('div', { class: 'stack' });
  const drawCal = (rows) => {
    clear(calBody).append(rows.length ? table([
      { head: 'Date', cell: (r) => fmtDate(r.on_date) },
      { head: 'Guest type', cell: (r) => (r.tier ? nameOf(r.tier) : 'Everyone') },
      { head: 'Price', num: true, cell: (r) => (r.blackout ? 'Not sold' : money(r.price_cents)) },
    ], rows) : h('p', { class: 'muted' }, 'No date-specific prices yet.'));
  };
  drawCal(calendar);
  const d = input({ type: 'date', name: 'date' });
  const tierSel = select([['', 'Everyone'], ...TIERS.map((t) => [t, nameOf(t)])], '', { name: 'tier' });
  const price = input({ name: 'price', inputmode: 'decimal', placeholder: '79.00' });
  const black = h('input', { type: 'checkbox', name: 'blackout' });
  const addDate = button('Set date price', async () => {
    if (!d.value) throw new Error('Choose a date');
    const entry = { on_date: d.value, blackout: black.checked };
    if (tierSel.value) entry.tier = tierSel.value;
    if (!black.checked) entry.price_cents = need(toCents(price.value), 'Price');
    await put(`/products/${p.id}/calendar`, { entries: [entry] });
    toast(black.checked ? 'Date blocked' : 'Date price saved');
    drawCal((await get(`/products/${p.id}/pricing`)).calendar);
  });

  dialog(`Prices for ${p.name}`, [
    h('p', { class: 'muted' }, `Base price ${money(p.base_price_cents)}. Leave a guest type blank to use the base price.`),
    tierForm, h('div', { class: 'row' }, saveTiers),
    h('h3', null, 'Holiday and blackout dates'),
    calBody,
    h('div', { class: 'form' }, field('Date', d), field('Guest type', tierSel), field('Price ($)', price), h('label', { class: 'check' }, black, 'Do not sell this day')),
    h('div', { class: 'row' }, addDate),
  ], { wide: true });
}

// ---------------------------------------------------------------- promos
async function drawPromos(box) {
  const { data } = await get('/pricing/promos?limit=500');
  const reload = async () => { const n = h('div'); await drawPromos(n); clear(box).append(...n.childNodes); };
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'row' }, button('Add promo code', () => editPromo(null, reload), { kind: 'primary' })),
    data.length ? table([
      { head: 'Code', cell: (r) => h('strong', null, r.code) },
      { head: 'Discount', cell: (r) => (r.percent_off ? `${r.percent_off}% off` : `${money(r.amount_off_cents)} off`) },
      { head: 'Runs', cell: (r) => (r.starts_on || r.ends_on ? `${r.starts_on ? fmtDate(r.starts_on) : 'Now'} to ${r.ends_on ? fmtDate(r.ends_on) : 'No end'}` : 'Always') },
      { head: 'Used', num: true, cell: (r) => `${r.used_count}${r.max_uses ? ` of ${r.max_uses}` : ''}` },
      { head: '', actions: true, cell: (r) => [
        button('Edit', () => editPromo(r, reload), { small: true }),
        button('Delete', () => confirmDialog('Delete this code?', `${r.code} will stop working.`, 'Delete code', async () => { await del(`/pricing/promos/${r.id}`); toast('Code deleted'); await reload(); }, { danger: true }), { small: true, kind: 'danger' }),
      ] },
    ], data) : empty('No promo codes yet.')));
}

function editPromo(p, done) {
  const kind = select([['percent', 'Percent off'], ['amount', 'Dollars off']], p && p.amount_off_cents ? 'amount' : 'percent', { name: 'kind' });
  const f = h('div', { class: 'form' },
    field('Code', input({ name: 'code', required: true, minlength: 3, maxlength: 40, value: p ? p.code : '', autocapitalize: 'characters' })),
    field('Type', kind),
    field('Amount (% or $)', input({ name: 'amount', inputmode: 'decimal', required: true, value: p ? (p.percent_off ? p.percent_off : centsToInput(p.amount_off_cents)) : '' })),
    field('Starts', input({ name: 'starts_on', type: 'date', value: p && p.starts_on ? p.starts_on : '' })),
    field('Ends', input({ name: 'ends_on', type: 'date', value: p && p.ends_on ? p.ends_on : '' })),
    field('Limit uses', input({ name: 'max_uses', type: 'number', min: 1, value: p && p.max_uses ? p.max_uses : '' }), 'Blank for no limit'));
  formDialog(p ? `Edit ${p.code}` : 'Add a promo code', f, async (fd) => {
    const body = { code: val(fd, 'code'), starts_on: val(fd, 'starts_on'), ends_on: val(fd, 'ends_on'), max_uses: num(fd, 'max_uses') };
    if (val(fd, 'kind') === 'percent') {
      const n = Number(fd.get('amount'));
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Percent must be a whole number from 1 to 100');
      Object.assign(body, { percent_off: n, amount_off_cents: null });
    } else {
      Object.assign(body, { amount_off_cents: need(toCents(fd.get('amount')), 'Amount'), percent_off: null });
    }
    if (p) await patch(`/pricing/promos/${p.id}`, body); else await post('/pricing/promos', body);
    toast('Promo code saved');
    await done();
  });
}
