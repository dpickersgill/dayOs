// The 20-second window (guests round 2, Track WINDOW): pieces of Sell.
// - findBox: one search box for a name, phone or email, or a scan: an order or confirmation (ORD-12), a ticket or pass,
//   a lesson check-in code (L345), an RFID card, a reward code, or a US driver's license read by a USB scanner (name and
//   date of birth only; the license number is never kept).
// - groupDialog: a typed number of tickets, the group price, and a roster pasted or read from a CSV file (names, ages).
// - changeDayDialog: move a dated ticket to another day, the same code; the difference paid or given back.
// - lineMode: line-busting on a phone: today's tickets as big buttons, a quantity, cash or the card reader, the receipt.
import { get, post, put, del } from '../api.js';
import { h, clear, money, toCents, centsToInput, state, input, select, field, button, toast, dialog, formDialog, fmtDate, fmtDay, label, errorBox, isManager, todayStr, addDays } from '../ui.js';
import { typeName, loadTypes, saleOptions } from '../guesttypes.js';
import { checkoutDialog, receiptSender } from './sell-checkout.js';
import { loadCustomerForm } from './customer-form.js';
import { welcomeCard } from './guest-card.js';

const KIND_TITLE = { order: 'Order', shop: 'Online order', ticket: 'Ticket or pass', lesson: 'Lesson', card: 'Card', reward: 'Reward', license: 'Driver\'s license', text: 'Search' };

/** "Sam Rivera, 9, child of Pat Rivera, last here Sat, Dec 12": what tells two people with the same name apart. */
export function apart(p) {
  return [p.age !== null && p.age !== undefined ? String(p.age) : null, p.guardian ? `child of ${p.guardian}` : null, p.last_visit ? `last here ${fmtDate(p.last_visit)}` : 'no visits yet', p.email || p.phone || null].filter(Boolean).join(', ');
}

// ---------------------------------------------------------------- scan to find
export function findBox({ onPerson, onLicense = null, onOrder = null, onReward = null, compact = false } = {}) {
  const box = h('input', { type: 'search', class: 'find-input', autocomplete: 'off', spellcheck: 'false', 'data-find': '',
    placeholder: compact ? 'Find a guest: name, phone or scan' : 'Name, phone, email, or scan an order, ticket, pass, card, reward or license', 'aria-label': 'Find a guest or scan a code' });
  const out = h('div', { class: 'find-results', 'aria-live': 'polite' });
  let timer; let seq = 0;
  async function run() {
    const q = box.value.trim();
    const mine = ++seq;
    if (q.length < 2) { clear(out); return; }
    let r;
    // a POST, so a scanned license never sits in a URL or a request log
    try { r = await post('/guests/find', { q }); } catch (err) { if (mine === seq) clear(out).append(errorBox(err)); return; }
    if (mine !== seq) return;
    clear(out);
    const pick = (p) => { clear(out); box.value = ''; onPerson(p); };
    if (r.kind !== 'text') out.append(h('p', { class: 'find-title' }, h('strong', null, KIND_TITLE[r.kind] || 'Found'), r.title ? `: ${r.title}` : ''));
    // a license is read for the name and date of birth only; the box is cleared so nothing else stays on screen
    if (r.kind === 'license') box.value = '';
    if (r.kind === 'license' && !r.people.length && onLicense) out.append(button(`New customer: ${r.license.first_name} ${r.license.last_name}${r.license.date_of_birth ? `, born ${fmtDay(r.license.date_of_birth)}` : ''}`, () => { clear(out); onLicense(r.license); }, { kind: 'primary' }));
    if (r.order_id && onOrder) out.append(button(`Open order #${r.order_id}`, () => onOrder(r.order_id), { small: true }));
    if (r.reward && onReward) out.append(r.reward.status === 'offered' ? button(`Use reward: ${r.reward.words}`, () => { clear(out); box.value = ''; onReward({ ...r.reward, person: r.people[0] ? r.people[0].first_name : null }); }, { small: true, kind: 'primary' }) : h('p', null, state(`This reward is ${r.reward.status === 'redeemed' ? 'already used' : label(r.reward.status)}`, 'warn')));
    if (!r.people.length && r.kind !== 'license') out.append(h('p', { class: 'muted small' }, r.kind === 'text' ? 'No one found. Check the spelling, or type their details at checkout.' : 'Nothing on file matches that code.'));
    if (r.people.length) {
      out.append(h('ul', { class: 'plain find-people' }, r.people.map((p) => h('li', null, h('button', { type: 'button', class: 'picker-hit', 'data-person': p.id, onclick: () => pick(p) },
        h('span', { class: 'picker-name' }, `${p.first_name} ${p.last_name}`), h('span', { class: 'muted small picker-line' }, apart(p)))))));
      // a code that names one person picks them straight away
      if (r.kind !== 'text' && r.kind !== 'reward' && r.people.length === 1 && !r.order_id) pick(r.people[0]);
    }
  }
  box.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { box.value = ''; clear(out); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // A license scanner types Enter between the lines: keep them (as "|") until the scan stops, then look it up once.
    if (/^@|ANSI ?\d|AAMVA/.test(box.value)) { box.value += '|'; clearTimeout(timer); timer = setTimeout(run, 280); return; }
    clearTimeout(timer); run();
  });
  return h('section', { class: `card find-box${compact ? ' compact' : ''}`, role: 'search' }, compact ? null : h('label', { class: 'find-label', for: 'sell-find' }, 'Find a guest'), Object.assign(box, { id: compact ? 'line-find' : 'sell-find' }), out);
}

// ---------------------------------------------------------------- group sales
export async function groupDialog({ menu, tiers, first, day, add }) {
  const products = menu.tickets.filter((p) => p.kind !== 'season_pass');
  if (!products.length) throw new Error('No ticket products to sell to a group');
  let groupPrices = [];
  try { groupPrices = (await get('/guests/group-prices')).data; } catch (_) { groupPrices = []; }
  const prod = select(products.map((p) => [String(p.id), p.name]), String(products[0].id), { name: 'product', 'aria-label': 'Ticket' });
  const tier = select(tiers, first, { name: 'tier', 'aria-label': 'Guest type for anyone without an age' });
  const when = input({ type: 'date', name: 'day', value: day || menu.today, min: menu.today, 'aria-label': 'Day' });
  const count = input({ type: 'number', name: 'count', min: 1, max: 200, inputmode: 'numeric', value: '', placeholder: 'For example 24', 'aria-label': 'How many tickets' });
  const roster = h('textarea', { name: 'roster', rows: 5, placeholder: 'One a line: name, age\nAlex Kim, 9\nJo Park, 34', 'aria-label': 'Roster: names and ages' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', 'aria-label': 'Roster file (CSV)' });
  const priceNote = h('p', { class: 'muted small', role: 'status' });
  const rosterNote = h('div', { role: 'status' });
  let people = null;
  const gpFor = () => groupPrices.find((g) => String(g.product_id) === prod.value);
  const showPrice = () => {
    const g = gpFor(); const p = products.find((x) => String(x.id) === prod.value);
    priceNote.textContent = g ? `Group price: ${money(g.price_cents)} each from ${g.min_people} people (usually ${money(p.base_price_cents)}). A lower guest type price stays.` : 'No group price for this ticket. The usual prices apply.';
  };
  prod.addEventListener('change', showPrice); showPrice();
  file.addEventListener('change', async () => { const f = file.files && file.files[0]; if (f) { roster.value = (await f.text()).slice(0, 60000); await read(); } });
  async function read() {
    clear(rosterNote); people = null;
    if (!roster.value.trim()) return;
    try {
      const r = await post('/guests/roster', { text: roster.value });
      people = r.people;
      const byTier = people.reduce((m, p) => { const k = p.tier || tier.value; m[k] = (m[k] || 0) + 1; return m; }, {});
      rosterNote.append(h('p', { class: 'notice' }, `${people.length} name${people.length === 1 ? '' : 's'} read: ${Object.entries(byTier).map(([k, n]) => `${n} ${typeName(k)}`).join(', ')}.`));
      if (!count.value || Number(count.value) < people.length) count.value = String(people.length);
    } catch (err) { rosterNote.append(errorBox(err)); }
  }
  roster.addEventListener('change', read);
  const mgr = isManager() ? (() => {
    const minP = input({ type: 'number', min: 2, max: 500, name: 'min_people', placeholder: '10', 'aria-label': 'From how many people' });
    const priceIn = input({ name: 'group_price', inputmode: 'decimal', placeholder: '60.00', 'aria-label': 'Group price each' });
    return h('details', { class: 'more-details' }, h('summary', null, 'Set the group price (managers)'), h('div', { class: 'form' }, field('From how many people', minP), field('Price each', priceIn),
      h('div', { class: 'row wide' }, button('Save group price', async () => {
        const c = toCents(priceIn.value); const n = Number(minP.value);
        if (!n || n < 2) throw new Error('Enter how many people the group price starts at (2 or more)');
        if (c === null) throw new Error('Enter the price each');
        await put(`/guests/group-prices/${prod.value}`, { min_people: n, price_cents: c });
        groupPrices = (await get('/guests/group-prices')).data; showPrice(); toast('Group price saved');
      }, { small: true }), gpFor() ? button('Remove it', async () => { await del(`/guests/group-prices/${prod.value}`); groupPrices = (await get('/guests/group-prices')).data; showPrice(); toast('Group price removed'); }, { small: true, kind: 'link' }) : null)));
  })() : null;
  formDialog('Group sale', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Type how many, or paste the roster. One person pays. With a roster, each person gets a ticket with their name, priced by their age.'),
    h('div', { class: 'form' }, field('Ticket', prod), field('Day', when), field('How many', count), field('Guest type (no age given)', tier)), priceNote,
    field('Roster (optional): name, age', roster, 'Paste from a spreadsheet, or choose a CSV file.'), file, rosterNote, mgr), async () => {
    if (roster.value.trim() && !people) await read();
    const n = Math.floor(Number(count.value) || 0);
    const p = products.find((x) => String(x.id) === prod.value);
    const total = Math.max(n, people ? people.length : 0);
    if (!total || total > 200) throw new Error('Enter how many tickets (1 to 200)');
    const base = { type: 'ticket', product_id: p.id, kind: p.kind, name: p.name, valid_on: when.value };
    if (people && people.length) {
      const byTier = new Map();
      for (const r of people) { const k = r.tier || tier.value; if (!byTier.has(k)) byTier.set(k, []); byTier.get(k).push(r); }
      for (const [k, list] of byTier) add({ ...base, tier: k, quantity: list.length, roster: list, detail: `${typeName(k)}, ${fmtDate(when.value)}, ${list.length} named` });
      if (total > people.length) add({ ...base, tier: tier.value, quantity: total - people.length, detail: `${typeName(tier.value)}, ${fmtDate(when.value)}` });
    } else add({ ...base, tier: tier.value, quantity: total, detail: `${typeName(tier.value)}, ${fmtDate(when.value)}` });
    toast(`${total} ticket${total === 1 ? '' : 's'} in the basket`);
  }, { submitText: 'Add to basket', wide: true });
}

// ---------------------------------------------------------------- change day
export function changeDayDialog(ticket, done) {
  const day = input({ type: 'date', name: 'date', min: todayStr(), value: addDays(String(ticket.valid_from).slice(0, 10) > todayStr() ? String(ticket.valid_from).slice(0, 10) : todayStr(), 1), 'aria-label': 'New day' });
  const tender = select([['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']], 'cash', { name: 'tender', 'aria-label': 'How the difference is paid' });
  const reason = input({ name: 'over_limit_reason', maxlength: 300, 'aria-label': 'Why sell over the day limit' });
  const quoteBox = h('div', { role: 'status', 'aria-live': 'polite' });
  const payF = field('The difference is paid by', tender); payF.hidden = true;
  const reasonF = field('Reason to go over the day limit (managers)', reason); reasonF.hidden = true;
  let last = null;
  async function check() {
    clear(quoteBox); last = null;
    try {
      last = await post(`/guests/tickets/${ticket.code}/change-day`, { date: day.value, check: true });
      const words = last.owed_cents ? `The new day costs ${money(last.owed_cents)} more${last.tax_cents ? ' (with tax)' : ''}.` : last.back_cents ? `${money(last.back_cents)} goes back to the guest${last.tax_cents ? ' (with tax)' : ''}, the way they paid.` : 'Same price. Nothing to pay.';
      quoteBox.append(h('p', { class: 'basket-total' }, words), last.over_limit.length ? h('div', { class: 'notice warn', role: 'alert' }, last.over_limit.map((o) => o.words).join(' '), isManager() ? '' : ' Only a manager can sell over the limit.') : null);
      payF.hidden = !last.owed_cents; reasonF.hidden = !(last.over_limit.length && isManager());
    } catch (err) { quoteBox.append(errorBox(err)); }
  }
  day.addEventListener('change', check);
  check();
  formDialog(`Change day: ${fmtDay(String(ticket.valid_from).slice(0, 10))}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, `Ticket ${ticket.code}. It keeps the same code. The guest gets an email with the new day.`),
    h('div', { class: 'form' }, field('New day', day), payF, reasonF), quoteBox), async () => {
    if (!last || last.ticket.to !== day.value) await check();
    if (!last) throw new Error('Pick a day that can be sold');
    const body = { date: day.value, ...(last.owed_cents ? { payment: { tender: tender.value } } : {}), ...(reason.value.trim() ? { over_limit_reason: reason.value.trim() } : {}) };
    const r = await post(`/guests/tickets/${ticket.code}/change-day`, body);
    toast(`Moved to ${fmtDay(r.ticket.to)}${r.owed_cents ? `. Took ${money(r.owed_cents)}` : r.back_cents ? `. ${money(r.back_cents)} back by ${label(r.back_method)}` : ''}${r.emailed ? '. Email sent.' : '.'}`);
    if (done) await done();
  }, { submitText: 'Move the ticket' });
}

// ---------------------------------------------------------------- Line mode
/**
 * Line-busting on a phone: the guest type, today's ticket products as big buttons, how many, then cash (one tap, the
 * exact amount) or the card reader. Anyone found in the search box gets the sale; otherwise a quick sale with no name.
 * After: the codes, the receipt by email or text, and loading the ticket on an RFID card when the mountain uses them.
 */
export async function lineMode(root, { drawerOpen, onOpenDrawer }) {
  const [menu, types, def] = await Promise.all([get('/checkout/menu'), loadTypes(), loadCustomerForm(true)]);
  const { options: TIERS, first: FIRST } = saleOptions(types);
  let hasCards = false;
  try { hasCards = ((await get('/access/cards?limit=1')).data || []).length > 0; } catch (_) { hasCards = false; }
  const products = menu.tickets.filter((p) => p.kind === 'day_ticket' || p.kind === 'multi_day' || p.kind === 'punch_card');
  let tier = FIRST; let qty = 1; let guest = null;
  const screen = h('div', { class: 'line-mode stack', 'data-line-mode': '' });
  root.append(screen);
  const guestEl = h('div');
  const finder = findBox({ compact: true, onPerson: (p) => { guest = { person: p }; drawGuest(); }, onLicense: (d) => { guest = { details: d }; drawGuest(); } });
  function drawGuest() {
    clear(guestEl);
    if (!guest) return;
    guestEl.append(h('div', { class: 'spread' }, h('strong', null, guest.person ? `${guest.person.first_name} ${guest.person.last_name}` : `${guest.details.first_name} ${guest.details.last_name} (new)`),
      button('No name', () => { guest = null; drawGuest(); }, { small: true, kind: 'link', label: 'Sell without a name' })), guest.person ? welcomeCard(guest.person.id, { compact: true }) : null);
  }
  const tierRow = h('div', { class: 'seg line-tiers', role: 'group', 'aria-label': 'Guest type' });
  const drawTiers = () => { clear(tierRow).append(...TIERS.map(([k, t]) => h('button', { type: 'button', class: 'btn', 'aria-pressed': String(k === tier), onclick: () => { tier = k; drawTiers(); drawTiles(); } }, t))); };
  const qtyIn = h('input', { type: 'number', class: 'qty-input line-qty', min: 1, max: 200, inputmode: 'numeric', value: '1', 'aria-label': 'How many' });
  qtyIn.addEventListener('change', () => { qty = Math.min(Math.max(Math.floor(Number(qtyIn.value) || 1), 1), 200); qtyIn.value = String(qty); drawTiles(); });
  const qtyRow = h('div', { class: 'row line-qty-row' }, h('span', null, 'How many'), button('−', () => { qty = Math.max(qty - 1, 1); qtyIn.value = String(qty); drawTiles(); }, { label: 'One fewer' }), qtyIn, button('+', () => { qty = Math.min(qty + 1, 200); qtyIn.value = String(qty); drawTiles(); }, { label: 'One more' }));
  const tiles = h('div', { class: 'line-tiles', role: 'group', 'aria-label': 'Tickets for today' });
  const msg = h('div', { role: 'status', 'aria-live': 'polite' });
  const price = (p) => (p.tiers && p.tiers[tier] !== undefined ? p.tiers[tier] : p.base_price_cents);
  let chosen = null;
  function drawTiles() {
    clear(tiles);
    if (!products.length) { tiles.append(h('p', { class: 'muted' }, 'No day tickets on sale.')); return; }
    for (const p of products) {
      tiles.append(h('button', { type: 'button', class: 'line-tile', 'aria-pressed': String(chosen === p.id), 'data-product': p.id, onclick: () => { chosen = p.id; drawTiles(); drawPay(); } },
        h('strong', null, p.name), h('span', { class: 'tile-price' }, `${qty > 1 ? `${qty} x ` : ''}${money(price(p))}`)));
    }
  }
  const pay = h('div', { class: 'line-pay' });
  const basketOf = () => { const p = products.find((x) => x.id === chosen); return [{ type: 'ticket', product_id: p.id, kind: p.kind, name: p.name, tier, quantity: qty, valid_on: menu.today, detail: `${typeName(tier)}, today` }]; };
  async function drawPay() {
    clear(pay); clear(msg);
    if (!chosen) return;
    let quote;
    try { quote = await post('/checkout/quote', { lines: basketOf().map((l) => ({ type: 'ticket', product_id: l.product_id, tier: l.tier, quantity: l.quantity, valid_on: l.valid_on })) }); } catch (err) { msg.append(errorBox(err)); return; }
    if ((quote.over_limit || []).length) { msg.append(h('div', { class: 'notice warn', role: 'alert' }, quote.over_limit.map((o) => o.words).join(' '), ' Use the full Sell screen.')); return; }
    const quickOk = menu.quick_sale.allowed && !guest;
    const open = (way) => checkoutDialog({ basket: basketOf(), quote, def, promo: '', comp: menu.comp, waiverText: menu.waiver_text, quickSale: menu.quick_sale, drawerOpen, onOpenDrawer, guest, receiptBy: true, startPay: way, onSold: (out) => done(out) });
    setTimeout(() => pay.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
    pay.append(h('p', { class: 'basket-total' }, `Total ${money(quote.total_cents)}`),
      h('div', { class: 'line-pay-buttons' },
        button(`Cash, exact ${money(quote.total_cents)}`, async () => {
          if (!quickOk) { open('cash'); return; }
          if (!drawerOpen()) { onOpenDrawer(() => drawPay()); throw new Error('Open your cash drawer first'); }
          const out = await post('/checkout', { channel: 'window', quick: true, lines: basketOf().map((l) => ({ type: 'ticket', product_id: l.product_id, tier: l.tier, quantity: l.quantity, valid_on: l.valid_on })), payments: quote.total_cents ? [{ tender: 'cash', amount_cents: quote.total_cents }] : [] });
          done(out);
        }, { kind: 'primary big' }),
        button('Card', () => open('card'), { kind: 'primary big' }),
        button('More ways', () => open(null), { kind: 'big' })));
  }
  function done(out) {
    clear(pay); chosen = null; drawTiles();
    clear(msg).append(h('section', { class: 'card stack line-done', 'data-line-done': '' },
      h('div', { class: 'receipt-head' }, h('strong', null, `Sold ${money(out.total_cents)}`), h('span', { class: 'muted' }, ` Order #${out.id}`)),
      h('div', { class: 'codes' }, out.tickets.map((t) => h('div', { class: 'code' }, t.code, h('small', null, [t.holder, t.product, typeName(t.tier)].filter(Boolean).join(', '))))),
      receiptSender(out, guest && guest.person ? guest.person.email || '' : ''),
      hasCards ? h('div', { class: 'row' }, out.tickets.map((t) => button(`Load on a card${out.tickets.length > 1 ? `: ${t.code.slice(-6)}` : ''}`, () => loadCard(t.code), { small: true }))) : null,
      h('div', { class: 'row' }, button('Next guest', () => { clear(msg); guest = null; drawGuest(); qty = 1; qtyIn.value = '1'; screen.scrollIntoView({ block: 'start' }); }, { kind: 'primary' }))));
    msg.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  function loadCard(code) {
    const uid = input({ name: 'uid', autocomplete: 'off', 'aria-label': 'Card (tap it on the reader or type the number)' });
    formDialog('Load on a card', h('div', { class: 'form' }, field('Tap the card on the reader', uid, 'Or type the number on the back.')), async () => {
      if (!uid.value.trim()) throw new Error('Tap the card or type its number');
      await post('/access/cards/assign', { ticket_code: code, uid: uid.value.trim() });
      toast('Card loaded. Straight to the lift.');
    }, { submitText: 'Load it' });
    setTimeout(() => uid.focus(), 50);
  }
  drawTiers(); drawTiles();
  screen.append(h('p', { class: 'muted small' }, `Today, ${fmtDay(menu.today)}. Pick the guest type and the ticket, then how they pay.`),
    finder, guestEl, tierRow, qtyRow, tiles, pay, msg);
}
