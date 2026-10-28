// Talks to the Verdynt/OS API. The token lives in sessionStorage, so closing the tab signs you out.

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
const store = () => globalThis.sessionStorage;

export const session = {
  get token() { return store().getItem(TOKEN_KEY); },
  set token(v) { if (v) store().setItem(TOKEN_KEY, v); else store().removeItem(TOKEN_KEY); },
  clear() { store().removeItem(TOKEN_KEY); },
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
  if (poll && !touched) headers['x-poll'] = '1'; else touched = false;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const dev = deviceId();
  if (dev) headers['x-device'] = dev;
  const res = await fetch(`${config.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
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
