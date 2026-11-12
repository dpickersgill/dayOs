'use strict';
// Demo data for the 2026.11.20 polish (run by db/demo-municipal.js for the fictional Riverbend Borough, after the other
// files). Running it again changes nothing.
//   - Request references run in the order the requests came in (R-1001 for the oldest), as new ones do from this
//     release; the counter is set so the next request continues from the last.
//   - Most valves carry their turns to close on the record (an 8 in valve 25, a 6 in valve 19); every third one is left
//     empty, so the valve exercise shows its estimate from the size there.
//
// Exports async function (conn, tenantId, helpers).

module.exports = async function polishDemo(conn, T, { log }) {
  // ---- request references in reporting order
  const [reqs] = await conn.query('SELECT id, reference FROM requests WHERE tenant_id = ? ORDER BY reported_at, id', [T]);
  const want = reqs.map((r, i) => ({ id: Number(r.id), from: r.reference, to: `R-${1001 + i}` })).filter((r) => r.from !== r.to);
  if (want.length) {
    // Two steps, so a number another request still holds is never given twice at once (the reference is unique).
    for (const r of want) await conn.query('UPDATE requests SET reference = ? WHERE tenant_id = ? AND id = ?', [`T-${r.id}`.slice(0, 12), T, r.id]);
    for (const r of want) await conn.query('UPDATE requests SET reference = ? WHERE tenant_id = ? AND id = ?', [r.to, T, r.id]);
    log(`Renumbered ${want.length} requests in the order they came in`);
  }
  await conn.query('INSERT INTO request_numbers (tenant_id, last_n) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_n = GREATEST(last_n, VALUES(last_n))', [T, 1000 + reqs.length]);

  // ---- valves' turns to close
  const [valves] = await conn.query("SELECT id, tag, size FROM map_features WHERE tenant_id = ? AND kind = 'valve' AND turns_expected IS NULL AND tag LIKE 'V-%'", [T]);
  let turned = 0;
  for (const v of valves) {
    const n = Number(String(v.tag).slice(2));
    if (!Number.isFinite(n) || n % 3 === 0) continue; // left for the estimate
    await conn.query('UPDATE map_features SET turns_expected = ? WHERE tenant_id = ? AND id = ?', [String(v.size).startsWith('8') ? 25 : 19, T, v.id]);
    turned += 1;
  }
  if (turned) log(`${turned} valves have their turns to close on the record`);
};
