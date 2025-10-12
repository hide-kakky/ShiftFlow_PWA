// ====== 基本設定 ======
const SPREADSHEET_ID = '1bL7cdFqtFd7eKAj0ZOUrmQ2kbPtGvDt6EMXt6fi5i_M';

// ====== 認証設定（削除） ======
// GCPクライアントIDは不要になったため削除します。
// const OAUTH_CLIENT_ID = '...';

// ====== 共通ユーティリティ ======
function _openSheet(name) {
  Logger.log('openSheet: ' + name);
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
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

function _normalizeStatus(status) {
  return String(status || '').trim();
}

function _isCompletedStatus(status) {
  return _normalizeStatus(status) === '完了';
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
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName('T_Audit') || ss.insertSheet('T_Audit');
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
  const values = sh.getDataRange().getValues();
  if (values.length === 0) {
    throw new Error('ヘッダー行が存在しません: ' + sh.getName());
  }
  const header = values[0];
  const map = {};
  for (let i = 0; i < header.length; i++) {
    const key = String(header[i] || '').trim();
    if (key) map[key] = i;
  }
  return map;
}

/** ヘッダーの存在を保証（なければ末尾に追加）し、最新のヘッダーマップを返す */
function _ensureColumns(sh, colNames) {
  let values = sh.getDataRange().getValues();
  if (values.length === 0) {
    sh.appendRow(colNames);
    return _getHeaderMap(sh);
  }
  let header = values[0];
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
  return _getHeaderMap(sh);
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
  const hdr = _ensureColumns(sh, [
    'UserID',
    'Email',
    'DisplayName',
    'ProfileImage',
    'Role',
    'IsActive',
    'Theme',
  ]);
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
  newRow[hdr['ProfileImage']] = 'https://placehold.jp/150x150.png';
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
function getLoggedInUserInfo() {
  const rawEmail = _getCurrentEmail();
  const email = String(rawEmail || '').trim();
  const normalizedEmail = _normalizeEmail(email);
  if (!normalizedEmail) {
    return {
      name: 'ゲスト',
      imageUrl: 'https://placehold.jp/150x150.png',
      role: '一般',
      email: email,
      theme: 'light',
    };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'user_info_' + normalizedEmail;
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const userSheet = _openSheet('M_Users');
  const header = _getHeaderMap(userSheet);
  const THEME_COL = header['Theme'];
  const data = userSheet.getDataRange().getValues();
  let info = {
    name: 'ゲスト',
    imageUrl: 'https://placehold.jp/150x150.png',
    role: '一般',
    email: email,
    theme: 'light',
  };

  for (let i = 1; i < data.length; i++) {
    if (_normalizeEmail(data[i][header['Email']]) === normalizedEmail) {
      let imageUrl = data[i][header['ProfileImage']] || 'https://placehold.jp/150x150.png';
      if (String(imageUrl).indexOf('drive.google.com') >= 0) {
        try {
          let fileId = '';
          if (imageUrl.indexOf('/d/') >= 0) {
            fileId = imageUrl.split('/d/')[1].split('/')[0];
          } else if (imageUrl.indexOf('id=') >= 0) {
            fileId = imageUrl.split('id=')[1].split('&')[0];
          }
          if (fileId) {
            const file = DriveApp.getFileById(fileId);
            const blob = file.getBlob();
            const base64Data = Utilities.encodeBase64WebSafe(blob.getBytes());
            const ct = blob.getContentType();
            imageUrl = 'data:' + ct + ';base64,' + base64Data;
          }
        } catch (e) {
          Logger.log('画像のBase64変換失敗: ' + e);
          imageUrl = 'https://placehold.jp/150x150.png';
        }
      }
      info = {
        name: data[i][header['DisplayName']] || 'ユーザー',
        imageUrl: imageUrl,
        role: data[i][header['Role']] || '一般',
        email: email,
        theme: THEME_COL != null && THEME_COL >= 0 ? data[i][THEME_COL] || 'light' : 'light',
      };
      break;
    }
  }
  cache.put(cacheKey, JSON.stringify(info), 3600);
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
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    status.hasSpreadsheetAccess = true;
    const userSheet = ss.getSheetByName('M_Users');
    if (userSheet && normalized) {
      const header = _getHeaderMap(userSheet);
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
  const header = _getHeaderMap(sh);
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
      res.push({ id: v[i][hdr['FolderID']], name: v[i][hdr['FolderName']] });
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

// ====== doGet ======
/**
 * 【修正】doGetが呼ばれた時点で、ユーザーがM_Usersに存在するか確認・自動登録します。
 */
function doGet(e) {
  _ensureUserRecord_(); // ★ ここで初回ログインユーザーを自動登録

  const tpl = HtmlService.createTemplateFromFile('index');
  tpl.userInfo = getLoggedInUserInfo();
  tpl.isManager = isManagerUser();
  tpl.users = listActiveUsers();
  tpl.folders = listActiveFolders();
  const out = tpl
    .evaluate()
    .setTitle('ShiftFlow')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return out;
}

// ====== ホーム（今日のタスク/メッセージ） ======
function getHomeContent() {
  const rawEmail = _getCurrentEmail();
  const normalizedEmail = _normalizeEmail(rawEmail);
  const todayMs = _startOfToday();
  const data = _loadTaskTable();
  const myTasks = data.tasks
    .filter(function (task) {
      if (!normalizedEmail) return false;
      if (_emailArrayContains(task.assignees, rawEmail)) return true;
      if (_emailArrayContains(task.assignees, normalizedEmail)) return true;
      if (_normalizeEmail(task.assignee) === normalizedEmail) return true;
      return false;
    })
    .filter(function (task) {
      return !task.isCompleted;
    })
    .sort(function (a, b) {
      return _compareTasksForList(a, b, todayMs);
    })
    .slice(0, 5)
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

  return { tasks: myTasks, messages: messages };
}

// ====== タスク CRUD/一覧 ======
function addNewTask(taskObject) {
  try {
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
      'RRULE',
      'ParentTaskID',
      'Attachments',
      'UpdatedAt',
      'RepeatRule',
      'AttachmentIDs',
    ]);

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

function getTaskById(taskId) {
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
    'UpdatedAt',
    'RepeatRule',
  ]);
  const v = sh.getDataRange().getValues();
  const current = _getCurrentEmail();
  const normalizedCurrent = _normalizeEmail(current);

  for (let i = 1; i < v.length; i++) {
    const row = v[i];
    const taskId = String(row[header['TaskID']] || '').trim();
    if (String(row[header['TaskID']] || '').trim() === targetId) {
      const createdBy = row[header['CreatedBy']];
      const canDelete = _normalizeEmail(createdBy) === normalizedCurrent || isManagerUser();
      const assigneesArr =
        header['AssigneeEmails'] != null ? _csvToArray(row[header['AssigneeEmails']]) : [];
      const assigneeSingle = assigneesArr.length ? assigneesArr[0] : row[header['AssigneeEmail']];
      const repeatRuleValue = header['RepeatRule'] != null ? row[header['RepeatRule']] || '' : '';
      return {
        id: targetId,
        title: row[header['Title']],
        assignee: assigneeSingle,
        dueDate: _formatJST(row[header['DueDate']], 'yyyy-MM-dd'),
        status: _normalizeStatus(row[header['Status']]),
        priority: row[header['Priority']] || '中',
        createdBy: createdBy,
        canDelete: canDelete,
        assignees: assigneesArr,
        attachments: [],
        repeatRule: repeatRuleValue,
        updatedAt: header['UpdatedAt'] != null ? row[header['UpdatedAt']] || '' : '',
      };
    }
  }
  return null;
}

function updateTask(taskObject) {
  try {
    const targetId = String(taskObject.id || '').trim();
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
      'UpdatedAt',
      'RepeatRule',
    ]);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (String(v[i][header['TaskID']] || '').trim() === targetId) {
        if (taskObject.title != null)
          sh.getRange(i + 1, header['Title'] + 1).setValue(taskObject.title);
        if (taskObject.dueDate != null)
          sh.getRange(i + 1, header['DueDate'] + 1).setValue(taskObject.dueDate);
        if (taskObject.status != null)
          sh.getRange(i + 1, header['Status'] + 1).setValue(taskObject.status);
        if (taskObject.priority != null)
          sh.getRange(i + 1, header['Priority'] + 1).setValue(taskObject.priority || '中');

        if (Array.isArray(taskObject.assignees) && header['AssigneeEmails'] != null) {
          const csv = _arrayToCsv(taskObject.assignees);
          sh.getRange(i + 1, header['AssigneeEmails'] + 1).setValue(csv);
          sh.getRange(i + 1, header['AssigneeEmail'] + 1).setValue(
            taskObject.assignees[0] || v[i][header['AssigneeEmail']]
          );
        }
        if (taskObject.repeatRule != null && header['RepeatRule'] != null) {
          sh.getRange(i + 1, header['RepeatRule'] + 1).setValue(taskObject.repeatRule);
        }
        if (header['UpdatedAt'] != null) {
          sh.getRange(i + 1, header['UpdatedAt'] + 1).setValue(new Date());
        }

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
      'UpdatedAt',
      'RepeatRule',
    ]);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (String(v[i][header['TaskID']] || '').trim() === targetId) {
        sh.getRange(i + 1, header['Status'] + 1).setValue('完了');
        if (header['UpdatedAt'] != null)
          sh.getRange(i + 1, header['UpdatedAt'] + 1).setValue(new Date());
        const row = v[i];
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

function listMyTasks(filter) {
  const rawEmail = _getCurrentEmail();
  const normalizedEmail = _normalizeEmail(rawEmail);
  if (!normalizedEmail) {
    return { tasks: [], meta: { statuses: [] } };
  }

  const data = _loadTaskTable();
  const todayMs = _startOfToday();
  const statusFilter = filter && filter.status ? _normalizeStatus(filter.status) : '';

  const statuses = new Set();
  const mine = data.tasks.filter(function (task) {
    if (_emailArrayContains(task.assignees, rawEmail)) return true;
    if (_emailArrayContains(task.assignees, normalizedEmail)) return true;
    if (_normalizeEmail(task.assignee) === normalizedEmail) return true;
    return false;
  });

  mine.forEach(function (task) {
    if (task.status) statuses.add(task.status);
  });

  const filtered = mine.filter(function (task) {
    if (!statusFilter) return true;
    return _normalizeStatus(task.status) === statusFilter;
  });

  filtered.sort(function (a, b) {
    return _compareTasksForList(a, b, todayMs);
  });

  return {
    tasks: filtered,
    meta: {
      statuses: Array.from(statuses).sort(),
      currentEmail: rawEmail,
      normalizedEmail: normalizedEmail,
      totalTasks: data.tasks.length,
      mineCount: mine.length,
      filteredCount: filtered.length,
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

  return {
    tasks: filtered,
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
    'RRULE',
    'ParentTaskID',
    'Attachments',
    'UpdatedAt',
    'RepeatRule',
    'AttachmentIDs',
  ]);
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

  return {
    tasks: filtered,
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
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const memoSh = ss.getSheetByName('T_Memos');
  const readSh = ss.getSheetByName('T_MemoReads');

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

  if (opt && opt.folderId) {
    const fid = String(opt.folderId);
    list = list.filter(function (x) {
      return String(x.folderId || '') === fid;
    });
  }
  if (opt && opt.unreadOnly) {
    list = list.filter(function (x) {
      return !x.isRead;
    });
  }
  return list;
}

function getMessageById(memoId) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const memoSh = ss.getSheetByName('T_Memos');
  const commentSh = ss.getSheetByName('T_Comments');
  const readSh = ss.getSheetByName('T_MemoReads');
  const userSh = ss.getSheetByName('M_Users');

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
  _ensureColumns(commentSh, ['CommentID', 'MemoID', 'CreatedAt', 'Author', 'Body']);
  _ensureColumns(readSh, ['MRID', 'MemoID', 'UserEmail', 'ReadAt']);
  _ensureColumns(userSh, [
    'UserID',
    'Email',
    'DisplayName',
    'ProfileImage',
    'Role',
    'IsActive',
    'Theme',
  ]);

  const memos = memoSh.getDataRange().getValues();
  const comments = commentSh.getDataRange().getValues();
  const reads = readSh.getDataRange().getValues();
  const users = userSh.getDataRange().getValues();

  const mHdr = _getHeaderMap(memoSh);
  const cHdr = _getHeaderMap(commentSh);
  const rHdr = _getHeaderMap(readSh);
  const uHdr = _getHeaderMap(userSh);

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
      message.comments.push({
        author: comments[i][cHdr['Author']],
        body: String(comments[i][cHdr['Body']] || '').replace(/\n/g, '<br>'),
        createdAt: new Date(comments[i][cHdr['CreatedAt']]).toLocaleString('ja-JP'),
      });
    }
  }

  const readUserEmails = new Set();
  for (let i = 1; i < reads.length; i++) {
    if (reads[i][rHdr['MemoID']] === memoId) readUserEmails.add(reads[i][rHdr['UserEmail']]);
  }
  for (let i = 1; i < users.length; i++) {
    const uemail = users[i][uHdr['Email']];
    const uname = users[i][uHdr['DisplayName']];
    if (readUserEmails.has(uemail)) message.readUsers.push(uname);
    else message.unreadUsers.push(uname);
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
    const sh = _openSheet('T_Comments');
    _ensureColumns(sh, ['CommentID', 'MemoID', 'CreatedAt', 'Author', 'Body']);
    const id = Utilities.getUuid();
    const now = new Date();
    const email = _getCurrentEmail();
    sh.appendRow([id, commentData.memoId, now, email, commentData.body]);
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
    _ensureColumns(sh, [
      'MemoID',
      'CreatedAt',
      'CreatedBy',
      'Title',
      'Body',
      'Priority',
      'FolderID',
      'AttachmentIDs',
    ]);
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
    if (hdr['AttachmentIDs'] != null)
      row[hdr['AttachmentIDs']] = _arrayToCsv(messageData.attachmentIds || []);

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
    _ensureColumns(sh, [
      'MemoID',
      'CreatedAt',
      'CreatedBy',
      'Title',
      'Body',
      'Priority',
      'FolderID',
      'AttachmentIDs',
    ]);
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
    const sh = _openSheet('M_Users');
    const hdr = _ensureColumns(sh, [
      'UserID',
      'Email',
      'DisplayName',
      'ProfileImage',
      'Role',
      'IsActive',
      'Theme',
    ]);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['Email']] === email) {
        if (payload.name != null) sh.getRange(i + 1, hdr['DisplayName'] + 1).setValue(payload.name);
        if (payload.imageUrl != null)
          sh.getRange(i + 1, hdr['ProfileImage'] + 1).setValue(payload.imageUrl);
        if (payload.theme != null) sh.getRange(i + 1, hdr['Theme'] + 1).setValue(payload.theme);
        CacheService.getScriptCache().remove('user_info_' + email);
        return { success: true, message: '設定を保存しました。' };
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
    const hdr = _ensureColumns(sh, [
      'UserID',
      'Email',
      'DisplayName',
      'ProfileImage',
      'Role',
      'IsActive',
      'Theme',
    ]);
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (v[i][hdr['Email']] === arg.email) {
        sh.getRange(i + 1, hdr['Role'] + 1).setValue(arg.role || '一般');
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
function myFunction() {}
// ====== テスト用の関数 ======
function testOpenSheet() {
  try {
    // 実際に存在することがわかっているシート名に書き換えてください
    const sheetName = 'M_Users';
    Logger.log('テスト開始: ' + sheetName + 'シートを開きます...');

    const sh = _openSheet(sheetName);

    if (sh) {
      Logger.log('成功！シートを取得できました。シート名: ' + sh.getName());
      const firstCell = sh.getRange('A1').getValue();
      Logger.log('A1セルの値: ' + firstCell);
    } else {
      // このログは通常表示されないはず（_openSheet内でエラーがスローされるため）
      Logger.log('失敗。シートオブジェクトがnullです。');
    }
  } catch (e) {
    Logger.log('テスト中にエラーが発生しました！');
    Logger.log('エラーメッセージ: ' + e.message);
    Logger.log('スタックトレース: ' + e.stack);
  }
}
