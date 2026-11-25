import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { SqliteD1 } from './helpers/d1-test-utils.mjs';
import { computeAppBadge } from '../functions/utils/appBadge.js';

const NOW = Date.parse('2026-11-13T03:00:00Z');
const JST_TODAY = Date.parse('2026-11-12T15:00:00Z');
const migrations = await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
  .filter(name => /^\d{3}_/.test(name) && !name.startsWith('999')).sort()
  .map(name => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')));
const actor = { orgId: 'org-a', userId: 'a', membershipId: 'ma', email: 'a@example.invalid', isManager: false, now: NOW };

function fixture(t) {
  const db = new SqliteD1(); t.after(() => db.close()); migrations.forEach(sql => db.exec(sql));
  db.exec(`INSERT INTO organizations(org_id,name,created_at_ms) VALUES('org-a','A',1),('org-b','B',1);
    INSERT INTO users(user_id,email,status,is_active,created_at_ms,updated_at_ms) VALUES
      ('a','a@example.invalid','active',1,1,1),('b','b@example.invalid','active',1,1,1),
      ('manager','manager@example.invalid','active',1,1,1),('guest','guest@example.invalid','active',1,1,1);
    INSERT INTO memberships(membership_id,org_id,user_id,role,status,created_at_ms) VALUES
      ('ma','org-a','a','member','active',1),('mb','org-a','b','member','active',1),
      ('manager-a','org-a','manager','manager','active',1),('guest-a','org-a','guest','guest','active',1),
      ('ma-other','org-b','a','member','active',1);
    INSERT INTO folders(id,org_id,name,is_active,is_public,created_at_ms,updated_at_ms) VALUES
      ('public','org-a','公開',1,1,1,1),('joined','org-a','参加済み',1,0,1,1),
      ('private','org-a','未参加',1,0,1,1),('inactive','org-a','終了',0,1,1,1),
      ('other','org-b','別組織',1,1,1,1);
    INSERT INTO folder_members(folder_id,user_id,added_at_ms) VALUES('joined','a',1);`);
  const message = async (id, folder = 'public', org = 'org-a') => {
    await db.prepare('INSERT INTO messages(message_id,org_id,folder_id,title,body,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,1,1)')
      .bind(id, org, folder, '返さない件名', '返さない本文').run();
  };
  const read = async (id, at = 100, membership = 'ma') => {
    await db.prepare('INSERT INTO message_reads(message_read_id,message_id,membership_id,read_at_ms) VALUES(?1,?2,?3,?4)')
      .bind(id + ':' + membership, id, membership, at).run();
  };
  let commentId = 0;
  const comment = async (id, at = 101, org = 'org-a') => {
    await db.prepare('INSERT INTO message_comments(comment_id,message_id,org_id,body,created_at_ms,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?5)')
      .bind('comment-' + ++commentId, id, org, '返さないコメント', at).run();
  };
  const task = async (id, options = {}) => {
    await db.prepare(`INSERT INTO tasks(task_id,org_id,folder_id,title,status,created_by_email,created_by_membership_id,created_at_ms,updated_at_ms,due_at_ms)
      VALUES(?1,?2,?3,?4,?5,'a@example.invalid','ma',1,1,?6)`)
      .bind(id, options.org || 'org-a', options.folder || null, '返さないタスク', options.status || 'open', options.due === undefined ? JST_TODAY - 1 : options.due).run();
  };
  const assign = async (id, email = 'a@example.invalid', membership = 'ma') => {
    await db.prepare('INSERT INTO task_assignees(task_id,email,membership_id,assigned_at_ms) VALUES(?1,?2,?3,1)')
      .bind(id, email, membership).run();
  };
  return { db, message, read, comment, task, assign };
}

test('閲覧可能なactive folderだけを数え、別tenant・不整合folder・未所属を混ぜない', async t => {
  const f = fixture(t);
  await f.message('public'); await f.message('joined', 'joined'); await f.message('private', 'private');
  await f.message('inactive', 'inactive'); await f.message('other', 'other', 'org-b');
  await f.message('wrong-folder-org', 'other'); await f.message('missing-folder', 'missing'); await f.message('no-folder', null);
  assert.deepEqual(await computeAppBadge(f.db, actor), { messageUnread: 2, taskOverdue: 0, total: 2, computedAt: NOW });
  assert.equal(f.db.sessionConsistencyModes.at(-1), 'first-primary');
});

test('本文未読または新着コメントをmessageごとに一度だけ数え、他membershipの既読を使わない', async t => {
  const f = fixture(t);
  for (const id of ['unread', 'read', 'new-comment', 'equal-comment', 'old-comment', 'zero-read', 'updated-only', 'wrong-comment-org', 'many-comments', 'other-reader']) await f.message(id);
  for (const id of ['read', 'new-comment', 'equal-comment', 'old-comment', 'updated-only', 'wrong-comment-org', 'many-comments']) await f.read(id);
  await f.read('zero-read', 0); await f.read('other-reader', 200, 'mb');
  await f.comment('new-comment', 101); await f.comment('equal-comment', 100); await f.comment('old-comment', 99);
  await f.comment('zero-read', 0); await f.comment('wrong-comment-org', 200, 'org-b');
  await f.comment('many-comments', 101); await f.comment('many-comments', 102);
  await f.db.prepare("UPDATE messages SET updated_at_ms=200 WHERE message_id='updated-only'").run();
  const result = await computeAppBadge(f.db, actor);
  assert.equal(result.messageUnread, 5); assert.equal(result.total, 5);
  assert.deepEqual(Object.keys(result).sort(), ['computedAt', 'messageUnread', 'taskOverdue', 'total']);
});

test('管理者scopeをDBroleでも確認し、memberがisManagerだけ偽ってもprivateを数えない', async t => {
  const f = fixture(t); await f.message('private', 'private'); await f.message('inactive', 'inactive');
  assert.equal((await computeAppBadge(f.db, { ...actor, isManager: true })).messageUnread, 0);
  const manager = { ...actor, userId: 'manager', membershipId: 'manager-a', email: 'manager@example.invalid', isManager: true };
  assert.equal((await computeAppBadge(f.db, manager)).messageUnread, 1);
  assert.equal((await computeAppBadge(f.db, { ...manager, isManager: false })).messageUnread, 0);
});

test('org・user・membership・emailが一致しない要求とguestを403にし、0件へ変換しない', async t => {
  const f = fixture(t); await f.message('secret');
  for (const bad of [
    { orgId: 'org-b' }, { userId: 'b' }, { membershipId: 'mb' }, { membershipId: '' }, { email: 'b@example.invalid' },
    { userId: 'guest', membershipId: 'guest-a', email: 'guest@example.invalid' },
  ]) {
    await assert.rejects(computeAppBadge(f.db, { ...actor, ...bad }), error => error.code === 'app_badge_access_denied' && error.httpStatus === 403);
  }
  assert.equal((await computeAppBadge(f.db, { ...actor, email: ' A@EXAMPLE.INVALID ' })).messageUnread, 1);
});

test('利用者停止・membership停止や権限喪失後は既存件数を返さない', async t => {
  const f = fixture(t); await f.message('visible');
  for (const change of [
    "UPDATE users SET is_active=0 WHERE user_id='a'",
    "UPDATE users SET status='suspended' WHERE user_id='a'",
    "UPDATE memberships SET status='pending' WHERE membership_id='ma'",
    "UPDATE memberships SET status='revoked' WHERE membership_id='ma'",
    "UPDATE memberships SET role='guest' WHERE membership_id='ma'",
  ]) {
    f.db.exec("UPDATE users SET is_active=1,status='active' WHERE user_id='a'; UPDATE memberships SET status='active',role='member' WHERE membership_id='ma';");
    f.db.exec(change);
    await assert.rejects(computeAppBadge(f.db, actor), error => error.httpStatus === 403);
  }
});

test('期限超過は本人担当のみで、membership/email双方を支え、重複担当・作成者・別tenantを混ぜない', async t => {
  const f = fixture(t);
  for (const id of ['email', 'membership', 'duplicate', 'creator-only', 'other-user']) await f.task(id);
  await f.task('other-org', { org: 'org-b' }); await f.task('private-assigned', { folder: 'private' }); await f.task('inactive-assigned', { folder: 'inactive' });
  await f.assign('email', 'A@EXAMPLE.INVALID', null); await f.assign('membership', 'former@example.invalid');
  await f.assign('duplicate'); await f.assign('duplicate', 'alias@example.invalid');
  await f.assign('other-user', 'b@example.invalid', 'mb'); await f.assign('other-org');
  await f.assign('private-assigned'); await f.assign('inactive-assigned');
  const result = await computeAppBadge(f.db, actor);
  assert.equal(result.taskOverdue, 5); assert.equal(result.total, 5);
});

test('今日0時より前だけを期限超過とし、完了・キャンセル・今日・期限なしを除く', async t => {
  const f = fixture(t);
  const rows = [
    ['yesterday', { due: JST_TODAY - 1 }], ['midnight', { due: JST_TODAY }], ['today', { due: JST_TODAY + 3600000 }],
    ['tomorrow', { due: JST_TODAY + 86400000 }], ['no-due', { due: null }], ['bad-due', { due: 'not-a-date' }],
    ['completed', { status: 'completed' }], ['completed-case', { status: ' COMPLETED ' }], ['legacy-completed', { status: '完了' }],
    ['progress', { status: 'in_progress' }], ['canceled', { status: 'canceled' }], ['cancelled', { status: 'cancelled' }],
    ['canceled-case', { status: ' CANCELED ' }], ['legacy-canceled', { status: 'キャンセル' }],
  ];
  for (const [id, options] of rows) { await f.task(id, options); await f.assign(id); }
  assert.equal((await computeAppBadge(f.db, actor)).taskOverdue, 2);
});

test('UTCではなくJSTの日付境界で期限超過へ切り替える', async t => {
  const f = fixture(t); await f.task('boundary', { due: Date.parse('2026-11-12T00:00:00Z') }); await f.assign('boundary');
  assert.equal((await computeAppBadge(f.db, { ...actor, now: Date.parse('2026-11-12T14:59:59.999Z') })).taskOverdue, 0);
  assert.equal((await computeAppBadge(f.db, { ...actor, now: Date.parse('2026-11-12T15:00:00.000Z') })).taskOverdue, 1);
});

test('通知全OFF・購読なしでもbadgeを数え、既読・担当解除を次の読取へ反映する', async t => {
  const f = fixture(t); await f.message('unread'); await f.task('overdue'); await f.assign('overdue');
  f.db.exec(`INSERT INTO push_preferences(org_id,user_id,task_assigned,task_updated,version,updated_at_ms) VALUES('org-a','a',0,0,'0',1);
    INSERT INTO push_folder_preferences(org_id,user_id,folder_id,message_created,comment_created,task_assigned,task_updated) VALUES('org-a','a','public',0,0,0,0);`);
  assert.deepEqual(await computeAppBadge(f.db, actor), { messageUnread: 1, taskOverdue: 1, total: 2, computedAt: NOW });
  await f.read('unread', NOW); f.db.exec("DELETE FROM task_assignees WHERE task_id='overdue'");
  assert.deepEqual(await computeAppBadge(f.db, actor), { messageUnread: 0, taskOverdue: 0, total: 0, computedAt: NOW });
  assert.equal(f.db.get('SELECT COUNT(*) AS count FROM push_subscriptions').count, 0);
});

test('無効な計算時刻は安全なcodeで拒否する', async t => {
  const f = fixture(t);
  for (const now of [NaN, Infinity, '2026-11-13']) {
    await assert.rejects(computeAppBadge(f.db, { ...actor, now }), error => error.code === 'app_badge_invalid_time' && error.httpStatus === 400);
  }
});
