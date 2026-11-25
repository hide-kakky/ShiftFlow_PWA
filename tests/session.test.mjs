import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SqliteD1 } from './helpers/d1-test-utils.mjs';

const sessionSource = await readFile(
  new URL('../functions/utils/session.js', import.meta.url),
  'utf8'
);
const sessionModule = await import(
  `data:text/javascript;base64,${Buffer.from(sessionSource).toString('base64')}`
);
const sessionRevocationMigration = await readFile(
  new URL('../migrations/014_add_session_revocations.sql', import.meta.url),
  'utf8'
);

class FakeKv {
  constructor() {
    this.values = new Map();
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

function createEnv() {
  const DB = new SqliteD1();
  DB.exec(sessionRevocationMigration);
  return { APP_KV: new FakeKv(), DB };
}

function sessionCookie(created) {
  return `SESSION=${created.sessionId}.${created.sessionKey}`;
}

function encodeJwtPayload(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('新規セッションはGoogleトークンを保存せず、Cookieで再検証できる', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: {
      sub: 'google-subject-1',
      email: 'member@example.com',
      emailVerified: true,
      name: 'Member',
    },
    tokens: { idToken: 'must-not-be-persisted' },
  });

  assert.equal(created.record.sessionVersion, 2);
  assert.equal('tokens' in created.record, false);
  assert.equal(env.APP_KV.puts.at(-1).options.expirationTtl, 90 * 24 * 60 * 60);

  const verified = await sessionModule.verifySession(env, sessionCookie(created));
  assert.equal(verified?.record.user.sub, 'google-subject-1');
  assert.equal(verified?.record.user.email, 'member@example.com');
  assert.deepEqual(env.DB.sessionConsistencyModes, ['first-primary']);
  const putCount = env.APP_KV.puts.length;
  const touched = await sessionModule.touchSession(env, created.sessionId, verified.record);
  assert.ok(touched);
  assert.equal(env.APP_KV.puts.length, putCount);
  assert.deepEqual(env.DB.sessionConsistencyModes, ['first-primary']);
});

test('SESSION Cookieはhost-onlyで、旧Domain Cookieは明示的に失効できる', () => {
  const cookie = sessionModule.buildSessionCookie('value');
  const legacyExpired = sessionModule.buildExpiredSessionCookie({
    domain: 'shiftflow.pages.dev',
  });
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(legacyExpired, /Domain=shiftflow\.pages\.dev/);
  assert.match(legacyExpired, /Max-Age=0/);
});

test('改ざん・不正形式・壊れたURLエンコードのCookieを安全に拒否する', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
  });

  const last = created.sessionKey.at(-1);
  const tamperedKey = `${created.sessionKey.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  assert.equal(
    await sessionModule.verifySession(env, `SESSION=${created.sessionId}.${tamperedKey}`),
    null
  );
  assert.deepEqual(env.DB.sessionConsistencyModes, []);
  assert.equal(
    await sessionModule.verifySession(
      env,
      `SESSION=${crypto.randomUUID()}.${'A'.repeat(43)}`
    ),
    null
  );
  assert.deepEqual(env.DB.sessionConsistencyModes, []);
  assert.equal(await sessionModule.verifySession(env, 'SESSION=not-a-session'), null);
  assert.deepEqual(sessionModule.parseCookies('safe=value; broken=%E0%A4%A'), {
    safe: 'value',
    broken: '%E0%A4%A',
  });
});

test('30日アイドル期限と90日絶対期限を別々に判定する', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const active = sessionModule.evaluateSessionTimeout(
    { createdAt: now - 80 * day, lastAccessAt: now - day },
    now
  );
  const idleExpired = sessionModule.evaluateSessionTimeout(
    { createdAt: now - 40 * day, lastAccessAt: now - 31 * day },
    now
  );
  const absoluteExpired = sessionModule.evaluateSessionTimeout(
    { createdAt: now - 91 * day, lastAccessAt: now - day },
    now
  );

  assert.equal(active.expired, false);
  assert.equal(idleExpired.reason, 'idle');
  assert.equal(absoluteExpired.reason, 'absolute');
});

test('Cookie寿命とKV TTLは90日の絶対期限を超えて延長されない', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
  });
  const day = 24 * 60 * 60 * 1000;
  const nearAbsolute = {
    ...created.record,
    createdAt: Date.now() - 89 * day,
    updatedAt: Date.now() - 10 * 60 * 1000,
    lastAccessAt: Date.now() - 10 * 60 * 1000,
  };

  const maxAge = sessionModule.getSessionCookieMaxAge(nearAbsolute);
  assert.ok(maxAge > 0 && maxAge <= 24 * 60 * 60);

  await sessionModule.touchSession(env, `ttl-test-${created.sessionId}`, nearAbsolute);
  assert.ok(env.APP_KV.puts.at(-1).options.expirationTtl <= 24 * 60 * 60 + 1);
});

test('旧セッションは検証済み保存情報からv2へ一度だけ移行する', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: { email: 'legacy@example.com', name: 'Legacy' },
  });
  const key = `sf:sessions:${created.sessionId}`;
  const legacyRecord = {
    ...created.record,
    sessionVersion: 1,
    user: { email: 'legacy@example.com', name: 'Legacy' },
    tokens: {
      idToken: encodeJwtPayload({
        sub: 'legacy-google-subject',
        email: 'legacy@example.com',
        email_verified: true,
      }),
    },
  };
  env.APP_KV.values.set(key, JSON.stringify(legacyRecord));

  const verified = await sessionModule.verifySession(env, sessionCookie(created));
  assert.equal(verified?.record.sessionVersion, 2);
  assert.equal(verified?.record.user.sub, 'legacy-google-subject');
  assert.equal(verified?.record.user.emailVerified, true);
  assert.equal('tokens' in verified.record, false);
});

test('未確認メールの旧セッションは移行せず再ログインを要求する', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: { email: 'legacy@example.com' },
  });
  env.APP_KV.values.set(
    `sf:sessions:${created.sessionId}`,
    JSON.stringify({
      ...created.record,
      sessionVersion: 1,
      user: { email: 'legacy@example.com' },
      tokens: {
        idToken: encodeJwtPayload({
          sub: 'legacy-google-subject',
          email: 'legacy@example.com',
          email_verified: false,
        }),
      },
    })
  );
  assert.equal(await sessionModule.verifySession(env, sessionCookie(created)), null);
});

test('logout失効はraw sessionを保存せず64桁SHA-256だけをD1 primaryへ冪等保存する', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: {
      sub: 'private-subject',
      email: 'private-member@example.com',
      emailVerified: true,
    },
  });

  const first = await sessionModule.destroySession(env, created.sessionId);
  const second = await sessionModule.destroySession(env, created.sessionId);
  assert.deepEqual(first, { revoked: true, tombstoned: true, deleted: true });
  assert.deepEqual(second, { revoked: true, tombstoned: true, deleted: true });

  const rows = env.DB.all(
    'SELECT session_fingerprint, revoked_at_ms, expires_at_ms FROM session_revocations'
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].session_fingerprint, /^[0-9a-f]{64}$/);
  const expectedFingerprint = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(created.sessionId))
  ).toString('hex');
  assert.equal(rows[0].session_fingerprint, expectedFingerprint);
  assert.ok(rows[0].expires_at_ms > rows[0].revoked_at_ms);
  const persisted = JSON.stringify(rows[0]);
  assert.doesNotMatch(persisted, new RegExp(created.sessionId.replaceAll('-', '\\-')));
  assert.doesNotMatch(persisted, new RegExp(created.sessionKey));
  assert.doesNotMatch(persisted, /private-member@example\.com|private-subject/);
  assert.ok(env.DB.sessionConsistencyModes.length >= 2);
  assert.ok(env.DB.sessionConsistencyModes.every((mode) => mode === 'first-primary'));
});

test('別POP相当のKVが古いrecordを返してもD1失効正本で盗難Cookieを拒否する', async () => {
  const current = createEnv();
  const created = await sessionModule.createSession(current, {
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
  });
  const staleReplica = new FakeKv();
  staleReplica.values.set(
    `sf:sessions:${created.sessionId}`,
    current.APP_KV.values.get(`sf:sessions:${created.sessionId}`)
  );

  await sessionModule.destroySession(current, created.sessionId);
  assert.equal(staleReplica.values.has(`sf:sessions:${created.sessionId}`), true);
  assert.equal(
    staleReplica.values.has(`sf:session_revoked:${created.sessionId}`),
    false
  );
  assert.equal(
    await sessionModule.verifySession(
      { APP_KV: staleReplica, DB: current.DB },
      sessionCookie(created)
    ),
    null
  );
});

test('D1 primaryを確認できないverify/touchはKVへfallbackせずfail-closedにする', async () => {
  const env = createEnv();
  const created = await sessionModule.createSession(env, {
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
  });
  const unavailableDb = {
    withSession() {
      throw new Error('raw database failure must not escape');
    },
  };
  const unavailableEnv = { ...env, DB: unavailableDb };

  await assert.rejects(
    sessionModule.verifySession(unavailableEnv, sessionCookie(created)),
    (error) =>
      error?.code === 'session_revocation_store_unavailable' &&
      error?.message === 'session_revocation_store_unavailable'
  );
  const untrackedId = crypto.randomUUID();
  const untrackedRecord = {
    ...created.record,
    id: untrackedId,
    updatedAt: Date.now() - 10 * 60 * 1000,
    lastAccessAt: Date.now() - 10 * 60 * 1000,
  };
  await assert.rejects(
    sessionModule.touchSession(unavailableEnv, untrackedId, untrackedRecord),
    (error) => error?.code === 'session_revocation_store_unavailable'
  );
});

test('touchとlogoutが競合して古いKV recordが再保存されてもD1失効は復活させない', async () => {
  const current = createEnv();
  const sessionId = crypto.randomUUID();
  const sessionKey = 'C'.repeat(43);
  const sessionHash = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sessionKey))
  ).toString('base64url');
  const staleRecord = {
    sessionVersion: 2,
    id: sessionId,
    hash: sessionHash,
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
    createdAt: Date.now() - 60 * 60 * 1000,
    updatedAt: Date.now() - 10 * 60 * 1000,
    lastAccessAt: Date.now() - 10 * 60 * 1000,
  };
  const created = { sessionId, sessionKey, record: staleRecord };
  await current.APP_KV.put(`sf:sessions:${sessionId}`, JSON.stringify(staleRecord));
  let releaseSessionWrite;
  let signalSessionWrite;
  const sessionWriteStarted = new Promise((resolve) => {
    signalSessionWrite = resolve;
  });
  const sessionWriteRelease = new Promise((resolve) => {
    releaseSessionWrite = resolve;
  });
  const staleReplica = new FakeKv();
  staleReplica.values.set(
    `sf:sessions:${created.sessionId}`,
    current.APP_KV.values.get(`sf:sessions:${created.sessionId}`)
  );
  const originalPut = staleReplica.put.bind(staleReplica);
  let paused = false;
  staleReplica.put = async (key, value, options) => {
    if (!paused && key === `sf:sessions:${created.sessionId}`) {
      paused = true;
      signalSessionWrite();
      await sessionWriteRelease;
    }
    return originalPut(key, value, options);
  };
  const touchPromise = sessionModule.touchSession(
    { APP_KV: staleReplica, DB: current.DB },
    created.sessionId,
    staleRecord
  );
  await sessionWriteStarted;
  await sessionModule.destroySession(current, created.sessionId);
  releaseSessionWrite();
  const touched = await touchPromise;

  assert.ok(touched);
  assert.ok(
    staleReplica.puts.some(({ key }) => key === `sf:sessions:${created.sessionId}`)
  );
  assert.equal(staleReplica.values.has(`sf:sessions:${created.sessionId}`), true);
  assert.equal(
    await sessionModule.verifySession(
      { APP_KV: staleReplica, DB: current.DB },
      sessionCookie(created)
    ),
    null
  );
});

test('session失効行は1回100件ずつ期限付きpruneし、有効な失効行を残す', async () => {
  const env = createEnv();
  const statement = env.DB.prepare(
    `INSERT INTO session_revocations (
       session_fingerprint, revoked_at_ms, expires_at_ms
     ) VALUES (?1, ?2, ?3)`
  );
  for (let index = 0; index < 105; index += 1) {
    await statement
      .bind(index.toString(16).padStart(64, '0'), index + 1, index + 2)
      .run();
  }
  const created = await sessionModule.createSession(env, {
    user: { sub: 'subject', email: 'member@example.com', emailVerified: true },
  });

  await sessionModule.destroySession(env, created.sessionId);
  assert.equal(
    env.DB.get(
      'SELECT COUNT(*) AS count FROM session_revocations WHERE expires_at_ms <= ?1',
      Date.now()
    ).count,
    5
  );
  await sessionModule.destroySession(env, created.sessionId);
  assert.equal(
    env.DB.get(
      'SELECT COUNT(*) AS count FROM session_revocations WHERE expires_at_ms <= ?1',
      Date.now()
    ).count,
    0
  );
  assert.equal(env.DB.get('SELECT COUNT(*) AS count FROM session_revocations').count, 1);
});

test('Service Workerは認証APIレスポンスをキャッシュしない', async () => {
  const swSource = await readFile(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(swSource, /API_CACHE/);
  assert.doesNotMatch(swSource, /caches\.open\([^)]*api/i);
  assert.match(swSource, /url\.pathname\.startsWith\('\/api\/'\)/);
});
