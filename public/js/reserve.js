// Partner pass holders reserve a free day (/reserve/<mountain>), when the mountain allows it: the pass number and level,
// the day, their name and date of birth, an email for the confirmation, and the waiver. They get a ticket with a
// barcode; photo ID is checked when they collect it. The discount day is bought at the ticket window.
import { h, clear } from './ui.js';
import { code128 } from './barcode.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('reserve');
const api = `/api/v1/public/${encodeURIComponent(slug)}/partner`;
const nice = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

async function main() {
  document.getElementById('reserve-loading')?.remove();
  let page;
  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error('off');
    page = await res.json();
  } catch (_) {
    root.append(h('h1', null, 'Reservations are not available'), h('p', { class: 'muted' }, 'Please call the mountain.'));
    return;
  }
  if (!page.programs.length) {
    root.append(h('h1', null, `${page.mountain}`), h('p', null, 'Online reservations for partner passes are not open right now.'), page.phone ? h('p', null, `Questions? Call ${page.phone}.`) : null);
    return;
  }
  document.title = `${page.mountain}: reserve your day`;
  const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const prog = h('select', { id: 'r-prog' }, page.programs.map((p) => h('option', { value: String(p.id) }, p.name)));
  const level = h('select', { id: 'r-level' });
  const number = h('input', { id: 'r-number', maxlength: 60, autocomplete: 'off', required: '' });
  const date = h('input', { id: 'r-date', type: 'date', min: page.today, max: page.last_day, required: '' });
  const first = h('input', { id: 'r-first', maxlength: 100, autocomplete: 'given-name', required: '' });
  const last = h('input', { id: 'r-last', maxlength: 100, autocomplete: 'family-name', required: '' });
  const dob = h('input', { id: 'r-dob', type: 'date', max: page.today, required: '' });
  const email = h('input', { id: 'r-email', type: 'email', maxlength: 255, autocomplete: 'email', required: '' });
  const phone = h('input', { id: 'r-phone', type: 'tel', maxlength: 40, autocomplete: 'tel' });
  const waiver = h('input', { id: 'r-waiver', type: 'checkbox' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const rules = h('p', { class: 'muted' });
  const dayNote = h('p', { class: 'small', role: 'status' });
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, 'Reserve my day');
  const current = () => page.programs.find((p) => String(p.id) === prog.value);
  const numberLabel = h('label', { for: 'r-number' });
  const sync = () => {
    const p = current();
    clear(level).append(...p.levels.map((l) => h('option', { value: l.key }, l.label)));
    numberLabel.textContent = p.number_label;
    rules.textContent = `${p.free_days} free day${p.free_days === 1 ? '' : 's'} here each season${p.discount_days ? `, then ${p.discount_days} at ${p.discount_percent}% off at the ticket window` : ''}.${p.id_check ? ' Bring photo ID that matches your pass account.' : ''}`;
    checkDay();
  };
  const checkDay = () => {
    const p = current(); const d = date.value;
    const lv = p.levels.find((l) => l.key === level.value);
    dayNote.textContent = !d ? '' : p.full.includes(d) ? `${nice(d)} is full. Choose another day.` : (lv && lv.blackouts && p.blackouts.includes(d)) ? `${nice(d)} is a blackout date for ${lv.label}.` : '';
  };
  prog.addEventListener('change', sync); level.addEventListener('change', checkDay); date.addEventListener('change', checkDay);
  const form = h('form', { class: 'stack', novalidate: '' },
    h('h1', null, `${page.mountain}: reserve your day`), rules,
    page.programs.length > 1 ? lab('r-prog', 'Pass', prog) : null,
    h('div', { class: 'field' }, numberLabel, number), lab('r-level', 'Which pass', level), lab('r-date', 'Day', date), dayNote,
    lab('r-first', 'First name', first), lab('r-last', 'Last name', last), lab('r-dob', 'Date of birth', dob),
    lab('r-email', 'Email', email, 'Your confirmation and ticket come here'), lab('r-phone', 'Cell phone', phone),
    page.waiver_text ? h('details', null, h('summary', null, 'Read the waiver'), h('p', { class: 'small', style: 'white-space:pre-wrap' }, page.waiver_text)) : null,
    page.waiver_text ? h('label', { class: 'check', for: 'r-waiver' }, waiver, 'I have read and accept the waiver (under 18: a parent signs at the ticket window)') : null,
    h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), send, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    const err = (text, el) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, text)); if (el) el.focus(); };
    if (number.value.trim().length < 3) return err(`Enter your ${current().number_label.toLowerCase()}.`, number);
    if (!date.value) return err('Choose the day.', date);
    if (dayNote.textContent) return err(dayNote.textContent, date);
    if (!first.value.trim() || !last.value.trim()) return err('Give your name as it is on your pass.', first);
    if (!dob.value) return err('Give your date of birth.', dob);
    if (!email.value.trim()) return err('Give an email address for your confirmation.', email);
    send.disabled = true;
    try {
      const body = { number: number.value.trim(), level: level.value, date: date.value, first_name: first.value.trim(), last_name: last.value.trim(), date_of_birth: dob.value, email: email.value.trim(), waiver_accepted: waiver.checked, website: trap.value || undefined };
      if (phone.value.trim()) body.phone = phone.value.trim();
      const res = await fetch(`${api}/${prog.value}/reserve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not reserve. Please call the mountain.');
      clear(root).append(h('div', { class: 'help-done stack' },
        h('h1', null, `See you ${nice(data.date)}`),
        h('p', null, `Your ${data.program} day at ${data.mountain} is reserved: free day ${data.free_day} of ${data.free_days} this season. We have emailed you the details.`),
        h('div', { class: 'qr-box' }, code128(data.code)), h('p', { class: 'small' }, `Ticket ${data.code}`),
        data.id_check ? h('p', null, 'Bring photo ID that matches your pass account. We check it when you collect your ticket or card.') : null,
        data.waiver_to_sign ? h('p', null, 'Your waiver still needs signing: do it at the ticket window.') : null));
    } catch (ex) {
      send.disabled = false;
      err(ex.message);
    }
  });
  root.append(form);
  sync();
}
main();
