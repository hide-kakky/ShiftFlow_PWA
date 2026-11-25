const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 20;
const RATE_LIMIT_TAILS = new Map();

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

function resolveSalt(env) {
  return String(
    env?.AUTH_RATE_LIMIT_SALT ||
      env?.GOOGLE_OAUTH_CLIENT_SECRET ||
      env?.GOOGLE_CLIENT_SECRET ||
      ''
  ).trim();
}

async function withRateLimitKeyLock(key, operation) {
  const previous = RATE_LIMIT_TAILS.get(key) || Promise.resolve();
  const queued = previous.catch(() => undefined).then(operation);
  RATE_LIMIT_TAILS.set(key, queued);
  try {
    return await queued;
  } finally {
    if (RATE_LIMIT_TAILS.get(key) === queued) {
      RATE_LIMIT_TAILS.delete(key);
    }
  }
}

/**
 * /auth/start と /auth/callback の書込み増幅を抑える短時間KV guard。
 * IPはログや値へ保存せず、secret付きSHA-256をkeyにだけ使用する。
 */
export async function checkAuthRateLimit(env, request, options = {}) {
  const windowSeconds = Math.max(10, Number(options.windowSeconds) || DEFAULT_WINDOW_SECONDS);
  const limit = Math.max(1, Number(options.limit) || DEFAULT_LIMIT);
  if (!env?.APP_KV) {
    return { allowed: false, reason: 'rate_limit_store_unavailable' };
  }
  const salt = resolveSalt(env);
  if (!salt) {
    return { allowed: false, reason: 'rate_limit_salt_unavailable' };
  }
  const route = String(options.route || 'auth').replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64);
  const clientAddress = String(
    request?.headers?.get('CF-Connecting-IP') ||
      request?.headers?.get('cf-connecting-ip') ||
      'unknown-client'
  ).trim();
  const now = Date.now();
  const bucket = Math.floor(now / (windowSeconds * 1000));
  const clientHash = await sha256Hex(`${salt}\u0000${clientAddress}`);
  const key = `auth-rate:${route}:${bucket}:${clientHash.slice(0, 32)}`;
  return withRateLimitKeyLock(key, async () => {
    try {
      const currentRaw = await env.APP_KV.get(key);
      const current = Math.max(0, Number.parseInt(String(currentRaw || '0'), 10) || 0);
      if (current >= limit) {
        return { allowed: false, reason: 'rate_limited', retryAfterSeconds: windowSeconds };
      }
      await env.APP_KV.put(key, String(current + 1), {
        expirationTtl: windowSeconds + 5,
      });
      return { allowed: true, remaining: Math.max(0, limit - current - 1) };
    } catch (_error) {
      return { allowed: false, reason: 'rate_limit_store_unavailable' };
    }
  });
}
