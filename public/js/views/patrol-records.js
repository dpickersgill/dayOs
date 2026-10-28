// Patrol > Cases > Records requests: who asked for a report, on what authority, and what was released, with a release
// number. Only the approved, frozen version is ever released, and opening the release pack is logged. Cases on legal
// hold are listed too. The release pack prints as a cover sheet plus the report.
import { get, post, put, patch } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, table, empty, errorBox, state, fmtDate, fmtDateTime, label, todayStr } from '../ui.js';
import { sharesList, showNewLink } from './patrol-claim.js';

const KINDS = [['patient', 'The patient'], ['guardian', 'Parent or guardian'], ['insurer', 'Insurer'], ['attorney', 'Attorney'], ['police', 'Police'], ['court', 'Court'], ['other', 'Other']];
const AUTHS = [['none', 'Nothing yet'], ['signed_release', 'Signed release from the patient'], ['patient_self', 'The patient asking for their own'], ['subpoena', 'Subpoena'], ['court_order', 'Court order'], ['police_request', 'Police request']];
const tone = { open: 'warn', released: 'good', denied: 'bad', withdrawn: 'neutral' };

export async function drawRecords(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try {
      const [d, links] = await Promise.all([get('/patrol/records'), get('/patrol/shares').catch(() => ({ data: [] }))]);
      draw(d, links.data.filter((x) => x.kind === 'claim'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(d, links = []) {
    clear(body).append(
      h('div', { class: 'spread' }, h('div', null, h('h2', null, 'Records requests'), h('p', { class: 'muted' }, 'Release only with an authorization on file. Only the approved report is released, frozen, with a release number.')),
        button('Log a request', () => requestDialog(load), { kind: 'primary' })),
      d.data.length ? table([
        { head: 'Received', cell: (r) => fmtDate(String(r.received_on).slice(0, 10)) },
        { head: 'Case', cell: (r) => h('a', { href: `#/patrol/case/${r.incident_id}` }, r.case_number) },
        { head: 'From', cell: (r) => `${r.requester_name} (${label(r.requester_kind)})` },
        { head: 'Authority', cell: (r) => (AUTHS.find((a) => a[0] === r.authorization) || [0, r.authorization])[1] },
        { head: 'Status', cell: (r) => h('span', null, state(label(r.status), tone[r.status]), r.release_no ? ` ${r.release_no}` : '') },
        { head: '', actions: true, cell: (r) => h('span', { class: 'row tight' },
          r.status === 'open' ? button('Release', () => releaseDialog(r, load), { small: true, kind: 'primary' }) : null,
          r.status === 'open' ? button('Authority', () => authDialog(r, load), { small: true }) : null,
          r.status === 'open' ? button('Deny or withdraw', () => decideDialog(r, load), { small: true, kind: 'ghost' }) : null,
          r.status === 'released' ? h('a', { class: 'btn small', href: `#/patrol/release/${r.id}` }, 'Release pack') : null,
          r.status === 'released' ? button('Secure link', () => shareDialog(r, load), { small: true }) : null) },
      ], d.data) : empty('No requests yet.'),
      h('section', { class: 'panel stack' }, h('h3', null, 'Secure links to claim files'),
        h('p', { class: 'muted small' }, 'A link opens only the approved report a release sent, until it expires or you stop it. Every opening is logged with the time and address.'),
        sharesList(links, load)),
      h('section', { class: 'panel' }, h('h3', null, `Cases on legal hold (${d.holds.length})`), d.holds.length ? h('ul', { class: 'duty-list' }, d.holds.map((c) => h('li', null, h('a', { href: `#/patrol/case/${c.id}` }, c.case_number), ` ${label(c.category)}, ${fmtDate(String(c.occurred_at).slice(0, 10))}: ${c.legal_hold_note || ''}`)))
        : h('p', { class: 'muted small' }, 'None. Put a case on hold from its Record view when a claim or request arrives.')));
  }
  await load();
}

async function requestDialog(again) {
  formDialog('Log a records request', h('div', { class: 'form' },
    field('Case number', input({ name: 'case', required: true, placeholder: '2026-27-0012' })),
    field('Received', input({ name: 'received_on', type: 'date', value: todayStr(), required: true })),
    field('From', select(KINDS, 'insurer', { name: 'requester_kind' })), field('Name', input({ name: 'requester_name', required: true, maxlength: 150 })),
    h('div', { class: 'wide' }, field('Contact', input({ name: 'contact', maxlength: 255, placeholder: 'Email, phone or address to send it to' }))),
    field('Authority received', select(AUTHS, 'none', { name: 'authorization' })), field('Authority details', input({ name: 'auth_note', maxlength: 255, placeholder: 'Release dated 10/12, case no. ...' }))), async (fd) => {
    const q = String(fd.get('case')).trim();
    const { data } = await get(`/patrol/incidents?q=${encodeURIComponent(q)}`);
    const c = data.find((x) => x.case_number === q) || (data.length === 1 ? data[0] : null);
    if (!c) throw new Error(`No single case matches "${q}". Use the full case number.`);
    await post('/patrol/records', { incident_id: c.id, received_on: fd.get('received_on'), requester_kind: fd.get('requester_kind'), requester_name: String(fd.get('requester_name')).trim(), contact: String(fd.get('contact') || '').trim() || null, authorization: fd.get('authorization'), auth_note: String(fd.get('auth_note') || '').trim() || null });
    toast(`Request logged for ${c.case_number}`); await again();
  }, { submitText: 'Log request', wide: true });
}

function authDialog(r, again) {
  formDialog('Authority for this request', h('div', { class: 'form' }, field('Authority received', select(AUTHS, r.authorization, { name: 'authorization' })), field('Details', input({ name: 'auth_note', maxlength: 255, value: r.auth_note || '' }))), async (fd) => {
    await patch(`/patrol/records/${r.id}`, { authorization: fd.get('authorization'), auth_note: String(fd.get('auth_note') || '').trim() || null });
    toast('Saved'); await again();
  });
}

function releaseDialog(r, again) {
  formDialog(`Release ${r.case_number} to ${r.requester_name}?`, h('div', { class: 'stack' },
    h('p', null, 'The approved report is released as it was approved, with a release number. The pack can then be printed or saved as a PDF and sent.'),
    field('Note', input({ name: 'note', maxlength: 500, placeholder: 'Sent by secure email' }))), async (fd) => {
    const out = await post(`/patrol/records/${r.id}/release`, { note: String(fd.get('note') || '').trim() || null });
    toast(`Released as ${out.release_no}`);
    location.hash = `#/patrol/release/${r.id}`;
    await again();
  }, { submitText: 'Release' });
}

/** After a release: a link the insurer opens instead of an emailed file. 14 days, revocable, with a passcode. */
function shareDialog(r, again) {
  formDialog(`Secure link for ${r.case_number}`, h('div', { class: 'form' },
    h('div', { class: 'wide' }, h('p', null, `Release ${r.release_no}: only the approved report it released. Every opening is logged on the case.`)),
    h('div', { class: 'wide' }, field('Who it is for', input({ name: 'shared_with', required: true, maxlength: 150, value: r.requester_name }))),
    field('Open for', select([['14', '14 days'], ['7', '7 days'], ['30', '30 days']], '14', { name: 'days' })),
    field('Passcode', select([['yes', '6-digit passcode (recommended)'], ['no', 'No passcode']], 'yes', { name: 'passcode' }), 'Send the passcode a different way from the link.')), async (fd) => {
    const who = String(fd.get('shared_with')).trim();
    const out = await post(`/patrol/records/${r.id}/share`, { shared_with: who, days: Number(fd.get('days')), passcode: fd.get('passcode') === 'yes' });
    showNewLink(out, who); await again();
  }, { submitText: 'Make link', wide: true });
}

function decideDialog(r, again) {
  formDialog('Deny or withdraw', h('div', { class: 'form' }, field('Outcome', select([['denied', 'Denied'], ['withdrawn', 'Withdrawn by the requester']], 'denied', { name: 'status' })), h('div', { class: 'wide' }, field('Why', input({ name: 'note', required: true, maxlength: 500 })))), async (fd) => {
    await post(`/patrol/records/${r.id}/decide`, { status: fd.get('status'), note: String(fd.get('note')).trim() });
    toast('Saved'); await again();
  });
}

/** The release pack: a cover sheet, then the frozen report (opened read only, as Record shows versions). */
export async function renderRelease(root, id) {
  const p = await get(`/patrol/records/${id}/pack`);
  const r = p.request;
  root.append(h('div', { class: 'print-page release-pack' },
    h('div', { class: 'no-print row' }, h('a', { class: 'btn', href: '#/patrol/cases?tab=records' }, 'Back'), button('Print or save as PDF', () => window.print(), { kind: 'primary' })),
    h('h1', null, `Release ${r.release_no}`),
    h('p', null, h('b', null, p.resort.legal_name || p.resort.name)),
    h('table', { class: 'kv' }, h('tbody', null,
      ...[['Case', r.case_number], ['Released to', `${r.requester_name} (${label(r.requester_kind)})`], ['Contact', r.contact || ''], ['Request received', fmtDate(String(r.received_on).slice(0, 10))],
        ['Authority', `${(AUTHS.find((a) => a[0] === r.authorization) || [0, r.authorization])[1]}${r.auth_note ? `: ${r.auth_note}` : ''}`], ['Released', fmtDateTime(r.released_at)], ['Released by', r.decided_by_name || ''],
        ['Report version', `Version ${p.version.version_no}, approved ${fmtDateTime(p.version.created_at)}`]].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
    h('p', { class: 'muted small' }, 'Confidential patient information, released under the authority above. Do not pass it on except as that authority allows.'),
    h('div', { class: 'page-break' }),
    h('div', { id: 'release-report' })));
  // The report itself: the frozen version, drawn read only as Record shows versions.
  const { renderCase } = await import('./patrol-case.js');
  await renderCase(root.querySelector('#release-report'), r.incident_id, { me: await get('/patrol/me'), version: p.version.id });
}

/** Legal hold switch for a case's Record view. */
export function legalHoldControl(c, onDone) {
  return h('div', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h3', null, 'Legal hold'), c.legal_hold ? state('On hold', 'bad') : state('Not on hold', 'neutral')),
    c.legal_hold ? h('p', { class: 'small' }, c.legal_hold_note || '') : h('p', { class: 'muted small' }, 'Put the case on hold when a claim, lawsuit or records request arrives: nothing on it can then be marked entered in error.'),
    button(c.legal_hold ? 'Take off hold' : 'Put on hold', () => formDialog(c.legal_hold ? 'Take off legal hold?' : 'Put on legal hold', c.legal_hold ? h('p', null, 'Only when the claim is settled and counsel agrees.') : field('Why', input({ name: 'note', required: true, maxlength: 255, placeholder: 'Claim letter from ... dated ...' })), async (fd) => {
      await put(`/patrol/incidents/${c.id}/legal-hold`, { hold: !c.legal_hold, note: c.legal_hold ? null : String(fd.get('note')).trim() });
      toast(c.legal_hold ? 'Hold removed' : 'Case on legal hold'); await onDone();
    }), { small: true }));
}
