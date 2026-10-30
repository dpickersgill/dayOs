'use strict';

// The product website: Home, Product, Pricing, Security, Contact, Privacy and Terms, served by this service.
//
// On the website's own addresses (SITE_HOSTS) the pages are at /, /product, /pricing and so on. On every address they
// are also at /site, /site/product..., so they can be checked before the domain points here. The pages are HTML files in
// src/site with a few {{TOKENS}} filled in here; their styles, script and pictures are plain files under public/site.
// The Pricing page reads the plans and add-ons set in the console (GET /api/v1/site/plans), and the Contact page posts
// walkthrough and trial requests (POST /api/v1/site/contact): kept for the console's Leads and emailed to SITE_CONTACT_EMAIL.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { pool, rows } = require('../db');
const { z, validate } = require('../lib/util');
const config = require('../config');
const { rateLimit } = require('../middleware/rateLimit');

const DIR = path.join(__dirname, '..', 'site');
const PAGES = {
  '': 'index', product: 'product', 'ski-patrol': 'skipatrol', 'lift-ticket-software': 'lifttickets', 'ski-school-software': 'skischool',
  'ski-rental-software': 'skirental', 'ski-waiver-software': 'skiwaivers', 'lift-maintenance-software': 'liftmaintenance',
  'ski-area-pos': 'skiareapos', 'online-lift-ticket-sales': 'onlinetickets', 'terrain-park-software': 'terrainpark', 'ski-area-staff-scheduling': 'staffscheduling',
  'attraction-ticketing-software': 'attractions', resources: 'resources', 'chairlift-inspection-checklist': 'guide-chairlift', 'terrain-park-inspection-checklist': 'guide-terrainpark',
  'ski-area-incident-report-guide': 'guide-incident', 'how-to-choose-ski-area-software': 'guide-choosing', about: 'about',
  pricing: 'pricing', security: 'security', contact: 'contact', privacy: 'privacy', terms: 'terms',
  // For owners, GMs and insurers: the record, the claim file, the documentation score and the season risk report.
  'ski-area-risk-management': 'risk',
};
// The pages written for one search each ("ski school software"), linked from the menu and the footer.
const SOLUTIONS = [['ski-patrol', 'Ski patrol'], ['lift-ticket-software', 'Lift tickets and passes'], ['ski-school-software', 'Ski school'],
  ['ski-rental-software', 'Ski rentals'], ['ski-waiver-software', 'Online waivers'], ['lift-maintenance-software', 'Lift and fleet maintenance'],
  ['ski-area-pos', 'Ski area POS'], ['online-lift-ticket-sales', 'Online ticket sales'], ['terrain-park-software', 'Terrain park'], ['attraction-ticketing-software', 'Attractions and activities'], ['ski-area-staff-scheduling', 'Staff scheduling']];
const SEO = require('../lib/seo');
const GD = require('../lib/goodday');
// The Good Day (guests round 2): the newsletter's home and its issues, one file each under src/site/good-day.
PAGES['good-day'] = 'good-day/index';
for (const i of GD.issues()) PAGES[i.slug] = i.slug;
Object.assign(SEO.META, GD.meta());
const cache = new Map();

const hostOf = (req) => String(req.get('host') || '').toLowerCase().replace(/:\d+$/, '');
const onSite = (req) => config.site.hosts.includes(hostOf(req));

function template(name) {
  if (!cache.has(name) || !config.isProd) cache.set(name, fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8'));
  return cache.get(name);
}

// The Verdynt/OS wordmark (public/brand): the light version on snow, the dark one on navy.
const WORDMARK = (theme, h) => `<img class="wordmark" src="/brand/verdynt-lockup-${theme}.png" alt="Verdynt/OS" width="${Math.round(h * 6.06)}" height="${h}">`;
const NAV = [['ski-patrol', 'Ski patrol'], ['ski-area-risk-management', 'For owners'], ['pricing', 'Pricing'], ['resources', 'Resources']];
// One line under each solution in the Product menu, from that page's own headline.
const SOLUTION_LINES = {
  'lift-ticket-software': 'Day tickets, season passes and the gate', 'ski-school-software': 'Lessons that fill without the phone tag',
  'ski-rental-software': 'Every item out, and every item back', 'ski-waiver-software': 'Signed before they drive up',
  'lift-maintenance-software': 'Inspections, work orders and service plans', 'ski-area-pos': 'A fast ticket window on a busy Saturday',
  'online-lift-ticket-sales': 'Your own page, selling while you sleep', 'terrain-park-software': 'Every feature, and whether it passed',
  'attraction-ticketing-software': 'Ziplines, coasters and tubing, open on their check', 'ski-area-staff-scheduling': 'Every shift covered before the first chair',
};
const CHEVRON = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The top of every page. Wide screens: the logo, Product (a menu of every solution page on hover or keyboard focus,
 * and a plain link to the Product page on a tap), four more links, then Sign in and Book a walkthrough. Try the demo sits
 * in the Product menu, the phone menu, the phone bar and each page's own buttons.
 * Narrower screens: a Menu button opening a full-screen menu, its two buttons kept at the bottom; on phones a bar at the
 * bottom of the page holds the two things people came to do. */
// The Resources menu: the guides, and The Good Day newsletter.
const RESOURCES = [['resources', 'Guides and checklists', 'Printable checklists and how-to guides'], ['good-day', 'The Good Day', 'Our newsletter, every other week']];
function header(current) {
  const cur = (s) => (s === current ? ' aria-current="page"' : '');
  const sols = SOLUTIONS.filter(([s]) => s !== 'ski-patrol');
  const resOn = RESOURCES.some(([s]) => s === current) || /^good-day/.test(current || ''); // an issue sits under The Good Day
  const resMenu = `<li class="sn-dd sn-dd-sm">
          <a class="sn-a" href="{{SITE}}/resources"${resOn ? ` aria-current="${current === 'resources' ? 'page' : 'true'}"` : ''}>Resources${CHEVRON}</a>
          <div class="sn-panel sm"><ul class="sn-sols" aria-label="Resources">${RESOURCES.map(([s, t, line]) => `<li><a href="{{SITE}}/${s}"${cur(s)}><b>${t}</b><span>${line}</span></a></li>`).join('')}</ul></div>
        </li>`;
  const links = NAV.map(([s, t]) => (s === 'resources' ? resMenu : `<li><a class="sn-a" href="{{SITE}}/${s}"${cur(s)}>${t}</a></li>`)).join('\n        ');
  const productOn = current === 'product' || sols.some(([s]) => s === current);
  const panel = sols.map(([s, t]) => `<li><a href="{{SITE}}/${s}"${cur(s)}><b>${t}</b><span>${SOLUTION_LINES[s]}</span></a></li>`).join('\n              ');
  const phoneLinks = [['', 'Home', '{{HOME}}'], ['product', 'Product'], ...NAV, ['good-day', 'The Good Day']].map(([s, t, href]) => `<li><a href="${href || `{{SITE}}/${s}`}"${cur(s)}>${t}</a></li>`).join('\n          ');
  const phoneSols = sols.map(([s, t]) => `<li><a href="{{SITE}}/${s}"${cur(s)}>${t}</a></li>`).join('\n          ');
  const bar = current === 'contact' ? '' : `
<div class="mcta"><a class="btn ghost" href="{{TRY}}">Try the demo</a><a class="btn" href="{{SITE}}/contact">Book a walkthrough</a></div>`;
  return `<a class="skip" href="#main">Skip to the content</a>
<header class="sn">
  <div class="wrap sn-in">
    <a class="sn-brand" href="{{HOME}}" aria-label="Verdynt/OS, home">${WORDMARK('light', 36)}</a>
    <nav class="sn-nav" aria-label="Main">
      <ul class="sn-links">
        <li class="sn-dd">
          <a class="sn-a" href="{{SITE}}/product"${productOn ? ` aria-current="${current === 'product' ? 'page' : 'true'}"` : ''}>Product${CHEVRON}</a>
          <div class="sn-panel">
            <div class="sn-ov">
              <b>Every part of the mountain</b>
              <span>Each part is its own app. Turn on the ones you run; your crew sees only those.</span>
              <a class="sn-ov-all" href="{{SITE}}/product">See the whole product</a>
              <a class="btn onink sm" href="{{TRY}}">Try the demo</a>
            </div>
            <ul class="sn-sols" aria-label="Solutions">
              ${panel}
            </ul>
          </div>
        </li>
        ${links}
      </ul>
    </nav>
    <div class="sn-act">
      <a class="sn-sign" href="{{APP}}">Sign in</a>
      <a class="btn sm" href="{{SITE}}/contact">Book a walkthrough</a>
    </div>
    <details class="sn-m">
      <summary><i aria-hidden="true"></i><span>Menu</span></summary>
      <div class="sn-menu">
        <nav class="sn-mnav" aria-label="Main">
          <ul class="sn-mp">
          ${phoneLinks}
          </ul>
          <h2 class="sn-mh">Solutions</h2>
          <ul class="sn-ms">
          ${phoneSols}
          </ul>
        </nav>
        <div class="sn-mact">
          <a class="btn ghost" href="{{TRY}}">Try the demo</a>
          <a class="btn" href="{{SITE}}/contact">Book a walkthrough</a>
          <a class="sn-sign" href="{{APP}}">Sign in</a>
        </div>
      </div>
    </details>
  </div>
</header>${bar}`;
}

const FOOTER = `<footer class="sf">
  <div class="wrap">
    <div class="sf-grid">
      <div>
        <div class="sf-brand"><img src="/brand/verdynt-logo-dark.png" alt="Verdynt/OS, resort operating system" width="220" height="109"></div>
        <p>Operations software for independent ski areas. Lifts, the fleet, tickets, rentals, lessons, patrol and staff in one place.</p>
      </div>
      <div>
        <h2>Explore</h2>
        <ul>
          <li><a href="{{HOME}}">Home</a></li>
          <li><a href="{{SITE}}/product">Product</a></li>
          <li><a href="{{SITE}}/ski-area-risk-management">For owners and insurers</a></li>
          <li><a href="{{SITE}}/pricing">Pricing</a></li>
          <li><a href="{{SITE}}/security">Security</a></li>
          <li><a href="{{SITE}}/resources">Guides and checklists</a></li>
          <li><a href="{{SITE}}/good-day">The Good Day newsletter</a></li>
          <li><a href="{{SITE}}/about">About</a></li>
        </ul>
      </div>
      <div>
        <h2>Solutions</h2>
        <ul>
          ${SOLUTIONS.map(([s, t]) => `<li><a href="{{SITE}}/${s}">${t}</a></li>`).join('\n          ')}
        </ul>
      </div>
      <div>
        <h2>Talk to us</h2>
        <ul>
          <li><a href="{{TRY}}">Try the demo</a></li>
          <li><a href="{{SITE}}/contact">Request a walkthrough</a></li>
          <li><a href="{{SITE}}/contact?kind=trial">Start a 14-day trial</a></li>
          <li><a href="{{SITE}}/contact?kind=founding">Become a founding mountain</a></li>
          <li><a href="{{SITE}}/contact?kind=review">Free incident report review</a></li>
          <li><a href="{{APP}}">Sign in</a></li>
        </ul>
        <p class="sf-mail">Sales and questions: <a href="mailto:{{HELLO}}">{{HELLO}}</a><br>Customer support: <a href="mailto:{{SUPPORT}}">{{SUPPORT}}</a></p>
      </div>
    </div>
    <!--GD:FOOTER-->
    <div class="sf-base"><span>&copy; {{YEAR}} Verdynt/OS. All rights reserved. Prices in US dollars.</span><span class="sf-legal">{{SOCIAL}}<a href="{{SITE}}/privacy">Privacy</a><a href="{{SITE}}/terms">Terms</a></span></div>
  </div>
</footer>`;

// ---------------------------------------------------------------- plans in the page itself
// Home and Pricing show the live plans in the HTML, so search engines and people without JavaScript see the real prices.
// site.js draws the same cards again (and the yearly prices) once it runs.
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const SYMS = ['<circle cx="17" cy="17" r="15" fill="#2C7A57"/>', '<rect x="2" y="2" width="30" height="30" rx="2" fill="#1B5FC1"/>', '<path d="M17 1 L33 17 L17 33 L1 17 Z" fill="#12303A"/>'];
// The patrol plan carries the patrol cross rather than a third trail sign.
const PATROL_SYM = '<path d="M12 2h10v10h10v10H22v10H12V22H2V12h10Z" fill="#D63A2F"/>';
const sym = (i, code) => `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">${/patrol/.test(code || '') ? PATROL_SYM : SYMS[Math.min(i, 2)]}</svg>`;
function homePlansHtml(d) {
  // Home shows each plan's name, who it is for (the blurb set in the console) and its price: what each holds is on Pricing.
  return d.plans.map((p, i) => `<div class="plan${i === 1 ? ' feat' : ''}"><div class="sym">${sym(i, p.code)}<h3>${escHtml(p.name)}</h3></div>${p.blurb ? `<p class="who">${escHtml(p.blurb)}</p>` : ''}<div class="price"><b>${dollars(p.monthly_cents)}</b><span>per month</span></div></div>`).join('\n        ');
}
// A few words after the two add-on names that do not explain themselves. Kept the same as ADDON_HINTS in public/site/site.js.
const ADDON_HINTS = { 'doc-ocr': 'scans become searchable', 'assistant-plus': 'live answers from your data' };
function homeAddonsHtml(d) {
  return `<b>Add when you want them:</b>${d.addons.map((a) => `<span>${escHtml(a.name)}${ADDON_HINTS[a.code] ? ` <i>(${ADDON_HINTS[a.code]})</i>` : ''}</span>`).join('')}<a href="{{SITE}}/pricing#addons">See add-on prices</a>`;
}
const PATROL_ONLY = ['Patient care reports and the report check', 'Requirements your patrol director sets', 'Dispatch and phone alerts', 'Duty, the patrol schedule and shift cover', 'Opening checks and the closing sweep', 'Medications, oxygen and AEDs', 'Records requests and legal hold', 'Documents', 'A free read-only login for the ski area'];
function pricingPlansHtml(d) {
  return d.plans.map((p, i) => {
    // "Everything in Lodge, plus" only when this plan really holds all of the one before it (Patrol only does not).
    const before = d.plans[i - 1];
    const prev = before && before.apps.every((a) => p.apps.some((x) => x.key === a.key)) ? before : null;
    const added = prev ? p.apps.filter((a) => !prev.apps.some((x) => x.key === a.key)) : p.apps;
    // Patrol only is one app, so its card says what that app holds for a patrol, not just "Patrol".
    const list = p.code === 'patrol-only' ? PATROL_ONLY.map((t) => `<li>${t}</li>`) : added.map((a) => `<li>${escHtml(a.label)}</li>`);
    const items = [prev ? `<li class="plus">Everything in ${escHtml(prev.name)}, plus:</li>` : '', ...list].join('');
    return `<div class="plan${i === 1 ? ' feat' : ''}"><div class="sym">${sym(i, p.code)}<h2>${escHtml(p.name)}</h2></div><p class="who">${escHtml(p.blurb)}</p>`
      + `<div class="price"><b>${p.monthly_cents ? dollars(p.monthly_cents) : 'Ask us'}</b><span>${p.monthly_cents ? 'per month' : ''}</span></div><p class="setup">Billed monthly</p>`
      + `<ul>${items}</ul><a class="btn go${i === 1 ? '' : ' ghost'}" href="{{SITE}}/contact?kind=trial&amp;plan=${encodeURIComponent(p.name)}">Start a ${escHtml(p.name)} trial</a></div>`;
  }).join('\n        ');
}
/** "$149": the Patrol only plan's monthly price, or the Patrol add-on's when there is no such plan. */
function patrolFrom(d) {
  const p = d && (d.plans.find((x) => x.code === 'patrol-only') || d.addons.find((x) => x.code === 'patrol'));
  return p && p.monthly_cents ? dollars(p.monthly_cents) : '$149';
}
/** The Patrol add-on's monthly price (on a plan), or the Patrol only price when there is no add-on. */
function patrolAddon(d) {
  const a = d && d.addons.find((x) => x.code === 'patrol');
  return a && a.monthly_cents ? dollars(a.monthly_cents) : patrolFrom(d);
}
/**
 * The no-cut example on Pricing: what Lodge with the Online shop costs for a year, paid yearly, against booking fees on a
 * season's online sales. Worked out from the live prices; the launch prices when the plans cannot be read.
 */
function noCut(d) {
  const find = (code) => d && [...d.plans, ...d.addons].find((x) => x.code === code);
  const lodge = find('lodge'); const shop = find('shop');
  const year = (lodge && lodge.yearly_cents ? lodge.yearly_cents : 203000) + (shop && shop.yearly_cents ? shop.yearly_cents : 80600);
  return { '{{NOCUT_YEAR}}': dollars(year), '{{NOCUT_FOUR}}': '$12,000', '{{NOCUT_ONEHALF}}': '$5,088' };
}
function fillPlans(html, d) {
  if (!d || !d.plans.length) return html;
  const cols = ` style="--n:${Math.min(d.plans.length, 4)}"`;
  return html
    .replace(/(id="homeplans")>(<!--PLANS:home-->)[\s\S]*?<!--\/PLANS-->/, (_m, id, mark) => `${id}${cols}>${mark}${homePlansHtml(d)}<!--/PLANS-->`)
    .replace(/(id="plans")>(<!--PLANS:pricing-->)[\s\S]*?<!--\/PLANS-->/, (_m, id, mark) => `${id}${cols}>${mark}${pricingPlansHtml(d)}<!--/PLANS-->`)
    .replace(/<!--ADDONS:home-->[\s\S]*?<!--\/ADDONS-->/, () => (d.addons.length ? homeAddonsHtml(d) : ''));
}

/** The address search engines should treat as the page's own: the website's first address once it has one. */
function canonicalOrigin(req) {
  if (config.site.hosts.length) return `https://${config.site.hosts[0]}`;
  return `${req.protocol}://${req.get('host')}/site`;
}
/** Served at /site on an address that is not the website, once the website has its own: a copy search engines skip. */
const isCopy = (req) => config.site.hosts.length > 0 && !onSite(req);

/** Fill in the page's head and links for where it is being served. */
/** The Good Day's parts in any page: the sign-up card, the footer line, the six moments, the archive and what is next. */
function fillGoodDay(html) {
  const next = GD.catalog().next;
  return html
    .replace(/<!--GD:CARD:([a-z0-9-]+)-->/g, (_m, src) => GD.card(src, { onIssue: /^issue-(\d+)$/.test(src) ? Number(src.slice(6)) : null }))
    .replace('<!--GD:FOOTER-->', GD.footerLine())
    .replace(/<!--GD:MOMENTS:([A-Za-z ]*)-->/g, (_m, on) => GD.momentStrip(on))
    .replace('<!--GD:ARCHIVE-->', GD.archive())
    .replace('<!--GD:NEXT-->', next ? `<p class="gd-next"><b>Next issue: ${escHtml(next.moment)}.</b> ${escHtml(next.question)}</p>` : '');
}

async function render(req, name, slug, words = null) {
  const site = onSite(req);
  const base = site ? '' : '/site';
  const origin = `${req.protocol}://${req.get('host')}`;
  const app = config.site.appUrl || (site ? '/app' : '');
  let html = template(name);
  const plans = await loadPlans().catch(() => null);
  // Prices in the page's words (FAQ answers included), so the structured data says the same as the page.
  const cut = noCut(plans);
  const prices = (s) => Object.entries(cut).reduce((t, [k, v]) => t.replaceAll(k, v), s.replaceAll('{{PATROL_FROM}}', patrolFrom(plans)).replaceAll('{{PATROL_ADDON}}', patrolAddon(plans)));
  html = prices(html);
  const head = SEO.head({ slug: name === 'notfound' ? 'notfound' : slug, origin: canonicalOrigin(req), html, plans, verify: config.site.verify, sameAs: config.site.sameAs, noindex: isCopy(req), modified: modified(name), asset: ASSET_V });
  html = fillPlans(html, plans).replace(/<!--\/?(PLANS|ADDONS)(:[a-z]+)?-->/g, '');
  html = html.replace('<!--HEAD-->', head)
    .replace('<div class="sx">', name === 'contact' ? '<div class="sx">' : '<div class="sx has-mcta">')
    .replace(/<!--HEADER:?([a-z-]*)-->/, (_m, cur) => header(cur))
    .replace('<!--FOOTER-->', FOOTER);
  html = fillGoodDay(html);
  if (words) html = html.replace(/\{\{GD_([A-Z]+)\}\}/g, (_m, k) => words[k.toLowerCase()] ?? '');
  return html
    .replaceAll('{{HOME}}', `${base}/`)
    .replaceAll('{{SITE}}', base)
    .replaceAll('{{APP}}', app || '/')
    .replaceAll('{{TRY}}', `${config.site.appUrl}/try`)
    // the Patrol only price, from the plans the console marks active (so the website never shows an old price)
    .replaceAll('{{PATROL_FROM}}', patrolFrom(plans))
    .replaceAll('{{ROOT}}', origin)
    .replaceAll('{{SOCIAL}}', config.site.sameAs.filter((u) => /linkedin\.com/i.test(u)).slice(0, 1).map((u) => `<a href="${escHtml(u)}" rel="me noopener">LinkedIn</a>`).join(''))
    .replaceAll('{{HELLO}}', escHtml(config.site.helloEmail))
    .replaceAll('{{SUPPORT}}', escHtml(config.site.supportEmail))
    .replaceAll('{{YEAR}}', String(new Date().getUTCFullYear()));
}

async function send(req, res, name, slug, status = 200, words = null) {
  const body = await render(req, name, slug, words);
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  if ((isCopy(req) || name === 'notfound') && !res.get('X-Robots-Tag')) res.set('X-Robots-Tag', 'noindex, follow');
  res.send(body);
}

// The website's stylesheet and script are fetched as /site/site.css?v=<version>-<build>, so browsers can keep them for a year
// and still get the new ones the moment a release changes the address.
// The build is part of the address too: several builds can share a version while it is on staging, and a browser that
// kept an earlier build's script for a year would otherwise go on running it (old prices, old buttons).
const ASSET_V = (() => {
  const { version } = require('../../package.json');
  let build = '';
  try { build = String(require('../release/build.json').build || '').replace(/[^0-9a-z]/gi, ''); } catch (_) { /* a copy without a stamped build */ }
  return build && build !== 'dev' ? `${version}-${build}` : version;
})();

/** When each page last changed, for the sitemap. */
const modified = (name) => { try { return fs.statSync(path.join(DIR, `${name}.html`)).mtime.toISOString().slice(0, 10); } catch (_) { return null; } };
const PRIORITY = { '': '1.0', product: '0.9', 'ski-patrol': '0.9', 'ski-area-risk-management': '0.9', pricing: '0.9', resources: '0.7', about: '0.6', contact: '0.7', security: '0.6', privacy: '0.2', terms: '0.2' };
for (const [s] of SOLUTIONS) if (!PRIORITY[s]) PRIORITY[s] = '0.8';
PRIORITY['good-day'] = '0.7';
for (const i of GD.issues()) PRIORITY[i.slug] = '0.6';
for (const s of ['chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'ski-area-incident-report-guide', 'how-to-choose-ski-area-software']) PRIORITY[s] = '0.7';

const pages = express.Router();
// Never in search results: the app's sign-in, the operator console and the time clock.
pages.use((req, res, next) => {
  if (/^\/(app|platform|kiosk)(\/|$)/.test(req.path) || (req.path === '/' && config.site.hosts.length && !onSite(req))) res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
// The website's other addresses (runmyresort.com when www.runmyresort.com is first) send people to the first one.
pages.use((req, res, next) => {
  const h = hostOf(req);
  if (config.site.hosts.length > 1 && config.site.hosts.slice(1).includes(h) && ['GET', 'HEAD'].includes(req.method)) return res.redirect(301, `https://${config.site.hosts[0]}${req.originalUrl}`);
  next();
});
// Everywhere: /site and its pages.
pages.get('/site', (req, res, next) => (req.path === '/site' ? res.redirect(301, '/site/') : next()));
pages.get('/site/sitemap.xml', (req, res) => sitemap(req, res));
pages.get('/site/{:page}', (req, res, next) => {
  const slug = req.params.page || '';
  if (!(slug in PAGES)) return next();
  send(req, res, PAGES[slug], slug).catch(next);
});
pages.get('/site/good-day/:issue', (req, res, next) => {
  const slug = `good-day/${req.params.issue}`;
  if (!(slug in PAGES)) return next();
  send(req, res, PAGES[slug], slug).catch(next);
});
goodDayPages(pages);

// The app itself, at /app, for a website address where / is the home page.
pages.get('/app', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', '..', 'public', 'index.html')));

/** robots.txt: on the website, everything but the app; on the app's address, the mountains' public pages only. */
pages.get('/robots.txt', (req, res) => {
  const lines = ['User-agent: *'];
  if (onSite(req)) lines.push('Allow: /', 'Disallow: /api/', 'Disallow: /app', 'Disallow: /platform', 'Disallow: /kiosk', `Sitemap: https://${config.site.hosts[0]}/sitemap.xml`);
  else {
    lines.push('Disallow: /api/', 'Disallow: /app', 'Disallow: /platform', 'Disallow: /kiosk');
    if (config.site.hosts.length) lines.push('Disallow: /site');
    else lines.push(`Sitemap: ${req.protocol}://${req.get('host')}/site/sitemap.xml`);
  }
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`${lines.join('\n')}\n`);
});
/** /llms.txt: a plain-text guide to the website for AI assistants and answer engines (llmstxt.org). */
pages.get('/llms.txt', async (req, res, next) => {
  if (!onSite(req) && config.site.hosts.length) return next();
  const origin = canonicalOrigin(req);
  const d = await loadPlans().catch(() => null);
  const price = d && d.plans.length ? d.plans.map((p) => `- ${p.name}: ${dollars(p.monthly_cents)} a month. ${p.blurb || ''}`.trim()).join('\n') : '- See the pricing page.';
  const addons = d && d.addons.length ? d.addons.map((a) => `- ${a.name}: ${dollars(a.monthly_cents)} a month`).join('\n') : '';
  const page = (slug) => `${origin}/${slug}`;
  const text = `# Verdynt/OS

> Verdynt/OS is web-based operations software for independent ski areas in the United States: lift and trail status and inspections, grooming, fleet maintenance, ticket and season pass sales with RFID gate scanning, an online ticket shop, waivers, ski and snowboard rentals, ski school and lesson booking, ski patrol (patient care reports, dispatch, the closing sweep), staff scheduling, and attractions and activities (ziplines, mountain coasters, tubing, ice skating, scenic rides and bike parks, with a daily opening check and time slots sold at the counter and online). Each mountain turns on only the apps it runs. Every plan starts with a 14-day free trial, with no contract.

Verdynt/OS runs in a web browser on counter computers, phones and tablets, with nothing to install. Guest card payments go straight into each mountain's own Stripe account; Verdynt/OS never holds the money. Each mountain's data is kept separate, patient records are never deleted (mistakes are marked entered in error), and every mountain can export its data as spreadsheets at any time. Every plan includes Ask, an in-app assistant that answers staff how-to questions from Help; the Assistant Plus add-on adds questions about the mountain's own day and a Questions button for guests. The assistant never sees patient care records.

## Pages

- [Home](${page('')}): what Verdynt/OS does, one day at a ski area from first chair to closing
- [Product](${page('product')}): every app and the pages guests use
- [Ski patrol software](${page('ski-patrol')}): patient care reports, dispatch, opening checks, the closing sweep, volunteers
- [For owners and insurers](${page('ski-area-risk-management')}): the claim file, the documentation score, the season risk report and insurer access
- [Lift ticket and season pass software](${page('lift-ticket-software')}): the counter, the gate, RFID cards and the online shop
- [Ski school software](${page('ski-school-software')}): lessons, online booking and instructors
- [Ski rental software](${page('ski-rental-software')}): rental contracts, sizing, binding records and barcoded gear
- [Online ski waivers](${page('ski-waiver-software')}): waivers signed on a phone or counter tablet
- [Lift inspection and maintenance software](${page('lift-maintenance-software')}): lift checks, grooming, work orders and the fleet
- [Ski area POS](${page('ski-area-pos')}): the ticket window, card payments on a Stripe smart reader, gift cards and the till
- [Online lift ticket sales](${page('online-lift-ticket-sales')}): the online shop, day-first pricing, daily limits and the waitlist
- [Terrain park software](${page('terrain-park-software')}): park features, the daily map with GPS pins, and inspections
- [Attraction and activity software](${page('attraction-ticketing-software')}): ziplines, coasters, tubing and skating with a daily opening check, time slots with rider limits sold at the counter and online, and tickets scanned at the attraction
- [Ski area staff scheduling](${page('ski-area-staff-scheduling')}): shifts, the time clock and certifications
- [About](${page('about')}): who Verdynt/OS is for and how it works with ski areas
- [Pricing](${page('pricing')}): plans, add-ons and how paying works
- [Security](${page('security')}): how guest and patient information is protected
- [Contact](${page('contact')}): book a walkthrough or start a free trial

## Guides and checklists

- [Resources](${page('resources')}): free guides and printable checklists for ski areas
- [Chairlift daily inspection checklist](${page('chairlift-inspection-checklist')}): the pre-opening lift check and the daily record
- [Terrain park daily inspection checklist](${page('terrain-park-inspection-checklist')}): features, landings, signs and the daily park record
- [How to write a ski area incident report](${page('ski-area-incident-report-guide')}): what to record, what to leave out, and a review checklist (and a free review of ten of your own reports)
- [How to choose ski area management software](${page('how-to-choose-ski-area-software')}): when to switch, what to compare, questions for vendors

## The Good Day newsletter

- [The Good Day](${page('good-day')}): a newsletter for ski area owners, GMs and patrol directors, every other week. Each issue takes apart one moment of the guest's day (Plan, Arrive, Learn, Ride, Get help, Come back): the guest's question, the process behind the answer, one number to watch and a quick test.
${GD.issues().map((i) => `- [Issue ${i.n}: ${i.question}](${page(i.slug)}): ${i.moment}. ${i.title}. ${i.teaser}`).join('\n')}

## Plans (US dollars, before sales tax)

${price}
${addons ? `\nAdd-ons, on any plan:\n\n${addons}\n` : ''}
Yearly billing costs less. Pay by card, US bank account or invoice. 14 days free, no card needed to start.

## Optional

- [Privacy policy](${page('privacy')})
- [Terms of service](${page('terms')})
- [Try a demo mountain](${config.site.appUrl || origin}/try): your own made-up mountain in about 20 seconds
`;
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(text);
});

function sitemap(req, res) {
  const origin = canonicalOrigin(req);
  const urls = Object.entries(PAGES).map(([slug, name]) => `  <url><loc>${origin}/${slug}</loc>${modified(name) ? `<lastmod>${modified(name)}</lastmod>` : ''}<priority>${PRIORITY[slug] || '0.5'}</priority></url>`).join('\n');
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
}

// On the website's own addresses: the pages at the top, with one address each (no trailing slash).
pages.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) || !onSite(req)) return next();
  if (req.path === '/sitemap.xml') return sitemap(req, res);
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const bare = req.path.replace(/\/+$/, '');
    const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    if (bare.slice(1) in PAGES) return res.redirect(301, bare + q);
  }
  // One address per page: /Pricing goes to /pricing.
  if (/[A-Z]/.test(req.path) && req.path.toLowerCase().slice(1) in PAGES) return res.redirect(301, req.originalUrl.replace(req.path, req.path.toLowerCase()));
  const slug = req.path === '/' ? '' : req.path.slice(1);
  if (slug in PAGES) return send(req, res, PAGES[slug], slug).catch(next);
  return next();
});

/** The website's "not found", for website addresses only (the app keeps its own). */
function notFound(req, res, next) {
  if (req.method === 'GET' && onSite(req) && !req.path.startsWith('/api/') && (req.accepts(['html', 'json']) === 'html')) return send(req, res, 'notfound', '', 404).catch(next);
  return next();
}

// ---------------------------------------------------------------- the website's API
const api = express.Router();
const M = require('../lib/modules');
let planCache = { at: 0, body: null };

/** The plans and add-ons mountains can buy, for the Pricing page. Only what the console marks active. */
async function loadPlans() {
  if (!planCache.body || Date.now() - planCache.at > 60_000) {
    const all = (await rows(pool, 'SELECT id, code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort FROM billing_plans WHERE active = 1 ORDER BY kind, sort, monthly_cents, id'));
    const label = (k) => (M.MODULES.find((m) => m.key === k) || { label: k }).label.replace(/\s*\(add-on\)/i, '');
    const shape = (p) => ({ code: p.code, name: p.name, blurb: p.blurb, monthly_cents: Number(p.monthly_cents), yearly_cents: Number(p.yearly_cents), apps: String(p.modules || '').split(',').filter(Boolean).map((k) => ({ key: k, label: label(k) })) });
    planCache = { at: Date.now(), body: { plans: all.filter((p) => p.kind === 'plan').map(shape), addons: all.filter((p) => p.kind === 'addon').map(shape), trial_days: require('../lib/billing').TRIAL_DAYS } };
  }
  return planCache.body;
}
api.get('/site/plans', async (_req, res) => res.set('Cache-Control', 'public, max-age=60').json(await loadPlans()));
const forgetPlans = () => { planCache = { at: 0, body: null }; };

const contactBody = z.object({
  kind: z.enum(['walkthrough', 'trial', 'founding', 'question', 'patrol', 'review', 'setup']).default('walkthrough'),
  name: z.string().trim().min(1).max(150), mountain: z.string().trim().min(1).max(150), role: z.string().trim().max(100).optional().default(''),
  email: z.string().trim().email().max(255), phone: z.string().trim().max(40).optional().default(''), lifts: z.string().trim().max(20).optional().default(''),
  plan_interest: z.string().trim().max(60).optional().default(''), message: z.string().trim().max(2000).optional().default(''),
  founding: z.boolean().optional().default(false), website: z.string().max(200).optional().default(''), // a field people never see: bots fill it
});
const KINDS = { walkthrough: 'Walkthrough request', trial: '14-day trial request', founding: 'Founding group request', question: 'Question', patrol: 'Patrol only sign-up', review: 'Incident report review request', setup: 'Guided setup request' };

api.post('/site/contact', rateLimit({ windowMs: 3_600_000, max: Number(process.env.SITE_CONTACT_LIMIT) || 8, message: 'Too many messages from this address. Try again later, or email us.' }), validate(contactBody), async (req, res) => {
  const b = req.body;
  if (b.website) return res.status(201).json({ ok: true }); // looks sent, goes nowhere
  const ipHash = crypto.createHash('sha256').update(`${config.linkSecret}:${req.ip}`).digest('hex');
  const [r] = await pool.query(
    'INSERT INTO site_leads (kind, name, mountain, role, email, phone, lifts, plan_interest, message, founding, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [b.kind, b.name, b.mountain, b.role || null, b.email, b.phone || null, b.lifts || null, b.plan_interest || null, b.message || null, b.founding || b.kind === 'founding' ? 1 : 0, ipHash],
  );
  const mailer = require('../lib/mailer');
  let copy = false;
  if (config.site.contactEmail && mailer.enabled()) {
    const lines = [`${KINDS[b.kind]} from the website`, '', `Name: ${b.name}`, `Mountain: ${b.mountain}`, b.role ? `Role: ${b.role}` : null, `Email: ${b.email}`, b.phone ? `Phone: ${b.phone}` : null,
      b.lifts ? `Lifts: ${b.lifts}` : null, b.plan_interest ? `Interested in: ${b.plan_interest}` : null, b.founding ? 'Wants to be considered for the founding group.' : null, b.message ? `\n${b.message}` : null,
      '', 'Reply to this email to answer them. It is also in the console, under Leads.'].filter((x) => x !== null);
    const sent = await mailer.sendPlatform({ to: config.site.contactEmail, replyTo: b.email, subject: `${KINDS[b.kind]}: ${b.mountain}`, text: lines.join('\n'), tag: 'site-lead' });
    if (sent.ok) {
      await pool.query('UPDATE site_leads SET emailed = 1 WHERE id = ?', [r.insertId]);
      copy = (await mailer.sendPlatform({ to: b.email, replyTo: config.site.contactEmail, subject: 'We have your Verdynt/OS request', tag: 'site-lead-thanks',
        text: `Hello ${b.name},\n\nThank you for writing about ${b.mountain}. A person will reply within one business day${b.kind === 'trial' ? ' to set up your trial' : b.kind === 'patrol' ? ' to set up your patrol, with a 14-day trial' : b.kind === 'review' ? ' with a safe way to send your ten reports (please do not email patient records)' : ' to set a time'}.\n\nTo look around in the meantime, start a demo mountain: ${config.site.appUrl || `${req.protocol}://${req.get('host')}`}/try\n\nVerdynt/OS` })).ok;
    }
  }
  res.status(201).json({ ok: true, copy });
});

// ---------------------------------------------------------------- The Good Day: sign-up, confirm, unsubscribe
/** The website's own address for links in emails: https://www.runmyresort.com, or this address plus /site before then. */
const linkOrigin = (req) => canonicalOrigin(req);
const siteBase = (req) => (onSite(req) ? '' : '/site');
const subscribeBody = z.object({
  email: z.string().trim().toLowerCase().email('Enter an email address like you@yourmountain.com').max(255),
  name: z.string().trim().max(100).optional().default(''),
  role: z.enum(['owner_gm', 'patrol', 'other', '']).optional().default(''),
  source: z.string().trim().max(40).regex(/^[a-z0-9-]*$/).optional().default(''),
  website: z.string().max(200).optional().default(''), // a field people never see: bots fill it
});
const SAME = 'Check your inbox for a link to confirm. If you are already subscribed, there is nothing more to do.';
api.post('/site/good-day/subscribe', express.urlencoded({ extended: false, limit: '10kb' }),
  rateLimit({ windowMs: 3_600_000, max: Number(process.env.GOODDAY_SUBSCRIBE_LIMIT) || 10, message: 'Too many sign-ups from this address. Try again in an hour.' }), async (req, res) => {
    const asForm = req.is('application/x-www-form-urlencoded');
    const parsed = subscribeBody.safeParse(req.body || {});
    const back = (q) => res.redirect(303, `${siteBase(req)}/good-day/check-your-email${q ? `?${q}` : ''}`);
    if (!parsed.success) return asForm ? back('bad=1') : res.status(400).json({ error: parsed.error.issues[0].message });
    const b = parsed.data;
    if (!b.website) {
      const mail = await GD.subscribe({ email: b.email, name: b.name || null, role: b.role || null, source: b.source || 'website', ip: req.ip, origin: linkOrigin(req) });
      GD.deliverLater(mail);
    }
    return asForm ? back('') : res.status(201).json({ ok: true, message: SAME });
  });

/** The confirm, unsubscribe and check-your-email pages, at /site/good-day/... everywhere and /good-day/... on the website. */
function goodDayPages(router) {
  const both = (p) => [`/site/good-day/${p}`, `/good-day/${p}`];
  const here = (req, next) => req.path.startsWith('/site/') || onSite(req) || next();
  const card = (src) => `<div class="gd-again">${GD.card(src)}</div>`;
  const page = (req, res, status, words) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    return send(req, res, 'good-day/notice', 'good-day/notice', status, words);
  };
  const B = (req) => siteBase(req);
  // Issue 1 first: it sets out the six moments the later issues build on.
  const readLinks = (req) => { const n = (GD.issues().slice(-1)[0] || { n: 1 }).n; return `<div class="ctas gd-ctas"><a class="gd-btn" href="${B(req)}/good-day/issue-${n}">Read Issue ${n}</a><a class="gd-btn ghost" href="${B(req)}/good-day">Every issue</a></div>`; };

  router.get(both('check-your-email'), (req, res, next) => here(req, next) === true && page(req, res, 200, req.query.bad
    ? { eyebrow: 'Almost', title: 'That email address did not look right', body: `<p>Try again with an address like you@yourmountain.com.</p>${card('retry')}` }
    : { eyebrow: 'One more step', title: 'Check your email', body: `<p>${SAME}</p><p>The link works for 7 days. Not there in a few minutes? Look in your spam or promotions folder.</p>${readLinks(req)}` }).catch(next));

  router.get(both('confirm/:token'), async (req, res, next) => {
    if (here(req, next) !== true) return;
    try {
      const r = await GD.confirm(req.params.token, { ip: req.ip, origin: linkOrigin(req) });
      const W = {
        confirmed: [200, { eyebrow: 'You are in', title: 'Welcome to The Good Day', body: `<p>Thanks for confirming ${escHtml(r.email)}. A welcome email is on its way, and the next issue comes in about two weeks.</p>${readLinks(req)}` }],
        already: [200, { eyebrow: 'All set', title: 'You are already subscribed', body: `<p>${escHtml(r.email)} gets The Good Day. There is nothing more to do.</p>${readLinks(req)}` }],
        expired: [410, { eyebrow: 'Link expired', title: 'That link has expired', body: `<p>Confirmation links work for 7 days. Sign up again and we send a new one.</p>${card('expired')}` }],
        unsubscribed: [200, { eyebrow: 'Not subscribed', title: 'This address unsubscribed', body: `<p>It was unsubscribed after that link was sent, so the link no longer signs it up. To come back, sign up again.</p>${card('resubscribe')}` }],
        invalid: [404, { eyebrow: 'Link not found', title: 'That link does not work', body: `<p>It may have been copied only in part. Sign up again and we send a new one.</p>${card('retry')}` }],
      }[r.state];
      await page(req, res, W[0], W[1]);
    } catch (err) { next(err); }
  });

  // Unsubscribe: the link shows a page with one button (a link checker opening every link in an email must not
  // unsubscribe anyone); a mail app's own unsubscribe button posts here directly (RFC 8058) and is done in one step.
  router.get(both('unsubscribe/:token'), async (req, res, next) => {
    if (here(req, next) !== true) return;
    try {
      const r = await GD.peekUnsubscribe(req.params.token);
      if (r.state === 'invalid') return await page(req, res, 404, { eyebrow: 'Link not found', title: 'That link does not work', body: `<p>It may have been copied only in part. To stop The Good Day, use the link at the bottom of any issue, or write to <a href="mailto:${escHtml(config.site.helloEmail)}?subject=Unsubscribe">${escHtml(config.site.helloEmail)}</a> and we take you off the list.</p>` });
      if (r.state === 'already') return await page(req, res, 200, { eyebrow: 'Unsubscribed', title: 'You are unsubscribed', body: `<p>${escHtml(r.email)} gets no more issues of The Good Day.</p>${card('resubscribe')}` });
      return await page(req, res, 200, { eyebrow: 'Unsubscribe', title: 'Stop getting The Good Day?', body: `<p>${escHtml(r.email)} will get no more issues. Nothing else changes.</p>
        <form method="post" class="gd-unsub"><button type="submit" class="gd-btn">Unsubscribe</button></form><p class="gd-fine">Changed your mind? Just close this page.</p>` });
    } catch (err) { return next(err); }
  });
  router.post(both('unsubscribe/:token'), express.urlencoded({ extended: false, limit: '2kb' }), rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
    if (here(req, next) !== true) return;
    try {
      const oneClick = req.body && req.body['List-Unsubscribe'] === 'One-Click';
      const r = await GD.unsubscribe(req.params.token, oneClick ? 'one-click' : 'page');
      if (r.state === 'invalid') return oneClick ? res.status(404).send('Not found') : await page(req, res, 404, { eyebrow: 'Link not found', title: 'That link does not work', body: `<p>Write to <a href="mailto:${escHtml(config.site.helloEmail)}?subject=Unsubscribe">${escHtml(config.site.helloEmail)}</a> and we take you off the list.</p>` });
      if (oneClick) return res.status(200).type('text/plain').send('Unsubscribed');
      return await page(req, res, 200, { eyebrow: 'Done', title: 'You are unsubscribed', body: `<p>${escHtml(r.email)} gets no more issues of The Good Day. Thank you for reading.</p>${card('resubscribe')}` });
    } catch (err) { return next(err); }
  });
}

module.exports = { pages, notFound, api, forgetPlans, PAGES, onSite, canonicalOrigin };
