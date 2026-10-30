// A gift experience (/gift/<mountain>/<private link>): the reveal, then "Add it to my account" (once), which starts or
// joins the household account of the person receiving it. Also the gift card balance page (/gift-balance/<mountain>).
// The reveal is a short unwrap that is skipped when the person prefers reduced motion.
import { h, clear } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean);
const mode = parts[0];
const slug = decodeURIComponent(parts[1] || '');
const token = parts[2] || '';
const root = document.getElementById('gift');
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
async function call(method, path, body) {
  const res = await fetch(`/api/v1/public/${encodeURIComponent(slug)}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again or call the mountain.');
  return data;
}
const lab = (id, text, el) => h('div', { class: 'field' }, h('label', { for: id }, text), el);

async function reveal() {
  let g;
  try { g = await call('GET', `/gift/${encodeURIComponent(token)}`); } catch (_) { clear(root).append(h('main', { class: 'gift-wrap' }, h('section', { class: 'gift-card' }, h('h1', null, 'We could not find this gift'), h('p', null, 'Check the link in your email, or call the mountain.')))); return; }
  document.title = `${g.mountain}: a gift for you`;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inside = h('div', { class: 'gift-inside', hidden: !still && !g.redeemed });
  const box = h('button', { type: 'button', class: 'gift-box', 'aria-label': 'Open your gift', hidden: still || g.redeemed }, h('span', { class: 'gift-lid', 'aria-hidden': 'true' }), h('span', { class: 'gift-base', 'aria-hidden': 'true' }), h('span', { class: 'gift-tap' }, 'Tap to open'));
  box.addEventListener('click', () => { box.classList.add('open'); setTimeout(() => { box.hidden = true; inside.hidden = false; inside.querySelector('h2').focus(); }, 650); });
  const what = [...g.includes, g.amount_cents ? `${money(g.amount_cents)} to spend` : null].filter(Boolean);
  const done = (x) => h('div', { class: 'stack' }, h('p', { class: 'gift-code-label' }, 'Your gift code'), h('p', { class: 'gift-code' }, x.code),
    h('p', null, `Worth ${money(x.balance_cents)}. Show this code at the ticket window, or tell them it is a gift experience. It is in your account too.`),
    h('a', { class: 'btn primary', href: x.account }, 'Open my account'));
  const f = h('input', { id: 'g-f', autocomplete: 'given-name', maxlength: 60, required: true });
  const l = h('input', { id: 'g-l', autocomplete: 'family-name', maxlength: 60, required: true });
  const b = h('input', { id: 'g-b', type: 'date' });
  const msg = h('p', { role: 'alert', class: 'error-box', hidden: true });
  const go = h('button', { type: 'submit', class: 'btn primary big' }, 'Add it to my account');
  const form = h('form', { class: 'stack', novalidate: true }, h('p', null, 'Add it to your account to keep it safe. We send you a sign-in link.'),
    h('div', { class: 'gift-cols' }, lab('g-f', 'First name', f), lab('g-l', 'Last name', l), lab('g-b', 'Birthday (optional, sets the ticket price)', b)), msg, go);
  const slot = h('div', { class: 'stack', 'aria-live': 'polite' }, g.redeemed ? done(g) : form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.hidden = true;
    if (!f.value.trim() || !l.value.trim()) { msg.textContent = 'Add your first and last name.'; msg.hidden = false; return; }
    go.disabled = true;
    try { const x = await call('POST', `/gift/${encodeURIComponent(token)}/redeem`, { first_name: f.value.trim(), last_name: l.value.trim(), ...(b.value ? { date_of_birth: b.value } : {}) }); clear(slot).append(done(x)); } catch (ex) { msg.textContent = ex.message; msg.hidden = false; go.disabled = false; }
  });
  inside.append(h('p', { class: 'gift-eyebrow' }, g.mountain), h('h2', { tabindex: '-1' }, g.theme), h('p', { class: 'gift-from' }, `For ${g.recipient_name}, from ${g.from_name}`),
    g.message ? h('blockquote', { class: 'gift-msg' }, g.message) : null,
    what.length ? h('ul', { class: 'gift-what', 'aria-label': 'What it includes' }, what.map((x) => h('li', null, x))) : null, slot);
  clear(root).append(h('main', { class: 'gift-wrap' }, h('section', { class: 'gift-card' }, h('h1', { class: 'gift-h1' }, `A gift for you, ${g.recipient_name.split(' ')[0]}`), box, inside)));
}

function balance() {
  document.title = 'Gift card balance';
  const code = h('input', { id: 'b-code', autocomplete: 'off', maxlength: 20, required: true, autocapitalize: 'characters' });
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Check the balance');
  const form = h('form', { class: 'stack', novalidate: true }, lab('b-code', 'Gift card code', code), go, out);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(out);
    if (!code.value.trim()) return;
    try {
      const r = await call('POST', '/gift-balance', { code: code.value.trim() });
      out.append(r.found ? h('p', { class: 'gift-balance' }, h('b', null, money(r.balance_cents)), ` left of ${money(r.initial_cents)}${r.expires_on ? `. Good until ${r.expires_on}` : ''}.`) : h('p', { class: 'error-box' }, 'We could not find that code. Check it and try again, or call the mountain.'));
    } catch (ex) { out.append(h('p', { class: 'error-box' }, ex.message)); }
  });
  clear(root).append(h('main', { class: 'gift-wrap' }, h('section', { class: 'gift-card' }, h('h1', { class: 'gift-h1' }, 'Gift card balance'), h('p', null, 'Type the code from the gift card or the email.'), form)));
}

if (mode === 'gift-balance') balance(); else reveal();
