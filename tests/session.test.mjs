import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sessionSource = await readFile(
  new URL('../functions/utils/session.js', import.meta.url),
  'utf8'
);
const sessionModule = await import(
  `data:text/javascript;base64,${Buffer.from(sessionSource).toString('base64')}`
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
  return { APP_KV: new FakeKv() };
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
    lastAccessAt: Date.now(),
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

test('Service Workerは認証APIレスポンスをキャッシュしない', async () => {
  const swSource = await readFile(new URL('../frontend/public/sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(swSource, /API_CACHE/);
  assert.doesNotMatch(swSource, /caches\.open\([^)]*api/i);
  assert.match(swSource, /url\.pathname\.startsWith\('\/api\/'\)/);
});
