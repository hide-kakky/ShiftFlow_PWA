import { loadConfig } from '../api/config.js';
import {
  consumeAuthInit,
  createSession,
  buildSessionCookie,
  parseCookies,
  getSessionCookieMaxAge,
} from '../utils/session.js';
import { verifyGoogleIdToken } from '../utils/googleIdToken.js';
import { recordAuthEvent } from '../utils/auditEvents.js';
import { recordAuthInfrastructureFailure } from '../utils/authDiagnostics.js';
import { checkAuthRateLimit } from '../utils/authRateLimit.js';
import { claimOAuthCallback } from '../utils/oauthCallbackClaim.js';

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

function normalizeRequestId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized)) {
    return normalized;
  }
  return '';
}

function resolveRequestId(request) {
  const received =
    request.headers.get('X-ShiftFlow-Request-Id') ||
    request.headers.get('x-shiftflow-request-id') ||
    '';
  const normalized = normalizeRequestId(received);
  if (normalized) return normalized;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function redirectAuthenticationFailure(env, code, requestId, reasonCode, options = {}) {
  if (options.record !== false) {
    await recordAuthEvent(env, {
      eventType: 'authentication.failed',
      outcome: 'failure',
      reasonCode,
      requestId,
      route: '/auth/callback',
      source: 'oauth_callback',
      authAttemptId: options.authAttemptId || crypto.randomUUID(),
      user: options.user && typeof options.user === 'object' ? options.user : {},
    });
  }
  console.warn('[auth/callback] authentication failed', {
    rid: requestId,
    reasonCode,
  });
  return redirectToSignin(code, requestId);
}

export async function onRequest({ request, env }) {
  const rid = resolveRequestId(request);

  const rateLimit = await checkAuthRateLimit(env, request, {
    route: 'auth_callback',
    limit: 30,
    windowSeconds: 60,
  });
  if (!rateLimit.allowed) {
    console.warn('[auth/callback] request rejected', {
      rid,
      reasonCode: rateLimit.reason,
    });
    const response = redirectToSignin(
      rateLimit.reason === 'rate_limited' ? 'rate' : 'server',
      rid
    );
    if (rateLimit.retryAfterSeconds) {
      response.headers.set('Retry-After', String(rateLimit.retryAfterSeconds));
    }
    return response;
  }

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  console.info('[auth/callback] IN', { rid, hasCode: Boolean(code), hasState: Boolean(state) });
  if (!state) {
    return redirectAuthenticationFailure(
      env,
      'missing',
      rid,
      'oauth_unsolicited_callback',
      { record: false }
    );
  }

  const rawCookies = request.headers.get('Cookie') || '';
  const cookies = parseCookies(rawCookies);
  const stateCookie = cookies.OAUTH_STATE || '';
  const pkceCookie = cookies.PKCE_CODE_VERIFIER || '';

  if (!stateCookie || !pkceCookie) {
    return redirectAuthenticationFailure(
      env,
      'state',
      rid,
      'oauth_unsolicited_callback',
      { record: false }
    );
  }

  if (stateCookie !== state) {
    return redirectAuthenticationFailure(
      env,
      'state',
      rid,
      'oauth_state_validation_failed'
    );
  }

  if (!code) {
    return redirectAuthenticationFailure(
      env,
      'missing',
      rid,
      'oauth_authorization_code_missing'
    );
  }

  let callbackClaim;
  try {
    callbackClaim = await claimOAuthCallback(env, state);
  } catch (_error) {
    console.warn('[auth/callback] callback claim failed', {
      rid,
      reasonCode: 'oauth_callback_claim_unavailable',
    });
    await recordAuthInfrastructureFailure(env, {
      event: 'auth_callback_claim_failed',
      reasonCode: 'oauth_callback_claim_unavailable',
      requestId: rid,
      route: '/auth/callback',
      phase: 'callback_claim',
      httpStatus: 503,
    });
    return redirectAuthenticationFailure(
      env,
      'server',
      rid,
      'oauth_callback_claim_unavailable'
    );
  }
  if (!callbackClaim.claimed) {
    console.warn('[auth/callback] duplicate callback rejected', {
      rid,
      reasonCode: 'oauth_callback_already_claimed',
    });
    return redirectAuthenticationFailure(
      env,
      'state',
      rid,
      'oauth_callback_already_claimed',
      { record: false }
    );
  }

  let initPayload = null;
  try {
    initPayload = await consumeAuthInit(env, state);
  } catch (_error) {
    console.warn('[auth/callback] auth init lookup failed', {
      rid,
      reasonCode: 'oauth_auth_init_lookup_failed',
    });
    await recordAuthInfrastructureFailure(env, {
      event: 'auth_callback_init_lookup_failed',
      reasonCode: 'oauth_auth_init_lookup_unavailable',
      requestId: rid,
      route: '/auth/callback',
      phase: 'auth_init_lookup',
      httpStatus: 503,
    });
    return redirectAuthenticationFailure(
      env,
      'server',
      rid,
      'oauth_auth_init_lookup_unavailable'
    );
  }

  const codeVerifier = pkceCookie;
  const authAttemptId =
    typeof initPayload?.authAttemptId === 'string' && initPayload.authAttemptId.trim()
      ? initPayload.authAttemptId.trim()
      : crypto.randomUUID();
  const returnTo = normalizeReturnPath(initPayload?.returnTo || '/');
  const requestId =
    normalizeRequestId(initPayload?.requestId) ||
    rid;
  const failAuthentication = (codeValue, reasonCode, options = {}) =>
    redirectAuthenticationFailure(env, codeValue, requestId, reasonCode, {
      ...options,
      authAttemptId,
    });

  console.info('[auth/callback] state restored', {
    rid,
    viaCookie: true,
    fromKv: Boolean(initPayload),
    found: Boolean(codeVerifier),
  });

  if (!initPayload) {
    return failAuthentication('state', 'oauth_auth_init_missing');
  }
  if (!codeVerifier || initPayload.codeVerifier !== codeVerifier) {
    return failAuthentication('state', 'oauth_pkce_verifier_mismatch');
  }

  let config;
  try {
    config = loadConfig(env);
  } catch (_error) {
    return failAuthentication('config', 'oauth_configuration_load_failed');
  }
  const clientId = config.googleClientId || env?.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';

  if (!clientId) {
    return failAuthentication('config', 'oauth_client_configuration_missing');
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
  } catch (_error) {
    return failAuthentication('token', 'oauth_token_exchange_unavailable');
  }

  console.info('[auth/callback] token exchange DONE', { rid, status: tokenResponse.status });

  if (!tokenResponse.ok) {
    return failAuthentication('token', 'oauth_token_exchange_rejected');
  }

  let tokenPayload;
  try {
    tokenPayload = await tokenResponse.json();
  } catch (_error) {
    return failAuthentication('token', 'oauth_token_response_invalid');
  }

  const idToken = tokenPayload.id_token;
  if (!idToken) {
    return failAuthentication('token', 'oauth_id_token_missing');
  }

  let tokenInfo;
  try {
    tokenInfo = await verifyGoogleIdToken(env, config, idToken);
  } catch (_error) {
    return failAuthentication('verify', 'oauth_id_token_verification_failed');
  }

  console.info('[auth/callback] id_token verify', {
    rid,
    ok: true,
  });

  if (!tokenInfo.emailVerified || !tokenInfo.sub || !tokenInfo.email) {
    return failAuthentication('verify', 'oauth_verified_identity_incomplete');
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

  let createdSession;
  try {
    createdSession = await createSession(env, sessionData);
  } catch (_error) {
    return failAuthentication('session', 'oauth_session_creation_failed', {
      user: sessionData.user,
    });
  }
  const { sessionId, sessionKey, record } = createdSession;

  await recordAuthEvent(env, {
    eventType: 'authentication.succeeded',
    outcome: 'success',
    reasonCode: 'google_oauth_verified',
    requestId,
    route: '/auth/callback',
    source: 'oauth_callback',
    authAttemptId,
    sessionId,
    user: sessionData.user,
  });

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
    cookie: 'SESSION; HostOnly=true; Path=/; HttpOnly; Secure; SameSite=Lax',
    requestId,
  });

  return new Response(null, { status: 302, headers });
}
