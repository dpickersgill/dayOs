// The follow-up desk (patrol directors and managers): who will be emailed and when, the ones waiting for a decision, how guests
// rated us, and gifts received. Nothing here shows what happened to a guest, only the case number and a first name.

import { get, post, put } from '../api.js';
import { h, clear, state, input, select, field, button, toast, fmtDate, fmtDateTime, money, label, empty, errorBox, fail } from '../ui.js';

const tone = { held: 'warn', queued: 'neutral', sent: 'good', skipped: 'neutral', failed: 'bad', unsubscribed: 'neutral' };
const words = { held: 'Needs a decision', queued: 'Will send', sent: 'Sent', skipped: 'Skipped', failed: 'Failed', unsubscribed: 'Stopped by guest' };
const mask = (e) => { const [a, d] = String(e).split('@'); return `${a.slice(0, 2)}${'•'.repeat(Math.max(1, a.length - 2))}@${d}`; };
const fig = (name, value) => h('div', { class: 'figure' }, h('strong', null, String(value)), h('span', null, name));

export async function drawFollowup(box) {
  const [settings, sum] = await Promise.all([get('/patrol/followup-settings'), get('/patrol/followup-summary')]);
  const list = h('div');
  const filter = select([['', 'All'], ['held', 'Needs a decision'], ['queued', 'Will send'], ['sent', 'Sent'], ['failed', 'Failed'], ['skipped', 'Skipped'], ['unsubscribed', 'Stopped by guest']], '', { 'aria-label': 'Show' });

  async function loadList() {
    clear(list).append(h('p', { class: 'loading' }, 'Loading…'));
    try {
      const { data } = await get(`/patrol/followups${filter.value ? `?status=${filter.value}` : ''}`);
      clear(list).append(data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Case', 'Guest', 'Sends to', 'Due', 'Status', 'Rating', ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, data.map((f) => h('tr', { 'data-followup': f.id },
          h('td', null, h('a', { href: `#/patrol/case/${f.incident_id}` }, f.case_number || `#${f.incident_id}`)), h('td', null, f.first_name === 'Unknown' ? '' : f.first_name),
          h('td', null, mask(f.to_email), f.for_guardian ? h('span', { class: 'muted small' }, ' (guardian)') : null), h('td', null, fmtDate(f.due_on)),
          h('td', null, state(words[f.status], tone[f.status]), f.hold_reason ? h('div', { class: 'muted small' }, f.hold_reason) : null, f.error ? h('div', { class: 'muted small' }, f.error) : null),
          h('td', null, f.rating ? `${f.rating} of 5` : ''),
          h('td', { class: 'actions' }, ['held', 'queued', 'failed'].includes(f.status) ? h('div', { class: 'row' },
            f.status === 'held' ? button('Approve', async () => { await post(`/patrol/followups/${f.id}/approve`, {}); toast('Approved. It sends with the next daily run.'); await loadList(); }, { small: true, kind: 'primary' }) : null,
            button('Send now', async () => { const r = await post(`/patrol/followups/${f.id}/send`, {}); toast(r.status === 'sent' ? 'Sent' : `Not sent: ${label(r.status)}`, r.status === 'sent' ? 'ok' : 'error'); await loadList(); }, { small: true }),
            button('Skip', async () => { await post(`/patrol/followups/${f.id}/skip`, {}); await loadList(); }, { small: true })) : null))))))
        : empty('Nothing here yet. Follow-ups appear five days after an approved case, when the guest has an email address.'));
    } catch (err) { clear(list).append(errorBox(err)); }
  }
  filter.addEventListener('change', loadList);

  const on = h('input', { type: 'checkbox', name: 'followup_enabled', checked: settings.followup_enabled });
  const form = h('form', { class: 'stack', novalidate: true },
    h('label', { class: 'check' }, on, ' Send follow-up emails five days after a case'),
    h('div', { class: 'form' },
      field('Days after the incident', input({ name: 'followup_days', type: 'number', min: 1, max: 30, value: settings.followup_days })),
      field('Name shown on the email', input({ name: 'patrol_org_name', maxlength: 150, value: settings.patrol_org_name || '', placeholder: `${settings.name} Ski Patrol` })),
      field('Replies go to', input({ name: 'reply_to', type: 'email', maxlength: 255, value: settings.reply_to || '' }), 'An address a person reads'),
      field('Suggested gift amounts, in dollars', input({ name: 'donate_amounts', maxlength: 60, value: settings.donate_amounts }), 'Up to six, separated by commas'),
      h('div', { class: 'wide' }, field('Mailing address for the email footer', input({ name: 'mail_address', maxlength: 300, value: settings.mail_address || '' }), 'The law requires a real postal address on email you send')),
      h('div', { class: 'wide' }, field('A line about what gifts pay for', h('textarea', { name: 'donate_blurb', rows: 2, maxlength: 600 }, settings.donate_blurb || ''), 'For example: Gifts buy toboggans, oxygen and training.')),
      h('div', { class: 'wide' }, field('Tax note, if your organization can issue receipts', h('textarea', { name: 'tax_note', rows: 2, maxlength: 500 }, settings.tax_note || ''), 'Leave blank unless the organization receiving gifts is a registered nonprofit. Ask your board or accountant for the exact wording.'))),
    h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save settings')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (n) => { const x = form.querySelector(`[name=${n}]`).value.trim(); return x === '' ? null : x; };
    try {
      await put('/patrol/followup-settings', { followup_enabled: on.checked, followup_days: Number(v('followup_days')) || 5, patrol_org_name: v('patrol_org_name'), reply_to: v('reply_to'), donate_amounts: v('donate_amounts') || '25,50,100,250', mail_address: v('mail_address'), donate_blurb: v('donate_blurb'), tax_note: v('tax_note') });
      toast('Settings saved');
    } catch (err) { fail(err); }
  });

  const slug = settings.slug;
  clear(box).append(h('div', { class: 'stack', 'data-followup-desk': '' },
    h('div', { class: 'row' },
      state(settings.email_ready ? 'Email (Postmark) is set up' : 'Email (Postmark) is not set up yet', settings.email_ready ? 'good' : 'warn'),
      state(settings.card_ready ? 'Online giving is set up' : 'Online giving needs the Stripe keys', settings.card_ready ? 'good' : 'warn'),
      state(settings.followup_enabled ? 'Follow-up is ON' : 'Follow-up is off', settings.followup_enabled ? 'good' : 'neutral')),
    h('div', { class: 'figures' },
      fig('Sent', sum.by_status.sent || 0), fig('Need a decision', sum.by_status.held || 0), fig('Will send', sum.by_status.queued || 0),
      fig('Guest rating', sum.rated ? `${sum.avg_rating} of 5 (${sum.rated})` : 'None yet'), fig('Gifts', sum.gifts ? `${money(sum.total_cents)} (${sum.gifts})` : 'None yet')),
    h('details', { class: 'panel more', open: !settings.followup_enabled }, h('summary', null, h('b', null, 'Settings')), form),
    h('section', { class: 'panel stack' }, h('div', { class: 'spread' }, h('h2', null, 'Follow-up emails'), h('label', { class: 'inline' }, 'Show ', filter)),
      h('p', { class: 'muted small' }, 'Cases that went to an ambulance, and serious or critical cases, wait here for a director. Minors are emailed at their parent or guardian\'s address. The email never says what happened.'), list),
    sum.comments.length ? h('section', { class: 'panel stack' }, h('h2', null, 'What guests said'), h('ul', { class: 'plain' }, sum.comments.map((c) => h('li', null, h('b', null, `${c.rating} of 5 `), c.comment, h('span', { class: 'muted small' }, ` ${fmtDateTime(c.responded_at)}`))))) : null,
    sum.recent_gifts.length ? h('section', { class: 'panel stack' }, h('h2', null, 'Recent gifts'), h('ul', { class: 'plain' }, sum.recent_gifts.map((g) => h('li', null, h('b', null, money(g.amount_cents)), g.monthly ? ' a month' : '', g.name ? ` from ${g.name}` : '', h('span', { class: 'muted small' }, ` ${fmtDateTime(g.created_at)}${g.from_email ? ', from a follow-up email' : ''}`))))) : null,
    h('p', { class: 'muted small' }, `Anyone can give at ${location.origin}/give/${slug}. Monthly gifts are counted when the first one is made.`)));
  await loadList();
}
