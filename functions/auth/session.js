import {
  verifySession,
  touchSession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  refreshGoogleTokens,
  calculateIdTokenExpiry,
  updateSessionTokens,
} from '../utils/session';

function jsonResponse(status, payload, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      ...extraHeaders,
    },
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = url.origin;
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'GET') {
    return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, origin);
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const verified = await verifySession(env, cookieHeader);
  if (!verified) {
    return jsonResponse(
      200,
      { ok: true, authenticated: false },
      origin,
      { 'Set-Cookie': buildExpiredSessionCookie() }
    );
  }

  let tokens = verified.record.tokens || {};
  const now = Date.now();
  let updatedRecord = verified.record;
  let setCookieHeader = '';

  const expiresAt = Number(tokens.expiry || 0);
  const refreshToken = tokens.refreshToken || '';
  const shouldRefresh = !!refreshToken && (!expiresAt || expiresAt <= now + 60_000);

  if (shouldRefresh) {
    try {
      const refreshed = await refreshGoogleTokens(env, refreshToken);
      const newIdToken = refreshed.id_token || tokens.idToken;
      const newExpiry =
        calculateIdTokenExpiry(newIdToken) || (refreshed.expires_in ? now + refreshed.expires_in * 1000 : now + 3600 * 1000);
      const mergedTokens = {
        ...tokens,
        idToken: newIdToken,
        accessToken: refreshed.access_token || tokens.accessToken || '',
        expiry: newExpiry,
        scope: refreshed.scope || tokens.scope || '',
        updatedAt: now,
      };
      updatedRecord = await updateSessionTokens(env, verified.id, verified.record, mergedTokens);
      tokens = mergedTokens;
    } catch (err) {
      console.warn('[ShiftFlow][Auth] Failed to refresh Google tokens', err);
    }
  } else {
    await touchSession(env, verified.id, verified.record);
  }

  const cookieValue = `${verified.id}.${verified.key}`;
  setCookieHeader = buildSessionCookie(cookieValue);

  const user = updatedRecord.user || {};
  return jsonResponse(
    200,
    {
      ok: true,
      authenticated: true,
      user: {
        email: user.email || '',
        name: user.name || '',
        picture: user.picture || '',
      },
      expiresAt: Number(tokens.expiry || 0),
    },
    origin,
    { 'Set-Cookie': setCookieHeader }
  );
}
