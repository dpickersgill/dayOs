'use strict';

// Mountain A is filled with demo data. Mountain B is a separate customer with its own owner login.
// B then calls every signed-in endpoint using A's ids. Nothing of A's may come back, change or be created.
process.env.BOOTSTRAP_KEY = 'test-bootstrap-key';
process.env.LOGIN_RATE_LIMIT = '100000';
// The guest pages are swept too, many times a second from one address.
for (const k of ['PUBLIC_RATE_LIMIT', 'PUBLIC_RATE_LIMIT_ALL', 'ASSISTANT_GUEST_LIMIT', 'BOOKING_RATE_LIMIT', 'CALENDAR_FEED_RATE_LIMIT', 'GIVE_RATE_LIMIT', 'HELP_RATE_LIMIT', 'INBOX_RATE_LIMIT', 'NEXT_TIMES_RATE_LIMIT', 'RENTAL_FORM_RATE_LIMIT', 'SHOP_RATE_LIMIT', 'WAIVER_RATE_LIMIT']) process.env[k] = '1000000';

const fs = require('fs');
const nodePath = require('path');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db');

const root = nodePath.join(__dirname, '..');
const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const PW = 'correct-horse-battery';
let server; let base; let A; let B;

async function call(method, path, token, body, headers = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { ...(raw ? { 'content-type': 'application/octet-stream', 'x-filename': 'x.txt' } : { 'content-type': 'application/json' }), ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' || method === 'DELETE' ? undefined : (raw ? body : JSON.stringify(body ?? {})),
  });
  return { status: res.status, text: await res.text() };
}
async function mountain(slug) {
  const res = await fetch(`${base}/api/v1/tenants`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-key': 'test-bootstrap-key' }, body: JSON.stringify({ slug, name: slug, owner: { email: `owner@${slug}.test`, password: PW, first_name: 'Olive', last_name: 'Owner' } }) });
  assert.equal(res.status, 201, await res.text());
  const login = await call('POST', '/auth/login', null, { tenant: slug, email: `owner@${slug}.test`, password: PW });
  return { slug, token: JSON.parse(login.text).token };
}

// Which tables belong to a mountain, and which columns they hold.
let tables = [];
async function loadTables() {
  const [cols] = await pool.query(`SELECT table_name AS t, column_name AS c, data_type AS d FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`);
  const by = {};
  for (const r of cols) (by[r.t] ||= []).push({ c: r.c, d: r.d });
  tables = Object.entries(by).filter(([, cs]) => cs.some((x) => x.c === 'tenant_id')).map(([t, cs]) => ({ t, cols: cs }));
}
const idOf = async (slug) => (await pool.query('SELECT id FROM tenants WHERE slug = ?', [slug]))[0][0].id;

// A fingerprint of everything mountain A owns. If it changes, something wrote to A.
async function fingerprint(tenantId) {
  const out = {};
  for (const { t, cols } of tables) {
    const parts = cols.map((x) => `COALESCE(\`${x.c}\`, '~')`).join(", '|', ");
    const [[r]] = await pool.query(`SELECT COUNT(*) AS n, COALESCE(SUM(CRC32(CONCAT(${parts}))), 0) AS h FROM \`${t}\` WHERE tenant_id = ?`, [tenantId]);
    out[t] = `${r.n}:${r.h}`;
  }
  return out;
}

// Every route, read from the route files. Each file under src/routes is listed in one of three places:
//   SIGNED  routers behind a mountain login: B calls them with its own token and A's ids;
//   PUBLIC  guest pages keyed by the mountain's web address (or a link token): B's address with A's ids;
//   EXEMPT  routers that hold no mountain's rows, or that a mountain login cannot reach, each with the reason.
// A route file in none of them fails the first test, so a new file is never left out of the sweep.
const SIGNED = {
  'access.js': { adminRouter: '/access' }, 'areaview.js': { router: '/area' }, 'assetmap.js': { router: '/assets/map' }, 'assets.js': { router: '/assets' },
  'assistant.js': { router: '/assistant' }, 'attractions.js': { router: '/attractions', workforceRouter: '/workforce' }, 'auth.js': { router: '' },
  'availability.js': { router: '/availability' }, 'billing.js': { router: '' }, 'board.js': { router: '/board' }, 'catalog.js': { products: '/products', pricing: '/pricing' },
  'checkout.js': { checkout: '/checkout', giftCards: '/gift-cards' }, 'crm.js': { router: '/crm' }, 'customerplus.js': { router: '/people' }, 'demotours.js': { router: '/demo-tours' },
  'dispatch.js': { router: '/patrol' }, 'documents.js': { router: '/documents' }, 'finance.js': { router: '' }, 'form.js': { router: '/patrol' },
  'guests.js': { router: '/guests' }, 'guestsaccount.js': { router: '/guests' }, 'guestsfair.js': { router: '/guests' }, 'guestsloyalty.js': { router: '/guests' }, 'guestswindow.js': { router: '/guests' },
  'guesttypes.js': { router: '/guest-types' }, 'inbox.js': { router: '/inbox' }, 'kiosk.js': { adminRouter: '/kiosk-admin' }, 'liftchecks.js': { router: '/ops' }, 'lostfound.js': { router: '/lost-found' },
  'maintenance.js': { router: '/ops' }, 'map.js': { router: '/patrol' }, 'messages.js': { router: '/messages' }, 'mountaincal.js': { router: '/calendar' }, 'ops.js': { router: '/ops' }, 'park.js': { router: '/park' }, 'parkrecords.js': { router: '/park' }, 'patrolpark.js': { router: '/patrol' },
  'partnerpasses.js': { router: '/partner-passes' }, 'patrol.js': { router: '/patrol' }, 'patrolclaims.js': { router: '/patrol' }, 'patrolcover.js': { router: '/patrol' }, 'patrolcrews.js': { router: '/patrol' },
  'patrolduty.js': { router: '/patrol' }, 'patrolkits.js': { router: '/patrol' }, 'patrolmedia.js': { router: '/patrol' }, 'patrolmeds.js': { router: '/patrol' }, 'patrolplus.js': { router: '/patrol' },
  'patrolrecords.js': { router: '/patrol' }, 'patrolreview.js': { router: '/patrol' }, 'patrolscene.js': { router: '/patrol' }, 'patrolschedule.js': { router: '/patrol' }, 'patrolsweep.js': { router: '/patrol' },
  'people.js': { router: '/people' }, 'programs.js': { router: '/programs' }, 'programterms.js': { router: '/programs' }, 'rentaldeposits.js': { router: '/rentals' }, 'rentalforms.js': { router: '/rentals' },
  'rentals.js': { router: '/rentals' }, 'rentalsfit.js': { router: '/rentals' }, 'rentalsplus.js': { router: '/rentals' }, 'rentalsreturns.js': { router: '/rentals' }, 'reports.js': { router: '/reports' },
  'safety.js': { router: '/patrol' }, 'sales.js': { router: '' }, 'schedule.js': { schedule: '/schedule' }, 'schooldirector.js': { router: '/skischool' }, 'schoollineup.js': { router: '/skischool' },
  // 2026.11.13: ski school safety and pay, and the dismissed notes
  'schoolsafety.js': { router: '/skischool' }, 'schoolmoney.js': { router: '/skischool' }, 'schoolreports.js': { router: '/skischool' }, 'schoolgroups.js': { router: '/skischool' }, 'notices.js': { router: '/notices' },
  'schoolparents.js': { router: '/skischool' }, 'schoolpay.js': { router: '/skischool' }, 'schoolplan.js': { router: '/skischool' }, 'schoolplus.js': { router: '/skischool' }, 'schoolsettings.js': { router: '/skischool' },
  'schoolstaff.js': { router: '/skischool' }, 'security.js': { router: '' }, 'shop.js': { router: '/online-shop' }, 'shopadmin.js': { router: '/online-shop' }, 'skischool.js': { router: '/skischool' },
  'staffinjuries.js': { router: '/staff-injuries' }, 'team.js': { router: '/patrol' }, 'terminal.js': { router: '/terminal' }, 'waivers.js': { router: '/waivers' }, 'whatsnew.js': { router: '/whats-new' },
  'workforce.js': { router: '/workforce' }, 'workforcetime.js': { router: '/workforce' },
  // 2026.11.15: the first AI release. Prepared actions (Ready for you) and the morning brief.
  'ai.js': { router: '/ai' }, 'brief.js': { router: '/brief' },
  // Guest help release: mapped places, sign sheets, a call's location panel and staff help.
  'places.js': { router: '/patrol' },
  // help/sms: Text HELP settings and a call's texts and photos.
  'helpsms.js': { router: '/patrol' },
  // Municipal edition (muni release 1): a municipality's street list.
  'streets.js': { router: '/requests/streets' },
  // 2026.11.20: Jump to finds records (test/m2-polish.test.js checks one municipality never finds another's).
  'jump.js': { router: '/jump' },
  // Municipal edition (muni release 1): asset programs and asset photos, inside the Assets and fleet router.
  'assetprograms.js': { router: '/assets/programs' }, 'assetphotos.js': { router: '/assets/photos' },
  // 2026.11.20: departments, funds, labor rates, job costs and the monthly report, inside the Assets and fleet router.
  'workmoney.js': { router: '/assets' },
  'utilities.js': { router: '/water' }, // the same Today card router is also mounted at /sewer and /stormwater
  'crew.js': { router: '/workforce', works: '/ops' }, // 2026.11.20: crew board, on call, overtime; assigning work orders and their map
  'requests.js': { router: '/requests' }, // muni release 1: resident requests (test/muni-requests.test.js sweeps two municipalities)
  // Municipal edition (muni release 1): bulk trash pickup (Trash and recycling).
  'bulkpickup.js': { router: '/solid-waste' },
  // Municipal edition: street notices and the resident alert list.
  'streetnotices.js': { router: '/street-notices' },
  // muni release 1: Buildings (the life-safety calendar and binder).
  'buildings.js': { router: '/buildings' },
  // 2026.11.20 (utilities): main breaks, Chapter 94, MS4 and illicit discharge cases, the water customer list and door
  // hangers, the bulk pickup route order, repeat callers and duplicates.
  'mainbreaks.js': { router: '/water' }, 'chapter94.js': { router: '/sewer' }, 'ms4.js': { router: '/stormwater' },
  'serviceaddresses.js': { router: '/street-notices' }, 'bulkroute.js': { router: '/solid-waste' }, 'requestchecks.js': { router: '/requests/checks' },
};
const PUBLIC = {
  'assistant.js': { publicRouter: '/public' }, 'availability.js': { publicRouter: '/public' }, 'dispatch.js': { publicRouter: '/public' }, 'family.js': { publicRouter: '/public' },
  'followpublic.js': { publicRouter: '/public' }, 'guestsaccount.js': { publicRouter: '/public' }, 'guestsfair.js': { publicRouter: '/public' }, 'guestsloyalty.js': { publicRouter: '/public' },
  'guestswindow.js': { publicRouter: '/public' }, 'lessonbook.js': { router: '/public' }, 'lostfound.js': { publicRouter: '/public' }, 'messages.js': { publicRouter: '/public' },
  'mountaincal.js': { feedRouter: '/calendar-feed' }, 'partnerpasses.js': { publicRouter: '/public' }, 'patrolclaims.js': { publicRouter: '/public' }, 'patrolscene.js': { publicRouter: '/public' },
  'programreg.js': { publicRouter: '/public' }, 'rentalforms.js': { publicRouter: '/public' }, 'schedule.js': { publicRouter: '/public' }, 'schooldirector.js': { publicRouter: '/public' },
  'schoollineup.js': { publicRouter: '/public' }, 'schoolparents.js': { publicRouter: '/public' }, 'schoolpay.js': { publicRouter: '/public' }, 'shop.js': { publicRouter: '/public' },
  'waivers.js': { publicRouter: '/public' },
  'schoolsafety.js': { publicRouter: '/public' }, 'schoolmoney.js': { publicRouter: '/public' }, 'schoolgroups.js': { publicRouter: '/public' },
  'guesthelp.js': { publicRouter: '/public' }, // help/guest: the guest's status page, keyed by the mountain and the call's guest token
  // help/sms: Twilio's inbound text webhook for every mountain's help number (refused without Twilio's signature).
  'helpsms.js': { publicRouter: '/public' },
  'requests.js': { publicRouter: '/public' }, // muni release 1: the report page and its status links, keyed by the web address and the request's token
  'streets.js': { publicRouter: '/public' }, // muni release 1: a municipality's street names, keyed by its web address
  'bulkpickup.js': { publicRouter: '/public' }, // muni release 1: the bulk pickup page and a resident's booking link
  'streetnotices.js': { publicRouter: '/public' }, // muni release 1: alert sign-ups, a notice's page and the manage link, keyed by the municipality's web address and a signed link
};
// Whole files, or single routers inside a file ('file.js:name'), left out of the sweep, and why.
const EXEMPT = {
  'site.js': 'The product website and its plans and contact form: no mountain data and no mountain login.',
  'status.js': 'The public status page (numbers about the service, nothing about any mountain) and the operator console\'s incident notes.',
  'platform.js': 'The operator console: signed by an operator login, never a mountain login (test/platform.test.js covers who may use it).',
  'platformgoodday.js': 'The operator console\'s newsletter: operator login only.',
  'platformoutreach.js': 'The operator console\'s outreach list: operator login only.',
  'platformprospects.js': 'The operator console\'s prospect research: operator login only.',
  'sandbox.js': 'The website\'s try-it demo: makes a new demo mountain and holds no existing mountain\'s rows.',
  'twilioinbound.js': 'Twilio\'s signed STOP and START replies: no login, refused without Twilio\'s signature (test/messages.test.js).',
  'access.js:deviceRouter': 'Gates and handheld readers: a paired device\'s own key, not a mountain login (test/gate.test.js).',
  'kiosk.js:publicRouter': 'The staff time clock kiosk: a paired device\'s own key, not a mountain login (test/kiosk.test.js).',
  'followpublic.js:jobs': 'Scheduled jobs: Cloud Scheduler\'s secret, not a mountain login.',
};
// Not routers: Map lookups that happen to read like route calls.
const NOT_ROUTERS = new Set(['availability.js:days', 'family.js:byPerson', 'schoolpay.js:by', 'patrolplus.js:seen', 'patrolcrews.js:teamMembers', 'patrolcrews.js:teamMembers', 'site.js:pages', 'site.js:api', 'site.js:router']);

function discover() {
  const found = []; const pub = []; const unknown = new Set(); const unlisted = [];
  const files = fs.readdirSync(nodePath.join(root, 'src/routes')).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    if (!SIGNED[file] && !PUBLIC[file] && !EXEMPT[file]) { unlisted.push(file); continue; }
    if (EXEMPT[file]) continue;
    const src = fs.readFileSync(nodePath.join(root, 'src/routes', file), 'utf8');
    const add = (name, method, p) => {
      if (EXEMPT[`${file}:${name}`] || NOT_ROUTERS.has(`${file}:${name}`)) return;
      if (SIGNED[file] && SIGNED[file][name] !== undefined) found.push({ method, path: SIGNED[file][name] + p, file });
      else if (PUBLIC[file] && PUBLIC[file][name] !== undefined) pub.push({ method, path: PUBLIC[file][name] + p, file });
      else unknown.add(`${file}:${name}`);
    };
    const re = /^[ \t]*(\w+)\.(get|post|put|patch|delete)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)/gm;
    let m;
    while ((m = re.exec(src))) {
      const paths = [...m[3].matchAll(/['"`]([^'"`]+)['"`]/g)].map((x) => x[1]);
      for (const p of m[3].startsWith('[') ? paths : [m[3].slice(1, -1)]) add(m[1], m[2].toUpperCase(), p);
    }
    // Lists made by lib/crud.js: a list, one by id, add, change and (when allowed) delete.
    const cr = /^(\w+)\.use\(\s*(?:'([^']*)'\s*,\s*)?crud\(/gm;
    while ((m = cr.exec(src))) {
      const at = (m[2] || '').replace(/\/$/, '');
      for (const [method, p] of [['GET', ''], ['GET', '/:id'], ['PATCH', '/:id'], ['DELETE', '/:id']]) add(m[1], method, `${at}${p}` || '/');
    }
  }
  return { found, pub, unknown, unlisted };
}

async function pool8(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const state = {};

/** A pending proposal and a stored brief (operations, today and yesterday) in a mountain, with A-only words in them. */
async function seedAi(M) {
  const proposals = require('../src/lib/proposals');
  for (const m of ['assistant_plus', 'conditions']) await pool.query('INSERT INTO tenant_modules (tenant_id, module, enabled) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE enabled = 1', [M.id, m]);
  require('../src/lib/modules').invalidate(M.id);
  require('../src/lib/conditionswriter'); // registers the conditions draft kind
  const [[lift]] = await pool.query('SELECT name FROM lifts WHERE tenant_id = ? ORDER BY id LIMIT 1', [M.id]);
  M.proposal = await proposals.create(pool, { tenantId: M.id, kind: 'conditions_update', title: `Isolation draft for ${M.slug}`, summary: `Pending isolation summary ${M.slug}`,
    preview: { note: `Isolation note ${M.slug}`, by: 'template' }, payload: { date: '2030-01-01', note: `Isolation note ${M.slug}`, send_email: false }, forRoles: ['owner', 'manager'], source: 'draft_now' });
  const [[t]] = await pool.query('SELECT timezone FROM tenants WHERE id = ?', [M.id]);
  const today = require('../src/lib/util').todayIn(t.timezone);
  const body = { summary: [`Open today at ${M.slug}.`, `Isolation brief line ${M.slug}`, 'Nothing needs attention this morning.'], sections: [{ title: 'Lifts', lines: [`${lift ? lift.name : 'Lift'}: open work order (isolation ${M.slug}).`] }], actions: [] };
  M.briefs = [];
  for (const d of [today, require('../src/lib/util').addDays(today, -1)]) {
    const [r] = await pool.query("INSERT INTO morning_briefs (tenant_id, sent_on, for_date, kind, data, body, source) VALUES (?, ?, ?, 'ops', ?, ?, 'template')",
      [M.id, d, d, JSON.stringify({ mountain: M.slug, note: `Isolation facts ${M.slug}` }), JSON.stringify(body)]);
    M.briefs.push(r.insertId);
  }
}

/** help/guest: a guest's request at A with answers, a reply, a message from dispatch and a position, in A-only words. */
async function seedGuestHelp(M) {
  await pool.query('UPDATE tenants SET guest_help_enabled = 1 WHERE id = ?', [M.id]);
  const made = await fetch(`${base}/api/v1/public/${M.slug}/help`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device': `isolation-device-${M.slug}`.slice(0, 60) }, body: JSON.stringify({ kind: 'help', location: `Isolation glade ${M.slug}`, gps_lat: 44.1, gps_lng: -71.2, accuracy: 25, rid: '0123456789abcdef0123456789abcdef' }) });
  M.help = await made.json();
  assert.equal(made.status, 201, JSON.stringify(M.help));
  const at = (p, method, body) => fetch(`${base}/api/v1/public/${M.slug}/help/${M.help.token}${p}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await at('', 'PATCH', { what: `Isolation guest words ${M.slug}`, tower: '7' })).status, 200);
  assert.equal((await at('/messages', 'POST', { body: `Isolation guest reply ${M.slug}` })).status, 201);
  assert.equal((await at('/position', 'POST', { lat: 44.1001, lng: -71.2001, accuracy: 12 })).status, 200);
  const [[c]] = await pool.query('SELECT * FROM dispatch_calls WHERE guest_token = ?', [M.help.token]);
  await require('../src/lib/guestmsg').toGuest(pool, c, `Isolation patrol note ${M.slug}`, null);
  M.helpCall = c.id;
}

/** help/sms: a help number and a call that came by text, with a photo, so the sweep has A's texts to look for. */
async function seedTextHelp(M) {
  const [[t]] = await pool.query('SELECT timezone FROM tenants WHERE id = ?', [M.id]);
  const now = require('../src/lib/util').nowIn(t.timezone);
  const line = `+1484${String(M.id).padStart(7, '0').slice(-7)}`;
  await pool.query('INSERT INTO patrol_help_lines (tenant_id, help_number, patrol_phone) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE help_number = VALUES(help_number)', [M.id, line, '+16105550100']);
  const [[{ n }]] = await pool.query('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM dispatch_calls WHERE tenant_id = ? AND call_date = ?', [M.id, now.slice(0, 10)]);
  const [c] = await pool.query("INSERT INTO dispatch_calls (tenant_id, call_date, seq, source, location, description, caller_phone, received_at) VALUES (?, ?, ?, 'sms', ?, ?, ?, ?)",
    [M.id, now.slice(0, 10), n, `Isolation sign ${M.slug}`, `Isolation text help ${M.slug}`, '+16105550177', now]);
  const media = `https://api.twilio.com/2010-04-01/Accounts/ACiso/Messages/MMiso${M.id}/Media/MEiso${M.id}`;
  await pool.query(`INSERT INTO dispatch_sms_threads (tenant_id, call_id, phone, phone_key, help_number, lang, opened_at, last_at, photos)
    VALUES (?, ?, '+16105550177', '6105550177', ?, 'en', UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?)`, [M.id, c.insertId, line, JSON.stringify([{ url: media, type: 'image/jpeg', at: now }])]);
}

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  A = await mountain(`ta-${suffix}`); B = await mountain(`tb-${suffix}`);
  A.id = await idOf(A.slug); B.id = await idOf(B.slug);
  await promisify(execFile)('node', ['db/demo.js', A.slug], { cwd: root, env: { ...process.env }, timeout: 240000, maxBuffer: 1 << 26 });
  // The demo has no documents yet, so A gets a category with a document and an uploaded file.
  const cat = JSON.parse((await call('POST', '/documents/categories', A.token, { name: 'Isolation test files' })).text).id;
  const doc = JSON.parse((await call('POST', '/documents/documents', A.token, { category_id: cat, title: 'Evacuation plan for Lodge' })).text).id;
  const up = await call('PUT', `/documents/documents/${doc}/file`, A.token, Buffer.from('muster point is the flagpole'));
  assert.equal(up.status, 201, up.text);
  await call('PUT', `/documents/documents/${doc}/file`, A.token, Buffer.from('muster point moved to the lodge deck'));
  // The AI release's rows (2026.11.15): a pending draft waiting for approval, and a stored morning brief, each with
  // words only A's data holds, so the sweep has something to find on the new routes.
  await seedAi(A);
  // Guest help release (help/places): mapped places with words only A has, for the new routes to be swept against.
  const [[aLift]] = await pool.query('SELECT id, name FROM lifts WHERE tenant_id = ? ORDER BY id LIMIT 1', [A.id]);
  for (const [kind, name, code, extra] of [['sign', `Isolation sign ${A.slug}`, 'ISA1', {}], ['tower', `Isolation tower ${A.slug}`, 'ISA2', { lift_id: aLift.id, tower_no: 4 }], ['junction', `Isolation junction ${A.slug}`, 'ISA3', {}]]) {
    await pool.query('INSERT INTO mountain_places (tenant_id, kind, name, code, lift_id, tower_no, lat, lng, accuracy_m, marked_at) VALUES (?, ?, ?, ?, ?, ?, 44.1, -71.2, 5, NOW())',
      [A.id, kind, name, code, extra.lift_id ?? null, extra.tower_no ?? null]);
  }
  await seedGuestHelp(A);
  await seedTextHelp(A);
  await loadTables();

  // Ids to try: a few real ones from every one of A's tables, minus any id that B legitimately owns in any table.
  const mine = new Set(); const theirs = new Set();
  for (const { t, cols } of tables) {
    if (!cols.some((x) => x.c === 'id')) continue;
    const [a] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ? ORDER BY id`, [A.id]);
    if (a.length) { mine.add(a[0].id); mine.add(a[a.length - 1].id); if (a.length > 2) mine.add(a[Math.floor(a.length / 2)].id); }
    const [b] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ?`, [B.id]);
    for (const r of b) theirs.add(r.id);
  }
  state.ids = [...mine].filter((x) => !theirs.has(x));

  // Words that only mountain A's data would contain: emails, names, titles, places. Words that are also in the app's own code are dropped.
  const code = ['src', 'public'].map((d) => { try { return execFileSync('cat', ['-s', ...fs.readdirSync(nodePath.join(root, d), { recursive: true }).filter((f) => /\.(js|html)$/.test(f)).map((f) => nodePath.join(root, d, f))], { maxBuffer: 1 << 28 }).toString(); } catch (_) { return ''; } }).join('\n').toLowerCase();
  const wanted = /^(email|name|title|summary|description|location|first_name|last_name|callsign|label|plate|code|note|notes|display_name|bio|company)$/;
  const words = new Set();
  for (const { t, cols } of tables) {
    for (const x of cols.filter((c) => wanted.test(c.c) && /char|text/.test(c.d))) {
      const [r] = await pool.query(`SELECT DISTINCT \`${x.c}\` AS v FROM \`${t}\` WHERE tenant_id = ? AND \`${x.c}\` IS NOT NULL LIMIT 400`, [A.id]);
      for (const { v } of r) if (typeof v === 'string' && v.length >= 7 && v.length <= 120 && !code.includes(v.toLowerCase())) words.add(v);
    }
  }
  state.words = [...words];
  state.routes = discover();
  state.before = await fingerprint(A.id);
});
test.after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

const fill = (path, id) => path.replace(/\{([^}]*)\}/g, '$1').replace(/:(\w+)/g, (_m, k) => (k === 'slug' ? B.slug : /^v$|version/i.test(k) ? '1' : String(id)));
const leaks = (text) => state.words.find((w) => text.includes(w));

test('the sweep covers the routes and has material to test with', (t) => {
  t.diagnostic(`${state.routes.found.length} signed-in routes, ${state.routes.pub.length} guest routes, ${state.ids.length} ids, ${state.words.length} words`);
  assert.deepEqual(state.routes.unlisted, [], 'a route file is in none of SIGNED, PUBLIC or EXEMPT: add it');
  assert.deepEqual([...state.routes.unknown], [], 'a route file uses a router name this test does not know');
  const all = fs.readdirSync(nodePath.join(root, 'src/routes')).filter((f) => f.endsWith('.js'));
  const swept = new Set([...state.routes.found, ...state.routes.pub].map((r) => r.file));
  const silent = all.filter((f) => !EXEMPT[f] && !swept.has(f));
  assert.deepEqual(silent, [], 'a listed route file gave the sweep no routes (its router name or mount is wrong)');
  assert.ok(state.routes.found.length > 900, `only ${state.routes.found.length} signed-in routes found`);
  assert.ok(state.routes.pub.length > 100, `only ${state.routes.pub.length} guest routes found`);
  assert.ok(state.ids.length > 40, `only ${state.ids.length} of A's ids to try`);
  assert.ok(state.words.length > 100, `only ${state.words.length} words to look for`);
});

test('B cannot read anything of A: not lists, not single records, not by id', async () => {
  const bad = [];
  const gets = state.routes.found.filter((r) => r.method === 'GET');
  const jobs = [];
  for (const r of gets) {
    if (!r.path.includes(':')) jobs.push({ r, url: r.path });
    else for (const id of state.ids) jobs.push({ r, url: fill(r.path, id) });
  }
  await pool8(jobs, async ({ r, url }) => {
    const res = await call('GET', url, B.token);
    if (res.status === 401) { bad.push(`${url} -> 401 (B's login stopped working)`); return; }
    const w = res.status < 300 && leaks(res.text);
    if (w) bad.push(`${url} -> ${res.status} shows "${w}" (${r.file})`);
  });
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} leaks`);
  assert.deepEqual(await fingerprint(A.id), state.before, 'a read by B changed A\'s data');
});

test('B cannot change or delete anything of A by id', async () => {
  const bad = [];
  const jobs = [];
  // B's reads in the test before this one can create B's own starter rows (default ski school skills, say), and an
  // id is only unique within its table: drop any id B owns by now, so a 200 always means one of A's rows was hit.
  const theirs = new Set();
  for (const { t, cols } of tables) {
    if (!cols.some((x) => x.c === 'id')) continue;
    const [b] = await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ?`, [B.id]);
    for (const r of b) theirs.add(r.id);
  }
  const ids = state.ids.filter((x) => !theirs.has(x));
  for (const r of state.routes.found.filter((x) => x.method !== 'GET' && x.path.includes(':'))) {
    for (const id of ids) jobs.push({ r, url: fill(r.path, id) });
  }
  await pool8(jobs, async ({ r, url }) => {
    const res = await call(r.method, url, B.token, {});
    if (res.status === 401) { bad.push(`${r.method} ${url} -> 401 (B's login stopped working)`); return; }
    if (res.status < 300) bad.push(`${r.method} ${url} -> ${res.status} (${r.file})`);
  });
  // These answer 200 but match nothing of B's (each query is scoped to B), so A is untouched.
  const harmless = /^(DELETE \/guests\/group-prices\/N|DELETE \/people\/N\/photo|DELETE \/people\/N\/family\/N|DELETE \/kiosk-admin\/people\/N\/pin|POST \/kiosk-admin\/people\/N\/unlock) /;
  const real = bad.filter((x) => !harmless.test(x.replace(/\/\d+/g, '/N')));
  assert.deepEqual(real.slice(0, 20), [], `${real.length} writes were accepted`);
  const after = await fingerprint(A.id);
  const diff = Object.keys(after).filter((k) => after[k] !== state.before[k]);
  assert.deepEqual(diff, [], 'A\'s data changed in these tables');
});

test('the AI release: B sees none of A\'s drafts or briefs, and cannot approve or set aside A\'s draft', async () => {
  const has = (text) => text.includes(A.slug);
  const reads = ['/ai/proposals', '/ai/proposals?status=approved', '/ai/conditions/settings', '/brief', '/brief/prefs', '/brief/people', '/reports/forecast-data', ...A.briefs.map((id) => `/brief/${id}`)];
  for (const p of reads) {
    const r = await call('GET', p, B.token);
    assert.ok(r.status !== 401, `${p}: B's login stopped working`);
    assert.ok(!(r.status < 300 && has(r.text)), `${p} -> ${r.status} shows A's data`);
  }
  for (const id of A.briefs) assert.equal((await call('GET', `/brief/${id}`, B.token)).status, 404, `brief ${id}`);
  const [[before]] = await pool.query('SELECT status FROM ai_proposals WHERE id = ?', [A.proposal]);
  for (const what of ['approve', 'reject']) {
    const r = await call('POST', `/ai/proposals/${A.proposal}/${what}`, B.token, {});
    assert.equal(r.status, 404, `${what}: ${r.status} ${r.text}`);
  }
  const [[after]] = await pool.query('SELECT status FROM ai_proposals WHERE id = ?', [A.proposal]);
  assert.equal(after.status, before.status); assert.equal(after.status, 'pending');
  // Control: A's own owner sees the draft and today's brief.
  assert.ok(has((await call('GET', '/ai/proposals', A.token)).text), 'A sees its own draft');
  assert.ok(has((await call('GET', `/brief/${A.briefs[0]}`, A.token)).text), 'A reads its own brief');
});

// Guest pages are keyed by the mountain's web address, so B's address with A's ids must find nothing of A's.
const idParams = (path) => [...path.matchAll(/:(\w+)/g)].some((m) => m[1] !== 'slug');
test('guest pages: B\'s web address with A\'s ids shows nothing of A and changes nothing of A', async () => {
  const bad = [];
  const before = await fingerprint(A.id);
  const jobs = [];
  for (const r of state.routes.pub) {
    if (!idParams(r.path)) { if (r.method === 'GET') jobs.push({ r, url: fill(r.path, 0) }); continue; }
    for (const id of state.ids) jobs.push({ r, url: fill(r.path, id) });
  }
  await pool8(jobs, async ({ r, url }) => {
    const res = await call(r.method, url, null, {});
    if (r.method === 'GET') { const w = res.status < 300 && leaks(res.text); if (w) bad.push(`${url} -> ${res.status} shows "${w}" (${r.file})`); return; }
    if (res.status < 300 && leaks(res.text)) bad.push(`${r.method} ${url} -> ${res.status} shows A's data (${r.file})`);
  });
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} leaks`);
  const after = await fingerprint(A.id);
  const diff = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.deepEqual(diff, [], 'A\'s data changed in these tables');
});

test('guest help: A\'s guest token under B\'s address finds nothing and changes nothing; dispatch at B cannot message A\'s guest', async () => {
  const before = await fingerprint(A.id);
  const tok = A.help.token;
  const tries = [['GET', '', null], ['PATCH', '', { what: 'from B', bleeding: true }], ['POST', '/position', { lat: 1, lng: 1 }], ['POST', '/live-off', {}], ['POST', '/messages', { body: 'from B' }], ['POST', '/pass', { number: 'ABCD1234' }]];
  for (const [method, p, body] of tries) {
    const r = await call(method, `/public/${B.slug}/help/${tok}${p}`, null, body || {});
    assert.equal(r.status, 404, `${method} ${p}: ${r.status} ${r.text.slice(0, 100)}`);
    assert.ok(!r.text.includes(A.slug), `${method} ${p} shows A's words`);
  }
  for (const r of [await call('POST', `/patrol/dispatch/${A.helpCall}/messages`, B.token, { body: 'from B' }), await call('GET', `/patrol/dispatch/${A.helpCall}`, B.token)]) assert.equal(r.status, 404, r.text);
  assert.deepEqual(await fingerprint(A.id), before, 'A\'s data changed');
  // Control: A's address with the token is the guest's own status page.
  const own = await call('GET', `/public/${A.slug}/help/${tok}`, null);
  assert.equal(own.status, 200);
  assert.match(own.text, /Isolation patrol note/);
});

test('B cannot tie its records to A\'s: a foreign id in the body is refused', async () => {
  const one = async (t, where = '1=1') => (await pool.query(`SELECT id FROM \`${t}\` WHERE tenant_id = ? AND ${where} ORDER BY id LIMIT 1`, [A.id]))[0][0]?.id;
  const ids = { category: await one('doc_categories'), asset: await one('ops_assets'), lift: await one('lifts'), trail: await one('trails'), staff: await one('staff'), person: await one('people'), product: await one('products') };
  for (const [k, v] of Object.entries(ids)) assert.ok(v, `no demo ${k}`);
  const before = await fingerprint(A.id);
  const tryIt = async (what, method, path, body) => {
    const r = await call(method, path, B.token, body);
    assert.ok(r.status >= 400 && r.status < 500, `${what}: ${method} ${path} -> ${r.status} ${r.text.slice(0, 120)}`);
  };
  await tryIt('document into A\'s category', 'POST', '/documents/documents', { title: 'Sneaky', category_id: ids.category });
  await tryIt('work order on A\'s asset', 'POST', '/ops/work-orders', { title: 'Sneaky', asset_id: ids.asset });
  await tryIt('work order on A\'s lift', 'POST', '/ops/work-orders', { title: 'Sneaky', lift_id: ids.lift });
  await tryIt('groom plan on A\'s trail', 'POST', '/ops/groom/plan', { plan_date: '2030-01-01', shift: 'night', trail_id: ids.trail, asset_id: ids.asset });
  await tryIt('order for A\'s guest and product', 'POST', '/orders', { person_id: ids.person, items: [{ product_id: ids.product }] });
  await tryIt('time off for A\'s staff', 'POST', '/workforce/time-off', { staff_id: ids.staff, start_date: '2030-01-01', end_date: '2030-01-02' });
  assert.deepEqual(await fingerprint(A.id), before, 'A\'s data changed');
  // Nothing of B's may point at A's rows either.
  const [[x]] = await pool.query('SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND category_id IN (SELECT id FROM doc_categories WHERE tenant_id <> ?)', [B.id, B.id]);
  assert.equal(x.n, 0);
});

test('A file or search from B never reaches A\'s documents', async () => {
  const [[d]] = await pool.query('SELECT id FROM documents WHERE tenant_id = ? AND file_name IS NOT NULL ORDER BY id LIMIT 1', [A.id]);
  if (!d) return; // the demo may hold no uploaded files
  for (const p of [`/documents/documents/${d.id}/file`, `/documents/documents/${d.id}/versions`, `/documents/documents/${d.id}/versions/1/file`]) assert.equal((await call('GET', p, B.token)).status, 404, p);
  for (const p of [`/documents/documents/${d.id}/scan`, `/documents/documents/${d.id}/versions/1/restore`]) assert.equal((await call('POST', p, B.token, {})).status, 404, p);
  assert.equal((await call('PUT', `/documents/documents/${d.id}/file`, B.token, Buffer.from('hello'))).status, 404);
});

// Last, because A's own signed-in reads may write to A (audit and last-seen rows) and would blur the before/after comparison above.
test('control: A\'s own owner sees A\'s data, so the leak check can actually catch something', async () => {
  let seen = 0;
  const gets = state.routes.found.filter((r) => r.method === 'GET' && !r.path.includes(':'));
  await pool8(gets, async (r) => { const res = await call('GET', r.path, A.token); if (res.status === 200 && leaks(res.text)) seen++; });
  assert.ok(seen >= 15, `only ${seen} pages showed A's data to A`);
});
