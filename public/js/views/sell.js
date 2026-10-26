// Sell: one menu for everything the mountain sells (tickets, lessons, rentals, program places, gift cards), one basket,
// and the customer's details added at the end. The gate scanner is its own page (gate.js).
import { loadTypes, saleOptions, typeName } from '../guesttypes.js';
import { get, post } from '../api.js';
import { h, clear, isManager, money, toCents, table, state, input, select, field, button, toast, dialog, formDialog, todayStr, fmtDate, fmtDateTime, label, empty, errorBox, tabs, fail, fmtTime, addDays } from '../ui.js';
import { loadCustomerForm } from './customer-form.js';
import { checkoutDialog, lineApi } from './sell-checkout.js';
import { drawerDialog } from './till.js';
import { printButtons } from '../print.js';
import { shareButton } from '../share.js';


// Whether this cashier has a drawer open, shown in the page header, so cash is always taken into a drawer that gets counted.
const drawer = { open: false, float: 0 };
const drawerBadge = h('span', { class: 'drawer-badge', role: 'status' });
async function loadDrawer() {
  try {
    const { till } = await get('/till/current');
    drawer.open = Boolean(till); drawer.float = till ? till.opening_float_cents : 0;
  } catch (_) { drawer.open = false; }
  clear(drawerBadge).append(drawer.open ? state(`Drawer open · float ${money(drawer.float)}`, 'good') : state('No cash drawer open', 'warn'));
}

export async function render(root, params = []) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Sell'), h('div', { class: 'row' }, drawerBadge, button('Cash drawer', () => drawerDialog(loadDrawer), { small: true }), h('a', { class: 'btn', href: '#/gate' }, 'Open the gate'))));
  await loadDrawer();
  const left = h('div', { class: 'stack sell-main' });
  const right = h('div', { class: 'stack' });
  root.append(h('div', { class: 'sell-grid' }, left, right));
  right.append(await sellPanel(left));
  // #/sell/order/12 (a shared link): open that order
  if (params[0] === 'order' && /^\d+$/.test(params[1] || '')) showOrder(Number(params[1])).catch((err) => toast(err.message || 'Could not open that order', 'error'));
}

// ---------------------------------------------------------------- selling
const ICON = { ticket: 'Ticket', lesson: 'Lesson', lesson_package: 'Lesson package', rental: 'Rental', program: 'Program', gift_card: 'Gift card' };

async function sellPanel(root) {
  const [menu, def, types] = await Promise.all([get('/checkout/menu'), loadCustomerForm(true), loadTypes()]);
  const { options: TIERS, first: FIRST } = saleOptions(types);
  const basket = [];
  const promoIn = input({ name: 'promo', autocapitalize: 'characters', placeholder: 'Promo code', 'aria-label': 'Promo code' });
  const basketBox = h('div', { class: 'stack', 'aria-live': 'polite' });
  const summary = h('div', { class: 'basket-summary', 'aria-live': 'polite' });
  const countBadge = h('span', { class: 'count', hidden: true });
  const quoteMsg = h('div');
  let quote = null;
  const tier = select(TIERS, FIRST, { name: 'tier', 'aria-label': 'Guest type' });
  const date = input({ type: 'date', value: menu.today, min: menu.today, name: 'date', 'aria-label': 'Valid on' });

  const same = (a, b) => a.type === b.type && (a.type === 'ticket' ? a.product_id === b.product_id && a.tier === b.tier && a.valid_on === b.valid_on : false);
  const add = (line) => {
    const existing = basket.find((b) => same(b, line));
    if (existing) existing.quantity += line.quantity || 1; else basket.push(line);
    return refresh();
  };
  const price = (p, t) => (p.tiers && p.tiers[t] !== undefined ? p.tiers[t] : p.base_price_cents);
  // A tap on a tile shows "Added" for a moment, so the cashier knows it landed even when the basket is off screen.
  const flash = (el) => { el.classList.add('added'); el.setAttribute('data-added', 'Added'); setTimeout(() => { el.classList.remove('added'); el.removeAttribute('data-added'); }, 700); };

  // ---- the menu
  const items = [
    ['tickets', 'Tickets', (b) => {
      if (!menu.tickets.length) { b.append(empty('No ticket products yet.', isManager() ? h('a', { class: 'btn primary', href: '#/catalog' }, 'Add a product') : null)); return; }
      const grid = h('div', { class: 'tiles' });
      const draw = () => {
        clear(grid);
        for (const p of menu.tickets) {
          const tile = h('button', { type: 'button', class: 'tile', 'data-product': p.id, onclick: () => { flash(tile); return add({ type: 'ticket', product_id: p.id, kind: p.kind, name: p.name, tier: tier.value, quantity: 1, valid_on: date.value, detail: `${tier.value}, ${date.value}` }); } },
            h('strong', null, p.name), h('small', { class: 'muted' }, p.uses ? `${p.uses} rides` : p.kind === 'season_pass' ? `Valid to ${fmtDate(addDays(date.value || menu.today, Math.max(p.valid_days, 1) - 1))}` : p.valid_days > 1 ? `${p.valid_days} days` : 'One day'), h('span', { class: 'tile-price' }, money(price(p, tier.value))));
          grid.append(tile);
        }
      };
      tier.addEventListener('change', draw);
      draw();
      b.append(h('div', { class: 'menu-tools' }, field('Valid on', date), field('Guest type', tier)), grid);
    }],
    ['lessons', 'Lessons', (b) => {
      if (!menu.lessons.length && !(menu.packages || []).length) { b.append(empty('No lessons are scheduled in the next two weeks.', isManager() ? h('a', { class: 'btn primary', href: '#/school' }, 'Schedule a lesson') : null)); return; }
      const t = select(TIERS, FIRST, { name: 'lesson-tier', 'aria-label': 'Student type' });
      b.append(h('div', { class: 'menu-tools' }, field('Student type', t)), table([
        { head: 'When', cell: (s) => fmtDateTime(s.starts_at) },
        { head: 'Lesson', cell: (s) => h('span', null, `${s.name}, ${label(s.discipline)}, ${label(s.ability_level)}`, s.format && s.format !== 'group' ? h('span', { class: 'muted' }, `  ${label(s.format)}`) : null, s.meeting_place ? h('div', { class: 'muted small' }, `Meet: ${s.meeting_place}`) : null) },
        { head: 'Spots', num: true, cell: (s) => (s.spots_left ? String(s.spots_left) : state('Full', 'bad')) },
        { head: 'Price', num: true, cell: (s) => money(s.base_price_cents) },
        { head: '', actions: true, cell: (s) => { const btn = button('Add', () => add({ type: 'lesson', session_id: s.id, name: s.name, tier: t.value, quantity: 1, detail: fmtDateTime(s.starts_at) }), { small: true }); btn.disabled = !s.spots_left; return btn; } },
      ], menu.lessons));
      if ((menu.packages || []).length) {
        b.append(h('h3', null, 'Lesson packages'), h('p', { class: 'muted small' }, 'Sold once, then spent one lesson at a time when the student is booked in (Ski school > Roster).'),
          h('div', { class: 'tiles' }, menu.packages.map((p) => h('button', { type: 'button', class: 'tile', 'data-package': p.id, onclick: () => add({ type: 'lesson_package', product_id: p.id, name: p.name, tier: t.value, quantity: 1, detail: `${p.uses} lessons` }) },
            h('strong', null, p.name), h('small', { class: 'muted' }, `${p.uses} lessons${p.valid_days > 1 ? `, valid ${p.valid_days} days` : ''}`), h('span', { class: 'tile-price' }, money(price(p, t.value)))))));
      }
    }],
    ['rentals', 'Rentals', (b) => {
      if (!menu.rentals.length) { b.append(empty('No rental packages yet. Add a product of type "rental", such as "Adult ski package".', isManager() ? h('a', { class: 'btn primary', href: '#/catalog' }, 'Add a package') : null)); return; }
      const t = select(TIERS, FIRST, { name: 'rental-tier', 'aria-label': 'Renter type' });
      const stock = Object.entries(menu.stock).map(([k, n]) => `${label(k)} ${n}`).join(', ');
      b.append(h('div', { class: 'menu-tools' }, field('Renter type', t)), h('p', { class: 'muted small' }, stock ? `Available now: ${stock}.` : 'No gear is available right now.'),
        h('div', { class: 'tiles' }, menu.rentals.map((p) => h('button', { type: 'button', class: 'tile', 'data-product': p.id, onclick: () => add({ type: 'rental', product_id: p.id, name: p.name, tier: t.value, quantity: 1, items: [], detail: `${t.value}, ${menu.today}${p.valid_days > 1 ? `, ${p.valid_days} days` : ''}` }) },
          h('strong', null, p.name), h('small', { class: 'muted' }, 'Gear is chosen at checkout'), h('span', { class: 'tile-price' }, money(price(p, t.value)))))));
    }],
    ['programs', 'Programs', (b) => {
      if (!menu.programs.length) { b.append(empty('No programs are open.', isManager() ? h('a', { class: 'btn primary', href: '#/programs' }, 'Add a program') : null)); return; }
      const simple = menu.programs.filter((p) => !(p.terms && p.terms.length));
      const sessioned = menu.programs.filter((p) => p.terms && p.terms.length);
      // A program run in sessions: pick the day for the session (or a day per session for a bundle), then Add.
      for (const p of sessioned) {
        // The child's answers change the price: ski or board, a season pass (no lift ticket part), rental, helmet.
        const discs = String(p.disciplines || 'ski,snowboard').split(',');
        const disc = select(discs.map((d) => [d, label(d)]), discs[0], { 'aria-label': `${p.name}: ski or snowboard` });
        const passCb = h('input', { type: 'checkbox' }); const rentCb = h('input', { type: 'checkbox' }); const helmCb = h('input', { type: 'checkbox' });
        const answers = () => ({ discipline: disc.value, ...(p.includes_ticket ? { has_pass: passCb.checked } : {}), ...(p.includes_rental ? { needs_rental: rentCb.checked } : {}), ...(p.offers_helmet ? { needs_helmet: helmCb.checked } : {}) });
        const answerText = () => [label(disc.value), p.includes_ticket && passCb.checked ? 'has a season pass' : null, p.includes_rental && rentCb.checked ? 'rental' : null, p.offers_helmet && helmCb.checked ? 'helmet' : null].filter(Boolean).join(', ');
        const answerRow = h('div', { class: 'row tight prog-answers' }, discs.length > 1 ? disc : null,
          p.includes_ticket ? h('label', { class: 'check' }, passCb, ' Has a season pass') : null,
          p.includes_rental ? h('label', { class: 'check' }, rentCb, ' Rental') : null,
          p.offers_helmet ? h('label', { class: 'check' }, helmCb, ' Helmet') : null);
        const dayPick = (t) => select(t.groups.map((g) => [g.id, `${g.day}s, ${money(g.price_cents)}${g.left === 0 ? ' (full)' : g.left != null ? ` (${g.left} left)` : ''}`]), '', { 'aria-label': `Day for ${t.name}` });
        const rowsEl = p.terms.map((t) => {
          const pick = dayPick(t);
          return h('div', { class: 'spread prog-sell' }, h('span', null, h('b', null, t.name), t.status === 'draft' ? h('span', { class: 'muted small' }, ' (not on sale online yet)') : null), h('div', { class: 'row' }, pick,
            button('Add', () => {
              const g = t.groups.find((x) => x.id === Number(pick.value));
              if (g.left === 0) { toast(`${g.day}s are full. Add the child to the waitlist from Programs.`, 'error'); return; }
              add({ type: 'program', program_id: p.id, term_id: t.id, group_id: g.id, ...answers(), name: `${p.name}: ${t.name}`, quantity: 1, detail: `${g.day}s, ${answerText()}` });
            }, { small: true })));
        });
        const bundleEls = (p.bundles || []).map((bd) => {
          const picks = bd.term_ids.map((tid) => { const t = p.terms.find((x) => x.id === tid); return [t, dayPick(t)]; });
          return h('div', { class: 'spread prog-sell' }, h('span', null, h('b', null, bd.name), ` ${money(bd.price_cents)}`), h('div', { class: 'row' }, picks.map(([t, s]) => h('label', { class: 'small' }, `${t.name} `, s)),
            button('Add', () => add({ type: 'program', program_id: p.id, bundle_id: bd.id, groups: picks.map(([t, s]) => ({ term_id: t.id, group_id: Number(s.value) })), ...answers(), name: `${p.name}: ${bd.name}`, quantity: 1, detail: picks.map(([t, s]) => `${t.name} ${s.selectedOptions[0].textContent.split(',')[0]}`).join(', ') }), { small: true })));
        });
        b.append(h('section', { class: 'stack tight prog-sell-box' }, h('h3', null, p.name), answerRow, rowsEl, bundleEls));
      }
      if (simple.length) b.append(table([
        { head: 'Program', cell: (p) => `${p.name} (${p.season})` },
        { head: 'Places', num: true, cell: (p) => (p.spots_left === null ? 'Open' : p.spots_left ? String(p.spots_left) : state('Full', 'bad')) },
        { head: 'Price', num: true, cell: (p) => money(p.price_cents) },
        { head: '', actions: true, cell: (p) => (p.spots_left === 0 ? null : button('Add', () => add({ type: 'program', program_id: p.id, name: p.name, quantity: 1, detail: p.season }), { small: true })) },
      ], simple));
    }],
    ['gift', 'Gift cards', (b) => {
      const amt = input({ name: 'gift-amount', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Gift card amount' });
      const to = input({ name: 'gift-to', maxlength: 150, 'aria-label': 'Gift card for' });
      const msg = input({ name: 'gift-msg', maxlength: 300, 'aria-label': 'Gift card message' });
      const addGift = (cents) => {
        if (cents === null || cents < menu.gift_card.min_cents || cents > menu.gift_card.max_cents) throw new Error(`A gift card can be ${money(menu.gift_card.min_cents)} to ${money(menu.gift_card.max_cents)}`);
        return add({ type: 'gift_card', amount_cents: cents, name: 'Gift card', quantity: 1, recipient_name: to.value.trim() || undefined, message: msg.value.trim() || undefined, detail: to.value.trim() ? `for ${to.value.trim()}` : '' });
      };
      const addOther = button('Add gift card', () => addGift(toCents(amt.value)));
      addOther.disabled = true; // nothing to add until an amount is typed
      amt.addEventListener('input', () => { addOther.disabled = toCents(amt.value) === null; });
      b.append(h('div', { class: 'tiles' }, [2500, 5000, 10000].map((c) => h('button', { type: 'button', class: 'tile', onclick: () => addGift(c) }, h('strong', null, 'Gift card'), h('small', { class: 'muted' }, 'Any amount works'), h('span', { class: 'tile-price' }, money(c))))),
        h('div', { class: 'menu-tools' }, field('Other amount', amt), field('For (optional)', to), field('Message (optional)', msg)),
        h('div', { class: 'row' }, addOther));
    }],
  ];
  const menuBox = h('section', { class: 'card sell-menu' }, tabs(items, 'tickets'));

  // ---- the basket
  async function refresh() {
    clear(quoteMsg);
    quote = null;
    if (basket.length) {
      try {
        quote = await post('/checkout/quote', { promo_code: promoIn.value.trim() || undefined, lines: basket.map((l) => lineApi(l)) });
      } catch (err) { quoteMsg.append(errorBox(err)); }
    }
    drawBasket();
  }
  function drawBasket() {
    clear(basketBox);
    const count = basket.reduce((n, l) => n + (l.quantity || 1), 0);
    countBadge.textContent = count ? String(count) : '';
    countBadge.hidden = !count;
    summary.hidden = !basket.length || !quote;
    checkoutBtn.disabled = !basket.length;
    // The phone and tablet bar: what is in the basket and the way to checkout, always in reach.
    clear(mobileBar).append(h('span', null, count ? `${count} item${count === 1 ? '' : 's'}${quote ? ` · ${money(quote.total_cents)}` : ''}` : 'Basket empty'),
      h('button', { type: 'button', class: 'btn primary', disabled: !basket.length, onclick: () => checkoutBtn.click() }, 'Checkout'));
    mobileBar.hidden = !count;
    if (!basket.length) { basketBox.append(h('p', { class: 'basket-empty' }, 'The basket is empty. Choose something from the menu.')); return; }
    basketBox.append(h('ul', { class: 'basket' }, basket.map((l, i) => {
      const q = quote && quote.lines[i];
      return h('li', { class: 'basket-line', 'data-type': l.type },
        h('div', { class: 'basket-what' }, h('strong', null, l.name), h('div', { class: 'muted small' }, `${ICON[l.type]}${l.detail ? `, ${l.detail}` : ''}`)),
        h('span', { class: 'line-price' }, q ? money(q.line_cents) : ''),
        l.type === 'ticket' ? h('div', { class: 'qty' },
          button('−', () => { l.quantity -= 1; if (l.quantity < 1) basket.splice(i, 1); return refresh(); }, { small: true }),
          h('span', { 'aria-label': 'Quantity' }, String(l.quantity)),
          button('+', () => { l.quantity = Math.min(l.quantity + 1, 200); return refresh(); }, { small: true })) : h('span'),
        button('Remove', () => { basket.splice(i, 1); return refresh(); }, { small: true, kind: 'link' }));
    })));
    if (quote) {
      clear(summary);
      if (quote.discount_cents) {
        summary.append(h('div', { class: 'spread muted' }, h('span', null, 'Before discount'), h('span', null, money(quote.subtotal_cents))),
          h('div', { class: 'spread muted' }, h('span', null, 'Discount'), h('span', null, `−${money(quote.discount_cents)}`)));
      }
      for (const t of quote.taxes || []) summary.append(h('div', { class: 'spread muted' }, h('span', null, `${t.name} ${(t.rate_bps / 100).toFixed(t.rate_bps % 100 ? 2 : 0)}%`), h('span', null, money(t.amount_cents))));
      summary.append(h('div', { class: 'spread basket-total' }, h('span', null, 'Total'), h('span', null, money(quote.total_cents))));
    }
  }
  promoIn.addEventListener('change', refresh);

  const checkoutBtn = button('Checkout', () => {
    if (!basket.length) throw new Error('Add something to the basket first');
    if (!quote) throw new Error('Fix the problem shown in the basket first');
    checkoutDialog({ basket, quote, def, promo: promoIn.value.trim(), comp: menu.comp, waiverText: menu.waiver_text, quickSale: menu.quick_sale, drawerOpen: () => drawer.open, onOpenDrawer: (after) => drawerDialog(async () => { await loadDrawer(); after(); }), onSold: async () => {
      basket.length = 0; promoIn.value = ''; quote = null;
      drawBasket();
      try { Object.assign(menu, await get('/checkout/menu')); } catch (_) { /* the menu refreshes on the next visit */ }
      loadOrders();
    } });
  }, { kind: 'primary big' });

  const mobileBar = h('div', { class: 'mobile-basket-bar', hidden: true, role: 'region', 'aria-label': 'Basket' });
  root.append(menuBox, mobileBar);
  const applyPromo = button('Apply', () => refresh(), { small: true });
  const basketPanel = h('section', { class: 'card basket-panel' }, h('header', { class: 'basket-head' }, h('h2', null, 'Basket'), countBadge), basketBox, quoteMsg, summary,
    h('label', { class: 'promo-row' }, h('span', { class: 'small muted' }, 'Promo code'), h('span', { class: 'promo-input' }, promoIn, applyPromo)), checkoutBtn);
  drawBasket();
  const orders = h('section', { class: 'card' });
  root.append(orders);

  // ---- today's orders
  async function loadOrders() {
    try {
      const { data } = await get(`/orders?date=${todayStr()}`);
      clear(orders).append(h('header', { class: 'card-head' }, h('h2', null, 'Sold today'), h('span', { class: 'muted small' }, data.length ? `${data.length} order${data.length === 1 ? '' : 's'}, ${money(data.filter((o) => o.status === 'paid').reduce((n, o) => n + o.total_cents, 0))} including tax` : '')),
        data.length ? h('ul', { class: 'order-list' }, data.map((o) => h('li', { class: 'order-row' },
          h('span', { class: 'order-id' }, `#${o.id}`),
          h('span', { class: 'muted' }, fmtTime(o.created_at)),
          state(label(o.status), o.status === 'paid' ? 'good' : 'neutral'),
          h('strong', { class: 'order-total' }, money(o.total_cents)),
          h('span', { class: 'order-actions' }, button('Details', () => showOrder(o.id), { small: true }),
            o.status === 'paid' && isManager() ? button('Refund', () => refund(o, loadOrders), { small: true, kind: 'danger' }) : null)))) : empty('Nothing sold yet today.'));
    } catch (err) { clear(orders).append(errorBox(err)); }
  }
  await loadOrders();
  return basketPanel;
}

async function showOrder(id) {
  const o = await get(`/orders/${id}`);
  const box = h('div', { class: 'stack' });
  box.append(table([
    { head: 'Item', cell: (l) => [l.name, l.refunded_at ? h('small', { class: 'muted' }, ' (refunded)') : null] },
    { head: 'For', cell: (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') },
    { head: 'Qty', num: true, cell: (l) => String(l.quantity) },
    { head: 'Price', num: true, cell: (l) => money(l.unit_price_cents * l.quantity - (l.discount_cents || 0)) },
    { head: 'Tax', num: true, cell: (l) => (l.tax_cents ? money(l.tax_cents) : '') },
  ], o.lines));
  box.append(h('p', null, `Total ${money(o.total_cents)}${o.discount_cents ? ` (after ${money(o.discount_cents)} discount)` : ''}${o.tax_cents ? `, including ${money(o.tax_cents)} tax` : ''}. Paid by ${o.payments.length ? o.payments.map((p) => `${label(p.tender)} ${money(p.amount_cents)}${p.card_last4 ? ` (card ending ${p.card_last4})` : ''}${p.comp_reason ? ` (${label(p.comp_reason)})` : ''}`).join(', ') : 'no payment recorded'}.`));
  if (o.refunds.length) box.append(h('section', { class: 'section' }, h('header', null, h('h2', null, 'Refunds')), table([
    { head: 'When', cell: (r) => fmtDateTime(r.created_at) }, { head: 'Why', cell: (r) => [label(r.reason), r.note ? h('small', { class: 'muted' }, ` ${r.note}`) : null] },
    { head: 'Returned by', cell: (r) => [label(r.method), r.card_status === 'failed' ? h('div', { class: 'small', role: 'alert' }, state('Card refund not sent', 'bad'), ' ', isManager() ? button('Try again', async () => { try { await post(`/orders/${id}/refunds/${r.id}/retry`, {}); toast('Card refund sent'); } catch (e) { fail(e); } }, { small: true }) : null) : r.card_status === 'pending' ? h('div', { class: 'small muted' }, 'Card refund on its way') : null] },
    { head: 'Amount', num: true, cell: (r) => money(r.amount_cents) }], o.refunds)));
  box.append(h('div', { class: 'row' }, printButtons(id, { hasTickets: o.tickets.some((t) => t.status !== 'void') }), shareButton('order', id)));
  if (o.tickets.length) showTickets(box, { tickets: o.tickets.map((t) => ({ code: t.code, product: 'Ticket', valid_from: t.valid_from, valid_to: t.valid_to, status: t.status })) }, true);
  if (o.gift_cards.length) box.append(h('section', { class: 'section' }, h('header', null, h('h2', null, 'Gift cards')), h('div', { class: 'codes' }, o.gift_cards.map((g) => h('div', { class: 'code' }, g.code, h('small', null, `${money(g.initial_cents)}${g.recipient_name ? ` for ${g.recipient_name}` : ''}${g.status === 'void' ? ', canceled' : ''}`))))));
  if (o.status === 'paid' && isManager()) box.append(h('div', { class: 'row' }, button('Refund…', () => refund(o, null), { small: true, kind: 'danger' })));
  dialog(`Order #${id}`, box, { wide: true });
}

const REFUND_REASONS = ['customer_request', 'weather', 'injury', 'wrong_item', 'duplicate', 'staff_error', 'other'];
/** Refund all or part of an order. A reason is always recorded. Managers only. */
async function refund(o, done) {
  const full = await get(`/orders/${o.id}`);
  const open = full.lines.filter((l) => !l.refunded_at);
  const boxes = new Map(open.map((l) => [l.id, h('input', { type: 'checkbox', checked: true, 'aria-label': `Refund ${l.name}` })]));
  const reason = select(REFUND_REASONS.map((r) => [r, label(r)]), 'customer_request', { name: 'reason', 'aria-label': 'Why is this being refunded' });
  const note = input({ name: 'note', maxlength: 300, 'aria-label': 'Note' });
  // Any cash part comes out of a drawer, so that drawer's count stays right at closing.
  const paidCash = full.payments.some((p) => p.tender === 'cash');
  let drawers = [];
  if (paidCash) { try { drawers = (await get(`/till?date=${todayStr()}`)).data.filter((t) => t.status === 'open'); } catch (_) { drawers = []; } }
  const drawer = select([['', 'My own open drawer'], ...drawers.map((t) => [String(t.id), `${t.email.split('@')[0]}'s drawer`])], '', { name: 'till_id', 'aria-label': 'Cash comes out of' });
  const worth = h('p', { class: 'basket-total', role: 'status' });
  const total = () => open.filter((l) => boxes.get(l.id).checked).reduce((n, l) => n + (l.unit_price_cents * l.quantity - (l.discount_cents || 0) + (l.tax_cents || 0)), 0);
  const redraw = () => { worth.textContent = `Refund about ${money(total())}`; };
  for (const b of boxes.values()) b.addEventListener('change', redraw);
  redraw();
  const f = h('div', { class: 'stack' },
    h('p', null, `Order #${o.id}, ${money(full.total_cents)}. Choose what is being refunded. Tickets are voided, lesson and program places released and unspent gift cards canceled. Gear that is still out must be checked in first. The money goes back the way it was paid.`),
    h('div', { class: 'stack tight' }, open.map((l) => h('label', { class: 'check' }, boxes.get(l.id), ` ${l.name}${[l.first_name, l.last_name].filter(Boolean).length ? ` (${[l.first_name, l.last_name].filter(Boolean).join(' ')})` : ''}, ${money(l.unit_price_cents * l.quantity - (l.discount_cents || 0) + (l.tax_cents || 0))}`))),
    h('div', { class: 'form' }, field('Why', reason), field('Note (needed for "Other")', note), paidCash && drawers.length ? field('Cash comes out of', drawer) : null), worth);
  formDialog(`Refund order #${o.id}`, f, async () => {
    const ids = open.filter((l) => boxes.get(l.id).checked).map((l) => l.id);
    if (!ids.length) throw new Error('Choose at least one thing to refund');
    if (reason.value === 'other' && !note.value.trim()) throw new Error('Add a note saying why');
    const body = { reason: reason.value, note: note.value.trim() || undefined };
    if (ids.length !== open.length) body.item_ids = ids;
    if (drawer.value) body.till_id = Number(drawer.value);
    const out = await post(`/orders/${o.id}/refund`, body);
    toast(`Refunded ${money(out.amount_cents)}: ${out.returns.map((r) => `${money(r.amount_cents)} ${label(r.method)}`).join(', ')}${out.card_refund_failed ? '. The card refund could not be sent yet; it will be retried. Open the order to try again.' : ''}`, out.card_refund_failed ? 'error' : 'ok');
    if (done) await done();
  }, { submitText: 'Refund', wide: true });
}

function showTickets(box, out, append = false) {
  const sec = h('section', { class: 'section' }, h('header', null, h('h2', null, `${out.tickets.length} ticket${out.tickets.length === 1 ? '' : 's'}`), h('p', null, 'Give each guest their code or print it.')),
    h('div', { class: 'codes' }, out.tickets.map((t) => h('div', { class: 'code' }, t.code, h('small', null, [t.product, t.tier ? typeName(t.tier) : null, t.valid_from === t.valid_to ? fmtDate(t.valid_from) : `${fmtDate(t.valid_from)} to ${fmtDate(t.valid_to)}`, t.status && t.status !== 'active' ? label(t.status) : null].filter(Boolean).join(', '))))));
  if (append) box.append(sec); else clear(box).append(sec);
}
