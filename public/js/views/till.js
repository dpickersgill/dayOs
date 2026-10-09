// The cash drawer: open it with a float, record cash paid in or out, count it at the end of the shift and close it.
// The system works out what should be in the drawer; the counter types what is really there. A difference needs a note.

import { get, post } from '../api.js';
import { h, clear, money, toCents, centsToInput, input, field, button, toast, dialog, formDialog, fmtDateTime, label, state, errorBox } from '../ui.js';
import { printDialog } from '../print.js';

const grid = (t) => h('div', { class: 'drawer-grid' },
  [['Opening float', t.opening_float_cents], ['Cash sales', t.cash_sales_cents], ['Cash refunds', -t.cash_refunds_cents], ['Paid in', t.paid_in_cents], ['Paid out', -t.payouts_cents], ['Dropped to safe', -t.drops_cents]]
    .map(([k, v]) => h('div', null, h('small', null, k), h('strong', null, money(v)))),
  h('div', { class: 'expected' }, h('small', null, 'Should be in the drawer'), h('strong', null, money(t.expected_cents))));

/** The end-of-shift sheet (a "Z report"): takings by tender, and the cash count against what was expected. */
export function closeSheet(t, who) {
  const row = (a, b) => h('div', { class: 'rc-row' }, h('span', null, a), h('span', null, b));
  return h('article', { class: 'sheet receipt-sheet', 'data-sheet': 'drawer-close' },
    h('header', { class: 'rc-head' }, h('strong', null, 'Drawer close'), h('div', null, who || '')),
    h('div', { class: 'rc-meta' }, `Opened ${fmtDateTime(t.opened_at)}`, h('br'), t.closed_at ? `Closed ${fmtDateTime(t.closed_at)}` : 'Still open'),
    h('div', { class: 'rc-lines' }, row('Orders', String(t.orders)), row('Sales (with tax)', money(t.sales_cents)), row('of which tax', money(t.tax_cents)),
      ...Object.entries(t.tenders).filter(([, v]) => v).map(([k, v]) => row(label(k), money(v))), t.refunds_cents ? row('Refunds', `-${money(t.refunds_cents)}`) : null),
    h('div', { class: 'rc-totals' }, row('Opening float', money(t.opening_float_cents)), row('Cash sales', money(t.cash_sales_cents)), t.paid_in_cents ? row('Paid in', money(t.paid_in_cents)) : null,
      t.payouts_cents ? row('Paid out', `-${money(t.payouts_cents)}`) : null, t.drops_cents ? row('Dropped to safe', `-${money(t.drops_cents)}`) : null, t.cash_refunds_cents ? row('Cash refunds', `-${money(t.cash_refunds_cents)}`) : null,
      row('Should be', money(t.expected_cents), 'rc-total'), t.counted_cents !== null && t.counted_cents !== undefined ? row('Counted', money(t.counted_cents)) : null,
      t.variance_cents !== null && t.variance_cents !== undefined ? row(t.variance_cents === 0 ? 'Balanced' : t.variance_cents > 0 ? 'Over' : 'Short', money(Math.abs(t.variance_cents))) : null),
    t.notes ? h('div', { class: 'rc-sub' }, `Note: ${t.notes}`) : null);
}

export async function drawerDialog(onChange) {
  const body = h('div', { class: 'stack' });
  const dlg = dialog('Cash drawer', body, { wide: true });
  async function draw() {
    clear(body);
    let till;
    try { till = (await get('/till/current')).till; } catch (err) { body.append(errorBox(err)); return; }
    if (!till) {
      const float = input({ name: 'float', inputmode: 'decimal', value: '0.00', 'aria-label': 'Cash in the drawer to start' });
      const err = h('div');
      body.append(h('p', null, 'Your drawer is closed. Count the cash you are starting with and open it. Cash sales, refunds and payouts are tracked from here.'),
        h('div', { class: 'form' }, field('Starting cash', float)), err,
        h('div', { class: 'row' }, button('Open drawer', async () => {
          clear(err);
          const cents = toCents(float.value);
          if (cents === null) { err.append(errorBox(new Error('Enter the starting cash, for example 200.00'))); return; }
          await post('/till/open', { opening_float_cents: cents });
          toast('Drawer open');
          if (onChange) onChange();
          await draw();
        }, { kind: 'primary' })));
      return;
    }
    body.append(h('p', { class: 'muted' }, `Open since ${fmtDateTime(till.opened_at)}. ${till.orders} order${till.orders === 1 ? '' : 's'}, ${money(till.sales_cents)} sold.`), grid(till),
      h('div', { class: 'row' },
        button('Cash paid in', () => move('paid_in', 'Cash paid in', draw), { small: true }),
        button('Cash paid out', () => move('payout', 'Cash paid out', draw), { small: true }),
        button('Drop to safe', () => move('drop', 'Drop to safe', draw), { small: true }),
        button('Count and close', () => closeIt(till, draw), { kind: 'primary', small: true })));
  }
  await draw();
  return dlg;
}

function move(kind, title, done) {
  const f = h('div', { class: 'form' }, field('Amount', input({ name: 'amount', inputmode: 'decimal', required: true })),
    field(kind === 'paid_in' ? 'Reason (optional)' : 'What was it for?', input({ name: 'reason', maxlength: 200, required: kind !== 'paid_in' })));
  formDialog(title, f, async (fd) => {
    const cents = toCents(fd.get('amount'));
    if (!cents) throw new Error('Enter an amount, for example 20.00');
    await post('/till/moves', { kind, amount_cents: cents, reason: String(fd.get('reason') || '').trim() || undefined });
    toast('Recorded');
    await done();
  });
}

function closeIt(till, done) {
  const counted = input({ name: 'counted', inputmode: 'decimal', required: true, 'aria-label': 'Cash counted' });
  const notes = h('textarea', { name: 'notes', rows: 2, maxlength: 500, 'aria-label': 'Note about any difference' });
  formDialog('Count and close the drawer', h('div', { class: 'stack' },
    h('p', null, 'Count all the cash in the drawer and type the total. The system compares it with what should be there.'),
    h('div', { class: 'form' }, field('Cash counted', counted), field('Note (needed if it does not match)', notes))),
  async () => {
    const cents = toCents(counted.value);
    if (cents === null) throw new Error('Enter the cash you counted, for example 412.50');
    const out = await post('/till/close', { counted_cents: cents, notes: notes.value.trim() || undefined });
    toast(out.till.variance_cents === 0 ? 'Drawer balanced and closed' : `Drawer closed, ${out.till.variance_cents > 0 ? 'over' : 'short'} ${money(Math.abs(out.till.variance_cents))}`);
    printDialog('Drawer close report', closeSheet(out.till));
    await done();
  }, { submitText: 'Close drawer' });
}

export { centsToInput, state };
