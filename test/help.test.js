'use strict';

// The in-app Help: the articles are plain data, so check they hold together (no broken links, nothing empty,
// every article belongs to a real section and a real screen).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let mod;
test.before(async () => {
  // the browser modules are ES modules; copy to a .mjs so Node will import them
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-'));
  fs.copyFileSync(path.join(__dirname, '..', 'public', 'js', 'help-content.js'), path.join(dir, 'help-content.mjs'));
  mod = await import(pathToFileURL(path.join(dir, 'help-content.mjs')).href);
});

test('every article is complete and belongs to a section', () => {
  const sections = new Set(mod.SECTIONS.map((s) => s.key));
  const ids = new Set();
  for (const a of mod.ARTICLES) {
    assert.ok(/^[a-z0-9-]+$/.test(a.id), `id ${a.id}`);
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`); ids.add(a.id);
    assert.ok(sections.has(a.app), `${a.id}: unknown section ${a.app}`);
    assert.ok(a.title && a.intro, `${a.id}: title and intro`);
    assert.ok(Array.isArray(a.steps) && a.steps.length >= 1, `${a.id}: needs steps`);
    assert.ok(a.steps.every((t) => typeof t === 'string' && t.length > 5), `${a.id}: steps are text`);
    for (const r of a.related || []) assert.ok(mod.articleById(r), `${a.id}: related ${r} does not exist`);
  }
});

test('every section is a real screen (or the getting-started section) and has articles', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  const screens = new Set([...src.matchAll(/^\s*\['([a-z]+)', '/gm)].map((m) => m[1]));
  for (const s of mod.SECTIONS) {
    if (s.key !== 'start') assert.ok(screens.has(s.key), `section ${s.key} has no screen`);
    assert.ok(mod.ARTICLES.some((a) => a.app === s.key), `section ${s.key} is empty`);
  }
});

test('the help text is plain: no long dashes and no placeholders left in', () => {
  for (const a of mod.ARTICLES) {
    const text = [a.title, a.intro, ...(a.steps || []), ...(a.tips || [])].join(' ');
    assert.ok(!/—|–/.test(text), `${a.id}: dash`);
    assert.ok(!/TODO|lorem|\[.*\]/i.test(text), `${a.id}: placeholder`);
  }
});

test('the app mounts the Help screen and a link to it on every page', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.ok(/\['help', 'Help'/.test(main) && main.includes('addHelpLink(holder, key)'));
});
