/**
 * Cloudflare Functions で共有する定数をまとめる。
 * 値そのものは従来と同じで、参照場所だけを一本化している。
 */
export const PROFILE_PLACEHOLDER_URL = 'https://placehold.jp/150x150.png';
export const PROFILE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MESSAGE_ATTACHMENT_LIMIT = 5;
export const API_JSON_BODY_MAX_BYTES = 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/heic',
  'image/heif',
]);

export const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const CORS_ALLOWED_HEADERS =
  'Content-Type,Authorization,X-ShiftFlow-Request-Id,X-ShiftFlow-File-Name,X-ShiftFlow-Attachment-Purpose,X-ShiftFlow-Content-Sha256';
export const CORS_EXPOSE_HEADERS = 'X-ShiftFlow-Request-Id,X-ShiftFlow-Cache';
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const SENSITIVE_META_KEYWORDS = [
  'secret',
  'authorization',
  'authheader',
  'token',
  'cookie',
  'raw',
  'responseheader',
  'redirectlocation',
  'payload',
  'body',
  'email',
  'useragent',
  'clientip',
];
export const ACTIVE_ACCESS_CACHE_TTL_MS = 3 * 60 * 1000;
