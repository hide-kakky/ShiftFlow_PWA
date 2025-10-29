// ====== 基本設定 ======
const SPREADSHEET_ID = '1bL7cdFqtFd7eKAj0ZOUrmQ2kbPtGvDt6EMXt6fi5i_M';
const PROFILE_IMAGE_FOLDER_ID =
  PropertiesService.getScriptProperties().getProperty('PROFILE_IMAGE_FOLDER_ID') || '';
const MESSAGE_ATTACHMENT_FOLDER_ID =
  PropertiesService.getScriptProperties().getProperty('MESSAGE_ATTACHMENT_FOLDER_ID') || '';
const PROFILE_PLACEHOLDER_URL = 'https://placehold.jp/150x150.png';
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_MESSAGE_ATTACHMENT_BYTES = 4 * 1024 * 1024; // 4MB
const HIDDEN_TEST_ACCOUNT = 'hide.for.appscript@gmail.com';
const CLEANUP_MONTH_THRESHOLD = 6;
const USER_SHEET_COLUMNS = [
  'UserID',
  'Email',
  'DisplayName',
  'ProfileImage',
  'Role',
  'IsActive',
  'Theme',
  'AuthSubject',
  'Status',
  'FirstLoginAt',
  'LastLoginAt',
  'ApprovedBy',
  'ApprovedAt',
  'Notes',
];
const MEMO_SHEET_COLUMNS = [
  'MemoID',
  'CreatedAt',
  'CreatedBy',
  'Title',
  'Body',
  'Priority',
  'FolderID',
  'Attachments',
  'UpdatedAt',
  'AttachmentIDs',
];
const TASK_SHEET_COLUMNS = [
  'TaskID',
  'Title',
  'AssigneeEmail',
  'DueDate',
  'Status',
  'CreatedBy',
  'CreatedAt',
  'Priority',
  'AssigneeEmails',
  'RepeatRule',
  'UpdatedAt',
  'ParentTaskID',
  'Attachments',
  'AttachmentIDs',
];
const LOGIN_AUDIT_COLUMNS = [
  'LoginID',
  'UserEmail',
  'UserSub',
  'Status',
  'Reason',
  'RequestID',
  'TokenIat',
  'AttemptedAt',
  'ClientIp',
  'UserAgent',
  'Role',
];
const PROXY_LOG_COLUMNS = [
  'LogID',
  'Level',
  'Event',
  'Message',
  'RequestID',
  'Route',
  'Email',
  'Status',
  'Meta',
  'Source',
  'ClientIp',
  'UserAgent',
  'CfRay',
  'CreatedAt',
];
const GOOGLE_TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const GOOGLE_OAUTH_CLIENT_ID =
  PropertiesService.getScriptProperties().getProperty('GOOGLE_OAUTH_CLIENT_ID') || '';
const SHARED_SECRET = (
  PropertiesService.getScriptProperties().getProperty('SHIFT_FLOW_SHARED_SECRET') || ''
).trim();
const SHARED_SECRET_OPTIONAL =
  (PropertiesService.getScriptProperties().getProperty('SHIFT_FLOW_SECRET_OPTIONAL') || '')
    .trim()
    .toLowerCase() === 'true';
const ROUTE_PERMISSIONS = {
  getBootstrapData: ['admin', 'manager', 'member'],
  getHomeContent: ['admin', 'manager', 'member'],
  listMyTasks: ['admin', 'manager', 'member'],
  listCreatedTasks: ['admin', 'manager'],
  listAllTasks: ['admin', 'manager'],
  getMessages: ['admin', 'manager', 'member'],
  getMessageById: ['admin', 'manager', 'member'],
  addNewMessage: ['admin', 'manager', 'member'],
  deleteMessageById: ['admin', 'manager', 'member'],
  toggleMemoRead: ['admin', 'manager', 'member'],
  markMemosReadBulk: ['admin', 'manager', 'member'],
  markMemoAsRead: ['admin', 'manager', 'member'],
  addNewTask: ['admin', 'manager', 'member'],
  updateTask: ['admin', 'manager', 'member'],
  completeTask: ['admin', 'manager', 'member'],
  deleteTaskById: ['admin', 'manager', 'member'],
  getTaskById: ['admin', 'manager', 'member'],
  getUserSettings: ['admin', 'manager', 'member', 'guest'],
  saveUserSettings: ['admin', 'manager', 'member'],
  listActiveUsers: ['admin', 'manager'],
  listActiveFolders: ['admin', 'manager', 'member'],
  clearCache: ['admin'],
  getAuditLogs: ['admin', 'manager'],
  resolveAccessContext: ['admin', 'manager', 'member', 'guest'],
};
const ROLE_ALIASES = {
  admin: 'admin',
  administrator: 'admin',
  管理者: 'admin',
  管理職: 'manager',
  manager: 'manager',
  supervisor: 'manager',
  member: 'member',
  一般: 'member',
  staff: 'member',
  guest: 'guest',
  ゲスト: 'guest',
  viewer: 'guest',
};
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

function _getRoutePermissions(route) {
  const name = String(route || '').trim();
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(ROUTE_PERMISSIONS, name)) {
    return ROUTE_PERMISSIONS[name];
  }
  return null;
}

function _isRoleAllowedForRoute(route, role) {
  const permissions = _getRoutePermissions(route);
  if (!permissions || !permissions.length) return true;
  const normalized = _normalizeRole(role);
  return permissions.indexOf(normalized) !== -1;
}

/** Spreadsheetインスタンスのキャッシュ */
let _cachedSpreadsheet = null;
/** シートインスタンスのキャッシュ */
const _sheetCache = {};
/** Cloudflare 経由で渡されたユーザー情報（リクエストスコープ） */
let __CURRENT_REQUEST_EMAIL = '';
let __CURRENT_REQUEST_NAME = '';
/** Cloudflare で評価されたアクセスコンテキスト（リクエストスコープ） */
let __CURRENT_ACCESS_CONTEXT = null;

function _createHttpError(status, message, detail) {
  const err = new Error(message || 'Request failed');
  err.httpStatus = status;
  if (detail !== undefined) {
    err.detail = detail;
  }
  return err;
}

/** リクエストスコープのデータキャッシュ */
const __REQUEST_CACHE = {};
const REQUEST_CACHE_KEYS = {
  USER_INFO_PREFIX: 'userInfo:',
  ACTIVE_USERS: 'activeUsers',
  ACTIVE_FOLDERS: 'activeFolders',
  TASK_TABLE: 'taskTable',
};
const SCRIPT_CACHE_KEYS = {
  ACTIVE_USERS: 'SF_ACTIVE_USERS_V1',
  ACTIVE_FOLDERS: 'SF_ACTIVE_FOLDERS_V1',
};

function _getRequestCacheValue(key) {
  if (!key) return undefined;
  return Object.prototype.hasOwnProperty.call(__REQUEST_CACHE, key)
    ? __REQUEST_CACHE[key]
    : undefined;
}

function _setRequestCacheValue(key, value) {
  if (!key) return;
  __REQUEST_CACHE[key] = value;
}

function _invalidateRequestCache(key) {
  if (!key) return;
  if (Object.prototype.hasOwnProperty.call(__REQUEST_CACHE, key)) {
    delete __REQUEST_CACHE[key];
  }
}

function _clearRequestCache() {
  Object.keys(__REQUEST_CACHE).forEach(function (key) {
    delete __REQUEST_CACHE[key];
  });
}

function _getScriptCacheJSON(key) {
  if (!key) return null;
  try {
    const cache = CacheService.getScriptCache();
    const raw = cache.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function _setScriptCacheJSON(key, value, ttlSeconds) {
  if (!key) return;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > 90 * 1024) {
      return;
    }
    const cache = CacheService.getScriptCache();
    cache.put(key, serialized, Math.max(1, ttlSeconds || 300));
  } catch (err) {
  }
}

function _invalidateScriptCacheKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  try {
    const cache = CacheService.getScriptCache();
    keys.forEach(function (key) {
      if (key) cache.remove(key);
    });
  } catch (err) {
  }
}

function _getCachedValue(requestKey, scriptKey, ttlSeconds, loader) {
  if (requestKey) {
    const hit = _getRequestCacheValue(requestKey);
    if (hit !== undefined) {
      return hit;
    }
  }
  if (scriptKey) {
    const cached = _getScriptCacheJSON(scriptKey);
    if (cached !== null) {
      if (requestKey) _setRequestCacheValue(requestKey, cached);
      return cached;
    }
  }
  const value = typeof loader === 'function' ? loader() : null;
  if (requestKey) {
    _setRequestCacheValue(requestKey, value);
  }
  if (scriptKey && ttlSeconds && ttlSeconds > 0) {
    _setScriptCacheJSON(scriptKey, value, ttlSeconds);
  }
  return value;
}

function _invalidateCacheGroup(group) {
  if (group === 'ACTIVE_USERS') {
    _invalidateRequestCache(REQUEST_CACHE_KEYS.ACTIVE_USERS);
    _invalidateScriptCacheKeys([SCRIPT_CACHE_KEYS.ACTIVE_USERS]);
    return;
  }
  if (group === 'ACTIVE_FOLDERS') {
    _invalidateRequestCache(REQUEST_CACHE_KEYS.ACTIVE_FOLDERS);
    _invalidateScriptCacheKeys([SCRIPT_CACHE_KEYS.ACTIVE_FOLDERS]);
    return;
  }
  if (group === 'TASK_TABLE') {
    _invalidateRequestCache(REQUEST_CACHE_KEYS.TASK_TABLE);
  }
}

function _invalidateUserInfoCache(email) {
  const normalized = _normalizeEmail(email);
  if (normalized) {
    _invalidateRequestCache(REQUEST_CACHE_KEYS.USER_INFO_PREFIX + normalized);
  }
  const raw = String(email || '').trim();
  const keys = [];
  if (normalized) keys.push('user_info_' + normalized);
  if (raw && raw !== normalized) keys.push('user_info_' + raw);
  if (keys.length) {
    _invalidateScriptCacheKeys(keys);
  }
}

// ====== 認証設定（削除） ======
// GCPクライアントIDは不要になったため削除します。
// const OAUTH_CLIENT_ID = '...';

// ====== 共通ユーティリティ ======
function _getSpreadsheet() {
  if (!_cachedSpreadsheet) {
    _cachedSpreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _cachedSpreadsheet;
}

function _openSheet(name) {
  if (_sheetCache[name]) return _sheetCache[name];
  const ss = _getSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  _sheetCache[name] = sh;
  return sh;
}

function _openCommentSheet() {
  const candidates = ['T_Comments', 'T_Commemts'];
  const ss = _getSpreadsheet();
  for (let i = 0; i < candidates.length; i++) {
    const sheetName = candidates[i];
    if (_sheetCache[sheetName]) return _sheetCache[sheetName];
    const sh = ss.getSheetByName(sheetName);
    if (sh) {
      _sheetCache[sheetName] = sh;
      return sh;
    }
  }
  throw new Error('コメントシートが見つかりません (T_Comments または T_Commemts)');
}
function _formatJST(d, fmt) {
  if (!d) return '';
  let dateObj;
  if (Object.prototype.toString.call(d) === '[object Date]') {
    dateObj = new Date(d.getTime());
  } else if (typeof d === 'number') {
    dateObj = new Date(d);
  } else if (typeof d === 'string') {
    if (d.trim() === '') return '';
    dateObj = new Date(d);
  } else {
    return '';
  }
  if (isNaN(dateObj.getTime())) return '';
  return Utilities.formatDate(dateObj, 'Asia/Tokyo', fmt || 'yyyy-MM-dd');
}
function _priorityWeight(p) {
  // 並び順: 高 → 中 → 低
  if (p === '高') return 1;
  if (p === '中') return 2;
  return 3;
}

function _coerceDateValue(value) {
  if (!value) return null;
  let dateObj;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    dateObj = new Date(value.getTime());
  } else if (typeof value === 'number') {
    dateObj = new Date(value);
  } else if (typeof value === 'string') {
    if (value.trim() === '') return null;
    dateObj = new Date(value);
  } else {
    return null;
  }
  if (isNaN(dateObj.getTime())) return null;
  return dateObj.getTime();
}

function testFolderAccess() {
  const folderId = '1D1nUL4-wtbrXErVyf3ERyyZ6PhuJtAdX';
  const folder = DriveApp.getFolderById(folderId);
  Logger.log(folder.getName());
  folder.createFile('test.txt', 'hello');
}

function _startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

function _normalizeRole(role) {
  const key = String(role || '')
    .trim()
    .toLowerCase();
  if (!key) return 'guest';
  return ROLE_ALIASES[key] || 'guest';
}

function _normalizeUserStatus(status) {
  const value = String(status || '')
    .trim()
    .toLowerCase();
  if (!value) return 'pending';
  if (value === 'active' || value === 'pending' || value === 'suspended') return value;
  if (value === 'disabled' || value === 'inactive') return 'suspended';
  if (value === 'revoked') return 'revoked';
  return 'pending';
}

function _isManagerRole(role) {
  const normalized = _normalizeRole(role);
  return normalized === 'admin' || normalized === 'manager';
}

function _isAdminRole(role) {
  return _normalizeRole(role) === 'admin';
}

function _normalizeStatus(status) {
  return String(status || '').trim();
}

function _isCompletedStatus(status) {
  return _normalizeStatus(status) === '完了';
}

function _normalizeTaskId(taskId) {
  if (taskId == null) return '';
  return String(taskId).trim();
}

function _normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function _emailArrayContains(arr, target) {
  if (!Array.isArray(arr)) return false;
  const normalizedTarget = _normalizeEmail(target);
  if (!normalizedTarget) return false;
  for (let i = 0; i < arr.length; i++) {
    if (_normalizeEmail(arr[i]) === normalizedTarget) {
      return true;
    }
  }
  return false;
}

/**
 * 【修正】現在ログインしているユーザーのメールアドレスを取得します。
 * GASの組み込み認証を使用するため、Session.getActiveUser().getEmail()のみで取得できます。
 */
function _getCurrentEmail() {
  if (__CURRENT_REQUEST_EMAIL) {
    return __CURRENT_REQUEST_EMAIL;
  }
  return String(Session.getActiveUser().getEmail() || '').trim();
}

/** 監査ログシートの列保証 */
function _ensureAuditSheet() {
  const ss = _getSpreadsheet();
  const sh = ss.getSheetByName('T_Audit') || ss.insertSheet('T_Audit');
  _sheetCache['T_Audit'] = sh;
  _ensureColumns(sh, ['AuditID', 'Type', 'TargetID', 'Action', 'UserEmail', 'At', 'Meta']);
  return sh;
}
/** 監査ログ記録のユーティリティ */
function _audit(type, targetId, action, meta) {
  try {
    const sh = _ensureAuditSheet();
    const id = Utilities.getUuid();
    const email = _getCurrentEmail();
    const row = [
      id,
      String(type || ''),
      String(targetId || ''),
      String(action || ''),
      email,
      new Date(),
      meta != null ? JSON.stringify(meta) : '',
    ];
    sh.appendRow(row);
    return id;
  } catch (e) {
    Logger.log('AUDIT_FAIL: ' + e);
    return '';
  }
}

function _ensureLoginAuditSheet() {
  const ss = _getSpreadsheet();
  const sh = ss.getSheetByName('T_LoginAudit') || ss.insertSheet('T_LoginAudit');
  _sheetCache['T_LoginAudit'] = sh;
  _ensureColumns(sh, LOGIN_AUDIT_COLUMNS);
  return sh;
}

function _ensureProxyLogSheet() {
  const ss = _getSpreadsheet();
  const sh = ss.getSheetByName('T_AuthProxyLogs') || ss.insertSheet('T_AuthProxyLogs');
  _sheetCache['T_AuthProxyLogs'] = sh;
  _ensureColumns(sh, PROXY_LOG_COLUMNS);
  return sh;
}

function _appendProxyLog(entry, headers) {
  try {
    const sh = _ensureProxyLogSheet();
    const hdr = _ensureColumns(sh, PROXY_LOG_COLUMNS);
    const width = sh.getLastColumn();
    const row = new Array(width);
    for (let i = 0; i < width; i++) row[i] = '';
    const raw = entry && typeof entry === 'object' ? entry : {};
    const logId = raw.id ? String(raw.id) : Utilities.getUuid();
    const headerIp =
      _getHeaderValue(headers || {}, 'X-ShiftFlow-Client-IP') ||
      _getHeaderValue(headers || {}, 'X-Forwarded-For');
    const headerAgent =
      _getHeaderValue(headers || {}, 'X-ShiftFlow-User-Agent') ||
      _getHeaderValue(headers || {}, 'User-Agent');
    const headerCfRay =
      _getHeaderValue(headers || {}, 'X-ShiftFlow-CF-Ray') || _getHeaderValue(headers || {}, 'CF-Ray');
    if (hdr['LogID'] != null) row[hdr['LogID']] = logId;
    if (hdr['Level'] != null) row[hdr['Level']] = (raw.level || 'info').toString().toLowerCase();
    if (hdr['Event'] != null) row[hdr['Event']] = raw.event ? String(raw.event) : '';
    if (hdr['Message'] != null) row[hdr['Message']] = raw.message ? String(raw.message) : '';
    if (hdr['RequestID'] != null) row[hdr['RequestID']] = raw.requestId ? String(raw.requestId) : '';
    if (hdr['Route'] != null) row[hdr['Route']] = raw.route ? String(raw.route) : '';
    if (hdr['Email'] != null) row[hdr['Email']] = raw.email ? String(raw.email) : '';
    if (hdr['Status'] != null) row[hdr['Status']] = raw.status ? String(raw.status) : '';
    if (hdr['Meta'] != null) {
      let metaJson = '';
      if (raw.meta != null) {
        try {
          metaJson = JSON.stringify(raw.meta);
        } catch (metaErr) {
          metaJson = String(raw.meta);
        }
      }
      row[hdr['Meta']] = metaJson;
    }
    if (hdr['Source'] != null) row[hdr['Source']] = raw.source ? String(raw.source) : 'cloudflare';
    if (hdr['ClientIp'] != null) row[hdr['ClientIp']] = raw.clientIp ? String(raw.clientIp) : headerIp || '';
    if (hdr['UserAgent'] != null)
      row[hdr['UserAgent']] = raw.userAgent ? String(raw.userAgent) : headerAgent || '';
    if (hdr['CfRay'] != null) row[hdr['CfRay']] = raw.cfRay ? String(raw.cfRay) : headerCfRay || '';
    if (hdr['CreatedAt'] != null) row[hdr['CreatedAt']] = new Date();
    sh.appendRow(row);
    return logId;
  } catch (err) {
    Logger.log('[ShiftFlow][Auth] PROXY_LOG_FAIL: ' + err);
    return '';
  }
}

function _logLoginAttempt(entry) {
  try {
    const sh = _ensureLoginAuditSheet();
    const hdr = _getHeaderMap(sh);
    const width = sh.getLastColumn();
    const row = new Array(width);
    for (let i = 0; i < width; i++) row[i] = '';
    const loginId = entry && entry.id ? String(entry.id) : Utilities.getUuid();
    const status = entry && entry.status ? String(entry.status) : '';
    if (hdr['LoginID'] != null) row[hdr['LoginID']] = loginId;
    if (hdr['UserEmail'] != null) row[hdr['UserEmail']] = entry && entry.email ? entry.email : '';
    if (hdr['UserSub'] != null) row[hdr['UserSub']] = entry && entry.sub ? entry.sub : '';
    if (hdr['Status'] != null) row[hdr['Status']] = status;
    if (hdr['Reason'] != null) row[hdr['Reason']] = entry && entry.reason ? entry.reason : '';
    if (hdr['RequestID'] != null) row[hdr['RequestID']] = entry && entry.requestId ? entry.requestId : '';
    if (hdr['TokenIat'] != null) row[hdr['TokenIat']] = entry && entry.tokenIat ? entry.tokenIat : '';
    if (hdr['AttemptedAt'] != null) row[hdr['AttemptedAt']] = new Date();
    if (hdr['ClientIp'] != null) row[hdr['ClientIp']] = entry && entry.clientIp ? entry.clientIp : '';
    if (hdr['UserAgent'] != null) row[hdr['UserAgent']] = entry && entry.userAgent ? entry.userAgent : '';
    if (hdr['Role'] != null) row[hdr['Role']] = entry && entry.role ? entry.role : '';
    sh.appendRow(row);
    return loginId;
  } catch (err) {
    Logger.log('LOGIN_AUDIT_FAIL: ' + err);
    return '';
  }
}

/** ヘッダー行を取得して {列名: index} を返す */
function _getHeaderMap(sh) {
  const lastColumn = sh.getLastColumn();
  if (!lastColumn) {
    throw new Error('ヘッダー行が存在しません: ' + sh.getName());
  }
  const header = sh.getRange(1, 1, 1, lastColumn).getValues()[0];
  return _buildHeaderMapFromRow(header);
}

function _buildHeaderMapFromRow(header) {
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const key = String(header[i] || '').trim();
    if (key) map[key] = i;
  }
  return map;
}

function serveManifest() {
  const content = HtmlService.createTemplateFromFile('manifest').getRawContent();
  return ContentService.createTextOutput(content).setMimeType(ContentService.MimeType.JSON);
}

/** ヘッダーの存在を保証（なければ末尾に追加）し、最新のヘッダーマップを返す */
function _ensureColumns(sh, colNames) {
  const lastRow = sh.getLastRow();
  if (!lastRow) {
    sh.getRange(1, 1, 1, colNames.length).setValues([colNames]);
    return _buildHeaderMapFromRow(colNames);
  }
  const lastColumn = sh.getLastColumn();
  const width = Math.max(lastColumn, colNames.length);
  const headerRange = sh.getRange(1, 1, 1, width);
  const header = headerRange.getValues()[0];
  let changed = false;
  colNames.forEach((name) => {
    if (header.indexOf(name) === -1) {
      header.push(name);
      changed = true;
    }
  });
  if (changed) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return _buildHeaderMapFromRow(header);
}

function _writeRow(sh, rowIndex, rowValues) {
  const lastCol = sh.getLastColumn();
  const payload = rowValues.slice();
  if (payload.length < lastCol) {
    for (let i = payload.length; i < lastCol; i++) {
      payload.push('');
    }
  } else if (payload.length > lastCol) {
    payload.length = lastCol;
  }
  sh.getRange(rowIndex, 1, 1, lastCol).setValues([payload]);
}

/** 文字列CSVを配列へ */
function _csvToArray(s) {
  if (!s) return [];
  return String(s)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
/** 配列をCSVへ */
function _arrayToCsv(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.filter(Boolean).join(',');
}

function _ensureFolder(folderId, label) {
  const id = String(folderId || '').trim();
  if (!id) throw new Error(label + '用のフォルダIDが設定されていません。');
  try {
    return DriveApp.getFolderById(id);
  } catch (e) {
    throw new Error(label + '用のフォルダにアクセスできません: ' + e);
  }
}

function _sanitizeDriveFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_');
}

function _profileImageFileName(email) {
  const normalized = _sanitizeDriveFileName(String(email || '').trim() || 'user');
  return normalized + '.ProfileImage';
}

function _extractImageBlob(dataUri, maxBytes) {
  if (!dataUri) return null;
  const trimmed = String(dataUri).trim();
  const match = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) throw new Error('画像データ形式が不正です。');
  const mimeType = match[1];
  const base64 = match[2].replace(/\s/g, '');
  const bytes = Utilities.base64Decode(base64);
  if (maxBytes && bytes.length > maxBytes) {
    throw new Error('画像サイズが大きすぎます (最大 ' + maxBytes + ' バイト)。');
  }
  return Utilities.newBlob(bytes, mimeType);
}

function _shareForDomain(file) {
  // 共有設定はフォルダ側で管理するためここでは変更しない
  try {
    file.getSharingAccess();
  } catch (e) {
    _audit('drive', file.getId(), 'share_access_fail', { error: String(e) });
  }
}

function _clearExistingFiles(folder, name) {
  const existing = folder.getFilesByName(name);
  while (existing.hasNext()) {
    try {
      existing.next().setTrashed(true);
    } catch (e) {
      _audit('drive', folder.getId(), 'cleanup_fail', { name: name, error: String(e) });
    }
  }
}

function _driveViewUrl(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return '';
  return 'https://drive.google.com/uc?id=' + encodeURIComponent(id) + '&export=download';
}

function _driveDownloadUrl(fileId) {
  const id = String(fileId || '').trim();
  if (!id) return '';
  return 'https://drive.google.com/uc?id=' + encodeURIComponent(id) + '&export=download';
}

function _deleteDriveFileById(fileId) {
  try {
    if (!fileId) return;
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (err) {
    _audit('drive', fileId, 'delete_fail', { error: String(err) });
  }
}

function _guessImageExtension(mimeType, originalName) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/heic': '.heic',
    'image/heif': '.heif',
    'image/bmp': '.bmp',
  };
  if (mimeType && map[mimeType]) return map[mimeType];
  const nameMatch = String(originalName || '').match(/\.[a-zA-Z0-9]+$/);
  if (nameMatch && nameMatch[0]) return nameMatch[0];
  return '.png';
}

function _storeProfileImage(dataUri, email) {
  const blob = _extractImageBlob(dataUri, MAX_PROFILE_IMAGE_BYTES);
  if (!blob) throw new Error('画像データが不正です。');
  const fileName = _profileImageFileName(email);
  blob.setName(fileName);
  const folder = _ensureFolder(PROFILE_IMAGE_FOLDER_ID, 'プロフィール画像');
  _clearExistingFiles(folder, fileName);
  const file = folder.createFile(blob);
  _shareForDomain(file);
  file.setName(fileName);
  return {
    fileId: file.getId(),
    url: _driveViewUrl(file.getId()),
    name: fileName,
  };
}

function _storeMessageAttachment(attachment, ownerEmail) {
  if (!attachment || !attachment.dataUri) return null;
  const blob = _extractImageBlob(attachment.dataUri, MAX_MESSAGE_ATTACHMENT_BYTES);
  if (!blob) return null;
  const mimeType = blob.getContentType();
  if (!/^image\//i.test(mimeType || '')) {
    throw new Error('画像ファイルのみアップロードできます。');
  }
  const baseName = _sanitizeDriveFileName(
    (attachment.name || '').replace(/\.[^.]+$/, '') || 'attachment'
  );
  const extension = _guessImageExtension(mimeType, attachment.name);
  const shortId = Utilities.getUuid().slice(0, 8);
  const fileName = baseName + '_' + shortId + extension;
  blob.setName(fileName);
  const folder = _ensureFolder(MESSAGE_ATTACHMENT_FOLDER_ID, 'メッセージ添付ファイル');
  const file = folder.createFile(blob);
  _shareForDomain(file);
  file.setName(fileName);
  return {
    fileId: file.getId(),
    fileName: fileName,
    owner: ownerEmail,
  };
}

function _extractDriveFileId(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (!str) return '';
  if (/^[a-zA-Z0-9_-]{10,}$/.test(str) && str.indexOf('http') !== 0) return str;
  const byPath = str.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (byPath && byPath[1]) return byPath[1];
  const byQuery = str.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (byQuery && byQuery[1]) return byQuery[1];
  return '';
}

/** 添付IDの正規化 */
function _parseAttachmentIds(csv) {
  return _csvToArray(csv)
    .map(function (x) {
      return x.trim();
    })
    .filter(Boolean);
}

/** Driveメタを取得（存在しないIDはスキップ、必要に応じて権限補正） */
function _getAttachmentMetas(ids) {
  const metas = [];
  ids.forEach(function (id) {
    try {
      const f = DriveApp.getFileById(id);
      // 社内既定の閲覧権限に補正（必要時のみ）。失敗は監査。
      try {
        const perm = f.getSharingAccess();
        if (perm !== DriveApp.Access.DOMAIN_WITH_LINK && perm !== DriveApp.Access.DOMAIN) {
          f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
          _audit('attach', id, 'perm_adjust', { to: 'DOMAIN_WITH_LINK' });
        }
      } catch (pe) {
        _audit('attach', id, 'perm_adjust_fail', { error: String(pe) });
      }
      metas.push({
        id: id,
        name: f.getName(),
        mimeType: f.getMimeType(),
        size: f.getSize(),
        url: 'https://drive.google.com/open?id=' + id,
      });
    } catch (e) {
      _audit('attach', id, 'meta_fail', { error: String(e) });
    }
  });
  return metas;
}

// ====== 認証API（削除） ======
// 以下の startSession, logout, _verifyGoogleIdToken_ は
// カスタム認証専用のため、不要になります。

/*
function startSession(idToken){ ... }
function logout(){ ... }
function _verifyGoogleIdToken_(idToken){ ... }
*/

/**
 * M_Users にユーザーを保証し、レコード情報を返す。
 * opts:
 *   - email (override current email)
 *   - displayName
 *   - sub (Google subject)
 *   - initialStatus ('pending'|'active'|'suspended')
 *   - initialRole
 *   - updateLastLogin (boolean)
 *   - status (force status update)
 *   - approvedBy / approvedAt
 */
function _ensureUserRecord_(opts) {
  const options = opts || {};
  const rawEmail = options.email || _getCurrentEmail();
  const email = String(rawEmail || '').trim();
  const normalizedEmail = _normalizeEmail(email);
  if (!normalizedEmail) return null;

  const sh = _openSheet('M_Users');
  const hdr = _ensureColumns(sh, USER_SHEET_COLUMNS);
  const width = sh.getLastColumn();
  const lastRow = sh.getLastRow();

  let targetRow = -1;
  let rowValues = null;

  if (lastRow >= 2) {
    const data = sh.getRange(2, 1, lastRow - 1, width).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowEmail = hdr['Email'] != null ? row[hdr['Email']] : '';
      if (_normalizeEmail(rowEmail) === normalizedEmail) {
        targetRow = i + 2;
        rowValues = row.slice();
        break;
      }
      if (options.sub && hdr['AuthSubject'] != null) {
        const rowSub = String(row[hdr['AuthSubject']] || '').trim();
        if (rowSub && rowSub === options.sub) {
          targetRow = i + 2;
          rowValues = row.slice();
          break;
        }
      }
    }
  }

  const now = new Date();
  const normalizedRole = _normalizeRole(options.initialRole || 'member');
  const desiredStatus = String(options.initialStatus || 'pending').toLowerCase();
  const displayName = options.displayName || options.name || email;

  if (targetRow === -1 || !rowValues) {
    const newRow = new Array(width);
    for (let c = 0; c < width; c++) {
      newRow[c] = '';
    }
    if (hdr['UserID'] != null) newRow[hdr['UserID']] = Utilities.getUuid();
    if (hdr['Email'] != null) newRow[hdr['Email']] = email;
    if (hdr['DisplayName'] != null) newRow[hdr['DisplayName']] = displayName;
    if (hdr['ProfileImage'] != null) newRow[hdr['ProfileImage']] = PROFILE_PLACEHOLDER_URL;
    if (hdr['Role'] != null) newRow[hdr['Role']] = normalizedRole;
    if (hdr['IsActive'] != null) newRow[hdr['IsActive']] = desiredStatus === 'active' ? 'TRUE' : 'FALSE';
    if (hdr['Theme'] != null) newRow[hdr['Theme']] = 'light';
    if (hdr['AuthSubject'] != null) newRow[hdr['AuthSubject']] = options.sub || '';
    if (hdr['Status'] != null) newRow[hdr['Status']] = desiredStatus;
    if (hdr['FirstLoginAt'] != null) newRow[hdr['FirstLoginAt']] = now;
    if (hdr['LastLoginAt'] != null) newRow[hdr['LastLoginAt']] = now;
    if (hdr['ApprovedBy'] != null) newRow[hdr['ApprovedBy']] = options.approvedBy || '';
    if (hdr['ApprovedAt'] != null) newRow[hdr['ApprovedAt']] = options.approvedAt || '';
    if (hdr['Notes'] != null) newRow[hdr['Notes']] = options.notes || '';
    sh.appendRow(newRow);
    _audit('user', email, 'auto_register', { status: desiredStatus });
    _invalidateCacheGroup('ACTIVE_USERS');
    _invalidateUserInfoCache(email);
    return _buildUserRecordFromRow(newRow, hdr);
  }

  let changed = false;
  if (hdr['DisplayName'] != null && displayName && rowValues[hdr['DisplayName']] !== displayName) {
    rowValues[hdr['DisplayName']] = displayName;
    changed = true;
  }
  if (hdr['AuthSubject'] != null && options.sub) {
    const currentSub = String(rowValues[hdr['AuthSubject']] || '').trim();
    if (!currentSub || currentSub !== options.sub) {
      rowValues[hdr['AuthSubject']] = options.sub;
      changed = true;
    }
  }
  if (options.status && hdr['Status'] != null) {
    const currentStatus = String(rowValues[hdr['Status']] || '').toLowerCase();
    if (currentStatus !== options.status) {
      rowValues[hdr['Status']] = options.status;
      if (hdr['IsActive'] != null) {
        rowValues[hdr['IsActive']] = options.status === 'active' ? 'TRUE' : 'FALSE';
      }
      changed = true;
    }
  }
  if (options.updateLastLogin && hdr['LastLoginAt'] != null) {
    rowValues[hdr['LastLoginAt']] = now;
    changed = true;
  }
  if (changed) {
    _writeRow(sh, targetRow, rowValues);
    _invalidateCacheGroup('ACTIVE_USERS');
    _invalidateUserInfoCache(email);
  }
  return _buildUserRecordFromRow(rowValues, hdr);
}

function _buildUserRecordFromRow(row, hdr) {
  if (!row || !hdr) return null;
  const record = {
    userId: hdr['UserID'] != null ? row[hdr['UserID']] : '',
    email: hdr['Email'] != null ? row[hdr['Email']] : '',
    displayName: hdr['DisplayName'] != null ? row[hdr['DisplayName']] || '' : '',
    rawRole: hdr['Role'] != null ? row[hdr['Role']] || '' : '',
    role: _normalizeRole(hdr['Role'] != null ? row[hdr['Role']] : ''),
    isActive:
      hdr['IsActive'] != null
        ? String(row[hdr['IsActive']] || '')
            .trim()
            .toUpperCase() === 'TRUE'
        : false,
    authSubject: hdr['AuthSubject'] != null ? row[hdr['AuthSubject']] || '' : '',
    firstLoginAt: hdr['FirstLoginAt'] != null ? row[hdr['FirstLoginAt']] || '' : '',
    lastLoginAt: hdr['LastLoginAt'] != null ? row[hdr['LastLoginAt']] || '' : '',
    approvedBy: hdr['ApprovedBy'] != null ? row[hdr['ApprovedBy']] || '' : '',
    approvedAt: hdr['ApprovedAt'] != null ? row[hdr['ApprovedAt']] || '' : '',
    notes: hdr['Notes'] != null ? row[hdr['Notes']] || '' : '',
  };
  const rawStatus = hdr['Status'] != null ? row[hdr['Status']] : '';
  const normalizedStatus = _normalizeUserStatus(rawStatus || (record.isActive ? 'active' : ''));
  record.status = normalizedStatus;
  return record;
}

function _getHeaderValue(headers, name) {
  if (!headers || !name) return '';
  const target = String(name).toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (String(key || '').toLowerCase() === target) {
      const value = headers[key];
      if (value == null) return '';
      if (Array.isArray(value)) {
        return value.length ? String(value[0] || '') : '';
      }
      return String(value || '');
    }
  }
  return '';
}

function _assertRequiredConfig() {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    throw _createHttpError(
      500,
      'GOOGLE_OAUTH_CLIENT_ID is not configured in Script Properties.'
    );
  }
}

function _verifySharedSecret(secretValue) {
  _assertRequiredConfig();
  if (!SHARED_SECRET || SHARED_SECRET_OPTIONAL) {
    if (SHARED_SECRET && SHARED_SECRET_OPTIONAL) {
      Logger.log('[ShiftFlow][Auth] Shared secret check bypassed (SHIFT_FLOW_SECRET_OPTIONAL=true).');
    }
    return true;
  }
  return String(secretValue || '').trim() === SHARED_SECRET;
}

function _verifyIdToken(idToken) {
  if (!idToken) {
    throw _createHttpError(401, 'Missing Authorization bearer token.');
  }
  _assertRequiredConfig();
  const url = GOOGLE_TOKENINFO_ENDPOINT + '?id_token=' + encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const status = response.getResponseCode();
  let payload = {};
  try {
    payload = JSON.parse(response.getContentText() || '{}');
  } catch (_err) {
    throw _createHttpError(401, 'Token verification returned an invalid payload.');
  }
  if (status !== 200) {
    const detail = payload && payload.error_description ? payload.error_description : payload.error;
    throw _createHttpError(401, 'Failed to verify ID token.', detail);
  }
  if (!payload || payload.aud !== GOOGLE_OAUTH_CLIENT_ID) {
    throw _createHttpError(401, 'ID token audience mismatch.');
  }
  if (GOOGLE_ISSUERS.indexOf(String(payload.iss || '')) === -1) {
    throw _createHttpError(401, 'ID token issuer mismatch.');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expSeconds = Number(payload.exp || 0);
  if (expSeconds && nowSeconds >= expSeconds) {
    throw _createHttpError(401, 'ID token has expired.');
  }
  const sub = String(payload.sub || '').trim();
  if (!sub) {
    throw _createHttpError(401, 'ID token is missing subject (sub).');
  }
  const email = String(payload.email || '').trim();
  if (!email) {
    throw _createHttpError(401, 'ID token is missing email.');
  }
  const emailVerifiedRaw = payload.email_verified;
  const emailVerified =
    emailVerifiedRaw === true ||
    emailVerifiedRaw === 'true' ||
    emailVerifiedRaw === 1 ||
    emailVerifiedRaw === '1';
  return {
    rawToken: idToken,
    sub: sub,
    email: email,
    emailVerified: emailVerified,
    name: payload.name || payload.given_name || '',
    picture: payload.picture || '',
    hd: payload.hd || '',
    iat: Number(payload.iat || 0),
    exp: expSeconds,
  };
}

function _buildRequestContext(e, route, body) {
  const headers = (e && e.headers) || {};
  const requestId = _getHeaderValue(headers, 'X-ShiftFlow-Request-Id') || Utilities.getUuid();
  const clientIp =
    _getHeaderValue(headers, 'X-ShiftFlow-Client-IP') ||
    _getHeaderValue(headers, 'X-Forwarded-For');
  const userAgent = _getHeaderValue(headers, 'X-ShiftFlow-User-Agent');
  const headerEmail = _getHeaderValue(headers, 'X-ShiftFlow-Email');
  const headerName = _getHeaderValue(headers, 'X-ShiftFlow-Name');
  const secret = _getHeaderValue(headers, 'X-ShiftFlow-Secret');
  if (!_verifySharedSecret(secret)) {
    Logger.log(
      '[ShiftFlow][Auth] Shared secret mismatch. requestId=%s emailHeader=%s ip=%s',
      requestId,
      headerEmail || '',
      clientIp || ''
    );
    throw _createHttpError(403, 'Shared secret mismatch.', 'shared_secret_mismatch');
  }
  const authHeader = _getHeaderValue(headers, 'Authorization');
  const token =
    authHeader && authHeader.indexOf('Bearer ') === 0 ? authHeader.slice('Bearer '.length).trim() : '';
  let tokenClaims;
  try {
    tokenClaims = _verifyIdToken(token);
  } catch (err) {
    Logger.log(
      '[ShiftFlow][Auth] ID token verification error. requestId=%s emailHeader=%s detail=%s',
      requestId,
      headerEmail || '',
      err && err.message ? err.message : String(err)
    );
    throw err;
  }
  if (!tokenClaims.emailVerified) {
    Logger.log(
      '[ShiftFlow][Auth] Email not verified. requestId=%s email=%s',
      requestId,
      tokenClaims.email || ''
    );
    throw _createHttpError(403, 'Google アカウントのメールアドレスが未確認です。', 'email_not_verified');
  }
  if (
    headerEmail &&
    _normalizeEmail(headerEmail) &&
    _normalizeEmail(headerEmail) !== _normalizeEmail(tokenClaims.email)
  ) {
    Logger.log(
      '[ShiftFlow][Auth] Email header mismatch. requestId=%s header=%s token=%s',
      requestId,
      headerEmail || '',
      tokenClaims.email || ''
    );
    throw _createHttpError(403, 'Email header mismatch.', 'email_mismatch');
  }
  const headerSub = _getHeaderValue(headers, 'X-ShiftFlow-Sub');
  if (headerSub && String(headerSub).trim() !== tokenClaims.sub) {
    Logger.log(
      '[ShiftFlow][Auth] Subject header mismatch. requestId=%s header=%s token=%s',
      requestId,
      headerSub || '',
      tokenClaims.sub || ''
    );
    throw _createHttpError(403, 'Subject header mismatch.', 'subject_mismatch');
  }

  __CURRENT_REQUEST_EMAIL = tokenClaims.email;
  __CURRENT_REQUEST_NAME = headerName || tokenClaims.name || tokenClaims.email;
  __CURRENT_ACCESS_CONTEXT = null;

  return {
    route: route,
    headers: headers,
    body: body,
    args: Array.isArray(body && body.args) ? body.args : [],
    requestId: requestId,
    authorizationToken: token,
    tokenClaims: tokenClaims,
    email: tokenClaims.email,
    sub: tokenClaims.sub,
    name: __CURRENT_REQUEST_NAME,
    domain: tokenClaims.hd || '',
    clientIp: clientIp || '',
    userAgent: userAgent || '',
  };
}

function _resolveAccessContextInternal(ctx, options) {
  const opts = options || {};
  const userRecord =
    _ensureUserRecord_({
      email: ctx.email,
      displayName: ctx.name,
      sub: ctx.sub,
      initialStatus: 'pending',
      initialRole: 'member',
    }) || {
      role: 'guest',
      status: 'pending',
      isActive: false,
      userId: '',
      authSubject: '',
    };

  let status = _normalizeUserStatus(userRecord.status || (userRecord.isActive ? 'active' : ''));
  if (!status && userRecord.isActive) status = 'active';
  let allowed = status === 'active';
  let reason = '';
  if (!allowed) {
    Logger.log(
      '[ShiftFlow][Auth] Access denied at context check. email=%s status=%s requestId=%s route=%s',
      ctx.email || '',
      status || '',
      ctx.requestId || '',
      ctx.route || ''
    );
    if (status === 'pending') {
      reason = '承認待ちです。管理者の承認をお待ちください。';
    } else if (status === 'suspended') {
      reason = '利用が停止されています。管理者にお問い合わせください。';
    } else if (status === 'revoked') {
      reason = 'アクセス権が取り消されています。';
    } else {
      reason = 'アクセスが制限されています。';
    }
  }

  if (opts.updateLastLogin && allowed) {
    _ensureUserRecord_({
      email: ctx.email,
      sub: ctx.sub,
      updateLastLogin: true,
    });
  }

  if (opts.logAttempt) {
    _logLoginAttempt({
      status: allowed ? 'success' : status || 'denied',
      reason: reason,
      email: ctx.email,
      sub: ctx.sub,
      requestId: ctx.requestId,
      tokenIat: ctx.tokenClaims && ctx.tokenClaims.iat ? String(ctx.tokenClaims.iat) : '',
      clientIp: ctx.clientIp,
      userAgent: ctx.userAgent,
      role: userRecord.role || 'guest',
    });
  }

  const accessContext = {
    allowed: allowed,
    status: status,
    role: userRecord.role || 'guest',
    email: ctx.email,
    displayName: ctx.name,
    reason: reason,
    userId: userRecord.userId || '',
    authSubject: userRecord.authSubject || '',
  };
  __CURRENT_ACCESS_CONTEXT = accessContext;
  return accessContext;
}

function _authorizeRouteAccess(route, ctx) {
  const accessContext = _resolveAccessContextInternal(ctx, {
    logAttempt: false,
    updateLastLogin: true,
  });
  if (!accessContext.allowed || accessContext.status !== 'active') {
    throw _createHttpError(
      403,
      'アクセスが許可されていません。',
      accessContext.reason || '承認待ち、または利用停止の可能性があります。'
    );
  }
  if (!_isRoleAllowedForRoute(route, accessContext.role)) {
    Logger.log(
      '[ShiftFlow][Auth] Route denied due to role. route=%s role=%s requestId=%s email=%s',
      route,
      accessContext.role || '',
      ctx.requestId || '',
      ctx.email || ''
    );
    throw _createHttpError(403, '権限がありません。');
  }
  return accessContext;
}

function _respondWithError(err, route) {
  if (!err) {
    return jsonResponse({ ok: false, error: 'Unknown error' }, 500);
  }
  const status = err && err.httpStatus ? Number(err.httpStatus) || 500 : 500;
  Logger.log(
    '[ShiftFlow][Auth] Responding with error. status=%s route=%s message=%s detail=%s',
    status,
    route || '',
    err && err.message ? err.message : 'Unknown error',
    err && err.detail ? err.detail : ''
  );
  const payload = {
    ok: false,
    error: err && err.message ? err.message : 'Internal Server Error',
  };
  if (err && err.detail) {
    payload.detail = err.detail;
    payload.reason = err.detail;
  }
  if (route) payload.route = route;
  return jsonResponse(payload, status);
}
// ====== ユーザー情報 ======
function _resolveProfileImageInfo(profileValue, email) {
  const raw = String(profileValue || '').trim();
  if (!raw || raw === PROFILE_PLACEHOLDER_URL) {
    return {
      imageUrl: PROFILE_PLACEHOLDER_URL,
      imageName: '',
      fileId: '',
    };
  }
  const fileId = _extractDriveFileId(raw);
  if (fileId) {
    try {
      const file = DriveApp.getFileById(fileId);
      const blob = file.getBlob();
      const contentType = blob.getContentType() || 'image/png';
      const bytes = blob.getBytes();
      const base64Data = Utilities.base64Encode(bytes || []);
      const dataUri = 'data:' + contentType + ';base64,' + base64Data;
      return {
        imageUrl: dataUri,
        imageName: _profileImageFileName(email),
        fileId: fileId,
      };
    } catch (err) {
      _audit('profile', fileId, 'image_fetch_fail', { error: String(err) });
      return {
        imageUrl: PROFILE_PLACEHOLDER_URL,
        imageName: _profileImageFileName(email),
        fileId: fileId,
      };
    }
  }
  if (raw.indexOf('http') === 0 || raw.indexOf('data:') === 0) {
    return {
      imageUrl: raw,
      imageName: '',
      fileId: '',
    };
  }
  return {
    imageUrl: PROFILE_PLACEHOLDER_URL,
    imageName: '',
    fileId: '',
  };
}

function getLoggedInUserInfo() {
  const rawEmail = _getCurrentEmail();
  const email = String(rawEmail || '').trim();
  const normalizedEmail = _normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      name: 'ゲスト',
      imageUrl: PROFILE_PLACEHOLDER_URL,
      role: 'guest',
      email: email,
      theme: 'light',
    };
  }

  const requestCacheKey = REQUEST_CACHE_KEYS.USER_INFO_PREFIX + normalizedEmail;
  const requestHit = _getRequestCacheValue(requestCacheKey);
  if (requestHit !== undefined) {
    return requestHit;
  }

  const scriptCacheKey = 'user_info_' + normalizedEmail;
  const scriptHit = _getScriptCacheJSON(scriptCacheKey);
  if (scriptHit) {
    _setRequestCacheValue(requestCacheKey, scriptHit);
    return scriptHit;
  }

  const userSheet = _openSheet('M_Users');
  const header = _ensureColumns(userSheet, USER_SHEET_COLUMNS);
  const THEME_COL = header['Theme'];
  const EMAIL_COL = header['Email'];
  const DISPLAY_COL = header['DisplayName'];
  const ROLE_COL = header['Role'];
  const IMAGE_COL = header['ProfileImage'];
  const lastRow = userSheet.getLastRow();
  const lastColumn = userSheet.getLastColumn();
  let info = {
    name: 'ゲスト',
    imageUrl: PROFILE_PLACEHOLDER_URL,
    imageName: '',
    role: 'guest',
    email: email,
    theme: 'light',
  };

  if (EMAIL_COL != null && lastRow >= 2 && lastColumn >= 1) {
    const values = userSheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (_normalizeEmail(row[EMAIL_COL]) !== normalizedEmail) continue;
      const profileMeta = _resolveProfileImageInfo(IMAGE_COL != null ? row[IMAGE_COL] : '', email);
      const rawRole = ROLE_COL != null ? row[ROLE_COL] : '';
      info = {
        name: (DISPLAY_COL != null ? row[DISPLAY_COL] : '') || 'ユーザー',
        imageUrl: profileMeta.imageUrl,
        imageName: profileMeta.imageName,
        role: _normalizeRole(rawRole),
        email: email,
        theme: THEME_COL != null ? row[THEME_COL] || 'light' : 'light',
      };
      break;
    }
  }
  _setRequestCacheValue(requestCacheKey, info);
  _setScriptCacheJSON(scriptCacheKey, info, 3600);
  return info;
}

function getAuthStatus() {
  const activeEmail = String(_getCurrentEmail() || '').trim();
  const normalized = _normalizeEmail(activeEmail);
  const status = {
    activeEmail: activeEmail,
    normalizedActiveEmail: normalized,
    effectiveUserEmail: String(Session.getEffectiveUser().getEmail() || '').trim(),
    hasSpreadsheetAccess: false,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID,
    userRecord: null,
    error: '',
  };
  try {
    const ss = _getSpreadsheet();
    status.hasSpreadsheetAccess = true;
    const userSheet = ss.getSheetByName('M_Users');
    if (userSheet && normalized) {
      const header = _ensureColumns(userSheet, USER_SHEET_COLUMNS);
      const values = userSheet.getDataRange().getValues();
      for (let i = 1; i < values.length; i++) {
        if (_normalizeEmail(values[i][header['Email']]) === normalized) {
          status.userRecord = {
            email: values[i][header['Email']],
            name: values[i][header['DisplayName']] || '',
            role: values[i][header['Role']] || '',
            isActive:
              String(values[i][header['IsActive']] || '')
                .trim()
                .toUpperCase() === 'TRUE',
            theme: header['Theme'] != null ? values[i][header['Theme']] || '' : '',
          };
          break;
        }
      }
    }
  } catch (err) {
    status.error = String(err);
  }
  return status;
}

function getBootstrapData() {
  const userInfo = getLoggedInUserInfo();
  const bootstrap = {
    userInfo: userInfo,
    users: [],
    folders: [],
    myTasks: { tasks: [], meta: {} },
    isManager: _isManagerRole(userInfo.role),
    theme: userInfo.theme || '',
  };
  try {
    bootstrap.users = listActiveUsers();
  } catch (userErr) {
    bootstrap.users = [];
    bootstrap.usersError = String(userErr);
  }
  try {
    bootstrap.folders = listActiveFolders();
  } catch (folderErr) {
    bootstrap.folders = [];
    bootstrap.foldersError = String(folderErr);
  }
  try {
    bootstrap.myTasks = listMyTasks();
  } catch (taskErr) {
    bootstrap.myTasks = {
      tasks: [],
      meta: {
        error: String(taskErr),
      },
    };
  }
  return bootstrap;
}

function isManagerUser() {
  const u = getLoggedInUserInfo();
  return _isManagerRole(u.role);
}

function listActiveUsers() {
  return _getCachedValue(
    REQUEST_CACHE_KEYS.ACTIVE_USERS,
    SCRIPT_CACHE_KEYS.ACTIVE_USERS,
    300,
    function () {
      const sh = _openSheet('M_Users');
      const header = _ensureColumns(sh, USER_SHEET_COLUMNS);
      const EMAIL_COL = header['Email'];
      const DISPLAY_COL = header['DisplayName'];
      const ROLE_COL = header['Role'];
      const ACTIVE_COL = header['IsActive'];
      if (EMAIL_COL == null || ACTIVE_COL == null) return [];

      const lastRow = sh.getLastRow();
      const lastColumn = sh.getLastColumn();
      if (lastRow < 2 || lastColumn < 1) {
        return [];
      }

      const values = sh.getRange(2, 1, lastRow - 1, lastColumn).getValues();
      const res = [];
      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        const isActive =
          String(row[ACTIVE_COL] || '')
            .trim()
            .toUpperCase() === 'TRUE';
        if (!isActive) continue;
        const rawRole = ROLE_COL != null ? row[ROLE_COL] : '';
        res.push({
          email: row[EMAIL_COL],
          name: DISPLAY_COL != null ? row[DISPLAY_COL] : '',
          role: _normalizeRole(rawRole),
        });
      }
      if (res.length === 0) {
        return [
          { id: '全体', name: '全体' },
          { id: 'ブッフェ', name: 'ブッフェ' },
          { id: 'レセプション', name: 'レセプション' },
          { id: 'ホール', name: 'ホール' },
        ];
      }
      return res;
    }
  );
}
function listActiveFolders() {
  return _getCachedValue(
    REQUEST_CACHE_KEYS.ACTIVE_FOLDERS,
    SCRIPT_CACHE_KEYS.ACTIVE_FOLDERS,
    300,
    function () {
      const sh = _openSheet('M_Folders');
      const hdr = _getHeaderMap(sh);
      const ID_COL = hdr['FolderID'];
      const NAME_COL = hdr['FolderName'];
      const ARCHIVE_COL = hdr['IsArchived'];
      const lastRow = sh.getLastRow();
      const lastColumn = sh.getLastColumn();
      if (lastRow < 2 || lastColumn < 1) {
        return [];
      }
      const values = sh.getRange(2, 1, lastRow - 1, lastColumn).getValues();
      const res = [];
      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        if (ARCHIVE_COL != null && String(row[ARCHIVE_COL]) === 'TRUE') continue;
        const rawId = ID_COL != null ? String(row[ID_COL] || '').trim() : '';
        const rawName = NAME_COL != null ? String(row[NAME_COL] || '').trim() : '';
        const effectiveId = rawId || rawName;
        if (!effectiveId) continue;
        res.push({ id: effectiveId, name: rawName || effectiveId });
      }
      if (res.length === 0) {
        return [
          { id: '全体', name: '全体' },
          { id: 'ブッフェ', name: 'ブッフェ' },
          { id: 'レセプション', name: 'レセプション' },
          { id: 'ホール', name: 'ホール' },
        ];
      }
      return res;
    }
  );
}

function cleanUpArchiveData() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - CLEANUP_MONTH_THRESHOLD);
  const cutoffMs = cutoff.getTime();

  // ===== タスク削除 =====
  try {
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);
    const values = sh.getDataRange().getValues();
    const rowsToDelete = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const status = _normalizeStatus(row[header['Status']]);
      if (status !== '完了') continue;
      const completedAt = _coerceDateValue(row[header['UpdatedAt']] || row[header['CreatedAt']]);
      if (completedAt != null && completedAt <= cutoffMs) {
        rowsToDelete.push(i + 1);
        const attachmentIds =
          header['AttachmentIDs'] != null ? _parseAttachmentIds(row[header['AttachmentIDs']]) : [];
        attachmentIds.forEach(_deleteDriveFileById);
      }
    }
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      sh.deleteRow(rowsToDelete[i]);
    }
  } catch (taskErr) {
    _audit('cleanup', '', 'task_cleanup_fail', { error: String(taskErr) });
  }

  // ===== メッセージ削除 =====
  try {
    const sh = _openSheet('T_Memos');
    const header = _ensureColumns(sh, MEMO_SHEET_COLUMNS);
    const values = sh.getDataRange().getValues();
    const rowsToDelete = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const createdAt = _coerceDateValue(row[header['CreatedAt']]);
      if (createdAt != null && createdAt <= cutoffMs) {
        rowsToDelete.push(i + 1);
        const attachmentIds =
          header['AttachmentIDs'] != null ? _parseAttachmentIds(row[header['AttachmentIDs']]) : [];
        attachmentIds.forEach(_deleteDriveFileById);
      }
    }
    for (let i = rowsToDelete.length - 1; i >= 0; i--) {
      sh.deleteRow(rowsToDelete[i]);
    }
  } catch (memoErr) {
    _audit('cleanup', '', 'memo_cleanup_fail', { error: String(memoErr) });
  }
}

// ====== doGet ======
function doGet(e) {
  _clearRequestCache();
  try {
    if (e && e.parameter && e.parameter.route) {
      const route = e.parameter.route;
      if (route === 'ping') {
        return jsonResponse({
          ok: true,
          route: 'ping',
          ts: new Date().toISOString(),
        });
      }
      return jsonResponse({
        ok: true,
        route: route || 'root',
      });
    }

    if (e && e.parameter && e.parameter.page === 'manifest') {
      return serveManifest();
    }

    return jsonResponse(
      {
        ok: false,
        error: 'Direct access is not supported.',
        detail: 'ShiftFlow API is available via the Cloudflare proxy.',
      },
      200
    );
  } finally {
    _clearRequestCache();
  }
}

// 他の関数（_ensureUserRecord_, getLoggedInUserInfoなど）は変更不要

// ====== ホーム（今日のタスク/メッセージ） ======
function getHomeContent() {
  const rawEmail = _getCurrentEmail();
  const normalizedEmail = _normalizeEmail(rawEmail);
  const todayMs = _startOfToday();
  const data = _loadTaskTable();
  const todays = data.tasks
    .filter(function (task) {
      if (!normalizedEmail) return false;
      if (_emailArrayContains(task.assignees, rawEmail)) return true;
      if (_emailArrayContains(task.assignees, normalizedEmail)) return true;
      if (_normalizeEmail(task.assignee) === normalizedEmail) return true;
      return false;
    })
    .filter(function (task) {
      return !task.isCompleted && task.dueValue != null && task.dueValue <= todayMs;
    })
    .sort(function (a, b) {
      return _compareTasksForList(a, b, todayMs);
    })
    .map(function (task) {
      return {
        id: task.id,
        title: task.title,
        dueDate: task.dueDate ? _formatJST(task.dueDate, 'M/d') : '',
        priority: task.priority,
        assignees: task.assignees,
        assignee: task.assignee,
        status: task.status,
        isCompleted: task.isCompleted,
      };
    });
  const messages = getMessages();

  return { tasks: todays, messages: messages };
}

// ====== タスク CRUD/一覧 ======
function addNewTask(taskObject) {
  try {
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);

    const newId = Utilities.getUuid();
    const now = new Date();
    const current = _getCurrentEmail();

    const assignees = Array.isArray(taskObject.assignees)
      ? taskObject.assignees.map((addr) => String(addr || '').trim()).filter(Boolean)
      : current
      ? [current]
      : [];
    const primaryAssignee = assignees.length ? assignees[0] : current;
    const assigneesCsv = _arrayToCsv(assignees);

    const row = [];
    row[header['TaskID']] = newId;
    row[header['Title']] = taskObject.title;
    row[header['AssigneeEmail']] = primaryAssignee;
    row[header['DueDate']] = taskObject.dueDate;
    row[header['Status']] = '未着手';
    row[header['CreatedBy']] = current;
    row[header['CreatedAt']] = now;
    row[header['Priority']] = taskObject.priority || '中';
    if (header['AssigneeEmails'] != null) row[header['AssigneeEmails']] = assigneesCsv;
    const repeatRuleValue = taskObject.repeatRule || '';
    if (header['RepeatRule'] != null) row[header['RepeatRule']] = repeatRuleValue;
    if (header['UpdatedAt'] != null) row[header['UpdatedAt']] = '';
    if (header['ParentTaskID'] != null) row[header['ParentTaskID']] = '';
    if (header['Attachments'] != null) row[header['Attachments']] = '';
    if (header['AttachmentIDs'] != null) row[header['AttachmentIDs']] = '';

    const lastCol = sh.getLastColumn();
    for (let c = 0; c < lastCol; c++) {
      if (row[c] === undefined) row[c] = '';
    }
    sh.appendRow(row);
    _audit('task', newId, 'create', {
      title: taskObject.title,
      dueDate: taskObject.dueDate,
      priority: row[header['Priority']],
      assignees: assignees,
    });
    _invalidateCacheGroup('TASK_TABLE');
    return { success: true, message: 'タスクを追加しました。' };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('task', '', 'create_fail', { error: String(e), payload: taskObject });
    return { success: false, message: 'エラーが発生しました: ' + e.message, logId: logId };
  }
}

/**
 * 生のタスクデータから最終的なタスクオブジェクトを構築するヘルパー関数。
 * この関数は、シートからのデータとフォールバックからのデータの両方を処理し、
 * canDeleteの決定、ステータスの正規化、デフォルト値の設定など、共通のロジックを集約します。
 * @param {object} rawData - タスクの生データ。id, title, createdByなどのプロパティを持つ。
 * @returns {object} - 整形された最終的なタスクオブジェクト。
 */
function _buildTaskObject(rawData) {
  const current = _getCurrentEmail();
  const normalizedCurrent = _normalizeEmail(current);
  const createdBy = rawData.createdBy || '';
  const canDelete = _normalizeEmail(createdBy) === normalizedCurrent || isManagerUser();
  const assignees = Array.isArray(rawData.assignees) ? rawData.assignees : [];

  return {
    id: rawData.id,
    title: rawData.title,
    assignee: rawData.assignee || (assignees.length > 0 ? assignees[0] : ''),
    dueDate: _formatJST(rawData.dueDate, 'yyyy-MM-dd'),
    status: _normalizeStatus(rawData.status),
    priority: rawData.priority || '中',
    createdBy: createdBy,
    canDelete: canDelete,
    assignees: assignees,
    attachments: [], // 元のコードと同様に常に空配列
    repeatRule: rawData.repeatRule || '',
    updatedAt: _formatJST(rawData.updatedAt, 'yyyy-MM-dd HH:mm:ss'),
  };
}

/**
 * 指定されたTaskIDに基づいてタスク情報を取得します。
 * まずGoogleスプレッドシートを検索し、見つからない場合はフォールバックの関数(listMyTasks)を試します。
 * @param {string} taskId - 検索するタスクのID。
 * @returns {object|null} - 見つかったタスクオブジェクト。見つからない場合はnull。
 */
function getTaskById(taskId) {
  const normalizedId = _normalizeTaskId(taskId);
  if (!normalizedId) {
    return null;
  }

  const sh = _openSheet('T_Tasks');
  const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);
  const rows = sh.getDataRange().getValues();
  const located = _findTaskRowById(rows, header, normalizedId);

  let rawTaskData = null;

  if (located) {
    // タスクがGoogleスプレッドシートで見つかった場合
    const row = located.row;
    const assigneesArr =
      header['AssigneeEmails'] != null ? _csvToArray(row[header['AssigneeEmails']]) : [];
    const assigneeSingle = assigneesArr.length ? assigneesArr[0] : row[header['AssigneeEmail']];

    rawTaskData = {
      id: normalizedId,
      title: row[header['Title']],
      assignee: assigneeSingle,
      dueDate: row[header['DueDate']], // 日付オブジェクトをそのまま渡す
      status: row[header['Status']],
      priority: row[header['Priority']],
      createdBy: row[header['CreatedBy']],
      assignees: assigneesArr,
      repeatRule: header['RepeatRule'] != null ? row[header['RepeatRule']] || '' : '',
      updatedAt: header['UpdatedAt'] != null ? row[header['UpdatedAt']] : null, // 日付オブジェクトをそのまま渡す
    };
  } else {
    // スプレッドシートで見つからない場合、フォールバックを試す
    const fallback = listMyTasks();
    if (fallback && Array.isArray(fallback.tasks)) {
      const candidate = fallback.tasks.find(function (t) {
        return _normalizeTaskId(t.id) === normalizedId;
      });

      if (candidate) {
        // フォールバックでタスクが見つかった場合
        rawTaskData = candidate;
      }
    }
  }

  // いずれかの方法でタスクデータが見つかった場合、オブジェクトを構築して返す
  if (rawTaskData) {
    return _buildTaskObject(rawTaskData);
  }

  // どこにもタスクが見つからなかった場合
  return null;
}

function updateTask(taskObject) {
  try {
    const targetId = String(taskObject.id || '').trim();
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);
    const v = sh.getDataRange().getValues();
    const now = new Date();
    for (let i = 1; i < v.length; i++) {
      if (String(v[i][header['TaskID']] || '').trim() === targetId) {
        const rowValues = v[i].slice();
        if (taskObject.title != null) rowValues[header['Title']] = taskObject.title;
        if (taskObject.dueDate != null) rowValues[header['DueDate']] = taskObject.dueDate;
        if (taskObject.status != null) rowValues[header['Status']] = taskObject.status;
        if (taskObject.priority != null)
          rowValues[header['Priority']] = taskObject.priority || '中';

        if (Array.isArray(taskObject.assignees) && header['AssigneeEmails'] != null) {
          const csv = _arrayToCsv(taskObject.assignees);
          rowValues[header['AssigneeEmails']] = csv;
          rowValues[header['AssigneeEmail']] =
            taskObject.assignees[0] || rowValues[header['AssigneeEmail']];
        }
        if (taskObject.repeatRule != null && header['RepeatRule'] != null) {
          rowValues[header['RepeatRule']] = taskObject.repeatRule;
        }
        if (header['UpdatedAt'] != null) {
          rowValues[header['UpdatedAt']] = now;
        }

        _writeRow(sh, i + 1, rowValues);
        _audit('task', targetId, 'update', { payload: taskObject });
        _invalidateCacheGroup('TASK_TABLE');
        return { success: true, message: 'タスクを更新しました。' };
      }
    }
    const logId = _audit('task', targetId || '', 'update_not_found', { payload: taskObject });
    return { success: false, message: '更新対象のタスクが見つかりませんでした。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('task', targetId || '', 'update_fail', {
      error: String(e),
      payload: taskObject,
    });
    return { success: false, message: 'エラーが発生しました: ' + e.message, logId: logId };
  }
}

function completeTask(taskId) {
  try {
    const targetId = String(taskId || '').trim();
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);
    const v = sh.getDataRange().getValues();
    const now = new Date();
    for (let i = 1; i < v.length; i++) {
      if (String(v[i][header['TaskID']] || '').trim() === targetId) {
        const row = v[i];
        const rowValues = row.slice();
        rowValues[header['Status']] = '完了';
        if (header['UpdatedAt'] != null) rowValues[header['UpdatedAt']] = now;
        _writeRow(sh, i + 1, rowValues);

        const repeatSource = header['RepeatRule'] != null ? row[header['RepeatRule']] || '' : '';
        const repeat = String(repeatSource || '').toUpperCase();
        _audit('task', targetId, 'complete', { repeatRule: repeat });

        if (repeat === 'DAILY' || repeat === 'WEEKLY' || repeat === 'MONTHLY') {
          const baseDue = new Date(row[header['DueDate']]);
          let nextDue = new Date(baseDue);
          if (repeat === 'DAILY') {
            nextDue.setDate(baseDue.getDate() + 1);
          } else if (repeat === 'WEEKLY') {
            nextDue.setDate(baseDue.getDate() + 7);
          } else if (repeat === 'MONTHLY') {
            const d = new Date(baseDue.getFullYear(), baseDue.getMonth() + 1, 1);
            d.setDate(
              Math.min(baseDue.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())
            );
            nextDue = d;
          }
          const assigneesCsv =
            header['AssigneeEmails'] != null ? String(row[header['AssigneeEmails']] || '') : '';
          const newId = Utilities.getUuid();
          const now = new Date();
          const current = _getCurrentEmail();
          const newRow = [];
          newRow[header['TaskID']] = newId;
          newRow[header['Title']] = row[header['Title']];
          newRow[header['AssigneeEmail']] = assigneesCsv
            ? assigneesCsv.split(',')[0]
            : row[header['AssigneeEmail']];
          newRow[header['DueDate']] = nextDue;
          newRow[header['Status']] = '未着手';
          newRow[header['CreatedBy']] = current;
          newRow[header['CreatedAt']] = now;
          newRow[header['Priority']] = row[header['Priority']] || '中';
          if (header['AssigneeEmails'] != null) newRow[header['AssigneeEmails']] = assigneesCsv;
          if (header['RepeatRule'] != null) newRow[header['RepeatRule']] = repeat;
          if (header['UpdatedAt'] != null) newRow[header['UpdatedAt']] = '';
          const lastCol = sh.getLastColumn();
          for (let c = 0; c < lastCol; c++) {
            if (newRow[c] === undefined) newRow[c] = '';
          }
          sh.appendRow(newRow);
          _audit('task', newId, 'repeat_spawn', {
            parent: targetId,
            dueDate: nextDue,
            repeatRule: repeat,
          });
          _invalidateCacheGroup('TASK_TABLE');
          return { success: true, message: 'タスクを完了にしました。（次回を生成）' };
        }
        _invalidateCacheGroup('TASK_TABLE');
        return { success: true, message: 'タスクを完了にしました。' };
      }
    }
    const logId = _audit('task', targetId, 'complete_not_found', {});
    return { success: false, message: '対象のタスクが見つかりません。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('task', targetId || '', 'complete_fail', { error: String(e) });
    return { success: false, message: '完了処理エラー: ' + e.message, logId: logId };
  }
}

function deleteTaskById(taskId) {
  try {
    const targetId = String(taskId || '').trim();
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, [
      'TaskID',
      'Title',
      'AssigneeEmail',
      'DueDate',
      'Status',
      'CreatedBy',
      'CreatedAt',
      'Priority',
      'AssigneeEmails',
      'RepeatRule',
      'UpdatedAt',
    ]);
    const v = sh.getDataRange().getValues();
    const current = _getCurrentEmail();
    for (let i = v.length - 1; i >= 1; i--) {
      if (String(v[i][header['TaskID']] || '').trim() === targetId) {
        sh.deleteRow(i + 1);
        _audit('task', targetId, 'delete', {});
        _invalidateCacheGroup('TASK_TABLE');
        return { success: true, message: 'タスクを削除しました。' };
      }
    }
    const logId = _audit('task', targetId, 'delete_not_found', {});
    return { success: false, message: '該当のタスクが見つかりませんでした。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('task', targetId || '', 'delete_fail', { error: String(e) });
    return { success: false, message: 'エラーが発生しました: ' + e.message, logId: logId };
  }
}

function listMyTasks() {
  const rawEmail = _getCurrentEmail();
  const normalizedEmail = _normalizeEmail(rawEmail);
  const data = _loadTaskTable();
  const todayMs = _startOfToday();

  // ユーザーのメールアドレスに一致するタスクをフィルタリング
  const mine = data.tasks.filter(function (task) {
    if (normalizedEmail) {
      if (_emailArrayContains(task.assignees, rawEmail)) return true;
      if (_emailArrayContains(task.assignees, normalizedEmail)) return true;
      if (_normalizeEmail(task.assignee) === normalizedEmail) return true;
    }
    return false;
  });

  // タスクをソート
  mine.sort(function (a, b) {
    return _compareTasksForList(a, b, todayMs);
  });

  // デバッグ用のログ出力
  Logger.log(
    '[listMyTasks] totalTasks=' +
      data.tasks.length +
      ' matched=' +
      mine.length +
      ' rawEmail=' +
      rawEmail
  );

  // google.script.runはDateオブジェクトを正しくシリアライズできないことがあるため、
  // フロントエンドに返す前に、日付をISO 8601形式の文字列に変換します。
  const cleanTasks = mine.map(function (task) {
    const cleanTask = { ...task };

    // 日付を含む可能性のあるプロパティを確認し、Dateオブジェクトであれば文字列に変換します。
    if (cleanTask.deadline && typeof cleanTask.deadline.toISOString === 'function') {
      cleanTask.deadline = cleanTask.deadline.toISOString();
    }
    if (cleanTask.createdAt && typeof cleanTask.createdAt.toISOString === 'function') {
      cleanTask.createdAt = cleanTask.createdAt.toISOString();
    }
    if (cleanTask.updatedAt && typeof cleanTask.updatedAt.toISOString === 'function') {
      cleanTask.updatedAt = cleanTask.updatedAt.toISOString();
    }
    // ★★★ 今回特定された原因への修正 ★★★
    if (cleanTask.createdAtRaw && typeof cleanTask.createdAtRaw.toISOString === 'function') {
      cleanTask.createdAtRaw = cleanTask.createdAtRaw.toISOString();
    }

    return cleanTask;
  });

  // 最終的なデータをフロントエンドに返す
  return {
    tasks: cleanTasks,
    meta: {
      totalTasks: data.tasks.length,
      matchedTasks: mine.length,
      rawEmail: rawEmail,
      normalizedEmail: normalizedEmail,
      sampleTaskIds: mine.slice(0, 5).map(function (t) {
        return t.id;
      }),
      note:
        normalizedEmail && normalizedEmail.length
          ? ''
          : 'ログインユーザーのメールアドレスが取得できません。Webアプリの公開設定と組織ポリシーを確認してください。',
    },
  };
}

function listCreatedTasks(filter) {
  const rawEmail = _getCurrentEmail();
  const normalizedEmail = _normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return { tasks: [], meta: { statuses: [] } };
  }

  const data = _loadTaskTable();
  const todayMs = _startOfToday();
  const statusFilter = filter && filter.status ? _normalizeStatus(filter.status) : '';
  const sortMode = filter && filter.sort ? String(filter.sort) : 'due';

  const mine = data.tasks.filter(function (task) {
    return _normalizeEmail(task.createdBy) === normalizedEmail;
  });

  const statuses = new Set();
  mine.forEach(function (task) {
    if (task.status) statuses.add(task.status);
  });

  let filtered = mine.filter(function (task) {
    if (!statusFilter) return true;
    return _normalizeStatus(task.status) === statusFilter;
  });

  if (sortMode === 'created_desc') {
    filtered.sort(function (a, b) {
      const ca = a.createdAt != null ? a.createdAt : 0;
      const cb = b.createdAt != null ? b.createdAt : 0;
      if (cb !== ca) return cb - ca;
      return _compareTasksForList(a, b, todayMs);
    });
  } else if (sortMode === 'created_asc') {
    filtered.sort(function (a, b) {
      const ca = a.createdAt != null ? a.createdAt : Number.MAX_SAFE_INTEGER;
      const cb = b.createdAt != null ? b.createdAt : Number.MAX_SAFE_INTEGER;
      if (ca !== cb) return ca - cb;
      return _compareTasksForList(a, b, todayMs);
    });
  } else {
    filtered.sort(function (a, b) {
      return _compareTasksForList(a, b, todayMs);
    });
  }

  const cleanTasks = filtered.map(function (task) {
    const cleanTask = { ...task };
    if (cleanTask.dueDate && typeof cleanTask.dueDate.toISOString === 'function') {
      cleanTask.dueDate = cleanTask.dueDate.toISOString();
    }
    if (cleanTask.createdAt && typeof cleanTask.createdAt.toISOString === 'function') {
      cleanTask.createdAt = cleanTask.createdAt.toISOString();
    }
    if (cleanTask.updatedAt && typeof cleanTask.updatedAt.toISOString === 'function') {
      cleanTask.updatedAt = cleanTask.updatedAt.toISOString();
    }
    if (cleanTask.createdAtRaw && typeof cleanTask.createdAtRaw.toISOString === 'function') {
      cleanTask.createdAtRaw = cleanTask.createdAtRaw.toISOString();
    }
    return cleanTask;
  });

  return {
    tasks: cleanTasks,
    meta: {
      statuses: Array.from(statuses).sort(),
      sort: sortMode,
      currentEmail: rawEmail,
      totalTasks: data.tasks.length,
      createdCount: mine.length,
      filteredCount: filtered.length,
    },
  };
}

function _loadTaskTable() {
  return _getCachedValue(REQUEST_CACHE_KEYS.TASK_TABLE, null, 0, function () {
    const sh = _openSheet('T_Tasks');
    const header = _ensureColumns(sh, TASK_SHEET_COLUMNS);
    const rows = sh.getDataRange().getValues();
    const statuses = new Set();
    const tasks = [];
    for (let i = 1; i < rows.length; i++) {
      const record = _buildTaskRecord(rows[i], header);
      if (!record) continue;
      if (record.status) statuses.add(record.status);
      tasks.push(record);
    }
    return {
      tasks: tasks,
      statuses: Array.from(statuses).sort(),
    };
  });
}

function _findTaskRowById(rows, header, targetId) {
  const normalized = _normalizeTaskId(targetId);
  if (!normalized) return null;
  const looseTarget = normalized.replace(/\s+/g, '');
  for (let i = 1; i < rows.length; i++) {
    const rawId = rows[i][header['TaskID']];
    if (rawId == null) continue;
    const candidate = _normalizeTaskId(rawId);
    if (candidate === normalized) {
      return { index: i, row: rows[i], rawId: rawId };
    }
    if (looseTarget && candidate.replace(/\s+/g, '') === looseTarget) {
      return { index: i, row: rows[i], rawId: rawId };
    }
  }
  return null;
}

function _buildTaskRecord(row, header) {
  const id = String(row[header['TaskID']] || '').trim();
  if (!id) return null;

  const assigneesArr =
    header['AssigneeEmails'] != null ? _csvToArray(row[header['AssigneeEmails']]) : [];
  const primaryAssignee = assigneesArr.length ? assigneesArr[0] : row[header['AssigneeEmail']];

  const status = _normalizeStatus(row[header['Status']]);
  const dueDateString = _formatJST(row[header['DueDate']], 'yyyy-MM-dd');
  const dueValue = _coerceDateValue(row[header['DueDate']]);
  const createdAtValue = _coerceDateValue(row[header['CreatedAt']]);
  const updatedAtValue =
    header['UpdatedAt'] != null ? _coerceDateValue(row[header['UpdatedAt']]) : null;

  return {
    id: id,
    title: row[header['Title']] || '',
    assignee: primaryAssignee || '',
    assignees: assigneesArr,
    dueDate: dueDateString,
    dueValue: dueValue,
    status: status,
    priority: row[header['Priority']] || '中',
    createdBy: row[header['CreatedBy']] || '',
    createdAt: createdAtValue,
    createdAtRaw: row[header['CreatedAt']] || '',
    updatedAt: header['UpdatedAt'] != null ? row[header['UpdatedAt']] || '' : '',
    updatedAtValue: updatedAtValue,
    repeatRule: header['RepeatRule'] != null ? row[header['RepeatRule']] || '' : '',
    isCompleted: _isCompletedStatus(status),
  };
}

function _taskBucket(task, todayMs) {
  if (task.isCompleted) return 3;
  if (task.dueValue == null) return 2;
  if (task.dueValue < todayMs) return 0;
  return 1;
}

function _compareTasksForList(a, b, todayMs) {
  const bucketA = _taskBucket(a, todayMs);
  const bucketB = _taskBucket(b, todayMs);
  if (bucketA !== bucketB) return bucketA - bucketB;

  const dueA = a.dueValue != null ? a.dueValue : Number.MAX_SAFE_INTEGER;
  const dueB = b.dueValue != null ? b.dueValue : Number.MAX_SAFE_INTEGER;
  if (dueA !== dueB) return dueA - dueB;

  const priorityDiff = _priorityWeight(a.priority || '中') - _priorityWeight(b.priority || '中');
  if (priorityDiff !== 0) return priorityDiff;

  const createdA = a.createdAt != null ? -a.createdAt : 0;
  const createdB = b.createdAt != null ? -b.createdAt : 0;
  if (createdA !== createdB) return createdA - createdB;

  return String(a.id || '').localeCompare(String(b.id || ''));
}

function listAllTasks(filter) {
  const userInfo = getLoggedInUserInfo();
  const roleRaw = String((userInfo && userInfo.role) || '').trim();
  const normalizedRole = roleRaw.toLowerCase();
  const isManager = _isManagerRole(roleRaw);
  if (!isManager) {
    return {
      tasks: [],
      meta: {
        managerOnly: true,
        userRole: roleRaw,
        normalizedRole: normalizedRole,
        reason: '権限がありません。',
      },
    };
  }

  const data = _loadTaskTable();
  const todayMs = _startOfToday();
  const statusFilter = filter && filter.status ? _normalizeStatus(filter.status) : '';

  const filtered = data.tasks.filter(function (task) {
    if (!statusFilter) return true;
    return _normalizeStatus(task.status) === statusFilter;
  });

  filtered.sort(function (a, b) {
    return _compareTasksForList(a, b, todayMs);
  });

  const cleanTasks = filtered.map(function (task) {
    const cleanTask = { ...task };
    if (cleanTask.dueDate && typeof cleanTask.dueDate.toISOString === 'function') {
      cleanTask.dueDate = cleanTask.dueDate.toISOString();
    }
    if (cleanTask.createdAt && typeof cleanTask.createdAt.toISOString === 'function') {
      cleanTask.createdAt = cleanTask.createdAt.toISOString();
    }
    if (cleanTask.updatedAt && typeof cleanTask.updatedAt.toISOString === 'function') {
      cleanTask.updatedAt = cleanTask.updatedAt.toISOString();
    }
    if (cleanTask.createdAtRaw && typeof cleanTask.createdAtRaw.toISOString === 'function') {
      cleanTask.createdAtRaw = cleanTask.createdAtRaw.toISOString();
    }
    return cleanTask;
  });

  return {
    tasks: cleanTasks,
    meta: {
      statuses: data.statuses,
      totalTasks: data.tasks.length,
      filteredCount: filtered.length,
      isManager: true,
    },
  };
}

// ====== メッセージ ======
function getMessages(opt) {
  const email = _getCurrentEmail();
  const memoSh = _openSheet('T_Memos');
  const readSh = _openSheet('T_MemoReads');

  const requestedFolderRaw = opt && typeof opt.folderId !== 'undefined' ? opt.folderId : '';
  const requestedFolder = String(requestedFolderRaw || '').trim();
  const unreadOnlyFlag = !!(opt && opt.unreadOnly);

  _ensureColumns(memoSh, MEMO_SHEET_COLUMNS);
  _ensureColumns(readSh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);

  const memos = memoSh.getDataRange().getValues();
  const reads = readSh.getDataRange().getValues();

  const mHdr = _getHeaderMap(memoSh);
  const rHdr = _getHeaderMap(readSh);

  const myReadMemoIds = new Set();
  for (let i = 1; i < reads.length; i++) {
    if (reads[i][rHdr['UserEmail']] === email) myReadMemoIds.add(reads[i][rHdr['MemoID']]);
  }

  let list = [];
  for (let i = 1; i < memos.length; i++) {
    const id = memos[i][mHdr['MemoID']];
    const fullBody = String(memos[i][mHdr['Body']] || '');
    const preview = fullBody.length > 80 ? fullBody.substring(0, 78).trimEnd() + '...' : fullBody;
    const createdAtVal = memos[i][mHdr['CreatedAt']];
    const createdAtDate = createdAtVal ? new Date(createdAtVal) : null;
    const obj = {
      id: id,
      title: memos[i][mHdr['Title']],
      body: fullBody,
      preview: preview,
      priority: memos[i][mHdr['Priority']] || '中',
      folderId: memos[i][mHdr['FolderID']] || '',
      isRead: myReadMemoIds.has(id),
      createdAt: createdAtDate ? createdAtDate.getTime() : 0,
    };
    list.push(obj);
  }
  list.sort(function (a, b) {
    if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
    const ap = _priorityWeight(a.priority || '中');
    const bp = _priorityWeight(b.priority || '中');
    if (ap !== bp) return ap - bp;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });

  const initialCount = list.length;
  if (requestedFolder) {
    const before = list.length;
    const fid = requestedFolder.toLowerCase();
    list = list.filter(function (x) {
      const candidate = String(x.folderId || '')
        .trim()
        .toLowerCase();
      return candidate === fid;
    });
  }

  if (unreadOnlyFlag) {
    const beforeUnread = list.length;
    list = list.filter(function (x) {
      return !x.isRead;
    });
  }

  return list;
}

function getMessageById(memoId) {
  const memoSh = _openSheet('T_Memos');
  const commentSh = _openCommentSheet();
  const readSh = _openSheet('T_MemoReads');
  const userSh = _openSheet('M_Users');

  _ensureColumns(memoSh, [
    'MemoID',
    'CreatedAt',
    'CreatedBy',
    'Title',
    'Body',
    'Priority',
    'FolderID',
    'AttachmentIDs',
  ]);
  _ensureColumns(commentSh, [
    'CommentID',
    'MemoID',
    'CreatedAt',
    'AuthorEmail',
    'Body',
    'Mentions',
    'Author',
  ]);
  _ensureColumns(readSh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);
  _ensureColumns(userSh, USER_SHEET_COLUMNS);

  const memos = memoSh.getDataRange().getValues();
  const comments = commentSh.getDataRange().getValues();
  const reads = readSh.getDataRange().getValues();
  const users = userSh.getDataRange().getValues();

  const mHdr = _getHeaderMap(memoSh);
  const cHdr = _getHeaderMap(commentSh);
  const rHdr = _getHeaderMap(readSh);
  const uHdr = _getHeaderMap(userSh);

  const userDisplayMap = {};
  for (let i = 1; i < users.length; i++) {
    const email = users[i][uHdr['Email']];
    const normalizedEmail = _normalizeEmail(email);
    if (!normalizedEmail) continue;
    const displayName = String(users[i][uHdr['DisplayName']] || '').trim();
    if (displayName) {
      userDisplayMap[normalizedEmail] = displayName;
    } else if (!userDisplayMap[normalizedEmail] && email) {
      userDisplayMap[normalizedEmail] = String(email || '').trim();
    }
  }

  const current = _getCurrentEmail();

  let message = null;
  for (let i = 1; i < memos.length; i++) {
    if (memos[i][mHdr['MemoID']] === memoId) {
      const createdBy = memos[i][mHdr['CreatedBy']];
      const canDelete = createdBy === current || isManagerUser();
      const attachIds = _parseAttachmentIds(memos[i][mHdr['AttachmentIDs']]);
      message = {
        id: memos[i][mHdr['MemoID']],
        createdBy: createdBy,
        title: memos[i][mHdr['Title']],
        body: String(memos[i][mHdr['Body']] || '').replace(/\n/g, '\n'),
        priority: memos[i][mHdr['Priority']] || '中',
        comments: [],
        readUsers: [],
        unreadUsers: [],
        canDelete: canDelete,
        attachments: _getAttachmentMetas(attachIds),
      };
      break;
    }
  }
  if (!message) return null;

  for (let i = 1; i < comments.length; i++) {
    if (comments[i][cHdr['MemoID']] === memoId) {
      const rawAuthorDisplay = comments[i][cHdr['Author']];
      let authorEmail = comments[i][cHdr['AuthorEmail']] || '';
      if (!authorEmail && rawAuthorDisplay && String(rawAuthorDisplay).indexOf('@') !== -1) {
        authorEmail = rawAuthorDisplay;
      }
      const normalizedAuthor = _normalizeEmail(authorEmail);
      let displayName = '';
      if (normalizedAuthor && userDisplayMap[normalizedAuthor]) {
        displayName = userDisplayMap[normalizedAuthor];
      } else if (rawAuthorDisplay) {
        displayName = String(rawAuthorDisplay || '').trim();
      }
      const createdValue = comments[i][cHdr['CreatedAt']];
      let createdAtText = '';
      if (createdValue) {
        const createdAt =
          createdValue instanceof Date ? createdValue : new Date(createdValue);
        if (!isNaN(createdAt.getTime())) {
          createdAtText = createdAt.toLocaleString('ja-JP');
        }
      }
      message.comments.push({
        author: displayName || authorEmail || String(rawAuthorDisplay || ''),
        authorEmail: authorEmail || '',
        authorName: displayName || '',
        body: String(comments[i][cHdr['Body']] || '').replace(/\n/g, '<br>'),
        createdAt: createdAtText,
      });
    }
  }

  const readUserEmails = new Set();
  for (let i = 1; i < reads.length; i++) {
    if (reads[i][rHdr['MemoID']] === memoId) {
      const normalizedReadEmail = _normalizeEmail(reads[i][rHdr['UserEmail']]);
      if (normalizedReadEmail) readUserEmails.add(normalizedReadEmail);
    }
  }
  function buildUserLabel(email, displayName) {
    const normalized = _normalizeEmail(email);
    if (normalized && userDisplayMap[normalized]) return userDisplayMap[normalized];
    const trimmedName = String(displayName || '').trim();
    if (trimmedName) return trimmedName;
    if (email) return String(email || '').trim();
    return '';
  }
  for (let i = 1; i < users.length; i++) {
    const uemail = users[i][uHdr['Email']];
    const uname = users[i][uHdr['DisplayName']];
    const normalizedUserEmail = _normalizeEmail(uemail);
    const label = buildUserLabel(uemail, uname);
    if (!label) continue;
    if (normalizedUserEmail && readUserEmails.has(normalizedUserEmail)) message.readUsers.push(label);
    else message.unreadUsers.push(label);
  }
  return message;
}

function markMemoAsRead(memoId) {
  const email = _getCurrentEmail();
  const sh = _openSheet('T_MemoReads');
  _ensureColumns(sh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);
  const hdr = _getHeaderMap(sh);
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (v[i][hdr['MemoID']] === memoId && v[i][hdr['UserEmail']] === email) return;
  }
  sh.appendRow([Utilities.getUuid(), memoId, email, new Date()]);
  _audit('memo', memoId, 'mark_read', {});
}

function toggleMemoRead(memoId, shouldRead) {
  const email = _getCurrentEmail();
  const sh = _openSheet('T_MemoReads');
  _ensureColumns(sh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);
  const hdr = _getHeaderMap(sh);
  const v = sh.getDataRange().getValues();

  if (shouldRead) {
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['MemoID']] === memoId && v[i][hdr['UserEmail']] === email) return;
    }
    sh.appendRow([Utilities.getUuid(), memoId, email, new Date()]);
    _audit('memo', memoId, 'mark_read', {});
  } else {
    for (let i = v.length - 1; i >= 1; i--) {
      if (v[i][hdr['MemoID']] === memoId && v[i][hdr['UserEmail']] === email) {
        sh.deleteRow(i + 1);
      }
    }
    _audit('memo', memoId, 'mark_unread', {});
  }
}

function markMemosReadBulk(memoIds) {
  try {
    if (!Array.isArray(memoIds) || memoIds.length === 0)
      return { success: true, message: '対象なし' };
    const email = _getCurrentEmail();
    const sh = _openSheet('T_MemoReads');
    _ensureColumns(sh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);
    const hdr = _getHeaderMap(sh);
    const v = sh.getDataRange().getValues();

    const has = new Set();
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['UserEmail']] === email) has.add(v[i][hdr['MemoID']]);
    }

    const now = new Date();
    const rows = [];
    memoIds.forEach((id) => {
      if (!has.has(id)) {
        rows.push([Utilities.getUuid(), id, email, now]);
      }
    });

    if (rows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    }
    _audit('memo', '', 'bulk_mark_read', { count: rows.length, targetIds: memoIds });
    return { success: true, message: '未読 ' + rows.length + ' 件を既読にしました' };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('memo', '', 'bulk_mark_read_fail', {
      error: String(e),
      targetIds: memoIds,
    });
    return { success: false, message: '一括既読エラー: ' + e.message, logId: logId };
  }
}

// ====== コメント/メッセージ作成 ======
function addNewComment(commentData) {
  try {
    const sh = _openCommentSheet();
    const hdr = _ensureColumns(sh, [
      'CommentID',
      'MemoID',
      'CreatedAt',
      'AuthorEmail',
      'Body',
      'Mentions',
      'Author',
    ]);
    const id = Utilities.getUuid();
    const now = new Date();
    const email = _getCurrentEmail();
    const userInfo = getLoggedInUserInfo();
    const displayName = userInfo && userInfo.name ? userInfo.name : email;
    const mentionsValue = Array.isArray(commentData.mentions)
      ? commentData.mentions.join(',')
      : '';
    const rowWidth =
      Math.max.apply(
        null,
        Object.keys(hdr).map(function (key) {
          return hdr[key];
        })
      ) + 1;
    const row = new Array(rowWidth).fill('');
    row[hdr['CommentID']] = id;
    row[hdr['MemoID']] = commentData.memoId;
    row[hdr['CreatedAt']] = now;
    row[hdr['AuthorEmail']] = email;
    row[hdr['Body']] = commentData.body;
    if (hdr['Mentions'] != null) row[hdr['Mentions']] = mentionsValue;
    if (hdr['Author'] != null) row[hdr['Author']] = displayName;
    sh.appendRow(row);
    _audit('memo', commentData.memoId, 'comment', { commentId: id });
    return { success: true, message: 'コメントを投稿しました。' };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('memo', commentData.memoId || '', 'comment_fail', { error: String(e) });
    return { success: false, message: 'コメントの投稿に失敗しました: ' + e.message, logId: logId };
  }
}

function addNewMessage(messageData) {
  try {
    const sh = _openSheet('T_Memos');
    _ensureColumns(sh, MEMO_SHEET_COLUMNS);
    const id = Utilities.getUuid();
    const now = new Date();
    const email = _getCurrentEmail();
    const row = [];
    const hdr = _getHeaderMap(sh);
    row[hdr['MemoID']] = id;
    row[hdr['CreatedAt']] = now;
    row[hdr['CreatedBy']] = email;
    row[hdr['Title']] = messageData.title;
    row[hdr['Body']] = messageData.body;
    row[hdr['Priority']] = messageData.priority || '中';
    row[hdr['FolderID']] = messageData.folderId || '全体';
    let attachmentIds = [];
    if (Array.isArray(messageData.attachments) && messageData.attachments.length) {
      attachmentIds = messageData.attachments.map(function (att) {
        const stored = _storeMessageAttachment(att, email);
        if (!stored || !stored.fileId) return '';
        return stored.fileId;
      });
      attachmentIds = attachmentIds.filter(Boolean);
    } else if (Array.isArray(messageData.attachmentIds)) {
      attachmentIds = messageData.attachmentIds;
    }
    if (hdr['Attachments'] != null) {
      const attachmentNames = (messageData.attachments || [])
        .map(function (att) {
          return att && att.name ? att.name : '';
        })
        .filter(Boolean);
      row[hdr['Attachments']] = _arrayToCsv(attachmentNames);
    }
    if (hdr['UpdatedAt'] != null) row[hdr['UpdatedAt']] = now;
    if (hdr['AttachmentIDs'] != null) row[hdr['AttachmentIDs']] = _arrayToCsv(attachmentIds);

    const lastCol = sh.getLastColumn();
    for (let c = 0; c < lastCol; c++) {
      if (row[c] === undefined) row[c] = '';
    }
    sh.appendRow(row);
    _audit('memo', id, 'create', {
      title: messageData.title,
      priority: messageData.priority,
      folderId: messageData.folderId,
    });
    return { success: true, message: 'メッセージを投稿しました。' };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('memo', '', 'create_fail', { error: String(e), payload: messageData });
    return {
      success: false,
      message: 'メッセージの投稿に失敗しました: ' + e.message,
      logId: logId,
    };
  }
}

// ====== メッセージ削除（作成者 or admin のみ） ======
function deleteMessageById(memoId) {
  try {
    const sh = _openSheet('T_Memos');
    _ensureColumns(sh, MEMO_SHEET_COLUMNS);
    const hdr = _getHeaderMap(sh);
    const v = sh.getDataRange().getValues();
    const current = _getCurrentEmail();
    for (let i = v.length - 1; i >= 1; i--) {
      if (v[i][hdr['MemoID']] === memoId) {
        const createdBy = v[i][hdr['CreatedBy']];
        if (!(createdBy === current || isManagerUser())) {
          return { success: false, message: '削除権限がありません。' };
        }
        sh.deleteRow(i + 1);
        _audit('memo', memoId, 'delete', {});
        return { success: true, message: 'メッセージを削除しました。' };
      }
    }
    const logId = _audit('memo', memoId, 'delete_not_found', {});
    return { success: false, message: '対象のメッセージが見つかりません。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('memo', memoId || '', 'delete_fail', { error: String(e) });
    return { success: false, message: '削除時エラー: ' + e.message, logId: logId };
  }
}

// ====== 設定 ======
function getUserSettings() {
  return getLoggedInUserInfo();
}

/** プロフィール/テーマ保存（Theme列が無ければ追加） */
function saveUserSettings(payload) {
  try {
    const email = _getCurrentEmail();
    const normalizedEmail = _normalizeEmail(email);
    const sh = _openSheet('M_Users');
    const hdr = _ensureColumns(sh, USER_SHEET_COLUMNS);
    const v = sh.getDataRange().getValues();
    let resultMeta = null;
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['Email']] === email) {
        let rowChanged = false;
        const rowValues = v[i].slice();
        if (payload.name != null) {
          rowValues[hdr['DisplayName']] = payload.name;
          rowChanged = true;
        }
        if (payload.imageData) {
          const stored = _storeProfileImage(payload.imageData, email);
          rowValues[hdr['ProfileImage']] = stored.url;
          resultMeta = { imageUrl: stored.url, imageName: stored.name };
          rowChanged = true;
        } else if (payload.imageUrl != null) {
          // 後方互換: URLが直接渡された場合はそのまま保存
          const value = payload.imageUrl || PROFILE_PLACEHOLDER_URL;
          rowValues[hdr['ProfileImage']] = value;
          resultMeta = _resolveProfileImageInfo(value, email);
          rowChanged = true;
        }
        if (payload.theme != null) {
          rowValues[hdr['Theme']] = payload.theme;
          rowChanged = true;
        }
        if (rowChanged) {
          _writeRow(sh, i + 1, rowValues);
        }
        _invalidateUserInfoCache(email);
        _invalidateCacheGroup('ACTIVE_USERS');
        const response = { success: true, message: '設定を保存しました。' };
        if (resultMeta) {
          response.imageUrl = resultMeta.imageUrl;
          response.imageName = resultMeta.imageName;
        }
        return response;
      }
    }
    const logId = _audit('user', email, 'settings_user_not_found', {});
    return { success: false, message: 'ユーザーが見つかりません。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('user', _getCurrentEmail(), 'settings_save_fail', {
      error: String(e),
      payload: payload,
    });
    return { success: false, message: '保存エラー: ' + e.message, logId: logId };
  }
}

// ====== ユーザーRole更新（adminのみ） ======
function updateUserRole(arg) {
  try {
    if (!isManagerUser()) return { success: false, message: '権限がありません。' };
    const nextRole = _normalizeRole(arg && arg.role ? arg.role : '');
    if (!nextRole || ['admin', 'manager', 'member', 'guest'].indexOf(nextRole) === -1) {
      return { success: false, message: '無効なロールです。' };
    }
    const sh = _openSheet('M_Users');
    const hdr = _ensureColumns(sh, USER_SHEET_COLUMNS);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['Email']] === arg.email) {
        const rowValues = v[i].slice();
        rowValues[hdr['Role']] = nextRole;
        _writeRow(sh, i + 1, rowValues);
        _invalidateUserInfoCache(arg.email);
        _invalidateCacheGroup('ACTIVE_USERS');
        _audit('admin', arg.email, 'role_update', { to: nextRole });
        return { success: true, message: 'Roleを更新しました。' };
      }
    }
    const logId = _audit('admin', arg.email || '', 'role_update_not_found', {});
    return { success: false, message: '対象ユーザーが見つかりません。', logId: logId };
  } catch (e) {
    Logger.log(e);
    const logId = _audit('admin', arg && arg.email ? arg.email : '', 'role_update_fail', {
      error: String(e),
      payload: arg,
    });
    return { success: false, message: '更新エラー: ' + e.message, logId: logId };
  }
}

// ====== キャッシュクリア ======
function clearCache() {
  const email = _getCurrentEmail();
  _invalidateUserInfoCache(email);
}

// ====== 管理者向け：監査ログ簡易取得 ======
function getAuditLogs(limit, filter) {
  if (!isManagerUser()) return [];
  const sh = _ensureAuditSheet();
  const hdr = _getHeaderMap(sh);
  const v = sh.getDataRange().getValues();
  const rows = [];
  for (let i = v.length - 1; i >= 1; i--) {
    const r = v[i];
    const rec = {
      id: r[hdr['AuditID']],
      type: r[hdr['Type']],
      targetId: r[hdr['TargetID']],
      action: r[hdr['Action']],
      userEmail: r[hdr['UserEmail']],
      at: r[hdr['At']],
      meta: r[hdr['Meta']],
    };
    if (filter) {
      if (filter.type && rec.type !== filter.type) continue;
      if (filter.action && rec.action !== filter.action) continue;
    }
    rows.push(rec);
    if (limit && rows.length >= limit) break;
  }
  return rows;
}
/*
// ===== デバッグ支援用（必要時にコメントアウトを解除） =====
function test_ListActiveUsers() {
  try {
    const activeUsers = listActiveUsers();
    Logger.log('--- テスト実行結果 ---');
    Logger.log('取得したアクティブユーザーの数: ' + activeUsers.length + ' 件');
    Logger.log('取得したデータの中身:');
    Logger.log(JSON.stringify(activeUsers, null, 2));
  } catch (e) {
    Logger.log('テスト中にエラーが発生しました: ' + e.toString());
  }
}

function testOpenSheet() {
  try {
    const sheetName = 'M_Users';
    Logger.log('テスト開始: ' + sheetName + 'シートを開きます...');
    const sh = _openSheet(sheetName);
    if (sh) {
      Logger.log('成功！シートを取得できました。シート名: ' + sh.getName());
      Logger.log('A1セルの値: ' + sh.getRange('A1').getValue());
    } else {
      Logger.log('失敗。シートオブジェクトがnullです。');
    }
  } catch (e) {
    Logger.log('テスト中にエラーが発生しました！');
    Logger.log('エラーメッセージ: ' + e.message);
    Logger.log('スタックトレース: ' + e.stack);
  }
}
// function myFunction() {}
*/

function jsonResponse(payload, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  if (statusCode && output.setHeader) {
    // TextOutput ではヘッダー指定ができないため、Cloudflare Functions 側でCORSを付与する
  }
  return output;
}

const API_METHODS = {
  getAuthStatus,
  getBootstrapData,
  getHomeContent,
  listMyTasks,
  listCreatedTasks,
  listAllTasks,
  getMessages,
  toggleMemoRead,
  markMemosReadBulk,
  getTaskById,
  updateTask,
  completeTask,
  deleteTaskById,
  markMemoAsRead,
  getMessageById,
  addNewComment,
  deleteMessageById,
  addNewTask,
  addNewMessage,
  getUserSettings,
  saveUserSettings,
};

function doPost(e) {
  try {
    const headers = (e && e.headers) || {};
    const requestId = headers ? headers['X-ShiftFlow-Request-Id'] || headers['x-shiftflow-request-id'] || 'UNKNOWN' : 'UNKNOWN';
    const payload =
      e && e.postData && typeof e.postData.contents === 'string' && e.postData.contents.length
        ? e.postData.contents
        : 'NONE';
    Logger.log('[doPost START] RequestID=%s Payload=%s', requestId, payload);
  } catch (logErr) {
    Logger.log('[doPost LOGGING ERROR] ' + logErr);
  }
  _clearRequestCache();
  let body = {};
  if (e && e.postData && e.postData.contents) {
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          error: 'Invalid JSON payload',
          detail: String(err && err.message ? err.message : err),
        },
        400
      );
    }
  }
  const routeParam =
    (body && body.route) ||
    (body && body.method) ||
    (e && e.parameter && e.parameter.route) ||
    (e && e.parameter && e.parameter.method) ||
    '';
  const route = String(routeParam || '').trim();
  if (!route) {
    return jsonResponse(
      {
        ok: false,
        error: 'Missing route parameter',
      },
      400
    );
  }

  if (route === 'logAuthProxyEvent') {
    try {
      const headers = (e && e.headers) || {};
      const secret = _getHeaderValue(headers, 'X-ShiftFlow-Secret');
      if (!_verifySharedSecret(secret)) {
        throw _createHttpError(403, 'Shared secret mismatch.', 'shared_secret_mismatch');
      }
      const payload =
        Array.isArray(body && body.args) && body.args.length
          ? body.args[0]
          : body && body.payload
          ? body.payload
          : {};
      const normalized = payload && typeof payload === 'object' ? payload : {};
      let metaValue = normalized.meta || normalized.Meta || {};
      if (typeof metaValue === 'string') {
        try {
          metaValue = JSON.parse(metaValue);
        } catch (_ignore) {
          metaValue = { raw: metaValue };
        }
      }
      const logEntry = {
        id: normalized.id || normalized.logId || '',
        level: normalized.level || normalized.Level || '',
        event: normalized.event || normalized.Event || '',
        message: normalized.message || normalized.Message || '',
        requestId:
          normalized.requestId ||
          normalized.RequestID ||
          _getHeaderValue(headers, 'X-ShiftFlow-Request-Id') ||
          '',
        route: normalized.route || normalized.Route || '',
        email: normalized.email || normalized.Email || '',
        status: normalized.status || normalized.Status || '',
        meta: metaValue,
        source: normalized.source || 'cloudflare',
        clientIp: normalized.clientIp || normalized.ClientIp || '',
        userAgent: normalized.userAgent || normalized.UserAgent || '',
        cfRay: normalized.cfRay || normalized.CfRay || '',
      };
      const logId = _appendProxyLog(logEntry, headers);
      return jsonResponse(
        {
          ok: true,
          result: {
            logId: logId || '',
          },
        },
        200
      );
    } catch (err) {
      Logger.log(err);
      return _respondWithError(err, route);
    } finally {
      __CURRENT_REQUEST_EMAIL = '';
      __CURRENT_REQUEST_NAME = '';
      __CURRENT_ACCESS_CONTEXT = null;
      _clearRequestCache();
    }
  }

  if (route === 'resolveAccessContext') {
    try {
      const ctx = _buildRequestContext(e, route, body);
      const access = _resolveAccessContextInternal(ctx, {
        logAttempt: true,
        updateLastLogin: false,
      });
      _audit(
        'api',
        route,
        access.allowed ? 'allow' : 'deny',
        {
          requestId: ctx.requestId,
          role: access.role,
          status: access.status,
          email: ctx.email,
          sub: ctx.sub,
        }
      );
      return jsonResponse({
        ok: true,
        result: access,
      });
    } catch (err) {
      Logger.log(err);
      return _respondWithError(err, route);
    } finally {
      __CURRENT_REQUEST_EMAIL = '';
      __CURRENT_REQUEST_NAME = '';
      __CURRENT_ACCESS_CONTEXT = null;
      _clearRequestCache();
    }
  }

  const handler = Object.prototype.hasOwnProperty.call(API_METHODS, route)
    ? API_METHODS[route]
    : null;
  if (typeof handler !== 'function') {
    return jsonResponse(
      {
        ok: false,
        error: 'Unknown route: ' + route,
      },
      404
    );
  }

  let ctx;
  try {
    ctx = _buildRequestContext(e, route, body);
  } catch (err) {
    Logger.log(err);
    return _respondWithError(err, route);
  }

  const args = ctx.args;
  let access = null;
  try {
    access = _authorizeRouteAccess(route, ctx);
    __CURRENT_ACCESS_CONTEXT = access;
    const result = handler.apply(null, args);
    _audit('api', route, 'allow', {
      requestId: ctx.requestId,
      role: access.role,
      status: access.status,
      email: ctx.email,
      sub: ctx.sub,
    });
    return jsonResponse({
      ok: true,
      result: result === undefined ? null : result,
    });
  } catch (err) {
    const action = err && err.httpStatus === 403 ? 'deny' : 'error';
    const meta = {
      requestId: ctx.requestId,
      route: route,
      email: ctx.email,
      sub: ctx.sub,
    };
    if (access && access.role) meta.role = access.role;
    if (access && access.status) meta.status = access.status;
    _audit('api', route, action, meta);
    Logger.log(err);
    return _respondWithError(err, route);
  } finally {
    __CURRENT_REQUEST_EMAIL = '';
    __CURRENT_REQUEST_NAME = '';
    __CURRENT_ACCESS_CONTEXT = null;
    _clearRequestCache();
  }
}

function doOptions() {
  return ContentService.createTextOutput('');
}
