'use strict';

// SEO pages (Nov 2026): the ski school, lift ticket, rental and waiver pages were deepened. Each has at least its target
// word count, one H1 whose words the share title repeats, an FAQ with FAQPage data, the Saturday walk-through, and links to
// the related product pages and guides. Resources lists the guides in four groups, with a PDF link only where one exists.
process.env.SITE_HOSTS = 'www.site.test,site.test';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const SEO = require('../src/lib/seo');

let server; let base;
function onHost(p, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path: p, headers: { host, accept: 'text/html' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    }).on('error', reject);
  });
}
test.before(async () => {
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
const words = (html) => plain(html).split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
const mainOf = (html) => html.match(/<main[\s\S]*?<\/main>/)[0];

const PAGES = {
  'ski-school-software': { min: 1800, faq: [6, 8], links: ['/ski-school-pickup-policy', '/lost-child-procedure', '/ski-instructor-pay-scale', '/ski-waiver-software', '/ski-patrol', '/pricing'],
    says: ['age band', 'authorized adults', 'Lost child', 'patrol dispatch call', 'parent or guardian', 'Adaptive lesson intake', 'Live class updates', 'Group programs', 'Take payment', 'PSIA-AASI', 'CSIA', 'CASI', 'Training pay', 'My pay', '0 to 10', 'learn-to-ski ladder', 'Owner reports', 'A Saturday in the ski school'] },
  'lift-ticket-software': { min: 1500, faq: [5, 7], links: ['/online-lift-ticket-sales', '/ski-area-pos', '/ski-school-software', '/ski-rental-software', '/ski-waiver-software', '/how-to-choose-ski-area-software', '/ski-area-opening-day-checklist', '/chairlift-inspection-checklist'] },
  'ski-rental-software': { min: 1500, faq: [5, 7], links: ['/ski-area-pos', '/lift-ticket-software', '/ski-school-software', '/ski-waiver-software', '/how-to-choose-ski-area-software', '/ski-area-opening-day-checklist'] },
  'ski-waiver-software': { min: 1500, faq: [5, 7], links: ['/lift-ticket-software', '/ski-school-software', '/ski-rental-software', '/ski-school-pickup-policy', '/ski-area-incident-report-guide', '/how-to-choose-ski-area-software'] },
};

for (const [slug, want] of Object.entries(PAGES)) {
  test(`${slug}: deep enough, one H1, questions as FAQPage data, and the links it promises`, async () => {
    const page = await onHost(`/${slug}`);
    assert.equal(page.status, 200);
    const main = mainOf(page.text);
    const n = words(main);
    assert.ok(n >= want.min, `${slug} has ${n} words in <main>, wants ${want.min}`);
    const h1s = page.text.match(/<h1[\s>][\s\S]*?<\/h1>/g) || [];
    assert.equal(h1s.length, 1, 'one H1');
    // The share title says what the H1 says.
    const h1 = plain(h1s[0]).replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    assert.equal(SEO.META[slug].og, h1, 'og:title matches the H1');
    const graph = JSON.parse(page.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
    const faq = graph.find((g) => g['@type'] === 'FAQPage');
    assert.ok(faq, 'FAQPage');
    assert.ok(faq.mainEntity.length >= want.faq[0] && faq.mainEntity.length <= want.faq[1], `${faq.mainEntity.length} questions`);
    for (const l of want.links) assert.ok(main.includes(`href="${l}"`), `links to ${l}`);
    assert.ok(/How it works on a busy Saturday|A Saturday in the ski school/.test(main), 'the Saturday walk-through');
    if (slug !== 'ski-school-software') {
      assert.ok(main.includes('What changes when you switch from paper or an older system'), 'the comparison');
      assert.ok(main.includes('<table class="cmp vs"') && main.includes('With Verdynt/OS'), 'as a table');
    }
    for (const s of want.says || []) assert.ok(plain(main).includes(s), `${slug} says "${s}"`);
    assert.ok(!/—/.test(page.text), 'no em dashes');
    const m = SEO.META[slug];
    assert.ok(m.title.length >= 50 && m.title.length <= 60, `title ${m.title.length}`);
    assert.ok(m.description.length >= 140 && m.description.length <= 160, `description ${m.description.length}`);
  });
}

test('ski school: the title and description say lessons', () => {
  assert.match(SEO.META['ski-school-software'].title, /Lessons/);
  assert.match(SEO.META['ski-school-software'].description, /lessons/);
});

test('Resources: the guides in four groups, with a PDF link only where the PDF exists', async () => {
  const page = await onHost('/resources');
  assert.equal(page.status, 200);
  const groups = ['Ski school.', 'Lifts and park.', 'Patrol.', 'Choosing software.'];
  let at = -1;
  for (const g of groups) { const i = page.text.indexOf(`>${g}</h2>`); assert.ok(i > at, `${g} in order`); at = i; }
  const guides = ['ski-school-pickup-policy', 'lost-child-procedure', 'ski-instructor-pay-scale', 'ski-area-opening-day-checklist',
    'chairlift-inspection-checklist', 'terrain-park-inspection-checklist', 'ski-area-incident-report-guide', 'how-to-choose-ski-area-software'];
  for (const g of guides) assert.ok(page.text.includes(`href="/${g}"`), g);
  const dir = path.join(__dirname, '..', 'public', 'site');
  for (const f of [...guides, 'good-day-scorecard']) {
    const has = fs.existsSync(path.join(dir, `${f}.pdf`));
    assert.equal(page.text.includes(`href="/site/${f}.pdf"`), has, `${f}: PDF link ${has ? 'shown' : 'left out'}`);
  }
  assert.ok(!page.text.includes('<!--PDF:'), 'no marker left');
  assert.ok(SEO.META.resources.title.length >= 50 && SEO.META.resources.description.length <= 160);
});

test('llms.txt describes the deeper pages', async () => {
  const t = (await onHost('/llms.txt')).text;
  assert.match(t, /Ski school software\]\([^)]+\): lessons and online lesson booking, class sizes by age band, pickup with authorized adults, lost child calls to patrol/);
  assert.match(t, /Ski rental software\]\([^)]+\): .*stations and the queue board/);
  assert.match(t, /Online ski waivers\]\([^)]+\): .*the register and voids/);
  assert.match(t, /Resources\]\([^)]+\): .*grouped by ski school, lifts and park, patrol, and choosing software/);
});
