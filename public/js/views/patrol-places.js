// Map the mountain for patrol (help/places): mark trail signs, lift towers and junctions from a phone, give each a short
// sign code, and print help signs. Patrol Gear, Places and signs. Patrol Admins and Managers (and managers).
//   drawPlaces(box)          the mapping screen: Mark this spot, Walk the mountain, the map, the list, CSV
//   renderSigns(root)        #/patrol/signs?ids=1,2&size=sticker|tower   a sign per place, ready to print
//   renderStencil(root, id)  #/patrol/stencil/<lift id>                  every tower code on one lift, for painting
import { get, post, patch, put, download } from '../api.js';
import { h, svg, clear, ctx, input, select, field, button, toast, formDialog, confirmDialog, table, state, fmtDateTime, empty, errorBox, fail, label } from '../ui.js';
import { watchFix, quality, goodEnough, MARK_MAX_M, WAIT_MS, mapsLink } from '../gpsfix.js';
import { placeMap } from '../placemap.js';
import { qrMatrix, qrPath, signWords, SIZES } from '../signsheet.js';
import { norm, compassWord } from '../mapturn.js';

const LIFT_KINDS = ['tower', 'lift_top', 'lift_bottom'];
const TRAIL_KINDS = ['sign', 'junction'];

export async function drawPlaces(box) {
  let data;
  try { data = await get('/patrol/places'); } catch (err) { clear(box).append(errorBox(err)); return; }
  const kindLabel = Object.fromEntries(data.kinds.map((k) => [k.key, k.label]));
  const max = data.gps_max_m || MARK_MAX_M;

  // ---- Mark this spot
  const kind = select(data.kinds.map((k) => [k.key, k.label]), 'sign', { name: 'kind', class: 'big-select', 'aria-label': 'What is here' });
  const lift = select([['', 'Choose the lift'], ...data.lifts.map((l) => [String(l.id), l.name])], '', { name: 'lift_id', class: 'big-select', 'aria-label': 'Lift' });
  const tower = input({ name: 'tower_no', type: 'number', inputmode: 'numeric', min: 0, max: 999, class: 'big-input', 'aria-label': 'Tower number' });
  const trail = select([['', 'No trail'], ...data.trails.map((t) => [String(t.id), t.name])], '', { name: 'trail_id', class: 'big-select', 'aria-label': 'Trail' });
  const name = input({ name: 'name', maxlength: 100, class: 'big-input', placeholder: 'Ridge Run upper sign', 'aria-label': 'Name' });
  const code = input({ name: 'code', maxlength: 5, class: 'big-input code-input', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Sign code', pattern: '[A-Za-z0-9]{2,5}' });
  const walk = h('input', { type: 'checkbox', id: 'pl-walk' });
  const liftRow = field('Lift', lift); const towerRow = field('Tower number', tower); const trailRow = field('Trail', trail);
  const nameRow = field('Name', name, 'Leave it blank to use the trail or lift name.');
  const codeRow = field('Sign code', code, '2 to 5 letters and digits, printed big on the sign. You can change it.');
  const gpsLine = h('p', { class: 'gps-line', role: 'status', 'aria-live': 'polite' }, 'Press Start GPS, then stand at the spot.');
  const markBtn = button('Mark this spot', () => mark(), { kind: 'primary big mark-btn' });
  markBtn.disabled = true;
  let codeTouched = false;
  code.addEventListener('input', () => { codeTouched = true; code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });

  function showFields() {
    const k = kind.value;
    liftRow.hidden = !LIFT_KINDS.includes(k);
    towerRow.hidden = k !== 'tower';
    trailRow.hidden = !TRAIL_KINDS.includes(k);
    nameRow.hidden = k === 'tower'; // a tower is named by its lift and number
  }
  const body = () => ({
    kind: kind.value, name: name.value.trim() || null,
    lift_id: LIFT_KINDS.includes(kind.value) && lift.value ? Number(lift.value) : null,
    tower_no: kind.value === 'tower' && tower.value !== '' ? Number(tower.value) : null,
    trail_id: TRAIL_KINDS.includes(kind.value) && trail.value ? Number(trail.value) : null,
  });
  let suggestN = 0;
  async function suggest() {
    if (codeTouched) return;
    const my = ++suggestN;
    const b = body();
    if (b.kind === 'tower' && (!b.lift_id || b.tower_no === null)) return;
    try { const r = await post('/patrol/places/code', b); if (my === suggestN && !codeTouched) code.value = r.code || ''; } catch (_) { /* typed by hand instead */ }
  }
  for (const el of [kind, lift, trail]) el.addEventListener('change', () => { showFields(); suggest(); });
  for (const el of [tower, name]) el.addEventListener('input', () => suggest());
  showFields();
  suggest();

  // GPS: the fix improves while the patroller stands there; Mark this spot opens once it is within the limit.
  let fix = null; let stop = null; let waited = null;
  function startGps() {
    if (stop) return;
    gpsLine.textContent = quality(null, max);
    stop = watchFix((f) => {
      fix = f;
      gpsLine.textContent = quality(f, max);
      markBtn.disabled = !goodEnough(f, max);
      gpsLine.classList.toggle('gps-weak', !goodEnough(f, max));
    }, (text) => { gpsLine.textContent = text; gpsLine.classList.add('gps-weak'); });
    clearTimeout(waited);
    waited = setTimeout(() => { if (box.isConnected && (!fix || !goodEnough(fix, max))) gpsLine.textContent = `${quality(fix, max)} Still waiting: a sign marked from a weak fix would send patrol to the wrong place.`; }, WAIT_MS);
    startBtn.textContent = 'GPS on';
    startBtn.disabled = true;
  }
  const startBtn = button('Start GPS', () => startGps(), { kind: 'big' });
  const stopWhenGone = setInterval(() => { if (!box.isConnected) { clearInterval(stopWhenGone); if (stop) stop(); clearTimeout(waited); } }, 2000);

  async function mark() {
    if (!goodEnough(fix, max)) { toast(`Wait for the GPS to be within ${max} m`, 'warn'); return; }
    const at = { ...fix };
    const b = { ...body(), code: code.value.trim() || null, lat: at.lat, lng: at.lng, accuracy_m: Math.round(at.acc * 10) / 10 };
    try {
      const r = await post('/patrol/places', b);
      toast(`Marked ${r.code}: ${r.name}`);
      codeTouched = false; code.value = '';
      // Walk the mountain: the next tower on the same lift is ready.
      if (walk.checked && b.kind === 'tower' && b.tower_no !== null) { tower.value = String(b.tower_no + 1); name.value = ''; walkNote.textContent = `Next: tower ${b.tower_no + 1}. Walk to it, then press Mark this spot.`; } else if (!walk.checked) { name.value = ''; }
      await reload();
      suggest();
    } catch (err) { fail(err); }
  }
  const walkNote = h('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  walk.addEventListener('change', () => {
    if (walk.checked) { kind.value = 'tower'; showFields(); walkNote.textContent = 'After each tower, the next tower number on the same lift is ready.'; startGps(); suggest(); } else walkNote.textContent = '';
  });

  const markCard = h('section', { class: 'panel stack mark-card', 'data-area': 'mark' },
    h('h2', null, 'Mark this spot'),
    h('p', { class: 'muted' }, `Stand at the sign, tower or junction. The spot is taken from this phone's GPS once it is within ${max} m.`),
    field('What is here', kind), liftRow, towerRow, trailRow, nameRow, codeRow,
    h('label', { class: 'check-row', for: 'pl-walk' }, walk, h('span', null, h('b', null, 'Walk the mountain. '), 'Mark tower after tower up one lift.')), walkNote,
    gpsLine,
    h('div', { class: 'row mark-actions' }, startBtn, markBtn));

  // ---- the map and the list
  const mapBox = h('div', { class: 'place-map-box' });
  const listBox = h('div');
  const chosen = new Set();
  const tools = h('div', { class: 'row places-tools' });
  let showRetired = false;

  function draw() {
    const active = data.data.filter((p) => p.active);
    clear(mapBox).append(placeMap(active, { width: 640, height: 360, rotation: turnTo, onPick: (p) => placeDialog(p), title: `Map of ${active.length} marked places` }),
      h('p', { class: 'muted small' }, `Squares are lift towers, dots are everything else. ${turnTo ? 'The red arrow points to true north.' : 'North is up.'} Tap a point for its details.`));
    const shown = data.data.filter((p) => showRetired || p.active);
    const printSel = () => { const ids = [...chosen].filter((id) => active.some((p) => p.id === id)); return ids.length ? ids : active.map((p) => p.id); };
    clear(tools).append(
      button(chosen.size ? `Print ${chosen.size} sign${chosen.size === 1 ? '' : 's'}` : 'Print all signs', () => printDialog(printSel()), { kind: 'primary' }),
      button('Tower stencil', () => stencilDialog(), {}),
      button('Export CSV', async () => { try { await download('/patrol/places/export', 'mountain-places.csv'); } catch (err) { fail(err); } }, {}),
      button('Import CSV', () => importDialog(), {}),
      h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: showRetired, onchange: (e) => { showRetired = e.target.checked; draw(); } }), ' Show retired'));
    clear(listBox).append(shown.length ? table([
      { head: '', cell: (p) => (p.active ? h('input', { type: 'checkbox', 'aria-label': `Choose ${p.code} for printing`, checked: chosen.has(p.id), onchange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); draw(); } }) : '') },
      { head: 'Code', cell: (p) => h('b', { class: 'place-code' }, p.code) },
      { head: 'Place', cell: (p) => h('span', null, p.name, p.active ? null : state('Retired', 'neutral')) },
      { head: 'Kind', cell: (p) => kindLabel[p.kind] || label(p.kind) },
      { head: 'GPS', cell: (p) => (p.accuracy_m === null ? h('span', { class: 'muted' }, 'Imported') : `within ${p.accuracy_m} m`) },
      { head: 'Marked', cell: (p) => fmtDateTime(p.marked_at) },
      { head: '', actions: true, cell: (p) => h('span', { class: 'row' },
        h('a', { class: 'btn small', href: mapsLink(p.lat, p.lng), target: '_blank', rel: 'noopener', 'aria-label': `Open ${p.code} in maps` }, 'Open in maps'),
        button('Edit', () => placeDialog(p), { small: true, label: `Edit ${p.code}` })) },
    ], shown) : empty('Nothing marked yet. Stand at a trail sign or lift tower and press Mark this spot.'));
  }
  async function reload() { try { data = await get('/patrol/places'); if (turnCard) paintTurn(); else { work(); prompt.hidden = Boolean(O().uphill); draw(); } } catch (err) { fail(err); } }

  // ---- Map orientation. By default the base is at the bottom and the summit at the top, as seen from the base: uphill,
  // worked out from the marked lift ends (again as more are marked). Owners, managers and the patrol Director or Admin
  // can turn it by hand instead; that sticks until Back to uphill up.
  const O = () => data.orientation || { rotation_deg: 0, mode: 'north', manual_deg: null, uphill: null };
  let preview = O().mode === 'manual' ? { auto: false, deg: O().manual_deg } : { auto: true, deg: 0 };
  const savedPreview = () => (O().mode === 'manual' ? { auto: false, deg: O().manual_deg } : { auto: true, deg: 0 });
  let turnTo = 0;
  const work = () => { turnTo = preview.auto ? (O().uphill ? O().uphill.deg : 0) : norm(preview.deg); };
  work();
  const turnNow = h('p', { class: 'turn-now', role: 'status', 'aria-live': 'polite' });
  const prompt = h('p', { class: 'turn-prompt', role: 'note' }, 'Mark a lift bottom and top so the map shows your mountain the way you see it from the base.');
  const turnSave = button('Save orientation', async () => {
    data.orientation = await put('/patrol/places/orientation', preview.auto ? { auto: true } : { rotation_deg: norm(preview.deg) });
    toast('Orientation saved'); paintTurn();
  }, { kind: 'primary' });
  const backUp = button('Back to uphill up', async () => {
    data.orientation = await put('/patrol/places/orientation', { auto: true });
    preview = { auto: true, deg: 0 }; toast('Back to uphill up'); paintTurn();
  }, {});
  const baseBtn = button('Base at the bottom (as you see it from the base)', () => { preview = { auto: true, deg: 0 }; paintTurn(); }, {});
  function paintTurn() {
    work();
    const up = O().uphill;
    const how = up ? (up.from === 'lifts' ? `worked out from the bottom and top of ${up.count} lift${up.count === 1 ? '' : 's'}` : 'worked out from the base map point and the summit weather point') : '';
    turnNow.textContent = preview.auto
      ? (up ? `Base at the bottom: the top of the map faces ${compassWord(turnTo)} (${turnTo}\u00b0), ${how}.` : 'North is up until uphill can be worked out.')
      : `Turned by hand: the top of the map faces ${compassWord(turnTo)} (${turnTo}\u00b0). It stays this way as more lifts are marked.`;
    prompt.hidden = Boolean(up);
    const saved = savedPreview();
    turnSave.disabled = saved.auto === preview.auto && (preview.auto || norm(saved.deg) === norm(preview.deg));
    backUp.hidden = O().mode !== 'manual';
    baseBtn.disabled = !up;
    baseBtn.setAttribute('aria-pressed', String(preview.auto));
    draw();
  }
  const byHand = (d) => { preview = { auto: false, deg: norm(d) }; paintTurn(); };
  const turnCard = data.can_turn ? h('section', { class: 'panel stack turn-panel', 'data-area': 'turn' },
    h('h2', null, 'Map orientation'),
    h('p', { class: 'muted' }, 'Maps show the base at the bottom and the summit at the top, as you see the mountain from the base. Turn it by hand to match your trail map if you like. It turns every map of your mountain: this one, the call map and the terrain park map. It is only ever turned, never flipped, so left and right stay where they are on the hill.'),
    turnNow,
    h('div', { class: 'row turn-row' },
      baseBtn,
      button('North up', () => byHand(0), {}),
      button('\u21ba 15\u00b0', () => byHand(turnTo + 15), { label: 'Turn 15 degrees to the left' }),
      button('\u21bb 15\u00b0', () => byHand(turnTo - 15), { label: 'Turn 15 degrees to the right' }),
      button('Turn around', () => byHand(turnTo + 180), {})),
    h('div', { class: 'row turn-row' }, turnSave, backUp)) : null;

  function placeDialog(p) {
    const k = select(data.kinds.map((x) => [x.key, x.label]), p.kind, { name: 'kind' });
    const l = select([['', 'No lift'], ...data.lifts.map((x) => [String(x.id), x.name])], p.lift_id ? String(p.lift_id) : '', { name: 'lift_id' });
    const t = select([['', 'No trail'], ...data.trails.map((x) => [String(x.id), x.name])], p.trail_id ? String(p.trail_id) : '', { name: 'trail_id' });
    const moveLine = h('p', { class: 'gps-line', role: 'status', 'aria-live': 'polite' });
    let moveFix = null; let moveStop = null;
    const moveBtn = button('Move it here', async () => {
      if (!moveStop) { moveStop = watchFix((f) => { moveFix = f; moveLine.textContent = quality(f, max); moveBtn.textContent = goodEnough(f, max) ? 'Move it here now' : 'Waiting for GPS…'; }, (text) => { moveLine.textContent = text; }); moveLine.textContent = quality(null, max); return; }
      if (!goodEnough(moveFix, max)) { toast(`Wait for the GPS to be within ${max} m`, 'warn'); return; }
      await put(`/patrol/places/${p.id}/position`, { lat: moveFix.lat, lng: moveFix.lng, accuracy_m: Math.round(moveFix.acc * 10) / 10 });
      toast(`${p.code} moved`); moveStop(); d.close(); await reload();
    }, {});
    const retire = p.active
      ? button('Retire', () => confirmDialog(`Retire ${p.code}?`, 'It leaves the map, the call words and the sign sheets. Its code stays taken, so an old sign is never sent to a new place. You can restore it.', 'Retire', async () => { await post(`/patrol/places/${p.id}/retire`); toast(`${p.code} retired`); d.close(); await reload(); }), { kind: 'danger' })
      : button('Restore', async () => { await post(`/patrol/places/${p.id}/restore`); toast(`${p.code} restored`); d.close(); await reload(); }, {});
    const d = formDialog(`${p.code}: ${p.name}`, h('div', { class: 'form' },
      field('Name', input({ name: 'name', value: p.name, maxlength: 100, required: true })),
      field('Sign code', input({ name: 'code', value: p.code, maxlength: 5, required: true, pattern: '[A-Za-z0-9]{2,5}', autocapitalize: 'characters' }), 'Changing it means printing a new sign.'),
      field('What is here', k), field('Lift', l),
      field('Tower number', input({ name: 'tower_no', type: 'number', min: 0, max: 999, value: p.tower_no ?? '' })), field('Trail', t),
      h('div', { class: 'wide stack tight' },
        h('p', { class: 'muted small' }, `Marked ${fmtDateTime(p.marked_at)}${p.accuracy_m !== null ? `, GPS within ${p.accuracy_m} m` : ', imported'}. `, h('a', { href: mapsLink(p.lat, p.lng), target: '_blank', rel: 'noopener' }, 'Open in maps')),
        h('div', { class: 'row' }, moveBtn, retire), moveLine)),
    async (fd) => {
      const v = (n) => { const x = String(fd.get(n) ?? '').trim(); return x === '' ? null : x; };
      await patch(`/patrol/places/${p.id}`, { name: v('name'), code: v('code'), kind: v('kind'), lift_id: v('lift_id') ? Number(v('lift_id')) : null, tower_no: v('tower_no') === null ? null : Number(v('tower_no')), trail_id: v('trail_id') ? Number(v('trail_id')) : null });
      toast('Saved'); await reload();
    }, { onClose: () => { if (moveStop) moveStop(); } });
  }

  function printDialog(ids) {
    if (!ids.length) { toast('Mark some places first', 'warn'); return; }
    const size = select(Object.entries(SIZES).map(([k, v]) => [k, v.label]), 'sticker', { name: 'size' });
    formDialog('Print help signs', h('div', { class: 'stack' }, h('p', null, `${ids.length} sign${ids.length === 1 ? '' : 's'}, one to a page. Print on weatherproof label stock or laminate them.`), field('Size', size)),
      async () => { location.hash = `#/patrol/signs?size=${size.value}&ids=${ids.join(',')}`; }, { submitText: 'Open the sign sheet' });
  }
  function stencilDialog() {
    const lifts = data.lifts.filter((l) => data.data.some((p) => p.active && p.kind === 'tower' && Number(p.lift_id) === Number(l.id)));
    if (!lifts.length) { toast('Mark some lift towers first', 'warn'); return; }
    const pick = select(lifts.map((l) => [String(l.id), l.name]), String(lifts[0].id), { name: 'lift' });
    formDialog('Lift tower stencil', h('div', { class: 'stack' }, h('p', null, 'Every tower code on one lift, large, for painting or for the lift crew to check.'), field('Lift', pick)),
      async () => { location.hash = `#/patrol/stencil/${pick.value}`; }, { submitText: 'Open the stencil sheet' });
  }
  function importDialog() {
    const file = h('input', { type: 'file', accept: '.csv,text/csv', name: 'file', required: true });
    const out = h('div');
    formDialog('Import places', h('div', { class: 'stack' },
      h('p', null, 'A CSV with the columns kind, name, code, lift, tower, trail, lat, lng (the same as Export CSV). A row with a code already used updates that place; the others are added.'),
      field('CSV file', file), out), async () => {
      const f = file.files && file.files[0];
      if (!f) throw new Error('Choose a CSV file');
      try {
        const r = await post('/patrol/places/import', { csv: await f.text() });
        toast(`Imported: ${r.added} added, ${r.updated} updated`);
        await reload();
      } catch (err) {
        const rows = err && err.details && err.details.errors;
        if (rows) { clear(out).append(h('ul', { class: 'error-list' }, rows.map((x) => h('li', null, `Line ${x.line}: ${x.error}`)))); }
        throw err;
      }
    }, { submitText: 'Import' });
  }

  clear(box).append(h('div', { class: 'places-page stack' },
    h('p', { class: 'muted' }, 'Mark trail signs, lift towers and junctions. Calls then say where a caller is in the words you use on the radio, and each place gets a help sign with its code.'),
    h('div', { class: 'places-grid' }, markCard, h('section', { class: 'panel stack', 'data-area': 'map' }, h('h2', null, 'Marked places'), mapBox)),
    turnCard,
    h('section', { class: 'panel stack', 'data-area': 'list' }, tools, listBox)));
  mapBox.before(prompt);
  prompt.hidden = Boolean(O().uphill);
  if (turnCard) paintTurn(); else draw();
}

// ---------------------------------------------------------------- printing
const qrSvg = (url, cls) => {
  const { d, size } = qrPath(qrMatrix(url));
  return svg('svg', { class: cls, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `QR code ${url}`, 'shape-rendering': 'crispEdges', 'data-url': url },
    svg('rect', { width: size, height: size, fill: '#fff' }), svg('path', { d, fill: '#000' }));
};
const query = () => new URLSearchParams(location.hash.split('?')[1] || '');

export async function renderSigns(root) {
  const q = query();
  let size = SIZES[q.get('size')] ? q.get('size') : 'sticker';
  const ids = String(q.get('ids') || '').split(',').filter((x) => /^\d+$/.test(x));
  const r = await get(`/patrol/places/signs${ids.length ? `?ids=${ids.join(',')}` : ''}`);
  const page = h('div');
  // The size switches on the page itself (the address keeps it, for a reload).
  function draw() {
    const sizeBtns = Object.entries(SIZES).map(([k, v]) => h('button', { type: 'button', class: `btn${k === size ? ' primary' : ''}`, 'aria-pressed': String(k === size), onclick: () => { size = k; history.replaceState(null, '', `#/patrol/signs?size=${k}&ids=${ids.join(',')}`); draw(); } }, v.short));
    clear(page).append(h('div', { class: `signs-page signs-${size}` },
      h('div', { class: 'row signs-tools no-print' }, h('a', { class: 'btn', href: '#/patrol/gear?tab=places' }, '\u2039 Places and signs'), ...sizeBtns, button('Print', () => window.print(), { kind: 'primary' }),
        h('span', { class: 'muted small' }, `${r.places.length} sign${r.places.length === 1 ? '' : 's'}. ${r.help_number ? '' : 'No help number for texts is set, so the signs say Scan this code. '}Print at 100% size.`)),
      ...(r.places.length ? r.places.map((p) => helpSign(p, r, size)) : [empty('No places to print.')])));
  }
  draw();
  root.append(page);
}

function helpSign(p, r, size) {
  const w = signWords({ code: p.code, mountain: r.mountain, number: r.help_number, tag: r.help_tag });
  return h('article', { class: `help-sign help-sign-${size}`, 'data-code': p.code },
    h('p', { class: 'hs-ask' }, w.ask),
    qrSvg(p.url, 'hs-qr'),
    h('p', { class: `hs-code${w.code.length > 6 ? ' hs-code-long' : ''}`, 'aria-label': `Sign code ${w.code}` }, w.code),
    h('p', { class: 'hs-how' }, w.how),
    h('p', { class: 'hs-911' }, w.emergency),
    h('p', { class: 'hs-mountain' }, w.mountain));
}

export async function renderStencil(root, liftId) {
  const r = await get(`/patrol/places/signs?lift=${liftId}`);
  root.append(h('div', { class: 'signs-page stencil-page' },
    h('div', { class: 'row signs-tools no-print' }, h('a', { class: 'btn', href: '#/patrol/gear?tab=places' }, '‹ Places and signs'), button('Print', () => window.print(), { kind: 'primary' })),
    h('h1', { class: 'stencil-title' }, `${r.lift || 'Lift'}: tower codes`),
    h('p', { class: 'stencil-sub' }, `${r.mountain}. Paint or stick each code on its tower, facing the trail below.`),
    r.places.length ? h('div', { class: 'stencil-grid' }, r.places.map((p) => h('div', { class: 'stencil-cell' }, h('span', { class: `stencil-code${(r.help_tag ? r.help_tag.length + 1 : 0) + p.code.length > 6 ? ' hs-code-long' : ''}` }, r.help_tag ? `${r.help_tag} ${p.code}` : p.code), h('span', { class: 'stencil-tower' }, `Tower ${p.tower_no}`))))
      : empty('No towers marked on this lift yet.')));
}
