// The mountain's guest types (Adult, Youth, Child, Senior, Military, or its own), loaded once per page and kept, for
// the counter, price forms, receipts and slips. typeName() falls back to a tidy form of the code until they load.
import { get } from './api.js';

let cache = null;
let pending = null;
const tidy = (code) => String(code || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** All types in order, hidden ones included (each has hidden: true|false). */
export async function loadTypes(fresh = false) {
  if (cache && !fresh) return cache;
  if (!pending || fresh) pending = get('/guest-types').then((r) => { cache = r.types; return cache; }).finally(() => { pending = null; });
  return pending;
}
/** The ones that can be sold, as [code, name] pairs for a select, and the one to start on (Adult when there is one). */
export function saleOptions(types) {
  const v = types.filter((t) => !t.hidden);
  return { options: v.map((t) => [t.code, t.name]), first: (v.find((t) => t.code === 'adult') || v[0] || { code: 'adult' }).code };
}
export const typeName = (code) => ((cache || []).find((t) => t.code === code) || {}).name || tidy(code);
export function forget() { cache = null; }
loadTypes().catch(() => {}); // warm the cache for receipts and slips
