// The public "try it" page at /try: a visitor asks for a demo mountain, we build one with made-up data, and they land inside it.

import './stage.js'; // the staging band (shows only on staging)
import { session } from './api.js';
import { h, svg, clear, field, input, select, errorBox } from './ui.js';

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
      h('p', null, 'You get a private demo mountain with every app switched on. Tell us your mountain and state, and it is built on your own lifts and trails, with made-up tickets, lessons, patrol cases and staff. Click anything.')), ridge());
}

function form() {
  clear(app);
  const err = h('div');
  const name = input({ name: 'name', autocomplete: 'name', required: true, maxlength: '100' });
  const email = input({ name: 'email', type: 'email', autocomplete: 'email', required: true, maxlength: '255' });
  const mountain = input({ name: 'mountain', autocomplete: 'organization', placeholder: 'For example, Spring Mountain', maxlength: '80' });
  const state = select([['', 'Choose a state'], ...STATES], '', { name: 'state', 'aria-label': 'State' });
  // undefined: not asked yet; null: a sample mountain; { ref, state, name }: their own mountain from the map
  let area;
  mountain.addEventListener('input', () => { area = undefined; });
  state.addEventListener('change', () => { area = undefined; });
  const trap = h('div', { class: 'sr', 'aria-hidden': 'true' }, h('label', null, 'Leave this empty', input({ name: 'website', tabindex: '-1', autocomplete: 'off' })));
  const status = h('p', { class: 'muted', role: 'status' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Continue');
  const f = h('form', { novalidate: true },
    field('Your name', name), field('Email', email, 'We use it as your demo login.'),
    field('Your mountain’s name (optional)', mountain, 'With your state, we find your mountain on the map and build the demo on its own lifts and trails.'),
    field('State', state),
    trap, err, go, status);
  const fail = (res, out) => new Error(res.status === 429 ? (out.error || 'Too many demo requests from this address. Try again later.') : (out.error || 'Something went wrong. Please try again.'));
  const post = async (path, body) => {
    const res = await fetch(`/api/v1/trial${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res, out);
    return out;
  };
  const details = () => ({ name: name.value.trim(), email: email.value.trim(), mountain: mountain.value.trim() || undefined, website: trap.querySelector('input').value, ...(area ? { area_ref: area.ref, state: area.state } : {}) });
  // Builds the demo (with the emailed code when there is one) and lands the visitor inside it.
  const build = async (code, button, line, box) => {
    button.disabled = true;
    line.textContent = area ? `Building ${area.name}. This takes about 20 seconds.` : 'Building your mountain. This takes about 20 seconds.';
    try { done(await post('', { ...details(), ...(code ? { code } : {}) })); } catch (ex) { line.textContent = ''; box.append(errorBox(ex)); button.disabled = false; }
  };
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    if (!name.value.trim() || !/^\S+@\S+\.\S+$/.test(email.value.trim())) { err.append(errorBox(new Error('Add your name and a valid email address.'))); return; }
    // Their own mountain first: find it on the map and ask "Is this you?" (once; changing the name or state asks again).
    if (area === undefined && mountain.value.trim().length >= 2 && state.value) {
      area = await chooseArea(f, mountain.value.trim(), state.value);
      if (area === 'back') { area = undefined; return; }
    }
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

const STATES = [['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'],
  ['ME', 'Maine'], ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming']];
const api = async (path, body) => {
  const res = await fetch(`/api/v1/trial${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'Something went wrong. Please try again.');
  return out;
};

/** The lifts and runs as a small map: green, blue and black lines for runs, dashed lines for lifts. */
function drawing(p) {
  const el = svg('svg', { class: 'area-map', viewBox: `0 0 ${p.w} ${p.h}`, role: 'img', 'aria-label': 'Map of the lifts and trails' });
  for (const l of p.lines) el.append(svg('path', { d: l.d, class: `area-${l.k}`, fill: 'none' }));
  return el;
}

/**
 * "Is this you?": the matches for their mountain's name in that state, then the one they pick with its lifts and runs.
 * Resolves to { ref, state, name } (build on it), null (a sample mountain), or 'back' (change what they typed).
 */
function chooseArea(formEl, typed, st) {
  return new Promise((resolve) => {
    const box = h('div', { class: 'stack area-pick' });
    const finish = (v) => { box.replaceWith(formEl); resolve(v); };
    const sample = h('button', { type: 'button', class: 'btn' }, 'Use a sample mountain instead');
    sample.addEventListener('click', () => finish(null));
    const back = h('button', { type: 'button', class: 'btn quiet' }, 'Change the name or state');
    back.addEventListener('click', () => finish('back'));
    const credit = h('p', { class: 'muted small' }, 'Map data \u00a9 OpenStreetMap contributors, via OpenSkiMap.org.');
    formEl.replaceWith(box);
    const show = (...els) => { clear(box).append(...els.filter(Boolean)); };
    const stateName = (STATES.find((x) => x[0] === st) || [st, st])[1];
    show(h('h3', null, 'Finding your mountain'), h('p', { class: 'muted', role: 'status' }, `Looking for ${typed} on the map\u2026`));
    api('/find', { mountain: typed, state: st }).then((r) => {
      if (r.unavailable) { show(h('h3', null, 'The map is not answering'), h('p', null, 'We could not reach the map just now. You can try again in a minute, or start with a sample mountain.'), h('div', { class: 'row' }, sample, back)); return; }
      if (!r.data.length) { show(h('h3', null, 'We could not find it'), h('p', null, `Nothing called ${typed} is on the map in ${stateName}. Check the spelling, or start with a sample mountain.`), h('div', { class: 'row' }, back, sample)); return; }
      const list = () => {
        if (r.data.length === 1) { pick(r.data[0]); return; }
        show(h('h3', null, 'Which one is yours?'),
          h('div', { class: 'stack tight' }, r.data.map((c) => { const b = h('button', { type: 'button', class: 'btn area-choice' }, h('b', null, c.name), h('span', { class: 'muted' }, [c.city, stateName].filter(Boolean).join(', '))); b.addEventListener('click', () => pick(c)); return b; })),
          h('div', { class: 'row' }, back, sample), credit);
      };
      function pick(c) {
        show(h('h3', null, c.name), h('p', { class: 'muted', role: 'status' }, 'Loading its lifts and trails\u2026'));
        api('/area', { ref: c.ref, state: st }).then((d) => {
          const yes = h('button', { type: 'button', class: 'btn primary' }, 'Yes, build my demo on this');
          yes.addEventListener('click', () => finish({ ref: d.ref, state: st, name: d.name }));
          const other = h('button', { type: 'button', class: 'btn' }, r.data.length > 1 ? 'Not this one' : 'Change the name or state');
          other.addEventListener('click', () => (r.data.length > 1 ? list() : finish('back')));
          const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
          show(h('h3', null, 'Is this you?'),
            h('p', null, h('b', null, d.name), ` \u00b7 ${[c.city, stateName].filter(Boolean).join(', ')}`),
            d.preview && d.preview.lines.length ? drawing(d.preview) : null,
            h('p', null, `${count(d.lifts.length, 'lift', 'lifts')} and ${count(d.trails.length, 'named trail', 'named trails')} on the map.`),
            d.usable ? null : h('p', { class: 'muted' }, 'There is not enough of it on the map to build on. Start with a sample mountain, or pick another.'),
            h('p', { class: 'muted small' }, 'We use the lift and trail names and where the mountain is. Prices, staff, guests and patrol cases are made up.'),
            h('div', { class: 'row' }, d.usable ? yes : null, other, d.usable ? null : sample), credit);
          if (d.usable) yes.focus();
        }).catch((ex) => { show(h('h3', null, c.name), errorBox(ex), h('div', { class: 'row' }, back, sample)); });
      }
      list();
    }).catch((ex) => { show(h('h3', null, 'Finding your mountain'), errorBox(ex), h('div', { class: 'row' }, back, sample)); });
  });
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
      out.real_map ? h('p', { class: 'muted small' }, 'Your lifts and trails come from OpenStreetMap (\u00a9 OpenStreetMap contributors). Everything else in the demo is made up.') : null,
      h('div', { class: 'cred' }, h('p', { class: 'cred-h' }, 'To come back later, sign in with'),
        h('dl', null, row('Mountain', h('code', null, out.tenant)), row('Email', out.email), row('Password', h('code', null, out.password)))),
      h('p', { class: 'muted small' }, 'Save this password now. It is shown only once. We have also emailed you a link that signs you straight in.'),
      h('a', { class: 'btn primary', href: '/' }, 'Open my demo'))));
}

// Links from the demo emails: ?open=<token> signs straight in (and &to=<screen> opens that screen); ?stop=<token>
// stops the emails about the demo.
async function fromEmail(kind, token) {
  clear(app);
  const msg = h('p', { role: 'status' }, kind === 'open' ? 'Opening your demo mountain\u2026' : 'One moment\u2026');
  const box = h('section', { class: 'signin-form' }, msg);
  app.append(h('div', { class: 'signin' }, side(), box));
  history.replaceState(null, '', '/try');
  try {
    const res = await fetch(`/api/v1/trial/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || out.message || 'That link did not work.');
    if (kind === 'stop') { clear(box).append(h('h2', null, 'Done'), h('p', null, 'You will not get any more emails about your demo.'), h('a', { class: 'btn', href: '/' }, 'Open my demo')); return; }
    session.token = out.token;
    try { localStorage.setItem(SLUG_KEY, out.tenant); } catch (_) { /* private mode */ }
    const to = params.get('to');
    location.replace(to && /^[a-z-]{2,30}$/.test(to) ? `/#/${to}` : '/');
  } catch (err) {
    clear(box).append(h('h2', null, 'That link did not work'), errorBox(err), h('a', { class: 'btn primary', href: '/try' }, 'Start a new demo'));
  }
}

const params = new URLSearchParams(location.search);
if (params.get('open')) fromEmail('open', params.get('open'));
else if (params.get('stop')) fromEmail('stop', params.get('stop'));
else form();
