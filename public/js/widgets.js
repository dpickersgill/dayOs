// Pieces shared by several screens: person lookup, and the season waiver check with signing on the counter screen.

import { get, post } from './api.js';
import { h, clear, state, button, fail, toast, todayStr, seasonFor, can, fmtDate, dialog } from './ui.js';
import { signaturePad } from './sigpad.js';

/**
 * Type-ahead person lookup. Calls onPick(person) when someone is chosen and shows them as a chip.
 * Returns { el, get() } where get() is the chosen person or null.
 */
const FLAG_WORDS = { do_not_rent: 'Do not rent', unpaid_balance: 'Unpaid balance', medical_alert: 'Medical alert', vip: 'VIP', banned: 'Banned', other: 'Note' };

export function personPicker({ label = 'Guest', required = false, onPick } = {}) {
  let chosen = null;
  let timer;
  let seq = 0;
  const search = h('input', { type: 'search', placeholder: 'Name, phone or email', autocomplete: 'off', 'aria-label': label });
  const results = h('div', { class: 'picker-results', hidden: true });
  const slot = h('div');
  const wrap = h('div', { class: 'picker' }, search, results);
  const el = h('div', { class: 'field' }, h('span', null, label, required ? '' : ' (optional)'), slot);

  function showChosen() {
    clear(slot);
    if (!chosen) { slot.append(wrap); return; }
    const x = h('button', { type: 'button', 'aria-label': `Remove ${chosen.first_name} ${chosen.last_name}` }, '×');
    x.addEventListener('click', () => { chosen = null; showChosen(); if (onPick) onPick(null); search.focus(); });
    slot.append(h('span', { class: 'chip' }, `${chosen.first_name} ${chosen.last_name}`, x));
  }
  async function run() {
    const q = search.value.trim();
    const mine = ++seq;
    if (q.length < 2) { results.hidden = true; return; }
    try {
      const { data } = await get(`/people/lookup?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      clear(results);
      if (!data.length) results.append(h('p', { class: 'muted small picker-empty' }, 'No one found. Check the spelling, or add them on the Customers screen first.'));
      for (const p of data) {
        const sm = p.summary;
        // what tells two people with the same name apart: age, a parent or guardian, the last visit (Track WINDOW)
        const known = [p.age !== null && p.age !== undefined ? `age ${p.age}` : null, p.guardian ? `child of ${p.guardian}` : null, p.last_visit ? `last here ${fmtDate(p.last_visit)}` : null, p.phone, p.email].filter(Boolean).join('  ·  ');
        const b = h('button', { type: 'button', class: 'picker-hit' },
          h('span', { class: 'picker-name' }, `${p.first_name} ${p.last_name}`, p.date_of_birth ? h('span', { class: 'muted' }, `  born ${p.date_of_birth}`) : null),
          known ? h('span', { class: 'muted small picker-line' }, known) : null,
          sm ? h('span', { class: 'picker-badges' },
            sm.waiver_this_season ? state('Waiver on file', 'good') : state('No waiver yet', 'warn'),
            ...sm.tickets_today.map((t) => state(t, 'good')),
            sm.rental_out ? state('Gear out', 'neutral') : null) : null,
          p.flags && p.flags.length ? h('span', { class: 'picker-badges' }, ...p.flags.map((f) => h('span', { class: 'flag-pill', 'data-kind': f.kind, title: f.message }, `${FLAG_WORDS[f.kind] || 'Note'}: ${f.message}`))) : null);
        b.addEventListener('click', () => { chosen = p; results.hidden = true; search.value = ''; showChosen(); if (onPick) onPick(p); });
        results.append(b);
      }
      results.hidden = false;
    } catch (err) { results.hidden = true; fail(err); }
  }
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 220); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.hidden = true; });
  showChosen();
  return { el, get: () => chosen, set(p) { chosen = p; showChosen(); } };
}

/**
 * Shows whether a person has a waiver that counts for the season of `date`, and the three ways to get one: the guest signs on
 * this screen, gets a link by email, or (for a paper waiver already signed) staff record it.
 */
export function waiverPanel(personId, date = todayStr(), onChange) {
  const season = seasonFor(date);
  const box = h('div', { class: 'row waiver-panel' });
  async function load() {
    clear(box).append(h('span', { class: 'muted' }, 'Checking waiver…'));
    try {
      const { data } = await get(`/people/${personId}/waivers`);
      const current = data.find((w) => w.season === season && w.counts !== false);
      clear(box);
      if (current) {
        box.append(state(`Waiver signed for ${season}`, 'good'), h('span', { class: 'muted small' }, fmtDate(String(current.signed_at).slice(0, 10))));
      } else {
        box.append(state(`No waiver for ${season}`, 'bad'));
        if (can('counter', 'instructor')) {
          box.append(
            button('Sign on this screen', () => signHere(personId, { season, onDone: async () => { await load(); if (onChange) onChange(true); } }), { small: true, kind: 'primary' }),
            button('Email a link', () => sendLink(personId), { small: true }),
            button('Record a paper waiver', async () => {
              await post(`/people/${personId}/waivers`, { season });
              toast('Paper waiver recorded');
              await load();
              if (onChange) onChange(true);
            }, { small: true }));
        }
      }
      if (onChange) onChange(Boolean(current));
    } catch (err) {
      clear(box).append(h('span', { class: 'muted' }, 'Waiver status is not available to your role.'));
    }
  }
  load();
  return box;
}

async function sendLink(personId) {
  try {
    const out = await post('/waivers/send-link', { person_id: personId });
    toast(`Link sent to ${out.to}`);
  } catch (err) { fail(err); }
}

const ageOf = (dob, today) => {
  if (!dob) return null;
  const [by, bm, bd] = String(dob).slice(0, 10).split('-').map(Number);
  const [y, m, d] = today.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

/**
 * The guest signs on this screen (turn it round to face them). Their details come from their record; a child is signed for by
 * a parent or guardian, whose details are typed here. Calls onDone() once it is saved.
 */
export async function signHere(personId, { season, onDone } = {}) {
  let p; let w;
  try {
    [p, w] = await Promise.all([get(`/people/${personId}`), get('/waivers/summary')]);
  } catch (err) { fail(err); return; }
  if (!w.text) { toast('Add your waiver wording first: Waivers, Wording', 'error'); return; }
  const today = todayStr();
  const age = ageOf(p.date_of_birth, today);
  const minor = age !== null && age < 18;
  const name = `${p.first_name} ${p.last_name}`;
  const inp = (attrs) => h('input', { autocomplete: 'off', ...attrs });
  const g = { first: inp({ maxlength: 100 }), last: inp({ maxlength: 100, value: p.last_name || '' }), dob: inp({ type: 'date', max: today }), email: inp({ type: 'email', maxlength: 255, value: '' }) };
  const dobSelf = inp({ type: 'date', max: today, value: p.date_of_birth ? String(p.date_of_birth).slice(0, 10) : '' });
  const emailSelf = inp({ type: 'email', maxlength: 255, value: p.email || '' });
  const fld = (text, el) => h('label', { class: 'field' }, text, el);
  const guardianBox = h('div', { class: 'form' }, h('p', { class: 'wide muted' }, `${name} is under 18, so a parent or guardian signs for them.`),
    fld('Parent or guardian first name', g.first), fld('Last name', g.last), fld('Their date of birth', g.dob), fld('Their email, for a copy (optional)', g.email));
  const selfBox = h('div', { class: 'form' }, fld('Date of birth', dobSelf), fld('Email, for a copy (optional)', emailSelf));
  const agree = h('input', { type: 'checkbox' });
  const typed = inp({ maxlength: 200 });
  const pad = signaturePad();
  const err = h('div', { role: 'alert' });
  let dlg;
  const save = button('Save signed waiver', async () => {
    clear(err);
    let signature;
    try { signature = pad.toDataUrl(); } catch (ex) { err.append(h('div', { class: 'error-box' }, ex.message)); return; }
    if (!signature) { err.append(h('div', { class: 'error-box' }, 'Ask them to sign in the box.')); return; }
    if (!agree.checked) { err.append(h('div', { class: 'error-box' }, 'They need to tick the box to agree.')); return; }
    const body = minor
      ? { sha: w.sha, season, self: false, children: [{ person_id: p.id, first_name: p.first_name, last_name: p.last_name, date_of_birth: String(p.date_of_birth).slice(0, 10) }],
        signer: { first_name: g.first.value, last_name: g.last.value, date_of_birth: g.dob.value, email: g.email.value.trim() }, typed_name: typed.value, signature, agree: true }
      : { sha: w.sha, season, self: true, children: [], signer: { person_id: p.id, first_name: p.first_name, last_name: p.last_name, date_of_birth: dobSelf.value, email: emailSelf.value.trim() }, typed_name: typed.value, signature, agree: true };
    try {
      const out = await post('/waivers/sign', body);
      toast(out.emailed ? 'Waiver signed. A copy was emailed.' : 'Waiver signed');
      dlg.close();
      if (onDone) await onDone();
    } catch (ex) { err.append(h('div', { class: 'error-box' }, ex.message)); }
  }, { kind: 'primary' });
  dlg = dialog(`Waiver for ${name}`, [
    h('p', { class: 'muted' }, 'Turn the screen to face the guest. They read the waiver, type their name and sign with a finger or the mouse.'),
    h('div', { class: 'waiver-text' }, w.text),
    minor ? guardianBox : selfBox,
    h('label', { class: 'check' }, agree, minor ? ` I have read this waiver and agree to it for ${p.first_name}, as their parent or legal guardian.` : ' I have read this waiver and agree to it.'),
    fld(minor ? 'Parent or guardian: type your full name' : 'Type your full name', typed),
    h('div', { class: 'stack tight' }, h('div', { class: 'spread' }, h('strong', null, 'Sign here'), button('Clear', () => pad.clear(), { small: true })), pad.el),
    err, h('div', { class: 'row' }, save)], { wide: true });
}
