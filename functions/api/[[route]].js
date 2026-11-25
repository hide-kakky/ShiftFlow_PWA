import { loadConfig, getRoutePermissions } from './config.js';
import {
  verifySession,
  buildSessionCookie,
  buildExpiredSessionCookie,
  touchSession,
  destroySession,
  evaluateSessionTimeout,
  getSessionCookieMaxAge,
} from '../utils/session.js';
import {
  PROFILE_PLACEHOLDER_URL,
  PROFILE_IMAGE_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_LIMIT,
  API_JSON_BODY_MAX_BYTES,
  ALLOWED_IMAGE_MIME_TYPES,
  MIME_EXTENSION_MAP,
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSE_HEADERS,
  REDIRECT_STATUSES,
  SENSITIVE_META_KEYWORDS,
  ACTIVE_ACCESS_CACHE_TTL_MS,
} from './constants.js';
import { recordAuthEvent } from '../utils/auditEvents.js';
import { handleNotificationApi, buildPushEventStatement, drainNotifications, renewNotificationSession } from '../utils/notifications.js';
import { isPushConfigured, sha256 } from '../utils/webPush.js';
import { computeAppBadge } from '../utils/appBadge.js';
import { captureDiagnostics, sanitizeDiagnosticMeta } from '../utils/diagnostics.js';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ACCESS_CACHE = new Map();
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_ULID_TIME = 2 ** 48 - 1;
const DEFAULT_ORG_COLOR = '#517CB2';
const DEFAULT_ORG_TIMEZONE = 'Asia/Tokyo';
const DEFAULT_FOLDER_COLOR = '#517CB2';
const DEFAULT_SYSTEM_FOLDER_NAME = 'Main';
const DEFAULT_LANGUAGE = 'ja';
const PINNED_MESSAGE_LIMIT = 5;
const HEX_COLOR_REGEX = /^#?([0-9a-fA-F]{6})$/;
const SUPPORTED_TIMEZONES = [
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
  'America/Los_Angeles',
  'Europe/London',
];
const API_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const API_IDEMPOTENCY_PRUNE_LIMIT = 100;
const STORAGE_UPLOAD_CLEANUP_GRACE_MS = 15 * 60 * 1000;
const STORAGE_CLEANUP_LEASE_MS = 60 * 1000;
const STAGED_ATTACHMENT_TTL_MS = 30 * 60 * 1000;
const STAGED_ATTACHMENT_ROUTES = new Set([
  'stageAttachment',
  'stageMessageAttachment',
  'stageProfileAttachment',
]);
const STAGED_UPLOAD_CONCURRENCY_LIMIT = 2;
let activeStagedUploadCount = 0;

function tryAcquireStagedUploadSlot() {
  if (activeStagedUploadCount >= STAGED_UPLOAD_CONCURRENCY_LIMIT) return null;
  activeStagedUploadCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeStagedUploadCount = Math.max(0, activeStagedUploadCount - 1);
  };
}

function createServiceUnavailableError(code, message) {
  const normalizedCode = String(code || 'service_unavailable');
  const error = new Error(message || normalizedCode);
  error.code = normalizedCode;
  error.httpStatus = 503;
  error.isShiftFlowServiceError = true;
  return error;
}
const LEGACY_READ_ONLY_POST_ROUTES = new Set([
  'getBootstrapData',
  'getHomeContent',
  'listMyTasks',
  'listCreatedTasks',
  'listAllTasks',
  'getMessages',
  'getMessageById',
  'getTaskById',
  'getUserSettings',
  'listActiveUsers',
  'listActiveFolders',
  'adminListUsers',
  'adminListOrganizations',
  'adminGetOrganization',
  'getAuditLogs',
]);
const LEGACY_MUTATION_ROUTES = new Set([
  'saveNotificationSettings',
  'registerPushSubscription',
  'removePushSubscription',
  'testPushNotification',
  'addNewComment',
  'addNewMessage',
  'addNewTask',
  'adminRetryStorageCleanup',
  'adminUpdateOrganization',
  'adminUpdateUser',
  'completeTask',
  'deleteMessageById',
  'deleteTaskById',
  'markMemoAsRead',
  'markMemosReadBulk',
  'saveUserSettings',
  'stageAttachment',
  'stageMessageAttachment',
  'stageProfileAttachment',
  'toggleMemoRead',
  'updateTask',
]);

function isD1MutationRequest(route, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedRoute = String(route || '');
  if (LEGACY_MUTATION_ROUTES.has(normalizedRoute)) return true;
  if (LEGACY_READ_ONLY_POST_ROUTES.has(normalizedRoute)) return false;
  if (normalizedRoute === 'folders') return normalizedMethod === 'POST';
  if (normalizedRoute.startsWith('folders/')) {
    return normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE';
  }
  if (normalizedRoute === 'templates') return normalizedMethod === 'POST';
  if (/^messages\/[^/]+\/pin$/.test(normalizedRoute)) return normalizedMethod === 'POST';
  return false;
}

function isAllowedMutationMethod(route, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedRoute = String(route || '');
  if (LEGACY_MUTATION_ROUTES.has(normalizedRoute)) return normalizedMethod === 'POST';
  if (normalizedRoute === 'folders' || normalizedRoute === 'templates') {
    return normalizedMethod === 'POST';
  }
  if (normalizedRoute.startsWith('folders/')) {
    return normalizedMethod === 'PATCH' || normalizedMethod === 'DELETE';
  }
  if (/^messages\/[^/]+\/pin$/.test(normalizedRoute)) return normalizedMethod === 'POST';
  return false;
}

function canBindMutationForRole(route, role) {
  const normalizedRoute = String(route || '');
  if (
    normalizedRoute === 'adminUpdateOrganization' ||
    normalizedRoute === 'folders' ||
    normalizedRoute === 'templates' ||
    normalizedRoute.startsWith('folders/')
  ) {
    return isManagerRole(role);
  }
  if (/^messages\/[^/]+\/pin$/.test(normalizedRoute)) {
    return new Set(['admin', 'manager', 'member']).has(String(role || '').toLowerCase());
  }
  return true;
}

const REPLAY_SAFE_MUTATION_ROUTES = new Set([
  'addNewComment',
  'addNewMessage',
  'addNewTask',
  'folders',
  'saveUserSettings',
  'stageAttachment',
  'stageMessageAttachment',
  'stageProfileAttachment',
  'templates',
]);

function canReplayMutationRoute(route) {
  return REPLAY_SAFE_MUTATION_ROUTES.has(String(route || ''));
}

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
    'Cache-Control': 'private, no-store',
    Pragma: 'no-cache',
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
      if (Array.isArray(value)) {
        headers.delete(key);
        value.forEach((item) => headers.append(key, String(item)));
      } else if (value !== undefined && value !== null) {
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

function createRequestId(request) {
  const received = request?.headers?.get('X-ShiftFlow-Request-Id') || '';
  const normalized = String(received).trim();
  if (normalized && normalized.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(normalized)) {
    return normalized;
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'req_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function encodeUlidTime(timestampMs) {
  const normalized = Math.max(0, Math.min(MAX_ULID_TIME, Math.floor(timestampMs)));
  const chars = new Array(10);
  let value = normalized;
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = ULID_ALPHABET[value % 32];
    value = Math.floor(value / 32);
  }
  return chars.join('');
}

function encodeUlidRandom(length) {
  const chars = new Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint8Array(length);
    crypto.getRandomValues(buffer);
    for (let i = 0; i < length; i += 1) {
      chars[i] = ULID_ALPHABET[buffer[i] % 32];
    }
  } else {
    for (let i = 0; i < length; i += 1) {
      chars[i] = ULID_ALPHABET[Math.floor(Math.random() * 32)];
    }
  }
  return chars.join('');
}

function createUlid(timestampMs = Date.now()) {
  return encodeUlidTime(timestampMs) + encodeUlidRandom(16);
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

function generateCommentId() {
  return createUlid(Date.now());
}

async function createRequestScopedId(options) {
  const kind = String(options?.kind || '').trim();
  const orgId = normalizeIdValue(options?.orgId);
  const actorUserId = normalizeIdValue(options?.actorUserId);
  const requestId = String(options?.requestId || '').trim();
  const resourceScope = String(options?.resourceScope || '').trim();
  if (!kind || !orgId || !actorUserId || !requestId) {
    const error = new Error('Request-scoped IDs require kind, org, actor, and request ID.');
    error.code = 'request_scope_invalid';
    throw error;
  }
  const material = [kind, orgId, actorUserId, requestId, resourceScope]
    .map((value) => `${value.length}:${value}`)
    .join('|');
  if (
    typeof TextEncoder !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    crypto.subtle
  ) {
    const bytes = new TextEncoder().encode(material);
    return (await computeSha256Hex(bytes.buffer)).slice(0, 32);
  }
  // WebCryptoを提供しない限定テスト環境向けの決定的fallback。
  const seeds = [2166136261, 2246822519, 3266489917, 668265263];
  return seeds
    .map((seed) => {
      let hash = seed >>> 0;
      for (let index = 0; index < material.length; index += 1) {
        hash ^= material.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash.toString(16).padStart(8, '0');
    })
    .join('');
}

const IDEMPOTENCY_INLINE_STRING_MAX_CHARS = 64 * 1024;
const IDEMPOTENCY_PAYLOAD_MAX_DEPTH = 64;
const IDEMPOTENCY_PAYLOAD_MAX_NODES = 10_000;
const IDEMPOTENCY_BINARY_FIELD_NAMES = new Set(['dataUri', 'imageData']);

function createIdempotencyPayloadComplexityError() {
  const error = new Error('Request structure is too complex for idempotency processing.');
  error.code = 'request_structure_too_complex';
  return error;
}

async function createIdempotencyStringNode(value, fieldName = '') {
  const shouldDigest =
    IDEMPOTENCY_BINARY_FIELD_NAMES.has(fieldName) ||
    value.length > IDEMPOTENCY_INLINE_STRING_MAX_CHARS ||
    value.startsWith('data:');
  if (!shouldDigest) return ['string', value];
  // 添付は最大10MB×5件。巨大文字列をcanonical JSONへ複製せず、1件ずつdigestして解放する。
  const bytes = new TextEncoder().encode(value);
  const sha256 = await computeSha256Hex(bytes.buffer);
  return ['string-sha256', value.length, sha256];
}

async function buildIdempotencyPayloadManifestNode(value, fieldName, state, depth) {
  if (depth > IDEMPOTENCY_PAYLOAD_MAX_DEPTH) {
    throw createIdempotencyPayloadComplexityError();
  }
  state.nodes += 1;
  if (state.nodes > IDEMPOTENCY_PAYLOAD_MAX_NODES) {
    throw createIdempotencyPayloadComplexityError();
  }
  if (Array.isArray(value)) {
    if (state.nodes + value.length > IDEMPOTENCY_PAYLOAD_MAX_NODES) {
      throw createIdempotencyPayloadComplexityError();
    }
    const items = [];
    for (const item of value) {
      items.push(await buildIdempotencyPayloadManifestNode(item, '', state, depth + 1));
    }
    return ['array', items];
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (state.nodes + keys.length > IDEMPOTENCY_PAYLOAD_MAX_NODES) {
      throw createIdempotencyPayloadComplexityError();
    }
    const entries = [];
    for (const key of keys.sort()) {
      if (value[key] !== undefined) {
        entries.push([
          key,
          await buildIdempotencyPayloadManifestNode(value[key], key, state, depth + 1),
        ]);
      }
    }
    return ['object', entries];
  }
  if (typeof value === 'string') {
    return createIdempotencyStringNode(value, fieldName);
  }
  if (value === null) return ['null'];
  if (typeof value === 'number') return ['number', value];
  if (typeof value === 'boolean') return ['boolean', value];
  return ['other', String(value)];
}

export async function buildIdempotencyPayloadManifest(value, fieldName = '') {
  return buildIdempotencyPayloadManifestNode(value, fieldName, { nodes: 0 }, 0);
}

export async function computeCanonicalPayloadSha256(payload) {
  const manifest = await buildIdempotencyPayloadManifest(payload ?? {});
  const canonicalPayload = JSON.stringify(manifest);
  const bytes = new TextEncoder().encode(canonicalPayload);
  return computeSha256Hex(bytes.buffer);
}

async function bindApiIdempotencyKey(db, options) {
  const orgId = normalizeIdValue(options?.orgId);
  const actorUserId = normalizeIdValue(options?.actorUserId);
  const requestId = String(options?.requestId || '').trim();
  const route = String(options?.route || '').trim();
  if (!db || !orgId || !actorUserId || !requestId || !route) {
    const error = new Error('Idempotency scope requires DB, org, actor, request ID, and route.');
    error.code = 'idempotency_scope_invalid';
    throw error;
  }
  const payloadSha256 = await computeCanonicalPayloadSha256(options?.payload ?? {});
  const wallClockNow = Date.now();
  const previousExact = await db
    .prepare(
      `
      SELECT created_at_ms,
             expires_at_ms
        FROM api_idempotency_keys
       WHERE org_id = ?1
         AND actor_user_id = ?2
         AND request_id = ?3
         AND route = ?4
       LIMIT 1
    `
    )
    .bind(orgId, actorUserId, requestId, route)
    .first();
  const previousCreatedAt = Number(previousExact?.created_at_ms || 0);
  const previousExpired = Number(previousExact?.expires_at_ms || 0) <= wallClockNow;
  // TTL切れ直後の再利用が同じmillisecondでも、監査世代を必ず前世代より進める。
  const now =
    previousExact && previousExpired
      ? Math.max(wallClockNow, previousCreatedAt + 1)
      : wallClockNow;
  const expiresAtMs = now + API_IDEMPOTENCY_TTL_MS;
  const exactPruneResult = await db
    .prepare(
      `
      DELETE FROM api_idempotency_keys
       WHERE org_id = ?1
         AND actor_user_id = ?2
         AND request_id = ?3
         AND route = ?4
         AND expires_at_ms <= ?5
    `
    )
    .bind(orgId, actorUserId, requestId, route, wallClockNow)
    .run();
  const remainingPruneLimit = Math.max(
    0,
    API_IDEMPOTENCY_PRUNE_LIMIT - Number(exactPruneResult?.meta?.changes || 0)
  );
  if (remainingPruneLimit > 0) {
    await db
      .prepare(
        `
        DELETE FROM api_idempotency_keys
         WHERE idempotency_key_id IN (
           SELECT idempotency_key_id
             FROM api_idempotency_keys
            WHERE expires_at_ms <= ?1
            ORDER BY expires_at_ms ASC
            LIMIT ?2
         )
      `
      )
      .bind(wallClockNow, remainingPruneLimit)
      .run();
  }
  const keyId = await createRequestScopedId({
    kind: 'api-idempotency-key',
    orgId,
    actorUserId,
    requestId,
    resourceScope: route,
  });
  const insertResult = await db
    .prepare(
      `
      INSERT OR IGNORE INTO api_idempotency_keys (
        idempotency_key_id,
        org_id,
        actor_user_id,
        request_id,
        route,
        payload_sha256,
        created_at_ms,
        expires_at_ms
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `
    )
    .bind(keyId, orgId, actorUserId, requestId, route, payloadSha256, now, expiresAtMs)
    .run();
  const inserted = Number(insertResult?.meta?.changes || 0) > 0;

  // INSERT OR IGNORE の直後にDB正本を再読し、並行要求でも先着payloadを基準に判定する。
  const persisted = await db
    .prepare(
      `
      SELECT idempotency_key_id,
             payload_sha256,
             created_at_ms,
             expires_at_ms
        FROM api_idempotency_keys
       WHERE org_id = ?1
         AND actor_user_id = ?2
         AND request_id = ?3
         AND route = ?4
       LIMIT 1
    `
    )
    .bind(orgId, actorUserId, requestId, route)
    .first();
  if (!persisted?.payload_sha256) {
    const error = new Error('Failed to read the persisted idempotency key.');
    error.code = 'idempotency_key_unavailable';
    throw error;
  }
  return {
    conflict: persisted.payload_sha256 !== payloadSha256,
    inserted,
    replay: !inserted && persisted.payload_sha256 === payloadSha256,
    keyId: persisted.idempotency_key_id,
    payloadSha256: persisted.payload_sha256,
    createdAtMs: persisted.created_at_ms,
    expiresAtMs: persisted.expires_at_ms,
  };
}

async function releaseInsertedApiIdempotencyKey(db, options = {}) {
  const orgId = normalizeIdValue(options.orgId || '');
  const actorUserId = normalizeIdValue(options.actorUserId || '');
  const requestId = String(options.requestId || '').trim();
  const route = String(options.route || '').trim();
  const keyId = normalizeIdValue(options.keyId || '');
  const payloadSha256 = String(options.payloadSha256 || '').trim();
  const createdAtMs = Number(options.createdAtMs);
  const expiresAtMs = Number(options.expiresAtMs);
  if (
    options.inserted !== true ||
    !db ||
    !orgId ||
    !actorUserId ||
    !requestId ||
    !route ||
    !keyId ||
    !/^[0-9a-f]{64}$/.test(payloadSha256) ||
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs)
  ) {
    return false;
  }
  const result = await db
    .prepare(
      `
      DELETE FROM api_idempotency_keys
       WHERE idempotency_key_id = ?1
         AND org_id = ?2
         AND actor_user_id = ?3
         AND request_id = ?4
         AND route = ?5
         AND payload_sha256 = ?6
         AND created_at_ms = ?7
         AND expires_at_ms = ?8
    `
    )
    .bind(
      keyId,
      orgId,
      actorUserId,
      requestId,
      route,
      payloadSha256,
      createdAtMs,
      expiresAtMs
    )
    .run();
  return Number(result?.meta?.changes || 0) > 0;
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

function normalizeSettingsVersion(value) {
  const normalized = normalizeIdValue(value).toLowerCase();
  if (normalized === '0' || /^[0-9a-f]{32}$/.test(normalized)) {
    return normalized;
  }
  return '';
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

function normalizeLanguageInput(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ja' || normalized === 'en') {
    return normalized;
  }
  return null;
}

function resolveLanguageValue(value) {
  return normalizeLanguageInput(value) || DEFAULT_LANGUAGE;
}

function computeEffectiveStatus(userStatusRaw, membershipStatusRaw, membershipId, isActiveFlag) {
  const derivedUserStatus =
    userStatusRaw != null && userStatusRaw !== ''
      ? userStatusRaw
      : isActiveFlag === 0
      ? 'suspended'
      : 'active';
  const derivedMembershipStatus =
    membershipStatusRaw != null && membershipStatusRaw !== ''
      ? membershipStatusRaw
      : membershipId
      ? 'active'
      : '';
  let status = normalizeUserStatusValue(derivedUserStatus);
  if (status === 'active') {
    const membershipStatus = normalizeUserStatusValue(derivedMembershipStatus);
    status = membershipStatus || 'active';
  }
  if (!status) status = 'pending';
  return status;
}

function clampPageSize(value, min = 25, max = 500) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return min;
  if (size < min) return min;
  if (size > max) return max;
  return Math.floor(size);
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
      reasonCode: 'd1_access_context_query_failed',
    });
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 access context is temporarily unavailable.'
    );
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
      orgId: row.org_id || '',
    };
    logAuthInfo('D1 auth subject mismatch; rejecting token', {
      requestId,
      email: mismatchContext.email,
    });
    return mismatchContext;
  }
  const status = computeEffectiveStatus(
    row.user_status,
    row.membership_status,
    row.membership_id,
    row.is_active
  );
  const hasMembership = Boolean(row.membership_id && row.org_id);
  const membershipStatus = normalizeUserStatusValue(row.membership_status || 'pending');
  const allowed = hasMembership && status === 'active' && membershipStatus === 'active';
  const role = hasMembership ? normalizeRoleValue(row.role || 'member') || 'member' : 'guest';
  const context = {
    allowed,
    status,
    role,
    email: row.email || tokenDetails.email || '',
    displayName: row.display_name || tokenDetails.name || '',
    reason: allowed
      ? ''
      : hasMembership
      ? deriveStatusReason(status)
      : '所属組織が登録されていません。管理者にお問い合わせください。',
    userId: row.user_id || '',
    authSubject: storedSubject,
    source: 'd1',
    reasonCode: allowed ? 'active' : hasMembership ? status || 'unknown' : 'no_membership',
    orgId: row.org_id || '',
  };
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

function parseRequestContentLength(request) {
  const raw = request?.headers?.get('content-length');
  if (raw === null || raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw.trim())) return NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

async function readRequestBytesWithLimit(request, maxBytes) {
  const normalizedMax = Number(maxBytes);
  if (!request || !Number.isSafeInteger(normalizedMax) || normalizedMax < 0) {
    throw new TypeError('A request and non-negative byte limit are required.');
  }
  const declaredLength = parseRequestContentLength(request);
  if (Number.isNaN(declaredLength)) {
    return { ok: false, code: 'invalid_content_length', status: 400, bytes: null };
  }
  if (declaredLength !== null && declaredLength > normalizedMax) {
    return { ok: false, code: 'request_body_too_large', status: 413, bytes: null };
  }
  if (!request.body) {
    const empty = new Uint8Array(0);
    if (declaredLength !== null && declaredLength !== 0) {
      return { ok: false, code: 'content_length_mismatch', status: 400, bytes: null };
    }
    return { ok: true, bytes: empty, sizeBytes: 0, declaredLength };
  }
  const reader = request.body.getReader();
  // chunk配列は極小chunk大量送信で要素数オーバーヘッドが増えるため使わない。
  // 長さ不明bodyは64KBから幾何拡張し、slow uploadが上限全量を先取りしない。
  let capacity =
    declaredLength === null ? Math.min(normalizedMax, 64 * 1024) : declaredLength;
  let buffer = new Uint8Array(capacity);
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      const nextTotal = total + chunk.byteLength;
      if (nextTotal > normalizedMax || (declaredLength !== null && nextTotal > capacity)) {
        try {
          await reader.cancel(
            nextTotal > normalizedMax ? 'request_body_too_large' : 'content_length_mismatch'
          );
        } catch (_ignore) {
          // 読み取り停止が失敗しても、上限超過bodyを後段へ渡さない。
        }
        return nextTotal > normalizedMax
          ? { ok: false, code: 'request_body_too_large', status: 413, bytes: null }
          : { ok: false, code: 'content_length_mismatch', status: 400, bytes: null };
      }
      if (nextTotal > capacity) {
        const nextCapacity = Math.min(
          normalizedMax,
          Math.max(nextTotal, Math.max(64 * 1024, capacity * 2))
        );
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(buffer.subarray(0, total));
        buffer = expanded;
        capacity = nextCapacity;
      }
      buffer.set(chunk, total);
      total = nextTotal;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_ignore) {
      // 既にcancel済みのreaderはreleaseできない実装がある。
    }
  }
  if (declaredLength !== null && declaredLength !== total) {
    return { ok: false, code: 'content_length_mismatch', status: 400, bytes: null };
  }
  const bytes = total === buffer.byteLength ? buffer : buffer.slice(0, total);
  return { ok: true, bytes, sizeBytes: total, declaredLength };
}

function normalizeStagedAttachmentPurpose(route, rawPurpose) {
  const normalizedRoute = String(route || '').trim();
  if (normalizedRoute === 'stageMessageAttachment') return 'message';
  if (normalizedRoute === 'stageProfileAttachment') return 'profile';
  const purpose = String(rawPurpose || '').trim().toLowerCase();
  return purpose === 'message' || purpose === 'profile' ? purpose : '';
}

function decodeStagedFileName(rawValue, fallback = 'attachment') {
  const raw = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!raw) return fallback;
  try {
    return decodeURIComponent(raw).slice(0, 255) || fallback;
  } catch (_error) {
    return raw.slice(0, 255) || fallback;
  }
}

function resolveStagedAttachmentMaxBytes(purpose) {
  return purpose === 'profile' ? PROFILE_IMAGE_MAX_BYTES : MESSAGE_ATTACHMENT_MAX_BYTES;
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

function extractCanonicalProfileAttachmentId(url) {
  if (!url || typeof url !== 'string') return '';
  const normalized = url.trim();
  if (!normalized || !normalized.startsWith('/api/downloadAttachment?')) return '';
  try {
    const parsed = new URL(normalized, 'https://shiftflow.invalid');
    if (parsed.origin !== 'https://shiftflow.invalid') return '';
    if (parsed.pathname !== '/api/downloadAttachment') return '';
    const keys = Array.from(parsed.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== 'attachmentId') return '';
    const attachmentId = normalizeIdValue(parsed.searchParams.get('attachmentId'));
    if (!attachmentId) return '';
    return buildAttachmentDownloadPath(attachmentId) === normalized ? attachmentId : '';
  } catch (_err) {
    return '';
  }
}

function buildContentDisposition(filename, disposition = 'inline') {
  if (!filename || typeof filename !== 'string') {
    return disposition;
  }
  const asciiName = filename.replace(/[^0-9A-Za-z()._\- ]+/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiName || 'file'}"; filename*=UTF-8''${utf8}`;
}

function buildStagedAttachmentStorageDescriptor(options) {
  const purpose = options?.purpose === 'profile' ? 'profile' : 'message';
  const mimeType = String(options?.mimeType || '').trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    const error = new Error('Unsupported MIME type.');
    error.code = 'unsupported_mime_type';
    throw error;
  }
  const stageId = normalizeIdValue(options?.stageId);
  const orgId = normalizeIdValue(options?.orgId);
  const ownerUserId = normalizeIdValue(options?.ownerUserId);
  if (!stageId || !orgId || !ownerUserId) {
    const error = new Error('Staged attachment scope is unavailable.');
    error.code = 'attachment_scope_unavailable';
    throw error;
  }
  const baseName = sanitizeFileBaseName(options?.fileName || stageId, 'attachment');
  const extension = guessExtensionFromMime(mimeType) || 'bin';
  const finalFileName = `${baseName}.${extension}`;
  const category = purpose === 'profile' ? 'profiles' : 'messages';
  // claim後も同じobjectをlive正本として使うため、expiryを連想するstaged prefixには置かない。
  // user IDやemailをobject keyへ露出せず、owner scopeはD1 metadataだけで管理する。
  const key = `orgs/${orgId}/${category}/objects/${stageId}/${finalFileName}`;
  const checksum = String(options?.checksum || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    const error = new Error('Attachment checksum is unavailable.');
    error.code = 'attachment_checksum_invalid';
    throw error;
  }
  return { stageId, orgId, ownerUserId, purpose, mimeType, fileName: finalFileName, key, checksum };
}

async function storeStagedBytesInR2(env, options) {
  if (!env?.R2 || typeof env.R2.put !== 'function') {
    const error = new Error('R2 bucket is not configured.');
    error.code = 'r2_unavailable';
    throw error;
  }
  const bytes = options?.bytes instanceof Uint8Array ? options.bytes : null;
  const purpose = options?.purpose === 'profile' ? 'profile' : 'message';
  const maxBytes = resolveStagedAttachmentMaxBytes(purpose);
  if (!bytes || bytes.byteLength < 1) {
    const error = new Error('Attachment body is empty.');
    error.code = 'attachment_data_missing';
    throw error;
  }
  if (bytes.byteLength > maxBytes) {
    const error = new Error('File size exceeds allowed limit.');
    error.code = 'file_too_large';
    throw error;
  }
  const descriptor = buildStagedAttachmentStorageDescriptor(options);
  await env.R2.put(descriptor.key, bytes, {
    httpMetadata: {
      contentType: descriptor.mimeType,
      cacheControl: 'private, no-store',
      contentDisposition: buildContentDisposition(descriptor.fileName),
    },
    customMetadata: {
      sha256: descriptor.checksum,
      purpose: descriptor.purpose,
      stageId: descriptor.stageId,
    },
  });
  return {
    stageId: descriptor.stageId,
    key: descriptor.key,
    mimeType: descriptor.mimeType,
    size: bytes.byteLength,
    checksum: descriptor.checksum,
    fileName: descriptor.fileName,
  };
}

function buildStagedAttachmentClientResult(row, options = {}) {
  return {
    stagedAttachmentId: row?.staged_attachment_id || '',
    expiresAtMs: Number(row?.expires_at_ms || 0),
    fileName: row?.file_name || '',
    mimeType: row?.content_type || '',
    sizeBytes: Number(row?.size_bytes || 0),
    checksum: row?.checksum || '',
    purpose: row?.purpose || '',
    status: row?.status || '',
    idempotentReplay: options.idempotentReplay === true,
  };
}

async function loadStagedAttachmentById(db, stagedAttachmentId) {
  const normalizedId = normalizeIdValue(stagedAttachmentId);
  if (!db || !normalizedId) return null;
  return db
    .prepare(
      `
      SELECT staged_attachment_id,
             org_id,
             owner_user_id,
             owner_membership_id,
             purpose,
             file_name,
             content_type,
             size_bytes,
             checksum,
             r2_key,
             request_id,
             request_payload_sha256,
             request_generation_ms,
             status,
             claimed_target_type,
             claimed_target_id,
             claimed_at_ms,
             created_at_ms,
             updated_at_ms,
             expires_at_ms
        FROM staged_attachments
       WHERE staged_attachment_id = ?1
       LIMIT 1
    `
    )
    .bind(normalizedId)
    .first();
}

async function pruneReleasedStagedAttachmentTombstones(db, context = {}) {
  const orgId = normalizeIdValue(context.orgId);
  const ownerUserId = normalizeIdValue(context.ownerUserId);
  const now = Number(context.now || Date.now());
  if (!db || !orgId || !ownerUserId || !Number.isFinite(now)) return;
  // R2 cleanup後もidempotency世代が有効な間はrowをtombstoneとして保持する。
  // 古いupload requestの再送で新しいprofile stageを巻き戻さないための境界。
  await db
    .prepare(
      `
      DELETE FROM staged_attachments
       WHERE staged_attachment_id IN (
         SELECT staged.staged_attachment_id
           FROM staged_attachments staged
          WHERE staged.org_id = ?1
            AND staged.owner_user_id = ?2
            AND (
              (staged.status <> 'claimed'
                AND (staged.status IN ('superseded', 'failed') OR staged.expires_at_ms <= ?3))
              OR
              (staged.status = 'claimed'
                AND NOT EXISTS (
                  SELECT 1
                    FROM attachments live_attachment
                   WHERE live_attachment.attachment_id = staged.staged_attachment_id
                ))
            )
            AND NOT EXISTS (
              SELECT 1
                FROM storage_cleanup_jobs cleanup
               WHERE cleanup.r2_key = staged.r2_key
            )
            AND NOT EXISTS (
              SELECT 1
                FROM api_idempotency_keys idem
               WHERE idem.org_id = staged.org_id
                 AND idem.actor_user_id = staged.owner_user_id
                 AND idem.request_id = staged.request_id
                 AND idem.payload_sha256 = staged.request_payload_sha256
                 AND idem.created_at_ms = staged.request_generation_ms
            )
          ORDER BY staged.updated_at_ms ASC
          LIMIT 25
       )
    `
    )
    .bind(orgId, ownerUserId, now)
    .run();
}

async function resolveStagedAttachmentsForClaim(db, options = {}) {
  const rawIds = Array.isArray(options.stagedAttachmentIds)
    ? options.stagedAttachmentIds
    : [];
  const ids = rawIds.map((value) => normalizeIdValue(value)).filter(Boolean);
  if (!db || !ids.length || ids.length !== rawIds.length || new Set(ids).size !== ids.length) {
    return null;
  }
  const orgId = normalizeIdValue(options.orgId);
  const ownerUserId = normalizeIdValue(options.ownerUserId);
  const ownerMembershipId = normalizeIdValue(options.ownerMembershipId);
  const purpose = options.purpose === 'profile' ? 'profile' : 'message';
  const targetType = options.targetType === 'user_settings' ? 'user_settings' : 'message';
  const targetId = normalizeIdValue(options.targetId);
  if (!orgId || !ownerUserId || !ownerMembershipId || !targetId) return null;
  const placeholders = ids.map((_, index) => `?${index + 4}`).join(', ');
  const result = await db
    .prepare(
      `
      SELECT staged_attachment_id,
             org_id,
             owner_user_id,
             owner_membership_id,
             purpose,
             file_name,
             content_type,
             size_bytes,
             checksum,
             r2_key,
             status,
             claimed_target_type,
             claimed_target_id,
             claimed_at_ms,
             created_at_ms,
             expires_at_ms
        FROM staged_attachments
       WHERE org_id = ?1
         AND owner_user_id = ?2
         AND owner_membership_id = ?3
         AND staged_attachment_id IN (${placeholders})
    `
    )
    .bind(orgId, ownerUserId, ownerMembershipId, ...ids)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const byId = new Map(rows.map((row) => [normalizeIdValue(row?.staged_attachment_id), row]));
  const now = Date.now();
  const ordered = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.purpose !== purpose || !isR2KeyWithinOrg(row.r2_key, orgId)) return null;
    const ready = row.status === 'ready' && Number(row.expires_at_ms || 0) > now;
    const alreadyClaimed =
      row.status === 'claimed' &&
      row.claimed_target_type === targetType &&
      row.claimed_target_id === targetId;
    if (!ready && !alreadyClaimed) return null;
    ordered.push(row);
  }
  return ordered;
}

function buildStagedAttachmentClaimStatement(db, row, context = {}) {
  if (!db || !row) return null;
  const stagedAttachmentId = normalizeIdValue(row.staged_attachment_id);
  const orgId = normalizeIdValue(context.orgId);
  const ownerUserId = normalizeIdValue(context.ownerUserId);
  const ownerMembershipId = normalizeIdValue(context.ownerMembershipId);
  const targetType = context.targetType === 'user_settings' ? 'user_settings' : 'message';
  const targetId = normalizeIdValue(context.targetId);
  const purpose = context.purpose === 'profile' ? 'profile' : 'message';
  if (!stagedAttachmentId || !orgId || !ownerUserId || !ownerMembershipId || !targetId) {
    return null;
  }
  const now = Number(context.claimedAtMs || Date.now());
  let targetGuard = '';
  const bindValues = [
    stagedAttachmentId,
    orgId,
    ownerUserId,
    ownerMembershipId,
    purpose,
    targetType,
    targetId,
    now,
  ];
  if (targetType === 'message') {
    targetGuard = `
      AND EXISTS (
        SELECT 1
          FROM messages claim_target
         WHERE claim_target.message_id = ?7
           AND claim_target.org_id = ?2
      )`;
  } else {
    const expectedSettingsVersion = normalizeSettingsVersion(context.expectedSettingsVersion);
    if (!expectedSettingsVersion) return null;
    bindValues.push(expectedSettingsVersion);
    targetGuard = `
      AND EXISTS (
        SELECT 1
          FROM users claim_target
         WHERE claim_target.user_id = ?3
           AND claim_target.settings_version = ?9
      )`;
  }
  return db
    .prepare(
      `
      UPDATE staged_attachments
         SET status = 'claimed',
             claimed_target_type = ?6,
             claimed_target_id = ?7,
             claimed_at_ms = CASE WHEN status = 'ready' THEN ?8 ELSE claimed_at_ms END,
             updated_at_ms = MAX(updated_at_ms, ?8)
       WHERE staged_attachment_id = ?1
         AND org_id = ?2
         AND owner_user_id = ?3
         AND owner_membership_id = ?4
         AND purpose = ?5
         AND (
           (status = 'ready'
             AND expires_at_ms > ?8
             AND claimed_target_type IS NULL
             AND claimed_target_id IS NULL)
           OR
           (status = 'claimed'
             AND claimed_target_type = ?6
             AND claimed_target_id = ?7)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM storage_cleanup_jobs cleanup_guard
            WHERE cleanup_guard.r2_key = staged_attachments.r2_key
              AND cleanup_guard.org_id = staged_attachments.org_id
              AND cleanup_guard.lease_token IS NOT NULL
         )
         ${targetGuard}
    `
    )
    .bind(...bindValues);
}

function buildStagedMessageAttachmentLinkStatement(db, stagedAttachmentId, messageId, orgId) {
  if (!db) return null;
  return db
    .prepare(
      `
      INSERT OR IGNORE INTO message_attachments (message_id, attachment_id)
      SELECT ?2, ?1
       WHERE EXISTS (
         SELECT 1
           FROM staged_attachments staged
          WHERE staged.staged_attachment_id = ?1
            AND staged.org_id = ?3
            AND staged.status = 'claimed'
            AND staged.claimed_target_type = 'message'
            AND staged.claimed_target_id = ?2
       )
    `
    )
    .bind(stagedAttachmentId, messageId, orgId);
}

async function handleStageAttachmentRoute(options) {
  const {
    db,
    env,
    requestId,
    allowedOrigin,
    config,
    tokenDetails,
    accessContext,
    idempotencyContext,
    binaryUpload,
  } = options || {};
  const purpose = binaryUpload?.purpose === 'profile' ? 'profile' : 'message';
  const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
  const membership = actorEmail
    ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
    : null;
  const orgId = normalizeIdValue(accessContext?.orgId || '');
  const ownerUserId = normalizeIdValue(accessContext?.userId || '');
  if (
    !membership?.membership_id ||
    membership.org_id !== orgId ||
    membership.user_id !== ownerUserId
  ) {
    return errorResponse(
      403,
      allowedOrigin,
      requestId,
      'cf-api',
      'attachment_scope_unavailable',
      '添付ファイルの所有者と所属組織を確認できません。'
    );
  }
  if (!(binaryUpload?.bytes instanceof Uint8Array) || binaryUpload.bytes.byteLength < 1) {
    return errorResponse(
      400,
      allowedOrigin,
      requestId,
      'cf-api',
      'attachment_data_missing',
      '添付ファイルのデータが空です。'
    );
  }
  const requestGenerationMs = Number(idempotencyContext?.createdAtMs || 0);
  if (!Number.isFinite(requestGenerationMs) || requestGenerationMs <= 0) {
    return errorResponse(
      503,
      allowedOrigin,
      requestId,
      'cf-api',
      'idempotency_generation_unavailable',
      'アップロード操作の世代を確認できませんでした。新しい操作としてやり直してください。'
    );
  }
  await pruneReleasedStagedAttachmentTombstones(db, {
    orgId,
    ownerUserId,
    now: Date.now(),
  });
  const stagedAttachmentId = await createRequestScopedId({
    kind: 'staged-attachment',
    orgId,
    actorUserId: ownerUserId,
    requestId,
    resourceScope: `${purpose}:${idempotencyContext?.payloadSha256 || ''}:${requestGenerationMs}`,
  });
  const descriptor = buildStagedAttachmentStorageDescriptor({
    ...binaryUpload,
    stageId: stagedAttachmentId,
    orgId,
    ownerUserId,
  });
  const now = Date.now();
  const expiresAtMs = now + STAGED_ATTACHMENT_TTL_MS;
  const existing = await loadStagedAttachmentById(db, stagedAttachmentId);
  if (existing) {
    const samePayload =
      existing.org_id === orgId &&
      existing.owner_user_id === ownerUserId &&
      existing.owner_membership_id === membership.membership_id &&
      existing.purpose === purpose &&
      existing.checksum === descriptor.checksum &&
      Number(existing.size_bytes) === binaryUpload.bytes.byteLength &&
      existing.content_type === descriptor.mimeType &&
      existing.r2_key === descriptor.key &&
      Number(existing.request_generation_ms || 0) === requestGenerationMs;
    if (!samePayload) {
      return errorResponse(
        409,
        allowedOrigin,
        requestId,
        'cf-api',
        'staged_attachment_conflict',
        '同じアップロードIDに異なるファイル情報が記録されています。新しい操作としてやり直してください。'
      );
    }
    if (Number(existing.expires_at_ms || 0) <= now && existing.status !== 'claimed') {
      return errorResponse(
        410,
        allowedOrigin,
        requestId,
        'cf-api',
        'staged_attachment_expired',
        '一時保存した添付ファイルの有効期限が切れました。もう一度選択してください。'
      );
    }
    if (existing.status === 'ready' || existing.status === 'claimed') {
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: buildStagedAttachmentClientResult(existing, { idempotentReplay: true }),
        },
        allowedOrigin,
        requestId
      );
    }
    if (existing.status === 'superseded') {
      return errorResponse(
        410,
        allowedOrigin,
        requestId,
        'cf-api',
        'staged_attachment_superseded',
        'この一時保存ファイルは新しい選択に置き換えられました。最新のファイルを使用してください。'
      );
    }
    if (existing.status === 'failed') {
      let retryState;
      try {
        const retryResults = await db.batch([
          db
            .prepare(
              `
              UPDATE staged_attachments
                 SET status = 'uploading',
                     updated_at_ms = ?2
               WHERE staged_attachment_id = ?1
                 AND status = 'failed'
                 AND expires_at_ms > ?2
                 AND NOT EXISTS (
                   SELECT 1
                     FROM storage_cleanup_jobs cleanup_guard
                    WHERE cleanup_guard.r2_key = staged_attachments.r2_key
                      AND cleanup_guard.org_id = staged_attachments.org_id
                      AND cleanup_guard.lease_token IS NOT NULL
                 )
            `
            )
            .bind(stagedAttachmentId, now),
          buildStorageCleanupJobStatement(db, descriptor.key, {
            orgId,
            targetType: 'staged_attachment',
            targetId: stagedAttachmentId,
            reason: 'upload_uncommitted',
            requestId,
            onlyIfPreviousStatementChanged: true,
          }),
        ]);
        retryState = retryResults?.[0];
      } catch (error) {
        if (String(error?.message || '').includes('staged_attachment_quota_exceeded')) {
          return errorResponse(
            429,
            allowedOrigin,
            requestId,
            'cf-api',
            'staged_attachment_quota_exceeded',
            '未使用の添付が上限に達しています。先に投稿または保存してください。'
          );
        }
        throw error;
      }
      if (Number(retryState?.meta?.changes || 0) === 0) {
        return errorResponse(
          409,
          allowedOrigin,
          requestId,
          'cf-api',
          'staged_attachment_retry_blocked',
          '一時保存ファイルの後処理中です。新しい操作としてもう一度選択してください。'
        );
      }
    }
  }
  if (!existing && idempotencyContext?.replay) {
    return errorResponse(
      409,
      allowedOrigin,
      requestId,
      'cf-api',
      'staged_attachment_replay_missing',
      '以前のアップロード状態を確認できません。新しい操作としてもう一度選択してください。'
    );
  }
  let supersededProfileRows = [];
  if (!existing) {
    if (purpose === 'profile') {
      const supersededResult = await db
        .prepare(
          `
          SELECT staged_attachment_id, r2_key
            FROM staged_attachments
           WHERE org_id = ?1
             AND owner_user_id = ?2
             AND purpose = 'profile'
             AND status IN ('ready', 'failed')
             AND expires_at_ms > ?3
        `
        )
        .bind(orgId, ownerUserId, now)
        .all();
      supersededProfileRows = Array.isArray(supersededResult?.results)
        ? supersededResult.results
        : [];
    }
    try {
      await db.batch(
        [
          purpose === 'profile'
            ? db
                .prepare(
                  `
                  UPDATE staged_attachments
                     SET status = 'superseded',
                         updated_at_ms = ?3
                   WHERE org_id = ?1
                     AND owner_user_id = ?2
                     AND purpose = 'profile'
                     AND status IN ('ready', 'failed')
                     AND expires_at_ms > ?3
                `
                )
                .bind(orgId, ownerUserId, now)
            : null,
          db
            .prepare(
              `
              INSERT OR IGNORE INTO staged_attachments (
                staged_attachment_id,
                org_id,
                owner_user_id,
                owner_membership_id,
                purpose,
                file_name,
                content_type,
                size_bytes,
                checksum,
                r2_key,
                request_id,
                request_payload_sha256,
                request_generation_ms,
                status,
                created_at_ms,
                updated_at_ms,
                expires_at_ms
              )
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'uploading', ?14, ?14, ?15)
            `
            )
            .bind(
              stagedAttachmentId,
              orgId,
              ownerUserId,
              membership.membership_id,
              purpose,
              descriptor.fileName,
              descriptor.mimeType,
              binaryUpload.bytes.byteLength,
              descriptor.checksum,
              descriptor.key,
              requestId,
              idempotencyContext?.payloadSha256 || '',
              requestGenerationMs,
              now,
              expiresAtMs
            ),
          buildStorageCleanupJobStatement(db, descriptor.key, {
            orgId,
            targetType: 'staged_attachment',
            targetId: stagedAttachmentId,
            reason: 'upload_uncommitted',
            requestId,
          }),
        ].filter(Boolean)
      );
    } catch (error) {
      const message = String(error?.message || '');
      if (message.includes('staged_attachment_quota_exceeded')) {
        return errorResponse(
          429,
          allowedOrigin,
          requestId,
          'cf-api',
          'staged_attachment_quota_exceeded',
          purpose === 'profile'
            ? '未使用のプロフィール画像があります。先に保存するか、有効期限後に再試行してください。'
            : `未使用の添付が上限（${MESSAGE_ATTACHMENT_LIMIT} 件）に達しています。先に投稿するか、有効期限後に再試行してください。`
        );
      }
      throw error;
    }
    if (purpose === 'profile' && supersededProfileRows.length) {
      const supersededKeys = supersededProfileRows
        .map((row) => String(row?.r2_key || '').trim())
        .filter(Boolean);
      const cleaned = await cleanupR2KeysWithOutbox(db, env, supersededKeys, {
        orgId,
        targetType: 'staged_attachment',
        targetId: stagedAttachmentId,
        reason: 'profile_stage_superseded',
        requestId,
        config,
      });
      // cleanup後も有効なidempotency世代のtombstoneを保持し、古いrequestの復活を防ぐ。
      // TTL後の安全なmetadata回収はpruneReleasedStagedAttachmentTombstonesが担当する。
      void cleaned;
    }
  }
  let upload;
  try {
    upload = await storeStagedBytesInR2(env, {
      ...binaryUpload,
      purpose,
      stageId: stagedAttachmentId,
      orgId,
      ownerUserId,
      checksum: descriptor.checksum,
    });
  } catch (error) {
    try {
      await db
        .prepare(
          `
          UPDATE staged_attachments
             SET status = 'failed',
                 updated_at_ms = ?2
           WHERE staged_attachment_id = ?1
             AND status = 'uploading'
        `
        )
        .bind(stagedAttachmentId, Date.now())
        .run();
    } catch (_stateError) {
      // cleanup outboxを正本として残し、元のR2障害を応答する。
    }
    const code = error?.code === 'r2_unavailable' ? 'r2_unavailable' : 'attachment_upload_failed';
    return errorResponse(
      code === 'r2_unavailable' ? 503 : 502,
      allowedOrigin,
      requestId,
      'cf-api',
      code,
      code === 'r2_unavailable'
        ? 'ファイルストレージが一時的に利用できません。後ほど再試行してください。'
        : '添付ファイルを一時保存できませんでした。後ほど再試行してください。'
    );
  }
  const readyAtMs = Date.now();
  await db
    .prepare(
      `
      UPDATE staged_attachments
         SET status = 'ready',
             updated_at_ms = ?2
       WHERE staged_attachment_id = ?1
         AND org_id = ?3
         AND owner_user_id = ?4
         AND status = 'uploading'
         AND r2_key = ?5
         AND checksum = ?6
    `
    )
    .bind(
      stagedAttachmentId,
      readyAtMs,
      orgId,
      ownerUserId,
      upload.key,
      upload.checksum
    )
    .run();
  const persisted = await loadStagedAttachmentById(db, stagedAttachmentId);
  if (!persisted || (persisted.status !== 'ready' && persisted.status !== 'claimed')) {
    return errorResponse(
      503,
      allowedOrigin,
      requestId,
      'cf-api',
      'staged_attachment_state_unavailable',
      '添付ファイルの一時保存状態を確認できませんでした。後ほど再試行してください。'
    );
  }
  captureDiagnostics(config, 'info', 'attachment_staged', {
    event: 'attachment_staged',
    requestId,
    route: options?.route || '',
    orgId,
    userId: ownerUserId,
    targetId: stagedAttachmentId,
    detail: purpose,
  });
  return jsonResponseFromD1(
    existing ? 200 : 201,
    {
      ok: true,
      success: true,
      result: buildStagedAttachmentClientResult(persisted, {
        idempotentReplay: Boolean(existing || idempotencyContext?.replay),
      }),
    },
    allowedOrigin,
    requestId
  );
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
      reasonCode: 'feature_flag_lookup_failed',
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
         AND LOWER(
               COALESCE(
                 NULLIF(TRIM(u.status), ''),
                 CASE WHEN u.is_active = 0 THEN 'suspended' ELSE 'active' END
               )
             ) = 'active'
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

function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function normalizeFolderName(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, 120);
}

async function ensureDefaultFolderForOrg(db, orgId) {
  if (!db || !orgId) return null;
  const existing = await db
    .prepare(
      `
      SELECT id
        FROM folders
       WHERE org_id = ?1
         AND is_system = 1
       ORDER BY created_at_ms ASC
       LIMIT 1
    `
    )
    .bind(orgId)
    .first();
  if (existing && existing.id) {
    return existing.id;
  }
  const now = Date.now();
  const folderId = createUlid(now);
  await db
    .prepare(
      `
      INSERT INTO folders (
        id,
        org_id,
        name,
        sort_order,
        color,
        is_active,
        is_public,
        is_system,
        created_at_ms,
        updated_at_ms
      )
      VALUES (?1, ?2, ?3, 0, ?4, 1, 1, 1, ?5, ?5)
    `
    )
    .bind(folderId, orgId, DEFAULT_SYSTEM_FOLDER_NAME, DEFAULT_FOLDER_COLOR, now)
    .run();
  return folderId;
}

async function fetchFolderMemberMap(db, folderIds) {
  const map = new Map();
  if (!db || !Array.isArray(folderIds) || !folderIds.length) {
    return map;
  }
  const uniqueIds = Array.from(new Set(folderIds.filter(Boolean)));
  if (!uniqueIds.length) {
    return map;
  }
  const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(',');
  const query = `SELECT folder_id, user_id FROM folder_members WHERE folder_id IN (${placeholders})`;
  const result = await db.prepare(query).bind(...uniqueIds).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  rows.forEach((row) => {
    const folderId = row?.folder_id ? String(row.folder_id).trim() : '';
    const userId = row?.user_id ? String(row.user_id).trim() : '';
    if (!folderId || !userId) return;
    if (!map.has(folderId)) {
      map.set(folderId, []);
    }
    const list = map.get(folderId);
    if (!list.includes(userId)) {
      list.push(userId);
    }
  });
  uniqueIds.forEach((id) => {
    if (!map.has(id)) {
      map.set(id, []);
    }
  });
  return map;
}

async function fetchFoldersWithAccess(db, options = {}) {
  if (!db) return [];
  const orgId = normalizeIdValue(options.orgId);
  if (!orgId) return [];
  if (options.ensureDefaultFolder) {
    await ensureDefaultFolderForOrg(db, orgId);
  }
  const userId = options.userId || '';
  const includeInactive = !!options.includeInactive;
  const includeMembers = !!options.includeMembers;
  const isManager = !!options.isManager;
  const result = await db
    .prepare(
      `
      SELECT f.id,
             f.org_id,
             f.name,
             f.sort_order,
             f.color,
             f.is_active,
             f.is_public,
             f.is_system,
             f.archived_at_ms,
             f.archive_year,
             f.archive_category,
             f.notes,
             f.meta_json,
             f.created_at_ms,
             f.updated_at_ms,
             fm_user.user_id AS granted_user_id,
             COALESCE(member_counts.member_count, 0) AS member_count
        FROM folders f
        LEFT JOIN folder_members fm_user
          ON fm_user.folder_id = f.id
         AND fm_user.user_id = ?2
        LEFT JOIN (
          SELECT folder_id, COUNT(*) AS member_count
            FROM folder_members
           GROUP BY folder_id
        ) member_counts
          ON member_counts.folder_id = f.id
       WHERE f.org_id = ?1
         ${includeInactive ? '' : 'AND f.is_active = 1'}
       ORDER BY f.is_system DESC, f.sort_order ASC, lower(f.name) ASC
    `
    )
    .bind(orgId, userId || '')
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const allowedRows = rows.filter((row) => {
    if (isManager) return true;
    if (row?.is_public) return true;
    return !!row?.granted_user_id;
  });
  const folderIds = allowedRows.map((row) => row?.id).filter(Boolean);
  let memberMap = new Map();
  if (includeMembers && folderIds.length) {
    memberMap = await fetchFolderMemberMap(db, folderIds);
  }
  return allowedRows.map((row) => {
    const base = {
      id: row.id,
      orgId: row.org_id,
      name: row.name || DEFAULT_SYSTEM_FOLDER_NAME,
      sortOrder: typeof row.sort_order === 'number' ? row.sort_order : 0,
      color: row.color || null,
      isActive: row.is_active === 1,
      isPublic: row.is_public === 1,
      isSystem: row.is_system === 1,
      archivedAt: row.archived_at_ms || null,
      archiveYear: row.archive_year || null,
      archiveCategory: row.archive_category || '',
      notes: row.notes || '',
      meta: safeJsonParse(row.meta_json, null),
      memberCount: row.member_count || 0,
      createdAt: row.created_at_ms || null,
      updatedAt: row.updated_at_ms || null,
    };
    if (includeMembers) {
      base.memberUserIds = memberMap.get(row.id) || [];
    }
    return base;
  });
}

async function fetchPinnedMessagesFromD1(db, options = {}) {
  if (!db) return {};
  const orgId = normalizeIdValue(options.orgId);
  if (!orgId) return {};
  const membershipId = options.membershipId || '';
  const userId = options.userId || '';
  const isManager = !!options.isManager;
  const perFolderLimit =
    typeof options.perFolderLimit === 'number' && options.perFolderLimit > 0
      ? Math.floor(options.perFolderLimit)
      : PINNED_MESSAGE_LIMIT;
  const result = await db
    .prepare(
      `
      SELECT m.message_id,
             m.title,
             m.body,
             m.folder_id,
             m.created_at_ms,
             m.updated_at_ms,
             mp.pinned_at_ms,
             f.name AS folder_name,
             f.color AS folder_color,
             CASE WHEN mr.message_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
             CASE WHEN fm_user.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_private_access,
             f.is_public
        FROM messages m
        JOIN message_pins mp
          ON mp.message_id = m.message_id
         AND mp.membership_id = ?2
         AND mp.org_id = m.org_id
        JOIN folders f ON f.id = m.folder_id
        LEFT JOIN message_reads mr
          ON mr.message_id = m.message_id
         AND mr.membership_id = ?2
        LEFT JOIN folder_members fm_user
          ON fm_user.folder_id = f.id
         AND fm_user.user_id = ?3
       WHERE m.org_id = ?1
         AND f.is_active = 1
       ORDER BY f.sort_order ASC,
                mp.pinned_at_ms DESC,
                m.created_at_ms DESC
    `
    )
    .bind(orgId, membershipId || '', userId || '')
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const grouped = new Map();
  for (const row of rows) {
    const folderId = row?.folder_id ? String(row.folder_id).trim() : '';
    if (!folderId) continue;
    const isPublic = row?.is_public === 1;
    const hasAccess = isPublic || isManager || row?.has_private_access;
    if (!hasAccess) continue;
    if (!grouped.has(folderId)) {
      grouped.set(folderId, []);
    }
    const list = grouped.get(folderId);
    if (list.length >= perFolderLimit) continue;
    list.push({
      id: row?.message_id || '',
      title: row?.title || '',
      body: typeof row?.body === 'string' ? row.body : '',
      preview: buildMessagePreview(row?.body || ''),
      folderId,
      folderName: row?.folder_name || '',
      folderColor: row?.folder_color || '',
      createdAt: row?.created_at_ms || 0,
      updatedAt: row?.updated_at_ms || 0,
      isPinned: true,
      isRead: row?.is_read ? true : false,
    });
  }
  const payload = {};
  grouped.forEach((value, key) => {
    payload[key] = value;
  });
  return payload;
}

async function fetchFolderById(db, orgId, folderId) {
  if (!db || !folderId) return null;
  const row = await db
    .prepare(
      `
      SELECT *
        FROM folders
       WHERE id = ?1
         AND (?2 IS NULL OR org_id = ?2)
       LIMIT 1
    `
    )
    .bind(folderId, orgId || null)
    .first();
  return row || null;
}

async function ensureFolderAccessForUser(db, options = {}) {
  if (!db || !options.folderId) return null;
  const folder = await fetchFolderById(db, options.orgId || null, options.folderId);
  if (!folder) return null;
  if (options.requireActive && folder.is_active !== 1) {
    return null;
  }
  if (folder.is_public === 1 || options.isManager) {
    return folder;
  }
  const userId = options.userId || '';
  if (!userId) return null;
  const member = await db
    .prepare(
      `
      SELECT 1
        FROM folder_members
       WHERE folder_id = ?1
         AND user_id = ?2
       LIMIT 1
    `
    )
    .bind(folder.id, userId)
    .first();
  return member ? folder : null;
}

async function resolveMemoReadAccess(db, options = {}) {
  const messageId = normalizeIdValue(options.messageId || '');
  const orgId = normalizeIdValue(options.orgId || '');
  if (!db || !messageId || !orgId) {
    return { status: 'not_found', messageId };
  }
  const message = await db
    .prepare(
      `
      SELECT message_id,
             org_id,
             folder_id
        FROM messages
       WHERE message_id = ?1
       LIMIT 1
    `
    )
    .bind(messageId)
    .first();
  if (!message || message.org_id !== orgId) {
    return { status: 'not_found', messageId };
  }
  const folder = await ensureFolderAccessForUser(db, {
    folderId: message.folder_id,
    orgId,
    userId: options.userId || '',
    isManager: Boolean(options.isManager),
  });
  if (!folder) {
    return { status: 'forbidden', messageId };
  }
  return { status: 'allowed', messageId, message, folder };
}

async function preflightMemoReadAccess(db, messageIds, options = {}) {
  const results = [];
  for (const messageId of messageIds) {
    results.push(
      await resolveMemoReadAccess(db, {
        ...options,
        messageId,
      })
    );
  }
  if (results.some((entry) => entry.status === 'not_found')) {
    return { status: 'not_found', results };
  }
  if (results.some((entry) => entry.status === 'forbidden')) {
    return { status: 'forbidden', results };
  }
  return { status: 'allowed', results };
}

async function normalizeFolderMemberIds(db, orgId, memberUserIds) {
  if (!db || !orgId || !Array.isArray(memberUserIds) || !memberUserIds.length) {
    return [];
  }
  const uniqueIds = Array.from(
    new Set(memberUserIds.map((id) => normalizeIdValue(id)).filter(Boolean))
  );
  if (!uniqueIds.length) return [];
  const placeholders = uniqueIds.map((_, index) => `?${index + 2}`).join(',');
  const query = `
    SELECT DISTINCT user_id
      FROM memberships
     WHERE org_id = ?1
       AND user_id IN (${placeholders})
       AND LOWER(COALESCE(status, 'active')) = 'active'
  `;
  const result = await db.prepare(query).bind(orgId, ...uniqueIds).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const allowed = new Set(rows.map((row) => row?.user_id).filter(Boolean));
  return uniqueIds.filter((userId) => allowed.has(userId));
}

async function folderNameExists(db, orgId, name, excludeFolderId) {
  if (!db || !orgId || !name) return false;
  const sql = excludeFolderId
    ? `
      SELECT id
        FROM folders
       WHERE org_id = ?1
         AND lower(name) = lower(?2)
         AND id <> ?3
       LIMIT 1
    `
    : `
      SELECT id
        FROM folders
       WHERE org_id = ?1
         AND lower(name) = lower(?2)
       LIMIT 1
    `;
  const statement = db.prepare(sql);
  const row = excludeFolderId
    ? await statement.bind(orgId, name, excludeFolderId).first()
    : await statement.bind(orgId, name).first();
  return !!row;
}

const MY_TASK_COMPLETED_WINDOW_DAYS = 14;
const MY_TASK_COMPLETED_WINDOW_MS = MY_TASK_COMPLETED_WINDOW_DAYS * 24 * 60 * 60 * 1000;

async function buildMyTasksPayload(db, rawEmail, orgId = '') {
  const normalizedEmail = normalizeEmailValue(rawEmail);
  const totalRow = await db
    .prepare('SELECT COUNT(*) AS count FROM tasks WHERE org_id = ?1')
    .bind(orgId || '')
    .first();
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
         AND t.org_id = ?2
    `
    )
    .bind(normalizedEmail, orgId || '')
    .all();
  const rows = Array.isArray(assignedResult?.results) ? assignedResult.results : [];
  const assigneeMap = await fetchAssigneesForTasks(
    db,
    rows.map((row) => row.task_id)
  );
  const tasks = rows
    .map((row) => buildTaskRecordFromD1(row, assigneeMap.get(row.task_id) || []))
    .filter(Boolean);
  const completionCutoff = Date.now() - MY_TASK_COMPLETED_WINDOW_MS;
  const filteredTasks = tasks.filter((task) => {
    if (!task) return false;
    if (!task.isCompleted) return true;
    const updatedValue =
      typeof task.updatedAtValue === 'number' && Number.isFinite(task.updatedAtValue)
        ? task.updatedAtValue
        : typeof task.updatedAt === 'number' && Number.isFinite(task.updatedAt)
        ? task.updatedAt
        : null;
    if (updatedValue == null) {
      return true;
    }
    return updatedValue >= completionCutoff;
  });
  const droppedTasks = tasks.length - filteredTasks.length;
  const todayMs = startOfTodayMs();
  filteredTasks.sort((a, b) => compareTasksForList(a, b, todayMs));
  return {
    tasks: filteredTasks,
    meta: {
      totalTasks,
      matchedTasks: filteredTasks.length,
      filteredOutTasks: droppedTasks > 0 ? droppedTasks : 0,
      completionWindowDays: MY_TASK_COMPLETED_WINDOW_DAYS,
      rawEmail,
      normalizedEmail,
      sampleTaskIds: filteredTasks.slice(0, 5).map((task) => task.id),
      note:
        droppedTasks > 0
          ? `完了から ${MY_TASK_COMPLETED_WINDOW_DAYS} 日を超えたタスク (${droppedTasks} 件) は一覧から除外されています。`
          : '',
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

async function fetchMessageComments(db, messageId) {
  if (!db || !messageId) return [];
  const result = await db
    .prepare(
      `
      SELECT mc.comment_id,
             mc.body,
             mc.mentions,
             mc.created_at_ms,
             mc.author_email,
             mc.author_display_name,
             u.email AS user_email,
             u.display_name AS user_display_name
        FROM message_comments mc
        LEFT JOIN memberships ms ON ms.membership_id = mc.membership_id
        LEFT JOIN users u ON u.user_id = ms.user_id
       WHERE mc.message_id = ?1
       ORDER BY mc.created_at_ms ASC
    `
    )
    .bind(messageId)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.map((row) => {
    const email = row?.user_email || row?.author_email || '';
    const displayName = row?.user_display_name || row?.author_display_name || '';
    let mentions = [];
    if (row?.mentions) {
      mentions = String(row.mentions)
        .split(',')
        .map((m) => normalizeEmailValue(m))
        .filter(Boolean);
    }
    return {
      id: row?.comment_id || '',
      body: typeof row?.body === 'string' ? row.body : '',
      authorEmail: email,
      authorName: displayName,
      author: displayName || email,
      createdAtMs:
        typeof row?.created_at_ms === 'number' && Number.isFinite(row.created_at_ms)
          ? row.created_at_ms
          : 0,
      createdAt: row?.created_at_ms ? formatJst(row.created_at_ms, true) : '',
      mentions,
    };
  });
}

async function buildMessagesForUser(db, options = {}) {
  if (!db) return [];
  const folderRaw = typeof options.folderId === 'string' ? options.folderId.trim() : '';
  const folderFilter =
    folderRaw && folderRaw.toLowerCase() !== 'all' ? folderRaw : '';
  const membershipId = options?.membershipId || '';
  const userId = options?.userId || '';
  const orgId = normalizeIdValue(options?.orgId);
  if (!orgId) return [];
  const isManager = !!options?.isManager;
  const includeInactiveFolders = !!options?.includeInactiveFolders;
  const result = await db
    .prepare(
      `
      SELECT m.message_id,
             m.title,
             m.body,
             m.folder_id,
             m.priority,
             m.created_at_ms,
             m.updated_at_ms,
             CASE WHEN mp.message_id IS NOT NULL THEN 1 ELSE 0 END AS is_pinned,
             f.name AS folder_name,
             f.color AS folder_color,
             author_user.email AS author_email,
             COALESCE(author_user.display_name, author_user.email) AS author_name,
             CASE WHEN mr.message_id IS NOT NULL THEN 1 ELSE 0 END AS is_read,
             mr.read_at_ms,
             (SELECT COUNT(*) FROM message_comments c
               WHERE c.org_id = m.org_id AND c.message_id = m.message_id) AS comment_count,
             (SELECT MAX(c.created_at_ms) FROM message_comments c
               WHERE c.org_id = m.org_id AND c.message_id = m.message_id) AS last_comment_at_ms
        FROM messages m
        JOIN folders f ON f.id = m.folder_id
        LEFT JOIN message_reads mr
          ON mr.message_id = m.message_id
         AND mr.membership_id = ?3
        LEFT JOIN message_pins mp
          ON mp.message_id = m.message_id
         AND mp.membership_id = ?3
         AND mp.org_id = m.org_id
        LEFT JOIN memberships author_ms
          ON author_ms.membership_id = m.author_membership_id
        LEFT JOIN users author_user
          ON author_user.user_id = author_ms.user_id
        LEFT JOIN folder_members fm_user
          ON fm_user.folder_id = f.id
         AND fm_user.user_id = ?4
       WHERE m.org_id = ?1
         AND (?2 = '' OR m.folder_id = ?2)
         ${includeInactiveFolders ? '' : 'AND f.is_active = 1'}
         AND (
           f.is_public = 1
           OR ?5 = 1
           OR fm_user.user_id IS NOT NULL
         )
       ORDER BY CASE WHEN mp.message_id IS NOT NULL THEN 1 ELSE 0 END DESC,
                MAX(
                  COALESCE(last_comment_at_ms, 0),
                  COALESCE(m.updated_at_ms, m.created_at_ms)
                ) DESC,
                m.created_at_ms DESC
    `
    )
    .bind(orgId, folderFilter || '', membershipId || '', userId || '', isManager ? 1 : 0)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.map((row) => {
    const createdAtMs =
      typeof row?.created_at_ms === 'number' && Number.isFinite(row.created_at_ms)
        ? row.created_at_ms
        : 0;
    const priority = mapD1PriorityToLegacy(row?.priority);
    const authorLabel = buildUserLabel(row?.author_email, row?.author_name);
    const readAtMs =
      typeof row?.read_at_ms === 'number' && Number.isFinite(row.read_at_ms)
        ? row.read_at_ms
        : 0;
    const commentCount = Number.isFinite(Number(row?.comment_count))
      ? Number(row.comment_count)
      : 0;
    const lastCommentAtMs =
      typeof row?.last_comment_at_ms === 'number' && Number.isFinite(row.last_comment_at_ms)
        ? row.last_comment_at_ms
        : 0;
    const updatedAtMs =
      typeof row?.updated_at_ms === 'number' && Number.isFinite(row.updated_at_ms)
        ? row.updated_at_ms
        : 0;
    const lastActivityAtMs = Math.max(createdAtMs, updatedAtMs, lastCommentAtMs);
    return {
      id: row?.message_id || '',
      title: row?.title || '',
      body: typeof row?.body === 'string' ? row.body : '',
      preview: buildMessagePreview(row?.body || ''),
      priority: priority || '中',
      folderId: row?.folder_id || '',
      folderName: row?.folder_name || '',
      folderColor: row?.folder_color || '',
      isRead: row?.is_read ? true : false,
      isPinned: row?.is_pinned ? true : false,
      createdAt: createdAtMs,
      updatedAt: updatedAtMs,
      commentCount,
      lastCommentAt: lastCommentAtMs,
      lastActivityAt: lastActivityAtMs,
      hasNewComment: commentCount > 0 && (!readAtMs || lastCommentAtMs > readAtMs),
      createdAtLabel: createdAtMs ? formatJst(createdAtMs, true) : '',
      createdBy: row?.author_email || '',
      createdByLabel: authorLabel,
    };
  });
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
      stagedAttachmentId:
        typeof payload.stagedAttachmentId === 'string'
          ? normalizeIdValue(payload.stagedAttachmentId)
          : undefined,
      expectedSettingsVersion:
        typeof payload.expectedSettingsVersion === 'string'
          ? payload.expectedSettingsVersion
          : undefined,
    };
    const nextLanguage = normalizeLanguageInput(payload.language);
    if (nextLanguage) {
      payload.language = nextLanguage;
      sanitizedContext.language = nextLanguage;
    } else if (payload.language !== undefined) {
      delete payload.language;
    }
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
    idempotencyContext,
    binaryUpload,
    pushSession,
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
  const normalizedRoute =
    typeof route === 'string' ? route.trim().replace(/^\/+|\/+$/g, '') : '';
  if (!normalizedRoute) return null;
  const routeSegments = normalizedRoute ? normalizedRoute.split('/') : [];
  const primaryRoute = routeSegments[0] || '';
  const secondaryRoute = routeSegments[1] || '';
  const tertiaryRoute = routeSegments[2] || '';

  const isMutationRequest = isD1MutationRequest(normalizedRoute, requestMethod);
  if (isMutationRequest && !isAllowedMutationMethod(normalizedRoute, requestMethod)) {
    return errorResponse(
      405,
      allowedOrigin || '*',
      requestId,
      'cf-api',
      'method_not_allowed',
      '更新処理は指定されたHTTPメソッドでは実行できません。'
    );
  }
  if (!flags?.d1Write && isMutationRequest) {
    return errorResponse(
      503,
      allowedOrigin || '*',
      requestId,
      'cf-api',
      'd1_write_disabled',
      '現在は安全のため更新処理を一時停止しています。時間をおいて再度お試しください。'
    );
  }

  try {
    if (isMutationRequest && canBindMutationForRole(normalizedRoute, accessContext?.role)) {
      let idempotencyBinding;
      try {
        idempotencyBinding = await bindApiIdempotencyKey(db, {
          orgId: accessContext?.orgId || '',
          actorUserId: accessContext?.userId || '',
          requestId,
          route: normalizedRoute,
          payload: parsedBody ?? {},
        });
      } catch (error) {
        if (error?.code === 'request_structure_too_complex') {
          return errorResponse(
            400,
            allowedOrigin || '*',
            requestId,
            'cf-api',
            'request_structure_too_complex',
            'リクエストの入れ子または項目数が上限を超えています。内容を分けて再実行してください。'
          );
        }
        throw error;
      }
      if (idempotencyContext && typeof idempotencyContext === 'object') {
        Object.assign(idempotencyContext, {
          bound: true,
          inserted: idempotencyBinding.inserted,
          replay: idempotencyBinding.replay,
          conflict: idempotencyBinding.conflict,
          keyId: idempotencyBinding.keyId,
          payloadSha256: idempotencyBinding.payloadSha256,
          createdAtMs: idempotencyBinding.createdAtMs,
          expiresAtMs: idempotencyBinding.expiresAtMs,
        });
      }
      if (idempotencyBinding.conflict) {
        return errorResponse(
          409,
          allowedOrigin || '*',
          requestId,
          'cf-api',
          'idempotency_key_reused',
          '同じリクエスト ID が異なる内容で使用されています。操作を確認してから再実行してください。'
        );
      }
      if (idempotencyBinding.replay && !canReplayMutationRoute(normalizedRoute)) {
        return errorResponse(
          409,
          allowedOrigin || '*',
          requestId,
          'cf-api',
          'idempotency_replay',
          '同じ更新リクエストは既に処理されています。現在の状態を取得してから、新しいリクエスト ID で操作してください。'
        );
      }
    }
    if (STAGED_ATTACHMENT_ROUTES.has(normalizedRoute)) {
      return handleStageAttachmentRoute({
        db,
        env,
        route: normalizedRoute,
        requestId,
        allowedOrigin,
        config,
        tokenDetails,
        accessContext,
        idempotencyContext,
        binaryUpload,
      });
    }
    if (normalizedRoute === 'getBootstrapData') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      let membership = null;
      if (normalizedEmail) {
        try {
          membership = await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId);
        } catch (err) {
          console.warn('[ShiftFlow][D1] Failed to resolve membership for bootstrap', {
            requestId,
            reasonCode: 'bootstrap_membership_lookup_failed',
          });
          throw createServiceUnavailableError(
            'd1_unavailable',
            'D1 bootstrap membership lookup is temporarily unavailable.'
          );
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
                   theme,
                   language
              FROM users
             WHERE lower(email) = ?1
          `
          )
          .bind(normalizedEmail)
          .first();
      }
      const resolvedUserId =
        membership?.user_id || userRow?.user_id || accessContext?.userId || '';
      const resolvedRole =
        membership?.role || accessContext?.role || userRow?.role || 'member';
      const userInfo = {
        email: userRow?.email || rawEmail || '',
        name: userRow?.display_name || accessContext?.displayName || 'ユーザー',
        imageUrl: userRow?.profile_image_url || PROFILE_PLACEHOLDER_URL,
        theme: userRow?.theme || 'light',
        role: resolvedRole,
        language: resolveLanguageValue(userRow?.language),
      };
      const bootstrap = {
        userInfo,
        users: [],
        folders: [],
        pinnedMessages: {},
        myTasks: { tasks: [], meta: {} },
        isManager: isManagerRole(resolvedRole),
        theme: userInfo.theme || 'light',
      };
      const orgId = membership?.org_id || accessContext?.orgId || '';
      if (!orgId) {
        throw createServiceUnavailableError(
          'd1_unavailable',
          'D1 bootstrap organization scope is unavailable.'
        );
      }
      try {
        const usersResult = await db
          .prepare(
            `
          SELECT users.user_id AS user_id,
                 users.email AS email,
                 COALESCE(users.display_name, users.email) AS display_name,
                 COALESCE(memberships.role, 'member') AS role,
                 users.profile_image_url AS profile_image_url
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
                userId: row.user_id || '',
                email: row.email,
                name: row.display_name || row.email || '',
                role: row.role ? String(row.role).trim() || 'member' : 'member',
                imageUrl: row.profile_image_url || PROFILE_PLACEHOLDER_URL,
              }))
            : [];
      } catch (err) {
        console.warn('[ShiftFlow][Bootstrap] Failed to load users', { requestId });
        bootstrap.users = [];
        bootstrap.usersError = 'bootstrap_users_unavailable';
      }
      try {
        bootstrap.folders = await fetchFoldersWithAccess(db, {
          orgId,
          userId: resolvedUserId,
          isManager: bootstrap.isManager,
          includeMembers: bootstrap.isManager,
          ensureDefaultFolder: true,
        });
      } catch (err) {
        console.warn('[ShiftFlow][Bootstrap] Failed to load folders', { requestId });
        bootstrap.folders = [];
        bootstrap.foldersError = 'bootstrap_folders_unavailable';
      }
      try {
        bootstrap.pinnedMessages = await fetchPinnedMessagesFromD1(db, {
          orgId,
          membershipId: membership?.membership_id || '',
          userId: resolvedUserId,
          isManager: bootstrap.isManager,
        });
      } catch (err) {
        console.warn('[ShiftFlow][Bootstrap] Failed to load pinned messages', { requestId });
        bootstrap.pinnedMessages = {};
        bootstrap.pinnedMessagesError = 'bootstrap_pinned_messages_unavailable';
      }
      try {
        bootstrap.myTasks = await buildMyTasksPayload(db, rawEmail, accessContext?.orgId || '');
      } catch (err) {
        console.warn('[ShiftFlow][Bootstrap] Failed to load tasks', { requestId });
        bootstrap.myTasks = {
          tasks: [],
          meta: {
            error: 'bootstrap_tasks_unavailable',
          },
        };
      }
      const partialFailureCodes = [
        bootstrap.usersError,
        bootstrap.foldersError,
        bootstrap.pinnedMessagesError,
        bootstrap.myTasks?.meta?.error,
      ].filter(Boolean);
      if (partialFailureCodes.length) {
        captureDiagnostics(config, 'warn', 'bootstrap_partial_failure', {
          event: 'bootstrap_partial_failure',
          route: normalizedRoute,
          requestId,
          orgId: accessContext?.orgId || '',
          userId: accessContext?.userId || '',
          detail: 'bootstrap_partial_failure',
          httpStatus: 200,
        });
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
      let orgId = accessContext?.orgId || '';
      if (email) {
        const membership = await resolveMembershipForEmail(db, email, accessContext?.orgId);
        orgId = membership?.org_id || orgId;
      }
      if (!orgId) {
        throw createServiceUnavailableError(
          'd1_unavailable',
          'D1 active user organization scope is unavailable.'
        );
      }
      const result = await db
        .prepare(
          `
          SELECT users.user_id AS user_id,
                 users.email AS email,
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
                userId: row.user_id || '',
                email: row.email,
                name: row.display_name || row.email || '',
                role: row.role ? String(row.role).trim() || 'member' : 'member',
              }))
            : [];
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
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const resolvedOrgId = membership?.org_id || accessContext?.orgId || '';
      const folders = await fetchFoldersWithAccess(db, {
        orgId: resolvedOrgId,
        userId: membership?.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        includeMembers: isManagerRole(accessContext?.role),
        ensureDefaultFolder: true,
      });
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
    if (primaryRoute === 'folders' && routeSegments.length === 1 && requestMethod === 'GET') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const resolvedOrgId = membership?.org_id || accessContext?.orgId || '';
      const includeMembersRequested =
        query?.get('includeMembers') === '1' || query?.get('include_members') === '1';
      const isManager = isManagerRole(accessContext?.role);
      const folders = await fetchFoldersWithAccess(db, {
        orgId: resolvedOrgId,
        userId: membership?.user_id || accessContext?.userId || '',
        isManager,
        includeMembers: includeMembersRequested && isManager,
        ensureDefaultFolder: true,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: folders,
        },
        allowedOrigin,
        requestId
      );
    }
    if (primaryRoute === 'folders' && routeSegments.length === 1 && requestMethod === 'POST') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'フォルダを作成する権限がありません。'
        );
      }
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = actorMembership?.org_id || accessContext?.orgId || '';
      if (!orgId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '所属組織を特定できません。'
        );
      }
      const payload = parsedBody && typeof parsedBody === 'object' ? parsedBody : {};
      const folderName = normalizeFolderName(payload.name || payload.folderName);
      if (!folderName) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_name_required',
          'フォルダ名を入力してください。'
        );
      }
      const folderId = await createRequestScopedId({
        kind: 'folder',
        orgId,
        actorUserId: actorMembership?.user_id || accessContext?.userId || '',
        requestId,
        resourceScope: `folders:${idempotencyContext?.payloadSha256 || ''}`,
      });
      const existingFolder = await fetchFolderById(db, orgId, folderId);
      if (existingFolder) {
        const existingMembers = await fetchFolderMemberMap(db, [folderId]);
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            success: true,
            result: {
              id: existingFolder.id,
              orgId: existingFolder.org_id,
              name: existingFolder.name,
              color: existingFolder.color || null,
              isActive: existingFolder.is_active === 1,
              isPublic: existingFolder.is_public === 1,
              isSystem: existingFolder.is_system === 1,
              sortOrder: existingFolder.sort_order || 0,
              memberUserIds: existingMembers.get(folderId) || [],
              createdAt: existingFolder.created_at_ms || 0,
              updatedAt: existingFolder.updated_at_ms || 0,
              idempotentReplay: true,
            },
          },
          allowedOrigin,
          requestId
        );
      }
      const duplicate = await folderNameExists(db, orgId, folderName, null);
      if (duplicate) {
        return errorResponse(
          409,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_name_exists',
          '同名のフォルダが既に存在します。'
        );
      }
      const rawColor = typeof payload.color === 'string' ? payload.color : payload.folderColor;
      const folderColor = normalizeOrgColor(rawColor) || null;
      let isPublicFlag = true;
      if (typeof payload.isPublic === 'boolean') {
        isPublicFlag = payload.isPublic;
      } else if (typeof payload.is_public === 'number' || typeof payload.is_public === 'boolean') {
        isPublicFlag = !!payload.is_public;
      }
      const memberUserIdsInput =
        Array.isArray(payload.memberUserIds) && payload.memberUserIds.length
          ? payload.memberUserIds
          : Array.isArray(payload.member_user_ids)
          ? payload.member_user_ids
          : [];
      const authorizedMembers = isPublicFlag
        ? []
        : await normalizeFolderMemberIds(db, orgId, memberUserIdsInput);
      const now = Date.now();
      const sortRow = await db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM folders WHERE org_id = ?1')
        .bind(orgId)
        .first();
      const sortOrder =
        typeof sortRow?.max_order === 'number' && Number.isFinite(sortRow.max_order)
          ? sortRow.max_order + 10
          : 0;
      const statements = [
        db
          .prepare(
            `
            INSERT OR IGNORE INTO folders (
              id,
              org_id,
              name,
              sort_order,
              color,
              is_active,
              is_public,
              is_system,
              created_at_ms,
              updated_at_ms
            )
            VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, 0, ?7, ?7)
          `
          )
          .bind(folderId, orgId, folderName, sortOrder, folderColor, isPublicFlag ? 1 : 0, now),
      ];
      statements.push(
        buildAuditLogStatement(db, {
          orgId,
          actorMembershipId: actorMembership?.membership_id || null,
          targetType: 'folder',
          targetId: folderId,
          action: 'folder.create',
          createdAtMs: now,
          requestId,
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
          onlyIfPreviousStatementChanged: true,
          payload: {
            name: folderName,
            color: folderColor,
            isPublic: isPublicFlag,
            memberUserIds: authorizedMembers,
          },
        })
      );
      if (!isPublicFlag && authorizedMembers.length) {
        authorizedMembers.forEach((userId) => {
          statements.push(
            db
              .prepare(
                `
                INSERT OR IGNORE INTO folder_members (
                  folder_id,
                  user_id,
                  added_at_ms
                )
                VALUES (?1, ?2, ?3)
              `
              )
              .bind(folderId, userId, now)
          );
        });
      }
      try {
        await db.batch(statements.filter(Boolean));
      } catch (err) {
        console.error('[ShiftFlow][Folders] Failed to insert folder', {
          requestId,
          reasonCode: 'folder_create_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_create_failed',
          'フォルダの作成に失敗しました。'
        );
      }
      return jsonResponseFromD1(
        201,
        {
          ok: true,
          success: true,
          result: {
            id: folderId,
            orgId,
            name: folderName,
            color: folderColor,
            isActive: true,
            isPublic: isPublicFlag,
            isSystem: false,
            sortOrder,
            memberUserIds: authorizedMembers,
            createdAt: now,
            updatedAt: now,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (primaryRoute === 'folders' && routeSegments.length === 2 && requestMethod === 'PATCH') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'フォルダを更新する権限がありません。'
        );
      }
      const targetFolderId = normalizeIdValue(secondaryRoute);
      if (!targetFolderId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_id_required',
          'フォルダ ID を指定してください。'
        );
      }
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = actorMembership?.org_id || accessContext?.orgId || '';
      const folder = await fetchFolderById(db, orgId, targetFolderId);
      if (!folder) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_not_found',
          '対象のフォルダが見つかりません。'
        );
      }
      const payload = parsedBody && typeof parsedBody === 'object' ? parsedBody : {};
      let nextName = folder.name || DEFAULT_SYSTEM_FOLDER_NAME;
      let nextColor = folder.color || null;
      let nextIsPublic = folder.is_public === 1;
      let nextIsActive = folder.is_active === 1;
      const changedFields = [];
      if (Object.prototype.hasOwnProperty.call(payload, 'name')) {
        const normalizedName = normalizeFolderName(payload.name);
        if (!normalizedName) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'folder_name_required',
            'フォルダ名を入力してください。'
          );
        }
        if (normalizedName !== folder.name) {
          const dup = await folderNameExists(db, folder.org_id, normalizedName, folder.id);
          if (dup) {
            return errorResponse(
              409,
              allowedOrigin,
              requestId,
              'cf-api',
              'folder_name_exists',
              '同名のフォルダが既に存在します。'
            );
          }
          nextName = normalizedName;
          changedFields.push('name');
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'color')) {
        const normalizedColor = normalizeOrgColor(payload.color) || null;
        if (normalizedColor !== folder.color) {
          nextColor = normalizedColor;
          changedFields.push('color');
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(payload, 'isPublic') ||
        Object.prototype.hasOwnProperty.call(payload, 'is_public')
      ) {
        const rawPublic =
          Object.prototype.hasOwnProperty.call(payload, 'isPublic') && payload.isPublic !== undefined
            ? payload.isPublic
            : payload.is_public;
        const normalizedPublic = !!rawPublic;
        if (normalizedPublic !== nextIsPublic) {
          nextIsPublic = normalizedPublic;
          changedFields.push('isPublic');
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(payload, 'isActive') ||
        Object.prototype.hasOwnProperty.call(payload, 'is_active')
      ) {
        if (folder.is_system === 1 && !payload.isActive && !payload.is_active) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'system_folder_protected',
            'システムフォルダは無効化できません。'
          );
        }
        const rawActive =
          Object.prototype.hasOwnProperty.call(payload, 'isActive') && payload.isActive !== undefined
            ? payload.isActive
            : payload.is_active;
        const normalizedActive = !!rawActive;
        if (normalizedActive !== nextIsActive) {
          nextIsActive = normalizedActive;
          changedFields.push('isActive');
        }
      }
      const memberListProvided =
        Array.isArray(payload.memberUserIds) || Array.isArray(payload.member_user_ids);
      let updatedMemberIds = null;
      if (memberListProvided) {
        const rawMembers = Array.isArray(payload.memberUserIds)
          ? payload.memberUserIds
          : payload.member_user_ids;
        updatedMemberIds = await normalizeFolderMemberIds(db, folder.org_id, rawMembers);
      }
      if (!changedFields.length && updatedMemberIds === null) {
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            success: true,
            result: {
              id: folder.id,
              name: folder.name,
              color: folder.color,
              isPublic: folder.is_public === 1,
              isActive: folder.is_active === 1,
              isSystem: folder.is_system === 1,
              memberUserIds: [],
              updated: false,
            },
          },
          allowedOrigin,
          requestId
        );
      }
      const now = Date.now();
      const statements = [
        db
          .prepare(
          `
          UPDATE folders
             SET name = ?2,
                 color = ?3,
                 is_public = ?4,
                 is_active = ?5,
                 updated_at_ms = ?6
           WHERE id = ?1
        `
          )
          .bind(
            folder.id,
            nextName,
            nextColor,
            nextIsPublic ? 1 : 0,
            nextIsActive ? 1 : 0,
            now
          ),
      ];
      if (updatedMemberIds !== null) {
        statements.push(
          db.prepare('DELETE FROM folder_members WHERE folder_id = ?1').bind(folder.id)
        );
        if (updatedMemberIds.length) {
          for (const userId of updatedMemberIds) {
            statements.push(
              db
                .prepare(
                `
                INSERT INTO folder_members (
                  folder_id,
                  user_id,
                  added_at_ms
                )
                VALUES (?1, ?2, ?3)
              `
                )
                .bind(folder.id, userId, now)
            );
          }
        }
        changedFields.push('memberUserIds');
      }
      statements.push(
        buildAuditLogStatement(db, {
          orgId: folder.org_id,
          actorMembershipId: actorMembership?.membership_id || null,
          targetType: 'folder',
          targetId: folder.id,
          action: 'folder.update',
          createdAtMs: now,
          requestId,
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
          payload: {
            changes: changedFields,
            name: nextName,
            isPublic: nextIsPublic,
          },
        })
      );
      try {
        await db.batch(statements.filter(Boolean));
      } catch (err) {
        console.error('[ShiftFlow][Folders] Failed to update folder', {
          requestId,
          reasonCode: 'folder_update_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_update_failed',
          'フォルダの更新に失敗しました。'
        );
      }
      const memberMap = await fetchFolderMemberMap(db, [folder.id]);
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            id: folder.id,
            orgId: folder.org_id,
            name: nextName,
            color: nextColor,
            isPublic: nextIsPublic,
            isActive: nextIsActive,
            isSystem: folder.is_system === 1,
            memberUserIds: memberMap.get(folder.id) || [],
            updatedAt: now,
            updated: true,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (primaryRoute === 'folders' && routeSegments.length === 2 && requestMethod === 'DELETE') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'フォルダをアーカイブする権限がありません。'
        );
      }
      const targetFolderId = normalizeIdValue(secondaryRoute);
      if (!targetFolderId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_id_required',
          'フォルダ ID を指定してください。'
        );
      }
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = actorMembership?.org_id || accessContext?.orgId || '';
      const folder = await fetchFolderById(db, orgId, targetFolderId);
      if (!folder) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_not_found',
          '対象のフォルダが見つかりません。'
        );
      }
      if (folder.is_system === 1) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'system_folder_protected',
          'システムフォルダは削除できません。'
        );
      }
      const messageCountRow = await db
        .prepare(
          `
          SELECT COUNT(*) AS cnt
            FROM messages
           WHERE folder_id = ?1
        `
        )
        .bind(folder.id)
        .first();
      const messageCount =
        typeof messageCountRow?.cnt === 'number'
          ? messageCountRow.cnt
          : typeof messageCountRow?.['COUNT(*)'] === 'number'
          ? messageCountRow['COUNT(*)']
          : 0;
      if (messageCount > 0) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_has_messages',
          'メッセージが存在するフォルダはアーカイブできません。'
        );
      }
      const now = Date.now();
      try {
        await db.batch(
          [
            db
              .prepare(
                `
                UPDATE folders
                   SET is_active = 0,
                       archived_at_ms = ?2,
                       archive_year = CAST(STRFTIME('%Y', 'now') AS INTEGER),
                       updated_at_ms = ?2
                 WHERE id = ?1
                   AND is_active = 1
              `
              )
              .bind(folder.id, now),
            buildAuditLogStatement(db, {
              orgId: folder.org_id,
              actorMembershipId: actorMembership?.membership_id || null,
              targetType: 'folder',
              targetId: folder.id,
              action: 'folder.archive',
              createdAtMs: now,
              requestId,
              requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
              requestGenerationMs: idempotencyContext?.createdAtMs || null,
              onlyIfPreviousStatementChanged: true,
              payload: {
                name: folder.name,
              },
            }),
          ].filter(Boolean)
        );
      } catch (err) {
        console.error('[ShiftFlow][Folders] Failed to archive folder', {
          requestId,
          reasonCode: 'folder_archive_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_archive_failed',
          'フォルダのアーカイブに失敗しました。'
        );
      }
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            id: folder.id,
            archived: true,
            archivedAt: now,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (primaryRoute === 'templates' && routeSegments.length === 1 && requestMethod === 'GET') {
      const folderIdParam = query?.get('folderId') || query?.get('folder_id') || '';
      const folderId =
        folderIdParam || (parsedBody && typeof parsedBody === 'object' ? parsedBody.folderId : '');
      if (!folderId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_id_required',
          'フォルダ ID を指定してください。'
        );
      }
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const orgId = membership?.org_id || accessContext?.orgId || '';
      const folder = await ensureFolderAccessForUser(db, {
        orgId,
        folderId,
        userId: membership?.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        requireActive: true,
      });
      if (!folder) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '指定されたフォルダにアクセスできません。'
        );
      }
      const result = await db
        .prepare(
          `
          SELECT id,
                 name,
                 title_format,
                 body_format,
                 created_at_ms,
                 updated_at_ms
            FROM templates
           WHERE org_id = ?1
             AND folder_id = ?2
           ORDER BY updated_at_ms DESC
        `
        )
        .bind(folder.org_id, folder.id)
        .all();
      const rows = Array.isArray(result?.results) ? result.results : [];
      const templates = rows.map((row) => ({
        id: row.id,
        name: row.name || '',
        titleFormat: row.title_format || '',
        bodyFormat: row.body_format || '',
        folderId: folder.id,
        createdAt: row.created_at_ms || 0,
        updatedAt: row.updated_at_ms || 0,
      }));
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: templates,
        },
        allowedOrigin,
        requestId
      );
    }
    if (primaryRoute === 'templates' && routeSegments.length === 1 && requestMethod === 'POST') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'テンプレートを作成する権限がありません。'
        );
      }
      const payload = parsedBody && typeof parsedBody === 'object' ? parsedBody : {};
      const folderId = normalizeIdValue(payload.folderId || payload.folder_id);
      if (!folderId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_id_required',
          'フォルダ ID を指定してください。'
        );
      }
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = actorMembership?.org_id || accessContext?.orgId || '';
      const folder = await fetchFolderById(db, orgId, folderId);
      if (!folder) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_not_found',
          'フォルダが見つかりません。'
        );
      }
      const templateName = normalizeFolderName(payload.name || payload.templateName);
      if (!templateName) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'template_name_required',
          'テンプレート名を入力してください。'
        );
      }
      const templateId = await createRequestScopedId({
        kind: 'template',
        orgId: folder.org_id,
        actorUserId: actorMembership?.user_id || accessContext?.userId || '',
        requestId,
        resourceScope: `${folder.id}:${idempotencyContext?.payloadSha256 || ''}`,
      });
      const now = Date.now();
      await db.batch(
        [
          db
            .prepare(
              `
              INSERT OR IGNORE INTO templates (
                id,
                org_id,
                folder_id,
                name,
                title_format,
                body_format,
                created_at_ms,
                updated_at_ms
              )
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
            `
            )
            .bind(
              templateId,
              folder.org_id,
              folder.id,
              templateName,
              typeof payload.titleFormat === 'string'
                ? payload.titleFormat
                : payload.title_format || '',
              typeof payload.bodyFormat === 'string'
                ? payload.bodyFormat
                : payload.body_format || '',
              now
            ),
          buildAuditLogStatement(db, {
            orgId: folder.org_id,
            actorMembershipId: actorMembership?.membership_id || null,
            targetType: 'template',
            targetId: templateId,
            action: 'template.create',
            createdAtMs: now,
            requestId,
            requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
            requestGenerationMs: idempotencyContext?.createdAtMs || null,
            onlyIfPreviousStatementChanged: true,
            payload: {
              name: templateName,
              folderId: folder.id,
            },
          }),
        ].filter(Boolean)
      );
      return jsonResponseFromD1(
        201,
        {
          ok: true,
          success: true,
          result: {
            id: templateId,
            folderId: folder.id,
            name: templateName,
            titleFormat:
              typeof payload.titleFormat === 'string'
                ? payload.titleFormat
                : payload.title_format || '',
            bodyFormat:
              typeof payload.bodyFormat === 'string' ? payload.bodyFormat : payload.body_format || '',
            createdAt: now,
            updatedAt: now,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'adminListUsers') {
      if (!isManagerRole(accessContext?.role)) {
        const resultPayload = {
          rows: [],
          meta: {
            managerOnly: true,
            reason: '管理者権限が必要です。',
            userRole: accessContext?.role || '',
          },
        };
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: resultPayload },
          allowedOrigin,
          requestId
        );
      }
      const argsObject =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const actorOrgId = actorMembership?.org_id || null;
      if (!actorOrgId) {
        const resultPayload = {
          rows: [],
          meta: {
            managerOnly: true,
            reason: '管理対象の組織が確認できません。',
            userRole: accessContext?.role || '',
          },
        };
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: resultPayload },
          allowedOrigin,
          requestId
        );
      }
      const filters = {
        search: typeof argsObject.search === 'string' ? argsObject.search.trim().toLowerCase() : '',
        status: argsObject.status ? normalizeUserStatusValue(argsObject.status) : '',
        role: argsObject.role ? normalizeRoleValue(argsObject.role) : '',
        page:
          typeof argsObject.page === 'number' && Number.isFinite(argsObject.page) && argsObject.page > 0
            ? Math.floor(argsObject.page)
            : 1,
      };
      filters.pageSize = clampPageSize(argsObject.pageSize || 100, 25, 500);
      const offset = (filters.page - 1) * filters.pageSize;
      let paramIndex = 1;
      const bindValues = [];
      const clauseParts = [];
      const membershipJoin = `JOIN memberships ms ON ms.user_id = u.user_id AND ms.org_id = ?${paramIndex}`;
      bindValues.push(actorOrgId);
      paramIndex += 1;
      const userStatusExpr =
        "LOWER(COALESCE(NULLIF(TRIM(u.status), ''), CASE WHEN u.is_active = 0 THEN 'suspended' ELSE 'active' END))";
      const membershipStatusExpr =
        "LOWER(COALESCE(NULLIF(TRIM(ms.status), ''), 'active'))";
      const effectiveStatusExpr = `CASE WHEN ${userStatusExpr} IN ('suspended','revoked') THEN ${userStatusExpr} WHEN ${membershipStatusExpr} <> '' THEN ${membershipStatusExpr} ELSE ${userStatusExpr} END`;
      if (filters.search) {
        const placeholderEmail = '?' + paramIndex;
        const placeholderName = '?' + (paramIndex + 1);
        paramIndex += 2;
        clauseParts.push(
          `(LOWER(u.email) LIKE ${placeholderEmail} OR LOWER(COALESCE(u.display_name, '')) LIKE ${placeholderName})`
        );
        const pattern = `%${filters.search}%`;
        bindValues.push(pattern, pattern);
      }
      if (filters.status) {
        const placeholder = '?' + paramIndex;
        paramIndex += 1;
        clauseParts.push(`${effectiveStatusExpr} = ${placeholder}`);
        bindValues.push(filters.status);
      }
      if (filters.role) {
        const placeholder = '?' + paramIndex;
        paramIndex += 1;
        clauseParts.push(`LOWER(COALESCE(ms.role, 'member')) = ${placeholder}`);
        bindValues.push(filters.role);
      }
      const whereClause = clauseParts.length ? 'WHERE ' + clauseParts.join(' AND ') : '';
      const baseFromClause = `
        FROM users u
        ${membershipJoin}
        LEFT JOIN organizations org ON org.org_id = ms.org_id
        ${whereClause}
      `;
      const countStatement = `SELECT COUNT(1) AS cnt ${baseFromClause}`;
      const countResult = await db.prepare(countStatement).bind(...bindValues).first();
      const totalRows = countResult && countResult.cnt ? Number(countResult.cnt) : 0;
      const limitPlaceholder = '?' + paramIndex;
      paramIndex += 1;
      const offsetPlaceholder = '?' + paramIndex;
      paramIndex += 1;
      const orderExpr = `CASE
        WHEN ${effectiveStatusExpr} = 'pending' THEN 0
        WHEN ${effectiveStatusExpr} = 'active' THEN 1
        WHEN ${effectiveStatusExpr} = 'suspended' THEN 2
        ELSE 3
      END`;
      const listStatement = `
        SELECT
          u.user_id,
          u.email,
          u.display_name,
          u.profile_image_url,
          u.status AS user_status,
          u.is_active,
          u.last_login_at_ms,
          u.first_login_at_ms,
          u.approved_by,
          u.approved_at_ms,
          u.notes,
          ms.membership_id,
          ms.status AS membership_status,
          ms.role,
          ms.org_id,
          ms.created_at_ms AS membership_created_at_ms,
          org.name AS org_name,
          ${effectiveStatusExpr} AS effective_status
        ${baseFromClause}
        ORDER BY ${orderExpr}, LOWER(COALESCE(u.display_name, u.email)), u.email
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `;
      const dataResult = await db
        .prepare(listStatement)
        .bind(...bindValues, filters.pageSize, offset)
        .all();
      const rows = Array.isArray(dataResult?.results) ? dataResult.results : [];
      const mapped = rows.map((row) => {
        const status = row.effective_status || 'pending';
        return {
          userId: row.user_id,
          membershipId: row.membership_id || '',
          email: row.email || '',
          name: row.display_name || row.email || '',
          role: normalizeRoleValue(row.role || 'member') || 'member',
          orgId: row.org_id || actorOrgId,
          orgName: row.org_name || '現在の組織',
          status,
          avatarUrl: row.profile_image_url || PROFILE_PLACEHOLDER_URL,
          lastLoginAt: row.last_login_at_ms || null,
          lastLoginLabel: row.last_login_at_ms ? formatJst(row.last_login_at_ms, true) : '—',
          approvedBy: row.approved_by || '',
          approvedAtLabel:
            row.approved_at_ms && Number.isFinite(row.approved_at_ms)
              ? formatJst(row.approved_at_ms, true)
              : '',
          isActive: row.is_active == null ? true : row.is_active !== 0,
          membershipStatus: row.membership_status || '',
          userStatus: row.user_status || '',
          notes: row.notes || '',
          createdAtLabel:
            row.membership_created_at_ms && Number.isFinite(row.membership_created_at_ms)
              ? formatJst(row.membership_created_at_ms, true)
              : '',
        };
      });
      const statusCounts = mapped.reduce(
        (acc, row) => {
          const key = row.status || 'pending';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        },
        {}
      );
      const refreshedAtMs = Date.now();
      const resultPayload = {
        rows: mapped,
        meta: {
          totalRows,
          returnedRows: mapped.length,
          filters,
          stats: {
            total: totalRows,
            pending: statusCounts.pending || 0,
            active: statusCounts.active || 0,
            suspended: statusCounts.suspended || 0,
            revoked: statusCounts.revoked || 0,
          },
          pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            hasMore: offset + mapped.length < totalRows,
          },
          refreshedAt: formatJst(refreshedAtMs, true),
          orgId: actorOrgId,
        },
      };
      captureDiagnostics(config, 'info', 'd1_admin_users', {
        event: 'd1_admin_users',
        requestId,
        orgId: actorOrgId,
        totalRows,
        returnedRows: mapped.length,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: resultPayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'adminListOrganizations') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '管理者権限が必要です。'
        );
      }
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership || !actorMembership.user_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '所属組織が見つかりません。'
        );
      }
      let orgRows = [];
      try {
        const query = await db
          .prepare(
            `
            SELECT org.org_id,
                   org.name,
                   org.short_name,
                   org.display_color,
                   org.timezone,
                   org.notification_email,
                   org.created_at_ms,
                   org.updated_at_ms,
                   ms.role AS membership_role,
                   ms.status AS membership_status
              FROM memberships ms
              JOIN organizations org ON org.org_id = ms.org_id
             WHERE ms.user_id = ?1
               AND LOWER(COALESCE(ms.status, 'active')) = 'active'
               AND LOWER(COALESCE(ms.role, 'member')) IN ('manager', 'admin')
             ORDER BY org.created_at_ms ASC
          `
          )
          .bind(actorMembership.user_id)
          .all();
        orgRows = Array.isArray(query?.results) ? query.results : [];
      } catch (err) {
        console.warn('[ShiftFlow][Admin][Org] Failed to list organizations', {
          requestId,
          reasonCode: 'organization_list_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_list_failed',
          '組織一覧の取得に失敗しました。'
        );
      }
      const mapped = orgRows.map((row) => ({
        orgId: row.org_id,
        name: row.name || '未設定の組織',
        shortName: row.short_name || '',
        displayColor: normalizeOrgColor(row.display_color) || DEFAULT_ORG_COLOR,
        timezone: row.timezone || DEFAULT_ORG_TIMEZONE,
        notificationEmail: row.notification_email || '',
        createdAt: row.created_at_ms || null,
        updatedAt: row.updated_at_ms || null,
        role: normalizeRoleValue(row.membership_role || 'member'),
      }));
      const candidateOrgIds = new Set(mapped.map((entry) => entry.orgId));
      let defaultOrgId = '';
      if (candidateOrgIds.has(accessContext?.orgId || '')) {
        defaultOrgId = accessContext.orgId || '';
      } else if (candidateOrgIds.has(actorMembership.org_id || '')) {
        defaultOrgId = actorMembership.org_id || '';
      } else if (mapped.length > 0) {
        defaultOrgId = mapped[0].orgId;
      }
      const payload = {
        orgs: mapped,
        meta: {
          total: mapped.length,
          defaultOrgId,
        },
      };
      captureDiagnostics(config, 'info', 'd1_admin_org_list', {
        event: 'd1_admin_org_list',
        requestId,
        total: mapped.length,
        user: actorEmail,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'adminGetOrganization') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '管理者権限が必要です。'
        );
      }
      const argsObject =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const requestedOrgId =
        typeof argsObject.orgId === 'string' ? argsObject.orgId.trim() : '';
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership || !actorMembership.user_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '所属組織が見つかりません。'
        );
      }
      const orgId = requestedOrgId || accessContext?.orgId || actorMembership.org_id || '';
      if (!orgId) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '参照可能な組織が見つかりません。'
        );
      }
      const membership = await fetchMembershipForOrg(db, actorMembership.user_id, orgId);
      const membershipStatus = (membership?.status || '').trim().toLowerCase();
      if (!membership || (membershipStatus && membershipStatus !== 'active')) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_access_denied',
          '指定の組織にアクセスできません。'
        );
      }
      const actorRole = normalizeRoleValue(membership.role || accessContext?.role || '');
      if (!isManagerRole(actorRole)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_access_denied',
          '指定の組織にアクセスできません。'
        );
      }
      const orgRow = await db
        .prepare(
          `
          SELECT org_id,
                 name,
                 short_name,
                 display_color,
                 timezone,
                 notification_email,
                 created_at_ms,
                 updated_at_ms
            FROM organizations
           WHERE org_id = ?1
           LIMIT 1
        `
        )
        .bind(orgId)
        .first();
      if (!orgRow) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '組織情報が見つかりません。'
        );
      }
      const stats = await fetchOrgMemberStats(db, orgId);
      const refreshedAtMs = Date.now();
      const payload = {
        org: {
          orgId,
          name: orgRow.name || '未設定の組織',
          shortName: orgRow.short_name || '',
          displayColor: normalizeOrgColor(orgRow.display_color) || DEFAULT_ORG_COLOR,
          timezone: orgRow.timezone || DEFAULT_ORG_TIMEZONE,
          notificationEmail: orgRow.notification_email || '',
          createdAt: formatJst(orgRow.created_at_ms, true),
          updatedAt: formatJst(orgRow.updated_at_ms || orgRow.created_at_ms, true),
        },
        stats,
        refreshedAt: formatJst(refreshedAtMs, true),
        orgId,
      };
      captureDiagnostics(config, 'info', 'd1_admin_org_detail', {
        event: 'd1_admin_org_detail',
        requestId,
        orgId,
        user: actorEmail,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getAppBadge') {
      if (requestMethod !== 'GET') return errorResponse(405, allowedOrigin, requestId, 'cf-api', 'method_not_allowed', 'この操作は GET にのみ対応しています。');
      try {
        const email = tokenDetails?.email || accessContext?.email || '';
        const membership = await resolveMembershipForEmail(db, email, accessContext.orgId);
        const counts = await computeAppBadge(db, { orgId: accessContext.orgId, userId: accessContext.userId,
          membershipId: membership?.membership_id, email, isManager: isManagerRole(accessContext.role) });
        return jsonResponseFromD1(200, { ok: true, result: { ...counts,
          owner: await sha256(accessContext.orgId + ':' + accessContext.userId), sessionExpiresAt: pushSession.expiresAt } }, allowedOrigin, requestId);
      } catch (error) {
        const code = error?.code === 'app_badge_access_denied' ? error.code : 'app_badge_unavailable';
        return errorResponse(code === 'app_badge_access_denied' ? 403 : 503, allowedOrigin, requestId, 'cf-api', code, '件数を確認できませんでした。時間をおいて再試行してください。');
      }
    }
    if (['getNotificationSettings','saveNotificationSettings','registerPushSubscription','removePushSubscription','testPushNotification'].includes(normalizedRoute)) {
      try {
        const folders = normalizedRoute === 'getNotificationSettings' && isPushConfigured(env)
          ? await fetchFoldersWithAccess(db, { orgId: accessContext.orgId, userId: accessContext.userId, isManager: isManagerRole(accessContext.role) }) : [];
        const result = await handleNotificationApi({ db, env, access: accessContext, route: normalizedRoute,
          method: requestMethod, body: parsedBody, query, session: pushSession, folders,
          ensureFolderAccess: folderId => ensureFolderAccessForUser(db, { orgId: accessContext.orgId, userId: accessContext.userId,
            isManager: isManagerRole(accessContext.role), folderId, requireActive: true }) });
        return jsonResponseFromD1(200, { ok: true, result }, allowedOrigin, requestId);
      } catch (error) {
        const code = /^[a-z_]+$/.test(error?.code || '') ? error.code : 'notification_service_unavailable';
        const retryAfterSeconds = code === 'push_test_rate_limited' && Number.isInteger(error.retryAfterSeconds)
          ? Math.max(1, Math.min(60, error.retryAfterSeconds)) : 0;
        return errorResponse(error.httpStatus || 503, allowedOrigin, requestId, 'cf-api', code,
          '通知設定を更新できませんでした。状態を確認して再試行してください。',
          retryAfterSeconds ? { retryAfterSeconds } : undefined,
          retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : undefined);
      }
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
                 theme,
                 language,
                 settings_version
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
              language: DEFAULT_LANGUAGE,
              settingsVersion: '0',
            },
          },
          allowedOrigin,
          requestId
        );
      }
      // 画面表示用roleも、認可に使ったactive membership snapshotを正本にする。
      // user_idだけの最古membership参照は、別tenant/停止済みroleを漏らすため禁止する。
      const role = accessContext?.role || 'member';
      const result = {
        name: user.display_name || 'ユーザー',
        imageUrl: user.profile_image_url || PROFILE_PLACEHOLDER_URL,
        imageName: '',
        role,
        email: tokenDetails?.email || user.email || '',
        theme: user.theme || 'light',
        language: resolveLanguageValue(user.language),
        settingsVersion: user.settings_version || '0',
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
      if (hasImageData) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'staged_attachment_required',
          'プロフィール画像は先に一時アップロードしてから保存してください。'
        );
      }
      const stagedProfileAttachmentId = normalizeIdValue(payload.stagedAttachmentId);
      const membership = await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId);
      if (!membership?.membership_id || !membership?.org_id || !membership?.user_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'profile_scope_unavailable',
          'プロフィールの所属情報を確認できません。'
        );
      }
      const profileOrgId = membership.org_id;
      const userRow = await db
        .prepare(
          `
          SELECT user_id,
                 display_name,
                 profile_image_url,
                 theme,
                 language,
                 settings_version,
                 updated_at_ms
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
      if (userRow.user_id !== membership.user_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'profile_scope_mismatch',
          'プロフィールの所有者を確認できません。'
        );
      }
      const currentSettingsVersion = normalizeSettingsVersion(userRow.settings_version) || '0';
      const hasExpectedSettingsVersion = payload.expectedSettingsVersion !== undefined;
      const expectedSettingsVersion = hasExpectedSettingsVersion
        ? normalizeSettingsVersion(payload.expectedSettingsVersion)
        : currentSettingsVersion;
      if (!expectedSettingsVersion) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'settings_version_invalid',
          '設定の更新情報が正しくありません。設定画面を開き直してください。'
        );
      }
      const nextSettingsVersion = await createRequestScopedId({
        kind: 'user-settings-version',
        orgId: profileOrgId,
        actorUserId: userRow.user_id,
        requestId,
        resourceScope: `${expectedSettingsVersion}:${idempotencyContext?.payloadSha256 || ''}`,
      });
      // 同時再送ではidempotency INSERTの勝者とsettings batchの勝者が逆になることがある。
      // replay flagではなく、同一scope/hash/generationの監査正本で確定済み操作を判定する。
      const priorSettingsAudit = await db
            .prepare(
              `
              SELECT audit_id
                FROM audit_logs
               WHERE org_id = ?1
                 AND actor_membership_id = ?2
                 AND target_type = 'user'
                 AND target_id = ?3
                 AND action = 'user_settings.update'
                 AND request_id = ?4
                 AND request_payload_sha256 = ?5
                 AND request_generation_ms = ?6
               LIMIT 1
            `
            )
            .bind(
              profileOrgId,
              membership.membership_id,
              userRow.user_id,
              requestId,
              idempotencyContext?.payloadSha256 || '',
              idempotencyContext?.createdAtMs || 0
            )
            .first();
      const currentSettingsPayload = {
        name: userRow.display_name || 'ユーザー',
        imageUrl: userRow.profile_image_url || PROFILE_PLACEHOLDER_URL,
        imageName: '',
        theme: userRow.theme || 'light',
        language: resolveLanguageValue(userRow.language),
        settingsVersion: currentSettingsVersion,
      };
      if (priorSettingsAudit?.audit_id) {
        let priorAttachmentInvariantSatisfied = true;
        if (stagedProfileAttachmentId) {
          const priorClaimedStage = await db
            .prepare(
              `
              SELECT staged.staged_attachment_id,
                     staged.claimed_target_id
                FROM staged_attachments staged
                JOIN attachments attachment
                  ON attachment.attachment_id = staged.staged_attachment_id
                 AND attachment.org_id = staged.org_id
                 AND attachment.created_by_membership_id = staged.owner_membership_id
               WHERE staged.staged_attachment_id = ?1
                 AND staged.org_id = ?2
                 AND staged.owner_user_id = ?3
                 AND staged.owner_membership_id = ?4
                 AND staged.purpose = 'profile'
                 AND staged.status = 'claimed'
                 AND staged.claimed_target_type = 'user_settings'
               LIMIT 1
            `
            )
            .bind(
              stagedProfileAttachmentId,
              profileOrgId,
              userRow.user_id,
              membership.membership_id
            )
            .first();
          const expectedClaimTarget = hasExpectedSettingsVersion
            ? nextSettingsVersion
            : currentSettingsVersion;
          priorAttachmentInvariantSatisfied = Boolean(
            priorClaimedStage?.staged_attachment_id &&
              priorClaimedStage.claimed_target_id === expectedClaimTarget &&
              userRow.profile_image_url === buildAttachmentDownloadPath(stagedProfileAttachmentId)
          );
        }
        if (
          priorAttachmentInvariantSatisfied &&
          (!hasExpectedSettingsVersion || currentSettingsVersion === nextSettingsVersion)
        ) {
          return jsonResponseFromD1(
            200,
            {
              ok: true,
              success: true,
              result: {
                success: true,
                message: '設定は既に保存されています。',
                ...currentSettingsPayload,
                idempotentReplay: true,
              },
            },
            allowedOrigin,
            requestId
          );
        }
        // 監査INSERTが先に見えてもuser UPDATEはまだ未確定の並行実行がある。
        // 現在versionが依頼のexpectedと同じなら、DBの更新条件まで進めて勝者へ収束させる。
        if (currentSettingsVersion !== expectedSettingsVersion) {
          return errorResponse(
            409,
            allowedOrigin,
            requestId,
            'cf-api',
            'settings_version_conflict',
            'この保存より後に設定が更新されています。入力内容を確認してもう一度保存してください。',
            { current: currentSettingsPayload }
          );
        }
      }
      if (expectedSettingsVersion !== currentSettingsVersion) {
        return errorResponse(
          409,
          allowedOrigin,
          requestId,
          'cf-api',
          'settings_version_conflict',
          '別の画面または端末で設定が更新されました。入力内容を確認してもう一度保存してください。',
          { current: currentSettingsPayload }
        );
      }
      const previousAttachmentId = extractAttachmentIdFromUrl(userRow.profile_image_url || '');
      const previousAttachment = previousAttachmentId
        ? await resolveOwnedProfileAttachment(db, {
            attachmentId: previousAttachmentId,
            orgId: profileOrgId,
            ownerUserId: userRow.user_id,
          })
        : null;
      let newAttachmentId = '';
      let newAttachmentUploaded = false;
      let newAttachmentFromStage = false;
      let newAttachment = null;
      let uploadedR2Key = '';
      let attachmentFileName = '';
      if (!stagedProfileAttachmentId && typeof payload.imageUrl === 'string' && payload.imageUrl.trim()) {
        const requestedAttachmentId = extractCanonicalProfileAttachmentId(payload.imageUrl);
        const requestedAttachment = requestedAttachmentId
          ? await resolveOwnedProfileAttachment(db, {
              attachmentId: requestedAttachmentId,
              orgId: profileOrgId,
              ownerUserId: userRow.user_id,
            })
          : null;
        if (!requestedAttachment) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'invalid_profile_image',
            'プロフィール画像は本人所有の保存済み画像だけを指定できます。'
          );
        }
        newAttachmentId = requestedAttachment.attachment_id;
        payload.imageUrl = buildAttachmentDownloadPath(newAttachmentId);
        attachmentFileName = requestedAttachment.file_name || '';
      }
      if (stagedProfileAttachmentId) {
        const stagedRows = await resolveStagedAttachmentsForClaim(db, {
          stagedAttachmentIds: [stagedProfileAttachmentId],
          orgId: profileOrgId,
          ownerUserId: userRow.user_id,
          ownerMembershipId: membership.membership_id,
          purpose: 'profile',
          targetType: 'user_settings',
          targetId: nextSettingsVersion,
        });
        const staged = stagedRows?.[0] || null;
        if (!staged) {
          return errorResponse(
            409,
            allowedOrigin,
            requestId,
            'cf-api',
            'staged_attachment_unavailable',
            'プロフィール画像が期限切れ、使用済み、または現在のユーザーに属していません。もう一度選択してください。'
          );
        }
        uploadedR2Key = staged.r2_key;
        const storagePath = buildAttachmentDownloadPath(staged.staged_attachment_id);
        newAttachment = {
          attachmentId: staged.staged_attachment_id,
          orgId: profileOrgId,
          fileName: staged.file_name,
          mimeType: staged.content_type,
          sizeBytes: Number(staged.size_bytes),
          storagePath,
          checksum: staged.checksum,
          createdAtMs: timestampMs,
          createdByMembershipId: membership.membership_id,
          extra: {
            r2Key: staged.r2_key,
            category: 'profile_image',
            uploadedAtMs: Number(staged.created_at_ms || timestampMs),
            ownerUserId: userRow.user_id,
          },
          stagedClaim: {
            stagedAttachmentId: staged.staged_attachment_id,
            targetType: 'user_settings',
            targetId: nextSettingsVersion,
          },
        };
        payload.imageUrl = storagePath;
        attachmentFileName = staged.file_name;
        payload.imageName = staged.file_name;
        newAttachmentId = staged.staged_attachment_id;
        newAttachmentFromStage = true;
      }
      delete payload.imageData;
      delete payload.stagedAttachmentId;
      const changedFields = [];
      if (payload.name !== undefined) changedFields.push('name');
      if (payload.theme !== undefined) changedFields.push('theme');
      if (payload.language !== undefined) changedFields.push('language');
      if (payload.imageUrl !== undefined) changedFields.push('profileImage');
      let settingsWrite = null;
      try {
        settingsWrite = await updateUserSettingsInD1(db, {
          email: actorEmail,
          user: userRow,
          orgId: profileOrgId,
          ownerMembershipId: membership.membership_id,
          name: payload.name,
          theme: payload.theme,
          language: payload.language,
          imageUrl: payload.imageUrl,
          timestampMs,
          requestId,
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
          expectedSettingsVersion,
          nextSettingsVersion,
          changedFields,
          newAttachment,
          stagedAttachment:
            newAttachmentFromStage && newAttachment
              ? {
                  stagedAttachmentId: newAttachment.attachmentId,
                  claimedAtMs: timestampMs,
                }
              : null,
          previousAttachment,
          nextAttachmentId: newAttachmentId,
        });
      } catch (err) {
        if (newAttachmentUploaded && uploadedR2Key) {
          await queueR2CleanupCandidates(db, [uploadedR2Key], {
            orgId: profileOrgId,
            targetType: 'user',
            targetId: userRow.user_id,
            reason: 'profile_update_commit_unknown',
            requestId,
            config,
          });
        }
        let commitRecovered = false;
        let recoveredOwnKeyAdopted = false;
        try {
          const primaryDb = resolvePrimaryD1(db);
          const recoveredUser = await loadUserSettingsState(primaryDb, userRow.user_id);
          const recoveredAudit = await primaryDb
            .prepare(
              `
              SELECT audit_id
                FROM audit_logs
               WHERE org_id = ?1
                 AND actor_membership_id = ?2
                 AND target_type = 'user'
                 AND target_id = ?3
                 AND action = 'user_settings.update'
                 AND request_id = ?4
                 AND request_payload_sha256 = ?5
                 AND request_generation_ms = ?6
               LIMIT 1
            `
            )
            .bind(
              profileOrgId,
              membership.membership_id,
              userRow.user_id,
              requestId,
              idempotencyContext?.payloadSha256 || '',
              idempotencyContext?.createdAtMs || 0
            )
            .first();
          const recoveredVersion = normalizeSettingsVersion(recoveredUser?.settings_version);
          let attachmentInvariantSatisfied = true;
          if (newAttachment) {
            const recoveredAttachment = await resolveOwnedProfileAttachment(primaryDb, {
              attachmentId: newAttachmentId,
              orgId: profileOrgId,
              ownerUserId: userRow.user_id,
            });
            attachmentInvariantSatisfied = Boolean(
              recoveredAttachment?.attachment_id &&
                recoveredUser?.profile_image_url === buildAttachmentDownloadPath(newAttachmentId)
            );
            recoveredOwnKeyAdopted = recoveredAttachment?.r2Key === uploadedR2Key;
          }
          commitRecovered = Boolean(
            recoveredAudit?.audit_id &&
              recoveredVersion === nextSettingsVersion &&
              attachmentInvariantSatisfied
          );
          if (commitRecovered && recoveredOwnKeyAdopted) {
            await clearStorageCleanupJobs(primaryDb, [uploadedR2Key]);
          }
        } catch (_reconcileError) {
          commitRecovered = false;
        }
        if (commitRecovered) {
          const previousKey =
            payload.imageUrl !== undefined &&
            previousAttachmentId &&
            previousAttachmentId !== newAttachmentId &&
            typeof previousAttachment?.r2Key === 'string'
              ? previousAttachment.r2Key.trim()
              : '';
          settingsWrite = {
            cleanupKeys: previousKey ? [previousKey] : [],
            userId: userRow.user_id,
            orgId: profileOrgId,
            conflict: false,
            settingsVersion: nextSettingsVersion,
            recovered: true,
          };
          captureDiagnostics(config, 'warn', 'profile_update_commit_recovered', {
            event: 'profile_update_commit_recovered',
            route: normalizedRoute,
            requestId,
            orgId: profileOrgId,
            userId: userRow.user_id,
            detail: 'profile_update_commit_recovered',
          });
        } else {
          console.error('[ShiftFlow][Profile] Failed to save settings', {
            requestId,
            reasonCode: 'profile_settings_save_failed',
          });
          return errorResponse(
            500,
            allowedOrigin,
            requestId,
            'cf-api',
            'save_failed',
            '設定の保存結果を確認できませんでした。再読み込み後に状態を確認してください。'
          );
        }
      }
      if (settingsWrite?.conflict) {
        if (newAttachmentUploaded && uploadedR2Key) {
          await cleanupR2KeysWithOutbox(db, env, [uploadedR2Key], {
            orgId: profileOrgId,
            targetType: 'user',
            targetId: userRow.user_id,
            reason: 'profile_update_conflict',
            requestId,
            config,
          });
        }
        const primaryDb = resolvePrimaryD1(db);
        const currentUser = await loadUserSettingsState(primaryDb, userRow.user_id);
        const currentVersion = normalizeSettingsVersion(currentUser?.settings_version) || '0';
        const current = {
          name: currentUser?.display_name || 'ユーザー',
          imageUrl: currentUser?.profile_image_url || PROFILE_PLACEHOLDER_URL,
          imageName: '',
          theme: currentUser?.theme || 'light',
          language: resolveLanguageValue(currentUser?.language),
          settingsVersion: currentVersion,
        };
        let ownMutationCommitted = false;
        if (currentVersion === nextSettingsVersion) {
          try {
            const ownAudit = await primaryDb
              .prepare(
                `
                SELECT audit_id
                  FROM audit_logs
                 WHERE org_id = ?1
                   AND actor_membership_id = ?2
                   AND target_type = 'user'
                   AND target_id = ?3
                   AND action = 'user_settings.update'
                   AND request_id = ?4
                   AND request_payload_sha256 = ?5
                   AND request_generation_ms = ?6
                 LIMIT 1
              `
              )
              .bind(
                profileOrgId,
                membership.membership_id,
                userRow.user_id,
                requestId,
                idempotencyContext?.payloadSha256 || '',
                idempotencyContext?.createdAtMs || 0
              )
              .first();
            let attachmentInvariantSatisfied = true;
            if (newAttachmentFromStage && newAttachmentId) {
              const [ownedAttachment, claimedStage] = await Promise.all([
                resolveOwnedProfileAttachment(primaryDb, {
                  attachmentId: newAttachmentId,
                  orgId: profileOrgId,
                  ownerUserId: userRow.user_id,
                }),
                primaryDb
                  .prepare(
                    `
                    SELECT staged_attachment_id
                      FROM staged_attachments
                     WHERE staged_attachment_id = ?1
                       AND org_id = ?2
                       AND owner_user_id = ?3
                       AND owner_membership_id = ?4
                       AND purpose = 'profile'
                       AND status = 'claimed'
                       AND claimed_target_type = 'user_settings'
                       AND claimed_target_id = ?5
                     LIMIT 1
                  `
                  )
                  .bind(
                    newAttachmentId,
                    profileOrgId,
                    userRow.user_id,
                    membership.membership_id,
                    nextSettingsVersion
                  )
                  .first(),
              ]);
              attachmentInvariantSatisfied = Boolean(
                ownedAttachment?.attachment_id &&
                  ownedAttachment.r2Key === uploadedR2Key &&
                  claimedStage?.staged_attachment_id &&
                  currentUser?.profile_image_url === buildAttachmentDownloadPath(newAttachmentId)
              );
            }
            ownMutationCommitted = Boolean(ownAudit?.audit_id && attachmentInvariantSatisfied);
            if (ownMutationCommitted && uploadedR2Key) {
              await clearStorageCleanupJobs(primaryDb, [uploadedR2Key]);
            }
          } catch (_reconcileError) {
            ownMutationCommitted = false;
          }
        }
        if (ownMutationCommitted) {
          return jsonResponseFromD1(
            200,
            {
              ok: true,
              success: true,
              result: {
                success: true,
                message: '設定は既に保存されています。',
                ...current,
                idempotentReplay: true,
                recovered: true,
              },
            },
            allowedOrigin,
            requestId
          );
        }
        return errorResponse(
          409,
          allowedOrigin,
          requestId,
          'cf-api',
          'settings_version_conflict',
          '別の画面または端末で設定が更新されました。入力内容は保持したまま、もう一度保存してください。',
          { current }
        );
      }
      if (newAttachmentUploaded && newAttachmentId && uploadedR2Key) {
        try {
          const unselectedUploadKeys = await findUnselectedR2UploadKeys(
            db,
            [
              {
                attachmentId: newAttachmentId,
                r2Key: uploadedR2Key,
              },
            ],
            profileOrgId
          );
          if (unselectedUploadKeys.length) {
            await cleanupR2KeysWithOutbox(db, env, unselectedUploadKeys, {
              orgId: profileOrgId,
              targetType: 'user',
              targetId: userRow.user_id,
              reason: 'profile_upload_superseded',
              requestId,
              config,
            });
          }
        } catch (_error) {
          // DB確定後の照合に失敗した場合は、live objectを誤削除しないことを優先する。
          captureDiagnostics(config, 'error', 'profile_upload_reconcile_failed', {
            event: 'profile_upload_reconcile_failed',
            route: normalizedRoute,
            requestId,
            orgId: profileOrgId,
            userId: userRow.user_id,
            detail: 'profile_upload_reconcile_failed',
          });
        }
      }
      if (Array.isArray(settingsWrite?.cleanupKeys) && settingsWrite.cleanupKeys.length) {
        await cleanupR2KeysWithOutbox(db, env, settingsWrite.cleanupKeys, {
          orgId: profileOrgId,
          targetType: 'user',
          targetId: userRow.user_id,
          reason: 'profile_image_replaced',
          requestId,
          config,
        });
      }
      const updatedUser = await db
        .prepare(
          `
          SELECT display_name,
                 profile_image_url,
                 theme,
                 language,
                 settings_version
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
        imageName:
          newAttachmentUploaded || newAttachmentFromStage
            ? attachmentFileName
            : payload.imageName || '',
        theme: updatedUser?.theme || payload.theme || 'light',
        language: resolveLanguageValue(updatedUser?.language || payload.language),
        settingsVersion:
          normalizeSettingsVersion(updatedUser?.settings_version) || nextSettingsVersion,
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
    if (normalizedRoute === 'adminUpdateOrganization') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '管理者権限が必要です。'
        );
      }
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
      const payload =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args[0] || {}
          : {};
      const nextName = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!nextName) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_name_required',
          '組織名を入力してください。'
        );
      }
      const shortName =
        typeof payload.shortName === 'string' ? payload.shortName.trim().slice(0, 32) : '';
      const rawColor =
        typeof payload.displayColor === 'string' && payload.displayColor
          ? payload.displayColor
          : DEFAULT_ORG_COLOR;
      const normalizedColor = normalizeOrgColor(rawColor) || DEFAULT_ORG_COLOR;
      const timezoneValue =
        typeof payload.timezone === 'string' ? payload.timezone.trim() : DEFAULT_ORG_TIMEZONE;
      const resolvedTimezone = coerceOrgTimezone(timezoneValue);
      const rawNotifyEmail =
        typeof payload.notificationEmail === 'string' ? payload.notificationEmail.trim() : '';
      const normalizedNotifyEmail = rawNotifyEmail ? validateEmailFormat(rawNotifyEmail) : '';
      if (rawNotifyEmail && !normalizedNotifyEmail) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'invalid_email',
          '通知メールアドレスの形式が正しくありません。'
        );
      }
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership || !actorMembership.user_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '所属組織が見つかりません。'
        );
      }
      const orgId =
        typeof payload.orgId === 'string'
          ? payload.orgId.trim()
          : accessContext?.orgId || actorMembership.org_id || '';
      if (!orgId) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '更新対象の組織が見つかりません。'
        );
      }
      const membership = await fetchMembershipForOrg(db, actorMembership.user_id, orgId);
      const membershipStatus = (membership?.status || '').trim().toLowerCase();
      if (!membership || (membershipStatus && membershipStatus !== 'active')) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_access_denied',
          '指定の組織にアクセスできません。'
        );
      }
      const actorRole = normalizeRoleValue(membership.role || accessContext?.role || '');
      if (!isManagerRole(actorRole)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_access_denied',
          '指定の組織にアクセスできません。'
        );
      }
      const now = Date.now();
      try {
        await db.batch(
          [
            db
              .prepare(
                `
                UPDATE organizations
                   SET name = ?1,
                       short_name = ?2,
                       display_color = ?3,
                       timezone = ?4,
                       notification_email = ?5,
                       updated_at_ms = ?6
                 WHERE org_id = ?7
              `
              )
              .bind(
                nextName,
                shortName || null,
                normalizedColor,
                resolvedTimezone,
                normalizedNotifyEmail || null,
                now,
                orgId
              ),
            buildAuditLogStatement(db, {
              orgId,
              actorMembershipId: membership.membership_id,
              targetType: 'organization',
              targetId: orgId,
              action: 'admin_org_update',
              payload: {
                name: nextName,
                shortName,
                displayColor: normalizedColor,
                timezone: resolvedTimezone,
                notificationEmail: normalizedNotifyEmail,
              },
              createdAtMs: now,
              requestId,
              requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
              requestGenerationMs: idempotencyContext?.createdAtMs || null,
            }),
          ].filter(Boolean)
        );
      } catch (err) {
        console.error('[ShiftFlow][Admin][Org] Failed to update organization', {
          requestId,
          orgId,
          reasonCode: 'organization_update_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_update_failed',
          '組織情報の更新に失敗しました。'
        );
      }
      captureDiagnostics(config, 'info', 'd1_admin_org_update', {
        event: 'd1_admin_org_update',
        requestId,
        orgId,
        user: actorEmail,
      });
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            success: true,
            message: '組織情報を更新しました。',
            orgId,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'adminUpdateUser') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '管理者権限が必要です。'
        );
      }
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
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership || !actorMembership.org_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_required',
          '管理対象の組織が確認できません。'
        );
      }
      const argsArray =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args
          : [];
      const updatePayload = argsArray.length ? argsArray[0] || {} : {};
      const targetEmail = normalizeEmailValue(updatePayload.email || '');
      const targetUserId = normalizeIdValue(updatePayload.userId || '');
      if (!targetEmail && !targetUserId) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'user_required',
          '更新対象のユーザーを指定してください。'
        );
      }
      const action =
        typeof updatePayload.action === 'string'
          ? updatePayload.action.trim().toLowerCase()
          : '';
      const mapActionToStatus = (value) => {
        switch (value) {
          case 'approve':
          case 'activate':
          case 'resume':
            return 'active';
          case 'suspend':
            return 'suspended';
          case 'pending':
            return 'pending';
          case 'revoke':
            return 'revoked';
          default:
            return '';
        }
      };
      let requestedStatus = '';
      if (typeof updatePayload.status === 'string' && updatePayload.status.trim()) {
        requestedStatus = normalizeUserStatusValue(updatePayload.status);
      } else {
        requestedStatus = mapActionToStatus(action);
      }
      let requestedRole = '';
      if (typeof updatePayload.role === 'string' && updatePayload.role.trim()) {
        requestedRole = normalizeRoleValue(updatePayload.role);
      }
      if (!requestedStatus && !requestedRole) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'payload_missing',
          'ステータスまたはロールを指定してください。'
        );
      }
      const targetLookup = await db
        .prepare(
          `
          SELECT u.user_id,
                 u.email,
                 u.display_name,
                 u.status AS user_status,
                 u.is_active,
                 u.approved_by,
                 u.approved_at_ms,
                 ms.membership_id,
                 ms.status AS membership_status,
                 ms.role,
                 ms.org_id
            FROM users u
            JOIN memberships ms
              ON ms.user_id = u.user_id
             AND ms.org_id = ?1
           WHERE ${targetUserId ? 'u.user_id = ?2' : 'lower(u.email) = ?2'}
           LIMIT 1
        `
        )
        .bind(actorMembership.org_id, targetUserId || targetEmail)
        .first();
      if (!targetLookup) {
        return jsonResponseFromD1(
          404,
          {
            ok: false,
            success: false,
            result: {
              success: false,
              message: '対象ユーザーが見つかりません。',
            },
          },
          allowedOrigin,
          requestId
        );
      }
      const membershipInfo = {
        membership_id: targetLookup.membership_id,
        role: targetLookup.role,
        status: targetLookup.membership_status,
      };
      const membershipId = membershipInfo?.membership_id;
      if (!membershipId) {
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'membership_missing',
          'ユーザーの所属情報を更新できませんでした。'
        );
      }
      const currentRole = normalizeRoleValue(membershipInfo?.role || targetLookup.role || 'member') || 'member';
      const currentMembershipStatus = normalizeUserStatusValue(
        membershipInfo?.status || 'pending'
      );
      const currentUserStatus = normalizeUserStatusValue(
        targetLookup.user_status || (targetLookup.is_active === 0 ? 'suspended' : 'active')
      );
      const currentStatus = computeEffectiveStatus(
        currentUserStatus,
        currentMembershipStatus,
        membershipId,
        targetLookup.is_active
      );
      const actorRole = normalizeRoleValue(accessContext?.role);
      if (currentRole === 'admin' && actorRole !== 'admin') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'admin_only',
          '管理者ユーザーの変更は管理者のみが実行できます。'
        );
      }
      if (requestedRole === 'admin' && actorRole !== 'admin') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'admin_only',
          '管理者ロールの付与には管理者権限が必要です。'
        );
      }
      const changes = [];
      const statements = [];
      const now = Date.now();
      if (requestedRole && requestedRole !== currentRole) {
        statements.push(
          db
            .prepare('UPDATE memberships SET role = ?1 WHERE membership_id = ?2 AND org_id = ?3')
            .bind(requestedRole, membershipId, actorMembership.org_id)
        );
        changes.push('role');
      }
      if (requestedStatus) {
        if (
          requestedStatus === 'active' &&
          (currentUserStatus === 'suspended' || currentUserStatus === 'revoked') &&
          actorRole !== 'admin'
        ) {
          return errorResponse(
            403,
            allowedOrigin,
            requestId,
            'cf-api',
            'admin_only',
            '全体停止・剥奪されたユーザーの再開は管理者のみ実行できます。'
          );
        }
        if (requestedStatus !== currentMembershipStatus) {
          statements.push(
            db
              .prepare(
                'UPDATE memberships SET status = ?1 WHERE membership_id = ?2 AND org_id = ?3'
              )
              .bind(requestedStatus, membershipId, actorMembership.org_id)
          );
        }
        const shouldActivateUser =
          requestedStatus === 'active' &&
          (currentUserStatus === 'pending' ||
            ((currentUserStatus === 'suspended' || currentUserStatus === 'revoked') &&
              actorRole === 'admin'));
        if (shouldActivateUser) {
          statements.push(
            db
              .prepare(
                `
                UPDATE users
                   SET status = 'active',
                       is_active = 1,
                       approved_by = ?1,
                       approved_at_ms = ?2,
                       updated_at_ms = ?2
                 WHERE user_id = ?3
                   AND CASE
                     WHEN LOWER(
                       COALESCE(
                         NULLIF(TRIM(status), ''),
                         CASE WHEN is_active = 0 THEN 'suspended' ELSE 'active' END
                       )
                     ) IN ('disabled', 'inactive') THEN 'suspended'
                     ELSE LOWER(
                       COALESCE(
                         NULLIF(TRIM(status), ''),
                         CASE WHEN is_active = 0 THEN 'suspended' ELSE 'active' END
                       )
                     )
                   END = ?4
              `
              )
              .bind(actorEmail, now, targetLookup.user_id, currentUserStatus)
          );
        }
        if (
          requestedStatus !== currentStatus ||
          requestedStatus !== currentMembershipStatus ||
          shouldActivateUser
        ) {
          changes.push('status');
        }
      }
      if (!statements.length) {
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            success: true,
            result: {
              success: true,
              message: '変更はありません。',
              changes: [],
            },
          },
          allowedOrigin,
          requestId
        );
      }
      if (changes.includes('status')) {
        statements.push(
          buildAuditLogStatement(db, {
            orgId: actorMembership.org_id,
            actorMembershipId: actorMembership.membership_id || null,
            targetType: 'user',
            targetId: targetLookup.user_id,
            action: 'user_status_update',
            payload: {
              to: requestedStatus,
              from: currentStatus,
              email: targetLookup.email || targetEmail,
            },
            createdAtMs: now,
            requestId,
            requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
            requestGenerationMs: idempotencyContext?.createdAtMs || null,
          })
        );
      }
      if (changes.includes('role')) {
        statements.push(
          buildAuditLogStatement(db, {
            orgId: actorMembership.org_id,
            actorMembershipId: actorMembership.membership_id || null,
            targetType: 'user',
            targetId: targetLookup.user_id,
            action: 'user_role_update',
            payload: {
              to: requestedRole,
              from: currentRole,
              email: targetLookup.email || targetEmail,
            },
            createdAtMs: now,
            requestId,
            requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
            requestGenerationMs: idempotencyContext?.createdAtMs || null,
          })
        );
      }
      try {
        await db.batch(statements.filter(Boolean));
      } catch (err) {
        console.error('[ShiftFlow][Admin] Failed to update user', {
          requestId,
          reasonCode: 'admin_user_update_failed',
        });
        return errorResponse(
          500,
          allowedOrigin,
          requestId,
          'cf-api',
          'update_failed',
          'ユーザーの更新に失敗しました。'
        );
      }
      captureDiagnostics(config, 'info', 'd1_admin_user_updated', {
        event: 'd1_admin_user_updated',
        requestId,
        orgId: actorMembership.org_id,
        changes,
        email: targetLookup.email || targetEmail,
      });
      const responsePayload = {
        success: true,
        message: 'ユーザー情報を更新しました。',
        changes,
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: responsePayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'adminRetryStorageCleanup') {
      if (normalizeRoleValue(accessContext?.role) !== 'admin') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'admin_only',
          'この操作は管理者のみ実行できます。'
        );
      }
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

      const args = Array.isArray(parsedBody?.args) ? parsedBody.args : [];
      const options =
        args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? args[0] : {};
      const rawLimit = options.limit;
      const limit = rawLimit === undefined ? 10 : rawLimit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'invalid_cleanup_limit',
          '一度に再試行できる件数は 1 件から 25 件です。'
        );
      }

      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = normalizeIdValue(accessContext?.orgId || '');
      if (
        !orgId ||
        !actorMembership?.membership_id ||
        actorMembership.org_id !== orgId
      ) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'cleanup_scope_unavailable',
          '再試行対象の組織を確認できません。'
        );
      }

      const writeRetryAudit = async (payload) => {
        const statement = buildAuditLogStatement(db, {
          orgId,
          actorMembershipId: actorMembership.membership_id,
          targetType: 'storage_cleanup',
          targetId: null,
          action: 'storage_cleanup.retry',
          payload,
          createdAtMs: Date.now(),
          requestId,
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
        });
        if (statement) {
          await statement.run();
        }
      };

      if (!env?.R2 || typeof env.R2.delete !== 'function') {
        await writeRetryAudit({
          status: 'unavailable',
          count: { selected: 0, deleted: 0, resolved: 0, pending: 0, blocked: 0 },
          errorCode: 'r2_unavailable',
        });
        return errorResponse(
          503,
          allowedOrigin,
          requestId,
          'cf-api',
          'r2_unavailable',
          'ファイルストレージが利用できないため、再試行を開始できません。'
        );
      }

      const selectedResult = await db
        .prepare(
          `
          SELECT job_id,
                 r2_key,
                 org_id,
                 updated_at_ms
            FROM storage_cleanup_jobs
           WHERE org_id = ?1
             AND org_id IS NOT NULL
             AND COALESCE(last_error, '') <> 'cleanup_scope_mismatch'
             AND (lease_token IS NULL OR lease_expires_at_ms <= ?2)
             AND (
               (reason <> 'upload_uncommitted' AND reason NOT LIKE '%commit_unknown')
               OR created_at_ms <= ?3
             )
           ORDER BY attempts ASC,
                    updated_at_ms ASC,
                    created_at_ms ASC,
                    job_id ASC
           LIMIT ?4
        `
        )
        .bind(
          orgId,
          Date.now(),
          Date.now() - STORAGE_UPLOAD_CLEANUP_GRACE_MS,
          limit
        )
        .all();
      const selectedJobs = Array.isArray(selectedResult?.results) ? selectedResult.results : [];
      const retryResults = [];
      for (const job of selectedJobs) {
        const retryResult = await cleanupR2KeysWithOutbox(db, env, [job.r2_key], {
          retryJob: job,
        });
        retryResults.push(retryResult);
      }

      const count = {
        selected: retryResults.length,
        deleted: retryResults.filter((entry) => entry?.outcome === 'deleted').length,
        resolved: retryResults.filter((entry) => entry?.outcome === 'resolved').length,
        pending: retryResults.filter((entry) => entry?.outcome === 'pending').length,
        blocked: retryResults.filter((entry) => entry?.outcome === 'blocked').length,
      };
      const status =
        count.selected === 0
          ? 'empty'
          : count.pending === 0 && count.blocked === 0
          ? 'completed'
          : count.deleted + count.resolved > 0
          ? 'partial'
          : 'pending';
      const jobs = retryResults.map((entry) => {
        const result = {
          jobId: entry?.jobId || '',
          status: entry?.status || 'retry_pending',
        };
        if (entry?.errorCode) {
          result.errorCode = entry.errorCode;
        }
        return result;
      });
      const resultPayload = { status, count, jobs };
      await writeRetryAudit(resultPayload);
      captureDiagnostics(config, 'info', 'storage_cleanup_retry', {
        event: 'storage_cleanup_retry',
        requestId,
        orgId,
        status,
        count,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: resultPayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getAuditLogs') {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '管理者権限が必要です。'
        );
      }
      const args = Array.isArray(parsedBody?.args) ? parsedBody.args : [];
      let limitArg = null;
      let filterArg = null;
      if (args.length >= 2) {
        limitArg = args[0];
        filterArg = args[1];
      } else if (args.length === 1) {
        if (typeof args[0] === 'number') {
          limitArg = args[0];
        } else {
          filterArg = args[0];
        }
      }
      const filters =
        filterArg && typeof filterArg === 'object' && !Array.isArray(filterArg) ? filterArg : {};
      const candidateLimit =
        typeof filters.limit === 'number' ? filters.limit : typeof limitArg === 'number' ? limitArg : 150;
      const limit = clampAuditLimit(candidateLimit);
      const rangeKey = filters.range || filters.period || '24h';
      const resolvedRange = resolveAuditRange(rangeKey);
      const candidateType = String(filters.eventType || filters.type || 'all').toLowerCase();
      const normalizedCandidateType = candidateType === 'login' ? 'auth' : candidateType;
      const recognizedTypes = new Set(['admin', 'auth', 'api']);
      const eventType =
        normalizedCandidateType === 'all' || !recognizedTypes.has(normalizedCandidateType)
          ? 'all'
          : normalizedCandidateType;
      const includeAdmin = eventType === 'all' || eventType === 'admin';
      const includeAuth = eventType === 'all' || eventType === 'auth';
      const includeApi = eventType === 'all' || eventType === 'api';
      const actorEmail = normalizeEmailValue(
        (tokenDetails && tokenDetails.email) || (accessContext && accessContext.email) || ''
      );
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership || !actorMembership.user_id) {
        const resultPayload = {
          rows: [],
          meta: {
            managerOnly: true,
            reason: '監査対象の組織に参加していません。',
          },
        };
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: resultPayload },
          allowedOrigin,
          requestId
        );
      }
      let orgId = actorMembership.org_id || accessContext?.orgId || null;
      const requestedOrgId =
        typeof filters.orgId === 'string' && filters.orgId.trim() && filters.orgId.trim() !== 'current'
          ? filters.orgId.trim()
          : '';
      if (requestedOrgId && requestedOrgId !== orgId) {
        const membershipForRequested = await fetchMembershipForOrg(
          db,
          actorMembership.user_id,
          requestedOrgId
        );
        const membershipStatus = (membershipForRequested?.status || '').trim().toLowerCase();
        if (
          !membershipForRequested ||
          (membershipStatus && membershipStatus !== 'active') ||
          !isManagerRole(membershipForRequested?.role)
        ) {
          return errorResponse(
            403,
            allowedOrigin,
            requestId,
            'cf-api',
            'org_access_denied',
            '指定の組織にアクセスできません。'
          );
        }
        orgId = requestedOrgId;
      }
      if (!orgId) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'org_not_found',
          '参照可能な組織が見つかりません。'
        );
      }
      const now = Date.now();
      const sinceMs = Math.max(0, now - resolvedRange.windowMs);
      const adminEntries = [];
      const authEntries = [];
      const apiEntries = [];
      const stats = { admin: 0, auth: 0, api: 0 };
      if (includeAdmin) {
        const adminCount = await db
          .prepare(
            `
            SELECT COUNT(*) AS row_count
              FROM audit_logs
             WHERE org_id = ?1
               AND created_at_ms >= ?2
          `
          )
          .bind(orgId, sinceMs)
          .first();
        stats.admin = Number(adminCount?.row_count || 0);
        const adminResult = await db
          .prepare(
            `
            SELECT
              al.audit_id,
              al.target_type,
              al.target_id,
              al.action,
              al.created_at_ms,
              al.payload_json,
              al.request_id,
              al.actor_membership_id,
              u.email AS actor_email,
              COALESCE(u.display_name, u.email) AS actor_name,
              ms.role AS actor_role
            FROM audit_logs al
            LEFT JOIN memberships ms ON ms.membership_id = al.actor_membership_id
            LEFT JOIN users u ON u.user_id = ms.user_id
            WHERE al.org_id = ?1
              AND al.created_at_ms >= ?2
            ORDER BY al.created_at_ms DESC
            LIMIT ?3
          `
          )
          .bind(orgId, sinceMs, limit)
          .all();
        const rows = Array.isArray(adminResult?.results) ? adminResult.results : [];
        rows.forEach((row) => {
          const entry = buildAdminAuditEntry(row);
          if (entry) {
            adminEntries.push(entry);
          }
        });
      }
      if (includeAuth) {
        const authCount = await db
          .prepare(
            `
            SELECT COUNT(*) AS row_count
              FROM auth_events ae
             WHERE (
                     ae.org_id = ?1
                     OR (
                       ae.org_id IS NULL
                       AND ae.user_id IS NOT NULL
                       AND EXISTS (
                         SELECT 1
                           FROM memberships auth_membership
                          WHERE auth_membership.org_id = ?1
                            AND auth_membership.user_id = ae.user_id
                            AND LOWER(COALESCE(auth_membership.status, '')) = 'active'
                       )
                     )
                   )
               AND ae.occurred_at_ms >= ?2
          `
          )
          .bind(orgId, sinceMs)
          .first();
        stats.auth = Number(authCount?.row_count || 0);
        const authResult = await db
          .prepare(
            `
            SELECT
              ae.event_id,
              ae.event_type,
              ae.outcome,
              ae.reason_code,
              ae.org_id,
              ae.user_id,
              u.email AS user_email,
              ae.user_sub,
              ae.status,
              ae.role,
              ae.request_id,
              ae.route,
              ae.source,
              ae.occurred_at_ms,
              COALESCE(u.display_name, u.email) AS display_name
            FROM auth_events ae
            LEFT JOIN users u ON u.user_id = ae.user_id
            WHERE (
                    ae.org_id = ?1
                    OR (
                      ae.org_id IS NULL
                      AND ae.user_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1
                          FROM memberships auth_membership
                         WHERE auth_membership.org_id = ?1
                           AND auth_membership.user_id = ae.user_id
                           AND LOWER(COALESCE(auth_membership.status, '')) = 'active'
                      )
                    )
                  )
              AND ae.occurred_at_ms >= ?2
            ORDER BY ae.occurred_at_ms DESC
            LIMIT ?3
          `
          )
          .bind(orgId, sinceMs, limit)
          .all();
        const rows = Array.isArray(authResult?.results) ? authResult.results : [];
        rows.forEach((row) => {
          const entry = buildAuthEventEntry(row);
          if (entry) {
            authEntries.push(entry);
          }
        });
      }
      if (includeApi) {
        const apiCount = await db
          .prepare(
            `
            SELECT COUNT(*) AS row_count
              FROM auth_proxy_logs
             WHERE created_at_ms >= ?2
               AND org_id = ?1
               AND LOWER(COALESCE(level, '')) IN ('warn', 'error')
          `
          )
          .bind(orgId, sinceMs)
          .first();
        stats.api = Number(apiCount?.row_count || 0);
        const proxyResult = await db
          .prepare(
            `
            SELECT
              apl.log_id,
              apl.level,
              apl.event,
              apl.message,
              apl.request_id,
              apl.route,
              apl.email,
              apl.status,
              apl.meta_json,
              apl.source,
              apl.cf_ray,
              apl.created_at_ms,
              apl.org_id,
              apl.user_id,
              u.display_name
            FROM auth_proxy_logs apl
            LEFT JOIN users u ON u.user_id = apl.user_id
            WHERE apl.created_at_ms >= ?2
              AND apl.org_id = ?1
              AND LOWER(COALESCE(apl.level, '')) IN ('warn', 'error')
            ORDER BY apl.created_at_ms DESC
            LIMIT ?3
          `
          )
          .bind(orgId, sinceMs, limit)
          .all();
        const rows = Array.isArray(proxyResult?.results) ? proxyResult.results : [];
        rows.forEach((row) => {
          const entry = buildProxyAuditEntry(row);
          if (entry) {
            apiEntries.push(entry);
          }
        });
      }
      const combined = adminEntries.concat(authEntries, apiEntries);
      combined.sort((a, b) => {
        const aTime = typeof a.occurredAt === 'number' ? a.occurredAt : 0;
        const bTime = typeof b.occurredAt === 'number' ? b.occurredAt : 0;
        return bTime - aTime;
      });
      const limitedRows = combined.slice(0, limit);
      const availableRows = stats.admin + stats.auth + stats.api;
      const resultPayload = {
        rows: limitedRows,
        meta: {
          totalRows: limitedRows.length,
          availableRows,
          truncated: availableRows > limit,
          stats,
          filters: {
            range: resolvedRange.key,
            eventType,
            orgId,
            limit,
          },
          refreshedAt: formatJst(now, true),
          rangeLabel: resolvedRange.label,
        },
      };
      captureDiagnostics(config, 'info', 'd1_admin_audit_logs', {
        event: 'd1_admin_audit_logs',
        requestId,
        orgId,
        counts: stats,
        filterType: eventType,
        range: resolvedRange.key,
      });
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: resultPayload },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'listMyTasks') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const responsePayload = await buildMyTasksPayload(db, rawEmail, accessContext?.orgId || '');
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
      const requestedTaskFolderId = normalizeIdValue(
        taskPayload.folderId || taskPayload.folder_id || ''
      );
      if (requestedTaskFolderId) {
        const taskFolderAccess = await ensureFolderAccessForUser(db, {
          orgId: accessContext?.orgId || '',
          folderId: requestedTaskFolderId,
          userId: accessContext?.userId || '',
          isManager: isManagerRole(accessContext?.role),
          requireActive: true,
        });
        if (!taskFolderAccess) {
          return errorResponse(
            403,
            allowedOrigin,
            requestId,
            'cf-api',
            'task_folder_access_denied',
            '指定されたフォルダへタスクを保存する権限がありません。'
          );
        }
        taskPayload.folderId = taskFolderAccess.id;
        delete taskPayload.folder_id;
      }
      const timestampMs =
        interception?.dualWriteContext?.timestampMs && Number.isFinite(interception.dualWriteContext.timestampMs)
          ? interception.dualWriteContext.timestampMs
          : Date.now();
      const taskId = await createRequestScopedId({
        kind: 'task',
        orgId: accessContext?.orgId || '',
        actorUserId: accessContext?.userId || '',
        requestId,
        resourceScope:
          `${normalizeIdValue(taskPayload.folderId || taskPayload.folder_id || '') || 'tasks'}:${
            idempotencyContext?.payloadSha256 || ''
          }`,
      });
      // auditは期限なしのtombstoneとして扱う。7日TTLの台帳が更新されても、
      // 同じ作成requestで削除済みresourceを復活させない。
      const priorCreate = await db
        .prepare(
          `
          SELECT al.audit_id
            FROM audit_logs al
            JOIN memberships actor ON actor.membership_id = al.actor_membership_id
           WHERE al.org_id = ?1
             AND actor.user_id = ?2
             AND al.target_type = 'task'
             AND al.target_id = ?3
             AND al.action = 'task.create'
             AND al.request_id = ?4
           LIMIT 1
        `
        )
        .bind(
          accessContext?.orgId || '',
          accessContext?.userId || '',
          taskId,
          requestId
        )
        .first();
      if (priorCreate?.audit_id) {
        const existingTask = await db
          .prepare('SELECT task_id FROM tasks WHERE task_id = ?1 AND org_id = ?2')
          .bind(taskId, accessContext?.orgId || '')
          .first();
        if (!existingTask?.task_id) {
          return errorResponse(
            409,
            allowedOrigin,
            requestId,
            'cf-api',
            'idempotency_replay',
            'このタスク作成リクエストは既に完了しており、対象は現在存在しません。新しい操作としてやり直してください。'
          );
        }
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            success: true,
            message: 'タスクを追加しました。',
            taskId,
            idempotentReplay: true,
          },
          allowedOrigin,
          requestId
        );
      }
      await insertTaskIntoD1(db, {
        notification: { enabled: isPushConfigured(env), orgId: accessContext.orgId, actorUserId: accessContext.userId,
          requestId, payloadSha256: idempotencyContext.payloadSha256, generationMs: idempotencyContext.createdAtMs },
                taskId,
        payload: taskPayload,
        timestampMs,
        authorEmail: tokenDetails?.email || accessContext?.email || '',
        orgId: accessContext?.orgId || '',
        role: accessContext?.role,
        requestId,
        audit: {
          targetType: 'task',
          action: 'task.create',
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
          payload: {
            title: typeof taskPayload.title === 'string' ? taskPayload.title.trim() : '',
            assigneeCount: Array.isArray(taskPayload.assignees) ? taskPayload.assignees.length : 0,
          },
        },
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
      const taskAccess = await resolveTaskAccess(db, {
        taskId,
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      if (!taskAccess) {
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
      if (!taskAccess.canUpdate) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_access_denied',
          'このタスクを更新する権限がありません。'
        );
      }
      const updatePayload = ctx?.payload || {};
      if (updatePayload.folderId !== undefined || updatePayload.folder_id !== undefined) {
        const requestedTaskFolderId = normalizeIdValue(
          updatePayload.folderId || updatePayload.folder_id || ''
        );
        if (requestedTaskFolderId) {
          const taskFolderAccess = await ensureFolderAccessForUser(db, {
            orgId: accessContext?.orgId || '',
            folderId: requestedTaskFolderId,
            userId: accessContext?.userId || '',
            isManager: isManagerRole(accessContext?.role),
            requireActive: true,
          });
          if (!taskFolderAccess) {
            return errorResponse(
              403,
              allowedOrigin,
              requestId,
              'cf-api',
              'task_folder_access_denied',
              '指定されたフォルダへタスクを移動する権限がありません。'
            );
          }
          updatePayload.folderId = taskFolderAccess.id;
        } else {
          updatePayload.folderId = null;
        }
        delete updatePayload.folder_id;
      }
      await updateTaskInD1(db, {
        notification: { enabled: isPushConfigured(env), orgId: accessContext.orgId, actorUserId: accessContext.userId,
          requestId, payloadSha256: idempotencyContext.payloadSha256, generationMs: idempotencyContext.createdAtMs },
                taskId,
        payload: updatePayload,
        timestampMs: ctx?.timestampMs || Date.now(),
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        requestId,
        audit: {
          targetType: 'task',
          action: 'task.update',
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
          payload: {
            fields: Object.keys(updatePayload).filter((key) =>
              ['title', 'description', 'status', 'priority', 'dueDate', 'folderId', 'assignees'].includes(key)
            ),
          },
        },
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
      const taskAccess = await resolveTaskAccess(db, {
        taskId,
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      if (!taskAccess) {
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
      if (!taskAccess.canComplete) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_access_denied',
          'このタスクを完了する権限がありません。'
        );
      }
      await completeTaskInD1(db, {
        notification: { ...{ enabled: isPushConfigured(env), orgId: accessContext.orgId, actorUserId: accessContext.userId,
          requestId, payloadSha256: idempotencyContext.payloadSha256, generationMs: idempotencyContext.createdAtMs }, folderId: taskAccess.row.folder_id },
                taskId,
        timestampMs: Date.now(),
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        requestId,
        audit: {
          targetType: 'task',
          action: 'task.complete',
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
        },
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
      const taskAccess = await resolveTaskAccess(db, {
        taskId,
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      if (!taskAccess) {
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
      const currentEmail = taskAccess.actorEmail;
      if (!taskAccess.canDelete) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '削除権限がありません。'
        );
      }
      await deleteTaskFromD1(db, env, {
        taskId,
        orgId: accessContext?.orgId || '',
        actorEmail: currentEmail,
        requestId,
        config,
        audit: {
          targetType: 'task',
          action: 'task.delete',
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
        },
      });
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
      const totalRow = await db
        .prepare('SELECT COUNT(*) AS count FROM tasks WHERE org_id = ?1')
        .bind(accessContext?.orgId || '')
        .first();
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
             AND org_id = ?2
        `
        )
        .bind(normalizedEmail, accessContext?.orgId || '')
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
      const allResult = await db
        .prepare('SELECT * FROM tasks WHERE org_id = ?1')
        .bind(accessContext?.orgId || '')
        .all();
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
      const taskAccess = await resolveTaskAccess(db, {
        taskId,
        orgId: accessContext?.orgId || '',
        actorEmail: tokenDetails?.email || accessContext?.email || '',
        role: accessContext?.role,
      });
      if (!taskAccess) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      if (!taskAccess.canRead) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'task_access_denied',
          'このタスクを表示する権限がありません。'
        );
      }
      const row = taskAccess.row;
      const assigneeMap = await fetchAssigneesForTasks(db, [taskId]);
      const summary = buildTaskRecordFromD1(row, assigneeMap.get(taskId) || []);
      const detail = {
        id: summary?.id || row.task_id,
        title: summary?.title || row.title || 'Untitled Task',
        assignee: summary?.assignee || '',
        dueDate: summary?.dueDate || '',
        status: summary?.status || mapD1StatusToLegacy(row.status),
        priority: summary?.priority || mapD1PriorityToLegacy(row.priority),
        createdBy: row.created_by_email || '',
        canDelete: taskAccess.canDelete,
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
      const messageId = await createRequestScopedId({
        kind: 'message',
        orgId: accessContext?.orgId || '',
        actorUserId: accessContext?.userId || '',
        requestId,
        resourceScope: `messages:${idempotencyContext?.payloadSha256 || ''}`,
      });
      const actorEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedActorEmail = normalizeEmailValue(actorEmail);
      const membership = normalizedActorEmail
        ? await resolveMembershipForEmail(db, normalizedActorEmail, accessContext?.orgId)
        : null;
      const orgId = membership?.org_id || accessContext?.orgId || '';
      let folderId =
        typeof messagePayload.folderId === 'string'
          ? messagePayload.folderId
          : typeof messagePayload.folder_id === 'string'
          ? messagePayload.folder_id
          : '';
      if (!folderId) {
        folderId = (await ensureDefaultFolderForOrg(db, orgId)) || '';
      }
      const folderAccess = await ensureFolderAccessForUser(db, {
        orgId,
        folderId,
        userId: membership?.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        requireActive: true,
      });
      if (!folderAccess) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'このフォルダには投稿できません。'
        );
      }
      const existingMessage = await db
        .prepare('SELECT message_id FROM messages WHERE message_id = ?1 AND org_id = ?2')
        .bind(messageId, orgId || '')
        .first();
      if (existingMessage) {
        return jsonResponseFromD1(
          200,
          {
            ok: true,
            success: true,
            message: 'メッセージを投稿しました。',
            memoId: messageId,
            idempotentReplay: true,
          },
          allowedOrigin,
          requestId
        );
      }
      if (membership?.membership_id) {
        const priorCreate = await db
          .prepare(
            `
            SELECT audit_id
              FROM audit_logs
             WHERE org_id = ?1
               AND actor_membership_id = ?2
               AND target_type = 'message'
               AND target_id = ?3
               AND action = 'message.create'
               AND request_id = ?4
             LIMIT 1
          `
          )
          .bind(orgId || '', membership.membership_id, messageId, requestId)
          .first();
        if (priorCreate?.audit_id) {
          return errorResponse(
            409,
            allowedOrigin,
            requestId,
            'cf-api',
            'idempotency_replay',
            'この投稿リクエストは既に完了しており、対象は現在存在しません。新しい操作としてやり直してください。'
          );
        }
      }
      messagePayload.folderId = folderAccess.id;
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
        const resolvedOrgId = membership?.org_id || accessContext?.orgId || null;
        if (!resolvedOrgId) {
          return errorResponse(
            403,
            allowedOrigin,
            requestId,
            'cf-api',
            'attachment_scope_unavailable',
            '添付ファイルの保存先組織を確認できません。'
          );
        }
        const hasLegacyInlineData = rawAttachments.some(
          (attachment) =>
            typeof attachment?.dataUri === 'string' || typeof attachment?.imageData === 'string'
        );
        if (hasLegacyInlineData) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'staged_attachment_required',
            '添付ファイルは先に一時アップロードしてから投稿してください。'
          );
        }
        const stagedAttachmentIds = rawAttachments.map((attachment) =>
          normalizeIdValue(attachment?.stagedAttachmentId)
        );
        if (stagedAttachmentIds.some((id) => !id) || new Set(stagedAttachmentIds).size !== stagedAttachmentIds.length) {
          return errorResponse(
            400,
            allowedOrigin,
            requestId,
            'cf-api',
            'staged_attachment_invalid',
            '添付ファイルの一時保存IDが正しくありません。もう一度選択してください。'
          );
        }
        const stagedRows = await resolveStagedAttachmentsForClaim(db, {
          stagedAttachmentIds,
          orgId: resolvedOrgId,
          ownerUserId: membership?.user_id || accessContext?.userId || '',
          ownerMembershipId: membership?.membership_id || '',
          purpose: 'message',
          targetType: 'message',
          targetId: messageId,
        });
        if (!stagedRows || stagedRows.length !== stagedAttachmentIds.length) {
          return errorResponse(
            409,
            allowedOrigin,
            requestId,
            'cf-api',
            'staged_attachment_unavailable',
            '添付ファイルが期限切れ、使用済み、または現在のユーザーに属していません。もう一度選択してください。'
          );
        }
        for (const staged of stagedRows) {
          const attachmentId = staged.staged_attachment_id;
          uploadKeysForRollback.push(staged.r2_key);
          preparedAttachments.push({
            attachmentId,
            stagedAttachmentId: staged.staged_attachment_id,
            fileName: staged.file_name,
            mimeType: staged.content_type,
            sizeBytes: Number(staged.size_bytes),
            checksum: staged.checksum,
            storagePath: buildAttachmentDownloadPath(attachmentId),
            createdAtMs: timestampMs,
            createdByMembershipId: membership?.membership_id || null,
            orgId: resolvedOrgId,
            extra: {
              r2Key: staged.r2_key,
              category: 'message_attachment',
              messageId,
              uploadedAtMs: Number(staged.created_at_ms || timestampMs),
              ownerUserId: membership?.user_id || accessContext?.userId || '',
              originalName: staged.file_name,
            },
          });
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
      const messageStatements = [
        buildMessageInsertStatement(db, {
          messageId,
          payload: messagePayload,
          timestampMs,
          orgId,
          membershipId: membership?.membership_id || null,
          ownerUserId: membership?.user_id || accessContext?.userId || '',
          requiredStagedAttachments: preparedAttachments.map((attachment) => ({
            staged_attachment_id: attachment.stagedAttachmentId,
          })),
        }),
      ];
      if (orgId) {
        const auditFolderId = folderAccess?.id || folderId;
        messageStatements.push(
          buildAuditLogStatement(db, {
            orgId,
            actorMembershipId: membership?.membership_id || null,
            targetType: 'message',
            targetId: messageId,
            action: 'message.create',
            createdAtMs: timestampMs,
            requestId,
            requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
            requestGenerationMs: idempotencyContext?.createdAtMs || null,
            onlyIfPreviousStatementChanged: true,
            payload: {
              title: typeof messagePayload.title === 'string' ? messagePayload.title.trim() : '',
              folderId: auditFolderId || '',
              attachmentCount: preparedAttachments.length,
            },
          })
        );
      }
      for (const attachment of preparedAttachments) {
        messageStatements.push(
          buildStagedAttachmentClaimStatement(
            db,
            { staged_attachment_id: attachment.stagedAttachmentId },
            {
              orgId: attachment.orgId || orgId || '',
              ownerUserId: membership?.user_id || accessContext?.userId || '',
              ownerMembershipId: membership?.membership_id || '',
              purpose: 'message',
              targetType: 'message',
              targetId: messageId,
              claimedAtMs: timestampMs,
            }
          ),
          buildAttachmentRecordStatement(db, {
            ...attachment,
            preserveExisting: true,
            stagedClaim: {
              stagedAttachmentId: attachment.stagedAttachmentId,
              targetType: 'message',
              targetId: messageId,
            },
          }),
          buildStagedMessageAttachmentLinkStatement(
            db,
            attachment.stagedAttachmentId,
            messageId,
            attachment.orgId || orgId || ''
          ),
          buildClearStorageCleanupJobForAdoptedAttachmentStatement(db, {
            r2Key: attachment.extra?.r2Key || '',
            attachmentId: attachment.attachmentId,
            orgId: attachment.orgId || orgId || '',
          })
        );
      }
      if (membership?.membership_id) {
        messageStatements.push(
          db
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
            .bind(generateMessageId(), messageId, membership.membership_id, timestampMs)
        );
      }
      messageStatements.push(await buildPushEventStatement(db, { ...{ enabled: isPushConfigured(env), orgId: accessContext.orgId, actorUserId: accessContext.userId,
          requestId, payloadSha256: idempotencyContext.payloadSha256, generationMs: idempotencyContext.createdAtMs }, kind: 'message_created',
        resourceId: messageId, folderId: folderAccess?.id || folderId, auditAction: 'message.create' }));
      let messageWriteRecovered = false;
      try {
        await db.batch(messageStatements.filter(Boolean));
        if (preparedAttachments.length) {
          const stagedIds = preparedAttachments.map(
            (attachment) => attachment.stagedAttachmentId
          );
          const placeholders = stagedIds.map((_, index) => `?${index + 3}`).join(', ');
          const verification = await db
            .prepare(
              `
              SELECT COUNT(*) AS count
                FROM message_attachments ma
                JOIN attachments a ON a.attachment_id = ma.attachment_id
                JOIN staged_attachments staged
                  ON staged.staged_attachment_id = a.attachment_id
               WHERE ma.message_id = ?1
                 AND a.org_id = ?2
                 AND staged.status = 'claimed'
                 AND staged.claimed_target_type = 'message'
                 AND staged.claimed_target_id = ?1
                 AND staged.staged_attachment_id IN (${placeholders})
            `
            )
            .bind(messageId, orgId || '', ...stagedIds)
            .first();
          if (Number(verification?.count || 0) !== stagedIds.length) {
            const claimError = new Error('Staged attachment claim could not be verified.');
            claimError.code = 'staged_attachment_claim_failed';
            throw claimError;
          }
        }
      } catch (err) {
        await queueR2CleanupCandidates(db, uploadKeysForRollback, {
          orgId: orgId || '',
          targetType: 'message',
          targetId: messageId,
          reason: 'message_create_commit_unknown',
          requestId,
          config,
        });
        try {
          const primaryDb = resolvePrimaryD1(db);
          const recoveredMessage = await primaryDb
            .prepare('SELECT message_id FROM messages WHERE message_id = ?1 AND org_id = ?2')
            .bind(messageId, orgId || '')
            .first();
          let recoveredAttachments = true;
          const adoptedOwnKeys = [];
          if (preparedAttachments.length) {
            const attachmentIds = preparedAttachments.map((attachment) => attachment.attachmentId);
            const placeholders = attachmentIds.map((_, index) => `?${index + 3}`).join(', ');
            const result = await primaryDb
              .prepare(
                `
                SELECT a.attachment_id,
                       a.extra_json
                  FROM message_attachments ma
                  JOIN attachments a ON a.attachment_id = ma.attachment_id
                 WHERE ma.message_id = ?1
                   AND a.org_id = ?2
                   AND a.attachment_id IN (${placeholders})
              `
              )
              .bind(messageId, orgId || '', ...attachmentIds)
              .all();
            const rows = Array.isArray(result?.results) ? result.results : [];
            const selectedKeys = new Map(
              rows.map((row) => [
                normalizeIdValue(row?.attachment_id),
                String(safeParseJson(row?.extra_json || null, {})?.r2Key || '').trim(),
              ])
            );
            recoveredAttachments = preparedAttachments.every((attachment) =>
              Boolean(selectedKeys.get(attachment.attachmentId))
            );
            preparedAttachments.forEach((attachment) => {
              if (selectedKeys.get(attachment.attachmentId) === attachment.extra?.r2Key) {
                adoptedOwnKeys.push(attachment.extra.r2Key);
              }
            });
          }
          messageWriteRecovered = Boolean(recoveredMessage?.message_id && recoveredAttachments);
          if (messageWriteRecovered && adoptedOwnKeys.length) {
            await clearStorageCleanupJobs(primaryDb, adoptedOwnKeys);
          }
        } catch (_reconcileError) {
          messageWriteRecovered = false;
        }
        if (!messageWriteRecovered) {
          console.error('[ShiftFlow][Message] Atomic create result is unknown', {
            requestId,
            messageId,
            reasonCode: 'message_atomic_write_unknown',
          });
          captureDiagnostics(config, 'error', 'message_create_failed', {
            event: 'message_create_failed',
            route: normalizedRoute,
            requestId,
            email: normalizedActorEmail || '',
            orgId: orgId || '',
            userId: accessContext?.userId || '',
            detail: 'message_atomic_write_unknown',
          });
          return errorResponse(
            500,
            allowedOrigin,
            requestId,
            'cf-api',
            'message_create_failed',
            'メッセージの保存結果を確認できませんでした。再読み込み後に状態を確認してください。'
          );
        }
        captureDiagnostics(config, 'warn', 'message_create_commit_recovered', {
          event: 'message_create_commit_recovered',
          route: normalizedRoute,
          requestId,
          orgId: orgId || '',
          userId: accessContext?.userId || '',
          detail: 'message_create_commit_recovered',
        });
      }
      if (preparedAttachments.length) {
        try {
          const unselectedUploadKeys = await findUnselectedR2UploadKeys(
            db,
            preparedAttachments.map((attachment) => ({
              attachmentId: attachment.attachmentId,
              r2Key: attachment.extra?.r2Key || '',
            })),
            orgId
          );
          if (unselectedUploadKeys.length) {
            await cleanupR2KeysWithOutbox(db, env, unselectedUploadKeys, {
              orgId: orgId || '',
              targetType: 'message',
              targetId: messageId,
              reason: 'message_upload_superseded',
              requestId,
              config,
            });
          }
        } catch (_error) {
          // DB正本を確認できない場合は、採用済みobjectの誤削除を避けて後続監視へ残す。
          captureDiagnostics(config, 'error', 'message_upload_reconcile_failed', {
            event: 'message_upload_reconcile_failed',
            route: normalizedRoute,
            requestId,
            orgId: orgId || '',
            userId: accessContext?.userId || '',
            detail: 'message_upload_reconcile_failed',
          });
        }
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
             AND m.org_id = ?2
        `
        )
        .bind(messageId, accessContext?.orgId || '')
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
      await deleteMessageFromD1(db, env, {
        messageId,
        orgId: accessContext?.orgId || '',
        actorEmail: currentEmail,
        requestId,
        config,
        audit: {
          targetType: 'message',
          action: 'message.delete',
          requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
          requestGenerationMs: idempotencyContext?.createdAtMs || null,
        },
      });
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
      const readAccess = await resolveMemoReadAccess(db, {
        messageId,
        orgId: accessContext?.orgId || '',
        userId: accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
      });
      if (readAccess.status === 'not_found') {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          '対象のメッセージが見つかりません。'
        );
      }
      if (readAccess.status === 'forbidden') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_access_denied',
          'このメッセージを既読にする権限がありません。'
        );
      }
      await ensureMemoReadInD1(db, {
        messageId,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
        orgId: accessContext?.orgId || '',
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
      const readAccess = await resolveMemoReadAccess(db, {
        messageId,
        orgId: accessContext?.orgId || '',
        userId: accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
      });
      if (readAccess.status === 'not_found') {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          '対象のメッセージが見つかりません。'
        );
      }
      if (readAccess.status === 'forbidden') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_access_denied',
          'このメッセージの既読状態を変更する権限がありません。'
        );
      }
      const shouldRead =
        argsArray.length > 1 ? Boolean(argsArray[1]) : true;
      await toggleMemoReadInD1(db, {
        messageId,
        shouldRead,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
        orgId: accessContext?.orgId || '',
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
        ? Array.from(new Set(rawList.map((id) => normalizeIdValue(id)).filter(Boolean)))
        : [];
      const readAccess = await preflightMemoReadAccess(db, memoIds, {
        orgId: accessContext?.orgId || '',
        userId: accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
      });
      if (readAccess.status === 'not_found') {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          '既読対象に参照できないメッセージが含まれています。'
        );
      }
      if (readAccess.status === 'forbidden') {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'folder_access_denied',
          '既読対象に権限のないメッセージが含まれています。'
        );
      }
      await bulkEnsureMemoReadInD1(db, {
        messageIds: memoIds,
        timestampMs: Date.now(),
        email: tokenDetails?.email || accessContext?.email || '',
        orgId: accessContext?.orgId || '',
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
    if (primaryRoute === 'messages' && routeSegments.length === 1 && requestMethod === 'GET') {
      const folderId = query?.get('folderId') || query?.get('folder_id') || '';
      const unreadOnly =
        query?.get('unreadOnly') === '1' || query?.get('unread_only') === '1';
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const membershipId = membership?.membership_id || null;
      const orgId = membership?.org_id || accessContext?.orgId || '';
      const userId = membership?.user_id || accessContext?.userId || '';
      const isManager = isManagerRole(accessContext?.role);
      const messages = await buildMessagesForUser(db, {
        folderId,
        membershipId,
        orgId,
        userId,
        isManager,
      });
      const payload = unreadOnly
        ? messages.filter((item) => !item.isRead || item.hasNewComment)
        : messages;
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
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
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const membershipId = membership?.membership_id || null;
      const orgId = membership?.org_id || accessContext?.orgId || '';
      const userId = membership?.user_id || accessContext?.userId || '';
      const isManager = isManagerRole(accessContext?.role);
      const messages = await buildMessagesForUser(db, {
        folderId,
        membershipId,
        orgId,
        userId,
        isManager,
      });
      const payload = unreadOnly
        ? messages.filter((item) => !item.isRead || item.hasNewComment)
        : messages;
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: payload },
        allowedOrigin,
        requestId
      );
    }
    if (
      primaryRoute === 'messages' &&
      routeSegments.length === 3 &&
      tertiaryRoute === 'pin' &&
      requestMethod === 'POST'
    ) {
      const pinAllowedRoles = new Set(['admin', 'manager', 'member']);
      if (!pinAllowedRoles.has(String(accessContext?.role || '').toLowerCase())) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'ピン留めを利用する権限がありません。'
        );
      }
      const messageId = normalizeIdValue(secondaryRoute);
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
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!actorMembership?.membership_id || !actorMembership?.org_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'ピン留めを保存する所属情報が見つかりません。'
        );
      }
      const orgId = actorMembership.org_id;
      const messageRow = await db
        .prepare(
          `
          SELECT m.message_id,
                 m.folder_id,
                 m.org_id
            FROM messages m
           WHERE m.message_id = ?1
             AND m.org_id = ?2
        `
        )
        .bind(messageId, orgId)
        .first();
      if (!messageRow) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          'メッセージが見つかりません。'
        );
      }
      if (orgId && messageRow.org_id && orgId !== messageRow.org_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '他組織のメッセージには操作できません。'
        );
      }
      const folderAccess = await ensureFolderAccessForUser(db, {
        orgId,
        folderId: messageRow.folder_id,
        userId: actorMembership.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        requireActive: false,
      });
      if (!folderAccess) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'このメッセージはピン留めできません。'
        );
      }
      const bodyObject = parsedBody && typeof parsedBody === 'object' ? parsedBody : {};
      const hasDesiredPin = Object.prototype.hasOwnProperty.call(bodyObject, 'pin');
      if (!hasDesiredPin || typeof bodyObject.pin !== 'boolean') {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'invalid_pin_state',
          'ピン状態は true または false で必ず指定してください。'
        );
      }
      const currentPin = await db
        .prepare(
          `
          SELECT pinned_at_ms
            FROM message_pins
           WHERE message_id = ?1
             AND membership_id = ?2
             AND org_id = ?3
        `
        )
        .bind(messageRow.message_id, actorMembership.membership_id, orgId)
        .first();
      const currentlyPinned = !!currentPin;
      const nextPinned = bodyObject.pin;
      let changed = false;
      const now = Date.now();
      let pinMutationStatement = null;
      if (nextPinned !== currentlyPinned && nextPinned) {
        pinMutationStatement = db
          .prepare(
            `
            INSERT OR IGNORE INTO message_pins (
              message_id,
              membership_id,
              org_id,
              pinned_at_ms
            )
            VALUES (?1, ?2, ?3, ?4)
          `
          )
          .bind(messageRow.message_id, actorMembership.membership_id, orgId, now);
      } else if (nextPinned !== currentlyPinned) {
        pinMutationStatement = db
          .prepare(
            `
            DELETE FROM message_pins
             WHERE message_id = ?1
               AND membership_id = ?2
               AND org_id = ?3
          `
          )
          .bind(messageRow.message_id, actorMembership.membership_id, orgId);
      }
      if (pinMutationStatement) {
        const results = await db.batch(
          [
            pinMutationStatement,
            buildAuditLogStatement(db, {
              orgId: messageRow.org_id || orgId,
              actorMembershipId: actorMembership.membership_id,
              targetType: 'message',
              targetId: messageRow.message_id,
              action: nextPinned ? 'message.pin' : 'message.unpin',
              createdAtMs: now,
              requestId,
              requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
              requestGenerationMs: idempotencyContext?.createdAtMs || null,
              onlyIfPreviousStatementChanged: true,
              payload: {
                folderId: messageRow.folder_id,
                personalized: true,
              },
            }),
          ].filter(Boolean)
        );
        changed = Number(results?.[0]?.meta?.changes || 0) > 0;
      }
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            messageId: messageRow.message_id,
            isPinned: !!nextPinned,
            changed,
          },
        },
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
             AND m.org_id = ?2
        `
        )
        .bind(messageId, accessContext?.orgId || '')
        .first();
      if (!messageRow) {
        return jsonResponseFromD1(
          200,
          { ok: true, success: true, result: null },
          allowedOrigin,
          requestId
        );
      }
      const viewerEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const viewerMembership = viewerEmail
        ? await resolveMembershipForEmail(db, viewerEmail, accessContext?.orgId)
        : null;
      if (!viewerMembership || messageRow.org_id !== viewerMembership.org_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'このメッセージにはアクセスできません。'
        );
      }
      const folderAccess = await ensureFolderAccessForUser(db, {
        orgId: messageRow.org_id || viewerMembership?.org_id || accessContext?.orgId || null,
        folderId: messageRow.folder_id,
        userId: viewerMembership?.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        requireActive: false,
      });
      if (!folderAccess) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'このメッセージにはアクセスできません。'
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
      const membership = viewerMembership;
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
      const createdAtMs =
        typeof messageRow?.created_at_ms === 'number' && Number.isFinite(messageRow.created_at_ms)
          ? messageRow.created_at_ms
          : null;
      const createdAtLabel = createdAtMs ? formatJst(createdAtMs, true) : '';
      const authorLabel = buildUserLabel(messageRow?.author_email, messageRow?.author_display_name);
      const priority = mapD1PriorityToLegacy(messageRow?.priority);
      const comments = await fetchMessageComments(db, messageId);
      const detail = {
        id: messageRow?.message_id || messageId,
        createdBy: messageRow?.author_email || '',
        createdByLabel: authorLabel,
        title: messageRow?.title || '',
        body: typeof messageRow?.body === 'string' ? messageRow.body.replace(/\r\n/g, '\n') : '',
        priority: priority || '中',
        comments,
        readUsers,
        unreadUsers,
        readEmails,
        unreadEmails,
        canDelete,
        attachments,
        createdAt: createdAtMs,
        createdAtLabel,
      };
      return jsonResponseFromD1(
        200,
        { ok: true, success: true, result: detail },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'addNewComment') {
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
      const args =
        parsedBody && Array.isArray(parsedBody.args) && parsedBody.args.length
          ? parsedBody.args
          : [];
      const payload = args.length && args[0] && typeof args[0] === 'object' ? args[0] : {};
      const messageId = normalizeIdValue(
        payload.memoId || payload.messageId || payload.message_id || payload.id || ''
      );
      const commentBody = typeof payload.body === 'string' ? payload.body.trim() : '';
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
      if (!commentBody) {
        return errorResponse(
          400,
          allowedOrigin,
          requestId,
          'cf-api',
          'comment_body_required',
          'コメント本文を入力してください。'
        );
      }
      const actorEmailRaw = tokenDetails?.email || accessContext?.email || '';
      const actorEmail = normalizeEmailValue(actorEmailRaw);
      const membership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      if (!membership) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'コメントを投稿する権限がありません。'
        );
      }
      const messageRow = await db
        .prepare(
          `
          SELECT m.message_id,
                 m.folder_id,
                 m.org_id
            FROM messages m
           WHERE m.message_id = ?1
             AND m.org_id = ?2
        `
        )
        .bind(messageId, accessContext?.orgId || '')
        .first();
      if (!messageRow) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          'メッセージが見つかりません。'
        );
      }
      const orgId = membership.org_id || accessContext?.orgId || null;
      if (messageRow.org_id && orgId && messageRow.org_id !== orgId) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '他組織のメッセージにはコメントできません。'
        );
      }
      if (!orgId) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'コメントを投稿できません。'
        );
      }
      const folderAccess = await ensureFolderAccessForUser(db, {
        orgId,
        folderId: messageRow.folder_id,
        userId: membership.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
        requireActive: false,
      });
      if (!folderAccess) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          'このメッセージにはコメントできません。'
        );
      }
      const userRow = membership?.user_id
        ? await db
            .prepare(
              `
              SELECT email, display_name
                FROM users
               WHERE user_id = ?1
            `
            )
            .bind(membership.user_id)
            .first()
        : null;
      const authorEmail = normalizeEmailValue(userRow?.email || actorEmailRaw);
      const authorDisplayName = buildUserLabel(
        authorEmail || actorEmailRaw,
        userRow?.display_name || accessContext?.displayName || tokenDetails?.name || ''
      );
      const now = Date.now();
      const commentId = await createRequestScopedId({
        kind: 'message-comment',
        orgId,
        actorUserId: membership.user_id || accessContext?.userId || '',
        requestId,
        resourceScope: `${messageRow.message_id}:${idempotencyContext?.payloadSha256 || ''}`,
      });
      const mentionsValue = Array.isArray(payload.mentions)
        ? payload.mentions
            .map((m) => normalizeEmailValue(m))
            .filter(Boolean)
            .join(',')
        : null;
      await db.batch(
        [
          db
            .prepare(
              `
              INSERT OR IGNORE INTO message_comments (
                comment_id,
                message_id,
                org_id,
                membership_id,
                author_email,
                author_display_name,
                body,
                mentions,
                created_at_ms,
                updated_at_ms
              )
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            `
            )
            .bind(
              commentId,
              messageRow.message_id,
              orgId,
              membership.membership_id || null,
              authorEmail || actorEmail || null,
              authorDisplayName || null,
              commentBody,
              mentionsValue,
              now,
              now
            ),
          buildAuditLogStatement(db, {
            orgId,
            actorMembershipId: membership.membership_id || null,
            targetType: 'message',
            targetId: messageRow.message_id,
            action: 'message.comment',
            createdAtMs: now,
            requestId,
            requestPayloadSha256: idempotencyContext?.payloadSha256 || null,
            requestGenerationMs: idempotencyContext?.createdAtMs || null,
            onlyIfPreviousStatementChanged: true,
            payload: { commentId },
          }),
          await buildPushEventStatement(db, { ...{ enabled: isPushConfigured(env), orgId: accessContext.orgId, actorUserId: accessContext.userId,
          requestId, payloadSha256: idempotencyContext.payloadSha256, generationMs: idempotencyContext.createdAtMs }, kind: 'comment_created',
            resourceId: messageRow.message_id, folderId: messageRow.folder_id, auditAction: 'message.comment' }),
        ].filter(Boolean)
      );
      const comments = await fetchMessageComments(db, messageId);
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            success: true,
            commentId,
            comments,
            message: 'コメントを投稿しました。',
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (
      primaryRoute === 'messages' &&
      routeSegments.length === 3 &&
      tertiaryRoute === 'read_status' &&
      requestMethod === 'GET'
    ) {
      if (!isManagerRole(accessContext?.role)) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '未読状況を確認する権限がありません。'
        );
      }
      const messageId = normalizeIdValue(secondaryRoute);
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
      const actorEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const actorMembership = actorEmail
        ? await resolveMembershipForEmail(db, actorEmail, accessContext?.orgId)
        : null;
      const orgId = actorMembership?.org_id || accessContext?.orgId || '';
      const messageRow = await db
        .prepare(
          `
          SELECT m.message_id,
                 m.folder_id,
                 m.org_id,
                 f.is_public AS folder_is_public
            FROM messages m
            JOIN folders f ON f.id = m.folder_id
           WHERE m.message_id = ?1
             AND m.org_id = ?2
        `
        )
        .bind(messageId, accessContext?.orgId || '')
        .first();
      if (!messageRow) {
        return errorResponse(
          404,
          allowedOrigin,
          requestId,
          'cf-api',
          'message_not_found',
          'メッセージが見つかりません。'
        );
      }
      if (orgId && messageRow.org_id && orgId !== messageRow.org_id) {
        return errorResponse(
          403,
          allowedOrigin,
          requestId,
          'cf-api',
          'forbidden',
          '他組織のメッセージにはアクセスできません。'
        );
      }
      const publicFolder = messageRow.folder_is_public === 1;
      const memberPublicQuery = `
          SELECT ms.membership_id,
                 ms.user_id,
                 u.email,
                 COALESCE(u.display_name, u.email) AS display_name
            FROM memberships ms
            JOIN users u ON u.user_id = ms.user_id
           WHERE ms.org_id = ?1
             AND LOWER(COALESCE(ms.status, 'active')) = 'active'
        `;
      const memberPrivateQuery = `
          SELECT ms.membership_id,
                 ms.user_id,
                 u.email,
                 COALESCE(u.display_name, u.email) AS display_name
            FROM memberships ms
            JOIN users u ON u.user_id = ms.user_id
           WHERE ms.org_id = ?1
             AND LOWER(COALESCE(ms.status, 'active')) = 'active'
             AND ms.user_id IN (
               SELECT user_id FROM folder_members WHERE folder_id = ?2
             )
        `;
      const memberStmt = publicFolder
        ? db.prepare(memberPublicQuery).bind(messageRow.org_id || orgId)
        : db.prepare(memberPrivateQuery).bind(messageRow.org_id || orgId, messageRow.folder_id);
      const memberResult = await memberStmt.all();
      const members = Array.isArray(memberResult?.results) ? memberResult.results : [];
      const readRows = await db
        .prepare(
          `
          SELECT membership_id
            FROM message_reads
           WHERE message_id = ?1
        `
        )
        .bind(messageId)
        .all();
      const readSet = new Set(
        (Array.isArray(readRows?.results) ? readRows.results : [])
          .map((row) => row?.membership_id)
          .filter(Boolean)
      );
      const unread = members
        .filter((row) => row?.membership_id && !readSet.has(row.membership_id))
        .map((row) => ({
          membershipId: row.membership_id,
          userId: row.user_id,
          email: row.email,
          name: row.display_name,
        }));
      return jsonResponseFromD1(
        200,
        {
          ok: true,
          success: true,
          result: {
            messageId,
            folderId: messageRow.folder_id,
            unread,
            totalCandidates: members.length,
            readCount: readSet.size,
          },
        },
        allowedOrigin,
        requestId
      );
    }
    if (normalizedRoute === 'getHomeContent') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
      const membershipId = membership?.membership_id || null;
      const assignedResult = await db
        .prepare(
          `
          SELECT DISTINCT t.*
            FROM tasks t
            JOIN task_assignees ta ON ta.task_id = t.task_id
           WHERE (?1 <> '' AND ta.email = ?1)
             AND t.org_id = ?2
        `
        )
        .bind(normalizedEmail || '', accessContext?.orgId || '')
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
      const upcomingWindowMs = 5 * 24 * 60 * 60 * 1000;
      const upcomingEndMs = todayMs + upcomingWindowMs;
      const todays = taskRecords
        .filter(
          (task) =>
            task &&
            !task.isCompleted &&
            task.dueValue != null &&
            task.dueValue <= upcomingEndMs
        )
        .sort((a, b) => {
          const dueA = a?.dueValue ?? Number.MAX_SAFE_INTEGER;
          const dueB = b?.dueValue ?? Number.MAX_SAFE_INTEGER;
          if (dueA !== dueB) return dueA - dueB;
          return compareTasksForList(a, b, todayMs);
        })
        .map((task) => ({
          id: task.id,
          title: task.title,
          dueDate: task.dueValue != null ? formatJst(task.dueValue, false) : '',
          priority: task.priority,
          assignees: task.assignees,
          assignee: task.assignee,
          status: task.status,
          isCompleted: task.isCompleted,
        }));
      const orgId = membership?.org_id || accessContext?.orgId || '';
      const messages = await buildMessagesForUser(db, {
        folderId: '',
        membershipId,
        orgId,
        userId: membership?.user_id || accessContext?.userId || '',
        isManager: isManagerRole(accessContext?.role),
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
                 storage_path,
                 created_by_membership_id
            FROM attachments
           WHERE attachment_id = ?1
             AND (org_id = ?2 OR org_id IS NULL)
        `
        )
        .bind(attachmentId, accessContext?.orgId || '')
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
      const normalizedEmail = normalizeEmailValue(tokenDetails?.email || accessContext?.email || '');
      const membership = normalizedEmail
        ? await resolveMembershipForEmail(db, normalizedEmail, accessContext?.orgId)
        : null;
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
        !attachmentOrgId ||
        attachmentOrgId !== membership.org_id
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
      let attachmentAllowed = isManagerRole(accessContext?.role);
      if (!attachmentAllowed && extras?.category === 'profile_image') {
        attachmentAllowed = true;
      }
      if (
        !attachmentAllowed &&
        attachmentRow.created_by_membership_id &&
        attachmentRow.created_by_membership_id === membership.membership_id
      ) {
        attachmentAllowed = true;
      }
      if (!attachmentAllowed) {
        const messageAccess = await db
          .prepare(
            `
            SELECT 1 AS allowed
              FROM message_attachments ma
              JOIN messages m ON m.message_id = ma.message_id
              JOIN folders f ON f.id = m.folder_id AND f.org_id = m.org_id
             WHERE ma.attachment_id = ?1
               AND m.org_id = ?2
               AND (
                 f.is_public = 1
                 OR EXISTS (
                   SELECT 1
                     FROM folder_members fm
                    WHERE fm.folder_id = f.id
                      AND fm.user_id = ?3
                 )
               )
             LIMIT 1
          `
          )
          .bind(attachmentId, membership.org_id, membership.user_id || '')
          .first();
        attachmentAllowed = !!messageAccess;
      }
      if (!attachmentAllowed) {
        const taskAccess = await db
          .prepare(
            `
            SELECT 1 AS allowed
              FROM task_attachments ta
              JOIN tasks t ON t.task_id = ta.task_id
             WHERE ta.attachment_id = ?1
               AND t.org_id = ?2
               AND (
                 LOWER(COALESCE(t.created_by_email, '')) = ?3
                 OR EXISTS (
                   SELECT 1
                     FROM task_assignees tas
                    WHERE tas.task_id = t.task_id
                      AND LOWER(COALESCE(tas.email, '')) = ?3
                 )
               )
             LIMIT 1
          `
          )
          .bind(attachmentId, membership.org_id, normalizedEmail)
          .first();
        attachmentAllowed = !!taskAccess;
      }
      if (!attachmentAllowed) {
        return errorResponse(
          403,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_forbidden',
          '添付ファイルにアクセスする権限がありません。'
        );
      }
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
      if (!isR2KeyWithinOrg(r2Key, attachmentOrgId)) {
        captureDiagnostics(config, 'error', 'attachment_storage_scope_mismatch', {
          event: 'attachment_storage_scope_mismatch',
          requestId,
          route: normalizedRoute,
          orgId: attachmentOrgId,
          userId: membership.user_id || '',
          targetId: attachmentId,
          detail: 'attachment_storage_scope_mismatch',
        });
        return errorResponse(
          409,
          originForResponses,
          requestId,
          'cf-api',
          'attachment_storage_scope_mismatch',
          '添付ファイルの保存先情報が一致しません。管理者にお問い合わせください。'
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
          reasonCode: 'attachment_r2_read_failed',
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
          reasonCode: 'attachment_r2_object_missing',
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
        'Content-Type': mimeType === 'image/svg+xml' ? 'application/octet-stream' : mimeType,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': buildContentDisposition(
          fileName,
          mimeType === 'image/svg+xml' ? 'attachment' : 'inline'
        ),
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
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
    const failureCode =
      err?.isShiftFlowServiceError === true &&
      typeof err.code === 'string' &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(err.code)
        ? err.code
        : 'd1_route_failed';
    const failureStatus =
      err?.isShiftFlowServiceError === true && Number(err?.httpStatus) >= 500
        ? Number(err.httpStatus)
        : 500;
    console.error('[ShiftFlow][D1] Route handling failed', {
      route: normalizedRoute,
      requestId,
      reasonCode: failureCode,
    });
    captureDiagnostics(config, 'error', failureCode, {
      event: failureCode,
      route: normalizedRoute,
      requestId,
      detail: failureCode,
      httpStatus: failureStatus,
      email: tokenDetails?.email || accessContext?.email || '',
      orgId: accessContext?.orgId || '',
      userId: accessContext?.userId || '',
    });
    return errorResponse(
      failureStatus,
      allowedOrigin || config?.allowedOrigins?.[0] || '*',
      requestId,
      'cf-api',
      failureCode,
      '処理を完了できませんでした。画面を更新して状態を確認してから再試行してください。'
    );
  }
  return null;
}


function buildMessageInsertStatement(db, context) {
  if (!db || !context?.messageId || !context?.orgId) return null;
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();
  const requiredStages = Array.isArray(context.requiredStagedAttachments)
    ? context.requiredStagedAttachments
        .map((row) => normalizeIdValue(row?.staged_attachment_id))
        .filter(Boolean)
    : [];
  const bindValues = [
    context.messageId,
    context.orgId,
    typeof payload.folderId === 'string' ? payload.folderId : null,
    context.membershipId || null,
    typeof payload.title === 'string' ? payload.title : '',
    typeof payload.body === 'string' ? payload.body : '',
    timestampMs,
    timestampMs,
  ];
  let valueClause = 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)';
  if (requiredStages.length) {
    const stagePlaceholders = requiredStages
      .map((_, index) => `?${index + 9}`)
      .join(', ');
    const ownerUserIndex = requiredStages.length + 9;
    const ownerMembershipIndex = ownerUserIndex + 1;
    const requiredCountIndex = ownerMembershipIndex + 1;
    valueClause = `
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
       WHERE (
         SELECT COUNT(*)
           FROM staged_attachments staged
          WHERE staged.staged_attachment_id IN (${stagePlaceholders})
            AND staged.org_id = ?2
            AND staged.owner_user_id = ?${ownerUserIndex}
            AND staged.owner_membership_id = ?${ownerMembershipIndex}
            AND staged.purpose = 'message'
            AND (
              (staged.status = 'ready' AND staged.expires_at_ms > ?7)
              OR
              (staged.status = 'claimed'
                AND staged.claimed_target_type = 'message'
                AND staged.claimed_target_id = ?1)
            )
            AND NOT EXISTS (
              SELECT 1
                FROM storage_cleanup_jobs cleanup_guard
               WHERE cleanup_guard.r2_key = staged.r2_key
                 AND cleanup_guard.org_id = staged.org_id
                 AND cleanup_guard.lease_token IS NOT NULL
            )
       ) = ?${requiredCountIndex}`;
    bindValues.push(
      ...requiredStages,
      normalizeIdValue(context.ownerUserId),
      normalizeIdValue(context.membershipId),
      requiredStages.length
    );
  }
  return db
    .prepare(
      `
      INSERT OR IGNORE INTO messages (
        message_id,
        org_id,
        folder_id,
        author_membership_id,
        title,
        body,
        created_at_ms,
        updated_at_ms
      )
      ${valueClause}
    `
    )
    .bind(...bindValues);
}

async function resolveTaskAccess(db, context = {}) {
  const taskId = normalizeIdValue(context.taskId);
  const orgId = normalizeIdValue(context.orgId);
  if (!db || !taskId || !orgId) return null;
  const actorEmail = normalizeEmailValue(context.actorEmail || '');
  const actorMembership = actorEmail
    ? await resolveMembershipForEmail(db, actorEmail, orgId)
    : null;
  const row = await db
    .prepare(
      `
      SELECT t.*,
             CASE
               WHEN ?3 <> '' AND LOWER(COALESCE(t.created_by_email, '')) = ?3 THEN 1
               WHEN ?4 <> '' AND t.created_by_membership_id = ?4 THEN 1
               ELSE 0
             END AS is_creator,
             CASE WHEN EXISTS (
               SELECT 1
                 FROM task_assignees ta
                WHERE ta.task_id = t.task_id
                  AND (
                    (?4 <> '' AND ta.membership_id = ?4)
                    OR (?3 <> '' AND LOWER(COALESCE(ta.email, '')) = ?3)
                  )
             ) THEN 1 ELSE 0 END AS is_assignee
        FROM tasks t
       WHERE t.task_id = ?1
         AND t.org_id = ?2
       LIMIT 1
    `
    )
    .bind(taskId, orgId, actorEmail, actorMembership?.membership_id || '')
    .first();
  if (!row) return null;
  const isManager = isManagerRole(context.role);
  const isCreator = row.is_creator === 1;
  const isAssignee = row.is_assignee === 1;
  return {
    row,
    actorEmail,
    actorMembership,
    isManager,
    isCreator,
    isAssignee,
    canRead: isManager || isCreator || isAssignee,
    canUpdate: isManager || isCreator || isAssignee,
    canComplete: isManager || isCreator || isAssignee,
    canDelete: isManager || isCreator,
  };
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
  const membership = creatorEmail
    ? await resolveMembershipForEmail(db, creatorEmail, context.orgId || '')
    : null;
  const orgId = normalizeIdValue(context.orgId || membership?.org_id || '');
  if (!orgId) {
    throw createServiceUnavailableError(
      'd1_unavailable',
      'Task organization scope is unavailable.'
    );
  }
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

  const statements = [
    db
    .prepare(
      `
      INSERT OR IGNORE INTO tasks (
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
    ),
  ];

  if (context.audit) {
    statements.push(
      buildAuditLogStatement(db, {
        ...context.audit,
        orgId,
        actorMembershipId: membership?.membership_id || null,
        targetId: context.taskId,
        createdAtMs: timestampMs,
        requestId: context.requestId || null,
        onlyIfPreviousStatementChanged: true,
      })
    );
  }

  const assigneeEmails = deriveTaskAssigneeEmails(payload, creatorEmail);
  for (const email of assigneeEmails) {
    const normalized = normalizeEmailValue(email);
    if (!normalized) continue;
    const membership = await resolveMembershipForEmail(db, normalized, orgId);
    statements.push(
      db.prepare(
        `
        INSERT OR IGNORE INTO task_assignees (
          task_id,
          email,
          membership_id,
          assigned_at_ms
        )
        VALUES (?1, ?2, ?3, ?4)
      `
      )
      .bind(context.taskId, normalized, membership?.membership_id || null, createdAtMs)
    );
  }
  statements.push(await buildPushEventStatement(db, { ...context.notification, kind: 'task_assigned',
    resourceId: context.taskId, folderId: folderId, auditAction: context.audit?.action }));
  await db.batch(statements.filter(Boolean));
  return { orgId, actorMembershipId: membership?.membership_id || null };
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
             meta_json,
             org_id
      FROM tasks
      WHERE task_id = ?1
        AND org_id = ?2
    `
    )
    .bind(context.taskId, context.orgId || '')
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

  const statements = [
    db.prepare(
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
         AND org_id = ?10
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
      mergedMetaJson,
      context.orgId || ''
    ),
  ];

  const assigneeChanged =
    Array.isArray(payload.assignees) ||
    typeof payload.assignee === 'string' ||
    typeof payload.assigneeEmail === 'string' ||
    typeof payload.assigneeEmails === 'string';
  const newlyAssignedUserIds = [];
  if (assigneeChanged) {
    const previousAssignees = context.notification?.enabled
      ? await db.prepare('SELECT email FROM task_assignees WHERE task_id=?1').bind(context.taskId).all() : { results: [] };
    const previousEmails = new Set((previousAssignees.results || []).map(row => normalizeEmailValue(row.email)));
    const assigneeEmails = deriveTaskAssigneeEmails(payload, null);
    statements.push(
      db.prepare('DELETE FROM task_assignees WHERE task_id = ?1').bind(context.taskId)
    );
    for (const email of assigneeEmails) {
      const normalized = normalizeEmailValue(email);
      if (!normalized) continue;
      const assigneeMembership = await resolveMembershipForEmail(
        db,
        normalized,
        context.orgId || existing.org_id || ''
      );
      if (assigneeMembership?.user_id && !previousEmails.has(normalized)) newlyAssignedUserIds.push(assigneeMembership.user_id);
      statements.push(
        db
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
          .bind(
            context.taskId,
            normalized,
            assigneeMembership?.membership_id || null,
            timestampMs
          )
      );
    }
  }
  if (context.audit) {
    const actorMembership = context.actorEmail
      ? await resolveMembershipForEmail(db, normalizeEmailValue(context.actorEmail), context.orgId || '')
      : null;
    statements.push(
      buildAuditLogStatement(db, {
        ...context.audit,
        orgId: context.orgId || existing.org_id || '',
        actorMembershipId: actorMembership?.membership_id || null,
        targetId: context.taskId,
        createdAtMs: timestampMs,
        requestId: context.requestId || null,
      })
    );
  }
  statements.push(await buildPushEventStatement(db, { ...context.notification, kind: 'task_updated',
    resourceId: context.taskId, folderId: nextFolderId, auditAction: context.audit?.action, excludedUserIds: newlyAssignedUserIds }));
  if (newlyAssignedUserIds.length) statements.push(await buildPushEventStatement(db, { ...context.notification, kind: 'task_assigned',
    resourceId: context.taskId, folderId: nextFolderId, auditAction: context.audit?.action, recipientUserIds: newlyAssignedUserIds }));
  await db.batch(statements.filter(Boolean));
}

async function completeTaskInD1(db, context) {
  if (!context?.taskId) return;
  const timestampMs = context.timestampMs || Date.now();
  const completedStatus = mapTaskStatus('完了');
  const statements = [
    db.prepare(
      `
      UPDATE tasks
         SET status = ?2,
             updated_at_ms = ?3
       WHERE task_id = ?1
         AND org_id = ?4
         AND COALESCE(status, '') <> ?2
    `
    )
    .bind(context.taskId, completedStatus, timestampMs, context.orgId || ''),
  ];
  if (context.audit) {
    const actorMembership = context.actorEmail
      ? await resolveMembershipForEmail(db, normalizeEmailValue(context.actorEmail), context.orgId || '')
      : null;
    statements.push(
      buildAuditLogStatement(db, {
        ...context.audit,
        orgId: context.orgId || '',
        actorMembershipId: actorMembership?.membership_id || null,
        targetId: context.taskId,
        createdAtMs: timestampMs,
        requestId: context.requestId || null,
        onlyIfPreviousStatementChanged: true,
      })
    );
  }
  statements.push(await buildPushEventStatement(db, { ...context.notification, kind: 'task_updated',
    resourceId: context.taskId, folderId: context.notification?.folderId, auditAction: context.audit?.action }));
  await db.batch(statements.filter(Boolean));
}

function buildMemoReadUpsertStatement(db, context) {
  if (!db || !context?.messageId || !context?.membershipId) return null;
  return db
    .prepare(
      `
      INSERT INTO message_reads (
        message_read_id,
        message_id,
        membership_id,
        read_at_ms
      )
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(message_id, membership_id)
      DO UPDATE SET read_at_ms = excluded.read_at_ms
      WHERE message_reads.read_at_ms < excluded.read_at_ms
    `
    )
    .bind(
      generateMessageId(),
      context.messageId,
      context.membershipId,
      context.timestampMs || Date.now()
    );
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
  const membership = await resolveMembershipForEmail(db, email, context.orgId || '');
  if (!membership || !membership.membership_id) {
    logAuthInfo('Membership not found for memo read toggle', {
      messageId: context.messageId,
      email,
    });
    return;
  }
  const messageRow = await db
    .prepare('SELECT message_id FROM messages WHERE message_id = ?1 AND org_id = ?2')
    .bind(context.messageId, membership.org_id)
    .first();
  if (!messageRow) return;
  const membershipId = membership.membership_id;
  if (context.shouldRead) {
    const statement = buildMemoReadUpsertStatement(db, {
      messageId: context.messageId,
      membershipId,
      timestampMs: context.timestampMs,
    });
    if (statement) {
      await statement.run();
    }
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
    orgId: context.orgId,
  });
}

async function bulkEnsureMemoReadInD1(db, context) {
  if (!context || !Array.isArray(context.messageIds) || !context.messageIds.length) return;
  const email = normalizeEmailValue(context.email);
  const membership = email
    ? await resolveMembershipForEmail(db, email, context.orgId || '')
    : null;
  if (!membership?.membership_id) {
    return;
  }
  const statements = context.messageIds
    .map((messageId) =>
      buildMemoReadUpsertStatement(db, {
        messageId,
        membershipId: membership.membership_id,
        timestampMs: context.timestampMs,
      })
    )
    .filter(Boolean);
  if (statements.length) {
    await db.batch(statements);
  }
}

function normalizeR2CleanupKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return Array.from(
    new Set(
      keys
        .filter((key) => typeof key === 'string' && key.trim())
        .map((key) => key.trim())
    )
  );
}

function isR2KeyWithinOrg(r2Key, orgId) {
  const normalizedKey = typeof r2Key === 'string' ? r2Key.trim() : '';
  const normalizedOrgId = normalizeIdValue(orgId);
  if (
    !normalizedKey ||
    !normalizedOrgId ||
    !/^[A-Za-z0-9_-]+$/.test(normalizedOrgId)
  ) {
    return false;
  }
  return normalizedKey.startsWith(`orgs/${normalizedOrgId}/`);
}

function buildStorageCleanupJobStatement(db, r2Key, context = {}) {
  if (!db || !r2Key) return null;
  const now = Date.now();
  const cleanupErrorCode = context.failed
    ? context.errorCode === 'r2_unavailable'
      ? 'r2_unavailable'
      : 'r2_delete_failed'
    : null;
  const attempts = context.failed ? 1 : 0;
  const profileState =
    context.requiredProfileState && typeof context.requiredProfileState === 'object'
      ? context.requiredProfileState
      : null;
  const requiredUserId = normalizeIdValue(profileState?.userId);
  const requiredSettingsVersion = normalizeSettingsVersion(profileState?.settingsVersion);
  const requiredImageUrl =
    typeof profileState?.imageUrl === 'string' ? profileState.imageUrl : '';
  let valueClause = 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)';
  if (requiredUserId && requiredSettingsVersion) {
    valueClause = `
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
       WHERE EXISTS (
         SELECT 1
           FROM users
          WHERE user_id = ?11
            AND settings_version = ?12
            AND COALESCE(profile_image_url, '') = ?13
       )`;
  } else if (context.onlyIfPreviousStatementChanged) {
    valueClause =
      'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10 WHERE changes() > 0';
  }
  const bindValues = [
    createUlid(now),
    r2Key,
    context.orgId || null,
    context.targetType || null,
    context.targetId || null,
    context.reason || 'orphaned_r2_object',
    context.requestId || null,
    attempts,
    cleanupErrorCode,
    now,
  ];
  if (requiredUserId && requiredSettingsVersion) {
    bindValues.push(requiredUserId, requiredSettingsVersion, requiredImageUrl);
  }
  return db
    .prepare(
      `
      INSERT INTO storage_cleanup_jobs (
        job_id,
        r2_key,
        org_id,
        target_type,
        target_id,
        reason,
        request_id,
        attempts,
        last_error,
        created_at_ms,
        updated_at_ms
      )
      ${valueClause}
      ON CONFLICT(r2_key) DO UPDATE SET
        org_id = COALESCE(excluded.org_id, storage_cleanup_jobs.org_id),
        target_type = COALESCE(excluded.target_type, storage_cleanup_jobs.target_type),
        target_id = COALESCE(excluded.target_id, storage_cleanup_jobs.target_id),
        reason = excluded.reason,
        request_id = COALESCE(excluded.request_id, storage_cleanup_jobs.request_id),
        attempts = storage_cleanup_jobs.attempts + excluded.attempts,
        last_error = COALESCE(excluded.last_error, storage_cleanup_jobs.last_error),
        updated_at_ms = excluded.updated_at_ms
    `
    )
    .bind(...bindValues);
}

async function clearStorageCleanupJobs(db, keys) {
  const normalizedKeys = normalizeR2CleanupKeys(keys);
  if (!db || !normalizedKeys.length) return;
  const placeholders = normalizedKeys.map((_, index) => `?${index + 1}`).join(', ');
  await db
    .prepare(`DELETE FROM storage_cleanup_jobs WHERE r2_key IN (${placeholders})`)
    .bind(...normalizedKeys)
    .run();
}

async function queueR2CleanupCandidates(db, keys, context = {}) {
  const normalizedKeys = normalizeR2CleanupKeys(keys);
  if (!db || !normalizedKeys.length) return true;
  try {
    await db.batch(
      normalizedKeys
        .map((key) =>
          buildStorageCleanupJobStatement(db, key, {
            orgId: context.orgId || '',
            targetType: context.targetType || null,
            targetId: context.targetId || null,
            reason: context.reason || 'upload_commit_unknown',
            requestId: context.requestId || '',
          })
        )
        .filter(Boolean)
    );
    return true;
  } catch (_error) {
    captureDiagnostics(context.config || {}, 'error', 'r2_cleanup_candidate_queue_failed', {
      event: 'r2_cleanup_candidate_queue_failed',
      requestId: context.requestId || '',
      orgId: context.orgId || '',
      targetType: context.targetType || '',
      targetId: context.targetId || '',
      count: normalizedKeys.length,
      detail: 'r2_cleanup_candidate_queue_failed',
    });
    return false;
  }
}

async function cleanupR2KeysWithOutbox(db, env, keys, context = {}) {
  const normalizedKeys = normalizeR2CleanupKeys(keys);
  if (!normalizedKeys.length) return true;
  if (
    context?.retryJob &&
    normalizedKeys.length === 1 &&
    normalizedKeys[0] === context.retryJob.r2_key
  ) {
    return retryStorageCleanupJob(db, env, context.retryJob);
  }
  const cleanupOrgId = normalizeIdValue(context.orgId || context.retryJob?.org_id || '');
  const blockedKeys = normalizedKeys.filter(
    (key) => !isR2KeyWithinOrg(key, cleanupOrgId)
  );
  let deleteKeys = normalizedKeys.filter((key) => isR2KeyWithinOrg(key, cleanupOrgId));
  if (blockedKeys.length) {
    try {
      const placeholders = blockedKeys.map((_, index) => `?${index + 2}`).join(', ');
      if (db && placeholders) {
        await db
          .prepare(
            `
            UPDATE storage_cleanup_jobs
               SET last_error = 'cleanup_scope_mismatch'
             WHERE org_id = ?1
               AND r2_key IN (${placeholders})
          `
          )
          .bind(cleanupOrgId || '', ...blockedKeys)
          .run();
      }
    } catch (_error) {
      // 不正scopeのobjectを削除しないことを優先し、診断は下で必ず残す。
    }
    captureDiagnostics(context.config || {}, 'error', 'r2_cleanup_scope_mismatch', {
      event: 'r2_cleanup_scope_mismatch',
      requestId: context.requestId || '',
      orgId: cleanupOrgId,
      targetType: context.targetType || '',
      targetId: context.targetId || '',
      count: blockedKeys.length,
      detail: 'cleanup_scope_mismatch',
    });
  }
  if (!deleteKeys.length) return false;
  try {
    const liveKeys = [];
    const activeStageKeys = [];
    const orphanKeys = [];
    for (const key of deleteKeys) {
      if (await hasLiveAttachmentForR2Key(db, key)) {
        liveKeys.push(key);
      } else if (await hasActiveStagedAttachmentForR2Key(db, key, Date.now())) {
        activeStageKeys.push(key);
      } else {
        orphanKeys.push(key);
      }
    }
    deleteKeys = orphanKeys;
    if (liveKeys.length) {
      try {
        await clearStorageCleanupJobs(db, liveKeys);
      } catch (_error) {
        // jobが残ってもretry側がlive参照を再確認するため、R2 objectは削除されない。
        console.warn('[ShiftFlow][R2] Live cleanup candidates could not be resolved', {
          requestId: context.requestId || '',
          count: liveKeys.length,
          reasonCode: 'live_cleanup_outbox_clear_failed',
        });
      }
    }
    if (!deleteKeys.length) {
      return blockedKeys.length === 0 && activeStageKeys.length === 0;
    }
    if (!env?.R2) {
      const unavailable = new Error('R2 bucket is not configured.');
      unavailable.code = 'r2_unavailable';
      throw unavailable;
    }
    // D1確認とR2削除は同一transactionにできないため、物理削除の直前にも再確認する。
    const stillOrphanKeys = [];
    for (const key of deleteKeys) {
      if (await hasLiveAttachmentForR2Key(db, key)) {
        await clearStorageCleanupJobs(db, [key]);
      } else if (await hasActiveStagedAttachmentForR2Key(db, key, Date.now())) {
        if (!activeStageKeys.includes(key)) activeStageKeys.push(key);
      } else {
        stillOrphanKeys.push(key);
      }
    }
    deleteKeys = stillOrphanKeys;
    if (!deleteKeys.length) {
      return blockedKeys.length === 0 && activeStageKeys.length === 0;
    }
    await env.R2.delete(deleteKeys);
    // stage metadataは有効なidempotency世代のtombstoneとして残す。
    try {
      await clearStorageCleanupJobs(db, deleteKeys);
    } catch (clearError) {
      console.warn('[ShiftFlow][R2] Object cleanup succeeded but outbox cleanup failed', {
        requestId: context.requestId || '',
        count: deleteKeys.length,
        reasonCode: 'cleanup_outbox_clear_failed',
      });
    }
    return blockedKeys.length === 0 && activeStageKeys.length === 0;
  } catch (error) {
    const errorCode = error?.code === 'r2_unavailable' ? 'r2_unavailable' : 'r2_delete_failed';
    const statements = deleteKeys.map((key) =>
      buildStorageCleanupJobStatement(db, key, {
        ...context,
        failed: true,
        errorCode,
      })
    );
    try {
      await db.batch(statements.filter(Boolean));
    } catch (outboxError) {
      console.error('[ShiftFlow][R2] Failed to persist cleanup outbox', {
        requestId: context.requestId || '',
        count: deleteKeys.length,
        reasonCode: 'cleanup_outbox_persist_failed',
      });
    }
    captureDiagnostics(context.config || {}, 'error', 'r2_cleanup_pending', {
      event: 'r2_cleanup_pending',
      requestId: context.requestId || '',
      orgId: context.orgId || '',
      targetType: context.targetType || '',
      targetId: context.targetId || '',
      count: deleteKeys.length,
      detail: errorCode,
    });
    return false;
  }
}

async function hasLiveAttachmentForR2Key(db, r2Key) {
  if (!db || !r2Key) return false;
  const row = await db
    .prepare(
      `
      SELECT attachment_id
        FROM attachments
       WHERE CASE
               WHEN JSON_VALID(COALESCE(extra_json, '')) = 1
               THEN JSON_EXTRACT(extra_json, '$.r2Key')
               ELSE NULL
             END = ?1
       LIMIT 1
    `
    )
    .bind(r2Key)
    .first();
  return Boolean(row?.attachment_id);
}

async function hasActiveStagedAttachmentForR2Key(db, r2Key, now = Date.now()) {
  if (!db || !r2Key) return false;
  const row = await db
    .prepare(
      `
      SELECT staged_attachment_id
        FROM staged_attachments
       WHERE r2_key = ?1
         AND status IN ('uploading', 'ready')
         AND expires_at_ms > ?2
       LIMIT 1
    `
    )
    .bind(r2Key, now)
    .first();
  return Boolean(row?.staged_attachment_id);
}

async function findUnselectedR2UploadKeys(db, uploads, orgId) {
  const normalizedOrgId = normalizeIdValue(orgId);
  const candidates = Array.isArray(uploads)
    ? uploads
        .map((upload) => ({
          attachmentId: normalizeIdValue(upload?.attachmentId),
          r2Key: typeof upload?.r2Key === 'string' ? upload.r2Key.trim() : '',
        }))
        .filter((upload) => upload.attachmentId && upload.r2Key)
    : [];
  if (!db || !normalizedOrgId || !candidates.length) return [];
  const attachmentIds = Array.from(new Set(candidates.map((upload) => upload.attachmentId)));
  const placeholders = attachmentIds.map((_, index) => `?${index + 2}`).join(', ');
  const result = await db
    .prepare(
      `
      SELECT attachment_id,
             extra_json
        FROM attachments
       WHERE org_id = ?1
         AND attachment_id IN (${placeholders})
    `
    )
    .bind(normalizedOrgId, ...attachmentIds)
    .all();
  const selectedKeys = new Map();
  const rows = Array.isArray(result?.results) ? result.results : [];
  for (const row of rows) {
    const attachmentId = normalizeIdValue(row?.attachment_id);
    const extra = safeParseJson(row?.extra_json || null, {});
    const selectedKey = typeof extra?.r2Key === 'string' ? extra.r2Key.trim() : '';
    if (attachmentId && selectedKey) {
      selectedKeys.set(attachmentId, selectedKey);
    }
  }
  // レコード欠落や不正extra_json時は削除候補にしない。DB上で別keyの採用を
  // 明確に確認できたputだけをloserとして回収する。
  return normalizeR2CleanupKeys(
    candidates
      .filter((upload) => {
        const selectedKey = selectedKeys.get(upload.attachmentId);
        return selectedKey && selectedKey !== upload.r2Key;
      })
      .map((upload) => upload.r2Key)
  );
}

async function retryStorageCleanupJob(db, env, job) {
  const jobId = normalizeIdValue(job?.job_id || '');
  const orgId = normalizeIdValue(job?.org_id || '');
  const r2Key = typeof job?.r2_key === 'string' ? job.r2_key.trim() : '';
  if (!db || !jobId || !orgId || !r2Key) {
    return {
      jobId,
      status: 'retry_pending',
      errorCode: 'cleanup_job_invalid',
      outcome: 'pending',
    };
  }
  if (!isR2KeyWithinOrg(r2Key, orgId)) {
    await db
      .prepare(
        `
        UPDATE storage_cleanup_jobs
           SET last_error = 'cleanup_scope_mismatch'
         WHERE job_id = ?1
           AND org_id = ?2
           AND r2_key = ?3
      `
      )
      .bind(jobId, orgId, r2Key)
      .run();
    return {
      jobId,
      status: 'blocked_scope_mismatch',
      errorCode: 'cleanup_scope_mismatch',
      outcome: 'blocked',
    };
  }

  const leaseToken = crypto.randomUUID();
  const claimedAtMs = Date.now();
  const claimResult = await db
    .prepare(
      `
      UPDATE storage_cleanup_jobs
         SET lease_token = ?5,
             lease_expires_at_ms = ?6,
             updated_at_ms = ?7
       WHERE job_id = ?1
         AND org_id = ?2
         AND r2_key = ?3
         AND updated_at_ms = ?4
         AND (lease_token IS NULL OR lease_expires_at_ms <= ?7)
    `
    )
    .bind(
      jobId,
      orgId,
      r2Key,
      Number(job.updated_at_ms || 0),
      leaseToken,
      claimedAtMs + STORAGE_CLEANUP_LEASE_MS,
      claimedAtMs
    )
    .run();
  if (Number(claimResult?.meta?.changes || 0) === 0) {
    return {
      jobId,
      status: 'retry_pending',
      errorCode: 'retry_already_claimed',
      outcome: 'pending',
    };
  }

  const resolveLiveReference = async () => {
    const resolved = await db
      .prepare(
        `
        DELETE FROM storage_cleanup_jobs
         WHERE job_id = ?1
           AND org_id = ?2
           AND r2_key = ?3
           AND lease_token = ?4
           AND updated_at_ms = ?5
      `
      )
      .bind(jobId, orgId, r2Key, leaseToken, claimedAtMs)
      .run();
    return Number(resolved?.meta?.changes || 0) > 0;
  };

  const deferActiveStage = async () => {
    const released = await db
      .prepare(
        `
        UPDATE storage_cleanup_jobs
           SET lease_token = NULL,
               lease_expires_at_ms = NULL,
               last_error = 'staged_attachment_unexpired'
         WHERE job_id = ?1
           AND org_id = ?2
           AND r2_key = ?3
           AND lease_token = ?4
           AND updated_at_ms = ?5
      `
      )
      .bind(jobId, orgId, r2Key, leaseToken, claimedAtMs)
      .run();
    return Number(released?.meta?.changes || 0) > 0;
  };

  if (await hasActiveStagedAttachmentForR2Key(db, r2Key, Date.now())) {
    const deferred = await deferActiveStage();
    return deferred
      ? {
          jobId,
          status: 'deferred_active_stage',
          errorCode: 'staged_attachment_unexpired',
          outcome: 'pending',
        }
      : {
          jobId,
          status: 'retry_pending',
          errorCode: 'retry_state_changed',
          outcome: 'pending',
        };
  }

  if (await hasLiveAttachmentForR2Key(db, r2Key)) {
    const resolved = await resolveLiveReference();
    return resolved
      ? {
          jobId,
          status: 'resolved_live_reference',
          errorCode: 'live_attachment_reference',
          outcome: 'resolved',
        }
      : {
          jobId,
          status: 'retry_pending',
          errorCode: 'retry_state_changed',
          outcome: 'pending',
        };
  }

  // D1とR2は同一transactionにできないため、物理削除直前にもadoptionを再確認する。
  if (await hasActiveStagedAttachmentForR2Key(db, r2Key, Date.now())) {
    const deferred = await deferActiveStage();
    return deferred
      ? {
          jobId,
          status: 'deferred_active_stage',
          errorCode: 'staged_attachment_unexpired',
          outcome: 'pending',
        }
      : {
          jobId,
          status: 'retry_pending',
          errorCode: 'retry_state_changed',
          outcome: 'pending',
        };
  }
  if (await hasLiveAttachmentForR2Key(db, r2Key)) {
    const resolved = await resolveLiveReference();
    return resolved
      ? {
          jobId,
          status: 'resolved_live_reference',
          errorCode: 'live_attachment_reference',
          outcome: 'resolved',
        }
      : {
          jobId,
          status: 'retry_pending',
          errorCode: 'retry_state_changed',
          outcome: 'pending',
        };
  }

  try {
    await env.R2.delete([r2Key]);
  } catch (_error) {
    const updateResult = await db
      .prepare(
        `
        UPDATE storage_cleanup_jobs
           SET attempts = attempts + 1,
               last_error = 'r2_delete_failed',
               lease_token = NULL,
               lease_expires_at_ms = NULL,
               updated_at_ms = ?6
         WHERE job_id = ?1
           AND org_id = ?2
           AND r2_key = ?3
           AND lease_token = ?4
           AND updated_at_ms = ?5
      `
      )
      .bind(jobId, orgId, r2Key, leaseToken, claimedAtMs, Date.now())
      .run();
    return Number(updateResult?.meta?.changes || 0) > 0
      ? {
          jobId,
          status: 'retry_pending',
          errorCode: 'r2_delete_failed',
          outcome: 'pending',
        }
      : {
          jobId,
          status: 'retry_pending',
          errorCode: 'retry_state_changed',
          outcome: 'pending',
        };
  }

  const cleanupResults = await db.batch([
    db
      .prepare(
        `
        DELETE FROM storage_cleanup_jobs
         WHERE job_id = ?1
           AND org_id = ?2
           AND r2_key = ?3
           AND lease_token = ?4
           AND updated_at_ms = ?5
      `
      )
      .bind(jobId, orgId, r2Key, leaseToken, claimedAtMs),
  ]);
  const deleted = cleanupResults[0];
  if (Number(deleted?.meta?.changes || 0) > 0) {
    return { jobId, status: 'deleted', outcome: 'deleted' };
  }
  const current = await db
    .prepare('SELECT job_id FROM storage_cleanup_jobs WHERE job_id = ?1 LIMIT 1')
    .bind(jobId)
    .first();
  return current?.job_id
    ? {
        jobId,
        status: 'retry_pending',
        errorCode: 'retry_state_changed_after_delete',
        outcome: 'pending',
      }
    : { jobId, status: 'deleted', outcome: 'deleted' };
}

async function deleteTaskFromD1(db, env, context) {
  if (!context?.taskId) return;
  const taskId = normalizeIdValue(context.taskId);
  if (!taskId) return;
  const ownedTask = await db
    .prepare('SELECT task_id FROM tasks WHERE task_id = ?1 AND org_id = ?2')
    .bind(taskId, context.orgId || '')
    .first();
  if (!ownedTask) return;
  const attachmentResult = await db
    .prepare(
      `
      SELECT a.attachment_id,
             a.extra_json
        FROM task_attachments ta
        JOIN attachments a ON a.attachment_id = ta.attachment_id
       WHERE ta.task_id = ?1
         AND a.org_id = ?2
         AND NOT EXISTS (
           SELECT 1
             FROM task_attachments other_task_attachment
            WHERE other_task_attachment.attachment_id = a.attachment_id
              AND other_task_attachment.task_id <> ?1
         )
         AND NOT EXISTS (
           SELECT 1
             FROM message_attachments other_message_attachment
            WHERE other_message_attachment.attachment_id = a.attachment_id
         )
    `
    )
    .bind(taskId, context.orgId || '')
    .all();
  const attachmentRows = Array.isArray(attachmentResult?.results) ? attachmentResult.results : [];
  const attachmentIds = attachmentRows
    .map((row) => normalizeIdValue(row?.attachment_id))
    .filter(Boolean);
  const r2Keys = attachmentRows
    .map((row) => safeParseJson(row?.extra_json || null, {})?.r2Key)
    .filter((key) => typeof key === 'string' && key.trim())
    .map((key) => key.trim());
  const statements = [
    db.prepare('DELETE FROM task_assignees WHERE task_id = ?1').bind(taskId),
    db.prepare('DELETE FROM task_attachments WHERE task_id = ?1').bind(taskId),
  ];
  if (attachmentIds.length) {
    const placeholders = attachmentIds.map((_, index) => `?${index + 2}`).join(', ');
    statements.push(
      db
        .prepare(
          `
          DELETE FROM attachments
           WHERE org_id = ?1
             AND attachment_id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1
                 FROM task_attachments remaining_task_attachment
                WHERE remaining_task_attachment.attachment_id = attachments.attachment_id
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM message_attachments remaining_message_attachment
                WHERE remaining_message_attachment.attachment_id = attachments.attachment_id
             )
        `
        )
        .bind(context.orgId || '', ...attachmentIds)
    );
  }
  const cleanupKeys = normalizeR2CleanupKeys(r2Keys);
  cleanupKeys.forEach((key) => {
    statements.push(
      buildStorageCleanupJobStatement(db, key, {
        orgId: context.orgId || '',
        targetType: 'task',
        targetId: taskId,
        reason: 'task_deleted',
        requestId: context.requestId || '',
      })
    );
  });
  statements.push(
    db.prepare('DELETE FROM tasks WHERE task_id = ?1 AND org_id = ?2').bind(taskId, context.orgId || '')
  );
  if (context.audit) {
    const actorMembership = context.actorEmail
      ? await resolveMembershipForEmail(db, normalizeEmailValue(context.actorEmail), context.orgId || '')
      : null;
    statements.push(
      buildAuditLogStatement(db, {
        ...context.audit,
        orgId: context.orgId || '',
        actorMembershipId: actorMembership?.membership_id || null,
        targetId: taskId,
        requestId: context.requestId || null,
        onlyIfPreviousStatementChanged: true,
      })
    );
  }
  await db.batch(statements.filter(Boolean));
  await cleanupR2KeysWithOutbox(db, env, cleanupKeys, {
    orgId: context.orgId || '',
    targetType: 'task',
    targetId: taskId,
    reason: 'task_deleted',
    requestId: context.requestId || '',
    config: context.config,
  });
}

async function deleteMessageFromD1(db, env, context) {
  if (!context?.messageId) return;
  const messageId = normalizeIdValue(context.messageId);
  if (!messageId) return;
  const ownedMessage = await db
    .prepare('SELECT message_id FROM messages WHERE message_id = ?1 AND org_id = ?2')
    .bind(messageId, context.orgId || '')
    .first();
  if (!ownedMessage) return;
  const attachmentResult = await db
    .prepare(
      `
      SELECT a.attachment_id,
             a.extra_json
        FROM message_attachments ma
        JOIN attachments a ON a.attachment_id = ma.attachment_id
       WHERE ma.message_id = ?1
         AND a.org_id = ?2
         AND NOT EXISTS (
           SELECT 1
             FROM message_attachments other_message_attachment
            WHERE other_message_attachment.attachment_id = a.attachment_id
              AND other_message_attachment.message_id <> ?1
         )
         AND NOT EXISTS (
           SELECT 1
             FROM task_attachments other_task_attachment
            WHERE other_task_attachment.attachment_id = a.attachment_id
         )
    `
    )
    .bind(messageId, context.orgId || '')
    .all();
  const attachmentRows = Array.isArray(attachmentResult?.results) ? attachmentResult.results : [];
  const attachmentIds = attachmentRows
    .map((row) => normalizeIdValue(row?.attachment_id))
    .filter(Boolean);
  const r2Keys = attachmentRows
    .map((row) => safeParseJson(row?.extra_json || null, {})?.r2Key)
    .filter((key) => typeof key === 'string' && key.trim())
    .map((key) => key.trim());
  const statements = [
    db.prepare('DELETE FROM message_reads WHERE message_id = ?1').bind(messageId),
    db.prepare('DELETE FROM message_attachments WHERE message_id = ?1').bind(messageId),
  ];
  if (attachmentIds.length) {
    const placeholders = attachmentIds.map((_, index) => `?${index + 2}`).join(', ');
    statements.push(
      db
        .prepare(
          `
          DELETE FROM attachments
           WHERE org_id = ?1
             AND attachment_id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1
                 FROM task_attachments remaining_task_attachment
                WHERE remaining_task_attachment.attachment_id = attachments.attachment_id
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM message_attachments remaining_message_attachment
                WHERE remaining_message_attachment.attachment_id = attachments.attachment_id
             )
        `
        )
        .bind(context.orgId || '', ...attachmentIds)
    );
  }
  const cleanupKeys = normalizeR2CleanupKeys(r2Keys);
  cleanupKeys.forEach((key) => {
    statements.push(
      buildStorageCleanupJobStatement(db, key, {
        orgId: context.orgId || '',
        targetType: 'message',
        targetId: messageId,
        reason: 'message_deleted',
        requestId: context.requestId || '',
      })
    );
  });
  statements.push(
    db
      .prepare('DELETE FROM messages WHERE message_id = ?1 AND org_id = ?2')
      .bind(messageId, context.orgId || '')
  );
  if (context.audit) {
    const actorMembership = context.actorEmail
      ? await resolveMembershipForEmail(db, normalizeEmailValue(context.actorEmail), context.orgId || '')
      : null;
    statements.push(
      buildAuditLogStatement(db, {
        ...context.audit,
        orgId: context.orgId || '',
        actorMembershipId: actorMembership?.membership_id || null,
        targetId: messageId,
        requestId: context.requestId || null,
        onlyIfPreviousStatementChanged: true,
      })
    );
  }
  await db.batch(statements.filter(Boolean));
  await cleanupR2KeysWithOutbox(db, env, cleanupKeys, {
    orgId: context.orgId || '',
    targetType: 'message',
    targetId: messageId,
    reason: 'message_deleted',
    requestId: context.requestId || '',
    config: context.config,
  });
}

function resolvePrimaryD1(db) {
  if (db && typeof db.withSession === 'function') {
    try {
      return db.withSession('first-primary');
    } catch (_error) {
      return db;
    }
  }
  return db;
}

async function loadUserSettingsState(db, userId) {
  const normalizedUserId = normalizeIdValue(userId);
  if (!db || !normalizedUserId) return null;
  return db
    .prepare(
      `
      SELECT user_id,
             display_name,
             profile_image_url,
             theme,
             language,
             settings_version,
             updated_at_ms
        FROM users
       WHERE user_id = ?1
       LIMIT 1
    `
    )
    .bind(normalizedUserId)
    .first();
}

async function updateUserSettingsInD1(db, context) {
  if (!context) return;
  const email = normalizeEmailValue(context.email);
  if (!email) return;
  const user = context.user || null;
  if (!user) {
    throw new Error('User context is required when saving settings.');
  }
  const orgId = normalizeIdValue(context.orgId);
  const ownerUserId = normalizeIdValue(user.user_id || context.ownerUserId);
  const ownerMembershipId = normalizeIdValue(context.ownerMembershipId);
  if (!orgId || !ownerUserId || !ownerMembershipId) {
    const error = new Error('Profile ownership scope is unavailable.');
    error.code = 'profile_scope_unavailable';
    throw error;
  }
  const expectedSettingsVersion = normalizeSettingsVersion(context.expectedSettingsVersion);
  const nextSettingsVersion = normalizeSettingsVersion(context.nextSettingsVersion);
  if (!expectedSettingsVersion || !nextSettingsVersion) {
    const error = new Error('Settings version is unavailable.');
    error.code = 'settings_version_invalid';
    throw error;
  }
  const updates = [];
  const values = [];
  let bindIndex = 1;
  if (context.theme !== undefined) {
    updates.push(`theme = ?${bindIndex++}`);
    values.push(context.theme);
  }
  if (context.name !== undefined) {
    updates.push(`display_name = ?${bindIndex++}`);
    values.push(context.name);
  }
  if (context.imageUrl !== undefined) {
    updates.push(`profile_image_url = ?${bindIndex++}`);
    values.push(context.imageUrl || null);
  }
  const nextLanguage = normalizeLanguageInput(context.language);
  if (nextLanguage) {
    updates.push(`language = ?${bindIndex++}`);
    values.push(nextLanguage);
  }
  const requestedTimestamp = context.timestampMs || Date.now();
  const timestamp = requestedTimestamp;
  // 認証成功もusers.updated_at_msを更新する。R2 upload中にその更新が入っても、
  // 設定保存が古い読取値でlast-modifiedを巻き戻さないようSQL側で単調増加させる。
  updates.push(`updated_at_ms = MAX(COALESCE(updated_at_ms, 0) + 1, ?${bindIndex++})`);
  values.push(requestedTimestamp);
  updates.push(`settings_version = ?${bindIndex++}`);
  values.push(nextSettingsVersion);

  const userIdIndex = bindIndex++;
  const expectedVersionIndex = bindIndex++;
  const updateBindValues = [
    ...values,
    ownerUserId,
    expectedSettingsVersion,
  ];
  let attachmentInvariantSql = '';
  if (context.newAttachment) {
    const attachmentIdIndex = bindIndex++;
    const attachmentOrgIndex = bindIndex++;
    const attachmentChecksumIndex = bindIndex++;
    const attachmentMembershipIndex = bindIndex++;
    const attachmentOwnerIndex = bindIndex++;
    attachmentInvariantSql = `
           AND EXISTS (
             SELECT 1
               FROM attachments a
              WHERE a.attachment_id = ?${attachmentIdIndex}
                AND a.org_id = ?${attachmentOrgIndex}
                AND a.checksum = ?${attachmentChecksumIndex}
                AND a.created_by_membership_id = ?${attachmentMembershipIndex}
                AND LOWER(COALESCE(JSON_EXTRACT(a.extra_json, '$.category'), '')) = 'profile_image'
                AND COALESCE(JSON_EXTRACT(a.extra_json, '$.ownerUserId'), '') = ?${attachmentOwnerIndex}
           )`;
    updateBindValues.push(
      context.newAttachment.attachmentId,
      orgId,
      context.newAttachment.checksum || '',
      ownerMembershipId,
      ownerUserId
    );
  }
  const statements = [];
  const uploadedR2Key =
    typeof context.newAttachment?.extra?.r2Key === 'string'
      ? context.newAttachment.extra.r2Key.trim()
      : '';
  if (context.newAttachment && uploadedR2Key && !context.stagedAttachment) {
    statements.push(
      buildStorageCleanupJobStatement(db, uploadedR2Key, {
        orgId,
        targetType: 'user',
        targetId: ownerUserId,
        reason: 'upload_uncommitted',
        requestId: context.requestId || '',
      })
    );
  }
  if (context.newAttachment && context.stagedAttachment) {
    statements.push(
      buildStagedAttachmentClaimStatement(
        db,
        { staged_attachment_id: context.stagedAttachment.stagedAttachmentId },
        {
          orgId,
          ownerUserId,
          ownerMembershipId,
          purpose: 'profile',
          targetType: 'user_settings',
          targetId: nextSettingsVersion,
          claimedAtMs: context.stagedAttachment.claimedAtMs || timestamp,
          expectedSettingsVersion,
        }
      )
    );
  }
  if (context.newAttachment) {
    // logical IDは冪等、物理R2世代はwrite-once。競合時は先着metadataを正本とする。
    statements.push(
      buildAttachmentRecordStatement(db, {
        ...context.newAttachment,
        preserveExisting: true,
      })
    );
  }
  const updateStatementIndex = statements.length;
  statements.push(
    db
      .prepare(
        `
        UPDATE users
           SET ${updates.join(', ')}
         WHERE user_id = ?${userIdIndex}
           AND settings_version = ?${expectedVersionIndex}
           ${attachmentInvariantSql}
      `
      )
      .bind(...updateBindValues)
  );
  const changedFields = Array.from(
    new Set(
      (Array.isArray(context.changedFields) ? context.changedFields : [])
        .map((field) => String(field || '').trim())
        .filter(Boolean)
    )
  );
  statements.push(
    buildAuditLogStatement(db, {
      orgId,
      actorMembershipId: ownerMembershipId,
      targetType: 'user',
      targetId: ownerUserId,
      action: 'user_settings.update',
      createdAtMs: timestamp,
      requestId: context.requestId || null,
      requestPayloadSha256: context.requestPayloadSha256 || null,
      requestGenerationMs: context.requestGenerationMs || null,
      onlyIfPreviousStatementChanged: true,
      payload: { fields: changedFields },
    })
  );

  const previousAttachment = context.previousAttachment || null;
  const nextAttachmentId = normalizeIdValue(context.nextAttachmentId);
  const previousAttachmentId = normalizeIdValue(previousAttachment?.attachment_id);
  const cleanupKeys = [];
  const profileImageChanged = context.imageUrl !== undefined;
  if (profileImageChanged && previousAttachmentId && previousAttachmentId !== nextAttachmentId) {
    const previousKey =
      typeof previousAttachment.r2Key === 'string' ? previousAttachment.r2Key.trim() : '';
    if (previousKey) {
      cleanupKeys.push(previousKey);
      statements.push(
        buildStorageCleanupJobStatement(db, previousKey, {
          orgId,
          targetType: 'user',
          targetId: ownerUserId,
          reason: 'profile_image_replaced',
          requestId: context.requestId || '',
          requiredProfileState: {
            userId: ownerUserId,
            settingsVersion: nextSettingsVersion,
            imageUrl: context.imageUrl || '',
          },
        })
      );
    }
    statements.push(
      db
        .prepare(
          `
          DELETE FROM attachments
           WHERE attachment_id = ?1
             AND org_id = ?2
             AND LOWER(COALESCE(JSON_EXTRACT(extra_json, '$.category'), '')) = 'profile_image'
             AND created_by_membership_id IN (
               SELECT membership_id
                 FROM memberships
                WHERE org_id = ?2
                  AND user_id = ?3
             )
             AND EXISTS (
               SELECT 1
                 FROM users
                WHERE user_id = ?3
                  AND settings_version = ?4
                  AND COALESCE(profile_image_url, '') = ?5
             )
        `
        )
        .bind(
          previousAttachmentId,
          orgId,
          ownerUserId,
          nextSettingsVersion,
          context.imageUrl || ''
        )
    );
  }
  if (context.newAttachment && uploadedR2Key) {
    statements.push(
      buildClearStorageCleanupJobForAdoptedAttachmentStatement(db, {
        r2Key: uploadedR2Key,
        attachmentId: context.newAttachment.attachmentId,
        orgId,
        ownerUserId,
        settingsVersion: nextSettingsVersion,
        storagePath: context.imageUrl || '',
      }),
      !context.stagedAttachment
        ? db
            .prepare(
              `
              DELETE FROM attachments
               WHERE attachment_id = ?1
                 AND org_id = ?2
                 AND CASE
                       WHEN JSON_VALID(COALESCE(extra_json, '')) = 1
                       THEN JSON_EXTRACT(extra_json, '$.r2Key')
                       ELSE NULL
                     END = ?3
                 AND NOT EXISTS (
                   SELECT 1
                     FROM users
                    WHERE user_id = ?4
                      AND settings_version = ?5
                      AND COALESCE(profile_image_url, '') = ?6
                 )
            `
            )
            .bind(
              context.newAttachment.attachmentId,
              orgId,
              uploadedR2Key,
              ownerUserId,
              nextSettingsVersion,
              context.imageUrl || ''
            )
        : null
    );
  }
  const batchResults = await db.batch(statements.filter(Boolean));
  const updateResult = batchResults[updateStatementIndex];
  const conflict = Number(updateResult?.meta?.changes || 0) === 0;
  return {
    cleanupKeys: conflict ? [] : cleanupKeys,
    userId: ownerUserId,
    orgId,
    conflict,
    settingsVersion: conflict ? expectedSettingsVersion : nextSettingsVersion,
  };
}

async function resolveOwnedProfileAttachment(db, context = {}) {
  const attachmentId = normalizeIdValue(context.attachmentId);
  const orgId = normalizeIdValue(context.orgId);
  const ownerUserId = normalizeIdValue(context.ownerUserId);
  if (!db || !attachmentId || !orgId || !ownerUserId) return null;
  const row = await db
    .prepare(
      `
      SELECT a.attachment_id,
             a.org_id,
             a.file_name,
             a.content_type,
             a.size_bytes,
             a.storage_path,
             a.checksum,
             a.created_at_ms,
             a.created_by_membership_id,
             a.extra_json
        FROM attachments a
        JOIN memberships owner_membership
          ON owner_membership.membership_id = a.created_by_membership_id
         AND owner_membership.org_id = a.org_id
       WHERE a.attachment_id = ?1
         AND a.org_id = ?2
         AND owner_membership.user_id = ?3
         AND LOWER(COALESCE(JSON_EXTRACT(a.extra_json, '$.category'), '')) = 'profile_image'
       LIMIT 1
    `
    )
    .bind(attachmentId, orgId, ownerUserId)
    .first();
  if (!row) return null;
  const extra = safeParseJson(row.extra_json || null, {});
  return {
    ...row,
    r2Key: typeof extra?.r2Key === 'string' ? extra.r2Key.trim() : '',
  };
}

function buildAttachmentRecordStatement(db, details) {
  if (!db || !details || !details.attachmentId) return null;
  const extraPayload =
    details.extra && typeof details.extra === 'object' && Object.keys(details.extra).length
      ? JSON.stringify(details.extra)
      : null;
  const insertMode = details.preserveExisting ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
  const guardedR2Key =
    details.extra && typeof details.extra.r2Key === 'string'
      ? details.extra.r2Key.trim()
      : '';
  const guardAdoption = Boolean(guardedR2Key && normalizeIdValue(details.orgId));
  const predicates = [];
  if (details.onlyIfPreviousStatementChanged) {
    predicates.push('changes() > 0');
  }
  if (guardAdoption) {
    predicates.push(`
      NOT EXISTS (
        SELECT 1
          FROM storage_cleanup_jobs cleanup_guard
         WHERE cleanup_guard.r2_key = ?11
           AND cleanup_guard.org_id = ?2
           AND cleanup_guard.lease_token IS NOT NULL
      )`);
  }
  const stagedClaim = details.stagedClaim && typeof details.stagedClaim === 'object'
    ? details.stagedClaim
    : null;
  const stagedAttachmentId = normalizeIdValue(stagedClaim?.stagedAttachmentId);
  const stagedTargetType =
    stagedClaim?.targetType === 'user_settings' ? 'user_settings' : 'message';
  const stagedTargetId = normalizeIdValue(stagedClaim?.targetId);
  const stagedGuard = Boolean(stagedAttachmentId && stagedTargetId && normalizeIdValue(details.orgId));
  if (stagedGuard) {
    const startIndex = guardAdoption ? 12 : 11;
    predicates.push(`
      EXISTS (
        SELECT 1
          FROM staged_attachments staged_claim
         WHERE staged_claim.staged_attachment_id = ?${startIndex}
           AND staged_claim.org_id = ?2
           AND staged_claim.status = 'claimed'
           AND staged_claim.claimed_target_type = ?${startIndex + 1}
           AND staged_claim.claimed_target_id = ?${startIndex + 2}
           AND staged_claim.r2_key = ${guardAdoption ? '?11' : "JSON_EXTRACT(?10, '$.r2Key')"}
      )`);
  }
  const valueClause = predicates.length
    ? `SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${predicates.join(' AND ')}`
    : 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)';
  const bindValues = [
    details.attachmentId,
    details.orgId || null,
    details.fileName || null,
    details.mimeType || null,
    typeof details.sizeBytes === 'number' ? details.sizeBytes : null,
    details.storagePath || null,
    details.checksum || null,
    typeof details.createdAtMs === 'number' ? details.createdAtMs : Date.now(),
    details.createdByMembershipId || null,
    extraPayload,
  ];
  if (guardAdoption) {
    bindValues.push(guardedR2Key);
  }
  if (stagedGuard) {
    bindValues.push(stagedAttachmentId, stagedTargetType, stagedTargetId);
  }
  return db
    .prepare(
      `
      ${insertMode} INTO attachments (
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
      ${valueClause}
    `
    )
    .bind(...bindValues);
}

function buildClearStorageCleanupJobForAdoptedAttachmentStatement(db, details = {}) {
  const r2Key = typeof details.r2Key === 'string' ? details.r2Key.trim() : '';
  const attachmentId = normalizeIdValue(details.attachmentId);
  const orgId = normalizeIdValue(details.orgId);
  if (!db || !r2Key || !attachmentId || !orgId) return null;
  const ownerUserId = normalizeIdValue(details.ownerUserId);
  const settingsVersion = normalizeSettingsVersion(details.settingsVersion);
  const storagePath = typeof details.storagePath === 'string' ? details.storagePath : '';
  const profileAdoptionClause = ownerUserId && settingsVersion
    ? `
         AND EXISTS (
           SELECT 1
             FROM users
            WHERE user_id = ?4
              AND settings_version = ?5
              AND COALESCE(profile_image_url, '') = ?6
         )`
    : '';
  const bindValues = [r2Key, attachmentId, orgId];
  if (profileAdoptionClause) {
    bindValues.push(ownerUserId, settingsVersion, storagePath);
  }
  return db
    .prepare(
      `
      DELETE FROM storage_cleanup_jobs
       WHERE r2_key = ?1
         AND lease_token IS NULL
         AND EXISTS (
           SELECT 1
             FROM attachments
            WHERE attachment_id = ?2
              AND org_id = ?3
              AND CASE
                    WHEN JSON_VALID(COALESCE(extra_json, '')) = 1
                    THEN JSON_EXTRACT(extra_json, '$.r2Key')
                    ELSE NULL
                  END = ?1
         )
         ${profileAdoptionClause}
    `
    )
    .bind(...bindValues);
}

async function deleteAttachmentRecords(db, env, attachmentIds, context = {}) {
  if (!db || !Array.isArray(attachmentIds) || !attachmentIds.length) return;
  const uniqueIds = Array.from(new Set(attachmentIds.map((id) => normalizeIdValue(id)).filter(Boolean)));
  if (!uniqueIds.length) return;
  const orgId = normalizeIdValue(context.orgId);
  const ownerUserId = normalizeIdValue(context.ownerUserId);
  const category = String(context.category || '').trim().toLowerCase();
  if (!orgId || !ownerUserId || category !== 'profile_image') {
    const error = new Error('Scoped profile attachment deletion requires org, owner, and category.');
    error.code = 'attachment_delete_scope_required';
    throw error;
  }
  const placeholders = uniqueIds.map((_, idx) => `?${idx + 1}`).join(', ');
  const selectStatement = `
    SELECT a.attachment_id, a.extra_json
      FROM attachments a
      JOIN memberships owner_membership
        ON owner_membership.membership_id = a.created_by_membership_id
       AND owner_membership.org_id = a.org_id
     WHERE a.attachment_id IN (${placeholders})
       AND a.org_id = ?${uniqueIds.length + 1}
       AND owner_membership.user_id = ?${uniqueIds.length + 2}
       AND LOWER(COALESCE(JSON_EXTRACT(a.extra_json, '$.category'), '')) = ?${uniqueIds.length + 3}
  `;
  const result = await db
    .prepare(selectStatement)
    .bind(...uniqueIds, orgId, ownerUserId, category)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const scopedIds = rows
    .map((row) => normalizeIdValue(row?.attachment_id))
    .filter(Boolean);
  if (!scopedIds.length) return { deletedAttachmentIds: [], cleanupKeys: [] };
  const r2Keys = [];
  for (const row of rows) {
    const extra = safeParseJson(row?.extra_json || null, {});
    const key = typeof extra?.r2Key === 'string' ? extra.r2Key.trim() : '';
    if (key) {
      r2Keys.push(key);
    }
  }
  const cleanupKeys = normalizeR2CleanupKeys(r2Keys);
  const statements = cleanupKeys.map((key) =>
    buildStorageCleanupJobStatement(db, key, {
      ...context,
      reason: context.reason || 'attachment_record_deleted',
    })
  );
  const scopedPlaceholders = scopedIds.map((_, idx) => `?${idx + 1}`).join(', ');
  statements.push(
    db
      .prepare(
        `
        DELETE FROM attachments
         WHERE attachment_id IN (${scopedPlaceholders})
           AND org_id = ?${scopedIds.length + 1}
           AND LOWER(COALESCE(JSON_EXTRACT(extra_json, '$.category'), '')) = ?${
             scopedIds.length + 2
           }
           AND created_by_membership_id IN (
             SELECT membership_id
               FROM memberships
              WHERE org_id = ?${scopedIds.length + 1}
                AND user_id = ?${scopedIds.length + 3}
           )
      `
      )
      .bind(...scopedIds, orgId, category, ownerUserId)
  );
  await db.batch(statements.filter(Boolean));
  await cleanupR2KeysWithOutbox(db, env, cleanupKeys, {
    ...context,
    reason: context.reason || 'attachment_record_deleted',
  });
  return { deletedAttachmentIds: scopedIds, cleanupKeys };
}

async function ensureMembershipForOrg(db, userId, orgId, defaults = {}) {
  if (!db || !userId || !orgId) {
    return null;
  }
  const existing = await db
    .prepare(
      `
      SELECT membership_id,
             role,
             status
        FROM memberships
       WHERE user_id = ?1
         AND org_id = ?2
       LIMIT 1
    `
    )
    .bind(userId, orgId)
    .first();
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const membershipId = createUlid(now);
  const role = normalizeRoleValue(defaults.role) || 'member';
  const status = normalizeUserStatusValue(defaults.status) || 'pending';
  await db
    .prepare(
      `
      INSERT INTO memberships (
        membership_id,
        org_id,
        user_id,
        role,
        status,
        created_at_ms
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `
    )
    .bind(membershipId, orgId, userId, role, status, now)
    .run();
  return {
    membership_id: membershipId,
    role,
    status,
  };
}

function buildAuditLogStatement(db, entry) {
  if (!db || !entry || !entry.orgId) {
    return null;
  }
  const timestamp = typeof entry.createdAtMs === 'number' ? entry.createdAtMs : Date.now();
  let payloadJson = null;
  if (entry.payload && typeof entry.payload === 'object') {
    try {
      payloadJson = JSON.stringify(entry.payload);
    } catch (_err) {
      payloadJson = null;
    }
  }
  const requestPayloadSha256 =
    typeof entry.requestPayloadSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.requestPayloadSha256.trim())
      ? entry.requestPayloadSha256.trim()
      : null;
  const requestGenerationMs = Number(entry.requestGenerationMs);
  const normalizedRequestGenerationMs =
    Number.isFinite(requestGenerationMs) && requestGenerationMs > 0
      ? Math.floor(requestGenerationMs)
      : null;
  const valueClause = entry.onlyIfPreviousStatementChanged
    ? 'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 WHERE changes() > 0'
    : 'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)';
  return db
    .prepare(
      `
      INSERT OR IGNORE INTO audit_logs (
        audit_id,
        org_id,
        actor_membership_id,
        target_type,
        target_id,
        action,
        created_at_ms,
        payload_json,
        request_id,
        request_payload_sha256,
        request_generation_ms
      )
      ${valueClause}
    `
    )
    .bind(
      createUlid(timestamp),
      entry.orgId,
      entry.actorMembershipId || null,
      entry.targetType || 'user',
      entry.targetId || null,
      entry.action || 'admin_update',
      timestamp,
      payloadJson,
      entry.requestId || null,
      requestPayloadSha256,
      normalizedRequestGenerationMs
    );
}

function clampAuditLimit(value, min = 25, max = 500) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 150;
  }
  const normalized = Math.floor(value);
  if (normalized < min) return min;
  if (normalized > max) return max;
  return normalized;
}

function resolveAuditRange(rangeKey) {
  const ranges = {
    '1h': { label: '直近1時間', windowMs: 60 * 60 * 1000 },
    '6h': { label: '直近6時間', windowMs: 6 * 60 * 60 * 1000 },
    '24h': { label: '直近24時間', windowMs: 24 * 60 * 60 * 1000 },
    '7d': { label: '直近7日間', windowMs: 7 * 24 * 60 * 60 * 1000 },
    '30d': { label: '直近30日間', windowMs: 30 * 24 * 60 * 60 * 1000 },
  };
  const normalized = String(rangeKey || '').toLowerCase();
  if (ranges[normalized]) {
    return { key: normalized, ...ranges[normalized] };
  }
  return { key: '24h', ...ranges['24h'] };
}

function describeAdminAction(action, payload) {
  const normalized = String(action || '').trim();
  const email = payload && typeof payload.email === 'string' ? payload.email : '';
  if (normalized === 'task.create') {
    const title = payload && typeof payload.title === 'string' ? payload.title : '';
    return {
      label: 'タスク作成',
      summary: title ? 'タイトル: ' + title : 'タスクを作成しました。',
    };
  }
  if (normalized === 'task.update') {
    const fields = Array.isArray(payload?.fields) ? payload.fields.join(', ') : '';
    return {
      label: 'タスク更新',
      summary: fields ? '更新項目: ' + fields : 'タスクを更新しました。',
    };
  }
  if (normalized === 'task.complete') {
    return { label: 'タスク完了', summary: 'タスクを完了にしました。' };
  }
  if (normalized === 'task.delete') {
    return { label: 'タスク削除', summary: 'タスクを削除しました。' };
  }
  if (normalized === 'message.create') {
    const title = payload && typeof payload.title === 'string' ? payload.title : '';
    return {
      label: 'メッセージ作成',
      summary: title ? 'タイトル: ' + title : 'メッセージを投稿しました。',
    };
  }
  if (normalized === 'message.delete') {
    return { label: 'メッセージ削除', summary: 'メッセージを削除しました。' };
  }
  if (normalized === 'message.pin') {
    return { label: 'ピン留め', summary: 'メッセージをピン留めしました。' };
  }
  if (normalized === 'message.unpin') {
    return { label: 'ピン留め解除', summary: 'メッセージのピン留めを解除しました。' };
  }
  if (normalized === 'message.comment') {
    return { label: 'コメント投稿', summary: 'メッセージへコメントを投稿しました。' };
  }
  if (normalized === 'folder.create') {
    return { label: 'フォルダ作成', summary: 'フォルダを作成しました。' };
  }
  if (normalized === 'folder.update') {
    return { label: 'フォルダ更新', summary: 'フォルダ設定を更新しました。' };
  }
  if (normalized === 'folder.archive') {
    return { label: 'フォルダアーカイブ', summary: 'フォルダをアーカイブしました。' };
  }
  if (normalized === 'template.create') {
    return { label: 'テンプレート作成', summary: 'テンプレートを作成しました。' };
  }
  if (normalized === 'user_settings.update') {
    const fields = Array.isArray(payload?.fields) ? payload.fields.join(', ') : '';
    return {
      label: '個人設定更新',
      summary: fields ? '更新項目: ' + fields : '個人設定を更新しました。',
    };
  }
  if (normalized === 'user_status_update') {
    return {
      label: 'ユーザーステータス更新',
      summary:
        (email ? email + '：' : '') +
        (payload && payload.from ? payload.from : '不明') +
        ' → ' +
        (payload && payload.to ? payload.to : '不明'),
    };
  }
  if (normalized === 'user_role_update') {
    return {
      label: 'ユーザーロール更新',
      summary:
        (email ? email + '：' : '') +
        (payload && payload.from ? payload.from : '不明') +
        ' → ' +
        (payload && payload.to ? payload.to : '不明'),
    };
  }
  if (normalized === 'admin_org_update') {
    return {
      label: '組織設定更新',
      summary: '名称・カラー・通知設定などを更新しました。',
    };
  }
  return {
    label: normalized || '業務操作',
    summary: normalized || '業務操作を記録しました。',
  };
}

function buildAdminAuditEntry(row) {
  if (!row) return null;
  const payload = safeParseJson(row.payload_json || '', {});
  const descriptor = describeAdminAction(row.action, payload);
  const actorName = row.actor_name || row.actor_email || 'システム';
  const createdAt = row.created_at_ms || Date.now();
  return {
    id: row.audit_id || createUlid(createdAt),
    type: 'admin',
    typeLabel: '業務操作',
    icon: 'fact_check',
    eventLabel: descriptor.label,
    statusLabel: '完了',
    severity: 'info',
    summary: descriptor.summary,
    occurredAt: createdAt,
    occurredLabel: formatJst(createdAt, true),
    userLabel: actorName,
    userEmail: row.actor_email || '',
    meta: {
      source: 'audit_logs',
      action: row.action || '',
      targetType: row.target_type || '',
      targetId: row.target_id || '',
      requestId: row.request_id || '',
      payload,
      actor: {
        email: row.actor_email || '',
        name: actorName,
        role: row.actor_role || '',
        membershipId: row.actor_membership_id || '',
      },
    },
  };
}

function buildAuthEventEntry(row) {
  if (!row) return null;
  const occurredAt = row.occurred_at_ms || Date.now();
  const eventType = String(row.event_type || '').toLowerCase();
  const outcome = String(row.outcome || '').toLowerCase();
  let eventLabel = '認証イベント';
  let statusLabel = outcome || '記録';
  let severity = 'info';
  let icon = 'shield';
  if (eventType === 'authentication.succeeded') {
    eventLabel = 'ログイン成功';
    statusLabel = '成功';
    severity = 'success';
    icon = 'login';
  } else if (eventType === 'authentication.failed') {
    eventLabel = 'ログイン失敗';
    statusLabel = '失敗';
    severity = 'danger';
    icon = 'gpp_bad';
  } else if (eventType === 'session.logged_out') {
    eventLabel = 'ログアウト';
    statusLabel = '終了';
    icon = 'logout';
  } else if (eventType === 'session.expired') {
    eventLabel = 'セッション期限切れ';
    statusLabel = '期限切れ';
    severity = 'warning';
    icon = 'timer_off';
  } else if (eventType === 'authorization.denied') {
    eventLabel = 'アクセス拒否';
    statusLabel = row.status || '拒否';
    severity = 'danger';
    icon = 'block';
  } else if (eventType === 'authorization.role_denied') {
    eventLabel = 'ロール権限拒否';
    statusLabel = '拒否';
    severity = 'danger';
    icon = 'gpp_bad';
  }
  const userLabel = row.display_name || row.user_email || '不明なユーザー';
  const summaryParts = [];
  if (row.reason_code) summaryParts.push('理由: ' + row.reason_code);
  if (row.status) summaryParts.push('状態: ' + row.status);
  if (row.role) summaryParts.push('ロール: ' + row.role);
  if (row.route) summaryParts.push('経路: ' + row.route);
  const summary = summaryParts.length
    ? summaryParts.join(' / ')
    : '認証・アクセスイベントを記録しました。';
  return {
    id: row.event_id || createUlid(occurredAt),
    type: 'auth',
    typeLabel: '認証・アクセス',
    icon,
    eventLabel,
    statusLabel,
    severity,
    summary,
    occurredAt,
    occurredLabel: formatJst(occurredAt, true),
    userLabel,
    userEmail: row.user_email || '',
    meta: {
      source: 'auth_events',
      eventType,
      outcome,
      requestId: row.request_id || '',
      reasonCode: row.reason_code || '',
      role: row.role || '',
      route: row.route || '',
      eventSource: row.source || '',
      orgId: row.org_id || '',
      status: row.status || '',
    },
  };
}

function buildProxyAuditEntry(row) {
  if (!row) return null;
  const createdAt = row.created_at_ms || Date.now();
  const meta = safeParseJson(row.meta_json || '', {});
  const level = String(row.level || '').toLowerCase();
  let severity = 'info';
  if (level === 'error') severity = 'danger';
  else if (level === 'warn') severity = 'warning';
  const summaryParts = [];
  if (row.message) summaryParts.push(row.message);
  if (row.status) summaryParts.push('status: ' + row.status);
  const summary = summaryParts.length
    ? summaryParts.join(' / ')
    : '認証プロキシイベントを記録しました。';
  const userLabel = row.display_name || row.email || 'システム';
  return {
    id: row.log_id || createUlid(createdAt),
    type: 'api',
    typeLabel: 'API障害',
    icon: 'error_outline',
    eventLabel: row.event || 'API診断',
    statusLabel: row.status || row.level || 'info',
    severity,
    summary,
    occurredAt: createdAt,
    occurredLabel: formatJst(createdAt, true),
    userLabel,
    userEmail: row.email || '',
    meta: {
      source: 'auth_proxy_logs',
      level: row.level || '',
      event: row.event || '',
      message: row.message || '',
      requestId: row.request_id || '',
      route: row.route || '',
      cfRay: row.cf_ray || '',
      status: row.status || '',
      orgId: row.org_id || '',
      userId: row.user_id || '',
      meta,
    },
  };
}

async function resolveMembershipForEmail(db, email, orgId = '') {
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
        AND LOWER(COALESCE(memberships.status, 'active')) = 'active'
        AND (?2 = '' OR memberships.org_id = ?2)
      ORDER BY memberships.created_at_ms ASC
      LIMIT 1
    `
    )
    .bind(email, orgId || '')
    .first();
  return row || null;
}

async function resolveDefaultOrgId(db) {
  const row = await db
    .prepare('SELECT org_id FROM organizations ORDER BY created_at_ms ASC LIMIT 1')
    .first();
  return row ? row.org_id : null;
}

function normalizeOrgColor(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const match = trimmed.match(HEX_COLOR_REGEX);
  if (!match) return null;
  return '#' + match[1].toUpperCase();
}

function coerceOrgTimezone(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return DEFAULT_ORG_TIMEZONE;
  }
  return SUPPORTED_TIMEZONES.includes(raw) ? raw : DEFAULT_ORG_TIMEZONE;
}

function validateEmailFormat(value) {
  const email = normalizeEmailValue(value);
  if (!email) return '';
  const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  return emailRegex.test(email) ? email : '';
}

async function fetchMembershipForOrg(db, userId, orgId) {
  if (!db || !userId || !orgId) return null;
  const row = await db
    .prepare(
      `
      SELECT membership_id,
             role,
             status
        FROM memberships
       WHERE user_id = ?1
         AND org_id = ?2
       LIMIT 1
    `
    )
    .bind(userId, orgId)
    .first();
  return row || null;
}

async function fetchOrgMemberStats(db, orgId) {
  if (!db || !orgId) {
    return {
      totalMembers: 0,
      statusCounts: { pending: 0, active: 0, suspended: 0, revoked: 0 },
      roleCounts: { admin: 0, manager: 0, member: 0, guest: 0 },
    };
  }
  const statusRows = await db
    .prepare(
      `
      SELECT LOWER(COALESCE(status, 'active')) AS status_key,
             COUNT(*) AS row_count
        FROM memberships
       WHERE org_id = ?1
       GROUP BY LOWER(COALESCE(status, 'active'))
    `
    )
    .bind(orgId)
    .all();
  const roleRows = await db
    .prepare(
      `
      SELECT LOWER(COALESCE(role, 'member')) AS role_key,
             COUNT(*) AS row_count
        FROM memberships
       WHERE org_id = ?1
         AND LOWER(COALESCE(status, 'active')) = 'active'
       GROUP BY LOWER(COALESCE(role, 'member'))
    `
    )
    .bind(orgId)
    .all();
  const statusCounts = { pending: 0, active: 0, suspended: 0, revoked: 0 };
  const roleCounts = { admin: 0, manager: 0, member: 0, guest: 0 };
  let totalMembers = 0;
  const statusResults = Array.isArray(statusRows?.results) ? statusRows.results : [];
  statusResults.forEach((row) => {
    const statusKey = (row.status_key || '').trim();
    const count = Number(row.row_count || 0);
    totalMembers += count;
    if (Object.prototype.hasOwnProperty.call(statusCounts, statusKey)) {
      statusCounts[statusKey] = count;
    }
  });
  const roleResults = Array.isArray(roleRows?.results) ? roleRows.results : [];
  roleResults.forEach((row) => {
    const roleKey = (row.role_key || '').trim();
    const count = Number(row.row_count || 0);
    if (Object.prototype.hasOwnProperty.call(roleCounts, roleKey)) {
      roleCounts[roleKey] = count;
    }
  });
  return {
    totalMembers,
    statusCounts,
    roleCounts,
  };
}

async function ensurePendingUserInD1(db, tokenDetails, requestId) {
  if (!db || !tokenDetails) return null;
  const email = normalizeEmailValue(tokenDetails.email);
  if (!email) return null;
  let existing;
  try {
    existing = await db
      .prepare('SELECT user_id FROM users WHERE lower(email) = ?1 LIMIT 1')
      .bind(email)
      .first();
  } catch (_error) {
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 pending user lookup is temporarily unavailable.'
    );
  }
  if (existing && existing.user_id) {
    return existing.user_id;
  }
  const now = Date.now();
  const displayName = typeof tokenDetails.name === 'string' ? tokenDetails.name.trim() : '';
  const storedEmail = tokenDetails.email ? String(tokenDetails.email).trim().toLowerCase() : email;
  const authSubject = tokenDetails.sub ? String(tokenDetails.sub).trim() : null;
  const issuedAtMs =
    typeof tokenDetails.iat === 'number' && Number.isFinite(tokenDetails.iat) && tokenDetails.iat > 0
      ? Math.floor(tokenDetails.iat * 1000)
      : now;
  const userId = createUlid(now);
  try {
    await db
      .prepare(
        `
        INSERT INTO users (
          user_id,
          email,
          display_name,
          auth_subject,
          status,
          is_active,
          created_at_ms,
          updated_at_ms,
          first_login_at_ms,
          last_login_at_ms
        )
        VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?7, ?8)
      `
      )
      .bind(userId, storedEmail, displayName || storedEmail, authSubject, now, now, issuedAtMs, issuedAtMs)
      .run();
    logAuthInfo('Inserted pending user into D1', {
      requestId,
      email: storedEmail,
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (!/UNIQUE constraint failed/i.test(message)) {
      logAuthError('Failed to insert pending user into D1', {
        requestId,
        email: storedEmail,
        reasonCode: 'pending_user_insert_failed',
      });
      throw createServiceUnavailableError(
        'd1_unavailable',
        'D1 pending user provisioning is temporarily unavailable.'
      );
    }
  }
  let ensuredRow;
  try {
    ensuredRow = await db
      .prepare('SELECT user_id FROM users WHERE lower(email) = ?1 LIMIT 1')
      .bind(email)
      .first();
  } catch (_error) {
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 pending user verification is temporarily unavailable.'
    );
  }
  const ensuredUserId = ensuredRow && ensuredRow.user_id ? ensuredRow.user_id : null;
  if (!ensuredUserId) {
    return null;
  }
  let orgId;
  try {
    orgId = await resolveDefaultOrgId(db);
  } catch (_error) {
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 organization lookup is temporarily unavailable.'
    );
  }
  if (!orgId) {
    return ensuredUserId;
  }
  try {
    await db
      .prepare(
        `
        INSERT OR IGNORE INTO memberships (
          membership_id,
          org_id,
          user_id,
          role,
          status,
          created_at_ms
        )
        VALUES (?1, ?2, ?3, 'member', 'pending', ?4)
      `
      )
      .bind(createUlid(now + 1), orgId, ensuredUserId, now)
      .run();
  } catch (err) {
    logAuthError('Failed to insert pending membership into D1', {
      requestId,
      email: storedEmail,
      reasonCode: 'pending_membership_insert_failed',
    });
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 pending membership provisioning is temporarily unavailable.'
    );
  }
  return ensuredUserId;
}

async function resolveAccessContext(config, tokenDetails, requestId, options = {}) {
  const cacheKey = resolveAccessCacheKey(tokenDetails);
  const cached = options.allowCache ? readAccessCache(cacheKey) : null;
  if (cached) {
    return cached;
  }

  const { db = null } = options;
  const flags = config.flags || {};
  const allowD1 = !!(db && (flags.d1Primary || flags.d1Read));
  let fallbackReason = 'ShiftFlow に登録されていません。管理者に連絡してください。';
  let fallbackReasonCode = 'not_registered';
  if (allowD1) {
    const d1Context = await resolveAccessContextFromD1(db, tokenDetails, requestId);
    if (d1Context) {
      if (options.allowCache && d1Context.allowed && d1Context.status === 'active') {
        writeAccessCache(cacheKey, d1Context, ACTIVE_ACCESS_CACHE_TTL_MS, tokenDetails);
      } else if (cacheKey) {
        ACCESS_CACHE.delete(cacheKey);
      }
      return d1Context;
    }
    if (db && options.allowProvision !== false) {
      await ensurePendingUserInD1(db, tokenDetails, requestId);
    } else if (db) {
      logAuthInfo('Skipped pending user provisioning because D1 writes are disabled', {
        requestId,
      });
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
    throw createServiceUnavailableError(
      'd1_unavailable',
      'D1 access control is temporarily unavailable.'
    );
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
    orgId: '',
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
  config.db = env?.DB || null;
  config.waitUntil = typeof waitUntil === 'function' ? waitUntil : null;
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
  config.flags = flags;
  const routeParam = params ? params.route : '';
  const route = Array.isArray(routeParam)
    ? routeParam.join('/')
    : routeParam
    ? String(routeParam)
    : '';
  const requestId = createRequestId(request);
  const authorizationAttemptId = crypto.randomUUID();
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

  // 診断相関にはCloudflareのrequest識別子だけを使い、IP/User-Agentは取得・保存しない。
  const clientMeta = { cfRay: request.headers.get('cf-ray') || '' };

  let tokenDetails;
  let sessionCookieHeader = '';
  let sessionContext = null;
  let sessionRecord = null;
  const cookieHeader = request.headers.get('cookie') || '';
  const mergeHeaders = (headers = {}) => {
    const base =
      headers && typeof headers === 'object' ? { ...headers } : {};
    if (sessionCookieHeader) {
      base['Set-Cookie'] = sessionCookieHeader;
    }
    return Object.keys(base).length ? base : undefined;
  };
  try {
    sessionContext = await verifySession(env, cookieHeader);
  } catch (err) {
    logAuthError('Session verification failed', {
      requestId,
      route,
      reasonCode: 'session_verification_unavailable',
    });
    captureDiagnostics(config, 'error', 'session_verification_unavailable', {
      event: 'session_verification_unavailable',
      requestId,
      route,
      reasonCode: 'session_verification_unavailable',
      phase: 'session_verify',
      httpStatus: 503,
      cfRay: clientMeta.cfRay,
    });
    return errorResponse(
      503,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'session_verification_unavailable',
      'ログイン状態を一時的に確認できません。時間をおいて再試行してください。'
    );
  }
  if (!sessionContext) {
    sessionCookieHeader = [
      buildExpiredSessionCookie(),
      buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
    ];
    return errorResponse(
      401,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'no_session',
      'ログインセッションを確認できません。もう一度ログインしてください。',
      null,
      mergeHeaders()
    );
  }

  sessionRecord = sessionContext.record || {};
  const timeoutCheck = evaluateSessionTimeout(sessionRecord);
  if (timeoutCheck.expired) {
    const expiredUser = sessionRecord.user || {};
    const timeoutReason = timeoutCheck.reason === 'absolute' ? 'absolute_timeout' : 'idle_timeout';
    await recordAuthEvent(env, {
      eventType: 'session.expired',
      outcome: 'expired',
      reasonCode: timeoutReason,
      requestId,
      route,
      source: 'api_session',
      sessionId: sessionContext.id,
      user: expiredUser,
      userSub: expiredUser.sub || '',
    });
    try {
      await destroySession(env, sessionContext.id);
    } catch (_error) {
      captureDiagnostics(config, 'error', 'session_expiry_cleanup_failed', {
        event: 'session_expiry_cleanup_failed',
        requestId,
        route,
        reasonCode: 'session_expiry_cleanup_failed',
        phase: 'session_destroy',
        httpStatus: 503,
        cfRay: clientMeta.cfRay,
      });
      return errorResponse(
        503,
        allowedOrigin || config.allowedOrigins[0] || '*',
        requestId,
        'cf-api',
        'session_expiry_cleanup_failed',
        '期限切れセッションを終了できませんでした。時間をおいて再試行してください。'
      );
    }
    sessionCookieHeader = [
      buildExpiredSessionCookie(),
      buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
    ];
    return errorResponse(
      401,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      timeoutReason,
      'ログインの有効期限が切れました。もう一度ログインしてください。',
      null,
      mergeHeaders()
    );
  }

  try {
    sessionRecord = await touchSession(env, sessionContext.id, sessionRecord);
  } catch (_error) {
    captureDiagnostics(config, 'error', 'session_refresh_unavailable', {
      event: 'session_refresh_unavailable',
      requestId,
      route,
      reasonCode: 'session_refresh_unavailable',
      phase: 'session_touch',
      httpStatus: 503,
      cfRay: clientMeta.cfRay,
    });
    return errorResponse(
      503,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'session_refresh_unavailable',
      'ログイン状態を更新できません。時間をおいて再試行してください。'
    );
  }
  if (!sessionRecord) {
    sessionCookieHeader = [
      buildExpiredSessionCookie(),
      buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
    ];
    return errorResponse(
      401,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'session_revoked',
      'このログインセッションは終了しています。もう一度ログインしてください。',
      null,
      mergeHeaders()
    );
  }
  const sessionUser = sessionRecord.user || {};
  tokenDetails = {
    sub: String(sessionUser.sub || '').trim(),
    email: String(sessionUser.email || '').trim(),
    emailVerified: sessionUser.emailVerified === true,
    name: String(sessionUser.name || '').trim(),
    picture: String(sessionUser.picture || '').trim(),
  };
  if (!tokenDetails.sub || !tokenDetails.email || !tokenDetails.emailVerified) {
    try {
      await destroySession(env, sessionContext.id);
    } catch (_error) {
      captureDiagnostics(config, 'error', 'invalid_session_cleanup_failed', {
        event: 'invalid_session_cleanup_failed',
        requestId,
        route,
        reasonCode: 'invalid_session_cleanup_failed',
        phase: 'session_destroy',
        httpStatus: 503,
        cfRay: clientMeta.cfRay,
      });
    }
    sessionCookieHeader = [
      buildExpiredSessionCookie(),
      buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
    ];
    return errorResponse(
      401,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'invalid_session_identity',
      'ログイン情報を確認できません。もう一度ログインしてください。',
      null,
      mergeHeaders()
    );
  }
  sessionCookieHeader = [
    buildSessionCookie(`${sessionContext.id}.${sessionContext.key}`, {
      maxAge: getSessionCookieMaxAge(sessionRecord),
    }),
    buildExpiredSessionCookie({ domain: 'shiftflow.pages.dev' }),
  ];

  const isMutationRequest = isD1MutationRequest(route, request.method);
  if (isMutationRequest && !isAllowedMutationMethod(route, request.method)) {
    return errorResponse(
      405,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'method_not_allowed',
      '更新処理は指定されたHTTPメソッドでは実行できません。',
      null,
      mergeHeaders()
    );
  }
  if (isMutationRequest && !flags.d1Write) {
    return errorResponse(
      503,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'd1_write_disabled',
      '現在は安全のため更新処理を一時停止しています。時間をおいて再度お試しください。',
      null,
      mergeHeaders()
    );
  }

  let accessContext;
  try {
    accessContext = await resolveAccessContext(config, tokenDetails, requestId, {
      db: env && env.DB ? env.DB : null,
      allowCache: false,
      allowProvision: flags.d1Write,
    });
  } catch (err) {
    logAuthError('resolveAccessContext failed', {
      requestId,
      route,
      reasonCode: 'resolve_access_context_failed',
      email: tokenDetails.email || '',
    });
    const isD1Unavailable = err && err.code === 'd1_unavailable';
    const diagnosticMessage = isD1Unavailable
      ? 'd1_unavailable'
      : err && err.message
        ? err.message
        : String(err || 'resolveAccessContext failed');
    const clientMessage = isD1Unavailable
      ? 'アクセス権限を一時的に確認できません。時間をおいて再度お試しください。'
      : 'アクセス権限を確認できませんでした。時間をおいて再度お試しください。';
    const statusCode = isD1Unavailable ? 503 : 403;
    captureDiagnostics(config, 'error', 'resolve_access_context_failed', {
      event: 'resolve_access_context_failed',
      requestId,
      route,
      email: tokenDetails.email || '',
      orgId: accessContext?.orgId || '',
      userId: accessContext?.userId || '',
      detail: diagnosticMessage,
      httpStatus: err && err.httpStatus ? err.httpStatus : '',
      cfRay: clientMeta.cfRay,
    });
    return errorResponse(
      statusCode,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      isD1Unavailable ? 'd1_unavailable' : 'resolve_access_context_failed',
      clientMessage,
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
    await recordAuthEvent(env, {
      eventType: 'authorization.denied',
      outcome: 'denied',
      reasonCode: accessContext.reasonCode || 'access_denied',
      requestId,
      authAttemptId: authorizationAttemptId,
      route,
      source: 'api_authorization',
      sessionId: sessionContext.id,
      idempotencyScope: accessContext.reasonCode || 'access_denied',
      user: tokenDetails,
      userId: accessContext.userId || '',
      orgId: accessContext.orgId || '',
      status: accessContext.status || '',
      role: accessContext.role || '',
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
  if (!accessContext.orgId) {
    await recordAuthEvent(env, {
      eventType: 'authorization.denied',
      outcome: 'denied',
      reasonCode: 'no_membership',
      requestId,
      authAttemptId: authorizationAttemptId,
      route,
      source: 'api_authorization',
      sessionId: sessionContext.id,
      idempotencyScope: 'no_membership',
      user: tokenDetails,
      userId: accessContext.userId || '',
      status: accessContext.status || '',
      role: accessContext.role || '',
    });
    return errorResponse(
      403,
      allowedOrigin || config.allowedOrigins[0] || '*',
      requestId,
      'cf-api',
      'no_membership',
      '所属組織が確認できません。管理者にお問い合わせください。',
      null,
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
      await recordAuthEvent(env, {
        eventType: 'authorization.role_denied',
        outcome: 'denied',
        reasonCode: 'role_not_allowed',
        requestId,
        authAttemptId: authorizationAttemptId,
        route,
        source: 'api_authorization',
        sessionId: sessionContext.id,
        idempotencyScope: route,
        user: tokenDetails,
        userId: accessContext.userId || '',
        orgId: accessContext.orgId || '',
        status: accessContext.status || '',
        role: accessContext.role || '',
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
  let binaryUpload = null;
  let releaseStagedUploadSlot = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type') || '';
    if (STAGED_ATTACHMENT_ROUTES.has(route)) {
      const purpose = normalizeStagedAttachmentPurpose(
        route,
        request.headers.get('x-shiftflow-attachment-purpose') || ''
      );
      if (!purpose) {
        return errorResponse(
          400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'attachment_purpose_invalid',
          '添付の用途は message または profile を指定してください。',
          null,
          mergeHeaders()
        );
      }
      const mimeType = contentType.split(';', 1)[0].trim().toLowerCase();
      if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
        return errorResponse(
          415,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'unsupported_mime_type',
          '未対応の画像形式です。PNG/JPEG 等の画像を使用してください。',
          null,
          mergeHeaders()
        );
      }
      releaseStagedUploadSlot = tryAcquireStagedUploadSlot();
      if (!releaseStagedUploadSlot) {
        return errorResponse(
          429,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'staged_upload_busy',
          '同時アップロード数が上限に達しています。完了後に再試行してください。',
          null,
          mergeHeaders()
        );
      }
      const maxBytes = resolveStagedAttachmentMaxBytes(purpose);
      let bodyResult;
      try {
        bodyResult = await readRequestBytesWithLimit(request, maxBytes);
      } catch (_error) {
        releaseStagedUploadSlot();
        releaseStagedUploadSlot = null;
        return errorResponse(
          400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'attachment_body_read_failed',
          '添付ファイルを読み取れませんでした。もう一度選択してください。',
          null,
          mergeHeaders()
        );
      }
      if (!bodyResult.ok) {
        releaseStagedUploadSlot();
        releaseStagedUploadSlot = null;
        const bodyTooLarge = bodyResult.code === 'request_body_too_large';
        return errorResponse(
          bodyResult.status || 400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          bodyResult.code || 'invalid_request_body',
          bodyTooLarge
            ? `添付ファイルが大きすぎます。${Math.floor(maxBytes / (1024 * 1024))}MB 以下にしてください。`
            : '添付ファイルのサイズ情報と実データが一致しません。もう一度選択してください。',
          null,
          mergeHeaders()
        );
      }
      if (!bodyResult.sizeBytes) {
        releaseStagedUploadSlot();
        releaseStagedUploadSlot = null;
        return errorResponse(
          400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'attachment_data_missing',
          '添付ファイルのデータが空です。',
          null,
          mergeHeaders()
        );
      }
      // bounded readerはoffset 0の専用bufferを返すため、digest前の同サイズcopyは不要。
      let checksum;
      try {
        checksum = await computeSha256Hex(bodyResult.bytes.buffer);
      } catch (_error) {
        releaseStagedUploadSlot();
        releaseStagedUploadSlot = null;
        return errorResponse(
          503,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'attachment_checksum_unavailable',
          '添付ファイルの整合性を確認できませんでした。後ほど再試行してください。',
          null,
          mergeHeaders()
        );
      }
      const clientChecksum = String(
        request.headers.get('x-shiftflow-content-sha256') || ''
      )
        .trim()
        .toLowerCase();
      if (clientChecksum && (!/^[0-9a-f]{64}$/.test(clientChecksum) || clientChecksum !== checksum)) {
        releaseStagedUploadSlot();
        releaseStagedUploadSlot = null;
        return errorResponse(
          400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          'attachment_checksum_mismatch',
          '添付ファイルの整合性を確認できませんでした。もう一度選択してください。',
          null,
          mergeHeaders()
        );
      }
      const fileName = decodeStagedFileName(
        request.headers.get('x-shiftflow-file-name') || '',
        purpose === 'profile' ? 'profile' : 'attachment'
      );
      binaryUpload = {
        bytes: bodyResult.bytes,
        purpose,
        mimeType,
        fileName,
        sizeBytes: bodyResult.sizeBytes,
        checksum,
      };
      parsedJsonBody = { purpose, mimeType, fileName, sizeBytes: bodyResult.sizeBytes, checksum };
    } else if (contentType.includes('application/json')) {
      const bodyResult = await readRequestBytesWithLimit(request, API_JSON_BODY_MAX_BYTES);
      if (!bodyResult.ok) {
        return errorResponse(
          bodyResult.status || 400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          bodyResult.code || 'invalid_request_body',
          bodyResult.code === 'request_body_too_large'
            ? 'リクエストが大きすぎます。添付ファイルは先に一時アップロードしてください。'
            : 'リクエストのサイズ情報と実データが一致しません。',
          null,
          mergeHeaders()
        );
      }
      try {
        const raw = new TextDecoder().decode(bodyResult.bytes);
        parsedJsonBody = raw ? JSON.parse(raw) : {};
      } catch (err) {
        logAuthError('Failed to parse JSON body', {
          requestId,
          route,
          reasonCode: 'invalid_json',
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
    } else {
      // Non-JSON bodies are currently unsupported for API routes.
      const bodyResult = await readRequestBytesWithLimit(request, API_JSON_BODY_MAX_BYTES);
      if (!bodyResult.ok) {
        return errorResponse(
          bodyResult.status || 400,
          allowedOrigin || config.allowedOrigins[0] || '*',
          requestId,
          'cf-api',
          bodyResult.code || 'invalid_request_body',
          'リクエストが大きすぎるか、サイズ情報が一致しません。',
          null,
          mergeHeaders()
        );
      }
      const raw = new TextDecoder().decode(bodyResult.bytes);
      parsedJsonBody = { raw };
    }
  }

  const pushSession = { fingerprint: await sha256(sessionContext.id), expiresAt: Date.now() + getSessionCookieMaxAge(sessionRecord) * 1000 };
  if (isPushConfigured(env)) {
    try { await renewNotificationSession(env.DB, accessContext, pushSession); }
    catch (_) { console.warn('[ShiftFlow][Push]', { code: 'push_session_renewal_unavailable' }); }
  }
  const idempotencyContext = {
    bound: false,
    inserted: false,
    replay: false,
    conflict: false,
    keyId: '',
    payloadSha256: '',
    createdAtMs: 0,
    expiresAtMs: 0,
  };
  let d1Response;
  try {
    d1Response = await maybeHandleRouteWithD1({
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
      idempotencyContext,
      binaryUpload,
      pushSession,
    });
  } finally {
    if (releaseStagedUploadSlot) {
      releaseStagedUploadSlot();
      releaseStagedUploadSlot = null;
    }
  }

  if (d1Response && d1Response.status < 400 && isPushConfigured(env) &&
      ['addNewTask','updateTask','completeTask','addNewMessage','addNewComment','testPushNotification'].includes(route)) {
    const delivery = drainNotifications(env, { maintenance: false }).catch(() => {
      console.warn('[ShiftFlow][Push]', { code: 'push_dispatch_unavailable' });
    });
    if (typeof context.waitUntil === 'function') context.waitUntil(delivery);
    else await delivery;
  }
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

  if (d1Response.status >= 500) {
    let failureCode = 'api_response_failed';
    try {
      const failurePayload = await d1Response.clone().json();
      const candidate = String(failurePayload?.code || '').trim();
      if (candidate && candidate.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(candidate)) {
        failureCode = candidate;
      }
    } catch (_ignore) {
      // response codeがないbinary/empty応答もgeneric codeで診断する。
    }
    captureDiagnostics(config, 'error', failureCode, {
      event: failureCode,
      requestId,
      route,
      status: String(d1Response.status),
      httpStatus: d1Response.status,
      orgId: accessContext.orgId || '',
      userId: accessContext.userId || '',
      detail: failureCode,
      cfRay: clientMeta.cfRay,
    });
  }

  // Route-level RBACを通過した後のobject-level拒否も認証監査へ残す。
  // 404はtenant/objectの存在を隠す契約を含むため、一律に拒否イベントへ変換しない。
  if (d1Response.status === 403) {
    let reasonCode = 'resource_access_denied';
    try {
      const denialPayload = await d1Response.clone().json();
      const candidate = String(denialPayload?.code || '').trim();
      if (candidate && candidate.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(candidate)) {
        reasonCode = candidate;
      }
    } catch (_ignore) {
      // 応答本文を監査の必須条件にしない。
    }
    await recordAuthEvent(env, {
      eventType: 'authorization.denied',
      outcome: 'denied',
      reasonCode,
      requestId,
      authAttemptId: authorizationAttemptId,
      route,
      source: 'api_resource_authorization',
      sessionId: sessionContext.id,
      idempotencyScope: reasonCode,
      user: tokenDetails,
      userId: accessContext.userId || '',
      orgId: accessContext.orgId || '',
      status: accessContext.status || '',
      role: accessContext.role || '',
    });
  }

  if (
    d1Response.status >= 400 &&
    d1Response.status < 500 &&
    idempotencyContext.inserted &&
    !idempotencyContext.conflict &&
    !idempotencyContext.replay
  ) {
    let responseCode = '';
    try {
      const responsePayload = await d1Response.clone().json();
      responseCode = String(responsePayload?.code || '').trim();
    } catch (_ignore) {
      // codeが読めない通常4xxも、今回新規作成したkeyだけを解放する。
    }
    const protectedCodes = new Set(['idempotency_key_reused', 'idempotency_replay']);
    if (!protectedCodes.has(responseCode)) {
      try {
        await releaseInsertedApiIdempotencyKey(env?.DB || null, {
          inserted: idempotencyContext.inserted,
          orgId: accessContext.orgId || '',
          actorUserId: accessContext.userId || '',
          requestId,
          route,
          keyId: idempotencyContext.keyId,
          payloadSha256: idempotencyContext.payloadSha256,
          createdAtMs: idempotencyContext.createdAtMs,
          expiresAtMs: idempotencyContext.expiresAtMs,
        });
      } catch (_error) {
        captureDiagnostics(config, 'error', 'idempotency_release_failed', {
          event: 'idempotency_release_failed',
          requestId,
          route,
          orgId: accessContext.orgId || '',
          userId: accessContext.userId || '',
          detail: 'idempotency_release_failed',
        });
      }
    }
  }

  if (sessionCookieHeader) {
    d1Response.headers.delete('Set-Cookie');
    (Array.isArray(sessionCookieHeader) ? sessionCookieHeader : [sessionCookieHeader]).forEach(
      (cookieValue) => d1Response.headers.append('Set-Cookie', cookieValue)
    );
  }
  return d1Response;
}
