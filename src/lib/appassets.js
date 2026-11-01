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
// The release part is the version, the build (with "-dirty" for a build with uncommitted changes) and a short hash of the content of every file served under it, worked out when the
// server starts (2026.11.10 fix). Files that differ always get a different address: a zip made with uncommitted changes
// (build "<commit>+") and the clean build of that commit no longer share one, and neither do two copies with no stamp.
// The year-long promise is made only by a stamped build (src/release/build.json, written by scripts/stamp-build.js). A
// copy without one (a developer's computer, the tests) sends the same addresses with no-cache.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const VERSIONED_DIRS = ['js', 'css', 'vendor'];
const YEAR = 'public, max-age=31536000, immutable';

/** A hash of the name and content of every file under these folders of public/ (/js, /css and /vendor): any change gives a new one. */
function contentHash(dirs = VERSIONED_DIRS) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() || e.isSymbolicLink()) { hash.update(`${path.relative(PUBLIC, f)}\0`); hash.update(fs.readFileSync(f)); hash.update('\0'); }
    }
  };
  for (const d of dirs) { try { walk(path.join(PUBLIC, d)); } catch (_) { /* no such folder */ } }
  return hash.digest('hex').slice(0, 12);
}

/** The build stamp, when this copy has a real one (not missing, empty or 'dev'). Kept as written, "+" and all. */
const BUILD = (() => {
  try { const b = String(require('../release/build.json').build || '').trim(); return b && b !== 'dev' ? b : ''; } catch (_) { return ''; }
})();
const STAMPED = Boolean(BUILD);
/** The version and build for an address: the build as stamped, with "+" (uncommitted changes) kept as "-dirty". */
const RELEASE_BASE = (() => {
  const { version } = require('../../package.json');
  const build = STAMPED ? BUILD.replace(/\+/g, '-dirty').replace(/[^0-9a-z-]/gi, '') : 'dev';
  return `${String(version).replace(/[^0-9a-z.]/gi, '')}-${build}`;
})();
const RELEASE = `${RELEASE_BASE}-${contentHash()}`;
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
  setHeaders(res) { res.setHeader('Cache-Control', STAMPED && res.req.assetRelease === RELEASE ? YEAR : 'no-cache'); },
});
releaseFiles.use('/r/:release', (req, res, next) => {
  if (!VERSIONED_DIRS.includes(req.path.split('/')[1])) return next();
  req.assetRelease = req.params.release;
  return serve(req, res, next);
});

/**
 * /sw.js: the service worker with this release filled in, and the app shell it keeps for no signal: the app page and
 * every file under /r/<release>/ (js, css, vendor), the fonts and the app icons. A new release changes the file, so the
 * browser installs the new worker, which replaces the old release's cache (public/sw.js). Never cached long.
 */
let swText = null;
function shellList() {
  const out = ['/'];
  const walk = (dir, url) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), `${url}${e.name}/`);
      else out.push(`${url}${e.name}`);
    }
  };
  for (const d of VERSIONED_DIRS) { try { walk(path.join(PUBLIC, d), `${PREFIX}/${d}/`); } catch (_) { /* no such folder */ } }
  for (const d of ['fonts', 'icons', 'brand']) { try { walk(path.join(PUBLIC, d), `/${d}/`); } catch (_) { /* none */ } }
  return out;
}
function serviceWorker(_req, res) {
  if (!swText) swText = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8').replace("'__RELEASE__'", JSON.stringify(RELEASE)).replace('[]; /* __SHELL__ */', `${JSON.stringify(shellList())};`);
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.send(swText);
}

/** Cache-Control for everything else in public/: fonts a year, the website's ?v= files a year, the rest no-cache. */
function staticHeaders(res, file) {
  // The website's ?v= address names its content (routes/site.js, ASSET_V): kept a year only by a stamped build that asks for it.
  const versioned = STAMPED && res.req && res.req.query && res.req.query.v === SITE_V && /[\\/]public[\\/]site[\\/]/.test(file);
  res.setHeader('Cache-Control', file.endsWith('.woff2') || versioned ? YEAR : 'no-cache');
}

/** The website's stylesheet and script version (?v=): release, build and a hash of public/site's content. */
const SITE_V = `${RELEASE_BASE}-${contentHash(['site'])}`;

module.exports = { RELEASE, PREFIX, STAMPED, BUILD, SITE_V, contentHash, rewrite, sendPage, page, directPages, releaseFiles, staticHeaders, VERSIONED_DIRS, serviceWorker, shellList };
