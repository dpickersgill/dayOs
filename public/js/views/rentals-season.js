// Season rentals: buying the gear out at the end of a season rental, and the return-side settings (the season return
// date and how deposits are taken), shown as their own block on Settings, Rentals.
import { get, put, post } from '../api.js';
import { h, field, input, select, button, toast, formDialog, money, toCents, centsToInput, label } from '../ui.js';

/** Buy out (managers): the renter keeps the gear. The price of each piece starts at half what it cost the shop. */
export async function buyoutDialog(contract, done) {
  const q = await get(`/rentals/contracts/${contract.id}/buyout`);
  if (!q.items.length) throw new Error('Nothing is still out on this rental');
  const rows = q.items.map((i) => {
    const keep = h('input', { type: 'checkbox', checked: true, 'aria-label': `Sell ${i.sku}` });
    const price = input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: i.suggested_cents == null ? '' : centsToInput(i.suggested_cents), 'aria-label': `Price for ${i.sku}`, class: 'fee-input' });
    return { i, keep, price, el: h('div', { class: 'buyout-row' }, h('label', { class: 'check' }, keep, h('span', null, h('strong', null, i.sku), ` ${label(i.category)}${i.size ? ` ${i.size}` : ''}`)),
      h('span', { class: 'row' }, price, h('span', { class: 'small muted' }, i.cost_cents ? `cost ${money(i.cost_cents)}` : 'cost not known'))) };
  });
  const total = h('p', { class: 'small', role: 'status' });
  const sum = () => { total.textContent = `Total ${money(rows.filter((r) => r.keep.checked).reduce((a, r) => a + (toCents(r.price.value) || 0), 0))}, added as a fee to collect.`; };
  rows.forEach((r) => { r.keep.addEventListener('change', sum); r.price.addEventListener('input', sum); });
  sum();
  const note = input({ name: 'note', maxlength: 150, placeholder: 'Optional, shown on the fee' });
  formDialog(`Buy out for ${contract.first_name} ${contract.last_name}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'The renter keeps the gear. Each piece is marked sold and comes off the rack. The price starts at half what it cost the shop, when that is known.'),
    ...rows.map((r) => r.el), total, field('Note', note)), async () => {
    const items = rows.filter((r) => r.keep.checked).map((r) => ({ rental_item_id: r.i.rental_item_id, cents: toCents(r.price.value) || 0 }));
    if (!items.length) throw new Error('Tick at least one piece');
    if (rows.some((r) => r.keep.checked && r.price.value === '')) throw new Error('Enter a price for each piece (0 is fine)');
    const r = await post(`/rentals/contracts/${contract.id}/buyout`, { items, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
    toast(`Sold. ${money(r.total_cents)} to collect${r.outstanding ? `, ${r.outstanding} still out` : ''}`);
    await done();
  }, { submitText: 'Sell the gear', wide: true });
}

/** The return side's settings (managers): how deposits are taken and when season rentals are due back. */
export async function drawReturnSettings(box) {
  const s = await get('/rentals/settings');
  const mode = select([['note', 'Note it (cash, an ID or a note)'], ['card', 'Hold it on the guest\'s card'], ['none', 'No deposit']], s.deposit_mode || 'note', { 'aria-label': 'How deposits are taken' });
  const [mm, dd] = String(s.season_return_md || '04-15').split('-');
  const month = select([['01', 'January'], ['02', 'February'], ['03', 'March'], ['04', 'April'], ['05', 'May'], ['06', 'June'], ['07', 'July'], ['08', 'August'], ['09', 'September'], ['10', 'October'], ['11', 'November'], ['12', 'December']], mm, { 'aria-label': 'Season return month' });
  const day = input({ type: 'number', min: '1', max: '31', value: String(Number(dd)), 'aria-label': 'Season return day', class: 'day-input' });
  const panel = h('section', { class: 'panel stack returns-settings', 'aria-labelledby': 'rs-head' },
    h('h3', { id: 'rs-head' }, 'Deposits and season rentals'),
    h('div', { class: 'form' },
      field('Deposits', mode, 'Card: the counter holds the deposit on the card reader after the gear goes out. A rental longer than a day and a half, or a season rental, saves the card instead. Needs Card payments and a card reader under Billing.'),
      h('fieldset', { class: 'field season-date' }, h('legend', null, 'Season rentals are due back on'), h('div', { class: 'row' }, month, day),
        h('span', { class: 'hint' }, 'Renters get a reminder by email in March, and another if they are late.'))),
    h('div', { class: 'row' }, button('Save', async () => {
      const md = `${month.value}-${String(Number(day.value) || 0).padStart(2, '0')}`;
      await put('/rentals/settings/returns', { deposit_mode: mode.value, season_return_md: md });
      toast('Saved');
    }, { kind: 'primary' })));
  box.append(panel);
  return panel;
}

