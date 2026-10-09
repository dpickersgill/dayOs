// Messages (managers): write an email or text, see who it would reach, send a test, send it, and read what happened.
// Only people who agreed (their consent history) are ever reached, and every message carries a way to stop.
import { get, post, put, del } from '../api.js';
import { h, clear, table, state, input, select, field, button, toast, fail, formDialog, confirmDialog, dialog, tabs, fmtDateTime, empty, errorBox } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Messages')),
    tabs([['sent', 'Messages', list], ['auto', 'Automatic reminders', auto]], 'sent'));
}

const CHANNELS = [['email', 'Email'], ['sms', 'Text message']];

async function list(box) {
  const status = await get('/messages/status');
  const body = h('div');
  const add = button('New message', () => editor(null, status, load), { kind: 'primary' });
  box.append(h('div', { class: 'row' }, add), setupNote(status), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get('/messages/campaigns');
      clear(body).append(data.length ? table([
        { head: 'Message', cell: (c) => h('strong', null, c.name) },
        { head: 'Kind', cell: (c) => (c.channel === 'sms' ? 'Text' : 'Email') },
        { head: 'To', cell: (c) => (status.audiences.find((a) => a.key === c.audience) || {}).label || c.audience },
        { head: 'Status', cell: (c) => state(c.status === 'sent' ? 'Sent' : c.status === 'sending' ? 'Sending' : 'Draft', c.status === 'sent' ? 'good' : 'warn') },
        { head: 'Reached', num: true, cell: (c) => (c.status === 'sent' ? `${c.sent} of ${c.total}` : '') },
        { head: 'When', cell: (c) => (c.sent_at ? fmtDateTime(c.sent_at) : '') },
        { head: '', actions: true, cell: (c) => button('Open', () => (c.status === 'draft' ? editor(c.id, status, load) : detail(c.id)), { small: true }) },
      ], data) : empty('No messages yet. Write one to tell customers who agreed to hear from you about opening day, new snow or a pass sale.'));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  await load();
}

function setupNote(status) {
  const missing = [!status.email_ready && 'email', !status.sms_ready && 'text messages'].filter(Boolean);
  if (!missing.length) return null;
  return h('p', { class: 'muted' }, `Not set up yet: ${missing.join(' and ')}. You can write drafts now. Sending starts once the account is connected (see Help, "Set up email and text messages").`);
}

/** The editor, for a new message or a saved draft. */
async function editor(id, status, done) {
  const c = id ? await get(`/messages/campaigns/${id}`) : { name: '', channel: 'email', audience: 'all', subject: '', body: '' };
  const name = input({ name: 'name', value: c.name, maxlength: 120, required: true, placeholder: 'For example: Opening day' });
  const channel = select(CHANNELS, c.channel, { name: 'channel' });
  const audience = select(status.audiences.map((a) => [a.key, a.label]), c.audience, { name: 'audience' });
  const subject = input({ name: 'subject', value: c.subject || '', maxlength: 200, placeholder: 'What they see in their inbox' });
  const bodyBox = h('textarea', { name: 'body', rows: 8, maxlength: 2000, required: true }, c.body || '');
  const reach = h('p', { class: 'muted', 'aria-live': 'polite' }, '');
  const subjectField = field('Subject', subject);
  const counter = h('small', { class: 'muted' });
  const syncChannel = () => { subjectField.hidden = channel.value === 'sms'; counter.textContent = channel.value === 'sms' ? `${bodyBox.value.length} of 320 characters. We add the mountain name and how to stop.` : 'Use {first_name} and {mountain} to personalise. We add the unsubscribe link.'; };
  async function count() {
    syncChannel();
    try {
      const r = await post('/messages/preview', { channel: channel.value, audience: audience.value });
      reach.textContent = r.count ? `This would reach ${r.count} ${r.count === 1 ? 'person' : 'people'}${r.more_than_limit ? ` (the first ${status.max_recipients}; send the rest in another message)` : ''}${r.sample.length ? `, for example ${r.sample.join(', ')}` : ''}.` : 'No one would receive this yet. Only customers who agreed are included.';
    } catch (_) { reach.textContent = ''; }
  }
  channel.addEventListener('change', count); audience.addEventListener('change', count); bodyBox.addEventListener('input', syncChannel);
  const fields = h('div', { class: 'stack' }, field('Name (only you see it)', name), field('Kind', channel), field('Send to', audience), reach, subjectField, field('Message', bodyBox), counter);
  count();
  const payload = () => ({ name: name.value.trim(), channel: channel.value, audience: audience.value, subject: channel.value === 'email' ? subject.value.trim() : null, body: bodyBox.value.trim() });
  const save = async () => (id ? put(`/messages/campaigns/${id}`, payload()) : post('/messages/campaigns', payload()));
  formDialog(id ? 'Edit message' : 'New message', fields, async () => { await save(); toast('Saved'); await done(); }, { submitText: 'Save draft', wide: true });
  // Test and send sit beside Save.
  const extra = h('div', { class: 'row' },
    button('Send me a test', async () => {
      try {
        const saved = await save(); id = saved.id;
        let phone;
        if (channel.value === 'sms') { phone = window.prompt('Phone number for the test text'); if (!phone) return; }
        const r = await post(`/messages/campaigns/${id}/test`, { phone });
        toast(`Test sent to ${r.to}`);
      } catch (e) { fail(e); }
    }, { small: true }),
    button('Send now', async () => {
      try {
        const saved = await save(); id = saved.id;
        const r = await post('/messages/preview', { channel: channel.value, audience: audience.value });
        if (!r.count) { toast('No one would receive this yet', 'error'); return; }
        confirmDialog('Send this message?', `It goes to ${r.count} ${r.count === 1 ? 'person' : 'people'} who agreed to hear from you. You cannot take it back.`, 'Send', async () => {
          const out = await post(`/messages/campaigns/${id}/send`, { confirm: true });
          toast(`Sent to ${out.sent} of ${out.total}`);
          document.querySelectorAll('.overlay').forEach((o) => { const b = o.querySelector('button[aria-label="Close"]'); if (b) b.click(); });
          await done();
        });
      } catch (e) { fail(e); }
    }, { small: true, kind: 'primary' }));
  fields.append(extra);
  if (id) fields.append(button('Delete draft', () => confirmDialog('Delete this draft?', 'This cannot be undone.', 'Delete', async () => { await del(`/messages/campaigns/${id}`); toast('Deleted'); await done(); }, { danger: true }), { small: true }));
}

async function detail(id) {
  const c = await get(`/messages/campaigns/${id}`);
  dialog(c.name, h('div', { class: 'stack' },
    h('p', null, `${c.channel === 'sms' ? 'Text message' : 'Email'} sent ${fmtDateTime(c.sent_at)}. Reached ${c.sent} of ${c.total}${c.failed ? `; ${c.failed} could not be delivered` : ''}.`),
    c.subject ? h('p', null, h('strong', null, 'Subject: '), c.subject) : null,
    h('pre', { class: 'msg-body' }, c.body),
    c.problems.length ? h('div', null, h('h3', null, 'Could not be delivered'), h('ul', { class: 'plain' }, c.problems.map((p) => h('li', null, `${p.to_addr}: ${p.error}`)))) : null), { wide: true });
}

async function auto(box) {
  const s = await get('/messages/status');
  box.append(h('div', { class: 'stack' },
    h('p', null, 'These go out by themselves once a day, to the email address on file. They are notes about the customer’s own rental or pass, so they do not need marketing consent, and nobody gets the same one twice.'),
    h('ul', { class: 'plain' },
      h('li', null, h('strong', null, 'Rental overdue. '), 'An hour after gear was due back and has not been returned.'),
      h('li', null, h('strong', null, 'Season pass ending. '), 'Fourteen days before a pass ends, with how to renew.')),
    s.email_ready ? state('Email is connected', 'good') : state('Email is not connected yet', 'warn'),
    h('p', { class: 'muted' }, 'Reminders use the same daily schedule as patrol follow-ups. Demo mountains never send.')));
}
