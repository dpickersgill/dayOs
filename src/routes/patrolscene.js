'use strict';
// Witness statements by link and the scene diagram. Mounted at /patrol (router) and /public (publicRouter).
const express = require('express');
const router = express.Router();
const publicRouter = express.Router();
module.exports = { router, publicRouter };
