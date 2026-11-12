// "+ New" (release 2026.11.21): one menu of what the person signed in may create, each item a link that opens the
// existing form ready to fill in. The top bar's + New button and the phone's round button show it (the frame draws
// them: frame.setNew), and each item is also a command in Jump to ("New work order": frame.addCommands).
//
// The server says which items this person may have (GET /nav/new, src/lib/navcounts.js): each one's rule is the rule its
// create route applies and its app must be on, so the menu never offers a form the server would refuse (a crew member
// who may not send street notices does not see Street notice; a patrol Host does not see Patrol case). This file knows
// each item's words and address.
//
// Addresses. Where a page already is the form, the item goes there (Sell; Sell's Lessons and Rentals). Everywhere else the
// address carries ?new=1 and the page opens its form with whenNew() below, then takes the mark off the address, so a
// reload, Back or a saved link does not open the form again.
import { get } from './api.js';
import { ctx, isMuni, hashPath, hashParam, withHashParam } from './ui.js';

// id -> what to show and where it goes. href: the page address without "#/". app: the view it belongs to (the frame puts
// that app's items first on its pages, and uses its icon). words: more to find it by in Jump to.
const ITEMS = {
  // A municipality
  request: { label: 'Request', href: 'requests?new=1', app: 'requests', words: 'resident report pothole phone complaint' },
  street_notice: { label: 'Street notice', href: 'notices?new=1', app: 'notices', words: 'alert text residents closure boil water outage' },
  bulk_booking: { label: 'Bulk pickup booking', href: 'bulk?tab=bookings&new=1', app: 'bulk', words: 'trash pickup book' },
  main_break: { label: 'Main break', href: 'water?new=1', app: 'water', words: 'water leak break record' },
  // A ski area
  sale: { label: 'Sale', href: 'sell', app: 'sell', words: 'ticket pass sell order' },
  lesson: { label: 'Lesson booking', href: 'sell?tab=lessons', app: 'school', words: 'book lesson student ski school' },
  rental: { label: 'Rental', href: 'sell?tab=rentals', app: 'rentals', words: 'rent gear skis boots' },
  incident: { label: 'Patrol case', href: 'patrol/now?new=1', app: 'patrol', words: 'incident injury report patient case' },
  lost_item: { label: 'Found item', href: 'lostfound?new=1', app: 'lostfound', words: 'lost item lost and found handed in' },
  customer: { label: 'Customer', href: 'people?new=1', app: 'people', words: 'guest person add customer' },
  calendar_event: { label: 'Calendar event', href: 'calendar?new=1', app: 'calendar', words: 'event meeting training date' },
  // Both
  message: { label: 'Message', href: 'messages?new=1', app: 'messages', words: 'email text campaign send' },
};
// A work order is the crew's Work orders page for a municipality, and Mountain status, Maintenance for a ski area.
const workOrder = () => (isMuni()
  ? { label: 'Work order', href: 'works?new=1', app: 'works', words: 'job repair report a problem' }
  : { label: 'Work order', href: 'conditions?tab=maint&new=1', app: 'conditions', words: 'job repair maintenance report a problem' });

/** The menu's items for a list of ids from the server, in its order: [{ id, label, href, app, icon }]. Unknown ids are left out. */
export function itemsFor(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const it = id === 'work_order' ? workOrder() : ITEMS[id];
    if (it) out.push({ id, label: it.label, href: it.href, app: it.app, icon: it.app, words: it.words });
  }
  return out;
}
/** "New work order", "New patrol case": the command's name in Jump to. */
export const commandTitle = (label) => `New ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

let frame = null;
let items = [];
let wired = new WeakSet(); // frames whose palette already has these commands

/** Called by main.js once the frame is built (again after each sign-in). Draws nothing until the server has answered. */
export async function start(f) {
  frame = f || null;
  items = [];
  if (!frame || typeof frame.setNew !== 'function') return;
  if (typeof frame.addCommands === 'function' && !wired.has(frame)) {
    wired.add(frame);
    // Asked each time the palette opens, so it always matches the menu.
    frame.addCommands(() => (frame === f ? items : []).map((it) => ({
      id: `new:${it.id}`, title: commandTitle(it.label), hint: 'Create', icon: 'plus', words: `new add create ${it.words || ''}`,
      run: () => { location.hash = `#/${it.href}`; },
    })));
  }
  if (!ctx.me || ctx.me.role === 'area') { frame.setNew([]); return; } // the read-only ski area login creates nothing
  let ids = [];
  try { ids = (await get('/nav/new')).items; } catch (_) { ids = []; } // offline or refused: no button rather than a wrong one
  if (frame !== f) return; // signed out and in again meanwhile
  items = itemsFor(ids);
  frame.setNew(items.map(({ id, label, href, app, icon }) => ({ id, label, href, app, icon })));
}

// ---------------------------------------------------------------- ?new=1: a page opens its create form
// A page says how to open its form: whenNew(root, open), once it can (at the end of render, or where a tab draws). When
// the address carries ?new=1 the form opens and the mark comes off the address. The router does not draw a page again
// for a change to its query alone, so a page already on screen is told here instead.
let onScreen = null; // { path, root, open }: the page (or tab) on screen that can open a form

/** True when the address asks for a new record; the mark is taken off the address (no history entry). */
export function takeNew() {
  if (hashParam('new') !== '1') return false;
  try { history.replaceState(null, '', withHashParam('new', null)); } catch (_) { /* the form still opens */ }
  return true;
}

/**
 * root: the element the page (or tab) drew into; open(): opens the create form. Opens it now when the address asks,
 * and later whenever the address asks again while root is still on screen.
 */
export function whenNew(root, open) {
  onScreen = { path: hashPath(), root, open };
  if (takeNew()) open();
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    if (hashParam('new') !== '1' || !onScreen) return;
    // Another page, or a page that has been drawn over: the router (or the tab) draws it, and its own whenNew opens the form.
    if (onScreen.path !== hashPath() || !onScreen.root || !onScreen.root.isConnected) return;
    if (takeNew()) onScreen.open();
  });
}
