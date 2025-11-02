import {
  parseSessionCookie,
  destroySession,
  buildExpiredSessionCookie,
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
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: 'Method Not Allowed' }, origin);
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const parsed = parseSessionCookie(cookieHeader);
  if (parsed?.id) {
    await destroySession(env, parsed.id);
  }
  return jsonResponse(
    200,
    { ok: true, loggedOut: true },
    origin,
    { 'Set-Cookie': buildExpiredSessionCookie() }
  );
}
