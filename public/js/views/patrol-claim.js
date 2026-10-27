// The claim panel on a case's Record view: the documentation score, the red flags and whether management and the
// insurer were told, a button to open the claim file, and (for patrol admins) the secure links shared outside, with
// every view. Also the pieces the claim file and records pages reuse: the score block, the links list, and the
// one-time dialog that shows a new link and its passcode.
import { get, post } from '../api.js';
import { h, clear, button, toast, state, errorBox, dialog, confirmDialog } from '../ui.js';
import { has } from './patrol-feat.js';
import { when } from './claim-render.js';

const tone = (n) => (n === null || n === undefined ? 'neutral' : n >= 90 ? 'good' : n >= 70 ? 'warn' : 'bad');

/** The score of one report: the number, what is missing, timeliness, and the red flags with who was told. */
export function scoreBlock(s) {
  if (!s) return null;
  const flags = s.red_flags || [];
  return h('div', { class: 'cf-score stack' },
    h('div', { class: 'cf-score-top' },
      h('div', { class: `cf-score-num is-${tone(s.score)}` }, h('b', null, s.score === null ? '–' : `${s.score}%`), h('span', null, s.score === null ? 'No requirements set' : `${s.answered} of ${s.items} ${s.basis === 'recommended' ? 'recommended' : 'required'} items`)),
      h('dl', { class: 'kv cf-kv' },
        h('dt', null, 'Signed off'), h('dd', null, s.hours_to_submit === null ? 'Not yet' : `${s.hours_to_submit} hours after the incident `, s.on_time === null ? null : state(s.on_time ? 'Within 24 hours' : 'Later than 24 hours', s.on_time ? 'good' : 'warn')),
        h('dt', null, 'N/A answers'), h('dd', null, String(s.na)),
        h('dt', null, 'Skipped before leaving'), h('dd', null, String(s.skips)),
        h('dt', null, 'Approved with exceptions'), h('dd', null, String(s.exceptions)))),
    (s.missing || []).length ? h('details', { class: 'cf-missing' }, h('summary', null, `${s.missing.length} missing`), h('ul', { class: 'cf-list' }, s.missing.map((x) => h('li', null, x.message, x.exception ? ' (approved with an exception)' : '')))) : null,
    flags.length ? h('div', { class: 'cf-flags' },
      h('p', null, h('b', null, 'Red flags: '), flags.map((f) => f.label).join(', ')),
      h('p', { class: 'row wrap tight' },
        state(s.told.management ? 'Management told' : 'Management not told', s.told.management ? 'good' : 'bad'),
        state(s.told.insurer ? 'Insurer told' : 'Insurer not told', s.told.insurer ? 'good' : 'warn'))) : null);
}

const SHARE_STATE = { active: 'good', expired: 'neutral', revoked: 'neutral', locked: 'bad' };
/** Links shared outside, with their views. Revoke for patrol admins. */
export function sharesList(list, reload) {
  if (!list || !list.length) return h('p', { class: 'muted small' }, 'No secure links yet. Make one from a released records request.');
  return h('ul', { class: 'cf-shares' }, list.map((s) => h('li', null,
    h('div', { class: 'spread' },
      h('div', null, h('b', null, s.shared_with), ' ', state(s.state === 'active' ? `Open until ${when(s.expires_at)}` : s.state === 'locked' ? 'Locked: wrong passcodes' : s.state === 'revoked' ? `Stopped ${when(s.revoked_at)}` : `Expired ${when(s.expires_at)}`, SHARE_STATE[s.state]),
        h('div', { class: 'muted small' }, `${s.kind === 'risk' ? `Season risk report ${s.season}` : `Claim file${s.release_no ? `, release ${s.release_no}` : ''}`} · made ${when(s.created_at)}${s.created_by ? ` by ${s.created_by}` : ''}${s.has_code ? ' · passcode' : ''}`)),
      s.state === 'active' ? button('Stop link', () => confirmDialog('Stop this link?', `${s.shared_with} will no longer be able to open it. You can make a new one later.`, 'Stop link', async () => { await post(`/patrol/shares/${s.id}/revoke`); toast('Link stopped'); await reload(); }, { danger: true }), { small: true }) : null),
    s.views ? h('details', { class: 'cf-views' }, h('summary', null, `Opened ${s.views} ${s.views === 1 ? 'time' : 'times'}, last ${when(s.last_view_at)}`),
      h('ul', { class: 'cf-list small' }, s.view_log.map((v) => h('li', null, `${when(v.at)} · ${v.ip || 'unknown address'}${v.user_agent ? ` · ${v.user_agent.slice(0, 60)}` : ''}`))))
      : h('p', { class: 'muted small' }, 'Not opened yet.'))));
}

/** A new link is shown once: the address and the passcode, to send separately. */
export function showNewLink(out, who) {
  const copy = (text, what) => button(`Copy ${what}`, async () => { try { await navigator.clipboard.writeText(text); toast(`${what[0].toUpperCase()}${what.slice(1)} copied`); } catch (_) { toast('Select it and copy'); } }, { small: true });
  dialog('Secure link made', h('div', { class: 'stack' },
    h('p', null, `Send this to ${who}. It works until ${when(out.expires_at)} and every opening is logged on the case.`),
    h('div', { class: 'code cf-link' }, h('span', null, out.url), copy(out.url, 'link')),
    out.passcode ? h('div', null, h('p', null, h('b', null, 'Passcode. '), 'Send it a different way (a phone call or a text), not in the same email as the link.'), h('div', { class: 'code' }, h('span', null, out.passcode), copy(out.passcode, 'passcode'))) : null,
    h('p', { class: 'muted small' }, 'This is the only time the link and passcode are shown. If they are lost, stop this link and make a new one.')), { wide: true });
}

/** The panel on the Record view. Nothing for a case started with no signal (not on the server yet) or a frozen copy. */
export function claimPanel({ c, id, version }) {
  if (version || !c || Number(id) < 0) return null;
  if (!has('view_cases') && !has('records')) return null;
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Working out the documentation score…'));
  const panel = h('section', { class: 'panel stack cf-panel' },
    h('div', { class: 'spread' }, h('h2', null, 'Claim file'), h('a', { class: 'btn primary small', href: `#/patrol/claim/${id}` }, 'Open claim file')),
    h('p', { class: 'muted small' }, 'Everything an insurer or attorney asks for on one printable page: the approved report, care timeline, photos with fingerprints, conditions, rental gear, who was told, witnesses, records releases and the audit trail. Opening it is logged.'),
    body);
  async function load() {
    try {
      const s = await get(`/patrol/incidents/${id}/doc-score`);
      clear(body).append(...[
        s.basis !== 'approved' ? h('p', { class: 'small' }, state(s.basis === 'draft' ? 'Draft: the score may change' : 'Not approved yet: the score may change', 'warn')) : null,
        scoreBlock(s),
        s.can && s.can.records ? h('div', { class: 'stack' }, h('h3', null, 'Shared outside'), sharesList(s.shares, load)) : null,
      ].filter(Boolean));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  load();
  return panel;
}
