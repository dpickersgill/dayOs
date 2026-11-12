// A municipality's cart request page (/cart-request/<municipality>, release 2026.11.22), linked from its website. Phone
// first, one step at a time: what you need, where, how to reach you, then the fee (paid by card on the municipality's own
// Stripe account, or at the office) and a reference with a link to come back. With ?request=<token> it shows that one
// request. It never shows anyone else's request, or what carts an address has.
import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('cart');
const api = `/api/v1/public/${encodeURIComponent(slug)}/cart-request`;
const params = new URLSearchParams(location.search);
const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const KINDS = {
  new: ['A cart for a new home', 'The first trash or recycling cart at this address. Free.'],
  extra: ['An extra cart', 'One more cart for this stream.'],
  replacement: ['A replacement', 'The cart is broken or worn out.'],
  stolen: ['My cart was stolen', 'Free. Give the police report number if you have one.'],
};

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or call the office.'); e.status = res.status; throw e; }
  return data;
}
const post = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const errorLine = (text) => h('p', { class: 'error-box', role: 'alert' }, text);
const rulesBlock = (rules) => (rules ? h('details', { class: 'bulk-rules' }, h('summary', null, 'About carts'), h('ul', null, String(rules).split('\n').filter((l) => l.trim()).map((l) => h('li', null, l)))) : null);

async function main() {
  document.getElementById('cart-loading')?.remove();
  if (params.get('request')) return showRequest(params.get('request'));
  let page;
  try { page = await getJson(api); } catch (_) {
    root.append(h('h1', null, 'Cart requests are not available'), h('p', { class: 'muted' }, 'Please call your municipal office to ask for a cart.'));
    return null;
  }
  document.title = `${page.town}: ask for a cart`;
  if (!page.open) {
    root.append(h('h1', null, `${page.town}: trash and recycling carts`), h('p', null, page.message), rulesBlock(page.rules));
    return null;
  }
  return wizard(page);
}

function wizard(page) {
  let kind = 'new';
  let streamId = page.streams[0].id;
  let size = page.streams[0].sizes[0].size_gal;
  const feeOf = () => {
    const st = page.streams.find((x) => x.id === streamId); const z = st && st.sizes.find((x) => x.size_gal === size);
    if (!z) return 0;
    return kind === 'extra' ? z.extra_fee_cents : kind === 'replacement' ? z.replacement_fee_cents : 0;
  };
  // Step 1: what
  const kinds = h('div', { class: 'bulk-days', role: 'radiogroup', 'aria-label': 'What you need' }, Object.entries(KINDS).map(([k, [title, words]]) => {
    const input = h('input', { type: 'radio', name: 'kind', value: k, checked: k === kind });
    input.addEventListener('change', () => { kind = k; drawFee(); police.closest('.field').hidden = kind !== 'stolen'; });
    return h('label', { class: 'bulk-day' }, input, h('span', null, h('b', null, title), h('small', null, words)));
  }));
  const streamSel = h('select', { id: 'c-stream' }, page.streams.map((x) => h('option', { value: x.id }, x.name)));
  const sizeSel = h('select', { id: 'c-size' });
  const fillSizes = () => {
    const st = page.streams.find((x) => x.id === streamId);
    clear(sizeSel).append(...st.sizes.map((z) => h('option', { value: z.size_gal, selected: z.size_gal === size }, `${z.size_gal} gallons`)));
    if (!st.sizes.some((z) => z.size_gal === size)) size = st.sizes[0].size_gal;
  };
  streamSel.addEventListener('change', () => { streamId = Number(streamSel.value); fillSizes(); drawFee(); });
  sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); drawFee(); });
  const feeLine = h('p', { class: 'bulk-total', 'aria-live': 'polite' });
  const police = h('input', { id: 'c-police', maxlength: 40, autocomplete: 'off' });
  // Step 2: where
  const street = h('select', { id: 'c-street', required: '' }, h('option', { value: '' }, 'Choose your street'), page.streets.map((x) => h('option', { value: x.id }, x.name)));
  const house = h('input', { id: 'c-house', inputmode: 'numeric', autocomplete: 'off', maxlength: 20, placeholder: 'For example 120' });
  const unit = h('input', { id: 'c-unit', maxlength: 20, placeholder: 'Apartment or unit, if any' });
  const note = h('textarea', { id: 'c-note', rows: 2, maxlength: 300, placeholder: 'For example: leave it by the side gate' });
  // Step 3: contact
  const name = h('input', { id: 'c-name', maxlength: 120, autocomplete: 'name' });
  const phone = h('input', { id: 'c-phone', type: 'tel', maxlength: 40, autocomplete: 'tel' });
  const email = h('input', { id: 'c-email', type: 'email', maxlength: 255, autocomplete: 'email' });
  const textsOk = h('input', { type: 'checkbox', id: 'c-texts' });
  const emailsOk = h('input', { type: 'checkbox', id: 'c-emails' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'button', class: 'btn primary big' }, 'Send request');
  const payWords = h('div');

  function drawFee() {
    const fee = feeOf();
    feeLine.textContent = fee ? `Fee: ${money(fee)}` : 'No fee';
    clear(payWords).append(fee
      ? h('p', null, page.card ? `The fee is ${money(fee)}, paid by card on the next page. If you cancel before the delivery day is set, it goes back to your card in full.` : `The fee is ${money(fee)}. ${page.card_message || `Pay it at ${page.office_name}.`}`)
      : h('p', null, 'Nothing to pay.'));
    send.textContent = fee && page.card ? `Send and pay ${money(fee)}` : 'Send request';
  }

  const steps = [
    { title: 'What do you need?', body: [kinds, lab('c-stream', 'Cart for', streamSel), lab('c-size', 'Size', sizeSel), feeLine, lab('c-police', 'Police report number', police, 'Not required'), rulesBlock(page.rules)] },
    { title: 'Where should it go?', body: [lab('c-street', 'Street', street), lab('c-house', 'House number', house), lab('c-unit', 'Apartment or unit', unit), lab('c-note', 'Anything the crew should know', note)],
      check: () => (!street.value ? ['Choose your street.', street] : !house.value.trim() ? ['Give your house number.', house] : null) },
    { title: 'How can we reach you?', body: [lab('c-name', 'Your name', name), lab('c-phone', 'Cell phone', phone), lab('c-email', 'Email', email, 'A phone number or an email, so we can tell you when the cart is coming'),
      h('label', { class: 'check' }, textsOk, 'Text me the delivery day'), h('label', { class: 'check' }, emailsOk, 'Email me the delivery day'),
      h('p', { class: 'muted small' }, 'Reply STOP to any text to stop texts. We use your details only for this cart.')],
    check: () => {
      if (name.value.trim().length < 2) return ['Give your name.', name];
      if (!phone.value.trim() && !email.value.trim()) return ['Give a phone number or an email address.', phone];
      if (textsOk.checked && !phone.value.trim()) return ['Give a phone number to get texts.', phone];
      if (emailsOk.checked && !email.value.trim()) return ['Give an email address to get emails.', email];
      return null;
    } },
    { title: 'Send', body: [payWords, h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), send] },
  ];
  let at = 0;
  const head = h('div', { class: 'bulk-head' }, h('h1', null, `${page.town}: ask for a cart`));
  const progress = h('p', { class: 'muted small bulk-progress' });
  const holder = h('section', { class: 'bulk-step', 'aria-live': 'polite' });
  const back = h('button', { type: 'button', class: 'btn' }, 'Back');
  const next = h('button', { type: 'button', class: 'btn primary big' }, 'Next');
  function show(i) {
    at = i; clear(msg);
    const s = steps[i];
    progress.textContent = `Step ${i + 1} of ${steps.length}`;
    clear(holder).append(h('h2', null, s.title), ...s.body.filter(Boolean), msg);
    police.closest('.field') && (police.closest('.field').hidden = kind !== 'stolen');
    back.hidden = i === 0; next.hidden = i === steps.length - 1;
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
    clear(msg); send.disabled = true;
    try {
      const r = await post(api, {
        kind, stream_id: streamId, size_gal: size, street_id: Number(street.value), house_number: house.value.trim(), unit: unit.value.trim() || undefined, note: note.value.trim() || undefined,
        police_report: kind === 'stolen' ? police.value.trim() || undefined : undefined,
        name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined, texts_ok: textsOk.checked, emails_ok: emailsOk.checked, website: trap.value || undefined,
      });
      if (r.checkout_url) { location.href = r.checkout_url; return; }
      history.replaceState(null, '', `${location.pathname}?request=${r.token}`);
      await showRequest(r.token, { just: true });
    } catch (ex) { send.disabled = false; msg.append(errorLine(ex.message)); }
  });
  fillSizes(); drawFee();
  root.append(head, progress, holder, h('div', { class: 'bulk-nav' }, back, next));
  show(0);
}

/** One request, by its secret link: what was asked, its state, and Cancel or Pay while they still can. */
async function showRequest(token, { just = false } = {}) {
  let v;
  const load = async () => { v = await getJson(`${api}/${encodeURIComponent(token)}`); };
  try { await load(); } catch (_) {
    clear(root).append(h('h1', null, 'Request not found'), h('p', { class: 'muted' }, 'Check the link, or call your municipal office.'));
    return;
  }
  for (let i = 0; i < 6 && params.get('paid') && v.pay_status === 'due'; i += 1) { await new Promise((r) => { setTimeout(r, 1500); }); await load(); }
  document.title = `${v.town}: cart request ${v.reference}`;
  const msg = h('div', { role: 'status' });
  const draw = () => {
    const canceled = v.status === 'cancelled' || v.status === 'expired';
    const pay = {
      paid: `Paid ${money(v.paid_cents)}.`, not_needed: 'Nothing to pay.',
      due: v.pay_method === 'card' ? `${money(v.fee_cents)} still to pay by card.` : `Please pay ${money(v.fee_cents)} at ${v.office_name}.`,
      refund_due: `Your refund of ${money(v.paid_cents)} is waiting at ${v.office_name}.`, refunded: `${money(v.refunded_cents)} refunded.`,
    }[v.pay_status] || '';
    const title = canceled ? 'Request canceled' : v.status === 'awaiting_payment' ? 'Almost done: pay to send it' : v.status === 'delivered' ? 'Delivered' : just || params.get('paid') ? 'Request sent' : 'Your cart request';
    const when = v.status === 'scheduled' ? `Coming ${v.deliver_words}.` : v.status === 'delivered' ? `Delivered${v.deliver_words ? ` ${v.deliver_words}` : ''}.` : v.status === 'open' ? 'We will tell you the delivery day.' : '';
    clear(root).append(h('div', { class: 'help-done stack' },
      h('h1', null, title), h('p', { class: 'bulk-ref' }, 'Reference ', h('b', null, v.reference)),
      h('dl', { class: 'bulk-facts' },
        h('dt', null, 'Request'), h('dd', null, `${v.kind_label}: ${v.size_gal}-gallon ${v.stream}`),
        h('dt', null, 'Address'), h('dd', null, v.address),
        when ? h('dt', null, 'Delivery') : null, when ? h('dd', null, when) : null,
        h('dt', null, 'Payment'), h('dd', null, pay)),
      v.texts_off && !canceled ? h('p', { role: 'status' }, h('strong', null, v.texts_off)) : null,
      h('p', { class: 'muted small' }, `Keep this page’s link to come back to your request. Questions? Call ${v.office_name}${v.phone ? ` at ${v.phone}` : ''}.`),
      v.can_pay ? h('button', { type: 'button', class: 'btn primary big', onclick: payNow }, `Pay ${money(v.fee_cents)} by card`) : null,
      v.can_cancel ? h('button', { type: 'button', class: 'btn big', onclick: cancelNow }, 'Cancel request') : null, msg));
  };
  async function payNow(e) {
    e.target.disabled = true; clear(msg);
    try { location.href = (await post(`${api}/${encodeURIComponent(token)}/pay`)).checkout_url; } catch (ex) { e.target.disabled = false; msg.append(errorLine(ex.message)); }
  }
  async function cancelNow(e) {
    if (!window.confirm('Cancel this cart request?')) return;
    e.target.disabled = true; clear(msg);
    try { v = await post(`${api}/${encodeURIComponent(token)}/cancel`); draw(); } catch (ex) { e.target.disabled = false; msg.append(errorLine(ex.message)); }
  }
  draw();
}

main();
