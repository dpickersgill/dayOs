// The page behind the follow-up email (/f/<token>) and a mountain's giving page (/give/<mountain>).
// It never shows anything about a case. Text is always set with textContent.

import './stage.js'; // the staging band (shows only on staging)
const path = location.pathname.split('/').filter(Boolean);
const mode = path[0] === 'f' ? 'followup' : 'give';
const key = decodeURIComponent(path[1] || '');
const query = new URLSearchParams(location.search);
const root = document.getElementById('give');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v === true) el.setAttribute(k, ''); else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

async function api(method, p, body) {
  const res = await fetch(`/api/v1/public${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || 'Something went wrong. Please try again.'); e.status = res.status; throw e; }
  return json;
}

const base = mode === 'followup' ? `/followup/${key}` : `/${key}`;

function ratingCard(info, done) {
  const labels = ['Poor', 'Fair', 'Good', 'Great', 'Excellent'];
  let chosen = info.rating || 0;
  const status = h('div', { role: 'status', 'aria-live': 'polite' });
  const comment = h('textarea', { 'aria-label': 'Anything else you would like to tell us?', maxlength: '2000', placeholder: 'Anything else you would like to tell us? (optional)' });
  const send = h('button', { type: 'button', class: 'btn give-go', disabled: !chosen && true }, 'Send');
  const buttons = [1, 2, 3, 4, 5].map((n) => h('button', { type: 'button', 'aria-pressed': String(n === chosen), 'aria-label': `${n} of 5, ${labels[n - 1]}`, onclick: () => { chosen = n; buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === n))); send.disabled = false; } }, String(n), h('small', null, labels[n - 1])));
  send.addEventListener('click', async () => {
    send.disabled = true; status.replaceChildren();
    try { await api('POST', `${base}/feedback`, { rating: chosen, comment: comment.value.trim() || undefined }); card.replaceChildren(h('h2', null, 'Thank you'), h('p', null, 'Your answer helps our volunteers get better.')); }
    catch (err) { status.replaceChildren(h('div', { class: 'give-err' }, err.message)); send.disabled = false; }
  });
  const card = h('section', { class: 'give-card', 'aria-labelledby': 'rate-h' },
    h('h2', { id: 'rate-h' }, 'How did we do?'), h('div', { class: 'rate', role: 'group', 'aria-label': 'Rate us from 1 to 5' }, buttons), comment, send, status);
  if (info.responded) card.replaceChildren(h('h2', null, 'Thank you'), h('p', null, 'You have already told us how we did. We appreciate it.'));
  return card;
}

function giveCard(info) {
  const amounts = info.amounts.length ? info.amounts : [25, 50, 100, 250];
  const want = query.get('give');
  let amount = want && want !== 'other' && Number(want) >= 5 ? Number(want) : 0;
  let monthly = false;
  const status = h('div', { role: 'status', 'aria-live': 'polite' });
  const go = h('button', { type: 'button', class: 'btn give-go' }, 'Give');
  const other = h('input', { type: 'number', inputmode: 'numeric', min: '5', max: '10000', step: '1', id: 'other-amt', placeholder: 'Other amount in dollars' });
  const email = h('input', { type: 'email', id: 'give-email', autocomplete: 'email', maxlength: '255' });
  const chips = [];
  const refresh = () => {
    chips.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.amt) === amount && other.value === '')));
    go.textContent = amount ? `Give $${amount}${monthly ? ' a month' : ''}` : 'Choose an amount';
    go.disabled = !amount;
  };
  for (const a of amounts) chips.push(h('button', { type: 'button', 'data-amt': String(a), onclick: () => { amount = a; other.value = ''; refresh(); } }, `$${a}`));
  other.addEventListener('input', () => { const n = Math.floor(Number(other.value)); amount = n >= 5 && n <= 10000 ? n : 0; refresh(); });
  const tick = h('input', { type: 'checkbox', id: 'monthly', onchange: (e) => { monthly = e.target.checked; refresh(); } });
  go.addEventListener('click', async () => {
    go.disabled = true; status.replaceChildren();
    try {
      const out = await api('POST', `${base}/give`, { amount, monthly, email: email.value.trim() || undefined });
      location.href = out.url;
    } catch (err) { status.replaceChildren(h('div', { class: 'give-err' }, err.message)); refresh(); }
  });
  const card = h('section', { class: 'give-card', id: 'give-card', 'aria-labelledby': 'give-h' },
    h('h2', { id: 'give-h' }, `Help keep ${info.org} on the mountain`),
    h('p', null, `${info.org} is a volunteer, nonprofit team. Gifts pay for the training and equipment that keep the mountain safe.${info.blurb ? ` ${info.blurb}` : ''}`),
    info.giving ? [
      h('div', { class: 'amounts', role: 'group', 'aria-label': 'Choose a gift amount' }, chips),
      h('label', { class: 'f', for: 'other-amt' }, 'Another amount', other),
      h('label', { class: 'tick', for: 'monthly' }, tick, 'Make this a monthly gift'),
      h('label', { class: 'f', for: 'give-email' }, 'Email for your receipt (optional)', email),
      go, status, h('p', { class: 'give-fine' }, 'You will pay on a secure Stripe page. We never see your card number.'),
    ] : h('p', { class: 'give-note' }, 'Online giving is not switched on yet. Please contact the patrol to give.'),
    info.tax_note ? h('p', { class: 'give-fine' }, info.tax_note) : null);
  if (info.giving) refresh();
  return card;
}

function hero(info, title, sub) {
  return h('header', { class: 'give-hero' }, h('div', { class: 'in' }, h('p', { class: 'give-fine', style: 'color:#b9d0d9' }, info.org), h('h1', { id: 'give-main', tabindex: '-1' }, title), h('p', null, sub)));
}

async function main() {
  let info;
  try { info = await api('GET', mode === 'followup' ? base : `${base}/give`); }
  catch (err) {
    root.replaceChildren(h('div', { class: 'give-card', style: 'margin-top:24px' }, h('h2', null, 'This link is not working'), h('p', null, err.status === 404 ? 'We could not find this page. If you copied the link, please try clicking it from the email again.' : err.message)));
    return;
  }
  document.title = mode === 'followup' ? `How did ${info.org} do?` : `Support ${info.org}`;
  const thanks = query.get('thanks') === '1';
  if (mode === 'followup' && query.get('stop') === '1') {
    const msg = h('div');
    const btn = h('button', { type: 'button', class: 'btn give-go', onclick: async () => { btn.disabled = true; try { await api('POST', `${base}/stop`); msg.replaceChildren(h('p', { class: 'give-note' }, 'Done. You will not get any more emails from us.')); btn.remove(); } catch (err) { msg.replaceChildren(h('div', { class: 'give-err' }, err.message)); btn.disabled = false; } } }, 'Stop these emails');
    root.replaceChildren(hero(info, 'Stop these emails?', 'We will not email you again.'), h('section', { class: 'give-card' }, info.stopped ? h('p', { class: 'give-note' }, 'You have already stopped these emails.') : [btn, msg], h('a', { href: location.pathname }, 'Go back')));
    return;
  }
  const parts = [];
  if (thanks) parts.push(h('section', { class: 'give-card' }, h('h2', null, 'Thank you for your gift'), h('p', null, `Your support means a great deal to our volunteers. Stripe will email you a receipt.`)));
  if (mode === 'followup') {
    parts.unshift(hero(info, 'We hope you are doing well', 'A volunteer patroller helped you recently. We would love to hear how we did.'));
    parts.push(ratingCard(info), giveCard(info));
    parts.push(h('p', { class: 'give-stop give-fine' }, h('a', { href: `${location.pathname}?stop=1` }, 'Stop these emails')));
  } else {
    parts.unshift(hero(info, `Support ${info.org}`, 'Volunteers give their time. Your gift helps with the equipment and training.'));
    parts.push(giveCard(info));
  }
  root.replaceChildren(...parts);
  if (query.get('give') && !thanks) { const el = document.getElementById('give-card'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' }); }
}
main();
