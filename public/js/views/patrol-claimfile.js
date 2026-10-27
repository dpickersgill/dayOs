// Patrol > a case > Claim file (#/patrol/claim/:id): everything about one case an adjuster, a broker or the mountain's
// attorney asks for, on one printable page. The approved, frozen report when there is one; otherwise the latest version,
// clearly marked. Opening it is logged. The documentation score, records releases, secure links and the audit trail
// follow the report (those are the mountain's own and never go outside).
import { get, fetchBlob, download } from '../api.js';
import { h, button, label, state } from '../ui.js';
import { claimDoc, when } from './claim-render.js';
import { scoreBlock, sharesList } from './patrol-claim.js';

const ACTIONS = {
  view: 'Opened the case', claim_file_view: 'Opened the claim file', claim_share: 'Made a secure link', claim_share_view: 'Secure link opened', claim_share_revoke: 'Stopped a secure link',
  records_request: 'Logged a records request', records_release: 'Released the report', records_pack_view: 'Opened the release pack', submit: 'Signed off', approve: 'Approved', return: 'Sent back',
};

export async function renderClaimFile(root, id) {
  const f = await get(`/patrol/incidents/${id}/claim-file`);
  const urls = [];
  const photoSrc = (p, img) => {
    fetchBlob(`/patrol/incidents/${id}/photos/${p.id}/preview`).then((b) => { const u = URL.createObjectURL(b); urls.push(u); img.src = u; }).catch(() => { img.replaceWith(h('div', { class: 'cf-nophoto' }, 'No preview')); });
  };
  const extra = [
    h('section', { class: 'cf-sec' }, h('h2', null, 'Documentation score'), scoreBlock(f.score)),
    h('section', { class: 'cf-sec' }, h('h2', null, 'Legal hold and records'),
      h('p', null, f.legal_hold ? state('On legal hold', 'bad') : state('Not on legal hold', 'neutral'), f.legal_hold_note ? ` ${f.legal_hold_note}` : ''),
      f.records.length ? h('div', { class: 'table-wrap cf-table' }, h('table', { class: 'rt' },
        h('thead', null, h('tr', null, ['Received', 'From', 'Authority', 'Status', 'Version'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, f.records.map((r) => h('tr', null,
          h('td', { 'data-label': 'Received' }, when(r.received_on)), h('td', { 'data-label': 'From' }, `${r.requester_name} (${label(r.requester_kind)})`),
          h('td', { 'data-label': 'Authority' }, label(r.authorization)), h('td', { 'data-label': 'Status' }, `${label(r.status)}${r.release_no ? ` ${r.release_no}, ${when(r.released_at)}` : ''}`),
          h('td', { 'data-label': 'Version' }, r.version_no ? `Version ${r.version_no}` : '')))))) : h('p', { class: 'muted' }, 'No records requests.'),
      f.can.records ? h('div', null, h('h3', null, 'Secure links'), sharesList(f.shares, () => location.reload())) : null),
    f.audit ? h('section', { class: 'cf-sec cf-audit' }, h('h2', null, `Audit trail (${f.audit.length})`),
      h('p', { class: 'muted small' }, 'Every opening, change, export and release of this case, newest first.'),
      h('div', { class: 'table-wrap cf-table' }, h('table', { class: 'rt' },
        h('thead', null, h('tr', null, ['When', 'Who', 'What', 'Details'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, f.audit.map((a) => h('tr', null, h('td', { 'data-label': 'When' }, when(a.at)), h('td', { 'data-label': 'Who' }, a.user || (a.action.endsWith('_view') && a.action.startsWith('claim_share') ? 'Outside (secure link)' : 'System')),
          h('td', { 'data-label': 'What' }, ACTIONS[a.action] || label(a.action)), h('td', { 'data-label': 'Details' }, detailText(a.detail)))))))) : null,
  ].filter(Boolean);
  const bar = h('div', { class: 'no-print row wrap cf-bar' },
    h('a', { class: 'btn', href: `#/patrol/case/${id}` }, 'Back to the case'),
    button('Print or save as PDF', () => window.print(), { kind: 'primary' }),
    f.report.photos && f.report.photos.some((p) => !p.voided_at) ? button('Download the original photos', async () => {
      for (const p of f.report.photos.filter((x) => !x.voided_at)) await download(`/patrol/incidents/${id}/photos/${p.id}/original`, `case-${f.case_number}-photo-${p.id}.jpg`);
    }) : null);
  root.append(h('div', { class: 'print-page claim-file' }, bar, claimDoc(f, { photoSrc, extra })));
  window.addEventListener('hashchange', () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
}

function detailText(d) {
  if (!d || typeof d !== 'object') return '';
  const parts = [];
  if (d.shared_with) parts.push(String(d.shared_with));
  if (d.release_no) parts.push(String(d.release_no));
  if (d.ip) parts.push(`from ${d.ip}`);
  if (d.basis) parts.push(label(d.basis));
  if (d.version) parts.push(`version ${d.version}`);
  if (d.expires_at) parts.push(`until ${when(d.expires_at)}`);
  return parts.join(', ');
}
