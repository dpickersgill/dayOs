// Gate: check a ticket and get one clear answer. Three tabs.
// - Scan: a barcode scanner or desk RFID reader types into the box; a phone can also tap cards (NFC) or read a barcode
//   with its camera. The answer shows the holder's name and photo, warns when the same ticket comes straight back,
//   and lets staff find a season pass holder who left their card at home.
// - Cards: put a ticket or pass on an RFID card, look a card up, block a lost one.
// - Devices (managers): pair gates, turnstiles and handheld readers, and set how long a gate stays open.
import { get, post, put, patch, del } from '../api.js';
import { h, clear, input, state, table, field, button, fmtDate, fmtDateTime, label, empty, errorBox, tabs, formDialog, confirmDialog, dialog, select, toast, val, isManager } from '../ui.js';
import { nfcSupported, cameraSupported, listenNfc, readOneCard, scanWithCamera } from '../readers.js';

const SCAN_TEXT = {
  ok: ['Let them ride', 'good'],
  expired: ['Ticket expired', 'bad'],
  not_yet_valid: ['Not valid yet', 'warn'],
  void: ['Ticket voided', 'bad'],
  no_uses: ['No rides left', 'bad'],
  unknown: ['Not recognized', 'bad'],
  duplicate: ['Scanned a moment ago', 'warn'],
  card_blocked: ['Card blocked', 'bad'],
};
const CARD_STATUS = { assigned: ['Has a ticket', 'good'], free: ['Empty', 'neutral'], lost: ['Lost, blocked', 'bad'], retired: ['Retired', 'neutral'] };

export async function render(root, params = []) {
  const items = [['scan', 'Scan', drawScan], ['cards', 'Cards', drawCards], ...(isManager() ? [['devices', 'Devices', drawDevices]] : [])];
  const want = items.some((i) => i[0] === params[0]) ? params[0] : 'scan';
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Gate'), h('p', { class: 'muted' }, 'Scan a ticket, tap a card, or type a code.')),
    tabs(items.map(([k, t, fn]) => [k, t, (box) => { try { if (location.hash.startsWith('#/gate')) history.replaceState(null, '', `#/gate${k === 'scan' ? '' : `/${k}`}`); } catch (_) { /* tab still opens */ } return fn(box); }]), want));
}

// ---------------------------------------------------------------- scan
function drawScan(box) {
  const g = gate();
  box.append(g.el, passLookup(g.scan));
}

function gate() {
  const code = input({ class: 'scan-input', name: 'code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Scan, tap or type', 'aria-label': 'Ticket code or card' });
  const panel = h('div', { class: 'gate', role: 'status', 'aria-live': 'assertive' }, h('strong', null, 'Ready'), h('span', null, 'Scan a ticket or tap a card to check it.'));
  const recent = h('div', { class: 'stack' });
  const history = [];
  const form = h('form', { class: 'stack' }, code);
  let stopNfc = null;

  async function scan(value, { override = false, card = false } = {}) {
    code.disabled = true;
    try {
      const out = await post('/tickets/scan', { ...(card ? { uid: value } : { code: value }), location: 'Gate', ...(override ? { override: true } : {}) });
      showResult(out, value, card);
    } catch (err) {
      clear(panel).append(h('strong', null, 'Could not check'), h('span', null, err.message || 'Try again'));
      panel.dataset.result = 'bad';
    } finally {
      code.value = '';
      code.disabled = false;
      if (!stopNfc) code.focus();
    }
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = code.value.trim();
    if (value) scan(value);
  });

  function showResult(out, value, card) {
    const [title, tone] = SCAN_TEXT[out.result] || [label(out.result), 'bad'];
    panel.dataset.result = tone;
    clear(panel);
    panel.append(h('strong', null, title));
    const t = out.ticket;
    if (out.result === 'duplicate' && out.scanned_before) panel.append(h('span', null, `This ticket went through at ${fmtDateTime(out.scanned_before.at)}${out.scanned_before.location ? ` (${out.scanned_before.location})` : ''}. Check who is holding it.`));
    else if (out.result === 'card_blocked') panel.append(h('span', null, 'This card was reported lost. Keep it and send the guest to the window.'));
    else if (t) {
      if (out.result === 'not_yet_valid') panel.append(h('span', null, `Valid from ${fmtDate(t.valid_from)}`));
      else if (out.result === 'expired') panel.append(h('span', null, `Expired ${fmtDate(t.valid_to)}`));
      else if (t.uses_remaining !== null && t.uses_remaining !== undefined) panel.append(h('span', null, `${t.uses_remaining} ride${t.uses_remaining === 1 ? '' : 's'} left`));
      else panel.append(h('span', null, `Valid through ${fmtDate(t.valid_to)}`));
    } else if (out.card && out.card.status === 'not_registered') panel.append(h('span', null, 'This card has no ticket on it. Load one on the Cards tab.'));
    else if (out.card && out.card.status === 'free') panel.append(h('span', null, 'This card is empty. Load a ticket on the Cards tab.'));
    else panel.append(h('span', null, 'No ticket has this code.'));
    const who = out.holder;
    if (who && (who.name || who.photo)) {
      panel.append(h('div', { class: 'gate-person', 'data-holder': '' },
        who.photo ? h('img', { src: who.photo, alt: `Photo of ${who.name || 'the holder'}` }) : null,
        h('div', null, h('div', { class: 'gate-name' }, who.name || 'Guest'), h('div', null, [who.product, who.kind === 'season_pass' && !who.photo ? 'No photo on file' : null].filter(Boolean).join(' · ')),
          who.waiver === false ? h('div', { class: 'gate-waiver' }, state('No waiver on file', 'warn'), ' Send them to the window to sign.') : null)));
    }
    if (out.result === 'duplicate') panel.append(button('Let them through anyway', () => scan(value, { override: true, card }), { kind: 'primary' }));
    const shown = out.ticket ? out.ticket.code : value.toUpperCase();
    history.unshift({ value: out.card && out.card.label ? `Card ${out.card.label}` : shown, title, tone, who: who && who.name, at: new Date() });
    history.length = Math.min(history.length, 8);
    clear(recent).append(h('h3', null, 'Recent scans'), table([
      { head: 'Ticket or card', cell: (r) => r.value },
      { head: 'Guest', cell: (r) => r.who || '' },
      { head: 'Result', cell: (r) => state(r.title, r.tone) },
      { head: 'Time', cell: (r) => r.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) },
    ], history));
  }

  // Phone helpers, offered only where the browser can do them.
  const helpers = h('div', { class: 'row wrap reader-tools' });
  if (nfcSupported()) {
    const nfcBtn = button('Tap cards on this phone', async () => {
      if (stopNfc) { stopNfc(); stopNfc = null; nfcBtn.textContent = 'Tap cards on this phone'; nfcBtn.setAttribute('aria-pressed', 'false'); return; }
      try {
        stopNfc = await listenNfc((serial) => scan(serial, { card: true }), (err) => toast(err.message, 'error'));
        nfcBtn.textContent = 'Stop reading cards'; nfcBtn.setAttribute('aria-pressed', 'true');
        clear(panel).append(h('strong', null, 'Ready'), h('span', null, 'Hold each card on the back of the phone.'));
      } catch (err) { toast(err && err.name === 'NotAllowedError' ? 'NFC is blocked. Allow it for this site in the browser settings.' : 'This phone cannot read cards here.', 'error'); }
    }, { label: 'Read RFID cards with this phone' });
    nfcBtn.setAttribute('aria-pressed', 'false');
    helpers.append(nfcBtn);
  }
  if (cameraSupported()) helpers.append(button('Scan with the camera', async () => { const v = await scanWithCamera(); if (v) scan(v); }));
  const wrap = h('section', { class: 'gate-page stack' }, form, helpers.childNodes.length ? helpers : null, panel, recent);
  // Leaving the Scan tab or the page stops the phone reading cards, so a tap meant for something else never scans here.
  const Observer = globalThis.MutationObserver;
  if (Observer) {
    const watch = new Observer(() => {
      if (wrap.isConnected) return;
      if (stopNfc) { stopNfc(); stopNfc = null; }
      watch.disconnect();
    });
    setTimeout(() => { if (wrap.isConnected) watch.observe(document.body, { childList: true, subtree: true }); }, 0);
  }
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
        { head: '', actions: true, cell: (r) => h('span', { class: 'row tight' },
          button('Check in', () => scan(r.code), { small: true, label: `Check in ${r.first_name} ${r.last_name}` }),
          button('New card', () => loadCardDialog(r.code, `${r.first_name} ${r.last_name}`), { small: true, label: `Put ${r.first_name} ${r.last_name}'s pass on a new card` })) },
      ], data) : empty('No season pass found for that.'));
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  return h('section', { class: 'gate-page stack' }, h('h2', null, 'Season pass lookup'), h('div', { class: 'inline-form' }, field('Find a pass holder', q)), out);
}

// ---------------------------------------------------------------- cards
/** A text box for a card, with a "tap on phone" button where the phone can read cards. */
function cardInput(name = 'uid', value = '') {
  const box = input({ name, required: true, autocomplete: 'off', spellcheck: 'false', value, placeholder: 'Tap the card on the reader', 'aria-label': 'Card number' });
  if (!nfcSupported()) return box;
  return h('div', { class: 'row tight' }, box, button('Tap on phone', async () => { const s = await readOneCard(); if (s) { box.value = s; box.dispatchEvent(new Event('input', { bubbles: true })); } }, { small: true, label: 'Read the card with this phone' }));
}
function codeInput(value = '') {
  const box = input({ name: 'ticket_code', required: true, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', value, placeholder: 'Scan the receipt or type the code', 'aria-label': 'Ticket code' });
  if (!cameraSupported()) return box;
  return h('div', { class: 'row tight' }, box, button('Camera', async () => { const v = await scanWithCamera(); if (v) box.value = v; }, { small: true, label: 'Scan the ticket code with the camera' }));
}

/** Put a ticket on a card. If the card already carries another good ticket, say which, and load only once replace is ticked. */
function loadCardDialog(ticketCode = '', who = '', done) {
  const replaceRow = h('label', { class: 'check wide', hidden: true }, h('input', { type: 'checkbox', name: 'replace' }), ' Replace the ticket already on this card');
  const fields = h('div', { class: 'form' },
    who ? h('p', { class: 'wide' }, `Pass for ${who}. Any other card it was on stops working.`) : null,
    field('Ticket or pass code', codeInput(ticketCode)),
    field('Card', cardInput()),
    field('Printed card number (optional)', input({ name: 'label', maxlength: 40, autocomplete: 'off' })),
    replaceRow);
  formDialog('Load a card', fields, async (fd) => {
    const body = { ticket_code: val(fd, 'ticket_code'), uid: val(fd, 'uid'), label: val(fd, 'label'), replace: fd.get('replace') === 'on' };
    try {
      await post('/access/cards/assign', body);
    } catch (err) {
      if (err.details && err.details.code === 'card_in_use') {
        replaceRow.hidden = false;
        throw new Error(`This card already carries ticket ${err.details.other_ticket}, which is still good. Tick Replace to load it anyway, or use another card.`);
      }
      throw err;
    }
    toast('Card loaded');
    if (done) await done();
  }, { submitText: 'Load card' });
}

async function drawCards(box) {
  const q = input({ type: 'search', name: 'card-q', placeholder: 'Card number, printed number, ticket code or name', 'aria-label': 'Find a card', autocomplete: 'off' });
  const status = select([['', 'All cards'], ['assigned', 'With a ticket'], ['free', 'Empty'], ['lost', 'Lost']], '', { 'aria-label': 'Which cards' });
  const out = h('div');
  const counts = h('p', { class: 'muted' });
  let timer;
  async function load() {
    try {
      const qs = new URLSearchParams();
      if (q.value.trim()) qs.set('q', q.value.trim());
      if (status.value) qs.set('status', status.value);
      const r = await get(`/access/cards?${qs}`);
      counts.textContent = `${r.counts.all} card${r.counts.all === 1 ? '' : 's'}: ${r.counts.assigned} with a ticket, ${r.counts.free} empty, ${r.counts.lost} lost.`;
      clear(out).append(r.data.length ? table([
        { head: 'Card', cell: (c) => h('span', { class: 'stack tight' }, h('strong', null, c.label ? `No. ${c.label}` : c.uid), c.label ? h('span', { class: 'muted small' }, c.uid) : null) },
        { head: 'Status', cell: (c) => state(...(CARD_STATUS[c.status] || [label(c.status), 'neutral'])) },
        { head: 'Ticket', cell: (c) => (c.ticket_code ? h('span', { class: 'stack tight' }, h('span', null, c.product || 'Ticket'), h('span', { class: 'muted small' }, `${c.holder ? `${c.holder}, ` : ''}to ${fmtDate(c.valid_to)}`)) : '') },
        { head: 'Last tap', cell: (c) => (c.last_seen_at ? fmtDateTime(c.last_seen_at) : '') },
        { head: '', actions: true, cell: (c) => h('span', { class: 'row tight' },
          c.status === 'assigned' ? button('Lost', () => confirmDialog('Block this card?', 'It stops opening gates straight away. You can then put the ticket on a new card.', 'Block card', async () => {
            const r2 = await post(`/access/cards/${c.id}/lost`, {}); toast('Card blocked'); await load();
            if (r2.ticket_code) loadCardDialog(r2.ticket_code, c.holder || '', load);
          }, { danger: true }), { small: true, label: `Report card ${c.label || c.uid} lost` }) : null,
          c.status === 'assigned' || (c.status === 'lost' && isManager()) ? button(c.status === 'lost' ? 'Found' : 'Empty it', () => confirmDialog(c.status === 'lost' ? 'Unblock this card?' : 'Take the ticket off this card?', 'The card goes back in the drawer, empty, ready to load again.', c.status === 'lost' ? 'Unblock' : 'Empty card', async () => { await post(`/access/cards/${c.id}/free`, {}); toast('Card emptied'); await load(); }), { small: true, label: `${c.status === 'lost' ? 'Unblock' : 'Empty'} card ${c.label || c.uid}` }) : null) },
      ], r.data) : empty(q.value || status.value ? 'No card matches.' : 'No cards yet. Load the first one with Load a card.'));
    } catch (err) { clear(out).append(errorBox(err)); }
  }
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  status.addEventListener('change', load);
  box.append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, 'An RFID card carries one ticket or pass at a time and can be loaded again next season. A desk reader types the card number into any box; a phone with NFC can read it too.'),
      button('Load a card', () => loadCardDialog('', '', load), { kind: 'primary' })),
    h('div', { class: 'filters' }, field('Find a card', q), field('Show', status)), counts, out));
  await load();
}

// ---------------------------------------------------------------- devices (managers)
const KINDS = [['gate', 'Gate'], ['turnstile', 'Turnstile'], ['handheld', 'Handheld scanner'], ['reader', 'Reader at a door or lift']];

function pairDialog(d) {
  dialog(`Pair ${d.name}`, h('div', { class: 'stack' },
    h('p', null, 'Enter this code on the device (or give it to the installer). It works once, within 30 minutes.'),
    h('p', { class: 'pair-code', 'aria-label': `Pairing code ${d.code.split('').join(' ')}` }, d.code),
    h('p', { class: 'muted small' }, 'The device trades the code for its own key, then checks every tap with Verdynt/OS and keeps a list of today\'s good cards for when the network drops. The guide for installers is in Help.')));
}

async function drawDevices(box) {
  const [{ data }, settings] = await Promise.all([get('/access/devices'), get('/access/settings')]);
  const again = async () => drawDevices(clear(box));
  const add = () => formDialog('Add a device', h('div', { class: 'form' },
    field('Name', input({ name: 'name', required: true, maxlength: 100, placeholder: 'Summit Quad gate 1' })),
    field('Where (shown on each scan)', input({ name: 'location', maxlength: 100, placeholder: 'Summit Quad' })),
    field('Kind', select(KINDS, 'gate', { name: 'kind' }))), async (fd) => {
    const r = await post('/access/devices', { name: val(fd, 'name'), location: val(fd, 'location'), kind: val(fd, 'kind') });
    await again(); pairDialog(r);
  }, { submitText: 'Add and get a code' });
  const setForm = () => formDialog('Gate settings', h('div', { class: 'form' },
    field('Gate stays open (seconds)', input({ name: 'open', type: 'number', min: 0.5, max: 15, step: 0.5, value: settings.gate_open_ms / 1000 })),
    field('Same ticket again is held for (seconds)', input({ name: 'passback', type: 'number', min: 0, max: 3600, step: 1, value: settings.scan_passback_seconds }), 'Catches a ticket handed back over the fence. 0 turns it off.')), async (fd) => {
    const open = val(fd, 'open'); const back = val(fd, 'passback');
    if (open === null || back === null) throw new Error('Fill in both times. Use 0 to turn the pass-back hold off.');
    await put('/access/settings', { gate_open_ms: Math.round(Number(open) * 1000), scan_passback_seconds: Number(back) });
    toast('Saved'); await again();
  });
  const status = (d) => (!d.active ? state('Switched off', 'neutral') : d.waiting ? state('Waiting to pair', 'warn') : !d.paired ? state('Not paired', 'warn') : state('Paired', 'good'));
  box.append(h('div', { class: 'stack' },
    h('div', { class: 'spread' }, h('p', { class: 'muted' }, `Gates, turnstiles and handheld scanners that check tickets and cards on their own. A gate opens for ${settings.gate_open_ms / 1000} s; the same ticket is held for ${settings.scan_passback_seconds} s.`),
      h('span', { class: 'row tight' }, button('Settings', setForm, { small: true }), button('Add a device', add, { kind: 'primary' }))),
    data.length ? table([
      { head: 'Device', cell: (d) => h('span', { class: 'stack tight' }, h('strong', null, d.name), h('span', { class: 'muted small' }, [label(d.kind), d.location].filter(Boolean).join(', '))) },
      { head: 'Status', cell: status },
      { head: 'Last seen', cell: (d) => (d.last_seen_at ? fmtDateTime(d.last_seen_at) : 'Never') },
      { head: 'Offline list', cell: (d) => (d.last_list_at ? fmtDateTime(d.last_list_at) : 'Never') },
      { head: 'Scans, 24 h', num: true, cell: (d) => String(d.scans_24h) },
      { head: '', actions: true, cell: (d) => h('span', { class: 'row tight' },
        button(d.paired ? 'New code' : 'Pair', async () => pairDialog({ ...d, ...(await post(`/access/devices/${d.id}/pair-code`, {})) }), { small: true, label: `Get a pairing code for ${d.name}` }),
        button(d.active ? 'Switch off' : 'Switch on', async () => { await patch(`/access/devices/${d.id}`, { active: !d.active }); await again(); }, { small: true, label: `${d.active ? 'Switch off' : 'Switch on'} ${d.name}` }),
        button('Remove', () => confirmDialog(`Remove ${d.name}?`, 'It stops working at once. Its scans stay in the records.', 'Remove', async () => { await del(`/access/devices/${d.id}`); await again(); }, { danger: true }), { small: true, kind: 'quiet', label: `Remove ${d.name}` })) },
    ], data) : empty('No devices yet. Barcode scanners and desk readers plugged into a counter computer need no setup; add gates and turnstiles here.')));
}
