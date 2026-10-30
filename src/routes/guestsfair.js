'use strict';
// Guests, round 2, Track FAIR. router is mounted at /guests (staff); publicRouter under /public (no sign-in).
// tick() runs every 5 minutes (POST /internal/jobs/guests) and daily() in the daily job: return a small summary.
const express = require('express');

const router = express.Router();
const publicRouter = express.Router();
async function tick() { return {}; }
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily };
