// Programs (muni release 1): a stub from the foundation workstream. The assets-core workstream replaces this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Programs'), h('p', null, 'One job over many assets or map features, such as hydrant flushing or valve exercising.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
