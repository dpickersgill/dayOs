'use strict';

// The guest rental form and rental groups (rentals round 2, Track FORMS).
//
// A guest fills in each renter's details (height, weight, boot size, ability) and signs that they are true, at home from
// the link on their order, from the QR poster in the shop, or from a group leader's link. The form waits in
// rental_forms until the counter uses it: each person is matched to a customer, their details are saved, a
// rental_signoffs row is written (via 'form', contract_id NULL), and they are put on the order's to_fit contracts or
// on their group.
//
// Links carry a token. Only its hash is stored (orders.rental_form_token_sha, rental_groups.link_token_sha). The token
// is an HMAC of the record's id with the link secret, so the app can print the same link again on a receipt without
// keeping the token itself.
const crypto = require('crypto');
const config = require('../config');
const { one, rows } = require('../db');
const { bad, conflict, notFound } = require('./errors');
const { addDays } = require('./util');

const MAX_PEOPLE = 10;
const MAX_SIGNATURE_CHARS = 90000; // the same limit as public/js/sigpad.js
const ABILITY = { cautious: '1', moderate: '2', aggressive: '3' };
const ABILITY_OF_TYPE = { 1: 'cautious', 2: 'moderate', 3: 'aggressive' };
const ADULT_AGE = 18;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tokenFor = (kind, tenantId, id) => crypto.createHmac('sha256', config.linkSecret).update(`rental-${kind}:${tenantId}:${id}`).digest('base64url').slice(0, 32);
const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32}$/.test(t);

/** The link to an order's rental form. Saves the token's hash on the order the first time. */
async function orderFormLink(conn, tenantId, orderId, base, slug) {
  const token = tokenFor('order', tenantId, orderId);
  await conn.query('UPDATE orders SET rental_form_token_sha = ? WHERE tenant_id = ? AND id = ? AND (rental_form_token_sha IS NULL OR rental_form_token_sha <> ?)', [sha(token), tenantId, orderId, sha(token)]);
  return `${base}/rental-form/${encodeURIComponent(slug)}?t=${token}`;
}

/** The link a group leader sends to parents. */
async function groupLink(conn, tenantId, groupId, base, slug) {
  const token = tokenFor('group', tenantId, groupId);
  await conn.query('UPDATE rental_groups SET link_token_sha = ? WHERE tenant_id = ? AND id = ? AND (link_token_sha IS NULL OR link_token_sha <> ?)', [sha(token), tenantId, groupId, sha(token)]);
  return `${base}/rental-form/${encodeURIComponent(slug)}?g=${token}`;
}

const walkInLink = (base, slug) => `${base}/rental-form/${encodeURIComponent(slug)}`;

/** Does an order have rental lines that are not refunded? Returns how many. */
async function rentalLines(conn, tenantId, orderId) {
  const r = await one(conn, "SELECT COUNT(*) AS n, MIN(valid_on) AS day FROM order_items WHERE tenant_id = ? AND order_id = ? AND line_kind = 'rental' AND refunded_at IS NULL", [tenantId, orderId]);
  return { count: Number(r.n), day: r.day ? String(r.day instanceof Date ? r.day.toISOString() : r.day).slice(0, 10) : null };
}

const ageOn = (dob, day) => {
  if (!dob) return null;
  const d = String(dob).slice(0, 10); const t = String(day).slice(0, 10);
  let a = Number(t.slice(0, 4)) - Number(d.slice(0, 4));
  if (t.slice(5) < d.slice(5)) a -= 1;
  return a;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function isPng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  return Boolean(m) && Buffer.from(m[1].slice(0, 16), 'base64').subarray(0, 8).equals(PNG_MAGIC);
}

/**
 * Checks one person from a public form and returns the clean record kept in rental_forms.people. The details here are
 * also the snapshot written to rental_signoffs.details (without the signature).
 */
function cleanPerson(p, day) {
  const t = (s, n) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
  const out = {
    first_name: t(p.first_name, 100), last_name: t(p.last_name, 100), date_of_birth: p.date_of_birth,
    discipline: p.discipline === 'snowboard' ? 'snowboard' : 'ski',
    height_in: p.height_in == null || p.height_in === '' ? null : Number(p.height_in),
    weight_lb: p.weight_lb == null || p.weight_lb === '' ? null : Number(p.weight_lb),
    boot_size: t(p.boot_size, 10) || null, shoe_size: t(p.shoe_size, 20) || null,
    stance: p.discipline === 'snowboard' && ['regular', 'goofy'].includes(p.stance) ? p.stance : null,
    ability: ABILITY[p.ability] ? p.ability : null, helmet: Boolean(p.helmet),
    signer_name: t(p.signer_name, 120), signer_relation: ['self', 'parent', 'guardian'].includes(p.signer_relation) ? p.signer_relation : 'self',
  };
  const who = `${out.first_name} ${out.last_name}`.trim() || 'each person';
  if (!out.first_name || !out.last_name) throw bad('Enter a first and last name for each person');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.date_of_birth || ''))) throw bad(`Enter the date of birth for ${who}`);
  const age = ageOn(out.date_of_birth, day);
  if (age < 0 || age > 110) throw bad(`Check the date of birth for ${who}`);
  if (!out.height_in || out.height_in < 24 || out.height_in > 96) throw bad(`Enter the height in inches for ${who}`);
  if (!out.weight_lb || out.weight_lb < 20 || out.weight_lb > 450) throw bad(`Enter the weight in pounds for ${who}`);
  if (!out.boot_size && !out.shoe_size) throw bad(`Enter a boot size or a shoe size for ${who}`);
  if (!out.ability) throw bad(`Say how ${who} skis or rides`);
  if (!out.signer_name) throw bad(`Type the name of the person signing for ${who}`);
  if (age < ADULT_AGE && out.signer_relation === 'self') throw bad(`${who} is under ${ADULT_AGE}, so a parent or guardian signs`);
  if (age >= ADULT_AGE && out.signer_relation !== 'self') throw bad(`${who} is ${ADULT_AGE} or over and signs for themselves`);
  if (age >= ADULT_AGE && out.signer_name.toLowerCase() !== `${out.first_name} ${out.last_name}`.toLowerCase()) throw bad(`${who} signs for themselves. Type their own name.`);
  if (!p.agree) throw bad(`Tick the box to confirm the details for ${who} are true`);
  if (String(p.signature || '').length > MAX_SIGNATURE_CHARS) throw bad(`The signature for ${who} is too detailed. Clear it and sign again.`);
  if (!isPng(p.signature)) throw bad(`Please sign for ${who}`);
  out.skier_type = ABILITY[out.ability];
  out.signature = p.signature;
  return out;
}

/** A form's people without their signatures, for lists. */
const withoutSignatures = (people) => people.map(({ signature, ...rest }) => ({ ...rest, signed: Boolean(signature) }));
const parsePeople = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch (_) { return []; } };

/** The details snapshot kept with a signoff. */
const snapshot = (p) => ({
  first_name: p.first_name, last_name: p.last_name, date_of_birth: p.date_of_birth, discipline: p.discipline,
  height_in: p.height_in, weight_lb: p.weight_lb, boot_size: p.boot_size, shoe_size: p.shoe_size, stance: p.stance,
  ability: p.ability, skier_type: p.skier_type, helmet: p.helmet,
});

/** Saves a person's sizing to people and rental_profiles. The details are the renter's own, signed, so they replace what was there. */
async function saveDetails(conn, tenantId, personId, p) {
  await conn.query(
    `UPDATE people SET height_in = COALESCE(?, height_in), weight_lb = COALESCE(?, weight_lb), boot_size = COALESCE(?, boot_size), stance = COALESCE(?, stance),
       skier_type = COALESCE(?, skier_type), discipline = COALESCE(?, discipline), date_of_birth = COALESCE(date_of_birth, ?) WHERE tenant_id = ? AND id = ?`,
    [p.height_in ?? null, p.weight_lb ?? null, p.boot_size ?? null, p.stance ?? null, p.skier_type ?? null, p.discipline ?? null, p.date_of_birth ?? null, tenantId, personId],
  );
  await conn.query(
    `INSERT INTO rental_profiles (tenant_id, person_id, skier_type, shoe_size, stance) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE skier_type = COALESCE(VALUES(skier_type), skier_type), shoe_size = COALESCE(VALUES(shoe_size), shoe_size), stance = COALESCE(VALUES(stance), stance)`,
    [tenantId, personId, p.skier_type ?? null, p.shoe_size ?? null, p.stance ?? null],
  );
}

/** A customer for a person on a list or a form: the one picked, else the same name and date of birth, else a new record. */
async function personFor(conn, tenantId, p, pickedId, source) {
  if (pickedId) {
    const r = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND id = ? AND anonymised_at IS NULL', [tenantId, pickedId]);
    if (!r) throw notFound('Customer');
    return { id: r.id, created: false };
  }
  if (p.date_of_birth) {
    const r = await one(conn, 'SELECT id FROM people WHERE tenant_id = ? AND first_name = ? AND last_name = ? AND date_of_birth = ? AND anonymised_at IS NULL ORDER BY id LIMIT 1', [tenantId, p.first_name, p.last_name, p.date_of_birth]);
    if (r) return { id: r.id, created: false };
  }
  const [x] = await conn.query('INSERT INTO people (tenant_id, first_name, last_name, date_of_birth, source) VALUES (?, ?, ?, ?, ?)', [tenantId, p.first_name, p.last_name, p.date_of_birth || null, source]);
  return { id: x.insertId, created: true };
}

/** Customers who might be this person: same name. The one with the same date of birth comes first. */
async function candidates(conn, tenantId, p) {
  return rows(conn, `SELECT id, first_name, last_name, date_of_birth, phone, email, (date_of_birth = ?) AS dob_match FROM people
    WHERE tenant_id = ? AND anonymised_at IS NULL AND first_name = ? AND last_name = ? ORDER BY dob_match DESC, id DESC LIMIT 5`, [p.date_of_birth || null, tenantId, p.first_name, p.last_name]);
}

/** The shop's closing time on a day, as a local date-time ('YYYY-MM-DD HH:MM:SS'). */
const closingOn = (day, settings) => `${day} ${String(settings.closing_time || '16:30:00').slice(0, 8)}`;

/** A group member is a to_fit contract with the group's id. Returns the contract id (an existing one for that person if there is one). */
async function addMember(conn, tenantId, group, personId, settings) {
  const have = await one(conn, "SELECT id FROM rental_contracts WHERE tenant_id = ? AND group_id = ? AND person_id = ? AND status <> 'cancelled' LIMIT 1", [tenantId, group.id, personId]);
  if (have) return { id: have.id, added: false };
  const day = String(group.rental_on instanceof Date ? group.rental_on.toISOString() : group.rental_on).slice(0, 10);
  const due = closingOn(addDays(day, Math.max(Number(group.days) || 1, 1) - 1), settings);
  const [c] = await conn.query(
    "INSERT INTO rental_contracts (tenant_id, person_id, status, due_at, group_name, group_id, valid_on, kind) VALUES (?, ?, 'to_fit', ?, ?, ?, ?, 'day')",
    [tenantId, personId, due, group.name.slice(0, 120), group.id, day],
  );
  return { id: c.insertId, added: true };
}

/**
 * Uses a waiting form: each person is matched (choices[i].person_id, or name and date of birth, or a new record), their
 * details saved, a signoff written, and they are put on the order's to_fit contracts or on the form's group.
 * Returns { people: [{ index, person_id, created, contract_id }], attached }.
 */
async function useForm(conn, tenantId, form, choices, { orderId, userId, settings }) {
  const people = parsePeople(form.people);
  const out = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const choice = choices.find((c) => c.index === i) || {};
    if (choice.skip) continue;
    const who = await personFor(conn, tenantId, p, choice.person_id, form.order_id ? 'online' : 'window');
    await saveDetails(conn, tenantId, who.id, p);
    // a self signer is the contact: fill their phone and email when the record has none
    if (p.signer_relation === 'self' && `${p.first_name} ${p.last_name}`.toLowerCase() === String(form.contact_name).toLowerCase()) {
      await conn.query('UPDATE people SET phone = COALESCE(phone, ?), email = COALESCE(email, ?) WHERE tenant_id = ? AND id = ?', [form.phone || null, form.email || null, tenantId, who.id]);
    }
    await conn.query(
      "INSERT INTO rental_signoffs (tenant_id, person_id, contract_id, form_id, signer_name, signer_relation, details, signature, via, signed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'form', ?)",
      [tenantId, who.id, form.id, p.signer_name, p.signer_relation, JSON.stringify(snapshot(p)), p.signature, form.created_at],
    );
    out.push({ index: i, person_id: who.id, created: who.created, name: `${p.first_name} ${p.last_name}`, contract_id: null });
  }

  // The order's to_fit contracts: a contract already for the person stays theirs; the rest of the people take the
  // contracts made out to the buyer, in order. A contract for someone else named on the order is left alone.
  const attached = [];
  const oid = orderId || form.order_id;
  if (oid) {
    const order = await one(conn, 'SELECT id, person_id FROM orders WHERE tenant_id = ? AND id = ?', [tenantId, oid]);
    if (!order) throw notFound('Order');
    const open = await rows(conn, "SELECT id, person_id, stage FROM rental_contracts WHERE tenant_id = ? AND order_id = ? AND status = 'to_fit' ORDER BY id FOR UPDATE", [tenantId, oid]);
    const taken = new Set();
    for (const p of out) {
      const mine = open.find((c) => c.person_id === p.person_id && !taken.has(c.id));
      if (mine) { taken.add(mine.id); p.contract_id = mine.id; }
    }
    for (const p of out.filter((x) => !x.contract_id)) {
      const spare = open.find((c) => !taken.has(c.id) && c.person_id === order.person_id);
      if (!spare) continue;
      taken.add(spare.id); p.contract_id = spare.id;
    }
    for (const p of out.filter((x) => x.contract_id)) {
      const c = open.find((x) => x.id === p.contract_id);
      // the form is in, so in a shop with stations the renter moves on to boots
      // (Track FIT reads a NULL stage as 'form' in a shop with stations; a counter shop keeps no stage.)
      const stations = settings && settings.layout === 'stations';
      await conn.query("UPDATE rental_contracts SET person_id = ?, stage = IF(? AND (stage IS NULL OR stage = 'form'), 'boots', IF(stage = 'form', 'boots', stage)) WHERE tenant_id = ? AND id = ?", [p.person_id, stations ? 1 : 0, tenantId, c.id]);
      attached.push({ contract_id: c.id, person_id: p.person_id });
    }
  }
  if (form.group_id) {
    const group = await one(conn, 'SELECT * FROM rental_groups WHERE tenant_id = ? AND id = ?', [tenantId, form.group_id]);
    if (group) for (const p of out) { const m = await addMember(conn, tenantId, group, p.person_id, settings); p.contract_id = m.id; }
  }
  await conn.query("UPDATE rental_forms SET status = 'used', used_by = ?, order_id = COALESCE(order_id, ?) WHERE tenant_id = ? AND id = ?", [userId ?? null, orderId ?? null, tenantId, form.id]);
  return { people: out, attached };
}

/**
 * A signed confirmation that counts for handing out gear on a contract: one signed at the counter for this contract,
 * a guest form for the rental day, or any signoff for the person within the shop's signoff_valid_days.
 * Track FIT's src/lib/rentalfit.js validSignoff is the shared check; this one also knows a form is filled ahead of the day.
 */
async function signoffFor(conn, tenantId, contract, settings) {
  const day = String(contract.valid_on instanceof Date ? contract.valid_on.toISOString() : contract.valid_on || '').slice(0, 10);
  const days = Math.max(Number(settings.signoff_valid_days) || 1, 1);
  return one(conn, `SELECT s.id FROM rental_signoffs s LEFT JOIN rental_forms f ON f.tenant_id = s.tenant_id AND f.id = s.form_id
    WHERE s.tenant_id = ? AND s.person_id = ? AND (s.contract_id = ? OR (f.id IS NOT NULL AND f.rental_on = ?) OR s.signed_at >= NOW() - INTERVAL ? DAY)
    ORDER BY s.id DESC LIMIT 1`, [tenantId, contract.person_id, contract.id, day || null, days]);
}

/** Lets go of gear set aside on a contract: the lines go, and the gear goes back on the rack. */
async function releaseSetAside(conn, tenantId, contractId) {
  const lines = await rows(conn, 'SELECT rental_item_id FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND returned_at IS NULL', [tenantId, contractId]);
  if (!lines.length) return 0;
  const ids = lines.map((l) => l.rental_item_id);
  await conn.query('DELETE FROM rental_contract_items WHERE tenant_id = ? AND contract_id = ? AND returned_at IS NULL', [tenantId, contractId]);
  await conn.query("UPDATE rental_items SET status = 'available' WHERE tenant_id = ? AND id IN (?) AND status = 'set_aside'", [tenantId, ids]);
  return ids.length;
}

/** Sets gear aside for a group member: locks it, checks it is free, writes the lines, and marks it set_aside. */
async function setAside(conn, tenantId, contract, gear) {
  const ids = gear.map((g) => g.rental_item_id);
  if (new Set(ids).size !== ids.length) throw bad('The same piece of gear was chosen twice');
  await releaseSetAside(conn, tenantId, contract.id);
  if (!ids.length) { await conn.query('UPDATE rental_contracts SET stage = NULL WHERE tenant_id = ? AND id = ?', [tenantId, contract.id]); return []; }
  const locked = await rows(conn, 'SELECT id, sku, status, category FROM rental_items WHERE tenant_id = ? AND id IN (?) FOR UPDATE', [tenantId, ids]);
  if (locked.length !== ids.length) throw notFound('One or more pieces of gear');
  const busy = locked.filter((r) => r.status !== 'available');
  if (busy.length) throw conflict(`Not free: ${busy.map((b) => `${b.sku} (${b.status.replace('_', ' ')})`).join(', ')}`);
  const byId = new Map(locked.map((l) => [l.id, l]));
  for (const g of gear) {
    if (g.test_result === 'fail') throw bad(`${byId.get(g.rental_item_id).sku} failed its binding test. Choose other gear.`);
    await conn.query(
      `INSERT INTO rental_contract_items (tenant_id, contract_id, rental_item_id, person_id, din_setting, boot_sole_mm, skier_type, tech_name, set_at, test_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, contract.id, g.rental_item_id, contract.person_id, g.din_setting ?? null, g.boot_sole_mm ?? null, g.skier_type ?? null, g.tech_name ?? null, g.din_setting != null ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, g.test_result ?? null],
    );
  }
  await conn.query("UPDATE rental_items SET status = 'set_aside' WHERE tenant_id = ? AND id IN (?)", [tenantId, ids]);
  await conn.query("UPDATE rental_contracts SET stage = 'set' WHERE tenant_id = ? AND id = ?", [tenantId, contract.id]);
  return locked;
}

/** The contract code printed on a bag label: RC- and the contract number. */
const contractCode = (id) => `RC-${id}`;
const parseContractCode = (code) => { const m = /^RC-?(\d{1,12})$/i.exec(String(code || '').trim()); return m ? Number(m[1]) : null; };

module.exports = {
  MAX_PEOPLE, MAX_SIGNATURE_CHARS, ABILITY, ABILITY_OF_TYPE, ADULT_AGE, sha, tokenOk, orderFormLink, groupLink, walkInLink, rentalLines, ageOn, cleanPerson,
  withoutSignatures, parsePeople, snapshot, saveDetails, personFor, candidates, closingOn, addMember, useForm, signoffFor, releaseSetAside, setAside,
  contractCode, parseContractCode,
};
