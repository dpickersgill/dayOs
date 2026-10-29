// The return side of the rental shop: the Returns tab (one scan box: each gear tag scanned is checked in at once) and
// Out now (search and filters), with check in, extend, swap, fees and the card deposit. Built for the 3:30 to 4:30
// rush with a USB scanner: the scan box keeps the focus, every scan is handled in order, and one tap marks damage.
import { get, post } from '../api.js';
import { h, clear, isManager, table, state, input, select, field, button, toast, formDialog, dialog, val, num, fmtDateTime, label, empty, money, toCents, centsToInput } from '../ui.js';
import { depositBadge, confirmTake, releaseDeposit, depositStep } from './rentals-deposit.js';
import { buyoutDialog } from './rentals-season.js';

const gearName = (i) => [i.brand, i.model, i.size].filter(Boolean).join(' ');
const who = (c) => `${c.first_name} ${c.last_name}`;
const pieceText = (i) => `${i.sku} ${label(i.category)}${gearName(i) ? ` ${gearName(i)}` : ''}`;

// ---------------------------------------------------------------- Returns tab
export async function drawReturns(box) {
  let damagedNext = false;
  let queue = Promise.resolve();
  const results = h('div', { class: 'stack return-results', 'aria-live': 'polite' });
  const scan = input({ type: 'text', class: 'return-scan', placeholder: 'Scan a gear tag', 'aria-label': 'Scan a gear tag or type a contract number, then press Enter', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  const fine = h('button', { type: 'button', class: 'chip on', 'aria-pressed': 'true' }, 'Back fine');
  const damaged = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, 'Next one is damaged');
  const setMode = (d) => {
    damagedNext = d;
    fine.classList.toggle('on', !d); fine.setAttribute('aria-pressed', String(!d));
    damaged.classList.toggle('on', d); damaged.setAttribute('aria-pressed', String(d));
    scan.placeholder = d ? 'Scan the damaged piece' : 'Scan a gear tag';
    scan.focus();
  };
  fine.addEventListener('click', () => setMode(false));
  damaged.addEventListener('click', () => setMode(true));
  const flash = (kind) => { scan.classList.remove('ok', 'bad'); void scan.offsetWidth; scan.classList.add(kind); };

  async function handle(code, extra = {}) {
    try {
      const r = await post('/rentals/returns/scan', { code, ...extra });
      flash('ok');
      show(r);
    } catch (err) {
      flash('bad');
      const empty0 = results.querySelector('.return-empty'); if (empty0) empty0.remove();
      results.prepend(h('div', { class: 'return-card error-box', role: 'alert' }, h('strong', null, code), `: ${err.message}`));
      trim();
    }
  }
  function trim() { while (results.children.length > 8) results.lastChild.remove(); }
  function show(r) {
    // one card per contract: a newer scan on the same contract replaces the older card
    for (const old of [...results.querySelectorAll(`.return-card[data-contract="${r.contract.id}"]`)]) old.remove();
    const empty0 = results.querySelector('.return-empty'); if (empty0) empty0.remove();
    const card = h('div', { class: `return-card panel${r.closed ? ' closed' : ''}`, 'data-contract': String(r.contract.id) });
    const draw = (contract, head) => {
      clear(card).append(...contractCard(contract, { head, onChange: (next) => draw(next, null), deposit: r.deposit }));
    };
    const head = r.kind === 'returned' ? h('p', { class: 'return-head' }, h('strong', null, `${r.item.sku} is back`), ` ${label(r.item.category)}${gearName(r.item) ? ` ${gearName(r.item)}` : ''}`) : null;
    draw(r.contract, head);
    results.prepend(card);
    trim();
    if (r.deposit && r.deposit.action === 'confirm') confirmTake(r.contract.id, r.deposit, async () => draw(await get(`/rentals/contracts/${r.contract.id}/view`), null));
  }

  scan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    scan.value = '';
    if (!code) return;
    if (damagedNext) {
      setMode(false);
      damageDialog(code, (extra) => { queue = queue.then(() => handle(code, extra)); });
      return;
    }
    queue = queue.then(() => handle(code)); // a fast scanner can send the next code before this one is done
  });

  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'return-bar panel' },
      field('Scan to check in', scan, 'Each gear tag you scan is checked in right away. Type a contract number (like 1234) to open a contract.'),
      h('div', { class: 'rchips', role: 'group', 'aria-label': 'How the next piece came back' }, fine, damaged)),
    results));
  if (!results.children.length) results.append(h('p', { class: 'muted return-empty' }, 'Scanned gear shows here, with the renter and what is still out.'));
  scan.focus();
}

function damageDialog(sku, go) {
  const f = h('div', { class: 'form' },
    field('What is wrong', input({ name: 'notes', required: true, maxlength: 500, placeholder: 'Core shot, edge cracked, strap torn…' })),
    field('Damage fee ($, optional)', input({ name: 'fee', type: 'number', min: '0', step: '0.01', inputmode: 'decimal' })));
  formDialog(`${sku} came back damaged`, f, async (fd) => {
    if (!val(fd, 'notes')) throw new Error('Say what is wrong');
    go({ damage_notes: val(fd, 'notes'), ...(toCents(fd.get('fee')) ? { fee_cents: toCents(fd.get('fee')) } : {}) });
  }, { submitText: 'Check in as damaged' });
}

/**
 * One contract as the return screens show it: renter, due back, deposit, each piece (still out first) with Lost or
 * Damaged, fees to collect and the card deposit. onChange(view) is called with the fresh contract after any change.
 */
export function contractCard(c, { head, onChange, deposit } = {}) {
  const refresh = async () => onChange(await get(`/rentals/contracts/${c.id}/view`));
  const out = c.items.filter((i) => !i.returned_at);
  const back = c.items.filter((i) => i.returned_at);
  const open = ['out', 'overdue'].includes(c.status);
  const dueFees = c.charges.filter((x) => x.status === 'due' && x.kind !== 'deposit');
  const cardActive = c.deposit && ['held', 'saved'].includes(c.deposit.status);
  const pieceRow = (i, isOut) => h('li', { class: 'return-piece' },
    h('span', null, h('strong', null, i.sku), ` ${label(i.category)}${gearName(i) ? ` ${gearName(i)}` : ''}`, i.user_first ? h('span', { class: 'muted' }, ` · ${i.user_first} ${i.user_last}`) : null,
      i.damage_notes && i.returned_at ? h('span', null, ' ', state(i.damage_notes === 'Lost' ? 'Lost' : 'Damaged', 'warn')) : null),
    isOut
      ? h('span', { class: 'row' }, button('Back', async () => { await post(`/rentals/contracts/${c.id}/checkin`, { items: [{ rental_item_id: i.rental_item_id }] }).then(afterCheckin); }, { small: true, label: `${i.sku} is back` }),
        button('Lost', () => lostDialog(c, i, afterCheckin), { small: true, label: `${i.sku} is lost` }))
      : (!i.damage_notes && i.item_status !== 'rented' && i.item_status !== 'sold' ? button('Damaged', () => lateDamage(i, onChange), { small: true, label: `${i.sku} is damaged` }) : null));
  async function afterCheckin(r) {
    if (r && r.deposit) handleDeposit(c.id, r.deposit, refresh);
    await refresh();
  }
  const depositLine = (() => {
    if (deposit && deposit.action === 'released') return h('p', { class: 'small' }, state('Card deposit released', 'good'));
    if (!c.deposit) return null;
    const d = c.deposit;
    const what = d.kind === 'hold' ? `Hold of ${money(d.amount_cents)}` : 'Card saved';
    const st = { held: 'on the card', saved: 'for fees', released: 'released', captured: `${money(d.taken_cents)} taken`, charged: `${money(d.taken_cents)} charged` }[d.status] || label(d.status);
    return h('p', { class: 'small' }, `Deposit: ${what}${d.card ? `, ${d.card}` : ''}, ${st}.`);
  })();
  return [
    head,
    h('div', { class: 'spread' },
      h('div', null, h('strong', null, who(c)), c.phone ? h('span', { class: 'muted' }, ` · ${c.phone}`) : null, c.group_name ? h('span', { class: 'muted' }, ` · ${c.group_name}`) : null),
      h('span', { class: 'row small' }, `Contract #${c.id}`, c.kind === 'season' ? state('Season', 'neutral') : null,
        open ? state(out.length ? `${out.length} still out` : 'Out', 'neutral') : state('All back', 'good'))),
    h('p', { class: 'small muted' }, `Due back ${fmtDateTime(c.due_at)}`),
    out.length ? h('div', null, h('h3', { class: 'small-head' }, 'Still out'), h('ul', { class: 'return-pieces' }, ...out.map((i) => pieceRow(i, true)))) : null,
    back.length ? h('div', null, h('h3', { class: 'small-head' }, 'Back'), h('ul', { class: 'return-pieces' }, ...back.map((i) => pieceRow(i, false)))) : null,
    open && out.length > 1 ? h('div', { class: 'row' }, button('All the rest is back', async () => { const r = await post(`/rentals/contracts/${c.id}/checkin`, {}); await afterCheckin(r); }, { small: true })) : null,
    dueFees.length ? h('div', { class: 'callout' }, h('strong', null, `Fees to collect: ${money(c.fees_due_cents)}`),
      h('ul', { class: 'return-pieces' }, ...dueFees.map((f) => h('li', { class: 'return-piece' }, h('span', null, `${label(f.kind)}${f.note ? `: ${f.note}` : ''} `, h('strong', null, money(f.cents))),
        h('span', { class: 'row' }, button('Collect', () => collect({ ...f, contract_id: c.id }, refresh), { small: true, kind: 'primary' }),
          isManager() ? button('Waive', async () => { await post(`/rentals/charges/${f.id}/waive`, {}); toast('Fee waived'); await refresh(); }, { small: true }) : null)))),
      cardActive ? h('div', { class: 'row' }, button(c.deposit.kind === 'hold' ? 'Take from the card hold' : 'Charge the saved card', () => takeFromCard(c, refresh), { kind: 'primary', small: true })) : null) : null,
    depositLine,
    cardActive && !dueFees.length && !open ? h('div', { class: 'row' }, button('Release the deposit', () => releaseDeposit(c.id, refresh), { small: true })) : null,
  ].filter(Boolean);
}

function handleDeposit(contractId, d, after) {
  if (d.action === 'released') toast('All back. Card deposit released.');
  else if (d.action === 'confirm') confirmTake(contractId, d, after);
  else if (d.action === 'error') toast(d.message, 'error');
}

/** Take the fees owed from the card deposit on a contract (staff confirm first). */
export async function takeFromCard(c, after) {
  const view = c.items ? c : await get(`/rentals/contracts/${c.id}/view`);
  const d = view.deposit;
  if (!d || !['held', 'saved'].includes(d.status)) throw new Error('This rental has no card deposit to take from');
  confirmTake(view.id, { kind: d.kind, card: d.card_last4 ? `${label(d.card_brand || 'card')} ending ${d.card_last4}` : null, owed_cents: view.fees_due_cents, can_take_cents: d.kind === 'hold' ? Math.min(view.fees_due_cents, d.amount_cents) : view.fees_due_cents }, after);
}

function lostDialog(c, i, after) {
  const fee = input({ name: 'fee', type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: i.cost_cents ? centsToInput(i.cost_cents) : '' });
  formDialog(`${i.sku} is lost`, h('div', { class: 'form' },
    h('p', { class: 'wide muted' }, `${who(c)} did not bring back ${pieceText(i)}. It is marked lost and taken off the rack.`),
    field('Charge for it ($)', fee, i.cost_cents ? 'Filled in with what it cost the shop. Change it if your shop charges something else.' : 'Leave blank to charge nothing now.')), async (fd) => {
    const cents = toCents(fd.get('fee'));
    const r = await post(`/rentals/contracts/${c.id}/checkin`, { items: [{ rental_item_id: i.rental_item_id, lost: true, ...(cents ? { fee_cents: cents } : {}) }] });
    toast(`${i.sku} marked lost`);
    await after(r);
  }, { submitText: 'Mark lost' });
}

function lateDamage(i, onChange) {
  const f = h('div', { class: 'form' },
    field('What is wrong', input({ name: 'notes', required: true, maxlength: 500 })),
    field('Damage fee ($, optional)', input({ name: 'fee', type: 'number', min: '0', step: '0.01', inputmode: 'decimal' })));
  formDialog(`${i.sku} is damaged`, f, async (fd) => {
    if (!val(fd, 'notes')) throw new Error('Say what is wrong');
    const r = await post(`/rentals/returns/lines/${i.line_id}/damage`, { notes: val(fd, 'notes'), ...(toCents(fd.get('fee')) ? { fee_cents: toCents(fd.get('fee')) } : {}) });
    toast(`${i.sku} sent to service`);
    onChange(r.contract);
  }, { submitText: 'Send to service' });
}

// ---------------------------------------------------------------- Out now
const FILTERS = [['', 'All'], ['overdue', 'Overdue'], ['today', 'Due today'], ['groups', 'Groups'], ['season', 'Season']];

export async function drawOut(box) {
  const settings = await get('/rentals/settings');
  let filter = '';
  let timer = null;
  const search = input({ type: 'search', placeholder: 'Name, phone, gear tag or contract number', 'aria-label': 'Search what is out', autocomplete: 'off' });
  const chips = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Show' });
  const feesBox = h('div');
  const list = h('div', { class: 'out-list' });
  const count = h('p', { class: 'muted small', role: 'status' });
  function drawChips() {
    clear(chips).append(...FILTERS.map(([k, t]) => { const b = h('button', { type: 'button', class: `chip${filter === k ? ' on' : ''}`, 'aria-pressed': String(filter === k) }, t); b.addEventListener('click', () => { filter = k; drawChips(); load(); }); return b; }));
  }
  async function load() {
    const qs = new URLSearchParams({ ...(search.value.trim() ? { q: search.value.trim() } : {}), ...(filter ? { filter } : {}) });
    const r = await get(`/rentals/out?${qs}`);
    drawFees(r.fees);
    const nOut = r.data.length;
    count.textContent = filter || search.value.trim() ? `${nOut} ${nOut === 1 ? 'rental matches' : 'rentals match'}` : `${nOut} rental${nOut === 1 ? '' : 's'} out`;
    clear(list).append(r.data.length ? table([
      { head: 'Renter', cell: (c) => h('span', null, h('strong', null, who(c)), c.group_name ? h('span', { class: 'muted' }, ` (${c.group_name})`) : '', h('div', { class: 'small muted' }, [`Contract #${c.id}`, c.phone].filter(Boolean).join(' · '))) },
      { head: 'Gear out', cell: (c) => h('span', { class: 'small out-tags' }, `${c.pieces_out}: ${c.tags || ''}`) },
      { head: 'Due back', cell: (c) => h('span', null, fmtDateTime(c.due_at), h('div', { class: 'row' }, c.overdue ? state('Overdue', 'bad') : c.due_today ? state('Due today', 'neutral') : state('Out', 'neutral'), c.kind === 'season' ? state('Season', 'neutral') : null)) },
      { head: 'Deposit', cell: (c) => depositBadge(c) || h('span', { class: 'muted small' }, 'None') },
      { head: '', actions: true, cell: (c) => h('span', { class: 'row' },
        button('Check in', () => checkIn(c, load), { small: true, kind: 'primary', label: `Check in for ${who(c)}` }),
        button('Extend', () => extend(c, load), { small: true, label: `Extend for ${who(c)}` }),
        button('Swap', () => swap(c, load), { small: true, label: `Swap gear for ${who(c)}` }),
        settings.deposit_mode === 'card' && (c.deposit_mode === 'none' || c.deposit_status === 'failed') ? button('Deposit', async () => { await depositStep(c, settings); await load(); }, { small: true, label: `Take a deposit from ${who(c)}` }) : null,
        isManager() && c.kind === 'season' ? button('Buy out', () => buyoutDialog(c, load), { small: true, label: `Buy out for ${who(c)}` }) : null) },
    ], r.data, { rowClass: (c) => (c.overdue || c.hold_ends_soon ? 'attention' : null) }) : empty(search.value.trim() || filter ? 'Nothing out matches.' : 'No gear is out right now.'));
  }
  let allFees = false;
  function drawFees(fees) {
    clear(feesBox);
    if (!fees.length) return;
    const shown = allFees ? fees : fees.slice(0, 3);
    feesBox.append(h('div', { class: 'callout' }, h('strong', null, `${fees.length} unpaid fee${fees.length === 1 ? '' : 's'}`),
      table([
        { head: 'Renter', cell: (c) => who(c) },
        { head: 'Fee', cell: (c) => `${label(c.kind)}${c.note ? `: ${c.note}` : ''}` },
        { head: 'Amount', cell: (c) => money(c.cents) },
        { head: '', actions: true, cell: (c) => h('span', { class: 'row' },
          c.kind === 'deposit' ? null : button('Collect', () => collect(c, load), { small: true, kind: 'primary' }),
          c.kind !== 'deposit' && ['card_hold', 'card_saved'].includes(c.deposit_mode) && c.deposit_status === 'held' ? button('From card', () => takeFromCard({ id: c.contract_id }, load), { small: true }) : null,
          isManager() ? button(c.kind === 'deposit' ? 'Mark returned' : 'Waive', async () => { await post(`/rentals/charges/${c.id}/waive`, {}); toast('Done'); await load(); }, { small: true }) : null) },
      ], shown),
      fees.length > shown.length ? h('div', { class: 'row' }, button(`Show all ${fees.length}`, () => { allFees = true; drawFees(fees); }, { small: true })) : null));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch((err) => toast(err.message, 'error')), 250); });
  drawChips();
  clear(box).append(h('div', { class: 'stack' }, feesBox, h('div', { class: 'out-find' }, search, chips), count, list));
  await load();
}

export function collect(charge, done) {
  const method = select([['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']], 'cash', { name: 'method' });
  formDialog(`Collect ${money(charge.cents)}`, h('div', { class: 'form' }, field('Paid by', method)), async (fd) => {
    await post(`/rentals/charges/${charge.id}/collect`, { method: val(fd, 'method') });
    toast('Payment recorded');
    await done();
  }, { submitText: 'Record payment' });
}

export function extend(c, done) {
  formDialog(`Extend ${who(c)}`, h('div', { class: 'form' }, field('New return time', input({ type: 'datetime-local', name: 'due', required: true, value: String(c.due_at).replace(' ', 'T').slice(0, 16) }))), async (fd) => {
    await post(`/rentals/contracts/${c.id}/extend`, { due_at: val(fd, 'due') });
    toast('Return time updated');
    await done();
  });
}

export async function swap(contract, done) {
  const [c, avail] = await Promise.all([get(`/rentals/contracts/${contract.id}`), get('/rentals/items?status=available&limit=500')]);
  const open = c.items.filter((i) => !i.returned_at);
  const outSel = select(open.map((i) => [String(i.rental_item_id), `${i.sku} ${gearName(i)}`]), '', { name: 'out' });
  const inSel = select(avail.data.map((i) => [String(i.id), `${i.sku} ${label(i.category)} ${gearName(i)}`]), '', { name: 'in' });
  const reason = input({ name: 'reason', maxlength: 200, placeholder: 'Too big, bad fit, broken…' });
  const damaged = h('input', { type: 'checkbox', name: 'damaged' });
  const din = input({ name: 'din', type: 'number', step: '0.25', min: '0.5', max: '20' });
  const tech = input({ name: 'tech', maxlength: 100 });
  formDialog('Swap gear', h('div', { class: 'form' }, field('Bring back', outSel), field('Give instead', inSel), field('Why', reason), h('label', { class: 'check' }, damaged, 'Returned item is damaged (send to service)'),
    field('Binding setting (skis)', din), field('Set by', tech)), async (fd) => {
    const rep = { rental_item_id: Number(val(fd, 'in')) };
    if (num(fd, 'din')) { rep.din_setting = num(fd, 'din'); rep.tech_name = val(fd, 'tech') || undefined; }
    await post(`/rentals/contracts/${contract.id}/swap`, { out_item_id: Number(val(fd, 'out')), reason: val(fd, 'reason') || undefined, damaged: damaged.checked, replacement: rep });
    toast('Gear swapped');
    await done();
  }, { submitText: 'Swap' });
}

/** Check in from Out now: each piece back, damaged (with a fee) or lost; then the deposit. */
export async function checkIn(contract, done) {
  const c = await get(`/rentals/contracts/${contract.id}/view`);
  const open = c.items.filter((i) => !i.returned_at);
  const rows = open.map((i) => {
    const r = {
      i,
      back: h('input', { type: 'checkbox', checked: true, 'aria-label': `${i.sku} returned` }),
      note: input({ placeholder: 'Damage, if any', maxlength: 500, 'aria-label': `${i.sku} damage notes` }),
      fee: input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', placeholder: 'Fee', 'aria-label': `${i.sku} damage or loss fee`, class: 'fee-input' }),
      lost: h('input', { type: 'checkbox', 'aria-label': `${i.sku} lost` }),
    };
    r.lost.addEventListener('change', () => { if (r.lost.checked) { r.back.checked = false; if (!r.fee.value && i.cost_cents) r.fee.value = centsToInput(i.cost_cents); } });
    r.back.addEventListener('change', () => { if (r.back.checked) r.lost.checked = false; });
    return r;
  });
  const tbl = table([
    { head: 'Back', cell: (r) => r.back },
    { head: 'Item', cell: (r) => h('span', null, h('strong', null, r.i.sku), ` ${label(r.i.category)} ${gearName(r.i)}`) },
    { head: 'Damage', cell: (r) => r.note },
    { head: 'Fee', cell: (r) => r.fee },
    { head: 'Lost', cell: (r) => r.lost },
  ], rows);
  const go = button('Check in selected', async () => {
    const items = rows.filter((r) => r.back.checked || r.lost.checked).map((r) => ({
      rental_item_id: r.i.rental_item_id,
      ...(r.lost.checked ? { lost: true } : {}),
      ...(r.note.value.trim() ? { damage_notes: r.note.value.trim() } : {}),
      ...(toCents(r.fee.value) ? { fee_cents: toCents(r.fee.value) } : {}),
    }));
    if (!items.length) throw new Error('Select at least one item');
    const out = await post(`/rentals/contracts/${contract.id}/checkin`, { items });
    const owed = out.fees.reduce((a, f) => a + f.cents, 0);
    toast(owed ? `Returned. ${money(owed)} in fees to collect` : out.outstanding ? `${out.outstanding} item${out.outstanding === 1 ? '' : 's'} still out` : 'All gear returned');
    dlg.close();
    if (out.deposit) handleDeposit(contract.id, out.deposit, done);
    await done();
  }, { kind: 'primary' });
  const dlg = dialog(`Check in for ${who(c)}`, [
    h('p', { class: 'muted' }, 'Gear with damage notes goes to service. Lost gear comes off the rack. A late fee is added automatically if the shop charges one.'), tbl, h('div', { class: 'footer row' }, go)], { wide: true });
}
