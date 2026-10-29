'use strict';

// The ski school, round 2: the 9:45 lineup, check-in and the counter (Track LINEUP).
// router is mounted at /skischool (staff); publicRouter under /public (no sign-in).
// tick() runs every few minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');

const router = express.Router();
const publicRouter = express.Router();

async function tick() { return {}; }
async function daily() { return {}; }

module.exports = { router, publicRouter, tick, daily };
