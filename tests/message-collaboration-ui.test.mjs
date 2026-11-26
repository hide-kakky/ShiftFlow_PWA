import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const indexSource = await readFile(
  new URL('../frontend/public/index.html', import.meta.url),
  'utf8'
);

function sliceBetween(start, end) {
  const startIndex = indexSource.indexOf(start);
  const endIndex = indexSource.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `開始位置が見つかりません: ${start}`);
  assert.notEqual(endIndex, -1, `終了位置が見つかりません: ${end}`);
  return indexSource.slice(startIndex, endIndex);
}

test('メッセージカードはコメント件数と新着コメントを表示する', () => {
  const block = sliceBetween('function renderMessageCard', 'function rowMsg');
  assert.match(block, /commentCount/);
  assert.match(block, /hasNewComment/);
  assert.match(block, /新着コメント/);
  assert.match(block, /msg-comment-badge--new/);
  assert.match(block, /!isRead \|\| hasNewComment/);
});

test('未読一覧とホームは既読後の新着コメントも対象にする', () => {
  const filterBlock = sliceBetween('function filterMessages', 'function loadMessagesFromCache');
  const homeBlock = sliceBetween('function renderHomeView', 'function collectActiveTaskRows');
  assert.match(filterBlock, /!x\.isRead \|\| x\.hasNewComment/);
  assert.match(homeBlock, /!x\.isRead \|\| x\.hasNewComment/);
  assert.match(indexSource, /const API_REFRESH_INTERVAL_MS = 60 \* 1000/);
  assert.match(indexSource, /refreshCollaborationViewOnReturn/);
});

test('個人ピンはmemberにも表示し、明示状態をAPIへ送る', () => {
  const cardBlock = sliceBetween('function renderMessageCard', 'function rowMsg');
  const toggleBlock = sliceBetween('function togglePin', "on('btn-msg-markall'");
  assert.doesNotMatch(cardBlock, /if \(IS_MANAGER\)/);
  assert.doesNotMatch(toggleBlock, /if \(!IS_MANAGER\)/);
  assert.match(cardBlock, /canPinMessages\(\)/);
  assert.match(toggleBlock, /body: \{ pin: !!shouldPin \}/);
  assert.match(toggleBlock, /自分用にピン留め/);
});

function detailEntryFixture() {
  const openBlock = sliceBetween('function openMessageModal', "on('btnCommentPost'");
  const commentBlock = sliceBetween("on('btnCommentPost'", "on('btnMsgToTask'");
  const elements = new Map(), requests = [], handlers = new Map(), rendered = [];
  let refreshes = 0;
  const sandbox = {
    CURRENT_MEMO_ID: 'memo',
    byId(id) {
      if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', disabled: false,
        classList: {add() {}, remove() {}}});
      return elements.get(id);
    },
    bootstrap: {Modal: {getInstance: () => ({show() {}})}},
    renderMessageDetail: value => rendered.push(value),
    refreshHomeAndMessages: () => { refreshes++; return Promise.resolve(true); },
    notify() {}, setButtonLoading(button, loading) {button.disabled = loading;},
    on(id, event, handler) {handlers.set(id + ':' + event, handler);},
    google: {script: {get run() {
      const request = {}, chain = {
        withSuccessHandler(fn) {request.success = fn; return chain;},
        withFailureHandler(fn) {request.failure = fn; return chain;},
      };
      for (const route of ['markMemoAsRead', 'getMessageById', 'addNewComment']) {
        chain[route] = value => requests.push({...request, route, value});
      }
      return chain;
    }}},
  };
  runInNewContext(openBlock + commentBlock, sandbox);
  return {sandbox, elements, requests, handlers, rendered, refreshes: () => refreshes};
}

test('詳細は既読反映と詳細取得の成功後にHome・一覧の共有更新を1回起動する', () => {
  const s = detailEntryFixture();
  s.sandbox.openMessageModal('memo');
  assert.equal(s.requests[0].route, 'markMemoAsRead');
  assert.equal(s.refreshes(), 0);
  s.requests[0].success();
  assert.equal(s.requests[1].route, 'getMessageById');
  assert.equal(s.refreshes(), 0);
  const detail = {id: 'memo', isRead: true, comments: [{id: 'new-comment'}]};
  s.requests[1].success(detail);
  assert.deepEqual(s.rendered, [detail]);
  assert.equal(s.refreshes(), 1);
});

test('コメント投稿成功は詳細の読み直しから共有更新へ進み、失敗では再取得しない', () => {
  for (const success of [true, false]) {
    const s = detailEntryFixture();
    s.sandbox.byId('newCommentBody').value = '追加コメント';
    s.handlers.get('btnCommentPost:click')();
    assert.equal(s.requests[0].route, 'addNewComment');
    assert.equal(s.requests[0].value.body, '追加コメント');
    assert.equal(s.refreshes(), 0);
    s.requests[0].success({success});
    assert.equal(s.requests.length, success ? 2 : 1);
    if (success) {
      assert.equal(s.requests[1].route, 'markMemoAsRead');
      s.requests[1].success();
      s.requests[2].success({id: 'memo', commentCount: 1});
      assert.equal(s.refreshes(), 1);
    } else {
      assert.equal(s.sandbox.byId('newCommentBody').value, '追加コメント');
      assert.equal(s.refreshes(), 0);
    }
    assert.equal(s.sandbox.byId('btnCommentPost').disabled, false);
  }
});
