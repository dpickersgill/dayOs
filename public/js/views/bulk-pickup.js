// Bulk pickup (muni release 1): a stub from the foundation workstream. The trash workstream replaces this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Bulk pickup'), h('p', null, 'Bulk trash pickups residents book and pay for online.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
