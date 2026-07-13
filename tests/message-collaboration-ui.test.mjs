import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  const filterBlock = sliceBetween('function filterMessages', 'function getMessagesCacheKey');
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

test('コメント投稿と詳細閲覧の後は一覧とホームを即時再取得する', () => {
  const openBlock = sliceBetween('function openMessageModal', "on('btnCommentPost'");
  const commentBlock = sliceBetween("on('btnCommentPost'", "on('btnMsgToTask'");
  assert.match(openBlock, /loadMessages\(\{ force: true \}\)/);
  assert.match(openBlock, /loadHome\(\{ force: true \}\)/);
  assert.match(commentBlock, /res\.success !== false/);
  assert.match(commentBlock, /openMessageModal\(CURRENT_MEMO_ID\)/);
});
