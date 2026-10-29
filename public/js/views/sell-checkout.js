// Checkout for the basket. Two steps in one dialog: who the sale is for (the customer, and each person a lesson,
// rental, program place or activity is for, with each rider's limits confirmed), then how it is paid. The counter builds the basket first; this is where the
// customer's details are added. The receipt at the end shows ticket and gift card codes, change due and bookings.

import { typeName } from '../guesttypes.js';
import { get, post } from '../api.js';
import { h, clear, ctx, money, toCents, centsToInput, state, input, select, field, button, toast, dialog, label, errorBox, fmtDateTime, fmtTime, appendAll } from '../ui.js';
import { safetyFields } from './lesson-safety.js';
import { customerCapture } from './customer-form.js';
import { printButtons } from '../print.js';

const clock12 = (t) => { const [hh, mm] = String(t || '').split(':').map(Number); return `${hh % 12 || 12}:${String(mm || 0).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
const WHO_TYPES = ['lesson', 'lesson_package', 'rental', 'program', 'activity'];
export const lineApi = (l, who, holders, limitsOk) => {
  const { type } = l;
  if (type === 'activity') return { type, product_id: l.product_id, tier: l.tier, valid_on: l.valid_on, ...(l.start_time ? { start_time: l.start_time } : {}), ...(who ? { participant: who } : {}), ...(limitsOk ? { limits_ok: true } : {}) };
  if (type === 'ticket') return { type, product_id: l.product_id, tier: l.tier, quantity: l.quantity, valid_on: l.valid_on, ...(holders ? { holders } : {}) };
  if (type === 'lesson') return { type, session_id: l.session_id, tier: l.tier, ...(who ? { participant: who } : {}), ...(l.safety ? { safety: l.safety } : {}) };
  if (type === 'lesson_package') return { type, product_id: l.product_id, tier: l.tier, ...(who ? { participant: who } : {}) };
  // eslint-disable-next-line no-unused-vars
  if (type === 'rental') return { type, product_id: l.product_id, tier: l.tier, items: (l.items || []).map(({ _item, _category, ...g }) => g), ...(l.fit ? { fit: l.fit } : {}), ...(l.signoff ? { signoff: l.signoff } : {}), ...(who ? { participant: who } : {}) };
  if (type === 'program') return { type, program_id: l.program_id, ...(l.term_id ? { term_id: l.term_id, group_id: l.group_id } : {}), ...(l.bundle_id ? { bundle_id: l.bundle_id, groups: l.groups } : {}), ...['discipline', 'has_pass', 'needs_rental', 'needs_helmet'].reduce((o, k) => (l[k] !== undefined ? { ...o, [k]: l[k] } : o), {}), ...(who ? { participant: who } : {}) };
  return { type, amount_cents: l.amount_cents, recipient_name: l.recipient_name, message: l.message };
};

// ---------------------------------------------------------------- fitting a rental line now (optional)
/**
 * The rental shop's fitting card for a rental line: today's details, the binding suggestion, the gear and the renter's
 * signed confirmation. Optional: a rental with no gear is paid now and fitted at the rental shop. No setting is ever
 * filled in from a past rental.
 */
export async function gearDialog(line, onDone, who = {}) {
  const { sellFitDialog } = await import('./rentals-fit.js');
  await sellFitDialog(line, who, onDone);
}

// ---------------------------------------------------------------- the checkout dialog
/**
 * basket: [{ type, name, ... }] built by the Sell screen. quote: the server's quote for it (totals).
 * onSold(order) runs after a successful sale.
 */
export function checkoutDialog({ basket, quote, def, promo, onSold, comp = null, waiverText = null, quickSale = null, drawerOpen = () => true, onOpenDrawer = null }) {
  const hasTickets = basket.some((l) => l.type === 'ticket' || l.type === 'activity'); // an activity asks for the same details as a ticket
  const hasLesson = basket.some((l) => l.type === 'lesson' || l.type === 'lesson_package');
  const hasRental = basket.some((l) => l.type === 'rental');
  let total = quote.total_cents; // the check before payment can change it: a guest type that follows the person
  // Everything sold is for a named person: one slot per ticket, and one per lesson, rental and program place.
  const slots = [];
  for (const l of basket) {
    if (l.type === 'ticket') {
      for (let n = 0; n < l.quantity; n++) slots.push({ line: l, text: l.quantity > 1 ? `${l.name} ${n + 1} of ${l.quantity}` : l.name, aria: l.quantity > 1 ? `${l.name} ${n + 1}` : l.name });
    } else if (WHO_TYPES.includes(l.type)) slots.push({ line: l, text: l.name, aria: l.name });
  }
  const slotNeedsWaiver = (s) => s.line.type === 'lesson' || s.line.type === 'rental' || (s.line.type === 'activity' && Boolean(s.line.attraction && s.line.attraction.waiver_required));
  // An activity rider: the clerk ticks that they meet the attraction's height, weight and age limits. Kept per slot.
  const limitsOk = new Map();
  const needsLimits = (s) => s.line.type === 'activity' && Boolean(s.line.attraction && s.line.attraction.has_limits);
  // Quick sale: a basket of only day tickets, multi-day tickets, punch cards or vouchers (and gift cards) can be sold
  // with no name, and that is the first choice for it; the guest's details are a tap away.
  const quickOk = Boolean(quickSale && quickSale.allowed && basket.length && basket.every((l) => (l.type === 'ticket' && quickSale.kinds.includes(l.kind)) || l.type === 'gift_card'));
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
  const step0Error = h('div');

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
    riderEls.clear();
    refreshGuardians();
    refreshWaivers();
    for (const e of everyone()) e.cap.photoNeeded(usedBy(e.id).some((s) => s.line.kind === 'season_pass'));
    if (!slots.length) return;
    whoBox.append(h('h3', null, 'Who is each one for?'));
    for (const s of slots) {
      const l = s.line;
      const sel = select([['customer', `Same as ${custName()}`], ...people.map((p) => [p.id, nameOf(p)])], assign.get(s), { 'aria-label': `Who is ${s.aria} for` });
      // a fitting belongs to one person: choosing someone else for the rental starts it again
      sel.addEventListener('change', () => { assign.set(s, sel.value); if (l.type === 'rental') { l.items = []; delete l.fit; delete l.signoff; } refreshWho(); });
      if (l.type === 'lesson') safetyFor(s, sel.value);
      const extra = l.type === 'rental' ? [button(l.items && l.items.length ? `Gear: ${l.items.length} chosen` : 'Fit now (optional)', () => openGear(s), { small: true }), l.items && l.items.length ? null : h('small', { class: 'muted' }, ' or fit at the rental shop')] : [];
      if (needsLimits(s)) {
        const cb = h('input', { type: 'checkbox', checked: Boolean(limitsOk.get(s)), 'data-limits': '' });
        cb.addEventListener('change', () => { limitsOk.set(s, cb.checked); });
        const who = h('span', { class: 'rider-name' });
        riderEls.set(s, who);
        extra.push(h('label', { class: 'check limits-ok' }, cb, h('span', null, ' ', who, ' meets the limits', h('small', { class: 'muted' }, ` ${l.attraction.limits_text}`))));
      }
      whoBox.append(h('div', { class: `who-row${needsLimits(s) ? ' who-limits' : ''}` }, h('div', null, h('strong', null, s.text), h('small', { class: 'muted' }, ` ${l.detail || ''}`)), sel, ...extra));
      if (l.type === 'lesson') whoBox.append(safety.get(s).box);
    }
    whoBox.append(button('Someone else is taking part', () => addPerson(), { small: true }));
    renameRiders();
  }
  // ---- each lesson's safety details and the family's answers on texts and photos (lesson-safety.js). The same fields
  // are kept while people are added or changed; they are filled from the student's last lesson when they are on file.
  const safety = new Map(); // slot -> { f, box, filledFor }
  const textsOn = Boolean(ctx.me && ctx.me.modules && ctx.me.modules.includes('lesson_texts'));
  function safetyFor(s, whoKey) {
    if (!safety.has(s)) {
      const f = safetyFields({ name: s.text, texts: textsOn, photos: true });
      if (s.line.safety_prefill) f.fill(s.line.safety_prefill);
      const sum = h('summary', null, 'Allergies, pickup and who to call');
      safety.set(s, { f, sum, box: h('details', { class: 'who-safety', open: true }, sum, f.el), filledFor: null });
    }
    const x = safety.get(s);
    const e = everyone().find((p) => p.id === whoKey);
    const person = e && e.cap.person();
    x.sum.textContent = `Allergies, pickup and who to call${e ? ` for ${e.name}` : ''}`;
    if (person && person.id && x.filledFor !== person.id) {
      x.filledFor = person.id;
      get(`/skischool/lesson-safety/${person.id}`).then((r) => x.f.fill(r.safety || {})).catch(() => {});
    }
  }
  /** The rider's name beside each limits box, kept up to date as names are typed. */
  const riderEls = new Map();
  function renameRiders() {
    for (const [s, el] of riderEls) { el.textContent = (everyone().find((e) => e.id === assign.get(s)) || {}).name || 'The rider'; }
  }
  /** The fitting card for this rental: today's details (typed above, or on file), never a setting from a past rental. */
  async function openGear(s) {
    const who = everyone().find((e) => e.id === assign.get(s));
    const d = who ? (who.cap.payload('details').details || {}) : {};
    const [first, ...rest] = String(who ? who.name : '').split(' ');
    await gearDialog(s.line, refreshWho, { person: who && who.cap.person(), first_name: d.first_name || first, last_name: d.last_name || rest.join(' '), minor: Boolean(who && who.cap.isMinor()), sizing: { ...(who ? who.cap.sizing() : {}), ...(d.date_of_birth ? { date_of_birth: d.date_of_birth } : {}) } });
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
  customer.el.addEventListener('input', () => { for (const o of whoBox.querySelectorAll('option[value=customer]')) o.textContent = `Same as ${custName()}`; refreshGuardians(); refreshWaivers(); renameRiders(); });

  // a student picked in Sell's lesson list is added as the person taking that lesson
  for (const s of slots) {
    const st = s.line.type === 'lesson' && s.line.student;
    if (!st) continue;
    const already = people.find((p) => p.capture.person() && p.capture.person().id === st.id);
    assign.set(s, already ? already.id : addPerson(st));
  }
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
  const totalEl = h('div', { class: 'basket-total' }, `Total ${money(total)}`);
  const typeNote = h('div');
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
    // The sale can still go through? Nothing goes to the reader otherwise: a refusal shows here, with no card charged.
    try { await check(); } catch (err) { clear(readerBox).append(errorBox(err)); return; }
    const pay = await post('/terminal/charges', { reader_id: reader.id, amount_cents: cents });
    charging = pay.id;
    const line = h('p', { role: 'status' }, h('strong', null, `Waiting for the card on ${reader.label}.`), ` Ask the guest to tap, insert or swipe for ${money(cents)}.`);
    const stop = button('Cancel', async () => {
      let st;
      try { st = await post(`/terminal/payments/${pay.id}/cancel`, {}); } catch (err) { readerBox.append(errorBox(err)); return; }
      charging = null; clear(readerBox).append(h('p', { class: 'muted' }, st && st.status === 'refunded' ? `The card had already gone through, so ${money(st.amount_cents)} was refunded to it.` : 'Stopped. Nothing was charged.'));
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
        took(st);
      } else if (st.status === 'failed') {
        clear(readerBox).append(errorBox(new Error(`${st.failure || 'The card was not accepted.'} Try again, or take another payment.`)));
      } else {
        clear(readerBox).append(h('p', { class: 'muted' }, 'The payment was canceled. Nothing was charged.'));
      }
      return;
    }
    if (charging === pay.id) {
      // Giving up: stop the payment, but a card that went through after all is kept for this sale, never lost or refunded.
      charging = null;
      let st;
      try { st = await post(`/terminal/payments/${pay.id}/cancel`, { keep_if_paid: true }); } catch (err) {
        clear(readerBox).append(errorBox(new Error(`The reader did not answer in 3 minutes, and the payment could not be stopped (${err.message}). Do not charge again until you have checked the reader. It also shows under Billing, Card readers.`)));
        return;
      }
      if (st.status === 'succeeded') { took(st); return; }
      clear(readerBox).append(errorBox(new Error('The reader did not answer in 3 minutes, so the payment was stopped and nothing was charged. Check it is on and online, then try again.')));
    }
  }
  /** A reader payment that went through: added to the sale's payments. */
  function took(st) {
    const p = { tender: 'card', amount_cents: st.amount_cents, terminal_payment_id: st.id, on_reader: true };
    if (st.card_last4) p.card_last4 = st.card_last4;
    if (st.card_brand && BRAND_OK.includes(st.card_brand)) p.card_brand = st.card_brand;
    payments.push(p); clear(readerBox); drawPayments();
    toast(`Card approved: ${money(st.amount_cents)}`);
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
      if (card.status !== 'active') throw new Error('That gift card has been canceled');
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
    h('div', { class: 'spread' }, h('div', { class: 'muted' }, [quote.discount_cents ? `Discount ${money(quote.discount_cents)}` : '', quote.tax_cents ? `${quote.discount_cents ? ' · ' : ''}Tax ${money(quote.tax_cents)}` : ''].join('')), totalEl),
    typeNote,
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
    for (const s of slots) {
      if (!needsLimits(s) || limitsOk.get(s)) continue;
      const who = (everyone().find((e) => e.id === assign.get(s)) || {}).name || 'each rider';
      return `Confirm that ${who} meets the limits for ${s.line.attraction.name}. ${s.line.attraction.limits_text}`;
    }
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
      if (l.type === 'lesson' && mine.length && safety.has(mine[0])) { const v = safety.get(mine[0]).f.value(); l.safety = Object.keys(v).length ? v : undefined; }
      if (l.type === 'ticket') return lineApi(l, null, mine.map((s) => assign.get(s)));
      const who = mine.length ? assign.get(mine[0]) : null;
      return lineApi(l, who && who !== 'customer' ? who : null, null, mine.length ? limitsOk.get(mine[0]) : false);
    });
    return body;
  }

  /**
   * The sale as it stands, checked by the server before any money is taken: who it is for, guardians, waivers, a
   * rider's limits and age, places left and gear. A refusal shows here, not after the guest has paid.
   */
  async function check() { return post('/checkout/check', build()); }

  async function finish() {
    clear(step2Error);
    complete.disabled = true;
    try {
      const out = await post('/checkout', build());
      sold = true;
      receipt(out);
      onSold(out);
      // gear fitted here went straight out: the shop's deposit step runs for each contract
      const outNow = (out.rentals || []).filter((r) => r.status === 'out');
      if (outNow.length) {
        const [{ depositStep }, settings] = await Promise.all([import('./rentals-deposit.js'), get('/rentals/fit/settings')]);
        for (const r of outNow) await depositStep({ id: r.contract_id, ...r }, settings);
      }
    } catch (err) {
      step2Error.append(errorBox(err));
      complete.disabled = remaining() !== 0;
    }
  }

  // ---- step 0, a basket that needs no name: quick sale first, the guest's details a tap away
  const quickText = basket.some((l) => l.type === 'gift_card') && basket.every((l) => l.type === 'gift_card') ? 'Gift cards need no name: the code is the card.' : 'Day tickets need no name. Nothing is saved about the guest.';
  const step0 = h('div', { class: 'stack', 'data-quick': '' },
    h('h3', null, 'Quick sale'),
    h('p', { class: 'muted' }, `${quickText} Add guest details to put the sale on a customer record instead.`),
    h('ul', { class: 'plain quick-lines' }, basket.map((l) => h('li', null, h('strong', null, l.quantity > 1 ? `${l.quantity} x ${l.name}` : l.name), h('small', { class: 'muted' }, ` ${l.detail || ''}`)))),
    step0Error);
  const toPayment = async (asQuick) => {
    const errs = asQuick ? step0Error : step1Error;
    clear(errs);
    quick = asQuick;
    if (!asQuick) { const p = problems(); if (p) { errs.append(errorBox(new Error(p))); return; } }
    let r;
    try { r = await check(); } catch (err) { errs.append(errorBox(err)); return; }
    // a guest's type follows them (a child on the lesson is a child on the rental): the total may have changed
    if (r && typeof r.total_cents === 'number' && r.total_cents !== total) total = r.total_cents;
    clear(totalEl).append(`Total ${money(total)}`);
    clear(typeNote);
    if (r && (r.type_changes || []).length) typeNote.append(h('div', { class: 'notice', role: 'status' }, r.type_changes.map((c) => h('div', null, `${c.name}: the ${label(c.line)} is priced as ${typeName(c.to)}, the same as their other items.`))));
    show(2); drawPayments();
  };

  function show(n) {
    clear(dlgBody).append(n === 0 ? step0 : n === 1 ? step1 : step2);
    clear(nav);
    if (n === 0) {
      quick = true;
      appendAll(nav, button('Cancel', () => dlg.close()),
        button('Add guest details', () => show(1)),
        button(total ? 'Next: payment' : 'Next', () => toPayment(true), { kind: 'primary' }));
    } else if (n === 1) {
      quick = false;
      appendAll(nav, button('Cancel', () => dlg.close()),
        quickOk ? button('Quick sale: no name', () => show(0), { kind: null }) : null,
        button(total ? 'Next: payment' : 'Next', () => toPayment(false), { kind: 'primary' }));
    } else {
      nav.append(button('Back', () => show(quick ? 0 : 1)), complete);
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
      codes(out.tickets.map((t) => h('div', { class: 'code' }, t.code, h('small', null, [t.holder, t.product, typeName(t.tier), t.valid_from === t.valid_to ? t.valid_from : `${t.valid_from} to ${t.valid_to}`].filter(Boolean).join(', ')))), `${out.tickets.length} ticket${out.tickets.length === 1 ? '' : 's'}`),
      codes(out.gift_cards.map((g) => h('div', { class: 'code' }, g.code, h('small', null, `${money(g.amount_cents)}${g.recipient_name ? ` for ${g.recipient_name}` : ''}`))), 'Gift cards (give the guest the code)'),
      out.lessons.length ? h('section', { class: 'stack', 'data-lessons-booked': '' }, h('h3', null, 'Lessons booked'), h('ul', { class: 'plain' }, out.lessons.map((l) => h('li', null,
        h('strong', null, l.student || 'Student'), `: ${l.name}, ${fmtDateTime(l.starts_at)}${l.ends_at ? ` to ${fmtTime(l.ends_at)}` : ''}`, l.meeting_place ? `. Meet at ${l.meeting_place}` : '', l.instructor_first ? ` with ${l.instructor_first}` : '', '.')))) : null,
      out.rentals.some((r) => r.status !== 'to_fit') ? h('section', { class: 'stack' }, h('h3', null, 'Gear out'), h('ul', { class: 'plain' }, out.rentals.filter((r) => r.status !== 'to_fit').map((r) => h('li', null, `${r.items.join(', ')}, due back ${fmtDateTime(r.due_at)}`)))) : null,
      out.rentals.some((r) => r.status === 'to_fit') ? h('section', { class: 'stack' }, h('h3', null, 'Ready to fit'), h('p', null, `${out.rentals.filter((r) => r.status === 'to_fit').length} rental${out.rentals.filter((r) => r.status === 'to_fit').length === 1 ? '' : 's'} paid. Send the guest to the rental shop with the receipt.`)) : null,
      out.programs.length ? h('section', { class: 'stack' }, h('h3', null, 'Program places'), h('ul', { class: 'plain' }, out.programs.map((p) => h('li', null, p.name)))) : null,
      out.activities && out.activities.length ? h('section', { class: 'stack' }, h('h3', null, 'Activities booked'), h('ul', { class: 'plain' }, out.activities.map((a) => h('li', null, `${a.holder}: ${a.product} at ${a.attraction}, ${a.date}${a.start_time ? `, ${clock12(a.start_time)} to ${clock12(a.end_time)}` : ', all day'}`))), h('p', { class: 'muted small' }, 'Each ticket lets one guest in once, at that attraction, from 15 minutes before the time.')) : null);
    nav.append(button('New sale', () => dlg.close(), { kind: 'primary' }));
  }

  // Closed without completing the sale: a card already charged on the reader goes back to the guest.
  const onClose = () => {
    charging = null;
    if (sold) return;
    // Returned so sign-out can wait for the refund before the page starts again.
    return Promise.all(payments.filter((x) => x.on_reader).map((p) => giveBack(p).catch(() => toast('A card reader payment could not be refunded. A manager can refund it under Billing, Card readers.', 'error'))));
  };
  dlg = dialog('Checkout', h('div', { class: 'stack' }, dlgBody, nav), { wide: true, onClose });
  show(quickOk ? 0 : 1);
  return dlg;
}

export { state };
