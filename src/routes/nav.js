'use strict';

// The menu's own two questions (release 2026.11.21), asked by public/js/navcounts.js and public/js/newmenu.js:
//   GET /nav/counts -> { counts: { <view key>: { n, says, alert? } } }   what waits on this person, per app
//   GET /nav/new    -> { items: [<item id>] }                            what this person may create ("+ New")
// Any signed-in person may ask, for any kind of tenant: the path belongs to no app (lib/modules.js), and each count and
// item checks its own app and role (lib/navcounts.js). The tenant and the person come from the sign-in only.
const express = require('express');
const N = require('../lib/navcounts');

const router = express.Router();

router.get('/counts', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ counts: await N.countsFor(req) });
});

router.get('/new', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ items: await N.creatable(req) });
});

module.exports = router;
