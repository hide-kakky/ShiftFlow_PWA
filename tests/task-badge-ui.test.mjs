import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../frontend/public/index.html', import.meta.url), 'utf8');
function block(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
const now = new Date(2026, 10, 13, 12).getTime();
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const task = (id, values = {}) => ({ id, title: '担当タスク', dueDate: '2026/11/12', status: '未着手', isCompleted: false, ...values });
function fixture() {
  const elements = new Map();
  function byId(id) {
    if (!elements.has(id)) {
      const classes = new Set(['d-none']);
      elements.set(id, { textContent: '', innerHTML: '', attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } } });
    }
    return elements.get(id);
  }
  const sandbox = { Date: Clock, window: {}, IS_MANAGER: true, byId,
    HOME_SOURCE: { payload: null }, LAST_HOME_FETCH_AT: 0, LAST_TASK_FETCH_AT: {my: 0},
    normalizeArray: value => Array.isArray(value) ? value : [],
    sortMessagesByActivity: value => value, rowTask: () => '', renderMessageCard: () => '', renderShiftHomeCard: () => '',
    findShiftFolderId: () => '', isShiftFolderMessage: () => false, esc: value => value, tShift: (_key, fallback) => fallback };
  runInNewContext(block('const TASK_STATE =', 'const TASK_FILTERS =') +
    block('function renderHomeView', 'function loadHomeFromCache') +
    block('function isTaskOverdue', 'function rowTask') +
    'globalThis.ui = { state:TASK_STATE, updateTaskOverdueBadge, computeOverdueTaskCount, renderHomeView };', sandbox);
  return { ui: sandbox.ui, byId, sandbox };
}

test('constの担当タスクを再集計し、他人の担当・自分の依頼一覧を件数へ混ぜない', () => {
  const s = fixture();
  s.ui.state.my.rows = [task('mine')]; s.ui.state.my.loaded = true;
  s.ui.state.from.rows = [task('other-request')]; s.ui.state.all.rows = [task('other')];
  assert.equal(s.ui.updateTaskOverdueBadge(), 1);
  for (const id of ['badge-task-overdue-top', 'badge-task-overdue-bottom']) {
    assert.equal(s.byId(id).textContent, 1); assert.equal(s.byId(id).classList.contains('d-none'), false);
  }
});

test('担当タスクを取得し直した明示的な空配列は、古い一覧へ戻らずバッジを消す', () => {
  const s = fixture(); s.ui.state.my.rows = [task('stale')];
  assert.equal(s.ui.updateTaskOverdueBadge([]), 0);
  assert.equal(s.byId('badge-task-overdue-bottom').classList.contains('d-none'), true);
});

test('取得済みの担当一覧が空なら、古いHome応答の期限超過をバッジへ復活させない', () => {
  const s = fixture(); s.ui.state.my.loaded = true;
  s.ui.renderHomeView({ tasks: [task('old-home')], messages: [] });
  assert.equal(s.byId('badge-task-overdue-bottom').textContent, 0);
});

test('期限切れ未完了だけを数え、今日・未来・完了・キャンセル・無期限を数えない', () => {
  const s = fixture();
  const rows = [task('late'), task('today', { dueDate: '2026/11/13', status: '対応中' }),
    task('future', { dueDate: '2026/11/14' }), task('complete', { isCompleted: true, status: '完了' }),
    task('canceled', { status: 'キャンセル' }), task('english-cancel', { status: ' Cancelled ' }),
    task('english-done', { status: 'completed' }), task('no-due', { dueDate: '' }), task('bad-due', { dueDate: 'invalid' })];
  assert.equal(s.ui.computeOverdueTaskCount(rows), 1);
});

test('閲覧では担当バッジが残り、完了・延期・担当解除の再取得で減る', () => {
  const s = fixture(); const rows = [task('a'), task('b')]; s.ui.state.my.rows = rows;
  assert.equal(s.ui.updateTaskOverdueBadge(), 2);
  assert.equal(s.ui.updateTaskOverdueBadge(), 2, '画面再集計だけでは消えない');
  rows[0].status = '完了'; rows[0].isCompleted = true;
  assert.equal(s.ui.updateTaskOverdueBadge(), 1);
  rows[1].dueDate = '2026/11/14'; assert.equal(s.ui.updateTaskOverdueBadge(), 0);
  s.ui.state.my.rows = []; assert.equal(s.ui.updateTaskOverdueBadge(), 0);
});

test('新しいHomeの担当期限超過を反映し、その後の担当再取得が空なら消す', () => {
  const s = fixture(); s.ui.state.my.loaded = true;
  s.sandbox.LAST_TASK_FETCH_AT.my = 100; s.sandbox.LAST_HOME_FETCH_AT = 200;
  s.sandbox.HOME_SOURCE.payload = {tasks:[task('new-assignment')],messages:[]};
  s.ui.renderHomeView(s.sandbox.HOME_SOURCE.payload);
  assert.equal(s.byId('badge-task-overdue-bottom').textContent, 1);
  assert.equal(s.ui.updateTaskOverdueBadge(), 1, '別一覧の再描画でも新しいHome集計を保つ');
  s.sandbox.LAST_TASK_FETCH_AT.my = 300;
  s.ui.state.my.rows = [];
  assert.equal(s.ui.updateTaskOverdueBadge([]), 0);
  assert.equal(s.ui.updateTaskOverdueBadge(), 0, 'より新しい空の担当一覧を優先する');
});

test('新しい担当タスクの作成と閲覧だけでは期限切れバッジを増やさない', () => {
  const s = fixture();
  s.ui.state.my.rows = [task('new', { dueDate: '2026/11/14' })];
  s.ui.state.my.loaded = true;
  assert.equal(s.ui.updateTaskOverdueBadge(), 0);
  assert.equal(s.ui.updateTaskOverdueBadge(), 0);
});
