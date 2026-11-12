// The counts beside the menu's apps (release 2026.11.21): a number shows only where something in that app waits on the
// person signed in (new requests for the front desk, overdue work orders, a patroller's open cases, reports to review,
// lesson requests to answer, rental reservations to hand out), and never when it is zero. The server works each one out
// with the same function its Today card uses (GET /nav/counts, src/lib/navcounts.js), so the menu and Today agree.
//
// Asked when the app opens, every 60 seconds while the page is in view, and after a move to another page or tab (at
// most once every 10 seconds, so tapping through tabs does not ask each time). The timed checks are polls (api.js): they
// do not count as someone using the app, so a tab nobody touches still signs out on time. Inbox keeps its own unread
// count (main.js); this never touches it.
//
// main.js loads this after the frame is built and calls start(frame). The frame draws the number in every place the app
// shows (its row, a pin to the app's own address, the collapsed icon, the phone bar and the sheet tile):
//   frame.setBadge(key, n, { says, alert })   says: the words a screen reader hears after the number; alert: red.
import { poll } from './api.js';
import { ctx } from './ui.js';

const EVERY = 60_000; // while the page is in view
const AFTER_MOVE = 10_000; // a page change asks again, but not more often than this

let frame = null;
let timer = null; // the next timed check
let trailing = null; // a check owed after a page change that came too soon
let busy = false;
let lastAt = 0; // when the last check went out
let shown = new Map(); // key -> "n|says|alert" as last drawn, so a count that went to zero is cleared
let listening = false;
let startedAt = 0;
const hidden = () => typeof document !== 'undefined' && document.hidden;

/** Draws what the server answered: every count in it, and nothing for an app that is no longer in it. */
export function paint(counts) {
  if (!frame || typeof frame.setBadge !== 'function') return;
  const next = new Map();
  for (const [key, c] of Object.entries(counts || {})) {
    const n = Number(c && c.n) || 0;
    if (key === 'inbox' || n <= 0) continue; // Inbox has its own count
    const says = (c && c.says) || 'waiting';
    const alert = Boolean(c && c.alert);
    const stamp = `${n}|${says}|${alert}`;
    next.set(key, stamp);
    if (shown.get(key) !== stamp) frame.setBadge(key, n, { says, alert });
  }
  for (const key of shown.keys()) if (!next.has(key)) frame.setBadge(key, 0, {}); // it went to zero: clear it
  shown = next;
}

/** Asks the server now (one request at a time) and draws the answer. A failed check keeps what is shown and waits for the next. */
export async function refresh() {
  if (busy || !frame || !ctx.me || ctx.me.role === 'area') return; // the read-only ski area login has no counts
  busy = true;
  lastAt = Date.now();
  const asked = frame;
  try {
    const r = await poll('/nav/counts');
    if (asked === frame && ctx.me) paint(r && r.counts);
  } catch (_) { /* offline, or signed out meanwhile: the next check tries again */ }
  busy = false;
}

function schedule() {
  clearTimeout(timer);
  if (!frame) return;
  timer = setTimeout(async () => {
    if (!ctx.me) { stop(); return; } // signed out: nothing to count
    if (!hidden()) await refresh(); // a page nobody is looking at does not ask
    schedule();
  }, EVERY);
  if (timer && timer.unref) timer.unref(); // test runners only
}

/** A move to another page or tab: ask again now, or as soon as 10 seconds have passed since the last check. */
function onMove() {
  if (!frame || !ctx.me) return;
  if (Date.now() - startedAt < 2000) return; // the first page as the app opens: start() has just asked
  const wait = lastAt + AFTER_MOVE - Date.now();
  if (wait <= 0) { refresh(); return; }
  if (trailing) return; // one is already owed
  trailing = setTimeout(() => { trailing = null; if (!hidden()) refresh(); }, wait);
  if (trailing && trailing.unref) trailing.unref();
}

/** Back in view after a while: catch up straight away instead of waiting for the next minute. */
function onVisible() {
  if (!hidden() && frame && ctx.me && Date.now() - lastAt >= EVERY) refresh();
}

/** Stops asking and forgets what was drawn (sign-out, or a new frame after signing in again). */
export function stop() {
  clearTimeout(timer); clearTimeout(trailing);
  timer = null; trailing = null; frame = null; shown = new Map(); lastAt = 0;
}

/** Called by main.js once the frame is built (again after each sign-in: the old frame's counts are dropped). */
export function start(f) {
  stop();
  if (!f || typeof f.setBadge !== 'function') return;
  frame = f;
  startedAt = Date.now();
  if (!listening) {
    listening = true;
    window.addEventListener('nav:page', onMove);
    document.addEventListener('visibilitychange', onVisible);
  }
  refresh();
  schedule();
}
