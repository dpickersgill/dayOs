// Customer extras: the photo, family and guardians, duplicate finder and merge, and the season pass renewal list.
import { get, post, put, del } from '../api.js';
import { h, clear, can, isManager, table, state, select, field, button, toast, dialog, formDialog, confirmDialog, fmtDate, empty, errorBox, label } from '../ui.js';
import { personPicker } from '../widgets.js';
import { photoControl } from '../photo.js';

const fullName = (p) => `${p.first_name} ${p.last_name}`;

/** The customer's photo with a way to take or replace it. */
export function photoSection(person, onChange) {
  const box = h('div', { class: 'stack', 'data-section': 'photo' });
  async function draw() {
    clear(box);
    let current = null;
    if (person.has_photo) { try { current = (await get(`/people/${person.id}/photo`)).photo; } catch (_) { /* not shown */ } }
    const ctl = photoControl({ has: Boolean(person.has_photo), current, label: 'Photo for season passes and the gate' });
    box.append(ctl.el, h('div', { class: 'row' },
      button('Save photo', async () => {
        const v = ctl.value();
        if (!v) throw new Error('Take or choose a picture first');
        await put(`/people/${person.id}/photo`, { photo: v });
        person.has_photo = true;
        toast('Photo saved');
        if (onChange) onChange();
        await draw();
      }, { small: true, kind: 'primary' }),
      person.has_photo ? button('Remove photo', async () => { await del(`/people/${person.id}/photo`); person.has_photo = false; toast('Photo removed'); if (onChange) onChange(); await draw(); }, { small: true }) : null));
  }
  draw();
  return box;
}

/** Parents, children and household on file, with a way to link and unlink people. */
export function familySection(person) {
  const box = h('div', { class: 'stack', 'data-section': 'family' });
  async function draw() {
    clear(box);
    let fam;
    try { fam = await get(`/people/${person.id}/family`); } catch (err) { box.append(errorBox(err)); return; }
    const group = (title, list) => (list.length ? h('div', { class: 'stack tight' }, h('strong', null, title), h('ul', { class: 'plain' }, list.map((p) => h('li', { class: 'spread' },
      h('span', null, fullName(p), p.age !== null && p.age !== undefined ? h('span', { class: 'muted' }, ` (${p.age})`) : null),
      button('Unlink', async () => { await del(`/people/${person.id}/family/${p.id}`); await draw(); }, { small: true }))))) : null);
    const any = fam.guardians.length || fam.dependents.length || fam.household.length;
    box.append(h('div', { class: 'stack' },
      any ? [group('Parents and guardians', fam.guardians), group('Children and dependents', fam.dependents), group('Household and family', fam.household)] : h('p', { class: 'muted' }, 'No family linked yet. A child is linked to a parent automatically when a parent buys for them.'),
      h('div', { class: 'row' }, button('Link a family member', () => link(), { small: true }))));
  }
  function link() {
    const pick = personPicker({ label: 'Find the person', required: true });
    const how = select([['guardian_of', `${person.first_name} is their parent or guardian (they are a child)`], ['dependent_of', `They are ${person.first_name}'s parent or guardian`], ['family', 'Family or household (partner, sibling, ...)']], 'guardian_of', { name: 'how' });
    formDialog(`Link family to ${fullName(person)}`, h('div', { class: 'stack' }, pick.el, field('How are they connected?', how)), async () => {
      const other = pick.get();
      if (!other) throw new Error('Find and choose the person first');
      const body = how.value === 'family' ? { other_id: other.id, relation: 'family' } : { other_id: other.id, relation: 'guardian', as: how.value };
      await post(`/people/${person.id}/family`, body);
      toast('Linked');
      await draw();
    }, { submitText: 'Link' });
  }
  draw();
  return box;
}

/** Customers who look like the same person, and a way to merge them into one record. */
export async function duplicatesDialog(done) {
  const body = h('div', { class: 'stack' });
  const dlg = dialog('Possible duplicate customers', body, { wide: true });
  async function draw() {
    clear(body);
    let out;
    try { out = await get('/people/duplicates'); } catch (err) { body.append(errorBox(err)); return; }
    if (!out.data.length) { body.append(empty('No duplicates found. Customers with the same name and date of birth, or the same name and phone number, would be listed here.')); return; }
    body.append(h('p', { class: 'muted' }, 'Merging moves everything one record bought, signed and booked onto the other, fills any blanks, and removes the extra record. It cannot be undone.'));
    for (const group of out.data) {
      body.append(h('section', { class: 'panel stack', 'data-dup-group': '' }, table([
        { head: 'Name', cell: (p) => h('strong', null, fullName(p)) },
        { head: 'Born', cell: (p) => p.date_of_birth || '' },
        { head: 'Phone', cell: (p) => p.phone || '' },
        { head: 'Email', cell: (p) => p.email || '' },
        { head: 'Added', cell: (p) => fmtDate(String(p.created_at).slice(0, 10)) },
        { head: '', actions: true, cell: (p) => (group.length === 2
          ? button(`Keep this one`, () => merge(group.find((x) => x.id !== p.id), p), { small: true })
          : button('Merge others into this', async () => { for (const o of group.filter((x) => x.id !== p.id)) await merge(o, p, true); await draw(); }, { small: true })) },
      ], group)));
    }
  }
  function merge(from, into, quiet) {
    const run = async () => { await post(`/people/${from.id}/merge`, { into_id: into.id }); toast('Merged'); if (done) await done(); await draw(); };
    if (quiet) return run();
    confirmDialog('Merge these two customers?', `${fullName(from)} (${from.phone || from.email || `#${from.id}`}) will be merged into ${fullName(into)} and removed. Everything they bought, signed and booked moves to ${fullName(into)}.`, 'Merge', run);
    return null;
  }
  await draw();
  return dlg;
}

/** Season passes that ended or are about to, for whoever has not bought another: the renewal call list. */
export async function renewalsDialog() {
  const body = h('div', { class: 'stack' });
  dialog('Season pass renewals', body, { wide: true });
  try {
    const out = await get('/passes/renewals');
    body.append(h('p', { class: 'muted' }, `Passes that ended in the last 120 days or end in the next 45, for people who have not bought a newer one. ${out.renewed ? `${out.renewed} already renewed.` : ''}`),
      out.data.length ? table([
        { head: 'Holder', cell: (r) => h('strong', null, `${r.first_name} ${r.last_name}`) },
        { head: 'Pass', cell: (r) => r.product },
        { head: 'Ends', cell: (r) => fmtDate(r.valid_to) },
        { head: 'Status', cell: (r) => state(r.expired ? 'Ended' : 'Ending soon', r.expired ? 'bad' : 'warn') },
        { head: 'Phone', cell: (r) => r.phone || '' },
        { head: 'Email', cell: (r) => (r.email ? h('a', { href: `mailto:${encodeURIComponent(r.email)}` }, r.email) : '') },
      ], out.data) : empty('Everyone with a season pass has renewed.'));
  } catch (err) { body.append(errorBox(err)); }
}
export { can, isManager, label };
