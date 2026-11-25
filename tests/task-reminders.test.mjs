import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { SqliteD1 } from './helpers/d1-test-utils.mjs';
import { encode64 } from '../functions/utils/webPush.js';
import { enqueueTaskReminders } from '../functions/utils/taskReminders.js';

const DAY = 86400000;
const TEN_JST = Date.parse('2026-11-13T01:00:00.000Z');
const MIDNIGHT_JST = Date.parse('2026-11-12T15:00:00.000Z');
const fingerprint = id => createHash('sha256').update('fixture-session:' + id).digest('hex');
const migrations = await Promise.all((await readdir(new URL('../migrations/', import.meta.url)))
  .filter(name => /^\d{3}_/.test(name) && !name.startsWith('999')).sort()
  .map(name => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')));

async function fixture(t) {
  const db = new SqliteD1(); t.after(() => db.close()); migrations.forEach(sql => db.exec(sql));
  // migrationを別担当が追加するまでのfixture。追加後も同じテストを使う。
  for (const [table, name, definition] of [
    ['push_preferences', 'task_overdue_reminder', 'INTEGER NOT NULL DEFAULT 0 CHECK(task_overdue_reminder IN (0,1))'],
    ['push_preferences', 'task_reminder_enabled_at_ms', 'INTEGER'],
    ['push_events', 'reminder_day', 'TEXT'],
  ]) {
    if (!db.all(`PRAGMA table_info(${table})`).some(column => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS fixture_push_reminder_day ON push_events(org_id,actor_user_id,reminder_day) WHERE reminder_day IS NOT NULL;
    INSERT INTO organizations(org_id,name,created_at_ms) VALUES('org-a','A',1),('org-b','B',1);`);
  // enqueueだけを確認し、外部送信に使わない合成設定。
  const publicKey = new Uint8Array(65); publicKey[0] = 4;
  const env = { DB: db, WEB_PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: encode64(publicKey),
    VAPID_PRIVATE_KEY: encode64(new Uint8Array(32)), VAPID_SUBJECT: 'mailto:push@example.invalid' };
  async function target(id = 'a', org = 'org-a') {
    await db.prepare(`INSERT INTO users(user_id,email,status,is_active,created_at_ms,updated_at_ms)
      VALUES(?1,?2,'active',1,1,1)`).bind(id, id + '@example.invalid').run();
    await db.prepare(`INSERT INTO memberships(membership_id,org_id,user_id,role,status,created_at_ms)
      VALUES(?1,?2,?3,'member','active',1)`).bind('m-' + id, org, id).run();
    await db.prepare(`INSERT INTO push_preferences(org_id,user_id,task_assigned,task_updated,task_overdue_reminder,task_reminder_enabled_at_ms,updated_at_ms)
      VALUES(?1,?2,0,0,1,?3,1)`).bind(org, id, TEN_JST - DAY).run();
    await db.prepare(`INSERT INTO push_subscriptions(subscription_id,org_id,user_id,endpoint,p256dh,auth,session_fingerprint,session_expires_at_ms,created_at_ms,updated_at_ms)
      VALUES(?1,?2,?3,?4,'fixture-key','fixture-auth',?5,?6,1,1)`)
      .bind('s-' + id, org, id, 'https://web.push.apple.com/fixture-' + id, fingerprint(id), TEN_JST + 3 * DAY).run();
    await task('task-' + id, { org, user: id });
  }
  async function task(id, { org = 'org-a', user = 'a', due = MIDNIGHT_JST - 1, status = 'open', assigned = true } = {}) {
    await db.prepare(`INSERT INTO tasks(task_id,org_id,title,status,created_by_email,created_by_membership_id,created_at_ms,updated_at_ms,due_at_ms)
      VALUES(?1,?2,'外部へ返さない件名',?3,?4,?5,1,1,?6)`)
      .bind(id, org, status, user + '@example.invalid', 'm-' + user, due).run();
    if (assigned) await db.prepare('INSERT INTO task_assignees(task_id,email,membership_id,assigned_at_ms) VALUES(?1,?2,?3,1)')
      .bind(id, user + '@example.invalid', 'm-' + user).run();
  }
  await target();
  const run = (now = TEN_JST) => enqueueTaskReminders(env, { now });
  return { db, env, target, task, run };
}

test('JST10時に本人宛の日次イベントを作成し、当日24時に失効する', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(), { queued: 1 });
  const row = f.db.get('SELECT * FROM push_events');
  assert.match(row.event_id, /^[a-f0-9]{64}$/);
  assert.equal(row.org_id, 'org-a'); assert.equal(row.actor_user_id, 'a');
  assert.equal(row.kind, 'task_updated'); assert.equal(row.reminder_day, '2026-11-13');
  assert.equal(row.resource_id, ''); assert.equal(row.folder_id, null);
  assert.equal(row.recipient_user_ids, '["a"]'); assert.equal(row.excluded_user_ids, '[]');
  assert.equal(row.created_at_ms, TEN_JST); assert.equal(row.expires_at_ms, Date.parse('2026-11-13T15:00:00Z'));
  assert.equal(row.expanded, 0); assert.equal(f.db.sessionConsistencyModes.at(-1), 'first-primary');
});

test('10時前と11時以降はDBを読み書きせず、10時59分のcatchupは実行する', async t => {
  for (const now of [TEN_JST - 1, TEN_JST + 3600000, TEN_JST + DAY - 1]) {
    const f = await fixture(t);
    f.env.DB = { prepare() { throw new Error('窓外でDBを参照した'); } };
    assert.deepEqual(await f.run(now), { queued: 0 });
  }
  const f = await fixture(t);
  assert.deepEqual(await f.run(TEN_JST + 3599999), { queued: 1 });
});

test('10時を過ぎてONにした人は翌朝からで、10時ちょうどのONは対象になる', async t => {
  const f = await fixture(t);
  f.db.prepare('UPDATE push_preferences SET task_reminder_enabled_at_ms=?1').bind(TEN_JST + 1).run();
  assert.deepEqual(await f.run(TEN_JST + 60000), { queued: 0 });
  assert.deepEqual(await f.run(TEN_JST + DAY), { queued: 1 });
  assert.equal(f.db.get('SELECT reminder_day FROM push_events').reminder_day, '2026-11-14');
  const exact = await fixture(t);
  exact.db.prepare('UPDATE push_preferences SET task_reminder_enabled_at_ms=?1').bind(TEN_JST).run();
  assert.deepEqual(await exact.run(), { queued: 1 });
});

test('同時cronや同日の再実行で重複せず、翌日の期限超過は別イベントになる', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.reduce((sum, result) => sum + result.queued, 0), 1);
  const id = f.db.get('SELECT event_id FROM push_events').event_id;
  assert.deepEqual(await f.run(TEN_JST + 60000), { queued: 0 });
  assert.equal(f.db.get('SELECT event_id FROM push_events').event_id, id);
  assert.deepEqual(await f.run(TEN_JST + DAY), { queued: 1 });
  assert.equal(f.db.get('SELECT COUNT(*) AS count FROM push_events').count, 2);
});

test('初回DB保存失敗は全体をrollbackし、次のcronで未作成分を再試行する', async t => {
  const f = await fixture(t); await f.target('b');
  f.db.exec("CREATE TRIGGER fixture_reminder_failure BEFORE INSERT ON push_events WHEN NEW.actor_user_id='b' BEGIN SELECT RAISE(ABORT,'fixture_reminder_failure'); END");
  await assert.rejects(f.run(), /fixture_reminder_failure/);
  assert.equal(f.db.get('SELECT COUNT(*) AS count FROM push_events').count, 0);
  f.db.exec('DROP TRIGGER fixture_reminder_failure');
  assert.deepEqual(await f.run(TEN_JST + 60000), { queued: 2 });
});

test('1回50人までで、次のcronが未作成の残りを拾う', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++) await f.target('target-' + i);
  assert.deepEqual(await f.run(), { queued: 50 });
  assert.deepEqual(await f.run(TEN_JST + 60000), { queued: 1 });
  assert.deepEqual(await f.run(TEN_JST + 120000), { queued: 0 });
  assert.equal(f.db.get('SELECT COUNT(*) AS count FROM push_events').count, 51);
});

test('本人担当と組織と期限を限定し、完了・キャンセル・今日の期限・期限なしを除く', async t => {
  const cases = [
    ["UPDATE tasks SET org_id='org-b'", 0],
    ['DELETE FROM task_assignees', 0],
    ["UPDATE task_assignees SET membership_id=NULL,email='other@example.invalid'", 0],
    ["UPDATE task_assignees SET membership_id=NULL,email='A@EXAMPLE.INVALID'", 1],
    ["UPDATE task_assignees SET email='former@example.invalid'", 1],
    [`UPDATE tasks SET due_at_ms=${MIDNIGHT_JST}`, 0],
    [`UPDATE tasks SET due_at_ms=${TEN_JST}`, 0],
    ['UPDATE tasks SET due_at_ms=NULL', 0],
    ["UPDATE tasks SET due_at_ms='invalid'", 0],
    ...['completed', ' COMPLETED ', '完了', 'canceled', 'cancelled', ' CANCELED ', 'キャンセル'].map(status => [`UPDATE tasks SET status='${status}'`, 0]),
    ["UPDATE tasks SET status='in_progress'", 1],
  ];
  for (const [change, queued] of cases) {
    const f = await fixture(t); f.db.exec(change);
    assert.deepEqual(await f.run(), { queued }, change);
  }
});

test('全体設定だけを使い、フォルダ設定・通常タスク通知OFF・重複担当・複数端末に左右されない', async t => {
  const f = await fixture(t);
  f.db.exec(`INSERT INTO folders(id,org_id,name,is_active,is_public,created_at_ms,updated_at_ms) VALUES('private','org-a','限定',0,0,1,1);
    UPDATE tasks SET folder_id='private';
    INSERT INTO push_folder_preferences(org_id,user_id,folder_id,message_created,comment_created,task_assigned,task_updated) VALUES('org-a','a','private',0,0,0,0);
    INSERT INTO task_assignees(task_id,email,membership_id,assigned_at_ms) VALUES('task-a','alias@example.invalid','m-a',1);
    INSERT INTO push_subscriptions SELECT 'second-device',org_id,user_id,'https://web.push.apple.com/second-fixture',p256dh,auth,session_fingerprint,session_expires_at_ms,created_at_ms,updated_at_ms FROM push_subscriptions;`);
  assert.deepEqual(await f.run(), { queued: 1 });
});

test('所属・利用者・権限・購読とセッションの有効性を確認する', async t => {
  const cases = [
    ["UPDATE users SET is_active=0", 0], ["UPDATE users SET status='suspended'", 0],
    ["UPDATE memberships SET status='inactive'", 0], ["UPDATE memberships SET role='guest'", 0],
    ["UPDATE memberships SET org_id='org-b'", 0], ['DELETE FROM push_subscriptions', 0],
    ["UPDATE push_subscriptions SET org_id='org-b'", 0],
    [`UPDATE push_subscriptions SET session_expires_at_ms=${TEN_JST}`, 0],
    [`UPDATE push_subscriptions SET session_expires_at_ms=${TEN_JST + 1}`, 1],
    [`INSERT INTO session_revocations(session_fingerprint,expires_at_ms,revoked_at_ms) VALUES('${fingerprint('a')}',${TEN_JST + DAY},1)`, 0],
    ["UPDATE memberships SET role='manager'", 1], ["UPDATE memberships SET role='admin'", 1],
    ["UPDATE memberships SET role='administrator'", 1],
    ["UPDATE users SET status=' ACTIVE '; UPDATE memberships SET status=' ACTIVE ',role=' MEMBER '", 1],
    ["UPDATE users SET status=''", 1],
  ];
  for (const [change, queued] of cases) {
    const f = await fixture(t); f.db.exec(change);
    assert.deepEqual(await f.run(), { queued }, change);
  }
});

test('リマインダーOFF・有効化時刻なし・通知サービス停止ではイベントを作らない', async t => {
  for (const change of ['UPDATE push_preferences SET task_overdue_reminder=0',
    'UPDATE push_preferences SET task_reminder_enabled_at_ms=NULL', 'DELETE FROM push_preferences']) {
    const f = await fixture(t); f.db.exec(change);
    assert.deepEqual(await f.run(), { queued: 0 }, change);
  }
  const f = await fixture(t); f.env.WEB_PUSH_ENABLED = 'false';
  assert.deepEqual(await f.run(), { queued: 0 });
});

test('別組織・別担当者は各自のイベントだけを作り、元の利用者へ混ぜない', async t => {
  const f = await fixture(t); await f.target('b', 'org-b');
  f.db.exec(`INSERT INTO memberships(membership_id,org_id,user_id,role,status,created_at_ms) VALUES('m-a-other','org-b','a','member','active',1);
    INSERT INTO push_preferences(org_id,user_id,task_overdue_reminder,task_reminder_enabled_at_ms,updated_at_ms) SELECT 'org-b','a',1,task_reminder_enabled_at_ms,1 FROM push_preferences WHERE org_id='org-a' AND user_id='a';
    INSERT INTO push_subscriptions SELECT 'a-other-org','org-b',user_id,'https://web.push.apple.com/a-other-org',p256dh,auth,session_fingerprint,session_expires_at_ms,created_at_ms,updated_at_ms FROM push_subscriptions WHERE subscription_id='s-a';`);
  await f.task('task-a-other', { org: 'org-b' });
  assert.deepEqual(await f.run(), { queued: 3 });
  assert.deepEqual(f.db.all('SELECT org_id,actor_user_id,recipient_user_ids FROM push_events ORDER BY org_id,actor_user_id').map(row => ({ ...row })),
    [{ org_id: 'org-a', actor_user_id: 'a', recipient_user_ids: '["a"]' },
      { org_id: 'org-b', actor_user_id: 'a', recipient_user_ids: '["a"]' },
      { org_id: 'org-b', actor_user_id: 'b', recipient_user_ids: '["b"]' }]);
});

test('候補取得後のOFF・完了・購読失効をINSERT時に再確認する', async t => {
  for (const change of ['UPDATE push_preferences SET task_overdue_reminder=0', "UPDATE tasks SET status='completed'", 'DELETE FROM push_subscriptions']) {
    const f = await fixture(t); const batch = f.db.batch.bind(f.db);
    f.db.batch = statements => { f.db.exec(change); return batch(statements); };
    assert.deepEqual(await f.run(), { queued: 0 }, change);
    assert.equal(f.db.get('SELECT COUNT(*) AS count FROM push_events').count, 0);
  }
});

test('無効な時刻はDB処理へ進めず安全なcodeで拒否する', async t => {
  const f = await fixture(t);
  for (const now of [NaN, Infinity, '2026-11-13', 8640000000000001]) {
    await assert.rejects(f.run(now), error => error.code === 'task_reminders_invalid_time');
  }
});
