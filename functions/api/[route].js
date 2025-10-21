const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

export async function onRequest(context) {
  const { request, params, env } = context;
  const route = params.route || '';
  const gasBase = env && env.GAS_WEB_APP_URL ? env.GAS_WEB_APP_URL : '';

  if (!gasBase) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'GAS_WEB_APP_URL is not configured on Cloudflare Pages.',
      }),
      {
        status: 500,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const upstreamUrl = new URL(gasBase);
  const originalUrl = new URL(request.url);

  originalUrl.searchParams.forEach((value, key) => {
    if (key !== 'route') {
      upstreamUrl.searchParams.append(key, value);
    }
  });
  if (route) {
    upstreamUrl.searchParams.set('route', route);
  }

  const init = {
    method: request.method,
    redirect: 'follow',
    headers: {},
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type');
    if (contentType) {
      init.headers['Content-Type'] = contentType;
    }
    const bodyText = await request.text();
    init.body = bodyText;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), init);
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'GAS unreachable', detail: err.message }),
      {
        status: 502,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  const responseHeaders = new Headers(CORS_HEADERS);
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    responseHeaders.set('Content-Type', contentType);
  }

  const bodyBuffer = await upstreamResponse.arrayBuffer();
  return new Response(bodyBuffer, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
