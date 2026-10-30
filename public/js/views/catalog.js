import { get, post, put, patch, del } from '../api.js';
import { h, clear, money, toCents, centsToInput, table, state, input, select, field, button, toast, formDialog, confirmDialog, dialog, tabs, val, num, fmtDate, label, empty, isManager, errorBox, todayStr } from '../ui.js';
import { loadTypes, typeName, forget } from '../guesttypes.js';

const KINDS = ['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'lesson', 'rental', 'program', 'voucher', 'activity'];
const TICKET_KINDS = ['day_ticket', 'multi_day', 'season_pass', 'punch_card', 'voucher'];

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
  const [{ data }, opts] = await Promise.all([get('/products?limit=500'), get('/products/activity-options').catch(() => ({ attractions: [] }))]);
  const atts = opts.attractions || [];
  const attName = (id) => (atts.find((a) => a.id === id) || {}).name || 'an attraction no longer in use';
  const reload = async () => { clear(box); box.append(...(await rebuild())); };
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'row' }, button('Add product', () => editProduct(null, reload, atts), { kind: 'primary' })));
  async function rebuild() { const n = h('div'); await drawProducts(n); return [...n.childNodes]; }
  wrap.append(data.length ? table([
    { head: 'Product', cell: (p) => h('strong', null, p.name) },
    { head: 'Kind', cell: (p) => (p.kind === 'rental' && p.rental_kind === 'season' ? 'Season rental' : label(p.kind)) },
    { head: 'Base price', num: true, cell: (p) => money(p.base_price_cents) },
    { head: 'Days', num: true, cell: (p) => String(p.valid_days) },
    { head: 'Rides', num: true, cell: (p) => (p.uses === null ? 'Unlimited' : String(p.uses)) },
    { head: 'Rules', cell: (p) => (p.kind === 'activity' ? [h('span', { class: 'act-for' }, attName(p.attraction_id)), `. ${p.timed ? 'Time slots' : `All day${p.day_capacity ? `, ${p.day_capacity} places a day` : ''}`}`, rulesText(p) ? `. ${rulesText(p)}` : ''] : rulesText(p)) },
    { head: 'Status', cell: (p) => [state(p.active ? 'Selling' : 'Off sale', p.active ? 'good' : 'neutral'), p.online ? state('Online', 'good') : null] },
    { head: '', actions: true, cell: (p) => [
      button('Edit', () => editProduct(p, reload, atts), { small: true }),
      button('Prices', () => pricing(p), { small: true }),
      p.kind === 'activity' && p.timed ? button('Time slots', () => slotsDialog(p), { small: true, label: `Time slots for ${p.name}` }) : null,
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

function editProduct(p, done, atts = []) {
  const mask = p && p.sale_days ? p.sale_days : 127;
  // An activity: the attraction it is for, and whether it sells by time slot or for the whole day.
  const kindSel = select(KINDS, p ? p.kind : 'day_ticket', { name: 'kind' });
  const attSel = select([['', 'Choose…'], ...atts.map((a) => [String(a.id), a.name])], p && p.attraction_id ? String(p.attraction_id) : '', { name: 'attraction_id' });
  const timedSlots = h('input', { type: 'radio', name: 'timed', value: '1', checked: !p || p.kind !== 'activity' || Boolean(p.timed) });
  const timedDay = h('input', { type: 'radio', name: 'timed', value: '0', checked: Boolean(p && p.kind === 'activity' && !p.timed) });
  const dayCap = input({ name: 'day_capacity', type: 'number', min: 1, max: 100000, value: p && p.day_capacity ? p.day_capacity : '' });
  const capField = field('Places a day (blank = no limit)', dayCap, 'For a day pass, such as skating all day.');
  // A rental: a day rental, or a season rental (due back on the shop's season return date, set in Settings, Rentals).
  const rentalKind = select([['day', 'Day rental'], ['season', 'Season rental']], p && p.rental_kind === 'season' ? 'season' : 'day', { name: 'rental_kind' });
  const rentalBox = field('Rental type', rentalKind, 'A season rental is due back on the season return date in Settings, Rentals. Renters get a reminder in March.');
  const actBox = h('fieldset', { class: 'field act-setup wide' }, h('legend', null, 'Activity'),
    atts.length ? field('Attraction', attSel, 'Its height, weight and age limits and its waiver come from the attraction (Settings, Attractions).') : h('p', { class: 'muted small' }, 'Add the attraction first, in Settings, Attractions.'),
    h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'How it is sold' }, h('label', { class: 'check' }, timedSlots, ' Time slots'), h('label', { class: 'check' }, timedDay, ' All day (a day pass)')),
    capField, h('p', { class: 'muted small' }, 'Time slots are set after saving, with the Time slots button. Each guest gets a ticket good once, at this attraction only.'));
  // A lift ticket or pass can include attractions: its holder is let in at those attractions' gates too.
  const inc = new Set();
  const incBoxes = atts.map((a) => { const cb = h('input', { type: 'checkbox', value: String(a.id) }); cb.addEventListener('change', () => { if (cb.checked) inc.add(a.id); else inc.delete(a.id); }); return [a, cb]; });
  const incBox = atts.length ? h('fieldset', { class: 'field act-includes wide' }, h('legend', null, 'Also lets the holder in at'), h('div', { class: 'row' }, incBoxes.map(([a, cb]) => h('label', { class: 'check' }, cb, ` ${a.name}`))),
    h('p', { class: 'muted small' }, 'Leave all unticked for a lift ticket that is not good at any attraction. A gate set to an attraction refuses other tickets.')) : null;
  if (p && incBox) get(`/products/${p.id}/activity`).then((r) => { for (const [a, cb] of incBoxes) if (r.includes.includes(a.id)) { cb.checked = true; inc.add(a.id); } }).catch(() => {});
  const showKind = () => {
    const k = kindSel.value;
    actBox.hidden = k !== 'activity';
    capField.hidden = !timedDay.checked;
    if (incBox) incBox.hidden = !TICKET_KINDS.includes(k);
    rentalBox.hidden = k !== 'rental';
  };
  for (const el of [kindSel, timedSlots, timedDay]) el.addEventListener('change', showKind);
  // A new activity starts as the attraction usually sells: skating, the bike park and disc golf by the day, rides by time slot.
  attSel.addEventListener('change', () => {
    const a = atts.find((x) => String(x.id) === attSel.value);
    if (p || !a) return;
    const day = ['ice_rink', 'bike_park', 'disc_golf'].includes(a.type);
    timedDay.checked = day; timedSlots.checked = !day; showKind();
  });
  const dayBoxes = DOW.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `dow${i}`, checked: Boolean(mask & (1 << i)) }), d));
  const f = h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 255, value: p ? p.name : '' })),
    field('Kind', kindSel),
    actBox, incBox, rentalBox,
    field('Base price ($)', input({ name: 'price', inputmode: 'decimal', required: true, value: p ? centsToInput(p.base_price_cents) : '' })),
    field('Valid for (days)', input({ name: 'valid_days', type: 'number', min: 1, max: 400, value: p ? p.valid_days : 1 })),
    field('Rides (blank = unlimited)', input({ name: 'uses', type: 'number', min: 1, value: p && p.uses !== null ? p.uses : '' }), 'For punch cards. For a lesson product, 2 or more makes it a lesson package: that many lessons, valid for the number of days above (1 means no expiry).'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p ? Boolean(p.active) : true }), 'On sale'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'online', checked: p ? Boolean(p.online) : false }), 'Sell on the online shop'),
    h('p', { class: 'muted small' }, ['Day tickets, multi-day tickets and season passes are sold on the calendar. Rentals and lesson packages are add-ons on a ticket, for that person and day. Vouchers are add-ons for the buyer. A single lesson is booked on the lesson page. Needs the online shop turned on in ', h('a', { href: '#/settings/shop' }, 'Settings, Online shop'), '.']),
    h('fieldset', { class: 'field days' }, h('legend', null, 'Days it is sold'), h('div', { class: 'row' }, dayBoxes), h('p', { class: 'muted small' }, 'For example, untick Sat and Sun for a weekday ticket. The ticket window and the online shop both refuse the other days.')),
    field('Online discount (%)', input({ name: 'advance_percent', type: 'number', min: 1, max: 90, value: p && p.advance_percent ? p.advance_percent : '' }), 'Shown as "buy online and save". Leave blank for no discount.'),
    field('Discount applies when the visit is at least this many days away', input({ name: 'advance_days', type: 'number', min: 1, max: 365, value: p && p.advance_days ? p.advance_days : '' })),
    field('Most sold for one day online (blank = no limit)', input({ name: 'online_daily_limit', type: 'number', min: 1, max: 100000, value: p && p.online_daily_limit ? p.online_daily_limit : '' }), 'Counts every ticket of this product for that day, window sales too. When it is reached the day shows Sold out in the online shop, and the window needs a manager and a reason to sell more. Day tickets and multi-day tickets only.'));
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
    if (body.kind === 'rental') body.rental_kind = rentalKind.value;
    if (!!body.advance_percent !== !!body.advance_days) throw new Error('Fill in both the discount and the number of days ahead, or leave both blank');
    if (body.kind === 'activity') {
      if (!attSel.value) throw new Error('Choose the attraction this activity is for');
      Object.assign(body, { attraction_id: Number(attSel.value), timed: timedSlots.checked ? 1 : 0, day_capacity: timedSlots.checked ? null : num(fd, 'day_capacity') });
    } else if (p && p.kind === 'activity') Object.assign(body, { attraction_id: null });
    const saved = p ? await patch(`/products/${p.id}`, body) : await post('/products', body);
    if (incBox && TICKET_KINDS.includes(body.kind) && (p || inc.size)) await put(`/products/${saved.id}/includes`, { attraction_ids: [...inc] });
    toast(p ? 'Product saved' : 'Product added');
    await done();
    if (!p && body.kind === 'activity' && body.timed) slotsDialog(saved);
  });
  showKind();
}

// ---------------------------------------------------------------- activity time slots
const clock = (t) => { const [hh, mm] = String(t).split(':').map(Number); return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const daysText = (m) => (m === 127 ? 'Every day' : m === 62 ? 'Mon to Fri' : m === 65 ? 'Weekends' : DOW.filter((_, i) => m & (1 << i)).join(', '));
/** The start times a manager sets for a timed activity: by weekday, over a date range, with a slot length and places. */
async function slotsDialog(p) {
  const body = h('div', { class: 'stack' });
  const draw = async () => {
    const { schedules } = await get(`/products/${p.id}/activity`);
    clear(body).append(
      h('p', { class: 'muted' }, 'Each set of times runs on the days ticked, between its first and last day. A guest picks one start time; the slot lasts the length set, and each start time has its own places. Bookings already made keep their time if you change or remove a set.'),
      h('div', { class: 'row' }, button('Add times', () => editSlots(p, null, draw), { kind: 'primary' })),
      schedules.length ? table([
        { head: 'Days', cell: (x) => daysText(x.days) },
        { head: 'Dates', cell: (x) => `${fmtDate(x.starts_on)} to ${x.ends_on ? fmtDate(x.ends_on) : 'no end'}` },
        { head: 'Start times', cell: (x) => x.start_times.map(clock).join(', ') },
        { head: 'Length', num: true, cell: (x) => `${x.slot_minutes} min` },
        { head: 'Places', num: true, cell: (x) => String(x.capacity) },
        { head: '', actions: true, cell: (x) => [
          button('Edit', () => editSlots(p, x, draw), { small: true, label: `Edit times from ${fmtDate(x.starts_on)}` }),
          button('Remove', () => confirmDialog('Remove these times?', 'They stop being sold. Bookings already made keep their time.', 'Remove', async () => { await del(`/products/${p.id}/schedules/${x.id}`); toast('Times removed'); await draw(); }, { danger: true }), { small: true, label: `Remove times from ${fmtDate(x.starts_on)}` }),
        ] },
      ], schedules) : empty('No times yet. Add the first set, such as every day at 10:00, 11:00 and 1:00.'));
  };
  dialog(`Time slots for ${p.name}`, body, { wide: true });
  await draw();
}
function editSlots(p, x, done) {
  const mask = x ? x.days : 127;
  const dayBoxes = DOW.map((d, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `sd${i}`, checked: Boolean(mask & (1 << i)) }), d));
  const times = input({ name: 'times', required: true, value: x ? x.start_times.join(', ') : '', placeholder: '10:00, 11:00, 13:00', autocomplete: 'off' });
  const from = input({ type: 'time', name: 'gen_from', value: '10:00', 'aria-label': 'First start' });
  const to = input({ type: 'time', name: 'gen_to', value: '16:00', 'aria-label': 'Last start' });
  const every = input({ type: 'number', name: 'gen_every', min: 5, max: 240, value: 30, 'aria-label': 'Every so many minutes' });
  const fill = button('Fill in', () => {
    const m = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
    const step = Number(every.value);
    if (!from.value || !to.value || !(step >= 5)) throw new Error('Give the first start, the last start and how many minutes apart');
    const out = [];
    for (let t = m(from.value); t <= m(to.value) && out.length < 60; t += step) out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    times.value = out.join(', ');
  }, { small: true });
  const f = h('div', { class: 'form' },
    h('fieldset', { class: 'field days wide' }, h('legend', null, 'Days'), h('div', { class: 'row' }, dayBoxes)),
    field('First day', input({ type: 'date', name: 'starts_on', required: true, value: x ? x.starts_on : todayStr() })),
    field('Last day (optional)', input({ type: 'date', name: 'ends_on', value: x && x.ends_on ? x.ends_on : '' })),
    field('Start times', times, 'Times of day, 24-hour, separated by commas.'),
    h('div', { class: 'field wide slot-fill' }, h('span', null, 'Or fill in every'), every, h('span', null, 'minutes from'), from, h('span', null, 'to'), to, fill),
    field('Slot length (minutes)', input({ type: 'number', name: 'slot_minutes', required: true, min: 5, max: 720, value: x ? x.slot_minutes : 60 })),
    field('Places per slot', input({ type: 'number', name: 'capacity', required: true, min: 1, max: 10000, value: x ? x.capacity : 10 })));
  formDialog(x ? 'Change times' : 'Add times', f, async (fd) => {
    const days = DOW.reduce((n, _, i) => n + (fd.get(`sd${i}`) ? (1 << i) : 0), 0);
    if (!days) throw new Error('Tick at least one day');
    const list = String(fd.get('times') || '').split(/[\s,;]+/).filter(Boolean);
    if (!list.length) throw new Error('Give at least one start time, like 10:00');
    const b = { days, starts_on: val(fd, 'starts_on'), ends_on: val(fd, 'ends_on') || null, start_times: list, slot_minutes: num(fd, 'slot_minutes'), capacity: num(fd, 'capacity') };
    if (x) await patch(`/products/${p.id}/schedules/${x.id}`, b); else await post(`/products/${p.id}/schedules`, b);
    toast(x ? 'Times saved' : 'Times added');
    await done();
  }, { submitText: x ? 'Save' : 'Add times' });
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
