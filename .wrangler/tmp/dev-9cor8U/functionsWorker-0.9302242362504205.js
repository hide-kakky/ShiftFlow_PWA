var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/pages-lFDSpN/functionsWorker-0.9302242362504205.mjs
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
function loadConfig(env) {
  const cfOrigin = (env?.CF_ORIGIN || "").trim();
  const gasUrl = (env?.GAS_EXEC_URL || env?.GAS_WEB_APP_URL || "").trim();
  const googleClientId = (env?.GOOGLE_OAUTH_CLIENT_ID || env?.GOOGLE_CLIENT_ID || "").trim();
  const sharedSecret = (env?.SHIFT_FLOW_SHARED_SECRET || env?.GAS_SHARED_SECRET || "").trim();
  const flags2 = readFeatureFlags(env);
  if (!cfOrigin) {
    throw new Error("CF_ORIGIN is not configured. Set it in Cloudflare Pages environment variables.");
  }
  if (!gasUrl) {
    throw new Error(
      "GAS_EXEC_URL is not configured. Set it in Cloudflare Pages environment variables."
    );
  }
  try {
    const parsedGasUrl = new URL(gasUrl);
    if (parsedGasUrl.hostname.endsWith("googleusercontent.com") && parsedGasUrl.pathname.includes("/macros/echo")) {
      throw new Error(
        "GAS_EXEC_URL \u304C macros/echo \u30A8\u30F3\u30C9\u30DD\u30A4\u30F3\u30C8\u3092\u6307\u3057\u3066\u3044\u307E\u3059\u3002Apps Script \u306E Web \u30A2\u30D7\u30EA (/exec) URL \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
      );
    }
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    throw new Error("GAS_EXEC_URL \u306B\u6709\u52B9\u306A URL \u3092\u6307\u5B9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  }
  if (!googleClientId) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID is not configured. Set it in Cloudflare Pages environment variables."
    );
  }
  const allowedOrigins = cfOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);
  if (!allowedOrigins.length) {
    allowedOrigins.push(cfOrigin);
  }
  return {
    cfOrigin,
    allowedOrigins,
    gasUrl,
    googleClientId,
    sharedSecret,
    flags: flags2
  };
}
__name(loadConfig, "loadConfig");
__name2(loadConfig, "loadConfig");
function parseBooleanFlag(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}
__name(parseBooleanFlag, "parseBooleanFlag");
__name2(parseBooleanFlag, "parseBooleanFlag");
function readFeatureFlags(env) {
  return {
    cfAuth: parseBooleanFlag(env?.CFG_CF_AUTH),
    cacheBootstrap: parseBooleanFlag(env?.CFG_CACHE_BOOTSTRAP),
    cacheHome: parseBooleanFlag(env?.CFG_CACHE_HOME),
    d1Read: parseBooleanFlag(env?.CFG_D1_READ),
    d1Write: parseBooleanFlag(env?.CFG_D1_WRITE),
    d1Primary: parseBooleanFlag(env?.CFG_D1_PRIMARY)
  };
}
__name(readFeatureFlags, "readFeatureFlags");
__name2(readFeatureFlags, "readFeatureFlags");
var ROUTE_PERMISSIONS = {
  getBootstrapData: ["admin", "manager", "member"],
  getHomeContent: ["admin", "manager", "member"],
  listMyTasks: ["admin", "manager", "member"],
  listCreatedTasks: ["admin", "manager"],
  listAllTasks: ["admin", "manager"],
  getMessages: ["admin", "manager", "member"],
  getMessageById: ["admin", "manager", "member"],
  addNewMessage: ["admin", "manager", "member"],
  deleteMessageById: ["admin", "manager", "member"],
  toggleMemoRead: ["admin", "manager", "member"],
  markMemosReadBulk: ["admin", "manager", "member"],
  markMemoAsRead: ["admin", "manager", "member"],
  addNewTask: ["admin", "manager", "member"],
  updateTask: ["admin", "manager", "member"],
  completeTask: ["admin", "manager", "member"],
  deleteTaskById: ["admin", "manager", "member"],
  getTaskById: ["admin", "manager", "member"],
  getUserSettings: ["admin", "manager", "member", "guest"],
  saveUserSettings: ["admin", "manager", "member"],
  listActiveUsers: ["admin", "manager"],
  listActiveFolders: ["admin", "manager", "member"],
  clearCache: ["admin"],
  getAuditLogs: ["admin", "manager"]
};
function getRoutePermissions(routeName) {
  const normalized = String(routeName || "").trim();
  if (!normalized) return null;
  return ROUTE_PERMISSIONS[normalized] || null;
}
__name(getRoutePermissions, "getRoutePermissions");
__name2(getRoutePermissions, "getRoutePermissions");
var GOOGLE_ISSUERS = /* @__PURE__ */ new Set(["https://accounts.google.com", "accounts.google.com"]);
var TOKENINFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
var DIAGNOSTIC_ROUTE = "logAuthProxyEvent";
var ACCESS_CACHE = /* @__PURE__ */ new Map();
var CORS_ALLOWED_HEADERS = "Content-Type,Authorization,X-ShiftFlow-Request-Id";
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function logAuthInfo(message, meta) {
  if (meta) {
    console.info("[ShiftFlow][Auth]", message, meta);
  } else {
    console.info("[ShiftFlow][Auth]", message);
  }
}
__name(logAuthInfo, "logAuthInfo");
__name2(logAuthInfo, "logAuthInfo");
function logAuthError(message, meta) {
  if (meta) {
    console.error("[ShiftFlow][Auth]", message, meta);
  } else {
    console.error("[ShiftFlow][Auth]", message);
  }
}
__name(logAuthError, "logAuthError");
__name2(logAuthError, "logAuthError");
function pickAllowedOrigin(allowedOrigins, originHeader) {
  if (!allowedOrigins || !allowedOrigins.length) {
    return "*";
  }
  if (!originHeader) {
    return allowedOrigins[0];
  }
  const normalized = originHeader.trim();
  return allowedOrigins.includes(normalized) ? normalized : null;
}
__name(pickAllowedOrigin, "pickAllowedOrigin");
__name2(pickAllowedOrigin, "pickAllowedOrigin");
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
__name2(corsHeaders, "corsHeaders");
function jsonResponse(status, payload, origin, extraHeaders) {
  const headers = new Headers({
    "Content-Type": "application/json",
    ...corsHeaders(origin)
  });
  if (extraHeaders && typeof extraHeaders === "object") {
    Object.entries(extraHeaders).forEach(([key, value]) => {
      if (value !== void 0 && value !== null) {
        headers.set(key, String(value));
      }
    });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers
  });
}
__name(jsonResponse, "jsonResponse");
__name2(jsonResponse, "jsonResponse");
function createRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "req_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}
__name(createRequestId, "createRequestId");
__name2(createRequestId, "createRequestId");
function normalizeRedirectUrl(currentUrl, locationHeader) {
  if (!locationHeader) return null;
  try {
    return new URL(locationHeader, currentUrl).toString();
  } catch (_err) {
    return null;
  }
}
__name(normalizeRedirectUrl, "normalizeRedirectUrl");
__name2(normalizeRedirectUrl, "normalizeRedirectUrl");
function stripXssiPrefix(text) {
  if (typeof text !== "string") return text;
  if (!text) return text;
  let trimmed = text.replace(/^\s+/, "");
  if (trimmed.startsWith(")]}'")) {
    trimmed = trimmed.replace(/^\)\]\}'\s*/, "");
  }
  const firstBrace = trimmed.indexOf("{");
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
__name(stripXssiPrefix, "stripXssiPrefix");
__name2(stripXssiPrefix, "stripXssiPrefix");
function isLikelyHtmlDocument(text) {
  if (typeof text !== "string") return false;
  const sample = text.trim().slice(0, 200).toLowerCase();
  if (!sample) return false;
  return sample.startsWith("<!doctype html") || sample.startsWith("<html") || sample.includes("<body") || sample.includes("<head") || sample.includes("<meta") || sample.includes("<title");
}
__name(isLikelyHtmlDocument, "isLikelyHtmlDocument");
__name2(isLikelyHtmlDocument, "isLikelyHtmlDocument");
function generateMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
__name(generateMessageId, "generateMessageId");
__name2(generateMessageId, "generateMessageId");
function generateTaskId() {
  return generateMessageId();
}
__name(generateTaskId, "generateTaskId");
__name2(generateTaskId, "generateTaskId");
function normalizeEmailValue(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase();
}
__name(normalizeEmailValue, "normalizeEmailValue");
__name2(normalizeEmailValue, "normalizeEmailValue");
function parseTaskDueDate(value) {
  if (value === void 0 || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  let iso = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = `${raw}T00:00:00+09:00`;
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) {
    const normalized = raw.replace(/\//g, "-");
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
__name(parseTaskDueDate, "parseTaskDueDate");
__name2(parseTaskDueDate, "parseTaskDueDate");
function mapTaskStatus(value) {
  const raw = value === void 0 || value === null ? "" : String(value).trim();
  const lower = raw.toLowerCase();
  const mapping = {
    \u672A\u7740\u624B: "open",
    todo: "open",
    open: "open",
    \u9032\u884C\u4E2D: "in_progress",
    \u5BFE\u5FDC\u4E2D: "in_progress",
    in_progress: "in_progress",
    "in progress": "in_progress",
    \u5B9F\u884C\u4E2D: "in_progress",
    \u5B8C\u4E86: "completed",
    \u5B8C\u4E86\u6E08\u307F: "completed",
    completed: "completed",
    done: "completed",
    \u4FDD\u7559: "on_hold",
    on_hold: "on_hold",
    hold: "on_hold",
    pending: "pending",
    \u30AD\u30E3\u30F3\u30BB\u30EB: "canceled",
    canceled: "canceled",
    cancelled: "canceled"
  };
  return mapping[raw] || mapping[lower] || "open";
}
__name(mapTaskStatus, "mapTaskStatus");
__name2(mapTaskStatus, "mapTaskStatus");
function mapTaskPriority(value) {
  const raw = value === void 0 || value === null ? "" : String(value).trim();
  const lower = raw.toLowerCase();
  const mapping = {
    \u9AD8: "high",
    high: "high",
    \u4E2D: "medium",
    normal: "medium",
    medium: "medium",
    \u4F4E: "low",
    low: "low"
  };
  return mapping[raw] || mapping[lower] || "medium";
}
__name(mapTaskPriority, "mapTaskPriority");
__name2(mapTaskPriority, "mapTaskPriority");
function deriveTaskAssigneeEmails(payload, fallbackEmail) {
  const emails = /* @__PURE__ */ new Set();
  const addEmail = /* @__PURE__ */ __name2((candidate) => {
    const normalized = normalizeEmailValue(candidate);
    if (normalized) emails.add(normalized);
  }, "addEmail");
  if (payload) {
    if (Array.isArray(payload.assignees)) {
      payload.assignees.forEach(addEmail);
    }
    if (payload.assignee) {
      addEmail(payload.assignee);
    }
    if (typeof payload.assigneeEmail === "string") {
      addEmail(payload.assigneeEmail);
    }
    if (typeof payload.assigneeEmails === "string") {
      payload.assigneeEmails.split(/[,;、]/).map((item) => item.trim()).forEach(addEmail);
    }
  }
  if (!emails.size && fallbackEmail) {
    addEmail(fallbackEmail);
  }
  return Array.from(emails);
}
__name(deriveTaskAssigneeEmails, "deriveTaskAssigneeEmails");
__name2(deriveTaskAssigneeEmails, "deriveTaskAssigneeEmails");
function buildTaskMetaJson(payload) {
  if (!payload || typeof payload !== "object") return null;
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
__name(buildTaskMetaJson, "buildTaskMetaJson");
__name2(buildTaskMetaJson, "buildTaskMetaJson");
var CACHE_TTL_SECONDS = 300;
var CACHEABLE_ROUTES = {
  getBootstrapData: { flagKey: "cacheBootstrap" },
  getHomeContent: { flagKey: "cacheHome" }
};
var CACHE_INVALIDATION_ROUTES = {
  getBootstrapData: /* @__PURE__ */ new Set([
    "saveUserSettings",
    "clearCache",
    "addNewTask",
    "updateTask",
    "completeTask",
    "deleteTaskById",
    "addNewMessage",
    "deleteMessageById"
  ]),
  getHomeContent: /* @__PURE__ */ new Set([
    "addNewTask",
    "updateTask",
    "completeTask",
    "deleteTaskById",
    "toggleMemoRead",
    "markMemosReadBulk",
    "markMemoAsRead",
    "addNewMessage",
    "deleteMessageById"
  ])
};
function createLegacyTokenDetails(rawToken) {
  return {
    rawToken,
    sub: "",
    email: "",
    emailVerified: true,
    name: "",
    picture: "",
    hd: "",
    aud: "",
    iss: "",
    iat: 0,
    exp: 0,
    iatMs: void 0,
    expMs: void 0
  };
}
__name(createLegacyTokenDetails, "createLegacyTokenDetails");
__name2(createLegacyTokenDetails, "createLegacyTokenDetails");
function shouldUseKvCache(route, flags2) {
  if (!route || !flags2) return null;
  const config = CACHEABLE_ROUTES[route];
  if (!config) return null;
  const enabled = !!flags2[config.flagKey];
  if (!enabled) return null;
  return { ttlSeconds: CACHE_TTL_SECONDS };
}
__name(shouldUseKvCache, "shouldUseKvCache");
__name2(shouldUseKvCache, "shouldUseKvCache");
function buildKvCacheKey(route, emailOrSub) {
  const identity = emailOrSub ? emailOrSub.toLowerCase() : "anonymous";
  return `shiftflow:cache:${route}:${identity}`;
}
__name(buildKvCacheKey, "buildKvCacheKey");
__name2(buildKvCacheKey, "buildKvCacheKey");
async function readKvCache(kv, key) {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.body !== "string") return null;
    return parsed;
  } catch (err) {
    console.warn("[ShiftFlow][Cache] Failed to read KV cache", {
      key,
      error: err && err.message ? err.message : String(err)
    });
    return null;
  }
}
__name(readKvCache, "readKvCache");
__name2(readKvCache, "readKvCache");
async function writeKvCache(kv, key, record, ttlSeconds) {
  try {
    await kv.put(
      key,
      JSON.stringify({
        status: record.status,
        body: record.body,
        contentType: record.contentType,
        storedAt: Date.now()
      }),
      { expirationTtl: ttlSeconds }
    );
  } catch (err) {
    console.warn("[ShiftFlow][Cache] Failed to write KV cache", {
      key,
      error: err && err.message ? err.message : String(err)
    });
  }
}
__name(writeKvCache, "writeKvCache");
__name2(writeKvCache, "writeKvCache");
async function invalidateKvCacheForUser(kv, routes2, email) {
  if (!kv || !Array.isArray(routes2) || !routes2.length) return;
  const identity = email ? email.toLowerCase() : "anonymous";
  for (const route of routes2) {
    const key = buildKvCacheKey(route, identity);
    try {
      await kv.delete(key);
    } catch (err) {
      console.warn("[ShiftFlow][Cache] Failed to delete KV cache", {
        key,
        error: err && err.message ? err.message : String(err)
      });
    }
  }
}
__name(invalidateKvCacheForUser, "invalidateKvCacheForUser");
__name2(invalidateKvCacheForUser, "invalidateKvCacheForUser");
function resolveInvalidationTargets(route) {
  const routes2 = [];
  if (CACHE_INVALIDATION_ROUTES.getBootstrapData && CACHE_INVALIDATION_ROUTES.getBootstrapData.has(route)) {
    routes2.push("getBootstrapData");
  }
  if (CACHE_INVALIDATION_ROUTES.getHomeContent && CACHE_INVALIDATION_ROUTES.getHomeContent.has(route)) {
    routes2.push("getHomeContent");
  }
  return routes2;
}
__name(resolveInvalidationTargets, "resolveInvalidationTargets");
__name2(resolveInvalidationTargets, "resolveInvalidationTargets");
function buildCacheResponse(cached, origin, requestId) {
  const headers = new Headers({
    ...corsHeaders(origin),
    "Content-Type": cached.contentType || "application/json",
    "X-ShiftFlow-Request-Id": requestId,
    "X-ShiftFlow-Cache": "HIT"
  });
  return new Response(cached.body, {
    status: cached.status || 200,
    headers
  });
}
__name(buildCacheResponse, "buildCacheResponse");
__name2(buildCacheResponse, "buildCacheResponse");
function interceptRequestBodyForRoute(route, body, context) {
  if (!body || typeof body !== "object") {
    return { body, mutated: false, dualWriteContext: null };
  }
  const flags2 = context?.flags || {};
  if (route === "addNewMessage" && flags2.d1Write) {
    const mutatedBody = { ...body };
    let mutated = false;
    if (!mutatedBody.messageId || typeof mutatedBody.messageId !== "string") {
      mutatedBody.messageId = generateMessageId();
      mutated = true;
    }
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: "message",
        messageId: mutatedBody.messageId,
        payload: mutatedBody,
        timestampMs: Date.now()
      }
    };
  }
  if (route === "addNewTask" && flags2.d1Write) {
    const mutatedBody = { ...body };
    let mutated = false;
    if (!mutatedBody.taskId || typeof mutatedBody.taskId !== "string" || !mutatedBody.taskId.trim()) {
      mutatedBody.taskId = generateTaskId();
      mutated = true;
    } else {
      mutatedBody.taskId = mutatedBody.taskId.trim();
    }
    if (Array.isArray(mutatedBody.assignees)) {
      mutatedBody.assignees = mutatedBody.assignees.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
    }
    return {
      body: mutatedBody,
      mutated,
      dualWriteContext: {
        type: "task",
        taskId: mutatedBody.taskId,
        payload: mutatedBody,
        timestampMs: Date.now()
      }
    };
  }
  return { body, mutated: false, dualWriteContext: null };
}
__name(interceptRequestBodyForRoute, "interceptRequestBodyForRoute");
__name2(interceptRequestBodyForRoute, "interceptRequestBodyForRoute");
async function parseJsonResponseSafe(response) {
  if (!response) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }
  try {
    const text = await response.text();
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}
__name(parseJsonResponseSafe, "parseJsonResponseSafe");
__name2(parseJsonResponseSafe, "parseJsonResponseSafe");
async function performDualWriteIfNeeded(options) {
  const { env, config, route, requestId, tokenDetails, accessContext, dualWriteContext, responseJson, clientMeta } = options;
  const flags2 = config?.flags || {};
  if (!flags2.d1Write || !dualWriteContext) return;
  if (!env?.DB) {
    logAuthInfo("Dual write skipped because DB binding is missing", { route, requestId });
    return;
  }
  if (!responseJson || responseJson.success === false || responseJson.ok === false) {
    logAuthInfo("Dual write skipped due to upstream failure", {
      route,
      requestId,
      success: responseJson && responseJson.success
    });
    return;
  }
  try {
    if (dualWriteContext.type === "message") {
      await insertMessageIntoD1(env.DB, {
        messageId: dualWriteContext.messageId,
        payload: dualWriteContext.payload,
        timestampMs: dualWriteContext.timestampMs,
        authorEmail: tokenDetails.email,
        role: accessContext.role
      });
      captureDiagnostics(config, "info", "dual_write_message_success", {
        event: "dual_write_message_success",
        route,
        requestId,
        email: tokenDetails.email || "",
        messageId: dualWriteContext.messageId,
        cfRay: clientMeta?.cfRay || ""
      });
    } else if (dualWriteContext.type === "task") {
      await insertTaskIntoD1(env.DB, {
        taskId: dualWriteContext.taskId,
        payload: dualWriteContext.payload,
        timestampMs: dualWriteContext.timestampMs,
        authorEmail: tokenDetails.email,
        role: accessContext.role
      });
      captureDiagnostics(config, "info", "dual_write_task_success", {
        event: "dual_write_task_success",
        route,
        requestId,
        email: tokenDetails.email || "",
        taskId: dualWriteContext.taskId,
        cfRay: clientMeta?.cfRay || ""
      });
    }
  } catch (err) {
    console.error("[ShiftFlow][DualWrite] Failed to replicate to D1", {
      route,
      requestId,
      entityType: dualWriteContext.type,
      messageId: dualWriteContext.messageId,
      taskId: dualWriteContext.taskId,
      error: err && err.message ? err.message : String(err)
    });
    captureDiagnostics(config, "error", "dual_write_failure", {
      event: "dual_write_failure",
      route,
      requestId,
      email: tokenDetails.email || "",
      entityType: dualWriteContext.type,
      messageId: dualWriteContext.messageId,
      taskId: dualWriteContext.taskId,
      detail: err && err.message ? err.message : String(err),
      cfRay: clientMeta?.cfRay || ""
    });
  }
}
__name(performDualWriteIfNeeded, "performDualWriteIfNeeded");
__name2(performDualWriteIfNeeded, "performDualWriteIfNeeded");
async function insertMessageIntoD1(db, context) {
  if (!context?.messageId) return;
  const lowerEmail = normalizeEmailValue(context.authorEmail);
  const membership = await resolveMembershipForEmail(db, lowerEmail);
  const orgId = membership?.org_id || await resolveDefaultOrgId(db) || "01H00000000000000000000000";
  if (!membership) {
    console.warn("[ShiftFlow][DualWrite] Membership not found for author email", {
      email: lowerEmail,
      messageId: context.messageId
    });
  }
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();
  await db.prepare(
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
  ).bind(
    context.messageId,
    orgId,
    typeof payload.folderId === "string" ? payload.folderId : null,
    membership?.membership_id || null,
    typeof payload.title === "string" ? payload.title : "",
    typeof payload.body === "string" ? payload.body : "",
    timestampMs,
    timestampMs
  ).run();
}
__name(insertMessageIntoD1, "insertMessageIntoD1");
__name2(insertMessageIntoD1, "insertMessageIntoD1");
async function insertTaskIntoD1(db, context) {
  if (!context?.taskId) return;
  const payload = context.payload || {};
  const timestampMs = context.timestampMs || Date.now();
  const creatorEmail = normalizeEmailValue(context.authorEmail || payload.createdBy || payload.createdByEmail);
  const folderId = typeof payload.folderId === "string" ? payload.folderId.trim() : typeof payload.folder_id === "string" ? payload.folder_id.trim() : null;
  const membership = creatorEmail ? await resolveMembershipForEmail(db, creatorEmail) : null;
  const orgId = membership?.org_id || await resolveDefaultOrgId(db) || "01H00000000000000000000000";
  const createdAtCandidate = typeof payload.createdAtMs === "number" ? payload.createdAtMs : typeof payload.created_at_ms === "number" ? payload.created_at_ms : null;
  const createdAtMs = Number.isFinite(createdAtCandidate) ? createdAtCandidate : parseTaskDueDate(payload.createdAt) || parseTaskDueDate(payload.created_at) || timestampMs;
  const updatedAtCandidate = typeof payload.updatedAtMs === "number" ? payload.updatedAtMs : typeof payload.updated_at_ms === "number" ? payload.updated_at_ms : null;
  const updatedAtMs = Number.isFinite(updatedAtCandidate) ? updatedAtCandidate : parseTaskDueDate(payload.updatedAt) || parseTaskDueDate(payload.updated_at) || createdAtMs;
  const dueAtMs = parseTaskDueDate(payload.dueAtMs) || parseTaskDueDate(payload.due_at_ms) || parseTaskDueDate(payload.dueDate) || parseTaskDueDate(payload.due_at) || null;
  const status = mapTaskStatus(payload.status);
  const priority = mapTaskPriority(payload.priority);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Untitled Task";
  const description = typeof payload.description === "string" ? payload.description : typeof payload.body === "string" ? payload.body : null;
  const legacyTaskId = typeof payload.legacyTaskId === "string" && payload.legacyTaskId.trim() ? payload.legacyTaskId.trim() : null;
  const metaJson = typeof payload.metaJson === "string" && payload.metaJson.trim() ? payload.metaJson : typeof payload.meta_json === "string" && payload.meta_json.trim() ? payload.meta_json : buildTaskMetaJson(payload);
  await db.prepare(
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
  ).bind(
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
  ).run();
  const assigneeEmails = deriveTaskAssigneeEmails(payload, creatorEmail);
  await insertTaskAssigneesIntoD1(db, context.taskId, assigneeEmails, createdAtMs);
}
__name(insertTaskIntoD1, "insertTaskIntoD1");
__name2(insertTaskIntoD1, "insertTaskIntoD1");
async function insertTaskAssigneesIntoD1(db, taskId, emails, assignedAtMs) {
  if (!Array.isArray(emails) || !emails.length) return;
  await db.prepare("DELETE FROM task_assignees WHERE task_id = ?1").bind(taskId).run();
  for (const email of emails) {
    const normalized = normalizeEmailValue(email);
    if (!normalized) continue;
    const membership = await resolveMembershipForEmail(db, normalized);
    await db.prepare(
      `
        INSERT OR REPLACE INTO task_assignees (
          task_id,
          email,
          membership_id,
          assigned_at_ms
        )
        VALUES (?1, ?2, ?3, ?4)
      `
    ).bind(taskId, normalized, membership?.membership_id || null, assignedAtMs).run();
  }
}
__name(insertTaskAssigneesIntoD1, "insertTaskAssigneesIntoD1");
__name2(insertTaskAssigneesIntoD1, "insertTaskAssigneesIntoD1");
async function resolveMembershipForEmail(db, email) {
  if (!email) return null;
  const row = await db.prepare(
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
  ).bind(email).first();
  return row || null;
}
__name(resolveMembershipForEmail, "resolveMembershipForEmail");
__name2(resolveMembershipForEmail, "resolveMembershipForEmail");
async function resolveDefaultOrgId(db) {
  const row = await db.prepare("SELECT org_id FROM organizations ORDER BY created_at_ms ASC LIMIT 1").first();
  return row ? row.org_id : null;
}
__name(resolveDefaultOrgId, "resolveDefaultOrgId");
__name2(resolveDefaultOrgId, "resolveDefaultOrgId");
async function fetchPreservingAuth(originalUrl, originalInit, remainingRedirects = 4, meta = {}) {
  const init = { ...originalInit || {}, redirect: "manual" };
  const response = await fetch(originalUrl, init);
  if (!REDIRECT_STATUSES.has(response.status)) {
    return response;
  }
  const location = normalizeRedirectUrl(originalUrl, response.headers.get("Location"));
  const originHostRaw = (() => {
    try {
      return new URL(originalUrl).hostname;
    } catch (_err) {
      return "";
    }
  })();
  const locationHostRaw = (() => {
    try {
      return location ? new URL(location).hostname : "";
    } catch (_err) {
      return "";
    }
  })();
  const originHost = originHostRaw ? originHostRaw.toLowerCase() : "";
  const locationHost = locationHostRaw ? locationHostRaw.toLowerCase() : "";
  if (location && locationHost && locationHost.endsWith("script.googleusercontent.com") && originHost && (originHost === "script.google.com" || originHost.endsWith(".script.google.com"))) {
    if (remainingRedirects <= 0) {
      logAuthError("Exceeded redirect attempts when calling upstream", {
        requestId: meta.requestId || "",
        route: meta.route || "",
        status: response.status,
        location: location || "",
        originHost,
        locationHost
      });
      const error2 = new Error("Too many upstream redirects.");
      error2.httpStatus = response.status;
      error2.redirectLocation = location || "";
      error2.responseHeaders = Object.fromEntries(response.headers.entries());
      error2.isRedirect = true;
      throw error2;
    }
    logAuthInfo("Following upstream redirect", {
      requestId: meta.requestId || "",
      route: meta.route || "",
      status: response.status,
      location
    });
    captureDiagnostics(meta.config, "info", "upstream_redirect_followed", {
      event: "upstream_redirect_followed",
      requestId: meta.requestId || "",
      route: meta.route || "",
      status: response.status,
      location,
      originHost,
      locationHost
    });
    const nextInit = { ...init };
    delete nextInit.redirect;
    const originalMethod = (nextInit.method || "GET").toString().toUpperCase();
    const shouldResetMethod = response.status === 303 || (response.status === 301 || response.status === 302) && originalMethod !== "GET" && originalMethod !== "HEAD";
    if (shouldResetMethod) {
      nextInit.method = "GET";
      delete nextInit.body;
      if (nextInit.headers && typeof nextInit.headers === "object") {
        if (typeof nextInit.headers.delete === "function") {
          nextInit.headers.delete("Content-Type");
        } else {
          delete nextInit.headers["Content-Type"];
          delete nextInit.headers["content-type"];
        }
      }
    }
    nextInit.redirect = "manual";
    return fetchPreservingAuth(location, nextInit, remainingRedirects - 1, meta);
  }
  logAuthInfo("Blocked upstream redirect", {
    requestId: meta.requestId || "",
    route: meta.route || "",
    status: response.status,
    location: location || ""
  });
  captureDiagnostics(meta.config, "warn", "upstream_redirect_blocked", {
    event: "upstream_redirect_blocked",
    requestId: meta.requestId || "",
    route: meta.route || "",
    status: response.status,
    location: location || "",
    originHost,
    locationHost
  });
  const error = new Error("Upstream responded with a redirect.");
  error.httpStatus = response.status;
  error.redirectLocation = location || "";
  error.responseHeaders = Object.fromEntries(response.headers.entries());
  error.isRedirect = true;
  error.isCrossOriginRedirect = originHost && locationHost && originHost !== locationHost;
  throw error;
}
__name(fetchPreservingAuth, "fetchPreservingAuth");
__name2(fetchPreservingAuth, "fetchPreservingAuth");
function sanitizeDiagnosticsValue(value) {
  if (value === null || value === void 0) {
    return void 0;
  }
  const type = typeof value;
  if (type === "string") {
    return value.length > 500 ? value.slice(0, 497) + "..." : value;
  }
  if (type === "number" || type === "boolean") {
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
  if (type === "object") {
    const entries = Object.entries(value);
    const limited = {};
    for (let i = 0; i < Math.min(entries.length, 10); i += 1) {
      const [key, val] = entries[i];
      if (!key) continue;
      const sanitized = sanitizeDiagnosticsValue(val);
      if (sanitized !== void 0) {
        limited[key] = sanitized;
      }
    }
    return limited;
  }
  return String(value);
}
__name(sanitizeDiagnosticsValue, "sanitizeDiagnosticsValue");
__name2(sanitizeDiagnosticsValue, "sanitizeDiagnosticsValue");
function createDiagnosticsPayload(level, message, meta) {
  const safeMetaRaw = meta && typeof meta === "object" ? meta : {};
  const safeMeta = {};
  const entries = Object.entries(safeMetaRaw);
  const limit = Math.min(entries.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const [key, value] = entries[i];
    if (!key) continue;
    const sanitized = sanitizeDiagnosticsValue(value);
    if (sanitized !== void 0) {
      safeMeta[key] = sanitized;
    }
  }
  const payload = {
    level,
    message,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    requestId: typeof safeMeta.requestId === "string" ? safeMeta.requestId : "",
    event: typeof safeMeta.event === "string" ? safeMeta.event : "",
    route: typeof safeMeta.route === "string" ? safeMeta.route : "",
    email: typeof safeMeta.email === "string" ? safeMeta.email : "",
    status: typeof safeMeta.status === "string" ? safeMeta.status : "",
    meta: safeMeta
  };
  return payload;
}
__name(createDiagnosticsPayload, "createDiagnosticsPayload");
__name2(createDiagnosticsPayload, "createDiagnosticsPayload");
async function sendDiagnostics(config, payload) {
  if (!config || !config.gasUrl) {
    return;
  }
  const headers = new Headers({
    "Content-Type": "application/json"
  });
  if (config.sharedSecret) {
    headers.set("X-ShiftFlow-Secret", config.sharedSecret);
  }
  if (payload.requestId) {
    headers.set("X-ShiftFlow-Request-Id", payload.requestId);
  }
  const body = JSON.stringify({
    route: DIAGNOSTIC_ROUTE,
    args: [payload]
  });
  const response = await fetch(config.gasUrl, {
    method: "POST",
    headers,
    body
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Diagnostic endpoint failed (${response.status}): ${text ? text.slice(0, 200) : "no body"}`
    );
  }
}
__name(sendDiagnostics, "sendDiagnostics");
__name2(sendDiagnostics, "sendDiagnostics");
function captureDiagnostics(config, level, message, meta) {
  try {
    const payload = createDiagnosticsPayload(level, message, meta);
    sendDiagnostics(config, payload).catch((err) => {
      console.warn("[ShiftFlow][Auth] Failed to push diagnostics log", {
        requestId: payload.requestId || "",
        message: err && err.message ? err.message : String(err)
      });
    });
  } catch (err) {
    console.warn("[ShiftFlow][Auth] Failed to prepare diagnostics payload", {
      message: err && err.message ? err.message : String(err)
    });
  }
}
__name(captureDiagnostics, "captureDiagnostics");
__name2(captureDiagnostics, "captureDiagnostics");
async function fetchTokenInfo(idToken, config) {
  if (!idToken) {
    throw new Error("Missing Authorization bearer token.");
  }
  const tokenUrl = `${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`;
  const response = await fetch(tokenUrl, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    throw new Error(`Token verification failed (HTTP ${response.status})`);
  }
  let data;
  try {
    data = await response.json();
  } catch (_err) {
    throw new Error("Token verification returned a non-JSON response.");
  }
  if (!data || !data.aud || String(data.aud) !== config.googleClientId) {
    throw new Error("ID token audience mismatch.");
  }
  if (!GOOGLE_ISSUERS.has(String(data.iss || ""))) {
    throw new Error("ID token issuer is not Google.");
  }
  const nowSeconds = Math.floor(Date.now() / 1e3);
  const expSeconds = Number(data.exp || 0);
  if (expSeconds && nowSeconds >= expSeconds) {
    throw new Error("ID token has expired.");
  }
  const sub = String(data.sub || "").trim();
  if (!sub) {
    throw new Error("ID token is missing subject (sub).");
  }
  const email = String(data.email || "").trim();
  if (!email) {
    throw new Error("ID token is missing email.");
  }
  const emailVerifiedRaw = data.email_verified;
  const emailVerified = emailVerifiedRaw === true || emailVerifiedRaw === "true" || emailVerifiedRaw === 1 || emailVerifiedRaw === "1";
  return {
    rawToken: idToken,
    sub,
    email,
    emailVerified,
    name: data.name || data.given_name || "",
    picture: data.picture || "",
    hd: data.hd || "",
    aud: data.aud,
    iss: data.iss,
    iat: Number(data.iat || 0),
    exp: expSeconds,
    iatMs: Number(data.iat || 0) > 0 ? Number(data.iat) * 1e3 : void 0,
    expMs: expSeconds > 0 ? expSeconds * 1e3 : void 0
  };
}
__name(fetchTokenInfo, "fetchTokenInfo");
__name2(fetchTokenInfo, "fetchTokenInfo");
async function resolveAccessContext(config, tokenDetails, requestId, clientMeta) {
  const cacheKey = tokenDetails.sub ? tokenDetails.sub : null;
  const cached = cacheKey ? ACCESS_CACHE.get(cacheKey) : null;
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }
  const url = new URL(config.gasUrl);
  const headers = {
    "Content-Type": "application/json",
    "X-ShiftFlow-Sub": tokenDetails.sub,
    "X-ShiftFlow-Email": tokenDetails.email,
    "X-ShiftFlow-Request-Id": requestId
  };
  const hasRawToken = typeof tokenDetails.rawToken === "string" && tokenDetails.rawToken.trim() !== "";
  const authorizationHeader = hasRawToken ? `Bearer ${tokenDetails.rawToken.trim()}` : "";
  if (authorizationHeader) {
    headers.Authorization = authorizationHeader;
  }
  if (config.sharedSecret) headers["X-ShiftFlow-Secret"] = config.sharedSecret;
  if (tokenDetails.name) headers["X-ShiftFlow-Name"] = tokenDetails.name;
  if (tokenDetails.hd) headers["X-ShiftFlow-Domain"] = tokenDetails.hd;
  if (tokenDetails.iat) headers["X-ShiftFlow-Token-Iat"] = String(tokenDetails.iat);
  if (tokenDetails.exp) headers["X-ShiftFlow-Token-Exp"] = String(tokenDetails.exp);
  if (clientMeta.ip) headers["X-ShiftFlow-Client-IP"] = clientMeta.ip;
  if (clientMeta.userAgent) headers["X-ShiftFlow-User-Agent"] = clientMeta.userAgent;
  const bodyPayload = {
    route: "resolveAccessContext",
    args: []
  };
  if (authorizationHeader) {
    bodyPayload.authorization = authorizationHeader;
    bodyPayload.headers = { Authorization: authorizationHeader };
  }
  const body = JSON.stringify(bodyPayload);
  logAuthInfo("Calling resolveAccessContext upstream", {
    requestId,
    route: "resolveAccessContext",
    gasHost: url.host,
    gasPath: url.pathname,
    email: tokenDetails.email || "",
    hasAuthorization: !!authorizationHeader
  });
  let response;
  try {
    response = await fetchPreservingAuth(
      url.toString(),
      {
        method: "POST",
        headers,
        body
      },
      4,
      { config, requestId, route: "resolveAccessContext" }
    );
  } catch (err) {
    if (err && err.isRedirect) {
      const redirectError = new Error(
        "resolveAccessContext received a redirect instead of JSON. Authentication may be required."
      );
      redirectError.httpStatus = err.httpStatus;
      redirectError.redirectLocation = err.redirectLocation;
      redirectError.isRedirect = true;
      redirectError.responseHeaders = err.responseHeaders || {};
      throw redirectError;
    }
    throw err;
  }
  logAuthInfo("resolveAccessContext upstream status", {
    requestId,
    route: "resolveAccessContext",
    status: response.status,
    contentType: response.headers.get("Content-Type") || "",
    location: response.headers.get("Location") || ""
  });
  const text = await response.text();
  let payload;
  try {
    if (isLikelyHtmlDocument(text)) {
      const error = new Error("resolveAccessContext returned HTML content.");
      error.httpStatus = response.status;
      error.rawResponseSnippet = text.slice(0, 512);
      error.responseHeaders = Object.fromEntries(response.headers.entries());
      error.isHtml = true;
      throw error;
    }
    payload = JSON.parse(stripXssiPrefix(text));
  } catch (_err) {
    const snippet = typeof text === "string" ? text.slice(0, 512) : "";
    const error = _err instanceof Error ? _err : new Error("resolveAccessContext returned a non-JSON payload.");
    error.httpStatus = response.status;
    error.rawResponseSnippet = snippet;
    error.responseHeaders = Object.fromEntries(response.headers.entries());
    throw error;
  }
  if (!response.ok) {
    const detail = payload && payload.error ? `${payload.error}${payload.detail ? `: ${payload.detail}` : ""}` : `HTTP ${response.status}`;
    const error = new Error(`resolveAccessContext failed (${detail})`);
    error.httpStatus = response.status;
    error.rawResponseSnippet = payload && typeof payload === "object" ? JSON.stringify(payload).slice(0, 512) : "";
    error.responseHeaders = Object.fromEntries(response.headers.entries());
    throw error;
  }
  if (!payload || payload.ok === false) {
    const reason = payload && payload.error ? payload.error : "resolveAccessContext returned an unexpected response.";
    throw new Error(reason);
  }
  const result = payload.result || {};
  const context = {
    allowed: !!result.allowed,
    role: String(result.role || "").trim() || "guest",
    status: String(result.status || "").trim() || "unknown",
    email: result.email || tokenDetails.email,
    displayName: result.displayName || "",
    reason: result.reason || ""
  };
  const ttlMs = context.allowed ? 5 * 60 * 1e3 : 60 * 1e3;
  if (cacheKey) {
    const expiresAt = Math.min(
      tokenDetails.expMs ? tokenDetails.expMs - 5e3 : now + ttlMs,
      now + ttlMs
    );
    ACCESS_CACHE.set(cacheKey, {
      context,
      expiresAt
    });
  }
  return context;
}
__name(resolveAccessContext, "resolveAccessContext");
__name2(resolveAccessContext, "resolveAccessContext");
async function onRequest(context) {
  const { request, params, env } = context;
  const config = loadConfig(env);
  const flags2 = config.flags || {};
  const route = params.route ? String(params.route) : "";
  const requestId = createRequestId();
  const originHeader = request.headers.get("Origin") || "";
  const allowedOrigin = pickAllowedOrigin(config.allowedOrigins, originHeader);
  if (request.method === "OPTIONS") {
    if (originHeader && !allowedOrigin) {
      logAuthInfo("Blocked preflight from disallowed origin", {
        requestId,
        origin: originHeader
      });
      captureDiagnostics(config, "warn", "origin_blocked", {
        event: "origin_blocked",
        requestId,
        origin: originHeader,
        phase: "preflight",
        route
      });
      return jsonResponse(
        403,
        { ok: false, error: "Origin is not allowed." },
        config.allowedOrigins[0] || "*",
        { "X-ShiftFlow-Request-Id": requestId }
      );
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(allowedOrigin || config.allowedOrigins[0] || "*"),
        "X-ShiftFlow-Request-Id": requestId
      }
    });
  }
  if (originHeader && !allowedOrigin) {
    logAuthInfo("Blocked request from disallowed origin", {
      requestId,
      origin: originHeader
    });
    captureDiagnostics(config, "warn", "origin_blocked", {
      event: "origin_blocked",
      requestId,
      origin: originHeader,
      route
    });
    return jsonResponse(
      403,
      { ok: false, error: "Origin is not allowed." },
      config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  if (!route) {
    return jsonResponse(
      400,
      { ok: false, error: "Route parameter is required." },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  if (route === "resolveAccessContext") {
    return jsonResponse(
      403,
      { ok: false, error: "Route is reserved." },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  const clientMeta = {
    ip: request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "",
    userAgent: request.headers.get("user-agent") || "",
    cfRay: request.headers.get("cf-ray") || ""
  };
  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  let tokenDetails;
  logAuthInfo("Handling authenticated route request", {
    requestId,
    route,
    hasAuthorizationHeader: !!token,
    origin: originHeader || ""
  });
  if (!token) {
    logAuthError("Missing Authorization bearer token", { requestId, route });
    return jsonResponse(
      401,
      { ok: false, error: "Unauthorized", detail: "Missing Authorization bearer token." },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  if (flags2.cfAuth) {
    try {
      tokenDetails = await fetchTokenInfo(token, config);
    } catch (err) {
      logAuthError("Token verification failed", {
        requestId,
        message: err && err.message ? err.message : String(err),
        route
      });
      captureDiagnostics(config, "error", "token_verification_failed", {
        event: "token_verification_failed",
        requestId,
        route,
        detail: err && err.message ? err.message : String(err),
        tokenPresent: !!token,
        clientIp: clientMeta.ip,
        userAgent: clientMeta.userAgent,
        cfRay: clientMeta.cfRay
      });
      return jsonResponse(
        401,
        {
          ok: false,
          error: "Unauthorized",
          detail: err && err.message ? err.message : String(err || "Token verification failed")
        },
        allowedOrigin || config.allowedOrigins[0] || "*",
        { "X-ShiftFlow-Request-Id": requestId }
      );
    }
    if (!tokenDetails.emailVerified) {
      logAuthInfo("Email not verified", {
        requestId,
        email: tokenDetails.email || "",
        route
      });
      captureDiagnostics(config, "warn", "email_not_verified", {
        event: "email_not_verified",
        requestId,
        route,
        email: tokenDetails.email || "",
        clientIp: clientMeta.ip,
        userAgent: clientMeta.userAgent,
        cfRay: clientMeta.cfRay
      });
      return jsonResponse(
        403,
        { ok: false, error: "Google \u30A2\u30AB\u30A6\u30F3\u30C8\u306E\u30E1\u30FC\u30EB\u30A2\u30C9\u30EC\u30B9\u304C\u672A\u78BA\u8A8D\u3067\u3059\u3002" },
        allowedOrigin || config.allowedOrigins[0] || "*",
        { "X-ShiftFlow-Request-Id": requestId }
      );
    }
  } else {
    tokenDetails = createLegacyTokenDetails(token);
  }
  let accessContext;
  try {
    accessContext = await resolveAccessContext(config, tokenDetails, requestId, clientMeta);
  } catch (err) {
    logAuthError("resolveAccessContext failed", {
      requestId,
      route,
      message: err && err.message ? err.message : String(err),
      email: tokenDetails.email || "",
      rawSample: err && err.rawResponseSnippet ? err.rawResponseSnippet.slice(0, 200) : "",
      rawHtml: err && err.isHtml ? (err.rawResponseSnippet || "").slice(0, 200) : "",
      redirectLocation: err && err.redirectLocation ? err.redirectLocation : ""
    });
    const detailMessage = err && err.isRedirect ? "Apps Script \u304C\u8A8D\u8A3C\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3092\u8FD4\u3057\u307E\u3057\u305F\u3002GAS_EXEC_URL \u304C Web \u30A2\u30D7\u30EA\u306E /exec URL \u306B\u306A\u3063\u3066\u3044\u308B\u304B\u78BA\u8A8D\u3057\u3001\u5FC5\u8981\u3067\u3042\u308C\u3070 Apps Script \u3067\u8A8D\u8A3C\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044\u3002" : err && err.isHtml ? "Apps Script \u304C HTML \u3092\u8FD4\u3057\u307E\u3057\u305F\u3002GAS_EXEC_URL \u3092\u30D6\u30E9\u30A6\u30B6\u3067\u958B\u3044\u3066 Google \u30A2\u30AB\u30A6\u30F3\u30C8\u306E\u627F\u8A8D\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044\u3002" : err && err.message ? err.message : String(err || "resolveAccessContext failed");
    const statusCode = err && err.isRedirect ? 401 : 403;
    captureDiagnostics(config, "error", "resolve_access_context_failed", {
      event: "resolve_access_context_failed",
      requestId,
      route,
      email: tokenDetails.email || "",
      detail: detailMessage,
      clientIp: clientMeta.ip,
      userAgent: clientMeta.userAgent,
      httpStatus: err && err.httpStatus ? err.httpStatus : "",
      rawResponseSnippet: err && err.rawResponseSnippet ? err.rawResponseSnippet : "",
      responseHeaders: err && err.responseHeaders ? err.responseHeaders : {},
      cfRay: clientMeta.cfRay,
      redirectLocation: err && err.redirectLocation ? err.redirectLocation : ""
    });
    return jsonResponse(
      statusCode,
      {
        ok: false,
        error: "\u30A2\u30AF\u30BB\u30B9\u6A29\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
        detail: detailMessage
      },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  if (!accessContext.allowed || accessContext.status !== "active") {
    logAuthInfo("Access denied by GAS context", {
      requestId,
      route,
      email: tokenDetails.email || "",
      status: accessContext.status,
      reason: accessContext.reason || ""
    });
    captureDiagnostics(config, "warn", "access_denied", {
      event: "access_denied",
      requestId,
      route,
      email: tokenDetails.email || "",
      status: accessContext.status,
      reason: accessContext.reason || "",
      clientIp: clientMeta.ip,
      cfRay: clientMeta.cfRay
    });
    return jsonResponse(
      403,
      {
        ok: false,
        error: "\u30A2\u30AF\u30BB\u30B9\u304C\u8A31\u53EF\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002",
        reason: accessContext.reason || "\u627F\u8A8D\u5F85\u3061\u3001\u307E\u305F\u306F\u5229\u7528\u505C\u6B62\u306E\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002",
        status: accessContext.status
      },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
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
      logAuthInfo("Route denied due to role mismatch", {
        requestId,
        route,
        required: routePermissions,
        role: accessContext.role,
        email: tokenDetails.email || ""
      });
      captureDiagnostics(config, "warn", "role_mismatch", {
        event: "role_mismatch",
        requestId,
        route,
        email: tokenDetails.email || "",
        role: accessContext.role,
        required: routePermissions,
        cfRay: clientMeta.cfRay
      });
      return jsonResponse(
        403,
        { ok: false, error: "\u6A29\u9650\u304C\u3042\u308A\u307E\u305B\u3093\u3002" },
        allowedOrigin || config.allowedOrigins[0] || "*",
        { "X-ShiftFlow-Request-Id": requestId }
      );
    }
  }
  const cacheSettings = shouldUseKvCache(route, flags2);
  const hasKvStore = !!env && !!env.APP_KV;
  const cacheIdentitySource = accessContext.email && accessContext.email.trim() || tokenDetails.email && tokenDetails.email.trim() || tokenDetails.sub && tokenDetails.sub.trim() || "anonymous";
  const cacheIdentity = cacheIdentitySource.toLowerCase();
  const invalidationTargets = resolveInvalidationTargets(route);
  let cacheKey = null;
  let cacheStatus = "BYPASS";
  if (cacheSettings && hasKvStore) {
    cacheKey = buildKvCacheKey(route, cacheIdentity);
    const cachedRecord = await readKvCache(env.APP_KV, cacheKey);
    if (cachedRecord) {
      logAuthInfo("Serving response from KV cache", {
        requestId,
        route,
        cacheKey
      });
      return buildCacheResponse(
        cachedRecord,
        allowedOrigin || config.allowedOrigins[0] || "*",
        requestId
      );
    }
    cacheStatus = "MISS";
  }
  const upstreamUrl = new URL(config.gasUrl);
  upstreamUrl.searchParams.delete("route");
  upstreamUrl.searchParams.delete("method");
  upstreamUrl.searchParams.delete("page");
  const originalUrl = new URL(request.url);
  originalUrl.searchParams.forEach((value, key) => {
    if (key !== "route") {
      upstreamUrl.searchParams.append(key, value);
    }
  });
  upstreamUrl.searchParams.set("route", route);
  upstreamUrl.searchParams.set("__userEmail", tokenDetails.email || "");
  upstreamUrl.searchParams.set("__userSub", tokenDetails.sub || "");
  if (tokenDetails.name) {
    upstreamUrl.searchParams.set("__userName", tokenDetails.name);
  }
  const rawBearerToken = typeof tokenDetails.rawToken === "string" ? tokenDetails.rawToken.trim() : "";
  const authorizationHeader = rawBearerToken ? `Bearer ${rawBearerToken}` : "";
  let dualWriteContext = null;
  const init = {
    method: request.method,
    redirect: "follow",
    headers: {
      "X-ShiftFlow-Email": tokenDetails.email || "",
      "X-ShiftFlow-Sub": tokenDetails.sub || "",
      "X-ShiftFlow-Role": accessContext.role,
      "X-ShiftFlow-User-Status": accessContext.status,
      "X-ShiftFlow-Request-Id": requestId
    }
  };
  if (authorizationHeader) {
    init.headers.Authorization = authorizationHeader;
  }
  if (config.sharedSecret) init.headers["X-ShiftFlow-Secret"] = config.sharedSecret;
  if (tokenDetails.name) {
    init.headers["X-ShiftFlow-Name"] = tokenDetails.name;
  }
  if (clientMeta.ip) init.headers["X-ShiftFlow-Client-IP"] = clientMeta.ip;
  if (clientMeta.userAgent) init.headers["X-ShiftFlow-User-Agent"] = clientMeta.userAgent;
  if (clientMeta.cfRay) init.headers["X-ShiftFlow-CF-Ray"] = clientMeta.cfRay;
  if (tokenDetails.iat) init.headers["X-ShiftFlow-Token-Iat"] = String(tokenDetails.iat);
  if (tokenDetails.exp) init.headers["X-ShiftFlow-Token-Exp"] = String(tokenDetails.exp);
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type");
    const originalContentType = contentType || "";
    if (originalContentType) {
      init.headers["Content-Type"] = originalContentType;
    }
    let rawBody = await request.text();
    if (rawBody && originalContentType.includes("application/json")) {
      try {
        const parsedBody = JSON.parse(rawBody) || {};
        if (authorizationHeader) {
          if (parsedBody && typeof parsedBody === "object") {
            if (!parsedBody.authorization) {
              parsedBody.authorization = authorizationHeader;
            }
            if (!parsedBody.headers || typeof parsedBody.headers !== "object") {
              parsedBody.headers = {};
            }
            if (!parsedBody.headers.Authorization) {
              parsedBody.headers.Authorization = authorizationHeader;
            }
          }
        }
        const interception = interceptRequestBodyForRoute(route, parsedBody, {
          flags: flags2,
          tokenDetails,
          accessContext
        });
        const bodyToForward = interception ? interception.body : parsedBody;
        if (interception && interception.dualWriteContext) {
          dualWriteContext = interception.dualWriteContext;
        }
        rawBody = JSON.stringify(bodyToForward);
        init.headers["Content-Type"] = "application/json";
      } catch (_err) {
      }
    }
    init.body = rawBody;
  }
  let upstreamResponse;
  try {
    upstreamResponse = await fetchPreservingAuth(upstreamUrl.toString(), init, 4, {
      config,
      requestId,
      route
    });
  } catch (err) {
    if (err && err.isRedirect) {
      logAuthError("GAS returned redirect", {
        requestId,
        route,
        email: tokenDetails.email || "",
        status: err.httpStatus || "",
        location: err.redirectLocation || ""
      });
      captureDiagnostics(config, "error", "gas_redirected", {
        event: "gas_redirected",
        requestId,
        route,
        email: tokenDetails.email || "",
        status: err.httpStatus || "",
        location: err.redirectLocation || "",
        clientIp: clientMeta.ip,
        cfRay: clientMeta.cfRay
      });
      return jsonResponse(
        401,
        {
          ok: false,
          error: "Google \u30A2\u30AB\u30A6\u30F3\u30C8\u306E\u8A8D\u8A3C\u304C\u5FC5\u8981\u3067\u3059\u3002",
          detail: "Apps Script \u304C\u8A8D\u8A3C\u30EA\u30C0\u30A4\u30EC\u30AF\u30C8\u3092\u8FD4\u3057\u307E\u3057\u305F\u3002\u30D6\u30E9\u30A6\u30B6\u3067 GAS_EXEC_URL \u3092\u958B\u3044\u3066 Google \u30A2\u30AB\u30A6\u30F3\u30C8\u306E\u627F\u8A8D\u3092\u5B8C\u4E86\u3057\u3066\u304F\u3060\u3055\u3044\u3002"
        },
        allowedOrigin || config.allowedOrigins[0] || "*",
        { "X-ShiftFlow-Request-Id": requestId }
      );
    }
    logAuthError("Failed to reach GAS", {
      requestId,
      route,
      email: tokenDetails.email || "",
      message: err && err.message ? err.message : String(err)
    });
    captureDiagnostics(config, "error", "gas_unreachable", {
      event: "gas_unreachable",
      requestId,
      route,
      email: tokenDetails.email || "",
      detail: err && err.message ? err.message : String(err),
      clientIp: clientMeta.ip,
      cfRay: clientMeta.cfRay
    });
    return jsonResponse(
      502,
      {
        ok: false,
        error: "GAS unreachable",
        detail: err && err.message ? err.message : String(err || "fetch failed")
      },
      allowedOrigin || config.allowedOrigins[0] || "*",
      { "X-ShiftFlow-Request-Id": requestId }
    );
  }
  const responseForCache = cacheSettings && hasKvStore ? upstreamResponse.clone() : null;
  if (hasKvStore && invalidationTargets.length && upstreamResponse.ok) {
    await invalidateKvCacheForUser(env.APP_KV, invalidationTargets, cacheIdentitySource);
  }
  if (cacheSettings && hasKvStore && cacheKey && cacheStatus === "MISS" && upstreamResponse.ok && responseForCache) {
    try {
      const cacheBodyText = await responseForCache.text();
      await writeKvCache(
        env.APP_KV,
        cacheKey,
        {
          status: upstreamResponse.status,
          body: cacheBodyText,
          contentType: upstreamResponse.headers.get("content-type") || "application/json"
        },
        cacheSettings.ttlSeconds
      );
      logAuthInfo("Stored response in KV cache", {
        requestId,
        route,
        cacheKey,
        ttl: cacheSettings.ttlSeconds
      });
    } catch (err) {
      console.warn("[ShiftFlow][Cache] Failed to cache response", {
        cacheKey,
        error: err && err.message ? err.message : String(err)
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
      clientMeta
    });
  }
  const baseCors = corsHeaders(allowedOrigin || config.allowedOrigins[0] || "*");
  const responseHeaders = new Headers({
    ...baseCors,
    "X-ShiftFlow-Request-Id": requestId
  });
  responseHeaders.set("X-ShiftFlow-Cache", cacheStatus);
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith("access-control")) return;
    responseHeaders.set(key, value);
  });
  const bodyBuffer = await upstreamResponse.arrayBuffer();
  return new Response(bodyBuffer, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}
__name(onRequest, "onRequest");
__name2(onRequest, "onRequest");
async function onRequest2(context) {
  const gasUrl = context.env && typeof context.env.GAS_WEB_APP_URL === "string" ? context.env.GAS_WEB_APP_URL : "";
  const clientId = context.env && typeof context.env.GOOGLE_CLIENT_ID === "string" ? context.env.GOOGLE_CLIENT_ID : "";
  const body = `window.__GAS_WEB_APP_URL__ = ${JSON.stringify(
    gasUrl
  )};
window.__GOOGLE_CLIENT_ID__ = ${JSON.stringify(clientId)};`;
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=60"
    }
  });
}
__name(onRequest2, "onRequest2");
__name2(onRequest2, "onRequest");
var routes = [
  {
    routePath: "/api/:route",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  },
  {
    routePath: "/config",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest2]
  }
];
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
__name2(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name2(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name2(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name2(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name2(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name2(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
__name2(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
__name2(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name2(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
__name2(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
__name2(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
__name2(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
__name2(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
__name2(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
__name2(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
__name2(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");
__name2(pathToRegexp, "pathToRegexp");
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
__name2(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name2(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name2(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name2((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
var drainBody = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
__name2(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
__name2(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
__name2(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");
__name2(__facade_invoke__, "__facade_invoke__");
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  static {
    __name(this, "___Facade_ScheduledController__");
  }
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name2(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name2(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name2(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
__name2(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name2((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name2((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
__name2(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default2 = drainBody2;

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError2(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError2(e.cause)
  };
}
__name(reduceError2, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError2(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default2 = jsonError2;

// .wrangler/tmp/bundle-Q6xFC5/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__2 = [
  middleware_ensure_req_body_drained_default2,
  middleware_miniflare3_json_error_default2
];
var middleware_insertion_facade_default2 = middleware_loader_entry_default;

// ../../../.nvm/versions/node/v20.19.5/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__2 = [];
function __facade_register__2(...args) {
  __facade_middleware__2.push(...args.flat());
}
__name(__facade_register__2, "__facade_register__");
function __facade_invokeChain__2(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__2(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__2, "__facade_invokeChain__");
function __facade_invoke__2(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__2(request, env, ctx, dispatch, [
    ...__facade_middleware__2,
    finalMiddleware
  ]);
}
__name(__facade_invoke__2, "__facade_invoke__");

// .wrangler/tmp/bundle-Q6xFC5/middleware-loader.entry.ts
var __Facade_ScheduledController__2 = class ___Facade_ScheduledController__2 {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__2)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler2(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__2(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__2(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler2, "wrapExportedHandler");
function wrapWorkerEntrypoint2(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__2(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__2(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint2, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY2;
if (typeof middleware_insertion_facade_default2 === "object") {
  WRAPPED_ENTRY2 = wrapExportedHandler2(middleware_insertion_facade_default2);
} else if (typeof middleware_insertion_facade_default2 === "function") {
  WRAPPED_ENTRY2 = wrapWorkerEntrypoint2(middleware_insertion_facade_default2);
}
var middleware_loader_entry_default2 = WRAPPED_ENTRY2;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__2 as __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default2 as default
};
//# sourceMappingURL=functionsWorker-0.9302242362504205.js.map
