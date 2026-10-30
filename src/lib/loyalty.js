'use strict';
// Loyalty and memories (Track LOYALTY fills this in): badges for the welcome-back card, birthdays, milestones, loyalty
// rules, recaps. The welcome-back card calls badgesFor; it must stay fast (a few queries) and never throw.

/** Short lines for the welcome-back card, for example [{ kind: 'birthday', text: 'Birthday this week' }]. */
async function badgesFor(_db, _tenantId, _personId, _day) { return []; }

module.exports = { badgesFor };
