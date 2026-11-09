'use strict';

// Search engines and link previews for the product website: each page's title and description (written for what ski
// area managers search for), the one canonical address, Open Graph and X cards, and structured data (JSON-LD) that
// Google reads: the organization, the website, the software with its live prices, breadcrumbs, and each page's
// questions and answers, read from the page itself so they never drift from what visitors see.

// title: under ~60 characters, the search phrase first. description: under ~160 characters, a reason to click.
const META = {
  '': {
    title: 'Ski Area and Ski Resort Management Software | Verdynt/OS',
    description: 'Run lifts, ski patrol, tickets, rentals, lessons, staff and your zipline, coaster or tubing hill from one screen. For independent ski areas. From {{FROM}}/month.',
    og: 'Run the whole mountain from one screen',
  },
  product: {
    title: 'Ski Resort Software: POS, Lifts, Patrol, Rentals | Verdynt/OS',
    description: 'Every Verdynt/OS app: ticket sales and RFID gate, online shop, lift inspections, grooming, fleet maintenance, rentals, ski school, ski patrol and scheduling.',
    og: 'Every part of the mountain. Run the parts you need.',
    crumb: 'Product',
  },
  'ski-patrol': {
    title: 'Ski Patrol Software: Incident Reports, Dispatch | Verdynt/OS',
    description: 'Ski patrol patient care reports written once at the bedside, even with no signal, with an EMS hand-off sheet. Dispatch, sweep and volunteers too.',
    og: 'Write the report once, at the bedside',
    crumb: 'Ski patrol',
  },
  'ski-area-risk-management': {
    title: 'Ski Area Risk Management and Incident Records | Verdynt/OS',
    description: 'For ski area owners, GMs and insurers: a documentation score, a one-click claim file, a season risk report for renewal and secure insurer access.',
    og: 'When the claim comes, the record is already written',
    crumb: 'For owners and insurers',
  },
  'lift-ticket-software': {
    title: 'Ski Area Lift Ticket and Season Pass Software | Verdynt/OS',
    description: 'Sell lift tickets, season passes and gift cards at the window and online, scan them at the gate or on RFID cards, and stop a pass that was just used.',
    og: 'Lift ticket and season pass software for independent ski areas',
    crumb: 'Lift tickets and passes',
  },
  'ski-school-software': {
    title: 'Ski School Software: Lessons and Booking | Verdynt/OS',
    description: 'Ski school software for lessons: online lesson booking, class sizes by age, pickup with authorized adults, lost child calls to patrol and instructor pay.',
    og: 'Ski school software for lessons, from the first booking to the last pickup',
    crumb: 'Ski school',
  },
  'ski-rental-software': {
    title: 'Ski Rental Shop Software: Contracts and Gear | Verdynt/OS',
    description: 'Ski and snowboard rental software: guest rental forms, fitting cards, binding records, card deposits, group bags and scan-to-return for every item.',
    og: 'Ski rental software: every item out, and every item back',
    crumb: 'Ski rentals',
  },
  'ski-waiver-software': {
    title: 'Online Ski Waivers: Sign on a Phone or Tablet | Verdynt/OS',
    description: 'Guests sign your ski area waiver at home or on a counter tablet. Parents sign for their children, the exact wording is kept, and every signer gets a copy.',
    og: 'Online waivers your guests sign before they drive up',
    crumb: 'Online waivers',
  },
  'lift-maintenance-software': {
    title: 'Lift Inspection and Maintenance Software | Verdynt/OS',
    description: 'Lift inspection checklists on a phone, wind holds and downtime, grooming plans, work orders and service plans for groomers, snowmobiles, snowmaking and lifts.',
    og: "Lift inspections and maintenance: know what's safe to open",
    crumb: 'Lift and fleet maintenance',
  },
  'ski-area-pos': {
    title: 'Ski Area POS: Tickets, Card Reader, Gift Cards | Verdynt/OS',
    description: 'Point of sale for ski areas: lift tickets, passes, lessons and rentals in one basket, cards on a Stripe smart reader, cash, gift cards and the till counted.',
    og: 'Ski area POS: a fast ticket window on a busy Saturday',
    crumb: 'Ski area POS',
  },
  'online-lift-ticket-sales': {
    title: 'Sell Lift Tickets Online: Ski Area Ticket Shop | Verdynt/OS',
    description: 'Your own online ticket shop: guests pick a day, see its price and buy tickets, passes and gift cards by card. Daily limits, a waitlist and date changes.',
    og: 'Sell lift tickets online, on your own page',
    crumb: 'Online ticket sales',
  },
  'terrain-park-software': {
    title: 'Terrain Park Software: Feature Map, Inspections | Verdynt/OS',
    description: 'A catalog of rails, boxes and jumps, a daily park map with GPS pins from a phone, and inspections that close a failed feature until it passes again.',
    og: 'Terrain park software: every feature, where it is, and whether it passed',
    crumb: 'Terrain park',
  },
  'attraction-ticketing-software': {
    title: 'Ski Area Zipline, Coaster and Tubing Software | Verdynt/OS',
    description: 'Run your zipline, coaster, tubing hill or rink: a daily opening check, and time slots with height, weight and age limits, sold at the counter and online.',
    og: 'Attractions and activities: open on the check, sold by the time slot',
    crumb: 'Attractions and activities',
  },
  'ski-area-staff-scheduling': {
    title: 'Ski Area Staff Scheduling and Time Clock | Verdynt/OS',
    description: 'Schedule lifts, rentals, ski school and food staff by the week, see staffing needs from tickets sold, clock in with a PIN or badge, and track certifications.',
    og: 'Ski area staff scheduling: every shift covered before the first chair',
    crumb: 'Staff scheduling',
  },
  resources: {
    title: 'Ski Area Guides, Checklists and Templates | Verdynt/OS',
    description: 'Free guides for ski areas: a ski school pickup policy, a lost child procedure, instructor pay scales, opening day, lift and park checklists, incident reports.',
    og: 'Guides and checklists for running a ski area',
    crumb: 'Resources',
  },
  'chairlift-inspection-checklist': {
    title: 'Chairlift Daily Inspection Checklist (Printable) | Verdynt/OS',
    description: 'A printable chairlift pre-opening inspection checklist for ski areas, and how to keep the documented daily record ANSI B77.1 and state inspectors expect.',
    og: 'Chairlift daily inspection checklist for ski areas',
    crumb: 'Chairlift inspection checklist', parent: 'resources',
    article: { published: '2026-10-23', headline: 'Chairlift daily inspection checklist for ski areas' },
  },
  'terrain-park-inspection-checklist': {
    title: 'Terrain Park Daily Inspection Checklist | Verdynt/OS',
    description: 'A printable terrain park inspection checklist: every jump, rail and landing, the signs and Park SMART messages, and a daily record of what was open.',
    og: 'Terrain park daily inspection checklist',
    crumb: 'Terrain park inspection checklist', parent: 'resources',
    article: { published: '2026-10-23', headline: 'Terrain park daily inspection checklist' },
  },
  'ski-area-incident-report-guide': {
    title: 'How to Write a Ski Area Incident Report | Verdynt/OS',
    description: 'What a ski patrol incident report should record, what to leave out, and a printable checklist for reviewing every report before it is filed.',
    og: 'How to write a ski area incident report',
    crumb: 'Incident report guide', parent: 'resources',
    article: { published: '2026-10-23', headline: 'How to write a ski area incident report' },
  },
  'how-to-choose-ski-area-software': {
    title: 'How to Choose Ski Area Management Software | Verdynt/OS',
    description: 'A buyer\'s guide for independent ski areas: when to switch, what to compare, and twelve questions to ask every ski area software vendor before you sign.',
    og: 'How to choose ski area management software',
    crumb: 'Choosing ski area software', parent: 'resources',
    article: { published: '2026-10-23', headline: 'How to choose ski area management software' },
  },
  'ski-school-pickup-policy': {
    title: 'Ski School Child Pickup Policy Template | Verdynt/OS',
    description: 'A ski school child pickup and release policy template: the authorized adult list, ID checks, what to do when nobody comes, overrides and the record to keep.',
    og: 'Ski school child pickup and release policy (template)',
    crumb: 'Child pickup and release policy', parent: 'resources',
    article: { published: '2026-11-09', headline: 'Ski school child pickup and release policy (template)' },
  },
  'lost-child-procedure': {
    title: 'Lost Child Procedure for Ski Areas, with Drill | Verdynt/OS',
    description: 'A lost child procedure for ski areas: the first 5 minutes, the next 30, the reunion and the record, with a printable checklist for a drill twice a season.',
    og: 'Lost child procedure for ski areas',
    crumb: 'Lost child procedure', parent: 'resources',
    article: { published: '2026-11-09', headline: 'Lost child procedure for ski areas' },
  },
  'ski-instructor-pay-scale': {
    title: 'How to Build a Ski Instructor Pay Scale | Verdynt/OS',
    description: 'Build a ski instructor pay scale: base rates by certification level, credential and seniority steps, private and request premiums, training pay and tips.',
    og: 'How to build a ski instructor pay scale',
    crumb: 'Ski instructor pay scale', parent: 'resources',
    article: { published: '2026-11-09', headline: 'How to build a ski instructor pay scale' },
  },
  'ski-area-opening-day-checklist': {
    title: 'Ski Area Opening Day Checklist (Printable) | Verdynt/OS',
    description: 'A printable ski area opening day checklist for lifts, patrol, the park, grooming, tickets, rentals, ski school, staff and guests: weeks before and morning of.',
    og: 'Ski area opening day checklist',
    crumb: 'Opening day checklist', parent: 'resources',
    article: { published: '2026-11-09', headline: 'Ski area opening day checklist' },
  },
  about: {
    title: 'About Verdynt/OS: Software for Independent Ski Areas',
    description: 'Verdynt/OS is operations software built for independent ski areas: family-owned hills, community areas and nonprofit mountains. What we believe and how we work.',
    og: 'Software for the ski areas the big systems forgot',
    crumb: 'About',
  },
  pricing: {
    title: 'Pricing: Ski Area Software from {{FROM}}/month | Verdynt/OS',
    description: 'Plans for independent ski areas and ski patrols, plus add-ons, monthly or less yearly. Pay by card, bank or invoice. No contract, and 14 days free.',
    og: 'Verdynt/OS pricing: priced by what you run',
    crumb: 'Pricing',
  },
  security: {
    title: 'Security and Patient Data Protection | Verdynt/OS',
    description: 'How Verdynt/OS protects guest and ski patrol patient records: separate mountains, access by role, two-step sign-in, nothing deleted, payments via Stripe.',
    og: 'Careful with guest and patient information',
    crumb: 'Security',
  },
  status: {
    title: 'Service Status | Verdynt/OS',
    description: 'Whether each part of Verdynt/OS is working right now: the app, online shop and booking pages, card payments, email and texts, with incidents and maintenance.',
    og: 'Is Verdynt/OS working?',
    crumb: 'Status',
  },
  contact: {
    title: 'Request a Demo or a Free 14-Day Trial | Verdynt/OS',
    description: 'Book a 20-minute walkthrough of Verdynt/OS, start a 14-day free trial, or apply for the Founding Mountain Program.',
    og: 'See your mountain on the board',
    crumb: 'Contact',
  },
  privacy: { title: 'Privacy Policy | Verdynt/OS', description: 'What Verdynt/OS collects, why, who it is shared with, how long it is kept, and the choices you have.', crumb: 'Privacy' },
  terms: { title: 'Terms of Service | Verdynt/OS', description: 'The terms for using Verdynt/OS: trials, subscriptions and payment, your data, and what each side is responsible for.', crumb: 'Terms' },
  // The Good Day scorecard (2026.11 policy and brand review): a free tool, so it carries WebApplication data too.
  'good-day/scorecard': {
    title: 'The Good Day Scorecard for Ski Areas | Verdynt/OS',
    description: 'Twelve questions on the guest\'s day at your ski area: tickets, lessons, lift checks, patrol, the park, staff and conditions. Free, with next steps.',
    og: 'How good is your guest\'s day? The Good Day scorecard',
    crumb: 'Scorecard', parent: 'good-day', tool: 'The Good Day scorecard',
  },
  notfound: { title: 'Page Not Found | Verdynt/OS', description: 'That page is not here.', noindex: true },
};

// Each page's own share image when there is one (public/site/img/share, drawn by scripts/share-images.js from lib/share.js),
// else the site-wide share.png. Looked up once per page.
const fs = require('node:fs');
const path = require('node:path');
const SHARE = require('./share');
const SHARE_DIR = path.join(__dirname, '..', '..', 'public', 'site', 'img', 'share');
const shareSeen = new Map();
function shareImage(slug) {
  if (!shareSeen.has(slug)) {
    const file = SHARE.fileFor(slug);
    const own = slug in SHARE.SHARE && fs.existsSync(path.join(SHARE_DIR, `${file}.png`));
    const t = SHARE.SHARE[slug];
    shareSeen.set(slug, own ? { path: `/site/img/share/${file}.png`, alt: `${t.headline}: ${t.sub.replace(/\.$/, '')}. Verdynt/OS` }
      : { path: '/site/img/share.png', alt: 'Verdynt/OS, resort operating system: open the mountain from one screen' });
  }
  return shareSeen.get(slug);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

/** The questions and answers on a page (its <details><summary> blocks), for FAQ structured data. */
function faqsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)) out.push({ q: text(m[1]), a: text(m[2]) });
  return out;
}

const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

/**
 * The whole <head> for a page.
 * ctx: { slug, origin (the canonical origin, no trailing slash), base (link prefix), html (the page body), plans, verify }
 */
// Pages that describe the software itself carry its structured data (name, category, prices).
const SOFTWARE_PAGES = ['', 'pricing', 'product', 'ski-patrol', 'ski-area-risk-management', 'lift-ticket-software', 'ski-school-software', 'ski-rental-software', 'ski-waiver-software', 'lift-maintenance-software', 'ski-area-pos', 'online-lift-ticket-sales', 'terrain-park-software', 'attraction-ticketing-software', 'ski-area-staff-scheduling'];
const FEATURES = ['Lift and trail status and inspections', 'Grooming and snowmaking logs', 'Ticket and season pass sales', 'RFID gate scanning', 'Online ticket shop',
  'Online waivers', 'Ski and snowboard rentals', 'Ski school and lesson booking', 'Ski patrol patient care reports and dispatch', 'Staff scheduling and time clock', 'Fleet and equipment maintenance',
  'Attractions with daily opening checks', 'Activity time slots with rider limits sold at the counter and online'];

function head({ slug, origin, html, plans, verify = {}, sameAs = [], noindex = false, modified = null, asset = '' }) {
  const key = slug in META ? slug : 'notfound';
  const m = META[key];
  // The lowest ski area plan: Patrol only is left out, as lib/demomail.js does, so "from" never quotes the patrol's own price.
  const areaPlans = plans ? plans.plans.filter((p) => p.code !== 'patrol-only' && p.monthly_cents) : [];
  const from = areaPlans.length ? dollars(Math.min(...areaPlans.map((p) => p.monthly_cents))) : '$199';
  const fill = (s) => String(s || '').replaceAll('{{FROM}}', from);
  const url = `${origin}/${key === 'notfound' ? '' : slug}`;
  const share = shareImage(key === 'notfound' ? '' : slug);
  const image = `${origin.replace(/\/site$/, '')}${share.path}`;
  const title = fill(m.title); const description = fill(m.description);
  const robots = noindex || m.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large';

  const graph = [
    { '@type': 'Organization', '@id': `${origin}/#org`, name: 'Verdynt/OS', url: `${origin}/`, logo: `${origin.replace(/\/site$/, '')}/icons/icon-512.png`,
      // the company behind it, from config.site.company (one place, so a legal suffix is a one-line change)
      legalName: require('../config').site.company.name, foundingDate: '2026', areaServed: 'US',
      address: { '@type': 'PostalAddress', addressRegion: 'PA', addressCountry: 'US' },
      description: 'Operations software for independent ski areas.', ...(sameAs.length ? { sameAs } : {}), contactPoint: [
        { '@type': 'ContactPoint', contactType: 'sales', email: require('../config').site.helloEmail, url: `${origin}/contact`, availableLanguage: ['English'] },
        { '@type': 'ContactPoint', contactType: 'customer support', email: require('../config').site.supportEmail, availableLanguage: ['English'] },
      ] },
    { '@type': 'WebSite', '@id': `${origin}/#site`, name: 'Verdynt/OS', url: `${origin}/`, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-US' },
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: title, description, isPartOf: { '@id': `${origin}/#site` }, inLanguage: 'en-US',
      primaryImageOfPage: { '@type': 'ImageObject', url: image, width: 1200, height: 630 }, ...(modified ? { dateModified: modified } : {}) },
  ];
  if (SOFTWARE_PAGES.includes(key) && plans && plans.plans.length) {
    graph.push({
      '@type': 'SoftwareApplication', '@id': `${origin}/#software`, name: 'Verdynt/OS', applicationCategory: 'BusinessApplication', applicationSubCategory: 'Ski area management software',
      operatingSystem: 'Web browser', url: `${origin}/`, image, publisher: { '@id': `${origin}/#org` },
      description: 'Operations software for independent ski areas: lift inspections, ski patrol, ticket sales, waivers, rentals, ski school, staff scheduling, and attractions and activities such as ziplines, coasters and tubing.',
      featureList: FEATURES.join(', '), isAccessibleForFree: false, inLanguage: 'en-US',
      offers: { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: (Math.min(...plans.plans.map((p) => p.monthly_cents)) / 100).toFixed(2), highPrice: (Math.max(...plans.plans.map((p) => p.monthly_cents)) / 100).toFixed(2), offerCount: plans.plans.length,
        offers: plans.plans.map((p) => ({ '@type': 'Offer', name: p.name, price: (p.monthly_cents / 100).toFixed(2), priceCurrency: 'USD', description: p.blurb || undefined, url: `${origin}/pricing`,
          priceSpecification: { '@type': 'UnitPriceSpecification', price: (p.monthly_cents / 100).toFixed(2), priceCurrency: 'USD', unitText: 'MONTH', billingDuration: 'P1M' } })) },
    });
  }
  if (key !== '' && m.crumb) {
    // Home, then the section (Resources) for a guide, then the page itself.
    const trail = [{ name: 'Home', item: `${origin}/` }, ...(m.parent && META[m.parent] ? [{ name: META[m.parent].crumb, item: `${origin}/${m.parent}` }] : []), { name: m.crumb, item: url }];
    graph.push({ '@type': 'BreadcrumbList', itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, ...t })) });
  }
  // A free tool on the website (the Good Day scorecard): what it is, that it is free, and who made it.
  if (m.tool) {
    graph.push({ '@type': 'WebApplication', '@id': `${url}#app`, name: m.tool, url, description, applicationCategory: 'BusinessApplication', operatingSystem: 'Web browser',
      isAccessibleForFree: true, offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-US' });
  }
  // Guides are articles: who published them and when, so search engines can show them as such.
  if (m.article) {
    graph.push({ '@type': 'Article', '@id': `${url}#article`, headline: m.article.headline, description, url, mainEntityOfPage: { '@id': `${url}#page` }, image,
      datePublished: m.article.published, dateModified: modified && modified > m.article.published ? modified : m.article.published,
      author: { '@id': `${origin}/#org` }, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-US', isAccessibleForFree: true });
  }
  const faqs = faqsOf(html || '');
  if (faqs.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });

  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="robots" content="${robots}">`,
    key === 'notfound' ? null : `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="${m.article ? 'article' : 'website'}">`,
    '<meta property="og:site_name" content="Verdynt/OS">',
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:title" content="${esc(fill(m.og || title))}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:type" content="image/png">',
    `<meta property="og:image:alt" content="${esc(share.alt)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(fill(m.og || title))}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<meta name="twitter:image:alt" content="${esc(share.alt)}">`,
    verify.google ? `<meta name="google-site-verification" content="${esc(verify.google)}">` : null,
    verify.bing ? `<meta name="msvalidate.01" content="${esc(verify.bing)}">` : null,
    '<meta name="theme-color" content="#0e2632">',
    '<link rel="icon" href="/icons/icon-32.png" type="image/png" sizes="32x32">',
    '<link rel="apple-touch-icon" href="/icons/icon-180.png">',
    '<link rel="preload" href="/brand/verdynt-lockup-light.png" as="image" type="image/png">',
    '<link rel="preload" href="/fonts/barlow-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/fonts/atkinson-hyperlegible-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>',
    `<link rel="stylesheet" href="/site/site.css${asset ? `?v=${esc(asset)}` : ''}">`,
    `<script src="/site/site.js${asset ? `?v=${esc(asset)}` : ''}" defer></script>`,
    '<link rel="alternate" type="text/plain" href="/llms.txt" title="Verdynt/OS for AI assistants">',
    `<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@graph': graph })}</script>`,
  ].filter(Boolean).join('\n');
}

module.exports = { META, head, faqsOf, SOFTWARE_PAGES, shareImage };
