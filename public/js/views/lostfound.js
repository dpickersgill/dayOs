// Front desk > Lost and found: what has been handed in, what guests have reported missing (here or on the website),
// and the likely matches between them. Confirming a match tells the guest by email or text. An item leaves as returned
// (who collected it, with their ID checked), donated or thrown away once its keeping time is up.
import { get, post, put } from '../api.js';
import { h, clear, input, select, field, button, toast, formDialog, dialog, confirmDialog, empty, errorBox, state, fmtDate, fmtDateTime, nowInput, todayStr, ctx, isManager, fail, closeAllDialogs } from '../ui.js';

const STATUS = { held: ['Held', 'neutral'], matched: ['Owner found, waiting for pickup', 'good'], returned: ['Returned', 'good'], donated: ['Donated', 'neutral'], discarded: ['Thrown away', 'neutral'] };
const VALUABLE = ['phone', 'wallet', 'keys', 'card', 'electronics', 'jewelry'];

export async function render(root) {
  const body = h('div');
  let view = 'open';
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Lost and found')), body);
  async function load() {
    clear(body).append(h('p', { class: 'loading' }, 'Loading lost and found…'));
    try { draw(await get(`/lost-found?status=${view}`)); } catch (err) { clear(body).append(errorBox(err)); }
  }
  function draw(r) {
    const kindText = (k) => (r.kinds.find((x) => x[0] === k) || [k, k])[1];
    const what = (i) => [i.color, i.brand, kindText(i.kind).toLowerCase()].filter(Boolean).join(' ');
    const due = r.items.filter((i) => i.due).length;
    const pick = select([['open', 'Still here'], ['returned', 'Returned'], ['donated', 'Donated'], ['discarded', 'Thrown away'], ['all', 'Everything']], view, { 'aria-label': 'Show' });
    pick.addEventListener('change', () => { view = pick.value; load(); });
    const itemCard = (i) => h('article', { class: 'lf-item', 'data-status': i.status },
      i.has_photo ? h('img', { class: 'lf-photo', src: '', alt: `Photo of item ${i.number}`, 'data-photo': i.id }) : h('div', { class: 'lf-photo lf-nophoto', 'aria-hidden': 'true' }, kindText(i.kind).slice(0, 1)),
      h('div', { class: 'lf-main' },
        h('p', null, h('b', null, `No. ${i.number} `), what(i), i.valuable ? [' ', state('Valuable', 'warn')] : null),
        h('p', { class: 'muted small' }, [i.description, i.found_where ? `Found at ${i.found_where}` : null, fmtDateTime(i.found_at), i.bin ? `Bin ${i.bin}` : null].filter(Boolean).join('. ')),
        h('p', null, state(...STATUS[i.status]), i.due ? [' ', state(`Kept ${r.settings.keep_days} days: clear it out`, 'warn')] : null, i.returned_to ? h('span', { class: 'muted small' }, ` to ${i.returned_to}`) : null)),
      ['held', 'matched'].includes(i.status) ? h('div', { class: 'cover-actions' },
        button('Hand back', () => returnDialog(i, what(i), load), { kind: 'primary', small: true }),
        i.status === 'held' ? button('Whose is it?', () => matchesDialog(i, what(i), load), { small: true }) : button('Not theirs', () => confirmDialog('Undo the match?', 'The item goes back to waiting, and the report opens again.', 'Undo', async () => { await post(`/lost-found/items/${i.id}/unmatch`); await load(); }), { small: true }),
        i.due ? button('Clear out', () => clearDialog(i, load), { small: true }) : null) : null);
    const reportCard = (rp) => h('article', { class: 'lf-item lf-report' },
      h('div', { class: 'lf-main' },
        h('p', null, h('b', null, rp.name), ` lost ${[rp.color, rp.brand, kindText(rp.kind).toLowerCase()].filter(Boolean).join(' ')}`),
        h('p', { class: 'muted small' }, [rp.description, rp.lost_where ? `At ${rp.lost_where}` : null, `on ${fmtDate(rp.lost_on)}`, rp.source === 'web' ? 'From the website' : null, [rp.email, rp.phone].filter(Boolean).join(', ')].filter(Boolean).join('. ')),
        rp.matches.length ? h('p', null, 'Could be: ', ...rp.matches.map((m) => button(`No. ${m.number}`, () => confirmMatch(m.id, rp, load), { small: true }))) : h('p', { class: 'muted small' }, 'Nothing like it handed in yet.')),
      h('div', { class: 'cover-actions' }, button('Close', () => confirmDialog('Close this report?', 'For example, they found it themselves. It leaves the list.', 'Close', async () => { await post(`/lost-found/reports/${rp.id}/close`); await load(); }), { small: true })));
    clear(body).append(
      h('div', { class: 'week-bar' },
        h('p', { class: 'muted' }, `Items are kept ${r.settings.keep_days} days.${r.settings.web_form ? ' Guests can also report on your website.' : ''}${due ? ` ${due} ready to clear out.` : ''}`),
        h('div', { class: 'week-actions' },
          button('Log a found item', () => itemDialog(r.kinds, load), { kind: 'primary' }),
          button('A guest lost something', () => reportDialog(r.kinds, r.today, load)),
          isManager() ? button('Settings', () => settingsDialog(r.settings, load)) : null, pick)),
      h('section', { class: 'cover-section' }, h('h2', null, `Handed in (${r.items.length})`), r.items.length ? h('div', { class: 'lf-list' }, r.items.map(itemCard)) : empty(view === 'open' ? 'Nothing is waiting to be claimed.' : 'Nothing here.')),
      ...(view === 'open' ? [h('section', { class: 'cover-section' }, h('h2', null, `Reported missing (${r.reports.length})`), r.reports.length ? h('div', { class: 'lf-list' }, r.reports.map(reportCard)) : empty('No open reports.'))] : []));
    // Photos load with the signed-in session.
    for (const img of body.querySelectorAll('img[data-photo]')) loadPhoto(img, img.dataset.photo);
  }
  await load();
}

async function loadPhoto(img, id) {
  try {
    const { session } = await import('../api.js');
    const res = await fetch(`/api/v1/lost-found/items/${id}/photo`, { headers: { authorization: `Bearer ${session.token}` } });
    if (res.ok) img.src = URL.createObjectURL(await res.blob());
  } catch (_) { /* the item still shows without its photo */ }
}

/** A photo from the phone or tablet camera, made small (640 px, JPEG) so it travels with the record. */
function photoInput() {
  let data = null;
  const preview = h('img', { class: 'lf-preview', alt: '', hidden: true });
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.7, 0.55, 0.4]) { data = c.toDataURL('image/jpeg', q); if (data.length < 85_000) break; }
    preview.src = data; preview.hidden = false;
  });
  return { el: h('div', { class: 'stack tight' }, file, preview), get: () => data };
}

function itemDialog(kinds, onDone) {
  const kind = select(kinds, 'gloves', { name: 'kind' });
  const valuable = h('input', { type: 'checkbox', name: 'valuable' });
  kind.addEventListener('change', () => { valuable.checked = VALUABLE.includes(kind.value); });
  const photo = photoInput();
  formDialog('Log a found item', h('div', { class: 'form' },
    field('What is it?', kind), field('Color', input({ name: 'color', maxlength: 40 })), field('Brand', input({ name: 'brand', maxlength: 60 })),
    field('Found where', input({ name: 'found_where', maxlength: 150, placeholder: 'Summit Quad, base lodge, parking lot' })),
    field('Found when', input({ type: 'datetime-local', name: 'found_at', value: nowInput(), required: true })), field('Handed in by', input({ name: 'found_by', maxlength: 150 })),
    field('Storage bin', input({ name: 'bin', maxlength: 40, placeholder: 'For example B3' })),
    h('div', { class: 'wide' }, field('Anything that tells it apart', input({ name: 'description', maxlength: 255, placeholder: 'Stickers, a name inside, what is in it. No card numbers.' }))),
    h('div', { class: 'wide' }, field('Photo', photo.el)),
    h('label', { class: 'check wide' }, valuable, 'Valuable: keep it locked away (phones, wallets, keys, cards)')), async (fd) => {
    const s = (k) => String(fd.get(k) || '').trim();
    const body = { kind: s('kind'), found_at: s('found_at'), valuable: valuable.checked, photo: photo.get() };
    for (const k of ['color', 'brand', 'found_where', 'found_by', 'bin', 'description']) if (s(k)) body[k] = s(k);
    const r = await post('/lost-found/items', body);
    toast(`Logged as No. ${r.number}. Write it on the tag.`);
    await onDone();
    if (r.matches.length) {
      dialog('Someone may be looking for this', [h('p', null, 'These open reports look like it:'),
        h('ul', { class: 'plain stack' }, r.matches.map((m) => h('li', { class: 'spread' }, h('span', null, h('b', null, m.name), ` lost ${m.description || m.kind} on ${fmtDate(m.lost_on)}`),
          button('This is theirs', () => confirmMatch(r.id, m, onDone), { kind: 'primary', small: true }))))]);
    }
  }, { submitText: 'Log item', wide: true });
}

function reportDialog(kinds, today, onDone) {
  formDialog('A guest lost something', h('div', { class: 'form' },
    field('What did they lose?', select(kinds, 'phone', { name: 'kind' })), field('Color', input({ name: 'color', maxlength: 40 })), field('Brand', input({ name: 'brand', maxlength: 60 })),
    field('Where', input({ name: 'lost_where', maxlength: 150 })), field('When', input({ type: 'date', name: 'lost_on', value: today || todayStr(), required: true })),
    h('div', { class: 'wide' }, field('Anything that tells it apart', input({ name: 'description', maxlength: 255 }))),
    field('Their name', input({ name: 'name', maxlength: 120, required: true })), field('Email', input({ type: 'email', name: 'email', maxlength: 255 })), field('Cell phone', input({ type: 'tel', name: 'phone', maxlength: 40 }))), async (fd) => {
    const s = (k) => String(fd.get(k) || '').trim();
    const body = { kind: s('kind'), lost_on: s('lost_on'), name: s('name') };
    for (const k of ['color', 'brand', 'lost_where', 'description', 'email', 'phone']) if (s(k)) body[k] = s(k);
    if (!body.email && !body.phone) throw new Error('Give an email address or a phone number, so they can be told when it is found');
    const r = await post('/lost-found/reports', body);
    await onDone();
    if (r.matches.length) {
      dialog('It may already be here', [h('p', null, 'These items look like it. Check with the guest:'),
        h('ul', { class: 'plain stack' }, r.matches.map((m) => h('li', { class: 'spread' }, h('span', null, h('b', null, `No. ${m.number} `), [m.color, m.brand, m.kind_label.toLowerCase()].filter(Boolean).join(' '), m.bin ? `, bin ${m.bin}` : ''),
          button('This is theirs', () => confirmMatch(m.id, { id: r.id, name: body.name }, onDone, false), { kind: 'primary', small: true }))))]);
    } else toast('Report saved. They are told if it is handed in.');
  }, { submitText: 'Save report', wide: true });
}

function confirmMatch(itemId, rep, onDone, tell = true) {
  confirmDialog(`Is it ${rep.name}'s?`, tell ? 'The item is set aside for them, and they get an email or text saying how to collect it.' : 'The item is set aside for them. Hand it back now with Hand back.', 'Yes, theirs', async () => {
    const r = await post('/lost-found/match', { item_id: itemId, report_id: rep.id, tell });
    toast(r.told ? `Matched. They were told by ${r.told}.` : 'Matched');
    closeAllDialogs();
    await onDone();
  });
}

async function matchesDialog(i, what, onDone) {
  const r = await get(`/lost-found/items/${i.id}/matches`);
  dialog(`Whose is No. ${i.number}?`, [h('p', { class: 'muted' }, `${what}. Open reports, most likely first:`),
    r.data.length ? h('ul', { class: 'plain stack' }, r.data.map((m) => h('li', { class: 'spread' }, h('span', null, h('b', null, m.name), ` lost ${[m.color, m.brand, m.kind].filter(Boolean).join(' ')}${m.lost_where ? ` at ${m.lost_where}` : ''} on ${fmtDate(m.lost_on)}`),
      button('This is theirs', () => confirmMatch(i.id, m, onDone), { kind: 'primary', small: true })))) : empty('No open report looks like it.')]);
}

function returnDialog(i, what, onDone) {
  const ok = h('input', { type: 'checkbox', name: 'id_checked', required: true });
  formDialog(`Hand back No. ${i.number}`, h('div', { class: 'stack' }, h('p', null, what),
    field('Collected by', input({ name: 'returned_to', maxlength: 150, required: true })),
    h('label', { class: 'check' }, ok, 'I checked their photo ID')), async (fd) => {
    if (!ok.checked) throw new Error('Check their photo ID before handing it over');
    await post(`/lost-found/items/${i.id}/return`, { returned_to: String(fd.get('returned_to')).trim(), id_checked: true });
    toast('Handed back');
    await onDone();
  }, { submitText: 'Hand back' });
}

function clearDialog(i, onDone) {
  const how = select([['donated', 'Donated'], ['discarded', 'Thrown away']], 'donated');
  formDialog(`Clear out No. ${i.number}`, field('What happened to it', how), async () => {
    await post(`/lost-found/items/${i.id}/clear`, { how: how.value });
    toast('Cleared out'); await onDone();
  }, { submitText: 'Clear out' });
}

function settingsDialog(s, onDone) {
  const days = input({ type: 'number', min: 7, max: 365, value: s.keep_days });
  const web = h('input', { type: 'checkbox', checked: s.web_form });
  const pickup = input({ maxlength: 255, value: s.pickup || '', placeholder: 'Collect it from Guest Services with photo ID.' });
  const link = `${location.origin}/lost/${encodeURIComponent(ctx.me.tenant)}`;
  formDialog('Lost and found settings', h('div', { class: 'stack' },
    field('Keep items for (days)', days, 'After this, items show as ready to donate or throw away'),
    field('How guests collect', pickup, 'Sent to the guest when their item is found'),
    h('label', { class: 'check' }, web, 'Guests can report a lost item on your website'),
    h('p', { class: 'small' }, 'The form: ', h('a', { href: link, target: '_blank', rel: 'noopener' }, link), ' ', button('Copy link', async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch (err) { fail(err); } }, { small: true })),
    h('p', { class: 'muted small' }, 'Link it from your website, or print it as a QR code at Guest Services.')), async () => {
    await put('/lost-found/settings', { keep_days: Number(days.value), web_form: web.checked, pickup: pickup.value.trim() || null });
    toast('Settings saved'); await onDone();
  }, { submitText: 'Save' });
}
