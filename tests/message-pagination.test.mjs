import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const epoch = new Date(2026, 10, 13, 12).getTime();
const row = (index, values = {}) => ({ id: 'm' + index, title: '連絡', body: '本文', folderId: 'one', createdAt: epoch - index * 60000, isRead: true, ...values });
const many = count => Array.from({ length: count }, (_, index) => row(index));

function setup(options = {}) {
  const list = { innerHTML: '', attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, insertAdjacentHTML(position, html) { assert.equal(position, 'beforeend'); this.innerHTML += html; } };
  const more = { hidden: true }, button = { events: {} }, pending = [], observers = [];
  const elements = { 'msg-list': list, 'message-list-more': more, 'btn-msg-more': button, 'btn-msg-markall': {} };
  for(const id of ['home-today-tasks','home-shift-messages','home-unread','badge-unread-top','badge-unread-bottom']) elements[id]={innerHTML:'',textContent:'',classList:{toggle(){}}};
  const filters = { folderId: '', unreadOnly: false, keyword: '' };
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    // disconnect前にqueueされた通知も再現するため、切断後も呼べる。
    fire(isIntersecting = true) { this.callback([{ target: this.target, isIntersecting }]); }
  }
  const sandbox = {
    HAS_ACTIVE_EMAIL: true, PRIVATE_STORAGE_BLOCKED: false, AUTH_NOTICE_SHOWN: true,
    RETURN_AUTH_SYNC_INFLIGHT: null, IDENTITY_RELOAD_IN_PROGRESS: false,
    CURRENT_VIEW: 'messages', LAST_MESSAGES_FETCH_AT: 0, HOME_SOURCE: { inflight: null },
    owner: 'account-a', resolveCurrentIdentity() { return sandbox.owner; },
    MessageViewController: { getFilters: () => filters },
    byId: id => elements[id],
    on(id, event, handler) { elements[id].events[event] = handler; },
    getUiLabel: (_key, fallback) => fallback,
    esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    rowMsg: message => '<article data-memo="' + message.id + '"></article>',
    renderMessageCard: message => '<article data-memo="' + message.id + '"></article>',
    findShiftFolderId:()=>'',isShiftFolderMessage:()=>false,tShift:(_key,fallback)=>fallback,
    TASK_STATE:{my:{rows:[]}},rowTask:()=>'',collectActiveTaskRows:rows=>rows,updateTaskOverdueBadge:()=>0,
    authRequiredCard: () => 'login', skel: () => 'loading', notify() {},
    shouldThrottleFetch: (last, opts) => !opts.force && last > 0 && Date.now() - last < 60000,
    readUserCacheEntry: async () => null, writeUserCacheEntry: async () => true,
    google: { script: { get run() {
      const request = {};
      const chain = {
        withSuccessHandler(handler) { request.success = handler; return chain; },
        withFailureHandler(handler) { request.failure = handler; return chain; },
        getMessages(args) { pending.push({ ...request, args }); },
      };
      return chain;
    } } },
  };
  if (options.observer !== false) sandbox.IntersectionObserver = Observer;
  runInNewContext(
    block('function coerceDate', 'function extractTaskPayload') +
    block('function messageDisplayDate', 'function renderMessageCard') +
    block('function messageActivityValue', 'function setMsgLoading') +
    block('function renderHomeView', 'function collectActiveTaskRows') +
    block('function setMsgLoading', 'function handleMessageCardClick') +
    block("on('btn-msg-more', 'click'", '\n\n      function navigateToShiftFolder') +
    'globalThis.api = { loadMessages, renderHomeView, getSource: () => MESSAGE_SOURCE, seed(rows) { clearMessagePresentation(MESSAGE_SOURCE); MESSAGE_SOURCE = { identity: resolveCurrentIdentity(), rows: sortMessagesByActivity(rows), loaded: true, inflight: null }; LAST_MESSAGES_FETCH_AT = Date.now(); } };',
    sandbox,
  );
  const ids = () => Array.from(list.innerHTML.matchAll(/data-memo="([^"]+)"/g), match => match[1]);
  const headers = () => (list.innerHTML.match(/<h3 /g) || []).length;
  const clickMore = () => button.events.click();
  function finish() {
    for (let safety = 0; !more.hidden && safety < 100; safety++) clickMore();
    assert.equal(more.hidden, true, 'さらに表示から最終行まで到達できる');
  }
  return { sandbox, filters, list, more, pending, observers, elements, ids, headers, clickMore, finish, ...sandbox.api };
}

test('同じ日付を24件境界で重複させず、次の日付だけ見出しを追加する', async () => {
  const s = setup();
  const rows = many(50).map((message, index) => ({ ...message, createdAt: epoch - (index < 26 ? 0 : 86400000) - index * 1000 }));
  s.seed(rows); await s.loadMessages();
  assert.equal(s.ids().length, 24); assert.equal(s.headers(), 1);
  s.clickMore(); assert.equal(s.ids().length, 48); assert.equal(s.headers(), 2);
  s.clickMore(); assert.equal(s.ids().length, 50); assert.equal(s.headers(), 2);
  assert.equal(new Set(s.ids()).size, 50); assert.equal(s.more.hidden, true);
});

test('ホームは新着3件のプレビューに絞り、未読バッジの全件数を保つ',()=>{
  const s=setup(); const rows=many(80).map(message=>({...message,isRead:false}));
  s.renderHomeView({tasks:[],messages:rows});
  assert.equal((s.elements['home-unread'].innerHTML.match(/data-memo=/g)||[]).length,3);
  assert.equal(Number(s.elements['badge-unread-bottom'].textContent),80);
});

test('24件以降にある本文の検索一致も全sourceから見つける', async () => {
  const s = setup(); const rows = many(80);
  rows[63].body = '探す対象'; rows[64].title = '探す対象'; rows[64].folderId = 'two';
  s.seed(rows); await s.loadMessages(); assert.equal(s.ids().includes('m63'), false);
  s.filters.keyword = '探す'; s.filters.folderId = 'one'; await s.loadMessages({ localOnly: true });
  assert.deepEqual(s.ids(), ['m63']); assert.equal(s.more.hidden, true); assert.equal(s.pending.length, 0);
});

test('未読と既読後の新着コメントを全sourceから抽出し、末尾まで表示する', async () => {
  const s = setup(); const rows = many(80);
  for (let index = 30; index < 60; index++) rows[index].isRead = false;
  rows[75].hasNewComment = true;
  s.seed(rows); s.filters.unreadOnly = true; await s.loadMessages();
  assert.equal(s.ids().length, 24); assert.equal(s.ids()[0], 'm30');
  s.finish(); assert.equal(s.ids().length, 31); assert.equal(s.ids().at(-1), 'm75');
  assert.equal(s.ids().includes('m74'), false); assert.equal(new Set(s.ids()).size, 31);
});

test('IOとさらに表示を併用して最終ページを一度だけ追加する', async () => {
  const s = setup(); s.seed(many(55)); await s.loadMessages();
  const observer = s.observers[0]; assert.equal(observer.target, s.more);
  observer.fire(false); assert.equal(s.ids().length, 24);
  observer.fire(); assert.equal(s.ids().length, 48);
  s.clickMore(); assert.equal(s.ids().length, 55);
  assert.equal(s.more.hidden, true); assert.equal(observer.disconnected, true);
  observer.fire(); s.clickMore(); assert.equal(s.ids().length, 55);
  assert.equal(new Set(s.ids()).size, 55); assert.doesNotMatch(s.list.innerHTML, /メッセージはありません/);
});

test('IntersectionObserverがない環境もボタンで全件へ到達できる', async () => {
  const s = setup({ observer: false }); s.seed(many(73)); await s.loadMessages();
  assert.equal(s.ids().length, 24); s.finish();
  assert.equal(s.ids().length, 73); assert.equal(new Set(s.ids()).size, 73);
});

test('同じfilterのforce更新は展開件数を保ち、旧observerから追加しない', async () => {
  const s = setup(); s.seed(many(70)); await s.loadMessages();
  const oldObserver = s.observers[0]; oldObserver.fire(); assert.equal(s.ids().length, 48);
  const force = s.loadMessages({ force: true }); await tick();
  s.pending[0].success(many(71)); await force;
  assert.equal(s.ids().length, 48); assert.equal(oldObserver.disconnected, true);
  const before = s.list.innerHTML; oldObserver.fire(); assert.equal(s.list.innerHTML, before);
  s.finish(); assert.equal(s.ids().length, 71); assert.equal(new Set(s.ids()).size, 71);
});

test('filter変更後の旧observerは旧filterのカードを追加しない', async () => {
  const s = setup(); s.seed(many(70).map((message, index) => ({ ...message, isRead: index % 2 === 0 })));
  await s.loadMessages(); const oldObserver = s.observers[0];
  s.filters.unreadOnly = true; await s.loadMessages({ localOnly: true });
  const before = s.list.innerHTML; oldObserver.fire(); assert.equal(s.list.innerHTML, before);
  s.finish(); assert.equal(s.ids().length, 35); assert.ok(s.ids().every(id => Number(id.slice(1)) % 2 === 1));
});

test('本人切替後は旧observerを止め、新アカウントのsourceだけを表示する', async () => {
  const s = setup(); s.seed(many(60)); await s.loadMessages(); const oldObserver = s.observers[0];
  s.sandbox.owner = 'account-b'; const loading = s.loadMessages(); await tick();
  assert.equal(oldObserver.disconnected, true);
  s.pending[0].success([row(1, { id: 'private-b' })]); await loading;
  oldObserver.fire(); assert.deepEqual(s.ids(), ['private-b']);
  s.sandbox.PRIVATE_STORAGE_BLOCKED = true; await s.loadMessages();
  oldObserver.fire(); assert.equal(s.list.innerHTML, 'login'); assert.equal(s.more.hidden, true);
});

test('通常の再訪は24件へ戻し、履歴復帰のresetPage:falseは展開を保持する', async () => {
  const s = setup(); s.seed(many(70)); await s.loadMessages(); s.clickMore();
  await s.loadMessages({ resetPage: false }); assert.equal(s.ids().length, 48);
  const oldObserver = s.observers.at(-1);
  await s.loadMessages({ resetPage: true }); assert.equal(s.ids().length, 24);
  oldObserver.fire(); assert.equal(s.ids().length, 24);
});

test('通常navのresetは一度だけ行い、取得待ち中の追加表示を応答で縮めない', async () => {
  const s = setup(); s.seed(many(70));
  s.sandbox.LAST_MESSAGES_FETCH_AT = Date.now() - 61000;
  const loading = s.loadMessages({ resetPage: true }); await tick();
  assert.equal(s.ids().length, 24);
  s.clickMore(); assert.equal(s.ids().length, 48);
  s.pending[0].success(many(71)); await loading;
  assert.equal(s.ids().length, 48);
});

test('空の取得済み一覧から新しいデータへ更新しても、空メッセージを残さない',async()=>{
  const s=setup();s.seed([]);await s.loadMessages();
  const loading=s.loadMessages({force:true});await tick();s.pending[0].success(many(30));await loading;
  assert.equal(s.ids().length,24);assert.doesNotMatch(s.list.innerHTML,/メッセージはありません/);
  s.finish();assert.equal(s.ids().length,30);
});

test('古い個人pinを先頭へ保ち、通常カードまで重複せず到達する', async () => {
  const s = setup();
  const rows = many(60).reverse();
  rows.push(row(100, { id: 'pin-old', isPinned: true }), row(90, { id: 'pin-new', isPinned: true }));
  s.seed(rows); await s.loadMessages();
  assert.deepEqual(s.ids().slice(0, 2), ['pin-new', 'pin-old']);
  s.finish(); assert.equal(s.ids().length, 62); assert.equal(new Set(s.ids()).size, 62);
  assert.equal((s.list.innerHTML.match(/message-divider--pin/g) || []).length, 1);
  assert.deepEqual(s.ids().slice(2), Array.from({ length: 60 }, (_, index) => 'm' + index));
});
