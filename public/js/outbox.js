// Offline save for bedside entries. On the hill the signal comes and goes, so a vitals set, a treatment, a time stamp or
// an assessment answer that cannot reach the server is kept on this phone, shown as "waiting to send", and sent in order
// as soon as the signal returns. Each entry carries the time it was taken, so the record shows when it really happened
// (and the server marks when it arrived).
//
// Only the person who typed an entry can send it: entries are tagged with the signed-in user and stay put if someone else
// signs in on the same phone. Entries are removed from the phone once the server has them.

import { api, session, ApiError } from './api.js';
import { nowStamp } from './ui.js';

const KEY = 'so.patrol.outbox';
const KEEP_HOURS = 72; // an entry nobody has sent in three days is dropped, so patient details do not sit on a phone
const listeners = new Set();
let timer = null;
let flushing = null;

export function who() {
  try {
    const t = session.token;
    if (!t) return null;
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return `${p.tid}.${p.sub}`;
  } catch (_) { return null; }
}
function read() {
  try {
    const list = JSON.parse(globalThis.localStorage.getItem(KEY) || '[]');
    const cut = Date.now() - KEEP_HOURS * 3600000;
    const fresh = list.filter((x) => Date.parse(x.queued || 0) > cut);
    if (fresh.length !== list.length) globalThis.localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  } catch (_) { return []; }
}
function write(list) {
  try { if (list.length) globalThis.localStorage.setItem(KEY, JSON.stringify(list)); else globalThis.localStorage.removeItem(KEY); } catch (_) { /* storage blocked: entries live in memory only */ memory = list; }
  for (const fn of listeners) { try { fn(); } catch (_) { /* a listener that fails does not stop the others */ } }
}
let memory = null;
const all = () => memory || read();

/** Entries for one case that have not reached the server yet: [{ id, method, path, body, label, at, error }]. */
export function pending(caseId) {
  const me = who();
  return all().filter((x) => x.caseId === Number(caseId) && x.who === me);
}
/** How many entries on this phone belong to someone else, or to the person signed in (for the sign-out warning). */
export function waitingCounts(caseId) {
  const me = who();
  const list = all().filter((x) => caseId === undefined || x.caseId === Number(caseId));
  return { mine: list.filter((x) => x.who === me).length, others: list.filter((x) => x.who !== me).length };
}
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Did this fail because the phone could not reach the server (as opposed to the server saying no)? */
const unreachable = (err) => !(err instanceof ApiError) || err.status === 0 || err.status >= 502;
const newRef = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Sends one change. If the phone is offline (or the request cannot get through) it is kept and sent later, and the
 * result is { queued: true }. A refusal from the server (a mistake in the entry, a locked report) is thrown as usual.
 */
export async function send(method, path, body, { caseId, label: text }) {
  // A new entry carries an id from this phone, so if the answer is lost and it is sent again the server keeps one copy.
  const ref = newRef();
  const sendBody = method === 'POST' ? { ...body, client_ref: ref } : body;
  const queue = () => {
    const item = { id: ref, who: who(), caseId: Number(caseId), method, path, body: sendBody, label: text, at: nowStamp(), queued: new Date().toISOString() };
    write([...all(), item]);
    schedule();
    return { queued: true };
  };
  if (globalThis.navigator && globalThis.navigator.onLine === false) return queue();
  if (pending(caseId).some((x) => !x.error)) { const r = queue(); flush(); return r; } // keep the order: earlier entries go first
  try { return await api(method, path, sendBody); } catch (err) { if (unreachable(err)) return queue(); throw err; }
}

/** Sends what is waiting, oldest first. Stops at the first entry that still cannot get through. */
export function flush() {
  if (flushing) return flushing;
  const run = async () => {
    let sent = 0;
    const me = who();
    for (const item of all().filter((x) => x.who === me && !x.error)) {
      if (!all().some((x) => x.id === item.id)) continue; // another tab sent it meanwhile
      try {
        await api(item.method, item.path, item.body);
        write(all().filter((x) => x.id !== item.id));
        sent += 1;
      } catch (err) {
        if (unreachable(err) || err.status === 401) break; // no signal, or signed out: try again later
        // The server refused it (for example the report was locked meanwhile). Keep it, marked, so nothing is silently lost.
        write(all().map((x) => (x.id === item.id ? { ...x, error: err.message } : x)));
      }
    }
    return sent;
  };
  // One tab at a time sends, where the browser can arrange that; the ids on each entry catch any overlap anyway.
  const locks = globalThis.navigator && globalThis.navigator.locks;
  flushing = (locks ? locks.request('so-patrol-outbox', run) : run()).finally(() => { flushing = null; });
  return flushing;
}

/** Tries a refused entry again (after the report was sent back to draft, say). */
export function retry(id) { write(all().map((x) => (x.id === id ? { ...x, error: undefined } : x))); schedule(); return flush(); }
/** Drops one entry the server refused, after the patroller has seen it. */
export function discard(id) { write(all().filter((x) => x.id !== id)); }

function schedule() {
  if (timer) return;
  timer = setInterval(() => {
    if (!all().some((x) => !x.error)) { clearInterval(timer); timer = null; return; }
    if (!globalThis.navigator || globalThis.navigator.onLine !== false) flush();
  }, 20000);
  if (timer.unref) timer.unref();
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { flush(); });
  if (all().length) schedule();
}

// ---------------------------------------------------------------- cases kept for a dead spot
// The last few cases this person opened are kept on the phone for 12 hours, so a case can still be opened (to read it
// and keep adding bedside entries) where there is no signal. They belong to the person signed in and are cleared on
// sign-out with the rest of the outbox.
const CASES = 'so.patrol.cases';
const CASE_HOURS = 12; const CASE_MAX = 5;
export function keepCase(id, data) {
  try {
    const me = who(); if (!me) return;
    const cut = Date.now() - CASE_HOURS * 3600000;
    const list = JSON.parse(globalThis.localStorage.getItem(CASES) || '[]').filter((x) => x.who === me && x.at > cut && x.id !== Number(id));
    list.unshift({ id: Number(id), who: me, at: Date.now(), data });
    globalThis.localStorage.setItem(CASES, JSON.stringify(list.slice(0, CASE_MAX)));
  } catch (_) { /* storage full or blocked: the case simply is not kept */ }
}
export function keptCase(id) {
  try {
    const me = who(); const cut = Date.now() - CASE_HOURS * 3600000;
    return JSON.parse(globalThis.localStorage.getItem(CASES) || '[]').find((x) => x.who === me && x.id === Number(id) && x.at > cut) || null;
  } catch (_) { return null; }
}
export function forgetCases() { try { globalThis.localStorage.removeItem(CASES); } catch (_) { /* nothing kept */ } }
