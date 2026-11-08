'use strict';

// App policy (fix/app-policy): the brand theme in the app, fonts, help prose, words and values people read, one time
// format, printing a patrol case, and accessibility on phones. Mostly checks of the stylesheet and the screens' source,
// plus the shared formatters run directly (ui.js in a small DOM, lib/util.js clock).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch (_) { /* the DOM checks are skipped */ }

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('public/css/app.css');
const view = (n) => read(`public/js/views/${n}.js`);

// ---------------------------------------------------------------- contrast
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const tok = (name, block = rootBlock) => { const m = new RegExp(`${name}: (#[0-9a-f]{6})`).exec(block); return m && m[1]; };

test('brand: gold is the light accent, as a fill with dark slate text; links are spruce', () => {
  assert.equal(tok('--accent'), '#d8b672');
  assert.ok(ratio(tok('--accent'), tok('--on-accent')) >= 4.5, 'text on the gold passes 4.5:1');
  assert.ok(ratio(tok('--accent-hover'), tok('--on-accent')) >= 4.5, 'and on its hover');
  assert.ok(ratio(tok('--link'), '#ffffff') >= 4.5 && ratio(tok('--link'), tok('--snowpack')) >= 4.5, 'links on white and on the page');
  assert.ok(ratio(tok('--accent-line'), '#ffffff') >= 3, 'gold lines and tracks hold 3:1 on white');
  assert.match(css, /\.btn\.primary \{ background: var\(--accent\); border-color: var\(--accent\); color: var\(--on-accent\); \}/);
  assert.match(css, /\na \{ color: var\(--link\); \}/);
  assert.ok(!/var\(--trail-blue/.test(css), 'nothing is painted with the old blue name');
  const dark = css.slice(css.indexOf(":root[data-theme='dark'] {\n  color-scheme: dark;"));
  assert.equal(tok('--accent', dark), '#d8b672', 'the dark theme uses the same gold');
  assert.ok(ratio(tok('--accent', dark), tok('--on-accent', dark)) >= 4.5);
});

test('brand: colors are custom properties and corners use one radius scale', () => {
  const lines = css.split('\n').filter((l) => !/^\s*--[a-z0-9-]+:/.test(l) && !/^\s*(:root|\[data-(dept|kind)|:root\[data-theme='dark'\] \[data-)[^{]*\{\s*--/.test(l) && !/mask-image/.test(l));
  const hex = new Set(lines.join('\n').match(/#[0-9a-fA-F]{3,8}\b/g) || []);
  assert.deepEqual([...hex], [], 'no hard-coded hex colors outside token definitions');
  const radii = (css.match(/border-radius: [^;}]+/g) || []).map((r) => r.slice(15).trim());
  const odd = radii.filter((r) => !r.split(/\s+/).every((p) => /^var\(--radius(-[a-z0-9]+)?\)$/.test(p) || p === '0' || p === '50%'));
  assert.deepEqual(odd, [], 'every radius comes from the scale');
  for (const n of ['--radius-xs', '--radius-sm', '--radius', '--radius-md', '--radius-lg', '--radius-xl', '--radius-pill']) assert.match(rootBlock, new RegExp(`${n}: \\d+px;`));
});

test('fonts: controls take the body font, help titles are Barlow Condensed, the map uses the body font', () => {
  assert.match(css, /\nbutton, input, select, textarea, optgroup \{ font-family: inherit; \}/);
  assert.match(css, /\.help-article h1, \.help h1, \.help-done h1 \{ font-family: 'Barlow Condensed'/);
  assert.match(css, /body \.leaflet-container \.leaflet-control-attribution[^{]*\{ font-family: inherit; \}/);
});

test('help prose writes money in words', () => {
  const help = read('public/js/help-content.js');
  assert.ok(!/\$\d/.test(help), 'no "$20" in help');
  assert.match(help, /a 20, 50 or 100 dollar note/);
  assert.match(help, /5 to 1,000 dollars/);
});

test('no em dashes on screen', () => {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'vendor') walk(p); } else if (/\.(js|html)$/.test(f)) files.push(p); } };
  walk(path.join(ROOT, 'public'));
  const hits = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!line.includes('—')) return;
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '').replace(/\s\/\/ .*$/, '').replace(/<!--.*?-->/g, '');
      if (code.includes('—')) hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('times: one 12-hour format from the shared server formatter, including Today', () => {
  const { clock } = require('../src/lib/util');
  assert.equal(clock('2026-11-07 22:54:10'), '10:54 PM');
  assert.equal(clock('2026-11-07T09:05'), '9:05 AM');
  assert.equal(clock('00:10'), '12:10 AM');
  assert.equal(clock('12:00:00'), '12:00 PM');
  const board = read('src/routes/board.js');
  assert.ok(!/slice\(11, 16\)/.test(board), 'Today no longer cuts "22:54" out of a timestamp');
  assert.match(board, /Passed inspection at \$\{clock\(/);
  assert.match(read('src/lib/reportcheck.js'), /clock\(t\)/);
});

test('words: Today says cases like Patrol; the demo sentence shows only on demo mountains; titles on Inbox and the refused risk report', () => {
  const dash = view('dashboard');
  assert.ok(!/incidents? open|open incidents/i.test(dash), 'no "incidents" on Today');
  assert.match(dash, /'cases open'/); assert.match(dash, /'No open cases'/);
  assert.match(read('src/routes/board.js'), /case\$\{p\.open_incidents === 1 \? '' : 's'\} still open/);
  assert.match(view('messages'), /ctx\.me && ctx\.me\.sandbox \? '[^']*Demo mountains never send\.'/);
  assert.match(view('inbox'), /h\('h1', null, 'Inbox'\)/);
  const risk = view('patrol-risk');
  assert.match(risk, /catch \(err\) \{[\s\S]{0,200}h\('h1', null, 'Season risk report'\)/);
});

test('raw values: the conditions feed is labeled with a copy button; programs never print "null"', () => {
  const cond = view('conditions');
  assert.match(cond, /field\('Conditions feed address for your website'/);
  assert.match(cond, /button\('Copy address'/); assert.match(cond, /toast\('Address copied'\)/);
  assert.ok(!/Public feed for your website: \/api/.test(cond));
  assert.equal((view('programs').match(/appendAll\(clear\(page\),/g) || []).length, 2, 'optional parts are skipped, not printed as null');
  assert.match(view('patrol-log'), /s\.surface && label\(s\.surface\)/);
});

test('accessibility: phone targets, map zoom, labels, closed menus', () => {
  const phone = css.slice(css.lastIndexOf('@media (max-width: 600px) {'));
  assert.match(phone, /\.btn:not\(\.link\), \.btn\.small:not\(\.link\), summary\.btn \{ min-height: 44px; \}/);
  assert.match(phone, /label:not\(\.check-hit\):has\(> input\[type='checkbox'\]\)[^{]*\{ min-height: 44px;/);
  assert.match(css, /label\.check-hit \{[^}]*min-width: 44px; min-height: 44px;/);
  assert.match(css, /\.leaflet-bar a[^{]*\{ width: 44px; height: 44px;/);
  assert.match(css, /\.menu-pop:not\(\[open\]\) > \.menu-items \{ display: none; \}/, 'closed Options menus have no nameless buttons');
  assert.match(view('rentals'), /'aria-label': 'Gear type'/);
  assert.match(view('patrol-settings'), /'aria-label': kind === 'lifts' \? 'New lift name' : 'New run name'/);
  assert.match(read('public/js/main.js'), /if \(document\.querySelector\('\.overlay'\)\) \{ setTimeout\(when, 1500\); return; \}/, 'the passkey prompt never opens on top of a dialog');
});

test('printing a case: no blank first page, no controls or helper text, one time format', () => {
  const pr = css.slice(css.indexOf('/* ---------- Printing a patrol case'));
  assert.match(pr, /\.case-page \.case > \.pane \{ break-before: auto !important; \}/);
  assert.match(pr, /\.case-page \.case > \.pane ~ \.pane \{ break-before: page !important; \}/);
  assert.match(pr, /\.case-page \.hint/);
  assert.match(pr, /\.case-page input\[type='datetime-local'\][^{]*\{ display: none !important; \}/);
  assert.match(pr, /\.overlay[^{]*\{ display: none !important; \}/, 'open dialogs do not print');
  assert.match(pr, /\.case-page \.wristband \{ position: static !important;/);
  assert.match(view('patrol-case'), /printableTimes\(page\)/);
  assert.match(view('patrol-bedside'), /h\('span', \{ class: 'no-print' \}, ` \(\$\{agoText/, '"(13 min ago)" stays on screen');
});

// ---------------------------------------------------------------- the shared client formatters, in a small DOM
let ui; let dom; let tmp;
test('client: labels, the mountain clock and printed date boxes', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  for (const k of ['document', 'Node', 'HTMLElement', 'Event']) Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'MutationObserver', { value: dom.window.MutationObserver, configurable: true, writable: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'so-apppol-'));
  fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  ui = await import(pathToFileURL(path.join(tmp, 'js', 'ui.js')).href);
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // the words the forms use
  assert.equal(ui.label('sprain_strain'), 'Sprain or strain');
  assert.equal(ui.label('wrist_hand'), 'Wrist or hand');
  assert.equal(ui.label('treated_released'), 'Treated and released');
  assert.equal(ui.label('packed_powder'), 'Packed powder');
  assert.equal(ui.label(null), ''); assert.equal(ui.label('null'), '');

  // a UTC sign-in shows on the mountain's clock, not this device's
  ui.ctx.tz = 'America/New_York';
  assert.equal(ui.mountainClock('2026-11-08 14:35:00'), '2026-11-08T09:35');
  assert.match(ui.fmtInstant('2026-11-08 14:35:00'), /^Sun, Nov 8, 9:35 AM/);
  const sec = view('security');
  assert.match(sec, /const when = \(v\) => \(v \? fmtInstant\(v\) : 'Never'\)/);
  assert.ok(!/toLocaleString\(undefined|toLocaleTimeString\(/.test(sec), 'no device-zone times in Settings');

  // a date and time box prints as words in the printout's format
  const root = ui.h('div');
  document.body.append(root);
  const box = ui.input({ type: 'datetime-local', value: '2026-11-07T18:54' });
  root.append(box);
  ui.printableTimes(root);
  const words = box.nextElementSibling;
  assert.ok(words && words.classList.contains('print-value'));
  assert.match(words.textContent, /^Sat, Nov 7, 6:54 PM [A-Z]/);
  box.value = '2026-11-07T07:05'; box.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(words.textContent, /^Sat, Nov 7, 7:05 AM/);
});

test('2026.11.13: new screens use the theme tokens; status switches never break a word on a phone', () => {
  // the ski school safety and pay screens, the group page and the menu v3 code paint with tokens, not raw colors
  for (const f of ['public/js/views/school-safety.js', 'public/js/views/school-money.js', 'public/js/group.js', 'public/js/jumpindex.js', 'public/js/views/settings-menus.js', 'public/js/nav.js']) {
    assert.ok(!/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?![\w-])|rgba?\(/i.test(read(f).replace(/\/\/.*$/gm, '')), `${f} has no raw colors`);
  }
  const school = css.slice(css.indexOf('/* ---------------------------------------------------------------- ski school safety'));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(school.replace(/\/\*[\s\S]*?\*\//g, '')), 'the school blocks in app.css use tokens');
  assert.ok(!/1b5fc1/i.test(read('public/css/book.css').slice(read('public/css/book.css').indexOf('feat/school-safety'))), 'the family page blocks add no blue');
  // Mountain status on a phone: the switch takes the card's width and keeps each word whole
  assert.match(css, /table\.rt td:has\(> \.seg\) \{ flex-direction: column;/);
  assert.match(css, /table\.rt td > \.seg button \{[^}]*white-space: nowrap; overflow-wrap: normal;/);
});
