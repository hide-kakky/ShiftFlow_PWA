import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-13T01:00:00Z');
const ORIGIN = 'https://shiftflow.example.invalid';
const OWNER_A = 'a'.repeat(64), OWNER_B = 'b'.repeat(64);
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const value = (overrides = {}) => ({ owner: OWNER_A, messageUnread: 3, taskOverdue: 2, total: 5,
  computedAt: NOW, sessionExpiresAt: NOW + 60000, ...overrides });
const response = (result, status = 200) => ({ status, ok: status >= 200 && status < 300,
  async json() { return { ok: true, result }; } });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

// transactionの完了とabortを再現し、timeout後の古いputがcommitしないことも検証する。
function metadataStore(initial = null) {
  const state = { current: copy(initial), writes: [], closed: 0, aborts: 0, holdWrites: 0,
    holdOpens: false, delayedWrites: [], delayedOpens: [] };
  state.api = { open() {
    const request = {};
    const open = () => {
      const db = {
        close() { state.closed++; },
        createObjectStore() {},
        transaction() {
          let aborted = false, completed = false;
          const transaction = {
            abort() {
              if (completed || aborted) return;
              aborted = true; state.aborts++;
              queueMicrotask(() => transaction.onabort?.());
            },
            objectStore() {
              return {
                get() {
                  const operation = {};
                  queueMicrotask(() => {
                    if (aborted) return;
                    operation.result = copy(state.current); operation.onsuccess?.();
                    completed = true; transaction.oncomplete?.();
                  });
                  return operation;
                },
                put(next) {
                  const operation = {}, saved = copy(next);
                  const commit = () => {
                    if (aborted || completed) return;
                    state.current = saved; state.writes.push(copy(saved));
                    operation.result = 'current'; operation.onsuccess?.();
                    completed = true; transaction.oncomplete?.();
                  };
                  if (state.holdWrites > 0) { state.holdWrites--; state.delayedWrites.push(commit); }
                  else queueMicrotask(commit);
                  return operation;
                },
              };
            },
          };
          return transaction;
        },
      };
      request.result = db; request.onsuccess?.();
    };
    if (state.holdOpens) state.delayedOpens.push(open); else queueMicrotask(open);
    return request;
  } };
  state.releaseWrites = () => { for (const commit of state.delayedWrites.splice(0)) commit(); };
  state.releaseOpens = () => { for (const open of state.delayedOpens.splice(0)) open(); };
  return state;
}

function worker(options = {}) {
  const handlers = {}, calls = [], badges = [], shown = [], timers = new Map();
  let now = NOW, nextTimer = 0;
  const navigator = {};
  if (!options.unsupported) {
    navigator.setAppBadge = async count => { badges.push({ set: count }); return options.setBadge?.(count); };
    if (!options.noClear) navigator.clearAppBadge = async () => { badges.push({ clear: true }); };
  }
  const self = { location: { origin: ORIGIN }, navigator,
    registration: { showNotification(title, details) { shown.push({ title, details }); return Promise.resolve(); } },
    addEventListener(type, handler) { handlers[type] = handler; },
    clients: { matchAll: async () => [], openWindow: async () => {} },
  };
  if (options.storage) self.indexedDB = options.storage.api;
  const Clock = class extends Date { static now() { return now; } };
  vm.runInNewContext(source, { self, URL, AbortController, Date: Clock, Promise, console,
    fetch(url, request) {
      calls.push({ url, request });
      return Promise.resolve().then(() => options.fetch ? options.fetch(calls.length, url, request) : response(value()));
    },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function message(type, sourceUrl = ORIGIN + '/index.html') {
    const replies = []; let completion;
    handlers.message({ data: { type }, source: { url: sourceUrl },
      ports: [{ postMessage(reply) { replies.push(copy(reply)); } }], waitUntil(promise) { completion = promise; } });
    return { replies, completion: Promise.resolve(completion) };
  }
  function push(payload, broken = false) {
    let completion;
    handlers.push({ data: payload === null ? null : { json() { if (broken) throw new SyntaxError('broken'); return payload; } },
      waitUntil(promise) { completion = promise; } });
    return completion;
  }
  return { calls, badges, shown, message, push,
    async refresh() { const operation = message('REFRESH_APP_BADGE'); await operation.completion; return operation.replies[0]; },
    async clear() { await message('CLEAR_APP_BADGE').completion; },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await settle();
    },
  };
}

test('SWは認証付きGET/no-storeで絶対件数を取得し、永続化は本人と時刻だけに限定する', async () => {
  const storage = metadataStore(), sw = worker({ storage });
  assert.deepEqual(await sw.refresh(), { ok: true, total: 5 });
  const call = sw.calls[0];
  assert.equal(String(call.url), ORIGIN + '/api/getAppBadge');
  assert.equal(call.request.method || 'GET', 'GET'); assert.equal(call.request.credentials, 'include');
  assert.equal(call.request.cache, 'no-store'); assert.equal(call.request.headers.Accept, 'application/json');
  assert.deepEqual(sw.badges, [{ set: 5 }]);
  assert.deepEqual(storage.current, { owner: OWNER_A, computedAt: NOW, sessionExpiresAt: NOW + 60000 });
  assert.deepEqual(Object.keys(storage.current).sort(), ['computedAt', 'owner', 'sessionExpiresAt']);
});

test('0件ではclearし、clearAppBadgeがない環境はsetAppBadge(0)で消去する', async () => {
  for (const noClear of [false, true]) {
    const sw = worker({ noClear, fetch: () => response(value({ messageUnread: 0, taskOverdue: 0, total: 0 })) });
    assert.deepEqual(await sw.refresh(), { ok: true, total: 0 });
    assert.deepEqual(sw.badges, [noClear ? { set: 0 } : { clear: true }]);
  }
});

test('件数は加算せず置き換え、同じ本人の古いAPI応答は採用しない', async () => {
  const results = [value(), value({ messageUnread: 1, taskOverdue: 0, total: 1, computedAt: NOW + 1 }), value()];
  const sw = worker({ fetch: () => response(results.shift()) });
  await sw.refresh(); await sw.refresh();
  assert.deepEqual(await sw.refresh(), { ok: false });
  assert.deepEqual(sw.badges, [{ set: 5 }, { set: 1 }]);
});

test('同じworkerで認証API成功後なら、通信できないpushの有効で新しい本人件数を使う', async () => {
  const storage = metadataStore();
  const sw = worker({ storage, fetch(index) { if (index === 1) return response(value()); throw new Error('offline'); } });
  await sw.refresh();
  await sw.push({ appBadge: value({ messageUnread: 1, taskOverdue: 0, total: 1, computedAt: NOW + 1 }) });
  assert.equal(sw.shown.length, 1); assert.deepEqual(sw.badges, [{ set: 5 }, { set: 1 }]);
});

test('認証済みworkerでもpayload fallbackの本人不一致・失効・10分超・古い件数・不正値を拒否する', async () => {
  const cases = [
    { payload: value({ owner: OWNER_B }) },
    { initial: value({ sessionExpiresAt: NOW + 1 }), advance: 1, payload: value({ computedAt: NOW + 1 }) },
    { payload: value({ sessionExpiresAt: NOW }) },
    { initial: value({ computedAt: NOW - 700000 }), payload: value({ computedAt: NOW - 600001 }) },
    { payload: value({ computedAt: NOW - 1 }) },
    { payload: value({ computedAt: NOW + 60001 }) },
    { payload: value({ total: 99 }) },
    { payload: value({ total: '5' }) },
  ];
  for (const entry of cases) {
    const sw = worker({ storage: metadataStore(), fetch(index) {
      if (index === 1) return response(entry.initial || value());
      throw new Error('offline');
    } });
    await sw.refresh(); sw.badges.length = 0;
    if (entry.advance) await sw.advance(entry.advance);
    await sw.push({ appBadge: entry.payload });
    assert.equal(sw.shown.length, 1); assert.deepEqual(sw.badges, [], JSON.stringify(entry));
  }
});

test('worker再起動後のofflineでは同じ本人の永続metadataだけでpayload件数を適用しない', async () => {
  const storage = metadataStore({ owner: OWNER_A, computedAt: NOW - 1, sessionExpiresAt: NOW + 60000 });
  const sw = worker({ storage, fetch() { throw new Error('offline'); } });
  await sw.push({ appBadge: value() });
  assert.equal(sw.shown.length, 1); assert.deepEqual(sw.badges, []);
});

test('認証APIで本人が切り替われば新本人を採用し、旧本人payloadへ戻さない', async () => {
  const storage = metadataStore({ owner: OWNER_A, computedAt: NOW, sessionExpiresAt: NOW + 60000 });
  const sw = worker({ storage, fetch(index) {
    if (index === 1) return response(value({ owner: OWNER_B, messageUnread: 1, taskOverdue: 0, total: 1 }));
    throw new Error('offline');
  } });
  await sw.refresh();
  await sw.push({ appBadge: value({ computedAt: NOW + 1 }) });
  assert.deepEqual(sw.badges, [{ set: 1 }]);
  await sw.push({ appBadge: value({ owner: OWNER_B, computedAt: NOW + 2 }) });
  assert.deepEqual(sw.badges, [{ set: 1 }, { set: 5 }]); assert.equal(storage.current.owner, OWNER_B);
});

test('401/403は件数と保存済み本人を消し、有効そうなpush payloadにもfallbackしない', async () => {
  for (const status of [401, 403]) {
    const storage = metadataStore({ owner: OWNER_A, computedAt: NOW - 1, sessionExpiresAt: NOW + 60000 });
    const sw = worker({ storage, fetch: () => response(null, status) });
    await sw.push({ appBadge: value() });
    assert.deepEqual(sw.badges, [{ clear: true }]);
    assert.equal(storage.current.owner, ''); assert.equal(storage.current.sessionExpiresAt, 0);
  }
});

test('5xxや壊れたAPI JSONでは0件へ変換せず、保存済みの本人・時刻も巻き戻さない', async () => {
  const saved = { owner: OWNER_A, computedAt: NOW - 1, sessionExpiresAt: NOW + 60000 };
  for (const fetch of [() => response(null, 503), () => ({ ok: true, status: 200, json() { throw new SyntaxError('broken'); } })]) {
    const storage = metadataStore(saved), sw = worker({ storage, fetch });
    assert.deepEqual(await sw.refresh(), { ok: false });
    assert.deepEqual(sw.badges, []); assert.deepEqual(storage.current, saved);
  }
});

test('不正な認証API件数・合計不一致・失効したsessionの応答を適用しない', async () => {
  for (const payload of [value({ total: -1 }), value({ messageUnread: '3' }), value({ total: 4 }),
    value({ owner: 'invalid' }), value({ computedAt: NOW + 60001 }), value({ sessionExpiresAt: NOW })]) {
    const sw = worker({ fetch: () => response(payload) });
    assert.deepEqual(await sw.refresh(), { ok: false }); assert.deepEqual(sw.badges, []);
  }
});

test('ログアウト時のCLEARは取得中の旧本人応答を破棄し、新本人の取得を妨げない', async () => {
  const old = deferred(), storage = metadataStore();
  const sw = worker({ storage, fetch(index) { return index === 1 ? old.promise
    : response(value({ owner: OWNER_B, messageUnread: 1, taskOverdue: 0, total: 1 })); } });
  const pending = sw.message('REFRESH_APP_BADGE'); await settle();
  await sw.clear(); await sw.refresh(); old.resolve(response(value())); await pending.completion;
  assert.deepEqual(pending.replies, [{ ok: false }]);
  assert.deepEqual(sw.badges, [{ clear: true }, { set: 1 }]); assert.equal(storage.current.owner, OWNER_B);
});

test('並行REFRESHとpushの件数取得を合流し、可視通知は待たずに表示する', async () => {
  const delayed = deferred(), sw = worker({ fetch: () => delayed.promise });
  const first = sw.message('REFRESH_APP_BADGE'), second = sw.message('REFRESH_APP_BADGE');
  const pushed = sw.push({ body: '新しいメッセージがあります', appBadge: value() });
  assert.equal(sw.shown.length, 1); assert.deepEqual(sw.badges, []);
  await settle(); assert.equal(sw.calls.length, 1);
  delayed.resolve(response(value())); await Promise.all([first.completion, second.completion, pushed]);
  assert.deepEqual(first.replies, [{ ok: true, total: 5 }]); assert.deepEqual(second.replies, first.replies);
  assert.deepEqual(sw.badges, [{ set: 5 }]);
});

test('進行中のOS件数書込みより後にCLEARを実行し、最後に旧件数を残さない', async () => {
  const held = deferred(), sw = worker({ setBadge: () => held.promise });
  const pending = sw.message('REFRESH_APP_BADGE'); await settle();
  const clearing = sw.message('CLEAR_APP_BADGE'); await settle();
  assert.deepEqual(sw.badges, [{ set: 5 }]);
  held.resolve(); await Promise.all([pending.completion, clearing.completion]);
  assert.deepEqual(sw.badges, [{ set: 5 }, { clear: true }]);
});

test('API timeoutは2.5秒でfetchをabortし、次の更新を再試行できる', async () => {
  const held = deferred(), sw = worker({ fetch: index => index === 1 ? held.promise : response(value()) });
  const pending = sw.message('REFRESH_APP_BADGE'); await settle();
  await sw.advance(2499); assert.equal(pending.replies.length, 0);
  await sw.advance(1); await pending.completion;
  assert.deepEqual(pending.replies, [{ ok: false }]); assert.equal(sw.calls[0].request.signal.aborted, true);
  assert.deepEqual(await sw.refresh(), { ok: true, total: 5 }); assert.deepEqual(sw.badges, [{ set: 5 }]);
});

test('HTTPヘッダー受信後にJSON本文が停止してもtimeoutで処理を解放する', async () => {
  const body = deferred(), sw = worker({ fetch: () => ({ ok: true, status: 200, json: () => body.promise }) });
  const pending = sw.message('REFRESH_APP_BADGE'); await settle(); await sw.advance(2500); await pending.completion;
  assert.deepEqual(pending.replies, [{ ok: false }]); assert.equal(sw.calls[0].request.signal.aborted, true);
  body.resolve({ ok: true, result: value() }); await settle(); assert.deepEqual(sw.badges, []);
});

test('IndexedDBが開かなくても500msで進み、遅れて開いた接続を閉じる', async () => {
  const storage = metadataStore(); storage.holdOpens = true;
  const sw = worker({ storage }), pending = sw.message('REFRESH_APP_BADGE'); await settle();
  await sw.advance(500); await sw.advance(500); await pending.completion;
  assert.deepEqual(sw.badges, [{ set: 5 }]);
  storage.releaseOpens(); assert.equal(storage.closed, 2); assert.deepEqual(storage.writes, []);
  const clearing = sw.message('CLEAR_APP_BADGE'); await settle(); await sw.advance(500); await clearing.completion;
  assert.deepEqual(sw.badges, [{ set: 5 }, { clear: true }]);
});

test('timeoutしたIDB書込みをabortし、CLEAR後の遅いcommitで旧本人を復活させない', async () => {
  const storage = metadataStore({ owner: OWNER_A, computedAt: NOW - 1, sessionExpiresAt: NOW + 60000 });
  storage.holdWrites = 1;
  const sw = worker({ storage }), pending = sw.message('REFRESH_APP_BADGE'); await settle();
  assert.equal(storage.delayedWrites.length, 1);
  await sw.advance(500); await pending.completion; await sw.clear();
  assert.ok(storage.aborts >= 1); assert.equal(storage.current.owner, '');
  storage.releaseWrites(); assert.equal(storage.current.owner, '');
  const restarted = worker({ storage, fetch() { throw new Error('offline'); } });
  await restarted.push({ appBadge: value() });
  assert.equal(restarted.shown.length, 1); assert.deepEqual(restarted.badges, []);
});

test('CLEARの保存が失敗して旧metadataが残っても、再起動後offlineで旧本人件数を復活させない', async () => {
  const storage = metadataStore({ owner: OWNER_A, computedAt: NOW - 1, sessionExpiresAt: NOW + 60000 });
  const sw = worker({ storage }); await sw.refresh();
  storage.holdWrites = 1;
  const clearing = sw.message('CLEAR_APP_BADGE'); await settle(); await sw.advance(500); await clearing.completion;
  assert.equal(storage.current.owner, OWNER_A); assert.deepEqual(sw.badges, [{ set: 5 }, { clear: true }]);
  const restarted = worker({ storage, fetch() { throw new Error('offline'); } });
  await restarted.push({ appBadge: value() });
  assert.equal(restarted.shown.length, 1); assert.deepEqual(restarted.badges, []);
});

test('Badging API未対応でも壊れたpushを可視通知にし、不要な件数通信はしない', async () => {
  const sw = worker({ unsupported: true });
  await sw.push({}, true); await sw.push(null);
  assert.equal(sw.shown.length, 2); assert.equal(sw.calls.length, 0); assert.deepEqual(sw.badges, []);
  assert.deepEqual(await sw.refresh(), { ok: false }); await sw.clear();
});

test('他originのmessageでは件数の取得や消去を実行しない', async () => {
  const sw = worker();
  await sw.message('REFRESH_APP_BADGE', 'https://other.invalid/').completion;
  await sw.message('CLEAR_APP_BADGE', 'https://other.invalid/').completion;
  assert.deepEqual(sw.badges, []); assert.equal(sw.calls.length, 0);
});
