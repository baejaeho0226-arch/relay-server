'use strict';

const CACHE = 'relay-admin-shell-v4.12.0-fix23';
const SHELL = [
  "/index.html",
  "/admin.css?v=4.12.0-fix23",
  "/admin-theme.css?v=4.12.0-fix23",
  "/admin-appearance.css?v=4.12.0-fix23",
  "/admin-appearance.js?v=4.12.0-fix23",
  "/admin-navigation.css?v=4.12.0-fix23",
  "/admin-i18n.js?v=4.12.0-fix23",
  "/admin.js?v=4.12.0-fix23",
  "/admin-navigation.js?v=4.12.0-fix23",
  "/admin-pages-monitoring.js?v=4.12.0-fix23",
  "/admin-terminal.js?v=4.12.0-fix23",
  "/admin-pages-traffic.js?v=4.12.0-fix23",
  "/admin-pages-danger.js?v=4.12.0-fix23",
  "/admin-pages-access.js?v=4.12.0-fix23",
  "/admin-pages-sessions.js?v=4.12.0-fix23",
  "/admin-pages-reports.js?v=4.12.0-fix23",
  "/admin-pages-devices.js?v=4.12.0-fix23",
  "/admin-pages-qr.js?v=4.12.0-fix23",
  "/admin-pages-licenses.js?v=4.12.0-fix23",
  "/admin-pages-deployment.js?v=4.12.0-fix23",
  "/admin-pages-security.js?v=4.12.0-fix23",
  "/admin-pages-operations.js?v=4.12.0-fix23",
  "/admin-pages-support.js?v=4.12.0-fix23",
  "/admin-actions-access.js?v=4.12.0-fix23",
  "/admin-actions-operations.js?v=4.12.0-fix23",
  "/admin-actions-traffic.js?v=4.12.0-fix23",
  "/admin-actions-devices.js?v=4.12.0-fix23",
  "/admin-actions-policy.js?v=4.12.0-fix23",
  "/admin-actions-system.js?v=4.12.0-fix23",
  "/admin-modal.js?v=4.12.0-fix23",
  "/admin-device-actions.js?v=4.12.0-fix23",
  "/admin-license-actions.js?v=4.12.0-fix23",
  "/admin-actions.js?v=4.12.0-fix23",
  "/admin-pages-member.js?v=4.12.0-fix23",
  "/admin-member-actions.js?v=4.12.0-fix23",
  "/admin-member.css?v=4.12.0-fix23",
  "/admin-palette.js?v=4.12.0-fix23",
  "/admin-pages-production.js?v=4.12.0-fix23",
  "/ui-refresh.html",
  "/ui-refresh.js?v=4.12.0-fix23",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: 'no-store' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('relay-admin-shell-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache authenticated API/SSE/health data.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/ui-version.json' || url.pathname === '/ui-refresh' || url.pathname === '/ui-refresh.html' || url.pathname === '/ui-refresh.js') {
    event.respondWith(fetch(new Request(request, { cache: 'no-store' })));
    return;
  }
  if (request.method !== 'GET') return;
  const navigation = request.mode === 'navigate';
  const cacheable = navigation || SHELL.some(item => new URL(item, self.location.origin).pathname === url.pathname);
  event.respondWith(
    fetch(new Request(request, { cache: 'no-store' })).then(response => {
      if (cacheable && response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then(cache => cache.put(navigation ? '/index.html' : request, copy)).catch(() => {}));
      }
      return response;
    }).catch(async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(navigation ? '/index.html' : request);
      // A missing JavaScript/CSS file must never be replaced with HTML.
      return hit || new Response('인터넷 연결 후 이 화면을 다시 열어주세요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const severity = String(data.severity || 'INFO').toUpperCase();
  event.waitUntil(self.registration.showNotification(data.title || '중계 서버 운영 알림', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `${data.type || 'SYSTEM'}:${data.entityId || ''}`,
    renotify: severity === 'CRITICAL',
    requireInteraction: severity === 'CRITICAL',
    data: { url: data.url || '/', type: data.type || 'SYSTEM', entityId: data.entityId || '' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    for (const client of windows) {
      if ('focus' in client) {
        if ('navigate' in client) client.navigate(target);
        return client.focus();
      }
    }
    return clients.openWindow ? clients.openWindow(target) : undefined;
  }));
});
