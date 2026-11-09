// Settings, Morning brief: your own brief (on or off, by email, phone alert or both) and, for owners and managers, who
// at the mountain gets one. The brief comes at 6:00 AM mountain time on days the calendar says the mountain is open.
import { get, put } from '../api.js';
import { h, clear, isManager, select, toast, fail, errorBox, empty } from '../ui.js';
import { card, row, toggle, infoRow } from './settings-kit.js';
import * as alerts from '../alerts.js';

const KIND = { ops: 'Operations brief', patrol: 'Patrol brief', school: 'Ski school brief' };
const ROLE = { owner: 'Owner', manager: 'Manager', patrol: 'Patrol', instructor: 'Ski school' };
const CHANNEL = [['both', 'Email and phone alert'], ['email', 'Email only'], ['push', 'Phone alert only']];

export async function renderSettingsPage(root) {
  let me;
  try { me = await get('/brief/prefs'); } catch (err) { root.append(errorBox(err)); return; }
  if (!me.eligible) { root.append(card('Your brief', [empty('The morning brief goes to owners, managers, the patrol director and the ski school Director. Your role does not get one.')])); return; }
  root.append(mineCard(me));
  if (isManager()) root.append(await peopleCard());
}

function mineCard(me) {
  const on = toggle({ checked: me.on, 'aria-label': 'Get the morning brief' });
  const how = select(CHANNEL, me.channel, { name: 'channel' });
  const phone = h('div');
  const save = async () => {
    try {
      const r = await put('/brief/prefs', { on: on.checked, channel: how.value });
      how.disabled = !r.on;
      toast(r.on ? `Morning brief on: ${CHANNEL.find((c) => c[0] === r.channel)[1].toLowerCase()}` : 'Morning brief off');
      drawPhone();
    } catch (err) { fail(err); }
  };
  on.addEventListener('change', save);
  how.addEventListener('change', save);
  how.disabled = !me.on;
  async function drawPhone() {
    clear(phone);
    if (!on.checked || how.value === 'email') return;
    const st = await alerts.status().catch(() => 'unsupported');
    if (st === 'on') { phone.append(h('span', { class: 'muted small' }, 'Phone alerts are on for this device.')); return; }
    if (st === 'blocked') { phone.append(h('span', { class: 'muted small' }, 'Alerts are blocked in this browser. Allow them in its site settings.')); return; }
    if (st === 'unsupported') { phone.append(h('span', { class: 'muted small' }, alerts.isIos() && !alerts.standalone() ? 'On an iPhone, add Verdynt/OS to your Home Screen and open it from there to get alerts.' : 'This browser cannot show alerts. Open Verdynt/OS on your phone to turn them on there.')); return; }
    const b = h('button', { type: 'button', class: 'btn small' }, 'Turn on alerts on this device');
    b.addEventListener('click', async () => { b.disabled = true; try { await alerts.turnOn('/brief/alerts'); toast('Alerts turned on for this device'); drawPhone(); } catch (err) { fail(err); b.disabled = false; } });
    phone.append(b);
  }
  drawPhone();
  return card('Your brief', [
    row(KIND[me.kind], on, 'A short read at 6:00 AM mountain time on open days, and the day before opening day: the weather, what is booked, and what needs attention.'),
    row('How it comes', how, 'The phone alert shows the summary line and opens the brief. Every brief is also on the Morning brief page for 7 days.'),
    infoRow('Phone alerts on this device', null, phone),
  ]);
}

async function peopleCard() {
  let list;
  try { ({ data: list } = await get('/brief/people')); } catch (err) { return errorBox(err); }
  const rows = list.map((p) => {
    const t = toggle({ checked: p.on, 'aria-label': `Morning brief for ${p.name}` });
    t.addEventListener('change', async () => {
      try { const r = await put(`/brief/people/${p.id}`, { on: t.checked }); toast(r.on ? `${p.name} gets the brief` : `${p.name} no longer gets the brief`); } catch (err) { t.checked = !t.checked; fail(err); }
    });
    const hint = `${ROLE[p.role] || p.role}. ${KIND[p.kind]}${p.has_email ? '' : '. No email address, so phone alerts only'}${p.default_on ? '' : '. Off unless turned on'}.`;
    return row(p.name, t, hint);
  });
  return card('Who gets it', rows.length ? rows : [empty('Nobody here can get a brief yet.')], {
    intro: 'Owners and managers get the operations brief, the patrol director the patrol brief, and the ski school Director the school brief. Turn it on for other patrol leaders or school supervisors here. Each person picks email or phone alerts for themselves.',
  });
}
