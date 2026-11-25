// アプリ全体のバージョン。フロントコードに変更が入ったら必ず更新する。
const APP_VERSION = '2.3.10';

const CACHE_PREFIX = 'shiftflow-';
const APP_SHELL_CACHE = `${CACHE_PREFIX}app-shell-${APP_VERSION}`;
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/app-config.js',
  '/i18n.js',
  '/request-coalescer.js',
  '/app-badge.js',
  '/push-settings.js',
  '/push-settings.css',
  '/compact-ui.css',
];

self.addEventListener('install', (event) => {
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
      // 稼働版は切り替えるが、開いている画面は本人の操作まで再読み込みしない。
      .then(() => self.skipWaiting())
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
  if (event.source?.url && new URL(event.source.url).origin !== self.location.origin) return;
  if (event.data.type === 'SHIFT_FLOW_GET_APP_VERSION') {
    event.source?.postMessage({ type: 'SHIFT_FLOW_APP_VERSION', version: APP_VERSION });
    return;
  }
  if (event.data.type === 'CLEAR_APP_BADGE') {
    event.waitUntil(clearAppIconBadge());
  }
  if (event.data.type === 'REFRESH_APP_BADGE') {
    event.waitUntil(refreshAppIconBadge().then((result) => {
      event.ports?.[0]?.postMessage(result ? { ok: true, total: result.total } : { ok: false });
    }).catch(() => event.ports?.[0]?.postMessage({ ok: false })));
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
  return caches.open(APP_SHELL_CACHE).then((cache) => cache.match(request)).then((cachedResponse) => {
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

// 件数・本文・認証情報は保存しない。ownerと最終適用時刻だけで古いpushを判別する。
let badgeGeneration = 0;
let badgePending = null;
let badgeWrites = Promise.resolve();
let badgeContext = null;
let badgeContextLoaded = false;
let badgeOwnerAuthenticated = false;
function badgeStorage(mode, value) {
  if (!self.indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let db = null;
    let transaction = null;
    const timer = setTimeout(() => {
      try { transaction?.abort(); db?.close(); } catch (_) {}
      finish(null);
    }, 500);
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    try {
      const request = self.indexedDB.open('shiftflow-app-badge', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('context');
      request.onerror = request.onblocked = () => finish(null);
      request.onsuccess = () => {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          transaction = db.transaction('context', mode === 'read' ? 'readonly' : 'readwrite');
          const store = transaction.objectStore('context');
          const operation = mode === 'read' ? store.get('current') : store.put(value, 'current');
          let result = null;
          operation.onsuccess = () => { result = operation.result || null; };
          transaction.oncomplete = () => { db.close(); finish(result); };
          transaction.onerror = transaction.onabort = () => { db.close(); finish(null); };
        } catch (_) { db.close(); finish(null); }
      };
    } catch (_) { finish(null); }
  });
}
function canSetAppIconBadge() {
  return typeof self.navigator?.setAppBadge === 'function' || typeof self.navigator?.clearAppBadge === 'function';
}
function validAppIconBadge(value) {
  return value && /^[a-f0-9]{64}$/.test(value.owner || '') &&
    ['total', 'messageUnread', 'taskOverdue'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) &&
    value.total === value.messageUnread + value.taskOverdue &&
    Number.isFinite(value.computedAt) && value.computedAt <= Date.now() + 60000 &&
    Number.isFinite(value.sessionExpiresAt) && value.sessionExpiresAt > Date.now();
}
function queueBadgeWrite(callback) {
  const result = badgeWrites.catch(() => {}).then(callback);
  badgeWrites = result.catch(() => {});
  return result;
}
function clearAppIconBadge(expectedGeneration) {
  if (expectedGeneration !== undefined && expectedGeneration !== badgeGeneration) return Promise.resolve(null);
  const generation = ++badgeGeneration;
  badgeOwnerAuthenticated = false;
  badgePending = null;
  return queueBadgeWrite(async () => {
    if (generation !== badgeGeneration) return null;
    badgeContext = { owner: '', computedAt: Date.now(), sessionExpiresAt: 0 };
    badgeContextLoaded = true;
    await badgeStorage('write', badgeContext);
    if (typeof self.navigator?.clearAppBadge === 'function') await self.navigator.clearAppBadge();
    else if (typeof self.navigator?.setAppBadge === 'function') await self.navigator.setAppBadge(0);
    return null;
  });
}
function applyAppIconBadge(value, generation, fallback, deadline) {
  return queueBadgeWrite(async () => {
    if (generation !== badgeGeneration || !validAppIconBadge(value) || Date.now() > deadline) return null;
    if (!badgeContextLoaded) {
      badgeContext = await badgeStorage('read');
      badgeContextLoaded = true;
    }
    if (generation !== badgeGeneration || Date.now() > deadline) return null;
    if (fallback && (!badgeOwnerAuthenticated || !badgeContext || badgeContext.owner !== value.owner ||
        badgeContext.sessionExpiresAt <= Date.now() || Date.now() - value.computedAt > 600000)) return null;
    if (badgeContext?.owner === value.owner && badgeContext.computedAt > value.computedAt) return null;
    if (!fallback) badgeOwnerAuthenticated = true;
    badgeContext = { owner: value.owner, computedAt: value.computedAt, sessionExpiresAt: value.sessionExpiresAt };
    await badgeStorage('write', badgeContext);
    if (generation !== badgeGeneration || Date.now() > deadline) return null;
    if (value.total === 0 && typeof self.navigator?.clearAppBadge === 'function') await self.navigator.clearAppBadge();
    else if (typeof self.navigator?.setAppBadge === 'function') await self.navigator.setAppBadge(value.total);
    return value;
  });
}
function refreshAppIconBadge(fallback) {
  if (!canSetAppIconBadge()) return Promise.resolve(null);
  if (badgePending) return badgePending;
  const generation = badgeGeneration;
  const deadline = Date.now() + 2500;
  const controller = new AbortController();
  let timer;
  const request = fetch(new URL('/api/getAppBadge', self.location.origin), {
    credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
  }).then(async (response) => ({ response, payload: response.ok ? await response.json() : null }));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('badge_timeout')); }, 2500);
  });
  const operation = Promise.race([request, timeout]).then(async ({ response, payload }) => {
    if (generation !== badgeGeneration) return null;
    if (response.status === 401 || response.status === 403) return clearAppIconBadge(generation);
    if (!response.ok) return null;
    return applyAppIconBadge(payload?.ok === true ? payload.result : null, generation, false, deadline);
  }, () => applyAppIconBadge(fallback, generation, true, deadline)).catch(() => null).finally(() => {
    clearTimeout(timer);
    if (badgePending === operation) badgePending = null;
  });
  badgePending = operation;
  return operation;
}

// Safariはsilent pushを許可しない。受信したpushは必ず可視通知として表示する。
function safeNotificationUrl(value) {
  try {
    const url = new URL(value || '/', self.location.origin);
    if (url.origin === self.location.origin && url.pathname === '/') return url.href;
  } catch (_) {}
  return new URL('/', self.location.origin).href;
}
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) {}
  if (!payload || typeof payload !== 'object') payload = {};
  const shown = self.registration.showNotification('ShiftFlow', {
    body: typeof payload.body === 'string' ? payload.body.slice(0, 160) : '新しいお知らせがあります。アプリで確認してください。',
    tag: typeof payload.tag === 'string' ? payload.tag.slice(0, 128) : 'shiftflow-update',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    data: { url: safeNotificationUrl(payload.url) },
  });
  event.waitUntil(Promise.all([shown, refreshAppIconBadge(payload.appBadge)]));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeNotificationUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (client) {
      try { const navigated = await client.navigate(url); return await (navigated || client).focus(); } catch (_) {}
    }
    return self.clients.openWindow(url);
  })());
});
