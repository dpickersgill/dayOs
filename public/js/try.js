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
    h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/dayos-logo-dark.svg', alt: 'DAY/OS, resort operating system', width: '220', height: '77' })), h('h1', null, 'Try it on a mountain of your own.'),
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
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Start my demo');
  const f = h('form', { novalidate: true },
    field('Your name', name), field('Email', email, 'We use it as your demo login.'),
    field('Your mountain’s name (optional)', mountain, 'It shows at the top of your demo.'),
    trap, err, go, status);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    if (!name.value.trim() || !/^\S+@\S+\.\S+$/.test(email.value.trim())) { err.append(errorBox(new Error('Add your name and a valid email address.'))); return; }
    go.disabled = true;
    status.textContent = 'Building your mountain. This takes about 20 seconds.';
    try {
      const res = await fetch('/api/v1/trial', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), email: email.value.trim(), mountain: mountain.value.trim() || undefined, website: trap.querySelector('input').value }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 429 ? 'Too many demo requests from this address. Try again later.' : (out.error || 'Something went wrong. Please try again.'));
      done(out);
    } catch (ex) {
      status.textContent = '';
      err.append(errorBox(ex));
      go.disabled = false;
    }
  });
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
