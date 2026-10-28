// Billing: the mountain's Verdynt/OS subscription, and where guests' card payments go (the mountain's own Stripe account). Where it stands (trial, paid, grace, read only), the plan and add-ons
// with monthly or yearly prices, paying by card, US bank account or invoice, Stripe's portal for the card and
// canceling, past invoices and the history. Owners change and pay; managers can look.
import { get, post, put, del } from '../api.js';
import { h, clear, ctx, money, state, button, table, toast, formDialog, field, input, errorBox, loading, label, fmtDate, fmtDateTime, confirmDialog } from '../ui.js';

const STATUS_WORDS = {
  comped: ['Included at no charge', 'good'], subscribed: ['Paid and up to date', 'good'], cancelling: ['Canceling at the end of the period', 'warn'],
  paid_manually: ['Paid', 'good'], trial: ['Free trial', 'neutral'], payment_failed: ['Payment did not go through', 'bad'],
  trial_ended: ['Trial ended', 'bad'], paid_time_ended: ['Paid time ended', 'bad'], canceled: ['Subscription canceled', 'bad'],
};
const dateText = (d) => (d ? fmtDate(`${String(d).slice(0, 10)}T12:00:00`) : '');

export async function render(root) {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Billing')));
  const box = h('div', { class: 'stack billing' }, loading('Loading billing'));
  root.append(box);
  if (query.get('paid') === '1') toast('Thanks. Stripe is confirming the payment; this page updates in a moment');
  let d;
  async function load() {
    try { d = await get('/billing'); draw(); } catch (err) { clear(box).append(errorBox(err)); }
  }
  // Right after paying, Stripe's webhook can be a few seconds behind the return: look again until it shows.
  if (query.get('paid') === '1') {
    let tries = 0;
    const again = async () => { tries += 1; await load(); if (d && !(d.billing && d.billing.subscribed) && tries < 6 && box.isConnected) setTimeout(again, 2500); };
    await again();
  } else await load();

  function draw() {
    const s = d.standing; const b = d.billing || {};
    const [word, kind] = STATUS_WORDS[s.kind] || [label(s.kind), s.read_only ? 'bad' : 'neutral'];
    const choice = { plan_id: b.plan_id || (d.plans[0] && d.plans[0].id) || null, addons: new Set(b.addons || []), interval: b.interval || 'month' };
    const owner = d.can_pay;
    const live = b.subscribed && ['active', 'trialing', 'past_due'].includes(b.sub_status);

    clear(box).append(...[
      standingPanel(s, b, word, kind),
      b.comped && !live ? h('section', { class: 'panel' }, h('p', null, 'This mountain is on Verdynt/OS at no charge. There is nothing to pay.'), d.plans.length && owner ? h('p', { class: 'muted small' }, 'You can still choose a plan below if you would like to start paying.') : null) : null,
      d.plans.length ? planPanel(choice, { owner, live, b }) : h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Plans have not been set up yet. Contact Verdynt/OS.')),
      cardPaymentsPanel(query),
      readersPanel(),
      invoicesPanel(),
      historyPanel(),
    ].filter(Boolean));
  }

  function standingPanel(s, b, word, kind) {
    const lines = [];
    if (s.kind === 'trial') lines.push(`Everything is on during the trial. It ends ${dateText(s.until)} (${s.days_left === 0 ? 'today' : s.days_left === 1 ? 'tomorrow' : `in ${s.days_left} days`}). Choose a plan and a way to pay before then; paying early does not shorten the trial.`);
    if (s.kind === 'subscribed' && s.until) lines.push(`Renews ${dateText(s.until)}${b.pay_method ? `, paid by ${{ card: 'card', bank: 'bank account', invoice: 'invoice' }[b.pay_method]}` : ''}.`);
    if (b.interval === 'season') lines.push(b.season_paused_until ? `Paid over the season: nothing to pay until ${dateText(b.season_paused_until)}, and everything keeps working meanwhile.` : 'Paid over the season: six monthly payments, November to April.');
    if (s.kind === 'cancelling' && s.until) lines.push(`Ends ${dateText(s.until)}. Use Manage payment to keep it going.`);
    if (s.kind === 'paid_manually' && s.until) lines.push(`Paid through ${dateText(s.until)}.`);
    if (s.state === 'grace') lines.push(`Everything keeps working until ${dateText(s.until)} (${s.days_left} day${s.days_left === 1 ? '' : 's'}). After that the mountain becomes read only: people can sign in, see and export everything, but nothing new is sold, booked or added. Patrol, the time clock and the Inbox keep working.`);
    if (s.read_only) lines.push('Verdynt/OS is read only. Everything can be seen and exported, and patrol, the time clock and the Inbox keep working, but nothing new is sold, booked or added. Pay below to turn everything back on straight away.');
    return h('section', { class: `panel billing-standing is-${s.state}` },
      h('div', { class: 'spread' }, h('h2', null, 'Subscription'), state(word, kind)),
      ...lines.map((t) => h('p', null, t)),
      !d.stripe ? h('p', { class: 'muted small' }, 'Online payment is not switched on yet. Contact Verdynt/OS to pay.') : null);
  }

  function planPanel(choice, { owner, live, b }) {
    const sec = h('section', { class: 'panel stack' });
    // Season: the yearly price in six payments, November to April.
    const priceOf = (p) => (choice.interval === 'year' ? p.yearly_cents : choice.interval === 'season' ? (p.yearly_cents ? Math.round(p.yearly_cents / 6) : 0) : p.monthly_cents);
    const per = () => (choice.interval === 'year' ? 'year' : choice.interval === 'season' ? 'month, November to April' : 'month');
    function paint() {
      const plan = d.plans.find((p) => p.id === choice.plan_id);
      const addons = d.addons.filter((a) => choice.addons.has(a.id));
      const total = (plan ? priceOf(plan) || 0 : 0) + addons.reduce((n, a) => n + (priceOf(a) || 0), 0);
      const yearlySaves = d.plans.some((p) => p.yearly_cents && p.monthly_cents && p.yearly_cents < p.monthly_cents * 12);
      const changed = choice.plan_id !== b.plan_id || choice.interval !== (b.interval || 'month') || [...choice.addons].sort().join() !== [...(b.addons || [])].sort().join();
      const intervalBtn = (v, text) => h('button', { type: 'button', 'data-tone': 'good', 'aria-pressed': String(choice.interval === v), disabled: !owner, onclick: () => { choice.interval = v; paint(); } }, text);
      clear(sec).append(...[
        h('div', { class: 'spread' }, h('h2', null, live ? 'Your plan' : 'Choose a plan'),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Billing period' }, intervalBtn('month', 'Monthly'), intervalBtn('year', yearlySaves ? 'Yearly (save)' : 'Yearly'), intervalBtn('season', 'Over the season'))),
        choice.interval === 'season' ? h('p', { class: 'muted small' }, 'The yearly price in six monthly payments, November to April, with nothing to pay May to October. Everything keeps working all year. Starting between May and October, the first payment is on November 1.') : null,
        h('div', { class: 'plan-grid', role: 'radiogroup', 'aria-label': 'Plan' }, d.plans.map((p) => {
          const cents = priceOf(p); const on = p.id === choice.plan_id;
          return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: `plan-card${on ? ' on' : ''}`, disabled: !owner || !cents,
            onclick: () => { choice.plan_id = p.id; paint(); } },
          h('span', { class: 'plan-name' }, p.name),
          h('span', { class: 'plan-price' }, cents ? money(cents) : 'Not offered', cents ? h('small', null, ` a ${per()}`) : null),
          p.blurb ? h('span', { class: 'plan-blurb' }, p.blurb) : null,
          p.modules.length ? h('span', { class: 'plan-apps' }, p.modules.map(label).join(', ')) : null,
          b.plan_id === p.id && live ? h('span', { class: 'plan-current' }, 'Current plan') : null);
        })),
        d.addons.length ? h('fieldset', { class: 'addon-list' }, h('legend', null, 'Add-ons'), d.addons.map((a) => {
          const cents = priceOf(a);
          const box2 = h('input', { type: 'checkbox', checked: choice.addons.has(a.id), disabled: !owner, onchange: (e) => { if (e.target.checked) choice.addons.add(a.id); else choice.addons.delete(a.id); paint(); } });
          return h('label', { class: 'addon' }, box2, h('span', null, h('b', null, a.name), a.blurb ? h('span', { class: 'muted small' }, ` ${a.blurb}`) : null), h('span', { class: 'addon-price' }, cents ? `${money(cents)} a ${per()}` : 'Included'));
        })) : null,
        h('p', { class: 'plan-total' }, 'Total ', h('b', null, `${money(total)} a ${per()}`), h('span', { class: 'muted small' }, ' plus any tax')),
        owner ? actions(changed, live, b) : h('p', { class: 'muted small' }, 'Only the mountain\'s owner can change the plan or pay.'),
      ].filter(Boolean));
    }
    async function saveChoice() {
      await put('/billing/choice', { plan_id: choice.plan_id, addons: [...choice.addons], interval: choice.interval });
    }
    function actions(changed, isLive) {
      if (isLive) {
        return h('div', { class: 'row' }, ...[
          changed ? button('Change plan', () => confirmDialog('Change the plan?', 'Stripe charges or credits the difference for the rest of this period, and the apps change straight away.', 'Change plan', async () => { await saveChoice(); toast('Plan changed'); await load(); }), { kind: 'primary' }) : null,
          button('Manage payment', async () => { const { url } = await post('/billing/portal'); location.assign(url); }),
        ].filter(Boolean), h('span', { class: 'muted small' }, 'Change the card or bank account, see receipts or cancel, on Stripe\'s secure page.'));
      }
      const pay = (method) => async () => { if (!choice.plan_id) throw new Error('Choose a plan first'); await saveChoice(); const { url } = await post('/billing/checkout', { method }); location.assign(url); };
      return h('div', { class: 'stack' },
        h('h3', null, 'How would you like to pay?'),
        h('div', { class: 'pay-ways' },
          payWay('Card', 'Pay now by credit or debit card. Renews automatically.', button('Pay by card', pay('card'), { kind: 'primary' })),
          payWay('Bank account (ACH)', 'Link a US bank account. Takes a few business days to clear the first time.', button('Pay by bank', pay('bank'))),
          payWay('Invoice', 'We email an invoice each period, due in 30 days. Pay by card, bank transfer or check.', button('Send me invoices', () => invoiceDialog()))),
        changed && choice.plan_id ? h('div', { class: 'row' }, button('Save choice without paying', async () => { await saveChoice(); toast('Choice saved'); await load(); }, { small: true })) : null,
        !d.stripe ? h('p', { class: 'muted small' }, 'Payment buttons work once Verdynt/OS switches on online payment.') : null);
    }
    function invoiceDialog() {
      formDialog('Pay by invoice', h('div', { class: 'form' },
        h('div', { class: 'wide' }, field('Send invoices to', input({ name: 'billing_email', type: 'email', required: true, maxlength: 255, value: b.billing_email || ctx.me.email || '' }), 'Usually your accounts payable address'))), async (fd) => {
        await saveChoice();
        await post('/billing/invoice', { billing_email: String(fd.get('billing_email')).trim() });
        toast('Subscribed. The first invoice is on its way'); await load();
      }, { submitText: 'Start invoicing' });
    }
    paint();
    return sec;
  }

  function invoicesPanel() {
    if (d.invoices === null) return h('section', { class: 'panel' }, h('h2', null, 'Invoices'), h('p', { class: 'muted' }, 'Invoices could not be loaded from Stripe just now. Try again later.'));
    if (!d.invoices.length) return null;
    return h('section', { class: 'panel stack' }, h('h2', null, 'Invoices'),
      table([
        { head: 'Date', cell: (i) => fmtDate(i.created) },
        { head: 'Number', cell: (i) => i.number || '' },
        { head: 'Amount', num: true, cell: (i) => money(i.amount_cents) },
        { head: 'Status', cell: (i) => state(i.status === 'paid' ? 'Paid' : i.status === 'open' ? (i.due ? `Due ${fmtDate(i.due)}` : 'Open') : label(i.status), i.status === 'paid' ? 'good' : i.status === 'open' ? 'warn' : 'neutral') },
        { actions: true, cell: (i) => h('span', { class: 'row' }, ...[i.url ? h('a', { class: 'btn small', href: i.url, target: '_blank', rel: 'noopener' }, i.status === 'open' ? 'Pay' : 'View') : null, i.pdf ? h('a', { class: 'btn small', href: i.pdf, target: '_blank', rel: 'noopener' }, 'PDF') : null].filter(Boolean)) },
      ], d.invoices));
  }

  function historyPanel() {
    const shown = d.events.filter((e) => !e.kind.startsWith('stripe:'));
    if (!shown.length) return null;
    const words = { trial_started: 'Trial started', plan_chosen: 'Plan chosen', subscribed: 'Subscribed', paid: 'Payment received', payment_failed: 'Payment failed', operator_change: 'Updated by Verdynt/OS' };
    const quiet = ['plan_chosen', 'operator_change']; // their details are internal
    return h('section', { class: 'panel stack' }, h('h2', null, 'History'),
      h('ul', { class: 'duty-list' }, shown.map((e) => h('li', null, h('span', { class: 'muted small' }, fmtDateTime(e.at)), ' ', h('b', null, words[e.kind] || label(e.kind)), e.detail && !quiet.includes(e.kind) ? h('span', null, ` ${e.detail}`) : null))));
  }
}

// Guest card payments: the online shop, lesson payments, date changes and patrol giving are paid into the mountain's own
// Stripe account. The owner connects it here (Stripe's own pages collect the business and bank details); managers can look.
const CARD_STATE = {
  ready: ['Taking card payments', 'good'], unfinished: ['Stripe needs more details', 'warn'], not_connected: ['Not connected', 'neutral'], off: ['Not available yet', 'neutral'],
};
function cardPaymentsPanel(query) {
  const sec = h('section', { class: 'panel stack' }, h('h2', null, 'Guest card payments'), loading('Checking Stripe'));
  const back = query.get('stripe');
  (async () => {
    let s;
    try { s = await get(`/payments/stripe${back ? '?refresh=1' : ''}`); } catch (err) { clear(sec).append(h('h2', null, 'Guest card payments'), errorBox(err)); return; }
    const draw = () => {
      const [word, kind] = CARD_STATE[s.status] || [s.status, 'neutral'];
      const fee = s.platform_fee_bps || s.platform_fee_cents ? `${(s.platform_fee_bps / 100).toFixed(2).replace(/\.?0+$/, '')}%${s.platform_fee_cents ? ` plus ${money(s.platform_fee_cents)}` : ''} of each guest card payment` : null;
      const go = async () => { const r = await post('/payments/stripe/link', {}); location.href = r.url; };
      const text = {
        ready: `Online shop orders, lesson payments, date changes and gifts to the patrol are paid straight into your own Stripe account${s.business_name ? ` (${s.business_name})` : ''}, and Stripe pays them out to your bank. ${s.payouts_enabled ? '' : 'Payouts are not on yet: finish your bank details in Stripe. '}Refunds come back out of the same account.`,
        unfinished: 'Your Stripe account is connected, but Stripe still needs some details (the business, a person, a bank account) before it can take payments. Card payments open as soon as Stripe is happy.',
        not_connected: 'Guests\' card payments go into your mountain\'s own Stripe account, never through Verdynt/OS. Connect one to open the online shop, lesson payments and patrol giving. Stripe asks for the business, a contact and the bank account payouts go to; if you already use Stripe, sign in with that login.',
        off: 'Card payments are not switched on for Verdynt/OS yet. Contact Verdynt/OS.',
      }[s.status];
      clear(sec).append(...[
        h('div', { class: 'spread' }, h('h2', null, 'Guest card payments'), state(word, kind)),
        h('p', null, text),
        h('p', { class: 'muted small' }, `Stripe's own card fees are charged by Stripe to your account. ${fee ? `Verdynt/OS's fee: ${fee}, kept by Stripe from the payment and returned in proportion on refunds. Gifts to the patrol carry no Verdynt/OS fee.` : 'Verdynt/OS adds no fee of its own.'}`),
        s.fallback ? h('p', { class: 'muted small' }, 'Until you connect, this test service takes card payments into the Verdynt/OS test account.') : null,
        s.sandbox ? h('p', { class: 'muted small' }, 'This is a demo mountain, so it cannot take real card payments.') : null,
        s.check_failed ? h('p', { class: 'muted small' }, 'Stripe could not be reached just now to check the account. Try again in a minute.') : null,
        s.can_connect && s.enabled && !s.sandbox ? h('div', { class: 'row' },
          s.status === 'not_connected' ? button('Connect Stripe', go, { kind: 'primary' }) : null,
          s.status === 'unfinished' ? button('Finish in Stripe', go, { kind: 'primary' }) : null,
          s.status === 'ready' ? button('Update details in Stripe', go) : null,
          s.connected ? button('Check again', async () => { s = { ...s, ...(await get('/payments/stripe?refresh=1')) }; draw(); }) : null,
          s.connected ? button('Disconnect', () => confirmDialog('Stop taking card payments into this Stripe account?', 'The online shop, lesson payments and patrol giving stop taking cards until you connect an account again. Your Stripe account and the money in it are not touched, and refunds of earlier payments still work.', 'Disconnect', async () => { s = { ...s, ...(await post('/payments/stripe/disconnect', {})) }; toast('Disconnected'); draw(); }, { danger: true })) : null)
          : !s.can_connect && s.status !== 'ready' ? h('p', { class: 'muted small' }, 'Only the mountain\'s owner can connect Stripe.') : null,
      ].filter(Boolean));
    };
    draw();
    if (back === 'return') toast(s.status === 'ready' ? 'Stripe is connected. Card payments are open.' : 'Back from Stripe. If it still needs details, finish them there.');
    if (back === 'again' && s.can_connect) toast('That Stripe page timed out. Press the button to carry on.');
  })();
  return sec;
}

// Card readers at the counter (routes/terminal.js): Stripe smart readers paired to this mountain's Stripe account.
// Managers pair and remove them; the ticket window then shows Charge on reader at checkout.
function readersPanel() {
  const sec = h('section', { class: 'panel stack' }, h('h2', null, 'Card readers'), loading('Checking readers'));
  const draw = async () => {
    let r; let stray = { payments: [] };
    try { r = await get('/terminal/readers'); stray = await get('/terminal/unattached').catch(() => stray); } catch (err) { clear(sec).append(h('h2', null, 'Card readers'), errorBox(err)); return; }
    const manager = ['owner', 'manager'].includes(ctx.me && ctx.me.role);
    const pair = (simulated) => {
      const code = input({ name: 'registration_code', required: true, autocomplete: 'off', maxlength: '60', placeholder: 'For example, apple-grape-orange' });
      const name = input({ name: 'label', required: true, maxlength: '100', value: simulated ? 'Test reader' : '', placeholder: 'For example, Ticket window 1' });
      const addr = r.has_location ? null : h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Stripe needs the mountain’s street address for its first card reader.'),
        field('Street address', input({ name: 'line1', required: true, maxlength: '200', autocomplete: 'address-line1' })),
        h('div', { class: 'form' }, field('Town', input({ name: 'city', required: true, maxlength: '100', autocomplete: 'address-level2' })),
          field('State', input({ name: 'state', required: true, maxlength: '2', placeholder: 'PA', autocomplete: 'address-level1' })),
          field('ZIP code', input({ name: 'postal_code', required: true, maxlength: '10', inputmode: 'numeric', autocomplete: 'postal-code' }))));
      if (simulated) code.value = 'simulated-wpe';
      formDialog(simulated ? 'Add a test reader' : 'Pair a card reader', h('div', { class: 'stack' },
        simulated ? h('p', { class: 'muted small' }, 'A pretend reader for trying the counter in Stripe’s test mode. At checkout, Simulate a tap stands in for a real card.')
          : h('p', { class: 'muted small' }, 'On the reader, open its settings, choose Generate pairing code, and type the three words it shows.'),
        simulated ? null : field('Pairing code', code), field('Name it', name, 'Shown at checkout when there is more than one reader.'), addr), async (fd) => {
        const body = { registration_code: simulated ? 'simulated-wpe' : String(fd.get('registration_code') || '').trim(), label: String(fd.get('label') || '').trim() };
        if (addr) body.address = { line1: fd.get('line1'), city: fd.get('city'), state: String(fd.get('state') || '').trim(), postal_code: String(fd.get('postal_code') || '').trim() };
        await post('/terminal/readers', body);
        toast('Card reader paired');
        draw();
      }, { submitText: simulated ? 'Add test reader' : 'Pair reader' });
    };
    clear(sec).append(...[
      h('h2', null, 'Card readers'),
      h('p', null, 'A Stripe card reader on the counter takes tap, chip and swipe for sales at the ticket window, paid straight into your own Stripe account. Order one from your Stripe dashboard (Terminal, Shop); the Stripe Reader S700 is a good choice.'),
      !r.enabled ? h('p', { class: 'muted small' }, 'Connect Stripe above first.') : null,
      r.readers.length ? table(['Reader', 'Type', ''], r.readers.map((x) => [h('span', null, x.label, x.simulated ? h('small', { class: 'muted' }, ' (test)') : null), x.device_type ? label(x.device_type.replace(/_/g, ' ')) : '',
        manager ? button('Remove', () => confirmDialog(`Remove ${x.label}?`, 'It stops taking payments here. You can pair it again later with a new code.', 'Remove', async () => { await del(`/terminal/readers/${x.id}`); toast('Removed'); draw(); }, { danger: true }), { small: true }) : ''])) : r.enabled ? h('p', { class: 'muted' }, 'No card readers paired yet.') : null,
      manager && r.enabled ? h('div', { class: 'row' }, button('Pair a card reader', () => pair(false), { kind: 'primary' }), r.test_mode ? button('Add a test reader', () => pair(true)) : null) : null,
      stray.payments.length ? h('div', { class: 'notice warn stack' }, h('b', null, 'Card payments not part of a sale'),
        h('p', { class: 'small' }, 'These were charged on a reader but the sale was never completed. Refund them so the guest is not charged. A payment still waiting for the card is one the counter stopped watching: check the reader, then cancel it if the guest did not pay.'),
        ...stray.payments.map((p) => h('div', { class: 'spread' }, h('span', null, `${money(p.amount_cents)}${p.card_last4 ? `, card ending ${p.card_last4}` : ''}`,
          p.status === 'waiting' ? h('small', { class: 'muted' }, `  Still waiting for the card on the reader${p.created_at ? ` since ${fmtDateTime(p.created_at)}` : ''}`) : null),
          p.status === 'waiting'
            ? h('span', { class: 'row' }, button('Check again', async () => { await get(`/terminal/payments/${p.id}`); draw(); }, { small: true }),
              button('Cancel it', async () => { const st = await post(`/terminal/payments/${p.id}/cancel`, {}); toast(st.status === 'refunded' ? 'It had gone through, so it was refunded' : 'Canceled. Nothing was charged.'); draw(); }, { small: true }))
            : button('Refund', async () => { await post(`/terminal/payments/${p.id}/cancel`, {}); toast('Refunded'); draw(); }, { small: true })))) : null,
    ].filter(Boolean));
  };
  draw();
  return sec;
}

function payWay(title, text, btn) {
  return h('div', { class: 'pay-way' }, h('b', null, title), h('p', { class: 'muted small' }, text), btn);
}

/** The strip across the top of the app when billing needs attention: grace days or read only. Owners get a link. */
export function billingBanner(s, { canFix }) {
  if (!s || (s.state === 'ok' && !(s.kind === 'trial' && s.days_left <= 3))) return null;
  const text = s.read_only ? 'Verdynt/OS is read only because the subscription has lapsed. Patrol, the time clock and the Inbox still work.'
    : s.state === 'grace' ? `${s.kind === 'payment_failed' ? 'The last Verdynt/OS payment did not go through.' : 'The Verdynt/OS trial or paid time has ended.'} Everything keeps working until ${dateText(s.until)}.`
      : `The Verdynt/OS trial ends ${s.days_left === 0 ? 'today' : s.days_left === 1 ? 'tomorrow' : `in ${s.days_left} days`}.`;
  return h('div', { class: `billing-banner is-${s.read_only ? 'read_only' : s.state === 'grace' ? 'grace' : 'trial'}`, role: s.read_only ? 'alert' : 'status' },
    h('span', null, text), canFix ? h('a', { href: '#/billing' }, s.read_only || s.state === 'grace' ? 'Pay now' : 'Choose a plan') : h('span', { class: 'small' }, ' Ask the owner to renew.'));
}
