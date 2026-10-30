// The public page for a private lesson asked for by name (/private/<mountain>). The family picks a discipline, a length
// and an instructor (or any instructor), a day and an open time, then the students, and pays by card (or at the desk when
// the mountain takes no cards online). The instructor accepts within the school's time to answer. The same page, with
// ?r=<token>, shows where the request stands, and lets the family pick another instructor or ask for their money back.
// ?i=<instructor> starts with that instructor picked (the link in an instructor's "ski with me again" email).
import './stage.js';
import { h, clear } from './ui.js';
import { levelList } from './levels.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;
const params = new URLSearchParams(location.search);

const ES = { 'Private lessons': 'Clases privadas', 'Book a private lesson': 'Reserva una clase privada', 'Ski or snowboard': 'Esquí o snowboard', 'How long': 'Duración', 'Instructor': 'Instructor', 'Any instructor': 'Cualquier instructor',
  'Pick a day': 'Elige un día', 'Pick a time': 'Elige una hora', 'No open times that day. Try another day.': 'No hay horarios ese día. Prueba otro día.', 'Who is taking the lesson?': '¿Quién toma la clase?',
  'First name': 'Nombre', 'Last name': 'Apellido', 'Date of birth': 'Fecha de nacimiento', 'Level': 'Nivel', 'Allergies (optional)': 'Alergias (opcional)', 'Medical notes (optional)': 'Notas médicas (opcional)',
  'Who is booking?': '¿Quién reserva?', 'Email': 'Correo', 'Phone': 'Teléfono', 'Continue to payment': 'Continuar al pago', 'Send request': 'Enviar solicitud', 'Add another student': 'Agregar otro alumno',
  'Something went wrong. Please try again or call the ski school.': 'Algo salió mal. Inténtalo de nuevo o llama a la escuela de esquí.', 'Not sure of the level?': '¿No sabes el nivel?', 'Find my level': 'Encontrar mi nivel',
  'Sex': 'Sexo', 'Female': 'Femenino', 'Male': 'Masculino', 'Other': 'Otro', 'Remove': 'Quitar', 'Anything the instructor should know? (optional)': '¿Algo que el instructor deba saber? (opcional)', 'Total': 'Total', 'Your details': 'Tus datos' };
let LANG = (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
try { const saved = localStorage.getItem('shop-lang'); if (saved === 'en' || saved === 'es') LANG = saved; } catch (_) { /* private mode */ }
const T = (en) => (LANG === 'es' && ES[en]) || en;
const put = (el, ...kids) => { for (const k of kids.flat()) if (k) el.append(k); return el; };
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const fmt = (s, opts) => new Intl.DateTimeFormat(LANG === 'es' ? 'es-US' : 'en-US', { timeZone: 'UTC', ...opts }).format(dateOf(s));
const dayLong = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric' });
const clock = (t) => { const hr = +t.slice(0, 2); const m = t.slice(3, 5); return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`; };
const addDay = (s, n) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const lengthWords = (m) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ''}${m % 60} min`);
const DISC = { ski: 'Ski', snowboard: 'Snowboard', telemark: 'Telemark', adaptive: 'Adaptive' };
let uid = 0;
const lab = (text, el, hint) => { const id = el.id || `f${++uid}`; el.id = id; return h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null); };

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || T('Something went wrong. Please try again or call the ski school.'));
  return data;
}

async function main() {
  document.getElementById('private-loading')?.remove();
  document.documentElement.lang = LANG;
  if (params.get('r')) return statusPage(params.get('r'));
  let page;
  try { page = await call('GET', '/private'); } catch (err) {
    root.append(h('div', { class: 'layout' }, h('div', { class: 'card stack' }, h('h1', null, 'Private lessons are not offered online here'),
      h('p', { class: 'muted' }, 'Please call or visit the ski school to book a private lesson.'))));
    return;
  }
  document.title = `${page.mountain}: book a private lesson`;
  const tel = page.phone ? `tel:${page.phone.replace(/[^\d+]/g, '')}` : null;
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    h('span', { class: 'eyebrow' }, T('Private lessons')),
    h('h1', null, page.mountain),
    h('p', { class: 'sub' }, `Pick your instructor and a time. ${page.pay_online ? 'You pay now, and' : 'You pay at the desk, and'} the instructor has ${page.accept_minutes >= 120 ? `${Math.round(page.accept_minutes / 60)} hours` : `${page.accept_minutes} minutes`} to say yes. If they cannot, ${page.decline === 'refund' && page.pay_online ? 'you get your money back in full.' : page.pay_online ? 'you can pick another instructor or get your money back in full.' : 'you can pick another instructor.'}`),
    h('div', { class: 'chips-row' },
      h('button', { type: 'button', class: 'btn link lang', lang: LANG === 'es' ? 'en' : 'es', onclick: () => { try { localStorage.setItem('shop-lang', LANG === 'es' ? 'en' : 'es'); } catch (_) { /* ignore */ } location.reload(); } }, LANG === 'es' ? 'English' : 'Español'),
      h('span', { class: 'trust' }, page.pay_online ? 'Secure card payment' : 'Pay at the ski school desk'),
      tel ? h('a', { class: 'call', href: tel }, `Call ${page.phone}`) : null)));
  const main = h('main', { class: 'main', id: 'private-main' });
  root.append(hero, h('div', { class: 'layout one' }, main));

  // ---- what the family has picked so far
  const disciplines = [...new Set(['ski', 'snowboard', ...page.instructors.flatMap((i) => i.disciplines)])].filter((d) => DISC[d]);
  const wanted = Number(params.get('i')) || null;
  const st = {
    discipline: 'ski', offer: page.offers[0], level: 3,
    instructor: wanted && page.instructors.some((i) => i.id === wanted) ? wanted : 'any',
    day: null, time: null,
  };
  if (st.instructor !== 'any') { const ins = page.instructors.find((i) => i.id === st.instructor); if (ins.disciplines.length && !ins.disciplines.includes('ski')) st.discipline = ins.disciplines[0]; }

  const pick = h('section', { class: 'card stack', 'aria-labelledby': 'p-what' });
  const when = h('section', { class: 'card stack', 'aria-labelledby': 'p-when' });
  const who = h('section', { class: 'card stack', 'aria-labelledby': 'p-who', hidden: true });
  put(main, pick, when, who);

  const pills = (items, current, onPick, name) => h('div', { class: 'types', role: 'group', 'aria-label': name }, items.map(([v, text]) => h('button', { type: 'button', class: 'pill', 'aria-pressed': String(String(v) === String(current)), onclick: () => onPick(v) }, text)));
  const teaches = (i) => (!i.disciplines.length || i.disciplines.includes(st.discipline)) && (!(st.discipline === 'snowboard' ? i.snowboard_level_max : i.ski_level_max) || st.level <= (st.discipline === 'snowboard' ? i.snowboard_level_max : i.ski_level_max));
  function drawPick() {
    const levelSel = h('select', { id: 'p-level' }, levelList(st.discipline).map((l) => h('option', { value: l.level, selected: l.level === st.level }, `${l.level}: ${l.short}`)));
    levelSel.addEventListener('change', () => { st.level = Number(levelSel.value); st.time = null; drawPick(); drawWhen(); });
    const can = levelList(st.discipline)[st.level - 1];
    const list = page.instructors.filter(teaches);
    if (st.instructor !== 'any' && !list.some((i) => i.id === st.instructor)) st.instructor = 'any';
    clear(pick).append(h('h2', { id: 'p-what' }, T('Book a private lesson')),
      h('div', { class: 'field' }, h('span', { class: 'legend' }, T('Ski or snowboard')), pills(disciplines.map((d) => [d, DISC[d]]), st.discipline, (v) => { st.discipline = v; st.time = null; drawPick(); drawWhen(); }, T('Ski or snowboard'))),
      h('div', { class: 'field' }, h('span', { class: 'legend' }, T('How long')), pills(page.offers.map((o) => [o.id, `${lengthWords(o.minutes)}, ${money(o.price_cents)}`]), st.offer.id, (v) => { st.offer = page.offers.find((o) => o.id === Number(v)); st.time = null; drawPick(); drawWhen(); }, T('How long'))),
      lab(T('Level'), levelSel, can ? `"${can.can}"` : null),
      h('p', { class: 'small' }, `${T('Not sure of the level?')} `, h('a', { href: `/level/${encodeURIComponent(slug)}` }, T('Find my level'))),
      h('div', { class: 'field' }, h('span', { class: 'legend' }, T('Instructor')),
        h('div', { class: 'inst-cards', role: 'group', 'aria-label': T('Instructor') },
          instCard({ id: 'any', name: T('Any instructor'), bio: 'The first instructor free at your time.' }),
          ...list.map(instCard)),
        list.length ? null : h('p', { class: 'muted small' }, 'No instructor is listed for this yet. Any instructor works.')));
  }
  function instCard(i) {
    return h('button', { type: 'button', class: 'inst-card', 'aria-pressed': String(st.instructor === i.id), onclick: () => { st.instructor = i.id; st.time = null; drawPick(); drawWhen(); } },
      h('strong', null, i.name), i.bio ? h('span', { class: 'small muted' }, i.bio) : null,
      i.disciplines && i.disciplines.length ? h('span', { class: 'small' }, i.disciplines.map((d) => DISC[d]).join(', ')) : null);
  }

  // ---- the day and the time
  let openDays = new Set();
  async function drawWhen() {
    clear(when).append(h('h2', { id: 'p-when' }, T('Pick a day')));
    const strip = h('div', { class: 'days', role: 'group', 'aria-label': T('Pick a day') });
    const slots = h('div', { class: 'time-grid', role: 'group', 'aria-label': T('Pick a time'), 'aria-live': 'polite' });
    when.append(strip, h('h3', null, T('Pick a time')), slots);
    // Open days come with the first look-up; draw 14 days from the first allowed one.
    const first = page.earliest.slice(0, 10);
    if (!st.day) st.day = first;
    let res;
    try { res = await call('GET', `/private/times?date=${st.day}&offer_id=${st.offer.id}&instructor=${st.instructor}&discipline=${st.discipline}&level=${st.level}`); } catch (err) { slots.append(h('p', { class: 'error-box', role: 'alert' }, err.message)); return; }
    openDays = new Set(res.open_days || []);
    if (!openDays.has(st.day) && openDays.size && !res.times.length) {
      const next = [...openDays].sort().find((d) => d >= first);
      if (next && next !== st.day) { st.day = next; return drawWhen(); }
    }
    for (let k = 0; k < 14; k += 1) {
      const d = addDay(first, k);
      const open = openDays.has(d);
      strip.append(h('button', { type: 'button', class: `day${open ? '' : ' empty'}`, 'aria-pressed': String(d === st.day), 'aria-label': `${dayLong(d)}${open ? '' : ', no open times'}`, onclick: () => { st.day = d; st.time = null; drawWhen(); } },
        h('span', { class: 'dow' }, fmt(d, { weekday: 'short' })), h('span', { class: 'num' }, fmt(d, { day: 'numeric' })), h('span', { class: 'cnt' }, open ? 'Open' : '')));
    }
    // 2026.11.9: the day's private hours from the season plan, and why a length is not sold that day.
    if (res.hours && !res.hours.closed) slots.before(h('p', { class: 'muted small hours-line' }, `Privates this day start and finish between ${clock(res.hours.start)} and ${clock(res.hours.end)}.`));
    if (!res.times.length) { slots.append(h('p', { class: 'empty-day' }, res.note || T('No open times that day. Try another day.'))); who.hidden = true; return; }
    for (const t of res.times) {
      slots.append(h('button', { type: 'button', class: 'pill', 'aria-pressed': String(st.time === t.time), onclick: () => { st.time = t.time; drawWhen(); drawWho(); who.hidden = false; who.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, clock(t.time)));
    }
    if (st.time && !res.times.some((t) => t.time === st.time)) st.time = null;
    who.hidden = !st.time;
    if (st.time) drawWho();
  }

  // ---- the students and the family, then pay
  const students = [];
  function studentBlock(i) {
    const s = students[i];
    const inp = (k, attrs = {}) => { const el = h('input', { value: s[k] || '', ...attrs }); el.addEventListener('input', () => { s[k] = el.value; if (k === 'date_of_birth') drawTotal(); }); return el; };
    const sex = h('select', null, [['', ''], ['female', T('Female')], ['male', T('Male')], ['other', T('Other')]].map(([v, t]) => h('option', { value: v, selected: s.sex === v }, t)));
    sex.addEventListener('change', () => { s.sex = sex.value; });
    const lvl = h('select', null, levelList(st.discipline).map((l) => h('option', { value: l.level, selected: l.level === (s.level || st.level) }, `${l.level}: ${l.short}`)));
    lvl.addEventListener('change', () => { s.level = Number(lvl.value); });
    s.level = s.level || st.level;
    const photo = page.photos ? h('input', { type: 'checkbox', checked: Boolean(s.photo_ok) }) : null;
    if (photo) photo.addEventListener('change', () => { s.photo_ok = photo.checked; });
    return h('fieldset', { class: 'student' }, h('legend', null, `${T('Who is taking the lesson?')} ${students.length > 1 ? i + 1 : ''}`),
      h('div', { class: 'row2' }, lab(T('First name'), inp('first_name', { autocomplete: 'off', maxlength: 100, required: true })), lab(T('Last name'), inp('last_name', { autocomplete: 'off', maxlength: 100, required: true }))),
      h('div', { class: 'row2' }, lab(T('Date of birth'), inp('date_of_birth', { type: 'date', required: true })), lab(T('Sex'), sex)),
      lab(T('Level'), lvl),
      h('div', { class: 'row2' }, lab(T('Allergies (optional)'), inp('allergies', { maxlength: 300 })), lab(T('Medical notes (optional)'), inp('medical', { maxlength: 500 }))),
      photo ? h('label', { class: 'check' }, photo, h('span', null, 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.')) : null,
      students.length > 1 ? h('button', { type: 'button', class: 'btn link', onclick: () => { students.splice(i, 1); drawWho(); } }, T('Remove')) : null);
  }
  const contact = { first_name: '', last_name: '', email: '', phone: '', text_ok: false, note: '' };
  let totalEl = null;
  function drawTotal() {
    if (!totalEl) return;
    const cents = st.offer.price_cents + Math.max(students.length - 1, 0) * st.offer.extra_student_cents;
    clear(totalEl).append(`${T('Total')}: ${money(cents)}`, h('small', null, 'Before any tax. You see the exact total before you pay.'));
  }
  function drawWho() {
    if (!students.length) students.push({});
    const ins = st.instructor === 'any' ? T('Any instructor') : page.instructors.find((i) => i.id === st.instructor).name;
    const cin = (k, attrs) => { const el = h('input', { value: contact[k], ...attrs }); el.addEventListener('input', () => { contact[k] = el.value; }); return el; };
    const textOk = page.texts ? h('input', { type: 'checkbox', checked: contact.text_ok }) : null;
    if (textOk) textOk.addEventListener('change', () => { contact.text_ok = textOk.checked; });
    const note = h('textarea', { maxlength: 500 }, contact.note); note.addEventListener('input', () => { contact.note = note.value; });
    const waiver = h('input', { type: 'checkbox' });
    const policy = page.pay_online ? h('input', { type: 'checkbox' }) : null;
    const err = h('div', { 'aria-live': 'assertive' });
    const send = h('button', { type: 'submit', class: 'btn primary big' }, page.pay_online ? T('Continue to payment') : T('Send request'));
    totalEl = h('div', { class: 'total' });
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'card summary' }, h('strong', null, `${dayLong(st.day)}, ${clock(st.time)}`), h('span', null, `${lengthWords(st.offer.minutes)} ${DISC[st.discipline].toLowerCase()} private with ${ins}`), st.offer.meeting_place ? h('span', { class: 'small' }, `Meet at ${st.offer.meeting_place}`) : null),
      ...students.map((_, i) => studentBlock(i)),
      students.length < st.offer.max_students ? h('button', { type: 'button', class: 'btn', onclick: () => { students.push({}); drawWho(); } }, `${T('Add another student')} (+${money(st.offer.extra_student_cents)})`) : null,
      h('fieldset', { class: 'student' }, h('legend', null, T('Who is booking?')),
        h('div', { class: 'row2' }, lab(T('First name'), cin('first_name', { autocomplete: 'given-name', maxlength: 100 })), lab(T('Last name'), cin('last_name', { autocomplete: 'family-name', maxlength: 100 }))),
        h('div', { class: 'row2' }, lab(T('Email'), cin('email', { type: 'email', autocomplete: 'email', maxlength: 255 })), lab(T('Phone'), cin('phone', { type: 'tel', autocomplete: 'tel', maxlength: 40 }))),
        textOk ? h('label', { class: 'check' }, textOk, h('span', null, 'Text me about this lesson (changes, the instructor\'s answer). Message and data rates may apply. Reply STOP to stop.')) : null,
        lab(T('Anything the instructor should know? (optional)'), note)),
      page.waiver_text ? h('details', { class: 'card' }, h('summary', null, 'Read the waiver'), h('div', { class: 'waiver-text' }, page.waiver_text)) : null,
      h('label', { class: 'check' }, waiver, h('span', null, 'I have read and accept the waiver, for myself and for each student named above who is under 18.')),
      policy ? h('details', { class: 'card' }, h('summary', null, 'Cancellation policy'), h('ul', { class: 'small' }, page.policy.map((p) => h('li', null, p)))) : null,
      policy ? h('label', { class: 'check' }, policy, h('span', null, 'I have read and accept the cancellation policy.')) : null,
      h('input', { class: 'help-trap', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' }),
      err, h('div', { class: 'actionbar' }, totalEl, send));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(err);
      const missing = students.findIndex((s) => !s.first_name || !s.last_name || !s.date_of_birth || !s.sex);
      const say = (m) => { err.append(h('p', { class: 'error-box', role: 'alert' }, m)); };
      if (missing >= 0) return say(`Please fill in the name, date of birth and sex for student ${missing + 1}.`);
      if (!contact.first_name || !contact.last_name || !contact.email || !contact.phone) return say('Please fill in your name, email and phone number.');
      if (!waiver.checked) return say('Please accept the waiver to continue.');
      if (policy && !policy.checked) return say('Please accept the cancellation policy to continue.');
      send.disabled = true;
      try {
        const r = await call('POST', `/private${wanted ? `?i=${wanted}` : ''}`, {
          offer_id: st.offer.id, discipline: st.discipline, date: st.day, time: st.time, instructor: st.instructor,
          contact_first_name: contact.first_name.trim(), contact_last_name: contact.last_name.trim(), contact_email: contact.email.trim(), contact_phone: contact.phone.trim(), text_ok: contact.text_ok,
          students: students.map((s) => ({ first_name: s.first_name.trim(), last_name: s.last_name.trim(), date_of_birth: s.date_of_birth, sex: s.sex, level: Number(s.level) || st.level, allergies: s.allergies || undefined, medical: s.medical || undefined, photo_ok: Boolean(s.photo_ok) })),
          waiver_accepted: true, policy_accepted: Boolean(policy && policy.checked), note: contact.note.trim() || undefined, website: form.querySelector('[name=website]').value || undefined,
        });
        if (r.checkout_url) { location.href = r.checkout_url; return; }
        history.replaceState(null, '', `${location.pathname}?r=${r.token}`);
        clear(root); statusPage(r.token);
      } catch (ex) { say(ex.message); send.disabled = false; }
    });
    clear(who).append(h('h2', { id: 'p-who' }, T('Your details')), form);
    drawTotal();
  }

  drawPick();
  await drawWhen();
}

/** Where a request stands, by its private link. */
async function statusPage(token) {
  let r;
  try {
    r = params.get('paid') ? await call('POST', `/private/r/${encodeURIComponent(token)}/check`, {}) : await call('GET', `/private/r/${encodeURIComponent(token)}`);
  } catch (err) {
    root.append(h('div', { class: 'layout' }, h('div', { class: 'card stack' }, h('h1', null, 'We could not find that request'), h('p', { class: 'muted' }, 'Check the link in your email, or call the ski school.'))));
    return;
  }
  document.title = `${r.mountain}: your private lesson`;
  const box = h('div', { class: 'card stack done' });
  const tel = r.phone ? h('a', { class: 'btn', href: `tel:${r.phone.replace(/[^\d+]/g, '')}` }, `Call ${r.phone}`) : null;
  const when = `${dayLong(r.starts_at.slice(0, 10))}, ${clock(r.starts_at.slice(11, 16))}, ${lengthWords(r.minutes)}`;
  const kids = r.students.map((s) => s.first_name).join(' and ');
  const head = { awaiting_payment: params.get('cancelled') ? 'Payment canceled. Nothing was booked.' : 'Waiting for your payment', waiting: r.instructor ? `Waiting for ${r.instructor} to say yes` : 'Waiting for an instructor to say yes',
    offered: 'Please pick another instructor', accepted: 'Your private lesson is booked', refunded: 'Refunded', declined: 'No instructor was free', cancelled: 'Canceled', expired: 'Not booked' }[r.status] || r.status;
  put(box, h('p', { class: 'eyebrow muted' }, r.mountain), h('span', { class: `status ${r.status === 'accepted' ? 'ok' : ['refunded', 'declined', 'cancelled', 'expired'].includes(r.status) ? 'bad' : ''}` }, head),
    h('h1', null, kids), h('p', null, when), h('p', { class: 'reference' }, r.reference),
    r.status === 'waiting' && r.deadline_at ? h('p', { class: 'muted' }, `You will hear back by ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: r.timezone || undefined }).format(new Date(r.deadline_at))}, by email${r.pay_at_desk ? '' : '. If they cannot, your money comes back in full'}.`) : null,
    r.status === 'accepted' ? h('p', null, `${r.instructor} will teach ${kids}. ${r.pay_at_desk ? 'Please pay at the ski school desk before the lesson.' : 'You are all paid.'} To cancel, use the booking page with your reference and email.`) : null,
    r.status === 'refunded' ? h('p', null, `${money(r.refund_cents || r.amount_cents)} is going back to your card. It can take 5 to 10 days to show.`) : null);
  const list = h('div', { class: 'inst-cards' });
  if (r.status === 'offered') {
    box.append(h('p', null, 'These instructors are free at your time. Pick one and we will ask them right away.'), list);
    for (const i of r.choices) {
      list.append(h('button', { type: 'button', class: 'inst-card', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await call('POST', `/private/r/${encodeURIComponent(token)}/pick`, { instructor: i.id }); clear(root); statusPage(token); } catch (err) { box.append(h('p', { class: 'error-box', role: 'alert' }, err.message)); }
      } }, h('strong', null, i.name), i.bio ? h('span', { class: 'small muted' }, i.bio) : null));
    }
  }
  if (['waiting', 'offered'].includes(r.status)) {
    box.append(h('button', { type: 'button', class: 'btn', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await call('POST', `/private/r/${encodeURIComponent(token)}/refund`, {}); clear(root); statusPage(token); } catch (err) { box.append(h('p', { class: 'error-box', role: 'alert' }, err.message)); }
    } }, r.pay_at_desk ? 'Cancel my request' : 'Cancel and get a full refund'));
  }
  if (r.status === 'awaiting_payment' && !params.get('cancelled')) box.append(h('p', { class: 'muted' }, 'If you just paid, this page updates in a moment.'));
  put(box, h('a', { class: 'btn', href: `/private/${encodeURIComponent(slug)}` }, 'Book another private'), tel);
  root.append(h('div', { class: 'layout one' }, h('main', { class: 'main', id: 'private-main' }, box)));
  if (r.status === 'awaiting_payment' && params.get('paid')) setTimeout(() => { clear(root); statusPage(token); }, 4000);
}

main();
