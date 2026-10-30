// The Good Day in the platform console: who subscribed (confirmed, waiting to confirm, unsubscribed), a spreadsheet of
// them with their consent, and sending an issue: preview, a test to yourself, then every confirmed subscriber.
// Opened from the Mountains page; uses the console's own session (passed in). See src/lib/goodday.js.

import { h, clear, button, field, input, select, table, dialog, formDialog, toast, fail, empty, errorBox } from './ui.js';

let ctx = null; // { app, call, session(), back(), signIn() }
const query = { status: 'confirmed', q: '' };
const STATUS = [['confirmed', 'Confirmed'], ['pending', 'Waiting to confirm'], ['unsubscribed', 'Unsubscribed'], ['', 'Everyone']];
const when = (t) => (t ? new Date(String(t).replace(' ', 'T') + (/Z$/.test(String(t)) ? '' : 'Z')).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const day = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const off = (b, yes) => { b.disabled = Boolean(yes); return b; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function openGoodDay(c) { ctx = c; draw(); }

async function draw() {
  const { app, call } = ctx;
  clear(app);
  const body = h('div', { class: 'stack' });
  app.append(h('main', { class: 'platform-box wider stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Newsletter'), h('p', { class: 'muted' }, 'The Good Day: who subscribed on the website, and sending an issue. Only operators see this.')),
      h('div', { class: 'row' }, button('Back to mountains', () => ctx.back(), { small: true }), button('Sender and address', () => settingsDialog(r), { small: true }), button('Download spreadsheet', () => download().catch(fail), { small: true }))),
    body));
  let r;
  try { r = await call('GET', '/goodday'); } catch (ex) { if (ex.status === 403) ctx.signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
  const c = r.counts;
  const needs = [
    !r.email_on ? 'Email is not set up on the service (POSTMARK_SERVER_TOKEN and MAIL_FROM), so nothing can be sent.' : null,
    !r.settings.postal_address ? 'Add your postal address under Sender and address. Every issue must carry it (CAN-SPAM).' : null,
  ].filter(Boolean);
  body.append(h('section', { class: 'panel stack' },
    h('div', { class: 'row wrap' },
      ...[['confirmed', `${c.confirmed} confirmed`], ['pending', `${c.pending} waiting to confirm`], ['unsubscribed', `${c.unsubscribed} unsubscribed`]].map(([k, t]) => button(t, () => { query.status = k; drawList(); }, { small: true, kind: k === 'confirmed' ? 'primary' : undefined }))),
    h('p', { class: 'muted small' }, `Confirmed, by role: ${Object.entries(r.roles).map(([k, t]) => `${t} ${c.roles[k] || 0}`).join(', ')}. Sign-ups come from the card on the website (${r.site}/good-day) and confirm by email link.`),
    ...needs.map((n) => h('div', { class: 'error-box', role: 'alert' }, n))));

  // ---- send an issue
  body.append(h('h2', null, 'Send an issue'));
  if (!r.issues.length) body.append(empty('No issues yet. Add src/site/good-day/issue-N.html and its line in issues.json.'));
  else body.append(sendPanel(r));

  // ---- subscribers
  body.append(h('h2', null, 'Subscribers'));
  const search = input({ type: 'search', placeholder: 'Find an email or name', 'aria-label': 'Find an email or name', value: query.q });
  const statusSel = select(STATUS, query.status, { 'aria-label': 'Which subscribers' });
  const list = h('div', { class: 'stack' });
  body.append(h('div', { class: 'row wrap' }, statusSel, search), list);
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query.q = search.value.trim(); drawList(); }, 250); });
  statusSel.addEventListener('change', () => { query.status = statusSel.value; drawList(); });
  async function drawList() {
    statusSel.value = query.status;
    clear(list).append(h('p', { class: 'loading' }, 'Loading…'));
    let d;
    try { d = await call('GET', `/goodday/subscribers?${new URLSearchParams(query)}`); } catch (ex) { clear(list).append(errorBox(ex)); return; }
    clear(list).append(d.data.length ? table([
      { head: 'Email', cell: (s) => h('span', null, h('b', null, s.email), s.name ? h('div', { class: 'small' }, s.name) : null) },
      { head: 'Role', cell: (s) => r.roles[s.role] || s.role },
      { head: 'Status', cell: (s) => (s.status === 'confirmed' ? `Confirmed ${when(s.confirmed_at)}` : s.status === 'pending' ? `Waiting since ${when(s.consent_at)}` : `Unsubscribed ${when(s.unsubscribed_at)}${s.unsubscribe_how === 'one-click' ? ' (mail app button)' : ''}`) },
      { head: 'Signed up', cell: (s) => h('span', { class: 'small' }, `${when(s.consent_at)} on ${s.source || 'the website'}`) },
    ], d.data) : empty(query.q ? 'No one matches that.' : 'No one here yet.'));
  }
  drawList();
}

function sendPanel(r) {
  const { call } = ctx;
  const issueSel = select(r.issues.map((i) => [String(i.n), `Issue ${i.n}: ${i.question}`]), String(r.issues[0].n), { name: 'issue' });
  const pick = () => r.issues.find((i) => String(i.n) === issueSel.value);
  const subject = input({ name: 'subject', maxlength: 200, value: pick().default_subject });
  const intro = h('textarea', { name: 'intro', rows: 4, maxlength: 1000, placeholder: 'Optional. Two or three sentences above the three lines, in your voice.' });
  const status = h('div', { class: 'stack tight' });
  const payload = () => ({ n: Number(issueSel.value), subject: subject.value.trim(), intro: intro.value.trim() });
  const drawStatus = () => {
    const i = pick();
    clear(status).append(
      h('p', null, h('b', null, `Issue ${i.n}, ${i.moment}, ${day(i.date)}. `), i.sent ? `Sent to ${plural(i.sent, 'subscriber', 'subscribers')}. ` : 'Not sent yet. ',
        i.failed ? `${i.failed} failed (Send again tries them again). ` : '', i.sending ? `${i.sending} were being sent when the service stopped; they are not sent again. ` : '',
        `${plural(i.waiting, 'confirmed subscriber has', 'confirmed subscribers have')} not had it.`),
      i.history.length ? h('ul', { class: 'small muted' }, ...i.history.map((x) => h('li', null, `${when(x.created_at)}: ${x.started_by || 'someone'} sent "${x.subject}": ${x.sent} sent, ${x.failed} failed${x.left_over ? `, ${x.left_over} left` : ''}.`))) : null);
  };
  issueSel.addEventListener('change', () => { subject.value = pick().default_subject; drawStatus(); });
  drawStatus();

  const preview = async () => {
    const m = await call('POST', '/goodday/preview', payload());
    const frame = h('iframe', { title: 'Email preview', sandbox: '', style: 'width:100%;height:70vh;border:1px solid var(--line, #ccc);border-radius:8px;background:#fff' });
    frame.srcdoc = m.html;
    dialog(`Preview: ${m.subject}`, h('div', { class: 'stack' }, frame, h('details', null, h('summary', null, 'The plain-text version'), h('pre', { style: 'white-space:pre-wrap' }, m.text))), { wide: true });
  };
  const test = () => {
    const to = input({ type: 'email', name: 'to', required: true, value: r.my_email || '', autocomplete: 'email' });
    formDialog('Send a test', h('div', { class: 'stack' }, h('p', null, 'The issue email goes to this one address, with [Test] in the subject. Its unsubscribe link does nothing.'), field('Send to', to)), async () => {
      await call('POST', '/goodday/test', { ...payload(), to: to.value.trim() });
      toast(`Test sent to ${to.value.trim()}.`);
    }, { submitText: 'Send test' });
    to.focus();
  };
  const sendAll = () => {
    const i = pick();
    const confirm = input({ name: 'confirm', autocomplete: 'off', required: true, placeholder: `issue-${i.n}` });
    formDialog(`Send Issue ${i.n} to everyone?`, h('div', { class: 'stack' },
      h('p', null, `It goes now to ${plural(i.waiting, 'confirmed subscriber', 'confirmed subscribers')} who have not had it, with the subject "${subject.value.trim() || i.default_subject}". No one gets it twice, and no one waiting to confirm or unsubscribed gets it.`),
      field(`Type issue-${i.n} to confirm`, confirm)), async () => {
      const out = await call('POST', '/goodday/send', { ...payload(), confirm: confirm.value.trim() });
      toast(`Sent to ${out.sent}.${out.failed ? ` ${out.failed} failed: press Send again to try them again.` : ''}${out.left ? ` ${out.left} still to go: press Send again.` : ''}`);
      draw();
    }, { submitText: `Send Issue ${i.n}` });
    confirm.focus();
  };
  const ready = r.email_on && r.settings.postal_address;
  return h('section', { class: 'panel stack' },
    h('div', { class: 'form' }, field('Issue', issueSel), field('Subject', subject, 'What subscribers see in their inbox.'), field('A short intro', intro, 'Optional. The email shows the question, this intro, the issue\'s three lines and a "Read Issue" button.')),
    status,
    h('div', { class: 'row wrap' }, button('Preview', () => preview().catch(fail), { small: true }), off(button('Send a test to me', test, { small: true }), !r.email_on),
      off(button(`Send to all confirmed (${pick().waiting})`, sendAll, { kind: 'primary' }), !ready || !pick().waiting)));
}

function settingsDialog(r) {
  if (!r) return;
  const name = input({ name: 'from_name', required: true, maxlength: 100, value: r.settings.from_name || '' });
  const postal = input({ name: 'postal_address', required: true, maxlength: 300, value: r.settings.postal_address || '', placeholder: 'Street, town, state and ZIP, or a PO box' });
  formDialog('Sender and address', h('div', { class: 'stack' }, field('From name', name, 'For example: Dan at The Good Day. The address is the service\'s MAIL_FROM (or GOODDAY_FROM).'),
    field('Postal address', postal, 'Required at the bottom of every issue (CAN-SPAM). A PO box works.')), async () => {
    await ctx.call('PUT', '/goodday/settings', { from_name: name.value.trim(), postal_address: postal.value.trim() });
    toast('Saved.'); draw();
  });
}

async function download() {
  const res = await fetch(`/api/v1/platform/goodday/subscribers.csv?${new URLSearchParams({ status: query.status })}`, { headers: { 'x-platform-session': ctx.session() } });
  if (!res.ok) { let m = 'Could not download'; try { m = (await res.json()).error || m; } catch (_) { /* not JSON */ } throw new Error(m); }
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `good-day-subscribers-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}
