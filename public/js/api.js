// Talks to the SummitOps API. The token lives in sessionStorage, so closing the tab signs you out.

export const config = { base: '' };
export const hooks = { onSignedOut() {} };

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

export async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`${config.base}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const signedIn = Boolean(session.token);
    if (res.status === 401 && signedIn && path !== '/auth/login' && path !== '/auth/change-password') {
      session.clear();
      hooks.onSignedOut();
    }
    throw new ApiError(res.status, (isJson && data.error) || 'Request failed', isJson ? data.details : undefined);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);

/** Download a protected file (the browser cannot attach the token to a plain link). */
export async function download(path, filename) {
  const res = await fetch(`${config.base}/api/v1${path}`, { headers: { authorization: `Bearer ${session.token}` } });
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
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
