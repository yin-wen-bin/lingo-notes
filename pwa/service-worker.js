/* Only public application files are cached. Learning data and signed images never enter CacheStorage. */
const CACHE = 'lingo-shell-__CACHE_VERSION__';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/extension-brand-128.png', /*__BUILD_ASSETS__*/];
const SHELL_PATHS = new Set(SHELL);
const FONT_PATHS = new Set([/*__BUILD_FONTS__*/]);

async function isFontResponse(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.ok || response.redirected || !['font/woff2', 'application/font-woff2', 'application/octet-stream'].includes(type)) return false;
  const bytes = await response.clone().arrayBuffer();
  return bytes.byteLength >= 4 && new DataView(bytes).getUint32(0) === 0x774f4632;
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('lingo-shell-') && name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // Query strings can contain private batch/record identifiers: always request the public shell URL.
    event.respondWith(fetch('/', { redirect: 'error', cache: 'no-cache', credentials: 'omit' }).then(response => {
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') throw new Error('SHELL_UNAVAILABLE');
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put('/', copy)));
      return response;
    }).catch(async () => {
      const cached = await caches.match('/');
      return cached?.ok && !cached.redirected && cached.type !== 'opaqueredirect' ? cached : Response.error();
    }));
    return;
  }
  if (url.search) return;
  if (FONT_PATHS.has(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      const response = await fetch(request, { credentials: 'omit', redirect: 'error' });
      if (await isFontResponse(response)) {
        event.waitUntil(cache.put(url.pathname, response.clone()));
      }
      return response;
    }));
    return;
  }
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.match(url.pathname).then(cached => cached || fetch(request)));
});
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Still provide a generic notification. */ }
  const candidate = payload.batch_id ?? payload.data?.batch_id;
  const batchId = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(candidate) ? candidate : null;
  event.waitUntil(self.registration.showNotification('Lingo Notes', {
    body: '今天的复习卡片已准备好，点开读一读。',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: batchId ? `lingo-review-${batchId}` : 'lingo-review',
    data: { path: batchId ? `/?batch=${encodeURIComponent(batchId)}` : '/' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = event.notification.data?.path;
  const safePath = typeof path === 'string' && /^\/\?batch=[a-zA-Z0-9_%\-]+$/.test(path) ? path : '/';
  const destination = new URL(safePath, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(item => new URL(item.url).origin === self.location.origin);
    if (client && 'navigate' in client) {
      await client.navigate(destination);
      return client.focus();
    }
    return self.clients.openWindow(destination);
  }));
});
