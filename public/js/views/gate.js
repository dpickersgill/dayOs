// Gate: scan or type a ticket code and get one clear answer. Its own page so the gate can stay open on a tablet.
// The answer shows the holder's name and photo, warns when the same ticket is scanned again straight away, and
// lets staff find a season pass holder who left their card at home.
import { get, post } from '../api.js';
import { h, clear, input, state, table, field, button, fmtDate, fmtDateTime, label, empty, errorBox } from '../ui.js';

const SCAN_TEXT = {
  ok: ['Let them ride', 'good'],
  expired: ['Ticket expired', 'bad'],
  not_yet_valid: ['Not valid yet', 'warn'],
  void: ['Ticket voided', 'bad'],
  no_uses: ['No rides left', 'bad'],
  unknown: ['Not recognized', 'bad'],
  duplicate: ['Scanned a moment ago', 'warn'],
};

export async function render(root) {
  const g = gate();
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Gate'), h('p', { class: 'muted' }, 'Scan a ticket or type its code.')), g.el, passLookup(g.scan));
}

function gate() {
  const code = input({ class: 'scan-input', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Scan or type a ticket code', 'aria-label': 'Ticket code' });
  const panel = h('div', { class: 'gate', role: 'status', 'aria-live': 'assertive' }, h('strong', null, 'Ready'), h('span', null, 'Scan a ticket to check it.'));
  const recent = h('div', { class: 'stack' });
  const history = [];
  const form = h('form', { class: 'stack' }, code);

  async function scan(value, override = false) {
    code.disabled = true;
    try {
      const out = await post('/tickets/scan', { code: value, location: 'Gate', ...(override ? { override: true } : {}) });
      showResult(out, value);
    } catch (err) {
      clear(panel).append(h('strong', null, 'Could not check'), h('span', null, err.message || 'Try again'));
      panel.dataset.result = 'bad';
    } finally {
      code.value = '';
      code.disabled = false;
      code.focus();
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = code.value.trim();
    if (value) scan(value);
  });

  function showResult(out, value) {
    const [title, tone] = SCAN_TEXT[out.result] || [out.result, 'bad'];
    panel.dataset.result = tone;
    clear(panel);
    panel.append(h('strong', null, title));
    const t = out.ticket;
    if (out.result === 'duplicate' && out.scanned_before) panel.append(h('span', null, `This ticket went through at ${fmtDateTime(out.scanned_before.at)}${out.scanned_before.location ? ` (${out.scanned_before.location})` : ''}. Check who is holding it.`));
    else if (t) {
      if (out.result === 'not_yet_valid') panel.append(h('span', null, `Valid from ${fmtDate(t.valid_from)}`));
      else if (out.result === 'expired') panel.append(h('span', null, `Expired ${fmtDate(t.valid_to)}`));
      else if (t.uses_remaining !== null && t.uses_remaining !== undefined) panel.append(h('span', null, `${t.uses_remaining} ride${t.uses_remaining === 1 ? '' : 's'} left`));
      else panel.append(h('span', null, `Valid through ${fmtDate(t.valid_to)}`));
    } else panel.append(h('span', null, 'No ticket has this code.'));
    const who = out.holder;
    if (who && (who.name || who.photo)) {
      panel.append(h('div', { class: 'gate-person', 'data-holder': '' },
        who.photo ? h('img', { src: who.photo, alt: `Photo of ${who.name || 'the holder'}` }) : null,
        h('div', null, h('div', { class: 'gate-name' }, who.name || 'Guest'), h('div', null, [who.product, who.kind === 'season_pass' && !who.photo ? 'No photo on file' : null].filter(Boolean).join(' · ')),
          who.waiver === false ? h('div', { class: 'gate-waiver' }, state('No waiver on file', 'warn'), ' Send them to the window to sign.') : null)));
    }
    if (out.result === 'duplicate') panel.append(button('Let them through anyway', () => scan(value, true), { kind: 'primary' }));
    history.unshift({ value, title, tone, who: who && who.name, at: new Date() });
    history.length = Math.min(history.length, 8);
    clear(recent).append(h('h3', null, 'Recent scans'), table([
      { head: 'Code', cell: (r) => r.value.toUpperCase() },
      { head: 'Guest', cell: (r) => r.who || '' },
      { head: 'Result', cell: (r) => state(r.title, r.tone) },
      { head: 'Time', cell: (r) => r.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
    ], history));
  }
  const wrap = h('section', { class: 'gate-page stack' }, form, panel, recent);
  setTimeout(() => code.focus(), 0);
  return { el: wrap, scan };
}

/** Find a season pass by name, phone or code, for the guest who left their card in the car. */
function passLookup(scan) {
  const q = input({ type: 'search', name: 'pass-q', placeholder: 'Name, phone or ticket code', 'aria-label': 'Find a season pass holder', autocomplete: 'off' });
  const out = h('div');
  let timer;
  async function search() {
    const text = q.value.trim();
    if (text.length < 2) { clear(out); return; }
    try {
      const { data } = await get(`/passes/lookup?q=${encodeURIComponent(text)}`);
      clear(out).append(data.length ? table([
        { head: 'Holder', cell: (r) => h('strong', null, `${r.first_name} ${r.last_name}`) },
        { head: 'Pass', cell: (r) => r.product },
        { head: 'Valid', cell: (r) => `${fmtDate(r.valid_from)} to ${fmtDate(r.valid_to)}` },
        { head: 'Today', cell: (r) => state(r.valid_today ? 'Valid' : label(r.status === 'active' ? 'not in dates' : r.status), r.valid_today ? 'good' : 'bad') },
        { head: 'Last scan', cell: (r) => (r.last_scan ? fmtDateTime(r.last_scan) : '') },
        { head: 'Photo', cell: (r) => (r.has_photo ? 'Yes' : state('None', 'warn')) },
        { head: '', actions: true, cell: (r) => button('Check in', () => scan(r.code), { small: true }) },
      ], data) : empty('No season pass found for that.'));
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  return h('section', { class: 'gate-page stack' }, h('h2', null, 'Season pass lookup'), h('div', { class: 'inline-form' }, field('Find a pass holder', q)), out);
}
