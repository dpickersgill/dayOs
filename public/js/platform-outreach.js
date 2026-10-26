// Outreach in the platform console: the mailbox and settings, first emails waiting for approval, every sequence and
// where it is, and the templates. Opened from Prospects. See src/lib/outreach.js for how the cadence works.

import { h, clear, button, field, input, select, dialog, formDialog, confirmDialog, toast, fail, empty, errorBox } from './ui.js';

export const OUTREACH_STATUS = { pending: 'First email waiting for approval', active: 'Emails going out', nurture: 'Quarterly updates', replied: 'Replied', bounced: 'Bounced', stopped: 'Stopped', not_interested: 'Not interested' };
const STEP_NAMES = { 1: 'Email 1', 2: 'Email 2', 3: 'Email 3', 4: 'Email 4', 5: 'Email 5', 6: 'Quarterly update' };
const when = (t) => (t ? new Date(String(t).replace(' ', 'T') + (/Z$/.test(String(t)) ? '' : 'Z')).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
let ctx = null;
let filter = 'open';

export function openOutreach(c) { ctx = c; draw(); }

async function draw() {
  const { app, call } = ctx;
  clear(app);
  const body = h('div', { class: 'stack' });
  app.append(h('main', { class: 'platform-box wider stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Outreach'), h('p', { class: 'muted' }, 'Emails to prospects from your own mailbox: you approve the first, the follow-ups go on their own until they reply, bounce or say not interested.')),
      h('div', { class: 'row' }, button('Back to prospects', () => ctx.backToProspects(), { small: true }), button('Settings', () => settingsDialog(r), { small: true }), button('Templates', () => templatesDialog(r), { small: true }), button('Send due now', () => runNow(), { small: true }))),
    body));
  let r;
  try { r = await call('GET', '/outreach'); } catch (ex) { if (ex.status === 403) ctx.signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
  const s = r.settings;
  const needs = [
    !r.mailbox.ready ? 'The mailbox is not connected: set OUTREACH_GMAIL_KEY and OUTREACH_SENDER on the service (see the setup notes).' : null,
    !r.mailbox.link_base ? 'APP_URL is not set, so emails would have no working opt-out link.' : null,
    !s.sender_name || !s.postal_address ? 'Fill in your name and postal address under Settings. Every email needs them.' : null,
  ].filter(Boolean);
  body.append(h('section', { class: 'panel stack' },
    h('p', null, r.mailbox.ready ? `Sending as ${r.mailbox.sender}` : 'Mailbox not connected', s.paused ? h('b', null, ' (paused)') : null,
      `. Weekdays ${s.send_from_hour}:00 to ${s.send_to_hour}:00 (${s.timezone}), up to ${s.daily_cap} a day; ${r.sent_last_day} sent in the last 24 hours. Emails on days ${s.offsets.join(', ')}, then an update every ${s.nurture_days} days. ${r.suppressed} address${r.suppressed === 1 ? '' : 'es'} on the do-not-email list.`),
    ...needs.map((n) => h('div', { class: 'error-box', role: 'alert' }, n)),
    r.mailbox.ready ? h('div', { class: 'row' }, button('Send a test to me', () => testDialog(), { small: true })) : null));

  // ---- first emails waiting for approval
  body.append(h('h2', null, `Waiting for your approval (${r.drafts.length})`));
  if (!r.drafts.length) body.append(empty('Nothing to approve. Start outreach from a person on a prospect (People, Start outreach).'));
  for (const d of r.drafts) {
    const subject = input({ maxlength: 200, value: d.subject, 'aria-label': 'Subject' });
    const text = h('textarea', { rows: 10, maxlength: 4000, 'aria-label': 'Email' }, d.body);
    const save = async () => call('PATCH', `/outreach/messages/${d.id}`, { subject: subject.value.trim(), body: text.value.trim() });
    body.append(h('section', { class: 'panel stack' },
      h('div', { class: 'row between' }, h('div', null, h('b', null, `${d.person || d.email}, ${d.mountain}`), h('div', { class: 'small muted' }, `${d.title ? `${d.title}. ` : ''}${d.email}. ${d.drafted_by === 'assistant' ? 'Drafted for them by the assistant.' : d.drafted_by === 'operator' ? 'Edited by you.' : 'From the template.'}`))),
      field('Subject', subject), field('Email', text, 'The footer with your name, postal address and the "not interested" link is added when it is sent.'),
      h('div', { class: 'row' },
        button('Approve and send', async () => { try { await save(); await call('POST', `/outreach/messages/${d.id}/approve`); toast('Approved. It goes in the next sending window, and the follow-ups follow on their own.'); draw(); } catch (ex) { fail(ex); } }, { kind: 'primary', small: true }),
        button('Save', async () => { try { await save(); toast('Saved.'); } catch (ex) { fail(ex); } }, { small: true }),
        r.assistant ? button('Draft again', async () => { try { const x = await call('POST', `/outreach/messages/${d.id}/redraft`); subject.value = x.subject; text.value = x.body; toast('Drafted again.'); } catch (ex) { fail(ex); } }, { small: true }) : null,
        button('Don\'t send', () => confirmDialog('Stop this outreach?', `Nothing is sent to ${d.email}.`, 'Stop', async () => { await call('POST', `/outreach/sequences/${d.sequence_id}/stop`); toast('Stopped.'); draw(); }), { small: true }))));
  }

  // ---- every sequence
  const pick = select([['open', 'Going'], ['done', 'Finished'], ['all', 'Everything']], filter, { 'aria-label': 'Show', style: 'width:auto' });
  pick.addEventListener('change', () => { filter = pick.value; draw(); });
  const OPEN = ['pending', 'active', 'nurture'];
  const list = r.sequences.filter((x) => (filter === 'all' ? true : filter === 'open' ? OPEN.includes(x.status) : !OPEN.includes(x.status)));
  body.append(h('div', { class: 'row between' }, h('h2', null, 'Sequences'), pick));
  body.append(list.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'rt' },
    h('thead', null, h('tr', null, ['Who', 'Status', 'Sent', 'Next', ''].map((x) => h('th', null, x)))),
    h('tbody', null, list.map((x) => h('tr', null,
      h('td', { 'data-label': 'Who' }, h('b', null, x.person || x.email), h('div', { class: 'small muted' }, `${x.mountain}${x.state ? `, ${x.state}` : ''}`)),
      h('td', { 'data-label': 'Status' }, OUTREACH_STATUS[x.status] || x.status, x.stop_reason && !OPEN.includes(x.status) ? h('div', { class: 'small muted' }, x.stop_reason) : null, x.last_error ? h('div', { class: 'small error-text' }, x.last_error) : null),
      h('td', { 'data-label': 'Sent', class: 'num' }, String(x.sent)),
      h('td', { 'data-label': 'Next' }, OPEN.includes(x.status) && x.next_at ? when(x.next_at) : ''),
      h('td', { class: 'actions' }, h('div', { class: 'row' }, button('Open', () => sequenceDialog(x.id), { small: true }), OPEN.includes(x.status) ? button('Stop', () => confirmDialog('Stop this outreach?', `No more emails go to ${x.email}. They can still be started again later.`, 'Stop', async () => { await call('POST', `/outreach/sequences/${x.id}/stop`); toast('Stopped.'); draw(); }), { small: true }) : null))))))) : empty('Nothing here.'));
}

async function runNow() {
  try {
    const out = await ctx.call('POST', '/outreach/run', {});
    toast(out.skipped ? out.skipped : `Sent ${out.sent}${out.failed ? `, ${out.failed} failed` : ''}${out.stopped ? `, ${out.stopped} stopped (replies or bounces)` : ''}.`, out.failed ? 'error' : 'ok');
    draw();
  } catch (ex) { fail(ex); }
}

function testDialog() {
  const to = input({ type: 'email', required: true, maxlength: 200 });
  formDialog('Send a test email', [field('Send it to', to, 'Your own address. It shows the footer every email carries.')], async () => {
    await ctx.call('POST', '/outreach/test', { to: to.value.trim() });
    toast('Sent. Check that inbox.');
  }, { submitText: 'Send' });
}

function settingsDialog(r) {
  const s = r.settings;
  const name = input({ maxlength: 100, value: s.sender_name || '', required: true });
  const company = input({ maxlength: 150, value: s.company_line || 'Verdynt/OS, operations software for ski areas' });
  const address = input({ maxlength: 300, value: s.postal_address || '', required: true, placeholder: 'Street, town, state and ZIP' });
  const cap = input({ type: 'number', min: 1, max: 200, value: s.daily_cap });
  const from = input({ type: 'number', min: 0, max: 23, value: s.send_from_hour });
  const to = input({ type: 'number', min: 1, max: 24, value: s.send_to_hour });
  const tz = select(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage'].map((z) => [z, z.replace('America/', '').replace('_', ' ')]), s.timezone);
  const days = input({ value: s.offsets.join(', '), 'aria-label': 'Days' });
  const nurture = input({ type: 'number', min: 14, max: 365, value: s.nurture_days });
  const ai = input({ type: 'checkbox', checked: s.use_ai });
  const paused = input({ type: 'checkbox', checked: s.paused });
  formDialog('Outreach settings', [
    field('Your name, as it shows in the inbox', name), field('Company line', company), field('Postal address', address, 'Required in every commercial email (CAN-SPAM). A registered P.O. box or private mailbox works.'),
    h('div', { class: 'row wrap' }, field('Emails a day, at most', cap), field('Send from (hour)', from), field('Until (hour)', to), field('Time zone', tz)),
    h('div', { class: 'row wrap' }, field('Days the five emails go', days, 'Day 0 is the first'), field('Then an update every (days)', nurture)),
    h('label', { class: 'check' }, ai, ' Let the assistant draft each first email for the person and mountain (you still approve it)'),
    h('label', { class: 'check' }, paused, ' Pause all sending'),
  ], async () => {
    const offsets = days.value.split(/[,\s]+/).filter(Boolean).map(Number);
    await ctx.call('PUT', '/outreach/settings', { sender_name: name.value.trim(), company_line: company.value.trim() || null, postal_address: address.value.trim(), daily_cap: Number(cap.value), send_from_hour: Number(from.value), send_to_hour: Number(to.value), timezone: tz.value, offsets, nurture_days: Number(nurture.value), use_ai: ai.checked, paused: paused.checked });
    toast('Saved.'); draw();
  }, { wide: true });
}

function templatesDialog(r) {
  const box = h('div', { class: 'stack' });
  for (const t of r.templates) {
    box.append(h('section', { class: 'panel stack' }, h('div', { class: 'row between' }, h('h3', null, `${STEP_NAMES[t.step]}${t.step <= 5 ? `, day ${r.settings.offsets[t.step - 1]}` : ''}`), button('Edit', () => editTemplate(r, t), { small: true })),
      h('p', null, h('b', null, t.subject)), h('p', { class: 'small', style: 'white-space:pre-wrap' }, t.body)));
  }
  dialog('Templates', h('div', { class: 'stack' }, h('p', { class: 'muted small' }, `Fields: ${r.fields.map((f) => `{${f}}`).join(', ')}. Emails 2 to 5 are replies in the same thread as email 1. The first email can be drafted by the assistant instead; you approve it either way.`), box), { wide: true });
}

function editTemplate(r, t) {
  const subject = input({ maxlength: 200, value: t.subject, required: true });
  const text = h('textarea', { rows: 12, maxlength: 4000 }, t.body);
  formDialog(`Edit ${STEP_NAMES[t.step]}`, [field('Subject', subject), field('Email', text, `Fields: ${r.fields.map((f) => `{${f}}`).join(', ')}`)], async () => {
    await ctx.call('PUT', `/outreach/templates/${t.step}`, { subject: subject.value.trim(), body: text.value.trim() });
    toast('Saved.'); draw();
  }, { wide: true });
}

async function sequenceDialog(id) {
  let x;
  try { x = await ctx.call('GET', `/outreach/sequences/${id}`); } catch (ex) { fail(ex); return; }
  const msg = (m, label) => h('section', { class: 'panel stack' }, h('div', { class: 'row between' }, h('b', null, label), h('span', { class: 'small muted' }, m.sent_at ? `Sent ${when(m.sent_at)}` : m.status === 'draft' ? 'Draft' : m.status === 'approved' ? 'Approved, waiting for the sending window' : m.status)),
    h('p', null, h('b', null, m.subject)), h('p', { class: 'small', style: 'white-space:pre-wrap' }, m.body), m.error ? h('p', { class: 'small error-text' }, m.error) : null);
  dialog(`${x.person || x.email}, ${x.mountain}`, h('div', { class: 'stack' },
    h('p', null, `${OUTREACH_STATUS[x.status] || x.status}. ${x.email}.${x.stop_reason ? ` ${x.stop_reason}.` : ''}`),
    ...x.messages.map((m) => msg(m, STEP_NAMES[m.step])),
    ...(x.status === 'active' || x.status === 'pending' ? x.upcoming.map((u) => msg({ ...u, status: `Day ${u.day}, if they have not replied` }, `${STEP_NAMES[u.step]} (coming)`)) : []),
    h('details', null, h('summary', null, 'The footer on every email'), h('p', { class: 'small', style: 'white-space:pre-wrap' }, x.footer))), { wide: true });
}
