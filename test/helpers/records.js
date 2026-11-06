'use strict';

// The patient-record check (feat/auth-hardening): signing in no longer counts as the check for opening older or other
// people's patient care records. Tests that open someone else's case make the check once for the session, the way a
// person does at the records prompt: POST /auth/step-up with scope "records" and their password (logins with no passkey
// or app). Returns the same token, so it wraps a sign-in: records(base, PW)(token).
function records(base, password) {
  const b = typeof base === 'function' ? base : () => base;
  const pw = typeof password === 'function' ? password : () => password;
  return async (token) => {
    if (!token) return token;
    const r = await fetch(`${b()}/api/v1/auth/step-up`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ scope: 'records', password: pw() }) });
    if (r.status !== 200) throw new Error(`records check: ${r.status} ${await r.text()}`);
    return token;
  };
}

module.exports = { records };
