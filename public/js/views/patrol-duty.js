// Patrol > Now > On duty: sign in when you reach the patrol room and out when you leave. Dispatch, the sweep, Today's
// posts and days patrolled all use this list. A shared tablet in the patrol room can run the big-button screen, where
// anyone taps their name. Also here: my phone alerts, and my days this season against the patrol's minimum.
import { get, post, patch } from '../api.js';
import { h, clear, select, input, field, button, toast, formDialog, empty, errorBox, state, fmtTime, label, act } from '../ui.js';
import { hrs } from './workforce-common.js';
import * as alerts from '../alerts.js';

const since = (t) => fmtTime(String(t).replace(' ', 'T'));

export async function drawDuty(box) {
  const body = h('div', { class: 'stack' });
  clear(box).append(body);
  async function load() {
    try {
      const [d, c] = await Promise.all([get('/patrol/duty'), get('/patrol/commitment').catch(() => null)]);
      await draw(d, c);
    } catch (err) { clear(body).append(errorBox(err)); }
  }

  async function draw(d, c) {
    const parts = [];
    // ---- me
    if (d.me && d.me.on_roster) {
      const mine = d.me.entry;
      const station = select([['', 'No station'], ...d.stations.map((s) => [s.id, s.name])], mine && mine.station_id ? mine.station_id : '', { 'aria-label': 'Station' });
      const radio = input({ maxlength: 30, value: mine && mine.radio ? mine.radio : '', placeholder: 'Radio number', 'aria-label': 'Radio' });
      const paid = d.roster.find((r) => r.staff_id === d.me.staff_id);
      const clock = paid && paid.paid ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true }), ' Also clock in for pay') : null;
      parts.push(h('section', { class: `panel duty-me${mine ? ' is-on' : ''}` },
        h('div', { class: 'spread' },
          h('div', null, h('h2', null, mine ? 'You are on duty' : 'You are not signed in'),
            h('p', { class: 'muted' }, mine ? `Since ${since(mine.signed_in_at)}${mine.station ? ` at ${mine.station}` : ''}${mine.radio ? `, radio ${mine.radio}` : ''}. Dispatch can send you to calls.` : 'Sign in when you reach the patrol room, so dispatch and the sweep know you are on the hill.')),
          mine
            ? button('Sign out', (e) => act(e.currentTarget, async () => { await post('/patrol/duty/sign-out', { clock_out: Boolean(paid && paid.paid) }); toast('Signed out'); await load(); })(e), { kind: 'danger' })
            : null),
        mine
          ? h('div', { class: 'row' }, station, radio, button('Update', async () => { await patch(`/patrol/duty/${d.me.staff_id}`, { station_id: station.value ? Number(station.value) : null, radio: radio.value.trim() || null }); toast('Updated'); await load(); }, { small: true }))
          : h('div', { class: 'row' }, station, radio, clock,
            button('Sign in', (e) => act(e.currentTarget, async () => {
              await post('/patrol/duty/sign-in', { station_id: station.value ? Number(station.value) : null, radio: radio.value.trim() || null, clock_in: Boolean(clock && clock.querySelector('input').checked) });
              toast('Signed in'); await load();
            })(e), { kind: 'primary' }))));
    }
    // ---- my season
    if (c && c.me && c.me.target) {
      const pct = Math.min(100, Math.round((c.me.days / c.me.target) * 100));
      parts.push(h('section', { class: 'panel' }, h('div', { class: 'spread' }, h('h3', null, `Your days this season: ${c.me.days} of ${c.me.target}`), state(c.me.short ? `${c.me.short} to go` : 'Done', c.me.short ? 'warn' : 'good')),
        h('div', { class: 'meter-bar', role: 'img', 'aria-label': `${pct}% of the days the patrol asks for` }, h('span', { style: `width:${pct}%` })),
        h('p', { class: 'muted small' }, c.self_signup ? 'Open shifts you can take are on Team, Cover.' : 'Ask whoever builds the schedule for more shifts, or take a cover request on Team, Cover.')));
    }
    // ---- alerts
    parts.push(await alertsPanel());
    // ---- who is on
    parts.push(h('section', { class: 'panel stack' },
      h('div', { class: 'spread' }, h('h2', null, `On duty now (${d.on_duty.length})`), d.can_sign_others ? button('Patrol-room screen', () => { location.hash = '#/patrol/room'; }, { small: true }) : null),
      d.on_duty.length ? h('ul', { class: 'duty-list' }, d.on_duty.map((e) => h('li', null,
        h('b', null, e.name), e.callsign ? h('span', { class: 'muted' }, ` ${e.callsign}`) : null,
        h('span', { class: 'muted' }, ` since ${since(e.signed_in_at)}${e.station ? `, ${e.station}` : ''}${e.radio ? `, radio ${e.radio}` : ''}`),
        d.can_sign_others && e.staff_id !== d.me?.staff_id ? button('Sign out', async () => { await post('/patrol/duty/sign-out', { staff_id: e.staff_id }); toast(`${e.name} signed out`); await load(); }, { small: true, kind: 'ghost' }) : null)))
        : empty('Nobody is signed in yet.'),
      d.scheduled_not_in.length ? h('div', null, h('h3', null, 'Scheduled today, not signed in'), h('ul', { class: 'duty-list' }, d.scheduled_not_in.map((s) => h('li', null, h('b', null, s.name || 'Someone'), h('span', { class: 'muted' }, ` ${fmtTime(String(s.starts_at).replace(' ', 'T'))} to ${fmtTime(String(s.ends_at).replace(' ', 'T'))}${s.station ? `, ${s.station}` : ''}`),
        d.can_sign_others ? button('Sign in', async () => { await post('/patrol/duty/sign-in', { staff_id: s.staff_id, source: 'room' }); toast('Signed in'); await load(); }, { small: true }) : null)))) : null,
      d.signed_out.length ? h('details', null, h('summary', null, `Signed out today (${d.signed_out.length})`), h('ul', { class: 'duty-list' }, d.signed_out.map((e) => h('li', null, h('b', null, e.name), h('span', { class: 'muted' }, ` ${since(e.signed_in_at)} to ${since(e.signed_out_at)}${Number(e.auto_closed) ? ' (closed automatically)' : ''}`))))) : null));
    // ---- the whole patrol's days (leaders)
    if (c && c.data.length > 1 && c.data.some((x) => x.target)) {
      parts.push(h('details', { class: 'panel' }, h('summary', null, h('b', null, 'Volunteer days this season')),
        h('ul', { class: 'duty-list' }, c.data.filter((x) => x.target).map((x) => h('li', null, h('b', null, x.name), ` ${x.days} of ${x.target}`, x.short ? state(`${x.short} short`, 'warn') : state('Done', 'good'), h('span', { class: 'muted' }, ` ${hrs(x.minutes)}`))))));
    }
    clear(body).append(...parts);
  }
  await load();
}

async function alertsPanel() {
  const box = h('section', { class: 'panel' });
  async function draw() {
    let s = 'unsupported';
    try { s = await alerts.status(); } catch (_) { /* treat as unsupported */ }
    const text = {
      on: 'This phone gets an alert when dispatch sends you to a call, when your sweep route is late, and when a cover request needs you.',
      off: 'Get an alert on this phone when dispatch sends you to a call. Each phone you use needs turning on.',
      blocked: 'Alerts are blocked for Verdynt/OS in this browser. Allow notifications in the site settings, then come back.',
      unsupported: alerts.isIos() && !alerts.standalone() ? 'On an iPhone: tap Share, then Add to Home Screen, and open Verdynt/OS from your Home Screen. Then turn alerts on here.' : 'This browser cannot show alerts. Use Chrome, Edge, Firefox or Safari.',
    }[s];
    clear(box).append(h('div', { class: 'spread' }, h('div', null, h('h3', null, 'Phone alerts'), h('p', { class: 'muted small' }, text)),
      h('div', { class: 'row' },
        s === 'off' || (s === 'unsupported' && alerts.isIos()) ? button('Turn on alerts', (e) => act(e.currentTarget, async () => { await alerts.turnOn(); toast('Alerts are on'); await draw(); })(e), { kind: 'primary', small: true }) : null,
        s === 'on' ? button('Send a test', async () => { const r = await alerts.test(); toast(r.sent ? 'Test sent' : 'No phone answered. Try turning alerts off and on.'); }, { small: true }) : null,
        s === 'on' ? button('Turn off', async () => { await alerts.turnOff(); toast('Alerts are off on this phone'); await draw(); }, { small: true, kind: 'ghost' }) : null)));
  }
  await draw();
  return box;
}

/** The patrol-room screen: big name buttons, tap to sign in or out. Runs on a shared tablet signed in by a leader. */
export async function renderRoom(root) {
  const body = h('div', { class: 'room' });
  clear(root).append(h('div', { class: 'room-head' }, h('h1', null, 'Patrol room'), h('p', null, 'Tap your name to sign in or out.'), h('a', { class: 'btn small', href: '#/patrol/duty' }, 'Done')), body);
  let timer = null;
  const tick = () => { if (!body.isConnected) { clearInterval(timer); return; } load(); };
  async function load() {
    try {
      const d = await get('/patrol/duty');
      clear(body).append(h('div', { class: 'room-grid' }, d.roster.map((r) => h('button', {
        type: 'button', class: `room-tile${r.on_duty ? ' is-on' : ''}`, 'aria-pressed': String(r.on_duty),
        onclick: () => (r.on_duty ? signOut(r) : signIn(r, d.stations)),
      }, h('b', null, r.name), h('span', null, r.on_duty ? 'On duty' : label(r.level))))));
    } catch (err) { clear(body).append(errorBox(err)); }
  }
  async function signOut(r) {
    await post('/patrol/duty/sign-out', { staff_id: r.staff_id, clock_out: r.paid });
    toast(`${r.name} signed out`); await load();
  }
  function signIn(r, stations) {
    const station = select([['', 'No station'], ...stations.map((s) => [s.id, s.name])], '', { name: 'station' });
    formDialog(`Sign in: ${r.name}`, h('div', { class: 'form' }, field('Station', station), field('Radio', input({ name: 'radio', maxlength: 30 })),
      r.paid ? h('label', { class: 'check wide' }, h('input', { type: 'checkbox', name: 'clock', checked: true }), ' Also clock in for pay') : null), async (fd) => {
      await post('/patrol/duty/sign-in', { staff_id: r.staff_id, source: 'room', station_id: fd.get('station') ? Number(fd.get('station')) : null, radio: String(fd.get('radio') || '').trim() || null, clock_in: Boolean(fd.get('clock')) });
      toast(`${r.name} signed in`); await load();
    }, { submitText: 'Sign in' });
  }
  await load();
  timer = setInterval(tick, 30000);
  if (timer && timer.unref) timer.unref();
}
