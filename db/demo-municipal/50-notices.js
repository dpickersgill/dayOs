'use strict';

// The demo borough's street alerts (run by db/demo-municipal.js after 00-base.js): 300 made-up residents signed up across
// Riverbend's streets (phones in the 555-01xx range, emails at example.com), three past notices with their follow-ups,
// and one water outage out now on two streets. Nothing is texted or emailed: the sends are written as already sent.
// Safe to run again: sign-ups are counted by their demo note, notices are found by title.
const { upsertResident } = require('../../src/lib/residents');
const SN = require('../../src/lib/streetnotices');
const quiet = require('../../src/lib/quiet');

const NOTE = 'Demo sign-up (made up)';
const FIRST = ['Alex', 'Jamie', 'Morgan', 'Casey', 'Riley', 'Taylor', 'Jordan', 'Avery', 'Quinn', 'Drew', 'Reese', 'Skyler', 'Parker', 'Rowan', 'Emerson', 'Hayden', 'Kendall', 'Logan', 'Peyton', 'Sawyer'];
const LAST = ['Ashby', 'Brennan', 'Carver', 'Delaney', 'Easton', 'Fairley', 'Garnett', 'Holloway', 'Ingram', 'Jessup', 'Kimball', 'Lockhart', 'Mercer', 'Norwood', 'Oakley', 'Pruitt', 'Quimby', 'Radford', 'Sutter', 'Tolliver'];
const AREA_CODES = ['610', '484', '267'];
const TOPIC_SETS = ['water', 'water,streets', 'water,streets,trash', 'water,streets,trash,leaves', 'water,streets,trash,leaves,news', 'water,trash,leaves', 'water,news'];

// [title, type, days ago, hour, areas [[street, from, to, side]], sms, follow-ups [[kind, hours later, text]], ends after hours or null]
const NOTICES = [
  ['Paving on Main Street', 'paving', 20, 10, [['Main Street', null, null, 'both']], 'Paving on Main Street from Tuesday 7 AM. Please move cars off the street by 7 AM. Parking is back by Thursday evening.',
    [['update', 24, 'Rain moved Main Street paving to Wednesday. Please keep cars off the street by 7 AM Wednesday.'], ['ended', 60, 'Paving on Main Street is done. Thank you for moving your cars.']]],
  ['Water main break on Mill Street', 'water_outage', 12, 6, [['Mill Street', 100, 399, 'both']], 'Water is off on Mill Street 100 to 399 for a water main repair. We expect it back by 2 PM.',
    [['update', 3, 'Crews found the break on Mill Street and are replacing a section of pipe. Still expected back by 2 PM.'], ['ended', 8, 'Water is back on along Mill Street. Run the cold tap for a few minutes until it runs clear.']]],
  ['Leaf collection on the avenues', 'leaf_collection', 5, 9, [['First Avenue', null, null, 'both'], ['Second Avenue', null, null, 'both'], ['Third Avenue', null, null, 'both']], 'Leaf collection on First, Second and Third Avenue starts Monday. Rake leaves to the curb, not into the street.',
    [['ended', 120, 'Leaf collection on the avenues is done for this round. The next round starts in two weeks.']]],
];
const ACTIVE = ['Water main break on Water Street', 'water_outage', [['Water Street', 100, 298, 'even'], ['Canal Street', null, null, 'both']],
  'Water is off on Water Street 100 to 298 (even side) and on Canal Street for a water main repair. We expect it back by 6 PM.',
  'Water service is off on Water Street 100 to 298 (even side) and on Canal Street while crews repair a water main. We expect it back by 6 PM.\n\nKeep some bottled water on hand. When the water comes back, run the cold tap for a few minutes until it runs clear.',
  [['update', 1, 'Crews are on site on Water Street. Still expected back by 6 PM.']]];

/** A small repeatable sequence, so a demo built twice looks the same. */
function seq(seed) { let x = seed; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; }

module.exports = async function notices(conn, tenantId, helpers) {
  const streets = await helpers.ids('streets');
  const users = await helpers.userIds();
  const managerId = users.get('manager') || null;
  const utc = (local) => quiet.utcOf(helpers.timezone, local);

  // One crew member holds the water operator certification, so a boil water advisory can name who issued it.
  const operatorId = users.get('crew1') || null;
  if (operatorId) {
    await conn.query(`INSERT INTO street_notice_settings (tenant_id, certified_operators) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE certified_operators = COALESCE(certified_operators, VALUES(certified_operators))`, [tenantId, String(operatorId)]);
  }

  // ---------------------------------------------------------------- 300 sign-ups
  const [[have]] = await conn.query('SELECT COUNT(*) AS n FROM alert_signups WHERE tenant_id = ? AND consent_note = ?', [tenantId, NOTE]);
  if (Number(have.n) < 300) {
    const rnd = seq(4242);
    const names = [...streets.keys()];
    let made = 0;
    for (let i = Number(have.n); i < 300; i += 1) {
      const street = names[Math.floor(rnd() * names.length)];
      const house = String(100 + Math.floor(rnd() * 400));
      const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`;
      const phone = i % 5 === 4 ? null : `+1${AREA_CODES[Math.floor(i / 100) % 3]}55501${String(i % 100).padStart(2, '0')}`;
      const email = i % 3 === 0 || !phone ? `${name.toLowerCase().replace(/\s+/g, '.')}.${i}@example.com` : null;
      const topics = TOPIC_SETS[i % TOPIC_SETS.length];
      const residentId = await upsertResident(conn, tenantId, { name, phone, email, streetId: streets.get(street), houseNumber: house, unit: i % 17 === 0 ? 'Apt 2' : null, textsOk: phone ? true : undefined, emailsOk: email ? true : undefined }, { source: 'street_notices' });
      for (const [channel, v] of [['sms', phone], ['email', email]]) {
        if (!v) continue;
        const a = await SN.addressRow(conn, tenantId, channel, v);
        if (!a.confirmed_at) {
          await conn.query("UPDATE alert_addresses SET confirmed_at = UTC_TIMESTAMP() - INTERVAL ? DAY, confirmed_by = 'import' WHERE tenant_id = ? AND id = ?", [30 + (i % 60), tenantId, a.id]);
          await SN.recordAnswer(conn, tenantId, a.id, 'opted_in', 'import', managerId);
        }
      }
      // A few signed up in the last week, so Today has a card.
      const daysAgo = i % 40 === 0 ? i % 6 : 30 + (i % 90);
      await conn.query(`INSERT INTO alert_signups (tenant_id, resident_id, name, street_id, house_number, house_no, unit, phone, email, topics, by_text, by_email, status, source, consent_note, created_by, created_at, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'import', ?, ?, UTC_TIMESTAMP() - INTERVAL ? DAY, UTC_TIMESTAMP() - INTERVAL ? DAY)`,
      [tenantId, residentId, name, streets.get(street), house, Number(house), i % 17 === 0 ? 'Apt 2' : null, phone, email, topics, phone ? 1 : 0, email ? 1 : 0, NOTE, managerId, daysAgo, daysAgo]);
      made += 1;
    }
    // Two residents replied STOP at some point: they stay on the list, and are skipped.
    for (const k of ['6105550107', '4845550133']) {
      const [[a]] = await conn.query("SELECT id, stopped_at FROM alert_addresses WHERE tenant_id = ? AND channel = 'sms' AND addr = ?", [tenantId, k]);
      if (a && !a.stopped_at) await SN.stopAddress(conn, tenantId, 'sms', k, 'text_reply');
    }
    helpers.log(`${made} alert sign-ups`);
  }

  // ---------------------------------------------------------------- notices, written as already sent
  const code = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  async function addNotice({ title, type, areas, sms, body, sentLocal, followups, endedLocal }) {
    const [[found]] = await conn.query('SELECT id FROM street_notices WHERE tenant_id = ? AND title = ?', [tenantId, title]);
    if (found) return false;
    const missing = areas.filter(([s]) => !streets.get(s));
    if (missing.length) { helpers.log(`skipped "${title}": no ${missing.map((m) => m[0]).join(', ')} on the street list`); return false; }
    const sentAt = utc(sentLocal);
    const [n] = await conn.query(`INSERT INTO street_notices (tenant_id, code, type, title, sms_text, body, starts_at, status, created_by, created_at, sent_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [tenantId, code(), type, title, sms, body || null, sentLocal, endedLocal ? 'ended' : 'active', managerId, sentAt, sentAt, endedLocal ? utc(endedLocal) : null]);
    const areaRows = areas.map(([s, from, to, side]) => ({ street_id: streets.get(s), from_no: from, to_no: to, side }));
    for (const a of areaRows) await conn.query('INSERT INTO street_notice_areas (tenant_id, notice_id, street_id, from_no, to_no, side) VALUES (?, ?, ?, ?, ?, ?)', [tenantId, n.insertId, a.street_id, a.from_no, a.to_no, a.side]);
    const aud = await SN.audienceOf(tenantId, type, areaRows);
    const sends = [['first', sentLocal, sms, body], ...followups];
    for (const [kind, local, text, long] of sends) {
      const at = utc(local);
      const [u] = await conn.query("INSERT INTO street_notice_updates (tenant_id, notice_id, kind, sms_text, body, status, send_at, created_by, created_at, queued_at) VALUES (?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)",
        [tenantId, n.insertId, kind, text, long || null, at, managerId, at, at]);
      const rows = [...aud.send.map((x, i) => [x, i % 97 === 5 ? 'failed' : 'sent']), ...aud.opted_out.map((x) => [x, 'opted_out'])];
      for (const [x, st] of rows) {
        await conn.query('INSERT IGNORE INTO street_notice_deliveries (tenant_id, notice_id, update_id, resident_id, channel, to_addr, status, error, send_after, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [tenantId, n.insertId, u.insertId, x.resident_id, x.channel, x.to, st, st === 'failed' ? 'Twilio said the number is not a mobile phone' : st === 'opted_out' ? 'Said no to these messages' : null, at, at]);
      }
    }
    return true;
  }
  const at = (daysAgo, hour, plusHours = 0) => {
    const d = new Date(Date.parse(`${helpers.daysAgo(daysAgo, hour).replace(' ', 'T')}Z`) + plusHours * 3600000);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  let added = 0;
  for (const [title, type, days, hour, areas, sms, follow] of NOTICES) {
    const followups = follow.map(([kind, h, text]) => [kind, at(days, hour, h), text]);
    const end = follow.find((f) => f[0] === 'ended');
    if (await addNotice({ title, type, areas, sms, sentLocal: at(days, hour), followups, endedLocal: end ? at(days, hour, end[1]) : null })) added += 1;
  }
  // Out now: sent two hours ago, one update since.
  const nowLocal = require('../../src/lib/util').nowIn(helpers.timezone);
  const [title, type, areas, sms, body, follow] = ACTIVE;
  const sentLocal = utcBack(nowLocal, 2);
  if (await addNotice({ title, type, areas, sms, body, sentLocal, followups: follow.map(([kind, h, text]) => [kind, utcBack(sentLocal, -h), text]), endedLocal: null })) added += 1;
  helpers.log(`${added} street notices`);

  /** A local time moved by hours (negative moves later). */
  function utcBack(local, hours) { return new Date(Date.parse(`${local.replace(' ', 'T')}Z`) - hours * 3600000).toISOString().slice(0, 19).replace('T', ' '); }
};
