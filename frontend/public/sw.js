const CACHE_PREFIX = 'shiftflow-';
const APP_SHELL_CACHE = `${CACHE_PREFIX}app-shell-v2`;
const API_CACHE = `${CACHE_PREFIX}api-v1`;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];
const API_REVALIDATE_PATHS = ['/api/tasks', '/api/messages', '/api/home'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith(CACHE_PREFIX) && key !== APP_SHELL_CACHE && key !== API_CACHE
          )
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (shouldHandleAsApi(url.pathname)) {
    event.respondWith(staleWhileRevalidateApi(event));
    return;
  }

  event.respondWith(cacheFirstAppShell(event.request));
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

async function staleWhileRevalidateApi(event) {
  const { request } = event;
  const cache = await caches.open(API_CACHE);
  const cachedResponse = await cache.match(request);

  const networkPromise = fetch(request)
    .then(async (networkResponse) => {
      if (!isCacheableResponse(networkResponse)) {
        return networkResponse;
      }

      const responseForCache = networkResponse.clone();
      const responseForNotify = networkResponse.clone();
      await cache.put(request, responseForCache);

      if (await shouldBroadcastUpdate(request, responseForNotify, cachedResponse)) {
        broadcastCacheUpdate(request.url);
      }

      return networkResponse;
    })
    .catch((error) => {
      if (!cachedResponse) {
        throw error;
      }
      return cachedResponse;
    });

  if (cachedResponse) {
    event.waitUntil(networkPromise.catch(() => {}));
    return cachedResponse;
  }

  return networkPromise;
}

function isCacheableResponse(response) {
  return response && response.status === 200 && (response.type === 'basic' || response.type === 'default');
}

function shouldHandleAsApi(pathname) {
  return API_REVALIDATE_PATHS.some((prefix) => pathname.startsWith(prefix));
}

async function shouldBroadcastUpdate(request, freshResponse, cachedResponse) {
  if (!cachedResponse) {
    return true;
  }

  const freshTag = freshResponse.headers.get('etag');
  const cachedTag = cachedResponse.headers.get('etag');
  if (freshTag && cachedTag && freshTag === cachedTag) {
    return false;
  }

  const freshModified = freshResponse.headers.get('last-modified');
  const cachedModified = cachedResponse.headers.get('last-modified');
  if (freshModified && cachedModified && freshModified === cachedModified) {
    return false;
  }

  const freshLength = freshResponse.headers.get('content-length');
  const cachedLength = cachedResponse.headers.get('content-length');
  if (freshLength && cachedLength && freshLength === cachedLength) {
    return false;
  }

  // Fallback: if no comparison was possible, assume updated.
  return true;
}

function broadcastCacheUpdate(url) {
  self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'API_CACHE_UPDATED',
          url,
          timestamp: Date.now(),
        });
      });
    })
    .catch(() => {
      // ignore broadcast failures
    });
}
