// The safety details and consents asked for each lesson booking: allergies, medical notes, who picks the child up,
// who to call, and the family's answers on texts and photos. Used by Sell for a lesson line (Track LINEUP); the
// counter booking dialog (Track CORE) can use the same fields. Plain words a parent understands at the window.
import { h, input } from '../ui.js';

export const PHOTO_WORDS = 'You may take photos of my child during the lesson for the lesson recap. You can change this any time.';
export const TEXT_WORDS = 'Text me about this lesson (check-in, changes and the recap). Message and data rates may apply. Reply STOP to stop.';

/**
 * fields({ name, texts, photos }): texts and photos say whether to ask about each (texts only with the "Texts to
 * families" add-on, photos only when the school sends photo recaps). Returns { el, value(), fill(obj), filled() }.
 */
export function safetyFields({ name = 'the student', texts = false, photos = true } = {}) {
  const id = Math.random().toString(36).slice(2, 7);
  const f = (key, text, attrs = {}, hint = null) => {
    const el = input({ name: key, id: `ls-${key}-${id}`, ...attrs });
    return [el, h('label', { class: 'field', for: el.id }, text, el, hint ? h('span', { class: 'hint' }, hint) : null)];
  };
  const [allergies, allergiesF] = f('allergies', 'Allergies', { maxlength: 300, placeholder: 'For example: peanuts, bee stings. Leave blank if none.' });
  const [medical, medicalF] = f('medical', 'Medical notes', { maxlength: 500, placeholder: 'For example: asthma inhaler in the left pocket' });
  const [pickup, pickupF] = f('pickup', 'Who picks them up', { maxlength: 300, placeholder: 'Names of the adults who may pick up' });
  const [cname, cnameF] = f('contact_name', 'Who to call during the lesson', { maxlength: 150, autocomplete: 'name' });
  const [cphone, cphoneF] = f('contact_phone', 'Their phone', { maxlength: 40, type: 'tel', inputmode: 'tel', autocomplete: 'tel' });
  const [cemail, cemailF] = f('contact_email', 'Email for the confirmation', { maxlength: 255, type: 'email', autocomplete: 'email' });
  const textOk = h('input', { type: 'checkbox', name: 'text_ok' });
  const photoOk = h('input', { type: 'checkbox', name: 'photo_ok' });
  const el = h('div', { class: 'form lesson-safety', 'data-safety': '' },
    allergiesF, medicalF, pickupF, cnameF, cphoneF, cemailF,
    texts ? h('label', { class: 'check wide' }, textOk, ` ${TEXT_WORDS}`) : null,
    photos ? h('label', { class: 'check wide' }, photoOk, ` ${PHOTO_WORDS}`) : null);
  el.setAttribute('aria-label', `Safety details for ${name}`);
  const value = () => {
    const out = {};
    for (const [k, inp] of [['allergies', allergies], ['medical', medical], ['pickup', pickup], ['contact_name', cname], ['contact_phone', cphone], ['contact_email', cemail]]) if (inp.value.trim()) out[k] = inp.value.trim();
    if (texts) out.text_ok = textOk.checked;
    if (photos) out.photo_ok = photoOk.checked;
    return out;
  };
  const fill = (o = {}) => {
    for (const [k, inp] of [['allergies', allergies], ['medical', medical], ['pickup', pickup], ['contact_name', cname], ['contact_phone', cphone], ['contact_email', cemail]]) if (o[k] && !inp.value) inp.value = o[k];
    if (o.text_ok !== undefined) textOk.checked = Boolean(o.text_ok);
    if (o.photo_ok !== undefined) photoOk.checked = Boolean(o.photo_ok);
  };
  const filled = () => Boolean(allergies.value.trim() || medical.value.trim() || pickup.value.trim() || cname.value.trim() || cphone.value.trim());
  return { el, value, fill, filled };
}
