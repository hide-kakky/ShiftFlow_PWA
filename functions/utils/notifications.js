import { isPushConfigured, validateSubscription, sha256, sendWebPush } from './webPush.js';
import { computeAppBadge } from './appBadge.js';

export const PUSH_KINDS = ['task_assigned', 'task_updated', 'message_created', 'comment_created'];
const FOLDER_PUSH_KINDS = ['message_created', 'comment_created'];
const DAY = 86400000;
function fail(code, status = 400, details = {}) { throw Object.assign(new Error(code), { code, httpStatus: status, ...details }); }
function scope(access) {
  if (!access?.orgId || !access?.userId || !['admin','manager','member'].includes(access.role)) fail('push_access_denied', 403);
  return [access.orgId, access.userId];
}
function boolean(value) { if (typeof value !== 'boolean') fail('invalid_notification_preferences'); return value ? 1 : 0; }
const defaults = () => Object.fromEntries(PUSH_KINDS.map(k => [k, true]));

async function testRetryAfterSeconds(db, orgId, userId, now = Date.now()) {
  const row = await db.prepare("SELECT MAX(created_at_ms) AS last_test_at_ms FROM push_events WHERE org_id=?1 AND actor_user_id=?2 AND kind='test'")
    .bind(orgId, userId).first();
  const latest = Number(row?.last_test_at_ms || 0);
  return Number.isFinite(latest) ? Math.max(0, Math.min(60, Math.ceil((latest + 60000 - now) / 1000))) : 0;
}

export async function handleNotificationApi({ db, env, access, route, method, body, query, session, folders, ensureFolderAccess }) {
  const [orgId, userId] = scope(access);
  if (typeof db.withSession === 'function') db = db.withSession('first-primary');
  if (method !== (route === 'getNotificationSettings' ? 'GET' : 'POST')) fail('method_not_allowed', 405);
  const ready = isPushConfigured(env);
  if (route === 'getNotificationSettings') {
    const owner = await sha256(orgId + ':' + userId);
    if (!ready) return { owner, serverReady: false, publicKey: '', version: '0', folders: [], deviceRegistered: false };
    const prefs = await db.prepare('SELECT * FROM push_preferences WHERE org_id=?1 AND user_id=?2').bind(orgId, userId).first();
    const saved = await db.prepare('SELECT * FROM push_folder_preferences WHERE org_id=?1 AND user_id=?2').bind(orgId, userId).all();
    const map = new Map((saved.results || []).map(row => [row.folder_id, row]));
    const legacyTasks = { task_assigned: prefs ? !!prefs.task_assigned : true, task_updated: prefs ? !!prefs.task_updated : true };
    const taskPreferences = { ...legacyTasks, task_overdue_reminder: !!prefs?.task_overdue_reminder };
    const subscriptionId = query.get('subscriptionId') || '';
    const device = /^[a-f0-9]{64}$/.test(subscriptionId) ? await db.prepare(`SELECT subscription_id FROM push_subscriptions
      WHERE subscription_id=?1 AND org_id=?2 AND user_id=?3 AND session_fingerprint=?4 AND session_expires_at_ms>?5`)
      .bind(subscriptionId, orgId, userId, session.fingerprint, Date.now()).first() : null;
    return { owner, serverReady: true, publicKey: env.VAPID_PUBLIC_KEY, version: prefs?.version || '0',
      taskPreferences, unfiledTasks: legacyTasks,
      // 旧画面にも全体設定を返し、保存済みのフォルダ別タスク値は使わない。
      folders: folders.map(folder => ({ id: folder.id, name: folder.name, ...legacyTasks,
        ...Object.fromEntries(FOLDER_PUSH_KINDS.map(k => [k, map.has(folder.id) ? !!map.get(folder.id)[k] : true])) })),
      deviceRegistered: !!device, testRetryAfterSeconds: await testRetryAfterSeconds(db, orgId, userId) };
  }
  if (!ready) fail('push_not_configured', 503);
  if (route === 'saveNotificationSettings') {
    if (!body || typeof body.version !== 'string' || !/^(0|[a-f0-9-]{36})$/.test(body.version) ||
      !Array.isArray(body.folders) || body.folders.length > 200) fail('invalid_notification_preferences');
    const seen = new Set();
    const rows = [];
    for (const row of body.folders) {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 128 || seen.has(row.id)) fail('invalid_notification_preferences');
      seen.add(row.id);
      if (!await ensureFolderAccess(row.id)) fail('notification_folder_access_denied', 403);
      rows.push({ id: row.id, values: FOLDER_PUSH_KINDS.map(k => boolean(row[k])) });
    }
    // 新形式があれば優先する。不正値を旧形式で補わず、旧画面だけaliasを受け付ける。
    const taskPreferences = Object.hasOwn(body, 'taskPreferences') ? body.taskPreferences : body.unfiledTasks;
    const taskAssigned = boolean(taskPreferences?.task_assigned);
    const taskUpdated = boolean(taskPreferences?.task_updated);
    const reminder = Object.hasOwn(taskPreferences, 'task_overdue_reminder') ? boolean(taskPreferences.task_overdue_reminder) : null;
    const version = crypto.randomUUID();
    const now = Date.now();
    const statements = [
      db.prepare('INSERT OR IGNORE INTO push_preferences(org_id,user_id,updated_at_ms) VALUES(?1,?2,?3)').bind(orgId,userId,now),
      db.prepare(`UPDATE push_preferences SET task_assigned=?3,task_updated=?4,version=?5,updated_at_ms=?6,
        task_overdue_reminder=COALESCE(?8,task_overdue_reminder),
        task_reminder_enabled_at_ms=CASE WHEN ?8 IS NULL THEN task_reminder_enabled_at_ms WHEN ?8=0 THEN NULL
          WHEN task_overdue_reminder=0 THEN ?6 ELSE COALESCE(task_reminder_enabled_at_ms,?6) END
        WHERE org_id=?1 AND user_id=?2 AND version=?7`)
        .bind(orgId,userId,taskAssigned,taskUpdated,version,now,body.version,reminder),
      ...rows.map(row => db.prepare(`INSERT INTO push_folder_preferences(org_id,user_id,folder_id,message_created,comment_created)
        SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM push_preferences WHERE org_id=?1 AND user_id=?2 AND version=?6)
        ON CONFLICT(org_id,user_id,folder_id) DO UPDATE SET message_created=excluded.message_created,comment_created=excluded.comment_created`)
        .bind(orgId,userId,row.id,row.values[0],row.values[1],version)),
    ];
    const results = await db.batch(statements);
    if (!results[1]?.meta?.changes) fail('notification_settings_conflict', 409);
    return { version };
  }
  if (route === 'registerPushSubscription') {
    let subscription;
    try { subscription = await validateSubscription(body?.subscription); } catch { fail('invalid_push_subscription'); }
    const existing = await db.prepare('SELECT org_id,user_id FROM push_subscriptions WHERE subscription_id=?1').bind(subscription.id).first();
    if (existing && (existing.org_id !== orgId || existing.user_id !== userId)) fail('push_subscription_conflict', 409);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE org_id=?1 AND user_id=?2').bind(orgId,userId).first();
    if (!existing && count.count >= 10) fail('push_device_limit', 429);
    const now = Date.now();
    await db.prepare(`INSERT INTO push_subscriptions(subscription_id,org_id,user_id,endpoint,p256dh,auth,session_fingerprint,session_expires_at_ms,created_at_ms,updated_at_ms)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)
      ON CONFLICT(subscription_id) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,session_fingerprint=excluded.session_fingerprint,
        session_expires_at_ms=excluded.session_expires_at_ms,updated_at_ms=excluded.updated_at_ms
      WHERE push_subscriptions.org_id=excluded.org_id AND push_subscriptions.user_id=excluded.user_id`)
      .bind(subscription.id,orgId,userId,subscription.endpoint,subscription.p256dh,subscription.auth,session.fingerprint,session.expiresAt,now).run();
    // 同時登録で他アカウントへ所有権を移さない。
    const owned = await db.prepare('SELECT subscription_id FROM push_subscriptions WHERE subscription_id=?1 AND org_id=?2 AND user_id=?3')
      .bind(subscription.id,orgId,userId).first();
    if (!owned) fail('push_subscription_conflict', 409);
    return { subscriptionId: subscription.id };
  }
  if (route === 'removePushSubscription' || route === 'testPushNotification') {
    if (!/^[a-f0-9]{64}$/.test(body?.subscriptionId || '')) fail('invalid_push_subscription');
    const owned = await db.prepare('SELECT subscription_id FROM push_subscriptions WHERE subscription_id=?1 AND org_id=?2 AND user_id=?3 AND session_fingerprint=?4')
      .bind(body.subscriptionId,orgId,userId,session.fingerprint).first();
    if (!owned) fail('push_subscription_not_found', 404);
    if (route === 'removePushSubscription') {
      await db.prepare('DELETE FROM push_subscriptions WHERE subscription_id=?1 AND org_id=?2 AND user_id=?3').bind(body.subscriptionId,orgId,userId).run();
      return { removed: true };
    }
    const now = Date.now();
    const result = await db.prepare(`INSERT INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,target_subscription_id,created_at_ms,expires_at_ms)
      SELECT ?1,?2,?3,'test','',?4,?5,?6 WHERE NOT EXISTS(
        SELECT 1 FROM push_events WHERE org_id=?2 AND actor_user_id=?3 AND kind='test' AND created_at_ms>?7)`)
      .bind(crypto.randomUUID(),orgId,userId,body.subscriptionId,now,now+3600000,now-60000).run();
    if (!result.meta?.changes) fail('push_test_rate_limited', 429, { retryAfterSeconds: await testRetryAfterSeconds(db, orgId, userId, now) || 60 });
    return { queued: true, retryAfterSeconds: 60 };
  }
  fail('unknown_notification_route', 404);
}

export async function buildPushEventStatement(db, options) {
  if (!options?.enabled) return null;
  const { orgId, actorUserId, kind, resourceId, folderId, requestId, auditAction, payloadSha256, generationMs } = options;
  if (!PUSH_KINDS.includes(kind) || !orgId || !actorUserId || !resourceId || !requestId || !payloadSha256 || !generationMs) throw new Error('push_event_scope_invalid');
  const id = await sha256(JSON.stringify([orgId,actorUserId,kind,resourceId,requestId,payloadSha256,generationMs]));
  const now = Date.now();
  // 既存auditが実際に保存された場合だけenqueueする。changes()の連鎖へ割り込まない。
  return db.prepare(`INSERT OR IGNORE INTO push_events(event_id,org_id,actor_user_id,kind,resource_id,folder_id,created_at_ms,expires_at_ms,recipient_user_ids,excluded_user_ids)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?13,?14 WHERE EXISTS(
      SELECT 1 FROM audit_logs a JOIN memberships m ON m.membership_id=a.actor_membership_id
      WHERE a.org_id=?2 AND m.user_id=?3 AND a.target_id=?5 AND a.request_id=?9 AND a.action=?10
        AND a.request_payload_sha256=?11 AND a.request_generation_ms=?12)`)
    .bind(id,orgId,actorUserId,kind,resourceId,folderId || null,now,now+DAY,requestId,auditAction,payloadSha256,generationMs,
      options.recipientUserIds ? JSON.stringify(options.recipientUserIds) : null, JSON.stringify(options.excludedUserIds || []));
}

export async function renewNotificationSession(db, access, session, now = Date.now()) {
  // 普段の認証済み利用に合わせて延長する。実際の書き込みは約1日おき。
  // logout済みsessionを復活させず、別session/別userへ購読を引き継がない。
  await db.prepare(`UPDATE push_subscriptions SET session_expires_at_ms=?3
    WHERE org_id=?1 AND user_id=?2 AND session_fingerprint=?4 AND session_expires_at_ms>?5 AND session_expires_at_ms<?6
      AND NOT EXISTS(SELECT 1 FROM session_revocations WHERE session_fingerprint=?4)`)
    .bind(access.orgId,access.userId,session.expiresAt,session.fingerprint,now,session.expiresAt-DAY).run();
}

function eligibleSql(kind) {
  if (![...PUSH_KINDS, 'test'].includes(kind)) throw new Error('invalid_push_kind');
  const todayJst = "(CAST(strftime('%s',?2/1000.0,'unixepoch','+9 hours','start of day','-9 hours') AS INTEGER)*1000)";
  const reminderPreference = `p.task_overdue_reminder=1 AND typeof(p.task_reminder_enabled_at_ms) IN ('integer','real')
    AND p.task_reminder_enabled_at_ms<=${todayJst}+36000000`;
  const preference = kind === 'test' ? '1=1' : kind.startsWith('task_')
    ? kind === 'task_updated'
      ? `((e.reminder_day IS NULL AND COALESCE(p.task_updated,1)=1) OR (e.reminder_day IS NOT NULL AND ${reminderPreference}))`
      : `COALESCE(p.${kind},1)=1`
    : `COALESCE(fp.${kind},1)=1`;
  const taskResource = `EXISTS(
    SELECT 1 FROM tasks t WHERE t.task_id=e.resource_id AND t.org_id=e.org_id AND COALESCE(t.folder_id,'')=COALESCE(e.folder_id,'')
      AND (${kind === 'task_updated' ? '(t.created_by_membership_id=m.membership_id OR lower(t.created_by_email)=lower(u.email)) OR' : ''}
        EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.task_id AND (ta.membership_id=m.membership_id OR lower(ta.email)=lower(u.email)))))`;
  const reminderResource = `e.actor_user_id=u.user_id AND e.folder_id IS NULL AND e.resource_id=''
    AND e.reminder_day=date(?2/1000.0,'unixepoch','+9 hours') AND ?2>=${todayJst}+36000000
    AND EXISTS(SELECT 1 FROM tasks t WHERE t.org_id=e.org_id
      AND typeof(t.due_at_ms) IN ('integer','real') AND t.due_at_ms<${todayJst}
      AND LOWER(TRIM(COALESCE(t.status,''))) NOT IN ('completed','canceled','cancelled','完了','キャンセル')
      AND EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.task_id
        AND (ta.membership_id=m.membership_id OR LOWER(COALESCE(ta.email,''))=LOWER(TRIM(u.email)))))`;
  const resource = kind === 'test' ? 's.subscription_id=e.target_subscription_id' : kind.startsWith('task_')
    ? kind === 'task_updated'
      ? `((e.reminder_day IS NULL AND ${taskResource}) OR (e.reminder_day IS NOT NULL AND ${reminderResource}))`
      : taskResource :
    `EXISTS(SELECT 1 FROM messages msg WHERE msg.message_id=e.resource_id AND msg.org_id=e.org_id AND COALESCE(msg.folder_id,'')=COALESCE(e.folder_id,''))`;
  return `SELECT s.*,m.membership_id,u.email,
      CASE WHEN LOWER(TRIM(m.role)) IN ('admin','administrator','manager') THEN 1 ELSE 0 END AS is_manager
    FROM push_events e JOIN push_subscriptions s ON s.org_id=e.org_id
    JOIN users u ON u.user_id=s.user_id JOIN memberships m ON m.user_id=u.user_id AND m.org_id=e.org_id
    LEFT JOIN push_preferences p ON p.org_id=e.org_id AND p.user_id=u.user_id
    LEFT JOIN push_folder_preferences fp ON fp.org_id=e.org_id AND fp.user_id=u.user_id AND fp.folder_id=e.folder_id
    WHERE e.event_id=?1 AND e.expires_at_ms>?2 AND s.session_expires_at_ms>?2
      AND NOT EXISTS(SELECT 1 FROM session_revocations revoked WHERE revoked.session_fingerprint=s.session_fingerprint)
      AND u.is_active=1 AND (u.status IS NULL OR u.status='' OR LOWER(TRIM(u.status))='active')
      AND LOWER(TRIM(m.status))='active' AND LOWER(TRIM(m.role)) IN ('admin','administrator','manager','member')
      AND (e.reminder_day IS NULL OR e.kind='task_updated')
      AND ${kind === 'test' ? '1=1' : `((e.reminder_day IS NULL AND u.user_id<>e.actor_user_id)
        OR (e.reminder_day IS NOT NULL AND e.kind='task_updated' AND u.user_id=e.actor_user_id)) AND s.created_at_ms<=e.created_at_ms`}
      AND (e.recipient_user_ids IS NULL OR EXISTS(SELECT 1 FROM json_each(e.recipient_user_ids) WHERE value=u.user_id))
      AND NOT EXISTS(SELECT 1 FROM json_each(e.excluded_user_ids) WHERE value=u.user_id)
      AND ${preference} AND ${resource}
      AND (e.folder_id IS NULL OR EXISTS(SELECT 1 FROM folders f WHERE f.id=e.folder_id AND f.org_id=e.org_id AND f.is_active=1
        AND (f.is_public=1 OR LOWER(TRIM(m.role)) IN ('admin','administrator','manager') OR EXISTS(SELECT 1 FROM folder_members fm WHERE fm.folder_id=f.id AND fm.user_id=u.user_id))))`;
}
export function notificationPayload(event) {
  const labels = { task_assigned: 'タスクが届きました', task_updated: 'タスクが更新されました', message_created: '新しいメッセージがあります', comment_created: '新しいコメントがあります', test: 'テスト通知です' };
  const view = event.kind.startsWith('task_') ? 'tasks' : event.kind === 'test' ? 'settings' : 'messages';
  const params = new URLSearchParams({ view });
  const reminder = event.kind === 'task_updated' && event.reminder_day != null;
  if (event.resource_id && !reminder) params.set(view === 'tasks' ? 'task' : 'message', event.resource_id);
  return { title: 'ShiftFlow', body: reminder ? '期限を過ぎた未完了タスクがあります' : labels[event.kind] || '新しいお知らせがあります', tag: `shiftflow-${event.event_id}`,
    url: `/?${params}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' };
}
export async function drainNotifications(env, options = {}) {
  if (!isPushConfigured(env)) return { sent: 0 };
  const db = typeof env.DB.withSession === 'function' ? env.DB.withSession('first-primary') : env.DB;
  const now = options.now ?? Date.now();
  const events = await db.prepare('SELECT * FROM push_events WHERE expanded=0 AND expires_at_ms>?1 ORDER BY created_at_ms LIMIT 2').bind(now).all();
  for (const event of events.results || []) {
    const candidates = await db.prepare(eligibleSql(event.kind) + ' AND s.subscription_id>?3 ORDER BY s.subscription_id LIMIT 20')
      .bind(event.event_id,now,event.expansion_cursor).all();
    const rows = candidates.results || [];
    await db.batch([
      ...rows.map(row => db.prepare('INSERT OR IGNORE INTO push_deliveries(event_id,subscription_id,next_attempt_at_ms) VALUES(?1,?2,?3)').bind(event.event_id,row.subscription_id,now)),
      db.prepare('UPDATE push_events SET expansion_cursor=?2,expanded=?3 WHERE event_id=?1 AND expansion_cursor=?4')
        .bind(event.event_id,rows.at(-1)?.subscription_id || event.expansion_cursor,rows.length < 20 ? 1 : 0,event.expansion_cursor),
    ]);
  }
  const pending = await db.prepare(`SELECT d.*,e.kind FROM push_deliveries d JOIN push_events e ON e.event_id=d.event_id
    WHERE e.expires_at_ms>?1 AND d.attempts<4 AND ((d.status='pending' AND d.next_attempt_at_ms<=?1) OR (d.status='sending' AND d.lease_until_ms<=?1))
    ORDER BY d.next_attempt_at_ms LIMIT 5`).bind(now).all();
  let sent = 0;
  for (const delivery of pending.results || []) {
    const lease = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE push_deliveries SET status='sending',lease_token=?3,lease_until_ms=?4,attempts=attempts+1
      WHERE event_id=?1 AND subscription_id=?2 AND attempts<4 AND ((status='pending' AND next_attempt_at_ms<=?5) OR (status='sending' AND lease_until_ms<=?5))`)
      .bind(delivery.event_id,delivery.subscription_id,lease,now+60000,now).run();
    if (!claimed.meta?.changes) continue;
    const subscription = await db.prepare(eligibleSql(delivery.kind) + ' AND s.subscription_id=?3')
      .bind(delivery.event_id,options.now ?? Date.now(),delivery.subscription_id).first();
    let status = 'skipped', code = 'no_longer_eligible', next = now;
    if (subscription) {
      let stage = 'badge';
      try {
        const event = await db.prepare('SELECT * FROM push_events WHERE event_id=?1').bind(delivery.event_id).first();
        const counts = await computeAppBadge(db, { orgId: subscription.org_id, userId: subscription.user_id,
          membershipId: subscription.membership_id, email: subscription.email, isManager: subscription.is_manager === 1,
          now: options.now ?? Date.now() });
        if (![counts.messageUnread, counts.taskOverdue, counts.total].every(value => Number.isSafeInteger(value) && value >= 0)
          || counts.total !== counts.messageUnread + counts.taskOverdue) throw new Error('app_badge_invalid_counts');
        // 件数計算中に設定や所属が変わっていないかも送信直前に再確認する。
        const current = await db.prepare(eligibleSql(delivery.kind) + ' AND s.subscription_id=?3')
          .bind(delivery.event_id,options.now ?? Date.now(),delivery.subscription_id).first();
        if (current && current.membership_id === subscription.membership_id && current.email === subscription.email
          && current.is_manager === subscription.is_manager && !(event.reminder_day != null && counts.taskOverdue === 0)) {
          const appBadge = { ...counts, owner: await sha256(current.org_id + ':' + current.user_id), sessionExpiresAt: current.session_expires_at_ms };
          stage = 'transport';
          const response = await sendWebPush(current,{ ...notificationPayload(event), appBadge },env,options);
          code = `http_${response}`;
          if (response >= 200 && response < 300) { status = 'sent'; sent++; }
          else if (response === 404 || response === 410) {
            await db.prepare('DELETE FROM push_subscriptions WHERE subscription_id=?1 AND updated_at_ms=?2').bind(current.subscription_id,current.updated_at_ms).run();
          } else if (response === 429 || response >= 500) status = 'pending';
          else status = 'failed';
        }
      } catch (error) {
        status = error?.code === 'app_badge_access_denied' ? 'skipped' : 'pending';
        code = status === 'skipped' ? 'no_longer_eligible' : stage === 'badge' ? 'badge_unavailable' : 'transport_unavailable';
      }
      if (status === 'pending') {
        status = delivery.attempts >= 3 ? 'failed' : 'pending';
        next = now + Math.min(15 * 60000,60000 * (2 ** delivery.attempts));
      }
    }
    await db.prepare(`UPDATE push_deliveries SET status=?4,result_code=?5,next_attempt_at_ms=?6,lease_token=NULL,lease_until_ms=NULL
      WHERE event_id=?1 AND subscription_id=?2 AND lease_token=?3`).bind(delivery.event_id,delivery.subscription_id,lease,status,code,next).run();
  }
  // 即時配信では期限切れデータを探さない。毎分の定期処理に回収を任せる。
  if (options.maintenance !== false) {
    await db.prepare('DELETE FROM push_events WHERE event_id IN (SELECT event_id FROM push_events WHERE expires_at_ms<?1 LIMIT 50)').bind(now-DAY).run();
    await db.prepare('DELETE FROM push_subscriptions WHERE subscription_id IN (SELECT subscription_id FROM push_subscriptions WHERE session_expires_at_ms<?1 LIMIT 50)').bind(now).run();
  }
  return { sent };
}
