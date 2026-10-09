// Public guest help page, opened from a QR code on a trail sign (/help/<mountain>?loc=Ridge+Run).
// It sends one request to the public API and shows a reference number. It never shows anything about patrol.

import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('help');
const api = `/api/v1/public/${encodeURIComponent(slug)}/help`;

function note(text) { return h('p', { class: 'muted' }, text); }

async function main() {
  document.getElementById('help-loading')?.remove();
  let page;
  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error('off');
    page = await res.json();
  } catch (_) {
    root.append(h('h1', null, 'Online help is not available'), note('Please flag down a patroller or call 911 for an emergency.'));
    return;
  }
  document.title = `${page.mountain}: ask ski patrol for help`;
  const where = h('input', { id: 'help-where', name: 'location', required: '', maxlength: 120, autocomplete: 'off', list: 'help-places' });
  const places = h('datalist', { id: 'help-places' }, page.places.map((p) => h('option', { value: p })));
  where.value = (new URLSearchParams(location.search).get('loc') || '').slice(0, 120);
  const what = h('textarea', { id: 'help-what', name: 'description', rows: 3, maxlength: 300, placeholder: 'What happened? How many people? Is anyone bleeding or unable to move?' });
  const name = h('input', { id: 'help-name', name: 'name', maxlength: 60, autocomplete: 'name' });
  const phone = h('input', { id: 'help-phone', name: 'phone', type: 'tel', maxlength: 30, autocomplete: 'tel' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, 'Send request to patrol');
  const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const form = h('form', { class: 'stack', novalidate: '' },
    h('h1', null, `${page.mountain}: ask patrol for help`),
    page.message ? h('p', { class: 'help-msg' }, page.message) : null,
    lab('help-where', 'Where are you?', where, 'A trail name, lift, or landmark. The sign you scanned helps.'), places,
    lab('help-what', 'What is wrong?', what),
    lab('help-name', 'Your name (optional)', name),
    lab('help-phone', 'Phone number so patrol can reach you (optional)', phone),
    h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap),
    send, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    if (where.value.trim().length < 2) { msg.append(h('p', { class: 'error-box', role: 'alert' }, 'Please say where you are.')); where.focus(); return; }
    send.disabled = true;
    try {
      const res = await fetch(api, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: where.value.trim(), description: what.value.trim() || undefined, name: name.value.trim() || undefined, phone: phone.value.trim() || undefined, website: trap.value || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send. Please flag down a patroller or call 911.');
      clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Request sent'),
        data.reference ? h('p', null, 'Reference: ', h('b', null, data.reference)) : null,
        h('p', null, 'Patrol has your location. Stay where you are, keep warm, and keep the phone with you. If things get worse, call 911.')));
    } catch (err) {
      send.disabled = false;
      msg.append(h('p', { class: 'error-box', role: 'alert' }, err.message));
    }
  });
  root.append(form);
}
main();
