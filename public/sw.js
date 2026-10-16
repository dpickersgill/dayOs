// Phone alerts. The server sends an encrypted Web Push message; this shows it as a notification, and a tap opens
// SummitOps at the page it points to (a dispatch call, the sweep, a cover request). Nothing is cached here.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (_) { m = { title: 'SummitOps', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(m.title || 'SummitOps', {
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
