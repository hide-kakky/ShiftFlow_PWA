export async function onRequest(context) {
  const gasUrl =
    context.env && typeof context.env.GAS_WEB_APP_URL === 'string'
      ? context.env.GAS_WEB_APP_URL
      : '';
  const body = `window.__GAS_WEB_APP_URL__ = ${JSON.stringify(gasUrl)};`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
