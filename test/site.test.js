'use strict';

// The product website: its pages at /site everywhere and at / on its own address, robots and sitemap, live plans from the
// console, and the Contact form (kept for the console's Leads and emailed through a mock Postmark).
const http = require('node:http');
const mails = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { mails.push(JSON.parse(body || '{}')); res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"m"}'); });
});
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';
process.env.SITE_HOSTS = 'www.site.test,site.test';
process.env.GOOGLE_SITE_VERIFICATION = 'g-verify-123';
process.env.SITE_CONTACT_EMAIL = 'sales@site.test';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
process.env.MAIL_FROM = 'hello@site.test';
process.env.SITE_SAME_AS = 'https://www.linkedin.com/company/verdynt-test, not a url';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');

let server; let base;
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const KEY = 'test-bootstrap-key';
async function get(path, host) {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'text/html', ...(host ? { 'x-forwarded-host': host, host } : {}) }, redirect: 'manual' });
  return { status: res.status, text: await res.text(), type: res.headers.get('content-type') || '', location: res.headers.get('location') };
}
// fetch will not set Host, so ask Node's http client directly for the website's own address
function onHost(path, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path, headers: { host, accept: 'text/html' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t, type: res.headers['content-type'] || '', location: res.headers.location, robots: res.headers['x-robots-tag'] }));
    }).on('error', reject);
  });
}
const api = async (method, path, body, key) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
};

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  require('../src/lib/mailer').settings.apiBase = process.env.POSTMARK_API_BASE;
  const { createApp } = require('../src/app');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stub.close(r)); await pool.end(); });

test('every page is at /site, with its links kept under /site', async () => {
  assert.equal((await get('/site')).status, 301);
  for (const p of ['/site/', '/site/product', '/site/ski-patrol', '/site/lift-ticket-software', '/site/ski-school-software', '/site/ski-rental-software', '/site/ski-waiver-software', '/site/lift-maintenance-software', '/site/ski-area-pos', '/site/online-lift-ticket-sales', '/site/terrain-park-software', '/site/attraction-ticketing-software', '/site/ski-area-staff-scheduling', '/site/pricing', '/site/security', '/site/contact', '/site/privacy', '/site/terms']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.type, /text\/html/);
    assert.ok(!r.text.includes('{{') && !r.text.includes('<!--HEADER') && !r.text.includes('<!--FOOTER') && !r.text.includes('<!--HEAD') && !r.text.includes('<!--PLANS'), `${p} has every token filled`);
    assert.equal((r.text.match(/<h1[ >]/g) || []).length, 1, `${p} has one main heading`);
    assert.ok(r.text.includes('href="/site/pricing"'), `${p} links within /site`);
  }
  assert.equal((await get('/site/nope')).status, 404);
  const app = await get('/');
  assert.ok(app.text.includes('/js/main.js'), 'the app keeps / on its own address');
});

test('on the website address, the pages are at the top, with robots, a sitemap and a not-found page', async () => {
  const home = await onHost('/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('Run the whole mountain from one screen.'));
  assert.match(home.text, /<meta name="description" content="Run lifts, ski patrol, tickets, rentals, lessons, staff and your zipline, coaster or tubing hill from one screen\./);
  assert.match(home.text, /<h1[^>]*><span class="kicker">Ski area management software<\/span>/, 'the head search term is in the main heading');
  assert.ok(home.text.includes('href="/pricing"') && home.text.includes('href="/app"') && home.text.includes('href="/try"'));
  assert.ok(home.text.includes('rel="canonical" href="https://www.site.test/"'));
  assert.ok(home.text.includes('<meta name="robots" content="index, follow'));
  assert.ok(home.text.includes('<meta name="google-site-verification" content="g-verify-123">'));
  assert.ok(home.text.includes('og:image" content="https://www.site.test/site/img/share.png"') && home.text.includes('twitter:card'));
  // the bare address and a trailing slash send people to the one address
  const bare = await onHost('/pricing?x=1', 'site.test');
  assert.equal(bare.status, 301); assert.equal(bare.location, 'https://www.site.test/pricing?x=1');
  const slash = await onHost('/pricing/');
  assert.equal(slash.status, 301); assert.equal(slash.location, '/pricing');
  assert.equal((await onHost('/pricing')).status, 200);
  const robots = await onHost('/robots.txt');
  assert.match(robots.text, /Sitemap: https:\/\/www\.site\.test\/sitemap\.xml/);
  assert.match(robots.text, /Disallow: \/platform/);
  const map = await onHost('/sitemap.xml');
  assert.ok(map.text.includes('<loc>https://www.site.test/ski-patrol</loc>') && map.text.includes('<lastmod>'));
  const lost = await onHost('/no-such-page');
  assert.equal(lost.status, 404);
  assert.ok(lost.text.includes('isn\'t on the map'));
  assert.ok((await onHost('/app')).text.includes('/js/main.js'), 'the app is at /app on the website address');
  assert.equal((await onHost('/try')).status, 200, 'the demo page still works there');
  assert.match((await onHost('/app')).robots, /noindex/, 'the app is kept out of search results');
  assert.match(lost.robots, /noindex/);
});

test('search engines get one copy of each page, with structured data from the page itself', async () => {
  // On the app's own address, the /site copies point to the website and are kept out of search results
  const copy = await onHost('/site/pricing', 'app.site.test');
  assert.equal(copy.status, 200);
  assert.match(copy.robots, /noindex/);
  assert.ok(copy.text.includes('rel="canonical" href="https://www.site.test/pricing"'));
  const appRobots = await onHost('/robots.txt', 'app.site.test');
  assert.match(appRobots.text, /Disallow: \/site/); assert.match(appRobots.text, /Disallow: \/platform/);
  assert.match((await onHost('/', 'app.site.test')).robots, /noindex/, 'the sign-in page is not a search result');
  // Structured data: the software with its live prices, breadcrumbs, and the page's own questions
  const page = await onHost('/ski-patrol');
  const ld = JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const types = ld['@graph'].map((g) => g['@type']);
  for (const t of ['Organization', 'WebSite', 'WebPage', 'BreadcrumbList', 'FAQPage']) assert.ok(types.includes(t), t);
  const faq = ld['@graph'].find((g) => g['@type'] === 'FAQPage');
  assert.ok(faq.mainEntity.some((q) => q.name === 'Does it work for a volunteer patrol?'));
  assert.ok(page.text.includes('<title>Ski Patrol Software'));
  const pricing = await onHost('/pricing');
  const app = JSON.parse(pricing.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find((g) => g['@type'] === 'SoftwareApplication');
  assert.ok(app && app.offers.offers.length >= 1 && app.offers.priceCurrency === 'USD');
  assert.match(pricing.text, /<title>Pricing: Ski Area Software from \$[\d,]+\/month/);
});

test('the Pricing page reads the active plans and add-ons set in the console', async () => {
  const code = `site-${suffix}`;
  const made = await api('POST', '/platform/billing/plans', { code, name: `Site Plan ${suffix}`, kind: 'plan', modules: ['sell', 'gate', 'assets'], monthly_cents: 12300, yearly_cents: 120000, blurb: 'For testing' }, KEY);
  assert.equal(made.status, 201);
  const r = await api('GET', '/site/plans');
  assert.equal(r.status, 200);
  const p = r.body.plans.find((x) => x.code === code);
  assert.ok(p, 'a new plan shows straight away');
  assert.equal(p.monthly_cents, 12300);
  assert.deepEqual(p.apps.map((a) => a.label), ['Sell', 'Gate', 'Assets and fleet']);
  assert.equal(r.body.trial_days, 14);
  assert.ok(!('id' in p) && !('stripe_product' in p), 'nothing internal');
  await api('PATCH', `/platform/billing/plans/${made.body.id}`, { active: false }, KEY);
  assert.ok(!(await api('GET', '/site/plans')).body.plans.some((x) => x.code === code), 'a hidden plan leaves the website');
});

test('pages written for each search are linked from every page, in the sitemap, and described for AI assistants', async () => {
  const slugs = ['ski-patrol', 'lift-ticket-software', 'ski-school-software', 'ski-rental-software', 'ski-waiver-software', 'lift-maintenance-software', 'ski-area-pos', 'online-lift-ticket-sales', 'terrain-park-software', 'attraction-ticketing-software', 'ski-area-staff-scheduling'];
  const home = await onHost('/');
  const map = await onHost('/sitemap.xml');
  for (const s of slugs) {
    assert.ok(home.text.includes(`href="/${s}"`), `${s} is linked from the footer`);
    assert.ok(map.text.includes(`<loc>https://www.site.test/${s}</loc>`), `${s} is in the sitemap`);
    const page = await onHost(`/${s}`);
    assert.equal(page.status, 200, s);
    const graph = JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    assert.ok(graph.some((g) => g['@type'] === 'BreadcrumbList') && graph.some((g) => g['@type'] === 'FAQPage'), `${s} has breadcrumbs and questions`);
    assert.ok(page.text.includes('class="mcta"'), `${s} has the phone action bar`);
  }
  assert.ok(!(await onHost('/contact')).text.includes('class="mcta"'), 'the Contact page needs no bar to itself');
  // llms.txt: what Verdynt/OS is, every page, and the live prices, on the website's address only
  const llms = await onHost('/llms.txt');
  assert.equal(llms.status, 200);
  assert.match(llms.type, /text\/plain/);
  assert.match(llms.text, /^# Verdynt\/OS\n\n> /);
  for (const s of slugs) assert.ok(llms.text.includes(`https://www.site.test/${s}`), s);
  assert.match(llms.text, /- Lodge: \$[\d,]+ a month/);
  assert.ok(home.text.includes('rel="alternate" type="text/plain" href="/llms.txt"'));
  assert.ok(!(await onHost('/llms.txt', 'app.site.test')).text.startsWith('# Verdynt/OS'), 'not on the app address');
  // The stylesheet is fetched by version, so browsers keep it for a year and still see a new release at once
  const css = home.text.match(/href="(\/site\/site\.css\?v=[^"]+)"/);
  assert.ok(css, 'versioned stylesheet');
  // and by build and content (2026.11.10 fix), so a new build or any changed file is fetched fresh; kept a year only when stamped
  const A = require('../src/lib/appassets');
  assert.equal(css[1], `/site/site.css?v=${A.SITE_V}`);
  const cssRes = await fetch(`${base}${css[1]}`);
  assert.match(cssRes.headers.get('cache-control'), A.STAMPED ? /max-age=31536000/ : /no-cache/);
  assert.match((await fetch(`${base}/site/site.css`)).headers.get('cache-control'), /no-cache/);
});

test('the live plans are in the page itself, for search engines and people without JavaScript', async () => {
  const d = (await api('GET', '/site/plans')).body;
  const home = await onHost('/');
  const pricing = await onHost('/pricing');
  for (const p of d.plans) {
    const price = `<b>$${Math.round(p.monthly_cents / 100).toLocaleString('en-US')}</b>`;
    assert.ok(home.text.includes(`<h3>${p.name}</h3>`) && home.text.includes(price), `${p.name} on Home`);
    assert.ok(pricing.text.includes(`<h2>${p.name}</h2>`) && pricing.text.includes(price), `${p.name} on Pricing`);
  }
  for (const a of d.addons) assert.ok(home.text.includes(`<span>${a.name}`), a.name);
  // who each plan is for, from the console's own line, so Home and Pricing say the same
  for (const p of d.plans) if (p.blurb) assert.ok(home.text.includes(`<p class="who">${p.blurb}</p>`), `${p.name}: who it is for, on Home`);
  // a few words after the two add-on names that do not explain themselves
  if (d.addons.some((a) => a.code === 'doc-ocr')) assert.match(home.text, /Document text recognition <i>\(scans become searchable\)<\/i>/);
  // A plan that is not a step up from the one before lists its own apps, not "Everything in Resort, plus" and nothing
  const own = d.plans.find((p, i) => i > 0 && !d.plans[i - 1].apps.every((a) => p.apps.some((x) => x.key === a.key)));
  if (own) {
    const card = pricing.text.slice(pricing.text.indexOf(`<h2>${own.name}</h2>`)).split('</ul>')[0];
    assert.ok(!card.includes('Everything in'), `${own.name} stands on its own`);
    // Patrol only is one app, so its card spells out what that app holds for a patrol instead of the app's name
    const expect = own.code === 'patrol-only' ? ['Patient care reports and the report check', 'A free read-only login for the ski area'] : own.apps.map((a) => a.label);
    for (const t of expect) assert.ok(card.includes(`<li>${t}</li>`), t);
  }
});

test('Pricing: pay monthly, yearly or over the season; setup packages; and the no-cut comparison from the live prices', async () => {
  const page = (await onHost('/pricing')).text;
  assert.ok(page.includes('data-interval="season"'), 'a season choice beside monthly and yearly');
  assert.ok(page.includes('id="setup"') && page.includes('kind=setup'), 'setup packages, with a way to ask for one');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(page), 'every token is filled in');
  const d = (await api('GET', '/site/plans')).body;
  const lodge = d.plans.find((x) => x.code === 'lodge'); const shop = d.addons.find((x) => x.code === 'shop');
  if (lodge && shop) assert.ok(page.includes(`$${Math.round((lodge.yearly_cents + shop.yearly_cents) / 100).toLocaleString('en-US')}`), 'the Lodge and Online shop year, from the live prices');
  assert.ok(!page.includes('Why is Patrol'), 'no question about Patrol costing more as an add-on');
  // a mountain open in summer reads which plan runs its attractions, and never that it pays "nothing May to October"
  assert.ok(page.includes("We're open in summer too. Which plan?") && page.includes('Attractions are part of Lifts and trails'), 'the summer question');
  assert.ok(!page.includes('May to October') && page.includes('nothing in the months between'), 'season billing is not described as winter only');
  // the request kind for guided setup goes to Leads
  const r = await api('POST', '/site/contact', { kind: 'setup', name: 'Sam Setup', mountain: 'Setup Hill', email: `setup-${suffix}@example.test` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
});

test('the attractions page: its own search title, questions in the structured data, in the Product menu, llms.txt and the home page', async () => {
  const page = await onHost('/attraction-ticketing-software');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('<title>Zipline, Mountain Coaster and Tubing Software for Ski Areas | Verdynt/OS</title>'));
  const graph = JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const faq = graph.find((g) => g['@type'] === 'FAQPage');
  for (const q of ['Can guests book a time slot online?', 'How does the daily inspection work?', 'Does it work in summer?']) assert.ok(faq.mainEntity.some((x) => x.name === q), q);
  const crumbs = graph.find((g) => g['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
  assert.deepEqual(crumbs, ['Home', 'Attractions and activities']);
  const soft = graph.find((g) => g['@type'] === 'SoftwareApplication');
  assert.match(soft.featureList, /Attractions with daily opening checks/);
  // the Product menu on every page, the home page's day and its questions, and llms.txt
  const home = await onHost('/');
  assert.ok(home.text.includes('<b>Attractions and activities</b>'), 'in the Product menu');
  assert.ok(home.text.includes('The zipline opens on its check.') && home.text.includes('We run a zipline and a tubing hill too. Does it handle those?'));
  assert.ok(home.text.includes('<div class="bt">Attractions</div>') && home.text.includes('Alpine Coaster'), 'on the morning board');
  assert.ok(home.text.indexOf('id="day"') < home.text.indexOf('id="risk"'), 'the day comes before the claims section');
  assert.ok(home.text.includes('Built in Pennsylvania, and support is answered by the people who build it.'));
  assert.ok(!/[\u2014]/.test(home.text + page.text), 'no em dashes');
  const llms = (await onHost('/llms.txt')).text;
  assert.match(llms, /attractions and activities/);
  assert.ok(llms.includes('https://www.site.test/attraction-ticketing-software'));
});

test('the Contact form keeps the request for Leads and emails it, and bots and bad input are turned away', async () => {
  assert.equal((await api('POST', '/site/contact', { name: 'A', mountain: 'B', email: 'not-an-email' })).status, 400);
  mails.length = 0;
  const bot = await api('POST', '/site/contact', { name: 'Bot', mountain: `Bot ${suffix}`, email: 'bot@x.test', website: 'http://spam' });
  assert.equal(bot.status, 201);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM site_leads WHERE mountain = ?', [`Bot ${suffix}`]))[0][0].n, 0, 'the hidden field catches it');
  assert.equal(mails.length, 0);
  const ok = await api('POST', '/site/contact', { kind: 'trial', name: 'Pat Patroller', mountain: `Ridge ${suffix}`, email: 'pat@ridge.test', lifts: '3 to 5', plan_interest: 'Mountain', message: 'Volunteer patrol of 30', founding: true });
  assert.equal(ok.status, 201); assert.equal(ok.body.copy, true);
  const row = (await pool.query('SELECT * FROM site_leads WHERE mountain = ?', [`Ridge ${suffix}`]))[0][0];
  assert.equal(row.kind, 'trial'); assert.equal(row.founding, 1); assert.equal(row.emailed, 1); assert.ok(row.ip_hash && !row.ip_hash.includes('127.0.0.1'));
  assert.equal(mails.length, 2);
  assert.equal(mails[0].To, 'sales@site.test'); assert.equal(mails[0].ReplyTo, 'pat@ridge.test');
  assert.match(mails[0].Subject, /14-day trial request/); assert.match(mails[0].TextBody, /Volunteer patrol of 30/);
  assert.equal(mails[1].To, 'pat@ridge.test');

  // The console's Leads
  const list = await api('GET', '/platform/leads?status=new', null, KEY);
  assert.equal(list.status, 200);
  const lead = list.body.data.find((l) => l.mountain === `Ridge ${suffix}`);
  assert.ok(lead && list.body.new_count >= 1);
  assert.equal((await api('GET', '/platform/leads')).status, 403, 'the console key is needed');
  assert.equal((await api('PATCH', `/platform/leads/${lead.id}`, { status: 'contacted', operator_note: 'Called Tuesday' }, KEY)).status, 200);
  const after = (await api('GET', '/platform/leads?status=contacted', null, KEY)).body.data.find((l) => l.id === lead.id);
  assert.equal(after.operator_note, 'Called Tuesday');
});

test('the guides are articles in a Resources section, with three-level breadcrumbs, and the company profile is linked', async () => {
  const guides = ['chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'ski-area-incident-report-guide', 'how-to-choose-ski-area-software'];
  const hub = await onHost('/resources');
  assert.equal(hub.status, 200);
  const map = await onHost('/sitemap.xml');
  for (const g of guides) {
    assert.ok(hub.text.includes(`href="/${g}"`), `${g} is on the Resources page`);
    assert.ok(map.text.includes(`<loc>https://www.site.test/${g}</loc>`), `${g} is in the sitemap`);
    const page = await onHost(`/${g}`);
    assert.equal(page.status, 200, g);
    const graph = JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    const art = graph.find((x) => x['@type'] === 'Article');
    assert.ok(art && art.headline && art.datePublished && art.author['@id'].endsWith('#org'), `${g} is an article`);
    const crumbs = graph.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name);
    assert.deepEqual(crumbs.slice(0, 2), ['Home', 'Resources']);
    assert.equal(crumbs.length, 3);
    assert.ok(page.text.includes('<meta property="og:type" content="article">'));
    assert.ok(page.text.includes('data-print'), `${g} can be printed`);
  }
  const home = await onHost('/');
  assert.ok(home.text.includes('href="/resources"') && home.text.includes('href="/about"'), 'Resources and About are linked from every page');
  assert.equal((await onHost('/about')).status, 200);
  // The company's LinkedIn page: in the structured data and the footer; anything that is not an https address is ignored.
  const org = JSON.parse(home.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find((x) => x['@type'] === 'Organization');
  assert.deepEqual(org.sameAs, ['https://www.linkedin.com/company/verdynt-test']);
  assert.ok(home.text.includes('href="https://www.linkedin.com/company/verdynt-test" rel="me noopener">LinkedIn</a>'));
  // One address per page
  const upper = await onHost('/Resources');
  assert.equal(upper.status, 301);
  assert.equal(upper.location, '/resources');
  assert.ok((await onHost('/llms.txt')).text.includes('https://www.site.test/chairlift-inspection-checklist'));
  // Cloudflare Web Analytics may run on the website, never in the app
  const csp = await new Promise((resolve) => http.get({ hostname: new URL(base).hostname, port: new URL(base).port, path: '/', headers: { host: 'www.site.test' } }, (r) => { r.resume(); resolve(r.headers['content-security-policy']); }));
  assert.match(csp, /script-src 'self' https:\/\/static\.cloudflareinsights\.com/);
  const appCsp = (await fetch(`${base}/app`)).headers.get('content-security-policy');
  assert.ok(!appCsp.includes('cloudflareinsights'), 'not on the app');
});

test('the sales and support addresses are on every page, the Contact page, in the company details and in security.txt', async () => {
  const home = await onHost('/');
  assert.ok(home.text.includes('href="mailto:hello@runmyresort.com"') && home.text.includes('href="mailto:support@runmyresort.com"'), 'in the footer');
  const contact = await onHost('/contact');
  assert.match(contact.text, /Rather email\?/);
  const org = JSON.parse(home.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'].find((x) => x['@type'] === 'Organization');
  assert.deepEqual(org.contactPoint.map((c) => [c.contactType, c.email]), [['sales', 'hello@runmyresort.com'], ['customer support', 'support@runmyresort.com']]);
  const sec = await get('/.well-known/security.txt');
  assert.match(sec.text, /^Contact: mailto:support@runmyresort\.com$/m);
  assert.match(sec.text, /^Expires: \d{4}-/m);
  const v = await (await fetch(`${base}/version`)).json();
  assert.equal(v.support_email, 'support@runmyresort.com', 'the app’s Help reads the support address from here');
});

test('the privacy page names every outside service, and Security says what the assistant sees', async () => {
  const pv = await get('/site/privacy');
  assert.match(pv.text, /<table class="sub">/, 'the service table is there');
  for (const name of ['Google Cloud', 'Stripe', 'Postmark', 'Twilio', 'Anthropic', 'Cloudflare', 'Open-Meteo', 'OpenStreetMap', 'USGS National Map', 'Have I Been Pwned']) assert.ok(pv.text.includes(`<td>${name}`) || pv.text.includes(`${name}</td>`) || pv.text.includes(name), `${name} is named`);
  assert.ok(pv.text.includes('<td>Anthropic</td>') && pv.text.includes('<td>Twilio</td>'), 'Anthropic and Twilio have rows of their own');
  assert.match(pv.text, /tell mountains before we add one/);
  assert.match(pv.text, /Never patient care records/);
  const sec = await get('/site/security');
  assert.match(sec.text, /It never sees patient care records or patrol reports/);
});
