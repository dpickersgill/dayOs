'use strict';

// A software passkey for tests: makes and uses WebAuthn credentials the way a phone would (P-256, "none" attestation,
// user verified), so the server's real checks run end to end.
const crypto = require('node:crypto');
const { encodeCBOR } = require('@levischuck/tiny-cbor');

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

class SoftAuthenticator {
  constructor(origin) {
    this.origin = origin;
    this.rpId = new URL(origin).hostname;
    this.creds = [];
  }

  /** Answers registration options (from the server) with a new credential. */
  create(options) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = crypto.randomBytes(16);
    const cose = encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(id.length);
    const authData = Buffer.concat([sha(options.rp.id || this.rpId), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, id, Buffer.from(cose)]);
    const att = encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const cred = { id, privateKey, userHandle: Buffer.from(options.user.id, 'base64url'), counter: 0, rpId: options.rp.id || this.rpId };
    this.creds.push(cred);
    return { id: b64u(id), rawId: b64u(id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] } };
  }

  /** Answers authentication options with the first credential allowed (or the given one). */
  get(options, pick) {
    const allowed = (options.allowCredentials || []).map((c) => c.id);
    const cred = pick || this.creds.find((c) => !allowed.length || allowed.includes(b64u(c.id)));
    if (!cred) throw new Error('No credential for these options');
    cred.counter += 1;
    const n = Buffer.alloc(4); n.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha(options.rpId || cred.rpId), Buffer.from([0x05]), n]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), { key: cred.privateKey, dsaEncoding: 'der' });
    return { id: b64u(cred.id), rawId: b64u(cred.id), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u(cred.userHandle) } };
  }
}

module.exports = { SoftAuthenticator };
