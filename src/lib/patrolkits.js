'use strict';

// Patrol kits: the plain rules, shared by the server and the phone (public/js/kits.js has the same evaluate()), so a
// check made with no signal comes out the same when it is sent.
//
// A kind of kit lists its contents: { key, label, qty, expires }. A kit's stock is what its last check, restock or use
// left: { [key]: { qty, expires_on } }. A check marks each item present (with how many and, for items that expire, the
// soonest date), and the kit is ready when every item is there in full and nothing has expired.

/** Starting lists for the director to adjust. Quantities are typical for a small to mid-size patrol. */
const STARTERS = [
  { name: 'Trauma bag', prefix: 'TB', every_days: 1, contents: [
    ['trauma_dressing', 'Trauma dressings', 2, true], ['gauze_4x4', '4x4 gauze pads', 10, true], ['roller_gauze', 'Roller gauze', 4, true], ['triangular', 'Triangular bandages', 4, false],
    ['tape', 'Medical tape', 2, false], ['gloves', 'Nitrile gloves (pairs)', 6, false], ['pocket_mask', 'CPR pocket mask', 1, false], ['opa', 'Oral airways (set)', 1, false],
    ['sam_splint', 'SAM splints', 2, false], ['shears', 'Trauma shears', 1, false], ['tourniquet', 'Tourniquet', 1, false], ['hemostatic', 'Hemostatic gauze', 1, true],
    ['cold_pack', 'Instant cold packs', 2, true], ['oral_glucose', 'Oral glucose', 1, true], ['space_blanket', 'Emergency blankets', 2, false], ['penlight', 'Penlight', 1, false], ['care_cards', 'Patient care cards and pen', 2, false],
  ] },
  { name: 'Packed toboggan', prefix: 'TOB', every_days: 1, contents: [
    ['backboard', 'Backboard or vacuum mattress', 1, false], ['head_blocks', 'Head blocks', 1, false], ['straps', 'Straps', 4, false], ['c_collar', 'Cervical collar set', 1, false],
    ['traction', 'Traction splint', 1, false], ['quick_splints', 'Quick splint set', 1, false], ['blankets', 'Blankets', 2, false], ['tarp', 'Tarp or weather cover', 1, false],
    ['brake_chain', 'Brake chain', 1, false], ['ropes', 'Tie-down ropes', 2, false],
  ] },
  { name: 'Lift evacuation kit', prefix: 'EVAC', every_days: 7, contents: [
    ['rope', 'Rescue rope (check the retire date)', 1, true], ['seats', 'Evacuation seats or T-bars', 2, false], ['harnesses', 'Harnesses', 2, true], ['carabiners', 'Locking carabiners', 6, false],
    ['belay', 'Belay or lowering device', 1, false], ['throw_line', 'Throw line', 1, false], ['edge_protector', 'Edge protector', 1, false], ['helmets', 'Helmets', 2, true],
    ['headlamps', 'Headlamps with spare batteries', 2, false], ['gloves', 'Rope gloves (pairs)', 2, false], ['rope_bag', 'Rope bag', 1, false],
  ] },
].map((t) => ({ ...t, contents: t.contents.map(([key, label, qty, expires]) => ({ key, label, qty, expires })) }));

const parse = (v, d) => { if (!v) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };

/**
 * The outcome of a check: items is { [key]: { qty, expires_on } } as found. Returns the result (ready, not_ready), what
 * is short or expired, the soonest expiry, and the stock to keep.
 */
function evaluate(contents, items, today) {
  const short = []; const expired = []; let earliest = null; const stock = {};
  for (const c of contents) {
    const got = items[c.key] || {};
    const qty = Number(got.qty ?? 0);
    const exp = c.expires && got.expires_on ? String(got.expires_on).slice(0, 10) : null;
    stock[c.key] = { qty, expires_on: exp };
    if (qty < Number(c.qty)) short.push({ key: c.key, label: c.label, need: Number(c.qty), have: qty });
    if (exp && exp < today) expired.push({ key: c.key, label: c.label, expires_on: exp });
    if (exp && (!earliest || exp < earliest)) earliest = exp;
  }
  return { result: short.length || expired.length ? 'not_ready' : 'ready', short, expired, earliest, stock };
}

/** Supplies used on a case come off the stock; the kit then needs a restock. */
function afterUse(stock, used) {
  const out = { ...stock };
  for (const [key, n] of Object.entries(used)) out[key] = { ...(out[key] || { qty: 0 }), qty: Math.max(0, Number((out[key] || {}).qty || 0) - Number(n || 0)) };
  return out;
}

/** Where a kit stands on the board: out of service, needs restock, expired items, check due, or ready. */
function standing(kit, type, today) {
  if (kit.status === 'out_of_service') return 'out_of_service';
  if (kit.status === 'needs_restock') return 'needs_restock';
  if (kit.earliest_expiry && String(kit.earliest_expiry).slice(0, 10) < today) return 'expired';
  if (!kit.last_check_at) return 'check_due';
  const last = String(kit.last_check_at).slice(0, 10);
  const due = new Date(Date.parse(`${last}T12:00:00Z`) + Number(type.every_days) * 86_400_000).toISOString().slice(0, 10);
  if (due <= today) return 'check_due';
  if (kit.status === 'not_ready') return 'not_ready';
  return 'ready';
}

module.exports = { STARTERS, parse, evaluate, afterUse, standing };
