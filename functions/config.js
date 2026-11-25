export async function onRequest(context) {
  const clientIdRaw =
    context.env && typeof context.env.GOOGLE_OAUTH_CLIENT_ID === 'string'
      ? context.env.GOOGLE_OAUTH_CLIENT_ID
      : context.env && typeof context.env.GOOGLE_CLIENT_ID === 'string'
      ? context.env.GOOGLE_CLIENT_ID
      : '';
  const clientId = typeof clientIdRaw === 'string' ? clientIdRaw.trim() : '';
  const body = `window.__GOOGLE_CLIENT_ID__ = ${JSON.stringify(clientId)};`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
