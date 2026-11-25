import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../frontend/public/app-badge.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function ui(options = {}) {
  const context = { identity: 'user-a', allowed: false };
  const calls = [], messages = [], channels = [], timers = new Map();
  const events = { window: {}, document: {} };
  let now = 1000, nextTimer = 0;
  const document = { visibilityState: 'visible', addEventListener(type, listener) { events.document[type] = listener; } };
  const worker = { postMessage(message, ports) { messages.push({ message, port: ports?.[0] }); options.worker?.(message, ports?.[0]); } };
  const navigator = {};
  if (!options.unsupported) {
    navigator.setAppBadge = async total => { calls.push({ badge: total }); return options.setBadge?.(total); };
    navigator.clearAppBadge = async () => { calls.push({ clear: true }); return options.clearBadge?.(); };
  }
  if (options.sw) navigator.serviceWorker = options.registrationOnly
    ? { getRegistration: async () => options.noActive ? {} : { active: worker } }
    : { controller: worker };
  class Channel {
    constructor() {
      const channel = this;
      this.port1 = { onmessage: null, start() {}, close() { this.closed = true; } };
      this.port2 = { postMessage(data) { channel.port1.onmessage?.({ data }); }, close() { this.closed = true; } };
      channels.push(this);
    }
  }
  const window = {
    __SHIFT_FLOW_BADGE_CONTEXT__: () => context,
    apiRequest(path, request) {
      calls.push({ path, request });
      return Promise.resolve(options.request ? options.request(path, request) : { owner: 'owner-a', total: 4 });
    },
    addEventListener(type, listener) { events.window[type] = listener; },
  };
  const Clock = class extends Date { static now() { return now; } };
  const globals = { window, document, navigator, Date: Clock, Promise, Number, console,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  if (!options.noChannel) globals.MessageChannel = Channel;
  vm.runInNewContext(source, globals);
  assert.equal(typeof window.ShiftFlowAppBadge?.refresh, 'function', 'バッジ更新の公開APIが必要');
  assert.equal(typeof window.ShiftFlowAppBadge?.clear, 'function', 'バッジ消去の公開APIが必要');
  context.allowed = options.allowed !== false;
  return { context, calls, messages, channels, document, badge: window.ShiftFlowAppBadge,
    async event(type, target = 'window') { events[target][type]?.(); await settle(); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await settle();
    },
    get requests() { return calls.filter(call => call.path); },
    get badges() { return calls.filter(call => 'badge' in call || call.clear); },
  };
}

test('未認証・非表示では件数を取得せず、未対応端末でも安全に終了する', async () => {
  const page = ui({ allowed: false });
  await page.badge.refresh(true);
  page.context.allowed = true; page.document.visibilityState = 'hidden';
  await page.badge.refresh(true); await page.event('online'); await page.advance(60000);
  assert.equal(page.requests.length, 0); assert.equal(page.badges.length, 0);
  const unsupported = ui({ unsupported: true });
  await unsupported.badge.refresh(); await unsupported.badge.clear();
  assert.equal(unsupported.requests.length, 0);
});

test('SWなしでは絶対件数を適用し、0で消去する', async () => {
  let total = 7;
  const page = ui({ request: () => ({ total }) });
  await page.badge.refresh();
  assert.equal(page.requests[0].path, '/api/getAppBadge');
  assert.equal(page.requests[0].request.method, 'GET'); assert.equal(page.requests[0].request.dedupe, false);
  assert.deepEqual(page.badges, [{ badge: 7 }]);
  total = 0; await page.badge.refresh(true);
  assert.deepEqual(page.badges, [{ badge: 7 }, { clear: true }]);
});

test('通信失敗と不正件数を0扱いせず、表示済み件数を保持する', async () => {
  let response = { total: 5 };
  const page = ui({ request() { if (response instanceof Error) throw response; return response; } });
  await page.badge.refresh();
  for (const bad of [new Error('offline'), { total: -1 }, { total: '3' }, { total: NaN }, {}]) {
    response = bad; await page.badge.refresh(true);
  }
  assert.deepEqual(page.badges, [{ badge: 5 }]);
});

test('同一取得はforceでも合流し、通常更新は30秒抑制、forceは抑制を無視する', async () => {
  const delayed = deferred();
  const page = ui({ request: () => delayed.promise });
  const first = page.badge.refresh(), second = page.badge.refresh(true);
  assert.equal(first, second);
  await settle(); assert.equal(page.requests.length, 1);
  delayed.resolve({ total: 2 }); await first;
  await page.badge.refresh(); await page.advance(29999); await page.badge.refresh();
  assert.equal(page.requests.length, 1);
  await page.advance(1); await page.badge.refresh(); assert.equal(page.requests.length, 2);
  await page.badge.refresh(true); assert.equal(page.requests.length, 3);
});

test('別本人へ切り替えたら古い取得と合流せず、遅い旧本人の件数を適用しない', async () => {
  const old = deferred(); let count = 0;
  const page = ui({ request: () => ++count === 1 ? old.promise : { total: 1 } });
  const pending = page.badge.refresh(); await settle();
  page.context.identity = 'user-b'; await page.badge.refresh();
  old.resolve({ total: 99 }); await pending;
  assert.equal(page.requests.length, 2); assert.deepEqual(page.badges, [{ badge: 1 }]);
});

test('clearで遅延取得を無効化し、直後の再取得も古いpendingに妨げられない', async () => {
  const old = deferred(); let count = 0;
  const page = ui({ request: () => ++count === 1 ? old.promise : { total: 3 } });
  const pending = page.badge.refresh(); await settle(); await page.badge.clear();
  await page.badge.refresh(); old.resolve({ total: 42 }); await pending;
  assert.deepEqual(page.badges, [{ clear: true }, { badge: 3 }]);
});

test('取得中に認証が無効になった場合も古い件数を適用しない', async () => {
  const delayed = deferred(); const page = ui({ request: () => delayed.promise });
  const pending = page.badge.refresh(); await settle(); page.context.allowed = false;
  delayed.resolve({ total: 4 }); await pending;
  assert.equal(page.badges.length, 0);
});

test('active SWへMessageChannelで依頼し、成功時にwindowで二重適用しない', async () => {
  const page = ui({ sw: true, registrationOnly: true, worker(message, port) {
    if (message.type === 'REFRESH_APP_BADGE') port.postMessage({ ok: true, total: 6 });
  } });
  await page.badge.refresh();
  assert.equal(page.messages[0].message.type, 'REFRESH_APP_BADGE');
  assert.equal(page.requests.length, 0); assert.equal(page.badges.length, 0);
  assert.equal(page.channels[0].port1.closed, true);
  await page.badge.clear(); assert.equal(page.messages.at(-1).message.type, 'CLEAR_APP_BADGE');
  assert.deepEqual(page.badges, [{ clear: true }]);
});

test('SWが3秒応答しなくてもwindowから適用せず、遅い応答を無視して次回再取得できる', async () => {
  let respond = false;
  const page = ui({ sw: true, worker(message, port) { if (respond) port?.postMessage({ ok: true, total: 8 }); } });
  const pending = page.badge.refresh(); await settle();
  await page.advance(2999); assert.equal(page.requests.length, 0);
  await page.advance(1); assert.equal(await pending, null); assert.equal(page.requests.length, 0);
  page.channels[0].port2.postMessage({ ok: true, total: 99 });
  assert.deepEqual(page.badges, []);
  respond = true; await page.badge.refresh(true);
  assert.equal(page.messages.length, 2); assert.equal(page.requests.length, 0); assert.deepEqual(page.badges, []);
});

test('clearはSW待機を取り消し、タイムアウト後もfallbackを実行しない', async () => {
  const page = ui({ sw: true }); const pending = page.badge.refresh(); await settle();
  await page.badge.clear(); await pending; await page.advance(3000);
  assert.equal(page.requests.length, 0); assert.deepEqual(page.badges, [{ clear: true }]);
  assert.equal(page.channels[0].port1.closed, true);
});

test('MessageChannel不在だけAPIへfallbackし、SW失敗応答ではwindowを別writerにしない', async () => {
  const missing = ui({ sw: true, noChannel: true }); await missing.badge.refresh();
  assert.equal(missing.requests.length, 1); assert.equal(missing.messages.length, 0);
  const failed = ui({ sw: true, worker(message, port) { port?.postMessage({ ok: false }); } });
  assert.equal(await failed.badge.refresh(), null); assert.deepEqual(failed.badges, []); assert.equal(failed.requests.length, 0);
});

test('SW登録があってもactive workerがなければwindowから絶対件数を適用する', async () => {
  const page = ui({ sw: true, registrationOnly: true, noActive: true });
  await page.badge.refresh();
  assert.equal(page.messages.length, 0); assert.equal(page.requests.length, 1); assert.deepEqual(page.badges, [{ badge: 4 }]);
});

test('可視中だけ60秒更新し、復帰・focus・onlineでは抑制を無視する', async () => {
  const page = ui(); await page.badge.refresh(); await page.advance(60000);
  assert.equal(page.requests.length, 2);
  page.document.visibilityState = 'hidden'; await page.event('visibilitychange', 'document');
  await page.event('focus'); await page.event('online'); await page.advance(120000);
  assert.equal(page.requests.length, 2);
  page.document.visibilityState = 'visible'; await page.event('visibilitychange', 'document');
  assert.equal(page.requests.length, 3);
  await page.event('focus'); await page.event('online'); assert.equal(page.requests.length, 5);
  page.context.allowed = false; await page.advance(60000); assert.equal(page.requests.length, 5);
});

test('既に進行中のBadge API処理とclearを直列化し、旧件数を最後に残さない', async () => {
  const held = deferred(); let first = true;
  const page = ui({ setBadge() { if (first) { first = false; return held.promise; } } });
  const pending = page.badge.refresh(); await settle();
  const clearing = page.badge.clear(); await settle();
  assert.deepEqual(page.badges, [{ badge: 4 }]);
  held.resolve(); await Promise.all([pending, clearing]);
  assert.deepEqual(page.badges, [{ badge: 4 }, { clear: true }]);
});
