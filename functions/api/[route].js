import { loadConfig, getRoutePermissions } from './config';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const ACCESS_CACHE = new Map();

function logAuthInfo(message, meta) {
  if (meta) {
    console.info('[ShiftFlow][Auth]', message, meta);
  } else {
    console.info('[ShiftFlow][Auth]', message);
  }
}

function logAuthError(message, meta) {
  if (meta) {
    console.error('[ShiftFlow][Auth]', message, meta);
  } else {
    console.error('[ShiftFlow][Auth]', message);
  }
}

function pickAllowedOrigin(allowedOrigins, originHeader) {
  if (!allowedOrigins || !allowedOrigins.length) {
    return '*';
  }
  if (!originHeader) {
    return allowedOrigins[0];
  }
  const normalized = originHeader.trim();
  return allowedOrigins.includes(normalized) ? normalized : null;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(status, payload, origin, extraHeaders) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...corsHeaders(origin),
  });
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.entries(extraHeaders).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        headers.set(key, String(value));
      }
    });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers,
  });
}

function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function fetchTokenInfo(idToken, config) {
  if (!idToken) {
    throw new Error('Missing Authorization bearer token.');
  }
  const tokenUrl = `${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(tokenUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Token verification failed (HTTP ${response.status})`);
  }
  let data;
  try {
    data = await response.json();
  } catch (_err) {
    throw new Error('Token verification returned a non-JSON response.');
  }

  if (!data || !data.aud || String(data.aud) !== config.googleClientId) {
    throw new Error('ID token audience mismatch.');
  }
  if (!GOOGLE_ISSUERS.has(String(data.iss || ''))) {
    throw new Error('ID token issuer is not Google.');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Number(data.exp || 0);
  if (expSeconds && nowSeconds >= expSeconds) {
    throw new Error('ID token has expired.');
  }
  const sub = String(data.sub || '').trim();
  if (!sub) {
    throw new Error('ID token is missing subject (sub).');
  }
  const email = String(data.email || '').trim();
  if (!email) {
    throw new Error('ID token is missing email.');
  }
  const emailVerifiedRaw = data.email_verified;
  const emailVerified =
    emailVerifiedRaw === true ||
    emailVerifiedRaw === 'true' ||
    emailVerifiedRaw === 1 ||
    emailVerifiedRaw === '1';
  return {
    rawToken: idToken,
    sub,
    email,
    emailVerified,
    name: data.name || data.given_name || '',
    picture: data.picture || '',
    hd: data.hd || '',
    aud: data.aud,
    iss: data.iss,
    iat: Number(data.iat || 0),
    exp: expSeconds,
    iatMs: Number(data.iat || 0) > 0 ? Number(data.iat) * 1000 : undefined,
    expMs: expSeconds > 0 ? expSeconds * 1000 : undefined,
  };
}

async function resolveAccessContext(config, tokenDetails, requestId, clientMeta) {
  const cacheKey = tokenDetails.sub;
  const cached = ACCESS_CACHE.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }

  const url = new URL(config.gasUrl);
  const body = JSON.stringify({
    route: 'resolveAccessContext',
    args: [],
  });
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${tokenDetails.rawToken}`,
    'X-ShiftFlow-Sub': tokenDetails.sub,
    'X-ShiftFlow-Email': tokenDetails.email,
    'X-ShiftFlow-Request-Id': requestId,
  };
  if (config.sharedSecret) headers['X-ShiftFlow-Secret'] = config.sharedSecret;
  if (tokenDetails.name) headers['X-ShiftFlow-Name'] = tokenDetails.name;
  if (tokenDetails.hd) headers['X-ShiftFlow-Domain'] = tokenDetails.hd;
  if (tokenDetails.iat) headers['X-ShiftFlow-Token-Iat'] = String(tokenDetails.iat);
  if (tokenDetails.exp) headers['X-ShiftFlow-Token-Exp'] = String(tokenDetails.exp);
  if (clientMeta.ip) headers['X-ShiftFlow-Client-IP'] = clientMeta.ip;
  if (clientMeta.userAgent) headers['X-ShiftFlow-User-Agent'] = clientMeta.userAgent;

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body,
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_err) {
    throw new Error('resolveAccessContext returned a non-JSON payload.');
  }

  if (!response.ok) {
    const detail =
      payload && payload.error
        ? `${payload.error}${payload.detail ? `: ${payload.detail}` : ''}`
        : `HTTP ${response.status}`;
    throw new Error(`resolveAccessContext failed (${detail})`);
  }
  if (!payload || payload.ok === false) {
    const reason =
      payload && payload.error
        ? payload.error
        : 'resolveAccessContext returned an unexpected response.';
    throw new Error(reason);
  }
  const result = payload.result || {};
  const context = {
    allowed: !!result.allowed,
    role: String(result.role || '').trim() || 'guest',
    status: String(result.status || '').trim() || 'unknown',
    email: result.email || tokenDetails.email,
    displayName: result.displayName || '',
    reason: result.reason || '',
  };
  const ttlMs = context.allowed ? 5 * 60 * 1000 : 60 * 1000;
  const expiresAt = Math.min(
    tokenDetails.expMs ? tokenDetails.expMs - 5_000 : now + ttlMs,
    now + ttlMs
  );
  ACCESS_CACHE.set(cacheKey, {
    context,
    expiresAt,
  });
  return context;
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const config = loadConfig(env);
  const route = params.route ? String(params.route) : '';
  const requestId = createRequestId();
  const originHeader = request.headers.get('Origin') || '';
  const allowedOrigin = pickAllowedOrigin(config.allowedOrigins, originHeader);

  if (request.method === 'OPTIONS') {
    if (originHeader && !allowedOrigin) {
      logAuthInfo('Blocked preflight from disallowed origin', {
        requestId,
        origin: originHeader,
      });
      return jsonResponse(
        403,
        { ok: false, error: 'Origin is not allowed.' },
        config.allowedOrigins[0] || '*',
        { 'X-ShiftFlow-Request-Id': requestId }
      );
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(allowedOrigin || config.allowedOrigins[0] || '*'),
        'X-ShiftFlow-Request-Id': requestId,
      },
    });
  }

  if (originHeader && !allowedOrigin) {
    logAuthInfo('Blocked request from disallowed origin', {
      requestId,
      origin: originHeader,
    });
    return jsonResponse(
      403,
      { ok: false, error: 'Origin is not allowed.' },
      config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }
  if (!route) {
    return jsonResponse(
      400,
      { ok: false, error: 'Route parameter is required.' },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }
  if (route === 'resolveAccessContext') {
    return jsonResponse(
      403,
      { ok: false, error: 'Route is reserved.' },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let tokenDetails;
  try {
    tokenDetails = await fetchTokenInfo(token, config);
  } catch (err) {
    logAuthError('Token verification failed', {
      requestId,
      message: err && err.message ? err.message : String(err),
      route,
    });
    return jsonResponse(
      401,
      {
        ok: false,
        error: 'Unauthorized',
        detail: err && err.message ? err.message : String(err || 'Token verification failed'),
      },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }
  if (!tokenDetails.emailVerified) {
    logAuthInfo('Email not verified', {
      requestId,
      email: tokenDetails.email || '',
      route,
    });
    return jsonResponse(
      403,
      { ok: false, error: 'Google アカウントのメールアドレスが未確認です。' },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  const clientMeta = {
    ip:
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '',
    userAgent: request.headers.get('user-agent') || '',
  };

  let accessContext;
  try {
    accessContext = await resolveAccessContext(config, tokenDetails, requestId, clientMeta);
  } catch (err) {
    logAuthError('resolveAccessContext failed', {
      requestId,
      route,
      message: err && err.message ? err.message : String(err),
      email: tokenDetails.email || '',
    });
    return jsonResponse(
      403,
      {
        ok: false,
        error: 'アクセス権を確認できませんでした。',
        detail: err && err.message ? err.message : String(err || 'resolveAccessContext failed'),
      },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }
  if (!accessContext.allowed || accessContext.status !== 'active') {
    logAuthInfo('Access denied by GAS context', {
      requestId,
      route,
      email: tokenDetails.email || '',
      status: accessContext.status,
      reason: accessContext.reason || '',
    });
    return jsonResponse(
      403,
      {
        ok: false,
        error: 'アクセスが許可されていません。',
        reason: accessContext.reason || '承認待ち、または利用停止の可能性があります。',
        status: accessContext.status,
      },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  const routePermissions = getRoutePermissions(route);
  if (Array.isArray(routePermissions) && routePermissions.length > 0) {
    if (!routePermissions.includes(accessContext.role)) {
      logAuthInfo('Route denied due to role mismatch', {
        requestId,
        route,
        required: routePermissions,
        role: accessContext.role,
        email: tokenDetails.email || '',
      });
      return jsonResponse(
        403,
        { ok: false, error: '権限がありません。' },
        allowedOrigin || config.allowedOrigins[0] || '*',
        { 'X-ShiftFlow-Request-Id': requestId }
      );
    }
  }

  const upstreamUrl = new URL(config.gasUrl);
  const originalUrl = new URL(request.url);
  originalUrl.searchParams.forEach((value, key) => {
    if (key !== 'route') {
      upstreamUrl.searchParams.append(key, value);
    }
  });
  upstreamUrl.searchParams.set('route', route);
  upstreamUrl.searchParams.set('__userEmail', tokenDetails.email);
  upstreamUrl.searchParams.set('__userSub', tokenDetails.sub);
  if (tokenDetails.name) {
    upstreamUrl.searchParams.set('__userName', tokenDetails.name);
  }

  const init = {
    method: request.method,
    redirect: 'follow',
    headers: {
      Authorization: `Bearer ${tokenDetails.rawToken}`,
      'X-ShiftFlow-Email': tokenDetails.email,
      'X-ShiftFlow-Sub': tokenDetails.sub,
      'X-ShiftFlow-Role': accessContext.role,
      'X-ShiftFlow-User-Status': accessContext.status,
      'X-ShiftFlow-Request-Id': requestId,
    },
  };
  if (config.sharedSecret) init.headers['X-ShiftFlow-Secret'] = config.sharedSecret;
  if (tokenDetails.name) {
    init.headers['X-ShiftFlow-Name'] = tokenDetails.name;
  }
  if (clientMeta.ip) init.headers['X-ShiftFlow-Client-IP'] = clientMeta.ip;
  if (clientMeta.userAgent) init.headers['X-ShiftFlow-User-Agent'] = clientMeta.userAgent;
  if (tokenDetails.iat) init.headers['X-ShiftFlow-Token-Iat'] = String(tokenDetails.iat);
  if (tokenDetails.exp) init.headers['X-ShiftFlow-Token-Exp'] = String(tokenDetails.exp);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type');
    if (contentType) {
      init.headers['Content-Type'] = contentType;
    }
    init.body = await request.text();
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), init);
  } catch (err) {
    logAuthError('Failed to reach GAS', {
      requestId,
      route,
      email: tokenDetails.email || '',
      message: err && err.message ? err.message : String(err),
    });
    return jsonResponse(
      502,
      {
        ok: false,
        error: 'GAS unreachable',
        detail: err && err.message ? err.message : String(err || 'fetch failed'),
      },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  const baseCors = corsHeaders(allowedOrigin || config.allowedOrigins[0] || '*');
  const responseHeaders = new Headers({
    ...baseCors,
    'X-ShiftFlow-Request-Id': requestId,
  });
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith('access-control')) return;
    responseHeaders.set(key, value);
  });
  const bodyBuffer = await upstreamResponse.arrayBuffer();

  return new Response(bodyBuffer, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}
