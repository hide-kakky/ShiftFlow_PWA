import { loadConfig } from '../api/config.js';
import {
  consumeAuthInit,
  createSession,
  buildSessionCookie,
  parseCookies,
  getSessionCookieMaxAge,
} from '../utils/session.js';
import { verifyGoogleIdToken } from '../utils/googleIdToken.js';

const CANONICAL_DOMAIN = 'shiftflow.pages.dev';
const CALLBACK_URL = `https://${CANONICAL_DOMAIN}/auth/callback`;

function expireCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function expireLegacyDomainCookie(name) {
  return `${name}=; Domain=${CANONICAL_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function normalizeReturnPath(rawValue) {
  const fallback = '/';
  if (!rawValue) return fallback;
  const MAX_LENGTH = 1024;
  const trimmed = rawValue.trim();
  if (!trimmed) return fallback;
  try {
    const resolved = new URL(trimmed, `https://${CANONICAL_DOMAIN}`);
    if (resolved.hostname !== CANONICAL_DOMAIN) {
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

function buildSigninErrorPath(code, requestId) {
  const params = new URLSearchParams();
  if (code) params.set('e', code);
  if (requestId) params.set('req', requestId);
  const query = params.toString();
  return query ? `/signin?${query}` : '/signin';
}

function redirect(path) {
  const headers = new Headers({ Location: path });
  headers.append('Set-Cookie', expireCookie('OAUTH_STATE'));
  headers.append('Set-Cookie', expireCookie('PKCE_CODE_VERIFIER'));
  headers.append('Set-Cookie', expireLegacyDomainCookie('OAUTH_STATE'));
  headers.append('Set-Cookie', expireLegacyDomainCookie('PKCE_CODE_VERIFIER'));
  return new Response(null, { status: 302, headers });
}

function redirectToSignin(code, requestId) {
  return redirect(buildSigninErrorPath(code, requestId));
}

export async function onRequest({ request, env }) {
  const rid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  console.info('[auth/callback] IN', { rid, hasCode: Boolean(code), hasState: Boolean(state) });
  if (!code || !state) {
    return redirectToSignin('missing', rid);
  }

  const rawCookies = request.headers.get('Cookie') || '';
  const cookies = parseCookies(rawCookies);
  const stateCookie = cookies.OAUTH_STATE || '';
  const pkceCookie = cookies.PKCE_CODE_VERIFIER || '';

  if (!stateCookie || !pkceCookie || stateCookie !== state) {
    console.warn('[auth/callback] state cookie validation failed', {
      rid,
      hasStateCookie: Boolean(stateCookie),
      hasPkceCookie: Boolean(pkceCookie),
    });
    return redirectToSignin('state', rid);
  }

  let initPayload = null;
  try {
    initPayload = await consumeAuthInit(env, state);
  } catch (err) {
    console.error('[auth/callback] consumeAuthInit failed', {
      rid,
      message: err && err.message ? err.message : String(err),
    });
  }

  const viaCookie = true;
  const codeVerifier = pkceCookie;
  const returnTo = normalizeReturnPath(initPayload?.returnTo || '/');
  const requestId =
    (initPayload && typeof initPayload.requestId === 'string' && initPayload.requestId.trim()) ||
    rid;

  console.info('[auth/callback] state restored', {
    rid,
    viaCookie,
    fromKv: Boolean(initPayload),
    found: Boolean(codeVerifier),
  });

  if (!codeVerifier) {
    return redirectToSignin('state', requestId);
  }

  const config = loadConfig(env);
  const clientId = config.googleClientId || env?.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';

  if (!clientId) {
    console.error('[auth/callback] missing clientId', { rid });
    return redirectToSignin('config', requestId);
  }

  console.info('[auth/callback] token exchange START', { rid });

  let tokenResponse;
  try {
    tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code,
        code_verifier: codeVerifier,
        grant_type: 'authorization_code',
        redirect_uri: CALLBACK_URL,
      }),
    });
  } catch (err) {
    console.error('[auth/callback] token exchange failed (network)', {
      rid,
      message: err && err.message ? err.message : String(err),
    });
    return redirectToSignin('token', requestId);
  }

  console.info('[auth/callback] token exchange DONE', { rid, status: tokenResponse.status });

  if (!tokenResponse.ok) {
    let detail = '';
    try {
      detail = (await tokenResponse.text()).slice(0, 200);
    } catch (_err) {
      detail = '';
    }
    console.error('[auth/callback] token exchange error', { rid, status: tokenResponse.status, detail });
    return redirectToSignin('token', requestId);
  }

  let tokenPayload;
  try {
    tokenPayload = await tokenResponse.json();
  } catch (err) {
    console.error('[auth/callback] token payload parse failed', {
      rid,
      message: err && err.message ? err.message : String(err),
    });
    return redirectToSignin('token', requestId);
  }

  const idToken = tokenPayload.id_token;
  if (!idToken) {
    console.error('[auth/callback] missing id_token', { rid });
    return redirectToSignin('token', requestId);
  }

  let tokenInfo;
  try {
    tokenInfo = await verifyGoogleIdToken(env, config, idToken);
  } catch (err) {
    console.warn('[auth/callback] id_token verify failed', {
      rid,
      message: err && err.message ? err.message : String(err),
    });
    return redirectToSignin('verify', requestId);
  }

  console.info('[auth/callback] id_token verify', {
    rid,
    ok: true,
    aud: tokenInfo.aud,
    iss: tokenInfo.iss,
    hd: tokenInfo.hd || '',
    exp: tokenInfo.exp || null,
  });

  if (!tokenInfo.emailVerified || !tokenInfo.sub || !tokenInfo.email) {
    console.warn('[auth/callback] verified identity is incomplete', {
      rid,
      hasSubject: Boolean(tokenInfo.sub),
      hasEmail: Boolean(tokenInfo.email),
      emailVerified: Boolean(tokenInfo.emailVerified),
    });
    return redirectToSignin('verify', requestId);
  }

  const sessionData = {
    user: {
      sub: tokenInfo.sub,
      email: tokenInfo.email,
      emailVerified: true,
      name: tokenInfo.name || tokenInfo.given_name || tokenInfo.email,
      picture: tokenInfo.picture || '',
    },
  };

  const { sessionId, sessionKey, record } = await createSession(env, sessionData);

  const sessionValue = `${sessionId}.${sessionKey}`;
  const sessionCookie = buildSessionCookie(sessionValue, {
    maxAge: getSessionCookieMaxAge(record),
    sameSite: 'Lax',
  });

  const destination = `https://${CANONICAL_DOMAIN}${returnTo}`;
  const headers = new Headers({ Location: destination });
  headers.append('Set-Cookie', sessionCookie);
  headers.append('Set-Cookie', expireLegacyDomainCookie('SESSION'));
  headers.append('Set-Cookie', expireCookie('OAUTH_STATE'));
  headers.append('Set-Cookie', expireCookie('PKCE_CODE_VERIFIER'));
  headers.append('Set-Cookie', expireLegacyDomainCookie('OAUTH_STATE'));
  headers.append('Set-Cookie', expireLegacyDomainCookie('PKCE_CODE_VERIFIER'));

  console.info('[auth/callback] session COOKIE SET -> redirect', {
    rid,
    destination,
    cookie: `SESSION; Domain=${CANONICAL_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    requestId,
  });

  return new Response(null, { status: 302, headers });
}
