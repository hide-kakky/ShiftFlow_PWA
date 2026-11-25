const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function failure(code, httpStatus) {
  return Object.assign(new Error(code), { code, httpStatus });
}

// 件数取得にも本人・組織・所属を要求する。通知の購読やON/OFFは参照しない。
export async function computeAppBadge(db, options = {}) {
  if (!db || typeof db.prepare !== 'function') throw failure('app_badge_unavailable', 503);
  const orgId = typeof options?.orgId === 'string' ? options.orgId.trim() : '';
  const userId = typeof options?.userId === 'string' ? options.userId.trim() : '';
  const membershipId = typeof options?.membershipId === 'string' ? options.membershipId.trim() : '';
  const email = typeof options?.email === 'string' ? options.email.trim().toLowerCase() : '';
  if (!orgId || !userId || !membershipId || !email) throw failure('app_badge_access_denied', 403);
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isFinite(now) || Math.abs(now) > 8640000000000000) throw failure('app_badge_invalid_time', 400);
  // 日付だけの期限はJST当日0時と比較し、今日の期限は超過に含めない。
  const todayJst = Math.floor((now + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  const primary = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
  const row = await primary.prepare(`
    WITH viewer AS (
      SELECT ms.org_id, ms.membership_id, u.user_id, LOWER(TRIM(u.email)) AS email,
             CASE WHEN ?5=1 AND LOWER(TRIM(ms.role)) IN ('admin','administrator','manager') THEN 1 ELSE 0 END AS is_manager
        FROM memberships ms
        JOIN users u ON u.user_id=ms.user_id
       WHERE ms.org_id=?1 AND u.user_id=?2 AND ms.membership_id=?3
         AND LOWER(TRIM(u.email))=?4
         AND u.is_active=1
         AND (u.status IS NULL OR u.status='' OR LOWER(TRIM(u.status))='active')
         AND LOWER(TRIM(ms.status))='active'
         AND LOWER(TRIM(ms.role)) IN ('admin','administrator','manager','member')
    )
    SELECT (
      SELECT COUNT(*)
        FROM messages m
        JOIN folders f ON f.id=m.folder_id AND f.org_id=m.org_id
        LEFT JOIN message_reads mr ON mr.message_id=m.message_id AND mr.membership_id=v.membership_id
       WHERE m.org_id=v.org_id AND f.is_active=1
         AND (f.is_public=1 OR v.is_manager=1 OR EXISTS (
           SELECT 1 FROM folder_members fm WHERE fm.folder_id=f.id AND fm.user_id=v.user_id
         ))
         AND CASE
           WHEN mr.message_id IS NULL THEN 1
           WHEN (CASE WHEN typeof(mr.read_at_ms) IN ('integer','real') THEN mr.read_at_ms ELSE 0 END)=0 THEN EXISTS (
             SELECT 1 FROM message_comments c
              WHERE c.org_id=m.org_id AND c.message_id=m.message_id
           )
           ELSE EXISTS (
             SELECT 1 FROM message_comments c
              WHERE c.org_id=m.org_id AND c.message_id=m.message_id
                AND c.created_at_ms>mr.read_at_ms
                AND typeof(c.created_at_ms) IN ('integer','real')
           )
         END
    ) AS message_unread, (
      SELECT COUNT(*)
        FROM tasks t
       WHERE t.org_id=v.org_id
         AND typeof(t.due_at_ms) IN ('integer','real') AND t.due_at_ms<?6
         AND LOWER(TRIM(COALESCE(t.status,''))) NOT IN ('completed','canceled','cancelled','完了','キャンセル')
         AND EXISTS (
           SELECT 1 FROM task_assignees ta
            WHERE ta.task_id=t.task_id
              AND (ta.membership_id=v.membership_id OR LOWER(COALESCE(ta.email,''))=v.email)
         )
    ) AS task_overdue
      FROM viewer v
     LIMIT 1
  `).bind(orgId, userId, membershipId, email, options.isManager === true ? 1 : 0, todayJst).first();
  if (!row) throw failure('app_badge_access_denied', 403);
  const messageUnread = Number(row.message_unread);
  const taskOverdue = Number(row.task_overdue);
  return { messageUnread, taskOverdue, total: messageUnread + taskOverdue, computedAt: now };
}
