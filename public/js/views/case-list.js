// One way to show a case in a list, used by the patrol home screen and the Cases tab so they always look and read the same.

import { h, state, fmtDateTime, label } from '../ui.js';

const sevTone = { minor: 'neutral', moderate: 'warn', serious: 'bad', critical: 'bad' };
const stateTone = { draft: 'warn', submitted: 'neutral', approved: 'good' };
const stateText = { draft: 'Draft', submitted: 'Waiting for review', approved: 'Approved' };

/** opts: { reportState: show the draft / waiting / approved chip (default false) } */
export function caseRow(i, { reportState = false } = {}) {
  return h('a', { class: 'case-row', href: `#/patrol/case/${i.id}` },
    h('span', { class: 'cr-main' }, h('b', null, i.case_number || `Case ${i.id}`), ' ', h('span', null, i.summary)),
    h('span', { class: 'cr-meta muted small' }, `${fmtDateTime(i.occurred_at)} · ${i.location}`),
    h('span', { class: 'cr-tags' },
      state(label(i.severity), sevTone[i.severity]), ' ', state(label(i.category), 'neutral'),
      reportState && stateText[i.report_state] ? [' ', state(stateText[i.report_state], stateTone[i.report_state])] : null,
      i.patient_count ? h('span', { class: 'muted small' }, ` ${i.patient_count} patient${i.patient_count === 1 ? '' : 's'}`) : null));
}
