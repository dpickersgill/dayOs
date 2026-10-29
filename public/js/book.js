// The public lesson booking page (/book/<mountain>). A family says who is coming (name, age, ski or snowboard, level, with
// "Find my level" for anyone not sure), picks a lesson for each person from the lessons that fit (good fits first), adds a
// lift ticket and rental where the lesson offers them, and books it all at once: one payment with card payment on, or
// one request staff confirm (paid at the desk). A full lesson offers its waitlist. It shows no private data.

import './stage.js';
import { mountGuestAssistant } from './guest-assistant.js'; // the staging band (shows only on staging)
import { h, clear } from './ui.js';
import { levelOptions, levelName } from './levels.js';
import { quizPanel, rememberedLevel, rememberLevel } from './levelpicker.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;
const MAX_PEOPLE = 8;
const DAYS_SHOWN = 14;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || T('Something went wrong. Please try again or call the ski school.'));
  return data;
}

const ES = {"From": "Desde", "Only": "Solo", "left": "disponibles", "Total": "Total", "Includes": "Incluye", "tax": "de impuestos", "Student": "Alumno", "Meet at:": "Punto de encuentro:", "Ages:": "Edades:", "All lessons": "Todas las clases", "Already booked?": "¿Ya reservaste?", "Anyone under 18 must be booked by a parent or guardian.": "Los menores de 18 deben ser reservados por un padre o tutor.", "Anything we should know? (optional)": "¿Algo que debamos saber? (opcional)", "Before you pay": "Antes de pagar", "Before you send": "Antes de enviar", "Book another lesson": "Reservar otra clase", "Boot size": "Talla de bota", "Cancel and refund under the policy": "Cancelar y reembolsar según la política", "Cancel this request": "Cancelar esta solicitud", "Cancellation policy": "Política de cancelación", "Canceled": "Cancelada", "Canceled. This was inside the no-refund window, so nothing is refunded.": "Cancelada. Fue dentro del plazo sin reembolso, así que no se reembolsa nada.", "Choose a day": "Elige un día", "Choose a lesson": "Elige una clase", "Confirmed. Pay at the ski school desk": "Confirmada. Paga en el mostrador de la escuela de esquí", "Confirming your payment…": "Confirmando tu pago…", "Continue to payment": "Continuar al pago", "Date of birth": "Fecha de nacimiento", "Email you used": "El correo que usaste", "Fears, injuries, goals, or who they would like to ski with.": "Miedos, lesiones, metas o con quién le gustaría esquiar.", "Find my booking": "Buscar mi reserva", "Find your booking with the reference we gave you and your email. You can cancel from here too.": "Busca tu reserva con la referencia que te dimos y tu correo. También puedes cancelar desde aquí.", "First name": "Nombre", "Good to know": "Bueno saber", "Height (inches)": "Estatura (pulgadas)", "I have read and accept the cancellation policy.": "He leído y acepto la política de cancelación.", "I have read and accept the waiver, for myself and for each student named above who is under 18.": "He leído y acepto la exención, por mí y por cada alumno menor de 18 nombrado arriba.", "Keep this reference. You can look up or cancel your booking at the bottom of this page.": "Guarda esta referencia. Puedes consultar o cancelar tu reserva al final de esta página.", "Keep your reference and email to check or cancel your request below.": "Guarda tu referencia y correo para consultar o cancelar tu solicitud abajo.", "Last name": "Apellido", "Last spot": "Último lugar", "Looking further ahead?": "¿Buscas más adelante?", "Need a hand?": "¿Necesitas ayuda?", "No tax added": "Sin impuestos", "Not booked": "No reservada", "Not completed (payment not taken)": "No completada (no se cobró)", "Not sure which lesson is right, or booking for a group? The ski school is happy to help.": "¿No sabes qué clase elegir o reservas para un grupo? La escuela de esquí te ayuda con gusto.", "Online booking is not available": "La reserva en línea no está disponible", "Paid and confirmed": "Pagada y confirmada", "Paid at the ski school desk": "Pagada en el mostrador de la escuela", "Pay at the ski school desk": "Paga en el mostrador de la escuela de esquí", "Payment was canceled, so nothing was booked. Pick a lesson to try again.": "El pago se canceló, así que no se reservó nada. Elige una clase para intentarlo de nuevo.", "Payments are handled by Stripe. We never see or store your card number.": "Los pagos los procesa Stripe. Nunca vemos ni guardamos tu número de tarjeta.", "Please accept the cancellation policy to continue.": "Acepta la política de cancelación para continuar.", "Please accept the waiver to continue.": "Acepta la exención para continuar.", "Please call or visit the ski school to book a lesson.": "Llama o visita la escuela de esquí para reservar una clase.", "Please fill in your name, email and phone number.": "Escribe tu nombre, correo y teléfono.", "Read the waiver": "Leer la exención", "Reference": "Referencia", "Request sent": "Solicitud enviada", "Secure card payment": "Pago seguro con tarjeta", "Send request": "Enviar solicitud", "Size details for gear (optional)": "Tallas para el equipo (opcional)", "Ski and snowboard lessons": "Clases de esquí y snowboard", "Snowboard": "Snowboard", "So the ski school can reach you if the lesson changes.": "Para que la escuela te contacte si la clase cambia.", "Something went wrong. Please try again or call the ski school.": "Algo salió mal. Inténtalo de nuevo o llama a la escuela de esquí.", "Taking you to the payment page…": "Llevándote a la página de pago…", "Thank you": "Gracias", "The ski school could not take this request": "La escuela de esquí no pudo aceptar esta solicitud", "Waiting for payment": "Esperando el pago", "Waiting for the ski school to confirm": "Esperando la confirmación de la escuela", "We could not find a booking with that reference and email.": "No encontramos una reserva con esa referencia y correo.", "We will show your total on the next step.": "Te mostraremos el total en el siguiente paso.", "Weight (pounds)": "Peso (libras)", "Who is booking?": "¿Quién reserva?", "You are booked": "Tu reserva está hecha", "Your details": "Tus datos", "Your reference is ": "Tu referencia es ", "Your reference is": "Tu referencia es", "Try again": "Intentar de nuevo", "We could not reach the mountain. Check your connection and try again.": "No pudimos conectar con la montaña. Revisa tu conexión e inténtalo de nuevo.", "Buy lift tickets online": "Compra boletos de remontes en línea",
  "Who is coming?": "¿Quién viene?", "Add someone": "Agregar a alguien", "Remove": "Quitar", "Ski": "Esquí", "Level": "Nivel", "Not sure? Find the level": "¿No sabes? Encuentra el nivel", "Pick a level, or find it with five quick questions.": "Elige un nivel o encuéntralo con cinco preguntas rápidas.", "Next: pick lessons": "Siguiente: elegir clases", "Pick a lesson for": "Elige una clase para", "Good fit": "Buena opción", "Not a fit": "No es para", "Show all lessons": "Mostrar todas las clases", "Show good fits only": "Mostrar solo buenas opciones", "Pick this lesson": "Elegir esta clase", "Picked": "Elegida", "Add a lift ticket": "Agregar boleto de remonte", "Add a rental": "Agregar equipo de alquiler", "Full": "Llena", "Join the waitlist": "Unirse a la lista de espera", "Next: your details": "Siguiente: tus datos", "Each person needs a lesson. Pick one, or remove the person.": "Cada persona necesita una clase. Elige una o quita a la persona.", "Safety details": "Datos de seguridad", "Allergies": "Alergias", "Medical notes": "Notas médicas", "Who may pick up": "Quién puede recoger", "Photos in the lesson recap": "Fotos en el resumen de la clase", "Text me about these lessons": "Envíame mensajes de texto sobre estas clases", "Sex": "Sexo", "Female": "Femenino", "Male": "Masculino", "Other": "Otro", "Choose": "Elige", "Your booking": "Tu reserva", "Want a private lesson? Ask for an instructor": "¿Quieres una clase privada? Pide un instructor", "Lift ticket": "Boleto de remonte", "Rental": "Alquiler", "You are on the waitlist": "Estás en la lista de espera", "We email you if a spot opens.": "Te escribimos si se abre un lugar.", "Your email": "Tu correo", "Your phone": "Tu teléfono", "Your name": "Tu nombre", "Back": "Atrás", "Edit": "Editar", "Age": "Edad",
};
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
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint', id: `${id}-hint` }, hint) : null);
const badge = (t, cls = '') => h('span', { class: `badge ${cls}`.trim() }, t);
const ageOn = (dob, day) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return null; let a = +day.slice(0, 4) - +dob.slice(0, 4); if (day.slice(5) < dob.slice(5)) a -= 1; return a; };
const discWord = (d) => ({ ski: T('Ski'), snowboard: T('Snowboard'), telemark: 'Telemark', adaptive: 'Adaptive' }[d] || d);

/** Does a lesson fit this person on its day? The same rule as the server (lib/lessonfamily.fits). */
function fitsPerson(l, p) {
  if (p.discipline && l.discipline !== p.discipline && l.discipline !== 'adaptive' && p.discipline !== 'adaptive') return { ok: false, why: `${discWord(l.discipline)} lesson` };
  const age = ageOn(p.dob, l.starts_at.slice(0, 10));
  if (age !== null && ((l.age_min != null && age < l.age_min) || (l.age_max != null && age > l.age_max))) return { ok: false, why: l.ages };
  const lv = Number(p.level) || null;
  if (lv && ((l.level_min && lv < l.level_min) || (l.level_max && lv > l.level_max))) return { ok: false, why: l.level_words };
  return { ok: true };
}

function lessonPrice(l) {
  const all = l.prices.length ? l.prices.map((p) => p.price_cents) : [l.price_cents];
  const lo = Math.min(...all); const hi = Math.max(...all);
  return { text: lo !== hi ? `${T('From')} ${money(lo)}` : money(lo), note: 'per person' };
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
    root.append(h('div', { class: 'layout' }, h('div', { class: 'card stack' },
      h('h1', null, offline ? T('Something went wrong. Please try again or call the ski school.') : T('Online booking is not available')),
      h('p', { class: 'muted' }, offline ? T('We could not reach the mountain. Check your connection and try again.') : T('Please call or visit the ski school to book a lesson.')),
      other && other.phone ? h('p', null, h('a', { class: 'btn', href: `tel:${other.phone.replace(/[^\d+]/g, '')}` }, `${LANG === 'es' ? 'Llamar al' : 'Call'} ${other.phone}`)) : null,
      other ? h('p', null, h('a', { class: 'btn', href: `/shop/${encodeURIComponent(slug)}` }, T('Buy lift tickets online'))) : null,
      offline ? h('p', null, h('button', { class: 'btn primary', type: 'button', onclick: () => location.reload() }, T('Try again'))) : null)));
    return;
  }
  if (page.assistant) mountGuestAssistant('booking'); // only when the mountain has it on (no request otherwise)
  document.documentElement.lang = LANG;
  document.title = `${page.mountain}: book a ski lesson`;
  const tel = page.phone ? `tel:${page.phone.replace(/[^\d+]/g, '')}` : null;
  const callLine = page.phone ? ` Please call the mountain on ${page.phone} for updates.` : ' Please call the mountain for updates.';
  const tiers = page.policy_tiers || [];
  const params = new URLSearchParams(location.search);
  const wantLesson = Number(params.get('lesson')) || null;
  const all = [...page.lessons, ...(page.full || [])];

  // ---- header and progress
  const hero = h('header', { class: 'hero' }, h('div', { class: 'hero-in' },
    h('span', { class: 'eyebrow' }, T('Ski and snowboard lessons')),
    h('h1', null, page.mountain),
    h('p', { class: 'sub' }, page.pay_online ? 'Tell us who is coming, pick a lesson for each person and pay once. You will see your total before you pay.' : 'Tell us who is coming and pick a lesson for each person. The ski school confirms it, and you pay at the desk.'),
    page.message ? h('p', { class: 'note' }, page.message) : null,
    h('div', { class: 'chips-row' }, langToggle(),
      page.pay_online ? h('span', { class: 'trust' }, T('Secure card payment')) : h('span', { class: 'trust' }, T('Pay at the ski school desk')),
      page.pay_online && tiers.length ? h('span', { class: 'trust' }, `Full refund up to ${hoursText(tiers[0].from_hours)} before`) : null,
      tel ? h('a', { class: 'call', href: tel }, `Call ${page.phone}`) : null)));
  const stepNames = [T('Who is coming?'), T('Choose a lesson'), page.pay_online ? 'Pay' : 'Send'];
  const stepsEl = h('nav', { class: 'steps', 'aria-label': 'Progress' }, h('ol', null, stepNames.map((n, i) => h('li', { 'data-step': i + 1 }, `${i + 1}. ${n}`))));
  const setStep = (n) => stepsEl.querySelectorAll('li').forEach((li, i) => { li.className = i + 1 < n ? 'done' : ''; if (i + 1 === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });

  // ---- the main column
  const stage = h('div', { class: 'stack', id: 'book-stage', 'aria-live': 'polite' });
  const lookup = h('section', { class: 'card stack lookup', id: 'book-lookup' });
  const topSlot = h('div', { class: 'stack' });
  const policyCard = page.pay_online ? h('section', { class: 'card stack', id: 'policy-top' }, h('h2', null, T('Cancellation policy')), tiersList(page), ...(page.policy_notes || []).map((x) => h('p', { class: 'small muted' }, x))) : null;
  const helpCard = h('section', { class: 'card stack' }, h('h2', null, T('Need a hand?')),
    h('p', { class: 'muted' }, T('Not sure which lesson is right, or booking for a group? The ski school is happy to help.')),
    h('a', { class: 'btn', href: `/level/${encodeURIComponent(slug)}` }, 'Find my level'),
    h('a', { class: 'btn', href: `/private/${encodeURIComponent(slug)}`, id: 'private-link' }, T('Want a private lesson? Ask for an instructor')),
    tel ? h('a', { class: 'btn', href: tel }, `Call ${page.phone}`) : null);
  const aside = h('aside', { class: 'aside stack', 'aria-label': T('Good to know') }, policyCard, helpCard);
  const main = h('main', { class: 'main', id: 'book-main' }, topSlot, stage);
  put(root, hero, stepsEl, h('div', { class: 'layout' }, main, aside), h('div', { class: 'below' }, lookup), h('p', { class: 'footer' }, page.pay_online ? T('Payments are handled by Stripe. We never see or store your card number.') : ''));

  // ---- the family: who is coming, and what each has picked
  let seq = 0;
  const remembered = rememberedLevel(slug);
  const newPerson = () => ({ id: ++seq, first_name: '', last_name: '', dob: '', discipline: (remembered && remembered.discipline) || 'ski', level: seq === 1 && remembered ? String(remembered.level) : '', lessonId: null, ticket: false, rental: false });
  const people = [newPerson()];
  const lessonOf = (id) => all.find((l) => l.id === id) || null;
  const chosenCount = (id, except) => people.filter((p) => p !== except && p.lessonId === id).length;

  // ================================================================ step 1: who is coming
  function drawPeople() {
    setStep(1);
    clear(stage);
    const list = h('div', { class: 'stack' });
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    const draw = () => {
      clear(list);
      people.forEach((p, i) => {
        const n = p.id;
        const first = h('input', { id: `p${n}-first`, value: p.first_name, maxlength: 100, autocomplete: 'off', required: '', oninput: (e) => { p.first_name = e.target.value; } });
        const last = h('input', { id: `p${n}-last`, value: p.last_name, maxlength: 100, autocomplete: 'off', required: '', oninput: (e) => { p.last_name = e.target.value; } });
        const dob = h('input', { id: `p${n}-dob`, type: 'date', value: p.dob, required: '', 'aria-describedby': `p${n}-dob-hint`, onchange: (e) => { p.dob = e.target.value; }, oninput: (e) => { p.dob = e.target.value; } });
        const disc = h('div', { class: 'types', role: 'radiogroup', 'aria-label': `${T('Ski')} / ${T('Snowboard')}` }, ['ski', 'snowboard'].map((d) => h('button', { type: 'button', class: 'pill', role: 'radio', 'aria-checked': String(p.discipline === d), 'aria-pressed': String(p.discipline === d), onclick: () => { p.discipline = d; p.level = ''; draw(); } }, discWord(d))));
        const level = h('select', { id: `p${n}-level`, 'aria-describedby': `p${n}-level-hint`, onchange: (e) => { p.level = e.target.value; } }, h('option', { value: '' }, T('Choose')), levelOptions(p.discipline).map(([v, t]) => h('option', { value: v, selected: v === String(p.level) }, t)));
        const quizSlot = h('div');
        const quizBtn = h('button', { type: 'button', class: 'btn', 'aria-expanded': 'false', onclick: () => {
          if (quizSlot.firstChild) { clear(quizSlot); quizBtn.setAttribute('aria-expanded', 'false'); return; }
          quizBtn.setAttribute('aria-expanded', 'true');
          quizSlot.append(h('div', { class: 'card quiz-card' }, quizPanel({ discipline: p.discipline, who: p.first_name.trim(), lang: LANG, onDone: (lv) => { p.level = String(lv); rememberLevel(slug, p.discipline, lv); draw(); document.getElementById(`p${n}-level`)?.focus(); } })));
        } }, T('Not sure? Find the level'));
        list.append(h('fieldset', { class: 'student', 'data-person': n },
          h('legend', null, `${T('Student')} ${i + 1}`, people.length > 1 ? h('button', { type: 'button', class: 'btn link', 'aria-label': `${T('Remove')} ${T('Student').toLowerCase()} ${i + 1}`, onclick: () => { people.splice(people.indexOf(p), 1); draw(); } }, T('Remove')) : null),
          h('div', { class: 'row2' }, lab(`p${n}-first`, T('First name'), first), lab(`p${n}-last`, T('Last name'), last)),
          h('div', { class: 'row2' }, lab(`p${n}-dob`, T('Date of birth'), dob, T('Anyone under 18 must be booked by a parent or guardian.')), h('div', { class: 'field' }, h('span', { class: 'legend' }, `${T('Ski')} / ${T('Snowboard')}`), disc)),
          h('div', { class: 'row2' }, lab(`p${n}-level`, T('Level'), level, T('Pick a level, or find it with five quick questions.')), h('div', { class: 'field quiz-open' }, quizBtn)),
          quizSlot));
      });
      more.disabled = people.length >= MAX_PEOPLE;
    };
    const more = h('button', { type: 'button', class: 'btn', onclick: () => { people.push(newPerson()); draw(); document.getElementById(`p${people.at(-1).id}-first`)?.focus(); } }, `+ ${T('Add someone')}`);
    draw();
    const next = h('button', { type: 'button', class: 'btn primary big', id: 'to-lessons', onclick: () => {
      clear(msg);
      for (const [i, p] of people.entries()) {
        if (!p.first_name.trim() || !p.last_name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.dob) || +p.dob.slice(0, 4) < 1900) {
          msg.append(h('p', { class: 'error-box', role: 'alert' }, `Please add the name and date of birth for student ${i + 1}.`));
          document.getElementById(`p${p.id}-${!p.first_name.trim() ? 'first' : !p.last_name.trim() ? 'last' : 'dob'}`)?.focus();
          return;
        }
      }
      drawLessons(0);
    } }, T('Next: pick lessons'));
    stage.append(h('section', { class: 'card stack section' }, h('h2', null, T('Who is coming?')),
      h('p', { class: 'muted small' }, 'Add everyone who wants a lesson. Each person can pick a different lesson, so brothers and sisters at different levels are fine.'),
      list, h('div', null, more), msg), h('div', { class: 'actionbar' }, h('span', { class: 'muted small' }, `${people.length} ${people.length === 1 ? 'person' : 'people'}`), next));
  }

  // ================================================================ step 2: a lesson for each person
  const view = { day: null, showAll: false };
  function drawLessons(idx) {
    setStep(2);
    clear(stage);
    const p = people[idx];
    const today = localToday();
    const goodFor = (l) => fitsPerson(l, p).ok;
    if (!view.day) {
      const want = wantLesson ? lessonOf(wantLesson) : null;
      view.day = want ? want.starts_at.slice(0, 10) : ([...new Set(all.filter(goodFor).map((l) => l.starts_at.slice(0, 10)))].sort().find((d) => d >= today) || today);
    }
    const tabsRow = people.length > 1 ? h('div', { class: 'types', role: 'tablist', 'aria-label': 'Students' }, people.map((q, i) => h('button', { type: 'button', class: 'pill', role: 'tab', 'aria-selected': String(i === idx), 'aria-pressed': String(i === idx), onclick: () => drawLessons(i) },
      `${q.first_name || `${T('Student')} ${i + 1}`}${q.lessonId ? ' ✓' : ''}`))) : null;
    const lv = Number(p.level) || null;
    const who = h('p', { class: 'muted' }, [p.first_name, p.dob ? `${T('Age')} ${ageOn(p.dob, today)}` : null, discWord(p.discipline), lv ? levelName(lv, p.discipline) : 'Level not set'].filter(Boolean).join(' · '),
      ' ', h('button', { type: 'button', class: 'btn link', onclick: drawPeople }, T('Edit')));
    const dayRow = h('div', { class: 'days', role: 'group', 'aria-label': T('Choose a day') });
    const dayIn = h('input', { type: 'date', id: 'pick-day', value: view.day, min: today, max: addDay(today, 45), onchange: (e) => { if (e.target.value) { view.day = e.target.value; drawLessons(idx); } } });
    const pool = (d) => all.filter((l) => l.starts_at.startsWith(d) && (view.showAll || goodFor(l)));
    for (let i = 0; i < DAYS_SHOWN; i++) {
      const d = addDay(today, i); const nOpen = all.filter((l) => l.starts_at.startsWith(d) && goodFor(l) && l.spots_left > 0).length;
      dayRow.append(h('button', { type: 'button', class: `day${nOpen ? '' : ' empty'}`, 'data-day': d, 'aria-pressed': String(d === view.day), 'aria-label': `${dayLong(d)}, ${nOpen ? `${nOpen} good fit${nOpen === 1 ? '' : 's'}` : 'no good fits'}`, onclick: () => { view.day = d; drawLessons(idx); } },
        h('span', { class: 'dow' }, i === 0 ? 'Today' : fmt(d, { weekday: 'short' })), h('span', { class: 'num' }, fmt(d, { day: 'numeric' })), h('span', { class: 'cnt' }, nOpen ? `${nOpen} fit${nOpen === 1 ? '' : 's'}` : '')));
    }
    const ls = pool(view.day).sort((a, b) => (goodFor(b) - goodFor(a)) || a.starts_at.localeCompare(b.starts_at));
    const hidden = all.filter((l) => l.starts_at.startsWith(view.day) && !goodFor(l)).length;
    const list = h('div', { class: 'lessons', id: 'book-list' });
    if (!ls.length) {
      list.append(h('div', { class: 'empty-day', id: 'no-lessons', role: 'status' },
        h('p', null, `No lessons that fit ${p.first_name || 'this student'} on ${dayLong(view.day)}.${hidden ? '' : callLine}`),
        hidden ? h('button', { type: 'button', class: 'btn', onclick: () => { view.showAll = true; drawLessons(idx); } }, `${T('Show all lessons')} (${hidden})`) : null,
        tel ? h('a', { class: 'btn', href: tel }, `Call ${page.phone}`) : null));
    }
    for (const l of ls) list.append(lessonCard(l, p, idx));
    const done = people.every((q) => q.lessonId);
    const nextIdx = people.findIndex((q, i) => i > idx && !q.lessonId);
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    stage.append(h('section', { class: 'card stack picker', 'aria-labelledby': 'pick-h' },
      tabsRow, h('h2', { id: 'pick-h' }, `${T('Pick a lesson for')} ${p.first_name || `${T('Student')} ${idx + 1}`}`), who, dayRow,
      h('div', { class: 'otherdate' }, lab('pick-day', T('Looking further ahead?'), dayIn)),
      h('div', { class: 'list-head' }, h('h2', null, dayLong(view.day)),
        (hidden || view.showAll) ? h('button', { type: 'button', class: 'btn link', 'aria-pressed': String(view.showAll), onclick: () => { view.showAll = !view.showAll; drawLessons(idx); } }, view.showAll ? T('Show good fits only') : `${T('Show all lessons')} (${hidden} more)`) : null)),
    list,
    h('div', { class: 'actionbar' }, h('button', { type: 'button', class: 'btn', onclick: drawPeople }, `← ${T('Back')}`), msg,
      nextIdx >= 0 && p.lessonId ? h('button', { type: 'button', class: 'btn primary big', onclick: () => { view.showAll = false; drawLessons(nextIdx); } }, `Next: ${people[nextIdx].first_name || `${T('Student')} ${nextIdx + 1}`}`)
        : h('button', { type: 'button', class: 'btn primary big', id: 'to-details', onclick: () => {
          clear(msg);
          const missing = people.findIndex((q) => !q.lessonId);
          if (missing >= 0) { msg.append(h('p', { class: 'error-box', role: 'alert' }, T('Each person needs a lesson. Pick one, or remove the person.'))); if (missing !== idx) drawLessons(missing); return; }
          drawDetails();
        } }, done ? T('Next: your details') : T('Next: your details'))));
    if (wantLesson) document.querySelector(`[data-lesson="${wantLesson}"]`)?.scrollIntoView?.({ block: 'center' });
  }

  function lessonCard(l, p, idx) {
    const fit = fitsPerson(l, p);
    const left = l.spots_left - chosenCount(l.id, p);
    const mine = p.lessonId === l.id;
    const pr = lessonPrice(l);
    const isFull = l.spots_left <= 0;
    const badges = [badge(fit.ok ? T('Good fit') : `${T('Not a fit')}: ${fit.why}`, fit.ok ? 'good' : 'warm'), badge(l.level_words), badge(l.ages), badge(discWord(l.discipline))];
    if (l.format !== 'group') badges.push(badge(l.format.replace('_', ' ')));
    if (!isFull) badges.push(left <= 2 ? badge(left === 1 ? T('Last spot') : left <= 0 ? 'No places left' : `${T('Only')} ${left} ${T('left')}`, 'warm') : badge(`${left} spots open`));
    const extras = mine && (l.offers_ticket || l.offers_rental) ? h('div', { class: 'extras' },
      l.offers_ticket ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.ticket, onchange: (e) => { p.ticket = e.target.checked; } }), h('span', null, `${T('Add a lift ticket')} for ${p.first_name || 'this student'}`)) : null,
      l.offers_rental ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.rental, onchange: (e) => { p.rental = e.target.checked; } }), h('span', null, `${T('Add a rental')} (skis or board, boots, helmet)`)) : null) : null;
    const wl = h('div', { class: 'wl-slot' });
    return h('article', { class: `lesson${mine ? ' picked' : ''}${fit.ok ? '' : ' nofit'}`, 'data-lesson': l.id },
      h('div', null, h('div', { class: 'when' }, `${clock(l.starts_at)} – ${clock(l.ends_at)}`), h('div', { class: 'what' }, l.product),
        h('div', { class: 'badges' }, badges), l.meeting_place ? h('p', { class: 'meet' }, `${T('Meet at:')} ${l.meeting_place}`) : null, extras, wl),
      h('div', { class: 'buy' }, h('div', { class: 'price' }, pr.text, h('small', null, pr.note)),
        isFull ? h('button', { type: 'button', class: 'btn', onclick: () => { if (!wl.firstChild) wl.append(waitlistForm(l, p)); } }, `${T('Full')}: ${T('Join the waitlist')}`)
          : mine ? h('button', { type: 'button', class: 'btn primary', 'aria-pressed': 'true', onclick: () => { p.lessonId = null; p.ticket = false; p.rental = false; drawLessons(idx); } }, `✓ ${T('Picked')}`)
            : h('button', { type: 'button', class: 'btn primary', disabled: left <= 0, 'aria-label': `${T('Pick this lesson')}: ${clock(l.starts_at)} ${l.product} for ${p.first_name}`, onclick: () => { p.lessonId = l.id; p.ticket = false; p.rental = false; drawLessons(idx); } }, T('Pick this lesson'))));
  }

  function waitlistForm(l, p) {
    const name = h('input', { id: `wl-name-${l.id}`, autocomplete: 'name', maxlength: 150 });
    const email = h('input', { id: `wl-email-${l.id}`, type: 'email', autocomplete: 'email', maxlength: 255 });
    const phone = h('input', { id: `wl-phone-${l.id}`, type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 40 });
    const texts = page.texts_available ? h('input', { type: 'checkbox', id: `wl-text-${l.id}` }) : null;
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    const box = h('form', { class: 'card stack wl', novalidate: '' }, h('h3', null, `${T('Join the waitlist')}: ${p.first_name}`),
      h('p', { class: 'muted small' }, 'If a spot opens, the first family waiting gets an email with a link to claim it. The spot is held for a short time.'),
      lab(`wl-name-${l.id}`, T('Your name'), name), h('div', { class: 'row2' }, lab(`wl-email-${l.id}`, T('Your email'), email), lab(`wl-phone-${l.id}`, T('Your phone'), phone)),
      texts ? h('label', { class: 'check' }, texts, h('span', null, 'Text me too when a spot opens. Message and data rates may apply. Reply STOP to stop.')) : null,
      msg, h('button', { type: 'submit', class: 'btn primary' }, T('Join the waitlist')));
    box.addEventListener('submit', async (e) => {
      e.preventDefault(); clear(msg);
      if (!name.value.trim() || !email.value.trim()) { msg.append(h('p', { class: 'error-box', role: 'alert' }, 'Add your name and email.')); return; }
      try {
        const r = await call('POST', '/waitlist', { session_id: l.id, contact_name: name.value.trim(), contact_email: email.value.trim(), contact_phone: phone.value.trim() || undefined, text_ok: texts ? texts.checked : false,
          student: { first_name: p.first_name.trim(), last_name: p.last_name.trim(), ...(p.dob ? { date_of_birth: p.dob } : {}), ...(p.level ? { level: Number(p.level) } : {}) } });
        clear(box).append(h('p', { class: 'status ok', role: 'status' }, `${T('You are on the waitlist')} (#${r.position}). ${T('We email you if a spot opens.')}`));
      } catch (err) { msg.append(h('p', { class: 'error-box', role: 'alert' }, err.message)); }
    });
    return box;
  }

  // ================================================================ step 3: details and payment
  function drawDetails() {
    setStep(3);
    clear(stage);
    const f = {};
    for (const [k, type, ac] of [['first_name', 'text', 'given-name'], ['last_name', 'text', 'family-name'], ['email', 'email', 'email'], ['phone', 'tel', 'tel']]) f[k] = h('input', { id: `c-${k}`, required: '', maxlength: 100, type, autocomplete: ac, ...(k === 'phone' ? { inputmode: 'tel' } : {}) });
    const quoteLine = h('div', { class: 'total', id: 'total', 'aria-live': 'polite' }, T('We will show your total on the next step.'));
    const items = () => people.map((p) => ({ session_id: p.lessonId, student: { date_of_birth: p.dob }, ticket: p.ticket, rental: p.rental }));
    (async () => {
      try {
        const q = await call('POST', '/lesson-basket/quote', { items: items() });
        clear(quoteLine).append(`${T('Total')} ${money(q.total_cents)}`, h('small', null, q.tax_cents ? `${T('Includes')} ${money(q.tax_cents)} ${T('tax')}` : page.pay_online ? T('No tax added') : T('Paid at the ski school desk')));
      } catch (_) { /* the total shows on the payment page */ }
    })();
    const summary = h('section', { class: 'card summary', 'aria-label': T('Your booking') }, h('strong', null, T('Your booking')), people.map((p) => {
      const l = lessonOf(p.lessonId);
      return h('span', null, `${p.first_name}: ${l.product}, ${fmt(l.starts_at.slice(0, 10), { weekday: 'short', month: 'short', day: 'numeric' })} ${clock(l.starts_at)}${p.ticket ? `, + ${T('Lift ticket').toLowerCase()}` : ''}${p.rental ? `, + ${T('Rental').toLowerCase()}` : ''}`);
    }), h('button', { type: 'button', class: 'btn link back', onclick: () => drawLessons(0) }, `${T('Edit')}`));
    const studs = people.map((p) => {
      const n = p.id;
      const s = {
        p, sex: h('select', { id: `s${n}-sex`, required: '' }, [['', T('Choose')], ['female', T('Female')], ['male', T('Male')], ['other', T('Other')]].map(([v, t]) => h('option', { value: v }, t))),
        allergies: h('input', { id: `s${n}-allergies`, maxlength: 300, autocomplete: 'off' }), medical: h('input', { id: `s${n}-medical`, maxlength: 500, autocomplete: 'off' }), pickup: h('input', { id: `s${n}-pickup`, maxlength: 300, autocomplete: 'off' }),
        photo: page.photos_asked ? h('input', { type: 'checkbox', id: `s${n}-photo` }) : null,
        height_in: h('input', { id: `s${n}-h`, type: 'number', min: 20, max: 96, inputmode: 'numeric' }), weight_lb: h('input', { id: `s${n}-w`, type: 'number', min: 20, max: 500, inputmode: 'numeric' }), boot_size: h('input', { id: `s${n}-b`, maxlength: 10 }),
      };
      s.box = h('fieldset', { class: 'student', 'data-student': n }, h('legend', null, `${p.first_name} ${p.last_name}`),
        h('div', { class: 'row2' }, lab(`s${n}-sex`, T('Sex'), s.sex), lab(`s${n}-pickup`, T('Who may pick up'), s.pickup, 'Names of the grown-ups who may collect them.')),
        h('div', { class: 'row2' }, lab(`s${n}-allergies`, T('Allergies'), s.allergies, 'Only the instructor and the desk see this.'), lab(`s${n}-medical`, T('Medical notes'), s.medical, 'Anything the instructor should know.')),
        s.photo ? h('label', { class: 'check' }, s.photo, h('span', null, 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.')) : null,
        p.ticket || p.rental ? h('details', { class: 'more', open: p.rental }, h('summary', null, T('Size details for gear (optional)')), h('div', { class: 'row3' }, lab(`s${n}-h`, T('Height (inches)'), s.height_in), lab(`s${n}-w`, T('Weight (pounds)'), s.weight_lb), lab(`s${n}-b`, T('Boot size'), s.boot_size))) : null);
      return s;
    });
    const textOk = page.texts_available ? h('input', { type: 'checkbox', id: 'text-ok' }) : null;
    const accept = h('input', { type: 'checkbox', id: 'accept', name: 'accept' });
    const policy = h('input', { type: 'checkbox', id: 'accept-policy', name: 'accept_policy' });
    const note = h('textarea', { id: 'note', rows: 3, maxlength: 500 });
    const trap = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    const msg = h('div', { role: 'status', 'aria-live': 'polite' });
    const send = h('button', { type: 'submit', class: 'btn primary big' }, page.pay_online ? T('Continue to payment') : T('Send request'));
    const form = h('form', { class: 'stack', novalidate: '' },
      h('button', { type: 'button', class: 'btn link back', onclick: () => drawLessons(0) }, `← ${T('Back')}`), summary,
      h('section', { class: 'card section' }, h('h3', null, h('span', { class: 'num-dot' }, '1'), T('Who is booking?')),
        h('div', { class: 'row2' }, lab('c-first_name', T('First name'), f.first_name), lab('c-last_name', T('Last name'), f.last_name)),
        h('div', { class: 'row2' }, lab('c-email', 'Email', f.email, T('So the ski school can reach you if the lesson changes.')), lab('c-phone', 'Phone', f.phone)),
        textOk ? h('label', { class: 'check' }, textOk, h('span', null, `${T('Text me about these lessons')}: the confirmation, changes, check-in and the recap. Message and data rates may apply. Reply STOP to stop.`)) : null),
      h('section', { class: 'card section' }, h('h3', null, h('span', { class: 'num-dot' }, '2'), T('Safety details')), studs.map((s) => s.box),
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
      const problem = (t, el) => { msg.append(h('p', { class: 'error-box', role: 'alert' }, t)); (el || msg).scrollIntoView?.({ block: 'center' }); el?.focus?.(); };
      const empty = Object.values(f).find((c) => !c.value.trim());
      if (empty) return problem(T('Please fill in your name, email and phone number.'), empty);
      for (const s of studs) if (!s.sex.value) return problem(`Please choose ${s.p.first_name}'s sex (used for gear and the lesson roster).`, s.sex);
      if (!accept.checked) return problem(T('Please accept the waiver to continue.'), accept);
      if (page.pay_online && !policy.checked) return problem(T('Please accept the cancellation policy to continue.'), policy);
      send.disabled = true;
      const v = (el) => (el && el.value.trim()) || undefined;
      try {
        const out = await call('POST', '/lesson-basket', {
          contact_first_name: f.first_name.value.trim(), contact_last_name: f.last_name.value.trim(), contact_email: f.email.value.trim(), contact_phone: f.phone.value.trim(),
          items: studs.map((s) => ({
            session_id: s.p.lessonId, ticket: s.p.ticket || undefined, rental: s.p.rental || undefined,
            student: {
              first_name: s.p.first_name.trim(), last_name: s.p.last_name.trim(), date_of_birth: s.p.dob, sex: s.sex.value, discipline: s.p.discipline, ...(s.p.level ? { level: Number(s.p.level) } : {}),
              allergies: v(s.allergies), medical: v(s.medical), pickup: v(s.pickup), photo_ok: s.photo ? s.photo.checked : undefined, text_ok: textOk ? textOk.checked : undefined,
              ...(s.height_in.value ? { height_in: Number(s.height_in.value) } : {}), ...(s.weight_lb.value ? { weight_lb: Number(s.weight_lb.value) } : {}), boot_size: v(s.boot_size),
            },
          })),
          waiver_accepted: true, ...(page.pay_online ? { policy_accepted: true } : {}), note: note.value.trim() || undefined, website: trap.value || undefined,
        });
        if (out.checkout_url) {
          try { sessionStorage.setItem(`book-${out.reference}`, f.email.value.trim()); } catch (_) { /* fine without */ }
          msg.append(h('p', { role: 'status' }, T('Taking you to the payment page…')));
          location.href = out.checkout_url;
          return;
        }
        clear(stage).append(h('section', { class: 'card stack done', role: 'status', id: 'book-done' }, h('h2', null, T('Request sent')),
          h('p', null, out.message || ''), h('p', null, T('Your reference is')), h('strong', { class: 'reference' }, (out.requests || []).map((r) => r.reference).join('  ')),
          h('p', { class: 'muted small' }, T('Keep your reference and email to check or cancel your request below.')),
          h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, T('Book another lesson'))));
        stage.scrollIntoView?.();
      } catch (err) { problem(err.message); send.disabled = false; }
    });
    stage.append(form);
    window.scrollTo?.(0, 0);
    f.first_name.focus({ preventScroll: true });
  }

  // ---- find, check or cancel a booking (one lesson's reference)
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
      const words = { pending: T('Waiting for the ski school to confirm'), confirmed: r.amount_cents ? T('Paid and confirmed') : T('Confirmed. Pay at the ski school desk'), awaiting_payment: T('Waiting for payment'), expired: T('Not completed (payment not taken)'), declined: T('The ski school could not take this request'), cancelled: T('Canceled') }[r.status] || r.status;
      const tone = r.status === 'confirmed' ? 'ok' : ['declined', 'cancelled', 'expired'].includes(r.status) ? 'bad' : '';
      put(out, h('div', { class: 'stack' }, h('span', { class: `status ${tone}`.trim() }, words),
        h('p', null, `${r.product}, ${dayLong(r.starts_at.slice(0, 10))} at ${clock(r.starts_at)}, ${r.students} student${r.students === 1 ? '' : 's'}.`),
        r.staff_note ? h('p', { class: 'muted' }, r.staff_note) : null,
        r.refund_cents ? h('p', null, `Refund: ${money(r.refund_cents)} back to your card (allow a few days).`) : null,
        ['pending', 'confirmed', 'awaiting_payment'].includes(r.status) ? h('div', null, h('button', { type: 'button', class: 'btn', id: 'l-cancel', onclick: async () => {
          try {
            const c = await call('POST', `/requests/${encodeURIComponent(ref.value.trim())}/cancel`, { email: email.value.trim() });
            await check();
            if (c.message) put(out, h('p', { role: 'status' }, c.message));
            else if (c.refund_percent !== undefined && r.amount_cents && (r.status === 'confirmed' || c.refund_cents)) put(out, h('p', { role: 'status' }, c.refund_cents ? `Canceled. ${c.refund_percent}% refunded: ${money(c.refund_cents)}.` : T('Canceled. This was inside the no-refund window, so nothing is refunded.')));
          } catch (err) { clear(out).append(h('p', { class: 'error-box', role: 'alert' }, err.message)); }
        } }, r.amount_cents && r.status === 'confirmed' ? T('Cancel and refund under the policy') : T('Cancel this request'))) : null));
    } catch (_) { out.append(h('p', { class: 'error-box', role: 'alert' }, T('We could not find a booking with that reference and email.'))); }
  }

  // ---- coming back from the payment page: a family basket (?basket=) or one lesson (?paid=, older links)
  const basketRef = (params.get('basket') || '').toUpperCase();
  const paidRef = (params.get('paid') || '').toUpperCase();
  const backRef = basketRef || paidRef;
  if (backRef) {
    setStep(3);
    let saved = '';
    try { saved = sessionStorage.getItem(`book-${backRef}`) || ''; } catch (_) { /* none */ }
    const banner = h('section', { class: 'card stack success', id: 'paid-banner', role: 'status' }, h('h2', null, T('Thank you')), h('p', null, T('Confirming your payment…')));
    topSlot.append(banner);
    drawPeople();
    if (saved) {
      email.value = saved;
      for (let i = 0; i < 12; i++) {
        try {
          if (basketRef) {
            const r = await call('POST', `/lesson-basket/${basketRef}/status`, { email: saved });
            if (r.status === 'paid') {
              clear(banner).append(h('h2', null, T('You are booked')), h('ul', { class: 'booked-list' }, r.lessons.map((x) => h('li', null, `${x.product}, ${dayLong(x.starts_at.slice(0, 10))} at ${clock(x.starts_at)}. ${T('Reference')} `, h('strong', null, x.reference)))),
                h('p', { class: 'muted small' }, 'Each family gets an email with a private link for every student: check in, see the details and change the date there.'));
              return;
            }
            if (['expired', 'cancelled'].includes(r.status)) { clear(banner).append(h('h2', null, T('Not booked')), h('p', null, `That booking could not be made and any payment is refunded.${callLine}`)); return; }
          } else {
            const r = await call('POST', `/requests/${paidRef}/status`, { email: saved });
            if (r.status === 'confirmed') { ref.value = paidRef; clear(banner).append(h('h2', null, T('You are booked')), h('p', null, `${r.product}, ${dayLong(r.starts_at.slice(0, 10))} at ${clock(r.starts_at)}.`), h('p', null, T('Your reference is '), h('strong', { class: 'reference' }, paidRef)), h('p', { class: 'muted small' }, T('Keep this reference. You can look up or cancel your booking at the bottom of this page.'))); return; }
            if (['expired', 'cancelled'].includes(r.status)) { clear(banner).append(h('h2', null, T('Not booked')), h('p', null, `That lesson could not be booked and any payment is refunded.${callLine}`)); return; }
          }
        } catch (_) { /* try again */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    clear(banner).append(h('h2', null, T('Thank you')), h('p', null, `Your payment is being processed. Your reference is ${backRef}. Watch for the confirmation email.`));
  } else {
    if (params.get('cancelled')) topSlot.append(h('p', { class: 'card', role: 'status' }, T('Payment was canceled, so nothing was booked. Pick a lesson to try again.')));
    drawPeople();
  }
}
main();
