'use strict';

const express = require('express');
const { rows, one, pool } = require('../db');
const { requireRole } = require('../middleware/auth');
const { notFound, bad } = require('./errors');
const { validate, paramId, setClause } = require('./util');
const { audit } = require('./audit');

/**
 * Builds a tenant-scoped REST resource for a simple table:
 *   GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
 * Every statement carries tenant_id taken from the verified token.
 */
function crud({ table, entity, createSchema, updateSchema, columns, filters = [], orderBy = 'id', readRoles = [], writeRoles = ['manager'], writeGuard: guard = null, allowDelete = true, search }) {
  const router = express.Router();
  const readGuard = readRoles === 'any' ? (_q, _s, n) => n() : requireRole(...readRoles, ...writeRoles);
  const writeGuard = guard || requireRole(...writeRoles); // guard: a route's own write check (Products: the school director, lessons only)

  router.get('/', readGuard, async (req, res) => {
    const where = ['tenant_id = ?'];
    const params = [req.auth.tenantId];
    const first = (v) => String(Array.isArray(v) ? v[0] : v);
    for (const f of filters) {
      if (req.query[f] !== undefined && req.query[f] !== '') {
        where.push(`\`${f}\` = ?`);
        params.push(first(req.query[f]));
      }
    }
    if (search && req.query.q) {
      where.push(`(${search.map((c) => `\`${c}\` LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < search.length; i++) params.push(`%${first(req.query.q)}%`);
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const data = await rows(pool, `SELECT * FROM \`${table}\` WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data, limit, offset });
  });

  router.get('/:id', readGuard, async (req, res) => {
    const row = await one(pool, `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, paramId(req)]);
    if (!row) throw notFound(entity);
    res.json(row);
  });

  router.post('/', writeGuard, validate(createSchema), async (req, res) => {
    const keys = Object.keys(req.body).filter((k) => columns.includes(k));
    const sql = `INSERT INTO \`${table}\` (tenant_id, ${keys.map((k) => `\`${k}\``).join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})`;
    const [result] = await pool.query(sql, [req.auth.tenantId, ...keys.map((k) => req.body[k])]);
    await audit(pool, req, 'create', table, result.insertId);
    const row = await one(pool, `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, result.insertId]);
    res.status(201).json(row);
  });

  router.patch('/:id', writeGuard, validate(updateSchema), async (req, res) => {
    const set = setClause(req.body, columns);
    if (!set) throw bad('No updatable fields supplied');
    const rowId = paramId(req);
    const [result] = await pool.query(`UPDATE \`${table}\` SET ${set.sql} WHERE tenant_id = ? AND id = ?`, [...set.values, req.auth.tenantId, rowId]);
    if (!result.affectedRows) throw notFound(entity);
    await audit(pool, req, 'update', table, rowId, req.body);
    res.json(await one(pool, `SELECT * FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, rowId]));
  });

  if (allowDelete) {
    router.delete('/:id', writeGuard, async (req, res) => {
      const rowId = paramId(req);
      const [result] = await pool.query(`DELETE FROM \`${table}\` WHERE tenant_id = ? AND id = ?`, [req.auth.tenantId, rowId]);
      if (!result.affectedRows) throw notFound(entity);
      await audit(pool, req, 'delete', table, rowId);
      res.status(204).end();
    });
  }

  return router;
}

module.exports = { crud };
