// Patrol: who looked at patient information. For patrol administrators.

import { get } from '../api.js';
import { h, clear, table, input, field, button, fail, fmtDateTime, label, empty } from '../ui.js';

const WHAT = {
  view: 'Opened a case', create: 'Started a case', update: 'Changed a case', add_patient: 'Added a patient', update_patient: 'Changed a patient', remove_patient: 'Removed a patient',
  pull_from_customer: 'Pulled guest details into a patient', pull_preview: 'Looked up a guest\'s ticket and gear', lookup: 'Searched for a guest',
  export: 'Exported records', read: 'Viewed the incident map', view_signature: 'Opened a signature', view_access_log: 'Read this log',
  submitted: 'Submitted a report', approved: 'Approved a report', reopened: 'Reopened a report', add_note: 'Added a note',
};
const what = (a) => WHAT[a] || label(a);

export async function drawAccessLog(box) {
  const from = input({ type: 'date', name: 'from' });
  const to = input({ type: 'date', name: 'to' });
  const out = h('div');
  async function load() {
    const q = new URLSearchParams();
    if (from.value) q.set('from', from.value);
    if (to.value) q.set('to', to.value);
    try {
      const { data } = await get(`/patrol/access-log?${q}`);
      clear(out).append(data.length ? table([
        { head: 'When', cell: (r) => fmtDateTime(r.at) },
        { head: 'Who', cell: (r) => r.user_email || 'Unknown' },
        { head: 'What', cell: (r) => what(r.action) },
        { head: 'Case', cell: (r) => (r.case_number ? h('a', { href: `#/patrol/case/${r.entity_id}` }, r.case_number) : '') },
        { head: 'Details', cell: (r) => (r.detail && r.detail.fields ? r.detail.fields.join(', ') : '') },
      ], data) : empty('No activity in that period.'));
    } catch (err) { clear(out); fail(err); }
  }
  clear(box).append(
    h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Every time patient information is opened, changed, searched for, pulled in or exported, it is recorded here with who did it. Entries are kept and cannot be edited from the app. The log records that a search happened, not what was typed.'),
      h('div', { class: 'row' }, field('From', from), field('To', to), button('Show', load, { small: true })),
      out));
  await load();
}
