(function () {
  'use strict';
  var generation = 0, identity = '', pending = null, timer = null;
  var lastRequestAt = -Infinity;
  var badgeWrites = Promise.resolve();

  function context() {
    try {
      var value = window.__SHIFT_FLOW_BADGE_CONTEXT__?.();
      return value && value.allowed && typeof value.identity === 'string' && value.identity
        ? { identity: value.identity, allowed: true } : { identity: '', allowed: false };
    } catch (_) { return { identity: '', allowed: false }; }
  }
  function visible() { return document.visibilityState === 'visible'; }
  function current(operation) {
    var value = context();
    return generation === operation.generation && value.allowed && value.identity === operation.identity && visible();
  }
  function validTotal(value) { return Number.isSafeInteger(value) && value >= 0; }
  function canWriteBadge() { return typeof navigator.setAppBadge === 'function' || typeof navigator.clearAppBadge === 'function'; }
  function stopTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function schedule() {
    if (timer !== null || !visible() || !context().allowed) return;
    timer = setTimeout(function () { timer = null; refresh(); }, 60000);
  }
  function invalidate() {
    generation++;
    if (pending?.cancel) pending.cancel();
    pending = null;
    lastRequestAt = -Infinity;
  }
  function activeWorker() {
    try {
      var workers = navigator.serviceWorker;
      if (workers?.controller) return Promise.resolve(workers.controller);
      return workers?.getRegistration
        ? Promise.resolve(workers.getRegistration('/')).then(function (registration) { return registration?.active || null; })
        : Promise.resolve(null);
    } catch (_) { return Promise.resolve(null); }
  }
  function askWorker(operation) {
    if (!navigator.serviceWorker || typeof MessageChannel !== 'function') return Promise.resolve(null);
    return new Promise(function (resolve) {
      var done = false, channel = null, workerUsed = false;
      var timeout = setTimeout(function () { finish(null); }, 3000);
      function finish(value) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        if (channel) {
          channel.port1.onmessage = null;
          try { channel.port1.close(); channel.port2.close(); } catch (_) {}
        }
        if (operation.cancel === cancel) operation.cancel = null;
        resolve(workerUsed ? { response: value } : null);
      }
      function cancel() { finish(null); }
      operation.cancel = cancel;
      activeWorker().then(function (worker) {
        if (done) return;
        if (!worker || !current(operation)) { finish(null); return; }
        try {
          channel = new MessageChannel();
          channel.port1.onmessage = function (event) {
            var value = event.data;
            finish(value?.ok === true && validTotal(value.total) ? value : null);
          };
          channel.port1.start?.();
          workerUsed = true;
          worker.postMessage({ type: 'REFRESH_APP_BADGE' }, [channel.port2]);
        } catch (_) { finish(null); }
      }).catch(function () { finish(null); });
    });
  }
  // set/clearの完了順で以前の件数が復活しないよう、端末APIへの書込みを直列化する。
  function writeBadge(total, operation) {
    badgeWrites = badgeWrites.catch(function () {}).then(function () {
      if (operation && !current(operation)) return;
      if (total === 0 && typeof navigator.clearAppBadge === 'function') return navigator.clearAppBadge();
      if (typeof navigator.setAppBadge === 'function') return navigator.setAppBadge(total);
    }).catch(function () {});
    return badgeWrites;
  }
  async function update(operation) {
    var result = await askWorker(operation);
    if (!current(operation)) return null;
    // SWへ依頼した場合は、失敗やtimeoutでもwindowを別の書込み元にしない。
    if (result) return result.response;
    if (!canWriteBadge() || typeof window.apiRequest !== 'function') return null;
    var data = await window.apiRequest('/api/getAppBadge', { method: 'GET', dedupe: false });
    if (!current(operation) || !validTotal(data?.total)) return null;
    await writeBadge(data.total, operation);
    return current(operation) ? data : null;
  }
  function refresh(force) {
    var value = context();
    if (!value.allowed) {
      if (identity || pending) { invalidate(); identity = ''; }
      stopTimer();
      return Promise.resolve(null);
    }
    if (!visible()) return Promise.resolve(null);
    if (identity !== value.identity) { invalidate(); identity = value.identity; }
    schedule();
    if (pending) return pending.promise;
    if (force !== true && Date.now() - lastRequestAt < 30000) return Promise.resolve(null);
    var operation = { identity: identity, generation: generation, cancel: null, promise: null };
    pending = operation;
    lastRequestAt = Date.now();
    operation.promise = update(operation).catch(function () { return null; }).finally(function () {
      if (pending === operation) pending = null;
    });
    return operation.promise;
  }
  function clear() {
    invalidate(); identity = ''; stopTimer();
    var clearedGeneration = generation;
    var workerClear = activeWorker().then(function (worker) {
      if (generation === clearedGeneration && worker) worker.postMessage({ type: 'CLEAR_APP_BADGE' });
    }).catch(function () {});
    return Promise.all([workerClear, writeBadge(0)]);
  }

  document.addEventListener('visibilitychange', function () {
    if (visible()) refresh(true); else stopTimer();
  });
  window.addEventListener('focus', function () { refresh(true); });
  window.addEventListener('online', function () { refresh(true); });
  window.ShiftFlowAppBadge = { refresh: refresh, clear: clear };
  schedule();
})();
