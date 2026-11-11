// Buildings (muni release 1): a stub from the foundation workstream. The buildings workstream replaces this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Buildings'), h('p', null, 'The building inspection calendar and each permit\'s binder.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
