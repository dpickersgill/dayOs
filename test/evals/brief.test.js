'use strict';

// Evaluations for the morning brief (ai/brief): 8 realistic mountain days, run through the real data assembly and a fake
// model. The checks are about what we control: the input is limited to the role, patrol data is counts by area only,
// the facts guard falls back to the template on a number that is not in the facts (and with no key, or at the cap),
// nobody is sent the same day's brief twice, and 6:00 AM is the mountain's own 6:00 AM.
// scripts/ai-evals-brief.js runs the same fixtures against the real model when ASSISTANT_API_KEY is set.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.POSTMARK_SERVER_TOKEN = 'pm-test-token';
process.env.MAIL_FROM = 'noreply@test.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const config = require('../../src/config');
const mailer = require('../../src/lib/mailer');
const push = require('../../src/lib/push');
const { createApp } = require('../../src/app');
const { pool } = require('../../src/db');
const modules = require('../../src/lib/modules');
const B = require('../../src/lib/brief');
const D = require('../../src/lib/briefdata');
const W = require('../../src/lib/briefwrite');
const F = require('./brief-fixtures');

let server; let base; let fake;
const calls = []; const mail = []; const pushes = [];
let replies = [];
const wx = new Map(); // latitude -> daily weather the fake forecast answers with

const DEVICE = 'test-device-0123456789abcdef';
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'x-device': DEVICE, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}
const ok = (r) => { assert.ok(r.status < 300, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const reply = (t) => ({ stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] });
const on = () => { config.assistant = { on: true, key: 'sk-brief', apiBase: `http://127.0.0.1:${fake.address().port}`, model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' }; };
const off = () => { config.assistant = { on: false, key: '', apiBase: '', model: 'claude-haiku-5-5', dataModel: 'claude-sonnet-5-5' }; };
/** A model reply that only repeats numbers from the facts: what a good brief looks like. */
const goodReply = (data) => {
  const t = W.template(data);
  return reply({ summary: t.summary, sections: t.sections.slice(0, 4), actions: t.actions });
};

test.before(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/forecast')) {
        const q = new URL(req.url, 'http://x').searchParams;
        const w = wx.get(Number(q.get('latitude')).toFixed(3));
        const day = q.get('start_date');
        if (!w) return res.end(JSON.stringify({ daily: { time: [] } }));
        return res.end(JSON.stringify({ daily: { time: [day], temperature_2m_max: [w.high], temperature_2m_min: [w.low], snowfall_sum: [w.snow], precipitation_sum: [w.precip], wind_speed_10m_max: [w.wind], wind_gusts_10m_max: [w.gust], weather_code: [w.code] } }));
      }
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/email') { mail.push(body); return res.end(JSON.stringify({ ErrorCode: 0, MessageID: `m${mail.length}` })); }
      calls.push(body);
      const next = replies.length ? replies.shift() : reply('{}');
      return res.end(JSON.stringify(typeof next === 'function' ? next(body) : next));
    });
  });
  await new Promise((r) => { fake.listen(0, r); });
  mailer.settings.apiBase = `http://127.0.0.1:${fake.address().port}`;
  process.env.WEATHER = 'on';
  process.env.WEATHER_URL = `http://127.0.0.1:${fake.address().port}`;
  push.setTransport(async (endpoint, init) => { pushes.push({ endpoint, init }); return { status: 201 }; });
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  F.setup({ pool, base, api, ok, wx, modules });
});
test.after(async () => {
  process.env.WEATHER = 'off';
  await new Promise((r) => server.close(r));
  await new Promise((r) => fake.close(r));
  await pool.end();
});

const run = (m, kind, opts = {}) => F.brief(m, kind, opts);

// ---------------------------------------------------------------- the 8 fixtures
test('powder Saturday: snow and the crew report reach the brief, the AI brief is kept when every number checks out', async () => {
  on();
  const m = await F.powderSaturday();
  const data = await F.facts(m, 'ops');
  assert.equal(data.weekday, 'Saturday');
  assert.equal(data.weather.snow_in, 14);
  assert.equal(data.weather.sky, 'Snow');
  assert.deepEqual(data.weather.crew_snow_report, { new_snow_in: 12, base_in: 40 });
  assert.equal(data.visitors.presold_tickets, 320);
  assert.equal(data.visitors.expected_visits, 900, 'average of the last 4 open Saturdays: 800, 850, 950, 1000');
  assert.match(data.visitors.expected_basis, /Simple estimate: the average of the last 4 open Saturdays/);
  replies = [goodReply(data)];
  const b = await run(m, 'ops');
  assert.equal(b.source, 'ai');
  assert.equal(b.label, 'Drafted by the assistant');
  assert.equal(b.body.summary.length, 3);
  assert.ok(b.body.actions.length <= 3);
  for (const a of b.body.actions) assert.match(a.href, /^#\//);
  const sent = calls.at(-1);
  assert.equal(sent.model, 'claude-haiku-5-5', 'the small model');
  const [[log]] = await pool.query("SELECT * FROM assistant_log WHERE tenant_id = ? AND page = 'brief' ORDER BY id DESC LIMIT 1", [m.id]);
  assert.equal(Number(log.cost_micros), 500, '3000 x $0.10 + 400 x $0.50 per million: the cost is logged against the cap');
  assert.equal(log.answer, null, 'the log keeps the cost, not the brief');
});

test('wind day: a lift over its wind hold limit is named, a lift without a limit is reported as not set', async () => {
  on();
  const m = await F.windDay();
  const data = await F.facts(m, 'ops');
  assert.deepEqual(data.wind_holds.lifts_over_limit, [{ lift: 'Summit Quad', limit_mph: 45, gust_mph: 58 }]);
  assert.deepEqual(data.wind_holds.lifts_near_limit, []);
  assert.equal(data.wind_holds.limits_set, 2);
  assert.equal(data.wind_holds.limits_not_set, 1);
  const t = W.template(data);
  assert.match(t.summary[2], /1 lift over the wind hold limit/);
  assert.ok(t.actions.some((a) => /wind holds on Summit Quad/.test(a.text) && a.href === '#/conditions'));
  assert.ok(t.sections.find((s) => s.title === 'Weather and wind').lines.some((l) => /1 lift has no wind hold limit set/.test(l)));
  replies = [goodReply(data)];
  assert.equal((await run(m, 'ops')).source, 'ai');
});

test('rain: a number the facts do not hold sends the brief to the template (the facts guard)', async () => {
  on();
  const m = await F.rainDay();
  const data = await F.facts(m, 'ops');
  assert.equal(data.weather.sky, 'Rain');
  assert.equal(data.weather.precip_in, 0.6);
  const good = W.template(data);
  replies = [reply({ summary: [good.summary[0], 'Expect about 40% fewer visitors than usual.', good.summary[2]], sections: good.sections, actions: good.actions })];
  const b = await run(m, 'ops');
  assert.equal(b.source, 'template');
  assert.equal(b.label, 'Filled in from today\u2019s records');
  const [[row]] = await pool.query('SELECT fallback_reason, cost_micros FROM morning_briefs WHERE id = ?', [b.id]);
  assert.equal(row.fallback_reason, 'facts');
  assert.ok(Number(row.cost_micros) > 0, 'the call still cost money and is still logged');
  assert.deepEqual(W.unknownNumbers({ summary: ['Up 40%'], sections: [], actions: [] }, data), [40]);
  // A reply that is not the JSON asked for also falls back, and an action to a screen the role cannot open is dropped.
  replies = [reply('Here is your brief: it will rain.')];
  assert.equal((await F.writeOnly(m, data)).reason, 'bad_reply');
  replies = [reply({ ...good, actions: [{ text: 'Open payroll', href: '#/settings/billing' }, ...good.actions] })];
  const w = await F.writeOnly(m, data);
  assert.ok(!w.body.actions.some((a) => a.href === '#/settings/billing'));
});

test('slow Tuesday: with no AI key the brief is the template, never an error', async () => {
  off();
  const before = calls.length;
  const m = await F.slowTuesday();
  const b = await run(m, 'ops');
  assert.equal(calls.length, before, 'no model call');
  assert.equal(b.source, 'template');
  const [[row]] = await pool.query('SELECT fallback_reason FROM morning_briefs WHERE id = ?', [b.id]);
  assert.equal(row.fallback_reason, 'no_key');
  assert.equal(b.body.summary.length, 3);
  assert.match(b.body.summary[1], /12 tickets sold ahead/);
  assert.deepEqual(W.unknownNumbers(b.body, JSON.parse((await pool.query('SELECT data FROM morning_briefs WHERE id = ?', [b.id]))[0][0].data)), [], 'the template passes its own facts guard');
  // At the monthly cap: the template too, and no call.
  on();
  await pool.query('INSERT INTO assistant_settings (tenant_id, staff_on, guest_pages, monthly_cap_cents) VALUES (?, 1, \'\', 0) ON DUPLICATE KEY UPDATE monthly_cap_cents = 0', [m.id]);
  const w = await F.writeOnly(m, await F.facts(m, 'ops'));
  assert.equal(w.reason, 'cap');
  assert.equal(calls.length, before);
});

test('opening day: the brief goes the day before, at 6:00 AM in the mountain\'s own time zone', async () => {
  off();
  const m = await F.openingDay(); // America/Denver, first open day 2026-12-05, nothing open in the 14 days before
  const at = (iso) => B.dueDay(pool, { id: m.id, timezone: 'America/Denver' }, new Date(iso));
  assert.equal(await at('2026-12-04T12:59:00Z'), null, '5:59 AM in Denver: not yet');
  const d = await at('2026-12-04T13:00:00Z');
  assert.deepEqual([d.sentOn, d.forDate, d.opening_tomorrow], ['2026-12-04', '2026-12-05', true]);
  assert.equal(await at('2026-12-04T19:00:00Z'), null, 'noon: too late for a morning brief');
  assert.equal(await at('2026-12-03T13:00:00Z'), null, 'two days before: nothing');
  const day = await at('2026-12-05T13:30:00Z');
  assert.deepEqual([day.forDate, day.opening_day], ['2026-12-05', true]);
  assert.equal(await at('2026-12-06T13:30:00Z'), null, 'a closed day after opening: nothing');
  // The same moment is 8:00 AM in New York: the mountain's own clock decides, not the server's.
  assert.equal(B.localNow('America/New_York', new Date('2026-12-04T10:59:00Z')).hm, '05:59');
  assert.equal(B.localNow('America/Denver', new Date('2026-12-04T13:00:00Z')).hm, '06:00');
  const r = await B.runDue({ now: new Date('2026-12-04T13:05:00Z'), only: m.id });
  assert.equal(r.sent, 1);
  const [[brief]] = await pool.query('SELECT for_date, sent_on, data FROM morning_briefs WHERE tenant_id = ?', [m.id]);
  assert.equal(String(brief.for_date), '2026-12-05');
  assert.equal(JSON.parse(brief.data).day_before_opening, true);
  const email = mail.filter((x) => x.To === m.ownerEmail).at(-1);
  assert.match(email.Subject, /Morning brief for Saturday, December 5/);
  assert.match(email.TextBody, /Opening day is tomorrow/);
});

test('understaffed school: lessons without instructors and a class over its age band ratio, in a school brief that holds nothing else', async () => {
  on();
  const m = await F.understaffedSchool();
  const data = await F.facts(m, 'school');
  assert.equal(data.lessons.lessons, 3);
  assert.equal(data.lessons.instructors_scheduled, 1);
  assert.equal(data.lessons.lessons_without_instructor, 2);
  assert.deepEqual(data.lessons.classes_over_ratio, [{ lesson: '10:00 AM Kids group', students: 6, limit: 4, band: 'Ages 3 to 4' }]);
  // Role limits: a school brief has the weather, lessons and school shifts only.
  for (const k of ['revenue_yesterday', 'visitors', 'patrol_yesterday', 'lifts', 'park', 'wind_holds']) assert.equal(data[k], undefined, `school brief has no ${k}`);
  assert.deepEqual(data.shifts.by_department.map((x) => x.department), ['Ski school'], 'only the school\'s shifts');
  assert.deepEqual(data.screens.map((s) => s.href), ['#/school', '#/calendar']);
  replies = [goodReply(data)];
  const b = await run(m, 'school');
  assert.equal(b.source, 'ai');
  assert.ok(!JSON.stringify(calls.at(-1)).includes('revenue'), 'nothing about money reaches the model');
});

test('a lift with a failed check: named for operations and patrol, never in the school brief', async () => {
  off();
  const m = await F.failedCheck();
  const ops = await F.facts(m, 'ops');
  assert.deepEqual(ops.lifts.failed_checks, [{ lift: 'Valley Double', check: 'daily', date: '2026-12-15' }]);
  assert.deepEqual(ops.lifts.with_open_work_orders, [{ lift: 'Valley Double', open_work_orders: 1, titles: ['Bullwheel liner worn'] }]);
  const pat = await F.facts(m, 'patrol');
  assert.deepEqual(pat.lifts.failed_checks, ops.lifts.failed_checks);
  for (const k of ['revenue_yesterday', 'visitors', 'lessons']) assert.equal(pat[k], undefined, `patrol brief has no ${k}`);
  assert.ok(!pat.screens.some((s) => ['#/money', '#/shop', '#/workforce'].includes(s.href)));
  const t = W.template(ops);
  assert.match(t.actions[0].text, /Clear the failed check on Valley Double/);
  assert.equal(ops.revenue_yesterday.revenue_dollars, 1250, 'owners and managers see revenue');
});

test('patrol busy day: yesterday\'s cases as counts by area from one query, and nothing else from patrol', async () => {
  on();
  const m = await F.patrolBusyDay();
  const data = await F.facts(m, 'patrol');
  assert.deepEqual(data.patrol_yesterday, { day: '2026-12-19', total: 7, by_area: [{ area: 'Upper Ridge', count: 3 }, { area: 'Summit Quad', count: 2 }, { area: 'Lower Meadow', count: 1 }, { area: 'Other places', count: 1 }] });
  for (const a of data.patrol_yesterday.by_area) assert.deepEqual(Object.keys(a).sort(), ['area', 'count']);
  assert.deepEqual(Object.keys(data.patrol_yesterday).sort(), ['by_area', 'day', 'total']);
  replies = [goodReply(data)];
  const b = await run(m, 'patrol');
  const sent = JSON.stringify(calls.at(-1));
  const stored = JSON.stringify((await pool.query('SELECT data, body FROM morning_briefs WHERE id = ?', [b.id]))[0][0]);
  for (const secret of F.PATROL_SECRETS) {
    assert.ok(!sent.includes(secret), `the model never sees "${secret}"`);
    assert.ok(!stored.includes(secret), `the stored brief never holds "${secret}"`);
    assert.ok(!JSON.stringify(data).includes(secret), `the facts never hold "${secret}"`);
  }
  // The case's free-text place and its time never come through either (only the run's or lift's own name).
  assert.ok(!sent.includes('behind the Zeb cabin'));
  assert.ok(!/T?1[04]:2[27]/.test(JSON.stringify(data.patrol_yesterday)));
  // The query itself: one aggregate over incidents, reading only the run, the lift and the count.
  const src = require('fs').readFileSync(require.resolve('../../src/lib/briefdata'), 'utf8');
  const fn = src.slice(src.indexOf('async function patrolCounts'), src.indexOf('/** Refunds above normal'));
  assert.equal((fn.match(/SELECT/g) || []).length, 1);
  assert.match(fn, /COUNT\(\*\)/);
  assert.match(fn, /GROUP BY area/);
  assert.doesNotMatch(fn, /\bi\.(summary|narrative|person_id|severity|category|seq|location|form|disposition|weather|conditions)\b/);
  assert.doesNotMatch(src, /incident_(patients|injuries|vitals|treatments|events|witnesses)/, 'no patient tables anywhere in the brief');
  // Operations sees the same counts; the school brief none.
  assert.deepEqual((await F.facts(m, 'ops')).patrol_yesterday, data.patrol_yesterday);
  assert.equal((await F.facts(m, 'school')).patrol_yesterday, undefined);
});

// ---------------------------------------------------------------- sending
test('no duplicate sends: runs that repeat or overlap send each person one brief a day, by the channel they chose', async () => {
  off();
  const m = await F.sendingMountain();
  const now = new Date('2026-12-15T11:30:00Z'); // 6:30 AM in New York
  const before = mail.length;
  const [a, b] = await Promise.all([B.runDue({ now, only: m.id }), B.runDue({ now, only: m.id })]);
  const c = await B.runDue({ now: new Date('2026-12-15T14:00:00Z'), only: m.id });
  assert.equal(a.sent + b.sent + c.sent, 4, 'owner, manager, patrol director and school Director (the counter and plain instructor get none)');
  const sentTo = mail.slice(before).map((x) => x.To).sort();
  assert.deepEqual(sentTo, [m.emails.manager, m.emails.owner, m.emails.school].sort(), 'the patrol director chose phone alerts only');
  assert.equal(new Set(sentTo).size, sentTo.length, 'nobody twice');
  const [sends] = await pool.query('SELECT user_id, status, channel, email_ok, phones FROM brief_sends WHERE tenant_id = ? ORDER BY user_id', [m.id]);
  assert.equal(sends.length, 4);
  const pd = sends.find((s) => Number(s.user_id) === m.ids.patrol);
  assert.deepEqual([pd.channel, pd.email_ok, Number(pd.phones), pd.status], ['push', null, 1, 'sent']);
  const alert = pushes.at(-1);
  assert.match(alert.endpoint, /fcm\.googleapis\.com/);
  const [briefs] = await pool.query('SELECT kind FROM morning_briefs WHERE tenant_id = ? ORDER BY kind', [m.id]);
  assert.deepEqual(briefs.map((x) => x.kind), ['ops', 'patrol', 'school'], 'one brief per kind, shared by everyone of that kind');
  // The emails: one page with a plain text part, the label, and links to the brief.
  const mgr = mail.slice(before).find((x) => x.To === m.emails.manager);
  assert.match(mgr.HtmlBody, /Filled in from today\u2019s records/);
  assert.doesNotMatch(mgr.HtmlBody, /Drafted by the assistant/, 'a template brief never says the assistant drafted it');
  assert.match(mgr.TextBody, /Read it in the app: .*#\/brief/);
  assert.equal(mgr.Tag, 'morning-brief');
  // The next day is a new day.
  const d = await B.runDue({ now: new Date('2026-12-16T11:30:00Z'), only: m.id });
  assert.equal(d.sent, 4);
  // Turned off: nothing.
  await pool.query('INSERT INTO brief_prefs (tenant_id, user_id, on_off, channel) VALUES (?, ?, 0, \'both\') ON DUPLICATE KEY UPDATE on_off = 0', [m.id, m.ids.manager]);
  const e = await B.runDue({ now: new Date('2026-12-17T11:30:00Z'), only: m.id });
  assert.equal(e.sent, 3);
});

test('batches: a run stops at its limit and the next run carries on without sending anyone twice', async () => {
  off();
  const m = await F.sendingMountain();
  const now = new Date('2026-12-15T11:30:00Z');
  const first = await B.runDue({ now, only: m.id, maxSends: 2 });
  assert.equal(first.sent, 2);
  assert.equal(first.more, true);
  const second = await B.runDue({ now, only: m.id, maxSends: 2 });
  assert.equal(second.sent, 2);
  const third = await B.runDue({ now, only: m.id });
  assert.equal(third.sent, 0);
});

test('settings: each person turns it on or off and picks the channel; owners and managers choose who gets it; other roles get none', async () => {
  const m = await F.sendingMountain();
  const mine = ok(await api('GET', '/brief/prefs', { token: m.tokens.school }));
  assert.deepEqual([mine.eligible, mine.kind, mine.on, mine.channel], [true, 'school', true, 'both']);
  ok(await api('PUT', '/brief/prefs', { token: m.tokens.school, body: { on: true, channel: 'email' } }));
  assert.equal(ok(await api('GET', '/brief/prefs', { token: m.tokens.school })).channel, 'email');
  assert.equal(ok(await api('GET', '/brief/prefs', { token: m.tokens.counter })).eligible, false);
  assert.equal((await api('PUT', '/brief/prefs', { token: m.tokens.counter, body: { on: true, channel: 'both' } })).status, 403);
  assert.equal((await api('GET', '/brief/people', { token: m.tokens.school })).status, 403);
  const people = ok(await api('GET', '/brief/people', { token: m.tokens.manager })).data;
  const plain = people.find((p) => p.id === m.ids.instructor2);
  assert.deepEqual([plain.kind, plain.on], ['school', false], 'a school supervisor can have it, off by default');
  ok(await api('PUT', `/brief/people/${m.ids.instructor2}`, { token: m.tokens.manager, body: { on: true } }));
  assert.equal(ok(await api('GET', '/brief/people', { token: m.tokens.owner })).data.find((p) => p.id === m.ids.instructor2).on, true);
  assert.equal((await api('PUT', `/brief/people/${m.ids.counter}`, { token: m.tokens.manager, body: { on: true } })).status, 404, 'a counter clerk cannot be given one');
  // The page: today's brief and the ones before, of the person's own kind only.
  const today = B.localNow('America/New_York').date;
  const t = (await pool.query(`SELECT * FROM tenants WHERE id = ?`, [m.id]))[0][0];
  await B.ensure(pool, t, 'school', { sentOn: today, forDate: today, today, hours: null }, new Set(await modules.enabledKeys(m.id)));
  const page = ok(await api('GET', '/brief', { token: m.tokens.school }));
  assert.equal(page.brief.kind, 'school');
  assert.equal(page.brief.label, 'Filled in from today\u2019s records');
  const opsPage = ok(await api('GET', '/brief', { token: m.tokens.owner }));
  assert.ok(!opsPage.brief || opsPage.brief.kind === 'ops');
  assert.equal((await api('GET', `/brief/${page.brief.id}`, { token: m.tokens.owner })).status, 404, 'another kind\'s brief is not shown');
});

test('a lift\'s wind hold limit is set with its type, and old briefs and sends go after 30 days', async () => {
  const m = await F.sendingMountain();
  const [[lift]] = await pool.query('SELECT id FROM lifts WHERE tenant_id = ? LIMIT 1', [m.id]);
  const r = ok(await api('PATCH', `/ops/lifts/${lift.id}/type`, { token: m.tokens.manager, body: { lift_type: null, wind_hold_mph: 50 } }));
  assert.equal(r.wind_hold_mph, 50);
  ok(await api('PATCH', `/ops/lifts/${lift.id}/type`, { token: m.tokens.manager, body: { lift_type: null } }));
  assert.equal((await pool.query('SELECT wind_hold_mph FROM lifts WHERE id = ?', [lift.id]))[0][0].wind_hold_mph, 50, 'left out keeps it');
  await pool.query("INSERT INTO brief_sends (tenant_id, user_id, sent_on, status, created_at) VALUES (?, ?, '2026-01-01', 'sent', UTC_TIMESTAMP() - INTERVAL 31 DAY)", [m.id, m.ids.owner]);
  const p = await B.purge();
  assert.ok(p.sends >= 1);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM brief_sends WHERE tenant_id = ? AND sent_on = '2026-01-01'", [m.id]))[0][0].n, 0);
  const reg = require('../../src/lib/personal').NOT_GUESTS;
  for (const tbl of ['brief_prefs', 'morning_briefs', 'brief_sends']) assert.ok(reg[tbl], `${tbl} is in the personal-data register`);
  assert.match(reg.brief_sends, /30 days/);
});

test('snapshots: read when the table and module exist, otherwise the live queries', async () => {
  const plain = D.dayFromForecast({ hours: [{ time: '2026-12-12T09:00', temp_f: 20, wind_mph: 10, gust_mph: 30, snow_in: 1 }, { time: '2026-12-12T13:00', temp_f: 26, wind_mph: 15, gust_mph: 41, snow_in: 2 }, { time: '2026-12-13T09:00', temp_f: 40, gust_mph: 90 }] }, '2026-12-12');
  assert.deepEqual({ ...plain, wind: undefined }, { high_f: 26, low_f: 20, snow_in: 3, precip_in: null, wind_mph: 15, gust_mph: 41, code: null, wind: undefined });
  assert.equal(D.ticketsFromPresales({ days: [{ date: '2026-12-12', tickets: 210 }] }, '2026-12-12'), 210);
  assert.equal(D.ticketsFromPresales({ '2026-12-12': { tickets: 5 } }, '2026-12-12'), 5);
  // The daily job's own shape (lib/snapshots.js presalesFrom): tickets is { sold, online, by_product }.
  assert.equal(D.ticketsFromPresales({ as_of: '2026-12-12T06:00:00Z', days: [{ date: '2026-12-12', days_ahead: 0, tickets: { sold: 412, online: 300, by_product: {} } }] }, '2026-12-12'), 412);
  D.resetSnapshotCheck();
  assert.equal(await D.hasSnapshots(pool), true, 'ai/data is merged: the table and lib/snapshots.js are here');
});

// ---------------------------------------------------------------- 2026.11.15: snapshots, wind, labels, headings
/** The daily job's forecast snapshot shape: base and summit, hourly, on the mountain's clock. */
function hourlySnap(date, { base, summit }) {
  const hrs = Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);
  const pt = (role, gustAt) => ({ role, lat: 40, lng: -105, elevation_m: role === 'summit' ? 3400 : 2900,
    hourly: { time: hrs, temp_f: hrs.map((_, h) => (role === 'summit' ? 10 : 20) + (h > 12 ? 4 : 0)), precip_in: hrs.map(() => 0), snow_in: hrs.map((_, h) => (h < 6 ? 0.5 : 0)),
      wind_mph: hrs.map((_, h) => Math.round(gustAt(h) / 2)), gust_mph: hrs.map((_, h) => gustAt(h)), weather_code: hrs.map(() => 3) } });
  return { source: 'open-meteo', resolution: 'hourly', hours: 72, timezone: 'America/New_York', units: { temp: 'F', precip: 'in', snow: 'in', wind: 'mph' }, points: [pt('base', base), pt('summit', summit)] };
}

test('snapshots in use: the brief reads the morning forecast (hourly gusts in the operating hours, at base and summit) and the presales', async () => {
  off();
  const S = require('../../src/lib/snapshots');
  const m = await F.mountain('Snapshot Bowl', { day: '2026-12-19' });
  await pool.query("INSERT INTO calendar_days (tenant_id, on_date, status, open_time, close_time) VALUES (?, '2026-12-19', 'open', '09:00:00', '16:00:00')", [m.id]);
  await pool.query("INSERT INTO lifts (tenant_id, name, status, wind_hold_mph) VALUES (?, 'Summit Quad', 'open', 45), (?, 'Valley Double', 'open', 60)", [m.id, m.id]);
  // Gusts of 80 at 3 AM (before opening) must not count; 47 at the summit at 11 AM does; the base stays at 30.
  await S.save(pool, m.id, '2026-12-19', 'forecast', hourlySnap('2026-12-19', { base: () => 30, summit: (h) => (h === 3 ? 80 : h === 11 ? 47 : 35) }));
  await S.save(pool, m.id, '2026-12-19', 'presales', { as_of: '2026-12-19T06:00:00Z', days: [{ date: '2026-12-19', days_ahead: 0, tickets: { sold: 777, online: 500, by_product: {} } }] });
  D.resetSnapshotCheck();
  const data = await F.facts(m, 'ops');
  assert.equal(data.weather.source, 'snapshot');
  assert.equal(data.visitors.presold_tickets, 777, 'tickets sold ahead come from the presales snapshot');
  assert.equal(data.weather.gust_mph, 80, 'the day\'s weather still shows the strongest gust of the day');
  const wh = data.wind_holds;
  assert.deepEqual(wh.lifts_over_limit, [{ lift: 'Summit Quad', limit_mph: 45, gust_mph: 47 }], 'the gust in the operating hours, not the 3 AM one');
  assert.deepEqual(wh.lifts_near_limit, []);
  assert.equal(wh.gusts_from, 'summit point');
  assert.equal(wh.gusts_during, 'from 9:00 AM to 4:00 PM');
  assert.deepEqual(wh.gusts_by_point, [{ point: 'base point', gust_mph: 30 }, { point: 'summit point', gust_mph: 47 }]);
  assert.match(wh.caveat, /forecast at the summit point/);
  // An earlier day's snapshot is never used for today.
  const m2 = await F.mountain('Stale Basin', { day: '2026-12-20' });
  await S.save(pool, m2.id, '2026-12-19', 'presales', { days: [{ date: '2026-12-20', tickets: { sold: 999 } }] });
  const d2 = await F.facts(m2, 'ops');
  assert.equal(d2.visitors.presold_tickets, 0, 'yesterday\'s presales snapshot is not today\'s');
  // The backfill's daily shape reads too (whole day, one point).
  const bf = D.dayFromForecast({ source: 'day_record', points: [{ role: 'map_point', lat: 40, lng: -105, elevation_m: null }], days: [{ date: '2026-12-19', high_f: 30, low_f: 10, snow_in: 2, precip_in: 0.2, wind_mph: 12, gust_mph: 33, weather_code: 71 }] }, '2026-12-19', { open: '09:00', close: '16:00' });
  assert.equal(bf.gust_mph, 33); assert.equal(bf.wind.window, 'all_day');
});

test('wind: every comparison with a lift\'s limit says it is the forecast at a point, an early warning only, and it is in the facts the model gets', async () => {
  on();
  const m = await F.windDay();
  const data = await F.facts(m, 'ops');
  const wh = data.wind_holds;
  assert.equal(wh.caveat, D.windCaveat('map_point'));
  assert.match(wh.caveat, /forecast at the map point/);
  assert.match(wh.caveat, /early warning only, not a reading at the lift/);
  // The template: the line sits in the wind section, right after the comparisons.
  const sec = W.template(data).sections.find((s) => /wind/i.test(s.title));
  const at = sec.lines.findIndex((l) => /wind hold limit\./.test(l) && /Summit Quad/.test(l));
  assert.ok(at >= 0);
  assert.equal(sec.lines[at + 1], wh.caveat);
  // The model gets it in the facts, and the rule to keep it.
  replies = [goodReply(data)];
  const n = calls.length;
  const out = await W.write(data, { tenantId: m.id, kind: 'ops' });
  assert.equal(calls.length, n + 1);
  const sent = calls.at(-1);
  assert.ok(sent.messages[0].content.includes(JSON.stringify(wh.caveat)), 'the caveat is in the facts given to the model');
  assert.match(sent.system, /never say a lift is safe to run/);
  assert.equal(out.source, 'ai');
  // A model brief that drops the line gets it back under its wind section.
  const t = W.template(data);
  const dropped = t.sections.map((s) => ({ ...s, lines: s.lines.filter((l) => l !== wh.caveat) }));
  replies = [reply({ summary: t.summary, sections: dropped, actions: t.actions })];
  const back = await W.write(data, { tenantId: m.id, kind: 'ops' });
  assert.equal(back.source, 'ai');
  assert.ok(back.body.sections.find((s) => /wind/i.test(s.title)).lines.includes(wh.caveat));
  // No comparison, no line: a calm day does not carry it.
  const calm = await F.facts(await F.powderSaturday(), 'ops');
  assert.ok(!W.template(calm).sections.flatMap((s) => s.lines).some((l) => /early warning/.test(l)));
});

// Go-aheads the guard must refuse: the four from the 2026.11.15 review, then four more ways of saying the same thing.
const GO_AHEAD_PHRASES = [
  'Gusts stay under the limit, so every lift should be able to run all day.',
  '{lift} should be good to go.',
  '{lift} looks fine for wind today.',
  'No wind holds expected on {lift} today.',
  '{lift} is okay for wind today.',
  'All the chairs can probably spin through the afternoon.',
  'Wind looks safe for every lift.',
  'Expect no wind holds on {lift} today.',
];
// Lines that warn, plan or report, and are not a go-ahead.
const NOT_GO_AHEAD = [
  'Plan for wind holds on {lift}', '{lift} may not open if gusts build.', 'Clear the failed check on {lift} before loading', 'Check the open lift work orders',
  'Lifts with open work orders can wait until noon.', '1 lift has no wind hold limit set.', 'Open more lesson spots for the waitlist',
  'Wind hold limits are not set for any lift. A manager adds them under Mountain status, Maintenance, Lift inspections, Type.',
];

test('wind: the go-ahead guard refuses each paraphrase, and passes lines that warn or report', () => {
  const lifts = ['Summit Quad', 'Big Bear'];
  for (const lift of lifts) {
    for (const p of GO_AHEAD_PHRASES) assert.ok(W.goAheadIn(p.replace(/\{lift\}/g, lift), lifts), p);
    for (const p of NOT_GO_AHEAD) assert.ok(!W.goAheadIn(p.replace(/\{lift\}/g, lift), lifts), p);
  }
  assert.ok(W.goAheadIn('Big Bear should probably be able to spin by 10.', lifts), 'words between the modal and the verb');
  assert.ok(W.goAheadIn('Wind is light: lifts are clear to spin.', lifts));
});

test('wind: the brief never tells anyone to open a lift or that one is safe to run', async () => {
  on();
  const m = await F.windDay();
  const data = await F.facts(m, 'ops');
  const t = W.template(data);
  for (const bad of [
    { summary: ['Open today.', 'Summit Quad is safe to run.', 'Nothing else.'] },
    { summary: t.summary, actions: [{ text: 'Open Valley Double at 9', href: '#/conditions' }] },
    { summary: t.summary, sections: [{ title: 'Weather and wind', lines: ['Valley Double can run all day.'] }] },
    { summary: t.summary, sections: [{ title: 'Weather and wind', lines: ['Gusts are fine to open the lifts.'] }] },
    // 2026.11.15 review: these passed before.
    ...GO_AHEAD_PHRASES.map((line) => ({ summary: t.summary, sections: [{ title: 'Weather and wind', lines: [line.replace(/\{lift\}/g, W.liftNamesOf(data)[0])] }] })),
  ]) {
    replies = [reply({ sections: [], actions: [], ...bad })];
    const out = await W.write(data, { tenantId: m.id, kind: 'ops' });
    assert.equal(out.source, 'template', JSON.stringify(bad));
    assert.equal(out.reason, 'go_ahead');
  }
  // The template itself, on every fixture day and kind, never says it either.
  for (const [name, make] of Object.entries(F.ALL)) {
    const fm = await make();
    for (const kind of ['ops', 'patrol']) {
      const fd = await F.facts(fm, kind);
      const words = (b) => [...b.summary, ...b.sections.flatMap((s) => [s.title, ...s.lines]), ...b.actions.map((a) => a.text)];
      for (const w of words(W.template(fd))) assert.ok(!W.goAheadIn(w, W.liftNamesOf(fd)), `${name} ${kind}: ${w}`);
    }
  }
  assert.ok(!W.goAheadIn('Plan for wind holds on Summit Quad', ['Summit Quad']));
  assert.ok(!W.goAheadIn('Open more lesson spots for the waitlist', []));
});

test('names: the brief names only the lifts, trails, park features and areas in its facts, never a made-up place or person', async () => {
  on();
  const words = (b) => [...b.summary, ...b.sections.flatMap((s) => [s.title, ...s.lines]), ...b.actions.map((a) => a.text)];
  // The template, on every fixture day and kind, passes the name check (no false alarms on our own words).
  for (const [name, make] of Object.entries(F.ALL)) {
    const fm = await make();
    for (const kind of ['ops', 'patrol', 'school']) {
      const fd = await F.facts(fm, kind);
      assert.deepEqual(W.unknownNamesIn(W.template(fd), fd), [], `${name} ${kind}: ${JSON.stringify(words(W.template(fd)))}`);
    }
  }
  const m = await F.windDay();
  const data = await F.facts(m, 'ops');
  const t = W.template(data);
  const lift = W.liftNamesOf(data)[0];
  for (const line of [`Grizzly ${lift.split(' ').pop()} Bowl is closed for the morning.`, 'Patroller John Smith will brief the crew.', 'Call Dave about the bullwheel.', 'Check the forecast at weather.example first.']) {
    replies = [reply({ summary: t.summary, sections: [{ title: 'Weather and wind', lines: [line] }], actions: t.actions })];
    const out = await W.write(data, { tenantId: m.id, kind: 'ops' });
    assert.equal(out.source, 'template', line);
    assert.ok(['names', 'facts'].includes(out.reason), line);
  }
  // Names that are in the facts, written as whole words, pass.
  replies = [reply({ summary: t.summary, sections: [{ title: 'Lifts', lines: [`Plan for wind holds on ${lift}.`] }], actions: t.actions })];
  assert.equal((await W.write(data, { tenantId: m.id, kind: 'ops' })).source, 'ai');
});

test('labels and headings: "Drafted by the assistant" only for AI briefs, and the email\'s headings in sentence case', async () => {
  on();
  const m = await F.windDay();
  const data = await F.facts(m, 'ops');
  replies = [goodReply(data)];
  const ai = await W.write(data, { tenantId: m.id, kind: 'ops' });
  const tpl = { body: W.template(data), source: 'template' };
  const tenant = { name: 'Gusty Peak' };
  const link = 'https://app.example/#/brief?d=2026-12-13';
  const aiMail = W.renderEmail({ ...ai, for_date: '2026-12-13', sent_on: '2026-12-13' }, tenant, link);
  const tMail = W.renderEmail({ ...tpl, for_date: '2026-12-13', sent_on: '2026-12-13' }, tenant, link);
  assert.match(aiMail.text, /Drafted by the assistant\./);
  assert.doesNotMatch(tMail.text, /Drafted by the assistant/);
  assert.match(tMail.text, /Filled in from today\u2019s records\./);
  for (const e of [aiMail, tMail]) {
    assert.doesNotMatch(e.html, /text-transform:\s*uppercase/i, 'no all-caps headings in the email');
    for (const line of e.text.split('\n')) assert.ok(!(/[A-Z]{4,}/.test(line) && line === line.toUpperCase()), `all caps: ${line}`);
    assert.match(e.text, /^Weather and wind$/m);
    assert.match(e.text, /^Suggested$/m);
  }
  assert.ok(tMail.text.includes(data.wind_holds.caveat), 'the wind line is in the email too');
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'public', 'css', 'app.css'), 'utf8');
  for (const sel of ['.brief-kicker', '.brief-sec h3']) assert.doesNotMatch(css.split('\n').find((l) => l.startsWith(sel)), /uppercase/, `${sel} is not all caps on the page`);
});

test('plans: the brief is in every plan with no add-on, and the add-on is labeled "AI Operations (add-on)" everywhere', async () => {
  off();
  const plus = modules.MODULES.find((x) => x.key === 'assistant_plus');
  assert.equal(plus.label, 'AI Operations (add-on)');
  assert.ok(!plus.paths.some((p) => /brief/.test(p)), 'the add-on does not gate the brief');
  // A mountain with the add-on off still gets its brief, AI-written when there is a key.
  const m = await F.windDay();
  assert.ok(!(await modules.enabledKeys(m.id)).includes('assistant_plus'));
  on();
  const data = await F.facts(m, 'ops');
  replies = [goodReply(data)];
  assert.equal((await W.write(data, { tenantId: m.id, kind: 'ops' })).source, 'ai');
  off();
  // Words people read: no stray add-on names, and the brief's help and settings say every plan.
  const fs = require('fs'); const path = require('path'); const root = path.join(__dirname, '..', '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const help = read('public/js/help-content.js');
  const briefHelp = help.slice(help.indexOf("id: 'morning-brief'"), help.indexOf('\n  {', help.indexOf("id: 'morning-brief'")));
  assert.match(briefHelp, /Every plan has it/);
  assert.doesNotMatch(briefHelp, /add-on/i, 'the brief\'s help does not put it behind an add-on');
  const settings = read('public/js/views/settings-brief.js');
  assert.doesNotMatch(settings, /Assistant Plus|AI Operations(?! \(add-on\))/);
  for (const f of ['public/js/help-content.js', 'public/js/views/settings-mountain.js', 'public/js/views/conditions-writer.js', 'public/js/views/settings-brief.js', 'public/js/views/brief.js', 'src/lib/modules.js', 'src/site/pricing.html']) {
    const visible = read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(visible, /Assistant Plus/, `${f} still names Assistant Plus`);
  }
  assert.match(read('public/js/views/conditions-writer.js'), /'AI Operations \(add-on\)'/);
});
