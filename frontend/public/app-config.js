/**
 * ShiftFlow フロントエンド共通定数。
 * window / self のどちらからでも参照できるようにグローバルへ公開する。
 */
(function attachShiftFlowConfig(globalScope) {
  var existing = globalScope.SHIFT_FLOW_CONFIG || {};
  var config = Object.assign({}, existing, {
    APP_VERSION: '1.2.5',
    PROFILE_PLACEHOLDER_URL: 'https://placehold.jp/150x150.png',
    PROFILE_IMAGE_MAX_BYTES: 8 * 1024 * 1024,
    MESSAGE_ATTACHMENT_MAX_BYTES: 10 * 1024 * 1024,
    MESSAGE_ATTACHMENT_LIMIT: 5,
    AUTH_NOTICE_MESSAGE:
      'Google でログインしてから再試行してください。画面の「Google でログイン」ボタンから認証できます。',
    API_BASE_PATH: '/api',
    BOOTSTRAP_CACHE_PREFIX: 'bootstrap:',
    BOOTSTRAP_CACHE_RECENT_KEY: 'bootstrap:recent',
    BOOTSTRAP_CACHE_DEFAULT_EMAIL: 'guest',
    BOOTSTRAP_CACHE_MAX_AGE_MS: 60 * 1000,
    CACHE_PREFIX: 'shiftflow-',
    APP_SHELL_CACHE_KEY: 'shiftflow-app-shell-v2',
    API_CACHE_KEY: 'shiftflow-api-v1',
    APP_SHELL_PATHS: ['/', '/index.html', '/manifest.webmanifest', '/app-config.js'],
    API_REVALIDATE_PATHS: ['/api/tasks', '/api/messages', '/api/home', '/api/templates'],
  });
  globalScope.SHIFT_FLOW_CONFIG = config;
})(typeof globalThis !== 'undefined'
  ? globalThis
  : typeof self !== 'undefined'
  ? self
  : typeof window !== 'undefined'
  ? window
  : {});

  
