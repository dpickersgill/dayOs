// Rentals, the fitting side. The Counter tab: paid rentals ready to fit (today's, oldest first), found by name, phone,
// order number or a scanned receipt, with a Station choice when the shop works in stations. The fitting card, one per
// person: photo and age, height, weight, date of birth, boot size, sole length, stance and ability (three plain
// answers), the binding suggestion from today's details, the gear (the shared picker) with each ski's setting, and the
// renter's signed confirmation. Also the queue board for a wall screen, the fitting settings, and a manager's hand-out
// with nothing paid. Sell uses the same card (sellFitDialog) when gear is fitted at the ticket window.

import { get, post, put } from '../api.js';
import { h, clear, isManager, state, input, select, field, button, toast, formDialog, dialog, label, empty, toCents, centsToInput, fmtDate, fmtDateTime, errorBox, todayStr } from '../ui.js';
import { personPicker, waiverPanel } from '../widgets.js';
import { signaturePad } from '../sigpad.js';
import { typeName } from '../guesttypes.js';
import { gearPicker, leftPanel, gearName } from './rentals-picker.js';
import { printAgreement } from './rentals-agreement.js';
import { depositStep } from './rentals-deposit.js';

export const ABILITY = { 1: 'Cautious', 2: 'Moderate', 3: 'Aggressive' };
const ABILITY_HINT = { 1: 'Slower speeds, easy runs', 2: 'Different speeds, most runs', 3: 'Fast, steep runs' };
const STATIONS = [['form', 'Form'], ['boots', 'Boots'], ['tech', 'Ski tech'], ['door', 'Door']];
const stationName = (s) => (s === 'set' ? 'Set aside (group)' : (STATIONS.find((x) => x[0] === s) || [s, label(s)])[1]);
const BINDING = ['ski', 'snowboard'];
const MATCH_KEYS = ['height_in', 'weight_lb', 'date_of_birth', 'boot_sole_mm', 'skier_type'];
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private window */ } } };
const waited = (m) => (m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dobText = (d) => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${MONTHS[Number(m) - 1]} ${Number(dd)}, ${y}`; };
const ageOn = (dob, day = todayStr()) => { if (!dob) return null; let a = Number(day.slice(0, 4)) - Number(dob.slice(0, 4)); if (day.slice(5) < dob.slice(5, 10)) a -= 1; return a; };
/** Fields that differ between what was signed and the card now (blank on either side is not a difference). */
function changedSince(signed, now) {
  const n = (k, v) => (v === null || v === undefined || v === '' ? null : k === 'date_of_birth' ? String(v).slice(0, 10) : String(k === 'skier_type' ? v : Number(v)));
  return MATCH_KEYS.filter((k) => { const a = n(k, signed && signed[k]); const b = n(k, now[k]); return a !== null && b !== null && a !== b; });
}

// ---------------------------------------------------------------- the renter's details
/** Height, weight, date of birth, boot size, sole length, stance and ability, all editable. */
function detailsEditor(d, onInput) {
  const id = Math.random().toString(36).slice(2, 7);
  const ft = input({ type: 'number', min: '1', max: '8', inputmode: 'numeric', value: d.height_in ? Math.floor(d.height_in / 12) : '', 'aria-label': 'Height, feet', class: 'fit-num' });
  const inch = input({ type: 'number', min: '0', max: '11', inputmode: 'numeric', value: d.height_in ? d.height_in % 12 : '', 'aria-label': 'Height, inches', class: 'fit-num' });
  const weight = input({ type: 'number', min: '20', max: '500', inputmode: 'numeric', value: d.weight_lb ?? '', class: 'fit-num', id: `w-${id}` });
  const dob = input({ type: 'date', value: d.date_of_birth || '', max: todayStr() });
  const boot = input({ maxlength: 10, value: d.boot_size || '', class: 'fit-num', placeholder: '26.5' });
  const sole = input({ type: 'number', min: '150', max: '400', inputmode: 'numeric', value: d.boot_sole_mm ?? '', class: 'fit-num', placeholder: 'mm' });
  const stance = select([['', 'Not set'], ['regular', 'Regular (left foot forward)'], ['goofy', 'Goofy (right foot forward)']], d.stance || '');
  let type = d.skier_type ? String(d.skier_type) : '';
  const seg = h('div', { class: 'fit-ability', role: 'radiogroup', 'aria-labelledby': `ab-${id}` });
  function drawSeg() {
    clear(seg).append(...['1', '2', '3'].map((t) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(type === t), class: type === t ? 'on' : '' }, h('strong', null, ABILITY[t]), h('small', null, ABILITY_HINT[t]));
      b.addEventListener('click', () => { type = type === t ? '' : t; drawSeg(); onInput(); });
      return b;
    }));
  }
  drawSeg();
  for (const e of [ft, inch, weight, dob, boot, sole]) e.addEventListener('input', onInput);
  stance.addEventListener('change', onInput);
  const n = (e) => (e.value === '' ? null : Number(e.value));
  const el = h('div', { class: 'stack' },
    h('div', { class: 'fit-details' },
      h('div', { class: 'field' }, h('span', null, 'Height'), h('span', { class: 'row fit-height' }, ft, h('span', { 'aria-hidden': 'true' }, 'ft'), inch, h('span', { 'aria-hidden': 'true' }, 'in'))),
      field('Weight (lb)', weight), field('Date of birth', dob), field('Boot size', boot), field('Boot sole length', sole, 'Printed on the boot heel'), field('Stance (boards)', stance)),
    h('div', { class: 'field' }, h('span', { id: `ab-${id}` }, 'How do they ski?'), seg));
  return {
    el,
    values: () => ({
      height_in: ft.value === '' && inch.value === '' ? null : (Number(ft.value || 0) * 12 + Number(inch.value || 0)) || null,
      weight_lb: n(weight), date_of_birth: dob.value || null, boot_size: boot.value.trim() || null, boot_sole_mm: n(sole), stance: stance.value || null, skier_type: type || null,
    }),
  };
}

/** What is written above the signature: the details in plain words. */
function detailsWords(v) {
  const feet = v.height_in ? `${Math.floor(v.height_in / 12)} ft ${v.height_in % 12} in` : 'not given';
  return [`Height ${feet}`, `weight ${v.weight_lb ? `${v.weight_lb} lb` : 'not given'}`, `born ${v.date_of_birth ? dobText(v.date_of_birth) : 'not given'}`, v.boot_sole_mm ? `boot sole ${v.boot_sole_mm} mm` : null, `skis ${v.skier_type ? ABILITY[v.skier_type].toLowerCase() : 'not given'}`].filter(Boolean).join(', ');
}

/** The renter (or a parent or guardian) signs that the details are true. Resolves { signer_name, signer_relation, signature } or null. */
function signDialog(name, minor, values) {
  return new Promise((resolve) => {
    const pad = signaturePad();
    const who = input({ name: 'signer', maxlength: 120, required: true, value: minor ? '' : name, autocomplete: 'off' });
    const rel = select(minor ? [['parent', 'Parent'], ['guardian', 'Guardian']] : [['self', `${name} (themself)`], ['parent', 'Parent'], ['guardian', 'Guardian']], minor ? 'parent' : 'self', { name: 'relation' });
    let done = false;
    const dlg = formDialog(`${name}: confirm the details`, h('div', { class: 'stack' },
      h('p', { class: 'fit-confirm' }, `I confirm these details for ${name} are true: ${detailsWords(values)}. The binding setting is chosen from them.`),
      minor ? h('p', { class: 'warn-note' }, `${name} is under 18. A parent or guardian signs.`) : null,
      h('div', { class: 'form' }, field('Name of the person signing', who), field('They are', rel)),
      h('div', { class: 'stack tight' }, h('span', null, 'Sign here'), pad.el, h('div', { class: 'row' }, button('Clear', () => pad.clear(), { small: true })))), async () => {
      if (who.value.trim().length < 2) throw new Error('Type the name of the person signing');
      const sig = pad.toDataUrl();
      if (!sig) throw new Error('Sign in the box');
      done = true;
      resolve({ signer_name: who.value.trim(), signer_relation: rel.value, signature: sig });
    }, { submitText: 'Sign', onClose: () => { if (!done) resolve(null); } });
    return dlg;
  });
}

// ---------------------------------------------------------------- the fitting card
/**
 * One person's fitting card. mode 'live': a paid rental on the Counter (saves as it goes, hands out). mode 'sell': the
 * ticket window, before the sale (nothing is saved; the result rides along with the sale).
 * data: { person, details, signoff, contract?, items? }, settings: the shop's fitting settings.
 */
function fittingCard({ mode, data, settings, line = null, onDone = () => {} }) {
  const p = data.person;
  const name = `${p.first_name || ''} ${p.last_name || ''}`.trim() || 'The renter';
  const c = data.contract || null;
  let signed = data.signoff && !(data.signoff.mismatch || []).length ? { ...data.signoff, details: { ...data.details } } : null; // a signoff that matches what is on file
  let fresh = line && line.signoff ? line.signoff : null; // signed on this card in Sell, not saved yet
  const chosen = new Map(); // item id -> { item, din, tech, test }
  // gear already on a paid rental (set aside for a group the night before) shows as chosen, with its settings
  for (const i of (c && c.status === 'to_fit' && data.items) || []) if (!i.returned_at) chosen.set(i.rental_item_id, { item: { id: i.rental_item_id, sku: i.sku, category: i.category, brand: i.brand, model: i.model, size: i.size }, din: i.din_setting ?? '', tech: i.tech_name || '', test: i.test_result || '' });
  for (const i of (line && line.items) || []) chosen.set(i.rental_item_id, { item: i._item || { id: i.rental_item_id, sku: `#${i.rental_item_id}`, category: i._category || '' }, din: i.din_setting ?? '', tech: i.tech_name || '', test: i.test_result || '' });
  const suggestEl = h('div', { class: 'fit-suggest', 'aria-live': 'polite' });
  const signEl = h('div', { class: 'fit-sign' });
  const chosenEl = h('div', { class: 'stack' });
  const errEl = h('div');
  let suggestion = null;
  let timer = null;
  const ed = detailsEditor(line && line.fit ? { ...data.details, ...line.fit } : data.details, () => { clearTimeout(timer); timer = setTimeout(() => { suggest(); drawSign(); }, 300); });
  const minor = () => { const a = ageOn(ed.values().date_of_birth); return a !== null ? a < 18 : Boolean(p.minor); };

  async function suggest() {
    const v = ed.values();
    const qs = new URLSearchParams();
    for (const [k, val] of Object.entries({ weight_lb: v.weight_lb, height_in: v.height_in, sole_mm: v.boot_sole_mm, skier_type: v.skier_type, date_of_birth: v.date_of_birth })) if (val !== null && val !== undefined) qs.set(k, val);
    try {
      const r = await get(`/rentals/fit/suggest?${qs}`);
      suggestion = r.din;
      clear(suggestEl).append(r.din !== null
        ? h('div', null, h('span', null, 'Your chart says '), h('strong', { class: 'fit-din' }, String(r.din)), r.note ? h('span', { class: 'muted small' }, ` ${r.note}`) : null)
        : h('div', { class: 'muted' }, r.note || 'No chart setting yet.'),
      h('div', { class: 'small fit-caution' }, 'Check it against the binding maker\'s chart before you set it.'));
      drawChosen();
    } catch (err) { clear(suggestEl).append(errorBox(err)); }
  }

  const needsSign = () => settings.require_signoff && [...chosen.values()].some((r) => BINDING.includes(r.item.category));
  const signedNow = () => {
    const s = fresh ? { details: fresh.details } : signed;
    return s && !changedSince(s.details, ed.values()).length ? s : null;
  };
  function drawSign() {
    clear(signEl);
    const now = ed.values();
    const s = fresh ? { ...fresh, details: fresh.details, signed_at: null } : signed;
    const changed = s ? changedSince(s.details, now) : [];
    if (s && !changed.length) {
      signEl.append(state('Details confirmed', 'good'), h('span', { class: 'small muted' }, ` ${s.signer_name}${s.signer_relation && s.signer_relation !== 'self' ? ` (${s.signer_relation})` : ''}${s.signed_at ? `, ${fmtDateTime(s.signed_at)}` : ', signed just now'}${s.via === 'form' ? ', on the rental form' : ''}`));
    } else {
      signEl.append(state(s ? 'Details changed: sign again' : (needsSign() ? 'Needs to sign' : 'Not signed yet'), s || needsSign() ? 'warn' : 'neutral'),
        button(s ? 'Sign again' : 'Sign the details', async () => {
          const v = ed.values();
          const got = await signDialog(name, minor(), v);
          if (!got) return;
          if (mode === 'live') {
            await post('/rentals/fit/signoffs', { person_id: p.id, ...(c ? { contract_id: c.id } : {}), ...got, details: v });
            signed = { ...got, details: v, signed_at: null, via: 'counter' };
            fresh = null;
            toast('Signed');
          } else {
            fresh = { ...got, details: v };
          }
          drawSign();
        }, { small: true, kind: needsSign() ? 'primary' : null }));
    }
  }

  function bindingRow(r) {
    const din = input({ type: 'number', step: '0.25', min: '0.5', max: '20', value: r.din, placeholder: 'Setting', 'aria-label': `Binding setting ${r.item.sku}`, class: 'fit-num' });
    const tech = input({ value: r.tech, placeholder: 'Set by', maxlength: 100, 'aria-label': `Technician ${r.item.sku}`, class: 'fit-tech' });
    const test = select([['', 'Test'], ['pass', 'Passed'], ['fail', 'Failed']], r.test, { 'aria-label': `Binding test ${r.item.sku}` });
    din.addEventListener('input', () => { r.din = din.value; });
    tech.addEventListener('input', () => { r.tech = tech.value; store.set('rentals.tech', tech.value); });
    test.addEventListener('change', () => { r.test = test.value; });
    const use = suggestion !== null ? button(`Use ${suggestion}`, () => { din.value = suggestion; r.din = String(suggestion); }, { small: true, label: `Use the chart setting ${suggestion} for ${r.item.sku}` }) : null;
    return h('div', { class: 'row fit-binding' }, din, use, tech, test);
  }
  function drawChosen() {
    clear(chosenEl);
    if (!chosen.size) { chosenEl.append(h('p', { class: 'muted small' }, 'No gear chosen yet. Tap gear below, or scan a tag.')); return; }
    for (const r of chosen.values()) {
      chosenEl.append(h('div', { class: 'cart-line' },
        h('div', { class: 'spread' }, h('span', null, h('strong', null, r.item.sku), ` ${label(r.item.category)} ${gearName(r.item)}`), button('Remove', () => { chosen.delete(r.item.id); drawChosen(); picker.redraw(); drawSign(); }, { small: true, label: `Remove ${r.item.sku}` })),
        BINDING.includes(r.item.category) ? bindingRow(r) : null));
    }
  }
  const picker = gearPicker({
    isPicked: (id) => chosen.has(id),
    sizeFor: (category) => (category === 'boot' ? ed.values().boot_size : null), // boots open on the boot size on the card
    onPick: (i) => {
      if (chosen.has(i.id)) chosen.delete(i.id);
      else chosen.set(i.id, { item: i, din: '', tech: BINDING.includes(i.category) ? (store.get('rentals.tech') || '') : '', test: '' });
      drawChosen(); drawSign();
    },
  });
  const gearItems = () => [...chosen.values()].map((r) => ({
    rental_item_id: r.item.id,
    ...(r.din !== '' && r.din !== null ? { din_setting: Number(r.din) } : {}),
    ...(String(r.tech || '').trim() ? { tech_name: String(r.tech).trim() } : {}),
    ...(r.test ? { test_result: r.test } : {}),
    ...(BINDING.includes(r.item.category) && ed.values().boot_sole_mm ? { boot_sole_mm: ed.values().boot_sole_mm } : {}),
    ...(BINDING.includes(r.item.category) && ed.values().skier_type ? { skier_type: ed.values().skier_type } : {}),
  }));
  function checkBindings() {
    for (const r of chosen.values()) {
      if (r.test === 'fail') throw new Error(`${r.item.sku} failed its binding test. Choose other gear.`);
      if (settings.require_binding_record && r.item.category === 'ski' && (r.din === '' || !String(r.tech || '').trim())) throw new Error(`Record the binding setting and who set it for ${r.item.sku}`);
    }
    if (needsSign() && !signedNow()) throw new Error(`${name} needs to sign that the details are true before skis or a board go out.`);
  }

  // ---- live: the paid rental's actions
  const actions = h('div', { class: 'row fit-actions' });
  const dueIn = c ? input({ type: 'datetime-local', value: String(c.due_at).replace(' ', 'T').slice(0, 16), 'aria-label': `Due back for ${name}` }) : null;
  const depIn = c && settings.deposit_mode === 'note' ? input({ type: 'number', min: '0', step: '0.01', value: centsToInput(settings.default_deposit_cents || 0), 'aria-label': `Deposit for ${name}`, class: 'fit-num' }) : null;
  let handed = Boolean(c && c.status === 'out');
  function drawActions() {
    clear(actions);
    if (mode === 'sell') {
      actions.append(button('Use this fitting', () => {
        clear(errEl);
        try { checkBindings(); } catch (err) { errEl.append(errorBox(err)); return; }
        const v = ed.values();
        line.items = gearItems().map((g) => ({ ...g, _item: chosen.get(g.rental_item_id).item, _category: chosen.get(g.rental_item_id).item.category }));
        line.fit = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null));
        line.signoff = fresh && !changedSince(fresh.details, v).length ? { ...fresh, details: line.fit } : undefined;
        onDone();
      }, { kind: 'primary' }));
      return;
    }
    if (handed) {
      actions.append(state('Gear out', 'good'), button('Print agreement', () => printAgreement(c.id), { kind: 'primary' }));
      return;
    }
    actions.append(button('Save details', async () => { await put(`/rentals/fit/people/${p.id}`, ed.values()); toast('Details saved'); }, { small: true }));
    const stage = c.stage === 'set' ? 'door' : c.stage || (settings.layout === 'stations' ? 'form' : null); // a group's set-aside gear goes out from here
    if (settings.layout === 'stations' && stage && stage !== 'door') {
      const next = STATIONS[STATIONS.findIndex((s) => s[0] === stage) + 1];
      actions.append(button(`Done here: send to ${next[1]}`, async () => {
        await put(`/rentals/fit/people/${p.id}`, ed.values());
        const r = await post(`/rentals/fit/contracts/${c.id}/stage`, {});
        c.stage = r.stage;
        toast(`${name} sent to ${stationName(r.stage)}`);
        drawActions(); onDone();
      }, { kind: 'primary' }));
    }
    if (settings.layout !== 'stations' || stage === 'door' || !stage) {
      actions.append(button('Hand out gear', async () => {
        clear(errEl);
        try {
          if (!chosen.size) throw new Error('Choose the gear first');
          checkBindings();
          await put(`/rentals/fit/people/${p.id}`, ed.values());
          if (fresh) { await post('/rentals/fit/signoffs', { person_id: p.id, contract_id: c.id, ...fresh }); fresh = null; }
          const out = await post(`/rentals/contracts/${c.id}/handout`, { items: gearItems(), ...(dueIn && dueIn.value ? { due_at: dueIn.value } : {}), ...(depIn && depIn.value !== '' ? { deposit_cents: toCents(depIn.value) || 0 } : {}) });
          handed = true;
          c.status = 'out';
          toast(`Gear out for ${name}. Due back ${fmtDateTime(out.due_at)}`);
          await depositStep({ ...c, ...out }, settings);
          drawActions(); lock(); onDone();
        } catch (err) { errEl.append(errorBox(err)); }
      }, { kind: 'primary' }));
    }
  }
  drawActions();

  const dueBox = c && !handed ? h('div', { class: 'form' }, field('Due back', dueIn), depIn ? field('Deposit held ($)', depIn) : null) : h('div');
  const pickEl = h('details', { class: 'fit-pick', open: !chosen.size }, h('summary', null, 'Choose gear'), picker.el);
  /** Once the gear is out the card is a record: nothing on it can be changed by accident. */
  function lock() {
    pickEl.hidden = true;
    dueBox.hidden = true;
    for (const x of [ed.el, chosenEl, signEl]) for (const e of x.querySelectorAll('input, select, button')) e.disabled = true;
  }
  const age = ageOn(data.details.date_of_birth);
  const bought = c && c.product_name ? `${c.product_name}${c.tier ? `, ${typeName(c.tier)}` : ''}${c.kind === 'season' ? ', season rental' : ''}` : (line ? line.name : null);
  const waiverBox = h('div');
  if (mode === 'live' && p.waiver_signed === false) waiverBox.append(waiverPanel(p.id, todayStr(), () => {}));
  const el = h('section', { class: 'panel fit-card', 'aria-label': `Fitting card for ${name}` },
    h('div', { class: 'fit-head' },
      p.photo ? h('img', { class: 'pickup-photo', src: p.photo, alt: `Photo of ${name}` }) : h('div', { class: 'pickup-photo none', 'aria-hidden': 'true' }, `${(p.first_name || '?')[0]}${(p.last_name || '')[0] || ''}`),
      h('div', { class: 'stack tight' },
        h('h3', null, name, age !== null ? h('span', { class: 'muted' }, ` · ${age}${age < 18 ? ' (under 18)' : ''}`) : null),
        bought ? h('div', null, h('span', { class: 'muted' }, 'Bought: '), h('strong', null, bought)) : null,
        c && settings.layout === 'stations' ? h('div', { class: 'small' }, `At: ${stationName(c.stage || 'form')}`) : null,
        mode === 'live' ? h('div', { class: 'row' }, state(p.waiver_signed ? 'Waiver signed' : 'No waiver', p.waiver_signed ? 'good' : 'bad')) : null)),
    waiverBox,
    h('h4', null, 'Details'), ed.el,
    h('h4', null, 'Binding'), suggestEl,
    h('h4', null, 'Confirmed by the renter'), signEl,
    h('h4', null, 'Gear'), chosenEl,
    pickEl,
    dueBox,
    errEl, actions);
  suggest(); drawSign(); drawChosen();
  if (handed) lock();
  return { el };
}

// ---------------------------------------------------------------- opening paid rentals
/** Opens the fitting cards for a paid rental and everyone else on the same order who is waiting. */
export async function openFitting(contractId, onChange = () => {}) {
  const first = await get(`/rentals/fit/contracts/${contractId}`);
  const rest = await Promise.all(first.same_order.map((o) => get(`/rentals/fit/contracts/${o.id}`)));
  const all = [first, ...rest];
  const settings = { ...(await get('/rentals/fit/settings')), ...first.settings };
  const body = h('div', { class: 'stack' },
    first.contract.order_id ? h('p', { class: 'muted' }, `Order #${first.contract.order_id} · ${all.length} ${all.length === 1 ? 'person' : 'people'} to fit`) : null,
    ...all.map((d) => fittingCard({ mode: 'live', data: d, settings: { ...settings, ...d.settings }, onDone: onChange }).el));
  dialog(all.length === 1 ? `Fit ${first.person.first_name} ${first.person.last_name}` : `Fit ${all.length} people`, body, { wide: true, onClose: onChange });
}

// ---------------------------------------------------------------- the Counter tab: ready to fit
export async function drawCounter(box) {
  const settings = await get('/rentals/fit/settings');
  const stations = settings.layout === 'stations';
  let station = stations ? (store.get('rentals.station') || '') : '';
  const q = input({ type: 'search', placeholder: 'Name, phone or order number', 'aria-label': 'Find a paid rental by name, phone or order number', autocomplete: 'off' });
  const scan = input({ type: 'text', placeholder: 'Scan, then Enter', 'aria-label': 'Scan a receipt or ticket', autocomplete: 'off' });
  const listEl = h('div', { 'aria-live': 'polite' });
  const leftEl = h('div', { class: 'stack' });
  let timer = null;
  async function load() {
    const qs = new URLSearchParams();
    if (q.value.trim()) qs.set('q', q.value.trim());
    if (station) qs.set('stage', station);
    const r = await get(`/rentals/fit/ready?${qs}`);
    clear(listEl);
    if (!r.data.length) { listEl.append(empty(q.value.trim() ? 'No paid rental matches. Check the spelling, or scan the receipt.' : station ? `Nobody is waiting at ${stationName(station)}.` : 'Nobody is waiting to be fitted. Rentals sold in Sell or online show here.')); return; }
    listEl.append(h('ul', { class: 'fit-queue' }, r.data.map((c) => h('li', null,
      h('button', { type: 'button', class: 'fit-row', 'aria-label': `Fit ${c.first_name} ${c.last_name}` },
        h('span', { class: 'fit-who' }, h('strong', null, `${c.first_name} ${c.last_name}`), c.age !== null ? h('span', { class: 'muted' }, ` ${c.age}`) : null),
        h('span', { class: 'fit-what' }, c.product_name ? `${c.product_name}${c.tier ? `, ${typeName(c.tier)}` : ''}` : 'Rental', c.kind === 'season' ? h('span', { class: 'tag' }, ' Season') : null),
        h('span', { class: 'fit-meta small muted' }, [c.order_id ? `Order #${c.order_id}` : null, c.earlier ? `Paid for ${fmtDate(c.valid_on)}` : null, stations ? `At ${stationName(c.stage || 'form')}` : null].filter(Boolean).join(' · ')),
        h('span', { class: 'fit-wait' }, waited(Number(c.waiting_min) || 0)),
      ))))) ;
    [...listEl.querySelectorAll('.fit-row')].forEach((b, n) => b.addEventListener('click', () => openFitting(r.data[n].id, load).catch((err) => toast(err.message, 'error'))));
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(() => {}), 250); });
  scan.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const code = scan.value.trim();
    scan.value = '';
    if (!code) return;
    try {
      const r = await get(`/rentals/fit/find?code=${encodeURIComponent(code)}`);
      if (r.ready.length) { await openFitting(r.ready[0].id, load); return; }
      toast(r.other.length ? `Order #${r.order.id}: the rental gear is already ${label(r.other[0].status).toLowerCase()}. See Out now.` : `Order #${r.order.id} has no rental on it.`, 'error');
    } catch (err) { toast(err.message, 'error'); }
  });
  const stationSel = stations ? select([['', 'All stations'], ...STATIONS], station, { 'aria-label': 'Station' }) : null;
  if (stationSel) stationSel.addEventListener('change', () => { station = stationSel.value; store.set('rentals.station', station); load(); });
  const noSale = isManager()
    ? button('Hand out without a sale', () => unpaidDialog(load), { small: true })
    : button('Gear with no sale?', () => dialog('Sell the rental first', h('div', { class: 'stack' }, h('p', null, 'Gear goes out on a paid rental. Sell the rental package in Sell, then fit them here. A manager can hand out gear without a sale if there is a good reason.'), h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/sell' }, 'Go to Sell')))), { small: true });
  clear(box).append(h('div', { class: 'fit-layout' },
    h('section', { class: 'stack', 'aria-label': 'Ready to fit' },
      h('div', { class: 'fit-find' }, field('Scan a receipt or ticket', scan), field('Find', q), stationSel ? field('Station', stationSel) : null),
      h('div', { class: 'spread' }, h('h2', null, 'Ready to fit'), h('span', { class: 'row' }, button('Refresh', () => load(), { small: true }), noSale)),
      listEl),
    h('aside', { class: 'panel fit-side', 'aria-label': "What's left" }, h('h2', null, "What's left"), leftEl, stations ? h('a', { href: '#/rentals?tab=board', class: 'small' }, 'Open the queue board') : null)));
  await Promise.all([load(), leftPanel(leftEl)]);
  // keep the list fresh while it is on screen
  const tick = setInterval(() => { if (!box.isConnected) { clearInterval(tick); return; } if (!document.querySelector('.overlay')) load().catch(() => {}); }, 30000);
}

// ---------------------------------------------------------------- a manager hands out with nothing paid
function unpaidDialog(done) {
  let person = null;
  const slot = h('div');
  const pk = personPicker({ label: 'Renter', required: true, onPick: async (p) => {
    person = p; clear(slot);
    if (!p) return;
    slot.append(waiverPanel(p.id, todayStr(), () => {}));
  } });
  const reason = input({ name: 'reason', maxlength: 200, required: true, placeholder: 'Why this goes out without a sale' });
  formDialog('Hand out gear without a sale', h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Only for a good reason, such as a card machine that is down. The reason and your name are kept on the contract. The renter is fitted on the next screen.'),
    pk.el, slot, field('Reason', reason)), async () => {
    if (!person) throw new Error('Choose who is renting');
    if (reason.value.trim().length < 3) throw new Error('Say why this gear goes out without a sale');
    const why = reason.value.trim();
    const card = await get(`/rentals/fit/people/${person.id}`);
    const settings = await get('/rentals/fit/settings');
    const line = { name: 'No sale', items: [] };
    let dlg = null;
    const fc = fittingCard({ mode: 'sell', data: card, settings, line, onDone: async () => {
      try {
        if (line.signoff) await post('/rentals/fit/signoffs', { person_id: person.id, ...line.signoff });
        else if (line.fit) await put(`/rentals/fit/people/${person.id}`, line.fit);
        const out = await post('/rentals/contracts', { person_id: person.id, unpaid_reason: why, due_at: `${todayStr()}T${settings.closing_time}`, items: line.items.map(({ _item, _category, ...g }) => g) });
        toast(`Contract #${out.id}: gear out with no sale`);
        await depositStep({ id: out.id, person_id: person.id }, settings);
        dlg.close();
        await done();
      } catch (err) { toast(err.message, 'error'); }
    } });
    dlg = dialog(`Fit ${person.first_name} ${person.last_name} (no sale)`, fc.el, { wide: true });
  }, { submitText: 'Next: fit them' });
}

// ---------------------------------------------------------------- Sell: fit at the ticket window
/**
 * The fitting card in Sell. who: { person (on file, or null), first_name, last_name, minor, sizing (typed on the customer
 * form) }. Gear is optional: a rental with no gear is fitted at the rental shop.
 */
export async function sellFitDialog(line, who, onDone) {
  const settings = await get('/rentals/fit/settings');
  let data;
  if (who.person && who.person.id) data = await get(`/rentals/fit/people/${who.person.id}`);
  else data = { person: { first_name: who.first_name || '', last_name: who.last_name || '', minor: who.minor }, details: {}, signoff: null };
  // typed on the customer form a moment ago wins over what is on file
  const typed = Object.fromEntries(Object.entries(who.sizing || {}).filter(([k, v]) => v !== null && v !== undefined && v !== '' && k !== 'last_din'));
  if (typed.skier_type) { const t = { I: '1', II: '2', III: '3', 1: '1', 2: '2', 3: '3' }[String(typed.skier_type).toUpperCase()]; if (t) typed.skier_type = t; else delete typed.skier_type; }
  data.details = { ...data.details, ...typed };
  data.person.minor = who.minor;
  let dlg = null;
  const fc = fittingCard({ mode: 'sell', data, settings, line, onDone: () => { dlg.close(); onDone(); } });
  dlg = dialog(`Fit now: ${line.name}`, h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'Optional. Skip this and the rental waits in the rental shop\'s Ready to fit list after the sale.'), fc.el), { wide: true });
}

// ---------------------------------------------------------------- the queue board (wall screen or tablet)
export async function drawBoard(box) {
  const wrap = h('div', { class: 'fit-board', 'aria-live': 'polite' });
  async function load() {
    const r = await get('/rentals/fit/board');
    clear(wrap).append(...r.stages.map((s) => h('section', { class: 'fit-board-col' },
      h('h2', null, s.stage ? stationName(s.stage) : 'Waiting to be fitted'),
      h('div', { class: 'fit-board-count' }, String(s.count), h('span', null, s.count === 1 ? ' waiting' : ' waiting')),
      s.count ? h('div', { class: 'fit-board-wait' }, `Longest wait ${waited(s.longest_min)}`) : null,
      h('ol', null, s.next.map((x) => h('li', null, h('span', null, x.name), h('span', { class: 'fit-board-min' }, waited(x.waiting_min))))))));
  }
  const full = button('Full screen', () => { const el = wrap.parentNode; if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); }, { small: true });
  clear(box).append(h('div', { class: 'stack fit-board-wrap' }, h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'Updates every 15 seconds. Shows first names only.'), full), wrap));
  await load();
  const tick = setInterval(() => { if (!box.isConnected) { clearInterval(tick); return; } load().catch(() => {}); }, 15000);
}

// ---------------------------------------------------------------- settings: layout, closing time, the signed confirmation
export async function drawFitSettings(box) {
  const s = await get('/rentals/fit/settings');
  const layout = select([['counter', 'One counter: fit and hand out in one place'], ['stations', 'Stations: form, boots, ski tech, door']], s.layout);
  const close = input({ type: 'time', value: s.closing_time, required: true });
  const sign = h('input', { type: 'checkbox', checked: s.require_signoff });
  const days = input({ type: 'number', min: '1', max: '30', value: s.signoff_valid_days, class: 'fit-num' });
  clear(box).append(h('section', { class: 'stack fit-settings', 'aria-labelledby': 'fit-set-h' },
    h('h3', { id: 'fit-set-h' }, 'Fitting and hand-out'),
    h('div', { class: 'form' },
      field('How the shop works', layout, 'Stations show a queue for each station and a queue board.'),
      field('Closing time', close, 'Gear is due back at this time on its last day'),
      h('label', { class: 'check' }, sign, 'Renters sign that their details are true before skis or a board go out'),
      field('A signature counts for (days)', days, 'So a renter back tomorrow does not sign again, if their details are the same')),
    h('div', { class: 'row' }, button('Save fitting settings', async () => {
      await put('/rentals/fit/settings', { layout: layout.value, closing_time: close.value.slice(0, 5), require_signoff: sign.checked, signoff_valid_days: Number(days.value || 1) });
      toast('Fitting settings saved');
    }, { kind: 'primary' }))));
}

