// Offline save for bedside entries. On the hill the signal comes and goes, so a vitals set, a treatment, a time stamp,
// an assessment answer, or what is collected before the patient leaves (contact details, a signature, a witness, a skip),
// that cannot reach the server is kept on this phone, shown as "waiting to send", and sent in order
// as soon as the signal returns. Each entry carries the time it was taken, so the record shows when it really happened
// (and the server marks when it arrived).
//
// Only the person who typed an entry can send it: entries are tagged with the signed-in user and stay put if someone else
// signs in on the same phone. Entries are removed from the phone once the server has them.
//
// Encrypted on the phone: what is kept is sealed (AES-GCM) with a key that belongs to the signed-in person on this device and
// comes from the server at sign-in (GET /auth/me, device_key). It changes when every session of the login ends (password
// change, Sign out everywhere), and differs from phone to phone (2026.11.11). The browser holds it as a key that cannot be
// read back out (non-extractable), in this tab's memory only, so a lost
// phone, a shared tablet or another person signing in finds sealed data it cannot read. Until the key arrives, entries are
// held in memory only, never written in the clear. Each person's entries are sealed separately; the only thing kept in the
// clear is how many entries each person has waiting (for the sign-out warning).

import { api, session, ApiError } from './api.js';
import { nowStamp } from './ui.js';

const LEGACY = 'so.patrol.outbox'; // plain text, before 2026.10.16: read once, sealed, then removed
const BOX = (w) => `so.patrol.outbox.${w}`;
const COUNTS = 'so.patrol.outbox.counts';
const KEY_SLOT = 'so.dk';
// An entry nobody has sent in three days is kept (sealed) and shown with a warning: it is part of a patient record, so it
// is never dropped without the patroller seeing it (they send it, or discard it).
const KEEP_HOURS = 72;
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

// ---------------------------------------------------------------- sealing
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
const store = () => { try { return globalThis.localStorage; } catch (_) { return null; } };
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
let key = null; let keyOwner = null;

async function seal(value) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
async function open(text, k = key) {
  const o = JSON.parse(text);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, k, unb64(o.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
/** Opens with the new key, or with the key this tab held before it changed (then persist() seals it again with the new one). */
async function openEither(text, prev) {
  try { return await open(text); } catch (e) { if (prev) return open(text, prev); throw e; }
}

/**
 * The signed-in person's key, from the server. Opens what this person has waiting on the phone (and seals any entries
 * an older version left in the clear). Call after sign-in, and on page load with the copy kept for this tab.
 */
export async function setDeviceKey(raw) {
  const me = who();
  if (!raw || !me || !subtle()) return false;
  // The key this tab held for the same person before (a password change or Sign out everywhere gives a new one): what is
  // on the phone is opened with it and sealed again with the new key, so nothing waiting is lost.
  const prev = key && keyOwner === me ? key : null;
  try {
    key = await subtle().importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); // non-extractable
    keyOwner = me;
    try { globalThis.sessionStorage.removeItem(KEY_SLOT); } catch (_) { /* never kept there now */ }
    const st = store();
    let mine = [];
    const sealed = st && st.getItem(BOX(me));
    if (sealed) { try { mine = await openEither(sealed, prev); } catch (_) { mine = []; } }
    const legacy = st && st.getItem(LEGACY);
    if (legacy) {
      const old = JSON.parse(legacy || '[]');
      mine = [...mine, ...old.filter((x) => x.who === me && !mine.some((m) => m.id === x.id))];
      const rest = old.filter((x) => x.who !== me);
      if (rest.length) st.setItem(LEGACY, JSON.stringify(rest)); else st.removeItem(LEGACY);
    }
    memory = [...mine, ...(memory || []).filter((x) => x.who === me && !mine.some((m) => m.id === x.id))];
    const kept = st && st.getItem(CASES_BOX(me));
    cases = []; if (kept) { try { cases = await openEither(kept, prev); } catch (_) { cases = []; } }
    const plainCases = st && st.getItem(CASES_LEGACY);
    if (plainCases) st.removeItem(CASES_LEGACY);
    await persist();
    await persistCases();
    for (const fn of listeners) { try { fn(); } catch (_) { /* keep going */ } }
    if (memory.length) schedule();
    return true;
  } catch (_) { key = null; keyOwner = null; return false; }
}
/** After a password change or Sign out everywhere: the new key from the server; what waits is sealed again with it. */
export async function refreshDeviceKey() {
  try { const me = await api('GET', '/auth/me'); return await setDeviceKey(me.device_key); } catch (_) { return false; }
}
/** Kept for older callers: the key is no longer stored in the tab (2026.11.11); main.js asks the server on load. */
export function restoreDeviceKey() {
  return Promise.resolve(false);
}
/** On sign-out: forget the key (the sealed entries stay, unreadable, until this person signs in again). */
export function dropDeviceKey() {
  key = null; keyOwner = null; memory = null; cases = [];
  try { globalThis.sessionStorage.removeItem(KEY_SLOT); } catch (_) { /* none */ }
}

let memory = null;
const ready = () => key && keyOwner === who();
function read() {
  memory = memory || [];
  return memory;
}
/** Waiting longer than three days: the case strip warns about it. */
export const isOld = (x) => Date.parse(x.queued || 0) < Date.now() - KEEP_HOURS * 3600000;
async function persist() {
  const st = store(); const me = who();
  if (!st || !me || !ready()) return; // no key yet: memory only, never in the clear
  const mine = (memory || []).filter((x) => x.who === me);
  try {
    if (mine.length) st.setItem(BOX(me), await seal(mine)); else st.removeItem(BOX(me));
    const counts = JSON.parse(st.getItem(COUNTS) || '{}');
    if (mine.length) counts[me] = mine.length; else delete counts[me];
    st.setItem(COUNTS, JSON.stringify(counts));
  } catch (_) { /* storage full or blocked: entries stay in memory */ }
}
function write(list) {
  memory = list;
  persist();
  for (const fn of listeners) { try { fn(); } catch (_) { /* a listener that fails does not stop the others */ } }
}
const all = () => read();
/** How many entries other people left on this phone (sealed; only the count is known). */
function othersWaiting() {
  try {
    const me = who(); const counts = JSON.parse((store() && store().getItem(COUNTS)) || '{}');
    let n = Object.entries(counts).filter(([w]) => w !== me).reduce((a, [, c]) => a + Number(c || 0), 0);
    const legacy = store() && store().getItem(LEGACY);
    if (legacy) n += JSON.parse(legacy).filter((x) => x.who !== me).length;
    return n;
  } catch (_) { return 0; }
}

// The terrain park's entries (inspections, placements, rope lines, an area opened or closed) wait in the same outbox,
// under queue 0: no patrol case has that id (cases are positive, and negative while started with no signal). They are
// sealed, sent in order and refused the same way as patrol's (2026.11.12).
export const PARK_QUEUE = 0;

/** Entries for one case that have not reached the server yet: [{ id, method, path, body, label, at, error }]. */
export function pending(caseId) {
  const me = who();
  return all().filter((x) => x.caseId === Number(caseId) && x.who === me);
}
/** How many entries on this phone belong to someone else, or to the person signed in (for the sign-out warning). */
export function waitingCounts(caseId) {
  const me = who();
  const list = all().filter((x) => caseId === undefined || x.caseId === Number(caseId));
  return { mine: list.filter((x) => x.who === me).length, others: caseId === undefined ? othersWaiting() : 0 };
}
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Did this fail because the phone could not reach the server (as opposed to the server saying no)? */
const unreachable = (err) => !(err instanceof ApiError) || err.status === 0 || err.status >= 502;
const newRef = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Sends one change. If the phone is offline (or the request cannot get through) it is kept and sent later, and the
 * result is { queued: true }. A refusal from the server (a mistake in the entry, a locked report) is thrown as usual.
 */
export async function send(method, path, body, { caseId, label: text, temp, offlineBody }) {
  // A new entry carries an id from this phone, so if the answer is lost and it is sent again the server keeps one copy.
  const ref = newRef();
  const sendBody = method === 'POST' ? { ...body, client_ref: ref } : body;
  const queue = () => {
    const item = { id: ref, who: who(), caseId: Number(caseId), method, path, body: offlineBody ? { ...offlineBody, client_ref: ref } : sendBody, label: text, at: nowStamp(), queued: new Date().toISOString(), ...(temp ? { temp } : {}) };
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
    for (const queued of all().filter((x) => x.who === me && !x.error)) {
      // Read it again: another tab may have sent it, or a case started offline may have just been given its real id.
      const item = all().find((x) => x.id === queued.id);
      if (!item || item.error) continue;
      try {
        const out = await api(item.method, item.path, item.body);
        write(all().filter((x) => x.id !== item.id));
        if (item.temp && out && out.id) settle(item.temp, out);
        sent += 1;
      } catch (err) {
        if (unreachable(err) || err.status === 401) break; // no signal, or signed out: try again later
        // The server refused it (for example the report was locked meanwhile). Keep it, marked, so nothing is silently lost.
        write(all().map((x) => (x.id === item.id ? { ...x, error: err.message, details: err.details || null, refused_phone_at: nowStamp() } : x)));
      }
    }
    return sent;
  };
  // One tab at a time sends, where the browser can arrange that; the ids on each entry catch any overlap anyway.
  const locks = globalThis.navigator && globalThis.navigator.locks;
  flushing = (locks ? locks.request('so-patrol-outbox', run) : run()).finally(() => { flushing = null; });
  return flushing;
}

// ---------------------------------------------------------------- cases started with no signal
// A case started offline has a temporary negative id (and its first patient another). When the case reaches the server,
// the entries waiting behind it are pointed at the real ids, and the page moves to the real case.
const MAP_KEY = 'so.patrol.tmpcases';
function settle(temp, out) {
  const fromCase = `/patrol/incidents/${temp.caseId}/`;
  const fromPatient = temp.patientId && out.patient_id ? `/patients/${temp.patientId}` : null;
  write(all().map((x) => {
    if (x.caseId !== temp.caseId) return x;
    let path = x.path.startsWith(fromCase) ? `/patrol/incidents/${out.id}/${x.path.slice(fromCase.length)}` : x.path;
    if (fromPatient && (path.includes(`${fromPatient}/`) || path.endsWith(fromPatient))) path = path.replace(fromPatient, `/patients/${out.patient_id}`);
    // a signature, a skip or an N/A answer names its patient in the body too
    let body = temp.patientId && out.patient_id && x.body && x.body.patient_id === temp.patientId ? { ...x.body, patient_id: out.patient_id } : x.body;
    // supplies used from a kit name the case in the body (2026.11.11: they were left with no case)
    if (body && body.incident_id === temp.caseId) body = { ...body, incident_id: out.id };
    return { ...x, caseId: out.id, path, body };
  }));
  try { const m = JSON.parse(globalThis.sessionStorage.getItem(MAP_KEY) || '{}'); m[temp.caseId] = out.id; globalThis.sessionStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch (_) { /* the page reloads the list instead */ }
  cases = cases.filter((x) => x.id !== temp.caseId); persistCases();
}
/** The real id of a case started with no signal, once it has reached the server. */
export function realCaseId(tmp) {
  try { return JSON.parse(globalThis.sessionStorage.getItem(MAP_KEY) || '{}')[tmp] || null; } catch (_) { return null; }
}

/** Tries a refused entry again (after the report was sent back to draft, say). */
export function retry(id) { write(all().map((x) => (x.id === id ? { ...x, error: undefined } : x))); schedule(); return flush(); }
/**
 * An entry refused because its time is in the future (this phone's clock runs fast): moves its time back by how far the
 * phone's clock is ahead of the server's, says so on the entry, and sends it again.
 */
export function fixClock(id) {
  const x = all().find((e) => e.id === id);
  const d = x && x.details;
  if (!d || d.code !== 'future_time' || !d.field || !x.body || !x.body[d.field]) return retry(id);
  const ms = (v) => Date.parse(String(v).replace(' ', 'T').slice(0, 19));
  const ahead = Math.max(0, ms(x.refused_phone_at || x.at || '') - ms(d.server_now)) || 0;
  let fixed = new Date(ms(x.body[d.field]) - ahead);
  if (!(fixed.getTime() <= ms(d.server_now))) fixed = new Date(ms(d.server_now));
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${fixed.getFullYear()}-${p2(fixed.getMonth() + 1)}-${p2(fixed.getDate())}T${p2(fixed.getHours())}:${p2(fixed.getMinutes())}`;
  const mins = Math.round(ahead / 60000);
  write(all().map((e) => (e.id === id ? { ...e, body: { ...e.body, [d.field]: stamp }, error: undefined, details: null, label: `${e.label} (time moved back ${mins} min: this phone's clock was ahead)` } : e)));
  schedule();
  return flush();
}

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
}

// ---------------------------------------------------------------- cases kept for a dead spot
// The last few cases this person opened are kept on the phone for 12 hours, so a case can still be opened (to read it
// and keep adding bedside entries) where there is no signal. They are sealed with the same key, belong to the person
// signed in, and are cleared on sign-out.
const CASES_LEGACY = 'so.patrol.cases';
const CASES_BOX = (w) => `so.patrol.cases.${w}`;
const CASE_HOURS = 12; const CASE_MAX = 5;
let cases = [];
async function persistCases() {
  const st = store(); const me = who();
  if (!st || !me || !ready()) return;
  try { if (cases.length) st.setItem(CASES_BOX(me), await seal(cases)); else st.removeItem(CASES_BOX(me)); } catch (_) { /* not kept */ }
}
export function keepCase(id, data) {
  const me = who(); if (!me) return;
  const cut = Date.now() - CASE_HOURS * 3600000;
  cases = cases.filter((x) => x.who === me && x.at > cut && x.id !== Number(id));
  cases.unshift({ id: Number(id), who: me, at: Date.now(), data });
  cases = cases.slice(0, CASE_MAX);
  persistCases();
}
/** The case most recently kept on this phone (for its report form and lists, when a new case starts with no signal). */
export function latestKept() {
  const me = who();
  return cases.find((x) => x.who === me && x.id > 0) ? cases.find((x) => x.who === me && x.id > 0).data : null;
}
export function keptCase(id) {
  const me = who(); const cut = Date.now() - CASE_HOURS * 3600000;
  return cases.find((x) => x.who === me && x.id === Number(id) && x.at > cut) || null;
}
export function forgetCases() {
  cases = [];
  const st = store(); const me = who();
  try { if (st) { st.removeItem(CASES_LEGACY); if (me) st.removeItem(CASES_BOX(me)); } } catch (_) { /* nothing kept */ }
}

// ---------------------------------------------------------------- lists kept for a dead spot
// The trails, lifts and attractions (what New case and the location picker offer) are kept on the phone, in the clear,
// whenever they are fetched with a signal: they hold no patient details. With no signal, the copy last kept is offered,
// so a case started in a dead spot can still name its trail or attraction.
const LIST_KEY = (name) => { const t = who(); return `so.patrol.list.${t ? t.split('.')[0] : ''}.${name}`; };
const lists = {};
/** Fetches a list with `load()`; keeps the answer on the phone, and falls back to the copy kept when there is no signal. */
export async function cachedList(name, load) {
  try {
    const data = await load();
    if (Array.isArray(data)) keepList(name, data);
    return data;
  } catch (err) {
    const kept = keptList(name);
    if (kept) return kept;
    throw err;
  }
}
export function keepList(name, data) {
  lists[name] = data;
  const st = store();
  try { if (st) st.setItem(LIST_KEY(name), JSON.stringify(data)); } catch (_) { /* private mode or full: kept in memory */ }
}
/** The list last fetched on this phone, or null if it never was. */
export function keptList(name) {
  if (lists[name]) return lists[name];
  try { const s = store() && store().getItem(LIST_KEY(name)); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
