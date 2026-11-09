// Ready for you (AI release 1): what the assistant drafted for this person to approve. Today shows a card per draft;
// the Inbox shows how many are waiting. Nothing is published or sent until a person presses Approve, and then it is done
// as them, with their own permissions (src/lib/proposals.js). Every draft says "Drafted by the assistant" until a person
// changes it.
import { get, post } from '../api.js';
import { h, clear, button, toast, fail } from '../ui.js';

const DRAFTED = 'Drafted by the assistant';
const EDITED = 'Edited by you';
const FALLBACK = {
  no_ai: 'Filled in from today’s records. No AI was used.',
  cap: 'This month’s assistant allowance is used, so this is the plain version from today’s records.',
  unavailable: 'The assistant could not be reached, so this is the plain version from today’s records.',
  facts: 'The assistant’s wording had a number or name that is not in your records, so this is the plain version from today’s records.',
};

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

/** The "Ready for you" section on Today. Hidden when there is nothing to approve (or the add-on is off). */
export async function readyCards(host) {
  let data;
  try { ({ data } = await get('/ai/proposals')); } catch (_) { host.hidden = true; return; }
  clear(host);
  host.hidden = !data.length;
  if (!data.length) return;
  const count = h('span', { class: 'ready-count' }, `${data.length} to approve`);
  const listEl = h('div', { class: 'ready-list' });
  const done = (card) => {
    card.remove();
    const left = listEl.children.length;
    count.textContent = `${left} to approve`;
    if (!left) host.hidden = true;
    window.dispatchEvent(new Event('ai:changed'));
  };
  for (const p of data) listEl.append(cardFor(p, done));
  host.append(h('section', { class: 'ready', id: 'ready', 'aria-labelledby': 'ready-h' },
    h('div', { class: 'ready-head' }, h('h2', { id: 'ready-h' }, 'Ready for you'), count),
    h('p', { class: 'muted ready-intro' }, 'The assistant prepared these. Nothing is published or sent until you approve.'), listEl));
}

/** The Inbox's line for drafts waiting, linking to them on Today. */
export async function inboxEntry(host) {
  let data;
  try { ({ data } = await get('/ai/proposals')); } catch (_) { host.hidden = true; return; }
  clear(host);
  host.hidden = !data.length;
  if (!data.length) return;
  host.append(h('a', { class: 'ready-inbox', href: '#/dashboard' },
    h('span', { class: 'ready-chip' }, 'Ready for you'),
    h('span', null, h('b', null, data.length === 1 ? '1 draft to approve' : `${data.length} drafts to approve`), h('small', null, data.map((p) => p.title).slice(0, 2).join(', '))),
    h('span', { class: 'ready-go', 'aria-hidden': 'true' }, '›')));
}

function cardFor(p, done) {
  return p.kind === 'conditions_update' ? conditionsCard(p, done) : genericCard(p, done);
}

function labelChip() { return h('span', { class: 'ready-chip' }, DRAFTED); }

function actions(p, card, collect, done, approvedText) {
  const approve = button('Approve', async () => {
    try {
      const r = await post(`/ai/proposals/${p.id}/approve`, collect ? { edits: collect() } : {});
      toast(approvedText(r.result || {}));
      done(card);
    } catch (err) {
      fail(err);
      // Gone from the list (approved by someone else, past its time, or approved but failed): take the card away.
      try { const { data } = await get('/ai/proposals'); if (!data.some((x) => x.id === p.id)) done(card); } catch (_) { /* keep it */ }
    }
  }, { kind: 'primary' });
  const notNow = button('Not now', async () => {
    try { await post(`/ai/proposals/${p.id}/reject`); toast('Set aside. Nothing was published or sent.'); done(card); } catch (err) { fail(err); }
  });
  return h('div', { class: 'ready-actions' }, approve, notNow);
}

function genericCard(p, done) {
  const card = h('article', { class: 'ready-card', 'aria-label': p.title });
  card.append(h('header', null, h('h3', null, p.title), labelChip()), p.summary ? h('p', null, p.summary) : null,
    actions(p, card, null, done, () => 'Approved'));
  return card;
}

// ---------------------------------------------------------------- the conditions writer's draft
function area(text, { rows = 3, max, label: lab, readonly = false }) {
  const id = nextId('rd');
  const el = h('textarea', { id, rows, maxlength: max || null, class: 'ready-text', readonly: readonly || null });
  el.value = text || '';
  // grows with its text, so the whole draft can be read without scrolling inside the box
  const fit = () => { if (!el.isConnected) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  el.addEventListener('input', fit);
  requestAnimationFrame(() => requestAnimationFrame(fit));
  return { el, id, field: (extra) => h('div', { class: 'ready-field' }, h('label', { for: id }, lab), el, extra || null) };
}

async function copyText(el, what) {
  try { await navigator.clipboard.writeText(el.value); toast(`${what} copied`); } catch (_) { el.select(); toast(`Select the ${what.toLowerCase()} and copy it`); }
}

function conditionsCard(p, done) {
  const v = p.preview || {};
  const card = h('article', { class: 'ready-card', 'aria-label': p.title });
  const chip = labelChip();
  const max = Object.fromEntries((p.editable || []).map((f) => [f.key, f.max]));
  const note = area(v.note, { rows: 3, max: max.note, label: 'Conditions page note (published on Approve)' });
  const report = area(v.snow_report, { rows: 5, max: max.snow_report, label: 'Snow report' });
  const social = area(v.social, { rows: 3, max: max.social, label: 'Social post' });
  const subject = h('input', { id: nextId('rd'), class: 'ready-input', maxlength: max.email_subject || 200, value: v.email_subject || '' });
  const body = area(v.email_body, { rows: 6, max: max.email_body, label: 'Email' });
  const counter = h('small', { class: 'muted', 'aria-live': 'polite' });
  const count = () => { counter.textContent = `${social.el.value.length} of 280 characters`; };
  count();
  const fields = { note: note.el, snow_report: report.el, social: social.el, email_subject: subject, email_body: body.el };
  const original = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
  const changed = () => Object.entries(fields).some(([k, el]) => el.value !== original[k]);
  for (const el of Object.values(fields)) el.addEventListener('input', () => { chip.textContent = changed() ? EDITED : DRAFTED; chip.classList.toggle('is-edited', changed()); if (el === social.el) count(); });

  const viewer = p.viewer || {};
  const sendBox = h('input', { type: 'checkbox', id: nextId('rd'), disabled: !viewer.can_email });
  const sendRow = h('label', { class: 'ready-check', for: sendBox.id }, sendBox,
    h('span', null, h('b', null, 'Also email passholders'), h('small', null, viewer.can_email
      ? `Goes to ${viewer.passholders === 1 ? '1 current season pass holder' : `${viewer.passholders ?? 'the'} current season pass holders`} who agreed to email, with a link to stop.`
      : `${String(viewer.email_blocked || 'Only managers send email to passholders').replace(/\.$/, '')}.`)));
  const emailBox = h('details', { class: 'ready-email' }, h('summary', null, 'Passholder email'),
    h('div', { class: 'ready-field' }, h('label', { for: subject.id }, 'Subject'), subject), body.field(), sendRow);

  const facts = v.facts || {};
  const fallback = v.by === 'template' ? FALLBACK[v.fallback] || FALLBACK.no_ai : null;
  card.append(
    h('header', null, h('div', null, h('h3', null, p.title), p.summary ? h('p', { class: 'ready-sum' }, p.summary) : null), chip),
    fallback ? h('p', { class: 'ready-fallback' }, fallback) : null,
    facts.status === 'closed' ? null : h('p', { class: 'muted small' }, `From your records: ${[facts.groomed ? `${facts.groomed} groomed` : null, 'lifts, trails, snow, weather and today’s calendar'].filter(Boolean).join(', ')}.`),
    note.field(),
    report.field(h('div', { class: 'ready-copy' }, button('Copy snow report', () => copyText(report.el, 'Snow report')))),
    social.field(h('div', { class: 'ready-copy' }, counter, button('Copy social post', () => copyText(social.el, 'Social post')))),
    emailBox,
    actions(p, card, () => {
      const edits = {};
      for (const [k, el] of Object.entries(fields)) if (el.value !== original[k]) edits[k] = el.value;
      if (sendBox.checked) edits.send_email = true;
      return edits;
    }, done, (r) => (r.emailed ? `Approved. The note is published and the email went to ${r.sent} ${r.sent === 1 ? 'passholder' : 'passholders'}.` : 'Approved. The note is published on your conditions page.')));
  return card;
}
