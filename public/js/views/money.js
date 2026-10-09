// Money (managers): the cash drawers, matching card payments to the processor's statement, files for the accountant,
// and the sales tax rates.
import { get, post, patch, del, download } from '../api.js';
import { h, clear, fail, money, toCents, table, state, input, select, field, button, toast, formDialog, confirmDialog, tabs, todayStr, addDays, fmtDateTime, fmtDate, label, empty, errorBox } from '../ui.js';
import { closeSheet } from './till.js';
import { printDialog } from '../print.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Money')),
    tabs([['drawers', 'Cash drawers', drawers], ['weekly', 'Weekly report', weekly], ['online', 'Online orders', onlineOrders], ['cards', 'Card statement', cards], ['exports', 'For the accountant', exports], ['tax', 'Sales tax', tax]], 'drawers'));
}

// ---------------------------------------------------------------- drawers
async function drawers(box) {
  const date = input({ type: 'date', value: todayStr(), 'aria-label': 'Day' });
  const list = h('div');
  async function load() {
    clear(list);
    const out = await get(`/till?date=${date.value}`);
    list.append(out.data.length ? table([
      { head: 'Cashier', cell: (t) => h('strong', null, t.email.split('@')[0]) },
      { head: 'Opened', cell: (t) => fmtDateTime(t.opened_at) },
      { head: 'Status', cell: (t) => state(t.status === 'open' ? 'Open' : 'Closed', t.status === 'open' ? 'warn' : 'good') },
      { head: 'Cash sales', num: true, cell: (t) => money(t.cash_sales_cents) },
      { head: 'Should be', num: true, cell: (t) => money(t.expected_cents) },
      { head: 'Counted', num: true, cell: (t) => (t.counted_cents === null || t.counted_cents === undefined ? '' : money(t.counted_cents)) },
      { head: 'Difference', num: true, cell: (t) => (t.variance_cents === null || t.variance_cents === undefined ? '' : h('span', { class: t.variance_cents === 0 ? '' : t.variance_cents > 0 ? 'variance-over' : 'variance-short' }, t.variance_cents === 0 ? 'Balanced' : `${t.variance_cents > 0 ? 'Over' : 'Short'} ${money(Math.abs(t.variance_cents))}`)) },
      { head: 'Note', cell: (t) => t.notes || '' },
      { head: '', actions: true, cell: (t) => button('Report', () => printDialog('Drawer report', closeSheet(t, t.email.split('@')[0])), { small: true }) },
    ], out.data) : empty('No drawers were opened on this day.'));
  }
  date.addEventListener('change', () => date.value && load().catch((e) => list.append(errorBox(e))));
  box.append(h('p', { class: 'muted' }, 'Each cashier opens a drawer with a starting float on the Sell screen and counts it at the end of the shift. A difference needs a note.'), h('div', { class: 'inline-form' }, field('Day', date)), list);
  await load();
}

// ---------------------------------------------------------------- weekly report
const TYPE = { ticket: 'Tickets and passes', lesson: 'Lessons', rental: 'Rentals', program: 'Programs', gift_card: 'Gift cards sold' };
const CHAN = { window: 'Ticket window', online: 'Online', phone: 'Phone', group: 'Groups' };
async function weekly(box) {
  let start = null; // null: last week
  const body = h('div', { class: 'stack' });
  const bar = h('div', { class: 'row' });
  const change = (p) => (p === null ? 'nothing to compare' : p === 0 ? 'same as the week before' : `${p > 0 ? 'Up' : 'Down'} ${Math.abs(p)}% on the week before`);
  async function load() {
    clear(body).append(h('p', { class: 'loading', role: 'status' }, 'Loading…'));
    const w = await get(`/reports/weekly${start ? `?week=${start}` : ''}`);
    start = w.week_start;
    const t = w.totals; const top = Math.max(1, ...w.days.map((d) => d.revenue_cents));
    clear(body).append(
      h('h3', null, `${fmtDate(w.week_start)} to ${fmtDate(w.week_end)}${w.complete ? '' : ' (so far)'}`),
      h('div', { class: 'figures' },
        h('div', { class: 'figure' }, h('strong', null, money(t.revenue_cents)), h('span', null, 'Sales'), h('em', null, change(w.change.revenue_pct))),
        h('div', { class: 'figure' }, h('strong', null, String(t.orders)), h('span', null, 'Orders'), h('em', null, change(w.change.orders_pct))),
        h('div', { class: 'figure' }, h('strong', null, String(t.guests)), h('span', null, 'Guests on the lifts'), h('em', null, change(w.change.guests_pct)))),
      h('p', { class: 'muted small' }, 'Sales are before tax and after refunds, the same as on the Today screen. Guests are tickets scanned at the gate, counted once per day.'),
      h('h3', null, 'Day by day'),
      h('ul', { class: 'bars week-bars' }, w.days.map((d) => h('li', null, h('span', null, fmtDate(d.date)), h('meter', { min: 0, max: top, value: d.revenue_cents, 'aria-label': `${fmtDate(d.date)} sales` }), h('span', null, `${money(d.revenue_cents)} · ${d.guests} guests`)))),
      h('div', { class: 'form' },
        h('div', null, h('h3', null, 'Sales by type'), w.types.length ? table([{ head: 'Type', cell: (x) => TYPE[x.kind] || label(x.kind) }, { head: 'Sales', num: true, cell: (x) => money(x.cents) }], w.types) : empty('No sales this week.'), h('p', { class: 'muted small' }, 'Before tax and refunds.')),
        h('div', null, h('h3', null, 'Where it was sold'), w.channels.length ? table([{ head: 'Where', cell: (x) => CHAN[x.channel] || label(x.channel) }, { head: 'Orders', num: true, cell: (x) => String(x.orders) }, { head: 'Total', num: true, cell: (x) => money(x.cents) }], w.channels) : empty('No sales this week.'), h('p', { class: 'muted small' }, `Online is ${w.online_share_pct}% of sales.`)),
        h('div', null, h('h3', null, 'Top sellers'), w.top_products.length ? table([{ head: 'Product', cell: (x) => x.name }, { head: 'Sold', num: true, cell: (x) => String(x.units) }], w.top_products) : empty('Nothing sold.'))),
      h('h3', null, 'Also this week'),
      h('ul', { class: 'bd-list' }, h('li', null, `New customers: ${w.new_customers} (${w.new_email_opt_ins} agreed to email)`), h('li', null, `Ski school: ${w.ski_school.sessions} lessons, ${w.ski_school.students} students`), h('li', null, `Patrol cases: ${w.patrol.incidents}`)),
      h('h3', null, 'Needs attention'),
      (() => { const a = w.attention; const items = [[a.overdue_rentals, a.overdue_rentals === 1 ? 'rental overdue' : 'rentals overdue'], [a.unfilled_shifts_next_7_days, a.unfilled_shifts_next_7_days === 1 ? 'shift with nobody assigned in the next 7 days' : 'shifts with nobody assigned in the next 7 days'], [a.season_passes_ending_14_days, a.season_passes_ending_14_days === 1 ? 'season pass ending within 14 days' : 'season passes ending within 14 days'], [a.open_incidents, a.open_incidents === 1 ? 'patrol case still open' : 'patrol cases still open']].filter((x) => x[0]);
        return items.length ? h('ul', { class: 'bd-list' }, items.map(([n, text]) => h('li', null, state(`${n} ${text}`, 'warn')))) : h('p', null, state('Nothing needs attention', 'good')); })());
  }
  const go = (n) => async () => { start = addDays(start, n); await load(); };
  bar.append(button('Earlier week', go(-7), { small: true }), button('Later week', go(7), { small: true }),
    button('Email me this report', async () => { try { const r = await post('/reports/weekly/email-me', { week: start }); toast(`Sent to ${r.to}`); } catch (e) { fail(e); } }, { small: true }));
  box.append(h('p', { class: 'muted' }, 'Last week in numbers. Owners and managers also get this by email every Monday morning (turn it off in Settings).'), bar, body);
  await load();
}

// ---------------------------------------------------------------- online orders
async function onlineOrders(box) {
  const out = await get('/online-shop/orders');
  const tone = { paid: 'good', awaiting_payment: 'warn', expired: 'neutral', refunded: 'neutral' };
  box.append(h('p', { class: 'muted' }, 'Tickets and passes bought on your online shop page. A paid order is already in your sales (Sell > Orders), with its tickets ready for the gate. Orders still waiting on the card page disappear after a couple of hours. To refund one, open it in Sell > Orders: the money goes back to the guest\'s card.'),
    out.data.length ? table([
      { head: 'When', cell: (o) => fmtDateTime(o.created_at) },
      { head: 'Guest', cell: (o) => [h('strong', null, o.contact_name), h('div', { class: 'muted small' }, o.contact_email)] },
      { head: 'Reference', cell: (o) => o.reference },
      { head: 'Tickets', num: true, cell: (o) => String(o.tickets) },
      { head: 'Total', num: true, cell: (o) => money(o.amount_cents) },
      { head: 'Status', cell: (o) => [state(label(o.status), tone[o.status] || 'neutral'), o.note ? h('div', { class: 'muted small' }, o.note) : null] },
      { head: '', actions: true, cell: (o) => (o.status === 'paid' ? button(o.emailed_at ? 'Send again' : 'Send tickets', async () => { try { await post(`/online-shop/orders/${o.id}/resend`, {}); toast('Sent'); } catch (e) { fail(e); } }, { small: true }) : null) },
    ], out.data) : empty('No online orders yet.'));
}

// ---------------------------------------------------------------- card statement
/** Splits one statement line on commas, tabs or semicolons, keeping quoted cells (such as "$1,234.50") whole. */
function splitLine(line) {
  const cells = [];
  let cur = ''; let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === '\t' || ch === ';')) { cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Reads pasted statement lines: a reference first and an amount (the last number on the line). Header lines are skipped. */
export function parseStatement(text) {
  const rows = [];
  const skipped = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = splitLine(line).filter((c) => c !== '');
    const amountCell = cells.length > 1 ? [...cells].reverse().find((c) => /^-?\$?\s?[\d,]*\.?\d+$/.test(c)) : undefined;
    const ref = cells[0];
    const cents = amountCell === undefined ? null : toCents(amountCell.replace(/^-/, '').replace(/\s/g, ''));
    if (!ref || cents === null || amountCell === ref) { skipped.push(line); continue; }
    rows.push({ reference: ref, amount_cents: amountCell.startsWith('-') ? -cents : cents });
  }
  return { rows, skipped };
}

async function cards(box) {
  const from = input({ type: 'date', value: todayStr(), 'aria-label': 'From' });
  const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const paste = h('textarea', { rows: 8, 'aria-label': 'Processor statement lines', placeholder: 'One line per payment:\nreference, amount\nAB12CD, 106.00', name: 'statement' });
  const out = h('div');
  const run = button('Compare', async () => {
    clear(out);
    const { rows, skipped } = parseStatement(paste.value);
    if (!rows.length) throw new Error('Paste the statement lines first: each line needs a reference and an amount');
    const r = await post('/reconcile/cards', { from: from.value, to: to.value, rows });
    out.append(h('div', { class: 'stack' },
      h('div', { class: 'figures' },
        fig(money(r.system_total_cents), 'card payments recorded here'), fig(money(r.processor_total_cents), 'on the statement'), fig(String(r.matched), 'matched', money(r.matched_cents))),
      skipped.length ? h('p', { class: 'muted small' }, `${skipped.length} line${skipped.length === 1 ? '' : 's'} could not be read and were skipped (headers are fine).`) : null,
      r.mismatched.length ? h('section', { class: 'section' }, h('header', null, h('h2', null, 'Different amounts')), table([
        { head: 'Order', cell: (m) => `#${m.order_id}` }, { head: 'Reference', cell: (m) => m.reference }, { head: 'Recorded', num: true, cell: (m) => money(m.our_cents) }, { head: 'Statement', num: true, cell: (m) => money(m.processor_cents) }], r.mismatched)) : null,
      r.only_in_system.length ? h('section', { class: 'section' }, h('header', null, h('h2', null, 'Recorded here, not on the statement')), table([
        { head: 'Order', cell: (m) => `#${m.order_id}` }, { head: 'Reference', cell: (m) => m.reference || '' }, { head: 'Amount', num: true, cell: (m) => money(m.amount_cents) }], r.only_in_system)) : null,
      r.only_in_file.length ? h('section', { class: 'section' }, h('header', null, h('h2', null, 'On the statement, not recorded here')), table([
        { head: 'Reference', cell: (m) => m.reference }, { head: 'Amount', num: true, cell: (m) => money(m.amount_cents) }], r.only_in_file)) : null,
      !r.mismatched.length && !r.only_in_system.length && !r.only_in_file.length ? h('div', { class: 'panel' }, state('Everything matches', 'good')) : null));
  }, { kind: 'primary' });
  box.append(h('p', { class: 'muted' }, 'Copy the payment lines from your card processor’s statement or report and paste them here. Each card payment is matched by its reference (or approval code) and amount. Fill in the reference or approval code when you take a card payment so it can be matched.'),
    h('div', { class: 'inline-form' }, field('From', from), field('To', to)), field('Statement lines', paste), h('div', { class: 'row' }, run), out);
}
const fig = (big, text, sub) => h('div', { class: 'figure' }, h('strong', null, big), h('span', null, text), sub ? h('em', null, sub) : null);

// ---------------------------------------------------------------- exports
function exports(box) {
  const to = input({ type: 'date', value: todayStr(), 'aria-label': 'To' });
  const from = input({ type: 'date', value: addDays(todayStr(), -30), 'aria-label': 'From' });
  const q = () => `from=${from.value}&to=${to.value}`;
  const dl = (kind, text, note) => h('div', { class: 'panel stack tight' }, h('strong', null, text), h('span', { class: 'muted small' }, note),
    h('div', { class: 'row' }, button('Download CSV', () => download(`/exports/${kind}.csv?${q()}`, `${kind}-${from.value}-to-${to.value}.csv`), { small: true })));
  box.append(h('p', { class: 'muted' }, 'Spreadsheet files (CSV) for your accountant or bookkeeping software. Opens in Excel, Numbers and Google Sheets. A year at most.'),
    h('div', { class: 'inline-form' }, field('From', from), field('To', to)),
    h('div', { class: 'stack' },
      dl('daily-summary', 'Daily summary', 'One row per day: sales, discounts, tax by rate, gift cards sold and spent, free-of-charge, refunds, and takings by payment type. Shaped for a journal entry.'),
      dl('sales', 'Sales detail', 'Every item sold: date, time, product, who it was for, price, discount, tax, who sold it and how it was paid.'),
      dl('payments', 'Payments', 'Every payment: cash, card (brand, last four, approval code), gift card and free-of-charge reasons.'),
      dl('refunds', 'Refunds', 'Every refund with the reason, the amount, the tax returned and how the money went back.')));
}

// ---------------------------------------------------------------- sales tax
const APPLIES = [['all', 'Everything'], ['ticket', 'Tickets and passes'], ['lesson', 'Lessons'], ['rental', 'Rentals'], ['program', 'Programs'], ['gift_card', 'Gift cards']];
async function tax(box) {
  async function load() {
    const { data } = await get('/tax-rules');
    clear(box).append(h('p', { class: 'muted' }, 'Sales tax is added on top of the price at checkout and shown on the receipt. Reports keep tax out of revenue. Past sales keep the tax they were charged. Ask your accountant which of your items are taxable and at what rate.'),
      h('div', { class: 'row' }, button('Add a tax rate', () => edit(null, load), { kind: 'primary', small: true })),
      data.length ? table([
        { head: 'Name', cell: (r) => h('strong', null, r.name) },
        { head: 'Applies to', cell: (r) => (APPLIES.find((a) => a[0] === r.applies_to) || [0, label(r.applies_to)])[1] },
        { head: 'Rate', num: true, cell: (r) => `${r.rate_percent}%` },
        { head: 'Status', cell: (r) => state(r.active ? 'On' : 'Off', r.active ? 'good' : 'neutral') },
        { head: '', actions: true, cell: (r) => [button('Edit', () => edit(r, load), { small: true }), button(r.active ? 'Turn off' : 'Turn on', async () => { await patch(`/tax-rules/${r.id}`, { active: !r.active }); await load(); }, { small: true }),
          button('Delete', () => confirmDialog('Delete this tax rate?', `${r.name} will no longer be added to new sales. Past sales are not changed.`, 'Delete', async () => { await del(`/tax-rules/${r.id}`); toast('Deleted'); await load(); }, { danger: true }), { small: true, kind: 'danger' })] },
      ], data) : empty('No sales tax is set up, so none is added at checkout.'));
  }
  await load();
}
function edit(r, done) {
  const f = h('div', { class: 'form' }, field('Name', input({ name: 'name', value: r ? r.name : '', required: true, maxlength: 80, placeholder: 'State sales tax' })),
    field('Applies to', select(APPLIES, r ? r.applies_to : 'all', { name: 'applies_to' })),
    field('Rate (%)', input({ name: 'rate', inputmode: 'decimal', value: r ? String(r.rate_percent) : '', required: true, placeholder: '6.5' })));
  formDialog(r ? `Edit ${r.name}` : 'Add a tax rate', f, async (fd) => {
    const rate = Number(String(fd.get('rate')).replace('%', ''));
    if (!Number.isFinite(rate) || rate < 0 || rate > 30) throw new Error('Enter the rate as a percentage between 0 and 30, for example 6.5');
    const body = { name: String(fd.get('name')).trim(), applies_to: fd.get('applies_to'), rate_percent: rate };
    if (r) await patch(`/tax-rules/${r.id}`, body); else await post('/tax-rules', body);
    toast('Saved');
    await done();
  });
}
