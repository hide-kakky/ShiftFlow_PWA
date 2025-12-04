-- QC checklist for ShiftFlow D1 data validation
-- 件数一致: Compare these counts with移行元 (例: GAS スプレッドシート)
SELECT 'users_total' AS metric, COUNT(*) AS value FROM users;
SELECT 'memberships_total', COUNT(*) FROM memberships;
SELECT 'messages_total', COUNT(*) FROM messages;
SELECT 'message_reads_total', COUNT(*) FROM message_reads;
SELECT 'tasks_total', COUNT(*) FROM tasks;
SELECT 'task_assignees_total', COUNT(*) FROM task_assignees;

-- 参照整合: 孤児検出
SELECT mr.message_read_id
FROM message_reads mr
LEFT JOIN messages m ON m.message_id = mr.message_id
WHERE m.message_id IS NULL;

SELECT mr.message_read_id
FROM message_reads mr
LEFT JOIN memberships mem ON mem.membership_id = mr.membership_id
WHERE mem.membership_id IS NULL;

SELECT m.message_id
FROM messages m
LEFT JOIN memberships mem ON mem.membership_id = m.author_membership_id
WHERE m.author_membership_id IS NOT NULL
  AND mem.membership_id IS NULL;

-- 重複検出: 期待件数と異なる場合は要調査
SELECT email, COUNT(*) AS duplicates
FROM users
GROUP BY email
HAVING COUNT(*) > 1;

SELECT org_id, user_id, COUNT(*) AS duplicates
FROM memberships
GROUP BY org_id, user_id
HAVING COUNT(*) > 1;

-- 既読のタイムスタンプがメッセージ作成前になっていないか確認
SELECT mr.message_read_id, mr.read_at_ms, m.created_at_ms
FROM message_reads mr
JOIN messages m ON m.message_id = mr.message_id
WHERE mr.read_at_ms < m.created_at_ms;

-- created_at が極端な未来/過去に飛んでいないか確認（30日超未来 or 1970未満）
SELECT message_id, created_at_ms
FROM messages
WHERE created_at_ms > (strftime('%s', 'now') + 86400 * 30) * 1000
   OR created_at_ms < 0;

-- ユーザーのメール形式が概ね正しいか簡易チェック
SELECT user_id, email
FROM users
WHERE email NOT LIKE '%@%.%';

-- タスク割当の孤児検出
SELECT ta.task_id, ta.email
FROM task_assignees ta
LEFT JOIN tasks t ON t.task_id = ta.task_id
WHERE t.task_id IS NULL;

SELECT ta.task_id, ta.email
FROM task_assignees ta
LEFT JOIN memberships mem ON mem.membership_id = ta.membership_id
WHERE ta.membership_id IS NOT NULL
  AND mem.membership_id IS NULL;
