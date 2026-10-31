// The status page in the platform console (2026.11.10, READY): what the website's /status page shows right now, and the
// incidents and planned maintenance written for it. Opened from the Mountains page; uses the console's own session.
// See src/lib/status.js and src/routes/status.js. Only operators see this. Never put customer details in a note.

import { h, clear, button, field, input, select, table, formDialog, confirmDialog, toast, empty, errorBox } from './ui.js';

let ctx = null; // { app, call, session(), back(), signIn() }
const WORD = { ok: 'Working', slow: 'Slow or partly working', down: 'Not working', unknown: 'Not checked' };
const when = (t) => (t ? new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '');
// <input type="datetime-local"> reads and writes this computer's own time.
const toInput = (t) => { if (!t) return ''; const d = new Date(t); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromInput = (v) => (v ? new Date(v).toISOString() : null);
const stateOf = (n) => { const now = Date.now(); if (new Date(n.starts_at) > now) return 'Planned'; if (!n.ends_at || new Date(n.ends_at) > now) return 'Happening now'; return 'Over'; };

export function openStatus(c) { ctx = c; draw(); }

async function draw() {
  const { app, call } = ctx;
  clear(app);
  const body = h('div', { class: 'stack' });
  app.append(h('main', { class: 'platform-box wider stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Status page'), h('p', { class: 'muted' }, 'What the public status page shows, and the incidents and maintenance you write for it. Never put a mountain\'s or a guest\'s details in a note.')),
      h('div', { class: 'row' }, button('Back to mountains', () => ctx.back(), { small: true }), h('a', { class: 'btn small', href: '/site/status', target: '_blank', rel: 'noopener' }, 'Open the status page'))),
    body));
  let r;
  try { r = await call('GET', '/status'); } catch (ex) { if (ex.status === 403) ctx.signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }

  body.append(h('section', { class: 'panel stack' },
    h('h2', null, 'The checks right now'),
    h('p', { class: 'muted small' }, 'Each server checks these itself, at most once a minute. A part shows the impact of an open note instead, if that is worse.'),
    h('ul', { class: 'stack tight' }, ...r.parts.map((p) => h('li', null, h('b', null, `${p.name}: `), WORD[r.live[p.key]] || r.live[p.key])))));

  body.append(h('div', { class: 'row wrap' },
    button('Report an incident', () => edit(r, { kind: 'incident' }), { kind: 'primary' }),
    button('Plan maintenance', () => edit(r, { kind: 'maintenance' }))));

  body.append(h('h2', null, 'Notes, newest first'));
  const name = (k) => (r.parts.find((p) => p.key === k) || { name: k }).name;
  body.append(r.notes.length ? table([
    { head: 'Note', cell: (n) => h('span', null, h('b', null, `${n.kind === 'maintenance' ? 'Maintenance: ' : ''}${n.title}`), n.body ? h('div', { class: 'small' }, n.body) : null) },
    { head: 'When', cell: (n) => h('span', { class: 'small' }, n.ends_at ? `${when(n.starts_at)} to ${when(n.ends_at)}` : `Since ${when(n.starts_at)}`) },
    { head: 'Parts', cell: (n) => n.parts.map(name).join(', ') },
    { head: 'Impact', cell: (n) => r.impacts[n.impact] },
    { head: 'Now', cell: (n) => stateOf(n) },
    { actions: true, cell: (n) => h('div', { class: 'row' },
      button('Edit', () => edit(r, n), { small: true, label: `Edit ${n.title}` }),
      stateOf(n) === 'Happening now' ? button('Mark over', () => end(n), { small: true, label: `Mark ${n.title} over` }) : null,
      button('Remove', () => remove(n), { small: true, label: `Remove ${n.title}` })) },
  ], r.notes) : empty('No notes in the last 90 days. The status page says each part is working, from its checks.'));
}

function edit(r, n) {
  const isNew = !n.id;
  const kind = select([['incident', 'Incident (something went wrong)'], ['maintenance', 'Planned maintenance']], n.kind || 'incident', { name: 'kind' });
  const title = input({ name: 'title', required: true, maxlength: 150, value: n.title || '', placeholder: 'For example: Card payments failing' });
  const text = h('textarea', { name: 'body', rows: 4, maxlength: 4000, placeholder: 'What people notice, what we are doing, and when we expect it fixed. Add updates here as it goes.' }, n.body || '');
  const boxes = r.parts.map((p) => {
    const box = input({ type: 'checkbox', name: 'parts', value: p.key, checked: (n.parts || []).includes(p.key) });
    return h('label', { class: 'check' }, box, h('span', null, p.name));
  });
  const parts = h('fieldset', { class: 'stack tight' }, h('legend', null, 'Which parts'), ...boxes);
  const impact = select([['slow', r.impacts.slow], ['down', r.impacts.down], ['none', r.impacts.none]], n.impact || (n.kind === 'maintenance' ? 'none' : 'slow'), { name: 'impact' });
  const starts = input({ type: 'datetime-local', name: 'starts_at', required: true, value: toInput(n.starts_at || new Date().toISOString()) });
  const ends = input({ type: 'datetime-local', name: 'ends_at', value: toInput(n.ends_at) });
  formDialog(isNew ? (n.kind === 'maintenance' ? 'Plan maintenance' : 'Report an incident') : 'Edit the note', h('div', { class: 'form stack' },
    field('Kind', kind), field('Title', title, 'Short and plain. It is public.'), field('What people should know', text, 'Public. No mountain, guest or staff names.'),
    parts, field('Impact while it lasts', impact),
    field('Starts', starts, 'Your computer\'s own time.'), field('Ends', ends, 'Leave empty while it is still going on. Planned maintenance: when you expect to finish.')), async () => {
    const chosen = boxes.map((b) => b.querySelector('input')).filter((b) => b.checked).map((b) => b.value);
    if (!chosen.length) throw new Error('Choose at least one part.');
    const payload = { kind: kind.value, title: title.value.trim(), body: text.value.trim(), parts: chosen, impact: impact.value, starts_at: fromInput(starts.value), ends_at: fromInput(ends.value) };
    if (!payload.starts_at) throw new Error('Say when it starts.');
    if (isNew) await ctx.call('POST', '/status', payload); else await ctx.call('PATCH', `/status/${n.id}`, payload);
    toast(isNew ? 'Added. The status page shows it within a minute.' : 'Saved.');
    draw();
  }, { submitText: isNew ? 'Add to the status page' : 'Save', wide: true });
  title.focus();
}

function end(n) {
  confirmDialog('Mark it over?', `"${n.title}" ends now, and moves to the last 90 days on the status page.`, 'Mark over', async () => {
    await ctx.call('POST', `/status/${n.id}/end`);
    toast('Marked over.'); draw();
  });
}

function remove(n) {
  confirmDialog('Remove this note?', `"${n.title}" leaves the status page for good. Only remove a note written by mistake: for something that is over, use Mark over.`, 'Remove', async () => {
    await ctx.call('DELETE', `/status/${n.id}`);
    toast('Removed.'); draw();
  }, { danger: true });
}
