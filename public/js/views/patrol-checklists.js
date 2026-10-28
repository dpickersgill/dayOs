// Short checklists that keep a response on track. Tapping an item ticks it and stamps who and when. The panel suggests
// the lists that fit this case first (a collision, a minor, a head injury, a refusal, a transport, an attraction and
// more: each list says when it fits, src/lib/checklists.js), then "Add a checklist" offers every list the patrol has on.
// A tick with no signal waits on the phone (outbox.js) like other bedside entries, and shows as waiting to send.
// Each tick keeps the list title and item words it was ticked under, so a past case reads the same after a list changes.

import { get } from '../api.js';
import { h, state, fmtTime, fail, nowStamp, dialog, input } from '../ui.js';
import { send, pending } from '../outbox.js';

/** The lists this patrol has on (and, for a case, any list already ticked on it). */
export async function loadChecklists(caseId) {
  return (await get(`/patrol/checklists${caseId > 0 ? `?case=${caseId}` : ''}`)).data;
}

const live = (list) => (list || []).filter((x) => !x.voided_at);
const formHas = (form, rule) => Boolean(rule && form && Object.entries(rule).some(([f, vals]) => vals.includes(form[f])));

/** Does a list's `suggest` rule fit this patient? */
function fitsPatient(s, p) {
  if (!s) return false;
  if (s.injury_types && live(p.injuries).some((i) => s.injury_types.includes(i.injury_type))) return true;
  if (s.body_regions && live(p.injuries).some((i) => s.body_regions.includes(i.body_region))) return true;
  if (s.treatments && live(p.treatments).some((t) => s.treatments.includes(t.kind))) return true;
  if (s.dispositions && s.dispositions.includes(p.disposition)) return true;
  if (s.minor && p.age_years !== null && p.age_years !== undefined && p.age_years < 18) return true;
  return formHas(p.form, s.patient_form);
}
/** Does a list fit the case itself (its category, a collision, its form, the attraction it happened at)? */
function fitsCase(list, c) {
  if (c.attraction_type && (list.attraction_types || []).includes(c.attraction_type)) return true;
  const s = list.suggest;
  if (!s) return false;
  if (s.categories && s.categories.includes(c.category)) return true;
  if (s.collision && (c.collision || (c.parties || []).length)) return true;
  return formHas(c.form, s.case_form);
}

/** The lists that fit this case, as [{ list, patient }] where patient is null for a case-level list. */
export function suggested(c, defs) {
  const out = [];
  const pts = live(c.patients);
  const on = (defs || []).filter((d) => !d.off);
  for (const l of on.filter((d) => d.scope === 'case')) if (fitsCase(l, c) || pts.some((p) => fitsPatient(l.suggest, p))) out.push({ list: l, patient: null });
  for (const p of pts) for (const l of on.filter((d) => d.scope === 'patient')) if (fitsCase(l, c) || fitsPatient(l.suggest, p)) out.push({ list: l, patient: p });
  return out;
}

// Per case, while the page is open: lists added by hand (before anything is ticked) and cards left open.
const added = new Map();
const opened = new Map();
const setOf = (m, id) => { if (!m.has(id)) m.set(id, new Set()); return m.get(id); };

/** The list a tick belongs to: its stored list id, or (for an older tick) the list that holds its key. */
const listOfRow = (row, defs) => row.list_id || ((defs.find((d) => d.items.some((i) => i.key === row.item_key)) || {}).id) || null;

/** opts: { id, editable, reload, defs, frozen } */
export function checklistPanel(c, { id, editable, reload, defs = [], frozen = false }) {
  const rows = c.checklist || [];
  const path = `/patrol/incidents/${id}/checklist`;
  // ticks waiting on this phone: the last one for each item wins
  const waiting = new Map();
  if (!frozen) for (const x of pending(id)) if (x.path === path && x.body) waiting.set(`${x.body.key}:${x.body.patient_id || 0}`, x);
  const done = (key, pid) => rows.find((x) => x.item_key === key && Number(x.patient_id) === (pid || 0));
  const patientOf = (pid) => (pid ? (c.patients || []).find((p) => p.id === Number(pid)) || null : null);

  const shown = [];
  const seen = new Set();
  const add = (list, patient) => { const k = `${list.id}:${patient ? patient.id : 0}`; if (!seen.has(k)) { seen.add(k); shown.push({ list, patient }); } };
  if (!frozen) suggested(c, defs).forEach((x) => add(x.list, x.patient));
  // a list that already has ticks stays visible even when it no longer matches (or has been switched off since)
  for (const row of rows) {
    const lid = listOfRow(row, defs);
    const list = defs.find((d) => d.id === lid) || {
      // not in this patrol's lists any more (or a frozen copy): built from what was ticked, in the words of the time
      id: lid || `k_${row.item_key}`, scope: row.patient_id ? 'patient' : 'case', title: row.list_title || 'Checklist', when: '', items: [], gone: true,
    };
    add(list, patientOf(row.patient_id));
  }
  if (!frozen) for (const k of setOf(added, id)) {
    const [lid, pid] = k.split(':');
    const list = defs.find((d) => d.id === lid);
    if (list) add(list, patientOf(Number(pid)));
  }

  const card = ({ list, patient }) => {
    const pid = patient ? patient.id : 0;
    const ckey = `${list.id}:${pid}`;
    const mine = rows.filter((r) => Number(r.patient_id) === pid && listOfRow(r, defs) === list.id);
    // the items: the list as it stands, then anything ticked that is no longer on it (in the words it was ticked under)
    const items = [...list.items.map((i) => ({ key: i.key, label: i.label })), ...mine.filter((r) => !list.items.some((i) => i.key === r.item_key)).map((r) => ({ key: r.item_key, label: r.item_label || r.item_key, old: true }))]
      .filter((i) => !frozen || done(i.key, pid));
    const isOn = (i) => { const w = waiting.get(`${i.key}:${pid}`); return w ? Boolean(w.body.done) : Boolean(done(i.key, pid)); };
    const ticked = items.filter(isOn).length;
    const total = frozen ? ticked : items.length;
    const lis = items.map((i) => {
      const row = done(i.key, pid);
      const w = waiting.get(`${i.key}:${pid}`);
      const words = row && row.item_label ? row.item_label : i.label; // a tick reads as it was ticked
      const canTick = editable && !frozen && !list.gone && !i.old;
      const box = h('input', { type: 'checkbox', checked: isOn(i), disabled: !(canTick || (editable && !frozen && row)), 'data-key': i.key });
      box.addEventListener('change', async () => {
        box.disabled = true;
        setOf(opened, id).add(ckey); // keep this card open when the page redraws after the save
        const body ={ key: i.key, done: box.checked, ...(pid ? { patient_id: pid } : {}) };
        try {
          const r = await send('POST', path, body, { caseId: id, label: `${list.title}: ${i.label}${box.checked ? '' : ' (untick)'}`, offlineBody: { ...body, at: nowStamp() } });
          if (!(r && r.queued)) await reload();
        } catch (err) { fail(err); box.checked = !box.checked; box.disabled = false; }
      });
      const stamp = w ? h('span', { class: 'cl-stamp cl-waiting' }, w.error ? `Not saved: ${w.error}` : 'Waiting to send')
        : row ? h('span', { class: 'cl-stamp' }, `${fmtTime(row.done_at)}${row.done_by ? `, ${String(row.done_by).split('@')[0]}` : ''}`) : null;
      return h('li', { class: `cl-item${isOn(i) ? ' done' : ''}` }, h('label', { class: 'cl-check' }, box, h('span', { class: 'cl-label' }, words), stamp));
    });
    const titledAs = [...new Set(mine.map((r) => r.list_title).filter((x) => x && x !== list.title))];
    const el = h('details', { class: 'checklist', 'data-checklist': `${list.id}${pid ? `:${pid}` : ''}`, open: frozen || setOf(opened, id).has(ckey) },
      h('summary', null, h('span', { class: 'cl-title' }, h('b', null, list.title), patient ? ` for ${patient.first_name || ''} ${patient.last_name || ''}`.trimEnd() : ''), ' ',
        frozen ? state(`${ticked} ticked`, 'good') : state(`${ticked} of ${total}`, ticked === total && total ? 'good' : 'warn')),
      list.when ? h('p', { class: 'muted small' }, list.when) : null,
      titledAs.length ? h('p', { class: 'muted small' }, `Ticked under the title ${titledAs.map((x) => `“${x}”`).join(' and ')}.`) : null,
      list.off && !list.gone ? h('p', { class: 'muted small' }, 'This list is switched off for your patrol. It stays here because it was already used on this case.') : null,
      h('ul', { class: 'plain cl-items' }, lis));
    el.addEventListener('toggle', () => { if (el.open) setOf(opened, id).add(ckey); else setOf(opened, id).delete(ckey); });
    return el;
  };

  const box = h('section', { class: 'panel stack', 'data-area': 'checklists' }, h('h2', null, 'Checklists'));
  const cards = h('div', { class: 'stack cl-cards' }, shown.length ? shown.map(card)
    : h('p', { class: 'muted' }, frozen ? 'No checklist items were ticked on this copy.' : 'Lists appear here when they fit the case: a collision, a minor, a head injury, a refusal, a transport, or an attraction. Add any other list below.'));
  box.append(cards);

  // ---- add a checklist: every list that is on, each one tap
  const options = (defs || []).filter((l) => !l.off).flatMap((l) => (l.scope === 'case' ? [{ list: l, patient: null }] : live(c.patients).map((p) => ({ list: l, patient: p }))))
    .filter((o) => !seen.has(`${o.list.id}:${o.patient ? o.patient.id : 0}`));
  if (editable && !frozen && options.length) {
    const open = h('button', { type: 'button', class: 'btn cl-add', 'data-act': 'add-checklist' }, 'Add a checklist');
    open.addEventListener('click', () => pickDialog(options, (o) => {
      const k = `${o.list.id}:${o.patient ? o.patient.id : 0}`;
      setOf(added, id).add(k); setOf(opened, id).add(k);
      const el = card(o);
      el.open = true;
      if (!cards.querySelector('details')) cards.replaceChildren();
      cards.append(el);
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }));
    box.append(h('div', { class: 'row' }, open));
  }
  return box;
}

/** The list of lists to add, with a filter: large rows, one tap each. */
function pickDialog(options, onPick) {
  const filter = input({ type: 'search', placeholder: 'Find a list', 'aria-label': 'Find a list', class: 'cl-filter' });
  const list = h('ul', { class: 'plain cl-pick', role: 'list' });
  let dlg = null;
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = options.filter((o) => !q || `${o.list.title} ${o.list.when}`.toLowerCase().includes(q));
    list.replaceChildren(...(hits.length ? hits.map((o) => {
      const b = h('button', { type: 'button', class: 'cl-pick-btn', 'data-list': o.list.id, 'data-patient': o.patient ? o.patient.id : null },
        h('b', null, o.list.title), o.patient ? h('span', { class: 'cl-for' }, ` for ${`${o.patient.first_name || ''} ${o.patient.last_name || ''}`.trim() || 'this patient'}`) : null,
        o.list.when ? h('span', { class: 'muted small cl-when' }, o.list.when) : null);
      b.addEventListener('click', () => { dlg.close(); onPick(o); });
      return h('li', null, b);
    }) : [h('li', { class: 'muted' }, 'No list matches.')]));
  };
  filter.addEventListener('input', draw);
  draw();
  dlg = dialog('Add a checklist', [filter, list], { wide: true });
}
