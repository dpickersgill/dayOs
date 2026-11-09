'use strict';

// SEO technical fixes (2026.11): the sitemap's lastmod and dateModified from each page's last git change, a share image
// per page, the organization and software structured data, internal links between product pages and guides, printable
// PDFs of the checklists, and the website page a request came from, kept with the lead.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';
process.env.SITE_HOSTS = 'www.site.test,site.test';
process.env.SITE_CONTACT_EMAIL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pool } = require('../src/db');

const root = path.join(__dirname, '..');
const KEY = 'test-bootstrap-key';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
let server; let base;

function onHost(p, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path: p, headers: { host, accept: 'text/html' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, text: buf.toString('utf8'), buf, type: res.headers['content-type'] || '' }); });
    }).on('error', reject);
  });
}
const api = async (method, p, body, key) => {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
};
const graphOf = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
const meta = (html, prop) => (html.match(new RegExp(`<meta (?:property|name)="${prop.replace(/[:]/g, '\\:')}" content="([^"]*)"`)) || [])[1];

test.before(async () => {
  const { createApp } = require('../src/app');
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------- 1. lastmod from git, not the deploy date
const DATES = path.join(root, 'src', 'release', 'page-dates.json');
test('the sitemap and dateModified read src/release/page-dates.json, and fall back to the file date without it', async () => {
  const kept = fs.existsSync(DATES) ? fs.readFileSync(DATES) : null;
  try {
    fs.writeFileSync(DATES, JSON.stringify({ written_at: new Date().toISOString(), pages: { 'ski-patrol': '2026-03-04', 'chairlift-inspection-checklist': '2026-11-01', 'good-day/issue-1': '2026-10-31', product: 'not a date' } }));
    const map = (await onHost('/sitemap.xml')).text;
    assert.match(map, /<loc>https:\/\/www\.site\.test\/ski-patrol<\/loc><lastmod>2026-03-04<\/lastmod>/);
    assert.match(map, /<loc>https:\/\/www\.site\.test\/good-day\/issue-1<\/loc><lastmod>2026-10-31<\/lastmod>/, 'the Good Day issues too');
    const fileDate = fs.statSync(path.join(root, 'src', 'site', 'product.html')).mtime.toISOString().slice(0, 10);
    assert.match(map, new RegExp(`<loc>https://www\\.site\\.test/product</loc><lastmod>${fileDate}</lastmod>`), 'a bad entry falls back to the file date');
    const page = graphOf((await onHost('/ski-patrol')).text).find((g) => g['@type'] === 'WebPage');
    assert.equal(page.dateModified, '2026-03-04');
    const art = graphOf((await onHost('/chairlift-inspection-checklist')).text).find((g) => g['@type'] === 'Article');
    assert.equal(art.dateModified, '2026-11-01');
    fs.rmSync(DATES);
    const without = (await onHost('/sitemap.xml')).text;
    const patrolDate = fs.statSync(path.join(root, 'src', 'site', 'skipatrol.html')).mtime.toISOString().slice(0, 10);
    assert.match(without, new RegExp(`/ski-patrol</loc><lastmod>${patrolDate}</lastmod>`), 'no file: the template date (local copies)');
  } finally {
    if (kept) fs.writeFileSync(DATES, kept); else fs.rmSync(DATES, { force: true });
  }
});

test('scripts/page-dates.js dates every page from git, and the release stamps it and zips it', () => {
  const { build } = require('../scripts/page-dates');
  const { PAGES } = require('../src/routes/site');
  const got = build();
  for (const slug of Object.keys(PAGES)) assert.match(got[slug] || '', /^\d{4}-\d{2}-\d{2}$/, `a date for "${slug}"`);
  assert.ok('good-day/issue-1' in got && 'good-day/scorecard' in got);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'stamp-build.js'), 'utf8'), /require\('\.\/page-dates'\)\.write\(\)/);
  const zip = fs.readFileSync(path.join(root, 'scripts', 'zip-release.sh'), 'utf8');
  assert.match(zip, /echo "src\/release\/page-dates\.json" >> "\$LIST"/);
  assert.match(zip, /node scripts\/page-dates\.js/);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^src\/release\/page-dates\.json$/m);
});

// ---------------------------------------------------------------- 2. a share image per page
const pngSize = (buf) => ({ sig: buf.subarray(0, 8).toString('hex'), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
test('each listed page has its own 1200 x 630 share image, used for og:image and twitter:image; other pages keep share.png', async () => {
  const { SHARE, fileFor } = require('../src/lib/share');
  const { PAGES } = require('../src/routes/site');
  const must = ['', 'product', 'ski-patrol', 'lift-ticket-software', 'ski-school-software', 'ski-rental-software', 'ski-waiver-software', 'lift-maintenance-software',
    'ski-area-pos', 'online-lift-ticket-sales', 'terrain-park-software', 'attraction-ticketing-software', 'ski-area-staff-scheduling', 'ski-area-risk-management', 'pricing',
    'chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'ski-area-incident-report-guide', 'how-to-choose-ski-area-software', 'resources', 'good-day',
    'good-day/scorecard', 'ski-school-pickup-policy', 'lost-child-procedure', 'ski-instructor-pay-scale', 'ski-area-opening-day-checklist',
    'about', 'security', 'contact', 'status', 'privacy', 'terms'];
  for (const slug of must) {
    assert.ok(SHARE[slug], `share words for "${slug}"`);
    const f = path.join(root, 'public', 'site', 'img', 'share', `${fileFor(slug)}.png`);
    assert.ok(fs.existsSync(f), `${f} is there`);
    const png = pngSize(fs.readFileSync(f));
    assert.deepEqual(png, { sig: '89504e470d0a1a0a', w: 1200, h: 630 }, `${slug}: a 1200 x 630 PNG`);
    assert.ok(fs.statSync(f).size < 60_000, `${slug}: kept small`);
    if (!(slug in PAGES)) continue; // the four new guides arrive from another branch
    const html = (await onHost(`/${slug}`)).text;
    const want = `https://www.site.test/site/img/share/${fileFor(slug)}.png`;
    assert.equal(meta(html, 'og:image'), want, `${slug} og:image`);
    assert.equal(meta(html, 'twitter:image'), want, `${slug} twitter:image`);
    assert.match(meta(html, 'og:image:alt'), new RegExp(SHARE[slug].headline.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(graphOf(html).find((g) => g['@type'] === 'WebPage').primaryImageOfPage.url, want);
  }
  // an issue of the Good Day uses the newsletter's image; a page with no words in lib/share.js keeps the site-wide one
  assert.equal(meta((await onHost('/good-day/issue-1')).text, 'og:image'), 'https://www.site.test/site/img/share/good-day.png');
  assert.equal(require('../src/lib/seo').shareImage('no-such-page').path, '/site/img/share.png', 'a page without its own image keeps the site-wide one');
  const img = await onHost('/site/img/share/ski-patrol.png');
  assert.equal(img.status, 200);
  assert.match(img.type, /image\/png/);
});

// ---------------------------------------------------------------- 3 and 4. structured data and the ski school title
test('Organization has foundingDate and areaServed; the software is a BusinessApplication for a web browser; ski school og:title says lessons', async () => {
  const home = graphOf((await onHost('/')).text);
  const org = home.find((g) => g['@type'] === 'Organization');
  assert.equal(org.foundingDate, '2026');
  assert.equal(org.areaServed, 'US');
  for (const slug of ['', 'pricing', 'ski-patrol', 'terrain-park-software']) {
    const sw = graphOf((await onHost(`/${slug}`)).text).find((g) => g['@type'] === 'SoftwareApplication');
    if (!sw) continue; // no plans in this database: no prices to state
    assert.equal(sw.applicationCategory, 'BusinessApplication');
    assert.equal(sw.operatingSystem, 'Web browser');
  }
  const school = (await onHost('/ski-school-software')).text;
  assert.match(meta(school, 'og:title'), /Ski school software for lessons/);
  assert.match(meta(school, 'twitter:title'), /lessons/);
  assert.doesNotMatch(meta(school, 'og:title'), /sessions/);
});

// ---------------------------------------------------------------- 5. internal links
test('product pages link to their guides, Home and Pricing to the buyer\'s guide, and each guide to its product page and related guides', async () => {
  const links = {
    'ski-patrol': ['/ski-area-incident-report-guide'],
    'lift-maintenance-software': ['/chairlift-inspection-checklist', '/ski-area-opening-day-checklist'],
    'terrain-park-software': ['/terrain-park-inspection-checklist'],
    '': ['/how-to-choose-ski-area-software'],
    pricing: ['/how-to-choose-ski-area-software'],
    'chairlift-inspection-checklist': ['/lift-maintenance-software', '/terrain-park-inspection-checklist', '/ski-area-incident-report-guide', '/ski-area-opening-day-checklist'],
    'terrain-park-inspection-checklist': ['/terrain-park-software', '/chairlift-inspection-checklist', '/ski-area-incident-report-guide'],
    'ski-area-incident-report-guide': ['/ski-patrol', '/chairlift-inspection-checklist', '/terrain-park-inspection-checklist'],
    'how-to-choose-ski-area-software': ['/product', '/chairlift-inspection-checklist', '/ski-area-incident-report-guide'],
  };
  for (const [slug, hrefs] of Object.entries(links)) {
    const main = (await onHost(`/${slug}`)).text.match(/<main[^>]*>([\s\S]*?)<\/main>/)[1]; // in the page's own words, not the menus
    for (const h of hrefs) assert.ok(main.includes(`href="${h}"`), `/${slug} links to ${h} in its content`);
  }
});

// ---------------------------------------------------------------- 6. printable PDFs
test('the three checklists have printable PDFs, built by scripts/checklist-pdf.js and linked from each guide', async () => {
  const { GUIDES } = require('../scripts/checklist-pdf');
  const slugs = ['chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'ski-area-incident-report-guide'];
  assert.deepEqual(GUIDES.map((g) => g.slug).filter((s) => slugs.includes(s)), slugs);
  for (const g of GUIDES) assert.ok(fs.existsSync(path.join(root, 'src', 'site', `${g.template}.html`)) && g.sections.length, `${g.slug}: a template and sections`);
  for (const s of slugs) {
    const f = path.join(root, 'public', 'site', `${s}.pdf`);
    assert.ok(fs.existsSync(f), `${s}.pdf is there`);
    assert.equal(fs.readFileSync(f).subarray(0, 5).toString(), '%PDF-');
    assert.ok(fs.statSync(f).size > 20_000 && fs.statSync(f).size < 400_000, `${s}.pdf has the fonts and stays small`);
    const page = (await onHost(`/${s}`)).text;
    assert.match(page, new RegExp(`<a class="btn ghost" href="/site/${s}\\.pdf" download>Download the printable PDF</a>`));
    const pdf = await onHost(`/site/${s}.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.type, /application\/pdf/);
  }
});

// ---------------------------------------------------------------- 7. where a request came from
test('the Contact form and the scorecard keep the website page the visitor came from and the referring domain, and the console shows them', async () => {
  const send = (extra) => api('POST', '/site/contact', { kind: 'walkthrough', name: 'Pat Example', mountain: `Ridge ${suffix}`, email: `pat-${suffix}@example.test`, ...extra });
  assert.equal((await send({ source_page: '/site/ski-patrol?email=pat@example.test#top', source_ref: 'https://www.google.com/search?q=ski+patrol+software' })).status, 201);
  assert.equal((await send({ mountain: `Ridge2 ${suffix}`, source_page: '/', source_ref: 'site.test' })).status, 201);
  assert.equal((await send({ mountain: `Ridge3 ${suffix}`, source_page: '/admin/secret?x=1', source_ref: 'javascript:alert(1)' })).status, 201);
  assert.equal((await send({ mountain: `Ridge4 ${suffix}` })).status, 201, 'nothing sent: still saved');
  const scores = require('../src/lib/scorecard').QUESTIONS.map(() => 1);
  assert.equal((await api('POST', '/site/contact', { kind: 'scorecard', name: 'Pat Example', mountain: `Score ${suffix}`, email: `pat-${suffix}@example.test`, scores, source_page: '/good-day/issue-1', source_ref: 'linkedin.com' })).status, 201);

  const row = async (m) => (await pool.query('SELECT source_page, source_ref FROM site_leads WHERE mountain = ?', [m]))[0][0];
  assert.deepEqual({ ...(await row(`Ridge ${suffix}`)) }, { source_page: '/ski-patrol', source_ref: 'google.com' }, 'the page without its query, the domain alone');
  assert.deepEqual({ ...(await row(`Ridge2 ${suffix}`)) }, { source_page: '/', source_ref: null }, 'Home, and never our own address as the referrer');
  assert.deepEqual({ ...(await row(`Ridge3 ${suffix}`)) }, { source_page: null, source_ref: null }, 'not one of our pages, and not a domain');
  assert.deepEqual({ ...(await row(`Ridge4 ${suffix}`)) }, { source_page: null, source_ref: null });
  assert.deepEqual({ ...(await row(`Score ${suffix}`)) }, { source_page: '/good-day/issue-1', source_ref: 'linkedin.com' });

  const list = await api('GET', '/platform/leads', null, KEY);
  assert.equal(list.status, 200);
  const lead = list.body.data.find((l) => l.mountain === `Ridge ${suffix}`);
  assert.equal(lead.source_page, '/ski-patrol');
  assert.equal(lead.source_ref, 'google.com');
  const patrol = list.body.by_page.find((x) => x.page === '/ski-patrol');
  assert.ok(patrol && patrol.n >= 1, 'walkthrough requests counted by page');

  // The browser side sends it with both forms, and the console's Leads list shows it.
  const js = fs.readFileSync(path.join(root, 'public', 'site', 'site.js'), 'utf8');
  assert.equal((js.match(/website: v\('website'\), \.\.\.source \}/g) || []).length, 2, 'the Contact form and "Email my results" both send it');
  assert.match(js, /sessionStorage/);
  const con = fs.readFileSync(path.join(root, 'public', 'js', 'platform.js'), 'utf8');
  assert.match(con, /head: 'From', cell: \(l\) => h\('span', \{ class: 'small' \}, l\.source_page/);
  assert.match(con, /requests by page, last 12 months/);
  await pool.query('DELETE FROM site_leads WHERE mountain LIKE ?', [`%${suffix}`]);
});

test('leadSource keeps only page addresses and domains', () => {
  const { leadSource } = require('../src/routes/site');
  const req = { get: () => 'app.example.test' };
  assert.deepEqual(leadSource(req, { source_page: 'https://www.site.test/site/pricing?plan=x', source_ref: 'www.bing.com' }), { page: '/pricing', ref: 'bing.com' });
  assert.deepEqual(leadSource(req, { source_page: '/good-day/scorecard/', source_ref: 'https://app.example.test/x' }), { page: '/good-day/scorecard', ref: null });
  assert.deepEqual(leadSource(req, { source_page: 'pat@example.test', source_ref: 'pat@example.test' }), { page: null, ref: null });
});
