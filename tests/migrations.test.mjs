import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const migrationDir = new URL('../migrations/', import.meta.url);
const migrationNames = (await readdir(migrationDir))
  .filter((name) => /^\d{3}_.+\.sql$/.test(name) && !name.startsWith('999_'))
  .sort();
const migrations = await Promise.all(
  migrationNames.map(async (name) => ({
    name,
    sql: await readFile(new URL(name, migrationDir), 'utf8'),
  }))
);
const qcSql = await readFile(new URL('999_qc_checks.sql', migrationDir), 'utf8');
const legacyLogQuarantineSql = await readFile(
  new URL('../ops/post-deploy/015_quarantine_legacy_auth_logs.sql', import.meta.url),
  'utf8'
);

function apply(database, list) {
  list.forEach(({ name, sql }) => {
    assert.doesNotThrow(() => database.exec(sql), `migration failed: ${name}`);
  });
}

test('空DBへ全migrationを順番に適用してv2 schemaを再構築できる', () => {
  const database = new DatabaseSync(':memory:');
  try {
    apply(database, migrations);
    const messageColumns = database.prepare('PRAGMA table_info(messages)').all();
    assert.ok(messageColumns.some((column) => column.name === 'priority'));
    const authEventColumns = database.prepare('PRAGMA table_info(auth_events)').all();
    assert.ok(authEventColumns.some((column) => column.name === 'event_key'));
    const proxyColumns = database.prepare('PRAGMA table_info(auth_proxy_logs)').all();
    assert.ok(proxyColumns.some((column) => column.name === 'org_id'));
    assert.ok(proxyColumns.some((column) => column.name === 'user_id'));
    const auditColumns = database.prepare('PRAGMA table_info(audit_logs)').all();
    assert.ok(auditColumns.some((column) => column.name === 'request_id'));
    assert.ok(auditColumns.some((column) => column.name === 'request_payload_sha256'));
    assert.ok(auditColumns.some((column) => column.name === 'request_generation_ms'));
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'storage_cleanup_jobs'")
        .get()
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_attachment_insert_during_cleanup_lease'"
        )
        .get()
    );
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'api_idempotency_keys'")
        .get()
    );
    assert.ok(
      database
        .prepare('PRAGMA table_info(api_idempotency_keys)')
        .all()
        .some((column) => column.name === 'expires_at_ms')
    );
    assert.ok(
      database
        .prepare('PRAGMA table_info(users)')
        .all()
        .some(
          (column) =>
            column.name === 'settings_version' &&
            column.notnull === 1 &&
            String(column.dflt_value) === "'0'"
        )
    );
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_revocations'")
        .get()
    );
  } finally {
    database.close();
  }
});

test('009適用時に旧ログ行を保持し、v2 observability列とcleanup台帳を追加する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const beforeV2 = migrations.filter(({ name }) => name < '009_');
    const v2 = migrations.filter(({ name }) => name.startsWith('009_'));
    apply(database, beforeV2);
    database.exec(`
      INSERT INTO login_audits (login_id, attempted_at_ms) VALUES ('legacy-login', 1);
      INSERT INTO auth_proxy_logs (log_id, event, created_at_ms)
      VALUES ('legacy-proxy', 'login_attempt', 1);
    `);
    apply(database, v2);
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM login_audits').get().count,
      1
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM auth_proxy_logs').get().count,
      1
    );
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM auth_events').get().count, 0);
    assert.ok(
      database
        .prepare('PRAGMA table_info(audit_logs)')
        .all()
        .some((column) => column.name === 'request_id')
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM storage_cleanup_jobs').get().count,
      0
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_login_audits_request'"
        )
        .get()
    );
  } finally {
    database.close();
  }
});

test('v2 schemaに対してQC SQLを最後まで実行できる', () => {
  const database = new DatabaseSync(':memory:');
  try {
    apply(database, migrations);
    assert.doesNotThrow(() => database.exec(qcSql));
  } finally {
    database.close();
  }
});

test('010は旧監査indexをactor scopeへ移行しAPI冪等性台帳を追加する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const before010 = migrations.filter(({ name }) => name < '010_');
    const migration010 = migrations.filter(({ name }) => name.startsWith('010_'));
    apply(database, before010);
    database.exec(`
      INSERT INTO users (
        user_id, email, display_name, auth_subject, is_active, created_at_ms, updated_at_ms
      ) VALUES
        ('idem-user-a', 'idem-a@example.com', 'A', 'sub-a', 1, 1, 1),
        ('idem-user-b', 'idem-b@example.com', 'B', 'sub-b', 1, 1, 1);
      INSERT INTO memberships (
        membership_id, org_id, user_id, role, status, created_at_ms
      ) VALUES
        ('idem-member-a', '01H00000000000000000000000', 'idem-user-a', 'member', 'active', 1),
        ('idem-member-b', '01H00000000000000000000000', 'idem-user-b', 'member', 'active', 1);
      INSERT INTO audit_logs (
        audit_id, org_id, actor_membership_id, target_type, target_id, action,
        created_at_ms, request_id
      ) VALUES (
        'audit-a', '01H00000000000000000000000', 'idem-member-a', 'message',
        'message-shared', 'message.pin', 1, 'shared-request'
      );
    `);
    assert.throws(() =>
      database.exec(`
        INSERT INTO audit_logs (
          audit_id, org_id, actor_membership_id, target_type, target_id, action,
          created_at_ms, request_id
        ) VALUES (
          'audit-b-before', '01H00000000000000000000000', 'idem-member-b', 'message',
          'message-shared', 'message.pin', 1, 'shared-request'
        );
      `)
    );

    apply(database, migration010);
    database.exec(`
      INSERT INTO audit_logs (
        audit_id, org_id, actor_membership_id, target_type, target_id, action,
        created_at_ms, request_id
      ) VALUES (
        'audit-b', '01H00000000000000000000000', 'idem-member-b', 'message',
        'message-shared', 'message.pin', 1, 'shared-request'
      );
      INSERT INTO api_idempotency_keys (
        idempotency_key_id, org_id, actor_user_id, request_id, route,
        payload_sha256, created_at_ms, expires_at_ms
      ) VALUES (
        'idem-key-a', '01H00000000000000000000000', 'idem-user-a',
        'shared-request', 'messages/message-shared/pin',
        '${'a'.repeat(64)}', 1, 604800001
      );
    `);
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'shared-request'").get()
        .count,
      2
    );
    assert.throws(() =>
      database.exec(`
        INSERT INTO audit_logs (
          audit_id, org_id, actor_membership_id, target_type, target_id, action,
          created_at_ms, request_id
        ) VALUES (
          'audit-a-duplicate', '01H00000000000000000000000', 'idem-member-a', 'message',
          'message-shared', 'message.pin', 2, 'shared-request'
        );
      `)
    );
    assert.throws(() =>
      database.exec(`
        INSERT INTO api_idempotency_keys (
          idempotency_key_id, org_id, actor_user_id, request_id, route,
          payload_sha256, created_at_ms, expires_at_ms
        ) VALUES (
          'idem-key-a-duplicate', '01H00000000000000000000000', 'idem-user-a',
          'shared-request', 'messages/message-shared/pin',
          '${'b'.repeat(64)}', 2, 604800002
        );
      `)
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_api_idempotency_keys_actor_expiry'"
        )
        .get()
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(idx_api_idempotency_keys_actor_expiry)')
        .all()
        .map((column) => column.name),
      ['org_id', 'actor_user_id', 'expires_at_ms']
    );
    assert.ok(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_api_idempotency_keys_expiry'"
        )
        .get()
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(idx_api_idempotency_keys_expiry)')
        .all()
        .map((column) => column.name),
      ['expires_at_ms']
    );
  } finally {
    database.close();
  }
});

test('011は既存userを保持して設定versionを初期化する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const before011 = migrations.filter(({ name }) => name < '011_');
    const migration011 = migrations.filter(({ name }) => name.startsWith('011_'));
    apply(database, before011);
    database.exec(`
      INSERT INTO users (
        user_id, email, display_name, auth_subject, is_active, created_at_ms, updated_at_ms
      ) VALUES (
        'settings-version-user', 'settings-version@example.com', 'Version User',
        'settings-version-sub', 1, 1, 1
      );
    `);
    apply(database, migration011);
    assert.deepEqual(
      {
        ...database
          .prepare(
            "SELECT user_id, settings_version FROM users WHERE user_id = 'settings-version-user'"
          )
          .get(),
      },
      { user_id: 'settings-version-user', settings_version: '0' }
    );
  } finally {
    database.close();
  }
});

test('012は同一request世代だけを監査重複として扱う', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const before012 = migrations.filter(({ name }) => name < '012_');
    const migration012 = migrations.filter(({ name }) => name.startsWith('012_'));
    apply(database, before012);
    database.exec(`
      INSERT INTO users (
        user_id, email, display_name, auth_subject, is_active, created_at_ms, updated_at_ms,
        settings_version
      ) VALUES (
        'audit-generation-user', 'audit-generation@example.com', 'Audit User',
        'audit-generation-sub', 1, 1, 1, '0'
      );
      INSERT INTO memberships (
        membership_id, org_id, user_id, role, status, created_at_ms
      ) VALUES (
        'audit-generation-member', '01H00000000000000000000000',
        'audit-generation-user', 'member', 'active', 1
      );
      INSERT INTO audit_logs (
        audit_id, org_id, actor_membership_id, target_type, target_id, action,
        created_at_ms, request_id
      ) VALUES (
        'audit-generation-old', '01H00000000000000000000000',
        'audit-generation-member', 'user', 'audit-generation-user',
        'user_settings.update', 1, 'reused-request'
      );
    `);

    apply(database, migration012);
    const hashA = 'a'.repeat(64);
    database
      .prepare(`
        INSERT INTO audit_logs (
          audit_id, org_id, actor_membership_id, target_type, target_id, action,
          created_at_ms, request_id, request_payload_sha256, request_generation_ms
        ) VALUES (?1, ?2, ?3, 'user', ?4, 'user_settings.update', ?5, ?6, ?7, ?8)
      `)
      .run(
        'audit-generation-a',
        '01H00000000000000000000000',
        'audit-generation-member',
        'audit-generation-user',
        2,
        'reused-request',
        hashA,
        100
      );
    database
      .prepare(`
        INSERT INTO audit_logs (
          audit_id, org_id, actor_membership_id, target_type, target_id, action,
          created_at_ms, request_id, request_payload_sha256, request_generation_ms
        ) VALUES (?1, ?2, ?3, 'user', ?4, 'user_settings.update', ?5, ?6, ?7, ?8)
      `)
      .run(
        'audit-generation-b',
        '01H00000000000000000000000',
        'audit-generation-member',
        'audit-generation-user',
        3,
        'reused-request',
        hashA,
        200
      );
    assert.throws(() =>
      database
        .prepare(`
          INSERT INTO audit_logs (
            audit_id, org_id, actor_membership_id, target_type, target_id, action,
            created_at_ms, request_id, request_payload_sha256, request_generation_ms
          ) VALUES (?1, ?2, ?3, 'user', ?4, 'user_settings.update', ?5, ?6, ?7, ?8)
        `)
        .run(
          'audit-generation-a-duplicate',
          '01H00000000000000000000000',
          'audit-generation-member',
          'audit-generation-user',
          4,
          'reused-request',
          hashA,
          100
        )
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = 'reused-request'")
        .get().count,
      3
    );
  } finally {
    database.close();
  }
});

test('013はstageの初期状態・owner・quota・retry・claimをDB境界で強制する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    apply(
      database,
      migrations.filter(({ name }) => name < '014_')
    );
    database.exec(`
      INSERT INTO users (
        user_id, email, display_name, auth_subject, is_active, created_at_ms, updated_at_ms
      ) VALUES
        ('stage-user-a', 'stage-a@example.com', 'Stage A', 'stage-sub-a', 1, 1, 1),
        ('stage-user-b', 'stage-b@example.com', 'Stage B', 'stage-sub-b', 1, 1, 1);
      INSERT INTO memberships (
        membership_id, org_id, user_id, role, status, created_at_ms
      ) VALUES
        ('stage-member-a', '01H00000000000000000000000', 'stage-user-a', 'member', 'active', 1),
        ('stage-member-b', '01H00000000000000000000000', 'stage-user-b', 'member', 'active', 1);
    `);

    let sequence = 10;
    const insertStage = (id, purpose, options = {}) => {
      const current = sequence++;
      return database
        .prepare(`
          INSERT INTO staged_attachments (
            staged_attachment_id, org_id, owner_user_id, owner_membership_id,
            purpose, file_name, content_type, size_bytes, checksum, r2_key,
            request_id, request_payload_sha256, request_generation_ms, status,
            claimed_target_type, claimed_target_id, claimed_at_ms,
            created_at_ms, updated_at_ms, expires_at_ms
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, 'image/png', ?7, ?8, ?9,
            ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17, ?18
          )
        `)
        .run(
          id,
          '01H00000000000000000000000',
          options.ownerUserId || 'stage-user-a',
          options.ownerMembershipId || 'stage-member-a',
          purpose,
          `${id}.png`,
          options.sizeBytes || 1024,
          'a'.repeat(64),
          `orgs/01H00000000000000000000000/${purpose}s/objects/${id}`,
          `request-${id}`,
          'b'.repeat(64),
          current,
          options.status || 'uploading',
          options.claimedTargetType ?? null,
          options.claimedTargetId ?? null,
          options.claimedAtMs ?? null,
          current,
          current + 1_800_000
        );
    };

    assert.throws(
      () =>
        insertStage('owner-mismatch', 'message', {
          ownerMembershipId: 'stage-member-b',
        }),
      /staged_attachment_owner_scope_mismatch/
    );
    assert.throws(
      () => insertStage('direct-ready', 'message', { status: 'ready' }),
      /staged_attachment_initial_state_invalid/
    );
    assert.throws(
      () =>
        insertStage('direct-claimed', 'profile', {
          status: 'claimed',
          claimedTargetType: 'user_settings',
          claimedTargetId: 'stage-user-a',
          claimedAtMs: 20,
        }),
      /staged_attachment_initial_state_invalid/
    );

    insertStage('profile-a', 'profile');
    assert.throws(
      () => insertStage('profile-b', 'profile'),
      /staged_attachment_quota_exceeded/
    );
    database.exec(`
      UPDATE staged_attachments
         SET status = 'ready', updated_at_ms = 30
       WHERE staged_attachment_id = 'profile-a';
    `);
    assert.throws(() =>
      database.exec(`
        UPDATE staged_attachments
           SET status = 'claimed',
               claimed_target_type = 'message',
               claimed_target_id = 'message-target',
               claimed_at_ms = 31,
               updated_at_ms = 31
         WHERE staged_attachment_id = 'profile-a';
      `)
    );
    database.exec(`
      UPDATE staged_attachments
         SET status = 'claimed',
             claimed_target_type = 'user_settings',
             claimed_target_id = 'stage-user-a',
             claimed_at_ms = 32,
             updated_at_ms = 32
       WHERE staged_attachment_id = 'profile-a';
    `);
    assert.throws(() =>
      database.exec(`
        UPDATE staged_attachments
           SET claimed_target_id = 'stage-user-b', updated_at_ms = 33
         WHERE staged_attachment_id = 'profile-a';
      `)
    );

    for (let index = 1; index <= 5; index += 1) {
      insertStage(`message-${index}`, 'message', { sizeBytes: 10 * 1024 * 1024 });
    }
    assert.throws(
      () => insertStage('message-6', 'message'),
      /staged_attachment_quota_exceeded/
    );
    database.exec(`
      UPDATE staged_attachments
         SET status = 'failed', updated_at_ms = 40
       WHERE staged_attachment_id = 'message-5';
    `);
    insertStage('message-6', 'message');
    assert.throws(
      () =>
        database.exec(`
          UPDATE staged_attachments
             SET status = 'uploading', updated_at_ms = 41
           WHERE staged_attachment_id = 'message-5';
        `),
      /staged_attachment_quota_exceeded/
    );
    database.exec(`
      UPDATE staged_attachments
         SET status = 'failed', updated_at_ms = 42
       WHERE staged_attachment_id = 'message-6';
      UPDATE staged_attachments
         SET status = 'uploading', updated_at_ms = 43
       WHERE staged_attachment_id = 'message-5';
      UPDATE staged_attachments
         SET status = 'ready', updated_at_ms = 44
       WHERE staged_attachment_id = 'message-1';
      UPDATE staged_attachments
         SET status = 'claimed',
             claimed_target_type = 'message',
             claimed_target_id = 'message-target',
             claimed_at_ms = 45,
             updated_at_ms = 45
       WHERE staged_attachment_id = 'message-1';
    `);
    assert.deepEqual(
      {
        ...database
          .prepare(`
            SELECT purpose, status, claimed_target_type, claimed_target_id
              FROM staged_attachments
             WHERE staged_attachment_id = 'message-1'
          `)
          .get(),
      },
      {
        purpose: 'message',
        status: 'claimed',
        claimed_target_type: 'message',
        claimed_target_id: 'message-target',
      }
    );
  } finally {
    database.close();
  }
});

test('014はraw sessionを保存できない期限付き失効台帳とexpiry indexを追加する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const before014 = migrations.filter(({ name }) => name < '014_');
    const migration014 = migrations.filter(({ name }) => name.startsWith('014_'));
    apply(database, before014);
    apply(database, migration014);

    const fingerprint = 'a'.repeat(64);
    database
      .prepare(
        `INSERT INTO session_revocations (
           session_fingerprint, revoked_at_ms, expires_at_ms
         ) VALUES (?1, ?2, ?3)`
      )
      .run(fingerprint, 100, 200);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT session_fingerprint, revoked_at_ms, expires_at_ms
               FROM session_revocations`
          )
          .get(),
      },
      { session_fingerprint: fingerprint, revoked_at_ms: 100, expires_at_ms: 200 }
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO session_revocations (
             session_fingerprint, revoked_at_ms, expires_at_ms
           ) VALUES (?1, ?2, ?3)`
        )
        .run('raw-session-id', 100, 200)
    );
    assert.throws(() =>
      database
        .prepare(
          `INSERT INTO session_revocations (
             session_fingerprint, revoked_at_ms, expires_at_ms
           ) VALUES (?1, ?2, ?3)`
        )
        .run('b'.repeat(64), 200, 200)
    );
    assert.deepEqual(
      database
        .prepare('PRAGMA index_info(idx_session_revocations_expiry)')
        .all()
        .map((column) => column.name),
      ['expires_at_ms']
    );
  } finally {
    database.close();
  }
});

test('post-deploy 015はpaired旧ログを保持したままAPI誤分類へ再分類しPIIを空化する', () => {
  const database = new DatabaseSync(':memory:');
  try {
    apply(database, migrations);
    database.exec(`
      INSERT INTO login_audits (
        login_id, org_id, user_email, user_sub, status, reason, request_id,
        token_iat_ms, attempted_at_ms, client_ip, user_agent, role
      ) VALUES
        ('paired-login', 'org-a', 'person@example.com', 'google-sub', 'active', NULL,
         'paired-request', 123, 1000, '192.0.2.1', 'Legacy Browser', 'manager'),
        ('unpaired-login', 'org-a', 'real@example.com', 'real-sub', 'success', 'real-login',
         'unpaired-request', 456, 1001, '192.0.2.2', 'Browser', 'member');
      INSERT INTO auth_proxy_logs (
        log_id, level, event, message, request_id, route, email, status, meta_json,
        source, client_ip, user_agent, cf_ray, created_at_ms, org_id, user_id
      ) VALUES
        (
          'paired-proxy', 'info', 'login_attempt', 'login_allowed', 'paired-request',
          'getBootstrapData', 'person@example.com', 'active', '{"token":"secret"}',
          'cf-api', '192.0.2.1', 'Legacy Browser', 'ray-secret', 1000, NULL, NULL
        ),
        (
          'unpaired-auth-proxy', 'info', 'login_attempt', 'oauth_callback',
          'unpaired-auth-request', '/auth/callback', 'real-auth@example.com', 'success',
          '{"auth":"preserve"}', 'legacy-auth', '192.0.2.3', 'Auth Browser',
          'ray-auth', 1002, NULL, NULL
        );
    `);
    assert.deepEqual(
      {
        ...database
          .prepare(`
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN proxy.request_id IS NOT NULL
                                  AND proxy.request_id <> ''
                                  AND proxy.request_id IN (
                                    SELECT paired_login.request_id
                                      FROM login_audits paired_login
                                     WHERE paired_login.request_id IS NOT NULL
                                       AND paired_login.request_id <> ''
                                  ) THEN 1 ELSE 0 END) AS paired,
                   SUM(CASE WHEN proxy.request_id IS NULL
                                  OR proxy.request_id = ''
                                  OR proxy.request_id NOT IN (
                                    SELECT paired_login.request_id
                                      FROM login_audits paired_login
                                     WHERE paired_login.request_id IS NOT NULL
                                       AND paired_login.request_id <> ''
                                  ) THEN 1 ELSE 0 END) AS unpaired
              FROM auth_proxy_logs proxy
             WHERE proxy.event = 'login_attempt'
          `)
          .get(),
      },
      { total: 2, paired: 1, unpaired: 1 }
    );
    apply(database, [
      {
        name: 'ops/post-deploy/015_quarantine_legacy_auth_logs.sql',
        sql: legacyLogQuarantineSql,
      },
    ]);

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM login_audits').get().count, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM auth_proxy_logs').get().count, 2);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT org_id, user_email, user_sub, status, reason, token_iat_ms,
                    client_ip, user_agent, role
               FROM login_audits
              WHERE login_id = 'paired-login'`
          )
          .get(),
      },
      {
        org_id: null,
        user_email: null,
        user_sub: null,
        status: 'legacy_misclassified',
        reason: 'legacy_api_request_misclassified',
        token_iat_ms: null,
        client_ip: null,
        user_agent: null,
        role: null,
      }
    );
    assert.equal(
      database
        .prepare("SELECT user_email FROM login_audits WHERE login_id = 'unpaired-login'")
        .get().user_email,
      'real@example.com'
    );
    const proxy = database
      .prepare(
        `SELECT event, message, route, email, status, meta_json, source,
                client_ip, user_agent, cf_ray
           FROM auth_proxy_logs
          WHERE log_id = 'paired-proxy'`
      )
      .get();
    assert.deepEqual(
      { ...proxy },
      {
        event: 'legacy_api_request_misclassified',
        message: 'v1 API request was misclassified as login_attempt',
        route: 'getBootstrapData',
        email: null,
        status: 'quarantined',
        meta_json: '{}',
        source: 'legacy_v1_quarantine',
        client_ip: null,
        user_agent: null,
        cf_ray: null,
      }
    );
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT event, message, request_id, route, email, status, meta_json,
                    source, client_ip, user_agent, cf_ray
               FROM auth_proxy_logs
              WHERE log_id = 'unpaired-auth-proxy'`
          )
          .get(),
      },
      {
        event: 'login_attempt',
        message: 'oauth_callback',
        request_id: 'unpaired-auth-request',
        route: '/auth/callback',
        email: 'real-auth@example.com',
        status: 'success',
        meta_json: '{"auth":"preserve"}',
        source: 'legacy-auth',
        client_ip: '192.0.2.3',
        user_agent: 'Auth Browser',
        cf_ray: 'ray-auth',
      }
    );
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'login_attempt'")
        .get().count,
      1
    );
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_login_audits_request'")
        .get()
    );
  } finally {
    database.close();
  }
});
