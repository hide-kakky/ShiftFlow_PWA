import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequest as getSession } from '../functions/auth/session.js';
import { onRequest as logout } from '../functions/auth/logout.js';
import { onRequest as oauthCallback } from '../functions/auth/callback.js';
import { createSession } from '../functions/utils/session.js';

class FakeKv {
  constructor() {
    this.values = new Map();
    this.deletes = [];
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

async function fixture() {
  const env = { APP_KV: new FakeKv() };
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

test('/auth/logout は正しいCookieだけを破棄し、改ざんCookieではKVを削除しない', async () => {
  const valid = await fixture();
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

test('/auth/callback はstate/PKCE Cookieなしのログイン差し替えを拒否する', async () => {
  const env = { APP_KV: new FakeKv() };
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});
