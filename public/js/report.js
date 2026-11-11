// The municipal report page: /report/<municipality>, opened from the municipality's website or a QR code. A resident says
// what is wrong, where, and (if they want) adds photos and a way to reach them. They get a reference (R-4821) and a status
// link (/report/<municipality>#s=<token>) that shows the status and the public note. Small on purpose (a weak signal):
// no app styles, no libraries. "For an emergency, call 911" is on every screen, and nothing here promises a response time.
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const api = `/api/v1/public/${encodeURIComponent(slug)}`;
const root = document.getElementById('app');
const S = { page: null, step: 'what', cat: null, street: '', house: '', cross: '', pos: null, files: [], desc: '', name: '', phone: '', email: '', texts: false, emails: false, rid: null, sending: false };
const KEY = `so.report.${slug}`;

// ---------------------------------------------------------------- helpers
function h(tag, a, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(a || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'class') el.className = v; else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const btn = (text, on, cls = '', extra = {}) => h('button', { type: 'button', class: `b ${cls}`, onclick: on, ...extra }, text);
const tel = (n) => `tel:${String(n).replace(/[^0-9+]/g, '')}`;
const keep = (k, v) => { try { if (v === undefined) return localStorage.getItem(`${KEY}.${k}`); if (v === null) localStorage.removeItem(`${KEY}.${k}`); else localStorage.setItem(`${KEY}.${k}`, v); } catch (_) { /* private mode */ } return null; };
function show(...kids) {
  root.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  const head = root.querySelector('h1,h2');
  if (head) { head.setAttribute('tabindex', '-1'); head.focus({ preventScroll: true }); }
  window.scrollTo(0, 0);
}
async function call(method, path, body, { ms = 20000, raw = false } = {}) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${api}${path}`, { method, signal: ctl.signal, headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: raw ? body : body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || 'That did not go through.'), { status: r.status });
    return data;
  } finally { clearTimeout(timer); }
}
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const when = (s) => { if (!s) return ''; const d = new Date(`${String(s).replace(' ', 'T')}`); return Number.isNaN(d.getTime()) ? s : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const org = () => (S.page ? h('p', { class: 'org' }, S.page.municipality) : null);
const step = (n) => h('p', { class: 'steps' }, `Step ${n} of 4`);

// The after-hours number, for a water leak or sewer backup (the municipality chooses which).
function afterHours() {
  if (!S.cat || !S.cat.after_hours || !S.page.after_hours_phone) return null;
  return h('div', { class: 'note', role: 'note' }, h('strong', null, 'Water or sewer problem after hours? '), 'Call ', h('a', { href: tel(S.page.after_hours_phone) }, S.page.after_hours_phone), ' as well. For an emergency, call 911.');
}

// ---------------------------------------------------------------- start
async function start() {
  const st = (location.hash.match(/s=([0-9a-f]{32})/) || [])[1];
  try { S.page = await call('GET', '/report'); } catch (err) {
    if (st) { status(st); return; }
    show(h('h1', null, err.status === 404 ? 'This page is not available' : 'The page could not load'),
      h('p', null, err.status === 404 ? 'Check the address, or call the municipal office.' : 'Check your signal and try again.'),
      err.status === 404 ? null : btn('Try again', () => { show(h('p', null, 'Loading…')); start(); }, 'pri'));
    return;
  }
  document.title = `Report a problem: ${S.page.municipality}`;
  if (st) { status(st); return; }
  what();
}
window.addEventListener('hashchange', () => { const st = (location.hash.match(/s=([0-9a-f]{32})/) || [])[1]; if (st) status(st); });

// ---------------------------------------------------------------- 1. what is wrong
function what() {
  show(org(), h('h1', null, 'Report a problem'), S.page.intro ? h('p', null, S.page.intro) : null, step(1), h('h2', null, 'What is wrong?'),
    h('div', { class: 'grid' }, S.page.categories.map((c) => btn(c.name, () => { S.cat = c; where(); }, '', { 'aria-pressed': S.cat && S.cat.id === c.id ? 'true' : 'false' }))),
    keep('last') ? h('p', { class: 'small' }, h('a', { href: `#s=${keep('last')}` }, 'See your last report')) : null,
    S.page.open_map ? h('p', { class: 'small' }, h('a', { href: `/open-requests/${encodeURIComponent(slug)}` }, 'See open reports on a map')) : null);
}

// ---------------------------------------------------------------- 2. where
function where() {
  const list = h('datalist', { id: 'streets' }, S.page.streets.map((s) => h('option', { value: s.name })));
  const street = h('input', { id: 'f-street', list: 'streets', autocomplete: 'off', value: S.street, placeholder: 'Start typing the street' });
  const house = h('input', { id: 'f-house', inputmode: 'numeric', maxlength: 20, value: S.house, autocomplete: 'off' });
  const cross = h('input', { id: 'f-cross', maxlength: 120, value: S.cross, placeholder: 'For example, Bridge Street' });
  const gps = h('p', { role: 'status', class: S.pos ? 'got' : 'muted small' }, S.pos ? `Your location is added (within about ${Math.round(S.pos.acc)} m).` : '');
  const err = h('p', { class: 'err', role: 'alert' });
  const locate = btn(S.pos ? 'Update my location' : 'Use my location', () => {
    if (!navigator.geolocation) { gps.textContent = 'This phone cannot share its location. Type the street instead.'; return; }
    gps.className = 'muted small'; gps.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition((p) => {
      S.pos = { lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, acc: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : 50 };
      gps.className = 'got'; gps.textContent = `Your location is added (within about ${Math.round(S.pos.acc)} m).${S.pos.acc > 100 ? ' That is rough: add the street too if you can.' : ''}`;
    }, () => { gps.className = 'err'; gps.textContent = 'Your location was not shared. Type the street instead, or allow location for this page.'; }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
  const next = () => {
    S.street = street.value.trim(); S.house = house.value.trim(); S.cross = cross.value.trim();
    if (S.street && !streetId()) { err.textContent = 'Pick the street from the list, or leave it empty and type the nearest cross street.'; street.focus(); return; }
    if (!streetId() && !S.cross && !S.pos) { err.textContent = 'Say where: the street, the nearest cross street, or your location.'; street.focus(); return; }
    photos();
  };
  show(org(), step(2), h('h2', null, `Where is the ${S.cat.name.toLowerCase()}?`), afterHours(),
    h('label', { for: 'f-street' }, 'Street'), street, list,
    h('label', { for: 'f-house' }, 'House number ', h('span', { class: 'muted' }, '(the nearest one)')), house,
    h('label', { for: 'f-cross' }, 'Or the nearest cross street'), cross,
    locate, gps, err, btn('Next', next, 'pri'), btn('Back', what));
}
const streetId = () => { const s = S.page.streets.find((x) => x.name.toLowerCase() === S.street.toLowerCase()); return s ? s.id : null; };

// ---------------------------------------------------------------- 3. photos and words
function photos() {
  const thumbs = h('div', { class: 'thumbs' });
  const draw = () => thumbs.replaceChildren(...S.files.map((f, i) => {
    const img = h('img', { alt: `Photo ${i + 1}` });
    img.src = URL.createObjectURL(f);
    return h('span', null, img, h('br'), h('button', { type: 'button', class: 'b small', style: 'min-height:40px;margin:4px 0', onclick: () => { S.files.splice(i, 1); draw(); pick.disabled = false; } }, 'Remove'));
  }));
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, id: 'f-photo', style: 'display:none' });
  const pick = btn('Add a photo', () => file.click(), '', { disabled: S.files.length >= 3 });
  file.addEventListener('change', () => { S.files = [...S.files, ...file.files].filter((f) => f.size < 12 * 1024 * 1024).slice(0, 3); pick.disabled = S.files.length >= 3; file.value = ''; draw(); });
  const desc = h('textarea', { id: 'f-desc', maxlength: 1000 }, S.desc);
  draw();
  show(org(), step(3), h('h2', null, 'Photos and a few words'), h('p', { class: 'muted small' }, 'Both are optional. Up to 3 photos.'),
    pick, file, thumbs, h('label', { for: 'f-desc' }, 'What should the crew know? ', h('span', { class: 'muted' }, '(optional)')), desc,
    btn('Next', () => { S.desc = desc.value.trim(); contact(); }, 'pri'), btn('Back', () => { S.desc = desc.value.trim(); where(); }));
}

// ---------------------------------------------------------------- 4. contact and send
function contact() {
  const need = S.cat.needs_contact;
  const f = (id, label, attrs) => [h('label', { for: id }, label), h('input', { id, ...attrs })];
  const [ln, name] = f('f-name', 'Your name', { maxlength: 120, autocomplete: 'name', value: S.name });
  const [lp, phone] = f('f-phone', 'Phone', { type: 'tel', maxlength: 30, autocomplete: 'tel', value: S.phone });
  const [le, email] = f('f-email', 'Email', { type: 'email', maxlength: 190, autocomplete: 'email', value: S.email });
  const texts = h('input', { type: 'checkbox', id: 'f-texts', checked: S.texts });
  const emails = h('input', { type: 'checkbox', id: 'f-emails', checked: S.emails });
  const err = h('p', { class: 'err', role: 'alert' });
  const send = btn('Send report', async () => {
    Object.assign(S, { name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(), texts: texts.checked, emails: emails.checked });
    err.textContent = '';
    if (need && !S.phone && !S.email) { err.textContent = `For ${S.cat.name.toLowerCase()}, give a phone number or email so the crew can reach you.`; phone.focus(); return; }
    if (S.texts && !S.phone) { err.textContent = 'Type your phone number to get texts.'; phone.focus(); return; }
    if (S.emails && !S.email) { err.textContent = 'Type your email address to get emails.'; email.focus(); return; }
    await submit(send, err);
  }, 'pri');
  show(org(), step(4), h('h2', null, need ? 'How can we reach you?' : 'Do you want updates?'),
    h('p', { class: 'muted small' }, need ? `For ${S.cat.name.toLowerCase()}, the crew may need to reach you. Your details are kept by the municipality and are never shown publicly.` : 'Optional. Your details are kept by the municipality and are never shown publicly.'),
    ln, name, lp, phone, le, email,
    h('label', { class: 'check', for: 'f-texts' }, texts, h('span', null, 'Text me updates about this report. Message and data rates may apply. Reply STOP to stop.')),
    h('label', { class: 'check', for: 'f-emails' }, emails, h('span', null, 'Email me updates about this report.')),
    h('input', { type: 'text', name: 'website', id: 'f-website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-9999px;height:1px;width:1px' }),
    err, send, btn('Back', () => { Object.assign(S, { name: name.value.trim(), phone: phone.value.trim(), email: email.value.trim(), texts: texts.checked, emails: emails.checked }); photos(); }));
}

async function submit(button, err) {
  if (S.sending) return;
  S.sending = true; button.disabled = true; button.textContent = 'Sending…';
  S.rid = S.rid || hex(16); // the same send, tried again on a weak signal, is kept once
  const body = {
    category_id: S.cat.id, street_id: streetId(), house_number: S.house || null, cross_street: S.cross || null, description: S.desc || null,
    ...(S.pos ? { lat: S.pos.lat, lng: S.pos.lng, accuracy: Math.round(S.pos.acc) } : {}),
    name: S.name || null, phone: S.phone || null, email: S.email || null, texts_ok: S.texts, emails_ok: S.emails, rid: S.rid,
    website: (document.getElementById('f-website') || {}).value || '',
  };
  try {
    const out = await call('POST', '/report', body);
    if (!out.token) { show(org(), h('h1', null, 'Thank you'), h('p', null, 'Your report was sent.')); return; }
    keep('last', out.token);
    await sendPhotos(out.token);
    done(out);
  } catch (e) {
    button.disabled = false; button.textContent = 'Try again';
    err.replaceChildren(e.name === 'AbortError' ? 'The signal is weak and the report did not go through. Try again: it will not be sent twice.' : e.message || 'That did not go through. Try again.');
    if (S.page.office_phone) err.append(' ', h('a', { href: tel(S.page.office_phone) }, `Or call ${S.page.office_phone}.`));
  } finally { S.sending = false; }
}

async function sendPhotos(token) {
  for (const [i, f] of S.files.entries()) {
    const ref = `${S.rid.slice(0, 12)}${i}`;
    for (let tries = 0; tries < 2; tries += 1) {
      try { await call('POST', `/report/${token}/photos?client_ref=${ref}`, f, { raw: true, ms: 60000 }); break; } catch (_) { /* tried again once; the report is in */ }
    }
  }
}

function done(out) {
  const link = `${location.origin}/report/${encodeURIComponent(slug)}#s=${out.token}`;
  const copy = btn('Copy the status link', async () => { try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied'; } catch (_) { copy.textContent = link; } });
  show(org(), h('h1', null, 'Thank you. We got your report.'), h('p', null, 'Your reference:'), h('p', { class: 'ref' }, out.reference),
    h('p', null, 'Keep this link to see what happens with it:'), h('p', null, h('a', { href: link }, 'Your report’s status')), copy,
    S.texts || S.emails ? h('p', { class: 'muted' }, `We will send updates by ${[S.texts && 'text', S.emails && 'email'].filter(Boolean).join(' and ')}.`) : null,
    afterHours(), btn('Report something else', () => { Object.assign(S, { cat: null, street: '', house: '', cross: '', pos: null, files: [], desc: '', rid: null }); history.replaceState(null, '', location.pathname); what(); }));
}

// ---------------------------------------------------------------- the status page
async function status(token) {
  show(h('p', { role: 'status' }, 'Loading…'));
  let s;
  try { s = await call('GET', `/report/${token}`); } catch (err) {
    show(h('h1', null, err.status === 404 ? 'Report not found' : 'The status could not load'), h('p', null, err.status === 404 ? 'Check the link you were sent.' : 'Check your signal and try again.'),
      err.status === 404 ? null : btn('Try again', () => status(token), 'pri'), S.page ? btn('Report a problem', () => { history.replaceState(null, '', location.pathname); what(); }) : null);
    return;
  }
  const tl = [['Reported', s.reported_at], ['Made safe', s.made_safe_at], ['Fixed', s.fixed_at], [s.status === 'fixed' ? null : 'Closed', s.status === 'fixed' ? null : s.closed_at]].filter(([k, v]) => k && v);
  const img = (p) => { const i = h('img', { alt: p.stage === 'after' ? 'After the repair' : 'Your photo', loading: 'lazy' }); i.src = `${api}/report/${token}/photos/${p.id}`; return i; };
  const stop = btn('Stop updates', async () => { try { await call('POST', `/report/${token}/stop`); status(token); } catch (e) { stop.textContent = e.message; } });
  show(h('p', { class: 'org' }, s.municipality), h('h1', null, `Report ${s.reference}`), h('p', null, `${s.category}, ${s.place}`),
    h('div', { class: 'got' }, h('h2', { style: 'margin:0' }, s.status_words), h('p', null, s.status_more)),
    s.public_note ? h('p', null, h('strong', null, 'Note: '), s.public_note) : null,
    h('ul', { class: 'tl' }, tl.map(([k, v]) => h('li', null, h('strong', null, `${k}: `), when(v)))),
    s.photos.length ? h('div', { class: 'thumbs' }, s.photos.map(img)) : null,
    s.updates.text || s.updates.email ? [h('p', { class: 'muted small' }, `Updates go to you by ${[s.updates.text && 'text', s.updates.email && 'email'].filter(Boolean).join(' and ')}.`), stop] : null,
    s.office_phone ? h('p', null, 'Questions? Call ', h('a', { href: tel(s.office_phone) }, s.office_phone), '.') : null,
    btn('Report something else', () => { history.replaceState(null, '', location.pathname); if (S.page) what(); else start(); }));
}

start();
