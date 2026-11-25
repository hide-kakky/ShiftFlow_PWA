import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import coalescerApi from '../frontend/public/request-coalescer.js';

const html = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
function block(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
const rows = [
  { id: 'read', folderId: 'one', isRead: true, title: '連絡' },
  { id: 'unread', folderId: 'one', isRead: false, title: '連絡' },
  { id: 'comment', folderId: 'two', isRead: true, hasNewComment: true, title: '更新' },
];
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(cached = null) {
  const list = { innerHTML: '', setAttribute() {} };
  const pending = [], writes = [], notices = [];
  const remote = coalescerApi.createRequestCoalescer();
  const filters = { folderId: '', unreadOnly: false, keyword: '' };
  const sandbox = {
    HAS_ACTIVE_EMAIL: true, PRIVATE_STORAGE_BLOCKED: false,
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: 'messages', LAST_MESSAGES_FETCH_AT: 0, AUTH_NOTICE_SHOWN: true,
    HOME_SOURCE: { inflight: null },
    identity: 'account-a', resolveCurrentIdentity() { return sandbox.identity; },
    byId: id => id === 'msg-list' ? list : null,
    MessageViewController: { getFilters: () => filters },
    normalizeArray: value => Array.isArray(value) ? value : [],
    sortMessagesByActivity: value => value.slice(),
    renderMessageList: value => value.map(row => row.id).join(','),
    skel: () => 'loading', authRequiredCard: () => 'login',
    notify: message => notices.push(message),
    invalidateReadRequests: reason => remote.clear(reason),
    shouldThrottleFetch: (last, opts) => !opts.force && last > 0 && Date.now() - last < 60000,
    readUserCacheEntry: async () => cached && { value: { rows: cached } },
    writeUserCacheEntry: async (key, value) => { writes.push({ key, value }); },
    google: { script: { get run() {
      const request = {};
      const chain = {
        withSuccessHandler(fn) { request.success = fn; return chain; },
        withFailureHandler(fn) { request.failure = fn; return chain; },
        getMessages(args) {
          remote.run(coalescerApi.stableSerialize(args), () => new Promise((resolve, reject) => {
            pending.push({ args, success: resolve, failure: reject });
          })).then(request.success, request.failure);
        },
      };
      return chain;
    } } },
  };
  runInNewContext(
    block('var MESSAGE_LOAD_REQUEST_ID = 0;', 'function renderMessageList') +
    block('function setMsgLoading', 'function handleMessageCardClick') +
    'globalThis.load = loadMessages;', sandbox);
  return { sandbox, filters, list, pending, writes, notices, load: sandbox.load };
}
test('全件を先に取得し、未読とすべての連続切替は同期描画で追加通信しない', async () => {
  const s = setup();
  const initial = s.load({ prefetch: true }); await tick();
  assert.equal(s.pending.length, 1); assert.equal(s.pending[0].args.unreadOnly, false);
  assert.equal(s.pending[0].args.folderId, undefined);
  s.pending[0].success(rows); await initial;
  for (let i = 0; i < 4; i++) {
    s.filters.unreadOnly = true; s.load({ localOnly: true });
    assert.equal(s.list.innerHTML, 'unread,comment');
    s.filters.unreadOnly = false; s.load({ localOnly: true });
    assert.equal(s.list.innerHTML, 'read,unread,comment');
  }
  assert.equal(s.pending.length, 1);
  assert.deepEqual(s.writes[0].value.rows, rows);
});
test('初回取得中の切替と検索・フォルダを最終条件で描画する', async () => {
  const s = setup(); const load = s.load(); await tick();
  s.filters.unreadOnly = true; s.filters.folderId = 'two'; s.filters.keyword = '更新';
  s.load({ localOnly: true });
  assert.equal(s.pending.length, 1);
  s.pending[0].success(rows); await load;
  assert.equal(s.list.innerHTML, 'comment');
  s.filters.unreadOnly = false; s.filters.folderId = ''; s.filters.keyword = '';
  s.load(); assert.equal(s.list.innerHTML, 'read,unread,comment');
});
test('裏の更新中も表示を保ち、応答時に現在のモードを反映する', async () => {
  const s = setup(); const initial = s.load(); await tick(); s.pending[0].success(rows); await initial;
  const refresh = s.load({ force: true }); await tick();
  s.filters.unreadOnly = true; s.load({ localOnly: true });
  assert.equal(s.list.innerHTML, 'unread,comment');
  s.pending[1].success(rows.map(row => ({ ...row, isRead: true, hasNewComment: false })));
  await refresh; assert.equal(s.list.innerHTML, '');
  s.filters.unreadOnly = false; s.load({ localOnly: true });
  assert.equal(s.list.innerHTML, 'read,unread,comment');
});
test('変更後の強制取得より古い応答が遅れても既読・ピンを巻き戻さない', async () => {
  const s = setup(); const old = s.load(); await tick();
  const fresh = s.load({ force: true }); await tick();
  s.pending[1].success([{ ...rows[0], isPinned: true }]); await fresh;
  s.pending[0].success(rows); await old;
  assert.equal(s.list.innerHTML, 'read'); assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].value.rows[0].isPinned, true);
});
test('キャッシュから未読だけを即表示し、取得失敗時も絞り込みを保つ', async () => {
  const s = setup(rows); s.filters.unreadOnly = true;
  const load = s.load(); await tick(); assert.equal(s.list.innerHTML, 'unread,comment');
  s.pending[0].failure(new Error('offline')); await load;
  assert.equal(s.list.innerHTML, 'unread,comment');
  s.filters.unreadOnly = false; s.load({ localOnly: true });
  assert.equal(s.list.innerHTML, 'read,unread,comment');
});
test('認証破棄で共有sourceを消し、旧アカウントの遅い応答を保存も描画もしない', async () => {
  const s = setup(); const old = s.load(); await tick();
  // 実際のpurge内にある共有source破棄の文を実行する。
  const purge = block('function purgePrivateInMemoryState', 'async function purgePrivateClientState');
  const reset = purge.match(/MESSAGE_LOAD_REQUEST_ID \+= 1;[\s\S]*?MESSAGE_SOURCE = [^;]+;/);
  assert.ok(reset); runInNewContext(reset[0], s.sandbox);
  assert.match(purge, /invalidateReadRequests\(reason/);
  s.sandbox.invalidateReadRequests('private-state-purge');
  s.sandbox.identity = 'account-b';
  const fresh = s.load(); await tick();
  s.pending[1].success([{ id: 'private-b' }]); await fresh;
  s.pending[0].success(rows); await old;
  assert.equal(s.list.innerHTML, 'private-b'); assert.equal(s.writes.length, 1);
});
test('private storageが閉じている時と認証同期中は即時描画を通さない', async () => {
  const s = setup(); const initial = s.load(); await tick(); s.pending[0].success(rows); await initial;
  s.sandbox.PRIVATE_STORAGE_BLOCKED = true;
  await s.load({ localOnly: true }); assert.equal(s.list.innerHTML, 'login');
  s.sandbox.PRIVATE_STORAGE_BLOCKED = false;
  let release;
  s.sandbox.RETURN_AUTH_SYNC_INFLIGHT = new Promise(resolve => { release = resolve; });
  s.sandbox.awaitAuthIdentityGate = () => s.sandbox.RETURN_AUTH_SYNC_INFLIGHT;
  const guarded = s.load(); assert.equal(s.list.innerHTML, 'login');
  s.sandbox.RETURN_AUTH_SYNC_INFLIGHT = null; release(); await guarded;
  assert.equal(s.list.innerHTML, 'read,unread,comment');
});
test('期限を過ぎた切替は同期描画してから裏で全件を更新する', async () => {
  const s = setup(); const initial = s.load(); await tick(); s.pending[0].success(rows); await initial;
  s.sandbox.LAST_MESSAGES_FETCH_AT = Date.now() - 61000;
  s.filters.unreadOnly = true;
  const refresh = s.load({ localOnly: true });
  assert.equal(s.list.innerHTML, 'unread,comment');
  await tick(); assert.equal(s.pending.length, 2);
  s.pending[1].success(rows.filter(row => row.id !== 'unread')); await refresh;
  assert.equal(s.list.innerHTML, 'comment');
});
