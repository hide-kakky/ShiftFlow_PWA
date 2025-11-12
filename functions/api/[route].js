import { loadConfig, getRoutePermissions } from './config';
import {
  verifySession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  refreshGoogleTokens,
  calculateIdTokenExpiry,
  updateSessionTokens,
  touchSession,
} from '../utils/session';
import { verifyGoogleIdToken } from '../utils/googleIdToken';
import {
  PROFILE_PLACEHOLDER_URL,
  PROFILE_IMAGE_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_LIMIT,
  ALLOWED_IMAGE_MIME_TYPES,
  MIME_EXTENSION_MAP,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSE_HEADERS,
  REDIRECT_STATUSES,
  SENSITIVE_META_KEYWORDS,
  ACTIVE_ACCESS_CACHE_TTL_MS,
  DIAGNOSTIC_ROUTE,
} from './constants';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ACCESS_CACHE = new Map();

function sanitizeLogMeta(meta) {
  if (!meta || typeof meta !== 'object') {
    return meta;
  }
  if (Array.isArray(meta)) {
    return meta.map((item) => sanitizeLogMeta(item));
  }
  const sanitized = {};
  Object.entries(meta).forEach(([key, value]) => {
    if (!key) return;
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_META_KEYWORDS.some((keyword) => lowerKey.includes(keyword))) {
      sanitized[key] = '[masked]';
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeLogMeta(value);
    } else {
      sanitized[key] = value;
    }
  });
  return sanitized;
}

function logAuthInfo(message, meta) {
  if (meta) {
    console.info('[ShiftFlow][Auth]', message, sanitizeLogMeta(meta));
  } else {
    console.info('[ShiftFlow][Auth]', message);
  }
}

function logAuthError(message, meta) {
  if (meta) {
    console.error('[ShiftFlow][Auth]', message, sanitizeLogMeta(meta));
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
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
    Vary: 'Origin',
  };
}

function jsonResponse(status, payload, origin, requestIdOrHeaders, maybeHeaders) {
  let requestId = '';
  let extraHeaders = undefined;
  if (typeof requestIdOrHeaders === 'string') {
    requestId = requestIdOrHeaders;
    extraHeaders = maybeHeaders;
  } else if (
    requestIdOrHeaders &&
    typeof requestIdOrHeaders === 'object' &&
    !(requestIdOrHeaders instanceof Headers)
  ) {
    extraHeaders = requestIdOrHeaders;
  }
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...corsHeaders(origin),
  });
  if (requestId) {
    headers.set('X-ShiftFlow-Request-Id', requestId);
  }
  let bodyPayload = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    bodyPayload = { ...payload };
    const isErrorPayload =
      bodyPayload.ok === false ||
      (typeof bodyPayload.ok === 'undefined' &&
        (typeof bodyPayload.error === 'string' || typeof bodyPayload.reason === 'string'));
    if (isErrorPayload) {
      const derivedReason =
        typeof bodyPayload.reason === 'string' && bodyPayload.reason
          ? bodyPayload.reason
          : typeof bodyPayload.error === 'string' && bodyPayload.error
          ? bodyPayload.error
          : `Request failed (${status})`;
      bodyPayload.ok = false;
      bodyPayload.reason = derivedReason;
      bodyPayload.where =
        typeof bodyPayload.where === 'string' && bodyPayload.where
          ? bodyPayload.where
          : 'cf-api';
      bodyPayload.code =
        typeof bodyPayload.code === 'string' && bodyPayload.code
          ? bodyPayload.code
          : typeof bodyPayload.errorCode === 'string' && bodyPayload.errorCode
          ? bodyPayload.errorCode
          : 'error';
      bodyPayload.requestId = requestId;
    } else if (requestId && typeof bodyPayload.requestId !== 'string') {
      bodyPayload.requestId = requestId;
    }
  } else if (requestId) {
    bodyPayload = {
      ok: false,
      where: 'cf-api',
      code: 'invalid_payload',
      reason: 'Invalid payload',
      requestId,
    };
  }
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.entries(extraHeaders).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        headers.set(key, String(value));
      }
    });
  }
  return new Response(JSON.stringify(bodyPayload), {
    status,
    headers,
  });
}

function errorResponse(status, origin, requestId, where, code, reason, extraPayload, extraHeaders) {
  const payload = {
    ok: false,
    where,
    code,
    reason,
    requestId,
    ...(extraPayload || {}),
  };
  return jsonResponse(status, payload, origin, requestId, extraHeaders);
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

function generateTaskId() {
  return generateMessageId();
}

function normalizeEmailValue(value) {
  if (!value) return '';
  return String(value).trim().toLowerCase();
}

function parseTaskDueDate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  let iso = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = `${raw}T00:00:00+09:00`;
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    const normalized = raw.replace(/\//g, '-');
    iso = `${normalized}T00:00:00+09:00`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    iso = `${raw}+09:00`;
  }
  let timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    timestamp = Date.parse(raw);
  }
  return Number.isNaN(timestamp) ? null : timestamp;
}

function mapTaskStatus(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const lower = raw.toLowerCase();
  const mapping = {
    未着手: 'open',
    todo: 'open',
    open: 'open',
    進行中: 'in_progress',
    対応中: 'in_progress',
    in_progress: 'in_progress',
    'in progress': 'in_progress',
    実行中: 'in_progress',
    完了: 'completed',
    完了済み: 'completed',
    completed: 'completed',
    done: 'completed',
    保留: 'on_hold',
    on_hold: 'on_hold',
    hold: 'on_hold',
    pending: 'pending',
    キャンセル: 'canceled',
    canceled: 'canceled',
    cancelled: 'canceled',
  };
  return mapping[raw] || mapping[lower] || 'open';
}

function mapTaskPriority(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim();
  const lower = raw.toLowerCase();
  const mapping = {
    高: 'high',
    high: 'high',
    中: 'medium',
    normal: 'medium',
    medium: 'medium',
    低: 'low',
    low: 'low',
  };
  return mapping[raw] || mapping[lower] || 'medium';
}

function deriveTaskAssigneeEmails(payload, fallbackEmail) {
  const emails = new Set();
  const addEmail = (candidate) => {
    const normalized = normalizeEmailValue(candidate);
    if (normalized) emails.add(normalized);
  };
  if (payload) {
    if (Array.isArray(payload.assignees)) {
      payload.assignees.forEach(addEmail);
    }
    if (payload.assignee) {
      addEmail(payload.assignee);
    }
    if (typeof payload.assigneeEmail === 'string') {
      addEmail(payload.assigneeEmail);
    }
    if (typeof payload.assigneeEmails === 'string') {
      payload.assigneeEmails
        .split(/[,;、]/)
        .map((item) => item.trim())
        .forEach(addEmail);
    }
  }
  if (!emails.size && fallbackEmail) {
    addEmail(fallbackEmail);
  }
  return Array.from(emails);
}

function buildTaskMetaJson(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const meta = {};
  if (payload.repeatRule) meta.repeatRule = payload.repeatRule;
  if (payload.parentTaskId) meta.parentTaskId = payload.parentTaskId;
  if (payload.attachments) meta.attachments = payload.attachments;
  if (payload.meta) meta.sourceMeta = payload.meta;
  if (payload.note) meta.note = payload.note;
  if (payload.status) meta.rawStatus = payload.status;
  if (payload.priority) meta.rawPriority = payload.priority;
  const keys = Object.keys(meta);
  if (!keys.length) return null;
  try {
    return JSON.stringify(meta);
  } catch (_err) {
    return null;
  }
}

function normalizeIdValue(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function mergeMetaJson(existingJson, newJsonString) {
  if (!newJsonString) return existingJson || null;
  try {
    const newMeta = JSON.parse(newJsonString);
    const existingMeta = existingJson ? JSON.parse(existingJson) : {};
    const merged = { ...existingMeta, ...newMeta };
    return JSON.stringify(merged);
  } catch (_err) {
    return newJsonString;
  }
}

function normalizeRoleValue(role) {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (!value) return '';
  if (value === 'administrator') return 'admin';
  if (value === 'manager' || value === 'admin') return value;
  if (value === 'member' || value === 'guest') return value;
  return value;
}

function normalizeUserStatusValue(status) {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!value) return 'pending';
  if (value === 'active' || value === 'pending' || value === 'suspended') return value;
  if (value === 'revoked') return 'revoked';
  if (value === 'disabled' || value === 'inactive') return 'suspended';
  return 'pending';
}

function deriveStatusReason(status) {
  switch ((status || '').toLowerCase()) {
    case 'pending':
      return '承認待ちです。管理者の承認をお待ちください。';
    case 'suspended':
      return '利用が停止されています。管理者にお問い合わせください。';
    case 'revoked':
      return 'アクセス権が取り消されています。';
    default:
      return 'アクセスが制限されています。';
  }
}

function resolveAccessCacheKey(tokenDetails) {
  if (!tokenDetails) return '';
  if (tokenDetails.sub) return tokenDetails.sub;
  if (tokenDetails.email) return normalizeEmailValue(tokenDetails.email);
  return '';
}

function readAccessCache(cacheKey) {
  if (!cacheKey) return null;
  const entry = ACCESS_CACHE.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    ACCESS_CACHE.delete(cacheKey);
    return null;
  }
  const context = { ...entry.context };
  context.cached = true;
  context.cacheHit = true;
  return context;
}

function writeAccessCache(cacheKey, context, ttlMs, tokenDetails) {
  if (!cacheKey || !context) return;
  const baseTtl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : ACTIVE_ACCESS_CACHE_TTL_MS;
  const now = Date.now();
  let expiresAt = now + baseTtl;
  const tokenExpiryMs =
    tokenDetails && typeof tokenDetails.expMs === 'number' ? Number(tokenDetails.expMs) : 0;
  if (tokenExpiryMs > 0) {
    expiresAt = Math.min(expiresAt, tokenExpiryMs - 5000);
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return;
  }
  const contextCopy = { ...context };
  delete contextCopy.cached;
  delete contextCopy.cacheHit;
  ACCESS_CACHE.set(cacheKey, {
    context: contextCopy,
    expiresAt,
  });
}

async function resolveAccessContextFromD1(db, tokenDetails, requestId) {
  if (!db || !tokenDetails) return null;
  const email = normalizeEmailValue(tokenDetails.email);
  if (!email) return null;
  let row;
  try {
    row = await db
      .prepare(
        `
        SELECT
          users.user_id,
          users.email,
          users.display_name,
          users.status AS user_status,
          users.auth_subject,
          users.is_active,
          memberships.membership_id,
          memberships.role,
          memberships.status AS membership_status,
          memberships.org_id
        FROM users
        LEFT JOIN memberships
          ON memberships.user_id = users.user_id
        WHERE lower(users.email) = ?1
        ORDER BY
          CASE
            WHEN memberships.status IS NULL THEN 0
            WHEN LOWER(memberships.status) = 'active' THEN 0
            ELSE 1
          END,
          CASE
            WHEN memberships.created_at_ms IS NULL THEN 9223372036854775807
            ELSE memberships.created_at_ms
          END ASC
        LIMIT 1
      `
      )
      .bind(email)
      .first();
  } catch (err) {
    console.warn('[ShiftFlow][Auth] Failed to query D1 for access context', {
      requestId,
      email,
      message: err && err.message ? err.message : String(err),
    });
    return null;
  }
  if (!row) {
    logAuthInfo('No D1 access record found', { requestId, email });
    return null;
  }
  const storedSubject = typeof row.auth_subject === 'string' ? row.auth_subject.trim() : '';
  if (storedSubject && tokenDetails.sub && storedSubject !== tokenDetails.sub) {
    const mismatchContext = {
      allowed: false,
      status: 'pending',
      role: 'guest',
      email: row.email || tokenDetails.email || '',
      displayName: row.display_name || tokenDetails.name || '',
      reason: '登録済みの Google アカウントと一致しません。管理者に連絡してください。',
      userId: row.user_id || '',
      authSubject: storedSubject,
      source: 'd1',
      reasonCode: 'subject_mismatch',
    };
    logAuthInfo('D1 auth subject mismatch; rejecting token', {
      requestId,
      email: mismatchContext.email,
    });
    return mismatchContext;
  }
  const userStatusRaw =
    row.user_status != null && row.user_status !== ''
      ? row.user_status
      : row.is_active === 0
      ? 'suspended'
      : 'active';
  const membershipStatusRaw =
    row.membership_status != null && row.membership_status !== ''
      ? row.membership_status
      : row.membership_id
      ? 'active'
      : '';
  const userStatus = normalizeUserStatusValue(userStatusRaw);
  const membershipStatus = normalizeUserStatusValue(membershipStatusRaw);
  let status = userStatus || 'pending';
  if (status === 'active') {
    status = membershipStatus || 'active';
  }
  if (!status) status = 'pending';
  const allowed = status === 'active';
  const role = normalizeRoleValue(row.role || 'member') || 'member';
  const context = {
    allowed,
    status,
    role,
    email: row.email || tokenDetails.email || '',
    displayName: row.display_name || tokenDetails.name || '',
    reason: allowed ? '' : deriveStatusReason(status),
    userId: row.user_id || '',
    authSubject: storedSubject,
    source: 'd1',
    reasonCode: allowed ? 'active' : status || 'unknown',
  };
  logAuthInfo('Resolved access context via D1', {
    requestId,
    email: context.email,
    role: context.role,
    status: context.status,
  });
  return context;
}

function jsonResponseFromD1(status, payload, origin, requestId, extraHeaders) {
  return jsonResponse(status, payload, origin, requestId, {
    'X-ShiftFlow-Cache': 'BYPASS',
    'X-ShiftFlow-Backend': 'D1',
    ...(extraHeaders || {}),
  });
}

function sanitizeFileBaseName(name, fallback = 'file') {
  if (typeof name !== 'string') return fallback;
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const lastSegment = segments.length ? segments[segments.length - 1] : trimmed;
  const withoutExt =
    lastSegment.includes('.') && lastSegment.lastIndexOf('.') > 0
      ? lastSegment.slice(0, lastSegment.lastIndexOf('.'))
      : lastSegment;
  const normalized = withoutExt.replace(/[^0-9A-Za-z_.-]+/g, '_').replace(/_+/g, '_');
  const candidate = normalized || fallback;
  return candidate.slice(0, 64);
}

function guessExtensionFromMime(mimeType) {
  if (!mimeType) return '';
  const normalized = mimeType.trim().toLowerCase();
  return MIME_EXTENSION_MAP[normalized] || '';
}

function decodeDataUri(dataUri) {
  if (typeof dataUri !== 'string') return null;
  const trimmed = dataUri.trim();
  if (!trimmed) return null;
  const commaIndex = trimmed.indexOf(',');
  if (!trimmed.startsWith('data:') || commaIndex === -1) return null;
  const header = trimmed.slice(5, commaIndex);
  const dataPart = trimmed.slice(commaIndex + 1).trim();
  if (!dataPart) return null;
  const metaParts = header.split(';').map((part) => part.trim()).filter(Boolean);
  let mimeType = metaParts.length ? metaParts[0] : '';
  const isBase64 = metaParts.includes('base64');
  if (!isBase64) return null;
  if (!mimeType) mimeType = 'application/octet-stream';
  let binaryString;
  try {
    binaryString = atob(dataPart.replace(/\s+/g, ''));
  } catch (_err) {
    return null;
  }
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return {
    mimeType: mimeType.toLowerCase(),
    bytes,
  };
}

async function computeSha256Hex(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('ArrayBuffer is required for checksum calculation.');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  view.forEach((byte) => {
    hex += byte.toString(16).padStart(2, '0');
  });
  return hex;
}

function buildAttachmentDownloadPath(attachmentId) {
  const id = normalizeIdValue(attachmentId);
  if (!id) return '';
  return `/api/downloadAttachment?attachmentId=${encodeURIComponent(id)}`;
}

function extractAttachmentIdFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed =
      url.startsWith('http://') || url.startsWith('https://') ? new URL(url) : new URL(url, 'https://dummy.local');
    let pathname = parsed.pathname || '';
    if (pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    if (pathname !== '/api/downloadAttachment') {
      return '';
    }
    const id = parsed.searchParams.get('attachmentId');
    return normalizeIdValue(id);
  } catch (_err) {
    return '';
  }
}

function generateAttachmentId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function buildContentDisposition(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'inline';
  }
  const asciiName = filename.replace(/[^0-9A-Za-z()._\- ]+/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(filename);
  return `inline; filename="${asciiName || 'file'}"; filename*=UTF-8''${utf8}`;
}

async function storeDataUriInR2(env, options) {
  if (!env || !env.R2) {
    const err = new Error('R2 bucket is not configured.');
    err.code = 'r2_unavailable';
    throw err;
  }
  const dataUri = typeof options?.dataUri === 'string' ? options.dataUri : '';
  const parsed = decodeDataUri(dataUri);
  if (!parsed) {
    const err = new Error('Invalid image data.');
    err.code = 'invalid_data_uri';
    throw err;
  }
  const mimeType = parsed.mimeType;
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    const err = new Error('Unsupported MIME type.');
    err.code = 'unsupported_mime_type';
    throw err;
  }
  const byteLength = parsed.bytes.byteLength;
  const maxBytes = Number(options?.maxBytes) || PROFILE_IMAGE_MAX_BYTES;
  if (byteLength > maxBytes) {
    const err = new Error('File size exceeds allowed limit.');
    err.code = 'file_too_large';
    throw err;
  }
  const attachmentId = normalizeIdValue(options?.attachmentId) || generateAttachmentId();
  const fileNameHint = typeof options?.fileNameHint === 'string' ? options.fileNameHint : '';
  const baseName = sanitizeFileBaseName(fileNameHint || attachmentId);
  const extension = guessExtensionFromMime(mimeType) || 'bin';
  const finalFileName = `${baseName}.${extension}`;
  const keyPrefix = typeof options?.keyPrefix === 'string' && options.keyPrefix ? options.keyPrefix : 'uploads';
  const key = `${keyPrefix}/${attachmentId}/${finalFileName}`;
  const buffer = parsed.bytes.buffer.slice(parsed.bytes.byteOffset, parsed.bytes.byteOffset + parsed.bytes.byteLength);
  const checksum = await computeSha256Hex(buffer);
  await env.R2.put(key, buffer, {
    httpMetadata: {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000',
      contentDisposition: buildContentDisposition(finalFileName),
    },
  });
  return {
    attachmentId,
    key,
    mimeType,
    size: byteLength,
    checksum,
    fileName: finalFileName,
  };
}

function getPrimarySharedSecret(config) {
  if (!config) return '';
  if (Array.isArray(config.sharedSecrets) && config.sharedSecrets.length) {
    return config.sharedSecrets[0];
  }
  return config.sharedSecret || '';
}

function isManagerRole(role) {
  const normalized = normalizeRoleValue(role);
  return normalized === 'admin' || normalized === 'manager';
}

function formatJst(dateInput, withTime = false) {
  if (dateInput === null || dateInput === undefined) return '';
  let date;
  if (dateInput instanceof Date) {
    date = new Date(dateInput.getTime());
  } else if (typeof dateInput === 'number') {
    date = new Date(dateInput);
  } else if (typeof dateInput === 'string') {
    const parsed = Date.parse(dateInput);
    if (Number.isNaN(parsed)) return '';
    date = new Date(parsed);
  } else {
    return '';
  }
  if (Number.isNaN(date.getTime())) return '';
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const jst = new Date(utc + 9 * 60 * 60000);
  const pad = (num) => String(num).padStart(2, '0');
  const year = jst.getFullYear();
  const month = pad(jst.getMonth() + 1);
  const day = pad(jst.getDate());
  if (!withTime) {
    return `${year}-${month}-${day}`;
  }
  const hour = pad(jst.getHours());
  const minute = pad(jst.getMinutes());
  const second = pad(jst.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatJstMonthDay(dateInput) {
  const formatted = formatJst(dateInput, true);
  if (!formatted) return '';
  const [year, month, day] = formatted.split(/[ T]/)[0].split('-');
  return `${Number(month)}\/${Number(day)}`;
}

function mapD1StatusToLegacy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'completed':
      return '完了';
    case 'in_progress':
      return '対応中';
    case 'open':
      return '未着手';
    case 'on_hold':
      return '保留';
    case 'pending':
      return '保留';
    case 'canceled':
    case 'cancelled':
      return 'キャンセル';
    default:
      return value || '';
  }
}

function mapD1PriorityToLegacy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'high':
      return '高';
    case 'low':
      return '低';
    case 'medium':
    default:
      return '中';
  }
}

function priorityWeight(priority) {
  const normalized = typeof priority === 'string' ? priority.trim() : '';
  if (normalized === '高') return 1;
  if (normalized === '中') return 2;
  if (normalized === '低') return 3;
  return 4;
}

function startOfTodayMs() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function computeTaskBucket(task, todayMs) {
  if (task.isCompleted) return 3;
  if (task.dueValue == null) return 2;
  if (task.dueValue < todayMs) return 0;
  return 1;
}

function compareTasksForList(a, b, todayMs) {
  const bucketA = computeTaskBucket(a, todayMs);
  const bucketB = computeTaskBucket(b, todayMs);
  if (bucketA !== bucketB) return bucketA - bucketB;

  const dueA = a.dueValue != null ? a.dueValue : Number.MAX_SAFE_INTEGER;
  const dueB = b.dueValue != null ? b.dueValue : Number.MAX_SAFE_INTEGER;
  if (dueA !== dueB) return dueA - dueB;

  const priorityDiff = priorityWeight(a.priority || '中') - priorityWeight(b.priority || '中');
  if (priorityDiff !== 0) return priorityDiff;

  const createdA = a.createdAt != null ? -a.createdAt : 0;
  const createdB = b.createdAt != null ? -b.createdAt : 0;
  if (createdA !== createdB) return createdA - createdB;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

function safeParseJson(input, fallback = {}) {
  if (typeof input !== 'string' || !input.trim()) return fallback;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_err) {
    return fallback;
  }
}

function coerceFlagValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return null;
}

async function readFlagOverridesFromKv(kv, key) {
  if (!kv || !key) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    let payload = raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      payload = JSON.parse(trimmed);
    }
    if (!payload || typeof payload !== 'object') return null;
    const overrides = {};
    Object.entries(payload).forEach(([flagKey, flagValue]) => {
      const coerced = coerceFlagValue(flagValue);
      if (coerced === null) return;
      overrides[flagKey] = coerced;
    });
    return Object.keys(overrides).length ? overrides : null;
  } catch (err) {
    console.warn('[ShiftFlow][Flags] Failed to load KV flag overrides', {
      key,
      error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function fetchAssigneesForTasks(db, taskIds) {
  const assigneeMap = new Map();
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return assigneeMap;
  }
  const placeholders = taskIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const statement = db.prepare(
    `SELECT task_id, email FROM task_assignees WHERE task_id IN (${placeholders})`
  );
  const result = await statement.bind(...taskIds).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  for (const row of rows) {
    if (!row || !row.task_id) continue;
    const list = assigneeMap.get(row.task_id) || [];
    if (row.email) {
      list.push(String(row.email).trim());
    }
    assigneeMap.set(row.task_id, list);
  }
  return assigneeMap;
}

function buildTaskRecordFromD1(row, assignees) {
  if (!row) return null;
  const meta = safeParseJson(row.meta_json, {});
  const dueMs =
    typeof row.due_at_ms === 'number' && Number.isFinite(row.due_at_ms) ? row.due_at_ms : null;
  const createdMs =
    typeof row.created_at_ms === 'number' && Number.isFinite(row.created_at_ms)
      ? row.created_at_ms
      : null;
  const updatedMs =
    typeof row.updated_at_ms === 'number' && Number.isFinite(row.updated_at_ms)
      ? row.updated_at_ms
      : createdMs;
  const priority = mapD1PriorityToLegacy(row.priority);
  const status = mapD1StatusToLegacy(row.status);
  const normalizedAssignees = Array.isArray(assignees) ? assignees.map((email) => String(email)) : [];
  return {
    id: row.task_id,
    title: row.title || 'Untitled Task',
    assignee: normalizedAssignees.length ? normalizedAssignees[0] : '',
    assignees: normalizedAssignees,
    dueDate: dueMs ? formatJst(dueMs, false) : '',
    dueValue: dueMs,
    status,
    priority,
    createdBy: row.created_by_email || '',
    createdAt: createdMs,
    createdAtRaw: createdMs ? formatJst(createdMs, true) : '',
    updatedAt: updatedMs,
    updatedAtValue: updatedMs,
    repeatRule: meta.repeatRule || '',
    isCompleted: status === '完了',
  };
}

function buildMessagePreview(body) {
  const text = typeof body === 'string' ? body : '';
  if (text.length <= 80) return text;
  return text.slice(0, 78).trimEnd() + '...';
}

async function fetchActiveUsersForOrg(db, orgId) {
  const result = await db
    .prepare(
      `
      SELECT u.email AS email,
             COALESCE(u.display_name, u.email) AS display_name
        FROM memberships ms
        JOIN users u ON u.user_id = ms.user_id
       WHERE (?1 IS NULL OR ms.org_id = ?1)
         AND LOWER(COALESCE(ms.status, 'active')) = 'active'
    `
    )
    .bind(orgId || null)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows
    .map((row) => ({
      email: row?.email ? String(row.email).trim() : '',
      displayName: row?.display_name ? String(row.display_name).trim() : '',
    }))
    .filter((entry) => entry.email);
}

function buildUserLabel(email, displayName) {
  const trimmedName = typeof displayName === 'string' ? displayName.trim() : '';
  if (trimmedName) return trimmedName;
  return typeof email === 'string' ? email.trim() : '';
}

async function fetchActiveFoldersFromD1(db) {
  const result = await db
    .prepare(
      `
      SELECT DISTINCT TRIM(COALESCE(folder_id, '')) AS folder_id
        FROM messages
    `
    )
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const folders = [];
  const seen = new Set();
  const pushFolder = (id, name) => {
    const normalizedId = (id || '').trim();
    if (!normalizedId || seen.has(normalizedId)) return;
    seen.add(normalizedId);
    folders.push({ id: normalizedId, name: name || normalizedId });
  };
  pushFolder('全体', '全体');
  for (const row of rows) {
    const value = row?.folder_id ? String(row.folder_id).trim() : '';
    if (!value) continue;
    pushFolder(value, value);
  }
  if (!folders.length) {
    pushFolder('全体', '全体');
    pushFolder('ブッフェ', 'ブッフェ');
    pushFolder('レセプション', 'レセプション');
    pushFolder('ホール', 'ホール');
  }
  return folders;
}

async function buildMyTasksPayload(db, rawEmail) {
  const normalizedEmail = normalizeEmailValue(rawEmail);
  const totalRow = await db.prepare('SELECT COUNT(*) AS count FROM tasks').first();
  const totalTasks =
    typeof totalRow?.count === 'number'
      ? totalRow.count
      : typeof totalRow?.['COUNT(*)'] === 'number'
      ? totalRow['COUNT(*)']
      : 0;
  if (!normalizedEmail) {
    return {
      tasks: [],
      meta: {
        totalTasks,
        matchedTasks: 0,
        rawEmail,
        normalizedEmail: '',
        sampleTaskIds: [],
        note:
          'ログインユーザーのメールアドレスが取得できません。Webアプリの公開設定と組織ポリシーを確認してください。',
      },
    };
  }
  const assignedResult = await db
    .prepare(
      `
      SELECT DISTINCT t.*
        FROM tasks t
        JOIN task_assignees ta ON ta.task_id = t.task_id
       WHERE ta.email = ?1
    `
    )
    .bind(normalizedEmail)
    .all();
  const rows = Array.isArray(assignedResult?.results) ? assignedResult.results : [];
  const assigneeMap = await fetchAssigneesForTasks(
    db,
    rows.map((row) => row.task_id)
  );
  const tasks = rows
    .map((row) => buildTaskRecordFromD1(row, assigneeMap.get(row.task_id) || []))
    .filter(Boolean);
  const todayMs = startOfTodayMs();
  tasks.sort((a, b) => compareTasksForList(a, b, todayMs));
  return {
    tasks,
    meta: {
      totalTasks,
      matchedTasks: tasks.length,
      rawEmail,
      normalizedEmail,
      sampleTaskIds: tasks.slice(0, 5).map((task) => task.id),
      note: '',
    },
  };
}

async function fetchMessageAttachments(db, messageId) {
  const result = await db
    .prepare(
      `
      SELECT a.attachment_id,
             a.file_name,
             a.content_type,
             a.size_bytes,
             a.storage_path,
             a.extra_json
        FROM message_attachments ma
        JOIN attachments a ON a.attachment_id = ma.attachment_id
       WHERE ma.message_id = ?1
    `
    )
    .bind(messageId)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.map((row) => {
    const extras = safeParseJson(row?.extra_json || null, {});
    return {
      name: row?.file_name || '',
      mimeType: row?.content_type || '',
      size: typeof row?.size_bytes === 'number' ? row.size_bytes : null,
      url: row?.storage_path || extras?.url || '',
    };
  });
}

async function buildMessagesForUser(db, options) {
  const folderRaw = typeof options?.folderId === 'string' ? options.folderId.trim() : '';
  const folderFilter =
    folderRaw && folderRaw.toLowerCase() !== 'all' ? folderRaw : '';
  const membershipId = options?.membershipId || null;
  const result = await db
    .prepare(
      `
      SELECT m.message_id,
             m.title,
             m.body,
             m.folder_id,
             m.created_at_ms,
             m.updated_at_ms,
             CASE WHEN mr.message_id IS NOT NULL THEN 1 ELSE 0 END AS is_read
        FROM messages m
        LEFT JOIN message_reads mr
          ON mr.message_id = m.message_id
         AND mr.membership_id = ?2
       WHERE (?1 = '' OR m.folder_id = ?1)
    `
    )
    .bind(folderFilter, membershipId)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const items = rows.map((row) => {
    const createdAtMs =
      typeof row?.created_at_ms === 'number' && Number.isFinite(row.created_at_ms)
        ? row.created_at_ms
        : 0;
    const priority = mapD1PriorityToLegacy(row?.priority);
    return {
      id: row?.message_id || '',
      title: row?.title || '',
      body: typeof row?.body === 'string' ? row.body : '',
      preview: buildMessagePreview(row?.body || ''),
      priority: priority || '中',
      folderId: row?.folder_id || '',
      isRead: row?.is_read ? true : false,
      createdAt: createdAtMs,
    };
  });
  items.sort((a, b) => {
    if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
    const priorityDiff = priorityWeight(a.priority || '中') - priorityWeight(b.priority || '中');
    if (priorityDiff !== 0) return priorityDiff;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  return items;
}

function createLegacyTokenDetails(rawToken) {
  return {
    rawToken,
    sub: '',
    email: '',
    emailVerified: true,
    name: '',
    picture: '',
    hd: '',
    aud: '',
    iss: '',
    iat: 0,
    exp: 0,
    iatMs: undefined,
    expMs: undefined,
  };
}

function interceptRequestBodyForRoute(route, body, context) {
  if (!body || typeof body !== 'object') {
    return { body, mutated: false, dualWriteContext: null };
  }
  const flags = context?.flags || {};
  if (route === 'addNewMessage' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const originalPayload =
      argsArray.length && argsArray[0] && typeof argsArray[0] === 'object' ? argsArray[0] : {};
    const messagePayload = { ...originalPayload };
    let mutated = false;
    if (!messagePayload.messageId || typeof messagePayload.messageId !== 'string') {
      messagePayload.messageId = generateMessageId();
      mutated = true;
    }
    if (argsArray.length) {
      argsArray[0] = messagePayload;
      mutatedBody.args = argsArray;
    } else {
      mutatedBody.args = [messagePayload];
    }
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'message',
        messageId: messagePayload.messageId,
        payload: messagePayload,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'addNewTask' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const originalPayload =
      argsArray.length && argsArray[0] && typeof argsArray[0] === 'object' ? argsArray[0] : {};
    const taskPayload = { ...originalPayload };
    let mutated = false;
    if (!taskPayload.taskId || typeof taskPayload.taskId !== 'string' || !taskPayload.taskId.trim()) {
      taskPayload.taskId = generateTaskId();
      mutated = true;
    } else {
      taskPayload.taskId = taskPayload.taskId.trim();
    }
    if (Array.isArray(taskPayload.assignees)) {
      taskPayload.assignees = taskPayload.assignees
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean);
    }
    if (argsArray.length) {
      argsArray[0] = taskPayload;
      mutatedBody.args = argsArray;
    } else {
      mutatedBody.args = [taskPayload];
    }
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'task',
        taskId: taskPayload.taskId,
        payload: taskPayload,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'updateTask' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const originalPayload =
      argsArray.length && argsArray[0] && typeof argsArray[0] === 'object' ? argsArray[0] : {};
    const taskPayload = { ...originalPayload };
    const taskId = normalizeIdValue(taskPayload.id || taskPayload.taskId || taskPayload.task_id);
    if (argsArray.length) {
      argsArray[0] = taskPayload;
      mutatedBody.args = argsArray;
    } else {
      mutatedBody.args = [taskPayload];
    }
    return {
      body: mutatedBody,
      mutated: false,
      dualWriteContext: {
        type: 'task_update',
        taskId,
        payload: taskPayload,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'completeTask' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const taskIdRaw = argsArray.length ? argsArray[0] : '';
    const taskId = normalizeIdValue(taskIdRaw);
    const normalizedArgs = [taskId];
    const mutated = taskId !== taskIdRaw;
    mutatedBody.args = normalizedArgs;
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'task_complete',
        taskId,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'toggleMemoRead' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const memoIdRaw = argsArray.length ? argsArray[0] : '';
    const memoId = normalizeIdValue(memoIdRaw);
    const shouldRead =
      argsArray.length > 1 ? Boolean(argsArray[1]) : true;
    mutatedBody.args = [memoId, shouldRead];
    const mutated =
      memoId !== memoIdRaw || (argsArray.length > 1 && shouldRead !== argsArray[1]);
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'memo_read_toggle',
        messageId: memoId,
        shouldRead,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'deleteTaskById' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const rawTaskId = argsArray.length ? argsArray[0] : '';
    const taskId = normalizeIdValue(rawTaskId);
    mutatedBody.args = [taskId];
    const mutated = taskId !== rawTaskId;
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'task_delete',
        taskId,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'deleteMessageById' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const rawMessageId = argsArray.length ? argsArray[0] : '';
    const messageId = normalizeIdValue(rawMessageId);
    mutatedBody.args = [messageId];
    const mutated = messageId !== rawMessageId;
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'message_delete',
        messageId,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'markMemoAsRead' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const rawMemoId = argsArray.length ? argsArray[0] : '';
    const memoId = normalizeIdValue(rawMemoId);
    mutatedBody.args = [memoId];
    const mutated = memoId !== rawMemoId;
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'memo_mark_read',
        messageId: memoId,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'markMemosReadBulk' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const rawList = argsArray.length ? argsArray[0] : [];
    const memoIds = Array.isArray(rawList)
      ? rawList.map((id) => normalizeIdValue(id)).filter(Boolean)
      : [];
    mutatedBody.args = [memoIds];
    const mutated =
      Array.isArray(rawList) &&
      (rawList.length !== memoIds.length ||
        rawList.some((value, index) => normalizeIdValue(value) !== memoIds[index]));
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: 'memo_mark_read_bulk',
        messageIds: memoIds,
        timestampMs: Date.now(),
      },
    };
  }
  if (route === 'saveUserSettings' && flags.d1Write) {
    const mutatedBody = { ...body };
    const argsArray = Array.isArray(mutatedBody.args) ? [...mutatedBody.args] : [];
    const originalPayload =
      argsArray.length && argsArray[0] && typeof argsArray[0] === 'object' ? argsArray[0] : {};
    const payload = { ...originalPayload };
    if (argsArray.length) {
      argsArray[0] = payload;
      mutatedBody.args = argsArray;
    } else {
      mutatedBody.args = [payload];
    }
    const sanitizedContext = {
      name: typeof payload.name === 'string' ? payload.name : undefined,
      theme: typeof payload.theme === 'string' ? payload.theme : undefined,
      imageUrl: typeof payload.imageUrl === 'string' ? payload.imageUrl : undefined,
      imageData: typeof payload.imageData === 'string' ? payload.imageData : undefined,
      hasImageData: typeof payload.imageData === 'string' && payload.imageData.length > 0,
    };
    return {
      body: mutatedBody,
      mutated: false,
      dualWriteContext: {
        type: 'user_settings',
        payload: sanitizedContext,
        timestampMs: Date.now(),
      },
    };
  }
  return { body, mutated: false, dualWriteContext: null };
}

async function maybeHandleRouteWithD1(options) {
  if (!options) return null;
  const {
    route,
    flags,
    db,
    requestId,
    allowedOrigin,
    config,
    tokenDetails,
    accessContext,
    env,
    requestMethod,
    parsedBody,
    query,
    clientMeta,
  } = options;
  if (!db) {
    logAuthError('D1 database binding is missing', { requestId, route });
    return errorResponse(
      500,
      allowedOrigin || '*',
      requestId,
      'cf-api',
      'd1_unavailable',
      'D1 データベース接続が設定されていません。'
    );
  }
  const normalizedRoute = typeof route === 'string' ? route.trim() : '';
  if (!normalizedRoute) return null;

  try {
    if (normalizedRoute === 'getBootstrapData') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      let membership = null;
      if (normalizedEmail) {
        try {
          membership = await resolveMembershipForEmail(db, normalizedEmail);
        } catch (err) {
          console.warn('[ShiftFlow][D1] Failed to resolve membership for bootstrap', {
            requestId,
            email: normalizedEmail,
            error: err && err.message ? err.message : String(err),
          });
        }
      }
      let userRow = null;
      if (normalizedEmail) {
        userRow = await db
          .prepare(
            `
            SELECT user_id,
                   email,
                   display_name,
                   profile_image_url,
                   theme
              FROM users
             WHERE lower(email) = ?1
          `
          )
          .bind(normalizedEmail)
          .first();
      }
      const resolvedRole =
        membership?.role || accessContext?.role || userRow?.role || 'member';
      const userInfo = {
        email: userRow?.email || rawEmail || '',
        name: userRow?.display_name || accessContext?.displayName || 'ユーザー',
        imageUrl: userRow?.profile_image_url || PROFILE_PLACEHOLDER_URL,
        theme: userRow?.theme || 'light',
        role: resolvedRole,
      };
      const bootstrap = {
        userInfo,
        users: [],
        folders: [],
        myTasks: { tasks: [], meta: {} },
        isManager: isManagerRole(resolvedRole),
        theme: userInfo.theme || 'light',
      };
      const orgId = membership?.org_id || (await resolveDefaultOrgId(db));
      try {
        const usersResult = await db
          .prepare(
            `
            SELECT users.email AS email,
                   COALESCE(users.display_name, users.email) AS display_name,
                   COALESCE(memberships.role, 'member') AS role
              FROM memberships
              JOIN users ON users.user_id = memberships.user_id
             WHERE (?1 IS NULL OR memberships.org_id = ?1)
               AND LOWER(COALESCE(memberships.status, 'active')) = 'active'
               AND (users.is_active IS NULL OR users.is_active = 1)
               AND LOWER(COALESCE(users.status, 'active')) = 'active'
             ORDER BY LOWER(display_name) ASC, users.email ASC
          `
          )
          .bind(orgId || null)
          .all();
        const rows = Array.isArray(usersResult?.results) ? usersResult.results : [];
        bootstrap.users =
          rows.length > 0
            ? rows.map((row) => ({
                email: row.email,
                name: row.display_name || row.email || '',
                role: row.role ? String(row.role).trim() || 'member' : 'member',
              }))
            : [
                { id: '全体', name: '全体' },
                { id: 'ブッフェ', name: 'ブッフェ' },
                { id: 'レセプション', name: 'レセプション' },
                { id: 'ホール', name: 'ホール' },
              ];
      } catch (err) {
        bootstrap.users = [];
        bootstrap.usersError = err && err.message ? err.message : String(err);
      }
      try {
        bootstrap.folders = await fetchActiveFoldersFromD1(db);
      } catch (err) {
        bootstrap.folders = [];
        bootstrap.foldersError = err && err.message ? err.message : String(err);
      }
      try {
        bootstrap.myTasks = await buildMyTasksPayload(db, rawEmail);
      } catch (err) {
        bootstrap.myTasks = {
          tasks: [],
          meta: {
            error: err && err.message ? err.message : String(err),
          },
        };
      }
      captureDiagnostics(config, 'info', 'd1_route_served', {
        event: 'd1_route_served',
        route: normalizedRoute,
        requestId,
        email: userInfo.email || '',
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: bootstrap },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listActiveUsers') {
      const email = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      let orgId = null;
      if (email) {
        const membership = await resolveMembershipForEmail(db, email);
        orgId = membership?.org_id || null;
      }
      if (!orgId) {
        orgId = await resolveDefaultOrgId(db);
      }
      const result = await db
        .prepare(
          `
          SELECT users.email AS email,
                 COALESCE(users.display_name, users.email) AS display_name,
                 COALESCE(memberships.role, 'member') AS role
            FROM memberships
            JOIN users ON users.user_id = memberships.user_id
           WHERE (?1 IS NULL OR memberships.org_id = ?1)
             AND LOWER(COALESCE(memberships.status, 'active')) = 'active'
             AND (users.is_active IS NULL OR users.is_active = 1)
             AND LOWER(COALESCE(users.status, 'active')) = 'active'
           ORDER BY LOWER(display_name) ASC, users.email ASC
        `
        )
        .bind(orgId || null)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      const mapped =
        rows.length > 0
          ? rows.map((row) => ({
              email: row.email,
              name: row.display_name || row.email || '',
              role: row.role ? String(row.role).trim() || 'member' : 'member',
            }))
          : [
              { id: '全体', name: '全体' },
              { id: 'ブッフェ', name: 'ブッフェ' },
              { id: 'レセプション', name: 'レセプション' },
              { id: 'ホール', name: 'ホール' },
            ];
      logAuthInfo('Served route from D1', {
        requestId,
        route: normalizedRoute,
        orgId: orgId || '',
        count: mapped.length,
      });
      captureDiagnostics(config, 'info', 'd1_route_served', {
        event: 'd1_route_served',
        route: normalizedRoute,
        requestId,
        orgId: orgId || '',
        count: mapped.length,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: mapped },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listActiveFolders') {
      const folders = await fetchActiveFoldersFromD1(db);
      captureDiagnostics(config, 'info', 'd1_route_served', {
        event: 'd1_route_served',
        route: normalizedRoute,
        requestId,
        count: folders.length,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: folders },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getUserSettings') {
      const email = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      if (!email) return null;
      const user = await db
        .prepare(
          `
          SELECT user_id,
                 email,
                 display_name,
                 profile_image_url,
                 theme
            FROM users
           WHERE lower(email) = ?1
        `
        )
        .bind(email)
        .first();
      if (!user) {
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            result: {
              name: 'ゲスト',
              imageUrl: PROFILE_PLACEHOLDER_URL,
              imageName: '',
              role: accessContext?.role || 'guest',
              email: tokenDetails?.email || '',
              theme: 'light',
            },
          },
          allowedOrigin,
          requestId
        );
      }
      const membership = await db
        .prepare(
          `
          SELECT role
            FROM memberships
           WHERE user_id = ?1
           ORDER BY created_at_ms ASC
           LIMIT 1
        `
        )
        .bind(user.user_id)
        .first();
      const role = membership?.role || accessContext?.role || 'member';
      const result = {
        name: user.display_name || 'ユーザー',
        imageUrl: user.profile_image_url || PROFILE_PLACEHOLDER_URL,
        imageName: '',
        role,
        email: tokenDetails?.email || user.email || '',
        theme: user.theme || 'light',
      };
      captureDiagnostics(config, 'info', 'd1_route_served', {
        event: 'd1_route_served',
        route: normalizedRoute,
        requestId,
        email: result.email,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'saveUserSettings') {
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      if (!actorEmail) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'email_required',
          'ユーザーのメールアドレスが特定できません。'
        );
      }
      const bodyObject = parsedBody && typeof parsedBody === 'object' ? { ...parsedBody } : {};
      const interception = interceptRequestBodyForRoute(normalizedRoute, bodyObject, {
        flags,
        tokenDetails,
        accessContext,
      });
      const ctx = interception?.dualWriteContext;
      const payload = ctx?.payload ? { ...ctx.payload } : {};
      const timestampMs =
        ctx?.timestampMs && Number.isFinite(ctx.timestampMs) ? ctx.timestampMs : Date.now();
      const hasImageData = typeof payload.imageData === 'string' && payload.imageData.trim();
      const membership = await resolveMembershipForEmail(db, actorEmail);
      const userRow = await db
        .prepare(
          `
          SELECT user_id,
                 profile_image_url
            FROM users
           WHERE lower(email) = ?1
        `
        )
        .bind(actorEmail)
        .first();
      if (!userRow) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'user_not_found',
          '対象のユーザーが見つかりません。'
        );
      }
      const previousAttachmentId = extractAttachmentIdFromUrl(userRow.profile_image_url || '');
      let newAttachmentId = '';
      let newAttachmentUploaded = false;
      let attachmentFileName = '';
      if (hasImageData) {
        let upload = null;
        try {
          upload = await storeDataUriInR2(env, {
            dataUri: payload.imageData,
            maxBytes: PROFILE_IMAGE_MAX_BYTES,
            keyPrefix: membership?.org_id
              ? `orgs/${membership.org_id}/profiles`
              : 'profiles',
            fileNameHint: actorEmail ? actorEmail.split('@')[0] : 'profile',
          });
          const orgId =
            membership?.org_id ||
            (await resolveDefaultOrgId(db)) ||
            null;
          const storagePath = buildAttachmentDownloadPath(upload.attachmentId);
          await insertAttachmentRecord(db, {
            attachmentId: upload.attachmentId,
            orgId,
            fileName: upload.fileName,
            mimeType: upload.mimeType,
            sizeBytes: upload.size,
            storagePath,
            checksum: upload.checksum,
            createdAtMs: timestampMs,
            createdByMembershipId: membership?.membership_id || null,
            extra: {
              r2Key: upload.key,
              category: 'profile_image',
              uploadedAtMs: timestampMs,
              ownerEmail: actorEmail,
            },
          });
          payload.imageUrl = storagePath;
          attachmentFileName = upload.fileName;
          payload.imageName = upload.fileName;
          newAttachmentId = upload.attachmentId;
          newAttachmentUploaded = true;
        } catch (err) {
          if (upload && upload.key && env && env.R2) {
            try {
              await env.R2.delete(upload.key);
            } catch (cleanupErr) {
              console.warn('[ShiftFlow][R2] Failed to roll back profile image upload', {
                requestId,
                message:
                  cleanupErr && cleanupErr.message ? cleanupErr.message : String(cleanupErr),
              });
            }
          }
          console.warn('[ShiftFlow][Profile] Image upload failed', {
            requestId,
            email: actorEmail,
            message: err && err.message ? err.message : String(err),
            code: err && err.code ? err.code : '',
          });
          const code = err && err.code ? err.code : 'image_upload_failed';
          let status = code === 'r2_unavailable' ? 500 : 400;
          let reason = '画像のアップロードに失敗しました。';
          if (code === 'invalid_data_uri') {
            reason = '画像データの形式が正しくありません。';
          } else if (code === 'unsupported_mime_type') {
            reason = '未対応の画像形式です。PNG/JPEG 等の画像を使用してください。';
          } else if (code === 'file_too_large') {
            reason = '画像が大きすぎます。2MB 以下の画像を選択してください。';
          } else if (code === 'r2_unavailable') {
            reason = 'ファイルストレージが一時的に利用できません。後ほど再試行してください。';
          }
          return errorResponse(
            status,
            allowedOrigin,
            requestId,
            'cf-api',
            code,
            reason
          );
        }
      }
      delete payload.imageData;
      try {
        await updateUserSettingsInD1(db, {
          email: actorEmail,
          name: payload.name,
          theme: payload.theme,
          imageUrl: payload.imageUrl,
          timestampMs,
        });
      } catch (err) {
        if (newAttachmentUploaded && newAttachmentId) {
          await deleteAttachmentRecords(db, env, [newAttachmentId]);
        }
        console.error('[ShiftFlow][Profile] Failed to save settings', {
          requestId,
          email: actorEmail,
          message: err && err.message ? err.message : String(err),
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'save_failed',
          '設定の保存に失敗しました。'
        );
      }
      if (
        newAttachmentUploaded &&
        previousAttachmentId &&
        newAttachmentId &&
        previousAttachmentId !== newAttachmentId
      ) {
        await deleteAttachmentRecords(db, env, [previousAttachmentId]);
      }
      const updatedUser = await db
        .prepare(
          `
          SELECT profile_image_url, theme
            FROM users
           WHERE lower(email) = ?1
        `
        )
        .bind(actorEmail)
        .first();
      const responsePayload = {
        success: true,
        message: '設定を保存しました。',
        imageUrl: updatedUser?.profile_image_url || payload.imageUrl || PROFILE_PLACEHOLDER_URL,
        imageName: newAttachmentUploaded ? attachmentFileName : payload.imageName || '',
        theme: updatedUser?.theme || payload.theme || 'light',
      };
      captureDiagnostics(config, 'info', 'd1_user_settings_saved', {
        event: 'd1_user_settings_saved',
        route: normalizedRoute,
        requestId,
        email: actorEmail,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: responsePayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listMyTasks') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const responsePayload = await buildMyTasksPayload(db, rawEmail);
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: responsePayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'addNewTask') {
      if (requestMethod && requestMethod.toUpperCase() !== 'POST') {
        return errorResponse(
          405,
          allowedOrigin,
          requestId,
          'cf-api',
          'method_not_allowed',
          'この操作は POST にのみ対応しています。'
        );
      }
      const bodyObject = parsedBody && typeof parsedBody === 'object' ? { ...parsedBody } : {};
      const interception = interceptRequestBodyForRoute(normalizedRoute, bodyObject, {
        flags,
        tokenDetails,
        accessContext,
      });
      const effectiveBody = interception?.body || bodyObject;
      const argsArray = Array.isArray(effectiveBody?.args) ? effectiveBody.args : [];
      const taskPayload =
        argsArray.length && typeof argsArray[0] === 'object' ? argsArray[0] : {};
      const timestampMs =
        interception?.dualWriteContext?.timestampMs && Number.isFinite(interception.dualWriteContext.timestampMs)
          ? interception.dualWriteContext.timestampMs
          : Date.now();
      const taskId =
        interception?.dualWriteContext?.taskId ||
        normalizeIdValue(taskPayload.taskId) ||
        generateTaskId();
      await insertTaskIntoD1(db, {
        taskId,
        payload: taskPayload,
        timestampMs,
        authorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      captureDiagnostics(config, 'info', 'd1_task_created', {
        event: 'd1_task_created',
        route: normalizedRoute,
        requestId,
        email: tokenDetails?.email || accessContext?.email || '',
        taskId,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'タスクを追加しました。',
          taskId,
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'updateTask') {
      const bodyObject = parsedBody && typeof parsedBody === 'object' ? { ...parsedBody } : {};
      const interception = interceptRequestBodyForRoute(normalizedRoute, bodyObject, {
        flags,
        tokenDetails,
        accessContext,
      });
      const ctx = interception?.dualWriteContext;
      const taskId = ctx?.taskId ? normalizeIdValue(ctx.taskId) : '';
      if (!taskId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_id_required',
          'タスク ID を指定してください。'
        );
      }
      const taskRow = await db
        .prepare('SELECT task_id FROM tasks WHERE task_id = ?1')
        .bind(taskId)
        .first();
      if (!taskRow) {
        return jsonResponseFromD1(
          404,
          {
            ok: false,
            success: false,
            message: '更新対象のタスクが見つかりませんでした。',
          },
          allowedOrigin,
          requestId
        );
      }
      await updateTaskInD1(db, {
        taskId,
        payload: ctx?.payload || {},
        timestampMs: ctx?.timestampMs || Date.now(),
      });
      captureDiagnostics(config, 'info', 'd1_task_updated', {
        event: 'd1_task_updated',
        route: normalizedRoute,
        requestId,
        taskId,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'タスクを更新しました。',
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'completeTask') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawTaskId = argsArray.length > 0 ? argsArray[0] : query?.get('taskId') || '';
      const taskId = normalizeIdValue(rawTaskId);
      if (!taskId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_id_required',
          'タスク ID を指定してください。'
        );
      }
      const taskRow = await db
        .prepare('SELECT task_id FROM tasks WHERE task_id = ?1')
        .bind(taskId)
        .first();
      if (!taskRow) {
        return jsonResponseFromD1(
          404,
          {
            ok: false,
            success: false,
            message: '対象のタスクが見つかりません。',
          },
          allowedOrigin,
          requestId
        );
      }
      await completeTaskInD1(db, {
        taskId,
        timestampMs: Date.now(),
      });
      captureDiagnostics(config, 'info', 'd1_task_completed', {
        event: 'd1_task_completed',
        route: normalizedRoute,
        requestId,
        taskId,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'タスクを完了にしました。',
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'deleteTaskById') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawTaskId = argsArray.length > 0 ? argsArray[0] : query?.get('taskId') || '';
      const taskId = normalizeIdValue(rawTaskId);
      if (!taskId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_id_required',
          'タスク ID を指定してください。'
        );
      }
      const taskRow = await db
        .prepare(
          `
          SELECT task_id,
                 created_by_email
            FROM tasks
           WHERE task_id = ?1
        `
        )
        .bind(taskId)
        .first();
      if (!taskRow) {
        return jsonResponseFromD1(
          404,
          {
            ok: false,
            success: false,
            message: '該当のタスクが見つかりませんでした。',
          },
          allowedOrigin,
          requestId
        );
      }
      const currentEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const creatorEmail = normalizeEmailValue(taskRow.created_by_email || '');
      const canDelete =
        !creatorEmail ||
        !currentEmail ||
        creatorEmail === currentEmail ||
        isManagerRole(accessContext?.role);
      if (!canDelete) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '削除権限がありません。'
        );
      }
      await deleteTaskFromD1(db, env, { taskId });
      captureDiagnostics(config, 'info', 'd1_task_deleted', {
        event: 'd1_task_deleted',
        route: normalizedRoute,
        requestId,
        taskId,
        email: currentEmail || '',
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'タスクを削除しました。',
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listCreatedTasks') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const filterArg =
        parsedBody &&
        Array.isArray(parsedBody.args) &&
        parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const statusFilterRaw =
        typeof filterArg?.status === 'string' ? filterArg.status.trim() : '';
      const sortMode =
        typeof filterArg?.sort === 'string' && filterArg.sort.trim()
          ? filterArg.sort.trim()
          : 'due';
      const totalRow = await db.prepare('SELECT COUNT(*) AS count FROM tasks').first();
      const totalTasks =
        typeof totalRow?.count === 'number'
          ? totalRow.count
          : typeof totalRow?.['COUNT(*)'] === 'number'
          ? totalRow['COUNT(*)']
          : 0;
      if (!normalizedEmail) {
        return jsonResponseFromD1(
          200,
          { ok: true, result: { tasks: [], meta: { statuses: [] } } },
          allowedOrigin,
          requestId
        );
      }
      const createdResult = await db
        .prepare(
          `
          SELECT *
            FROM tasks
           WHERE created_by_email = ?1
        `
        )
        .bind(normalizedEmail)
        .all();
      const rows = Array.isArray(createdResult?.results) ? createdResult.results : [];
      const assigneeMap = await fetchAssigneesForTasks(
        db,
        rows.map((row) => row.task_id)
      );
      const todayMs = startOfTodayMs();
      const createdTasks = rows
        .map((row) => buildTaskRecordFromD1(row, assigneeMap.get(row.task_id) || []))
        .filter(Boolean);
      const statuses = new Set();
      createdTasks.forEach((task) => {
        if (task.status) statuses.add(task.status);
      });
      const statusFilter = statusFilterRaw
        ? mapD1StatusToLegacy(statusFilterRaw) || statusFilterRaw
        : '';
      let filtered = createdTasks.slice();
      if (statusFilter) {
        filtered = filtered.filter((task) => task.status === statusFilter);
      }
      if (sortMode === 'created_desc') {
        filtered.sort((a, b) => {
          const ca = a.createdAt != null ? a.createdAt : 0;
          const cb = b.createdAt != null ? b.createdAt : 0;
          if (cb !== ca) return cb - ca;
          return compareTasksForList(a, b, todayMs);
        });
      } else if (sortMode === 'created_asc') {
        filtered.sort((a, b) => {
          const ca = a.createdAt != null ? a.createdAt : Number.MAX_SAFE_INTEGER;
          const cb = b.createdAt != null ? b.createdAt : Number.MAX_SAFE_INTEGER;
          if (ca !== cb) return ca - cb;
          return compareTasksForList(a, b, todayMs);
        });
      } else {
        filtered.sort((a, b) => compareTasksForList(a, b, todayMs));
      }
      const responsePayload = {
        tasks: filtered,
        meta: {
          statuses: Array.from(statuses).sort(),
          sort: sortMode,
          currentEmail: rawEmail,
          totalTasks,
          createdCount: createdTasks.length,
          filteredCount: filtered.length,
        },
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: responsePayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listAllTasks') {
      if (!isManagerRole(accessContext?.role)) {
        const normalizedRole = normalizeRoleValue(accessContext?.role);
        const responsePayload = {
          tasks: [],
          meta: {
            managerOnly: true,
            userRole: accessContext?.role || '',
            normalizedRole,
            reason: '権限がありません。',
            isManager: false,
          },
        };
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: responsePayload },
          allowedOrigin,
          requestId
        );
      }
      const filterArg =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const statusFilterRaw =
        typeof filterArg?.status === 'string' ? filterArg.status.trim() : '';
      const allResult = await db.prepare('SELECT * FROM tasks').all();
      const rows = Array.isArray(allResult?.results) ? allResult.results : [];
      const assigneeMap = await fetchAssigneesForTasks(
        db,
        rows.map((row) => row.task_id)
      );
      const todayMs = startOfTodayMs();
      const allTasks = rows
        .map((row) => buildTaskRecordFromD1(row, assigneeMap.get(row.task_id) || []))
        .filter(Boolean);
      const statuses = new Set();
      allTasks.forEach((task) => {
        if (task.status) statuses.add(task.status);
      });
      const statusFilter = statusFilterRaw
        ? mapD1StatusToLegacy(statusFilterRaw) || statusFilterRaw
        : '';
      let filtered = allTasks.slice();
      if (statusFilter) {
        filtered = filtered.filter((task) => task.status === statusFilter);
      }
      filtered.sort((a, b) => compareTasksForList(a, b, todayMs));
      const responsePayload = {
        tasks: filtered,
        meta: {
          statuses: Array.from(statuses).sort(),
          totalTasks: allTasks.length,
          filteredCount: filtered.length,
          isManager: true,
        },
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: responsePayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getTaskById') {
      const args =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args
          : [];
      const rawTaskId = args.length ? args[0] : query?.get('taskId') || '';
      const taskId = normalizeIdValue(rawTaskId);
      if (!taskId) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      const row = await db
        .prepare(
          `
          SELECT *
            FROM tasks
           WHERE task_id = ?1
        `
        )
        .bind(taskId)
        .first();
      if (!row) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      const assigneeMap = await fetchAssigneesForTasks(db, [taskId]);
      const summary = buildTaskRecordFromD1(row, assigneeMap.get(taskId) || []);
      const currentEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const creatorEmail = normalizeEmailValue(row.created_by_email);
      const canDelete =
        (currentEmail && creatorEmail && currentEmail === creatorEmail) ||
        isManagerRole(accessContext?.role);
      const detail = {
        id: summary?.id || row.task_id,
        title: summary?.title || row.title || 'Untitled Task',
        assignee: summary?.assignee || '',
        dueDate: summary?.dueDate || '',
        status: summary?.status || mapD1StatusToLegacy(row.status),
        priority: summary?.priority || mapD1PriorityToLegacy(row.priority),
        createdBy: row.created_by_email || '',
        canDelete,
        assignees: summary?.assignees || [],
        attachments: [],
        repeatRule: summary?.repeatRule || '',
        updatedAt: summary?.updatedAt ? formatJst(summary.updatedAt, true) : '',
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: detail },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'addNewMessage') {
      if (requestMethod && requestMethod.toUpperCase() !== 'POST') {
        return errorResponse(
          405,
          allowedOrigin,
          requestId,
          'cf-api',
          'method_not_allowed',
          'この操作は POST にのみ対応しています。'
        );
      }
      const bodyObject = parsedBody && typeof parsedBody === 'object' ? { ...parsedBody } : {};
      const interception = interceptRequestBodyForRoute(normalizedRoute, bodyObject, {
        flags,
        tokenDetails,
        accessContext,
      });
      const effectiveBody = interception?.body || bodyObject;
      const argsArray = Array.isArray(effectiveBody?.args) ? effectiveBody.args : [];
      const messagePayload =
        argsArray.length && typeof argsArray[0] === 'object' ? { ...argsArray[0] } : {};
      const timestampMs =
        interception?.dualWriteContext?.timestampMs && Number.isFinite(interception.dualWriteContext.timestampMs)
          ? interception.dualWriteContext.timestampMs
          : Date.now();
      const messageId =
        interception?.dualWriteContext?.messageId ||
        normalizeIdValue(messagePayload.messageId) ||
        generateMessageId();
      const actorEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedActorEmail = normalizeEmailValue(actorEmail);
      const membership = normalizedActorEmail ? await resolveMembershipForEmail(db, normalizedActorEmail) : null;
      const rawAttachments = Array.isArray(messagePayload.attachments) ? messagePayload.attachments : [];
      const preparedAttachments = [];
      const uploadKeysForRollback = [];
      if (rawAttachments.length) {
        if (rawAttachments.length > MESSAGE_ATTACHMENT_LIMIT) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'attachment_limit_exceeded',
            `添付は最大 ${MESSAGE_ATTACHMENT_LIMIT} 件までです。`
          );
        }
        let resolvedOrgId = membership?.org_id || null;
        if (!resolvedOrgId) {
          resolvedOrgId = await resolveDefaultOrgId(db);
        }
        for (let index = 0; index < rawAttachments.length; index += 1) {
          const rawAttachment = rawAttachments[index] || {};
          const dataUri = typeof rawAttachment.dataUri === 'string' ? rawAttachment.dataUri : '';
          if (!dataUri) {
            if (uploadKeysForRollback.length && env && env.R2) {
              try {
                await env.R2.delete(uploadKeysForRollback);
              } catch (cleanupErr) {
                console.warn('[ShiftFlow][R2] Failed to roll back attachment uploads', {
                  requestId,
                  message:
                    cleanupErr && cleanupErr.message ? cleanupErr.message : String(cleanupErr),
                });
              }
            }
            return errorResponse(
              400,
              allowedOrigin,
              requestId,
              'cf-api',
              'attachment_data_missing',
              `添付ファイル ${index + 1} のデータが取得できません。`
            );
          }
          let upload = null;
          try {
            upload = await storeDataUriInR2(env, {
              dataUri,
              maxBytes: MESSAGE_ATTACHMENT_MAX_BYTES,
              keyPrefix: membership?.org_id
                ? `orgs/${membership.org_id}/messages`
                : 'messages',
              fileNameHint:
                typeof rawAttachment.name === 'string' && rawAttachment.name
                  ? rawAttachment.name
                  : `attachment_${index + 1}`,
            });
            uploadKeysForRollback.push(upload.key);
            preparedAttachments.push({
              attachmentId: upload.attachmentId,
              fileName: upload.fileName,
              mimeType: upload.mimeType,
              sizeBytes: upload.size,
              checksum: upload.checksum,
              storagePath: buildAttachmentDownloadPath(upload.attachmentId),
              createdAtMs: timestampMs,
              createdByMembershipId: membership?.membership_id || null,
              orgId: resolvedOrgId || null,
              extra: {
                r2Key: upload.key,
                category: 'message_attachment',
                messageId,
                uploadedAtMs: timestampMs,
                ownerEmail: normalizedActorEmail,
                originalName:
                  typeof rawAttachment.name === 'string' ? rawAttachment.name : '',
              },
            });
          } catch (err) {
            if (upload && upload.key && env && env.R2) {
              try {
                await env.R2.delete(upload.key);
              } catch (cleanupErr) {
                console.warn('[ShiftFlow][R2] Failed to roll back attachment upload', {
                  requestId,
                  message:
                    cleanupErr && cleanupErr.message ? cleanupErr.message : String(cleanupErr),
                });
              }
            }
            if (uploadKeysForRollback.length && env && env.R2) {
              try {
                await env.R2.delete(uploadKeysForRollback);
              } catch (cleanupErr) {
                console.warn('[ShiftFlow][R2] Failed to roll back attachment uploads', {
                  requestId,
                  message:
                    cleanupErr && cleanupErr.message ? cleanupErr.message : String(cleanupErr),
                });
              }
            }
            const code = err && err.code ? err.code : 'attachment_upload_failed';
            let status = code === 'r2_unavailable' ? 500 : 400;
            let reason = '添付ファイルのアップロードに失敗しました。';
            if (code === 'invalid_data_uri') {
              reason = `添付ファイル ${index + 1} のデータ形式が不正です。`;
            } else if (code === 'unsupported_mime_type') {
              reason = `添付ファイル ${index + 1} は未対応の形式です。`;
            } else if (code === 'file_too_large') {
              reason = `添付ファイル ${index + 1} が大きすぎます。4MB 以下にしてください。`;
            } else if (code === 'r2_unavailable') {
              reason = 'ファイルストレージが一時的に利用できません。後ほど再試行してください。';
            }
            return errorResponse(status, allowedOrigin, requestId, 'cf-api', code, reason);
          }
        }
        messagePayload.attachments = preparedAttachments.map((attachment) => ({
          name: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.sizeBytes,
          url: attachment.storagePath,
        }));
      } else {
        delete messagePayload.attachments;
      }
      await insertMessageIntoD1(db, {
        messageId,
        payload: messagePayload,
        timestampMs,
        authorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      if (preparedAttachments.length) {
        try {
          for (const attachment of preparedAttachments) {
            await insertAttachmentRecord(db, attachment);
            await db
              .prepare(
                `
                INSERT OR REPLACE INTO message_attachments (message_id, attachment_id)
                VALUES (?1, ?2)
              `
              )
              .bind(messageId, attachment.attachmentId)
              .run();
          }
        } catch (err) {
          console.error('[ShiftFlow][Message] Failed to persist attachments', {
            requestId,
            messageId,
            email: normalizedActorEmail || '',
            message: err && err.message ? err.message : String(err),
          });
          await deleteMessageFromD1(db, env, { messageId });
          await deleteAttachmentRecords(
            db,
            env,
            preparedAttachments.map((attachment) => attachment.attachmentId)
          );
          return errorResponse(
            500,
            allowedOrigin,
            requestId,
            'cf-api',
            'attachment_persist_failed',
            'メッセージの添付ファイル保存に失敗しました。'
          );
        }
      }
      if (actorEmail) {
        await ensureMemoReadInD1(db, {
          messageId,
          timestampMs,
          email: actorEmail,
        });
      }
      captureDiagnostics(config, 'info', 'd1_message_created', {
        event: 'd1_message_created',
        route: normalizedRoute,
        requestId,
        email: actorEmail || '',
        messageId,
        attachments: preparedAttachments.length,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'メッセージを投稿しました。',
          memoId: messageId,
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'deleteMessageById') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawMessageId =
        argsArray.length > 0 ? argsArray[0] : query?.get('memoId') || '';
      const messageId = normalizeIdValue(rawMessageId);
      if (!messageId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_id_required',
          'メッセージ ID を指定してください。'
        );
      }
      const messageRow = await db
        .prepare(
          `
          SELECT m.message_id,
                 m.org_id,
                 COALESCE(u.email, '') AS author_email
            FROM messages m
            LEFT JOIN memberships ms ON ms.membership_id = m.author_membership_id
            LEFT JOIN users u ON u.user_id = ms.user_id
           WHERE m.message_id = ?1
        `
        )
        .bind(messageId)
        .first();
      if (!messageRow) {
        return jsonResponseFromD1(
          404,
          {
            ok: false,
            success: false,
            reason: '対象のメッセージが見つかりません。',
          },
          allowedOrigin,
          requestId
        );
      }
      const currentEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const authorEmail = normalizeEmailValue(messageRow.author_email || '');
      const canDelete =
        (currentEmail && authorEmail && currentEmail === authorEmail) ||
        isManagerRole(accessContext?.role);
      if (!canDelete) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '削除権限がありません。'
        );
      }
      await deleteMessageFromD1(db, env, { messageId });
      captureDiagnostics(config, 'info', 'd1_message_deleted', {
        event: 'd1_message_deleted',
        route: normalizedRoute,
        requestId,
        email: currentEmail || '',
        messageId,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'メッセージを削除しました。',
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'markMemoAsRead') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawMessageId =
        argsArray.length > 0 ? argsArray[0] : query?.get('memoId') || '';
      const messageId = normalizeIdValue(rawMessageId);
      if (!messageId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_id_required',
          'メッセージ ID を指定してください。'
        );
      }
      await ensureMemoReadInD1(db, {
        messageId,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: 'メッセージを既読にしました。',
          memoId: messageId,
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'toggleMemoRead') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawMessageId =
        argsArray.length > 0 ? argsArray[0] : query?.get('memoId') || '';
      const messageId = normalizeIdValue(rawMessageId);
      if (!messageId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_id_required',
          'メッセージ ID を指定してください。'
        );
      }
      const shouldRead =
        argsArray.length > 1 ? Boolean(argsArray[1]) : true;
      await toggleMemoReadInD1(db, {
        messageId,
        shouldRead,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: shouldRead ? 'メッセージを既読にしました。' : 'メッセージを未読に戻しました。',
          memoId: messageId,
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'markMemosReadBulk') {
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) ? parsedBody.args : [];
      const rawList = argsArray.length > 0 ? argsArray[0] : [];
      const memoIds = Array.isArray(rawList)
        ? rawList.map((id) => normalizeIdValue(id)).filter(Boolean)
        : [];
      await bulkEnsureMemoReadInD1(db, {
        messageIds: memoIds,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          message: `未読 ${memoIds.length} 件を既読にしました`,
          targetCount: memoIds.length,
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getMessages') {
      const args =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const folderId = typeof args?.folderId === 'string' ? args.folderId : '';
      const unreadOnly = !!args?.unreadOnly;
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail ? await resolveMembershipForEmail(db, normalizedEmail) : null;
      const membershipId = membership?.membership_id || null;
      const messages = await buildMessagesForUser(db, {
        folderId,
        membershipId,
      });
      const payload = unreadOnly ? messages.filter((item) => !item.isRead) : messages;
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getMessageById') {
      const args =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args
          : [];
      const rawMessageId = args.length ? args[0] : query?.get('memoId') || '';
      const messageId = normalizeIdValue(rawMessageId);
      if (!messageId) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      const messageRow = await db
        .prepare(
          `
          SELECT m.*,
                 ms.org_id AS author_org_id,
                 u.email AS author_email,
                 u.display_name AS author_display_name
            FROM messages m
            LEFT JOIN memberships ms ON ms.membership_id = m.author_membership_id
            LEFT JOIN users u ON u.user_id = ms.user_id
           WHERE m.message_id = ?1
        `
        )
        .bind(messageId)
        .first();
      if (!messageRow) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      const attachments = await fetchMessageAttachments(db, messageId);
      const readResult = await db
        .prepare(
          `
          SELECT u.email AS email,
                 COALESCE(u.display_name, u.email) AS display_name
            FROM message_reads mr
            JOIN memberships ms ON ms.membership_id = mr.membership_id
            JOIN users u ON u.user_id = ms.user_id
           WHERE mr.message_id = ?1
        `
        )
        .bind(messageId)
        .all();
      const readRows = Array.isArray(readResult?.results) ? readResult.results : [];
      const readSet = new Set();
      const readUsers = [];
      const readEmails = [];
      for (const row of readRows) {
        const email = row?.email ? String(row.email).trim() : '';
        const displayName = row?.display_name ? String(row.display_name).trim() : '';
        const normalizedEmail = normalizeEmailValue(email);
        if (normalizedEmail) {
          readSet.add(normalizedEmail);
          readEmails.push(normalizedEmail);
        }
        if (email || displayName) {
          readUsers.push({
            email,
            label: buildUserLabel(email, displayName),
          });
        }
      }
      const membership = await resolveMembershipForEmail(
        db,
        normalizeEmailValue(tokenDetails?.email || accessContext?.email || '')
      );
      const orgId = messageRow?.org_id || membership?.org_id || messageRow?.author_org_id || null;
      const activeUsers = await fetchActiveUsersForOrg(db, orgId);
      const unreadUsers = [];
      const unreadEmails = [];
      for (const user of activeUsers) {
        const normalizedEmail = normalizeEmailValue(user.email);
        if (normalizedEmail && readSet.has(normalizedEmail)) continue;
        if (normalizedEmail) {
          unreadEmails.push(normalizedEmail);
        }
        unreadUsers.push({
          email: user.email,
          label: buildUserLabel(user.email, user.displayName),
        });
      }
      const currentEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const authorEmail = normalizeEmailValue(messageRow?.author_email);
      const canDelete =
        (currentEmail && authorEmail && currentEmail === authorEmail) ||
        isManagerRole(accessContext?.role);
      const detail = {
        id: messageRow?.message_id || messageId,
        createdBy: messageRow?.author_email || '',
        title: messageRow?.title || '',
        body: typeof messageRow?.body === 'string' ? messageRow.body.replace(/\r\n/g, '\n') : '',
        priority: '中',
        comments: [],
        readUsers,
        unreadUsers,
        readEmails,
        unreadEmails,
        canDelete,
        attachments,
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: detail },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getHomeContent') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail ? await resolveMembershipForEmail(db, normalizedEmail) : null;
      const membershipId = membership?.membership_id || null;
      const assignedResult = await db
        .prepare(
          `
          SELECT DISTINCT t.*
            FROM tasks t
            JOIN task_assignees ta ON ta.task_id = t.task_id
           WHERE (?1 <> '' AND ta.email = ?1)
        `
        )
        .bind(normalizedEmail || '')
        .all();
      const taskRows = Array.isArray(assignedResult?.results) ? assignedResult.results : [];
      const assigneeMap = await fetchAssigneesForTasks(
        db,
        taskRows.map((row) => row.task_id)
      );
      const taskRecords = taskRows
        .map((row) => buildTaskRecordFromD1(row, assigneeMap.get(row.task_id) || []))
        .filter(Boolean);
      const todayMs = startOfTodayMs();
      const todays = taskRecords
        .filter(
          (task) =>
            task &&
            !task.isCompleted &&
            task.dueValue != null &&
            task.dueValue <= todayMs
        )
        .sort((a, b) => compareTasksForList(a, b, todayMs))
        .map((task) => ({
          id: task.id,
          title: task.title,
          dueDate: task.dueValue != null ? formatJstMonthDay(task.dueValue) : '',
          priority: task.priority,
          assignees: task.assignees,
          assignee: task.assignee,
          status: task.status,
          isCompleted: task.isCompleted,
        }));
      const messages = await buildMessagesForUser(db, {
        folderId: '',
        membershipId,
      });
      const payload = {
        tasks: todays,
        messages,
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'downloadAttachment') {
      const originForResponses = allowedOrigin || config.allowedOrigins[0] || '*';
      if (requestMethod && requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        return errorResponse(
          405,
          originForResponses,
          requestId,
          'cf-api',
          'method_not_allowed',
          'この操作は GET/HEAD にのみ対応しています。'
        );
      }
      if (!env || !env.R2) {
        return errorResponse(
          500,
          originForResponses,
          requestId,
          'cf-api',
          'r2_unavailable',
          'ファイルストレージが一時的に利用できません。'
        );
      }
      const attachmentIdArg =
        query?.get('attachmentId') ||
        (Array.isArray(parsedBody?.args) && parsedBody.args.length ? parsedBody.args[0] : '');
      const attachmentId = normalizeIdValue(attachmentIdArg);
      if (!attachmentId) {
        return errorResponse(
          400,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_id_required',
          '添付ファイル ID を指定してください。'
        );
      }
      const attachmentRow = await db
        .prepare(
          `
          SELECT attachment_id,
                 org_id,
                 file_name,
                 content_type,
                 size_bytes,
                 extra_json,
                 storage_path
            FROM attachments
           WHERE attachment_id = ?1
        `
        )
        .bind(attachmentId)
        .first();
      if (!attachmentRow) {
        return errorResponse(
          404,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_not_found',
          '指定された添付ファイルが見つかりません。'
        );
      }
      const extras = safeParseJson(attachmentRow.extra_json || null, {});
      const r2Key = typeof extras?.r2Key === 'string' ? extras.r2Key.trim() : '';
      if (!r2Key) {
        console.warn('[ShiftFlow][R2] Attachment missing R2 key', {
          requestId,
          attachmentId,
        });
        return errorResponse(
          410,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_missing_object',
          'ファイルが削除されている可能性があります。'
        );
      }
      const normalizedEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const membership = normalizedEmail ? await resolveMembershipForEmail(db, normalizedEmail) : null;
      if (!membership || !membership.org_id) {
        return errorResponse(
          403,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_forbidden',
          '添付ファイルにアクセスする権限がありません。'
        );
      }
      const attachmentOrgId =
        attachmentRow.org_id ||
        (typeof extras?.orgId === 'string' ? extras.orgId : null);
      if (
        attachmentOrgId &&
        attachmentOrgId !== membership.org_id &&
        !isManagerRole(accessContext?.role)
      ) {
        return errorResponse(
          403,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_forbidden',
          '添付ファイルにアクセスする権限がありません。'
        );
      }
      let object = null;
      try {
        object =
          requestMethod === 'HEAD' ? await env.R2.head(r2Key) : await env.R2.get(r2Key);
      } catch (err) {
        console.error('[ShiftFlow][R2] Failed to read attachment', {
          requestId,
          attachmentId,
          message: err && err.message ? err.message : String(err),
        });
        return errorResponse(
          502,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_fetch_failed',
          '添付ファイルの取得に失敗しました。'
        );
      }
      if (!object) {
        console.warn('[ShiftFlow][R2] Attachment object missing', {
          requestId,
          attachmentId,
          r2Key,
        });
        return errorResponse(
          410,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_missing_object',
          'ファイルが削除されている可能性があります。'
        );
      }
      const sizeCandidate =
        typeof object.size === 'number' && Number.isFinite(object.size)
          ? object.size
          : typeof attachmentRow.size_bytes === 'number'
          ? attachmentRow.size_bytes
          : null;
      const mimeType =
        attachmentRow.content_type ||
        (object.httpMetadata && object.httpMetadata.contentType) ||
        'application/octet-stream';
      const fileName =
        attachmentRow.file_name ||
        (typeof extras?.originalName === 'string' && extras.originalName) ||
        `${attachmentId}.bin`;
      const headers = new Headers({
        ...corsHeaders(originForResponses),
        'Content-Type': mimeType,
        'Cache-Control': 'private, max-age=300',
        'Content-Disposition': buildContentDisposition(fileName),
        'X-ShiftFlow-Request-Id': requestId,
        'X-ShiftFlow-Backend': 'R2',
      });
      if (sizeCandidate != null) {
        headers.set('Content-Length', String(sizeCandidate));
      }
      const etag = object.httpEtag || object.etag || '';
      if (etag) {
        headers.set('ETag', etag);
      }
      const uploadedAt =
        object.uploaded instanceof Date
          ? object.uploaded
          : object.uploaded
          ? new Date(object.uploaded)
          : null;
      if (uploadedAt && !Number.isNaN(uploadedAt.getTime())) {
        headers.set('Last-Modified', uploadedAt.toUTCString());
      }
      if (requestMethod === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers,
        });
      }
      return new Response(object.body, {
        status: 200,
        headers,
      });
    }
  } catch (err) {
    console.error('[ShiftFlow][D1] Route handling failed', {
      route: normalizedRoute,
      requestId,
      error: err && err.message ? err.message : String(err),
    });
    captureDiagnostics(config, 'error', 'd1_route_failed', {
      event: 'd1_route_failed',
      route: normalizedRoute,
      requestId,
      detail: err && err.message ? err.message : String(err),
    });
  }
  return null;
}


async function insertMessageIntoD1(db, context) {
  if (!context?.messageId) return;
  const lowerEmail = normalizeEmailValue(context.authorEmail);
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

async function insertTaskIntoD1(db, context) {
  if (!context?.taskId) return;
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();
  const creatorEmail = normalizeEmailValue(context.authorEmail || payload.createdBy || payload.createdByEmail);
  const folderId =
    typeof payload.folderId === 'string'
      ? payload.folderId.trim()
      : typeof payload.folder_id === 'string'
      ? payload.folder_id.trim()
      : null;
  const membership = creatorEmail ? await resolveMembershipForEmail(db, creatorEmail) : null;
  const orgId =
    membership?.org_id ||
    (await resolveDefaultOrgId(db)) ||
    '01H00000000000000000000000';
  const createdAtCandidate =
    typeof payload.createdAtMs === 'number'
      ? payload.createdAtMs
      : typeof payload.created_at_ms === 'number'
      ? payload.created_at_ms
      : null;
  const createdAtMs = Number.isFinite(createdAtCandidate)
    ? createdAtCandidate
    : parseTaskDueDate(payload.createdAt) ||
      parseTaskDueDate(payload.created_at) ||
      timestampMs;
  const updatedAtCandidate =
    typeof payload.updatedAtMs === 'number'
      ? payload.updatedAtMs
      : typeof payload.updated_at_ms === 'number'
      ? payload.updated_at_ms
      : null;
  const updatedAtMs = Number.isFinite(updatedAtCandidate)
    ? updatedAtCandidate
    : parseTaskDueDate(payload.updatedAt) ||
      parseTaskDueDate(payload.updated_at) ||
      createdAtMs;
  const dueAtMs =
    parseTaskDueDate(payload.dueAtMs) ||
    parseTaskDueDate(payload.due_at_ms) ||
    parseTaskDueDate(payload.dueDate) ||
    parseTaskDueDate(payload.due_at) ||
    null;
  const status = mapTaskStatus(payload.status);
  const priority = mapTaskPriority(payload.priority);
  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Untitled Task';
  const description =
    typeof payload.description === 'string'
      ? payload.description
      : typeof payload.body === 'string'
      ? payload.body
      : null;
  const legacyTaskId =
    typeof payload.legacyTaskId === 'string' && payload.legacyTaskId.trim()
      ? payload.legacyTaskId.trim()
      : null;
  const metaJson =
    typeof payload.metaJson === 'string' && payload.metaJson.trim()
      ? payload.metaJson
      : typeof payload.meta_json === 'string' && payload.meta_json.trim()
      ? payload.meta_json
      : buildTaskMetaJson(payload);

  await db
    .prepare(
      `
      INSERT OR REPLACE INTO tasks (
        task_id,
        org_id,
        folder_id,
        title,
        description,
        status,
        priority,
        created_by_email,
        created_by_membership_id,
        created_at_ms,
        updated_at_ms,
        due_at_ms,
        legacy_task_id,
        meta_json
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    `
    )
    .bind(
      context.taskId,
      orgId,
      folderId || null,
      title,
      description,
      status,
      priority,
      creatorEmail || null,
      membership?.membership_id || null,
      createdAtMs,
      updatedAtMs,
      dueAtMs,
      legacyTaskId,
      metaJson
    )
    .run();

  const assigneeEmails = deriveTaskAssigneeEmails(payload, creatorEmail);
  await insertTaskAssigneesIntoD1(db, context.taskId, assigneeEmails, createdAtMs);
}

async function insertTaskAssigneesIntoD1(db, taskId, emails, assignedAtMs) {
  if (!Array.isArray(emails) || !emails.length) return;
  await db.prepare('DELETE FROM task_assignees WHERE task_id = ?1').bind(taskId).run();
  for (const email of emails) {
    const normalized = normalizeEmailValue(email);
    if (!normalized) continue;
    const membership = await resolveMembershipForEmail(db, normalized);
    await db
      .prepare(
        `
        INSERT OR REPLACE INTO task_assignees (
          task_id,
          email,
          membership_id,
          assigned_at_ms
        )
        VALUES (?1, ?2, ?3, ?4)
      `
      )
      .bind(taskId, normalized, membership?.membership_id || null, assignedAtMs)
      .run();
  }
}

async function updateTaskInD1(db, context) {
  if (!context?.taskId) return;
  const existing = await db
    .prepare(
      `
      SELECT task_id,
             title,
             description,
             status,
             priority,
             due_at_ms,
             folder_id,
             meta_json
      FROM tasks
      WHERE task_id = ?1
    `
    )
    .bind(context.taskId)
    .first();
  if (!existing) {
    logAuthInfo('Task not found in D1 during update', { taskId: context.taskId });
    return;
  }
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();

  const nextTitle =
    payload.title !== undefined ? String(payload.title || '') : existing.title || '';
  const nextDescription =
    payload.description !== undefined
      ? payload.description === null
        ? null
        : String(payload.description)
      : existing.description ?? null;
  const nextStatus =
    payload.status !== undefined ? mapTaskStatus(payload.status) : existing.status || 'open';
  const nextPriority =
    payload.priority !== undefined ? mapTaskPriority(payload.priority) : existing.priority || 'medium';
  const nextFolderId =
    payload.folderId !== undefined
      ? normalizeIdValue(payload.folderId) || null
      : existing.folder_id ?? null;

  let nextDueAtMs =
    existing.due_at_ms !== undefined && existing.due_at_ms !== null
      ? Number(existing.due_at_ms)
      : null;
  if (payload.dueDate !== undefined) {
    const parsedDue = parseTaskDueDate(payload.dueDate);
    nextDueAtMs = parsedDue !== null ? parsedDue : null;
  }

  const mergedMetaJson = mergeMetaJson(existing.meta_json, buildTaskMetaJson(payload));

  await db
    .prepare(
      `
      UPDATE tasks
         SET title = ?2,
             description = ?3,
             status = ?4,
             priority = ?5,
             updated_at_ms = ?6,
             due_at_ms = ?7,
             folder_id = ?8,
             meta_json = ?9
       WHERE task_id = ?1
    `
    )
    .bind(
      context.taskId,
      nextTitle,
      nextDescription,
      nextStatus,
      nextPriority,
      timestampMs,
      nextDueAtMs,
      nextFolderId,
      mergedMetaJson
    )
    .run();

  const assigneeChanged =
    Array.isArray(payload.assignees) ||
    typeof payload.assignee === 'string' ||
    typeof payload.assigneeEmail === 'string' ||
    typeof payload.assigneeEmails === 'string';
  if (assigneeChanged) {
    const assigneeEmails = deriveTaskAssigneeEmails(payload, null);
    await insertTaskAssigneesIntoD1(db, context.taskId, assigneeEmails, timestampMs);
  }
}

async function completeTaskInD1(db, context) {
  if (!context?.taskId) return;
  const timestampMs = context.timestampMs || Date.now();
  const completedStatus = mapTaskStatus('完了');
  await db
    .prepare(
      `
      UPDATE tasks
         SET status = ?2,
             updated_at_ms = ?3
       WHERE task_id = ?1
    `
    )
    .bind(context.taskId, completedStatus, timestampMs)
    .run();
}

async function toggleMemoReadInD1(db, context) {
  if (!context?.messageId) return;
  const email = normalizeEmailValue(context.email);
  if (!email) {
    logAuthInfo('Skipping memo read toggle because email is missing', {
      messageId: context.messageId,
    });
    return;
  }
  const membership = await resolveMembershipForEmail(db, email);
  if (!membership || !membership.membership_id) {
    logAuthInfo('Membership not found for memo read toggle', {
      messageId: context.messageId,
      email,
    });
    return;
  }
  const membershipId = membership.membership_id;
  if (context.shouldRead) {
    await db
      .prepare(
        `
        INSERT OR IGNORE INTO message_reads (
          message_read_id,
          message_id,
          membership_id,
          read_at_ms
        )
        VALUES (?1, ?2, ?3, ?4)
      `
      )
      .bind(
        generateMessageId(),
        context.messageId,
        membershipId,
        context.timestampMs || Date.now()
      )
      .run();
  } else {
    await db
      .prepare(
        `
        DELETE FROM message_reads
        WHERE message_id = ?1 AND membership_id = ?2
      `
      )
      .bind(context.messageId, membershipId)
      .run();
  }
}

async function ensureMemoReadInD1(db, context) {
  if (!context?.messageId) return;
  await toggleMemoReadInD1(db, {
    messageId: context.messageId,
    shouldRead: true,
    timestampMs: context.timestampMs,
    email: context.email,
  });
}

async function bulkEnsureMemoReadInD1(db, context) {
  if (!context || !Array.isArray(context.messageIds) || !context.messageIds.length) return;
  for (const memoId of context.messageIds) {
    await toggleMemoReadInD1(db, {
      messageId: memoId,
      shouldRead: true,
      timestampMs: context.timestampMs,
      email: context.email,
    });
  }
}

async function deleteTaskFromD1(db, env, context) {
  if (!context?.taskId) return;
  const taskId = normalizeIdValue(context.taskId);
  if (!taskId) return;
  const attachmentResult = await db
    .prepare(
      `
      SELECT a.attachment_id
        FROM task_attachments ta
        JOIN attachments a ON a.attachment_id = ta.attachment_id
       WHERE ta.task_id = ?1
    `
    )
    .bind(taskId)
    .all();
  const attachmentIds = Array.isArray(attachmentResult?.results)
    ? attachmentResult.results
        .map((row) => normalizeIdValue(row?.attachment_id))
        .filter(Boolean)
    : [];
  await db.prepare('DELETE FROM task_assignees WHERE task_id = ?1').bind(taskId).run();
  await db.prepare('DELETE FROM task_attachments WHERE task_id = ?1').bind(taskId).run();
  if (attachmentIds.length) {
    await deleteAttachmentRecords(db, env, attachmentIds);
  }
  await db.prepare('DELETE FROM tasks WHERE task_id = ?1').bind(taskId).run();
}

async function deleteMessageFromD1(db, env, context) {
  if (!context?.messageId) return;
  const messageId = normalizeIdValue(context.messageId);
  if (!messageId) return;
  const attachmentResult = await db
    .prepare(
      `
      SELECT a.attachment_id
        FROM message_attachments ma
        JOIN attachments a ON a.attachment_id = ma.attachment_id
       WHERE ma.message_id = ?1
    `
    )
    .bind(messageId)
    .all();
  const attachmentIds = Array.isArray(attachmentResult?.results)
    ? attachmentResult.results
        .map((row) => normalizeIdValue(row?.attachment_id))
        .filter(Boolean)
    : [];
  await db.prepare('DELETE FROM message_reads WHERE message_id = ?1').bind(messageId).run();
  await db.prepare('DELETE FROM message_attachments WHERE message_id = ?1')
    .bind(messageId)
    .run();
  if (attachmentIds.length) {
    await deleteAttachmentRecords(db, env, attachmentIds);
  }
  await db.prepare('DELETE FROM messages WHERE message_id = ?1').bind(messageId).run();
}

async function updateUserSettingsInD1(db, context) {
  if (!context) return;
  const email = normalizeEmailValue(context.email);
  if (!email) return;
  const user = await db
    .prepare(
      `
      SELECT user_id, theme, display_name, profile_image_url
        FROM users
       WHERE lower(email) = ?1
    `
    )
    .bind(email)
    .first();
  if (!user) {
    console.warn('[ShiftFlow][DualWrite] User not found in D1 when saving settings', { email });
    return;
  }
  const updates = [];
  const values = [];
  let bindIndex = 2;
  if (context.theme) {
    updates.push(`theme = ?${bindIndex++}`);
    values.push(context.theme);
  }
  if (context.name) {
    updates.push(`display_name = ?${bindIndex++}`);
    values.push(context.name);
  }
  if (context.imageUrl) {
    updates.push(`profile_image_url = ?${bindIndex++}`);
    values.push(context.imageUrl);
  }
  const timestamp = context.timestampMs || Date.now();
  updates.push(`updated_at_ms = ?${bindIndex++}`);
  values.push(timestamp);
  if (!updates.length) return;
  await db
    .prepare(`UPDATE users SET ${updates.join(', ')} WHERE lower(email) = ?1`)
    .bind(email, ...values)
    .run();
}

async function insertAttachmentRecord(db, details) {
  if (!db || !details || !details.attachmentId) return;
  const extraPayload =
    details.extra && typeof details.extra === 'object' && Object.keys(details.extra).length
      ? JSON.stringify(details.extra)
      : null;
  await db
    .prepare(
      `
      INSERT OR REPLACE INTO attachments (
        attachment_id,
        org_id,
        file_name,
        content_type,
        size_bytes,
        storage_path,
        checksum,
        created_at_ms,
        created_by_membership_id,
        extra_json
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `
    )
    .bind(
      details.attachmentId,
      details.orgId || null,
      details.fileName || null,
      details.mimeType || null,
      typeof details.sizeBytes === 'number' ? details.sizeBytes : null,
      details.storagePath || null,
      details.checksum || null,
      typeof details.createdAtMs === 'number' ? details.createdAtMs : Date.now(),
      details.createdByMembershipId || null,
      extraPayload
    )
    .run();
}

async function deleteAttachmentRecords(db, env, attachmentIds) {
  if (!db || !Array.isArray(attachmentIds) || !attachmentIds.length) return;
  const uniqueIds = Array.from(new Set(attachmentIds.map((id) => normalizeIdValue(id)).filter(Boolean)));
  if (!uniqueIds.length) return;
  const placeholders = uniqueIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const selectStatement = `
    SELECT attachment_id, extra_json
      FROM attachments
     WHERE attachment_id IN (${placeholders})
  `;
  const result = await db.prepare(selectStatement).bind(...uniqueIds).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const r2Keys = [];
  for (const row of rows) {
    const extra = safeParseJson(row?.extra_json || null, {});
    const key = typeof extra?.r2Key === 'string' ? extra.r2Key.trim() : '';
    if (key) {
      r2Keys.push(key);
    }
  }
  await db.prepare(`DELETE FROM attachments WHERE attachment_id IN (${placeholders})`).bind(...uniqueIds).run();
  if (env && env.R2 && r2Keys.length) {
    try {
      await env.R2.delete(r2Keys);
    } catch (err) {
      console.warn('[ShiftFlow][R2] Failed to delete objects', {
        count: r2Keys.length,
        message: err && err.message ? err.message : String(err),
      });
    }
  }
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
  const primarySharedSecret = getPrimarySharedSecret(config);
  if (primarySharedSecret) {
    headers.set('X-ShiftFlow-Secret', primarySharedSecret);
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


async function resolveAccessContext(config, tokenDetails, requestId, clientMeta, options = {}) {
  const cacheKey = resolveAccessCacheKey(tokenDetails);
  const cached = readAccessCache(cacheKey);
  if (cached) {
    return cached;
  }

  const flags = config.flags || {};
  const db = options && options.db ? options.db : null;
  const allowD1 = !!(db && (flags.d1Primary || flags.d1Read));
  let fallbackReason = 'ShiftFlow に登録されていません。管理者に連絡してください。';
  let fallbackReasonCode = 'not_registered';
  if (allowD1) {
    const d1Context = await resolveAccessContextFromD1(db, tokenDetails, requestId);
    if (d1Context) {
      if (d1Context.allowed && d1Context.status === 'active') {
        writeAccessCache(cacheKey, d1Context, ACTIVE_ACCESS_CACHE_TTL_MS, tokenDetails);
      } else if (cacheKey) {
        ACCESS_CACHE.delete(cacheKey);
      }
      return d1Context;
    }
    logAuthInfo('Falling back after D1 returned no access context', {
      requestId,
      email: tokenDetails.email || '',
    });
  } else {
    logAuthError('D1 access control disabled; denying access', {
      requestId,
      email: tokenDetails.email || '',
    });
    fallbackReason = 'アクセス制御ストアが一時的に利用できません。管理者に連絡してください。';
    fallbackReasonCode = 'd1_unavailable';
  }
  const fallbackContext = {
    allowed: false,
    status: 'pending',
    role: 'guest',
    email: tokenDetails.email || '',
    displayName: tokenDetails.name || '',
    reason: fallbackReason,
    userId: '',
    authSubject: '',
    source: 'fallback',
    reasonCode: fallbackReasonCode,
  };
  if (cacheKey) {
    ACCESS_CACHE.delete(cacheKey);
  }
  logAuthInfo('Access context fallback applied', {
    requestId,
    email: fallbackContext.email,
    reasonCode: fallbackContext.reasonCode,
  });
  return fallbackContext;
}

export async function onRequest(context) {
  const { request, params, env, waitUntil } = context;
  const config = loadConfig(env);
  let flags = { ...(config.flags || {}) };
  let appliedFlagOverrides = null;
  if (env && env.APP_KV) {
    const kvOverrides = await readFlagOverridesFromKv(env.APP_KV, config.flagKvKey);
    if (kvOverrides) {
      const recognized = {};
      Object.keys(kvOverrides).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(flags, key)) {
          recognized[key] = kvOverrides[key];
        }
      });
      if (Object.keys(recognized).length) {
        flags = { ...flags, ...recognized };
        appliedFlagOverrides = recognized;
      }
    }
  }
  flags.d1Read = true;
  flags.d1Write = true;
  flags.d1Primary = true;
  config.flags = flags;
  const route = params.route ? String(params.route) : '';
  const requestId = createRequestId();
  const originHeader = request.headers.get('Origin') || '';
  const allowedOrigin = pickAllowedOrigin(config.allowedOrigins, originHeader);
  if (appliedFlagOverrides) {
    logAuthInfo('Applied KV flag overrides', {
      requestId,
      overrides: appliedFlagOverrides,
    });
  }

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
      return errorResponse(
        403,
        config.allowedOrigins[0] || '*',
        requestId,
        'cf-api',
        'origin_not_allowed',
        'Origin is not allowed.'
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
    return errorResponse(
      403,
      config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'origin_not_allowed',
      'Origin is not allowed.'
    );
  }
  if (!route) {
    return errorResponse(
      400,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'route_required',
      'Route parameter is required.'
    );
  }
  if (route === 'resolveAccessContext') {
    return errorResponse(
      403,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'reserved_route',
      'Route is reserved.'
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
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let tokenDetails;
  let sessionCookieHeader = '';
  let sessionContext = null;
  let sessionRecord = null;
  logAuthInfo('Handling authenticated route request', {
    requestId,
    route,
    hasAuthorizationHeader: !!token,
    origin: originHeader || '',
  });
  const cookieHeader = request.headers.get('cookie') || '';
  const mergeHeaders = (headers = {}) => {
    const base =
      headers && typeof headers === 'object' ? { ...headers } : {};
    if (sessionCookieHeader) {
      base['Set-Cookie'] = sessionCookieHeader;
    }
    return Object.keys(base).length ? base : undefined;
  };
  if (!token) {
    try {
      sessionContext = await verifySession(env, cookieHeader);
    } catch (err) {
      console.warn('[ShiftFlow][Auth] Session verification failed', err);
      sessionContext = null;
    }
    if (sessionContext) {
      sessionRecord = sessionContext.record || {};
      let sessionTokens = sessionRecord.tokens || {};
      let idToken = sessionTokens.idToken || '';
      const now = Date.now();
      let expiry = Number(sessionTokens.expiry || 0);
      const refreshToken = sessionTokens.refreshToken || '';
      const needsRefresh =
        !!refreshToken && (!expiry || Number.isNaN(expiry) || expiry <= now + 60_000);
      if ((!idToken || expiry <= now + 60_000) && refreshToken) {
        try {
          const refreshed = await refreshGoogleTokens(env, refreshToken);
          const newIdToken = refreshed.id_token || idToken;
          const newExpiry =
            calculateIdTokenExpiry(newIdToken) ||
            (typeof refreshed.expires_in === 'number'
              ? now + Number(refreshed.expires_in) * 1000
              : now + 3600 * 1000);
          const mergedTokens = {
            ...sessionTokens,
            idToken: newIdToken,
            accessToken: refreshed.access_token || sessionTokens.accessToken || '',
            scope: refreshed.scope || sessionTokens.scope || '',
            expiry: newExpiry,
            updatedAt: now,
          };
          sessionRecord = await updateSessionTokens(env, sessionContext.id, sessionRecord, mergedTokens);
          sessionTokens = sessionRecord.tokens || mergedTokens;
          idToken = mergedTokens.idToken;
          expiry = mergedTokens.expiry;
        } catch (err) {
          console.warn('[ShiftFlow][Auth] Failed to refresh Google tokens for session', err);
          idToken = '';
          expiry = 0;
        }
      }
      if (idToken && expiry && expiry <= now + 60_000) {
        idToken = '';
      }
      if (idToken) {
        token = idToken;
        sessionCookieHeader = buildSessionCookie(`${sessionContext.id}.${sessionContext.key}`);
        if (!needsRefresh) {
          await touchSession(env, sessionContext.id, sessionRecord);
        }
      } else {
        sessionCookieHeader = buildExpiredSessionCookie();
        sessionContext = null;
      }
    }
  }
  if (!token) {
    logAuthError('Missing Authorization bearer token', { requestId, route });
    return errorResponse(
      401,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'missing_bearer_token',
      'Missing Authorization bearer token.',
      null,
      mergeHeaders()
    );
  }

  if (flags.cfAuth) {
    try {
      tokenDetails = await verifyGoogleIdToken(env, config, token);
      if (tokenDetails && typeof tokenDetails.exp === 'number' && !tokenDetails.expMs) {
        tokenDetails.expMs = Number(tokenDetails.exp) * 1000;
      }
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
      return errorResponse(
        401,
        allowedOrigin || config.allowedOrigins[0] || '*',
        requestId,
        'cf-api',
        'token_verification_failed',
        err && err.message ? err.message : String(err || 'Token verification failed'),
        null,
        mergeHeaders()
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
      return errorResponse(
        403,
        allowedOrigin || config.allowedOrigins[0] || '*',
        requestId,
        'cf-api',
        'email_not_verified',
        'Google アカウントのメールアドレスが未確認です。',
        null,
        mergeHeaders()
      );
    }
  } else {
    tokenDetails = createLegacyTokenDetails(token);
  }

  let accessContext;
  try {
    accessContext = await resolveAccessContext(config, tokenDetails, requestId, clientMeta, {
      db: env && env.DB ? env.DB : null,
    });
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
    return errorResponse(
      statusCode,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'resolve_access_context_failed',
      detailMessage,
      {},
      mergeHeaders()
    );
  }
  if (!accessContext.allowed || accessContext.status !== 'active') {
    logAuthInfo('Access denied by access policy', {
      requestId,
      route,
      email: tokenDetails.email || '',
      status: accessContext.status,
      reason: accessContext.reason || '',
      source: accessContext.source || '',
      reasonCode: accessContext.reasonCode || '',
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
      source: accessContext.source || '',
      reasonCode: accessContext.reasonCode || '',
    });
    return errorResponse(
      403,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'access_denied',
      accessContext.reason || '承認待ち、または利用停止の可能性があります。',
      {
        status: accessContext.status,
        source: accessContext.source || '',
        reasonCode: accessContext.reasonCode || '',
      },
      mergeHeaders()
    );
  }

  if (!tokenDetails.email && accessContext.email) {
    tokenDetails.email = accessContext.email;
  }
  if (!tokenDetails.sub && accessContext.email) {
    tokenDetails.sub = accessContext.email.toLowerCase();
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
      return errorResponse(
        403,
        allowedOrigin || config.allowedOrigins[0] || '*',
        requestId,
        'cf-api',
        'role_not_allowed',
        '権限がありません。',
        { requiredRoles: routePermissions, role: accessContext.role },
        mergeHeaders()
      );
    }
  }

  const originalUrl = new URL(request.url);

  let parsedJsonBody = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const raw = await request.text();
        parsedJsonBody = raw ? JSON.parse(raw) : {};
      } catch (err) {
        logAuthError('Failed to parse JSON body', {
          requestId,
          route,
          message: err && err.message ? err.message : String(err),
        });
        return errorResponse(
          400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'invalid_json',
          'リクエストボディの JSON 解析に失敗しました。',
          null,
          mergeHeaders()
        );
      }
    } else if (request.headers.has('content-length')) {
      // Non-JSON bodies are currently unsupported for API routes.
      const raw = await request.text();
      parsedJsonBody = { raw };
    } else {
      parsedJsonBody = {};
    }
  }

  const d1Response = await maybeHandleRouteWithD1({
    route,
    flags,
    db: env && env.DB ? env.DB : null,
    requestId,
    allowedOrigin: allowedOrigin || config.allowedOrigins[0] || '*',
    config,
    tokenDetails,
    accessContext,
    requestMethod: request.method,
    parsedBody: parsedJsonBody,
    query: originalUrl.searchParams,
    clientMeta,
    env,
  });

  if (!d1Response) {
    captureDiagnostics(config, 'error', 'route_not_implemented', {
      event: 'route_not_implemented',
      requestId,
      route,
      email: tokenDetails.email || '',
    });
    return errorResponse(
      501,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'route_not_implemented',
      '指定されたルートは現在利用できません。',
      null,
      mergeHeaders()
    );
  }

  if (sessionCookieHeader) {
    d1Response.headers.set('Set-Cookie', sessionCookieHeader);
  }
  return d1Response;
}
