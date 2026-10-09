'use strict';

// Patrol access levels and the features each one can use.
//
//   admin     everything, including who has which level and what each level can do
//   manager   runs the team day to day: roster, posts, equipment, training, reports
//   approver  signs off reports and follow-up emails
//   patrol    works cases in the field
//   host      guest-facing helper: sees the map and the day's posts and logs trail checks, never case or patient details
//
// A mountain's owner and system managers always have every feature, so nobody can be locked out.
// An admin can switch features on or off per level; a level/feature with no saved choice follows DEFAULTS.
const { one, rows } = require('../db');
const { forbidden } = require('./errors');

const LEVELS = ['admin', 'manager', 'approver', 'patrol', 'host'];
const LEVEL_LABEL = { admin: 'Admin', manager: 'Manager', approver: 'Approver', patrol: 'Patrol', host: 'Host' };
const LEVEL_ABOUT = {
  admin: 'Everything, including who has which level.',
  manager: 'Runs the team: roster, posts, equipment and training.',
  approver: 'Signs off reports and follow-up emails.',
  patrol: 'Works cases in the field.',
  host: 'Helps guests. No case or patient details.',
};

// [key, label, what it lets a person do, group]
const FEATURES = [
  ['view_cases', 'See cases', 'Open the case list, a case and its patients.', 'Cases'],
  ['create_case', 'Write cases', 'Start a case, add patients, vitals, treatment and notes, and look up a guest.', 'Cases'],
  ['submit_case', 'Submit reports', 'Send a finished report for approval.', 'Cases'],
  ['approve_case', 'Approve reports', 'Approve a submitted report or reopen an approved one.', 'Cases'],
  ['reports', 'Reports and exports', 'See analytics and download case and patient CSV files.', 'Cases'],
  ['dispatch', 'Dispatch board', 'Log calls, send responders and turn a call into a case.', 'Calls'],
  ['trail_checks', 'Trail checks', 'Record a trail check and its hazards.', 'Calls'],
  ['followups', 'Follow-up emails', 'Approve, skip or send the emails to patients, and set how they work.', 'Cases'],
  ['manage_team', 'Roster', 'Add, change and remove patrol team members.', 'Team'],
  ['assign_posts', "Today's posts", 'Set who is posted where today.', 'Team'],
  ['manage_equipment', 'Equipment and stations', 'Add and change equipment and stations, and clear flagged items.', 'Team'],
  ['manage_training', 'Training', "Edit competencies and record or remove anyone's training.", 'Team'],
  ['manage_settings', 'Form, map and guest help', 'Choose mandatory fields, set where the map opens and edit the guest help page.', 'Settings'],
  ['view_access_log', 'Access log', 'Read who looked at which patient record.', 'Settings'],
];
const KEYS = FEATURES.map((f) => f[0]);

const grant = (...levels) => new Set(levels);
const DEFAULTS = {
  view_cases: grant('admin', 'manager', 'approver', 'patrol'),
  create_case: grant('admin', 'manager', 'approver', 'patrol'),
  submit_case: grant('admin', 'manager', 'approver', 'patrol'),
  approve_case: grant('admin', 'approver'),
  reports: grant('admin', 'manager', 'approver'),
  dispatch: grant('admin', 'manager', 'approver', 'patrol'),
  trail_checks: grant('admin', 'manager', 'approver', 'patrol', 'host'),
  followups: grant('admin', 'approver'),
  manage_team: grant('admin', 'manager'),
  assign_posts: grant('admin', 'manager'),
  manage_equipment: grant('admin', 'manager'),
  manage_training: grant('admin', 'manager'),
  manage_settings: grant('admin'),
  view_access_log: grant('admin'),
};

/** The level a roster rank starts with when nobody has chosen one. */
const levelForRank = (rank) => ({ director: 'admin', leader: 'manager' }[rank] || 'patrol');

const isSystemAdmin = (req) => ['owner', 'manager'].includes(req.auth.role);

/** The person's patrol access level: admin for owners and managers; the roster record for patrol logins. */
async function levelOf(pool, req) {
  if (isSystemAdmin(req)) return 'admin';
  if (req.auth.role !== 'patrol') return null;
  if (!req.auth.staffId) return 'patrol';
  const m = await one(pool, 'SELECT access_level FROM patrol_members WHERE tenant_id = ? AND staff_id = ?', [req.auth.tenantId, req.auth.staffId]);
  return m ? m.access_level : 'patrol';
}

/** The saved choices for a mountain, as { 'level|feature': true/false }. */
async function savedRules(pool, tenantId) {
  const out = {};
  for (const r of await rows(pool, 'SELECT level, feature, allowed FROM patrol_access_rules WHERE tenant_id = ?', [tenantId])) out[`${r.level}|${r.feature}`] = Boolean(r.allowed);
  return out;
}

/** The full table for a mountain: matrix[level][feature] = true/false. Admin is always everything. */
async function matrix(pool, tenantId) {
  const saved = await savedRules(pool, tenantId);
  const out = {};
  for (const level of LEVELS) {
    out[level] = {};
    for (const key of KEYS) {
      if (level === 'admin') { out[level][key] = true; continue; }
      const k = `${level}|${key}`;
      out[level][key] = k in saved ? saved[k] : DEFAULTS[key].has(level);
    }
  }
  return out;
}

/** The features this request's person has: { level, features: Set }. */
async function accessOf(pool, req) {
  const level = await levelOf(pool, req);
  if (!level) return { level: null, features: new Set() };
  if (level === 'admin') return { level, features: new Set(KEYS) };
  const m = await matrix(pool, req.auth.tenantId);
  return { level, features: new Set(KEYS.filter((k) => m[level][k])) };
}

const can = async (pool, req, feature) => (await accessOf(pool, req)).features.has(feature);

/** Route guard: the person must be signed in with a patrol-capable role and have the feature. */
function needs(pool, feature, message) {
  if (!KEYS.includes(feature)) throw new Error(`Unknown patrol feature "${feature}"`);
  return async (req, _res, next) => {
    try {
      if (!(await can(pool, req, feature))) throw forbidden(message || 'Your patrol access level cannot do that');
      next();
    } catch (err) { next(err); }
  };
}

module.exports = { LEVELS, LEVEL_LABEL, LEVEL_ABOUT, FEATURES, KEYS, DEFAULTS, levelForRank, levelOf, matrix, accessOf, can, needs, isSystemAdmin };
