// The printed rental agreement for one contract: the mountain, the renter and each person with the details they
// confirmed and their signature, each piece of gear with its binding setting, technician and test, when it is due back,
// the deposit, the fees and a reminder about the waiver.

import { get } from '../api.js';
import { h, label, money, fmtDate, fmtDateTime, fmtTimeZoned } from '../ui.js';
import { printDialog } from '../print.js';
import { code128 } from '../barcode.js';

const feet = (inches) => (inches ? `${Math.floor(inches / 12)} ft ${inches % 12} in` : null);
const when = (s) => `${fmtDate(s)}, ${fmtTimeZoned(s)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dobText = (v) => { const [y, m, dd] = String(v).slice(0, 10).split('-'); return `${MONTHS[Number(m) - 1]} ${Number(dd)}, ${y}`; };
const ABILITY = { 1: 'Cautious', 2: 'Moderate', 3: 'Aggressive' };

function detailsText(d) {
  if (!d) return 'No details signed';
  return [
    d.height_in ? `Height ${feet(d.height_in)}` : null, d.weight_lb ? `Weight ${d.weight_lb} lb` : null,
    d.date_of_birth ? `Born ${dobText(d.date_of_birth)}` : null, d.boot_size ? `Boot ${d.boot_size}` : null,
    d.boot_sole_mm ? `Sole ${d.boot_sole_mm} mm` : null, d.stance ? `Stance ${label(d.stance).toLowerCase()}` : null,
    d.skier_type ? `Skis ${(ABILITY[d.skier_type] || '').toLowerCase()} (Type ${d.skier_type})` : null,
  ].filter(Boolean).join(' · ') || 'No details signed';
}

export function agreementSheet(a) {
  const c = a.contract;
  const lateFee = a.fees.late_fee_cents_per_day
    ? `A late fee of ${money(a.fees.late_fee_cents_per_day)} a day applies when gear comes back more than ${a.fees.late_grace_minutes} minutes after the due time.`
    : 'No late fee is charged.';
  const deposit = c.deposit_cents ? `Deposit held: ${money(c.deposit_cents)}${c.deposit_card ? ` on ${c.deposit_card}` : ''}.` : 'No deposit held.';
  return h('article', { class: 'sheet agreement-sheet', 'data-sheet': 'agreement' },
    h('header', { class: 'ag-head' }, h('div', null, h('strong', null, a.mountain.name), a.mountain.address ? h('div', null, a.mountain.address) : null, a.mountain.phone ? h('div', null, a.mountain.phone) : null),
      h('div', { class: 'ag-code' }, code128(`RC-${c.id}`, { height: 36, module: 1.4 }), h('div', null, `Rental agreement #${c.id}`))),
    h('div', { class: 'ag-meta' },
      h('div', null, h('strong', null, 'Out: '), c.checked_out_at && c.status !== 'to_fit' ? fmtDateTime(c.checked_out_at) : 'Not handed out yet'),
      h('div', null, h('strong', null, 'Due back: '), when(c.due_at), c.kind === 'season' ? ' (season rental)' : ''),
      c.product_name ? h('div', null, h('strong', null, 'Package: '), c.product_name) : null,
      h('div', null, deposit)),
    ...a.people.map((p) => h('section', { class: 'ag-person' },
      h('h3', null, `${p.first_name} ${p.last_name}${p.age !== null && p.age !== undefined ? `, ${p.age}` : ''}${p.is_renter ? ' (renter)' : ''}`),
      h('p', null, detailsText(p.signoff && p.signoff.details)),
      p.items.length ? h('table', { class: 'ag-gear' },
        h('thead', null, h('tr', null, ['Gear', 'Tag', 'Binding setting', 'Set by', 'Test'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, p.items.map((i) => h('tr', null,
          h('td', null, `${label(i.category)} ${[i.brand, i.model, i.size].filter(Boolean).join(' ')}`), h('td', null, i.sku),
          h('td', null, i.din_setting == null ? (['ski', 'snowboard'].includes(i.category) ? 'Not recorded' : '') : String(Number(i.din_setting))),
          h('td', null, i.tech_name || ''), h('td', null, i.test_result ? label(i.test_result === 'pass' ? 'passed' : 'failed') : ''))))) : h('p', { class: 'muted' }, 'No gear for this person.'),
      p.signoff ? h('div', { class: 'ag-sign' },
        h('p', { class: 'small' }, `${p.signoff.signer_name}${p.signoff.signer_relation !== 'self' ? ` (${p.signoff.signer_relation})` : ''} signed that these details are true, ${fmtDateTime(p.signoff.signed_at)}${p.signoff.via === 'form' ? ', on the rental form' : ''}.`),
        h('img', { class: 'sig-img', src: p.signoff.signature, alt: `Signature of ${p.signoff.signer_name}` }))
        : h('p', { class: 'small' }, 'Not signed.'),
      h('p', { class: 'small' }, p.waiver_signed ? `Waiver signed for the ${a.season} season.` : `No waiver on file for the ${a.season} season.`))),
    h('section', { class: 'ag-terms small' },
      h('p', null, 'The binding setting was chosen from the details above. If any of them are wrong, tell the rental shop before you ski.'),
      h('p', null, lateFee, ' Damage beyond normal wear and gear that is lost are charged at the shop\'s rates.'),
      h('p', null, 'Everyone using this gear must have a signed waiver for the season. Skiing and riding have risks you accept under that waiver.')));
}

export async function printAgreement(contractId) {
  const a = await get(`/rentals/fit/contracts/${contractId}/agreement`);
  printDialog(`Rental agreement #${contractId}`, agreementSheet(a));
}
