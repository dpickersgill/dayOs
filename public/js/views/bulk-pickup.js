// Bulk pickup (muni release 1, the Trash and recycling app). Residents book and pay online at /bulk-pickup/<slug>;
// here staff work with those bookings.
//   Collection day   the stop list for a day, in the route's driving order (or by street name), with counts by size. On a phone the crew taps
//                    Picked up, Not out or Not accepted (a photo is required for the last two). Print view for the office.
//   Route order      the order streets are driven on each collection weekday, and which way house numbers go (managers set it).
//   Bookings         search and filter; add a phone or walk-in booking; open one to take payment, cancel or decide a refund.
//   Settings         collection days, cutoff, stops a day, item sizes and prices, payment options, rules, holidays (managers).
//   Report           bookings, items, money and the not-out rate by month, and the spreadsheet (managers).
import { get, post, put, del, download, sendBytes, fetchBlob } from '../api.js';
import { routeTab } from './bulk-route.js';
import { h, clear, appendAll, ctx, money, state, button, field, input, select, toast, fail, formDialog, dialog, confirmDialog, empty, errorBox, loading, tabs, table, isManager, can, fmtDay, fmtDate, fmtDateTime, fmtInstant, hashParam, toCents, centsToInput, closeAllDialogs } from '../ui.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const office = () => can('counter');
const crewRole = () => isManager() || (ctx.me && ctx.me.role === 'staff');
const PAY = {
  card: 'Card', office: 'At the office', stickers: 'Stickers', credit: 'Credit', free: 'Free',
};
const PAY_STATE = { due: ['To pay', 'warn'], paid: ['Paid', 'good'], not_needed: ['Nothing to pay', 'neutral'], refund_due: ['Refund at the office', 'warn'], refunded: ['Refunded', 'neutral'] };
const OUTCOME = { picked_up: ['Picked up', 'good'], not_out: ['Not out', 'bad'], not_accepted: ['Not accepted', 'warn'] };
const clock = (t) => { const [hh, mm] = String(t || '').split(':').map(Number); return Number.isNaN(hh) ? '' : `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const itemsText = (b) => b.items.map((i) => `${i.quantity} ${i.name}`).join(', ');
const payState = (b) => (b.status === 'cancelled' || b.status === 'expired' ? state(b.status === 'expired' ? 'Not paid in time' : 'Canceled', 'neutral') : state(...(PAY_STATE[b.pay_status] || [b.pay_status, 'neutral'])));

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Bulk pickup'), h('p', { class: 'muted' }, 'Bulk trash pickups residents book online or by phone, and the crew’s stop list.')));
  const items = [['day', 'Collection day', dayTab], ['bookings', 'Bookings', bookingsTab], ['route', 'Route order', routeTab]]; // route: 2026.11.20 (bulk-route.js)
  if (isManager()) items.push(['settings', 'Settings', settingsTab], ['report', 'Report', reportTab]);
  root.append(tabs(items, hashParam('tab') || 'day'));
}

// ---------------------------------------------------------------- collection day
async function dayTab(panel) {
  let date = hashParam('date') || '';
  let mode = crewRole() && !office() ? 'phone' : (window.matchMedia && window.matchMedia('(max-width: 700px)').matches ? 'phone' : 'list');
  const body = h('div');
  panel.append(body);
  async function load() {
    clear(body).append(loading('Loading the stop list'));
    let d;
    try { d = await get(`/solid-waste/day${date ? `?date=${date}` : ''}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    date = d.date;
    const pick = select(d.days.map((x) => [x.date, `${fmtDay(x.date)}${x.skipped ? ' (no pickup)' : ` (${x.booked} stops)`}`]).concat(d.days.some((x) => x.date === d.date) ? [] : [[d.date, fmtDay(d.date)]]), d.date, { 'aria-label': 'Collection day' });
    pick.addEventListener('change', () => { date = pick.value; load(); });
    const other = input({ type: 'date', value: d.date, 'aria-label': 'Another day' });
    other.addEventListener('change', () => { if (other.value) { date = other.value; load(); } });
    const views = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
      ...[['phone', 'Phone view'], ['list', 'Print view']].map(([k, t]) => h('button', { type: 'button', 'aria-pressed': String(mode === k), onclick: () => { mode = k; load(); } }, t)));
    const o = d.outcomes;
    // appendAll leaves out the parts that do not apply (a plain append would write them as "null").
    appendAll(clear(body),
      h('div', { class: 'week-bar' },
        h('div', { class: 'row' }, pick, other),
        h('div', { class: 'week-actions' }, views, mode === 'list' ? button('Print', () => window.print()) : null)),
      d.skipped ? h('p', { class: 'set-note' }, `No pickup this day${d.skip_note ? `: ${d.skip_note}` : ''}.`) : null,
      // The stops follow the route order a manager set for this weekday (2026.11.20); a street not in it comes last.
      d.route && d.route.set && d.route.new_streets.length ? h('p', { class: 'set-note' }, `Not in the route order yet, so at the end: ${d.route.new_streets.join(', ')}.`, isManager() ? [' ', h('a', { href: `#/bulk?tab=route&weekday=${new Date(`${d.date}T12:00:00Z`).getUTCDay()}` }, 'Add to the route')] : null) : null,
      d.route && !d.route.set && d.stops.length && isManager() ? h('p', { class: 'muted small no-print' }, 'Stops are by street name. ', h('a', { href: `#/bulk?tab=route&weekday=${new Date(`${d.date}T12:00:00Z`).getUTCDay()}` }, 'Set the driving order')) : null,
      !d.collection_day && !d.stops.length ? h('p', { class: 'muted' }, `${fmtDay(d.date)} is not a collection day.`) : null,
      h('div', { class: 'figures' },
        figure(d.stops.length, `of ${d.capacity} stops`), figure(o.picked_up, 'picked up'), figure(o.not_out, 'not out'), figure(o.not_accepted, 'not accepted'), figure(o.left, 'to go')),
      d.sizes.length ? h('p', null, h('b', null, 'Items: '), d.sizes.map((s) => `${s.quantity} ${s.name}`).join(', ')) : null,
      d.stops.length ? (mode === 'phone' ? phoneList(d, load) : printList(d)) : empty('No stops booked for this day.'));
  }
  await load();
}
const figure = (n, words) => h('div', { class: 'figure' }, h('strong', null, String(n)), h('span', null, words));

function stopFlags(s) {
  return [s.pay_method === 'stickers' ? state('Check for stickers', 'warn') : null, s.pay_status === 'due' ? state(`Not paid: ${money(s.total_cents)}`, 'bad') : null].filter(Boolean);
}

function phoneList(d, reload) {
  return h('ol', { class: 'plain stack bulk-stops' }, d.stops.map((s) => h('li', { class: 'panel stack' },
    h('div', { class: 'spread' }, h('b', null, s.address), s.outcome ? state(...OUTCOME[s.outcome]) : null),
    h('p', null, itemsText(s), s.items_note ? h('span', { class: 'muted' }, ` (${s.items_note})`) : null),
    stopFlags(s).length ? h('p', { class: 'row' }, ...stopFlags(s)) : null,
    s.outcome_reason ? h('p', { class: 'muted small' }, s.outcome_reason) : null,
    crewRole() && d.date <= d.today ? h('div', { class: 'row' },
      button('Picked up', async () => { try { await post(`/solid-waste/bookings/${s.id}/outcome`, { outcome: 'picked_up' }); toast(`${s.address}: picked up`); await reload(); } catch (err) { fail(err); } }, { kind: s.outcome ? null : 'primary' }),
      button('Not out', () => outcomeDialog(s, 'not_out', reload)),
      button('Not accepted', () => outcomeDialog(s, 'not_accepted', reload))) : null)));
}

function printList(d) {
  return table([
    { head: '#', cell: (s) => String(d.stops.indexOf(s) + 1) },
    { head: 'Address', cell: (s) => s.address },
    { head: 'Items', cell: (s) => [itemsText(s), s.items_note ? h('div', { class: 'muted small' }, s.items_note) : null] },
    { head: 'Pay', cell: (s) => [PAY[s.pay_method], s.pay_status === 'due' ? ` (${money(s.total_cents)} due)` : ''].join('') },
    ...(office() ? [{ head: 'Resident', cell: (s) => [s.name || '', s.phone ? h('div', { class: 'muted small' }, s.phone) : null] }] : []),
    { head: 'Done', cell: (s) => (s.outcome ? OUTCOME[s.outcome][0] : '☐') },
  ], d.stops);
}

/** Not out or Not accepted: a photo of the curb is required, with the time and (when the phone allows) where it was taken. */
function outcomeDialog(s, outcome, reload) {
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', name: 'photo', required: true });
  const preview = h('img', { class: 'lf-preview', alt: '', hidden: true });
  file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) { preview.src = URL.createObjectURL(f); preview.hidden = false; } });
  const reason = input({ name: 'reason', maxlength: 200, required: outcome === 'not_accepted', placeholder: outcome === 'not_accepted' ? 'For example: paint cans, tires, a TV' : 'Optional' });
  let gps = null;
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { gps = { lat: p.coords.latitude, lng: p.coords.longitude }; }, () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  formDialog(outcome === 'not_out' ? `Not out: ${s.address}` : `Not accepted: ${s.address}`, h('div', { class: 'stack' },
    h('p', null, outcome === 'not_out' ? 'Take a photo of the curb showing nothing is out.' : 'Take a photo of what you are leaving.'),
    field('Photo', h('div', { class: 'stack tight' }, file, preview)),
    field(outcome === 'not_accepted' ? 'Why it was left' : 'Note', reason),
    h('p', { class: 'muted small' }, 'The resident is told by text or email only if they said yes. The photo stays here; it is never sent to them.')), async () => {
    const f = file.files && file.files[0];
    if (!f) throw new Error('Take a photo first');
    const q = new URLSearchParams({ client_ref: `bp${s.id}${Date.now().toString(36)}` });
    if (gps) { q.set('lat', gps.lat.toFixed(6)); q.set('lng', gps.lng.toFixed(6)); }
    const photo = await sendBytes('POST', `/solid-waste/bookings/${s.id}/photos?${q}`, f);
    const r = await post(`/solid-waste/bookings/${s.id}/outcome`, { outcome, photo_id: photo.id, reason: reason.value.trim() || undefined, ...(gps ? { lat: Number(gps.lat.toFixed(6)), lng: Number(gps.lng.toFixed(6)) } : {}) });
    toast(r.told.length ? `Saved. The resident was told by ${r.told.join(' and ')}.` : 'Saved. The resident did not ask to be told.');
    await reload();
  }, { submitText: outcome === 'not_out' ? 'Mark not out' : 'Mark not accepted' });
}

// ---------------------------------------------------------------- bookings
async function bookingsTab(panel) {
  let show = 'upcoming'; let q = '';
  const body = h('div');
  const search = input({ type: 'search', placeholder: office() ? 'Reference, name, phone or address' : 'Reference or address', 'aria-label': 'Search bookings' });
  const pick = select([['upcoming', 'Coming up'], ['unpaid', 'Not paid'], ['not_out', 'Not out or not accepted'], ['cancelled', 'Canceled'], ['all', 'Everything']], show, { 'aria-label': 'Show' });
  let timer = null;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(); }, 300); });
  pick.addEventListener('change', () => { show = pick.value; load(); });
  panel.append(h('div', { class: 'week-bar' }, h('div', { class: 'row' }, search, pick), h('div', { class: 'week-actions' }, office() ? button('Add booking', () => bookingDialog(load), { kind: 'primary' }) : null)), body);
  async function load() {
    clear(body).append(loading('Loading bookings'));
    let r;
    try { r = await get(`/solid-waste/bookings?show=${show}${q ? `&q=${encodeURIComponent(q)}` : ''}`); } catch (err) { clear(body).append(errorBox(err)); return; }
    clear(body).append(r.data.length ? table([
      { head: 'Day', cell: (b) => fmtDate(b.collection_date) },
      { head: 'Address', cell: (b) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); detailDialog(b.id, load); } }, b.address) },
      ...(office() ? [{ head: 'Resident', cell: (b) => b.name || '' }] : []),
      { head: 'Items', cell: (b) => itemsText(b) },
      { head: 'Payment', cell: (b) => [money(b.total_cents), ' ', PAY[b.pay_method], ' ', payState(b)] },
      { head: 'Crew', cell: (b) => (b.outcome ? state(...OUTCOME[b.outcome]) : '') },
      { head: 'Ref', cell: (b) => b.reference },
    ], r.data) : empty(q ? 'No booking matches that.' : 'No bookings here.'));
  }
  await load();
}

async function bookingDialog(onDone) {
  let o;
  try { o = await get('/solid-waste/options'); } catch (err) { fail(err); return; }
  const dayOpts = o.days.filter((d) => !d.skipped).map((d) => [d.date, `${fmtDay(d.date)}${d.closed ? ' (booking closed)' : d.left <= 0 ? ' (full)' : ` (${d.left} open)`}`]);
  const day = select(dayOpts, (o.days.find((d) => d.available) || {}).date, { name: 'collection_date', required: true });
  const override = h('input', { type: 'checkbox', name: 'override' });
  const qty = o.sizes.map((s) => ({ s, el: input({ type: 'number', min: 0, max: s.max_qty, value: 0, name: `size_${s.id}`, 'aria-label': `${s.name} quantity` }) }));
  const totalLine = h('p', { class: 'muted' });
  const sum = () => { const t = qty.reduce((n, x) => n + Number(x.el.value || 0) * x.s.price_cents, 0); totalLine.textContent = `Total: ${money(t)}`; return t; };
  qty.forEach((x) => x.el.addEventListener('input', sum)); sum();
  const payChoices = [['office_paid', `Paid at ${o.office_name} now`], ['office_due', `Will pay at ${o.office_name}`], ...(o.pay_stickers ? [['stickers', 'Has stickers']] : []),
    ...(o.card_ready ? [['link', 'Send a link to pay by card']] : []), ['credit', 'Use a credit from a not-out pickup']];
  const pay = select(payChoices, 'office_paid', { name: 'pay' });
  const linkBy = select([['text', 'By text'], ['email', 'By email']], 'text', { name: 'link_by' });
  const creditRef = input({ name: 'credit_ref', maxlength: 8, placeholder: 'Reference of the not-out booking' });
  const linkRow = field('Send the link', linkBy); const creditRow = field('Credit reference', creditRef);
  const syncPay = () => { linkRow.hidden = pay.value !== 'link'; creditRow.hidden = pay.value !== 'credit'; };
  pay.addEventListener('change', syncPay); syncPay();
  const texts = h('input', { type: 'checkbox', name: 'texts_ok' }); const emails = h('input', { type: 'checkbox', name: 'emails_ok' });
  formDialog('Add a bulk pickup', h('div', { class: 'form' },
    field('Collection day', day), h('label', { class: 'check' }, override, 'Book it even though booking has closed or the day is full'),
    field('Street', select([['', 'Choose a street'], ...o.streets.map((s) => [s.id, s.name])], '', { name: 'street_id', required: true })),
    field('House number', input({ name: 'house_number', maxlength: 20, required: true })), field('Apartment or unit', input({ name: 'unit', maxlength: 20 })),
    h('div', { class: 'wide stack tight' }, h('b', null, 'Items'), ...qty.map(({ s, el }) => field(`${s.name} (${s.price_cents ? money(s.price_cents) : 'free'}, up to ${s.max_qty})`, el)), totalLine),
    h('div', { class: 'wide' }, field('What is going out', input({ name: 'items_note', maxlength: 300, placeholder: 'Old couch, two chairs' }))),
    field('Resident’s name', input({ name: 'name', maxlength: 120, required: true })), field('Phone', input({ type: 'tel', name: 'phone', maxlength: 40 })), field('Email', input({ type: 'email', name: 'email', maxlength: 255 })),
    h('label', { class: 'check wide' }, texts, 'They agree to texts (a reminder, and word if the crew cannot take their items)'),
    h('label', { class: 'check wide' }, emails, 'They agree to emails (the same)'),
    field('Payment', pay), linkRow, creditRow), async (fd) => {
    const s = (k) => String(fd.get(k) || '').trim();
    const items = qty.filter((x) => Number(x.el.value) > 0).map((x) => ({ size_id: x.s.id, quantity: Number(x.el.value) }));
    if (!items.length) throw new Error('Add at least one item');
    const body = { collection_date: s('collection_date'), street_id: Number(s('street_id')), house_number: s('house_number'), unit: s('unit') || undefined, items, items_note: s('items_note') || undefined,
      name: s('name'), phone: s('phone') || undefined, email: s('email') || undefined, texts_ok: texts.checked, emails_ok: emails.checked, pay: pay.value, override: override.checked };
    if (pay.value === 'link') body.link_by = linkBy.value;
    if (pay.value === 'credit') body.credit_ref = s('credit_ref');
    const r = await post('/solid-waste/bookings', body);
    toast(`Booked: reference ${r.reference}${r.sent.length ? `. Sent by ${r.sent.join(' and ')}.` : ''}`);
    if (r.texts_off) toast(r.texts_off, 'error'); // the phone texted STOP: only a texted START turns texts back on
    await onDone();
    if (pay.value === 'link' && !r.sent.length) dialog('The link could not be sent', [h('p', null, 'Read this link to them, or try email:'), h('p', null, h('code', null, r.link))]);
  }, { submitText: 'Book pickup', wide: true });
}

async function detailDialog(id, onDone) {
  let b;
  try { b = await get(`/solid-waste/bookings/${id}`); } catch (err) { fail(err); return; }
  const live = b.status === 'booked' || b.status === 'awaiting_payment';
  const again = async () => { closeAllDialogs(); await onDone(); detailDialog(id, onDone); };
  const photos = h('div', { class: 'row' });
  for (const p of b.photos) {
    const img = h('img', { class: 'lf-photo', alt: `Crew photo, ${fmtDateTime(p.taken_at)}` });
    photos.append(h('figure', null, img, h('figcaption', { class: 'muted small' }, `${fmtDateTime(p.taken_at)}${p.taken_lat !== null ? `, at ${Number(p.taken_lat).toFixed(5)}, ${Number(p.taken_lng).toFixed(5)}` : ''}. SHA-256 ${p.sha256.slice(0, 12)}…`)));
    fetchBlob(`/solid-waste/bookings/${id}/photos/${p.id}`).then((blob) => { img.src = URL.createObjectURL(blob); }).catch(() => {});
  }
  const acts = [];
  if (office() && live && b.pay_status === 'due') acts.push(button('Mark paid at the office', () => confirmDialog('Paid at the office?', `${money(b.total_cents)} taken at the office for ${b.address}.`, 'Mark paid', async () => { await post(`/solid-waste/bookings/${id}/paid`); toast('Marked paid'); await again(); })));
  if (office() && live && b.pay_method === 'card' && b.pay_status === 'due') acts.push(button('Send the payment link', () => linkDialog(b, again)));
  if (office() && b.pay_status === 'refund_due') acts.push(button('Refund given', () => confirmDialog('Refund handed back?', `${money(b.paid_cents)} given back at the office.`, 'Refund given', async () => { await post(`/solid-waste/bookings/${id}/refund-given`); toast('Refund recorded'); await again(); })));
  if (office() && live && !b.outcome) acts.push(button('Cancel booking', () => cancelDialog(b, again)));
  if (isManager() && ['not_out', 'not_accepted'].includes(b.outcome) && !b.decision) acts.push(button('Refund or credit', () => decisionDialog(b, again), { kind: 'primary' }));
  dialog(`${b.address}: ${fmtDay(b.collection_date)}`, h('div', { class: 'stack' },
    h('p', null, h('b', null, `Reference ${b.reference}`), ' ', b.source === 'staff' ? '(booked by staff)' : '(booked online)'),
    h('p', null, itemsText(b), b.items_note ? h('span', { class: 'muted' }, ` (${b.items_note})`) : null),
    h('p', null, `${money(b.total_cents)}, ${PAY[b.pay_method]} `, payState(b), b.credit_from ? ` (credit from ${b.credit_from})` : ''),
    b.name !== undefined ? h('p', null, [b.name, b.phone, b.email].filter(Boolean).join(', '), h('br'), h('span', { class: 'muted small' }, `Texts: ${b.texts_ok ? 'yes' : 'no'}. Emails: ${b.emails_ok ? 'yes' : 'no'}.${b.reminded ? ' Reminder sent.' : ''}`)) : null,
    b.outcome ? h('p', null, state(...OUTCOME[b.outcome]), b.outcome_at ? ` ${fmtDateTime(b.outcome_at)}` : '', b.outcome_reason ? `: ${b.outcome_reason}` : '', b.notified_via ? h('span', { class: 'muted small' }, b.notified_via === 'none' ? ' Resident not told (they did not ask).' : ` Resident told by ${b.notified_via.replace(',', ' and ')}.`) : null) : null,
    b.decision ? h('p', null, `Decision: ${{ no_refund: 'no refund', refund: `refund ${money(b.decision_cents)}`, credit: `credit ${money(b.decision_cents)}${b.credit_used ? ' (used)' : ''}` }[b.decision]}${b.decision_note ? `. ${b.decision_note}` : ''}`) : null,
    b.cancel_reason ? h('p', { class: 'muted' }, b.cancel_reason) : null,
    b.message_note ? h('p', { class: 'warn-note' }, b.message_note) : null,
    b.photos.length ? photos : null,
    b.link ? h('p', { class: 'muted small' }, 'Resident’s link: ', h('code', null, b.link)) : null,
    h('p', { class: 'muted small' }, `Booked ${fmtInstant(b.created_at)}`),
    acts.length ? h('div', { class: 'row' }, ...acts) : null), { wide: true });
}

function linkDialog(b, done) {
  const by = select([['text', 'By text'], ['email', 'By email']], b.phone ? 'text' : 'email');
  formDialog('Send the payment link', field('How', by), async () => {
    const r = await post(`/solid-waste/bookings/${b.id}/send-link`, { by: by.value });
    toast(`Sent by ${r.sent.join(' and ')}`); await done();
  }, { submitText: 'Send' });
}

function cancelDialog(b, done) {
  const reason = input({ maxlength: 200, placeholder: 'For example: called to cancel' });
  const refund = h('input', { type: 'checkbox' });
  formDialog(`Cancel ${b.address}?`, h('div', { class: 'stack' },
    h('p', null, 'Before booking closes, a card payment goes back in full by itself, and money paid at the office is set aside to hand back. After it, only a manager can give money back.'),
    field('Why', reason),
    isManager() && b.pay_status === 'paid' ? h('label', { class: 'check' }, refund, 'Give the money back even if booking has closed') : null), async () => {
    const r = await post(`/solid-waste/bookings/${b.id}/cancel`, { reason: reason.value.trim() || undefined, ...(refund.checked ? { refund: true } : {}) });
    toast(r.pay_status === 'refunded' ? 'Canceled and refunded to the card' : r.pay_status === 'refund_due' ? 'Canceled. Hand the refund back at the office.' : 'Canceled');
    await done();
  }, { submitText: 'Cancel booking' });
}

async function decisionDialog(b, done) {
  let policy = 'no_refund';
  try { policy = (await get('/solid-waste/settings')).not_out_policy; } catch (_) { /* the usual choice stays "no refund" */ }
  const paid = b.pay_status === 'paid' && b.paid_cents > 0 && b.pay_method !== 'credit';
  const choice = select([['no_refund', 'No refund'], ...(paid ? [['refund', `Refund ${money(b.paid_cents)}${b.pay_method === 'card' ? ' to the card' : ' at the office'}`]] : []), ['credit', `Credit ${money(b.total_cents)} for another pickup`]], paid || policy !== 'refund' ? policy : 'credit');
  const note = input({ maxlength: 200 });
  formDialog(`${b.outcome === 'not_out' ? 'Not out' : 'Not accepted'}: ${b.address}`, h('div', { class: 'stack' }, field('Decision', choice), field('Note', note),
    h('p', { class: 'muted small' }, 'Decided once, and written to the audit trail. A credit is used by quoting this booking’s reference on a new booking.')), async () => {
    await post(`/solid-waste/bookings/${b.id}/decision`, { decision: choice.value, note: note.value.trim() || undefined });
    toast('Decision saved'); await done();
  }, { submitText: 'Save decision' });
}

// ---------------------------------------------------------------- settings
async function settingsTab(panel) {
  let s;
  try { s = await get('/solid-waste/settings'); } catch (err) { panel.append(errorBox(err)); return; }
  const online = h('input', { type: 'checkbox', checked: s.online });
  const days = DAYS.map((d, i) => ({ i, el: h('input', { type: 'checkbox', checked: s.collection_days.includes(i) }), d }));
  const before = select([1, 2, 3, 4, 5, 6, 7].map((n2) => [n2, `${n2} day${n2 === 1 ? '' : 's'} before`]), s.cutoff_days_before);
  const cutTime = input({ type: 'time', value: s.cutoff_time, required: true });
  const hint = h('span', { class: 'hint' });
  const syncHint = () => { const first = days.find((x) => x.el.checked); hint.textContent = first ? `For a ${first.d} pickup, booking closes ${DAYS[(first.i - Number(before.value) + 14) % 7]} at ${clock(cutTime.value)}.` : 'Pick a collection day.'; };
  [before, cutTime, ...days.map((x) => x.el)].forEach((el) => el.addEventListener('change', syncHint)); syncHint();
  const capacity = input({ type: 'number', min: 1, max: 2000, value: s.capacity, required: true });
  const curb = input({ type: 'time', value: s.curb_by, required: true });
  const card = h('input', { type: 'checkbox', checked: s.pay_card }); const stickers = h('input', { type: 'checkbox', checked: s.pay_stickers });
  const officeName = input({ value: s.office_name, maxlength: 80, required: true });
  const rules = h('textarea', { rows: 6, maxlength: 4000 }, s.rules_text || '');
  const policy = select([['no_refund', 'No refund'], ['credit', 'A credit for another pickup'], ['refund', 'A refund']], s.not_out_policy);
  const sizeRows = h('div', { class: 'stack' });
  const sizes = s.sizes.map((z) => ({ ...z }));
  const drawSizes = () => clear(sizeRows).append(...sizes.map((z, i) => {
    const name = input({ value: z.name, maxlength: 40, 'aria-label': 'Size name' }); name.addEventListener('input', () => { z.name = name.value; });
    const desc = input({ value: z.description || '', maxlength: 255, 'aria-label': 'Examples' }); desc.addEventListener('input', () => { z.description = desc.value; });
    const price = input({ type: 'number', min: 0, step: '0.01', value: centsToInput(z.price_cents), 'aria-label': 'Price' }); price.addEventListener('input', () => { z.price_cents = toCents(price.value) ?? 0; });
    const max = input({ type: 'number', min: 1, max: 20, value: z.max_qty, 'aria-label': 'Most per pickup' }); max.addEventListener('input', () => { z.max_qty = Number(max.value) || 1; });
    const on = h('input', { type: 'checkbox', checked: z.active }); on.addEventListener('change', () => { z.active = on.checked; });
    return h('div', { class: 'panel form' }, field('Size', name), field('Price ($, 0 for free)', price), field('Most per pickup', max), h('div', { class: 'wide' }, field('What counts (examples residents see)', desc)),
      h('label', { class: 'check' }, on, 'Offered'), !z.id ? button('Remove', () => { sizes.splice(i, 1); drawSizes(); }, { small: true }) : null);
  }));
  drawSizes();
  const msg = h('div');
  const save = button('Save settings', async () => {
    clear(msg);
    try {
      s = await put('/solid-waste/settings', { online: online.checked, collection_days: days.filter((x) => x.el.checked).map((x) => x.i), cutoff_days_before: Number(before.value), cutoff_time: cutTime.value,
        capacity: Number(capacity.value), curb_by: curb.value, pay_card: card.checked, pay_stickers: stickers.checked, office_name: officeName.value.trim(), rules_text: rules.value.trim() || null, not_out_policy: policy.value,
        sizes: sizes.map((z) => ({ ...(z.id ? { id: z.id } : {}), name: String(z.name || '').trim(), description: String(z.description || '').trim() || null, price_cents: Number(z.price_cents) || 0, max_qty: Number(z.max_qty) || 1, active: z.active !== false })) });
      toast('Settings saved');
      sizes.splice(0, sizes.length, ...s.sizes.map((z) => ({ ...z }))); drawSizes();
    } catch (err) { msg.append(errorBox(err)); }
  }, { kind: 'primary' });
  const skipList = h('div');
  const drawSkips = () => clear(skipList).append(s.skip_dates.length ? h('ul', { class: 'plain stack' }, s.skip_dates.map((d) => h('li', { class: 'spread' }, h('span', null, fmtDay(d.on_date), d.note ? ` (${d.note})` : ''),
    button('Remove', async () => { try { await del(`/solid-waste/skip-dates/${d.id}`); s.skip_dates = s.skip_dates.filter((x) => x.id !== d.id); drawSkips(); } catch (err) { fail(err); } }, { small: true })))) : h('p', { class: 'muted' }, 'No days off coming up.'));
  drawSkips();
  const skipDate = input({ type: 'date' }); const skipNote = input({ maxlength: 120, placeholder: 'For example: Memorial Day' });
  panel.append(
    h('section', { class: 'panel stack' }, h('h2', null, 'The page residents use'),
      h('p', null, h('a', { href: s.page, target: '_blank', rel: 'noopener' }, s.page), ' ', button('Copy link', async () => { try { await navigator.clipboard.writeText(s.page); toast('Link copied'); } catch (err) { fail(err); } }, { small: true })),
      h('p', { class: 'muted small' }, 'Link it from your website’s trash page. It works on a phone.'),
      h('label', { class: 'check' }, online, 'Residents can book online (off: the page asks them to call)'),
      h('p', null, s.card_ready ? state('Card payments go to your Stripe account', 'good') : state('Card payments are not set up', 'warn'), ' ', s.card_ready ? '' : h('a', { href: '#/settings/payments' }, 'Connect Stripe under Settings, Payments'), s.card_ready ? '' : '. Until then, a resident who picks card pays at the office.')),
    h('section', { class: 'panel stack' }, h('h2', null, 'Collection days and booking'),
      h('fieldset', { class: 'row' }, h('legend', null, 'Collection days'), ...days.map((x) => h('label', { class: 'check' }, x.el, x.d))),
      h('div', { class: 'form' }, field('Booking closes', before), field('At', cutTime), h('div', { class: 'wide' }, hint), field('Stops a day', capacity), field('Items at the curb by', curb))),
    h('section', { class: 'panel stack' }, h('h2', null, 'Item sizes and prices'), sizeRows,
      button('Add a size', () => { sizes.push({ name: '', description: '', price_cents: 0, max_qty: 3, active: true }); drawSizes(); }, { small: true })),
    h('section', { class: 'panel stack' }, h('h2', null, 'Paying'),
      h('label', { class: 'check' }, card, 'Pay online by card'), h('label', { class: 'check' }, stickers, 'I have stickers (no payment; the crew checks for them)'),
      field('Where residents pay in person', officeName), field('Not out: what a resident gets, unless a manager decides otherwise', policy)),
    h('section', { class: 'panel stack' }, h('h2', null, 'Rules shown to residents'), field('One rule a line: what you take, what you do not, where to put items, by what time', rules)),
    msg, h('div', { class: 'row' }, save),
    h('section', { class: 'panel stack' }, h('h2', null, 'Days with no pickup'), h('p', { class: 'muted small' }, 'Holidays and other days off. Residents see the note and book another day.'), skipList,
      h('div', { class: 'row' }, skipDate, skipNote, button('Add day off', async () => {
        if (!skipDate.value) { toast('Pick a date', 'error'); return; }
        try {
          const r = await post('/solid-waste/skip-dates', { on_date: skipDate.value, note: skipNote.value.trim() || undefined });
          s.skip_dates = [...s.skip_dates.filter((x) => x.on_date !== skipDate.value), { id: r.id, on_date: skipDate.value, note: skipNote.value.trim() || null }].sort((a, c) => a.on_date.localeCompare(c.on_date));
          drawSkips();
          toast(r.booked_that_day ? `Added. ${r.booked_that_day} stop${r.booked_that_day === 1 ? ' is' : 's are'} already booked that day: call them, or move them in Bookings.` : 'Added');
          skipDate.value = ''; skipNote.value = '';
        } catch (err) { fail(err); }
      }))));
}

// ---------------------------------------------------------------- report
async function reportTab(panel) {
  let r;
  try { r = await get('/solid-waste/report?months=12'); } catch (err) { panel.append(errorBox(err)); return; }
  const from = input({ type: 'date', 'aria-label': 'From' }); const to = input({ type: 'date', 'aria-label': 'To' });
  const range = () => `${from.value ? `from=${from.value}&` : ''}${to.value ? `to=${to.value}&` : ''}`;
  const month = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  panel.append(
    r.months.length ? table([
      { head: 'Month', cell: (m) => month(m.month) },
      { head: 'Bookings', num: true, cell: (m) => `${m.bookings}${m.online ? ` (${m.online} online)` : ''}` },
      { head: 'Items', num: true, cell: (m) => String(m.items) },
      { head: 'Card', num: true, cell: (m) => money(m.card_cents) },
      { head: 'At the office', num: true, cell: (m) => money(m.office_cents) },
      { head: 'Refunded', num: true, cell: (m) => money(m.refunded_cents) },
      { head: 'Revenue', num: true, cell: (m) => h('b', null, money(m.revenue_cents)) },
      { head: 'Stickers', num: true, cell: (m) => String(m.stickers) },
      { head: 'Not out', num: true, cell: (m) => `${m.not_out}${m.not_out_rate !== null ? ` (${m.not_out_rate}%)` : ''}` },
      { head: 'Canceled', num: true, cell: (m) => String(m.cancelled) },
    ], r.months) : empty('No bookings yet.'),
    h('p', { class: 'muted small' }, 'By collection day. Not out rate: stops marked Not out out of every stop the crew marked. Revenue is card and office payments less refunds; stickers are sold separately.'),
    h('section', { class: 'panel stack' }, h('h2', null, 'Download bookings'),
      h('p', { class: 'muted small' }, 'Bookings are public records. The usual download leaves out residents’ names, phones, emails and house numbers. Adding them is for managers, and is written to the audit trail.'),
      h('div', { class: 'row' }, field('From', from), field('To', to)),
      h('div', { class: 'row' },
        button('Download', async () => { try { await download(`/solid-waste/export?${range()}`, 'bulk-pickups.csv'); } catch (err) { fail(err); } }, { kind: 'primary' }),
        button('Download with contact details', () => confirmDialog('Include contact details?', 'The file will have residents’ names, phones, emails and house numbers. Keep it private: do not use it to answer a public records request.', 'Download', async () => { await download(`/solid-waste/export?${range()}contacts=1`, 'bulk-pickups-with-contacts.csv'); })))));
}
