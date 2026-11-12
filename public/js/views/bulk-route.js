// Bulk pickup, Route order (release 2026.11.20): the order the truck drives the streets on each collection weekday, and
// for each street which way the house numbers go. The Collection day stop list follows it; a street not in the route
// comes at the end with a note. Managers drag streets into order (or use Up and Down, on a phone or with a keyboard);
// everyone else sees the order.
import { get, put } from '../api.js';
import { h, clear, appendAll, button, select, toast, fail, empty, hashParam } from '../ui.js';

export async function routeTab(panel) {
  let weekday = hashParam('weekday') !== null && hashParam('weekday') !== '' ? Number(hashParam('weekday')) : null;
  const body = h('div', { class: 'stack' });
  panel.append(body);
  async function load() {
    const r = await get(`/solid-waste/route${weekday !== null ? `?weekday=${weekday}` : ''}`);
    weekday = r.weekday;
    let order = r.route.map((x) => ({ street_id: x.street_id, name: x.name, direction: x.direction, stops: x.stops_last_year }));
    let rest = r.not_in_route.map((x) => ({ street_id: x.street_id, name: x.name, direction: 'up', stops: x.stops_last_year }));
    const daySel = select(r.collection_days.map((d) => [d.weekday, d.name]).concat(r.collection_days.some((d) => d.weekday === r.weekday) ? [] : [[r.weekday, r.weekday_name]]), r.weekday, { 'aria-label': 'Collection day' });
    daySel.addEventListener('change', () => { weekday = Number(daySel.value); load().catch(fail); });
    const listEl = h('ol', { class: 'route-list' });
    const restEl = h('ul', { class: 'plain route-rest' });
    let dirty = false;
    const save = button('Save the route', async () => {
      try { await put('/solid-waste/route', { weekday, streets: order.map((x) => ({ street_id: x.street_id, direction: x.direction })) }); dirty = false; toast(`Route saved for ${r.weekday_name}s`); draw(); } catch (err) { fail(err); }
    }, { kind: 'primary' });
    const move = (i, to) => { if (to < 0 || to >= order.length) return; const [x] = order.splice(i, 1); order.splice(to, 0, x); dirty = true; draw(); };
    let dragFrom = null;
    function draw() {
      save.disabled = !dirty;
      clear(listEl).append(...order.map((x, i) => {
        const dir = select([['up', 'Numbers going up'], ['down', 'Numbers going down']], x.direction, { 'aria-label': `House numbers on ${x.name}`, disabled: !r.can_edit });
        dir.addEventListener('change', () => { x.direction = dir.value; dirty = true; draw(); });
        const li = h('li', { class: 'route-row', draggable: r.can_edit ? 'true' : 'false', dataset: { i: String(i) } },
          h('span', { class: 'route-grip', 'aria-hidden': 'true' }, r.can_edit ? '☰' : ''),
          h('span', { class: 'route-name' }, h('strong', null, x.name), x.stops ? h('span', { class: 'muted small' }, ` ${x.stops} stops in the last year`) : null),
          dir,
          r.can_edit ? h('span', { class: 'row' },
            button('Up', () => move(i, i - 1), { small: true, label: `Move ${x.name} up` }),
            button('Down', () => move(i, i + 1), { small: true, label: `Move ${x.name} down` }),
            button('Take out', () => { order.splice(i, 1); rest = [...rest, x].sort((a, b) => a.name.localeCompare(b.name)); dirty = true; draw(); }, { small: true, label: `Take ${x.name} out of the route` })) : null);
        li.addEventListener('dragstart', (e) => { dragFrom = i; li.classList.add('dragging'); try { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; } catch (_) { /* old browsers */ } });
        li.addEventListener('dragend', () => li.classList.remove('dragging'));
        li.addEventListener('dragover', (e) => { if (dragFrom !== null) { e.preventDefault(); li.classList.add('drop-here'); } });
        li.addEventListener('dragleave', () => li.classList.remove('drop-here'));
        li.addEventListener('drop', (e) => { e.preventDefault(); li.classList.remove('drop-here'); if (dragFrom !== null && dragFrom !== i) move(dragFrom, i); dragFrom = null; });
        return li;
      }));
      clear(restEl).append(...rest.map((x, i) => h('li', { class: 'spread' }, h('span', null, x.name, x.stops ? h('span', { class: 'muted small' }, ` ${x.stops} stops in the last year`) : null),
        r.can_edit ? button('Add to the end', () => { rest.splice(i, 1); order.push(x); dirty = true; draw(); }, { small: true, label: `Add ${x.name} to the route` }) : null)));
    }
    appendAll(clear(body),
      h('p', null, 'The order the truck drives the streets on this collection day, and which way the house numbers go on each. The stop list follows it. A street that is not in the route comes at the end, with a note.'),
      h('div', { class: 'row' }, daySel, r.can_edit ? save : null, r.can_edit && order.length ? button('Clear', () => { rest = [...rest, ...order].sort((a, b) => a.name.localeCompare(b.name)); order = []; dirty = true; draw(); }, { small: true }) : null),
      order.length || r.can_edit ? h('section', { class: 'stack tight' }, h('h2', null, `Driving order on ${r.weekday_name}s`), order.length ? null : h('p', { class: 'muted' }, 'No order yet: stops are listed by street name. Add the streets in the order the truck drives them.'), listEl) : empty('No route order yet: stops are listed by street name.'),
      r.can_edit && rest.length ? h('section', { class: 'stack tight' }, h('h2', null, 'Not in the route'), restEl) : null);
    draw();
  }
  await load();
}
