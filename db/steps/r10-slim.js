'use strict';

// 2026.11.10, SLIM: a text message STOP finds the customer by phone number at every mountain (src/routes/twilioinbound.js),
// so people.phone_key gets an index of its own.
module.exports = () => [
  ['people phone_key alone index', async (c) => {
    const [r] = await c.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'people' AND index_name = 'ix_people_phone_any' LIMIT 1");
    return r.length > 0;
  }, 'ALTER TABLE people ADD KEY ix_people_phone_any (phone_key)'],
];
