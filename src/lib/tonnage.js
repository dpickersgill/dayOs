'use strict';

// Tonnage (release 2026.11.22, Trash and recycling): weigh tickets from landfills, transfer stations and recycling
// processors, and the figures made from them.
//
//   A ticket    date, facility, stream (and the material for the recycling report), truck, gross, tare and net pounds,
//               ticket number, the tipping fee, and a photo. Entered in the office from a ticket or a facility's monthly
//               statement, brought in from a facility's or hauler's spreadsheet, or (with Collection routes) by the driver
//               at the end of the route through addTicket below.
//   The math    net = gross - tare, in pounds. A statement line with only a net weight (pounds or tons) is taken as it
//               is. Tons = pounds / 2000, shown to two places. A ticket number is unique at its facility, so the same
//               ticket cannot be counted twice (a line without a number is matched on its date, facility, stream and net).
//   Figures     tons by month, stream, facility and zone; recycling rate = (recycling + yard + food tons) / all tons;
//               cost per ton from tipping fees (owners and managers only, lib/nomoney.js); pounds per household from
//               the service address count (the water customer list), else the addresses that have carts.
const { pool, tx, rows, one } = require('../db');
const { bad, conflict } = require('./errors');
const { audit } = require('./audit');

const STREAM_KINDS = ['trash', 'recycling', 'yard', 'food', 'other'];
const RECYCLED = ['recycling', 'yard', 'food'];
const SECTORS = { res_curb: 'Residential curbside', res_dropoff: 'Residential drop-off', com_curb: 'Commercial curbside', com_dropoff: 'Commercial drop-off' };
const SECTOR_KEYS = Object.keys(SECTORS);
const FACILITY_KINDS = { landfill: 'Landfill', transfer: 'Transfer station', recycling: 'Recycling processor', compost: 'Compost or yard waste site', other: 'Other' };
// The materials of Pennsylvania's municipal recycling report (DEP / county categories), plus trash, which is weighed
// but never reported as recycled. The list is easy to change: the report reads it from here.
const MATERIALS = [
  ['msw', 'Trash (municipal solid waste)', 'trash'],
  ['commingled', 'Single-stream recycling (mixed)', 'recycling'],
  ['newsprint', 'Newsprint', 'recycling'],
  ['corrugated', 'Corrugated cardboard', 'recycling'],
  ['office_paper', 'High-grade office paper', 'recycling'],
  ['mixed_paper', 'Mixed paper and magazines', 'recycling'],
  ['glass_clear', 'Clear glass', 'recycling'],
  ['glass_colored', 'Colored glass', 'recycling'],
  ['aluminum', 'Aluminum cans', 'recycling'],
  ['steel', 'Steel and bimetallic cans', 'recycling'],
  ['plastics', 'Plastics', 'recycling'],
  ['metal_other', 'Scrap metal and appliances', 'recycling'],
  ['electronics', 'Electronics', 'recycling'],
  ['tires', 'Tires', 'recycling'],
  ['leaf_yard', 'Leaf and yard waste', 'yard'],
  ['food', 'Food waste', 'food'],
  ['other', 'Other recycled material', 'other'],
];
const MATERIAL = Object.fromEntries(MATERIALS.map(([k, label, kind]) => [k, { label, kind }]));
const MATERIAL_KEYS = MATERIALS.map((m) => m[0]);
const defaultMaterial = (kind) => ({ trash: 'msw', recycling: 'commingled', yard: 'leaf_yard', food: 'food' }[kind] || 'other');
const tons = (lb) => Math.round((Number(lb || 0) / 2000) * 100) / 100;
const MAX_NET_LB = 2_000_000; // 1,000 tons: a hauler's monthly total on one line, never a typing slip of an extra digit or three

/** lib/collection.js (workstream "schedule"), or the phase 1 stub until it is merged. */
const collection = () => require('./carts').collection();

const facilitiesOf = (db, tenantId, { all = false } = {}) => rows(db, `SELECT id, name, kind, address, fee_per_ton_cents, residue_pct, active FROM tonnage_facilities
  WHERE tenant_id = ?${all ? '' : ' AND active = 1'} ORDER BY active DESC, name`, [tenantId])
  .then((r) => r.map((f) => ({ ...f, id: Number(f.id), fee_per_ton_cents: f.fee_per_ton_cents === null ? null : Number(f.fee_per_ton_cents), residue_pct: Number(f.residue_pct), active: Boolean(f.active) })));

const int = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * The weights of a ticket in pounds: { gross_lb, tare_lb, net_lb }. Takes gross and tare (net = gross - tare), or a net
 * alone in pounds or tons. Refuses what cannot be right, in plain words.
 */
function weights(t) {
  const gross = int(t.gross_lb); const tare = int(t.tare_lb);
  let net = int(t.net_lb);
  if (net === null && t.net_tons !== null && t.net_tons !== undefined && t.net_tons !== '') net = Math.round(Number(t.net_tons) * 2000);
  for (const [v, w] of [[gross, 'gross'], [tare, 'tare'], [net, 'net']]) {
    if (v !== null && (!Number.isFinite(v) || v < 0)) throw bad(`The ${w} weight must be a number of pounds, 0 or more`);
  }
  if ((gross === null) !== (tare === null)) throw bad('Give both the gross and the tare weight, or only the net weight');
  if (gross !== null) {
    if (tare >= gross) throw bad('The tare (empty truck) must be less than the gross (full truck)');
    const fromScale = Math.round(gross) - Math.round(tare);
    // A ticket prints net tons to two places, so a net typed from it may be off by up to 10 pounds.
    if (net !== null && Math.abs(net - fromScale) > 10) throw bad(`The net weight should be gross minus tare: ${fromScale.toLocaleString('en-US')} pounds (${tons(fromScale)} tons)`);
    net = fromScale;
  }
  if (net === null) throw bad('Give the gross and tare weights, or the net weight');
  if (net <= 0) throw bad('The net weight must be more than 0');
  if (net > MAX_NET_LB) throw bad('That is more than 1,000 tons on one ticket. Check the weight and its unit (pounds or tons).');
  return { gross_lb: gross === null ? null : Math.round(gross), tare_lb: tare === null ? null : Math.round(tare), net_lb: Math.round(net) };
}

/**
 * Adds one weigh ticket inside the caller's transaction (conn), checked and audited. The routes workstream calls this
 * for a driver's ticket at the end of a route. ticket: { on_date, facility_id, stream_id?, stream_kind?, material?,
 * sector?, zone_id?, truck_asset_id?, truck_label?, ticket_no?, gross_lb?, tare_lb?, net_lb?, net_tons?, fee_cents?,
 * hauler?, note?, source?: 'office'|'driver'|'import', import_id? }. by: the user id entering it.
 * Returns { id, net_lb, net_tons, fee_cents }. A ticket number already used at that facility is refused (409,
 * code duplicate_ticket).
 */
async function addTicket(conn, tenantId, ticket, { by = null } = {}) {
  const t = ticket || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.on_date || ''))) throw bad('Give the ticket date (YYYY-MM-DD)');
  const tz = (await one(conn, 'SELECT timezone FROM tenants WHERE id = ?', [tenantId])).timezone;
  const today = require('./util').todayIn(tz);
  if (String(t.on_date) > today) throw bad('The ticket date cannot be in the future');
  if (String(t.on_date) < '2000-01-01') throw bad('Check the ticket date');
  const f = await one(conn, 'SELECT id, name, fee_per_ton_cents FROM tonnage_facilities WHERE tenant_id = ? AND id = ?', [tenantId, t.facility_id || 0]);
  if (!f) throw bad('Pick the facility from the list');
  let kind = t.stream_kind || null; let streamId = t.stream_id ? Number(t.stream_id) : null;
  if (streamId) {
    const s = await one(conn, 'SELECT id, kind FROM collection_streams WHERE tenant_id = ? AND id = ?', [tenantId, streamId]);
    if (!s) throw bad('Pick the stream from the list');
    kind = s.kind;
  }
  if (!kind && t.material && MATERIAL[t.material]) kind = MATERIAL[t.material].kind;
  if (!STREAM_KINDS.includes(kind)) throw bad('Say what was weighed: trash, recycling, yard waste, food waste or other');
  const material = t.material || defaultMaterial(kind);
  if (!MATERIAL[material]) throw bad('Pick the material from the list');
  if (kind === 'trash' && material !== 'msw') throw bad('A trash ticket is trash: pick a recycling stream for a recycled material');
  const sector = t.sector || 'res_curb';
  if (!SECTORS[sector]) throw bad('Pick residential or commercial, curbside or drop-off');
  if (t.zone_id && !(await one(conn, 'SELECT id FROM collection_zones WHERE tenant_id = ? AND id = ?', [tenantId, t.zone_id]))) throw bad('Pick the zone from the list');
  if (t.truck_asset_id && !(await one(conn, 'SELECT id FROM ops_assets WHERE tenant_id = ? AND id = ?', [tenantId, t.truck_asset_id]))) throw bad('Pick the truck from the list');
  const w = weights(t);
  const ticketNo = t.ticket_no ? String(t.ticket_no).trim().slice(0, 40) : null;
  let fee = t.fee_cents === null || t.fee_cents === undefined || t.fee_cents === '' ? null : Number(t.fee_cents);
  if (fee !== null && (!Number.isInteger(fee) || fee < 0 || fee > 100_000_000)) throw bad('Check the tipping fee');
  if (fee === null && f.fee_per_ton_cents !== null) fee = Math.round((w.net_lb / 2000) * Number(f.fee_per_ton_cents));
  if (!ticketNo) {
    // No ticket number (a statement or report line): the same date, facility, stream and weight is the same line.
    const same = await one(conn, 'SELECT id FROM weigh_tickets WHERE tenant_id = ? AND facility_id = ? AND on_date = ? AND stream_kind = ? AND material = ? AND net_lb = ? AND voided_at IS NULL AND ticket_no IS NULL',
      [tenantId, f.id, t.on_date, kind, material, w.net_lb]);
    if (same) throw conflict('This line is already entered (same date, facility, stream and weight)', { code: 'duplicate_ticket', ticket_id: Number(same.id) });
  }
  let ins;
  try {
    [ins] = await conn.query(`INSERT INTO weigh_tickets (tenant_id, on_date, ticket_no, facility_id, stream_id, stream_kind, material, sector, zone_id, truck_asset_id, truck_label, gross_lb, tare_lb, net_lb,
        fee_cents, source, import_id, hauler, note, entered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, t.on_date, ticketNo, f.id, streamId, kind, material, sector, t.zone_id || null, t.truck_asset_id || null, t.truck_label ? String(t.truck_label).slice(0, 60) : null,
      w.gross_lb, w.tare_lb, w.net_lb, fee, ['office', 'driver', 'import'].includes(t.source) ? t.source : 'office', t.import_id || null, t.hauler ? String(t.hauler).slice(0, 120) : null,
      t.note ? String(t.note).slice(0, 300) : null, by]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const same = await one(conn, 'SELECT id FROM weigh_tickets WHERE tenant_id = ? AND facility_id = ? AND ticket_no = ?', [tenantId, f.id, ticketNo]);
      throw conflict(`Ticket ${ticketNo} from ${f.name} is already entered`, { code: 'duplicate_ticket', ticket_id: same ? Number(same.id) : null });
    }
    throw err;
  }
  await audit(conn, { auth: { tenantId, userId: by } }, 'weigh_ticket', 'weigh_tickets', ins.insertId, { on_date: t.on_date, facility_id: f.id, ticket_no: ticketNo, net_lb: w.net_lb, stream_kind: kind, source: t.source || 'office' });
  return { id: Number(ins.insertId), net_lb: w.net_lb, net_tons: tons(w.net_lb), fee_cents: fee };
}

// ---------------------------------------------------------------- households
/**
 * Households for pounds per household: the year's report's own number when the manager set it, else the water customer
 * list's active addresses, else the addresses that have carts. { n, source }.
 */
async function households(db, tenantId, year = null) {
  if (year) {
    const r = await one(db, 'SELECT households FROM recycling_reports WHERE tenant_id = ? AND year = ?', [tenantId, year]);
    if (r && r.households) return { n: Number(r.households), source: 'report' };
  }
  const sa = await one(db, 'SELECT COUNT(*) AS n FROM service_addresses WHERE tenant_id = ? AND active = 1', [tenantId]);
  if (Number(sa.n)) return { n: Number(sa.n), source: 'service_addresses' };
  const c = await one(db, "SELECT COUNT(DISTINCT street_id, house_number, COALESCE(unit, '')) AS n FROM carts WHERE tenant_id = ? AND status = 'in_use'", [tenantId]);
  return { n: Number(c.n), source: Number(c.n) ? 'carts' : 'none' };
}

const rate = (recycled, all) => (all > 0 ? Math.round((recycled / all) * 1000) / 10 : null);

/**
 * The figures for a period (from..to inclusive): totals by stream kind, month, facility, zone and material; the recycling
 * rate; pounds per household (over the whole period); tipping fees and cost per ton (lib/nomoney.js takes those out for
 * anyone but owners and managers).
 */
async function figures(db, tenantId, { from, to, year = null }) {
  const W = 't.tenant_id = ? AND t.on_date BETWEEN ? AND ? AND t.voided_at IS NULL';
  const P = [tenantId, from, to];
  const byKind = await rows(db, `SELECT t.stream_kind AS kind, SUM(t.net_lb) AS lb, SUM(COALESCE(t.fee_cents, 0)) AS fees, COUNT(*) AS n FROM weigh_tickets t WHERE ${W} GROUP BY t.stream_kind`, P);
  const byMonth = await rows(db, `SELECT DATE_FORMAT(t.on_date, '%Y-%m') AS month, t.stream_kind AS kind, SUM(t.net_lb) AS lb, SUM(COALESCE(t.fee_cents, 0)) AS fees FROM weigh_tickets t WHERE ${W} GROUP BY month, t.stream_kind ORDER BY month`, P);
  const byFacility = await rows(db, `SELECT f.id, f.name, f.kind, t.stream_kind AS stream_kind, SUM(t.net_lb) AS lb, SUM(COALESCE(t.fee_cents, 0)) AS fees, COUNT(*) AS n FROM weigh_tickets t
    JOIN tonnage_facilities f ON f.tenant_id = t.tenant_id AND f.id = t.facility_id WHERE ${W} GROUP BY f.id, f.name, f.kind, t.stream_kind ORDER BY f.name`, P);
  const byZone = await rows(db, `SELECT z.id, z.name, t.stream_kind AS kind, SUM(t.net_lb) AS lb FROM weigh_tickets t LEFT JOIN collection_zones z ON z.tenant_id = t.tenant_id AND z.id = t.zone_id
    WHERE ${W} GROUP BY z.id, z.name, t.stream_kind ORDER BY z.id IS NULL, z.name`, P);
  const byMaterial = await rows(db, `SELECT t.material, SUM(t.net_lb) AS lb FROM weigh_tickets t WHERE ${W} GROUP BY t.material ORDER BY lb DESC`, P);
  const lbOf = (list, kinds) => list.filter((x) => kinds.includes(x.kind)).reduce((s, x) => s + Number(x.lb || 0), 0);
  const allLb = lbOf(byKind, STREAM_KINDS); const recLb = lbOf(byKind, RECYCLED);
  const fees = byKind.reduce((s, x) => s + Number(x.fees || 0), 0);
  const hh = await households(db, tenantId, year);
  const months = new Map();
  for (const m of byMonth) {
    const cur = months.get(m.month) || { month: m.month, tons: {}, all_tons: 0, recycled_tons: 0, fees_cents: 0 };
    cur.tons[m.kind] = tons(m.lb); cur.fees_cents += Number(m.fees || 0);
    cur.all_lb = (cur.all_lb || 0) + Number(m.lb); if (RECYCLED.includes(m.kind)) cur.rec_lb = (cur.rec_lb || 0) + Number(m.lb);
    months.set(m.month, cur);
  }
  const facilities = new Map();
  for (const f of byFacility) {
    const cur = facilities.get(f.id) || { id: Number(f.id), name: f.name, kind: f.kind, tickets: 0, lb: 0, fees_cents: 0, by_stream: {} };
    cur.tickets += Number(f.n); cur.lb += Number(f.lb); cur.fees_cents += Number(f.fees || 0); cur.by_stream[f.stream_kind] = tons(f.lb);
    facilities.set(f.id, cur);
  }
  const zones = new Map();
  for (const z of byZone) {
    const key = z.id === null ? 'none' : String(z.id);
    const cur = zones.get(key) || { zone_id: z.id === null ? null : Number(z.id), zone: z.id === null ? 'Zone not recorded' : z.name, tons: {}, lb: 0 };
    cur.tons[z.kind] = tons(z.lb); cur.lb += Number(z.lb); zones.set(key, cur);
  }
  return {
    from, to,
    totals: { tickets: byKind.reduce((s, x) => s + Number(x.n), 0), all_tons: tons(allLb), recycled_tons: tons(recLb), by_stream: Object.fromEntries(byKind.map((x) => [x.kind, tons(x.lb)])) },
    recycling_rate: rate(recLb, allLb),
    households: hh.n, households_source: hh.source,
    pounds_per_household: hh.n ? Math.round(allLb / hh.n) : null,
    recycled_pounds_per_household: hh.n ? Math.round(recLb / hh.n) : null,
    fees_cents: fees, cost_per_ton_cents: allLb ? Math.round(fees / (allLb / 2000)) : null,
    months: [...months.values()].map(({ all_lb: a = 0, rec_lb: r = 0, ...m }) => ({ ...m, all_tons: tons(a), recycled_tons: tons(r), recycling_rate: rate(r, a), cost_per_ton_cents: a ? Math.round(m.fees_cents / (a / 2000)) : null })),
    facilities: [...facilities.values()].map(({ lb, ...f }) => ({ ...f, tons: tons(lb), cost_per_ton_cents: lb ? Math.round(f.fees_cents / (lb / 2000)) : null })),
    zones: [...zones.values()].map(({ lb, ...z }) => ({ ...z, all_tons: tons(lb) })),
    materials: byMaterial.map((m) => ({ material: m.material, label: (MATERIAL[m.material] || { label: m.material }).label, tons: tons(m.lb) })),
  };
}

/** The monthly report's Trash and recycling section (lib/monthreport.js): tons, rate, missed pickups, carts delivered. */
async function monthSection(db, tenantId, from, to) {
  const f = await figures(db, tenantId, { from, to });
  const missed = await one(db, `SELECT COUNT(*) AS n FROM requests r JOIN request_categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
    WHERE r.tenant_id = ? AND c.name IN ('Missed pickup', 'Missed trash or recycling') AND r.reported_at BETWEEN ? AND ? AND r.status <> 'duplicate'`, [tenantId, `${from} 00:00:00`, `${to} 23:59:59`]);
  return {
    tons: f.totals.by_stream, all_tons: f.totals.all_tons, recycled_tons: f.totals.recycled_tons, recycling_rate: f.recycling_rate, tickets: f.totals.tickets,
    pounds_per_household: f.pounds_per_household, households: f.households, fees_cents: f.fees_cents, cost_per_ton_cents: f.cost_per_ton_cents,
    missed_pickups: Number(missed.n), carts_delivered: await require('./carts').deliveredBetween(db, tenantId, from, to),
  };
}

// ---------------------------------------------------------------- spreadsheet import
// Column names facilities and haulers use, to the field each fills.
const HEADS = {
  date: 'on_date', ticket_date: 'on_date', on_date: 'on_date', day: 'on_date', service_date: 'on_date',
  ticket: 'ticket_no', ticket_no: 'ticket_no', ticket_number: 'ticket_no', ticket_num: 'ticket_no', scale_ticket: 'ticket_no',
  facility: 'facility', site: 'facility', location: 'facility', disposal_site: 'facility',
  stream: 'stream', material: 'stream', commodity: 'stream', waste_type: 'stream', product: 'stream',
  gross: 'gross_lb', gross_lb: 'gross_lb', gross_lbs: 'gross_lb', gross_weight: 'gross_lb', tare: 'tare_lb', tare_lb: 'tare_lb', tare_lbs: 'tare_lb', tare_weight: 'tare_lb',
  net: 'net_lb', net_lb: 'net_lb', net_lbs: 'net_lb', net_weight: 'net_lb', pounds: 'net_lb', lbs: 'net_lb',
  tons: 'net_tons', net_tons: 'net_tons', tonnage: 'net_tons',
  fee: 'fee', tipping_fee: 'fee', amount: 'fee', charge: 'fee', cost: 'fee',
  truck: 'truck_label', vehicle: 'truck_label', truck_no: 'truck_label', hauler: 'hauler', sector: 'sector',
};
const STREAM_WORDS = [
  [/^(msw|trash|refuse|garbage|solid waste|municipal solid waste|rubbish)/i, 'trash', 'msw'],
  [/single.?stream|commingled|mixed recycl|recycl/i, 'recycling', 'commingled'],
  [/news/i, 'recycling', 'newsprint'], [/corrugated|cardboard|occ/i, 'recycling', 'corrugated'], [/office paper|high.?grade/i, 'recycling', 'office_paper'],
  [/mixed paper|magazine/i, 'recycling', 'mixed_paper'], [/clear glass/i, 'recycling', 'glass_clear'], [/colou?red glass|brown glass|green glass/i, 'recycling', 'glass_colored'],
  [/alumin/i, 'recycling', 'aluminum'], [/steel|tin|bimetal/i, 'recycling', 'steel'], [/plastic/i, 'recycling', 'plastics'], [/scrap|appliance|white goods|metal/i, 'recycling', 'metal_other'],
  [/electronic|e-?waste/i, 'recycling', 'electronics'], [/tire/i, 'recycling', 'tires'],
  [/leaf|leaves|yard|brush|grass|organics/i, 'yard', 'leaf_yard'], [/food/i, 'food', 'food'],
];
/** "Single stream" -> { kind: 'recycling', material: 'commingled' }; a stream's own name works too. */
function streamFromWords(text, streams) {
  const s = String(text || '').trim();
  if (!s) return null;
  const own = streams.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (own) return { stream_id: Number(own.id), kind: own.kind, material: defaultMaterial(own.kind) };
  const mat = MATERIAL_KEYS.find((k) => k === s.toLowerCase() || MATERIAL[k].label.toLowerCase() === s.toLowerCase());
  if (mat) return { kind: MATERIAL[mat].kind, material: mat };
  for (const [re, kind, material] of STREAM_WORDS) if (re.test(s)) return { kind, material };
  return null;
}
const money2cents = (v) => { const s = String(v ?? '').replace(/[$,\s]/g, ''); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
function dateOf(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{1,2})$/.exec(s); // a monthly report's month: the last day is not known, the first is used
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`;
  return null;
}
const realDate = (d) => { if (!d) return false; const x = new Date(`${d}T12:00:00Z`); return !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d; };

/**
 * Brings in a facility's or hauler's report (CSV text). Each row is checked like a typed ticket; a bad row is listed
 * with its line number and reason and the rest still come in. dryRun: check only. Returns
 * { added, skipped: [{ line, reason }], rows, import_id }.
 */
async function importCsv(tenantId, { csv, sourceName, fileName = null, facilityId = null, hauler = null, dryRun = false }, { by = null } = {}) {
  const table = require('./places').parseCsv(String(csv || '')).filter((r) => r.some((c) => String(c || '').trim()));
  if (table.length < 2) throw bad('The file needs a header row (date, ticket, facility, material, gross, tare, net or tons) and at least one line.');
  if (table.length > 20001) throw bad('Bring in at most 20,000 lines at a time.');
  const head = table[0].map((h) => HEADS[String(h).trim().toLowerCase().replace(/[\s.#()-]+/g, '_').replace(/^_+|_+$/g, '')] || null);
  if (!head.includes('on_date')) throw bad('The header row needs a date column.');
  if (!['gross_lb', 'net_lb', 'net_tons'].some((k) => head.includes(k))) throw bad('The header row needs a weight column: gross and tare, net (pounds), or tons.');
  if (!head.includes('facility') && !facilityId) throw bad('Pick the facility these tickets are from, or include a facility column.');
  const facilities = await facilitiesOf(pool, tenantId, { all: true });
  const streams = await rows(pool, 'SELECT id, name, kind FROM collection_streams WHERE tenant_id = ?', [tenantId]);
  const clean = (v) => String(v ?? '').trim().replace(/^'(?=[=+\-@])/, '');
  const out = { added: 0, skipped: [], rows: table.length - 1, import_id: null };
  const seenNos = new Set(); // a check (dryRun) adds nothing, so a number twice in the file is caught here
  await tx(async (conn) => {
    if (!dryRun) {
      const [r] = await conn.query('INSERT INTO weigh_ticket_imports (tenant_id, source_name, file_name, created_by) VALUES (?, ?, ?, ?)', [tenantId, String(sourceName).slice(0, 120), fileName ? String(fileName).slice(0, 160) : null, by]);
      out.import_id = Number(r.insertId);
    }
    for (let i = 1; i < table.length; i += 1) {
      const row = {};
      head.forEach((k, j) => { if (k && row[k] === undefined) row[k] = clean(table[i][j]); });
      const line = i + 1;
      const skip = (reason) => out.skipped.push({ line, reason });
      const onDate = dateOf(row.on_date);
      if (!realDate(onDate)) { skip('The date is not a real date (use 2026-03-31 or 3/31/2026)'); continue; }
      let fac = facilityId ? facilities.find((f) => f.id === Number(facilityId)) : null;
      if (row.facility) fac = facilities.find((f) => f.name.toLowerCase() === row.facility.toLowerCase()) || null;
      if (!fac) { skip(row.facility ? `"${row.facility.slice(0, 60)}" is not on the facilities list. Add it first, or fix the name.` : 'No facility'); continue; }
      const st = streamFromWords(row.stream, streams) || (row.stream ? null : (fac.kind === 'landfill' || fac.kind === 'transfer' ? { kind: 'trash', material: 'msw' } : fac.kind === 'compost' ? { kind: 'yard', material: 'leaf_yard' } : { kind: 'recycling', material: 'commingled' }));
      if (!st) { skip(`"${String(row.stream).slice(0, 60)}" is not a stream or material we know`); continue; }
      const num = (v) => { const s = String(v ?? '').replace(/[,\s]/g, ''); return s === '' ? null : Number(s); };
      const fee = row.fee === undefined ? null : money2cents(row.fee);
      if (Number.isNaN(fee)) { skip('The fee is not an amount'); continue; }
      const t = { on_date: onDate, ticket_no: row.ticket_no || null, facility_id: fac.id, stream_id: st.stream_id || null, stream_kind: st.kind, material: st.material,
        sector: SECTORS[row.sector] ? row.sector : /commercial/i.test(row.sector || '') ? (/drop/i.test(row.sector) ? 'com_dropoff' : 'com_curb') : /drop/i.test(row.sector || '') ? 'res_dropoff' : 'res_curb',
        gross_lb: num(row.gross_lb), tare_lb: num(row.tare_lb), net_lb: num(row.net_lb), net_tons: num(row.net_tons), fee_cents: fee, truck_label: row.truck_label || null,
        hauler: row.hauler || hauler || null, source: 'import', import_id: out.import_id };
      for (const k of ['gross_lb', 'tare_lb', 'net_lb', 'net_tons']) if (t[k] !== null && Number.isNaN(t[k])) t[k] = -1; // reported by weights() as "must be a number"
      try {
        await conn.query('SAVEPOINT line');
        if (dryRun) {
          weights(t);
          if (t.ticket_no && (seenNos.has(`${fac.id}|${t.ticket_no}`) || await one(conn, 'SELECT id FROM weigh_tickets WHERE tenant_id = ? AND facility_id = ? AND ticket_no = ?', [tenantId, fac.id, t.ticket_no]))) throw conflict(`Ticket ${t.ticket_no} from ${fac.name} is already entered`);
          if (t.ticket_no) seenNos.add(`${fac.id}|${t.ticket_no}`);
        } else await addTicket(conn, tenantId, t, { by });
        await conn.query('RELEASE SAVEPOINT line');
        out.added += 1;
      } catch (err) {
        await conn.query('ROLLBACK TO SAVEPOINT line');
        if (!err.status || err.status >= 500) throw err;
        skip(err.message);
      }
    }
    if (!dryRun) {
      await conn.query('UPDATE weigh_ticket_imports SET rows_added = ?, rows_skipped = ? WHERE tenant_id = ? AND id = ?', [out.added, out.skipped.length, tenantId, out.import_id]);
      await audit(conn, { auth: { tenantId, userId: by } }, 'weigh_ticket_import', 'weigh_ticket_imports', out.import_id, { source: sourceName, added: out.added, skipped: out.skipped.length });
    }
  });
  return out;
}

module.exports = {
  STREAM_KINDS, RECYCLED, SECTORS, SECTOR_KEYS, FACILITY_KINDS, MATERIALS, MATERIAL, MATERIAL_KEYS, defaultMaterial, tons, weights, addTicket, facilitiesOf, households, figures,
  monthSection, importCsv, streamFromWords, rate, collection,
};
