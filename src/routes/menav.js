'use strict';

// A person's own pins (2026.11.21): the top of their menu, under "Pinned", and the four pages on their phone's bar.
//   GET    /me/nav   { pins, bar, custom, standard }   standard: their role's starting pins
//   PUT    /me/nav   { pins, bar }                     their own list (lib/menus.js checkNav says what a pin may be)
//   DELETE /me/nav                                     back to their role's menu
// With nothing saved, the pins are the role's menu as the owner set it (Settings, Team and logins, Menus for each role),
// so a change there keeps reaching everyone who has not made their own. Kept in user_nav, one row for a person, always
// read and written by tenant AND person from the session: nobody reaches anyone else's. A shared counter computer (a
// session opened by PIN) always shows the role's pins and saves nothing, so the next person at the counter finds the
// menu they expect. The ski area's read-only login has no pins. Arranging your own menu is not in the audit log.
// Mounted after the app gate and never part of an app (no path in lib/modules.js), so every kind of tenant reaches it.

const express = require('express');
const { pool, one } = require('../db');
const { TIER_SQL } = require('../middleware/auth');
const { z, validate } = require('../lib/util');
const { forbidden, bad, unauthorized } = require('../lib/errors');
const moduleGate = require('../lib/modules');
const menus = require('../lib/menus');

const router = express.Router();

const NO_PINS = { pins: [], bar: null, custom: false };
const ON_TERMINAL = 'This is a shared computer, so its menu stays the same for everyone with your role. Sign in on your own phone or computer to change your pins.';
const AREA = 'The ski area login has one page and no pins.';

/**
 * The pins for this session, from what /auth/me already knows about the person (so it asks the database for one row).
 * who: { role, org, modules, onPatrol, schoolAccess, menu } with menu the role's menu (menuFor or muniMenuFor).
 * Returns { pins, bar, custom, standard }.
 */
async function navOf(auth, who) {
  if (who.role === 'area' || !who.menu) return { ...NO_PINS, standard: [] };
  const may = menus.viewsFor(who);
  const standard = menus.startingPins(who.menu, may);
  // A shared counter computer never shows one person's own pins.
  const row = auth.terminalId ? null : await one(pool, 'SELECT pins, bar FROM user_nav WHERE tenant_id = ? AND user_id = ?', [auth.tenantId, auth.userId]);
  return { ...menus.navFrom(row, standard, may), standard };
}

/** Who is asking, as /auth/me works it out: their role, the kind of tenant, the apps that are on, and their role's menu. */
async function whoIs(auth) {
  const user = await one(pool,
    `SELECT u.role, u.staff_id, t.role_menus, t.org_type, ${TIER_SQL}
       FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.tenant_id = ?`, [auth.userId, auth.tenantId]);
  if (!user) throw unauthorized();
  const muni = user.org_type === 'municipality';
  let positions = [];
  if (!muni && user.staff_id && menus.POSITION_ROLES.includes(user.role)) {
    const [list] = await pool.query(
      `SELECT p.id, p.name, p.department FROM staff_positions sp JOIN positions p ON p.tenant_id = sp.tenant_id AND p.id = sp.position_id
        WHERE sp.tenant_id = ? AND sp.staff_id = ? ORDER BY p.name, p.id`, [auth.tenantId, user.staff_id]);
    positions = list.map((p) => ({ id: Number(p.id), name: p.name, department: p.department }));
  }
  const menu = muni ? menus.muniMenuFor(user.role) : menus.menuFor(user.role, user.role_menus, user.school_access, { patrolLead: Boolean(Number(user.patrol_lead)), positions });
  return { role: user.role, org: muni ? 'municipality' : 'mountain', modules: await moduleGate.enabledKeys(auth.tenantId), onPatrol: Boolean(auth.onPatrol), schoolAccess: user.school_access || null, menu };
}

/** The ski area's read-only login has no pins at all. */
const notArea = (req, _res, next) => (req.auth.role === 'area' ? next(forbidden(AREA)) : next());
/** A session opened by PIN on a shared computer keeps the role's pins. */
const ownDevice = (req, _res, next) => (req.auth.terminalId ? next(forbidden(ON_TERMINAL)) : next());

router.get('/', notArea, async (req, res) => {
  res.set('cache-control', 'no-store');
  res.json(await navOf(req.auth, await whoIs(req.auth)));
});

// The shape only, with room to spare: the limits a person can run into (12 pins, a 40-character name, what a page
// address may be, the bar's four) are checked by menus.checkNav, which answers in plain words.
const PIN = z.object({ id: z.string().max(80), label: z.string().max(400), href: z.string().max(2000), app: z.string().max(80).optional(), icon: z.string().max(80).nullable().optional() });
const BAR_ITEM = z.union([z.string().max(2000), z.object({ href: z.string().max(2000), label: z.string().max(400).optional(), app: z.string().max(80).optional(), icon: z.string().max(80).nullable().optional() })]);
router.put('/', notArea, ownDevice, validate(z.object({ pins: z.array(PIN).max(100), bar: z.array(BAR_ITEM).max(20).nullable().optional() })), async (req, res) => {
  const who = await whoIs(req.auth);
  const may = menus.viewsFor(who);
  const r = menus.checkNav(req.body, may);
  if (r.problem) throw bad(r.problem);
  await pool.query(
    'INSERT INTO user_nav (tenant_id, user_id, pins, bar) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE pins = VALUES(pins), bar = VALUES(bar)',
    [req.auth.tenantId, req.auth.userId, JSON.stringify(r.pins), r.bar ? JSON.stringify(r.bar) : null]);
  res.json(await navOf(req.auth, who));
});

router.delete('/', notArea, ownDevice, async (req, res) => {
  await pool.query('DELETE FROM user_nav WHERE tenant_id = ? AND user_id = ?', [req.auth.tenantId, req.auth.userId]);
  res.json(await navOf(req.auth, await whoIs(req.auth)));
});

module.exports = { router, navOf };
