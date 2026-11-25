import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const sw = readFileSync(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
const config = readFileSync(new URL('../frontend/public/app-config.js', import.meta.url), 'utf8');
const versionFn = html.slice(html.indexOf('      function parseVersionSegments('), html.indexOf('      function cloneDeep('));
const noticeFn = html.slice(html.indexOf('      function startAppUpdateNotice('), html.indexOf('      var HISTORY_GUARD_ACTIVE'));
function fixture() {
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
  const nodes = {
    'app-update-notice': { hidden: true },
    'app-update-version': { textContent: '' },
    'app-update-now': new EventTarget(),
  };
  const runtime = vm.createContext({
    navigator: { serviceWorker }, document, APP_VERSION_LABEL: '2.3.0',
    CURRENT_VIEW: 'home', byId: key => nodes[key],
    MutationObserver: class {
      constructor(cb) { invalidated = cb; }
      observe() {}
      disconnect() {}
    },
    window: { location: { reload() { reloads++; } }, requestAnimationFrame: cb => frames.push(cb) },
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
  };
}

test('稼働版の通知は新しい場合だけ案内し、押した画面だけを一度再読み込みする', () => {
  const a = fixture(), b = fixture();
  assert.equal(a.worker.requests[0].type, 'SHIFT_FLOW_GET_APP_VERSION');
  a.report('2.3.1', {});
  a.report('2.3.0');
  assert.equal(a.nodes['app-update-notice'].hidden, true);
  a.report('2.3.1');
  b.report('2.3.1');
  assert.equal(a.nodes['app-update-notice'].hidden, false);
  assert.match(a.nodes['app-update-version'].textContent, /2\.3\.1/);
  a.click();
  a.click();
  assert.equal(a.reloads(), 1);
  assert.equal(b.reloads(), 0);
  assert.doesNotMatch(noticeFn, /fetch\(|performLogout|localStorage|sessionStorage|caches\.|unregister/);
});

test('編集中は案内と再読み込みを止め、画面遷移とロールバックにも追随する', () => {
  const a = fixture();
  a.document.querySelector = () => ({});
  a.report('2.3.1');
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
