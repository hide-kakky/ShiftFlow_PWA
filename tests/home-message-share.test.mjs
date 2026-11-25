// 実アプリinline loaderを実行し、APIの応答順を制御する。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import rawTest from 'node:test';
function test(name, fn) { return rawTest(name, { timeout: 1500 }, fn); }
const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
const api = await readFile(new URL('../functions/api/[[route]].js', import.meta.url), 'utf8');
function block(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const rows = [
  { id: 'pin', folderId: 'one', isRead: true, isPinned: true, body: 'line one\nline two', commentCount: 1, hasNewComment: false },
  { id: 'unread', folderId: 'one', isRead: false, isPinned: false, body: 'body needed for search', commentCount: 0, hasNewComment: false },
  { id: 'comment', folderId: 'two', isRead: true, isPinned: false, body: 'full body', commentCount: 3, hasNewComment: true, lastCommentAt: 1794500000000 },
];
function setup({ cachedHome = null, cachedMessages = null } = {}) {
  const pending = { home: [], messages: [] }, writes = [];
  const elements = new Map();
  const filters = { unreadOnly: false, folderId: '', keyword: '' };
  const sandbox = {
    HAS_ACTIVE_EMAIL: true, PRIVATE_STORAGE_BLOCKED: false,
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: 'home', LAST_HOME_FETCH_AT: 0, LAST_MESSAGES_FETCH_AT: 0,
    AUTH_NOTICE_SHOWN: true, identity: 'account-a',
    resolveCurrentIdentity() { return sandbox.identity; },
    async awaitAuthIdentityGate() { if (sandbox.RETURN_AUTH_SYNC_INFLIGHT) await sandbox.RETURN_AUTH_SYNC_INFLIGHT; },
    normalizeArray: value => Array.isArray(value) ? value : [],
    sortMessagesByActivity: value => value.slice(),
    MessageViewController: { getFilters: () => filters },
    byId(id) { if (!elements.has(id)) elements.set(id, { innerHTML: '', setAttribute() {} }); return elements.get(id); },
    renderMessageList: value => value.map(row => row.id).join(','),
    renderHomeView() {}, skel: () => 'loading', authRequiredCard: () => 'login', notify() {},
    shouldThrottleFetch: (last, options) => !options.force && last > 0 && Date.now() - last < 60000,
    readUserCacheEntry: async key => key === 'home' ? (cachedHome && { value: cachedHome }) : (cachedMessages && { value: { rows: cachedMessages } }),
    writeUserCacheEntry: async (key, value) => { writes.push({ key, value }); },
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
    block(html, 'function loadHomeFromCache()', '// ===== Tasks =====') +
    block(html, 'var MESSAGE_LOAD_REQUEST_ID = 0;', 'function renderMessageList') +
    block(html, 'function setMsgLoading', 'function handleMessageCardClick') +
    'globalThis.ui = { loadHome, loadMessages, messages: () => MESSAGE_SOURCE, home: () => HOME_SOURCE };', sandbox);
  return { sandbox, ui: sandbox.ui, pending, writes, elements, filters };
}

test('fresh Home全件を共有し、背景prefetchの重複APIを発行しない', async () => {
  const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
  await tick(); assert.equal(s.pending.home.length, 1); assert.equal(s.pending.messages.length, 0);
  s.pending.home[0].success({ tasks: [], messages: rows });
  await Promise.all([home, warm]);
  assert.equal(s.pending.messages.length, 0); assert.equal(s.ui.messages().loaded, true);
  assert.deepEqual(s.ui.messages().rows, rows);
  assert.ok(s.sandbox.LAST_MESSAGES_FETCH_AT > 0);
  s.sandbox.CURRENT_VIEW = 'messages'; s.filters.unreadOnly = true; s.ui.loadMessages();
  assert.equal(s.elements.get('msg-list').innerHTML, 'unread,comment');
  assert.equal(s.pending.messages.length, 0);
});

test('Home失敗時だけ専用messages APIにfallbackする', async () => {
  const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
  await tick(); s.pending.home[0].failure(new Error('fixture')); await tick();
  assert.equal(s.pending.messages.length, 1); s.pending.messages[0].success(rows);
  await Promise.all([home, warm]); assert.deepEqual(s.ui.messages().rows, rows);
});

test('messages欠落は不足としてfallbackし、正当な空配列は取得完了とする', async () => {
  for (const payload of [{ tasks: [] }, { tasks: [], messages: [] }]) {
    const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
    await tick(); s.pending.home[0].success(payload); await tick();
    const expected = Array.isArray(payload.messages) ? 0 : 1;
    assert.equal(s.pending.messages.length, expected);
    if (expected) s.pending.messages[0].success(rows);
    await Promise.all([home, warm]); assert.equal(s.ui.messages().loaded, true);
  }
});

test('実画面入場はHomeを待たず専用fetchを開始し、遅いHomeで上書きしない', async () => {
  const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
  await tick(); s.sandbox.CURRENT_VIEW = 'messages'; const foreground = s.ui.loadMessages();
  await tick(); assert.equal(s.pending.messages.length, 1);
  s.pending.home[0].success({ tasks: [], messages: [{ id: 'older' }] }); await tick();
  assert.notEqual(s.ui.messages().rows[0]?.id, 'older');
  s.pending.messages[0].success(rows); await Promise.all([home, warm, foreground]);
  assert.deepEqual(s.ui.messages().rows, rows); assert.equal(s.pending.messages.length, 1);
});

test('専用fetchが先に完了した後も、古いHomeをadoptしない', async () => {
  const s = setup(); const home = s.ui.loadHome(); s.sandbox.CURRENT_VIEW = 'messages'; const foreground = s.ui.loadMessages();
  await tick(); s.pending.messages[0].success(rows); await foreground;
  s.pending.home[0].success({ tasks: [], messages: [{ id: 'older' }] }); await home;
  assert.deepEqual(s.ui.messages().rows, rows);
});

test('Home待機中にidentity境界が閉じたら、旧応答を共有せずfallback通信もしない', async () => {
  const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
  await tick(); s.sandbox.identity = 'account-b'; s.sandbox.PRIVATE_STORAGE_BLOCKED = true;
  s.pending.home[0].success({ tasks: [], messages: rows }); await Promise.all([home, warm]);
  assert.equal(s.ui.messages().loaded, false); assert.equal(s.pending.messages.length, 0);
});

test('force messagesはHome待機を迂回し、独立した最新fetchを開始する', async () => {
  const s = setup(); const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true });
  const forced = s.ui.loadMessages({ force: true, prefetch: true }); await tick();
  assert.equal(s.pending.messages.length, 1); assert.ok(s.pending.messages[0].args.refreshGeneration);
  s.pending.messages[0].success(rows); s.pending.home[0].success({ tasks: [], messages: [{ id: 'older' }] });
  await Promise.all([home, warm, forced]); assert.deepEqual(s.ui.messages().rows, rows);
});

test('永続cacheのHome表示だけではmessage全件sourceとして採用しない', async () => {
  const s = setup({ cachedHome: { tasks: [], messages: [{ id: 'stale' }] } });
  const home = s.ui.loadHome(); const warm = s.ui.loadMessages({ prefetch: true }); await tick();
  assert.equal(s.ui.messages().loaded, false); assert.equal(s.pending.messages.length, 0);
  s.pending.home[0].success({ tasks: [], messages: rows }); await Promise.all([home, warm]);
  assert.deepEqual(s.ui.messages().rows, rows);
});

test('本番getHomeContent.messagesとgetMessages全件は同じscope/optionsと全フィールドを返す', async () => {
  const getMessages = block(api, "if (normalizedRoute === 'getMessages') {", "    if (\n      primaryRoute === 'messages'");
  const getHome = block(api, "if (normalizedRoute === 'getHomeContent') {", "    if (normalizedRoute === 'downloadAttachment')");
  const seen = [];
  const sandbox = {
    normalizeEmailValue: value => value, isManagerRole: () => false,
    resolveMembershipForEmail: async () => ({ membership_id: 'fixture-membership', org_id: 'fixture-org', user_id: 'fixture-user' }),
    buildMessagesForUser: async (_db, options) => { seen.push(options); return rows; },
    fetchAssigneesForTasks: async () => new Map(), buildTaskRecordFromD1() {},
    startOfTodayMs: () => 0, jsonResponseFromD1: (_status, payload) => payload,
  };
  runInNewContext('globalThis.route = async function(normalizedRoute) { const parsedBody={args:[{unreadOnly:false}]}; const tokenDetails={email:"fixture"}; const accessContext={orgId:"fixture-org",userId:"fixture-user",role:"member"}; const requestId="fixture"; const allowedOrigin=""; const db={prepare(){return {bind(){return {all:async()=>({results:[]})}}}}};' + getMessages + getHome + '};', sandbox);
  const dedicated = await sandbox.route('getMessages'); const home = await sandbox.route('getHomeContent');
  assert.deepEqual(seen[0], seen[1]); assert.deepEqual(home.result.messages, dedicated.result);
  assert.deepEqual(home.result.messages, rows);
});
