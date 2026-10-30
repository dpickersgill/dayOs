'use strict';
// Lesson planning, best of breed (2026.11.9), Track STAFF. router is mounted at /skischool (staff).
// tick() runs every 5 minutes (POST /jobs/lessons) and daily() once a day (POST /jobs/daily): return a small summary.
const express = require('express');

const router = express.Router();

async function tick() { return {}; }
async function daily() { return {}; }

module.exports = { router, tick, daily };
