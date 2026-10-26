// The guest's lost and found form (/lost/<mountain>), linked from the mountain's website or a QR code at Guest Services.
// It sends one report and says what happens next. It never shows anything that has been handed in.
import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('lost');
const api = `/api/v1/public/${encodeURIComponent(slug)}/lost`;

async function main() {
  document.getElementById('lost-loading')?.remove();
  let page;
  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error('off');
    page = await res.json();
  } catch (_) {
    root.append(h('h1', null, 'This form is not available'), h('p', { class: 'muted' }, 'Please call the mountain or ask at Guest Services.'));
    return;
  }
  document.title = `${page.mountain}: report something lost`;
  const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const kind = h('select', { id: 'l-kind', required: '' }, h('option', { value: '' }, 'Choose one'), page.kinds.map(([k, t]) => h('option', { value: k }, t)));
  const color = h('input', { id: 'l-color', maxlength: 40 });
  const brand = h('input', { id: 'l-brand', maxlength: 60 });
  const what = h('textarea', { id: 'l-what', rows: 3, maxlength: 255, placeholder: 'Anything that makes it yours: stickers, a name tag, what is inside' });
  const where = h('input', { id: 'l-where', maxlength: 150, placeholder: 'A lift, a trail, the lodge, the parking lot' });
  const when = h('input', { id: 'l-when', type: 'date', required: '', max: page.today, value: page.today });
  const name = h('input', { id: 'l-name', maxlength: 120, autocomplete: 'name', required: '' });
  const email = h('input', { id: 'l-email', type: 'email', maxlength: 255, autocomplete: 'email' });
  const phone = h('input', { id: 'l-phone', type: 'tel', maxlength: 40, autocomplete: 'tel' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, 'Send report');
  const form = h('form', { class: 'stack', novalidate: '' },
    h('h1', null, `${page.mountain}: report something lost`),
    h('p', null, 'Tell us what you lost. If it is handed in, we will email or text you. Please do not include card numbers.'),
    lab('l-kind', 'What did you lose?', kind), lab('l-color', 'Color', color), lab('l-brand', 'Brand or make', brand), lab('l-what', 'Anything else that would help', what),
    lab('l-where', 'Where do you think you lost it?', where), lab('l-when', 'When?', when),
    lab('l-name', 'Your name', name), lab('l-email', 'Email', email), lab('l-phone', 'Cell phone', phone, 'An email address or a phone number, so we can tell you'),
    h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), send, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const err = (text, el) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, text)); if (el) el.focus(); };
    if (!kind.value) return err('Choose what you lost.', kind);
    if (name.value.trim().length < 2) return err('Give your name.', name);
    if (!email.value.trim() && !phone.value.trim()) return err('Give an email address or a phone number, so we can tell you.', email);
    send.disabled = true;
    try {
      const body = { kind: kind.value, lost_on: when.value, name: name.value.trim(), website: trap.value || undefined };
      for (const [k, el] of [['color', color], ['brand', brand], ['description', what], ['lost_where', where], ['email', email], ['phone', phone]]) if (el.value.trim()) body[k] = el.value.trim();
      const res = await fetch(api, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send. Please call the mountain.');
      clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Report sent'),
        h('p', null, 'Thank you. We check what is handed in against your report, and we will contact you if we find it. Items are kept for a few weeks.')));
    } catch (ex) {
      send.disabled = false;
      err(ex.message);
    }
    return null;
  });
  root.append(form);
}
main();
