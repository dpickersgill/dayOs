// The product website's small amount of behaviour: the app switchboard on Home, live plans and prices on Home and
// Pricing (from the plans set in the console), and the Contact form. Every page reads fine without it.
(function () {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const dollars = (cents) => '$' + Math.round(cents / 100).toLocaleString('en-US');
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sym(i) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('width', '34'); s.setAttribute('height', '34'); s.setAttribute('viewBox', '0 0 34 34'); s.setAttribute('aria-hidden', 'true');
    const shapes = [['circle', { cx: 17, cy: 17, r: 15, fill: '#2C7A57' }], ['rect', { x: 2, y: 2, width: 30, height: 30, rx: 2, fill: '#1B5FC1' }], ['path', { d: 'M17 1 L33 17 L17 33 L1 17 Z', fill: '#12303A' }]];
    const [tag, a] = shapes[Math.min(i, 2)];
    const p = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(a)) p.setAttribute(k, v);
    s.append(p);
    return s;
  }
  const siteBase = () => { const a = $('.sn-brand'); const href = a ? a.getAttribute('href') : '/'; return href.replace(/\/$/, ''); };

  // ---------------------------------------------------------------- Home: turn apps on and off
  const APPS = [
    ['sell', 'Sell', 'Tickets, passes, gift cards, refunds', 'Front desk'],
    ['gate', 'Gate', 'Scan tickets, passes and RFID cards', 'Front desk'],
    ['rentals', 'Rentals', 'Gear and rental contracts', 'Front desk'],
    ['shop', 'Online shop', 'Add-on: guests buy online', 'Front desk'],
    ['conditions', 'Lifts and trails', 'Status, grooming, weather, maintenance', 'Mountain'],
    ['park', 'Terrain park', 'Features and the park map', 'Mountain'],
    ['assets', 'Assets and fleet', 'Add-on: fleet, lifts, snowmaking, buildings', 'Mountain'],
    ['patrol', 'Patrol', 'Care, dispatch, duty, sweep, records', 'Safety'],
    ['school', 'Ski school', 'Lessons, instructors, packages', 'Programs'],
    ['programs', 'Clubs and programs', 'Camps, leagues and sessions', 'Programs'],
    ['availability', 'Instructor availability', 'Open dates and a public page', 'Programs'],
    ['catalog', 'Products and prices', 'Items, promo codes, price rules', 'Office'],
    ['money', 'Money', 'Tax rules, till and exports', 'Office'],
    ['workforce', 'Staff and schedule', 'Shifts, hours, time clock', 'Office'],
    ['messages', 'Messages', 'Add-on: email and texts to guests', 'Office'],
    ['documents', 'Documents', 'Manuals and forms, searchable', 'Office'],
  ];
  function switchboard() {
    const grid = $('#appgrid'); if (!grid) return;
    const off = { rentals: true, park: true, patrol: true, messages: true, assets: true, shop: true };
    let note = 'Rentals, Terrain park, Patrol, the Online shop, Assets and fleet and Messages are off, as a small hill might choose.';
    function flip(key) {
      note = '';
      if (off[key]) {
        delete off[key];
        if ((key === 'sell' || key === 'shop') && off.catalog) { delete off.catalog; note = `${key === 'sell' ? 'Sell' : 'The online shop'} needs Products and prices, so that came on too.`; }
        if (key === 'assets' && off.conditions) { delete off.conditions; note = 'Assets and fleet needs Lifts and trails, so that came on too.'; }
      } else {
        off[key] = true;
        if (key === 'catalog') { const gone = ['sell', 'shop'].filter((k) => !off[k]); gone.forEach((k) => { off[k] = true; }); if (gone.length) note = 'Sell and the online shop need Products and prices, so they went off too.'; }
        if (key === 'conditions' && !off.assets) { off.assets = true; note = 'Assets and fleet needs Lifts and trails, so it went off too.'; }
      }
      draw();
    }
    function draw() {
      grid.replaceChildren(...APPS.map(([key, label, blurb]) => {
        const on = !off[key];
        return el('button', { type: 'button', class: on ? 'app on' : 'app', 'aria-pressed': String(on), onclick: () => flip(key) },
          el('span', { class: 'sw-t', 'aria-hidden': 'true' }), el('span', null, el('b', null, label), el('span', { class: 'bl' }, blurb)));
      }));
      const rows = [el('div', { class: 'prow h' }, 'Always on')];
      for (const l of ['Today', 'Inbox', 'Customers', 'Waivers', 'My shifts', 'Help']) rows.push(el('div', { class: 'prow m' }, el('i', { 'aria-hidden': 'true' }), l));
      for (const g of ['Front desk', 'Mountain', 'Safety', 'Programs', 'Office']) {
        const items = APPS.filter((a) => a[3] === g && !off[a[0]]);
        if (!items.length) continue;
        rows.push(el('div', { class: 'prow h' }, g));
        for (const a of items) rows.push(el('div', { class: 'prow' }, el('i', { 'aria-hidden': 'true' }), a[1]));
      }
      $('#approws').replaceChildren(...rows);
      const n = APPS.filter((a) => !off[a[0]]).length;
      $('#appnote').textContent = `${n} of ${APPS.length} apps on. ${note}`;
    }
    draw();
  }

  // ---------------------------------------------------------------- plans and prices, live from the console
  let plansData = null;
  async function loadPlans() {
    if (plansData) return plansData;
    try {
      const res = await fetch('/api/v1/site/plans', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      plansData = await res.json();
    } catch (_) { plansData = null; }
    return plansData;
  }
  const perMonth = (p, interval) => (interval === 'year' && p.yearly_cents ? p.yearly_cents / 12 : p.monthly_cents);

  async function homePlans() {
    const box = $('#homeplans'); if (!box) return;
    const d = await loadPlans(); if (!d || !d.plans.length) return;
    box.style.setProperty('--n', String(Math.min(d.plans.length, 4)));
    box.replaceChildren(...d.plans.map((p, i) => el('div', { class: `plan${i === 1 ? ' feat' : ''}` },
      el('div', { class: 'sym' }, sym(i), el('h3', null, p.name)), el('p', { class: 'who' }, p.blurb || ''),
      el('div', { class: 'price' }, el('b', null, dollars(p.monthly_cents)), el('span', null, 'per month')))));
    const adds = $('#homeaddons');
    if (adds && d.addons.length) adds.replaceChildren(el('b', null, 'Add when you want them:'), ...d.addons.map((a) => el('span', null, a.name)), el('a', { href: `${siteBase()}/pricing#addons` }, 'See add-on prices'));
  }

  async function pricing() {
    if (!document.querySelector('[data-page="pricing"]')) return;
    const d = await loadPlans();
    let interval = 'month';
    try { if (localStorage.getItem('so.site.interval') === 'year') interval = 'year'; } catch (_) { /* private mode */ }
    const base = siteBase();
    const buttons = [...document.querySelectorAll('.bill button')];
    // How much yearly saves, from the real prices
    if (d && d.plans.length) {
      const saves = d.plans.filter((p) => p.yearly_cents && p.monthly_cents).map((p) => 1 - p.yearly_cents / (p.monthly_cents * 12));
      const best = saves.length ? Math.round(Math.max(...saves) * 100) : 0;
      const tag = $('#yearsave'); if (tag) tag.textContent = best > 0 ? `save ${best}%` : '';
      if (!d.plans.some((p) => p.yearly_cents)) { buttons[1].hidden = true; interval = 'month'; }
    }
    function draw() {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.interval === interval)));
      if (!d || !d.plans.length) return; // the page's own copy stays
      const allApps = [];
      for (const p of d.plans) for (const a of p.apps) if (!allApps.some((x) => x.key === a.key)) allApps.push(a);
      $('#plans').style.setProperty('--n', String(Math.min(d.plans.length, 4)));
      $('#cmpwrap').style.setProperty('--n', String(d.plans.length));
      $('#plans').replaceChildren(...d.plans.map((p, i) => {
        // "Everything in Lodge, plus" only when this plan really holds all of the one before it (Patrol only does not).
        const before = d.plans[i - 1];
        const prev = before && before.apps.every((a) => p.apps.some((x) => x.key === a.key)) ? before : null;
        const added = prev ? p.apps.filter((a) => !prev.apps.some((x) => x.key === a.key)) : p.apps;
        const offered = interval === 'year' ? p.yearly_cents : p.monthly_cents;
        return el('div', { class: `plan${i === 1 ? ' feat' : ''}` },
          el('div', { class: 'sym' }, sym(i), el('h2', null, p.name)),
          el('p', { class: 'who' }, p.blurb || ''),
          el('div', { class: 'price' }, el('b', null, offered ? dollars(perMonth(p, interval)) : 'Ask us'), el('span', null, offered ? 'per month' : '')),
          el('p', { class: 'setup' }, interval === 'year' ? (p.yearly_cents ? `${dollars(p.yearly_cents)} billed once a year` : 'Not offered yearly') : 'Billed monthly'),
          el('ul', null, prev ? el('li', { class: 'plus' }, `Everything in ${prev.name}, plus:`) : null, ...added.map((a) => el('li', null, a.label))),
          el('a', { class: `btn go${i === 1 ? '' : ' ghost'}`, href: `${base}/contact?kind=trial&plan=${encodeURIComponent(p.name)}` }, `Start a ${p.name} trial`));
      }));
      $('#planfine').textContent = `Prices are in US dollars, before any sales tax. ${interval === 'year' ? 'Yearly prices are shown per month and charged once a year.' : 'Every plan starts with a ' + (d.trial_days || 14) + '-day free trial.'}`;
      // Comparison table: plans across, apps down, add-ons after
      const yes = () => el('span', { class: 'y', html: '<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 9.5 L7.5 14 L15 4.5" fill="none" stroke="#2C7A57" stroke-width="2.6"/></svg><span class="vh">Included</span>' });
      const no = () => el('span', { class: 'n', html: '<span aria-hidden="true">&ndash;</span><span class="vh">Not included</span>' });
      const addonFor = (key) => d.addons.find((a) => a.apps.some((x) => x.key === key));
      const extraKeys = d.addons.flatMap((a) => a.apps).filter((a) => !allApps.some((x) => x.key === a.key));
      const rows = allApps.map((a) => el('tr', null, el('th', { scope: 'row' }, a.label), ...d.plans.map((p) => el('td', null, p.apps.some((x) => x.key === a.key) ? yes() : addonFor(a.key) ? el('span', { class: 'ad' }, 'Add-on') : no()))));
      const addRows = extraKeys.map((a) => el('tr', null, el('th', { scope: 'row' }, a.label), ...d.plans.map(() => el('td', null, el('span', { class: 'ad' }, 'Add-on')))));
      $('#cmpwrap').replaceChildren(el('table', { class: 'cmp' },
        el('caption', { class: 'vh' }, 'Apps in each plan'),
        el('thead', null, el('tr', null, el('th', { scope: 'col' }, el('span', { class: 'vh' }, 'App')), ...d.plans.map((p) => el('th', { scope: 'col' }, p.name)))),
        el('tbody', null, ...rows, addRows.length ? el('tr', { class: 'sub' }, el('th', { scope: 'rowgroup', colspan: String(d.plans.length + 1) }, 'Add-ons')) : null, ...addRows,
          el('tr', { class: 'sub' }, el('th', { scope: 'rowgroup', colspan: String(d.plans.length + 1) }, 'With every plan')),
          ...['Today, Inbox, Customers and Waivers', 'Staff logins: as many as you need', 'Billing by card, bank account or invoice', '14-day free trial'].map((t) => el('tr', null, el('th', { scope: 'row' }, t), ...d.plans.map(() => el('td', null, yes())))))));
      // Add-on cards
      $('#addonlist').replaceChildren(...d.addons.map((a) => {
        const inPlans = d.plans.filter((p) => a.apps.length && a.apps.every((x) => p.apps.some((y) => y.key === x.key))).map((p) => p.name);
        const offered = interval === 'year' ? a.yearly_cents : a.monthly_cents;
        return el('div', { class: 'addon' },
          el('div', { class: 'tops' }, el('h3', null, a.name), el('div', { class: 'ap' }, el('b', null, offered ? dollars(perMonth(a, interval)) : (a.monthly_cents ? dollars(a.monthly_cents) : 'Ask us')), el('span', null, offered ? 'per month' : (a.monthly_cents ? 'per month, monthly only' : '')))),
          el('p', null, a.blurb || ''),
          el('p', { class: 'fit' }, a.apps.length ? `Turns on ${a.apps.map((x) => x.label).join(', ')}. ` : '', inPlans.length ? el('b', null, `Included in ${inPlans.join(' and ')}.`) : 'Works with any plan.'));
      }));
    }
    buttons.forEach((b) => b.addEventListener('click', () => { interval = b.dataset.interval; try { localStorage.setItem('so.site.interval', interval); } catch (_) { /* private mode */ } draw(); }));
    if (!d) { $('#cmpwrap').replaceChildren(el('p', { class: 'fine' }, 'Prices could not be loaded just now. Ask us for a quote and we will put it in writing.')); $('#addonlist').replaceChildren(); }
    draw();
  }

  // ---------------------------------------------------------------- Contact
  const LABELS = {
    walkthrough: 'Which part of the day is hardest right now?', trial: 'Anything we should set up for your trial? (lifts, apps you want first)',
    founding: 'Tell us about your mountain and what you would want from Verdynt/OS', question: 'Your question',
    patrol: 'About your patrol: how many patrollers, volunteer or paid, and who at the ski area should get the read-only login',
  };
  function contact() {
    const form = $('#leadform'); if (!form) return;
    const q = new URLSearchParams(location.search);
    const kind = q.get('kind'); if (kind && LABELS[kind]) { const r = form.querySelector(`input[name=kind][value="${kind}"]`); if (r) r.checked = true; }
    const plan = q.get('plan'); if (plan) { const s = $('#f-plan'); if ([...s.options].some((o) => o.value === plan)) s.value = plan; }
    const msgLabel = $('#l-msg');
    const syncKind = () => {
      const k = form.querySelector('input[name=kind]:checked').value;
      msgLabel.firstChild.textContent = `${LABELS[k]} `;
      msgLabel.querySelector('.opt').hidden = k === 'question';
      if (k === 'founding') $('#f-found').checked = true;
      $('#f-send').textContent = { walkthrough: 'Request a walkthrough', trial: 'Ask for my trial', founding: 'Apply for the founding group', question: 'Send my question' }[k];
    };
    form.addEventListener('change', (e) => { if (e.target.name === 'kind') syncKind(); });
    syncKind();
    const status = $('#f-status');
    const show = (text, kind2) => { status.textContent = text; status.className = `status show ${kind2}`; status.focus(); };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = (n) => String(form.elements[n].value || '').trim();
      const checks = [['name', v('name')], ['mountain', v('mountain')], ['email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('email'))]];
      let first = null;
      for (const [n, ok] of checks) { const f = form.elements[n].closest('.fld'); f.classList.toggle('invalid', !ok); form.elements[n].setAttribute('aria-invalid', String(!ok)); form.elements[n].setAttribute('aria-describedby', ok ? '' : `e-${n}`); if (!ok && !first) first = form.elements[n]; }
      const k = form.querySelector('input[name=kind]:checked').value;
      if (k === 'question' && !v('message')) { show('Add your question first.', 'bad'); $('#f-msg').focus(); return; }
      if (first) { first.focus(); return; }
      const btn = $('#f-send'); btn.disabled = true;
      try {
        const res = await fetch('/api/v1/site/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          kind: k, name: v('name'), mountain: v('mountain'), role: v('role'), email: v('email'), phone: v('phone'), lifts: v('lifts'), plan_interest: v('plan_interest'),
          message: v('message'), founding: form.elements.founding.checked, website: v('website') }) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || 'Something went wrong');
        form.querySelectorAll('input:not([type=radio]):not([type=checkbox]), textarea').forEach((i) => { i.value = ''; });
        show(`Sent. ${k === 'trial' ? 'We will reply within one business day to set up your trial mountain.' : 'A person will reply within one business day.'}${out.copy ? ' A copy is on its way to your email.' : ''}`, 'ok');
      } catch (err) {
        show(`${err.message}. Try again in a moment.`, 'bad');
      } finally { btn.disabled = false; }
    });
  }


  // ---------------------------------------------------------------- every page: header, phone menu, phone action bar, folding lists
  function chrome() {
    const head = $('.sn');
    const bar = $('.mcta');
    const onScroll = () => {
      const y = window.scrollY;
      if (head) head.classList.toggle('scrolled', y > 8);
      if (bar) bar.classList.toggle('show', y > Math.min(560, window.innerHeight * 0.7));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    // The phone menu covers the page: the page underneath stops scrolling, Escape or a link closes it.
    const menu = $('.sn-m');
    if (menu) {
      menu.addEventListener('toggle', () => { document.documentElement.style.overflow = menu.open ? 'hidden' : ''; if (head) head.classList.toggle('open', menu.open); if (bar) bar.hidden = menu.open; });
      menu.addEventListener('click', (e) => { if (e.target.closest('a')) menu.open = false; });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
      window.matchMedia('(min-width: 961px)').addEventListener('change', (m) => { if (m.matches) menu.open = false; });
    }
    // Long lists of what an app does fold away on phones, behind "What it does". Open everywhere else.
    const phone = window.matchMedia('(max-width: 640px)');
    const fold = () => document.querySelectorAll('details.more').forEach((d) => { d.open = !phone.matches; });
    phone.addEventListener('change', fold);
    fold();
  }

  // The script is deferred, so the page is already parsed: fold the lists now, before the first paint where possible.
  chrome();
  document.addEventListener('DOMContentLoaded', () => { switchboard(); homePlans(); pricing(); contact(); });
}());
