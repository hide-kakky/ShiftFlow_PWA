import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const i18n = await readFile(new URL('../frontend/public/i18n.js', import.meta.url), 'utf8');
function block(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return html.slice(from, to);
}
const listener = block("document.addEventListener('shiftflow:languagechange', function () {\n        updateViewHeader(CURRENT_VIEW);", 'function showPanel');
const homeLoader = block('function loadHome(options)', '// ===== Tasks =====');

function setup({ view = 'home', active = false, blocked = false } = {}) {
  const events = new Map(), notices = [], calls = { headers: 0, cards: 0, homeApi: 0, messages: 0 };
  const elements = new Map();
  const sandbox = {
    navigator: { language: 'ja-JP' }, localStorage: { getItem() { return null; }, setItem() {} },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    document: {
      readyState: 'loading', documentElement: {}, querySelectorAll() { return []; }, getElementById() { return null; },
      addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
      dispatchEvent(event) { (events.get(event.type) || []).forEach(fn => fn(event)); },
    },
    HAS_ACTIVE_EMAIL: active, PRIVATE_STORAGE_BLOCKED: blocked, AUTH_NOTICE_SHOWN: false,
    AUTH_NOTICE_MESSAGE: 'Google でログインしてから再試行してください。',
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: view, ACTIVE_TASK_TAB: 'my', HOME_LOAD_REQUEST_ID: 0, LAST_HOME_FETCH_AT: 0,
    HOME_SOURCE: { identity: '', payload: null, inflight: null }, MESSAGE_SOURCE: { renderedRows: 'previous' },
    resolveCurrentIdentity() { return 'fixture-account'; },
    updateViewHeader() { calls.headers++; }, syncTaskScopeHeader() {}, syncMessageToolbarLabels() {},
    awaitAuthIdentityGate: async () => {}, loadHomeFromCache: async () => null,
    cacheHomePayload: async () => {}, primeMessagesFromHome() {}, renderHomeView() {},
    shouldThrottleFetch: () => false, skel: () => 'loading',
    authRequiredCard() { calls.cards++; return 'login'; },
    notify(message) { notices.push(message); },
    byId(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '' }); return elements.get(id); },
    loadMessages() { calls.messages++; },
    google: { script: { get run() {
      const chain = { withSuccessHandler(fn) { chain.success = fn; return chain; }, withFailureHandler() { return chain; },
        getHomeContent() { calls.homeApi++; chain.success({ tasks: [], messages: [] }); } };
      return chain;
    } } },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  runInNewContext(homeLoader + listener + i18n, sandbox);
  return { sandbox, calls, notices, events };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('DOMContentLoadedの実I18n初期化は、認証確認前にログインエラーや業務取得を発生させない', async () => {
  const s = setup();
  s.sandbox.document.dispatchEvent({ type: 'DOMContentLoaded' }); await settle();
  assert.equal(s.calls.headers, 1, '見出しの翻訳は初期化する');
  assert.deepEqual(s.notices, [], '認証未確認を未ログイン扱いで通知しない');
  assert.equal(s.calls.cards, 0, '未ログイン用カードへ置き換えない');
  assert.equal(s.calls.homeApi, 0);
  s.sandbox.HAS_ACTIVE_EMAIL = true;
  await s.sandbox.loadHome(); await settle();
  assert.equal(s.calls.homeApi, 1, '通常のbootstrap完了後にホームを取得できる');
  assert.deepEqual(s.notices, [], 'ログイン確認後にも誤案内が残らない');
});

test('本人bootstrap前のlanguageイベントも認証済みsessionだけで業務表示を開始しない', async () => {
  const s = setup(); s.sandbox.AUTH_SESSION = { authenticated: true, user: { email: 'fixture@example.invalid' } };
  s.sandbox.I18n.init(); await settle();
  assert.equal(s.calls.homeApi, 0); assert.deepEqual(s.notices, []);
});

test('本人bootstrap後の言語変更はホームを更新する', async () => {
  const s = setup({ active: true });
  s.sandbox.I18n.setLanguage('en'); await settle();
  assert.equal(s.calls.headers, 1); assert.equal(s.calls.homeApi, 1); assert.deepEqual(s.notices, []);
  assert.equal(s.sandbox.document.documentElement.lang, 'en');
});

test('メッセージの言語変更は本人確認後だけ再描画し、確認前のsourceを触らない', () => {
  const s = setup({ view: 'messages' }); s.sandbox.I18n.init();
  assert.equal(s.calls.messages, 0); assert.equal(s.sandbox.MESSAGE_SOURCE.renderedRows, 'previous');
  s.sandbox.HAS_ACTIVE_EMAIL = true; s.sandbox.I18n.setLanguage('en');
  assert.equal(s.calls.messages, 1); assert.equal(s.sandbox.MESSAGE_SOURCE.renderedRows, null);
});

test('認証破棄中はlanguageイベントでprivate sourceへ再入場しない', async () => {
  const s = setup({ active: true, blocked: true }); s.sandbox.I18n.init(); await settle();
  assert.equal(s.calls.homeApi, 0); assert.equal(s.calls.cards, 0); assert.deepEqual(s.notices, []);
});
