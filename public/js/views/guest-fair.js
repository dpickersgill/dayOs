// Settings, Sell and gate: Fair by design (guests round 2, Track FAIR). settingsPages: { key: { title, render(panel), who } }.
// - Fair promises: every promise is off until a manager turns it on, with what the guest sees and what it may cost.
// - Closure credits: preview who gets a credit for a closed day, then give them.
// - Conditions guarantee: today's switch and the credits guests claimed.
// - Scan review: unusual scans with the evidence; block a pass with a reason, read the guest's answer, unblock.
// - Payment plans: every plan, its payments and status; charge now, settle or cancel.
// - Passes: which can be paid in a plan, caps and the waitlist, and who renews automatically.
import { get, post, put, patch } from '../api.js';
import { h, clear, input, select, money, toCents, centsToInput, fmtDay, fmtDateTime, state, table, button, confirmDialog, formDialog, field, val, empty, errorBox, toast, loading } from '../ui.js';
import { row, infoRow, toggle, amount, formTracker } from './settings-kit.js';

const PLAN_STATE = { active: ['On track', 'good'], late: ['Late', 'warn'], suspended: ['On hold at the gate', 'bad'], paid: ['Paid', 'good'], settled: ['Settled', 'good'], canceled: ['Canceled', 'neutral'] };
const CHARGE_STATE = { paid: 'Paid', due: 'Coming up', failed: 'Did not go through', canceled: 'Canceled', settled: 'Settled' };
const reload = async (panel, fn) => { clear(panel).append(loading()); try { clear(panel); await fn(panel); } catch (err) { clear(panel).append(errorBox(err)); } };

// ---------------------------------------------------------------- the promises
async function promises(panel) {
  const s = await get('/guests/fair/settings');
  const f = formTracker(async (changed) => {
    const g = {}; const fair = {};
    const centsOf = (el, what) => { const c = toCents(el.value || '0'); if (c === null) throw new Error(`Enter ${what} in dollars, for example 10.00`); return c; };
    if (changed(capOn)) g.walkup_cap_on = capOn.checked;
    if (changed(capAmt)) g.walkup_cap_cents = centsOf(capAmt, 'the walk-up cap');
    if (capOn.checked && (g.walkup_cap_cents ?? s.walkup_cap_cents) == null) g.walkup_cap_cents = centsOf(capAmt, 'the walk-up cap');
    if (changed(promise)) g.price_promise_on = promise.checked;
    if (changed(closure)) g.closure_credit_on = closure.checked;
    if (changed(guar)) g.conditions_guarantee_on = guar.checked;
    if (changed(hours)) g.conditions_hours = Number(hours.value);
    if (changed(plans)) g.plans_on = plans.checked;
    if (changed(count)) g.plans_count = Number(count.value);
    if (changed(renew)) g.autorenew_on = renew.checked;
    if (changed(renewOn)) fair.renew_on = renewOn.value || null;
    if (changed(rule)) fair.renew_rule = rule.value;
    if (changed(travel)) fair.travel_minutes = Number(travel.value);
    if (Object.keys(g).length) await patch('/guests/settings', g);
    if (Object.keys(fair).length) await patch('/guests/fair/settings', fair);
    await reload(panel, promises);
  });
  const capOn = f.track(toggle({ name: 'walkup_cap_on', checked: Boolean(s.walkup_cap_on) }));
  const capAmt = f.track(input({ name: 'walkup_cap', inputmode: 'decimal', value: centsToInput(s.walkup_cap_cents ?? 1000) }));
  const promise = f.track(toggle({ name: 'price_promise_on', checked: Boolean(s.price_promise_on) }));
  const closure = f.track(toggle({ name: 'closure_credit_on', checked: Boolean(s.closure_credit_on) }));
  const guar = f.track(toggle({ name: 'conditions_guarantee_on', checked: Boolean(s.conditions_guarantee_on) }));
  const hours = f.track(select([1, 2, 3, 4, 6, 8].map((n) => [String(n), `${n} hour${n === 1 ? '' : 's'}`]), String(s.conditions_hours), { name: 'conditions_hours' }));
  const plans = f.track(toggle({ name: 'plans_on', checked: Boolean(s.plans_on) }));
  const count = f.track(select([2, 3, 4, 5, 6].map((n) => [String(n), `${n} payments`]), String(s.plans_count), { name: 'plans_count' }));
  const renew = f.track(toggle({ name: 'autorenew_on', checked: Boolean(s.autorenew_on) }));
  const renewOn = f.track(input({ type: 'date', name: 'renew_on', value: s.renew_on || '' }));
  const rule = f.track(select([['lower', 'The lower of last season\'s price and this season\'s'], ['current', 'This season\'s price']], s.renew_rule, { name: 'renew_rule' }));
  const travel = f.track(input({ type: 'number', name: 'travel_minutes', min: 1, max: 60, value: s.travel_minutes }));
  const sync = () => { capAmt.disabled = !capOn.checked; hours.disabled = !guar.checked; count.disabled = !plans.checked; renewOn.disabled = rule.disabled = !renew.checked; };
  [capOn, guar, plans, renew].forEach((el) => el.addEventListener('change', sync)); sync();
  const sect = (title) => h('h3', { class: 'fair-set-head' }, title);
  panel.append(
    h('p', { class: 'muted' }, 'Promises that make buying feel fair. Each is off until you turn it on. When one is on, the online shop shows its badge.'),
    s.badges.length ? h('div', { class: 'fair-badges', 'aria-label': 'Badges the shop shows now' }, s.badges.map((b) => h('span', { class: 'fair-badge', title: b.detail }, b.text))) : null,
    sect('Prices'),
    row('Walk-up cap', capOn, 'The ticket window never charges more than this over the best online price for the same ticket and day. The cashier sees "walk-up cap applied". Costs you the difference on busy walk-up days.'),
    row('Most over the online price', amount(capAmt, 'dollars')),
    row('Price-drop promise', promise, 'If a guest bought a ticket online and the price for that day goes down later, the difference goes back to their card automatically, with an email. Window and cash sales are not included.'),
    sect('Bad days'),
    row('Closure credits', closure, 'When you close the mountain or the main lifts, guests with a ticket for that day who did not ski get a credit for another day this season. You see who first, then give them.'),
    row('Conditions guarantee', guar, 'The guest\'s email has a link. Within the hours below of their first lift, they tap "Conditions were not good" and get a credit for another day. You can turn it off for one day.'),
    row('Guests can ask within', hours),
    sect('Passes'),
    s.cards_ready ? null : h('div', { class: 'notice warn', role: 'status' }, 'Payment plans and auto-renew need card payments. Connect your Stripe account in Settings, Payments and card readers.'),
    row('Payment plans', plans, 'Season passes (and products you mark below) can be paid in monthly payments on your own Stripe account. A missed payment is tried twice more over a week; then the pass is held at the gate until paid.'),
    row('Number of payments', count),
    row('Auto-renew', renew, 'Pass holders can say yes from their account. They get an email a week before, then their saved card is charged on the renewal day.'),
    row('Renewal day', renewOn, 'Set it before your early price ends.'),
    row('Renewal price', rule),
    sect('Scan review'),
    row('Flag a pass seen at two lifts within', amount(travel, 'minutes'), 'Scans closer together than this at different lifts go to the scan review list. Nothing is blocked without a manager.'),
    f.bar);
}

// ---------------------------------------------------------------- closure credits
async function closures(panel) {
  const [s, c] = await Promise.all([get('/guests/fair/settings'), get('/guests/fair/closures')]);
  if (!s.closure_credit_on) panel.append(h('p', { class: 'muted' }, 'Closure credits are off. Turn them on under Fair promises to give them.'));
  const dayIn = input({ type: 'date', name: 'day', value: c.suggested[0] ? c.suggested[0].day : s.today, max: s.today, required: true });
  const scope = select([['mountain', 'The whole mountain'], ['main_lifts', 'The main lifts']], 'mountain', { name: 'scope' });
  const from = input({ type: 'time', name: 'closed_from' });
  const reason = input({ name: 'reason', maxlength: 200, placeholder: 'For example: high winds' });
  const out = h('div', { class: 'stack', 'aria-live': 'polite' });
  const body = () => ({ day: dayIn.value, scope: scope.value, closed_from: from.value || null, reason: reason.value.trim() || null });
  const preview = button('Preview credits', async () => {
    const p = await post('/guests/fair/closures/preview', body());
    clear(out).append(
      h('p', null, h('strong', null, `${p.items.length} guest${p.items.length === 1 ? '' : 's'} would get a credit, ${money(p.total_cents)} in all.`), p.skipped ? ` ${p.skipped} ticket${p.skipped === 1 ? ' has' : 's have'} no name and no customer, so they are left out.` : ''),
      p.items.length ? table([{ head: 'Guest', cell: (r) => r.name }, { head: 'Ticket', cell: (r) => r.product }, { head: 'Why', cell: (r) => r.why }, { head: 'Credit', num: true, cell: (r) => money(r.cents) }], p.items.slice(0, 50)) : null,
      p.items.length > 50 ? h('p', { class: 'muted' }, `And ${p.items.length - 50} more.`) : null,
      p.items.length && s.closure_credit_on ? button(`Give ${p.items.length} credit${p.items.length === 1 ? '' : 's'} and email them`, async () => {
        const r = await post('/guests/fair/closures', body());
        toast(`${r.issued} credit${r.issued === 1 ? '' : 's'} given`);
        await reload(panel, closures);
      }, { kind: 'primary' }) : null);
  });
  panel.append(
    c.suggested.length ? h('div', { class: 'notice', role: 'status' }, `Marked closed in the calendar: ${c.suggested.map((d) => fmtDay(d.day)).join(', ')}. Preview the credits for ${c.suggested.length === 1 ? 'that day' : 'those days'}.`) : null,
    row('Day', dayIn), row('What closed', scope), row('Closed from', from, 'Leave empty for the whole day. With a time, guests who scanned before it do not get a credit.'), row('Reason (in the email)', reason),
    h('div', { class: 'row' }, preview), out,
    c.done.length ? h('div', { class: 'stack' }, h('h3', null, 'Credits given'), table([{ head: 'Day', cell: (r) => fmtDay(r.on_date) }, { head: 'Reason', cell: (r) => r.reason || '' }, { head: 'Guests', num: true, cell: (r) => String(r.issued_count) }, { head: 'Total', num: true, cell: (r) => money(r.issued_cents) }], c.done)) : null);
}

// ---------------------------------------------------------------- the conditions guarantee
async function guarantee(panel) {
  const [s, g] = await Promise.all([get('/guests/fair/settings'), get('/guests/fair/guarantee')]);
  const offToday = g.off_days.includes(g.today);
  const sw = toggle({ name: 'guarantee_today', checked: !offToday, disabled: !s.conditions_guarantee_on });
  sw.addEventListener('change', async () => {
    try { await put(`/guests/fair/guarantee/off/${g.today}`, { off: !sw.checked }); toast(sw.checked ? 'The guarantee is on today' : 'The guarantee is off today'); } catch (err) { sw.checked = !sw.checked; toast(err.message, 'error'); }
  });
  panel.append(
    s.conditions_guarantee_on ? null : h('p', { class: 'muted' }, 'The conditions guarantee is off. Turn it on under Fair promises.'),
    row('Offer the guarantee today', sw, 'Turn it off for a day you cannot stand behind (a storm cycle you announced, say). Guests see "the guarantee is off today".'),
    g.data.length ? table([{ head: 'When', cell: (r) => fmtDateTime(r.at) }, { head: 'Guest', cell: (r) => r.name }, { head: 'What they said', cell: (r) => (r.reason || '').replace(/^Conditions guarantee:?\s*/, '') || '' }, { head: 'Credit', num: true, cell: (r) => money(r.cents) }, { head: 'Used', cell: (r) => state(r.status === 'redeemed' ? 'Used' : 'Not yet', r.status === 'redeemed' ? 'good' : 'neutral') }], g.data)
      : empty('No guarantee credits in the last two weeks.'));
}

// ---------------------------------------------------------------- scan review
const KIND_WORDS = { two_gates: 'Two gates within a minute', far_apart: 'Two lifts too far apart', failed_reloads: 'Many failed reloads' };
function evidence(f) {
  const e = f.evidence || {};
  if (f.kind === 'failed_reloads') return `${e.failures} failed reloads on card ${e.uid}`;
  return (e.scans || []).map((s) => `${s.location || 'Gate'} at ${fmtDateTime(s.at)}`).join(', then ') + (e.seconds !== undefined ? ` (${Math.round(e.seconds / 60) || '<1'} min apart)` : '');
}
function blockDialog(panel, { ticketId = null, flagId = null, who = null }) {
  const code = ticketId ? null : input({ name: 'code', required: true, autocomplete: 'off', placeholder: 'Scan or type the code' });
  const reason = h('textarea', { name: 'reason', required: true, maxlength: 300, rows: 3, placeholder: 'For example: this pass was used at two lifts at the same time on Sat, Dec 12.' });
  formDialog(who ? `Put ${who}'s pass on hold` : 'Put a pass on hold', h('div', { class: 'stack' },
    code ? field('Ticket or pass code', code) : null,
    field('Reason (the guest reads this)', reason, 'Say what happened in plain words. The guest gets an email with this reason and a page to answer.')), async (fd) => {
    const r = await post('/guests/fair/blocks', { ...(ticketId ? { ticket_id: ticketId } : { code: val(fd, 'code') }), flag_id: flagId, reason: val(fd, 'reason') });
    toast(r.emailed ? 'On hold. The guest was emailed.' : 'On hold. There is no email for this guest, so tell them at the window.');
    await reload(panel, review);
  }, { submitText: 'Put on hold' });
}
async function review(panel) {
  const r = await get('/guests/fair/review');
  const open = r.flags.filter((f) => f.status === 'open');
  const person = (x) => h('div', { class: 'fair-who' }, x.photo ? h('img', { src: x.photo, alt: `Photo of ${x.name || 'the holder'}`, width: 40, height: 40 }) : null, h('div', null, h('strong', null, x.name || 'No name'), h('div', { class: 'muted small' }, [x.product, x.code].filter(Boolean).join(', '))));
  panel.append(
    h('p', { class: 'muted' }, 'Unusual scans land here with what was seen. Nothing is blocked unless a manager does it, and the guest always gets the reason and a way to answer.'),
    h('div', { class: 'row' }, button('Check today\'s scans now', async () => { const x = await post('/guests/fair/review/check'); toast(`${x.flagged} new`); await reload(panel, review); }),
      button('Put a pass on hold', () => blockDialog(panel, {}))),
    h('h3', null, `To look at (${open.length})`),
    open.length ? table([{ head: 'Holder', cell: person }, { head: 'What', cell: (f) => h('div', null, h('strong', null, KIND_WORDS[f.kind]), h('div', { class: 'muted small' }, evidence(f))) },
      { actions: true, cell: (f) => h('div', { class: 'row' }, f.ticket_id ? button('Put on hold', () => blockDialog(panel, { ticketId: f.ticket_id, flagId: f.id, who: f.name }), { small: true, label: `Put ${f.name || 'this'} pass on hold` }) : null,
        button('Looks fine', async () => { await post(`/guests/fair/flags/${f.id}/dismiss`); await reload(panel, review); }, { small: true, label: `Dismiss the flag for ${f.name || 'this pass'}` })) }], open) : empty('Nothing to look at.'),
    h('h3', null, 'Passes on hold'),
    r.blocks.length ? table([{ head: 'Holder', cell: person }, { head: 'Reason', cell: (b) => b.reason },
      { head: 'Guest\'s answer', cell: (b) => (b.reply ? h('div', null, h('div', null, b.reply), h('div', { class: 'muted small' }, fmtDateTime(b.replied_at))) : h('span', { class: 'muted' }, 'No answer yet')) },
      { head: 'Status', cell: (b) => state(b.status === 'active' ? 'On hold' : 'Lifted', b.status === 'active' ? 'bad' : 'good') },
      { actions: true, cell: (b) => (b.status === 'active' ? button('Unblock', () => formDialog(`Unblock ${b.name || 'this pass'}`, field('Note to the guest (optional)', h('textarea', { name: 'note', maxlength: 300, rows: 2 })), async (fd) => { await post(`/guests/fair/blocks/${b.id}/lift`, { note: val(fd, 'note') }); toast('Unblocked. The guest was emailed.'); await reload(panel, review); }, { submitText: 'Unblock' }), { small: true, label: `Unblock ${b.name || 'this pass'}` }) : null) }], r.blocks) : empty('No passes on hold.'));
}

// ---------------------------------------------------------------- payment plans
function planDialog(panel, p) {
  const body = h('div', { class: 'stack' },
    h('p', null, `${p.name || 'Guest'}${p.email ? `, ${p.email}` : ''}. Order ${p.order_id}. ${money(p.paid_cents)} paid of ${money(p.total_cents)}.`, p.card ? ` Card ending ${p.card.last4}.` : ''),
    table([{ head: 'Payment', cell: (c) => `${c.n} of ${p.count}` }, { head: 'Day', cell: (c) => fmtDay(c.next_try_on || c.due_on) }, { head: 'Amount', num: true, cell: (c) => money(c.cents) },
      { head: 'Status', cell: (c) => h('div', null, CHARGE_STATE[c.status] || c.status, c.last_error ? h('div', { class: 'muted small' }, c.last_error) : null) }], p.charges),
    p.note ? h('p', { class: 'muted' }, p.note) : null);
  const done = ['paid', 'settled', 'canceled'].includes(p.status);
  const actions = done ? null : h('div', { class: 'row' },
    button('Charge now', async () => { const r = await post(`/guests/fair/plans/${p.id}/charge`); toast(r.result === 'paid' ? 'Paid' : 'The card did not go through'); await reload(panel, plansView); }),
    button('Settle', () => formDialog('Settle this plan', field('How was the rest paid?', input({ name: 'note', maxlength: 300, placeholder: 'For example: paid in cash at the window' })), async (fd) => { await post(`/guests/fair/plans/${p.id}/settle`, { note: val(fd, 'note') }); toast('Settled. The pass works.'); await reload(panel, plansView); }, { submitText: 'Settle' })),
    button('Cancel plan', () => confirmDialog('Cancel this plan?', 'Nothing more will be charged, and the pass stays on hold at the gate until you settle or refund it.', 'Cancel plan', async () => { await post(`/guests/fair/plans/${p.id}/cancel`, {}); await reload(panel, plansView); }, { danger: true })));
  formDialog(`Payment plan ${p.id}`, h('div', { class: 'stack' }, body, actions), async () => {}, { submitText: 'Close', wide: true });
}
async function plansView(panel) {
  const { data } = await get('/guests/fair/plans');
  panel.append(data.length ? table([{ head: 'Guest', cell: (p) => p.name || p.email || 'Guest' }, { head: 'Paid', num: true, cell: (p) => `${money(p.paid_cents)} of ${money(p.total_cents)}` },
    { head: 'Next', cell: (p) => { const n = p.charges.find((c) => ['due', 'failed'].includes(c.status)); return n ? `${fmtDay(n.next_try_on || n.due_on)}, ${money(n.cents)}` : ''; } },
    { head: 'Status', cell: (p) => state(...(PLAN_STATE[p.status] || [p.status, 'neutral'])) },
    { actions: true, cell: (p) => button('Open', () => planDialog(panel, p), { small: true, label: `Open the plan for ${p.name || 'this guest'}` }) }], data) : empty('No payment plans yet. They start when a guest picks "Pay in" at the online shop.'));
}

// ---------------------------------------------------------------- passes: plans, caps, the waitlist, renewals
async function passes(panel) {
  const [{ data }, ren] = await Promise.all([get('/guests/fair/waitlist'), get('/guests/fair/renewals')]);
  if (!data.length) panel.append(empty('No season passes, multi-day tickets or punch cards yet.'));
  for (const p of data) {
    const cap = input({ type: 'number', min: 1, name: `cap-${p.product_id}`, value: p.cap ?? '', placeholder: 'No cap', 'aria-label': `Cap for ${p.name}` });
    const plan = toggle({ checked: p.plan_ok, disabled: p.kind === 'season_pass', 'aria-label': `${p.name} can be paid in a plan` });
    const save = button('Save', async () => { await put(`/guests/fair/products/${p.product_id}`, { cap: cap.value ? Number(cap.value) : null, ...(p.kind === 'season_pass' ? {} : { plan_ok: plan.checked }) }); toast('Saved'); await reload(panel, passes); }, { small: true, label: `Save ${p.name}` });
    panel.append(h('div', { class: 'fair-pass' },
      infoRow(p.name, p.cap !== null ? `${p.sold} sold of ${p.cap}${p.left !== null ? `, ${p.left} open` : ''}. ${p.waiting.length} on the waitlist.` : 'No cap.', save),
      row('Most sold (a waitlist opens when full)', amount(cap, 'passes')),
      row('Can be paid in a plan', plan, p.kind === 'season_pass' ? 'Season passes always can when plans are on.' : null),
      p.waiting.length ? table([{ head: 'Waiting', cell: (w) => `${w.first_name} ${w.last_name}` }, { head: 'Email', cell: (w) => w.email }, { head: 'Status', cell: (w) => (w.status === 'offered' ? state(`Offered until ${fmtDateTime(w.offer_expires_at)}`, 'warn') : state('Waiting')) }], p.waiting) : null));
  }
  panel.append(h('h3', null, 'Renew automatically'),
    ren.data.length ? table([{ head: 'Guest', cell: (r) => r.name }, { head: 'Pass', cell: (r) => r.pass }, { head: 'Auto-renew', cell: (r) => state(r.status === 'on' ? 'On' : 'Off', r.status === 'on' ? 'good' : 'neutral') },
      { head: 'Card', cell: (r) => (r.has_card ? `Ending ${r.last4}` : h('span', { class: 'muted' }, 'None yet')) }, { head: 'Last', cell: (r) => (r.last_error ? state('Did not go through', 'bad') : r.renewed_for ? `Renewed for ${r.renewed_for}` : '') }], ren.data) : empty('Nobody has turned on auto-renew yet.'));
}

export const settingsPages = {
  fair: { title: 'Fair promises', render: (panel) => promises(panel), who: 'manager' },
  closures: { title: 'Closure credits', render: (panel) => closures(panel), who: 'manager' },
  guarantee: { title: 'Conditions guarantee', render: (panel) => guarantee(panel), who: 'manager' },
  review: { title: 'Scan review', render: (panel) => review(panel), who: 'manager' },
  plans: { title: 'Payment plans', render: (panel) => plansView(panel), who: 'manager' },
  passes: { title: 'Pass caps, waitlist and auto-renew', render: (panel) => passes(panel), who: 'manager' },
};
