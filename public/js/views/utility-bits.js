// Pieces the utilities screens share with other screens (release 2026.11.20):
//   featurePicker      find a map item by tag, kind or street (a work order's "On the map", a main break's main)
//   streetField        the street a map item is on (the map's details form)
//   utilityPanel       a map item's panel: a main's breaks, an outfall's cases, a pump station's rated flows
//   intakeChecks       on a new request: what is already open on the block, and a caller's earlier requests
//   requestChecks      on an open request: the same, for one that came in from the public page
import { get, post } from '../api.js';
import { h, clear, button, field, input, select, state, can, fmtDateTime, fmtDate, toast, fail } from '../ui.js';

const debounce = (fn, ms = 250) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/**
 * A search box that picks one map item. name: the form field the item's id goes in. value: { id, label } when one is
 * picked already. kinds: limit to these kinds. Returns the element; el.value() gives the id or null.
 */
export function featurePicker({ name = 'map_feature_id', value = null, kinds = [], placeholder = 'Tag, kind or street: V-114, hydrant, Market Street', onPick = null } = {}) {
  const hidden = h('input', { type: 'hidden', name, value: value ? String(value.id) : '' });
  const box = input({ type: 'search', placeholder, autocomplete: 'off', 'aria-label': 'Find on the map', value: value ? value.label : '' });
  const list = h('ul', { class: 'plain picker-list', role: 'listbox', hidden: true });
  const chosen = h('p', { class: 'small muted', role: 'status' }, value ? `Picked: ${value.label}` : '');
  const pick = (f) => {
    hidden.value = f ? String(f.id) : ''; box.value = f ? f.label : ''; list.hidden = true; clear(list);
    chosen.textContent = f ? `Picked: ${f.label}` : 'Nothing picked';
    if (onPick) onPick(f);
  };
  const find = debounce(async () => {
    const q = box.value.trim();
    if (q.length < 2) { list.hidden = true; return; }
    try {
      const { data } = await get(`/assets/map/search?q=${encodeURIComponent(q)}${kinds.length ? `&kinds=${kinds.join(',')}` : ''}`);
      clear(list).append(...(data.length ? data.map((f) => h('li', null, button(f.label, () => pick(f), { small: true }))) : [h('li', { class: 'muted small' }, 'Nothing on the map matches.')]));
      list.hidden = false;
    } catch (_) { list.hidden = true; }
  });
  box.addEventListener('input', () => { if (!box.value.trim()) pick(null); else find(); });
  // Enter picks the first match instead of sending the form.
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = list.querySelector('button'); if (b && !list.hidden) b.click(); } });
  const el = h('div', { class: 'stack tight feature-picker' }, hidden, h('div', { class: 'row' }, box, button('Clear', () => pick(null), { small: true })), list, chosen);
  el.value = () => (hidden.value ? Number(hidden.value) : null);
  return el;
}

let streetCache = null;
/** A Street select for a map item (the streets list, loaded once). */
export function streetField(value) {
  const sel = select([['', 'Not set']], value || '', { name: 'street_id' });
  (streetCache || (streetCache = get('/requests/streets').then((r) => r.data).catch(() => []))).then((list) => {
    for (const s of list) sel.append(h('option', { value: String(s.id), selected: Number(value) === Number(s.id) }, s.name));
  });
  return field('Street', sel, 'Finds it by street, and lists the valves along a main.');
}

/** A map item's utilities section (or null): breaks on a main, cases on an outfall, rated flows of a pump station. */
export function utilityPanel(f) {
  if (f.main_breaks) {
    const b = f.main_breaks;
    return h('section', { class: 'stack tight' }, h('h3', null, 'Breaks'),
      h('p', null, b.total ? `${b.total} recorded, ${b.in_5_years} in the last 5 years.` : 'No breaks recorded.', b.in_5_years > 2 ? h('span', null, ' ', state('Raises its condition', 'warn')) : null),
      b.list.length ? h('ul', { class: 'plain rows' }, b.list.slice(0, 8).map((x) => h('li', { class: 'spread' }, h('span', null, fmtDateTime(x.broke_at), x.boil_water ? ' (boil water)' : '', x.status === 'open' ? h('span', null, ' ', state('Open', 'warn')) : null),
        h('a', { class: 'btn small', href: `#/water?break=${x.id}` }, 'Open')))) : null,
      can('staff') ? h('p', null, h('a', { class: 'btn small', href: `#/water?new=1&main=${f.id}` }, 'Record a main break')) : null);
  }
  if (f.cases) {
    return h('section', { class: 'stack tight' }, h('h3', null, 'Illicit discharge cases'),
      f.cases.length ? h('ul', { class: 'plain rows' }, f.cases.map((c) => h('li', { class: 'spread' }, h('span', null, h('b', null, c.reference), ' ', state(c.open ? 'Open' : 'Closed', c.open ? 'warn' : 'good'), ` opened ${fmtDate(c.opened_at)}`),
        h('a', { class: 'btn small', href: `#/stormwater?tab=cases&case=${c.id}` }, 'Open')))) : h('p', { class: 'muted' }, 'None. A screening that finds a suspected illicit discharge opens one.'));
  }
  if (f.pump_gpm) {
    const rates = Object.entries(f.pump_gpm);
    return h('section', { class: 'stack tight' }, h('h3', null, 'Rated flow (Chapter 94)'),
      h('p', null, rates.length ? rates.map(([k, v]) => `${k.replace(/_hours$/, '').replace(/pump(\d)/, 'Pump $1')}: ${v} gpm`).join(', ') : 'Not entered yet. The Chapter 94 flow needs each pump’s rated flow.'),
      h('p', null, h('a', { class: 'btn small', href: '#/sewer' }, 'Open Chapter 94')));
  }
  return null;
}

// ---------------------------------------------------------------- requests
function matchList(matches, { onLink = null } = {}) {
  return h('ul', { class: 'plain rows' }, matches.map((m) => h('li', { class: 'spread' }, h('span', null, m.words, m.same_address ? h('span', null, ' ', state('Same address', 'warn')) : null),
    h('span', { class: 'row' },
      m.type === 'request' ? h('a', { class: 'btn small', href: `#/requests/r/${m.request_id}`, target: '_blank', rel: 'noopener' }, 'Look') : m.work_order_id ? h('a', { class: 'btn small', href: `#/works/${m.work_order_id}`, target: '_blank', rel: 'noopener' }, 'Look') : null,
      onLink ? onLink(m) : null))));
}

/**
 * For the New request form: watches its What, Street, House number, Phone and Email and shows what is already open on the
 * block ("Open: R-1042 pothole at 111 Market Street, reported 2 days ago") with Link as duplicate / Add as new, and the
 * caller's earlier requests (Front desk and managers). Put el in the form after the place and el.callerEl after the
 * resident's contact; after the request is saved, call el.after(saved).
 */
export function intakeChecks() {
  const dupBox = h('div', { class: 'stack tight', role: 'status', 'aria-live': 'polite' });
  const callerBox = h('div', { class: 'stack tight wide', 'aria-live': 'polite' });
  let choice = null; // { match } to link as a duplicate, or null to add as new
  const el = h('div', { class: 'stack tight intake-checks wide' }, dupBox);
  el.callerEl = callerBox; // goes after the resident's phone and email
  const drawDup = (matches) => {
    clear(dupBox);
    choice = null;
    if (!matches.length) return;
    const radios = h('div', { class: 'stack tight' });
    const opt = (value, text, m) => {
      const r = h('input', { type: 'radio', name: 'dup_choice', value, checked: value === 'new' });
      r.addEventListener('change', () => { choice = value === 'new' ? null : { match: m }; });
      return h('label', { class: 'check' }, r, ` ${text}`);
    };
    radios.append(opt('new', 'Add as new'), ...matches.map((m, i) => opt(`m${i}`, m.request_id ? `Link as duplicate of ${m.reference}` : `Link to work order ${m.work_order_id}`, m)));
    dupBox.append(h('div', { class: 'warn-note stack tight' }, h('strong', null, matches.length === 1 ? 'This may be reported already' : `${matches.length} open on this block may be the same problem`), matchList(matches), radios));
  };
  const check = debounce(async (form) => {
    const cat = form.querySelector('[name=category_id]'); const st = form.querySelector('[name=street_id]'); const no = form.querySelector('[name=house_number]');
    if (!cat || !st || !cat.value || !st.value) { drawDup([]); return; }
    try { drawDup((await get(`/requests/checks/similar?category_id=${cat.value}&street_id=${st.value}&house_number=${encodeURIComponent(no ? no.value.trim() : '')}`)).matches); } catch (_) { drawDup([]); }
  });
  const caller = debounce(async (form) => {
    if (!can('counter')) return;
    const ph = form.querySelector('[name=phone]'); const em = form.querySelector('[name=email]');
    const phone = ph ? ph.value.replace(/\D/g, '') : ''; const email = em ? em.value.trim() : '';
    const q = phone.length >= 10 ? `phone=${encodeURIComponent(phone)}` : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? `email=${encodeURIComponent(email)}` : null;
    clear(callerBox);
    if (!q) return;
    try {
      const { requests } = await get(`/requests/checks/callers?${q}`);
      if (requests.length) callerBox.append(h('div', { class: 'panel stack tight' }, h('strong', null, `This caller’s earlier requests (${requests.length})`), h('ul', { class: 'plain' }, requests.map((r) => h('li', null, h('a', { href: `#/requests/r/${r.id}`, target: '_blank', rel: 'noopener' }, r.words))))));
      else callerBox.append(h('p', { class: 'muted small' }, 'No earlier requests from this caller.'));
    } catch (_) { /* nothing to add */ }
  });
  // Wired to the form once it is on the page.
  let tries = 0;
  const wire = () => {
    const form = el.closest('form');
    if (!form) { if (!el.isConnected && (tries += 1) < 40) setTimeout(wire, 50); return; }
    form.addEventListener('change', (e) => { if (['category_id', 'street_id', 'house_number'].includes(e.target.name)) check(form); if (['phone', 'email'].includes(e.target.name)) caller(form); });
    form.addEventListener('input', (e) => { if (e.target.name === 'house_number') check(form); if (['phone', 'email'].includes(e.target.name)) caller(form); });
  };
  setTimeout(wire, 0);
  el.after = async (saved) => {
    if (!choice || !saved || !saved.id) return;
    const m = choice.match;
    try {
      if (m.request_id) { await post(`/requests/${saved.id}/duplicate`, { of: m.request_id }); toast(`Linked as a duplicate of ${m.reference}`); }
      else { await post('/requests/checks/link', { request_id: saved.id, work_order_id: m.work_order_id }); toast(`Linked to work order ${m.work_order_id}`); }
    } catch (err) { fail(err); }
  };
  return el;
}

/** On an open request (one from the public page, say): what else is open for the same problem on the block. */
export function requestChecks(r, done) {
  const box = h('div');
  if (!['new', 'assigned', 'made_safe'].includes(r.status) || !r.street_id || !r.category_id) return box;
  get(`/requests/checks/similar?category_id=${r.category_id}&street_id=${r.street_id}&house_number=${encodeURIComponent(r.house_number || '')}&exclude_id=${r.id}`).then(({ matches }) => {
    if (!matches.length) return;
    const desk = can('counter');
    box.append(h('section', { class: 'warn-note stack tight' }, h('strong', null, 'Also open on this block'), matchList(matches, {
      onLink: desk ? (m) => button(m.request_id ? 'Link as duplicate' : 'Link to this work order', async () => {
        try {
          if (m.request_id) await post(`/requests/${r.id}/duplicate`, { of: m.request_id });
          else await post('/requests/checks/link', { request_id: r.id, work_order_id: m.work_order_id });
          toast('Linked'); if (done) await done();
        } catch (err) { fail(err); }
      }, { small: true }) : null,
    })));
  }).catch(() => {});
  return box;
}
