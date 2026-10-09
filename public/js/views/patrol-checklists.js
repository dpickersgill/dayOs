// Short checklists that keep a response on track. Tapping an item ticks it and stamps who and when. The panel suggests the
// lists that fit this case (a collision, a minor, a head injury, a refusal, a transport) and lets a patroller add any other.

import { get, post } from '../api.js';
import { h, state, select, fmtTime, fail } from '../ui.js';

let cached = null;
export async function loadChecklists() {
  if (!cached) cached = (await get('/patrol/checklists')).data;
  return cached;
}

const HEAD_TYPES = new Set(['concussion', 'spinal']);
const HEAD_REGIONS = new Set(['head', 'neck', 'face']);
const isHeadInjury = (p) => p.injuries.some((i) => HEAD_TYPES.has(i.injury_type) || HEAD_REGIONS.has(i.body_region));

/** The lists that fit this case, as [{ list, patient }] where patient is null for a case-level list. */
export function suggested(c, defs) {
  const out = [];
  const by = (id) => defs.find((d) => d.id === id);
  if (c.category === 'collision' || c.collision || c.parties.length) out.push({ list: by('collision'), patient: null });
  for (const p of c.patients) {
    if (isHeadInjury(p)) out.push({ list: by('head_spine'), patient: p });
    if (p.age_years !== null && p.age_years !== undefined && p.age_years < 18) out.push({ list: by('minor'), patient: p });
    if (p.disposition === 'refused_care') out.push({ list: by('refusal'), patient: p });
    if (['transported_ambulance', 'transported_private'].includes(p.disposition)) out.push({ list: by('transport'), patient: p });
  }
  return out.filter((x) => x.list);
}

/** opts: { id, editable, reload, defs } */
export function checklistPanel(c, { id, editable, reload, defs }) {
  const done = (listItemKey, pid) => c.checklist.find((x) => x.item_key === listItemKey && x.patient_id === (pid || 0));
  const shown = [];
  const seen = new Set();
  const add = (list, patient) => { const k = `${list.id}:${patient ? patient.id : 0}`; if (!seen.has(k)) { seen.add(k); shown.push({ list, patient }); } };
  suggested(c, defs).forEach((x) => add(x.list, x.patient));
  // a list that already has ticks stays visible even when it no longer matches
  for (const row of c.checklist) {
    const list = defs.find((d) => d.items.some((i) => i.key === row.item_key));
    if (list) add(list, row.patient_id ? c.patients.find((p) => p.id === row.patient_id) || null : null);
  }
  const card = ({ list, patient }) => {
    const pid = patient ? patient.id : 0;
    const ticked = list.items.filter((i) => done(i.key, pid)).length;
    const items = list.items.map((i) => {
      const row = done(i.key, pid);
      const box = h('input', { type: 'checkbox', checked: Boolean(row), disabled: !editable, 'aria-label': i.label });
      box.addEventListener('change', async () => {
        box.disabled = true;
        try { await post(`/patrol/incidents/${id}/checklist`, { key: i.key, done: box.checked, ...(pid ? { patient_id: pid } : {}) }); await reload(); } catch (err) { fail(err); box.checked = !box.checked; box.disabled = false; }
      });
      return h('li', { class: row ? 'done' : '' }, h('label', { class: 'check' }, box, ' ', h('span', null, i.label)), row ? h('span', { class: 'muted small' }, ` ${fmtTime(row.done_at)}${row.done_by ? `, ${String(row.done_by).split('@')[0]}` : ''}`) : null);
    });
    return h('details', { class: 'checklist', 'data-checklist': `${list.id}${pid ? `:${pid}` : ''}`, open: false },
      h('summary', null, h('b', null, list.title), patient ? ` for ${patient.first_name} ${patient.last_name}`.trimEnd() : '', ' ', state(`${ticked} of ${list.items.length}`, ticked === list.items.length ? 'good' : 'warn')),
      h('p', { class: 'muted small' }, list.when), h('ul', { class: 'plain' }, items));
  };
  const options = defs.flatMap((l) => (l.scope === 'case' ? [[`${l.id}:0`, l.title]] : c.patients.map((p) => [`${l.id}:${p.id}`, `${l.title}: ${p.first_name} ${p.last_name}`.trim()])));
  const picker = select([['', 'Add a checklist…'], ...options.filter(([k]) => !seen.has(k))], '', { 'aria-label': 'Add a checklist' });
  const extra = [];
  picker.addEventListener('change', () => {
    if (!picker.value) return;
    const [lid, pid] = picker.value.split(':');
    const list = defs.find((d) => d.id === lid);
    const patient = Number(pid) ? c.patients.find((p) => p.id === Number(pid)) : null;
    const el = card({ list, patient });
    el.open = true;
    box.insertBefore(el, picker.parentElement);
    picker.querySelector(`option[value="${picker.value}"]`).remove();
    picker.value = '';
    extra.push(el);
  });
  const box = h('section', { class: 'panel stack', 'data-area': 'checklists' }, h('h2', null, 'Checklists'),
    shown.length ? shown.map(card) : h('p', { class: 'muted' }, 'Lists appear here when they fit the case: a collision, a minor, a head injury, a refusal, or a transport. You can add any list below.'),
    editable && options.length ? h('div', { class: 'row' }, picker) : null);
  return box;
}
