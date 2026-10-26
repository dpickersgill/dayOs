// Passkeys in the browser: turns the server's options into what navigator.credentials expects, and the phone's or
// computer's answer back into plain JSON for the server. Used by the app (sign-in, Account, second checks) and the console.

const dec = (s) => {
  const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Can this browser use passkeys at all? */
export const supported = () => Boolean(globalThis.PublicKeyCredential && navigator.credentials && navigator.credentials.create);

// What the person sees when the browser refuses: plain words, not "NotAllowedError".
function plain(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new Error('The passkey was canceled or took too long. Try again.');
  if (name === 'InvalidStateError') return new Error('This device already has a passkey for this login.');
  if (name === 'SecurityError') return new Error('Passkeys only work on the app\'s secure address (https).');
  if (name === 'NotSupportedError') return new Error('This browser cannot make a passkey. Try another browser or device.');
  return err instanceof Error ? err : new Error('The passkey did not work');
}

/** Makes a new passkey from registration options; returns the answer for the server. */
export async function create(options) {
  if (!supported()) throw new Error('This browser cannot use passkeys. Try a newer browser, or use an authenticator app.');
  const publicKey = {
    ...options,
    challenge: dec(options.challenge),
    user: { ...options.user, id: dec(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: dec(c.id) })),
  };
  let cred;
  try { cred = await navigator.credentials.create({ publicKey }); } catch (e) { throw plain(e); }
  return {
    id: cred.id, rawId: enc(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: enc(cred.response.clientDataJSON), attestationObject: enc(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  };
}

/** Uses a passkey with authentication options; returns the answer for the server. */
export async function use(options) {
  if (!supported()) throw new Error('This browser cannot use passkeys. Sign in with your password instead.');
  const publicKey = { ...options, challenge: dec(options.challenge), allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: dec(c.id) })) };
  let cred;
  try { cred = await navigator.credentials.get({ publicKey }); } catch (e) { throw plain(e); }
  return {
    id: cred.id, rawId: enc(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    response: {
      clientDataJSON: enc(cred.response.clientDataJSON), authenticatorData: enc(cred.response.authenticatorData),
      signature: enc(cred.response.signature), userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : undefined,
    },
  };
}
