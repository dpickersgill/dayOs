// Billing: the mountain's SummitOps subscription. Where it stands (trial, paid, grace, read only), the plan and add-ons
// with monthly or yearly prices, paying by card, US bank account or invoice, Stripe's portal for the card and
// cancelling, past invoices and the history. Owners change and pay; managers can look.
import { get, post, put } from '../api.js';
import { h, clear, ctx, money, state, button, table, toast, formDialog, field, input, errorBox, loading, label, fmtDate, fmtDateTime, confirmDialog } from '../ui.js';

const STATUS_WORDS = {
  comped: ['Included at no charge', 'good'], subscribed: ['Paid and up to date', 'good'], cancelling: ['Cancelling at the end of the period', 'warn'],
  paid_manually: ['Paid', 'good'], trial: ['Free trial', 'neutral'], payment_failed: ['Payment did not go through', 'bad'],
  trial_ended: ['Trial ended', 'bad'], paid_time_ended: ['Paid time ended', 'bad'], canceled: ['Subscription cancelled', 'bad'],
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
      b.comped && !live ? h('section', { class: 'panel' }, h('p', null, 'This mountain is on SummitOps at no charge. There is nothing to pay.'), d.plans.length && owner ? h('p', { class: 'muted small' }, 'You can still choose a plan below if you would like to start paying.') : null) : null,
      d.plans.length ? planPanel(choice, { owner, live, b }) : h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Plans have not been set up yet. Contact SummitOps.')),
      invoicesPanel(),
      historyPanel(),
    ].filter(Boolean));
  }

  function standingPanel(s, b, word, kind) {
    const lines = [];
    if (s.kind === 'trial') lines.push(`Everything is on during the trial. It ends ${dateText(s.until)} (${s.days_left === 0 ? 'today' : s.days_left === 1 ? 'tomorrow' : `in ${s.days_left} days`}). Choose a plan and a way to pay before then; paying early does not shorten the trial.`);
    if (s.kind === 'subscribed' && s.until) lines.push(`Renews ${dateText(s.until)}${b.pay_method ? `, paid by ${{ card: 'card', bank: 'bank account', invoice: 'invoice' }[b.pay_method]}` : ''}.`);
    if (s.kind === 'cancelling' && s.until) lines.push(`Ends ${dateText(s.until)}. Use Manage payment to keep it going.`);
    if (s.kind === 'paid_manually' && s.until) lines.push(`Paid through ${dateText(s.until)}.`);
    if (s.state === 'grace') lines.push(`Everything keeps working until ${dateText(s.until)} (${s.days_left} day${s.days_left === 1 ? '' : 's'}). After that the mountain becomes read only: people can sign in, see and export everything, but nothing new is sold, booked or added. Patrol, the time clock and the Inbox keep working.`);
    if (s.read_only) lines.push('SummitOps is read only. Everything can be seen and exported, and patrol, the time clock and the Inbox keep working, but nothing new is sold, booked or added. Pay below to turn everything back on straight away.');
    return h('section', { class: `panel billing-standing is-${s.state}` },
      h('div', { class: 'spread' }, h('h2', null, 'Subscription'), state(word, kind)),
      ...lines.map((t) => h('p', null, t)),
      !d.stripe ? h('p', { class: 'muted small' }, 'Online payment is not switched on yet. Contact SummitOps to pay.') : null);
  }

  function planPanel(choice, { owner, live, b }) {
    const sec = h('section', { class: 'panel stack' });
    const priceOf = (p) => (choice.interval === 'year' ? p.yearly_cents : p.monthly_cents);
    const per = () => (choice.interval === 'year' ? 'year' : 'month');
    function paint() {
      const plan = d.plans.find((p) => p.id === choice.plan_id);
      const addons = d.addons.filter((a) => choice.addons.has(a.id));
      const total = (plan ? priceOf(plan) || 0 : 0) + addons.reduce((n, a) => n + (priceOf(a) || 0), 0);
      const yearlySaves = d.plans.some((p) => p.yearly_cents && p.monthly_cents && p.yearly_cents < p.monthly_cents * 12);
      const changed = choice.plan_id !== b.plan_id || choice.interval !== (b.interval || 'month') || [...choice.addons].sort().join() !== [...(b.addons || [])].sort().join();
      const intervalBtn = (v, text) => h('button', { type: 'button', 'data-tone': 'good', 'aria-pressed': String(choice.interval === v), disabled: !owner, onclick: () => { choice.interval = v; paint(); } }, text);
      clear(sec).append(...[
        h('div', { class: 'spread' }, h('h2', null, live ? 'Your plan' : 'Choose a plan'),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'Billing period' }, intervalBtn('month', 'Monthly'), intervalBtn('year', yearlySaves ? 'Yearly (save)' : 'Yearly'))),
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
        !d.stripe ? h('p', { class: 'muted small' }, 'Payment buttons work once SummitOps switches on online payment.') : null);
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
    const words = { trial_started: 'Trial started', plan_chosen: 'Plan chosen', subscribed: 'Subscribed', paid: 'Payment received', payment_failed: 'Payment failed', operator_change: 'Updated by SummitOps' };
    const quiet = ['plan_chosen', 'operator_change']; // their details are internal
    return h('section', { class: 'panel stack' }, h('h2', null, 'History'),
      h('ul', { class: 'duty-list' }, shown.map((e) => h('li', null, h('span', { class: 'muted small' }, fmtDateTime(e.at)), ' ', h('b', null, words[e.kind] || label(e.kind)), e.detail && !quiet.includes(e.kind) ? h('span', null, ` ${e.detail}`) : null))));
  }
}

function payWay(title, text, btn) {
  return h('div', { class: 'pay-way' }, h('b', null, title), h('p', { class: 'muted small' }, text), btn);
}

/** The strip across the top of the app when billing needs attention: grace days or read only. Owners get a link. */
export function billingBanner(s, { canFix }) {
  if (!s || (s.state === 'ok' && !(s.kind === 'trial' && s.days_left <= 3))) return null;
  const text = s.read_only ? 'SummitOps is read only because the subscription has lapsed. Patrol, the time clock and the Inbox still work.'
    : s.state === 'grace' ? `${s.kind === 'payment_failed' ? 'The last SummitOps payment did not go through.' : 'The SummitOps trial or paid time has ended.'} Everything keeps working until ${dateText(s.until)}.`
      : `The SummitOps trial ends ${s.days_left === 0 ? 'today' : s.days_left === 1 ? 'tomorrow' : `in ${s.days_left} days`}.`;
  return h('div', { class: `billing-banner is-${s.read_only ? 'read_only' : s.state === 'grace' ? 'grace' : 'trial'}`, role: s.read_only ? 'alert' : 'status' },
    h('span', null, text), canFix ? h('a', { href: '#/billing' }, s.read_only || s.state === 'grace' ? 'Pay now' : 'Choose a plan') : h('span', { class: 'small' }, ' Ask the owner to renew.'));
}
