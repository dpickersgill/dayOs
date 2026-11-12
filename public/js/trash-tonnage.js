// Trash and recycling (release 2026.11.22, workstream "tonnage"): the Carts, Tonnage and Recycling report tabs of the
// Trash and recycling app (views/bulk-pickup.js). Each registers itself through ./trashtabs.js; the app shows the ones
// whose show() is true, after its own tabs. Addresses: #/bulk?tab=carts|tonnage|recycling, with &part= for a section.
//   Carts             requests (new, extra, replacement, stolen) from the public page or taken by phone; delivery days and
//                     the day's deliveries (the crew marks Delivered on a phone); the carts at an address; carts in the
//                     yard; sizes and fees (managers). + New "Cart request" opens the request form.
//   Tonnage           the figures (tons by month, stream, facility and zone; recycling rate; pounds per household; cost
//                     per ton for managers); weigh tickets with their photos; a facility's or hauler's spreadsheet;
//                     facilities (managers). + New "Weigh ticket" opens the ticket form.
//   Recycling report  the year's Act 101 report (managers): reporters, their forms and links, the follow-up list, the
//                     municipal report in the DEP / county columns, and the Section 904 packet.
// Money (fees, tipping fees, cost per ton) reaches only owners and managers: the server leaves it out for everyone else,
// and these screens show what they get.
import { get, post, put, patch, download, sendBytes, fetchBlob } from './api.js';
import { h, clear, appendAll, ctx, money, state, button, field, input, select, toast, fail, formDialog, dialog, confirmDialog, empty, errorBox, loading, tabs, table, isManager, can, fmtDay, fmtDate, fmtInstant, hashParam, toCents, centsToInput, closeAllDialogs, todayStr } from './ui.js';
import { whenNew } from './newmenu.js';
import { registerTab } from './trashtabs.js';

const office = () => can('counter');
const crewRole = () => isManager() || (ctx.me && ctx.me.role === 'staff');
const KIND = { new: 'New cart', extra: 'Extra cart', replacement: 'Replacement cart', stolen: 'Stolen cart' };
const STATUS = { awaiting_payment: ['Waiting for card payment', 'warn'], open: ['Needs a delivery day', 'warn'], scheduled: ['Delivery day set', 'neutral'], delivered: ['Delivered', 'good'], cancelled: ['Canceled', 'neutral'], expired: ['Not paid in time', 'neutral'] };
const PAY = { not_needed: ['No fee', 'neutral'], due: ['Fee to pay', 'warn'], paid: ['Paid', 'good'], refund_due: ['Refund at the office', 'warn'], refunded: ['Refunded', 'neutral'] };
const STREAM_WORDS = { trash: 'Trash', recycling: 'Recycling', yard: 'Yard waste', food: 'Food waste', other: 'Other' };
const tons = (v) => (v === null || v === undefined ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const lbs = (v) => (v === null || v === undefined ? '' : Number(v).toLocaleString('en-US'));
const figure = (n, words, note) => h('div', { class: 'figure' }, h('strong', null, String(n)), h('span', null, words), note ? h('em', null, note) : null);
const s = (fd, k) => String(fd.get(k) || '').trim();
const numOrNull = (v) => (String(v ?? '').trim() === '' ? null : Number(String(v).replace(/,/g, '')));

// ================================================================ Carts
async function cartsTab(el) {
  const parts = [['requests', 'Requests', requestsPart], ['stops', 'Deliveries', stopsPart], ['address', 'Addresses', addressPart], ['stock', 'In the yard', stockPart]];
  if (isManager()) parts.push(['setup', 'Sizes and fees', setupPart]);
  const initial = hashParam('part') || (hashParam('show') === 'stops' ? 'stops' : office() ? 'requests' : 'stops');
  el.append(tabs(parts, initial, { param: 'part' }));
}

async function requestsPart(panel) {
  let show = ['waiting', 'scheduled', 'delivered', 'cancelled', 'all'].includes(hashParam('show')) ? hashParam('show') : 'waiting';
  const search = input({ type: 'search', placeholder: 'Reference, address or name', 'aria-label': 'Search requests' });
  const body = h('div');
  // A list rather than buttons, so it fits a phone (2026.11.22 browser check).
  const seg = select([['waiting', 'Waiting'], ['scheduled', 'Delivery day set'], ['delivered', 'Delivered'], ['cancelled', 'Canceled'], ['all', 'All']], show, { 'aria-label': 'Show' });
  seg.addEventListener('change', () => { show = seg.value; load(); });
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  panel.append(h('div', { class: 'week-bar' }, h('div', { class: 'row' }, seg, search),
    h('div', { class: 'week-actions' }, office() ? button('Add a request', () => requestDialog(load), { kind: 'primary' }) : null, office() ? button('Spreadsheet', () => exportDialog()) : null)), body);
  async function load() {
    clear(body).append(loading('Loading cart requests'));
    let d;
    try { d = await get(`/solid-waste/carts/requests?show=${show}${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    if (!d.data.length) { clear(body).append(empty(show === 'waiting' ? 'No cart requests waiting.' : 'No cart requests here.')); return; }
    clear(body).append(table([
      { head: 'Reference', cell: (r) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); detailDialog(r.id, load); } }, r.reference) },
      { head: 'Address', cell: (r) => r.address },
      { head: 'What', cell: (r) => `${r.kind_label}: ${r.size_gal}-gallon ${r.stream}` },
      { head: 'Status', cell: (r) => h('span', null, state(...(STATUS[r.status] || [r.status])), r.deliver_on && r.status === 'scheduled' ? ` ${fmtDay(r.deliver_on)}` : '', r.checks && r.checks.length ? h('span', { class: 'muted small', title: r.checks.join(' ') }, ' Check first') : null) },
      { head: 'Fee', cell: (r) => (r.pay_status === 'not_needed' ? '' : h('span', null, r.fee_cents !== undefined ? `${money(r.fee_cents)} ` : '', state(...(PAY[r.pay_status] || [r.pay_status])))) },
      { head: 'Asked', cell: (r) => `${fmtDate(String(r.created_at).slice(0, 10))}${r.source === 'online' ? ' online' : ''}` },
    ], d.data));
  }
  await load();
  if (office()) whenNew(panel, () => requestDialog(load)); // #/bulk?tab=carts&new=1 (+ New "Cart request")
}

async function requestDialog(onDone) {
  let o;
  try { o = await get('/solid-waste/carts/options'); } catch (err) { fail(err); return; }
  if (!o.options.length) {
    dialog('Cart sizes are not set up yet', h('p', null, isManager() ? 'Set the cart sizes for each stream first, under Carts, Sizes and fees.' : 'A manager sets the cart sizes for each stream first.'));
    return;
  }
  const opts = o.options.map((x) => [`${x.stream_id}|${x.size_gal}`, `${x.stream}, ${x.size_gal} gallons`]);
  const kind = select(Object.entries(KIND), 'new', { name: 'kind' });
  const size = select(opts, opts[0][0], { name: 'size' });
  const feeLine = h('p', { class: 'muted small' });
  const drawFee = () => {
    const [sid, gal] = size.value.split('|').map(Number);
    const x = o.options.find((y) => y.stream_id === sid && y.size_gal === gal);
    const fee = !x ? 0 : kind.value === 'extra' ? x.extra_fee_cents : kind.value === 'replacement' ? x.replacement_fee_cents : 0;
    feeLine.textContent = fee === undefined ? (['extra', 'replacement'].includes(kind.value) ? 'An extra or replacement cart may carry a fee.' : 'No fee.') : fee ? `Fee: ${money(fee)}` : 'No fee.';
    payRow.hidden = !(['extra', 'replacement'].includes(kind.value) && (fee === undefined || fee > 0));
    policeRow.hidden = kind.value !== 'stolen';
  };
  const pay = select([['office_due', 'Will pay at the office'], ['office_paid', 'Paid at the office now'], ...(o.card_ready ? [['link', 'Send a link to pay by card']] : []), ...(isManager() ? [['waive', 'No fee (waived by a manager)']] : [])], 'office_due', { name: 'pay' });
  const linkBy = select([['text', 'By text'], ['email', 'By email']], 'text', { name: 'link_by' });
  const linkRow = field('Send the link', linkBy);
  const payRow = h('div', { class: 'stack tight' }, field('Fee', pay), linkRow);
  const policeRow = field('Police report number, if any', input({ name: 'police_report', maxlength: 40 }));
  const sync = () => { linkRow.hidden = pay.value !== 'link'; };
  pay.addEventListener('change', sync); kind.addEventListener('change', drawFee); size.addEventListener('change', drawFee);
  const override = h('input', { type: 'checkbox', name: 'override' });
  const overrideRow = h('label', { class: 'check wide', hidden: true }, override, 'Take it anyway');
  const texts = h('input', { type: 'checkbox', name: 'texts_ok' }); const emails = h('input', { type: 'checkbox', name: 'emails_ok', checked: true });
  const fields = h('div', { class: 'form' },
    field('Request', kind), field('Cart', size), h('div', { class: 'wide' }, feeLine),
    field('Street', select([['', 'Choose a street'], ...o.streets.map((x) => [x.id, x.name])], '', { name: 'street_id', required: true })),
    field('House number', input({ name: 'house_number', maxlength: 20, required: true })), field('Apartment or unit', input({ name: 'unit', maxlength: 20 })),
    policeRow, h('div', { class: 'wide' }, field('Note for the crew', input({ name: 'note', maxlength: 300, placeholder: 'For example: leave it by the side gate' }))),
    field('Resident’s name', input({ name: 'name', maxlength: 120, required: true })), field('Phone', input({ type: 'tel', name: 'phone', maxlength: 40 })), field('Email', input({ type: 'email', name: 'email', maxlength: 255 })),
    h('label', { class: 'check wide' }, texts, 'They agree to texts about this cart'), h('label', { class: 'check wide' }, emails, 'They agree to emails about this cart'),
    payRow, overrideRow);
  drawFee(); sync();
  formDialog('Add a cart request', fields, async (fd) => {
    const [sid, gal] = size.value.split('|').map(Number);
    const body = { kind: kind.value, stream_id: sid, size_gal: gal, street_id: Number(s(fd, 'street_id')), house_number: s(fd, 'house_number'), unit: s(fd, 'unit') || undefined,
      note: s(fd, 'note') || undefined, police_report: kind.value === 'stolen' ? s(fd, 'police_report') || undefined : undefined,
      name: s(fd, 'name'), phone: s(fd, 'phone') || undefined, email: s(fd, 'email') || undefined, texts_ok: texts.checked, emails_ok: emails.checked, override: override.checked };
    if (!payRow.hidden) { body.pay = pay.value; if (pay.value === 'link') body.link_by = linkBy.value; }
    let r;
    try { r = await post('/solid-waste/carts/requests', body); } catch (err) {
      // The checks (a cart already there, too many extras, a request already open): staff may take it anyway.
      if (err.details && err.details.code === 'cart_checks') overrideRow.hidden = false;
      throw err;
    }
    toast(`Request taken: reference ${r.reference}${r.sent.length ? `. Sent by ${r.sent.join(' and ')}.` : ''}`);
    if (r.texts_off) toast(r.texts_off, 'error');
    await onDone();
    if (body.pay === 'link' && !r.sent.length) dialog('The link could not be sent', [h('p', null, 'Read this link to them, or try email:'), h('p', null, h('code', null, r.link))]);
  }, { submitText: 'Take request', wide: true });
}

async function detailDialog(id, onDone) {
  let r;
  try { r = await get(`/solid-waste/carts/requests/${id}`); } catch (err) { fail(err); return; }
  const again = async () => { closeAllDialogs(); await onDone(); detailDialog(id, onDone); };
  const live = ['open', 'scheduled', 'awaiting_payment'].includes(r.status);
  const acts = [];
  if (office() && ['open', 'scheduled'].includes(r.status)) acts.push(button(r.status === 'scheduled' ? 'Change the delivery day' : 'Set the delivery day', () => scheduleDialog(r, again), { kind: 'primary' }));
  if (['open', 'scheduled'].includes(r.status) && (office() || (crewRole() && r.status === 'scheduled' && r.deliver_on <= todayStr()))) acts.push(button('Delivered', () => deliverDialog(r, again)));
  if (office() && live && r.pay_status === 'due') acts.push(button('Mark paid at the office', () => confirmDialog('Paid at the office?', `The fee for ${r.address} was taken at the office.`, 'Mark paid', async () => { await post(`/solid-waste/carts/requests/${id}/paid`); toast('Marked paid'); await again(); })));
  if (office() && live && r.pay_method === 'card' && r.pay_status === 'due') acts.push(button('Send the payment link', () => linkDialog(r, again)));
  if (office() && r.pay_status === 'refund_due') acts.push(button('Refund given', () => confirmDialog('Refund handed back?', 'The fee was given back at the office.', 'Refund given', async () => { await post(`/solid-waste/carts/requests/${id}/refund-given`); toast('Refund recorded'); await again(); })));
  if (office() && live) acts.push(button('Cancel request', () => cancelDialog(r, again)));
  dialog(`${r.address}: ${r.kind_label.toLowerCase()}`, h('div', { class: 'stack' },
    h('p', null, h('b', null, `Reference ${r.reference}`), r.source === 'online' ? ' (asked online)' : ' (taken by staff)'),
    h('p', null, `${r.size_gal}-gallon ${r.stream} cart. `, state(...(STATUS[r.status] || [r.status])), r.deliver_on ? ` ${fmtDay(r.deliver_on)}` : ''),
    r.pay_status !== 'not_needed' ? h('p', null, r.fee_cents !== undefined ? `Fee ${money(r.fee_cents)} ` : 'Fee ', state(...(PAY[r.pay_status] || [r.pay_status])), r.pay_method === 'card' ? ' (card)' : '') : null,
    r.checks && r.checks.length ? h('div', { class: 'warn-note' }, h('b', null, 'Check first: '), r.checks.join(' ')) : null,
    r.note ? h('p', null, `Note: ${r.note}`) : null, r.police_report ? h('p', null, `Police report ${r.police_report}`) : null,
    r.name !== undefined ? h('p', null, [r.name, r.phone, r.email].filter(Boolean).join(', '), h('br'), h('span', { class: 'muted small' }, `Texts: ${r.texts_ok ? 'yes' : 'no'}. Emails: ${r.emails_ok ? 'yes' : 'no'}.`)) : null,
    r.cancel_reason ? h('p', { class: 'muted' }, r.cancel_reason) : null,
    r.link ? h('p', { class: 'muted small' }, 'Resident’s link: ', h('code', null, r.link)) : null,
    h('p', { class: 'muted small' }, `Asked ${fmtInstant(r.created_at)}`),
    acts.length ? h('div', { class: 'row' }, ...acts) : null), { wide: true });
}

function scheduleDialog(r, done) {
  const d = input({ type: 'date', name: 'deliver_on', required: true, min: todayStr(), value: r.deliver_on || todayStr() });
  formDialog('Delivery day', h('div', { class: 'stack' }, field('Deliver on', d), h('p', { class: 'muted small' }, 'The resident is told the day by the ways they agreed to. The delivery shows on that day\'s list for the crew.')), async () => {
    const out = await post(`/solid-waste/carts/requests/${r.id}/schedule`, { deliver_on: d.value });
    toast(`Delivery set for ${fmtDay(d.value)}${out.told.length ? `. Resident told by ${out.told.join(' and ')}.` : ''}`); await done();
  }, { submitText: 'Set day' });
}

async function deliverDialog(r, done) {
  const serial = input({ name: 'serial', maxlength: 40, placeholder: 'The number on the cart, if it has one' });
  const back = h('input', { type: 'checkbox' });
  let old = [];
  if (['replacement', 'stolen'].includes(r.kind)) {
    try { old = (await get(`/solid-waste/carts/address?street_id=${r.street_id}&house_number=${encodeURIComponent(r.house_number)}${r.unit ? `&unit=${encodeURIComponent(r.unit)}` : ''}`)).carts.filter((c) => c.stream_id === r.stream_id); } catch (_) { old = []; }
  }
  const oldPick = old.length ? select(old.map((c) => [c.id, `${c.size_gal} gallons${c.serial ? `, ${c.serial}` : ''}${c.delivered_on ? `, since ${fmtDate(c.delivered_on)}` : ''}`]), old[0].id) : null;
  formDialog(`Delivered to ${r.address}`, h('div', { class: 'stack' },
    h('p', null, `One ${r.size_gal}-gallon ${r.stream} cart leaves the yard.`), field('Cart number', serial),
    oldPick ? field(r.kind === 'stolen' ? 'The stolen cart' : 'The cart it replaces', oldPick) : null,
    oldPick && r.kind === 'replacement' ? h('label', { class: 'check' }, back, 'The old cart came back to the yard and can be used again') : null), async () => {
    await post(`/solid-waste/carts/requests/${r.id}/deliver`, { serial: serial.value.trim() || undefined, ...(oldPick ? { old_cart_id: Number(oldPick.value) } : {}), old_cart_back: back.checked });
    toast('Delivered'); await done();
  }, { submitText: 'Mark delivered' });
}

function linkDialog(r, done) {
  const by = select([['text', 'By text'], ['email', 'By email']], r.phone ? 'text' : 'email');
  formDialog('Send the payment link', field('How', by), async () => {
    const out = await post(`/solid-waste/carts/requests/${r.id}/send-link`, { by: by.value });
    toast(`Sent by ${out.sent.join(' and ')}`); await done();
  }, { submitText: 'Send' });
}

function cancelDialog(r, done) {
  const reason = input({ maxlength: 200, placeholder: 'For example: found the old cart' });
  formDialog(`Cancel the request for ${r.address}?`, h('div', { class: 'stack' },
    h('p', null, 'A card payment goes back to the card in full by itself. A fee paid at the office is set aside to hand back.'), field('Why', reason)), async () => {
    const out = await post(`/solid-waste/carts/requests/${r.id}/cancel`, { reason: reason.value.trim() || undefined });
    toast(out.pay_status === 'refunded' ? 'Canceled and refunded to the card' : out.pay_status === 'refund_due' ? 'Canceled. Hand the refund back at the office.' : 'Canceled');
    await done();
  }, { submitText: 'Cancel request' });
}

function exportDialog() {
  const from = input({ type: 'date', value: `${todayStr().slice(0, 4)}-01-01` }); const to = input({ type: 'date', value: todayStr() });
  const range = () => `from=${from.value}&to=${to.value}&`;
  dialog('Cart requests spreadsheet', h('div', { class: 'stack' },
    h('div', { class: 'row' }, field('From', from), field('To', to)),
    h('p', { class: 'muted small' }, 'A public record copy: no names, phones, emails or house numbers (Pennsylvania\'s Right-to-Know Law).'),
    h('div', { class: 'row' },
      button('Download', async () => { try { await download(`/solid-waste/carts/export?${range()}`, 'cart-requests.csv'); } catch (err) { fail(err); } }, { kind: 'primary' }),
      isManager() ? button('Download with contact details', () => confirmDialog('Include contact details?', 'The file will have residents’ names, phones, emails and house numbers. Keep it private: do not use it to answer a public records request.', 'Download', async () => { await download(`/solid-waste/carts/export?${range()}contacts=1`, 'cart-requests-with-contacts.csv'); })) : null)));
}

async function stopsPart(panel) {
  let date = hashParam('date') || todayStr();
  const body = h('div');
  const pick = input({ type: 'date', value: date, 'aria-label': 'Delivery day' });
  pick.addEventListener('change', () => { if (pick.value) { date = pick.value; load(); } });
  panel.append(h('div', { class: 'week-bar' }, h('div', { class: 'row' }, pick), h('div', { class: 'week-actions' }, button('Print', () => window.print()))), body);
  async function load() {
    clear(body).append(loading('Loading the deliveries'));
    let d;
    try { d = await get(`/solid-waste/carts/stops?date=${date}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const left = d.stops.filter((x) => !x.delivered);
    const need = new Map();
    for (const x of left) need.set(`${x.stream_id}|${x.size_gal}`, { stream: x.stream, size: x.size_gal, n: (need.get(`${x.stream_id}|${x.size_gal}`) || { n: 0 }).n + 1 });
    const short = [...need.entries()].filter(([k, v]) => (d.stock.find((y) => `${y.stream_id}|${y.size_gal}` === k) || { on_hand: 0 }).on_hand < v.n);
    appendAll(clear(body),
      h('div', { class: 'figures' }, figure(d.stops.length, 'deliveries'), figure(d.stops.length - left.length, 'delivered'), figure(left.length, 'to go')),
      need.size ? h('p', null, h('b', null, 'Load: '), [...need.values()].map((v) => `${v.n} × ${v.size}-gallon ${v.stream}`).join(', ')) : null,
      short.length ? h('p', { class: 'warn-note' }, `Not enough in the yard: ${short.map(([, v]) => `${v.size}-gallon ${v.stream}`).join(', ')}. Receive carts first.`) : null,
      d.stops.length ? h('ol', { class: 'plain stack' }, d.stops.map((x) => h('li', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('b', null, x.address), x.delivered ? state('Delivered', 'good') : null),
        h('p', null, `${x.kind_label}: ${x.size_gal}-gallon ${x.stream}`, h('span', { class: 'muted small' }, ` ${x.reference}`)),
        !x.delivered && date <= d.today && (crewRole() || office()) ? h('div', { class: 'row no-print' }, button('Delivered', () => deliverDialog({ ...x, deliver_on: date, status: 'scheduled' }, load), { kind: 'primary' })) : null)))
        : empty('No cart deliveries this day.'));
  }
  await load();
}

async function addressPart(panel) {
  let o;
  try { o = await get('/solid-waste/carts/options'); } catch (err) { panel.append(errorBox(err)); return; }
  const street = select([['', 'Choose a street'], ...o.streets.map((x) => [x.id, x.name])], '', { 'aria-label': 'Street' });
  const house = input({ maxlength: 20, placeholder: 'House number', 'aria-label': 'House number', inputmode: 'numeric' });
  const body = h('div');
  const look = async () => {
    if (!street.value || !house.value.trim()) { clear(body).append(h('p', { class: 'muted' }, 'Pick the street and type the house number.')); return; }
    clear(body).append(loading('Looking up the address'));
    let d;
    try { d = await get(`/solid-waste/carts/address?street_id=${street.value}&house_number=${encodeURIComponent(house.value.trim())}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    appendAll(clear(body),
      h('h3', null, d.address), h('p', { class: 'muted small' }, `${d.zone ? `Zone: ${d.zone}. ` : 'No collection zone covers this address. '}${d.service_address ? 'On the water customer list.' : ''}`),
      d.carts.length ? table([
        { head: 'Stream', cell: (c) => c.stream }, { head: 'Size', cell: (c) => `${c.size_gal} gal` }, { head: 'Number', cell: (c) => c.serial || '' },
        { head: 'Since', cell: (c) => (c.delivered_on ? fmtDate(c.delivered_on) : '') }, { head: 'Condition', cell: (c) => (c.cond === 'damaged' ? state('Damaged', 'warn') : 'Good') },
        ...(crewRole() ? [{ head: '', actions: true, cell: (c) => button('Change', () => cartDialog(c, look), { small: true }) }] : []),
      ], d.carts) : empty('No carts on record here.'),
      crewRole() ? button('Put a cart on record', () => addCartDialog(o, Number(street.value), house.value.trim(), look)) : null,
      d.requests.length ? h('div', { class: 'stack' }, h('h4', null, 'Requests'), h('ul', { class: 'plain' }, d.requests.map((r) => h('li', null, `${r.reference}: ${r.kind_label}, ${r.size_gal}-gallon ${r.stream}. `, state(...(STATUS[r.status] || [r.status])))))) : null);
  };
  street.addEventListener('change', look); house.addEventListener('change', look);
  panel.append(h('div', { class: 'row' }, street, house, button('Look up', look)), body);
  const counts = h('div');
  panel.append(counts);
  try {
    const c = await get('/solid-waste/carts/counts');
    if (c.by_size.length) {
      counts.append(h('h3', null, 'Carts in use'), table([{ head: 'Stream', cell: (x) => x.stream }, { head: 'Size', cell: (x) => `${x.size_gal} gal` }, { head: 'Carts', num: true, cell: (x) => x.carts }], c.by_size));
      if (c.by_zone.length) counts.append(h('h3', null, 'By zone'), table([{ head: 'Zone', cell: (x) => x.zone }, { head: 'Stream', cell: (x) => x.stream }, { head: 'Carts', num: true, cell: (x) => x.carts }], c.by_zone));
    }
  } catch (_) { /* the counts are a convenience */ }
}

function addCartDialog(o, streetId, houseNumber, done) {
  const streams = o.streams.map((x) => [x.id, x.name]);
  formDialog(`A cart at ${houseNumber}`, h('div', { class: 'form' },
    field('Stream', select(streams, streams[0] && streams[0][0], { name: 'stream_id' })), field('Size', select(o.sizes.map((g) => [g, `${g} gallons`]), 65, { name: 'size_gal' })),
    field('Number on the cart', input({ name: 'serial', maxlength: 40 })), field('Delivered on, if known', input({ type: 'date', name: 'delivered_on', max: todayStr() })),
    field('Condition', select([['good', 'Good'], ['damaged', 'Damaged']], 'good', { name: 'cond' }))), async (fd) => {
    await post('/solid-waste/carts', { street_id: streetId, house_number: houseNumber, stream_id: Number(s(fd, 'stream_id')), size_gal: Number(s(fd, 'size_gal')), serial: s(fd, 'serial') || null, delivered_on: s(fd, 'delivered_on') || null, cond: s(fd, 'cond') });
    toast('Cart on record'); await done();
  }, { submitText: 'Save' });
}

function cartDialog(c, done) {
  formDialog(`${c.stream} cart, ${c.size_gal} gallons`, h('div', { class: 'form' },
    field('Number on the cart', input({ name: 'serial', maxlength: 40, value: c.serial || '' })), field('Condition', select([['good', 'Good'], ['damaged', 'Damaged']], c.cond, { name: 'cond' })),
    field('Still at the address?', select([['in_use', 'Yes'], ['removed', 'No, taken away'], ['stolen', 'No, stolen']], c.status, { name: 'status' }))), async (fd) => {
    await patch(`/solid-waste/carts/${c.id}`, { serial: s(fd, 'serial') || null, cond: s(fd, 'cond'), status: s(fd, 'status') });
    toast('Saved'); await done();
  });
}

async function stockPart(panel) {
  const body = h('div');
  panel.append(body);
  let o;
  try { o = await get('/solid-waste/carts/options'); } catch (err) { panel.append(errorBox(err)); return; }
  async function load() {
    clear(body).append(loading('Loading the yard'));
    let d;
    try { d = await get('/solid-waste/carts/stock'); } catch (err) { clear(body).append(errorBox(err)); return; }
    const REASON = { received: 'Received', delivered: 'Delivered', returned: 'Came back', scrapped: 'Scrapped', count: 'Counted' };
    appendAll(clear(body),
      crewRole() ? h('div', { class: 'row' }, button('Receive carts', () => stockDialog('received', o, load), { kind: 'primary' }), button('Scrap', () => stockDialog('scrapped', o, load)), button('Count', () => stockDialog('count', o, load))) : null,
      d.stock.length ? table([{ head: 'Stream', cell: (x) => x.stream }, { head: 'Size', cell: (x) => `${x.size_gal} gal` }, { head: 'In the yard', num: true, cell: (x) => (x.on_hand ? String(x.on_hand) : state('None', 'warn')) }], d.stock) : empty('No carts in the yard on record yet.'),
      d.moves.length ? h('div', { class: 'stack' }, h('h3', null, 'Recent changes'), table([
        { head: 'When', cell: (m) => fmtInstant(m.created_at) }, { head: 'Cart', cell: (m) => `${m.size_gal}-gallon ${m.stream}` }, { head: 'What', cell: (m) => `${REASON[m.reason] || m.reason}${m.note ? `: ${m.note}` : ''}` },
        { head: 'Change', num: true, cell: (m) => (m.delta > 0 ? `+${m.delta}` : String(m.delta)) }, { head: 'Left', num: true, cell: (m) => m.on_hand }], d.moves)) : null);
  }
  await load();
}

function stockDialog(reason, o, done) {
  const streams = o.streams.map((x) => [x.id, x.name]);
  const title = { received: 'Carts received', scrapped: 'Carts scrapped', count: 'Count the yard' }[reason];
  formDialog(title, h('div', { class: 'form' },
    field('Stream', select(streams, streams[0] && streams[0][0], { name: 'stream_id' })), field('Size', select(o.sizes.map((g) => [g, `${g} gallons`]), 65, { name: 'size_gal' })),
    field(reason === 'count' ? 'How many are in the yard' : 'How many', input({ type: 'number', name: 'quantity', min: reason === 'count' ? 0 : 1, max: 5000, required: true })),
    h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 200 })))), async (fd) => {
    const out = await post('/solid-waste/carts/stock', { stream_id: Number(s(fd, 'stream_id')), size_gal: Number(s(fd, 'size_gal')), reason, quantity: Number(s(fd, 'quantity')), note: s(fd, 'note') || null });
    toast(`${out.on_hand} in the yard now`); await done();
  });
}

async function setupPart(panel) {
  let d;
  try { d = await get('/solid-waste/carts/setup'); } catch (err) { panel.append(errorBox(err)); return; }
  if (!d.streams.length) { panel.append(empty('Add the collection streams first (Schedule), then the cart sizes for each.')); return; }
  const online = h('input', { type: 'checkbox', checked: d.online });
  const maxExtra = input({ type: 'number', min: 0, max: 10, value: d.max_extra, 'aria-label': 'Extra carts allowed' });
  const rules = h('textarea', { rows: 4, maxlength: 4000 }, d.rules_text || '');
  const rowsBy = [];
  const grid = h('div', { class: 'stack' }, d.streams.map((st) => h('fieldset', { class: 'stack tight' }, h('legend', null, st.name), ...d.sizes.map((g) => {
    const have = d.options.find((x) => x.stream_id === st.id && x.size_gal === g);
    const on = h('input', { type: 'checkbox', checked: Boolean(have && have.active) });
    const extra = input({ inputmode: 'decimal', value: have ? centsToInput(have.extra_fee_cents) : '0.00', 'aria-label': `${st.name} ${g} gallons extra cart fee`, size: 6 });
    const repl = input({ inputmode: 'decimal', value: have ? centsToInput(have.replacement_fee_cents) : '0.00', 'aria-label': `${st.name} ${g} gallons replacement fee`, size: 6 });
    rowsBy.push({ stream_id: st.id, size_gal: g, on, extra, repl, had: Boolean(have) });
    return h('div', { class: 'row' }, h('label', { class: 'check' }, on, `${g} gallons`), field('Extra cart fee $', extra), field('Replacement fee $', repl));
  }))));
  const save = button('Save', async () => {
    try {
      const options = rowsBy.filter((r) => r.on.checked || r.had).map((r) => ({ stream_id: r.stream_id, size_gal: r.size_gal, extra_fee_cents: toCents(r.extra.value) || 0, replacement_fee_cents: toCents(r.repl.value) || 0, active: r.on.checked }));
      await put('/solid-waste/carts/setup', { online: online.checked, max_extra: Number(maxExtra.value || 0), rules_text: rules.value.trim() || null, options: options.filter((x) => x.active || rowsBy.find((r) => r.stream_id === x.stream_id && r.size_gal === x.size_gal).had) });
      toast('Saved');
    } catch (err) { fail(err); }
  }, { kind: 'primary' });
  panel.append(h('div', { class: 'stack' },
    h('p', null, 'Residents ask for a cart at ', h('a', { href: d.page, target: '_blank', rel: 'noopener' }, d.page), '. A new home\'s first cart and a stolen cart are free; an extra cart and a replacement for one damaged by misuse carry the fee set here. A fee of $0 makes it free.'),
    d.card_ready ? null : h('p', { class: 'warn-note' }, 'Card payment is not set up, so fees are paid at the office. Connect Stripe under Settings, Payments.'),
    h('label', { class: 'check' }, online, 'Take cart requests online'), field('Extra carts allowed per stream at one address', maxExtra),
    grid, field('What residents read on the page (one point per line)', rules), h('div', { class: 'row' }, save)));
}

// ================================================================ Tonnage
async function tonnageTab(el) {
  const parts = [['figures', 'Figures', figuresPart], ['tickets', 'Weigh tickets', ticketsPart], ['import', 'Bring in a report', importPart]];
  if (isManager()) parts.push(['facilities', 'Facilities', facilitiesPart]);
  el.append(tabs(parts, hashParam('part') || (hashParam('new') === '1' ? 'tickets' : 'figures'), { param: 'part' }));
}

async function figuresPart(panel) {
  let year = Number(hashParam('year')) || Number(todayStr().slice(0, 4));
  const body = h('div');
  panel.append(body);
  async function load() {
    clear(body).append(loading('Adding up the tons'));
    let f;
    try { f = await get(`/solid-waste/tonnage/figures?year=${year}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    const years = []; for (let y = Number(f.today.slice(0, 4)); y >= Math.min(f.first_year, Number(f.today.slice(0, 4)) - 1); y -= 1) years.push([y, String(y)]);
    const pick = select(years, year, { 'aria-label': 'Year' });
    pick.addEventListener('change', () => { year = Number(pick.value); load(); });
    const kinds = ['trash', 'recycling', 'yard', 'food', 'other'].filter((k) => f.totals.by_stream[k] !== undefined);
    const maxTons = Math.max(1, ...f.months.map((m) => m.all_tons));
    const bar = (m) => h('div', { class: 'tn-bar', role: 'img', 'aria-label': `${m.all_tons} tons` }, kinds.map((k) => (m.tons[k] ? h('span', { class: `tn-${k}`, style: `width:${(m.tons[k] / maxTons) * 100}%`, title: `${STREAM_WORDS[k]} ${tons(m.tons[k])}` }) : null)));
    appendAll(clear(body),
      h('div', { class: 'week-bar' }, h('div', { class: 'row' }, pick), h('div', { class: 'week-actions' }, office() ? button('Tickets spreadsheet', async () => { try { await download(`/solid-waste/tonnage/tickets.csv?from=${year}-01-01&to=${year}-12-31`, `weigh-tickets-${year}.csv`); } catch (err) { fail(err); } }) : null)),
      h('div', { class: 'figures' },
        figure(tons(f.totals.all_tons), 'tons in all', `${f.totals.tickets} weigh tickets`),
        figure(f.recycling_rate === null ? '–' : `${f.recycling_rate}%`, 'recycling rate', `${tons(f.totals.recycled_tons)} tons recycled`),
        figure(f.pounds_per_household === null ? '–' : lbs(f.pounds_per_household), 'pounds per household', f.households ? `${lbs(f.households)} households${f.households_source === 'carts' ? ' with carts' : ''}` : 'Households not known'),
        f.cost_per_ton_cents !== undefined && f.cost_per_ton_cents !== null ? figure(money(f.cost_per_ton_cents), 'per ton', `${money(f.fees_cents)} in tipping fees`) : null),
      h('p', { class: 'muted small' }, 'Recycling rate: recycling, yard waste and food waste tons over all tons. Pounds per household: all tons over the households on the water customer list (or the addresses with carts).'),
      f.months.length ? h('div', { class: 'stack' }, h('h3', null, 'By month'),
        h('p', { class: 'tn-legend small' }, kinds.map((k) => h('span', null, h('i', { class: `tn-${k}` }), STREAM_WORDS[k]))),
        table([
          { head: 'Month', cell: (m) => fmtMonth(m.month) }, ...kinds.map((k) => ({ head: STREAM_WORDS[k], num: true, cell: (m) => tons(m.tons[k] || 0) })),
          { head: 'All tons', num: true, cell: (m) => h('b', null, tons(m.all_tons)) }, { head: 'Rate', num: true, cell: (m) => (m.recycling_rate === null ? '' : `${m.recycling_rate}%`) },
          ...(f.cost_per_ton_cents !== undefined ? [{ head: 'Per ton', num: true, cell: (m) => (m.cost_per_ton_cents === null || m.cost_per_ton_cents === undefined ? '' : money(m.cost_per_ton_cents)) }] : []),
          { head: '', cell: bar },
        ], f.months)) : empty(`No weigh tickets for ${year} yet.`),
      f.facilities.length ? h('div', { class: 'stack' }, h('h3', null, 'By facility'), table([
        { head: 'Facility', cell: (x) => x.name }, { head: 'Tickets', num: true, cell: (x) => x.tickets }, { head: 'Tons', num: true, cell: (x) => tons(x.tons) },
        ...(f.cost_per_ton_cents !== undefined ? [{ head: 'Fees', num: true, cell: (x) => (x.fees_cents === undefined ? '' : money(x.fees_cents)) }, { head: 'Per ton', num: true, cell: (x) => (x.cost_per_ton_cents ? money(x.cost_per_ton_cents) : '') }] : []),
      ], f.facilities)) : null,
      f.zones.length ? h('div', { class: 'stack' }, h('h3', null, 'By zone'), table([{ head: 'Zone', cell: (z) => z.zone }, ...kinds.map((k) => ({ head: STREAM_WORDS[k], num: true, cell: (z) => tons(z.tons[k] || 0) })), { head: 'All tons', num: true, cell: (z) => tons(z.all_tons) }], f.zones),
        h('p', { class: 'muted small' }, 'A ticket counts for a zone when the truck\'s route that day was in that zone (entered with the ticket, or by the driver).')) : null,
      f.materials.length ? h('div', { class: 'stack' }, h('h3', null, 'By material'), table([{ head: 'Material', cell: (m) => m.label }, { head: 'Tons', num: true, cell: (m) => tons(m.tons) }], f.materials)) : null);
  }
  await load();
}
const fmtMonth = (ym) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-15T12:00:00Z`));

async function ticketsPart(panel) {
  const today = todayStr();
  const from = input({ type: 'date', value: `${today.slice(0, 7)}-01`, 'aria-label': 'From' }); const to = input({ type: 'date', value: today, 'aria-label': 'To' });
  const search = input({ type: 'search', placeholder: 'Ticket number, hauler or truck', 'aria-label': 'Search tickets' });
  const body = h('div');
  [from, to].forEach((x) => x.addEventListener('change', () => load()));
  let timer = null; search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
  let setup;
  try { setup = await get('/solid-waste/tonnage/setup'); } catch (err) { panel.append(errorBox(err)); return; }
  panel.append(h('div', { class: 'week-bar' }, h('div', { class: 'row' }, from, to, search), h('div', { class: 'week-actions' }, office() ? button('Add a ticket', () => ticketDialog(setup, load), { kind: 'primary' }) : null)), body);
  async function load() {
    clear(body).append(loading('Loading tickets'));
    let d;
    try { d = await get(`/solid-waste/tonnage/tickets?from=${from.value}&to=${to.value}${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    appendAll(clear(body),
      h('p', null, h('b', null, `${d.totals.tickets} ticket${d.totals.tickets === 1 ? '' : 's'}, ${tons(d.totals.net_tons)} tons`), d.totals.fees_cents !== undefined && d.totals.fees_cents ? `, ${money(d.totals.fees_cents)} in fees` : ''),
      d.data.length ? table([
        { head: 'Date', cell: (t) => fmtDate(t.on_date) }, { head: 'Ticket', cell: (t) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); ticketDetail(t.id, load); } }, t.ticket_no || 'No number') },
        { head: 'Facility', cell: (t) => t.facility }, { head: 'Stream', cell: (t) => t.stream || STREAM_WORDS[t.stream_kind] }, { head: 'Net tons', num: true, cell: (t) => tons(t.net_tons) },
        ...(isManager() ? [{ head: 'Fee', num: true, cell: (t) => (t.fee_cents === null || t.fee_cents === undefined ? '' : money(t.fee_cents)) }] : []),
        { head: 'From', cell: (t) => ({ office: 'Office', driver: 'Driver', import: 'Spreadsheet' }[t.source]) }, { head: 'Photo', cell: (t) => (t.photos ? 'Yes' : '') },
      ], d.data) : empty('No weigh tickets in these dates.'));
  }
  await load();
  if (office()) whenNew(panel, () => ticketDialog(setup, load)); // #/bulk?tab=tonnage&new=1 (+ New "Weigh ticket")
}

function ticketDialog(setup, done) {
  if (!setup.facilities.filter((f) => f.active).length) { dialog('Add a facility first', h('p', null, isManager() ? 'Add the landfill, transfer station or recycling processor under Tonnage, Facilities.' : 'A manager adds the facilities first.')); return; }
  const streamOpts = setup.streams.length ? setup.streams.map((x) => [`s${x.id}`, x.name]) : setup.stream_kinds.map((k) => [`k${k}`, STREAM_WORDS[k]]);
  const stream = select(streamOpts, streamOpts[0][0], { name: 'stream' });
  const kindOf = () => (stream.value.startsWith('s') ? (setup.streams.find((x) => `s${x.id}` === stream.value) || {}).kind : stream.value.slice(1));
  const material = select([], '', { name: 'material' });
  const fillMaterials = () => { const k = kindOf(); clear(material).append(...setup.materials.filter((m) => m.kind === k || (k === 'other' && m.kind !== 'trash')).map((m) => h('option', { value: m.key }, m.label))); };
  stream.addEventListener('change', fillMaterials); fillMaterials();
  const unit = select([['scale', 'Gross and tare (pounds)'], ['net_lb', 'Net only, in pounds'], ['net_tons', 'Net only, in tons']], 'scale', { 'aria-label': 'How the weight is given' });
  const gross = input({ name: 'gross_lb', inputmode: 'numeric' }); const tare = input({ name: 'tare_lb', inputmode: 'numeric' }); const net = input({ name: 'net', inputmode: 'decimal' });
  const netLine = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const grossRow = field('Gross (full truck), pounds', gross); const tareRow = field('Tare (empty truck), pounds', tare); const netRow = field('Net', net);
  const sync = () => {
    const scale = unit.value === 'scale';
    grossRow.hidden = !scale; tareRow.hidden = !scale; netRow.hidden = scale;
    const g = numOrNull(gross.value); const t = numOrNull(tare.value);
    netLine.textContent = scale && g !== null && t !== null ? (t >= g ? 'The tare must be less than the gross.' : `Net ${lbs(g - t)} pounds, ${tons((g - t) / 2000)} tons`) : '';
  };
  [unit, gross, tare].forEach((x) => x.addEventListener('input', sync)); unit.addEventListener('change', sync);
  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
  const facility = select(setup.facilities.filter((f) => f.active).map((f) => [f.id, f.name]), '', { name: 'facility_id', required: true });
  formDialog('Add a weigh ticket', h('div', { class: 'form' },
    field('Date', input({ type: 'date', name: 'on_date', required: true, max: setup.today, value: setup.today })), field('Ticket number', input({ name: 'ticket_no', maxlength: 40 })),
    field('Facility', facility), field('Stream', stream), field('Material', material),
    field('Where it came from', select(Object.entries(setup.sectors), 'res_curb', { name: 'sector' })),
    setup.zones.length ? field('Zone (the route that day)', select([['', 'Not recorded'], ...setup.zones.map((z) => [z.id, z.name])], '', { name: 'zone_id' })) : null,
    setup.trucks.length ? field('Truck', select([['', 'Not recorded'], ...setup.trucks.map((t) => [t.id, `${t.name}${t.asset_tag ? ` (${t.asset_tag})` : ''}`])], '', { name: 'truck_asset_id' })) : field('Truck', input({ name: 'truck_label', maxlength: 60 })),
    h('div', { class: 'wide' }, field('Weight given as', unit)), grossRow, tareRow, netRow, h('div', { class: 'wide' }, netLine),
    isManager() ? field('Tipping fee $ (blank: the facility\'s fee per ton)', input({ name: 'fee', inputmode: 'decimal' })) : null,
    field('Hauler, if not the borough', input({ name: 'hauler', maxlength: 120 })), h('div', { class: 'wide' }, field('Photo of the ticket', photo)),
    h('div', { class: 'wide' }, field('Note', input({ name: 'note', maxlength: 300 })))), async (fd) => {
    const sv = stream.value;
    const body = { on_date: s(fd, 'on_date'), ticket_no: s(fd, 'ticket_no') || null, facility_id: Number(s(fd, 'facility_id')), material: s(fd, 'material') || null, sector: s(fd, 'sector'),
      zone_id: s(fd, 'zone_id') ? Number(s(fd, 'zone_id')) : null, truck_asset_id: s(fd, 'truck_asset_id') ? Number(s(fd, 'truck_asset_id')) : null, truck_label: s(fd, 'truck_label') || null,
      hauler: s(fd, 'hauler') || null, note: s(fd, 'note') || null, ...(sv.startsWith('s') ? { stream_id: Number(sv.slice(1)) } : { stream_kind: sv.slice(1) }) };
    if (unit.value === 'scale') { body.gross_lb = numOrNull(gross.value); body.tare_lb = numOrNull(tare.value); } else if (unit.value === 'net_lb') body.net_lb = numOrNull(net.value); else body.net_tons = numOrNull(net.value);
    if (isManager() && s(fd, 'fee')) body.fee_cents = toCents(s(fd, 'fee'));
    const out = await post('/solid-waste/tonnage/tickets', body);
    if (photo.files && photo.files[0]) { try { await sendBytes('POST', `/solid-waste/tonnage/tickets/${out.id}/photos`, photo.files[0]); } catch (err) { toast(`Ticket saved, but the photo did not upload: ${err.message}`, 'error'); } }
    toast(`Ticket saved: ${tons(out.net_tons)} tons`); await done();
  }, { submitText: 'Save ticket', wide: true });
  sync();
}

async function ticketDetail(id, done) {
  let t;
  try { t = await get(`/solid-waste/tonnage/tickets/${id}`); } catch (err) { fail(err); return; }
  const again = async () => { closeAllDialogs(); await done(); ticketDetail(id, done); };
  const photos = h('div', { class: 'row' });
  for (const p of t.photo_list) {
    const img = h('img', { class: 'lf-photo', alt: `Photo of ticket ${t.ticket_no || ''}` });
    photos.append(h('figure', null, img, h('figcaption', { class: 'muted small' }, `SHA-256 ${p.sha256.slice(0, 12)}…`)));
    fetchBlob(`/solid-waste/tonnage/tickets/${id}/photos/${p.id}`).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
  }
  const add = h('input', { type: 'file', accept: 'image/*', capture: 'environment', 'aria-label': 'Add a photo of the ticket' });
  add.addEventListener('change', async () => { if (!add.files[0]) return; try { await sendBytes('POST', `/solid-waste/tonnage/tickets/${id}/photos`, add.files[0]); toast('Photo added'); await again(); } catch (err) { fail(err); } });
  dialog(`Ticket ${t.ticket_no || '(no number)'}`, h('div', { class: 'stack' },
    h('p', null, `${fmtDay(t.on_date)} at ${t.facility}. ${t.stream || STREAM_WORDS[t.stream_kind]}: ${t.material_label}.`),
    h('p', null, t.gross_lb !== null ? `Gross ${lbs(t.gross_lb)} lb, tare ${lbs(t.tare_lb)} lb, ` : '', h('b', null, `net ${lbs(t.net_lb)} lb (${tons(t.net_tons)} tons)`), t.fee_cents !== undefined && t.fee_cents !== null ? `. Fee ${money(t.fee_cents)}` : ''),
    t.zone || t.truck || t.hauler ? h('p', { class: 'muted' }, [t.zone ? `Zone ${t.zone}` : '', t.truck ? `Truck ${t.truck}` : '', t.hauler ? `Hauler ${t.hauler}` : ''].filter(Boolean).join('. ')) : null,
    t.voided ? h('p', { class: 'warn-note' }, `Taken out: ${t.void_reason}`) : null,
    t.photo_list.length ? photos : null, office() && !t.voided ? field('Add a photo', add) : null,
    isManager() && !t.voided ? h('div', { class: 'row' }, button('Take this ticket out', () => {
      const why = input({ maxlength: 200, required: true, placeholder: 'For example: entered twice' });
      formDialog('Take the ticket out?', field('Why', why), async () => { await post(`/solid-waste/tonnage/tickets/${id}/void`, { reason: why.value.trim() }); toast('Taken out'); await again(); }, { submitText: 'Take out' });
    })) : null), { wide: true });
}

async function importPart(panel) {
  if (!office()) { panel.append(empty('The office brings in facility and hauler reports.')); return; }
  let setup;
  try { setup = await get('/solid-waste/tonnage/setup'); } catch (err) { panel.append(errorBox(err)); return; }
  const file = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'The report file' });
  const sourceName = input({ maxlength: 120, placeholder: 'For example: Blue Mountain MRF, October statement', 'aria-label': 'Whose report' });
  const facility = select([['', 'Named on each line'], ...setup.facilities.filter((f) => f.active).map((f) => [f.id, f.name])], '', { 'aria-label': 'Facility' });
  const hauler = input({ maxlength: 120, placeholder: 'Leave blank for the borough\'s own trucks', 'aria-label': 'Hauler' });
  const out = h('div');
  const read = () => new Promise((res, rej) => { const f = file.files[0]; if (!f) { rej(new Error('Pick the file first')); return; } const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Could not read the file')); r.readAsText(f); });
  const run = async (dry) => {
    const csv = await read();
    if (!sourceName.value.trim()) throw new Error('Say whose report this is');
    const r = await post('/solid-waste/tonnage/import', { csv, source_name: sourceName.value.trim(), file_name: file.files[0].name, facility_id: facility.value ? Number(facility.value) : null, hauler: hauler.value.trim() || null, dry_run: dry });
    appendAll(clear(out),
      h('p', null, h('b', null, dry ? `${r.added} of ${r.rows} lines can come in.` : `${r.added} of ${r.rows} lines came in.`), r.skipped.length ? ` ${r.skipped.length} ${dry ? 'would be' : 'were'} left out:` : ''),
      r.skipped.length ? table([{ head: 'Line', num: true, cell: (x) => x.line }, { head: 'Why', cell: (x) => x.reason }], r.skipped) : null,
      dry && r.added ? button(`Bring in ${r.added} line${r.added === 1 ? '' : 's'}`, async () => { try { await run(false); toast('Brought in'); } catch (err) { fail(err); } }, { kind: 'primary' }) : null);
  };
  panel.append(h('div', { class: 'stack' },
    h('p', null, 'A landfill\'s, processor\'s or hauler\'s monthly report as a spreadsheet (CSV). The first row names the columns: a date, a ticket number, the facility, the material or stream, and the weight as gross and tare, net pounds, or tons. A fee column is read too. Check it first: nothing is added until you bring it in, a line already entered is never added twice, and a line that cannot be read is listed with the reason.'),
    h('div', { class: 'form' }, field('The file', file), field('Whose report', sourceName), field('Facility', facility), field('Hauler', hauler)),
    h('div', { class: 'row' }, button('Check the file', async () => { try { await run(true); } catch (err) { fail(err); } }, { kind: 'primary' })), out));
}

async function facilitiesPart(panel) {
  const body = h('div');
  panel.append(body);
  async function load() {
    let d;
    try { d = await get('/solid-waste/tonnage/setup'); } catch (err) { clear(body).append(errorBox(err)); return; }
    appendAll(clear(body),
      h('div', { class: 'row' }, button('Add a facility', () => facilityDialog(null, d, load), { kind: 'primary' })),
      d.facilities.length ? table([
        { head: 'Facility', cell: (f) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); facilityDialog(f, d, load); } }, f.name) }, { head: 'Kind', cell: (f) => d.facility_kinds[f.kind] },
        { head: 'Fee per ton', num: true, cell: (f) => (f.fee_per_ton_cents === null || f.fee_per_ton_cents === undefined ? '' : money(f.fee_per_ton_cents)) }, { head: 'Residue', num: true, cell: (f) => (f.residue_pct ? `${f.residue_pct}%` : '') },
        { head: '', cell: (f) => (f.active ? '' : state('Not used', 'neutral')) }], d.facilities) : empty('No facilities yet. Add the landfill, transfer station and recycling processor the trucks go to.'));
  }
  await load();
}
function facilityDialog(f, d, done) {
  formDialog(f ? f.name : 'Add a facility', h('div', { class: 'form' },
    field('Name', input({ name: 'name', maxlength: 120, required: true, value: f ? f.name : '' })), field('Kind', select(Object.entries(d.facility_kinds), f ? f.kind : 'landfill', { name: 'kind' })),
    h('div', { class: 'wide' }, field('Address', input({ name: 'address', maxlength: 200, value: f ? f.address || '' : '' }))),
    field('Usual tipping fee per ton $', input({ name: 'fee', inputmode: 'decimal', value: f && f.fee_per_ton_cents !== null ? centsToInput(f.fee_per_ton_cents) : '' })),
    field('Residue the processor reports, %', input({ name: 'residue_pct', type: 'number', min: 0, max: 60, step: '0.1', value: f ? f.residue_pct : 0 }), 'Taken off the recycled tons in the annual report.'),
    f ? h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'active', checked: f.active }), 'In use') : null), async (fd) => {
    const body = { name: s(fd, 'name'), kind: s(fd, 'kind'), address: s(fd, 'address') || null, fee_per_ton_cents: s(fd, 'fee') ? toCents(s(fd, 'fee')) : null, residue_pct: Number(s(fd, 'residue_pct') || 0), active: f ? fd.get('active') === 'on' : true };
    if (f) await put(`/solid-waste/tonnage/facilities/${f.id}`, body); else await post('/solid-waste/tonnage/facilities', body);
    toast('Saved'); await done();
  });
}

// ================================================================ Recycling report
async function recyclingTab(el) {
  const body = h('div');
  el.append(body);
  let base;
  try { base = await get('/solid-waste/recycling-report'); } catch (err) { body.append(errorBox(err)); return; }
  let year = Number(hashParam('year')) || base.current_year;
  const years = [...new Set([base.current_year, ...base.years.map((y) => y.year)])].sort((a, b) => b - a);
  const pick = select(years.map((y) => [y, String(y)]), year, { 'aria-label': 'Report year' });
  pick.addEventListener('change', () => { year = Number(pick.value); draw(); });
  const main = h('div');
  body.append(h('p', { class: 'muted no-print' }, 'Pennsylvania Act 101: each year the municipality reports the year before to its county recycling coordinator, who reports to DEP. This report follows the DEP / county municipal report: tons by material in four columns (residential curbside, residential drop-off, commercial curbside, commercial drop-off), residue taken off, and the processor named. Chester County\'s form came first; other counties use the same categories. If your county asks for something different, tell us: it is a small change.'),
    h('div', { class: 'week-bar no-print' }, h('div', { class: 'row' }, pick)), main);
  async function draw() {
    clear(main).append(loading('Loading the report'));
    const r = await get(`/solid-waste/recycling-report/${year}`).catch((err) => err);
    if (r instanceof Error) {
      if (r.status !== 404) { clear(main).append(errorBox(r)); return; }
      appendAll(clear(main), empty(`The ${year} report is not open yet. It opens by itself in December; you can open it now.`, button(`Open the ${year} report`, async () => { try { await post(`/solid-waste/recycling-report/${year}/open`); toast('Opened'); draw(); } catch (err) { fail(err); } }, { kind: 'primary' })),
        reportersBlock(base.reporters, draw));
      return;
    }
    const parts = [['forms', 'Reporters', (p) => formsPart(p, r, year, draw)], ['report', 'Municipal report', (p) => municipalPart(p, year)], ['packet', 'Section 904 packet', (p) => packetPart(p, year)], ['settings', 'Report details', (p) => detailsPart(p, r, year, draw)]];
    appendAll(clear(main),
      h('div', { class: 'figures' },
        figure(r.status === 'open' ? 'Open' : 'Closed', `${year} report`, `Due to ${r.county} County ${fmtDay(r.due_on)}`),
        figure(`${r.summary.answered} of ${r.summary.forms}`, 'reporters answered'), figure(tons(r.summary.total), 'tons recycled', r.summary.residue ? `${tons(r.summary.residue)} tons residue taken off` : null),
        figure(r.summary.recycling_rate === null ? '–' : `${r.summary.recycling_rate}%`, 'recycling rate')),
      tabs(parts, hashParam('part') || 'forms', { param: 'part' }));
  }
  await draw();
}

function reportersBlock(reporters, done) {
  return h('div', { class: 'stack' }, h('h3', null, 'Haulers and businesses that report'),
    reporters.length ? table([
      { head: 'Name', cell: (p) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); reporterDialog(p, done); } }, p.name) }, { head: 'Form', cell: (p) => p.form },
      { head: 'Email', cell: (p) => p.email || h('span', { class: 'muted' }, 'None: the office types in their answer') }, { head: '', cell: (p) => (p.active ? '' : state('Not asked', 'neutral')) }], reporters)
      : empty('No one on the list yet. Add the licensed haulers (DEP forms FM-12, FM-13) and the businesses that must report (FM-11).'),
    h('div', { class: 'row' }, button('Add a hauler or business', () => reporterDialog(null, done))));
}
function reporterDialog(p, done) {
  formDialog(p ? p.name : 'Add a hauler or business', h('div', { class: 'form' },
    field('Name', input({ name: 'name', maxlength: 120, required: true, value: p ? p.name : '' })), field('Kind', select([['hauler', 'Hauler (FM-12 / FM-13)'], ['business', 'Business (FM-11)']], p ? p.kind : 'hauler', { name: 'kind' })),
    field('Contact', input({ name: 'contact_name', maxlength: 120, value: p ? p.contact_name || '' : '' })), field('Email (their form link goes here)', input({ type: 'email', name: 'email', maxlength: 255, value: p ? p.email || '' : '' })),
    field('Phone', input({ type: 'tel', name: 'phone', maxlength: 40, value: p ? p.phone || '' : '' })),
    p ? h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'active', checked: p.active }), 'Asked to report') : null), async (fd) => {
    const body = { name: s(fd, 'name'), kind: s(fd, 'kind'), contact_name: s(fd, 'contact_name') || null, email: s(fd, 'email') || null, phone: s(fd, 'phone') || null, active: p ? fd.get('active') === 'on' : true };
    if (p) await put(`/solid-waste/recycling-report/reporters/${p.id}`, body); else await post('/solid-waste/recycling-report/reporters', body);
    toast('Saved'); await done();
  });
}

async function formsPart(panel, r, year, redraw) {
  const open = r.status === 'open';
  const notSent = r.forms.filter((f) => f.active && !f.answered_at && !f.sent_at && f.email).length;
  const base = await get('/solid-waste/recycling-report').catch(() => ({ reporters: [] }));
  appendAll(panel,
    open ? h('div', { class: 'row no-print' },
      button(notSent ? `Send the forms (${notSent})` : 'Send the forms again to those not answered', () => confirmDialog('Send the forms?', 'Each hauler and business not yet answered gets an email with a link to its own form. A new link replaces the one sent before. Reminders go out by themselves on January 15, and a last one on the follow-up day.', 'Send', async () => {
        const out = await post(`/solid-waste/recycling-report/${year}/send`, {});
        toast(`Sent ${out.sent}${out.no_email.length ? `. No email for ${out.no_email.join(', ')}: type their answers in.` : ''}`); await redraw();
      }), { kind: 'primary' })) : h('p', { class: 'muted' }, 'This report is closed: its links no longer open.'),
    r.forms.length ? table([
      { head: 'Reporter', cell: (f) => h('span', null, f.name, h('br'), h('span', { class: 'muted small' }, f.form)) },
      { head: 'Sent', cell: (f) => (f.sent_at ? fmtInstant(f.sent_at) : f.email ? 'Not yet' : 'No email') },
      { head: 'Answer', cell: (f) => (f.answered_at ? h('span', null, state('Answered', 'good'), ` ${f.none_to_report ? 'nothing collected' : `${tons(f.tons)} tons`}`, f.answered_by === 'office' ? ' (typed in by the office)' : '') : state(r.followup_due ? 'Follow up' : 'Waiting', r.followup_due ? 'bad' : 'warn')) },
      { head: '', actions: true, cell: (f) => h('div', { class: 'row' },
        button(f.answered_at ? 'See or change' : 'Type in their answer', () => answerDialog(year, f.id, redraw), { small: true }),
        open ? button('Get a link', async () => { try { const out = await post(`/solid-waste/recycling-report/${year}/forms/${f.id}/link`); dialog(`Link for ${f.name}`, [h('p', null, 'Give this link to them by phone or in your own email. The one sent before stops working.'), h('p', null, h('code', null, out.link))]); } catch (err) { fail(err); } }, { small: true }) : null) },
    ], r.forms) : empty('No haulers or businesses on the list.'),
    r.followup.length && r.followup_due ? h('div', { class: 'stack' }, h('h3', null, `Follow-up list (since ${fmtDay(r.followup_on)})`),
      h('ul', { class: 'plain' }, r.followup.map((f) => h('li', null, h('b', null, f.name), ` ${[f.contact_name, f.phone, f.email].filter(Boolean).join(', ') || 'no contact on file'}`)))) : null,
    reportersBlock(base.reporters, redraw));
}

async function answerDialog(year, formId, done) {
  let f;
  try { f = await get(`/solid-waste/recycling-report/${year}/forms/${formId}`); } catch (err) { fail(err); return; }
  const rowsEl = h('div', { class: 'stack' });
  const none = h('input', { type: 'checkbox', checked: f.none_to_report });
  const addLine = (l = {}) => {
    const mat = select(f.materials.map((m) => [m.key, m.label]), l.material || 'commingled', { 'aria-label': 'Material' });
    const cols = f.columns.map((c) => ({ key: c.key, el: input({ inputmode: 'decimal', value: l[c.key] || '', 'aria-label': `${c.label} tons`, size: 6 }), label: c.label }));
    const residue = input({ inputmode: 'decimal', value: l.residue || '', 'aria-label': 'Residue tons', size: 6 });
    const proc = input({ maxlength: 160, value: l.processor || '', 'aria-label': 'Processor or market' });
    const row = h('fieldset', { class: 'stack tight' }, h('legend', null, 'Material'), mat, h('div', { class: 'row' }, ...cols.map((c) => field(`${c.label}, tons`, c.el)), field('Residue, tons', residue)), field('Processor or market', proc),
      button('Remove', () => { row.remove(); lines.splice(lines.indexOf(entry), 1); }, { small: true }));
    const entry = { mat, cols, residue, proc };
    lines.push(entry); rowsEl.append(row);
  };
  const lines = [];
  (f.lines.length ? f.lines : [{}]).forEach(addLine);
  formDialog(`${f.reporter}: ${year}`, h('div', { class: 'stack' }, h('p', { class: 'muted small' }, f.form),
    h('label', { class: 'check' }, none, 'They collected nothing in the municipality this year'), rowsEl, button('Add a material', () => addLine())), async () => {
    const body = { none: none.checked, lines: none.checked ? [] : lines.map((x) => ({ material: x.mat.value, ...Object.fromEntries(x.cols.map((c) => [c.key, Number(c.el.value || 0)])), residue: Number(x.residue.value || 0), processor: x.proc.value.trim() })) };
    await post(`/solid-waste/recycling-report/${year}/forms/${formId}/answer`, body);
    toast('Answer saved'); await done();
  }, { submitText: 'Save answer', wide: true });
}

function reportTable(rep) {
  const cols = rep.columns;
  return table([
    { head: 'Material', cell: (m) => (m.material === '_total' ? h('b', null, 'Total recycled') : m.label) },
    ...cols.map((c) => ({ head: c.label, num: true, cell: (m) => tons(m[c.key]) })),
    { head: 'Residue taken off', num: true, cell: (m) => tons(m.residue) }, { head: 'Total tons', num: true, cell: (m) => h('b', null, tons(m.total)) },
    { head: 'Processor or market', cell: (m) => (m.processors || []).join('; ') },
  ], [...rep.rows, { material: '_total', ...rep.totals }]);
}

async function municipalPart(panel, year) {
  let rep;
  try { rep = await get(`/solid-waste/recycling-report/${year}/report`); } catch (err) { panel.append(errorBox(err)); return; }
  appendAll(panel,
    h('div', { class: 'row no-print' }, button('Print', () => window.print()), button('Spreadsheet for the county', async () => { try { await download(`/solid-waste/recycling-report/${year}/report.csv`, `recycling-report-${year}.csv`); } catch (err) { fail(err); } }, { kind: 'primary' })),
    h('h2', null, `${rep.town}: ${year} municipal recycling report`),
    h('p', null, rep.report ? `For ${rep.report.county} County, due ${fmtDay(rep.report.due_on)}.` : '', ` Trash: ${tons(rep.trash_tons)} tons. Recycling rate ${rep.recycling_rate === null ? 'not known' : `${rep.recycling_rate}%`}.`),
    rep.rows.length ? reportTable(rep) : empty('No recycled tons yet: weigh tickets and reporters\' answers fill this in.'),
    rep.sources.length ? h('details', null, h('summary', null, 'Where each number came from'), table([
      { head: 'From', cell: (x) => x.source }, { head: 'Material', cell: (x) => x.label }, { head: 'Tons', num: true, cell: (x) => tons(x.total) }, { head: 'Residue', num: true, cell: (x) => tons(x.residue) }, { head: 'Processor', cell: (x) => x.processor },
    ], rep.sources)) : null,
    h('p', { class: 'muted small' }, 'Own weigh tickets count recycled materials only, with each processor\'s residue share taken off (Tonnage, Facilities). Do not list a hauler whose tickets the office already enters, or its tons count twice.'));
}

async function packetPart(panel, year) {
  let p;
  try { p = await get(`/solid-waste/recycling-report/${year}/packet`); } catch (err) { panel.append(errorBox(err)); return; }
  const withPhoto = p.documents.tickets.filter((t) => t.photos).length;
  appendAll(panel,
    h('div', { class: 'row no-print' }, button('Print', () => window.print()), button('Ticket photos (zip)', async () => { try { await download(`/solid-waste/recycling-report/${year}/packet.zip`, `section-904-${year}.zip`); } catch (err) { fail(err); } }, { kind: 'primary' })),
    h('h2', null, `${p.town}: Section 904 recycling performance grant, ${year}`),
    h('p', null, `${tons(p.totals.total)} tons recycled (residue taken off), ${tons(p.trash_tons)} tons of trash; recycling rate ${p.recycling_rate === null ? 'not known' : `${p.recycling_rate}%`}.`),
    p.rows.length ? reportTable(p) : null,
    h('h3', null, 'Backing documents'),
    h('p', null, `${p.documents.tickets.length} weigh tickets (${withPhoto} with a photo, in the zip with their SHA-256), and ${p.documents.reports.length} hauler and business reports.`),
    p.documents.reports.length ? table([{ head: 'Report from', cell: (x) => x.reporter }, { head: 'Form', cell: (x) => x.form }, { head: 'Answered', cell: (x) => fmtInstant(x.answered_at) }, { head: 'Tons', num: true, cell: (x) => (x.none_to_report ? 'None' : tons(x.tons)) }], p.documents.reports) : null,
    p.documents.tickets.length ? table([{ head: 'Date', cell: (t) => fmtDate(t.on_date) }, { head: 'Ticket', cell: (t) => t.ticket_no || '' }, { head: 'Facility', cell: (t) => t.facility }, { head: 'Material', cell: (t) => t.material },
      { head: 'Net tons', num: true, cell: (t) => tons(t.net_tons) }, { head: 'Photo', cell: (t) => (t.photos ? 'Yes' : '') }], p.documents.tickets) : null);
}

function detailsPart(panel, r, year, redraw) {
  const county = input({ maxlength: 60, value: r.county, required: true });
  const due = input({ type: 'date', value: r.due_on, required: true }); const fol = input({ type: 'date', value: r.followup_on, required: true });
  const hh = input({ type: 'number', min: 0, value: r.households ?? '', placeholder: 'From the water customer list' }); const pop = input({ type: 'number', min: 0, value: r.population ?? '' });
  const notes = h('textarea', { rows: 3, maxlength: 4000 }, r.notes || '');
  appendAll(panel, h('div', { class: 'form' }, field('County', county), field('Due to the county', due), field('Follow-up day (last reminder)', fol), field('Households', hh), field('Population', pop), h('div', { class: 'wide' }, field('Notes', notes))),
    h('div', { class: 'row' },
      button('Save', async () => { try { await put(`/solid-waste/recycling-report/${year}`, { county: county.value.trim(), due_on: due.value, followup_on: fol.value, households: numOrNull(hh.value), population: numOrNull(pop.value), notes: notes.value.trim() || null }); toast('Saved'); await redraw(); } catch (err) { fail(err); } }, { kind: 'primary' }),
      r.status === 'open' ? button('Close the report', () => confirmDialog('Close the report?', 'Every reporter\'s link stops working. You can open the report again, and give out new links.', 'Close', async () => { await post(`/solid-waste/recycling-report/${year}/close`); toast('Closed'); await redraw(); })) : button('Open it again', async () => { try { await post(`/solid-waste/recycling-report/${year}/reopen`); toast('Open again'); await redraw(); } catch (err) { fail(err); } })));
}

// ================================================================ registration
registerTab({ id: 'carts', label: 'Carts', order: 65, show: () => office() || crewRole(), render: cartsTab });
registerTab({ id: 'tonnage', label: 'Tonnage', order: 70, show: () => office(), render: tonnageTab });
registerTab({ id: 'recycling', label: 'Recycling report', order: 75, show: () => isManager(), render: recyclingTab });

export { cartsTab, tonnageTab, recyclingTab };
