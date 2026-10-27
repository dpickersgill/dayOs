'use strict';
// Pricing review (Oct 2026). Loaded by db/migrate.js. Each entry: [name, (conn) => Promise<boolean> already done, ddl].
//
// Season billing: the yearly price paid in six monthly payments, November to April, with nothing to pay May to October.
// Stripe needs its own monthly price for it (a sixth of the yearly price), kept beside the monthly and yearly ones.
//
// The launch prices change once, with the new columns, and only where they are still the launch values, so anything the
// operator already changed in the console is left alone:
//   - Resort includes Assets and fleet and Messages, so it costs less than building it from Mountain and add-ons.
//   - The Patrol add-on is the same price as Patrol on its own ($149 a month, $1,500 a year).
const RESORT_AT_LAUNCH = 'sell,catalog,gate,conditions,documents,rentals,school,availability,programs,workforce,money,patrol,park,shop';

module.exports = ({ columnExists }) => [
  ['billing: season billing, and the Resort and Patrol price changes', (c) => columnExists(c, 'billing_plans', 'stripe_season'), [
    'ALTER TABLE billing_plans ADD COLUMN stripe_season VARCHAR(60) NULL AFTER stripe_year_cents, ADD COLUMN stripe_season_cents INT UNSIGNED NULL AFTER stripe_season',
    "ALTER TABLE tenant_billing MODIFY billing_interval ENUM('month','year','season') NOT NULL DEFAULT 'month'",
    'ALTER TABLE tenant_billing ADD COLUMN season_paused_until DATE NULL AFTER past_due_since',
    `UPDATE billing_plans SET modules = '${RESORT_AT_LAUNCH},assets,messages' WHERE code = 'resort' AND kind = 'plan' AND modules = '${RESORT_AT_LAUNCH}'`,
    "UPDATE billing_plans SET monthly_cents = 14900, yearly_cents = 150000 WHERE code = 'patrol' AND kind = 'addon' AND monthly_cents = 17900",
  ]],
];
