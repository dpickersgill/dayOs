'use strict';

// Search engines and link previews for the product website: each page's title and description (written for what ski
// area managers search for), the one canonical address, Open Graph and X cards, and structured data (JSON-LD) that
// Google reads: the organisation, the website, the software with its live prices, breadcrumbs, and each page's
// questions and answers, read from the page itself so they never drift from what visitors see.

// title: under ~60 characters, the search phrase first. description: under ~160 characters, a reason to click.
const META = {
  '': {
    title: 'Ski Area and Ski Resort Management Software | Verdynt/OS',
    description: 'Run lifts, ski patrol, tickets, waivers, rentals, lessons and staff from one screen. Built for independent ski areas. Plans from {{FROM}}/month, 14 days free.',
    og: 'Open the mountain from one screen',
  },
  product: {
    title: 'Ski Resort Software: POS, Lifts, Patrol, Rentals | Verdynt/OS',
    description: 'Every Verdynt/OS app: ticket sales and RFID gate, online shop, lift inspections, grooming, fleet maintenance, rentals, ski school, ski patrol and scheduling.',
    og: 'Every part of the mountain. Run the parts you need.',
    crumb: 'Product',
  },
  'ski-patrol': {
    title: 'Ski Patrol Software: Incident Reports, Dispatch | Verdynt/OS',
    description: 'Patient care reports written at the bedside, dispatch with phone alerts, opening checks, the closing sweep and volunteer days, for paid and volunteer patrols.',
    og: 'Ski patrol software, from the first call to the closing sweep',
    crumb: 'Ski patrol',
  },
  'lift-ticket-software': {
    title: 'Lift Ticket and Season Pass Software | Verdynt/OS',
    description: 'Sell lift tickets, season passes and gift cards at the counter and online, scan them at the lift with RFID cards, and stop a pass that was just used.',
    og: 'Lift tickets and passes: sell it, scan it, move on',
    crumb: 'Lift tickets and passes',
  },
  'ski-school-software': {
    title: 'Ski School Software: Lesson Booking | Verdynt/OS',
    description: 'Lesson sessions with rosters, online lesson booking and payment in English or Spanish, packages that count down, and instructors who post their own open days.',
    og: 'Ski school software: sessions that fill without the phone tag',
    crumb: 'Ski school',
  },
  'ski-rental-software': {
    title: 'Ski Rental Shop Software: Contracts and Gear | Verdynt/OS',
    description: 'Ski and snowboard rental software: sizing profiles, reservations, binding records, barcoded gear, deposits and late fees, and a waiver for every renter.',
    og: 'Ski rental software: every item out, and every item back',
    crumb: 'Ski rentals',
  },
  'ski-waiver-software': {
    title: 'Online Ski Waivers: Sign on a Phone or Tablet | Verdynt/OS',
    description: 'Guests sign their ski area waiver at home or on a counter tablet. Parents sign for their children, the exact wording is kept, and every signer gets a copy.',
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
    description: 'A catalog of rails, boxes and jumps, a daily park map with GPS pins dropped from a phone, and inspections that close a feature everywhere when it fails.',
    og: 'Terrain park software: every feature, where it is, and whether it passed',
    crumb: 'Terrain park',
  },
  'ski-area-staff-scheduling': {
    title: 'Ski Area Staff Scheduling and Time Clock | Verdynt/OS',
    description: 'Schedule lifts, rentals, ski school and food staff by the week, see staffing needs from tickets sold, clock in with a PIN or badge, and track certifications.',
    og: 'Ski area staff scheduling: every shift covered before the first chair',
    crumb: 'Staff scheduling',
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
  contact: {
    title: 'Request a Demo or a Free 14-Day Trial | Verdynt/OS',
    description: 'Book a 20-minute walkthrough of Verdynt/OS, start a 14-day free trial on your own mountain, or join the founding group of independent ski areas.',
    og: 'See your mountain on the board',
    crumb: 'Contact',
  },
  privacy: { title: 'Privacy Policy | Verdynt/OS', description: 'What Verdynt/OS collects, why, who it is shared with, how long it is kept, and the choices you have.', crumb: 'Privacy' },
  terms: { title: 'Terms of Service | Verdynt/OS', description: 'The terms for using Verdynt/OS: trials, subscriptions and payment, your data, and what each side is responsible for.', crumb: 'Terms' },
  notfound: { title: 'Page Not Found | Verdynt/OS', description: 'That page is not here.', noindex: true },
};

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
const SOFTWARE_PAGES = ['', 'pricing', 'product', 'ski-patrol', 'lift-ticket-software', 'ski-school-software', 'ski-rental-software', 'ski-waiver-software', 'lift-maintenance-software', 'ski-area-pos', 'online-lift-ticket-sales', 'terrain-park-software', 'ski-area-staff-scheduling'];
const FEATURES = ['Lift and trail status and inspections', 'Grooming and snowmaking logs', 'Ticket and season pass sales', 'RFID gate scanning', 'Online ticket shop',
  'Online waivers', 'Ski and snowboard rentals', 'Ski school and lesson booking', 'Ski patrol patient care reports and dispatch', 'Staff scheduling and time clock', 'Fleet and equipment maintenance'];

function head({ slug, origin, html, plans, verify = {}, noindex = false, modified = null, asset = '' }) {
  const key = slug in META ? slug : 'notfound';
  const m = META[key];
  const from = plans && plans.plans.length ? dollars(Math.min(...plans.plans.map((p) => p.monthly_cents).filter(Boolean))) : '$199';
  const fill = (s) => String(s || '').replaceAll('{{FROM}}', from);
  const url = `${origin}/${key === 'notfound' ? '' : slug}`;
  const image = `${origin.replace(/\/site$/, '')}/site/img/share.png`;
  const title = fill(m.title); const description = fill(m.description);
  const robots = noindex || m.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large';

  const graph = [
    { '@type': 'Organization', '@id': `${origin}/#org`, name: 'Verdynt/OS', url: `${origin}/`, logo: `${origin.replace(/\/site$/, '')}/icons/icon-512.png`,
      description: 'Operations software for independent ski areas.', contactPoint: { '@type': 'ContactPoint', contactType: 'sales', url: `${origin}/contact`, availableLanguage: ['English'] } },
    { '@type': 'WebSite', '@id': `${origin}/#site`, name: 'Verdynt/OS', url: `${origin}/`, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-US' },
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: title, description, isPartOf: { '@id': `${origin}/#site` }, inLanguage: 'en-US',
      primaryImageOfPage: { '@type': 'ImageObject', url: image, width: 1200, height: 630 }, ...(modified ? { dateModified: modified } : {}) },
  ];
  if (SOFTWARE_PAGES.includes(key) && plans && plans.plans.length) {
    graph.push({
      '@type': 'SoftwareApplication', '@id': `${origin}/#software`, name: 'Verdynt/OS', applicationCategory: 'BusinessApplication', applicationSubCategory: 'Ski area management software',
      operatingSystem: 'Web browser; iOS; Android', url: `${origin}/`, image, publisher: { '@id': `${origin}/#org` },
      description: 'Operations software for independent ski areas: lift inspections, ski patrol, ticket sales, waivers, rentals, ski school and staff scheduling.',
      featureList: FEATURES.join(', '), isAccessibleForFree: false, inLanguage: 'en-US',
      offers: { '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: (Math.min(...plans.plans.map((p) => p.monthly_cents)) / 100).toFixed(2), highPrice: (Math.max(...plans.plans.map((p) => p.monthly_cents)) / 100).toFixed(2), offerCount: plans.plans.length,
        offers: plans.plans.map((p) => ({ '@type': 'Offer', name: p.name, price: (p.monthly_cents / 100).toFixed(2), priceCurrency: 'USD', description: p.blurb || undefined, url: `${origin}/pricing`,
          priceSpecification: { '@type': 'UnitPriceSpecification', price: (p.monthly_cents / 100).toFixed(2), priceCurrency: 'USD', unitText: 'MONTH', billingDuration: 'P1M' } })) },
    });
  }
  if (key !== '' && m.crumb) graph.push({ '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` }, { '@type': 'ListItem', position: 2, name: m.crumb, item: url }] });
  const faqs = faqsOf(html || '');
  if (faqs.length) graph.push({ '@type': 'FAQPage', '@id': `${url}#faq`, mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });

  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<meta name="robots" content="${robots}">`,
    key === 'notfound' ? null : `<link rel="canonical" href="${esc(url)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Verdynt/OS">',
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:title" content="${esc(fill(m.og || title))}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:alt" content="Verdynt/OS, resort operating system: open the mountain from one screen">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(fill(m.og || title))}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
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

module.exports = { META, head, faqsOf, SOFTWARE_PAGES };
