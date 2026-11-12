// Settings, Apps and add-ons (release 2026.11.20): what is on for the municipality, what each add-on costs, and Add or
// Remove for the owner. Adding or removing goes through the plan on Billing and plan (POST /billing/apps, which uses the
// same plan choice), so with a subscription Stripe charges or credits the difference and the apps follow what is paid
// for. During the free trial, or with no charge, the app turns on or off straight away and the choice is kept for when
// you pay. Managers see the page; only the owner changes it.
import { get, post } from '../api.js';
import { h, clear, money, state, button, toast, confirmDialog, errorBox, loading } from '../ui.js';
import { card } from './settings-kit.js';

export async function renderSettingsPage(root) {
  const box = h('div', { class: 'stack' }, loading('Loading your apps'));
  root.append(box);
  let d;
  async function load() { try { d = await get('/billing/apps'); draw(); } catch (err) { clear(box).append(errorBox(err)); } }

  const price = (a) => {
    const cents = d.interval === 'year' ? a.yearly_cents : a.monthly_cents;
    return cents ? `${money(cents)} a ${d.interval === 'year' ? 'year' : 'month'}` : 'Included';
  };

  function change(a, on) {
    const what = on ? `Add ${a.label}?` : `Remove ${a.label}?`;
    const words = on
      ? (d.live ? `${price(a)} is added to your subscription. Stripe charges the difference for the rest of this period, and ${a.label} turns on straight away.` : d.comped ? `${a.label} turns on straight away, at no charge.` : `${a.label} turns on straight away. ${price(a)} is added to your plan for when you pay.`)
      : (d.live ? `${a.label} turns off and comes off your subscription. Stripe credits the rest of this period. Its records are kept and come back if you add it again.` : `${a.label} turns off. Its records are kept and come back if you add it again.`);
    confirmDialog(what, words, on ? 'Add it' : 'Remove it', async () => {
      d = await post('/billing/apps', { module: a.key, on });
      toast(on ? `${a.label} added` : `${a.label} removed`);
      draw();
      // The menu changes with the apps: reload the person's context the way Settings does after a change.
      setTimeout(() => { location.reload(); }, 900);
    }, { danger: !on });
  }

  function draw() {
    const core = d.apps.filter((a) => !a.addon);
    const addons = d.apps.filter((a) => a.addon);
    clear(box).append(
      card('Your plan', [
        h('p', { class: 'set-card-intro' }, d.plan ? `${d.plan.name}. These come with it:` : 'These come with every plan:'),
        h('ul', { class: 'apps-list' }, core.map((a) => h('li', { dataset: { app: a.key } }, h('span', { class: 'app-text' }, h('b', null, a.label), h('span', { class: 'muted small' }, ` ${a.blurb}`)),
          h('span', { class: 'app-side' }, state(a.on ? 'On' : 'Off', a.on ? 'good' : 'neutral'))))),
      ], { id: 'apps-core' }),
      card('Add-ons', [
        h('p', { class: 'set-card-intro' }, d.can_change ? 'Add the apps your departments need. Prices are per municipality, ' + (d.interval === 'year' ? 'billed yearly.' : 'billed monthly.') : 'Only the owner adds or removes an add-on. Ask them if you need one.'),
        addons.length ? h('ul', { class: 'apps-list' }, addons.map((a) => h('li', { dataset: { app: a.key } },
          h('span', { class: 'app-text' }, h('b', null, a.label), h('span', { class: 'muted small' }, ` ${a.blurb}`)),
          h('span', { class: 'app-side' }, h('span', { class: 'muted' }, a.priced ? price(a) : 'Ask Verdynt/OS'), state(a.on ? 'On' : 'Off', a.on ? 'good' : 'neutral'),
            d.can_change && a.priced ? (a.on ? button('Remove', () => change(a, false), { small: true, label: `Remove ${a.label}` }) : button('Add', () => change(a, true), { small: true, kind: 'primary', label: `Add ${a.label}` })) : null)))) : h('p', { class: 'muted' }, 'No add-ons are offered yet.'),
        h('p', { class: 'set-card-intro muted small apps-foot' }, 'Your plan, billing period and invoices are on ', h('a', { href: '#/settings/billing' }, 'Billing and plan'), '.'),
      ], { id: 'apps-addons' }));
  }
  await load();
}
