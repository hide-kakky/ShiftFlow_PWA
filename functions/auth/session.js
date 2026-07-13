import {
  verifySession,
  touchSession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  destroySession,
  evaluateSessionTimeout,
  getSessionCookieMaxAge,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_ABSOLUTE_TIMEOUT_MS,
} from '../utils/session.js';

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
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Cache-Control': 'no-store',
  });
  Object.entries(extraHeaders || {}).forEach(([name, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, String(item)));
    } else if (value !== undefined && value !== null) {
      headers.set(name, String(value));
    }
  });
  if (requestId) {
    headers.set('X-ShiftFlow-Request-Id', requestId);
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
      {
        'Set-Cookie': [
          buildExpiredSessionCookie(),
          buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
        ],
      }
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
      {
        'Set-Cookie': [
          buildExpiredSessionCookie(),
          buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
        ],
      }
    );
  }

  const updatedRecord = (await touchSession(env, verified.id, verified.record)) || verified.record;

  const refreshedTimeout = evaluateSessionTimeout(updatedRecord, Date.now());
  const cookieValue = `${verified.id}.${verified.key}`;
  const setCookieHeader = buildSessionCookie(cookieValue, {
    maxAge: getSessionCookieMaxAge(updatedRecord),
  });

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
      expiresAt: Math.min(refreshedTimeout.idleDeadline, refreshedTimeout.absoluteDeadline),
      session: {
        idleDeadline: refreshedTimeout.idleDeadline,
        absoluteDeadline: refreshedTimeout.absoluteDeadline,
        idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
        absoluteTimeoutMs: SESSION_ABSOLUTE_TIMEOUT_MS,
      },
    },
    origin,
    requestId,
    {
      'Set-Cookie': [
        setCookieHeader,
        buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
      ],
    }
  );
}
