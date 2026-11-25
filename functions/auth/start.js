import { loadConfig } from '../api/config.js';
import { createPkcePair, persistAuthInit } from '../utils/session.js';
import { recordAuthEvent } from '../utils/auditEvents.js';
import { recordAuthInfrastructureFailure } from '../utils/authDiagnostics.js';
import { checkAuthRateLimit } from '../utils/authRateLimit.js';

const CANONICAL_DOMAIN = 'shiftflow.pages.dev';
const CALLBACK_URL = `https://${CANONICAL_DOMAIN}/auth/callback`;
const COOKIE_MAX_AGE = 60 * 5; // 5 minutes

function resolveRequestId(request) {
  const header =
    request.headers.get('X-ShiftFlow-Request-Id') ||
    request.headers.get('x-shiftflow-request-id') ||
    '';
  const trimmed = header.trim();
  if (trimmed && trimmed.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(trimmed)) return trimmed;
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
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

function cookie(name, value, { maxAge } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${maxAge}`);
  }
  return parts.join('; ');
}

async function recordStartFailure(env, requestId, reasonCode, authAttemptId) {
  await recordAuthEvent(env, {
    eventType: 'authentication.failed',
    outcome: 'failure',
    reasonCode,
    requestId,
    route: '/auth/start',
    source: 'oauth_start',
    authAttemptId,
  });
  await recordAuthInfrastructureFailure(env, {
    event: 'auth_start_failed',
    reasonCode,
    requestId,
    route: '/auth/start',
    phase: 'oauth_start',
    httpStatus: 503,
  });
}

export async function onRequest({ request, env }) {
  const requestUrl = new URL(request.url);
  const requestId = resolveRequestId(request);
  const authAttemptId = crypto.randomUUID();
  const rateLimit = await checkAuthRateLimit(env, request, {
    route: 'auth_start',
    limit: 20,
    windowSeconds: 60,
  });
  if (!rateLimit.allowed) {
    console.warn('[auth/start] request rejected', {
      rid: requestId,
      reasonCode: rateLimit.reason,
    });
    const errorCode = rateLimit.reason === 'rate_limited' ? 'rate' : 'server';
    const headers = new Headers({ Location: buildSigninErrorPath(errorCode, requestId) });
    if (rateLimit.retryAfterSeconds) {
      headers.set('Retry-After', String(rateLimit.retryAfterSeconds));
    }
    return new Response(null, { status: 302, headers });
  }
  let config;
  try {
    config = loadConfig(env);
  } catch (_error) {
    await recordStartFailure(env, requestId, 'oauth_configuration_load_failed', authAttemptId);
    const headers = new Headers({ Location: buildSigninErrorPath('config', requestId) });
    return new Response(null, { status: 302, headers });
  }
  const clientId = config.googleClientId || env?.GOOGLE_OAUTH_CLIENT_ID || '';
  if (!clientId) {
    await recordStartFailure(env, requestId, 'oauth_client_configuration_missing', authAttemptId);
    const headers = new Headers({ Location: buildSigninErrorPath('config', requestId) });
    return new Response(null, { status: 302, headers });
  }
  let verifier;
  let challenge;
  try {
    const pair = await createPkcePair();
    verifier = pair.verifier;
    challenge = pair.challenge;
  } catch (_error) {
    await recordStartFailure(env, requestId, 'oauth_pkce_generation_failed', authAttemptId);
    const headers = new Headers({ Location: buildSigninErrorPath('server', requestId) });
    return new Response(null, { status: 302, headers });
  }
  const state = crypto.randomUUID().replace(/-/g, '');
  let returnToInput =
    requestUrl.searchParams.get('returnTo') || requestUrl.searchParams.get('return_to') || '';
  if (!returnToInput && request.method === 'POST') {
    try {
      const body = await request.clone().json();
      if (body && typeof body.returnTo === 'string') {
        returnToInput = body.returnTo;
      }
    } catch (_err) {
      // ignore body parse errors
    }
  }
  const returnTo = normalizeReturnPath(returnToInput) || '/';

  try {
    await persistAuthInit(env, state, {
      codeVerifier: verifier,
      issuedAt: Date.now(),
      returnTo,
      requestId,
      authAttemptId,
    });
  } catch (err) {
    console.error('[auth/start] persistAuthInit failed', {
      rid: requestId,
      reasonCode: 'oauth_auth_init_persist_failed',
    });
    await recordStartFailure(env, requestId, 'oauth_auth_init_persist_failed', authAttemptId);
    const headers = new Headers({ Location: buildSigninErrorPath('server', requestId) });
    return new Response(null, { status: 302, headers });
  }

  const scopes = [
    'openid',
    'email',
    'profile',
  ];

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

  const headers = new Headers({ Location: authUrl });
  headers.append(
    'Set-Cookie',
    `OAUTH_STATE=; Domain=${CANONICAL_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  headers.append(
    'Set-Cookie',
    `PKCE_CODE_VERIFIER=; Domain=${CANONICAL_DOMAIN}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  headers.append('Set-Cookie', cookie('OAUTH_STATE', state, { maxAge: COOKIE_MAX_AGE }));
  headers.append(
    'Set-Cookie',
    cookie('PKCE_CODE_VERIFIER', verifier, { maxAge: COOKIE_MAX_AGE })
  );

  console.info('[auth/start] 302 -> google; cookies issued', {
    rid: requestId,
    stateLength: state.length,
    verifierLength: verifier.length,
    returnPathLength: returnTo.length,
  });

  return new Response(null, { status: 302, headers });
}
