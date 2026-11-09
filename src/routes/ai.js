'use strict';

// Prepared actions (AI release 1): what the assistant has drafted for this person to approve, and the conditions writer.
//   GET  /ai/proposals                    the drafts waiting for this person (their role and apps decide)
//   POST /ai/proposals/:id/approve        { edits? }: approve, with this person's changes, and do it as them
//   POST /ai/proposals/:id/reject         Not now
//   POST /ai/conditions/draft             Draft now (Mountain status)
//   GET  /ai/conditions/settings          when the morning draft is made, and the mountain's past reports for its voice
//   PUT  /ai/conditions/settings          managers
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { rateLimit } = require('../middleware/rateLimit');
const proposals = require('../lib/proposals');
const writer = require('../lib/conditionswriter'); // registers the conditions_update kind
const modulesLib = require('../lib/modules');

const router = express.Router();

router.get('/proposals', async (req, res) => {
  res.json({ data: await proposals.list(pool, req) });
});

router.post('/proposals/:id/approve', validate(z.object({ edits: z.record(z.string(), z.union([z.string().max(5000), z.boolean()])).optional() })), async (req, res) => {
  res.json(await proposals.approve(pool, req, paramId(req), req.body.edits));
});

router.post('/proposals/:id/reject', async (req, res) => {
  res.json(await proposals.reject(pool, req, paramId(req)));
});

// Each draft is a model call that counts against the mountain's monthly allowance: a few an hour per person is plenty.
const draftLimit = rateLimit({ name: 'conditions-draft', windowMs: 3_600_000, max: Number(process.env.CONDITIONS_DRAFT_LIMIT) || 6, message: 'That is a lot of drafts. Wait a while, or edit the last one.', keyOf: (req) => `${req.auth.tenantId}:${req.auth.userId}` });
router.post('/conditions/draft', draftLimit, async (req, res) => {
  const out = await writer.draftNow(req);
  res.status(201).json(out);
});

router.get('/conditions/settings', requireRole('manager', 'staff'), async (req, res) => {
  const on = new Set(await modulesLib.enabledKeys(req.auth.tenantId));
  res.json({ ...(await writer.settingsOf(pool, req.auth.tenantId)), available: writer.NEEDS.every((k) => on.has(k)) });
});

router.put('/conditions/settings', requireRole('manager'), validate(z.object({
  auto_on: z.boolean().optional(),
  draft_at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 07:00').optional(),
  voice: z.array(z.string().max(2000)).max(5).optional(),
})), async (req, res) => {
  res.json(await writer.saveSettings(pool, req, req.body));
});

module.exports = router;
