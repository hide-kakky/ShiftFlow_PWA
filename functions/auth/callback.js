import { loadConfig } from '../api/config';
import {
  consumeAuthInit,
  createSession,
  buildSessionCookie,
  calculateIdTokenExpiry,
  updateSessionTokens,
} from '../utils/session';
import { verifyGoogleIdToken } from '../utils/googleIdToken';
import { resolveCallbackUrl } from '../utils/redirect';

function resolveRequestId(request) {
  const header =
    request.headers.get('X-ShiftFlow-Request-Id') ||
    request.headers.get('x-shiftflow-request-id') ||
    '';
  const trimmed = header.trim();
  if (trimmed) return trimmed;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function htmlResponse(status, body, requestId, headers = {}) {
  const finalHeaders = {
    'Content-Type': 'text/html; charset=utf-8',
    ...headers,
  };
  if (requestId) {
    finalHeaders['X-ShiftFlow-Request-Id'] = requestId;
  }
  return new Response(body, {
    status,
    headers: finalHeaders,
  });
}

function renderError(message, requestId) {
  const content = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Sign-in error</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;}main{background:rgba(15,23,42,0.75);backdrop-filter:blur(18px);padding:48px;border-radius:28px;box-shadow:0 20px 60px rgba(15,23,42,0.35);max-width:420px;text-align:center;}h1{margin:0 0 12px;font-size:24px;font-weight:600;}p{margin:0 0 20px;line-height:1.7;}a{color:#93c5fd;text-decoration:none;font-weight:600;}a:hover{text-decoration:underline;}</style></head><body><main><h1>サインインに失敗しました</h1><p>${message}</p><a href="/" rel="nofollow">戻る</a></main></body></html>`;
  return htmlResponse(400, content, requestId);
}

function normalizeReturnPath(rawValue, baseOrigin) {
  const fallback = '/';
  if (!baseOrigin) return fallback;
  const MAX_LENGTH = 1024;
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  const base = baseOrigin.replace(/\/+$/, '');
  if (!trimmed) return fallback;
  try {
    const resolved = new URL(trimmed, base);
    if (resolved.origin !== base) {
      return fallback;
    }
    let candidate = (resolved.pathname || '/') + (resolved.search || '') + (resolved.hash || '');
    if (!candidate.startsWith('/')) {
      return fallback;
    }
    if (candidate.length > MAX_LENGTH) {
      return fallback;
    }
    return candidate;
  } catch (_err) {
    if (trimmed.startsWith('/') && trimmed.length <= MAX_LENGTH) {
      return trimmed;
    }
    return fallback;
  }
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const config = loadConfig(env);
  const origin = url.origin;
  const callbackUrl = resolveCallbackUrl(origin, config);
  let requestId = resolveRequestId(request);
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') || '認証を完了できませんでした。';
    return renderError(description, requestId);
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) {
    return renderError('不正なリクエストです。もう一度お試しください。', requestId);
  }

  const initPayload = await consumeAuthInit(env, state);
  if (!initPayload) {
    console.warn('[ShiftFlow][Auth]', 'State payload not found or already consumed', {
      where: 'auth-callback',
      requestId,
    });
    return renderError('サインイン・セッションが期限切れになりました。再度操作してください。', requestId);
  }

  if (initPayload.requestId && typeof initPayload.requestId === 'string') {
    const trimmed = initPayload.requestId.trim();
    if (trimmed) {
      requestId = trimmed;
    }
  }

  const { codeVerifier, returnTo } = initPayload;
  if (!codeVerifier) {
    console.warn('[ShiftFlow][Auth]', 'Missing code verifier in state payload', {
      where: 'auth-callback',
      requestId,
    });
    return renderError('サインイン・セッションが無効です。もう一度お試しください。', requestId);
  }
  const clientId = config.googleClientId;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';
  if (!clientId || !clientSecret) {
    return renderError('サーバー設定が不完全です。管理者に連絡してください。', requestId);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrl,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return renderError(`Google 認証に失敗しました: ${detail}`, requestId);
  }

  const tokenPayload = await tokenRes.json();
  const idToken = tokenPayload.id_token;
  if (!idToken) {
    return renderError('Google から ID トークンを受信できませんでした。', requestId);
  }

  let tokenInfo;
  try {
    tokenInfo = await verifyGoogleIdToken(env, config, idToken);
  } catch (err) {
    console.warn('[ShiftFlow][Auth]', 'ID token verification failed', {
      where: 'auth-callback',
      requestId,
      message: err && err.message ? err.message : String(err),
    });
    return renderError(
      err && err.message ? err.message : 'ID トークンの検証に失敗しました。',
      requestId
    );
  }

  const now = Date.now();
  const tokenExpiry =
    calculateIdTokenExpiry(idToken) ||
    (tokenInfo.exp ? Number(tokenInfo.exp) * 1000 : null) ||
    (typeof tokenPayload.expires_in === 'number'
      ? now + Number(tokenPayload.expires_in) * 1000
      : now + 3600 * 1000);

  const sessionData = {
    user: {
      email: tokenInfo.email,
      name: tokenInfo.name || tokenInfo.given_name || tokenInfo.email,
      picture: tokenInfo.picture || '',
    },
    tokens: {
      idToken,
      accessToken: tokenPayload.access_token || '',
      refreshToken: tokenPayload.refresh_token || '',
      scope: tokenPayload.scope || '',
      expiry: tokenExpiry,
      issuedAt: now,
    },
  };

  const { sessionId, sessionKey, record } = await createSession(env, sessionData);
  const cookieValue = `${sessionId}.${sessionKey}`;
  const cookie = buildSessionCookie(cookieValue);

  const normalizedReturnPath = normalizeReturnPath(returnTo || '/', origin);
  const normalizedBase = callbackUrl.replace(/\/auth\/callback$/, '');
  console.info('[ShiftFlow][Auth]', 'Return path normalized', {
    where: 'auth-callback',
    normalizedReturn: normalizedReturnPath,
    requestId,
  });
  const destination = normalizedBase + normalizedReturnPath;
  const headers = {
    Location: destination,
    'Set-Cookie': cookie,
    'X-ShiftFlow-Request-Id': requestId,
  };

  // Update record with calculated expiry (createSession already persisted but ensure expiry set)
  await updateSessionTokens(env, sessionId, record, sessionData.tokens);

  return new Response(null, {
    status: 302,
    headers,
  });
}
