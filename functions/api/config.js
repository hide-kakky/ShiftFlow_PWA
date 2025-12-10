export function loadConfig(env) {
  const cfOrigin = (env?.CF_ORIGIN || '').trim();
  const rawGasUrl = (env?.GAS_EXEC_URL || env?.GAS_WEB_APP_URL || '').trim();
  const googleClientId = (env?.GOOGLE_OAUTH_CLIENT_ID || env?.GOOGLE_CLIENT_ID || '').trim();
  const primarySecret = (env?.SHIFT_FLOW_SHARED_SECRET || env?.GAS_SHARED_SECRET || '').trim();
  const nextSecret = (env?.SHIFT_FLOW_SHARED_SECRET_NEXT || '').trim();
  const sharedSecrets = [primarySecret, nextSecret].filter((value, index, arr) => value && arr.indexOf(value) === index);
  const flags = readFeatureFlags(env);

  if (!cfOrigin) {
    throw new Error('CF_ORIGIN is not configured. Set it in Cloudflare Pages environment variables.');
  }
  let gasUrl = '';
  if (rawGasUrl) {
    try {
      const parsedGasUrl = new URL(rawGasUrl);
      if (
        parsedGasUrl.hostname.endsWith('googleusercontent.com') &&
        parsedGasUrl.pathname.includes('/macros/echo')
      ) {
        throw new Error(
          'GAS_EXEC_URL が macros/echo エンドポイントを指しています。Apps Script の Web アプリ (/exec) URL を指定してください。'
        );
      }
      gasUrl = parsedGasUrl.toString();
    } catch (err) {
      if (!(err instanceof TypeError)) {
        throw err;
      }
      throw new Error('GAS_EXEC_URL に有効な URL を指定してください。');
    }
  }
  if (!googleClientId) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID is not configured. Set it in Cloudflare Pages environment variables.'
    );
  }
  const allowedOrigins = cfOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowedOrigins.length) {
    allowedOrigins.push(cfOrigin);
  }

  return {
    cfOrigin,
    allowedOrigins,
    gasUrl,
    googleClientId,
    sharedSecret: sharedSecrets.length ? sharedSecrets[0] : '',
    sharedSecrets,
    flagKvKey: (env?.CFG_FLAG_KV_KEY || 'shiftflow:flags').trim(),
    flags,
  };
}

function parseBooleanFlag(value) {
  if (!value) return false;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function readBooleanFlag(env, key, defaultValue = false) {
  const raw = env ? env[key] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  return parseBooleanFlag(raw);
}

export function readFeatureFlags(env) {
  return {
    cfAuth: parseBooleanFlag(env?.CFG_CF_AUTH),
    cacheBootstrap: parseBooleanFlag(env?.CFG_CACHE_BOOTSTRAP),
    cacheHome: parseBooleanFlag(env?.CFG_CACHE_HOME),
    d1Read: readBooleanFlag(env, 'CFG_D1_READ', true),
    d1Write: readBooleanFlag(env, 'CFG_D1_WRITE', true),
    d1Primary: readBooleanFlag(env, 'CFG_D1_PRIMARY', true),
    useJwks: parseBooleanFlag(env?.CFG_USE_JWKS),
  };
}

const ROUTE_PERMISSIONS = {
  getBootstrapData: ['admin', 'manager', 'member'],
  getHomeContent: ['admin', 'manager', 'member'],
  listMyTasks: ['admin', 'manager', 'member'],
  listCreatedTasks: ['admin', 'manager', 'member'],
  listAllTasks: ['admin', 'manager'],
  getMessages: ['admin', 'manager', 'member'],
  getMessageById: ['admin', 'manager', 'member'],
  addNewComment: ['admin', 'manager', 'member'],
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
  downloadAttachment: ['admin', 'manager', 'member'],
  getUserSettings: ['admin', 'manager', 'member', 'guest'],
  saveUserSettings: ['admin', 'manager', 'member'],
  listActiveUsers: ['admin', 'manager'],
  listActiveFolders: ['admin', 'manager', 'member'],
  adminListUsers: ['admin', 'manager'],
  adminUpdateUser: ['admin', 'manager'],
  clearCache: ['admin'],
  getAuditLogs: ['admin', 'manager'],
};

export function getRoutePermissions(routeName) {
  const normalized = String(routeName || '').trim();
  if (!normalized) return null;
  return ROUTE_PERMISSIONS[normalized] || null;
}
