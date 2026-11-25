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
import { recordAuthEvent } from '../utils/auditEvents.js';
import { recordAuthInfrastructureFailure } from '../utils/authDiagnostics.js';

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
  let verified;
  try {
    verified = await verifySession(env, cookieHeader);
  } catch (_error) {
    await recordAuthInfrastructureFailure(env, {
      event: 'auth_session_verification_failed',
      reasonCode: 'session_verification_unavailable',
      requestId,
      route: '/auth/session',
      phase: 'session_verify',
      httpStatus: 503,
    });
    return jsonResponse(
      503,
      {
        ok: false,
        authenticated: false,
        code: 'session_verification_unavailable',
        reason: 'ログイン状態を一時的に確認できません。時間をおいて再試行してください。',
        requestId,
      },
      origin,
      requestId
    );
  }
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
      idleDeadline: timeoutCheck.idleDeadline,
      absoluteDeadline: timeoutCheck.absoluteDeadline,
    });
    await recordAuthEvent(env, {
      eventType: 'session.expired',
      outcome: 'expired',
      reasonCode,
      requestId,
      route: '/auth/session',
      source: 'auth_session',
      sessionId: verified.id,
      user: verified.record?.user || {},
    });
    try {
      await destroySession(env, verified.id);
    } catch (_error) {
      await recordAuthInfrastructureFailure(env, {
        event: 'auth_session_expiry_cleanup_failed',
        reasonCode: 'session_expiry_cleanup_failed',
        requestId,
        route: '/auth/session',
        phase: 'session_destroy',
        httpStatus: 503,
      });
      return jsonResponse(
        503,
        {
          ok: false,
          authenticated: false,
          code: 'session_expiry_cleanup_failed',
          reason: '期限切れセッションを終了できませんでした。時間をおいて再試行してください。',
          requestId,
        },
        origin,
        requestId
      );
    }
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

  let updatedRecord;
  try {
    updatedRecord = await touchSession(env, verified.id, verified.record);
  } catch (_error) {
    await recordAuthInfrastructureFailure(env, {
      event: 'auth_session_touch_failed',
      reasonCode: 'session_refresh_unavailable',
      requestId,
      route: '/auth/session',
      phase: 'session_touch',
      httpStatus: 503,
    });
    return jsonResponse(
      503,
      {
        ok: false,
        authenticated: false,
        code: 'session_refresh_unavailable',
        reason: 'ログイン状態を更新できません。時間をおいて再試行してください。',
        requestId,
      },
      origin,
      requestId
    );
  }
  if (!updatedRecord) {
    return jsonResponse(
      200,
      {
        ok: true,
        authenticated: false,
        reason: 'session_revoked',
        requestId,
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
