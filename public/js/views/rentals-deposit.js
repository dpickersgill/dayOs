// Deposits on the guest's card, at the rental counter. depositStep runs right after gear is handed out (Track FIT calls
// it from the fitting card and from Sell). With the shop's deposit set to "Card", it sends the deposit to the card
// reader: a hold for a short day rental, or the card saved (nothing charged) for a long or season rental, because a
// hold on a card tapped in person only lasts about 2 days. When the card service or the reader cannot be used, it
// offers a note deposit instead and says why. The other exports show a deposit on Out now and settle it on return.
import { get, post, poll } from '../api.js';
import { h, clear, field, input, select, button, toast, dialog, money, toCents, centsToInput, state, confirmDialog, isManager } from '../ui.js';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The deposit step after hand-out. contract: { id, kind?, due_at?, first_name?, last_name? }. settings: the shop's
 * rental settings. Resolves when the counter is done with it (held, saved, noted or skipped).
 */
export async function depositStep(contract, settings) {
  if (!contract || !contract.id || !settings || settings.deposit_mode !== 'card') return null;
  const ready = await get('/rentals/deposits/ready').catch((err) => ({ ready: false, why: err.message, readers: [] }));
  return new Promise((resolve) => {
    let finished = null;
    const body = h('div', { class: 'stack deposit-step' });
    const dlg = dialog(`Deposit for ${[contract.first_name, contract.last_name].filter(Boolean).join(' ') || `contract #${contract.id}`}`, body, { onClose: () => resolve(finished) });
    const done = (result) => { finished = result; dlg.close(); };
    if (!ready.ready) noteForm(body, contract, settings, `Card deposit not available: ${ready.why} Take a note deposit instead, or skip.`, done);
    else cardForm(body, contract, settings, ready, done);
  });
}

function cardForm(body, contract, settings, ready, done) {
  const amount = input({ type: 'number', min: '0.50', step: '0.01', inputmode: 'decimal', value: centsToInput(settings.default_deposit_cents || 0) || '', 'aria-label': 'Deposit amount in dollars', required: true });
  const reader = select(ready.readers.map((r) => [String(r.id), r.label]), String(ready.readers[0].id), { 'aria-label': 'Card reader' });
  const season = contract.kind === 'season';
  const go = button('Send to the reader', async () => {
    const cents = toCents(amount.value);
    if (!(cents >= 50)) throw new Error('Enter the deposit amount');
    try {
      const d = await post(`/rentals/contracts/${contract.id}/deposit`, { reader_id: Number(reader.value), amount_cents: cents });
      waitForCard(body, contract, settings, ready, d, done);
    } catch (err) {
      if (err.details && err.details.fallback === 'note') { noteForm(body, contract, settings, `${err.message}`, done, cents); return; }
      throw err;
    }
  }, { kind: 'primary' });
  clear(body).append(
    h('p', null, season ? 'This is a season rental, so the card is saved, not charged. It is only charged if gear is not returned or fees are owed.' : 'The deposit is held on the guest\'s card, not charged. It is let go when the gear comes back. A rental longer than a day and a half saves the card instead.'),
    h('div', { class: 'form' }, field('Deposit ($)', amount), ready.readers.length > 1 ? field('Card reader', reader) : null),
    h('div', { class: 'footer row' }, button('Note deposit instead', () => noteForm(body, contract, settings, 'Take a note deposit (cash, an ID or a note) instead of the card.', done)), button('Skip', () => done({ skipped: true })), go));
}

/** Watches the reader until the guest has tapped (or it failed), asking the server every second and a half. */
async function waitForCard(body, contract, settings, ready, d, done) {
  const status = h('p', { class: 'deposit-wait', role: 'status', 'aria-live': 'polite' }, d.kind === 'hold' ? `Ask the guest to tap, insert or swipe their card for a ${money(d.amount_cents)} hold.` : 'Ask the guest to tap, insert or swipe their card. It is saved, not charged.');
  let stopped = false;
  const cancel = button('Cancel', async () => { stopped = true; await post(`/rentals/deposits/${d.id}/cancel`, {}); toast('Deposit canceled'); cardForm(body, contract, settings, ready, done); });
  const sim = ready.test_mode && ready.readers.some((r) => r.simulated) ? [
    button('Simulate a tap', () => post(`/rentals/deposits/${d.id}/simulate`, { outcome: 'approve' }), { small: true }),
    button('Simulate a decline', () => post(`/rentals/deposits/${d.id}/simulate`, { outcome: 'decline' }), { small: true })] : [];
  clear(body).append(status, h('div', { class: 'footer row' }, ...sim, cancel));
  for (let i = 0; i < 240 && !stopped && body.isConnected; i += 1) {
    await sleep(1500);
    if (stopped || !body.isConnected) return;
    let now;
    try { now = await poll(`/rentals/deposits/${d.id}`); } catch (_) { continue; }
    if (now.status === 'held' || now.status === 'saved') {
      toast(now.status === 'held' ? `${money(now.amount_cents)} held on ${now.card || 'the card'}` : `${now.card || 'Card'} saved for the deposit`);
      done(now);
      return;
    }
    if (now.status === 'failed' || now.status === 'canceled') {
      clear(body).append(h('div', { class: 'error-box', role: 'alert' }, now.failure || 'The card was not accepted.'),
        h('div', { class: 'footer row' }, button('Note deposit instead', () => noteForm(body, contract, settings, 'Take a note deposit instead of the card.', done)), button('Skip', () => done({ skipped: true })), button('Try again', () => cardForm(body, contract, settings, ready, done), { kind: 'primary' })));
      return;
    }
  }
}

function noteForm(body, contract, settings, why, done, cents) {
  const amount = input({ type: 'number', min: '0', step: '0.01', inputmode: 'decimal', value: centsToInput(cents ?? settings.default_deposit_cents ?? 0), 'aria-label': 'Deposit amount in dollars' });
  const note = input({ maxlength: 200, placeholder: 'Cash, driver license, credit card slip…', 'aria-label': 'What the shop is holding' });
  clear(body).append(h('div', { class: 'callout' }, why),
    h('div', { class: 'form' }, field('Deposit ($)', amount), field('What you are holding', note)),
    h('div', { class: 'footer row' }, button('Skip', () => done({ skipped: true })), button('Save note deposit', async () => {
      await post(`/rentals/contracts/${contract.id}/deposit/note`, { amount_cents: toCents(amount.value || '0'), ...(note.value.trim() ? { note: note.value.trim() } : {}) });
      toast('Deposit noted');
      done({ mode: 'note' });
    }, { kind: 'primary' })));
}

/** The deposit on a contract row, in a few words: card held, card saved, note, ending soon. */
export function depositBadge(c) {
  if (c.hold_ends_soon) return state('Card hold ends within a day', 'warn');
  if (c.deposit_mode === 'card_hold' && c.deposit_status === 'held') return state(`Hold ${money(c.deposit_cents)}${c.deposit_card ? `, ${c.deposit_card}` : ''}`, 'good');
  if (c.deposit_mode === 'card_saved' && c.deposit_status === 'held') return state(`Card saved${c.deposit_card ? `, ${c.deposit_card}` : ''}`, 'good');
  if (c.deposit_status === 'pending') return state('Waiting at the reader', 'neutral');
  if (c.deposit_status === 'failed') return state('Card hold ended', 'warn');
  if (c.deposit_mode === 'note' && Number(c.deposit_cents)) return state(`Noted ${money(c.deposit_cents)}`, 'neutral');
  return null;
}

/**
 * After a return with a card deposit and fees owed: staff confirm before anything is taken. info is the deposit reply
 * from the check-in ({ action: 'confirm', owed_cents, can_take_cents, kind, card }).
 */
export function confirmTake(contractId, info, after) {
  const what = info.kind === 'hold' ? `Take ${money(info.can_take_cents)} from the card hold on ${info.card || 'the card'}?` : `Charge ${money(info.can_take_cents)} to the saved ${info.card || 'card'}?`;
  const rest = info.owed_cents > info.can_take_cents ? ` The hold covers part of the ${money(info.owed_cents)} owed. Collect the rest at the counter.` : '';
  const left = info.kind === 'hold' ? ' The rest of the hold is let go.' : '';
  confirmDialog('Fees owed', `${what}${left}${rest}`, info.kind === 'hold' ? 'Take it from the hold' : 'Charge the card', async () => {
    const r = await post(`/rentals/contracts/${contractId}/deposit/take`, {});
    toast(r.still_due_cents ? `${money(r.taken_cents)} taken. ${money(r.still_due_cents)} still to collect.` : `${money(r.taken_cents)} taken from the card`);
    if (after) await after(r);
  });
}

/** Release a card deposit by hand (fees waived or paid another way). Managers only while gear is still out. */
export function releaseDeposit(contractId, after, { stillOut = false } = {}) {
  if (stillOut && !isManager()) { toast('Gear is still out. Ask a manager to release the deposit.', 'error'); return; }
  confirmDialog('Release the deposit', stillOut ? 'Gear is still out. Release the card deposit anyway?' : 'Let go of the card deposit? Nothing is charged.', 'Release', async () => {
    await post(`/rentals/contracts/${contractId}/deposit/release`, {});
    toast('Deposit released');
    if (after) await after();
  });
}

/**
 * A rental extended past the end of its card hold: let the hold go and save the card on the reader instead (the guest
 * taps again; nothing is charged). contract: { id, deposit_cents?, first_name?, last_name? }.
 */
export async function switchDeposit(contract, after) {
  const ready = await get('/rentals/deposits/ready');
  if (!ready.ready) { toast(`The card cannot be saved now: ${ready.why}`, 'error'); return; }
  const body = h('div', { class: 'stack deposit-step' });
  const reader = select(ready.readers.map((r) => [String(r.id), r.label]), String(ready.readers[0].id), { 'aria-label': 'Card reader' });
  const dlg = dialog('Switch to a saved card', body, { onClose: () => { if (after) after(); } });
  const done = (r) => { if (r && r.status === 'saved') toast('Card saved. Now extend the rental.'); dlg.close(); };
  clear(body).append(
    h('p', null, 'A card hold only lasts about 2 days, so a longer rental saves the card instead. The hold is let go now, and the guest taps their card again to save it. Nothing is charged.'),
    ready.readers.length > 1 ? h('div', { class: 'form' }, field('Card reader', reader)) : null,
    h('div', { class: 'footer row' }, button('Not now', () => dlg.close()), button('Let go of the hold and save the card', async () => {
      const d = await post(`/rentals/contracts/${contract.id}/deposit/switch`, { reader_id: Number(reader.value) });
      waitForCard(body, contract, { default_deposit_cents: d.amount_cents }, ready, d, done);
    }, { kind: 'primary' })));
}

