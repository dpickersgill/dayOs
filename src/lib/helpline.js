'use strict';

// Text HELP (help/sms, 2026.11.15). A guest texts the mountain's help number to reach ski patrol.
//
// One Twilio account serves every mountain (lib/sms.js). Each mountain sets its own help number in Patrol settings
// (patrol_help_lines, unique), and an inbound text finds its mountain by the number it was sent To.
//
// The conversation: one open call per phone. A text from a phone with an open call whose last activity (a text either
// way) was in the last 2 hours joins that call; anything else starts a new call, source 'sms'. The first text may carry
// a sign code ("HELP R7", looked up with places.byCode) and the help page's text fallback position ("44.27110,-71.30330
// ±12m", described with places.describe); the rest is the description. The reply (in Spanish after AYUDA or a Spanish
// text) gives the 911 line, a Locate caller link (the same token and page dispatch uses) and asks for the sign code.
// Later texts go on the call through guestmsg.fromGuest and the responders get a phone alert. Dispatch's replies go out
// through guestmsg.toGuest, which texts through lib/sms.js, which sends them from the help number (outbound below).
// When the call closes, one closing text goes out.
//
// STOP (and Twilio's other opt-out words) is recorded per mountain and phone: nothing more is texted to that phone
// from the help line until START (Twilio blocks it until then too; HELP does not undo it). A text from that phone is still taken as a call (a request for help always is).
//
// Limits: a phone's new calls are grouped like guest help requests (dispatch.js createCall); at most 20 texts out per
// call (HELP_SMS_CALL_CAP) and 300 an hour per mountain (HELP_SMS_HOURLY_CAP); a phone alert to responders at most
// once a minute per call. Help requests and their texts are patrol data: they never go to AI.
//
// The shared number (help/shared): every mountain uses one shared Verdynt/OS help number by default, and any mountain can
// switch to its own (patrol_help_lines.help_mode). On the shared number a sign's code carries the mountain's tag ("HELP BR
// R7"), and lib/sharedhelp.js finds the mountain before the text reaches the conversation here. The conversation is the
// same either way; the thread keeps the number the guest texted, so every reply goes from it. STOP to the shared number
// counts for the whole shared number (help_shared_optouts), and it has an hourly cap of its own across all mountains.
//
// Times in dispatch_sms_* are UTC; dispatch_calls and dispatch_events keep the mountain's clock (nowIn).
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const { nowIn } = require('./util');
const { logFailure } = require('./jobs');

const OPEN = ['new', 'dispatched', 'on_scene', 'transporting'];
const STOPPED = 'This phone texted STOP; replies can\'t be sent until it texts START. Call them instead.';
const WINDOW_HOURS = 2;
const LOCATE_HOURS = 2;
const CALL_CAP = () => Number(process.env.HELP_SMS_CALL_CAP) || 20;
const HOUR_CAP = () => Number(process.env.HELP_SMS_HOURLY_CAP) || 300;
const SHARED_HOUR_CAP = () => Number(process.env.HELP_SMS_SHARED_HOURLY_CAP) || 1000;
const PUSH_GAP_S = 60;
const MAX_PHOTOS = 20;

/** The words that start a request: HELP and PATROL in English, AYUDA in Spanish. */
const TRIGGERS = { HELP: 'en', PATROL: 'en', AYUDA: 'es' };

/** A US or Canadian number the way it is written on a sign: 610-555-0100. Others as stored. The guest page, the sign
 * sheets and the first reply all write numbers this way (public/js/signsheet.js has the same rule). */
const says = (p) => { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || ''); };

// What the guest reads. Plain words; never a promise of a response time.
const STRINGS = {
  en: {
    first: (mountain, link) => `${mountain} ski patrol has your message. If it is life threatening, call 911. Tap this link to send your location: ${link}. Or reply with the code on the nearest sign or lift tower.`,
    firstLost: (mountain, link) => `If it is life threatening, call 911. ${mountain} ski patrol has your message. Tap this link to send your location: ${link}. Or reply with the code on the nearest sign or lift tower.`,
    call: (phone) => ` To talk to patrol, call ${says(phone)}.`,
    closed: 'Patrol has closed your request. Reply HELP if you need patrol again.',
  },
  es: {
    first: (mountain, link) => `La patrulla de esquí de ${mountain} recibió su mensaje. Si su vida corre peligro, llame al 911. Toque este enlace para enviar su ubicación: ${link}. O responda con el código del letrero o de la torre de telesilla más cercana.`,
    firstLost: (mountain, link) => `Si su vida corre peligro, llame al 911. La patrulla de esquí de ${mountain} recibió su mensaje. Toque este enlace para enviar su ubicación: ${link}. O responda con el código del letrero o de la torre de telesilla más cercana.`,
    call: (phone) => ` Para hablar con la patrulla, llame al ${says(phone)}.`,
    closed: 'La patrulla cerró su solicitud. Responda AYUDA si necesita a la patrulla otra vez.',
  },
};

// ---------------------------------------------------------------- numbers
const E164 = /^\+[1-9]\d{7,14}$/;
/** A help or patrol number as E.164: "+16105550100", "(610) 555-0100" or "610-555-0100" (US and Canada). */
function normalNumber(s) {
  const t = String(s || '').trim().replace(/[\s().-]/g, '');
  if (E164.test(t)) return t;
  return require('./sms').e164(t);
}
/** The phone's key: 10 digits for the US and Canada, all the digits otherwise. */
function keyOf(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
}

// ---------------------------------------------------------------- reading a text
const ES_WORDS = new Set(['ayuda', 'ayudame', 'ayúdame', 'estoy', 'herido', 'herida', 'heridos', 'necesito', 'necesitamos', 'por', 'favor', 'donde', 'dónde', 'pierna', 'brazo',
  'rodilla', 'cabeza', 'caí', 'caído', 'caida', 'mi', 'hijo', 'hija', 'socorro', 'accidente', 'perdido', 'perdida', 'puedo', 'gracias', 'hola', 'aquí', 'aqui', 'duele',
  'pista', 'telesilla', 'niño', 'niña', 'estamos', 'está', 'tengo', 'nos', 'abajo', 'arriba', 'cerca', 'del', 'los', 'las', 'una', 'muy', 'con', 'para', 'que']);
/** Spanish when it has ¿, ¡ or ñ, or enough common Spanish words. */
function isSpanish(text) {
  const s = String(text || '');
  if (/[¿¡ñÑ]/.test(s)) return true;
  const words = s.toLowerCase().match(/[a-záéíóúüñ]+/g) || [];
  if (!words.length) return false;
  const hits = words.filter((w) => ES_WORDS.has(w)).length;
  return hits >= 2 && hits / words.length >= 0.3;
}

/**
 * Reads a text: the trigger word (HELP, PATROL, AYUDA) at the start, a position, candidate sign codes, and the rest as the
 * description. area: the mountain's map point { lat, lng }, or null.
 *
 * A position is "lat,lng": signed numbers with 2 to 8 decimals, not part of a longer number ("1044.27110" is not one),
 * both in range. It is taken when
 *   - it carries the help page's accuracy ("44.27110,-71.30330 ±12m", the text fallback's own format), or
 *   - it is within 50 km of the mountain's map point, or
 *   - the mountain has no map point and the comma has no space ("44.2711,-71.3033").
 * So "12.50, 7.25" (a price, a time) is not read as a position.
 */
const POS = /(?<![\d.])([-+]?\d{1,2}\.\d{2,8})(\s*),(\s*)([-+]?\d{1,3}\.\d{2,8})(?![\d.])(?:\s*(?:±|\+\/-|\+-)\s*(\d{1,6}(?:\.\d+)?)\s*m\b)?/g;
const AREA_M = 50000;
function parse(text, area = null) {
  let s = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  let trigger = null;
  // The word, then spaces and punctuation; a "-" that starts a number ("HELP -33.86,151.21") stays with the number.
  const t = s.match(/^([A-Za-zÁÉÍÓÚáéíóú]+)(?=$|[\s:,.!¡?-])(?:[\s:,.!¡?]|-(?![\d.]))*/);
  if (t && TRIGGERS[t[1].toUpperCase()]) { trigger = t[1].toUpperCase(); s = s.slice(t[0].length); }
  let gps = null;
  const hasArea = area && Number.isFinite(Number(area.lat)) && Number.isFinite(Number(area.lng)) && area.lat !== null && area.lng !== null;
  for (const g of s.matchAll(POS)) {
    const lat = Number(g[1]); const lng = Number(g[4]);
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const withAcc = g[5] !== undefined;
    const inArea = hasArea && require('./places').haversine(lat, lng, Number(area.lat), Number(area.lng)) <= AREA_M;
    const tight = g[2] === '' && g[3] === '';
    if (!(withAcc || inArea || (!hasArea && tight))) continue;
    gps = { lat, lng, accuracy: withAcc ? Math.round(Number(g[5])) : null };
    s = `${s.slice(0, g.index)} ${s.slice(g.index + g[0].length)}`.replace(/\s+/g, ' ').trim();
    break;
  }
  const words = s.split(' ').map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter(Boolean);
  // A sign code is 2 to 5 letters and digits. Words with both come first; plain words only when the text is that short.
  const mixed = words.filter((w) => /^[A-Za-z0-9]{2,5}$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w));
  const plain = words.length <= 2 ? words.filter((w) => /^[A-Za-z0-9]{2,5}$/.test(w) && !mixed.includes(w)) : [];
  const codes = [...new Set([...mixed, ...plain].map((w) => w.toUpperCase()))].slice(0, 6);
  return { trigger, gps, codes, rest: s, lostChild: LOST_CHILD.test(String(text || '').normalize('NFKC')) };
}

/** A text that says a child is lost: the help page's fallback ("lost child"), "lost kid", "niño perdido", "perdí a mi hijo". */
const LOST_CHILD = /(^|[^A-Za-z])(lost (child|kid)|ni[nñ][oa] perdid[oa]|perd[ií] a mi hij[oa])(?![A-Za-z])/i;

/** The text without the code that matched, for the description. */
function without(rest, code) {
  if (!code) return rest;
  return rest.replace(new RegExp(`(^|[^A-Za-z0-9])${code}(?=$|[^A-Za-z0-9])`, 'i'), '$1').replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,:;-]+$/g, '').trim();
}

// ---------------------------------------------------------------- settings
/**
 * The mountain's two numbers, from the one place they are kept (Patrol settings, Text HELP): help_number, the number
 * guests text (the sign sheets and the guest page's Send by text instead), and patrol_phone, the phone guests may call
 * (the guest page's Call patrol and the first reply to a text). Either may be null. Null when neither is set.
 */
async function lineOf(db, tenantId) {
  return one(db, 'SELECT help_number, patrol_phone, help_mode FROM patrol_help_lines WHERE tenant_id = ?', [tenantId]);
}
/** A mountain's own help number: the text that reached it was sent To this number. Its mode does not matter here. */
async function lineByNumber(number) {
  const n = normalNumber(number);
  if (!n) return null;
  return one(pool, `SELECT l.tenant_id, l.help_number, l.patrol_phone, t.name, t.timezone, t.status, t.help_tag FROM patrol_help_lines l JOIN tenants t ON t.id = l.tenant_id
    WHERE l.help_number = ?`, [n]);
}
/** 'own' or 'shared'. A row from before help/shared (no mode) is own when it has a help number. No row: shared. */
const modeOf = (l) => (l && l.help_mode ? l.help_mode : l && l.help_number ? 'own' : 'shared');

// ---------------------------------------------------------------- the shared number (platform setting)
const SHARED_KEY = 'shared_help_number';
let sharedCache = { at: 0, v: null };
/**
 * The shared Verdynt/OS help number (E.164), set by the platform operator in the console, else SHARED_HELP_NUMBER, else
 * null (then a mountain on the shared number has no number for texts, and its signs say Scan this code). Cached 15 s.
 */
async function sharedNumber() {
  if (Date.now() - sharedCache.at < 15000) return sharedCache.v;
  let v = null;
  try { const r = await one(pool, 'SELECT value FROM platform_settings WHERE name = ?', [SHARED_KEY]); v = r && r.value ? normalNumber(r.value) : null; } catch (_) { v = null; }
  if (!v && process.env.SHARED_HELP_NUMBER) v = normalNumber(process.env.SHARED_HELP_NUMBER);
  sharedCache = { at: Date.now(), v };
  return v;
}
const forgetShared = () => { sharedCache = { at: 0, v: null }; };
/** Is this number the shared one? */
async function isShared(number) {
  const s = await sharedNumber();
  return Boolean(s && number && normalNumber(number) === s);
}

// ---------------------------------------------------------------- the mountain's tag
// 1 to 3 letters, unique across all mountains, and never used again by another mountain once retired (help_tag_history).
// Never a word a guest might type at the start of a text: every English 1 to 3 letter word, texting short forms, Spanish
// words, and body and ski words are refused (src/data/tag-blocklist.txt), so "HELP I fell", "help im on blue run" or
// "help red run" never read as a tag. Suggested from the name, 3 letters by default: Blue Ridge is BRI or similar.
const TAG_RE = /^[A-Z]{1,3}$/;
const RESERVED = new Set(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'tag-blocklist.txt'), 'utf8')
  .split('\n').filter((l) => !/^\s*#/.test(l)).join(' ').toUpperCase().split(/\s+/).filter(Boolean));
const normalTag = (t) => String(t || '').trim().toUpperCase();
/** Why a tag cannot be used, or null when it can. */
function tagProblem(t) {
  const tag = normalTag(t);
  if (!TAG_RE.test(tag)) return 'A tag is 1 to 3 letters, like BRX';
  if (RESERVED.has(tag) || TRIGGERS[tag]) return `${tag} is a word guests might type in a text, so it cannot be a tag. Pick other letters.`;
  return null;
}
const GENERIC = new Set(['mountain', 'mountains', 'mount', 'mt', 'mtn', 'ski', 'skiing', 'area', 'resort', 'the', 'of', 'at', 'and']);
const lettersOf = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z ]+/g, ' ').trim();
/** A free tag from a mountain's name, 3 letters: initials, then initials and the next letters, then any free letters. */
function suggestTag(name, taken) {
  const all = lettersOf(name).split(/\s+/).filter(Boolean);
  const words = all.filter((w) => !GENERIC.has(w.toLowerCase()));
  const use = (words.length ? words : all.length ? all : ['X']).map((w) => w.toUpperCase());
  const tries = [];
  const initials = use.map((w) => w[0]).join('');
  const first = use[0]; const last = use[use.length - 1];
  if (use.length >= 3) tries.push(initials.slice(0, 3));
  if (use.length >= 2) { for (const ch of last.slice(1)) tries.push(`${initials.slice(0, 2)}${ch}`); for (const ch of first.slice(1)) tries.push(`${first[0]}${ch}${last[0]}`); }
  tries.push(first.slice(0, 3));
  for (const ch of first.slice(2)) tries.push(`${first.slice(0, 2)}${ch}`);
  for (const a of first.slice(1)) for (const b of first.slice(2)) tries.push(`${first[0]}${a}${b}`);
  const ok = (t) => /^[A-Z]{3}$/.test(t) && !tagProblem(t) && !taken.has(t);
  for (const t of tries) if (ok(t)) return t;
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) for (const b of A) if (ok(`${first[0]}${a}${b}`)) return `${first[0]}${a}${b}`;
  for (const a of A) for (const b of A) for (const c of A) if (ok(`${a}${b}${c}`)) return `${a}${b}${c}`;
  return null;
}
/** Tags in use now or used before by any mountain: never given to another. */
async function takenTags(db) {
  const now = (await rows(db, 'SELECT help_tag AS t FROM tenants WHERE help_tag IS NOT NULL')).map((r) => r.t);
  const old = (await rows(db, 'SELECT tag AS t FROM help_tag_history').catch(() => [])).map((r) => r.t);
  return new Set([...now, ...old]);
}
/** Keeps a retired tag: it is never given to another mountain, and a text with it still reaches this one. */
async function retireTag(db, tenantId, tag) {
  if (!tag) return;
  await db.query('INSERT INTO help_tag_history (tag, tenant_id, retired_at) VALUES (?, ?, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE retired_at = UTC_TIMESTAMP()', [tag, tenantId]);
}
/** The mountain that used this tag before, or null. */
async function oldTagOwner(db, tag) {
  const r = await one(db, 'SELECT tenant_id FROM help_tag_history WHERE tag = ?', [normalTag(tag)]).catch(() => null);
  return r ? Number(r.tenant_id) : null;
}
/**
 * The mountain's tag, given now from its name when it has none (or when the one it has became a blocked word: the old
 * one is retired). A demo mountain has none (it never takes texts).
 */
async function ensureTag(db, tenantId) {
  const t = await one(db, 'SELECT name, help_tag, sandbox_expires_at FROM tenants WHERE id = ?', [tenantId]);
  if (!t) return null;
  if (t.help_tag && !tagProblem(t.help_tag)) return t.help_tag;
  if (t.sandbox_expires_at) return t.help_tag || null;
  for (let i = 0; i < 5; i++) {
    const tag = suggestTag(t.name, await takenTags(db));
    if (!tag) return null;
    try {
      const [u] = await db.query('UPDATE tenants SET help_tag = ? WHERE id = ? AND help_tag <=> ?', [tag, tenantId, t.help_tag]);
      if (u.affectedRows && t.help_tag) await retireTag(db, tenantId, t.help_tag);
    } catch (err) { if (err.code === 'ER_DUP_ENTRY') continue; throw err; }
    const now = await one(db, 'SELECT help_tag FROM tenants WHERE id = ?', [tenantId]);
    if (now && now.help_tag && !tagProblem(now.help_tag)) return now.help_tag;
  }
  return null;
}
/** Sets the tag (platform operator or owner). The old one is retired. Throws a 400 or 409 the screen can show. */
async function setTag(db, tenantId, value) {
  const { bad, conflict } = require('./errors');
  const tag = normalTag(value);
  const why = tagProblem(tag);
  if (why) throw bad(why);
  const taken = `${tag} is, or was, another mountain's tag. Old signs may still show it, so it is never given to another mountain. Pick other letters.`;
  const other = await one(db, 'SELECT id FROM tenants WHERE help_tag = ? AND id <> ?', [tag, tenantId]);
  const was = await oldTagOwner(db, tag);
  if (other || (was && was !== Number(tenantId))) throw conflict(taken);
  const before = await one(db, 'SELECT help_tag FROM tenants WHERE id = ?', [tenantId]);
  if (before && before.help_tag === tag) return tag;
  try { await db.query('UPDATE tenants SET help_tag = ? WHERE id = ?', [tag, tenantId]); } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict(taken);
    throw err;
  }
  if (before && before.help_tag) await retireTag(db, tenantId, before.help_tag);
  if (was === Number(tenantId)) await db.query('DELETE FROM help_tag_history WHERE tag = ?', [tag]); // its own old tag, back in use
  return tag;
}
/** A sign's code with the tag, the way it is printed: "BR R7". */
const taggedCode = (tag, code) => (tag ? `${tag} ${code}` : String(code));

/**
 * Everything a screen, a sign or the guest page needs: { mode, number (what guests text now, or null), own_number,
 * shared_number, patrol_phone, tag }. A demo mountain has no number (it never takes texts).
 */
async function numbersOf(db, tenantId) {
  const l = await lineOf(db, tenantId);
  const mode = modeOf(l);
  const shared = await sharedNumber();
  const t = await one(db, 'SELECT sandbox_expires_at FROM tenants WHERE id = ?', [tenantId]);
  const demo = Boolean(t && t.sandbox_expires_at);
  const tag = await ensureTag(db, tenantId);
  const number = demo ? null : mode === 'own' ? (l && l.help_number) || null : shared;
  return { mode, number, own_number: (l && l.help_number) || null, shared_number: shared, patrol_phone: (l && l.patrol_phone) || null, tag };
}

/**
 * The text's lead after the trigger word: possible tags and codes. "BR R7", "BR-R7", "BR" (then anything) and "BRR7".
 * Returns { trigger, after (the text after the trigger, trimmed), cands: [{ tag, code, end, joined }] }, where end is
 * how much of `after` the candidate covers (tag alone, or tag and code).
 */
function leadOf(text) {
  const s = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const t = s.match(/^([A-Za-zÁÉÍÓÚáéíóú]+)(?=$|[\s:,.!¡?-])(?:[\s:,.!¡?]|-(?![\d.]))*/);
  let trigger = null; let after = s;
  if (t && TRIGGERS[t[1].toUpperCase()]) { trigger = t[1]; after = s.slice(t[0].length); }
  after = after.replace(/^[\s:,.!¡?¿#-]+/, '');
  const cands = [];
  const sep = after.match(/^([A-Za-z]{1,3})(?:\s*[-.]\s*|\s+)([A-Za-z0-9]{2,5})(?=$|[^A-Za-z0-9])/);
  if (sep) cands.push({ tag: sep[1].toUpperCase(), code: sep[2].toUpperCase(), end: sep[0].length, tagEnd: sep[1].length, joined: false });
  const alone = after.match(/^([A-Za-z]{1,3})(?=$|[^A-Za-z0-9])/);
  if (alone && !sep) cands.push({ tag: alone[1].toUpperCase(), code: null, end: alone[0].length, tagEnd: alone[0].length, joined: false });
  const joined = after.match(/^([A-Za-z0-9]{3,8})(?=$|[^A-Za-z0-9])/);
  if (joined) {
    const w = joined[1].toUpperCase();
    for (let k = 1; k <= 3; k++) {
      const tag = w.slice(0, k); const code = w.slice(k);
      if (/^[A-Z]+$/.test(tag) && /^[A-Z0-9]{2,5}$/.test(code)) cands.push({ tag, code, end: joined[0].length, tagEnd: joined[0].length, joined: true });
    }
  }
  return { trigger, after, cands: cands.filter((c) => !tagProblem(c.tag)) };
}
/** The text with the tag taken out, keeping the trigger word and the code: "HELP BR-R7 hurt" becomes "HELP R7 hurt". */
function withoutLead(lead, cand, codeFound) {
  const rest = lead.after.slice(codeFound || cand.joined ? cand.end : cand.tagEnd).replace(/^[\s:,.!-]+/, '');
  return [lead.trigger, codeFound ? cand.code : null, rest].filter(Boolean).join(' ');
}
/**
 * For a text that reached a mountain (its own number, or the shared number once the mountain is known): the text with the
 * mountain's own tag taken out of the lead, so "HELP BR R7" and "HELP BRR7" read as "HELP R7". Anything else unchanged.
 */
async function untagFor(tenantId, tag, text) {
  if (!tag) return text;
  const lead = leadOf(text);
  for (const c of lead.cands) {
    if (c.tag !== tag) continue;
    const found = c.code ? await require('./places').byCode(pool, tenantId, c.code) : null;
    if (c.joined && !found) continue; // a joined code must be a real sign here: a digit is not enough
    return withoutLead(lead, c, Boolean(found) || c.joined);
  }
  return text;
}

// ---------------------------------------------------------------- notes, places, columns
async function note(db, tenantId, callId, text) {
  const t = await one(db, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId]);
  await db.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, note) VALUES (?, ?, ?, 'note', ?)", [tenantId, callId, nowIn(t.timezone), String(text).slice(0, 500)]);
}

// place_id and place_text on dispatch_calls come from help/guest; until that is merged the place goes in location only.
let placeCols = null;
async function hasPlaceCols() {
  if (placeCols === null) {
    const r = await rows(pool, "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dispatch_calls' AND column_name IN ('place_id','place_text')");
    placeCols = r.length === 2;
  }
  return placeCols;
}
/** The location line from describe(): its words when a place is near, else the position and "No mapped place ...". */
const posWords = (gps, d) => (d && d.text ? (d.place_id ? d.text : `Phone position ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}. ${d.text}`) : `Phone position ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}`).slice(0, 255);
/** Where the place is, in words patrol uses: the place's name and the code the guest gave. */
const placeWords = (p, code) => `${p.name}${code ? ` (sign ${code})` : ''}`.slice(0, 255);

async function setPlace(tenantId, callId, place, words) {
  if (await hasPlaceCols()) await pool.query('UPDATE dispatch_calls SET location = ?, place_id = ?, place_text = ? WHERE tenant_id = ? AND id = ?', [words, place ? place.id : null, words, tenantId, callId]);
  else await pool.query('UPDATE dispatch_calls SET location = ? WHERE tenant_id = ? AND id = ?', [words, tenantId, callId]);
}

async function findCode(tenantId, codes) {
  const places = require('./places');
  for (const c of codes) {
    const p = await places.byCode(pool, tenantId, c);
    if (p) return { place: p, code: c };
  }
  return null;
}

async function setGps(tenantId, callId, tz, gps) {
  await pool.query('UPDATE dispatch_calls SET gps_lat = ?, gps_lng = ?, located_at = ?, located_accuracy_m = ? WHERE tenant_id = ? AND id = ?',
    [gps.lat, gps.lng, nowIn(tz), gps.accuracy, tenantId, callId]);
}

// ---------------------------------------------------------------- opt-out
/** Has this phone texted STOP to this number? The shared number has one list for every mountain; an own number its own. */
async function optedOut(tenantId, key, helpNumber = null) {
  if (helpNumber && await isShared(helpNumber)) return sharedOptedOut(key);
  return Boolean(await one(pool, 'SELECT 1 AS x FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [tenantId, key]));
}
async function sharedOptedOut(key) {
  return Boolean(await one(pool, 'SELECT 1 AS x FROM help_shared_optouts WHERE phone_key = ?', [key]));
}
/** Texts out on calls from the shared number in the last hour, across every mountain. Pending replies never use these. */
async function sharedHourCount() {
  const s = await sharedNumber();
  if (!s) return 0;
  const a = await one(pool, `SELECT COUNT(*) AS n FROM dispatch_sms_log l JOIN dispatch_sms_threads th ON th.tenant_id = l.tenant_id AND th.call_id = l.call_id
    WHERE l.direction = 'out' AND l.at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR AND th.help_number = ?`, [s]);
  return Number(a.n); // texts on calls only: the "which ski area" replies have their own budget (lib/sharedhelp.js)
}

// ---------------------------------------------------------------- the conversation
const threadSql = `SELECT th.*, c.status, c.call_date, c.seq, c.caller_phone, c.id AS id FROM dispatch_sms_threads th
  JOIN dispatch_calls c ON c.tenant_id = th.tenant_id AND c.id = th.call_id`;

/** The phone's open call at this mountain with activity in the last 2 hours, or null. */
async function openThread(db, tenantId, key) {
  return one(db, `${threadSql} WHERE th.tenant_id = ? AND th.phone_key = ? AND c.status IN (${OPEN.map(() => '?').join(',')})
    AND th.last_at >= UTC_TIMESTAMP() - INTERVAL ${WINDOW_HOURS} HOUR ORDER BY th.last_at DESC LIMIT 1`, [tenantId, key, ...OPEN]);
}

/** Photos from an MMS: Twilio's media addresses on our account (never the image itself). */
function mediaBase() { return `${(process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '')}/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID || ''}/Messages/`; }
function mediaOk(url) {
  const u = String(url || '');
  return u.length < 400 && Boolean(process.env.TWILIO_ACCOUNT_SID) && u.startsWith(mediaBase()) && /^[A-Za-z0-9]+\/Media\/[A-Za-z0-9]+$/.test(u.slice(mediaBase().length));
}
function photosIn(params) {
  const n = Math.min(Number(params.NumMedia) || 0, 10);
  const out = [];
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    out.push({ url: mediaOk(url) ? String(url) : null, type: String(params[`MediaContentType${i}`] || '').slice(0, 60), at: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  }
  return out;
}
async function addPhotos(tenantId, callId, list) {
  if (!list.length) return;
  const th = await one(pool, 'SELECT photos FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [tenantId, callId]); // under the phone lock
  let all = [];
  try { all = JSON.parse(th && th.photos ? th.photos : '[]'); } catch (_) { all = []; }
  all = all.concat(list).slice(0, MAX_PHOTOS);
  await pool.query('UPDATE dispatch_sms_threads SET photos = ? WHERE tenant_id = ? AND call_id = ?', [JSON.stringify(all), tenantId, callId]);
  await note(pool, tenantId, callId, list.length === 1 ? 'Guest sent a photo by text' : `Guest sent ${list.length} photos by text`);
}

/** Holds a per-phone lock while a text is handled, so two texts at once cannot open two calls. */
async function withPhoneLock(tenantId, key, fn) {
  const conn = await pool.getConnection();
  const name = `helpsms:${tenantId}:${key}`.slice(0, 64);
  try {
    await conn.query('SELECT GET_LOCK(?, 10)', [name]);
    return await fn();
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [name]); } catch (_) { /* the connection goes back anyway */ }
    conn.release();
  }
}

/**
 * Counts one text out on this call, or says why it may not go: the phone texted STOP, the call has had 20 texts, or the
 * mountain has sent its hourly limit. The first refusal on a call is noted on its timeline.
 */
async function reserve(th) {
  const tenantId = th.tenant_id; const callId = th.call_id;
  let why = null;
  const shared = th.help_number ? await isShared(th.help_number) : false;
  if (await optedOut(tenantId, th.phone_key, th.help_number)) why = STOPPED;
  if (!why && shared && await sharedHourCount() >= SHARED_HOUR_CAP()) {
    why = `The shared help number has sent ${SHARED_HOUR_CAP()} texts in the last hour, its limit. Call the guest.`;
    logFailure({ job: 'help_sms', tenant: tenantId, message: 'shared number hourly text cap reached' });
  }
  if (!why) {
    const h = await one(pool, "SELECT COUNT(*) AS n FROM dispatch_sms_log WHERE tenant_id = ? AND direction = 'out' AND at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR", [tenantId]);
    if (Number(h.n) >= HOUR_CAP()) { why = `The help line has sent ${HOUR_CAP()} texts in the last hour, its limit. Call the guest.`; logFailure({ job: 'help_sms', tenant: tenantId, message: 'hourly text cap reached' }); }
  }
  if (!why) {
    const [u] = await pool.query('UPDATE dispatch_sms_threads SET out_count = out_count + 1, last_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND out_count < ?', [tenantId, callId, CALL_CAP()]);
    if (!u.affectedRows) why = `This call has had ${CALL_CAP()} texts, the limit. Call the guest.`;
  }
  if (why) {
    const [first] = await pool.query('UPDATE dispatch_sms_threads SET cap_noted = 1 WHERE tenant_id = ? AND call_id = ? AND cap_noted = 0', [tenantId, callId]);
    if (first.affectedRows) await note(pool, tenantId, callId, `Text not sent: ${why}`);
    return { ok: false, error: why };
  }
  await pool.query("INSERT INTO dispatch_sms_log (tenant_id, call_id, direction, at) VALUES (?, ?, 'out', UTC_TIMESTAMP())", [tenantId, callId]);
  return { ok: true };
}

/**
 * For lib/sms.js: a text to a phone that is texting this mountain's help line (its call is open, or had activity in the
 * last 2 hours) goes from the help number and counts against the caps. null: an ordinary text.
 */
async function outbound(tenantId, to) {
  const key = keyOf(to);
  if (!tenantId || !key) return null;
  const th = await one(pool, `SELECT th.* FROM dispatch_sms_threads th JOIN dispatch_calls c ON c.tenant_id = th.tenant_id AND c.id = th.call_id
    WHERE th.tenant_id = ? AND th.phone_key = ? AND (c.status IN (${OPEN.map(() => '?').join(',')}) OR th.last_at >= UTC_TIMESTAMP() - INTERVAL ${WINDOW_HOURS} HOUR)
    ORDER BY th.last_at DESC LIMIT 1`, [tenantId, key, ...OPEN]);
  if (!th) return null;
  const r = await reserve(th);
  return r.ok ? { from: th.help_number, callId: th.call_id } : { blocked: r.error, from: th.help_number };
}

/** A phone alert to the people on the call (or, with no one sent yet, to patrol on duty), at most once a minute. */
async function alertNewText(tenantId, call) {
  const [claim] = await pool.query(`UPDATE dispatch_sms_threads SET last_push_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ?
    AND (last_push_at IS NULL OR last_push_at < UTC_TIMESTAMP() - INTERVAL ${PUSH_GAP_S} SECOND)`, [tenantId, call.id]);
  if (!claim.affectedRows) return 0;
  let staff = (await rows(pool, 'SELECT staff_id FROM dispatch_responders WHERE tenant_id = ? AND call_id = ?', [tenantId, call.id])).map((r) => r.staff_id);
  if (!staff.length) staff = await require('./patrolops').onDutyIds(pool, tenantId).catch(() => []);
  if (!staff.length) return 0;
  const { callNo } = require('../routes/dispatch');
  // A phone alert shows on a locked screen: never what the guest wrote (2026.11.11).
  await require('./push').notifyStaff(tenantId, staff, { title: `Call ${callNo(call)}: new text from the guest`, body: 'Open the app to read it.', url: '#/patrol/dispatch', tag: `call-${call.id}-sms` }).catch(() => {});
  return staff.length;
}

/**
 * Handles one text that Twilio posted to the help line (signature already checked).
 *   line:   the mountain's help line row with its name and time zone (lineByNumber)
 *   params: Twilio's fields (From, Body, MessageSid, NumMedia, MediaUrl0, OptOutType ...)
 *   base:   this service's public address, for the location link
 * Returns { reply } where reply is the text to answer with (TwiML), or null for no reply.
 */
async function inbound(line, params, base) {
  const tenantId = line.tenant_id;
  const from = normalNumber(params.From);
  if (!from) return { reply: null, ignored: 'no sender' };
  const key = keyOf(from);
  const sid = /^[A-Za-z0-9]{10,40}$/.test(String(params.MessageSid || params.SmsSid || '')) ? String(params.MessageSid || params.SmsSid) : null;
  // The MessageSid is claimed first, so a text Twilio sends twice at once is taken once, and given back when handling it
  // fails, so Twilio's retry (the fallback address) is taken and a text for help is never lost.
  if (sid) {
    const [r] = await pool.query("INSERT IGNORE INTO dispatch_sms_log (tenant_id, direction, message_sid, at) VALUES (?, 'in', ?, UTC_TIMESTAMP())", [tenantId, sid]);
    if (!r.affectedRows) return { reply: null, duplicate: true }; // Twilio sent this one already (a fallback retry)
  }
  try {
    return await handle(line, params, base, from, key);
  } catch (err) {
    if (sid) await pool.query("DELETE FROM dispatch_sms_log WHERE tenant_id = ? AND direction = 'in' AND message_sid = ?", [tenantId, sid]).catch(() => {});
    throw err;
  }
}

async function handle(line, params, base, from, key) {
  const tenantId = line.tenant_id;
  // Now and then, forget the 7-day-old counts.
  if (Math.random() < 0.02) pool.query('DELETE FROM dispatch_sms_log WHERE at < UTC_TIMESTAMP() - INTERVAL 7 DAY').catch(() => {});
  const intent = require('../routes/twilioinbound').intentOf(params);
  return withPhoneLock(tenantId, key, async () => {
    const open = await openThread(pool, tenantId, key);
    if (intent === 'stop') {
      await pool.query('INSERT IGNORE INTO dispatch_sms_optouts (tenant_id, phone_key, opted_out_at) VALUES (?, ?, UTC_TIMESTAMP())', [tenantId, key]);
      if (open) await note(pool, tenantId, open.call_id, STOPPED);
      return { reply: null, stopped: true };
    }
    const words = String(params.Body || '').slice(0, 1600);
    if (intent === 'start') {
      // START (or an opt-in keyword set in Twilio, such as AYUDA or PATROL: RUNBOOK.md, Text HELP set-up step 3).
      const [d] = await pool.query('DELETE FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [tenantId, key]);
      if (d.affectedRows && open) await note(pool, tenantId, open.call_id, 'Guest texted START: patrol can text this phone again.');
      // Nothing to join and no help word: Twilio sends its own START reply. A help word is a request for help, always.
      if (!open && !TRIGGERS[String(words).trim().replace(/[^A-Za-zÁÉÍÓÚáéíóú]+$/g, '').toUpperCase()]) return { reply: null, started: Boolean(d.affectedRows) };
      // With an open call the word goes on it too ("yes" may be an answer to patrol).
    }
    const photos = photosIn(params);
    const p = parse(await untagFor(tenantId, line.help_tag, words), await areaOf(tenantId));
    // A phone that texted STOP is still heard: every text is taken as a request for help. Nothing is texted to it until
    // it texts START (Twilio keeps blocking it until then, whatever we record), and the call says so.
    if (open) return followUp(line, open, p, words, photos);
    return firstText(line, from, key, p, words, photos, base);
  });
}

/** The mountain's map point { lat, lng }, or null. */
async function areaOf(tenantId) {
  const area = await one(pool, 'SELECT map_lat AS lat, map_lng AS lng FROM tenants WHERE id = ?', [tenantId]).catch(() => null);
  return area && area.lat !== null && area.lng !== null ? { lat: Number(area.lat), lng: Number(area.lng) } : null;
}

/**
 * Texts to the shared number, once lib/sharedhelp.js knows the mountain. line: the mountain as lineByNumber gives it, with
 * help_number set to the shared number. texts: [{ b: words, ph: photos }], oldest first: everything the guest texted while
 * the mountain was not known. The first opens the call (or joins the phone's open call there); the rest follow in order.
 * opt: { note (how the mountain was found, for the call), lang }. Returns what firstText or followUp returns.
 */
async function fromShared(line, from, key, texts, base, opt = {}) {
  const tenantId = line.tenant_id;
  return withPhoneLock(tenantId, key, async () => {
    const area = await areaOf(tenantId);
    let open = await openThread(pool, tenantId, key);
    let out = null;
    for (const x of texts) {
      const words = String(x.b || '').slice(0, 1600);
      const p = parse(await untagFor(tenantId, line.help_tag, words), area);
      if (!open) {
        out = await firstText(line, from, key, p, words, x.ph || [], base, opt);
        open = await openThread(pool, tenantId, key);
      } else {
        const r = await followUp(line, open, p, words, x.ph || []);
        if (!out) {
          out = r;
          if (opt.note) await note(pool, tenantId, open.call_id, opt.note);
        }
      }
    }
    return out || { reply: null };
  });
}

async function followUp(line, th, p, words, photos) {
  const tenantId = line.tenant_id;
  const call = await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, th.call_id]);
  const text = words.trim() || (photos.length ? '[Photo]' : '');
  if (text) await require('./guestmsg').fromGuest(pool, call, text, 'sms');
  await pool.query(`UPDATE dispatch_sms_threads SET last_at = UTC_TIMESTAMP()${p.trigger === 'AYUDA' ? ", lang = 'es'" : ''} WHERE tenant_id = ? AND call_id = ?`, [tenantId, th.call_id]);
  const hit = p.codes.length ? await findCode(tenantId, p.codes) : null;
  if (hit) {
    const w = placeWords(hit.place, hit.code);
    await setPlace(tenantId, call.id, hit.place, w);
    await note(pool, tenantId, call.id, `Guest texted sign code ${hit.code}: ${w}`);
  }
  if (p.gps) {
    await setGps(tenantId, call.id, line.timezone, p.gps);
    const d = await require('./places').describe(pool, tenantId, p.gps.lat, p.gps.lng, p.gps.accuracy).catch(() => null);
    if (d && d.text && !hit) await setPlace(tenantId, call.id, d.place_id ? { id: d.place_id } : null, posWords(p.gps, d));
    await note(pool, tenantId, call.id, `Guest texted their position${p.gps.accuracy !== null ? ` (within about ${p.gps.accuracy} m)` : ''}`);
  }
  await addPhotos(tenantId, call.id, photos);
  if (p.lostChild && call.call_type !== 'lost_child') {
    // A text that says a child is lost makes the call a Lost child call, High, and alerts patrol on duty as one.
    await pool.query("UPDATE dispatch_calls SET call_type = 'lost_child', priority = IF(priority IN ('low','normal'), 'high', priority) WHERE tenant_id = ? AND id = ?", [tenantId, call.id]);
    await note(pool, tenantId, call.id, 'Guest texted that a child is lost. This is now a Lost child call.');
    const D = require('../routes/dispatch');
    const now = await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, call.id]);
    await D.alertNewRequest(tenantId, { id: call.id, call_no: D.callNo(now), flood_of: null }, now.location, 'sms', { lostChild: true });
    return { reply: null, call_id: call.id, joined: true };
  }
  await alertNewText(tenantId, call);
  return { reply: null, call_id: call.id, joined: true };
}

async function firstText(line, from, key, p, words, photos, base, opt = {}) {
  const tenantId = line.tenant_id;
  const D = require('../routes/dispatch');
  const lang = opt.lang || (p.trigger === 'AYUDA' || isSpanish(words) ? 'es' : 'en');
  const hit = p.codes.length ? await findCode(tenantId, p.codes) : null;
  const described = p.gps ? await require('./places').describe(pool, tenantId, p.gps.lat, p.gps.lng, p.gps.accuracy).catch(() => null) : null;
  const location = hit ? placeWords(hit.place, hit.code) : p.gps ? posWords(p.gps, described) : 'Not given yet (Text HELP)';
  const rest = without(p.rest, hit && hit.code);
  const description = (rest || (photos.length ? 'Sent a photo' : '') || null);
  // Repeats from one phone are grouped on the board like guest help requests (never refused).
  const sender = { device: D.senderKey(tenantId, 'dev', `sms:${key}`), ip: D.senderKey(tenantId, 'ip', `sms:${key}`) };
  const tenant = { id: tenantId, timezone: line.timezone };
  // A text that says a child is lost is a Lost child call at High, the same call type the help page uses.
  const made = await D.createCall(tenant, { location, description: description ? description.slice(0, 500) : null, caller_phone: from, gps_lat: p.gps ? p.gps.lat : null, gps_lng: p.gps ? p.gps.lng : null,
    priority: p.lostChild ? 'high' : 'normal', call_type: p.lostChild ? 'lost_child' : null }, { source: 'sms', sender });
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE dispatch_calls SET locate_token = ?, locate_sent_at = ? WHERE tenant_id = ? AND id = ?', [token, nowIn(line.timezone), tenantId, made.id]);
  if (p.gps) await setGps(tenantId, made.id, line.timezone, p.gps);
  if (hit) await setPlace(tenantId, made.id, hit.place, location);
  else if (p.gps && described && described.text) await setPlace(tenantId, made.id, described.place_id ? { id: described.place_id } : null, location);
  await pool.query(`INSERT INTO dispatch_sms_threads (tenant_id, call_id, phone, phone_key, help_number, lang, opened_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [tenantId, made.id, from, key, line.help_number, lang]);
  const call = await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, made.id]);
  const text = words.trim() || (photos.length ? '[Photo]' : '');
  if (text) await require('./guestmsg').fromGuest(pool, call, text, 'sms');
  if (hit) await note(pool, tenantId, made.id, `Guest texted sign code ${hit.code}`);
  if (opt.note) await note(pool, tenantId, made.id, opt.note);
  await addPhotos(tenantId, made.id, photos);
  // Patrol on duty hears about a new text at once, the same as a guest page request or staff's Guest needs help here
  // (a lost child always on its own; a phone's repeats rate limited per group, never silenced).
  await D.alertNewRequest(tenantId, made, location, 'sms', { lostChild: p.lostChild });
  // The reply, unless the phone has texted STOP (Twilio would refuse it) or a cap is reached.
  const th = { tenant_id: tenantId, call_id: made.id, phone_key: key, help_number: line.help_number };
  const ok = await reserve(th);
  if (!ok.ok) return { reply: null, call_id: made.id, created: true };
  const S = STRINGS[lang];
  const link = `${String(base).replace(/\/$/, '')}/locate/${token}`;
  const reply = (p.lostChild || opt.lostChild ? S.firstLost : S.first)(line.name, link) + (line.patrol_phone ? S.call(line.patrol_phone) : '');
  await note(pool, tenantId, made.id, `Texted back${lang === 'es' ? ' in Spanish' : ''}: the 911 line, a location link and a request for the sign code`);
  return { reply, call_id: made.id, created: true, lang };
}

/** After dispatch closes or cancels a call that came by text: one closing text, in the guest's language. */
async function closed(tenantId, callId) {
  const th = await one(pool, 'SELECT * FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [tenantId, callId]);
  if (!th) return { sent: false };
  const [claim] = await pool.query('UPDATE dispatch_sms_threads SET closed_text_at = UTC_TIMESTAMP() WHERE tenant_id = ? AND call_id = ? AND closed_text_at IS NULL', [tenantId, callId]);
  if (!claim.affectedRows) return { sent: false, already: true };
  const SMS = require('./sms');
  if (!SMS.enabled()) return { sent: false };
  const ok = await reserve(th);
  if (!ok.ok) return { sent: false, error: ok.error };
  const r = await SMS.send({ tenantId, to: th.phone, body: STRINGS[th.lang === 'es' ? 'es' : 'en'].closed, from: th.help_number });
  await note(pool, tenantId, callId, r.ok ? 'Closing text sent to the guest' : `Closing text not sent: ${r.error}`);
  return { sent: Boolean(r.ok) };
}

/** What the call's Text HELP panel shows dispatch: the phone, language, STOP, texts used and the photos (no addresses). */
async function threadView(tenantId, callId) {
  const th = await one(pool, 'SELECT * FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [tenantId, callId]);
  if (!th) return null;
  let photos = [];
  try { photos = JSON.parse(th.photos || '[]'); } catch (_) { photos = []; }
  return {
    phone: th.phone, help_number: th.help_number, shared: await isShared(th.help_number), lang: th.lang, opted_out: await optedOut(tenantId, th.phone_key, th.help_number), texts_sent: Number(th.out_count), text_cap: CALL_CAP(),
    last_at: th.last_at, closed_text_at: th.closed_text_at, photos: photos.map((x, n) => ({ n, type: x.type, at: x.at, available: Boolean(x.url) })),
  };
}
async function photoUrl(tenantId, callId, n) {
  const th = await one(pool, 'SELECT photos FROM dispatch_sms_threads WHERE tenant_id = ? AND call_id = ?', [tenantId, callId]);
  if (!th) return null;
  let photos = [];
  try { photos = JSON.parse(th.photos || '[]'); } catch (_) { photos = []; }
  const x = photos[n];
  return x && x.url && mediaOk(x.url) ? x.url : null;
}

module.exports = {
  STRINGS, TRIGGERS, CALL_CAP, HOUR_CAP, SHARED_HOUR_CAP, WINDOW_HOURS, LOCATE_HOURS, OPEN, TAG_RE, RESERVED,
  says, normalNumber, keyOf, isSpanish, parse, without, LOST_CHILD, STOPPED, lineOf, lineByNumber, outbound, reserve, inbound, closed, threadView, photoUrl, mediaOk, optedOut,
  modeOf, sharedNumber, forgetShared, isShared, sharedOptedOut, sharedHourCount, tagProblem, suggestTag, ensureTag, setTag, oldTagOwner, takenTags, taggedCode, numbersOf, leadOf, withoutLead, untagFor,
  fromShared, areaOf, note, photosIn,
};
