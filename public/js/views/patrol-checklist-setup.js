// Settings > Patrol > Checklists (the patrol admin): which built-in checklists patrollers see on a case, and the
// patrol's own lists. A list that is on suggests itself when it fits a case and can always be added by hand; a list
// that is off is not offered on new cases. Lists are never deleted: one the patrol no longer wants is archived, and
// every case that used it still shows its ticks in the words they were ticked under.
import { get, post, put, patch } from '../api.js';
import { h, clear, input, select, field, button, toast, fail, errorBox, formDialog, confirmDialog, dialog, state } from '../ui.js';
import { toggle } from './settings-kit.js';

const SCOPES = [['case', 'The whole case'], ['patient', 'One patient']];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function drawChecklistSetup(panel) {
  const body = h('div', { class: 'stack cl-setup' });
  clear(panel).append(body);
  let data;
  async function load() {
    try { data = await get('/patrol/checklists/setup'); } catch (err) { clear(body).append(errorBox(err)); return; }
    draw();
  }

  const typeLabel = (k) => ((data.attraction_types || []).find((x) => x.key === k) || {}).label || k;

  function preview(l) {
    dialog(l.title, [
      l.when ? h('p', { class: 'muted' }, l.when) : null,
      h('p', { class: 'small' }, `${l.scope === 'patient' ? 'For one patient' : 'For the whole case'}${(l.attraction_types || []).length ? `. Suggests itself at: ${l.attraction_types.map(typeLabel).join(', ')}` : ''}.`),
      h('ol', { class: 'cl-preview' }, l.items.map((i) => h('li', null, i.label))),
    ]);
  }

  /** One list: its title, when to use it, how many items, a preview, and its switch. */
  function listRow(l, { onSwitch, extra = [] }) {
    const sw = toggle({ checked: Boolean(l.enabled), 'aria-label': `${l.title}: ${l.enabled ? 'on' : 'off'}`, 'data-switch': l.id });
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      try { await onSwitch(sw.checked); toast(sw.checked ? `${l.title}: on` : `${l.title}: off`); l.enabled = sw.checked; sw.setAttribute('aria-label', `${l.title}: ${l.enabled ? 'on' : 'off'}`); } catch (err) { fail(err); sw.checked = !sw.checked; }
      sw.disabled = false;
    });
    const notes = [
      plural(l.items.length, 'item', 'items'),
      l.scope === 'patient' ? 'one patient' : 'whole case',
      (l.attraction_types || []).length ? `suggests itself at ${l.attraction_types.map(typeLabel).join(' or ')}` : null,
      l.cases ? `used on ${plural(l.cases, 'case', 'cases')}` : null,
    ].filter(Boolean).join(' · ');
    return h('li', { class: 'cl-row', 'data-list': l.id },
      h('div', { class: 'cl-row-text' }, h('b', { class: 'cl-row-title' }, l.title), l.when ? h('span', { class: 'cl-row-when' }, l.when) : null,
        h('span', { class: 'muted small' }, notes), l.start_note && !l.chosen ? h('span', { class: 'muted small' }, `Starts ${l.starts_on ? 'on' : 'off'}: ${l.start_note}`) : null),
      h('div', { class: 'cl-row-actions' }, button('Preview', () => preview(l), { small: true, label: `Preview ${l.title}` }), ...extra, sw));
  }

  function draw() {
    const on = data.builtin.filter((l) => l.enabled).length + data.custom.filter((l) => l.enabled && !l.archived_at).length;
    const groups = data.groups.map((g) => {
      const lists = data.builtin.filter((l) => l.group === g.key);
      if (!lists.length) return null;
      return h('section', { class: 'cl-group', 'data-group': g.key }, h('h3', null, g.label),
        h('ul', { class: 'plain cl-rows' }, lists.map((l) => listRow(l, { onSwitch: (v) => put(`/patrol/checklists/builtin/${l.id}`, { enabled: v }) }))));
    });
    const mine = data.custom.filter((l) => !l.archived_at);
    const archived = data.custom.filter((l) => l.archived_at);
    const ownRows = mine.map((l) => listRow(l, {
      onSwitch: (v) => patch(`/patrol/checklists/custom/${l.db_id}`, { enabled: v }),
      extra: [
        button('Edit', () => editDialog(l), { small: true, label: `Edit ${l.title}` }),
        button('Archive', () => confirmDialog(`Archive ${l.title}?`, l.cases ? `It is no longer offered on cases. The ${plural(l.cases, 'case', 'cases')} that used it keep their ticks exactly as they were. You can bring it back later.` : 'It is no longer offered on cases. You can bring it back later.', 'Archive', async () => { await post(`/patrol/checklists/custom/${l.db_id}/archive`); await load(); }), { small: true, label: `Archive ${l.title}` }),
      ],
    }));
    clear(body).append(
      h('p', { class: 'muted' }, `Choose the checklists your patrollers see on a case. A list that is on suggests itself when it fits the case (a head injury, a minor, a collision, an attraction) and can always be added by hand. ${plural(on, 'list is', 'lists are')} on now.`),
      h('p', { class: 'muted small' }, 'Checklists are memory aids for documenting and running a scene. Your protocols and your medical director come first.'),
      ...groups,
      h('section', { class: 'cl-group', 'data-group': 'own' },
        h('div', { class: 'spread' }, h('h3', null, 'Your patrol’s own lists'), button('Write a checklist', () => editDialog(null), { small: true, kind: 'primary' })),
        mine.length ? h('ul', { class: 'plain cl-rows' }, ownRows) : h('p', { class: 'muted' }, 'None yet. Write one for something your patrol does its own way, such as a race day or a night-skiing call.'),
        archived.length ? h('details', { class: 'cl-archived' }, h('summary', null, `Archived (${archived.length})`),
          h('ul', { class: 'plain cl-rows' }, archived.map((l) => h('li', { class: 'cl-row', 'data-list': l.id },
            h('div', { class: 'cl-row-text' }, h('b', null, l.title), h('span', { class: 'muted small' }, `${plural(l.items.length, 'item', 'items')}${l.cases ? ` · used on ${plural(l.cases, 'case', 'cases')}` : ''}`)),
            h('div', { class: 'cl-row-actions' }, button('Preview', () => preview(l), { small: true, label: `Preview ${l.title}` }), state('Archived'),
              button('Bring back', async () => { await post(`/patrol/checklists/custom/${l.db_id}/restore`); toast('Brought back'); await load(); }, { small: true, label: `Bring back ${l.title}` })))))) : null));
  }

  /** Write or change one of the patrol's own lists: title, when, scope, attraction type and the items in order. */
  function editDialog(l) {
    const title = input({ name: 'title', maxlength: 150, required: true, value: l ? l.title : '', placeholder: 'For example: Race day crash' });
    const when = input({ name: 'when', maxlength: 300, value: l ? l.when : '', placeholder: 'One line on when to use it' });
    const scope = select(SCOPES, l ? l.scope : 'case', { name: 'scope' });
    if (l && l.cases) scope.disabled = true; // ticks already recorded belong to a patient or to the whole case
    const attraction = select([['', 'No attraction'], ...data.attraction_types.map((x) => [x.key, x.label])], l ? l.attraction_type || '' : '', { name: 'attraction_type' });
    const items = h('ol', { class: 'cl-edit-items' });
    const itemRow = (it = {}) => {
      const inp = input({ name: 'item', maxlength: 255, value: it.label || '', 'aria-label': 'Item', placeholder: 'A short, checkable action', 'data-id': it.id || '' });
      const li = h('li', { class: 'cl-edit-item' }, inp);
      const move = (d) => { const sib = d < 0 ? li.previousElementSibling : li.nextElementSibling; if (!sib) return; if (d < 0) items.insertBefore(li, sib); else items.insertBefore(sib, li); inp.focus(); };
      li.append(
        h('button', { type: 'button', class: 'btn small', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
        h('button', { type: 'button', class: 'btn small', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
        h('button', { type: 'button', class: 'btn small', 'aria-label': 'Take this item off', onclick: () => { li.remove(); if (!items.children.length) items.append(itemRow()); } }, 'Remove'));
      return li;
    };
    for (const it of (l ? l.items : [{}, {}, {}])) items.append(itemRow(it));
    const more = button('Add an item', () => { const r = itemRow(); items.append(r); r.querySelector('input').focus(); }, { small: true });
    const fields = h('div', { class: 'form' },
      field('Title', title), field('When to use it', when),
      field('Ticked for', scope, l && l.cases ? 'In use on cases, so this stays as it is.' : 'A patient list is ticked once for each patient.'),
      field('Suggest it for cases at', attraction, 'It suggests itself when the case happened at this kind of attraction.'),
      h('div', { class: 'field' }, h('span', null, 'Items, in order'), items, more,
        h('span', { class: 'hint' }, l ? 'Rewording or taking an item off never changes a case already ticked: each tick keeps the words it was ticked under.' : 'Write each as a short action someone can tick, like "Time of the fall recorded".')));
    formDialog(l ? `Edit ${l.title}` : 'Write a checklist', fields, async () => {
      const list = [...items.querySelectorAll('input[name=item]')].map((x) => ({ ...(x.dataset.id ? { id: Number(x.dataset.id) } : {}), label: x.value.trim() })).filter((x) => x.label);
      if (!title.value.trim()) throw new Error('Give the list a title');
      if (!list.length) throw new Error('Add at least one item');
      const out = { title: title.value.trim(), when: when.value.trim() || null, attraction_type: attraction.value || null, items: list };
      if (!scope.disabled) out.scope = scope.value;
      if (l) await patch(`/patrol/checklists/custom/${l.db_id}`, out);
      else await post('/patrol/checklists/custom', { ...out, scope: scope.value });
      toast(l ? 'Saved' : 'Checklist added and switched on');
      await load();
    }, { wide: true, submitText: l ? 'Save' : 'Add checklist' });
  }

  await load();
}
