// The guest rental form (/rental-form/<mountain>). Each renter's height, weight, boot size and how they ski, signed as
// true by the renter (or a parent or guardian for anyone under 18). The shop picks it up at the counter and sets
// bindings from it. ?t=<token> is the link on an order's email and receipt; ?g=<token> a group leader's link; with
// neither it is the walk-in form from the poster in the shop. The page never shows anyone's details back.

import './stage.js'; // the staging band (shows only on staging)
import { h, clear } from './ui.js';
import { signaturePad } from './sigpad.js';

const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const params = new URLSearchParams(location.search);
const orderToken = params.get('t') || '';
const groupToken = params.get('g') || '';
const root = document.getElementById('book');
const base = `/api/v1/public/${encodeURIComponent(slug)}`;
const query = orderToken ? `?t=${encodeURIComponent(orderToken)}` : groupToken ? `?g=${encodeURIComponent(groupToken)}` : '';

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    throw new Error('We could not reach the mountain. Check your connection and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Please try again, or fill in a form at the rental shop.'); e.status = res.status; throw e; }
  return data;
}

let seq = 0;
const uid = () => `rf${(seq += 1)}`;
const field = (text, el, hint) => { el.id = el.id || uid(); const hid = hint ? `${el.id}-hint` : null; if (hid) el.setAttribute('aria-describedby', hid); return h('div', { class: 'field' }, h('label', { for: el.id }, text), el, hint ? h('span', { class: 'hint', id: hid }, hint) : null); };
const input = (attrs) => h('input', { ...attrs });
const dateOf = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)));
const dayLong = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(dateOf(s));
const ageOn = (dob, day) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || '')) return null; let a = +day.slice(0, 4) - +dob.slice(0, 4); if (day.slice(5) < dob.slice(5)) a -= 1; return a; };

const ABILITY = [
  ['cautious', 'Cautious', 'I like slower speeds and easy, wide runs. New skiers and riders pick this.'],
  ['moderate', 'Moderate', 'I ski or ride at different speeds on most runs.'],
  ['aggressive', 'Aggressive', 'I go fast on steep runs and prefer them.'],
];

function hero(page, title, sub) {
  const b = page && page.brand;
  if (b && b.color) document.documentElement.style.setProperty('--blue', b.color);
  const tel = page && page.phone ? `tel:${page.phone.replace(/[^\d+]/g, '')}` : null;
  return h('header', { class: 'hero no-print' }, h('div', { class: 'hero-in' },
    b && b.logo ? h('img', { class: 'logo', src: b.logo, alt: `${page.mountain} logo` }) : null,
    h('div', { class: 'eyebrow' }, page ? page.mountain : 'Rental form'), h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null,
    tel ? h('div', { class: 'chips-row' }, h('a', { class: 'call', href: tel }, `Call ${page.phone}`)) : null));
}

function failPage(message, page) {
  clear(root).append(hero(page, 'Rental form', null), h('main', { class: 'waiver-layout', id: 'form-main' }, h('div', { class: 'card error-box', role: 'alert' }, message)));
}

/** One renter: their details, then the signature that says the details are true. */
function personCard(page, n, onRemove, dayNow) {
  const p = {};
  p.first = input({ autocomplete: 'off', maxlength: 100, required: true });
  p.last = input({ autocomplete: 'off', maxlength: 100, required: true });
  p.dob = input({ type: 'date', autocomplete: 'off', max: page.today, required: true });
  p.ft = input({ type: 'number', inputmode: 'numeric', min: '2', max: '7', 'aria-label': 'Height, feet', class: 'short', placeholder: 'ft' });
  p.inch = input({ type: 'number', inputmode: 'numeric', min: '0', max: '11', 'aria-label': 'Height, inches', class: 'short', placeholder: 'in' });
  p.weight = input({ type: 'number', inputmode: 'numeric', min: '20', max: '450', placeholder: 'lb' });
  p.boot = input({ maxlength: 10, inputmode: 'decimal', placeholder: 'e.g. 27.5 or 9' });
  p.shoe = input({ maxlength: 20, placeholder: "e.g. men's 10" });
  p.helmet = h('input', { type: 'checkbox' });
  p.agree = h('input', { type: 'checkbox' });
  p.signer = input({ autocomplete: 'off', maxlength: 120 });
  p.relation = h('select', null, h('option', { value: 'parent' }, 'Parent'), h('option', { value: 'guardian' }, 'Guardian'));
  p.pad = signaturePad();
  const group = `kind${uid()}`; const abil = `abil${uid()}`; const st = `stance${uid()}`;
  const radio = (name, value, text, extra, checked) => { const r = h('input', { type: 'radio', name, value, checked: Boolean(checked) }); return { r, el: h('label', { class: 'choice' }, r, h('span', null, h('strong', null, text), extra ? h('small', null, extra) : null)) }; };
  p.kinds = [radio(group, 'ski', 'Skis', null, true), radio(group, 'snowboard', 'Snowboard')];
  p.abilities = ABILITY.map(([v, t, d]) => radio(abil, v, t, d));
  p.stances = [radio(st, 'regular', 'Regular', 'Left foot forward'), radio(st, 'goofy', 'Goofy', 'Right foot forward'), radio(st, '', 'Not sure', 'The shop will check', true)];
  const stanceBox = h('fieldset', { class: 'choices', hidden: true }, h('legend', null, 'Snowboard stance'), h('div', { class: 'choice-row' }, ...p.stances.map((x) => x.el)));
  const signHead = h('p', { class: 'sign-for' });
  const relBox = h('div', { hidden: true }, field('Signing as', p.relation));
  const kidNote = h('p', { class: 'hint' });
  function sync() {
    const age = ageOn(p.dob.value, dayNow());
    const minor = age !== null && age < page.adult_age;
    const name = `${p.first.value.trim()} ${p.last.value.trim()}`.trim();
    relBox.hidden = !minor;
    signHead.textContent = minor ? `${name || 'This child'} is under ${page.adult_age}. A parent or guardian signs.` : `${name || 'This person'} signs for themselves.`;
    if (!minor && !p.signerTouched) p.signer.value = name;
    if (minor && p.signer.value === name) p.signer.value = '';
    kidNote.textContent = age !== null && age >= 0 ? `Age on the rental day: ${age}` : '';
    stanceBox.hidden = !p.kinds[1].r.checked;
  }
  p.signer.addEventListener('input', () => { p.signerTouched = true; });
  for (const el of [p.first, p.last, p.dob]) el.addEventListener('input', sync);
  for (const k of p.kinds) k.r.addEventListener('change', sync);
  p.heading = h('h2', null, `Person ${n}`);
  p.el = h('section', { class: 'card stack person' },
    h('div', { class: 'kid-head' }, p.heading, onRemove ? h('button', { type: 'button', class: 'btn link', onclick: () => onRemove(p) }, 'Remove') : null),
    h('div', { class: 'row2' }, field('First name', p.first), field('Last name', p.last)),
    h('div', { class: 'row2' }, h('div', { class: 'stack tight' }, field('Date of birth', p.dob), kidNote),
      h('fieldset', { class: 'choices' }, h('legend', null, 'Skis or snowboard'), h('div', { class: 'choice-row' }, ...p.kinds.map((x) => x.el)))),
    h('div', { class: 'row3' },
      h('div', { class: 'field' }, h('span', { class: 'legend', id: `${p.ft.id || (p.ft.id = uid())}-l` }, 'Height'), h('div', { class: 'pair', role: 'group', 'aria-labelledby': `${p.ft.id}-l` }, p.ft, h('span', { 'aria-hidden': 'true' }, 'ft'), p.inch, h('span', { 'aria-hidden': 'true' }, 'in'))),
      field('Weight (pounds)', p.weight),
      field('Boot size', p.boot, 'Mondo or US size. Leave empty if you do not know.')),
    field('Or shoe size', p.shoe, 'If you do not know your boot size'),
    stanceBox,
    h('fieldset', { class: 'choices' }, h('legend', null, 'How do you ski or ride?'), h('p', { class: 'hint' }, 'Be honest: it sets how easily the bindings let go in a fall.'),
      h('div', { class: 'choice-col' }, ...p.abilities.map((x) => x.el))),
    h('label', { class: 'check' }, p.helmet, h('span', null, 'Rent a helmet too')),
    h('div', { class: 'stack sign-box' }, h('h3', null, 'Sign that these details are true'), signHead, relBox,
      field('Name of the person signing', p.signer),
      h('label', { class: 'check' }, p.agree, h('span', null, 'These details are true. I understand the shop sets the bindings from them, and a wrong height, weight or ability can make a binding release too early or too late.')),
      h('div', { class: 'sigwrap' }, h('div', { class: 'sigline' }, h('strong', null, 'Sign in the box with your finger or mouse'), h('button', { type: 'button', class: 'btn link', onclick: () => p.pad.clear() }, 'Clear')), p.pad.el)));
  p.sync = sync;
  p.value = () => {
    const ft = Number(p.ft.value || 0); const inch = Number(p.inch.value || 0);
    const minor = (ageOn(p.dob.value, dayNow()) ?? 99) < page.adult_age;
    return {
      first_name: p.first.value.trim(), last_name: p.last.value.trim(), date_of_birth: p.dob.value,
      discipline: p.kinds[1].r.checked ? 'snowboard' : 'ski', height_in: ft || inch ? ft * 12 + inch : null, weight_lb: p.weight.value ? Number(p.weight.value) : null,
      boot_size: p.boot.value.trim() || null, shoe_size: p.shoe.value.trim() || null,
      stance: p.kinds[1].r.checked ? ((p.stances.find((x) => x.r.checked) || {}).r || {}).value || null : null,
      ability: ((p.abilities.find((x) => x.r.checked) || {}).r || {}).value || '', helmet: p.helmet.checked,
      signer_name: p.signer.value.trim(), signer_relation: minor ? p.relation.value : 'self', agree: p.agree.checked, signature: p.pad.toDataUrl(),
    };
  };
  sync();
  return p;
}

async function showForm() {
  let page;
  try { page = await call('GET', `/rental-form${query}`); } catch (err) {
    failPage(err.status === 404 && !query ? 'We could not find this mountain. Check the link.' : err.message);
    return;
  }
  document.title = `${page.mountain} rental form`;
  const fixedDay = page.order ? page.order.day : page.group ? page.group.day : null;
  const day = input({ type: 'date', min: page.today, max: page.last_day, value: page.today, required: true });
  const dayNow = () => fixedDay || day.value || page.today;
  const contact = input({ autocomplete: 'name', maxlength: 120, required: true });
  const phone = input({ type: 'tel', autocomplete: 'tel', maxlength: 30 });
  const email = input({ type: 'email', autocomplete: 'email', maxlength: 255 });
  const trap = input({ name: 'website', tabindex: '-1', autocomplete: 'off' });
  const people = [];
  const list = h('div', { class: 'stack' });
  const addBtn = h('button', { type: 'button', class: 'btn' }, 'Add another person');
  const err = h('div', { role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn primary big' }, 'Send to the rental shop');

  const renumber = () => { people.forEach((p, i) => { p.heading.textContent = `Person ${i + 1}`; }); addBtn.hidden = people.length >= page.max_people; };
  function add(focus = true) {
    const p = personCard(page, people.length + 1, people.length ? (x) => { people.splice(people.indexOf(x), 1); x.el.remove(); renumber(); } : null, dayNow);
    people.push(p); list.append(p.el); renumber();
    if (focus) p.first.focus();
  }
  addBtn.addEventListener('click', () => add(true));
  day.addEventListener('change', () => people.forEach((p) => p.sync()));
  const start = page.order ? Math.min(Math.max(page.order.renters, 1), page.max_people) : 1;
  for (let i = 0; i < start; i++) add(false);

  const intro = page.order
    ? `For your rental on ${dayLong(page.order.day)}. Your order has ${page.order.renters} rental${page.order.renters === 1 ? '' : 's'}: fill in one person for each.`
    : page.group ? `For ${page.group.name} on ${dayLong(page.group.day)}. Fill in one person for each child, then sign for each.`
      : 'Fill this in while you wait. The shop finds it by your name or phone and fits you faster.';
  const form = h('form', { class: 'waiver-layout', id: 'form-main', novalidate: true },
    h('p', { class: 'muted' }, intro),
    page.order && page.order.sent ? h('div', { class: 'card note-box' }, 'We already have a form for this order. Sending it again replaces it.') : null,
    h('section', { class: 'card stack' }, h('h2', null, page.group ? 'Parent or guardian' : 'Your details'),
      fixedDay ? null : field('Rental day', day),
      h('div', { class: 'row2' }, field('Your name', contact), field(page.order ? 'Mobile phone (optional)' : 'Mobile phone', phone, 'The shop looks your form up by phone number')),
      field('Email (optional)', email),
      h('div', { class: 'help-trap', 'aria-hidden': 'true' }, h('label', null, 'Leave this empty', trap))),
    list,
    h('div', null, addBtn),
    page.waiver_link ? h('p', { class: 'card small' }, 'Everyone wearing rental gear also needs a signed waiver for the season. ', h('a', { href: page.waiver_link }, 'Sign the waiver'), ' if you have not yet.') : null,
    err, submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clear(err);
    const show = (msg, el) => { err.append(h('div', { class: 'error-box' }, msg)); if (el) el.scrollIntoView({ block: 'center' }); };
    if (!contact.value.trim()) { show('Enter your name.', contact); contact.focus(); return; }
    if (!page.order && !phone.value.trim()) { show('Enter a mobile phone number so the shop can find your form.', phone); phone.focus(); return; }
    let body;
    try {
      body = people.map((p, i) => {
        const v = p.value();
        const who = `${v.first_name} ${v.last_name}`.trim() || `person ${i + 1}`;
        const stop = (m, el) => { const x = new Error(m); x.el = el; throw x; };
        if (!v.first_name || !v.last_name) stop(`Enter a first and last name for person ${i + 1}.`, p.first);
        if (!v.date_of_birth) stop(`Enter the date of birth for ${who}.`, p.dob);
        if (!v.height_in) stop(`Enter the height for ${who}.`, p.ft);
        if (!v.weight_lb) stop(`Enter the weight for ${who}.`, p.weight);
        if (!v.boot_size && !v.shoe_size) stop(`Enter a boot size or a shoe size for ${who}.`, p.boot);
        if (!v.ability) stop(`Say how ${who} skis or rides.`, p.abilities[0].r);
        if (!v.signer_name) stop(`Type the name of the person signing for ${who}.`, p.signer);
        if (!v.agree) stop(`Tick the box to say the details for ${who} are true.`, p.agree);
        if (!v.signature) stop(`Please sign for ${who}.`, p.pad.el);
        return v;
      });
    } catch (ex) { show(ex.message, ex.el); if (ex.el && ex.el.focus) ex.el.focus(); return; }
    submit.disabled = true; submit.textContent = 'Sending…';
    try {
      const out = await call('POST', '/rental-form', { t: orderToken || undefined, g: groupToken || undefined, contact_name: contact.value.trim(), phone: phone.value.trim(), email: email.value.trim(), rental_on: fixedDay ? undefined : day.value, website: trap.value, people: body });
      done(page, out, contact.value.trim().split(' ')[0]);
    } catch (ex) { show(ex.message); } finally { submit.disabled = false; submit.textContent = 'Send to the rental shop'; }
  });

  clear(root).append(hero(page, 'Rental form', 'Sizes and ability for each renter, signed. Takes about two minutes a person.'), form);
}

function done(page, out, firstName) {
  const card = h('section', { class: 'card done success stack', role: 'status', tabindex: '-1' },
    h('h2', null, `Sent. Thank you, ${firstName}.`),
    h('p', null, `The rental shop has your form for ${out.people} ${out.people === 1 ? 'person' : 'people'}, for ${dayLong(out.day)}.`),
    h('p', null, out.for === 'order' ? 'At the rental shop, show your receipt or give your name.' : out.for === 'group' ? 'Your group leader picks up the gear with the group.' : 'At the rental shop, give your name or phone number.'),
    page.waiver_link ? h('p', { class: 'muted' }, 'Everyone wearing rental gear needs a signed waiver too. ', h('a', { href: page.waiver_link }, 'Sign the waiver')) : null,
    h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Fill in another form'));
  clear(root).append(hero(page, 'All set', null), h('main', { class: 'waiver-layout', id: 'form-main' }, card));
  card.focus();
}

if (!slug) failPage('This link is missing the mountain. Check the address.');
else showForm();
