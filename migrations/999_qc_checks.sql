-- QC checklist for ShiftFlow D1 data validation
-- metrics: 以下は件数の観測値。0件を成功条件にせず、直前値・期待値と比較する。
SELECT 'users_total' AS metric, COUNT(*) AS value FROM users;
SELECT 'memberships_total', COUNT(*) FROM memberships;
SELECT 'messages_total', COUNT(*) FROM messages;
SELECT 'message_reads_total', COUNT(*) FROM message_reads;
SELECT 'message_comments_total', COUNT(*) FROM message_comments;
SELECT 'message_pins_total', COUNT(*) FROM message_pins;
SELECT 'tasks_total', COUNT(*) FROM tasks;
SELECT 'task_assignees_total', COUNT(*) FROM task_assignees;
SELECT 'auth_events_total', COUNT(*) FROM auth_events;
SELECT 'api_diagnostics_total', COUNT(*) FROM auth_proxy_logs
WHERE source = 'cf-api' AND level IN ('warn', 'error');
SELECT 'legacy_login_attempt_rows_pending_review', COUNT(*) FROM auth_proxy_logs
WHERE event = 'login_attempt';
SELECT 'legacy_login_attempt_rows_paired', COUNT(*) FROM auth_proxy_logs proxy
WHERE proxy.event = 'login_attempt'
  AND proxy.request_id IS NOT NULL
  AND proxy.request_id <> ''
  AND proxy.request_id IN (
    SELECT paired_login.request_id
      FROM login_audits paired_login
     WHERE paired_login.request_id IS NOT NULL
       AND paired_login.request_id <> ''
  );
SELECT 'legacy_login_attempt_rows_unpaired', COUNT(*) FROM auth_proxy_logs proxy
WHERE proxy.event = 'login_attempt'
  AND (
    proxy.request_id IS NULL
    OR proxy.request_id = ''
    OR proxy.request_id NOT IN (
      SELECT paired_login.request_id
        FROM login_audits paired_login
       WHERE paired_login.request_id IS NOT NULL
         AND paired_login.request_id <> ''
    )
  );
SELECT 'storage_cleanup_pending', COUNT(*) FROM storage_cleanup_jobs;
SELECT 'staged_attachments_total', COUNT(*) FROM staged_attachments;
SELECT 'staged_attachments_active_pending', COUNT(*) FROM staged_attachments
WHERE status IN ('uploading', 'ready')
  AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000;
SELECT 'staged_attachments_expired_unclaimed', COUNT(*) FROM staged_attachments
WHERE status <> 'claimed'
  AND expires_at_ms <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
SELECT 'api_idempotency_keys_total', COUNT(*) FROM api_idempotency_keys;
SELECT 'api_idempotency_keys_expired', COUNT(*) FROM api_idempotency_keys
WHERE expires_at_ms <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;
SELECT 'users_settings_versioned', COUNT(*) FROM users
WHERE settings_version <> '0';
SELECT 'session_revocations_active', COUNT(*) FROM session_revocations
WHERE expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000;
SELECT 'session_revocations_expired_pending_prune', COUNT(*) FROM session_revocations
WHERE expires_at_ms <= CAST(strftime('%s', 'now') AS INTEGER) * 1000;

-- anomalies: ここから下のSELECTは原則0行を成功条件とする。

-- 参照整合: 孤児検出
SELECT mr.message_read_id
FROM message_reads mr
LEFT JOIN messages m ON m.message_id = mr.message_id
WHERE m.message_id IS NULL;

SELECT mr.message_read_id
FROM message_reads mr
LEFT JOIN memberships mem ON mem.membership_id = mr.membership_id
WHERE mem.membership_id IS NULL;

SELECT mc.comment_id
FROM message_comments mc
LEFT JOIN messages m ON m.message_id = mc.message_id
WHERE m.message_id IS NULL;

SELECT mc.comment_id
FROM message_comments mc
LEFT JOIN memberships mem ON mem.membership_id = mc.membership_id
WHERE mc.membership_id IS NOT NULL
  AND mem.membership_id IS NULL;

SELECT mp.message_id, mp.membership_id
FROM message_pins mp
LEFT JOIN messages m ON m.message_id = mp.message_id
WHERE m.message_id IS NULL;

SELECT mp.message_id, mp.membership_id
FROM message_pins mp
LEFT JOIN memberships mem ON mem.membership_id = mp.membership_id
WHERE mem.membership_id IS NULL;

SELECT mp.message_id, mp.membership_id
FROM message_pins mp
JOIN messages m ON m.message_id = mp.message_id
JOIN memberships mem ON mem.membership_id = mp.membership_id
WHERE mp.org_id <> m.org_id
   OR mp.org_id <> mem.org_id;

SELECT m.message_id
FROM messages m
LEFT JOIN memberships mem ON mem.membership_id = m.author_membership_id
WHERE m.author_membership_id IS NOT NULL
  AND mem.membership_id IS NULL;

-- 添付の関連先と添付本体は同じtenantに属する必要がある。
SELECT ta.task_id, ta.attachment_id, t.org_id AS task_org_id, a.org_id AS attachment_org_id
FROM task_attachments ta
JOIN tasks t ON t.task_id = ta.task_id
JOIN attachments a ON a.attachment_id = ta.attachment_id
WHERE t.org_id <> a.org_id;

SELECT ma.message_id,
       ma.attachment_id,
       m.org_id AS message_org_id,
       a.org_id AS attachment_org_id
FROM message_attachments ma
JOIN messages m ON m.message_id = ma.message_id
JOIN attachments a ON a.attachment_id = ma.attachment_id
WHERE m.org_id <> a.org_id;

-- staged attachmentのowner scope、R2 prefix、同世代一意性、active quotaを確認する。
SELECT staged.staged_attachment_id,
       staged.org_id,
       staged.owner_user_id,
       staged.owner_membership_id
FROM staged_attachments staged
LEFT JOIN memberships owner_scope
  ON owner_scope.membership_id = staged.owner_membership_id
 AND owner_scope.org_id = staged.org_id
 AND owner_scope.user_id = staged.owner_user_id
WHERE owner_scope.membership_id IS NULL;

SELECT staged_attachment_id, org_id, r2_key
FROM staged_attachments
WHERE r2_key NOT LIKE 'orgs/' || org_id || '/%'
   OR (purpose = 'message' AND r2_key NOT LIKE 'orgs/' || org_id || '/messages/%')
   OR (purpose = 'profile' AND r2_key NOT LIKE 'orgs/' || org_id || '/profiles/%');

SELECT org_id,
       owner_user_id,
       request_id,
       request_payload_sha256,
       request_generation_ms,
       COUNT(*) AS duplicates
FROM staged_attachments
GROUP BY org_id,
         owner_user_id,
         request_id,
         request_payload_sha256,
         request_generation_ms
HAVING COUNT(*) > 1;

SELECT org_id,
       owner_user_id,
       purpose,
       COUNT(*) AS pending_count,
       SUM(size_bytes) AS pending_size_bytes
FROM staged_attachments
WHERE status IN ('uploading', 'ready')
  AND expires_at_ms > CAST(strftime('%s', 'now') AS INTEGER) * 1000
GROUP BY org_id, owner_user_id, purpose
HAVING (purpose = 'profile' AND COUNT(*) > 1)
    OR (purpose = 'message' AND (COUNT(*) > 5 OR SUM(size_bytes) > 52428800));

SELECT staged.staged_attachment_id, staged.status, staged.r2_key
FROM staged_attachments staged
LEFT JOIN storage_cleanup_jobs cleanup
  ON cleanup.r2_key = staged.r2_key
WHERE staged.status IN ('uploading', 'ready')
  AND cleanup.job_id IS NULL;

SELECT staged_attachment_id, purpose, status, claimed_target_type
FROM staged_attachments
WHERE (status = 'claimed' AND NOT (
         (purpose = 'message' AND claimed_target_type = 'message')
         OR (purpose = 'profile' AND claimed_target_type = 'user_settings')
       ))
   OR (status <> 'claimed' AND (
         claimed_target_type IS NOT NULL
         OR claimed_target_id IS NOT NULL
         OR claimed_at_ms IS NOT NULL
       ));

-- 重複検出: 期待件数と異なる場合は要調査
SELECT email, COUNT(*) AS duplicates
FROM users
GROUP BY email
HAVING COUNT(*) > 1;

SELECT org_id, user_id, COUNT(*) AS duplicates
FROM memberships
GROUP BY org_id, user_id
HAVING COUNT(*) > 1;

SELECT org_id,
       COALESCE(actor_membership_id, '') AS actor_membership_id,
       request_id,
       action,
       COALESCE(target_id, '') AS target_id,
       COALESCE(request_payload_sha256, '') AS request_payload_sha256,
       COALESCE(request_generation_ms, 0) AS request_generation_ms,
       COUNT(*) AS duplicates
FROM audit_logs
WHERE request_id IS NOT NULL
  AND request_id <> ''
GROUP BY org_id,
         COALESCE(actor_membership_id, ''),
         request_id,
         action,
         COALESCE(target_id, ''),
         COALESCE(request_payload_sha256, ''),
         COALESCE(request_generation_ms, 0)
HAVING COUNT(*) > 1;

SELECT audit_id, request_payload_sha256
FROM audit_logs
WHERE request_payload_sha256 IS NOT NULL
  AND (
    LENGTH(request_payload_sha256) <> 64
    OR request_payload_sha256 GLOB '*[^0-9a-f]*'
  );

SELECT audit_id, request_generation_ms
FROM audit_logs
WHERE request_generation_ms IS NOT NULL
  AND request_generation_ms <= 0;

SELECT org_id, actor_user_id, request_id, route, COUNT(*) AS duplicates
FROM api_idempotency_keys
GROUP BY org_id, actor_user_id, request_id, route
HAVING COUNT(*) > 1;

SELECT aik.idempotency_key_id, aik.org_id, aik.actor_user_id
FROM api_idempotency_keys aik
LEFT JOIN memberships mem
  ON mem.org_id = aik.org_id
 AND mem.user_id = aik.actor_user_id
WHERE mem.membership_id IS NULL;

SELECT idempotency_key_id, payload_sha256
FROM api_idempotency_keys
WHERE LENGTH(payload_sha256) <> 64
   OR payload_sha256 GLOB '*[^0-9a-f]*';

SELECT idempotency_key_id, created_at_ms, expires_at_ms
FROM api_idempotency_keys
WHERE expires_at_ms IS NULL
   OR expires_at_ms <> created_at_ms + 604800000;

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

-- 設定versionはmigration初期値かserver発行の32桁hexだけを許可する。
SELECT user_id, settings_version
FROM users
WHERE settings_version <> '0'
  AND (
    LENGTH(settings_version) <> 32
    OR settings_version GLOB '*[^0-9a-f]*'
  );

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

-- task.folder_idは同一tenantのfolderだけを参照する。
SELECT t.task_id, t.org_id AS task_org_id, t.folder_id, f.org_id AS folder_org_id
FROM tasks t
LEFT JOIN folders f ON f.id = t.folder_id
WHERE t.folder_id IS NOT NULL
  AND (f.id IS NULL OR f.org_id <> t.org_id);

-- v2認証イベントの意味・tenant snapshot検証
SELECT event_id, event_type, outcome
FROM auth_events
WHERE event_type NOT IN (
        'authentication.succeeded',
        'authentication.failed',
        'session.logged_out',
        'session.expired',
        'authorization.denied',
        'authorization.role_denied'
      )
   OR outcome IS NULL
   OR TRIM(outcome) = '';

SELECT event_id, event_type
FROM auth_events
WHERE (
        event_type = 'authentication.failed'
        AND (
          session_fingerprint IS NOT NULL
          OR request_id IS NULL
          OR TRIM(request_id) = ''
        )
      )
   OR (
        event_type <> 'authentication.failed'
        AND (
          session_fingerprint IS NULL
          OR TRIM(session_fingerprint) = ''
        )
      );

-- Google subjectはusers.auth_subjectを正本とし、監査スナップショットへ複製しない。
SELECT event_id, event_type, user_sub
FROM auth_events
WHERE user_sub IS NOT NULL;

-- メールアドレスはusersを正本として表示時にjoinし、認証イベントへ複製しない。
SELECT event_id, event_type, user_email
FROM auth_events
WHERE user_email IS NOT NULL;

SELECT ae.event_id, ae.org_id, ae.user_id
FROM auth_events ae
LEFT JOIN memberships mem
  ON mem.org_id = ae.org_id
 AND mem.user_id = ae.user_id
WHERE ae.org_id IS NOT NULL
  AND ae.user_id IS NOT NULL
  AND mem.membership_id IS NULL;

-- OAuth callback claimにraw stateや不正なfingerprintを残さない。
SELECT state_fingerprint, claimed_at_ms, expires_at_ms
FROM oauth_callback_claims
WHERE LENGTH(state_fingerprint) <> 64
   OR state_fingerprint GLOB '*[^0-9a-f]*'
   OR expires_at_ms <= claimed_at_ms;

-- session ID/key/PIIを保存せず、期限付きSHA-256 fingerprintだけを許可する。
SELECT session_fingerprint, revoked_at_ms, expires_at_ms
FROM session_revocations
WHERE LENGTH(session_fingerprint) <> 64
   OR session_fingerprint GLOB '*[^0-9a-f]*'
   OR expires_at_ms <= revoked_at_ms;

-- v2以降の所属済みAPI診断はorg/userを一組で持つ。未所属拒否は両方NULLを許容する。
SELECT log_id, event, request_id
FROM auth_proxy_logs
WHERE source = 'cf-api'
  AND level IN ('warn', 'error')
  AND (
    (org_id IS NULL AND user_id IS NOT NULL)
    OR (org_id IS NOT NULL AND user_id IS NULL)
  );

-- R2 object keyはattachment/jobのtenant prefixと一致しなければならない。
SELECT attachment_id, org_id
FROM attachments
WHERE JSON_VALID(COALESCE(extra_json, '')) <> 1
   OR JSON_TYPE(extra_json, '$.r2Key') <> 'text'
   OR JSON_EXTRACT(extra_json, '$.r2Key') NOT LIKE 'orgs/' || org_id || '/%';

SELECT job_id, org_id
FROM storage_cleanup_jobs
WHERE org_id IS NULL
   OR r2_key NOT LIKE 'orgs/' || org_id || '/%'
   OR (lease_token IS NULL AND lease_expires_at_ms IS NOT NULL)
   OR (lease_token IS NOT NULL AND lease_expires_at_ms IS NULL);

-- v1誤分類行はloginとして残さず、PIIを空化したquarantineだけを許可する。
SELECT login_id, request_id
FROM login_audits
WHERE reason = 'legacy_api_request_misclassified'
  AND (
    org_id IS NOT NULL
    OR user_email IS NOT NULL
    OR user_sub IS NOT NULL
    OR token_iat_ms IS NOT NULL
    OR client_ip IS NOT NULL
    OR user_agent IS NOT NULL
    OR role IS NOT NULL
  );

SELECT log_id, request_id
FROM auth_proxy_logs
WHERE event = 'legacy_api_request_misclassified'
  AND (
    email IS NOT NULL
    OR client_ip IS NOT NULL
    OR user_agent IS NOT NULL
    OR cf_ray IS NOT NULL
    OR org_id IS NOT NULL
    OR user_id IS NOT NULL
    OR source <> 'legacy_v1_quarantine'
  );

-- 旧login_attempt残数は先頭のpending_review / paired / unpaired metricsで観測する。
-- 015はpreflightでunpaired=0を確認してからpairedだけを処理するため、その条件下では適用後に
-- pending_review=0を期待する。unpairedが1件でもあれば015を止め、認証ログとして個別調査する。
