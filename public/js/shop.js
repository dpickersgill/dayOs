// The public ticket shop (/shop/<mountain>). The guest adds tickets and passes, names who each one is for, sees the exact
// total, then pays on Stripe's page. Tickets appear on this page (with a barcode for the gate) and by email once paid.
// Prices always come from the server; this page only shows them. It shows no private data.

import './stage.js';
import { mountGuestAssistant } from './guest-assistant.js'; // the staging band (shows only on staging)
import { h, clear, appendAll } from './ui.js';
import { code128, qr } from './barcode.js';
import { shrink } from './photo.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('shop');
const base = `/api/v1/public/${encodeURIComponent(slug)}/shop`;
const qs = new URLSearchParams(location.search);

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again or call the mountain.');
  return data;
}
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(dateOf(s.slice(0, 10)));
const addDay = (s, n) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Guest type names: the mountain's own (sent with the shop), falling back to the five every mountain starts with.
const TIER = { child: 'Child', youth: 'Youth', adult: 'Adult', senior: 'Senior', military: 'Military' };
let ONLINE_TYPES = ['child', 'youth', 'adult', 'senior'];
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
let uid = 0;
const ES = {"Fill in every ticket to pay": "Completa cada boleto para pagar", "item": "artículo", "items": "artículos", "About": "Aprox.", "The exact total, with tax, shows when every ticket is filled in.": "El total exacto, con impuestos, aparece al completar cada boleto.", "Your order": "Tu pedido", "Have a promo code?": "¿Tienes un código promocional?", "Tell me if tickets open up": "Avísame si hay boletos", "You are on the list. We will email you once, if tickets open up.": "Estás en la lista. Te escribiremos una vez si hay boletos.", "This day is sold out": "Este día está agotado", "Email": "Correo", "Name": "Nombre", "How many tickets?": "¿Cuántos boletos?", "Send inquiry": "Enviar consulta", "Thank you. We will be in touch.": "Gracias. Nos pondremos en contacto.", "Booking for a group of 6 or more?": "¿Reservas para un grupo de 6 o más?", "Schools, clubs and companies: tell us about your group and we will send a quote.": "Escuelas, clubes y empresas: cuéntanos de tu grupo y te enviaremos una cotización.", "Your name": "Tu nombre", "Group or organization": "Grupo u organización", "Phone": "Teléfono", "How many people?": "¿Cuántas personas?", "Preferred day": "Día preferido", "Anything we should know?": "¿Algo que debamos saber?", "Promo code": "Código promocional", "Gift card": "Tarjeta de regalo", "Add-ons": "Extras", "quantity": "cantidad", "Give a gift card": "Regala una tarjeta", "Amount": "Monto", "Add gift card": "Agregar tarjeta de regalo", "Gift card amount": "Monto de la tarjeta", "Photo for the pass": "Foto para el pase", "A clear photo of the face, for the pass.": "Una foto clara del rostro, para el pase.", "Photo added.": "Foto agregada.", "Saved guests": "Invitados guardados", "Lift tickets and passes": "Boletos de remontes y pases", "Secure card payment": "Pago seguro con tarjeta", "1. Pick a day": "1. Elige un día", "2. Choose services": "2. Elige tus boletos", "3. Who is each ticket for?": "3. ¿Para quién es cada boleto?", "4. Your details": "4. Tus datos", "First name of the person using it": "Nombre de quien lo usará", "Last name": "Apellido", "First name": "Nombre", "Age group": "Grupo de edad", "Date of birth": "Fecha de nacimiento", "Sets the price": "Define el precio", "Needed for a season pass": "Necesario para un pase de temporada", "Choose…": "Elige…", "Remove": "Quitar", "Add a ticket": "Agregar boleto", "Add a ticket to start": "Agrega un boleto para empezar", "Mobile phone": "Teléfono móvil", "Email (we send the tickets here)": "Correo (aquí enviamos los boletos)", "Waiver": "Exención de responsabilidad", "Loading prices…": "Cargando precios…", "Nothing is on sale online for this day.": "No hay boletos en línea para este día.", "Online sales are closed": "Las ventas en línea están cerradas", "Online sales are not open right now.": "Las ventas en línea no están abiertas ahora.", "Everyone": "Todos", "Valid this day only.": "Válido solo este día.", "Payments are handled by Stripe. We never see or store your card number.": "Los pagos los procesa Stripe. Nunca vemos ni guardamos tu número de tarjeta.", "Taking you to the card page…": "Llevándote a la página de pago…", "Previous month": "Mes anterior", "Next month": "Mes siguiente", "Fill in your name, email and phone.": "Escribe tu nombre, correo y teléfono.", "Please read and accept the waiver.": "Lee y acepta la exención de responsabilidad.", "Please confirm you understand tickets are not refundable online.": "Confirma que entiendes que los boletos en línea no son reembolsables.", "Something went wrong. Please try again.": "Algo salió mal. Inténtalo de nuevo.", "Pick a day, choose your tickets, see the exact total, and pay by card. Your tickets arrive by email and on screen.": "Elige un día, elige tus boletos, ve el total exacto y paga con tarjeta. Recibirás los boletos por correo y en pantalla.", "Pick a day above to see what is on sale and the price for each age.": "Elige un día arriba para ver qué hay a la venta y el precio por edad.", "I understand tickets bought online are not refundable. If the mountain closes, I can call for help.": "Entiendo que los boletos comprados en línea no son reembolsables. Si la montaña cierra, puedo llamar para pedir ayuda.", "I have read the waiver. I accept it for myself and for any child under 18 in this order. Other adults in the order will sign at the mountain.": "He leído la exención. La acepto por mí y por cualquier menor de 18 años en este pedido. Los demás adultos firmarán en la montaña.", "Fill in the name and age group for every ticket.": "Completa el nombre y el grupo de edad de cada boleto.", "Leave this empty": "Deja esto vacío"};
let LANG = (navigator.language || '').toLowerCase().startsWith('es') ? 'es' : 'en';
try { const saved = localStorage.getItem('shop-lang'); if (saved === 'en' || saved === 'es') LANG = saved; } catch (_) { /* private mode */ }
const T = (en) => (LANG === 'es' && ES[en]) || en;
function langToggle() {
  return h('button', { type: 'button', class: 'btn link lang', lang: LANG === 'es' ? 'en' : 'es', onclick: () => { try { localStorage.setItem('shop-lang', LANG === 'es' ? 'en' : 'es'); } catch (_) { /* ignore */ } location.reload(); } }, LANG === 'es' ? 'English' : 'Español');
}


const fmtDay = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
function brandIt(page) {
  const b = page.brand;
  if (b && b.color) document.documentElement.style.setProperty('--blue', b.color);
}
function conditionsStrip(page) {
  const c = page.conditions; if (!c) return null;
  const bits = [];
  if (c.status) bits.push(c.status === 'closed' ? 'Closed today' : c.status === 'limited' ? 'Limited operations today' : 'Open today');
  if (c.base_in !== null && c.base_in !== undefined) bits.push(`${Number(c.base_in)}" base`);
  if (c.new_snow_in) bits.push(`${Number(c.new_snow_in)}" new snow`);
  if (c.lifts_open !== null) bits.push(`${c.lifts_open} of ${c.lifts_total} lifts`);
  if (c.trails_open !== null) bits.push(`${c.trails_open} of ${c.trails_total} trails`);
  return bits.length ? h('ul', { class: 'conditions', 'aria-label': 'Conditions today' }, bits.map((x) => h('li', null, x))) : null;
}
function hero(page, title, sub) {
  brandIt(page);
  const b = page.brand || {};
  const presale = b.opening_day && b.opening_day > page.today;
  const tel = page.phone ? `tel:${page.phone.replace(/[^\d+]/g, '')}` : null;
  return h('header', { class: `hero${b.hero ? ' has-photo' : ''}`, style: b.hero ? `background-image: linear-gradient(rgba(10,20,35,.55), rgba(10,20,35,.7)), url(${b.hero})` : '' }, h('div', { class: 'hero-in' },
    b.logo ? h('img', { class: 'logo', src: b.logo, alt: `${page.mountain} logo` }) : null,
    h('span', { class: 'eyebrow' }, T('Lift tickets and passes')), h('h1', null, page.mountain),
    presale ? h('p', { class: 'presale' }, `We open ${fmtDay(b.opening_day)}.${b.opening_note ? ` ${b.opening_note}` : ' Buy ahead and pick any day.'}`) : null,
    conditionsStrip(page), h('p', { class: 'sub' }, sub || title),
    page.message ? h('p', { class: 'note' }, page.message) : null,
    h('div', { class: 'chips-row' }, langToggle(), h('span', { class: 'trust' }, T('Secure card payment')), tel ? h('a', { class: 'call', href: tel }, `Call ${page.phone}`) : null)));
}
const shell = (...kids) => h('div', { class: 'layout' }, h('main', { class: 'main stack', id: 'shop-main' }, ...kids));

// A guest moves one ticket to another day. The server checks the rules and the price again.
function changeBox(t, policy, token) {
  const date = h('input', { type: 'date', id: `chg-${t.code}`, min: t.valid_from, 'aria-label': 'New day' });
  const msg = h('p', { class: 'small', role: 'status' });
  const go = h('button', { class: 'btn no-print', type: 'button' }, 'Move to this day');
  go.addEventListener('click', async () => {
    msg.textContent = ''; if (!date.value) { msg.textContent = 'Pick the new day first.'; return; }
    go.disabled = true;
    try {
      const out = await call('POST', `/orders/${encodeURIComponent(token)}/change`, { ticket_code: t.code, date: date.value });
      if (out.checkout_url) { location.href = out.checkout_url; return; }
      location.href = `${location.pathname}?order=${encodeURIComponent(token)}&changed=1`;
    } catch (e) { msg.textContent = e.message; go.disabled = false; }
  });
  return h('details', { class: 'change no-print' }, h('summary', null, 'Change the day'),
    h('p', { class: 'muted small' }, `You can move this ticket up to ${policy.hours} hours before the day.${policy.fee_cents ? ` A change costs ${money(policy.fee_cents)}, plus any rise in the ticket price.` : ' A change is free if the price is the same.'} A lower price is not refunded.`),
    h('div', { class: 'field' }, h('label', { for: `chg-${t.code}` }, 'New day'), date), go, msg);
}

// ---------------------------------------------------------------- the guest's tickets
async function showOrder(token) {
  const draw = (v) => {
    clear(root);
    const paid = v.status === 'paid';
    root.append(hero(v, '', paid ? 'You are all set. Show a barcode on your phone at the gate.' : 'Checking your payment…'),
      shell(
        qs.get('changed') ? h('div', { class: 'card' }, h('strong', null, 'Your ticket has been moved. '), 'The new day is on the ticket below.') : null,
        paid ? h('section', { class: 'card stack' }, h('h2', null, `Thank you, ${v.name.split(' ')[0]}`), h('p', { class: 'muted' }, `Order ${v.reference}, ${money(v.amount_cents)}. Keep this page (bookmark or screenshot it): it is your ticket. Turn your screen brightness up at the gate, or print it.`),
          h('button', { class: 'btn no-print', type: 'button', onclick: () => window.print() }, 'Print tickets'))
          : h('section', { class: 'card stack' }, h('h2', null, v.status === 'awaiting_payment' ? 'Waiting for your payment to finish' : 'This order was not completed'), h('p', { class: 'muted' }, v.status === 'awaiting_payment' ? 'This usually takes a few seconds. This page updates by itself.' : `Nothing was charged for this order, or it was refunded.${v.phone ? ` Questions? Call ${v.phone}.` : ''}`)),
        paid ? h('div', { class: 'pass-grid' }, v.tickets.map((t) => h('article', { class: 'pass-card' },
          h('span', { class: 'who' }, `${t.first_name || ''} ${t.last_name || ''}`.trim() || 'Ticket'), h('span', null, t.product),
          h('span', { class: 'muted' }, t.valid_from === t.valid_to ? dayLong(t.valid_from) : `${dayLong(t.valid_from)} to ${dayLong(t.valid_to)}`),
          t.status === 'void' ? h('span', { class: 'void' }, 'Canceled and refunded') : [code128(t.code, { height: 64, module: 2 }), qr(t.code, { size: 120 })],
          h('span', { class: 'code' }, t.code),
          t.movable && v.changes ? changeBox(t, v.changes, token) : null))) : null,
        paid && v.gift_cards && v.gift_cards.length ? h('div', { class: 'pass-grid' }, v.gift_cards.map((g) => h('article', { class: 'pass-card' }, h('span', { class: 'who' }, `Gift card ${money(g.amount_cents)}`), g.recipient_name ? h('span', null, `For ${g.recipient_name}`) : null, g.message ? h('span', { class: 'muted' }, g.message) : null, code128(g.code, { height: 64, module: 2 }), h('span', { class: 'code' }, g.code)))) : null));
    return v;
  };
  let tries = 0;
  for (;;) {
    let v;
    try { v = await call('GET', `/orders/${encodeURIComponent(token)}`); } catch (e) { clear(root); root.append(shell(h('section', { class: 'card stack' }, h('h1', null, 'We could not find that order'), h('p', { class: 'muted' }, 'Check the link in your email, or call the mountain.')))); return; }
    draw(v);
    if (v.status !== 'awaiting_payment' || ++tries > 20) return;
    await new Promise((r) => setTimeout(r, 2500));
  }
}

// ---------------------------------------------------------------- the shop
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const AGE_ES = { child: 'Niño (menor de 13)', youth: 'Joven (13 a 17)', adult: 'Adulto (18 a 64)', senior: 'Mayor (65 o más)' };
const AGE_EN = { child: 'Child (under 13)', youth: 'Youth (13 to 17)', adult: 'Adult (18 to 64)', senior: 'Senior (65 and over)' };
// A type the mountain renamed or added shows its own name and ages; the five it started with keep their translations.
let TYPES = null;
const DEFAULT_NAMES = { child: 'Child', youth: 'Youth', adult: 'Adult', senior: 'Senior', military: 'Military' };
const ages = (t) => (t.min_age == null && t.max_age == null ? '' : t.max_age == null ? (LANG === 'es' ? ` (${t.min_age} o más)` : ` (${t.min_age} and over)`)
  : !t.min_age ? (LANG === 'es' ? ` (menor de ${t.max_age + 1})` : ` (under ${t.max_age + 1})`) : (LANG === 'es' ? ` (${t.min_age} a ${t.max_age})` : ` (${t.min_age} to ${t.max_age})`));
const AGE = new Proxy({}, { get: (_, k) => {
  const t = TYPES && TYPES.find((x) => x.code === k);
  if (t && !(DEFAULT_NAMES[k] === t.name && (LANG === 'es' ? AGE_ES : AGE_EN)[k])) return `${t.name}${ages(t)}`;
  return (LANG === 'es' ? AGE_ES : AGE_EN)[k] || (t ? t.name : DEFAULT_NAMES[k] || k);
} });

function groupBox() {
  const f = (id, props = {}) => h('input', { id, maxlength: 150, ...props });
  const name = f('gr-name'); const org = f('gr-org'); const em = f('gr-email', { type: 'email', maxlength: 255 }); const ph = f('gr-phone', { type: 'tel', maxlength: 40 });
  const size = f('gr-size', { type: 'number', min: 6, max: 5000 }); const on = f('gr-date', { type: 'date' }); const note = h('textarea', { id: 'gr-note', rows: 3, maxlength: 1000 });
  const msg = h('p', { role: 'status', class: 'small' });
  const go = h('button', { class: 'btn', type: 'button' }, T('Send inquiry'));
  go.addEventListener('click', async () => {
    msg.textContent = '';
    try {
      await call('POST', '/group', { contact_name: name.value.trim(), organisation: org.value.trim() || undefined, email: em.value.trim(), phone: ph.value.trim() || undefined, group_size: Number(size.value), preferred_on: on.value || undefined, note: note.value.trim() || undefined });
      msg.textContent = T('Thank you. We will be in touch.'); go.disabled = true;
    } catch (e) { msg.textContent = e.message; }
  });
  return h('details', { class: 'card stack' }, h('summary', null, h('strong', null, T('Booking for a group of 6 or more?'))),
    h('p', { class: 'muted' }, T('Schools, clubs and companies: tell us about your group and we will send a quote.')),
    h('div', { class: 'cols' }, lab('gr-name', T('Your name'), name), lab('gr-org', T('Group or organization'), org), lab('gr-email', T('Email'), em), lab('gr-phone', T('Phone'), ph), lab('gr-size', T('How many people?'), size), lab('gr-date', T('Preferred day'), on)),
    lab('gr-note', T('Anything we should know?'), note), h('div', { class: 'row' }, go), msg);
}

async function showShop() {
  let page;
  try {
    page = await call('GET', '');
    if (page.guest_types) { TYPES = page.guest_types; ONLINE_TYPES = TYPES.filter((t) => t.online).map((t) => t.code); for (const t of TYPES) TIER[t.code] = t.name; }
  } catch (_) {
    clear(root).append(shell(h('section', { class: 'card stack' }, h('h1', null, 'Online sales are not available'), h('p', { class: 'muted' }, 'Please buy at the ticket window.')))); return;
  }
  document.title = `${page.mountain}: ${LANG === 'es' ? 'boletos y pases' : 'buy tickets and passes'}`;
  document.documentElement.lang = LANG;
  clear(root);
  const today = page.today;
  const lastDay = addDay(today, 365);
  const basket = []; // { id, product, date, f, l, dob, priceEl, badEl, el }
  const rowsEl = h('div', { class: 'stack', 'aria-live': 'polite' });
  const totalEl = h('div', { class: 'totals' });
  const err = h('div', { role: 'alert', class: 'error-box', hidden: true });
  const pay = h('button', { class: 'btn primary big', type: 'submit', disabled: true }, T('Add a ticket to start'));
  const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };

  // A day is closed when every product is blacked out that day. (The server decides again when pricing.)
  const closed = (d) => page.products.length > 0 && page.products.every((p) => p.closed_dates.includes(d));
  let picked = null; let shown = today.slice(0, 7); // 'YYYY-MM'
  const calEl = h('div', { class: 'cal' });
  const svcEl = h('div', { class: 'stack', 'aria-live': 'polite' });
  const svcHead = h('h2', { id: 'svc-h' }, T('2. Choose services'));

  const months = new Map(); // 'YYYY-MM' -> { 'YYYY-MM-DD': { state, from_cents } }
  async function loadMonth(ym) {
    if (months.has(ym)) return;
    months.set(ym, {});
    try { months.set(ym, (await call('GET', `/month?month=${ym}`)).days || {}); drawCal(); } catch (_) { /* the calendar still works without prices */ }
  }

  function drawCal() {
    loadMonth(shown);
    const info = months.get(shown) || {};
    const [y, m] = shown.split('-').map(Number);
    const first = `${shown}-01`;
    const lead = dateOf(first).getUTCDay();
    const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const used = new Set(basket.map((r) => r.date));
    const prevOk = shown > today.slice(0, 7);
    const nextOk = shown < lastDay.slice(0, 7);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-pad', 'aria-hidden': 'true' }));
    for (let n = 1; n <= count; n++) {
      const d = `${shown}-${String(n).padStart(2, '0')}`;
      const di = info[d];
      const off = d < today || d > lastDay || closed(d) || (di && (di.state === 'sold_out' || di.state === 'closed'));
      const sub = !off && di && di.from_cents ? h('small', { class: `cal-p${di.state === 'few' ? ' few' : ''}` }, `$${Math.round(di.from_cents / 100)}`) : (di && di.state === 'sold_out' ? h('small', { class: 'cal-p' }, 'Sold out') : null);
      cells.push(h('button', { type: 'button', class: `cal-day${d === picked ? ' on' : ''}${used.has(d) ? ' has' : ''}${d === today ? ' today' : ''}`, disabled: off, 'aria-pressed': d === picked ? 'true' : 'false',
        'aria-label': `${dayLong(d)}${off ? ', not available' : ''}${!off && di && di.from_cents ? `, from $${Math.round(di.from_cents / 100)}` : ''}${!off && di && di.state === 'few' ? ', few left' : ''}${used.has(d) ? ', tickets in your order' : ''}`, onclick: () => pickDay(d) }, h('span', null, String(n)), sub));
    }
    clear(calEl).append(
      h('div', { class: 'cal-head' },
        h('button', { type: 'button', class: 'btn', disabled: !prevOk, 'aria-label': T('Previous month'), onclick: () => { shown = addMonth(shown, -1); drawCal(); } }, '‹'),
        h('strong', { 'aria-live': 'polite' }, `${MONTHS[m - 1]} ${y}`),
        h('button', { type: 'button', class: 'btn', disabled: !nextOk, 'aria-label': T('Next month'), onclick: () => { shown = addMonth(shown, 1); drawCal(); } }, '›')),
      h('div', { class: 'cal-grid', role: 'group', 'aria-label': 'Choose a day' }, ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => h('span', { class: 'cal-w', 'aria-hidden': 'true' }, w)), cells),
      h('p', { class: 'hint' }, 'Prices are the lowest ticket that day. Amber prices mean few are left. Gray days are not on sale or are sold out.'));
  }
  const addMonth = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 7); };

  async function pickDay(d) {
    picked = d; drawCal();
    const ph = document.getElementById('pick-hint'); if (ph) ph.hidden = true;
    svcHead.textContent = `2. Choose services for ${dayLong(d)}`;
    clear(svcEl).append(h('p', { class: 'muted', role: 'status' }, T('Loading prices…')));
    try {
      const out = await call('GET', `/day?date=${d}`);
      if (picked !== d) return;
      const cards = out.products.map((p) => {
        const same = p.prices.length && p.prices.every((x) => x.price_cents === p.prices[0].price_cents);
        const when = p.kind === 'season_pass' ? `Starts on this day and is valid ${p.valid_days} days.` : p.valid_days > 1 ? `${p.valid_days} days in a row, starting this day.` : T('Valid this day only.');
        return h('article', { class: `prod${p.available ? '' : ' off'}` },
          h('h3', null, p.name),
          h('span', { class: 'tiers-line' }, `${when}${p.uses ? ` ${p.uses} rides.` : ''}${p.available && p.days_text ? ` Sold ${p.days_text}.` : ''}`),
          p.available && p.left !== null && p.left <= 20 ? h('span', { class: 'few' }, p.left === 1 ? 'Only 1 left for this day' : `Only ${p.left} left for this day`) : null,
          p.available
            ? h('ul', { class: 'agelist' }, same ? h('li', null, h('span', null, T('Everyone')), h('b', null, money(p.prices[0].price_cents))) : p.prices.map((x) => h('li', null, h('span', null, AGE[x.tier]), h('b', null, x.was_cents ? [h('s', { class: 'was' }, money(x.was_cents)), ' ', money(x.price_cents)] : money(x.price_cents)))))
            : h('span', { class: 'bad' }, p.reason || 'Not sold on this day.'),
          p.available ? h('button', { class: 'btn', type: 'button', onclick: () => add(p, d) }, T('Add a ticket')) : null);
      });
      const soldOut = out.products.filter((p) => p.kind !== 'season_pass').length > 0 && out.products.filter((p) => p.kind !== 'season_pass').every((p) => !p.available && /Sold out/.test(p.reason || ''));
      clear(svcEl).append(cards.length ? h('div', { class: 'prod-grid' }, cards) : h('p', { class: 'muted' }, T('Nothing is on sale online for this day.')), ...(soldOut ? [waitlistBox(d)] : []));
    } catch (e) { clear(svcEl).append(h('div', { role: 'alert', class: 'error-box' }, e.message)); }
  }

  // Guests from earlier visits, kept on this device only.
  const GKEY = `shop-guests-${location.pathname}`;
  const loadGuests = () => { try { const g = JSON.parse(localStorage.getItem(GKEY) || '[]'); return Array.isArray(g) ? g.slice(0, 12) : []; } catch (_) { return []; } };
  const saveGuests = () => {
    try {
      const have = loadGuests();
      for (const r of basket) {
        if (r.pass) continue;
        const g = { f: r.f.value.trim(), l: r.l.value.trim(), a: r.age.value };
        if (g.f && g.l && g.a && !have.some((x) => x.f === g.f && x.l === g.l)) have.push(g);
      }
      localStorage.setItem(GKEY, JSON.stringify(have.slice(-12)));
      localStorage.setItem(`${GKEY}-me`, JSON.stringify({ f: bf.value.trim(), l: bl.value.trim(), e: be.value.trim(), p: bp.value.trim() }));
    } catch (_) { /* storage can be off; the shop works without it */ }
  };

  function add(p, date) {
    const id = ++uid;
    const f = h('input', { id: `f${id}`, autocomplete: 'off', maxlength: 60, required: true });
    const l = h('input', { id: `l${id}`, autocomplete: 'off', maxlength: 60, required: true });
    const pass = p.kind === 'season_pass';
    const dob = h('input', { type: 'date', id: `b${id}`, max: today, required: true });
    const age = h('select', { id: `a${id}`, required: true }, h('option', { value: '' }, T('Choose…')), ONLINE_TYPES.map((k) => [k, AGE[k]]).map(([k, v]) => h('option', { value: k }, v)));
    const priceEl = h('span', { class: 'line-price' });
    const badEl = h('span', { class: 'bad', role: 'alert' });
    const shot = { data: null };
    const photoIn = h('input', { type: 'file', accept: 'image/*', id: `ph${id}` });
    const photoMsg = h('span', { class: 'hint', role: 'status' }, T('A clear photo of the face, for the pass.'));
    photoIn.addEventListener('change', async () => {
      try { shot.data = await shrink(photoIn.files[0]); photoMsg.textContent = T('Photo added.'); } catch (e) { shot.data = null; photoMsg.textContent = e.message; }
      sync();
    });
    const row = { id, product: p, date, f, l, dob, age, pass, shot, priceEl, badEl };
    row.el = h('div', { class: 'ticket-row' },
      h('div', { class: 'row-head' }, h('div', null, h('h3', null, p.name), h('span', { class: 'muted' }, dayLong(date))), h('span', null, priceEl, ' ', h('button', { class: 'btn link', type: 'button', onclick: () => { basket.splice(basket.indexOf(row), 1); row.el.remove(); drawCal(); sync(); } }, T('Remove')))),
      h('div', { class: 'cols' }, lab(`f${id}`, T('First name of the person using it'), f), lab(`l${id}`, T('Last name'), l), pass ? lab(`b${id}`, T('Date of birth'), dob, T('Needed for a season pass')) : lab(`a${id}`, T('Age group'), age, T('Sets the price'))),
      badEl);
    for (const el of [f, l, dob, age]) el.addEventListener('input', sync);
    const saved = pass ? [] : loadGuests().filter((g) => !basket.some((r) => r.f.value.trim() === g.f && r.l.value.trim() === g.l));
    if (saved.length) {
      row.el.insertBefore(h('div', { class: 'saved-row', role: 'group', 'aria-label': T('Saved guests') }, h('span', { class: 'muted small' }, T('Saved guests') + ':'),
        saved.map((g) => h('button', { type: 'button', class: 'chip', onclick: () => { f.value = g.f; l.value = g.l; age.value = g.a; sync(); } }, `${g.f} ${g.l}`))), row.el.children[1]);
    }
    basket.push(row); rowsEl.append(row.el); drawCal(); sync();
    f.focus();
  }

  function waitlistBox(d) {
    const em = h('input', { type: 'email', id: 'wl-email', autocomplete: 'email', maxlength: 255 });
    const nm = h('input', { id: 'wl-name', autocomplete: 'name', maxlength: 150 });
    const ps = h('select', { id: 'wl-size' }, Array.from({ length: 10 }, (_, i) => h('option', { value: String(i + 1) }, String(i + 1))));
    const msg = h('p', { role: 'status', class: 'small' });
    const go = h('button', { class: 'btn', type: 'button' }, T('Tell me if tickets open up'));
    go.addEventListener('click', async () => {
      msg.textContent = '';
      try { await call('POST', '/waitlist', { email: em.value.trim(), name: nm.value.trim() || undefined, date: d, party_size: Number(ps.value) }); msg.textContent = T('You are on the list. We will email you once, if tickets open up.'); go.disabled = true; } catch (e) { msg.textContent = e.message; }
    });
    return h('div', { class: 'ticket-row' }, h('h3', null, T('This day is sold out')), h('div', { class: 'cols' }, lab('wl-email', T('Email'), em), lab('wl-name', T('Name'), nm), lab('wl-size', T('How many tickets?'), ps)), h('div', { class: 'row' }, go), msg);
  }

  const ready = (r) => r.f.value.trim() && r.l.value.trim() && (r.pass ? r.dob.value && r.shot.data : r.age.value);
  let timer = 0; let seq = 0; let last = null;

  // ---- extras: add-ons, gift cards, promo code
  const qtys = new Map((page.addons || []).map((a) => [a.id, 0]));
  const gifts = [];
  const promo = h('input', { id: 'promo', autocomplete: 'off', maxlength: 40, placeholder: T('Promo code') });
  promo.addEventListener('input', sync);
  const giftList = h('div', { class: 'saved-row', 'aria-live': 'polite' });
  const drawGifts = () => {
    clear(giftList).append(...gifts.map((g, i) => h('span', { class: 'chip on' }, `${T('Gift card')} ${money(g.amount_cents)}${g.recipient_name ? ` · ${g.recipient_name}` : ''} `, h('button', { type: 'button', class: 'btn link', 'aria-label': `${T('Remove')} ${T('Gift card')}`, onclick: () => { gifts.splice(i, 1); drawGifts(); sync(); } }, '×'))));
  };
  const addonsEl = (page.addons || []).length ? h('section', { class: 'card stack' }, h('h2', null, T('Add-ons')),
    h('p', { class: 'muted' }, T('Lessons and rentals you pay for now and use at the mountain. You get a barcode for each.')),
    page.addons.map((a) => {
      const sel = h('select', { id: `ad${a.id}`, 'aria-label': `${a.name}: ${T('quantity')}` }, Array.from({ length: 11 }, (_, n) => h('option', { value: String(n) }, String(n))));
      sel.addEventListener('change', () => { qtys.set(a.id, Number(sel.value)); sync(); });
      return h('div', { class: 'ticket-row' }, h('div', { class: 'row-head' }, h('div', null, h('h3', null, a.name), h('span', { class: 'muted' }, money(a.price_cents))), sel));
    })) : null;
  const gAmt = h('select', { id: 'g-amt', 'aria-label': T('Gift card amount') }, [2500, 5000, 10000, 20000].map((c) => h('option', { value: String(c) }, money(c))));
  const gTo = h('input', { id: 'g-to', maxlength: 150, autocomplete: 'off' });
  const gMsg = h('input', { id: 'g-msg', maxlength: 300, autocomplete: 'off' });
  const giftEl = h('section', { class: 'card stack' }, h('h2', null, T('Give a gift card')),
    h('p', { class: 'muted' }, T('We email you the code to give. It works at the ticket window and online.')),
    h('div', { class: 'cols' }, lab('g-amt', T('Amount'), gAmt), lab('g-to', T('Who is it for? (optional)'), gTo), lab('g-msg', T('A short message (optional)'), gMsg)),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => {
      if (gifts.length >= 5) return showErr('You can add up to 5 gift cards.');
      gifts.push({ amount_cents: Number(gAmt.value), recipient_name: gTo.value.trim() || undefined, message: gMsg.value.trim() || undefined });
      gTo.value = ''; gMsg.value = ''; drawGifts(); sync();
    } }, T('Add gift card'))), giftList);
  const promoEl = h('div', { class: 'stack' }, lab('promo', T('Promo code'), promo));
  const addonsOf = () => [...qtys].filter(([, n]) => n > 0).map(([product_id, quantity]) => ({ product_id, quantity }));
  const anything = () => basket.length > 0 || addonsOf().length > 0 || gifts.length > 0;

  function sync() {
    clearTimeout(timer); showErr('');
    pay.disabled = true;
    hint.hidden = basket.length > 0;
    if (!anything()) { clear(totalEl); pay.textContent = T('Add a ticket to start'); return; }
    pay.textContent = T('Fill in every ticket to pay');
    showEstimate();
    timer = setTimeout(quote, 350);
  }
  const itemsOf = (withPhoto = false) => basket.map((r) => ({ product_id: r.product.id, valid_on: r.date, holder: { first_name: r.f.value.trim(), last_name: r.l.value.trim(), ...(r.pass ? { date_of_birth: r.dob.value, ...(withPhoto ? { photo: r.shot.data } : {}) } : { age_group: r.age.value }) } }));
  const basketOf = (withPhoto = false) => ({ items: itemsOf(withPhoto), addons: addonsOf(), gifts, ...(promo.value.trim() ? { promo_code: promo.value.trim() } : {}) });
  // A running estimate from the listed prices, shown straight away; the exact total (tax, discounts) follows once every
  // ticket is filled in.
  function showEstimate() {
    const priceOf = (r) => {
      const prices = r.product.prices || [];
      const tier = r.pass ? null : r.age.value;
      const hit = tier && prices.find((x) => x.tier === tier);
      if (hit) return hit.price_cents;
      return prices.length ? Math.min(...prices.map((x) => x.price_cents)) : 0;
    };
    const tickets = basket.reduce((n, r) => n + priceOf(r), 0);
    const extras = [...qtys].reduce((n, [id, q]) => n + q * ((page.addons || []).find((a) => a.id === id) || { price_cents: 0 }).price_cents, 0) + gifts.reduce((n, g) => n + g.amount_cents, 0);
    const count = basket.length + [...qtys.values()].reduce((n, q) => n + q, 0) + gifts.length;
    clear(totalEl).append(h('span', { class: 'muted' }, `${count} ${count === 1 ? T('item') : T('items')}`), h('span', { class: 'grand' }, `${T('About')} ${money(tickets + extras)}`), h('span', { class: 'muted small' }, T('The exact total, with tax, shows when every ticket is filled in.')));
  }
  async function quote() {
    for (const r of basket) { r.badEl.textContent = ''; r.priceEl.textContent = ''; }
    if (!basket.every(ready)) { showEstimate(); return; }
    const mine = ++seq;
    try {
      const q = await call('POST', '/quote', basketOf());
      if (mine !== seq) return;
      last = q;
      q.lines.forEach((ln, i) => { basket[i].priceEl.textContent = `${TIER[ln.tier] || ''} ${money(ln.unit_cents)}`; });
      const saved = q.lines.reduce((n, l) => n + (l.saved_cents || 0), 0);
      appendAll(clear(totalEl), ...[saved ? h('span', { class: 'save-note' }, `You save ${money(saved)} by buying online`) : null, h('span', { class: 'muted' }, `Subtotal ${money(q.subtotal_cents)}`),
        q.discount_cents ? h('span', { class: 'save-note' }, `${q.promo}: -${money(q.discount_cents)}`) : null,
        q.tax_cents ? h('span', { class: 'muted' }, `Tax ${money(q.tax_cents)}`) : null, h('span', { class: 'grand' }, `Total ${money(q.total_cents)}`)]);
      pay.disabled = !page.open; pay.textContent = page.open ? `${LANG === 'es' ? 'Pagar' : 'Pay'} ${money(q.total_cents)}` : T('Online sales are closed');
    } catch (e) { if (mine === seq) { showErr(e.message); clear(totalEl); } }
  }

  // ---- buyer details
  const bf = h('input', { id: 'c-first', autocomplete: 'given-name', maxlength: 60, required: true });
  const bl = h('input', { id: 'c-last', autocomplete: 'family-name', maxlength: 60, required: true });
  const be = h('input', { id: 'c-email', type: 'email', autocomplete: 'email', maxlength: 255, required: true });
  const bp = h('input', { id: 'c-phone', type: 'tel', autocomplete: 'tel', maxlength: 40, required: true });
  const waiver = h('input', { type: 'checkbox', id: 'c-waiver' });
  const terms = h('input', { type: 'checkbox', id: 'c-terms' });
  const news = h('input', { type: 'checkbox', id: 'c-news' });
  const hp = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
  const hint = h('p', { class: 'muted' }, 'Add a ticket above, then enter the name and age group of the person who will use it.');

  const form = h('form', { class: 'shop-grid', novalidate: true }, h('div', { class: 'stack shop-main' },
    h('section', { class: 'card stack' }, h('h2', null, T('1. Pick a day')), calEl),
    h('section', { class: 'card stack' }, svcHead, h('p', { id: 'pick-hint', class: 'muted' }, T('Pick a day above to see what is on sale and the price for each age.')), svcEl),
    h('section', { class: 'card stack' }, h('h2', null, T('3. Who is each ticket for?')), rowsEl, hint),
    addonsEl,
    h('section', { class: 'card stack' }, h('h2', null, T('4. Your details')),
      h('div', { class: 'ticket-row' }, h('div', { class: 'cols' }, lab('c-first', T('First name'), bf), lab('c-last', T('Last name'), bl), lab('c-email', T('Email (we send the tickets here)'), be), lab('c-phone', T('Mobile phone'), bp))),
      page.waiver_text ? [h('h3', null, T('Waiver')), h('div', { class: 'waiver-box', tabindex: '0' }, page.waiver_text), h('label', { class: 'check-row', for: 'c-waiver' }, waiver, h('span', null, T('I have read the waiver. I accept it for myself and for any child under 18 in this order. Other adults in the order will sign at the mountain.')))] : null,
      h('label', { class: 'check-row', for: 'c-terms' }, terms, h('span', null, T('I understand tickets bought online are not refundable. If the mountain closes, I can call for help.'))),
      h('label', { class: 'check-row', for: 'c-news' }, news, h('span', null, `Email me news from ${page.mountain} (optional)`)),
      h('div', { class: 'hp' }, h('label', null, T('Leave this empty'), hp))),
    giftEl),
    // The order summary: beside the form on a wide screen, stuck to the bottom on a phone.
    h('aside', { class: 'shop-aside' }, h('section', { class: 'card stack paybar' }, h('h2', { class: 'sum-h' }, T('Your order')), totalEl, h('details', { class: 'promo-link' }, h('summary', null, T('Have a promo code?')), promoEl), err, h('div', { class: 'row' }, pay))));

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('');
    if (!anything() || !basket.every(ready)) return showErr(T('Fill in the name and age group for every ticket.'));
    if (![bf, bl, be, bp].every((x) => x.value.trim())) return showErr(T('Fill in your name, email and phone.'));
    if (page.waiver_text && !waiver.checked) return showErr(T('Please read and accept the waiver.'));
    if (!terms.checked) return showErr(T('Please confirm you understand tickets are not refundable online.'));
    pay.disabled = true; pay.textContent = T('Taking you to the card page…');
    try {
      saveGuests();
      const out = await call('POST', '/orders', { contact_first_name: bf.value.trim(), contact_last_name: bl.value.trim(), contact_email: be.value.trim(), contact_phone: bp.value.trim(), ...basketOf(true), waiver_accepted: waiver.checked, terms_accepted: terms.checked, news_opt_in: news.checked, website: hp.value });
      if (out.checkout_url) location.href = out.checkout_url; else showErr(T('Something went wrong. Please try again.'));
    } catch (ex) { showErr(ex.message); pay.disabled = false; pay.textContent = last ? `${LANG === 'es' ? 'Pagar' : 'Pay'} ${money(last.total_cents)}` : 'Pay'; }
  });

  try { const me = JSON.parse(localStorage.getItem(`${GKEY}-me`) || 'null'); if (me) { bf.value = me.f || ''; bl.value = me.l || ''; be.value = me.e || ''; bp.value = me.p || ''; } } catch (_) { /* ignore */ }
  drawCal();
  // The first open day is picked for them, so the services are showing straight away.
  const firstOpen = (() => { for (let i = 0; i <= 365; i++) { const d = addDay(today, i); if (!closed(d)) return d; } return null; })();
  if (firstOpen) { shown = firstOpen.slice(0, 7); }

  // Back from the card page without paying: let the basket go straight away (it held tickets and any promo use).
  const back = qs.get('cancelled');
  if (back && /^[0-9a-f]{32}$/.test(back)) call('POST', `/orders/${back}/abandon`).catch(() => {});
  root.append(hero(page, '', page.open ? T('Pick a day, choose your tickets, see the exact total, and pay by card. Your tickets arrive by email and on screen.') : T('Online sales are not open right now.')),
    shell(qs.get('cancelled') ? h('div', { class: 'card' }, h('strong', null, 'Payment canceled. '), 'Nothing was charged. You can start again below.') : null,
      page.open ? form : h('section', { class: 'card stack' }, h('h2', null, T('Online sales are closed')), h('p', { class: 'muted' }, `Please buy at the ticket window${page.phone ? ` or call ${page.phone}` : ''}.`))),
    ...(page.open ? [shell(groupBox())] : []),
    h('p', { class: 'footer' }, T('Payments are handled by Stripe. We never see or store your card number.')));
  if (firstOpen) { drawCal(); await pickDay(firstOpen); }
}

(async () => {
  document.getElementById('shop-loading')?.remove();
  const token = qs.get('order');
  if (token) await showOrder(token); else await showShop();
})();

mountGuestAssistant('shop');
