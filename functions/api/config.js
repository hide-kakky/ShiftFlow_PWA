export function loadConfig(env) {
  const cfOrigin = (env?.CF_ORIGIN || '').trim();
  const gasUrl = (env?.GAS_EXEC_URL || env?.GAS_WEB_APP_URL || '').trim();
  const googleClientId = (env?.GOOGLE_OAUTH_CLIENT_ID || env?.GOOGLE_CLIENT_ID || '').trim();
  const sharedSecret = (env?.SHIFT_FLOW_SHARED_SECRET || env?.GAS_SHARED_SECRET || '').trim();
  const flags = readFeatureFlags(env);

  if (!cfOrigin) {
    throw new Error('CF_ORIGIN is not configured. Set it in Cloudflare Pages environment variables.');
  }
  if (!gasUrl) {
    throw new Error(
      'GAS_EXEC_URL is not configured. Set it in Cloudflare Pages environment variables.'
    );
  }
  try {
    const parsedGasUrl = new URL(gasUrl);
    if (
      parsedGasUrl.hostname.endsWith('googleusercontent.com') &&
      parsedGasUrl.pathname.includes('/macros/echo')
    ) {
      throw new Error(
        'GAS_EXEC_URL が macros/echo エンドポイントを指しています。Apps Script の Web アプリ (/exec) URL を指定してください。'
      );
    }
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
    throw new Error('GAS_EXEC_URL に有効な URL を指定してください。');
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
    sharedSecret,
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

export function readFeatureFlags(env) {
  return {
    cfAuth: parseBooleanFlag(env?.CFG_CF_AUTH),
    cacheBootstrap: parseBooleanFlag(env?.CFG_CACHE_BOOTSTRAP),
    cacheHome: parseBooleanFlag(env?.CFG_CACHE_HOME),
    d1Read: parseBooleanFlag(env?.CFG_D1_READ),
    d1Write: parseBooleanFlag(env?.CFG_D1_WRITE),
    d1Primary: parseBooleanFlag(env?.CFG_D1_PRIMARY),
  };
}

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
};

export function getRoutePermissions(routeName) {
  const normalized = String(routeName || '').trim();
  if (!normalized) return null;
  return ROUTE_PERMISSIONS[normalized] || null;
}
