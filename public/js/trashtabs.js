// The Trash and recycling app's tab registry (release 2026.11.22). The app's view (views/bulk-pickup.js, address #/bulk)
// draws its own tabs and then every tab registered here whose show(ctx) is true, all sorted by order. Each add-on's
// client module (trash-routes.js, trash-tonnage.js) imports this file and registers its tabs when it loads:
//
//   import { registerTab } from './trashtabs.js';
//   registerTab({ id: 'routes', label: 'Routes', order: 15, show: (c) => c.on.includes('collectionroutes') && c.model === 'inhouse', render: async (el, params) => { ... } });
//
// id: the tab's address (#/bulk?tab=<id>), unique in the app. order: where it goes among the app's own tabs, which are
//   Calendar 10, Missed pickups 20, Bulk pickup 50, Bulk bookings 55, Bulk route order 60, Schedule 80, Bulk settings 85,
//   Bulk report 90 (pick a number between them).
// show(ctx): ctx = { me, role, manager, on (the app keys turned on), model ('inhouse' | 'contract' | 'subscription'),
//   setup_done }. A tab whose show throws is left out.
// render(el, params): draws the tab into el. params = ctx plus query (the address's query, a URLSearchParams).
// Registering an id twice replaces the first one.
export const TABS = [];

export function registerTab({ id, label, order = 100, show = () => true, render } = {}) {
  if (!id || !label || typeof render !== 'function') throw new Error('registerTab needs an id, a label and render');
  const at = TABS.findIndex((t) => t.id === id);
  const tab = { id: String(id), label: String(label), order: Number(order) || 100, show, render };
  if (at >= 0) TABS.splice(at, 1, tab); else TABS.push(tab);
  TABS.sort((a, b) => a.order - b.order);
  return tab;
}
