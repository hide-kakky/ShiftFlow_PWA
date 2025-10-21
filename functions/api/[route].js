const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
let jwksCache = { keys: new Map(), expiresAt: 0 };

function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const outputArray = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) {
    outputArray[i] = raw.charCodeAt(i);
  }
  return outputArray;
}

function decodeJwtPart(part) {
  const decoded = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded);
}

async function fetchGoogleJwks() {
  const response = await fetch('https://www.googleapis.com/oauth2/v3/certs', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error('Failed to fetch Google JWKS: HTTP ' + response.status);
  }
  const { keys } = await response.json();
  const map = new Map();
  keys.forEach((key) => {
    if (key && key.kid) {
      map.set(key.kid, key);
    }
  });
  jwksCache = {
    keys: map,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

async function getGoogleJwk(kid) {
  if (!jwksCache.keys.size || Date.now() > jwksCache.expiresAt || !jwksCache.keys.has(kid)) {
    await fetchGoogleJwks();
  }
  const jwk = jwksCache.keys.get(kid);
  if (!jwk) {
    throw new Error('JWK not found for kid: ' + kid);
  }
  return jwk;
}

async function verifyGoogleIdToken(idToken, clientId) {
  if (!idToken) {
    throw new Error('Missing ID token');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid ID token format');
  }
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (!header.kid) {
    throw new Error('ID token missing kid');
  }
  if (!payload || !payload.aud || payload.aud !== clientId) {
    throw new Error('ID token aud mismatch');
  }
  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw new Error('ID token issuer mismatch');
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) {
    throw new Error('ID token expired');
  }
  if (payload.nbf && now < payload.nbf) {
    throw new Error('ID token not yet valid');
  }

  const jwk = await getGoogleJwk(header.kid);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: { name: 'SHA-256' },
    },
    false,
    ['verify']
  );
  const signedData = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const signature = base64UrlToUint8Array(parts[2]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedData);
  if (!valid) {
    throw new Error('Invalid ID token signature');
  }
  return payload;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const route = params.route || '';
  const gasBase = env && env.GAS_WEB_APP_URL ? env.GAS_WEB_APP_URL : '';
  const googleClientId = env && env.GOOGLE_CLIENT_ID ? env.GOOGLE_CLIENT_ID : '';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

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
  if (!googleClientId) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'GOOGLE_CLIENT_ID is not configured on Cloudflare Pages.',
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

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : '';
  let tokenPayload;
  try {
    tokenPayload = await verifyGoogleIdToken(token, googleClientId);
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Unauthorized',
        detail: err && err.message ? err.message : String(err || 'Invalid token'),
      }),
      {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        },
      }
    );
  }
  const userEmail = tokenPayload && tokenPayload.email;
  if (!userEmail || tokenPayload.email_verified === false) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Email address is not verified on Google account.',
      }),
      {
        status: 403,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
        },
      }
    );
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
  upstreamUrl.searchParams.set('__userEmail', userEmail);
  if (tokenPayload.name) {
    upstreamUrl.searchParams.set('__userName', tokenPayload.name);
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
  init.headers['X-ShiftFlow-Email'] = userEmail;
  if (tokenPayload.name) {
    init.headers['X-ShiftFlow-Name'] = tokenPayload.name;
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
