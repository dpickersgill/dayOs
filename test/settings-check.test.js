'use strict';
// scripts/settings-check.sh: the passkey address warning (review of 2026.11.12). Passkeys are accepted only on PUBLIC_URL
// and WEBAUTHN_ORIGINS, so a run.app PUBLIC_URL with passkeys on the mountain's own domain is a warning.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const script = path.join(__dirname, '..', 'scripts', 'settings-check.sh');
const warn = (pub, rpid) => execFileSync('bash', ['-c', `. "${script}"; passkey_origin_warning "$1" "$2"`, 'x', pub, rpid], { encoding: 'utf8' });

test('warns when PUBLIC_URL is a run.app address and WEBAUTHN_RP_ID is a custom domain', () => {
  const out = warn('https://summitops-api-1.us-east1.run.app', 'runmyresort.com');
  assert.match(out, /^Warning: PUBLIC_URL is https:\/\/summitops-api-1\.us-east1\.run\.app, a run\.app address/);
  assert.match(out, /https:\/\/app\.runmyresort\.com/);
  assert.match(out, /WEBAUTHN_ORIGINS/);
});

test('says nothing when the two agree or no domain is set', () => {
  assert.equal(warn('https://app.runmyresort.com', 'runmyresort.com'), '');
  assert.equal(warn('https://summitops-api-1.us-east1.run.app', ''), '');
  assert.equal(warn('https://summitops-api-1.us-east1.run.app', 'summitops-api-1.us-east1.run.app'), '');
});

test('the runbook no longer says the passkey address is the one the request came to', () => {
  const rb = require('node:fs').readFileSync(path.join(__dirname, '..', 'RUNBOOK.md'), 'utf8');
  assert.doesNotMatch(rb, /the address the request came to/);
  assert.doesNotMatch(rb, /PUBLIC_URL=https:\/\/summitops-api-[^\s,]*run\.app/);
  assert.match(rb, /must be listed in\s+`WEBAUTHN_ORIGINS`/);
});
