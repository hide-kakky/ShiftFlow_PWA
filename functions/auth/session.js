import {
  verifySession,
  touchSession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  refreshGoogleTokens,
  calculateIdTokenExpiry,
  updateSessionTokens,
  destroySession,
  evaluateSessionTimeout,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
} from '../utils/session';

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

function jsonResponse(status, payload, origin, requestId, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    ...extraHeaders,
  };
  if (requestId) {
    headers['X-ShiftFlow-Request-Id'] = requestId;
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const origin = url.origin;
  const requestId = resolveRequestId(request);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-ShiftFlow-Request-Id': requestId,
      },
    });
  }
  if (request.method !== 'GET') {
    return jsonResponse(
      405,
      {
        ok: false,
        where: 'auth-session',
        code: 'method_not_allowed',
        reason: 'Method Not Allowed',
        requestId,
      },
      origin,
      requestId
    );
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const verified = await verifySession(env, cookieHeader);
  if (!verified) {
    return jsonResponse(
      200,
      {
        ok: true,
        authenticated: false,
        reason: 'no_session',
        requestId,
        session: {
          idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
          absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
        },
      },
      origin,
      requestId,
      { 'Set-Cookie': buildExpiredSessionCookie() }
    );
  }

  const now = Date.now();
  const timeoutCheck = evaluateSessionTimeout(verified.record, now);
  if (timeoutCheck.expired) {
    const reasonCode = timeoutCheck.reason === 'absolute' ? 'absolute_timeout' : 'idle_timeout';
    console.info('[ShiftFlow][Auth] Session expired', {
      where: 'session',
      requestId,
      reason: timeoutCheck.reason,
      sessionId: verified.id,
      idleDeadline: timeoutCheck.idleDeadline,
      absoluteDeadline: timeoutCheck.absoluteDeadline,
    });
    await destroySession(env, verified.id);
    return jsonResponse(
      200,
      {
        ok: true,
        authenticated: false,
        reason: reasonCode,
        requestId,
        session: {
          idleDeadline: timeoutCheck.idleDeadline,
          absoluteDeadline: timeoutCheck.absoluteDeadline,
          idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
          absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
        },
      },
      origin,
      requestId,
      { 'Set-Cookie': buildExpiredSessionCookie() }
    );
  }

  let updatedRecord = verified.record;
  let tokens = updatedRecord.tokens || {};
  let setCookieHeader = '';

  const expiresAt = Number(tokens.expiry || 0);
  const refreshToken = tokens.refreshToken || '';
  const shouldRefresh = !!refreshToken && (!expiresAt || expiresAt <= now + 60_000);

  if (shouldRefresh) {
    try {
      const refreshed = await refreshGoogleTokens(env, refreshToken);
      const newIdToken = refreshed.id_token || tokens.idToken;
      const newExpiry =
        calculateIdTokenExpiry(newIdToken) ||
        (refreshed.expires_in ? now + refreshed.expires_in * 1000 : now + 3600 * 1000);
      const mergedTokens = {
        ...tokens,
        idToken: newIdToken,
        accessToken: refreshed.access_token || tokens.accessToken || '',
        expiry: newExpiry,
        scope: refreshed.scope || tokens.scope || '',
        updatedAt: now,
      };
      updatedRecord = (await updateSessionTokens(env, verified.id, updatedRecord, mergedTokens)) || updatedRecord;
      tokens = updatedRecord.tokens || mergedTokens;
    } catch (err) {
      console.warn('[ShiftFlow][Auth] Failed to refresh Google tokens', err);
      updatedRecord = (await touchSession(env, verified.id, updatedRecord)) || updatedRecord;
      tokens = updatedRecord.tokens || tokens;
    }
  } else {
    updatedRecord = (await touchSession(env, verified.id, updatedRecord)) || updatedRecord;
    tokens = updatedRecord.tokens || tokens;
  }

  const refreshedTimeout = evaluateSessionTimeout(updatedRecord, Date.now());
  const cookieValue = `${verified.id}.${verified.key}`;
  setCookieHeader = buildSessionCookie(cookieValue);

  const user = updatedRecord.user || {};
  return jsonResponse(
    200,
    {
      ok: true,
      authenticated: true,
      requestId,
      user: {
        email: user.email || '',
        name: user.name || '',
        picture: user.picture || '',
      },
      expiresAt: Number(tokens.expiry || 0),
      session: {
        idleDeadline: refreshedTimeout.idleDeadline,
        absoluteDeadline: refreshedTimeout.absoluteDeadline,
        idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
        absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
      },
    },
    origin,
    requestId,
    { 'Set-Cookie': setCookieHeader }
  );
}
