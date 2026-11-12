// Street notices, Water customers (release 2026.11.20): the service addresses from the utility billing system, kept apart
// from the alert sign-ups. A water or sewer notice reaches every service address on its streets: by text or email where
// the import confirmed consent (STOP still honored), and by door hanger or mail for the rest. The crew sees the counts and
// the door hanger list (addresses only); managers and the front desk see an address's phone and email; managers import.
import { get, post, download } from '../api.js';
import { h, clear, table, button, field, input, toast, formDialog, confirmDialog, dialog, appendAll, fmtInstant, empty, isManager, can } from '../ui.js';
import { printDialog } from '../print.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function customersTab(box) {
  const draw = async () => {
    const r = await get('/street-notices/service-addresses/streets');
    appendAll(clear(box),
      h('p', null, 'The water service addresses from your billing system. Water outage, boil water and sewer notices reach every address on the streets you pick: by text or email where you have the customer\u2019s consent, and on a door hanger or mail list for the rest. This list is kept apart from the residents who signed up for alerts.'),
      r.total ? h('p', null, `${plural(r.total, 'service address', 'service addresses')}, ${r.with_contact} with a phone or email you have consent to use.${r.last_import ? ` Last imported ${fmtInstant(r.last_import.at)}.` : ''}`) : null,
      isManager() ? h('div', { class: 'row' }, button('Import from billing', () => importDialog(draw), { kind: 'primary', small: true }), button('Imports', imports, { small: true }),
        r.total ? button('Remove the list', () => confirmDialog('Remove the whole customer list?', 'Every service address is taken off, and every phone and email on the list is removed. Alert sign-ups are not touched. You can import the list again.', 'Remove', async () => {
          await post('/street-notices/service-addresses/clear', { confirm: true }); toast('Removed'); await draw();
        }, { danger: true }), { small: true }) : null) : null,
      r.data.length ? table([
        { head: 'Street', cell: (s) => h('strong', null, s.name) },
        { head: 'Addresses', num: true, cell: (s) => String(s.addresses) },
        { head: 'With consent for texts or email', num: true, cell: (s) => String(s.with_contact) },
        { head: '', actions: true, cell: (s) => (can('counter') ? button('Open', () => street(s), { small: true, label: `Open ${s.name}` }) : '') },
      ], r.data) : empty(isManager() ? 'No customer list yet. Export the service addresses from your billing system as a CSV and import it here.' : 'No customer list yet. A manager imports it from the billing system.'));
  };
  await draw();
}

async function street(s) {
  const r = await get(`/street-notices/service-addresses?street_id=${s.street_id}`);
  dialog(`${s.name}: water customers`, r.data.length ? table([
    { head: 'Address', cell: (x) => `${x.house_number || ''}${x.unit ? `, ${x.unit}` : ''}` },
    { head: 'Account', cell: (x) => (x.account_last4 ? `\u2026${x.account_last4}` : '') }, // only the last 4 are kept
    { head: 'Text', cell: (x) => (x.phone ? `${x.phone}${x.texts_stopped_at ? ' (stopped)' : ''}` : '') },
    { head: 'Email', cell: (x) => (x.email ? `${x.email}${x.emails_stopped_at ? ' (stopped)' : ''}` : '') },
  ], r.data) : empty('No addresses on this street.'), { wide: true });
}

function importDialog(done) {
  const file = input({ type: 'file', accept: '.csv,text/csv' });
  const csv = h('textarea', { name: 'csv', rows: 8, placeholder: 'account_number,service_address,unit,phone,email\n10-2231,214 Market St,,610-555-0101,\n10-2232,216 Market St,2B,,pat@example.com' });
  file.addEventListener('change', async () => { const f = file.files[0]; if (f) csv.value = await f.text(); });
  const consent = h('input', { type: 'checkbox', id: 'sa-consent' });
  const note = input({ maxlength: 300, placeholder: 'For example: Water bill sign-up form, text and email box ticked' });
  const noteField = field('How did the customers agree?', note);
  noteField.hidden = true;
  consent.addEventListener('change', () => { noteField.hidden = !consent.checked; note.required = consent.checked; });
  const replace = h('input', { type: 'checkbox', id: 'sa-replace' });
  formDialog('Import water customers', h('div', { class: 'stack' },
    h('p', null, 'Export the service addresses from your utility billing system as a CSV with a header row. Columns read: street and house number (or one service address column like "214 Market St"), unit, account number, phone, email. Streets must be on your street list.'),
    field('CSV file', file), field('Or paste it', csv),
    h('label', { class: 'check', for: 'sa-consent' }, consent, ' We have these customers’ consent to text or email them about their water service. This is recorded with your name.'),
    noteField,
    h('p', { class: 'muted small' }, 'Without this box ticked, the phones and emails in the file are not kept: the addresses go on the door hanger list. A phone that texted STOP, or an email that used the stop link, stays stopped.'),
    h('label', { class: 'check', for: 'sa-replace' }, replace, ' This file is the whole list: take off addresses that are not in it (their phones and emails are removed)')), async () => {
    const r = await post('/street-notices/service-addresses/import', { csv: csv.value, file_name: file.files[0] ? file.files[0].name : null, consent: consent.checked, consent_note: consent.checked ? note.value.trim() : null, replace: replace.checked });
    toast(`${plural(r.added, 'address', 'addresses')} added, ${r.updated} updated${r.ended ? `, ${r.ended} taken off` : ''}`);
    const lines = [
      `${plural(r.contacts_kept, 'phone or email', 'phones and emails')} kept${r.stopped ? `, ${r.stopped} of them already said stop` : ''}.`,
      r.contacts_dropped ? `${plural(r.contacts_dropped, 'row', 'rows')} had a phone or email that was not kept, because consent was not confirmed.` : null,
    ].filter(Boolean);
    dialog('Import done', h('div', { class: 'stack' }, ...lines.map((l) => h('p', null, l)),
      r.skipped.length ? h('div', null, h('h3', null, 'Rows to check'), h('ul', { class: 'plain' }, r.skipped.map((s) => h('li', null, `Line ${s.line}: ${s.reason}`)))) : null));
    await done();
  }, { submitText: 'Import', wide: true });
}

async function imports() {
  const { data } = await get('/street-notices/service-addresses/imports');
  dialog('Imports of the customer list', data.length ? table([
    { head: 'When', cell: (x) => fmtInstant(x.created_at) },
    { head: 'By', cell: (x) => x.by_name || '' },
    { head: 'Rows', num: true, cell: (x) => String(x.rows_in) },
    { head: 'Added, updated, taken off', cell: (x) => `${x.added}, ${x.updated}, ${x.ended}` },
    { head: 'Consent', cell: (x) => (x.consent ? `Confirmed: ${x.consent_note}` : 'Not confirmed (no phones or emails kept)') },
  ], data) : empty('No imports yet.'), { wide: true });
}

/** A notice's door hanger and mail list: addresses only, in street and house number order, to print or download. */
export async function doorHangers(noticeId) {
  const r = await get(`/street-notices/${noticeId}/door-hangers`);
  const byStreet = new Map();
  for (const a of r.addresses) { if (!byStreet.has(a.street)) byStreet.set(a.street, []); byStreet.get(a.street).push(a); }
  const sheet = h('div', { class: 'sheet stack' },
    h('h2', null, `Door hangers: ${r.notice.title}`), h('p', null, `${r.notice.type_label}, notice ${r.notice.code}. Streets: ${r.streets}.`),
    !r.reaches_customers ? h('p', null, 'This kind of notice does not go to the water customer list.')
      : r.addresses.length ? h('p', null, `${plural(r.addresses.length, 'address', 'addresses')} without a phone or email to use. Leave a door hanger or mail the notice.`) : h('p', null, 'Every customer address on these streets gets a text or email. No door hangers needed.'),
    ...[...byStreet].map(([name, list]) => h('section', { class: 'stack tight' }, h('h3', null, `${name} (${list.length})`),
      h('ul', { class: 'plain door-list' }, list.map((a) => h('li', null, h('span', { class: 'tick', 'aria-hidden': 'true' }, '☐ '), `${a.house_number || 'No number'}${a.unit ? `, unit ${a.unit}` : ''} ${name}`))))));
  printDialog('Door hanger list', sheet, [button('Download spreadsheet', () => download(`/street-notices/${noticeId}/door-hangers?format=csv`, `door-hangers-${r.notice.code}.csv`))]);
}
