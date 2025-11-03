import { loadConfig } from '../api/config';
import { createPkcePair, persistAuthInit } from '../utils/session';

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

function jsonResponse(status, payload, origin, requestId) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  };
  if (requestId) {
    headers['X-ShiftFlow-Request-Id'] = requestId;
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function errorResponse(status, origin, requestId, code, reason) {
  return jsonResponse(
    status,
    {
      ok: false,
      where: 'auth-start',
      code,
      reason,
      requestId,
    },
    origin,
    requestId
  );
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
  const requestId = resolveRequestId(request);
  const config = loadConfig(env);
  const origin = url.origin;
  const allowedOrigins = Array.isArray(config.allowedOrigins)
    ? config.allowedOrigins.filter(Boolean)
    : [];
  const isOriginAllowed = allowedOrigins.includes(origin);
  const redirectBase = isOriginAllowed ? origin : allowedOrigins[0] || origin;
  const normalizedBase = redirectBase.replace(/\/+$/, '');
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-ShiftFlow-Request-Id': requestId,
      },
    });
  }
  if (request.method !== 'POST') {
    return errorResponse(405, origin, requestId, 'method_not_allowed', 'Method Not Allowed');
  }
  const clientId = config.googleClientId;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';
  if (!clientId || !clientSecret) {
    return errorResponse(
      500,
      origin,
      requestId,
      'oauth_config_missing',
      'Google OAuth credentials are not configured. Configure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.'
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_err) {
    body = {};
  }
  const rawReturn = typeof body.returnTo === 'string' ? body.returnTo : '';
  const normalizedReturnPath = normalizeReturnPath(rawReturn || '/', normalizedBase);
  console.info('[ShiftFlow][Auth]', 'Return path normalized', {
    where: 'auth-start',
    normalizedReturn: normalizedReturnPath,
    requestId,
  });

  const { verifier, challenge } = await createPkcePair();
  const state = crypto.randomUUID().replace(/-/g, '');
  await persistAuthInit(env, state, {
    codeVerifier: verifier,
    issuedAt: Date.now(),
    returnTo: normalizedReturnPath,
    requestId,
  });

  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${normalizedBase}/auth/callback`,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return jsonResponse(
    200,
    { ok: true, authUrl, state, requestId },
    origin,
    requestId
  );
}
