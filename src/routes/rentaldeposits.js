'use strict';

// Card deposits on the counter's card reader: hold the deposit (a short day rental) or save the card (a long or season
// rental), watch the reader, release it when the gear is back, take fees from it after staff confirm, and fall back to a
// note deposit when the card service or the reader cannot be used. The rules and the Stripe findings are in
// lib/rentaldeposit.js. Mounted inside routes/rentals.js.
const express = require('express');
const { requireRole } = require('../middleware/auth');
const { z, validate, paramId } = require('../lib/util');
const { notFound } = require('../lib/errors');
const D = require('../lib/rentaldeposit');

const router = express.Router();
const counter = ['counter', 'manager'];

/** Whether a card deposit can be taken now (card service set up, a reader paired), for the counter to choose. */
router.get('/deposits/ready', requireRole(...counter), async (req, res) => res.json(await D.readiness(req.auth.tenantId)));

router.post('/contracts/:id/deposit', requireRole(...counter), validate(z.object({ reader_id: z.number().int().positive(), amount_cents: z.number().int().min(0).max(1_000_000) })), async (req, res) => {
  res.status(201).json(await D.start(req, paramId(req), req.body));
});

router.get('/deposits/:id', requireRole(...counter), async (req, res) => {
  const row = await D.rowOf(req.auth.tenantId, paramId(req));
  if (!row) throw notFound('Deposit');
  res.json(D.shape(await D.settle(row)));
});

router.post('/deposits/:id/simulate', requireRole(...counter), validate(z.object({ outcome: z.enum(['approve', 'decline']).default('approve') })), async (req, res) => {
  res.json(await D.simulate(req, paramId(req), req.body.outcome));
});

router.post('/deposits/:id/cancel', requireRole(...counter), async (req, res) => res.json(await D.cancel(req, paramId(req))));

router.post('/contracts/:id/deposit/note', requireRole(...counter), validate(z.object({ amount_cents: z.number().int().min(0).max(1_000_000), note: z.string().max(200).optional() })), async (req, res) => {
  res.status(201).json(await D.noteDeposit(req, paramId(req), req.body.amount_cents, req.body.note));
});

/** Takes the fees owed from the card deposit (staff confirm first; loss fees and gear still out need a manager). */
router.post('/contracts/:id/deposit/take', requireRole(...counter), async (req, res) => res.json(await D.take(req, paramId(req))));

/** A rental extended past the end of its card hold: let the hold go and save the card on the reader instead. */
router.post('/contracts/:id/deposit/switch', requireRole(...counter), validate(z.object({ reader_id: z.number().int().positive() })), async (req, res) => {
  res.status(201).json(await D.switchToSaved(req, paramId(req), req.body));
});

router.post('/contracts/:id/deposit/release', requireRole(...counter), async (req, res) => res.json(await D.release(req, paramId(req))));

module.exports = router;
