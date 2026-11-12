'use strict';

// Pay and costs are a manager's (2026.11.20 review): only owners and managers ever receive a money amount for work
// orders, assets, fleet, parts and the crew's time, from any endpoint. Labor on a job is costed at the person's own rate,
// so a cost next to their hours gives away their pay. For anyone else, every response under the paths below has its
// money fields taken out (hours, quantities and counts stay); a spreadsheet leaves out its money columns.
//
// Mounted once, after authenticate (src/app.js), so a route added later is covered without remembering to.

const PREFIXES = ['/assets', '/ops', '/water', '/sewer', '/stormwater', '/workforce/crew-board', '/workforce/my-day', '/workforce/overtime', '/jump', '/dashboard',
  '/solid-waste/routes', '/solid-waste/hauler']; // 2026.11.22: collection-day costs, tipping fees, the hauler's contract price and penalties
// A key that holds money. Not "rate" alone: a pump's rated flow and the share of requests met are not money.
const MONEY_KEY = /(_cents$|^cents$|^cost$|_cost$|^costs?_|_cost_|cost_per|^amount|_amount$|book_value|^money$|^price|_price$|rate_cents|^spend)/i;
const MANAGERS = ['owner', 'manager'];

/** A copy of value without money: keys that name money are dropped when they hold a number (or a numeric string). */
// Inside an object that is all about money (an asset's costs, its lifecycle), every number is money unless its key
// says it counts hours, miles, days or things.
const MONEY_PARENT = /^(costs?|lifecycle|money|totals_cost|cost_totals)$/i;
const NOT_MONEY = /(hours|miles|days|count|qty|quantity|years|^n$|percent|pct|score|months)/i;
function scrub(value, inMoney = false) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, inMoney));
  if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (MONEY_KEY.test(k) && (v === null || typeof v === 'number' || typeof v === 'string')) continue;
    if (inMoney && typeof v === 'number' && !NOT_MONEY.test(k)) continue;
    out[k] = scrub(v, inMoney || MONEY_PARENT.test(k));
  }
  return out;
}

/** A CSV without its money columns (a header that names cost, cents, rate, price, amount or a dollar sign). */
function scrubCsv(text) {
  const s = String(text);
  const lines = s.split(/\r?\n/);
  if (!lines.length) return s;
  const cells = (line) => { const out = []; let cur = ''; let q = false; for (let i = 0; i < line.length; i += 1) { const ch = line[i]; if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const head = cells(lines[0]);
  const drop = new Set(head.map((h, i) => (/(cost|cents|\brate\b|price|amount|\$|dollars|value)/i.test(h) ? i : -1)).filter((i) => i >= 0));
  if (!drop.size) return s;
  const q = (c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
  return lines.map((line) => (line === '' ? line : cells(line).filter((_, i) => !drop.has(i)).map(q).join(','))).join(s.includes('\r\n') ? '\r\n' : '\n');
}

// Express routes without regard to case (and decodes %xx when matching), so compare the same way: "/ASSETS/..." and
// "/%61ssets/..." reach the asset routes and must be filtered too (2026.11.20 re-review).
function normalPath(raw) {
  let p = String(raw || '');
  try { p = decodeURIComponent(p); } catch { /* a malformed escape: Express will 400 it; compare the raw form */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/');
}

function noMoney(req, res, next) {
  const path = normalPath(req.path);
  if (!req.auth || MANAGERS.includes(req.auth.role) || !PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`) || path.startsWith(`${p}.`))) return next();
  const json = res.json.bind(res);
  res.json = (body) => json(scrub(body));
  const send = res.send.bind(res);
  res.send = (body) => {
    const type = String(res.get('Content-Type') || '');
    if (typeof body === 'string' && /text\/csv/.test(type)) return send(scrubCsv(body));
    return send(body);
  };
  next();
}

module.exports = { noMoney, scrub, scrubCsv, MONEY_KEY, normalPath };
