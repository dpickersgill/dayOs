// Street alerts for residents (muni release 1), one page for four addresses:
//   /alerts/<town>                  sign up one address for texts and emails, and the notices out now
//   /alerts/<town>/<code>           one notice: what is happening, which streets, and each update
//   /alerts/<town>/manage/<token>   the link in every alert: topics, remove an address, stop texts or emails
//   /alerts/<town>/email/<token>    the link in the confirmation email (confirmed when this page posts it)
// Nothing here shows anyone else's name, phone, email or house number.
import { h, clear, appendAll } from './ui.js';

const parts = location.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
const slug = parts[1] || '';
const root = document.getElementById('alerts');
const API = `/api/v1/public/${encodeURIComponent(slug)}/alerts`;

async function call(path, body) {
  const res = await fetch(`${API}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or call the municipal office.'); e.status = res.status; throw e; }
  return data;
}
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const check = (id, text, checked, attrs = {}) => {
  const box = h('input', { type: 'checkbox', id, checked: Boolean(checked), ...attrs });
  return { box, el: h('label', { class: 'alert-check', for: id }, box, h('span', null, text)) };
};
const problem = (box, text) => { clear(box).append(h('p', { class: 'error-box', role: 'alert' }, text)); };
const notAvailable = () => clear(root).append(h('h1', null, 'This page is not available'), h('p', { class: 'muted' }, 'Please call the municipal office.'));

/** A time the server keeps in UTC ('2026-11-12 14:05:00'), in the town's own time zone. */
function whenUtc(s, tz) {
  if (!s) return '';
  try { return new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return String(s); }
}
/** A time the town typed (its own clock, '2026-11-12 14:00:00'), as written. */
function whenLocal(s) {
  if (!s) return '';
  try { return new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return String(s); }
}

// ---------------------------------------------------------------- sign up
async function signUpPage() {
  let page;
  try { page = await call(''); } catch (_) { notAvailable(); return; }
  document.title = `${page.municipality}: street alerts`;
  const live = page.notices.filter((n) => n.status === 'active');
  const now = live.length ? h('section', null, h('h2', null, 'Out now'), ...live.map((n) => h('div', { class: 'alert-card alert-live' },
    h('h2', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}/${n.code}` }, n.title)), h('p', { class: 'muted' }, `${n.type_label}. ${n.streets.join('; ')}`)))) : null;
  const street = h('select', { id: 'a-street', required: '' }, h('option', { value: '' }, 'Choose your street'), page.streets.map((s) => h('option', { value: String(s.id) }, s.name)));
  const house = h('input', { id: 'a-house', maxlength: 20, inputmode: 'text', autocomplete: 'address-line1', required: '' });
  const unit = h('input', { id: 'a-unit', maxlength: 20 });
  const name = h('input', { id: 'a-name', maxlength: 120, autocomplete: 'name' });
  const phone = h('input', { id: 'a-phone', type: 'tel', maxlength: 40, autocomplete: 'tel' });
  const email = h('input', { id: 'a-email', type: 'email', maxlength: 255, autocomplete: 'email' });
  const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const topics = page.topics.map((t) => ({ t, ...check(`a-t-${t.key}`, t.always ? `${t.label} (always on)` : t.label, true, t.always ? { disabled: true } : {}) }));
  const msg = h('div', { role: 'status' });
  const send = h('button', { type: 'submit', class: 'btn primary big' }, 'Sign up');
  const form = h('form', { class: 'stack', novalidate: '' },
    h('h1', null, `${page.municipality} street alerts`),
    h('p', null, 'Get a text or an email when a water main break, a boil water advisory, a street closure or a trash change affects your street. One address at a time; you can add more later.'),
    now,
    h('h2', null, 'Your address'),
    lab('a-street', 'Street', street), h('div', { class: 'alert-row' }, lab('a-house', 'House number', house), lab('a-unit', 'Apartment or unit', unit, 'If you have one')),
    h('h2', null, 'How to reach you'),
    lab('a-phone', 'Cell phone for texts', phone, 'We text a 6-digit code to check it is yours.'), lab('a-email', 'Email', email, 'We email a link to check it is yours.'),
    lab('a-name', 'Your name', name, 'Optional. Only office staff see it.'),
    h('h2', null, 'What to hear about'), ...topics.map((x) => x.el),
    h('p', { class: 'muted' }, `By signing up you agree to get alert texts and emails from ${page.municipality}. How often depends on what happens. Message and data rates may apply. Reply STOP to any text to stop texts; every email has a link to stop.`),
    h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), send, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(msg);
    if (!street.value) { problem(msg, 'Choose your street.'); street.focus(); return; }
    if (!house.value.trim()) { problem(msg, 'Enter your house number.'); house.focus(); return; }
    if (!phone.value.trim() && !email.value.trim()) { problem(msg, 'Give a cell phone number for texts, an email address, or both.'); phone.focus(); return; }
    send.disabled = true;
    try {
      const body = { street_id: Number(street.value), house_number: house.value.trim(), unit: unit.value.trim() || null, name: name.value.trim() || null,
        phone: phone.value.trim() || null, email: email.value.trim() || null, topics: topics.filter((x) => x.box.checked).map((x) => x.t.key), website: trap.value || undefined };
      const r = await call('', body);
      if (r.needs_code) codeStep(page, r); else emailWait(page, r);
    } catch (ex) { send.disabled = false; problem(msg, ex.message); }
  });
  clear(root).append(form);
}

function codeStep(page, r) {
  const code = h('input', { id: 'a-code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', required: '' });
  const msg = h('div', { role: 'status' });
  const go = h('button', { type: 'submit', class: 'btn primary big' }, 'Confirm');
  const again = h('button', { type: 'button', class: 'btn' }, 'Send a new code');
  const form = h('form', { class: 'stack', novalidate: '' }, h('h1', null, 'Check your phone'),
    h('p', null, `We texted a 6-digit code to the phone ${r.phone_hint}. Type it here. It works for ${r.minutes} minutes.`),
    r.email_sent ? h('p', { class: 'muted' }, 'We also emailed you a link. Press it to get alerts by email too.') : null,
    lab('a-code', 'Code', code), go, again, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(msg); go.disabled = true;
    try { done(page.municipality, await call('/confirm', { ref: r.ref, code: code.value.trim() }), 'Your phone is confirmed.'); } catch (ex) { go.disabled = false; problem(msg, ex.message); }
  });
  again.addEventListener('click', async () => {
    clear(msg); again.disabled = true;
    try { await call('/resend', { ref: r.ref }); msg.append(h('p', null, 'A new code is on its way.')); code.value = ''; code.focus(); } catch (ex) { problem(msg, ex.message); } finally { again.disabled = false; }
  });
  clear(root).append(form);
  code.focus();
}

function emailWait(page, r) {
  clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'Check your email'),
    h('p', null, r.email_sent ? 'We emailed you a link. Press it to finish signing up. Nothing is sent to you until you do.' : 'We could not send the email. Please try again.')));
}

function done(town, r, lead) {
  clear(root).append(h('div', { class: 'help-done' }, h('h1', null, 'You are signed up'),
    h('p', null, `${lead} ${town} will send you alerts for this address.`),
    h('p', null, h('a', { href: r.manage }, 'Manage your alerts'), ' (change topics or stop). Every alert email has this link too.'),
    h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'Sign up another address'))));
}

// ---------------------------------------------------------------- the email link
async function emailPage(token) {
  clear(root).append(h('p', { class: 'loading' }, 'Confirming…'));
  try {
    const r = await call('/email', { token });
    let town = '';
    try { town = (await call('')).municipality; } catch (_) { /* the words below still read well */ }
    done(town || 'We', r, 'Your email is confirmed.');
  } catch (ex) {
    clear(root).append(h('h1', null, 'This link does not work'), h('p', null, ex.message), h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'Sign up again')));
  }
}

// ---------------------------------------------------------------- manage
async function managePage(token) {
  let v;
  try { v = await call(`/manage/${encodeURIComponent(token)}`); } catch (ex) {
    clear(root).append(h('h1', null, 'This link does not work'), h('p', null, ex.message), h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'Sign up again')));
    return;
  }
  document.title = `${v.municipality}: your alerts`;
  const msg = h('div', { role: 'status' });
  const act = async (body, said) => { clear(msg); try { v = await call(`/manage/${encodeURIComponent(token)}`, body); draw(); msg.append(h('p', null, said)); } catch (ex) { problem(msg, ex.message); } };
  function draw() {
    const anyText = v.signups.some((s) => s.texts === 'on');
    const anyMail = v.signups.some((s) => s.emails === 'on');
    // A manage link is for one phone or one email: the addresses signed up through it, nothing else.
    const forWhat = v.channel === 'sms' ? `texts to the phone ${v.hint}` : `emails to ${v.hint}`;
    appendAll(clear(root), h('h1', null, `Your ${v.municipality} alerts`),
      h('p', { class: 'muted' }, `This page is for ${forWhat}. Addresses signed up with another phone or email have their own link.`),
      v.signups.length ? null : h('p', null, 'You have no addresses signed up now.'),
      ...v.signups.map((s) => {
        const boxes = v.topics.map((t) => ({ t, ...check(`m-${s.id}-${t.key}`, t.always ? `${t.label} (always on)` : t.label, s.topics.includes(t.key), t.always ? { disabled: true } : {}) }));
        const save = h('button', { type: 'button', class: 'btn' }, 'Save topics');
        save.addEventListener('click', () => act({ action: 'topics', signup_id: s.id, topics: boxes.filter((b) => b.box.checked).map((b) => b.t.key) }, 'Topics saved.'));
        const remove = h('button', { type: 'button', class: 'btn' }, 'Remove this address');
        remove.addEventListener('click', () => act({ action: 'remove', signup_id: s.id }, 'Address removed. You will not get alerts for it.'));
        const how = [s.texts && `Texts to the phone ${s.phone_hint}: ${s.texts === 'on' ? 'on' : 'stopped'}`, s.emails && `Emails to ${s.email_hint}: ${s.emails === 'on' ? 'on' : 'stopped'}`].filter(Boolean);
        return h('section', { class: 'alert-card' }, h('h2', null, `${s.house_number || ''} ${s.street}${s.unit ? `, ${s.unit}` : ''}`.trim()),
          h('p', { class: 'muted' }, how.join('. ') || 'Waiting for you to confirm your phone or email.'), ...boxes.map((b) => b.el), h('div', { class: 'row' }, save, remove));
      }),
      anyText || anyMail ? h('h2', null, 'Stop everything') : null,
      anyText ? h('button', { type: 'button', class: 'btn', onclick: () => act({ action: 'stop', channel: 'sms' }, 'Texts stopped.') }, 'Stop all texts to this phone') : null,
      anyMail ? h('button', { type: 'button', class: 'btn', onclick: () => act({ action: 'stop', channel: 'email' }, 'Emails stopped.') }, 'Stop all emails to this address') : null,
      h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'Sign up another address')), msg);
  }
  draw();
}

// ---------------------------------------------------------------- one notice
async function noticePage(code) {
  let n;
  try { n = await call(`/${encodeURIComponent(code)}`); } catch (ex) {
    clear(root).append(h('h1', null, 'Notice not found'), h('p', null, 'It may have been typed wrongly, or the notice is no longer posted.'), h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'See current notices and sign up for alerts')));
    return;
  }
  document.title = `${n.municipality}: ${n.title}`;
  const tz = n.timezone;
  const times = [n.starts_at && `Starts ${whenLocal(n.starts_at)}`, n.ends_expected_at && `Expected to end ${whenLocal(n.ends_expected_at)}`].filter(Boolean);
  appendAll(clear(root),
    h('p', { class: 'muted' }, `${n.municipality}: ${n.type_label}`),
    h('h1', null, n.title),
    h('div', { class: `alert-card ${n.status === 'ended' ? 'alert-ended' : 'alert-live'}` },
      h('p', null, h('strong', null, n.status === 'ended' ? `Ended ${whenUtc(n.ended_at, tz)}` : `Posted ${whenUtc(n.sent_at, tz)}`)),
      ...String(n.body || n.summary).split(/\n{2,}/).map((p) => h('p', null, p)),
      n.operator_note ? h('p', { class: 'muted' }, n.operator_note) : null,
      times.length ? h('p', null, times.join('. ')) : null,
      h('p', null, h('strong', null, 'Streets: '), n.streets.join('; '))),
    n.updates.length ? h('section', null, h('h2', null, 'Updates'), h('ul', { class: 'alert-updates' }, [...n.updates].reverse().map((u) => h('li', null,
      h('strong', null, `${u.kind === 'ended' ? 'Ended' : 'Update'}, ${whenUtc(u.at, tz)}`), h('p', null, u.text))))) : null,
    h('p', null, h('a', { href: `/alerts/${encodeURIComponent(slug)}` }, 'Get alerts like this by text or email')));
}

function main() {
  document.getElementById('alerts-loading')?.remove();
  if (!slug) { notAvailable(); return; }
  if (parts[2] === 'manage' && parts[3]) managePage(parts[3]);
  else if (parts[2] === 'email' && parts[3]) emailPage(parts[3]);
  else if (parts[2]) noticePage(parts[2]);
  else signUpPage();
}
main();
