// The time clock kiosk. It has no login: a manager pairs the tablet once, then people tap their name and enter a PIN
// (or hold up a QR badge), confirm, and they are clocked in or out. Text is always set with textContent.

import './stage.js'; // the staging band (shows only on staging)
const KEY = 'summitops.kiosk';
const root = document.getElementById('kiosk');

// ---------------------------------------------------------------- small helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v === true) el.setAttribute(k, ''); else el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const k of kids) el.append(k);
  return el;
}
const qrIcon = () => svg('svg', { width: 28, height: 28, viewBox: '0 0 24 24', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2 },
  svg('rect', { x: 3, y: 3, width: 7, height: 7, rx: 1 }), svg('rect', { x: 14, y: 3, width: 7, height: 7, rx: 1 }), svg('rect', { x: 3, y: 14, width: 7, height: 7, rx: 1 }), svg('path', { d: 'M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1' }));
const checkIcon = () => svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true', fill: 'none', stroke: '#fff', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  svg('circle', { cx: 60, cy: 60, r: 52 }), svg('path', { d: 'M36 62l16 16 32-34' }));

const t12 = (s) => { const hr = Number(String(s).slice(11, 13)); return `${((hr + 11) % 12) + 1}:${String(s).slice(14, 16)} ${hr < 12 ? 'AM' : 'PM'}`; };
const dur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } },
  set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* private mode: the tablet will ask to be set up again */ } },
  clear() { try { localStorage.removeItem(KEY); } catch (_) { /* nothing stored */ } },
};
let device = store.get();
let roster = null;
let screen = 'start';
let timers = [];
const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
const reset = () => { timers.forEach(clearTimeout); timers = []; stopCamera(); window.onkeydown = null; };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/v1/kiosk${path}`, { method, headers: { 'content-type': 'application/json', ...(device ? { 'x-kiosk-token': device.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) { throw Object.assign(new Error('No connection. Check the Wi-Fi and try again.'), { offline: true }); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error || 'Something went wrong. Try again.');
    e.status = res.status; e.details = json.details;
    if (e.details && e.details.code === 'kiosk_unpaired') { store.clear(); device = null; }
    throw e;
  }
  return json;
}

// ---------------------------------------------------------------- camera
let stream = null;
async function openCamera() {
  try { return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); } catch (_) { return null; }
}
function stopCamera() { if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; } }
function video() {
  const v = h('video', { autoplay: true, playsinline: true, muted: true, 'aria-hidden': 'true' });
  v.muted = true; v.srcObject = stream; v.play().catch(() => {});
  return v;
}
/** A small JPEG of the current frame, under the server's size limit, or null. */
function snapshot(v) {
  if (!v || v.readyState < 2 || !v.videoWidth) return null;
  const scale = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  let q = 0.7; let out = c.toDataURL('image/jpeg', q);
  while (out.length > 90_000 && q > 0.3) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  return out.length <= 120_000 ? out : null;
}
let detector = null;
try { if ('BarcodeDetector' in window) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch (_) { detector = null; }
let jsqrReady = null;
const loadJsqr = () => {
  if (window.jsQR) return Promise.resolve();
  if (!jsqrReady) jsqrReady = new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/vendor/jsqr/jsQR.js'; s.onload = ok; s.onerror = () => no(new Error('The scanner could not load')); document.head.append(s); });
  return jsqrReady;
};
async function readFrame(v, canvas) {
  if (v.readyState < 2 || !v.videoWidth) return null;
  if (detector) { try { const r = await detector.detect(v); if (r[0] && r[0].rawValue) return r[0].rawValue; } catch (_) { /* fall back to jsQR */ } }
  await loadJsqr();
  const w = 480; const hh = Math.round((w * v.videoHeight) / v.videoWidth);
  canvas.width = w; canvas.height = hh;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, w, hh);
  const d = g.getImageData(0, 0, w, hh);
  const r = window.jsQR(d.data, w, hh, { inversionAttempts: 'dontInvert' });
  return r ? r.data : null;
}

// ---------------------------------------------------------------- screens
const mount = (...els) => { root.replaceChildren(...els.flat().filter(Boolean)); };
const netBanner = h('div', { class: 'k-net', role: 'status', hidden: navigator.onLine !== false }, 'No connection. You cannot clock in or out until the Wi-Fi is back.');
window.addEventListener('offline', () => { netBanner.hidden = false; });
window.addEventListener('online', () => { netBanner.hidden = true; });

function bar() {
  const tz = roster && roster.timezone;
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hour: 'numeric', minute: '2-digit' });
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'long', month: 'long', day: 'numeric' });
  const t = h('b'); const d = h('span');
  const paint = () => { const now = new Date(); t.textContent = time.format(now); d.textContent = day.format(now); };
  const tick = () => { if (!t.isConnected) return; paint(); later(tick, 10_000); };
  paint();
  later(tick, 10_000);
  return h('header', { class: 'k-bar' }, h('div', null, h('h1', null, (roster && roster.mountain) || (device && device.mountain) || 'Staff clock'), h('p', { class: 'sub' }, 'Staff clock')), h('div', { class: 'k-clock' }, t, d));
}

/** First screen on a new tablet: type the code a manager gave, or open the link they made. */
function showPair(message) {
  reset(); screen = 'pair';
  const code = h('input', { class: 'k-code', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: 9, placeholder: 'ABCD-EFGH', 'aria-label': 'Pairing code' });
  const msg = h('div', { class: 'k-msg bad', role: 'alert', hidden: !message }, message || '');
  const go = h('button', { class: 'k-btn primary', type: 'submit' }, 'Set up this tablet');
  const form = h('form', { class: 'k-card' }, h('h2', null, 'Set up this tablet'), h('p', { class: 'k-fine' }, 'A manager makes a code in the staff app: Staff and schedule, then Kiosk, then Add a tablet. Type it here.'), code, msg, go);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); go.disabled = true; msg.hidden = true;
    try { await pairWith(code.value); } catch (err) { msg.textContent = err.message; msg.hidden = false; go.disabled = false; }
  });
  mount(netBanner, h('main', { class: 'k-center' }, form));
  code.focus();
}
async function pairWith(code) {
  const r = await api('POST', '/pair', { code });
  device = { token: r.token, name: r.device.name, mountain: r.mountain.name };
  store.set(device);
  history.replaceState(null, '', '/kiosk');
  await showHome();
}

let query = '';
async function showHome(notice) {
  reset(); screen = 'home'; query = '';
  try { roster = await api('GET', '/roster'); } catch (err) { if (!device) { showPair(err.message); return; } if (!roster) { showError(err); return; } }
  const search = h('input', { class: 'k-search', type: 'search', placeholder: 'Find your name', 'aria-label': 'Find your name', autocomplete: 'off', spellcheck: 'false' });
  const grid = h('div', { class: 'k-grid', role: 'list' });
  const note = h('div', { class: 'k-msg note', role: 'status', hidden: !notice }, notice || '');
  const draw = () => {
    const q = query.trim().toLowerCase();
    const list = roster.people.filter((p) => !q || p.name.toLowerCase().includes(q));
    grid.replaceChildren(...(list.length ? list.map((p) => h('button', { class: `k-tile${p.in ? ' in' : ''}`, type: 'button', role: 'listitem', onclick: () => showPin(p) }, h('b', null, p.name), h('span', { class: 'st' }, p.in ? 'Clocked in' : 'Clocked out'))) : [h('p', { class: 'k-empty' }, roster.people.length ? `No name matches "${query.trim()}".` : 'No one is set up on this clock yet. A manager adds PINs under Staff and schedule, then Kiosk.')]));
  };
  search.addEventListener('input', () => { query = search.value; draw(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && search.value.startsWith('SO1.')) { e.preventDefault(); identifyBadge(search.value.trim()); } });
  const scan = h('button', { class: 'k-btn primary', type: 'button', onclick: () => showScan() }, qrIcon(), 'Scan badge');
  mount(netBanner, bar(), h('main', { class: 'k-main' }, note, h('div', { class: 'k-tools' }, search, scan), grid));
  draw();
  if (notice) later(() => { note.hidden = true; }, 8000);
  const refresh = async () => { try { roster = await api('GET', '/roster'); if (screen === 'home') draw(); } catch (_) { /* keep showing what we have */ } if (screen === 'home') later(refresh, 20_000); };
  later(refresh, 20_000);
  // A USB or Bluetooth badge scanner types the code and presses Enter; the wedge below catches it wherever the cursor is.
  let buf = ''; let last = 0;
  window.onkeydown = (e) => {
    const now = Date.now(); if (now - last > 120) buf = ''; last = now;
    if (e.key === 'Enter') { if (buf.startsWith('SO1.')) { e.preventDefault(); const c = buf; buf = ''; identifyBadge(c); } else buf = ''; return; }
    if (e.key.length === 1) buf += e.key;
  };
}

function showError(err) {
  reset(); screen = 'error';
  mount(netBanner, h('main', { class: 'k-center' }, h('h2', null, 'This clock cannot reach the server'), h('p', { class: 'lead' }, err.message), h('button', { class: 'k-btn primary', type: 'button', onclick: () => showHome() }, 'Try again')));
  later(() => showHome(), 15_000);
}

function showPin(person) {
  reset(); screen = 'pin';
  let pin = ''; let busy = false; let locked = false;
  const dots = h('div', { class: 'k-dots', 'aria-live': 'polite' });
  const msg = h('div', { class: 'k-msg bad', role: 'alert', hidden: true });
  const keys = [];
  const draw = () => { dots.replaceChildren(...(pin ? [...pin].map(() => h('i')) : [h('span', null, 'Enter your PIN')])); dots.setAttribute('aria-label', `${pin.length} digits entered`); };
  const home = () => showHome();
  const press = (d) => { if (busy || locked || pin.length >= 6) return; pin += d; msg.hidden = true; draw(); idle(); };
  const back = () => { if (busy || locked) return; pin = pin.slice(0, -1); draw(); idle(); };
  async function enter() {
    if (busy || locked) return;
    if (pin.length < 4) { msg.textContent = 'A PIN is at least 4 digits.'; msg.hidden = false; return; }
    busy = true; keys.forEach((k) => { k.disabled = true; });
    try { showConfirm(await api('POST', '/identify', { staff_id: person.id, pin })); return; } catch (err) {
      pin = ''; draw();
      msg.textContent = err.status === 401 && err.details && typeof err.details.attempts_left === 'number'
        ? `That PIN did not match. ${err.details.attempts_left} ${err.details.attempts_left === 1 ? 'try' : 'tries'} left.` : err.message;
      msg.hidden = false;
      if (err.status === 429) { locked = true; later(home, 6000); } else { busy = false; keys.forEach((k) => { k.disabled = false; }); }
    }
  }
  const idle = () => { timers.forEach(clearTimeout); timers = []; later(home, 30_000); };
  const key = (text, fn, cls = '') => { const b = h('button', { class: `k-key ${cls}`, type: 'button', onclick: fn }, text); keys.push(b); return b; };
  const pad = h('div', { class: 'k-pad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => press(d))), key('Back', back, 'act'), key('0', () => press('0')), key('Enter', enter, 'act go'));
  mount(netBanner, h('main', { class: 'k-center' }, h('div', { class: 'k-card' }, h('h2', null, person.name), dots, msg, pad, h('button', { class: 'k-link', type: 'button', onclick: home }, 'Not you? Go back'))));
  draw(); idle();
  window.onkeydown = (e) => {
    if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') back(); else if (e.key === 'Enter') enter(); else if (e.key === 'Escape') home();
  };
}

async function identifyBadge(code) {
  try { showConfirm(await api('POST', '/identify', { badge: code })); } catch (err) { showHome(err.message); }
}

function showConfirm(r) {
  reset(); screen = 'confirm';
  const action = r.state === 'in' ? 'out' : 'in';
  const msg = h('div', { class: 'k-msg bad', role: 'alert', hidden: true });
  let cam = null; const camNote = h('p', { class: 'k-fine' });
  const camHolder = h('div');
  if (r.photo) {
    openCamera().then((s) => {
      if (screen !== 'confirm') { if (s) for (const t of s.getTracks()) t.stop(); return; }
      stream = s;
      if (s) { cam = video(); cam.className = 'k-cam'; camHolder.replaceChildren(cam); camNote.textContent = `A photo is saved with this clock-${action} to check timesheets. It is deleted after ${roster ? roster.photo_days : 30} days.`; } else camNote.textContent = 'The camera is off, so no photo will be saved.';
    });
    camNote.textContent = 'Starting the camera…';
  }
  const go = h('button', { class: `k-big ${action}`, type: 'button' }, `Clock ${action}`);
  go.addEventListener('click', async () => {
    go.disabled = true; msg.hidden = true;
    try {
      const out = await api('POST', '/punch', { session: r.session, action, ...(r.photo && cam ? { image: snapshot(cam) || undefined } : {}) });
      showDone(out);
    } catch (err) {
      if (err.status === 401 || err.status === 409) { showHome(err.details && err.details.code === 'session_expired' ? 'That took too long. Start again.' : err.message); return; }
      msg.textContent = err.message; msg.hidden = false; go.disabled = false;
    }
  });
  const shift = r.shift ? h('p', { class: 'k-fine' }, `Today's shift: ${r.shift.position}, ${t12(r.shift.starts_at)} to ${t12(r.shift.ends_at)}`) : null;
  mount(netBanner, h('main', { class: 'k-center' }, h('div', { class: 'k-card' },
    h('h2', null, `Hi, ${r.staff.first_name}.`),
    h('span', { class: `k-state ${r.state}` }, r.state === 'in' ? `Clocked in since ${t12(r.since)} (${dur(r.minutes || 0)})` : 'Clocked out'),
    shift, r.photo ? camHolder : null, r.photo ? camNote : null, msg, go,
    h('button', { class: 'k-link', type: 'button', onclick: () => showHome() }, 'That is not me'))));
  later(() => showHome(), 25_000);
}

function showDone(out) {
  reset(); screen = 'done';
  mount(netBanner, h('main', { class: `k-done ${out.action}` }, checkIcon(),
    h('h2', null, `Clocked ${out.action}`), h('p', { class: 'big' }, t12(out.at)),
    h('p', null, out.action === 'in' ? `Have a good shift, ${out.first_name}.` : `You worked ${dur(out.minutes || 0)}. See you next time.`),
    h('button', { class: 'k-btn', type: 'button', onclick: () => showHome() }, 'Done')));
  later(() => showHome(), 5000);
}

async function showScan() {
  reset(); screen = 'scan';
  const msg = h('p', { class: 'lead' }, 'Hold your badge up to the camera.');
  mount(netBanner, h('main', { class: 'k-center' }, h('h2', null, 'Scan your badge'), msg, h('div', { class: 'k-scan', id: 'k-scan' }), h('button', { class: 'k-btn', type: 'button', onclick: () => showHome() }, 'Cancel')));
  stream = await openCamera();
  if (screen !== 'scan') { stopCamera(); return; }
  if (!stream) { msg.textContent = 'The camera is not available. Tap your name instead, or ask a manager.'; return; }
  const v = video();
  document.getElementById('k-scan').replaceChildren(v, h('div', { class: 'frame' }));
  const canvas = document.createElement('canvas');
  let found = false;
  const loop = async () => {
    if (screen !== 'scan' || found) return;
    try {
      const text = await readFrame(v, canvas);
      if (text && text.startsWith('SO1.')) { found = true; stopCamera(); await identifyBadge(text); return; }
    } catch (err) { msg.textContent = err.message; }
    later(loop, 150);
  };
  loop();
  later(() => showHome(), 30_000);
}

// ---------------------------------------------------------------- start
(async function start() {
  const code = location.pathname.split('/').filter(Boolean)[1];
  if (code) { try { await pairWith(code); } catch (err) { showPair(err.message); } return; }
  if (device) { await showHome(); return; }
  showPair();
})();
