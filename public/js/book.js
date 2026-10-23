// The public lesson booking page (/book/<mountain>). The guest picks a day and a lesson type, sees what is open, and
// reserves. With card payment on, they pay on Stripe's page and the lesson is booked when the payment lands; otherwise the
// request waits for staff and is paid at the desk. It shows no private data.

import './stage.js';
import { mountGuestAssistant } from './guest-assistant.js'; // the staging band (shows only on staging)
import { h, clear, label } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;
const MAX_STUDENTS = 6;
const DAYS_SHOWN = 14;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || T('Something went wrong. Please try again or call the ski school.'));
  return data;
}

const ES = {"From": "Desde", "Only": "Solo", "left": "disponibles", "Total": "Total", "Includes": "Incluye", "tax": "de impuestos", "Student": "Alumno", "Meet at:": "Punto de encuentro:", "Ages:": "Edades:", "Please fill in the name, date of birth and sex for student": "Escribe el nombre, la fecha de nacimiento y el sexo del alumno", "Add another student": "Agregar otro alumno", "All lessons": "Todas las clases", "Already booked?": "¿Ya reservaste?", "Anyone under 18 must be booked by a parent or guardian.": "Los menores de 18 deben ser reservados por un padre o tutor.", "Anything we should know? (optional)": "¿Algo que debamos saber? (opcional)", "Ask for this lesson": "Solicitar esta clase", "Before you pay": "Antes de pagar", "Before you send": "Antes de enviar", "Book another lesson": "Reservar otra clase", "Boot size": "Talla de bota", "Cancel and refund under the policy": "Cancelar y reembolsar según la política", "Cancel this request": "Cancelar esta solicitud", "Cancellation policy": "Política de cancelación", "Cancelled": "Cancelada", "Cancelled. This was inside the no-refund window, so nothing is refunded.": "Cancelada. Fue dentro del plazo sin reembolso, así que no se reembolsa nada.", "Choose a day": "Elige un día", "Choose a lesson": "Elige una clase", "Confirmed. Pay at the ski school desk": "Confirmada. Paga en el mostrador de la escuela de esquí", "Confirming your payment…": "Confirmando tu pago…", "Continue to payment": "Continuar al pago", "Date of birth": "Fecha de nacimiento", "Days with open lessons show how many.": "Los días con clases disponibles muestran cuántas hay.", "Email you used": "El correo que usaste", "Fears, injuries, goals, or who they would like to ski with.": "Miedos, lesiones, metas o con quién le gustaría esquiar.", "Find my booking": "Buscar mi reserva", "Find your booking with the reference we gave you and your email. You can cancel from here too.": "Busca tu reserva con la referencia que te dimos y tu correo. También puedes cancelar desde aquí.", "First name": "Nombre", "Good to know": "Bueno saber", "Height (inches)": "Estatura (pulgadas)", "I have read and accept the cancellation policy.": "He leído y acepto la política de cancelación.", "I have read and accept the waiver, for myself and for each student named above who is under 18.": "He leído y acepto la exención, por mí y por cada alumno menor de 18 nombrado arriba.", "Keep this reference. You can look up or cancel your booking at the bottom of this page.": "Guarda esta referencia. Puedes consultar o cancelar tu reserva al final de esta página.", "Keep your reference and email to check or cancel your request below.": "Guarda tu referencia y correo para consultar o cancelar tu solicitud abajo.", "Last name": "Apellido", "Last spot": "Último lugar", "Lesson type": "Tipo de clase", "Looking further ahead?": "¿Buscas más adelante?", "Most students per booking": "Máximo de alumnos por reserva", "Need a hand?": "¿Necesitas ayuda?", "No more places in this lesson": "No quedan lugares en esta clase", "No tax added": "Sin impuestos", "Not booked": "No reservada", "Not completed (payment not taken)": "No completada (no se cobró)", "Not sure which lesson is right, or booking for a group? The ski school is happy to help.": "¿No sabes qué clase elegir o reservas para un grupo? La escuela de esquí te ayuda con gusto.", "Online booking is not available": "La reserva en línea no está disponible", "Paid and confirmed": "Pagada y confirmada", "Paid at the ski school desk": "Pagada en el mostrador de la escuela", "Pay at the ski school desk": "Paga en el mostrador de la escuela de esquí", "Payment was cancelled, so nothing was booked. Pick a lesson to try again.": "El pago se canceló, así que no se reservó nada. Elige una clase para intentarlo de nuevo.", "Payments are handled by Stripe. We never see or store your card number.": "Los pagos los procesa Stripe. Nunca vemos ni guardamos tu número de tarjeta.", "Pick a day and ask for a lesson. The ski school confirms it, and you pay at the desk.": "Elige un día y solicita una clase. La escuela de esquí la confirma y pagas en el mostrador.", "Pick a day, choose your lesson and pay online. You will see your total before you pay.": "Elige un día, tu clase y paga en línea. Verás el total antes de pagar.", "Please accept the cancellation policy to continue.": "Acepta la política de cancelación para continuar.", "Please accept the waiver to continue.": "Acepta la exención para continuar.", "Please call or visit the ski school to book a lesson.": "Llama o visita la escuela de esquí para reservar una clase.", "Please fill in your name, email and phone number.": "Escribe tu nombre, correo y teléfono.", "Read the waiver": "Leer la exención", "Reference": "Referencia", "Request sent": "Solicitud enviada", "Secure card payment": "Pago seguro con tarjeta", "Send request": "Enviar solicitud", "Size details for gear (optional)": "Tallas para el equipo (opcional)", "Ski and snowboard lessons": "Clases de esquí y snowboard", "Ski or snowboard": "Esquí o snowboard", "Snowboard": "Snowboard", "So the ski school can reach you if the lesson changes.": "Para que la escuela te contacte si la clase cambia.", "Something went wrong. Please try again or call the ski school.": "Algo salió mal. Inténtalo de nuevo o llama a la escuela de esquí.", "Taking you to the payment page…": "Llevándote a la página de pago…", "Thank you": "Gracias", "The ski school could not take this request": "La escuela de esquí no pudo aceptar esta solicitud", "Waiting for payment": "Esperando el pago", "Waiting for the ski school to confirm": "Esperando la confirmación de la escuela", "We could not find a booking with that reference and email.": "No encontramos una reserva con esa referencia y correo.", "We will show your total on the next step.": "Te mostraremos el total en el siguiente paso.", "Weight (pounds)": "Peso (libras)", "Who is booking?": "¿Quién reserva?", "Who is taking the lesson?": "¿Quién toma la clase?", "You are booked": "Tu reserva está hecha", "Your details": "Tus datos", "Your reference is ": "Tu referencia es ", "Your reference is": "Tu referencia es", "Try again": "Intentar de nuevo", "We could not reach the mountain. Check your connection and try again.": "No pudimos conectar con la montaña. Revisa tu conexión e inténtalo de nuevo.", "Buy lift tickets online": "Compra boletos de remontes en línea"};
let LANG = (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
try { const saved = localStorage.getItem('shop-lang'); if (saved === 'en' || saved === 'es') LANG = saved; } catch (_) { /* private mode */ }
const T = (en) => (LANG === 'es' && ES[en]) || en;
const langToggle = () => h('button', { type: 'button', class: 'btn link lang', lang: LANG === 'es' ? 'en' : 'es', onclick: () => { try { localStorage.setItem('shop-lang', LANG === 'es' ? 'en' : 'es'); } catch (_) { /* ignore */ } location.reload(); } }, LANG === 'es' ? 'English' : 'Español');
// ---- small helpers. Native append() would print "null" for a missing piece, so optional pieces go through put().
const put = (el, ...kids) => { for (const k of kids) if (k) el.append(k); return el; };
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const fmt = (s, opts) => new Intl.DateTimeFormat(LANG === 'es' ? 'es-US' : 'en-US', { timeZone: 'UTC', ...opts }).format(dateOf(s));
const dayLong = (s) => fmt(s, { weekday: 'long', month: 'long', day: 'numeric' });
const clock = (s) => { const hr = +s.slice(11, 13); const m = s.slice(14, 16); return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`; };
const addDay = (s, n) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hoursText = (n) => `${n} hours`;
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const badge = (t, cls = '') => h('span', { class: `badge ${cls}`.trim() }, t);

function lessonPrice(l) {
  const all = l.prices.length ? l.prices.map((p) => p.price_cents) : [l.price_cents];
  const lo = Math.min(...all); const hi = Math.max(...all);
  const note = l.prices.length > 1 && lo !== hi ? l.prices.map((p) => `${label(p.tier)} ${money(p.price_cents)}`).join(' · ') : 'per person';
  return { text: lo !== hi ? `${T('From')} ${money(lo)}` : money(lo), note };
}

/** The cancellation policy drawn as three plain steps, so nobody has to read a paragraph to know what they get back. */
function tiersList(page) {
  const tiers = page.policy_tiers || [];
  return h('ul', { class: 'tiers' }, tiers.map((t, i) => {
    const last = i === tiers.length - 1 && t.percent === 0;
    const when = i === 0 ? `Cancel ${hoursText(t.from_hours)} or more before the lesson` : last ? `Cancel less than ${hoursText(tiers[i - 1].from_hours)} before, or do not show up` : `Cancel ${hoursText(t.from_hours)} to ${hoursText(tiers[i - 1].from_hours)} before the lesson`;
    const cls = t.percent === 100 ? 'full' : t.percent === 0 ? 'none' : 'part';
    return h('li', { class: `tier ${cls}` }, h('span', { class: 'pct' }, t.percent === 0 ? 'None' : `${t.percent}%`), h('span', { class: 'when' }, when));
  }));
}

async function main() {
  document.getElementById('book-loading')?.remove();
  let page;
  try { page = await call('GET', '/booking'); } catch (err) {
    // A dropped connection is not the same as booking being off: offer to try again, and point to what else is open.
    const offline = err instanceof TypeError || !navigator.onLine;
    let other = null;
    if (!offline) { try { other = await call('GET', '/shop'); } catch (_) { other = null; } }
    const slug = location.pathname.split('/').filter(Boolean)[1] || '';
    root.append(h('div', { class: 'layout' }, h('div', { class: 'card stack' },
      h('h1', null, offline ? T('Something went wrong. Please try again or call the ski school.') : T('Online booking is not available')),
      h('p', { class: 'muted' }, offline ? T('We could not reach the mountain. Check your connection and try again.') : T('Please call or visit the ski school to book a lesson.')),
      other && other.phone ? h('p', null, h('a', { class: 'btn', href: `tel:${other.phone.replace(/[^\d+]/g, '')}` }, `${LANG === 'es' ? 'Llamar al' : 'Call'} ${other.phone}`)) : null,
      other ? h('p', null, h('a', { class: 'btn', href: `/shop/${encodeURIComponent(slug)}` }, T('Buy lift tickets online'))) : null,
      offline ? h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, T('Try again'))) : null)));
    return;
  }
  document.documentElement.lang = LANG;
  document.title = `${page.mountain}: book a ski lesson`;
  const tel = page.phone ? `tel:${page.phone.replace(/[^\d+]/g, '')}` : null;
  const callLine = page.phone ? ` Please call the mountain on ${page.phone} for updates.` : ' Please call the mountain for updates.';
  const tiers = page.policy_tiers || [];

  // ---- header and progress
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    h('span', { class: 'eyebrow' }, T('Ski and snowboard lessons')),
    h('h1', null, page.mountain),
    h('p', { class: 'sub' }, page.pay_online ? T('Pick a day, choose your lesson and pay online. You will see your total before you pay.') : T('Pick a day and ask for a lesson. The ski school confirms it, and you pay at the desk.')),
    page.message ? h('p', { class: 'note' }, page.message) : null,
    h('div', { class: 'chips-row' }, langToggle(),
      page.pay_online ? h('span', { class: 'trust' }, T('Secure card payment')) : h('span', { class: 'trust' }, T('Pay at the ski school desk')),
      page.pay_online && tiers.length ? h('span', { class: 'trust' }, `Full refund up to ${hoursText(tiers[0].from_hours)} before`) : null,
      tel ? h('a', { class: 'call', href: tel }, `Call ${page.phone}`) : null)));
  const stepNames = [T('Choose a lesson'), T('Your details'), page.pay_online ? 'Pay' : 'Send'];
  const stepsEl = h('nav', { class: 'steps', 'aria-label': 'Progress' }, h('ol', null, stepNames.map((n, i) => h('li', { 'data-step': i + 1 }, `${i + 1}. ${n}`))));
  const setStep = (n) => stepsEl.querySelectorAll('li').forEach((li, i) => { li.className = i + 1 < n ? 'done' : ''; if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });

  // ---- the main column
  const picker = h('section', { class: 'card stack picker', id: 'book-picker', 'aria-labelledby': 'pick-h' });
  const list = h('section', { class: 'stack', id: 'book-list', 'aria-live': 'polite' });
  const formSlot = h('div', { id: 'book-form' });
  const lookup = h('section', { class: 'card stack lookup', id: 'book-lookup' });
  const topSlot = h('div', { class: 'stack' });
  const policyCard = page.pay_online ? h('section', { class: 'card stack', id: 'policy-top' }, h('h2', null, T('Cancellation policy')), tiersList(page), ...(page.policy_notes || []).map((x) => h('p', { class: 'small muted' }, x))) : null;
  const helpCard = h('section', { class: 'card stack' }, h('h2', null, T('Need a hand?')),
    h('p', { class: 'muted' }, T('Not sure which lesson is right, or booking for a group? The ski school is happy to help.')),
    tel ? h('a', { class: 'btn', href: tel }, `Call ${page.phone}`) : null);
  const aside = h('aside', { class: 'aside stack', 'aria-label': T('Good to know') }, policyCard, helpCard);
  const main = h('main', { class: 'main', id: 'book-main' }, topSlot, picker, list, formSlot);
  put(root, hero, stepsEl, h('div', { class: 'layout' }, main, aside), h('div', { class: 'below' }, lookup), h('p', { class: 'footer' }, page.pay_online ? T('Payments are handled by Stripe. We never see or store your card number.') : ''));
  setStep(1);

  // ---- pick a day and a lesson type
  const today = localToday();
  const lessonDays = new Set(page.lessons.map((l) => l.starts_at.slice(0, 10)));
  const state = { day: [...lessonDays].sort().find((d) => d >= today) || today, type: '' };
  const types = [...new Set(page.lessons.map((l) => l.product))].sort();
  const dayIn = h('input', { type: 'date', id: 'pick-day', value: state.day, min: today, max: addDay(today, 45) });
  const dayRow = h('div', { class: 'days', role: 'group', 'aria-label': T('Choose a day') });
  const typeRow = h('div', { class: 'types', id: 'pick-type', role: 'group', 'aria-label': T('Lesson type') });
  const countFor = (d) => page.lessons.filter((l) => l.starts_at.startsWith(d) && (!state.type || l.product === state.type)).length;
  function drawPicker() {
    clear(dayRow);
    for (let i = 0; i < DAYS_SHOWN; i++) {
      const d = addDay(today, i); const n = countFor(d);
      dayRow.append(h('button', { type: 'button', class: `day${n ? '' : ' empty'}`, 'data-day': d, 'aria-pressed': String(d === state.day), 'aria-label': `${dayLong(d)}, ${n ? `${n} lesson${n === 1 ? '' : 's'}` : 'no lessons'}`, onclick: () => pickDay(d) },
        h('span', { class: 'dow' }, i === 0 ? 'Today' : fmt(d, { weekday: 'short' })), h('span', { class: 'num' }, fmt(d, { day: 'numeric' })), h('span', { class: 'cnt' }, n ? `${n} open` : '')));
    }
    clear(typeRow);
    for (const t of ['', ...types]) typeRow.append(h('button', { type: 'button', class: 'pill', 'data-type': t, 'aria-pressed': String(t === state.type), onclick: () => { state.type = t; drawPicker(); showDay(); } }, t || T('All lessons')));
  }
  function pickDay(d) { state.day = d; dayIn.value = d; clear(formSlot); drawPicker(); showDay(); }
  put(picker, h('div', null, h('h2', { id: 'pick-h' }, T('Choose a day')), h('p', { class: 'muted small' }, T('Days with open lessons show how many.'))), dayRow,
    h('div', { class: 'otherdate' }, lab('pick-day', T('Looking further ahead?'), dayIn)),
    types.length > 1 ? h('div', { class: 'stack' }, h('h2', null, T('Lesson type')), typeRow) : typeRow);
  if (types.length <= 1) typeRow.hidden = true;
  dayIn.addEventListener('change', () => { if (dayIn.value) pickDay(dayIn.value); });

  function showDay() {
    clear(list);
    const d = state.day;
    if (!d) return;
    const ls = page.lessons.filter((l) => l.starts_at.startsWith(d) && (!state.type || l.product === state.type));
    if (!ls.length) {
      list.append(h('div', { class: 'empty-day', id: 'no-lessons', role: 'status' },
        h('p', null, `No lessons are scheduled for ${dayLong(d)}${state.type ? ` for ${state.type}` : ''}.${callLine}`),
        tel ? h('a', { class: 'btn', href: tel }, `Call ${page.phone}`) : null));
      return;
    }
    list.append(h('div', { class: 'list-head' }, h('h2', null, dayLong(d)), h('span', { class: 'muted small' }, `${ls.length} lesson${ls.length === 1 ? '' : 's'} open`)),
      h('div', { class: 'lessons' }, ls.map((l) => {
        const pr = lessonPrice(l);
        return h('article', { class: 'lesson', 'data-lesson': l.id },
          h('div', null, h('div', { class: 'when' }, `${clock(l.starts_at)} – ${clock(l.ends_at)}`), h('div', { class: 'what' }, l.product),
            h('div', { class: 'badges' }, [label(l.format), label(l.discipline), label(l.ability_level), l.age_group !== 'all' ? `${T('Ages:')} ${label(l.age_group)}` : null].filter(Boolean).map((t) => badge(t)),
              l.spots_left <= 2 ? badge(l.spots_left === 1 ? T('Last spot') : `${T('Only')} ${l.spots_left} ${T('left')}`, 'warm') : badge(`${l.spots_left} spots open`, 'good')),
            l.meeting_place ? h('p', { class: 'meet' }, `${T('Meet at:')} ${l.meeting_place}`) : null),
          h('div', { class: 'buy' }, h('div', { class: 'price' }, pr.text, h('small', null, pr.note)),
            h('button', { type: 'button', class: 'btn primary', 'aria-label': `${page.pay_online ? 'Reserve' : 'Ask for'} the ${clock(l.starts_at)} ${l.product}`, onclick: () => openForm(l) }, page.pay_online ? 'Reserve' : T('Ask for this lesson'))));
      })));
  }
  drawPicker();
  showDay();

  // ---- the request form
  function openForm(lesson) {
    clear(formSlot);
    picker.hidden = true; list.hidden = true; lookup.hidden = true; root.classList.add('in-form'); setStep(2);
    const leave = () => { clear(formSlot); picker.hidden = false; list.hidden = false; lookup.hidden = false; root.classList.remove('in-form'); setStep(1); picker.scrollIntoView?.(); };
    const max = Math.min(lesson.spots_left, MAX_STUDENTS);
    const f = {};
    const contactSpec = [['first_name', T('First name'), 'text', 'given-name'], ['last_name', T('Last name'), 'text', 'family-name'], ['email', 'Email', 'email', 'email'], ['phone', 'Phone', 'tel', 'tel']];
    for (const [k, , type, ac] of contactSpec) f[k] = h('input', { id: `c-${k}`, name: `contact_${k}`, required: '', maxlength: 100, type, autocomplete: ac, ...(k === 'phone' ? { inputmode: 'tel' } : {}) });
    const studentBox = h('div', { class: 'stack' });
    const students = [];
    let counter = 0;
    const quoteLine = h('div', { class: 'total', id: 'total', 'aria-live': 'polite' }, 'Add each student\'s date of birth to see your total.');
    let quoteTimer = 0; let quoteSeq = 0;
    function refreshQuote() {
      clearTimeout(quoteTimer);
      quoteTimer = setTimeout(async () => {
        const dobs = students.map((s) => s.date_of_birth.value);
        if (dobs.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || +d.slice(0, 4) < 1900)) { clear(quoteLine).append('Add each student\'s date of birth to see your total.'); return; }
        const seq = ++quoteSeq;
        try {
          const q = await call('POST', '/quote', { session_id: lesson.id, students: dobs.map((d) => ({ date_of_birth: d })) });
          if (seq !== quoteSeq) return;
          clear(quoteLine).append(`${T('Total')} ${money(q.total_cents)}`, h('small', null, q.tax_cents ? `${T('Includes')} ${money(q.tax_cents)} ${T('tax')}` : page.pay_online ? T('No tax added') : T('Paid at the ski school desk')));
        } catch (_) { clear(quoteLine).append(T('We will show your total on the next step.')); }
      }, 250);
    }
    const addStudent = () => {
      counter += 1; const n = counter;
      const s = {
        first_name: h('input', { id: `s${n}-first`, required: '', maxlength: 100, autocomplete: 'off' }), last_name: h('input', { id: `s${n}-last`, required: '', maxlength: 100, autocomplete: 'off' }),
        date_of_birth: h('input', { id: `s${n}-dob`, type: 'date', required: '' }),
        sex: h('select', { id: `s${n}-sex` }, [['', 'Choose'], ['female', 'Female'], ['male', 'Male'], ['other', 'Other']].map(([v, t]) => h('option', { value: v }, t))),
        discipline: h('select', { id: `s${n}-disc` }, [['ski', 'Ski'], ['snowboard', T('Snowboard')], ['telemark', 'Telemark'], ['adaptive', 'Adaptive']].map(([v, t]) => h('option', { value: v }, t))),
        height_in: h('input', { id: `s${n}-h`, type: 'number', min: 20, max: 96, inputmode: 'numeric' }), weight_lb: h('input', { id: `s${n}-w`, type: 'number', min: 20, max: 500, inputmode: 'numeric' }), boot_size: h('input', { id: `s${n}-b`, maxlength: 10 }),
      };
      s.date_of_birth.addEventListener('change', refreshQuote); s.date_of_birth.addEventListener('input', refreshQuote);
      const legend = h('legend', null, '');
      s.box = h('fieldset', { class: 'student', 'data-student': n }, legend,
        h('div', { class: 'row2' }, lab(`s${n}-first`, T('First name'), s.first_name), lab(`s${n}-last`, T('Last name'), s.last_name)),
        h('div', { class: 'row2' }, lab(`s${n}-dob`, T('Date of birth'), s.date_of_birth, T('Anyone under 18 must be booked by a parent or guardian.')), lab(`s${n}-sex`, 'Sex', s.sex)),
        lab(`s${n}-disc`, T('Ski or snowboard'), s.discipline),
        h('details', { class: 'more' }, h('summary', null, T('Size details for gear (optional)')), h('div', { class: 'row3' }, lab(`s${n}-h`, T('Height (inches)'), s.height_in), lab(`s${n}-w`, T('Weight (pounds)'), s.weight_lb), lab(`s${n}-b`, T('Boot size'), s.boot_size))));
      s.legend = legend; s.remove = h('button', { type: 'button', class: 'btn link', onclick: () => { const i = students.indexOf(s); students.splice(i, 1); s.box.remove(); renumber(); refreshQuote(); } }, 'Remove');
      students.push(s); studentBox.append(s.box); renumber();
    };
    function renumber() {
      students.forEach((s, i) => { clear(s.legend).append(`${T('Student')} ${i + 1}`); s.remove.remove(); if (students.length > 1) s.legend.append(' ', s.remove); });
      more.disabled = students.length >= max; more.textContent = students.length >= max ? (max >= MAX_STUDENTS ? T('Most students per booking') : T('No more places in this lesson')) : T('Add another student');
      more.hidden = max < 2;
    }
    const more = h('button', { type: 'button', class: 'btn', onclick: () => { if (students.length < max) { addStudent(); refreshQuote(); } } }, T('Add another student'));
    addStudent();
    const accept = h('input', { type: 'checkbox', id: 'accept', name: 'accept' });
    const policy = h('input', { type: 'checkbox', id: 'accept-policy', name: 'accept_policy' });
    const note = h('textarea', { id: 'note', rows: 3, maxlength: 500 });
    const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    const send = h('button', { type: 'submit', class: 'btn primary big' }, page.pay_online ? T('Continue to payment') : T('Send request'));
    const spec = lessonPrice(lesson);
    const form = h('form', { class: 'stack', novalidate: '' },
      h('button', { type: 'button', class: 'btn link back', onclick: leave }, '← Back to lessons'),
      h('div', { class: 'card summary' }, h('strong', null, lesson.product), h('span', null, `${dayLong(lesson.starts_at.slice(0, 10))}, ${clock(lesson.starts_at)} – ${clock(lesson.ends_at)}`),
        lesson.meeting_place ? h('span', { class: 'muted' }, `${T('Meet at:')} ${lesson.meeting_place}`) : null, h('span', { class: 'muted' }, `${spec.text} ${spec.note === 'per person' ? 'per person' : ''}`.trim())),
      h('section', { class: 'card section' }, h('h3', null, h('span', { class: 'num-dot' }, '1'), T('Who is booking?')),
        h('div', { class: 'row2' }, lab('c-first_name', T('First name'), f.first_name), lab('c-last_name', T('Last name'), f.last_name)),
        h('div', { class: 'row2' }, lab('c-email', 'Email', f.email, T('So the ski school can reach you if the lesson changes.')), lab('c-phone', 'Phone', f.phone))),
      h('section', { class: 'card section' }, h('h3', null, h('span', { class: 'num-dot' }, '2'), T('Who is taking the lesson?')), studentBox, more,
        lab('note', T('Anything we should know? (optional)'), note, T('Fears, injuries, goals, or who they would like to ski with.'))),
      h('section', { class: 'card section' }, h('h3', null, h('span', { class: 'num-dot' }, '3'), page.pay_online ? T('Before you pay') : T('Before you send')),
        page.waiver_text ? h('details', { class: 'waiver-read' }, h('summary', null, T('Read the waiver')), h('div', { class: 'waiver-text' }, page.waiver_text)) : null,
        h('label', { class: 'check' }, accept, h('span', null, T('I have read and accept the waiver, for myself and for each student named above who is under 18.'))),
        page.pay_online ? h('div', { class: 'stack', id: 'policy-box' }, h('h4', null, T('Cancellation policy')), tiersList(page), ...(page.policy_notes || []).map((x) => h('p', { class: 'small muted' }, x)),
          h('label', { class: 'check' }, policy, h('span', null, T('I have read and accept the cancellation policy.')))) : null),
      h('div', { class: 'help-trap', 'aria-hidden': 'true' }, trap), msg,
      h('div', { class: 'actionbar' }, quoteLine, send));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(msg);
      const problem = (t) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, t)); msg.scrollIntoView?.({ block: 'center' }); };
      if (Object.values(f).some((c) => !c.value.trim())) return problem(T('Please fill in your name, email and phone number.'));
      for (const [i, s] of students.entries()) if (!s.first_name.value.trim() || !s.last_name.value.trim() || !s.date_of_birth.value || !s.sex.value) return problem(`${T('Please fill in the name, date of birth and sex for student')} ${i + 1}.`);
      if (!accept.checked) return problem(T('Please accept the waiver to continue.'));
      if (page.pay_online && !policy.checked) return problem(T('Please accept the cancellation policy to continue.'));
      send.disabled = true;
      try {
        const out = await call('POST', '/requests', {
          session_id: lesson.id, contact_first_name: f.first_name.value.trim(), contact_last_name: f.last_name.value.trim(), contact_email: f.email.value.trim(), contact_phone: f.phone.value.trim(),
          students: students.map((s) => ({
            first_name: s.first_name.value.trim(), last_name: s.last_name.value.trim(), date_of_birth: s.date_of_birth.value, sex: s.sex.value, discipline: s.discipline.value,
            ...(s.height_in.value ? { height_in: Number(s.height_in.value) } : {}), ...(s.weight_lb.value ? { weight_lb: Number(s.weight_lb.value) } : {}), ...(s.boot_size.value.trim() ? { boot_size: s.boot_size.value.trim() } : {}),
          })),
          waiver_accepted: true, ...(page.pay_online ? { policy_accepted: true } : {}), note: note.value.trim() || undefined, website: trap.value || undefined,
        });
        if (out.checkout_url) {
          try { sessionStorage.setItem(`book-${out.reference}`, f.email.value.trim()); } catch (_) { /* fine without */ }
          msg.append(h('p', { role: 'status' }, T('Taking you to the payment page…')));
          location.href = out.checkout_url;
          return;
        }
        setStep(3);
        clear(formSlot).append(h('section', { class: 'card stack done', role: 'status', id: 'book-done' }, h('h2', null, T('Request sent')),
          h('p', null, T('Your reference is')), h('strong', { class: 'reference' }, out.reference || ''), h('p', null, out.message), h('p', { class: 'muted small' }, T('Keep your reference and email to check or cancel your request below.')),
          h('button', { type: 'button', class: 'btn', onclick: leave }, T('Book another lesson'))));
        lookup.hidden = false;
        formSlot.scrollIntoView?.();
      } catch (err) { problem(err.message); send.disabled = false; }
    });
    formSlot.append(form);
    window.scrollTo?.(0, 0);
  }

  // ---- find, check or cancel a booking
  const ref = h('input', { id: 'l-ref', maxlength: 8, autocapitalize: 'characters', autocomplete: 'off', required: '' });
  const email = h('input', { id: 'l-email', type: 'email', required: '', autocomplete: 'email' });
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  put(lookup, h('div', null, h('h2', null, T('Already booked?')), h('p', { class: 'muted small' }, T('Find your booking with the reference we gave you and your email. You can cancel from here too.'))),
    h('div', { class: 'row2' }, lab('l-ref', T('Reference'), ref), lab('l-email', T('Email you used'), email)),
    h('div', null, h('button', { type: 'button', class: 'btn', id: 'l-check', onclick: check }, T('Find my booking'))), out);
  async function check() {
    clear(out);
    try {
      const r = await call('POST', `/requests/${encodeURIComponent(ref.value.trim())}/status`, { email: email.value.trim() });
      const words = { pending: T('Waiting for the ski school to confirm'), confirmed: r.amount_cents ? T('Paid and confirmed') : T('Confirmed. Pay at the ski school desk'), awaiting_payment: T('Waiting for payment'), expired: T('Not completed (payment not taken)'), declined: T('The ski school could not take this request'), cancelled: T('Cancelled') }[r.status] || label(r.status);
      const tone = r.status === 'confirmed' ? 'ok' : ['declined', 'cancelled', 'expired'].includes(r.status) ? 'bad' : '';
      put(out, h('div', { class: 'stack' }, h('span', { class: `status ${tone}`.trim() }, words),
        h('p', null, `${r.product}, ${dayLong(r.starts_at.slice(0, 10))} at ${clock(r.starts_at)}, ${r.students} student${r.students === 1 ? '' : 's'}.`),
        r.staff_note ? h('p', { class: 'muted' }, r.staff_note) : null,
        r.refund_cents ? h('p', null, `Refund: ${money(r.refund_cents)} back to your card (allow a few days).`) : null,
        ['pending', 'confirmed', 'awaiting_payment'].includes(r.status) ? h('div', null, h('button', { type: 'button', class: 'btn', id: 'l-cancel', onclick: async () => {
          try {
            const c = await call('POST', `/requests/${encodeURIComponent(ref.value.trim())}/cancel`, { email: email.value.trim() });
            await check();
            if (c.refund_percent !== undefined && r.amount_cents) put(out, h('p', { role: 'status' }, c.refund_cents ? `Cancelled. ${c.refund_percent}% refunded: ${money(c.refund_cents)}.` : T('Cancelled. This was inside the no-refund window, so nothing is refunded.')));
          } catch (err) { clear(out).append(h('p', { class: 'error-box', role: 'alert' }, err.message)); }
        } }, r.amount_cents && r.status === 'confirmed' ? T('Cancel and refund under the policy') : T('Cancel this request'))) : null));
    } catch (_) { out.append(h('p', { class: 'error-box', role: 'alert' }, T('We could not find a booking with that reference and email.'))); }
  }

  // ---- coming back from the payment page
  const params = new URLSearchParams(location.search);
  const paidRef = (params.get('paid') || '').toUpperCase();
  if (paidRef) {
    ref.value = paidRef; setStep(3);
    let saved = '';
    try { saved = sessionStorage.getItem(`book-${paidRef}`) || ''; } catch (_) { /* none */ }
    const banner = h('section', { class: 'card stack success', id: 'paid-banner', role: 'status' }, h('h2', null, T('Thank you')), h('p', null, T('Confirming your payment…')));
    topSlot.append(banner);
    if (saved) {
      email.value = saved;
      for (let i = 0; i < 12; i++) {
        try {
          const r = await call('POST', `/requests/${paidRef}/status`, { email: saved });
          if (r.status === 'confirmed') { clear(banner).append(h('h2', null, T('You are booked')), h('p', null, `${r.product}, ${dayLong(r.starts_at.slice(0, 10))} at ${clock(r.starts_at)}.`), h('p', null, T('Your reference is '), h('strong', { class: 'reference' }, paidRef)), h('p', { class: 'muted small' }, T('Keep this reference. You can look up or cancel your booking at the bottom of this page.'))); return; }
          if (['expired', 'cancelled'].includes(r.status)) { clear(banner).append(h('h2', null, T('Not booked')), h('p', null, `That lesson could not be booked and any payment is refunded.${callLine}`)); return; }
        } catch (_) { /* try again */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    clear(banner).append(h('h2', null, T('Thank you')), h('p', null, `Your payment is being processed. Your reference is ${paidRef}. Enter it with your email at the bottom of this page to see your booking.`));
  } else if (params.get('cancelled')) {
    topSlot.append(h('p', { class: 'card', role: 'status' }, T('Payment was cancelled, so nothing was booked. Pick a lesson to try again.')));
  }
}
main();

mountGuestAssistant('booking');
