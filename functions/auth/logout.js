import { verifySession, destroySession, buildExpiredSessionCookie } from '../utils/session.js';

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
  const verified = await verifySession(env, cookieHeader);
  if (verified?.id) {
    await destroySession(env, verified.id);
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
