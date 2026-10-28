// The lost-person search on a case: who is missing (description, clothing, phone), where and when they were last seen,
// the areas being searched and by whom (each patroller is alerted with their area), and when and where they were found.
import { get, post, put } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, errorBox, state, fmtTime, nowInput, label } from '../ui.js';

export function searchPanel(c, { editable, roster = [], trails = [] }) {
  const box = h('section', { class: 'panel stack search-panel', 'data-area': 'search' }, h('p', { class: 'loading' }, 'Loading the search…'));
  const base = `/patrol/incidents/${c.id}/search`;
  async function load() {
    try { draw(await get(base)); } catch (err) { clear(box).append(errorBox(err)); }
  }
  function draw(d) {
    const s = d.search || {};
    const open = d.areas.filter((a) => a.status !== 'searched').length;
    clear(box).append(...[
      h('div', { class: 'spread' }, h('h2', null, 'Lost person search'), s.outcome ? state(label(s.outcome), s.outcome === 'not_found' ? 'bad' : 'good') : state(`${open} area${open === 1 ? '' : 's'} being searched`, open ? 'warn' : 'neutral')),
      h('div', { class: 'search-who' },
        h('p', null, h('b', null, s.person_name || 'Name not recorded'), s.age_years != null ? `, ${s.age_years}` : '', s.phone ? `, phone ${s.phone}` : ''),
        s.description ? h('p', null, h('b', null, 'Looks like: '), s.description) : null,
        s.clothing ? h('p', null, h('b', null, 'Wearing: '), s.clothing) : null,
        h('p', null, h('b', null, 'Last seen: '), s.last_seen_at ? `${fmtTime(String(s.last_seen_at).replace(' ', 'T'))}, ` : '', s.last_seen_place || 'not recorded'),
        s.reported_by ? h('p', { class: 'muted small' }, `Reported by ${s.reported_by}`) : null,
        s.found_at ? h('p', null, h('b', null, 'Found: '), `${fmtTime(String(s.found_at).replace(' ', 'T'))}${s.found_place ? `, ${s.found_place}` : ''}`) : null),
      editable ? h('div', { class: 'row' }, button('Edit details', () => detailsDialog(s), { small: true }), !s.outcome ? button('Found or returned', () => foundDialog(s), { small: true, kind: 'primary' }) : null) : null,
      h('h3', null, 'Search areas'),
      d.areas.length ? h('ul', { class: 'duty-list' }, d.areas.map((a) => h('li', null,
        state(a.status === 'searched' ? `Searched ${fmtTime(String(a.searched_at).replace(' ', 'T'))}` : 'Searching', a.status === 'searched' ? 'good' : 'warn'), ' ',
        h('b', null, a.area), a.trail ? ` (${a.trail})` : '', a.staff_name ? `, ${a.staff_name}` : '', a.note ? h('span', { class: 'muted' }, `. ${a.note}`) : null,
        editable && a.status !== 'searched' ? button('Searched', async () => { await post(`${base}/areas/${a.id}/searched`, {}); toast('Area marked searched'); await load(); }, { small: true }) : null)))
        : h('p', { class: 'muted small' }, 'No areas assigned yet.'),
      editable ? button('Assign an area', () => areaDialog(), { small: true }) : null].filter(Boolean));
  }
  function detailsDialog(s) {
    formDialog('Missing person', h('div', { class: 'form' },
      field('Name', input({ name: 'person_name', maxlength: 150, value: s.person_name || '' })), field('Age', input({ name: 'age_years', type: 'number', min: 0, max: 120, value: s.age_years ?? '' })),
      field('Phone', input({ name: 'phone', type: 'tel', maxlength: 40, value: s.phone || '' })), field('Reported by', input({ name: 'reported_by', maxlength: 255, value: s.reported_by || '', placeholder: 'Name and phone' })),
      h('div', { class: 'wide' }, field('What they look like', input({ name: 'description', maxlength: 500, value: s.description || '' }))),
      h('div', { class: 'wide' }, field('Clothing and equipment', input({ name: 'clothing', maxlength: 500, value: s.clothing || '', placeholder: 'Red jacket, black helmet, blue snowboard' }))),
      field('Last seen at', input({ name: 'last_seen_at', type: 'datetime-local', value: s.last_seen_at ? String(s.last_seen_at).slice(0, 16).replace(' ', 'T') : '' })),
      field('Last seen where', input({ name: 'last_seen_place', maxlength: 255, value: s.last_seen_place || '' }))), async (fd) => {
      const v = (k) => String(fd.get(k) || '').trim() || null;
      await put(base, { person_name: v('person_name'), age_years: fd.get('age_years') === '' ? null : Number(fd.get('age_years')), phone: v('phone'), reported_by: v('reported_by'), description: v('description'), clothing: v('clothing'), last_seen_at: v('last_seen_at'), last_seen_place: v('last_seen_place') });
      toast('Saved'); await load();
    }, { submitText: 'Save', wide: true });
  }
  function foundDialog() {
    formDialog('Found or returned', h('div', { class: 'form' },
      field('Outcome', select([['found_well', 'Found, well'], ['found_injured', 'Found, injured (add them as a patient)'], ['self_returned', 'Came back on their own'], ['not_found', 'Not found: search stood down'], ['other', 'Other']], 'found_well', { name: 'outcome' })),
      field('When', input({ name: 'found_at', type: 'datetime-local', value: nowInput() })), h('div', { class: 'wide' }, field('Where', input({ name: 'found_place', maxlength: 255 })))), async (fd) => {
      await put(base, { outcome: fd.get('outcome'), found_at: fd.get('found_at') || null, found_place: String(fd.get('found_place') || '').trim() || null });
      toast('Saved'); await load();
    }, { submitText: 'Save' });
  }
  function areaDialog() {
    formDialog('Assign a search area', h('div', { class: 'form' },
      h('div', { class: 'wide' }, field('Area', input({ name: 'area', required: true, maxlength: 150, placeholder: 'Trees skier\'s left of Upper Ridge' }))),
      field('Run', select([['', 'None'], ...trails.map((t) => [t.id, t.name])], '', { name: 'trail_id' })),
      field('Who', select([['', 'Not assigned'], ...roster.filter((m) => m.staff_status === 'active').map((m) => [m.staff_id, `${m.first_name} ${m.last_name}`])], '', { name: 'staff_id' }), 'They get an alert on their phone'),
      h('div', { class: 'wide' }, field('Instructions', input({ name: 'note', maxlength: 255 })))), async (fd) => {
      await post(`${base}/areas`, { area: String(fd.get('area')).trim(), trail_id: fd.get('trail_id') ? Number(fd.get('trail_id')) : null, staff_id: fd.get('staff_id') ? Number(fd.get('staff_id')) : null, note: String(fd.get('note') || '').trim() || null });
      toast('Area assigned'); await load();
    }, { submitText: 'Assign' });
  }
  load();
  return box;
}

/** The records requests on one case and its legal hold, for the Record view. */
export function recordsPanel(c, { canManage }) {
  const box = h('section', { class: 'panel stack', 'data-area': 'records' });
  get(`/patrol/incidents/${c.id}/records`).then((r) => {
    clear(box).append(...[h('h2', null, 'Requests for this report'),
      r.data.length ? h('ul', { class: 'duty-list' }, r.data.map((x) => h('li', null, state(label(x.status), x.status === 'released' ? 'good' : x.status === 'open' ? 'warn' : 'neutral'), ` ${x.requester_name} (${label(x.requester_kind)}), received ${String(x.received_on).slice(0, 10)}${x.release_no ? `, ${x.release_no}` : ''}`)))
        : h('p', { class: 'muted small' }, 'No requests for this report.'),
      canManage ? h('a', { class: 'btn small', href: '#/patrol/cases?tab=records' }, 'Records requests') : null].filter(Boolean));
  }).catch(() => box.remove());
  return box;
}
