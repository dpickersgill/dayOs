'use strict';

// The website after the November 2026 policy and brand review: promises only the Terms and Privacy policy should make
// point there, support hours carry no reply time, the location is the state only, the brand colors are tokens, and the
// Good Day scorecard is a public page with a printable copy.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.SITE_CONTACT_LIMIT = '1000';

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
  const { createApp } = require('../src/app');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

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
