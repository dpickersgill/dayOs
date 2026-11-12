'use strict';

// Pins on the page (public/js/pins.js), against the real API, with jsdom and a stand-in for the frame built to the
// contract in the release's shared spec: setPins, addCommands, canEdit, slots.star, and the nav:page, nav:edit-pins and
// nav:row-menu events. Checked here: the star, the row menu, the palette commands, Edit (reorder with the arrows,
// rename, unpin, reset, the phone bar), a refused save putting the menu back, the limit of 12, and that a shared
// counter computer is offered nothing. Dragging and the look are checked in a real browser.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }

const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const slug = `pinsweb-${suffix}`;
const PW = 'correct-horse-battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = JSDOM ? false : 'jsdom is not installed';

let server; let base; let tmp; let pins; let ui; let apiMod;
let inflight = 0;
const T = {};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const login = async (email) => ok(await api('POST', '/auth/login', { body: { tenant: slug, email, password: PW } })).token;
/** Waits until no request is in flight (a save is sent after the menu has already changed). */
async function settle() {
  let calm = 0;
  for (let i = 0; i < 200 && calm < 3; i++) { await sleep(10); calm = inflight === 0 ? calm + 1 : 0; }
}
const serverNav = async (who) => ok(await api('GET', '/me/nav', { token: T[who] }));
const hrefs = (list) => list.map((p) => p.href);
const labels = (list) => list.map((p) => p.label);

/** A frame to the contract: what pins.js may call, and a record of what it was told. */
function fakeFrame({ canEdit = true } = {}) {
  const slot = document.createElement('span');
  document.body.append(slot);
  const f = { shown: [], commands: [], canEdit, slots: { star: slot }, plan: { home: ['dashboard', 'inbox', 'calendar', 'myshifts'] } };
  f.setPins = (list, bar) => f.shown.push({ pins: list, bar });
  f.addCommands = (fn) => f.commands.push(fn);
  f.last = () => f.shown[f.shown.length - 1];
  f.palette = () => f.commands.flatMap((fn) => fn());
  return f;
}
const say = (name, detail) => window.dispatchEvent(new window.CustomEvent(name, { detail }));
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
const clearToasts = () => document.querySelectorAll('.toast').forEach((t) => t.remove());
const click = (el) => { assert.ok(el, 'the control is there'); assert.ok(!el.disabled, `${el.textContent || el.getAttribute('aria-label')} can be pressed`); el.click(); };
const editor = () => document.querySelector('.dialog .pins-edit');
const rowNames = (sel = '.pins-section:not(.pins-bar) .pins-row') => [...document.querySelectorAll(sel)].map((li) => li.querySelector('.pins-name, .pins-name-input').textContent.trim());

/** Signs the page in as this person, on a fresh page, and starts pins with a new frame. */
async function open(who, { canEdit = true, hash = '#/dashboard', title = 'Today' } = {}) {
  document.body.replaceChildren();
  apiMod.session.token = T[who];
  ui.ctx.me = ok(await api('GET', '/auth/me', { token: T[who] }));
  window.history.replaceState(null, '', `${window.location.pathname}${hash}`);
  document.title = `${title} · Pins Web`;
  const frame = fakeFrame({ canEdit });
  const live = pins.start(frame);
  return { frame, live, star: () => frame.slots.star.querySelector('.pin-star') };
}

test.before(async () => {
  if (skip) return;
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: 'Pins Web', owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201);
  T.owner = await login(`owner@${slug}.test`);
  for (const role of ['manager', 'counter', 'staff']) {
    ok(await api('POST', '/users', { token: T.owner, body: { email: `${role}@${slug}.test`, password: PW, role } }));
    T[role] = await login(`${role}@${slug}.test`);
  }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${base}/`, pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ['document', 'Node', 'HTMLElement', 'sessionStorage', 'localStorage', 'location', 'history', 'Event']) Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: w, configurable: true, writable: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => { inflight += 1; try { return await realFetch(...a); } finally { inflight -= 1; } };
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-pins-'));
  fs.cpSync(path.join(__dirname, '..', 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  const imp = (f) => import(pathToFileURL(path.join(tmp, 'js', f)).href);
  apiMod = await imp('api.js'); ui = await imp('ui.js'); pins = await imp('pins.js');
  apiMod.config.base = base;
});

test.after(async () => {
  if (skip) return;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('what an address may be, on the page as on the server', { skip }, () => {
  const menus = require('../src/lib/menus');
  for (const href of ['patrol', 'patrol/cases?tab=records', 'works?dept=water&status=overdue', 'settings/team?tab=menus', 'javascript:alert(1)', '//x', 'patrol/..', 'a b', '#', '', 'patrol?x=<y>', `sell?${'a'.repeat(200)}`]) {
    assert.equal(pins.pinnable(href), menus.goodHref(href), JSON.stringify(href));
  }
  assert.equal(pins.hrefOfHash('#/works?status=overdue'), 'works?status=overdue');
  assert.equal(pins.hrefOfHash('#/patrol/cases/'), 'patrol/cases');
  assert.equal(pins.hrefOfHash('#/sell?'), 'sell');
  assert.equal(pins.hrefOfHash('patrol/cases?tab=records'), 'patrol/cases?tab=records', 'the frame sends it without "#/"');
  assert.equal(pins.pinHref('people?q=o\'brien'), 'people', 'filters an address may not hold are left off');
  assert.equal(pins.pinHref('javascript:alert(1)'), null);
  assert.equal(pins.appOf('patrol/cases?tab=records'), 'patrol');
  assert.deepEqual(pins.moved(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(pins.moved(['a', 'b', 'c'], 2, 3), ['a', 'b', 'c'], 'no place past the end');
  assert.deepEqual([pins.PIN_MAX, pins.LABEL_MAX, pins.BAR_MAX], [menus.PIN_MAX, menus.PIN_LABEL_MAX, menus.BAR_MAX]);
});

test('start: the person\'s pins go to the frame, the star is in its slot, and the palette has its commands', { skip }, async () => {
  const { frame, live, star } = await open('counter');
  assert.deepEqual(hrefs(frame.last().pins), ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'], 'the role\'s starting pins');
  assert.equal(frame.last().bar, null);
  assert.equal(live.canEdit, true);
  assert.ok(star(), 'the star');
  assert.equal(star().getAttribute('aria-label'), 'Pin this page to your menu');
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  assert.deepEqual(frame.palette().map((c) => c.title), ['Pin this page', 'Edit my pins', 'Edit my phone bar']);
  for (const c of frame.palette()) assert.ok(c.id && c.icon && typeof c.words === 'string' && typeof c.run === 'function', c.title);
  // Without nav on the person (an older server): nothing is started and the frame keeps its own starting pins.
  ui.ctx.me = { ...ui.ctx.me, nav: undefined };
  const bare = fakeFrame();
  assert.equal(pins.start(bare), null);
  assert.equal(bare.shown.length, 0);
  assert.equal(bare.slots.star.children.length, 0);
});

test('the star pins the page you are on, with its tab and filters, and a second press unpins it', { skip }, async () => {
  const { frame, star } = await open('counter');
  say('nav:page', { key: 'sell', href: 'sell?tab=window', label: 'Sell: Ticket window' });
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  click(star());
  // The menu changes at once, before the server has answered.
  assert.deepEqual(hrefs(frame.last().pins).slice(-1), ['sell?tab=window']);
  assert.equal(star().getAttribute('aria-pressed'), 'true');
  assert.equal(star().title, 'Unpin this page');
  assert.deepEqual(toasts(), ['Pinned Sell: Ticket window']);
  await settle();
  const saved = await serverNav('counter');
  assert.equal(saved.custom, true);
  assert.deepEqual(saved.pins[saved.pins.length - 1], { id: saved.pins[6].id, label: 'Sell: Ticket window', href: 'sell?tab=window', app: 'sell' });
  assert.equal(saved.pins.length, 7, 'the role\'s six and this one');
  assert.deepEqual(ui.ctx.me.nav.pins, saved.pins, 'the page keeps what the server kept');
  // Another page: not pressed. Back: pressed. The app's own page is another address.
  say('nav:page', { key: 'sell', href: 'sell?tab=orders', label: 'Sell: Orders' });
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  say('nav:page', { key: 'sell', href: 'sell', label: 'Sell' });
  assert.equal(star().getAttribute('aria-pressed'), 'true', 'Sell itself is one of the role\'s pins');
  say('nav:page', { key: 'sell', href: 'sell?tab=window', label: 'Sell: Ticket window' });
  assert.equal(star().getAttribute('aria-pressed'), 'true');
  clearToasts();
  click(star());
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  assert.deepEqual(toasts(), ['Unpinned Sell: Ticket window']);
  await settle();
  assert.deepEqual(hrefs((await serverNav('counter')).pins), ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop']);
  // A page whose address cannot be pinned at all: the star says so.
  say('nav:page', { key: null, href: '', label: '' });
  assert.equal(star().disabled, true);
  assert.equal(star().title, 'This page cannot be pinned');
  ok(await api('DELETE', '/me/nav', { token: T.counter }));
});

test('a pins.js that starts after the first page change reads the page from frame.page', { skip }, async () => {
  document.body.replaceChildren();
  apiMod.session.token = T.counter;
  ui.ctx.me = ok(await api('GET', '/auth/me', { token: T.counter }));
  window.history.replaceState(null, '', `${window.location.pathname}#/dashboard`);
  const frame = fakeFrame();
  frame.page = { key: 'sell', href: 'sell', label: 'Sell' };
  pins.start(frame);
  const star = frame.slots.star.querySelector('.pin-star');
  assert.equal(star.getAttribute('aria-pressed'), 'true', 'Sell is pinned, though the address says Today');
  assert.equal(frame.palette()[0].title, 'Unpin this page');
});

test('the row menu: Pin or Unpin at the pointer, with the keyboard, and focus goes back', { skip }, async () => {
  const { frame } = await open('staff');
  const row = document.createElement('a'); row.href = '#/documents'; row.textContent = 'Documents'; document.body.append(row);
  row.focus();
  say('nav:row-menu', { key: 'documents', href: 'documents', label: 'Documents', x: 40, y: 300, pinned: false });
  const menu = document.querySelector('.pin-menu');
  assert.ok(menu, 'the menu opened');
  assert.equal(menu.getAttribute('role'), 'menu');
  const items = [...menu.querySelectorAll('[role=menuitem]')];
  assert.deepEqual(items.map((b) => b.textContent), ['Pin to my menu', 'Edit pins']);
  assert.equal(document.activeElement, items[0], 'focus is on the first choice');
  menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement, items[1]);
  menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(document.activeElement, items[0], 'and round again');
  menu.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.pin-menu'), null, 'Escape closes it');
  assert.equal(document.activeElement, row, 'and focus is back on the row');
  // Pin.
  say('nav:row-menu', { key: 'documents', href: 'documents', label: 'Documents', x: 40, y: 300, pinned: false });
  click(document.querySelector('.pin-menu [role=menuitem]'));
  assert.equal(document.querySelector('.pin-menu'), null);
  assert.deepEqual(hrefs(frame.last().pins), ['conditions', 'gate', 'lostfound', 'documents']);
  await settle();
  assert.deepEqual(labels((await serverNav('staff')).pins), ['Mountain status', 'Gate', 'Lost and found', 'Documents']);
  // Now it says Unpin; a second menu replaces the first; a press elsewhere closes it.
  say('nav:row-menu', { key: 'gate', href: 'gate', label: 'Gate', x: 40, y: 200, pinned: true });
  say('nav:row-menu', { key: 'documents', href: 'documents', label: 'Documents', x: 40, y: 300, pinned: true });
  assert.equal(document.querySelectorAll('.pin-menu').length, 1);
  assert.equal(document.querySelector('.pin-menu [role=menuitem]').textContent, 'Unpin');
  click(document.querySelector('.pin-menu [role=menuitem]'));
  assert.deepEqual(hrefs(frame.last().pins), ['conditions', 'gate', 'lostfound']);
  await settle();
  say('nav:row-menu', { key: 'gate', href: 'gate', label: 'Gate', x: 40, y: 200, pinned: true });
  document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(document.querySelector('.pin-menu'), null);
  ok(await api('DELETE', '/me/nav', { token: T.staff }));
});

test('Jump to: Pin this page, Unpin this page, Edit my pins', { skip }, async () => {
  const { frame } = await open('manager');
  say('nav:page', { key: 'patrol', href: 'patrol/cases?tab=records', label: 'Patrol: Cases' });
  const cmd = (title) => frame.palette().find((c) => c.title === title);
  assert.equal(cmd('Pin this page').hint, 'Patrol: Cases');
  cmd('Pin this page').run();
  assert.ok(cmd('Unpin this page'), 'the command follows the page');
  await settle();
  assert.deepEqual((await serverNav('manager')).pins.slice(-1).map((p) => [p.label, p.href, p.app]), [['Patrol: Cases', 'patrol/cases?tab=records', 'patrol']]);
  cmd('Unpin this page').run();
  await settle();
  assert.equal((await serverNav('manager')).pins.length, 6);
  cmd('Edit my pins').run();
  assert.ok(editor(), 'Edit opened');
  document.querySelector('.dialog header button').click();
  assert.equal(editor(), null);
  ok(await api('DELETE', '/me/nav', { token: T.manager }));
});

test('Edit: reorder with the arrows, rename, unpin, and reset to the role\'s menu', { skip }, async () => {
  const { frame } = await open('staff');
  say('nav:edit-pins', { bar: false });
  assert.ok(editor(), 'Edit opened');
  assert.equal(document.querySelector('.dialog h2').textContent, 'Edit your pins');
  assert.deepEqual(rowNames(), ['Mountain status', 'Gate', 'Lost and found']);
  await settle(); // the role's menu arrives for Reset
  const btn = (name, act) => [...document.querySelectorAll(`.pins-row [data-act=${act}]`)].find((b) => b.getAttribute('aria-label').includes(name));
  assert.equal(btn('Mountain status', 'up').disabled, true, 'the first cannot go up');
  assert.equal(btn('Lost and found', 'down').disabled, true, 'the last cannot go down');
  assert.equal(document.querySelector('[data-act=reset]').disabled, true, 'nothing to reset yet');
  // Move Gate up: the list, the menu and the server follow; the keyboard stays on the button that was pressed.
  click(btn('Gate', 'up'));
  assert.deepEqual(rowNames(), ['Gate', 'Mountain status', 'Lost and found']);
  assert.deepEqual(hrefs(frame.last().pins), ['gate', 'conditions', 'lostfound']);
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Move Gate down', 'Gate is first now and cannot go up, so the keyboard is on its other arrow');
  assert.equal(document.querySelector('.pins-edit ~ [role=status], .dialog [role=status]').textContent, 'Gate moved up: now 1 of 3');
  await settle(); // the server's answer arrives between presses, as it does for a person
  click(btn('Gate', 'down')); await settle(); click(btn('Gate', 'down'));
  assert.deepEqual(rowNames(), ['Mountain status', 'Lost and found', 'Gate']);
  await settle();
  assert.deepEqual(hrefs((await serverNav('staff')).pins), ['conditions', 'lostfound', 'gate']);
  // Rename: Escape leaves the name and the dialog; Save name keeps the new one.
  click(btn('Lost and found', 'rename'));
  let box = document.querySelector('.pins-name-input');
  assert.equal(document.activeElement, box);
  assert.equal(box.value, 'Lost and found');
  assert.equal(box.getAttribute('maxlength'), '40');
  box.value = 'Nope';
  box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(editor(), 'Escape in the name box does not close Edit');
  assert.deepEqual(rowNames(), ['Mountain status', 'Lost and found', 'Gate']);
  click(btn('Lost and found', 'rename'));
  box = document.querySelector('.pins-name-input');
  box.value = '  Lost property  ';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  box.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.deepEqual(rowNames(), ['Mountain status', 'Lost property', 'Gate']);
  assert.equal(document.activeElement.getAttribute('aria-label'), 'Rename Lost property');
  await settle();
  assert.deepEqual(labels((await serverNav('staff')).pins), ['Mountain status', 'Lost property', 'Gate']);
  // Unpin.
  click(btn('Mountain status', 'unpin'));
  assert.deepEqual(rowNames(), ['Lost property', 'Gate']);
  assert.deepEqual(toasts().filter((t) => /Unpinned/.test(t)), [], 'no toast for what Edit already shows');
  await settle();
  // Typing a name did not make the dialog ask before closing; Reset asks first.
  const reset = document.querySelector('[data-act=reset]');
  assert.equal(reset.disabled, false);
  click(reset);
  assert.match(document.querySelector('.pins-ask').textContent, /Put back your role's menu\?/);
  click(document.querySelector('[data-act=reset-no]'));
  assert.deepEqual(rowNames(), ['Lost property', 'Gate'], 'Keep mine');
  click(document.querySelector('[data-act=reset]'));
  click(document.querySelector('[data-act=reset-yes]'));
  assert.deepEqual(rowNames(), ['Mountain status', 'Gate', 'Lost and found'], 'the role\'s menu, at once');
  assert.deepEqual(hrefs(frame.last().pins), ['conditions', 'gate', 'lostfound']);
  await settle();
  assert.deepEqual(await serverNav('staff').then((n) => [n.custom, hrefs(n.pins)]), [false, ['conditions', 'gate', 'lostfound']]);
  document.querySelector('.dialog header button').click();
  assert.equal(editor(), null, 'closes without asking');
  assert.equal(document.querySelector('.discard-ask:not([hidden])'), null);
});

test('Edit bar: choose the phone bar\'s four from the pins and Home, in order, or go back to the standard bar', { skip }, async () => {
  const { frame } = await open('staff');
  say('nav:edit-pins', { bar: true });
  await settle();
  assert.equal(document.activeElement.id, 'pins-bar-h', 'opened at the phone bar');
  const on = () => rowNames('.pins-bar-on .pins-row');
  const rest = () => rowNames('.pins-bar-rest .pins-row');
  const btn = (name, act) => [...document.querySelectorAll(`.pins-bar [data-act=${act}]`)].find((b) => b.getAttribute('aria-label').includes(name));
  // The standard bar: the screen the menu opens on (Today), then the pins.
  assert.deepEqual(on(), ['Today', 'Mountain status', 'Gate', 'Lost and found']);
  assert.deepEqual(rest(), ['My shifts', 'Calendar']);
  assert.equal(btn('My shifts', 'bar-on').disabled, true, 'four is full');
  assert.equal(document.querySelector('[data-act=bar-standard]').disabled, true);
  click(btn('Gate', 'bar-off'));
  assert.deepEqual(on(), ['Today', 'Mountain status', 'Lost and found']);
  click(btn('My shifts', 'bar-on'));
  click(btn('My shifts', 'bar-up')); click(btn('My shifts', 'bar-up')); click(btn('My shifts', 'bar-up'));
  assert.deepEqual(on(), ['My shifts', 'Today', 'Mountain status', 'Lost and found']);
  assert.deepEqual(hrefs(frame.last().bar), ['myshifts', 'dashboard', 'conditions', 'lostfound']);
  await settle();
  const saved = await serverNav('staff');
  assert.deepEqual(saved.bar, [{ label: 'My shifts', href: 'myshifts', app: 'myshifts' }, { label: 'Today', href: 'dashboard', app: 'dashboard' }, { label: 'Mountain status', href: 'conditions', app: 'conditions' }, { label: 'Lost and found', href: 'lostfound', app: 'lostfound' }]);
  assert.deepEqual(hrefs(saved.pins), ['conditions', 'gate', 'lostfound'], 'the pins are as they were');
  // A pin taken out leaves the bar too.
  click([...document.querySelectorAll('.pins-section:not(.pins-bar) [data-act=unpin]')].find((b) => b.getAttribute('aria-label') === 'Unpin Lost and found'));
  assert.deepEqual(on(), ['My shifts', 'Today', 'Mountain status']);
  await settle();
  assert.deepEqual(hrefs((await serverNav('staff')).bar), ['myshifts', 'dashboard', 'conditions']);
  click(document.querySelector('[data-act=bar-standard]'));
  assert.equal(frame.last().bar, null);
  await settle();
  assert.equal((await serverNav('staff')).bar, null);
  document.querySelector('.dialog header button').click();
  ok(await api('DELETE', '/me/nav', { token: T.staff }));
});

test('a save the server refuses puts the menu back and says why', { skip }, async () => {
  const { frame, star } = await open('counter');
  clearToasts();
  // The frame would never offer it, but say a row for an app this person cannot open asked to be pinned.
  say('nav:row-menu', { key: 'money', href: 'money', label: 'Money', x: 10, y: 10, pinned: false });
  click(document.querySelector('.pin-menu [role=menuitem]'));
  assert.ok(hrefs(frame.last().pins).includes('money'), 'shown at once');
  await settle();
  assert.deepEqual(hrefs(frame.last().pins), ['sell', 'gate', 'rentals', 'people', 'waivers', 'shop'], 'and taken back');
  assert.deepEqual(toasts().filter((t) => /not saved/.test(t)), ['Your pins were not saved. You cannot open Money, so it cannot be pinned']);
  assert.equal(document.querySelector('.toast[data-kind=error]').textContent, 'Your pins were not saved. You cannot open Money, so it cannot be pinned');
  assert.equal((await serverNav('counter')).custom, false);
  assert.equal(ui.ctx.me.nav.custom, false);
  assert.equal(star().getAttribute('aria-pressed'), 'false');
});

test('twelve pins is the most: the thirteenth is not added, and says so', { skip }, async () => {
  const twelve = ['sell', 'gate', 'shop', 'rentals', 'people', 'waivers', 'lostfound', 'conditions', 'park', 'patrol', 'school', 'programs'].map((k) => ({ id: k, label: k, href: k, app: k }));
  ok(await api('PUT', '/me/nav', { token: T.owner, body: { pins: twelve } }));
  const { frame, star } = await open('owner');
  const before = frame.shown.length;
  clearToasts();
  say('nav:page', { key: 'money', href: 'money', label: 'Money' });
  click(star());
  assert.equal(frame.shown.length, before, 'the menu did not change');
  assert.deepEqual(toasts(), ['You have 12 pins, the most there can be. Unpin one to add another.']);
  assert.equal(star().getAttribute('aria-pressed'), 'false');
  await settle();
  assert.equal((await serverNav('owner')).pins.length, 12);
  ok(await api('DELETE', '/me/nav', { token: T.owner }));
});

test('a shared counter computer, and the ski area login: the role\'s pins, and nothing to change them with', { skip }, async () => {
  for (const how of ['frame', 'terminal', 'area']) {
    const { frame, live, star } = await open('counter', { canEdit: how !== 'frame' });
    if (how !== 'frame') {
      // The frame's word alone is not relied on: the person's own session says it too.
      live.stop();
      ui.ctx.me = how === 'terminal' ? { ...ui.ctx.me, terminal: { id: 1, name: 'Ticket window 1' } } : { ...ui.ctx.me, role: 'area', nav: { pins: [], bar: null, custom: false } };
    }
    const f = how === 'frame' ? frame : fakeFrame();
    const l = how === 'frame' ? live : pins.start(f);
    assert.equal(l.canEdit, false, how);
    assert.equal(f.shown.length, 1, `${how}: the pins are still shown`);
    assert.equal(f.slots.star.children.length, 0, `${how}: no star`);
    assert.equal(how === 'frame' ? star() : null, null);
    assert.deepEqual(f.palette(), [], `${how}: no commands`);
    say('nav:edit-pins', { bar: false });
    say('nav:row-menu', { key: 'gate', href: 'gate', label: 'Gate', x: 1, y: 1, pinned: true });
    assert.equal(editor(), null, `${how}: no Edit`);
    assert.equal(document.querySelector('.pin-menu'), null, `${how}: no row menu`);
    assert.equal(l.pin({ href: 'documents', label: 'Documents' }), false);
    assert.equal(l.unpin('gate'), false);
    l.stop();
  }
  await settle();
  assert.equal((await serverNav('counter')).custom, false, 'nothing was saved');
});

test('starting again (a new sign-in on the same page) ends the one before', { skip }, async () => {
  const a = await open('staff');
  const b = await open('staff');
  say('nav:row-menu', { key: 'gate', href: 'gate', label: 'Gate', x: 1, y: 1, pinned: true });
  assert.equal(document.querySelectorAll('.pin-menu').length, 1, 'one answer, not two');
  document.querySelector('.pin-menu').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(a.frame.palette(), [], 'the old frame\'s commands are empty');
  assert.equal(b.frame.palette().length, 3);
  b.live.stop();
  say('nav:edit-pins', { bar: false });
  assert.equal(editor(), null, 'stopped: it answers nothing');
});
