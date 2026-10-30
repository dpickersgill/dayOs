// Settings: everything that is set up once rather than used every day, in one place. Its own list on the left (in
// place of the app menu) in three groups: You (everyone), The mountain and Apps (owners and managers; Apps only for apps
// that are on). A patrol Admin who is not a manager sees the Patrol page as well as their own. On a phone the list is a
// page of its own: pick one, and each page has a link back to the list.
//
// Pages: #/settings/<page>. #/settings on its own opens Your profile and sign-in on a computer, and the list on a phone.
import { get } from '../api.js';
import { h, clear, ctx, isManager, schoolCan, errorBox, loading, confirmDialog } from '../ui.js';
import { hasUnsaved } from './settings-kit.js';

const GROUPS = { you: 'You', mountain: 'The mountain', apps: 'Apps' };

// [key, group, name in the list and title, one line under the title, loader of the page's own module]
const PAGES = [
  ['profile', 'you', 'Your profile and sign-in', 'Your password, passkeys and two-step sign-in, where you are signed in, and light or dark.', () => import('./settings-you.js')],
  ['mountain', 'mountain', 'Mountain details', 'The name, phone and address on receipts, the mountain’s time zone, and the weekly report.', () => import('./settings-mountain.js')],
  ['team', 'mountain', 'Team and logins', 'Who can sign in, who must use two-step sign-in, and the menu each role sees.', () => import('./settings-team.js')],
  ['shared', 'mountain', 'Shared computers', 'Computers several people use, like the ticket window. Staff switch in with their username and PIN.', () => import('./settings-mountain.js')],
  ['billing', 'mountain', 'Billing and plan', 'Your Verdynt/OS plan, how you pay for it, invoices and history.', () => import('./billing.js')],
  ['payments', 'mountain', 'Payments and card readers', 'The Stripe account guests’ card payments go into, and the card readers at the counter.', () => import('./billing.js')],
  ['assistant', 'mountain', 'Assistant', 'Who can ask the assistant, which guest pages show it, and this month’s use.', () => import('./settings-mountain.js')],
  ['sell', 'apps', 'Sell and gate', 'The ticket window’s limits, quick sale, partner passes, and the gate. Only owners and managers see this page.', () => import('./settings-apps.js')],
  ['shop', 'apps', 'Online shop', 'Whether guests can buy online, date changes, limits and prices by day, and how the shop page looks.', () => import('./settings-apps.js')],
  ['school', 'apps', 'Ski school', 'Online lesson booking, cancellations and refunds, and the levels you teach. Only owners, managers and the ski school Director see this page.', () => import('./settings-apps.js')],
  ['programs', 'apps', 'Programs', 'How families register for programs.', () => import('./settings-apps.js')],
  ['rentals', 'apps', 'Rentals', 'How the rental counter works: fees, deposits and the binding chart.', () => import('./settings-apps.js')],
  ['attractions', 'apps', 'Attractions', 'Ziplines, a coaster, tubing, the rink and more: limits, waivers and each one’s daily opening checks.', () => import('./settings-apps.js')],
  ['waivers', 'apps', 'Waivers', 'The waiver wording guests sign, with every earlier version kept.', () => import('./settings-apps.js')],
  ['patrol', 'apps', 'Patrol', 'Patrol settings, what a report must hold, and who can do what.', () => import('./settings-apps.js')],
  ['workforce', 'apps', 'Staff and schedule', 'Positions, certifications and the time clock.', () => import('./settings-apps.js')],
  ['messages', 'apps', 'Messages', 'How email and text messages are sent.', () => import('./settings-apps.js')],
];
export const PAGE_KEYS = PAGES.map((p) => p[0]);

// The app each Apps page opens, and the module that must be on for the page to show.
export const APP_OF = { sell: ['sell', 'Sell', ['sell', 'gate']], shop: ['shop', 'Online shop', ['shop']], school: ['school', 'Ski school', ['school']], programs: ['programs', 'Programs', ['programs']],
  rentals: ['rentals', 'Rentals', ['rentals']], attractions: ['conditions', 'Mountain status', ['conditions']], waivers: ['waivers', 'Waivers', null], patrol: ['patrol', 'Patrol', ['patrol']], workforce: ['workforce', 'Staff and schedule', ['workforce']], messages: ['messages', 'Messages', ['messages']] };

const moduleOn = (keys) => !keys || !ctx.me.modules || keys.some((k) => ctx.me.modules.includes(k));

/** The person's patrol access level (admin, manager, ...), or null when they are not on the patrol. */
async function patrolLevel() {
  if (!moduleOn(['patrol']) || !(ctx.me.role === 'patrol' || ctx.me.on_patrol)) return null;
  try { const m = await get('/patrol/me'); return { level: m.access_level, features: m.features || [] }; } catch (_) { return null; }
}

/** Which pages this person sees, in list order. who: { manager, patrolAdmin }. */
async function visiblePages(who) {
  const apps = await import('./settings-apps.js');
  const out = [];
  for (const p of PAGES) {
    const [key, group] = p;
    if (group === 'you') { out.push(p); continue; }
    if (ctx.me.role === 'area') continue;
    if (group === 'mountain') { if (who.manager) out.push(p); continue; }
    if (!moduleOn(APP_OF[key][2])) continue;
    if (key === 'patrol' ? !(who.manager || who.patrol) : key === 'school' ? !(who.manager || who.schoolDirector) : !who.manager) continue; // school: a ski school director too (2026.11.9) // patrol: the cards decide, by permission
    if (await apps.pageHasSetup(key, who)) out.push(p);
  }
  return out;
}

// Leaving Settings gives the app its menu back.
let watching = false;
function enterArea() {
  document.documentElement.classList.add('in-settings');
  if (watching) return;
  watching = true;
  window.addEventListener('hashchange', () => { if (!/^#\/settings(\/|\?|$)/.test(location.hash)) document.documentElement.classList.remove('in-settings'); });
}

/** A link inside Settings that asks first when the page has changes not saved yet. */
function guarded(a) {
  a.addEventListener('click', (e) => {
    if (!hasUnsaved() || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    confirmDialog('Leave without saving?', 'This page has changes that are not saved yet. Leave and lose them, or stay and press Save changes.', 'Leave without saving', async () => { location.hash = a.getAttribute('href'); });
  });
  return a;
}

export async function render(root, params = []) {
  enterArea();
  const asked = params[0] || null;
  const manager = isManager();
  const pl = manager ? null : await patrolLevel();
  const who = { manager, schoolDirector: !manager && schoolCan('director'), patrolAdmin: Boolean(pl && (pl.level === 'admin' || pl.features.includes('manage_settings'))), patrol: pl };
  const pages = await visiblePages(who);
  const page = pages.find((p) => p[0] === asked) || pages[0];
  const home = !asked || !pages.some((p) => p[0] === asked);
  if (asked && home) history.replaceState(history.state, '', '#/settings'); // a page this person cannot use: the list instead

  const phone = Boolean(window.matchMedia && window.matchMedia('(max-width: 860px)').matches);
  // ---- the list
  const back = guarded(h('a', { class: 'set-backapp', href: ctx.me.menu && ctx.me.menu.start ? `#/${ctx.me.menu.start}` : '#/' }, h('span', { 'aria-hidden': 'true' }, '‹'), 'Back to the app'));
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Settings' }, back, h('p', { class: 'set-nav-title', role: 'heading', 'aria-level': '2' }, 'Settings'),
    Object.entries(GROUPS).map(([g, name]) => {
      const mine = pages.filter((p) => p[1] === g);
      if (!mine.length) return null;
      return h('div', { class: 'set-group' }, h('p', { class: 'set-group-name' }, name),
        h('ul', null, mine.map(([key, , text]) => h('li', null, guarded(h('a', { href: `#/settings/${key}`, class: 'set-link', dataset: { page: key }, 'aria-current': key === page[0] && !(home && phone) ? 'page' : null }, text))))));
    }));

  // ---- the page
  const content = h('div', { class: 'set-main' });
  const area = h('div', { class: `set-area${home ? ' is-home' : ''}` }, nav, content);
  root.append(area);
  if (home && phone) { document.title = `Settings · ${ctx.me.tenant_name}`; return; } // the list is the page
  await renderPage(content, page, who);
}

async function renderPage(content, [key, group, title, line, load], who) {
  const app = APP_OF[key];
  const head = h('header', { class: 'page-head set-head' },
    h('div', { class: 'set-head-text' },
      h('a', { class: 'set-back', href: '#/settings' }, h('span', { 'aria-hidden': 'true' }, '‹ '), 'Settings'),
      h('nav', { class: 'set-crumbs', 'aria-label': 'Breadcrumb' }, h('ol', null, h('li', null, h('a', { href: '#/settings' }, 'Settings')), h('li', null, GROUPS[group]))),
      h('h1', null, title),
      h('p', { class: 'set-line' }, line)),
    app ? h('a', { class: 'set-open', href: `#/${app[0]}` }, `Open ${app[1]}`) : null);
  const body = h('div', { class: 'set-body' }, loading());
  clear(content).append(head, body);
  document.title = `${title} · Settings · ${ctx.me.tenant_name}`;
  try {
    const mod = await load();
    const holder = h('div', { class: 'set-body' });
    await mod.renderSettingsPage(holder, key, who);
    body.replaceWith(holder);
  } catch (err) {
    clear(body).append(errorBox(err));
  }
}
