// The app's service worker: phone alerts, and the app shell kept on the phone so Verdynt/OS opens with no signal.
//
// Phone alerts: the server sends an encrypted Web Push message; this shows it as a notification, and a tap opens
// Verdynt/OS at the page it points to (a dispatch call, the sweep, a cover request).
//
// The app shell (2026.11.11): the server sends this file with the release filled in (src/lib/appassets.js). On install it
// keeps the app page and every script, style and font of this release, at their /r/<release>/ addresses, in one cache
// named for the release. A reload with no signal then opens the app from that cache, in offline mode, instead of the
// browser's error page. API calls are never cached here: patient details stay sealed in the outbox (outbox.js).
// A new release is a new file, so the browser installs the new worker, which keeps the new release and removes the old
// caches when it takes over. The page itself is always fetched fresh when there is a signal.
const RELEASE = '__RELEASE__';
const SHELL = []; /* __SHELL__ */
const CACHE = `so-shell-${RELEASE}`;
const PREFIX = `/r/${RELEASE}/`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one: a file that fails (a weak signal) does not stop the rest; it is fetched again when next used.
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload', credentials: 'same-origin' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('so-shell-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

const isShellPage = (url) => url.pathname === '/' || url.pathname === '/index.html';
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  // The app page: always fresh with a signal; the kept copy with none (or when the server cannot be reached).
  if (req.mode === 'navigate') {
    if (!isShellPage(url)) return;
    event.respondWith(fetch(req).catch(async () => (await (await caches.open(CACHE)).match('/')) || Response.error()));
    return;
  }
  // This release's files never change: from the cache first. A file from another release (a tab opened before an
  // update) is fetched; with no signal, this release's copy of the same file is the best there is.
  const m = /^\/r\/[^/]+\/(.*)$/.exec(url.pathname);
  if (m || /^\/(fonts|icons|brand)\//.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && (url.pathname.startsWith(PREFIX) || !m)) cache.put(req, res.clone()).catch(() => {});
        return res;
      } catch (err) {
        const same = m && await cache.match(`${PREFIX}${m[1]}`);
        if (same) return same;
        throw err;
      }
    })());
  }
});

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (_) { m = { title: 'Verdynt/OS', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(m.title || 'Verdynt/OS', {
    body: m.body || '', tag: m.tag || undefined, renotify: Boolean(m.tag), requireInteraction: /CRITICAL/.test(m.title || ''),
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: m.url || '#/patrol' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.url) || '#/patrol';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); c.navigate(`/${hash}`).catch(() => {}); return; }
    }
    await self.clients.openWindow(`/${hash}`);
  })());
});
