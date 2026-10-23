// Checkout for the basket. Two steps in one dialog: who the sale is for (the customer, and each person a lesson,
// rental or program place is for), then how it is paid. The counter builds the basket first; this is where the
// customer's details are added. The receipt at the end shows ticket and gift card codes, change due and bookings.

import { typeName } from '../guesttypes.js';
import { get, post } from '../api.js';
import { h, clear, money, toCents, centsToInput, state, input, select, field, button, toast, dialog, label, errorBox, fmtDateTime, appendAll } from '../ui.js';
import { customerCapture } from './customer-form.js';
import { printButtons } from '../print.js';

const WHO_TYPES = ['lesson', 'lesson_package', 'rental', 'program'];
export const lineApi = (l, who, holders) => {
  const { type } = l;
  if (type === 'ticket') return { type, product_id: l.product_id, tier: l.tier, quantity: l.quantity, valid_on: l.valid_on, ...(holders ? { holders } : {}) };
  if (type === 'lesson') return { type, session_id: l.session_id, tier: l.tier, ...(who ? { participant: who } : {}) };
  if (type === 'lesson_package') return { type, product_id: l.product_id, tier: l.tier, ...(who ? { participant: who } : {}) };
  if (type === 'rental') return { type, product_id: l.product_id, tier: l.tier, items: l.items || [], ...(who ? { participant: who } : {}) };
  if (type === 'program') return { type, program_id: l.program_id, ...(l.term_id ? { term_id: l.term_id, group_id: l.group_id } : {}), ...(l.bundle_id ? { bundle_id: l.bundle_id, groups: l.groups } : {}), ...(who ? { participant: who } : {}) };
  return { type, amount_cents: l.amount_cents, recipient_name: l.recipient_name, message: l.message };
};

// ---------------------------------------------------------------- choosing gear for a rental line
export async function gearDialog(line, onDone, profile = null) {
  const { data } = await get('/rentals/items?status=available&limit=500');
  const sized = profile ? [profile.height_in && `${profile.height_in} in`, profile.weight_lb && `${profile.weight_lb} lb`, profile.boot_size && `boot ${profile.boot_size}`, profile.stance && label(profile.stance), profile.skier_type && `type ${profile.skier_type}`, profile.last_din && `last DIN ${profile.last_din}`].filter(Boolean) : [];
  const chosen = new Map((line.items || []).map((i) => [i.rental_item_id, i]));
  const filter = input({ type: 'search', placeholder: 'Filter by size, brand or tag number', 'aria-label': 'Filter gear' });
  const list = h('div', { class: 'stack' });
  const dinInputs = new Map();
  function draw() {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const items = data.filter((i) => !q || [i.sku, i.brand, i.model, i.size, i.category].join(' ').toLowerCase().includes(q));
    if (!items.length) { list.append(h('p', { class: 'muted' }, data.length ? 'Nothing matches.' : 'No gear is available right now.')); return; }
    for (const cat of [...new Set(items.map((i) => i.category))]) {
      list.append(h('h4', null, label(cat)), h('div', { class: 'gear-grid' }, items.filter((i) => i.category === cat).map((i) => {
        const bootMatch = profile && profile.boot_size && i.category === 'boot' && String(i.size || '').trim() === String(profile.boot_size).trim();
        const box = h('input', { type: 'checkbox', checked: chosen.has(i.id), 'aria-label': `${i.sku}` });
        const din = ['ski', 'snowboard'].includes(i.category) ? h('input', { type: 'number', step: '0.5', min: '0.5', max: '20', placeholder: 'DIN', class: 'din', 'aria-label': `DIN for ${i.sku}`, value: chosen.has(i.id) && chosen.get(i.id).din_setting ? chosen.get(i.id).din_setting : (profile && profile.last_din ? profile.last_din : '') }) : null;
        if (din) dinInputs.set(i.id, din);
        box.addEventListener('change', () => { if (box.checked) chosen.set(i.id, { rental_item_id: i.id }); else chosen.delete(i.id); });
        return h('label', { class: bootMatch ? 'gear match' : 'gear', title: bootMatch ? 'Matches the boot size on file' : null }, box, h('span', null, `${i.brand || ''} ${i.model || ''}`.trim() || label(i.category), h('small', { class: 'muted' }, ` ${[i.size && `size ${i.size}`, `tag ${i.sku}`, bootMatch ? 'matches boot size' : null].filter(Boolean).join(', ')}`)), din);
      })));
    }
  }
  filter.addEventListener('input', draw);
  const done = button('Use this gear', () => {
    line.items = [...chosen.values()].map((i) => {
      const d = dinInputs.get(i.rental_item_id);
      const n = d && d.value ? Number(d.value) : null;
      return { rental_item_id: i.rental_item_id, ...(n ? { din_setting: n } : {}) };
    });
    dlg.close();
    onDone();
  }, { kind: 'primary' });
  const dlg = dialog(`Choose the gear: ${line.name}`, h('div', { class: 'stack' }, sized.length ? h('p', { class: 'sizing-note', 'data-sizing': '' }, `Sizing on file: ${sized.join(', ')}.`) : h('p', { class: 'muted small' }, 'No sizing on file for this renter. Add height, weight and boot size on their customer details to get a match next time.'), filter, list, h('div', { class: 'footer row' }, done)), { wide: true });
  draw();
}

// ---------------------------------------------------------------- the checkout dialog
/**
 * basket: [{ type, name, ... }] built by the Sell screen. quote: the server's quote for it (totals).
 * onSold(order) runs after a successful sale.
 */
export function checkoutDialog({ basket, quote, def, promo, onSold, comp = null, waiverText = null, quickSale = null, drawerOpen = () => true, onOpenDrawer = null }) {
  const hasTickets = basket.some((l) => l.type === 'ticket');
  const hasLesson = basket.some((l) => l.type === 'lesson' || l.type === 'lesson_package');
  const hasRental = basket.some((l) => l.type === 'rental');
  const total = quote.total_cents;
  // Everything sold is for a named person: one slot per ticket, and one per lesson, rental and program place.
  const slots = [];
  for (const l of basket) {
    if (l.type === 'ticket') {
      for (let n = 0; n < l.quantity; n++) slots.push({ line: l, text: l.quantity > 1 ? `${l.name} ${n + 1} of ${l.quantity}` : l.name, aria: l.quantity > 1 ? `${l.name} ${n + 1}` : l.name });
    } else if (WHO_TYPES.includes(l.type)) slots.push({ line: l, text: l.name, aria: l.name });
  }
  const slotNeedsWaiver = (s) => s.line.type === 'lesson' || s.line.type === 'rental';
  // Quick sale: a basket of only day tickets, multi-day tickets, punch cards or vouchers can be sold with no name.
  const quickOk = Boolean(quickSale && quickSale.allowed && basket.length && basket.every((l) => l.type === 'ticket' && quickSale.kinds.includes(l.kind)));
  let quick = false;

  // ---- step 1: customer and participants
  const waiverBox = () => (waiverText ? h('details', { class: 'waiver-read' }, h('summary', null, 'Read the waiver'), h('div', { class: 'waiver-text' }, waiverText)) : null);
  const customer = customerCapture({ def, scope: hasTickets ? 'ticket' : (hasLesson ? 'lesson' : null), who: 'Customer', sale: true, sizing: hasRental, onPick: (p) => { refreshWho(); loadFamily(p); } });
  const custWaiver = h('input', { type: 'checkbox', name: 'cust_waiver' });
  const custWaiverText = h('span');
  const custWaiverRow = h('div', { class: 'stack tight' }, h('label', { class: 'check' }, custWaiver, custWaiverText), waiverBox());
  const custGuardianRow = h('div', { class: 'guardian-row', hidden: true });
  const famBox = h('div', { class: 'stack tight' });
  const people = []; // extra participants: { id, capture, waiver, waiverRow, waiverText, guardianRow, box }
  const peopleBox = h('div', { class: 'stack' });
  const assign = new Map(); // slot -> 'customer' | participant id
  for (const s of slots) assign.set(s, 'customer');
  const guardianPick = new Map(); // person key -> the key of their parent or guardian ('' = already on file)
  const whoBox = h('div', { class: 'stack' });
  const step1Error = h('div');

  const nameOf = (p) => {
    const d = p.capture.payload('details');
    const first = d.details && d.details.first_name;
    const last = d.details && d.details.last_name;
    return [first, last].filter(Boolean).join(' ') || `Person ${people.indexOf(p) + 2}`;
  };
  const custName = () => {
    const d = customer.payload('details').details;
    return d && (d.first_name || d.last_name) ? [d.first_name, d.last_name].filter(Boolean).join(' ') : 'the customer';
  };
  const hasWaiver = (cap) => { const p = cap.person(); return Boolean(p && p.summary && p.summary.waiver_this_season); };
  const everyone = () => [{ id: 'customer', cap: customer, name: custName(), row: custGuardianRow }, ...people.map((p) => ({ id: p.id, cap: p.capture, name: nameOf(p), row: p.guardianRow }))];
  const usedBy = (id) => slots.filter((s) => assign.get(s) === id);
  const guardianFor = (id) => (guardianPick.has(id) ? guardianPick.get(id) : (id !== 'customer' && !customer.isMinor() ? 'customer' : ''));

  function refreshWho() {
    clear(whoBox);
    refreshGuardians();
    refreshWaivers();
    for (const e of everyone()) e.cap.photoNeeded(usedBy(e.id).some((s) => s.line.kind === 'season_pass'));
    if (!slots.length) return;
    whoBox.append(h('h3', null, 'Who is each one for?'));
    for (const s of slots) {
      const l = s.line;
      const sel = select([['customer', `Same as ${custName()}`], ...people.map((p) => [p.id, nameOf(p)])], assign.get(s), { 'aria-label': `Who is ${s.aria} for` });
      sel.addEventListener('change', () => { assign.set(s, sel.value); refreshWho(); });
      const extra = l.type === 'rental' ? [button(l.items && l.items.length ? `Gear: ${l.items.length} chosen` : 'Choose gear', () => openGear(s), { small: true })] : [];
      whoBox.append(h('div', { class: 'who-row' }, h('div', null, h('strong', null, s.text), h('small', { class: 'muted' }, ` ${l.detail || ''}`)), sel, ...extra));
    }
    whoBox.append(button('Someone else is taking part', () => addPerson(), { small: true }));
  }
  /** Sizing on file (typed above, or kept from last time) and the last DIN used, then the gear chooser. */
  async function openGear(s) {
    const who = everyone().find((e) => e.id === assign.get(s));
    const typed = who ? who.cap.sizing() : {};
    let last = null;
    const person = who && who.cap.person();
    if (person) { try { last = (await get(`/people/${person.id}/rental-profile`)).last_din; } catch (_) { /* no history */ } }
    await gearDialog(s.line, refreshWho, { ...typed, last_din: last });
  }
  function refreshGuardians() {
    for (const e of everyone()) {
      clear(e.row);
      const needs = e.cap.isMinor() && (e.id === 'customer' || usedBy(e.id).length > 0);
      e.row.hidden = !needs;
      if (!needs) continue;
      const opts = [];
      for (const o of everyone()) if (o.id !== e.id && !o.cap.isMinor()) opts.push([o.id, o.id === 'customer' ? `${o.name} (the customer)` : o.name]);
      opts.push(['', 'A parent or guardian already on file']);
      const sel = select(opts, guardianFor(e.id), { 'aria-label': `Parent or guardian of ${e.name}`, 'data-guardian-for': e.id });
      sel.addEventListener('change', () => { guardianPick.set(e.id, sel.value); refreshWaivers(); });
      e.row.append(h('label', { class: 'field' }, `${e.name} is under 18. Parent or guardian`, sel, h('span', { class: 'hint' }, 'They sign the waiver for the child and are linked to them on file.')));
    }
  }
  function refreshWaivers() {
    const set = (box, textEl, e) => {
      const needs = usedBy(e.id).some(slotNeedsWaiver) && !hasWaiver(e.cap);
      box.hidden = !needs;
      textEl.textContent = e.cap.isMinor() ? ` A parent or guardian signed the waiver for ${e.name}` : ' Waiver signed at the counter';
    };
    const [c, ...rest] = everyone();
    set(custWaiverRow, custWaiverText, c);
    rest.forEach((e, i) => set(people[i].waiverRow, people[i].waiverText, e));
  }
  function addPerson(prefill) {
    const id = `p${people.length + 1}`;
    const capture = customerCapture({ def, scope: hasLesson ? 'lesson' : (hasTickets ? 'ticket' : null), who: 'Participant', sale: true, sizing: hasRental, onPick: () => refreshWho() });
    const waiver = h('input', { type: 'checkbox' });
    const waiverText_ = h('span');
    const waiverRow = h('div', { class: 'stack tight' }, h('label', { class: 'check' }, waiver, waiverText_), waiverBox());
    const guardianRow = h('div', { class: 'guardian-row', hidden: true });
    const remove = button('Remove this person', () => {
      for (const s of slots) if (assign.get(s) === id) assign.set(s, 'customer');
      people.splice(people.findIndex((p) => p.id === id), 1);
      box.remove(); refreshWho();
    }, { small: true });
    const box = h('section', { class: 'panel stack', 'data-person': id }, h('h3', null, 'Another person'), capture.el, guardianRow, waiverRow, h('div', { class: 'row' }, remove));
    people.push({ id, capture, waiver, waiverRow, waiverText: waiverText_, guardianRow, box });
    peopleBox.append(box);
    if (prefill) capture.usePerson(prefill);
    refreshWho();
    // refresh the "Same as ..." and name labels as details are typed
    box.addEventListener('input', () => refreshWho());
    return id;
  }
  /** Family on file for the customer: one tap adds a child or partner as someone taking part. */
  async function loadFamily(p) {
    clear(famBox);
    if (!p || !p.id) return;
    try {
      const fam = await get(`/people/${p.id}/family`);
      const kin = [...fam.dependents, ...fam.household];
      if (!kin.length) return;
      famBox.append(h('p', { class: 'muted small' }, 'Family on file'), h('div', { class: 'chips' }, kin.map((k) => h('button', { type: 'button', class: 'family-chip', 'data-family': k.id, onclick: () => {
        if (people.some((x) => x.capture.person() && x.capture.person().id === k.id)) return;
        addPerson(k);
      } }, `Add ${k.first_name}${k.age !== null && k.age !== undefined ? ` (${k.age})` : ''}`))));
    } catch (_) { /* family is a convenience; the sale does not depend on it */ }
  }
  customer.el.addEventListener('input', () => { for (const o of whoBox.querySelectorAll('option[value=customer]')) o.textContent = `Same as ${custName()}`; refreshGuardians(); refreshWaivers(); });

  const step1 = h('div', { class: 'stack' },
    h('h3', null, 'Customer'),
    h('p', { class: 'muted small' }, 'Every item sold needs a name. Find the customer by name, phone or email, or type their details. Everyone needs a date of birth and sex; under 18s do not need a phone or email, but do need a parent or guardian.'),
    customer.el, famBox, custGuardianRow, custWaiverRow, whoBox, peopleBox, step1Error);
  refreshWho();

  // ---- step 2: payment. Choose how they pay first; only that way's fields show.
  const payments = [];
  const paid = () => payments.reduce((n, p) => n + p.amount_cents, 0);
  const remaining = () => total - paid();
  const amount = input({ name: 'amount', inputmode: 'decimal', 'aria-label': 'Amount' });
  const tendered = input({ name: 'tendered', inputmode: 'decimal', 'aria-label': 'Cash handed over', placeholder: 'Optional' });
  const reference = input({ name: 'reference', maxlength: 100, 'aria-label': 'Card reference', placeholder: 'Optional' });
  const cardBrand = select([['', 'Not recorded'], ['visa', 'Visa'], ['mastercard', 'Mastercard'], ['amex', 'American Express'], ['discover', 'Discover'], ['other', 'Other']], '', { name: 'card_brand', 'aria-label': 'Card brand' });
  const cardLast4 = input({ name: 'card_last4', inputmode: 'numeric', maxlength: 4, placeholder: '1234', 'aria-label': 'Last four digits of the card' });
  const authCode = input({ name: 'auth_code', maxlength: 40, autocomplete: 'off', placeholder: 'Optional', 'aria-label': 'Approval code' });
  const compReason = select([['', 'Choose a reason'], ...((comp && comp.reasons) || []).map((r) => [r, label(r)])], '', { name: 'comp_reason', 'aria-label': 'Reason this is free' });
  const cardCode = input({ name: 'giftcode', autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Gift card code' });
  const payList = h('div', { class: 'stack' });
  const due = h('div', { class: 'basket-total', role: 'status' });
  const changeBig = h('div', { class: 'change-due', role: 'status', hidden: true });
  const step2Error = h('div');
  const complete = button('Complete sale', () => finish(), { kind: 'primary' });

  // ---- card readers at the counter (routes/terminal.js): the amount goes to the reader, the guest taps, inserts or swipes.
  let readers = []; let readerTest = false; let currentWay = null; let sold = false; let charging = null;
  const readerPick = select([], '', { name: 'reader', 'aria-label': 'Card reader' });
  const readerBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  get('/terminal/readers').then((r) => {
    readers = r.readers || []; readerTest = Boolean(r.test_mode);
    clear(readerPick).append(...readers.map((x) => h('option', { value: String(x.id) }, x.label)));
    if (currentWay === 'card') choose('card');
  }).catch(() => {});
  const BRAND_OK = ['visa', 'mastercard', 'amex', 'discover', 'other'];
  async function chargeOnReader() {
    clear(readerBox);
    const cents = toCents(amount.value);
    if (!cents || cents < 50) throw new Error('Enter the amount to take (at least $0.50)');
    if (cents > remaining()) throw new Error(`That is more than the ${money(remaining())} still to pay`);
    const reader = readers.find((x) => String(x.id) === readerPick.value) || readers[0];
    const pay = await post('/terminal/charges', { reader_id: reader.id, amount_cents: cents });
    charging = pay.id;
    const line = h('p', { role: 'status' }, h('strong', null, `Waiting for the card on ${reader.label}.`), ` Ask the guest to tap, insert or swipe for ${money(cents)}.`);
    const stop = button('Cancel', async () => {
      try { await post(`/terminal/payments/${pay.id}/cancel`, {}); } catch (err) { readerBox.append(errorBox(err)); return; }
      charging = null; clear(readerBox).append(h('p', { class: 'muted' }, 'Stopped. Nothing was charged.'));
    }, { small: true });
    const sim = reader.simulated && readerTest ? [
      button('Simulate a tap', () => post(`/terminal/payments/${pay.id}/simulate`, { outcome: 'approve' }).catch((err) => readerBox.append(errorBox(err))), { small: true }),
      button('Simulate a decline', () => post(`/terminal/payments/${pay.id}/simulate`, { outcome: 'decline' }).catch((err) => readerBox.append(errorBox(err))), { small: true })] : [];
    appendAll(clear(readerBox), h('div', { class: 'notice reader-wait' }, line, h('div', { class: 'row' }, stop, ...sim)));
    const started = Date.now();
    while (charging === pay.id && Date.now() - started < 180_000) {
      await new Promise((r) => { setTimeout(r, 1500); });
      if (charging !== pay.id) return;
      let st;
      try { st = await get(`/terminal/payments/${pay.id}`); } catch (_) { continue; }
      if (st.status === 'waiting') continue;
      charging = null;
      if (st.status === 'succeeded') {
        const p = { tender: 'card', amount_cents: st.amount_cents, terminal_payment_id: st.id, on_reader: true };
        if (st.card_last4) p.card_last4 = st.card_last4;
        if (st.card_brand && BRAND_OK.includes(st.card_brand)) p.card_brand = st.card_brand;
        payments.push(p); clear(readerBox); drawPayments();
        toast(`Card approved: ${money(st.amount_cents)}`);
      } else if (st.status === 'failed') {
        clear(readerBox).append(errorBox(new Error(`${st.failure || 'The card was not accepted.'} Try again, or take another payment.`)));
      } else {
        clear(readerBox).append(h('p', { class: 'muted' }, 'The payment was cancelled. Nothing was charged.'));
      }
      return;
    }
    if (charging === pay.id) { charging = null; clear(readerBox).append(errorBox(new Error('The reader did not answer in 3 minutes. Check it is on and online, then try again.'))); post(`/terminal/payments/${pay.id}/cancel`, {}).catch(() => {}); }
  }
  /** A reader payment taken off the sale, or a sale given up: the card is refunded, never left charged. */
  async function giveBack(p) {
    await post(`/terminal/payments/${p.terminal_payment_id}/cancel`, {});
    toast(`Refunded ${money(p.amount_cents)} to the card`);
  }

  function drawPayments() {
    clear(payList);
    for (const [i, p] of payments.entries()) {
      payList.append(h('div', { class: 'spread pay-row' }, h('span', null, `${label(p.tender)} ${money(p.amount_cents)}`, p.tendered_cents && p.tendered_cents > p.amount_cents ? h('small', { class: 'muted' }, `  (${money(p.tendered_cents)} handed over)`) : null, p.code ? h('small', { class: 'muted' }, `  card ${p.code}`) : null, p.card_last4 ? h('small', { class: 'muted' }, `  ending ${p.card_last4}`) : null, p.comp_reason ? h('small', { class: 'muted' }, `  (${label(p.comp_reason)})`) : null),
        button(p.on_reader ? 'Refund and remove' : 'Remove', async () => {
          if (p.on_reader) { try { await giveBack(p); } catch (err) { step2Error.append(errorBox(err)); return; } }
          payments.splice(i, 1); drawPayments();
        }, { small: true })));
    }
    const left = remaining();
    clear(due).append(left > 0 ? `Still to pay ${money(left)}` : left === 0 ? (total ? 'Paid in full' : 'Nothing to pay') : `Over by ${money(-left)}`);
    due.dataset.state = left === 0 ? 'good' : 'warn';
    amount.value = left > 0 ? centsToInput(left) : '';
    const change = payments.reduce((n, p) => n + (p.tendered_cents ? p.tendered_cents - p.amount_cents : 0), 0);
    changeBig.hidden = !change; changeBig.textContent = change ? `Give ${money(change)} change` : '';
    complete.disabled = left !== 0;
    drawCashButtons();
  }
  async function addPayment(tender, tenderedCents = null) {
    const cents = toCents(amount.value);
    if (!cents || cents < 1) throw new Error('Enter the amount to take');
    if (cents > remaining()) throw new Error(`That is more than the ${money(remaining())} still to pay`);
    const p = { tender, amount_cents: cents };
    if (tender === 'cash') {
      const t = tenderedCents !== null ? tenderedCents : (tendered.value.trim() ? toCents(tendered.value) : null);
      if (t !== null && (t === undefined || t < cents)) throw new Error('The cash handed over is less than the amount');
      if (t && t > cents) p.tendered_cents = t;
    }
    if (tender === 'card' || tender === 'other') { if (reference.value.trim()) p.reference = reference.value.trim(); }
    if (tender === 'card') {
      const last4 = cardLast4.value.trim();
      if (last4 && !/^\d{4}$/.test(last4)) throw new Error('Enter just the last four digits of the card, or leave it blank');
      if (last4) p.card_last4 = last4;
      if (cardBrand.value) p.card_brand = cardBrand.value;
      if (authCode.value.trim()) p.auth_code = authCode.value.trim();
      p.processor = 'manual';
    }
    if (tender === 'comp') {
      if (!compReason.value) throw new Error('Say why this is free of charge');
      p.comp_reason = compReason.value;
    }
    if (tender === 'gift_card') {
      const code = cardCode.value.trim();
      if (!code) throw new Error('Enter the gift card code');
      const card = await get(`/gift-cards/${encodeURIComponent(code)}`);
      if (card.status !== 'active') throw new Error('That gift card has been cancelled');
      if (card.balance_cents < cents) throw new Error(`That gift card only has ${money(card.balance_cents)} left. Take that amount, then pay the rest another way.`);
      p.code = code;
      toast(`Gift card balance after this: ${money(card.balance_cents - cents)}`);
    }
    payments.push(p);
    tendered.value = ''; reference.value = ''; cardCode.value = ''; cardLast4.value = ''; authCode.value = ''; cardBrand.value = ''; compReason.value = '';
    drawPayments();
  }
  // Cash: one tap for the note handed over; the change shows in large type.
  const cashButtons = h('div', { class: 'row cash-quick', role: 'group', 'aria-label': 'Cash handed over' });
  function drawCashButtons() {
    clear(cashButtons);
    const left = remaining();
    if (left <= 0) return;
    cashButtons.append(button(`Exact ${money(left)}`, () => { amount.value = centsToInput(left); return addPayment('cash', left); }, { kind: 'primary' }));
    for (const note of [2000, 5000, 10000]) if (note > left) cashButtons.append(button(money(note), () => { amount.value = centsToInput(left); return addPayment('cash', note); }));
  }
  const ways = [['cash', 'Cash'], ['card', 'Card'], ['gift_card', 'Gift card'], ['other', 'Other']];
  if (comp && comp.can_comp) ways.push(['comp', 'Free of charge']);
  const panel = h('div', { class: 'stack' });
  const wayBtns = new Map();
  function choose(way) {
    currentWay = way;
    for (const [k, b] of wayBtns) b.setAttribute('aria-pressed', String(k === way));
    const take = (text) => button(text, () => addPayment(way), { kind: way === 'cash' ? null : 'primary' });
    const forms = {
      cash: () => [drawerOpen() ? null : h('div', { class: 'notice warn', role: 'alert' }, 'No cash drawer is open, so this cash will not be in any drawer count. Open your drawer first.', onOpenDrawer ? [' ', button('Open cash drawer', () => onOpenDrawer(() => choose('cash')), { small: true })] : null),
        cashButtons, h('div', { class: 'form' }, field('Amount', amount), field('Cash handed over (other amount)', tendered)), h('div', { class: 'row' }, take('Take cash'))],
      card: () => {
        const manual = [h('div', { class: 'form' }, field('Amount', amount), field('Last 4 digits', cardLast4), field('Card brand', cardBrand), field('Approval code', authCode), field('Card reference', reference)), h('div', { class: 'row' }, take('Take card'))];
        if (!readers.length) return manual;
        return [h('div', { class: 'form' }, field('Amount', amount), readers.length > 1 ? field('Card reader', readerPick) : null),
          h('div', { class: 'row' }, button('Charge on reader', () => chargeOnReader(), { kind: 'primary' })), readerBox,
          h('details', { class: 'more-pay' }, h('summary', null, 'Card taken another way'), h('div', { class: 'stack' }, h('div', { class: 'form' }, field('Last 4 digits', cardLast4), field('Card brand', cardBrand), field('Approval code', authCode), field('Card reference', reference)), h('div', { class: 'row' }, take('Record card'))))];
      },
      gift_card: () => [h('div', { class: 'form' }, field('Amount', amount), field('Gift card code', cardCode)), basket.some((l) => l.type === 'gift_card') ? h('p', { class: 'muted small' }, 'A gift card cannot be used to buy another gift card.') : null, h('div', { class: 'row' }, take('Use gift card'))],
      other: () => [h('div', { class: 'form' }, field('Amount', amount), field('Reference', reference)), h('div', { class: 'row' }, take('Record payment'))],
      comp: () => [h('div', { class: 'form' }, field('Amount', amount), field('Reason', compReason, comp && comp.counter_limit_cents ? undefined : 'Managers only')), h('div', { class: 'row' }, take('Give free of charge'))],
    };
    appendAll(clear(panel), forms[way]()); // built on demand: each field lives in one place at a time
    drawCashButtons();
    const first = panel.querySelector('input, select'); if (first && way !== 'cash') first.focus();
  }
  const wayRow = h('div', { class: 'seg tender-row', role: 'group', 'aria-label': 'How are they paying' }, ways.map(([k, t]) => { const b = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => choose(k) }, t); wayBtns.set(k, b); return b; }));
  const step2 = h('div', { class: 'stack' },
    h('h3', null, 'Payment'),
    h('div', { class: 'spread' }, h('div', { class: 'muted' }, [quote.discount_cents ? `Discount ${money(quote.discount_cents)}` : '', quote.tax_cents ? `${quote.discount_cents ? ' · ' : ''}Tax ${money(quote.tax_cents)}` : ''].join('')), h('div', { class: 'basket-total' }, `Total ${money(total)}`)),
    total ? h('div', { class: 'stack' }, wayRow, panel) : h('p', { class: 'muted' }, 'Nothing is due, so no payment is needed.'),
    payList, due, changeBig, step2Error);
  if (total) choose('cash');

  // ---- assembling the sale
  const dlgBody = h('div', { class: 'stack' });
  const nav = h('div', { class: 'footer row' });
  let dlg;

  function problems() {
    if (quick) return null;
    const uses = (id) => slots.filter((s) => assign.get(s) === id);
    const d = customer.payload('details').details;
    const has = Boolean(customer.person() || (d && (d.first_name || d.last_name)));
    if (!has) return "Add the customer's details: every item sold needs a name.";
    try { customer.check(); } catch (e) { return e.message; }
    for (const p of people) {
      if (!uses(p.id).length) continue;
      try { p.capture.check(); } catch (e) { return `${nameOf(p)}: ${e.message}`; }
    }
    for (const e of everyone()) {
      if (e.id !== 'customer' && !usedBy(e.id).length) continue;
      if (e.cap.isMinor() && guardianFor(e.id) === '' && !(e.cap.person() && e.cap.person().id)) return `${e.name} is under 18: choose a parent or guardian (18 or over) who is signing for them.`;
    }
    for (const s of slots) if (s.line.type === 'rental' && !(s.line.items && s.line.items.length)) return `Choose the gear for ${s.line.name}.`;
    return null;
  }

  function build() {
    const body = { channel: 'window', promo_code: promo || undefined, lines: [], payments: payments.map((p) => ({ ...p })) };
    if (quick) return { ...body, quick: true, lines: basket.map((l) => lineApi(l, null, null)) };
    const c = customer.payload('details');
    const gOf = (id, cap) => { const g = guardianFor(id); return cap.isMinor() && g ? { guardian: g } : {}; };
    body.customer = { ...c, ...(custWaiver.checked && !custWaiverRow.hidden ? { sign_waiver: true } : {}), ...gOf('customer', customer) };
    const used = new Set(slots.map((s) => assign.get(s)).filter((k) => k !== 'customer'));
    for (const p of people) {
      if (!used.has(p.id)) continue;
      body.participants = body.participants || {};
      body.participants[p.id] = { ...p.capture.payload('details'), ...(p.waiver.checked && !p.waiverRow.hidden ? { sign_waiver: true } : {}), ...gOf(p.id, p.capture) };
    }
    body.lines = basket.map((l) => {
      const mine = slots.filter((s) => s.line === l);
      if (l.type === 'ticket') return lineApi(l, null, mine.map((s) => assign.get(s)));
      const who = mine.length ? assign.get(mine[0]) : null;
      return lineApi(l, who && who !== 'customer' ? who : null);
    });
    return body;
  }

  async function finish() {
    clear(step2Error);
    complete.disabled = true;
    try {
      const out = await post('/checkout', build());
      sold = true;
      receipt(out);
      onSold(out);
    } catch (err) {
      step2Error.append(errorBox(err));
      complete.disabled = remaining() !== 0;
    }
  }

  function show(n) {
    clear(dlgBody).append(n === 1 ? step1 : step2);
    clear(nav);
    if (n === 1) {
      quick = false;
      appendAll(nav, button('Cancel', () => dlg.close()),
        quickOk ? button('Quick sale: no name', () => { quick = true; show(2); drawPayments(); }, { kind: null }) : null,
        button(total ? 'Next: payment' : 'Next', () => {
        clear(step1Error);
        const p = problems();
        if (p) { step1Error.append(errorBox(new Error(p))); return; }
        show(2); drawPayments();
      }, { kind: 'primary' }));
    } else {
      nav.append(button('Back', () => show(1)), complete);
      if (quick) dlgBody.prepend(h('p', { class: 'muted small' }, 'Quick sale: nothing is saved about the guest. Use Back to add their details instead.'));
    }
  }

  function receipt(out) {
    clear(dlgBody); clear(nav);
    const codes = (items, text) => (items.length ? h('section', { class: 'stack' }, h('h3', null, text), h('div', { class: 'codes' }, items)) : null);
    appendAll(dlgBody,
      h('div', { class: 'receipt-head', role: 'status' }, h('strong', null, `Sold ${money(out.total_cents)}`), h('span', { class: 'muted' }, ` Order #${out.id}`), out.tax_cents ? h('span', { class: 'muted' }, ` (includes ${money(out.tax_cents)} tax)`) : null),
      h('div', { class: 'row print-actions' }, printButtons(out.id, { hasTickets: out.tickets.length > 0 })),
      out.change_due_cents ? h('div', { class: 'change-due', role: 'status' }, `Change due ${money(out.change_due_cents)}`) : null,
      out.customer ? h('p', { class: 'muted' }, out.customer.created ? 'New customer saved.' : 'Customer record updated.') : null,
      codes(out.tickets.map((t) => h('div', { class: 'code' }, t.code, h('small', null, [t.holder, t.product, typeName(t.tier), t.valid_from === t.valid_to ? t.valid_from : `${t.valid_from} to ${t.valid_to}`].join(', ')))), `${out.tickets.length} ticket${out.tickets.length === 1 ? '' : 's'}`),
      codes(out.gift_cards.map((g) => h('div', { class: 'code' }, g.code, h('small', null, `${money(g.amount_cents)}${g.recipient_name ? ` for ${g.recipient_name}` : ''}`))), 'Gift cards (give the guest the code)'),
      out.lessons.length ? h('section', { class: 'stack' }, h('h3', null, 'Lessons booked'), h('ul', { class: 'plain' }, out.lessons.map((l) => h('li', null, `${l.name}, ${fmtDateTime(l.starts_at)}`)))) : null,
      out.rentals.length ? h('section', { class: 'stack' }, h('h3', null, 'Gear out'), h('ul', { class: 'plain' }, out.rentals.map((r) => h('li', null, `${r.items.join(', ')}, due back ${fmtDateTime(r.due_at)}`)))) : null,
      out.programs.length ? h('section', { class: 'stack' }, h('h3', null, 'Program places'), h('ul', { class: 'plain' }, out.programs.map((p) => h('li', null, p.name)))) : null);
    nav.append(button('New sale', () => dlg.close(), { kind: 'primary' }));
  }

  // Closed without completing the sale: a card already charged on the reader goes back to the guest.
  const onClose = () => {
    charging = null;
    if (sold) return;
    for (const p of payments.filter((x) => x.on_reader)) giveBack(p).catch(() => toast('A card reader payment could not be refunded. A manager can refund it under Billing, Card readers.', 'error'));
  };
  dlg = dialog('Checkout', h('div', { class: 'stack' }, dlgBody, nav), { wide: true, onClose });
  show(1);
  return dlg;
}

export { state };
