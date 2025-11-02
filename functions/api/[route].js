import { loadConfig, getRoutePermissions } from './config';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const DIAGNOSTIC_ROUTE = 'logAuthProxyEvent';
const ACCESS_CACHE = new Map();
const CORS_ALLOWED_HEADERS = 'Content-Type,Authorization,X-ShiftFlow-Request-Id';
const CORS_EXPOSE_HEADERS = 'X-ShiftFlow-Request-Id,X-ShiftFlow-Cache';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PROFILE_PLACEHOLDER_URL = 'https://placehold.jp/150x150.png';

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
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
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

const CACHE_TTL_SECONDS = 300;
const CACHEABLE_ROUTES = {
  getBootstrapData: { flagKey: 'cacheBootstrap' },
  getHomeContent: { flagKey: 'cacheHome' },
};
const CACHE_INVALIDATION_ROUTES = {
  getBootstrapData: new Set([
    'saveUserSettings',
    'clearCache',
    'addNewTask',
    'updateTask',
    'completeTask',
    'deleteTaskById',
    'addNewMessage',
    'deleteMessageById',
  ]),
  getHomeContent: new Set([
    'addNewTask',
    'updateTask',
    'completeTask',
    'deleteTaskById',
    'toggleMemoRead',
    'markMemosReadBulk',
    'markMemoAsRead',
    'addNewMessage',
    'deleteMessageById',
  ]),
};

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

function shouldUseKvCache(route, flags) {
  if (!route || !flags) return null;
  const config = CACHEABLE_ROUTES[route];
  if (!config) return null;
  const enabled = !!flags[config.flagKey];
  if (!enabled) return null;
  return { ttlSeconds: CACHE_TTL_SECONDS };
}

function buildKvCacheKey(route, emailOrSub) {
  const identity = emailOrSub ? emailOrSub.toLowerCase() : 'anonymous';
  return `shiftflow:cache:${route}:${identity}`;
}

async function readKvCache(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.body !== 'string') return null;
    return parsed;
  } catch (err) {
    console.warn('[ShiftFlow][Cache] Failed to read KV cache', {
      key,
      error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

async function writeKvCache(kv, key, record, ttlSeconds) {
  try {
    await kv.put(
      key,
      JSON.stringify({
        status: record.status,
        body: record.body,
        contentType: record.contentType,
        storedAt: Date.now(),
      }),
      { expirationTtl: ttlSeconds }
    );
  } catch (err) {
    console.warn('[ShiftFlow][Cache] Failed to write KV cache', {
      key,
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function invalidateKvCacheForUser(kv, routes, email) {
  if (!kv || !Array.isArray(routes) || !routes.length) return;
  const identity = email ? email.toLowerCase() : 'anonymous';
  for (const route of routes) {
    const key = buildKvCacheKey(route, identity);
    try {
      await kv.delete(key);
    } catch (err) {
      console.warn('[ShiftFlow][Cache] Failed to delete KV cache', {
        key,
        error: err && err.message ? err.message : String(err),
      });
    }
  }
}

function resolveInvalidationTargets(route) {
  const routes = [];
  if (
    CACHE_INVALIDATION_ROUTES.getBootstrapData &&
    CACHE_INVALIDATION_ROUTES.getBootstrapData.has(route)
  ) {
    routes.push('getBootstrapData');
  }
  if (
    CACHE_INVALIDATION_ROUTES.getHomeContent &&
    CACHE_INVALIDATION_ROUTES.getHomeContent.has(route)
  ) {
    routes.push('getHomeContent');
  }
  return routes;
}

function buildCacheResponse(cached, origin, requestId) {
  const headers = new Headers({
    ...corsHeaders(origin),
    'Content-Type': cached.contentType || 'application/json',
    'X-ShiftFlow-Request-Id': requestId,
    'X-ShiftFlow-Cache': 'HIT',
  });
  return new Response(cached.body, {
    status: cached.status || 200,
    headers,
  });
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

async function maybeHandleRouteWithD1(options) {
  if (!options) return null;
  const { route, flags, db, requestId, allowedOrigin, config, tokenDetails, accessContext } =
    options;
  if (!db) return null;
  const preferD1 = !!(flags && (flags.d1Primary || flags.d1Read));
  if (!preferD1) return null;
  const normalizedRoute = typeof route === 'string' ? route.trim() : '';
  if (!normalizedRoute) return null;

  try {
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
      return jsonResponse(
        200,
        { ok: true, result: mapped },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
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
        return jsonResponse(
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
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
      return jsonResponse(
        200,
        { ok: true, result },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
    }
    if (normalizedRoute === 'listMyTasks') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const totalRow = await db.prepare('SELECT COUNT(*) AS count FROM tasks').first();
      const totalTasks =
        typeof totalRow?.count === 'number'
          ? totalRow.count
          : typeof totalRow?.['COUNT(*)'] === 'number'
          ? totalRow['COUNT(*)']
          : 0;
      if (!normalizedEmail) {
        const emptyPayload = {
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
        return jsonResponse(
          200,
          { ok: true, result: emptyPayload },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
        );
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
      const responsePayload = {
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
      return jsonResponse(
        200,
        { ok: true, result: responsePayload },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
    }
    if (normalizedRoute === 'listCreatedTasks') {
      const rawEmail = tokenDetails?.email || accessContext?.email || '';
      const normalizedEmail = normalizeEmailValue(rawEmail);
      const filterArg =
        options.parsedBody &&
        Array.isArray(options.parsedBody.args) &&
        options.parsedBody.args.length
          ? options.parsedBody.args[0] || {}
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
        return jsonResponse(
          200,
          { ok: true, result: { tasks: [], meta: { statuses: [] } } },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
      return jsonResponse(
        200,
        { ok: true, result: responsePayload },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
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
        return jsonResponse(
          200,
          { ok: true, result: responsePayload },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
        );
      }
      const filterArg =
        options.parsedBody &&
        Array.isArray(options.parsedBody.args) &&
        options.parsedBody.args.length
          ? options.parsedBody.args[0] || {}
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
      return jsonResponse(
        200,
        { ok: true, result: responsePayload },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
    }
    if (normalizedRoute === 'getTaskById') {
      const args =
        options.parsedBody &&
        Array.isArray(options.parsedBody.args) &&
        options.parsedBody.args.length
          ? options.parsedBody.args
          : [];
      const rawTaskId = args.length ? args[0] : options.query?.get('taskId') || '';
      const taskId = normalizeIdValue(rawTaskId);
      if (!taskId) {
        return jsonResponse(
          200,
          { ok: true, result: null },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
        return jsonResponse(
          200,
          { ok: true, result: null },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
      return jsonResponse(
        200,
        { ok: true, result: detail },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
    }
    if (normalizedRoute === 'getMessages') {
      const args =
        options.parsedBody &&
        Array.isArray(options.parsedBody.args) &&
        options.parsedBody.args.length
          ? options.parsedBody.args[0] || {}
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
      return jsonResponse(
        200,
        { ok: true, result: payload },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
    }
    if (normalizedRoute === 'getMessageById') {
      const args =
        options.parsedBody &&
        Array.isArray(options.parsedBody.args) &&
        options.parsedBody.args.length
          ? options.parsedBody.args
          : [];
      const rawMessageId = args.length ? args[0] : options.query?.get('memoId') || '';
      const messageId = normalizeIdValue(rawMessageId);
      if (!messageId) {
        return jsonResponse(
          200,
          { ok: true, result: null },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
        return jsonResponse(
          200,
          { ok: true, result: null },
          allowedOrigin,
          {
            'X-ShiftFlow-Request-Id': requestId,
            'X-ShiftFlow-Cache': 'BYPASS',
            'X-ShiftFlow-Backend': 'D1',
          }
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
      for (const row of readRows) {
        const email = row?.email ? String(row.email).trim() : '';
        const displayName = row?.display_name ? String(row.display_name).trim() : '';
        if (email) {
          readSet.add(normalizeEmailValue(email));
          readUsers.push(buildUserLabel(email, displayName));
        }
      }
      const membership = await resolveMembershipForEmail(
        db,
        normalizeEmailValue(tokenDetails?.email || accessContext?.email || '')
      );
      const orgId = messageRow?.org_id || membership?.org_id || messageRow?.author_org_id || null;
      const activeUsers = await fetchActiveUsersForOrg(db, orgId);
      const unreadUsers = [];
      for (const user of activeUsers) {
        const normalizedEmail = normalizeEmailValue(user.email);
        if (normalizedEmail && readSet.has(normalizedEmail)) continue;
        unreadUsers.push(buildUserLabel(user.email, user.displayName));
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
        canDelete,
        attachments,
      };
      return jsonResponse(
        200,
        { ok: true, result: detail },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
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
      return jsonResponse(
        200,
        { ok: true, result: payload },
        allowedOrigin,
        {
          'X-ShiftFlow-Request-Id': requestId,
          'X-ShiftFlow-Cache': 'BYPASS',
          'X-ShiftFlow-Backend': 'D1',
        }
      );
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
    const userEmail = tokenDetails.email || accessContext.email || '';
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
    } else if (dualWriteContext.type === 'task') {
      await insertTaskIntoD1(env.DB, {
        taskId: dualWriteContext.taskId,
        payload: dualWriteContext.payload,
        timestampMs: dualWriteContext.timestampMs,
        authorEmail: tokenDetails.email,
        role: accessContext.role,
      });
      captureDiagnostics(config, 'info', 'dual_write_task_success', {
        event: 'dual_write_task_success',
        route,
        requestId,
        email: tokenDetails.email || '',
        taskId: dualWriteContext.taskId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'task_update') {
      await updateTaskInD1(env.DB, {
        taskId: dualWriteContext.taskId,
        payload: dualWriteContext.payload,
        timestampMs: dualWriteContext.timestampMs,
      });
      captureDiagnostics(config, 'info', 'dual_write_task_update_success', {
        event: 'dual_write_task_update_success',
        route,
        requestId,
        email: userEmail || '',
        taskId: dualWriteContext.taskId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'task_complete') {
      await completeTaskInD1(env.DB, {
        taskId: dualWriteContext.taskId,
        timestampMs: dualWriteContext.timestampMs,
      });
      captureDiagnostics(config, 'info', 'dual_write_task_complete_success', {
        event: 'dual_write_task_complete_success',
        route,
        requestId,
        email: userEmail || '',
        taskId: dualWriteContext.taskId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'memo_read_toggle') {
      await toggleMemoReadInD1(env.DB, {
        messageId: dualWriteContext.messageId,
        shouldRead: dualWriteContext.shouldRead,
        timestampMs: dualWriteContext.timestampMs,
        email: userEmail,
      });
      captureDiagnostics(config, 'info', 'dual_write_memo_read_success', {
        event: 'dual_write_memo_read_success',
        route,
        requestId,
        email: userEmail || '',
        messageId: dualWriteContext.messageId,
        shouldRead: dualWriteContext.shouldRead,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'task_delete') {
      await deleteTaskFromD1(env.DB, {
        taskId: dualWriteContext.taskId,
      });
      captureDiagnostics(config, 'info', 'dual_write_task_delete_success', {
        event: 'dual_write_task_delete_success',
        route,
        requestId,
        email: userEmail || '',
        taskId: dualWriteContext.taskId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'message_delete') {
      await deleteMessageFromD1(env.DB, {
        messageId: dualWriteContext.messageId,
      });
      captureDiagnostics(config, 'info', 'dual_write_message_delete_success', {
        event: 'dual_write_message_delete_success',
        route,
        requestId,
        email: userEmail || '',
        messageId: dualWriteContext.messageId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'memo_mark_read') {
      await ensureMemoReadInD1(env.DB, {
        messageId: dualWriteContext.messageId,
        timestampMs: dualWriteContext.timestampMs,
        email: userEmail,
      });
      captureDiagnostics(config, 'info', 'dual_write_memo_mark_read_success', {
        event: 'dual_write_memo_mark_read_success',
        route,
        requestId,
        email: userEmail || '',
        messageId: dualWriteContext.messageId,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'memo_mark_read_bulk') {
      await bulkEnsureMemoReadInD1(env.DB, {
        messageIds: Array.isArray(dualWriteContext.messageIds) ? dualWriteContext.messageIds : [],
        timestampMs: dualWriteContext.timestampMs,
        email: userEmail,
      });
      captureDiagnostics(config, 'info', 'dual_write_memo_mark_read_bulk_success', {
        event: 'dual_write_memo_mark_read_bulk_success',
        route,
        requestId,
        email: userEmail || '',
        targetCount: Array.isArray(dualWriteContext.messageIds)
          ? dualWriteContext.messageIds.length
          : 0,
        cfRay: clientMeta?.cfRay || '',
      });
    } else if (dualWriteContext.type === 'user_settings') {
      const finalTheme =
        dualWriteContext.payload?.theme ||
        (responseJson && typeof responseJson.theme === 'string' ? responseJson.theme : undefined);
      const finalName =
        dualWriteContext.payload?.name ||
        (responseJson && typeof responseJson.name === 'string' ? responseJson.name : undefined);
      const finalImageUrl =
        (responseJson && typeof responseJson.imageUrl === 'string'
          ? responseJson.imageUrl
          : undefined) ||
        (dualWriteContext.payload?.imageUrl && !dualWriteContext.payload.hasImageData
          ? dualWriteContext.payload.imageUrl
          : undefined);
      await updateUserSettingsInD1(env.DB, {
        email: userEmail,
        name: finalName,
        theme: finalTheme,
        imageUrl: finalImageUrl,
        timestampMs: dualWriteContext.timestampMs,
      });
      captureDiagnostics(config, 'info', 'dual_write_user_settings_success', {
        event: 'dual_write_user_settings_success',
        route,
        requestId,
        email: userEmail || '',
        theme: finalTheme || '',
        cfRay: clientMeta?.cfRay || '',
      });
    }
  } catch (err) {
    console.error('[ShiftFlow][DualWrite] Failed to replicate to D1', {
      route,
      requestId,
      entityType: dualWriteContext.type,
      messageId: dualWriteContext.messageId,
      taskId: dualWriteContext.taskId,
      shouldRead: dualWriteContext.shouldRead,
      error: err && err.message ? err.message : String(err),
    });
    captureDiagnostics(config, 'error', 'dual_write_failure', {
      event: 'dual_write_failure',
      route,
      requestId,
      email: tokenDetails.email || '',
      entityType: dualWriteContext.type,
      messageId: dualWriteContext.messageId,
      taskId: dualWriteContext.taskId,
      shouldRead: dualWriteContext.shouldRead,
      detail: err && err.message ? err.message : String(err),
      cfRay: clientMeta?.cfRay || '',
    });
  }
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

async function deleteTaskFromD1(db, context) {
  if (!context?.taskId) return;
  const taskId = normalizeIdValue(context.taskId);
  if (!taskId) return;
  await db.prepare('DELETE FROM task_assignees WHERE task_id = ?1').bind(taskId).run();
  await db.prepare('DELETE FROM task_attachments WHERE task_id = ?1').bind(taskId).run();
  await db.prepare('DELETE FROM tasks WHERE task_id = ?1').bind(taskId).run();
}

async function deleteMessageFromD1(db, context) {
  if (!context?.messageId) return;
  const messageId = normalizeIdValue(context.messageId);
  if (!messageId) return;
  await db.prepare('DELETE FROM message_reads WHERE message_id = ?1').bind(messageId).run();
  await db.prepare('DELETE FROM message_attachments WHERE message_id = ?1')
    .bind(messageId)
    .run();
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
  const cacheKey = tokenDetails.sub ? tokenDetails.sub : null;
  const cached = cacheKey ? ACCESS_CACHE.get(cacheKey) : null;
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
  if (cacheKey) {
    const expiresAt = Math.min(
      tokenDetails.expMs ? tokenDetails.expMs - 5_000 : now + ttlMs,
      now + ttlMs
    );
    ACCESS_CACHE.set(cacheKey, {
      context,
      expiresAt,
    });
  }
  return context;
}

export async function onRequest(context) {
  const { request, params, env } = context;
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
  if (!token) {
    logAuthError('Missing Authorization bearer token', { requestId, route });
    return jsonResponse(
      401,
      { ok: false, error: 'Unauthorized', detail: 'Missing Authorization bearer token.' },
      allowedOrigin || config.allowedOrigins[0] || '*',
      { 'X-ShiftFlow-Request-Id': requestId }
    );
  }

  if (flags.cfAuth) {
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
  } else {
    tokenDetails = createLegacyTokenDetails(token);
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
      return jsonResponse(
        403,
        { ok: false, error: '権限がありません。' },
        allowedOrigin || config.allowedOrigins[0] || '*',
        { 'X-ShiftFlow-Request-Id': requestId }
      );
    }
  }

  const cacheSettings = shouldUseKvCache(route, flags);
  const hasKvStore = !!env && !!env.APP_KV;
  const cacheIdentitySource =
    (accessContext.email && accessContext.email.trim()) ||
    (tokenDetails.email && tokenDetails.email.trim()) ||
    (tokenDetails.sub && tokenDetails.sub.trim()) ||
    'anonymous';
  const cacheIdentity = cacheIdentitySource.toLowerCase();
  const invalidationTargets = resolveInvalidationTargets(route);
  let cacheKey = null;
  let cacheStatus = 'BYPASS';
  if (cacheSettings && hasKvStore) {
    cacheKey = buildKvCacheKey(route, cacheIdentity);
    const cachedRecord = await readKvCache(env.APP_KV, cacheKey);
    if (cachedRecord) {
      logAuthInfo('Serving response from KV cache', {
        requestId,
        route,
        cacheKey,
      });
      return buildCacheResponse(
        cachedRecord,
        allowedOrigin || config.allowedOrigins[0] || '*',
        requestId
      );
    }
    cacheStatus = 'MISS';
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
  upstreamUrl.searchParams.set('__userEmail', tokenDetails.email || '');
  upstreamUrl.searchParams.set('__userSub', tokenDetails.sub || '');
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
      'X-ShiftFlow-Email': tokenDetails.email || '',
      'X-ShiftFlow-Sub': tokenDetails.sub || '',
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

  let parsedJsonBody = null;
  let rawBodyToForward = null;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const contentType = request.headers.get('content-type');
    const originalContentType = contentType || '';
    if (originalContentType) {
      init.headers['Content-Type'] = originalContentType;
    }
    rawBodyToForward = await request.text();
    if (rawBodyToForward && originalContentType.includes('application/json')) {
      try {
        parsedJsonBody = JSON.parse(rawBodyToForward) || {};
        if (authorizationHeader) {
          if (parsedJsonBody && typeof parsedJsonBody === 'object') {
            if (!parsedJsonBody.authorization) {
              parsedJsonBody.authorization = authorizationHeader;
            }
            if (!parsedJsonBody.headers || typeof parsedJsonBody.headers !== 'object') {
              parsedJsonBody.headers = {};
            }
            if (!parsedJsonBody.headers.Authorization) {
              parsedJsonBody.headers.Authorization = authorizationHeader;
            }
          }
        }
        const interception = interceptRequestBodyForRoute(route, parsedJsonBody, {
          flags,
          tokenDetails,
          accessContext,
        });
        const bodyToForward = interception ? interception.body : parsedJsonBody;
        if (interception && interception.dualWriteContext) {
          dualWriteContext = interception.dualWriteContext;
        }
        parsedJsonBody = bodyToForward || {};
        rawBodyToForward = JSON.stringify(bodyToForward);
        init.headers['Content-Type'] = 'application/json';
      } catch (_err) {
        // Leave body as-is if JSON parsing fails.
        parsedJsonBody = null;
      }
    }
    init.body = rawBodyToForward;
  }

  if ((flags.d1Primary || flags.d1Read) && env && env.DB) {
    const d1Response = await maybeHandleRouteWithD1({
      route,
      flags,
      db: env.DB,
      requestId,
      allowedOrigin: allowedOrigin || config.allowedOrigins[0] || '*',
      config,
      tokenDetails,
      accessContext,
      requestMethod: request.method,
      parsedBody: parsedJsonBody,
      query: originalUrl.searchParams,
      clientMeta,
    });
    if (d1Response) {
      return d1Response;
    }
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

  const responseForCache = cacheSettings && hasKvStore ? upstreamResponse.clone() : null;

  if (hasKvStore && invalidationTargets.length && upstreamResponse.ok) {
    await invalidateKvCacheForUser(env.APP_KV, invalidationTargets, cacheIdentitySource);
  }

  if (
    cacheSettings &&
    hasKvStore &&
    cacheKey &&
    cacheStatus === 'MISS' &&
    upstreamResponse.ok &&
    responseForCache
  ) {
    try {
      const cacheBodyText = await responseForCache.text();
      await writeKvCache(
        env.APP_KV,
        cacheKey,
        {
          status: upstreamResponse.status,
          body: cacheBodyText,
          contentType: upstreamResponse.headers.get('content-type') || 'application/json',
        },
        cacheSettings.ttlSeconds
      );
      logAuthInfo('Stored response in KV cache', {
        requestId,
        route,
        cacheKey,
        ttl: cacheSettings.ttlSeconds,
      });
    } catch (err) {
      console.warn('[ShiftFlow][Cache] Failed to cache response', {
        cacheKey,
        error: err && err.message ? err.message : String(err),
      });
    }
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
  responseHeaders.set('X-ShiftFlow-Cache', cacheStatus);
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
