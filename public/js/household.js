// The household account (Guests round 2, Track ACCOUNT): shown at the top of the family page (/family/<mountain>) once
// signed in. "Buy for a day" (tap the day, tap who is coming, pay), "Same as last time", passes and tickets with their
// barcodes for the gate, rewards with their choices, the saved family (sizes, levels, birthday, photo), pass renewal with
// last season's photo, receipts and season recaps. Prices and checks always come from the server.
import { h, clear } from './ui.js';
import { code128 } from './barcode.js';
import { shrink } from './photo.js';

const money = (c) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);
const dateOf = (s) => new Date(`${s}T12:00:00Z`);
const fmtDay = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(dateOf(s));
const shortDay = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(dateOf(s));
const addDay = (s, n) => { const d = dateOf(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LEVELS = { first_timer: 'First time', beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** The next few days to pick from: today, tomorrow, the coming Saturday and Sunday. */
function dayChoices(today) {
  const out = [today, addDay(today, 1)];
  for (let i = 2; i < 9 && out.length < 4; i++) { const d = addDay(today, i); const w = dateOf(d).getUTCDay(); if (w === 6 || w === 0) out.push(d); }
  return out;
}

/**
 * Draws the account sections into `into`. call(method, path, body): the family page's call to /public/<slug>/family;
 * acall: the same for /public/<slug> (the account, the shop). Returns nothing; redraws itself after changes.
 */
export async function householdSections(into, { acall, slug, onChange }) {
  let d;
  try { d = await acall('GET', '/account'); } catch (e) { into.append(h('p', { class: 'error-box' }, e.message)); return; }
  const kids = [buyCard(d, acall, slug), ticketsCard(d), rewardsCard(d, slug), renewCard(d, acall, slug), familyCard(d, acall, onChange), receiptsCard(d)].filter(Boolean);
  clear(into).append(...kids);
}

// ---------------------------------------------------------------- buy for a day: the day, who, pay
function buyCard(d, acall, slug) {
  if (!d.shop || !d.members.length) return null;
  const days = dayChoices(d.today);
  let day = days[days.length > 2 ? 2 : 0];
  const picked = new Map(d.members.map((m) => [m.id, { on: true, rental: false, lesson: false }]));
  const msg = h('div', { role: 'status', 'aria-live': 'polite', class: 'stack tight' });
  const pay = h('button', { type: 'button', class: 'btn primary big' }, 'Check the total');
  const terms = h('input', { type: 'checkbox', id: 'hh-terms' });
  const waiver = h('input', { type: 'checkbox', id: 'hh-waiver' });
  const needWaiver = d.waiver_link && d.members.some((m) => !m.waiver_signed);
  const dateIn = h('input', { type: 'date', id: 'hh-date', min: d.today, 'aria-label': 'Another day' });
  const dayRow = h('div', { class: 'hh-days', role: 'group', 'aria-label': 'Which day?' });
  const drawDays = () => clear(dayRow).append(...days.map((x) => h('button', { type: 'button', class: `chip${x === day ? ' on' : ''}`, 'aria-pressed': x === day ? 'true' : 'false', onclick: () => { day = x; dateIn.value = ''; drawDays(); reset(); } }, x === d.today ? 'Today' : x === addDay(d.today, 1) ? 'Tomorrow' : shortDay(x))), dateIn);
  dateIn.addEventListener('change', () => { if (dateIn.value) { day = dateIn.value; drawDays(); reset(); } });
  const who = h('ul', { class: 'hh-who', 'aria-label': 'Who is coming?' });
  const drawWho = () => clear(who).append(...d.members.map((m) => {
    const p = picked.get(m.id);
    const tog = (key, label) => h('button', { type: 'button', class: `chip small${p[key] ? ' on' : ''}`, 'aria-pressed': p[key] ? 'true' : 'false', disabled: !p.on, onclick: () => { p[key] = !p[key]; drawWho(); reset(); } }, label);
    return h('li', { class: `hh-person${p.on ? ' on' : ''}` },
      h('button', { type: 'button', class: 'hh-name', 'aria-pressed': p.on ? 'true' : 'false', onclick: () => { p.on = !p.on; drawWho(); reset(); } }, h('span', { class: 'hh-tick', 'aria-hidden': 'true' }, p.on ? '✓' : ''), h('span', null, m.first_name)),
      d.rental_offered ? tog('rental', 'Rental') : null, tog('lesson', 'Lesson'));
  }));
  let basket = null; let quote = null; let lessonLink = null;
  const reset = () => { basket = null; quote = null; pay.textContent = 'Check the total'; clear(msg); };
  const order = (b) => ({ contact_first_name: d.me.first_name, contact_last_name: d.me.last_name, contact_email: d.email, contact_phone: d.me.phone || '000-000-0000', ...b, terms_accepted: terms.checked, waiver_accepted: waiver.checked });
  async function go(same) {
    clear(msg);
    try {
      if (!basket || same) {
        const people = d.members.filter((m) => picked.get(m.id).on).map((m) => ({ id: m.id, rental: picked.get(m.id).rental, lesson: picked.get(m.id).lesson }));
        const out = await acall('POST', '/account/basket', same ? { date: day, same_as_last: true } : { date: day, people });
        if (out.missing_age.length) { msg.append(h('p', { class: 'error-box' }, `Add the birthday for ${out.missing_age.map((x) => x.first_name).join(', ')} under Your family: it sets the price.`)); return; }
        basket = out.basket; lessonLink = out.lesson_link;
        quote = await acall('POST', '/shop/quote', basket);
        msg.append(h('div', { class: 'hh-total' }, h('span', null, `${basket.items.length} ${basket.items.length === 1 ? 'ticket' : 'tickets'}${basket.addons.length ? ` and ${basket.addons.length} ${basket.addons.length === 1 ? 'rental' : 'rentals'}` : ''}, ${fmtDay(day)}`),
          quote.tax_cents ? h('span', { class: 'muted small' }, `Tax ${money(quote.tax_cents)}`) : null, h('b', null, `Total ${money(quote.total_cents)}`)),
        out.lesson_for.length ? h('p', { class: 'small' }, `After paying, book the lesson for ${out.lesson_for.join(' and ')} on the lesson page. It opens on this day.`) : null);
        pay.textContent = `Pay ${money(quote.total_cents)}`;
        return;
      }
      if (!terms.checked) { msg.append(h('p', { class: 'error-box' }, 'Please confirm you understand tickets are not refundable online.')); return; }
      if (needWaiver && !waiver.checked) { msg.append(h('p', { class: 'error-box' }, 'Please accept the waiver for this order.')); return; }
      pay.disabled = true; pay.textContent = 'Taking you to the card page…';
      try { sessionStorage.setItem(`hh-lesson-${slug}`, lessonLink || ''); } catch (_) { /* fine */ }
      const out = await acall('POST', '/shop/orders', order(basket));
      location.href = out.checkout_url;
    } catch (e) { msg.append(h('p', { class: 'error-box' }, e.message)); pay.disabled = false; }
  }
  pay.addEventListener('click', () => go(false));
  drawDays(); drawWho();
  return h('section', { class: 'card stack hh-buy', 'aria-labelledby': 'hh-buy-h' },
    h('div', { class: 'spread' }, h('h2', { id: 'hh-buy-h' }, 'Buy for a day'), d.rebuy ? h('button', { type: 'button', class: 'btn', onclick: () => go(true) }, 'Same as last time') : null),
    d.rebuy ? h('p', { class: 'small muted' }, `Last time: ${d.rebuy.people.join(', ')}. ${d.rebuy.products.join(', ')}.`) : null,
    h('h3', null, '1. Which day?'), dayRow,
    h('h3', null, '2. Who is coming?'), h('p', { class: 'small muted' }, 'Everyone gets their usual ticket for their age. Rentals use the sizes saved below.'), who,
    h('label', { class: 'check-row', for: 'hh-terms' }, terms, h('span', null, 'I understand tickets bought online are not refundable. If the mountain closes, I can call for help.')),
    needWaiver ? h('label', { class: 'check-row', for: 'hh-waiver' }, waiver, h('span', null, h('a', { href: d.waiver_link, target: '_blank', rel: 'noopener' }, 'I have read the waiver'), ' and accept it for myself and the children in this order.')) : null,
    msg, h('div', { class: 'row' }, pay));
}

// ---------------------------------------------------------------- passes and tickets
function ticketsCard(d) {
  if (!d.tickets.length) return h('section', { class: 'card stack' }, h('h2', null, 'Passes and tickets'), h('p', { class: 'muted' }, 'Nothing coming up yet. Tickets you buy show here, ready for the gate.'));
  return h('section', { class: 'card stack', 'aria-labelledby': 'hh-tk-h' }, h('h2', { id: 'hh-tk-h' }, 'Passes and tickets'),
    h('p', { class: 'small muted' }, 'Show the barcode at the lift. Turn your screen brightness up.'),
    h('div', { class: 'pass-grid' }, d.tickets.map((k) => h('article', { class: 'pass-card' },
      h('span', { class: 'who' }, k.first_name || 'Ticket'), h('span', null, k.product),
      h('span', { class: 'muted' }, k.pass ? `Good to ${fmtDay(k.valid_to)}` : k.valid_from === k.valid_to ? fmtDay(k.valid_from) : `${fmtDay(k.valid_from)} to ${fmtDay(k.valid_to)}`),
      k.card_label ? h('span', { class: 'small' }, `On card ${k.card_label}: tap it at the gate.`) : [code128(k.code, { height: 56, module: 2 }), h('span', { class: 'code' }, k.code)]))));
}

// ---------------------------------------------------------------- rewards
function rewardsCard(d, slug) {
  if (!d.rewards.length && !d.recaps.length) return null;
  return h('section', { class: 'card stack', 'aria-labelledby': 'hh-rw-h' }, h('h2', { id: 'hh-rw-h' }, d.rewards.length ? 'Rewards' : 'Your season'),
    ...d.rewards.map((r) => h('div', { class: 'hh-reward' },
      h('p', null, h('b', null, `${r.first_name}: ${r.kind === 'birthday' ? 'a birthday gift' : r.reason || 'a reward'}`), ` Pick one: ${r.words}.`),
      h('p', { class: 'small muted' }, `Good ${fmtDay(r.valid_from)} to ${fmtDay(r.valid_to)}. Use it when you buy online (signed in), or show code ${r.code} at the window.`),
      h('a', { class: 'btn small', href: `/shop/${encodeURIComponent(slug)}?reward=${r.id}` }, 'Use it in the shop'))),
    ...d.recaps.map((x) => h('p', null, h('a', { href: x.url }, x.label || `${x.first_name || 'Your'} season recap`))));
}

// ---------------------------------------------------------------- pass renewal with last season's photo
function renewCard(d, acall, slug) {
  if (!d.renew.length) return null;
  return h('section', { class: 'card stack', 'aria-labelledby': 'hh-rn-h' }, h('h2', { id: 'hh-rn-h' }, 'Renew your season pass'),
    ...d.renew.map((r) => {
      const box = h('div', { class: 'hh-renew' });
      const img = h('img', { class: 'pass-photo', alt: `${r.first_name}'s photo on file`, hidden: true });
      const msg = h('p', { role: 'status', class: 'small' });
      const yes = h('button', { type: 'button', class: 'btn primary', disabled: !r.has_photo }, 'Yes, still me. Renew');
      if (r.has_photo) acall('GET', `/account/people/${r.person_id}/photo`).then((p) => { if (p.photo) { img.src = p.photo; img.hidden = false; } }).catch(() => {});
      yes.addEventListener('click', async () => {
        msg.textContent = '';
        try {
          const out = await acall('POST', '/account/renew', { person_id: r.person_id, product_id: r.product_id, photo_is_me: true });
          const terms = confirm('Tickets and passes bought online are not refundable. Continue to pay?');
          if (!terms) return;
          const o = await acall('POST', '/shop/orders', { contact_first_name: d.me.first_name, contact_last_name: d.me.last_name, contact_email: d.email, contact_phone: d.me.phone || '000-000-0000', ...out.basket, terms_accepted: true, waiver_accepted: true });
          location.href = o.checkout_url;
        } catch (e) { msg.textContent = e.message; }
      });
      return h('div', { class: 'stack' }, h('p', null, h('b', null, r.first_name), ` had ${r.product} last season.`), img,
        r.has_photo ? h('p', { class: 'small' }, 'Is this photo still a good likeness? Then you do not need a new one.') : h('p', { class: 'small' }, 'No photo on file. Buy the pass in the shop with a new photo.'),
        h('div', { class: 'row' }, yes, h('a', { class: 'btn', href: `/shop/${encodeURIComponent(slug)}` }, 'Use a new photo')), msg, box);
    }),
    d.autorenew ? h('p', { class: 'small muted' }, 'Want it to renew by itself next year? Turn on "Renew automatically" on the pass once you have it.') : null);
}

// ---------------------------------------------------------------- the saved family
function familyCard(d, acall, onChange) {
  const rows = d.members.map((m) => {
    const bits = [m.date_of_birth ? `Born ${fmtDay(m.date_of_birth)}` : 'No birthday yet',
      m.height_in ? `${m.height_in} in` : null, m.weight_lb ? `${m.weight_lb} lb` : null, m.boot_size ? `boot ${m.boot_size}` : null,
      m.ski_level ? `ski level ${m.ski_level}` : null, m.snowboard_level ? `snowboard level ${m.snowboard_level}` : null, m.ability_level ? LEVELS[m.ability_level] : null].filter(Boolean);
    const edit = h('button', { type: 'button', class: 'btn small' }, 'Edit');
    edit.addEventListener('click', () => personDialog(m, acall, onChange));
    return h('li', { class: 'hh-member' }, h('div', null, h('b', null, `${m.first_name} ${m.last_name}`),
      h('span', { class: `fam-chip ${m.waiver_signed ? 'ok' : 'warn'}` }, m.waiver_signed ? 'Waiver signed' : 'Waiver to sign'),
      h('p', { class: 'small muted' }, bits.join(' · ')),
      m.visits && m.visits.this_season ? h('p', { class: 'small' }, `${m.visits.this_season} ${m.visits.this_season === 1 ? 'day' : 'days'} here this season`) : null), edit);
  });
  const add = h('button', { type: 'button', class: 'btn' }, 'Add someone');
  add.addEventListener('click', () => personDialog(null, acall, onChange));
  return h('section', { class: 'card stack', 'aria-labelledby': 'hh-fam-h' }, h('h2', { id: 'hh-fam-h' }, 'Your family'),
    h('p', { class: 'small muted' }, 'Saved once, used every time: sizes for rentals, levels for lessons, birthdays for the right price.'),
    h('ul', { class: 'hh-members' }, rows), h('div', { class: 'row' }, add, d.waiver_link && d.members.some((m) => !m.waiver_signed) ? h('a', { class: 'btn', href: d.waiver_link }, 'Sign waivers now') : null));
}

function personDialog(m, acall, onChange) {
  const dlg = h('dialog', { class: 'card stack', 'aria-labelledby': 'pd-h' });
  const f = (id, label, el, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), el, hint ? h('span', { class: 'hint' }, hint) : null);
  const inp = (id, v, more = {}) => h('input', { id, value: v ?? '', ...more });
  const first = inp('pd-f', m && m.first_name, { maxlength: 60, required: true, autocomplete: 'off' });
  const last = inp('pd-l', m && m.last_name, { maxlength: 60, required: true, autocomplete: 'off' });
  const dob = inp('pd-b', m && m.date_of_birth, { type: 'date' });
  const ht = inp('pd-h', m && m.height_in, { type: 'number', min: 20, max: 96, inputmode: 'numeric' });
  const wt = inp('pd-w', m && m.weight_lb, { type: 'number', min: 15, max: 400, inputmode: 'numeric' });
  const boot = inp('pd-boot', m && m.boot_size, { maxlength: 10 });
  const sel = (id, opts, v) => h('select', { id }, h('option', { value: '' }, 'Not set'), opts.map(([k, t]) => h('option', { value: k, selected: String(v ?? '') === String(k) }, t)));
  const stance = sel('pd-st', [['regular', 'Regular (left foot forward)'], ['goofy', 'Goofy (right foot forward)']], m && m.stance);
  const ability = sel('pd-ab', Object.entries(LEVELS), m && m.ability_level);
  const ski = sel('pd-sk', Array.from({ length: 9 }, (_, i) => [i + 1, `Level ${i + 1}`]), m && m.ski_level);
  const board = sel('pd-sb', Array.from({ length: 9 }, (_, i) => [i + 1, `Level ${i + 1}`]), m && m.snowboard_level);
  const adult = h('input', { type: 'checkbox', id: 'pd-adult' });
  const photoIn = h('input', { type: 'file', accept: 'image/*', id: 'pd-ph' });
  let photo; photoIn.addEventListener('change', async () => { try { photo = await shrink(photoIn.files[0]); } catch (e) { err.textContent = e.message; err.hidden = false; } });
  const err = h('p', { class: 'error-box', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit', class: 'btn primary' }, 'Save');
  const close = h('button', { type: 'button', class: 'btn' }, 'Close');
  const num = (el) => (el.value === '' ? null : Number(el.value));
  const form = h('form', { class: 'stack', novalidate: true }, h('h2', { id: 'pd-h' }, m ? `${m.first_name}'s details` : 'Add someone'),
    h('div', { class: 'hh-grid' }, f('pd-f', 'First name', first), f('pd-l', 'Last name', last), f('pd-b', 'Birthday', dob, 'Sets the ticket price'),
      f('pd-h', 'Height (inches)', ht), f('pd-w', 'Weight (pounds)', wt), f('pd-boot', 'Boot or shoe size', boot), f('pd-st', 'Snowboard stance', stance),
      f('pd-ab', 'Ability', ability), f('pd-sk', 'Ski level', ski), f('pd-sb', 'Snowboard level', board), f('pd-ph', 'Pass photo (a clear face)', photoIn)),
    m ? null : h('label', { class: 'check-row', for: 'pd-adult' }, adult, h('span', null, 'This is another adult (not a child in my care)')),
    err, h('div', { class: 'row' }, close, save));
  close.addEventListener('click', () => dlg.close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.hidden = true;
    if (!first.value.trim() || !last.value.trim()) { err.textContent = 'Add a first and last name.'; err.hidden = false; return; }
    const body = { first_name: first.value.trim(), last_name: last.value.trim(), date_of_birth: dob.value || null, height_in: num(ht), weight_lb: num(wt), boot_size: boot.value.trim() || null,
      stance: stance.value || null, ability_level: ability.value || null, ski_level: ski.value ? Number(ski.value) : null, snowboard_level: board.value ? Number(board.value) : null, ...(photo ? { photo } : {}) };
    try {
      if (m) await acall('PATCH', `/account/people/${m.id}`, body);
      else { if (!adult.checked && !body.date_of_birth) { err.textContent = 'Add the birthday for a child: it sets their ticket price.'; err.hidden = false; return; } await acall('POST', '/account/people', { ...body, adult: adult.checked }); }
      dlg.close(); onChange();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  dlg.append(form); document.body.append(dlg); dlg.showModal();
  dlg.addEventListener('close', () => dlg.remove());
}

// ---------------------------------------------------------------- receipts
function receiptsCard(d) {
  if (!d.receipts.length) return null;
  return h('section', { class: 'card stack', 'aria-labelledby': 'hh-rc-h' }, h('h2', { id: 'hh-rc-h' }, 'Receipts'),
    h('ul', { class: 'hh-receipts' }, d.receipts.map((r) => h('li', null, h('a', { href: r.link }, `Order ${r.reference}`), h('span', { class: 'muted small' }, ` ${r.paid_on ? fmtDay(r.paid_on) : ''}, ${money(r.amount_cents)}`)))));
}
