// Customers: the shared record that tickets, lessons, rentals and programs all point at.
import { get, post, patch, download } from '../api.js';
import { h, clear, can, isManager, money, table, state, input, field, button, toast, formDialog, dialog, fmtDate, fmtDateTime, label, empty, errorBox } from '../ui.js';
import { waiverPanel } from '../widgets.js';
import { shareButton } from '../share.js';
import { loadCustomerForm, customerFields, customerSettingsDialog } from './customer-form.js';
import { photoSection, familySection, duplicatesDialog, renewalsDialog, mergeDialog } from './people-extra.js';
import { alertsBanner, consentSection, notesSection, dataActions, qualityStrip, FLAG_LABELS } from './customer-care.js';
import { welcomeCard, familyHistory } from './guest-card.js';

export async function render(root, params = []) {
  const q = input({ type: 'search', placeholder: 'Name, email or phone', 'aria-label': 'Search customers' });
  const body = h('div');
  const canWrite = can('counter', 'instructor');
  const mgr = isManager();
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Customers'), h('div', { class: 'row' },
    mgr ? button('Mandatory details', () => customerSettingsDialog(), { small: true }) : null,
    mgr ? button('Find duplicates', () => duplicatesDialog(load), { small: true }) : null,
    canWrite ? button('Season pass renewals', () => renewalsDialog(), { small: true }) : null,
    mgr ? button('Export CSV', () => download('/people/export.csv', 'customers.csv'), { small: true }) : null,
    mgr ? button('Email list CSV', () => download('/people/export.csv?marketing=1', 'email-list.csv'), { small: true }) : null,
    canWrite ? button('Add customer', () => edit(null, load), { kind: 'primary' }) : null)),
  h('div', { class: 'inline-form' }, field('Search', q), button('Search', () => load())), body);
  qualityStrip().then((el) => { if (el) body.before(el); });
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/people?limit=100${q.value.trim() ? `&q=${encodeURIComponent(q.value.trim())}` : ''}`);
      let extra = {};
      if (data.length) { try { extra = (await get(`/people/scores?ids=${data.map((p) => p.id).join(',')}`)).data; } catch (_) { extra = {}; } }
      clear(body).append(data.length ? table([
        { head: 'Name', cell: (p) => h('span', null, h('strong', null, `${p.first_name} ${p.last_name}`), ...((extra[p.id] && extra[p.id].flags) || []).map((k) => h('span', { class: 'flag-pill', 'data-kind': k }, FLAG_LABELS[k] || k))) },
        { head: 'Email', cell: (p) => p.email || '' },
        { head: 'Phone', cell: (p) => p.phone || '' },
        { head: 'Where', cell: (p) => [p.city, p.region].filter(Boolean).join(', ') },
        { head: 'Emails', cell: (p) => (p.marketing_opt_in ? state('Agreed', 'good') : '') },
        { head: 'Complete', cell: (p) => (extra[p.id] ? `${extra[p.id].score}%` : '') },
        { head: '', actions: true, cell: (p) => button('Open', () => detail(p, load), { small: true }) },
      ], data) : empty(q.value.trim() ? 'No one matches that search.' : 'No customers yet. They are added when you sell a ticket or book a lesson, or you can add one here.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
  // #/people/12 (a shared link): open that customer straight away
  if (/^\d+$/.test(params[0] || '')) detail({ id: Number(params[0]) }, load).catch((err) => toast(err.message || 'Could not open that customer', 'error'));
}

async function edit(p, done) {
  const def = await loadCustomerForm();
  const f = customerFields({ def, scope: null, person: p, sizing: true });
  const notes = h('textarea', { name: 'notes', maxlength: 1000, rows: 2 });
  formDialog(p ? `Edit ${p.first_name} ${p.last_name}` : 'Add a customer', h('div', { class: 'stack' }, f.el, p ? null : field('First note', notes, 'Seen by staff only. More notes can be added on the customer\u2019s record.')), async () => {
    const v = f.values();
    if (!v.first_name || !v.last_name) throw new Error('First and last name are required');
    if (p) await patch(`/people/${p.id}`, v);
    else {
      const made = await post('/people', v);
      if (notes.value.trim()) await post(`/people/${made.id}/notes`, { category: 'general', body: notes.value.trim() });
    }
    toast('Saved');
    await done();
  }, { wide: true });
}

async function detail(p, done) {
  const fresh = await get(`/people/${p.id}`);
  const line = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
  const address = [fresh.address_line1, fresh.address_line2, [fresh.city, fresh.region].filter(Boolean).join(', '), [fresh.postal_code, fresh.country].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const parts = [
    h('div', { class: 'row end' }, shareButton('customer', fresh.id)),
    fresh.anonymised_at ? h('p', { class: 'muted' }, 'This customer has been anonymised. Their history stays for the mountain\u2019s records.') : null,
    alertsBanner(fresh),
    // the welcome back (Track WINDOW): visits, pass, birthday, the family's lessons and sizes, rewards held
    !fresh.anonymised_at && can('counter', 'instructor', 'staff') ? welcomeCard(fresh.id) : null,
    h('dl', { class: 'cust-lines' },
      ...line('Email', fresh.email), ...line('Phone', fresh.phone), ...line('Born', fresh.date_of_birth ? fmtDate(fresh.date_of_birth) : ''),
      ...line('Address', address), ...line('Emergency contact', [fresh.emergency_name, fresh.emergency_phone].filter(Boolean).join(', ')),
      ...line('Skiing', [fresh.discipline, fresh.ability_level].filter(Boolean).map(label).join(', ')),
      ...line('Rental sizing', [fresh.height_in && `${fresh.height_in} in`, fresh.weight_lb && `${fresh.weight_lb} lb`, fresh.boot_size && `boot ${fresh.boot_size}`, fresh.stance && label(fresh.stance), fresh.skier_type && `type ${fresh.skier_type}`].filter(Boolean).join(', ')),
      ...line('First recorded', fresh.created_at ? `${fmtDate(String(fresh.created_at).slice(0, 10))}${fresh.source ? ` (${label(fresh.source)})` : ''}` : '')),
  ];
  if (can('counter', 'instructor')) parts.push(h('h3', null, 'Photo'), photoSection(fresh), h('h3', null, 'Family'), familySection(fresh), h('h3', null, 'Season waiver'), waiverPanel(fresh.id));
  parts.push(h('h3', null, 'Consent'), consentSection(fresh), h('h3', null, 'Notes'), notesSection(fresh));
  const hist = h('div', { class: 'stack' });
  parts.push(h('h3', null, 'History'), hist);
  loadHistory(hist, fresh);
  // the whole family's history, visits and rewards, and a manager's goodwill credit (Track WINDOW)
  if (can('counter', 'instructor') && !fresh.anonymised_at) parts.push(h('h3', null, 'Family history'), familyHistory(fresh));
  if (can('instructor')) {
    const box = h('div');
    parts.push(h('h3', null, 'Lesson progress'), box);
    try {
      const { data } = await get(`/people/${fresh.id}/progress`);
      box.append(data.length ? table([{ head: 'Date', cell: (r) => fmtDate(String(r.recorded_at).slice(0, 10)) }, { head: 'Discipline', cell: (r) => label(r.discipline) }, { head: 'Level', num: true, cell: (r) => String(r.level) }, { head: 'Notes', cell: (r) => r.notes || '' }], data) : h('p', { class: 'muted' }, 'No progress recorded.'));
    } catch (_) { box.append(h('p', { class: 'muted' }, 'Not available.')); }
  }
  let shown;
  const act = dataActions(fresh, async () => { if (shown) shown.close(); await done(); });
  if (act) parts.push(h('h3', null, 'Their data'), act);
  if (can('counter', 'instructor') && !fresh.anonymised_at) parts.push(h('div', { class: 'row' }, button('Edit details', () => edit(fresh, done)),
    isManager() ? button('Merge with another record', () => mergeDialog(fresh, async (kept) => { if (shown) shown.close(); await done(); if (kept) detail(kept, done); })) : null));
  shown = dialog(`${fresh.first_name} ${fresh.last_name}`, parts, { wide: true });
}

/** What this customer has bought and done, across tickets, lessons, rentals and programs. */
async function loadHistory(box, person) {
  try {
    const a = await get(`/people/${person.id}/activity`);
    const none = !a.orders.length && !a.lessons.length && !a.rentals.length && !a.programs.length;
    clear(box);
    if (none) { box.append(h('p', { class: 'muted' }, 'Nothing bought or booked yet.')); return; }
    box.append(h('p', null, `${a.totals.orders} paid order${a.totals.orders === 1 ? '' : 's'}, ${money(a.totals.spend_cents)} spent after refunds, ${a.totals.days_skied} day${a.totals.days_skied === 1 ? '' : 's'} scanned at the gate.`));
    if (a.tickets.length) box.append(h('h4', null, 'Tickets'), table([
      { head: 'Ticket', cell: (t) => t.product }, { head: 'Valid', cell: (t) => (t.valid_from === t.valid_to ? fmtDate(t.valid_from) : `${fmtDate(t.valid_from)} to ${fmtDate(t.valid_to)}`) },
      { head: 'Status', cell: (t) => state(label(t.status), t.status === 'active' ? 'good' : 'neutral') }, { head: 'Code', cell: (t) => t.code }], a.tickets));
    if (a.lessons.length) box.append(h('h4', null, 'Lessons'), table([
      { head: 'When', cell: (l) => fmtDateTime(l.starts_at) }, { head: 'Lesson', cell: (l) => l.product }, { head: 'Status', cell: (l) => label(l.status) }], a.lessons));
    if (a.rentals.length) box.append(h('h4', null, 'Rentals'), table([
      { head: 'Out', cell: (r) => fmtDateTime(r.checked_out_at) }, { head: 'Status', cell: (r) => label(r.status) }], a.rentals));
    if (a.programs.length) box.append(h('h4', null, 'Programs'), table([
      { head: 'Program', cell: (r) => r.name }, { head: 'Season', cell: (r) => r.season }, { head: 'Status', cell: (r) => label(r.status) }], a.programs));
  } catch (_) {
    clear(box).append(h('p', { class: 'muted' }, 'History is not available to your role.'));
  }
}
