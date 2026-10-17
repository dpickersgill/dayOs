'use strict';

// Search engines and link previews for the product website: each page's title and description (written for what ski
// area managers search for), the one canonical address, Open Graph and X cards, and structured data (JSON-LD) that
// Google reads: the organisation, the website, the software with its live prices, breadcrumbs, and each page's
// questions and answers, read from the page itself so they never drift from what visitors see.

// title: under ~60 characters, the search phrase first. description: under ~160 characters, a reason to click.
const META = {
  '': {
    title: 'Ski Area Management Software | DAY/OS',
    description: 'Run lifts, ski patrol, tickets, waivers, rentals, lessons and staff from one screen. Built for independent ski areas. Plans from {{FROM}}/month, 14 days free.',
    og: 'Open the mountain from one screen',
  },
  product: {
    title: 'Ski Resort Software: POS, Lifts, Patrol, Rentals | DAY/OS',
    description: 'Every DAY/OS app: ticket sales and RFID gate, online shop, lift inspections, grooming, fleet maintenance, rentals, ski school, ski patrol and scheduling.',
    og: 'Every part of the mountain. Run the parts you need.',
    crumb: 'Product',
  },
  'ski-patrol': {
    title: 'Ski Patrol Software: Incident Reports and Dispatch | DAY/OS',
    description: 'Patient care reports written at the bedside, dispatch with phone alerts, opening checks, the closing sweep and volunteer days, for paid and volunteer patrols.',
    og: 'Ski patrol software, from the first call to the closing sweep',
    crumb: 'Ski patrol',
  },
  pricing: {
    title: 'Pricing: Ski Area Software from {{FROM}}/month | DAY/OS',
    description: 'Three plans for independent ski areas plus add-ons, monthly or 15% less yearly. Pay by card, bank or invoice. No contract, and 14 days free.',
    og: 'DAY/OS pricing: priced by what you run',
    crumb: 'Pricing',
  },
  security: {
    title: 'Security and Patient Data Protection | DAY/OS',
    description: 'How DAY/OS protects guest and ski patrol patient records: separate mountains, access by role, two-step sign-in, nothing deleted, payments via Stripe.',
    og: 'Careful with guest and patient information',
    crumb: 'Security',
  },
  contact: {
    title: 'Request a Demo or a Free 14-Day Trial | DAY/OS',
    description: 'Book a 20-minute walkthrough of DAY/OS, start a 14-day free trial on your own mountain, or join the founding group of independent ski areas.',
    og: 'See your mountain on the board',
    crumb: 'Contact',
  },
  privacy: { title: 'Privacy Policy | DAY/OS', description: 'What DAY/OS collects, why, who it is shared with, how long it is kept, and the choices you have.', crumb: 'Privacy' },
  terms: { title: 'Terms of Service | DAY/OS', description: 'The terms for using DAY/OS: trials, subscriptions and payment, your data, and what each side is responsible for.', crumb: 'Terms' },
  notfound: { title: 'Page Not Found | DAY/OS', description: 'That page is not here.', noindex: true },
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
function head({ slug, origin, html, plans, verify = {}, noindex = false }) {
  const key = slug in META ? slug : 'notfound';
  const m = META[key];
  const from = plans && plans.plans.length ? dollars(Math.min(...plans.plans.map((p) => p.monthly_cents).filter(Boolean))) : '$199';
  const fill = (s) => String(s || '').replaceAll('{{FROM}}', from);
  const url = `${origin}/${key === 'notfound' ? '' : slug}`;
  const image = `${origin.replace(/\/site$/, '')}/site/img/share.png`;
  const title = fill(m.title); const description = fill(m.description);
  const robots = noindex || m.noindex ? 'noindex, follow' : 'index, follow, max-image-preview:large';

  const graph = [
    { '@type': 'Organization', '@id': `${origin}/#org`, name: 'DAY/OS', url: `${origin}/`, logo: `${origin.replace(/\/site$/, '')}/icons/icon-512.png` },
    { '@type': 'WebSite', '@id': `${origin}/#site`, name: 'DAY/OS', url: `${origin}/`, publisher: { '@id': `${origin}/#org` }, inLanguage: 'en-US' },
    { '@type': 'WebPage', '@id': `${url}#page`, url, name: title, description, isPartOf: { '@id': `${origin}/#site` }, inLanguage: 'en-US' },
  ];
  if (['', 'pricing', 'product', 'ski-patrol'].includes(key) && plans && plans.plans.length) {
    graph.push({
      '@type': 'SoftwareApplication', '@id': `${origin}/#software`, name: 'DAY/OS', applicationCategory: 'BusinessApplication', applicationSubCategory: 'Ski area management software',
      operatingSystem: 'Web browser; iOS; Android', url: `${origin}/`, image, publisher: { '@id': `${origin}/#org` },
      description: 'Operations software for independent ski areas: lift inspections, ski patrol, ticket sales, waivers, rentals, ski school and staff scheduling.',
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
    '<meta property="og:site_name" content="DAY/OS">',
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:title" content="${esc(fill(m.og || title))}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="DAY/OS: Open the mountain from one screen">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${esc(fill(m.og || title))}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    verify.google ? `<meta name="google-site-verification" content="${esc(verify.google)}">` : null,
    verify.bing ? `<meta name="msvalidate.01" content="${esc(verify.bing)}">` : null,
    '<meta name="theme-color" content="#12303a">',
    '<link rel="icon" href="/site/img/icon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/icons/icon-180.png">',
    '<link rel="preload" href="/fonts/barlow-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="preload" href="/fonts/atkinson-hyperlegible-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>',
    '<link rel="stylesheet" href="/site/site.css">',
    '<script src="/site/site.js" defer></script>',
    `<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@graph': graph })}</script>`,
  ].filter(Boolean).join('\n');
}

module.exports = { META, head, faqsOf };
