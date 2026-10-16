// Entry point: sign-in, role-aware navigation and the hash router.

import { openTourPicker, resumeTour, welcomeOnce, endTour } from './tour.js';
import { get, post, session, hooks, ApiError } from './api.js';
import { mfaPanel } from './views/mfa.js';
import { flush as flushOutbox, waitingCounts, forgetCases } from './outbox.js';
import { buildFrame, GROUP_OF } from './nav.js';
import { icon } from './icons.js';
import { h, svg, clear, ctx, can, isManager, toast, loading, errorBox, button, field, input, closeAllDialogs } from './ui.js';

const VIEWS = [
  // [hash, label, who may open it, loader]
  ['dashboard', 'Today', () => true, () => import('./views/dashboard.js')],
  ['inbox', 'Inbox', () => true, () => import('./views/inbox.js')],
  ['sell', 'Sell', () => can('counter'), () => import('./views/sell.js')],
  ['gate', 'Gate', () => can('counter', 'staff'), () => import('./views/gate.js')],
  ['conditions', 'Mountain status', () => true, () => import('./views/conditions.js')],
  ['park', 'Terrain park', () => true, () => import('./views/park.js')],
  ['assets', 'Assets and fleet', () => can('staff'), () => import('./views/assets.js')],
  ['documents', 'Documents', () => true, () => import('./views/documents.js')],
  ['rentals', 'Rentals', () => can('counter'), () => import('./views/rentals.js')],
  ['school', 'Ski school', () => can('instructor', 'counter'), () => import('./views/school.js')],
  ['programs', 'Programs', () => can('instructor', 'counter'), () => import('./views/programs.js')],
  ['availability', 'Instructor availability', () => can('instructor', 'counter'), () => import('./views/availability.js')],
  ['patrol', 'Patrol', () => can('patrol'), () => import('./views/patrol.js')],
  ['people', 'Customers', () => can('counter', 'instructor'), () => import('./views/people.js')],
  ['waivers', 'Waivers', () => can('counter', 'instructor'), () => import('./views/waivers.js')],
  ['shop', 'Online shop', () => can('counter'), () => import('./views/shop.js')],
  ['catalog', 'Products and prices', () => isManager(), () => import('./views/catalog.js')],
  ['messages', 'Messages', () => isManager(), () => import('./views/messages.js')],
  ['money', 'Money', () => isManager(), () => import('./views/money.js')],
  ['workforce', 'Staff and schedule', () => isManager(), () => import('./views/workforce.js')],
  ['myshifts', 'My shifts', () => true, () => import('./views/myshifts.js')],
  ['settings', 'Account', () => true, () => import('./views/settings.js')],
  ['billing', 'Billing', () => isManager(), () => import('./views/billing.js')],
  ['help', 'Help', () => true, () => import('./views/help.js')],
];

const app = document.getElementById('app');
const SLUG_KEY = 'so.mountain';

function defaultView() {
  const role = ctx.me.role;
  if (isManager()) return 'dashboard';
  const home = { counter: 'sell', instructor: 'school', patrol: 'patrol' }[role] || 'conditions';
  return visibleViews().some((v) => v[0] === home) ? home : (visibleViews()[0] || ['settings'])[0];
}

// ---------------------------------------------------------------- sign in
function ridge() {
  const pts = '0,150 40,120 70,132 120,70 150,96 190,40 230,88 262,64 300,112 340,92 380,128 420,100 460,140 500,118 500,170 0,170';
  const el = svg('svg', { class: 'ridge', viewBox: '0 0 500 170', preserveAspectRatio: 'xMidYMax slice', role: 'img', 'aria-label': 'Mountain ridgeline' });
  el.append(svg('polygon', { points: pts, fill: '#1d4452' }));
  el.append(svg('polyline', { points: pts.split(' ').slice(0, -2).join(' '), fill: 'none', stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
  return el;
}

function readSlug() { try { return localStorage.getItem(SLUG_KEY) || ''; } catch (_) { return ''; } }
function saveSlug(v) { try { localStorage.setItem(SLUG_KEY, v); } catch (_) { /* private mode */ } }

function showSignIn(message) {
  clear(app);
  const err = h('div');
  const slug = input({ name: 'tenant', autocomplete: 'organization', autocapitalize: 'none', spellcheck: 'false', value: readSlug(), required: true });
  const email = input({ name: 'login', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const form = h('form', { novalidate: true },
    field('Mountain', slug, 'The short name you were given, such as spring-mountain'),
    field('Username or email', email), field('Password', pw), err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    go.disabled = true;
    try {
      const out = await post('/auth/login', { tenant: slug.value.trim().toLowerCase(), login: email.value.trim(), password: pw.value });
      saveSlug(slug.value.trim().toLowerCase());
      if (out.mfa_required) { showSecondStep(out.mfa_token); return; }
      session.token = out.token;
      await start();
    } catch (ex) {
      err.append(errorBox(ex instanceof ApiError && ex.status === 429 ? new Error('Too many attempts. Wait a minute and try again.') : ex));
      go.disabled = false;
    }
  });
  app.append(h('div', { class: 'signin' },
    h('section', { class: 'signin-side' },
      h('div', null, h('p', { class: 'brand' }, h('strong', null, 'SummitOps')), h('h1', null, 'Run the mountain from one screen.'),
        h('p', null, 'Tickets, lifts, rentals, lessons, patrol and staff schedules for your mountain.')), ridge()),
    h('section', { class: 'signin-form' }, h('h2', null, 'Sign in'), message ? h('p', { class: 'muted', role: 'status' }, message) : null, form, signInVersion())));
  (slug.value ? email : slug).focus();
}

function signInVersion() {
  const p = h('p', { class: 'signin-version' });
  fetch('/version').then((r) => r.json()).then((v) => { if (v && v.version) p.textContent = `Version ${v.version}`; }).catch(() => {});
  return p;
}

/** Password was right and the login has two-step sign-in: ask for the six-digit code (or a recovery code). */
function showSecondStep(mfaToken) {
  clear(app);
  const err = h('div');
  const code = input({ name: 'code', inputmode: 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', required: true, 'aria-label': 'Code' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Verify');
  const back = button('Start again', () => showSignIn(), { small: true });
  const form = h('form', { novalidate: true, 'data-step': 'mfa' }, field('Six-digit code', code, 'From your authenticator app. Lost your phone? Type one of your recovery codes instead.'), err, h('div', { class: 'row' }, go, back));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    go.disabled = true;
    try {
      const out = await post('/auth/mfa', { mfa_token: mfaToken, code: code.value.trim() });
      session.token = out.token;
      if (out.recovery_codes_left !== undefined && out.recovery_codes_left < 3) toast(`Recovery code used. ${out.recovery_codes_left} left: make new ones in Account.`);
      await start();
    } catch (ex) {
      err.append(errorBox(ex));
      go.disabled = false;
      code.select();
    }
  });
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('strong', null, 'SummitOps')), h('h1', null, 'One more step.'), h('p', null, 'Enter the code from your authenticator app to finish signing in.')), ridge()),
    h('section', { class: 'signin-form' }, h('h2', null, 'Two-step sign-in'), form)));
  code.focus();
}

/** The mountain requires two-step sign-in and this login does not have it yet: nothing else opens until it is set up. */
function showEnrollment() {
  clear(app);
  const done = async () => { await start(); };
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('strong', null, 'SummitOps')), h('h1', null, 'Protect your account.'), h('p', null, 'Your mountain requires two-step sign-in.')), ridge()),
    h('section', { class: 'signin-form stack' }, mfaPanel(done), button('Sign out', () => signOut(), { small: true }))));
}

/** A manager set a temporary password: the person chooses their own before anything else opens. */
function showPasswordChange() {
  clear(app);
  const err = h('div');
  const cur = input({ name: 'current', type: 'password', autocomplete: 'current-password', required: true });
  const next = input({ name: 'new', type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const again = input({ name: 'again', type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Save my password');
  const form = h('form', { novalidate: true, 'data-step': 'new-password' }, field('Temporary password', cur, 'The one you were given'), field('New password', next, 'At least 10 characters'), field('New password again', again), err, h('div', { class: 'row' }, go, button('Sign out', () => signOut(), { small: true })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    if (next.value.length < 10) { err.append(errorBox(new Error('Use at least 10 characters'))); return; }
    if (next.value !== again.value) { err.append(errorBox(new Error('The two new passwords are not the same'))); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/change-password', { current_password: cur.value, new_password: next.value });
      session.token = out.token;
      toast('Password saved');
      await start();
    } catch (ex) { err.append(errorBox(ex)); go.disabled = false; }
  });
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('strong', null, 'SummitOps')), h('h1', null, 'Choose your password.'), h('p', null, `Signed in as ${ctx.me.username || ctx.me.email}. Your password was set by a manager; choose your own to continue.`)), ridge()),
    h('section', { class: 'signin-form' }, h('h2', null, 'New password'), form)));
  cur.focus();
}

// ---------------------------------------------------------------- shell
let navToken = 0;
const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });

// An app the platform has turned off for this mountain is hidden for everyone, including the owner.
const ALWAYS = ['dashboard', 'inbox', 'people', 'waivers', 'myshifts', 'settings', 'billing', 'help'];
const appOn = (key) => ALWAYS.includes(key) || !ctx.me.modules || ctx.me.modules.includes(key);
function visibleViews() { return VIEWS.filter((v) => appOn(v[0]) && v[2]()); }

let frame = null;
function buildShell() {
  clear(app);
  frame = buildFrame({ views: visibleViews().map(([key, text]) => [key, text]), main, signOut: () => signOut() });
  app.append(frame.shell);
  if (ctx.me.sandbox) app.append(demoPill(ctx.me.sandbox));
  showBillingBanner();
  refreshUnread();
  refreshWhatsNew();
}

// Grace days, read only, or the last days of the trial: a strip above every page (managers get the Billing link).
async function showBillingBanner() {
  const s = ctx.me.billing;
  if (!s || (s.state === 'ok' && !(s.kind === 'trial' && s.days_left <= 3))) return;
  const { billingBanner } = await import('./views/billing.js');
  const el = billingBanner(s, { canFix: isManager() });
  if (el && main.parentElement) main.before(el);
}

// The quiet dot on Help when What's new has changes for this person: checked when the app opens, cleared when they look.
async function refreshWhatsNew() {
  try { const { unseen } = await get('/whats-new/count'); if (frame && frame.setBadge) frame.setBadge('help', unseen, { dot: true, says: 'new' }); } catch (_) { /* no dot */ }
}
window.addEventListener('whatsnew:seen', () => { if (frame && frame.setBadge) frame.setBadge('help', 0, { dot: true }); });

// The unread count on Inbox: checked every 30 seconds while signed in, and straight away when a conversation is read.
let unreadTimer = null;
let unreadBusy = false;
async function refreshUnread() {
  if (unreadBusy) return; // one check at a time, so the 30-second timer never doubles up
  clearTimeout(unreadTimer);
  if (!ctx.me || !frame) return;
  unreadBusy = true;
  try { const { unread } = await get('/inbox/unread'); if (frame.setBadge) frame.setBadge('inbox', unread); } catch (_) { /* try again on the next tick */ }
  unreadBusy = false;
  clearTimeout(unreadTimer);
  if (ctx.me) { unreadTimer = setTimeout(refreshUnread, document.hidden ? 120_000 : 30_000); unreadTimer.unref?.(); } // (unref: test runners only)
}
window.addEventListener('inbox:changed', () => refreshUnread());

/** A small tag on a demo mountain: how long it lasts, and a way to talk to us. */
function demoPill(sb) {
  const days = Math.max(0, Math.ceil((new Date(sb.expires_at) - Date.now()) / 86400000));
  return h('aside', { class: 'demo-pill', 'aria-label': 'Demo mountain' },
    h('span', null, `Demo mountain. ${days <= 1 ? 'Ends within a day.' : `${days} days left.`}`),
    h('button', { type: 'button', onclick: () => openTourPicker() }, 'Guided tours'),
    sb.contact_url ? h('a', { href: sb.contact_url, target: '_blank', rel: 'noopener' }, 'Ask for a walkthrough') : null);
}

/** '#/patrol/case/12?x=1' -> { key: 'patrol', params: ['case', '12'] } */
function currentPath() {
  const [key, ...params] = location.hash.replace(/^#\//, '').split('?')[0].split('/').filter((x, i) => i === 0 || x !== '');
  return { key: visibleViews().some((v) => v[0] === key) ? key : null, params };
}

async function route() {
  if (!ctx.me) return;
  const { key, params } = currentPath();
  if (!key) { location.replace(`#/${defaultView()}`); return; }
  const my = ++navToken;
  if (frame) frame.setCurrent(key);
  clear(main).append(loading());
  document.title = `${visibleViews().find((v) => v[0] === key)[1]} · ${ctx.me.tenant_name}`;
  const view = visibleViews().find((v) => v[0] === key);
  try {
    const mod = await view[3]();
    const holder = h('div');
    await mod.render(holder, params);
    if (my !== navToken) return;
    clear(main).append(holder);
    addHelpLink(holder, key);
    markArea(holder, key);
    main.focus({ preventScroll: true });
  } catch (err) {
    if (my !== navToken) return;
    clear(main).append(errorBox(err));
  }
}

/** Colour, icon and area name on the page title, so every page says which part of the app it belongs to. */
function markArea(holder, key) {
  const area = key === 'dashboard' ? { id: 'home', name: 'Today' } : GROUP_OF[key];
  if (!area) return;
  holder.dataset.group = area.id;
  const head = holder.querySelector('.page-head');
  if (!head) return;
  const lead = head.firstElementChild && head.firstElementChild.tagName === 'DIV' ? head.firstElementChild : null;
  const h1 = head.querySelector('h1');
  if (h1 && !h1.querySelector('.ico')) h1.prepend(icon(key, 26));
  if (area.id === 'home') return;
  const name = h('p', { class: 'area-name' }, area.name);
  if (lead) lead.prepend(name);
  else if (h1 && h1.parentElement === head) { const wrap = h('div'); h1.replaceWith(wrap); wrap.append(name, h1); }
}

/** A small link under each page title that opens the help for that page. */
function addHelpLink(holder, key) {
  if (key === 'help') return;
  const head = holder.querySelector('.page-head');
  if (!head) return;
  const lead = head.firstElementChild;
  (lead && lead.tagName === 'DIV' ? lead : head).append(h('a', { class: 'help-link', href: `#/help/for-${key}` }, 'Help with this page'));
}

async function signOut(message) {
  endTour();
  // Patrol entries kept on this phone while there was no signal go with the person who typed them. Try to send them first;
  // if they still cannot go, say so before signing out (they stay on this phone for up to three days, for this person).
  if (!message) {
    try { if (waitingCounts().mine) await flushOutbox(); } catch (_) { /* still offline */ }
    const left = waitingCounts().mine;
    if (left && !window.confirm(`${left} patient care entr${left === 1 ? 'y has' : 'ies have'} not been sent yet (no signal). They stay on this phone and send when you sign in again with a signal. Sign out anyway?`)) return;
  }
  if (!message) forgetCases(); // signing out on purpose clears the cases kept for a dead spot
  session.clear();
  ctx.me = null;
  navToken += 1;
  history.replaceState(null, '', location.pathname);
  showSignIn(message);
}

hooks.onSignedOut = () => { if (ctx.me) signOut('Your session ended. Sign in again.'); };

// Automatic sign-out: a phone or screen left open should not leave guest and patient details on display.
const IDLE_MINUTES = 15;
let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  if (!ctx.me) return;
  // The patrol-room sign-in screen stays up all day on a shared tablet; it shows names only, never patient details.
  idleTimer = setTimeout(() => { if (location.hash.startsWith('#/patrol/room')) { resetIdle(); return; } if (ctx.me) signOut(`Signed out after ${IDLE_MINUTES} minutes without activity.`); }, IDLE_MINUTES * 60_000);
  if (idleTimer && idleTimer.unref) idleTimer.unref(); // (test runners only: a pending timer must not keep the process alive)
}
for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) document.addEventListener(ev, resetIdle, { passive: true, capture: true });
// Arm the timer shortly after sign-in, and again whenever it has been cleared by a sign-out and back in.
setInterval(() => { if (ctx.me && !idleTimer) resetIdle(); if (!ctx.me) { clearTimeout(idleTimer); idleTimer = null; } }, 5_000).unref?.();

async function start() {
  if (!session.token) { showSignIn(); return; }
  try {
    ctx.me = await get('/auth/me');
  } catch (_) {
    session.clear();
    showSignIn();
    return;
  }
  ctx.tz = ctx.me.timezone || ctx.tz;
  if (ctx.me.must_change_password) { showPasswordChange(); return; }
  if (ctx.me.mfa_enrollment_required) { showEnrollment(); return; }
  buildShell();
  await route();
  if (ctx.me.sandbox) { resumeTour(); welcomeOnce(); }
}

// Moving to another page closes any dialog left open on the last one (for example a customer opened from an Inbox link).
let lastPath = location.hash.split('?')[0];
window.addEventListener('hashchange', () => {
  const now = location.hash.split('?')[0];
  if (now !== lastPath) closeAllDialogs();
  lastPath = now;
  route();
});
start();

export { route };
