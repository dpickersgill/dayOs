'use strict';

// The four guides from the Nov 9 SEO plan (seo/guides): ski school pickup policy, lost child procedure, instructor pay
// scale and opening day checklist. Each is served, in the sitemap and llms.txt, has one H1, Article and FAQPage data,
// 1,200 to 2,000 words, links to its product page and related guides, and a printable PDF that exists.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.SITE_HOSTS = 'www.site.test,site.test';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');

const ROOT = path.join(__dirname, '..');
const GUIDES = {
  'ski-school-pickup-policy': { file: 'guide-pickup', h1: 'Ski school child pickup and release policy', links: ['ski-school-software', 'lost-child-procedure'], template: true },
  'lost-child-procedure': { file: 'guide-lostchild', h1: 'Lost child procedure for ski areas', links: ['ski-patrol', 'ski-school-software', 'ski-school-pickup-policy', 'ski-area-incident-report-guide'], template: true },
  'ski-instructor-pay-scale': { file: 'guide-payscale', h1: 'How to build a ski instructor pay scale', links: ['ski-school-software', 'ski-school-pickup-policy', 'ski-area-opening-day-checklist'] },
  'ski-area-opening-day-checklist': { file: 'guide-openingday', h1: 'Ski area opening day checklist', links: ['lift-maintenance-software', 'terrain-park-software', 'ski-patrol', 'ski-school-software', 'chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'lost-child-procedure'], template: true },
};

let server; let base;
function onHost(p, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path: p, headers: { host, accept: 'text/html' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '' }));
    }).on('error', reject);
  });
}
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const words = (html) => visible(html).split(' ').filter((w) => /[A-Za-z0-9]/.test(w)).length;
const graphOf = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];

test.before(async () => {
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

test('each new guide is served on the website and at /site, with one H1, Article and FAQPage data, and fitting search text', async () => {
  const SEO = require('../src/lib/seo');
  for (const [slug, g] of Object.entries(GUIDES)) {
    const r = await onHost(`/${slug}`);
    assert.equal(r.status, 200, slug);
    assert.equal((await fetch(`${base}/site/${slug}`)).status, 200, `/site/${slug}`);
    assert.ok(!r.text.includes('{{') && !r.text.includes('<!--HEAD-->') && !r.text.includes('<!--FOOTER-->'), `${slug}: every token filled`);
    const h1s = r.text.match(/<h1[ >][\s\S]*?<\/h1>/g) || [];
    assert.equal(h1s.length, 1, `${slug}: one H1`);
    assert.ok(visible(h1s[0]).includes(g.h1), `${slug}: the H1 carries the search phrase`);
    const graph = graphOf(r.text);
    const art = graph.find((x) => x['@type'] === 'Article');
    assert.ok(art && art.headline && art.datePublished === '2026-11-09' && art.author['@id'].endsWith('#org'), `${slug}: Article`);
    const faq = graph.find((x) => x['@type'] === 'FAQPage');
    assert.ok(faq && faq.mainEntity.length >= 5 && faq.mainEntity.length <= 7, `${slug}: 5 to 7 questions`);
    assert.deepEqual(graph.find((x) => x['@type'] === 'BreadcrumbList').itemListElement.map((i) => i.name).slice(0, 2), ['Home', 'Resources']);
    assert.ok(r.text.includes('<meta property="og:type" content="article">'));
    const m = SEO.META[slug];
    assert.ok(m.title.length >= 50 && m.title.length <= 60, `${slug}: title ${m.title.length}`);
    assert.ok(m.description.length >= 140 && m.description.length <= 160, `${slug}: description ${m.description.length}`);
    assert.equal(m.parent, 'resources');
    // headings do not skip a level
    const main = r.text.split('<main')[1];
    const levels = [...main.matchAll(/<h([1-6])[ >]/g)].map((x) => Number(x[1]));
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `${slug}: h${levels[i - 1]} then h${levels[i]}`);
  }
});

test('each new guide runs 1,200 to 2,000 words, links to its product page and related guides, and follows the writing rules', async () => {
  for (const [slug, g] of Object.entries(GUIDES)) {
    const r = await onHost(`/${slug}`);
    const main = r.text.split('<main')[1].split('</main>')[0];
    const n = words(main);
    assert.ok(n >= 1200 && n <= 2000, `${slug}: ${n} words`);
    for (const l of g.links) assert.ok(main.includes(`href="/${l}"`), `${slug} links to /${l}`);
    const text = visible(main);
    assert.ok(!text.includes('—'), `${slug}: no em dashes`);
    assert.ok(!text.includes('$'), `${slug}: no dollar figures`);
    assert.ok(!/\bBRP\b|founder/i.test(text), `${slug}: no names`);
    if (g.template) assert.match(text, /Have your insurer and attorney review (it|this policy|any) ?[a-z ]*before adopting/, `${slug}: the review line`);
  }
  // The pay scale gives no rates; the lost child page leaves law enforcement to the area's own policy.
  const pay = visible((await onHost('/ski-instructor-pay-scale')).text);
  assert.ok(!/\d+(\.\d\d)? (an|per) hour/.test(pay), 'no hourly figures');
  const lost = visible((await onHost('/lost-child-procedure')).text);
  assert.match(lost, /Call local law enforcement as your area's own written policy says, at the time that policy sets\./);
});

test('the new guides are in the sitemap at 0.7, in llms.txt under Guides and checklists, and in the guide list', async () => {
  const { GUIDES: LIST } = require('../src/routes/site');
  const map = (await onHost('/sitemap.xml')).text;
  const llms = (await onHost('/llms.txt')).text;
  const section = llms.slice(llms.indexOf('## Guides and checklists'), llms.indexOf('## The Good Day newsletter'));
  for (const slug of Object.keys(GUIDES)) {
    assert.ok(LIST.includes(slug), `${slug} in GUIDES`);
    assert.match(map, new RegExp(`<loc>https://www\\.site\\.test/${slug}</loc>(<lastmod>[^<]+</lastmod>)?<priority>0\\.7</priority>`), `${slug} in the sitemap`);
    assert.ok(section.includes(`(https://www.site.test/${slug})`), `${slug} in llms.txt`);
    assert.ok(section.includes(`/site/${slug}.pdf`), `${slug} PDF in llms.txt`);
  }
  // the Resources description names the new topics
  assert.match(require('../src/lib/seo').META.resources.description, /ski school pickup policy, a lost child procedure, instructor pay scales, opening day/);
});

test('each new guide links its printable PDF, which is committed, served and built from the page by scripts/guide-pdfs.js', async () => {
  const gen = require('../scripts/guide-pdfs');
  assert.deepEqual(gen.GUIDES.map((g) => g.slug).sort(), Object.keys(GUIDES).sort());
  for (const [slug, g] of Object.entries(GUIDES)) {
    const page = (await onHost(`/${slug}`)).text;
    assert.ok(page.includes(`href="/site/${slug}.pdf" download>Download the printable PDF</a>`), `${slug}: the download link`);
    const file = path.join(ROOT, 'public', 'site', `${slug}.pdf`);
    assert.ok(fs.existsSync(file), `${slug}.pdf is committed`);
    const pdf = await onHost(`/site/${slug}.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.type, /application\/pdf/);
    assert.equal(pdf.body.subarray(0, 5).toString(), '%PDF-');
    // the printable part comes from the page itself, with links as plain text
    const src = fs.readFileSync(path.join(ROOT, 'src', 'site', `${g.file}.html`), 'utf8');
    assert.ok(src.includes('<!--PDF-->') && src.includes('<!--/PDF-->'), `${slug}: marked printable part`);
    const part = gen.printable(gen.GUIDES.find((x) => x.slug === slug));
    assert.ok(part.length > 500 && !/<a |\{\{/.test(part), `${slug}: printable part`);
  }
  // what each PDF holds
  const pick = (slug) => gen.printable(gen.GUIDES.find((x) => x.slug === slug));
  assert.match(pick('ski-school-pickup-policy'), /class="blank/);
  assert.match(pick('lost-child-procedure'), /Lost child drill checklist/);
  assert.equal((pick('ski-instructor-pay-scale').match(/<td><\/td>/g) || []).length > 40, true, 'blank rate cells');
  for (const area of ['Lifts', 'Ski patrol', 'Terrain park', 'Snowmaking and grooming', 'Ticketing and the online shop', 'Rentals', 'Ski school', 'Staff and scheduling', 'Guest communication']) {
    assert.ok(pick('ski-area-opening-day-checklist').includes(`<h3>${area} <span class="own">`), `opening day: ${area}`);
  }
});

// ---------------------------------------------------------------- release 2026.11.14: the three SEO branches together
test('every guide has a PDF built by the one script, linked from its page and on Resources', async () => {
  const { GUIDES: ALL_GUIDES } = require('../src/routes/site');
  const gen = require('../scripts/guide-pdfs');
  assert.deepEqual([...gen.ALL].sort(), [...ALL_GUIDES].sort(), 'scripts/guide-pdfs.js builds a PDF for every guide');
  const resources = (await onHost('/resources')).text;
  for (const slug of ALL_GUIDES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'site', `${slug}.pdf`)), `${slug}.pdf is committed`);
    assert.ok((await onHost(`/${slug}`)).text.includes(`href="/site/${slug}.pdf" download>Download the printable PDF</a>`), `${slug} links its PDF`);
    assert.ok(resources.includes(`<a class="gpdf" href="/site/${slug}.pdf">Printable PDF</a>`), `${slug} PDF on Resources`);
    assert.equal((await onHost(`/site/${slug}.pdf`)).status, 200);
  }
});

test('the older guides link to the new ones, and every new guide has at least 3 links from other pages', async () => {
  const has = async (from, to) => (await onHost(`/${from}`)).text.split('<main')[1].includes(`href="/${to}"`);
  assert.ok(await has('chairlift-inspection-checklist', 'ski-area-opening-day-checklist'));
  assert.ok(await has('ski-area-incident-report-guide', 'lost-child-procedure'));
  assert.ok(await has('how-to-choose-ski-area-software', 'ski-instructor-pay-scale'));
  const { PAGES } = require('../src/routes/site');
  const mains = {};
  for (const slug of Object.keys(PAGES)) mains[slug] = ((await onHost(`/${slug}`)).text.split('<main')[1] || '').split('</main>')[0];
  for (const to of Object.keys(GUIDES)) {
    const from = Object.keys(mains).filter((s) => s !== to && mains[s].includes(`href="/${to}"`));
    assert.ok(from.length >= 3, `${to} is linked from ${from.length} pages: ${from.join(', ')}`);
  }
});

test('every page in the sitemap has a share image of its own, and the new guides use theirs', async () => {
  const { PAGES } = require('../src/routes/site');
  for (const slug of Object.keys(PAGES)) {
    const html = (await onHost(`/${slug}`)).text;
    const img = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
    assert.ok(img && !img.endsWith('/site/img/share.png'), `/${slug} has its own og:image (${img})`);
    assert.equal((await onHost(new URL(img).pathname)).status, 200, `${img} is served`);
  }
  for (const slug of Object.keys(GUIDES)) {
    assert.match((await onHost(`/${slug}`)).text, new RegExp(`og:image" content="https://www\\.site\\.test/site/img/share/${slug}\\.png"`));
  }
});

test('every page in the sitemap has a title of 30 to 65 characters and a description of 100 to 160', async () => {
  const { PAGES } = require('../src/routes/site');
  for (const slug of Object.keys(PAGES)) {
    const html = (await onHost(`/${slug}`)).text;
    const un = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const title = un(html.match(/<title>([^<]*)<\/title>/)[1]);
    const desc = un(html.match(/<meta name="description" content="([^"]*)"/)[1]);
    assert.ok(title.length >= 30 && title.length <= 65, `/${slug} title ${title.length}: ${title}`);
    assert.ok(desc.length >= 100 && desc.length <= 160, `/${slug} description ${desc.length}`);
  }
});
