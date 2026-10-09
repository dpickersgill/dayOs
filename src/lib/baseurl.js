'use strict';

const config = require('../config');

/** The public address of this service, for links in emails. PUBLIC_URL wins; otherwise the address the request came in on. */
const baseUrl = (req) => config.stripe.publicUrl || `${req.protocol}://${req.get('host')}`;

module.exports = { baseUrl };
