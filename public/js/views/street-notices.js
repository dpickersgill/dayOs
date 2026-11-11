// Street notices (muni release 1): a stub from the foundation workstream. The notices workstream replaces this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Street notices'), h('p', null, 'Texts and emails to residents on the streets a water break or road work affects.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
