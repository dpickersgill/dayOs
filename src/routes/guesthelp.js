'use strict';

// The guest's status page after asking for help (help/guest, Nov 9). No sign-in: the page holds the call's guest token
// (32 hex), and every address names the mountain too, so another mountain's address with this token finds nothing.
//
//   GET   /public/:slug/help/:token            the status in the guest's words, patrol's messages, the phone numbers
//   PATCH /public/:slug/help/:token            one or more tap answers, saved as they are given
//   POST  /public/:slug/help/:token/position   the phone's position while the page is open (live location)
//   POST  /public/:slug/help/:token/live-off   the guest turns live location off
//   POST  /public/:slug/help/:token/messages   a reply from the guest
//   POST  /public/:slug/help/:token/pass       a pass number: the server notes the pass's last lift scan today for patrol,
//                                              and tells the guest nothing about the pass
//
// Nothing here returns patrol's notes, the timeline, responders' names, the call's words or the pass hint.
// Help requests and their messages are patrol and dispatch data and never go to AI.
const express = require('express');
const { pool, rows, one } = require('../db');
const { z, validate, nowIn } = require('../lib/util');
const { notFound, conflict, AppError } = require('../lib/errors');
const { counter } = require('../middleware/rateLimit');
const GM = require('../lib/guestmsg');
const GH = require('../lib/guesthelp');

const publicRouter = express.Router();
const ACTIVE = ['new', 'dispatched', 'on_scene', 'transporting'];
const TOKEN = /^[0-9a-f]{32}$/;
const KEEP_HOURS = 24; // the status page works for a day after the request
const LIVE_HOURS = 2; // live location stops 2 hours after the request
const TRAIL = 10; // positions kept per call
const PHONE_CHANGES = 3; // times a guest may change the phone they gave, per request

// Limits per call (the guest token), on top of the guest pages' own limit per address.
const limit = (name, windowMs, envMax, max) => counter({ name, windowMs, max: Number(process.env[envMax]) || max });
const LIMITS = {
  answers: limit('help-answers', 600_000, 'HELP_ANSWER_LIMIT', 60),
  position: limit('help-position', 60_000, 'HELP_POSITION_LIMIT', 6), // a phone sends at most every 30 s, sooner only when it moves
  messages: limit('help-messages', 600_000, 'HELP_MESSAGE_LIMIT', 20),
  pass: limit('help-pass', 600_000, 'HELP_PASS_LIMIT', 3),
  passAddress: limit('help-pass-ip', 3_600_000, 'HELP_PASS_IP_LIMIT', 10),
};
async function within(which, key) {
  const { over, retryAfter } = await LIMITS[which].hit(key);
  if (over) throw Object.assign(new AppError(429, 'Too many tries. Please call patrol, or call 911 in an emergency.'), { extra: { retry_after: retryAfter } });
}

const callNo = (c) => `${String(c.call_date).slice(5).replace('-', '')}-${String(c.seq).padStart(2, '0')}`;
const ms = (local) => Date.parse(`${String(local).replace(' ', 'T')}Z`);
const ageMs = (c) => ms(nowIn(c.timezone)) - ms(c.received_at);

/** The call behind a token at this mountain, or 404. */
async function byToken(req) {
  const token = String(req.params.token || '');
  if (!TOKEN.test(token)) throw notFound('Request');
  const c = await one(pool, `SELECT c.*, t.name AS mountain, t.timezone FROM dispatch_calls c JOIN tenants t ON t.id = c.tenant_id
    WHERE t.slug = ? AND c.guest_token = ? AND c.source = 'guest'`, [String(req.params.slug || ''), token]);
  if (!c || ageMs(c) > KEEP_HOURS * 3600000) throw notFound('Request');
  return c;
}
const open = (c) => { if (!ACTIVE.includes(c.status)) throw conflict('Patrol has closed this request. If you still need help, call 911 or ask again.'); };
const note = (c, text) => pool.query("INSERT INTO dispatch_events (tenant_id, call_id, at, kind, note) VALUES (?, ?, ?, 'note', ?)", [c.tenant_id, c.id, nowIn(c.timezone), String(text).slice(0, 500)]);
const answersOf = (c) => { try { return c.answers ? JSON.parse(c.answers) : {}; } catch (_) { return {}; } };
const liveOn = (c) => ACTIVE.includes(c.status) && !c.live_off_at && ageMs(c) <= LIVE_HOURS * 3600000;

publicRouter.get('/:slug/help/:token', async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  const messages = await GM.list(pool, c.tenant_id, c.id);
  const unread = messages.filter((m) => m.direction === 'to_guest' && !m.delivered).map((m) => m.id);
  if (unread.length) await pool.query('UPDATE dispatch_messages SET delivered = ? WHERE tenant_id = ? AND call_id = ? AND id IN (?) AND delivered IS NULL', [nowIn(c.timezone), c.tenant_id, c.id, unread]);
  const a = answersOf(c);
  res.json({
    mountain: c.mountain, reference: callNo(c), status: GM.guestStatus(c.status), lost_child: c.call_type === 'lost_child', who: c.who, lang: c.lang,
    messages: messages.map((m) => ({ id: m.id, from: m.direction === 'to_guest' ? 'patrol' : 'you', body: m.body, at: m.at })),
    ...(await require('./dispatch').guestNumbers(c.tenant_id)), live: liveOn(c),
    answered: Object.keys(a).filter((k) => !['auto_location', 'lift_name', 'lift_not_sure', 'phone_changes'].includes(k)).concat(a.lift_not_sure ? ['lift'] : [], c.caller_phone ? ['phone'] : []),
  });
});

const answerFields = z.object({
  who: z.enum(['me', 'someone_with_me', 'someone_i_saw']).optional(),
  where: z.enum(['trail', 'lift', 'building', 'park', 'trees', 'parking', 'unknown']).optional(),
  lift: z.union([z.number().int().positive(), z.literal('not_sure')]).optional(),
  steep: z.enum(['green', 'blue', 'black', 'double_black', 'not_sure']).optional(),
  tower: z.string().trim().regex(/^\d{1,3}$/).optional(),
  what: z.string().trim().min(1).max(400).optional(),
  bleeding: z.boolean().optional(), cant_move: z.boolean().optional(), very_cold: z.boolean().optional(),
  phone: z.string().trim().max(30).regex(/^[0-9+()\-. ]{7,30}$/, 'Type the phone number with digits').optional(),
  child_name: z.string().trim().min(1).max(40).optional(),
  child_age: z.number().int().min(0).max(17).optional(),
  child_jacket: z.string().trim().min(1).max(40).optional(),
  child_last_seen: z.string().trim().min(1).max(200).optional(),
});
const RAISE = { low: 'high', normal: 'high' };
const URGENT = { bleeding: 'someone is bleeding', cant_move: 'someone cannot move', very_cold: 'someone is very cold' };

publicRouter.patch('/:slug/help/:token', validate(answerFields), async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  open(c);
  await within('answers', c.guest_token);
  const b = req.body;
  const a = answersOf(c);
  const sets = {};
  for (const k of ['where', 'steep', 'tower', 'what', 'bleeding', 'cant_move', 'very_cold', 'child_name', 'child_age', 'child_jacket', 'child_last_seen']) if (b[k] !== undefined) a[k] = b[k];
  if (b.lift !== undefined) {
    if (b.lift === 'not_sure') { a.lift_not_sure = true; delete a.lift_id; delete a.lift_name; } else {
      const l = await one(pool, 'SELECT id, name FROM lifts WHERE tenant_id = ? AND id = ?', [c.tenant_id, b.lift]); // this mountain's lifts only
      if (!l) throw notFound('Lift');
      a.lift_id = l.id; a.lift_name = l.name; delete a.lift_not_sure;
    }
  }
  if (b.who) sets.who = b.who;
  // The phone patrol may text: set once, then changed at most 3 times a call (each number gets texts, up to 20 a call).
  let phoneKept = false;
  if (b.phone && b.phone !== c.caller_phone) {
    if (!c.caller_phone) sets.caller_phone = b.phone;
    else if ((Number(a.phone_changes) || 0) < PHONE_CHANGES) { sets.caller_phone = b.phone; a.phone_changes = (Number(a.phone_changes) || 0) + 1; } else phoneKept = true;
  }
  // What happened, in the guest's words, becomes the call's description; a lost child's details make it up instead.
  if (c.call_type === 'lost_child' && ['child_name', 'child_age', 'child_jacket', 'child_last_seen', 'what'].some((k) => b[k] !== undefined)) {
    sets.description = [`Lost child (guest report)${a.child_name ? `: ${a.child_name}` : ''}${a.child_age != null ? `, age ${a.child_age}` : ''}.`, a.child_jacket ? `Jacket ${a.child_jacket}.` : null,
      a.child_last_seen ? `Last seen: ${a.child_last_seen}.` : null, a.what || null].filter(Boolean).join(' ').slice(0, 500);
  } else if (b.what) sets.description = b.what.slice(0, 500);
  // A yes on bleeding, cannot move or very cold raises the call to High (a dispatcher decides on Critical).
  const yes = Object.keys(URGENT).filter((k) => b[k] === true);
  if (yes.length && RAISE[c.priority]) sets.priority = RAISE[c.priority];
  // The location line: where a lost child was last seen; otherwise, when the guest gave no sign or place, what they tapped.
  if (c.call_type === 'lost_child') { if (b.child_last_seen) sets.location = `Child last seen: ${a.child_last_seen}`.slice(0, 255); }
  else if (a.auto_location) sets.location = GH.autoLocation(c, a);
  sets.answers = JSON.stringify(a);
  const keys = Object.keys(sets);
  await pool.query(`UPDATE dispatch_calls SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE tenant_id = ? AND id = ?`, [...keys.map((k) => sets[k]), c.tenant_id, c.id]);
  if (yes.length) await note(c, `Guest says ${yes.map((k) => URGENT[k]).join(', ')}.${sets.priority ? ` Priority raised to ${sets.priority === 'high' ? 'High' : sets.priority}.` : ''}`);
  if (phoneKept) await note(c, `The guest tried to change the phone number again. Kept the one they gave before (${PHONE_CHANGES} changes a request).`);
  res.json({ ok: true, ...(phoneKept ? { phone: 'kept' } : {}) });
});

publicRouter.post('/:slug/help/:token/position', validate(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracy: z.number().min(0).max(100000).optional(), age_s: z.number().min(0).max(3600).optional() })), async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  if (!liveOn(c)) return res.status(409).json({ error: 'Live location has stopped for this request.', stop: true });
  await within('position', c.guest_token);
  const now = nowIn(c.timezone);
  const taken = req.body.age_s ? new Date(ms(now) - req.body.age_s * 1000).toISOString().slice(0, 19).replace('T', ' ') : now;
  const acc = req.body.accuracy === undefined ? null : Math.round(req.body.accuracy);
  await pool.query('INSERT INTO dispatch_positions (tenant_id, call_id, lat, lng, accuracy_m, taken_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [c.tenant_id, c.id, req.body.lat, req.body.lng, acc, taken, now]);
  // Only the last 10 are kept: the trail patrol sees.
  const keep = await rows(pool, 'SELECT id FROM dispatch_positions WHERE tenant_id = ? AND call_id = ? ORDER BY id DESC LIMIT ?', [c.tenant_id, c.id, TRAIL]);
  await pool.query('DELETE FROM dispatch_positions WHERE tenant_id = ? AND call_id = ? AND id < ?', [c.tenant_id, c.id, keep[keep.length - 1].id]);
  const near = await GH.describePlace(pool, c.tenant_id, req.body.lat, req.body.lng, acc);
  const placeText = near && near.text ? String(near.text).slice(0, 255) : c.place_text;
  const a = answersOf(c);
  const sets = ['gps_lat = ?', 'gps_lng = ?', 'located_at = ?', 'located_accuracy_m = ?', 'place_text = ?']; const vals = [req.body.lat, req.body.lng, taken, acc, placeText];
  if (near && near.place_id) { sets.push('place_id = ?'); vals.push(near.place_id); }
  if (a.auto_location && c.call_type !== 'lost_child') { sets.push('location = ?'); vals.push(GH.autoLocation({ place_text: placeText, gps_lat: req.body.lat, gps_lng: req.body.lng, located_accuracy_m: acc }, a)); }
  await pool.query(`UPDATE dispatch_calls SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`, [...vals, c.tenant_id, c.id]);
  res.json({ ok: true });
});

publicRouter.post('/:slug/help/:token/live-off', async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  if (!c.live_off_at) {
    await pool.query('UPDATE dispatch_calls SET live_off_at = ? WHERE tenant_id = ? AND id = ?', [nowIn(c.timezone), c.tenant_id, c.id]);
    if (ACTIVE.includes(c.status)) await note(c, 'The guest turned off live location.');
  }
  res.json({ ok: true });
});

publicRouter.post('/:slug/help/:token/messages', validate(z.object({ body: z.string().trim().min(1).max(GM.MAX) })), async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  open(c);
  await within('messages', c.guest_token);
  const out = await GM.fromGuest(pool, c, req.body.body, 'page');
  res.status(201).json({ ok: true, id: out.id });
});

// With the guest's consent (they type or scan it themselves): the pass's last lift scan today at this mountain, stored on
// the call for patrol as { lift, minutes_ago }. The answer to the guest is the same whatever was found.
publicRouter.post('/:slug/help/:token/pass', validate(z.object({ number: z.string().trim().min(4).max(40) })), async (req, res) => {
  const c = await byToken(req);
  res.set('Cache-Control', 'no-store');
  open(c);
  await within('pass', c.guest_token);
  await within('passAddress', `${c.tenant_id}|${req.ip}`);
  const hint = await GH.passHint(pool, c.tenant_id, req.body.number, c.timezone);
  await pool.query('UPDATE dispatch_calls SET last_scan_hint = ? WHERE tenant_id = ? AND id = ?', [JSON.stringify(hint || { none: true }), c.tenant_id, c.id]);
  await note(c, hint ? 'The guest gave their pass number. Its last lift scan today is on the call.' : 'The guest gave a pass number. No lift scan today was found for it.');
  res.json({ ok: true });
});

module.exports = { publicRouter };
