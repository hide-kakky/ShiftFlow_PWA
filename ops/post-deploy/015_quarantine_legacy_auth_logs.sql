-- v2 post-deploy cleanup: v1.6以前に通常APIをlogin_attemptとして二重記録した旧行を隔離・PII空化する。
-- 通常migrationではない。D1 backup、009-014、Pages/GAS新writer、drain確認後に明示承認を得て実行する。
PRAGMA foreign_keys = ON;

-- 009で先行作成するが、maintenance script単独実行時も相関全走査へ戻らないよう冪等に保証する。
CREATE INDEX IF NOT EXISTS idx_login_audits_request
  ON login_audits(request_id);

UPDATE login_audits
   SET org_id = NULL,
       user_email = NULL,
       user_sub = NULL,
       status = 'legacy_misclassified',
       reason = 'legacy_api_request_misclassified',
       token_iat_ms = NULL,
       client_ip = NULL,
       user_agent = NULL,
       role = NULL
 WHERE request_id IS NOT NULL
   AND request_id <> ''
   AND request_id IN (
     SELECT request_id
       FROM auth_proxy_logs
      WHERE event = 'login_attempt'
        AND request_id IS NOT NULL
        AND request_id <> ''
   );

-- login_auditsとpairになった旧API誤分類だけを更新する。unpaired行は実認証イベントの
-- 可能性があるため不可逆なPII空化を行わず、preflightで別途確認する。
UPDATE auth_proxy_logs
   SET event = 'legacy_api_request_misclassified',
       message = 'v1 API request was misclassified as login_attempt',
       email = NULL,
       status = 'quarantined',
       meta_json = '{}',
       source = 'legacy_v1_quarantine',
       client_ip = NULL,
       user_agent = NULL,
       cf_ray = NULL,
       org_id = NULL,
       user_id = NULL
 WHERE event = 'login_attempt'
   AND request_id IS NOT NULL
   AND request_id <> ''
   AND EXISTS (
     SELECT 1
       FROM login_audits paired_login
      WHERE paired_login.request_id = auth_proxy_logs.request_id
        AND paired_login.status = 'legacy_misclassified'
        AND paired_login.reason = 'legacy_api_request_misclassified'
   );
