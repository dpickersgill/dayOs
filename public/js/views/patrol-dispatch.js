// Patrol dispatch board (calls, timeline, responders, guest help requests) and the training passport.

import { get, post, put, patch, del } from '../api.js';
import { h, clear, state, input, select, field, button, toast, formDialog, dialog, table, val, num, fmtTime, fmtDateTime, fmtDate, label, empty, errorBox, appendAll } from '../ui.js';
import { has } from './patrol-feat.js';
import { compact } from './patrol-case.js';

const PRIORITY = ['low', 'normal', 'high', 'critical'];
const statusTone = { new: 'bad', dispatched: 'warn', on_scene: 'warn', transporting: 'warn', closed: 'neutral', cancelled: 'neutral' };
const statusText = { new: 'New', dispatched: 'Dispatched', on_scene: 'On scene', transporting: 'Transporting', closed: 'Closed', cancelled: 'Canceled' };
const prioTone = { low: 'neutral', normal: 'neutral', high: 'warn', critical: 'bad' };
const kindText = { received: 'Call received', dispatched: 'Dispatched', on_scene: 'On scene', transporting: 'Transporting', at_aid_room: 'At aid room', note: 'Note', closed: 'Closed', cancelled: 'Canceled' };
// The next step a dispatcher usually takes from each status.
const NEXT = { new: [], dispatched: [['on_scene', 'On scene']], on_scene: [['transporting', 'Transporting'], ['at_aid_room', 'At aid room']], transporting: [['at_aid_room', 'At aid room']] };

function callCard(c, onOpen) {
  const who = c.responders.map((r) => r.callsign || `${r.first_name} ${r.last_name[0]}.`).join(', ');
  return h('article', { class: 'call-card', 'data-priority': c.priority },
    h('div', { class: 'spread' }, h('b', null, `Call ${c.call_no}`), h('span', { class: 'row' }, c.priority !== 'normal' ? state(label(c.priority), prioTone[c.priority]) : null, state(statusText[c.status], statusTone[c.status]))),
    h('div', null, h('b', null, c.location)),
    c.description ? h('div', null, c.description) : null,
    h('div', { class: 'muted' }, `${fmtTime(c.received_at)} · ${c.source === 'guest' ? 'Guest request' : label(c.source)}${c.caller_name ? ` · ${c.caller_name}` : ''}${c.caller_phone ? ` · ${c.caller_phone}` : ''}`),
    h('div', null, who ? `Responding: ${who}` : h('span', { class: 'muted' }, 'No one sent yet')),
    button('Open', onOpen, { small: true, kind: c.status === 'new' ? 'primary' : undefined }));
}

export async function drawDispatch(box, { canLead }) {
  const board = h('div');
  const avail = h('div');
  let timer = null;
  const mgr = has('manage_settings');

  const mine = h('div');
  async function load() {
    if (!box.isConnected && timer) { clearInterval(timer); timer = null; return; }
    try {
      const [{ data }, a, m] = await Promise.all([get('/patrol/dispatch'), get('/patrol/dispatch/available'), get('/patrol/dispatch-mine')]);
      // The calls I am sent to, with "On my way" so dispatch knows the alert was seen.
      clear(mine).append(...m.data.map((c) => h('div', { class: `my-call${c.acked_at ? '' : ' is-new'}`, role: c.acked_at ? null : 'alert' },
        h('b', null, `You are sent to call ${c.call_no}: `), c.location, c.description ? ` (${c.description})` : '',
        c.acked_at ? h('span', { class: 'muted' }, ' On your way') : button('On my way', async () => { await post(`/patrol/dispatch/${c.id}/ack`); toast('Dispatch knows you are on your way'); await load(); }, { kind: 'primary' }))));
      clear(board).append(data.length ? h('div', { class: 'call-grid' }, data.map((c) => callCard(c, () => openCall(c.id, load)))) : empty('No active calls.'));
      clear(avail).append(h('p', null, h('b', null, 'On duty: '), a.data.length
        ? a.data.map((p) => `${p.callsign || `${p.first_name} ${p.last_name}`}${p.radio ? ` (radio ${p.radio})` : ''}${p.state === 'on_call' ? ' (on a call)' : ''}`).join(', ')
        : h('span', { class: 'muted' }, 'nobody is signed in. Patrollers sign in on Now, On duty.')));
    } catch (err) { clear(board).append(errorBox(err)); }
  }

  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'The board refreshes every 15 seconds. Guest requests arrive here as New calls.'),
      h('div', { class: 'row' }, mgr ? button('Guest help page', () => guestHelpDialog(), {}) : null, button('History', () => historyDialog(), {}), button('New call', () => newCallDialog(load), { kind: 'primary' }))),
    mine, avail, board));
  await load();
  timer = setInterval(load, 15000);
  if (timer && timer.unref) timer.unref(); // Node (tests) only; browsers return a number
}

function newCallDialog(again) {
  formDialog('New call', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Location', input({ name: 'location', required: true, maxlength: 255, placeholder: 'Ridge Run, below the lift' }))),
    h('div', { class: 'wide' }, field('What is reported', input({ name: 'description', maxlength: 500 }))),
    field('Priority', select(PRIORITY.map((p) => [p, label(p)]), 'normal', { name: 'priority' })),
    field('Received by', select([['radio', 'Radio'], ['phone', 'Phone'], ['patrol', 'Patroller in person']], 'radio', { name: 'source' })),
    field('Caller name', input({ name: 'caller_name', maxlength: 100 })), field('Caller phone', input({ name: 'caller_phone', maxlength: 40 }))),
  async (fd) => { const r = await post('/patrol/dispatch', compact({ location: val(fd, 'location'), description: val(fd, 'description'), priority: val(fd, 'priority'), source: val(fd, 'source'), caller_name: val(fd, 'caller_name'), caller_phone: val(fd, 'caller_phone') })); toast(`Call ${r.call_no} logged`); await again(); }, { submitText: 'Log call' });
}

async function openCall(id, again) {
  const holder = h('div', { class: 'stack' });
  const d = dialog('Call', holder, { wide: true });
  async function draw() {
    const [c, a] = await Promise.all([get(`/patrol/dispatch/${id}`), get('/patrol/dispatch/available')]);
    const live = ['new', 'dispatched', 'on_scene', 'transporting'].includes(c.status);
    const sent = new Set(c.responders.map((r) => r.staff_id));
    const choices = a.data.filter((p) => !sent.has(p.staff_id));
    const pick = select([['', 'Choose a patroller'], ...choices.map((p) => [p.staff_id, `${p.callsign ? `${p.callsign}: ` : ''}${p.first_name} ${p.last_name}${p.state === 'on_call' ? ' (on a call)' : ''}`])], '', { 'aria-label': 'Patroller to send' });
    const note = input({ maxlength: 500, 'aria-label': 'Note', placeholder: 'Add a note to the timeline' });
    const step = async (kind, text) => { await post(`/patrol/dispatch/${id}/events`, compact({ kind, note: text })); await draw(); await again(); };
    appendAll(clear(holder),
      h('div', { class: 'spread' }, h('h2', null, `Call ${c.call_no}`), h('span', { class: 'row' }, state(label(c.priority), prioTone[c.priority]), state(statusText[c.status], statusTone[c.status]))),
      h('p', null, h('b', null, c.location), c.description ? ` · ${c.description}` : ''),
      h('p', { class: 'muted' }, `${fmtDateTime(c.received_at)} · ${c.source === 'guest' ? 'Guest request' : label(c.source)}${c.caller_name ? ` · ${c.caller_name}` : ''}${c.caller_phone ? ` · ${c.caller_phone}` : ''}`),
      whereBlock(c, live),
      h('h3', null, 'Responders'),
      c.responders.length ? h('ul', null, c.responders.map((r) => h('li', null, `${r.callsign ? `${r.callsign}: ` : ''}${r.first_name} ${r.last_name}`,
        ' ', r.acked_at ? state('On the way', 'good') : r.notified_at ? state('Alerted, not answered', 'warn') : state('No phone alert', 'neutral'), r.texted_at ? state('Texted', 'neutral') : null,
        live && !r.acked_at ? button('Text them', async () => { await post(`/patrol/dispatch/${id}/responders/${r.staff_id}/text`); toast('Text sent'); await draw(); }, { small: true, kind: 'ghost' }) : null, live ? button('Remove', async () => { await del(`/patrol/dispatch/${id}/responders/${r.staff_id}`); await draw(); await again(); }, { small: true }) : null))) : h('p', { class: 'muted' }, 'No one sent yet.'),
      live ? h('div', { class: 'row' }, pick, button('Send', async () => { if (!pick.value) { toast('Choose a patroller first', 'error'); return; } await post(`/patrol/dispatch/${id}/responders`, { staff_id: Number(pick.value) }); await draw(); await again(); }, { kind: 'primary' })) : null,
      live && !choices.length ? h('p', { class: 'muted' }, 'Only patrollers on duty appear here: signed in on Patrol, or clocked in for a patrol shift.') : null,
      live ? h('div', { class: 'row' }, (NEXT[c.status] || []).map(([k, t]) => button(t, () => step(k)))) : null,
      h('h3', null, 'Timeline'),
      h('ul', { class: 'timeline' }, c.events.map((e) => h('li', null, h('span', { class: 'muted' }, fmtTime(e.at)), h('span', null, kindText[e.kind], e.first_name ? `: ${e.first_name} ${e.last_name}` : '', e.note ? ` (${e.note})` : '')))),
      live ? h('div', { class: 'row' }, note, button('Add note', async () => { if (!note.value.trim()) return; await step('note', note.value.trim()); })) : null,
      h('div', { class: 'row' },
        c.case ? h('a', { href: `#/patrol/case/${c.case.id}`, onclick: () => d.close() }, `Open case ${c.case.case_number}`) : button('Start a patient care report', async () => { const m = await post(`/patrol/dispatch/${id}/case`, {}); toast(`Case ${m.case_number} started`); d.close(); location.hash = `#/patrol/case/${m.id}`; }),
        live ? button('Close call', async () => { await step('closed'); }, { kind: 'primary' }) : null,
        live ? button('Cancel call', async () => { await step('cancelled', 'Canceled'); }, { kind: 'danger' }) : null));
  }
  // Where the caller is: from the guest help page, or from the location link dispatch texts them.
  function whereBlock(c, live) {
    const has = c.gps_lat !== null && c.gps_lat !== undefined;
    const pos = has ? `${Number(c.gps_lat).toFixed(5)}, ${Number(c.gps_lng).toFixed(5)}` : null;
    const waiting = live && c.locate_sent_at && !c.located_at;
    if (waiting) watch();
    return h('div', { class: 'locate-box' },
      has ? h('p', null, h('b', null, 'Caller\'s phone: '), pos, c.located_accuracy_m ? ` (within about ${c.located_accuracy_m} m${c.located_at ? `, ${fmtTime(c.located_at)}` : ''})` : '', ' ',
        h('a', { href: `https://www.google.com/maps/search/?api=1&query=${c.gps_lat},${c.gps_lng}`, target: '_blank', rel: 'noopener' }, 'Open in maps')) : null,
      waiting ? h('p', { class: 'muted' }, `Location link sent at ${fmtTime(c.locate_sent_at)}. Waiting for the caller to tap it…`) : null,
      live ? button(has ? 'Ask for their location again' : 'Locate caller', () => locateDialog(c), { small: true, kind: has ? 'ghost' : null }) : null);
  }
  function locateDialog(c) {
    const phone = input({ name: 'phone', type: 'tel', maxlength: 30, value: c.caller_phone || '', required: true });
    formDialog('Locate caller', h('div', { class: 'stack' },
      h('p', null, 'We text the caller a link. When they tap it and allow location, their phone\'s position appears here, with how accurate it is.'),
      field('Caller\'s mobile number', phone)), async () => {
      const r = await post(`/patrol/dispatch/${id}/locate`, { phone: phone.value.trim() });
      if (r.texted) toast('Location link texted'); else { toast(`Not texted: ${r.error}. Read them the link instead.`, 'warn'); dialog('Location link', h('div', { class: 'stack' }, h('p', null, 'Text messages are not working, so give the caller this link another way:'), h('p', null, h('code', null, r.link)))); }
      await draw(); watch();
    }, { submitText: 'Text the link' });
  }
  // While a location link is out, check every 8 seconds until the caller answers or the call is closed.
  let poll = null;
  function watch() {
    if (poll) return;
    poll = setInterval(async () => {
      if (!holder.isConnected) { clearInterval(poll); poll = null; return; }
      try { const c = await get(`/patrol/dispatch/${id}`); if (c.located_at || !c.locate_sent_at) { clearInterval(poll); poll = null; await draw(); if (c.located_at) toast('Caller located'); } } catch (_) { /* try again next time */ }
    }, 8000);
  }
  try { await draw(); } catch (err) { clear(holder).append(errorBox(err)); }
}

async function historyDialog() {
  const date = input({ type: 'date', 'aria-label': 'Day' });
  const out = h('div');
  async function load() {
    const { data } = await get(`/patrol/dispatch?status=all${date.value ? `&date=${date.value}` : ''}`);
    clear(out).append(data.length ? table([
      { head: 'Call', cell: (c) => c.call_no }, { head: 'Received', cell: (c) => fmtDateTime(c.received_at) }, { head: 'Where', cell: (c) => c.location },
      { head: 'Source', cell: (c) => label(c.source) }, { head: 'Status', cell: (c) => state(statusText[c.status], statusTone[c.status]) },
      { head: '', actions: true, cell: (c) => button('Open', () => openCall(c.id, load), { small: true }) },
    ], data) : empty('No calls.'));
  }
  date.addEventListener('change', load);
  dialog('Call history', h('div', { class: 'stack' }, field('Day (blank for the latest)', date), out), { wide: true });
  await load();
}

async function guestHelpDialog() {
  const s = await get('/patrol/guest-help');
  const url = `${location.origin}${s.path}`;
  const on = select([['0', 'Off'], ['1', 'On']], s.enabled ? '1' : '0', { name: 'enabled' });
  formDialog('Guest help page', h('div', { class: 'form' },
    h('p', { class: 'wide' }, 'Guests scan a QR code on a trail sign, say where they are, and the request lands on your board as a New call. It never replaces 911: the page tells guests to call 911 for emergencies.'),
    h('p', { class: 'wide' }, 'Link for your QR codes: ', h('b', null, url), h('br'), 'Add ?loc=Ridge+Run to a sign\'s link to fill in its location.'),
    field('Page is', on), h('div', { class: 'wide' }, field('Message to guests', input({ name: 'message', value: s.message || '', maxlength: 300, placeholder: 'Patrol phone: 555-0100' }), 'Shown above the form. Put the patrol phone number here.'))),
  async (fd) => { await put('/patrol/guest-help', { enabled: val(fd, 'enabled') === '1', message: val(fd, 'message') }); toast('Saved'); });
}

// ---------------------------------------------------------------- training passport
const passTone = { signed_off: 'good', expiring: 'warn', expired: 'bad', in_progress: 'neutral', not_started: 'neutral' };
const passText = { signed_off: 'Signed off', expiring: 'Expires soon', expired: 'Expired', in_progress: 'In progress', not_started: 'Not started' };

export async function drawPassport(box, { canLead, staffId }) {
  const again = async () => { const n = h('div'); await drawPassport(n, { canLead, staffId }); clear(box).append(...n.childNodes); };
  const parts = [h('p', { class: 'muted' }, 'Each skill is signed off by a patrol leader. Skills with a validity period lapse and show as expired until they are signed off again.')];
  if (canLead) {
    const [{ data: skills }, { data: overview }] = await Promise.all([get('/patrol/competencies'), get('/patrol/passport')]);
    parts.push(h('div', { class: 'spread' }, h('h3', null, 'Team'), button('Add a skill', () => skillDialog(null, again), { kind: 'primary' })));
    parts.push(overview.length ? table([
      { head: 'Name', cell: (m) => `${m.first_name} ${m.last_name}` }, { head: 'Signed off', num: true, cell: (m) => `${m.signed_off} of ${m.skills}` },
      { head: 'Expired', num: true, cell: (m) => (m.expired ? state(String(m.expired), 'bad') : '0') }, { head: 'In progress', num: true, cell: (m) => m.in_progress },
      { head: '', actions: true, cell: (m) => button('Skills', () => passportDialog(m.staff_id, `${m.first_name} ${m.last_name}`, true, again), { small: true }) },
    ], overview) : empty('Add patrollers to the roster first.'));
    parts.push(h('h3', null, 'Skills'), skills.length ? table([
      { head: 'Skill', cell: (k) => k.name }, { head: 'Group', cell: (k) => k.category || '' }, { head: 'Valid for', cell: (k) => (k.valid_months ? `${k.valid_months} months` : 'Does not lapse') },
      { head: 'In use', cell: (k) => (k.active ? 'Yes' : 'Retired') }, { head: '', actions: true, cell: (k) => button('Edit', () => skillDialog(k, again), { small: true }) },
    ], skills) : empty('No skills yet. Add things like toboggan handling, spinal stabilization or AED use.'));
  }
  if (staffId) {
    const mine = await get(`/patrol/passport/${staffId}`);
    parts.push(h('h3', null, 'My passport'), passportTable(mine.skills, null));
  } else if (!canLead) {
    parts.push(empty('Your login is not linked to a staff record, so there is no passport to show.'));
  }
  clear(box).append(h('div', { class: 'stack' }, ...parts));
}

function passportTable(skills, onEdit) {
  if (!skills.length) return empty('No skills have been set up yet.');
  const cols = [
    { head: 'Skill', cell: (k) => k.name }, { head: 'Group', cell: (k) => k.category || '' },
    { head: 'Status', cell: (k) => state(passText[k.state], passTone[k.state]) },
    { head: 'Signed', cell: (k) => (k.signed_on ? `${fmtDate(k.signed_on)}${k.signed_by ? ` by ${k.signed_by}` : ''}` : '') },
    { head: 'Expires', cell: (k) => (k.expires_on ? fmtDate(k.expires_on) : '') },
  ];
  if (onEdit) cols.push({ head: '', actions: true, cell: (k) => h('span', { class: 'row' }, k.state === 'signed_off' || k.state === 'expiring' ? null : button('Sign off', () => onEdit(k, 'signed_off'), { small: true, kind: 'primary' }), k.state === 'not_started' ? button('Mark in progress', () => onEdit(k, 'in_progress'), { small: true }) : null, k.state === 'expiring' || k.state === 'expired' ? button('Renew', () => onEdit(k, 'signed_off'), { small: true }) : null) });
  return table(cols, skills);
}

async function passportDialog(staffId, name, canSign, again) {
  const holder = h('div');
  dialog(`Passport: ${name}`, holder, { wide: true });
  async function draw() {
    const p = await get(`/patrol/passport/${staffId}`);
    clear(holder).append(passportTable(p.skills, canSign ? async (k, status) => { const r = await put(`/patrol/passport/${staffId}/${k.competency_id}`, { status }); toast(status === 'signed_off' ? 'Signed off' : 'Saved'); await draw(); await again(); return r; } : null));
  }
  try { await draw(); } catch (err) { clear(holder).append(errorBox(err)); }
}

function skillDialog(k, again) {
  formDialog(k ? 'Edit skill' : 'Add a skill', h('div', { class: 'form' },
    h('div', { class: 'wide' }, field('Skill', input({ name: 'name', value: k ? k.name : '', required: true, maxlength: 120 }))),
    field('Group', input({ name: 'category', value: k && k.category ? k.category : '', maxlength: 60, placeholder: 'Rescue, Medical…' })),
    field('Valid for (months)', input({ name: 'valid_months', type: 'number', min: 1, max: 120, value: k && k.valid_months ? k.valid_months : '' }), 'Blank if it never lapses.'),
    h('div', { class: 'wide' }, field('What it covers', input({ name: 'description', value: k && k.description ? k.description : '', maxlength: 500 }))),
    k ? field('In use', select([['1', 'Yes'], ['0', 'Retired']], k.active ? '1' : '0', { name: 'active' })) : null),
  async (fd) => {
    const body = { name: val(fd, 'name'), category: val(fd, 'category'), valid_months: num(fd, 'valid_months'), description: val(fd, 'description') };
    if (k) await patch(`/patrol/competencies/${k.id}`, { ...body, active: val(fd, 'active') === '1' }); else await post('/patrol/competencies', compact(body));
    toast('Saved'); await again();
  });
}
