export async function onRequest(context) {
  const gasUrlRaw =
    context.env && typeof context.env.GAS_EXEC_URL === 'string'
      ? context.env.GAS_EXEC_URL
      : context.env && typeof context.env.GAS_WEB_APP_URL === 'string'
      ? context.env.GAS_WEB_APP_URL
      : '';
  const gasUrl = typeof gasUrlRaw === 'string' ? gasUrlRaw.trim() : '';
  const clientIdRaw =
    context.env && typeof context.env.GOOGLE_OAUTH_CLIENT_ID === 'string'
      ? context.env.GOOGLE_OAUTH_CLIENT_ID
      : context.env && typeof context.env.GOOGLE_CLIENT_ID === 'string'
      ? context.env.GOOGLE_CLIENT_ID
      : '';
  const clientId = typeof clientIdRaw === 'string' ? clientIdRaw.trim() : '';
  const body = `window.__GAS_WEB_APP_URL__ = ${JSON.stringify(
    gasUrl
  )};\nwindow.__GOOGLE_CLIENT_ID__ = ${JSON.stringify(clientId)};`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
