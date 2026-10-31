// Prospects in the platform console: the ski areas we are selling to, the people there, where each one is in the
// pipeline and what happens next. Opened from the Mountains page; uses the console's own session (passed in).

import { h, clear, button, field, input, select, table, dialog, formDialog, confirmDialog, toast, fail, empty, errorBox } from './ui.js';
import { openOutreach, OUTREACH_STATUS } from './platform-outreach.js';

let ctx = null; // { app, call, session(), back(), signIn() }
let meta = { stages: [], roles: [], note_kinds: [], patrol_kinds: [], regions: [], states: [] };
const query = { q: '', stage: 'open', region: '', state: '', priority: '', due: '' };

const PRIORITY = [[1, 'High'], [2, 'Medium'], [3, 'Low']];
const NOTE_NAMES = { note: 'Note', call: 'Call', email: 'Email', meeting: 'Meeting', demo: 'Demo', visit: 'Visit', stage: 'Stage' };
const OFFER_NAMES = { ski_school: 'ski school', rentals: 'rentals', terrain_park: 'terrain park', night_skiing: 'night skiing', tubing: 'tubing', summer_ops: 'summer operations' };
const roleName = (k) => (meta.roles.find(([v]) => v === k) || [k, k])[1];
const today = () => new Date().toISOString().slice(0, 10);
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const when = (t) => (t ? new Date(String(t).replace(' ', 'T') + (String(t).endsWith('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const link = (href, text) => (href ? h('a', { href, target: '_blank', rel: 'noopener' }, text || href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) : null);
const prio = (p) => h('span', { class: p === 1 ? 'badge warn' : 'badge' }, (PRIORITY.find(([v]) => v === p) || [0, ''])[1]);
const sizeLine = (p) => [p.vertical_ft ? `${p.vertical_ft.toLocaleString('en-US')} ft vertical` : null, p.lifts ? `${p.lifts} lift${p.lifts === 1 ? '' : 's'}` : null, p.trails ? `${p.trails} trails` : null, p.acres ? `${p.acres} acres` : null].filter(Boolean).join(', ');

export function openProspects(c) { ctx = c; draw(); }

function stageSelect(value, attrs = {}) { return select(meta.stages, value, attrs); }

async function draw() {
  const { app, call } = ctx;
  clear(app);
  const body = h('div', { class: 'stack' });
  const chips = h('div', { class: 'row wrap' });
  const search = input({ type: 'search', placeholder: 'Find a ski area, town or person', 'aria-label': 'Find a ski area, town or person', value: query.q });
  const stageSel = select([['open', 'Open (not won or closed)'], ['', 'Every stage'], ...meta.stages], query.stage, { 'aria-label': 'Stage' });
  const regionSel = select([['', 'All regions'], ...meta.regions.map((r) => [r, r])], query.region, { 'aria-label': 'Region' });
  const stateSel = select([['', 'All states'], ...meta.states.map((s) => [s, s])], query.state, { 'aria-label': 'State' });
  const prioSel = select([['', 'Any priority'], ...PRIORITY.map(([v, t]) => [String(v), `${t} priority`])], query.priority, { 'aria-label': 'Priority' });
  app.append(h('main', { class: 'platform-box wider stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'stack tight' }, h('h1', null, 'Prospects'), h('p', { class: 'muted' }, 'Ski areas to sell to, who runs them, and what happens next. Only operators see this.')),
      h('div', { class: 'row' }, button('Back to mountains', () => ctx.back(), { small: true }), button('Add a ski area', () => editProspect(null), { kind: 'primary' }), button('Outreach', () => openOutreach({ ...ctx, backToProspects: () => openProspects(ctx) }), { small: true }), button('Import research', () => importDialog(), { small: true }), button('Download spreadsheet', () => download().catch(fail), { small: true }))),
    chips,
    h('div', { class: 'row wrap prospect-filters' }, search, stageSel, regionSel, stateSel, prioSel),
    body));
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query.q = search.value.trim(); load(); }, 250); });
  stageSel.addEventListener('change', () => { query.stage = stageSel.value; query.due = ''; load(); });
  regionSel.addEventListener('change', () => { query.region = regionSel.value; load(); });
  stateSel.addEventListener('change', () => { query.state = stateSel.value; load(); });
  prioSel.addEventListener('change', () => { query.priority = prioSel.value; load(); });

  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading…'));
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
    let r;
    try { r = await call('GET', `/prospects${qs ? `?${qs}` : ''}`); } catch (ex) { clear(body); if (ex.status === 403) ctx.signIn('Your session ended. Sign in again.'); else body.append(errorBox(ex)); return; }
    const first = !meta.stages.length;
    meta = { stages: r.stages, roles: r.roles, note_kinds: r.note_kinds, patrol_kinds: r.patrol_kinds, regions: r.regions, states: r.states };
    if (first) { draw(); return; } // the filters need the stage, region and state lists
    if (regionSel.options.length !== r.regions.length + 1 || stateSel.options.length !== r.states.length + 1) { draw(); return; }
    clear(chips).append(...[
      ...meta.stages.filter(([k]) => r.counts[k]).map(([k, t]) => button(`${t} ${r.counts[k]}`, () => { query.stage = k; query.due = ''; draw(); }, { small: true, kind: query.stage === k ? 'primary' : undefined })),
      r.due ? button(`Follow-ups due ${r.due}`, () => { query.due = '1'; query.stage = ''; draw(); }, { small: true, kind: query.due ? 'primary' : 'danger' }) : null,
    ].filter(Boolean));
    clear(body);
    if (!r.data.length) { body.append(empty(query.q || query.state || query.region || query.priority || query.due ? 'No ski areas match.' : 'No prospects yet. Add a ski area, or import a research file.')); return; }
    body.append(h('p', { class: 'muted small' }, `${r.data.length} ski area${r.data.length === 1 ? '' : 's'}`), table([
      { head: 'Priority', cell: (p) => prio(p.priority) },
      { head: 'Ski area', cell: (p) => h('div', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openProspect(p.id); } }, h('b', null, p.name)), h('div', { class: 'small muted' }, [p.town, p.state].filter(Boolean).join(', ')), h('div', { class: 'small muted' }, [sizeLine(p), p.indy_pass ? 'Indy Pass' : null].filter(Boolean).join(' · '))) },
      { head: 'Who runs it', cell: (p) => (p.leader ? h('div', null, p.leader.name, h('div', { class: 'small muted' }, p.leader.title || roleName(p.leader.role))) : h('span', { class: 'muted' }, 'Not found yet')) },
      { head: 'People', num: true, cell: (p) => String(p.contact_count) },
      { head: 'Stage', cell: (p) => { const sel = stageSelect(p.stage, { 'aria-label': `Stage for ${p.name}`, style: 'min-width:10em' }); sel.addEventListener('change', async () => { try { await call('PATCH', `/prospects/${p.id}`, { stage: sel.value }); toast('Saved.'); } catch (ex) { fail(ex); } }); return sel; } },
      { head: 'Next step', cell: (p) => (p.next_step || p.next_on ? h('div', null, p.next_step || '', p.next_on ? h('div', { class: 'small' }, String(p.next_on).slice(0, 10) <= today() ? h('span', { class: 'badge bad' }, `Due ${day(p.next_on)}`) : h('span', { class: 'muted' }, day(p.next_on))) : null) : h('span', { class: 'muted' }, '')) },
      { actions: true, cell: (p) => button('Open', () => openProspect(p.id), { small: true }) },
    ], r.data));
  }
  await load();
  ctx.reload = load;
}

async function download() {
  const res = await fetch('/api/v1/platform/prospects/export.csv', { headers: { 'x-platform-session': ctx.session() } });
  if (!res.ok) { let m = 'Could not download'; try { m = (await res.json()).error || m; } catch (_) { /* not JSON */ } throw new Error(m); }
  const a = h('a', { href: URL.createObjectURL(await res.blob()), download: `verdynt-prospects-${today()}.csv` });
  document.body.append(a); a.click(); a.remove();
}

function importDialog() {
  const file = input({ type: 'file', name: 'file', accept: '.json,application/json', required: true });
  formDialog('Import research', [
    h('p', null, 'A research file of ski areas (JSON). The research files are in the research folder of the release zip. Load each one once: a file you loaded before is not loaded again.'),
    h('p', null, 'Ski areas already on the list keep what you have changed: only empty facts are filled in, and only new people are added. Indy Pass resorts are left out.'),
    field('File', file),
  ], async () => {
    if (!file.files[0]) throw new Error('Choose a file');
    let body;
    try { body = JSON.parse(await file.files[0].text()); } catch (_) { throw new Error('That file is not JSON'); }
    const r = await ctx.call('POST', '/prospects/import', body);
    if (r.already) { toast(`"${r.batch}" was loaded before. Nothing changed.`); return; }
    toast(`Added ${r.added} ski area${r.added === 1 ? '' : 's'}, filled in ${r.updated}, and added ${r.contacts} ${r.contacts === 1 ? 'person' : 'people'}.${r.skipped ? ` Left out ${r.skipped} Indy Pass resort${r.skipped === 1 ? '' : 's'}.` : ''}`);
    draw();
  }, { submitText: 'Import' });
}

function editProspect(p) {
  const v = p || {};
  const f = {
    name: input({ name: 'name', required: true, maxlength: 150, value: v.name || '' }),
    town: input({ name: 'town', maxlength: 120, value: v.town || '' }),
    state: input({ name: 'state', maxlength: 2, value: v.state || '', style: 'width:4em' }),
    region: input({ name: 'region', maxlength: 60, value: v.region || '', list: 'prospect-regions' }),
    website: input({ name: 'website', type: 'url', maxlength: 500, value: v.website || '', placeholder: 'https://' }),
    phone: input({ name: 'phone', type: 'tel', maxlength: 60, value: v.phone || '' }),
    ownership: input({ name: 'ownership', maxlength: 600, value: v.ownership || '' }),
    vertical_ft: input({ name: 'vertical_ft', type: 'number', min: 0, max: 10000, value: v.vertical_ft ?? '' }),
    lifts: input({ name: 'lifts', type: 'number', min: 0, max: 100, value: v.lifts ?? '' }),
    trails: input({ name: 'trails', type: 'number', min: 0, max: 500, value: v.trails ?? '' }),
    acres: input({ name: 'acres', type: 'number', min: 0, max: 20000, value: v.acres ?? '' }),
    indy: select([['', 'Not known'], ['yes', 'Yes'], ['no', 'No']], v.indy_pass === true ? 'yes' : v.indy_pass === false ? 'no' : '', { name: 'indy' }),
    patrol: select([['', 'Not known'], ...meta.patrol_kinds.map((k) => [k, k === 'NSP volunteer' ? 'Volunteer (NSP)' : k === 'paid' ? 'Paid' : 'Paid and volunteer'])], v.patrol || '', { name: 'patrol' }),
    fit: h('textarea', { name: 'fit_notes', rows: 3, maxlength: 2000 }, v.fit_notes || ''),
    priority: select(PRIORITY.map(([n, t]) => [String(n), t]), String(v.priority || 2), { name: 'priority' }),
  };
  const n = (x) => (x.value === '' ? null : Number(x.value));
  formDialog(p ? `Edit ${p.name}` : 'Add a ski area', [
    h('datalist', { id: 'prospect-regions' }, meta.regions.map((r) => h('option', { value: r }))),
    field('Name', f.name),
    h('div', { class: 'row wrap' }, field('Town', f.town), field('State', f.state, 'Two letters'), field('Region', f.region)),
    h('div', { class: 'row wrap' }, field('Website', f.website), field('Main phone', f.phone)),
    field('Who owns or runs it', f.ownership, 'For example: family-owned, nonprofit, the town'),
    h('div', { class: 'row wrap' }, field('Vertical (ft)', f.vertical_ft), field('Lifts', f.lifts), field('Trails', f.trails), field('Acres', f.acres)),
    h('div', { class: 'row wrap' }, field('Indy Pass', f.indy), field('Patrol', f.patrol), field('Priority', f.priority)),
    field('Why they fit', f.fit),
  ], async () => {
    const body = {
      name: f.name.value.trim(), town: f.town.value, state: f.state.value.trim() || null, region: f.region.value, website: f.website.value.trim(), phone: f.phone.value,
      ownership: f.ownership.value, vertical_ft: n(f.vertical_ft), lifts: n(f.lifts), trails: n(f.trails), acres: n(f.acres),
      indy_pass: f.indy.value === 'yes' ? true : f.indy.value === 'no' ? false : null, patrol: f.patrol.value || null, fit_notes: f.fit.value, priority: Number(f.priority.value),
    };
    if (p) { await ctx.call('PATCH', `/prospects/${p.id}`, body); toast('Saved.'); openProspect(p.id); } else { const r = await ctx.call('POST', '/prospects', body); toast('Added.'); openProspect(r.id); }
    if (ctx.reload) ctx.reload();
  }, { wide: true, submitText: p ? 'Save' : 'Add' });
}

function editContact(p, c, after) {
  const v = c || { role: 'general_manager' };
  const f = {
    role: select(meta.roles, v.role, { name: 'role' }),
    name: input({ name: 'name', maxlength: 120, value: v.name || '' }),
    title: input({ name: 'title', maxlength: 200, value: v.title || '' }),
    email: input({ name: 'email', type: 'email', maxlength: 200, value: v.email || '' }),
    phone: input({ name: 'phone', type: 'tel', maxlength: 80, value: v.phone || '' }),
    source: input({ name: 'source_url', type: 'url', maxlength: 500, value: v.source_url || '', placeholder: 'https://' }),
    note: input({ name: 'note', maxlength: 500, value: v.note || '' }),
  };
  formDialog(c ? `Edit ${c.name || roleName(c.role)}` : `Add a person at ${p.name}`, [
    h('div', { class: 'row wrap' }, field('Role', f.role), field('Name', f.name)),
    field('Title', f.title, 'As they use it, for example "General Manager"'),
    h('div', { class: 'row wrap' }, field('Email', f.email), field('Phone', f.phone)),
    field('Where this came from', f.source, 'A link, so the name can be checked again later'),
    field('Note', f.note),
  ], async () => {
    const body = { role: f.role.value, name: f.name.value, title: f.title.value, email: f.email.value, phone: f.phone.value, source_url: f.source.value, note: f.note.value };
    if (c) await ctx.call('PATCH', `/prospects/${p.id}/contacts/${c.id}`, body); else await ctx.call('POST', `/prospects/${p.id}/contacts`, body);
    toast('Saved.');
    after();
  }, { wide: true });
}

async function openProspect(id) {
  const { call } = ctx;
  let p;
  try { p = await call('GET', `/prospects/${id}`); } catch (ex) { fail(ex); return; }
  const refresh = () => { dlg.close(); openProspect(id); if (ctx.reload) ctx.reload(); };

  // The pipeline: stage, priority, next step and date, plan of interest.
  const stage = stageSelect(p.stage, { 'aria-label': 'Stage' });
  const priority = select(PRIORITY.map(([n, t]) => [String(n), t]), String(p.priority), { 'aria-label': 'Priority' });
  const next = input({ maxlength: 300, value: p.next_step || '', placeholder: 'For example: call the GM about a demo', 'aria-label': 'Next step' });
  const nextOn = input({ type: 'date', value: p.next_on ? String(p.next_on).slice(0, 10) : '', 'aria-label': 'Next step date' });
  const plan = select([['', 'Not known yet'], ['Lodge', 'Lodge'], ['Mountain', 'Mountain'], ['Resort', 'Resort'], ['Patrol only', 'Patrol only']], p.plan_interest || '', { 'aria-label': 'Plan they would fit' });
  const savePipe = button('Save', async () => {
    try {
      await call('PATCH', `/prospects/${p.id}`, { stage: stage.value, priority: Number(priority.value), next_step: next.value, next_on: nextOn.value || null, plan_interest: plan.value || null });
      toast('Saved.'); refresh();
    } catch (ex) { fail(ex); }
  }, { kind: 'primary', small: true });

  const offers = Object.entries(p.offers || {}).filter(([, on]) => on).map(([k]) => OFFER_NAMES[k] || k);
  const facts = h('dl', { class: 'kv' },
    ...[
      ['Where', [p.town, p.state].filter(Boolean).join(', ') + (p.region ? ` (${p.region})` : '')],
      ['Website', link(p.website)],
      ['Main phone', p.phone ? h('a', { href: `tel:${p.phone.replace(/[^\d+]/g, '')}` }, p.phone) : null],
      ['Owner', p.ownership],
      ['Size', sizeLine(p)],
      ['Indy Pass', p.indy_pass === null ? null : p.indy_pass ? 'Yes' : 'No'],
      ['Patrol', p.patrol === 'NSP volunteer' ? 'Volunteer (NSP)' : p.patrol === 'paid' ? 'Paid' : p.patrol === 'mixed' ? 'Paid and volunteer' : null],
      ['Runs', offers.length ? offers.join(', ') : null],
      ['Software today', (p.software || []).length ? p.software.map((s) => [s.area, s.vendor].filter(Boolean).join(': ')).join('; ') : null],
      ['Why they fit', p.fit_notes],
      ['Researched', p.checked_on ? day(p.checked_on) : null],
      ['Their mountain', p.tenant_slug ? `${p.tenant_slug} (a Verdynt/OS mountain)` : null],
    ].filter(([, val]) => val).flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)]));

  const people = p.contacts.length ? table([
    { head: 'Role', cell: (c) => roleName(c.role) },
    { head: 'Name', cell: (c) => h('div', null, c.name || h('span', { class: 'muted' }, 'No name'), c.title ? h('div', { class: 'small muted' }, c.title) : null, c.note ? h('div', { class: 'small' }, c.note) : null) },
    { head: 'Reach them', cell: (c) => h('div', null, c.email ? h('div', null, h('a', { href: `mailto:${c.email}` }, c.email)) : null, c.phone ? h('div', null, c.phone) : null) },
    { head: 'Source', cell: (c) => (c.source_url ? link(c.source_url, 'Source') : '') },
    { head: 'Outreach', cell: (c) => (c.outreach ? h('div', null, OUTREACH_STATUS[c.outreach.status] || c.outreach.status, c.outreach.step ? h('div', { class: 'small muted' }, `${c.outreach.step} of 5 sent`) : null)
      : c.email ? button('Start outreach', async () => { try { const r = await call('POST', '/outreach/enroll', { contact_ids: [c.id] }); const x = r.data[0]; toast(x.id ? 'First email drafted. Approve it under Outreach.' : `Not started: ${x.skipped}.`, x.id ? 'ok' : 'error'); refresh(); } catch (ex) { fail(ex); } }, { small: true }) : h('span', { class: 'muted small' }, 'No email')) },
    { actions: true, cell: (c) => h('div', { class: 'row' }, button('Edit', () => editContact(p, c, refresh), { small: true }), button('Remove', () => confirmDialog('Remove this person?', `${c.name || roleName(c.role)} comes off ${p.name}.`, 'Remove', async () => { await call('DELETE', `/prospects/${p.id}/contacts/${c.id}`); toast('Removed.'); refresh(); }, { danger: true }), { small: true })) },
  ], p.contacts) : empty('No people yet.');

  const kind = select(meta.note_kinds.map((k) => [k, NOTE_NAMES[k] || k]), 'call', { 'aria-label': 'What happened' });
  const text = h('textarea', { rows: 2, maxlength: 4000, placeholder: 'What happened, what they said, what was agreed', 'aria-label': 'Note' });
  const addNote = button('Add to timeline', async () => {
    if (!text.value.trim()) { toast('Write the note first.', 'error'); return; }
    try { await call('POST', `/prospects/${p.id}/notes`, { kind: kind.value, body: text.value.trim() }); toast('Added.'); refresh(); } catch (ex) { fail(ex); }
  }, { small: true });
  const timeline = p.notes.length ? h('ul', { class: 'timeline prospect-log' }, p.notes.map((n) => h('li', null, h('div', { class: 'small muted' }, `${NOTE_NAMES[n.kind] || n.kind}, ${when(n.created_at)}${n.actor ? `, ${n.actor}` : ''}`), h('div', { style: 'white-space:pre-wrap' }, n.body)))) : h('p', { class: 'muted' }, 'Nothing yet.');

  const dlg = dialog(p.name, h('div', { class: 'stack' },
    h('section', { class: 'panel stack' }, h('h3', null, 'Pipeline'),
      h('div', { class: 'row wrap' }, field('Stage', stage), field('Priority', priority), field('Plan they would fit', plan)),
      h('div', { class: 'row wrap' }, field('Next step', next), field('On', nextOn)), h('div', { class: 'row' }, savePipe)),
    h('section', { class: 'panel stack' }, h('div', { class: 'row between' }, h('h3', null, 'About the ski area'), button('Edit', () => { dlg.close(); editProspect(p); }, { small: true })), facts),
    h('section', { class: 'panel stack' }, h('div', { class: 'row between' }, h('h3', null, 'People'), button('Add a person', () => editContact(p, null, refresh), { small: true })), people,
      h('p', { class: 'small muted' }, 'Names come from public sources. Check that someone is still in the role before reaching out.')),
    h('section', { class: 'panel stack' }, h('h3', null, 'Timeline'), h('div', { class: 'row wrap' }, kind, text, addNote), timeline),
    p.leads && p.leads.length ? h('section', { class: 'panel stack' }, h('h3', null, 'Requests from the website that may be theirs'), table([{ head: 'When', cell: (l) => when(l.created_at) }, { head: 'Who', cell: (l) => `${l.name} (${l.email})` }, { head: 'Wanted', cell: (l) => l.kind }, { head: 'Status', cell: (l) => l.status }], p.leads)) : null,
    (p.sources || []).length ? h('details', null, h('summary', null, `Sources (${p.sources.length})`), h('ul', null, p.sources.map((s) => h('li', null, link(s))))) : null,
    h('div', { class: 'row' }, button('Remove from the list', () => confirmDialog(`Remove ${p.name}?`, 'The ski area, its people and its timeline are deleted. A research batch already loaded will not add it back.', 'Remove', async () => { await call('DELETE', `/prospects/${p.id}`); toast('Removed.'); dlg.close(); if (ctx.reload) ctx.reload(); }, { danger: true }), { small: true })),
  ), { wide: true });
}
