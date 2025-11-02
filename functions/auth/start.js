import { loadConfig } from '../api/config';
import { createPkcePair, persistAuthInit } from '../utils/session';

function jsonResponse(status, payload, origin) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const config = loadConfig(env);
  const origin = url.origin;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, origin);
  }
  const clientId = config.googleClientId;
  const clientSecret =
    env?.GOOGLE_OAUTH_CLIENT_SECRET ||
    env?.GOOGLE_CLIENT_SECRET ||
    env?.GOOGLE_OAUTH_CLIENT_SECRET_JSON ||
    '';
  if (!clientId || !clientSecret) {
    return jsonResponse(
      500,
      {
        ok: false,
        error: 'Google OAuth credentials are not set. Configure GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
      },
      origin
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_err) {
    body = {};
  }

  let returnTo = typeof body.returnTo === 'string' ? body.returnTo.trim() : '';
  if (!returnTo) {
    returnTo = config.allowedOrigins[0] || origin;
  }
  try {
    const parsedReturn = new URL(returnTo, origin);
    if (parsedReturn.origin !== origin) {
      returnTo = origin;
    } else {
      returnTo = parsedReturn.toString();
    }
  } catch (_err) {
    returnTo = origin;
  }

  const { verifier, challenge } = await createPkcePair();
  const state = crypto.randomUUID().replace(/-/g, '');
  await persistAuthInit(env, state, {
    codeVerifier: verifier,
    issuedAt: Date.now(),
    returnTo,
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
    redirect_uri: `${origin}/auth/callback`,
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
  return jsonResponse(200, { ok: true, authUrl, state }, origin);
}
