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
class Element {
  value = ''; checked = false; dataset = {}; attributes = {}; events = {};
  classList = { toggle() {} }; focused = false;
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  fire(name, values = {}) { this.events[name]?.({ preventDefault() {}, stopImmediatePropagation() {}, ...values }); }
}
function setup() {
  const elements = Object.fromEntries(['flt-msg-folder', 'flt-msg-unread', 'msg-search-box', 'message-mode', 'view-messages'].map(id => [id, new Element()]));
  const buttons = ['all', 'unread'].map(mode => Object.assign(new Element(), { dataset: { messageMode: mode } }));
  elements['message-mode'].querySelectorAll = () => buttons;
  elements['message-mode'].querySelector = selector => buttons.find(b => selector.includes('"' + b.dataset.messageMode + '"'));
  let loads = 0;
  const document = { documentElement: { scrollTop: 0 }, body: { scrollTop: 0 } };
  const sandbox = {
    document,
    window: { userInfo: { role: 'member' } }, CURRENT_USER_ROLE: 'member', CURRENT_VIEW: 'messages',
    PROFILE_PLACEHOLDER_URL: '', getUserProfile: () => null,
    getUiLabel: (_key, fallback) => fallback, byId: id => elements[id],
    on: (id, event, fn) => elements[id].addEventListener(event, fn), debounce: fn => fn,
    syncHeaderFilterIndicators() {}, loadMessages() { loads++; },
    esc: value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  };
  runInNewContext(
    block('function coerceDate', 'function normalizeArray') +
    block('function normalizeArray', 'function extractTaskPayload') +
    block('function scrollToTopNow()', 'function ensureAdminViewHidden') +
    block('const MessageViewController = (function () {', '// ===== Messages =====') +
    block('function sanitizePersonLabel', 'function setMsgLoading') +
    'globalThis.ui = { renderMessageCard, renderMessageList, filterMessages, messageDayLabel, MessageViewController };', sandbox);
  return { ui: sandbox.ui, elements, buttons, loads: () => loads,
    scroll(y) { document.documentElement.scrollTop = document.body.scrollTop = y; },
    position: () => [document.documentElement.scrollTop, document.body.scrollTop] };
}
const date = (day, hour = 12) => new Date(2026, 10, day, hour).getTime();
const message = (id, values = {}) => ({ id, title: '連絡', body: '本文', createdByLabel: '担当', createdAt: date(12), isRead: true, ...values });
test('ピンと日付で一度だけ区切り、コメント更新の日付と時刻を揃える', () => {
  const { ui } = setup();
  const rows = ui.filterMessages([
    message('old-comment', { createdAt: date(8), lastCommentAt: date(12, 18), hasNewComment: true }),
    message('today'), message('yesterday', { createdAt: date(11) }),
    message('p1', { isPinned: true }), message('p2', { isPinned: true, createdAt: date(9) }),
  ], {});
  const html = ui.renderMessageList(rows);
  for (const id of ['p1', 'p2', 'old-comment', 'today', 'yesterday']) assert.equal(html.split('data-memo="' + id + '"').length - 1, 1);
  assert.equal((html.match(/<h3 /g) || []).length, 3);
  assert.match(html, /message-divider--pin/);
  assert.match(html, /<span class="visually-hidden">ピン留め<\/span>/);
  assert.ok(html.indexOf('data-memo="p1"') < html.indexOf('data-memo="old-comment"'));
  assert.match(html, /更新 18:00/);
  assert.match(ui.renderMessageList([]), /メッセージはありません/);
});
test('一覧は改行を空白へまとめ、本文と題名をescapeし、個人ピンの状態を示す', () => {
  const { ui } = setup();
  const m = message('x', { title: '<img>', body: '用意しました。\r\n\nバーの下です。 <script>', isPinned: true });
  const html = ui.renderMessageCard(m, { grouped: true });
  assert.match(html, /用意しました。 バーの下です。 &lt;script&gt;/);
  assert.match(html, /&lt;img&gt;/); assert.doesNotMatch(html, /<br>/);
  assert.match(html, /aria-pressed="true"/); assert.match(html, /12:00/);
  assert.doesNotMatch(html, /11\/12/);
  assert.doesNotMatch(ui.renderMessageCard(m, { hideAction: true }), /msg-action-btn/);
});
test('未読と検索とフォルダを同時に絞り、新着コメントを見落とさない', () => {
  const { ui } = setup();
  const rows = ui.filterMessages([
    message('comment', { folderId: 'main', hasNewComment: true }),
    message('read', { folderId: 'main' }),
    message('unread', { folderId: 'main', isRead: false }),
    message('other', { folderId: 'other', isRead: false }),
  ], { folderId: 'MAIN', unreadOnly: true, keyword: '本文' });
  assert.equal(Array.from(rows, m => m.id).sort().join(','), 'comment,unread');
});
test('セグメント、矢印キー、既存checkboxが同じ未読状態を持つ', () => {
  const { ui, elements, buttons, loads } = setup();
  ui.MessageViewController.init();
  buttons[1].fire('click');
  assert.equal(ui.MessageViewController.getFilters().unreadOnly, true);
  assert.equal(buttons[1].attributes['aria-pressed'], 'true'); assert.equal(loads(), 1);
  buttons[1].fire('click'); assert.equal(loads(), 1);
  buttons[1].fire('keydown', { key: 'ArrowLeft' });
  assert.equal(ui.MessageViewController.getFilters().unreadOnly, false); assert.equal(loads(), 2);
  assert.equal(buttons[0].focused, true);
  elements['flt-msg-unread'].checked = true; elements['flt-msg-unread'].fire('change');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  elements['flt-msg-folder'].value = 'ALL'; assert.equal(ui.MessageViewController.getFilters().folderId, '');
  elements['flt-msg-folder'].value = 'main'; assert.equal(ui.MessageViewController.getFilters().folderId, 'main');
});
test('年越しの昨日と過去年を区別する', () => {
  const { ui } = setup();
  assert.match(ui.messageDayLabel(new Date(2025, 11, 31), new Date(2026, 0, 1)), /^昨日・2025\//);
  assert.match(ui.messageDayLabel(new Date(2026, 0, 1), new Date(2026, 0, 1)), /^今日・/);
});

test('スワイプ後の合成clickは切替を巻き戻さない', () => {
  const { ui, elements, buttons, loads } = setup();
  ui.MessageViewController.init();
  elements['message-mode'].fire('pointerdown', {clientX: 100, clientY: 20});
  elements['message-mode'].fire('pointerup', {clientX: 20, clientY: 20});
  buttons[0].fire('click');
  assert.equal(ui.MessageViewController.getFilters().unreadOnly, true);
  assert.equal(loads(), 1);
  elements['message-mode'].fire('pointerdown', {clientX: 100, clientY: 20});
  buttons[0].fire('click');
  assert.equal(ui.MessageViewController.getFilters().unreadOnly, false);
});

test('一覧全体の左右スワイプで切り替え、縦スクロールとピン操作を妨げない', () => {
  const { ui, elements, loads } = setup();
  ui.MessageViewController.init();
  const panel = elements['view-messages'];
  const card = {closest: () => null};
  const gesture = (dx,dy,target=card) => {
    panel.fire('pointerdown', {clientX:150,clientY:100,pointerId:1,target});
    panel.fire('pointerup', {clientX:150+dx,clientY:100+dy,pointerId:1,target});
  };
  gesture(-90,8); assert.equal(ui.MessageViewController.getFilters().unreadOnly,true);
  let prevented=false; panel.fire('click',{preventDefault(){prevented=true;}}); assert.equal(prevented,true);
  gesture(90,8); assert.equal(ui.MessageViewController.getFilters().unreadOnly,false);
  gesture(-20,90); assert.equal(loads(),2);
  gesture(-90,0,{closest:()=>({})}); assert.equal(loads(),2);
});

test('深い位置から未読・すべてへ切り替えると、先頭位置で一覧を表示する', () => {
  const s = setup(); s.ui.MessageViewController.init();
  s.scroll(1800); s.buttons[1].fire('click');
  assert.deepEqual(s.position(), [0, 0]); assert.equal(s.loads(), 1);
  s.scroll(1400); s.buttons[1].fire('keydown', { key: 'ArrowLeft' });
  assert.deepEqual(s.position(), [0, 0]); assert.equal(s.loads(), 2);
  s.scroll(1200); s.elements['flt-msg-unread'].checked = true; s.elements['flt-msg-unread'].fire('change');
  assert.deepEqual(s.position(), [0, 0]); assert.equal(s.loads(), 3);
});

test('一覧とバーの左右スワイプも先頭へ戻し、縦方向の操作では位置を維持する', () => {
  const s = setup(); s.ui.MessageViewController.init();
  const gesture = (surface, dx, dy) => {
    surface.fire('pointerdown', { clientX: 150, clientY: 100, pointerId: 1, target: { closest: () => null } });
    surface.fire('pointerup', { clientX: 150 + dx, clientY: 100 + dy, pointerId: 1 });
  };
  s.scroll(2000); gesture(s.elements['view-messages'], -90, 4);
  assert.deepEqual(s.position(), [0, 0]); assert.equal(s.ui.MessageViewController.getFilters().unreadOnly, true);
  s.scroll(1600); gesture(s.elements['message-mode'], 90, 4);
  assert.deepEqual(s.position(), [0, 0]); assert.equal(s.ui.MessageViewController.getFilters().unreadOnly, false);
  s.scroll(1500); gesture(s.elements['view-messages'], -20, 90);
  assert.deepEqual(s.position(), [1500, 1500]); assert.equal(s.loads(), 2);
});

test('同じmodeの再タップと検索入力ではスクロール位置を巻き戻さない', () => {
  const s = setup(); s.ui.MessageViewController.init();
  s.scroll(1300); s.buttons[0].fire('click');
  assert.deepEqual(s.position(), [1300, 1300]); assert.equal(s.loads(), 0);
  s.elements['msg-search-box'].value = '連絡'; s.elements['msg-search-box'].fire('input');
  assert.deepEqual(s.position(), [1300, 1300]); assert.equal(s.loads(), 1);
});
