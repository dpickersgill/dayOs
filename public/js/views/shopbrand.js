// Manager screen: how the public shop page looks (logo, colour, hero photo) and the opening-day banner.
import { get, put } from '../api.js';
import { h, input, field, button, toast, errorBox } from '../ui.js';
import { fit } from '../photo.js';

export async function brandPanel() {
  const b = await get('/online-shop/brand');
  let logo = b.logo; let hero = b.hero;
  const color = input({ name: 'color', type: 'color', value: b.color || '#1a5fb4' });
  const useColor = h('input', { type: 'checkbox', checked: Boolean(b.color) });
  const open = input({ name: 'opening_day', type: 'date', value: b.opening_day || '' });
  const note = input({ name: 'opening_note', maxlength: 200, value: b.opening_note || '', placeholder: 'Buy ahead and pick any day.' });
  const prev = (src, cls) => (src ? h('img', { class: cls, src, alt: '' }) : h('span', { class: 'muted small' }, 'None yet'));
  const logoBox = h('div'); const heroBox = h('div');
  const draw = () => { logoBox.replaceChildren(prev(logo, 'brand-logo')); heroBox.replaceChildren(prev(hero, 'brand-hero')); };
  const pick = (kind) => {
    const f = h('input', { type: 'file', accept: 'image/*', 'aria-label': kind === 'logo' ? 'Choose a logo' : 'Choose a hero photo' });
    f.addEventListener('change', async () => {
      try {
        if (kind === 'logo') logo = await fit(f.files[0], 400, 'image/png', 200_000); else hero = await fit(f.files[0], 1400, 'image/jpeg', 380_000);
        draw();
      } catch (e) { toast(e.message, 'error'); }
    });
    return f;
  };
  const slot = h('div');
  const save = button('Save look of the shop page', async () => {
    slot.replaceChildren();
    try {
      await put('/online-shop/brand', { color: useColor.checked ? color.value : null, logo, hero, opening_day: open.value || null, opening_note: note.value.trim() || null });
      toast('Saved');
    } catch (e) { slot.replaceChildren(errorBox(e)); }
  }, { kind: 'primary' });
  draw();
  return h('section', { class: 'section stack', 'data-section': 'shop-look' },
    h('h2', null, 'Look of the online shop'),
    h('label', { class: 'check' }, useColor, ' Use our brand colour for buttons and highlights'), field('Brand colour', color, 'Must be dark enough for white text.'),
    field('Logo', pick('logo'), 'A PNG with a clear background works best.'), logoBox,
    field('Hero photo', pick('hero'), 'A wide photo of the mountain. It sits behind the mountain name.'), heroBox,
    h('div', { class: 'form' }, field('Opening day (shows a banner until this day)', open), field('Banner note', note)),
    slot, h('div', { class: 'row' }, save));
}
