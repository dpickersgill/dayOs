// Guided tours for demo mountains. A card in the corner walks the visitor through the real app one step at a time,
// opening the right page and ringing the button or panel each step is about. The visitor does the clicking: a step
// that asks them to click something moves on when they do. Tours never change anything on their own, apart from the
// "Type it for me" buttons, which only fill in the scan box.
//
// Progress is kept in this tab (so a reload carries on where it was) and sent to the server, so the platform's Demos
// dashboard can show which tours each visitor took and finished.

import { h, clear, dialog, ctx } from './ui.js';
import { post } from './api.js';

// A step: route (open this page first), at (CSS selector) and/or text (the element's own words), title and body,
// click (move on when the visitor clicks it), until (move on when this becomes true), fill (a "Type it for me" button).
export const TOURS = [
  {
    id: 'morning', title: 'Your morning at a glance', minutes: 3,
    blurb: 'The Today screen, then opening lifts and trails for the day.',
    steps: [
      { route: '#/dashboard', at: '.page-head h1', title: 'Today', body: 'Lifts, trails, snow, sales, rentals, lessons, staffing, patrol and open work orders, on one screen. It is what a GM or ops manager opens first.' },
      { at: 'a.board-alert', title: 'What needs a look', body: 'Anything that blocks opening or needs attention shows up here, and each one links straight to the page that fixes it.' },
      { at: 'button', text: 'Wall screen', title: 'On the big screen', body: 'Wall screen turns this into a display for a TV in the patrol room or the ticket office. It refreshes on its own.' },
      { route: '#/conditions', at: '.page-head h1', title: 'Mountain status', body: 'Every lift and trail, with its status for today. What you set here is what guests see on your conditions page.' },
      { at: 'button', text: 'Wind hold', click: true, title: 'Try it: put a lift on wind hold', body: 'Click Wind hold on any lift. The Today screen and the public conditions page change straight away.' },
      { at: 'button', text: 'Grooming', click: true, title: 'Grooming and snow', body: 'Click Grooming. Grooming, snow and weather, lift maintenance and daily reports each have their own tab.' },
      { title: 'That is the morning', body: 'Next, try selling a lift ticket, or pick another tour.' },
    ],
  },
  {
    id: 'sell', title: 'Sell a lift ticket', minutes: 3,
    blurb: 'Ring up a day ticket at the window and take a card payment.',
    steps: [
      { route: '#/sell', at: '.page-head h1', title: 'The ticket window', body: 'Tickets, lessons, rentals, programs and gift cards, all from one screen. It works on a tablet or a counter computer.' },
      { at: 'button.tile', click: true, title: 'Add a ticket', body: 'Click any ticket to put it in the basket. Age prices, promo codes and tax are worked out for you.' },
      { at: 'button.btn', text: 'Checkout', click: true, title: 'Check out', body: 'Click Checkout to take payment.' },
      { at: '.dialog button', text: 'Quick sale: no name', click: true, title: 'Who is it for', body: 'Find the guest or type their details: season passes and lessons need a name. For a day ticket you can skip it. Click Quick sale: no name.' },
      { at: '.dialog button', text: 'Card', click: true, title: 'Take payment', body: 'Cash, card, a gift card, or split between them. Click Card. This is a demo: no money moves.' },
      { at: '.dialog button', text: 'Take card', click: true, title: 'Card details', body: 'The last 4 digits and approval code are optional. Click Take card.' },
      { at: '.dialog button', text: 'Complete sale', click: true, title: 'Done', body: 'Click Complete sale. The sale is in Sold today and in the day\'s money report.' },
      { at: '.dialog', title: 'Sold', body: 'Print a receipt, the tickets or wristband slips. The ticket can be scanned at the gate straight away: the Gate tour shows how, with RFID cards too.' },
    ],
  },
  {
    id: 'gate', title: 'Gate scanning and RFID cards', minutes: 4,
    blurb: 'Scan a ticket, tap an RFID card, block a lost one, and pair a turnstile.',
    steps: [
      { route: '#/gate', at: '.scan-input', title: 'Tap a card', body: 'A USB RFID reader or barcode scanner types into this box. Card 04A1B2C3D4E5F6 carries a day ticket: type it and press Enter, or let us type it.', fill: { at: '.scan-input', value: '04A1B2C3D4E5F6' }, until: () => document.querySelector('.gate[data-result]') },
      { at: '.gate', title: 'Green means go', body: 'The gate shows who it is, what they hold and whether they can ride. Android phones can read cards too, with Use phone NFC, and any phone can scan a barcode with its camera.' },
      { at: '.scan-input', title: 'A lost card', body: 'Card 04C0FFEE123456 was reported lost. Type it in: it is refused, even though its ticket is still good.', fill: { at: '.scan-input', value: '04C0FFEE123456' }, until: () => document.querySelector('.gate[data-result="bad"]') },
      { at: 'button', text: 'Cards', click: true, title: 'Every card', body: 'Click Cards to see every card and what it carries.' },
      { at: 'button.btn', text: 'Load a card', title: 'Load a card', body: 'Tap a card, scan the ticket, done. A lost card is blocked in one click, and its ticket moves to a new card.' },
      { route: '#/settings/sell', at: 'button.btn', text: 'Add a device', title: 'Gates and turnstiles', body: 'Turnstiles, gates and handhelds from any maker are set up in Settings, Sell and gate. Each pairs with a one-time code, checks tickets online, keeps a list for when the network drops, and sends its scans when it is back.' },
    ],
  },
  {
    id: 'patrol', title: 'Patrol: a case from call to report', minutes: 5,
    blurb: 'Open an incident, see care, vitals and the report, then statistics and the injury network.',
    module: 'patrol',
    steps: [
      { route: '#/patrol', at: '.page-head h1', title: 'Patrol', body: 'Built for a phone on the hill: open cases, dispatch, the map, posts and trail checks.' },
      { at: 'button.fab', title: 'Start a case anywhere', body: 'New case is always one tap away. A patroller can start the report on scene and finish it in the aid room.' },
      { at: 'a.case-row', click: true, title: 'Open a case', body: 'Click any case in the list.' },
      { at: 'button.pstep', title: 'What to do next', body: 'The next steps guide the patroller: add the patient, take vitals, log injuries and treatment, record the outcome.' },
      { at: 'button.btn', text: 'Add vitals', title: 'Vitals and care', body: 'Vitals, injuries and treatments are logged with times, and they keep working without a signal. They are sent when it comes back.' },
      { at: 'button', text: 'Report', click: true, title: 'The report', body: 'Click Report. The full incident report, laid out like the NSAA form, filled from what was logged during care.' },
      { route: '#/patrol/cases?tab=stats', at: '.figures', title: 'Statistics', body: 'Cases by type, place, hour, activity and injury, and response times, for any dates.' },
      { route: '#/patrol/cases?tab=network', at: '.panel h2', title: 'The injury network', body: 'Mountains can share anonymous injury counts with the National Ski Patrol and NSAA, and see how their season compares. Demo mountains cannot join, but you can read how it works here.' },
    ],
  },
  {
    id: 'staff', title: 'Staff schedule and time clock', minutes: 3,
    blurb: 'Build the week, publish it, and clock in at the kiosk.',
    steps: [
      { route: '#/workforce', at: '.page-head h1', title: 'The week', body: 'The week as a grid: people down the side, days across. Click a shift to change it, or an empty day to add one. The person picker puts first whoever can work it, and says why anyone else cannot (a missing certification, a clash, their availability).' },
      { at: 'button.btn', text: 'Add shift', title: 'Add a shift', body: 'Pick the person, the position and the hours.' },
      { at: 'button.btn', text: 'Publish this week', title: 'Publish', body: 'Publishing sends staff their shifts. Until then, the week is a draft only managers see.' },
      { at: 'button', text: 'Time clock kiosk', click: true, title: 'The time clock', body: 'Click Time clock kiosk. A tablet at the staff entrance becomes a time clock: staff clock in with a PIN.' },
      { route: '#/myshifts', at: '.page-head h1', title: 'What staff see', body: 'Each person sees their own shifts on their phone, and can offer one up for a swap.' },
    ],
  },
  {
    id: 'assets', title: 'Assets and fleet', minutes: 3, module: 'assets',
    blurb: 'Groomers, lifts, snowmaking and buildings: service, parts and costs.',
    steps: [
      { route: '#/assets', at: '.page-head h1', title: 'Assets and fleet', body: 'Every machine and building on one register: what needs service, papers running out, parts running low, and what costs the most to keep.' },
      { at: 'a.stat', title: 'At a glance', body: 'Each number opens the list behind it.' },
      { at: 'button', text: 'Service', click: true, title: 'Service', body: 'Click Service. Planned maintenance by hours, miles or date, and the work orders it creates.' },
      { at: 'button', text: 'Parts', click: true, title: 'Parts and stock', body: 'Click Parts. Stock levels, reorder points, and parts used on each job.' },
      { at: 'button', text: 'Costs', click: true, title: 'Costs', body: 'Click Costs. Labor, parts and fuel by machine, so replacing it is a decision made on numbers.' },
    ],
  },
  {
    id: 'waivers', title: 'Waivers', minutes: 2,
    blurb: 'Guests sign online or at the counter; the gate knows who has signed.',
    steps: [
      { route: '#/waivers', at: '.page-head h1', title: 'Signed waivers', body: 'Every waiver, signed online before the visit or at the counter, kept word for word as it was signed.' },
      { at: 'button', text: 'Sign a guest', click: true, title: 'Sign at the counter', body: 'Click Sign a guest. The guest signs on the screen; a parent signs for a child.' },
      { route: '#/settings/waivers', at: 'textarea', title: 'Your wording', body: 'The wording is in Settings, Waivers. Change the text, and choose whether everyone has to sign again. The gate shows whether a pass holder has signed this season.' },
    ],
  },
];

const KEY = 'summitops.tour';
const DONE = 'summitops.tours.done';
const read = (store, key, fallback) => { try { const v = JSON.parse(store.getItem(key)); return v ?? fallback; } catch (_) { return fallback; } };
const write = (store, key, v) => { try { if (v === null) store.removeItem(key); else store.setItem(key, JSON.stringify(v)); } catch (_) { /* private window */ } };

export const available = () => TOURS.filter((t) => !t.module || !ctx.me || !ctx.me.modules || ctx.me.modules.includes(t.module));
export const doneTours = () => read(localStorage, `${DONE}.${ctx.me ? ctx.me.tenant : ''}`, []);
const markDone = (id) => write(localStorage, `${DONE}.${ctx.me ? ctx.me.tenant : ''}`, [...new Set([...doneTours(), id])]);
const report = (tour, step, done = false) => post('/demo-tours', { tour: tour.id, step, total: tour.steps.length, done }).catch(() => {});

let card = null; let ring = null; let timer = null; let cleanup = [];
let current = null; // { tour, i }

/** Find a step's element: the first visible match for its selector whose own words start with its text. */
function find(step) {
  if (!step.at) return null;
  const visible = (e) => e.getClientRects().length > 0 && !e.closest('.tour-card');
  const words = (e) => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ');
  return [...document.querySelectorAll(step.at)].find((e) => visible(e) && (!step.text || words(e).startsWith(step.text))) || null;
}

function unring() { if (ring) ring.classList.remove('tour-ring'); ring = null; }
function stopStep() { clearInterval(timer); timer = null; unring(); for (const f of cleanup) f(); cleanup = []; }

export function endTour() {
  stopStep();
  if (card) card.remove();
  card = null; current = null;
  write(sessionStorage, KEY, null);
}

export function startTour(id, from = 0) {
  const tour = TOURS.find((t) => t.id === id);
  if (!tour) return;
  current = { tour, i: from };
  show();
}

/** Carry on after a reload, if a tour was running in this tab. */
export function resumeTour() {
  const s = read(sessionStorage, KEY, null);
  if (s && TOURS.some((t) => t.id === s.id)) startTour(s.id, s.i);
}

function go(delta) {
  if (!current) return;
  const next = current.i + delta;
  if (next < 0) return;
  if (next >= current.tour.steps.length) { finish(); return; }
  current.i = next;
  show();
}

function finish() {
  const { tour } = current;
  report(tour, tour.steps.length, true);
  markDone(tour.id);
  endTour();
  const left = available().filter((t) => !doneTours().includes(t.id));
  if (left.length) openTourPicker({ heading: `Done: ${tour.title}`, intro: 'Pick the next one, or explore on your own.' });
}

function show() {
  stopStep();
  const { tour, i } = current;
  const step = tour.steps[i];
  write(sessionStorage, KEY, { id: tour.id, i });
  report(tour, i + 1);
  if (step.route && !location.hash.startsWith(step.route)) location.hash = step.route;

  if (!card) { card = h('aside', { class: 'tour-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Guided tour' }); document.body.append(card); }
  const last = i === tour.steps.length - 1;
  const hint = h('p', { class: 'tour-hint', hidden: true }, 'This part is not on the screen right now. Use Next to carry on.');
  const fill = step.fill ? h('button', { type: 'button', class: 'btn small', onclick: () => {
    const el = document.querySelector(step.fill.at);
    if (!el) return;
    el.value = step.fill.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (el.form) el.form.requestSubmit(); else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  } }, 'Type it for me') : null;
  clear(card).append(
    h('p', { class: 'tour-meta' }, `${tour.title} · Step ${i + 1} of ${tour.steps.length}`),
    h('h2', null, step.title),
    h('p', null, step.body),
    hint,
    h('div', { class: 'tour-actions' },
      fill,
      i > 0 ? h('button', { type: 'button', class: 'btn small', onclick: () => go(-1) }, 'Back') : null,
      h('button', { type: 'button', class: 'btn small primary', onclick: () => go(1) }, last ? 'Finish' : step.click ? 'Skip' : 'Next'),
      h('button', { type: 'button', class: 'linklike tour-end', onclick: () => endTour() }, 'End tour')));

  // Ring the element when it appears (pages load, tabs re-draw), and keep ringing it while the step is open.
  const started = Date.now();
  let hooked = null;
  const tick = () => {
    if (step.until && step.until()) { go(1); return; }
    const el = find(step);
    if (el && el !== ring) {
      unring();
      ring = el; el.classList.add('tour-ring');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (step.click && el !== hooked) {
        hooked = el;
        const onClick = () => setTimeout(() => go(1), 50);
        el.addEventListener('click', onClick, { once: true, capture: true });
        cleanup.push(() => el.removeEventListener('click', onClick, { capture: true }));
      }
    }
    hint.hidden = !step.at || Boolean(el) || Date.now() - started < 6000;
    // Never cover what the step is pointing at: move the card to the top of the screen while it would.
    if (el && card) {
      const r = el.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const top = card.classList.contains('tour-top');
      const wouldCover = (box) => r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
      if (!top && wouldCover(c)) card.classList.add('tour-top');
      else if (top && r.top < c.bottom + 8 && !wouldCover({ top: window.innerHeight - c.height - 96, bottom: window.innerHeight - 96, left: c.left, right: c.right })) card.classList.remove('tour-top');
    }
  };
  timer = setInterval(tick, 250);
  timer.unref?.();
  tick();
}

/** The list of tours: shown when a demo opens for the first time, and from the demo tag at any time. */
export function openTourPicker({ heading = 'Guided tours', intro = 'Short walk-throughs of the real app, with your demo mountain\'s data. Each takes a few minutes, and you can stop at any point.' } = {}) {
  const done = doneTours();
  let dlg = null;
  const list = h('div', { class: 'tour-list' }, available().map((t) => h('button', { type: 'button', class: 'tour-pick', onclick: () => { dlg.close(); startTour(t.id); } },
    h('strong', null, t.title), h('span', null, t.blurb),
    h('small', null, done.includes(t.id) ? `Done · about ${t.minutes} minutes` : `About ${t.minutes} minutes`))));
  dlg = dialog(heading, h('div', { class: 'stack' }, h('p', null, intro), list,
    h('div', { class: 'footer row' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Explore on my own'))), { wide: true });
}

/** First visit to a demo: say hello and offer the tours, once per demo mountain in this browser. */
export function welcomeOnce() {
  const key = `summitops.tours.welcomed.${ctx.me.tenant}`;
  if (read(localStorage, key, false) || read(sessionStorage, KEY, null)) return;
  write(localStorage, key, true);
  openTourPicker({ heading: `Welcome to ${ctx.me.tenant_name}`, intro: 'This demo mountain is yours for a week, filled with made-up guests, staff, sales and patrol cases. Change anything you like. Want a quick guided tour first?' });
}
