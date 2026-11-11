// Entry point: sign-in, role-aware navigation and the hash router.

import './stage.js'; // the staging band (shows only on staging)
import { openTourPicker, resumeTour, welcomeOnce, endTour } from './tour.js';
import { get, poll, post, session, hooks, noteActivity, ApiError } from './api.js';
import { mfaPanel } from './views/mfa.js';
import * as passkey from './passkey.js';
import { confirmItsYou } from './stepup.js';
import { readTerminal, saveTerminal } from './terminal.js';
import { passkeysPanel } from './views/security.js';
import { watchPasswords } from './showpw.js';
import { startTabWatch, activity as tabActivity, checkNow as tabCheckNow, msLeft as tabMsLeft, refresh as tabRefresh, LOCK_MINUTES } from './tablock.js';
import * as alerts from './alerts.js';
import { flush as flushOutbox, waitingCounts, forgetCases, setDeviceKey, restoreDeviceKey, dropDeviceKey } from './outbox.js';
import { buildFrame, GROUP_OF, PATROL_SECTIONS, patrolSection, AREA_MENU } from './nav.js';
import { icon } from './icons.js';
import { h, svg, clear, ctx, can, isManager, isMuni, schoolCan, toast, loading, errorBox, button, field, input, dialog, closeAllDialogs, dirtyDialogOpen, newPage, hashPath, todayStr, noteBack } from './ui.js';

const VIEWS = [
  // [hash, label, who may open it, loader]
  ['dashboard', 'Today', () => true, () => import('./views/dashboard.js')],
  ['inbox', 'Inbox', () => true, () => import('./views/inbox.js')],
  ['brief', 'Morning brief', () => ctx.me.role !== 'area', () => import('./views/brief.js')], // opened from Today, the email and the phone alert
  ['sell', 'Sell', () => can('counter') || schoolCan('director'), () => import('./views/sell.js')],
  ['gate', 'Gate', () => can('counter', 'staff'), () => import('./views/gate.js')],
  ['conditions', 'Mountain status', () => true, () => import('./views/conditions.js')],
  ['park', 'Terrain park', () => true, () => import('./views/park.js')],
  ['assets', 'Assets and fleet', () => can('staff'), () => import('./views/assets.js')],
  ['documents', 'Documents', () => true, () => import('./views/documents.js')],
  ['rentals', 'Rentals', () => can('counter'), () => import('./views/rentals.js')],
  ['school', 'Lessons', () => can('instructor', 'counter'), () => import('./views/school.js')], // its group in All apps is Ski school (Lessons and Programs)
  ['programs', 'Programs', () => can('instructor', 'counter'), () => import('./views/programs.js')],
  ['availability', 'My availability', () => can('instructor', 'counter'), () => import('./views/availability.js')], // an instructor's own page; everyone else is sent to Lessons
  ['patrol', 'Patrol', () => can('patrol'), () => import('./views/patrol.js')],
  ['people', 'Customers', () => can('counter', 'instructor'), () => import('./views/people.js')],
  ['waivers', 'Waivers', () => can('counter', 'instructor'), () => import('./views/waivers.js')],
  ['lostfound', 'Lost and found', () => can('counter', 'staff'), () => import('./views/lostfound.js')],
  ['shop', 'Online shop', () => can('counter'), () => import('./views/shop.js')],
  ['catalog', 'Products and prices', () => isManager() || schoolCan('director'), () => import('./views/catalog.js')],
  ['messages', 'Messages', () => isManager(), () => import('./views/messages.js')],
  ['money', 'Money', () => isManager(), () => import('./views/money.js')],
  ['workforce', 'Staff and schedule', () => isManager(), () => import('./views/workforce.js')],
  ['myshifts', 'My shifts', () => true, () => import('./views/myshifts.js')],
  ['calendar', 'Calendar', () => ctx.me.role !== 'area', () => import('./views/calendar.js')],
  ['settings', 'Settings', () => true, () => import('./views/settings.js')],
  ['help', 'Help', () => true, () => import('./views/help.js')],
  ['area', 'Summary', () => ctx.me.role === 'area', () => import('./views/area.js')],
  // The municipal edition (muni release 1). Each opens with its app (VIEW_MODULE) on; Crew is the staff role, Front desk
  // the counter role. The owning workstreams replace the stub files.
  ['requests', 'Requests', () => can('counter', 'staff'), () => import('./views/requests.js')],
  ['notices', 'Street notices', () => can('counter'), () => import('./views/street-notices.js')],
  ['works', 'Work orders', () => can('staff'), () => import('./views/works.js')],
  ['assetprograms', 'Programs', () => can('staff'), () => import('./views/asset-programs.js')],
  ['bulk', 'Bulk pickup', () => can('counter', 'staff'), () => import('./views/bulk-pickup.js')],
  ['buildings', 'Buildings', () => can('counter', 'staff'), () => import('./views/buildings.js')],
];
// A view whose app (lib/modules.js) has another name. Every other view's key is its app's key.
const VIEW_MODULE = { requests: 'requests', notices: 'requests', works: 'assets', assetprograms: 'assets', bulk: 'solidwaste', buildings: 'buildings' };
// The views a municipality may have at all (with their apps on, for the roles that may open them). Ski views never show there.
const MUNI_VIEWS = ['dashboard', 'inbox', 'myshifts', 'requests', 'notices', 'bulk', 'works', 'assets', 'assetprograms', 'buildings', 'workforce', 'messages', 'documents', 'settings', 'help'];

// Old addresses that still work: Partner passes is the last tab of Sell, Billing is a page of Settings. Instructor
// availability is Lessons, Instructors, Availability for everyone but an instructor, whose own menu keeps the page.
const REDIRECTS = {
  partners: () => '#/sell?tab=partners',
  billing: (query) => `#/settings/billing${query ? `?${query}` : ''}`,
  availability: () => (ownAvailability() ? null : AVAILABILITY_TAB),
  // A work order shared from the Inbox (#/conditions/wo/12) opens on a municipality's Work orders (muni release 1).
  conditions: () => { const m = /^#\/conditions\/wo\/(\d+)/.exec(location.hash); return isMuni() && m ? `#/works/${m[1]}` : null; },
};
export const AVAILABILITY_TAB = '#/school?tab=team&view=availability';
/** An instructor keeps Instructor availability as its own page (it is their own work); everyone else finds it in Lessons. */
const ownAvailability = () => Boolean(ctx.me) && ctx.me.role === 'instructor';

const app = document.getElementById('app');
const SLUG_KEY = 'so.mountain';

// Verdynt/OS Patrol: a mountain with Patrol and none of the front-desk or mountain apps is a patrol on its own.
const patrolOnly = () => !isMuni() && Boolean(ctx.me.modules) && ctx.me.modules.includes('patrol') && !['sell', 'conditions', 'rentals', 'school'].some((k) => ctx.me.modules.includes(k));

function defaultView() {
  const role = ctx.me.role;
  const open = (k) => visibleViews().some((v) => v[0] === k);
  if (role === 'area') return 'area';
  if (isMuni()) return open('dashboard') ? 'dashboard' : (visibleViews()[0] || ['settings'])[0];
  if (patrolOnly()) return open('patrol') ? 'patrol' : 'settings';
  // A menu (owners and managers have one too) starts on its start screen, or on the first app in it this person can open.
  const menu = ctx.me.menu;
  if (menu && Array.isArray(menu.apps)) {
    if (menu.start && open(menu.start)) return menu.start;
    if (isManager() && open('dashboard')) return 'dashboard';
    const first = menu.apps.find(open);
    if (first) return first;
  }
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

// "Remember me on this device": the mountain and the username (or email) are kept in this browser and filled in next
// time, and the sign-in is shared by this browser's tabs (api.js, tablock.js). Never the password. Without it, only the
// mountain is kept (as before). Not offered on a shared terminal.
const REMEMBER_KEY = 'so.remember';
function readRemember() { try { const r = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); return r && r.tenant ? r : null; } catch (_) { return null; } }
function saveRemember(r) { try { if (r) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ tenant: r.tenant, login: r.login })); else localStorage.removeItem(REMEMBER_KEY); } catch (_) { /* private mode */ } }
// Whether the sign-in under way keeps its token for every tab (Remember me was ticked, or a locked tab was shared).
let keepShared = false;
// "This is my own device" (feat/auth-hardening): remembered for this browser. Remember me is offered only once it is
// ticked, and the server decides: it never keeps a sign-in for every tab on a device not marked as the person's own, on a
// shared terminal, or for anyone who can open patient care records (patrol, the ski area login).
const OWN_KEY = 'so.own';
const readOwn = () => { try { return localStorage.getItem(OWN_KEY) === '1'; } catch (_) { return false; } };
const saveOwn = (v) => { try { if (v) localStorage.setItem(OWN_KEY, '1'); else localStorage.removeItem(OWN_KEY); } catch (_) { /* private mode */ } };
let ownDevice = readOwn();
/** What every sign-in call says about this device: Remember me asked, own device, and the shared terminal's key. */
const signinFlags = () => { const term = readTerminal(); return { remember: Boolean(keepShared && ownDevice && !term), own_device: Boolean(ownDevice && !term), ...(term ? { terminal: term.secret } : {}) }; };
const PK_USED_KEY = 'so.pk.used'; // this browser signed in with a passkey before: the sign-in page offers it first
const usedPasskeyHere = () => { try { return localStorage.getItem(PK_USED_KEY) === '1'; } catch (_) { return false; } };
const notePasskeyHere = () => { try { localStorage.setItem(PK_USED_KEY, '1'); } catch (_) { /* private mode */ } };
const REFUSED_WHY = {
  patient_records: 'Remember me is off for logins that open patient records, so this tab signs out on its own.',
  not_own_device: 'Remember me works only on a device you marked as your own.',
  shared_terminal: 'Remember me is never used on a shared terminal.',
  no_device_id: 'This browser did not keep its device id, so Remember me is off here.',
};
const NOT_CASE = 'Not case sensitive: JSmith and jsmith are the same.';

/** Signed in: keep the token and open the app. */
async function signedIn(out) {
  // The server says whether this sign-in may be kept for every tab (remember); the browser follows it.
  const shared = keepShared && !readTerminal() && out.remember === true;
  if (keepShared && !shared && out.remember_refused && REFUSED_WHY[out.remember_refused]) toast(REFUSED_WHY[out.remember_refused]);
  const before = shared ? session.sharedToken() : null;
  session.save(out.token, { shared });
  tabRefresh();
  // A sign-in that replaces the browser's shared token (a locked tab signed in again): the old session ends.
  if (before && before !== out.token) fetch('/api/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${before}` }, keepalive: true }).catch(() => {});
  if (out.recovery_codes_left !== undefined && out.recovery_codes_left < 3) toast(`Recovery code used. ${out.recovery_codes_left} left: make new ones in Settings.`);
  await start();
}

/** What the sign-in page may offer for a mountain (server: GET /auth/signin-options). null when it cannot tell. */
async function mountainOptions(tenant) {
  try {
    const r = await fetch(`/api/v1/auth/signin-options?tenant=${encodeURIComponent(tenant || '')}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}
/** The line under the mountain, and whether the email buttons show. Returns true when emailed codes can work. */
function sayMountain(o, note, emailRow) {
  clear(note);
  let usable = true; let say = '';
  if (o && o.tenant && !o.known) { usable = false; say = `We can't find a mountain called "${o.tenant}". Check the spelling, or ask your manager for the short name.`; }
  else if (o && o.demo) { usable = false; say = "Demo mountains don't send email. Sign in with your password."; }
  else if (o && !o.email_set_up) { usable = false; say = "Email sign-in isn't set up here yet."; }
  if (say) note.append(h('p', { class: o && o.tenant && !o.known ? 'signin-note warn' : 'signin-note' }, say));
  if (emailRow) emailRow.hidden = !usable;
  return usable;
}

const signinFailed = (ex, tenant) => {
  if (ex instanceof ApiError && ex.status === 429) return new Error('Too many attempts. Wait a minute and try again.');
  if (ex instanceof ApiError && ex.status === 401) return new Error(`Wrong username or password. Check the mountain name too: you are signing in to ${tenant}.`);
  return ex;
};

function showSignIn(message) {
  clear(app);
  const term = readTerminal();
  const remembered = term ? null : readRemember();
  const known = readSlug();
  const err = h('div');
  const slug = input({ name: 'tenant', autocomplete: 'organization', autocapitalize: 'none', spellcheck: 'false', value: known, required: true });
  const email = input({ name: 'login', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, value: remembered && remembered.tenant === known ? remembered.login || '' : '' });
  const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const remember = term ? null : h('input', { type: 'checkbox', name: 'remember', checked: Boolean(remembered && readOwn()) });
  const own = term ? null : h('input', { type: 'checkbox', name: 'own_device', checked: readOwn() });
  const rememberRow = remember ? h('div', { class: 'stack tight', 'data-remember': '', hidden: !readOwn() }, h('label', { class: 'check' }, remember, ' Remember me on this device'),
    h('p', { class: 'hint signin-hint' }, 'Keeps your mountain and username here, and keeps you signed in when you open a new tab. Never your password. Not used for logins that open patient records.')) : null;
  if (own) own.addEventListener('change', () => { ownDevice = own.checked; saveOwn(own.checked); rememberRow.hidden = !own.checked; if (!own.checked) remember.checked = false; });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  // The remembered mountain is said plainly, with a way to change it: signing in to the wrong mountain looks exactly like a
  // wrong password.
  const slugField = field('Mountain', slug, 'The short name you were given, such as spring-mountain');
  const note = h('div', { 'aria-live': 'polite', 'data-mountain-note': '' });
  const change = h('button', { type: 'button', class: 'btn link', 'aria-label': `Change the mountain (now ${known})` }, 'Change');
  const shown = known ? h('p', { class: 'signin-mountain', 'data-mountain': known }, 'Mountain: ', h('strong', null, known), '.', change) : null;
  if (shown) slugField.hidden = true;
  change.addEventListener('click', () => { shown.remove(); slugField.hidden = false; slug.focus(); slug.select(); });
  const form = h('form', { novalidate: true, 'data-step': 'signin' },
    shown, slugField, note,
    field('Username or email', email, NOT_CASE), field('Password', pw),
    own ? h('div', { class: 'stack tight' }, h('label', { class: 'check' }, own, ' This is my own device'),
      h('p', { class: 'hint signin-hint' }, 'Tick it only on your own phone or computer, never on one other people use.')) : null,
    rememberRow,
    err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    const tenant = slug.value.trim().toLowerCase();
    const login = email.value.trim();
    if (!tenant) { slugField.hidden = false; if (shown) shown.remove(); err.append(errorBox(new Error('Type your mountain first'))); slug.focus(); return; }
    go.disabled = true;
    try {
      keepShared = Boolean(remember && remember.checked && ownDevice);
      const out = await post('/auth/login', { tenant, login, password: pw.value, ...signinFlags() });
      saveSlug(tenant);
      saveRemember(keepShared ? { tenant, login: login.includes('@') ? login : login.toLowerCase() } : null);
      if (out.mfa_required) { showSecondStep(out); return; }
      await signedIn(out);
    } catch (ex) {
      err.append(errorBox(signinFailed(ex, tenant)));
      go.disabled = false;
    }
  });
  // A passkey signs in on its own: no username or password to type (the phone asks for a fingerprint, face or PIN).
  const pkErr = h('div');
  const pk = passkey.supported() ? button('Sign in with a passkey', async () => {
    clear(pkErr);
    const tenant = slug.value.trim().toLowerCase();
    if (!tenant) { pkErr.append(errorBox(new Error('Type your mountain first'))); slugField.hidden = false; slug.focus(); return; }
    pk.disabled = true;
    try {
      keepShared = Boolean(remember && remember.checked && ownDevice);
      const { handle, options } = await post('/auth/passkey/options', { tenant });
      const response = await passkey.use(options);
      const out = await post('/auth/passkey', { tenant, handle, response, ...signinFlags() });
      saveSlug(tenant);
      if (!keepShared) saveRemember(null);
      await signedIn(out);
    } catch (ex) { pkErr.append(errorBox(ex)); pk.disabled = false; }
  }, { small: false }) : null;
  const toEmail = (purpose) => { keepShared = Boolean(remember && remember.checked && ownDevice); showEmailCode(purpose, slug.value.trim().toLowerCase(), email.value.trim()); };
  const emailRow = h('div', { class: 'row signin-email' },
    button('Email me a code instead', () => toEmail('signin'), { small: true }),
    button('Forgot password?', () => toEmail('reset'), { small: true, kind: 'quiet' }));
  // Which mountain this is decides what the page can offer (a demo sends no email); checked as the name is typed.
  let asked = 0; let wait = null;
  const check = async () => { const my = ++asked; const o = await mountainOptions(slug.value.trim().toLowerCase()); if (my === asked) sayMountain(o, note, emailRow); };
  slug.addEventListener('input', () => { clear(err); clearTimeout(wait); wait = setTimeout(check, 500); });
  slug.addEventListener('change', () => { clearTimeout(wait); check(); });
  check();
  // Someone who signed in with a passkey on this device before sees it first (feat/auth-hardening): no code to type.
  const pkFirst = Boolean(pk && usedPasskeyHere());
  if (pkFirst) pk.classList.add('primary', 'passkey-big');
  const pkBlock = pk ? h('div', { class: 'stack tight signin-passkey' }, h('p', { class: 'muted small' }, pkFirst ? 'You used a passkey here before: one touch signs you in.' : 'Or, if you added a passkey on this phone or computer:'), pk, pkErr) : null;
  app.append(h('div', { class: 'signin' },
    h('section', { class: 'signin-side' },
      h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, 'Run the mountain from one screen.'),
        h('p', null, 'Tickets, lifts, rentals, lessons, patrol and staff schedules for your mountain.')), ridge()),
    h('section', { class: 'signin-form' }, h('h2', null, 'Sign in'), message ? h('p', { class: 'muted', role: 'status' }, message) : null, pkFirst ? pkBlock : null, form,
      pkFirst ? null : pkBlock,
      emailRow,
      term ? h('p', { class: 'small' }, button(`Back to the PIN screen (${term.name})`, () => showPinSignIn(), { small: true })) : null,
      signInVersion())));
  (!slug.value ? slug : email.value ? pw : email).focus();
}

/**
 * Quick resume (feat/auth-hardening): a patrol or leader session paused after 30 minutes without use, or locked by its
 * tab. The token is kept; a passkey or a code from the authenticator app opens it again, without typing a password, as
 * long as its 8 hours have not passed and nobody signed out or changed the password. Otherwise: sign in again.
 */
async function showResume(message) {
  const kept = session.keptMe() || {};
  const err = h('div');
  const slot = h('div', { class: 'stack resume-slot' });
  signInFrame('Paused to keep patient details private.', 'Nobody used Verdynt/OS here for a while, so it paused. Your work is where you left it.', 'Carry on',
    message ? h('p', { class: 'muted', role: 'status' }, message) : null,
    h('p', { class: 'resume-lead', 'data-resume-as': kept.login_name || '' }, 'Signed in as ', h('strong', null, kept.login_name || kept.username || 'you'), kept.tenant_name ? ` at ${kept.tenant_name}` : '', '. Confirm it is you to carry on.'),
    slot, err,
    h('p', { class: 'small' }, button('Sign out', () => signOut(), { small: true, kind: 'quiet' })));
  document.title = 'Paused · Verdynt/OS';
  let opts;
  try { opts = await post('/auth/resume/options'); } catch (ex) {
    // Not resumable (past 8 hours, signed out, password changed): a full sign-in.
    session.clear(); showSignIn(ex.message || 'Sign in again.'); return;
  }
  const done = async () => { toast('Welcome back'); await start(); };
  if (opts.methods.includes('passkey') && opts.passkey) {
    const b = button('Use my passkey', async () => {
      clear(err); b.disabled = true;
      try {
        const fresh = b.dataset.used ? await post('/auth/resume/options') : opts;
        b.dataset.used = '1';
        const response = await passkey.use(fresh.passkey.options);
        await post('/auth/resume', { handle: fresh.passkey.handle, response });
        await done();
      } catch (ex) { err.append(errorBox(ex)); b.disabled = false; }
    }, { kind: 'primary' });
    b.classList.add('big', 'passkey-big');
    slot.append(b);
  }
  if (opts.methods.includes('app')) {
    const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, 'aria-label': 'Six-digit code' });
    const go = h('button', { type: 'submit', class: opts.methods.includes('passkey') ? 'btn' : 'btn primary' }, 'Carry on');
    const f = h('form', { class: 'stack', novalidate: true, 'data-step': 'resume' }, field(opts.methods.includes('passkey') ? 'Or the code from your authenticator app' : 'Code from your authenticator app', code), h('div', { class: 'row' }, go));
    f.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(err); go.disabled = true;
      try { await post('/auth/resume', { code: code.value.trim() }); await done(); } catch (ex) { err.append(errorBox(ex)); go.disabled = false; code.select(); }
    });
    slot.append(f);
  }
  const first = slot.querySelector('.btn.primary, input');
  if (first) first.focus();
}
let resuming = false;
hooks.onPaused = () => { if (resuming) return; resuming = true; closeAllDialogs().catch(() => {}); ctx.me = null; showResume().finally(() => { resuming = false; }); };

/**
 * A tab nobody used for 10 minutes: it locked itself (tablock.js) and reads no token until someone signs in here again.
 * With Remember me, the other tabs carry on; signing in here replaces the shared sign-in, and the page opens where it was.
 */
function showLocked(who, message) {
  keepShared = Boolean(who.shared);
  const err = h('div');
  const pw = input({ name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const user = h('input', { type: 'text', name: 'login', autocomplete: 'username', value: who.login || '', hidden: true, readonly: true, tabindex: '-1', 'aria-hidden': 'true' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Continue');
  const form = h('form', { novalidate: true, 'data-step': 'locked' }, user, field('Password', pw), err, h('div', { class: 'row' }, go));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err);
    if (!pw.value) { err.append(errorBox(new Error('Type your password'))); pw.focus(); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/login', { tenant: who.tenant, login: who.login, password: pw.value, ...signinFlags() });
      if (out.mfa_required) { showSecondStep(out); return; }
      await signedIn(out);
    } catch (ex) { err.append(errorBox(signinFailed(ex, who.tenant))); go.disabled = false; pw.select(); }
  });
  const other = h('div', { class: 'stack tight' });
  const pkErr = h('div');
  if (passkey.supported()) {
    const pk = button('Use a passkey', async () => {
      clear(pkErr); pk.disabled = true;
      try {
        const { handle, options } = await post('/auth/passkey/options', { tenant: who.tenant });
        const response = await passkey.use(options);
        await signedIn(await post('/auth/passkey', { tenant: who.tenant, handle, response, ...signinFlags() }));
      } catch (ex) { pkErr.append(errorBox(ex)); pk.disabled = false; }
    }, { small: true });
    other.append(pk, pkErr);
  }
  const emailRow = h('div', { class: 'row' }, button('Email me a code instead', () => showEmailCode('signin', who.tenant, who.login), { small: true }));
  emailRow.hidden = true;
  const note = h('div', { 'aria-live': 'polite' });
  mountainOptions(who.tenant).then((o) => sayMountain(o, note, emailRow));
  signInFrame(`Locked after ${LOCK_MINUTES} minutes.`,
    who.shared ? `Nobody used this tab for ${LOCK_MINUTES} minutes, so it locked to keep guest and patient details private. Your other tabs are not affected.` : `Nobody used this tab for ${LOCK_MINUTES} minutes, so it locked and signed out, to keep guest and patient details private.`,
    'Locked',
    message ? h('p', { class: 'muted', role: 'status' }, message) : null,
    h('p', { 'data-locked-as': who.login || '' }, who.shared ? 'Signed in as ' : 'You were signed in as ', h('strong', null, who.name || who.login || 'you'), ` at ${who.tenant}. Type your password to carry on where you were.`),
    form, other, note, emailRow,
    h('p', { class: 'small' }, button('Sign in as someone else', () => { keepShared = false; showSignIn(); }, { small: true, kind: 'quiet' })));
  document.title = 'Locked · Verdynt/OS';
  pw.focus();
}

/** The sign-in page frame used by the email screens: the ridge on one side, the form on the other. */
function signInFrame(lead, say, title, ...body) {
  clear(app);
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, lead), h('p', null, say)), ridge()),
    h('section', { class: 'signin-form stack' }, h('h2', null, title), ...body)));
}

/**
 * Sign in with a code from your email, or reset a forgotten password. Step one asks who you are; step two takes the code
 * (and, for a reset, the new password). The email also has a link that does the same on whichever device opens it.
 */
function showEmailCode(purpose, tenant0 = readSlug(), login0 = '') {
  const reset = purpose === 'reset';
  const err = h('div');
  const slug = input({ name: 'tenant', autocomplete: 'organization', autocapitalize: 'none', spellcheck: 'false', value: tenant0 || readSlug(), required: true });
  const who = input({ name: 'login', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: login0, required: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Email me a code');
  const form = h('form', { novalidate: true, 'data-step': 'email-ask' }, field('Mountain', slug), field('Username or email', who, `The code goes to the email on your login. No email on your login? Ask a manager to add one, or sign in with your password. ${NOT_CASE}`), err, h('div', { class: 'row' }, go, button('Back to sign in', () => showSignIn(), { small: true })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err);
    const tenant = slug.value.trim().toLowerCase(); const login = who.value.trim();
    if (!tenant || !login) { err.append(errorBox(new Error('Enter your mountain and your username or email'))); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/email-code', { tenant, login, purpose });
      saveSlug(tenant);
      showEmailCodeEntry(purpose, { tenant, login, request: out.request, minutes: out.minutes });
    } catch (ex) { err.append(errorBox(ex)); go.disabled = false; }
  });
  signInFrame(reset ? 'Forgot your password?' : 'Sign in by email.', reset ? 'We email you a code to choose a new one.' : 'No password to remember: we email you a code, or a link you can tap.', reset ? 'Reset your password' : 'Email me a code', form);
  (slug.value ? who : slug).focus();
}

function showEmailCodeEntry(purpose, { tenant, login, request, minutes = 10, link = null }) {
  const reset = purpose === 'reset';
  const err = h('div');
  const code = link ? null : input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, 'aria-label': 'Code' });
  const next = reset ? input({ name: 'new', type: 'password', autocomplete: 'new-password', minlength: 12, required: true }) : null;
  const again = reset ? input({ name: 'again', type: 'password', autocomplete: 'new-password', minlength: 12, required: true }) : null;
  const go = h('button', { type: 'submit', class: 'btn primary' }, reset ? 'Save my new password' : 'Sign in');
  const form = h('form', { novalidate: true, 'data-step': reset ? 'email-reset' : 'email-code' },
    code ? field('Code from your email', code, `If there is a login for ${login} at this mountain with an email, we sent a six-digit code to it. It works for ${minutes} minutes. ${NO_MAIL}`) : null,
    reset ? field('New password', next, 'At least 12 characters') : null, reset ? field('New password again', again) : null,
    err, h('div', { class: 'row' }, go, button('Start again', () => showSignIn(), { small: true })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); clear(err);
    if (reset && next.value.length < 12) { err.append(errorBox(new Error('Use at least 12 characters'))); return; }
    if (reset && next.value !== again.value) { err.append(errorBox(new Error('The two new passwords are not the same'))); return; }
    const proof = link ? { link } : { request, code: code.value.trim() };
    go.disabled = true;
    try {
      if (!reset) {
        const out = await post('/auth/email-code/verify', { ...proof, ...signinFlags() });
        if (out.mfa_required) { showSecondStep(out); return; }
        await signedIn(out);
        return;
      }
      const out = await post('/auth/password-reset', { ...proof, new_password: next.value, ...signinFlags() });
      toast('Password saved. Every other device was signed out.');
      if (out.mfa_required) { showSecondStep(out); return; }
      await signedIn(out);
    } catch (ex) { err.append(errorBox(ex)); go.disabled = false; if (code) code.select(); }
  });
  signInFrame(reset ? 'Choose a new password.' : 'Check your email.', reset ? 'Every other device is signed out when you save it.' : 'Type the code from the email, or open its link on this device.', reset ? 'New password' : 'Enter the code', form);
  (code || next).focus();
}

// Said wherever we tell someone to look for an emailed code.
const NO_MAIL = "If it doesn't arrive in 2 minutes, check spam, or ask your manager to make sure your login has an email address.";

/** Opened from the link in a sign-in or reset email (#email-link=… or #reset-link=…). Returns true when it took over. */
async function fromEmailLink() {
  const m = /^#(email-link|reset-link)=([A-Za-z0-9_-]+\.\d{6})$/.exec(location.hash);
  if (!m) return false;
  history.replaceState(null, '', location.pathname + location.search); // the link works once: keep it out of history
  if (m[1] === 'reset-link') { showEmailCodeEntry('reset', { link: m[2] }); return true; }
  try {
    const out = await post('/auth/email-code/verify', { link: m[2] });
    if (out.mfa_required) { showSecondStep(out); return true; }
    keepShared = false;
    session.save(out.token); // this tab only: a link from an email never signs in every tab
    return false; // signed in: start() carries on
  } catch (ex) { showSignIn(ex.message); return true; }
}

function signInVersion() {
  const p = h('p', { class: 'signin-version' });
  fetch('/version').then((r) => r.json()).then((v) => { if (v && v.version) p.textContent = `Version ${v.version}`; }).catch(() => {});
  return p;
}

/**
 * Password was right; the second step is still to do: their passkey, the code from their app (or a recovery code), or on a
 * device they have not used before, the code emailed to them.
 */
function showSecondStep(first) {
  clear(app);
  const methods = first.methods || { app: true };
  const err = h('div');
  const parts = [];
  if (methods.passkey) {
    const b = button('Use my passkey', async () => {
      clear(err); b.disabled = true;
      try {
        const { handle, options } = await post('/auth/mfa/passkey-options', { mfa_token: first.mfa_token });
        const response = await passkey.use(options);
        await signedIn(await post('/auth/mfa', { mfa_token: first.mfa_token, handle, response }));
      } catch (ex) { err.append(errorBox(ex)); b.disabled = false; }
    }, { kind: 'primary' });
    parts.push(h('div', { class: 'row' }, b));
  }
  let code = null;
  if (methods.app || methods.email) {
    code = input({ name: 'code', inputmode: methods.email ? 'numeric' : 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', required: true, 'aria-label': 'Code' });
    const go = h('button', { type: 'submit', class: methods.passkey ? 'btn' : 'btn primary' }, 'Verify');
    const hint = methods.email ? `We emailed a six-digit code to ${first.sent_to}, because this device has not signed in before. It works for 10 minutes. ${NO_MAIL}` : 'From your authenticator app. Lost your phone? Type one of your recovery codes instead.';
    const form = h('form', { novalidate: true, 'data-step': 'mfa' }, field(methods.email ? 'Code from your email' : methods.passkey ? 'Or the six-digit code' : 'Six-digit code', code, hint), h('div', { class: 'row' }, go));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(err);
      go.disabled = true;
      try { await signedIn(await post('/auth/mfa', { mfa_token: first.mfa_token, code: code.value.trim() })); } catch (ex) { err.append(errorBox(ex)); go.disabled = false; code.select(); }
    });
    parts.push(form);
  }
  const lead = methods.email ? 'Check your email.' : 'One more step.';
  const say = methods.email ? 'This device has not signed in to your account before.' : methods.passkey ? 'Use your passkey to finish signing in.' : 'Enter the code from your authenticator app to finish signing in.';
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, lead), h('p', null, say)), ridge()),
    h('section', { class: 'signin-form stack' }, h('h2', null, methods.email ? 'New device' : 'Two-step sign-in'), ...parts, err, button('Start again', () => showSignIn(), { small: true }))));
  const first_ = app.querySelector('.signin-form .btn.primary, .signin-form input');
  if (first_) first_.focus();
}

/** A shared terminal: pick yourself by username and type your PIN. Managers and patrol sign in properly instead. */
async function showPinSignIn(message) {
  const term = readTerminal();
  if (!term) { showSignIn(message); return; }
  clear(app);
  const err = h('div');
  const who = input({ name: 'login', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', required: true });
  const pin = input({ name: 'pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', pattern: '[0-9]*', maxlength: 8, required: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Start');
  const form = h('form', { novalidate: true, 'data-step': 'pin' }, field('Username', who, NOT_CASE), field('PIN', pin, 'Your 6 to 8 digit PIN. Set it in Settings after signing in with your password.'), err, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    go.disabled = true;
    try { await signedIn(await post('/auth/pin-login', { tenant: term.tenant, terminal: term.secret, login: who.value.trim(), pin: pin.value.trim() })); } catch (ex) { pin.value = ''; err.append(errorBox(ex)); go.disabled = false; pin.focus(); }
  });
  const title = h('h2', null, term.name);
  app.append(h('div', { class: 'signin terminal' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, 'Shared terminal.'), h('p', null, 'Switch in with your username and PIN. Sign out when you step away, so the next person starts as themselves.')), ridge()),
    h('section', { class: 'signin-form' }, title, message ? h('p', { class: 'muted', role: 'status' }, message) : null, form,
      h('p', { class: 'small' }, button('Sign in with a password or passkey', () => showSignIn(), { small: true })))));
  who.focus();
  // Check this computer is still enrolled (a manager can remove it); if not, it goes back to the normal sign-in.
  try { const t = await post('/auth/terminal', { tenant: term.tenant, terminal: term.secret }); title.textContent = `${t.name}, ${t.mountain}`; } catch (ex) { if (ex.status === 403) { saveTerminal(null); showSignIn(ex.message); } }
}

/** The mountain requires two-step sign-in and this login does not have it yet: nothing else opens until it is set up. */
function showEnrollment() {
  clear(app);
  const done = async () => { await start(); };
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, 'Protect your account.'), h('p', null, ctx.me.mfa_rule === 'mountain' ? 'Your mountain requires two-step sign-in.' : ctx.me.mfa_rule === 'patrol' ? 'Patrol holds patient details, so patrollers use two-step sign-in.' : ctx.me.mfa_rule === 'school_director' ? 'Ski school directors sell, refund and approve pay, so they use two-step sign-in.' : 'Owners, managers and patrol leads use two-step sign-in, because they can change everything.')), ridge()),
    h('section', { class: 'signin-form stack' }, h('p', null, 'Add a passkey (quickest: your fingerprint or face) or an authenticator app. Either one works.'), passkeysPanel(done), mfaPanel(done), button('Sign out', () => signOut(), { small: true }))));
}

/** A manager set a temporary password: the person chooses their own before anything else opens. */
function showPasswordChange() {
  clear(app);
  const err = h('div');
  const cur = input({ name: 'current', type: 'password', autocomplete: 'current-password', required: true });
  const next = input({ name: 'new', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const again = input({ name: 'again', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Save my password');
  const form = h('form', { novalidate: true, 'data-step': 'new-password' }, field('Temporary password', cur, 'The one you were given'), field('New password', next, 'At least 12 characters'), field('New password again', again), err, h('div', { class: 'row' }, go, button('Sign out', () => signOut(), { small: true })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    if (next.value.length < 12) { err.append(errorBox(new Error('Use at least 12 characters'))); return; }
    if (next.value !== again.value) { err.append(errorBox(new Error('The two new passwords are not the same'))); return; }
    go.disabled = true;
    try {
      const out = await post('/auth/change-password', { current_password: cur.value, new_password: next.value });
      session.token = out.token;
      toast('Password saved');
      await start();
    } catch (ex) { err.append(errorBox(ex)); go.disabled = false; }
  });
  app.append(h('div', { class: 'signin' }, h('section', { class: 'signin-side' }, h('div', null, h('p', { class: 'brand' }, h('img', { class: 'brand-logo-full', src: '/brand/verdynt-logo-dark.png', alt: 'Verdynt/OS, resort operating system', width: '220', height: '109' })), h('h1', null, 'Choose your password.'), h('p', null, `Signed in as ${ctx.me.username || ctx.me.email}. Your password was set by a manager; choose your own to continue.`)), ridge()),
    h('section', { class: 'signin-form' }, h('h2', null, 'New password'), form)));
  cur.focus();
}

// ---------------------------------------------------------------- shell
let navToken = 0;
const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });

// An app the platform has turned off for this mountain is hidden for everyone, including the owner.
const ALWAYS = ['dashboard', 'brief', 'calendar', 'inbox', 'people', 'waivers', 'lostfound', 'myshifts', 'settings', 'help', 'area'];
const appOn = (key) => ALWAYS.includes(key) || !ctx.me.modules || ctx.me.modules.includes(VIEW_MODULE[key] || key);
function visibleViews() {
  // A municipality: Today and Inbox, My shifts when Staff and schedule is on, and its own apps (muni release 1).
  if (isMuni()) {
    const shifts = Boolean(ctx.me.modules) && ctx.me.modules.includes('workforce');
    return VIEWS.filter((v) => MUNI_VIEWS.includes(v[0]) && (v[0] !== 'myshifts' || shifts) && (VIEW_MODULE[v[0]] ? !ctx.me.modules || ctx.me.modules.includes(VIEW_MODULE[v[0]]) : appOn(v[0])) && v[2]());
  }
  // The ski area's read-only login sees the summary (patrol, ski school, or both) and its own account, nothing else.
  if (ctx.me.role === 'area') return VIEWS.filter((v) => ['area', 'settings', 'help'].includes(v[0]));
  // A patrol on its own has no customers, waivers or day board to keep.
  const hide = patrolOnly() ? ['dashboard', 'people', 'waivers', 'lostfound', 'myshifts'] : [];
  return VIEWS.filter((v) => !hide.includes(v[0]) && !VIEW_MODULE[v[0]] && appOn(v[0]) && v[2]()); // the municipal views never show for a mountain
}

let frame = null;
function buildShell() {
  clear(app);
  // Instructor availability is a tab of Lessons for everyone but an instructor, so it is not a menu item for them.
  // The Morning brief is opened from Today, its email and its phone alert, so it is not a menu item.
  const inMenu = visibleViews().filter(([key]) => key !== 'brief' && (key !== 'availability' || ownAvailability()));
  // The ski area's read-only login has a menu of its own: the summary (and Help), no All apps.
  const menu = ctx.me.role === 'area' ? AREA_MENU : ctx.me.menu || null;
  frame = buildFrame({ views: inMenu.map(([key, text]) => [key, text]), main, signOut: () => signOut(), menu, links: ctx.me.menu_links || {} });
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
  if (!ctx.me || !frame || ctx.me.role === 'area') return; // the ski area's read-only login has no Inbox
  unreadBusy = true;
  try { const { unread } = await poll('/inbox/unread'); if (frame.setBadge) frame.setBadge('inbox', unread); } catch (_) { /* try again on the next tick */ }
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
  const [key, ...params] = hashPath().split('/').filter((x, i) => i === 0 || x !== '');
  return { key: visibleViews().some((v) => v[0] === key) ? key : null, params, raw: key };
}

// The path of the page on screen. A change to the query alone (a tab: #/rentals?tab=service) does not draw the page again.
let drawnPath = null;

async function route() {
  if (!ctx.me) return;
  if (ctx.me.display === 'patrol_room') { if (location.hash !== '#/patrol/room') history.replaceState(null, '', `${location.pathname}#/patrol/room`); return; } // the room screen goes nowhere else
  const { key, params, raw } = currentPath();
  const moved = REDIRECTS[raw] ? REDIRECTS[raw](location.hash.split('?')[1] || '') : null;
  if (moved) { location.replace(moved); return; }
  if (!key) { location.replace(`#/${defaultView()}`); return; }
  const my = ++navToken;
  drawnPath = hashPath();
  newPage();
  if (frame) frame.setCurrent(key, params);
  clear(main).append(loading());
  const view = visibleViews().find((v) => v[0] === key);
  document.title = `${view[1]} · ${ctx.me.tenant_name}`;
  try {
    const mod = await view[3]();
    const holder = h('div');
    await mod.render(holder, params);
    if (my !== navToken) return;
    clear(main).append(holder);
    decorateHead(holder, key, params, mod);
    noteWork(key, params);
    movedNote(holder, key).catch(() => {});
    main.focus({ preventScroll: true });
  } catch (err) {
    if (my !== navToken) return;
    clear(main).append(errorBox(err));
  }
}

// Apps with a page in Settings, and which page: "<App> settings" in the page header links there (managers and owners).
// Patrol has its own Patrol settings button, shown to patrol admins too.
const SETTINGS_PAGE = { sell: 'sell', gate: 'sell', shop: 'shop', school: 'school', availability: 'school', rentals: 'rentals', waivers: 'waivers', workforce: 'workforce' };
const MAYBE_SETTINGS = { programs: 'programs', messages: 'messages' }; // only when the app has setup to show there
export function settingsPageFor(key, mod) {
  if (SETTINGS_PAGE[key]) return SETTINGS_PAGE[key];
  if (MAYBE_SETTINGS[key] && mod && mod.settingsPages && Object.keys(mod.settingsPages).length) return MAYBE_SETTINGS[key];
  return null;
}
const appName = (key) => (VIEWS.find((v) => v[0] === key) || [key, key])[1];
// The settings button is named for the app ("Lessons settings"); Instructor availability's setup is in Lessons settings.
const SETTINGS_NAME = { availability: 'Lessons' };

/**
 * Notes the page someone is working on (every page but Settings and Help), so "Back to the app" in Settings and the back
 * link on Help return to it, tab and all: Patrol, Gear rather than Today.
 */
function noteWork(key = currentPath().key, params = currentPath().params) {
  if (!key || key === 'settings' || key === 'help') return;
  const part = key === 'patrol' ? (PATROL_SECTIONS.find(([id]) => id === patrolSection(params)) || [])[1] : null;
  noteBack({ hash: location.hash, key, name: part ? `${appName(key)}, ${part}` : appName(key), part: key === 'patrol' ? patrolSection(params) : null });
}
/** Where an app's Help button goes: its Help page, and for Patrol the part it was pressed on (Patrol, Gear: Gear help). */
export function helpHref(key, params = []) {
  if (key === 'patrol') return `#/help/for-patrol?part=${patrolSection(params)}`;
  return `#/help/for-${key}`;
}

/**
 * The page header, the same on every page: a breadcrumb (App / Tab) where the page has tabs (Patrol / Section on
 * Patrol), the title, the page's one-line summary, a Help button, and "<App> settings" for managers. Done here, so
 * each screen only says its title and summary.
 */
function decorateHead(holder, key, params, mod) {
  const area = GROUP_OF[key];
  if (area) holder.dataset.group = area.id;
  holder.dataset.app = key;
  const head = holder.querySelector('.page-head');
  if (!head || head.dataset.decorated) return;
  head.dataset.decorated = '1';
  const h1 = head.querySelector('h1');
  if (!h1) return;
  // The title and its summary sit together on the left.
  let lead = h1.parentElement === head ? null : h1.parentElement;
  if (!lead || lead.parentElement !== head) {
    lead = h('div', { class: 'head-lead' });
    h1.replaceWith(lead);
    lead.append(h1);
    const next = lead.nextElementSibling;
    if (next && next.tagName === 'P') lead.append(next);
  } else lead.classList.add('head-lead');
  const crumbs = key === 'settings' ? null : breadcrumb(holder, key, params); // Settings draws its own
  if (crumbs) lead.prepend(crumbs);
  // Help and the app's settings: next to the title, before the page's own buttons.
  // On a phone both are icon buttons in the title row (the words hide; the names stay for screen readers).
  const tools = h('div', { class: 'head-tools' });
  const page = isManager() ? settingsPageFor(key, mod) : null;
  const own = head.querySelector('.head-settings'); // an app that draws its own (Patrol settings, for patrol Admins too)
  const setName = own ? own.textContent.trim() : `${SETTINGS_NAME[key] || appName(key)} settings`;
  if (own) { own.classList.add('btn', 'small'); own.setAttribute('aria-label', setName); own.title = setName; tools.append(own); } else if (page) tools.append(h('a', { class: 'btn small head-settings', href: `#/settings/${page}`, 'aria-label': setName, title: setName }, icon('settings', 16), h('span', { class: 'head-btn-text' }, setName)));
  if (key !== 'help') tools.append(h('a', { class: 'btn small help-btn', href: helpHref(key, params), 'aria-label': `Help with ${appName(key)}`, title: 'Help' }, icon('help', 16), h('span', { class: 'head-btn-text' }, 'Help')));
  if (tools.firstChild) lead.after(tools);
}

/** "Rentals / Service": the app, then the open tab (or Patrol's section). Kept up to date as tabs change. */
function breadcrumb(holder, key, params) {
  const name = appName(key);
  const bar = holder.querySelector('.tabs[data-address]');
  if (key !== 'patrol' && !bar) return null;
  const here = h('span', { 'aria-current': 'page' });
  const nav = h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: `#/${key}` }, name), h('span', { 'aria-hidden': 'true' }, '/'), here);
  const paint = () => {
    if (key === 'patrol') { here.textContent = (PATROL_SECTIONS.find(([id]) => id === patrolSection(params)) || PATROL_SECTIONS[0])[1]; return; }
    const on = bar.querySelector('[aria-selected=true]');
    here.textContent = on ? on.textContent : '';
  };
  paint();
  holder.addEventListener('tabs:change', (e) => { if (bar && e.target.contains(bar)) paint(); });
  return nav;
}

// For 30 days after the release that moved it (2026.11.12), apps whose setup moved into Settings say so: managers only,
// until they dismiss it. A dismissal is kept per login on the server (/notices), so it stays gone on every device and on
// every view of the app (feat/school-pay); this browser remembers it too, in case the server cannot be reached.
export const MOVED_FROM = '2026-11-08';
export const MOVED_DAYS = 30;
const MOVED_PAGE = { sell: 'sell', gate: 'sell', shop: 'shop', school: 'school', availability: 'school', rentals: 'rentals', waivers: 'waivers', workforce: 'workforce', patrol: 'patrol' };
export function movedNoteDue(key, today) {
  if (!MOVED_PAGE[key]) return false;
  const start = Date.parse(`${MOVED_FROM}T00:00:00Z`);
  const day = Date.parse(`${today}T00:00:00Z`);
  return day >= start && day < start + MOVED_DAYS * 86400000;
}
const movedKey = () => `so.moved.${ctx.me.tenant || ''}.${ctx.me.id || ctx.me.email || ''}`;
function movedDismissed() { try { return JSON.parse(localStorage.getItem(movedKey()) || '[]'); } catch (_) { return []; } }
let serverNotices = null; // this login's dismissed notes, read once per page load
async function noticesDismissed() {
  if (!serverNotices) serverNotices = get('/notices').then((r) => r.dismissed || []).catch(() => []);
  return serverNotices;
}
export const movedNoticeKey = (key) => `moved:${MOVED_PAGE[key] || key}`;
async function movedNote(holder, key) {
  if (!isManager() || !movedNoteDue(key, todayStr()) || movedDismissed().includes(key)) return;
  if ((await noticesDismissed()).includes(movedNoticeKey(key))) return;
  const head = holder.querySelector('.page-head');
  if (!head || holder.querySelector('.moved-note')) return;
  const close = h('button', { type: 'button', class: 'moved-close', 'aria-label': 'Dismiss this note' }, icon('close', 16));
  const note = h('div', { class: 'moved-note', role: 'note' }, h('span', null, 'Setup for this app moved to Settings. '), h('a', { href: `#/settings/${MOVED_PAGE[key]}` }, `Open ${appName(key)} settings`), close);
  close.addEventListener('click', () => {
    try { localStorage.setItem(movedKey(), JSON.stringify([...new Set([...movedDismissed(), key])])); } catch (_) { /* the server keeps it */ }
    serverNotices = noticesDismissed().then((list) => [...list, movedNoticeKey(key)]);
    post('/notices/dismiss', { key: movedNoticeKey(key) }).catch(() => { /* this browser still remembers it */ });
    note.remove();
  });
  head.after(note);
}

// Why the last session ended, carried across the reload to the sign-in screen (this tab only).
const SAID_KEY = 'so.signedout';
function takeSaid() { try { const m = sessionStorage.getItem(SAID_KEY); sessionStorage.removeItem(SAID_KEY); return m || undefined; } catch (_) { return undefined; } }
const within = (p, ms) => Promise.race([p, new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); })]); // (unref: test runners only)

let signingOut = false;
/**
 * Every way out (Sign out, 15 minutes without activity, a session the server ended, a PIN switch on a shared terminal)
 * ends with a fresh page. Dialogs, the Ask panel, timers and what each screen kept all live in the page, so starting it
 * again is the only sure way none of it reaches the next person. message: why it happened (none when on purpose).
 */
async function signOut(message) {
  if (signingOut) return;
  endTour();
  // Patrol entries kept on this phone while there was no signal go with the person who typed them. Try to send them first;
  // if they still cannot go, say so before signing out (they stay on this phone for up to three days, for this person).
  if (!message) {
    try { if (waitingCounts().mine) await flushOutbox(); } catch (_) { /* still offline */ }
    const left = waitingCounts().mine;
    if (left && !window.confirm(`${left} patient care entr${left === 1 ? 'y has' : 'ies have'} not been sent yet (no signal). They stay on this phone and send when you sign in again with a signal. Sign out anyway?`)) return;
  }
  signingOut = true;
  // Each open dialog's own clean-up runs while this session can still act: a camera or NFC reader is let go, and a card
  // already charged on the reader goes back to the guest. (After a session the server ended, that refund cannot go from here.)
  await within(closeAllDialogs(), 8000);
  await within(import('./assistant.js').then((m) => m.resetAssistant()).catch(() => {}), 2000);
  // Signing out on purpose on a shared phone or tablet: this person's phone alerts stop coming to it. An automatic
  // sign-out leaves them on, so a patroller's own phone still gets dispatch calls after it locks itself.
  if (!message && ctx.me && (ctx.me.role === 'patrol' || ctx.me.on_patrol) && alerts.supported()) await within(alerts.turnOff().catch(() => {}), 3000);
  if (!message) forgetCases(); // signing out on purpose clears the cases kept for a dead spot
  dropDeviceKey(); // what stays on the phone is sealed, and the key goes with the session (the sealed entries stay)
  // End the session on the server too (also after an idle sign-out). Sent with the token directly, so a session the server
  // already ended cannot bounce back into another sign-out; keepalive lets it finish while the page reloads.
  const ending = session.token;
  session.clear();
  if (ending) fetch('/api/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${ending}` }, keepalive: true }).catch(() => { /* offline: it expires on its own */ });
  ctx.me = null;
  navToken += 1;
  try { if (message) sessionStorage.setItem(SAID_KEY, message); } catch (_) { /* the sign-in screen shows no reason */ }
  // The sign-in screen at once, then the fresh page. What it needs is kept: the mountain name and a shared terminal's
  // enrollment (both in this browser's storage), and why the session ended.
  history.replaceState(null, '', location.pathname);
  if (readTerminal()) showPinSignIn(message); else showSignIn(message);
  signingOut = false;
  freshPage();
}

/** Loads the page again as soon as the server answers. With no signal the sign-in screen stays until it does. */
async function freshPage() {
  for (;;) {
    if (session.token) return; // signed in again on this screen meanwhile: nothing to start over
    try { const r = await within(fetch('/version', { cache: 'no-store' }), 4000); if (r && r.ok) { location.replace(location.pathname); return; } } catch (_) { /* no signal yet */ }
    await new Promise((r) => { const t = setTimeout(r, 15000); if (t && t.unref) t.unref(); });
  }
}

hooks.onSignedOut = () => { if (ctx.me) signOut('Your session ended. Sign in again.'); };
hooks.stepUp = (details) => confirmItsYou(details);
hooks.signOut = () => signOut();

// A phone or screen left open should not leave guest and patient details on display.
// - A shared terminal (a computer a manager enrolled for PIN sign-in) keeps its own rule: signed out after 15 minutes.
// - Everywhere else, a tab nobody uses for 10 minutes locks itself (tablock.js, showLocked). The patrol-room screen stays up.
const IDLE_MINUTES = 15;
const onTerminal = () => Boolean(readTerminal());
let idleTimer = null;
function resetIdle() {
  clearTimeout(idleTimer);
  if (!ctx.me || !onTerminal()) return;
  // The patrol-room screen stays up all day on a shared tablet. The server holds its session to that screen (names, signing in
  // and out, never patient details), and leaving it needs the leader's password, passkey or code.
  idleTimer = setTimeout(() => { if (ctx.me && ctx.me.display === 'patrol_room') { resetIdle(); return; } if (ctx.me) signOut(`Signed out after ${IDLE_MINUTES} minutes without activity.`); }, IDLE_MINUTES * 60_000);
  if (idleTimer && idleTimer.unref) idleTimer.unref(); // (test runners only: a pending timer must not keep the process alive)
}
const touchedPage = () => { noteActivity(); resetIdle(); tabActivity(); };
for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) document.addEventListener(ev, touchedPage, { passive: true, capture: true });
// Moving the mouse over the page, or coming back to the tab, counts as using it for the tab lock (not for the server).
document.addEventListener('pointermove', () => tabActivity(), { passive: true, capture: true });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tabActivity(); });
// Arm the timer shortly after sign-in, and again whenever it has been cleared by a sign-out and back in.
setInterval(() => { if (ctx.me && !idleTimer) resetIdle(); if (!ctx.me) { clearTimeout(idleTimer); idleTimer = null; } }, 5_000).unref?.();

let locking = false;
/** This tab was idle 10 minutes: tidy up like a sign-out, lock it, and load the page again (nothing stays in memory). */
async function lockTab() {
  if (locking || signingOut || !ctx.me || onTerminal() || ctx.me.display === 'patrol_room') return;
  locking = true;
  // A patrol or leader session with a passkey or app: locked on the server, kept, and resumed with one touch (showResume).
  if (ctx.me.resumable && session.token) {
    try {
      const out = await post('/auth/lock');
      if (out && out.locked && out.resumable) {
        endTour();
        await within(closeAllDialogs(), 8000);
        dropDeviceKey();
        ctx.me = null;
        navToken += 1;
        location.reload(); // nothing stays in memory; start() finds the paused session and shows the resume screen
        return;
      }
    } catch (_) { /* the server may already have paused it: carry on as before */ }
  }
  const shared = session.shared;
  const token = session.token;
  const who = { tenant: ctx.me.tenant, login: ctx.me.login_name || ctx.me.username || ctx.me.email, name: [ctx.me.first_name, ctx.me.last_name].filter(Boolean).join(' ') || null, shared };
  endTour();
  await within(closeAllDialogs(), 8000);
  await within(import('./assistant.js').then((m) => m.resetAssistant()).catch(() => {}), 2000);
  dropDeviceKey();
  session.lock(who);
  ctx.me = null;
  navToken += 1;
  if (!shared) {
    // This tab's own sign-in (no Remember me): no other tab uses it, so it ends now.
    session.unlock(); session.clear(); session.lock(who);
    if (token) fetch('/api/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
  } else tabCheckNow(); // the last tab in use: the shared sign-in ends too
  showLocked(who);
  location.reload();
}

startTabWatch({
  enabled: () => Boolean(ctx.me) && !onTerminal() && ctx.me.display !== 'patrol_room',
  awake: () => Boolean(ctx.me) && ctx.me.display === 'patrol_room',
  onLock: () => { lockTab(); },
});

// Other tabs of this browser share a Remember me sign-in. When it ends there (Sign out, or every tab idle), this tab
// follows; when someone else signs in with Remember me, this tab reloads as them rather than mixing two people.
const tokenUser = (t) => { try { const p = JSON.parse(atob(String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return `${p.tid}:${p.sub}`; } catch (_) { return null; } };
window.addEventListener('storage', (e) => {
  if (e.key !== 'so.token' || session.locked()) return;
  if (ctx.me && !e.newValue && e.oldValue && !session.token) {
    // Every tab was idle (this one too): it locks like the others. Otherwise someone signed out in another tab.
    if (!tabMsLeft() && !onTerminal()) lockTab(); else signOut('Your sign-in ended in another tab. Sign in again.');
    return;
  }
  if (ctx.me && e.newValue && e.oldValue && tokenUser(e.newValue) !== tokenUser(e.oldValue) && session.token === e.newValue) { location.reload(); return; }
  if (!ctx.me && e.newValue && !signingOut && app.querySelector('form[data-step="signin"]')) start(); // signed in in another tab
});

async function start() {
  if (/^#(email|reset)-link=/.test(location.hash) && await fromEmailLink()) return;
  const said = takeSaid();
  const lockedAs = session.locked();
  if (lockedAs) { if (readTerminal()) { session.unlock(); session.clear(); } else { showLocked(lockedAs, said); return; } }
  if (!session.token) { if (readTerminal()) showPinSignIn(said); else showSignIn(said); return; }
  let offline = false;
  try {
    ctx.me = await get('/auth/me');
    session.keepMe(ctx.me);
  } catch (err) {
    // Only the server saying the sign-in is over (401) signs out. No signal, a timeout or a server hiccup keeps the
    // sign-in: the app opens in offline mode from what this tab last knew, so a patroller at the bedside loses nothing.
    if (err && err.status === 401 && err.details && err.details.code === 'resume') { await showResume(); return; }
    if (err && err.status === 401) {
      session.clear();
      if (readTerminal()) showPinSignIn(); else showSignIn();
      return;
    }
    const kept = session.keptMe();
    if (!kept) { showNoSignal(); return; }
    ctx.me = kept; offline = true;
  }
  ctx.tz = ctx.me.timezone || ctx.tz;
  if (ctx.me.display === 'patrol_room' && !offline) { await showRoom(); return; }
  // Opens (and sends) any patrol entries this person left waiting on this phone; they are sealed with this key.
  try {
    const opened = offline ? await restoreDeviceKey() : await setDeviceKey(ctx.me.device_key);
    if (opened && waitingCounts().mine && !offline) flushOutbox();
  } catch (_) { /* nothing waiting */ }
  if (offline) { buildShell(); offlineBanner(); await route(); return; }
  if (ctx.me.must_change_password) { showPasswordChange(); return; }
  if (ctx.me.mfa_enrollment_required) { showEnrollment(); return; }
  if (ctx.me.export_only) { (await import('./views/closed-export.js')).show(app, signOut); return; } // a closed mountain's owner
  buildShell();
  if (ctx.me.mfa_starts_on && !ctx.me.mfa_enabled) {
    main.before(h('div', { class: 'banner warn', role: 'status', 'data-banner': 'mfa-soon' }, `From ${new Date(`${ctx.me.mfa_starts_on}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}, patrollers need two-step sign-in, because Patrol holds patient details. `,
      h('a', { href: '#/settings' }, 'Set it up now in Settings'), ' (a passkey takes a minute).'));
  }
  await route();
  if (ctx.me.signed_in_with === 'passkey') notePasskeyHere();
  if (ctx.me.sandbox) { resumeTour(); welcomeOnce(); }
  // Offered once the first page has settled: opening a role's start page changes the address, which closes open dialogs.
  // Never on top of a dialog the person already opened (Add lift, say): it waits until no dialog is open.
  else if (ctx.me.passkey_prompt) {
    const p = ctx.me.passkey_prompt; const who = ctx.me.id;
    const when = () => { if (!ctx.me || ctx.me.id !== who) return; if (document.querySelector('.overlay')) { setTimeout(when, 1500); return; } offerPasskey(p); };
    setTimeout(when, 900);
  }
}

/**
 * Passkeys as the default for leaders (feat/auth-hardening): owners, managers and patrol directors and admins are asked
 * after signing in until they have two; patrollers and the ski area login are offered one once. Always skippable.
 */
/** "Keeps working as a backup", only for what this login really has (passkey_prompt.app and .codes from /auth/me). */
function backupLine(p) {
  if (p.app && p.codes) return 'Your authenticator app and recovery codes keep working as a backup.';
  if (p.app) return 'Your authenticator app keeps working as a backup.';
  if (p.codes) return 'Your recovery codes keep working as a backup.';
  if (p.have) return p.have === 1 ? 'The passkey you have keeps working.' : 'The passkeys you have keep working.';
  return null;
}

function offerPasskey(p) {
  const SKIP = 'so.pk.later';
  try { if (sessionStorage.getItem(SKIP)) return; } catch (_) { /* fine */ }
  if (!passkey.supported()) return;
  const leader = p.kind === 'leader';
  const err = h('div');
  const later = async () => {
    try { sessionStorage.setItem(SKIP, '1'); } catch (_) { /* fine */ }
    if (!leader) post('/auth/passkey-prompt/seen').catch(() => {});
    dlg.close();
  };
  const add = button(p.have ? 'Add a second passkey here' : 'Add a passkey on this device', async () => {
    clear(err); add.disabled = true;
    try {
      const { addPasskey } = await import('./views/security.js');
      await addPasskey();
      notePasskeyHere();
      toast(leader && p.have + 1 < 2 ? 'Passkey added. Add a second one on another phone or a security key, in Settings.' : 'Passkey added. Next time, one touch signs you in.');
      try { sessionStorage.setItem(SKIP, '1'); } catch (_) { /* fine */ }
      if (!leader) post('/auth/passkey-prompt/seen').catch(() => {});
      dlg.close();
    } catch (ex) { err.append(errorBox(ex)); add.disabled = false; }
  }, { kind: 'primary' });
  add.classList.add('big', 'passkey-big');
  const body = h('div', { class: 'stack', 'data-passkey-prompt': p.kind },
    h('p', { class: 'resume-lead' }, 'One touch with your fingerprint or face, and no code to type.'),
    leader && isMuni() ? h('p', null, `You can see residents' details and change who can do what, so a passkey is the safest way in: nobody can phish it or guess it. Add two: one on this device, and a second on another phone or a security key, so a lost phone never locks you out. You have ${p.have} of 2.`)
      : leader ? h('p', null, `You can see every patient record and change who can do what, so a passkey is the safest way in: nobody can phish it or guess it. Add two: one on this device, and a second on another phone or a security key, so a lost phone never locks you out. You have ${p.have} of 2.`)
      : h('p', null, 'Patrol records are private. A passkey signs you in and opens records with one touch, even with cold hands.'),
    backupLine(p) ? h('p', { class: 'muted small', 'data-backup': '' }, backupLine(p)) : null,
    add, err, h('div', { class: 'row' }, button('Not now', later, { small: true, kind: 'quiet' })));
  const dlg = dialog('Add a passkey', body, { onClose: () => { try { sessionStorage.setItem(SKIP, '1'); } catch (_) { /* fine */ } } });
}

/** Opened with no signal: a strip says so, and offers to reload once the signal is back. */
function offlineBanner() {
  const again = h('button', { type: 'button', class: 'btn small', hidden: true }, 'Signal is back: reload');
  again.addEventListener('click', () => location.reload());
  main.before(h('div', { class: 'banner warn', role: 'status', 'data-banner': 'offline' }, 'No signal: opened from this phone. Patrol cases kept here, new cases and bedside entries work and send later. Other pages need a signal. ', again));
  window.addEventListener('online', () => { again.hidden = false; }, { once: true });
}

/** No signal and nothing kept in this tab yet: the sign-in is kept, and the page tries again when the signal returns. */
function showNoSignal() {
  clear(app);
  const retry = h('button', { type: 'button', class: 'btn primary' }, 'Try again');
  retry.addEventListener('click', () => location.reload());
  app.append(h('main', { class: 'main', id: 'main' }, h('section', { class: 'panel stack', role: 'status', 'data-area': 'no-signal' },
    h('h1', null, 'No signal'), h('p', null, 'Verdynt/OS cannot reach the server. You are still signed in. It tries again when the signal returns.'), retry)));
  window.addEventListener('online', () => location.reload(), { once: true });
}

/** The patrol-room screen on its own, without the menu: this session can do nothing else (the server holds it to that). */
async function showRoom() {
  clear(app);
  frame = null;
  if (location.hash !== '#/patrol/room') history.replaceState(null, '', `${location.pathname}#/patrol/room`);
  document.title = `Patrol room · ${ctx.me.tenant_name}`;
  const holder = h('main', { class: 'main room-screen', id: 'main' });
  app.append(holder);
  try { await (await import('./views/patrol-duty.js')).renderRoom(holder); } catch (err) { holder.append(errorBox(err)); }
}

// Moving to another page closes any dialog left open on the last one (for example a customer opened from an Inbox link).
// A change to the query alone (Back to the last tab) stays on the page: the tabs follow the address themselves.
let lastPath = hashPath();
let lastHash = location.hash;
window.addEventListener('hashchange', () => {
  const now = hashPath();
  // Back (or a link) while a form has something typed in it: ask first, and stay on the page if the answer is no.
  if (now !== lastPath && dirtyDialogOpen() && !window.confirm('Leave this page? What you typed in the open form will be lost.')) {
    history.pushState(null, '', lastHash);
    return;
  }
  lastHash = location.hash;
  if (now !== lastPath) closeAllDialogs();
  lastPath = now;
  if (ctx.me && frame && drawnPath !== null && now === drawnPath && currentPath().key) { noteWork(); return; } // a tab change: remember the tab
  route();
});
watchPasswords();
// The service worker keeps this release's app on the phone, so a reload with no signal still opens it (public/sw.js).
try { if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); } catch (_) { /* not available */ }
start();

export { route };
