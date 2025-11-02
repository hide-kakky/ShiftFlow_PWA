import { loadConfig, getRoutePermissions } from './config';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const DIAGNOSTIC_ROUTE = 'logAuthProxyEvent';
const ACCESS_CACHE = new Map();
const CORS_ALLOWED_HEADERS = 'Content-Type,Authorization,X-ShiftFlow-Request-Id';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
    'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
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

function normalizeRedirectUrl(currentUrl, locationHeader) {
  if (!locationHeader) return null;
  try {
    return new URL(locationHeader, currentUrl).toString();
  } catch (_err) {
    return null;
  }
}

function stripXssiPrefix(text) {
  if (typeof text !== 'string') return text;
  if (!text) return text;
  let trimmed = text.replace(/^\s+/, '');
  if (trimmed.startsWith(")]}'")) {
    trimmed = trimmed.replace(/^\)\]\}'\s*/, '');
  }
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) {
    const candidate = trimmed.slice(firstBrace);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch (_err) {
      return trimmed;
    }
  }
  return trimmed;
}

function isLikelyHtmlDocument(text) {
  if (typeof text !== 'string') return false;
  const sample = text.trim().slice(0, 200).toLowerCase();
  if (!sample) return false;
  return (
    sample.startsWith('<!doctype html') ||
    sample.startsWith('<html') ||
    sample.includes('<body') ||
    sample.includes('<head') ||
    sample.includes('<meta') ||
    sample.includes('<title')
  );
}

function generateMessageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function interceptRequestBodyForRoute(route, body, context) {
  if (!body || typeof body !== 'object') {
    return { body, mutated: false, dualWriteContext: null };
  }
  const flags = context?.flags || {};
  if (route === 'addNewMessage' && flags.d1Write) {
    const mutatedBody = { ...body };
    let mutated = false;
    if (!mutatedBody.messageId || typeof mutatedBody.messageId !== 'string') {
      mutatedBody.messageId = generateMessageId();
      mutated = true;
    }
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'message',
        messageId: mutatedBody.messageId,
        payload: mutatedBody,
        timestampMs: Date.now(),
      },
    };
  }
  return { body, mutated: false, dualWriteContext: null };
}

async function parseJsonResponseSafe(response) {
  if (!response) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return null;
  }
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

async function performDualWriteIfNeeded(options) {
  const { env, config, route, requestId, tokenDetails, accessContext, dualWriteContext, responseJson, clientMeta } =
    options;
  const flags = config?.flags || {};
  if (!flags.d1Write || !dualWriteContext) return;
  if (!env?.DB) {
    logAuthInfo('Dual write skipped because DB binding is missing', { route, requestId });
    return;
  }
  if (!responseJson || responseJson.success === false || responseJson.ok === false) {
    logAuthInfo('Dual write skipped due to upstream failure', {
      route,
      requestId,
      success: responseJson && responseJson.success,
    });
    return;
  }
  try {
    if (dualWriteContext.type === 'message') {
      await insertMessageIntoD1(env.DB, {
        messageId: dualWriteContext.messageId,
        payload: dualWriteContext.payload,
        timestampMs: dualWriteContext.timestampMs,
        authorEmail: tokenDetails.email,
        role: accessContext.role,
      });
      captureDiagnostics(config, 'info', 'dual_write_message_success', {
        event: 'dual_write_message_success',
        route,
        requestId,
        email: tokenDetails.email || '',
        messageId: dualWriteContext.messageId,
        cfRay: clientMeta?.cfRay || '',
      });
    }
  } catch (err) {
    console.error('[ShiftFlow][DualWrite] Failed to replicate to D1', {
      route,
      requestId,
      messageId: dualWriteContext.messageId,
      error: err && err.message ? err.message : String(err),
    });
    captureDiagnostics(config, 'error', 'dual_write_failure', {
      event: 'dual_write_failure',
      route,
      requestId,
      email: tokenDetails.email || '',
      messageId: dualWriteContext.messageId,
      detail: err && err.message ? err.message : String(err),
      cfRay: clientMeta?.cfRay || '',
    });
  }
}

async function insertMessageIntoD1(db, context) {
  if (!context?.messageId) return;
  const lowerEmail = (context.authorEmail || '').trim().toLowerCase();
  const membership = await resolveMembershipForEmail(db, lowerEmail);
  const orgId =
    membership?.org_id ||
    (await resolveDefaultOrgId(db)) ||
    '01H00000000000000000000000';
  if (!membership) {
    console.warn('[ShiftFlow][DualWrite] Membership not found for author email', {
      email: lowerEmail,
      messageId: context.messageId,
    });
  }
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();
  await db
    .prepare(
      `
      INSERT OR REPLACE INTO messages (
        message_id,
        org_id,
        folder_id,
        author_membership_id,
        title,
        body,
        created_at_ms,
        updated_at_ms
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
    )
    .bind(
      context.messageId,
      orgId,
      typeof payload.folderId === 'string' ? payload.folderId : null,
      membership?.membership_id || null,
      typeof payload.title === 'string' ? payload.title : '',
      typeof payload.body === 'string' ? payload.body : '',
      timestampMs,
      timestampMs
    )
    .run();
}

async function resolveMembershipForEmail(db, email) {
  if (!email) return null;
  const row = await db
    .prepare(
      `
      SELECT memberships.membership_id,
             memberships.org_id,
             users.user_id
      FROM memberships
      JOIN users ON users.user_id = memberships.user_id
      WHERE lower(users.email) = ?1
      ORDER BY memberships.created_at_ms ASC
      LIMIT 1
    `
    )
    .bind(email)
    .first();
  return row || null;
}

async function resolveDefaultOrgId(db) {
  const row = await db
    .prepare('SELECT org_id FROM organizations ORDER BY created_at_ms ASC LIMIT 1')
    .first();
  return row ? row.org_id : null;
}

async function fetchPreservingAuth(originalUrl, originalInit, remainingRedirects = 4, meta = {}) {
  const init = { ...(originalInit || {}), redirect: 'manual' };
  const response = await fetch(originalUrl, init);
  if (!REDIRECT_STATUSES.has(response.status)) {
    return response;
  }
  const location = normalizeRedirectUrl(originalUrl, response.headers.get('Location'));

  const originHostRaw = (() => {
    try {
      return new URL(originalUrl).hostname;
    } catch (_err) {
      return '';
    }
  })();
  const locationHostRaw = (() => {
    try {
      return location ? new URL(location).hostname : '';
    } catch (_err) {
      return '';
    }
  })();
  const originHost = originHostRaw ? originHostRaw.toLowerCase() : '';
  const locationHost = locationHostRaw ? locationHostRaw.toLowerCase() : '';

  if (
    location &&
    locationHost &&
    locationHost.endsWith('script.googleusercontent.com') &&
    originHost &&
    (originHost === 'script.google.com' || originHost.endsWith('.script.google.com'))
  ) {
    if (remainingRedirects <= 0) {
      logAuthError('Exceeded redirect attempts when calling upstream', {
        requestId: meta.requestId || '',
        route: meta.route || '',
        status: response.status,
        location: location || '',
        originHost,
        locationHost,
      });
      const error = new Error('Too many upstream redirects.');
      error.httpStatus = response.status;
      error.redirectLocation = location || '';
      error.responseHeaders = Object.fromEntries(response.headers.entries());
      error.isRedirect = true;
      throw error;
    }
    logAuthInfo('Following upstream redirect', {
      requestId: meta.requestId || '',
      route: meta.route || '',
      status: response.status,
      location,
    });
    captureDiagnostics(meta.config, 'info', 'upstream_redirect_followed', {
      event: 'upstream_redirect_followed',
      requestId: meta.requestId || '',
      route: meta.route || '',
      status: response.status,
      location,
      originHost,
      locationHost,
    });
    const nextInit = { ...init };
    delete nextInit.redirect;
    const originalMethod = (nextInit.method || 'GET').toString().toUpperCase();
    const shouldResetMethod =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        originalMethod !== 'GET' &&
        originalMethod !== 'HEAD');
    if (shouldResetMethod) {
      nextInit.method = 'GET';
      delete nextInit.body;
      if (nextInit.headers && typeof nextInit.headers === 'object') {
        if (typeof nextInit.headers.delete === 'function') {
          nextInit.headers.delete('Content-Type');
        } else {
          delete nextInit.headers['Content-Type'];
          delete nextInit.headers['content-type'];
        }
      }
    }
    nextInit.redirect = 'manual';
    return fetchPreservingAuth(location, nextInit, remainingRedirects - 1, meta);
  }

  logAuthInfo('Blocked upstream redirect', {
    requestId: meta.requestId || '',
    route: meta.route || '',
    status: response.status,
    location: location || '',
  });
  captureDiagnostics(meta.config, 'warn', 'upstream_redirect_blocked', {
    event: 'upstream_redirect_blocked',
    requestId: meta.requestId || '',
    route: meta.route || '',
    status: response.status,
    location: location || '',
    originHost,
    locationHost,
  });

  const error = new Error('Upstream responded with a redirect.');
  error.httpStatus = response.status;
  error.redirectLocation = location || '';
  error.responseHeaders = Object.fromEntries(response.headers.entries());
  error.isRedirect = true;
  error.isCrossOriginRedirect = originHost && locationHost && originHost !== locationHost;
  throw error;
}

function sanitizeDiagnosticsValue(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  const type = typeof value;
  if (type === 'string') {
    return value.length > 500 ? value.slice(0, 497) + '...' : value;
  }
  if (type === 'number' || type === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    try {
      return value.slice(0, 10).map((item) => sanitizeDiagnosticsValue(item));
    } catch (_err) {
      return String(value);
    }
  }
  if (type === 'object') {
    const entries = Object.entries(value);
    const limited = {};
    for (let i = 0; i < Math.min(entries.length, 10); i += 1) {
      const [key, val] = entries[i];
      if (!key) continue;
      const sanitized = sanitizeDiagnosticsValue(val);
      if (sanitized !== undefined) {
        limited[key] = sanitized;
      }
    }
    return limited;
  }
  return String(value);
}

function createDiagnosticsPayload(level, message, meta) {
  const safeMetaRaw = meta && typeof meta === 'object' ? meta : {};
  const safeMeta = {};
  const entries = Object.entries(safeMetaRaw);
  const limit = Math.min(entries.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const [key, value] = entries[i];
    if (!key) continue;
    const sanitized = sanitizeDiagnosticsValue(value);
    if (sanitized !== undefined) {
      safeMeta[key] = sanitized;
    }
  }
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    requestId: typeof safeMeta.requestId === 'string' ? safeMeta.requestId : '',
    event: typeof safeMeta.event === 'string' ? safeMeta.event : '',
    route: typeof safeMeta.route === 'string' ? safeMeta.route : '',
    email: typeof safeMeta.email === 'string' ? safeMeta.email : '',
    status: typeof safeMeta.status === 'string' ? safeMeta.status : '',
    meta: safeMeta,
  };
  return payload;
}

async function sendDiagnostics(config, payload) {
  if (!config || !config.gasUrl) {
    return;
  }
  const headers = new Headers({
    'Content-Type': 'application/json',
  });
  if (config.sharedSecret) {
    headers.set('X-ShiftFlow-Secret', config.sharedSecret);
  }
  if (payload.requestId) {
    headers.set('X-ShiftFlow-Request-Id', payload.requestId);
  }
  const body = JSON.stringify({
    route: DIAGNOSTIC_ROUTE,
    args: [payload],
  });
  const response = await fetch(config.gasUrl, {
    method: 'POST',
    headers,
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `Diagnostic endpoint failed (${response.status}): ${text ? text.slice(0, 200) : 'no body'}`
    );
  }
}

function captureDiagnostics(config, level, message, meta) {
  try {
    const payload = createDiagnosticsPayload(level, message, meta);
    sendDiagnostics(config, payload).catch((err) => {
      console.warn('[ShiftFlow][Auth] Failed to push diagnostics log', {
        requestId: payload.requestId || '',
        message: err && err.message ? err.message : String(err),
      });
    });
  } catch (err) {
    console.warn('[ShiftFlow][Auth] Failed to prepare diagnostics payload', {
      message: err && err.message ? err.message : String(err),
    });
  }
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
  const headers = {
    'Content-Type': 'application/json',
    'X-ShiftFlow-Sub': tokenDetails.sub,
    'X-ShiftFlow-Email': tokenDetails.email,
    'X-ShiftFlow-Request-Id': requestId,
  };
  const hasRawToken = typeof tokenDetails.rawToken === 'string' && tokenDetails.rawToken.trim() !== '';
  const authorizationHeader = hasRawToken ? `Bearer ${tokenDetails.rawToken.trim()}` : '';
  if (authorizationHeader) {
    headers.Authorization = authorizationHeader;
  }
  if (config.sharedSecret) headers['X-ShiftFlow-Secret'] = config.sharedSecret;
  if (tokenDetails.name) headers['X-ShiftFlow-Name'] = tokenDetails.name;
  if (tokenDetails.hd) headers['X-ShiftFlow-Domain'] = tokenDetails.hd;
  if (tokenDetails.iat) headers['X-ShiftFlow-Token-Iat'] = String(tokenDetails.iat);
  if (tokenDetails.exp) headers['X-ShiftFlow-Token-Exp'] = String(tokenDetails.exp);
  if (clientMeta.ip) headers['X-ShiftFlow-Client-IP'] = clientMeta.ip;
  if (clientMeta.userAgent) headers['X-ShiftFlow-User-Agent'] = clientMeta.userAgent;
  const bodyPayload = {
    route: 'resolveAccessContext',
    args: [],
  };
  if (authorizationHeader) {
    bodyPayload.authorization = authorizationHeader;
    bodyPayload.headers = { Authorization: authorizationHeader };
  }
  const body = JSON.stringify(bodyPayload);

  logAuthInfo('Calling resolveAccessContext upstream', {
    requestId,
    route: 'resolveAccessContext',
    gasHost: url.host,
    gasPath: url.pathname,
    email: tokenDetails.email || '',
    hasAuthorization: !!authorizationHeader,
  });
  let response;
  try {
    response = await fetchPreservingAuth(
      url.toString(),
      {
        method: 'POST',
        headers,
        body,
      },
      4,
      { config, requestId, route: 'resolveAccessContext' }
    );
  } catch (err) {
    if (err && err.isRedirect) {
      const redirectError = new Error(
        'resolveAccessContext received a redirect instead of JSON. Authentication may be required.'
      );
      redirectError.httpStatus = err.httpStatus;
      redirectError.redirectLocation = err.redirectLocation;
      redirectError.isRedirect = true;
      redirectError.responseHeaders = err.responseHeaders || {};
      throw redirectError;
    }
    throw err;
  }
  logAuthInfo('resolveAccessContext upstream status', {
    requestId,
    route: 'resolveAccessContext',
    status: response.status,
    contentType: response.headers.get('Content-Type') || '',
    location: response.headers.get('Location') || '',
  });
  const text = await response.text();
  let payload;
  try {
    if (isLikelyHtmlDocument(text)) {
      const error = new Error('resolveAccessContext returned HTML content.');
      error.httpStatus = response.status;
      error.rawResponseSnippet = text.slice(0, 512);
      error.responseHeaders = Object.fromEntries(response.headers.entries());
      error.isHtml = true;
      throw error;
    }
    payload = JSON.parse(stripXssiPrefix(text));
  } catch (_err) {
    const snippet = typeof text === 'string' ? text.slice(0, 512) : '';
    const error = _err instanceof Error ? _err : new Error('resolveAccessContext returned a non-JSON payload.');
    error.httpStatus = response.status;
    error.rawResponseSnippet = snippet;
    error.responseHeaders = Object.fromEntries(response.headers.entries());
    throw error;
  }

  if (!response.ok) {
    const detail =
      payload && payload.error
        ? `${payload.error}${payload.detail ? `: ${payload.detail}` : ''}`
        : `HTTP ${response.status}`;
    const error = new Error(`resolveAccessContext failed (${detail})`);
    error.httpStatus = response.status;
    error.rawResponseSnippet =
      payload && typeof payload === 'object' ? JSON.stringify(payload).slice(0, 512) : '';
    error.responseHeaders = Object.fromEntries(response.headers.entries());
    throw error;
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
  const flags = config.flags || {};
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
      captureDiagnostics(config, 'warn', 'origin_blocked', {
        event: 'origin_blocked',
        requestId,
        origin: originHeader,
        phase: 'preflight',
        route,
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
    captureDiagnostics(config, 'warn', 'origin_blocked', {
      event: 'origin_blocked',
      requestId,
      origin: originHeader,
      route,
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

  const clientMeta = {
    ip:
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '',
    userAgent: request.headers.get('user-agent') || '',
    cfRay: request.headers.get('cf-ray') || '',
  };

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let tokenDetails;
  logAuthInfo('Handling authenticated route request', {
    requestId,
    route,
    hasAuthorizationHeader: !!token,
    origin: originHeader || '',
  });
  try {
    tokenDetails = await fetchTokenInfo(token, config);
  } catch (err) {
    logAuthError('Token verification failed', {
      requestId,
      message: err && err.message ? err.message : String(err),
      route,
    });
    captureDiagnostics(config, 'error', 'token_verification_failed', {
      event: 'token_verification_failed',
      requestId,
      route,
      detail: err && err.message ? err.message : String(err),
      tokenPresent: !!token,
      clientIp: clientMeta.ip,
      userAgent: clientMeta.userAgent,
      cfRay: clientMeta.cfRay,
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
    captureDiagnostics(config, 'warn', 'email_not_verified', {
      event: 'email_not_verified',
      requestId,
      route,
      email: tokenDetails.email || '',
      clientIp: clientMeta.ip,
      userAgent: clientMeta.userAgent,
      cfRay: clientMeta.cfRay,
    });
    return jsonResponse(
      403,
      { ok: false, error: 'Google アカウントのメールアドレスが未確認です。' },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  let accessContext;
  try {
    accessContext = await resolveAccessContext(config, tokenDetails, requestId, clientMeta);
  } catch (err) {
    logAuthError('resolveAccessContext failed', {
      requestId,
      route,
      message: err && err.message ? err.message : String(err),
      email: tokenDetails.email || '',
      rawSample: err && err.rawResponseSnippet ? err.rawResponseSnippet.slice(0, 200) : '',
      rawHtml: err && err.isHtml ? (err.rawResponseSnippet || '').slice(0, 200) : '',
      redirectLocation: err && err.redirectLocation ? err.redirectLocation : '',
    });
    const detailMessage =
      err && err.isRedirect
        ? 'Apps Script が認証リダイレクトを返しました。GAS_EXEC_URL が Web アプリの /exec URL になっているか確認し、必要であれば Apps Script で認証を完了してください。'
        : err && err.isHtml
        ? 'Apps Script が HTML を返しました。GAS_EXEC_URL をブラウザで開いて Google アカウントの承認を完了してください。'
        : err && err.message
        ? err.message
        : String(err || 'resolveAccessContext failed');
    const statusCode = err && err.isRedirect ? 401 : 403;
    captureDiagnostics(config, 'error', 'resolve_access_context_failed', {
      event: 'resolve_access_context_failed',
      requestId,
      route,
      email: tokenDetails.email || '',
      detail: detailMessage,
      clientIp: clientMeta.ip,
      userAgent: clientMeta.userAgent,
      httpStatus: err && err.httpStatus ? err.httpStatus : '',
      rawResponseSnippet: err && err.rawResponseSnippet ? err.rawResponseSnippet : '',
      responseHeaders: err && err.responseHeaders ? err.responseHeaders : {},
      cfRay: clientMeta.cfRay,
      redirectLocation: err && err.redirectLocation ? err.redirectLocation : '',
    });
    return jsonResponse(
      statusCode,
      {
        ok: false,
        error: 'アクセス権を確認できませんでした。',
        detail: detailMessage,
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
    captureDiagnostics(config, 'warn', 'access_denied', {
      event: 'access_denied',
      requestId,
      route,
      email: tokenDetails.email || '',
      status: accessContext.status,
      reason: accessContext.reason || '',
      clientIp: clientMeta.ip,
      cfRay: clientMeta.cfRay,
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
      captureDiagnostics(config, 'warn', 'role_mismatch', {
        event: 'role_mismatch',
        requestId,
        route,
        email: tokenDetails.email || '',
        role: accessContext.role,
        required: routePermissions,
        cfRay: clientMeta.cfRay,
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
  upstreamUrl.searchParams.delete('route');
  upstreamUrl.searchParams.delete('method');
  upstreamUrl.searchParams.delete('page');
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

  const rawBearerToken =
    typeof tokenDetails.rawToken === 'string' ? tokenDetails.rawToken.trim() : '';
  const authorizationHeader = rawBearerToken ? `Bearer ${rawBearerToken}` : '';

  let dualWriteContext = null;

  const init = {
    method: request.method,
    redirect: 'follow',
    headers: {
      'X-ShiftFlow-Email': tokenDetails.email,
      'X-ShiftFlow-Sub': tokenDetails.sub,
      'X-ShiftFlow-Role': accessContext.role,
      'X-ShiftFlow-User-Status': accessContext.status,
      'X-ShiftFlow-Request-Id': requestId,
    },
  };
  if (authorizationHeader) {
    init.headers.Authorization = authorizationHeader;
  }
  if (config.sharedSecret) init.headers['X-ShiftFlow-Secret'] = config.sharedSecret;
  if (tokenDetails.name) {
    init.headers['X-ShiftFlow-Name'] = tokenDetails.name;
  }
  if (clientMeta.ip) init.headers['X-ShiftFlow-Client-IP'] = clientMeta.ip;
  if (clientMeta.userAgent) init.headers['X-ShiftFlow-User-Agent'] = clientMeta.userAgent;
  if (clientMeta.cfRay) init.headers['X-ShiftFlow-CF-Ray'] = clientMeta.cfRay;
  if (tokenDetails.iat) init.headers['X-ShiftFlow-Token-Iat'] = String(tokenDetails.iat);
  if (tokenDetails.exp) init.headers['X-ShiftFlow-Token-Exp'] = String(tokenDetails.exp);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type');
    const originalContentType = contentType || '';
    if (originalContentType) {
     init.headers['Content-Type'] = originalContentType;
    }
    let rawBody = await request.text();
    if (rawBody && originalContentType.includes('application/json')) {
      try {
        const parsedBody = JSON.parse(rawBody) || {};
        if (authorizationHeader) {
          if (parsedBody && typeof parsedBody === 'object') {
            if (!parsedBody.authorization) {
              parsedBody.authorization = authorizationHeader;
            }
            if (!parsedBody.headers || typeof parsedBody.headers !== 'object') {
              parsedBody.headers = {};
            }
            if (!parsedBody.headers.Authorization) {
              parsedBody.headers.Authorization = authorizationHeader;
            }
          }
        }
        const interception = interceptRequestBodyForRoute(route, parsedBody, {
          flags,
          tokenDetails,
          accessContext,
        });
        const bodyToForward = interception ? interception.body : parsedBody;
        if (interception && interception.dualWriteContext) {
          dualWriteContext = interception.dualWriteContext;
        }
        rawBody = JSON.stringify(bodyToForward);
        init.headers['Content-Type'] = 'application/json';
      } catch (_err) {
        // Leave body as-is if JSON parsing fails.
      }
    }
    init.body = rawBody;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchPreservingAuth(upstreamUrl.toString(), init, 4, {
      config,
      requestId,
      route,
    });
  } catch (err) {
    if (err && err.isRedirect) {
      logAuthError('GAS returned redirect', {
        requestId,
        route,
        email: tokenDetails.email || '',
        status: err.httpStatus || '',
        location: err.redirectLocation || '',
      });
      captureDiagnostics(config, 'error', 'gas_redirected', {
        event: 'gas_redirected',
        requestId,
        route,
        email: tokenDetails.email || '',
        status: err.httpStatus || '',
        location: err.redirectLocation || '',
        clientIp: clientMeta.ip,
        cfRay: clientMeta.cfRay,
      });
      return jsonResponse(
        401,
        {
          ok: false,
          error: 'Google アカウントの認証が必要です。',
          detail:
            'Apps Script が認証リダイレクトを返しました。ブラウザで GAS_EXEC_URL を開いて Google アカウントの承認を完了してください。',
        },
        allowedOrigin || config.allowedOrigins[0] || '*',
        { 'X-ShiftFlow-Request-Id': requestId }
      );
    }
    logAuthError('Failed to reach GAS', {
      requestId,
      route,
      email: tokenDetails.email || '',
      message: err && err.message ? err.message : String(err),
    });
    captureDiagnostics(config, 'error', 'gas_unreachable', {
      event: 'gas_unreachable',
      requestId,
      route,
      email: tokenDetails.email || '',
      detail: err && err.message ? err.message : String(err),
      clientIp: clientMeta.ip,
      cfRay: clientMeta.cfRay,
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

  let inspectedResponseJson = null;
  if (dualWriteContext) {
    inspectedResponseJson = await parseJsonResponseSafe(upstreamResponse.clone());
    await performDualWriteIfNeeded({
      env,
      config,
      route,
      requestId,
      tokenDetails,
      accessContext,
      dualWriteContext,
      responseJson: inspectedResponseJson,
      clientMeta,
    });
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
