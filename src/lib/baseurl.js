'use strict';

const config = require('../config');

/**
 * The public address of this service, for links in emails. PUBLIC_URL, which production must have (config.js refuses to
 * start without it, 2026.11.11), so a link in a reset or family email never comes from a Host header someone sent. Only
 * local runs and tests, where PUBLIC_URL is often unset, fall back to the address the request came in on.
 */
const baseUrl = (req) => config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`;

module.exports = { baseUrl };
