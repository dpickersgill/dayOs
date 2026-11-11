// Requests (muni release 1): a stub from the foundation workstream. The requests workstream replaces this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Requests'), h('p', null, 'Resident requests: reports from residents, each with its repair record.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
