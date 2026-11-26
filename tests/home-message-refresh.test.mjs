// 実際のpin/画面refresh入口とinline loaderを使い、全件取得数と世代境界を検証する。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const html = await readFile(process.env.SHIFTFLOW_UI_SOURCE || new URL('../frontend/public/index.html', import.meta.url), 'utf8');
function block(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const original = [{ id: 'old', title: '既存', isRead: false }];
const fresh = [{ id: 'new', title: '更新', isRead: true, isPinned: true, hasNewComment: true }];

function setup({ cache = false } = {}) {
  const pending = { home: [], messages: [] }, writes = [], rendered = [], badge = [];
  const elements = new Map(), filters = { folderId: '', unreadOnly: false, keyword: '' };
  const sandbox = {
    HAS_ACTIVE_EMAIL: true, PRIVATE_STORAGE_BLOCKED: false, AUTH_NOTICE_SHOWN: true,
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: 'messages', LAST_HOME_FETCH_AT: 0, LAST_MESSAGES_FETCH_AT: 0,
    identity: 'member-a', resolveCurrentIdentity() { return sandbox.identity; },
    async awaitAuthIdentityGate() { if (sandbox.RETURN_AUTH_SYNC_INFLIGHT) await sandbox.RETURN_AUTH_SYNC_INFLIGHT; },
    window: { userInfo: { orgId: 'org-a', membershipId: 'membership-a' }, ShiftFlowAppBadge: { refresh: force => badge.push(force) } },
    DIRECT_API_READ_COALESCER: { clear() {} },
    normalizeArray: value => Array.isArray(value) ? value : [], sortMessagesByActivity: rows => rows.slice(),
    MessageViewController: { getFilters: () => filters },
    byId(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', setAttribute() {} }); return elements.get(id); },
    renderMessageList: rows => rows.map(row => row.id).join(','),
    renderHomeView: payload => rendered.push(payload),
    skel: () => 'loading', authRequiredCard: () => 'login', notify() {},
    shouldThrottleFetch: (last, options) => !options.force && last > 0 && Date.now() - last < 60000,
    readUserCacheEntry: async key => !cache ? null : { value: key === 'home' ? { tasks: [], messages: original } : { rows: original } },
    writeUserCacheEntry: async (key, value) => { writes.push({ key, value }); },
    canPinMessages: () => true, setButtonLoading() {}, API_BASE_PATH: '/api',
    apiRequest: async () => { sandbox.invalidateReadRequests('mutation'); return { success: true }; },
    google: { script: { get run() {
      const request = {};
      const chain = {
        withSuccessHandler(fn) { request.success = fn; return chain; },
        withFailureHandler(fn) { request.failure = fn; return chain; },
        getHomeContent(args) { pending.home.push({ ...request, args }); },
        getMessages(args) { pending.messages.push({ ...request, args }); },
      };
      return chain;
    } } },
  };
  runInNewContext(
    block('function invalidateReadRequests', 'const API_REFRESH_INTERVAL_MS') +
    block('function loadHomeFromCache()', '// ===== Tasks =====') +
    block('var MESSAGE_LOAD_REQUEST_ID = 0;', 'function renderMessageList') +
    block('function setMsgLoading', 'function handleMessageCardClick') +
    block('function togglePin', "on('btn-msg-markall'") +
    block('function refreshCurrentView', 'function initPullToRefresh') +
    `globalThis.ui = {loadHome, loadMessages, togglePin, refreshCurrentView,
      pair: options => refreshHomeAndMessages(options),
      messages: () => MESSAGE_SOURCE, home: () => HOME_SOURCE,
      cacheScope: () => resolveReadCacheScope(),
      advanceScope() { READ_SCOPE_EPOCH += 1; },
      seed() { HOME_SOURCE.identity = resolveCurrentIdentity(); HOME_SOURCE.payload = {tasks:[],messages:${JSON.stringify(original)}};
        MESSAGE_SOURCE.identity = resolveCurrentIdentity(); MESSAGE_SOURCE.rows = ${JSON.stringify(original)}; MESSAGE_SOURCE.loaded = true;
        LAST_HOME_FETCH_AT = LAST_MESSAGES_FETCH_AT = Date.now(); }
    };`, sandbox);
  return { sandbox, ui: sandbox.ui, pending, writes, rendered, badge, elements, filters };
}

test('実pin成功入口はHome内の全件を共有し、二重取得2回を1回へ減らす', async () => {
  const s = setup(); s.ui.seed();
  s.ui.togglePin({}, 'memo', true); await tick();
  assert.equal(s.pending.home.length, 1);
  assert.equal(s.pending.messages.length, 0, '同じpin操作の全件取得を別APIへ重ねない');
  s.pending.home[0].success({ tasks: [], messages: fresh }); await tick();
  assert.deepEqual(s.ui.messages().rows, fresh);
  assert.equal(s.elements.get('msg-list').innerHTML, 'new');
  assert.equal(s.badge.length, 1, '既存badge更新を抑止しない');
});

test('実messages画面の強制refreshも1全件取得で両表示を更新する', async () => {
  const s = setup(); s.ui.seed();
  const operation = s.ui.refreshCurrentView({ force: true });
  assert.equal(s.elements.get('msg-list').innerHTML, 'old', '既存sourceは同期描画する');
  await tick();
  assert.equal(s.pending.home.length, 1); assert.equal(s.pending.messages.length, 0);
  s.pending.home[0].success({ tasks: [], messages: fresh }); await operation;
  assert.equal(s.rendered.at(-1).messages[0].id, 'new');
  assert.equal(s.elements.get('msg-list').innerHTML, 'new');
});

test('同一本人・scope・変更世代のpaired refresh多重呼出は1操作に合流する', async () => {
  const s = setup(); s.ui.seed();
  const a = s.ui.pair(), b = s.ui.pair(); await tick();
  assert.equal(a, b); assert.equal(s.pending.home.length, 1); assert.equal(s.pending.messages.length, 0);
  s.pending.home[0].success({ tasks: [], messages: fresh }); await Promise.all([a, b]);
});

test('Home失敗時だけ専用messagesへfallbackし、待機中はcacheを即描画する', async () => {
  const s = setup({ cache: true }); const operation = s.ui.pair(); await tick();
  assert.equal(s.elements.get('msg-list').innerHTML, 'old');
  assert.equal(s.pending.messages.length, 0);
  s.pending.home[0].failure(new Error('offline')); await tick();
  assert.equal(s.pending.messages.length, 1);
  s.pending.messages[0].success(fresh); await operation;
  assert.equal(s.elements.get('msg-list').innerHTML, 'new');
});

test('正当なfresh空一覧は完了として扱い専用APIを追加しない', async () => {
  const s = setup(); s.ui.seed(); const operation = s.ui.pair(); await tick();
  s.pending.home[0].success({ tasks: [], messages: [] }); await operation;
  assert.equal(s.pending.messages.length, 0); assert.equal(s.ui.messages().rows.length, 0);
});

test('mutation前のHome応答は新しいloaderがなくても採用・保存しない', async () => {
  const s = setup(); const old = s.ui.loadHome(); await tick();
  s.sandbox.invalidateReadRequests('mutation');
  s.pending.home[0].success({ tasks: [], messages: original }); await old;
  assert.equal(s.ui.home().payload, null); assert.equal(s.writes.length, 0);
});

test('mutation前のmessages応答も新しいloaderがなくても描画・保存しない', async () => {
  const s = setup(); const old = s.ui.loadMessages(); await tick();
  s.sandbox.invalidateReadRequests('mutation');
  s.pending.messages[0].success(original); await old;
  assert.equal(s.ui.messages().loaded, false); assert.equal(s.writes.length, 0);
});

test('新世代取得と逆順で旧Homeが完了しても既読・ピンを巻き戻さない', async () => {
  const s = setup(); const old = s.ui.loadHome(); await tick();
  s.sandbox.invalidateReadRequests('mutation'); const next = s.ui.pair(); await tick();
  s.pending.home[1].success({ tasks: [], messages: fresh }); await next;
  s.pending.home[0].success({ tasks: [], messages: original }); await old;
  assert.deepEqual(s.ui.messages().rows, fresh);
  assert.equal(s.rendered.at(-1).messages[0].id, 'new');
});

test('旧世代paired Homeのfailureは新世代のfallbackやsourceを増やさない', async () => {
  const s = setup(); const old = s.ui.pair(); await tick();
  s.sandbox.invalidateReadRequests('mutation'); const next = s.ui.pair(); await tick();
  s.pending.home[1].success({ tasks: [], messages: fresh }); await next;
  s.pending.home[0].failure(new Error('old failure')); await old;
  assert.equal(s.pending.messages.length, 0); assert.deepEqual(s.ui.messages().rows, fresh);
});

test('同一emailの所属snapshot更新は旧inflightとloaded sourceを隔離する', async () => {
  const s = setup(); s.ui.seed(); const old = s.ui.loadHome({ force: true }); await tick();
  s.ui.advanceScope(); s.sandbox.window.userInfo.orgId = 'org-b';
  const next = s.ui.pair(); await tick();
  s.pending.home[1].success({ tasks: [], messages: fresh }); await next;
  s.pending.home[0].success({ tasks: [], messages: original }); await old;
  assert.deepEqual(s.ui.messages().rows, fresh); assert.equal(s.elements.get('msg-list').innerHTML, 'new');
});

test('独立foregroundとforceは無関係なHome待ちへ合流しない', async () => {
  const s = setup(); const home = s.ui.loadHome(); await tick();
  const messages = s.ui.loadMessages({ force: true }); await tick();
  assert.equal(s.pending.messages.length, 1);
  s.pending.messages[0].success(fresh); await messages;
  s.pending.home[0].success({ tasks: [], messages: original }); await home;
  assert.deepEqual(s.ui.messages().rows, fresh);
});

test('cache Promise待ちで本人が切り替わったら旧cacheを描画も通信もしない', async () => {
  const s = setup(); let release;
  s.sandbox.readUserCacheEntry = () => new Promise(resolve => { release = resolve; });
  const operation = s.ui.loadMessages(); await tick();
  s.sandbox.identity = 'member-b'; release({ value: { rows: original } }); await operation;
  assert.equal(s.pending.messages.length, 0); assert.equal(s.ui.messages().loaded, false);
  assert.notEqual(s.elements.get('msg-list').innerHTML, 'old');
});

test('logout境界と本人切替後の旧paired成功/failureは描画もfallbackもしない', async () => {
  for (const response of ['success', 'failure']) {
    const s = setup(); const operation = s.ui.pair(); await tick();
    s.sandbox.PRIVATE_STORAGE_BLOCKED = true; s.sandbox.HAS_ACTIVE_EMAIL = false;
    s.sandbox.identity = ''; s.sandbox.invalidateReadRequests('logout');
    s.pending.home[0][response](response === 'success' ? { tasks: [], messages: original } : new Error('old'));
    await operation;
    assert.equal(s.pending.messages.length, 0); assert.equal(s.writes.length, 0);
  }
});

test('認可gateが開くまでpaired readを始めず、開いた時の所属snapshotを使う', async () => {
  const s = setup(); let release;
  s.sandbox.RETURN_AUTH_SYNC_INFLIGHT = new Promise(resolve => { release = resolve; });
  const operation = s.ui.pair(); await tick();
  assert.equal(s.pending.home.length, 0); assert.equal(s.pending.messages.length, 0);
  s.ui.advanceScope(); s.sandbox.window.userInfo.orgId = 'org-b';
  s.sandbox.RETURN_AUTH_SYNC_INFLIGHT = null; release(); await tick();
  assert.equal(s.pending.home.length, 1);
  s.pending.home[0].success({ tasks: [], messages: fresh }); await operation;
  assert.deepEqual(s.ui.messages().rows, fresh); assert.equal(s.pending.messages.length, 0);
});

test('同一本人・同じ既知所属の永続cacheは前session epoch2から新session epoch1でも即表示する', async () => {
  const previous = setup(); previous.ui.advanceScope(); previous.ui.advanceScope();
  const prior = previous.ui.pair(); await tick();
  previous.pending.home[0].success({ tasks: [], messages: original }); await prior;
  const persisted = new Map(previous.writes.map(entry => [entry.key, entry.value]));
  assert.ok(persisted.has('home')); assert.ok(persisted.has('messages:complete:v2'));
  const next = setup(); next.ui.advanceScope();
  next.sandbox.readUserCacheEntry = async key => persisted.has(key) ? { value: persisted.get(key) } : null;
  const home = next.ui.loadHome(), messages = next.ui.loadMessages(); await tick();
  assert.equal(next.rendered[0].messages[0].id, 'old');
  assert.equal(next.elements.get('msg-list').innerHTML, 'old');
  next.pending.home[0].failure(new Error('offline')); next.pending.messages[0].failure(new Error('offline'));
  await Promise.all([home, messages]);
});

test('同じemailでも既知所属が違う永続cacheは表示しない', async () => {
  const s = setup(); const oldScope = s.ui.cacheScope();
  s.sandbox.window.userInfo.orgId = 'org-b'; s.ui.advanceScope();
  s.sandbox.readUserCacheEntry = async key => ({ value: { readScope: oldScope, tasks: [], messages: original, rows: original } });
  const home = s.ui.loadHome(), messages = s.ui.loadMessages(); await tick();
  assert.equal(s.rendered.length, 0); assert.notEqual(s.elements.get('msg-list').innerHTML, 'old');
  s.pending.home[0].failure(new Error('offline')); s.pending.messages[0].failure(new Error('offline'));
  await Promise.all([home, messages]);
});

test('cold pairのHome待ちへ独立foreground入場を合流させず、専用fetchを開始する', async () => {
  const s = setup(); const pair = s.ui.pair(); await tick();
  const foreground = s.ui.loadMessages(); await tick();
  assert.equal(s.pending.messages.length, 1, '実画面入場はpaired Homeの遅い応答を待たない');
  s.pending.messages[0].success(fresh); await foreground;
  s.pending.home[0].success({ tasks: [], messages: original }); await pair;
  assert.deepEqual(s.ui.messages().rows, fresh);
  assert.equal(s.elements.get('msg-list').innerHTML, 'new');
});

test('mutationなしの後続手動forceは独立操作として新Homeを取り旧結果を採用しない', async () => {
  const s = setup(); s.ui.seed();
  const old = s.ui.refreshCurrentView({ force: true }); await tick();
  const next = s.ui.refreshCurrentView({ force: true }); await tick();
  assert.equal(s.pending.home.length, 2, '別の手動更新を先行forceへ合流しない');
  s.pending.home[1].success({ tasks: [], messages: fresh }); await next;
  s.pending.home[0].success({ tasks: [], messages: original }); await old;
  assert.deepEqual(s.ui.messages().rows, fresh); assert.equal(s.pending.messages.length, 0);
});

test('mutation後の通常Home/messagesは旧pendingへ合流せず新しい取得を行う', async () => {
  for (const route of ['home', 'messages']) {
    const s = setup(), load = route === 'home' ? s.ui.loadHome : s.ui.loadMessages;
    const old = load(); await tick();
    s.sandbox.invalidateReadRequests('mutation'); const next = load(); await tick();
    assert.notEqual(next, old); assert.equal(s.pending[route].length, 2, route);
    s.pending[route][1].success(route === 'home' ? { tasks: [], messages: fresh } : fresh); await next;
    s.pending[route][0].success(route === 'home' ? { tasks: [], messages: original } : original); await old;
    assert.equal(route === 'home' ? s.ui.home().payload.messages[0].id : s.ui.messages().rows[0].id, 'new');
  }
});

test('warm cacheが最近でもmutation後の通常取得を旧pendingやTTLで抑止しない', async () => {
  for (const route of ['home', 'messages']) {
    const s = setup(); s.ui.seed();
    const load = route === 'home' ? s.ui.loadHome : s.ui.loadMessages;
    const old = load({ force: true }); await tick();
    s.sandbox.invalidateReadRequests('mutation'); const next = load(); await tick();
    assert.equal(s.pending[route].length, 2, route);
    s.pending[route][1].success(route === 'home' ? { tasks: [], messages: fresh } : fresh); await next;
    s.pending[route][0].success(route === 'home' ? { tasks: [], messages: original } : original); await old;
    assert.equal(route === 'home' ? s.ui.home().payload.messages[0].id : s.ui.messages().rows[0].id, 'new');
  }
});

test('org/membershipを持たない実bootstrap shapeでもepoch越しの共有・逆転採用をしない', async () => {
  const s = setup(); s.sandbox.window.userInfo = { email: 'member-a', role: 'member', theme: 'dark', language: 'ja' };
  s.ui.seed(); const old = s.ui.pair(); await tick();
  s.ui.advanceScope(); const next = s.ui.pair(); await tick();
  assert.equal(s.pending.home.length, 2); assert.equal(s.pending.messages.length, 0);
  s.pending.home[1].success({ tasks: [], messages: fresh }); await next;
  s.pending.home[0].success({ tasks: [], messages: original }); await old;
  assert.deepEqual(s.ui.messages().rows, fresh); assert.equal(s.elements.get('msg-list').innerHTML, 'new');
});

test('新世代prefetchは旧世代Home待ちへ合流せず専用のfresh取得を始める', async () => {
  const s = setup(); const oldHome = s.ui.loadHome(); await tick();
  s.sandbox.invalidateReadRequests('mutation'); const next = s.ui.loadMessages({ prefetch: true }); await tick();
  assert.equal(s.pending.messages.length, 1);
  s.pending.messages[0].success(fresh); await next;
  s.pending.home[0].success({ tasks: [], messages: original }); await oldHome;
  assert.deepEqual(s.ui.messages().rows, fresh);
});

test('2.3.19 legacy cacheはcached/fresh bootstrap後も先行描画し通信失敗後も維持する', async () => {
  const s = setup({ cache: true });
  s.sandbox.window.userInfo = { email: 'member-a', role: 'member', theme: 'dark', language: 'ja' };
  s.ui.advanceScope(); s.ui.advanceScope();
  const home = s.ui.loadHome(), messages = s.ui.loadMessages(); await tick();
  assert.equal(s.rendered[0]?.messages[0].id, 'old', 'scope無しの既存Home cacheを即表示する');
  assert.equal(s.elements.get('msg-list').innerHTML, 'old', 'scope無しの既存messages cacheを即表示する');
  s.pending.home[0].failure(new Error('offline')); s.pending.messages[0].failure(new Error('offline'));
  await Promise.all([home, messages]);
  assert.equal(s.rendered.at(-1).messages[0].id, 'old');
  assert.equal(s.elements.get('msg-list').innerHTML, 'old');
});
