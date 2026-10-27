// Scene diagram (Report view) and witness statement links (Witnesses).
//
// The scene diagram is drawn on a grid with big buttons: markers you tap to place and drag (guest, other skier,
// patroller, point of impact, tree, rock, sign, lift tower, snow gun, groomer), direction-of-travel arrows, rope lines
// and plain lines you stretch by their ends, short labels, and an uphill or north arrow. It is saved to the server,
// which draws the stored copy itself for the report and the claim file.
//
// A statement link lets a witness write what they saw in their own words on their own phone and sign it. It arrives
// on the case marked as theirs; staff never edit it, only mark it entered in error with a reason.

import { get, post, put } from '../api.js';
import { h, clear, button, field, input, dialog, formDialog, confirmDialog, toast, fail, state, fmtDateTime, errorBox } from '../ui.js';
import { qr } from '../barcode.js';
import { sceneSvg, KINDS, KIND, W, H, MAX_ITEMS } from '../scene-draw.js';

const placeOf = (c) => [c.trail, c.lift].filter(Boolean).join(', ') || c.location || '';
const whenOf = (c) => (c.occurred_at ? new Date(`${String(c.occurred_at).replace(' ', 'T')}Z`).toLocaleString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const svgImage = (svg, alt) => h('img', { class: 'scene-img', alt, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
const offline = (err) => err instanceof TypeError || /fetch|network/i.test(String(err && err.message));

// ============================================================ scene diagram
export function scenePanel({ c, editable, id, version }) {
  if (version || !(id > 0)) return null;
  const box = h('div', { class: 'stack' }, h('p', { class: 'loading' }, 'Loading the scene diagram…'));
  const section = h('section', { class: 'panel stack scene-panel' }, h('h3', null, 'Scene diagram'), box);
  let saved = null;
  const show = () => {
    clear(box);
    if (saved && saved.svg) {
      box.append(svgImage(saved.svg, `Scene diagram, ${placeOf(c)}`),
        h('p', { class: 'muted small' }, `Saved ${fmtDateTime(saved.updated_at)}${saved.updated_by ? ` by ${saved.updated_by}` : ''}. It goes in the report and the claim file.`));
      if (editable) box.append(h('div', { class: 'row' }, button('Change the drawing', () => edit(), { small: true })));
    } else {
      box.append(h('p', { class: 'muted' }, editable ? 'Draw where it happened: the direction each person was going, where they met, and what was around them. Not to scale.' : 'No scene diagram.'));
      if (editable) box.append(h('div', { class: 'row' }, button('Draw the scene', () => edit(), { kind: 'primary' })));
    }
  };
  const edit = () => {
    clear(box).append(editor({ c, id, start: saved && saved.data, onSaved: (s) => { saved = s; show(); }, onCancel: show }));
  };
  get(`/patrol/incidents/${id}/scene`).then((s) => { saved = s.svg ? s : null; show(); }).catch((err) => { clear(box).append(errorBox(err)); });
  return section;
}

let seq = 0;
const newId = () => `i${Date.now().toString(36)}${(seq++).toString(36)}`;
const TOOL_ICON = { travel: '➜', impact: '✕', guest: 'G', rider: 'R', patroller: '✚', tree: '▲', rock: '◆', sign: '▭', rope: '┄', tower: '╥', gun: '❄', groomer: '▬', line: '╱', text: 'Aa' };

function editor({ c, id, start, onSaved, onCancel }) {
  let data = start && Array.isArray(start.items) ? JSON.parse(JSON.stringify(start)) : { items: [], compass: { mode: 'uphill', angle: 0 }, note: '' };
  data.compass = data.compass || { mode: 'uphill', angle: 0 };
  const history = [];
  let tool = null; let selected = null; let drag = null; let dirty = false;
  const trail = placeOf(c); const when = whenOf(c);

  const canvas = h('div', { class: 'scene-canvas', role: 'application', 'aria-label': 'Scene drawing. Choose an item below, then tap the drawing to place it. Drag to move it.' });
  const hint = h('p', { class: 'small muted', role: 'status' });
  const statusEl = h('span', { class: 'small muted', role: 'status' });
  const tools = h('div', { class: 'scene-tools', role: 'group', 'aria-label': 'Add to the drawing' });
  const selBar = h('div', { class: 'scene-selbar row wrap' });
  const compassLabel = h('span', { class: 'small' });
  const compassToggle = button('Show north instead', () => { snapshot(); data.compass.mode = data.compass.mode === 'north' ? 'uphill' : 'north'; change(); }, { small: true });
  const note = input({ maxlength: 300, value: data.note || '', placeholder: 'For example: looking downhill from the lift tower 7', 'aria-label': 'Note on the drawing' });

  const snapshot = () => { history.push(JSON.stringify(data)); if (history.length > 50) history.shift(); };
  const find = (iid) => data.items.find((it) => it.id === iid);
  const render = () => {
    data.note = note.value;
    try { canvas.innerHTML = sceneSvg(data, { trail, when, selected, interactive: true }); } catch (err) { canvas.textContent = err.message; }
    statusEl.textContent = dirty ? 'Not saved yet' : '';
    for (const b of tools.querySelectorAll('button[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    hint.textContent = tool ? (KIND[tool].shape === 'two' ? `Tap where the ${KIND[tool].label.toLowerCase()} starts and drag to where it ends.` : `Tap the drawing to place the ${KIND[tool].label.toLowerCase()}.`)
      : selected ? 'Drag to move it. Use the buttons below to turn, label or remove it.' : 'Choose something to add, or tap an item to move it.';
    const sel = selected ? find(selected) : null;
    clear(selBar);
    if (sel) {
      selBar.append(...[h('b', null, KIND[sel.t].label),
        KIND[sel.t].shape === 'point' && sel.t !== 'text' ? button('Turn left', () => { snapshot(); sel.r = ((sel.r || 0) - 45) % 360; change(); }, { small: true }) : null,
        KIND[sel.t].shape === 'point' && sel.t !== 'text' ? button('Turn right', () => { snapshot(); sel.r = ((sel.r || 0) + 45) % 360; change(); }, { small: true }) : null,
        KIND[sel.t].shape === 'two' ? button('Turn around', () => { snapshot(); [sel.x, sel.y, sel.x2, sel.y2] = [sel.x2, sel.y2, sel.x, sel.y]; change(); }, { small: true }) : null,
        button(sel.label ? 'Change label' : 'Add label', () => labelDialog(sel), { small: true }),
        button('Remove', () => { snapshot(); data.items = data.items.filter((x) => x !== sel); selected = null; change(); }, { small: true })].filter(Boolean));
    }
    compassLabel.textContent = data.compass.mode === 'north' ? 'North arrow' : 'Uphill arrow';
    compassToggle.textContent = data.compass.mode === 'north' ? 'Show uphill instead' : 'Show north instead';
  };
  const change = () => { dirty = true; render(); };

  const labelDialog = (it, isNew = false) => {
    const t = input({ maxlength: 40, value: it.label || '', placeholder: it.t === 'text' ? 'Cat track, Lift 2 tower 7' : 'Guest A, Skier B', required: it.t === 'text' });
    formDialog(it.t === 'text' ? 'Label' : `Label: ${KIND[it.t].label}`, field('Words on the drawing', t, 'Short: up to 40 characters'), async () => {
      const v = t.value.trim();
      if (it.t === 'text' && !v) throw new Error('Type the label');
      if (!isNew) snapshot();
      if (v) it.label = v; else delete it.label;
      change();
    }, { onClose: () => { if (isNew && it.t === 'text' && !it.label) { data.items = data.items.filter((x) => x !== it); selected = null; render(); } } });
  };

  for (const [k, text] of KINDS) {
    const b = h('button', { type: 'button', class: 'btn scene-tool', 'data-tool': k, 'aria-pressed': 'false' }, h('span', { class: 'scene-ico', 'aria-hidden': 'true' }, TOOL_ICON[k] || ''), text);
    b.addEventListener('click', () => { tool = tool === k ? null : k; selected = null; render(); });
    tools.append(b);
  }

  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(Math.min(W, Math.max(0, ((e.clientX - r.left) / (r.width || W)) * W))), y: Math.round(Math.min(H, Math.max(0, ((e.clientY - r.top) / (r.height || H)) * H))) };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = point(e);
    const handle = e.target.closest && e.target.closest('[data-handle]');
    const itemEl = e.target.closest && e.target.closest('.scene-item');
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* not capturable */ }
    e.preventDefault();
    if (tool) {
      if (data.items.length >= MAX_ITEMS) { toast(`A drawing can have up to ${MAX_ITEMS} items`, 'error'); tool = null; render(); return; }
      snapshot();
      const it = { id: newId(), t: tool, x: p.x, y: p.y };
      if (KIND[tool].shape === 'two') { it.x2 = p.x; it.y2 = p.y; drag = { kind: 'b', it, from: p, placing: true }; } else { it.r = 0; drag = null; }
      data.items.push(it);
      selected = it.id;
      const placed = tool;
      tool = null;
      dirty = true;
      render();
      if (placed === 'text') labelDialog(it, true);
      return;
    }
    if (handle && selected) { snapshot(); drag = { kind: handle.dataset.handle, it: find(selected), from: p }; return; }
    if (itemEl) {
      selected = itemEl.dataset.id;
      const it = find(selected);
      snapshot();
      drag = { kind: 'move', it, from: p, orig: { ...it }, moved: false };
      render();
      return;
    }
    selected = null; drag = null; render();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !drag.it) return;
    const p = point(e);
    const it = drag.it;
    if (drag.kind === 'move') {
      const dx = p.x - drag.from.x; const dy = p.y - drag.from.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      it.x = Math.min(W, Math.max(0, drag.orig.x + dx)); it.y = Math.min(H, Math.max(0, drag.orig.y + dy));
      if (KIND[it.t].shape === 'two') { it.x2 = Math.min(W, Math.max(0, drag.orig.x2 + dx)); it.y2 = Math.min(H, Math.max(0, drag.orig.y2 + dy)); }
    } else if (drag.kind === 'a') { it.x = p.x; it.y = p.y; } else { it.x2 = p.x; it.y2 = p.y; }
    dirty = true;
    render();
  });
  const end = () => {
    if (drag && drag.placing) {
      const it = drag.it;
      if (Math.hypot(it.x2 - it.x, it.y2 - it.y) < 20) { it.x2 = Math.min(W, it.x + 140); it.y2 = it.y; render(); } // a tap, not a drag: a sensible length to stretch
    }
    if (drag && drag.kind === 'move' && !drag.moved) history.pop(); // a tap to select changes nothing
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  note.addEventListener('input', () => { dirty = true; statusEl.textContent = 'Not saved yet'; });

  const turnCompass = (d) => { snapshot(); data.compass.angle = ((data.compass.angle || 0) + d) % 360; change(); };
  const save = button('Save drawing', async () => {
    data.note = note.value.trim();
    try {
      const out = await put(`/patrol/incidents/${id}/scene`, { data });
      dirty = false;
      toast('Scene diagram saved.');
      onSaved({ data: out.data, svg: out.svg, updated_at: out.updated_at, updated_by: null });
    } catch (err) {
      if (offline(err)) toast('No signal: keep this page open and press Save drawing again when you have signal.', 'error');
      else fail(err);
    }
  }, { kind: 'primary' });

  render();
  return h('div', { class: 'stack scene-editor' },
    hint, canvas,
    tools,
    selBar,
    h('div', { class: 'row wrap' },
      compassLabel,
      button('Turn arrow left', () => turnCompass(-45), { small: true }), button('Turn arrow right', () => turnCompass(45), { small: true }),
      compassToggle),
    field('Note under the drawing', note),
    h('div', { class: 'row wrap' }, save,
      button('Undo', () => { const last = history.pop(); if (!last) return; data = JSON.parse(last); selected = null; note.value = data.note || ''; change(); }, { small: true }),
      button('Clear all', () => confirmDialog('Clear the drawing?', 'Everything on it is removed. Undo brings it back until you save.', 'Clear', async () => { snapshot(); data.items = []; selected = null; change(); }), { small: true }),
      button('Cancel', () => { if (!dirty) { onCancel(); return; } confirmDialog('Leave without saving?', 'Your changes to the drawing are lost.', 'Leave', async () => onCancel()); }, { small: true }),
      statusEl),
    h('p', { class: 'small muted' }, 'Saving needs signal. Not to scale: it shows who went where and what was around them.'));
}

// ============================================================ witness statement links
const LINK_STATUS = { sent: ['Sent, not opened yet', 'neutral'], opened: ['Opened, not sent back yet', 'warn'], received: ['Statement received', 'good'], expired: ['Expired', 'neutral'], canceled: ['Canceled', 'neutral'] };

export function witnessLinkButton({ c, editable, id, onDone }) {
  if (!editable || !(id > 0)) return null;
  const wrap = h('span', { class: 'row' });
  const main = button('Send a statement link', () => sendDialog({ c, id, onDone }), { small: true });
  wrap.append(main);
  get(`/patrol/incidents/${id}/witness-links`).then((r) => {
    if (!r.links.length && !r.statements.length) return;
    const waiting = r.links.filter((l) => l.status === 'sent' || l.status === 'opened').length;
    wrap.append(button(`Statement links (${r.links.length})${waiting ? `, ${waiting} waiting` : ''}`, () => linksDialog({ c, id, onDone }), { small: true }));
  }).catch(() => { /* the list shows again on the next load */ });
  return wrap;
}

function shownLink(out, name) {
  return h('div', { class: 'stack witness-show' },
    h('p', null, `Hand the phone to ${name}, or have them scan this with their own phone's camera:`),
    h('div', { class: 'qr-box' }, qr(out.link, { size: 220 })),
    h('p', { class: 'small' }, h('a', { href: out.link, target: '_blank', rel: 'noopener' }, out.link)),
    h('p', { class: 'small muted' }, 'It works once, for 72 hours. Their statement arrives on this case by itself.'));
}

function sendDialog({ c, id, onDone }) {
  const name = input({ name: 'name', required: true, maxlength: 150, autocomplete: 'off' });
  const phone = input({ name: 'phone', type: 'tel', maxlength: 40, autocomplete: 'off' });
  const email = input({ name: 'email', type: 'email', maxlength: 255, autocomplete: 'off' });
  const result = h('div', { role: 'status' });
  const go = async (send) => {
    clear(result);
    const body = { name: name.value.trim(), send };
    if (phone.value.trim()) body.phone = phone.value.trim();
    if (email.value.trim()) body.email = email.value.trim();
    if (!body.name) { result.append(errorBox(new Error('Type the witness\'s name'))); return; }
    try {
      const out = await post(`/patrol/incidents/${id}/witness-links`, body);
      if (send === 'show') { dlg.close(); dialog(`Statement link for ${body.name}`, shownLink(out, body.name)); } else { dlg.close(); toast(out.note || 'Sent.', /not sent/i.test(out.note || '') ? 'error' : 'ok'); }
      if (onDone) onDone();
    } catch (err) {
      result.append(errorBox(offline(err) ? new Error('No signal: a statement link needs signal to make. Try again when you have it, or write their statement with Add witness.') : err));
    }
  };
  const dlg = dialog('Send a statement link', h('div', { class: 'stack' },
    h('p', null, 'The witness writes what they saw in their own words on their own phone, and signs it. It arrives on this case marked as theirs.'),
    field('Witness name', name), h('div', { class: 'row wrap' }, field('Cell phone', phone), field('Email', email)),
    result,
    h('div', { class: 'row wrap' },
      button('Text it', () => go('text'), { kind: 'primary' }), button('Email it', () => go('email')), button('Text and email', () => go('both')), button('Show it here', () => go('show'))),
    h('p', { class: 'small muted' }, `${c.resort && c.resort.name ? `${c.resort.name} is` : 'The mountain is'} named in the message; the patient never is. Making a link needs signal.`)));
}

async function linksDialog({ c, id, onDone }) {
  let r;
  try { r = await get(`/patrol/incidents/${id}/witness-links`); } catch (err) { fail(err); return; }
  const linkRow = (l) => {
    const [text, kind] = LINK_STATUS[l.status] || [l.status, 'neutral'];
    const open = l.status === 'sent' || l.status === 'opened' || l.status === 'expired';
    const again = async (send) => {
      try {
        const out = await post(`/patrol/witness-links/${l.id}/resend`, { send });
        dlg.close();
        if (send === 'show') dialog(`Statement link for ${l.name}`, shownLink(out, l.name)); else toast(out.note || 'Sent again.');
      } catch (err) { fail(err); }
    };
    return h('li', { class: 'stack tight' },
      h('div', { class: 'spread' }, h('span', null, h('b', null, l.name), h('span', { class: 'muted small' }, ` ${[l.phone, l.email].filter(Boolean).join(', ')}`)), state(text, kind)),
      h('div', { class: 'muted small' }, [`Made ${fmtDateTime(l.created_at)}${l.created_by_name ? ` by ${l.created_by_name}` : ''}`, l.send_note, l.received_at ? `Received ${fmtDateTime(l.received_at)}` : ''].filter(Boolean).map((x) => `${x.replace(/\.$/, '')}.`).join(' ')),
      open ? h('div', { class: 'row wrap' },
        l.phone ? button('Text it again', () => again('text'), { small: true }) : null,
        l.email ? button('Email it again', () => again('email'), { small: true }) : null,
        button('Show it here', () => again('show'), { small: true }),
        l.status !== 'expired' ? button('Cancel link', () => confirmDialog('Cancel this link?', `${l.name} will not be able to use it.`, 'Cancel link', async () => { await post(`/patrol/witness-links/${l.id}/cancel`); dlg.close(); toast('Link canceled.'); if (onDone) onDone(); }), { small: true }) : null) : null);
  };
  const stRow = (s) => h('li', { class: `stack tight${s.voided_at ? ' voided' : ''}` },
    h('div', { class: 'spread' }, h('b', null, s.name), s.voided_at ? state('Entered in error', 'neutral') : state('In their own words', 'good')),
    h('div', { class: 'muted small' }, `In their own words, received ${fmtDateTime(s.received_at)}${s.signed ? ', signed on their phone' : ''}.${s.voided_at ? ` Marked entered in error: ${s.void_reason}` : ''}`),
    h('p', { class: 'prewrap' }, s.statement),
    !s.voided_at && c.report_state === 'draft' ? h('div', { class: 'row' }, button('Mark entered in error', () => {
      const reason = input({ required: true, minlength: 3, maxlength: 255 });
      formDialog('Mark as entered in error', h('div', { class: 'stack' }, h('p', null, h('b', null, `Statement from ${s.name}`)), h('p', { class: 'muted small' }, 'It stays on the record, struck through, with your reason and your name. Nobody can change what the witness wrote.'), field('Why', reason)), async () => {
        await post(`/patrol/incidents/${id}/witness-statements/${s.id}/void`, { reason: reason.value.trim() });
        dlg.close(); toast('Marked entered in error.'); if (onDone) onDone();
      }, { submitText: 'Mark entered in error' });
    }, { small: true })) : null);
  const dlg = dialog('Statement links', h('div', { class: 'stack' },
    r.statements.length ? h('section', { class: 'stack' }, h('h3', null, 'Statements received'), h('ul', { class: 'plain' }, r.statements.map(stRow))) : null,
    r.links.length ? h('section', { class: 'stack' }, h('h3', null, 'Links sent'), h('ul', { class: 'plain' }, r.links.map(linkRow))) : h('p', { class: 'muted' }, 'No links sent yet.'),
    c.report_state !== 'draft' ? h('p', { class: 'small muted' }, 'This report has been signed off, so a statement that arrives now goes in as an addendum under Record, Notes and addenda.') : null,
    h('div', { class: 'row' }, button('Send another link', () => { dlg.close(); sendDialog({ c, id, onDone }); }, { small: true }))), { wide: true });
}
