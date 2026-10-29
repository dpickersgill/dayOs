// Rentals, Forms: the guest rental forms waiting for the counter today. "Use this form" matches each person to a customer,
// saves their sizes, keeps their signed confirmation, and puts them on the order's rentals that are ready to fit. The QR
// poster for the shop is printed from here too.

import { get, post } from '../api.js';
import { h, clear, state, input, button, toast, dialog, confirmDialog, empty, fmtDate, fmtDateTime, label } from '../ui.js';
import { personPicker } from '../widgets.js';
import { printDialog } from '../print.js';
import { qr } from '../barcode.js';

const ABILITY = { cautious: 'Cautious', moderate: 'Moderate', aggressive: 'Aggressive' };
const TYPE_WORDS = { 1: 'Cautious', 2: 'Moderate', 3: 'Aggressive' };
export const abilityText = (p) => {
  const t = p.skier_type ? String(p.skier_type) : null;
  const words = p.ability ? ABILITY[p.ability] : t ? TYPE_WORDS[Math.floor(Number(t))] : null;
  return words ? `${words}${t ? ` (Type ${t})` : ''}` : null;
};
export const heightText = (inches) => (inches ? `${Math.floor(inches / 12)}' ${inches % 12}"` : null);
/** One line of sizes: height, weight, boot or shoe, ability, board stance. */
export function sizesText(p) {
  return [heightText(p.height_in), p.weight_lb ? `${p.weight_lb} lb` : null, p.boot_size ? `boot ${p.boot_size}` : null, p.shoe_size ? `shoe ${p.shoe_size}` : null,
    abilityText(p), p.discipline === 'snowboard' ? `snowboard${p.stance ? `, ${p.stance}` : ''}` : null, p.helmet ? 'helmet' : null].filter(Boolean).join(' · ');
}
const nameOf = (p) => `${p.first_name} ${p.last_name}`;

export async function drawForms(box) {
  let coming = false;
  const search = input({ type: 'search', placeholder: 'Name, phone or order number', 'aria-label': 'Search forms' });
  const listBox = h('div', { class: 'stack' });
  const when = h('div', { class: 'rchips', role: 'group', 'aria-label': 'Which day' });
  let timer;
  async function load() {
    const q = search.value.trim();
    const r = await get(`/rentals/forms?${new URLSearchParams({ ...(q ? { q } : {}), ...(coming ? { coming: '1' } : {}) })}`);
    clear(when).append(chip('Today', !coming, () => { coming = false; load(); }), chip('Coming days', coming, () => { coming = true; load(); }));
    clear(listBox);
    if (!r.data.length) { listBox.append(empty(q ? 'No waiting form matches.' : coming ? 'No forms for the coming days yet.' : 'No forms waiting for today. Guests fill them in from the QR poster or the link on their receipt.')); return; }
    for (const f of r.data) listBox.append(formCard(f, load));
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch((e) => toast(e.message, 'error')), 250); });
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Forms guests filled in on their phone: sizes, ability and a signature for each renter.'), button('Print the QR poster', printPoster)),
    h('div', { class: 'row rform-bar' }, search, when), listBox));
  await load();
}

function chip(text, on, click) {
  const b = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on) }, text);
  b.addEventListener('click', click);
  return b;
}

function formCard(f, reload) {
  return h('article', { class: 'panel rform-card' },
    h('div', { class: 'spread' },
      h('div', null, h('strong', null, f.contact_name), f.phone ? h('span', { class: 'muted' }, ` · ${f.phone}`) : null),
      h('span', { class: 'row' }, f.order_id ? state(`Order #${f.order_id}`, 'good') : null, f.group_name ? state(f.group_name, 'neutral') : null, !f.order_id && !f.group_id ? state('Walk-in', 'neutral') : null)),
    h('ul', { class: 'rform-people' }, ...f.people.map((p) => h('li', null, h('strong', null, nameOf(p)), h('span', { class: 'small muted' }, ` ${sizesText(p)}`)))),
    h('div', { class: 'spread' }, h('span', { class: 'small muted' }, `For ${fmtDate(f.rental_on)} · sent ${fmtDateTime(f.created_at)}`),
      h('span', { class: 'row' },
        button('Discard', () => confirmDialog('Discard this form?', `The form from ${f.contact_name} is set aside and will not show again.`, 'Discard', async () => { await post(`/rentals/forms/${f.id}/discard`, {}); toast('Form discarded'); await reload(); }, { danger: true }), { small: true }),
        button('Use this form', () => useForm(f.id, reload), { kind: 'primary', small: true }))));
}

/** The dialog that matches each person to a customer and uses the form. */
export async function useForm(id, done) {
  const f = await get(`/rentals/forms/${id}`);
  const picks = f.people.map((p, index) => {
    const best = p.candidates.find((c) => c.dob_match);
    const pick = { index, person_id: best ? best.id : null, skip: false };
    const group = `m${id}-${index}`;
    const opt = (value, text, extra, checked) => {
      const r = h('input', { type: 'radio', name: group, value: String(value), checked });
      r.addEventListener('change', () => { if (r.checked) { pick.person_id = value === 'new' || value === 'skip' || value === 'other' ? null : Number(value); pick.skip = value === 'skip'; otherBox.hidden = value !== 'other'; } });
      return h('label', { class: 'check' }, r, h('span', null, text, extra ? h('span', { class: 'small muted' }, ` ${extra}`) : null));
    };
    const otherBox = h('div', { hidden: true });
    const picker = personPicker({ label: 'Find the customer', onPick: (x) => { pick.person_id = x ? x.id : null; } });
    otherBox.append(picker.el);
    const signerLine = p.signer_relation === 'self' ? `Signed by ${p.signer_name}` : `Signed by ${p.signer_name} (${label(p.signer_relation)})`;
    return { pick, el: h('section', { class: 'rform-person stack' },
      h('div', { class: 'spread' }, h('h3', null, `${nameOf(p)}${p.age != null ? `, ${p.age}` : ''}`), h('span', { class: 'small muted' }, `Born ${fmtDate(p.date_of_birth)}`)),
      h('p', null, sizesText(p)),
      h('div', { class: 'rform-sig' }, p.signature ? h('img', { src: p.signature, alt: `Signature of ${p.signer_name}` }) : null, h('span', { class: 'small muted' }, signerLine)),
      h('fieldset', { class: 'stack tight' }, h('legend', null, 'Who is this in your records?'),
        ...p.candidates.map((c) => opt(c.id, nameOf(c), [`record #${c.id}`, c.date_of_birth ? `born ${fmtDate(c.date_of_birth)}` : 'no date of birth', c.phone, c.waiver_signed ? 'waiver signed' : 'no waiver yet', c.dob_match ? 'same birthday' : null].filter(Boolean).join(' · '), best ? best.id === c.id : false)),
        opt('new', 'New customer', 'Add them with these details', !best),
        opt('other', 'Someone else', 'Search for them'),
        otherBox,
        opt('skip', 'Leave this person out', 'They are not renting today'))) };
  });
  const orderInput = input({ type: 'number', min: '1', placeholder: 'Order number', 'aria-label': 'Order number', style: 'width:10rem' });
  const orderNote = f.order_id
    ? h('div', { class: 'callout' }, h('strong', null, `Order #${f.order_id}. `), f.to_fit.length ? `They go on its ${f.to_fit.length} rental${f.to_fit.length === 1 ? '' : 's'} ready to fit.` : 'No rentals ready to fit on this order yet.')
    : f.group_name ? h('div', { class: 'callout' }, h('strong', null, `${f.group_name}. `), 'They are added to the group.')
      : h('div', { class: 'row' }, h('span', null, 'Paid already? Put them on the order:'), orderInput);
  const go = button('Use this form', async () => {
    for (const x of picks) if (!x.pick.skip && x.el.querySelector('input[value="other"]').checked && !x.pick.person_id) throw new Error('Pick the customer, or choose New customer');
    const body = { people: picks.map((x) => ({ index: x.pick.index, person_id: x.pick.person_id, ...(x.pick.skip ? { skip: true } : {}) })), ...(orderInput.value ? { order_id: Number(orderInput.value) } : {}) };
    const r = await post(`/rentals/forms/${id}/use`, body);
    dlg.close();
    toast(`Form used for ${r.people.length} ${r.people.length === 1 ? 'person' : 'people'}${r.attached.length ? `. ${r.attached.length} ready to fit.` : '.'}`);
    if (done) await done(r);
  }, { kind: 'primary' });
  const dlg = dialog(`Form from ${f.contact_name}`, [h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, `${f.phone || 'No phone'}${f.email ? ` · ${f.email}` : ''} · for ${fmtDate(f.rental_on)}. Check each person against your records. Their sizes and signature are saved to the customer you pick.`),
    ...picks.map((x) => x.el), orderNote, h('div', { class: 'footer row' }, go))], { wide: true });
}

async function printPoster() {
  const { url, mountain } = await get('/rentals/forms/link');
  printDialog('Rental form poster', h('article', { class: 'sheet rform-poster', 'data-sheet': 'poster' },
    h('div', { class: 'rform-poster-mtn' }, mountain),
    h('h2', null, 'Renting gear? Fill in your form first.'),
    h('p', { class: 'rform-poster-sub' }, 'Skip the clipboard. It takes about two minutes on your phone.'),
    h('div', { class: 'rform-poster-qr' }, qr(url, { size: 320 })),
    h('ol', null, h('li', null, 'Point your phone camera at the code.'), h('li', null, 'Fill in each person: height, weight, boot size and how they ski. Sign for each.'), h('li', null, 'At the counter, give your name or phone number.')),
    h('p', { class: 'rform-poster-url' }, url)));
}
