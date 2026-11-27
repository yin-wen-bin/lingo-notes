/* Only public application files are cached. Learning data and signed images never enter CacheStorage. */
const CACHE = 'lingo-shell-__CACHE_VERSION__';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/extension-brand-128.png', /*__BUILD_ASSETS__*/];
const SHELL_PATHS = new Set(SHELL);
const FONT_PATHS = new Set([/*__BUILD_FONTS__*/]);

function validShell(response) {
  return response?.ok && !response.redirected && response.type !== 'opaqueredirect';
}

async function fetchShell() {
  // Batch IDs and note IDs stay in the browser address; cache only canonical public HTML.
  const response = await fetch('/', {redirect:'error', cache:'no-cache', credentials:'omit'});
  if (!validShell(response)) throw new Error('SHELL_UNAVAILABLE');
  return response;
}

async function isFontResponse(response) {
  const type = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.ok || response.redirected || !['font/woff2', 'application/font-woff2', 'application/octet-stream'].includes(type)) return false;
  const bytes = await response.clone().arrayBuffer();
  return bytes.byteLength >= 4 && new DataView(bytes).getUint32(0) === 0x774f4632;
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const shell = await fetchShell();
    const html = await shell.clone().text();
    if (SHELL.some(path => path.startsWith('/assets/') && !html.includes(path))) throw new Error('SHELL_VERSION_MISMATCH');
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.filter(path => path !== '/'));
    await cache.put('/', shell);
    // Let the browser activate after existing pages close so their reading is uninterrupted.
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('lingo-shell-') && name !== CACHE).map(name => caches.delete(name)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html')) {
    event.respondWith((async () => {
      const cached = await caches.open(CACHE).then(cache => cache.match('/')).catch(() => undefined);
      if (validShell(cached)) return cached;
      return await fetchShell().catch(() => Response.error());
    })());
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
  event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(request)));
});
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Still provide a generic notification. */ }
  const candidate = payload.batch_id ?? payload.data?.batch_id;
  const batchId = typeof candidate === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(candidate) ? candidate : null;
  const test = payload.kind === 'test' && !batchId;
  event.waitUntil(self.registration.showNotification('Lingo Notes', {
    body: test ? '这是一条通知测试。点开返回学习中心。' : '今天的复习卡片已准备好，点开读一读。',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: batchId ? `lingo-review-${batchId}` : test ? 'lingo-test' : 'lingo-review',
    data: { path: batchId ? `/?batch=${encodeURIComponent(batchId)}` : '/' },
  }));
});

async function openInPage(client, batch) {
  const channel = new MessageChannel();
  let timeout;
  try {
    return await new Promise(resolve => {
      timeout = setTimeout(() => resolve(false), 500);
      channel.port1.onmessage = event => resolve(event.data === 'LINGO_REVIEW_OPENED');
      client.postMessage({type:'LINGO_OPEN_REVIEW', batch}, [channel.port2]);
    });
  } finally {
    clearTimeout(timeout);
    channel.port1.close();
  }
}
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const path = event.notification.data?.path;
  const batch = typeof path === 'string' ? /^\/\?batch=([a-zA-Z0-9_-]{1,128})$/.exec(path)?.[1] : undefined;
  const safePath = batch ? '/?batch=' + batch : '/';
  const destination = new URL(safePath, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    const client = clients.find(item => {
      const url = new URL(item.url);
      return url.origin === self.location.origin && ['/', '/index.html'].includes(url.pathname) && !url.hash;
    });
    if (client) {
      try {
        if (!batch || await openInPage(client, batch)) return await client.focus();
        const navigated = await client.navigate(destination);
        if (navigated) return await navigated.focus();
      } catch { /* Open the validated destination below if this page became unavailable. */ }
    }
    return self.clients.openWindow(destination);
  }));
});
