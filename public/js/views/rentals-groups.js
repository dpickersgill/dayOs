// Rentals, Groups: a school or club renting together. Add the members (paste a list, or send the leader a link so parents
// fill in the rental form), check everyone's details, signature and waiver, set the gear aside the night before and print
// a bag label for each member. In the morning, scan a bag label to hand that bag out, or hand out the whole group at once.

import { get, post, patch, put, del } from '../api.js';
import { h, clear, state, input, select, field, button, toast, dialog, formDialog, confirmDialog, empty, table, fmtDate, label, val, todayStr } from '../ui.js';
import { printDialog } from '../print.js';
import { code128 } from '../barcode.js';
import { sizesText, useForm } from './rentals-forms.js';

const nameOf = (p) => `${p.first_name} ${p.last_name}`;
const gearName = (i) => [i.brand, i.model, i.size].filter(Boolean).join(' ');
const dayText = (g) => (g.days > 1 ? `${fmtDate(g.rental_on)} for ${g.days} days` : fmtDate(g.rental_on));
const STATUS = { open: ['Getting ready', 'neutral'], set: ['Gear set aside', 'good'], out: ['Gear out', 'neutral'], returned: ['Returned', 'neutral'], closed: ['Closed', 'neutral'] };

export async function drawGroups(box) {
  const { data } = await get('/rentals/groups');
  const reload = () => drawGroups(box);
  const scan = input({ type: 'text', placeholder: 'Scan a bag label, then Enter', 'aria-label': 'Scan a bag label', autocomplete: 'off' });
  scan.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim(); scan.value = '';
    if (!code) return;
    try { await scanBag(code); } catch (err) { toast(err.message, 'error'); }
  });
  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'scan-bar' }, field('Morning hand-out', scan, 'Scan the barcode on a bag label. That member\'s gear goes out if their waiver and signed details are in.')),
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Schools and clubs that rent together. Set their gear aside the night before.'), button('New group', () => editGroup(null, (newId) => drawGroup(box, newId)), { kind: 'primary' })),
    data.length ? table([
      { head: 'Group', cell: (g) => h('span', null, h('strong', null, g.name), g.leader_name ? h('span', { class: 'muted' }, ` · ${g.leader_name}`) : null) },
      { head: 'Day', cell: (g) => dayText(g) },
      { head: 'Members', cell: (g) => `${g.members}${g.set_aside ? ` · ${g.set_aside} set aside` : ''}${g.out_now ? ` · ${g.out_now} out` : ''}` },
      { head: 'Forms', cell: (g) => (g.forms_waiting ? state(`${g.forms_waiting} waiting`, 'warn') : '') },
      { head: 'Status', cell: (g) => state(...(STATUS[g.status] || [label(g.status), 'neutral'])) },
      { head: '', actions: true, cell: (g) => button('Open', () => drawGroup(box, g.id), { small: true, kind: 'primary' }) },
    ], data) : empty('No groups coming up. Add one when a school or club books.')));
  scan.focus();
}

async function scanBag(code) {
  const r = await post('/rentals/groups/scan', { code });
  if (r.out) toast(`${r.name}: gear handed out`);
  else toast(`${r.name}: ${r.skipped}`, 'error');
  return r;
}

function editGroup(g, done) {
  const f = h('div', { class: 'form' },
    field('Group name', input({ name: 'name', required: true, maxlength: 120, value: g ? g.name : '', placeholder: 'School, club or family name' })),
    field('Rental day', input({ name: 'day', type: 'date', required: true, value: g ? g.rental_on : todayStr() })),
    field('Days', input({ name: 'days', type: 'number', min: '1', max: '30', value: g ? g.days : 1 })),
    field('Leader', input({ name: 'leader', maxlength: 120, value: g && g.leader_name ? g.leader_name : '' })),
    field('Leader phone', input({ name: 'phone', type: 'tel', maxlength: 30, value: g && g.leader_phone ? g.leader_phone : '' })),
    field('Leader email', input({ name: 'email', type: 'email', maxlength: 255, value: g && g.leader_email ? g.leader_email : '' }), 'The parents link is sent here'),
    field('Notes', input({ name: 'notes', maxlength: 500, value: g && g.notes ? g.notes : '', placeholder: 'Bus time, billing, anything the shop should know' })));
  formDialog(g ? `Edit ${g.name}` : 'New group', f, async (fd) => {
    const body = { name: val(fd, 'name'), rental_on: val(fd, 'day'), days: Number(val(fd, 'days') || 1), leader_name: val(fd, 'leader'), leader_phone: val(fd, 'phone'), leader_email: val(fd, 'email') || '', notes: val(fd, 'notes') };
    const r = g ? await patch(`/rentals/groups/${g.id}`, body) : await post('/rentals/groups', body);
    toast(g ? 'Group saved' : 'Group added');
    await done(g ? g.id : r.id);
  }, { wide: true });
}

// ---------------------------------------------------------------- one group
async function drawGroup(box, id) {
  const d = await get(`/rentals/groups/${id}`);
  const g = d.group;
  const reload = () => drawGroup(box, id);
  const back = () => drawGroups(box);
  const missingWaiver = d.members.filter((m) => !m.waiver_signed);
  const ready = d.members.filter((m) => m.status === 'to_fit' && m.gear.length);
  const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch (_) { dialog(what, h('p', { class: 'rform-url' }, text)); } };
  const yesNo = (ok, yes, no, kind = 'bad') => state(ok ? yes : no, ok ? 'good' : kind);

  const members = d.members.length ? table([
    { head: 'Member', cell: (m) => h('span', null, h('strong', null, nameOf(m)), m.age != null ? h('span', { class: 'muted' }, `, ${m.age}`) : null) },
    { head: 'Sizes', cell: (m) => h('span', { class: 'small' }, sizesText(m) || 'None yet') },
    { head: 'Checks', cell: (m) => h('span', { class: 'row' }, yesNo(m.details_in, 'Details in', 'Details missing', 'warn'), yesNo(m.signed, 'Signed', 'Not signed', d.require_signoff ? 'bad' : 'neutral'), yesNo(m.waiver_signed, 'Waiver', 'No waiver')) },
    { head: 'Gear', cell: (m) => (m.gear.length ? h('span', { class: 'small' }, m.gear.map((x) => `${x.sku} ${label(x.category)}${x.size ? ` ${x.size}` : ''}${x.din_setting != null ? ` (setting ${Number(x.din_setting)})` : ''}`).join(', ')) : h('span', { class: 'muted small' }, 'Not set aside')) },
    { head: '', actions: true, cell: (m) => (m.status === 'to_fit' ? h('span', { class: 'row' },
      button(m.gear.length ? 'Change gear' : 'Set aside gear', () => gearDialog(d, m, reload), { small: true, kind: m.gear.length ? undefined : 'primary' }),
      m.gear.length ? button('Hand out', async () => { const r = await scanBag(m.code); if (r.out) await reload(); }, { small: true }) : null,
      button('Remove', () => confirmDialog(`Remove ${nameOf(m)}?`, 'They come off the group and any gear set aside for them goes back on the rack.', 'Remove', async () => { await del(`/rentals/groups/${id}/members/${m.contract_id}`); toast('Removed'); await reload(); }, { danger: true }), { small: true }))
      : state(label(m.status), m.status === 'out' ? 'neutral' : 'good')) },
  ], d.members) : empty('No members yet. Paste a list, or send the leader the link for parents.');

  clear(box).append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('div', null, button('Back to groups', back, { small: true })), h('span', { class: 'row' },
      button('Edit', () => editGroup(g, reload), { small: true }),
      g.status !== 'closed' ? button('Close group', () => confirmDialog(`Close ${g.name}?`, 'Members still waiting come off, and gear set aside for them goes back on the rack. Do this once everything is back.', 'Close group', async () => { await patch(`/rentals/groups/${id}`, { status: 'closed' }); toast('Group closed'); await back(); }), { small: true }) : null)),
    h('div', { class: 'panel stack' },
      h('div', { class: 'spread' }, h('h2', null, g.name), state(...(STATUS[g.status] || [label(g.status), 'neutral']))),
      h('p', null, `${dayText(g)}${g.leader_name ? ` · Leader: ${g.leader_name}` : ''}${g.leader_phone ? ` · ${g.leader_phone}` : ''}${g.leader_email ? ` · ${g.leader_email}` : ''}`),
      g.notes ? h('p', { class: 'muted' }, g.notes) : null,
      h('p', { class: 'small muted' }, 'Billing: take payment for the group as one sale in Sell, and note the order number here with Edit.')),
    h('div', { class: 'panel stack' }, h('h3', null, 'Link for parents'),
      h('p', { class: 'small muted' }, 'Parents open it on a phone and fill in the rental form for each child: sizes, ability and a signature. Their forms show below to add to the group.'),
      h('p', { class: 'rform-url' }, d.link),
      h('div', { class: 'row' }, button('Copy link', () => copy(d.link, 'Link')), g.leader_email && d.email_ready ? button('Email it to the leader', async () => { const r = await post(`/rentals/groups/${id}/send-link`, {}); toast(`Sent to ${r.to}`); }) : null)),
    missingWaiver.length ? h('div', { class: 'callout stack' }, h('strong', null, `${missingWaiver.length} without a waiver for ${d.season}: ${missingWaiver.map(nameOf).join(', ')}`),
      h('p', { class: 'small' }, 'Everyone wearing gear needs a signed waiver for the season. A bag cannot be handed out without one.'),
      d.waiver_link ? h('div', { class: 'row' }, button('Copy the waiver link', () => copy(d.waiver_link, 'Waiver link')), h('span', { class: 'small muted' }, 'Send it to the leader or the parents.')) : h('p', { class: 'small muted' }, 'Add your waiver wording in Waivers to get a signing link.')) : null,
    d.forms.length ? h('div', { class: 'panel stack' }, h('h3', null, `${d.forms.length} form${d.forms.length === 1 ? '' : 's'} from parents to add`),
      ...d.forms.map((f) => h('div', { class: 'spread' }, h('span', null, h('strong', null, f.people.map(nameOf).join(', ')), h('span', { class: 'small muted' }, ` from ${f.contact_name}${f.phone ? `, ${f.phone}` : ''}`)),
        button('Add to group', () => useForm(f.id, reload), { small: true, kind: 'primary' })))) : null,
    h('div', { class: 'spread' }, h('h3', null, `Members (${d.members.length})`), h('span', { class: 'row' },
      button('Add members', () => addMembers(id, reload), { small: true }),
      ready.length ? button('Print bag labels', () => printLabels(d, ready), { small: true }) : null,
      ready.length ? button('Hand out all', () => handOutAll(d, ready, reload), { small: true, kind: 'primary' }) : null)),
    members));
}

// ---------------------------------------------------------------- adding members from a list
const ABILITY_IN = { cautious: '1', moderate: '2', aggressive: '3', 1: '1', 2: '2', 3: '3', i: '1', ii: '2', iii: '3' };
function parseDob(s) {
  const t = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  const y = m[3].length === 2 ? (Number(m[3]) > 30 ? `19${m[3]}` : `20${m[3]}`) : m[3];
  return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
function parseHeight(s) {
  const t = String(s || '').trim();
  const fi = /^(\d)\s*(?:'|ft)\s*(\d{1,2})?/.exec(t);
  if (fi) return Number(fi[1]) * 12 + Number(fi[2] || 0);
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
/** One member per line: name, date of birth, height, weight, boot size, ability. Commas or tabs between. */
export function parseMembers(text) {
  const rows = []; const problems = [];
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).forEach((line, n) => {
    const c = line.split(/\t|,/).map((x) => x.trim());
    if (n === 0 && /name/i.test(c[0])) return; // a header row
    const parts = c[0].split(/\s+/);
    if (parts.length < 2) { problems.push(`Line ${n + 1}: give a first and last name`); return; }
    const r = { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] };
    if (c[1]) { r.date_of_birth = parseDob(c[1]); if (!r.date_of_birth) { problems.push(`Line ${n + 1}: date of birth "${c[1]}" (use 2014-03-09 or 3/9/2014)`); return; } }
    if (c[2]) r.height_in = parseHeight(c[2]);
    if (c[3]) r.weight_lb = parseInt(c[3], 10) || null;
    if (c[4]) r.boot_size = c[4].slice(0, 10);
    if (c[5]) { r.skier_type = ABILITY_IN[c[5].toLowerCase()] || null; if (!r.skier_type) { problems.push(`Line ${n + 1}: ability "${c[5]}" (use cautious, moderate or aggressive)`); return; } }
    rows.push(r);
  });
  return { rows, problems };
}

function addMembers(id, done) {
  const ta = h('textarea', { name: 'list', rows: 10, 'aria-label': 'Member list', placeholder: 'Sam Oak, 2014-03-09, 54, 80, 4, cautious\nTia Elm, 5/1/2015, 4\'4", 75, 3, moderate' });
  formDialog('Add members', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'One member per line: name, date of birth, height, weight, boot size, ability. Copy the columns from a spreadsheet, or type them with commas. Only the name is needed; the rest can come from the parents link.'),
    h('p', { class: 'small muted' }, 'Height in inches or like 4\'6". Ability: cautious, moderate or aggressive.'), ta), async () => {
    const { rows, problems } = parseMembers(ta.value);
    if (problems.length) throw new Error(problems.slice(0, 3).join('. '));
    if (!rows.length) throw new Error('Add at least one member');
    const r = await post(`/rentals/groups/${id}/members`, { rows });
    toast(`${r.added} added${r.already ? `, ${r.already} already in the group` : ''}`);
    await done();
  }, { submitText: 'Add members', wide: true });
}

// ---------------------------------------------------------------- setting gear aside
async function gearDialog(d, m, done) {
  const kinds = m.discipline === 'snowboard' ? ['snowboard', 'boot', 'helmet'] : ['ski', 'boot', 'pole', 'helmet'];
  const lists = await Promise.all(kinds.map((k) => get(`/rentals/items?category=${k}&status=available&limit=500`)));
  const mine = new Map(m.gear.map((x) => [x.category, x]));
  const wantSize = { boot: m.boot_size || '' };
  const sizeNum = (s) => parseFloat(s);
  const rowsOf = kinds.map((k, i) => {
    let items = lists[i].data;
    const cur = mine.get(k);
    if (cur && !items.some((x) => x.id === cur.rental_item_id)) items = [{ id: cur.rental_item_id, sku: cur.sku, category: k, brand: cur.brand, model: cur.model, size: cur.size }, ...items];
    // the closest sizes first for boots; the rest by size
    const target = sizeNum(wantSize[k]);
    items = [...items].sort((a, b) => (Number.isFinite(target) ? Math.abs((sizeNum(a.size) || 999) - target) - Math.abs((sizeNum(b.size) || 999) - target) : 0) || String(a.size || '').localeCompare(String(b.size || ''), undefined, { numeric: true }));
    const sel = select([['', 'None'], ...items.map((x) => [String(x.id), `${x.size ? `${x.size} · ` : ''}${x.sku}${gearName(x) ? ` · ${gearName(x)}` : ''}`])], cur ? String(cur.rental_item_id) : '', { 'aria-label': label(k) });
    return { k, sel, cur };
  });
  const board = rowsOf.find((r) => r.k === 'ski');
  const cur = board && board.cur;
  const din = input({ type: 'number', step: '0.25', min: '0.5', max: '20', value: cur && cur.din_setting != null ? Number(cur.din_setting) : '', 'aria-label': 'Binding setting', style: 'width:6rem' });
  const tech = input({ maxlength: 100, value: cur && cur.tech_name ? cur.tech_name : '', 'aria-label': 'Set by', placeholder: 'Set by', style: 'width:9rem' });
  const test = select([['', 'Test'], ['pass', 'Passed'], ['fail', 'Failed']], cur && cur.test_result ? cur.test_result : '', { 'aria-label': 'Binding test' });
  const hint = h('p', { class: 'small muted', role: 'status' });
  const suggest = button('Suggest from the chart', async () => {
    if (!m.skier_type) throw new Error('Add the ability first (from the parents form, or Remove and add the member again)');
    const q = new URLSearchParams({ skier_type: m.skier_type, ...(m.weight_lb ? { weight_lb: m.weight_lb } : {}), ...(m.height_in ? { height_in: m.height_in } : {}), ...(m.boot_sole_mm ? { sole_mm: m.boot_sole_mm } : {}) });
    const res = (await get(`/rentals/chart/suggest?${q}`)).data;
    if (!res.length) { hint.textContent = 'Nothing in your chart matches. Set it by your shop procedure.'; return; }
    din.value = Number(res[0].din);
    hint.textContent = `Your chart says ${Number(res[0].din)} for type ${m.skier_type}, ${m.weight_lb || '?'} lb. Check it against the binding maker's chart before you set it.`;
  }, { small: true });
  formDialog(`Gear for ${nameOf(m)}`, h('div', { class: 'stack' },
    h('p', { class: 'muted' }, sizesText(m) || 'No sizes yet.'),
    h('div', { class: 'form' }, ...rowsOf.map((r) => field(label(r.k), r.sel))),
    board ? h('div', { class: 'stack tight' }, h('strong', null, 'Binding'), h('div', { class: 'row' }, din, tech, test, suggest), hint) : null,
    h('p', { class: 'small muted' }, 'The gear is held for this member and cannot be rented to anyone else until it is handed out or put back.')), async () => {
    const items = rowsOf.filter((r) => r.sel.value).map((r) => ({ rental_item_id: Number(r.sel.value),
      ...(r.k === 'ski' && din.value !== '' ? { din_setting: Number(din.value) } : {}), ...(r.k === 'ski' && tech.value.trim() ? { tech_name: tech.value.trim() } : {}), ...(r.k === 'ski' && test.value ? { test_result: test.value } : {}) }));
    await put(`/rentals/groups/${d.group.id}/members/${m.contract_id}/gear`, { items });
    toast(items.length ? 'Gear set aside' : 'Gear put back');
    await done();
  }, { submitText: 'Set aside', wide: true });
}

// ---------------------------------------------------------------- bag labels and hand-out
function printLabels(d, ready) {
  printDialog(`Bag labels for ${d.group.name}`, h('div', { class: 'tag-sheet' }, ...ready.map((m) => h('article', { class: 'bag-label', 'data-sheet': 'bag' },
    h('div', { class: 'bag-name' }, nameOf(m)),
    h('div', { class: 'small' }, `${d.group.name} · ${fmtDate(d.group.rental_on)}`),
    h('div', { class: 'small' }, sizesText(m)),
    h('ul', { class: 'bag-gear' }, ...m.gear.map((x) => h('li', null, `${x.sku} ${label(x.category)}${x.size ? ` ${x.size}` : ''}${x.din_setting != null ? `, setting ${Number(x.din_setting)}${x.tech_name ? ` by ${x.tech_name}` : ''}` : ''}`))),
    code128(m.code, { height: 40, module: 1.6 }), h('div', { class: 'small' }, m.code)))));
}

function handOutAll(d, ready, done) {
  confirmDialog(`Hand out all of ${d.group.name}?`, `${ready.length} bag${ready.length === 1 ? '' : 's'} with gear set aside go out to the leader now. Members without a waiver or signed details stay behind and are listed.`, 'Hand out', async () => {
    const r = await post(`/rentals/groups/${d.group.id}/handout`, {});
    toast(`${r.out.length} handed out`);
    if (r.skipped.length) dialog('Not handed out', h('div', { class: 'stack' }, h('p', null, 'These members are not ready:'), h('ul', null, ...r.skipped.map((s) => h('li', null, h('strong', null, s.name), `: ${s.skipped}`)))));
    await done();
  });
}
