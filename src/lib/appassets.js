'use strict';

// The app's scripts and styles, cached by release (2026.11.10).
//
// Every page in public/ (index.html, the guest pages, the console) is sent with its <script src> and <link href> for
// /js/, /css/ and /vendor/ moved under /r/<release>/, for example /r/2026.11.10-ab12cd3/js/main.js. Those addresses
// change with every release, so browsers keep them for a year (immutable) and never ask again. The scripts import each
// other by relative paths ('./api.js'), so everything a page loads stays under the same /r/<release>/ address.
// The pages themselves, the service worker (/sw.js) and the manifest are never cached long: they say no-cache, so a
// release shows up on the next load.
//
// The release part is the version and the build (the git commit the zip was made from). A copy without a stamped build
// (a developer's computer, the tests) uses the version and a short fingerprint of the files instead, so an edited
// file still gets a new address after a restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const VERSIONED_DIRS = ['js', 'css', 'vendor'];
const YEAR = 'public, max-age=31536000, immutable';

function fingerprint() {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else { const s = fs.statSync(f); hash.update(`${path.relative(PUBLIC, f)}:${s.size}:${s.mtimeMs}\n`); }
    }
  };
  for (const d of VERSIONED_DIRS) { try { walk(path.join(PUBLIC, d)); } catch (_) { /* no such folder */ } }
  return hash.digest('hex').slice(0, 10);
}

const RELEASE = (() => {
  const { version } = require('../../package.json');
  let build = '';
  try { build = String(require('../release/build.json').build || '').replace(/[^0-9a-z]/gi, ''); } catch (_) { /* a copy without a stamped build */ }
  return `${version}-${build && build !== 'dev' ? build : `dev${fingerprint()}`}`;
})();
const PREFIX = `/r/${RELEASE}`;

/** A page's HTML with its scripts and stylesheets moved to the release address. */
const rewrite = (html) => html.replace(/(\s(?:src|href)=["'])\/(js|css|vendor)\//g, `$1${PREFIX}/$2/`);

const pages = new Map();
function pageHtml(name) {
  if (!pages.has(name)) pages.set(name, rewrite(fs.readFileSync(path.join(PUBLIC, name), 'utf8')));
  return pages.get(name);
}

/** Sends a page from public/ (for example 'index.html') with release addresses for its scripts and styles. Never cached long. */
function sendPage(res, name) {
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(pageHtml(name));
}
/** A route handler that sends that page. */
const page = (name) => (_req, res) => sendPage(res, name);

/** Every top-level page in public/ by its own name (/index.html, /kiosk.html), sent the same way. */
const PAGE_NAMES = new Set(fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')));
function directPages(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = req.path === '/' ? 'index.html' : req.path.slice(1);
  return PAGE_NAMES.has(name) ? sendPage(res, name) : next();
}

/**
 * /r/<release>/js|css|vendor/...: the files from public/, kept a year when the address names this release. An address
 * from another release (a tab opened before a deploy loading one more screen) gets today's file, not cached, so it never
 * keeps a mix of two releases.
 */
const releaseFiles = express.Router();
const serve = express.static(PUBLIC, {
  index: false, redirect: false,
  setHeaders(res) { res.setHeader('Cache-Control', res.req.assetRelease === RELEASE ? YEAR : 'no-cache'); },
});
releaseFiles.use('/r/:release', (req, res, next) => {
  if (!VERSIONED_DIRS.includes(req.path.split('/')[1])) return next();
  req.assetRelease = req.params.release;
  return serve(req, res, next);
});

/** Cache-Control for everything else in public/: fonts a year, the website's ?v= files a year, the rest no-cache. */
function staticHeaders(res, file) {
  const versioned = res.req && res.req.query && res.req.query.v && /[\\/]public[\\/]site[\\/]/.test(file);
  res.setHeader('Cache-Control', file.endsWith('.woff2') || versioned ? YEAR : 'no-cache');
}

module.exports = { RELEASE, PREFIX, rewrite, sendPage, page, directPages, releaseFiles, staticHeaders, VERSIONED_DIRS };
