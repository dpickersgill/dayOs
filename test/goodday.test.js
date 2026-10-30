'use strict';

// The Good Day (guests round 2, track SITE): the newsletter's pages on the website, sign-up with double opt-in, the
// welcome, unsubscribe (the page and a mail app's one-click), the honeypot, the rate limit, no hint of who is subscribed,
// and sending an issue from the platform console through a stand-in for Postmark (test, then everyone confirmed, once).
const http = require('node:http');
const mails = [];
const stub = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = JSON.parse(body || '{}');
    mails.push(m);
    res.setHeader('content-type', 'application/json');
    if (/^fail-/.test(m.To || '')) { res.statusCode = 422; return res.end('{"ErrorCode":300,"Message":"Invalid email request"}'); }
    return res.end(`{"ErrorCode":0,"MessageID":"pm-${mails.length}"}`);
  });
});
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test';
process.env.MAIL_FROM = 'hello@site.test';
process.env.GOODDAY_SUBSCRIBE_LIMIT = '10';
process.env.SITE_HOSTS = 'www.site.test,site.test'; // links in emails use the website's own address

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');

let server; let base;
const KEY = 'test-bootstrap-key';
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const addr = (who) => `${who}-${run}@mountain.test`;
let ipN = 0;
const nextIp = () => { ipN += 1; return `10.77.${Math.floor(ipN / 250)}.${ipN % 250}`; };

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  return { status: res.status, text: await res.text(), headers: res.headers };
}
function onHost(path, host = 'www.site.test') {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ hostname: u.hostname, port: u.port, path, headers: { host, accept: 'text/html' } }, (res) => {
      let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    }).on('error', reject);
  });
}
async function subscribe(body, ip = nextIp()) {
  const res = await fetch(`${base}/api/v1/site/good-day/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const api = async (method, path, body, key = KEY) => {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-platform-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
};
const mailsTo = (to) => mails.filter((m) => m.To === to);
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 25)); }
}
const tokenIn = (m, kind) => ((m.TextBody || '').match(new RegExp(`good-day/${kind}/([A-Za-z0-9_-]{43})`)) || [])[1];
const row = async (email) => (await pool.query('SELECT * FROM goodday_subscribers WHERE email = ?', [email]))[0][0];

/** Signs someone up and confirms them. Returns their confirmation token. */
async function confirmed(who) {
  const email = addr(who);
  await subscribe({ email, name: `${who} Tester`, role: 'owner_gm', source: 'good-day' });
  const m = await waitFor(() => mailsTo(email)[0]);
  const t = tokenIn(m, 'confirm');
  assert.equal((await get(`/site/good-day/confirm/${t}`)).status, 200);
  await waitFor(() => mailsTo(email).length >= 2);
  return t;
}

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

// ---------------------------------------------------------------- the pages
test('the Good Day home and Issue 1 are pages of the site: its header and footer, its own fonts, no Google Fonts', async () => {
  for (const p of ['/site/good-day', '/site/good-day/issue-1']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes('<header class="sn">') && r.text.includes('<footer class="sf">'), `${p} has the site's header and footer`);
    assert.ok(r.text.includes('/site/site.css'), `${p} uses the site's stylesheet`);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic|IBM Plex/i.test(r.text), `${p} loads no outside fonts`);
    assert.ok(!r.text.includes('data:image/jpeg'), `${p} has no images inlined`);
    assert.ok(!r.text.includes('{{') && !r.text.includes('<!--GD:') && !r.text.includes('<!--HEADER'), `${p} has every token filled`);
    assert.equal((r.text.match(/<h1[ >]/g) || []).length, 1, `${p} has one main heading`);
    assert.ok(r.text.includes('action="/api/v1/site/good-day/subscribe"'), `${p} has the sign-up`);
    assert.ok(r.text.includes('href="/site/good-day"'), `${p} links within /site`);
  }
  const home = await get('/site/good-day');
  assert.ok(home.text.includes('Every issue, newest first') && home.text.includes('href="/site/good-day/issue-1"') && home.text.includes('Can I trust what I&#39;m about to buy?'), 'the archive lists Issue 1 with its question');
  assert.ok(home.text.includes('<time datetime="2026-10-30">October 30, 2026</time>'));
  for (const m of ['Plan', 'Arrive', 'Learn', 'Ride', 'Get help', 'Come back']) assert.ok(home.text.includes(m), m);
  const issue = await get('/site/good-day/issue-1');
  for (const f of ['issue-1-shop-calendar.jpg', 'issue-1-shop-services.jpg', 'issue-1-shop-sold-out.jpg', 'issue-1-ski-school-booking.jpg']) {
    assert.ok(issue.text.includes(`/site/img/good-day/${f}`), f);
    const img = await fetch(`${base}/site/img/good-day/${f}`);
    assert.equal(img.status, 200); assert.match(img.headers.get('content-type'), /image\/jpeg/);
    assert.ok(Number(img.headers.get('content-length') || (await img.arrayBuffer()).byteLength) < 120_000, `${f} is compressed`);
  }
  assert.ok(issue.text.includes('alt="The ticket shop calendar for December with Saturday the 19th selected."'), 'the alt text is kept');
  assert.ok(issue.text.includes('class="gd-moments"') && issue.text.includes('<li class="on" aria-current="step"><b>1</b>Plan</li>'), 'the moments strip with Plan lit');
  assert.ok(issue.text.includes('2026.11.7. Moment 1: Plan.') && issue.text.includes('2026.11.5. Moment 3: Learn.') && issue.text.includes('data-edit="dan"'), 'What shipped holds the real releases, marked for Dan');
  assert.ok(!/To fill in before sending|\[Release version/.test(issue.text), 'no placeholders left');
  assert.ok(!/aria-disabled|Take the scorecard/.test(issue.text), 'the disabled scorecard button is gone');
  assert.ok(issue.text.includes('href="mailto:hello@runmyresort.com?subject='), 'Reply is a mailto');
  const own = await onHost('/good-day/issue-1');
  assert.ok(own.text.includes('"@type":"Article"') && own.text.includes('<meta name="robots" content="index, follow'), 'an indexed article on the website\'s own address');
  assert.ok(!/\u2014/.test(issue.text), 'no em dashes');
});

test('the card is on Resources, Home and About, a sign-up line is in every footer, and the menu, sitemap and llms.txt list it', async () => {
  for (const p of ['/site/resources', '/site/', '/site/about']) {
    const r = await get(p);
    assert.ok(r.text.includes('class="gd-card"'), `${p} has the card`);
  }
  const res = await get('/site/resources');
  assert.ok(res.text.indexOf('class="gd-card"') < res.text.indexOf('h-check'), 'Resources: the newsletter comes first');
  const home = await get('/site/');
  assert.ok(home.text.indexOf('class="gd-card"') < home.text.indexOf('id="h-contact"'), 'Home: above the final call to action');
  const pricing = await get('/site/pricing');
  assert.ok(pricing.text.includes('class="sf-gd"') && pricing.text.includes('data-gd="footer"'), 'the footer sign-up line');
  assert.ok(pricing.text.includes('<a href="/site/good-day"><b>The Good Day</b>'), 'The Good Day in the Resources menu');
  const map = await get('/site/sitemap.xml');
  assert.ok(map.text.includes('https://www.site.test/good-day</loc>') && map.text.includes('https://www.site.test/good-day/issue-1</loc>'));
  const llms = await onHost('/llms.txt');
  assert.ok(llms.text.includes('## The Good Day newsletter') && llms.text.includes('https://www.site.test/good-day/issue-1'));
  const site = await onHost('/good-day/issue-1');
  assert.equal(site.status, 200);
  assert.ok(site.text.includes('rel="canonical" href="https://www.site.test/good-day/issue-1"'));
  assert.equal((await onHost('/good-day/issue-1/')).status, 301);
  assert.equal((await get('/site/good-day/issue-99')).status, 404);
});

// ---------------------------------------------------------------- sign-up
test('sign-up is double opt-in: a confirmation link, then the welcome linking Issue 1, with the consent kept', async () => {
  const email = addr('pat');
  const r = await subscribe({ email: email.toUpperCase(), name: 'Pat Ridge', role: 'patrol', source: 'issue-1' }, '10.1.2.3');
  assert.equal(r.status, 201);
  const m = await waitFor(() => mailsTo(email)[0]);
  assert.ok(m, 'a confirmation email');
  assert.equal(m.Subject, 'Confirm your subscription to The Good Day');
  assert.ok(m.HtmlBody.includes('Yes, subscribe me') && m.TextBody.includes('https://www.site.test/good-day/confirm/'));
  assert.notEqual(m.MessageStream, 'broadcast', 'the confirmation is a one-to-one email, not a broadcast');
  const s = await row(email);
  assert.equal(s.status, 'pending'); assert.equal(s.role, 'patrol'); assert.equal(s.source, 'issue-1'); assert.equal(s.consent_ip, '10.1.2.3');
  assert.match(s.consent_wording, /^One email every other week from Verdynt\/OS\. We send a link to confirm first\. Unsubscribe any time\./);
  assert.ok(s.consent_at);
  // only the token's hash is stored
  const token = tokenIn(m, 'confirm');
  const [[t]] = await pool.query('SELECT token_hash FROM goodday_tokens WHERE subscriber_id = ? AND purpose = \'confirm\'', [s.id]);
  assert.notEqual(t.token_hash, token);
  assert.equal(t.token_hash, require('crypto').createHash('sha256').update(token).digest('hex'));

  const c = await get(`/site/good-day/confirm/${token}`);
  assert.equal(c.status, 200);
  assert.ok(c.text.includes('Welcome to The Good Day') && c.text.includes('p***@mountain.test') && !c.text.includes(email), 'the page masks the address');
  assert.equal(c.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal((await row(email)).status, 'confirmed');
  const w = await waitFor(() => mailsTo(email)[1]);
  assert.equal(w.Subject, 'Welcome to The Good Day');
  assert.equal(w.MessageStream, 'broadcast');
  assert.ok(w.TextBody.includes('https://www.site.test/good-day/issue-1') && w.HtmlBody.includes('Read Issue 1'));
  const lu = (w.Headers || []).find((x) => x.Name === 'List-Unsubscribe');
  assert.match(lu.Value, /^<https:\/\/www\.site\.test\/good-day\/unsubscribe\/[A-Za-z0-9_-]{43}>, <mailto:/);
  assert.ok((w.Headers || []).some((x) => x.Name === 'List-Unsubscribe-Post' && x.Value === 'List-Unsubscribe=One-Click'));
  // the link again: already confirmed, no second welcome
  const again = await get(`/site/good-day/confirm/${token}`);
  assert.ok(again.text.includes('You are already subscribed'));
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(mailsTo(email).length, 2);
  assert.equal((await get('/site/good-day/confirm/not-a-token')).status, 404);
});

test('the answer never says whether an address is subscribed, and a pending address is not emailed again within minutes', async () => {
  const email = addr('lee');
  await confirmed('lee');
  const before = mailsTo(email).length;
  const known = await subscribe({ email });
  const fresh = await subscribe({ email: addr('nobody-yet') });
  assert.deepEqual(known, fresh, 'the same answer for a subscriber and a new address');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mailsTo(email).length, before, 'a confirmed subscriber gets nothing more');
  const pend = addr('pending-twice');
  await subscribe({ email: pend });
  await waitFor(() => mailsTo(pend).length);
  await subscribe({ email: pend });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mailsTo(pend).length, 1, 'no second link within 10 minutes');
  assert.equal((await subscribe({ email: 'not an email' })).status, 400);
});

test('the honeypot looks sent and stores nothing; the plain form posts to the check-your-email page', async () => {
  const email = addr('bot');
  const r = await subscribe({ email, website: 'https://spam.example' });
  assert.equal(r.status, 201);
  await new Promise((x) => setTimeout(x, 100));
  assert.equal(await row(email), undefined);
  assert.equal(mailsTo(email).length, 0);
  const form = await fetch(`${base}/api/v1/site/good-day/subscribe`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': nextIp() }, body: new URLSearchParams({ email: addr('noscript'), source: 'footer' }) });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get('location'), '/site/good-day/check-your-email');
  assert.equal((await row(addr('noscript'))).source, 'footer');
  const page = await get('/site/good-day/check-your-email');
  assert.ok(page.text.includes('Check your email'));
});

test('sign-ups are rate limited per address', async () => {
  const ip = '10.99.99.99';
  for (let i = 0; i < 10; i += 1) assert.equal((await subscribe({ email: addr(`flood${i}`) }, ip)).status, 201);
  const r = await subscribe({ email: addr('flood-last') }, ip);
  assert.equal(r.status, 429);
});

test('unsubscribe: the link shows a button (a link checker cannot unsubscribe), the button and a mail app\'s one click both work', async () => {
  const email = addr('una');
  await confirmed('una');
  const w = mailsTo(email)[1];
  const t = tokenIn(w, 'unsubscribe');
  const page = await get(`/site/good-day/unsubscribe/${t}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Stop getting The Good Day?') && page.text.includes('<form method="post"'));
  assert.equal((await row(email)).status, 'confirmed', 'opening the link changes nothing');
  const done = await fetch(`${base}/site/good-day/unsubscribe/${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(done.status, 200);
  assert.ok((await done.text()).includes('You are unsubscribed'));
  const s = await row(email);
  assert.equal(s.status, 'unsubscribed'); assert.equal(s.unsubscribe_how, 'page');
  // the old confirmation link does not sign them back up
  const conf = tokenIn(mailsTo(email)[0], 'confirm');
  const c = await get(`/site/good-day/confirm/${conf}`);
  assert.ok(c.text.includes('You are already subscribed') || c.text.includes('This address unsubscribed'));
  assert.equal((await row(email)).status, 'unsubscribed');

  const email2 = addr('oneclick');
  await confirmed('oneclick');
  const t2 = tokenIn(mailsTo(email2)[1], 'unsubscribe');
  const oc = await fetch(`${base}/site/good-day/unsubscribe/${t2}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(oc.status, 200);
  assert.equal(await oc.text(), 'Unsubscribed');
  assert.equal((await row(email2)).unsubscribe_how, 'one-click');
  assert.equal((await fetch(`${base}/site/good-day/unsubscribe/${'x'.repeat(43)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status, 404);
  // signing up again after unsubscribing starts over with a new consent and a new link
  await subscribe({ email: email2 });
  await waitFor(() => mailsTo(email2).length >= 3);
  assert.equal((await row(email2)).status, 'pending');
});

// ---------------------------------------------------------------- sending from the console
test('the console\'s newsletter routes are for operators only', async () => {
  for (const [m, p] of [['GET', '/platform/goodday'], ['GET', '/platform/goodday/subscribers'], ['GET', '/platform/goodday/subscribers.csv'], ['POST', '/platform/goodday/send'], ['POST', '/platform/goodday/test'], ['PUT', '/platform/goodday/settings']]) {
    assert.equal((await api(m, p, m === 'GET' ? undefined : {}, null)).status, 403, `${m} ${p} without a key`);
    assert.equal((await api(m, p, m === 'GET' ? undefined : {}, 'wrong-key')).status, 403, `${m} ${p} with a wrong key`);
  }
});

test('send an issue: preview, a test, then every confirmed subscriber once; pending and unsubscribed never get it', async () => {
  const a = addr('send-a'); const b = addr('send-b'); const fail = `fail-${run}@mountain.test`;
  await confirmed('send-a'); await confirmed('send-b');
  // an address the stand-in Postmark refuses
  await subscribe({ email: fail }); const ft = tokenIn(await waitFor(() => mailsTo(fail)[0]), 'confirm'); await get(`/site/good-day/confirm/${ft}`);
  const pending = addr('send-pending'); await subscribe({ email: pending }); await waitFor(() => mailsTo(pending).length);
  const gone = addr('send-gone'); await confirmed('send-gone');
  await fetch(`${base}/site/good-day/unsubscribe/${tokenIn(mailsTo(gone)[1], 'unsubscribe')}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });

  const home = await api('GET', '/platform/goodday');
  assert.equal(home.status, 200);
  assert.ok(home.body.counts.confirmed >= 3 && home.body.issues[0].n === 1);
  assert.equal(home.body.issues[0].default_subject, 'The Good Day, Issue 1: Can I trust what I\'m about to buy?');

  // no postal address yet: the send refuses (CAN-SPAM)
  await pool.query('UPDATE goodday_settings SET postal_address = NULL WHERE id = 1');
  const noAddr = await api('POST', '/platform/goodday/send', { n: 1, confirm: 'issue-1' });
  assert.equal(noAddr.status, 400); assert.match(noAddr.body.error, /postal address/);
  assert.equal((await api('PUT', '/platform/goodday/settings', { from_name: 'Dan at The Good Day', postal_address: 'PO Box 12, Royersford, PA 19468' })).status, 200);

  const pv = await api('POST', '/platform/goodday/preview', { n: 1, intro: 'First one. Tell me what you think.' });
  assert.equal(pv.status, 200);
  assert.ok(pv.body.html.includes('CAN I TRUST') || pv.body.html.includes('Can I trust what I&#39;m about to buy?'));
  assert.ok(pv.body.html.includes('First one. Tell me what you think.') && pv.body.html.includes('Read Issue 1') && pv.body.html.includes('PO Box 12'));
  assert.ok(pv.body.text.includes('Read Issue 1: ') && pv.body.text.includes('Unsubscribe: '));
  assert.ok(!/\u2014/.test(pv.body.html + pv.body.text), 'no em dashes in the email');

  const me = addr('operator');
  assert.equal((await api('POST', '/platform/goodday/test', { n: 1, to: me })).status, 200);
  const tm = await waitFor(() => mailsTo(me)[0]);
  assert.match(tm.Subject, /^\[Test\] The Good Day, Issue 1/);
  assert.equal(tm.MessageStream, 'broadcast');

  assert.equal((await api('POST', '/platform/goodday/send', { n: 1, confirm: 'yes' })).status, 400, 'the second check: type issue-1');
  const before = mails.length;
  const out = await api('POST', '/platform/goodday/send', { n: 1, subject: 'The Good Day #1', intro: 'Hello.', confirm: 'issue-1' });
  assert.equal(out.status, 200);
  assert.ok(out.body.sent >= 2 && out.body.failed >= 1);
  const sent = mails.slice(before);
  for (const x of [a, b]) {
    const got = sent.filter((m) => m.To === x);
    assert.equal(got.length, 1, `${x} gets it once`);
    assert.equal(got[0].Subject, 'The Good Day #1');
    assert.equal(got[0].MessageStream, 'broadcast');
    assert.equal(got[0].From, 'Dan at The Good Day <hello@site.test>');
    assert.ok(got[0].Headers.some((h) => h.Name === 'List-Unsubscribe') && got[0].TextBody.includes('/good-day/unsubscribe/') && got[0].HtmlBody.includes('Unsubscribe</a>'));
    assert.ok(got[0].TextBody.includes('PO Box 12, Royersford, PA 19468'));
  }
  assert.equal(sent.filter((m) => m.To === pending || m.To === gone).length, 0, 'pending and unsubscribed are never sent');
  const [[fd]] = await pool.query("SELECT d.status, d.error FROM goodday_deliveries d JOIN goodday_subscribers s ON s.id = d.subscriber_id WHERE s.email = ? AND d.issue_no = 1", [fail]);
  assert.equal(fd.status, 'failed'); assert.ok(fd.error);

  // Send again: only the failed one is tried again; nobody who got it gets it twice
  const before2 = mails.length;
  const again = await api('POST', '/platform/goodday/send', { n: 1, confirm: 'issue-1' });
  assert.equal(again.status, 200);
  assert.equal(again.body.sent, 0);
  const second = mails.slice(before2);
  assert.ok(second.every((m) => m.To === fail || /^fail-/.test(m.To)), 'only failed addresses are tried again');
  const [[cnt]] = await pool.query("SELECT COUNT(*) AS n FROM goodday_deliveries d JOIN goodday_subscribers s ON s.id = d.subscriber_id WHERE s.email IN (?, ?) AND d.issue_no = 1 AND d.status = 'sent'", [a, b]);
  assert.equal(Number(cnt.n), 2);

  // two presses at once never double
  const c = addr('send-c'); await confirmed('send-c');
  const before3 = mails.length;
  await Promise.all([api('POST', '/platform/goodday/send', { n: 1, confirm: 'issue-1' }), api('POST', '/platform/goodday/send', { n: 1, confirm: 'issue-1' })]);
  assert.equal(mails.slice(before3).filter((m) => m.To === c).length, 1, 'one copy even with two sends at once');

  // the issue's unsubscribe link works
  const mine = sent.find((m) => m.To === a);
  const ut = tokenIn(mine, 'unsubscribe');
  await fetch(`${base}/site/good-day/unsubscribe/${ut}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal((await row(a)).status, 'unsubscribed');

  const st = (await api('GET', '/platform/goodday')).body.issues[0];
  assert.ok(st.sent >= 3 && st.history.length >= 2);
});

test('subscribers: the list by status and the spreadsheet with the consent', async () => {
  const email = addr('csv');
  await confirmed('csv');
  const list = await api('GET', '/platform/goodday/subscribers?status=confirmed&q=csv-');
  assert.ok(list.body.data.some((s) => s.email === email));
  assert.ok(!(await api('GET', `/platform/goodday/subscribers?status=pending&q=${encodeURIComponent(email)}`)).body.data.length);
  const res = await fetch(`${base}/api/v1/platform/goodday/subscribers.csv?status=confirmed`, { headers: { 'x-platform-key': KEY } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.ok(csv.startsWith('email,name,role,status,signed_up_on,consent_at_utc,consent_wording,consent_ip'));
  const line = csv.split('\r\n').find((l) => l.startsWith(`"${email}"`));
  assert.ok(line && line.includes('Owner or GM') && line.includes('confirmed') && line.includes('One email every other week'));
});
