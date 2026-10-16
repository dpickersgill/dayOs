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
const PAGES = { '': 'index', product: 'product', pricing: 'pricing', security: 'security', contact: 'contact', privacy: 'privacy', terms: 'terms' };
const cache = new Map();

const hostOf = (req) => String(req.get('host') || '').toLowerCase().replace(/:\d+$/, '');
const onSite = (req) => config.site.hosts.includes(hostOf(req));

function template(name) {
  if (!cache.has(name) || !config.isProd) cache.set(name, fs.readFileSync(path.join(DIR, `${name}.html`), 'utf8'));
  return cache.get(name);
}

const LOGO = (bg, fg) => `<svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="${bg}"/><path d="M3 25 L12 11 L17 18 L21 13 L29 25 Z" fill="${fg}"/></svg>`;
const NAV = [['product', 'Product'], ['pricing', 'Pricing'], ['security', 'Security']];

/** The top of every page: logo, Product, Pricing, Security, Try the demo, Sign in, Request a walkthrough. */
function header(current) {
  const links = NAV.map(([s, t]) => `<a href="{{SITE}}/${s}"${s === current ? ' aria-current="page"' : ''}>${t}</a>`).join('\n      ');
  const extra = '<a href="{{TRY}}">Try the demo</a>\n      <a href="{{APP}}">Sign in</a>';
  return `<a class="skip" href="#main">Skip to the content</a>
<header class="sn">
  <div class="wrap sn-in">
    <a class="sn-brand" href="{{HOME}}" aria-label="SummitOps, home">${LOGO('#12303A', '#FFFFFF')}<span>SummitOps</span></a>
    <nav class="sn-links" aria-label="Main">
      ${links}
      ${extra}
      <a class="btn" href="{{SITE}}/contact">Request a walkthrough</a>
    </nav>
    <details class="sn-m">
      <summary>Menu</summary>
      <nav class="sn-menu" aria-label="Main">
        ${links}
        ${extra}
        <a class="btn" href="{{SITE}}/contact">Request a walkthrough</a>
      </nav>
    </details>
  </div>
</header>`;
}

const FOOTER = `<footer class="sf">
  <div class="wrap">
    <div class="sf-grid">
      <div>
        <div class="sf-brand">${LOGO('#FFFFFF', '#12303A')}SummitOps</div>
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
    <div class="sf-base"><span>&copy; {{YEAR}} SummitOps. All rights reserved. Prices in US dollars.</span><span class="sf-legal"><a href="{{SITE}}/privacy">Privacy</a><a href="{{SITE}}/terms">Terms</a></span></div>
  </div>
</footer>`;

/** Fill in the page's links for where it is being served. */
function render(req, name, slug) {
  const site = onSite(req);
  const base = site ? '' : '/site';
  const origin = `${req.protocol}://${req.get('host')}`;
  const app = config.site.appUrl || (site ? '/app' : '');
  const canonical = `${site ? origin : `${origin}/site`}${slug ? `/${slug}` : '/'}`;
  return template(name)
    .replace(/<!--HEADER:?([a-z]*)-->/, (_m, cur) => header(cur))
    .replace('<!--FOOTER-->', FOOTER)
    .replaceAll('{{HOME}}', `${base}/`)
    .replaceAll('{{SITE}}', base)
    .replaceAll('{{APP}}', app || '/')
    .replaceAll('{{TRY}}', `${config.site.appUrl}/try`)
    .replaceAll('{{CANONICAL}}', canonical)
    .replaceAll('{{ROOT}}', origin)
    .replaceAll('{{ORIGIN}}', site ? origin : `${origin}/site`)
    .replaceAll('{{YEAR}}', String(new Date().getUTCFullYear()));
}

function send(req, res, name, slug, status = 200) {
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }).send(render(req, name, slug));
}

const pages = express.Router();
// Everywhere: /site and its pages.
pages.get('/site', (req, res, next) => (req.path === '/site' ? res.redirect(301, '/site/') : next()));
pages.get('/site/{:page}', (req, res, next) => {
  const slug = req.params.page || '';
  if (!(slug in PAGES)) return next();
  send(req, res, PAGES[slug], slug);
});
// The app itself, at /app, for a website address where / is the home page.
pages.get('/app', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', '..', 'public', 'index.html')));

// On the website's own addresses: the pages at the top, robots.txt and the sitemap.
pages.use((req, res, next) => {
  if (req.method !== 'GET' || !onSite(req)) return next();
  const p = req.path.replace(/\/+$/, '') || '/';
  if (p === '/robots.txt') return res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nSitemap: ${req.protocol}://${req.get('host')}/sitemap.xml\n`);
  if (p === '/sitemap.xml') {
    const origin = `${req.protocol}://${req.get('host')}`;
    const urls = Object.keys(PAGES).map((s) => `  <url><loc>${origin}/${s}</loc></url>`).join('\n');
    return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  }
  const slug = p === '/' ? '' : p.slice(1);
  if (slug in PAGES) return send(req, res, PAGES[slug], slug);
  return next();
});

/** The website's "not found", for website addresses only (the app keeps its own). */
function notFound(req, res, next) {
  if (req.method === 'GET' && onSite(req) && !req.path.startsWith('/api/') && (req.accepts(['html', 'json']) === 'html')) return send(req, res, 'notfound', '', 404);
  return next();
}

// ---------------------------------------------------------------- the website's API
const api = express.Router();
const M = require('../lib/modules');
let planCache = { at: 0, body: null };

/** The plans and add-ons mountains can buy, for the Pricing page. Only what the console marks active. */
api.get('/site/plans', async (_req, res) => {
  if (!planCache.body || Date.now() - planCache.at > 60_000) {
    const all = (await rows(pool, 'SELECT id, code, name, blurb, kind, modules, monthly_cents, yearly_cents, sort FROM billing_plans WHERE active = 1 ORDER BY kind, sort, monthly_cents, id'));
    const label = (k) => (M.MODULES.find((m) => m.key === k) || { label: k }).label.replace(/\s*\(add-on\)/i, '');
    const shape = (p) => ({ code: p.code, name: p.name, blurb: p.blurb, monthly_cents: Number(p.monthly_cents), yearly_cents: Number(p.yearly_cents), apps: String(p.modules || '').split(',').filter(Boolean).map((k) => ({ key: k, label: label(k) })) });
    planCache = { at: Date.now(), body: { plans: all.filter((p) => p.kind === 'plan').map(shape), addons: all.filter((p) => p.kind === 'addon').map(shape), trial_days: require('../lib/billing').TRIAL_DAYS } };
  }
  res.set('Cache-Control', 'public, max-age=60').json(planCache.body);
});
const forgetPlans = () => { planCache = { at: 0, body: null }; };

const contactBody = z.object({
  kind: z.enum(['walkthrough', 'trial', 'founding', 'question']).default('walkthrough'),
  name: z.string().trim().min(1).max(150), mountain: z.string().trim().min(1).max(150), role: z.string().trim().max(100).optional().default(''),
  email: z.string().trim().email().max(255), phone: z.string().trim().max(40).optional().default(''), lifts: z.string().trim().max(20).optional().default(''),
  plan_interest: z.string().trim().max(60).optional().default(''), message: z.string().trim().max(2000).optional().default(''),
  founding: z.boolean().optional().default(false), website: z.string().max(200).optional().default(''), // a field people never see: bots fill it
});
const KINDS = { walkthrough: 'Walkthrough request', trial: '14-day trial request', founding: 'Founding group request', question: 'Question' };

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
      copy = (await mailer.sendPlatform({ to: b.email, replyTo: config.site.contactEmail, subject: 'We have your SummitOps request', tag: 'site-lead-thanks',
        text: `Hello ${b.name},\n\nThank you for writing about ${b.mountain}. A person will reply within one business day${b.kind === 'trial' ? ' to set up your trial' : ' to set a time'}.\n\nTo look around in the meantime, start a demo mountain: ${config.site.appUrl || `${req.protocol}://${req.get('host')}`}/try\n\nSummitOps` })).ok;
    }
  }
  res.status(201).json({ ok: true, copy });
});

module.exports = { pages, notFound, api, forgetPlans, PAGES, onSite };
