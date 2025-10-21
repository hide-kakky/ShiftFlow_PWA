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

/** Spreadsheetインスタンスのキャッシュ */
let _cachedSpreadsheet = null;
/** シートインスタンスのキャッシュ */
const _sheetCache = {};

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

function _isManagerRole(role) {
  const normalized = String(role || '')
    .trim()
    .toLowerCase();
  return (
    normalized === '管理職' ||
    normalized === '管理者' ||
    normalized === 'admin' ||
    normalized === 'administrator' ||
    normalized === 'manager'
  );
}

function _isAdminRole(role) {
  return (
    String(role || '')
      .trim()
      .toLowerCase() === 'admin'
  );
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
 * 【修正】M_Usersにユーザーを保証し、レコード情報を返す（初回は自動仮登録方針）
 * 組み込み認証では名前やプロフィール画像は直接取得できないため、
 * emailのみを使って初回登録を行います。
 */
function _ensureUserRecord_() {
  const rawEmail = _getCurrentEmail();
  const email = String(rawEmail || '').trim();
  const normalizedEmail = _normalizeEmail(email);
  if (!normalizedEmail) return; // 何らかの理由でemailが取れない場合は中断

  const sh = _openSheet('M_Users');
  const hdr = _ensureColumns(sh, USER_SHEET_COLUMNS);
  const v = sh.getDataRange().getValues();

  // ユーザーが既に登録されているかチェック
  for (let i = 1; i < v.length; i++) {
    if (_normalizeEmail(v[i][hdr['Email']]) === normalizedEmail) {
      return; // 登録済みなので処理を終了
    }
  }

  // 未登録なら自動仮登録
  const id = Utilities.getUuid();
  const newRow = [];
  newRow[hdr['UserID']] = id;
  newRow[hdr['Email']] = email;
  newRow[hdr['DisplayName']] = email; // 初期表示名はメールアドレス
  newRow[hdr['ProfileImage']] = PROFILE_PLACEHOLDER_URL;
  newRow[hdr['Role']] = 'member';
  newRow[hdr['IsActive']] = 'TRUE';
  newRow[hdr['Theme']] = 'light';

  const lastCol = sh.getLastColumn();
  for (let c = 0; c < lastCol; c++) {
    if (newRow[c] === undefined) newRow[c] = '';
  }
  sh.appendRow(newRow);
  _audit('user', email, 'auto_register', {});
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
      role: '一般',
      email: email,
      theme: 'light',
    };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'user_info_' + normalizedEmail;
  const cached = cache.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const userSheet = _openSheet('M_Users');
  const header = _ensureColumns(userSheet, USER_SHEET_COLUMNS);
  const THEME_COL = header['Theme'];
  const data = userSheet.getDataRange().getValues();
  let info = {
    name: 'ゲスト',
    imageUrl: PROFILE_PLACEHOLDER_URL,
    imageName: '',
    role: '一般',
    email: email,
    theme: 'light',
  };

  for (let i = 1; i < data.length; i++) {
    if (_normalizeEmail(data[i][header['Email']]) === normalizedEmail) {
      const profileMeta = _resolveProfileImageInfo(data[i][header['ProfileImage']], email);
      info = {
        name: data[i][header['DisplayName']] || 'ユーザー',
        imageUrl: profileMeta.imageUrl,
        imageName: profileMeta.imageName,
        role: data[i][header['Role']] || '一般',
        email: email,
        theme: THEME_COL != null && THEME_COL >= 0 ? data[i][THEME_COL] || 'light' : 'light',
      };
      break;
    }
  }
  try {
    const payload = JSON.stringify(info);
    if (payload.length <= 90 * 1024) {
      cache.put(cacheKey, payload, 3600);
    } else {
      // Skip caching when payload is too large
    }
  } catch (e) {
    // Cache write failures are non-fatal
  }
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

function isManagerUser() {
  const u = getLoggedInUserInfo();
  return _isManagerRole(u.role);
}

function listActiveUsers() {
  const sh = _openSheet('M_Users');
  const header = _ensureColumns(sh, USER_SHEET_COLUMNS);
  const values = sh.getDataRange().getValues();
  const res = [];

  for (let i = 1; i < values.length; i++) {
    const isActiveValue = values[i][header['IsActive']];
    const isActive =
      String(isActiveValue || '')
        .trim()
        .toUpperCase() === 'TRUE';

    if (isActive) {
      res.push({
        email: values[i][header['Email']],
        name: values[i][header['DisplayName']],
        role: values[i][header['Role']] || '一般',
      });
    }
  }
  return res;
}
function listActiveFolders() {
  const sh = _openSheet('M_Folders');
  const hdr = _getHeaderMap(sh);
  const v = sh.getDataRange().getValues();
  const res = [];
  for (let i = 1; i < v.length; i++) {
    if (String(v[i][hdr['IsArchived']]) !== 'TRUE') {
      const rawId = String(v[i][hdr['FolderID']] || '').trim();
      const rawName = String(v[i][hdr['FolderName']] || '').trim();
      const effectiveId = rawId || rawName;
      if (!effectiveId) continue;
      res.push({ id: effectiveId, name: rawName || effectiveId });
    }
  }
  if (res.length === 0) {
    res.push(
      { id: '全体', name: '全体' },
      { id: 'ブッフェ', name: 'ブッフェ' },
      { id: 'レセプション', name: 'レセプション' },
      { id: 'ホール', name: 'ホール' }
    );
  }
  return res;
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

  _ensureUserRecord_(); // ★ ここで初回ログインユーザーを自動登録

  const tpl = HtmlService.createTemplateFromFile('index');
  const userInfo = getLoggedInUserInfo();
  const activeUsers = listActiveUsers();
  const isManager = _isManagerRole(userInfo.role);
  const isAdmin = _isAdminRole(userInfo.role);
  const filteredUsers = activeUsers.filter(function (user) {
    if (isAdmin) return true;
    if (isManager) return _normalizeEmail(user.email) !== _normalizeEmail(HIDDEN_TEST_ACCOUNT);
    const normalizedCurrent = _normalizeEmail(userInfo.email);
    return (
      _normalizeEmail(user.email) === normalizedCurrent ||
      _normalizeEmail(user.email) !== _normalizeEmail(HIDDEN_TEST_ACCOUNT)
    );
  });

  tpl.userInfo = userInfo;
  tpl.isManager = isManager;
  tpl.users = filteredUsers;
  tpl.folders = listActiveFolders();
  tpl.initialTasks = listMyTasks();

  const out = tpl
    .evaluate()
    .setTitle('ShiftFlow')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');

  return out;
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
          return { success: true, message: 'タスクを完了にしました。（次回を生成）' };
        }
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
        reason: '管理者権限が必要です。',
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
        CacheService.getScriptCache().remove('user_info_' + normalizedEmail);
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
    if (!isManagerUser())
      return { success: false, message: '権限がありません（adminまたは管理職のみ）。' };
    const sh = _openSheet('M_Users');
    const hdr = _ensureColumns(sh, USER_SHEET_COLUMNS);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['Email']] === arg.email) {
        const rowValues = v[i].slice();
        rowValues[hdr['Role']] = arg.role || '一般';
        _writeRow(sh, i + 1, rowValues);
        CacheService.getScriptCache().remove('user_info_' + arg.email);
        _audit('admin', arg.email, 'role_update', { to: arg.role || '一般' });
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
  CacheService.getScriptCache().remove('user_info_' + email);
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

function doPost(e) {
  let body = {};
  if (e && e.postData && e.postData.contents) {
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return jsonResponse({
        ok: false,
        error: 'Invalid JSON payload',
      }, 400);
    }
  }
  return jsonResponse({
    ok: true,
    received: body,
  });
}

// TODO: CORS設定を本番オリジンで固定する
