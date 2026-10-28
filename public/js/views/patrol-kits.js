// Patrol > Gear > Kits: trauma bags, packed toboggans and lift evacuation kits. The board shows every kit as ready, check
// due, needs restock or with expired items. A kit's QR label opens its own page, where anyone on patrol checks it (each
// item there or not, and when it expires), restocks it, or signs off an unbroken seal. Checks work with no signal: they
// wait on the phone and send when the signal returns. Those who manage equipment set the contents and how often.
import { get, post, patch } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, dialog, empty, errorBox, state, fmtDate, fmtDateTime, nowStamp, ctx, fail } from '../ui.js';
import { send } from '../outbox.js';
import { qr } from '../barcode.js';

const STANDING = { ready: ['Ready', 'good'], check_due: ['Check due', 'warn'], needs_restock: ['Needs restock', 'bad'], expired: ['Expired items', 'bad'], not_ready: ['Not ready', 'bad'], out_of_service: ['Out of service', 'neutral'] };
const ORDER = ['expired', 'needs_restock', 'not_ready', 'check_due', 'ready', 'out_of_service'];
const KEEP = 'so.patrol.kits';
const keep = (data) => { try { localStorage.setItem(KEEP, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* not kept */ } };
const kept = () => { try { const x = JSON.parse(localStorage.getItem(KEEP) || 'null'); return x && x.data; } catch (_) { return null; } };
const kitUrl = (id) => `${location.origin}/app#/patrol/kit/${id}`;

async function loadBoard() {
  try { const r = await get('/patrol/kits'); keep(r); return r; } catch (err) {
    const k = kept();
    if (k && (!err.status || (globalThis.navigator && navigator.onLine === false))) { toast('No connection. Showing kits as last loaded.', 'warn'); return { ...k, offline: true }; }
    throw err;
  }
}

export async function drawKits(box) {
  const body = h('div');
  clear(box).append(body);
  let only = '';
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading kits…'));
    try { draw(await loadBoard()); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(r) {
    if (!r.types.length) {
      clear(body).append(h('section', { class: 'panel stack' }, h('h2', null, 'Kits'),
        h('p', null, 'Track what should be in each trauma bag, packed toboggan and lift evacuation kit, check them by QR code, and see on one board which are ready.'),
        r.can_manage ? startersBox(r.starters, load) : h('p', { class: 'muted' }, 'Ask whoever manages patrol equipment to set up the kinds of kit.')));
      return;
    }
    const kits = r.kits.filter((k) => !only || k.type_id === Number(only)).sort((a, b) => ORDER.indexOf(a.standing) - ORDER.indexOf(b.standing) || a.label.localeCompare(b.label, 'en', { numeric: true }));
    const counts = Object.fromEntries(ORDER.map((s) => [s, r.kits.filter((k) => k.standing === s).length]));
    const pick = select([['', 'All kits'], ...r.types.filter((x) => x.active).map((x) => [x.id, x.name])], only, { 'aria-label': 'Kind of kit' });
    pick.addEventListener('change', () => { only = pick.value; draw(r); });
    clear(body).append(
      h('div', { class: 'week-bar' },
        h('div', null, h('h2', { class: 'week-title' }, 'Kits'), h('p', { class: 'muted' }, ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${STANDING[s][0].toLowerCase()}`).join(', ') || 'No kits yet.')),
        h('div', { class: 'week-actions' }, pick,
          r.can_manage ? button('Add kits', () => addDialog(r.types, load), { kind: 'primary' }) : null,
          r.can_manage ? button('Kinds of kit', () => typesDialog(r.types, load)) : null,
          r.kits.length ? h('a', { class: 'btn', href: '#/patrol/kit-labels' }, 'Print labels') : null)),
      kits.length ? h('div', { class: 'kit-board' }, kits.map((k) => h('article', { class: 'kit-card', 'data-standing': k.standing },
        h('div', { class: 'spread' }, h('a', { href: `#/patrol/kit/${k.id}`, class: 'kit-label' }, k.label), state(...STANDING[k.standing])),
        h('p', null, k.type, h('span', { class: 'muted' }, [k.location, k.station, k.lift].filter(Boolean).length ? `, ${[k.location, k.station, k.lift].filter(Boolean).join(', ')}` : '')),
        h('p', { class: 'muted small' }, [k.last_check_at ? `Checked ${fmtDateTime(k.last_check_at)}` : 'Never checked', k.earliest_expiry ? `first expiry ${fmtDate(k.earliest_expiry)}` : null, k.sealed ? `seal ${k.seal_no}` : null].filter(Boolean).join(', ')),
        h('div', { class: 'row tight' }, h('a', { class: 'btn small primary', href: `#/patrol/kit/${k.id}` }, k.standing === 'needs_restock' ? 'Restock' : 'Check'))))) : empty('No kits of this kind yet.'),
      ...(r.offline ? [h('p', { class: 'muted small' }, 'Offline: checks you make now wait on this phone and send when the signal returns.')] : []));
  }
  await load();
}

function startersBox(starters, onDone) {
  const boxes = starters.map((s) => ({ s, el: h('input', { type: 'checkbox', checked: true }) }));
  return h('div', { class: 'stack' }, h('p', null, 'Start from suggested lists. You can change every item, quantity and how often each is checked afterwards.'),
    ...boxes.map(({ s, el }) => h('label', { class: 'check' }, el, `${s.name}: ${s.count} items, checked every ${s.every_days === 1 ? 'day' : `${s.every_days} days`}`)),
    h('div', { class: 'row' }, button('Use these lists', async () => {
      try { await post('/patrol/kits/types/starter', { names: boxes.filter((b) => b.el.checked).map((b) => b.s.name) }); toast('Kinds of kit added. Next, add your kits.'); await onDone(); } catch (err) { fail(err); }
    }, { kind: 'primary' })));
}

async function addDialog(types, onDone) {
  const stations = (await get('/patrol/stations').catch(() => ({ data: [] }))).data;
  const lifts = (await get('/schedule/lifts?limit=200').catch(() => ({ data: [] }))).data;
  formDialog('Add kits', h('div', { class: 'form' },
    field('Kind', select(types.filter((x) => x.active).map((x) => [x.id, x.name]), types[0].id, { name: 'type_id' })),
    field('How many', input({ type: 'number', name: 'count', min: 1, max: 50, value: 1 })),
    field('Where it is kept', input({ name: 'location', maxlength: 120, placeholder: 'Top shack, aid room, toboggan cache 2' })),
    field('Station', select([['', 'None'], ...stations.map((s) => [s.id, s.name])], '', { name: 'station_id' })),
    field('Lift (for a lift evacuation kit kept at one lift)', select([['', 'Shared, not at one lift'], ...lifts.map((l) => [l.id, l.name])], '', { name: 'lift_id' }))), async (fd) => {
    const n = (k) => (fd.get(k) ? Number(fd.get(k)) : null);
    const r = await post('/patrol/kits', { type_id: n('type_id'), count: n('count') || 1, location: String(fd.get('location') || '').trim() || null, station_id: n('station_id'), lift_id: n('lift_id') });
    toast(`Added ${r.data.map((x) => x.label).join(', ')}. Check each one to make it ready.`);
    await onDone();
  }, { submitText: 'Add', wide: true });
}

/** The kinds of kit: contents (item, how many, whether it expires) and how often each kind is checked. */
function typesDialog(types, onDone) {
  const pick = select(types.map((x) => [x.id, x.name]), types[0].id, { 'aria-label': 'Kind of kit' });
  const box = h('div', { class: 'stack' });
  let rowsEl; let name; let prefix; let every;
  const row = (c = { key: '', label: '', qty: 1, expires: false }) => {
    const r = h('div', { class: 'kit-item-row', 'data-key': c.key },
      input({ class: 'k-label', value: c.label, maxlength: 80, 'aria-label': 'Item', placeholder: 'Item' }),
      input({ class: 'k-qty', type: 'number', min: 1, max: 500, value: c.qty, 'aria-label': 'How many' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', class: 'k-exp', checked: c.expires }), 'Expires'),
      h('button', { type: 'button', class: 'btn small icon-btn', 'aria-label': 'Remove', onclick: () => r.remove() }, '×'));
    rowsEl.append(r);
  };
  const show = () => {
    const t = types.find((x) => x.id === Number(pick.value));
    name = input({ value: t.name, maxlength: 80 }); prefix = input({ value: t.prefix, maxlength: 8 }); every = input({ type: 'number', min: 1, max: 365, value: t.every_days });
    rowsEl = h('div', { class: 'stack tight' });
    t.contents.forEach(row);
    clear(box).append(h('div', { class: 'form' }, field('Name', name), field('Label prefix', prefix, 'Kits are numbered from it, such as TB-1'), field('Check every (days)', every)),
      h('h3', null, 'Contents'), rowsEl, button('Add an item', () => row(), { small: true }));
  };
  pick.addEventListener('change', show);
  show();
  formDialog('Kinds of kit', h('div', { class: 'stack' }, field('Kind', pick), box), async () => {
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'item';
    const seen = new Set();
    const contents = [...rowsEl.querySelectorAll('.kit-item-row')].map((r) => {
      const label = r.querySelector('.k-label').value.trim();
      let key = r.dataset.key || slug(label); while (seen.has(key)) key = `${key}_2`.slice(0, 30); seen.add(key);
      return { key, label, qty: Number(r.querySelector('.k-qty').value) || 1, expires: r.querySelector('.k-exp').checked };
    }).filter((c) => c.label);
    await patch(`/patrol/kits/types/${pick.value}`, { name: name.value.trim(), prefix: prefix.value.trim(), every_days: Number(every.value), contents });
    toast('Saved'); await onDone();
  }, { submitText: 'Save', wide: true });
}

// ---------------------------------------------------------------- one kit (opened from its QR label)
export async function renderKitPage(root, id) {
  const body = h('div', { class: 'stack' });
  root.append(h('div', { class: 'page-head' }, h('a', { href: '#/patrol/gear?tab=kits', class: 'back' }, '‹ Kits'), h('h1', null, 'Kit')), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading the kit…'));
    let r;
    try { r = await get(`/patrol/kits/${id}`); } catch (err) {
      // No signal at the cache: the kit as last loaded on this phone, so it can still be checked.
      const k = kept();
      const kit = k && k.kits.find((x) => x.id === id);
      if (!kit) { clear(body).append(errorBox(err)); return; }
      r = { kit, type: k.types.find((x) => x.id === kit.type_id), checks: [], seals: k.seals, offline: true };
    }
    draw(r);
  }
  function draw(r) {
    const k = r.kit; const t = r.type;
    root.querySelector('h1').textContent = `${k.label}, ${t.name}`;
    const short = t.contents.filter((c) => Number((k.stock[c.key] || {}).qty || 0) < c.qty);
    clear(body).append(
      h('section', { class: 'panel stack' },
        h('div', { class: 'spread' }, h('p', null, [k.location, k.station, k.lift].filter(Boolean).join(', ') || 'No place recorded'), state(...STANDING[k.standing])),
        h('p', { class: 'muted small' }, [k.last_check_at ? `Last checked ${fmtDateTime(k.last_check_at)}` : 'Never checked', `checked every ${t.every_days === 1 ? 'day' : `${t.every_days} days`}`, k.earliest_expiry ? `first expiry ${fmtDate(k.earliest_expiry)}` : null].filter(Boolean).join(', ')),
        h('div', { class: 'row' },
          r.seals && k.sealed ? button(`Seal ${k.seal_no} unbroken`, () => sealDialog(k, load), { kind: 'primary' }) : null,
          button('Check it', () => checkDialog(k, t, r.seals, 'full', load), { kind: r.seals && k.sealed ? null : 'primary' }),
          button('Restock', () => checkDialog(k, t, r.seals, 'restock', load))),
        short.length ? h('p', { class: 'cover-why' }, `Short: ${short.map((c) => `${c.label} (${(k.stock[c.key] || {}).qty || 0} of ${c.qty})`).join(', ')}`) : null),
      h('section', { class: 'panel stack' }, h('h2', null, 'Contents'),
        h('ul', { class: 'plain kit-contents' }, t.contents.map((c) => { const s = k.stock[c.key] || {}; return h('li', { class: 'spread' }, h('span', null, c.label), h('span', { class: 'muted' }, `${s.qty ?? '?'} of ${c.qty}${c.expires ? `, ${s.expires_on ? `expires ${fmtDate(s.expires_on)}` : 'no date'}` : ''}`)); }))),
      r.checks.length ? h('section', { class: 'panel stack' }, h('h2', null, 'History'),
        h('ul', { class: 'plain' }, r.checks.map((c) => h('li', null, h('b', null, fmtDateTime(c.done_at)), ` ${{ full: 'Checked', seal: 'Seal checked', restock: 'Restocked', use: 'Used on a case' }[c.kind]}`, c.case_number ? h('span', null, ' ', h('a', { href: `#/patrol/case/${c.incident_id}` }, c.case_number)) : null, h('span', { class: 'muted' }, `, ${c.done_by}${c.note ? `: ${c.note}` : ''}`), ' ', state(...STANDING[c.result === 'needs_restock' ? 'needs_restock' : c.result]))))) : null,
      h('section', { class: 'panel row' }, qr(kitUrl(k.id), { size: 96 }), h('p', { class: 'muted small' }, 'This kit’s QR label opens this page. Print labels from the Kits board.')),
      ...(r.offline ? [h('p', { class: 'muted small' }, 'Offline: what you record waits on this phone and sends when the signal returns.')] : []));
  }
  await load();
}

/** Check or restock: each item, how many are there, and the soonest expiry for items that expire. */
function checkDialog(k, t, seals, kind, onDone) {
  const rowsEl = t.contents.map((c) => {
    const s = k.stock[c.key] || {};
    const qty = input({ type: 'number', min: 0, max: 500, value: kind === 'restock' ? c.qty : (s.qty ?? c.qty), 'aria-label': `${c.label}, how many` });
    const exp = c.expires ? input({ type: 'date', value: s.expires_on || '', 'aria-label': `${c.label}, soonest expiry` }) : null;
    return { c, qty, exp, el: h('div', { class: 'kit-check-row' }, h('span', null, c.label, h('small', { class: 'muted' }, ` needs ${c.qty}`)), qty, exp || h('span')) };
  });
  const seal = seals ? input({ maxlength: 30, placeholder: 'Number on the new seal' }) : null;
  const note = input({ maxlength: 300 });
  formDialog(`${kind === 'restock' ? 'Restock' : 'Check'} ${k.label}`, h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, kind === 'restock' ? 'Fill it to the full list. Give the soonest expiry date for what you put in.' : 'Count what is there. For items that expire, give the soonest date.'),
    h('div', { class: 'kit-check' }, rowsEl.map((x) => x.el)),
    seal ? field('Seal', seal, 'Leave blank if you are not sealing it') : null, field('Note', note)), async () => {
    const items = Object.fromEntries(rowsEl.map((x) => [x.c.key, { qty: Number(x.qty.value || 0), expires_on: x.exp && x.exp.value ? x.exp.value : null }]));
    const r = await send('POST', `/patrol/kits/${k.id}/checks`, { kind, items, seal_no: seal && seal.value.trim() ? seal.value.trim() : null, note: note.value.trim() || null, at: nowStamp() }, { caseId: 0, label: `Kit ${k.label}` });
    toast(r && r.queued ? 'Kept on this phone. It sends when the signal returns.' : r && r.result === 'ready' ? `${k.label} is ready` : `${k.label} saved: not ready yet`);
    await onDone();
  }, { submitText: 'Save', wide: true });
}

function sealDialog(k, onDone) {
  const no = input({ maxlength: 30, required: true, placeholder: 'The number on the seal' });
  formDialog(`Seal check, ${k.label}`, h('div', { class: 'stack' }, h('p', null, 'Type the number on the seal. If it matches, the kit is signed off. If it is broken or different, do a full check.'), field('Seal number', no)), async () => {
    const r = await send('POST', `/patrol/kits/${k.id}/checks`, { kind: 'seal', seal_no: no.value.trim(), at: nowStamp() }, { caseId: 0, label: `Seal ${k.label}` });
    toast(r && r.queued ? 'Kept on this phone. It sends when the signal returns.' : `${k.label} signed off`);
    await onDone();
  }, { submitText: 'Sign off' });
}

/** Printable QR labels for every kit. */
export async function renderKitLabels(root) {
  const r = await get('/patrol/kits');
  root.append(h('div', { class: 'labels-page stack' },
    h('div', { class: 'row labels-tools' }, h('a', { class: 'btn', href: '#/patrol/gear?tab=kits' }, '‹ Kits'), button('Print', () => window.print(), { kind: 'primary' }),
      h('span', { class: 'muted small' }, `${r.kits.length} label${r.kits.length === 1 ? '' : 's'}. Use weatherproof labels outdoors.`)),
    h('div', { class: 'labels' }, r.kits.map((k) => h('div', { class: 'label-card' }, qr(kitUrl(k.id), { size: 96 }),
      h('div', { class: 'label-text' }, h('b', null, k.label), h('span', null, k.type), h('span', { class: 'muted' }, (ctx.me && ctx.me.tenant_name) || ''), h('span', { class: 'small muted' }, 'Scan to check this kit')))))));
}

/** On a case: supplies used from kits. The kit then shows as needing a restock. */
export function kitUsePanel({ c, editable, id }) {
  const list = h('div');
  const sec = h('section', { class: 'panel stack', 'data-area': 'kit-use' }, h('div', { class: 'spread' }, h('h2', null, 'Kit supplies used'), editable ? button('Record supplies used', () => useDialog(id, () => fill()), { small: true }) : null), list);
  async function fill() {
    try {
      const r = await get(`/patrol/incidents/${id}/kit-use`);
      clear(list).append(r.data.length ? h('ul', { class: 'plain' }, r.data.map((u) => h('li', null, h('b', null, u.label), ` ${u.lines.map((x) => `${x.qty} \u00d7 ${x.label}`).join(', ')}`, h('span', { class: 'muted' }, `, ${fmtDateTime(u.done_at)}`)))) : h('p', { class: 'muted' }, 'None recorded.'));
    } catch (_) { clear(list).append(h('p', { class: 'muted' }, 'Not available offline.')); }
  }
  fill();
  return sec;
}

async function useDialog(caseId, onDone) {
  const board = await loadBoard();
  const kits = board.kits.filter((k) => k.standing !== 'out_of_service');
  if (!kits.length) { dialog('No kits', [h('p', null, 'No kits are set up yet. Kits are under Patrol, Gear, Kits.')]); return; }
  const pick = select(kits.map((k) => [k.id, `${k.label}, ${k.type}`]), kits[0].id, { 'aria-label': 'Kit' });
  const box = h('div', { class: 'kit-check' });
  const show = () => {
    const k = kits.find((x) => x.id === Number(pick.value)); const t = board.types.find((x) => x.id === k.type_id);
    clear(box).append(...t.contents.map((c) => h('div', { class: 'kit-check-row' }, h('span', null, c.label), input({ type: 'number', min: 0, max: 500, value: 0, 'data-key': c.key, 'aria-label': `${c.label} used` }), h('span'))));
  };
  pick.addEventListener('change', show); show();
  formDialog('Supplies used from a kit', h('div', { class: 'stack' }, field('Kit', pick), h('p', { class: 'muted small' }, 'How many of each were used. The kit then shows as needing a restock.'), box), async () => {
    const used = Object.fromEntries([...box.querySelectorAll('input[data-key]')].filter((x) => Number(x.value) > 0).map((x) => [x.dataset.key, Number(x.value)]));
    if (!Object.keys(used).length) throw new Error('Say what was used');
    const r = await send('POST', `/patrol/kits/${pick.value}/checks`, { kind: 'use', used, incident_id: caseId > 0 ? caseId : null, at: nowStamp() }, { caseId, label: 'Kit supplies used' });
    toast(r && r.queued ? 'Kept on this phone. It sends when the signal returns.' : 'Recorded. The kit needs a restock.');
    await onDone();
  }, { submitText: 'Save', wide: true });
}

