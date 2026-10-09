// Customers: alerts, consent history, dated notes, and the manager's data actions for one person.
import { get, post, del, download } from '../api.js';
import { h, clear, can, isManager, state, field, select, button, toast, fail, confirmDialog, formDialog, fmtDate, fmtDateTime, errorBox, input, val } from '../ui.js';

export const FLAG_LABELS = { do_not_rent: 'Do not rent', unpaid_balance: 'Unpaid balance', medical_alert: 'Medical alert', vip: 'VIP', banned: 'Banned', other: 'Note' };
const FLAG_TONE = { do_not_rent: 'bad', banned: 'bad', unpaid_balance: 'warn', medical_alert: 'warn', vip: 'good', other: 'neutral' };
const NOTE_LABELS = { general: 'General', service: 'Service', complaint: 'Complaint', preference: 'Preference', follow_up: 'Follow up' };
const SOURCE_LABELS = { counter: 'At the counter', phone: 'By phone', in_writing: 'In writing', online: 'Online', guest_request: 'Guest asked', staff_form: 'Customer form', sale: 'At a sale', earlier_record: 'Earlier record', erasure: 'Erasure' };
const CHANNEL = { email: 'Email', sms: 'Text messages' };

/** Coloured alerts for staff: shown first in a customer's record. */
export function alertsBanner(person, onChange) {
  const box = h('div', { class: 'cust-alerts' });
  async function load() {
    try {
      const { data } = await get(`/people/${person.id}/flags`);
      clear(box);
      for (const f of data) {
        const row = h('div', { class: 'cust-alert', 'data-tone': FLAG_TONE[f.kind] || 'neutral', role: 'note' },
          h('strong', null, FLAG_LABELS[f.kind]), h('span', null, ` ${f.message}`),
          h('small', { class: 'muted' }, ` ${f.set_by_name ? `set by ${f.set_by_name}` : ''}${f.expires_on ? `, until ${fmtDate(String(f.expires_on).slice(0, 10))}` : ''}`));
        if (isManager()) row.append(button('Clear', async () => { try { await del(`/people/${person.id}/flags/${f.id}`); toast('Cleared'); await load(); if (onChange) onChange(); } catch (e) { fail(e); } }, { small: true }));
        box.append(row);
      }
      if (isManager()) box.append(button('Add an alert', () => flagDialog(person, async () => { await load(); if (onChange) onChange(); }), { small: true }));
    } catch (_) { clear(box); }
  }
  load();
  return box;
}

function flagDialog(person, done) {
  const kind = select(Object.entries(FLAG_LABELS), 'other', { name: 'kind' });
  const msg = input({ name: 'message', maxlength: 200, required: true, placeholder: 'What staff should know' });
  const until = input({ name: 'expires_on', type: 'date' });
  formDialog(`Add an alert for ${person.first_name} ${person.last_name}`, h('div', { class: 'stack' }, field('Kind', kind), field('Message', msg, 'Staff see this when they look the customer up.'), field('Until (optional)', until, 'Leave empty to keep it until you clear it.')), async (fd) => {
    await post(`/people/${person.id}/flags`, { kind: val(fd, 'kind'), message: val(fd, 'message') || '', expires_on: val(fd, 'expires_on') });
    toast('Alert added');
    await done();
  });
}

/** What this person has agreed to, by channel, with the full history underneath. */
export function consentSection(person) {
  const box = h('div', { class: 'stack' });
  async function load() {
    try {
      const c = await get(`/people/${person.id}/consent`);
      clear(box);
      const line = (channel) => {
        const cur = c.current[channel];
        const on = cur && cur.status === 'opted_in';
        const row = h('div', { class: 'row' }, h('strong', null, CHANNEL[channel]),
          cur ? state(on ? 'Agreed' : 'Opted out', on ? 'good' : 'neutral') : state('Nothing recorded', 'warn'),
          cur ? h('small', { class: 'muted' }, `${fmtDate(String(cur.since).slice(0, 10))}, ${SOURCE_LABELS[cur.source] || cur.source}`) : null);
        if (can('counter', 'instructor') && !person.anonymised_at) row.append(button(on ? 'Record opt-out' : 'Record agreement', () => consentDialog(person, channel, on ? 'opted_out' : 'opted_in', load), { small: true }));
        return row;
      };
      box.append(line('email'), line('sms'));
      if (c.events.length) box.append(h('details', null, h('summary', null, `History (${c.events.length})`),
        h('ul', { class: 'plain' }, c.events.map((e) => h('li', null, `${fmtDateTime(e.created_at)}: ${CHANNEL[e.channel]} ${e.status === 'opted_in' ? 'agreed' : 'opted out'} (${SOURCE_LABELS[e.source] || e.source}${e.recorded_by_name ? `, ${e.recorded_by_name}` : ''})`)))));
    } catch (err) { clear(box).append(errorBox(err)); }
  }
  load();
  return box;
}

function consentDialog(person, channel, status, done) {
  const how = select(Object.entries(SOURCE_LABELS).filter(([k]) => ['counter', 'phone', 'in_writing', 'online', 'guest_request'].includes(k)), status === 'opted_out' ? 'guest_request' : 'counter', { name: 'source' });
  formDialog(`${status === 'opted_in' ? 'Record agreement' : 'Record opt-out'}: ${CHANNEL[channel]}`, h('div', { class: 'stack' },
    h('p', null, `${person.first_name} ${person.last_name} ${status === 'opted_in' ? 'has agreed to receive' : 'no longer wants'} ${channel === 'sms' ? 'text messages' : 'email'} from the mountain.`),
    field('How did they tell you?', how)), async (fd) => {
    await post(`/people/${person.id}/consent`, { channel, status, source: val(fd, 'source') });
    toast('Recorded');
    await done();
  }, { submitText: 'Record' });
}

/** Dated notes, newest first. */
export function notesSection(person) {
  const box = h('div', { class: 'stack' });
  const list = h('div', { class: 'stack' });
  const text = h('textarea', { rows: 2, maxlength: 1000, 'aria-label': 'New note', placeholder: 'Add a note for the next person who serves this customer' });
  const cat = select(Object.entries(NOTE_LABELS), 'general', { 'aria-label': 'Kind of note' });
  const draw = (data) => {
    clear(list);
    if (!data.length) { list.append(h('p', { class: 'muted' }, 'No notes yet.')); return; }
    for (const n of data) {
      const row = h('div', { class: 'cust-note' }, h('div', { class: 'row' }, state(NOTE_LABELS[n.category], 'neutral'), h('small', { class: 'muted' }, `${fmtDateTime(n.created_at)}${n.author_name ? `, ${n.author_name}` : ''}`)), h('p', null, n.body));
      if (isManager()) row.append(button('Delete', () => confirmDialog('Delete this note?', 'This cannot be undone.', 'Delete', async () => { await del(`/people/${person.id}/notes/${n.id}`); await load(); }, { danger: true }), { small: true }));
      list.append(row);
    }
  };
  async function load() { try { draw((await get(`/people/${person.id}/notes`)).data); } catch (err) { clear(list).append(errorBox(err)); } }
  if (can('counter', 'instructor') && !person.anonymised_at) {
    box.append(h('div', { class: 'stack' }, text, h('div', { class: 'row' }, cat, button('Add note', async () => {
      const body = text.value.trim();
      if (!body) return;
      try { draw((await post(`/people/${person.id}/notes`, { category: cat.value, body })).data); text.value = ''; } catch (e) { fail(e); }
    }, { kind: 'primary', small: true }))));
  }
  box.append(list);
  load();
  return box;
}

/** Manager-only: download everything held about this person, or remove who they are. */
export function dataActions(person, done) {
  if (!isManager() || person.anonymised_at) return null;
  return h('div', { class: 'row' },
    button('Download this person’s data', async () => { try { await download(`/people/${person.id}/data-export`, `customer-${person.id}-data.json`); } catch (e) { fail(e); } }, { small: true }),
    button('Anonymise', () => confirmDialog(`Anonymise ${person.first_name} ${person.last_name}?`,
      'Their name, contact details, photo, notes and alerts are removed for good. Sales, tickets, rentals and signed waivers stay, with no name on them, and the record of their consent stays. This cannot be undone.',
      'Anonymise', async () => { await post(`/people/${person.id}/anonymise`, { confirm: true }); toast('Anonymised'); await done(); }, { danger: true }), { small: true }));
}

/** A strip across the top of the Customers screen: what is missing, in plain counts. */
export async function qualityStrip() {
  if (!isManager()) return null;
  try {
    const q = await get('/people/quality');
    if (!q.total) return null;
    const pct = (n) => `${Math.round((n / q.total) * 100)}%`;
    const bit = (n, what) => h('li', null, h('strong', null, String(n)), ` ${what} (${pct(n)})`);
    return h('details', { class: 'cust-quality' }, h('summary', null, `Customer details are ${q.average_score}% complete on average`),
      h('ul', { class: 'plain' }, bit(q.no_email, 'have no email'), bit(q.no_phone, 'have no phone'), bit(q.no_date_of_birth, 'have no date of birth'), bit(q.no_address, 'have no address'), bit(q.no_consent_record, 'have no consent record'), h('li', null, h('strong', null, String(q.open_flags)), ' open alerts')));
  } catch (_) { return null; }
}
