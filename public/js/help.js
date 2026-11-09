// Guest help page, opened from a QR code on a trail sign: /help/<mountain>?c=R7 (or ?loc=Ridge+Run).
// One large button sends the request at once, with where the phone is when it can tell within 8 seconds. Then optional
// questions, one per screen, each saved as it is answered; then a status page with patrol's messages, which survives a
// reload. Small on purpose (a weak signal on the hill): no app styles, no big libraries. "Call 911" is on every screen.
import { t as tr, pickLang, smsBody, smsHref, isApple } from './help-strings.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const api = `/api/v1/public/${encodeURIComponent(slug)}/help`;
const qs = new URLSearchParams(location.search);
const code = (qs.get('c') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase();
const loc = (qs.get('loc') || '').slice(0, 120);
const root = document.getElementById('help');
const bar = document.getElementById('bar');
const S = { lang: 'en', page: null, token: null, ref: null, pos: null, kind: 'help', who: null, timers: [] };
const KEY = `so.help.${slug}`;

// ---------------------------------------------------------------- small helpers
const store = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(`${KEY}.${k}`); if (v === null) sessionStorage.removeItem(`${KEY}.${k}`); else sessionStorage.setItem(`${KEY}.${k}`, v); } catch (_) { /* private mode */ } return null; };
const keep = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (_) { /* private mode */ } return null; };
const t = (k, v) => tr(S.lang, k, v);
function h(tag, a, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
function s(tag, a, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(a || {})) el.setAttribute(k, v);
  for (const c of kids) el.append(c);
  return el;
}
const btn = (text, on, cls = '', extra = {}) => h('button', { type: 'button', class: `b ${cls}`, onclick: on, ...extra }, ...[].concat(text));
const tel = (n) => `tel:${String(n).replace(/[^0-9+]/g, '')}`;
function show(...kids) {
  root.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const head = root.querySelector('h1,h2');
  if (head) { head.setAttribute('tabindex', '-1'); head.focus({ preventScroll: true }); }
  window.scrollTo(0, 0);
}
function deviceId() {
  let id = keep('so.help.device');
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) { id = hex(18); keep('so.help.device', id); }
  return id;
}
function hex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function call(method, path, body, ms = 15000) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${api}${path}`, { method, signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-device': deviceId() }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'failed'), { status: r.status, data });
    return data;
  } finally { clearTimeout(timer); }
}
const later = (fn, ms) => { const id = setTimeout(fn, ms); S.timers.push(id); return id; };

// The 911 bar and the language switch, on every screen.
function drawBar() {
  bar.replaceChildren(
    h('span', { class: 'bar-q' }, t('emergency')),
    h('a', { class: 'b b911', href: 'tel:911' }, t('call911')),
    btn(t('other'), () => { S.lang = t('otherLang'); keep('so.help.lang', S.lang); document.documentElement.lang = S.lang; drawBar(); S.redraw && S.redraw(); }, 'blang', { lang: t('otherLang') }));
}
function setLang(server) {
  S.lang = pickLang(keep('so.help.lang'), server, navigator.language);
  document.documentElement.lang = S.lang;
  drawBar();
}

// ---------------------------------------------------------------- 1. the first screen
// The mountain's name and numbers from the last page that loaded, kept on the phone so a failed first load can still
// offer Send by text instead.
const CACHE = `so.help.page.${slug}`;
function cached() { try { const v = JSON.parse(keep(CACHE) || 'null'); return v && typeof v === 'object' ? v : null; } catch (_) { return null; } }
function cachePage(p) { keep(CACHE, JSON.stringify({ mountain: p.mountain || null, sms_number: p.sms_number || null, patrol_phone: p.patrol_phone || null, patrol_phone_shown: p.patrol_phone_shown || null })); }

async function start() {
  setLang(null);
  const saved = (location.hash.match(/t=([0-9a-f]{32})/) || [])[1] || store('token');
  try {
    S.page = await call('GET', code ? `?c=${encodeURIComponent(code)}` : '', null, 20000);
    cachePage(S.page);
  } catch (err) {
    if (!saved) { offline(); return; }
  }
  if (S.page) setLang(S.page.lang);
  if (saved) { S.token = saved; S.ref = store('ref'); status(); return; }
  home();
}

// The first load failed: try again, send by text (when the number is known from an earlier load), or call 911. Never a
// dead end.
function offline() {
  S.redraw = offline;
  const c = cached() || {};
  const body = smsBody({ code, place: code ? null : loc });
  show(c.mountain ? h('p', { class: 'mtn' }, c.mountain) : null, h('h1', null, t('offTitle')), h('p', null, t('offSub')),
    btn(t('retry'), () => { show(h('p', { role: 'status' }, t('loading'))); start(); }, 'pri'),
    c.sms_number ? h('a', { class: 'b big-alt', href: smsHref(c.sms_number, body, isApple(navigator.userAgent, navigator.maxTouchPoints)) }, t('smsFallback')) : null,
    c.sms_number ? h('p', { class: 'muted' }, t('offText')) : null,
    h('a', { class: 'b b911 wide', href: 'tel:911' }, t('call911')),
    c.patrol_phone ? h('a', { class: 'b sec has-num', href: tel(c.patrol_phone) }, h('span', null, t('callPatrol')), h('span', { class: 'num' }, c.patrol_phone_shown || c.patrol_phone)) : null);
}

// The request was not taken online even with nothing optional in it: send it by text, call 911, or try again.
function notTaken(kind, who) {
  S.redraw = () => notTaken(kind, who);
  const n = S.page && S.page.sms_number;
  const body = smsBody({ code, place: code ? null : loc, lat: S.pos && S.pos.lat, lng: S.pos && S.pos.lng, acc: S.pos && S.pos.acc, what: kind === 'lost_child' ? 'lost child' : null });
  show(h('h1', null, t('notTaken')), h('p', null, t('notTakenSub')),
    n ? h('a', { class: 'b big-alt', href: smsHref(n, body, isApple(navigator.userAgent, navigator.maxTouchPoints)) }, t('smsFallback')) : null,
    n ? h('p', { class: 'muted' }, t('smsHint')) : null,
    h('a', { class: 'b b911 wide', href: 'tel:911' }, t('call911')),
    btn(t('retry'), () => go(kind, who), 'sec'));
}

function home() {
  S.redraw = home;
  const p = S.page;
  show(
    h('p', { class: 'mtn' }, p.mountain), h('h1', null, t('title')),
    p.place ? h('p', { class: 'sign' }, t('atSign', p.place)) : null,
    btn([h('span', { class: 'big-t' }, t('needHelp')), h('span', { class: 'big-s' }, t('needHelpSub'))], () => go('help', null), 'big'),
    btn(t('forOther'), () => go('help', 'someone_i_saw'), 'sec'),
    btn(t('lostChild'), () => go('lost_child', null), 'sec'),
    h('div', { class: 'warn', role: 'note' }, h('strong', null, t('emergency')), ' ', t('banner911')),
    p.message ? h('p', { class: 'msg' }, p.message) : null);
}

// ---------------------------------------------------------------- 2. sending: location (8 s at most), then the request
function locate(maxMs) {
  return new Promise((done) => {
    if (!navigator.geolocation) { done(null); return; }
    const cap = setTimeout(() => done(null), maxMs);
    navigator.geolocation.getCurrentPosition((p) => { clearTimeout(cap); done(p.coords); }, () => { clearTimeout(cap); done(null); }, { enableHighAccuracy: true, timeout: maxMs, maximumAge: 60000 });
  });
}

async function go(kind, who) {
  S.kind = kind; S.who = who; S.redraw = null;
  const rid = hex(16);
  const line = h('p', { class: 'big-line', role: 'status', 'aria-live': 'polite' }, t('finding'));
  const fallback = h('div');
  show(h('h1', null, t(kind === 'lost_child' ? 'lostChild' : who ? 'forOther' : 'needHelp')), line, h('p', { class: 'muted' }, t('allow')), fallback, h('p', null, t('stay')));
  const pos = await locate(8000);
  S.pos = pos ? { lat: pos.latitude, lng: pos.longitude, acc: pos.accuracy } : null;
  line.textContent = t('sending');
  let body = { kind, rid, lang: S.lang, ...(who ? { who } : {}), ...(code ? { code } : {}), ...(loc && !code ? { location: loc } : {}),
    ...(S.pos ? { gps_lat: S.pos.lat, gps_lng: S.pos.lng, accuracy: Math.round(S.pos.acc) } : {}) };
  // Send, and keep trying in the background. After 15 s or a failure, offer a text message too; the first to reach patrol wins.
  let done = false; let tries = 0; let minimal = false;
  const offerText = () => {
    if (done || fallback.childNodes.length) return;
    fallback.append(h('p', { class: 'warn' }, t('trying')));
    if (!S.page.sms_number) return;
    const text = smsBody({ code, place: code ? null : loc, lat: S.pos && S.pos.lat, lng: S.pos && S.pos.lng, acc: S.pos && S.pos.acc, what: kind === 'lost_child' ? 'lost child' : null });
    fallback.append(h('a', { class: 'b big-alt', href: smsHref(S.page.sms_number, text, isApple(navigator.userAgent, navigator.maxTouchPoints)) }, t('smsFallback')), h('p', { class: 'muted' }, t('smsHint')));
  };
  const slow = setTimeout(offerText, 15000);
  while (!done) {
    try {
      const r = await call('POST', '', body, 15000);
      done = true; clearTimeout(slow);
      sent(r);
    } catch (err) {
      offerText();
      tries += 1;
      // Refused (a 4xx that is not "too many" or "too slow"): send again at once with nothing optional in it; if that is
      // refused too, the text message and Call 911.
      if (err.status && err.status < 500 && err.status !== 429 && err.status !== 408) {
        if (!minimal) { minimal = true; body = { kind, rid }; continue; }
        done = true; clearTimeout(slow); notTaken(kind, who); return;
      }
      await new Promise((r) => setTimeout(r, Math.min(30000, 3000 * tries)));
    }
  }
}

function sent(r) {
  S.token = r.token; S.ref = r.reference;
  store('token', r.token); store('ref', r.reference); store('kind', S.kind); store('at', String(Date.now()));
  history.replaceState(null, '', `${location.pathname}${location.search}#t=${r.token}`);
  live(true);
  questions(S.kind === 'lost_child' ? ['child_name', 'child_age', 'child_jacket', 'child_last_seen', 'phone'] : [...(S.who ? [] : ['who']), 'where', 'lift', 'steep', 'tower', 'what', 'hurt', 'pass', 'phone']);
}

// ---------------------------------------------------------------- 3. the questions, one per screen
// Answers are saved at once (PATCH by the guest token); a failed save is kept and sent again.
let pending = {}; let flushing = false;
async function save(obj) {
  Object.assign(pending, obj);
  if (flushing) return;
  flushing = true;
  while (Object.keys(pending).length) {
    const now = pending; pending = {};
    try { await call('PATCH', `/${S.token}`, now); } catch (err) {
      if (err.status === 409 || err.status === 404 || err.status === 400) break; // closed, gone, or not accepted: nothing more to do
      pending = { ...now, ...pending }; await new Promise((r) => setTimeout(r, 5000));
    }
  }
  flushing = false;
}

function questions(list) {
  const steps = list.filter((k) => k !== 'lift' || (S.page && S.page.lifts && S.page.lifts.length));
  let i = 0; let where = null;
  const next = () => {
    i += 1;
    while (i < steps.length && ['steep', 'tower'].includes(steps[i]) && ['building', 'parking'].includes(where)) i += 1;
    draw();
  };
  const draw = () => {
    S.redraw = draw; S.onStatus = false;
    if (i >= steps.length) { status(t('thanks')); return; }
    const k = steps[i];
    const head = h('div', { class: 'got', role: 'status' }, h('strong', null, t('received')), S.ref ? ` · ${t('ref')} ${S.ref}` : '');
    const skip = btn(t('skip'), next, 'skip');
    const pick = (field, value) => () => { save({ [field]: value }); if (field === 'where') where = value; next(); };
    const grid = (field, values, label = (v) => t(`${field}_${v}`)) => h('div', { class: 'grid' }, values.map((v) => btn(label(v), pick(field, v), 'opt')));
    const Q = (title, ...body) => show(head, h('p', { class: 'muted small' }, t('qOf', { n: i + 1, t: steps.length })), h('h2', null, title), ...body, skip);
    if (k === 'who') Q(t('qWho'), grid('who', ['me', 'someone_with_me', 'someone_i_saw']));
    else if (k === 'where') Q(t('qWhere'), i === 0 || (i === 1 && steps[0] === 'who') ? h('p', { class: 'muted' }, t('quick')) : null, grid('where', ['trail', 'lift', 'building', 'park', 'trees', 'parking', 'unknown']));
    else if (k === 'lift') Q(t('qLift'), h('div', { class: 'grid' }, S.page.lifts.map((l) => btn(l.name, pick('lift', l.id), 'opt')), btn(t('notSure'), pick('lift', 'not_sure'), 'opt')));
    else if (k === 'steep') Q(t('qSteep'), h('div', { class: 'grid' }, ['green', 'blue', 'black', 'double_black', 'not_sure'].map((v) => btn([symbol(v), h('span', null, t(`steep_${v}`))], pick('steep', v), 'opt sym'))));
    else if (k === 'tower') Q(t('qTower'), pad(3, (v) => { save({ tower: v }); next(); }));
    else if (k === 'what' || k === 'child_last_seen' || k === 'child_name') {
      const max = k === 'what' ? 400 : k === 'child_name' ? 40 : 200;
      const box = k === 'child_name' ? h('input', { id: 'f', maxlength: max, autocomplete: 'off', autocapitalize: 'words' }) : h('textarea', { id: 'f', rows: 3, maxlength: max });
      const title = { what: 'qWhat', child_last_seen: 'qSeen', child_name: 'qChildName' }[k];
      Q(h('label', { for: 'f' }, t(title)), box, h('p', { class: 'muted' }, k === 'child_last_seen' ? t('seenHint') : t('mic')),
        btn(t('save'), () => { const v = box.value.trim(); if (v) save({ [k]: v }); next(); }, 'pri'));
    } else if (k === 'child_age') Q(t('qChildAge'), pad(2, (v) => { if (Number(v) <= 17) save({ child_age: Number(v) }); next(); }));
    else if (k === 'child_jacket') {
      const other = h('input', { id: 'f', maxlength: 40, 'aria-label': t('otherColor'), placeholder: t('otherColor') });
      Q(t('qJacket'), h('div', { class: 'grid colors' }, ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white', 'gray'].map((c) => btn([h('i', { class: `sw c-${c}`, 'aria-hidden': 'true' }), t(`color_${c}`)], pick('child_jacket', t(`color_${c}`)), 'opt'))),
        other, btn(t('save'), () => { const v = other.value.trim(); if (v) save({ child_jacket: v }); next(); }, 'pri'));
    } else if (k === 'hurt') {
      const row = (f) => { const yes = btn(t('yes'), () => { save({ [f]: true }); mark(yes, no); }, 'yn'); const no = btn(t('no'), () => { save({ [f]: false }); mark(no, yes); }, 'yn'); return h('div', { class: 'yn-row' }, h('span', null, t(f)), h('div', null, yes, no)); };
      const mark = (on, off) => { on.setAttribute('aria-pressed', 'true'); off.setAttribute('aria-pressed', 'false'); };
      Q(t('qHurt'), row('bleeding'), row('cant_move'), row('very_cold'), btn(t('next'), next, 'pri'));
    } else if (k === 'pass') Q(t('qPass'), ...passBox(next));
    else if (k === 'phone') {
      const box = h('input', { id: 'f', type: 'tel', inputmode: 'tel', autocomplete: 'tel', maxlength: 30 });
      Q(h('label', { for: 'f' }, t('qPhone')), box, h('p', { class: 'muted' }, t('phoneHint')), btn(t('save'), () => { const v = box.value.trim(); if (v.replace(/\D/g, '').length >= 7) save({ phone: v }); next(); }, 'pri'));
    }
  };
  draw();
}

// The trail symbols, drawn (no images): green circle, blue square, black diamond, two black diamonds.
function symbol(v) {
  const box = { viewBox: '0 0 48 24', width: 48, height: 24, 'aria-hidden': 'true', focusable: 'false' };
  if (v === 'green') return s('svg', box, s('circle', { cx: 24, cy: 12, r: 10, fill: '#1f8a3b' }));
  if (v === 'blue') return s('svg', box, s('rect', { x: 14, y: 2, width: 20, height: 20, fill: '#1d5fbf' }));
  const d = (x) => s('path', { d: `M${x} 1 L${x + 11} 12 L${x} 23 L${x - 11} 12 Z`, fill: 'currentColor' });
  if (v === 'black') return s('svg', box, d(24));
  if (v === 'double_black') return s('svg', box, d(13), d(35));
  return s('svg', box, s('text', { x: 24, y: 18, 'text-anchor': 'middle', 'font-size': 18, fill: 'currentColor' }, '?'));
}

// A big number pad (gloves): digits, Delete, Save.
function pad(max, done) {
  let v = '';
  const out = h('output', { class: 'pad-out', 'aria-live': 'polite' }, ' ');
  const press = (d) => () => { if (v.length < max) v += d; out.textContent = v || ' '; };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => btn(d, press(d), 'key'));
  return h('div', { class: 'pad' }, out, h('div', { class: 'keys' }, keys,
    btn(t('del'), () => { v = v.slice(0, -1); out.textContent = v || ' '; }, 'key small'), btn('0', press('0'), 'key'), btn(t('save'), () => { if (v) done(v); }, 'key ok')));
}

// The pass hint: typed or scanned with the camera (the browser's own barcode reader, as the gate's readers.js uses).
function passBox(next) {
  const box = h('input', { id: 'pass', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: 40 });
  const note = h('p', { class: 'muted', role: 'status' });
  const send = (v) => { if (String(v).trim().length >= 4) call('POST', `/${S.token}/pass`, { number: String(v).trim() }).catch(() => {}); next(); };
  const camera = 'BarcodeDetector' in window && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  return [h('p', { class: 'muted' }, t('passWhy')), camera ? btn(t('scan'), () => scan(note, send), 'sec') : null,
    h('label', { for: 'pass' }, t('passNumber')), box, note, btn(t('save'), () => send(box.value), 'pri')];
}
async function scan(note, send) {
  let stream = null; let timer = null;
  const video = h('video', { class: 'cam', autoplay: true, muted: true, playsinline: true });
  const stop = () => { clearInterval(timer); if (stream) stream.getTracks().forEach((x) => x.stop()); layer.remove(); };
  const layer = h('div', { class: 'cam-layer', role: 'dialog', 'aria-label': t('scan') }, video, h('p', null, t('scanHold')), btn(t('cancel'), stop, 'sec'));
  document.body.append(layer);
  try {
    const det = new window.BarcodeDetector();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    timer = setInterval(async () => {
      if (video.readyState < 2) return;
      try { const f = await det.detect(video); if (f.length && f[0].rawValue) { stop(); send(f[0].rawValue); } } catch (_) { /* keep looking */ }
    }, 300);
  } catch (_) { stop(); note.textContent = t('scanBlocked'); }
}

// ---------------------------------------------------------------- live location while the page is open
// At most every 30 s, or sooner (10 s at least) when the phone moves more than 25 m. Stops when the call closes, after 2
// hours, or when the guest turns it off.
const LIVE_MS = 2 * 3600000;
let watch = null; let lastSent = null; let lastAt = 0;
function meters(a, b) {
  const r = (d) => (d * Math.PI) / 180; const dLat = r(b.lat - a.lat); const dLng = r(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(x));
}
function live(on) {
  if (!on || store('live') === 'off' || !navigator.geolocation || Date.now() - Number(store('at') || Date.now()) > LIVE_MS) { stopLive(); return; }
  if (watch !== null) return;
  watch = navigator.geolocation.watchPosition((p) => {
    if (Date.now() - Number(store('at') || 0) > LIVE_MS) { stopLive(); return; }
    const here = { lat: p.coords.latitude, lng: p.coords.longitude };
    const since = Date.now() - lastAt;
    if (lastSent && !(since >= 30000 || (since >= 10000 && meters(lastSent, here) > 25))) return;
    lastSent = here; lastAt = Date.now();
    call('POST', `/${S.token}/position`, { ...here, accuracy: Math.round(p.coords.accuracy), age_s: Math.max(0, Math.round((Date.now() - p.timestamp) / 1000)) })
      .catch((err) => { if (err.data && err.data.stop) stopLive(); });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}
function stopLive() { if (watch !== null && navigator.geolocation) navigator.geolocation.clearWatch(watch); watch = null; }

// ---------------------------------------------------------------- 4. the status page
let poller = null;
async function status(flash) {
  S.redraw = () => status(); S.onStatus = true;
  const since = Number(store('shown') || 0) || Date.now();
  if (!store('shown')) store('shown', String(since));
  let st;
  try { st = await call('GET', `/${S.token}`); } catch (err) {
    if (err.status === 404) { store('token', null); history.replaceState(null, '', location.pathname + location.search); if (S.page) home(); else show(h('h1', null, t('noOnline'))); return; }
    st = S.last || null;
  }
  if (!st) { show(h('h1', null, t('trying'))); schedule(since); return; }
  S.last = st; S.ref = st.reference;
  if (!S.page) setLang(st.lang); // a reload with no page info yet
  const closed = st.status === 'closed';
  if (closed) { stopLive(); store('live', 'off'); } else if (st.live) live(true); else stopLive();
  const list = h('ul', { class: 'msgs', 'aria-live': 'polite' }, st.messages.length
    ? st.messages.map((m) => h('li', { class: m.from }, h('b', null, m.from === 'patrol' ? t('fromPatrol') : t('fromYou')), h('span', null, m.body)))
    : h('li', { class: 'muted' }, t('noMessages')));
  const box = h('textarea', { id: 'reply', rows: 2, maxlength: 1000 });
  const note = h('p', { class: 'muted', role: 'status' });
  const phone = st.patrol_phone;
  const icon = { received: '✓', dispatched: '→', on_scene: '★', closed: '✓' }[st.status];
  show(
    flash ? h('p', { class: 'ok', role: 'status' }, flash) : null,
    h('div', { class: `state st-${st.status}` }, h('span', { class: 'st-i', 'aria-hidden': 'true' }, icon), h('h1', null, t(st.status))),
    h('p', null, t('ref'), ': ', h('b', null, st.reference)),
    closed ? h('p', null, t('closedSub')) : h('p', null, t('stay')),
    h('div', { class: 'row' }, h('a', { class: 'b b911', href: 'tel:911' }, t('call911')), phone ? h('a', { class: 'b sec has-num', href: tel(phone) }, h('span', null, t('callPatrol')), h('span', { class: 'num' }, st.patrol_phone_shown || phone)) : null),
    h('h2', null, t('messages')), list,
    closed ? null : h('div', { class: 'reply' }, h('label', { for: 'reply' }, t('reply')), box, h('p', { class: 'muted small' }, t('mic')),
      btn(t('send'), async () => {
        const v = box.value.trim(); if (!v) return;
        try { await call('POST', `/${S.token}/messages`, { body: v }); box.value = ''; note.textContent = t('sent'); status(); } catch (_) { note.textContent = t('notSent'); }
      }, 'pri'), note),
    closed ? null : h('p', { class: 'muted small' }, watch !== null ? t('liveOn') : t('liveOff'), ' ', watch !== null ? btn(t('liveStop'), () => {
      store('live', 'off'); stopLive(); call('POST', `/${S.token}/live-off`).catch(() => {}); status();
    }, 'link') : null),
    closed ? btn(t('askAgain'), () => { store('token', null); store('shown', null); store('live', null); history.replaceState(null, '', location.pathname + location.search); location.reload(); }, 'sec') : null,
    !closed && S.page && st.answered.length < 3 ? btn(t('answerMore'), () => questions((st.lost_child ? ['child_name', 'child_age', 'child_jacket', 'child_last_seen', 'phone'] : ['who', 'where', 'lift', 'steep', 'tower', 'what', 'hurt', 'pass', 'phone']).filter((k) => !st.answered.includes(k))), 'link') : null);
  if (!closed) schedule(since);
}
// Every 10 s, then every 30 s after 10 minutes. A reply or answer in progress is not interrupted by a redraw.
function schedule(since) {
  clearTimeout(poller);
  poller = setTimeout(async () => {
    const typing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName) && document.activeElement.value;
    if (!S.onStatus || typing) { schedule(since); return; } // on a question screen, or writing a reply
    await status();
  }, Date.now() - since > 600000 ? 30000 : 10000);
}

start();
