'use strict';

// The second check before sensitive actions. Being signed in is not enough to refund a large sale, change who can do
// what, release or export patient records, change billing or weaken sign-in rules: the person proves it is them again
// (their passkey, a code from their app, or for those with neither, their password), and that lasts STEP_UP_MINUTES (10).
// A fresh passkey or two-step sign-in counts. The app asks automatically and retries the action.
const { forbidden } = require('./errors');

function needed(what) {
  const err = forbidden(`Confirm it is you to ${what}`);
  err.details = { code: 'step_up_required', what };
  return err;
}

/** Route guard: the action needs a recent second check. what: the action in a few words ("release this record"). */
function stepUp(what) {
  return (req, _res, next) => {
    if (req.auth && req.auth.steppedUp) return next();
    return next(needed(what));
  };
}

/** For actions that need it only sometimes (a refund over a limit): throws when the check is needed and missing. */
function require_(req, what) {
  if (!req.auth || !req.auth.steppedUp) throw needed(what);
}

module.exports = { stepUp, require: require_, needed };
