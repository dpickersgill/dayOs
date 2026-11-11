// Work orders for a municipality (muni release 1): a stub until the foundation's work orders view lands in this file.
import { h } from '../ui.js';

export async function render(root) {
  root.append(h('div', { class: 'page-head' }, h('h1', null, 'Work orders'), h('p', null, 'Jobs for the crew, and the service plans that keep trucks and equipment running.')),
    h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Coming in this release.')));
}
