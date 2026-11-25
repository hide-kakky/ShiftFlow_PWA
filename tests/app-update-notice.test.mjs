import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../frontend/public/app-config.js', import.meta.url), 'utf8');
const versionFn = html.slice(html.indexOf('      function parseVersionSegments('), html.indexOf('      function cloneDeep('));
const noticeFn = html.slice(html.indexOf('      function startAppUpdateNotice('), html.indexOf('      var HISTORY_GUARD_ACTIVE'));
function fixture({ storage = new Map(), pageVersion = '2.3.10', navigationType = 'navigate' } = {}) {
  const worker = { requests: [], postMessage(x) { this.requests.push(x); } };
  const serviceWorker = new EventTarget();
  serviceWorker.controller = worker;
  serviceWorker.ready = Promise.resolve({});
  serviceWorker.getRegistration = async () => ({ update() {} });
  const document = new EventTarget();
  document.body = { classList: { contains: () => false } };
  document.activeElement = null;
  document.querySelector = () => null;
  let reloads = 0;
  let invalidated = () => {};
  const frames = [];
  const timers = new Map();
  let timerId = 0;
  const nodes = {
    'app-update-notice': { hidden: true },
    'app-update-version': { textContent: '' },
    'app-update-now': new EventTarget(),
    'app-update-complete': { hidden: true, textContent: '' },
  };
  const runtime = vm.createContext({
    navigator: { serviceWorker }, document, APP_VERSION_LABEL: pageVersion,
    sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)},
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    CURRENT_VIEW: 'home', byId: key => nodes[key],
    MutationObserver: class {
      constructor(cb) { invalidated = cb; }
      observe() {}
      disconnect() {}
    },
    window: { performance: {getEntriesByType: () => [{type: navigationType}]}, location: { reload() { reloads++; } }, requestAnimationFrame: cb => frames.push(cb) },
  });
  vm.runInContext(versionFn + noticeFn + '\nstartAppUpdateNotice();', runtime);
  function flush() { while (frames.length) frames.shift()(); }
  function report(version, source = worker) {
    serviceWorker.dispatchEvent(Object.assign(new Event('message'), {
      source, data: { type: 'SHIFT_FLOW_APP_VERSION', version },
    }));
    flush();
  }
  return {
    nodes, report, worker, serviceWorker, runtime, document,
    flush, invalidate: () => invalidated(),
    click: () => nodes['app-update-now'].dispatchEvent(new Event('click')),
    reloads: () => reloads,
    timers, storage,
    expire(delay) { for (const [id, item] of timers) if (item.delay === delay) { timers.delete(id); item.callback(); } flush(); },
  };
}

test('稼働版の通知は新しい場合だけ案内し、押した画面だけを一度再読み込みする', () => {
  const a = fixture(), b = fixture();
  assert.equal(a.worker.requests[0].type, 'SHIFT_FLOW_GET_APP_VERSION');
  a.report('2.3.11', {});
  a.report('2.3.10');
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  a.report('2.3.11');
  b.report('2.3.11');
  assert.equal(a.nodes['app-update-notice'].hidden, false);
  assert.equal(a.nodes['app-update-version'].textContent, '新しいバージョン（2.3.11）を利用できます。');
  a.click();
  a.click();
  assert.equal(a.reloads(), 1);
  assert.equal(b.reloads(), 0);
  assert.doesNotMatch(noticeFn, /fetch\(|performLogout|localStorage|sessionStorage\.clear|caches\.|unregister/);
});

test('編集中は案内と再読み込みを止め、画面遷移とロールバックにも追随する', () => {
  const a = fixture();
  a.document.querySelector = () => ({});
  a.report('2.3.11');
  a.click();
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  assert.equal(a.reloads(), 0);
  a.document.querySelector = () => null;
  a.document.activeElement = { closest: () => ({}) };
  a.invalidate(); a.flush();
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  a.document.activeElement = null;
  a.invalidate(); a.flush();
  assert.equal(a.nodes['app-update-notice'].hidden, false);
  a.runtime.CURRENT_VIEW = 'settings';
  a.invalidate(); a.flush();
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  a.runtime.CURRENT_VIEW = 'home';
  a.serviceWorker.dispatchEvent(new Event('controllerchange'));
  a.invalidate(); a.flush();
  assert.equal(a.nodes['app-update-notice'].hidden, true);
});

test('更新案内は15秒で消え、同じ版が通知されても再表示しない', () => {
  const a = fixture();
  a.report('2.3.11');
  assert.equal(a.nodes['app-update-notice'].hidden, false);
  a.expire(15000);
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  a.report('2.3.11');
  a.click();
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  assert.equal(a.reloads(), 0);
  a.report('2.3.12');
  assert.equal(a.nodes['app-update-notice'].hidden, false);
});

test('新版を実際に読み込んでから完了を表示し、3.2秒で消える', () => {
  const a = fixture();
  a.report('2.3.11');
  a.click();
  assert.doesNotMatch(a.nodes['app-update-version'].textContent, /更新されました/);
  const b = fixture({ storage: a.storage, pageVersion: '2.3.11' });
  b.report('2.3.10');
  assert.equal(b.nodes['app-update-notice'].hidden, true);
  b.report('2.3.11');
  assert.equal(b.nodes['app-update-notice'].hidden, true);
  assert.equal(b.nodes['app-update-complete'].hidden, false);
  assert.match(b.nodes['app-update-complete'].textContent, /更新されました（2\.3\.11）/);
  b.expire(3200);
  b.report('2.3.11');
  assert.equal(b.nodes['app-update-complete'].hidden, true);
});

test('旧版からの初回再読み込みは実際に読み込んだ新版を一度だけ伝える', () => {
  const a = fixture({ pageVersion: '2.3.11', navigationType: 'reload' });
  a.report('2.3.11');
  assert.equal(a.nodes['app-update-complete'].textContent, '最新版 2.3.11 を読み込みました');
  a.expire(3200);
  const b = fixture({ storage: a.storage, pageVersion: '2.3.11', navigationType: 'reload' });
  b.report('2.3.11');
  assert.equal(b.nodes['app-update-complete'].hidden, true);
});

test('旧版の再ログイン通知を送らず、二つの公開ファイルの版を一致させる', () => {
  assert.doesNotMatch(html + sw, /APP_SHELL_UPDATED|最新版を取得（再ログイン）|forceReloadLatestVersion/);
  const workerVersion = sw.match(/const APP_VERSION = '([^']+)'/)[1];
  assert.equal(config.match(/APP_VERSION: '([^']+)'/)[1], workerVersion);
  const handlers = {};
  vm.runInNewContext(sw, {self: {
    location: { origin: 'https://app.example' }, addEventListener: (type, cb) => handlers[type] = cb,
  }, URL, Promise, Map});
  const probe = [];
  handlers.message({ source: { url: 'https://app.example/', postMessage: msg => probe.push(msg) },
    data: { type: 'SHIFT_FLOW_GET_APP_VERSION' } });
  assert.equal(probe.length, 1);
  assert.equal(probe[0].type, 'SHIFT_FLOW_APP_VERSION');
  assert.equal(probe[0].version, workerVersion);
});
