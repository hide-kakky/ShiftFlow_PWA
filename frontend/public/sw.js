// アプリ全体のバージョン。フロントコードに変更が入ったら必ず更新する。
const APP_VERSION = '1.6.0';

const CACHE_PREFIX = 'shiftflow-';
const APP_SHELL_CACHE = `${CACHE_PREFIX}app-shell-${APP_VERSION}`;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/app-config.js', '/i18n.js'];

self.addEventListener('install', (event) => {
  const hadActiveWorker = !!(self.registration && self.registration.active);
  event.waitUntil(
    caches
      .open(APP_SHELL_CACHE)
      .then((cache) =>
        Promise.all(
          APP_SHELL.map((path) =>
            fetch(new Request(new URL(path, self.location.origin), { cache: 'reload' })).then((response) => {
              if (!isCacheableResponse(response)) {
                throw new Error(`Failed to refresh app shell: ${path}`);
              }
              return cache.put(path, response);
            })
          )
        )
      )
      .then(() => {
        if (hadActiveWorker) {
          broadcastAppShellUpdate();
        }
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== APP_SHELL_CACHE)
          .map((key) => caches.delete(key))
      );

      const appShellCache = await caches.open(APP_SHELL_CACHE);
      const requests = await appShellCache.keys();
      await Promise.all(
        requests
          .filter((request) => {
            try {
              return new URL(request.url).pathname === '/config';
            } catch (_err) {
              return false;
            }
          })
          .map((request) => appShellCache.delete(request))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (!event || !event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith('/auth/')) {
    return;
  }

  if (url.pathname === '/config') {
    return;
  }

  // 認証済み業務データはユーザーをまたいでCacheStorageへ残さない。
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  const shellPath = url.pathname === '/index.html' ? '/' : url.pathname;
  if (!APP_SHELL.includes(shellPath)) {
    return;
  }
  const cacheRequest = new Request(new URL(shellPath, self.location.origin));
  event.respondWith(cacheFirstAppShell(cacheRequest));
});

function cacheFirstAppShell(request) {
  return caches.match(request).then((cachedResponse) => {
    if (cachedResponse) {
      return cachedResponse;
    }
    return fetch(request).then((networkResponse) => {
      if (!isCacheableResponse(networkResponse)) {
        return networkResponse;
      }
      const clone = networkResponse.clone();
      caches.open(APP_SHELL_CACHE).then((cache) => cache.put(request, clone));
      return networkResponse;
    });
  });
}

function isCacheableResponse(response) {
  return (
    response &&
    response.status === 200 &&
    (response.type === 'basic' || response.type === 'default')
  );
}

function broadcastAppShellUpdate() {
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'APP_SHELL_UPDATED',
          timestamp: Date.now(),
          version: APP_VERSION,
        });
      });
    })
    .catch(() => {});
}
