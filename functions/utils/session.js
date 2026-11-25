const SESSION_COOKIE_NAME = 'SESSION';
const SESSION_NAMESPACE = 'sf:sessions:';
const SESSION_REVOCATION_NAMESPACE = 'sf:session_revoked:';
const SESSION_REVOCATION_STORE_ERROR = 'session_revocation_store_unavailable';
const SESSION_VERSION = 2;
const SESSION_IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_ABSOLUTE_TIMEOUT_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SESSION_TTL_SECONDS = Math.ceil(SESSION_ABSOLUTE_TIMEOUT_MS / 1000);
const SESSION_COOKIE_MAX_AGE_SECONDS = Math.ceil(SESSION_IDLE_TIMEOUT_MS / 1000);
const INIT_NAMESPACE = 'sf:auth_init:';
const INIT_TTL_SECONDS = 60 * 5; // 5 minutes
const MIN_SESSION_WRITE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_REVOCATION_PRUNE_LIMIT = 100;
const SESSION_WRITE_TRACKER = new Map();
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

function toBase64Url(bytes) {
  const binString = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

async function sha256Base64(value) {
  const buffer = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return toBase64Url(digest);
}

async function sha256Hex(value) {
  const buffer = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createRevocationStoreError() {
  const error = new Error(SESSION_REVOCATION_STORE_ERROR);
  error.code = SESSION_REVOCATION_STORE_ERROR;
  return error;
}

function resolvePrimaryD1(env) {
  if (!env?.DB || typeof env.DB.withSession !== 'function') {
    throw createRevocationStoreError();
  }
  try {
    const session = env.DB.withSession('first-primary');
    if (!session || typeof session.prepare !== 'function') {
      throw createRevocationStoreError();
    }
    return session;
  } catch (_error) {
    throw createRevocationStoreError();
  }
}

async function getSessionRevocationFingerprint(sessionId) {
  return sha256Hex(String(sessionId || ''));
}

async function isSessionRevokedInD1(env, sessionId, now = Date.now()) {
  const fingerprint = await getSessionRevocationFingerprint(sessionId);
  const db = resolvePrimaryD1(env);
  try {
    const row = await db
      .prepare(
        `SELECT expires_at_ms
           FROM session_revocations
          WHERE session_fingerprint = ?1
            AND expires_at_ms > ?2
          LIMIT 1`
      )
      .bind(fingerprint, now)
      .first();
    return Boolean(row);
  } catch (_error) {
    throw createRevocationStoreError();
  }
}

async function persistSessionRevocationInD1(env, sessionId, now = Date.now()) {
  const fingerprint = await getSessionRevocationFingerprint(sessionId);
  const expiresAt = now + SESSION_ABSOLUTE_TIMEOUT_MS;
  const db = resolvePrimaryD1(env);
  try {
    await db
      .prepare(
        `INSERT INTO session_revocations (
           session_fingerprint, revoked_at_ms, expires_at_ms
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_fingerprint) DO UPDATE SET
           revoked_at_ms = MIN(session_revocations.revoked_at_ms, excluded.revoked_at_ms),
           expires_at_ms = MAX(session_revocations.expires_at_ms, excluded.expires_at_ms)`
      )
      .bind(fingerprint, now, expiresAt)
      .run();
  } catch (_error) {
    throw createRevocationStoreError();
  }

  // 失効自体は既にprimaryへ確定済み。期限切れ行の整理失敗でlogoutを巻き戻さない。
  try {
    await db
      .prepare(
        `DELETE FROM session_revocations
          WHERE session_fingerprint IN (
            SELECT session_fingerprint
              FROM session_revocations
             WHERE expires_at_ms <= ?1
             ORDER BY expires_at_ms ASC
             LIMIT ?2
          )`
      )
      .bind(now, SESSION_REVOCATION_PRUNE_LIMIT)
      .run();
  } catch (_error) {
    console.warn('[ShiftFlow][Session] Revocation prune failed', {
      code: 'session_revocation_prune_failed',
    });
  }
}

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export function buildSessionCookie(value, opts = {}) {
  const params = [];
  const domain = typeof opts.domain === 'string' ? opts.domain.trim() : '';
  const sameSite = opts.sameSite || 'Lax';
  params.push(`${SESSION_COOKIE_NAME}=${value}`);
  if (domain) params.push(`Domain=${domain}`);
  params.push('Path=/');
  params.push('HttpOnly');
  params.push('Secure');
  params.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge ?? SESSION_COOKIE_MAX_AGE_SECONDS))}`);
  params.push(`SameSite=${sameSite}`);
  return params.join('; ');
}

export function buildExpiredSessionCookie(opts = {}) {
  const domain = typeof opts.domain === 'string' ? opts.domain.trim() : '';
  const sameSite = opts.sameSite || 'Lax';
  const domainPart = domain ? ` Domain=${domain};` : '';
  return `${SESSION_COOKIE_NAME}=;${domainPart} Path=/; HttpOnly; Secure; Max-Age=0; SameSite=${sameSite}`;
}

export function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((acc, item) => {
    const eq = item.indexOf('=');
    if (eq === -1) return acc;
    const key = item.slice(0, eq).trim();
    const val = item.slice(eq + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(val);
    } catch (_err) {
      acc[key] = val;
    }
    return acc;
  }, {});
}

export function parseSessionCookie(cookieHeader) {
  const cookies = parseCookies(cookieHeader || '');
  const raw = cookies[SESSION_COOKIE_NAME];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [id, key] = parts;
  if (!SESSION_ID_PATTERN.test(id) || !SESSION_KEY_PATTERN.test(key)) return null;
  return { id, key };
}

function getExpirationTtlSeconds(record, now = Date.now()) {
  const createdAt = Number(record?.createdAt || now) || now;
  const remainingMs = createdAt + SESSION_ABSOLUTE_TIMEOUT_MS - now;
  return Math.max(1, Math.min(SESSION_TTL_SECONDS, Math.ceil(remainingMs / 1000)));
}

async function persistSessionRecord(env, sessionId, record, now = Date.now()) {
  await env.APP_KV.put(`${SESSION_NAMESPACE}${sessionId}`, JSON.stringify(record), {
    expirationTtl: getExpirationTtlSeconds(record, now),
  });
  markSessionPersisted(sessionId);
  return record;
}

async function isSessionRevokedInKv(env, sessionId) {
  if (!sessionId) return false;
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for session storage.');
  }
  return Boolean(await env.APP_KV.get(`${SESSION_REVOCATION_NAMESPACE}${sessionId}`));
}

async function isSessionRevoked(env, sessionId, now = Date.now()) {
  if (!sessionId) return false;
  // KVのpositive tombstoneは早期拒否にだけ使う。KVに無い場合は必ずD1 primaryを
  // 最終gateとし、読めない場合もacceptへfallbackせずfail-closedにする。
  if (await isSessionRevokedInKv(env, sessionId)) return true;
  return isSessionRevokedInD1(env, sessionId, now);
}

function shouldSkipSessionPersist(sessionId, record, now, forcePersist) {
  if (forcePersist) return false;
  if (!sessionId) return false;
  const persistedAt = Math.max(
    Number(record?.updatedAt || 0) || 0,
    Number(record?.lastAccessAt || 0) || 0
  );
  const last = Math.max(SESSION_WRITE_TRACKER.get(sessionId) || 0, persistedAt);
  return now - last < MIN_SESSION_WRITE_INTERVAL_MS;
}

function markSessionPersisted(sessionId) {
  if (!sessionId) return;
  SESSION_WRITE_TRACKER.set(sessionId, Date.now());
}

export async function persistAuthInit(env, state, payload) {
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for auth init.');
  }
  const key = `${INIT_NAMESPACE}${state}`;
  await env.APP_KV.put(key, JSON.stringify(payload), { expirationTtl: INIT_TTL_SECONDS });
}

export async function consumeAuthInit(env, state) {
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for auth init.');
  }
  const key = `${INIT_NAMESPACE}${state}`;
  const raw = await env.APP_KV.get(key);
  if (!raw) return null;
  await env.APP_KV.delete(key);
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

export async function createSession(env, session) {
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for session storage.');
  }
  const sessionId = session.id || crypto.randomUUID();
  const sessionKey = session.key || toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const record = {
    sessionVersion: SESSION_VERSION,
    id: sessionId,
    hash: await sha256Base64(sessionKey),
    user: session.user || {},
    createdAt: now,
    updatedAt: now,
    lastAccessAt: now,
  };
  await persistSessionRecord(env, sessionId, record, now);
  return { record, sessionId, sessionKey };
}

export async function readSession(env, sessionId) {
  if (!sessionId) return null;
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for session storage.');
  }
  const raw = await env.APP_KV.get(`${SESSION_NAMESPACE}${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

export async function touchSession(env, sessionId, record) {
  if (!sessionId || !record) return;
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for session storage.');
  }
  const now = Date.now();
  const updated = { ...record, updatedAt: now, lastAccessAt: now };
  if (shouldSkipSessionPersist(sessionId, record, now, false)) {
    return updated;
  }
  // throttleでKVを書かない通常経路はverifySessionのfinal gateを再利用する。
  // 実際に古いrecordを書き戻す時だけ、persist直前にD1 primaryを再確認する。
  if (await isSessionRevoked(env, sessionId, now)) return null;
  return persistSessionRecord(env, sessionId, updated, now);
}

export async function destroySession(env, sessionId) {
  if (!sessionId) return;
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for session storage.');
  }

  // 強整合なD1失効を先に確定し、KVは高速な補助tombstone/cleanupとして後から更新する。
  await persistSessionRevocationInD1(env, sessionId);
  let tombstoned = false;
  let deleted = false;
  try {
    await env.APP_KV.put(`${SESSION_REVOCATION_NAMESPACE}${sessionId}`, '1', {
      expirationTtl: SESSION_TTL_SECONDS,
    });
    tombstoned = true;
  } catch (_error) {
    console.warn('[ShiftFlow][Session] KV revocation tombstone failed', {
      code: 'session_kv_tombstone_failed',
    });
  }
  try {
    await env.APP_KV.delete(`${SESSION_NAMESPACE}${sessionId}`);
    deleted = true;
  } catch (_error) {
    console.warn('[ShiftFlow][Session] KV session cleanup failed', {
      code: 'session_kv_cleanup_failed',
    });
  }
  return { revoked: true, tombstoned, deleted };
}

export async function verifySession(env, cookieHeader) {
  const parsed = parseSessionCookie(cookieHeader);
  if (!parsed) return null;
  const { id, key } = parsed;
  const record = await readSession(env, id);
  if (!record || !record.hash) return null;
  const candidateHash = await sha256Base64(key);
  if (candidateHash.length !== record.hash.length) return null;
  let mismatch = 0;
  for (let index = 0; index < candidateHash.length; index += 1) {
    mismatch |= candidateHash.charCodeAt(index) ^ record.hash.charCodeAt(index);
  }
  if (mismatch !== 0) return null;

  // UUIDだけを大量生成する入力でD1 primaryを増幅させない。KV recordと秘密鍵を
  // 検証できたsession候補だけを、返却直前のstrong revocation gateへ通す。
  if (await isSessionRevoked(env, id)) return null;

  let verifiedRecord = record;
  if (Number(record.sessionVersion || 0) < SESSION_VERSION) {
    const legacyPayload = decodeJwt(record?.tokens?.idToken || '');
    const existingEmail = String(record?.user?.email || '').trim().toLowerCase();
    const legacyEmail = String(legacyPayload?.email || existingEmail).trim().toLowerCase();
    const subject = String(record?.user?.sub || legacyPayload?.sub || '').trim();
    const legacyEmailVerified =
      legacyPayload?.email_verified === true ||
      legacyPayload?.email_verified === 'true' ||
      legacyPayload?.email_verified === 1 ||
      legacyPayload?.email_verified === '1';
    if (
      !subject ||
      !legacyEmail ||
      !legacyEmailVerified ||
      (existingEmail && legacyEmail !== existingEmail)
    )
      return null;
    verifiedRecord = {
      ...record,
      sessionVersion: SESSION_VERSION,
      user: {
        ...(record.user || {}),
        sub: subject,
        email: legacyEmail,
        emailVerified: true,
      },
    };
    delete verifiedRecord.tokens;
    await persistSessionRecord(env, id, verifiedRecord);
  }
  return { id, key, record: verifiedRecord };
}

export function decodeJwt(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(parts[1]))
    );
    return payload;
  } catch (_err) {
    return null;
  }
}

export async function createPkcePair() {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = await sha256Base64(verifier);
  return { verifier, challenge };
}

export function isSessionFresh(record) {
  if (!record?.tokens?.idToken || !record.tokens.expiry) return false;
  const now = Date.now();
  return now + 60_000 < Number(record.tokens.expiry);
}

export function calculateIdTokenExpiry(idToken) {
  const payload = decodeJwt(idToken);
  if (!payload || !payload.exp) return null;
  return payload.exp * 1000;
}

export function evaluateSessionTimeout(record, now = Date.now()) {
  if (!record) {
    return { expired: true, reason: 'invalid', idleDeadline: 0, absoluteDeadline: 0 };
  }
  const createdAt = Number(record.createdAt || 0) || 0;
  const lastAccessAt =
    Number(record.lastAccessAt || record.updatedAt || createdAt || 0) || createdAt || 0;
  const idleDeadline = lastAccessAt + SESSION_IDLE_TIMEOUT_MS;
  const absoluteDeadline = createdAt + SESSION_ABSOLUTE_TIMEOUT_MS;
  if (absoluteDeadline <= now) {
    return { expired: true, reason: 'absolute', idleDeadline, absoluteDeadline };
  }
  if (idleDeadline <= now) {
    return { expired: true, reason: 'idle', idleDeadline, absoluteDeadline };
  }
  return { expired: false, reason: null, idleDeadline, absoluteDeadline };
}

export function getSessionCookieMaxAge(record, now = Date.now()) {
  const timeout = evaluateSessionTimeout(record, now);
  if (timeout.expired) return 0;
  const remainingAbsoluteSeconds = Math.floor((timeout.absoluteDeadline - now) / 1000);
  return Math.max(1, Math.min(SESSION_COOKIE_MAX_AGE_SECONDS, remainingAbsoluteSeconds));
}

export {
  SESSION_VERSION,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
};
