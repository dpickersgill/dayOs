// Street notices (muni release 1): staff pick the streets a water break or road work affects, whole or a house-number
// range, and text and email every resident who signed up for alerts there. Updates go to the same list; Ended closes it.
// Managers send (and the Crew logins a manager picks in Settings); Front desk sees the notices and the sign-up list.
// The app records who issued a boil water advisory; it never suggests issuing one.
import { get, post, put, del, download } from '../api.js';
import { h, clear, table, state, input, select, field, button, toast, fail, formDialog, confirmDialog, dialog, tabs, appendAll, fmtDateTime, fmtInstant, empty, errorBox, loading, isManager, nowInput } from '../ui.js';

let setup = null;
const loadSetup = async () => { setup = await get('/street-notices/setup'); return setup; };
const typeOf = (key) => setup.types.find((t) => t.key === key) || setup.types[0];
const STATUS = { draft: ['Draft', 'neutral'], scheduled: ['Scheduled', 'warn'], active: ['Out now', 'bad'], ended: ['Ended', 'good'], cancelled: ['Cancelled', 'neutral'] };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const reachWords = (p) => (p.texts || p.emails
  ? `Reaches ${plural(p.residents, 'resident', 'residents')}: ${plural(p.texts, 'text', 'texts')} and ${plural(p.emails, 'email', 'emails')}.`
  : 'No one signed up for alerts on these streets yet.')
  + (p.opted_out ? ` ${plural(p.opted_out, 'address', 'addresses')} said stop and will be skipped.` : '')
  + (p.no_number ? ` ${plural(p.no_number, 'sign-up has', 'sign-ups have')} no house number, so ${p.no_number === 1 ? 'it is' : 'they are'} included in any range on the street.` : '')
  + (p.held_until ? ` It is past 9 PM, so texts wait until 8 AM (${fmtInstant(p.held_until)}).` : '');

export async function render(root) {
  try { await loadSetup(); } catch (err) { root.append(errorBox(err)); return; }
  const items = [['active', 'Out now', (b) => list(b, 'active')], ['drafts', 'Drafts and scheduled', (b) => list(b, 'drafts')], ['ended', 'Ended', (b) => list(b, 'ended')], ['residents', 'Residents signed up', residents]];
  if (setup.is_manager) items.push(['settings', 'Settings', settings]);
  const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Street notices'),
    h('p', { class: 'muted' }, 'Texts and emails to residents on the streets a water break, a closure or a schedule change affects.')),
    h('div', { class: 'row' }, setup.can_send ? button('New notice', () => editor(null), { kind: 'primary' }) : null,
      button('Export notices', () => download('/street-notices/export', 'street-notices.csv'))));
  appendAll(root, head, setupNote(), tabs(items, 'active'));
}

function setupNote() {
  const notes = [];
  if (!setup.sms_ready || !setup.email_ready) notes.push(`Not set up yet: ${[!setup.sms_ready && 'text messages', !setup.email_ready && 'email'].filter(Boolean).join(' and ')}. Those messages cannot go out until it is.`);
  if (!setup.can_send) notes.push('Only managers send notices. A manager can let a Crew lead send them in Street notices, Settings.');
  return notes.length ? h('div', null, ...notes.map((n) => h('p', { class: 'muted' }, n))) : null;
}

let reload = () => {};
async function list(box, which) {
  const body = h('div', null, loading());
  box.append(body);
  reload = async () => {
    try {
      const statuses = which === 'drafts' ? ['scheduled', 'draft'] : [which];
      const data = (await Promise.all(statuses.map((s) => get(`/street-notices?status=${s}`)))).flatMap((r) => r.data);
      const none = { active: 'No notices are out now.', drafts: 'No drafts or scheduled notices.', ended: 'No ended notices yet.' }[which];
      clear(body).append(data.length ? table([
        { head: 'Notice', cell: (n) => h('div', null, h('strong', null, n.title), h('div', { class: 'muted small' }, n.type_label)) },
        { head: 'Streets', cell: (n) => n.streets },
        { head: 'Status', cell: (n) => state(...(STATUS[n.status] || [n.status, 'neutral'])) },
        { head: 'Sent', num: true, cell: (n) => (n.sent_at ? `${n.summary.texts_sent} texts, ${n.summary.emails_sent} emails` : '') },
        { head: 'When', cell: (n) => (n.status === 'scheduled' ? `Goes ${fmtInstant(n.send_at)}` : n.ended_at ? `Ended ${fmtInstant(n.ended_at)}` : n.sent_at ? fmtInstant(n.sent_at) : '') },
        { head: '', actions: true, cell: (n) => button('Open', () => detail(n.id), { small: true, label: `Open ${n.title}` }) },
      ], data) : empty(none, which === 'active' && setup.can_send ? button('New notice', () => editor(null), { kind: 'primary' }) : null));
    } catch (err) { clear(body).append(errorBox(err)); }
  };
  await reload();
}

// ---------------------------------------------------------------- the notice form
function areaRow(a = {}) {
  const street = select([['', 'Choose a street'], ...setup.streets.map((s) => [String(s.id), s.name])], a.street_id ? String(a.street_id) : '', { 'aria-label': 'Street' });
  const from = input({ type: 'number', min: 0, max: 9999999, value: a.from_no ?? '', placeholder: 'From', 'aria-label': 'From house number' });
  const to = input({ type: 'number', min: 0, max: 9999999, value: a.to_no ?? '', placeholder: 'To', 'aria-label': 'To house number' });
  const side = select([['both', 'Both sides'], ['odd', 'Odd numbers'], ['even', 'Even numbers']], a.side || 'both', { 'aria-label': 'Side of the street' });
  const el = h('div', { class: 'row' }, street, from, to, side);
  const remove = button('Remove', () => { el.remove(); el.dispatchEvent(new Event('change', { bubbles: true })); }, { small: true, label: 'Remove this street' });
  el.append(remove);
  el.value = () => (street.value ? { street_id: Number(street.value), from_no: from.value === '' ? null : Number(from.value), to_no: to.value === '' ? null : Number(to.value), side: side.value } : null);
  el.words = () => {
    const s = setup.streets.find((x) => String(x.id) === street.value);
    if (!s) return '';
    const range = from.value && to.value ? ` ${from.value} to ${to.value}` : from.value ? ` ${from.value} and up` : to.value ? ` up to ${to.value}` : '';
    return `${s.name}${range}${side.value === 'odd' ? ' (odd side)' : side.value === 'even' ? ' (even side)' : ''}`;
  };
  return el;
}

const local = (s) => (s ? String(s).replace(' ', 'T').slice(0, 16) : '');
const sayWhen = (v) => (v ? fmtDateTime(v) : '');

async function editor(id) {
  if (!setup.streets.length) { toast('Add your streets first: Settings, Streets.', 'error'); return; }
  const n = id ? await get(`/street-notices/${id}`) : { type: 'water_outage', title: '', sms_text: typeOf('water_outage').sms, body: typeOf('water_outage').body, areas: [{}] };
  let touched = Boolean(id);
  const type = select(setup.types.map((t) => [t.key, t.label]), n.type, { name: 'type' });
  const title = input({ name: 'title', value: n.title, maxlength: 120, required: true, placeholder: 'For example: Water main break on Dayton Street' });
  const areas = h('div', { class: 'stack tight' }, ...(n.areas.length ? n.areas : [{}]).map(areaRow));
  const addArea = button('Add a street', () => { areas.append(areaRow()); count(); }, { small: true });
  const starts = input({ type: 'datetime-local', name: 'starts_at', value: local(n.starts_at) });
  const ends = input({ type: 'datetime-local', name: 'ends_expected_at', value: local(n.ends_expected_at) });
  const sms = h('textarea', { name: 'sms_text', rows: 3, maxlength: 320, required: true }, n.sms_text);
  const long = h('textarea', { name: 'body', rows: 6, maxlength: 4000 }, n.body || '');
  const counter = h('small', { class: 'muted' });
  const operator = select([['', 'Choose the operator'], ...setup.operators.map((o) => [String(o.id), o.name])], n.issued_by_user_id ? String(n.issued_by_user_id) : '', { name: 'issued_by_user_id' });
  const operatorBox = h('div', { class: 'stack tight' }, h('p', { class: 'callout' }, setup.operator_rule), field('Issued by (certified operator)', operator, 'The app records who issued it. People decide; the app only sends what you write.'));
  const reach = h('p', { class: 'muted', 'aria-live': 'polite' });
  const fill = button('Fill in streets and times', () => {
    const streets = [...areas.children].map((r) => r.words()).filter(Boolean).join(', ');
    for (const el of [sms, long]) el.value = el.value.replace(/\{streets\}/g, streets || '{streets}').replace(/\{start\}/g, starts.value ? sayWhen(starts.value) : '{start}').replace(/\{until\}/g, ends.value ? sayWhen(ends.value) : '{until}');
    sync();
  }, { small: true });
  const sync = () => {
    operatorBox.hidden = !typeOf(type.value).operator;
    const blanks = [...new Set(`${sms.value} ${long.value}`.match(/\{[a-z_ ]+\}/gi) || [])];
    counter.textContent = `${sms.value.length} of 320 characters. We add the municipality's name, the notice's page and "Reply STOP to stop texts".${blanks.length ? ` Fill in before sending: ${blanks.join(', ')}.` : ''}`;
  };
  let timer = null;
  const count = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const list = [...areas.children].map((r) => r.value()).filter(Boolean);
      if (!list.length) { reach.textContent = 'Pick at least one street.'; return; }
      try { reach.textContent = reachWords(await post('/street-notices/preview', { type: type.value, areas: list })); } catch (err) { reach.textContent = err.message; }
    }, 250);
  };
  type.addEventListener('change', () => {
    const t = typeOf(type.value);
    if (!touched || window.confirm('Replace the message with the template for this type?')) { sms.value = t.sms; long.value = t.body; touched = false; }
    sync(); count();
  });
  for (const el of [sms, long]) el.addEventListener('input', () => { touched = true; sync(); });
  areas.addEventListener('change', count); areas.addEventListener('input', count);
  const fields = h('div', { class: 'stack' },
    field('Type', type), field('Title (residents see it)', title),
    h('div', { class: 'field' }, h('span', null, 'Streets affected'), h('span', { class: 'hint' }, 'A whole street, or a range of house numbers. Leave From and To empty for the whole street.'), areas, addArea),
    reach,
    h('div', { class: 'row' }, field('Starts', starts), field('Expected to end', ends, 'Optional')),
    operatorBox,
    field('Text message', sms), counter, field('Longer version (email and the notice’s page)', long, 'Optional. Without it, the text is used.'), fill);
  sync(); count();
  formDialog(id ? 'Edit notice' : 'New notice', fields, async () => {
    const body = { type: type.value, title: title.value.trim(), sms_text: sms.value.trim(), body: long.value.trim() || null, areas: [...areas.children].map((r) => r.value()).filter(Boolean),
      starts_at: starts.value || null, ends_expected_at: ends.value || null, issued_by_user_id: typeOf(type.value).operator && operator.value ? Number(operator.value) : null };
    const saved = id ? await put(`/street-notices/${id}`, body) : await post('/street-notices', body);
    toast('Saved as a draft');
    await reload();
    detail(saved.id);
  }, { submitText: 'Save and review', wide: true });
}

// ---------------------------------------------------------------- one notice
const sumWords = (s) => `${s.texts_sent} texts and ${s.emails_sent} emails sent${s.queued + s.sending ? `, ${s.queued + s.sending} still going out` : ''}${s.failed ? `, ${s.failed} could not be delivered` : ''}${s.opted_out ? `, ${s.opted_out} skipped (said stop)` : ''}.`;

async function detail(id) {
  let n;
  try { n = await get(`/street-notices/${id}`); } catch (err) { fail(err); return; }
  const body = h('div', { class: 'stack' });
  const dlg = dialog(n.title, body, { wide: true });
  const again = async () => { n = await get(`/street-notices/${id}`); draw(); await reload(); };
  let poll = null;
  function draw() {
    clearTimeout(poll);
    appendAll(clear(body),
      h('p', null, state(...(STATUS[n.status] || [n.status, 'neutral'])), ' ', h('strong', null, n.type_label), n.code && n.status !== 'draft' ? h('span', { class: 'muted' }, ` Notice ${n.code}`) : null),
      h('p', null, h('strong', null, 'Streets: '), n.streets),
      n.starts_at || n.ends_expected_at ? h('p', null, [n.starts_at && `Starts ${sayWhen(n.starts_at)}`, n.ends_expected_at && `Expected to end ${sayWhen(n.ends_expected_at)}`].filter(Boolean).join('. ')) : null,
      n.issued_by_name ? h('p', null, h('strong', null, 'Issued by: '), n.issued_by_name, h('span', { class: 'muted' }, ' (certified operator)')) : null,
      h('h3', null, 'Text message'), h('pre', { class: 'msg-body' }, n.sms_text),
      n.body ? h('details', null, h('summary', null, 'Longer version'), h('pre', { class: 'msg-body' }, n.body)) : null,
      n.status !== 'draft' ? h('p', null, 'Residents follow it here: ', h('a', { href: n.public_link, target: '_blank', rel: 'noopener' }, n.public_link)) : null,
      n.work_order_id ? h('p', null, h('a', { href: `#/works/${n.work_order_id}` }, `Work order ${n.work_order_id}`)) : null,
      n.preview ? h('p', { class: 'muted' }, reachWords(n.preview)) : null,
      n.status === 'scheduled' ? h('p', null, `Goes out ${fmtInstant((n.updates.find((u) => u.kind === 'first' && u.status === 'scheduled') || {}).send_at)}.`) : null,
      n.updates.some((u) => u.status !== 'scheduled' && u.status !== 'cancelled') ? h('section', null, h('h3', null, 'What was sent'), h('ul', { class: 'plain' },
        n.updates.filter((u) => u.status !== 'scheduled' && u.status !== 'cancelled').map((u) => h('li', null, h('strong', null, `${{ first: 'Notice', update: 'Update', ended: 'Ended' }[u.kind]}, ${fmtInstant(u.queued_at || u.created_at)}: `), u.kind === 'first' ? '' : `"${u.sms_text}" `, sumWords(u.summary))))) : null,
      actions());
    if (n.summary.queued || n.summary.sending) poll = setTimeout(() => again().catch(() => {}), 3000);
  }
  function actions() {
    if (!n.can_send) return null;
    const row = h('div', { class: 'row' });
    if (n.status === 'draft') {
      row.append(button('Edit', () => { dlg.close(); editor(id); }, { small: true }), sendControls(), button('Delete draft', () => confirmDialog('Delete this draft?', 'It was never sent, so nothing is kept.', 'Delete', async () => { await del(`/street-notices/${id}`); toast('Deleted'); dlg.close(); await reload(); }, { danger: true }), { small: true }));
    } else if (n.status === 'scheduled') {
      row.append(button('Unschedule', async () => { n = await post(`/street-notices/${id}/unschedule`); toast('Back to a draft'); draw(); await reload(); }, { small: true }));
    } else if (n.status === 'active') {
      row.append(button('Send an update', () => followUp(false), { kind: 'primary', small: true }), button('End notice', () => followUp(true), { small: true }));
      if (isManager() && n.summary.failed) row.append(button('Could not be delivered', problems, { small: true }));
    }
    return row;
  }
  function sendControls() {
    const t = typeOf(n.type);
    const wo = h('input', { type: 'checkbox', id: `wo-${id}` });
    const at = input({ type: 'datetime-local', min: nowInput(), 'aria-label': 'Send at' });
    const box = h('div', { class: 'stack tight' });
    const go = async (when) => {
      if (n.blanks && n.blanks.length) { toast(`Fill in the blanks first: ${n.blanks.join(', ')}`, 'error'); return; }
      const reachText = n.preview ? reachWords(n.preview) : '';
      confirmDialog(when ? 'Schedule this notice?' : 'Send this notice now?', `${reachText} ${when ? `It goes out ${sayWhen(when)}.` : 'It cannot be taken back; you can send an update or end it.'}`, when ? 'Schedule' : 'Send now', async () => {
        const r = await post(`/street-notices/${id}/send`, { confirm: true, send_at: when || null, work_order: wo.checked });
        toast(r.scheduled ? 'Scheduled' : `Sending ${plural(r.texts, 'text', 'texts')} and ${plural(r.emails, 'email', 'emails')}`);
        await again();
      });
    };
    appendAll(box,
      t.work_order && setup.assets_on ? h('label', { class: 'check', for: `wo-${id}` }, wo, ' Also open a work order for the crew') : null,
      h('div', { class: 'row' }, button('Send now', () => go(null), { kind: 'primary', small: true }), at, button('Schedule', () => { if (!at.value) { toast('Pick a day and time to schedule it', 'error'); return; } go(at.value); }, { small: true })));
    return box;
  }
  function followUp(ending) {
    const sms = h('textarea', { name: 'sms_text', rows: 3, maxlength: 320, required: !ending },
      ending ? '' : n.type === 'boil_water' ? 'The boil water advisory is lifted. Run cold water for a few minutes before using it.' : n.type === 'water_outage' ? 'Water is back on. Run the cold tap for a few minutes until it runs clear.' : '');
    const long = h('textarea', { name: 'body', rows: 4, maxlength: 4000 });
    const fields = h('div', { class: 'stack' },
      h('p', { class: 'muted' }, ending ? 'Ending closes the notice. Add a last message to send it to everyone who got the notice, or leave it empty to end it quietly.' : 'An update goes to everyone who got the notice, except anyone who has said stop since.'),
      field(ending ? 'Last message (optional)' : 'Text message', sms), field('Longer version (optional)', long));
    formDialog(ending ? 'End this notice' : 'Send an update', fields, async () => {
      const b = { sms_text: sms.value.trim() || null, body: long.value.trim() || null };
      const r = ending ? await post(`/street-notices/${id}/end`, b) : await post(`/street-notices/${id}/updates`, b);
      toast(ending ? 'Notice ended' : `Sending ${plural(r.texts, 'text', 'texts')} and ${plural(r.emails, 'email', 'emails')}`);
      await again();
    }, { submitText: ending ? 'End notice' : 'Send update' });
  }
  async function problems() {
    const r = await get(`/street-notices/${id}/problems`);
    dialog('Could not be delivered', r.data.length ? h('ul', { class: 'plain' }, r.data.map((p) => h('li', null, `${p.to_addr || '(address removed)'}: ${p.error || ''}`))) : h('p', null, 'None.'));
  }
  draw();
}

// ---------------------------------------------------------------- residents signed up
async function residents(box) {
  const r = await get('/street-notices/residents/streets');
  appendAll(box,
    h('p', null, `${plural(r.total, 'resident gets', 'residents get')} street alerts. They sign up themselves at `, h('a', { href: setup.signup_link, target: '_blank', rel: 'noopener' }, setup.signup_link), '. Put the link on your website and your water bills.'),
    h('div', { class: 'row' },
      button('Export the list', () => download('/street-notices/residents/export', 'alert-sign-ups.csv'), { small: true }),
      isManager() ? button('Export with contact details', () => confirmDialog('Export with contact details?', 'The file will hold residents’ names, phones, emails and house numbers. Pennsylvania public records requests get the list without them. This export is recorded.', 'Export',
        () => download('/street-notices/residents/export?contacts=1', 'alert-sign-ups-with-contacts.csv')), { small: true }) : null,
      isManager() ? button('Import a list', importList, { small: true }) : null),
    r.data.length ? table([
      { head: 'Street', cell: (s) => h('strong', null, s.name) },
      { head: 'Residents', num: true, cell: (s) => String(s.residents) },
      { head: 'By text', num: true, cell: (s) => String(s.phones) },
      { head: 'By email', num: true, cell: (s) => String(s.emails) },
      { head: 'Not confirmed yet', num: true, cell: (s) => (s.waiting ? String(s.waiting) : '') },
      { head: '', actions: true, cell: (s) => (s.residents || s.waiting ? button('Open', () => street(s), { small: true, label: `Open ${s.name}` }) : '') },
    ], r.data) : empty('No streets yet. Add them in Settings, Streets.'));
}

async function street(s) {
  let r;
  try { r = await get(`/street-notices/residents?street_id=${s.street_id}`); } catch (err) {
    dialog(s.name, h('p', null, err.status === 403 ? 'Managers and the front desk see who signed up. You see the counts.' : err.message));
    return;
  }
  const body = h('div');
  const draw = () => clear(body).append(r.data.length ? table([
    { head: 'Address', cell: (x) => `${x.house_number || ''}${x.unit ? `, ${x.unit}` : ''}` },
    { head: 'Name', cell: (x) => x.name || '' },
    { head: 'Text', cell: (x) => (x.by_text ? `${x.phone}${x.texts_stopped_at ? ' (stopped)' : ''}` : x.phone && x.status === 'pending' ? `${x.phone} (not confirmed)` : '') },
    { head: 'Email', cell: (x) => (x.by_email ? `${x.email}${x.emails_stopped_at ? ' (stopped)' : ''}` : x.email ? `${x.email} (not confirmed)` : '') },
    { head: 'Topics', cell: (x) => x.topics.map((k) => (setup.topics.find((t) => t.key === k) || {}).label || k).join(', ') },
    { head: '', actions: true, cell: (x) => button('Take off', () => confirmDialog('Take this sign-up off the list?', 'They get no more alerts for this address. They can sign up again themselves.', 'Take off', async () => {
      await post(`/street-notices/residents/signups/${x.id}/end`); r.data = r.data.filter((y) => y.id !== x.id); draw(); toast('Taken off');
    }, { danger: true }), { small: true }) },
  ], r.data) : empty('No one on this street yet.'));
  draw();
  dialog(`${s.name}: residents signed up`, body, { wide: true });
}

function importList() {
  const csv = h('textarea', { name: 'csv', rows: 10, required: true, placeholder: 'name,phone,email,street,house_number,unit,topics\nPat Lee,610-555-0101,,Main Street,12,,leaves' });
  const ok = h('input', { type: 'checkbox', id: 'imp-ok', name: 'consent', required: true });
  const note = input({ name: 'consent_note', maxlength: 300, required: true, placeholder: 'For example: Paper sign-up forms at the 2025 open house' });
  const fields = h('div', { class: 'stack' },
    h('p', null, 'Paste a list of residents who already agreed to get alerts from you, for example from paper forms or an older alert service. Topics can be water, streets, trash, leaves and news; water is always on.'),
    field('List (CSV with a header row)', csv), field('Where did they agree?', note),
    h('label', { class: 'check', for: 'imp-ok' }, ok, ' Every resident on this list agreed to get alert texts or emails from us. This is recorded with your name.'),
    h('p', { class: 'muted' }, 'A phone that texted STOP, or an address that used the stop link, stays stopped.'));
  formDialog('Import residents', fields, async () => {
    const r = await post('/street-notices/residents/import', { csv: csv.value, consent: ok.checked ? true : undefined, consent_note: note.value.trim() });
    toast(`${plural(r.added, 'sign-up', 'sign-ups')} added${r.already ? `, ${r.already} already there` : ''}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
    if (r.skipped.length) dialog('Rows skipped', h('ul', { class: 'plain' }, r.skipped.map((s) => h('li', null, `Line ${s.line}: ${s.reason}`))));
  }, { submitText: 'Import', wide: true });
}

// ---------------------------------------------------------------- settings
async function settings(box) {
  const s = await get('/street-notices/settings');
  const boxes = s.crew.map((c) => ({ c, el: h('input', { type: 'checkbox', id: `crew-${c.id}`, checked: s.crew_senders.includes(c.id) }) }));
  const from = input({ name: 'from_number', value: s.from_number || '', maxlength: 30, placeholder: s.default_from || '+16105550100' });
  const save = button('Save', async () => {
    await put('/street-notices/settings', { crew_senders: boxes.filter((b) => b.el.checked).map((b) => b.c.id), from_number: from.value.trim() || null });
    toast('Saved');
  }, { kind: 'primary' });
  box.append(h('div', { class: 'stack' },
    h('h2', null, 'Crew leads who may send'),
    h('p', { class: 'muted' }, 'Managers always can. Pick Crew logins who may write and send notices too, for a break after hours.'),
    boxes.length ? h('div', { class: 'stack tight' }, ...boxes.map((b) => h('label', { class: 'check', for: `crew-${b.c.id}` }, b.el, ` ${b.c.name}`))) : h('p', { class: 'muted' }, 'No Crew logins yet.'),
    h('h2', null, 'Texting number'),
    field('Your own number (optional)', from, `Empty: texts come from the shared Verdynt/OS number${s.default_from ? ` (${s.default_from})` : ''}. A number of your own is set up with Verdynt/OS support first.`),
    h('p', { class: 'muted small' }, `For whoever sets up the number in Twilio: replies such as STOP go to ${s.inbound_url}`),
    h('div', { class: 'row' }, save)));
}
