// Text HELP (help/sms): guests text the mountain's help number to reach patrol.
//   textHelpPanel()   Settings > Patrol > Patrol settings: the help number (the Twilio number guests text) and the
//                     patrol phone, the address to give Twilio, and the words for the trail map and ticket back.
//   textHelpBlock(c)  on a call that came by text: the phone, the language, STOP, texts used, and the photos the
//                     guest sent (opened through the server, signed in; never stored).
import { get, put, fetchBlob } from '../api.js';
import { h, clear, appendAll, input, field, button, toast, state, dialog } from '../ui.js';

/** +16105550100 as 610-555-0100, the way the signs, the guest page and the first reply write it; others as given. */
export const showPhone = (p) => { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `${m[1]}-${m[2]}-${m[3]}` : String(p || ''); };

export function textHelpPanel() {
  const box = h('section', { class: 'panel stack', 'data-panel': 'text-help', hidden: true });
  async function draw() {
    let s;
    try { s = await get('/patrol/text-help'); } catch (_) { box.hidden = true; return; } // not for this login
    const help = input({ name: 'help_number', type: 'tel', maxlength: 30, value: s.help_number || '', placeholder: '+16105550100', autocomplete: 'off' });
    const phone = input({ name: 'patrol_phone', type: 'tel', maxlength: 30, value: s.patrol_phone || '', placeholder: '610-555-0100', autocomplete: 'off' });
    const form = h('form', { class: 'stack', novalidate: true },
      h('div', { class: 'form' },
        field('Help number', help, 'The Twilio number guests text. It goes on the sign sheets and the guest help page\'s Send by text instead. Leave blank to turn Text HELP off.'),
        field('Patrol phone (optional)', phone, 'Guests see Call patrol on the help page, and the first reply to a text says "To talk to patrol, call …".')),
      h('div', { class: 'row' }, button('Save', null, { type: 'submit', kind: 'primary', small: true })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await put('/patrol/text-help', { help_number: help.value.trim() || null, patrol_phone: phone.value.trim() || null }); toast('Saved'); await draw(); } catch (err) { toast(err.message, 'error'); }
    });
    const n = s.help_number ? showPhone(s.help_number) : '…';
    appendAll(clear(box),
      h('h3', null, 'Text HELP'),
      h('p', null, 'Guests text HELP to your help number. The text lands on the dispatch board as a New call. The guest gets a reply with the 911 line and a link to send their location. Replies from dispatch go back by text.'),
      s.texts_ready ? null : h('p', null, state('Text messages are not set up for Verdynt/OS yet, so replies cannot go out.', 'warn')),
      form,
      h('div', { class: 'stack tight' },
        h('h4', null, 'For your trail map and ticket back'),
        h('p', null, h('b', null, `Need ski patrol? Text HELP to ${n}.`), ' ', h('span', { lang: 'es' }, `¿Necesita a la patrulla? Envíe AYUDA al ${n}.`)),
        h('p', { class: 'muted small' }, 'If it is life threatening, call 911.')),
      h('details', null, h('summary', null, 'For whoever sets up Twilio'),
        h('p', { class: 'small' }, 'Set this as the help number\'s "A message comes in" webhook (HTTP POST): ', h('code', null, s.webhook_url)),
        h('p', { class: 'small muted' }, 'Help article "Text HELP" has the full set-up.')));
    box.hidden = false;
  }
  draw();
  return box;
}

export function textHelpBlock(c) {
  const box = h('div', { class: 'locate-box stack tight', 'data-block': 'text-help' }, h('p', { class: 'muted' }, 'Loading the texts…'));
  (async () => {
    let v;
    try { v = await get(`/patrol/dispatch/${c.id}/sms`); } catch (err) { clear(box).append(h('p', { class: 'muted' }, err.message)); return; }
    if (!v.by_text) { box.remove(); return; }
    const photos = v.photos || [];
    appendAll(clear(box),
      h('p', null, h('b', null, 'Came by text: '), showPhone(v.phone), ' ',
        v.lang === 'es' ? state('Spanish', 'neutral') : null, ' ',
        v.opted_out ? state('Texted STOP: call them', 'bad') : null),
      h('p', { class: 'muted small' }, `Texts sent on this call: ${v.texts_sent} of ${v.text_cap}.${v.closed_text_at ? ' Closing text sent.' : ''}`),
      v.photos_hidden ? h('p', { class: 'muted small' }, 'Photos: open the case to see them.') : null,
      photos.length ? h('div', { class: 'row' }, ...photos.map((p) => (p.available
        ? button(`Photo ${p.n + 1}`, () => showPhoto(c.id, p.n), { small: true })
        : h('span', { class: 'muted small' }, `Photo ${p.n + 1} (not from Twilio, not shown)`)))) : null);
  })();
  return box;
}

async function showPhoto(callId, n) {
  try {
    const blob = await fetchBlob(`/patrol/dispatch/${callId}/sms-photo/${n}`);
    const url = URL.createObjectURL(blob);
    dialog(`Photo ${n + 1} from the guest`, h('div', { class: 'stack' }, h('img', { src: url, alt: `Photo ${n + 1} the guest texted`, class: 'photo-preview' }),
      h('p', { class: 'muted small' }, 'Shown from Twilio, not saved in Verdynt/OS.')), { onClose: () => URL.revokeObjectURL(url) });
  } catch (err) { toast(err.message, 'error'); }
}
