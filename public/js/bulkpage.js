// A municipality's bulk trash pickup page (/public/<municipality>/bulk-pickup), linked from its website. Phone first:
// one step at a time (address, day, items, contact, pay), a running total, then a reference and a link to view or cancel.
// With ?booking=<token> it shows that one booking. It never shows anyone else's booking or address.
import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('bulk');
const api = `/api/v1/public/${encodeURIComponent(slug)}/bulk-pickup`;
const params = new URLSearchParams(location.search);
const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const clock = (t) => { const [hh, mm] = String(t || '').split(':').map(Number); return Number.isNaN(hh) ? '' : `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or call the office.'); e.status = res.status; throw e; }
  return data;
}
const post = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const errorLine = (text) => h('p', { class: 'error-box', role: 'alert' }, text);
const rulesBlock = (rules) => (rules ? h('details', { class: 'bulk-rules' }, h('summary', null, 'What we take, and what we do not'), h('ul', null, String(rules).split('\n').filter((l) => l.trim()).map((l) => h('li', null, l)))) : null);

async function main() {
  document.getElementById('bulk-loading')?.remove();
  if (params.get('booking')) return showBooking(params.get('booking'));
  let page;
  try { page = await getJson(api); } catch (_) {
    root.append(h('h1', null, 'Bulk pickup booking is not available'), h('p', { class: 'muted' }, 'Please call your municipal office to book a bulk pickup.'));
    return null;
  }
  document.title = `${page.town}: book a bulk pickup`;
  if (!page.open) {
    root.append(h('h1', null, `${page.town}: bulk pickup`), h('p', null, page.message), rulesBlock(page.rules));
    return null;
  }
  return wizard(page);
}

function wizard(page) {
  const want = new Map(); // size id -> quantity
  const total = () => page.sizes.reduce((n, s) => n + (want.get(s.id) || 0) * s.price_cents, 0);
  const count = () => [...want.values()].reduce((n, q) => n + q, 0);
  // Step 1: address
  const street = h('select', { id: 'b-street', required: '' }, h('option', { value: '' }, 'Choose your street'), page.streets.map((s) => h('option', { value: s.id }, s.name)));
  const house = h('input', { id: 'b-house', inputmode: 'numeric', autocomplete: 'off', maxlength: 20, placeholder: 'For example 120' });
  const unit = h('input', { id: 'b-unit', maxlength: 20, placeholder: 'Apartment or unit, if any' });
  // Step 2: day
  const open = page.days.filter((d) => d.available);
  let day = open[0] ? open[0].date : null;
  const dayList = h('div', { class: 'bulk-days', role: 'radiogroup', 'aria-label': 'Collection day' }, page.days.map((d) => {
    const input = h('input', { type: 'radio', name: 'day', value: d.date, disabled: !d.available, checked: d.date === day });
    input.addEventListener('change', () => { day = d.date; });
    return h('label', { class: `bulk-day${d.available ? '' : ' off'}` }, input, h('span', null, h('b', null, d.label), h('small', null, d.available ? `Book by ${d.cutoff_words}` : d.reason)));
  }));
  // Step 3: items
  const totalLine = h('p', { class: 'bulk-total', 'aria-live': 'polite' });
  const items = h('div', { class: 'bulk-sizes' }, page.sizes.map((s) => {
    const qty = h('output', { class: 'bulk-qty', 'aria-label': `${s.name} quantity` }, '0');
    const step = (by) => { const v = Math.max(0, Math.min(s.max_qty, (want.get(s.id) || 0) + by)); want.set(s.id, v); qty.textContent = String(v); drawTotal(); };
    return h('div', { class: 'bulk-size' },
      h('div', null, h('b', null, `${s.name} `), h('span', { class: 'bulk-price' }, s.price_cents ? money(s.price_cents) : 'Free'), s.description ? h('p', { class: 'muted small' }, s.description) : null,
        h('p', { class: 'muted small' }, `Up to ${s.max_qty}`)),
      h('div', { class: 'bulk-stepper' },
        h('button', { type: 'button', class: 'btn', 'aria-label': `One less ${s.name}`, onclick: () => step(-1) }, '−'), qty,
        h('button', { type: 'button', class: 'btn', 'aria-label': `One more ${s.name}`, onclick: () => step(1) }, '+')));
  }));
  const note = h('textarea', { id: 'b-note', rows: 2, maxlength: 300, placeholder: 'What is going out, like: old couch, two chairs, a bike' });
  // Step 4: contact
  const name = h('input', { id: 'b-name', maxlength: 120, autocomplete: 'name' });
  const phone = h('input', { id: 'b-phone', type: 'tel', maxlength: 40, autocomplete: 'tel' });
  const email = h('input', { id: 'b-email', type: 'email', maxlength: 255, autocomplete: 'email' });
  const textsOk = h('input', { type: 'checkbox', id: 'b-texts' });
  const emailsOk = h('input', { type: 'checkbox', id: 'b-emails' });
  // Step 5: pay
  let pay = page.pay.card ? 'card' : page.pay.office ? 'office' : 'stickers';
  const payChoice = (value, title, words) => {
    const input = h('input', { type: 'radio', name: 'pay', value, checked: pay === value });
    input.addEventListener('change', () => { pay = value; drawPay(); });
    return h('label', { class: 'bulk-day' }, input, h('span', null, h('b', null, title), h('small', null, words)));
  };
  const payBox = h('div');
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'button', class: 'btn primary big' }, 'Book pickup');

  function drawTotal() {
    const n = count();
    totalLine.textContent = n ? `${n} item${n === 1 ? '' : 's'}: ${total() ? money(total()) : 'free'}` : 'No items yet';
  }
  function drawPay() {
    const t = total();
    clear(payBox).append(t === 0
      ? h('p', null, 'Nothing to pay: metal items are free. They still need a booking.')
      : h('div', { class: 'bulk-days', role: 'radiogroup', 'aria-label': 'How you pay' },
        page.pay.card ? payChoice('card', `Pay ${money(t)} by card now`, 'On the next page. You can cancel for a full refund until booking closes.') : null,
        page.pay.office ? payChoice('office', `Pay ${money(t)} at ${page.office_name}`, page.card_message || `Pay before collection day.`) : null,
        page.pay.stickers ? payChoice('stickers', 'I have stickers', `Put one bulk pickup sticker on each item. Stickers are sold at ${page.office_name}.`) : null));
    send.textContent = t > 0 && pay === 'card' ? `Book and pay ${money(t)}` : 'Book pickup';
  }

  const steps = [
    { title: 'Where is the pickup?', body: [lab('b-street', 'Street', street), lab('b-house', 'House number', house), lab('b-unit', 'Apartment or unit', unit)],
      check: () => (!street.value ? ['Choose your street.', street] : !house.value.trim() ? ['Give your house number.', house] : null) },
    { title: 'Which collection day?', body: [open.length ? dayList : h('p', null, `No collection day has room right now. Please call ${page.office_name}${page.phone ? ` at ${page.phone}` : ''}.`),
      h('p', { class: 'muted small' }, `Put items at the curb by ${clock(page.curb_by)} on collection day.`)],
    check: () => (!day ? ['Pick a collection day.', null] : null) },
    { title: 'What is going out?', body: [items, totalLine, lab('b-note', 'Anything the crew should know', note), rulesBlock(page.rules)],
      check: () => (!count() ? ['Add at least one item.', null] : null) },
    { title: 'How can we reach you?', body: [lab('b-name', 'Your name', name), lab('b-phone', 'Cell phone', phone), lab('b-email', 'Email', email, 'A phone number or an email, so we can reach you about the pickup'),
      h('label', { class: 'check' }, textsOk, 'Text me a reminder the day before, and if the crew could not take my items'),
      h('label', { class: 'check' }, emailsOk, 'Email me a reminder the day before, and if the crew could not take my items'),
      h('p', { class: 'muted small' }, 'Reply STOP to any text to stop texts. We use your details only for this pickup.')],
    check: () => {
      if (name.value.trim().length < 2) return ['Give your name.', name];
      if (!phone.value.trim() && !email.value.trim()) return ['Give a phone number or an email address.', phone];
      if (textsOk.checked && !phone.value.trim()) return ['Give a phone number to get texts.', phone];
      if (emailsOk.checked && !email.value.trim()) return ['Give an email address to get emails.', email];
      return null;
    } },
    { title: 'Pay and book', body: [payBox, h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), send] },
  ];
  let at = 0;
  const head = h('div', { class: 'bulk-head' }, h('h1', null, `${page.town}: book a bulk pickup`));
  const progress = h('p', { class: 'muted small bulk-progress' });
  const holder = h('section', { class: 'bulk-step', 'aria-live': 'polite' });
  const back = h('button', { type: 'button', class: 'btn' }, 'Back');
  const next = h('button', { type: 'button', class: 'btn primary big' }, 'Next');
  const nav = h('div', { class: 'bulk-nav' }, back, next);
  function show(i) {
    at = i; clear(msg);
    const s = steps[i];
    progress.textContent = `Step ${i + 1} of ${steps.length}`;
    clear(holder).append(h('h2', null, s.title), ...s.body.filter(Boolean), msg);
    back.hidden = i === 0; next.hidden = i === steps.length - 1;
    if (i === steps.length - 1) drawPay();
    const first = holder.querySelector('select, input:not([type=radio]):not([type=checkbox]), button');
    if (first && i > 0) first.focus();
  }
  back.addEventListener('click', () => show(Math.max(0, at - 1)));
  next.addEventListener('click', () => {
    const bad = steps[at].check && steps[at].check();
    if (bad) { clear(msg).append(errorLine(bad[0])); if (bad[1]) bad[1].focus(); return; }
    show(at + 1);
  });
  send.addEventListener('click', async () => {
    clear(msg);
    send.disabled = true;
    try {
      const body = {
        collection_date: day, street_id: Number(street.value), house_number: house.value.trim(), unit: unit.value.trim() || undefined,
        items: [...want].filter(([, q]) => q > 0).map(([id, q]) => ({ size_id: id, quantity: q })), items_note: note.value.trim() || undefined,
        name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined, texts_ok: textsOk.checked, emails_ok: emailsOk.checked,
        pay: total() === 0 ? 'stickers' : pay, website: trap.value || undefined,
      };
      const r = await post(`${api}/bookings`, body);
      if (r.checkout_url) { location.href = r.checkout_url; return; }
      history.replaceState(null, '', `${location.pathname}?booking=${r.token}`);
      await showBooking(r.token, { just: true });
    } catch (ex) {
      send.disabled = false;
      msg.append(errorLine(ex.message));
    }
  });
  drawTotal();
  root.append(head, progress, holder, nav);
  show(0);
}

/** One booking, by its secret link: the details, and Cancel or Pay while they still can. */
async function showBooking(token, { just = false } = {}) {
  let v;
  const load = async () => { v = await getJson(`${api}/bookings/${encodeURIComponent(token)}`); };
  try { await load(); } catch (_) {
    clear(root).append(h('h1', null, 'Booking not found'), h('p', { class: 'muted' }, 'Check the link, or call your municipal office.'));
    return;
  }
  // Back from the card page: the payment can take a few seconds to reach us.
  for (let i = 0; i < 6 && params.get('paid') && v.pay_status === 'due'; i += 1) { await new Promise((r) => { setTimeout(r, 1500); }); await load(); }
  document.title = `${v.town}: bulk pickup ${v.reference}`;
  const msg = h('div', { role: 'status' });
  const draw = () => {
    const canceled = v.status === 'cancelled' || v.status === 'expired';
    const payWords = {
      paid: `Paid ${money(v.paid_cents)}.`, not_needed: v.pay_method === 'stickers' ? 'Put one bulk pickup sticker on each item.' : 'Nothing to pay.',
      due: v.pay_method === 'card' ? `${money(v.total_cents)} still to pay by card.` : `Please pay ${money(v.total_cents)} at ${v.office_name} before collection day.`,
      refund_due: `Your refund of ${money(v.paid_cents)} is waiting at ${v.office_name}.`, refunded: `${money(v.refunded_cents)} refunded.`,
    }[v.pay_status] || '';
    const title = canceled ? 'Pickup canceled' : v.status === 'awaiting_payment' ? 'Almost done: pay to book' : just || params.get('paid') ? 'Pickup booked' : 'Your bulk pickup';
    clear(root).append(h('div', { class: 'help-done stack' },
      h('h1', null, title),
      h('p', { class: 'bulk-ref' }, 'Reference ', h('b', null, v.reference)),
      h('dl', { class: 'bulk-facts' },
        h('dt', null, 'Collection day'), h('dd', null, v.day_label),
        h('dt', null, 'Address'), h('dd', null, v.address),
        h('dt', null, 'Items'), h('dd', null, v.items.map((i) => `${i.quantity} ${i.name}`).join(', '), v.items_note ? h('span', { class: 'muted small' }, ` (${v.items_note})`) : null),
        h('dt', null, 'Payment'), h('dd', null, payWords)),
      v.outcome === 'not_out' ? h('p', null, 'The crew came by and nothing was out at the curb.') : null,
      v.outcome === 'not_accepted' ? h('p', null, `The crew could not take some items: ${v.outcome_reason || 'not accepted for bulk pickup'}.`) : null,
      v.outcome === 'picked_up' ? h('p', null, 'Picked up. Thank you.') : null,
      !canceled && !v.outcome ? h('p', null, `Put items at the curb by ${clock(v.curb_by)} on ${v.day_label}.`) : null,
      !canceled && !v.outcome ? h('p', { class: 'muted small' }, v.can_cancel ? `You can cancel until ${v.cutoff_words}${v.pay_status === 'paid' && v.pay_method === 'card' ? ', with a full refund to your card' : ''}.` : `Changes closed ${v.cutoff_words}. To change anything, call ${v.office_name}${v.phone ? ` at ${v.phone}` : ''}.`) : null,
      v.texts_off && !canceled && !v.outcome ? h('p', { role: 'status' }, h('strong', null, v.texts_off)) : null,
      h('p', { class: 'muted small' }, 'Keep this page’s link to come back to your booking.'),
      v.can_pay ? h('button', { type: 'button', class: 'btn primary big', onclick: payNow }, `Pay ${money(v.total_cents)} by card`) : null,
      v.can_cancel ? h('button', { type: 'button', class: 'btn big', onclick: cancelNow }, 'Cancel pickup') : null,
      msg, rulesBlock(v.rules)));
  };
  async function payNow(e) {
    e.target.disabled = true; clear(msg);
    try { location.href = (await post(`${api}/bookings/${encodeURIComponent(token)}/pay`)).checkout_url; } catch (ex) { e.target.disabled = false; msg.append(errorLine(ex.message)); }
  }
  async function cancelNow(e) {
    if (!window.confirm('Cancel this bulk pickup?')) return;
    e.target.disabled = true; clear(msg);
    try { v = await post(`${api}/bookings/${encodeURIComponent(token)}/cancel`); draw(); } catch (ex) { e.target.disabled = false; msg.append(errorLine(ex.message)); }
  }
  draw();
}

main();
