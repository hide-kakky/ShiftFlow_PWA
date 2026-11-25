import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// 実時間ではなく、表示の再構築とcache読取り回数を検証する。
const source = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const messages = [{ id: 'read', isRead: true }, { id: 'unread', isRead: false }];
const homePayload = { tasks: [{ id: 'task' }], messages };

function setup() {
  const writes = [], renders = { messages: 0, home: 0, taskRows: 0 }, reads = [], delays = [];
  const stored = new Map(), pending = [];
  const elements = Object.fromEntries([
    'msg-list', 'btn-msg-markall', 'home-today-tasks', 'home-unread', 'home-shift-messages',
    'task-list-my', 'task-list-from', 'task-list-all',
  ].map(id => {
    let value = '';
    return [id, {
      get innerHTML() { return value; },
      set innerHTML(next) { value = next; writes.push({ id, value: next }); },
      setAttribute() {}, classList: { toggle() {} },
    }];
  }));
  const filters = { folderId: '', unreadOnly: false, keyword: '' };
  const sandbox = {
    HAS_ACTIVE_EMAIL: true, PRIVATE_STORAGE_BLOCKED: false,
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: 'messages', CURRENT_USER_EMAIL: 'owner', CURRENT_USER_ROLE: 'member',
    LAST_MESSAGES_FETCH_AT: 0, LAST_HOME_FETCH_AT: 0, LAST_TASK_FETCH_AT: { my: 0, from: 0, all: 0 },
    TASKS_BOOTSTRAPPED: true, INITIAL_MY_TASK_PAYLOAD: { tasks: [], meta: {} },
    AUTH_NOTICE_SHOWN: true, IS_MANAGER: false, ACTIVE_TASK_TAB: 'my',
    MIN_CONTENT_SKELETON_MS: 220, I18n: { currentLang: 'ja' }, window: { I18n: { currentLang: 'ja' } },
    resolveCurrentIdentity: () => 'owner', resolveUserCacheNamespace: () => 'owner',
    normalizeArray: value => Array.isArray(value) ? value : [],
    sortMessagesByActivity: rows => rows.slice(),
    byId: id => elements[id], $$: () => [],
    MessageViewController: { getFilters: () => filters },
    renderMessageList(rows) { renders.messages++; return rows.map(row => row.id).join(','); },
    renderHomeView(payload) {
      renders.home++;
      for (const id of ['home-today-tasks', 'home-unread', 'home-shift-messages']) elements[id].innerHTML = JSON.stringify(payload);
    },
    rowTask(row) { renders.taskRows++; return row.id; },
    getNameByEmail: value => value,
    updateTaskOverdueBadge() {}, syncTaskScopeHeader() {}, syncHeaderSearchControls() {},
    skel: count => 'loading:' + count, authRequiredCard: () => 'login', notify() {},
    shouldThrottleFetch: (last, options) => !options.force && last > 0 && Date.now() - last < 60000,
    readUserCacheEntry(key) { reads.push(key); return Promise.resolve(stored.get(key) || null); },
    writeUserCacheEntry(key, value) { stored.set(key, { value }); return Promise.resolve(true); },
    revealAfterDelay(start, duration, fn) { delays.push(duration); fn(); },
    google: { script: { get run() {
      const request = {};
      const chain = {
        withSuccessHandler(fn) { request.success = fn; return chain; },
        withFailureHandler(fn) { request.failure = fn; return chain; },
      };
      for (const route of ['getMessages', 'getHomeContent', 'listMyTasks', 'listCreatedTasks', 'listAllTasks']) {
        chain[route] = args => pending.push({ ...request, route, args });
      }
      return chain;
    } } },
  };
  runInNewContext(
    block('var MESSAGE_LOAD_REQUEST_ID = 0;', 'function renderMessageList') +
    block('function setMsgLoading', 'function handleMessageCardClick') +
    block('function loadHomeFromCache', '// ===== Tasks =====') +
    block('const TASK_STATE = {', 'function displayAssignees') +
    block('function getTaskContainerId', 'function loadCreatedTasks') +
    block('function activateTaskTab', 'var API_REFRESH_COOLDOWN_MS') +
    block('function loadViewContent', 'function pushViewHistoryState') +
    'globalThis.api = { loadMessages, loadHome, loadViewContent, renderTaskList, seedTask(rows) { TASK_STATE.my.rows = rows; TASK_STATE.my.loaded = true; TASK_STATE.my.loading = false; LAST_TASK_FETCH_AT.my = Date.now(); } };',
    sandbox,
  );
  function latest(route) { return pending.filter(request => request.route === route).at(-1); }
  function resetCounts() { writes.length = 0; reads.length = 0; delays.length = 0; renders.messages = renders.home = renders.taskRows = 0; }
  return { sandbox, filters, elements, writes, reads, renders, delays, pending, latest, resetCounts, ...sandbox.api };
}

async function primeMessages(s) {
  const loading = s.loadMessages(); await tick(); const request=s.latest('getMessages'); if(request) request.success(messages); await loading;
  assert.match(s.elements['msg-list'].innerHTML,/unread/); s.resetCounts();
}
async function primeHome(s) {
  s.sandbox.CURRENT_VIEW = 'home';
  const loading = s.loadHome(); await tick(); s.latest('getHomeContent').success(homePayload); await loading; s.resetCounts();
}

test('非表示メッセージのprefetchと強制更新は一覧DOMを構築しない', async () => {
  const s = setup(); await primeMessages(s); s.sandbox.CURRENT_VIEW = 'home';
  await s.loadMessages({ prefetch: true });
  assert.equal(s.renders.messages, 0); assert.equal(s.writes.length, 0);
  const force = s.loadMessages({ prefetch: true, force: true }); await tick();
  s.latest('getMessages').success([{ id: 'new', isRead: false }]); await force;
  assert.equal(s.renders.messages, 0); assert.equal(s.writes.length, 0);
  s.sandbox.CURRENT_VIEW = 'messages'; s.loadMessages({ localOnly: true });
  assert.equal(s.elements['msg-list'].innerHTML, 'new');
});

test('同じ取得結果・表示条件で戻る時はメッセージ一覧を作り直さない', async () => {
  const s = setup(); await primeMessages(s);
  s.sandbox.CURRENT_VIEW = 'tasks'; s.sandbox.CURRENT_VIEW = 'messages';
  s.loadMessages({ localOnly: true });
  assert.equal(s.renders.messages, 0); assert.equal(s.writes.length, 0);
  s.filters.unreadOnly = true; s.loadMessages({ localOnly: true });
  assert.equal(s.elements['msg-list'].innerHTML, 'unread');
  const count = s.writes.length; s.loadMessages({ localOnly: true });
  assert.equal(s.writes.length, count);
});

test('1000件取得済みでもホームの先読み10回で非表示一覧の再描画は0回', async () => {
  const s = setup(); const first = s.loadMessages(); await tick();
  s.latest('getMessages').success(Array.from({length:1000}, (_,id)=>({id:String(id),isRead:false})));
  await first; s.resetCounts(); s.sandbox.CURRENT_VIEW='home';
  for(let i=0;i<10;i++) await s.loadMessages({prefetch:true});
  assert.equal(s.renders.messages,0); assert.equal(s.writes.length,0);
});

test('ホームへ戻る時は取得済みのDOMを保ちIDBを読み直さない', async () => {
  const s = setup(); await primeHome(s);
  const before = s.elements['home-unread'].innerHTML;
  const loading = s.loadHome();
  assert.equal(s.elements['home-unread'].innerHTML, before);
  assert.equal(s.reads.length, 0); assert.equal(s.writes.length, 0);
  await loading; assert.equal(s.writes.length, 0); assert.equal(s.delays.length, 0);
});

test('期限切れのホームも既存DOMを保ったまま裏で取得しskeletonに戻さない', async () => {
  const s = setup(); await primeHome(s); s.sandbox.LAST_HOME_FETCH_AT = Date.now() - 61000;
  const loading = s.loadHome();
  assert.equal(s.writes.length, 0); assert.equal(s.reads.length, 0);
  await tick(); assert.equal(s.pending.filter(request => request.route === 'getHomeContent').length, 2);
  assert.equal(s.writes.length, 0);
  s.latest('getHomeContent').success({ ...homePayload, tasks: [] }); await loading;
  assert.equal(s.writes.some(write => write.value.startsWith('loading:')), false);
  assert.equal(s.delays.length, 0);
});

test('warmなタスク画面への1回の遷移は一覧を1回だけ構築する', () => {
  const s = setup(); s.sandbox.CURRENT_VIEW = 'tasks'; s.seedTask([{ id: 'task' }]);
  s.loadViewContent('tasks', {});
  assert.equal(s.renders.taskRows, 1);
  assert.equal(s.writes.filter(write => write.id === 'task-list-my').length, 1);
  assert.equal(s.reads.length, 0);
});

test('強制更新より古いホーム応答は描画も保存もしない', async () => {
  const s = setup(); s.sandbox.CURRENT_VIEW = 'home';
  const old = s.loadHome(); await tick(); const oldRequest = s.latest('getHomeContent');
  const fresh = s.loadHome({ force: true }); await tick(); const newRequest = s.latest('getHomeContent');
  assert.notEqual(oldRequest.args.refreshGeneration, newRequest.args.refreshGeneration);
  newRequest.success({ tasks: [{ id: 'fresh' }], messages: [] }); await fresh;
  s.resetCounts(); oldRequest.success(homePayload); await old;
  assert.equal(s.writes.length, 0); assert.equal(s.renders.home, 0);
  assert.match(s.elements['home-unread'].innerHTML, /fresh/);
});

test('認証破棄後に古いホーム応答が新アカウントの表示を上書きしない', async () => {
  const s = setup(); s.sandbox.CURRENT_VIEW = 'home';
  const old = s.loadHome(); await tick(); const oldRequest = s.latest('getHomeContent');
  const purge = block('function purgePrivateInMemoryState', 'async function purgePrivateClientState');
  const reset = purge.match(/HOME_LOAD_REQUEST_ID \+= 1;\s*HOME_SOURCE = [^;]+;/);
  assert.ok(reset); runInNewContext(reset[0], s.sandbox);
  s.sandbox.resolveCurrentIdentity = () => 'new-owner';
  const fresh = s.loadHome(); await tick();
  s.latest('getHomeContent').success({ tasks: [{ id: 'new-owner-only' }], messages: [] }); await fresh;
  s.resetCounts(); oldRequest.success(homePayload); await old;
  assert.equal(s.writes.length, 0); assert.equal(s.renders.home, 0);
  assert.match(s.elements['home-unread'].innerHTML, /new-owner-only/);
});

test('同じデータでも日付が変わるとホームとメッセージの表示を更新する', async () => {
  const s = setup(); let now = Date.now();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  s.sandbox.Date = Clock;
  await primeHome(s); s.sandbox.CURRENT_VIEW = 'messages'; await primeMessages(s);
  now += 86400000;
  s.sandbox.CURRENT_VIEW = 'home'; s.loadHome();
  s.sandbox.CURRENT_VIEW = 'messages'; s.loadMessages();
  assert.equal(s.renders.home, 1); assert.equal(s.renders.messages, 1);
});

test('取得済みタスクの裏更新中は一覧をskeletonへ置き換えない', async () => {
  const s = setup(); s.sandbox.CURRENT_VIEW = 'tasks'; s.seedTask([{ id: 'task' }]);
  s.loadViewContent('tasks', {}); s.resetCounts();
  s.sandbox.LAST_TASK_FETCH_AT.my = Date.now() - 61000;
  s.loadViewContent('tasks', {}); await tick();
  s.renderTaskList('my');
  assert.equal(s.writes.some(write => write.value.startsWith('loading:')), false);
  assert.equal(s.elements['task-list-my'].innerHTML.includes('task'), true);
});
