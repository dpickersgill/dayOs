// The public waiver page (/waiver/<mountain>). A guest reads the waiver, says who it is for (themselves, their children, or
// both), types their name and signs with a finger. They get an emailed copy. /waiver/<mountain>?copy=<token> shows that copy;
// ?counter=1 is for a tablet at the ticket window: after each signing it clears itself for the next guest.

import { h, clear } from './ui.js';
import { signaturePad } from './sigpad.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const params = new URLSearchParams(location.search);
const copyToken = params.get('copy');
const counter = params.get('counter') === '1';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    throw new Error('We could not reach the mountain. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or ask at the ticket window.'); e.status = res.status; throw e; }
  return data;
}

const put = (el, ...kids) => { for (const k of kids) if (k) el.append(k); return el; };
let seq = 0;
const field = (text, el, hint) => { const id = el.id || `f${(seq += 1)}`; el.id = id; return h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null); };
const input = (attrs) => h('input', { ...attrs });
const longDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });

function hero(mountain, title, sub) {
  return h('header', { class: 'hero no-print' }, h('div', { class: 'hero-in' },
    h('div', { class: 'eyebrow' }, mountain), h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null));
}

function failPage(message) {
  clear(root).append(h('main', { class: 'waiver-layout', id: 'waiver-main' }, h('div', { class: 'card error-box', role: 'alert' }, message)));
}

// ---------------------------------------------------------------- the signed copy
async function showCopy() {
  let c;
  try { c = await call('GET', `/waiver/copy/${encodeURIComponent(copyToken)}`); } catch (err) { failPage(err.status === 404 ? 'We could not find that signed waiver. Check the link in your email.' : err.message); return; }
  document.title = `Signed waiver, ${c.mountain}`;
  const main = h('main', { class: 'waiver-layout', id: 'waiver-main' },
    h('section', { class: 'card stack' },
      h('h2', null, `${c.mountain} waiver, ${c.season} season`),
      h('dl', { class: 'copy-meta' },
        h('dt', null, 'Signed by'), h('dd', null, c.signer),
        h('dt', null, 'Signed on'), h('dd', null, longDate(c.signed_at)),
        h('dt', null, 'Covers'), h('dd', null, c.covered.map((p) => `${p.name}${p.relation === 'guardian' ? ' (signed by a parent or guardian)' : ''}${p.voided ? ' (voided by the mountain)' : ''}`).join(', '))),
      c.text ? h('div', { class: 'waiver-text' }, c.text) : h('p', { class: 'muted' }, 'The wording is kept by the mountain.'),
      h('div', { class: 'stack tight' }, h('strong', null, 'Signature'), h('img', { class: 'copy-sig', src: c.signature, alt: `Signature of ${c.signer}` }), h('span', { class: 'small muted' }, `Typed name: ${c.typed_name}`)),
      h('div', { class: 'no-print' }, h('button', { type: 'button', class: 'btn', onclick: () => window.print() }, 'Print or save as PDF'))));
  clear(root).append(hero(c.mountain, 'Your signed waiver', null), main);
}

// ---------------------------------------------------------------- signing
async function showForm() {
  let page;
  try { page = await call('GET', '/waiver'); } catch (err) { failPage(err.status === 404 ? 'We could not find this mountain. Check the link.' : err.message); return; }
  document.title = `Sign the ${page.mountain} waiver`;
  if (!page.open) {
    clear(root).append(hero(page.mountain, 'Sign the waiver', null), h('main', { class: 'waiver-layout', id: 'waiver-main' },
      h('div', { class: 'card' }, `${page.mountain} has not put its waiver online yet. Please ask at the ticket window${page.phone ? ` or call ${page.phone}` : ''}.`)));
    return;
  }

  const today = page.today;
  const first = input({ name: 'first_name', autocomplete: 'given-name', required: true, maxlength: 100 });
  const last = input({ name: 'last_name', autocomplete: 'family-name', required: true, maxlength: 100 });
  const dob = input({ name: 'date_of_birth', type: 'date', autocomplete: 'bday', required: true, max: today });
  const email = input({ name: 'email', type: 'email', autocomplete: counter ? 'off' : 'email', maxlength: 255 });
  const phone = input({ name: 'phone', type: 'tel', autocomplete: counter ? 'off' : 'tel', maxlength: 40 });
  const me = h('input', { type: 'checkbox', name: 'self', checked: true });
  const kidsBox = h('div', { class: 'stack' });
  const kids = [];

  function addKid() {
    const k = {
      first: input({ autocomplete: 'off', maxlength: 100 }), last: input({ autocomplete: 'off', maxlength: 100, value: last.value }),
      dob: input({ type: 'date', autocomplete: 'off', max: today }),
    };
    k.el = h('fieldset', { class: 'kid' },
      h('div', { class: 'kid-head' }, h('legend', null, `Child ${kids.length + 1}`), h('button', { type: 'button', class: 'btn link', onclick: () => { kids.splice(kids.indexOf(k), 1); k.el.remove(); renumber(); } }, 'Remove')),
      h('div', { class: 'row2' }, field('First name', k.first), field('Last name', k.last), field('Date of birth', k.dob)));
    kids.push(k);
    kidsBox.append(k.el);
    k.first.focus();
  }
  function renumber() { kids.forEach((k, i) => { k.el.querySelector('legend').textContent = `Child ${i + 1}`; }); }

  const agree = h('input', { type: 'checkbox', name: 'agree' });
  const typed = input({ name: 'typed_name', autocomplete: 'off', maxlength: 200 });
  const pad = signaturePad();
  const err = h('div', { role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary big' }, 'Sign the waiver');

  const form = h('form', { class: 'waiver-layout', id: 'waiver-main', novalidate: true },
    counter ? null : h('p', { class: 'muted' }, `For the ${page.season} season. It takes about two minutes. A parent or guardian signs for anyone under 18.`),
    h('section', { class: 'card stack' }, h('h2', null, '1. Read the waiver'), h('div', { class: 'waiver-text', tabindex: '0', 'aria-label': 'Waiver wording' }, page.text),
      h('p', { class: 'read-more' }, 'Scroll inside the box to read it all.')),
    h('section', { class: 'card stack' }, h('h2', null, '2. Your details'),
      h('div', { class: 'row2' }, field('First name', first), field('Last name', last)),
      h('div', { class: 'row2' }, field('Date of birth', dob, 'You must be 18 or over to sign'), field('Email (optional)', email, 'We send your signed copy here')),
      field('Mobile phone (optional)', phone)),
    h('section', { class: 'card stack' }, h('h2', null, '3. Who is this for?'),
      h('label', { class: 'check' }, me, h('span', null, 'Me')),
      kidsBox,
      h('div', null, h('button', { type: 'button', class: 'btn', onclick: addKid }, 'Add a child under 18')),
      h('p', { class: 'hint' }, 'Anyone 18 or over signs their own waiver.')),
    h('section', { class: 'card stack' }, h('h2', null, '4. Sign'),
      h('label', { class: 'check' }, agree, h('span', null, 'I have read this waiver and agree to it, for myself and for each child named above, as their parent or legal guardian.')),
      field('Type your full name', typed, 'Exactly as in your details above'),
      h('div', { class: 'sigwrap' }, h('div', { class: 'sigline' }, h('strong', null, 'Sign in the box with your finger or mouse'), h('button', { type: 'button', class: 'btn link', onclick: () => pad.clear() }, 'Clear')), pad.el),
      err, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    let signature;
    try { signature = pad.toDataUrl(); } catch (ex) { err.append(h('div', { class: 'error-box' }, ex.message)); return; }
    if (!signature) { err.append(h('div', { class: 'error-box' }, 'Please sign in the box.')); pad.el.scrollIntoView({ block: 'center' }); return; }
    if (!agree.checked) { err.append(h('div', { class: 'error-box' }, 'Please tick the box to say you have read and agree to the waiver.')); return; }
    const body = {
      sha: page.sha, self: me.checked, typed_name: typed.value, signature, agree: true,
      signer: { first_name: first.value, last_name: last.value, date_of_birth: dob.value, email: email.value.trim(), phone: phone.value.trim() },
      children: kids.map((k) => ({ first_name: k.first.value, last_name: k.last.value, date_of_birth: k.dob.value })).filter((k) => k.first_name || k.last_name),
    };
    submit.disabled = true; submit.textContent = 'Signing…';
    try {
      const out = await call('POST', '/waiver/sign', body);
      done(page, out, first.value.trim());
    } catch (ex) {
      err.append(h('div', { class: 'error-box' }, ex.message));
      if (ex.status === 409) setTimeout(() => location.reload(), 2500);
    } finally { submit.disabled = false; submit.textContent = 'Sign the waiver'; }
  });

  clear(root);
  put(root, counter ? h('div', { class: 'counter-bar' }, 'Ticket window tablet: this page clears itself after each guest.') : null,
    hero(page.mountain, 'Sign the waiver', null), form);
}

function done(page, out, firstName) {
  const card = h('section', { class: 'card done success stack', role: 'status', tabindex: '-1' },
    h('h2', null, `Signed. Thank you, ${firstName}.`),
    h('p', null, `This waiver covers the ${out.season} season for:`),
    h('ul', { class: 'covered' }, out.covered.map((n) => h('li', null, n))),
    out.emailed ? h('p', { class: 'muted' }, 'We emailed you a copy.') : null,
    counter ? null : h('a', { class: 'btn', href: `/waiver/${encodeURIComponent(slug)}?copy=${out.token}` }, 'See and save your signed copy'),
    counter ? h('button', { type: 'button', class: 'btn primary big', onclick: () => location.reload() }, 'Next guest') : null);
  clear(root).append(hero(page.mountain, 'All set', null), h('main', { class: 'waiver-layout', id: 'waiver-main' }, card));
  card.focus();
  if (counter) setTimeout(() => location.reload(), 45000); // the next family should never see this one's names
}

if (!slug) failPage('This link is missing the mountain. Check the address.');
else if (copyToken) showCopy();
else showForm();
