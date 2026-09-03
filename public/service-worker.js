'use strict';

const CACHE = 'relay-admin-shell-v3.5.0-fix6';
const SHELL = [
  '/index.html',
  '/admin.css?v=3.5.0-fix6',
  '/admin.js?v=3.5.0-fix6',
  '/admin-pages-monitoring.js?v=3.5.0-fix6',
  '/admin-pages-access.js?v=3.5.0-fix6',
  '/admin-pages-operations.js?v=3.5.0-fix6',
  '/admin-actions.js?v=3.5.0-fix6',
  '/admin-pages-production.js?v=3.5.0-fix6',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache authenticated API/SSE/health data.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/healthz') {
    event.respondWith(fetch(request));
    return;
  }
  if (request.method !== 'GET') return;
  event.respondWith(
    fetch(request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
      return response;
    }).catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const severity = String(data.severity || 'INFO').toUpperCase();
  event.waitUntil(self.registration.showNotification(data.title || 'Relay Operations', {
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
