'use strict';

// The guest side of asking ski patrol for help (help/guest, Nov 9): the pieces the public routes and the dispatch view
// share. The guest's answers are patrol and dispatch data and never go to AI (test/ai-patrol-line.test.js).
const { one } = require('../db');

/** The page language from the phone's Accept-Language header: 'es' when Spanish comes before English, else 'en'. */
function langOf(header) {
  const prefs = String(header || '').split(',').map((part, i) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1, i };
  }).filter((p) => p.tag && p.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const p of prefs) {
    if (p.tag === 'es' || p.tag.startsWith('es-')) return 'es';
    if (p.tag === 'en' || p.tag.startsWith('en-')) return 'en';
  }
  return 'en';
}

/** help/places builds lib/places.js; until it is merged (or its table is there) the sign code and the place words are skipped. */
let stand = null; // tests only: a stand-in for lib/places.js (usePlaces)
const usePlaces = (lib) => { stand = lib; };
function placesLib() {
  if (stand) return stand;
  try {
    const p = require('./places');
    return p && typeof p.byCode === 'function' ? p : null;
  } catch (_) { return null; }
}
const CODE = /^[A-Za-z0-9]{2,5}$/;
async function placeByCode(db, tenantId, code) {
  const P = placesLib();
  if (!P || !CODE.test(String(code || ''))) return null;
  try { return (await P.byCode(db, tenantId, String(code).toUpperCase())) || null; } catch (_) { return null; }
}
async function describePlace(db, tenantId, lat, lng, acc) {
  const P = placesLib();
  if (!P || typeof P.describe !== 'function' || lat == null || lng == null) return null;
  try { return (await P.describe(db, tenantId, Number(lat), Number(lng), acc == null ? null : Number(acc))) || null; } catch (_) { return null; }
}

// The tap answers, in the words patrollers use.
const WHO = { me: 'The person asking', someone_with_me: 'Someone with the person asking', someone_i_saw: 'Someone the person asking saw' };
const WHERE = { trail: 'On a trail', lift: 'At a lift', building: 'In a building', park: 'In the terrain park', trees: 'In the trees or off a trail', parking: 'In the parking lot', unknown: 'Does not know' };
const STEEP = { green: 'Green circle (easiest)', blue: 'Blue square (more difficult)', black: 'Black diamond (most difficult)', double_black: 'Double black diamond (experts only)', not_sure: 'Not sure' };
const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);

/** [{ label, value, alert? }] in the order the guest is asked, for the dispatch view. Only what was answered. */
function answerWords(a) {
  if (!a || typeof a !== 'object') return [];
  const out = [];
  const add = (label, value, alert = false) => { if (value !== null && value !== undefined && value !== '') out.push({ label, value: String(value), ...(alert ? { alert: true } : {}) }); };
  if (a.child_name || a.child_age != null || a.child_jacket || a.child_last_seen) {
    add('Child\'s first name', a.child_name);
    add('Child\'s age', a.child_age);
    add('Jacket color', a.child_jacket);
    add('Last seen', a.child_last_seen);
  }
  add('Where they are', WHERE[a.where]);
  add('Last lift ridden', a.lift_not_sure ? 'Not sure' : a.lift_name);
  add('How steep', STEEP[a.steep]);
  add('Lift tower number', a.tower);
  add('What happened', a.what);
  add('Anyone bleeding', yesNo(a.bleeding), a.bleeding === true);
  add('Anyone who cannot move', yesNo(a.cant_move), a.cant_move === true);
  add('Anyone very cold', yesNo(a.very_cold), a.very_cold === true);
  return out;
}

/** The pass hint for dispatch, in plain words: "Last lift scan: Summit Quad, about 25 minutes before the request." */
function scanHintWords(raw) {
  let h = raw;
  if (typeof raw === 'string') { try { h = JSON.parse(raw); } catch (_) { return null; } }
  if (!h || typeof h !== 'object') return null;
  if (h.none) return 'The guest gave a pass number. It has no lift scan today.';
  return `Last lift scan today: ${h.lift}, about ${h.minutes_ago} minute${h.minutes_ago === 1 ? '' : 's'} before the guest asked.`;
}

/**
 * The last gate scan today of one pass at this mountain only: { lift, minutes_ago } or null. The number is matched to a
 * ticket code (or a scan's own code) of this mountain; another mountain's passes are never looked at.
 */
async function passHint(db, tenantId, number, tz) {
  const code = String(number || '').replace(/\s+/g, '').toUpperCase().slice(0, 20);
  if (code.length < 4) return null;
  const t = await one(db, 'SELECT id FROM tickets WHERE tenant_id = ? AND code = ?', [tenantId, code]);
  const sc = await one(db, `SELECT location, scanned_at FROM scans WHERE tenant_id = ? AND result = 'ok' AND location IS NOT NULL
    AND scanned_at >= UTC_TIMESTAMP() - INTERVAL 18 HOUR AND (code = ? OR ticket_id = ?) ORDER BY scanned_at DESC LIMIT 1`, [tenantId, code, t ? t.id : 0]);
  if (!sc) return null;
  const at = new Date(`${String(sc.scanned_at).replace(' ', 'T')}Z`);
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  if (day(at) !== day(new Date())) return null; // today at the mountain only
  return { lift: String(sc.location).slice(0, 100), minutes_ago: Math.max(0, Math.floor((Date.now() - at.getTime()) / 60000)) };
}

/** Distance in meters between two points (for live location: a phone that moved more than 25 m sends at once). */
function meters(a, b) {
  const R = 6371000; const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * The call's location line when the guest gave no sign and typed no place: the mapped place near the phone (help/places),
 * then what they tapped (lift and tower, where they are), then the phone's position.
 */
function autoLocation({ place_text: placeText, gps_lat: lat, gps_lng: lng, located_accuracy_m: acc }, a = {}) {
  const parts = [];
  if (placeText) parts.push(placeText);
  if (a.lift_name && a.tower) parts.push(`${a.lift_name} tower ${a.tower}`);
  else if (a.tower) parts.push(`Lift tower ${a.tower}`);
  else if (a.lift_name) parts.push(`Last rode ${a.lift_name}`);
  if (a.where && a.where !== 'unknown') parts.push(WHERE[a.where]);
  // "No mapped place within 600 m" (help/places) is said, and the phone's position follows it.
  if ((!parts.length || /^No mapped place/.test(String(placeText || ''))) && lat != null && lng != null) parts.push(`Phone location${acc != null ? `, within about ${acc} m` : ''}`);
  return (parts.join('. ') || 'Not given yet (guest help page)').slice(0, 255);
}

module.exports = { langOf, placeByCode, describePlace, placesLib, usePlaces, answerWords, scanHintWords, passHint, meters, autoLocation, WHO, WHERE, STEEP };
