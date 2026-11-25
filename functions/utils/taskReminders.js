import { isPushConfigured, sha256 } from './webPush.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const JST_OFFSET_MS = 9 * HOUR_MS;

// 候補取得とINSERT時に同じ条件を使い、途中のOFF・完了・購読失効も確認する。
const ELIGIBLE_SQL = `FROM push_preferences p
  JOIN users u ON u.user_id=p.user_id
  JOIN memberships m ON m.org_id=p.org_id AND m.user_id=p.user_id
  WHERE p.task_overdue_reminder=1
    AND typeof(p.task_reminder_enabled_at_ms) IN ('integer','real') AND p.task_reminder_enabled_at_ms<=?3
    AND u.is_active=1 AND (u.status IS NULL OR u.status='' OR LOWER(TRIM(u.status))='active')
    AND LOWER(TRIM(m.status))='active' AND LOWER(TRIM(m.role)) IN ('admin','administrator','manager','member')
    AND EXISTS(SELECT 1 FROM push_subscriptions s WHERE s.org_id=p.org_id AND s.user_id=p.user_id
      AND s.session_expires_at_ms>?1
      AND NOT EXISTS(SELECT 1 FROM session_revocations r WHERE r.session_fingerprint=s.session_fingerprint))
    AND EXISTS(SELECT 1 FROM tasks t WHERE t.org_id=p.org_id
      AND typeof(t.due_at_ms) IN ('integer','real') AND t.due_at_ms<?2
      AND LOWER(TRIM(COALESCE(t.status,''))) NOT IN ('completed','canceled','cancelled','完了','キャンセル')
      AND EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.task_id
        AND (ta.membership_id=m.membership_id OR LOWER(COALESCE(ta.email,''))=LOWER(TRIM(u.email)))))
    AND NOT EXISTS(SELECT 1 FROM push_events e WHERE e.org_id=p.org_id AND e.actor_user_id=p.user_id AND e.reminder_day=?4)`;

export async function enqueueTaskReminders(env, { now = Date.now() } = {}) {
  if (!Number.isFinite(now) || Math.abs(now) > 8640000000000000 - JST_OFFSET_MS) {
    throw Object.assign(new Error('task_reminders_invalid_time'), { code: 'task_reminders_invalid_time' });
  }
  const todayJst = Math.floor((now + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
  const tenJst = todayJst + 10 * HOUR_MS;
  // 毎分cronのcatchupは10時台だけ。新しくONにした人は次の朝から対象になる。
  if (now < tenJst || now >= tenJst + HOUR_MS || !isPushConfigured(env)) return { queued: 0 };
  const db = typeof env.DB?.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB;
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw Object.assign(new Error('task_reminders_unavailable'), { code: 'task_reminders_unavailable' });
  }
  const day = new Date(now + JST_OFFSET_MS).toISOString().slice(0, 10);
  const candidates = await db.prepare(`SELECT DISTINCT p.org_id,p.user_id ${ELIGIBLE_SQL}
    ORDER BY p.org_id,p.user_id LIMIT 50`).bind(now, todayJst, tenJst, day).all();
  const rows = candidates.results || [];
  if (!rows.length) return { queued: 0 };
  const statements = await Promise.all(rows.map(async row => {
    const eventId = await sha256(JSON.stringify([row.org_id, row.user_id, day]));
    // 同日分は一度だけ保存する。batch失敗時はrollbackし次のcronで再試行する。
    return db.prepare(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,folder_id,
        recipient_user_ids,created_at_ms,expires_at_ms,reminder_day)
      SELECT DISTINCT ?7,p.org_id,p.user_id,'task_updated','',NULL,?9,?1,?8,?4 ${ELIGIBLE_SQL}
        AND p.org_id=?5 AND p.user_id=?6 ON CONFLICT DO NOTHING`)
      .bind(now, todayJst, tenJst, day, row.org_id, row.user_id, eventId, todayJst + DAY_MS, JSON.stringify([row.user_id]));
  }));
  const results = await db.batch(statements);
  return { queued: results.reduce((sum, result) => sum + Number(result.meta?.changes || 0), 0) };
}
