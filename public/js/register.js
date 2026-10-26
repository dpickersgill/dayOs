// Program registration (/programs/<mountain>). A parent picks the program, the session (or a bundle of sessions) and the
// weekday, adds each child, accepts the waiver and pays on Stripe's page. The page shows every lesson date and the makeup
// date held in reserve. A full day offers its waitlist instead. Prices come from the server; this page only shows them.
import './stage.js';
import { mountGuestAssistant } from './guest-assistant.js';
import { h, clear } from './ui.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const root = document.getElementById('reg');
const base = `/api/v1/public/${encodeURIComponent(slug)}/programs`;
const qs = new URLSearchParams(location.search);

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again or call the mountain.');
  return data;
}
const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(`${s}T12:00:00Z`);
const short = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(dateOf(s));
const long = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const t12 = (t) => { const [hh, mm] = t.split(':').map(Number); return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')}${hh < 12 ? ' am' : ' pm'}`; };
const lab = (id, text, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, text), el, hint ? h('span', { class: 'hint' }, hint) : null);
const shell = (...kids) => h('div', { class: 'layout' }, h('main', { class: 'main stack', id: 'reg-main' }, ...kids));
const hero = (page, sub) => h('header', { class: 'hero' }, h('div', { class: 'hero-in' }, h('span', { class: 'eyebrow' }, 'Programs and lessons'), h('h1', null, page.mountain), h('p', { class: 'sub' }, sub),
  page.phone ? h('div', { class: 'chips-row' }, h('span', { class: 'trust' }, 'Secure card payment'), h('a', { class: 'call', href: `tel:${page.phone.replace(/[^\d+]/g, '')}` }, `Call ${page.phone}`)) : null));

async function main() {
  if (qs.get('registration')) return showRegistration(qs.get('registration'));
  let page;
  try { page = await call('GET', ''); } catch (_) {
    clear(root).append(shell(h('section', { class: 'card stack' }, h('h1', null, 'Registration is not available'), h('p', { class: 'muted' }, 'Please call the mountain.')))); return;
  }
  document.title = `${page.mountain}: register for a program`;
  if (!page.programs.length) {
    clear(root).append(hero(page, 'Register for lessons and programs'), shell(h('section', { class: 'card stack' }, h('h2', null, 'Nothing is open for registration right now'), h('p', { class: 'muted' }, 'Check back soon, or call us.'))));
    return;
  }
  const want = Number(qs.get('program'));
  let program = page.programs.find((p) => p.id === want) || (page.programs.length === 1 ? page.programs[0] : null);
  const body = h('div', { class: 'stack' });
  clear(root).append(hero(page, 'Choose a session and the day that suits you, add each child, and pay securely online.'), shell(
    qs.get('cancelled') ? h('p', { class: 'error-box', role: 'status' }, 'Payment was not finished, so nothing was booked. You can try again below.') : null,
    page.programs.length > 1 ? h('section', { class: 'card stack' }, h('h2', null, 'Choose a program'), ...[...new Set(page.programs.map((p) => p.type || ''))].map((type) => h('div', { class: 'stack tight' },
      type ? h('h3', { class: 'reg-type' }, type) : null,
      h('div', { class: 'reg-sessions' }, page.programs.filter((p) => (p.type || '') === type).map((p) => {
        const b = h('button', { type: 'button', class: 'pill prog-pill', 'aria-pressed': String(program === p) }, p.name);
        b.addEventListener('click', () => { program = p; main.draw(); for (const x of document.querySelectorAll('.prog-pill')) x.setAttribute('aria-pressed', String(x === b)); });
        return b;
      }))))) : null,
    body));
  main.draw = () => { clear(body); if (program) body.append(programForm(page, program)); };
  main.draw();
}

/** The form for one program: what it is, the session or bundle, each child with their day, the parent, the waiver, pay. */
function programForm(page, p) {
  let choice = p.terms[0] ? { term: p.terms[0] } : { bundle: p.bundles[0] };
  const kids = [];
  const sessEl = h('div', { class: 'reg-sessions', role: 'group', 'aria-label': 'Session' });
  const daysEl = h('div', { class: 'stack' });
  const kidsEl = h('div', { class: 'stack' });
  const linesEl = h('div', { class: 'reg-lines', 'aria-live': 'polite' });
  const err = h('div', { role: 'alert', class: 'error-box', hidden: true });
  const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };
  const pay = h('button', { class: 'btn primary big', type: 'submit' }, 'Continue to payment');
  const terms = new Map(p.terms.map((t) => [t.id, t]));

  // ---- sessions and bundles
  const opts = [...p.terms.map((t) => ({ term: t, text: `${t.name}: ${short(t.starts_on)}` })), ...p.bundles.map((b) => ({ bundle: b, text: `${b.name}, ${money(b.price_cents)}` }))];
  for (const o of opts) {
    const btn = h('button', { type: 'button', class: 'pill', 'aria-pressed': String((o.term && choice.term === o.term) || (o.bundle && choice.bundle === o.bundle)) }, o.text);
    btn.addEventListener('click', () => { choice = o.term ? { term: o.term } : { bundle: o.bundle }; for (const x of sessEl.children) x.setAttribute('aria-pressed', String(x === btn)); for (const k of kids) k.days = {}; drawDays(); drawKids(); requote(); });
    sessEl.append(btn);
  }
  const termsNow = () => (choice.term ? [choice.term] : choice.bundle.term_ids.map((id) => terms.get(id)));

  // ---- a card per weekday, with its dates
  function dayCard(t, g, picked, onPick) {
    const full = g.left === 0;
    const el = h('button', { type: 'button', class: `reg-day${full ? ' full' : ''}`, 'aria-pressed': String(picked) },
      h('span', { class: 'd' }, `${g.day}s`), h('span', { class: 't' }, `${t12(g.start_time)} to ${t12(g.end_time)}`),
      g.discipline && g.discipline !== 'any' ? h('span', { class: 'disc' }, g.discipline === 'ski' ? 'Ski only' : 'Snowboard only') : null,
      h('span', { class: 'dates', 'aria-label': `Lessons ${g.dates.map(long).join(', ')}` }, g.dates.map((d) => h('span', null, short(d))), g.makeup_dates.map((d) => h('span', { class: 'mk', title: 'Makeup date, used only if a lesson is canceled' }, short(d)))),
      choice.term ? h('span', { class: 'p' }, `Lessons ${money(g.price_now.cents)}`, g.price_now.label ? ` ${g.price_now.label.toLowerCase()} until ${short(g.price_now.until)}` : '') : null,
      h('span', { class: 'left' }, full ? 'Full: join the waitlist' : g.left != null && g.left <= 5 ? `${g.left} place${g.left === 1 ? '' : 's'} left` : 'Places available'));
    el.addEventListener('click', () => onPick(g));
    return el;
  }
  function drawDays() {
    clear(daysEl);
    for (const t of termsNow()) {
      daysEl.append(h('div', { class: 'stack' }, h('h3', null, choice.bundle ? t.name : 'Which day?'),
        h('p', { class: 'muted small' }, `${t.weeks} weekly lessons${t.makeup_weeks ? `, and a makeup date (dashed) held in case one is canceled for weather` : ''}.`),
        h('div', { class: 'reg-days' }, t.groups.map((g) => dayCard(t, g, false, () => {
          if (g.left === 0) { waitlist(page, p, t, g); return; }
          // Picking a day here sets it for every child who has not chosen yet.
          if (!kids.length) addKid();
          for (const k of kids) if (!k.days[t.id]) k.days[t.id] = g.id;
          drawKids(); requote();
          kids.at(-1).first.focus();
        })))));
    }
  }

  // ---- children
  function addKid() {
    const n = kids.length;
    const k = { days: {} };
    k.first = h('input', { id: `kf${n}`, autocomplete: 'off', maxlength: 60, required: true });
    k.last = h('input', { id: `kl${n}`, autocomplete: 'off', maxlength: 60, required: true });
    k.dob = h('input', { id: `kd${n}`, type: 'date', required: true });
    const discs = p.disciplines || ['ski', 'snowboard'];
    k.disc = h('select', { id: `kdi${n}` }, discs.map((d) => h('option', { value: d }, d === 'ski' ? 'Ski' : 'Snowboard')));
    k.pass = h('select', { id: `kp${n}` }, h('option', { value: 'no' }, 'No'), h('option', { value: 'yes' }, 'Yes'));
    k.rental = h('select', { id: `kr${n}` }, h('option', { value: 'no' }, 'No, own gear'), h('option', { value: 'yes' }, 'Yes'));
    k.helmet = h('select', { id: `kh${n}` }, h('option', { value: 'no' }, 'No, own helmet'), h('option', { value: 'yes' }, 'Yes'));
    k.height = h('input', { id: `kht${n}`, type: 'number', min: 20, max: 90, inputmode: 'numeric' });
    k.weight = h('input', { id: `kwt${n}`, type: 'number', min: 20, max: 400, inputmode: 'numeric' });
    k.boot = h('input', { id: `kbt${n}`, maxlength: 10 });
    k.allergies = h('input', { id: `kal${n}`, maxlength: 300 });
    k.medical = h('textarea', { id: `kme${n}`, rows: 2, maxlength: 500 });
    k.pick1 = h('input', { id: `kpu${n}`, maxlength: 100 }); k.pick1p = h('input', { id: `kpp${n}`, type: 'tel', maxlength: 40 });
    for (const i of [k.first, k.last, k.dob, k.disc, k.pass, k.rental, k.helmet]) i.addEventListener('change', () => { drawSizes(k); requote(); });
    kids.push(k); drawKids(); requote();
  }
  function drawKids() {
    clear(kidsEl);
    kids.forEach((k, i) => {
      const dayPicks = termsNow().map((t) => {
        const s = h('select', { id: `kday${i}-${t.id}`, required: true }, h('option', { value: '' }, 'Choose a day'), t.groups.map((g) => h('option', { value: g.id, disabled: g.left === 0, selected: k.days[t.id] === g.id }, `${g.day}s${g.left === 0 ? ' (full)' : ''}`)));
        s.addEventListener('change', () => { k.days[t.id] = Number(s.value) || undefined; requote(); });
        return lab(`kday${i}-${t.id}`, choice.bundle ? `${t.name} day` : 'Day', s);
      });
      const rm = kids.length > 1 ? h('button', { type: 'button', class: 'btn link' }, 'Remove') : null;
      if (rm) rm.addEventListener('click', () => { kids.splice(i, 1); drawKids(); requote(); });
      k.sizesEl = k.sizesEl || h('div', { class: 'reg-kid-grid' });
      drawSizes(k);
      const discs = p.disciplines || ['ski', 'snowboard'];
      kidsEl.append(h('div', { class: 'reg-kid' }, h('div', { class: 'spread' }, h('h3', null, `Child ${i + 1}`), rm),
        h('div', { class: 'reg-kid-grid' }, lab(`kf${i}`, 'First name', k.first), lab(`kl${i}`, 'Last name', k.last), lab(`kd${i}`, 'Date of birth', k.dob, p.age_min != null || p.age_max != null ? `For ages ${p.age_min ?? 0} to ${p.age_max ?? 99}` : null),
          discs.length > 1 ? lab(`kdi${i}`, 'Ski or snowboard', k.disc, p.snowboard_age_min ? `Snowboard from age ${p.snowboard_age_min}` : null) : null, ...dayPicks,
          p.includes_ticket ? lab(`kp${i}`, `Season pass at ${page.mountain}?`, k.pass, 'With a pass, there is no lift ticket to pay for') : null,
          p.includes_rental ? lab(`kr${i}`, 'Rental gear?', k.rental) : null,
          p.offers_helmet ? lab(`kh${i}`, 'Rent a helmet?', k.helmet) : null),
        k.sizesEl,
        p.ask_safety ? h('details', { class: 'reg-safety' }, h('summary', null, 'Allergies, medical notes and pickup'),
          h('div', { class: 'reg-kid-grid' }, lab(`kal${i}`, 'Allergies', k.allergies, 'Blank if none'), lab(`kpu${i}`, 'Someone else who may pick up', k.pick1), lab(`kpp${i}`, 'Their phone', k.pick1p)),
          lab(`kme${i}`, 'Medical notes for the instructor', k.medical)) : null));
    });
    const more = h('button', { type: 'button', class: 'btn' }, kids.length ? 'Add another child' : 'Add a child');
    more.addEventListener('click', () => { addKid(); kids.at(-1).first.focus(); });
    kidsEl.append(h('div', null, more, p.sibling ? h('p', { class: 'muted small' }, `Brothers and sisters: ${p.sibling.mode === 'percent' ? `${p.sibling.value}%` : money(p.sibling.value)} off each child after the first.`) : null));
  }

  // Rental sizes only when rental is asked for.
  function drawSizes(k) {
    if (!k.sizesEl) return;
    clear(k.sizesEl);
    if (p.includes_rental && k.rental.value === 'yes') k.sizesEl.append(lab(k.height.id, 'Height (inches)', k.height), lab(k.weight.id, 'Weight (pounds)', k.weight), lab(k.boot.id, 'Shoe or boot size', k.boot));
  }
  const num_ = (el) => (el.value ? Number(el.value) : undefined);
  const regs = () => kids.filter((k) => k.first.value.trim() && k.last.value.trim() && k.dob.value && termsNow().every((t) => k.days[t.id])).map((k) => ({
    program_id: p.id, child: { first_name: k.first.value.trim(), last_name: k.last.value.trim(), date_of_birth: k.dob.value },
    discipline: k.disc.value, ...(p.includes_ticket ? { has_pass: k.pass.value === 'yes' } : {}),
    ...(p.includes_rental ? { needs_rental: k.rental.value === 'yes', ...(k.rental.value === 'yes' ? { sizes: { height_in: num_(k.height), weight_lb: num_(k.weight), boot_size: k.boot.value.trim() || undefined } } : {}) } : {}),
    ...(p.offers_helmet ? { needs_helmet: k.helmet.value === 'yes' } : {}),
    ...(p.ask_safety ? { allergies: k.allergies.value.trim() || undefined, medical: k.medical.value.trim() || undefined, ...(k.pick1.value.trim() ? { pickup: [{ name: k.pick1.value.trim(), phone: k.pick1p.value.trim() || undefined }] } : {}) } : {}),
    ...(choice.term ? { term_id: choice.term.id, group_id: k.days[choice.term.id] } : { bundle_id: choice.bundle.id, groups: termsNow().map((t) => ({ term_id: t.id, group_id: k.days[t.id] })) }),
  }));
  let qn = 0;
  async function requote() {
    const r = regs(); const my = ++qn;
    clear(linesEl); showErr('');
    if (!r.length) { linesEl.append(h('p', { class: 'muted' }, 'Add each child with their name, date of birth and day to see the price.')); return; }
    try {
      const q = await call('POST', '/quote', { registrations: r });
      if (my !== qn) return;
      const partsOf = (l) => [`lessons ${money(l.lesson_cents)}`, l.ticket_cents ? `lift ticket ${money(l.ticket_cents)}` : null, l.rental_cents ? `rental ${money(l.rental_cents)}` : null, l.helmet_cents ? `helmet ${money(l.helmet_cents)}` : null].filter(Boolean).join(' + ');
      const passNote = (l) => (l.pass === 'found' ? h('span', { class: 'ok' }, ' Season pass found: no lift ticket.') : l.pass === 'check' ? h('span', { class: 'note' }, ' We will check the season pass at the first lesson.') : null);
      linesEl.append(...q.lines.map((l) => h('div', { class: 'reg-line' }, h('span', null, h('b', null, l.child), ` ${l.name}, ${l.detail}`, h('br'), h('span', { class: 'muted small' }, partsOf(l)),
        l.sibling_cents ? h('span', { class: 'off' }, ` Sibling ${money(l.sibling_cents)} off.`) : null, l.late ? h('span', { class: 'note' }, ' Started already: priced for the lessons left.') : null, passNote(l)), h('span', null, money(l.unit_cents)))),
        q.tax_cents ? h('div', { class: 'reg-line muted' }, h('span', null, 'Tax'), h('span', null, money(q.tax_cents))) : null,
        h('div', { class: 'reg-line total' }, h('span', null, 'Total'), h('span', null, money(q.total_cents))));
    } catch (e) { if (my === qn) showErr(e.message); }
  }

  // ---- parent and pay
  const cf = h('input', { id: 'cf', autocomplete: 'given-name', required: true, maxlength: 60 });
  const cl = h('input', { id: 'cl', autocomplete: 'family-name', required: true, maxlength: 60 });
  const ce = h('input', { id: 'ce', type: 'email', autocomplete: 'email', required: true, maxlength: 255 });
  const cp = h('input', { id: 'cp', type: 'tel', autocomplete: 'tel', required: true, maxlength: 40 });
  const hp = h('input', { name: 'website', tabindex: '-1', autocomplete: 'off', class: 'reg-hp', 'aria-hidden': 'true' });
  const waiver = h('input', { type: 'checkbox', id: 'wv' });
  const form = h('form', { class: 'stack', novalidate: true },
    h('section', { class: 'card stack' }, h('h2', null, p.name),
      p.description ? h('p', null, p.description) : null,
      h('div', { class: 'reg-includes' }, p.age_min != null || p.age_max != null ? h('span', null, `Ages ${p.age_min ?? 0} to ${p.age_max ?? 99}`) : null, p.includes_ticket ? h('span', null, 'Lift ticket included (not needed with a season pass)') : null, p.includes_rental ? h('span', null, 'Rental gear available') : null, p.offers_helmet ? h('span', null, 'Helmet available') : null),
      opts.length > 1 ? h('div', { class: 'stack' }, h('h3', null, 'Session'), sessEl) : null, daysEl),
    h('section', { class: 'card stack' }, h('h2', null, 'Your children'), kidsEl),
    h('section', { class: 'card stack' }, h('h2', null, 'Parent or guardian'),
      h('div', { class: 'reg-kid-grid' }, lab('cf', 'First name', cf), lab('cl', 'Last name', cl), lab('ce', 'Email', ce, 'Your confirmation and every lesson date go here'), lab('cp', 'Phone', cp, 'For weather cancellations')), hp,
      page.waiver_text ? h('div', { class: 'stack' }, h('div', { class: 'waiver-text', tabindex: '0', 'aria-label': 'Waiver' }, page.waiver_text), h('label', { class: 'check', for: 'wv' }, waiver, h('span', null, 'I have read the waiver and accept it for each child, as their parent or guardian.'))) : null),
    h('section', { class: 'card stack' }, h('h2', null, 'Total'), linesEl,
      p.meeting_place || p.what_to_bring ? h('p', { class: 'muted small' }, p.meeting_place ? `Meet at ${p.meeting_place}. ` : '', p.what_to_bring ? `Bring: ${p.what_to_bring}.` : '') : null,
      p.policy_text || p.cancel_days != null ? h('div', { class: 'reg-policy' }, h('h3', null, 'Good to know'), p.policy_text ? h('p', null, p.policy_text) : null,
        p.cancel_days != null ? h('p', { class: 'small' }, `Cancel from your family page up to ${p.cancel_days} days before the first lesson${p.cancel_fee_cents ? ` (a ${money(p.cancel_fee_cents)} fee applies)` : ''}.`) : null,
        p.allow_switch ? h('p', { class: 'small' }, 'You can switch to another day with room from your family page.') : null) : null,
      err, pay));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); showErr('');
    const r = regs();
    if (!r.length || r.length !== kids.length) { showErr('Add each child\'s name, date of birth and day.'); return; }
    if (![cf, cl, ce, cp].every((i) => i.value.trim())) { showErr('Add your name, email and phone.'); return; }
    if (page.waiver_text && !waiver.checked) { showErr('Please read and accept the waiver.'); return; }
    pay.disabled = true; pay.textContent = 'Opening secure payment…';
    try {
      const out = await call('POST', '/register', { contact_first_name: cf.value.trim(), contact_last_name: cl.value.trim(), contact_email: ce.value.trim(), contact_phone: cp.value.trim(), registrations: r, waiver_accepted: waiver.checked, website: hp.value || undefined });
      if (out.checkout_url) location.href = out.checkout_url;
    } catch (ex) { showErr(ex.message); pay.disabled = false; pay.textContent = 'Continue to payment'; }
  });
  drawDays(); drawKids(); requote();
  return form;
}

/** A full day: the waitlist. No payment now; the mountain is in touch when a place opens. */
function waitlist(page, p, t, g) {
  const box = h('dialog', { class: 'card stack', 'aria-labelledby': 'wl-h' });
  const f = h('input', { id: 'wf', required: true, maxlength: 60 }); const l = h('input', { id: 'wl', required: true, maxlength: 60 }); const d = h('input', { id: 'wd', type: 'date', required: true });
  const cf = h('input', { id: 'wcf', required: true, maxlength: 60, autocomplete: 'given-name' }); const cl = h('input', { id: 'wcl', required: true, maxlength: 60, autocomplete: 'family-name' });
  const ce = h('input', { id: 'wce', type: 'email', required: true, autocomplete: 'email' }); const cp = h('input', { id: 'wcp', type: 'tel', required: true, autocomplete: 'tel' });
  const any = h('input', { type: 'checkbox', id: 'wany' });
  const err = h('p', { class: 'error-box', role: 'alert', hidden: true });
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Join the waitlist');
  const close = h('button', { type: 'button', class: 'btn' }, 'Close');
  const form = h('form', { class: 'stack', method: 'dialog' }, h('h2', { id: 'wl-h' }, `${g.day}s in ${t.name} are full`),
    h('p', null, 'Join the waitlist and we will contact you when a place opens. Nothing to pay now.'),
    h('div', { class: 'reg-kid-grid' }, lab('wf', 'Child\'s first name', f), lab('wl', 'Last name', l), lab('wd', 'Date of birth', d), lab('wcf', 'Your first name', cf), lab('wcl', 'Your last name', cl), lab('wce', 'Email', ce), lab('wcp', 'Phone', cp)),
    h('label', { class: 'check', for: 'wany' }, any, h('span', null, 'Any day works: offer us the first place that opens on any day')), err, h('div', { class: 'row' }, close, go));
  close.addEventListener('click', () => box.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    try {
      await call('POST', '/waitlist', { program_id: p.id, term_id: t.id, group_id: g.id, any_day: any.checked, child: { first_name: f.value.trim(), last_name: l.value.trim(), date_of_birth: d.value }, contact_first_name: cf.value.trim(), contact_last_name: cl.value.trim(), contact_email: ce.value.trim(), contact_phone: cp.value.trim() });
      clear(form).append(h('h2', null, 'You are on the waitlist'), h('p', null, `We will contact you at ${ce.value.trim()} when a place opens.`), close);
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  box.append(form); document.body.append(box); box.showModal();
  box.addEventListener('close', () => box.remove());
}

/** After paying: each child, the session and day, every date, and the lift ticket code. */
async function showRegistration(token) {
  let v;
  try { v = await call('GET', `/registrations/${encodeURIComponent(token)}`); } catch (_) { clear(root).append(shell(h('section', { class: 'card' }, h('h1', null, 'Registration not found')))); return; }
  const waiting = v.status === 'awaiting_payment';
  clear(root).append(hero(v, waiting ? 'We are confirming your payment.' : 'You are registered.'), shell(h('section', { class: 'card stack' },
    h('h2', null, waiting ? 'Confirming your payment…' : v.status === 'paid' ? `Thank you, ${v.contact_name.split(' ')[0]}` : 'This registration was not completed'),
    h('p', { class: 'muted' }, `Reference ${v.reference}`),
    v.note ? h('p', { class: 'error-box' }, v.note) : null,
    v.places.map((pl) => h('div', { class: 'reg-place' }, h('h3', null, `${pl.first_name} ${pl.last_name}`), h('p', null, `${pl.program}, ${pl.term}, ${pl.day}s`),
      h('ol', null, pl.dates.map((d) => h('li', null, `${long(d.date)}, ${t12(d.time)}${d.makeup ? ' (makeup)' : ''}`))),
      pl.makeup_reserve.length ? h('p', { class: 'muted small' }, `Makeup date if a lesson is canceled for weather: ${pl.makeup_reserve.map(long).join(', ')}`) : null,
      pl.ticket_code ? h('p', null, 'Lift ticket: ', h('code', null, pl.ticket_code)) : null)),
    h('p', { class: 'muted small' }, 'A copy is in your email. ', h('a', { href: `/family/${encodeURIComponent(slug)}` }, 'Your family page'), ' shows every date, weather changes and report cards.'))));
  if (waiting) setTimeout(() => showRegistration(token), 3000);
}

main();

mountGuestAssistant('programs');
