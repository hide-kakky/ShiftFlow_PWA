const SESSION_COOKIE_NAME = 'SESSION';
const SESSION_NAMESPACE = 'sf:sessions:';
const SESSION_IDLE_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_TTL_SECONDS = Math.ceil(SESSION_ABSOLUTE_TIMEOUT_MS / 1000);
const INIT_NAMESPACE = 'sf:auth_init:';
const INIT_TTL_SECONDS = 60 * 5; // 5 minutes
const DEFAULT_COOKIE_DOMAIN = 'shiftflow.pages.dev';

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

export function getSessionCookieName() {
  return SESSION_COOKIE_NAME;
}

export function buildSessionCookie(value, opts = {}) {
  const params = [];
  const domain = opts.domain || DEFAULT_COOKIE_DOMAIN;
  const sameSite = opts.sameSite || 'None';
  params.push(`${SESSION_COOKIE_NAME}=${value}`);
  params.push(`Domain=${domain}`);
  params.push('Path=/');
  params.push('HttpOnly');
  params.push('Secure');
  params.push(`Max-Age=${opts.maxAge ?? SESSION_TTL_SECONDS}`);
  params.push(`SameSite=${sameSite}`);
  return params.join('; ');
}

export function buildExpiredSessionCookie(opts = {}) {
  const domain = opts.domain || DEFAULT_COOKIE_DOMAIN;
  const sameSite = opts.sameSite || 'None';
  return `${SESSION_COOKIE_NAME}=; Domain=${domain}; Path=/; HttpOnly; Secure; Max-Age=0; SameSite=${sameSite}`;
}

export function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((acc, item) => {
    const eq = item.indexOf('=');
    if (eq === -1) return acc;
    const key = item.slice(0, eq).trim();
    const val = item.slice(eq + 1).trim();
    if (key) acc[key] = decodeURIComponent(val);
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
  if (!id || !key) return null;
  return { id, key };
}

export async function persistAuthInit(env, state, payload) {
  if (!env?.APP_KV) {
    throw new Error('APP_KV binding is required for auth init.');
  }
  const key = `${INIT_NAMESPACE}${state}`;
  await env.APP_KV.put(key, JSON.stringify(payload), { expirationTtl: INIT_TTL_SECONDS });
}

export async function consumeAuthInit(env, state) {
  if (!env?.APP_KV) return null;
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
    id: sessionId,
    hash: await sha256Base64(sessionKey),
    user: session.user || {},
    tokens: session.tokens || {},
    createdAt: now,
    updatedAt: now,
    lastAccessAt: now,
  };
  await env.APP_KV.put(`${SESSION_NAMESPACE}${sessionId}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return { record, sessionId, sessionKey };
}

export async function readSession(env, sessionId) {
  if (!env?.APP_KV) return null;
  const raw = await env.APP_KV.get(`${SESSION_NAMESPACE}${sessionId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

export async function touchSession(env, sessionId, record) {
  if (!env?.APP_KV || !sessionId || !record) return;
  const now = Date.now();
  const updated = { ...record, updatedAt: now, lastAccessAt: now };
  await env.APP_KV.put(`${SESSION_NAMESPACE}${sessionId}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return updated;
}

export async function destroySession(env, sessionId) {
  if (!env?.APP_KV || !sessionId) return;
  await env.APP_KV.delete(`${SESSION_NAMESPACE}${sessionId}`);
}

export async function verifySession(env, cookieHeader) {
  const parsed = parseSessionCookie(cookieHeader);
  if (!parsed) return null;
  const { id, key } = parsed;
  const record = await readSession(env, id);
  if (!record || !record.hash) return null;
  const candidateHash = await sha256Base64(key);
  if (candidateHash !== record.hash) return null;
  return { id, key, record };
}

export async function updateSessionTokens(env, sessionId, record, tokens) {
  if (!env?.APP_KV || !sessionId || !record) return;
  const now = Date.now();
  const updated = {
    ...record,
    tokens: { ...(record.tokens || {}), ...tokens, updatedAt: now },
    updatedAt: now,
    lastAccessAt: now,
  };
  await env.APP_KV.put(`${SESSION_NAMESPACE}${sessionId}`, JSON.stringify(updated), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return updated;
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

export {
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
};

export async function refreshGoogleTokens(env, refreshToken) {
  const clientId = env?.GOOGLE_OAUTH_CLIENT_ID || env?.GOOGLE_CLIENT_ID || '';
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth client credentials are not configured.');
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Failed to refresh Google tokens: ${detail}`);
  }
  return res.json();
}
