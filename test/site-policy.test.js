'use strict';

// The website after the November 2026 policy and brand review: promises only the Terms and Privacy policy should make
// point there, support hours carry no reply time, the location is the state only, the brand colors are tokens, and the
// Good Day scorecard is a public page with a printable copy.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';
process.env.SITE_CONTACT_EMAIL = 'sales@site.test';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
process.env.MAIL_FROM = 'hello@site.test';
const http = require('node:http');
const mails = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => { mails.push(JSON.parse(body || '{}')); res.setHeader('content-type', 'application/json'); res.end('{"ErrorCode":0,"MessageID":"m"}'); });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('../src/db');

let server; let base;
const get = async (p) => { const r = await fetch(`${base}${p}`, { headers: { accept: 'text/html' }, redirect: 'manual' }); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') || '' }; };
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test.before(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  process.env.POSTMARK_API_BASE = `http://127.0.0.1:${stub.address().port}`;
  require('../src/lib/mailer').settings.apiBase = process.env.POSTMARK_API_BASE;
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => stub.close(r)); await pool.end(); });

test('policy: promises only the Terms and Privacy policy make now point there', async () => {
  const sec = visible((await get('/site/security')).text);
  for (const gone of ['about 130 days', '60 days to download', 'we hand over a full export', 'patrol keeps working', 'one business day', 'the same day when Verdynt/OS is down', 'We will sign a business associate agreement']) {
    assert.ok(!sec.includes(gone), `security no longer says "${gone}"`);
  }
  assert.ok(sec.includes('How long backup copies are kept is in our Privacy policy.'), 'backup retention points to Privacy');
  assert.ok(sec.includes('Monday to Friday, 8 AM to 6 PM Eastern') && sec.includes('December through March, also weekends and holidays, 7 AM to 5 PM Eastern, by phone to our support team'), 'support hours stay');
  assert.match(sec, /business associate agreement \(BAA\) under HIPAA, ask us before any real patient records go in\. Details are in our Terms and Privacy policy\./);
  const risk = visible((await get('/site/ski-area-risk-management')).text);
  assert.ok(!risk.includes('Yes. We will sign a BAA'), 'the risk FAQ no longer promises a BAA');
  assert.ok(risk.includes('Details are in our Terms and Privacy policy.'));
  const pricing = visible((await get('/site/pricing')).text);
  assert.ok(pricing.includes('download as spreadsheets whenever you want them. Details are in our Terms and Privacy policy.'));
  assert.ok(!pricing.includes('full export') && !pricing.includes('one business day'));
  const about = visible((await get('/site/about')).text);
  assert.ok(!about.includes('leaving never means losing them') && !about.includes('one business day'));
  const status = visible((await get('/site/status')).text);
  assert.ok(!status.includes('at least two days before') && status.includes('Details are in our Terms and Privacy policy.'));
  for (const p of ['/site/', '/site/contact']) assert.ok(!/business day/.test(visible((await get(p)).text)), `${p} makes no reply-time promise`);
});

test('policy: no reply-time promise in the contact thank-you email', () => {
  const src = read('src/routes/site.js');
  assert.ok(!/reply within one business day/.test(src));
});

test('location is the state only, on the page and in structured data', async () => {
  const home = (await get('/site/')).text;
  assert.ok(home.includes(`Verdynt Consulting Group, Pennsylvania.`), 'footer');
  assert.ok(!/Royersford/.test(home), 'no town on Home');
  assert.ok(!/Royersford/.test((await get('/site/about')).text), 'no town on About');
  const ld = JSON.parse(home.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const org = ld['@graph'].find((g) => g['@type'] === 'Organization');
  assert.deepEqual(org.address, { '@type': 'PostalAddress', addressRegion: 'PA', addressCountry: 'US' });
});

test('website text uses US spelling for anonymize', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'src/site')).filter((x) => x.endsWith('.html') && !['terms.html', 'privacy.html'].includes(x))) {
    assert.ok(!/anonymis/i.test(read(`src/site/${f}`)), `${f} spells anonymize the US way`);
  }
  assert.ok(!/hero photo/.test(read('src/site/product.html')), 'Product says a banner photo');
});

test('policy: no reply-time promise in the contact form script', () => {
  assert.ok(!/business day/.test(read('public/site/site.js')));
});

test('brand: gold buttons with slate text, colors as tokens, no Good Day amber or off spruce', async () => {
  const css = read('public/site/site.css');
  assert.match(css, /--gold:#D8B672/i);
  assert.match(css, /--spruce:#2C7A57/i);
  assert.match(css, /\.btn\{[^}]*background:var\(--gold\);color:var\(--on-gold\)!important/);
  assert.match(css, /--on-gold:var\(--slate\)/);
  for (const f of ['public/site/site.css', 'src/lib/goodday.js']) assert.ok(!/#f0a04b|#b45309|#0f3b2e/i.test(read(f)), `${f} has no old Good Day colors`);
  // slate on gold passes 4.5:1
  const L = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  assert.ok((L('#D8B672') + 0.05) / (L('#12303A') + 0.05) >= 4.5);
  const home = (await get('/site/')).text;
  assert.match(home, /<p class="brandline">The good day, designed\.<\/p>\s*<h1 id="h-hero"><span class="kicker">Ski area management software<\/span> Run the whole mountain from one screen\.<\/h1>/);
});

test('Good Day emails: brand colors and Atkinson Hyperlegible for body text', () => {
  const src = read('src/lib/goodday.js');
  assert.match(src, /const FONT = "'Atkinson Hyperlegible',Helvetica,Arial,sans-serif";/);
  assert.match(src, /gold: '#d8b672'/);
});

test('Product leads with patrol and inspections, and describes Lost and found, the kiosk and Find my level', async () => {
  const t = (await get('/site/product')).text;
  const order = ['id="h-new"', 'id="g-patrol"', 'id="g-ops"'].map((x) => t.indexOf(x));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'New this season, then Patrol, then Operations');
  const ops = t.slice(t.indexOf('id="g-ops"'));
  assert.ok(ops.indexOf('<h3>Lifts and trails</h3>') < ops.indexOf('<h3>Sell</h3>'), 'Operations opens with Lifts and trails');
  const news = t.slice(t.indexOf('id="h-new"'), t.indexOf('id="g-patrol"'));
  assert.ok(news.indexOf('Patrol operations') < news.indexOf('Billing you control') && news.indexOf('Attractions') < news.indexOf('Menus by role'));
  for (const w of ['<h3>Lost and found</h3>', '<h3>Find my level</h3>', 'A time clock kiosk on a tablet', 'a banner photo']) assert.ok(t.includes(w), w);
});

test('demo welcome email: Patrol first, the lift hold second, the ticket sale for next season', async () => {
  const src = read('src/lib/demomail.js');
  assert.match(src, /1\. Open Patrol on your phone and start a case[^\n]*\n2\. Put a lift on hold in Mountain status[^\n]*\n3\. For next season: sell a lift ticket in Sell/);
});

test('meta descriptions fit, Status and the scorecard are in llms.txt, headings do not skip', async () => {
  const SEO = require('../src/lib/seo');
  for (const k of ['contact', 'terrain-park-software', 'attraction-ticketing-software', 'good-day/scorecard']) {
    assert.ok(SEO.META[k].description.length <= 160, `${k} description`);
    assert.ok(SEO.META[k].title.length <= 60, `${k} title`);
  }
  assert.equal(SEO.META.contact.description, 'Book a 20-minute walkthrough of Verdynt/OS, start a 14-day free trial, or apply for the Founding Mountain Program.');
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  assert.match(llms, /- \[Status\]\([^)]*\/status\)/);
  assert.match(llms, /- \[The Good Day scorecard\]\([^)]*\/good-day\/scorecard\)/);
  for (const p of ['/site/ski-patrol', '/site/status', '/site/good-day/scorecard', '/site/product']) {
    const main = (await get(p)).text.split('<main')[1];
    const levels = [...main.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `${p}: h${levels[i - 1]} then h${levels[i]}`);
  }
  const css = read('public/site/site.css');
  assert.match(css, /\.form input,\.form select,\.form textarea\{font:inherit\}/);
  assert.match(css, /@media \(max-width:640px\)\{\.sf-mail a,\.crumbs a\{display:inline-flex;align-items:center;min-height:44px\}/);
});

test('scorecard: a public page in the nav, sitemap and structured data, linked from every page, with a printable PDF', async () => {
  const SC = require('../src/lib/scorecard');
  assert.ok(SC.QUESTIONS.length >= 10 && SC.QUESTIONS.length <= 12);
  assert.equal(new Set(SC.QUESTIONS.map((q) => q.area)).size, 7, 'every area has questions');
  const r = await get('/site/good-day/scorecard');
  assert.equal(r.status, 200);
  assert.equal((r.text.match(/<fieldset class="sc-q"/g) || []).length, SC.QUESTIONS.length);
  assert.ok(r.text.includes('href="/site/contact?kind=walkthrough"'), 'links to book a walkthrough');
  assert.ok(r.text.includes('/site/good-day-scorecard.pdf'));
  assert.ok(!r.text.includes('{{') && !r.text.includes('<!--SC:'));
  const ld = JSON.parse(r.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  assert.ok(ld.some((g) => g['@type'] === 'WebApplication' && g.isAccessibleForFree === true));
  assert.ok(ld.some((g) => g['@type'] === 'BreadcrumbList' && g.itemListElement.some((i) => i.name === 'The Good Day')));
  const map = await (await fetch(`${base}/site/sitemap.xml`)).text();
  assert.match(map, /\/good-day\/scorecard<\/loc>/);
  // every page: the footer link; Home, Product, Ski patrol and Pricing: the card too
  for (const p of ['/site/', '/site/about', '/site/security', '/site/good-day/issue-1']) assert.ok((await get(p)).text.includes('href="/site/good-day/scorecard">The Good Day scorecard</a>'), `${p} footer`);
  for (const p of ['/site/', '/site/product', '/site/ski-patrol', '/site/pricing']) assert.ok((await get(p)).text.includes('<aside class="sc-card"'), `${p} card`);
  const nav = (await get('/site/')).text;
  assert.match(nav, /<ul class="sn-sols" aria-label="Resources">.*good-day\/scorecard/);
  const issue = (await get('/site/good-day/issue-1')).text;
  assert.ok(!issue.includes('scorecard is on its way') && issue.includes('href="/site/good-day/scorecard"'));
  const pdf = await fetch(`${base}/site/good-day-scorecard.pdf`);
  assert.equal(pdf.status, 200);
  assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString() === '%PDF-');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/scorecard-pdf.js')), 'the generator is committed');
});

test('scorecard: scoring, and emailing results stores only our words and the numbers', async () => {
  const SC = require('../src/lib/scorecard');
  const all = SC.QUESTIONS.map(() => 2);
  assert.equal(SC.score(all).total, SC.MAX);
  assert.equal(SC.score(all).steps.length, 0);
  const mixed = SC.QUESTIONS.map((_q, i) => i % 3);
  const s = SC.score(mixed);
  assert.equal(s.total, mixed.reduce((a, b) => a + b, 0));
  assert.equal(s.steps[0].score, 0, 'the lowest answers first');
  assert.equal(SC.score([1, 2]), null);
  const post = (body) => fetch(`${base}/api/v1/site/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ kind: 'scorecard', name: 'A', mountain: 'B', email: 'a@b.test', scores: [1, 2] })).status, 400, 'every question answered');
  mails.length = 0;
  const res = await post({ kind: 'scorecard', name: 'Pat <a href=x>', mountain: 'Visit evil.example', email: 'pat@hill.test', scores: mixed, message: 'click http://evil.example' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).copy, true);
  const [[lead]] = await pool.query("SELECT kind, message FROM site_leads WHERE email = 'pat@hill.test' ORDER BY id DESC LIMIT 1");
  assert.equal(lead.kind, 'scorecard');
  assert.ok(lead.message.startsWith(`Your Good Day score: ${s.total} of ${SC.MAX}.`) && !lead.message.includes('evil'));
  const toThem = mails.find((m) => m.To === 'pat@hill.test');
  assert.ok(toThem && toThem.Subject === 'Your Good Day scorecard results');
  assert.ok(toThem.TextBody.includes(`Your Good Day score: ${s.total} of ${SC.MAX}.`));
  assert.ok(!/evil|Pat <|Visit|<a/.test(toThem.TextBody), 'nothing typed reaches their inbox');
});
