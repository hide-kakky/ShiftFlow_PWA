const DIAGNOSTIC_LEVELS = new Set(['warn', 'error']);
const ALLOWED_META_KEYS = new Set([
  'event',
  'requestId',
  'route',
  'status',
  'detail',
  'httpStatus',
  'cfRay',
  'source',
  'reasonCode',
  'phase',
  'required',
  'role',
  'orgId',
  'userId',
]);
const BLOCKED_KEY_PATTERN =
  /(secret|authorization|authheader|token|cookie|raw|responseheader|redirectlocation|payload|body)/i;

function normalizeText(value, maxLength = 500) {
  if (value === null || value === undefined) return '';
  const normalized = String(value);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function redactSensitiveText(value) {
  return normalizeText(value)
    .replace(/\b(https?:\/\/)[^/\s?#]*@/gi, '$1[masked-userinfo]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[masked-email]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [masked]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[masked-jwt]')
    .replace(
      /([?&](?:access[_-]?token|id[_-]?token|refresh[_-]?token|token|code|client[_-]?secret|api[_-]?key|key|secret|password|passwd|credential|authorization|session)=)[^&#\s]+/gi,
      '$1[masked]'
    )
    .replace(
      /\b(authorization|cookie|session|access[_-]?token|id[_-]?token|refresh[_-]?token|token|client[_-]?secret|api[_-]?key|key|secret|password|passwd|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[masked]'
    )
    .replace(
      /\b(?:[A-Za-z0-9]+[-_])*(?:secret|token|password|credential)(?:[-_][A-Za-z0-9]+)+\b/gi,
      '[masked-secret]'
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[masked-secret]');
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeValue(entry));
  }
  if (typeof value === 'object') {
    const safe = {};
    Object.entries(value)
      .slice(0, 10)
      .forEach(([key, entry]) => {
        if (!key || BLOCKED_KEY_PATTERN.test(key)) return;
        const normalized = sanitizeValue(entry);
        if (normalized !== undefined) safe[key] = normalized;
      });
    return safe;
  }
  return normalizeText(value);
}

export function sanitizeDiagnosticMeta(meta) {
  const safe = {};
  if (!meta || typeof meta !== 'object') return safe;
  Object.entries(meta).forEach(([key, value]) => {
    if (!ALLOWED_META_KEYS.has(key) || BLOCKED_KEY_PATTERN.test(key)) return;
    const normalized = sanitizeValue(value);
    if (normalized !== undefined) safe[key] = normalized;
  });
  return safe;
}

export function createDiagnosticsPayload(level, message, meta, now = Date.now()) {
  const normalizedLevel = String(level || '').trim().toLowerCase();
  if (!DIAGNOSTIC_LEVELS.has(normalizedLevel)) return null;
  const safeMeta = sanitizeDiagnosticMeta(meta);
  const safeMessage = redactSensitiveText(message);
  return {
    level: normalizedLevel,
    message: normalizeText(safeMessage, 200),
    timestamp: new Date(now).toISOString(),
    createdAt: now,
    requestId: normalizeText(safeMeta.requestId, 128),
    event: normalizeText(safeMeta.event || safeMessage, 128),
    route: normalizeText(safeMeta.route, 256),
    email: '',
    status: normalizeText(safeMeta.status, 64),
    orgId: normalizeText(safeMeta.orgId, 128),
    userId: normalizeText(safeMeta.userId, 128),
    cfRay: normalizeText(safeMeta.cfRay, 128),
    source: 'cf-api',
    meta: safeMeta,
  };
}

function serializeMeta(meta) {
  try {
    const raw = JSON.stringify(meta || {});
    return raw.length > 4000 ? raw.slice(0, 4000) : raw;
  } catch (_error) {
    return '{}';
  }
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const input = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(digest);
}

async function createDiagnosticLogId(payload) {
  const requestId = normalizeText(payload?.requestId, 128).replace(/[^A-Za-z0-9._:-]/g, '_');
  const event = normalizeText(payload?.event, 64).replace(/[^A-Za-z0-9._:-]/g, '_');
  const nonce = requestId
    ? ''
    : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}`;
  const material = [
    normalizeText(payload?.source, 64),
    event,
    requestId,
    normalizeText(payload?.route, 256),
    normalizeText(payload?.orgId, 128),
    normalizeText(payload?.userId, 128),
    nonce,
  ];
  return `diag:${await sha256Hex(material.join('\u0000'))}`;
}

export async function persistOperationalDiagnostic(db, payload) {
  if (!db || !payload) return { recorded: false };
  const result = await db
    .prepare(
      `
      INSERT OR IGNORE INTO auth_proxy_logs (
        log_id,
        level,
        event,
        message,
        request_id,
        route,
        email,
        status,
        meta_json,
        source,
        client_ip,
        user_agent,
        cf_ray,
        created_at_ms,
        org_id,
        user_id
      )
      VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, NULL, NULL, ?11, ?12, ?13, ?14
      )
    `
    )
    .bind(
      await createDiagnosticLogId(payload),
      payload.level,
      payload.event,
      payload.message,
      payload.requestId,
      payload.route,
      payload.email,
      payload.status,
      serializeMeta(payload.meta),
      payload.source,
      payload.cfRay,
      payload.createdAt,
      payload.orgId || null,
      payload.userId || null
    )
    .run();
  return { recorded: Number(result?.meta?.changes || 0) > 0 };
}

async function deliverDiagnostics(config, payload) {
  const jobs = [];
  if (config?.db) jobs.push(persistOperationalDiagnostic(config.db, payload));
  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length) {
    console.warn('[ShiftFlow][Diagnostics] delivery failed', {
      requestId: payload.requestId,
      event: payload.event,
      failedDestinations: failures.length,
    });
  }
}

/** 成功系infoは永続化せず、warn/errorだけをD1診断正本へ非同期保存する。 */
export function captureDiagnostics(config, level, message, meta) {
  const payload = createDiagnosticsPayload(level, message, meta);
  if (!payload) return false;
  const delivery = deliverDiagnostics(config, payload).catch((error) => {
    console.warn('[ShiftFlow][Diagnostics] unexpected delivery failure', {
      requestId: payload.requestId,
      event: payload.event,
      reasonCode: 'diagnostic_delivery_failed',
    });
  });
  if (typeof config?.waitUntil === 'function') {
    try {
      config.waitUntil(delivery);
    } catch (_error) {
      // waitUntilが利用できないtest環境では、上のPromiseをそのまま継続する。
    }
  }
  return true;
}
