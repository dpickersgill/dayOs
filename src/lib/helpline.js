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
// from the help line until START. A text from that phone is still taken as a call (a request for help always is).
//
// Limits: a phone's new calls are grouped like guest help requests (dispatch.js createCall); at most 20 texts out per
// call (HELP_SMS_CALL_CAP) and 300 an hour per mountain (HELP_SMS_HOURLY_CAP); a phone alert to responders at most
// once a minute per call. Help requests and their texts are patrol data: they never go to AI.
//
// Times in dispatch_sms_* are UTC; dispatch_calls and dispatch_events keep the mountain's clock (nowIn).
const crypto = require('crypto');
const { pool, rows, one } = require('../db');
const { nowIn } = require('./util');
const { logFailure } = require('./jobs');

const OPEN = ['new', 'dispatched', 'on_scene', 'transporting'];
const WINDOW_HOURS = 2;
const LOCATE_HOURS = 2;
const CALL_CAP = () => Number(process.env.HELP_SMS_CALL_CAP) || 20;
const HOUR_CAP = () => Number(process.env.HELP_SMS_HOURLY_CAP) || 300;
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
    call: (phone) => ` To talk to patrol, call ${says(phone)}.`,
    closed: 'Patrol has closed your request. Reply HELP if you need patrol again.',
  },
  es: {
    first: (mountain, link) => `La patrulla de esquí de ${mountain} recibió su mensaje. Si su vida corre peligro, llame al 911. Toque este enlace para enviar su ubicación: ${link}. O responda con el código del letrero o de la torre de telesilla más cercana.`,
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
 * Reads a text: the trigger word (HELP, PATROL, AYUDA) at the start, a position ("44.27110,-71.30330 ±12m", from the
 * help page's text fallback, the ± part optional), candidate sign codes, and the rest as the description.
 */
function parse(text) {
  let s = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  let trigger = null;
  const t = s.match(/^([A-Za-zÁÉÍÓÚáéíóú]+)(?=$|[\s:,.!¡?-])[\s:,.!¡?-]*/);
  if (t && TRIGGERS[t[1].toUpperCase()]) { trigger = t[1].toUpperCase(); s = s.slice(t[0].length); }
  let gps = null;
  const g = s.match(/(-?\d{1,2}\.\d{2,8})\s*,\s*(-?\d{1,3}\.\d{2,8})(?:\s*(?:±|\+\/-|\+-)\s*(\d{1,6}(?:\.\d+)?)\s*m\b)?/);
  if (g) {
    const lat = Number(g[1]); const lng = Number(g[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      gps = { lat, lng, accuracy: g[3] !== undefined ? Math.round(Number(g[3])) : null };
      s = `${s.slice(0, g.index)} ${s.slice(g.index + g[0].length)}`.replace(/\s+/g, ' ').trim();
    }
  }
  const words = s.split(' ').map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')).filter(Boolean);
  // A sign code is 2 to 5 letters and digits. Words with both come first; plain words only when the text is that short.
  const mixed = words.filter((w) => /^[A-Za-z0-9]{2,5}$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w));
  const plain = words.length <= 2 ? words.filter((w) => /^[A-Za-z0-9]{2,5}$/.test(w) && !mixed.includes(w)) : [];
  const codes = [...new Set([...mixed, ...plain].map((w) => w.toUpperCase()))].slice(0, 6);
  return { trigger, gps, codes, rest: s };
}

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
  return one(db, 'SELECT help_number, patrol_phone FROM patrol_help_lines WHERE tenant_id = ?', [tenantId]);
}
async function lineByNumber(number) {
  const n = normalNumber(number);
  if (!n) return null;
  return one(pool, `SELECT l.tenant_id, l.help_number, l.patrol_phone, t.name, t.timezone, t.status FROM patrol_help_lines l JOIN tenants t ON t.id = l.tenant_id
    WHERE l.help_number = ?`, [n]);
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
async function optedOut(tenantId, key) {
  return Boolean(await one(pool, 'SELECT 1 AS x FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [tenantId, key]));
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
  if (await optedOut(tenantId, th.phone_key)) why = 'This phone texted STOP to the help line, so patrol cannot text it. Call them.';
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
  if (sid) {
    const [r] = await pool.query("INSERT IGNORE INTO dispatch_sms_log (tenant_id, direction, message_sid, at) VALUES (?, 'in', ?, UTC_TIMESTAMP())", [tenantId, sid]);
    if (!r.affectedRows) return { reply: null, duplicate: true }; // Twilio sent this one already (a fallback retry)
  }
  // Now and then, forget the 7-day-old counts.
  if (Math.random() < 0.02) pool.query('DELETE FROM dispatch_sms_log WHERE at < UTC_TIMESTAMP() - INTERVAL 7 DAY').catch(() => {});
  const intent = require('../routes/twilioinbound').intentOf(params);
  return withPhoneLock(tenantId, key, async () => {
    const open = await openThread(pool, tenantId, key);
    if (intent === 'stop') {
      await pool.query('INSERT IGNORE INTO dispatch_sms_optouts (tenant_id, phone_key, opted_out_at) VALUES (?, ?, UTC_TIMESTAMP())', [tenantId, key]);
      if (open) await note(pool, tenantId, open.call_id, 'Guest texted STOP: patrol can no longer text this phone. Call them.');
      return { reply: null, stopped: true };
    }
    if (intent === 'start') {
      const [d] = await pool.query('DELETE FROM dispatch_sms_optouts WHERE tenant_id = ? AND phone_key = ?', [tenantId, key]);
      if (d.affectedRows) {
        if (open) await note(pool, tenantId, open.call_id, 'Guest texted START: patrol can text this phone again.');
        return { reply: null, started: true }; // Twilio sends its own START reply
      }
      if (!open) return { reply: null }; // a plain "yes" or "start" with nothing to join
    }
    const words = String(params.Body || '').slice(0, 1600);
    const photos = photosIn(params);
    const p = parse(words);
    if (open) return followUp(line, open, p, words, photos);
    return firstText(line, from, key, p, words, photos, base);
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
    if (d && d.text && !hit) await setPlace(tenantId, call.id, d.place_id ? { id: d.place_id } : null, d.text.slice(0, 255));
    await note(pool, tenantId, call.id, `Guest texted their position${p.gps.accuracy !== null ? ` (within about ${p.gps.accuracy} m)` : ''}`);
  }
  await addPhotos(tenantId, call.id, photos);
  await alertNewText(tenantId, call);
  return { reply: null, call_id: call.id, joined: true };
}

async function firstText(line, from, key, p, words, photos, base) {
  const tenantId = line.tenant_id;
  const D = require('../routes/dispatch');
  const lang = p.trigger === 'AYUDA' || isSpanish(words) ? 'es' : 'en';
  const hit = p.codes.length ? await findCode(tenantId, p.codes) : null;
  const described = p.gps ? await require('./places').describe(pool, tenantId, p.gps.lat, p.gps.lng, p.gps.accuracy).catch(() => null) : null;
  const location = hit ? placeWords(hit.place, hit.code)
    : described && described.text ? described.text.slice(0, 255)
      : p.gps ? `Phone position ${p.gps.lat.toFixed(5)}, ${p.gps.lng.toFixed(5)}`
        : 'Not given yet (Text HELP)';
  const rest = without(p.rest, hit && hit.code);
  const description = (rest || (photos.length ? 'Sent a photo' : '') || null);
  // Repeats from one phone are grouped on the board like guest help requests (never refused).
  const sender = { device: D.senderKey(tenantId, 'dev', `sms:${key}`), ip: D.senderKey(tenantId, 'ip', `sms:${key}`) };
  const tenant = { id: tenantId, timezone: line.timezone };
  const made = await D.createCall(tenant, { location, description: description ? description.slice(0, 500) : null, caller_phone: from, gps_lat: p.gps ? p.gps.lat : null, gps_lng: p.gps ? p.gps.lng : null, priority: 'normal' }, { source: 'sms', sender });
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE dispatch_calls SET locate_token = ?, locate_sent_at = ? WHERE tenant_id = ? AND id = ?', [token, nowIn(line.timezone), tenantId, made.id]);
  if (p.gps) await setGps(tenantId, made.id, line.timezone, p.gps);
  if (hit) await setPlace(tenantId, made.id, hit.place, location);
  else if (described && described.text) await setPlace(tenantId, made.id, described.place_id ? { id: described.place_id } : null, location);
  await pool.query(`INSERT INTO dispatch_sms_threads (tenant_id, call_id, phone, phone_key, help_number, lang, opened_at, last_at)
    VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`, [tenantId, made.id, from, key, line.help_number, lang]);
  const call = await one(pool, 'SELECT * FROM dispatch_calls WHERE tenant_id = ? AND id = ?', [tenantId, made.id]);
  const text = words.trim() || (photos.length ? '[Photo]' : '');
  if (text) await require('./guestmsg').fromGuest(pool, call, text, 'sms');
  if (hit) await note(pool, tenantId, made.id, `Guest texted sign code ${hit.code}`);
  await addPhotos(tenantId, made.id, photos);
  if (sender.alert) {
    const on = await require('./patrolops').onDutyIds(pool, tenantId).catch(() => []);
    if (on.length) require('./push').notifyStaff(tenantId, on, { title: 'Text HELP: many requests from one phone', body: 'They are grouped on the dispatch board. Check each place listed.', url: '#/patrol/dispatch', tag: `flood-${sender.alert}` }).catch(() => {});
  }
  // The reply, unless the phone has texted STOP (Twilio would refuse it) or a cap is reached.
  const th = { tenant_id: tenantId, call_id: made.id, phone_key: key };
  const ok = await reserve(th);
  if (!ok.ok) return { reply: null, call_id: made.id, created: true };
  const S = STRINGS[lang];
  const link = `${String(base).replace(/\/$/, '')}/locate/${token}`;
  const reply = S.first(line.name, link) + (line.patrol_phone ? S.call(line.patrol_phone) : '');
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
    phone: th.phone, help_number: th.help_number, lang: th.lang, opted_out: await optedOut(tenantId, th.phone_key), texts_sent: Number(th.out_count), text_cap: CALL_CAP(),
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
  STRINGS, TRIGGERS, CALL_CAP, HOUR_CAP, WINDOW_HOURS, LOCATE_HOURS,
  says, normalNumber, keyOf, isSpanish, parse, without, lineOf, lineByNumber, outbound, reserve, inbound, closed, threadView, photoUrl, mediaOk, optedOut,
};
