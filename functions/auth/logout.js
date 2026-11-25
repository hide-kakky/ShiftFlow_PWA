import { verifySession, destroySession, buildExpiredSessionCookie } from '../utils/session.js';
import { recordAuthEvent } from '../utils/auditEvents.js';
import { recordAuthInfrastructureFailure } from '../utils/authDiagnostics.js';

function resolveRequestId(request) {
  const received = request.headers.get('X-ShiftFlow-Request-Id') || '';
  const normalized = received.trim();
  if (normalized && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized)) {
    return normalized;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function jsonResponse(status, payload, origin, extraHeaders = {}) {
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
  return new Response(JSON.stringify(payload), {
    status,
    headers,
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
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, origin);
  }

  const requestOrigin = request.headers.get('origin') || '';
  if (requestOrigin && requestOrigin !== origin) {
    return jsonResponse(403, { ok: false, error: 'Origin is not allowed.' }, origin);
  }

  const cookieHeader = request.headers.get('cookie') || '';
  let verified;
  try {
    verified = await verifySession(env, cookieHeader);
  } catch (_error) {
    const requestId = resolveRequestId(request);
    await recordAuthInfrastructureFailure(env, {
      event: 'auth_logout_session_verification_failed',
      reasonCode: 'session_verification_unavailable',
      requestId,
      route: '/auth/logout',
      phase: 'session_verify',
      httpStatus: 503,
    });
    return jsonResponse(
      503,
      {
        ok: false,
        loggedOut: false,
        code: 'session_verification_unavailable',
        requestId,
      },
      origin
    );
  }
  if (verified?.id) {
    const logoutDetails = {
      eventType: 'session.logged_out',
      outcome: 'success',
      reasonCode: 'user_requested',
      requestId: resolveRequestId(request),
      route: '/auth/logout',
      source: 'auth_logout',
      sessionId: verified.id,
      user: verified.record?.user || {},
    };
    try {
      await destroySession(env, verified.id);
    } catch (error) {
      console.error('[ShiftFlow][Logout] Session revocation failed', {
        requestId: logoutDetails.requestId,
        reasonCode: 'session_revocation_failed',
      });
      await recordAuthInfrastructureFailure(env, {
        event: 'auth_logout_session_revocation_failed',
        reasonCode: 'session_revocation_failed',
        requestId: logoutDetails.requestId,
        route: '/auth/logout',
        phase: 'session_destroy',
        httpStatus: 503,
      });
      return jsonResponse(
        503,
        {
          ok: false,
          loggedOut: false,
          code: 'session_revocation_failed',
          requestId: logoutDetails.requestId,
        },
        origin
      );
    }
    await recordAuthEvent(env, logoutDetails);
  }
  return jsonResponse(
    200,
    { ok: true, loggedOut: true },
    origin,
    {
      'Set-Cookie': [
        buildExpiredSessionCookie(),
        buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
      ],
    }
  );
}
