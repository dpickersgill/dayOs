// Talks to the Verdynt/OS API. Where the sign-in token lives:
// - Signed in without "Remember me": in this tab only (sessionStorage), as before. A new tab asks to sign in.
// - With "Remember me": in localStorage, which every tab of this browser reads, so a link opened in a new tab opens signed
//   in. localStorage rather than sessionStorage plus a BroadcastChannel hand-off: a new tab finds the token at once, with no
//   wait for another tab to answer (a locked, sleeping or busy tab may not), and it is no easier to read from a script on
//   the page than sessionStorage is. tablock.js removes it when every tab has been idle 10 minutes or the last tab closes.
// - A tab that locked itself (10 minutes idle) reads no token at all until the person signs in again in that tab.
// The token never goes in a URL.

export const config = { base: '' };
// stepUp(details): asks the person to confirm it is them (passkey, app code or password) and resolves when they have,
// or rejects if they cancel. signOut(): signs out on purpose. Set by main.js.
export const hooks = { onSignedOut() {}, stepUp: null, signOut: null };

// Whether the person has touched the page since the last request went out. A background poll is marked x-poll: 1 when
// they have not, so the server does not count it as use and an unattended tab still ends after an hour; when they have
// (typing a long note, say), the poll carries that to the server instead.
let touched = false;
export function noteActivity() { touched = true; }

// A random id this browser keeps, so the server can tell a sign-in from a new device (it stores only a keyed hash).
// It is always sent: the server treats a sign-in with no id as a new device. When the browser will not store it (some
// private windows), this page keeps one for as long as it is open, and each sign-in there counts as a new device.
const DEVICE_KEY = 'so.device';
let pageDevice = '';
const newDeviceId = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
      id = newDeviceId();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch (_) {
    if (!pageDevice) pageDevice = newDeviceId();
    return pageDevice;
  }
}
const isStepUp = (status, data) => status === 403 && data && data.details && data.details.code === 'step_up_required';

const TOKEN_KEY = 'so.token';
const LOCK_KEY = 'so.locked'; // this tab locked itself: { tenant, login, name, shared } (sessionStorage, survives a reload)
const tabStore = () => globalThis.sessionStorage;
const sharedStore = () => { try { return globalThis.localStorage; } catch (_) { return null; } };
const read = (st, k) => { try { return st ? st.getItem(k) : null; } catch (_) { return null; } };
const write = (st, k, v) => { try { if (!st) return; if (v) st.setItem(k, v); else st.removeItem(k); } catch (_) { /* private mode */ } };

export const session = {
  /** The token this tab uses: its own, else the browser's shared one. None while the tab is locked. */
  get token() {
    if (read(tabStore(), LOCK_KEY)) return null;
    return read(tabStore(), TOKEN_KEY) || read(sharedStore(), TOKEN_KEY);
  },
  /** Keeps a fresh token where the current one is (a changed password, a step that issues a new token). */
  set token(v) { session.save(v, { shared: session.shared }); },
  /** Whether this tab uses the browser's shared token (signed in with Remember me). */
  get shared() { return !read(tabStore(), TOKEN_KEY) && Boolean(read(sharedStore(), TOKEN_KEY)); },
  /** A new sign-in: shared across this browser's tabs (Remember me) or this tab only. Unlocks the tab. */
  save(v, { shared = false } = {}) {
    write(tabStore(), LOCK_KEY, null);
    if (!v) { session.clear(); return; }
    if (shared && sharedStore()) { write(sharedStore(), TOKEN_KEY, v); write(tabStore(), TOKEN_KEY, null); } else { write(tabStore(), TOKEN_KEY, v); }
  },
  /** Signed out: this tab's token, and the shared one if this tab was using it (every tab of the browser signs out). */
  clear() {
    if (session.shared) write(sharedStore(), TOKEN_KEY, null);
    write(tabStore(), TOKEN_KEY, null);
  },
  /** The raw stores, for tablock.js (which moves the shared token aside while the last tab reloads). */
  sharedToken() { return read(sharedStore(), TOKEN_KEY); },
  setSharedToken(v) { write(sharedStore(), TOKEN_KEY, v); },
  /** Locks this tab: it reads no token until someone signs in again here. who: shown on the locked screen. */
  lock(who) { write(tabStore(), LOCK_KEY, JSON.stringify(who || {})); },
  locked() { try { return JSON.parse(read(tabStore(), LOCK_KEY) || 'null'); } catch (_) { return null; } },
  unlock() { write(tabStore(), LOCK_KEY, null); },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(method, path, body, retried = false, { poll = false } = {}) {
  const headers = {};
  if (poll && !touched) {
    headers['x-poll'] = '1';
    // On screen: someone still has the app open, so the server clears a closing mark (it is still not use).
    try { if (globalThis.document && document.visibilityState === 'visible') headers['x-visible'] = '1'; } catch (_) { /* fine */ }
  } else touched = false;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const used = session.token;
  if (used) headers.authorization = `Bearer ${used}`;
  const dev = deviceId();
  if (dev) headers['x-device'] = dev;
  const res = await fetch(`${config.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    // Another tab signed in again meanwhile and the shared token changed under this request: send it again with the new one.
    if (res.status === 401 && used && !retried && session.token && session.token !== used) return api(method, path, body, true, { poll });
    const signedIn = Boolean(session.token);
    if (res.status === 401 && signedIn && path !== '/auth/login' && path !== '/auth/change-password' && !path.startsWith('/auth/step-up')) {
      session.clear();
      hooks.onSignedOut();
    }
    // A sensitive action: confirm it is you, then the same request goes again.
    if (!retried && hooks.stepUp && isJson && isStepUp(res.status, data)) {
      await hooks.stepUp(data.details);
      return api(method, path, body, true, { poll });
    }
    throw new ApiError(res.status, (isJson && data.error) || 'Request failed', isJson ? data.details : undefined);
  }
  return data;
}

export const get = (p) => api('GET', p);
/** A GET made by a timer, not by the person (an unread count, a board that refreshes itself). */
export const poll = (p) => api('GET', p, undefined, false, { poll: true });
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p, b) => api('DELETE', p, b);

/** Download a protected file (the browser cannot attach the token to a plain link). */
export async function download(path, filename, retried = false) {
  const res = await fetch(`${config.base}/api/v1${path}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) {
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
    if (!retried && hooks.stepUp && isStepUp(res.status, data)) { await hooks.stepUp(data.details); return download(path, filename, true); }
    throw new ApiError(res.status, (data && data.error) || 'Download failed');
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open a protected file in a new tab (PDFs and images show in the browser). */
export async function openFile(path) {
  const win = window.open('', '_blank');
  try {
    const res = await fetch(`${config.base}/api/v1${path}`, { headers: { authorization: `Bearer ${session.token}` } });
    if (!res.ok) throw new ApiError(res.status, 'Could not open the file');
    const url = URL.createObjectURL(await res.blob());
    if (win) win.location = url; else window.location = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) { if (win) win.close(); throw err; }
}

/** Send a file as the raw request body. The name goes in a header so nothing needs to be encoded into JSON. */
export async function uploadFile(path, file, note) {
  const res = await fetch(`${config.base}/api/v1${path}`, { method: 'PUT', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name), ...(note ? { 'x-note': encodeURIComponent(note) } : {}) }, body: file });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'Upload failed', data ? data.details : undefined);
  return data;
}

/** Sends bytes (a photo) as the raw body, with query parameters; returns the JSON answer. */
export async function sendBytes(method, path, blob) {
  const res = await fetch(`${config.base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/octet-stream' }, body: blob });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || (res.status === 413 ? 'That file is too large' : 'Upload failed'), data ? data.details : undefined);
  return data;
}
/** A protected file as a Blob (to show an image that needs the sign-in token). */
export async function fetchBlob(path) {
  const res = await fetch(`${config.base}/api/v1${path}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) throw new ApiError(res.status, 'Could not load the file');
  return res.blob();
}

/** One readable sentence for any API error, including the lists of reasons the server sends back. */
export function describeError(err) {
  if (!(err instanceof ApiError)) return err && err.message ? err.message : 'Something went wrong';
  const parts = Array.isArray(err.details)
    ? err.details.map((d) => {
        if (typeof d === 'string') return d;
        if (d && d.sku) return `${d.sku} is ${d.status}`;
        if (d && d.message) return d.path ? `${d.path}: ${d.message}` : d.message;
        return '';
      }).filter(Boolean)
    : [];
  return parts.length ? `${err.message}: ${parts.join('; ')}` : err.message;
}
