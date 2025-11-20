import { loadConfig } from '../api/config';
import { createPkcePair, persistAuthInit } from '../utils/session';

const CANONICAL_DOMAIN = 'shiftflow.pages.dev';
const CALLBACK_URL = `https://${CANONICAL_DOMAIN}/auth/callback`;
const COOKIE_MAX_AGE = 60 * 5; // 5 minutes

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
    `Domain=${CANONICAL_DOMAIN}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=None',
  ];
  if (typeof maxAge === 'number') {
    parts.push(`Max-Age=${maxAge}`);
  }
  return parts.join('; ');
}

export async function onRequest({ request, env }) {
  const requestUrl = new URL(request.url);
  const config = loadConfig(env);
  const clientId = config.googleClientId || env?.GOOGLE_OAUTH_CLIENT_ID || '';
  const requestId = resolveRequestId(request);
  if (!clientId) {
    const headers = new Headers({ Location: buildSigninErrorPath('config', requestId) });
    return new Response(null, { status: 302, headers });
  }
  const { verifier, challenge } = await createPkcePair();
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
    });
  } catch (err) {
    console.error('[auth/start] persistAuthInit failed', {
      rid: requestId,
      message: err && err.message ? err.message : String(err),
    });
    const headers = new Headers({ Location: buildSigninErrorPath('server', requestId) });
    return new Response(null, { status: 302, headers });
  }

  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CALLBACK_URL,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

  const headers = new Headers({ Location: authUrl });
  headers.append('Set-Cookie', cookie('OAUTH_STATE', state, { maxAge: COOKIE_MAX_AGE }));
  headers.append(
    'Set-Cookie',
    cookie('PKCE_CODE_VERIFIER', verifier, { maxAge: COOKIE_MAX_AGE })
  );

  console.info('[auth/start] 302 -> google; cookies issued', {
    rid: requestId,
    stateLength: state.length,
    verifierLength: verifier.length,
    returnTo,
  });

  return new Response(null, { status: 302, headers });
}
