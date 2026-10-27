// A witness writes what they saw in their own words (/w/<token>), from a link the ski patrol sent or showed them.
// It shows only the mountain, when and where: never the patient. The statement, their details and their signature go
// to the patrol's case as written. The link works once.
import { h, clear } from './ui.js';
import { signaturePad } from './sigpad.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('page');
const api = `/api/v1/public/witness-link/${encodeURIComponent(token)}`;

function closed(text) {
  clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Witness statement'), h('p', null, text)));
}

async function main() {
  let page;
  try {
    const res = await fetch(api);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { closed(data.error || 'This link is not valid. If you want to give a statement, please contact the ski patrol.'); return; }
    page = data;
  } catch (_) { closed('This page could not load. Check your signal and open the link again.'); return; }
  document.title = `${page.mountain}: your witness statement`;
  const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const statement = h('textarea', { id: 'w-what', rows: 9, maxlength: 10000, required: '', placeholder: 'Where you were, what you saw and heard, in the order it happened.' });
  const name = h('input', { id: 'w-name', maxlength: 150, autocomplete: 'name', required: '', value: page.name || '' });
  const phone = h('input', { id: 'w-phone', type: 'tel', maxlength: 40, autocomplete: 'tel', value: page.phone || '' });
  const email = h('input', { id: 'w-email', type: 'email', maxlength: 255, autocomplete: 'email', value: page.email || '' });
  const address = h('input', { id: 'w-address', maxlength: 255, autocomplete: 'street-address' });
  const city = h('input', { id: 'w-city', maxlength: 100, autocomplete: 'address-level2' });
  const region = h('input', { id: 'w-region', maxlength: 60, autocomplete: 'address-level1' });
  const postal = h('input', { id: 'w-postal', maxlength: 20, autocomplete: 'postal-code' });
  const pad = signaturePad();
  const confirm = h('input', { id: 'w-true', type: 'checkbox' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, 'Send my statement');
  const clearSig = h('button', { type: 'button', class: 'btn small' }, 'Clear signature');
  clearSig.addEventListener('click', () => pad.clear());
  const form = h('form', { class: 'stack', novalidate: '' },
    h('h1', null, `${page.mountain}: your witness statement`),
    h('p', null, `About what happened on ${page.when}${page.where ? `, at ${page.where}` : ''}.`),
    h('p', null, 'Thank you for helping. Write what you saw and heard yourself, in your own words. It goes to the ski patrol exactly as you write it, and nobody changes it.'),
    lab('w-what', 'What you saw', statement),
    lab('w-name', 'Your full name', name),
    lab('w-phone', 'Cell phone', phone), lab('w-email', 'Email', email, 'A phone or an email, so the mountain can reach you if they have a question'),
    lab('w-address', 'Street address', address), lab('w-city', 'City', city), lab('w-region', 'State', region), lab('w-postal', 'ZIP code', postal),
    h('div', { class: 'field' }, h('span', null, 'Sign here with your finger'), pad.el, clearSig),
    h('label', { class: 'check', for: 'w-true' }, confirm, 'This is true and complete to the best of my knowledge.'),
    send, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const err = (text, el) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, text)); if (el && el.focus) el.focus(); };
    if (statement.value.trim().length < 10) return err('Write what you saw, in a few sentences at least.', statement);
    if (name.value.trim().length < 2) return err('Give your full name.', name);
    if (!phone.value.trim() && !email.value.trim()) return err('Give a phone number or an email address.', phone);
    if (pad.isEmpty()) return err('Sign in the box with your finger.');
    if (!confirm.checked) return err('Tick the box to confirm the statement is true.', confirm);
    let signature;
    try { signature = pad.toDataUrl(); } catch (ex) { return err(ex.message); }
    send.disabled = true;
    try {
      const body = { name: name.value.trim(), statement: statement.value.trim(), signature, confirm: true };
      for (const [k, el] of [['phone', phone], ['email', email], ['address', address], ['city', city], ['region', region], ['postal', postal]]) if (el.value.trim()) body[k] = el.value.trim();
      const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.details && data.details[0] && data.details[0].message) || data.error || 'It could not be sent. Try again.');
      clear(root).append(h('div', { class: 'help-done stack' }, h('h1', null, 'Statement sent'),
        h('p', null, `Thank you. Your statement is with the ${page.mountain} ski patrol, as you wrote it. You can close this page.`)));
    } catch (ex) {
      send.disabled = false;
      err(ex instanceof TypeError ? 'No signal: your statement is still here. Try again when you have signal.' : ex.message);
    }
  });
  clear(root).append(form);
}
main();
