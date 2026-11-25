import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { onRequest as getSession } from '../functions/auth/session.js';
import { onRequest as logout } from '../functions/auth/logout.js';
import { onRequest as oauthCallback } from '../functions/auth/callback.js';
import { onRequest as oauthStart } from '../functions/auth/start.js';
import {
  createSession,
  destroySession,
  touchSession,
  verifySession,
} from '../functions/utils/session.js';
import { SqliteD1 } from './helpers/d1-test-utils.mjs';

const sessionRevocationMigration = await readFile(
  new URL('../migrations/014_add_session_revocations.sql', import.meta.url),
  'utf8'
);

class FakeKv {
  constructor() {
    this.values = new Map();
    this.deletes = [];
    this.failSessionPut = false;
    this.failRevocationPut = false;
    this.failAuthInitPut = false;
    this.failGet = false;
  }

  async get(key) {
    if (this.failGet) {
      throw new Error('KV get failed with user@example.com short-secret-123');
    }
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    if (this.failAuthInitPut && key.startsWith('sf:auth_init:')) {
      throw new Error('auth init put failed with user@example.com short-secret-123');
    }
    if (this.failSessionPut && key.startsWith('sf:sessions:')) {
      throw new Error('session put failed for user@example.com short-secret-123');
    }
    if (this.failRevocationPut && key.startsWith('sf:session_revoked:')) {
      throw new Error('revocation put failed for user@example.com short-secret-123');
    }
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

async function fixture() {
  const DB = new SqliteD1();
  DB.exec(sessionRevocationMigration);
  const env = { APP_KV: new FakeKv(), DB };
  const created = await createSession(env, {
    user: {
      sub: 'google-subject',
      email: 'member@example.com',
      emailVerified: true,
      name: 'Member',
    },
  });
  return {
    env,
    created,
    cookie: `SESSION=${created.sessionId}.${created.sessionKey}`,
  };
}

function attachAuthEventDb(env) {
  const DB = env.DB || new SqliteD1();
  DB.exec(sessionRevocationMigration);
  DB.exec(`
    CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      auth_subject TEXT,
      status TEXT,
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
    CREATE TABLE oauth_callback_claims (
      state_fingerprint TEXT PRIMARY KEY,
      claimed_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
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
    ) VALUES ('user-logout', 'member@example.com', 'Member', 'google-subject', 'active', 1, 1);
    INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES ('membership-logout', 'org-logout', 'user-logout', 'member', 'active', 1);
  `);
  env.DB = DB;
  return DB;
}

function wrapRevocationStoreFailure(DB, { failRead = false, failWrite = false } = {}) {
  const failingStatement = () => ({
    bind() {
      return {
        async first() {
          throw new Error('raw D1 failure with user@example.com short-secret-123');
        },
        async run() {
          throw new Error('raw D1 failure with user@example.com short-secret-123');
        },
      };
    },
  });
  return {
    prepare: DB.prepare.bind(DB),
    batch: DB.batch.bind(DB),
    withSession(mode) {
      DB.sessionConsistencyModes.push(mode);
      return {
        prepare(sql) {
          const normalized = String(sql || '').replace(/\s+/g, ' ').trim();
          if (
            (failRead && normalized.startsWith('SELECT expires_at_ms FROM session_revocations')) ||
            (failWrite && normalized.startsWith('INSERT INTO session_revocations'))
          ) {
            return failingStatement();
          }
          return DB.prepare(sql);
        },
        batch: DB.batch.bind(DB),
      };
    },
  };
}

test('/auth/session はGoogleへ通信せず保存済みセッションだけで認証する', async () => {
  const { env, cookie } = await fixture();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected external request');
  };

  try {
    const response = await getSession({
      request: new Request('https://shiftflow.pages.dev/auth/session', {
        headers: { cookie },
      }),
      env,
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.authenticated, true);
    assert.equal(payload.user.email, 'member@example.com');
    assert.equal(fetchCalls, 0);
    assert.deepEqual(env.DB.sessionConsistencyModes, ['first-primary']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('set-cookie') || '', /SameSite=Lax/);
    if (typeof response.headers.getSetCookie === 'function') {
      const setCookies = response.headers.getSetCookie();
      assert.equal(setCookies.length, 2);
      assert.doesNotMatch(setCookies[0], /Domain=/i);
      assert.match(setCookies[1], /Domain=shiftflow\.pages\.dev/i);
      assert.match(setCookies[1], /Max-Age=0/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/auth/session はCookieなしを冪等な未認証として返す', async () => {
  const env = { APP_KV: new FakeKv() };
  const response = await getSession({
    request: new Request('https://shiftflow.pages.dev/auth/session'),
    env,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.authenticated, false);
  assert.equal(payload.reason, 'no_session');
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('/auth/session のKV障害は503とstable診断を返し未処理500にしない', async (t) => {
  const { env, cookie } = await fixture();
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  env.APP_KV.failGet = true;
  const response = await getSession({
    request: new Request('https://shiftflow.pages.dev/auth/session', {
      headers: {
        cookie,
        'x-shiftflow-request-id': 'session-kv-failure',
      },
    }),
    env,
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'session_verification_unavailable');
  const diagnostic = DB.get(
    "SELECT event, request_id, meta_json FROM auth_proxy_logs WHERE event = 'auth_session_verification_failed'"
  );
  assert.equal(diagnostic.request_id, 'session-kv-failure');
  assert.equal(JSON.stringify(diagnostic).includes('user@example.com'), false);
  assert.equal(JSON.stringify(diagnostic).includes('short-secret-123'), false);
});

test('/auth/session のD1 primary障害はfail-closed 503でCookieとKV recordを保持する', async (t) => {
  const { env, created, cookie } = await fixture();
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  env.DB = wrapRevocationStoreFailure(DB, { failRead: true });

  const response = await getSession({
    request: new Request('https://shiftflow.pages.dev/auth/session', {
      headers: {
        cookie,
        'x-shiftflow-request-id': 'session-d1-failure',
      },
    }),
    env,
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'session_verification_unavailable');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(env.APP_KV.values.has(`sf:sessions:${created.sessionId}`), true);
  const diagnostic = DB.get(
    "SELECT event, request_id, meta_json FROM auth_proxy_logs WHERE event = 'auth_session_verification_failed'"
  );
  assert.equal(diagnostic.request_id, 'session-d1-failure');
  assert.doesNotMatch(JSON.stringify(diagnostic), /user@example\.com|short-secret-123/);
});

test('/auth/session の更新失敗は503とstable診断を返す', async (t) => {
  const env = { APP_KV: new FakeKv() };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const sessionId = crypto.randomUUID();
  const sessionKey = 'A'.repeat(43);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionKey));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const now = Date.now();
  env.APP_KV.values.set(
    `sf:sessions:${sessionId}`,
    JSON.stringify({
      sessionVersion: 2,
      id: sessionId,
      hash,
      user: {
        sub: 'google-subject',
        email: 'member@example.com',
        emailVerified: true,
        name: 'Member',
      },
      createdAt: now - 60 * 60 * 1000,
      updatedAt: now - 10 * 60 * 1000,
      lastAccessAt: now - 10 * 60 * 1000,
    })
  );
  env.APP_KV.failSessionPut = true;
  const response = await getSession({
    request: new Request('https://shiftflow.pages.dev/auth/session', {
      headers: {
        cookie: `SESSION=${sessionId}.${sessionKey}`,
        'x-shiftflow-request-id': 'session-touch-failure',
      },
    }),
    env,
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'session_refresh_unavailable');
  assert.equal(
    DB.get(
      "SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'auth_session_touch_failed' AND request_id = 'session-touch-failure'"
    ).count,
    1
  );
});

test('/auth/start の設定障害は失敗監査と運用診断を同じrequest IDで残す', async (t) => {
  const env = {
    APP_KV: new FakeKv(),
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
  };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const response = await oauthStart({
    request: new Request('https://shiftflow.pages.dev/auth/start', {
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        'x-shiftflow-request-id': 'auth-start-config-failure',
      },
    }),
    env,
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /\/signin\?e=config/);
  assert.deepEqual(
    {
      ...DB.get(
        "SELECT event_type, reason_code, request_id FROM auth_events WHERE request_id = 'auth-start-config-failure'"
      ),
    },
    {
      event_type: 'authentication.failed',
      reason_code: 'oauth_configuration_load_failed',
      request_id: 'auth-start-config-failure',
    }
  );
  assert.equal(
    DB.get(
      "SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'auth_start_failed' AND request_id = 'auth-start-config-failure'"
    ).count,
    1
  );
});

test('/auth/start の認証初期値保存失敗はraw例外を残さず安全に戻す', async (t) => {
  const APP_KV = new FakeKv();
  APP_KV.failAuthInitPut = true;
  const env = {
    APP_KV,
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
    CF_ORIGIN: 'https://shiftflow.pages.dev',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const response = await oauthStart({
    request: new Request('https://shiftflow.pages.dev/auth/start', {
      headers: {
        'cf-connecting-ip': '192.0.2.2',
        'x-shiftflow-request-id': 'auth-start-persist-failure',
      },
    }),
    env,
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location') || '', /\/signin\?e=server/);
  const combined = JSON.stringify({
    event: DB.get(
      "SELECT * FROM auth_events WHERE request_id = 'auth-start-persist-failure'"
    ),
    diagnostic: DB.get(
      "SELECT * FROM auth_proxy_logs WHERE request_id = 'auth-start-persist-failure'"
    ),
  });
  assert.match(combined, /oauth_auth_init_persist_failed/);
  assert.doesNotMatch(combined, /user@example\.com|short-secret-123/);
});

test('/auth/start は同一clientの同時過剰呼び出しもKV guardで20件に制限する', async () => {
  const env = {
    APP_KV: new FakeKv(),
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
    CF_ORIGIN: 'https://shiftflow.pages.dev',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const invoke = () =>
    oauthStart({
      request: new Request('https://shiftflow.pages.dev/auth/start', {
        headers: { 'cf-connecting-ip': '192.0.2.3' },
      }),
      env,
    });
  const responses = await Promise.all(Array.from({ length: 40 }, invoke));
  const allowed = responses.filter((response) =>
    (response.headers.get('location') || '').startsWith(
      'https://accounts.google.com/o/oauth2/v2/auth?'
    )
  );
  const blocked = responses.filter((response) =>
    /\/signin\?e=rate/.test(response.headers.get('location') || '')
  );
  assert.equal(allowed.length, 20);
  assert.equal(blocked.length, 20);
  assert.ok(responses.every((response) => response.status === 302));
  assert.ok(blocked.every((response) => response.headers.get('retry-after') === '60'));
  assert.equal(
    Array.from(env.APP_KV.values.keys()).filter((key) => key.startsWith('sf:auth_init:')).length,
    20
  );
});

test('/auth/logout は正しいCookieだけを破棄し、改ざんCookieではKVを削除しない', async (t) => {
  const valid = await fixture();
  const validDb = attachAuthEventDb(valid.env);
  t.after(() => validDb.close());
  const validResponse = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: valid.cookie,
        origin: 'https://shiftflow.pages.dev',
      },
    }),
    env: valid.env,
  });
  assert.equal(validResponse.status, 200);
  assert.deepEqual(valid.env.APP_KV.deletes, [`sf:sessions:${valid.created.sessionId}`]);
  assert.equal(validResponse.headers.get('cache-control'), 'no-store');

  const tampered = await fixture();
  t.after(() => tampered.env.DB.close());
  const last = tampered.created.sessionKey.at(-1);
  const wrongKey = `${tampered.created.sessionKey.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  const tamperedResponse = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: `SESSION=${tampered.created.sessionId}.${wrongKey}`,
        origin: 'https://shiftflow.pages.dev',
      },
    }),
    env: tampered.env,
  });
  assert.equal(tamperedResponse.status, 200);
  assert.deepEqual(tampered.env.APP_KV.deletes, []);
  assert.match(tamperedResponse.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('/auth/logout は異なるOriginからの破棄を拒否する', async () => {
  const { env, cookie } = await fixture();
  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://attacker.example' },
    }),
    env,
  });
  assert.equal(response.status, 403);
  assert.deepEqual(env.APP_KV.deletes, []);
});

test('/auth/logout のセッション確認障害は503とstable診断を返す', async (t) => {
  const failed = await fixture();
  const DB = attachAuthEventDb(failed.env);
  t.after(() => DB.close());
  failed.env.APP_KV.failGet = true;
  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: failed.cookie,
        origin: 'https://shiftflow.pages.dev',
        'x-shiftflow-request-id': 'logout-verify-failure',
      },
    }),
    env: failed.env,
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'session_verification_unavailable');
  assert.equal(
    DB.get(
      "SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'auth_logout_session_verification_failed' AND request_id = 'logout-verify-failure'"
    ).count,
    1
  );
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 0);
});

test('/auth/logout のD1失効書込み失敗は503でCookieとKV recordを保持する', async (t) => {
  const failed = await fixture();
  const DB = attachAuthEventDb(failed.env);
  t.after(() => DB.close());
  failed.env.DB = wrapRevocationStoreFailure(DB, { failWrite: true });

  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: failed.cookie,
        origin: 'https://shiftflow.pages.dev',
        'x-shiftflow-request-id': 'logout-d1-write-failure',
      },
    }),
    env: failed.env,
  });
  const payload = await response.json();
  assert.equal(response.status, 503);
  assert.equal(payload.code, 'session_revocation_failed');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(
    failed.env.APP_KV.values.has(`sf:sessions:${failed.created.sessionId}`),
    true
  );
  assert.equal(
    failed.env.APP_KV.values.has(`sf:session_revoked:${failed.created.sessionId}`),
    false
  );
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM session_revocations').count, 0);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 0);
  assert.equal(
    DB.get(
      "SELECT COUNT(*) AS count FROM auth_proxy_logs WHERE event = 'auth_logout_session_revocation_failed' AND request_id = 'logout-d1-write-failure'"
    ).count,
    1
  );
});

test('/auth/logout はセッション破棄後にだけ成功監査を1件記録する', async (t) => {
  const valid = await fixture();
  const DB = attachAuthEventDb(valid.env);
  t.after(() => DB.close());
  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: valid.cookie,
        origin: 'https://shiftflow.pages.dev',
        'x-shiftflow-request-id': 'logout-success-1',
      },
    }),
    env: valid.env,
  });
  assert.equal(response.status, 200);
  const event = DB.get(
    'SELECT event_type, outcome, request_id, user_id, org_id FROM auth_events'
  );
  assert.deepEqual({ ...event }, {
    event_type: 'session.logged_out',
    outcome: 'success',
    request_id: 'logout-success-1',
    user_id: 'user-logout',
    org_id: 'org-logout',
  });
});

test('/auth/logout の同じCookie再送は冪等で失効行と成功監査を重複させない', async (t) => {
  const valid = await fixture();
  const DB = attachAuthEventDb(valid.env);
  t.after(() => DB.close());
  const invoke = (requestId) =>
    logout({
      request: new Request('https://shiftflow.pages.dev/auth/logout', {
        method: 'POST',
        headers: {
          cookie: valid.cookie,
          origin: 'https://shiftflow.pages.dev',
          'x-shiftflow-request-id': requestId,
        },
      }),
      env: valid.env,
    });

  const first = await invoke('logout-retry-first');
  const second = await invoke('logout-retry-second');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(first.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.match(second.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM session_revocations').count, 1);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 1);
});

test('/auth/logout はrecord削除失敗でもtombstoneで失効し成功監査を残す', async (t) => {
  const failed = await fixture();
  const DB = attachAuthEventDb(failed.env);
  t.after(() => DB.close());
  failed.env.APP_KV.delete = async () => {
    throw new Error('forced KV delete failure');
  };
  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: failed.cookie,
        origin: 'https://shiftflow.pages.dev',
        'x-shiftflow-request-id': 'logout-failure-1',
      },
    }),
    env: failed.env,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.loggedOut, true);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 1);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
  assert.ok(failed.env.APP_KV.values.has(`sf:sessions:${failed.created.sessionId}`));
  assert.equal(
    failed.env.APP_KV.values.get(`sf:session_revoked:${failed.created.sessionId}`),
    '1'
  );
  assert.equal(await verifySession(failed.env, failed.cookie), null);
});

test('/auth/logout はKV tombstone保存失敗でもD1 primary失効後なら安全に成功する', async (t) => {
  const failed = await fixture();
  const DB = attachAuthEventDb(failed.env);
  t.after(() => DB.close());
  failed.env.APP_KV.failRevocationPut = true;
  const response = await logout({
    request: new Request('https://shiftflow.pages.dev/auth/logout', {
      method: 'POST',
      headers: {
        cookie: failed.cookie,
        origin: 'https://shiftflow.pages.dev',
        'x-shiftflow-request-id': 'logout-tombstone-failure-1',
      },
    }),
    env: failed.env,
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.loggedOut, true);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 1);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM session_revocations').count, 1);
  assert.equal(
    failed.env.APP_KV.values.has(`sf:sessions:${failed.created.sessionId}`),
    false
  );
  assert.equal(await verifySession(failed.env, failed.cookie), null);
});

test('logout後のthrottle済みtouchはKVへ書き戻さずsessionを復活させない', async () => {
  const current = await fixture();
  const staleRecord = JSON.parse(JSON.stringify(current.created.record));
  const result = await destroySession(current.env, current.created.sessionId);
  assert.deepEqual(result, { revoked: true, tombstoned: true, deleted: true });
  const touched = await touchSession(current.env, current.created.sessionId, staleRecord);
  assert.ok(touched);
  assert.equal(
    current.env.APP_KV.values.has(`sf:sessions:${current.created.sessionId}`),
    false
  );
  assert.equal(await verifySession(current.env, current.cookie), null);
});

test('/auth/session の同一期限切れセッションへの同時到達は期限切れ監査を1件だけ残す', async (t) => {
  const expired = await fixture();
  const DB = attachAuthEventDb(expired.env);
  t.after(() => DB.close());
  const storageKey = `sf:sessions:${expired.created.sessionId}`;
  const stored = JSON.parse(expired.env.APP_KV.values.get(storageKey));
  expired.env.APP_KV.values.set(
    storageKey,
    JSON.stringify({
      ...stored,
      lastAccessAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    })
  );

  const responses = await Promise.all(
    ['session-expired-1', 'session-expired-2'].map((requestId) =>
      getSession({
        request: new Request('https://shiftflow.pages.dev/auth/session', {
          headers: {
            cookie: expired.cookie,
            'x-shiftflow-request-id': requestId,
          },
        }),
        env: expired.env,
      })
    )
  );
  const payloads = await Promise.all(responses.map((response) => response.json()));

  assert.ok(responses.every((response) => response.status === 200));
  assert.ok(payloads.every((payload) => payload.authenticated === false));
  assert.ok(payloads.every((payload) => payload.reason === 'idle_timeout'));
  assert.equal(
    DB.get("SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'session.expired'").count,
    1
  );
  const event = DB.get(
    "SELECT reason_code, route, source, session_fingerprint FROM auth_events WHERE event_type = 'session.expired'"
  );
  assert.equal(event.reason_code, 'idle_timeout');
  assert.equal(event.route, '/auth/session');
  assert.equal(event.source, 'auth_session');
  assert.equal(event.session_fingerprint.length, 32);
  assert.equal(expired.env.APP_KV.values.has(storageKey), false);
});

test('/auth/callback はstate/PKCE Cookieなしの未開始アクセスを拒否し、監査を増やさない', async (t) => {
  const env = { APP_KV: new FakeKv(), AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt' };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected token exchange');
  };
  try {
    const response = await oauthCallback({
      request: new Request(
        'https://shiftflow.pages.dev/auth/callback?code=attacker-code&state=attacker-state'
      ),
      env,
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /\/signin\?e=state/);
    assert.equal(fetchCalls, 0);
    assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('/auth/callback は未開始アクセスを監査へ増幅せず過剰呼び出しを止める', async (t) => {
  const env = { APP_KV: new FakeKv(), AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt' };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const invoke = () =>
    oauthCallback({
      request: new Request(
        'https://shiftflow.pages.dev/auth/callback?code=attacker-code&state=attacker-state',
        { headers: { 'cf-connecting-ip': '198.51.100.5' } }
      ),
      env,
    });
  for (let index = 0; index < 30; index += 1) {
    const response = await invoke();
    assert.match(response.headers.get('location') || '', /\/signin\?e=state/);
  }
  const blocked = await invoke();
  assert.match(blocked.headers.get('location') || '', /\/signin\?e=rate/);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 0);
  assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_proxy_logs').count, 0);
});

test('/auth/callback のtoken拒否はraw応答を出力せず、同一request IDを1件に集約する', async (t) => {
  const APP_KV = new FakeKv();
  const env = {
    APP_KV,
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
    CF_ORIGIN: 'https://shiftflow.pages.dev',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const state = 'failure-state';
  APP_KV.values.set(
    `sf:auth_init:${state}`,
    JSON.stringify({
      returnTo: '/',
      requestId: 'oauth-token-failure-1',
      authAttemptId: 'oauth-token-failure-attempt',
      codeVerifier: 'raw-pkce-verifier',
    })
  );
  const originalFetch = globalThis.fetch;
  const originalConsole = {
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const consoleEntries = [];
  console.info = (...args) => consoleEntries.push(args);
  console.warn = (...args) => consoleEntries.push(args);
  console.error = (...args) => consoleEntries.push(args);
  let responseBodyRead = false;
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      responseBodyRead = true;
      return 'token=raw-response-token user@example.com short-secret-123';
    },
  });

  const invoke = () =>
    oauthCallback({
      request: new Request(
        `https://shiftflow.pages.dev/auth/callback?code=raw-oauth-code&state=${state}`,
        {
          headers: {
            cookie: `OAUTH_STATE=${state}; PKCE_CODE_VERIFIER=raw-pkce-verifier`,
            'x-shiftflow-request-id': 'oauth-token-failure-1',
          },
        }
      ),
      env,
    });

  try {
    const first = await invoke();
    const duplicate = await invoke();
    assert.equal(first.status, 302);
    assert.equal(duplicate.status, 302);
    assert.match(first.headers.get('location') || '', /\/signin\?e=token/);
    assert.equal(responseBodyRead, false);
    assert.equal(
      DB.get("SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'authentication.failed'")
        .count,
      1
    );
    const event = DB.get('SELECT * FROM auth_events');
    assert.equal(event.reason_code, 'oauth_token_exchange_rejected');
    assert.equal(event.request_id, 'oauth-token-failure-1');
    assert.equal(event.user_sub, null);
    assert.equal(event.session_fingerprint, null);
    const persisted = JSON.stringify(event);
    const consoleOutput = JSON.stringify(consoleEntries);
    assert.doesNotMatch(
      `${persisted}\n${consoleOutput}`,
      /raw-oauth-code|raw-pkce-verifier|raw-response-token|user@example\.com|short-secret-123/
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }
});

test('/auth/callback のsession保存失敗はraw例外を出さず失敗監査へ収束する', async (t) => {
  const APP_KV = new FakeKv();
  APP_KV.failSessionPut = true;
  const env = {
    APP_KV,
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
    CF_ORIGIN: 'https://shiftflow.pages.dev',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const DB = attachAuthEventDb(env);
  t.after(() => DB.close());
  const state = 'session-failure-state';
  APP_KV.values.set(
    `sf:auth_init:${state}`,
    JSON.stringify({
      returnTo: '/',
      requestId: 'oauth-session-failure-1',
      authAttemptId: 'oauth-session-failure-attempt',
      codeVerifier: 'valid-verifier',
    })
  );
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const consoleEntries = [];
  console.warn = (...args) => consoleEntries.push(args);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
      return new Response(
        JSON.stringify({
          aud: env.GOOGLE_OAUTH_CLIENT_ID,
          iss: 'https://accounts.google.com',
          sub: 'google-subject',
          email: 'member@example.com',
          email_verified: 'true',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const response = await oauthCallback({
      request: new Request(
        `https://shiftflow.pages.dev/auth/callback?code=valid-code&state=${state}`,
        {
          headers: {
            cookie: `OAUTH_STATE=${state}; PKCE_CODE_VERIFIER=valid-verifier`,
          },
        }
      ),
      env,
    });
    assert.equal(response.status, 302);
    assert.match(response.headers.get('location') || '', /\/signin\?e=session/);
    const event = DB.get(
      'SELECT event_type, reason_code, request_id, user_id, org_id, user_email, user_sub FROM auth_events'
    );
    assert.deepEqual({ ...event }, {
      event_type: 'authentication.failed',
      reason_code: 'oauth_session_creation_failed',
      request_id: 'oauth-session-failure-1',
      user_id: 'user-logout',
      org_id: 'org-logout',
      user_email: null,
      user_sub: null,
    });
    const output = JSON.stringify(consoleEntries);
    assert.doesNotMatch(output, /user@example\.com|short-secret-123/);
    assert.equal(
      Array.from(APP_KV.values.keys()).some((key) => key.startsWith('sf:sessions:')),
      false
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('/auth/callback 同時到着はtoken exchange前に1本へclaimし、実ログインを1件だけ記録する', async (t) => {
  const APP_KV = new FakeKv();
  const DB = new SqliteD1();
  t.after(() => DB.close());
  DB.exec(`
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
    CREATE TABLE oauth_callback_claims (
      state_fingerprint TEXT PRIMARY KEY,
      claimed_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    INSERT INTO users (
      user_id, email, display_name, auth_subject, status, created_at_ms, updated_at_ms
    ) VALUES ('user-1', 'member@example.com', 'Member', 'google-subject', 'active', 1, 1);
    INSERT INTO memberships (
      membership_id, org_id, user_id, role, status, created_at_ms
    ) VALUES ('membership-1', 'org-1', 'user-1', 'member', 'active', 1);
  `);
  const state = 'valid-state';
  APP_KV.values.set(
    `sf:auth_init:${state}`,
    JSON.stringify({
      returnTo: '/',
      requestId: 'oauth-flow-1',
      authAttemptId: 'oauth-flow-attempt',
      codeVerifier: 'valid-verifier',
    })
  );
  const env = {
    APP_KV,
    DB,
    AUTH_RATE_LIMIT_SALT: 'test-rate-limit-salt',
    CF_ORIGIN: 'https://shiftflow.pages.dev',
    GOOGLE_OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  };
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    fetchCalls.push({ url, method: init.method || 'GET' });
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ id_token: 'verified-id-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo?')) {
      return new Response(
        JSON.stringify({
          aud: env.GOOGLE_OAUTH_CLIENT_ID,
          iss: 'https://accounts.google.com',
          sub: 'google-subject',
          email: 'member@example.com',
          email_verified: 'true',
          name: 'Member',
          exp: String(Math.floor(Date.now() / 1000) + 3600),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const createCallbackRequest = () =>
      new Request(`https://shiftflow.pages.dev/auth/callback?code=valid-code&state=${state}`, {
        headers: {
          cookie: `OAUTH_STATE=${state}; PKCE_CODE_VERIFIER=valid-verifier`,
        },
      });
    const responses = await Promise.all([
      oauthCallback({ request: createCallbackRequest(), env }),
      oauthCallback({ request: createCallbackRequest(), env }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [302, 302]
    );
    const locations = responses.map((response) => response.headers.get('location'));
    assert.equal(
      locations.filter((location) => location === 'https://shiftflow.pages.dev/').length,
      1
    );
    assert.equal(
      locations.filter((location) => /^\/signin\?e=state&req=[0-9a-f-]+$/i.test(location || '')).length,
      1
    );
    assert.equal(fetchCalls.length, 2);
    assert.equal(DB.get('SELECT COUNT(*) AS count FROM auth_events').count, 1);
    const event = DB.get('SELECT * FROM auth_events');
    assert.equal(event.event_type, 'authentication.succeeded');
    assert.equal(event.org_id, 'org-1');
    assert.equal(event.request_id, 'oauth-flow-1');
    assert.equal(event.user_sub, null);
    assert.equal(event.session_fingerprint.length, 32);
    const sessionStorageKey = Array.from(APP_KV.values.keys()).find((key) =>
      key.startsWith('sf:sessions:')
    );
    assert.ok(sessionStorageKey);
    assert.doesNotMatch(event.event_key, new RegExp(sessionStorageKey.slice('sf:sessions:'.length)));
    const user = DB.get('SELECT first_login_at_ms, last_login_at_ms FROM users WHERE user_id = ?1', 'user-1');
    assert.ok(user.first_login_at_ms > 1);
    assert.equal(user.last_login_at_ms, user.first_login_at_ms);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
