// The public "try it" page at /try: a visitor asks for a demo mountain, we build one with made-up data, and they land inside it.

import './stage.js'; // the staging band (shows only on staging)
import { session } from './api.js';
import { h, clear, field, input, errorBox } from './ui.js';

const app = document.getElementById('app');
const SLUG_KEY = 'so.mountain';

function ridge() {
  const ns = 'http://www.w3.org/2000/svg';
  const pts = '0,150 40,120 70,132 120,70 150,96 190,40 230,88 262,64 300,112 340,92 380,128 420,100 460,140 500,118 500,170 0,170';
  const el = document.createElementNS(ns, 'svg');
  el.setAttribute('class', 'ridge'); el.setAttribute('viewBox', '0 0 500 170'); el.setAttribute('preserveAspectRatio', 'xMidYMax slice'); el.setAttribute('aria-hidden', 'true');
  const a = document.createElementNS(ns, 'polygon'); a.setAttribute('points', pts); a.setAttribute('fill', '#1d4452');
  const b = document.createElementNS(ns, 'polyline'); b.setAttribute('points', pts.split(' ').slice(0, -2).join(' ')); b.setAttribute('fill', 'none'); b.setAttribute('stroke', '#ffffff'); b.setAttribute('stroke-width', '2'); b.setAttribute('stroke-linejoin', 'round');
  el.append(a, b);
  return el;
}

function side() {
  return h('section', { class: 'signin-side' },
    h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, 'Try it on a mountain of your own.'),
      h('p', null, 'You get a private demo mountain with every app switched on and made-up lifts, tickets, lessons, patrol cases and staff. Click anything.')), ridge());
}

function form() {
  clear(app);
  const err = h('div');
  const name = input({ name: 'name', autocomplete: 'name', required: true, maxlength: '100' });
  const email = input({ name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: '255' });
  const mountain = input({ name: 'mountain', autocomplete: 'organization', placeholder: 'For example, Spring Mountain', maxlength: '80' });
  const trap = h('div', { class: 'sr', 'aria-hidden': 'true' }, h('label', null, 'Leave this empty', input({ name: 'website', tabindex: '-1', autocomplete: 'off' })));
  const status = h('p', { class: 'muted', role: 'status' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Continue');
  const f = h('form', { novalidate: true },
    field('Your name', name), field('Email', email, 'We use it as your demo login.'),
    field('Your mountain’s name (optional)', mountain, 'It shows at the top of your demo.'),
    trap, err, go, status);
  const fail = (res, out) => new Error(res.status === 429 ? (out.error || 'Too many demo requests from this address. Try again later.') : (out.error || 'Something went wrong. Please try again.'));
  const post = async (path, body) => {
    const res = await fetch(`/api/v1/trial${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res, out);
    return out;
  };
  const details = () => ({ name: name.value.trim(), email: email.value.trim(), mountain: mountain.value.trim() || undefined, website: trap.querySelector('input').value });
  // Builds the demo (with the emailed code when there is one) and lands the visitor inside it.
  const build = async (code, button, line, box) => {
    button.disabled = true;
    line.textContent = 'Building your mountain. This takes about 20 seconds.';
    try { done(await post('', { ...details(), ...(code ? { code } : {}) })); } catch (ex) { line.textContent = ''; box.append(errorBox(ex)); button.disabled = false; }
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    if (!name.value.trim() || !/^\S+@\S+\.\S+$/.test(email.value.trim())) { err.append(errorBox(new Error('Add your name and a valid email address.'))); return; }
    go.disabled = true;
    status.textContent = 'Checking your email address.';
    let step;
    try { step = await post('/code', details()); } catch (ex) { status.textContent = ''; err.append(errorBox(ex)); go.disabled = false; return; }
    if (!step.required) { await build(null, go, status, err); return; }
    codeStep(step.minutes || 15);
  });
  // Step 2 when the email check is on: the 6-digit code from the email.
  function codeStep(minutes) {
    const box = h('div');
    const line = h('p', { class: 'muted', role: 'status' });
    const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]*', maxlength: '6', required: true, class: 'code-input', 'aria-describedby': 'code-hint' });
    const start = h('button', { type: 'submit', class: 'btn primary' }, 'Start my demo');
    const again = h('button', { type: 'button', class: 'btn' }, 'Send a new code');
    const back = h('button', { type: 'button', class: 'btn' }, 'Use a different email');
    const cf = h('form', { novalidate: true },
      h('p', null, 'We emailed a 6-digit code to ', h('b', null, email.value.trim()), '. Type it here to start your demo.'),
      field('Code', code, `It works for ${minutes} minutes. Not there? Check your spam folder.`), box, start, line,
      h('div', { class: 'row-actions' }, again, back));
    cf.addEventListener('submit', (ev) => {
      ev.preventDefault(); clear(box);
      if (!/^\d{6}$/.test(code.value.trim())) { box.append(errorBox(new Error('Enter the 6 digits from the email.'))); return; }
      build(code.value.trim(), start, line, box);
    });
    again.addEventListener('click', async () => {
      clear(box); again.disabled = true;
      try { await post('/code', details()); line.textContent = 'A new code is on its way. Only the newest code works.'; } catch (ex) { box.append(errorBox(ex)); }
      again.disabled = false;
    });
    back.addEventListener('click', () => { cf.replaceWith(f); go.disabled = false; status.textContent = ''; email.focus(); });
    f.replaceWith(cf);
    code.focus();
  }
  app.append(h('div', { class: 'signin' }, side(),
    h('section', { class: 'signin-form' }, h('h2', null, 'Start your demo'), f,
      h('p', { class: 'muted small' }, 'Everything in it is made up. Email and card payments are switched off. It deletes itself after 7 days.'))));
  name.focus();
}

function done(out) {
  session.token = out.token;
  try { localStorage.setItem(SLUG_KEY, out.tenant); } catch (_) { /* private mode: the sign-in page will ask for it */ }
  clear(app);
  const row = (k, v) => h('div', { class: 'cred-row' }, h('dt', null, k), h('dd', null, v));
  const days = Math.max(1, Math.round((new Date(out.expires_at) - Date.now()) / 86400000));
  app.append(h('div', { class: 'signin' }, side(),
    h('section', { class: 'signin-form' }, h('h2', null, 'Your demo is ready'),
      h('p', null, `${out.mountain} is open for about ${days} days. You are already signed in.`),
      h('div', { class: 'cred' }, h('p', { class: 'cred-h' }, 'To come back later, sign in with'),
        h('dl', null, row('Mountain', h('code', null, out.tenant)), row('Email', out.email), row('Password', h('code', null, out.password)))),
      h('p', { class: 'muted small' }, 'Save this password now. It is shown only once.'),
      h('a', { class: 'btn primary', href: '/' }, 'Open my demo'))));
}

form();
