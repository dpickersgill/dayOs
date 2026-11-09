'use strict';

// The shared Text HELP number (help/shared). Every mountain uses one shared Verdynt/OS help number by default; a text to
// it must reach the right mountain's patrol, and never the wrong one. Nothing here guesses.
//
// A text to the shared number goes to a mountain, in this order:
//   a. a tag or tagged sign code at the start ("HELP BR R7", "HELP BRR7", "HELP BR-R7", "BR", any case): the mountain
//      with that tag;
//   b. the phone's open call (a text either way in the last 2 hours): that call;
//   c. a position in the text (the help page's "44.27110,-71.30330 ±12m", or the same rules as lib/helpline.js parse):
//      the nearest mountain whose map point is within 50 km (the choice, and any other within 50 km, go on the call);
//   d. otherwise a pending request (help_pending), answered at once: which ski area are you at? A name reply is matched
//      against the mountains' names, forgiving case, punctuation, "mountain" and "ski area", small typos and Spanish. One
//      match routes; several get a numbered list of at most 5 ("Reply 1 for Blue Ridge, 2 for ..."); none asks again.
//      The reply's link opens the shared locate page; a position from it routes like c. Everything the guest texted while
//      pending goes on the call, in order, with a note: "Arrived on the shared number, matched by name after 2 min".
// The mountains a text can reach: active, not a demo, with the Patrol app on. That includes a mountain on its own number
// (decided Nov 9: a guest who names it, or texts its tag, still reaches the right patrol).
//
// The job (tick, every minute) texts a pending guest again after 3 minutes and closes the request after 2 hours with a
// last text ("If you still need help, call 911 or the ski area."). The console shows the pending texts to the platform
// operator, who can send one to a mountain by hand. STOP counts for the whole shared number. Caps: 6 replies per phone an
// hour while pending, and the shared number's hourly cap across every mountain (lib/helpline.js).
//
// These are patrol and dispatch data. None of it ever goes to AI (test/ai-patrol-line.test.js).
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const HL = require('./helpline');
const { logFailure } = require('./jobs');

const AREA_M = 50000;
const PENDING_HOURS = 2;
const NUDGE_MIN = 3;
const PHONE_CAP = () => Number(process.env.HELP_PENDING_PHONE_CAP) || 6;
const MAX_TEXTS = 40;

const STRINGS = {
  en: {
    e911: 'If it is life threatening, call 911.',
    ask: (link) => `Ski patrol: which ski area are you at? Reply with its name, or the code on the nearest sign. Or tap this link to send your location: ${link}.`,
    again: (link) => `Ski patrol: we did not find that ski area. Reply with its name, or the code on the nearest sign. Or tap this link to send your location: ${link}.`,
    list: (names) => `Ski patrol: Reply ${names.map((n, i) => `${i + 1} for ${n}`).join(', ')}.`,
    nudge: (link) => `Ski patrol: We still need the ski area name. Reply with it, or the code on the nearest sign. Or tap this link to send your location: ${link}.`,
    expired: 'Ski patrol: If you still need help, call 911 or the ski area.',
  },
  es: {
    e911: 'Si su vida corre peligro, llame al 911.',
    ask: (link) => `Patrulla de esquí: ¿en qué estación de esquí está? Responda con su nombre o con el código del letrero más cercano. O toque este enlace para enviar su ubicación: ${link}.`,
    again: (link) => `Patrulla de esquí: no encontramos esa estación de esquí. Responda con su nombre o con el código del letrero más cercano. O toque este enlace para enviar su ubicación: ${link}.`,
    list: (names) => `Patrulla de esquí: Responda ${names.map((n, i) => `${i + 1} para ${n}`).join(', ')}.`,
    nudge: (link) => `Patrulla de esquí: Todavía necesitamos el nombre de la estación de esquí. Respóndanos con él o con el código del letrero más cercano. O toque este enlace para enviar su ubicación: ${link}.`,
    expired: 'Patrulla de esquí: Si todavía necesita ayuda, llame al 911 o a la estación de esquí.',
  },
};
/** The 911 line last, or first when the guest said a child is lost. */
const with911 = (lang, body, lost) => { const S = STRINGS[lang] || STRINGS.en; return lost ? `${S.e911} ${body}` : `${body} ${S.e911}`; };
const linkOf = (base, token) => `${String(base).replace(/\/$/, '')}/help-locate/${token}`;

// ---------------------------------------------------------------- the mountains a text can reach
/** Active, not a demo, with the Patrol app on. Each with its tag, map point and patrol phone. */
async function reachable() {
  const list = await rows(pool, `SELECT t.id, t.name, t.slug, t.timezone, t.status, t.help_tag, t.map_lat, t.map_lng, l.patrol_phone, l.help_number, l.help_mode
    FROM tenants t LEFT JOIN patrol_help_lines l ON l.tenant_id = t.id WHERE t.status = 'active' AND t.sandbox_expires_at IS NULL ORDER BY t.id`);
  const M = require('./modules');
  const out = [];
  for (const t of list) if ((await M.enabledKeys(t.id)).includes('patrol')) out.push(t);
  return out;
}
/** The mountain as lib/helpline.js takes a line, on the shared number. */
const lineFor = (t, shared) => ({ tenant_id: Number(t.id), help_number: shared, patrol_phone: t.patrol_phone || null, name: t.name, timezone: t.timezone, status: t.status, help_tag: t.help_tag });

// ---------------------------------------------------------------- a. the tag
/**
 * The mountain a text's lead names by its tag, or null. A tag alone ("HELP BR ...") or with a code ("BR R7", "BR-R7")
 * names the mountain; a joined code ("BRR7") counts when the rest is one of its sign codes or has a digit. Two mountains
 * named at once (a joined code read two ways) is no match.
 */
async function byTag(text, list) {
  const lead = HL.leadOf(text);
  if (!lead.cands.length) return null;
  const byT = new Map(list.filter((t) => t.help_tag).map((t) => [t.help_tag, t]));
  const P = require('./places');
  for (const c of lead.cands.filter((x) => !x.joined)) {
    const t = byT.get(c.tag);
    if (t) return { tenant: t, tag: c.tag };
  }
  const hits = [];
  for (const c of lead.cands.filter((x) => x.joined)) {
    const t = byT.get(c.tag);
    if (!t) continue;
    const found = await P.byCode(pool, t.id, c.code);
    if (found || /\d/.test(c.code)) hits.push({ tenant: t, tag: c.tag });
  }
  const ids = new Set(hits.map((h) => Number(h.tenant.id)));
  if (ids.size === 1) return hits[0];
  if (ids.size > 1) logFailure({ job: 'help_shared', message: `a joined sign code matched ${ids.size} mountains' tags; asked which ski area instead` });
  return null;
}

// ---------------------------------------------------------------- c. a position
/** The nearest mountain whose map point is within 50 km of gps, with any others within 50 km. null when none is. */
function nearest(gps, list) {
  const P = require('./places');
  const near = list.filter((t) => t.map_lat !== null && t.map_lng !== null && t.map_lat !== undefined)
    .map((t) => ({ t, m: P.haversine(gps.lat, gps.lng, Number(t.map_lat), Number(t.map_lng)) }))
    .filter((x) => x.m <= AREA_M).sort((a, b) => a.m - b.m);
  if (!near.length) return null;
  return { tenant: near[0].t, meters: near[0].m, others: near.slice(1).map((x) => ({ name: x.t.name, meters: x.m })) };
}
const km = (m) => `${(m / 1000).toFixed(1)} km`;
const positionWords = (n) => `. Nearest ski area to the position: ${n.tenant.name} (${km(n.meters)})${n.others.length ? `; also within 50 km: ${n.others.slice(0, 4).map((o) => `${o.name} (${km(o.meters)})`).join(', ')}` : ''}`;

// ---------------------------------------------------------------- d. a name
const NAME_STOP = new Set(['mountain', 'mountains', 'mount', 'mt', 'mtn', 'ski', 'skiing', 'area', 'resort', 'the', 'at', 'a', 'an', 'in', 'on', 'i', 'im', 'am', 'we', 're',
  'are', 'is', 'its', 'of', 'help', 'patrol', 'please', 'pls', 'here', 'near', 'by', 'to', 'my', 'me', 'us', 'were', 'it', 'and', 'ayuda', 'estoy', 'estamos', 'en', 'el', 'la',
  'los', 'las', 'de', 'del', 'estacion', 'esqui', 'centro', 'montana', 'cerro', 'monte', 'pista', 'por', 'favor', 'aqui', 'sta', 'st']);
function nameWords(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter((w) => w && !NAME_STOP.has(w));
}
function lev(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** Typos allowed for a name of this length (letters, no spaces): none under 5, 1 up to 7, 2 from 8. */
const allowed = (n) => (n >= 8 ? 2 : n >= 5 ? 1 : 0);
/**
 * Mountains a reply names: { exact: [...], close: [...] } (each { tenant, d }). Exact: the reply is the name (once the
 * generic words are gone). Close: the name is in the reply, or within a small typo of a run of its words, or the reply is
 * part of the name (Pine Knob for Pine Knob East and Pine Knob West).
 */
function matchName(text, list) {
  const tw = nameWords(text);
  if (!tw.length || tw.join('').length < 2) return { exact: [], close: [] };
  const tc = tw.join('');
  const exact = []; const close = [];
  for (const t of list) {
    const nw = nameWords(t.name);
    if (!nw.length) continue;
    const nc = nw.join('');
    if (tc === nc) { exact.push({ tenant: t, d: 0 }); continue; }
    let best = 9;
    for (let size = Math.max(1, nw.length - 1); size <= nw.length + 1; size++) {
      for (let i = 0; i + size <= tw.length; i++) best = Math.min(best, lev(tw.slice(i, i + size).join(''), nc));
    }
    if (nc.length >= 4 && best <= allowed(nc.length)) { close.push({ tenant: t, d: best }); continue; }
    // The reply is part of the name: every word of it is a word of the name (or one typo off a long one).
    if (tc.length >= 4 && tw.every((w) => nw.some((n) => n === w || (w.length >= 5 && lev(w, n) <= 1)))) close.push({ tenant: t, d: 3 });
  }
  close.sort((a, b) => a.d - b.d || String(a.tenant.name).localeCompare(String(b.tenant.name)));
  return { exact, close };
}

// ---------------------------------------------------------------- texts out before a mountain is known
/** May a "which ski area" text go to this phone? Not after STOP, not past 6 an hour to the phone or the shared cap. */
async function mayReply(key) {
  if (await HL.sharedOptedOut(key)) return false;
  const n = await one(pool, "SELECT COUNT(*) AS n FROM help_shared_log WHERE phone_key = ? AND direction = 'out' AND at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR", [key]);
  if (Number(n.n) >= PHONE_CAP()) return false;
  if (await HL.sharedHourCount() >= HL.SHARED_HOUR_CAP()) { logFailure({ job: 'help_shared', message: 'shared number hourly text cap reached' }); return false; }
  return true;
}
const countOut = (key) => pool.query("INSERT INTO help_shared_log (phone_key, direction, at) VALUES (?, 'out', UTC_TIMESTAMP())", [key]);
/** A reply in the webhook's answer (TwiML), counted; or null when it may not go. */
async function replyText(key, body) {
  if (!(await mayReply(key))) return null;
  await countOut(key);
  return body;
}
/** A text sent now (the job, the locate page, the console), from the shared number. */
async function sendNow(phone, body, { counted = false } = {}) {
  const SMS = require('./sms');
  const shared = await HL.sharedNumber();
  if (!SMS.enabled() || !shared) return { ok: false, error: 'Text messages are not set up' };
  if (!counted) {
    const key = HL.keyOf(phone);
    if (!(await mayReply(key))) return { ok: false, error: 'Not sent: STOP, or a cap' };
    await countOut(key);
  }
  const r = await SMS.post({ to: phone, body, from: shared });
  if (!r.ok) logFailure({ job: 'help_shared', message: r.error });
  return r;
}

// ---------------------------------------------------------------- pending requests
const pendingSql = `SELECT * FROM help_pending WHERE phone_key = ? AND resolved_at IS NULL AND expired_at IS NULL
  AND created_at >= UTC_TIMESTAMP() - INTERVAL ${PENDING_HOURS} HOUR ORDER BY id DESC LIMIT 1`;
const openPending = (key) => one(pool, pendingSql, [key]);
const textsOf = (p) => { try { const v = JSON.parse(p.texts || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** Holds a lock on the phone across the shared number while one of its texts, a locate or an assignment is handled. */
async function withLock(key, fn) {
  const conn = await pool.getConnection();
  const name = `helpshared:${key}`.slice(0, 64);
  try {
    await conn.query('SELECT GET_LOCK(?, 10)', [name]);
    return await fn();
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [name]); } catch (_) { /* goes back anyway */ }
    conn.release();
  }
}

const BY_WORDS = { tag: 'tag', position: 'position', name: 'name', console: 'hand on the platform console' };
/**
 * Sends a pending request to a mountain: the call is made there with every text in order, then the request is marked.
 * (Under the phone's lock, so it happens once; if making the call fails, the request stays pending.)
 * opt: { text (the text that matched, not yet saved), extra (words for the note), operator }. Returns the call's result.
 */
async function resolve(pend, tenant, by, base, opt = {}) {
  const shared = await HL.sharedNumber();
  const texts = textsOf(pend);
  if (opt.text) texts.push(opt.text);
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(`${String(pend.created_at instanceof Date ? pend.created_at.toISOString() : pend.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')}`)) / 60000));
  const how = by === 'console' ? `assigned by hand on the platform console${opt.operator ? ` (${opt.operator})` : ''}` : `matched by ${BY_WORDS[by]}${opt.tag ? ` (${opt.tag})` : ''}`;
  const note = `Arrived on the shared number, ${how} after ${Number.isFinite(mins) ? mins : 0} min${opt.extra || ''}`.slice(0, 500);
  const out = await HL.fromShared(lineFor(tenant, shared), pend.phone, pend.phone_key, texts.length ? texts : [{ b: pend.first_text }], base,
    { note, lang: pend.lang, lostChild: Boolean(pend.lost_child) });
  const callId = out.call_id || null;
  await pool.query('UPDATE help_pending SET resolved_tenant = ?, resolved_by = ?, resolved_at = UTC_TIMESTAMP(), resolved_call_id = ?, choices = NULL WHERE id = ?', [tenant.id, by, callId, pend.id]);
  return { ...out, tenant_id: Number(tenant.id), mountain: tenant.name, pending_id: pend.id };
}

async function newPending(from, key, words, photos, base) {
  const p = HL.parse(words, null);
  const lang = p.trigger === 'AYUDA' || HL.isSpanish(words) ? 'es' : 'en';
  const token = crypto.randomBytes(16).toString('hex');
  const lost = p.lostChild ? 1 : 0;
  const [r] = await pool.query(`INSERT INTO help_pending (phone, phone_key, first_text, texts, lang, lost_child, locate_token, created_at, last_in_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [from, key, words || '[Photo]', JSON.stringify([{ b: words || (photos.length ? '[Photo]' : ''), ph: photos, at: stamp() }]), lang, lost, token]);
  const reply = await replyText(key, with911(lang, STRINGS[lang].ask(linkOf(base, token)), lost));
  return { reply, pending: r.insertId };
}

/** A text from a phone whose request is pending: kept, then matched by a number from the list or by a name. */
async function pendingText(pend, words, photos, list, base) {
  const texts = textsOf(pend);
  texts.push({ b: words || (photos.length ? '[Photo]' : ''), ph: photos, at: stamp() });
  const lost = Boolean(pend.lost_child) || HL.LOST_CHILD.test(String(words).normalize('NFKC'));
  const lang = pend.lang === 'es' || /^\s*ayuda\b/i.test(words) ? 'es' : 'en';
  await pool.query('UPDATE help_pending SET texts = ?, last_in_at = UTC_TIMESTAMP(), lost_child = ?, lang = ? WHERE id = ?', [JSON.stringify(texts.slice(-MAX_TEXTS)), lost ? 1 : 0, lang, pend.id]);
  const now = { ...pend, texts: JSON.stringify(texts.slice(-MAX_TEXTS)), lost_child: lost ? 1 : 0, lang };
  const S = STRINGS[lang];
  // A number from the list we sent.
  let choices = [];
  try { choices = JSON.parse(pend.choices || '[]'); } catch (_) { choices = []; }
  const n = String(words).trim().match(/^#?\s*(\d)\s*[.)!]?$/);
  if (n && choices.length) {
    const pick = list.find((t) => Number(t.id) === Number(choices[Number(n[1]) - 1]));
    if (pick) return resolve(now, pick, 'name', base);
  }
  const m = matchName(words, list);
  const one1 = m.exact.length === 1 ? m.exact[0] : !m.exact.length && m.close.length === 1 ? m.close[0] : null;
  if (one1) return resolve(now, one1.tenant, 'name', base);
  const several = (m.exact.length > 1 ? m.exact : m.close).slice(0, 5);
  if (several.length > 1) {
    await pool.query('UPDATE help_pending SET choices = ? WHERE id = ?', [JSON.stringify(several.map((x) => Number(x.tenant.id))), pend.id]);
    return { reply: await replyText(pend.phone_key, with911(lang, S.list(several.map((x) => x.tenant.name)), lost)), pending: pend.id, choices: several.length };
  }
  return { reply: await replyText(pend.phone_key, with911(lang, S.again(linkOf(base, pend.locate_token)), lost)), pending: pend.id };
}

// ---------------------------------------------------------------- a text to the shared number
const HELP_WORDS = (words) => Boolean(HL.TRIGGERS[String(words).trim().replace(/[^A-Za-zÁÉÍÓÚáéíóú]+$/g, '').toUpperCase()]);

/** The phone's open call at a mountain a text can reach (a text either way in the last 2 hours), newest first. */
async function openThreadOf(key, list) {
  const ids = new Set(list.map((t) => Number(t.id)));
  const found = await rows(pool, `SELECT th.tenant_id, th.call_id FROM dispatch_sms_threads th JOIN dispatch_calls c ON c.tenant_id = th.tenant_id AND c.id = th.call_id
    WHERE th.phone_key = ? AND c.status IN (${HL.OPEN.map(() => '?').join(',')}) AND th.last_at >= UTC_TIMESTAMP() - INTERVAL ${HL.WINDOW_HOURS} HOUR ORDER BY th.last_at DESC LIMIT 10`, [key, ...HL.OPEN]);
  return found.find((x) => ids.has(Number(x.tenant_id))) || null;
}

/**
 * Handles one text Twilio posted to the shared number (signature already checked). Returns { reply } (TwiML) and how it
 * went: { call_id, tenant_id, pending, by }.
 */
async function inbound(params, base) {
  const from = HL.normalNumber(params.From);
  if (!from) return { reply: null, ignored: 'no sender' };
  const key = HL.keyOf(from);
  const sid = /^[A-Za-z0-9]{10,40}$/.test(String(params.MessageSid || params.SmsSid || '')) ? String(params.MessageSid || params.SmsSid) : null;
  if (sid) {
    const [r] = await pool.query("INSERT IGNORE INTO help_shared_log (phone_key, direction, message_sid, at) VALUES (?, 'in', ?, UTC_TIMESTAMP())", [key, sid]);
    if (!r.affectedRows) return { reply: null, duplicate: true };
  }
  if (Math.random() < 0.02) pool.query('DELETE FROM help_shared_log WHERE at < UTC_TIMESTAMP() - INTERVAL 7 DAY').catch(() => {});
  try {
    return await withLock(key, () => route(params, base, from, key));
  } catch (err) {
    if (sid) await pool.query("DELETE FROM help_shared_log WHERE direction = 'in' AND message_sid = ?", [sid]).catch(() => {});
    throw err;
  }
}

async function route(params, base, from, key) {
  const shared = await HL.sharedNumber();
  const intent = require('../routes/twilioinbound').intentOf(params);
  const words = String(params.Body || '').slice(0, 1600);
  const photos = HL.photosIn(params);
  const list = await reachable();
  const open = await openThreadOf(key, list);
  if (intent === 'stop') {
    // STOP counts for the whole shared number, at every mountain. The open call says so.
    await pool.query('INSERT IGNORE INTO help_shared_optouts (phone_key, opted_out_at) VALUES (?, UTC_TIMESTAMP())', [key]);
    if (open) await HL.note(pool, open.tenant_id, open.call_id, HL.STOPPED);
    return { reply: null, stopped: true };
  }
  const pend = await openPending(key);
  if (intent === 'start') {
    const [d] = await pool.query('DELETE FROM help_shared_optouts WHERE phone_key = ?', [key]);
    if (d.affectedRows && open) await HL.note(pool, open.tenant_id, open.call_id, 'Guest texted START: patrol can text this phone again.');
    if (!open && !pend && !HELP_WORDS(words)) return { reply: null, started: Boolean(d.affectedRows) };
  }
  const text = { b: words || (photos.length ? '[Photo]' : ''), ph: photos };
  // a. a tag
  const tagged = await byTag(words, list);
  if (tagged) {
    if (pend) return { ...(await resolve(pend, tagged.tenant, 'tag', base, { text, tag: tagged.tag })), by: 'tag' };
    const fresh = !open || Number(open.tenant_id) !== Number(tagged.tenant.id);
    const out = await HL.fromShared(lineFor(tagged.tenant, shared), from, key, [text], base, fresh ? { note: `Arrived on the shared number, matched by tag (${tagged.tag}) after 0 min` } : {});
    return { ...out, tenant_id: Number(tagged.tenant.id), by: 'tag' };
  }
  // b. the phone's open call
  if (open) {
    const t = list.find((x) => Number(x.id) === Number(open.tenant_id));
    const out = await HL.fromShared(lineFor(t, shared), from, key, [text], base, {});
    return { ...out, tenant_id: Number(t.id), by: 'open call' };
  }
  // c. a position
  const gps = HL.parse(words, null).gps;
  const near = gps ? nearest(gps, list) : null;
  if (near) {
    const extra = positionWords(near);
    if (pend) return { ...(await resolve(pend, near.tenant, 'position', base, { text, extra })), by: 'position' };
    const out = await HL.fromShared(lineFor(near.tenant, shared), from, key, [text], base, { note: `Arrived on the shared number, matched by position after 0 min${extra}` });
    return { ...out, tenant_id: Number(near.tenant.id), by: 'position' };
  }
  // d. still not known: ask, or keep asking. Never a guess.
  if (pend) {
    const out = await pendingText(pend, words, photos, list, base);
    return { ...out, by: out.call_id ? 'name' : null };
  }
  return newPending(from, key, words, photos, base);
}

// ---------------------------------------------------------------- the locate link
async function byToken(token) {
  if (!/^[0-9a-f]{32}$/.test(String(token || ''))) return null;
  return one(pool, `SELECT * FROM help_pending WHERE locate_token = ? AND created_at >= UTC_TIMESTAMP() - INTERVAL ${PENDING_HOURS} HOUR`, [token]);
}
/** What the locate page shows: waiting for a position, sent to a mountain (its name), or expired. */
async function locateState(token) {
  const p = await byToken(token);
  if (!p) return null;
  if (p.resolved_tenant) {
    const t = await one(pool, 'SELECT name FROM tenants WHERE id = ?', [p.resolved_tenant]);
    return { state: 'matched', mountain: t ? t.name : null, lang: p.lang };
  }
  return { state: p.expired_at ? 'expired' : 'waiting', mountain: null, lang: p.lang };
}
/**
 * A position from the shared locate page: the pending request goes to the nearest mountain within 50 km (and the call
 * gets the position). A request already sent to a mountain passes the position to its open call. Returns
 * { matched, mountain } or { matched: false } when no mountain is within 50 km (the request stays pending).
 */
async function locate(token, lat, lng, acc, base) {
  const p0 = await byToken(token);
  if (!p0) return null;
  return withLock(p0.phone_key, async () => {
    const p = await byToken(token);
    if (!p || p.expired_at) return null;
    const D = require('../routes/dispatch');
    const { nowIn } = require('./util');
    const place = async (tenantId, callId) => {
      const c = await one(pool, 'SELECT c.*, t.timezone FROM dispatch_calls c JOIN tenants t ON t.id = c.tenant_id WHERE c.tenant_id = ? AND c.id = ?', [tenantId, callId]);
      if (!c || !HL.OPEN.includes(c.status)) return;
      const now = nowIn(c.timezone);
      await D.relocate(c, lat, lng, acc, now);
      await HL.note(pool, tenantId, callId, `Caller shared their location${acc !== null ? ` (within about ${acc} m)` : ''}`);
    };
    if (p.resolved_tenant) {
      const t = await one(pool, "SELECT name FROM tenants WHERE id = ? AND status = 'active'", [p.resolved_tenant]);
      if (t && p.resolved_call_id) await place(p.resolved_tenant, p.resolved_call_id);
      return { matched: Boolean(t), mountain: t ? t.name : null };
    }
    const near = nearest({ lat, lng }, await reachable());
    if (!near) return { matched: false };
    const out = await resolve(p, near.tenant, 'position', base, { extra: `${positionWords(near)} (from the locate link)` });
    if (out.call_id) await place(near.tenant.id, out.call_id);
    if (out.reply) await sendNow(p.phone, out.reply, { counted: true });
    return { matched: true, mountain: near.tenant.name };
  });
}

// ---------------------------------------------------------------- the platform console
/** The requests waiting for a ski area, with their texts, oldest first (the console's banner). */
async function waiting() {
  const list = await rows(pool, `SELECT id, phone, first_text, texts, lang, lost_child, created_at, nudged_at FROM help_pending
    WHERE resolved_at IS NULL AND expired_at IS NULL AND created_at >= UTC_TIMESTAMP() - INTERVAL ${PENDING_HOURS} HOUR ORDER BY id LIMIT 100`);
  return list.map((p) => ({ id: p.id, phone: p.phone, lang: p.lang, lost_child: Boolean(p.lost_child), created_at: p.created_at, nudged: Boolean(p.nudged_at), texts: textsOf(p).map((x) => ({ body: x.b, at: x.at, photos: (x.ph || []).length })) }));
}
/** The operator sends a waiting request to a mountain by hand: the call is made there with a note. */
async function assign(id, tenantId, operator, base) {
  const p0 = await one(pool, 'SELECT phone_key FROM help_pending WHERE id = ?', [id]);
  if (!p0) return { error: 'gone' };
  return withLock(p0.phone_key, async () => {
    const p = await one(pool, `SELECT * FROM help_pending WHERE id = ? AND resolved_at IS NULL AND expired_at IS NULL`, [id]);
    if (!p) return { error: 'gone' };
    const t = (await reachable()).find((x) => Number(x.id) === Number(tenantId));
    if (!t) return { error: 'mountain' };
    const out = await resolve(p, t, 'console', base, { operator });
    if (out.reply) await sendNow(p.phone, out.reply, { counted: true });
    return out;
  });
}

// ---------------------------------------------------------------- the job (every minute)
/**
 * Texts a guest again when their request has waited 3 minutes with no mountain, and closes a request after 2 hours with
 * a last text. Each is claimed with a row update, so it goes once however many runs overlap.
 */
async function tick() {
  const out = { nudged: 0, expired: 0 };
  const due = await rows(pool, `SELECT * FROM help_pending WHERE resolved_at IS NULL AND expired_at IS NULL AND nudged_at IS NULL
    AND created_at <= UTC_TIMESTAMP() - INTERVAL ${NUDGE_MIN} MINUTE AND created_at > UTC_TIMESTAMP() - INTERVAL ${PENDING_HOURS} HOUR ORDER BY id LIMIT 200`);
  const base = require('../config').stripe.publicUrl || process.env.PUBLIC_URL || '';
  for (const p of due) {
    const [c] = await pool.query('UPDATE help_pending SET nudged_at = UTC_TIMESTAMP() WHERE id = ? AND nudged_at IS NULL AND resolved_at IS NULL', [p.id]);
    if (!c.affectedRows) continue;
    const lang = p.lang === 'es' ? 'es' : 'en';
    const r = await sendNow(p.phone, with911(lang, STRINGS[lang].nudge(linkOf(base, p.locate_token)), Boolean(p.lost_child)));
    if (r.ok) out.nudged += 1;
  }
  const old = await rows(pool, `SELECT * FROM help_pending WHERE resolved_at IS NULL AND expired_at IS NULL AND created_at <= UTC_TIMESTAMP() - INTERVAL ${PENDING_HOURS} HOUR ORDER BY id LIMIT 200`);
  for (const p of old) {
    const [c] = await pool.query('UPDATE help_pending SET expired_at = UTC_TIMESTAMP() WHERE id = ? AND expired_at IS NULL AND resolved_at IS NULL', [p.id]);
    if (!c.affectedRows) continue;
    await sendNow(p.phone, STRINGS[p.lang === 'es' ? 'es' : 'en'].expired);
    out.expired += 1;
  }
  return out;
}

/** Retention (the daily job): requests 30 days after they came in (their texts are on the call), counts after 7 days. */
async function purge() {
  const [a] = await pool.query('DELETE FROM help_pending WHERE created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY LIMIT 50000');
  const [b] = await pool.query('DELETE FROM help_shared_log WHERE at < UTC_TIMESTAMP() - INTERVAL 7 DAY LIMIT 50000');
  return { help_pending: a.affectedRows, help_shared_log: b.affectedRows };
}

module.exports = { STRINGS, inbound, reachable, byTag, nearest, matchName, nameWords, lev, locate, locateState, waiting, assign, tick, purge, linkOf, PHONE_CAP };
