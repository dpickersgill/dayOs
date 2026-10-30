// Fair by design guest pages, one private link each, from an email:
// - /guarantee/<mountain>/<token>: the conditions guarantee on a day ticket. Within the hours after the first lift, one
//   tap ("Conditions were not good"), a confirm, and a credit for another day this season. No desk visit.
// - /blocked/<mountain>/<token>: a pass a manager put on hold: the reason, and the guest's reply.
// - /plan/<mountain>/<token>: a payment plan: the schedule, what is paid, and "Update card".
// - /renew/<mountain>/<token>: auto-renew for a season pass: on or off, the price and the day, the card.
// - /pass-offer/<mountain>/<token>: a place opened for a capped pass: buy it, or let the next guest have it.
// The page shows only what the link is for, and never another guest's details.

import './stage.js'; // the staging band (shows only on staging)
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const kind = parts[0] || '';
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}/${kind}/${encodeURIComponent(token)}`;

async function call(method, path = '', body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    throw new Error('We could not reach the mountain. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('This link is not valid any more. Please use the newest email, or call the mountain.');
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again, or call the mountain.');
  return data;
}

const money = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const asDay = (s) => new Date(`${String(s).slice(0, 10)}T12:00:00Z`);
const dayText = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(asDay(s));
const clock = (iso) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const when = (iso) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover' };
const cardText = (c) => (c ? `${BRANDS[c.brand] || 'Card'}${c.last4 ? ` ending ${c.last4}` : ''}` : 'No card yet');

const TITLES = { guarantee: 'Conditions guarantee', blocked: 'Your pass is on hold', plan: 'Your payment plan', renew: 'Renew your pass', 'pass-offer': 'A place opened for you' };

function hero(v, title) {
  const tel = v && v.phone ? `tel:${String(v.phone).replace(/[^\d+]/g, '')}` : null;
  return h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    h('div', { class: 'eyebrow' }, v && v.mountain ? v.mountain : 'Your mountain'), h('h1', null, title),
    tel ? h('div', { class: 'chips-row' }, h('a', { class: 'call', href: tel }, `Call ${v.phone}`)) : null));
}
function page(v, title, ...cards) {
  clear(root).append(hero(v, title), h('main', { class: 'fair', id: 'fair-main' }, ...cards));
  const first = root.querySelector('[data-focus]');
  if (first) first.focus();
}
function failPage(message) { page(null, TITLES[kind] || 'Your ticket', h('div', { class: 'card fair-err', role: 'alert' }, message)); }
const status = (text, tone = '') => h('div', { class: `fair-status ${tone}`, role: 'status' }, text);
const errLine = () => h('div', { class: 'fair-err', role: 'alert', hidden: true });
function busyRun(btn, err, fn) {
  return async () => {
    btn.disabled = true; err.hidden = true;
    try { await fn(); } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
  };
}

// ---------------------------------------------------------------- the conditions guarantee
function guarantee(v) {
  const who = v.ticket.first_name ? `${v.ticket.first_name}'s ` : 'Your ';
  const what = h('section', { class: 'card fair-what', 'aria-label': 'Your ticket' }, h('span', { class: 'big' }, `${who}${v.ticket.product}`), h('span', null, dayText(v.ticket.day)));
  if (v.state === 'claimed') {
    return page(v, TITLES.guarantee, status('Done. Your credit is ready.', 'good'), what,
      h('section', { class: 'card' }, h('h2', null, `A credit of ${money(v.reward.cents)}`), h('div', { class: 'fair-code', 'aria-label': 'Your credit code' }, v.reward.code),
        h('p', null, `Good through ${dayText(v.reward.valid_to)}. Show this code at the ticket window, or use it when you buy online. We emailed it to you too.`),
        h('p', { class: 'fair-note' }, 'Sorry the day was not what you hoped for. We hope to see you again soon.')));
  }
  if (v.state !== 'open') return page(v, TITLES.guarantee, status(v.why, v.state === 'waiting' ? '' : 'warn'), what);
  const err = errLine();
  const note = h('textarea', { name: 'note', maxlength: 300, placeholder: 'For example: icy, or lifts closed' });
  const ask = h('button', { type: 'button', class: 'btn primary big', 'data-focus': '' }, 'Conditions were not good');
  const yes = h('button', { type: 'button', class: 'btn primary big' }, `Yes, give me the ${money(v.credit_cents)} credit`);
  const no = h('button', { type: 'button', class: 'btn' }, 'Back');
  const confirm = h('div', { class: 'card', hidden: true, role: 'group', 'aria-label': 'Confirm' },
    h('p', null, h('strong', null, `You get a credit of ${money(v.credit_cents)} for another day this season.`), ' You can keep skiing today. This can be used once per ticket.'),
    h('div', { class: 'fair-actions' }, yes, no));
  ask.addEventListener('click', () => { confirm.hidden = false; ask.hidden = true; yes.focus(); });
  no.addEventListener('click', () => { confirm.hidden = true; ask.hidden = false; ask.focus(); });
  yes.addEventListener('click', busyRun(yes, err, async () => guarantee(await call('POST', '', { note: note.value.trim() || null }))));
  page(v, TITLES.guarantee, what,
    h('section', { class: 'card' }, h('h2', null, 'Not happy with the conditions?'),
      h('p', null, `Tell us by ${clock(v.until)} (${v.hours} hours after your first lift) and we will give you a credit of ${money(v.credit_cents)} for another day this season. No need to visit the desk.`),
      h('label', null, 'What was wrong? (optional)', note), err, h('div', { class: 'fair-actions' }, ask)),
    confirm);
}

// ---------------------------------------------------------------- a pass on hold
function blocked(v) {
  const what = h('section', { class: 'card fair-what' }, h('span', { class: 'big' }, `${v.first_name ? `${v.first_name}'s ` : ''}${v.product || 'pass'}`), h('span', { class: 'fair-note' }, `On hold since ${when(`${String(v.since).replace(' ', 'T')}Z`)}`));
  if (v.status !== 'active') return page(v, 'Your pass works again', status('Your pass opens the lifts again. Thank you for your patience.', 'good'), what);
  const err = errLine();
  const text = h('textarea', { name: 'reply', maxlength: 2000, required: true }, v.reply || '');
  const send = h('button', { type: 'submit', class: 'btn primary big' }, v.reply ? 'Update my answer' : 'Send my answer');
  const form = h('form', { class: 'card' }, h('h2', null, 'Tell us your side'),
    h('p', null, 'If we got this wrong, or there is something we should know, write it here. A manager reads every answer and replies by email.'),
    h('label', null, 'Your answer', text), err, h('div', { class: 'fair-actions' }, send),
    v.replied_at ? h('p', { class: 'fair-note', role: 'status' }, `We have your answer from ${when(`${String(v.replied_at).replace(' ', 'T')}Z`)}. You can add to it.`) : null);
  form.addEventListener('submit', (e) => { e.preventDefault(); busyRun(send, err, async () => blocked(await call('POST', '', { reply: text.value.trim() })))(); });
  page(v, TITLES.blocked, status('This pass does not open the lifts for now.', 'bad'), what,
    h('section', { class: 'card' }, h('h2', null, 'Why'), h('p', { 'data-reason': '' }, v.reason)), form);
}

// ---------------------------------------------------------------- a payment plan
const PILL = { paid: 'Paid', due: 'Coming up', failed: 'Did not go through', canceled: 'Canceled', settled: 'Settled' };
const PLAN_STATUS = { active: ['On track', 'good'], paid: ['Paid in full', 'good'], settled: ['Settled', 'good'], late: ['A payment did not go through. We will try again.', 'warn'], suspended: ['A payment is overdue, so the pass is on hold at the lifts. Update your card to pay now.', 'bad'], canceled: ['This plan was canceled. Please call us.', 'warn'] };
async function addCard(btn, err) {
  return busyRun(btn, err, async () => { const r = await call('POST', '/card'); location.assign(r.url); });
}
function plan(v, flash) {
  const [words, tone] = PLAN_STATUS[v.status] || [v.status, ''];
  const err = errLine();
  const upd = h('button', { type: 'button', class: `btn${['late', 'suspended'].includes(v.status) ? ' primary' : ''} big` }, 'Update card');
  addCard(upd, err).then((fn) => upd.addEventListener('click', fn));
  page(v, TITLES.plan, flash ? status(flash, 'good') : null, status(words, tone),
    h('section', { class: 'card fair-what' }, h('span', { class: 'big' }, `${v.holder ? `${v.holder}'s ` : ''}${v.what}`), h('span', null, `${money(v.paid_cents)} paid of ${money(v.total_cents)}, in ${v.count} payments`)),
    h('section', { class: 'card' }, h('h2', null, 'Payments'),
      h('table', { class: 'fair-sched' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Payment'), h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col', class: 'amt' }, 'Amount'), h('th', { scope: 'col' }, 'Status'))),
        h('tbody', null, v.charges.map((c) => h('tr', null, h('td', null, `${c.n} of ${v.count}`), h('td', null, dayText(c.next_try_on || c.due_on)), h('td', { class: 'amt' }, money(c.cents)), h('td', null, h('span', { class: `fair-pill ${c.status}` }, PILL[c.status] || c.status))))))),
    ['paid', 'settled', 'canceled'].includes(v.status) ? null : h('section', { class: 'card' }, h('h2', null, 'Your card'), h('p', null, cardText(v.card)),
      h('p', { class: 'fair-note' }, 'A new card is saved by our card processor, Stripe. Anything overdue is charged right away.'), err, h('div', { class: 'fair-actions' }, upd)));
}

// ---------------------------------------------------------------- auto-renew
function renew(v, flash) {
  const err = errLine();
  const sw = h('input', { type: 'checkbox', role: 'switch', class: 'switch', id: 'renew-on', checked: v.on, disabled: !v.available && !v.on });
  sw.addEventListener('change', busyRun(sw, err, async () => renew(await call('POST', '', { on: sw.checked }), sw.checked ? 'Auto-renew is on.' : 'Auto-renew is off.')));
  const add = h('button', { type: 'button', class: `btn${v.on && !v.card ? ' primary' : ''} big` }, v.card ? 'Use another card' : 'Add a card');
  addCard(add, err).then((fn) => add.addEventListener('click', fn));
  page(v, TITLES.renew, flash ? status(flash, 'good') : null,
    v.last_error && v.on ? status('The last try to renew did not go through. Add or update your card and we will try again tomorrow.', 'warn') : null,
    h('section', { class: 'card fair-what' }, h('span', { class: 'big' }, `${v.first_name ? `${v.first_name}'s ` : ''}${v.pass}`),
      v.renews_on && v.price_cents !== null ? h('span', null, `Renews on ${dayText(v.renews_on)} for ${money(v.price_cents)} plus any tax.`) : h('span', null, 'The mountain has not set the renewal day yet. We will email you before anything is charged.'),
      v.last_cents !== null && v.price_cents !== null && v.price_cents <= v.last_cents ? h('span', { class: 'fair-note' }, 'That is the best price: never more than you paid last time.') : null),
    h('section', { class: 'card' },
      h('label', { class: 'fair-switch', for: 'renew-on' }, h('span', null, h('strong', null, 'Renew automatically'), h('br'), h('span', { class: 'fair-note' }, 'We email you a week before. Turn it off any time before the day.')), sw),
      h('p', null, h('strong', null, 'Card: '), cardText(v.card)), err, h('div', { class: 'fair-actions' }, add)));
}

// ---------------------------------------------------------------- a waitlist offer
function offer(v) {
  if (v.status !== 'offered') {
    const words = { taken: 'You bought it. Enjoy the season!', expired: 'This offer has ended and went to the next guest. You can join the waitlist again in the shop.', left: 'Thanks for letting us know. We offered it to the next guest.', waiting: 'You are on the waitlist.' };
    return page(v, v.pass, status(words[v.status] || 'This offer is closed.', v.status === 'taken' ? 'good' : ''));
  }
  const err = errLine();
  const no = h('button', { type: 'button', class: 'btn' }, 'No thanks, offer it to the next guest');
  no.addEventListener('click', busyRun(no, err, async () => offer(await call('POST', '/decline'))));
  page(v, TITLES['pass-offer'], status(`Held for you until ${when(v.expires_at)}.`, 'good'),
    h('section', { class: 'card' }, h('h2', null, v.pass), h('p', null, `Hi ${v.first_name}, a place opened for the ${v.pass} and you are next on the waitlist.`),
      err, h('div', { class: 'fair-actions' }, h('a', { class: 'btn primary big', href: v.shop_url, 'data-focus': '' }, 'Buy it now'), no)));
}

// ---------------------------------------------------------------- start
const VIEWS = { guarantee, blocked, plan, renew, 'pass-offer': offer };
async function load() {
  const view = VIEWS[kind];
  if (!view || !slug || !token) { failPage('This link is not complete. Please use the link from your email.'); return; }
  document.title = `${TITLES[kind]}`;
  const done = new URLSearchParams(location.search).get('done');
  try {
    if (done && (kind === 'plan' || kind === 'renew')) {
      history.replaceState(null, '', location.pathname); // the card page came back: keep the new card once
      return view(await call('POST', '/card-done', { session_id: done }), 'Your new card is saved.');
    }
    view(await call('GET'));
  } catch (err) { failPage(err.message); }
}
load();
