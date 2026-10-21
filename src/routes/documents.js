'use strict';

// The document repository. Managers make categories and choose which roles can see each one (and which roles may add to it).
// A category with no roles is for managers only. Files are stored in the database, up to 10 MB each. Replacing a file keeps the
// old one as an earlier version (up to 10 in all), and the words inside every file are read so documents can be searched.
const express = require('express');
const path = require('path');
const { pool, tx, rows, one } = require('../db');
const { requireRole, isManager } = require('../middleware/auth');
const { partialOf, z, validate, paramId, setClause } = require('../lib/util');
const { AppError, notFound, bad, forbidden, conflict } = require('../lib/errors');
const { audit } = require('../lib/audit');
const { extract } = require('../lib/doctext');

const router = express.Router();
const manager = requireRole('manager');
const ROLES = ['staff', 'patrol', 'instructor', 'counter'];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_VERSIONS = 10; // a document keeps this many versions, counting the current one

// What may be uploaded. Web pages, scripts and vector images are left out on purpose: they can run code in the browser.
const TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', rtf: 'application/rtf',
};

/**
 * Is the file what its name says? Checked from its first bytes, so a program renamed to .pdf, or an Office file carrying
 * macros, is refused before anyone opens it. (Zip archives are no longer accepted: they are how malware usually travels.)
 */
function contentMatches(ext, buf) {
  const head = buf.subarray(0, 16);
  const starts = (...bytes) => bytes.every((b, i) => head[i] === b);
  const text = () => !buf.subarray(0, 8192).includes(0); // no NUL bytes in a text file
  const zipHas = (dir) => buf.includes(Buffer.from(dir)) && !buf.includes(Buffer.from('vbaProject.bin'));
  switch (ext) {
    case 'pdf': return buf.subarray(0, 5).toString() === '%PDF-';
    case 'png': return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'jpg': case 'jpeg': return starts(0xff, 0xd8, 0xff);
    case 'gif': return buf.subarray(0, 4).toString() === 'GIF8';
    case 'webp': return buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
    case 'docx': return starts(0x50, 0x4b, 0x03, 0x04) && zipHas('word/');
    case 'xlsx': return starts(0x50, 0x4b, 0x03, 0x04) && zipHas('xl/');
    case 'pptx': return starts(0x50, 0x4b, 0x03, 0x04) && zipHas('ppt/');
    case 'doc': case 'xls': case 'ppt': return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
    case 'rtf': return buf.subarray(0, 5).toString() === '{\\rtf';
    case 'txt': case 'csv': case 'md': return text();
    default: return false;
  }
}
const INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const nullable = (s) => s.nullable().optional();

/** What this login can do in a category: 'none', 'view' or 'add'. */
async function accessTo(conn, req, categoryId) {
  if (isManager(req)) return 'add';
  const r = await one(conn, 'SELECT can_add FROM doc_category_roles WHERE tenant_id = ? AND category_id = ? AND role = ?', [req.auth.tenantId, categoryId, req.auth.role]);
  if (!r) return 'none';
  return r.can_add ? 'add' : 'view';
}
async function needCategory(conn, req, id, level) {
  const c = await one(conn, 'SELECT id, name FROM doc_categories WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!c) throw notFound('Category');
  const a = await accessTo(conn, req, id);
  if (a === 'none') throw notFound('Category');
  if (level === 'add' && a !== 'add') throw forbidden('Your role can read this category but not add to it');
  return c;
}
async function needDocument(conn, req, id, level) {
  const d = await one(conn, 'SELECT * FROM documents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!d) throw notFound('Document');
  const a = await accessTo(conn, req, d.category_id);
  if (a === 'none') throw notFound('Document');
  if (level === 'add' && a !== 'add') throw forbidden('Your role can read this category but not change it');
  return d;
}
async function who(conn, req) {
  const u = await one(conn, "SELECT COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS name FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id WHERE u.tenant_id = ? AND u.id = ?", [req.auth.tenantId, req.auth.userId]);
  return u ? u.name : null;
}
const cleanName = (n) => String(n || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 150);

// ---------------------------------------------------------------- categories
const catFields = { name: z.string().min(1).max(100), description: nullable(z.string().max(255)), sort_order: z.number().int().min(0).max(9999).optional() };

router.get('/categories', async (req, res) => {
  const t = req.auth.tenantId;
  const mgr = isManager(req);
  const data = await rows(pool, `SELECT c.id, c.name, c.description, c.sort_order,
      (SELECT COUNT(*) FROM documents d WHERE d.tenant_id = c.tenant_id AND d.category_id = c.id) AS documents
    FROM doc_categories c WHERE c.tenant_id = ? ${mgr ? '' : 'AND EXISTS (SELECT 1 FROM doc_category_roles r WHERE r.tenant_id = c.tenant_id AND r.category_id = c.id AND r.role = ?)'}
    ORDER BY c.sort_order, c.name`, mgr ? [t] : [t, req.auth.role]);
  const roles = await rows(pool, 'SELECT category_id, role, can_add FROM doc_category_roles WHERE tenant_id = ?', [t]);
  for (const c of data) {
    c.documents = Number(c.documents);
    const mine = roles.filter((r) => r.category_id === c.id);
    c.can_add = mgr || mine.some((r) => r.role === req.auth.role && r.can_add);
    if (mgr) c.roles = mine.map((r) => ({ role: r.role, can_add: Boolean(r.can_add) }));
  }
  res.json({ data, roles: ROLES });
});

router.post('/categories', manager, validate(z.object(catFields)), async (req, res) => {
  try {
    const [r] = await pool.query('INSERT INTO doc_categories (tenant_id, name, description, sort_order) VALUES (?, ?, ?, ?)', [req.auth.tenantId, req.body.name, req.body.description ?? null, req.body.sort_order ?? 100]);
    await audit(pool, req, 'create', 'doc_categories', r.insertId);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a category with that name');
    throw err;
  }
});

router.patch('/categories/:id', manager, validate(partialOf(catFields)), async (req, res) => {
  const set = setClause(req.body, ['name', 'description', 'sort_order']);
  if (!set) throw bad('No updatable fields supplied');
  try {
    const [r] = await pool.query(`UPDATE doc_categories SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, paramId(req)]);
    if (!r.affectedRows) throw notFound('Category');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('There is already a category with that name');
    throw err;
  }
  res.json({ ok: true });
});

/** Replace the roles for a category. Send every role that should have access; any role left out loses it. */
router.put('/categories/:id/roles', manager, validate(z.object({ roles: z.array(z.object({ role: z.enum(ROLES), can_add: z.boolean().default(false) })).max(ROLES.length) })), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    if (!(await one(conn, 'SELECT id FROM doc_categories WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]))) throw notFound('Category');
    await conn.query('DELETE FROM doc_category_roles WHERE tenant_id = ? AND category_id = ?', [req.auth.tenantId, id]);
    for (const r of new Map(req.body.roles.map((x) => [x.role, x])).values()) {
      await conn.query('INSERT INTO doc_category_roles (tenant_id, category_id, role, can_add) VALUES (?, ?, ?, ?)', [req.auth.tenantId, id, r.role, r.can_add ? 1 : 0]);
    }
    await audit(conn, req, 'roles', 'doc_categories', id, { roles: req.body.roles });
  });
  res.json({ ok: true });
});

router.delete('/categories/:id', manager, async (req, res) => {
  const id = paramId(req);
  const { n } = await one(pool, 'SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND category_id = ?', [req.auth.tenantId, id]);
  if (Number(n)) throw conflict('Move or delete the documents in this category first');
  const [r] = await pool.query('DELETE FROM doc_categories WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
  if (!r.affectedRows) throw notFound('Category');
  await audit(pool, req, 'delete', 'doc_categories', id);
  res.status(204).end();
});

// ---------------------------------------------------------------- documents
const docFields = {
  category_id: z.number().int().positive(),
  title: z.string().min(1).max(150),
  description: nullable(z.string().max(500)),
  require_ack: z.boolean().optional(),
  link_url: nullable(z.string().url().max(500).refine((u) => /^https?:\/\//i.test(u), 'Use a web address that starts with http or https')),
};
const LIST = 'd.id, d.category_id, c.name AS category, d.title, d.description, d.link_url, d.file_name, d.mime_type, d.size_bytes, d.version, d.version_note, d.require_ack, d.text_status, d.uploader, d.created_at, d.updated_at, d.file_at';
const like = (w) => `%${w.replace(/[%_\\]/g, '\\$&')}%`;

router.get('/documents', async (req, res) => {
  const mgr = isManager(req);
  const where = ['d.tenant_id = ?']; const params = [req.auth.tenantId];
  if (!mgr) { where.push('EXISTS (SELECT 1 FROM doc_category_roles r WHERE r.tenant_id = d.tenant_id AND r.category_id = d.category_id AND r.role = ?)'); params.push(req.auth.role); }
  if (req.query.category_id) { where.push('d.category_id = ?'); params.push(Number(req.query.category_id)); }
  let from = 'documents d JOIN doc_categories c ON c.tenant_id = d.tenant_id AND c.id = d.category_id';
  let cols = `${LIST}, (SELECT COUNT(*) FROM document_acks a WHERE a.tenant_id = d.tenant_id AND a.document_id = d.id AND a.version = d.version AND a.user_id = ?) AS accepted_by_me, (SELECT COUNT(*) FROM document_acks a WHERE a.tenant_id = d.tenant_id AND a.document_id = d.id AND a.version = d.version) AS accepted_count`;
  let lead = [req.auth.userId];
  const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length) {
    from += ' LEFT JOIN document_text x ON x.tenant_id = d.tenant_id AND x.document_id = d.id';
    cols += ', CASE WHEN x.content IS NOT NULL AND LOCATE(?, x.content) > 0 THEN SUBSTRING(x.content, GREATEST(LOCATE(?, x.content) - 50, 1), 150) END AS snippet';
    lead = [...lead, words[0], words[0]];
    for (const w of words) { where.push('(d.title LIKE ? OR d.description LIKE ? OR d.file_name LIKE ? OR x.content LIKE ?)'); params.push(like(w), like(w), like(w), like(w)); }
  }
  const data = await rows(pool, `SELECT ${cols} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC, d.id DESC LIMIT 500`, [...lead, ...params]);
  for (const d of data) { d.require_ack = Boolean(d.require_ack); d.accepted_by_me = Boolean(Number(d.accepted_by_me)); d.accepted_count = Number(d.accepted_count); if (!mgr) delete d.accepted_count; }
  for (const d of data) if (d.snippet) d.snippet = `${/^\s/.test(d.snippet) ? '' : '…'}${String(d.snippet).replace(/\s+/g, ' ').trim()}…`;
  res.json({ data });
});

/** Add a document: its details first (and an optional web link). A file is attached next with PUT /documents/:id/file. */
router.post('/documents', validate(z.object(docFields)), async (req, res) => {
  const b = req.body;
  const id = await tx(async (conn) => {
    await needCategory(conn, req, b.category_id, 'add');
    const [r] = await conn.query('INSERT INTO documents (tenant_id, category_id, title, description, link_url, require_ack, uploaded_by, uploader) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.auth.tenantId, b.category_id, b.title, b.description ?? null, b.link_url ?? null, b.require_ack ? 1 : 0, req.auth.userId, await who(conn, req)]);
    await audit(conn, req, 'create', 'documents', r.insertId, { category_id: b.category_id });
    return r.insertId;
  });
  res.status(201).json({ id });
});

router.patch('/documents/:id', validate(partialOf(docFields)), async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await needDocument(conn, req, id, 'add');
    if (req.body.category_id) await needCategory(conn, req, req.body.category_id, 'add');
    const body = { ...req.body }; if (body.require_ack !== undefined) body.require_ack = body.require_ack ? 1 : 0;
    const set = setClause(body, ['category_id', 'title', 'description', 'link_url', 'require_ack']);
    if (!set) throw bad('No updatable fields supplied');
    await conn.query(`UPDATE documents SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, id]);
    await audit(conn, req, 'update', 'documents', id, Object.keys(req.body));
  });
  res.json({ ok: true });
});

/** Whether this mountain has the text-recognition add-on. */
const ocrOn = async (tenantId) => (await require('../lib/modules').enabledKeys(tenantId)).includes('doc_ocr');

/** Read the words out of a document's current file and store them for searching. Never throws: a file that cannot be read is marked failed. */
async function scanDocument(tenantId, id, { ocr = false } = {}) {
  if (ocr && !(await ocrOn(tenantId))) ocr = false; // text recognition is an add-on; without it only files with real text are read
  const d = await one(pool, 'SELECT d.file_name, f.content FROM documents d LEFT JOIN document_files f ON f.tenant_id = d.tenant_id AND f.document_id = d.id WHERE d.tenant_id = ? AND d.id = ?', [tenantId, id]);
  if (!d) return 'none';
  let status = 'none'; let method = null; let text = '';
  if (d.file_name && d.content) {
    try {
      const r = await extract(d.content, d.file_name, { ocr });
      if (r.unsupported) status = 'unsupported';
      else { text = r.text || ''; method = r.method; status = r.needsOcr ? 'needs_ocr' : text ? 'indexed' : 'none'; }
    } catch (err) { status = 'failed'; console.error(`document ${id} could not be scanned: ${err.message}`); }
  }
  await tx(async (conn) => {
    if (text) await conn.query('REPLACE INTO document_text (tenant_id, document_id, content) VALUES (?, ?, ?)', [tenantId, id, text]);
    else await conn.query('DELETE FROM document_text WHERE tenant_id = ? AND document_id = ?', [tenantId, id]);
    await conn.query('UPDATE documents SET text_status = ?, text_method = ? WHERE tenant_id = ? AND id = ?', [status, method, tenantId, id]);
  });
  return status;
}

/** Keep the current file as an earlier version before it is replaced. */
async function archiveCurrent(conn, tenantId, d) {
  if (!d.file_name) return;
  await conn.query(`INSERT INTO document_versions (tenant_id, document_id, version, file_name, mime_type, size_bytes, note, uploaded_by, uploader, uploaded_at, content)
    SELECT d.tenant_id, d.id, d.version, d.file_name, d.mime_type, d.size_bytes, d.version_note, d.uploaded_by, d.uploader, COALESCE(d.file_at, d.created_at), f.content
    FROM documents d JOIN document_files f ON f.tenant_id = d.tenant_id AND f.document_id = d.id WHERE d.tenant_id = ? AND d.id = ?`, [tenantId, d.id]);
}

/** How much of the mountain's document storage is used, in bytes, counting current files and every earlier version. */
async function storageUsed(conn, tenantId) {
  const a = await one(conn, 'SELECT COALESCE(SUM(size_bytes), 0) AS b FROM documents WHERE tenant_id = ?', [tenantId]);
  const b = await one(conn, 'SELECT COALESCE(SUM(size_bytes), 0) AS b FROM document_versions WHERE tenant_id = ?', [tenantId]);
  return Number(a.b) + Number(b.b);
}
/** Refuse a file that would take the mountain past its storage limit. The mountain's row is locked while we count so two uploads cannot both squeeze in. */
async function checkRoom(conn, tenantId, adding) {
  const t = await one(conn, 'SELECT storage_cap_mb FROM tenants WHERE id = ? FOR UPDATE', [tenantId]);
  const cap = Number(t.storage_cap_mb) * 1048576;
  const used = await storageUsed(conn, tenantId);
  if (used + adding > cap) {
    const mb = (n) => (n / 1048576).toFixed(1);
    throw new AppError(413, `Your document storage is full (${mb(used)} of ${t.storage_cap_mb} MB used, and this file is ${mb(adding)} MB). Delete documents you no longer need, or ask Verdynt/OS to raise your limit.`);
  }
}

/** Store a file as the document's newest version. */
async function storeFile(conn, req, d, { buf, name, mime, note }) {
  await checkRoom(conn, req.auth.tenantId, buf.length);
  if (d.file_name && d.version >= MAX_VERSIONS) throw conflict(`This document has reached ${MAX_VERSIONS} versions, the most we keep. Add the new file as a new document instead.`);
  await archiveCurrent(conn, req.auth.tenantId, d);
  const version = d.file_name ? d.version + 1 : d.version;
  await conn.query('REPLACE INTO document_files (tenant_id, document_id, content) VALUES (?, ?, ?)', [req.auth.tenantId, d.id, buf]);
  await conn.query("UPDATE documents SET file_name = ?, mime_type = ?, size_bytes = ?, version = ?, version_note = ?, uploaded_by = ?, uploader = ?, file_at = CURRENT_TIMESTAMP, text_status = 'pending', text_method = NULL WHERE tenant_id = ? AND id = ?",
    [name, mime, buf.length, version, note || null, req.auth.userId, await who(conn, req), req.auth.tenantId, d.id]);
  await conn.query('DELETE FROM document_text WHERE tenant_id = ? AND document_id = ?', [req.auth.tenantId, d.id]);
  await audit(conn, req, d.file_name ? 'replace_file' : 'add_file', 'documents', d.id, { name, bytes: buf.length, version });
  return version;
}

/** Attach or replace the file. The body is the raw file; the name travels in the x-filename header and an optional "what changed"
 * note in x-note. Replacing keeps the old file as an earlier version, up to 10 versions in all. */
router.put('/documents/:id/file', express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
  const id = paramId(req);
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw bad('No file was sent');
  if (buf.length > MAX_BYTES) throw bad('Files can be up to 10 MB');
  let name = cleanName(decodeURIComponent(String(req.get('x-filename') || 'file')));
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!TYPES[ext]) throw bad(`That file type is not allowed. Use ${Object.keys(TYPES).join(', ')}.`);
  if (ext === 'pdf' && buf.slice(0, 5).toString() !== '%PDF-') throw bad('That file does not look like a PDF');
  if (!contentMatches(ext, buf)) throw bad(`That file is not a real .${ext} file, or it carries macros. Save it again as a plain .${ext} and upload that.`);
  name = name || `file.${ext}`;
  const note = req.get('x-note') ? decodeURIComponent(String(req.get('x-note'))).trim().slice(0, 200) : null;
  const version = await tx(async (conn) => storeFile(conn, req, await lockDocument(conn, req, id), { buf, name, mime: TYPES[ext], note }));
  const text_status = await scanDocument(req.auth.tenantId, id, { ocr: false });
  res.status(201).json({ ok: true, version, max_versions: MAX_VERSIONS, text_status });
});

async function lockDocument(conn, req, id) {
  const d = await needDocument(conn, req, id, 'add');
  return one(conn, 'SELECT * FROM documents WHERE tenant_id = ? AND id = ? FOR UPDATE', [req.auth.tenantId, d.id]);
}

function sendFile(res, row, { inline }) {
  res.set({ 'content-type': row.mime_type, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${cleanName(row.file_name)}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store', 'content-security-policy': "default-src 'none'; sandbox" });
  res.send(row.content);
}

router.get('/documents/:id/file', async (req, res) => {
  const id = paramId(req);
  const d = await needDocument(pool, req, id, 'view');
  if (!d.file_name) throw notFound('File');
  const f = await one(pool, 'SELECT content FROM document_files WHERE tenant_id = ? AND document_id = ?', [req.auth.tenantId, id]);
  if (!f) throw notFound('File');
  sendFile(res, { ...d, content: f.content }, { inline: INLINE.has(d.mime_type) && req.query.download !== '1' });
});

// ---------------------------------------------------------------- earlier versions
router.get('/documents/:id/versions', async (req, res) => {
  const id = paramId(req);
  const d = await needDocument(pool, req, id, 'view');
  const old = await rows(pool, 'SELECT version, file_name, mime_type, size_bytes, note, uploader, uploaded_at FROM document_versions WHERE tenant_id = ? AND document_id = ? ORDER BY version DESC', [req.auth.tenantId, id]);
  res.json({
    max: MAX_VERSIONS, can_add: (await accessTo(pool, req, d.category_id)) === 'add',
    current: d.file_name ? { version: d.version, file_name: d.file_name, mime_type: d.mime_type, size_bytes: d.size_bytes, note: d.version_note, uploader: d.uploader, uploaded_at: d.file_at || d.created_at, current: true } : null,
    earlier: old,
  });
});

router.get('/documents/:id/versions/:v/file', async (req, res) => {
  const id = paramId(req);
  await needDocument(pool, req, id, 'view');
  const v = await one(pool, 'SELECT file_name, mime_type, content FROM document_versions WHERE tenant_id = ? AND document_id = ? AND version = ?', [req.auth.tenantId, id, Number(req.params.v)]);
  if (!v) throw notFound('Version');
  sendFile(res, v, { inline: INLINE.has(v.mime_type) && req.query.download !== '1' });
});

/** Bring an earlier version back. It becomes the newest version, so nothing later is lost. */
router.post('/documents/:id/versions/:v/restore', async (req, res) => {
  const id = paramId(req);
  const n = Number(req.params.v);
  const version = await tx(async (conn) => {
    const d = await lockDocument(conn, req, id);
    const v = await one(conn, 'SELECT file_name, mime_type, content FROM document_versions WHERE tenant_id = ? AND document_id = ? AND version = ?', [req.auth.tenantId, id, n]);
    if (!v) throw notFound('Version');
    return storeFile(conn, req, d, { buf: v.content, name: v.file_name, mime: v.mime_type, note: `Restored version ${n}` });
  });
  const text_status = await scanDocument(req.auth.tenantId, id, { ocr: false });
  res.json({ ok: true, version, text_status });
});

// ---------------------------------------------------------------- searching inside files
/** How many documents can be searched by their contents. */
router.get('/scan-status', async (req, res) => {
  const mgr = isManager(req);
  const data = await rows(pool, `SELECT d.text_status AS status, COUNT(*) AS n FROM documents d WHERE d.tenant_id = ? AND d.file_name IS NOT NULL
    ${mgr ? '' : 'AND EXISTS (SELECT 1 FROM doc_category_roles r WHERE r.tenant_id = d.tenant_id AND r.category_id = d.category_id AND r.role = ?)'} GROUP BY d.text_status`, mgr ? [req.auth.tenantId] : [req.auth.tenantId, req.auth.role]);
  const counts = Object.fromEntries(data.map((r) => [r.status, Number(r.n)]));
  const ocr = await ocrOn(req.auth.tenantId);
  res.json({ counts, total: Object.values(counts).reduce((a, b) => a + b, 0), ocr, waiting: (counts.pending || 0) + (ocr ? counts.needs_ocr || 0 : 0) });
});

/** Scan one document now, including reading pictures of text. */
router.post('/documents/:id/scan', async (req, res) => {
  const id = paramId(req);
  await needDocument(pool, req, id, 'add');
  res.json({ text_status: await scanDocument(req.auth.tenantId, id, { ocr: true }) });
});

/** Scan a few waiting documents (a manager calls this again and again until none are left). rescan: true queues every file again. */
router.post('/scan', manager, validate(z.object({ limit: z.number().int().min(1).max(10).default(3), rescan: z.boolean().default(false) })), async (req, res) => {
  const t = req.auth.tenantId;
  if (req.body.rescan) await pool.query("UPDATE documents SET text_status = 'pending' WHERE tenant_id = ? AND file_name IS NOT NULL", [t]);
  const ocr = await ocrOn(t);
  const waiting = ocr ? "('pending','needs_ocr')" : "('pending')";
  const next = await rows(pool, `SELECT id FROM documents WHERE tenant_id = ? AND file_name IS NOT NULL AND text_status IN ${waiting} ORDER BY id LIMIT ?`, [t, req.body.limit]);
  const done = {};
  for (const d of next) { const s = await scanDocument(t, d.id, { ocr: true }); done[s] = (done[s] || 0) + 1; }
  const { n } = await one(pool, `SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ? AND file_name IS NOT NULL AND text_status IN ${waiting}`, [t]);
  if (next.length) await audit(pool, req, 'scan', 'documents', null, { scanned: next.length });
  res.json({ scanned: next.length, results: done, remaining: Number(n) });
});

router.get('/storage', async (req, res) => {
  const t = await one(pool, 'SELECT storage_cap_mb FROM tenants WHERE id = ?', [req.auth.tenantId]);
  const used = await storageUsed(pool, req.auth.tenantId);
  res.json({ used_mb: Math.round((used / 1048576) * 10) / 10, cap_mb: Number(t.storage_cap_mb), percent: Math.min(100, Math.round((used / (t.storage_cap_mb * 1048576)) * 100)) });
});

/** "I have read this." Counts for the current version only, so a new version asks everyone again. */
router.post('/documents/:id/accept', async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    const d = await needDocument(conn, req, id, 'view');
    if (!d.require_ack) throw bad('This document does not ask for acceptance');
    await conn.query('INSERT IGNORE INTO document_acks (tenant_id, document_id, version, user_id, who) VALUES (?, ?, ?, ?, ?)', [req.auth.tenantId, id, d.version, req.auth.userId, await who(conn, req)]);
    await audit(conn, req, 'accept', 'documents', id, { version: d.version });
  });
  res.json({ ok: true });
});

/** Who has and has not accepted the current version: everyone who can see the category, plus managers and owners. */
router.get('/documents/:id/acceptances', manager, async (req, res) => {
  const id = paramId(req);
  const d = await needDocument(pool, req, id, 'view');
  const people = await rows(pool, `SELECT u.id AS user_id, u.email, u.role, COALESCE(NULLIF(CONCAT(p.first_name, ' ', p.last_name), ' '), u.email, u.username) AS name, a.accepted_at
      FROM users u LEFT JOIN people p ON p.tenant_id = u.tenant_id AND p.id = u.person_id
      LEFT JOIN document_acks a ON a.tenant_id = u.tenant_id AND a.document_id = ? AND a.version = ? AND a.user_id = u.id
     WHERE u.tenant_id = ? AND u.active = 1
       AND (u.role IN ('owner','manager') OR EXISTS (SELECT 1 FROM doc_category_roles r WHERE r.tenant_id = u.tenant_id AND r.category_id = ? AND r.role = u.role))
     ORDER BY a.accepted_at IS NULL DESC, name`, [id, d.version, req.auth.tenantId, d.category_id]);
  res.json({ version: d.version, require_ack: Boolean(d.require_ack), data: people, waiting: people.filter((x) => !x.accepted_at).length });
});

router.delete('/documents/:id', async (req, res) => {
  const id = paramId(req);
  await tx(async (conn) => {
    await needDocument(conn, req, id, 'add');
    await conn.query('DELETE FROM documents WHERE tenant_id = ? AND id = ?', [req.auth.tenantId, id]);
    await audit(conn, req, 'delete', 'documents', id);
  });
  res.status(204).end();
});

module.exports = router;
