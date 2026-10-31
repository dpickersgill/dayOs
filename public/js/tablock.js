// Tab lock: each tab of the app watches its own use (pointer, keys, touch, scroll, coming back into view). A tab nobody has
// used for 10 minutes locks itself (main.js shows the "Locked after 10 minutes" screen); the other tabs carry on.
//
// Tabs signed in with "Remember me" share one token (api.js). Each such tab keeps a small record in localStorage
// (so.tab.<id>: when it was last used, a heartbeat, whether it is locked). When every live tab of the browser has been idle
// for 10 minutes, or locked, the shared token is removed and the server session is ended. When the last tab closes, the
// token is moved aside into that tab's own storage (a reload puts it back) and the server is told the session is closing:
// it ends two minutes later unless it is used again. The server's 60-minute idle limit stays as the backstop.
//
// Test hook: window.__SO_IDLE_SPEED__ (set before the app loads) makes every clock here run that many times faster. It can
// only shorten the 10 minutes, never stretch them, and nothing in the app sets it.

import { session } from './api.js';

const SPEED = (() => { const n = Number(globalThis.__SO_IDLE_SPEED__); return Number.isFinite(n) && n > 1 ? Math.min(n, 100000) : 1; })();
export const LOCK_MINUTES = 10;
const LOCK_MS = (LOCK_MINUTES * 60_000) / SPEED;
const BEAT_MS = Math.max(40, 15_000 / SPEED); // how often each tab says it is still open (and checks its own clock)
const ALIVE_MS = Math.max(BEAT_MS * 4, 180_000 / SPEED, 3000); // a record older than this belongs to a tab that is gone (hidden tabs tick slowly)
// A shared token found when a tab opens, with no tab heard from in this long, was left by a browser that crashed or was
// killed (a normal close takes the token away): it is dropped and its session ended. Generous, because a browser may
// suspend a tab in the background for a while.
const STALE_MS = Math.max(ALIVE_MS, (15 * 60_000) / SPEED);
const FORGET_MS = Math.max(STALE_MS * 4, 3_600_000 / SPEED); // a record this old is removed
const PREFIX = 'so.tab.';
const HANDOFF = 'so.handoff'; // the shared token, kept in this tab's own storage while it reloads

const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
let seen = Date.now();
let hooks = { enabled: () => false, awake: () => false, onLock() {}, onAllIdle() {} };
let timer = null;

const ls = () => { try { return globalThis.localStorage; } catch (_) { return null; } };
const ss = () => { try { return globalThis.sessionStorage; } catch (_) { return null; } };

function records(within = ALIVE_MS) {
  const out = [];
  const st = ls();
  if (!st) return out;
  const now = Date.now();
  for (let i = st.length - 1; i >= 0; i -= 1) {
    const k = st.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    let r = null;
    try { r = JSON.parse(st.getItem(k)); } catch (_) { /* a broken record */ }
    const age = r ? now - Number(r.beat) : Infinity;
    if (!(age < FORGET_MS)) { try { st.removeItem(k); } catch (_) { /* fine */ } continue; } // a tab long gone
    if (!(age < within)) continue; // not heard from lately: gone, or asleep in the background
    out.push({ ...r, id: k.slice(PREFIX.length) });
  }
  return out;
}

function writeOwn() {
  const st = ls();
  if (!st) return;
  const locked = session.locked();
  const shared = session.shared || Boolean(locked && locked.shared);
  try { st.setItem(PREFIX + id, JSON.stringify({ seen, beat: Date.now(), locked: Boolean(locked), shared })); } catch (_) { /* full or blocked */ }
}

/** True when every live tab sharing the token has been idle 10 minutes, or is locked. */
export function allIdle(now = Date.now()) {
  const shared = records().filter((r) => r.shared);
  return shared.length > 0 && shared.every((r) => r.locked || now - Number(r.seen) >= LOCK_MS);
}

/** The shared session is over: the token leaves this browser and the server ends the session (best effort). */
function endShared() {
  const token = session.sharedToken();
  if (!token) return;
  session.setSharedToken(null);
  fetch('/api/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` }, keepalive: true }).catch(() => { /* it expires on its own */ });
  hooks.onAllIdle();
}

function tick() {
  const now = Date.now();
  if (hooks.awake()) seen = now; // a screen meant to stay up (the patrol room) counts as in use
  writeOwn();
  if (hooks.enabled() && !session.locked() && session.token && now - seen >= LOCK_MS) hooks.onLock();
  if (session.sharedToken() && allIdle(now)) endShared();
}

/** Someone used this tab. */
export function activity() {
  const now = Date.now();
  if (now - seen < 1000 / SPEED) return; // a burst of events writes once
  seen = now;
  if (!session.locked()) writeOwn();
}

/** Check now (after this tab locked itself): ends the shared session when no tab is in use any more. */
export function checkNow() { writeOwn(); if (session.sharedToken() && allIdle()) endShared(); }

/** Signed in (or out) in this tab: say so at once, so a tab opened next finds this one. */
export function refresh() { seen = Date.now(); writeOwn(); }

/** How long until this tab locks, in ms (for the tests). */
export function msLeft() { return Math.max(0, LOCK_MS - (Date.now() - seen)); }

// A reload of the last tab: put the shared token back where every tab reads it.
function restoreHandoff() {
  const st = ss();
  if (!st) return false;
  let kept = null;
  try { kept = st.getItem(HANDOFF); st.removeItem(HANDOFF); } catch (_) { return false; }
  if (kept && !session.sharedToken()) { session.setSharedToken(kept); return true; }
  return false;
}

function closingNotice(token) {
  fetch('/api/v1/auth/closing', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-poll': '1' }, keepalive: true }).catch(() => { /* the idle limit ends it */ });
}

// This tab is going (closed, reloaded or sent elsewhere). The last one out takes the shared token with it.
function leaving() {
  const st = ls();
  try { if (st) st.removeItem(PREFIX + id); } catch (_) { /* fine */ }
  if (session.locked()) return;
  const token = session.token;
  if (!token) return;
  if (!session.shared) { closingNotice(token); return; } // this tab's own session: a reload uses it again at once
  if (records().some((r) => r.shared && r.id !== id)) return; // other tabs still use it
  try { ss().setItem(HANDOFF, token); } catch (_) { /* a reload asks to sign in */ }
  session.setSharedToken(null);
  closingNotice(token);
}

/**
 * Starts the watch. enabled(): whether this tab may lock now (not on a shared terminal or the patrol-room screen).
 * awake(): this tab counts as in use however long nobody touches it. onLock(): lock this tab.
 */
export function startTabWatch(h) {
  hooks = { ...hooks, ...h };
  seen = Date.now();
  writeOwn();
  clearInterval(timer);
  timer = setInterval(tick, BEAT_MS);
  if (timer && timer.unref) timer.unref(); // (test runners only)
}

// A shared token left behind by a browser that did not close normally (see STALE_MS).
function dropStale() {
  if (!session.sharedToken()) return;
  if (records(STALE_MS).some((r) => r.shared)) return;
  endShared();
}

if (!restoreHandoff()) dropStale();
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', leaving);
  window.addEventListener('pageshow', (e) => { if (e.persisted) { restoreHandoff(); seen = Date.now(); writeOwn(); } });
}
