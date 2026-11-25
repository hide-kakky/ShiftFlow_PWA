import assert from 'node:assert/strict';
import test from 'node:test';

import { recordAuthEvent } from '../functions/utils/auditEvents.js';
import {
  createDiagnosticsPayload,
  persistOperationalDiagnostic,
} from '../functions/utils/diagnostics.js';
import { SqliteD1 } from './helpers/d1-test-utils.mjs';

function createDb() {
  const db = new SqliteD1();
  db.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      auth_subject TEXT,
      status TEXT,
      first_login_at_ms INTEGER,
      last_login_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE memberships (
      membership_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE auth_events (
      event_id TEXT PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason_code TEXT,
      org_id TEXT,
      user_id TEXT,
      user_email TEXT,
      user_sub TEXT,
      status TEXT,
      role TEXT,
      request_id TEXT,
      route TEXT,
      source TEXT NOT NULL,
      session_fingerprint TEXT,
      occurred_at_ms INTEGER NOT NULL
    );
    CREATE TABLE auth_proxy_logs (
      log_id TEXT PRIMARY KEY,
      level TEXT,
      event TEXT,
      message TEXT,
      request_id TEXT,
      route TEXT,
      email TEXT,
      status TEXT,
      meta_json TEXT,
      source TEXT,
      client_ip TEXT,
      user_agent TEXT,
      cf_ray TEXT,
      created_at_ms INTEGER NOT NULL,
      org_id TEXT,
      user_id TEXT
    );
    INSERT INTO users (
      user_id, email, display_name, auth_subject, status, created_at_ms, updated_at_ms
    ) VALUES ('user-a', 'user@example.com', '利用者', 'subject-a', 'active', 1, 1);
    INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES ('member-a', 'org-a', 'user-a', 'manager', 'active', 1);
  `);
  return db;
}

test('認証成功はsession fingerprintで冪等になり、最終ログイン時刻も更新する', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  const env = { DB };
  const details = {
    eventType: 'authentication.succeeded',
    outcome: 'success',
    reasonCode: 'google_oauth_verified',
    requestId: 'oauth-request-1',
    route: '/auth/callback',
    source: 'oauth_callback',
    sessionId: 'session-secret-id',
    occurredAt: 1_750_000_000_000,
    user: {
      sub: 'subject-a',
      email: 'user@example.com',
    },
  };

  const first = await recordAuthEvent(env, details);
  const second = await recordAuthEvent(env, details);
  assert.equal(first.recorded, true);
  assert.equal(second.duplicate, true);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 1);
  const event = DB.get('SELECT * FROM auth_events');
  assert.equal(event.org_id, 'org-a');
  assert.equal(event.user_id, 'user-a');
  assert.equal(event.user_email, null);
  assert.equal(event.user_sub, null);
  assert.equal(event.session_fingerprint.length, 32);
  assert.doesNotMatch(event.event_key, /session-secret-id/);
  const user = DB.get('SELECT first_login_at_ms, last_login_at_ms FROM users WHERE user_id = ?1', 'user-a');
  assert.equal(user.first_login_at_ms, details.occurredAt);
  assert.equal(user.last_login_at_ms, details.occurredAt);
});

test('複数組織ユーザーの認証イベントは任意の組織へ誤帰属せずPIIを複製しない', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  DB.prepare(
    `INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind('member-b', 'org-b', 'user-a', 'member', 'active', 2)
    .run();

  const result = await recordAuthEvent(
    { DB },
    {
      eventType: 'authentication.succeeded',
      outcome: 'success',
      reasonCode: 'google_oauth_verified',
      requestId: 'oauth-multi-org',
      route: '/auth/callback',
      source: 'oauth_callback',
      sessionId: 'session-multi-org',
      occurredAt: 1_750_000_000_100,
      user: { email: 'user@example.com' },
    }
  );

  assert.equal(result.recorded, true);
  const event = DB.get('SELECT org_id, user_id, user_email, status, role FROM auth_events');
  assert.deepEqual({ ...event }, {
    org_id: null,
    user_id: 'user-a',
    user_email: null,
    status: 'active',
    role: '',
  });
});

test('認証失敗はrequest IDで冪等になり、session fingerprintとGoogle subを保存しない', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  const env = { DB };
  const details = {
    eventType: 'authentication.failed',
    outcome: 'failure',
    reasonCode: 'oauth_token_exchange_rejected',
    requestId: 'oauth-failure-request-1',
    route: '/auth/callback',
    source: 'oauth_callback',
    userSub: 'raw-google-subject-must-not-persist',
    occurredAt: 1_750_000_000_000,
  };

  const first = await recordAuthEvent(env, details);
  const duplicate = await recordAuthEvent(env, details);
  assert.equal(first.recorded, true);
  assert.equal(duplicate.duplicate, true);
  const event = DB.get('SELECT * FROM auth_events');
  assert.equal(event.event_type, 'authentication.failed');
  assert.equal(event.outcome, 'failure');
  assert.equal(event.reason_code, 'oauth_token_exchange_rejected');
  assert.equal(event.request_id, 'oauth-failure-request-1');
  assert.equal(event.session_fingerprint, null);
  assert.equal(event.user_sub, null);
  assert.equal(event.org_id, null);
  assert.equal(event.user_id, null);
  assert.match(event.event_key, /^auth:[0-9a-f]{64}$/);
  assert.doesNotMatch(event.event_key, /oauth-failure-request-1/);
});

test('認可イベントはserver attemptだけをdedupeしclient request ID再利用を抑制に使わない', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  const env = { DB };
  const base = {
    eventType: 'authorization.denied',
    outcome: 'denied',
    reasonCode: 'suspended',
    requestId: 'shared-request-id',
    route: 'messages',
    source: 'api_authorization',
    sessionId: 'session-a',
    orgId: 'org-a',
    userId: 'user-a',
    idempotencyScope: 'suspended',
    authAttemptId: 'authorization-attempt-a',
  };

  const first = await recordAuthEvent(env, base);
  const duplicate = await recordAuthEvent(env, base);
  const differentSession = await recordAuthEvent(env, {
    ...base,
    authAttemptId: 'authorization-attempt-b',
    sessionId: 'session-b',
  });
  const differentRoute = await recordAuthEvent(env, {
    ...base,
    authAttemptId: 'authorization-attempt-c',
    route: 'listAllTasks',
  });
  const differentTenant = await recordAuthEvent(env, {
    ...base,
    authAttemptId: 'authorization-attempt-d',
    orgId: 'org-b',
  });
  const differentUser = await recordAuthEvent(env, {
    ...base,
    authAttemptId: 'authorization-attempt-e',
    userId: 'user-b',
  });
  const reusedClientRequest = await recordAuthEvent(env, {
    ...base,
    authAttemptId: 'authorization-attempt-f',
  });

  assert.equal(first.recorded, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(differentSession.recorded, true);
  assert.equal(differentRoute.recorded, true);
  assert.equal(differentTenant.recorded, true);
  assert.equal(differentUser.recorded, true);
  assert.equal(reusedClientRequest.recorded, true);
  const rows = DB.all('SELECT event_key FROM auth_events ORDER BY event_key');
  assert.equal(rows.length, 6);
  rows.forEach((row) => {
    assert.match(row.event_key, /^auth:[0-9a-f]{64}$/);
    assert.doesNotMatch(
      row.event_key,
      /shared-request-id|session-[abc]|org-[ab]|user-[ab]|messages|listAllTasks/
    );
  });
});

test('診断はwarn/errorだけを許可し、raw header・cookie・tokenを保存しない', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  assert.equal(createDiagnosticsPayload('info', 'success', { event: 'success' }), null);

  const payload = createDiagnosticsPayload(
    'error',
    'dependency_failed',
    {
      event: 'dependency_failed',
      requestId: 'request-1',
      route: 'getMessages',
      email: 'USER@example.com',
      orgId: 'org-a',
      userId: 'user-a',
      cfRay: 'ray-1',
      detail:
        'upstream unavailable Authorization: Bearer secret-token ' +
        'https://example.test/callback?code=oauth-secret&client_secret=client-secret',
      authorization: 'Bearer secret',
      cookie: 'SESSION=secret',
      rawResponseSnippet: '<html>secret</html>',
      responseHeaders: { location: 'private' },
      nested: { token: 'secret' },
    },
    1_750_000_000_000
  );
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(
    serialized,
    /Bearer secret|secret-token|oauth-secret|client-secret|SESSION=secret|html>secret|private/
  );
  assert.equal(payload.email, '');
  assert.equal(Object.prototype.hasOwnProperty.call(payload.meta, 'email'), false);
  assert.match(payload.meta.detail, /Authorization=\[masked\]/);
  assert.match(payload.meta.detail, /code=\[masked\]/);

  const first = await persistOperationalDiagnostic(DB, payload);
  const duplicate = await persistOperationalDiagnostic(DB, payload);
  assert.equal(first.recorded, true);
  assert.equal(duplicate.recorded, false);
  const row = DB.get('SELECT * FROM auth_proxy_logs');
  assert.equal(row.org_id, 'org-a');
  assert.equal(row.user_id, 'user-a');
  assert.equal(row.client_ip, null);
  assert.equal(row.user_agent, null);
});

test('診断のtop-level messageもPII・credential・短いsecretをredactしてから永続化する', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  const rawMessage =
    'Error user@example.com https://alice:pass@example.test/cb?token=url-token ' +
    'Bearer bearer-value key=labeled-value short-secret-123 eyJabc.def.ghi';
  const payload = createDiagnosticsPayload(
    'error',
    rawMessage,
    {
      event: 'dependency_failed',
      requestId: 'request-message-redaction-1',
      route: 'getMessages',
      detail: rawMessage,
    },
    1_750_000_000_000
  );

  const serialized = JSON.stringify(payload);
  for (const secret of [
    'user@example.com',
    'alice:pass',
    'url-token',
    'bearer-value',
    'labeled-value',
    'short-secret-123',
    'eyJabc.def.ghi',
  ]) {
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(payload.message, /\[masked-email\]/);
  assert.match(payload.message, /\[masked-userinfo\]/);
  assert.match(payload.message, /token=\[masked\]/);
  assert.match(payload.message, /Bearer \[masked\]/);
  assert.match(payload.message, /key=\[masked\]/);
  assert.match(payload.message, /\[masked-secret\]/);
  assert.match(payload.message, /\[masked-jwt\]/);

  await persistOperationalDiagnostic(DB, payload);
  const row = DB.get('SELECT message, meta_json FROM auth_proxy_logs');
  const persisted = JSON.stringify(row);
  assert.equal(persisted.includes('Error'), true);
  assert.doesNotMatch(
    persisted,
    /user@example\.com|alice:pass|url-token|bearer-value|labeled-value|short-secret-123|eyJabc\.def\.ghi/
  );
});

test('診断IDは同一scopeだけをdedupeしtenant・user・routeをhashで分離する', async (t) => {
  const DB = createDb();
  t.after(() => DB.close());
  const createPayload = (overrides = {}) =>
    createDiagnosticsPayload(
      'error',
      'dependency_failed',
      {
        event: 'dependency_failed',
        requestId: 'shared-diagnostic-request',
        route: 'getMessages',
        orgId: 'org-a',
        userId: 'user-a',
        ...overrides,
      },
      1_750_000_000_000
    );

  const first = await persistOperationalDiagnostic(DB, createPayload());
  const duplicate = await persistOperationalDiagnostic(DB, createPayload());
  const differentTenant = await persistOperationalDiagnostic(
    DB,
    createPayload({ orgId: 'org-b' })
  );
  const differentUser = await persistOperationalDiagnostic(
    DB,
    createPayload({ userId: 'user-c' })
  );
  const differentRoute = await persistOperationalDiagnostic(
    DB,
    createPayload({ route: 'getHomeContent' })
  );

  assert.equal(first.recorded, true);
  assert.equal(duplicate.recorded, false);
  assert.equal(differentTenant.recorded, true);
  assert.equal(differentUser.recorded, true);
  assert.equal(differentRoute.recorded, true);
  const rows = DB.all('SELECT log_id FROM auth_proxy_logs ORDER BY log_id');
  assert.equal(rows.length, 4);
  rows.forEach((row) => {
    assert.match(row.log_id, /^diag:[0-9a-f]{64}$/);
    assert.doesNotMatch(
      row.log_id,
      /shared-diagnostic-request|org-[ab]|user-[abc]|getMessages|getHomeContent/
    );
  });
});

test('監査DB障害は認証処理へ例外を伝播させない', async () => {
  const result = await recordAuthEvent(
    { DB: new SqliteD1() },
    {
      eventType: 'session.logged_out',
      outcome: 'success',
      requestId: 'request-no-schema',
      sessionId: 'session-id',
    }
  );
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'persistence_failed');
});
