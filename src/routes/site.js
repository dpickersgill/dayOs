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
  pricing: 'pricing', security: 'security', contact: 'contact', privacy: 'privacy', terms: 'terms',
};
// The pages written for one search each ("ski school software"), linked from the menu and the footer.
const SOLUTIONS = [['ski-patrol', 'Ski patrol'], ['lift-ticket-software', 'Lift tickets and passes'], ['ski-school-software', 'Ski school'],
  ['ski-rental-software', 'Ski rentals'], ['ski-waiver-software', 'Online waivers'], ['lift-maintenance-software', 'Lift and fleet maintenance']];
const SEO = require('../lib/seo');
const cache = new Map();

const hostOf = (req) => String(req.get('host') || '').toLowerCase().replace(/:\d+$/, '');
const onSite = (req) => config.site.hosts.includes(hostOf(req));

function template(name) {
  if (!cache.has(name) || !config.isProd) cache.set(name, fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8'));
  return cache.get(name);
}

// The Verdynt/OS wordmark (public/brand): the light version on snow, the dark one on navy.
const WORDMARK = (theme, h) => `<img class="wordmark" src="/brand/verdynt-lockup-${theme}.png" alt="Verdynt/OS" width="${Math.round(h * 6.06)}" height="${h}">`;
const NAV = [['product', 'Product'], ['ski-patrol', 'Ski patrol'], ['pricing', 'Pricing'], ['security', 'Security']];

/** The top of every page: logo, Product, Pricing, Security, Try the demo, Sign in, Request a walkthrough; on phones a
 * full-screen menu with every solution page, and a bar at the bottom with the two things people came to do. */
function header(current) {
  const links = NAV.map(([s, t]) => `<a href="{{SITE}}/${s}"${s === current ? ' aria-current="page"' : ''}>${t}</a>`).join('\n      ');
  const extra = '<a href="{{TRY}}">Try the demo</a>\n      <a href="{{APP}}">Sign in</a>';
  const solutions = SOLUTIONS.filter(([s]) => s !== 'ski-patrol').map(([s, t]) => `<a href="{{SITE}}/${s}"${s === current ? ' aria-current="page"' : ''}>${t}</a>`).join('');
  const bar = current === 'contact' ? '' : `
<div class="mcta"><a class="btn ghost" href="{{TRY}}">Try the demo</a><a class="btn" href="{{SITE}}/contact">Book a walkthrough</a></div>`;
  return `<a class="skip" href="#main">Skip to the content</a>
<header class="sn">
  <div class="wrap sn-in">
    <a class="sn-brand" href="{{HOME}}" aria-label="Verdynt/OS, home">${WORDMARK('light', 42)}</a>
    <nav class="sn-links" aria-label="Main">
      ${links}
      ${extra}
      <a class="btn" href="{{SITE}}/contact">Request a walkthrough</a>
    </nav>
    <details class="sn-m">
      <summary><i aria-hidden="true"></i>Menu</summary>
      <nav class="sn-menu" aria-label="Main">
        <a href="{{HOME}}"${current === '' ? ' aria-current="page"' : ''}>Home</a>
        ${links}
        <div class="sub">${solutions}</div>
        ${extra}
        <a class="btn" href="{{SITE}}/contact">Request a walkthrough</a>
      </nav>
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
          <li><a href="{{SITE}}/pricing">Pricing</a></li>
          <li><a href="{{SITE}}/security">Security</a></li>
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
          <li><a href="{{APP}}">Sign in</a></li>
        </ul>
      </div>
    </div>
    <div class="sf-base"><span>&copy; {{YEAR}} Verdynt/OS. All rights reserved. Prices in US dollars.</span><span class="sf-legal"><a href="{{SITE}}/privacy">Privacy</a><a href="{{SITE}}/terms">Terms</a></span></div>
  </div>
</footer>`;

// ---------------------------------------------------------------- plans in the page itself
// Home and Pricing show the live plans in the HTML, so search engines and people without JavaScript see the real prices.
// site.js draws the same cards again (and the yearly prices) once it runs.
const escHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const SYMS = ['<circle cx="17" cy="17" r="15" fill="#2C7A57"/>', '<rect x="2" y="2" width="30" height="30" rx="2" fill="#1B5FC1"/>', '<path d="M17 1 L33 17 L17 33 L1 17 Z" fill="#12303A"/>'];
const sym = (i) => `<svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">${SYMS[Math.min(i, 2)]}</svg>`;
function homePlansHtml(d) {
  return d.plans.map((p, i) => `<div class="plan${i === 1 ? ' feat' : ''}"><div class="sym">${sym(i)}<h3>${escHtml(p.name)}</h3></div><p class="who">${escHtml(p.blurb)}</p><div class="price"><b>${dollars(p.monthly_cents)}</b><span>per month</span></div></div>`).join('\n        ');
}
function homeAddonsHtml(d) {
  return `<b>Add when you want them:</b>${d.addons.map((a) => `<span>${escHtml(a.name)}</span>`).join('')}<a href="{{SITE}}/pricing#addons">See add-on prices</a>`;
}
function pricingPlansHtml(d) {
  return d.plans.map((p, i) => {
    // "Everything in Lodge, plus" only when this plan really holds all of the one before it (Patrol only does not).
    const before = d.plans[i - 1];
    const prev = before && before.apps.every((a) => p.apps.some((x) => x.key === a.key)) ? before : null;
    const added = prev ? p.apps.filter((a) => !prev.apps.some((x) => x.key === a.key)) : p.apps;
    const items = [prev ? `<li class="plus">Everything in ${escHtml(prev.name)}, plus:</li>` : '', ...added.map((a) => `<li>${escHtml(a.label)}</li>`)].join('');
    return `<div class="plan${i === 1 ? ' feat' : ''}"><div class="sym">${sym(i)}<h2>${escHtml(p.name)}</h2></div><p class="who">${escHtml(p.blurb)}</p>`
      + `<div class="price"><b>${p.monthly_cents ? dollars(p.monthly_cents) : 'Ask us'}</b><span>${p.monthly_cents ? 'per month' : ''}</span></div><p class="setup">Billed monthly</p>`
      + `<ul>${items}</ul><a class="btn go${i === 1 ? '' : ' ghost'}" href="{{SITE}}/contact?kind=trial&amp;plan=${encodeURIComponent(p.name)}">Start a ${escHtml(p.name)} trial</a></div>`;
  }).join('\n        ');
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
async function render(req, name, slug) {
  const site = onSite(req);
  const base = site ? '' : '/site';
  const origin = `${req.protocol}://${req.get('host')}`;
  const app = config.site.appUrl || (site ? '/app' : '');
  let html = template(name);
  const plans = await loadPlans().catch(() => null);
  const head = SEO.head({ slug: name === 'notfound' ? 'notfound' : slug, origin: canonicalOrigin(req), html, plans, verify: config.site.verify, noindex: isCopy(req), modified: modified(name), asset: ASSET_V });
  html = fillPlans(html, plans).replace(/<!--\/?(PLANS|ADDONS)(:[a-z]+)?-->/g, '');
  html = html.replace('<!--HEAD-->', head)
    .replace('<div class="sx">', name === 'contact' ? '<div class="sx">' : '<div class="sx has-mcta">')
    .replace(/<!--HEADER:?([a-z-]*)-->/, (_m, cur) => header(cur))
    .replace('<!--FOOTER-->', FOOTER);
  return html
    .replaceAll('{{HOME}}', `${base}/`)
    .replaceAll('{{SITE}}', base)
    .replaceAll('{{APP}}', app || '/')
    .replaceAll('{{TRY}}', `${config.site.appUrl}/try`)
    .replaceAll('{{ROOT}}', origin)
    .replaceAll('{{YEAR}}', String(new Date().getUTCFullYear()));
}

async function send(req, res, name, slug, status = 200) {
  const body = await render(req, name, slug);
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
  if (isCopy(req) || name === 'notfound') res.set('X-Robots-Tag', 'noindex, follow');
  res.send(body);
}

// The website's stylesheet and script are fetched as /site/site.css?v=<version>, so browsers can keep them for a year
// and still get the new ones the moment a release changes the address.
const ASSET_V = require('../../package.json').version;

/** When each page last changed, for the sitemap. */
const modified = (name) => { try { return fs.statSync(path.join(DIR, `${name}.html`)).mtime.toISOString().slice(0, 10); } catch (_) { return null; } };
const PRIORITY = { '': '1.0', product: '0.9', 'ski-patrol': '0.9', pricing: '0.9', contact: '0.7', security: '0.6', privacy: '0.2', terms: '0.2' };
for (const [s] of SOLUTIONS) if (!PRIORITY[s]) PRIORITY[s] = '0.8';

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

> Verdynt/OS is web-based operations software for independent ski areas in the United States: lift and trail status and inspections, grooming, fleet maintenance, ticket and season pass sales with RFID gate scanning, an online ticket shop, waivers, ski and snowboard rentals, ski school and lesson booking, ski patrol (patient care reports, dispatch, the closing sweep) and staff scheduling. Each mountain turns on only the apps it runs. Every plan starts with a 14-day free trial, with no contract.

Verdynt/OS runs in a web browser on counter computers, phones and tablets, with nothing to install. Guest card payments go straight into each mountain's own Stripe account; Verdynt/OS never holds the money. Each mountain's data is kept separate, patient records are never deleted (mistakes are marked entered in error), and every mountain can export its data as spreadsheets at any time.

## Pages

- [Home](${page('')}): what Verdynt/OS does, one day at a ski area from first chair to closing
- [Product](${page('product')}): every app and the pages guests use
- [Ski patrol software](${page('ski-patrol')}): patient care reports, dispatch, opening checks, the closing sweep, volunteers
- [Lift ticket and season pass software](${page('lift-ticket-software')}): the counter, the gate, RFID cards and the online shop
- [Ski school software](${page('ski-school-software')}): lessons, online booking and instructors
- [Ski rental software](${page('ski-rental-software')}): rental contracts, sizing, binding records and barcoded gear
- [Online ski waivers](${page('ski-waiver-software')}): waivers signed on a phone or counter tablet
- [Lift inspection and maintenance software](${page('lift-maintenance-software')}): lift checks, grooming, work orders and the fleet
- [Pricing](${page('pricing')}): plans, add-ons and how paying works
- [Security](${page('security')}): how guest and patient information is protected
- [Contact](${page('contact')}): book a walkthrough or start a free trial

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
  kind: z.enum(['walkthrough', 'trial', 'founding', 'question', 'patrol']).default('walkthrough'),
  name: z.string().trim().min(1).max(150), mountain: z.string().trim().min(1).max(150), role: z.string().trim().max(100).optional().default(''),
  email: z.string().trim().email().max(255), phone: z.string().trim().max(40).optional().default(''), lifts: z.string().trim().max(20).optional().default(''),
  plan_interest: z.string().trim().max(60).optional().default(''), message: z.string().trim().max(2000).optional().default(''),
  founding: z.boolean().optional().default(false), website: z.string().max(200).optional().default(''), // a field people never see: bots fill it
});
const KINDS = { walkthrough: 'Walkthrough request', trial: '14-day trial request', founding: 'Founding group request', question: 'Question', patrol: 'Patrol only sign-up' };

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
        text: `Hello ${b.name},\n\nThank you for writing about ${b.mountain}. A person will reply within one business day${b.kind === 'trial' ? ' to set up your trial' : b.kind === 'patrol' ? ' to set up your patrol, with a 14-day trial' : ' to set a time'}.\n\nTo look around in the meantime, start a demo mountain: ${config.site.appUrl || `${req.protocol}://${req.get('host')}`}/try\n\nVerdynt/OS` })).ok;
    }
  }
  res.status(201).json({ ok: true, copy });
});

module.exports = { pages, notFound, api, forgetPlans, PAGES, onSite };
