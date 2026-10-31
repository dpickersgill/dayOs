'use strict';

// Applies every erasure again after a restore (RECOVERY.md, "After any restore"). A backup is a copy of the database as it
// was; guests anonymised and mountains deleted since then come back in it. The deletion ledger lists them all.
//
//   node db/deletions.js export > ledger.json        on the live database BEFORE you restore (or any copy newer than the backup)
//   node db/deletions.js replay ledger.json          on the restored database, after node db/migrate.js
//   node db/deletions.js replay logs.json            the same, from Cloud Logging when the live database is gone:
//        gcloud logging read 'jsonPayload.action="deletion_ledger"' --freshness=400d --format=json > logs.json
//
// Replaying is safe to repeat: an erasure already applied is applied again (it changes nothing more) and its ledger row is
// added only when missing. Uses the usual DB_* settings; run it with the migrator login.
const fs = require('fs');
const { pool, tx } = require('../src/db');

function parse(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.rows || [];
  return list.map((x) => {
    const j = x.jsonPayload || x;
    return { tenant_id: Number(j.tenant_id ?? j.tenant), kind: j.kind || j.entity, ref_id: Number(j.ref_id ?? j.entity_id), done_by: j.done_by ?? j.actor ?? null, done_at: j.done_at || j.at || x.timestamp || null };
  }).filter((x) => x.tenant_id && x.ref_id && ['anonymise', 'mountain'].includes(x.kind));
}

async function exportAll() {
  const [r] = await pool.query('SELECT tenant_id, kind, ref_id, done_by, done_at FROM deletion_ledger ORDER BY id');
  process.stdout.write(`${JSON.stringify({ exported_at: new Date().toISOString(), rows: r }, null, 1)}\n`);
}

async function replay(file) {
  const items = parse(fs.readFileSync(file, 'utf8'));
  const { anonymise } = require('../src/routes/customerplus');
  const retention = require('../src/lib/retention');
  const out = { anonymised: 0, mountains: 0, refused: [] };
  for (const it of items) {
    if (it.kind === 'anonymise') {
      const ok = await tx(async (conn) => {
        const [[p]] = await conn.query('SELECT id FROM people WHERE tenant_id = ? AND id = ? FOR UPDATE', [it.tenant_id, it.ref_id]);
        if (!p) return false;
        await anonymise(conn, it.tenant_id, it.ref_id, null, null);
        return true;
      });
      if (ok) out.anonymised += 1;
    } else {
      const [[t]] = await pool.query('SELECT id, data_deleted_at FROM tenants WHERE id = ?', [it.tenant_id]);
      if (t && !t.data_deleted_at) {
        // The restored copy may predate the closing: close it again with the window already over, then delete as before.
        await pool.query("UPDATE tenants SET status = 'suspended', closed_at = COALESCE(closed_at, UTC_TIMESTAMP()), delete_after = LEAST(COALESCE(delete_after, CURDATE()), CURDATE()) WHERE id = ?", [t.id]);
        try { await retention.deleteClosed(t.id); out.mountains += 1; } catch (e) { out.refused.push({ tenant_id: t.id, why: e.message }); }
      }
    }
    const [[have]] = await pool.query('SELECT id FROM deletion_ledger WHERE tenant_id = ? AND kind = ? AND ref_id = ? LIMIT 1', [it.tenant_id, it.kind, it.ref_id]);
    if (!have) await pool.query('INSERT INTO deletion_ledger (tenant_id, kind, ref_id, done_by, done_at) VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))', [it.tenant_id, it.kind, it.ref_id, it.done_by, it.done_at ? new Date(it.done_at) : null]);
  }
  console.log(JSON.stringify(out));
  if (out.refused.length) process.exitCode = 3;
}

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  const run = cmd === 'export' ? exportAll() : cmd === 'replay' && file ? replay(file) : Promise.reject(new Error('Use: node db/deletions.js export | replay <file>'));
  run.then(() => pool.end()).catch((e) => { console.error(e.message); process.exitCode = 1; pool.end(); });
}

module.exports = { parse, replay };
