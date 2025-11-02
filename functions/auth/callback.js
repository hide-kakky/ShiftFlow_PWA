import { loadConfig } from '../api/config';
import {
  consumeAuthInit,
  createSession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  calculateIdTokenExpiry,
  updateSessionTokens,
} from '../utils/session';

const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';

function htmlResponse(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...headers,
    },
  });
}

function renderError(message) {
  const content = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Sign-in error</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;}main{background:rgba(15,23,42,0.75);backdrop-filter:blur(18px);padding:48px;border-radius:28px;box-shadow:0 20px 60px rgba(15,23,42,0.35);max-width:420px;text-align:center;}h1{margin:0 0 12px;font-size:24px;font-weight:600;}p{margin:0 0 20px;line-height:1.7;}a{color:#93c5fd;text-decoration:none;font-weight:600;}a:hover{text-decoration:underline;}</style></head><body><main><h1>サインインに失敗しました</h1><p>${message}</p><a href="/" rel="nofollow">戻る</a></main></body></html>`;
  return htmlResponse(400, content);
}

function pickReturnLocation(candidate, fallback) {
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    return parsed.toString();
  } catch (_err) {
    return fallback;
  }
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const config = loadConfig(env);
  const origin = url.origin;
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') || '認証を完了できませんでした。';
    return renderError(description);
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) {
    return renderError('不正なリクエストです。もう一度お試しください。');
  }

  const initPayload = await consumeAuthInit(env, state);
  if (!initPayload) {
    return renderError('サインイン・セッションが期限切れになりました。再度操作してください。');
  }

  const { codeVerifier, returnTo } = initPayload;
  const clientId = config.googleClientId;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';
  if (!clientId || !clientSecret) {
    return renderError('サーバー設定が不完全です。管理者に連絡してください。');
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
      redirect_uri: `${origin}/auth/callback`,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return renderError(`Google 認証に失敗しました: ${detail}`);
  }

  const tokenPayload = await tokenRes.json();
  const idToken = tokenPayload.id_token;
  if (!idToken) {
    return renderError('Google から ID トークンを受信できませんでした。');
  }

  const tokenInfoRes = await fetch(`${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`);
  if (!tokenInfoRes.ok) {
    const detail = await tokenInfoRes.text();
    return renderError(`ID トークンの検証に失敗しました: ${detail}`);
  }
  const tokenInfo = await tokenInfoRes.json();
  if (tokenInfo.aud !== clientId) {
    return renderError('無効なクライアント ID が指定されました。');
  }
  if (tokenInfo.iss !== 'https://accounts.google.com' && tokenInfo.iss !== 'accounts.google.com') {
    return renderError('無効な発行者からのトークンです。');
  }
  if (tokenInfo.email_verified !== 'true') {
    return renderError('Google アカウントのメールが未確認です。Google アカウント設定を確認してください。');
  }

  const now = Date.now();
  const tokenExpiry =
    calculateIdTokenExpiry(idToken) ||
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

  const destination = pickReturnLocation(returnTo, `${origin}/?auth=done`);
  const headers = {
    Location: destination,
    'Set-Cookie': cookie,
  };

  // Update record with calculated expiry (createSession already persisted but ensure expiry set)
  await updateSessionTokens(env, sessionId, record, sessionData.tokens);

  return new Response(null, {
    status: 302,
    headers,
  });
}
