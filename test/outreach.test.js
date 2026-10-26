'use strict';

// Prospect outreach: the first email waits for approval, then the follow-ups go on the cadence in the same thread, inside
// the sending hours and under the daily cap, with the postal address and opt-out link in every email. A reply, a bounce,
// "not interested" (the page or a mail app's one-click unsubscribe) or a stage change stops it; not interested and
// bounces are never emailed again. After the fifth email a short update goes every 90 days.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.PLATFORM_RATE_LIMIT = '1000';
process.env.APP_URL = 'https://app.verdynt.test';
process.env.ASSISTANT_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');
const O = require('../src/lib/outreach');
const gmail = require('../src/lib/gmail');

let server; let base;
const KEY = 'test-bootstrap-key';
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
async function api(method, p, body, headers = {}) {
  const res = await fetch(`${base}/api/v1${p}`, { method, headers: { 'content-type': 'application/json', 'x-platform-key': KEY, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

// A mailbox that remembers what it sent, with threads the test can add replies to.
const box = { sent: [], threads: new Map(), n: 0 };
const fake = {
  ready: () => true,
  sender: () => 'dan@verdynt.test',
  async send(msg) {
    box.n += 1;
    const threadId = msg.threadId || `t${box.n}`;
    box.sent.push({ ...msg, threadId });
    if (!box.threads.has(threadId)) box.threads.set(threadId, []);
    box.threads.get(threadId).push({ from: 'dan@verdynt.test', snippet: msg.subject, at: Date.now() });
    return { id: `m${box.n}`, threadId, messageId: `<m${box.n}@verdynt.test>` };
  },
  async thread(id) { return box.threads.get(id) || []; },
};
const last = () => box.sent[box.sent.length - 1];
// Weekday afternoons in New York, all after today.
const at = (iso) => new Date(iso);
const WED = '2026-11-04T19:00:00Z';
const plusDays = (iso, d) => new Date(new Date(iso).getTime() + d * 86400_000 + 60_000);
const seqOf = async (id) => (await pool.query('SELECT * FROM outreach_sequences WHERE id = ?', [id]))[0][0];

let P; const C = {};
test.before(async () => {
  gmail.setTransport(fake);
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await pool.query("UPDATE outreach_sequences SET status = 'stopped', next_at = NULL WHERE status IN ('pending','active','nurture')");
  P = ok(await api('POST', '/platform/prospects', { name: `Outreach Hill ${suffix}`, state: 'VT', town: 'Snowville' })).id;
  for (const [k, name, email] of [['gm', 'Gina Manager', `gina.${suffix}@hill.test`], ['pd', 'Pat Director', `pat.${suffix}@hill.test`], ['mk', 'Mo Market', `mo.${suffix}@hill.test`], ['ops', 'Oz Ops', `oz.${suffix}@hill.test`], ['none', 'No Email', null]]) {
    C[k] = ok(await api('POST', `/platform/prospects/${P}/contacts`, { role: k === 'gm' ? 'general_manager' : 'other', name, email })).id;
  }
});
test.after(async () => { gmail.setTransport(null); await new Promise((r) => server.close(r)); await pool.end(); });

test('settings come first: every email needs a name and a postal address', async () => {
  await O.settings();
  await pool.query('UPDATE outreach_settings SET postal_address = NULL WHERE id = 1');
  const bad = await api('POST', '/platform/outreach/enroll', { contact_ids: [C.gm] });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /postal address/);
  assert.equal((await api('PUT', '/platform/outreach/settings', { sender_name: 'Dan Pickersgill', company_line: 'Verdynt/OS', postal_address: '1', daily_cap: 25, send_from_hour: 9, send_to_hour: 16, timezone: 'America/New_York', offsets: [0, 7, 16, 30, 45], nurture_days: 90, use_ai: true, paused: false })).status, 400);
  assert.equal((await api('PUT', '/platform/outreach/settings', { sender_name: 'Dan Pickersgill', company_line: 'Verdynt/OS', postal_address: '100 Main St, Royersford, PA 19468', daily_cap: 200, send_from_hour: 9, send_to_hour: 16, timezone: 'America/New_York', offsets: [0, 7, 7, 30, 45], nurture_days: 90, use_ai: true, paused: false })).status, 400, 'each step on a later day');
  ok(await api('PUT', '/platform/outreach/settings', { sender_name: 'Dan Pickersgill', company_line: 'Verdynt/OS', postal_address: '100 Main St, Royersford, PA 19468', daily_cap: 200, send_from_hour: 9, send_to_hour: 16, timezone: 'America/New_York', offsets: [0, 7, 16, 30, 45], nurture_days: 90, use_ai: true, paused: false }));
  assert.equal((await api('PUT', '/platform/outreach/templates/2', { subject: 'Hi {firstname}', body: 'A body that is long enough to save.' })).status, 400, 'unknown fields are caught');
});

test('the first email waits for approval, then the follow-ups go on the cadence in the same thread', async () => {
  const r = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: [C.gm, C.none, C.gm] }));
  assert.ok(r.data[0].id, JSON.stringify(r.data)); assert.match(r.data[1].skipped, /no email/); assert.match(r.data[2].skipped, /already/);
  C.gmSeq = r.data[0].id;
  let page = ok(await api('GET', '/platform/outreach'));
  const draft = page.drafts.find((d) => d.sequence_id === C.gmSeq);
  assert.match(draft.body, /^Hi Gina,/);
  assert.equal(draft.drafted_by, 'template');
  assert.deepEqual(await O.runDue({ now: at(WED) }), { sent: 0, failed: 0, stopped: 0, waiting: 0 }, 'nothing goes before approval');

  ok(await api('PATCH', `/platform/outreach/messages/${draft.id}`, { subject: `Hello from Verdynt/OS ${suffix}`, body: `${draft.body}\nP.S. edited.` }));
  ok(await api('POST', `/platform/outreach/messages/${draft.id}/approve`));
  assert.equal((await api('PATCH', `/platform/outreach/messages/${draft.id}`, { subject: 'x again', body: 'too late to edit this one' })).status, 409);

  assert.equal((await O.runDue({ now: at('2026-11-07T19:00:00Z') })).skipped, 'Outside the sending hours', 'not on a Saturday');
  const one = await O.runDue({ now: at(WED) });
  assert.equal(one.sent, 1);
  const first = last();
  assert.equal(first.to, `gina.${suffix}@hill.test`);
  assert.match(first.text, /P\.S\. edited\./);
  assert.match(first.text, /100 Main St, Royersford, PA 19468/, 'the postal address');
  const seq = await seqOf(C.gmSeq);
  assert.ok(first.text.includes(`https://app.verdynt.test/o/${seq.token}`), 'the opt-out link');
  assert.equal(first.unsubscribeUrl, `https://app.verdynt.test/o/${seq.token}`);
  assert.equal(seq.status, 'active'); assert.equal(seq.step, 1);
  const [[pr]] = await pool.query('SELECT stage FROM prospects WHERE id = ?', [P]);
  assert.equal(pr.stage, 'contacted');

  assert.equal((await O.runDue({ now: plusDays(WED, 1) })).sent, 0, 'day 7 has not come');
  assert.equal((await O.runDue({ now: plusDays(WED, 7) })).sent, 1);
  assert.equal(last().threadId, first.threadId, 'the follow-up is a reply in the same thread');
  assert.equal(last().subject, `Re: Hello from Verdynt/OS ${suffix}`);
  assert.equal(last().inReplyTo, '<m' + (box.sent.indexOf(first) + 1) + '@verdynt.test>');

  const detail = ok(await api('GET', `/platform/outreach/sequences/${C.gmSeq}`));
  assert.equal(detail.messages.filter((m) => m.status === 'sent').length, 2);
  assert.deepEqual(detail.upcoming.map((u) => u.step), [3, 4, 5]);
  assert.equal(detail.token, undefined);

  // They reply: it stops, and the prospect moves to In conversation with the reply on its timeline.
  box.threads.get(first.threadId).push({ from: `gina manager <gina.${suffix}@hill.test>`, snippet: 'Sure, call me Tuesday', at: Date.now() });
  const r2 = await O.runDue({ now: plusDays(WED, 16) });
  assert.equal(r2.stopped, 1); assert.equal(r2.sent, 0);
  assert.equal((await seqOf(C.gmSeq)).status, 'replied');
  const p = ok(await api('GET', `/platform/prospects/${P}`));
  assert.equal(p.stage, 'talking');
  assert.ok(p.notes.some((n) => n.body.includes('Sure, call me Tuesday')));
});

test('"not interested" stops it for good, from the page or a mail app', async () => {
  // A new prospect, so the stage of the first one does not stop this.
  const P2 = ok(await api('POST', '/platform/prospects', { name: `Quiet Hill ${suffix}`, state: 'NH' })).id;
  const c = ok(await api('POST', `/platform/prospects/${P2}/contacts`, { role: 'general_manager', name: 'Quinn Quiet', email: `quinn.${suffix}@quiet.test` })).id;
  const id = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: [c] })).data[0].id;
  const draft = ok(await api('GET', '/platform/outreach')).drafts.find((d) => d.sequence_id === id);
  ok(await api('POST', `/platform/outreach/messages/${draft.id}/approve`));
  assert.equal((await O.runDue({ now: plusDays(WED, 21) })).sent, 1);
  const seq = await seqOf(id);
  const page = await fetch(`${base}/o/${seq.token}`);
  assert.equal(page.status, 200);
  assert.equal(ok(await api('GET', `/public/outreach-stop/${seq.token}`)).stopped, false);
  // A mail app's one-click unsubscribe posts to the link itself.
  const oneClick = await fetch(`${base}/o/${seq.token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.status, 200);
  assert.equal((await seqOf(id)).status, 'not_interested');
  assert.equal(ok(await api('GET', `/public/outreach-stop/${seq.token}`)).stopped, true);
  assert.equal((await O.runDue({ now: plusDays(WED, 30) })).sent, 0);
  const again = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: [c] })).data[0];
  assert.match(again.skipped, /asked not to be emailed/);
  const [[p]] = await pool.query('SELECT stage FROM prospects WHERE id = ?', [P2]);
  assert.equal(p.stage, 'lost');
  assert.equal((await api('GET', '/public/outreach-stop/not-a-token')).status, 404);
});

test('a bounce stops it and the address is not used again; a stage change stops it too', async () => {
  const P3 = ok(await api('POST', '/platform/prospects', { name: `Bounce Hill ${suffix}`, state: 'ME' })).id;
  const c1 = ok(await api('POST', `/platform/prospects/${P3}/contacts`, { role: 'general_manager', name: 'Bo Bounce', email: `bo.${suffix}@bounce.test` })).id;
  const c2 = ok(await api('POST', `/platform/prospects/${P3}/contacts`, { role: 'marketing', name: 'Mia Market', email: `mia.${suffix}@bounce.test` })).id;
  const [s1, s2] = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: [c1, c2] })).data.map((x) => x.id);
  const drafts = ok(await api('GET', '/platform/outreach')).drafts;
  ok(await api('POST', `/platform/outreach/messages/${drafts.find((d) => d.sequence_id === s1).id}/approve`));
  assert.equal((await O.runDue({ now: plusDays(WED, 22) })).sent, 1);
  box.threads.get(last().threadId).push({ from: 'mail delivery subsystem <mailer-daemon@googlemail.com>', snippet: 'Address not found', at: Date.now() });
  assert.equal((await O.runDue({ now: plusDays(WED, 23) })).stopped, 1);
  assert.equal((await seqOf(s1)).status, 'bounced');
  assert.equal((await O.isSuppressed(pool, `bo.${suffix}@bounce.test`)), true);
  // The other person's draft is still waiting; moving the prospect to Demo done stops it.
  ok(await api('PATCH', `/platform/prospects/${P3}`, { stage: 'demo' }));
  assert.equal((await seqOf(s2)).status, 'stopped');
  assert.equal(ok(await api('GET', '/platform/outreach')).drafts.some((d) => d.sequence_id === s2), false);
});

test('after the fifth email it becomes a quarterly update, under the daily cap', async () => {
  const P4 = ok(await api('POST', '/platform/prospects', { name: `Long Hill ${suffix}`, state: 'NY' })).id;
  const c = ok(await api('POST', `/platform/prospects/${P4}/contacts`, { role: 'general_manager', name: 'Lee Long', email: `lee.${suffix}@long.test` })).id;
  const id = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: [c] })).data[0].id;
  ok(await api('POST', `/platform/outreach/messages/${ok(await api('GET', '/platform/outreach')).drafts.find((d) => d.sequence_id === id).id}/approve`));
  const start = '2026-12-02T19:00:00Z'; // a Wednesday
  for (const [d, step] of [[0, 1], [7, 2], [16, 3], [30, 4], [45, 5]]) {
    let when = plusDays(start, d);
    while ([0, 6].includes(new Date(when.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay())) when = new Date(when.getTime() + 86400_000);
    assert.equal((await O.runDue({ now: when })).sent, 1, `email ${step}`);
    assert.equal((await seqOf(id)).step, step);
  }
  const s = await seqOf(id);
  assert.equal(s.status, 'nurture');
  const gap = (new Date(s.next_at).getTime() - plusDays(start, 45).getTime()) / 86400_000;
  assert.ok(gap > 85 && gap < 95, `about 90 days (${gap})`);
  const fifth = last();
  let when = new Date(new Date(s.next_at).getTime() + 3600_000);
  while ([0, 6].includes(new Date(when.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay()) || new Date(when.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours() < 9 || new Date(when.toLocaleString('en-US', { timeZone: 'America/New_York' })).getHours() >= 16) when = new Date(when.getTime() + 3600_000);
  assert.equal((await O.runDue({ now: when })).sent, 1);
  assert.equal(last().subject, 'What is new in Verdynt/OS');
  assert.notEqual(last().threadId, fifth.threadId, 'the update starts a new thread');

  // The daily cap: two due at once with a cap of one sends one.
  ok(await api('PUT', '/platform/outreach/settings', { sender_name: 'Dan Pickersgill', company_line: 'Verdynt/OS', postal_address: '100 Main St, Royersford, PA 19468', daily_cap: 1, send_from_hour: 9, send_to_hour: 16, timezone: 'America/New_York', offsets: [0, 7, 16, 30, 45], nurture_days: 90, use_ai: true, paused: false }));
  const P5 = ok(await api('POST', '/platform/prospects', { name: `Cap Hill ${suffix}`, state: 'PA' })).id;
  const ids = [];
  for (const n of ['a', 'b']) ids.push(ok(await api('POST', `/platform/prospects/${P5}/contacts`, { role: 'other', name: `Cap ${n}`, email: `cap${n}.${suffix}@cap.test` })).id);
  const seqs = ok(await api('POST', '/platform/outreach/enroll', { contact_ids: ids })).data.map((x) => x.id);
  for (const d of ok(await api('GET', '/platform/outreach')).drafts.filter((x) => seqs.includes(x.sequence_id))) ok(await api('POST', `/platform/outreach/messages/${d.id}/approve`));
  // A Wednesday of its own, so earlier runs of this test in the same database do not count against the cap.
  const capRun = await O.runDue({ now: new Date(Date.parse('2027-06-02T19:00:00Z') + 7 * 86400_000 * (1 + Math.floor(Math.random() * 2000))) });
  assert.equal(capRun.sent, 1); assert.ok(capRun.waiting >= 1, 'the rest wait for tomorrow');
  ok(await api('PUT', '/platform/outreach/settings', { sender_name: 'Dan Pickersgill', company_line: 'Verdynt/OS', postal_address: '100 Main St, Royersford, PA 19468', daily_cap: 200, send_from_hour: 9, send_to_hour: 16, timezone: 'America/New_York', offsets: [0, 7, 16, 30, 45], nurture_days: 90, use_ai: true, paused: false }));
  for (const sid of seqs) ok(await api('POST', `/platform/outreach/sequences/${sid}/stop`));
});
