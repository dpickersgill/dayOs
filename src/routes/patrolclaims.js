'use strict';
// Claim files, documentation score, season risk report and insurer sharing. Mounted at /patrol (router) and /public (publicRouter).
const express = require('express');
const router = express.Router();
const publicRouter = express.Router();
module.exports = { router, publicRouter };
